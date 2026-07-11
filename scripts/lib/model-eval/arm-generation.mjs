/**
 * @fileoverview Candidate-arm generation call boundary for the model
 * swap-in evaluation harness (relocated here from the old Phase 2
 * `evaluation-runner.mjs` design — see Audit Trail). `runAuditGenerationArm`
 * drives the SAME production 5-pass audit (`openai-audit.mjs::
 * runMultiPassCodeAudit`) for every `CandidateSpec` kind, so a candidate and
 * the baseline get identical search effort and cross-verification — never a
 * single structured-extraction call standing in for a real generation pass
 * (that would be the fairness bug Gemini round-3 caught in an earlier draft).
 *
 * `audit-shadow.mjs`'s `runStage` is a DIFFERENT, lighter-weight generation
 * path belonging to the separate model-A/B/C shadow experiment — not reused
 * here; this module always drives the full production pipeline.
 *
 * Plan: docs/plans/model-swap-eval-harness.md — File-Level Plan Phase 3.
 *
 * @module scripts/lib/model-eval/arm-generation
 */

import fs from 'node:fs';
import path from 'node:path';
import { createOpenAIClient } from '../openai-client.mjs';
import { auditShadowConfig } from '../config.mjs';
import { runMultiPassCodeAudit } from '../../openai-audit.mjs';
import { buildUsageEvent } from './cost.mjs';
import { assertEgressSafe, isPathSensitive } from '../sensitive-egress-gate.mjs';
import { findSensitivePathMentions, EgressGateError } from './egress-path-scan.mjs';

export class UnsupportedGenerationTransport extends Error {
  constructor(transport) {
    super(`runAuditGenerationArm: transport "${transport}" is unsupported — auditor-role generation requires an OpenAI-SDK-shaped client (openai-compatible transport only); see route-catalog.mjs's transport field`);
    this.name = 'UnsupportedGenerationTransport';
    this.transport = transport;
  }
}

// Generic, non-leaking framing — MUST NEVER be built from `hiddenGroundTruth`
// (known-defect-corpus.mjs's defectDesc/expectedFindingRubric). The whole
// point of the visible/hidden split is that the candidate model never sees
// the answer; this string is deliberately the same for every KD case.
const GENERIC_PLAN_CONTENT = [
  'Review the following code change for defects: correctness bugs, security',
  "issues, silent failure/data-loss modes, and violations of the project's",
  'own documented conventions (AGENTS.md/CLAUDE.md, if present). There is no',
  'separate design plan for this change — audit the diff itself.',
].join('\n');

/**
 * Resolves the client + model string for a generation call, uniformly
 * across all three ArmGenerationSchema kinds (audit-arms.mjs, Phase 3).
 * `generation.kind` picks which CLIENT to construct (openai-compatible vs
 * OSS-router base URL — route.transport is 'openai-compatible' for all
 * three kinds, so it can't disambiguate this); the MODEL STRING always
 * comes from `route.resolvedModel`/`route.deploymentId` — the ALREADY-
 * RESOLVED, authoritative value the caller computed once via
 * resolveCandidateRoute() — never a fresh resolveModel(generation.
 * modelSentinel) re-derivation. Round-2 (Cluster B) audit H5/H7 fix: the
 * prior version re-resolved the sentinel independently here, which could
 * silently DRIFT from the route's own resolvedModel (recorded in cost/
 * provenance evidence) if the live model catalog refreshed between route
 * resolution (once, at CLI startup) and this per-KD-case call — a
 * time-of-check/time-of-use gap where the model actually invoked could
 * differ from the model recorded as evaluated. Using route.resolvedModel
 * directly makes route resolution the single source of truth, matching
 * this repo's own "resolveCandidateRoute is the sole authority" invariant
 * (route-catalog.mjs's own header comment).
 */
