#!/usr/bin/env node
/**
 * @fileoverview Bake-off snapshot collector + progress counter — entry point.
 *
 * Reduced to argv + dispatch (plan: comparison-tooling-consolidation.md,
 * Phase 2/D2). The bake-off library logic lives in `scripts/lib/bakeoff/**`:
 * `scope.mjs` (ResolvedScope), `arms.mjs` (resolution/derivation/transport),
 * `log.mjs` (log read/append, entry identity), `spawn.mjs` (arg construction
 * + subprocess execution), `summary.mjs` (completeness/aggregation/spend —
 * pure), `progress.mjs` (stdout rendering).
 *
 * This file keeps: argv parsing, command dispatch, process exit, cloud-run
 * registration (`mintArmRun`/`cloudIsOn` — heavy store/context dependencies
 * with no other consumer), and the handful of functions that GENUINELY need
 * to compose two lib modules the D2a boundary keeps apart from each other
 * (`bakeoff/arms.mjs` and `bakeoff/summary.mjs` never import one another —
 * see D2a's dependency table): `isCompleteForEntry`, `selectRetryArmIds`,
 * `readArmResult`. The entry point is exactly the layer D2a designates for
 * that composition.
 *
 * Runs only when invoked, on a transcript you name — not a passive
 * background collector.
 *
 * Usage:
 *   node scripts/bakeoff-collect.mjs --transcript <path> --plan <path> [--mode plan|code]
 *   node scripts/bakeoff-collect.mjs --progress
 *   node scripts/bakeoff-collect.mjs --selfcheck-relocation
 *
 * Plan: docs/plans/final-review-shadow-bakeoff.md §0 (Activation Addendum);
 * docs/plans/comparison-tooling-consolidation.md (D1/D1c/D6/D2).
 *
 * @module scripts/bakeoff-collect
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import { atomicWriteFileSync } from './lib/file-io.mjs';
import { UnresolvedScopeError, ScopeMismatchError } from './lib/bakeoff/scope.mjs';
import { LOG_PATH, CONTRACT_EPOCH, snapshotId, planContentHash, readLog } from './lib/bakeoff/log.mjs';
import { resolveArms, scopeForEntry, armDidRun } from './lib/bakeoff/arms.mjs';
import { isComplete, armCostUsd, distinctFindingCount, cohortDigest } from './lib/bakeoff/summary.mjs';
import { runArmAttempts, verifyPreflightArtifact } from './lib/bakeoff/spawn.mjs';
import { printProgress } from './lib/bakeoff/progress.mjs';
import { planLooksRelated } from './lib/bakeoff/relatedness.mjs';
import { repoId } from './lib/campaign/promote.mjs';
import { resolveCohort, liveArmRunsForSnapshot, isAttemptExcluded } from './lib/store/campaign.mjs';
import { isCloudEnabled } from './lib/store/repo.mjs';

const KNOWN_FLAGS = Object.freeze([
  '--transcript', '--plan', '--mode', '--progress', '--target', '--campaign',
  '--force', '--allow-log-only-retry', '--confirm-mismatch', '--selfcheck-relocation', '--help', '-h',
]);

/**
 * Pre-registered cohort size, lowered 15 → **12** on 2026-08-03, before any
 * result under CONTRACT_EPOCH e2 was read — the only point §6.0b permits it
 * ("adjusts N ... only before run 1, never mid-campaign").
 *
 * 12 and not lower, deliberately. §6.3 row 1 makes `N < 12` terminal
 * INCONCLUSIVE — no keep/drop claim at any cost — so 8 would have bought a
 * cheaper campaign that answers nothing. 12 is the smallest N that still
 * yields a verdict, and reaching it required changing no decision rule: §0.5
 * states the rule is inherited, not re-invented, and it is not amended here.
 */
const DEFAULT_TARGET = 12;

/**
 * `isComplete` scoped to the entry's own campaign. Unjudgeable ⇒ false, but
 * callers that can report WHY should ask `scopeForEntry` first.
 *
 * Composition of `arms.mjs`'s `scopeForEntry` and `summary.mjs`'s
 * `isComplete` — the two modules never import each other (D2a), so this
 * lives at the entry point, the one layer permitted to see both.
 */
export function isCompleteForEntry(entry) {
  const scope = scopeForEntry(entry);
  if (!scope) return false;
  return isComplete(entry, scope);
}

