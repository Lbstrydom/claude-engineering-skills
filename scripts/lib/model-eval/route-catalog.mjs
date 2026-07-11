/**
 * @fileoverview Candidate route resolution for the model swap-in evaluation
 * harness. Sole authority for model-eval candidate route resolution,
 * lineage, and tier eligibility — every model-eval path (auditor, adjudicator,
 * public or Azure) computes its persisted candidate_ref/resolvedModel/
 * modelLineage/independenceGroup/judgeTier through resolveCandidateRoute.
 *
 * Plan: docs/plans/model-swap-eval-harness.md — File-Level Plan Phase 1.
 *
 * @module scripts/lib/model-eval/route-catalog
 */

import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSentinel, resolveModel, pickOssModel, SENTINEL_TO_TIER, OSS_POOL } from '../model-resolver.mjs';
import { azureConfig } from '../config.mjs';
import { RoleSchema, CandidateSpecSchema } from './contracts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Round-2 (Cluster B) audit M7 fix — CandidateSpecSchema now lives in
// contracts.mjs (genuinely side-effect-free — imports only zod) and is
// re-exported here for backward compatibility with existing importers of
// this module. Its own .strict()-per-member definition, provenance
// (round-12 audit L1), and rejection semantics are unchanged.
export { CandidateSpecSchema };

// M10 fix — azure-routes.json is validated at load time, not just parsed.
// `pricingModelSentinel` (implementation H8 fix, hardcoded-id violation
// fixed by implementation H9) is a SENTINEL (never a concrete model id, per
// AGENTS.md's Model Resolution anti-patterns — "do not pin concrete model
// IDs, use a sentinel") resolved at pricing-lookup time. deploymentId
// remains an arbitrary Azure-user-chosen name, never a valid
// model-pricing.mjs key.
// Round-7 audit M7 fix — .strict() so a stale/misspelled route key in
// azure-routes.json is rejected at load time, not silently stripped (the
// same root-cause fix as config/schema.mjs's round-6 M4).
//
// Trust boundary (round-8 audit M3/H7 — documented, not code-enforced):
// `modelLineage`/`lineageStatus` are an OPERATOR ATTESTATION about what
// AZURE_*_DEPLOYMENT actually points to, not a programmatically-verified
// fact — nothing here queries Azure to confirm the deployment's real model
// identity, matching this repo's existing trust model for OPENAI_AUDIT_MODEL/
// CLAUDE_FINAL_REVIEW_MODEL (env-selected models are trusted, never
// introspected). Whoever sets the deployment env var is administratively the
// same operator who committed this profile's lineage claim; repointing a
// deployment to a different underlying model without updating this file is
// an operator error this schema cannot detect. Live deployment-identity
// verification would need an Azure API round-trip — deferred until this is
// a real operational pain point, not a Phase-1 requirement.
const AzureRouteEntrySchema = z.object({
  profile: z.string().min(1),
  role: RoleSchema,
  deploymentEnvVar: z.string().min(1),
  modelLineage: z.string().min(1),
  lineageStatus: z.enum(['known', 'unknown']),
  pricingModelSentinel: z.string().min(1).refine((v) => isSentinel(v), { message: 'pricingModelSentinel must be a registered sentinel (latest-*), never a concrete model id' }),
}).strict();
const AzureRoutesSchema = z.array(AzureRouteEntrySchema).superRefine((entries, ctx) => {
  const seen = new Set();
  for (const e of entries) {
    const key = `${e.profile}:${e.role}`;
    if (seen.has(key)) ctx.addIssue({ code: 'custom', message: `duplicate profile "${e.profile}" for role "${e.role}"` });
    seen.add(key);
  }
});

class RouteResolutionError extends Error {
  constructor(message, { failedPreflight = true } = {}) {
    super(message);
    this.name = 'RouteResolutionError';
    this.failedPreflight = failedPreflight;
  }
}

