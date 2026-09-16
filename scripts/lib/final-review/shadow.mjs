/**
 * @fileoverview The shadow-review A/B path — resolving the configured shadow
 * reviewer, building its client, running it blind (or gap-conditioned) beside
 * the primary, diffing/deduping the two finding sets, and persisting both.
 *
 * Pure relocation out of `scripts/gemini-review.mjs`
 * (`docs/plans/gemini-review-decomposition.md` Phase 3) — `gemini-review.mjs`
 * imports `runShadowAndPersist`/`resolveModelEvalShadowOverride` back and
 * keeps re-exporting every symbol here through its existing `_internals`
 * object, unchanged in shape.
 *
 * **Domain: `audit-orchestration`, not `shared-lib`** — `.audit-loop/domain-map.json`
 * carries an explicit override for this one file (its siblings envelope.mjs/
 * gap-projection.mjs/scope.mjs stay `shared-lib`, genuinely dependency-free).
 * Caught by audit-code cluster B round 1 M4: this module's real imports cross
 * into `audit-orchestration` (`gemini-review.mjs`), `learning-store`, `stores`
 * (×2) and `model-eval` (×2) — none of which `shared-lib`'s `allowedDeps`
 * admits, while `audit-orchestration` already permits all four (it is
 * `gemini-review.mjs`'s own domain, and this module is that CLI's shadow-A/B
 * orchestration in a sibling file, not a reusable library primitive).
 *
 * **This module and `gemini-review.mjs` still import each other — an
 * intra-domain cycle, not a domain-boundary violation now that both are
 * `audit-orchestration`.** Neither side reads the other's binding at module
 * top level (Node's ESM loader handles that safely; verified live by the
 * full test suite, not merely reasoned about), and the relationship is
 * explicit, not incidental:
 *   - `gemini-review.mjs` imports `runShadowAndPersist` (its own `main()`'s
 *     one call site) plus the `_internals` re-export surface below.
 *   - This module needs `runReviewWithRetry` back — a function that has no
 *     future non-`gemini-review.mjs` home (it stays there permanently; see
 *     the plan's "STAYS" list) — so it is received as an explicit dependency,
 *     never imported: `runShadowReview` takes `deps.runReviewWithRetry`
 *     (mirrors the already-established `persistFn` test-seam pattern on
 *     `runShadowAndPersist` below), and `runShadowAndPersist` forwards the
 *     one it receives from `gemini-review.mjs`'s call site. Corrected 2026-09-16
 *     (cluster B round 1 M2) after an earlier draft of this comment called the
 *     OTHER four-function edge below "ONE-DIRECTION" without acknowledging
 *     that this edge alone already makes the two-file relationship circular —
 *     true of that edge in isolation, misleading as a claim about the module
 *     graph as a whole.
 *   - `applyDebtSuppression`/`applyScopeFilter`/`applyExistenceGate`/
 *     `addSemanticIds` are imported directly from `gemini-review.mjs` (Phase 4
 *     hasn't landed yet — they live there until `post-review.mjs` exists).
 *     Phase 4 retargets these four imports to `post-review.mjs`, which
 *     removes this edge but leaves the `runReviewWithRetry`/
 *     `runShadowAndPersist` one — permanent, by design, and no longer a
 *     concern once both files agree on domain.
 *
 * @module scripts/lib/final-review/shadow
 */
import { GoogleGenAI } from '@google/genai';
import { createOpenAIClient } from '../openai-client.mjs';
import { createAnthropicClient } from '../anthropic-client.mjs';
import { resolveModel, resolveXaiCreds, resolveAlibabaCreds, resolveDeepseekCreds } from '../model-resolver.mjs';
import { azureConfig, shadowReviewConfig, findingMatchConfig, FINDING_MATCH_SCHEMA_VERSION } from '../config.mjs';
import { SHADOW_PROVIDER_SPECS, shadowModelMatchesFamily } from './provider-specs.mjs';
import { resolveOpenRouterCreds } from './providers.mjs';
import { resolveEnvelopeScope, isNonBlindScope } from './scope.mjs';
import { semanticId } from '../findings.mjs';
import { matchFindings } from '../finding-match.mjs';
import { classifyLlmError } from '../robustness.mjs';
import { isCloudEnabled } from '../store/repo.mjs';
import { resolveRepoIdentity } from '../repo-identity.mjs';
import { getActiveEvalRunId } from '../store/model-eval.mjs';
import { resolveCandidateRoute } from '../model-eval/route-catalog.mjs';
import { appendModelEvalShadowObservation } from '../model-eval/finalize-shadow-eval.mjs';
import { recordFinalReviewFindings } from '../../learning-store.mjs';
// One-directional (see fileoverview) — Phase 4 retargets these to post-review.mjs.
import { applyDebtSuppression, applyScopeFilter, applyExistenceGate, addSemanticIds } from '../../gemini-review.mjs';

