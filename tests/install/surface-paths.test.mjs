import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveSkillTargets, receiptPath } from '../../scripts/lib/install/surface-paths.mjs';

describe('resolveSkillTargets', () => {
  it('returns copilot target for copilot surface', () => {
    const targets = resolveSkillTargets('audit-loop', 'copilot', '/repo');
    assert.equal(targets.length, 1);
    assert.equal(targets[0].surface, 'copilot');
    assert.ok(targets[0].filePath.includes('.github'));
  });

  it('returns 3 targets for both surface', () => {
    const targets = resolveSkillTargets('audit-loop', 'both', '/repo');
    assert.equal(targets.length, 3);
    const surfaces = targets.map(t => t.surface).sort();
    assert.deepEqual(surfaces, ['agents', 'claude', 'copilot']);
  });

  it('returns claude target using home dir', () => {
    const targets = resolveSkillTargets('ship', 'claude', '/repo');
    assert.equal(targets.length, 1);
    assert.ok(targets[0].filePath.includes('.claude'));
    assert.ok(targets[0].filePath.includes('ship'));
  });
});

describe('receiptPath', () => {
  it('returns repo receipt path', () => {
    const p = receiptPath('repo', '/my/repo');
    assert.ok(p.includes('.audit-loop-install-receipt.json'));
    assert.ok(p.includes('repo'));
  });

  it('returns global receipt path in home dir', () => {
    const p = receiptPath('global', '/my/repo');
    assert.ok(p.includes('.audit-loop-install-receipt.json'));
    assert.ok(!p.includes('/my/repo'));
  });
});
