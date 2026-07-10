/**
 * Tier-1 test for the `allowInfraFiles` escape hatch on extractPlanPaths()
 * (docs/plans/tiered-recall-audit-pipeline.md — self-audit gap fix).
 *
 * Default (false) must be unchanged from today's behavior: the audit tool's
 * own control-plane files (schemas.mjs, ledger.mjs, …) never surface as plan
 * subject files during a normal audit. Opting in (true) is the sole way a
 * META plan — whose deliverable IS a change to this tool's own infra — can
 * be self-audited at all.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractPlanPaths } from '../scripts/lib/plan-paths.mjs';

const PLAN = 'Modify `scripts/lib/schemas.mjs` (backtick path) to add a field, ' +
  'and `scripts/lib/config.mjs` while we are at it.';

describe('extractPlanPaths — allowInfraFiles escape hatch', () => {
  it('default (false): infra basenames (schemas.mjs, config.mjs) are excluded', () => {
    const { allPaths } = extractPlanPaths(PLAN);
    assert.equal([...allPaths].some((p) => p.endsWith('schemas.mjs')), false);
    assert.equal([...allPaths].some((p) => p.endsWith('config.mjs')), false);
  });

  it('allowInfraFiles:true includes infra basenames', () => {
    const { allPaths } = extractPlanPaths(PLAN, { allowInfraFiles: true });
    assert.ok([...allPaths].some((p) => p.endsWith('schemas.mjs')));
    assert.ok([...allPaths].some((p) => p.endsWith('config.mjs')));
  });

  it('a non-infra path is unaffected either way', () => {
    const plan = 'Modify `src/routes/orders.js` (a fictional consumer-repo path, not in the infra basename set).';
    const a = extractPlanPaths(plan);
    const b = extractPlanPaths(plan, { allowInfraFiles: true });
    assert.deepEqual([...a.allPaths].sort(), [...b.allPaths].sort());
    assert.ok([...a.allPaths].some((p) => p.endsWith('orders.js')));
  });

  it('omitting opts entirely still defaults to false (no destructure crash)', () => {
    assert.doesNotThrow(() => extractPlanPaths(PLAN));
  });
});
