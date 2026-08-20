/**
 * @fileoverview Regression test for the fresh-capture provenance guard added
 * to `scripts/dev/capture-cross-skill-envelopes.mjs` (audit findings
 * c0f829d9 / 7797ba5b / 3577e131 — near-duplicates of the same defect).
 *
 * The tool's `existing[c.id]` check only protects cases already present in
 * `tests/fixtures/cross-skill-envelopes.json`. If the fixture file itself is
 * missing, EVERY case in `CASES` was previously captured fresh against
 * whatever `scripts/cross-skill.mjs` does TODAY, with no prior fixture to
 * diff against — silently blessing any regression introduced since the last
 * real capture as the new "golden" reference. The fix refuses to run at all
 * in that state unless `--confirm-fresh-capture` is passed explicitly.
 *
 * `FIXTURE_PATH` is normally fixed to this repo's own `tests/fixtures/`
 * location. It accepts `CES_CAPTURE_FIXTURE_PATH_OVERRIDE` for exactly this
 * test — pointing the spawned CLI at a private temp path instead of moving
 * the REAL, git-tracked fixture out of the way. Renaming the real file (even
 * briefly, even with a try/finally restore) would race any other test file
 * that reads it at module-load time in the same `node --test` invocation —
 * tests/cross-skill-golden-envelopes.test.mjs does exactly that, and an
 * earlier version of this test reproduced the crash live (ENOENT on the
 * shared fixture) when run alongside it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CLI = path.join(REPO, 'scripts', 'dev', 'capture-cross-skill-envelopes.mjs');
const REAL_FIXTURE = path.join(REPO, 'tests', 'fixtures', 'cross-skill-envelopes.json');

function run(args, envOverrides = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO, encoding: 'utf-8', timeout: 30_000, env: { ...process.env, ...envOverrides },
  });
}

describe('capture-cross-skill-envelopes.mjs fresh-capture provenance guard', () => {
  it('refuses to run (and creates nothing) when the fixture path does not exist, without --confirm-fresh-capture', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-fixture-guard-'));
    const missingPath = path.join(tmpDir, 'does-not-exist.json');
    try {
      assert.equal(fs.existsSync(missingPath), false, 'precondition: the override path must not exist');
      const res = run([], { CES_CAPTURE_FIXTURE_PATH_OVERRIDE: missingPath });
      assert.notEqual(res.status, 0, `expected a refusal; stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
      assert.match(res.stderr, /does not exist/);
      assert.match(res.stderr, /--confirm-fresh-capture/);
      assert.equal(fs.existsSync(missingPath), false, 'the guard must return BEFORE writing anything');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('positive control: with the REAL fixture present (no override), a bare run is a no-op', () => {
    assert.ok(fs.existsSync(REAL_FIXTURE), 'precondition: the committed fixture must exist');
    const before = fs.readFileSync(REAL_FIXTURE, 'utf-8');
    const res = run([]);
    assert.equal(res.status, 0, `expected success; stderr:\n${res.stderr}`);
    assert.match(res.stderr, /0 new/);
    const after = fs.readFileSync(REAL_FIXTURE, 'utf-8');
    assert.equal(after, before, 'a bare re-run over an intact fixture must be a byte-identical no-op');
  });
});
