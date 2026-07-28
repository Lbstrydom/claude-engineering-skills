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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'install-skills.mjs');
const execFileAsync = promisify(execFile);

const SRC = fs.readFileSync(CLI, 'utf8');

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

// docs/plans/refactor-skill-governance.md round-1 audit H1 — the parseArgs
// switch has no default/unknown-flag case, so bare-deleting the
// --keep-github-skills arm would make it SILENTLY ignored, not rejected.
describe('install-skills / --keep-github-skills is rejected, not silently ignored (round-1 audit H1)', () => {
  test('the source carries an explicit exit-2 case, not a bare removal', () => {
    const arm = /case '--keep-github-skills':([\s\S]*?)break;/.exec(SRC);
    assert.ok(arm, 'expected a case arm for --keep-github-skills');
    assert.match(arm[1], /process\.exit\(2\)/, 'must exit 2, not silently fall through');
  });

  test('the --surface copilot rejection path (round-3 Gemini shadow finding #1)', () => {
    // install-skills.mjs does not call resolveSkillTargets directly — it calls
    // resolveSkillFiles, which delegates straight through with no swallowing.
    // Pin that the real call site is used, not a function this file never calls.
    assert.match(SRC, /resolveSkillFiles\(skillName, args\.surface, repoRoot, files\)/);
    assert.doesNotMatch(SRC, /\bresolveSkillTargets\(/, 'this file must not call resolveSkillTargets directly');
  });

  // Functional (round-3 M3): the source-pattern tests above prove the code
  // exists, not that it actually runs and exits with the promised code — spawn
  // the real CLI, same execFileAsync pattern
  // tests/db-test-container.integration.test.mjs already uses for CLI smoke
  // coverage.
  test('--keep-github-skills exits 2 with a diagnostic (functional)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-skills-'));
    try {
      await assert.rejects(
        execFileAsync(process.execPath, [CLI, '--local', '--target', tmp, '--keep-github-skills'], { cwd: REPO_ROOT }),
        (err) => {
          assert.equal(err.code, 2);
          assert.match(err.stderr, /--keep-github-skills was removed/);
          return true;
        },
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  test('--surface copilot exits 1 with the retired-surface message (functional)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-skills-'));
    try {
      await assert.rejects(
        execFileAsync(process.execPath, [CLI, '--local', '--target', tmp, '--surface', 'copilot', '--force'], { cwd: REPO_ROOT }),
        (err) => {
          assert.equal(err.code, 1);
          assert.match(err.stderr, /retired 2026-07-28/);
          return true;
        },
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