let _azureRoutesCache = null;
function loadAzureRoutes() {
  if (_azureRoutesCache) return _azureRoutesCache;
  const p = path.join(__dirname, 'config', 'azure-routes.json');
  if (!fs.existsSync(p)) { _azureRoutesCache = []; return _azureRoutesCache; }
  // Round-10 audit L2 fix — every OTHER preflight failure in this function
  // is wrapped as RouteResolutionError; malformed JSON escaped as a raw
  // SyntaxError instead, the one path outside the route-catalog error
  // contract callers can rely on.
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw new RouteResolutionError(`loadAzureRoutes: azure-routes.json is not valid JSON — ${err.message}`);
  }
  const parsed = AzureRoutesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RouteResolutionError(`loadAzureRoutes: azure-routes.json failed validation — ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  _azureRoutesCache = parsed.data;
  return _azureRoutesCache;
}

/** Fail-closed (implementation H13/H15 fix) — an unrecognized provider is a
 * route-resolution error, never a silent default transport. */
function transportForProvider(provider) {
  if (provider === 'openai' || provider === 'oss') return 'openai-compatible';
  if (provider === 'anthropic') return 'native-anthropic';
  if (provider === 'google') return 'native-gemini';
  throw new RouteResolutionError(`transportForProvider: unrecognized provider "${provider}" — every provider must have an explicit transport mapping`);
}

/** modelLineage is the underlying provider identity, not transport — an
 * Azure-hosted and public instance of the same lineage count as ONE family. */
function lineageForProvider(provider, tierOrVariantOrRole) {
  return tierOrVariantOrRole ? `${provider}:${tierOrVariantOrRole}` : provider;
}

/**
 * @param {{role: 'auditor'|'adjudicator', candidateSpec: unknown, env?: object}} args
 * @returns {{candidateSpec: object, provider: string, resolvedModel: string,
 *   deploymentId: string|null, modelLineage: string, lineageStatus: 'known'|'unknown',
 *   lineageSource: 'catalog-verified'|'reviewed-pool'|'operator-attested',
 *   independenceGroup: string|null, independenceEligible: boolean,
 *   judgeTier: 'A'|'B'|'C', availableFamilies: string[], catalogPolicy: string[]|null,
 *   transport: 'openai-compatible'|'native-anthropic'|'native-gemini'}}
 */
export function resolveCandidateRoute({ role, candidateSpec, env = process.env, azureCfg = azureConfig }) {
  const roleParsed = RoleSchema.safeParse(role);
  if (!roleParsed.success) {
    throw new RouteResolutionError(`resolveCandidateRoute: invalid role "${role}" — must be "auditor" or "adjudicator"`);
  }
  const parsed = CandidateSpecSchema.safeParse(candidateSpec);
  if (!parsed.success) {
    throw new RouteResolutionError(`resolveCandidateRoute: invalid candidateSpec — ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  const spec = parsed.data;

  let provider, resolvedModel, deploymentId = null, modelLineage, lineageStatus, pricingModel;
  // Round-8b audit H7 fix (GPT compromise ruling) — make the TRUST METHOD
  // behind lineageStatus:'known' an explicit, inspectable fact rather than
  // only a comment. 'catalog-verified' (sentinel routes — model-resolver.mjs
  // checks the live/static provider catalog), 'reviewed-pool' (oss-role —
  // OSS_POOL membership, round-6 H2), 'operator-attested' (azure-deployment —
  // no independent verification exists; see the trust-boundary comment on
  // AzureRouteEntrySchema below). Promotion-tier/Tier-A-B callers (Cluster
  // B/C, not yet built) are expected to gate on this — e.g. require an
  // explicit acknowledgement or cap to Tier C for 'operator-attested' routes
  // before a promotion decision — this module only supplies the fact.
  let lineageSource;

  if (spec.kind === 'sentinel') {
    if (!isSentinel(spec.value)) {
      throw new RouteResolutionError(`resolveCandidateRoute: "${spec.value}" is not a registered sentinel — a raw concrete model id is rejected`);
    }
    const tier = SENTINEL_TO_TIER[spec.value.toLowerCase()];
    provider = tier.provider;
    resolvedModel = resolveModel(spec.value);
    modelLineage = lineageForProvider(provider, tier.tier || tier.variant || tier.role);
    lineageStatus = 'known';
    lineageSource = 'catalog-verified';
    pricingModel = resolvedModel;
  } else if (spec.kind === 'oss-role') {
    provider = 'oss';
    resolvedModel = pickOssModel(spec.role);
    // Implementation H6 fix — a route with no resolvable model is not an
    // executable route at all (there is no OSS model configured for this
    // role); fail preflight rather than returning an "unknown lineage" route
    // that would still reach invocation and fail deep inside the provider call.
    if (!resolvedModel) {
      throw new RouteResolutionError(`resolveCandidateRoute: no OSS model configured for role "${spec.role}" (pickOssModel returned null — set OSS_${spec.role.toUpperCase()}_MODEL or populate OSS_POOL.${spec.role})`);
    }
    // Implementation H5 fix — lineage keyed on the RESOLVED MODEL, not the
    // abstract role name. Two roles resolving to the same underlying OSS
    // model must show the same lineage (the round-2 "coder"/"reasoner" bug
    // would have let two same-family roles look independent).
    modelLineage = lineageForProvider('oss', resolvedModel);
    // Round-6 audit H2 fix (GPT compromise ruling) — "known" lineage/
    // independence credit is earned only by a model on the reviewed,
    // committed OSS_POOL allowlist. An OSS_CODER_MODEL/OSS_REASONER_MODEL
    // env override can point at ANY OpenRouter id, including one that's
    // secretly re-serving a proprietary model this harness already treats
    // as a distinct family elsewhere — the static pool is the only
    // reviewed set, so an override outside it fails closed to 'unknown'
    // (capped at Tier C via independenceEligible below), never silently
    // trusted as an independent family.
    const inReviewedPool = (OSS_POOL[spec.role] || []).includes(resolvedModel);
    lineageStatus = inReviewedPool ? 'known' : 'unknown';
    // Round-12 audit M2 fix — lineageSource was hardcoded 'reviewed-pool'
    // UNCONDITIONALLY, even for an OSS_CODER_MODEL/OSS_REASONER_MODEL env
    // override outside the pool (where lineageStatus correctly says
    // 'unknown') — misleading provenance metadata, even though it wasn't
    // independently exploitable (independenceEligible, the actual gate,
    // was already correctly false). lineageSource now reflects which
    // METHOD actually determined the trust outcome.
    lineageSource = inReviewedPool ? 'reviewed-pool' : 'operator-attested';
    pricingModel = resolvedModel;
  } else {
    // azure-deployment
    const entry = loadAzureRoutes().find((r) => r.profile === spec.profile && r.role === role);
    if (!entry) {
      throw new RouteResolutionError(`resolveCandidateRoute: unknown azure-deployment profile "${spec.profile}" for role "${role}"`);
    }
    // Round-5 M3 fix — activation and deployment id both come from
    // injectable sources (azureCfg param defaults to the singleton; env
    // param already injectable), matching buildAzureConfig's own
    // test-injection pattern. No mixed singleton/injected reads.
    if (!azureCfg.active) {
      throw new RouteResolutionError(`resolveCandidateRoute: profile "${spec.profile}" requires the Azure work profile to be active (AZURE_OPENAI_ENDPOINT unset)`);
    }
    deploymentId = (env[entry.deploymentEnvVar] || '').trim() || null;
    if (!deploymentId) {
      throw new RouteResolutionError(`resolveCandidateRoute: profile "${spec.profile}" names env var "${entry.deploymentEnvVar}", which is unset`);
    }
    provider = 'azure';
    resolvedModel = deploymentId;
    modelLineage = entry.modelLineage;
    lineageStatus = entry.lineageStatus;
    lineageSource = 'operator-attested';
    // Implementation H9 fix — resolve the sentinel to a concrete pricing key
    // AT LOOKUP TIME (never store a concrete id in config); a live-catalog
    // refresh picks up a new model generation automatically without a
    // azure-routes.json edit, matching this repo's sentinel-resolution policy.
    pricingModel = resolveModel(entry.pricingModelSentinel);
  }

  // Round-9 audit H1/H8 fix (GPT compromise ruling) — ambient azureConfig
  // activation is NOT a restricted-catalog policy (a machine can legitimately
  // hold both Azure and public credentials, and comparing a public baseline
  // against an Azure Foundry deployment is a real use case). Instead, an
  // EXPLICIT, opt-in allowlist (MODEL_EVAL_ALLOWED_PROVIDERS, comma-separated
  // provider names) gates candidate resolution ONCE, centrally, here —
  // never duplicated as ad-hoc per-transport checks in provider-adapter.mjs
  // (which would be exactly the kind of redundant validation this round's
  // own DRY findings keep flagging). Unset → unrestricted, today's behavior.
  const allowedProvidersRaw = (env.MODEL_EVAL_ALLOWED_PROVIDERS || '').trim();
  const catalogPolicy = allowedProvidersRaw ? allowedProvidersRaw.split(',').map((p) => p.trim()).filter(Boolean) : null;
  if (catalogPolicy && !catalogPolicy.includes(provider)) {
    throw new RouteResolutionError(`resolveCandidateRoute: provider "${provider}" is not in the approved candidate-provider catalog (MODEL_EVAL_ALLOWED_PROVIDERS=${catalogPolicy.join(',')})`);
  }

  // Fail-closed on unknown lineage (round-2 audit H1) — never its own group.
  const independenceGroup = lineageStatus === 'known' ? modelLineage : null;
  const independenceEligible = lineageStatus === 'known';

  // Per-route best tier in isolation (round-4 H4 origin, round-6 H3 clarifies
  // the real comparison tier is decided by resolveEvaluationTier below).
  const judgeTier = independenceEligible ? (role === 'auditor' ? 'A' : 'B') : 'C';

  const transportProvider = provider === 'azure' ? azureTransportProvider(spec, role) : provider;
  assertAzureTransportSupported(provider, transportProvider);
  const transport = transportForProvider(transportProvider);

  return {
    candidateSpec: spec, provider, resolvedModel, deploymentId, modelLineage, lineageStatus, lineageSource,
    independenceGroup, independenceEligible, judgeTier, pricingModel, catalogPolicy,
    availableFamilies: [...new Set(loadAzureRoutes().map((r) => r.modelLineage.split(':')[0]))],
    transport,
  };
}

