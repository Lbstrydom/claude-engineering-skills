#!/usr/bin/env node
/**
 * @fileoverview CLI lint for `docs/` root placement discipline.
 *
 * `docs/` root is reserved for generated artefacts + live ledgers — files a
 * tool writes or reads by hardcoded path. Every hand-written doc belongs in a
 * bucket (`reference/`, `runbooks/`, `plans/`, `research/`, …). See
 * `docs/README.md` for the decision rule.
 *
 * Why this exists: the prose version of the rule already existed in
 * docs/README.md and still drifted — root accumulated 23 files against a table
 * documenting 8, because "long-lived reference → root" reads as a catch-all.
 * This lint makes root closed rather than open: a new root file fails until
 * someone either moves it to a bucket or consciously allowlists it.
 *
 * Deliberately narrow: it checks WHERE files sit, not whether a doc is
 * "reference" vs "runbook" — that judgement isn't mechanical, and a lint that
 * guesses it would be noise. Directories are not checked; adding a bucket is a
 * legitimate act (documented in docs/README.md).
 *
 * Usage:
 *   node scripts/check-docs-placement.mjs            # human output
 *   node scripts/check-docs-placement.mjs --format json
 *
 * Exit codes:
 *   0 = docs/ root is clean
 *   1 = unexpected file(s) at docs/ root
 *   2 = docs/ missing / bad CLI input
 *
 * @module scripts/check-docs-placement
 */
import fs from 'node:fs';
import path from 'node:path';

const DOCS_DIR = path.resolve('docs');

/**
 * Files permitted at `docs/` root. Add an entry ONLY for a new generated or
 * tool-owned artefact — never to park a hand-written doc. Each entry names the
 * tool that owns it, so a stale allowlist is self-evident on read.
 */
const ROOT_ALLOWLIST = new Map([
  ['README.md', 'hand-written — the docs index itself'],
  ['SKILLS-INDEX.md', 'generated — npm run skills:index'],
  ['architecture-map.md', 'generated — npm run arch:render'],
  ['architecture-intent.md', 'generated — from architecture-intent.template.md'],
  ['architecture-intent.template.md', 'hand-written — starter a consumer copies; lives beside its output'],
  ['requirements-map.md', 'generated — rendered from .requirements/ledger.json'],
  ['security-strategy.md', 'live ledger — read by npm run security:refresh'],
]);

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';

const HINT = [
  ['docs/reference/', 'a contract or spec something enforces'],
  ['docs/runbooks/', 'how to operate a subsystem'],
  ['docs/plans/', 'a unit of work with a Status: line'],
  ['docs/research/', 'part of the audit-effectiveness research arc'],
  ['docs/personal/', 'not project documentation'],
];

function main() {
  const jsonOut = process.argv.includes('--format') &&
    process.argv[process.argv.indexOf('--format') + 1] === 'json';

  if (!fs.existsSync(DOCS_DIR)) {
    if (jsonOut) console.log(JSON.stringify({ ok: false, error: 'docs/ not found' }));
    else console.error(`${R}docs/ not found${X}`);
    process.exit(2);
  }

  const rootFiles = fs.readdirSync(DOCS_DIR, { withFileTypes: true })
    .filter(d => d.isFile())
    .map(d => d.name)
    .sort();

  const unexpected = rootFiles.filter(f => !ROOT_ALLOWLIST.has(f));
  // An allowlisted file that no longer exists is stale bookkeeping, not a failure.
  const stale = [...ROOT_ALLOWLIST.keys()].filter(f => !rootFiles.includes(f));

  if (jsonOut) {
    console.log(JSON.stringify({
      ok: unexpected.length === 0,
      checked: rootFiles.length,
      unexpected,
      staleAllowlistEntries: stale,
    }, null, 2));
    process.exit(unexpected.length > 0 ? 1 : 0);
  }

  if (stale.length) {
    console.log(`${Y}note${X} allowlisted but absent (stale entry?): ${stale.join(', ')}`);
  }

  if (unexpected.length === 0) {
    console.log(`${G}✓${X} docs/ root clean — ${rootFiles.length} file(s), all allowlisted`);
    process.exit(0);
  }

  console.error(`\n${R}${B}✗ ctx/docs-root-placement${X} — ${unexpected.length} unexpected file(s) at docs/ root\n`);
  for (const f of unexpected) console.error(`  ${R}docs/${f}${X}`);
  console.error(`\n${B}docs/ root is reserved${X} for generated artefacts + live ledgers.`);
  console.error('Move hand-written docs into a bucket:\n');
  for (const [dir, why] of HINT) console.error(`  ${B}${dir}${X}${D} — ${why}${X}`);
  console.error(`\nFull decision rule: ${B}docs/README.md${X}`);
  console.error(`${D}If this really is a new generated/tool-owned artefact, add it to`);
  console.error(`ROOT_ALLOWLIST in scripts/check-docs-placement.mjs with the tool that owns it.${X}\n`);
  process.exit(1);
}

main();
