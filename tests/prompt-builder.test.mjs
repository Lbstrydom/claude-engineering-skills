import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAuditPassPrompt,
  estimateTokens,
  estimateStablePrefixTokens,
  PROMPT_BUILDER_VERSION,
} from '../scripts/lib/audit/prompt-builder.mjs';

const MINIMAL = Object.freeze({
  systemRubric: 'You are auditing for STRUCTURE issues.',
  brief: 'Project: claude-engineering-skills. Stack: js-ts.',
  planSlice: '## File-Level Plan\n- foo.js: bar()',
  code: 'function bar() { return 1; }',
});

describe('buildAuditPassPrompt — minimal fields', () => {
  it('returns system = systemRubric (no round modifier injected)', () => {
    const { system } = buildAuditPassPrompt(MINIMAL);
    assert.equal(system, MINIMAL.systemRubric);
  });

  it('returns 2 messages when no history and no roundModifier (R1 path)', () => {
    const { messages } = buildAuditPassPrompt(MINIMAL);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[1].role, 'user');
  });

  it('msg #1 contains brief + plan + (no fileListContext when empty)', () => {
    const { messages } = buildAuditPassPrompt(MINIMAL);
    assert.match(messages[0].content, /## Project Context\n/);
    assert.match(messages[0].content, /## Plan\n/);
    assert.equal(messages[0].content.includes(MINIMAL.brief), true);
    assert.equal(messages[0].content.includes(MINIMAL.planSlice), true);
  });

  it('msg #2 (last) contains code with default ## Code header (no unit label)', () => {
    const { messages } = buildAuditPassPrompt(MINIMAL);
    const last = messages[messages.length - 1].content;
    assert.match(last, /^## Code\n/);
    assert.equal(last.includes(MINIMAL.code), true);
  });
});

describe('buildAuditPassPrompt — with history (R2+ path)', () => {
  it('returns 3 messages when history present', () => {
    const { messages } = buildAuditPassPrompt({ ...MINIMAL, history: 'DISMISSED: H1 ...' });
    assert.equal(messages.length, 3);
  });

  it('msg #2 contains rulings; msg #1 does NOT', () => {
    const history = 'DISMISSED: H1 — R1 dismissed by claude with evidence...';
    const { messages } = buildAuditPassPrompt({ ...MINIMAL, history });
    assert.equal(messages[0].content.includes(history), false, 'history must not leak into msg #1');
    assert.equal(messages[1].content.includes(history), true);
    assert.match(messages[1].content, /## Prior Rulings\n/);
  });

  it('msg #2 carries roundModifier prefix before rulings', () => {
    const { messages } = buildAuditPassPrompt({
      ...MINIMAL,
      roundModifier: 'ROUND 2+ MODE — verify, do not re-raise dismissed.',
      history: 'DISMISSED: H1',
    });
    assert.equal(messages.length, 3);
    assert.match(messages[1].content, /^ROUND 2\+ MODE/, 'roundModifier must come first in msg #2');
    assert.match(messages[1].content, /## Prior Rulings/);
  });

  it('roundModifier alone (history=null) still produces 3 messages', () => {
    const { messages } = buildAuditPassPrompt({
      ...MINIMAL,
      roundModifier: 'ROUND 2+ MODE',
      history: null,
    });
    assert.equal(messages.length, 3);
    assert.equal(messages[1].content, 'ROUND 2+ MODE');
  });
});

describe('buildAuditPassPrompt — with unitLabel (map-reduce path)', () => {
  it('label appears in last message header only', () => {
    const { messages } = buildAuditPassPrompt({ ...MINIMAL, unitLabel: 'Audit Unit 3/7' });
    const last = messages[messages.length - 1].content;
    assert.match(last, /^## Code \(Audit Unit 3\/7\)\n/);
  });

  it('label does NOT appear in msg #1', () => {
    const { messages } = buildAuditPassPrompt({ ...MINIMAL, unitLabel: 'Audit Unit 3/7' });
    assert.equal(messages[0].content.includes('Audit Unit'), false);
  });
});

describe('buildAuditPassPrompt — fileListContext', () => {
  it('appears in msg #1 when present', () => {
    const fileListContext = '## Files\n- a.js\n- b.js';
    const { messages } = buildAuditPassPrompt({ ...MINIMAL, fileListContext });
    assert.equal(messages[0].content.includes(fileListContext), true);
  });

  it('omitted when empty string', () => {
    const { messages } = buildAuditPassPrompt({ ...MINIMAL, fileListContext: '' });
    assert.equal(messages[0].content.includes('## Files'), false);
  });
});

describe('buildAuditPassPrompt — edge cases', () => {
  it('empty code → msg has "## Code\\n" prefix preserved', () => {
    const { messages } = buildAuditPassPrompt({ ...MINIMAL, code: '' });
    const last = messages[messages.length - 1].content;
    assert.equal(last, '## Code\n');
  });

  it('throws TypeError on missing systemRubric', () => {
    assert.throws(() => buildAuditPassPrompt({ ...MINIMAL, systemRubric: undefined }), TypeError);
  });

  it('throws TypeError on non-string brief', () => {
    assert.throws(() => buildAuditPassPrompt({ ...MINIMAL, brief: 42 }), TypeError);
  });

  it('throws TypeError on null opts', () => {
    assert.throws(() => buildAuditPassPrompt(null), TypeError);
  });
});

describe('buildAuditPassPrompt — cache-invariant: msg #1 byte-stable across 5 calls', () => {
  it('5 consecutive calls with same prefix inputs produce byte-identical msg #1', () => {
    const calls = [
      { ...MINIMAL, code: 'code A', unitLabel: 'Unit 1/5' },
      { ...MINIMAL, code: 'code B', unitLabel: 'Unit 2/5' },
      { ...MINIMAL, code: 'code C', unitLabel: 'Unit 3/5', history: 'ruling X' },
      { ...MINIMAL, code: 'code D', unitLabel: 'Unit 4/5', history: 'ruling Y', roundModifier: 'R2 mode' },
      { ...MINIMAL, code: 'code E', unitLabel: 'Unit 5/5' },
    ];
    const msg1s = calls.map(c => buildAuditPassPrompt(c).messages[0].content);
    for (let i = 1; i < msg1s.length; i++) {
      assert.equal(msg1s[i], msg1s[0], `call #${i} msg #1 must match call #0`);
    }
  });
});

describe('buildAuditPassPrompt — R1/R2/R3 cache-invariant (Gemini-R1/H1 fix)', () => {
  it('system + msg #1 byte-identical across R1 (null), R2 (rulingsA), R3 (rulingsB)', () => {
    const base = { ...MINIMAL };
    const r1 = buildAuditPassPrompt({ ...base, history: null, roundModifier: null });
    const r2 = buildAuditPassPrompt({ ...base, history: 'rulings A', roundModifier: 'R2 mode' });
    const r3 = buildAuditPassPrompt({ ...base, history: 'rulings B', roundModifier: 'R3 mode' });
    assert.equal(r1.system, r2.system, 'system must be byte-identical R1 vs R2');
    assert.equal(r1.system, r3.system, 'system must be byte-identical R1 vs R3');
    assert.equal(r1.messages[0].content, r2.messages[0].content, 'msg #1 byte-identical R1 vs R2');
    assert.equal(r1.messages[0].content, r3.messages[0].content, 'msg #1 byte-identical R1 vs R3');
  });
});

describe('estimateTokens / estimateStablePrefixTokens', () => {
  it('estimateTokens returns ceil(text.length/4) for non-empty', () => {
    assert.equal(estimateTokens('hello world'), Math.ceil(11 / 4));
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens(undefined), 0);
  });

  it('estimateStablePrefixTokens sums system + msg #1', () => {
    const est = estimateStablePrefixTokens(MINIMAL);
    const expected = Math.ceil(MINIMAL.systemRubric.length / 4)
      + Math.ceil(buildAuditPassPrompt({ ...MINIMAL, history: null, roundModifier: null }).messages[0].content.length / 4);
    assert.equal(est, expected);
  });

  it('estimateStablePrefixTokens excludes round-varying msg #2', () => {
    const withHistory = estimateStablePrefixTokens({ ...MINIMAL, history: 'long ruling text' });
    const withoutHistory = estimateStablePrefixTokens(MINIMAL);
    assert.equal(withHistory, withoutHistory, 'estimate must ignore history (stable prefix is system+msg1 only)');
  });
});

describe('PROMPT_BUILDER_VERSION', () => {
  it('exported as a non-empty semver-ish string', () => {
    assert.ok(typeof PROMPT_BUILDER_VERSION === 'string' && PROMPT_BUILDER_VERSION.length > 0);
  });
});
