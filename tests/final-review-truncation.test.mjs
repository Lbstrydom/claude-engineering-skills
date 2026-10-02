/**
 * @fileoverview `truncateToSchema` shortens PROSE, never identity or evidence.
 *
 * The recovery that keeps a verbose review from failing Zod treated every
 * bounded string as disposable narrative, including `original_finding_id`
 * (then capped at 10) and each `cited_lines` entry (100). Slicing those does
 * not shorten them, it re-points them: the tiered adjudicator joins a reversal
 * on `envelope:<fingerprint>`, which a 10-char cut turned into a silent
 * `confirmed`; a cited `file.mjs:137` cut to `file.mjs:13` is a false citation
 * the existence gate then reads as evidence.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { truncateToSchema, GeminiFinalReviewSchema } from '../scripts/lib/final-review/output-schemas.mjs';

const LONG_PATH = `scripts/${'nested/'.repeat(14)}module.mjs:137`; // > 100 chars

describe('truncateToSchema — identity and evidence are never sliced', () => {
  it('a long original_finding_id survives byte-for-byte (the adjudicator join key)', () => {
    const id = 'envelope:9f3a1c2b7d4e5f60';
    const out = truncateToSchema({ wrongly_dismissed: [{ original_finding_id: id }] }, '', []);
    assert.equal(out.wrongly_dismissed[0].original_finding_id, id);
  });

  it('the schema admits a real adjudicator id — the bound fits the ids actually in use', () => {
    const r = GeminiFinalReviewSchema.shape.wrongly_dismissed.element.shape.original_finding_id
      .safeParse('envelope:9f3a1c2b7d4e5f60');
    assert.equal(r.success, true);
  });

  it('an over-long identifier is kept verbatim and REPORTED, so validation decides rather than a slice', () => {
    const id = 'x'.repeat(80);
    const log = [];
    const out = truncateToSchema({ wrongly_dismissed: [{ original_finding_id: id }] }, '', log);
    assert.equal(out.wrongly_dismissed[0].original_finding_id, id);
    assert.ok(log.some((l) => /original_finding_id .*kept verbatim/.test(l)), log.join('|'));
  });

  it('an over-long citation is DROPPED, never shortened into a different line reference', () => {
    assert.ok(LONG_PATH.length > 100, 'precondition: the citation exceeds the bound');
    const log = [];
    const out = truncateToSchema({ wrongly_dismissed: [{ cited_lines: ['auth.js:132', LONG_PATH] }] }, '', log);
    assert.deepEqual(out.wrongly_dismissed[0].cited_lines, ['auth.js:132']);
    assert.ok(log.some((l) => /cited_lines\[\] .*evidence dropped/.test(l)), log.join('|'));
  });

  it('NEGATIVE CONTROL: prose is still truncated to its bound', () => {
    const log = [];
    const out = truncateToSchema({ overall_reasoning: 'r'.repeat(3500) }, '', log);
    assert.equal(out.overall_reasoning.length, 3000);
    assert.equal(log.length, 1);
  });
});
