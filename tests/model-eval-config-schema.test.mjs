/**
 * @fileoverview `config/schema.mjs` — `.strict()` catches typos.
 *
 * Split out of `tests/model-eval-core.test.mjs` (Phase 5, plan:
 * comparison-tooling-consolidation.md, D3) — assertions moved verbatim.
 *
 * @module tests/model-eval-config-schema
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseThresholdConfig } from '../scripts/lib/model-eval/config/schema.mjs';

describe('config/schema.mjs — .strict() catches typos', () => {
  test('a typo\'d field name is rejected, not silently accepted', () => {
    const bad = {
      version: 1, role: 'auditor', calibrationNote: 'x',
      screen: { minSampleSize: 4, thresholds: { oracle: { minRecalll: 0.7 } } },
      promotion: { minSampleSize: 8, thresholds: { oracle: { minRecall: 0.7 } } },
    };
    const r = parseThresholdConfig(bad);
    assert.equal(r.ok, false);
  });

  test('an unrecognized key at the OUTER tier/role level is rejected, not silently stripped (round-6 M4 regression guard)', () => {
    const badTierLevel = {
      version: 1, role: 'auditor', calibrationNote: 'x',
      screen: { minSampleSize: 4, extraStrayKey: true, thresholds: { oracle: { minRecall: 0.7 } } },
      promotion: { minSampleSize: 8, thresholds: { oracle: { minRecall: 0.7 } } },
    };
    assert.equal(parseThresholdConfig(badTierLevel).ok, false);

    const badRoleLevel = {
      version: 1, role: 'auditor', calibrationNote: 'x', extraStrayTopLevelKey: true,
      screen: { minSampleSize: 4, thresholds: { oracle: { minRecall: 0.7 } } },
      promotion: { minSampleSize: 8, thresholds: { oracle: { minRecall: 0.7 } } },
    };
    assert.equal(parseThresholdConfig(badRoleLevel).ok, false);
  });
});
