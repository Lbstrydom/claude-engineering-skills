/**
 * @fileoverview The cited-source budget is a HARD ceiling, on input and output.
 *
 * Two audit findings, one budget:
 *
 *  - "Broken resource limit" — `CITED_SOURCE_MAX_CHARS` was not enforced.
 *    `clampChars` trimmed whole lines from the tail and only broke on overflow
 *    AFTER keeping at least one, so a single minified or generated line passed
 *    through whole. A limit with an exception is not a limit.
 *  - "Unbounded resource consumption" — the excerpt was capped in lines,
 *    characters and file COUNT, but `gitShowFileAtRevision` materialises the
 *    entire blob first. The only ceiling on the input was `spawnSync`'s 20MB
 *    `maxBuffer`: an accident of the transport, surfacing as an opaque ENOBUFS
 *    rather than a reason an adjudicator can read.
 *
 * Both sit on a spend-bearing path (cited sources are sent to a paid
 * adjudicator), which is why the bound has to hold for hostile inputs rather
 * than merely typical ones.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  centredWindow, resolveCitedSources,
  CITED_SOURCE_MAX_CHARS, CITED_SOURCE_MAX_BYTES,
} from '../scripts/campaign.mjs';

describe('centredWindow — the character ceiling holds unconditionally', () => {
  it('cuts a single line longer than the entire budget', () => {
    const out = centredWindow('x'.repeat(500_000), 1);
    assert.ok(out.text.length <= CITED_SOURCE_MAX_CHARS,
      `one 500k line must not pass a ${CITED_SOURCE_MAX_CHARS} budget (got ${out.text.length})`);
    assert.equal(out.truncated, true);
  });

  it('the truncation marker is paid for OUT of the budget, not added on top', () => {
    // The marker itself is ~60 chars; a budget smaller than the marker is the
    // case where "reserve room for it" still overflows.
    for (const budget of [10, 40, 80, 500]) {
      const out = centredWindow('y'.repeat(50_000), 1, 240, budget);
      assert.ok(out.text.length <= budget,
        `budget ${budget} exceeded: got ${out.text.length}`);
    }
  });

  it('survives numbers that merely look numeric, rather than disabling the bound', () => {
    // `text.length <= NaN` is false and `slice(0, NaN)` is empty — either way a
    // caller could defeat the ceiling by passing one of these.
    for (const bad of [NaN, Infinity, 0, -1, null, undefined, '24000']) {
      const out = centredWindow('z'.repeat(200_000), 1, 240, bad);
      assert.ok(out.text.length <= CITED_SOURCE_MAX_CHARS,
        `maxChars=${String(bad)} fell back to an unbounded excerpt (${out.text.length})`);
    }
  });

  // Vacuous-pass guard: a function returning '' always would satisfy every
  // assertion above.
  it('returns the content untouched when it already fits (negative control)', () => {
    const out = centredWindow('alpha\nbeta\ngamma', 2);
    assert.equal(out.text, 'alpha\nbeta\ngamma');
    assert.equal(out.truncated, false);
    assert.equal(out.startLine, 1);
    assert.equal(out.endLine, 3);
  });
});

describe('resolveCitedSources — the blob is measured before it is read', () => {
  const SECTION = 'scripts/huge.mjs';

  function harness({ bytes }) {
    const reads = [];
    const sources = resolveCitedSources({
      section: SECTION, detail: '', auditedSha: 'abc1234', repoRoot: '/repo',
      blobSize: () => ({ ok: true, bytes }),
      show: (_root, _sha, p) => { reads.push(p); return { ok: true, content: 'line\n'.repeat(10) }; },
    });
    return { ...sources, reads };
  }

  it('an oversized blob is never read at all', () => {
    const out = harness({ bytes: CITED_SOURCE_MAX_BYTES + 1 });
    assert.deepEqual(out.reads, [], 'the whole point is not paying to materialise it');
    assert.equal(out.resolvedAny, false);
    assert.equal(out.sources[0].resolved, false);
    assert.equal(out.sources[0].reason, 'oversized');
  });

  it('reports the size it saw and the budget it applied, so the skip is legible', () => {
    const out = harness({ bytes: CITED_SOURCE_MAX_BYTES + 5 });
    assert.equal(out.sources[0].bytes, CITED_SOURCE_MAX_BYTES + 5);
    assert.equal(out.sources[0].maxBytes, CITED_SOURCE_MAX_BYTES);
  });

  // Vacuous-pass guard: a resolver that skipped everything would pass both.
  it('a blob within budget is read and excerpted (negative control)', () => {
    const out = harness({ bytes: 1000 });
    assert.deepEqual(out.reads, [SECTION]);
    assert.equal(out.resolvedAny, true);
    assert.equal(out.sources[0].resolved, true);
  });

  it('a blob exactly at the budget is allowed — the bound is inclusive', () => {
    const out = harness({ bytes: CITED_SOURCE_MAX_BYTES });
    assert.equal(out.sources[0].resolved, true);
  });

  // A size probe that cannot answer must not become a silent skip: an
  // unmeasurable size is not an oversized blob, and the read still has its own
  // transport ceiling behind it.
  it('falls through to the read when the size probe fails', () => {
    const reads = [];
    const out = resolveCitedSources({
      section: SECTION, detail: '', auditedSha: 'abc1234', repoRoot: '/repo',
      blobSize: () => ({ ok: false, error: { code: 'EXEC_FAILED' } }),
      show: (_r, _s, p) => { reads.push(p); return { ok: true, content: 'x\n' }; },
    });
    assert.deepEqual(reads, [SECTION]);
    assert.equal(out.sources[0].resolved, true);
  });
});
