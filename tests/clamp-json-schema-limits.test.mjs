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

// ── anyOf/oneOf traversal (experiment-4 gate-1 screen, 2026-07-17) ─────────
// A nullable nested schema (EvidenceAnchorSchema.nullable() on every
// finding's anchor) is emitted as {anyOf: [<schema>, {type:'null'}]} — the
// walker previously stopped there, so anchor.quote's maxLength:1000 was
// never clamped and an oversized quote hard-failed the WHOLE response.
// Measured live: DeepSeek round-2 screen failures "quote: Too big".
describe('clampToJsonSchemaLimits — anyOf/oneOf traversal (nullable anchors)', () => {
  it('clamps a string limit hidden behind a nullable anyOf wrapper', () => {
    const js = {
      type: 'object',
      properties: {
        anchor: { anyOf: [{ type: 'object', properties: { quote: { type: 'string', maxLength: 10 } } }, { type: 'null' }] },
      },
    };
    const out = clampToJsonSchemaLimits({ anchor: { quote: 'x'.repeat(50) } }, js);
    assert.equal(out.anchor.quote.length, 10);
  });

  it('a null value through the same wrapper is untouched', () => {
    const js = { anyOf: [{ type: 'object', properties: { q: { type: 'string', maxLength: 5 } } }, { type: 'null' }] };
    assert.equal(clampToJsonSchemaLimits(null, js), null);
  });

  it('END-TO-END: the real ProducerFindingV2Schema anchor quote is now clamped (the exact live failure)', async () => {
    const { z } = await import('zod');
    const { ProducerFindingV2Schema } = await import('../scripts/lib/schemas.mjs');
    const strict = z.object({ findings: z.array(ProducerFindingV2Schema).max(15) });
    const js = z.toJSONSchema(strict);
    const finding = {
      id: 'H1', severity: 'MEDIUM', category: 'c', section: 's', detail: 'd', risk: 'r',
      recommendation: 'rec', is_quick_fix: false, is_mechanical: false, principle: 'p',
      classification: { sonarType: 'CODE_SMELL', effort: 'TRIVIAL', sourceKind: 'MODEL', sourceName: 'm' },
      evidenceType: 'commission',
      anchor: { diffPathId: 'a', oldFile: 'a', newFile: 'a', fileStatus: 'modified', side: 'head', startLine: 1, endLine: 1, quote: 'x'.repeat(1500), headSha: 'W' },
    };
    const clamped = clampToJsonSchemaLimits({ findings: [finding] }, js);
    assert.equal(clamped.findings[0].anchor.quote.length, 1000, 'was 1500 (unreachable) before the anyOf fix');
    assert.equal(strict.safeParse(clamped).success, true, 'and the clamped value must now pass the strict schema');
  });

  it('no matching branch → value untouched, never a throw', () => {
    const js = { anyOf: [{ type: 'number' }] };
    assert.equal(clampToJsonSchemaLimits('a long string', js), 'a long string');
  });
});
