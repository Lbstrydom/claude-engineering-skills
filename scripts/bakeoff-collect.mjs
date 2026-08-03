#!/usr/bin/env node
/**
 * @fileoverview Bake-off snapshot collector + progress counter.
 *
 * Runs BOTH arms of the final-review bake-off on ONE transcript and appends the
 * result to a machine-written log, so "how many snapshots do we have?" is a
 * QUERY, never a hand-maintained tally.
 *
 * **Why this script exists at all.** The activation addendum's first three
 * snapshots were recorded in a markdown table by hand, and a standalone
 * `gemini-review` invocation without `--run-id` has no audit run to attach to —
 * so nothing reached the store and the table was the only record. That is
 * precisely the manual-tally mechanism behind this repo's five prior false
 * "window met" reads (AGENTS.md, Model Swap-In Evaluation Harness). A count the
 * stopping rule depends on must be derived from data the collector wrote, not
 * from prose someone remembered to update.
 *
 * Bounded and synchronous by construction: `--progress` prints N/target and the
 * campaign has a fixed target. This is NOT a passive background collector — it
 * runs only when invoked, on a transcript you name.
 *
 * Usage:
 *   node scripts/bakeoff-collect.mjs --transcript <path> --plan <path> [--mode plan|code]
 *   node scripts/bakeoff-collect.mjs --progress
 *   node scripts/bakeoff-collect.mjs --selfcheck-relocation
 *
 * Plan: docs/plans/final-review-shadow-bakeoff.md §0 (Activation Addendum).
 *
 * @module scripts/bakeoff-collect
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import { atomicWriteFileSync } from './lib/file-io.mjs';

const KNOWN_FLAGS = Object.freeze([
  '--transcript', '--plan', '--mode', '--progress', '--target',
  '--selfcheck-relocation', '--help', '-h',
]);

/** Category A: accumulating run data, gitignored — never a committed artifact. */
export const LOG_PATH = '.audit/bakeoff-log.jsonl';
/**
 * Pre-registered cohort size, lowered 15 → **12** on 2026-08-03, before any
 * result under CONTRACT_EPOCH e2 was read — the only point §6.0b permits it
 * ("adjusts N ... only before run 1, never mid-campaign").
 *
 * 12 and not lower, deliberately. §6.3 row 1 makes `N < 12` terminal
 * INCONCLUSIVE — no keep/drop claim at any cost — so 8 would have bought a
 * cheaper campaign that answers nothing. 12 is the smallest N that still yields
 * a verdict, and reaching it required changing no decision rule: §0.5 states the
 * rule is inherited, not re-invented, and it is not amended here.
 *
 * What the reduction is worth: per-snapshot cost rose (three arms instead of
 * two, and matched reasoning effort made the OpenRouter arm ~5x slower), so the
 * three snapshots saved are real spend. What it is NOT: added confidence. §6.5
 * applies unchanged — this is an operating decision, not a statistical
 * inference, and 12 remains the floor the rule already set, not a new claim
 * about power.
 */
const DEFAULT_TARGET = 12;

/**
 * Evidence counts only if produced under the contract the stopping rule
 * validates (AGENTS.md, Model Swap-In Evaluation Harness). Bump on any
 * meaning-changing fix and RE-COLLECT — never backfill by date, which is the
 * relabelling that produced five false "window met" reads on the tiered
 * collector.
 *
 * e2 (2026-08-03): all three arms moved onto one reasoning dial. Under e1 the
 * arms ran at three unchosen depths — Gemini 16384, Opus 0 (forced tool_choice
 * silently disables reasoning), Kimi 'low'. Every e1 row therefore describes a
 * configuration that no longer exists, so they are ineligible rather than
 * deleted: the rows stay readable, they just cannot count.
 */
export const CONTRACT_EPOCH = 'e2-matched-reasoning-effort';

/**
 * The arms, in run order. Arm 1 IS the ordinary gate config.
 *
 * `solo-opus` answers a different question from the two shadow arms: not "what
 * does a second reviewer ADD to Gemini" but "would Opus alone have done". A
 * shadow arm can never answer it — it only ever reports findings measured
 * alongside a Gemini run, so a shadow that looks additive and a reviewer that
 * is simply better are indistinguishable from shadow buckets. It runs Opus as
 * PRIMARY with no shadow, so `shadowState` is inapplicable and completeness is
 * judged on the primary verdict instead (see isComplete).
 */
const ARMS = Object.freeze([
  { id: 'opus', env: { FINAL_REVIEW_SHADOW: 'claude-opus' } },
  { id: 'kimi', env: { FINAL_REVIEW_SHADOW: 'openrouter', FINAL_REVIEW_SHADOW_MODEL: 'moonshotai/kimi-k2-thinking' } },
  { id: 'solo-opus', solo: true, args: ['--provider', 'claude-opus'], env: { FINAL_REVIEW_SHADOW: '' } },
]);