/**
 * D5's retry-arm selection, widened by §7 Phase 2 to be STORE-AUTHORITATIVE
 * — extracted so the rule is assertable without spawning a single provider
 * call or touching a database, same reasoning as `resolvePromotionAttempt`
 * in campaign.mjs. Stays synchronous and pure: the store read and the
 * exclusion fetch each happen ONCE at the call site (`main()`) and are
 * injected here as plain data.
 *
 * An arm is treated as already-done when EITHER the store shows
 * `succeeded:true` for it, OR the local log's own entry shows a completed,
 * non-error result for this exact snapshot+arm that is NOT matched by
 * `isAttemptExcluded` AND whose OWN `configDigest`/`planContentHash` each
 * satisfy the same permissive-null policy as the store signal (round 6, M1)
 * against `expectedConfigDigest`/`expectedPlanContentHash`. Both signals are
 * needed: the store sees successes from OTHER checkouts/fixtures (the
 * original over-spawn defect); the log sees a just-collected,
 * not-yet-promoted success in THIS invocation (the normal collect-then-
 * later-reconcile gap between `bakeoff-collect.mjs` and `campaign.mjs
 * reconcile`) that the store cannot see yet.
 *
 * @param {object|undefined} existing - the entry currently on disk for this
 *   snapshotId, or undefined on a fresh fixture / first-ever collection
 * @param {import('./lib/bakeoff/scope.mjs').ResolvedScope|null} existingScope -
 *   `scopeForEntry(existing)` when `existing` is present; the CURRENT
 *   invocation's own resolved scope when it is not (a fresh fixture still
 *   knows which arms its OWN campaign declares); null when the entry names
 *   an unresolvable campaign ("cannot judge" — not the same fact as "an arm
 *   did not run")
 * @param {Record<string, {succeeded: boolean}>} [storeArmState] - the
 *   `liveArmRunsForSnapshot` result, keyed by arm id; `{}` when the store
 *   has nothing (or was not consulted)
 * @param {Array<{snapshotId: string, scope: string, planContentHash: string|null}>} [exclusions] -
 *   this cohort's active (non-lifted) exclusions
 * @param {string|null} [expectedConfigDigest]
 * @param {string|null} [expectedPlanContentHash]
 * @returns {string[]|null} arm ids to retry, or null when there is nothing
 *   to narrow — either every declared arm is already done (via store or
 *   log), or NOTHING is done anywhere (a genuine first-ever/full collection,
 *   which the caller must not read as "narrow to an empty retry list").
 *   Also null when every declared arm ran and the snapshot is still
 *   incomplete for a reason a retry cannot fix (envelope-scope binding,
 *   contract epoch): re-spawning nothing there would be a silent no-op that
 *   never resolves the incompleteness.
 */
export function selectRetryArmIds(
  existing, existingScope,
  storeArmState = {}, exclusions = [],
  expectedConfigDigest = null, expectedPlanContentHash = null,
) {
  if (!existingScope) return null;
  // A genuine first-ever/full collection — nothing recorded anywhere, not
  // even a store row to be suspicious of — is NOT a narrowed retry, and
  // must not be confused with "everything is individually missing" (e.g.
  // every arm quarantined, or every arm errored): those ARE real retry
  // lists, just ones that happen to name every arm. The two are
  // distinguished by whether anything is KNOWN at all, not by counting.
  const anyKnownAnywhere = Boolean(existing) || existingScope.arms.some((a) => storeArmState?.[a.id] !== undefined);
  if (!anyKnownAnywhere) return null;
  // No `isComplete` short-circuit here (round 6, correcting the original
  // draft): `isComplete` never checks plan-hash provenance (Phase 6 only
  // ever wires `configDigest` into it, deliberately — see Phase 6's own
  // rationale), so an entry whose arms all ran fine under an OLD plan hash
  // reads `isComplete: true`, and a short-circuit there would return null
  // before ever reaching the plan-hash check below — silently treating a
  // stale-plan snapshot as done. Every fixture this file's OTHER describe
  // block exercises (contract-epoch mismatch, scope-binding) already
  // reaches the same `null` result through the per-arm filter below (every
  // arm still individually reads as "ran fine"), so dropping this
  // short-circuit changes no existing behaviour — it only stops masking the
  // plan-hash case Phase 2 exists to catch.
  const missing = existingScope.arms.filter((a) => {
    if (storeArmState?.[a.id]?.succeeded === true) return false; // the store says this arm is genuinely done
    if (!existing) return true; // nothing local, and the store doesn't show success either
    if (!armDidRun(a, existing)) return true;
    const r = existing.arms?.[a.id];
    if (isAttemptExcluded({ snapshotId: existing.snapshotId, planContentHash: r?.planContentHash ?? null }, exclusions)) return true;
    const configOk = r?.configDigest == null || r.configDigest === expectedConfigDigest;
    const planOk = r?.planContentHash == null || r.planContentHash === expectedPlanContentHash;
    return !(configOk && planOk);
  }).map((a) => a.id);
  return missing.length > 0 ? missing : null;
}

/**
 * PURE. Carry a human-retried arm's PRIOR attempt forward as a superseded one.
 *
 * `readLog()` keeps only the newest entry per `snapshotId`, so an arm's earlier
 * failed record is erased the moment a retry writes a second line — and with it
 * the evidence that the attempt happened and was paid for. Everything
 * downstream of the log (`entriesToSpendSnapshots`, promotion into
 * `campaign_arm_runs`) then reports the retried arm as a single attempt, which
 * is the "a real charge read as never having happened" failure
 * `comparison/spend.mjs` documents. Automatic retries within one collection
 * already carry their own `supersededAttempts`; this closes the same hole for
 * the human-invoked path, using the same field so there is one shape to read.
 *
 * The prior record's own `supersededAttempts` are carried too, so a third
 * attempt does not amnesty the first.
 *
 * @param {Record<string, object>} newArms - results just collected, keyed by arm id
 * @param {Record<string, object>|undefined} priorArms - the entry on disk
 * @returns {Record<string, object>} newArms, with retry history folded in
 */
