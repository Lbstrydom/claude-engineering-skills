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
 * `planRetryScope`, `readArmResult`. The entry point is exactly the layer D2a
 * designates for that composition — and `planRetryScope` additionally composes
 * `bakeoff/**` with `campaign/promote.mjs`'s store read, which D2a forbids
 * either subsystem from doing to the other.
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
import { LOG_PATH, CONTRACT_EPOCH, snapshotId, readLog } from './lib/bakeoff/log.mjs';
import { resolveArms, scopeForEntry, armDidRun } from './lib/bakeoff/arms.mjs';
import { isComplete, armCostUsd, distinctFindingCount, cohortDigest } from './lib/bakeoff/summary.mjs';
import { runArmAttempts, verifyPreflightArtifact } from './lib/bakeoff/spawn.mjs';
import { printProgress } from './lib/bakeoff/progress.mjs';

const KNOWN_FLAGS = Object.freeze([
  '--transcript', '--plan', '--mode', '--progress', '--target', '--campaign',
  '--force', '--selfcheck-relocation', '--help', '-h',
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
 * D5's retry-arm selection — extracted so the rule is assertable without
 * spawning a single provider call, same reasoning as `resolvePromotionAttempt`
 * in campaign.mjs.
 *
 * @param {object|undefined} existing - the entry currently on disk for this
 *   snapshotId, or undefined on a first-ever collection
 * @param {import('./lib/bakeoff/scope.mjs').ResolvedScope|null} existingScope -
 *   `scopeForEntry(existing)`; null when the entry names an unresolvable
 *   campaign ("cannot judge" — not the same fact as "an arm did not run")
 * @returns {string[]|null} arm ids to retry, or null for a FULL collection —
 *   reached on a first-ever attempt, OR when every declared arm ran and the
 *   snapshot is still incomplete for a reason a retry cannot fix (envelope-
 *   scope binding, contract epoch): re-spawning nothing there would be a
 *   silent no-op that never resolves the incompleteness.
 */
export function selectRetryArmIds(existing, existingScope) {
  if (!existing || !existingScope) return null;
  if (isComplete(existing, existingScope)) return null;
  const missing = existingScope.arms.filter((a) => !armDidRun(a, existing)).map((a) => a.id);
  return missing.length > 0 ? missing : null;
}

/**
 * PURE. The full retry-scoping decision: which arms get spawned, judged
 * against BOTH the local log and the store, with the reason it decided that
 * printed before any money is spent.
 *
 * **The defect this replaces, measured 2026-08-18.** `selectRetryArmIds`
 * alone asks only the local `.audit/bakeoff-log.jsonl`. `.audit/` is
 * gitignored, so a freshly-created pinned fixture has an EMPTY one — and
 * `docs/runbooks/pinned-revision-fixture.md` tells operators to create
 * exactly such a fixture to retry a snapshot at its recorded revision. The
 * empty log read as "first-ever collection", `selectRetryArmIds` returned
 * `null`, and all SIX arms of snapshot `2bb342bdd692` re-ran when only `grok`
 * was missing. The other five were live in `campaign_arm_runs` throughout.
 * The store is already authoritative for N, for promotion and for spend
 * everywhere else in this system; the local log being the retry oracle was
 * the anomaly.
 *
 * **Four modes, and `nothing-to-do` is the one the old shape could not
 * express.** `selectRetryArmIds` returns `string[]|null`, where `null` means
 * "collect everything" — correct for a first-ever run and for the
 * every-arm-ran-yet-incomplete case, and catastrophically wrong for "the
 * store already holds all of them". Overloading one sentinel across those is
 * how the widening stayed invisible, so this returns a named mode instead.
 *
 * **`--force` is exempt from store narrowing, deliberately.** It is an
 * explicit operator instruction to re-spawn and supersede, issued from a
 * checkout whose log the operator is looking at. The defect fixed here is a
 * SILENT widening on a path where nobody asked for one; refusing an
 * operator's explicit re-collection would be a different bug.
 *
 * @param {object} args
 * @param {object|undefined} args.existing - the local log entry for this snapshot
 * @param {import('./lib/bakeoff/scope.mjs').ResolvedScope|null} args.existingScope
 * @param {import('./lib/bakeoff/scope.mjs').ResolvedScope} args.resolvedScope - the
 *   scope THIS run resolved; the store answer is keyed by its cohort, so it is
 *   the only scope the store's arm ids may be compared against
 * @param {{ok: boolean, source: string, armIds: string[], reason: string|null}|null} args.recorded
 * @param {boolean} [args.force]
 * @returns {{mode: 'full'|'partial'|'nothing-to-do', armIds: string[]|null,
 *   alreadyRecorded: string[], warn: boolean, messages: string[]}}
 */
export function planRetryScope({ existing, existingScope, resolvedScope, recorded = null, force = false }) {
  const storeOk = recorded?.ok === true;
  const storeIds = new Set(storeOk ? (recorded.armIds ?? []) : []);
  const declared = resolvedScope?.arms?.map((a) => a.id) ?? [];
  // The provenance line is printed on EVERY path, including the ordinary
  // first collection. Its absence is what made the overspend invisible until
  // the bill arrived, so "we consulted X and it said Y" is not conditional on
  // the answer being interesting.
  const storeLine = storeOk
    ? `store: ${storeIds.size} arm(s) already recorded live for this snapshot${storeIds.size ? ` (${[...storeIds].join(', ')})` : ''}`
    : `store: NOT CONSULTABLE — ${recorded?.reason ?? 'no store answer was requested'}`;
  const logLine = existing
    ? `local log: an entry exists${existingScope ? '' : ' but names an unresolvable campaign'}`
    : `local log: no entry for this snapshot in ${LOG_PATH}`;
  const provenance = `retry scoping — ${storeLine}; ${logLine}`;

  const local = selectRetryArmIds(existing, existingScope);

  if (force) {
    // Today's `--force` behaviour, unchanged and unnarrowed.
    return {
      mode: local ? 'partial' : 'full',
      armIds: local,
      alreadyRecorded: [],
      warn: false,
      messages: [provenance, '--force: the store is NOT consulted to narrow this run — an explicit re-collection re-spawns and supersedes.'],
    };
  }

  if (local) {
    const armIds = local.filter((id) => !storeIds.has(id));
    if (armIds.length === 0) {
      return {
        mode: 'nothing-to-do', armIds: [], alreadyRecorded: [...storeIds], warn: false,
        messages: [provenance,
          `every arm this snapshot is missing locally (${local.join(', ')}) is already recorded live in the store — nothing to re-spawn, and re-spawning would re-bill work already paid for.`,
          'Pass --force if you intend to re-run and supersede those arm-runs anyway.'],
      };
    }
    return {
      mode: 'partial', armIds, alreadyRecorded: declared.filter((id) => !armIds.includes(id)), warn: false, messages: [provenance],
    };
  }

  // `local === null` with a judgeable entry is one of the two DELIBERATE full
  // collections (already complete, or every arm ran yet the snapshot is
  // incomplete for a reason no retry can fix). The store must not narrow
  // either: the second one re-spawns precisely because nothing else can
  // resolve the incompleteness.
  if (existing && existingScope) {
    return { mode: 'full', armIds: null, alreadyRecorded: [], warn: false, messages: [provenance] };
  }

  // No usable local entry — the store is the ONLY thing that can say what a
  // full collection would re-bill. This is the pinned-fixture path.
  if (!storeOk) {
    return {
      mode: 'full', armIds: null, alreadyRecorded: [], warn: true,
      messages: [provenance,
        `WARNING: cannot determine which arms are already recorded for this snapshot — widening to a FULL collection of ${declared.length} arm(s), every one of which will be billed.`,
        'If arms ARE already recorded, run `node scripts/campaign.mjs reconcile` from a checkout whose log holds them (or restore the store connection) and re-run this collection.'],
    };
  }
  if (storeIds.size === 0) {
    return { mode: 'full', armIds: null, alreadyRecorded: [], warn: false, messages: [provenance] };
  }
  const armIds = declared.filter((id) => !storeIds.has(id));
  if (armIds.length === 0) {
    return {
      mode: 'nothing-to-do', armIds: [], alreadyRecorded: [...storeIds], warn: false,
      messages: [provenance,
        'every declared arm is already recorded live in the store for this snapshot — nothing to collect.',
        'Pass --force if you intend to re-run and supersede those arm-runs anyway.'],
    };
  }
  return { mode: 'partial', armIds, alreadyRecorded: [...storeIds], warn: false, messages: [provenance] };
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

/**
 * Ask the store which arms it already holds live for this snapshot's cohort.
 * Never throws, and never reports an unanswered question as a measured zero —
 * `{ok:false, reason}` is what a caller must be able to see, because widening
 * to a full collection on a silent store failure is the defect `planRetryScope`
 * exists to prevent.
 *
 * Dynamically imported, like `mintArmRun`/`cloudIsOn` above and for the same
 * reason: the store's dependency tree is heavy and this entry point is the one
 * layer D2a permits to compose `bakeoff/**` with `campaign/**`.
 */
async function recordedArmsForSnapshot(id, resolved) {
  const campaignKey = resolved?.config?.id ?? null;
  const lockDigest = resolved?.lock?.lockDigest ?? null;
  if (!campaignKey || !lockDigest) {
    return { ok: false, source: 'store', armIds: [], reason: 'this run resolved no campaign lock digest, so there is no cohort to ask about' };
  }
  try {
    const { recordedArmIdsForSnapshot } = await import('./lib/campaign/promote.mjs');
    return await recordedArmIdsForSnapshot({ campaignKey, lockDigest, snapshotId: id });
  } catch (err) {
    return { ok: false, source: 'store', armIds: [], reason: `store lookup failed: ${err.message}` };
  }
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
  const existing = readLog().find((e) => e.snapshotId === id);
  if (existing && isCompleteForEntry(existing) && !force) {
    process.stderr.write(`  [bakeoff] snapshot ${id} already collected and complete — skipping (re-runs would double-count)\n`
      + '  Pass --force to re-collect: it SUPERSEDES rather than overwrites, so the prior attempt stays readable and its spend still counts.\n');
    // `resolved` is not bound yet at this early return, so scope the readout
    // by the entry's own campaign — which is the authoritative answer anyway.
    printProgress(LOG_PATH, target, resolveScopeForProgress(existing.campaignId ?? null));
    return;
  }

  // Arms + D4 collision classification resolve BEFORE the output directory is
  // made and before any arm is spawned: a refusal must cost nothing. This also
  // has to happen before retry scoping now, because the store answer is keyed
  // by THIS run's cohort (campaign key + lock digest) — evidence recorded under
  // a different lock belongs to a different cohort and must never narrow this
  // one.
  const resolved = resolveArms({ campaignId: arg('campaign') });
  const fullArms = resolved.scope.arms;

  // D5 per-arm retry, now scoped against the store as well as the local log.
  // `retryArmIds !== null` means "only spawn these arms and carry every other
  // arm's result forward unchanged"; `null` means a full collection (either
  // the first-ever attempt, or an operator-requested full refresh of an
  // already-complete snapshot via --force). See `planRetryScope` for why the
  // local log alone was a ~6x overspend on the pinned-fixture path.
  const existingScope = existing ? scopeForEntry(existing) : null;
  const recorded = await recordedArmsForSnapshot(id, resolved);
  const retryPlan = planRetryScope({ existing, existingScope, resolvedScope: resolved.scope, recorded, force });
  for (const m of retryPlan.messages) process.stderr.write(`  [bakeoff] ${m}\n`);
  if (retryPlan.mode === 'nothing-to-do') {
    printProgress(LOG_PATH, target, { ok: true, scope: resolved.scope });
    return;
  }
  const retryArmIds = retryPlan.mode === 'partial' ? retryPlan.armIds : null;

  if (retryArmIds) {
    // Discarding the arms that already succeeded (opus/kimi/gemini-control,
    // say) because one arm (grok) returned `exit 1` is the exact waste D5
    // exists to stop — each of those was a real, paid provider call.
    process.stderr.write(`  [bakeoff] snapshot ${id} incomplete — retrying only: ${retryArmIds.join(', ')}`
      + ` (${retryPlan.alreadyRecorded.length} arm(s) already recorded, NOT re-charged)\n`);
  } else if (force && existing) {
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
  //
  // `existing` is OPTIONAL here since store-authoritative scoping landed: a
  // pinned fixture retries one arm with an empty local log, so there is no
  // prior entry to carry forward and the written entry legitimately holds only
  // the arm that ran. The other arms are not lost — they are in the store,
  // which is what `campaign.mjs reconcile` and the verdict actually read. What
  // must never happen is a crash on `existing.arms` here, AFTER every arm has
  // already been spawned and billed.
  const arms = retryArmIds ? { ...(existing?.arms ?? {}), ...mergeRetryHistory(newArms, existing?.arms) } : newArms;

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
    // The LOCAL log is what that verdict reads, and in a fresh checkout it can
    // be missing arms the store holds — the very asymmetry that made this
    // collection partial. Naming them stops the line above from reading as "N
    // arms were never run" when the honest statement is "N arms are not in
    // THIS log". Completeness for the campaign is decided store-side, by
    // `campaign.mjs reconcile`.
    const alsoRecorded = retryPlan.alreadyRecorded.filter((armId) => missing.includes(armId));
    if (alsoRecorded.length) {
      process.stderr.write(`  [bakeoff] ...of which ${alsoRecorded.join(', ')} ${alsoRecorded.length === 1 ? 'is' : 'are'} already recorded live in the STORE for this snapshot`
        + ' — absent from this checkout\'s log, not absent from the campaign. Run `node scripts/campaign.mjs reconcile` to judge completeness store-side.\n');
    }
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
