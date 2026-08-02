#!/usr/bin/env node
/**
 * @fileoverview Drift detector for docs/architecture-intent.md's `## Domains`
 * section vs `.audit-loop/domain-map.json`'s declared domain set.
 *
 * Follows this repo's own established "keep committed doc X in sync with
 * source-of-truth Y" pattern (scripts/check-context-drift.mjs for
 * AGENTS.md/CLAUDE.md; scripts/generate-plans-index.mjs --check for the
 * plans index).
 *
 * Scope: domain-NAME presence only. A domain declared in domain-map.json's
 * `rules` but not documented as a `### \`<domain>\`` heading inside the doc's
 * `## Domains` section is drift. The reverse is never flagged — the doc may
 * legitimately retain historical/retired domains as rationale.
 *
 * Plan: docs/plans/refactor-architecture-debt-remainder-2026-07.md item 3.
 *
 * Exit codes:
 *   0  No missing domains
 *   1  One or more domain-map domains are undocumented
 *
 * @module scripts/check-architecture-intent-drift
 */
import fs from 'node:fs';
import path from 'node:path';
import { makeFenceTracker } from './lib/markdown-fence-tracker.mjs';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';

const DEFAULT_DOMAIN_MAP = '.audit-loop/domain-map.json';
const DEFAULT_DOC = 'docs/architecture-intent.md';

/**
 * Every distinct domain name declared across domain-map.json's `rules`.
 * @param {string} domainMapJson - raw file contents
 * @returns {Set<string>}
 */
export function extractDomainMapDomains(domainMapJson) {
  const parsed = JSON.parse(domainMapJson);
  const rules = Array.isArray(parsed?.rules) ? parsed.rules : [];
  return new Set(rules.map((r) => r.domain).filter((d) => typeof d === 'string' && d.length > 0));
}

/**
 * Every `### \`<domain>\`` heading found strictly within the doc's
 * `## Domains` section — scoped between that heading and the next `## `
 * heading (or end of file). A domain name appearing outside that span
 * (e.g. in `## Boundary rationale`) does NOT count.
 * @param {string} docMarkdown
 * @returns {Set<string>}
 */
export function extractDocDomains(docMarkdown) {
  const lines = docMarkdown.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Domains\s*$/.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return new Set();

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }

  const domains = new Set();
  // A `### ` heading may name multiple comma/`, ` separated domains on one
  // line (this doc groups small sibling domains that way) — capture every
  // backtick-quoted name on the heading line, not just the first. Matches
  // any non-empty backtick content (not just [a-z0-9-]+) so this side's
  // acceptance is never STRICTER than the domain-map side's (which accepts
  // any non-empty string as a domain identifier) — a mismatch there would
  // make a correctly-documented but unusually-named domain permanently
  // report as "missing".
  const headingRe = /^###\s+(.+)$/;
  const nameRe = /`([^`]+)`/g;
  // Fence tracking (CommonMark same-char, len >= open-len closing rule) is
  // shared with check-context-drift.mjs via lib/markdown-fence-tracker.mjs —
  // this script hand-derived the identical logic across three audit rounds
  // before converging on what that module already had; now there is one
  // implementation, not two that can drift apart (Gemini shadow finding).
  const isFenced = makeFenceTracker();
  for (let i = start + 1; i < end; i++) {
    // A `### ...` line inside a fenced code block (e.g. a Mermaid diagram
    // subgraph label) is not a real Markdown heading — skip heading
    // detection entirely while fenced, so it can't be mistaken for one.
    if (isFenced(lines[i])) continue;
    const m = headingRe.exec(lines[i]);
    if (!m) continue;
    let nm;
    while ((nm = nameRe.exec(m[1])) !== null) {
      domains.add(nm[1]);
    }
  }
  return domains;
}

/**
 * Compare the two sets. Only map-domains missing from the doc are drift.
 * @param {Set<string>} mapDomains
 * @param {Set<string>} docDomains
 * @returns {{missing: string[]}}
 */
