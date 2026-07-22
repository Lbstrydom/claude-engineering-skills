/**
 * @fileoverview Tiered-recall pipeline Close-out — prospective shadow
 * validation. Runs `runTieredAuditPipeline` alongside the real, gating
 * `runLegacyProductionAudit` for the SAME commit — observation-only, never
 * gating, never blocking the real result — and logs a structured comparison
 * so an operator can review the accumulated evidence before Phase 14's
 * production-flip decision.
 *
 * **Deliberately NOT built as a 4th arm on the existing model-A/B/C shadow
 * infra** (`audit-shadow.mjs`/`arm-eval/toggle.mjs`), even though the plan's
 * Close-out text suggested reusing it. Traced directly (2026-07-13): that
 * infra's execution engine substitutes a model into the existing PER-PASS
 * GPT-5-pass loop (Thompson sampling, spend-cap reserve/reconcile,
 * Supabase-persisted arm stats) — machinery built for an ONGOING
 * multi-armed-bandit exploration among per-pass model compositions.
 * `runTieredAuditPipeline` is a fundamentally different shape: a
 * self-contained function returning ONE complete `AuditRunResult`
 * (discovery → Stage 0 → Stage 1 → Stage 2), not a per-pass substitution.
 * Forcing it into the bandit shape would mean either inventing new code
 * paths in an already-complex, heavily-audited module for a capability
 * (continuous arm exploration) this ONE-TIME comparison doesn't need, or
 * leaving most of that machinery unused once Phase 14 resolves — future
 * dead code either way. This module is deliberately small, decoupled from
 * `audit-shadow.mjs` entirely, and easy to remove once the shadow-
 * validation window (the plan's own "10-15 real commits") closes.
 *
 * **Concurrency**: neither `runLegacyProductionAudit` nor
 * `runTieredAuditPipeline` mutate `process.cwd()` (verified directly —
 * both only READ it); the chdir hazard that forces the model-eval harness's
 * candidate/baseline generation to serialize is specific to THAT harness's
 * cross-repo corpus-replay wrapper, not to a same-repo production run. The
 * two pipelines are therefore run concurrently here (`Promise.all`-shaped
 * in the caller), cutting shadow-window wall-clock roughly in half versus
 * sequential — real, measured performance, not a hypothetical optimization.
 *
 * **Persistence — local + cloud, cloud optional** (revised 2026-07-13): a
 * local, gitignored JSONL log (`.audit/tiered-shadow-log.jsonl`, mirroring
 * `quickfix-scan.mjs` → `.audit/quickfix-hits.jsonl`) remains the always-
 * available fallback, PLUS a best-effort write to `tiered_shadow_
 * observations` (`store/tiered-shadow.mjs`) via the existing single-tenant
 * Supabase project every repo already shares. The original "local-only,
 * no new schema" design was reconsidered once a REAL requirement surfaced:
 * the shadow-validation window spans 3 repos on one operator's machine, and
 * "how many total shadow runs have we accumulated across all of them" has
 * no answer from 3 independent local files without manually summing. The
 * cloud write reuses this repo's already-provisioned DB (no new
 * infrastructure, just one more table + one insert call) and matches the
 * project's own stated convention that cross-skill data flows through the
 * shared store — this is closing a gap in that convention, not violating
 * the design-rightsizing gate the original reasoning invoked.
 *
 * Plan: docs/plans/tiered-recall-audit-pipeline.md Close-out (shadow validation).
 *
 * @module scripts/lib/audit/tiered-shadow-compare
 */

import fs from 'node:fs';
import path from 'node:path';
import { semanticId } from '../findings.mjs';
import { normalizePath } from '../file-io.mjs';
import { resolveRepoIdentity } from '../repo-identity.mjs';
import { appendTieredShadowObservation } from '../store/tiered-shadow.mjs';
import { isFileInChangedScope } from './deferral-classifier.mjs';
import { TieredUnavailableError } from './tiered-pipeline.mjs';

export const SHADOW_LOG_PATH = path.join('.audit', 'tiered-shadow-log.jsonl');

/**
 * Build a shadow-safe copy of an `AuditRunContext` — same read-only inputs
 * (diff, files, plan, project context) as the real run, but with every
 * stateful WRITE path disabled so the shadow run cannot mutate anything the
 * real (gating) audit or a future round depends on.
 *
 * `ledgerFile: null` is load-bearing, not a formality: `stage1-triage.mjs`'s
 * own contract is "no ledgerPath means don't write" (verified directly —
 * it is NOT gated by `noLedger`/`noDebtLedger`, which the tiered pipeline
 * doesn't currently read at all) — so a scratch/placeholder path would
 * still write real ledger entries; `null` is the only value that
 * guarantees zero writes.
 *
 * @param {import('../schemas.mjs').AuditRunContext} ctx
 * @returns {import('../schemas.mjs').AuditRunContext}
 */
