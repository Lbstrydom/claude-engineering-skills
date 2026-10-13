#!/usr/bin/env node
/**
 * @fileoverview Drift-only ratchet over oversized source files.
 *
 * **The measurement that motivates it.** Over the 60 days to 2026-09-04, two
 * deliberate decompositions with `Complete` plans removed 3,652 lines
 * (`legacy-production-audit.mjs` 3773→1701, `cross-skill.mjs` 2692→1112) — and
 * were more than offset by **4,551 lines of unmanaged growth across 11 other
 * files** (`gemini-review.mjs` +911, `sync-to-repos.mjs` +892,
 * `store/runs-findings.mjs` +663, `lib/ledger.mjs` +609, …). One of those,
 * `runs-findings.mjs`, grew *after* its decomposition was accepted. Without a
 * ratchet, decomposition is a treadmill.
 *
 * **Why drift-only, not an absolute cap.** Nineteen files are already over the
 * limit. A gate that fails on all of them fails on the first push, teaches
 * everyone to reach for `--no-verify`, and is then worse than no gate — the
 * argument `scripts/knip-gate.mjs:5-14` makes at length, and this file
 * deliberately mirrors its shape: a committed baseline, a non-zero exit only
 * for drift, and self-cleaning stale entries.
 *
 * **A shrink FAILS too, and that IS the ratchet.** If a shrink merely passed,
 * the baseline would stay pinned at each file's historical high-water mark and
 * a file could grow back to its old maximum unchallenged — a ratchet that only
 * ever holds, never tightens. So a shrink beyond `TOLERANCE_LINES` fails with
 * an instruction to re-baseline, exactly as knip-gate fails on a stale entry.
 *
 * Usage:
 *   node scripts/file-size-ratchet.mjs                  # gate
 *   node scripts/file-size-ratchet.mjs --report         # report-only, exit 0
 *   node scripts/file-size-ratchet.mjs --update-baseline
 *
 * @module scripts/file-size-ratchet
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertKnownFlags, ArgvError, argOption } from './lib/cli-io.mjs';
import { atomicWriteFileSync } from './lib/file-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_BASELINE = '.file-size-baseline.json';

/** A file at or above this many lines is governed. */
export const LIMIT_LINES = 1000;

/**
 * Growth/shrink under this many lines is noise, not a ratchet event. Without a
 * tolerance every routine edit to a 2,000-line file would demand a re-baseline,
 * which is friction that earns `--no-verify`.
 */
export const TOLERANCE_LINES = 10;

const SCAN_DIRS = ['scripts'];
const SCAN_EXT = '.mjs';

/** Every governed file's current line count, as a sorted plain object. */
export function collectSizes(repoRoot = REPO, dirs = SCAN_DIRS) {
  const out = {};
  const walk = (dir, isRoot = false) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // A directory that cannot be read is a FAILURE, not an empty one.
      // Swallowing it means the gate reports "no growth" for files it never
      // inspected — the same fail-open it exists to prevent. The first fix
      // covered only the governed roots; a nested EACCES or I/O error still
      // passed silently, which is what the R4 audit caught.
      //
      // ENOENT on a NESTED directory is the one benign case: a temp dir or a
      // concurrent clean can remove one mid-walk, and it genuinely holds no
      // files. Everything else — including ENOENT on a declared root — throws.
      if (isRoot || err.code !== 'ENOENT') {
        throw new Error(`cannot read ${isRoot ? 'governed scan root' : 'directory'} ${dir}: ${err.message}`);
      }
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.isFile() || !e.name.endsWith(SCAN_EXT)) continue;
      const rel = path.relative(repoRoot, full).replace(/\\/g, '/');
      const lines = fs.readFileSync(full, 'utf-8').split('\n').length;
      if (lines >= LIMIT_LINES) out[rel] = lines;
    }
  };
  for (const d of dirs) walk(path.join(repoRoot, d), true);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Pure decision logic, testable without touching disk.
 *
 * Four outcomes, and the two self-cleaning cases are deliberately distinct:
 *   - `grew`     — a baselined file gained more than the tolerance. FAIL.
 *   - `newOver`  — an unbaselined file crossed the limit. FAIL.
 *   - `shrank`   — a baselined file lost more than the tolerance and is STILL
 *                  over the limit. FAIL, asking for a ratchet-down; the
 *                  baseline is *updated*, and the file stays baselined.
 *   - `dropped`  — a baselined file fell BELOW the limit. FAIL, asking for its
 *                  removal from the baseline entirely.
 *
 * Conflating the last two is a real trap: removing a still-oversized file from
 * the baseline would make it fail immediately as an unbaselined file over the
 * limit.
 */
