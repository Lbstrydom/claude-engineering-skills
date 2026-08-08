import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { assertRepoRoot, _internals } from '../scripts/lib/assert-repo-root.mjs';

const { findExpectedRoot } = _internals;

describe('findExpectedRoot — walks up from script path to find `scripts/` parent', () => {
  it('returns the dir above `scripts/` for a top-level entry script', () => {
    const scriptPath = path.normalize('/repo/scripts/requirements.mjs');
    assert.equal(findExpectedRoot(scriptPath), path.normalize('/repo'));
  });

  it('handles nested scripts (e.g. scripts/lib/foo.mjs)', () => {
    const scriptPath = path.normalize('/repo/scripts/lib/foo.mjs');
    assert.equal(findExpectedRoot(scriptPath), path.normalize('/repo'));
  });

  it('returns null when no `scripts/` ancestor exists', () => {
    const scriptPath = path.normalize('/foo/bar/baz.mjs');
    assert.equal(findExpectedRoot(scriptPath), null);
  });
});

describe('assertRepoRoot — guards cwd', () => {
  function fakeIo() {
    const writes = [];
    const exits = [];
    return {
      stderr: { write: (s) => writes.push(s) },
      exit: (code) => { exits.push(code); },
      writes,
      exits,
    };
  }

  it('passes silently when cwd matches the inferred repo root', () => {
    const io = fakeIo();
    const repoRoot = path.resolve('.');                     // any real dir
    const scriptUrl = pathToFileURL(
      path.join(repoRoot, 'scripts', 'fake-entry.mjs'),
    ).href;

    const origCwd = process.cwd();
    process.chdir(repoRoot);
    try {
      const result = assertRepoRoot(scriptUrl, { stderr: io.stderr, exit: io.exit });
      assert.equal(result.cwd, repoRoot);
      assert.equal(result.root, repoRoot);
      assert.deepEqual(io.writes, []);
      assert.deepEqual(io.exits, []);
    } finally {
      process.chdir(origCwd);
    }
  });

  it('writes actionable error + exits(1) when cwd is wrong', () => {
    const io = fakeIo();
    const repoRoot = path.resolve('.');
    const scriptUrl = pathToFileURL(
      path.join(repoRoot, 'scripts', 'fake-entry.mjs'),
    ).href;

    const origCwd = process.cwd();
    process.chdir(path.dirname(repoRoot));     // one level UP — guaranteed wrong
    try {
      assertRepoRoot(scriptUrl, { stderr: io.stderr, exit: io.exit });
      assert.deepEqual(io.exits, [1]);
      assert.equal(io.writes.length, 1);
      const msg = io.writes[0];
      assert.match(msg, /must be run from the repo root/);
      assert.match(msg, /Current directory:/);
      assert.match(msg, /Expected:/);
      assert.match(msg, /Re-run: cd /);
      assert.match(msg, /scripts\/fake-entry\.mjs/);   // forward-slash in re-run hint
    } finally {
      process.chdir(origCwd);
    }
  });

  it('AUDIT_ALLOW_FOREIGN_CWD=1 bypasses the cwd check (legitimate cross-repo invocation)', () => {
    const io = fakeIo();
    const repoRoot = path.resolve('.');
    const scriptUrl = pathToFileURL(
      path.join(repoRoot, 'scripts', 'fake-entry.mjs'),
    ).href;

    const origCwd = process.cwd();
    process.chdir(path.dirname(repoRoot));     // wrong cwd — would normally exit(1)
    try {
      const result = assertRepoRoot(scriptUrl, {
        stderr: io.stderr,
        exit: io.exit,
        env: { AUDIT_ALLOW_FOREIGN_CWD: '1' },
      });
      assert.deepEqual(io.exits, []);          // did NOT exit
      assert.deepEqual(io.writes, []);         // did NOT warn
      assert.equal(result.root, repoRoot);     // still reports the inferred root
    } finally {
      process.chdir(origCwd);
    }
  });

  it('a falsy AUDIT_ALLOW_FOREIGN_CWD still enforces the cwd check', () => {
    const io = fakeIo();
    const repoRoot = path.resolve('.');
    const scriptUrl = pathToFileURL(
      path.join(repoRoot, 'scripts', 'fake-entry.mjs'),
    ).href;

    const origCwd = process.cwd();
    process.chdir(path.dirname(repoRoot));
    try {
      assertRepoRoot(scriptUrl, {
        stderr: io.stderr,
        exit: io.exit,
        env: { AUDIT_ALLOW_FOREIGN_CWD: '0' },
      });
      assert.deepEqual(io.exits, [1]);
    } finally {
      process.chdir(origCwd);
    }
  });

  it('no-ops when script is not under a `scripts/` directory', () => {
    const io = fakeIo();
    const scriptUrl = pathToFileURL(path.resolve('install.mjs')).href;
    const result = assertRepoRoot(scriptUrl, { stderr: io.stderr, exit: io.exit });
    assert.equal(result.root, '');
    assert.deepEqual(io.writes, []);
    assert.deepEqual(io.exits, []);
  });
});

describe('sameDirectory — one directory, two spellings (2026-08-08 regression)', () => {
  const { sameDirectory } = _internals;

  it('identical strings are equal without touching the filesystem', () => {
    assert.equal(sameDirectory('/nonexistent/a', '/nonexistent/a'), true);
  });

  it('genuinely different directories are NOT equal', () => {
    const a = path.resolve('.');
    const b = path.dirname(a);
    assert.equal(sameDirectory(a, b), false);
  });

  it('resolves two spellings of one REAL directory to equal', () => {
    // The live failure: a worktree reached as `…\C--GIT-…` by cwd and
    // `…\c--GIT-…` by import.meta.url. realpathSync.native returns the true
    // on-disk casing for both, so they collapse. On a case-SENSITIVE fs the
    // two spellings are genuinely different paths, so only assert the
    // invariant that actually holds everywhere: a path equals itself
    // regardless of how it was spelled on the way in.
    const real = path.resolve('.');
    const viaDotSegments = path.join(real, 'scripts', '..');
    assert.equal(sameDirectory(real, viaDotSegments), true,
      'a normalised detour must still name the same directory');
  });

  it('a nonexistent path never throws — realpath failure falls through', () => {
    // The fallback must not crash the guard; an unresolvable path is simply
    // not equal to a real one.
    assert.equal(sameDirectory(path.resolve('.'), '/definitely/not/here/xyz'), false);
  });
});

describe('assertRepoRoot — case-only cwd difference must NOT abort (win32)', () => {
  it('accepts a cwd whose casing differs from the script-derived root', function () {
    if (process.platform !== 'win32') return; // case-insensitivity is the premise
    const writes = [], exits = [];
    const io = { stderr: { write: (s) => writes.push(s) }, exit: (c) => exits.push(c) };
    const repoRoot = path.resolve('.');
    const scriptUrl = pathToFileURL(path.join(repoRoot, 'scripts', 'fake-entry.mjs')).href;

    // Re-spell the drive letter — the same class of difference that made a
    // real push skip the consumer sync while reporting success.
    const reSpelled = repoRoot[0] === repoRoot[0].toUpperCase()
      ? repoRoot[0].toLowerCase() + repoRoot.slice(1)
      : repoRoot[0].toUpperCase() + repoRoot.slice(1);

    const orig = process.cwd();
    try {
      process.chdir(reSpelled);
      assertRepoRoot(scriptUrl, { stderr: io.stderr, exit: io.exit });
      assert.deepEqual(exits, [], `guard aborted on a case-only difference:\n${writes.join('')}`);
    } finally {
      process.chdir(orig);
    }
  });
});