export function buildShadowCtx(ctx) {
  return {
    ...ctx,
    // A shallow spread shares every NESTED value with the real ctx — and
    // `generatorOutcomes` is mutated IN PLACE (append-only) by
    // discovery-portfolio.mjs, so the shadow's discovery was pushing its
    // outcomes into the REAL run's array while the two ran concurrently
    // (audit round-1 M2, reproduced directly). Contained today only by
    // luck: `runLegacyProductionAudit` happens to hardcode
    // `generatorOutcomes: []` on its result (legacy-production-audit.mjs:2974),
    // so the pollution never escaped into the real audit's output. That is a
    // latent hazard, not a design — and it directly contradicts this
    // function's own contract ("every stateful WRITE path disabled so the
    // shadow run cannot mutate anything the real audit … depends on").
    // Snapshot it: the shadow gets its own array, nothing shared.
    generatorOutcomes: [...(ctx.generatorOutcomes || [])],
    ledgerFile: null,
    noLedger: true,
    // Read TODAY by `routePreExistingIndependent` (tiered-pipeline.mjs) —
    // a shadow's pre_existing_independent candidates resolve to
    // `debt_ledger_disabled` and write nothing (verified directly; audit
    // round-1 H1 claimed the opposite and was refuted by reproduction).
    // This comment previously said "it doesn't today", which went stale when
    // the Stage-0 debt-routing path landed.
    noDebtLedger: true,
    readOnlyDebt: true,
    // Blocks ALL learning-store writes (audit_runs, audit_findings, pass
    // stats, decisions, …) in runLegacyProductionAudit's cloud-recording
    // block — reached when the tiered pipeline falls back to it internally
    // on a required-generator failure, running CONCURRENTLY with the real,
    // gating legacy audit for the same commit. Since 2026-07-18 this
    // guarantee is actually complete: the orchestrator's
    // `learningWritesAllowed = !noCloudRecording` gates the two tail syncs
    // the `cloudRunId` key never covered (syncBanditArms — no repoId, wrote
    // whenever cloud was on — and syncFalsePositivePatterns), and the shared
    // `ctx.bandit` is swapped for a `nonPersistingView()` at entry so the
    // shadow's addArm/flush can't touch the real run's local state either
    // (the shallow ...ctx spread above shares the live instance — the same
    // shared-nested-value hazard as generatorOutcomes below). `ctx.runId` is kept
    // UNCHANGED (not mangled) — it's still used as a local telemetry label
    // (tiered-pipeline.mjs's `_sid`), just never reaches a DB write here.
    // Previously mangled to `${runId}-shadow` to dodge colliding with the
    // real run's row, which isn't a valid uuid and made every attempt fail
    // loudly (`invalid input syntax for type uuid`) instead of writing
    // nothing — this flag is the actual fix, not a differently-shaped id.
    noCloudRecording: true,
    // The shadow has NO obligation to return findings, so it must never fall
    // back to a second legacy audit when a required discovery generator fails
    // (plan: docs/plans/shadow-no-legacy-fallback.md). Without this, 41 of 57
    // live records each burned a full extra 5-pass GPT audit and then
    // compared legacy against legacy. `runTieredAuditPipeline` throws
    // TieredUnavailableError instead, which the catch below turns into this
    // module's EXISTING honest {ok:false, error} outcome.
    //
    // Sits with the four flags above as one more "this is not the real run"
    // marker — the same role this function already has. PRODUCTION never sets
    // it, so `openai-audit.mjs`'s gating path keeps falling back exactly as
    // before; a future caller that forgets it fails SAFE (it falls back —
    // costly but correct, never a wrong result).
    shadowMode: true,
  };
}

/**
 * Parse this repo's `_pass_timings.total` convention (`"3.2s"`) into a
 * number of seconds. Returns `null` for anything unparseable — a shape
 * mismatch must never masquerade as `0s`.
 * @param {string|undefined} totalStr
 * @returns {number|null}
 */
function parseTotalSeconds(totalStr) {
  if (typeof totalStr !== 'string') return null;
  // Strict decimal grammar (Cluster-C audit M1/M4): the old `[\d.]+` class
  // accepted malformed strings like "1..5s" / "..s", which parseFloat then
  // silently truncated to a numeric prefix (or NaN) — a shape mismatch
  // masquerading as a real timing. Exactly one optional fraction part.
  const m = totalStr.match(/^(\d+(?:\.\d+)?)s$/);
  return m ? Number.parseFloat(m[1]) : null;
}

