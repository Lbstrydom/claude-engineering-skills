/**
 * ensureAuditGitignore / checkAuditGitignore — repo-aware pattern seam.
 *
 * Pins the 2026-07-15 incident fix: the source repo's own post-merge git
 * hook (installed by setup.mjs) runs `install-skills.mjs --local ...
 * 2>/dev/null` after every `git pull`, whose main() calls
 * `ensureAuditGitignore(repoRoot)` with repoRoot = the SOURCE repo — which
 * silently appended the consumer-only BUNDLE block (`.claude/skills/`,
 * `scripts/openai-audit.mjs`, ~20 more core source files) into the source
 * repo's .gitignore, directly violating AGENTS.md's Category-B policy
 * (`.claude/skills/**` is committed + freshness-verified). The fix filters
 * bundle patterns at the shared `requiredPatternsFor` seam, so EVERY caller
 * (install.mjs bootstrap, install-skills --local, check-skill-updates --fix,
 * the post-merge hook, future callers) inherits the guard.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ensureAuditGitignore,
  checkAuditGitignore,
  requiredPatternsFor,
} from '../../scripts/lib/install/gitignore.mjs';

/** A pattern from each category, for spot assertions. */
const OPERATIONAL_SAMPLE = '.audit/local/';
const BUNDLE_SAMPLES = ['.claude/skills/', 'scripts/openai-audit.mjs', 'scripts/gemini-review.mjs', 'scripts/lib/'];

let tmpRoot;

function mkRepo(pkgName) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'repo-'));
  if (pkgName !== undefined) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkgName }), 'utf-8');
  }
  return dir;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gitignore-seam-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('requiredPatternsFor — the repo-aware seam', () => {
  it('consumer repo: bundle patterns included, nothing skipped', () => {
    const repo = mkRepo('wine-cellar-app');
    const { patterns, bundleSkipped } = requiredPatternsFor(repo);
    for (const p of BUNDLE_SAMPLES) assert.ok(patterns.includes(p), `expected bundle pattern ${p}`);
    assert.ok(patterns.includes(OPERATIONAL_SAMPLE));
    assert.deepEqual(bundleSkipped, []);
  });

  it('SOURCE repo: bundle patterns excluded and reported as skipped', () => {
    const repo = mkRepo('claude-engineering-skills');
    const { patterns, bundleSkipped } = requiredPatternsFor(repo);
    for (const p of BUNDLE_SAMPLES) {
      assert.ok(!patterns.includes(p), `bundle pattern ${p} must never apply to the source repo`);
      assert.ok(bundleSkipped.includes(p), `${p} must be reported as skipped`);
    }
    assert.ok(patterns.includes(OPERATIONAL_SAMPLE), 'operational patterns still apply to the source repo');
  });

  it('no package.json (tarball/scratch edge) degrades to CONSUMER semantics — never strips protection from a real consumer', () => {
    const repo = mkRepo(undefined);
    const { patterns, bundleSkipped } = requiredPatternsFor(repo);
    assert.ok(patterns.includes(BUNDLE_SAMPLES[0]));
    assert.deepEqual(bundleSkipped, []);
  });
});

describe('ensureAuditGitignore — the incident regression', () => {
  it('consumer repo: writes bundle + operational patterns (pre-fix behaviour preserved)', () => {
    const repo = mkRepo('some-consumer');
    const result = ensureAuditGitignore(repo, { quiet: true });
    const gi = fs.readFileSync(path.join(repo, '.gitignore'), 'utf-8');
    for (const p of BUNDLE_SAMPLES) assert.ok(gi.includes(p), `consumer .gitignore must gain ${p}`);
    assert.ok(gi.includes(OPERATIONAL_SAMPLE));
    assert.equal(result.created, true);
    assert.deepEqual(result.bundleSkipped, []);
  });

  it('SOURCE repo: never writes a single bundle pattern (the exact post-merge-hook incident)', () => {
    const repo = mkRepo('claude-engineering-skills');
    // Reproduce the incident's preconditions: operational patterns already
    // hand-maintained (as in the real source .gitignore), bundle absent.
    const { patterns } = requiredPatternsFor(repo);
    fs.writeFileSync(path.join(repo, '.gitignore'), patterns.join('\n') + '\n', 'utf-8');

    const result = ensureAuditGitignore(repo, { quiet: true });
    const gi = fs.readFileSync(path.join(repo, '.gitignore'), 'utf-8');
    for (const p of BUNDLE_SAMPLES) {
      assert.ok(!gi.includes(p), `source .gitignore must NOT gain ${p}`);
    }
    // The incident wrote a whole header block; with the fix, nothing at all changes.
    assert.deepEqual(result.added, [], 'a fully-covered source repo must see zero writes');
    assert.ok(result.bundleSkipped.length > 0);
  });

  it('SOURCE repo with a missing operational pattern: adds ONLY that pattern, still no bundle block', () => {
    const repo = mkRepo('claude-engineering-skills');
    const { patterns } = requiredPatternsFor(repo);
    const withoutOne = patterns.filter((p) => p !== OPERATIONAL_SAMPLE);
    fs.writeFileSync(path.join(repo, '.gitignore'), withoutOne.join('\n') + '\n', 'utf-8');

    const result = ensureAuditGitignore(repo, { quiet: true });
    assert.deepEqual(result.added, [OPERATIONAL_SAMPLE]);
    const gi = fs.readFileSync(path.join(repo, '.gitignore'), 'utf-8');
    for (const p of BUNDLE_SAMPLES) assert.ok(!gi.includes(p));
  });

  it('is idempotent — a second call adds nothing (both repo kinds)', () => {
    for (const name of ['some-consumer', 'claude-engineering-skills']) {
      const repo = mkRepo(name);
      ensureAuditGitignore(repo, { quiet: true });
      const second = ensureAuditGitignore(repo, { quiet: true });
      assert.deepEqual(second.added, [], `${name}: second run must be a no-op`);
    }
  });
});

describe('checkAuditGitignore — shares the same seam (the --fix convergence property)', () => {
  it('SOURCE repo: bundle patterns are never reported missing, so check-skill-updates --fix converges', () => {
    const repo = mkRepo('claude-engineering-skills');
    ensureAuditGitignore(repo, { quiet: true });
    const check = checkAuditGitignore(repo);
    assert.deepEqual(check.missing, [],
      'after ensure, check must agree the source repo is complete — a bundle pattern in `missing` here means the writer and checker use different pattern sets');
  });

  it('consumer repo: check/ensure agree too', () => {
    const repo = mkRepo('some-consumer');
    ensureAuditGitignore(repo, { quiet: true });
    assert.deepEqual(checkAuditGitignore(repo).missing, []);
  });
});
