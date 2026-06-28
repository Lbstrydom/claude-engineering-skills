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