/**
 * Resolve the file a finding cites, using this repo's existing
 * `_primaryFile`/`affectedFiles` convention (ledger.mjs::populateFindingMetadata),
 * falling back to the `section`'s own `file:line` prefix — the same
 * derivation `populateFindingMetadata` itself uses when no regex match
 * exists, so an un-enriched finding still resolves.
 * @param {object} f
 * @returns {string|null}
 */
function findingFile(f) {
  if (f?._primaryFile) return normalizePath(f._primaryFile);
  if (Array.isArray(f?.affectedFiles) && f.affectedFiles[0]) return normalizePath(f.affectedFiles[0]);
  const section = f?.section || '';
  const derived = section.split(':')[0].split('(')[0].trim();
  return derived ? normalizePath(derived) : null;
}

/**
 * Resolve the line a finding cites, from `_primaryLine` or the `section`'s
 * `file:line` prefix (the same `file:line (fn)` convention `findingFile`
 * strips the file from). Returns `null` when no line is resolvable — never a
 * fabricated 0 (a shape mismatch must not masquerade as line 0).
 * @param {object} f
 * @returns {number|null}
 */
function findingLine(f) {
  if (Number.isInteger(f?._primaryLine)) return f._primaryLine;
  const m = (f?.section || '').match(/:(\d+)\b/);
  return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * Line window within which two auditors citing the same file are treated as
 * flagging the same underlying issue. Different auditors routinely cite a
 * bug a few lines apart (the anchor line of a block vs the offending
 * statement inside it), so an exact-line match would systematically miss real
 * agreement; 5 lines is tight enough that two genuinely-distinct bugs in the
 * same file don't collide.
 */
const OVERLAP_LINE_WINDOW = 5;

/**
 * Do a legacy and a tiered finding refer to the SAME underlying issue?
 *
 * Correlated by LOCATION (file + line proximity), NOT by `semanticId` —
 * `semanticId` hashes the finding's PROSE (`category|section|detail`), which
 * is stable cross-ROUND (same model, same text) but which two DIFFERENT
 * auditors (legacy GPT 5-pass vs the tiered discovery→Gemini pipeline)
 * essentially never phrase identically. Keying overlap on it made the metric
 * structurally ~0 across pipelines — all 13 `complete` shadow rows since the
 * 2026-07-17 anchor fix read `overlapCount:0` (2026-07-22 defect), rendering
 * the central "do the two pipelines agree?" signal decision-void.
 *
 * Conservative for a production-FLIP gate: a finding with no resolvable line
 * does NOT match. Under-counting overlap is the safe direction (it never makes
 * tiered look more similar to legacy than the evidence supports); the
 * unlocalized findings are surfaced separately (`*UnlocalizedCount`) so a low
 * overlap driven by missing line info is visible, never silently read as
 * genuine disagreement.
 *
 * The match key is **file + line-proximity + severity** (see `findingsCorrelate`).
 * Severity is included specifically to stop file+line proximity from pairing
 * unrelated findings of different severity (a LOW nit vs a HIGH vuln).
 *
 * **Residual imprecision (accepted, not a defect):** the line window is still a
 * heuristic, not an identity — two DISTINCT bugs of the SAME severity cited
 * within the window in one file can over-match, and the same bug cited further
 * apart than the window (or rated a severity notch apart by the two auditors)
 * is missed. A precise cross-auditor identity is not achievable (the two
 * pipelines share no fingerprint, category vocabulary, or line convention), and
 * a semantic matcher would be over-engineering for a metric that only INFORMS a
 * human flip decision (never auto-gates) and is always read next to the raw
 * `legacy/tieredFindingCount`. `overlapCount` is therefore an APPROXIMATE
 * agreement signal — treat a small delta as noise. `category` equality was
 * considered as a further discriminator and rejected: the two pipelines don't
 * share a category vocabulary, so it would trade the over-match for a worse
 * under-match; severity (a common 3-value scale) does not have that problem.
 * @param {object} a - a legacy finding
 * @param {object} b - a tiered finding
 * @returns {boolean}
 */
function findingsCorrelate(a, b) {
  const fa = findingFile(a);
  if (!fa || fa !== findingFile(b)) return false;
  const la = findingLine(a);
  const lb = findingLine(b);
  if (la == null || lb == null) return false;
  if (Math.abs(la - lb) > OVERLAP_LINE_WINDOW) return false;
  // Severity discriminator (Gemini gate, 2026-07-22): file+line proximity ALONE
  // blindly paired unrelated findings — a LOW style nit and a HIGH security
  // finding a few lines apart — inflating overlap and the flip-gate's apparent
  // recall. Two auditors flagging the SAME issue almost always agree on
  // severity; a genuine mismatch (or the same bug rated a notch apart) fails to
  // an under-count, which is the safe direction for a production-flip decision.
  // (This does not need a shared category vocabulary — severity is a common,
  // 3-value scale both pipelines emit — so it avoids the worse under-match that
  // requiring `category` equality would cause.)
  return normSeverityForOverlap(a) === normSeverityForOverlap(b);
}

/** Normalized severity for overlap matching; `null` when absent (an absent-vs-present pair then fails to a safe non-match). */
function normSeverityForOverlap(f) {
  const s = String(f?.severity ?? '').toUpperCase().trim();
  return s || null;
}

/**
 * Structured, pure comparison between a real (legacy) and shadow (tiered)
 * `AuditRunResult` for the SAME commit. Finding overlap is correlated by
 * LOCATION (file + line proximity, `findingsCorrelate`), NOT by `semanticId`:
 * that content-hash is stable cross-ROUND (same model, same prose) but the two
 * pipelines are different auditors that never phrase a finding identically, so
 * a prose-hash overlap is structurally ~0 across them (2026-07-22 defect —
 * every `complete` shadow row read `overlapCount:0`). `semanticId` is still
 * used for the per-side scope buckets below, where both keys come from the
 * same pipeline and prose identity is correct.
 *
 * Two tiers of output (docs/plans/stage0-evidence-relevance-split.md
 * decisions #6/#7/#10):
 *
 *  - **Always emitted, never gated on `opts`** — the decision-grade fields
 *    `legacyEligibleCount`/`tieredEligibleCount` (the symmetric population
 *    counts `tiered-shadow-summary.mjs`'s `comparedRuns` predicate reads) and
 *    `overlapDebtRouted`. Neither needs the bucket maps, so neither is gated
 *    on them: a caller that forgets `opts` can NOT silently produce an
 *    un-comparable "old-shape" row.
 *    `overlapDebtRouted` is decision #10 — the single most consequential fix:
 *    a legacy finding whose file was correctly debt-routed by the tiered
 *    pipeline is counted here, NOT in `onlyLegacyCount`, because the tiered
 *    pipeline handled it by design and counting it as a "miss" would
 *    systematically penalize its most important new capability in the very
 *    metric this plan exists to make trustworthy. File-level matching
 *    (consistent with decision #6's file-level legacy-side bucketing); a
 *    false-positive here under-counts misses rather than falsely inflating
 *    them, which is the safe direction.
 *  - **`opts`-gated** — the sub-bucket PROVENANCE counts only
 *    (`legacyOutOfScopeCount`, `tiered{ChangeRelated,PreExistingImpactful,PreExistingIndependent}Count`),
 *    which genuinely need `legacyBuckets`/`tieredBuckets`
 *    (`Map<semanticId, scopeBucket>`). Reported for visibility, never gating:
 *    **`isComparisonEligible` is unconditionally TRUE for every bucket value**
 *    (round-3 plan-audit H5 / Gemini round-2 G2) — decision #9 already
 *    guarantees a SUCCESSFULLY debt-routed candidate never becomes a finding
 *    at all, so anything reaching this function is by construction something
 *    Stage 1/2 actually processed and belongs in the comparison. A
 *    `pre_existing_independent`-bucketed finding present here is specifically
 *    a debt-routing FAILURE fallback, not a routed one.
 *
 * Omitting `opts` leaves `overlapCount`/`onlyLegacyCount`/`onlyTieredCount`
 * and every pre-plan field byte-identical to the pre-plan behaviour (an
 * absent `debtRoutedFiles` makes `overlapDebtRouted` 0).
 *
 * @param {import('../schemas.mjs').AuditRunResult} legacyResult
 * @param {import('../schemas.mjs').AuditRunResult} tieredResult
 * @param {{legacyBuckets?: Map<string,string>, tieredBuckets?: Map<string,string>}} [opts]
 * @returns {object}
 */
export function compareAuditRunResults(legacyResult, tieredResult, opts = undefined) {
  const legacyFindings = legacyResult.findings || [];
  const tieredFindings = tieredResult.findings || [];

  // Cross-pipeline overlap is correlated by LOCATION (file + line proximity),
  // not `semanticId` prose-hash — see `findingsCorrelate` for the full why
  // (2026-07-22 defect: prose-hash overlap was structurally 0 across the two
  // auditors). Greedy ONE-TO-ONE matching, deterministic in index order: each
  // tiered finding covers at most one legacy finding and vice versa, so N
  // legacy findings clustered at one spot can't be "covered" by a single
  // tiered finding there.
  const tieredMatched = new Set();
  const legacyMatched = new Array(legacyFindings.length).fill(false);
  for (let i = 0; i < legacyFindings.length; i++) {
    for (let j = 0; j < tieredFindings.length; j++) {
      if (tieredMatched.has(j)) continue;
      if (findingsCorrelate(legacyFindings[i], tieredFindings[j])) {
        legacyMatched[i] = true;
        tieredMatched.add(j);
        break;
      }
    }
  }
  const overlapCount = tieredMatched.size;
  const onlyTieredCount = tieredFindings.length - tieredMatched.size;

  // Surfaced so a low overlap driven by missing line info (findings the
  // producer cited at file granularity only) is visible rather than silently
  // read as genuine cross-pipeline disagreement (AGENTS.md "audit your success
  // paths" — a clean-looking overlap must never hide un-checked data).
  const legacyUnlocalizedCount = legacyFindings.filter((f) => findingLine(f) == null).length;
  const tieredUnlocalizedCount = tieredFindings.filter((f) => findingLine(f) == null).length;

  // ── ALWAYS-EMITTED decision-grade fields (never gated on `opts`) ─────────
  // Load-bearing structural choice, found while checking a concurrent
  // session's flag ("an unbucketed production call site would make every
  // future row old-shape and silently un-comparable — a fourth way for this
  // window to read wrong"). It doesn't manifest today (the ONE production
  // call site passes opts), but the dependency was accidental, not
  // necessary: NEITHER of these needs the bucket maps. `*EligibleCount` is
  // just `findings.length`; `overlapDebtRouted` reads `debtRoutedFiles` off
  // the tiered RESULT. Only the sub-bucket PROVENANCE counts genuinely need
  // `opts`. Emitting the decision-grade fields unconditionally removes the
  // "forgot to pass opts → silently un-comparable forever" failure mode by
  // construction rather than guarding it with a static pin — a caller can no
  // longer get this wrong.
  // Partition the UNMATCHED legacy findings (an overlap-matched one is handled
  // by definition) into debt-routed-away vs genuine misses. Iterated by index
  // against `legacyMatched` so the accounting invariant holds exactly:
  // overlapCount + overlapDebtRouted + onlyLegacyCount === legacyFindings.length.
  const debtRoutedFiles = new Set((tieredResult.debtRoutedFiles || []).map(normalizePath));
  let overlapDebtRouted = 0;
  let onlyLegacyCount = 0;
  for (let i = 0; i < legacyFindings.length; i++) {
    if (legacyMatched[i]) continue; // a real two-sided (location) overlap, not a miss
    const file = findingFile(legacyFindings[i]);
    // Decision #10: a legacy finding on a debt-routed file is HANDLED, not
    // missed — the tiered pipeline routed it to the debt ledger by design, so
    // counting it as a "miss" would penalize its most important new
    // capability. An absent `debtRoutedFiles` (any pre-plan result) yields 0.
    if (file && debtRoutedFiles.has(file)) overlapDebtRouted++;
    else onlyLegacyCount++;
  }

  let bucketedFields = {};
  if (opts) {
    const { legacyBuckets = new Map(), tieredBuckets = new Map() } = opts;
    const countBucket = (findings, buckets, bucket) =>
      findings.filter((f) => (buckets.get(semanticId(f)) ?? 'change_related') === bucket).length;
    // Detailed sub-bucket provenance ONLY — reported for visibility, never
    // gating (round-3 plan-audit H5 / Gemini round-2 G2: `isComparisonEligible`
    // is unconditionally true for every bucket value).
    bucketedFields = {
      legacyOutOfScopeCount: countBucket(legacyFindings, legacyBuckets, 'out-of-scope'),
      tieredPreExistingIndependentCount: countBucket(tieredFindings, tieredBuckets, 'pre_existing_independent'),
      tieredChangeRelatedCount: countBucket(tieredFindings, tieredBuckets, 'change_related'),
      tieredPreExistingImpactfulCount: countBucket(tieredFindings, tieredBuckets, 'pre_existing_impactful'),
    };
  }

  return {
    legacyFindingCount: legacyFindings.length,
    tieredFindingCount: tieredFindings.length,
    overlapCount,
    onlyLegacyCount,
    onlyTieredCount,
    overlapDebtRouted,
    // Findings the producer localized only to a file (no `:line`), so
    // `findingsCorrelate` could not confirm or deny a location overlap for
    // them. Surfaced so a low `overlapCount` driven by coarse localization is
    // distinguishable from genuine cross-pipeline disagreement.
    legacyUnlocalizedCount,
    tieredUnlocalizedCount,
    // Symmetric + ALWAYS persisted (decision #7 / round-2 plan-audit H3).
    // Deliberately identical to the finding counts above: eligibility ===
    // "reached the comparison at all", so these ARE the vacuity check. Kept
    // as separate named fields anyway because `summarize()`'s decision-grade
    // predicate reads them by name, and a future eligibility rule needs one
    // place to change without redefining what `*FindingCount` means.
    legacyEligibleCount: legacyFindings.length,
    tieredEligibleCount: tieredFindings.length,
    ...bucketedFields,
    legacyCostUsd: legacyResult._usage?.costUsd ?? null,
    tieredCostUsd: tieredResult._usage?.costUsd ?? null,
    // Under-count signals for the tiered cost (Gemini gate, 2026-07-22): a
    // non-zero value means `tieredCostUsd` omits some real spend — events whose
    // model was unpriced (`unavailable`) or that failed to build at all
    // (`dropped`). Persisted so a cost comparison is never read as complete when
    // it isn't. `?? null` = "field absent / pre-fix row", never a confident 0.
    tieredCostUnavailableEvents: tieredResult._usage?.unavailableCostEventCount ?? null,
    tieredCostDroppedEvents: tieredResult._usage?.droppedUsageEventCount ?? null,
    legacyLatencySec: parseTotalSeconds(legacyResult._pass_timings?.total),
    tieredLatencySec: parseTotalSeconds(tieredResult._pass_timings?.total),
    legacyRunStatus: legacyResult.runStatus ?? null,
    tieredRunStatus: tieredResult.runStatus ?? null,
    // Load-bearing for diagnosability (2026-07-14 incident): without this,
    // a 100%-fallback window is invisible in stored telemetry — only
    // `tieredRunStatus:'fallback_legacy'` is recorded, never WHY, so
    // confirming it requires a live repro instead of a DB query.
    tieredFallbackReason: tieredResult.fallbackReason ?? null,
    // docs/plans/oss-call-reliability-hardening.md round-3 H1/H2: typed
    // Stage-1 telemetry (classified-failure categories + admission-guard
    // skip count), not prose-only — mirrors the tieredFallbackReason
    // pattern above (copy straight from the AuditRunResult into the
    // persisted comparison record).
    tieredStage1BudgetExhausted: tieredResult._stage1BudgetExhausted ?? null,
    tieredStage1FailureCategories: tieredResult._stage1FailureCategories ?? null,
    // Diagnosability (2026-07-15): a `complete` shadow run with 0 findings
    // was previously indistinguishable in stored telemetry from "both
    // generators genuinely found nothing" vs "candidates existed but were
    // dropped somewhere in Stage 0/1/2" — both fields already existed on
    // the full tieredResult (overall_reasoning's structured source), just
    // never copied into the persisted record. Same copy-straight-through
    // convention as tieredFallbackReason/tieredStage1* above.
    tieredGeneratorOutcomes: tieredResult.generatorOutcomes ?? null,
    tieredStageBreakdown: tieredResult._stageBreakdown ?? null,
    // docs/plans/stage0-evidence-relevance-split.md: hoisted out of the
    // nested `_stageBreakdown` blob to a top-level field, mirroring the
    // existing copy-straight-through convention — it's the headline
    // "did Stage 0 verify anything at all" number the summary's
    // `excludedNoStage0Evidence` reason and the CLI report both read.
    tieredStage0Verified: tieredResult._stageBreakdown?.stage0Verified ?? null,
    // evidence-anchor-path-contract §7c: hoisted alongside tieredStage0Verified
    // (same copy-straight-through convention) so a contract-bug run is
    // diagnosable from the stored row, not just live stderr. Lands inside the
    // existing `comparison` jsonb column — NO migration needed. `?? null`, never
    // `?? 0`: absent must read as "insufficient data", never "zero malformed
    // confirmed" (the same absent≠zero rule summarize() already applies to the
    // eligible counts).
    tieredStage0MalformedTripwire: tieredResult._stageBreakdown?.stage0MalformedTripwire ?? null,
    // Hoisted for the SAME reason (found by the union gate, 2026-07-17): under
    // the V3 enum contract our-schema rejections land HERE (raw, at the
    // producer boundary) rather than at the Stage-0 tripwire, so `summarize()`'s
    // §7c contract-failure exclusion must be able to see this counter or it is
    // dead for the V3 path. `?? null`, never `?? 0` — a historical row predating
    // this field is insufficient data, not "zero malformed confirmed".
    tieredDiscoveryMalformedRaw: tieredResult._stageBreakdown?.discoveryMalformedRaw ?? null,
    // The COUNT above says how many; it cannot say which SHAPE, so a malformed
    // window could never be diagnosed from stored telemetry — only from a live
    // repro, which is exactly what the 2026-07-14 incident cost. The bounded
    // reason breakdown makes the sub-case readable from the row. Same
    // `?? null` discipline: absent is insufficient data, never "zero".
    tieredDiscoveryMalformedReasons: tieredResult._stageBreakdown?.discoveryMalformedReasons ?? null,
    // Decision #9: per-fingerprint reasons for any pre_existing_independent
    // candidate whose debt-routing FAILED (restored to the Stage-1 pool
    // instead) — a silent restore would make the debt-routing path's own
    // failures invisible in stored telemetry, the exact class of gap the
    // 2026-07-14 incident was.
    tieredDebtRoutingIncomplete: tieredResult.debtRoutingIncomplete ?? null,
  };
}

/**
 * Best-effort: run the tiered pipeline as a shadow against `ctx`, returning
 * a discriminated outcome. NEVER throws — a shadow failure (provider error,
 * timeout, bug in not-yet-production-flipped code) must never surface to
 * the caller, since this pipeline hasn't earned production trust yet.
 *
 * **Worst-case budget reconciliation** (docs/plans/oss-call-reliability-hardening.md
 * Execution Model — deliberate, not accidental): the default `timeoutMs` below
 * (20 min) is the outer ceiling every inner stage's budget is reasoned against.
 * `oss-call-policy.json`'s `stage1TriageBudget.totalMs` (10 min) reserves the
 * ENTIRE sequential Stage-1 admission-guard loop's ceiling, leaving ~10 min for
 * discovery (`stage1_triage`/`discovery_generation` policies, worst case
 * ~241s for discovery alone) + Stage 2's Gemini adjudication + overhead. The
 * Stage-1 admission guard (`stage1-triage.mjs`) BOUNDS how much new work Stage 1
 * can *start* within its reservation — it does NOT cancel work already in
 * flight: `Promise.race` below does not cancel its losing promise, so an inner
 * OpenRouter call can keep running (and spending) after this outer race has
 * already recorded a timeout. That is a known, independent, pre-existing
 * limitation (deferred, not solved by the admission guard) — fixing it would
 * require threading an `AbortSignal`/cancellation context through the entire
 * inner pipeline, a materially larger change than this budget reconciliation.
 * @param {import('../schemas.mjs').AuditRunContext} ctx
 * @param {{runTieredAuditPipeline: Function, timeoutMs?: number}} deps - injectable for tests
 * @returns {Promise<{ok: true, result: object, latencyMs: number} | {ok: false, error: string, latencyMs: number}>}
 */
export async function runShadowTieredPipeline(ctx, { runTieredAuditPipeline, timeoutMs = 20 * 60 * 1000 }) {
  const shadowCtx = buildShadowCtx(ctx);
  const start = Date.now();
  // Bug found by the test suite itself (2026-07-13): an uncleared timer from
  // the losing side of Promise.race keeps the event loop alive — with the
  // default 20-minute timeout, every CALLER of this function (tests AND the
  // real CLI) would hang for up to 20 minutes past the real result. Both
  // race outcomes MUST clear the timer.
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`shadow timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    const result = await Promise.race([runTieredAuditPipeline(shadowCtx), timeout]);
    return { ok: true, result, latencyMs: Date.now() - start };
  } catch (err) {
    // A TieredUnavailableError is the EXPECTED outcome of a required
    // generator being unavailable (plan: docs/plans/shadow-no-legacy-fallback.md
    // decision #3) — not a harness bug. Prefer its clean formatted `.reason`
    // over a raw `err.message` so the existing `shadowError` field (and the
    // existing `shadow_error` column) carries the useful string.
    //
    // No `unavailable` boolean is persisted: the reason string is
    // self-discriminating (`required generator failed: …` vs any other
    // throw), which is what a human reading `shadowFailureReasons` actually
    // uses, and a flag no consumer branches on would be ceremony.
    const error = err instanceof TieredUnavailableError ? err.reason : err.message;
    return { ok: false, error, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Append one shadow-comparison record. Fire-and-forget-safe: any write
 * failure is logged to stderr, never thrown (mirrors `quickfix-scan.mjs`'s
 * existing `.audit/*.jsonl` telemetry pattern — same directory, same
 * append-only shape, same fail-open posture for a non-critical log).
 * @param {object} record
 * @param {string} [logPath]
 */
export function appendShadowLog(record, logPath = SHADOW_LOG_PATH) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
  } catch (err) {
    process.stderr.write(`  [tiered-shadow] WARNING: failed to write shadow log: ${err.message}\n`);
  }
}