/**
 * Snapshot identity is the transcript's CONTENT hash, not its path — two runs
 * over the same bytes are one snapshot even if the file was copied or renamed,
 * and a re-run against edited content is correctly a NEW snapshot rather than a
 * silent overwrite.
 * @param {string} transcriptPath
 * @returns {string} first 12 hex of sha256
 */
export function snapshotId(transcriptPath) {
  const buf = fs.readFileSync(transcriptPath);
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

/** Parse one arm's `--out` JSON into the fields the stopping rule scores. */
export function readArmResult(outPath) {
  const j = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
  const shadow = j._shadow || {};
  return {
    primaryVerdict: j.verdict ?? null,
    primaryFindings: (j.new_findings || []).length,
    shadowState: shadow.state ?? null,
    shadowModel: shadow.model ?? null,
    // The shadow's own VERDICT, not just its finding count. Observed at N=3:
    // both shadows APPROVE nearly everything — Kimi APPROVEd a plan the primary
    // REJECTed. A shadow's verdict is therefore near-useless as a signal, and
    // its whole value rides on the findings; recording it is what makes that
    // claim checkable at N=15 instead of an impression.
    shadowVerdict: shadow.verdict ?? null,
    // `buckets` is null when the shadow skipped — distinguish that from a real
    // zero, or a skipped arm reads as "found nothing" (the anti-green class).
    buckets: shadow.buckets ?? null,
  };
}

/** Every distinct snapshot in the log, newest entry wins per id. */
export function readLog(logPath = LOG_PATH) {
  if (!fs.existsSync(logPath)) return [];
  const byId = new Map();
  for (const line of fs.readFileSync(logPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { const e = JSON.parse(t); if (e?.snapshotId) byId.set(e.snapshotId, e); }
    catch { /* a torn final line must not lose every prior snapshot */ }
  }
  return [...byId.values()];
}

/**
 * A snapshot COUNTS only when every arm actually ran. An arm that skipped
 * (`skipped-no-key`, `skipped-azure`, …) or errored leaves the snapshot
 * incomplete — counting it would inflate N with rows that cannot support a
 * uniqueness claim, which is the same "measured nothing, read as data" failure
 * the epoch gate exists to prevent elsewhere.
 */
export function isComplete(entry) {
  if (entry?.contractEpoch !== CONTRACT_EPOCH) return false; // unstamped or stale ⇒ ineligible
  return ARMS.every((a) => {
    const r = entry?.arms?.[a.id];
    if (!r || r.error) return false;
    // A solo arm has no shadow, so demanding shadowState==='ran' would make the
    // snapshot permanently incomplete. Its evidence of having run is a verdict.
    return a.solo ? Boolean(r.primaryVerdict) : r.shadowState === 'ran';
  });
}

/**
 * Did an arm report ZERO findings while genuinely having reviewed?
 *
 * `shadowOnly: 0` is ambiguous on its own. Because cross-model `_hash` matching
 * makes the `both` bucket structurally ~0, a shadow that agreed with the primary
 * and a shadow that produced nothing at all BOTH read as `shadowOnly: 0`. The
 * distinguishing evidence is that it returned a verdict and spent output tokens:
 * that is a review that found nothing, not an arm that silently failed.
 *
 * Surfaced separately from `isComplete` because a broken arm and a lenient arm
 * lead to opposite conclusions, and the count alone cannot tell them apart.
 *
 * Three-way, never two-way. Entries written before `shadowVerdict` existed have
 * the key ABSENT, which is not the same as an arm that returned no verdict —
 * collapsing the two would report the campaign's own first three snapshots as
 * broken arms. `evidence` is `unrecorded` (predates the field, says nothing),
 * `reviewed` (returned a verdict ⇒ genuinely found nothing), or `no-verdict`
 * (recorded, and empty ⇒ suspect the arm, not the model).
 */
export function zeroFindingArms(entry) {
  const out = [];
  for (const a of ARMS) {
    const r = entry?.arms?.[a.id];
    if (a.solo) continue; // no shadow bucket exists; a zero here would be meaningless
    if (!r || r.shadowState !== 'ran') continue;
    if ((r.buckets?.shadowOnly ?? 0) !== 0) continue;
    const recorded = Object.hasOwn(r, 'shadowVerdict');
    out.push({
      arm: a.id,
      verdict: recorded ? (r.shadowVerdict ?? null) : undefined,
      evidence: !recorded ? 'unrecorded' : (r.shadowVerdict ? 'reviewed' : 'no-verdict'),
    });
  }
  return out;
}

export function summarise(entries, target = DEFAULT_TARGET) {
  const complete = entries.filter(isComplete);
  const totals = { opusUnique: 0, kimiUnique: 0, primaryTotal: 0 };
  for (const e of complete) {
    totals.opusUnique += e.arms.opus?.buckets?.shadowOnly ?? 0;
    totals.kimiUnique += e.arms.kimi?.buckets?.shadowOnly ?? 0;
    totals.primaryTotal += (e.arms.opus?.primaryFindings ?? 0) + (e.arms.kimi?.primaryFindings ?? 0);
  }
  return {
    complete: complete.length,
    incomplete: entries.length - complete.length,
    target,
    remaining: Math.max(0, target - complete.length),
    met: complete.length >= target,
    totals,
  };
}

function printProgress(logPath, target) {
  const entries = readLog(logPath);
  const s = summarise(entries, target);
  process.stdout.write(`\nBake-off progress — ${s.complete}/${s.target} complete snapshot(s)\n`);
  if (s.incomplete > 0) process.stdout.write(`  ${s.incomplete} incomplete (an arm skipped or errored) — not counted\n`);
  process.stdout.write(`  raw uniques so far: opus=${s.totals.opusUnique} kimi=${s.totals.kimiUnique}\n`);
  // A zero is only informative once you know the arm actually reviewed. Print the
  // verdict beside it so "lenient reviewer" and "broken arm" are never conflated
  // in the one number the stopping rule reads.
  const LABEL = { unrecorded: 'verdict not recorded (pre-dates the field)', 'no-verdict': 'NO VERDICT — suspect a BROKEN arm' };
  const zeros = entries.filter(isComplete).flatMap((e) => zeroFindingArms(e)
    .map((z) => `${z.arm}: ${LABEL[z.evidence] ?? `reviewed, verdict ${z.verdict}`}`));
  if (zeros.length > 0) {
    const tally = {};
    for (const z of zeros) tally[z] = (tally[z] || 0) + 1;
    process.stdout.write('  zero-finding arms — a zero means nothing until you know the arm reviewed:\n');
    for (const [k, n] of Object.entries(tally)) process.stdout.write(`    ${k} x${n}\n`);
  }
  process.stdout.write(s.met
    ? '  TARGET MET — adjudicate, then write the verdict to docs/research/ and STOP.\n'
    : `  ${s.remaining} more to go. Raw uniques are NOT the verdict — the rule scores ACCEPTED HIGH/MED clusters.\n`);
  process.stdout.write(`  log: ${logPath}\n\n`);
}

function runArm(arm, { transcript, plan, mode, outDir, id }) {
  const out = path.join(outDir, `${id}-${arm.id}.json`);
  const args = ['scripts/gemini-review.mjs', 'review', plan, transcript, '--out', out, ...(arm.args || [])];
  if (mode) args.push('--mode', mode);
  process.stderr.write(`  [bakeoff] arm ${arm.id}…\n`);
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf-8',
    env: { ...process.env, ...arm.env, GEMINI_REVIEW_TIMEOUT_MS: process.env.GEMINI_REVIEW_TIMEOUT_MS || '300000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) return { error: `exit ${r.status}`, stderrTail: String(r.stderr || '').slice(-400) };
  try { return readArmResult(out); } catch (err) { return { error: `unreadable result: ${err.message}` }; }
}

function main() {
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'bakeoff-collect' });
  const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? null : (process.argv[i + 1] ?? null); };
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('Usage: node scripts/bakeoff-collect.mjs --transcript <path> --plan <path> [--mode plan|code]\n'
      + '       node scripts/bakeoff-collect.mjs --progress\n');
    return;
  }
  const target = Number(arg('target') || DEFAULT_TARGET);
  if (process.argv.includes('--progress')) { printProgress(LOG_PATH, target); return; }

  const transcript = arg('transcript');
  const plan = arg('plan');
  if (!transcript || !plan) throw new ArgvError('--transcript <path> and --plan <path> are both required (or use --progress)');
  for (const p of [transcript, plan]) if (!fs.existsSync(p)) throw new ArgvError(`not found: ${p}`);

  const id = snapshotId(transcript);
  const existing = readLog().find((e) => e.snapshotId === id);
  if (existing && isComplete(existing)) {
    process.stderr.write(`  [bakeoff] snapshot ${id} already collected and complete — skipping (re-runs would double-count)\n`);
    printProgress(LOG_PATH, target);
    return;
  }

  const outDir = path.join('.audit', 'bakeoff', id);
  fs.mkdirSync(outDir, { recursive: true });
  process.stderr.write(`  [bakeoff] snapshot ${id} — ${ARMS.length} arms on ${path.basename(transcript)}\n`);

  const arms = {};
  for (const a of ARMS) arms[a.id] = runArm(a, { transcript, plan, mode: arg('mode'), outDir, id });

  const entry = {
    snapshotId: id,
    contractEpoch: CONTRACT_EPOCH,
    collectedAt: new Date().toISOString(),
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
  if (!isComplete(entry)) process.stderr.write('  [bakeoff] INCOMPLETE — an arm did not run; this snapshot does NOT count toward N\n');
  printProgress(LOG_PATH, target);
}

const invokedDirectly = (() => {
  try {
    const a = (process.argv[1] || '').replace(/\\/g, '/').toLowerCase();
    return a.endsWith('/bakeoff-collect.mjs');
  } catch { return false; }
})();

if (invokedDirectly) {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  try { main(); } catch (err) {
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') { process.stderr.write(`${err.message}\n`); process.exit(2); }
    process.stderr.write(`Error: ${err.message}\n`); process.exit(1);
  }
}
