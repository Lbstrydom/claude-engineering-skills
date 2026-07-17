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
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
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

describe('WAL Category-A artifacts are gitignored (install-transaction-wal-hardening)', () => {
  // Both artifacts are derived from crash state and volatile — Category A under
  // AGENTS.md's generated-artifact policy, so they must never reach a
  // consumer's `git status`, let alone a commit.
  it('the transaction LOCK file is covered (it sits at the repo root, outside .audit/)', () => {
    const repo = mkRepo('some-consumer');
    const { patterns } = requiredPatternsFor(repo);
    assert.ok(
      patterns.includes('.audit-loop-install-txn.json.lock'),
      'the lock lives beside the journal at the repo ROOT, so `.audit/**/*.lock` does not match it; '
      + 'without an explicit pattern every install dirties the working tree and a crashed install leaves it forever',
    );
  });

  it('the quarantine directory is covered by the pre-existing .audit/quarantine/ pattern', () => {
    const repo = mkRepo('some-consumer');
    const { patterns } = requiredPatternsFor(repo);
    assert.ok(
      patterns.includes('.audit/quarantine/'),
      'quarantined journals are written to <repoRoot>/.audit/quarantine/ — reusing this existing '
      + 'pattern is why the WAL hardening needed no new ignore entry for them',
    );
  });
});

describe('pattern presence is LINE-based, not substring (code-audit H2)', () => {
  // Adding `.audit-loop-install-txn.json.lock` made it the ONLY strict
  // superstring in the pattern set. Under the old `gi.includes(pattern)` check
  // its mere presence reported the shorter `.audit-loop-install-txn.json` as
  // already-ignored — leaving the journal (which records absolute paths of
  // every file an install touches) committable.
  it('a longer pattern does NOT shadow the shorter one it contains', () => {
    const repo = mkRepo('some-consumer');
    fs.writeFileSync(path.join(repo, '.gitignore'), '.audit-loop-install-txn.json.lock\n');

    const check = checkAuditGitignore(repo);

    assert.ok(
      check.missing.includes('.audit-loop-install-txn.json'),
      'the journal pattern is absent and MUST be reported missing — a substring match would call it present',
    );
    assert.ok(check.present.includes('.audit-loop-install-txn.json.lock'), 'the lock pattern really is present');
  });

  it('ensure ADDS the shadowed pattern rather than skipping it', () => {
    const repo = mkRepo('some-consumer');
    fs.writeFileSync(path.join(repo, '.gitignore'), '.audit-loop-install-txn.json.lock\n');
    const { added } = ensureAuditGitignore(repo, { quiet: true });
    assert.ok(added.includes('.audit-loop-install-txn.json'));
    assert.deepEqual(checkAuditGitignore(repo).missing, [], 'ensure must converge to complete');
  });

  it('a COMMENTED-OUT pattern does not count as present', () => {
    const repo = mkRepo('some-consumer');
    fs.writeFileSync(path.join(repo, '.gitignore'), '# .audit/local/ (disabled)\n');
    assert.ok(checkAuditGitignore(repo).missing.includes('.audit/local/'));
  });

  it('no pattern in the set strictly contains another (keeps the seam honest)', () => {
    // A defence in depth for the check above: if a future pattern reintroduces
    // a superstring relationship, line-matching still handles it — but this
    // makes the hazard visible at review time rather than in a consumer's repo.
    const { patterns } = requiredPatternsFor(mkRepo('some-consumer'));
    const collisions = [];
    for (const a of patterns) for (const b of patterns) if (a !== b && a.includes(b)) collisions.push(`${a} shadows ${b}`);
    assert.deepEqual(
      collisions, ['.audit-loop-install-txn.json.lock shadows .audit-loop-install-txn.json'],
      'the ONLY known superstring pair is the journal/lock one, which hasPattern() handles; a new entry here needs review',
    );
  });
});

describe('leading whitespace is significant to Git (code-audit R3-H2)', () => {
  it('an INDENTED rule does not count as present — it does not actually ignore', () => {
    // Verified with `git check-ignore`: a .gitignore line ' .env' matches a file
    // literally named " .env" and leaves `.env` UNIGNORED. Reporting it present
    // would skip adding the real rule — on the secret-protection path.
    const repo = mkRepo('some-consumer');
    fs.writeFileSync(path.join(repo, '.gitignore'), ' .env\n');
    assert.ok(
      checkAuditGitignore(repo).missing.includes('.env'),
      'an indented .env rule does not ignore .env, so the real rule is still missing',
    );
  });

  it('TRAILING whitespace does not block a match — Git strips it', () => {
    const repo = mkRepo('some-consumer');
    fs.writeFileSync(path.join(repo, '.gitignore'), '.env   \n');
    assert.ok(checkAuditGitignore(repo).present.includes('.env'), 'a trailing-space rule is effective, so it counts');
  });
});