/**
 * Orchestrates one shadow-validation observation for a real audit run.
 * Call concurrently with the real `runLegacyProductionAudit(ctx)` (the
 * caller starts both, awaits legacy first for the real result, then awaits
 * this) — never sequences shadow-after-legacy, which would double real
 * wall-clock for no reason (see module header on the chdir-safety check
 * that makes concurrency safe here).
 *
 * @param {{ctx: object, legacyResultPromise: Promise<object>, runTieredAuditPipeline: Function, logPath?: string}} args
 * @returns {Promise<void>} always resolves, never rejects
 */
export async function runTieredShadowComparison({ ctx, legacyResultPromise, runTieredAuditPipeline, logPath = SHADOW_LOG_PATH }) {
  const shadowOutcome = await runShadowTieredPipeline(ctx, { runTieredAuditPipeline });
  let legacyResult;
  try {
    legacyResult = await legacyResultPromise;
  } catch {
    // The real run itself failed — nothing to compare against. Still worth
    // recording that the shadow ran (or didn't), but there's no comparison.
    await recordObservation({
      ctx, logPath,
      legacyOk: false, shadowOk: shadowOutcome.ok, shadowLatencyMs: shadowOutcome.latencyMs,
      shadowError: shadowOutcome.ok ? null : shadowOutcome.error, comparison: null,
    });
    return;
  }
  await recordObservation({
    ctx, logPath,
    legacyOk: true, shadowOk: shadowOutcome.ok, shadowLatencyMs: shadowOutcome.latencyMs,
    shadowError: shadowOutcome.ok ? null : shadowOutcome.error,
    comparison: shadowOutcome.ok
      ? compareAuditRunResults(legacyResult, shadowOutcome.result, {
          legacyBuckets: buildLegacyBuckets(legacyResult, ctx.changedFiles),
          tieredBuckets: buildTieredBuckets(shadowOutcome.result),
        })
      : null,
  });
}

