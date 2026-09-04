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

function readBaseline(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')).files || {}; } catch { return null; }
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
    // Atomic: a truncate-then-write interrupted midway would leave an
    // unparseable baseline, and readBaseline() maps a parse failure to null —
    // which this gate treats as 'cannot say' and exits 2 on. Recoverable, but
    // the rename is free.
    atomicWriteFileSync(baselinePath, `${JSON.stringify({
      _description: 'Line counts for files already over the size limit. Drift-only ratchet: '
        + 'see scripts/file-size-ratchet.mjs. Regenerate deliberately with --update-baseline.',
      limitLines: LIMIT_LINES,
      toleranceLines: TOLERANCE_LINES,
      files: current,
    }, null, 2)}\n`, 'utf-8');
    process.stdout.write(`file-size-ratchet: baseline updated — ${Object.keys(current).length} file(s) over ${LIMIT_LINES} lines.\n`);
    process.exit(0);
  }

  const baseline = readBaseline(baselinePath);
  if (baseline === null) {
    // Fail closed: a missing baseline means the gate cannot say anything, and
    // "cannot say" must never render as "clean".
    process.stderr.write(`file-size-ratchet: no baseline at ${path.relative(REPO, baselinePath)} — run --update-baseline to create it.\n`);
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
    process.stdout.write('  A file over the limit may not grow. Split it, or justify and re-baseline.\n');
  }
  if (shrank.length || dropped.length) {
    process.stdout.write('  Improvements must be locked in, or the ratchet stays at the old high-water mark:\n');
    process.stdout.write('    npm run size:ratchet:gate -- --update-baseline\n');
  }
  process.exit(reportOnly ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('file-size-ratchet.mjs')) {
  main();
}
