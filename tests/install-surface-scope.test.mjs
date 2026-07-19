/**
 * @fileoverview `--surface` must gate REPO-scope side effects, not just which
 * skill files get written.
 *
 * Incident (2026-07-19): the source repo's post-merge hook runs
 * `install-skills.mjs --local --surface claude --force` after every `git pull`.
 * That is a GLOBAL-surface run — it writes ~/.claude/skills only — but it also
 * called ensureAuditGitignore(repoRoot) and ensureAuditDeps(repoRoot)
 * unconditionally, so every pull silently appended a consumer-shaped managed
 * block to the SOURCE repo's .gitignore (every pattern already covered by its
 * bare `.audit/` rule) and could shell out to npm install.
 *
 * This is the same shape as the 2026-07-15 bundle-pattern incident, which was
 * patched inside gitignore.mjs by filtering bundle patterns in the source repo.
 * That filter caught the BUNDLE patterns and missed the operational-state ones,
 * because the real defect is one layer up: a global-surface run reaching into
 * repo scope at all. These tests pin the layer that actually decides it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/install-skills.mjs'),
  'utf8',
);

describe('install-skills / --surface gates repo-scope side effects', () => {
  test('authoritativeScopesFor maps claude->global-only and copilot/agents->repo', () => {
    // Pinned as source assertions: this mapping is the single predicate both the
    // delete-pruner and the repo-scope maintenance block consult. If it changes,
    // both consumers must be re-reasoned, not silently inherited.
    assert.match(SRC, /if \(surface === 'claude'\) return new Set\(\['global'\]\)/,
      'claude surface must be authoritative over the global scope only');
    assert.match(SRC, /if \(surface === 'copilot' \|\| surface === 'agents'\) return new Set\(\['repo'\]\)/);
  });

  test('ensureAuditGitignore and ensureAuditDeps are BOTH inside a repo-scope guard', () => {
    // Locate the guard and assert both repo-mutating calls live within it. A
    // future edit that moves either call back out to top level fails here.
    const guard = /authoritativeScopesFor\(args\.surface\);\s*\n\s*if \([\s\S]{0,120}?\.has\('repo'\)\) \{([\s\S]*?)\n {2}\}/.exec(SRC);
    assert.ok(guard, 'expected a repo-scope guard derived from authoritativeScopesFor(args.surface)');
    const body = guard[1];
    assert.match(body, /ensureAuditGitignore\(repoRoot/, 'gitignore write must be repo-scope gated');
    assert.match(body, /ensureAuditDeps\(repoRoot/, 'dependency install must be repo-scope gated');
  });

  test('neither repo-mutating call appears ungated anywhere else', () => {
    // The guard above is worthless if a second, ungated call site exists.
    // Exactly one call each, and the guard test above proved where it is.
    const gitignoreCalls = SRC.match(/ensureAuditGitignore\(repoRoot/g) ?? [];
    const depsCalls = SRC.match(/ensureAuditDeps\(repoRoot/g) ?? [];
    assert.equal(gitignoreCalls.length, 1, 'exactly one ensureAuditGitignore call site');
    assert.equal(depsCalls.length, 1, 'exactly one ensureAuditDeps call site');
  });

  test('the global-only contract is still stated in the module docs', () => {
    // The fix aligns code with a contract the module already documented. If the
    // sentence goes, the guard loses its stated justification.
    assert.match(SRC, /`--surface claude` writes only global files/);
  });
});