// Implementation M6/M11 fix — exhaustive, fail-closed. An Azure lineage
// whose family isn't explicitly listed here is a configuration error, never
// a silent default to OpenAI-compatible transport.
const AZURE_LINEAGE_FAMILY_TRANSPORT = Object.freeze({ openai: 'openai', anthropic: 'anthropic', google: 'google' });

// Round-6 audit H3 fix — provider-adapter.mjs unconditionally rejects
// azure+google routes (no Azure-hosted Gemini transport exists in this
// codebase); resolveCandidateRoute must fail closed at the SAME boundary
// instead of returning an apparently-executable route that only fails deep
// inside invokeStructured. google stays IN AZURE_LINEAGE_FAMILY_TRANSPORT
// (lineage/availableFamilies bookkeeping still needs the mapping); this is
// a separate, later "is it actually invokable" gate.
function assertAzureTransportSupported(provider, transportProvider) {
  if (provider === 'azure' && transportProvider === 'google') {
    throw new RouteResolutionError('resolveCandidateRoute: no Azure-hosted Gemini transport exists — a google-lineage azure-deployment profile is unsupported');
  }
}

/** Azure deployments proxy an underlying model family (gpt/claude/etc) — the
 * transport check needs THAT family, not the literal string 'azure'. */
function azureTransportProvider(spec, role) {
  const entry = loadAzureRoutes().find((r) => r.profile === spec.profile && r.role === role);
  const family = entry?.modelLineage?.split(':')[0];
  const mapped = AZURE_LINEAGE_FAMILY_TRANSPORT[family];
  if (!mapped) {
    throw new RouteResolutionError(`azureTransportProvider: unrecognized Azure modelLineage family "${family}" for profile "${spec.profile}" — add it to AZURE_LINEAGE_FAMILY_TRANSPORT explicitly`);
  }
  return mapped;
}