/**
 * Resolve the shadow reviewer config into a concrete plan, or a skip reason.
 * Never throws (optional feature must not break the mandatory audit path).
 * Deps are injectable for tests (mirrors selectProvider).
 * @param {{shadowConfig?: object, env?: object, azureActive?: boolean, resolve?: Function}} [deps]
 * @returns {{provider: string|null, model: string|null, family?: string, state: string}}
 */
export function resolveShadow({
  shadowConfig = shadowReviewConfig,
  env = process.env,
  azureActive = azureConfig.active,
  resolve = resolveModel,
} = {}) {
  const raw = shadowConfig.provider;
  if (!raw) return { provider: null, model: null, state: 'skipped-unset' };
  // Azure guard (load-bearing): Claude/Fable/Mythos are not on Foundry.
  if (azureActive) return { provider: raw, model: null, state: 'skipped-azure' };
  const spec = SHADOW_PROVIDER_SPECS[raw];
  if (!spec) return { provider: raw, model: null, state: 'skipped-unsupported-provider' };
  // Credential presence via the spec's own resolver — a gateway legitimately has
  // two sources. Boolean only; the value never enters this result.
  if (!spec.hasCredential(env)) return { provider: spec.canonical, model: null, state: 'skipped-no-key' };
  // A GATEWAY has no meaningful default model: ids are passed verbatim, so there
  // is nothing to derive and guessing one would send an unintended model at the
  // operator's expense. Refuse explicitly instead — a named skip, never a silent
  // default (docs/plans/final-review-credit-and-cheap-shadow.md §3.2).
  if (spec.gateway && !shadowConfig.model) {
    return { provider: spec.canonical, model: null, state: 'skipped-no-model' };
  }
  // Derive the model: explicit override (validated against family) or per-
  // provider default. config injects NO default, so an unset model means
  // "derive from provider" (Gemini R2 G3).
  let model;
  if (shadowConfig.model) {
    // Gateways bypass resolveModel entirely (descriptor D6): a sentinel rewrite
    // would mangle `moonshotai/kimi-k2-thinking` into something the gateway has
    // never heard of.
    model = spec.gateway ? shadowConfig.model : resolve(shadowConfig.model, { silent: true });
    if (!shadowModelMatchesFamily(model, spec.family)) {
      return { provider: spec.canonical, model, state: 'skipped-unsupported-provider' };
    }
  } else {
    model = resolve(spec.defaultSentinel, { silent: true });
  }
  return { provider: spec.canonical, model, family: spec.family, state: 'ready' };
}

/**
 * Build a provider-appropriate client for the shadow reviewer.
 * `'azure-claude'` (model-swap-eval-harness Phase 4) mirrors buildClient's
 * existing azure-claude branch exactly (below, the PRIMARY reviewer's
 * client builder) — this was the actual "no-op under Azure" gap the plan's
 * round-1 audit M3 fix closes: the shadow path never had ANY Azure support
 * before this, unlike the primary reviewer path which already did.
 */