/**
 * The baseline `--update-baseline` writes. It only ever RATCHETS DOWN: each
 * baselined file keeps `min(old mark, current)`, a file now under the limit
 * leaves, and a file newly over the limit is NOT admitted. Writing every
 * file's current count (the previous behaviour) silently raised the mark of
 * any file that had grown within the tolerance — locking in one shrink
 * re-baselined unrelated creep upward. Accepting growth, or a new oversized
 * file, is a reviewed hand edit of that one entry, never a side effect.
 * With no baseline at all, the current sizes ARE the baseline (bootstrap).
 *
 * @param {Record<string, number>} current
 * @param {Record<string, number>|null} baseline
 * @returns {Record<string, number>}
 */
export function updatedBaseline(current, baseline) {
  if (!baseline) return { ...current };
  const next = {};
  for (const [file, was] of Object.entries(baseline)) {
    if (file in current) next[file] = Math.min(was, current[file]);
  }
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
}

export function diffAgainstBaseline(current, baseline, tolerance = TOLERANCE_LINES) {
  const grew = [];
  const newOver = [];
  const shrank = [];
  const dropped = [];

  for (const [file, lines] of Object.entries(current)) {
    if (!(file in baseline)) { newOver.push({ file, lines }); continue; }
    const was = baseline[file];
    if (lines - was > tolerance) grew.push({ file, was, now: lines });
    else if (was - lines > tolerance) shrank.push({ file, was, now: lines });
  }
  for (const [file, was] of Object.entries(baseline)) {
    if (!(file in current)) dropped.push({ file, was });
  }
  return { grew, newOver, shrank, dropped };
}

/**
 * What is on disk at the baseline path, as one of THREE outcomes. `absent`
 * (ENOENT) is the only one `--update-baseline` may bootstrap from; `invalid`
 * (unreadable, unparseable, or no `files` map of numeric counts) must refuse
 * with the file untouched. Collapsing the two into `null` let a corrupt baseline
 * read as "no baseline", so the update wrote every current size over it — the
 * growth the ratchet exists to refuse, absorbed.
 *
 * @param {string} p
 * @returns {{kind: 'absent'} | {kind: 'invalid', reason: string} | {kind: 'ok', files: Record<string, number>}}
 */
export function readBaselineState(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (err) {
    return err?.code === 'ENOENT' ? { kind: 'absent' } : { kind: 'invalid', reason: `unreadable: ${err?.code || err?.message}` };
  }
  let files;
  try { files = JSON.parse(raw)?.files; } catch (err) { return { kind: 'invalid', reason: `not valid JSON: ${err.message}` }; }
  if (!files || typeof files !== 'object' || Array.isArray(files)
      || !Object.values(files).every((n) => Number.isFinite(n))) {
    return { kind: 'invalid', reason: 'no `files` map of numeric line counts' };
  }
  return { kind: 'ok', files };
}