/**
 * A comparative Tier A/B claim depends on pairwise relationships among
 * candidate/baseline/judge routes, not any single route's self-reported
 * tier. Fail-closed to 'C' on any unknown lineage or same-lineage pair
 * anywhere in the triple.
 *
 * Implementation H4 fix — `judgeRoute` is NOT optional for comparative mode.
 * The round-2 signature let a caller omit it and still reach Tier A/B purely
 * on candidate-vs-baseline independence, never verifying judge independence
 * at all — defeating the entire point of a BLIND cross-family judge. An
 * omitted judge route now fails closed to Tier C, matching the plan's own
 * "promotion-tier comparative runs REQUIRE an explicit --judge flag" design.
 *
 * @param {{role: 'auditor'|'adjudicator', mode: 'comparative'|'oracle',
 *   candidateRoute: object, baselineRoute?: object, judgeRoute?: object|null}} args
 */
export function resolveEvaluationTier({ mode, candidateRoute, baselineRoute = null, judgeRoute = null }) {
  if (mode === 'oracle') {
    return { computedJudgeTier: 'C', independenceChecks: {} };
  }
  const known = (r) => r && r.lineageStatus === 'known';
  const distinct = (a, b) => a && b && a.independenceGroup !== b.independenceGroup;

  if (!known(candidateRoute) || !known(baselineRoute)) {
    return { computedJudgeTier: 'C', independenceChecks: { candidateVsBaseline: false, candidateVsJudge: false, baselineVsJudge: false } };
  }
  const candidateVsBaseline = distinct(candidateRoute, baselineRoute);
  if (!candidateVsBaseline) {
    return { computedJudgeTier: 'C', independenceChecks: { candidateVsBaseline: false, candidateVsJudge: false, baselineVsJudge: false } };
  }
  // judgeRoute is mandatory for comparative mode — a null/unknown judge
  // route can never earn Tier A/B, regardless of candidate/baseline independence.
  if (!known(judgeRoute)) {
    return { computedJudgeTier: 'C', independenceChecks: { candidateVsBaseline, candidateVsJudge: false, baselineVsJudge: false } };
  }
  const candidateVsJudge = distinct(candidateRoute, judgeRoute);
  const baselineVsJudge = distinct(baselineRoute, judgeRoute);
  if (!candidateVsJudge || !baselineVsJudge) {
    return { computedJudgeTier: 'C', independenceChecks: { candidateVsBaseline, candidateVsJudge, baselineVsJudge } };
  }
  return {
    computedJudgeTier: candidateRoute.judgeTier === 'A' ? 'A' : 'B',
    independenceChecks: { candidateVsBaseline, candidateVsJudge, baselineVsJudge },
  };
}

