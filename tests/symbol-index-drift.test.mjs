import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { _internals } from '../scripts/symbol-index/drift.mjs';

// Distinct from tests/symbol-index-drift-justification.test.mjs (a different
// concern — duplicate-justification pragma resolution) and
// tests/drift-stale-pragma.test.mjs. This covers atomicWrite's write path.

const tmpDirs = [];
function mkTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ }
  }
});

describe('symbol-index/drift.mjs — atomicWrite (atomic-write-adoption plan)', () => {
  it('writes content atomically and creates parent directories', () => {
    const tmpDir = mkTmp();
    const target = path.join(tmpDir, 'nested', 'drift-issue.md');

    _internals.atomicWrite(target, '# Drift Report\n\nGREEN\n');

    assert.equal(fs.readFileSync(target, 'utf-8'), '# Drift Report\n\nGREEN\n');
  });

  it('overwrites existing content', () => {
    const tmpDir = mkTmp();
    const target = path.join(tmpDir, 'drift-issue.md');
    _internals.atomicWrite(target, 'first');
    _internals.atomicWrite(target, 'second');
    assert.equal(fs.readFileSync(target, 'utf-8'), 'second');
  });
});

describe('symbol-index/drift.mjs — parseArgs (symbol-index-pipeline-reliability-hardening round-1 M2)', () => {
  const { parseArgs } = _internals;

  it('parses --out <path> and --json normally', () => {
    const args = parseArgs(['node', 'drift.mjs', '--out', 'report.md', '--json']);
    assert.equal(args.out, 'report.md');
    assert.equal(args.json, true);
  });

  it('--out immediately followed by --json throws instead of silently swallowing --json (the exact bug)', () => {
    assert.throws(
      () => parseArgs(['node', 'drift.mjs', '--out', '--json']),
      /--out requires a non-empty path value/,
    );
  });

  it('--out at end-of-argv (no value at all) throws', () => {
    assert.throws(
      () => parseArgs(['node', 'drift.mjs', '--out']),
      /--out requires a non-empty path value/,
    );
  });

  it('a legitimate path value that happens to start with a dash-like name is still accepted (only a literal --flag form is rejected)', () => {
    // Sanity: the guard checks `startsWith('--')`, not "contains a dash" —
    // a normal relative path is never mistaken for a flag.
    const args = parseArgs(['node', 'drift.mjs', '--out', 'my-report.md']);
    assert.equal(args.out, 'my-report.md');
  });
});

describe('symbol-index/drift.mjs — resolveStoreGateExit (false-green regression)', () => {
  const { resolveStoreGateExit } = _internals;

  // The callers (.github/workflows/architectural-drift.yml, here and in every
  // consumer) map this process's exit code as 0=green / 1=triggered / 2=infra
  // error, and the green branch auto-CLOSES the sticky drift issue. So a 0 for
  // either "cannot verify" state is not a cosmetic wrong number — it silently
  // certifies a clean sweep that never ran. Observed live 2026-08-08 in run
  // 31224329241, where an invalid AUDIT_DB_URL produced conclusion:success.
  it('a missing repo row exits 2, NEVER 0 — the workflow reads 0 as a clean sweep', () => {
    const gate = resolveStoreGateExit({ repo: null, snap: null });
    assert.ok(gate, 'a missing repo row must produce a gate decision, not null');
    assert.equal(gate.code, 2);
    assert.notEqual(gate.code, 0);
  });

  it('a missing active snapshot exits 2, NEVER 0', () => {
    const gate = resolveStoreGateExit({ repo: { id: 'repo-1' }, snap: null });
    assert.ok(gate);
    assert.equal(gate.code, 2);
    assert.notEqual(gate.code, 0);
  });

  it('a snapshot lacking refreshId is treated as absent (not a truthy-object pass)', () => {
    const gate = resolveStoreGateExit({ repo: { id: 'repo-1' }, snap: {} });
    assert.ok(gate, 'an object without refreshId must still gate');
    assert.equal(gate.code, 2);
  });

  it('names the unreachable-database cause too — this path is reached on a bad DSN, not only on an unindexed repo', () => {
    const gate = resolveStoreGateExit({ repo: null, snap: null });
    assert.match(gate.message, /unreachable/i);
    assert.match(gate.message, /AUDIT_DB_URL/);
  });

  it('returns null when the store yielded a repo and a real snapshot, so the sweep proceeds', () => {
    assert.equal(
      resolveStoreGateExit({ repo: { id: 'repo-1' }, snap: { refreshId: 'abc-123' } }),
      null,
    );
  });
});
