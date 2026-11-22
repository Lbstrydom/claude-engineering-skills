// docs:check (scripts/check-docs-placement.mjs) must be able to FAIL: a stray hand-written file at docs/ root is red,
// an allowlisted-only root is green. Found vacuous-by-census 2026-11-22: no test exercised a violation.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-docs-placement.mjs');

function run(files) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-placement-'));
  try {
    fs.mkdirSync(path.join(cwd, 'docs'));
    for (const f of files) fs.writeFileSync(path.join(cwd, 'docs', f), '# x\n');
    const r = spawnSync(process.execPath, [SCRIPT, '--format', 'json'], { cwd, encoding: 'utf8' });
    return { status: r.status, out: r.stdout ? JSON.parse(r.stdout) : null };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

describe('docs:check placement gate', () => {
  it('control: an allowlisted-only docs/ root passes and reports what it checked', () => {
    const r = run(['README.md', 'architecture-map.md']);
    assert.equal(r.status, 0);
    assert.equal(r.out.ok, true);
    assert.equal(r.out.checked, 2);
    assert.deepEqual(r.out.unexpected, []);
  });

  it('a stray hand-written file at docs/ root fails and is named', () => {
    const r = run(['README.md', 'my-notes.md']);
    assert.equal(r.status, 1);
    assert.equal(r.out.ok, false);
    assert.deepEqual(r.out.unexpected, ['my-notes.md']);
  });

  it('a missing docs/ directory is a tool error (exit 2), never a pass', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-placement-none-'));
    try {
      const r = spawnSync(process.execPath, [SCRIPT, '--format', 'json'], { cwd, encoding: 'utf8' });
      assert.equal(r.status, 2);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
