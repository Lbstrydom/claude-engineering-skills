#!/usr/bin/env node
/**
 * @fileoverview Gate: every `.gitignore` rule declares which category it is in,
 * and a private one names where it durably lives.
 *
 * **Why.** This repo is public, so some of what it produces is ignored to keep
 * it private. The failure mode is not the ignoring — it is what nobody checks
 * afterwards: everyone assumes a private path lives somewhere durable. Measured
 * 2026-09-04, that assumption left **37 tech-debt entries on exactly one disk
 * and nowhere else**, while the owning module documented the ignored file as
 * "the durable, human-approved state".
 *
 * So a `Category: P` rule must answer "where does the recoverable content
 * actually live?" — and must state, explicitly, what it is knowingly NOT
 * keeping. An over-claimed `Recoverable:` is worse than an honest `Disposable:`.
 *
 * **Drift-only**, mirroring `scripts/knip-gate.mjs`: 60-odd rules predate this,
 * and a gate that fails on all of them fails on the first push and teaches
 * everyone to reach for `--no-verify`. A NEW or CHANGED rule must declare.
 *
 * Category vocabulary and the full policy: `docs/reference/gitignore-policy.md`.
 *
 * Usage:
 *   node scripts/check-gitignore-policy.mjs                  # gate
 *   node scripts/check-gitignore-policy.mjs --report         # exit 0
 *   node scripts/check-gitignore-policy.mjs --update-baseline
 *
 * @module scripts/check-gitignore-policy
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_BASELINE = '.gitignore-policy-baseline.json';
export const VALID_CATEGORIES = Object.freeze(['A', 'B', 'P']);

/**
 * Parse `.gitignore` into rule GROUPS with their bound comment block.
 *
 * A comment block binds DOWNWARD to the contiguous run of rule lines beneath
 * it, ending at the next blank line or comment block. A negation is an ordinary
 * member of its group — modelling it as a separate case is what made an earlier
 * draft's grammar self-contradictory for a `pattern` / `!exception` pair.
 *
 * @param {string} text
 * @returns {Array<{patterns: string[], comment: string, startLine: number}>}
 */
