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
import { LOG_PATH, CONTRACT_EPOCH, snapshotId, readLog } from './lib/bakeoff/log.mjs';
import { resolveArms, scopeForEntry, armDidRun } from './lib/bakeoff/arms.mjs';
import { isComplete, armCostUsd, distinctFindingCount, cohortDigest } from './lib/bakeoff/summary.mjs';
import { runArm, verifyPreflightArtifact } from './lib/bakeoff/spawn.mjs';
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

  // D5 per-arm retry — scoped against the EXISTING entry's OWN campaign
  // (scopeForEntry), so this is knowable before `resolveArms` runs below.
  // `retryArmIds !== null` means "only spawn these arms and carry every other
  // arm's result forward unchanged"; `null` means a full collection (either
  // the first-ever attempt, or an operator-requested full refresh of an
  // already-complete snapshot via --force).
  const existingScope = existing ? scopeForEntry(existing) : null;
  const retryArmIds = selectRetryArmIds(existing, existingScope);

  if (retryArmIds) {
    // Discarding the arms that already succeeded (opus/kimi/gemini-control,
    // say) because one arm (grok) returned `exit 1` is the exact waste D5
    // exists to stop — each of those was a real, paid provider call.
    process.stderr.write(`  [bakeoff] snapshot ${id} incomplete — retrying only: ${retryArmIds.join(', ')}`
      + ` (${existingScope.arms.length - retryArmIds.length} arm(s) already recorded, NOT re-charged)\n`);
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

  // Arms + D4 collision classification resolve BEFORE the output directory is
  // made and before any arm is spawned: a refusal must cost nothing.
  const resolved = resolveArms({ campaignId: arg('campaign') });
  const fullArms = resolved.scope.arms;
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
    const runId = await mintArmRun(a, { plan, mode: arg('mode'), id });
    const spawned = runArm(a, { transcript, plan, mode: arg('mode'), outDir, id, runId, envelopeScope, campaignDigest });
    // `runArm` returns the raw spawn outcome only (spawn.mjs cannot import
    // summary.mjs, which readArmResult needs) — parse the result file here.
    const armResult = spawned.error ? spawned : (() => {
      try { return readArmResult(spawned.outPath); } catch (err) { return { error: `unreadable result: ${err.message}` }; }
    })();
    newArms[a.id] = { ...armResult, runId: runId ?? null };
  }
  // A partial retry carries every OTHER arm's result forward unchanged from
  // the existing entry — this is what makes "opus/kimi/gemini-control NOT
  // re-charged" true at the file level, not just in intent. `readLog()`
  // replaces the whole entry per snapshotId (newest wins), so the merged
  // object below — not a partial one — is what must be written; a log line
  // containing only the retried arm would make readLog() forget the others.
  const arms = retryArmIds ? { ...existing.arms, ...newArms } : newArms;

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
    process.stderr.write(`  [bakeoff] ${k}: ${v.error ? `ERROR ${v.error}` : `${v.shadowState} ${v.shadowModel} buckets=${JSON.stringify(v.buckets)}`}\n`);
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
