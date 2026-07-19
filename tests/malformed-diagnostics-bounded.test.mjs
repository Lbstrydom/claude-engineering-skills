/**
 * @fileoverview Malformed-anchor diagnostics: discriminating, and bounded.
 *
 * The tiered-recall blocker could not be confirmed from stored data because
 * only `reasonCode` survived — "malformed", never WHICH shape — so the
 * sub-case stayed a guess and the Phase-14 window could not be diagnosed.
 * `prepareCandidates` already returns `reasonDetail` and `rawIndex`; they were
 * dropped at the record boundary.
 *
 * The payload is MODEL-PRODUCED, i.e. untrusted, and is persisted and
 * rendered — so bounding it is part of the contract, not a nicety. Two
 * budgets: exemplars per reason AND the number of reasons (a model emitting
 * thousands of distinct codes would otherwise yield thousands of buckets).
 *
 * Plan: docs/plans/debt-burndown-workstreams.md §7 WS-E2.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { boundMalformedDetails } = await import('../scripts/model-eval-discovery.mjs')
  .then((m) => m.__testExports ?? m)
  .catch(() => ({}));

const mk = (n, reason, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ rawIndex: from + i, reasonCode: reason, reasonDetail: `detail ${from + i}` }));
const findings = Array.from({ length: 500 }, (_, i) => ({ anchor: `anchor-${i}` }));

describe('boundMalformedDetails', { skip: !boundMalformedDetails && 'helper not exported' }, () => {
  it('keeps the reasonDetail that reasonCode alone cannot express', () => {
    const [b] = boundMalformedDetails(mk(1, 'producer_anchor_malformed'), findings);
    assert.equal(b.exemplars[0].reasonDetail, 'detail 0');
    assert.equal(b.exemplars[0].rawAnchor, 'anchor-0', 'the raw anchor is the point of the exercise');
  });

  it('COUNTS every candidate even when exemplars are capped', () => {
    const [b] = boundMalformedDetails(mk(400, 'x'), findings);
    assert.equal(b.count, 400, 'a capped exemplar list must never be mistaken for the population');
    assert.equal(b.exemplars.length, 5);
    assert.equal(b.truncated, true);
    assert.equal(b.omittedCount, 395);
  });

  it('bounds the NUMBER of reason codes, not just exemplars per code', () => {
    // The second budget. Without it a model emitting thousands of distinct
    // codes yields thousands of one-element buckets — unbounded by construction.
    const many = Array.from({ length: 200 }, (_, i) => ({ rawIndex: i, reasonCode: `code_${i}`, reasonDetail: 'd' }));
    const out = boundMalformedDetails(many, findings);
    assert.ok(out.length <= 21, `expected ≤20 buckets + __other, got ${out.length}`);
    const other = out.find((b) => b.reasonCode.startsWith('__other'));
    assert.ok(other, 'the remainder must be folded into a counted bucket, not dropped');
    assert.equal(other.count + out.filter((b) => !b.reasonCode.startsWith('__other')).reduce((n, b) => n + b.count, 0), 200,
      'every candidate is still accounted for');
  });

  it('is deterministic — same input, identical record', () => {
    const input = [...mk(3, 'b'), ...mk(5, 'a', 10)];
    assert.deepEqual(boundMalformedDetails(input, findings), boundMalformedDetails(input, findings));
  });

  it('orders buckets by count desc then key asc (no map-iteration dependence)', () => {
    const out = boundMalformedDetails([...mk(2, 'zzz'), ...mk(5, 'aaa', 10), ...mk(2, 'bbb', 20)], findings);
    assert.deepEqual(out.map((b) => b.reasonCode), ['aaa', 'bbb', 'zzz']);
  });

  it('caps oversized detail and anchor payloads', () => {
    const huge = [{ rawIndex: 0, reasonCode: 'x', reasonDetail: 'D'.repeat(5000) }];
    const big = [{ anchor: 'A'.repeat(9000) }];
    const [b] = boundMalformedDetails(huge, big);
    assert.ok(b.exemplars[0].reasonDetail.length <= 500);
    assert.ok(b.exemplars[0].rawAnchor.length <= 2000);
  });

  it('caps an oversized reason CODE (the bucket key is untrusted too)', () => {
    const [b] = boundMalformedDetails([{ rawIndex: 0, reasonCode: 'K'.repeat(1000) }], findings);
    assert.ok(b.reasonCode.length <= 120);
  });

  it('validates rawIndex instead of indexing garbage', () => {
    for (const bad of [-1, 9999, null, undefined, 1.5, 'x']) {
      const [b] = boundMalformedDetails([{ rawIndex: bad, reasonCode: 'x', reasonDetail: 'd' }], findings);
      assert.equal(b.exemplars[0].rawIndex, null, `rawIndex ${bad} must not resolve`);
      assert.equal(b.exemplars[0].rawAnchor, null, 'an unresolvable index yields a null anchor, not a throw');
    }
  });

  it('handles an empty input', () => {
    assert.deepEqual(boundMalformedDetails([], findings), []);
  });
});

describe('persisted diagnostics are redacted (audit R1-H1)', () => {
  it('a secret echoed into an anchor does not reach the record', { skip: !boundMalformedDetails }, () => {
    const secretish = 'sk-ant-api03-PERSISTEDSECRETVALUE1234567890';
    const [b] = boundMalformedDetails(
      [{ rawIndex: 0, reasonCode: 'x', reasonDetail: `failed near ${secretish}` }],
      [{ anchor: `quote containing ${secretish}` }],
    );
    // These fields were DISCARDED before this change; persisting them widens
    // the blast radius of anything sensitive that reached the prompt, so
    // bounding alone is not an egress control.
    assert.ok(!b.exemplars[0].reasonDetail.includes('PERSISTEDSECRETVALUE'), 'reasonDetail must be redacted');
    assert.ok(!b.exemplars[0].rawAnchor.includes('PERSISTEDSECRETVALUE'), 'rawAnchor must be redacted');
  });

  it('redaction runs BEFORE the length cap (order matters)', { skip: !boundMalformedDetails }, () => {
    // Clipping first could sever a secret mid-token, leaving a prefix the
    // redactor no longer recognises but which is still sensitive.
    const [b] = boundMalformedDetails(
      [{ rawIndex: 0, reasonCode: 'x', reasonDetail: 'A'.repeat(490) + 'sk-ant-api03-TAILSECRET1234567890' }],
      [{ anchor: 'a' }],
    );
    assert.ok(!b.exemplars[0].reasonDetail.includes('TAILSECRET'));
  });
});

describe('Gemini gate fixes', () => {
  it('G1: an absent detail stays null, not the string "null"', { skip: !boundMalformedDetails }, () => {
    const [b] = boundMalformedDetails([{ rawIndex: 0, reasonCode: 'x' }], [{ anchor: null }]);
    assert.equal(b.exemplars[0].reasonDetail, null, 'absent must not become a 4-char literal that reads like data');
    assert.equal(b.exemplars[0].rawAnchor, null);
  });

  it('G3: truncation does not sever a surrogate pair', { skip: !boundMalformedDetails }, () => {
    // Cap is 500 for reasonDetail; land the cut mid-emoji.
    const detail = 'a'.repeat(499) + '😀tail';
    const [b] = boundMalformedDetails([{ rawIndex: 0, reasonCode: 'x', reasonDetail: detail }], [{ anchor: 'a' }]);
    const out = b.exemplars[0].reasonDetail;
    assert.equal([...out].every((ch) => ch.codePointAt(0) !== 0xfffd), true, 'no replacement char');
    const lastCode = out.charCodeAt(out.length - 1);
    assert.ok(!(lastCode >= 0xd800 && lastCode <= 0xdbff), 'must not end on a lone high surrogate');
  });

  it('G4: a model-emitted "__other" cannot collide with the harness sentinel', { skip: !boundMalformedDetails }, () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ rawIndex: i, reasonCode: `c${i}`, reasonDetail: 'd' }));
    const hostile = Array.from({ length: 50 }, (_, i) => ({ rawIndex: 200 + i, reasonCode: '__other', reasonDetail: 'd' }));
    const out = boundMalformedDetails([...many, ...hostile], Array.from({ length: 300 }, () => ({ anchor: 'a' })));
    const keys = out.map((b) => b.reasonCode);
    assert.equal(new Set(keys).size, keys.length, 'no two buckets may share a key');
  });
});