export function parseGroups(text) {
  const lines = text.split(/\r?\n/);
  const groups = [];
  let comment = [];
  let patterns = [];
  let startLine = 0;

  const flush = () => {
    if (patterns.length) groups.push({ patterns: [...patterns], comment: comment.join('\n'), startLine });
    patterns = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (line === '') { flush(); comment = []; continue; }
    if (line.startsWith('#')) {
      if (patterns.length) { flush(); comment = []; }
      comment.push(line.replace(/^#\s?/, ''));
      continue;
    }
    if (!patterns.length) startLine = i + 1;
    patterns.push(line);
  }
  flush();
  return groups;
}

/** Extract a `Token: value` from a comment block. */
function token(comment, name) {
  const m = comment.match(new RegExp(`^${name}:\\s*(.+)$`, 'mi'));
  return m ? m[1].trim() : null;
}

/**
 * Validate one group. Returns an array of violation strings (empty = fine).
 */
export function validateGroup(group) {
  const problems = [];
  const cat = token(group.comment, 'Category');

  if (!cat) {
    problems.push(`no \`Category:\` declared (expected one of ${VALID_CATEGORIES.join('/')})`);
  } else if (!VALID_CATEGORIES.includes(cat)) {
    problems.push(`unknown category \`${cat}\``);
  } else if (cat === 'P') {
    const home = token(group.comment, 'Durable home');
    const recoverable = token(group.comment, 'Recoverable');
    const disposable = token(group.comment, 'Disposable');
    if (!home) problems.push('Category P requires `Durable home:` — where does the content actually live?');
    if (!recoverable) problems.push('Category P requires `Recoverable:`');
    else if (/^(none|n\/a|nothing)$/i.test(recoverable)) {
      // A P rule whose recoverable half is empty is a contradiction: it is
      // either A (nothing worth keeping) or it has a home.
      problems.push('Category P with an empty `Recoverable:` is a contradiction — it is either Category A, or it has a durable home');
    }
    if (!disposable) problems.push('Category P requires `Disposable:` (may be `none`, but must be stated)');
  }

  if (group.patterns[0]?.startsWith('!')) {
    problems.push('a rule group may not START with a negation — it narrows nothing');
  }
  return problems;
}

/** Stable key for a group: its patterns plus the declaration it carries. */
export function keyFor(group) {
  const cat = token(group.comment, 'Category') || '-';
  const home = token(group.comment, 'Durable home') || '-';
  const rec = token(group.comment, 'Recoverable') || '-';
  const dis = token(group.comment, 'Disposable') || '-';
  // Keyed on the DECLARATION, not the line number: reordering the file is not
  // drift, but weakening a P rule's recoverability claim is.
  return `${group.patterns.join(',')}|${cat}|${home}|${rec}|${dis}`;
}

export function analyse(text) {
  const groups = parseGroups(text);
  const findings = [];
  for (const g of groups) {
    for (const problem of validateGroup(g)) {
      findings.push({ key: keyFor(g), line: g.startLine, patterns: g.patterns, problem });
    }
  }
  return { groups, findings };
}

function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  try {
    assertKnownFlags(process.argv, ['--report', '--update-baseline', '--baseline', '--help', '-h', '--selfcheck-relocation'], { cli: 'check-gitignore-policy' });
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    throw err;
  }
  const i = process.argv.indexOf('--baseline');
  const baselinePath = path.resolve(REPO, i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : DEFAULT_BASELINE);
  const reportOnly = process.argv.includes('--report');
  const update = process.argv.includes('--update-baseline');

  const text = fs.readFileSync(path.join(REPO, '.gitignore'), 'utf-8');
  const { groups, findings } = analyse(text);

  if (update) {
    fs.writeFileSync(baselinePath, `${JSON.stringify({
      _description: 'Accepted undeclared .gitignore rule groups. Drift-only: a NEW or CHANGED '
        + 'rule must declare its category (see docs/reference/gitignore-policy.md). '
        + 'This list should only ever shrink.',
      keys: [...new Set(findings.map((f) => f.key))].sort(),
    }, null, 2)}\n`, 'utf-8');
    process.stdout.write(`gitignore-policy: baseline updated — ${new Set(findings.map((f) => f.key)).size} undeclared group(s) accepted.\n`);
    process.exit(0);
  }

  let baseline;
  try { baseline = new Set(JSON.parse(fs.readFileSync(baselinePath, 'utf-8')).keys || []); } catch { baseline = null; }
  if (baseline === null) {
    process.stderr.write(`gitignore-policy: no baseline at ${path.relative(REPO, baselinePath)} — run --update-baseline.\n`);
    process.exit(reportOnly ? 0 : 2);
  }

  const netNew = findings.filter((f) => !baseline.has(f.key));
  const currentKeys = new Set(findings.map((f) => f.key));
  const stale = [...baseline].filter((k) => !currentKeys.has(k));

  if (netNew.length === 0 && stale.length === 0) {
    process.stdout.write(`gitignore-policy: clean — ${groups.length} rule group(s), ${baseline.size} in the accepted baseline, 0 net-new.\n`);
    process.exit(0);
  }

  if (netNew.length) {
    process.stdout.write(`gitignore-policy: ${netNew.length} undeclared or invalid rule group(s)\n`);
    for (const f of netNew) {
      process.stdout.write(`  .gitignore:${f.line}  ${f.patterns.join(', ')}\n      ${f.problem}\n`);
    }
    process.stdout.write('\n  Declare the category in the comment block above the rule.\n');
    process.stdout.write('  See docs/reference/gitignore-policy.md — A (derived), B (committed), P (private + load-bearing).\n');
  }
  if (stale.length) {
    process.stdout.write(`\ngitignore-policy: ${stale.length} stale baseline entr(ies) — now declared, remove them:\n`);
    for (const k of stale) process.stdout.write(`  ${k.split('|')[0]}\n`);
    process.stdout.write('  npm run gitignore:policy:gate -- --update-baseline\n');
  }
  process.exit(reportOnly ? 0 : 1);
}

if (process.argv[1]?.endsWith('check-gitignore-policy.mjs')) main();