async function resolveGenerationClient(generation, route) {
  if (generation.kind === 'sentinel') {
    return { client: await createOpenAIClient({ purpose: 'gpt' }), model: route.resolvedModel };
  }
  if (generation.kind === 'oss-role') {
    const client = await createOpenAIClient({
      oss: { baseURL: auditShadowConfig.openrouterBaseUrl, apiKey: auditShadowConfig.openrouterApiKey },
    });
    return { client, model: route.resolvedModel };
  }
  // resolved-route (Azure deployment candidate) — ambient azureConfig.active
  // is already a resolveCandidateRoute precondition (route-catalog.mjs fails
  // `failed_preflight` closed at RESOLUTION time if it's false), so
  // createOpenAIClient({purpose:'gpt'}) routes to Azure automatically here;
  // no explicit `azure` override needed. The Azure API routes by deployment
  // NAME in the model field, not by client construction — deploymentId wins
  // over resolvedModel when both are present.
  const client = await createOpenAIClient({ purpose: 'gpt' });
  return { client, model: route.deploymentId ?? route.resolvedModel };
}

/**
 * @param {{arm: object, auditInput: {diff:string, files:string[], repoRoot:string},
 *   route: {transport:string, resolvedModel:string, deploymentId:string|null, pricingModel:string, provider:string},
 *   runId: string, role: string, signal?: AbortSignal,
 *   _runMultiPassCodeAudit?: typeof runMultiPassCodeAudit}} args
 * @returns {Promise<{findings: object[], usageEvent: object, mergedResult: object}>}
 */