export async function buildShadowClient(canonicalProvider) {
  if (canonicalProvider === 'gemini') {
    return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  if (canonicalProvider === 'openrouter') {
    // Delegates to the PRIMARY route's own credential resolver rather than
    // re-deriving the baseURL/key here — one definition of "how do we reach
    // OpenRouter", so the shadow can never drift onto a different endpoint than
    // the primary. Note `buildShadowClient` deliberately does NOT call
    // `PROVIDERS[...].buildClient`/`assertReady`; the openrouter descriptor's
    // assertReady demands FINAL_REVIEW_MODEL (the PRIMARY's model), which a
    // shadow run has no reason to set. Readiness for this path is enforced in
    // resolveShadow instead — see its credential + explicit-model checks.
    const c = resolveOpenRouterCreds();
    return createOpenAIClient({ oss: { baseURL: c.baseUrl, apiKey: c.apiKey } });
  }
  if (canonicalProvider === 'azure-claude') {
    if (azureConfig.claudeApiShape === 'anthropic') {
      return createAnthropicClient({ azureRoute: azureConfig.claudeRoute });
    }
    return createOpenAIClient({ purpose: 'foundry-claude' });
  }
  if (canonicalProvider === 'xai') {
    // Same non-delegation note as openrouter above: buildShadowClient does NOT
    // call PROVIDERS.xai.assertReady/buildClient — that descriptor's assertReady
    // is a plain env check the shadow path duplicates in resolveShadow's own
    // hasCredential, so calling both would just be two places to keep in sync.
    const c = resolveXaiCreds();
    return createOpenAIClient({ oss: { baseURL: c.baseUrl, apiKey: c.apiKey } });
  }
  if (canonicalProvider === 'alibaba') {
    // Same non-delegation note as openrouter/xai above.
    const c = resolveAlibabaCreds();
    return createOpenAIClient({ oss: { baseURL: c.baseUrl, apiKey: c.apiKey } });
  }
  if (canonicalProvider === 'deepseek') {
    // Same non-delegation note as openrouter/xai/alibaba above.
    const c = resolveDeepseekCreds();
    return createOpenAIClient({ oss: { baseURL: c.baseUrl, apiKey: c.apiKey } });
  }
  // `backend:'sdk'` PINNED, never the ambient CLAUDE_BACKEND (found live
  // 2026-07-26 on the shadow's first real run). This transport gets its JSON
  // contract from a PROMPT INSTRUCTION ("Output strictly valid JSON") with no
  // provider-side enforcement — Gemini has `responseSchema`, Anthropic here has
  // nothing. Under `CLAUDE_BACKEND=cli` the call is served by a conversational
  // `claude -p`, which returned a markdown report ("# Final Gate Review … ##
  // Verdict: **APPROVE**") — no JSON object anywhere, so `parseReviewJson`
  // threw and the observation was dropped as `error-unavailable`. The shadow
  // stayed enabled and silently recorded NOTHING: precisely the dead-experiment
  // failure mode the A/B exists to avoid, and the same class as the tiered
  // pipeline's discovery generator (AGENTS.md: any call needing a structured
  // response must pin the sdk backend explicitly).
  //
  // Cost note: this bills ANTHROPIC_API_KEY rather than drawing Max-20x Agent
  // SDK credit. Accepted deliberately — the pre-registered window is ~20 runs,
  // and a shadow that produces no parseable verdict has zero value at any price.
  // `azureRoute: null` keeps that cost note TRUE on an Azure machine: the shadow
  // arm is named `claude-opus`, so it must stay the public service rather than
  // adopting the tenant's route and quietly changing what the A/B compares.
  return createAnthropicClient({ backend: 'sdk', azureRoute: null });
}

// ── Model-eval adjudicator Tier A/B override (model-swap-eval-harness
// Phase 4) ───────────────────────────────────────────────────────────────
//
// Round-6 audit H4 fix (the plan's own self-correction): gating discovery
// behind FINAL_REVIEW_SHADOW would defeat its own purpose — an operator
// starts a Tier A/B eval today, but the /audit-code runs that need to
// collect shadow observations happen days/weeks later, in ordinary
// sessions where FINAL_REVIEW_SHADOW was never set (that env var is the
// OPERATOR's manual shadow-reviewer choice, unrelated to whether an eval
// run is active). So this resolves UNCONDITIONALLY whenever cloud is
// configured — independent of FINAL_REVIEW_SHADOW — and its result
// OVERRIDES (never requires) any FINAL_REVIEW_SHADOW setting. A null
// result (the common case) falls through to today's ordinary
// resolveShadow() behavior, byte-identical to pre-plan.
//
// Only maps to the THREE provider strings runFinalReview's prompt dispatch
// already supports (gemini / claude-opus / azure-claude) — an
// openai-compatible-transport adjudicator candidate (a GPT-family
// candidateSpec) has no existing prompt-building branch in this file and
// is deliberately NOT wired here; model-eval-adjudicator.mjs falls back to
// Tier C for that transport rather than this file growing a fourth
// provider dispatch branch for a case the plan's primary use case (an
// Azure Claude candidate) doesn't need.
/**
 * Pure — maps a resolved route to one of the three provider strings
 * runFinalReview's prompt dispatch supports, or null when the transport has
 * no live-shadow prompt path yet. Extracted as its own function so the
 * mapping logic is directly unit-testable without a live DB/active eval run.
 */
export function mapRouteToShadowProvider(route) {
  if (route.transport === 'native-gemini') return 'gemini';
  if (route.transport === 'native-anthropic') return route.provider === 'azure' ? 'azure-claude' : 'claude-opus';
  return null;
}

export async function resolveModelEvalShadowOverride() {
  if (!await isCloudEnabled()) return null;
  let repoId;
  try {
    repoId = resolveRepoIdentity().repoUuid;
  } catch {
    return null; // not a git repo / no identity resolvable — never fatal
  }
  const active = await getActiveEvalRunId({ repoId, role: 'adjudicator' });
  if (!active) return null;

  let route;
  try {
    route = resolveCandidateRoute({ role: 'adjudicator', candidateSpec: active.candidateRef.candidateSpec });
  } catch (err) {
    process.stderr.write(`  [model-eval-shadow] active run ${active.runId}: candidate route failed to resolve — ${err.message}\n`);
    return null;
  }

  const provider = mapRouteToShadowProvider(route);
  if (!provider) {
    process.stderr.write(`  [model-eval-shadow] active run ${active.runId}: transport "${route.transport}" has no live-shadow prompt path yet (Tier C only) — skipping override\n`);
    return null;
  }

  return {
    repoId, modelEvalRunId: active.runId,
    shadow: { provider, model: route.deploymentId ?? route.resolvedModel, state: 'ready' },
  };
}

/**
 * Run the shadow review on the same transcript as the primary, then apply the
 * identical suppression/scope/semantic-id pipeline so finding counts are
 * comparable. Returns {result, usage, latencyMs}.
 *
 * BLINDNESS IS SCOPE-DEPENDENT — do not read the old unconditional claim here.
 * `full` and `thin` are BLIND: the primary's result is not a parameter of this
 * function and is never forwarded, so blindness is structural rather than
 * conventional. `gap` deliberately surrenders it — the mode's whole job is
 * "what did the primary miss?", which cannot be asked without showing it the
 * primary's findings. That trade is why `gap` is campaign-INELIGIBLE: a shadow
 * conditioned on its own arm's stochastic primary is not comparable across arms.
 *
 * `options.runReviewWithRetry` is a REQUIRED dependency, not a test seam —
 * see the fileoverview's cycle note. `runShadowAndPersist` (below) always
 * forwards the one it received from `gemini-review.mjs`.
 */
async function runShadowReview(shadow, planContent, transcriptContent, projectContext, auditMode, options = {}) {
  const { runReviewWithRetry, ...retryOptions } = options;
  const client = await buildShadowClient(shadow.provider);
  const r = await runReviewWithRetry(
    shadow.provider, client, planContent, transcriptContent, projectContext, auditMode, shadow.model, retryOptions
  );
  const { result, usage, latencyMs, requestFingerprint, transcriptContent: usedTranscript } = r;
  await applyDebtSuppression(result, usedTranscript);
  await applyScopeFilter(result, usedTranscript);
  applyExistenceGate(result);
  addSemanticIds(result, shadow.provider);
  return { result, usage, latencyMs, requestFingerprint };
}

/**
 * Dedup a reviewer's findings by semantic hash (R3 M2 — no count inflation).
 * A finding is normally pre-stamped with `_hash` by addSemanticIds(); if one
 * arrives without it (defensive — a programming error upstream), we compute
 * semanticId(f) as a fallback rather than SILENTLY DROPPING it (cluster-A R2 H1
 * — silent data loss). Only a truly empty/nullish entry is skipped.
 */
export function dedupByHash(findings) {
  const seen = new Map();
  for (const f of (findings || [])) {
    if (!f) continue;
    const key = f._hash || semanticId(f);
    // The fallback must be written BACK onto the finding, not just used as the
    // Map key (audit-code cluster A R3 M1): diffFindingBuckets reads `f._hash`
    // directly to build its both/primary-only/shadow-only Sets, so a
    // hash-less finding that survived dedup via its semantic-id fallback would
    // otherwise contribute `undefined` to that Set — colliding with every
    // OTHER hash-less finding rather than being classified on its own identity.
    if (!f._hash) f._hash = key;
    if (!seen.has(key)) seen.set(key, f);
  }
  return [...seen.values()];
}

/**
 * Classify each reviewer's findings into both / primary-only / shadow-only by
 * semantic-hash set membership (after per-reviewer dedup). Stamps `_bucket` on
 * each finding. The SINGLE writer of the three bucket literals (R3 M5).
 */
export function diffFindingBuckets(primaryResult, shadowResult) {
  const p = dedupByHash(primaryResult?.new_findings);
  const s = dedupByHash(shadowResult?.new_findings);
  const pHashes = new Set(p.map((f) => f._hash));
  const sHashes = new Set(s.map((f) => f._hash));
  for (const f of p) f._bucket = sHashes.has(f._hash) ? 'both' : 'primary-only';
  for (const f of s) f._bucket = pHashes.has(f._hash) ? 'both' : 'shadow-only';
  return {
    primary: p,
    shadow: s,
    counts: {
      both: p.filter((f) => f._bucket === 'both').length,
      primaryOnly: p.filter((f) => f._bucket === 'primary-only').length,
      shadowOnly: s.filter((f) => f._bucket === 'shadow-only').length,
    },
  };
}

/**
 * The file+similarity view of the same two finding sets (plan §2.5b-i).
 *
 * Returns `null` — not an empty bucket set — when matching is disabled, so a
 * consumer can tell "not computed" from "computed, found nothing". An empty
 * bucket set here would read as a measured zero, which is the exact failure
 * this whole change is fixing.
 */
function buildMatchedBuckets(primaryResult, shadowResult) {
  if (!findingMatchConfig.enabled) return null;
  const p = dedupByHash(primaryResult?.new_findings);
  const s = dedupByHash(shadowResult?.new_findings);
  const r = matchFindings(p, s, {
    threshold: findingMatchConfig.threshold,
    coverageFloor: findingMatchConfig.coverageFloor,
  });
  return {
    both: r.both,
    primaryOnly: r.primaryOnly,
    shadowOnly: r.shadowOnly,
    unmatchablePrimary: r.unmatchablePrimary,
    unmatchableShadow: r.unmatchableShadow,
    coverage: r.coverage,
    verdict: r.verdict,
    // Evidence for every merge: both hashes and the score that joined them.
    // A `both` count without this is an unauditable assertion — you could not
    // answer "which two findings did it merge, and how close were they?", which
    // is the only way to catch a false merge after the fact.
    pairs: r.pairs,
  };
}

/**
 * The `_shadow` block for a shadow reviewer that FAILED.
 *
 * A function rather than an object literal inside the catch, because it carries
 * a cross-process contract and a contract needs a boundary to be tested at: the
 * bake-off collector decides whether to re-spawn the arm from `errorRetryable`,
 * and a timed-out shadow and one rejected for a bad model id are otherwise
 * separated only by an English sentence. The classification is therefore made
 * HERE, by the repo's single `classifyLlmError` oracle, where the error object
 * still exists — nothing downstream can recover it from `error` prose.
 *
 * A consumer that finds these fields absent (an artifact from a reviewer
 * predating them) must read that as "not classified", never as "retryable".
 *
 * @param {{provider: string|null, model: string|null}} shadow
 * @param {Error} err
 */
export function shadowErrorBlock(shadow, err) {
  const cls = classifyLlmError(err);
  return {
    state: 'error-unavailable', provider: shadow.provider, model: shadow.model,
    verdict: null, usage: null, buckets: null, shadowOnlyFindings: null,
    error: (err.message || 'unknown error').slice(0, 300),
    errorCategory: cls.category,
    errorRetryable: cls.retryable,
    // What the attempt COST is unknown, not zero: the provider may well have
    // burned the full reasoning budget before the deadline fired and simply
    // never returned a usage block. `usage: null` above already reads as
    // unmeterable to `armCostUsd`; this states it in the artifact so a reader
    // does not have to infer it from an absence.
    usageEvidence: 'unreported-call-may-have-been-billed',
  };
}

/** The empty/skip `_shadow` block for a given skip state. */
function shadowSkipBlock(shadow) {
  return {
    state: shadow.state, provider: shadow.provider, model: shadow.model,
    verdict: null, usage: null, buckets: null, shadowOnlyFindings: null, error: null,
  };
}

/**
 * Build the `recordFinalReviewFindings` payload from an already-completed
 * review round. PURE — no I/O, no provider call — extracted 2026-09-14
 * (audit-code cluster A R1 M6) specifically so the three shapes this produces
 * (shadow executed non-empty, executed empty, did-not-run) are testable with
 * hand-built fixtures instead of only as a call-shape assertion on the
 * source: the network boundary this repo's testing doctrine forbids mocking
 * (Tier 2, no whole-provider mock) sits entirely in `runShadowAndPersist`
 * BEFORE this function ever runs, not inside it.
 *
 * @param {{result: object, diff: {primary: object[], shadow: object[]}|null, primaryModel: string, shadow: {model?: string}}} args
 *   `result._shadow` must already be populated (`shadowSkipBlock` /
 *   the 'ran' block / `shadowErrorBlock`) — this function only reads it.
 * @returns {{primary: object[], shadow: object[], shadowRan: boolean, models: object, verdict: string|null}}
 */
export function buildFinalReviewPersistPayload({ result, diff, primaryModel, shadow }) {
  const ran = result._shadow.state === 'ran';
  const primaryFindings = (diff?.primary) || dedupByHash(result.new_findings);
  for (const f of primaryFindings) {
    f._sourceModel = primaryModel;
    if (!ran) f._bucket = null; // bucket only meaningful when both reviewers ran
  }
  const shadowFindings = ran ? diff.shadow : [];
  return {
    primary: primaryFindings,
    shadow: shadowFindings,
    // `ran` already means exactly this: did the shadow reviewer actually
    // execute this round (final-review-credit-projection.md Seam 3). Forwarded
    // verbatim so the store can tell "shadow did not run" (leave prior shadow
    // rows untouched) from "shadow ran and found nothing" (prune the unruled
    // ones) — a distinction `shadow: []` alone cannot make.
    shadowRan: ran,
    models: {
      primaryModel,
      shadowModel: ran ? shadow.model : null,
      shadowInputTokens: result._shadow.usage?.input_tokens ?? null,
      shadowOutputTokens: result._shadow.usage?.output_tokens ?? null,
      shadowLatencyMs: result._shadow.usage?.latency_ms ?? null,
    },
    // The PRIMARY reviewer's verdict — the thing Step 7 exists to produce, and
    // until 2026-07-18 the one part of it that was never persisted. Explicitly
    // NOT `result._shadow.verdict`: the shadow is observation-only and must
    // never reach a column anything gates on.
    verdict: result.verdict ?? null,
  };
}

/**
 * Run the shadow reviewer (when enabled) and persist both reviewers' findings.
 * Mutates `result` to add `result._shadow`. Returns nothing — observation only.
 *
 * Decoupling (Gemini G2): primary final-review rows persist whenever
 * cloud+runId, INDEPENDENT of the shadow. Shadow rows + shadow model/usage
 * persist only when the shadow actually ran (`state==='ran'`).
 *
 * @param {object} result          primary reviewer result (already id-stamped)
 * @param {string} primaryModel    primary reviewer's resolved concrete model id
 * @param {string|null} runId      audit_runs.id (null → local-only, no cloud)
 * @param {{modelEvalOverride?: {repoId:string, modelEvalRunId:string, shadow:object}|null, envelopeScopeCli?: string|null, campaignDigest?: string|null, persistFn?: Function, runReviewWithRetry: Function}} [opts]
 *   `runReviewWithRetry` is REQUIRED whenever the shadow can actually run
 *   (see the fileoverview's cycle note) — `gemini-review.mjs`'s one call
 *   site always supplies it. Tests that force a non-'ready' shadow state
 *   (`modelEvalOverride` with `shadow.state !== 'ready'`) never reach the
 *   code path that calls it, so they may omit it.
 */
export async function runShadowAndPersist(result, primaryModel, runId, { planContent, transcriptContent, projectContext, auditMode }, { modelEvalOverride = null, envelopeScopeCli = null, campaignDigest = null, persistFn = recordFinalReviewFindings, runReviewWithRetry } = {}) {
  // `persistFn` is a test seam ONLY, same shape as `modelEvalOverride` above —
  // production always takes the default (the real store writer). Lets the
  // producer→store contract test capture the payload this function builds
  // (final-review-credit-projection.md Seam 3) without a whole-provider mock
  // or a real database.
  // modelEvalOverride (Phase 4) takes priority over the ordinary
  // FINAL_REVIEW_SHADOW-derived resolution — resolveModelEvalShadowOverride()
  // itself only returns non-null when an adjudicator Tier A/B eval run is
  // actively collecting for THIS repo, so this never silently hijacks an
  // operator's own FINAL_REVIEW_SHADOW choice when no eval is running.
  const shadow = modelEvalOverride ? modelEvalOverride.shadow : resolveShadow();
  let diff = null;

  // Campaign identity + scope resolution happen HERE, unconditionally and
  // BEFORE the shadow.state check — never inside the try/catch below, whose
  // only job is making an ACTUAL PROVIDER CALL failure non-fatal. A
  // config-level refusal must propagate as a genuine uncaught error ("exit
  // non-zero before any client is constructed" is the plan's own test for
  // this); relabelling it 'error-unavailable' via the catch would silently
  // turn a campaign-safety refusal into the same non-fatal shrug a network
  // timeout gets, which defeats the entire point of refusing early.
  //
  // Campaign identity is `--campaign-digest`'s PRESENCE, never how scope was
  // supplied (KD-6's correction: an earlier draft used "was --envelope-scope
  // given" as the campaign signal, which made identical `gap` intent behave
  // differently by transport — gap via env was fine, gap via CLI was a
  // violation, for no reason a caller could predict).
  //
  // Scope resolution has ONE home (scope.mjs). Precedence: --envelope-scope
  // (campaign) > FINAL_REVIEW_SHADOW_SCOPE (operator) > 'full' (default) —
  // resolveEnvelopeScope's own cli-then-env precedence gives this for free.
  const campaignActive = campaignDigest !== null;
  const scopeRes = resolveEnvelopeScope({ cliScope: envelopeScopeCli, envScope: shadowReviewConfig.scope });
  if (campaignActive && scopeRes.scope === 'gap') {
    // Zero-latency failure — the tell that nothing was billed.
    throw new Error(
      '[shadow-review] --envelope-scope gap is campaign-ineligible (plan KD-5): a gap '
      + 'shadow is conditioned on its own arm\'s primary result, so gap arms are not '
      + 'comparable across a cohort. Refusing before any provider call.',
    );
  }
  if (scopeRes.invalid !== null) {
    // Disposition differs by whether a campaign is watching. Interactive:
    // loud warning, proceed on 'full' (the most expensive envelope, so a
    // typo cannot silently buy the cheap behaviour). Campaign: hard reject
    // before any billed call — an unattended run has nobody to read the
    // warning, and the operator-approved plan explicitly requires this.
    if (campaignActive) {
      throw new Error(
        `[shadow-review] invalid --envelope-scope "${scopeRes.invalid}" under an active campaign `
        + '(--campaign-digest present) — refusing before any provider call. Campaign scope must be valid.',
      );
    }
    process.stderr.write(
      `  [shadow-review] WARNING: FINAL_REVIEW_SHADOW_SCOPE="${scopeRes.invalid}" is not one of `
      + `full|thin|gap — falling back to "full" (the most expensive envelope). `
      + 'Fix the value or unset it.\n',
    );
  }
  const envelopeScope = scopeRes.scope;

  if (shadow.state !== 'ready') {
    result._shadow = shadowSkipBlock(shadow);
    if (shadow.state !== 'skipped-unset') {
      process.stderr.write(`  [shadow-review] ${shadow.state} (provider=${shadow.provider ?? '-'})\n`);
    }
  } else {
    try {
      // `primaryResult` is passed ONLY for `gap` — for `full`/`thin` it stays
      // null so blindness is enforced by what the callee receives, not by
      // what it promises.
      const sr = await runShadowReview(shadow, planContent, transcriptContent, projectContext, auditMode, {
        envelopeScope,
        primaryResult: isNonBlindScope(envelopeScope) ? result : null,
        runReviewWithRetry,
      });
      diff = diffFindingBuckets(result, sr.result);
      for (const f of diff.primary) f._sourceModel = primaryModel;
      for (const f of diff.shadow) f._sourceModel = shadow.model;
      result._shadow = {
        state: 'ran', provider: shadow.provider, model: shadow.model,
        // Provenance: WHICH envelope produced this observation. Without it a
        // persisted shadow row cannot be told apart across contract epochs, and
        // the campaign's scope-binding eligibility check has nothing to read.
        scope: envelopeScope,
        envelope: sr.result?._envelope ?? null,
        // Recorded, never verified here — verification is the COLLECTOR's job
        // (it owns the manifest and can recompute against it). This is what
        // lets a persisted snapshot be matched to the specific signed cohort
        // that claims it, rather than merely being contemporaneous with one.
        campaignDigest,
        verdict: sr.result.verdict,
        // Cache token counts are copied, not dropped. This envelope is rebuilt
        // by hand rather than spread, so any field omitted here does not exist
        // downstream however correct the adapter was — and on a cache WRITE the
        // provider moves the whole prefix OUT of `input_tokens`, so omitting
        // these two would have reported an 81K-token shadow review as costing
        // almost nothing. Absent on providers that do not cache, where they
        // sanitize to 0 and the arithmetic is unchanged.
        usage: {
          input_tokens: sr.usage.input_tokens,
          output_tokens: sr.usage.output_tokens,
          cache_creation_input_tokens: sr.usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: sr.usage.cache_read_input_tokens ?? 0,
          latency_ms: sr.latencyMs,
        },
        // Lets a bake-off detect that a "different arm" issued the SAME request.
        requestFingerprint: sr.requestFingerprint ?? null,
        // The ambient-independent companion (see runFinalReview). Carried
        // beside, never instead of — the field above keeps its prior meaning.
        requestIdentity: sr.requestIdentity ?? null,
        buckets: diff.counts,
        // BOTH views, side by side. `buckets` keeps its exact prior meaning
        // (exact-hash), so the pre-registered metric is untouched and no
        // collected snapshot is invalidated — that is what keeps this off a
        // CONTRACT_EPOCH bump. `bucketsMatched` is additive evidence.
        bucketsMatched: buildMatchedBuckets(result, sr.result),
        matchSchemaVersion: FINDING_MATCH_SCHEMA_VERSION,
        matchConfig: {
          threshold: findingMatchConfig.threshold,
          coverageFloor: findingMatchConfig.coverageFloor,
          enabled: findingMatchConfig.enabled,
        },
        // The shadow's FULL deduped list, under a NEW field. `shadowOnlyFindings`
        // keeps meaning only the shadow-only subset — widening a field named
        // `shadowOnly…` would silently change what every existing reader gets,
        // the same defect class this plan exists to fix. Without the full list
        // no future matching rule can be re-derived from a collected snapshot,
        // which is why each instrument change used to shrink the cohort.
        allFindings: dedupByHash(sr.result?.new_findings).map((f) => ({
          fingerprint: f._hash,
          severity: f.severity,
          category: f.category,
          section: f.section,
          affectedFiles: f.affectedFiles ?? [],
          detail: (f.detail || '').slice(0, 600),
        })),
        shadowOnlyFindings: diff.shadow
          .filter((f) => f._bucket === 'shadow-only')
          .map((f) => ({ fingerprint: f._hash, severity: f.severity, category: f.category, section: f.section, detail: (f.detail || '').slice(0, 600) })),
        error: null,
      };
      process.stderr.write(`  [shadow-review] ran ${shadow.model} — buckets both:${diff.counts.both} primary-only:${diff.counts.primaryOnly} shadow-only:${diff.counts.shadowOnly}\n`);
    } catch (err) {
      result._shadow = shadowErrorBlock(shadow, err);
      process.stderr.write(`  [shadow-review] FAILED (non-fatal, primary review unaffected): ${err.message}\n`);
    }
  }

  // Cloud persistence — primary always (when cloud+runId); shadow only when ran.
  if (!runId) return;
  const persistPayload = buildFinalReviewPersistPayload({ result, diff, primaryModel, shadow });
  await persistFn(runId, persistPayload);

  // Phase 4 — append a model_eval_shadow_observations row when a Tier A/B
  // eval run is actively collecting AND the shadow actually ran this time
  // (a skip/error round contributes nothing to score against). findingRefs
  // disambiguates the underlying audit_runs.id from THIS observation's own
  // model_eval_run_id FK (round-6 audit H5) — finding_fingerprint alone is
  // only unique WITHIN one audit run. idempotencyKey = the audit run's own
  // id: runShadowAndPersist runs at most once per audit run, so a repeated
  // write for the same run upserts rather than duplicating.
  //
  // Reuses `persistPayload.primary`/`.shadow`/`.shadowRan` — the SAME
  // findings/flag just handed to the store, never a second derivation.
  if (modelEvalOverride && persistPayload.shadowRan) {
    const findingRefs = [
      ...persistPayload.primary.map((f) => ({ auditRunId: runId, findingFingerprint: f._hash, passName: 'final-review', bucket: f._bucket })),
      ...persistPayload.shadow.map((f) => ({ auditRunId: runId, findingFingerprint: f._hash, passName: 'final-review-shadow', bucket: f._bucket })),
    ];
    try {
      await appendModelEvalShadowObservation({
        repoId: modelEvalOverride.repoId, runId: modelEvalOverride.modelEvalRunId,
        observation: { findingRefs }, idempotencyKey: runId,
      });
    } catch (err) {
      process.stderr.write(`  [model-eval-shadow] appendModelEvalShadowObservation failed (non-fatal): ${err.message}\n`);
    }
  }
}
