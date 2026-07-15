/**
 * clampToJsonSchemaLimits — lenient ingestion for LLM replies whose provider
 * accepted our JSON Schema but did not enforce maxLength/maxItems.
 *
 * Pins the 2026-07-15 shadow-window failure: GLM (via OpenRouter
 * response_format json_schema) emitted `principle` fields >150 chars; the
 * strict safeParse inside oss-structured-output.mjs hard-failed the whole
 * discovery response → required-generator failure → every tiered-pipeline
 * round fell back to legacy. Clamping over-limit strings/arrays before
 * validation keeps cosmetic overflow from discarding a real round, while
 * semantic violations (bad enums, missing fields) still fail loud.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { clampToJsonSchemaLimits, ProducerFindingSchema } from '../scripts/lib/schemas.mjs';

/** A well-formed ProducerFinding with every required field. */
function validFinding(overrides = {}) {
  return {
    id: 'H1',
    severity: 'HIGH',
    category: 'Missing Error Handling',
    section: 'scripts/lib/foo.mjs',
    detail: 'Something is wrong.',
    risk: 'It could break.',
    recommendation: 'Fix it properly.',
    is_quick_fix: false,
    is_mechanical: true,
    principle: 'Fail loud, not quiet',
    classification: {
      sonarType: 'BUG',
      effort: 'EASY',
      sourceKind: 'MODEL',
      sourceName: 'glm-5.2',
    },
    ...overrides,
  };
}

const RESPONSE_SCHEMA = z.object({ findings: z.array(ProducerFindingSchema).max(15) });
const RESPONSE_JSON_SCHEMA = z.toJSONSchema(RESPONSE_SCHEMA);

describe('clampToJsonSchemaLimits', () => {
  it('truncates a string exceeding maxLength (the exact GLM principle>150 failure)', () => {
    const reply = { findings: [validFinding({ principle: 'p'.repeat(400) })] };
    const clamped = clampToJsonSchemaLimits(reply, RESPONSE_JSON_SCHEMA);
    assert.equal(clamped.findings[0].principle.length, 150);
    // and the strict schema now accepts it
    const parsed = RESPONSE_SCHEMA.safeParse(clamped);
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  });

  it('clamps nested object fields (classification.sourceName maxLength 64)', () => {
    const reply = { findings: [validFinding({ classification: {
      sonarType: 'BUG', effort: 'EASY', sourceKind: 'MODEL', sourceName: 's'.repeat(100),
    } })] };
    const clamped = clampToJsonSchemaLimits(reply, RESPONSE_JSON_SCHEMA);
    assert.equal(clamped.findings[0].classification.sourceName.length, 64);
    assert.equal(RESPONSE_SCHEMA.safeParse(clamped).success, true);
  });

  it('slices an array exceeding maxItems (16 findings → 15)', () => {
    const reply = { findings: Array.from({ length: 16 }, () => validFinding()) };
    const clamped = clampToJsonSchemaLimits(reply, RESPONSE_JSON_SCHEMA);
    assert.equal(clamped.findings.length, 15);
    assert.equal(RESPONSE_SCHEMA.safeParse(clamped).success, true);
  });

  it('leaves compliant values byte-identical in content', () => {
    const reply = { findings: [validFinding()] };
    const clamped = clampToJsonSchemaLimits(reply, RESPONSE_JSON_SCHEMA);
    assert.deepEqual(clamped, reply);
  });

  it('never truncates an enum string — a clipped enum is corruption, not cosmetics', () => {
    // Synthetic schema: enum whose member is longer than a sibling maxLength
    // would allow. The enum value must pass through untouched.
    const schema = { type: 'object', properties: {
      kind: { type: 'string', enum: ['SECURITY_HOTSPOT'], maxLength: 4 },
    } };
    const out = clampToJsonSchemaLimits({ kind: 'SECURITY_HOTSPOT' }, schema);
    assert.equal(out.kind, 'SECURITY_HOTSPOT');
  });

  it('does NOT rescue semantic violations — bad enum still fails the strict parse', () => {
    const reply = { findings: [validFinding({ severity: 'CATASTROPHIC' })] };
    const clamped = clampToJsonSchemaLimits(reply, RESPONSE_JSON_SCHEMA);
    assert.equal(RESPONSE_SCHEMA.safeParse(clamped).success, false);
  });

  it('passes through null/undefined value and unknown keys unchanged', () => {
    assert.equal(clampToJsonSchemaLimits(null, RESPONSE_JSON_SCHEMA), null);
    assert.equal(clampToJsonSchemaLimits(undefined, RESPONSE_JSON_SCHEMA), undefined);
    const reply = { findings: [], extraneous: 'x'.repeat(500) };
    const out = clampToJsonSchemaLimits(reply, RESPONSE_JSON_SCHEMA);
    assert.equal(out.extraneous.length, 500);
  });

  it('z.preprocess wrapper: toJSONSchema still derives the inner schema (ossCall contract)', () => {
    // ossCall derives the provider-facing JSON Schema from the SAME schema it
    // validates with — if the preprocess pipe broke z.toJSONSchema, the GLM
    // call would fail at schema derivation instead of being lenient.
    const lenient = z.preprocess(
      (v) => clampToJsonSchemaLimits(v, RESPONSE_JSON_SCHEMA),
      RESPONSE_SCHEMA,
    );
    const derived = z.toJSONSchema(lenient);
    assert.equal(
      derived.properties.findings.items.properties.principle.maxLength, 150,
    );
    // and parsing through the wrapper clamps then validates
    const parsed = lenient.safeParse({ findings: [validFinding({ principle: 'p'.repeat(400) })] });
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.findings[0].principle.length, 150);
  });
});
