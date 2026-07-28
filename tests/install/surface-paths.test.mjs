import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveSkillTargets, receiptPath } from '../../scripts/lib/install/surface-paths.mjs';

describe('resolveSkillTargets', () => {
  it('throws for the retired copilot surface (docs/plans/refactor-skill-governance.md, round-1 M1)', () => {
    assert.throws(() => resolveSkillTargets('audit-loop', 'copilot', '/repo'), /retired/);
  });

  it('returns 2 targets for both surface (copilot no longer included)', () => {
    const targets = resolveSkillTargets('audit-loop', 'both', '/repo');
    assert.equal(targets.length, 2);
    const surfaces = targets.map(t => t.surface).sort();
    assert.deepEqual(surfaces, ['agents', 'claude']);
  });

  it('returns claude target using home dir', () => {
    const targets = resolveSkillTargets('ship', 'claude', '/repo');
    assert.equal(targets.length, 1);
    assert.ok(targets[0].filePath.includes('.claude'));
    assert.ok(targets[0].filePath.includes('ship'));
  });

  it('Gemini gate G1 — throws for an entirely unrecognized surface, never a silent empty array', () => {
    // The real bug: a typo like --surface claudd matched none of the
    // existing branches and fell through to []. install-skills.mjs then
    // performs zero writes and exits 0 — a broken install reported as success.
    assert.throws(() => resolveSkillTargets('ship', 'claudd', '/repo'), /unrecognized surface 'claudd'/);
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
