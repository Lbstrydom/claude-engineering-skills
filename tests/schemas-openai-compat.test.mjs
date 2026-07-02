/**
 * OpenAI structured-outputs compatibility contract for LLM-facing schemas.
 *
 * The OpenAI responses API requires every field to be required — a Zod
 * `.optional()` without `.nullable()` is rejected client-side by
 * `zodTextFormat` with "uses .optional() without .nullable() which is not
 * supported by the API". The architecture pass hit exactly this on EVERY code
 * audit (its findings array reused the persisted FindingSchema, whose
 * `verification` field is a post-LLM attachment) and silently degraded to the
 * deterministic fallback. `zodTextFormat` here is the same gate the runtime
 * uses, so these tests fail iff the real call would.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';

import { ArchIntentPassSchema, ProducerFindingSchema } from '../scripts/lib/schemas.mjs';

describe('OpenAI structured-outputs compatibility (zodTextFormat gate)', () => {
  it('ArchIntentPassSchema derives without throwing (the every-audit architecture-pass failure)', () => {
    const fmt = zodTextFormat(ArchIntentPassSchema, 'architecture_pass');
    assert.equal(fmt.type, 'json_schema');
  });

  it('architecture findings use the PRODUCER shape — no post-LLM verification field', () => {
    const fmt = zodTextFormat(ArchIntentPassSchema, 'architecture_pass');
    const findingProps = fmt.json_schema?.schema?.properties?.findings?.items?.properties
      ?? fmt.schema?.properties?.findings?.items?.properties;
    assert.ok(findingProps, 'findings.items.properties must be derivable');
    assert.equal(findingProps.verification, undefined,
      'verification is attached by the deterministic gate AFTER the LLM — it must never appear in an LLM-facing schema');
    assert.ok(findingProps.classification, 'producer findings carry REQUIRED classification');
  });

  it('ProducerFindingSchema itself stays API-compatible (shared by all passes + shadow)', () => {
    const wrapper = z.object({ findings: z.array(ProducerFindingSchema) });
    assert.doesNotThrow(() => zodTextFormat(wrapper, 'producer_findings'));
  });
});
