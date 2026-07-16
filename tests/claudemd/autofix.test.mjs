import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { applyFixes } from '../../scripts/lib/claudemd/autofix.mjs';

const tmpDirs = [];
function mkTmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ }
  }
});

describe('applyFixes — write path (atomic-write-adoption plan)', () => {
  it('dryRun:false actually removes the standalone link line and persists it', () => {
    const repoRoot = mkTmpRepo();
    const relFile = 'AGENTS.md';
    fs.writeFileSync(
      path.join(repoRoot, relFile),
      'line one\n[stale ref](docs/gone.md)\nline three\n',
    );
    const findings = [
      { file: relFile, line: 2, fixable: true, ruleId: 'stale/file-ref' },
    ];

    const result = applyFixes(findings, repoRoot, { dryRun: false });

    assert.equal(result.applied.length, 1);
    assert.match(result.applied[0].action, /^removed:/);
    const after = fs.readFileSync(path.join(repoRoot, relFile), 'utf-8');
    assert.equal(after, 'line one\nline three\n');
  });

  it('dryRun:true (default) reports without modifying the file', () => {
    const repoRoot = mkTmpRepo();
    const relFile = 'AGENTS.md';
    const original = 'line one\n[stale ref](docs/gone.md)\nline three\n';
    fs.writeFileSync(path.join(repoRoot, relFile), original);
    const findings = [
      { file: relFile, line: 2, fixable: true, ruleId: 'stale/file-ref' },
    ];

    const result = applyFixes(findings, repoRoot);

    assert.match(result.applied[0].action, /^would remove:/);
    assert.equal(fs.readFileSync(path.join(repoRoot, relFile), 'utf-8'), original);
  });
});