export function mergeRetryHistory(newArms, priorArms) {
  const out = {};
  for (const [armId, result] of Object.entries(newArms)) {
    const prior = priorArms?.[armId];
    if (!prior) { out[armId] = result; continue; }
    const history = [
      ...(prior.supersededAttempts ?? []),
      {
        attempt: (prior.supersededAttempts?.length ?? 0) + 1,
        runId: prior.runId ?? null,
        elapsedMs: null, // not recorded before this field existed; unknown, never 0
        errorCategory: prior.shadowErrorCategory ?? null,
        error: prior.error ?? prior.shadowError ?? null,
        costUsd: typeof prior.costUsd === 'number' ? prior.costUsd : null,
        unpricedModels: prior.unpricedModels ?? [],
        // §7 Phase 4 (round 5, H2): the PRIOR result's OWN stamps, never the
        // current invocation's — this is what a carried-forward arm being
        // superseded here is superseded FROM, and it must not be silently
        // relabelled with a pairing it was never collected against.
        planContentHash: prior.planContentHash ?? null,
        configDigest: prior.configDigest ?? null,
      },
    ];
    const offset = history.length;
    out[armId] = {
      ...result,
      supersededAttempts: [
        ...history,
        // The attempts made in THIS collection sit after the prior ones, so the
        // numbering is continuous across invocations rather than restarting.
        ...(result.supersededAttempts ?? []).map((a) => ({ ...a, attempt: a.attempt + offset })),
      ],
    };
  }
  return out;
}

/**
 * Parse one arm's `--out` JSON into the fields the stopping rule scores.
 * Composition of raw file I/O and `summary.mjs`'s pure helpers — lives here
 * for the same D2a reason as the two functions above (`spawn.mjs`, which
 * produces the file this reads, is forbidden from importing `summary.mjs`).
 */
export function readArmResult(outPath) {
  const j = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
  const shadow = j._shadow || {};
  const cost = armCostUsd(j);
  return {
    costUsd: cost.usd,
    unpricedModels: cost.unpricedModels,
    // Request identity for BOTH calls this arm makes. Two arms sharing a
    // fingerprint issued the same request and differ only in how the result is
    // reported — a reroll, not a second configuration. Null on entries written
    // before the field existed, which reads as "unknown", never "distinct".
    requestFingerprints: [j._requestFingerprint ?? null, shadow.requestFingerprint ?? null].filter(Boolean),
    // The ambient-independent companion, carried BESIDE the above rather than
    // replacing it (so every already-collected snapshot stays comparable —
    // same additive rule as `bucketsMatched`). `summary.mjs` unions the two
    // sets, which can only ADD reroll detections, never remove one: the
    // `ri1:` prefix makes the two vocabularies non-overlapping by construction.
    requestIdentities: [j._requestIdentity ?? null, shadow.requestIdentity ?? null].filter(Boolean),
    primaryVerdict: j.verdict ?? null,
    primaryFindings: (j.new_findings || []).length,
    // Counted the shadow's way, so `solo-opus` can be compared against the Opus
    // shadow in the `opus` arm (see summarise → opusDivergence).
    primaryDistinct: distinctFindingCount(j.new_findings),
    shadowState: shadow.state ?? null,
    shadowModel: shadow.model ?? null,
    // The failed shadow's CLASSIFICATION, carried across the process boundary
    // from the one `classifyLlmError` oracle (gemini-review.mjs's shadow catch)
    // — this is what `classifyArmAttempt` reads to decide whether re-spawning
    // is worth anything. Absent on a successful arm, and absent on an artifact
    // written by a reviewer that predates the field; both must read as "not
    // classified", never as "retryable" (see classifyArmAttempt's fail-closed
    // rule). `shadowError` is the human-readable half, for the log line only.
    shadowErrorCategory: shadow.errorCategory ?? null,
    shadowErrorRetryable: shadow.errorRetryable ?? null,
    shadowError: shadow.error ?? null,
    // Which envelope the shadow actually received (gemini-review.mjs's
    // `_shadow.scope`). This is the evidence `isComplete`'s scope-binding
    // check reads — plan KD-6: scope must be signed cohort state, and a
    // snapshot whose arm ran a DIFFERENT scope than the manifest declared is
    // ineligible, not merely annotated. Absent on entries predating the field
    // (reads as null, never coerced to a guessed scope).
    shadowScope: shadow.scope ?? null,
    // The shadow's own VERDICT, not just its finding count. Observed at N=3:
    // both shadows APPROVE nearly everything — Kimi APPROVEd a plan the primary
    // REJECTed. A shadow's verdict is therefore near-useless as a signal, and
    // its whole value rides on the findings; recording it is what makes that
    // claim checkable at N=15 instead of an impression.
    shadowVerdict: shadow.verdict ?? null,
    // `buckets` is null when the shadow skipped — distinguish that from a real
    // zero, or a skipped arm reads as "found nothing" (the anti-green class).
    buckets: shadow.buckets ?? null,
    // The matched view + the cohort identity it was computed under. Null when
    // matching was disabled, or the arm predates the field — never coerced into
    // a bucket set, which would read as a measured zero.
    bucketsMatched: shadow.bucketsMatched ?? null,
    matchCohort: cohortDigest(shadow.matchSchemaVersion, shadow.matchConfig),
  };
}

