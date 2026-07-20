#!/usr/bin/env node
/**
 * @fileoverview Report AGENTS.md lines whose cited code has moved since the
 * line did — the "is this still TRUE" companion to `context:check`, which only
 * checks form.
 *
 * **A REPORT, never a gate.** It exits 0 whether or not it flags anything;
 * only a tool fault is non-zero. `check-docs-refs.mjs` records why: a lint that
 * guesses aptness "would be noise — noisy gates get bypassed, which is how the
 * stale refs accumulated". Measured precision is ~3-in-8 — worth a periodic
 * skim, intolerable on a push.
 *
 * Scope is AGENTS.md alone, deliberately. It is the file loaded every session,
 * so it has the highest cost-of-staleness and the smallest surface to validate
 * against. Widening to docs/ is cheap later; starting wide would have made the
 * precision question unanswerable.
 *
 * Usage:
 *   node scripts/context-staleness.mjs            # ranked report
 *   node scripts/context-staleness.mjs --json     # machine-readable
 *   node scripts/context-staleness.mjs --threshold 90
 *   node scripts/context-staleness.mjs --all      # every drifting line
 *
 * Acknowledge a line that is stable-and-still-true by adding its `ackKey` to
 * `.context-staleness-ack.json`. The key hashes the line TEXT, so editing the
 * line voids the ack automatically — it cannot rot into a permanent blindfold.
 *
 * @module scripts/context-staleness
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import {
  computeStaleness,
  citationsInLine,
  unverifiableReason,
  DEFAULT_THRESHOLD_DAYS,
} from './lib/context-staleness.mjs';

const TARGET = 'AGENTS.md';
const ACK_FILE = '.context-staleness-ack.json';
const G = '\x1b[32m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1e8 });

/** Per-line last-change date, in ONE blame call. */
function lineDatesFor(file) {
  const out = git('blame', '--line-porcelain', '--', file);
  const dates = [];
  let pending = null;
  for (const l of out.split('\n')) {
    if (l.startsWith('author-time ')) pending = new Date(Number(l.split(' ')[1]) * 1000);
    else if (l.startsWith('\t')) { dates.push(pending); pending = null; }
  }
  return dates;
}

const pathDateCache = new Map();
function pathDate(p) {
  if (pathDateCache.has(p)) return pathDateCache.get(p);
  let date = null;
  try {
    const s = git('log', '-1', '--format=%cI', '--', p).trim();
    if (s) date = new Date(s);
  } catch { /* untracked or unknown */ }
  pathDateCache.set(p, date);
  return date;
}

function loadAcks() {
  if (!fs.existsSync(ACK_FILE)) return new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(ACK_FILE, 'utf8'));
    return new Set((raw.acks || []).map((a) => a.ackKey).filter(Boolean));
  } catch (err) {
    process.stderr.write(`  [warn] ${ACK_FILE} unreadable (${err.message}) — proceeding with no acks\n`);
    return new Set();
  }
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const showAll = argv.includes('--all');
  const ti = argv.indexOf('--threshold');
  const threshold = ti !== -1 && argv[ti + 1] ? Number(argv[ti + 1]) : DEFAULT_THRESHOLD_DAYS;

  if (!fs.existsSync(TARGET)) {
    process.stderr.write(`${TARGET} not found — run from the repo root\n`);
    process.exit(1);
  }

  const lines = fs.readFileSync(TARGET, 'utf8').split('\n');
  const lineDates = lineDatesFor(TARGET);
  const resolve = (p) => fs.existsSync(p);

  // Resolve every cited path's date up front so the pure core stays pure.
  const pathDates = new Map();
  for (const line of lines) {
    for (const p of citationsInLine(line, resolve)) {
      if (!pathDates.has(p)) pathDates.set(p, pathDate(p));
    }
  }

  const result = computeStaleness({
    lines, lineDates, pathDates, resolve,
    acked: loadAcks(), thresholdDays: threshold,
  });
  const unverifiable = unverifiableReason(result.coverage);

  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, target: TARGET, threshold, unverifiable, ...result }, null, 2)}\n`);
    process.exit(0);
  }

  const { coverage } = result;
  process.stdout.write(`\n${B}context staleness — ${TARGET}${X}\n`);
  process.stdout.write(
    `${D}  ${coverage.citingLines} of ${coverage.totalLines} lines cite code; ` +
    `${coverage.withDrift} show drift; threshold ${threshold}d${X}\n\n`,
  );

  // A run that examined nothing must never print a clean verdict.
  if (unverifiable) {
    process.stdout.write(`${Y}  UNVERIFIED${X} — ${unverifiable}\n`);
    process.stdout.write(`${D}  Not a clean bill of health: this run checked nothing.${X}\n\n`);
    process.exit(0);
  }

  const shown = showAll ? result.rows : result.flagged;
  if (shown.length === 0) {
    process.stdout.write(`${G}  no line over the threshold${X}`);
    if (result.suppressed.length) process.stdout.write(`${D} (${result.suppressed.length} acknowledged)${X}`);
    process.stdout.write('\n\n');
    process.exit(0);
  }

  for (const r of shown) {
    const tag = r.acked ? `${D}[acked]${X} ` : '';
    process.stdout.write(`${Y}${String(r.driftDays).padStart(4)}d${X}  L${String(r.lineNumber).padStart(4)}  ${tag}${r.path}\n`);
    process.stdout.write(`${D}        ${r.text.slice(0, 96)}${X}\n`);
    process.stdout.write(`${D}        ack: ${r.ackKey}${X}\n`);
  }

  process.stdout.write(
    `\n${D}  Drift is a SMELL, not a verdict — a stable rule can cite churning code and stay true.\n` +
    `  Fix the line, or acknowledge it in ${ACK_FILE} with a reason (the ack voids itself when the line changes).${X}\n\n`,
  );
  process.exit(0);
}

const isMain = (() => {
  const argv1 = process.argv[1]?.replace(/\\/g, '/');
  if (!argv1) return false;
  return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
})();

if (isMain) main();
