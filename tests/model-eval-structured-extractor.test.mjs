/**
 * @fileoverview `structured-extractor.mjs` — extraction, validation, and
 * egress-safe payload preparation.
 *
 * Split out of `tests/model-eval-core.test.mjs` (Phase 5, plan:
 * comparison-tooling-consolidation.md, D3) — assertions moved verbatim.
 *
 * @module tests/model-eval-structured-extractor
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractStructured, InvalidEvaluationInputError, AuditorExtractionSchema,
  AdjudicatorExtractionSchema, prepareModelEvalPayloadForEgress,
} from '../scripts/lib/model-eval/structured-extractor.mjs';

describe('structured-extractor.mjs', () => {
  test('an unrecognized role is rejected instead of silently falling into the adjudicator branch (round-7 M5 regression guard)', async () => {
    await assert.rejects(
      () => extractStructured({ role: 'not-a-role', route: {}, rawContext: {} }),
      InvalidEvaluationInputError,
    );
  });

  test('a null/undefined rawContext raises a structured error, not a raw TypeError (round-8 M2/L1 regression guard)', async () => {
    await assert.rejects(() => extractStructured({ role: 'auditor', route: {}, rawContext: null }), InvalidEvaluationInputError);
    await assert.rejects(() => extractStructured({ role: 'auditor', route: {}, rawContext: undefined }), InvalidEvaluationInputError);
  });

  test('a sensitive file PATH (not just secret-shaped content) blocks egress (round-8b H2 regression guard)', () => {
    const sensitive = prepareModelEvalPayloadForEgress({
      route: { role: 'auditor' },
      visibleInput: { evidenceHunk: 'diff --git a/.env b/.env\n+FOO=bar', filePaths: ['.env'] },
    });
    assert.equal(sensitive.egressDecision, 'blocked');

    const clean = prepareModelEvalPayloadForEgress({
      route: { role: 'auditor' },
      visibleInput: { evidenceHunk: 'diff --git a/src/foo.js b/src/foo.js\n+const x = 1;', filePaths: ['src/foo.js'] },
    });
    assert.notEqual(clean.egressDecision, 'blocked');
  });

  test('a sensitive path mentioned only in the diff HEADERS (not the declared filePaths array) also blocks egress (round-9 H2/H9 regression guard)', () => {
    const r = prepareModelEvalPayloadForEgress({
      route: { role: 'auditor' },
      visibleInput: {
        evidenceHunk: 'diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n+SECRET=x',
        filePaths: ['src/unrelated.js'], // caller's declared list omits the sensitive path
      },
    });
    assert.equal(r.egressDecision, 'blocked');
  });

  test('a sensitive path in a quoted (C-style) diff header also blocks egress (round-11 H3/H6 regression guard)', () => {
    const r = prepareModelEvalPayloadForEgress({
      route: { role: 'auditor' },
      visibleInput: {
        evidenceHunk: 'diff --git "a/secrets/api keys.json" "b/secrets/api keys.json"\n--- "a/secrets/api keys.json"\n+++ "b/secrets/api keys.json"\n+{"key":"x"}',
        filePaths: ['src/unrelated.js'],
      },
    });
    assert.equal(r.egressDecision, 'blocked');
    const clean = prepareModelEvalPayloadForEgress({
      route: { role: 'auditor' },
      visibleInput: { evidenceHunk: 'diff --git "a/normal file.js" "b/normal file.js"\n+const x=1;', filePaths: ['src/unrelated.js'] },
    });
    assert.notEqual(clean.egressDecision, 'blocked');
  });

  test('a sensitive path mentioned only in adjudicator findingText prose also blocks egress (round-11 H7 regression guard)', () => {
    const r = prepareModelEvalPayloadForEgress({
      route: { role: 'adjudicator' },
      visibleInput: { findingText: 'the file .env has a hardcoded credential on line 3', severity: 'HIGH' },
    });
    assert.equal(r.egressDecision, 'blocked');
    const clean = prepareModelEvalPayloadForEgress({
      route: { role: 'adjudicator' },
      visibleInput: { findingText: 'the function foo() in src/utils.js has a null check bug', severity: 'MEDIUM' },
    });
    assert.notEqual(clean.egressDecision, 'blocked');
  });

  test('a sensitive path introduced only via a diff rename/copy header also blocks egress (round-10 M10 regression guard)', () => {
    const r = prepareModelEvalPayloadForEgress({
      route: { role: 'auditor' },
      visibleInput: {
        evidenceHunk: 'diff --git a/config.js b/.env\nsimilarity index 100%\nrename from config.js\nrename to .env',
        filePaths: ['config.js'],
      },
    });
    assert.equal(r.egressDecision, 'blocked');
  });

  test('prepareModelEvalPayloadForEgress rejects malformed input shapes at its own boundary instead of throwing a raw TypeError (round-10 M9 regression guard)', () => {
    assert.equal(prepareModelEvalPayloadForEgress({ route: { role: 'auditor' }, visibleInput: null }).egressDecision, 'blocked');
    assert.equal(prepareModelEvalPayloadForEgress({ route: { role: 'auditor' }, visibleInput: { evidenceHunk: 'x', filePaths: 'not-an-array' } }).egressDecision, 'blocked');
  });

  test('extraction schemas cap description/rationale length, bounding Levenshtein\'s worst-case cost (round-11 M3 regression guard)', () => {
    const tooLong = 'x'.repeat(2001);
    assert.equal(AuditorExtractionSchema.safeParse({ defectLocation: { file: 'a.js', description: tooLong } }).success, false);
    assert.equal(AdjudicatorExtractionSchema.safeParse({ verdict: 'true_positive', rationale: tooLong }).success, false);
    assert.equal(AuditorExtractionSchema.safeParse({ defectLocation: { file: 'a.js', description: 'x'.repeat(2000) } }).success, true);
  });

  test('extraction schemas reject empty-string fields as a vacuous-but-success-shaped response (round-8 H2 regression guard)', () => {
    assert.equal(AuditorExtractionSchema.safeParse({ defectLocation: { file: '', description: 'x' } }).success, false);
    assert.equal(AuditorExtractionSchema.safeParse({ defectLocation: { file: 'a.js', description: '' } }).success, false);
    assert.equal(AdjudicatorExtractionSchema.safeParse({ verdict: 'true_positive', rationale: '' }).success, false);
    assert.equal(AuditorExtractionSchema.safeParse({ defectLocation: { file: 'a.js', description: 'x' } }).success, true);
  });
});
