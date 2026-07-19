/**
 * @fileoverview A truncated response must never render as a complete one.
 *
 * Both adapters read `finishReason` to detect `blocked` and `empty`, but a
 * length-truncated finish WITH partial text fell through to
 * `state: 'success'` — so a mid-sentence fragment was rendered to the user
 * as a peer's finished view, beside a genuinely complete one. Field-observed
 * on gemini-pro-latest 2026-07-19 (text began mid-word).
 *
 * AGENTS.md: "audit your success paths — ask whether this can return green
 * without having actually checked anything."
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { _classifyCompletion as classifyOpenAI } from '../scripts/lib/brainstorm/openai-adapter.mjs';
import { _classifyCompletion as classifyGemini } from '../scripts/lib/brainstorm/gemini-adapter.mjs';

const CASES = [
  { name: 'openai', fn: classifyOpenAI, lengthReason: 'length', okReason: 'stop', blockReason: 'content_filter' },
  { name: 'gemini', fn: classifyGemini, lengthReason: 'MAX_TOKENS', okReason: 'STOP', blockReason: 'SAFETY' },
];

for (const c of CASES) {
  test(`${c.name}: complete response is success`, () => {
    const r = c.fn({ text: 'A full considered answer.', finishReason: c.okReason });
    assert.equal(r.state, 'success');
    assert.equal(r.text, 'A full considered answer.');
  });

  test(`${c.name}: length-truncated WITH text is 'truncated', never 'success'`, () => {
    const r = c.fn({ text: 'This answer stops mid-sent', finishReason: c.lengthReason });
    assert.equal(r.state, 'truncated',
      'a fragment presented as success is the bug this suite exists to prevent');
    assert.ok(r.errorMessage, 'truncation must be explained to the user');
  });

  test(`${c.name}: truncated response KEEPS its partial text`, () => {
    const r = c.fn({ text: 'Partial but useful reasoning', finishReason: c.lengthReason });
    assert.equal(r.text, 'Partial but useful reasoning',
      'the fragment is still worth showing — it must be labelled, not discarded');
  });

  test(`${c.name}: length-truncated with NO text stays 'empty'`, () => {
    const r = c.fn({ text: '', finishReason: c.lengthReason });
    assert.equal(r.state, 'empty', 'nothing to show is empty, not truncated');
  });

  test(`${c.name}: blocked still wins over truncation`, () => {
    const r = c.fn({ text: 'partial', finishReason: c.blockReason });
    assert.equal(r.state, 'blocked');
    assert.equal(r.text, null, 'blocked content must not be surfaced');
  });

  test(`${c.name}: unknown finishReason with text is success (no false alarm)`, () => {
    const r = c.fn({ text: 'complete answer', finishReason: null });
    assert.equal(r.state, 'success');
  });
}
