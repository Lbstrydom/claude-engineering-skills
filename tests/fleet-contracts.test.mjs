/**
 * @fileoverview /fleet shared contracts: oid shape, segment-aware containment,
 * and that the config-normalised tier validates against the persisted train schema.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { OID_RE, isOid, isInside, MERGE_METHODS, TierSchema } from '../scripts/lib/fleet/contracts.mjs';
import { parseFleetConfig, MERGE_METHODS as CONFIG_METHODS } from '../scripts/lib/fleet/config.mjs';
import { TrainSchema } from '../scripts/lib/fleet/registry.mjs';

describe('oid contract', () => {
  it('exactly 40 or 64 lowercase hex', () => {
    for (const [n, expected] of [[39, false], [40, true], [41, false], [63, false], [64, true], [65, false]]) {
      assert.equal(isOid('a'.repeat(n)), expected, String(n));
      assert.equal(OID_RE.test('a'.repeat(n)), expected, String(n));
    }
    assert.equal(isOid('A'.repeat(40)), false, 'uppercase is not canonical');
    assert.equal(isOid(null), false);
    assert.equal(isOid(`${'a'.repeat(40)}\n`), false, 'no trailing newline');
  });
});

describe('isInside is segment-aware', () => {
  const root = path.join(os.tmpdir(), 'iroot');
  it('child, equal, sibling, parent', () => {
    assert.equal(isInside(path.join(root, 'a', 'b'), root), true);
    assert.equal(isInside(root, root), true);
    assert.equal(isInside(root, root, { strict: true }), false);
    assert.equal(isInside(`${root}-sibling`, root), false, 'shared prefix is not containment');
    assert.equal(isInside(path.dirname(root), root), false);
    assert.equal(isInside(path.join(root, '..', 'elsewhere'), root), false);
  });
  it('a child literally named "..x" is inside', () => {
    assert.equal(isInside(path.join(root, '..fleet'), root), true);
    assert.equal(isInside(path.join(root, '..fleet', 'deep'), root), true);
    assert.equal(isInside(path.join(root, '..'), root), false);
  });
});

describe('one execution contract', () => {
  it('config re-exports the contracts merge methods', () => {
    assert.deepEqual([...CONFIG_METHODS], [...MERGE_METHODS]);
  });
  it('every config-normalised tier (list form and string forms) validates against the persisted train schema', () => {
    const cases = [
      { testCommand: 'npm test' },
      { testCommand: 'npm run a && npm run b' },
      { testCommand: { tiers: [{ name: 'fast', command: ['npm', 'run', 'test:unit'], timeoutMs: 5 }, { name: 'packaged', command: ['x'], stage: 'post-merge' }] } },
    ];
    for (const raw of cases) {
      const r = parseFleetConfig(raw);
      assert.equal(r.ok, true, JSON.stringify(raw));
      for (const tier of r.value.testCommand) assert.equal(TierSchema.safeParse(tier).success, true, JSON.stringify(tier));
      const train = {
        schemaVersion: 1, trainId: 't-20261005120000-abcd', createdAt: new Date().toISOString(), phase: 'snapshot',
        baseOid: 'b'.repeat(40), sources: [], mergeMethod: 'pr',
        destination: { remote: 'origin', fetchUrl: 'u', pushUrl: 'u', ref: 'refs/heads/main', expectedOid: null },
        testCommand: r.value.testCommand,
      };
      const parsed = TrainSchema.safeParse(train);
      assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
    }
  });
});