/** Is the cloud store configured? Never throws — an unreachable store is "off". */
async function cloudIsOn() {
  try {
    const store = await import('./learning-store.mjs');
    return await store.isCloudEnabled();
  } catch { return false; }
}

/**
 * Mint one `audit_runs` row for one arm invocation, or null when the cloud is
 * off / unreachable.
 *
 * ONE ROW PER ARM, not per snapshot. The run-level final-review columns
 * (`final_review_model`, `final_review_shadow_model`, the shadow token and
 * latency sums, `gemini_verdict`) are single-valued, so three arms sharing a
 * row would leave whichever finished last as the record of all three — the
 * three-arms-one-row shape looks tidier and destroys the comparison the arms
 * exist to make.
 *
 * Never throws: a bake-off snapshot with no cloud row is degraded (findings
 * live only in the arm's `--out` JSON) but still counts, exactly as the three
 * pre-epoch snapshots did. Refusing to collect because the store is down would
 * make the campaign hostage to it.
 */
async function mintArmRun(arm, { plan, mode, id }) {
  try {
    const store = await import('./learning-store.mjs');
    if (!await store.isCloudEnabled()) return null;
    await store.initLearningStore?.();
    const { generateRepoProfile } = await import('./lib/context.mjs');
    const ref = await store.resolveRepoForStore({ profile: generateRepoProfile() }).catch(() => null);
    const repoId = ref?.repoRowId ?? null;
    if (!repoId) return null;
    // `commitSha` is LOAD-BEARING, not decoration. §2.5b-i makes `audited_sha`
    // part of snapshot identity, and §2.5c verifies every adjudicated finding
    // against the tree at that revision — so a run without one makes its whole
    // snapshot unadjudicatable, and `campaign.mjs reconcile` correctly refuses
    // to promote it.
    const { gitCommitSha } = await import('./lib/vcs.mjs');
    const head = gitCommitSha(process.cwd());
    return await store.recordRunStart(repoId, plan, mode === 'plan' ? 'plan' : 'code', {
      scopeMode: mode === 'plan' ? 'plan' : 'diff',
      experimentTag: 'final-review-bakeoff',
      // Structured result, never a throw — an unreadable HEAD degrades to a
      // run with no sha (unpromotable, and visibly so) rather than losing the
      // whole registration and with it the findings.
      ...(head.ok ? { commitSha: head.sha } : {}),
    });
  } catch (err) {
    process.stderr.write(`  [bakeoff] run registration failed for arm ${arm.id} (findings will be file-only): ${err.message}\n`);
    return null;
  }
}

/**
 * Resolve a campaign scope for `printProgress` (which takes an
 * already-resolved outcome, never a raw campaign id — see `progress.mjs`'s
 * module note on why). Wraps `resolveArms` in the `{ok, ...}` shape
 * `printProgress` renders directly.
 */
function resolveScopeForProgress(campaignId) {
  try {
    return { ok: true, scope: resolveArms({ campaignId }).scope };
  } catch (err) {
    if (err instanceof UnresolvedScopeError) return { ok: false, message: err.message };
    throw err;
  }
}

/**
 * §7 Phase 2: resolve this invocation's authoritative store state for
 * retry-scoping — the cohort's live arm state and its active exclusions.
 *
 * Extracted from `main()` so the store-unavailable degradation ladder is
 * assertable without spawning the CLI or a real database: a THROWN store
 * error (a real operational failure) and a clean, no-error `cloud:false`
 * reply (the store is simply disabled) are two DIFFERENT code paths to the
 * same requirement (Gemini gate round 3, G1 sharpened by round 1's H3) —
 * checked here as the FIRST thing, explicitly, rather than inferred from
 * `repoId()`'s own collapsed null (which conflates "cloud is off" with "this
 * repo just isn't registered yet", and the latter is not the same refusal).
 * Both cases require `--allow-log-only-retry`, never a silent default.
 *
 * @param {{lockDigest: string|null, campaignKey: string|null, snapshotIdValue: string,
 *   expectedConfigDigest: string|null, expectedPlanContentHash: string|null, allowLogOnlyRetry: boolean}} args
 * @returns {Promise<{storeArmState: object, activeExclusions: Array<object>}>}
 * @throws {ArgvError} when the store is unreachable/off and `allowLogOnlyRetry` is false
 */