function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  try {
    assertKnownFlags(process.argv, ['--report', '--update-baseline', '--baseline', '--help', '-h', '--selfcheck-relocation'], { cli: 'file-size-ratchet' });
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    throw err;
  }
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stderr.write(`Usage: node scripts/file-size-ratchet.mjs [options]

Drift-only ratchet over files already past ${LIMIT_LINES} lines: they may not grow,
and an improvement must be locked in so the baseline does not stay at the
historical high-water mark.

Options:
  --report              Report findings, always exit 0
  --update-baseline     Re-baseline deliberately (records an improvement)
  --baseline <path>     Baseline file (default: ${DEFAULT_BASELINE})
  --help                Show this message

Exit codes: 0=clean, 1=drift, 2=no baseline / bad flag
`);
    process.exit(0);
  }
  // `--flag=value` returns -1 from a bare indexOf, so the explicit argument was
  // SILENTLY IGNORED and the default used instead. Fixed in
  // rotate-status-log.mjs first and left here — the inconsistent partial fix
  // the final gate flagged twice. `argOption` handles both forms.
  const i = process.argv.findIndex((a) => a === '--baseline' || a.startsWith('--baseline='));
  // A valueless or flag-followed --baseline silently fell back to the default,
  // so `--baseline --update-baseline` gated against the WRONG file while
  // looking like it honoured the flag.
  // Only the BARE form can be valueless; `--baseline=x` carries its own value.
  if (i !== -1 && process.argv[i] === '--baseline'
      && (process.argv[i + 1] === undefined || process.argv[i + 1].startsWith('-'))) {
    process.stderr.write('file-size-ratchet: --baseline requires a path.\n');
    process.exit(2);
  }
  const baselinePath = path.resolve(REPO, argOption('baseline', DEFAULT_BASELINE));
  const reportOnly = process.argv.includes('--report');
  const update = process.argv.includes('--update-baseline');

  const current = collectSizes();

  if (update) {
    const state = readBaselineState(baselinePath);
    if (state.kind === 'invalid') {
      // Bootstrap is for an ABSENT baseline only. Treating an unreadable or
      // malformed one as absent would write every current size over it —
      // absorbing exactly the growth and new oversized files this update
      // promises to refuse — so refuse and leave the file for a human.
      process.stderr.write(`file-size-ratchet: refusing --update-baseline — the baseline at ${path.relative(REPO, baselinePath)} exists but is invalid (${state.reason}). Fix or delete it deliberately; nothing was written.\n`);
      process.exit(2);
    }
    const prior = state.kind === 'ok' ? state.files : null;
    const files = updatedBaseline(current, prior);
    // Atomic: a truncate-then-write interrupted midway would leave an
    // unparseable baseline, which the gate reads as 'invalid' and exits 2 on, and
    // which this update now refuses to overwrite. Recoverable by hand, but the
    // rename is free.
    atomicWriteFileSync(baselinePath, `${JSON.stringify({
      _description: 'Line counts for files already over the size limit. Drift-only ratchet: '
        + 'see scripts/file-size-ratchet.mjs. Regenerate deliberately with --update-baseline.',
      limitLines: LIMIT_LINES,
      toleranceLines: TOLERANCE_LINES,
      files,
    }, null, 2)}\n`, 'utf-8');
    process.stdout.write(`file-size-ratchet: baseline updated (ratchet-down only) — ${Object.keys(files).length} file(s) baselined.\n`);
    const { grew, newOver } = prior ? diffAgainstBaseline(current, files) : { grew: [], newOver: [] };
    for (const g of [...grew, ...newOver]) {
      process.stdout.write(`  NOT absorbed: ${g.file} (${g.now ?? g.lines} lines) — split it, or hand-edit its entry in a reviewed commit.\n`);
    }
    process.exit(0);
  }

  const baselineState = readBaselineState(baselinePath);
  const baseline = baselineState.kind === 'ok' ? baselineState.files : null;
  if (baseline === null) {
    // Fail closed: a missing baseline means the gate cannot say anything, and
    // "cannot say" must never render as "clean". An INVALID one is named as
    // such — "run --update-baseline" would be the wrong advice for it.
    process.stderr.write(baselineState.kind === 'invalid'
      ? `file-size-ratchet: the baseline at ${path.relative(REPO, baselinePath)} is invalid (${baselineState.reason}) — fix it by hand; --update-baseline refuses to overwrite it.\n`
      : `file-size-ratchet: no baseline at ${path.relative(REPO, baselinePath)} — run --update-baseline to create it.\n`);
    process.exit(reportOnly ? 0 : 2);
  }

  const { grew, newOver, shrank, dropped } = diffAgainstBaseline(current, baseline);
  const lines = [];
  for (const g of grew) lines.push(`  GREW      ${g.file}: ${g.was} → ${g.now} (+${g.now - g.was})`);
  for (const n of newOver) lines.push(`  NEW>LIMIT ${n.file}: ${n.lines} lines (limit ${LIMIT_LINES})`);
  for (const s of shrank) lines.push(`  SHRANK    ${s.file}: ${s.was} → ${s.now} (−${s.was - s.now}) — lock it in`);
  for (const d of dropped) lines.push(`  DROPPED   ${d.file}: was ${d.was}, now under the limit — remove from baseline`);

  if (lines.length === 0) {
    process.stdout.write(`file-size-ratchet: clean — ${Object.keys(baseline).length} file(s) baselined, none grew.\n`);
    process.exit(0);
  }

  process.stdout.write(`file-size-ratchet: ${lines.length} change(s)\n${lines.join('\n')}\n\n`);
  if (grew.length || newOver.length) {
    process.stdout.write('  A file over the limit may not grow. Split it, or justify it and hand-edit its baseline entry\n'
      + '  (--update-baseline only ratchets down, so it never absorbs growth).\n');
  }
  if (shrank.length || dropped.length) {
    process.stdout.write('  Improvements must be locked in, or the ratchet stays at the old high-water mark:\n');
    process.stdout.write('    npm run size:ratchet:gate -- --update-baseline\n');
  }
  process.exit(reportOnly ? 0 : 1);
}

if (isInvokedAsScript(import.meta.url)) {
  main();
}