export async function runAuditGenerationArm({
  arm, auditInput, route, runId, role, signal,
  // Injectable seam (mirrors this repo's established pattern — e.g.
  // route-catalog.mjs's `azureCfg = azureConfig` default) — tests supply a
  // fake to prove call-count parity / correct client-per-kind selection /
  // repoProfile omission without a real network-calling 5-pass audit.
  _runMultiPassCodeAudit = runMultiPassCodeAudit,
}) {
  void signal; // accepted for API uniformity with the other model-eval
  // primitives (invokeStructured, runBlindJudgeProtocol both take signal) —
  // NOT forwarded to runMultiPassCodeAudit, which has no cancellation
  // support (verified directly: buildAuditRunContext's cliArgs destructure
  // has no signal field). A 5-pass production audit call cannot currently
  // be aborted mid-flight; documenting this explicitly rather than silently
  // dropping a parameter that looks like it should work.

  // Round-5 audit H5 — checked FIRST, before any client/generation work.
  if (route.transport !== 'openai-compatible') {
    throw new UnsupportedGenerationTransport(route.transport);
  }

  // Round-1 (Cluster B) audit H3/H7/H10 fix — explicit, defense-in-depth
  // egress gate at THIS boundary, before the diff/files ever reach
  // runMultiPassCodeAudit. The production pipeline it calls into already
  // filters sensitive paths internally (verified: it's the SAME pipeline
  // every real /audit-code invocation runs on untrusted PR diffs daily),
  // but this repo's own established doctrine (provider-adapter.mjs's own
  // H7 comment) is "a boundary must not trust that every caller remembered
  // to gate upstream" — known-defect-corpus.mjs's loadCorpusCase extracts
  // raw git history from POSSIBLY-SIBLING repos with no gate of its own
  // (by design — see that file), so this is the first LLM-bound boundary
  // for that data and must not assume protection it hasn't verified itself.
  assertEgressSafe(auditInput.diff, { label: `arm-generation:${arm.id}` });
  const sensitiveDiffPaths = findSensitivePathMentions(auditInput.diff);
  const sensitiveFiles = (auditInput.files || []).filter(isPathSensitive);
  const sensitivePaths = [...new Set([...sensitiveDiffPaths, ...sensitiveFiles])];
  if (sensitivePaths.length > 0) {
    throw new EgressGateError(`runAuditGenerationArm: refusing to generate on a diff/file-list containing sensitive path mention(s): ${sensitivePaths.join(', ')}`);
  }

  const { client, model } = await resolveGenerationClient(arm.generation, route);

  // Written BEFORE the chdir below, as ABSOLUTE paths — immune to the cwd
  // swap (buildAuditRunContext's file reads resolve relative to
  // process.cwd(), confirmed by tracing legacy-production-audit.mjs's
  // repoRoot/baseDir usage; a relative path here would silently read/write
  // the WRONG repo once cwd changes).
  const scratchDir = path.resolve('.audit', 'tmp', 'model-eval', runId);
  fs.mkdirSync(scratchDir, { recursive: true });
  const diffPath = path.join(scratchDir, `${arm.id}.diff`);
  const outFile = path.join(scratchDir, `${arm.id}.result.json`);
  fs.writeFileSync(diffPath, auditInput.diff, 'utf8');

  const savedCwd = process.cwd();
  let mergedResult;
  try {
    // Every file read inside runMultiPassCodeAudit's legacy pipeline
    // resolves against process.cwd() (repoRoot/baseDir, verified directly)
    // — a known-defect corpus case from a SIBLING repo (wine-cellar-app,
    // ai-organiser) requires actually chdir'ing there for changedFiles to
    // resolve to real file content. Always restored in `finally`, mirroring
    // diff-scope-resolver.mjs's own established chdir/restore pattern.
    if (path.resolve(savedCwd) !== path.resolve(auditInput.repoRoot)) {
      process.chdir(auditInput.repoRoot);
    }
    mergedResult = await _runMultiPassCodeAudit(
      client,
      GENERIC_PLAN_CONTENT,
      '', // projectContext — deliberately empty/uniform for both candidate and
          // baseline (a real per-repo AGENTS.md excerpt would be FAIR to add
          // later, but must be identical for both sides; empty is the safe,
          // symmetric default today).
      true, // jsonMode — irrelevant once outFile is set (see below), kept
            // true so the fallback branch (no outFile) would still be
            // machine-parseable rather than a markdown banner.
      outFile, // writeOutput's file+one-line-summary path (file-io.mjs) —
                // keeps this call's stdout to a single summary line instead
                // of the full JSON blob printAuditResult would otherwise
                // console.log() unconditionally.
      '', // historyContext — no R2+ prior-round context; every model-eval
          // generation call is a fresh, single round.
      {
        changedFiles: auditInput.files,
        diffFile: diffPath,
        scopeMode: 'diff',
        round: 1,
        model,
        runId,
        noLedger: true,      // no local adjudication ledger for a one-shot
        noDebtLedger: true,  // eval generation call — nothing to suppress
        // repoProfile is DELIBERATELY OMITTED (not just left at its default
        // by accident) — verified directly (legacy-production-audit.mjs):
        // the ENTIRE cloud audit_runs/audit_findings/learning-store write
        // path is gated on `isCloudEnabled() && repoProfile`; omitting
        // repoProfile means a model-eval generation call NEVER writes a row
        // into the production audit-effectiveness tables it isn't part of.
        // Passing a repoProfile here would silently corrupt those tables
        // with synthetic, non-PR generation calls.
      },
    );
  } finally {
    if (path.resolve(process.cwd()) !== path.resolve(savedCwd)) process.chdir(savedCwd);
  }

  // Round-1 (Cluster B) audit M15 fix — the legacy result contract
  // (`findings` array, `_usage` object) is trusted but never validated.
  // `mergedResult.findings || []` used to silently convert a missing/renamed
  // `findings` field into "zero findings" — indistinguishable from "the
  // candidate genuinely found nothing," exactly the empty-capture-reads-
  // clean anti-pattern this repo's own doctrine treats as a HIGH-severity
  // class (AGENTS.md "Audit your success paths"). Fail loud instead.
  if (!Array.isArray(mergedResult?.findings)) {
    throw new Error(`runAuditGenerationArm: runMultiPassCodeAudit returned a malformed result — expected an array "findings" field, got ${typeof mergedResult?.findings}`);
  }

  // Round-5 audit H4 — reads the SAME `_usage` aggregate printAuditResult
  // already surfaces (openai-audit.mjs), no new usage-capture mechanism.
  const candidateRef = route.deploymentId ?? route.resolvedModel;
  const usageEvent = buildUsageEvent({
    runId, role, phase: 'generation', armId: arm.id, candidateRef,
    resolvedModel: route.resolvedModel, pricingModel: route.pricingModel,
    deploymentId: route.deploymentId, provider: route.provider,
    usage: mergedResult._usage, capturedAt: new Date().toISOString(),
  });

  return { findings: mergedResult.findings, usageEvent, mergedResult };
}

// Exported for direct testing (mirrors the _internals pattern already used
// across scripts/lib/model-eval/*.mjs) — resolveGenerationClient only
// constructs local SDK client objects (no network I/O until a real call is
// made), so it's safe to exercise directly without mocking.
export const _internals = { resolveGenerationClient, GENERIC_PLAN_CONTENT };