/**
 * Legacy-side SCOPE bucketing (decision #6). The legacy pipeline has no
 * per-candidate evidence model at all, so its buckets are FILE-level: a
 * finding is `change_related` when its cited file is in this run's
 * `changedFiles`, `out-of-scope` when it authoritatively isn't. The
 * membership check is the shared `isFileInChangedScope` predicate extracted
 * from `deferral-classifier.mjs`'s gate (b) — reused, not re-implemented,
 * so the two can't drift.
 *
 * Its tri-state `null` (unknown: empty/absent `changedFiles`, or an
 * unresolvable file) maps to `change_related` — the safe, inclusion-biased
 * default (decision #2), never a silent `out-of-scope` mass-exclusion.
 *
 * @param {import('../schemas.mjs').AuditRunResult} legacyResult
 * @param {Array<string>|null|undefined} changedFiles
 * @returns {Map<string, 'change_related'|'out-of-scope'>}
 */
export function buildLegacyBuckets(legacyResult, changedFiles) {
  const normalizedChanged = Array.isArray(changedFiles) ? changedFiles.map(normalizePath) : changedFiles;
  const buckets = new Map();
  for (const f of (legacyResult.findings || [])) {
    const inScope = isFileInChangedScope(findingFile(f), normalizedChanged);
    buckets.set(semanticId(f), inScope === false ? 'out-of-scope' : 'change_related');
  }
  return buckets;
}

