/**
 * A thinking-capable model's FIRST content block is not its answer, and a cap
 * that was ignored on `cli` is ENFORCED on `sdk`.
 *
 * **Why this suite exists.** Pinning the `system`-passing call sites to the sdk
 * backend (docs/plans/anthropic-cli-faithfulness-routing.md) changed two things
 * about every one of them at once:
 *
 *   1. `max_tokens` went from **accepted and ignored** to **enforced to the
 *      token**. `work-unit-labels` asked for 64. Measured 2026-11-15 against
 *      `claude-haiku-5-5` on that exact prompt: the whole 64 goes to a
 *      `thinking` block, `stop_reason: max_tokens`, and the response carries NO
 *      text block — so every label came back underived. The pin turned a
 *      working call into a dead one, which is a regression the pin introduced
 *      and not a pre-existing defect.
 *   2. The response shape gained a leading `thinking` block, so
 *      `content[0].text` is `undefined`. THREE call sites had that read
 *      independently — the brief in `context.mjs` (dead in every audit run),
 *      the labeller, and `refine-prompts`.
 *
 * Both are one question with one answer: `textFromResponse` at the seam, and a
 * cap sized to the answer PLUS what the model spends getting there. These tests
 * hold that answer in place with the real response shapes rather than with a
 * hand-written factory that could only encode what the reader already expects.
 *
 * @module tests/anthropic-thinking-block-reads
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { textFromResponse } from '../scripts/lib/anthropic-client.mjs';
import { labelWorkUnits } from '../scripts/lib/work-unit-labels.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The shape the API actually returned at `max_tokens: 64` — recorded from a
 * live call, not invented. A hand-written factory would encode what the reader
 * expects, which is the assumption under test.
 */
const THINKING_ONLY = Object.freeze({
  content: [{ type: 'thinking', thinking: 'weighing the label…' }],
  stop_reason: 'max_tokens',
  usage: { output_tokens: 64, output_tokens_details: { thinking_tokens: 64 } },
});

/** The shape at a sufficient cap: thinking FIRST, then the answer. */
const THINKING_THEN_TEXT = Object.freeze({
  content: [
    { type: 'thinking', thinking: 'weighing the label…' },
    { type: 'text', text: 'store writes that swallow failures' },
  ],
  stop_reason: 'end_turn',
  usage: { output_tokens: 168, output_tokens_details: { thinking_tokens: 149 } },
});

describe('textFromResponse: the answer is the TEXT block, wherever it sits', () => {
  it('RED for the index-0 read: a thinking-only response yields no text', () => {
    assert.equal(textFromResponse(THINKING_ONLY), '');
    // The read every one of the three sites used, shown failing on the same input.
    assert.equal(THINKING_ONLY.content?.[0]?.text, undefined,
      'this is why `content[0].text` returned undefined from a good response');
  });

  it('skips a LEADING thinking block and returns the answer', () => {
    assert.equal(textFromResponse(THINKING_THEN_TEXT), 'store writes that swallow failures');
    assert.equal(THINKING_THEN_TEXT.content[0].text, undefined,
      'the index-0 read would have returned undefined here too — from a complete response');
  });

  it('joins several text blocks', () => {
    assert.equal(textFromResponse({ content: [
      { type: 'text', text: 'a' }, { type: 'thinking', thinking: 'x' }, { type: 'text', text: 'b' },
    ] }), 'ab');
  });

  it('is empty, not a throw, for a malformed or absent response', () => {
    assert.equal(textFromResponse(undefined), '');
    assert.equal(textFromResponse({}), '');
    assert.equal(textFromResponse({ content: null }), '');
    assert.equal(textFromResponse({ content: [{ type: 'text' }] }), '', 'a text block with no text');
  });

  it('does NOT read a tool_use or an unknown block as text', () => {
    assert.equal(textFromResponse({ content: [
      { type: 'tool_use', name: 'x', input: {} }, { type: 'image', text: 'not text' },
    ] }), '');
  });
});

describe('the labeller survives a thinking-first response', () => {
  // `labelWorkUnits` writes its cache under `<repoRoot>/.audit`, so each case
  // needs its own root. Tracked and removed rather than left behind: these are
  // real directories in the repo's own gitignored `.audit/`, and a suite that
  // leaks one per run accumulates them invisibly (the first version of this
  // file left two per `npm test`).
  const roots = [];
  const freshRoot = () => {
    const dir = fs.mkdtempSync(path.join(REPO_ROOT, '.audit', 'wul-think-'));
    roots.push(dir);
    return dir;
  };
  after(() => {
    for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('a thinking-only response yields NO label, and says so', async () => {
    const res = await labelWorkUnits(
      [{ key: 'k1', size: 3, category: 'cat', detail: 'd', members: [{}, {}, {}] }],
      {
        repoRoot: freshRoot(),
        // The labeller contract is `(unit) => string|null`; the seam's reader
        // has already turned a thinking-only response into ''.
        labellerProvider: async () => async () => textFromResponse(THINKING_ONLY) || null,
      },
    );
    assert.equal(res.labelled, 0);
    assert.equal(res.units[0].labelSource, 'underived', 'never a label invented from nothing');
  });

  it('a thinking-then-text response DOES yield the label', async () => {
    const res = await labelWorkUnits(
      [{ key: 'k2', size: 3, category: 'cat', detail: 'd', members: [{}, {}, {}] }],
      {
        repoRoot: freshRoot(),
        labellerProvider: async () => async () => textFromResponse(THINKING_THEN_TEXT) || null,
      },
    );
    assert.equal(res.labelled, 1);
    assert.equal(res.units[0].label, 'store writes that swallow failures');
  });
});

// The caps are a MEASUREMENT, so they are pinned as one: a future edit that
// lowers them back toward the model's thinking budget reproduces the regression,
// and the number in the source is the only place that fact lives.
describe('the pinned caps are sized to the answer PLUS the thinking', () => {
  const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

  it('work-unit-labels asks for far more than the 64 that returned nothing', () => {
    const src = read('scripts/lib/work-unit-labels.mjs');
    const m = src.match(/max_tokens:\s*(\d+)/);
    assert.ok(m, 'the labeller still sets a cap');
    assert.ok(Number(m[1]) >= 600, `measured: 64 → no text block, 200 → truncated, 600 → complete; got ${m[1]}`);
  });

  it('refine-prompts asks for more than the 2000 that truncated', () => {
    const m = read('scripts/refine-prompts.mjs').match(/max_tokens:\s*(\d+)/);
    assert.ok(m);
    assert.ok(Number(m[1]) > 2000, `measured: 2000 → stop_reason max_tokens mid-sentence; got ${m[1]}`);
  });

  it("the brief asks for more than the 2000 that returned only thinking", () => {
    const m = read('scripts/lib/context.mjs').match(/max_tokens:\s*(\d+)/);
    assert.ok(m);
    assert.ok(Number(m[1]) >= 4000, `measured: 2000 → thinking_tokens 2000, zero text blocks; got ${m[1]}`);
  });

  it('no pinned site still reads `content[0].text`', () => {
    for (const rel of ['scripts/lib/work-unit-labels.mjs', 'scripts/refine-prompts.mjs', 'scripts/lib/context.mjs']) {
      const code = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      assert.doesNotMatch(code, /content\s*\??\.\s*\[\s*0\s*\]\s*\??\.\s*text/,
        `${rel} must read the TEXT block, not index 0`);
    }
  });
});