export function compareDomainSets(mapDomains, docDomains) {
  const missing = [...mapDomains].filter((d) => !docDomains.has(d)).sort();
  return { missing };
}

/**
 * Run the full check against a repo root. Exposed for testing.
 * @param {string} repoRoot
 * @param {{domainMapPath?: string, docPath?: string}} [opts]
 * @returns {{missing: string[], mapDomainCount: number, docDomainCount: number}}
 */
export function runArchitectureIntentDriftCheck(repoRoot, opts = {}) {
  const domainMapPath = path.resolve(repoRoot, opts.domainMapPath || DEFAULT_DOMAIN_MAP);
  const docPath = path.resolve(repoRoot, opts.docPath || DEFAULT_DOC);

  const domainMapJson = fs.readFileSync(domainMapPath, 'utf-8');
  const mapDomains = extractDomainMapDomains(domainMapJson);

  // A missing doc file is the same drift signal as a missing section —
  // fail loud (every map domain reports missing) rather than crash or
  // silently pass.
  const docMarkdown = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf-8') : '';
  const docDomains = extractDocDomains(docMarkdown);

  const { missing } = compareDomainSets(mapDomains, docDomains);
  return { missing, mapDomainCount: mapDomains.size, docDomainCount: docDomains.size };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const KNOWN_FLAGS = ['--repo', '--help', '-h'];

function parseArgs(argv) {
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'check-architecture-intent-drift' });
  const args = { repo: '.' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') {
      const v = argv[++i];
      if (!v) throw new ArgvError('--repo requires a value');
      args.repo = v;
    } else if (a === '--help' || a === '-h') { showHelp(); process.exit(0); }
  }
  return args;
}

function showHelp() {
  process.stdout.write(`Usage: node scripts/check-architecture-intent-drift.mjs [options]

Fails if .audit-loop/domain-map.json declares a domain not documented as a
### \`<domain>\` heading inside docs/architecture-intent.md's ## Domains
section. Never flags the reverse (an extra/retired doc entry).

Options:
  --repo <path>   Repo root (default: cwd)
  -h, --help      Show this help
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(args.repo);
  const { missing, mapDomainCount, docDomainCount } = runArchitectureIntentDriftCheck(repoRoot);

  if (missing.length === 0) {
    process.stdout.write(`OK  docs/architecture-intent.md documents all ${mapDomainCount} domain-map domains (doc has ${docDomainCount}).\n`);
    process.exit(0);
  }

  // Diagnostics to STDERR, the OK line to stdout. Two reasons, both
  // load-bearing: this repo's convention keeps stdout clean for machine output
  // (AGENTS.md Code Style), and this gate's poison pill asserts on stderr —
  // because a non-zero exit alone cannot distinguish "detected the drift" from
  // "crashed before reading anything". A FAIL written to stdout is unassertable
  // by that pill, so this is what makes the gate's own honesty checkable.
  process.stderr.write(`FAIL  ${missing.length} domain-map domain(s) undocumented in docs/architecture-intent.md's ## Domains section:\n`);
  for (const d of missing) process.stderr.write(`  missing: ${d}\n`);
  process.exit(1);
}

// Run only when invoked as a script (Windows-safe — match by basename).
const invokedDirectly = (() => {
  try {
    const metaPath = new URL(import.meta.url).pathname.toLowerCase();
    const argvPath = process.argv[1] ? new URL(`file://${process.argv[1].replaceAll(/\\/g, '/')}`).pathname.toLowerCase() : '';
    return metaPath.endsWith('/check-architecture-intent-drift.mjs') && argvPath.endsWith('/check-architecture-intent-drift.mjs');
  } catch { return false; }
})();

if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    // A usage mistake is not a crash: print the diagnostic alone, no stack.
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`Error: ${err.message}\n${err.stack}\n`);
    process.exit(99);
  }
}