/**
 * Tiered-side bucketing — reads each finding's own `scopeBucket`, resolved
 * at the single ownership point in `tiered-pipeline.mjs` from the Stage 0
 * routing manifest via `resolveScopeBucketForFinding` (decision #8's
 * provenance link — NOT re-derived from `stageDecisions` here, which was
 * round-1's vague claim). A finding with no `scopeBucket` (a pre-plan
 * result shape) falls back to the same safe `change_related` default.
 *
 * @param {import('../schemas.mjs').AuditRunResult} tieredResult
 * @returns {Map<string, string>}
 */
export function buildTieredBuckets(tieredResult) {
  const buckets = new Map();
  for (const f of (tieredResult.findings || [])) {
    buckets.set(semanticId(f), f.scopeBucket ?? 'change_related');
  }
  return buckets;
}

/**
 * Writes one observation to BOTH sinks — local JSONL (always) and Supabase
 * (best-effort, cloud-optional). The cloud write's `repoId` comes from
 * `resolveRepoIdentity()` (synchronous, local git reads only, no network) —
 * NOT threaded through `ctx`, since it's a repo-wide fact, not a per-run
 * input. A cloud-write failure is logged, never thrown — this function's
 * whole contract (matching its callers') is "always resolves".
 * @param {{ctx: object, logPath: string, legacyOk: boolean, shadowOk: boolean, shadowLatencyMs: number, shadowError: string|null, comparison: object|null}} args
 */
async function recordObservation({ ctx, logPath, legacyOk, shadowOk, shadowLatencyMs, shadowError, comparison }) {
  appendShadowLog({
    timestamp: new Date().toISOString(), runId: ctx.runId || null,
    legacyOk, shadowOk, shadowLatencyMs, shadowError, comparison,
  }, logPath);
  try {
    const { repoUuid } = resolveRepoIdentity();
    const result = await appendTieredShadowObservation({
      repoId: repoUuid, runId: ctx.runId ?? null,
      legacyOk, shadowOk, shadowError, shadowLatencyMs, comparison,
    });
    if (!result.ok) {
      process.stderr.write(`  [tiered-shadow] WARNING: cloud persistence failed (local log unaffected): ${result.error}\n`);
    }
  } catch (err) {
    process.stderr.write(`  [tiered-shadow] WARNING: cloud persistence failed (local log unaffected): ${err.message}\n`);
  }
}
