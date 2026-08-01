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
const DEFAULT_TARGET = 15;

/** The arms, in run order. Arm 1 IS the ordinary gate config. */
const ARMS = Object.freeze([
  { id: 'opus', env: { FINAL_REVIEW_SHADOW: 'claude-opus' } },
  { id: 'kimi', env: { FINAL_REVIEW_SHADOW: 'openrouter', FINAL_REVIEW_SHADOW_MODEL: 'moonshotai/kimi-k2-thinking' } },
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
  return ARMS.every((a) => entry?.arms?.[a.id]?.shadowState === 'ran');
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
  process.stdout.write(s.met
    ? '  TARGET MET — adjudicate, then write the verdict to docs/research/ and STOP.\n'
    : `  ${s.remaining} more to go. Raw uniques are NOT the verdict — the rule scores ACCEPTED HIGH/MED clusters.\n`);
  process.stdout.write(`  log: ${logPath}\n\n`);
}

function runArm(arm, { transcript, plan, mode, outDir, id }) {
  const out = path.join(outDir, `${id}-${arm.id}.json`);
  const args = ['scripts/gemini-review.mjs', 'review', plan, transcript, '--out', out];
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
