import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  GRADING_LABELS as forkLabels,
  GradingSchema,
  JUDGE_SYSTEM as forkJudgeSystem,
  SEV_WEIGHTS as forkSevWeights,
  LABEL_FACTORS as forkLabelFactors,
} from '../scripts/lib/model-eval/blind-judge.mjs';

import {
  GRADING_LABELS as snapshotLabels,
  GRADING_SCHEMA_SHAPE as snapshotShape,
  JUDGE_SYSTEM as snapshotJudgeSystem,
  SEV_WEIGHTS as snapshotSevWeights,
  LABEL_FACTORS as snapshotLabelFactors,
} from './fixtures/solo-control-judge-protocol-snapshot.js';

// Guards docs/plans/model-swap-eval-harness.md's Phase 2 provenance
// requirement: blind-judge.mjs's own copies of the cross-family judge
// protocol must stay byte-identical to the frozen snapshot (which itself
// mirrors scripts/solo-control-audit.mjs lines 1043-1082 as of the fork
// date) UNLESS both files are bumped together, deliberately. This test
// compares blind-judge.mjs against the snapshot fixture ONLY — it never
// imports or reads scripts/solo-control-audit.mjs (that file is the live,
// active solo author-model control experiment and stays out of scope for
// this plan).

describe('blind-judge.mjs fork parity — snapshot fixture', () => {
  test('JUDGE_SYSTEM prompt is byte-identical to the frozen snapshot', () => {
    assert.equal(forkJudgeSystem, snapshotJudgeSystem);
  });

  test('GRADING_LABELS is identical (same values, same order)', () => {
    assert.deepEqual(forkLabels, snapshotLabels);
  });

  test('SEV_WEIGHTS is identical', () => {
    assert.deepEqual(forkSevWeights, snapshotSevWeights);
  });

  test('LABEL_FACTORS is identical', () => {
    assert.deepEqual(forkLabelFactors, snapshotLabelFactors);
  });

  // GradingSchema (a live Zod schema in blind-judge.mjs) is compared to
  // GRADING_SCHEMA_SHAPE (a runtime-free plain descriptor in the snapshot)
  // BEHAVIORALLY — parsing representative objects through the real schema
  // and asserting the observable contract matches the frozen shape,
  // rather than reflecting into Zod 4 internals (which is exactly the
  // kind of internal-API coupling AGENTS.md warns is fragile across
  // versions).

  test('GradingSchema accepts a minimal object and fills the documented defaults', () => {
    const parsed = GradingSchema.parse({ gradings: [{ blind_id: 'b0', label: 'proven' }] });
    const item = parsed.gradings[0];
    const fixtureItemShape = snapshotShape.gradings.item;
    for (const [field, spec] of Object.entries(fixtureItemShape)) {
      if (spec.optional) {
        assert.equal(item[field], spec.default, `field "${field}" should default to ${JSON.stringify(spec.default)}`);
      }
    }
  });

  test('GradingSchema key set matches the frozen shape exactly (no drift either direction)', () => {
    const full = {
      blind_id: 'b0', label: 'proven', proof: 'file.js:1', cluster: 'c1', matches: 'KD-001', pattern: 'p1',
    };
    const parsed = GradingSchema.parse({ gradings: [full] });
    const parsedKeys = Object.keys(parsed.gradings[0]).sort();
    const fixtureKeys = Object.keys(snapshotShape.gradings.item).sort();
    assert.deepEqual(parsedKeys, fixtureKeys);
  });

  test('GradingSchema enum accepts exactly the frozen label set, nothing more', () => {
    for (const label of snapshotLabels) {
      assert.doesNotThrow(() => GradingSchema.parse({ gradings: [{ blind_id: 'b0', label }] }));
    }
    assert.throws(() => GradingSchema.parse({ gradings: [{ blind_id: 'b0', label: 'not-a-real-label' }] }));
  });

  test('GradingSchema requires blind_id and label (no defaults for the required fields)', () => {
    assert.throws(() => GradingSchema.parse({ gradings: [{ label: 'proven' }] }));
    assert.throws(() => GradingSchema.parse({ gradings: [{ blind_id: 'b0' }] }));
  });
});