export async function resolveStoreState({
  lockDigest, campaignKey, snapshotIdValue, expectedConfigDigest, expectedPlanContentHash, allowLogOnlyRetry,
}) {
  const empty = { storeArmState: {}, activeExclusions: [] };
  if (!lockDigest) return empty; // no lock yet — nothing to look up
  try {
    if (!await isCloudEnabled()) {
      throw Object.assign(new Error('Cloud store is disabled — retry scoping has no authoritative arm state'), { cloudOff: true });
    }
    const rid = await repoId();
    if (!rid) return empty; // cloud is on but this repo has no store row yet — not an error
    const cohort = await resolveCohort({ repoId: rid, campaignKey, lockDigest });
    if (cohort.cloud === false) {
      throw Object.assign(new Error('Cloud store is disabled — retry scoping has no authoritative arm state'), { cloudOff: true });
    }
    if (!cohort.ok) throw new Error(cohort.error || 'cohort resolution failed');
    // No cohort recorded yet under this lock is not an error — nothing has
    // ever been promoted into it, so there is genuinely nothing
    // authoritative to read yet.
    if (!cohort.cohortId) return empty;
    const live = await liveArmRunsForSnapshot({
      cohortId: cohort.cohortId, snapshotId: snapshotIdValue,
      expectedConfigDigest, expectedPlanContentHash,
    });
    if (live.cloud === false) {
      throw Object.assign(new Error('Cloud store is disabled — retry scoping has no authoritative arm state'), { cloudOff: true });
    }
    if (!live.ok) throw new Error(live.error || 'store read failed');
    return { storeArmState: live.rows, activeExclusions: live.exclusions ?? [] };
  } catch (err) {
    if (!allowLogOnlyRetry) {
      throw new ArgvError(
        `[bakeoff] Store read failed: ${err.message} — retry scoping has no authoritative arm state and may re-spawn `
        + 'arms that already succeeded elsewhere. Pass --allow-log-only-retry for a genuinely offline/local-only workflow.',
      );
    }
    process.stderr.write(`  [bakeoff] WARNING: ${err.message} — proceeding with --allow-log-only-retry (local log only)\n`);
    return empty;
  }
}

