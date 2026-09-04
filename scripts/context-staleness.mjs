#!/usr/bin/env node
/**
 * @fileoverview Report doc lines whose cited code has moved since the line did
 * — the "is this still TRUE" companion to `context:check`, which only checks
 * form.
 *
 * **A REPORT, never a gate.** Exits 0 whether or not it flags anything; only a
 * tool fault is non-zero. `check-docs-refs.mjs` records why: a lint that guesses
 * aptness "would be noise — noisy gates get bypassed, which is how the stale
 * refs accumulated". Measured precision is ~3-in-8 — worth a periodic skim,
 * intolerable on a push.
 *
 * Scope: `AGENTS.md` + `docs/**`, minus the artefacts whose claims are NOT
 * meant to track code (see `shouldTrack`). That exclusion is not tuning: 613 of
 * 627 flagged lines came from terminal plans, which are historical records.
 *
 * Usage:
 *   node scripts/context-staleness.mjs                # ranked report
 *   node scripts/context-staleness.mjs --json
 *   node scripts/context-staleness.mjs --threshold 90
 *   node scripts/context-staleness.mjs --all          # every drifting line
 *   node scripts/context-staleness.mjs --agents-only  # the original narrow scope
 *
 * Acknowledge a stable-and-still-true line by adding its `ackKey` to
 * `.context-staleness-ack.json`. The key hashes file + line TEXT + cited path,
 * so editing the line voids its ack automatically.
 *
 * @module scripts/context-staleness
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import {
  computeStaleness,
  citationsInLine,
  shouldTrack,
  unverifiableReason,
  DEFAULT_THRESHOLD_DAYS,
} from './lib/context-staleness.mjs';
import { parsePlanStatus } from './lib/plan-status.mjs';

const ACK_FILE = '.context-staleness-ack.json';
const G = '\x1b[32m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

// stderr is piped, not inherited: an untracked doc makes `git blame` print
// "no such path ... in HEAD", which is expected here (the file simply has no
// history yet) and must not look like a tool fault in the report.
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1e8, stdio: ['ignore', 'pipe', 'pipe'] });

function lineDatesFor(file) {
  try {
    const out = git('blame', '--line-porcelain', '--', file);
    const dates = [];
    let pending = null;
    for (const l of out.split('\n')) {
      if (l.startsWith('author-time ')) pending = new Date(Number(l.split(' ')[1]) * 1000);
      else if (l.startsWith('\t')) { dates.push(pending); pending = null; }
    }
    return dates;
  } catch { return []; }
}

const pathDateCache = new Map();
function pathDate(p) {
  if (pathDateCache.has(p)) return pathDateCache.get(p);
  let date = null;
  try {
    const s = git('log', '-1', '--format=%cI', '--', p).trim();
    if (s) date = new Date(s);
  } catch { /* untracked */ }
  pathDateCache.set(p, date);
  return date;
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
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
  const agentsOnly = argv.includes('--agents-only');
  const ti = argv.indexOf('--threshold');
  const threshold = ti !== -1 && argv[ti + 1] ? Number(argv[ti + 1]) : DEFAULT_THRESHOLD_DAYS;

  const candidates = agentsOnly ? ['AGENTS.md'] : ['AGENTS.md', ...walk('docs')];
  const acked = loadAcks();
  const resolve = (p) => fs.existsSync(p);

  const allRows = [];
  const totals = { files: 0, skipped: 0, totalLines: 0, citingLines: 0, datedLines: 0, withDrift: 0 };
  const skipReasons = new Map();

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, 'utf8');

    const track = shouldTrack(file, content, parsePlanStatus);
    if (!track.tracked) {
      totals.skipped++;
      const k = track.reason.replace(/\(.*\)/, '(…)');
      skipReasons.set(k, (skipReasons.get(k) || 0) + 1);
      continue;
    }

    const lines = content.split('\n');
    const lineDates = lineDatesFor(file);
    if (!lineDates.length) continue;

    const pathDates = new Map();
    for (const line of lines) {
      for (const p of citationsInLine(line, resolve)) {
        if (!pathDates.has(p)) pathDates.set(p, pathDate(p));
      }
    }

    const r = computeStaleness({ file, lines, lineDates, pathDates, resolve, acked, thresholdDays: threshold });
    totals.files++;
    totals.totalLines += r.coverage.totalLines;
    totals.citingLines += r.coverage.citingLines;
    totals.datedLines += r.coverage.datedLines;
    totals.withDrift += r.coverage.withDrift;
    allRows.push(...r.rows);
  }

  allRows.sort((a, b) => b.driftDays - a.driftDays);
  const over = allRows.filter((r) => r.driftDays >= threshold);
  const flagged = over.filter((r) => !r.acked);
  const suppressed = over.filter((r) => r.acked);
  const unverifiable = unverifiableReason(totals);

  if (json) {
    // `ok` must agree with the human verdict below, which already refuses to
    // print a clean bill of health for a run that examined nothing. This
    // emitted a hardcoded `ok: true` alongside a non-null `unverifiable`, so a
    // machine consumer keying on `ok` got a green the human output explicitly
    // denies. Exit stays 0 — this is advisory, and an unverifiable run must not
    // start gating what a clean one never gated.
    process.stdout.write(`${JSON.stringify({
      ok: !unverifiable,
      verdict: unverifiable ? 'unverifiable' : 'ok',
      threshold, scope: agentsOnly ? 'agents-only' : 'agents+docs',
      unverifiable, coverage: totals, flagged, suppressed, rows: showAll ? allRows : undefined,
    }, null, 2)}\n`);
    process.exit(0);
  }

  process.stdout.write(`\n${B}context staleness — ${agentsOnly ? 'AGENTS.md' : 'AGENTS.md + docs/'}${X}\n`);
  process.stdout.write(
    `${D}  ${totals.files} file(s) tracked, ${totals.skipped} skipped; ` +
    `${totals.citingLines} lines cite code; ${totals.withDrift} drift; threshold ${threshold}d${X}\n`,
  );
  for (const [reason, n] of [...skipReasons].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`${D}    skipped ${String(n).padStart(3)} — ${reason}${X}\n`);
  }
  process.stdout.write('\n');

  // A run that examined nothing must never print a clean verdict.
  if (unverifiable) {
    process.stdout.write(`${Y}  UNVERIFIED${X} — ${unverifiable}\n`);
    process.stdout.write(`${D}  Not a clean bill of health: this run checked nothing.${X}\n\n`);
    process.exit(0);
  }

  const shown = showAll ? allRows : flagged;
  if (shown.length === 0) {
    process.stdout.write(`${G}  no line over the threshold${X}`);
    if (suppressed.length) process.stdout.write(`${D} (${suppressed.length} acknowledged)${X}`);
    process.stdout.write('\n\n');
    process.exit(0);
  }

  for (const r of shown) {
    const tag = r.acked ? `${D}[acked]${X} ` : '';
    process.stdout.write(`${Y}${String(r.driftDays).padStart(4)}d${X}  ${tag}${r.file}:${r.lineNumber}  ${D}→ ${r.path}${X}\n`);
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
