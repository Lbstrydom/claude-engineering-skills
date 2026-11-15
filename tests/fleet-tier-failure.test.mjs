/**
 * @fileoverview A red tier's failure summary (consumer report 2026-11-15: a red train hid its failure behind a log path).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { failureSummary, redTierLines } from '../scripts/lib/fleet/tier-failure.mjs';

describe('failureSummary', () => {
  it('pytest: the short test summary block, and nothing around it', () => {
    const s = failureSummary('a PASSED\n\u001b[31m===== short test summary info =====\u001b[0m\nFAILED t.py::x - boom\n\nERROR t.py::y\n===== 1 failed =====\ntrailer');
    assert.deepEqual(s, { kind: 'pytest', lines: ['FAILED t.py::x - boom', 'ERROR t.py::y'] });
  });
  it('other runners: the last FAILED/ERROR/not ok lines', () => {
    const s = failureSummary('ok 1 - a\nnot ok 2 - b\n  AssertionError: x\nok 3 - c\nnot ok 4 - d\n# fail 2\n');
    assert.equal(s.kind, 'fail-lines');
    assert.deepEqual(s.lines, ['not ok 2 - b', '  AssertionError: x', 'not ok 4 - d']);
  });
  it('no recognisable failure lines: the last lines of the log; an empty log says so', () => {
    assert.deepEqual(failureSummary('one\ntwo\n\nthree\n'), { kind: 'tail', lines: ['one', 'two', 'three'] });
    assert.deepEqual(failureSummary(''), { kind: 'empty', lines: [] });
  });
  it('is bounded', () => {
    const many = Array.from({ length: 50 }, (_, i) => `FAILED t${i}`).join('\n');
    assert.equal(failureSummary(many).lines.length, 20);
    assert.equal(failureSummary(many).lines.at(-1), 'FAILED t49');
  });
});

describe('redTierLines', () => {
  it('summarises only red tiers, and names an unreadable log', () => {
    const train = { tierResults: [{ name: 'fast', result: 'green', logPath: 'f' }, { name: 'full', result: 'red', logPath: 'g' }, { name: 'x', result: 'red', logPath: 'h' }] };
    const lines = redTierLines(train, { read: (p) => (p === 'g' ? 'FAILED a::b' : null) });
    assert.deepEqual(lines, ['  tier full failed — failing lines:', '    FAILED a::b', '  tier x failed — no log to summarise (h unreadable)']);
  });
});