async function main() {
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'bakeoff-collect' });
  const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? null : (process.argv[i + 1] ?? null); };
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('Usage: node scripts/bakeoff-collect.mjs --transcript <path> --plan <path> [--mode plan|code]\n'
      + '       node scripts/bakeoff-collect.mjs --progress\n');
    return;
  }
  const target = Number(arg('target') || DEFAULT_TARGET);
  if (process.argv.includes('--progress')) { printProgress(LOG_PATH, target, resolveScopeForProgress(arg('campaign'))); return; }

  const transcript = arg('transcript');
  const plan = arg('plan');
  if (!transcript || !plan) throw new ArgvError('--transcript <path> and --plan <path> are both required (or use --progress)');
  for (const p of [transcript, plan]) if (!fs.existsSync(p)) throw new ArgvError(`not found: ${p}`);

  const id = snapshotId(transcript);
  const force = process.argv.includes('--force');
  const allowLogOnlyRetry = process.argv.includes('--allow-log-only-retry');
  const confirmMismatch = process.argv.includes('--confirm-mismatch');
  const currentPlanHash = planContentHash(plan);

  // §7 Phase 4: a collection-time SOFT heuristic that would have caught all
  // 3 real mis-paired snapshots. Refuses to proceed on an apparent mismatch
  // unless the operator explicitly confirms — a legitimate plan may
  // genuinely share no filenames with its transcript (e.g. a narrative/UX
  // plan), so this is a soft gate, never a hard refusal.
  {
    let transcriptJsonForRelatedness;
    try { transcriptJsonForRelatedness = JSON.parse(fs.readFileSync(transcript, 'utf-8')); } catch { transcriptJsonForRelatedness = null; }
    const relatedness = planLooksRelated(transcriptJsonForRelatedness, fs.readFileSync(plan, 'utf-8'));
    if (!relatedness.related && !confirmMismatch) {
      throw new ArgvError(
        `[bakeoff] --transcript and --plan do not look related — no shared cited file basenames found `
        + `(transcript basenames vs plan text). If this pairing is genuinely correct (e.g. a narrative/UX plan `
        + 'sharing no filenames with its transcript), pass --confirm-mismatch to proceed.',
      );
    }
    if (!relatedness.related && confirmMismatch) {
      process.stderr.write('  [bakeoff] WARNING: --transcript and --plan do not look related, proceeding due to --confirm-mismatch\n');
    }
  }

  // Arms + D4 collision classification resolve FIRST now (§7 Phase 2 —
  // moved up from below `selectRetryArmIds`): a fresh fixture's local log has
  // no entry to derive a scope from at all, but the CURRENT invocation's own
  // campaign is always resolvable from `--campaign`/ambient config, and
  // Phase 2's store consultation needs it to resolve a cohort before any
  // local entry exists. A refusal here still costs nothing — no output
  // directory made yet, no arm spawned.
  const resolved = resolveArms({ campaignId: arg('campaign') });
  const fullArms = resolved.scope.arms;
  const expectedConfigDigest = resolved.config ? resolved.configDigest : null;

  // §7 Phase 2: consult the STORE for authoritative arm state before any
  // retry/skip decision — a fresh fixture's local log cannot see a success
  // recorded from another checkout. Fires only when a cohort is resolvable
  // (this campaign has a lock); absent that, `storeArmState`/
  // `activeExclusions` stay empty and every decision below falls back to
  // local-log-only behaviour, identical to before Phase 2.
  const { storeArmState, activeExclusions } = await resolveStoreState({
    lockDigest: resolved.lock?.lockDigest ?? null,
    campaignKey: resolved.config?.id ?? null,
    snapshotIdValue: id,
    expectedConfigDigest,
    expectedPlanContentHash: currentPlanHash,
    allowLogOnlyRetry,
  });

  // Abort BEFORE any spawn decision when this exact pairing (or the whole
  // snapshot) is under an active quarantine (§7 Phase 4) — never reached
  // silently: without this check, every arm reads `succeeded:false` via
  // `isAttemptExcluded` inside `liveArmRunsForSnapshot`'s own predicate, so
  // the collector would spawn and PAY for every arm, have promotion
  // correctly refuse them, and repeat the exact same spawn-pay-refuse cycle
  // on the very next invocation — an infinite billing loop.
  if (isAttemptExcluded({ snapshotId: id, planContentHash: currentPlanHash }, activeExclusions)) {
    throw new ArgvError(
      `[bakeoff] snapshot ${id} has an active quarantine matching this pairing — refusing to spawn (this would bill every `
      + 'arm and have promotion correctly refuse all of them, forever). Run `node scripts/campaign.mjs unquarantine` first '
      + 'if this was a mistake, or re-run with a genuinely corrected --plan.',
    );
  }

  const existing = readLog().find((e) => e.snapshotId === id);
  // D5 per-arm retry — scoped against the EXISTING entry's OWN campaign
  // (scopeForEntry) when there is one, else the CURRENT invocation's own
  // resolved scope (a fresh fixture still knows which arms its campaign
  // declares). `retryArmIds !== null` means "only spawn these arms and carry
  // every other arm's result forward unchanged"; `null` means either every
  // declared arm is already done (store or log), or nothing is done
  // anywhere yet (a genuine first-ever/full collection).
  const existingScope = existing ? scopeForEntry(existing) : resolved.scope;
  const retryArmIds = selectRetryArmIds(existing, existingScope, storeArmState, activeExclusions, expectedConfigDigest, currentPlanHash);
  const anySucceededAlready = existingScope
    ? existingScope.arms.some((a) => storeArmState?.[a.id]?.succeeded === true || (existing && armDidRun(a, existing)))
    : false;

  if (retryArmIds === null && anySucceededAlready && !force) {
    process.stderr.write(`  [bakeoff] snapshot ${id} already collected and complete — skipping (re-runs would double-count)\n`
      + '  Pass --force to re-collect: it SUPERSEDES rather than overwrites, so the prior attempt stays readable and its spend still counts.\n');
    printProgress(LOG_PATH, target, resolveScopeForProgress(existing?.campaignId ?? resolved.config?.id ?? null));
    return;
  }

  if (retryArmIds) {
    // Discarding the arms that already succeeded (opus/kimi/gemini-control,
    // say) because one arm (grok) returned `exit 1` is the exact waste D5
    // exists to stop — each of those was a real, paid provider call.
    process.stderr.write(`  [bakeoff] snapshot ${id} incomplete — retrying only: ${retryArmIds.join(', ')}`
      + ` (${existingScope.arms.length - retryArmIds.length} arm(s) already recorded, NOT re-charged)\n`);
  } else if (force && anySucceededAlready) {
    // §5's resume table: `--force` APPENDS a retry, it never overwrites. The
    // supersede itself happens at promotion time (`campaign.mjs reconcile`),
    // where the store can stamp the prior row `superseded_at` and insert
    // attempt N+1 in one transaction. Marking the log entry is what carries the
    // intent across that boundary — without it reconcile cannot tell a
    // deliberate re-collection from a replay of the same one, and correctly
    // refuses to double-count.
    process.stderr.write(`  [bakeoff] --force: re-collecting ${id}; the prior attempt will be superseded, never deleted\n`);
  }

  // The spawn set: every declared arm, UNLESS this is a per-arm retry, in
  // which case only the arm(s) named by retryArmIds are re-spawned. The other
  // declared arms are neither re-run nor re-charged — their prior results are
  // carried forward unchanged below.
  const ARMS = retryArmIds ? fullArms.filter((a) => retryArmIds.includes(a.id)) : fullArms;
  const envelopeScope = resolved.config?.controls?.envelopeScope ?? null;
  // `--campaign` in argv IS the campaign-active signal downstream — matches
  // gemini-review.mjs's own rule (--campaign-digest's presence, not how scope
  // arrived) so the two processes agree on what "a campaign is active" means.
  const campaignDigest = resolved.config ? resolved.configDigest : null;

  // Collector-side pre-flight verification (plan §8, Phase 6) — BEFORE any
  // arm spawns, cost nothing on refusal, same as the collision check above.
  const preflightCheck = verifyPreflightArtifact(resolved.config?.controls?.preflight);
  if (!preflightCheck.ok) throw new ArgvError(`[bakeoff] ${preflightCheck.reason}`);
  if (preflightCheck.checked) {
    process.stderr.write(`  [bakeoff] preflight verified: ${preflightCheck.artifact} (sha256 matches, disposition pass)\n`);
  }

  const outDir = path.join('.audit', 'bakeoff', id);
  fs.mkdirSync(outDir, { recursive: true });
  process.stderr.write(`  [bakeoff] snapshot ${id} — ${ARMS.length} arms on ${path.basename(transcript)} [${resolved.source}]\n`);
  if (resolved.lock) {
    process.stderr.write(`  [bakeoff] lock ${resolved.lock.lockDigest} (config ${resolved.configDigest}, prompt-template source: ${resolved.lock.promptTemplateSource})\n`);
  }

  const newArms = {};
  for (const a of ARMS) {
    // `readOutcome` is injected because `runArmAttempts` lives in spawn.mjs,
    // which cannot import summary.mjs (D2a) and therefore cannot parse a result
    // file — the same composition-at-the-entry-point rule as isCompleteForEntry
    // above. `beforeAttempt` mints ONE audit_runs row per ATTEMPT: two attempts
    // sharing a run id would persist the primary reviewer's findings into it
    // twice, and the store would carry a doubled review nobody ran.
    const { result, runId, supersededAttempts } = await runArmAttempts(
      a,
      { transcript, plan, mode: arg('mode'), outDir, id, envelopeScope, campaignDigest },
      {
        beforeAttempt: () => mintArmRun(a, { plan, mode: arg('mode'), id }),
        readOutcome: (spawned) => {
          try { return readArmResult(spawned.outPath); } catch (err) { return { error: `unreadable result: ${err.message}` }; }
        },
      },
    );
    newArms[a.id] = {
      ...result,
      runId: runId ?? null,
      // §7 Phase 4: stamped per-arm at collection time, never as a single
      // entry-level field — a value known only NOW must be carried per
      // attempt so promotion can populate campaign_arm_runs.config_digest/
      // .plan_content_hash correctly for each arm, including ones carried
      // forward by mergeRetryHistory under an OLDER config/plan. Only a
      // genuinely NEW collection call for an arm (this loop) stamps the
      // CURRENT invocation's values; mergeRetryHistory's carried-forward
      // arms below keep their own historical stamps unchanged.
      planContentHash: currentPlanHash,
      configDigest: expectedConfigDigest,
      // Superseded attempts are RECORDED, not discarded. Each was a real spawn
      // that may have been billed, and dropping them would make an arm that
      // failed once and recovered look exactly as cheap as one that succeeded
      // first time — the asymmetry `comparison/spend.mjs` exists to prevent,
      // and it flatters precisely the flakiest model in the cohort. Omitted
      // entirely (not `[]`) on the first-try case, so nothing changes shape for
      // an arm that never retried.
      ...(supersededAttempts.length ? { supersededAttempts } : {}),
    };
  }
  // A partial retry carries every OTHER arm's result forward unchanged from
  // the existing entry — this is what makes "opus/kimi/gemini-control NOT
  // re-charged" true at the file level, not just in intent. `readLog()`
  // replaces the whole entry per snapshotId (newest wins), so the merged
  // object below — not a partial one — is what must be written; a log line
  // containing only the retried arm would make readLog() forget the others.
  // `existing` can be undefined here even though `retryArmIds` is non-null:
  // `retryArmIds`/`selectRetryArmIds` is STORE-authoritative (checks
  // `storeArmState`, independent of the local log), so a fresh fixture whose
  // OWN bakeoff-log.jsonl has never seen this snapshot (the other arms were
  // collected in a different fixture or session) legitimately reaches this
  // branch with no local entry to merge against. `mergeRetryHistory` already
  // guards its own `priorArms?.[armId]` lookup; this was the one unguarded
  // read.
  const arms = retryArmIds ? { ...(existing?.arms ?? {}), ...mergeRetryHistory(newArms, existing?.arms ?? {}) } : newArms;

  const entry = {
    snapshotId: id,
    // Both stamped, and `isComplete` still gates on CONTRACT_EPOCH alone.
    // §2.5b's plan is for the derived lock to REPLACE the hand-maintained
    // string, but flipping the gate here would orphan every existing e2 row on
    // the next read — a data-meaning change that belongs with the cohort store
    // that can record the supersession, i.e. Cluster B. Stamping both now means
    // the rows collected in between carry the digest the new gate will need,
    // so the switchover reads history rather than discarding it.
    contractEpoch: CONTRACT_EPOCH,
    ...(resolved.lock ? {
      campaignId: resolved.config.id,
      configDigest: resolved.configDigest,
      lockDigest: resolved.lock.lockDigest,
      promptTemplateSource: resolved.lock.promptTemplateSource,
      requestFingerprints: resolved.fingerprints,
      // The campaign's DECLARED replicate arms — always from fullArms, never
      // from the (possibly retry-narrowed) spawn set ARMS. A partial retry
      // must not make this metadata forget a replicate arm just because it
      // wasn't spawned this particular round.
      replicateArmIds: fullArms.filter((a) => a.replicate).map((a) => a.id),
    } : {}),
    collectedAt: new Date().toISOString(),
    // Read by `campaign.mjs reconcile` to decide, PER ARM, whether that arm's
    // result in this entry is a retry (attempt N+1, supersede the prior live
    // row) or unchanged (skip — already recorded, never re-charged).
    // `retriedArmIds` is the per-arm marker (D5); `forced: true` is kept
    // alongside it on a whole-entry --force refresh for readability, but
    // `retriedArmIds` is what promotion actually keys on now.
    ...(retryArmIds ? { retriedArmIds: retryArmIds }
      : (force && existing ? { forced: true, retriedArmIds: fullArms.map((a) => a.id) } : {})),
    transcript: path.basename(transcript),
    plan,
    arms,
  };
  // Append-only + atomic: a crash mid-write can lose the newest line but never
  // corrupt earlier snapshots, and readLog tolerates a torn tail.
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  const prior = fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf-8') : '';
  atomicWriteFileSync(LOG_PATH, `${prior}${JSON.stringify(entry)}\n`);

  for (const [k, v] of Object.entries(arms)) {
    // The retry count rides on the SAME line as the result, not a separate one:
    // this readout is what an operator scans to see how the collection went, and
    // an arm that only succeeded on attempt 2 must not be indistinguishable here
    // from one that succeeded first time.
    const n = v.supersededAttempts?.length ?? 0;
    const retried = n ? ` [attempt ${n + 1}, ${n} superseded: ${v.supersededAttempts.map((s) => s.errorCategory ?? 'unknown').join(', ')}]` : '';
    process.stderr.write(`  [bakeoff] ${k}: ${v.error ? `ERROR ${v.error}` : `${v.shadowState} ${v.shadowModel} buckets=${JSON.stringify(v.buckets)}`}${retried}\n`);
  }

  // Anti-green on the CLOUD half. Registration is best-effort by design, but
  // "every arm ran and none of it was persisted" must never pass quietly: the
  // findings would exist only as files, `final-review-stats` would show nothing
  // to adjudicate, and the snapshot would still count — which is exactly the
  // state snapshots 2-3 were left in, undetected for a week. Found the hard way
  // on the first real run of this code path: a wrong import specifier made
  // every mint throw, and the failure was invisible behind a buffered pipe.
  const registered = Object.values(arms).filter((v) => v.runId).length;
  if (registered === 0 && await cloudIsOn()) {
    process.stderr.write('  [bakeoff] WARNING: cloud is enabled but NO arm registered an audit_runs row —\n'
      + '  findings are file-only and will not appear in `final-review-stats --worksheet`.\n'
      + '  Fix registration and re-collect; this snapshot cannot be adjudicated as-is.\n');
  } else if (registered < Object.keys(arms).length && await cloudIsOn()) {
    process.stderr.write(`  [bakeoff] NOTE: ${registered}/${Object.keys(arms).length} arms registered a cloud run — the rest are file-only.\n`);
  }
  // Judged against the campaign this entry was collected under, not an ambient
  // default (see scopeForEntry). And it names the arm: "an arm did not run"
  // printed directly under four lines each saying an arm HAD run, which is a
  // self-contradiction the reader has to debug rather than a diagnosis.
  const entryScope = scopeForEntry(entry);
  if (!entryScope) {
    process.stderr.write(`  [bakeoff] CANNOT JUDGE completeness — entry names campaign "${entry.campaignId}", which does not resolve.\n`
      + '  This is not "an arm did not run"; the snapshot is unjudgeable until the campaign is resolvable again.\n');
  } else if (!isComplete(entry, entryScope)) {
    const missing = entryScope.arms.filter((a) => !armDidRun(a, entry)).map((a) => a.id);
    process.stderr.write(`  [bakeoff] INCOMPLETE — this snapshot does NOT count toward N.${missing.length ? ` Arms that did not run: ${missing.join(', ')}.` : ' Every arm ran; the envelope-scope binding or contract epoch is what failed.'}\n`);
  }
  printProgress(LOG_PATH, target, { ok: true, scope: resolved.scope });
}

const invokedDirectly = (() => {
  try {
    const a = (process.argv[1] || '').replace(/\\/g, '/').toLowerCase();
    return a.endsWith('/bakeoff-collect.mjs');
  } catch { return false; }
})();

if (invokedDirectly) {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  // `main` is async since run registration talks to the store — an unawaited
  // rejection here would exit 0 with the log unwritten, which is precisely the
  // "an arm never ran reads as found nothing" failure the counter guards against.
  main().catch((err) => {
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') { process.stderr.write(`${err.message}\n`); process.exit(2); }
    process.stderr.write(`Error: ${err.message}\n`); process.exit(1);
  });
}
