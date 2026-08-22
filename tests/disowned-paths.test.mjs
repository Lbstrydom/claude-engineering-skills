/**
 * @fileoverview `ignoredUntrackedPaths` (consumer-friction-doctor plan D4) —
 * extracted out of `lib/claudemd/file-scanner.mjs` so it and the doctor's
 * probes share one oracle. Regression-locks the 2026-08-11 fix (upstream
 * 5b67666e): a vendored, gitignored instruction file must be excluded from a
 * context-drift scan, and — the actual defect — the exclusion must be
 * computed from the CANDIDATE list, never the whole repo (ENOBUFS past
 * spawnSync's 1 MiB maxBuffer under node_modules).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { ignoredUntrackedPaths } from '../scripts/lib/disowned-paths.mjs';

let repo;

function git(args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
}

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'disowned-paths-'));
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);

  fs.writeFileSync(path.join(repo, '.gitignore'), 'vendor/\n');
  fs.mkdirSync(path.join(repo, 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'vendor', 'CLAUDE.md'), 'AGENTS.md');
  fs.writeFileSync(path.join(repo, 'OWNED.md'), '# owned');
  fs.writeFileSync(path.join(repo, 'TRACKED_UNDER_PATTERN.md'), '# tracked but matches a pattern');

  git(['add', '.gitignore', 'OWNED.md']);
  // Force-add a file that matches an ignore pattern deliberately — proves
  // "ignored" alone (without "untracked") would wrongly exclude a real,
  // committed file.
  fs.writeFileSync(path.join(repo, 'vendor', 'TRACKED.md'), 'tracked despite the pattern');
  git(['add', '-f', 'vendor/TRACKED.md']);
  git(['commit', '-q', '-m', 'initial']);
});

after(() => {
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('ignoredUntrackedPaths', () => {
  it('excludes an ignored, untracked file; degraded:false on a real, successful scan', () => {
    const r = ignoredUntrackedPaths(repo, ['vendor/CLAUDE.md', 'OWNED.md']);
    assert.ok(r.paths.has('vendor/CLAUDE.md'));
    assert.ok(!r.paths.has('OWNED.md'));
    assert.equal(r.degraded, false);
    assert.equal(r.warning, null);
  });

  it('does NOT exclude a TRACKED file even when it matches an ignore pattern', () => {
    // `git check-ignore` WITHOUT `--no-index` (verified empirically, round-2
    // audit M7) already excludes tracked paths from its own output — it does
    // NOT report a match here. This test still locks the observable
    // contract (a tracked, force-added file is never treated as disowned),
    // regardless of which git behaviour makes that true.
    const r = ignoredUntrackedPaths(repo, ['vendor/TRACKED.md']);
    assert.ok(!r.paths.has('vendor/TRACKED.md'));
  });

  it('returns an empty, non-degraded result for an empty candidate list (no git call needed)', () => {
    const r = ignoredUntrackedPaths(repo, []);
    assert.deepEqual(r.paths, new Set());
    assert.equal(r.degraded, false);
  });

  it('a SMALL candidate list is unaffected by an unrelated large node_modules tree nearby', () => {
    // A companion to the real stress test below: proves the function's
    // answer for a small, targeted candidate list doesn't change just
    // because a large, IRRELEVANT tree happens to exist in the repo. This
    // does not by itself exercise the stdin/maxBuffer bound — see the next
    // test for that (round-1 audit L1: an earlier version of this test
    // claimed to prove the ENOBUFS fix with only 500 small files and no
    // .gitignore entry for node_modules, so `git check-ignore` never even
    // matched them — the claim outran what was actually exercised).
    const big = path.join(repo, 'node_modules');
    fs.mkdirSync(big, { recursive: true });
    for (let i = 0; i < 50; i++) {
      fs.writeFileSync(path.join(big, `pkg-${i}.js`), '// noise');
    }
    try {
      const r = ignoredUntrackedPaths(repo, ['vendor/CLAUDE.md', 'OWNED.md']);
      assert.ok(r.paths.has('vendor/CLAUDE.md'));
      assert.ok(!r.paths.has('OWNED.md'));
    } finally {
      fs.rmSync(big, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a large STDIN candidate list still resolves correctly (does not exercise the historical bug — see next test)', () => {
    // The historical 2026-08-11 defect (docstring above) was an unbounded
    // OUTPUT: `git ls-files --others --ignored` with no path filter, blowing
    // past spawnSync's 1 MiB default maxBuffer on STDOUT. This test instead
    // sends a large INPUT (20,000 mostly-non-matching candidates on stdin) —
    // a different dimension that the historical bug was never about (round-2
    // audit M19: an earlier version of this docstring conflated the two).
    // Kept because it's still a real property worth proving — a large
    // candidate list must not itself degrade to the fail-open empty set —
    // just not mislabelled as reproducing the original failure mode.
    const candidates = [];
    for (let i = 0; i < 20_000; i++) {
      candidates.push(`some/nonexistent/deeply/nested/path/number-${i}.md`);
    }
    candidates.push('vendor/CLAUDE.md', 'OWNED.md');
    const r = ignoredUntrackedPaths(repo, candidates);
    assert.ok(r.paths.has('vendor/CLAUDE.md'));
    assert.ok(!r.paths.has('OWNED.md'));
    assert.equal(r.degraded, false);
    // None of the synthetic paths exist or are ignored — proves the large
    // stdin payload didn't silently degrade to the empty-set fail-open path.
    assert.equal([...r.paths].filter((p) => p.startsWith('some/')).length, 0);
  });

  it('a large STDOUT (many genuine matches) does not overflow the buffer or fail open (closes round-2 audit M19)', () => {
    // THE actual historical shape: many candidates that ALL match check-ignore
    // produce a large OUTPUT — this is what the pre-2026-08-11 unscoped query
    // overflowed on. Create enough real ignored+untracked files that echoing
    // all of them back through `check-ignore -z --stdin` exceeds a token
    // amount of output, and confirm the exclusion still applies correctly
    // rather than silently degrading to "treat everything as owned".
    const dir = path.join(repo, 'vendor', 'many');
    fs.mkdirSync(dir, { recursive: true });
    const candidates = [];
    for (let i = 0; i < 20_000; i++) {
      // Padded to a fixed-width 6-digit number under a longer directory name
      // (round-4 audit L1): 20,000 short paths of ~25 bytes summed to ~0.5 MB
      // — BELOW Node's default 1 MiB execFileSync/spawnSync maxBuffer, so the
      // test approached the boundary without crossing it. This shape pushes
      // each entry to ~60 bytes, comfortably exceeding 1 MiB with margin, and
      // the assertion below makes that margin explicit rather than assumed.
      const rel = `vendor/many/deeply-nested-synthetic-fixture-file-number-${String(i).padStart(6, '0')}.md`;
      fs.writeFileSync(path.join(repo, rel), 'noise');
      candidates.push(rel);
    }
    candidates.push('OWNED.md');
    const stdoutBytes = candidates.reduce((sum, p) => sum + Buffer.byteLength(p, 'utf-8') + 1, 0); // +1 per NUL separator
    assert.ok(
      stdoutBytes > 1024 * 1024,
      `fixture must exceed the 1 MiB default maxBuffer to actually test the boundary — got ${stdoutBytes} bytes`,
    );
    try {
      const r = ignoredUntrackedPaths(repo, candidates);
      assert.equal(r.paths.size, candidates.length - 1); // every vendor/many/* file, not OWNED.md
      assert.ok(!r.paths.has('OWNED.md'));
      assert.equal(r.degraded, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('normalises backslash-style candidate paths to POSIX before comparing', () => {
    const r = ignoredUntrackedPaths(repo, ['vendor\\CLAUDE.md']);
    assert.ok(r.paths.has('vendor/CLAUDE.md'));
  });

  it('degrades to an empty, DEGRADED result outside a git work tree, with a stderr warning (closes round-3 audit M20)', () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
    try {
      let warned = '';
      const origWrite = process.stderr.write;
      process.stderr.write = (chunk) => { warned += chunk; return true; };
      let result;
      try {
        result = ignoredUntrackedPaths(notARepo, ['anything.md']);
      } finally {
        process.stderr.write = origWrite;
      }
      assert.deepEqual(result.paths, new Set());
      // The load-bearing distinction (round-3 audit M20): an empty `paths`
      // set alone is indistinguishable between "verified clean" and
      // "unverified" — `degraded`/`warning` are what let a caller tell them
      // apart, rather than a bare Set that always reads as "verified clean".
      assert.equal(result.degraded, true);
      assert.match(result.warning, /WARN/);
      assert.match(warned, /WARN/);
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
