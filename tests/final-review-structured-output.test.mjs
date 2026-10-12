/**
 * @fileoverview The openai final-review transport must ASK for the schema, not
 * describe it in prose — and must not do so on routes that share the adapter.
 *
 * Why (experiment-4, 2026-07-28): the openai transport only appended "Output
 * strictly valid JSON" to the system prompt. Opus complied because the
 * anthropic transport FORCES a `submit_review` tool call carrying the real
 * schema, so OpenAI-side arms were judged against a contract they were never
 * given. Measured: kimi-k3 returned `{file,title,description,evidence}` and
 * glm-5.2 returned `{title,description,evidence_basis,cited_lines}` — neither
 * carrying `category`/`section`/`risk`/`recommendation`, which the finding
 * taxonomy and R2+ suppression ledger key on. Zod validation here is
 * warn-and-keep, so those degraded rows reached the store silently.
 *
 * The Azure-parity case is the one that guards a regression in the OTHER
 * direction: Azure Foundry's openai shape shares this adapter and must keep
 * sending a byte-identical body.
 *
 * @module tests/final-review-structured-output
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { _internals } from '../scripts/gemini-review.mjs';
import {
  truncateToSchema, IDENTITY_PATHS, NARRATIVE_PATHS, GeminiFinalReviewSchema, FinalReviewFindingSchema,
} from '../scripts/lib/final-review/output-schemas.mjs';

const { REVIEW_TRANSPORTS, PROVIDERS } = _internals;

/** Minimal fake client capturing the request body; optionally throwing first. */
function fakeClient({ throwFirst = null } = {}) {
  const bodies = [];
  let thrown = false;
  return {
    bodies,
    chat: {
      completions: {
        create: async (body) => {
          bodies.push(structuredClone(body));
          if (throwFirst && !thrown) { thrown = true; throw throwFirst; }
          return {
            choices: [{ message: { content: '{"verdict":"APPROVE"}' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          };
        },
      },
    },
  };
}

const baseArgs = { model: 'm', maxTokens: 100, systemPrompt: 'sys', userPrompt: 'usr', signal: undefined };
const SCHEMA = { type: 'object', properties: { verdict: { type: 'string' } } };

describe('openai final-review transport — structured output', () => {
  it('sends response_format:json_schema when a schema is supplied', async () => {
    const c = fakeClient();
    await REVIEW_TRANSPORTS.openai(c, { ...baseArgs, openAiJsonSchema: SCHEMA });
    const rf = c.bodies[0].response_format;
    assert.equal(rf?.type, 'json_schema');
    assert.deepEqual(rf.json_schema.schema, SCHEMA);
    assert.match(rf.json_schema.name, /^[a-zA-Z0-9_-]{1,64}$/, 'schema name must match the provider-accepted shape');
  });

  it('AZURE PARITY: omits response_format entirely when no schema is supplied', async () => {
    const c = fakeClient();
    await REVIEW_TRANSPORTS.openai(c, { ...baseArgs });
    assert.ok(!('response_format' in c.bodies[0]),
      'a route that did not opt in must send a byte-identical body');
  });

  it('degrades ONCE to prompt-only when the router rejects response_format', async () => {
    const err = Object.assign(new Error('response_format is not supported by this provider'), { status: 400 });
    const c = fakeClient({ throwFirst: err });
    const r = await REVIEW_TRANSPORTS.openai(c, { ...baseArgs, openAiJsonSchema: SCHEMA });
    assert.equal(c.bodies.length, 2, 'exactly one retry');
    assert.ok('response_format' in c.bodies[0]);
    assert.ok(!('response_format' in c.bodies[1]), 'the retry must drop response_format');
    assert.equal(r.text, '{"verdict":"APPROVE"}');
  });

  it('does NOT mask an unrelated 400 as a format downgrade', async () => {
    // A bad-model / quota 400 must surface, not silently become a prompt-only
    // review — otherwise a broken config reads as a successful gate.
    const err = Object.assign(new Error('model not found'), { status: 400 });
    const c = fakeClient({ throwFirst: err });
    await assert.rejects(
      () => REVIEW_TRANSPORTS.openai(c, { ...baseArgs, openAiJsonSchema: SCHEMA }),
      /model not found/,
    );
    assert.equal(c.bodies.length, 1, 'must not retry an unrelated error');
  });

  it('only the explicitly-selected OpenAI-compatible routes opt in', () => {
    assert.equal(PROVIDERS.openrouter.structuredOutput, true);
    assert.equal(PROVIDERS['openai-compatible'].structuredOutput, true);
    for (const id of ['gemini', 'anthropic', 'azure-claude']) {
      assert.ok(!PROVIDERS[id]?.structuredOutput,
        `${id} must not opt in — azure-claude shares the openai adapter`);
    }
  });
});

// ── truncateToSchema: prose is repaired, IDENTITY is not ────────────────────
// `_maxLengthMap` used to cover every bounded string, so the repair that keeps a verbose
// narrative from failing Zod also clipped identifiers: two distinct ids collapsed into one
// (`G-existence-claim-one` / `-two` -> `G-existenc`) and a 12-hex ledger topicId stopped
// joining to its entry (`713af1a3f1bc` -> `713af1a3f1`). Real logs showed
// `new_findings[].id (21 -> 10)`. (docs/plans/final-review-debt-suppression-revival.md §2.4)
describe('truncateToSchema — identity fields are never truncated', () => {
  const finding = (id) => ({ id, severity: 'LOW', category: 'c', section: 's', detail: 'd' });

  it('prose is STILL truncated (the repair this function exists for)', () => {
    const truncated = [];
    const out = truncateToSchema({ overall_reasoning: 'x'.repeat(3500), new_findings: [{ ...finding('G1'), detail: 'y'.repeat(900) }] }, '', truncated);
    assert.equal(out.overall_reasoning.length, 3000);
    assert.equal(out.new_findings[0].detail.length, 600);
    assert.deepEqual(truncated.map((t) => t.split(' ')[0]), ['overall_reasoning', 'new_findings[].detail']);
  });

  it('every IDENTITY_PATHS member comes back WHOLE, however long', () => {
    const out = truncateToSchema({
      new_findings: [finding(`G-${'i'.repeat(200)}`)],
      wrongly_dismissed: [{ original_finding_id: `topic-${'t'.repeat(200)}` }],
    }, '', []);
    assert.equal(out.new_findings[0].id.length, 202);
    assert.equal(out.wrongly_dismissed[0].original_finding_id.length, 206);
  });

  it('the collision case: two distinct descriptive ids stay distinct', () => {
    const out = truncateToSchema({ new_findings: [finding('G-existence-claim-one'), finding('G-existence-claim-two')] }, '', []);
    assert.deepEqual(out.new_findings.map((f) => f.id), ['G-existence-claim-one', 'G-existence-claim-two']);
  });

  it('a 12-hex ledger topicId in original_finding_id survives (it used to become 10 chars and join to nothing)', () => {
    const out = truncateToSchema({ wrongly_dismissed: [{ original_finding_id: '713af1a3f1bc' }] }, '', []);
    assert.equal(out.wrongly_dismissed[0].original_finding_id, '713af1a3f1bc');
  });

  it('cited_lines: a long but realistic citation survives WHOLE (audit-code R1 M1/M5 — 100 cut valid deep paths)', () => {
    // A 150-character repository path plus a line number: past the old 100 bound.
    const deep = `${'packages/'.repeat(14)}core/src/widgets/very-long-component-name.mjs:4821`;
    assert.ok(deep.length > 100 && deep.length < 300, `fixture length ${deep.length}`);
    const out = truncateToSchema({ wrongly_dismissed: [{ cited_lines: [deep] }] }, '', []);
    assert.equal(out.wrongly_dismissed[0].cited_lines[0], deep, 'the :line must not be cut off');
  });

  it('cited_lines is EVIDENCE, not prose (audit-code R2 M1): an oversized citation is never silently shortened — it is kept whole and REJECTED by validation', () => {
    const oversized = `${'deeply/'.repeat(60)}nested.mjs:12`;
    assert.ok(oversized.length > 300, `fixture length ${oversized.length}`);
    const out = truncateToSchema({ wrongly_dismissed: [{ cited_lines: [oversized] }] }, '', []);
    assert.equal(out.wrongly_dismissed[0].cited_lines[0], oversized, 'the reference must be preserved exactly');
    // ...and the Zod bound that remains is what makes the oversize LOUD (callReviewer warns and keeps).
    const citedSchema = GeminiFinalReviewSchema.shape.wrongly_dismissed.element.shape.cited_lines.unwrap().element;
    assert.equal(citedSchema.safeParse(oversized).success, false);
    assert.equal(citedSchema.safeParse(oversized.slice(0, 300)).success, true, 'negative control: the bound is exactly the loud limit');
  });

  it('every IDENTITY_PATHS entry names a REAL string field in the emitted schema (a rename must fail loudly, not re-enable truncation)', () => {
    const schema = z.toJSONSchema(GeminiFinalReviewSchema);
    const deref = (node) => (node?.$ref ? schema.$defs[node.$ref.replace('#/$defs/', '')] : node);
    const resolve = (parts) => {
      let cur = schema;
      for (const part of parts) {
        const isArray = part.endsWith('[]');
        cur = deref(deref(cur)?.properties?.[isArray ? part.slice(0, -2) : part]);
        if (isArray) cur = deref(cur?.items);
      }
      return cur;
    };
    assert.ok(IDENTITY_PATHS.size >= 2);
    for (const p of IDENTITY_PATHS) {
      const node = resolve(p.split('.'));
      assert.equal(node?.type, 'string', `${p} must resolve to a string property`);
      assert.ok(Number.isInteger(node.maxLength), `${p} keeps a Zod bound (validated loudly, never truncated)`);
    }
  });

  it('the widened ids validate: a 12-hex topicId and a long descriptive id pass; > 40 fails loudly', () => {
    assert.equal(FinalReviewFindingSchema.shape.id.safeParse('G-existence-claim-one').success, true);
    assert.equal(FinalReviewFindingSchema.shape.id.safeParse('x'.repeat(41)).success, false);
    assert.equal(GeminiFinalReviewSchema.shape.wrongly_dismissed.element.shape.original_finding_id.safeParse('713af1a3f1bc').success, true);
  });

  it('every bounded string field is CLASSIFIED: a new one cannot become truncatable by default', () => {
    // The prose fields `truncateToSchema` may clip. A field added to the review schema with a
    // `.max()` shows up in NARRATIVE_PATHS and fails this test until someone decides: prose goes
    // in this list, an identifier or citation goes in IDENTITY_PATHS.
    const PROSE = [
      'deliberation_quality.quality_summary',
      'new_findings[].category',
      'new_findings[].classification.sourceName',
      'new_findings[].detail',
      'new_findings[].principle',
      'new_findings[].recommendation',
      'new_findings[].risk',
      'new_findings[].section',
      'over_engineering_flags[]',
      'overall_reasoning',
      'wrongly_dismissed[].evidence_basis',
      'wrongly_dismissed[].reason_claude_was_wrong',
    ];
    assert.deepEqual([...NARRATIVE_PATHS], PROSE,
      'the set of truncatable fields changed: classify each new bounded string as prose (list it here) or identity (IDENTITY_PATHS)');
    // The two sets are disjoint, and the probe can see something (vacuous-pass guard).
    assert.ok(NARRATIVE_PATHS.length > 0);
    for (const p of IDENTITY_PATHS) assert.ok(!NARRATIVE_PATHS.includes(p), `${p} is both identity and prose`);
  });
});
