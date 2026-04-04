/**
 * @fileoverview Phase B — classification schema tests.
 * Validates ClassificationSchema atomicity, ProducerFindingSchema strictness,
 * PersistedFindingSchema backward compat, and zodToGeminiSchema derivation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ClassificationSchema,
  ProducerFindingSchema,
  PersistedFindingSchema,
  FindingSchema,
  zodToGeminiSchema,
} from '../scripts/lib/schemas.mjs';
import { buildClassificationRubric } from '../scripts/lib/prompt-seeds.mjs';

const validClassification = {
  sonarType: 'BUG',
  effort: 'EASY',
  sourceKind: 'MODEL',
  sourceName: 'gpt-5.4',
};

const baseFindingFields = {
  id: 'H1',
  severity: 'HIGH',
  category: 'Missing Error Handling',
  section: 'src/foo.js',
  detail: 'The function swallows errors silently.',
  risk: 'Silent failures propagate bad state.',
  recommendation: 'Throw or log with context.',
  is_quick_fix: false,
  is_mechanical: false,
  principle: 'error-handling',
};

test('ClassificationSchema — rejects empty object', () => {
  const result = ClassificationSchema.safeParse({});
  assert.equal(result.success, false);
});

test('ClassificationSchema — accepts full envelope', () => {
  const result = ClassificationSchema.safeParse(validClassification);
  assert.equal(result.success, true);
});

test('ClassificationSchema — rejects partial envelope (missing effort)', () => {
  const { effort, ...partial } = validClassification;
  const result = ClassificationSchema.safeParse(partial);
  assert.equal(result.success, false);
});

test('ClassificationSchema — rejects invalid sonarType', () => {
  const bad = { ...validClassification, sonarType: 'NOT_A_TYPE' };
  assert.equal(ClassificationSchema.safeParse(bad).success, false);
});

test('ClassificationSchema — rejects invalid effort enum', () => {
  const bad = { ...validClassification, effort: 'HUGE' };
  assert.equal(ClassificationSchema.safeParse(bad).success, false);
});

test('ClassificationSchema — accepts LINTER and TYPE_CHECKER sourceKind (Phase C forward-compat)', () => {
  for (const sourceKind of ['LINTER', 'TYPE_CHECKER', 'REVIEWER']) {
    const result = ClassificationSchema.safeParse({ ...validClassification, sourceKind });
    assert.equal(result.success, true, `sourceKind=${sourceKind} should be valid`);
  }
});

test('ProducerFindingSchema — requires classification', () => {
  const result = ProducerFindingSchema.safeParse(baseFindingFields);
  assert.equal(result.success, false);
});

test('ProducerFindingSchema — accepts finding with valid classification', () => {
  const finding = { ...baseFindingFields, classification: validClassification };
  const result = ProducerFindingSchema.safeParse(finding);
  assert.equal(result.success, true);
});

test('PersistedFindingSchema — accepts old finding without classification (backward compat)', () => {
  const result = PersistedFindingSchema.safeParse(baseFindingFields);
  assert.equal(result.success, true);
});

test('PersistedFindingSchema — accepts finding with classification: null', () => {
  const finding = { ...baseFindingFields, classification: null };
  const result = PersistedFindingSchema.safeParse(finding);
  assert.equal(result.success, true);
});

test('PersistedFindingSchema — accepts finding with full classification', () => {
  const finding = { ...baseFindingFields, classification: validClassification };
  const result = PersistedFindingSchema.safeParse(finding);
  assert.equal(result.success, true);
});

test('PersistedFindingSchema — rejects finding with partial classification envelope', () => {
  const finding = { ...baseFindingFields, classification: { sonarType: 'BUG' } };
  const result = PersistedFindingSchema.safeParse(finding);
  assert.equal(result.success, false);
});

test('FindingSchema (alias) === PersistedFindingSchema — permissive for reads', () => {
  assert.equal(FindingSchema, PersistedFindingSchema);
  // Old-format finding still validates through the alias
  assert.equal(FindingSchema.safeParse(baseFindingFields).success, true);
});

test('zodToGeminiSchema(ProducerFindingSchema) includes classification in required', () => {
  const jsonSchema = zodToGeminiSchema(ProducerFindingSchema);
  assert.ok(jsonSchema.properties?.classification, 'classification property present');
  assert.ok(
    jsonSchema.required?.includes('classification'),
    'classification is required in producer JSON schema'
  );
});

test('zodToGeminiSchema(PersistedFindingSchema) — classification NOT required', () => {
  const jsonSchema = zodToGeminiSchema(PersistedFindingSchema);
  assert.ok(jsonSchema.properties?.classification, 'classification property present');
  const required = jsonSchema.required || [];
  assert.equal(
    required.includes('classification'),
    false,
    'classification must not be required in persisted JSON schema'
  );
});

test('buildClassificationRubric — interpolates sourceKind and sourceName', () => {
  const rubric = buildClassificationRubric({ sourceKind: 'MODEL', sourceName: 'gpt-5.4' });
  assert.match(rubric, /"MODEL"/);
  assert.match(rubric, /"gpt-5\.4"/);
  assert.match(rubric, /sonarType/);
  assert.match(rubric, /effort/);
  assert.match(rubric, /BUG/);
  assert.match(rubric, /CODE_SMELL/);
});

test('buildClassificationRubric — REVIEWER variant for final review', () => {
  const rubric = buildClassificationRubric({ sourceKind: 'REVIEWER', sourceName: 'gemini-3.1-pro-preview' });
  assert.match(rubric, /"REVIEWER"/);
  assert.match(rubric, /gemini-3\.1-pro-preview/);
});