/** Reduce a resolveCandidateRoute() return value to the RouteEvidence shape
 * verdict.mjs::VerdictInputSchema expects — never hand-pick these three
 * fields ad hoc at a call site. */
function toRouteEvidence(route) {
  // Round-10 audit M7 fix — lineageSource was being dropped here, defeating
  // the whole point of round-8b's H7 fix (make the trust method inspectable
  // downstream, not just at resolution time).
  return { judgeTier: route.judgeTier, lineageStatus: route.lineageStatus, independenceEligible: route.independenceEligible, lineageSource: route.lineageSource };
}

/**
 * Round-8b audit H4 fix (GPT compromise ruling) — the SOLE sanctioned way to
 * build a verdict.mjs comparative-mode `comparisonEvidence` object. Computes
 * `computedJudgeTier`/`independenceChecks` via resolveEvaluationTier (never
 * caller-supplied), so a comparative verdict can only ever be constructed
 * from real resolveCandidateRoute() outputs — closing the gap where a caller
 * could hand-assemble self-asserted independence evidence that merely passed
 * verdict.mjs's own internal-consistency check (round-6 H5 / round-7-8 H4)
 * without ever having been derived from actual route facts.
 * @param {{candidateRoute: object, baselineRoute: object, judgeRoute?: object|null}} args
 * @returns {object} comparisonEvidence, ready to pass to computeVerdict
 */
export function buildComparisonEvidenceFromRoutes({ candidateRoute, baselineRoute, judgeRoute = null }) {
  const { computedJudgeTier, independenceChecks } = resolveEvaluationTier({ mode: 'comparative', candidateRoute, baselineRoute, judgeRoute });
  return {
    candidateRoute: toRouteEvidence(candidateRoute),
    baselineRoute: toRouteEvidence(baselineRoute),
    judgeRoute: judgeRoute ? toRouteEvidence(judgeRoute) : null,
    computedJudgeTier,
    independenceChecks,
  };
}

// toRouteEvidence exposed here (Phase 3) — the ONLY correct way to build
// verdict.mjs's single-route `routeEvidence` (oracle mode); the comparative
// `comparisonEvidence` triple has its own sanctioned constructor
// (buildComparisonEvidenceFromRoutes, above), but oracle mode's single-route
// shape had no equivalent public constructor — model-eval-auditor.mjs's
// screen-tier (oracle mode) needs it and must not hand-pick these 4 fields
// ad hoc at the call site (the same duplication toRouteEvidence itself exists
// to prevent for the comparative case).
export const _internals = { RouteResolutionError, loadAzureRoutes, transportForProvider, assertAzureTransportSupported, AzureRouteEntrySchema, toRouteEvidence };
