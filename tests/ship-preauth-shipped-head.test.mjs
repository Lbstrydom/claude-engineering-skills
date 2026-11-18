/**
 * @fileoverview The coordinator batch re-check, as a PURE decision: `evaluateShippedHead` (scripts/lib/ship-preauth.mjs) and
 * the ship-step delta grammar `isShipStepDelta` (scripts/lib/ship-record/authority.mjs).
 * Plan: docs/plans/coordinator-aggregate-ship.md section 2.3 (C1-C5).
 *
 * Tier 1: every condition fails ALONE with its own reason, one row in which all hold, and the direction each rule must NOT
 * fire. The AI-Gate honesty cases (waived / not-run / a forged trailer) are the negative controls of this gate.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateShippedHead, SHIPPED_HEAD_CONDITIONS, renderShippedHeadConditions,
} from '../scripts/lib/ship-preauth.mjs';
import { isShipStepDelta } from '../scripts/lib/ship-record/authority.mjs';

const RUN = '981fc79a-0fbb-447a-a294-b0c0217dab71';
const OTHER_RUN = '11111111-2222-4333-8444-555555555555';
const TREE = 'ca77e929e43535fdee278229eed00a08cde80f59';
const OTHER_TREE = '4ca9f5a05945f5495eae1f6b4128406a3af46ab9';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const REPO = 'repo-row-1';

const trailers = (over = {}) => {
  const base = {
    'AI-Skill': 'ship', 'AI-Models': 'claude,gpt', 'AI-Gate': 'converged', 'AI-Run-ID': RUN,
    'AI-Final-Review': 'approve', 'AI-Ship-Authority': 'launch-prompt',
  };
  return Object.entries({ ...base, ...over }).filter(([, v]) => v !== null).map(([key, value]) => ({ key, value }));
};
const evidence = (extra = {}) => ({ runId: RUN, auditedTree: TREE, auditedSha: SHA, round: 4, auditedBranch: 'claude/x', ...extra });
const finalReview = (extra = {}) => ({ ok: true, marker: { runId: RUN, auditedTree: TREE, round: 4, verdict: 'APPROVE', disposition: 'approve', ts: '2026-11-18T07:00:00.000Z', ...extra } });
const runRow = (extra = {}) => ({ repoId: REPO, roundConvergedAfter: 4, auditedTree: TREE, geminiVerdict: 'APPROVE', ...extra });

/** Facts under which every condition holds. */
const GOOD = () => ({
  trailers: trailers(), evidence: evidence(), currentBranch: 'claude/x', runRow: runRow(), repoId: REPO,
  finalReview: finalReview(), delta: { ok: true, reason: 'empty delta' }, changedPaths: ['scripts/lib/foo.mjs', 'tests/foo.test.mjs'],
});
const failing = (v) => v.conditions.filter((c) => !c.ok).map((c) => c.id);
const reasonOf = (v, id) => v.conditions.find((c) => c.id === id).reason;

describe('evaluateShippedHead: all conditions hold', () => {
  it('passes with one satisfied row per condition, in the declared order', () => {
    const v = evaluateShippedHead(GOOD());
    assert.equal(v.ok, true, v.refusals.join('\n'));
    assert.deepEqual(v.conditions.map((c) => c.id), [...SHIPPED_HEAD_CONDITIONS]);
    assert.deepEqual(failing(v), []);
    assert.equal(v.gate, 'converged');
    assert.equal(v.runId, RUN);
  });
  it('`passed` is as acceptable as `converged`', () => {
    const f = GOOD(); f.trailers = trailers({ 'AI-Gate': 'passed' });
    assert.equal(evaluateShippedHead(f).ok, true);
  });
  it('renders one printable line per condition', () => {
    const lines = renderShippedHeadConditions(evaluateShippedHead(GOOD()));
    assert.equal(lines.length, SHIPPED_HEAD_CONDITIONS.length);
    assert.ok(lines.every((l) => /ok\s+\S/.test(l)));
  });
});

describe('evaluateShippedHead: AI-Gate honesty (the negative controls)', () => {
  for (const gate of ['waived', 'not-run']) {
    it(`a ${gate} member NEVER ships under the grant`, () => {
      const f = GOOD(); f.trailers = trailers({ 'AI-Gate': gate });
      const v = evaluateShippedHead(f);
      assert.equal(v.ok, false);
      assert.deepEqual(failing(v), ['trailers']);
      assert.match(reasonOf(v, 'trailers'), new RegExp(gate));
    });
  }
  it('a forged `converged` trailer with no converged run in the store is refused by the EVIDENCE row, not the trailer row', () => {
    const f = GOOD(); f.runRow = runRow({ roundConvergedAfter: null });
    const v = evaluateShippedHead(f);
    assert.deepEqual(failing(v), ['evidence']);
    assert.match(reasonOf(v, 'evidence'), /did not converge/);
  });
  it('the evaluator never reports a gate other than the one the trailer carries (it reads, never raises)', () => {
    const f = GOOD(); f.trailers = trailers({ 'AI-Gate': 'waived' });
    assert.notEqual(evaluateShippedHead(f).gate, 'passed');
    assert.notEqual(evaluateShippedHead(f).gate, 'converged');
  });
  it('an AI-Gate trailer that appears twice is refused (a block with two gates is not a gate)', () => {
    const f = GOOD(); f.trailers = [...trailers(), { key: 'AI-Gate', value: 'passed' }];
    assert.deepEqual(failing(evaluateShippedHead(f)), ['trailers']);
  });
});

describe('evaluateShippedHead: each condition fails ALONE with its own reason', () => {
  const cases = [
    ['trailers: unreadable message', (f) => { f.trailers = null; }, ['trailers', 'evidence'], /could not be read/],
    ['trailers: no trailer block (inline-only text)', (f) => { f.trailers = []; }, ['trailers', 'evidence'], /AI-Skill/],
    ['trailers: wrong skill', (f) => { f.trailers = trailers({ 'AI-Skill': 'plan' }); }, 'trailers', /AI-Skill/],
    ['trailers: no ship authority', (f) => { f.trailers = trailers({ 'AI-Ship-Authority': null }); }, 'trailers', /AI-Ship-Authority/],
    ['trailers: authority is a record-catchup', (f) => { f.trailers = trailers({ 'AI-Ship-Authority': 'record-catchup' }); }, 'trailers', /launch-prompt/],
    ['trailers: no final review trailer', (f) => { f.trailers = trailers({ 'AI-Final-Review': null }); }, 'trailers', /AI-Final-Review/],
    ['trailers: approve-with-debt is not approve', (f) => { f.trailers = trailers({ 'AI-Final-Review': 'approve-with-debt' }); }, 'trailers', /approve-with-debt/],
    ['trailers: no run id', (f) => { f.trailers = trailers({ 'AI-Run-ID': null }); }, ['trailers', 'evidence'], /AI-Run-ID/],
    ['evidence: no marker', (f) => { f.evidence = null; f.evidenceWhy = 'there is no usable gate-evidence marker'; }, ['evidence', 'final-review'], /no usable gate-evidence marker/],
    ['evidence: marker run differs from the trailer run', (f) => { f.evidence = evidence({ runId: OTHER_RUN }); }, ['evidence', 'final-review'], /AI-Run-ID/],
    ['evidence: audited branch is another branch', (f) => { f.evidence = evidence({ auditedBranch: 'claude/y' }); }, 'evidence', /branch/],
    ['evidence: audited branch unknown', (f) => { f.evidence = evidence({ auditedBranch: null }); }, 'evidence', /branch identity is unknown/],
    ['evidence: the shipping branch is unknown (detached)', (f) => { f.currentBranch = null; }, 'evidence', /branch identity is unknown/],
    ['evidence: store row unreadable', (f) => { f.runRow = null; f.runRowWhy = 'cloud store is off'; }, ['evidence', 'final-review'], /cloud store is off/],
    ['evidence: run belongs to another repository', (f) => { f.runRow = runRow({ repoId: 'repo-row-2' }); }, 'evidence', /another repository/],
    ['evidence: this repository could not be resolved', (f) => { f.repoId = null; }, 'evidence', /repository identity/],
    ['evidence: store audited tree differs from the marker', (f) => { f.runRow = runRow({ auditedTree: OTHER_TREE }); }, 'evidence', /audited tree/],
    ['final-review: no marker', (f) => { f.finalReview = { ok: false, reason: 'absent' }; }, 'final-review', /absent/],
    ['final-review: for another tree', (f) => { f.finalReview = finalReview({ auditedTree: OTHER_TREE }); }, 'final-review', /different audited tree/],
    ['final-review: for another round', (f) => { f.finalReview = finalReview({ round: 3 }); }, 'final-review', /round 3/],
    ['final-review: verdict is not APPROVE', (f) => { f.finalReview = finalReview({ verdict: 'CONCERNS', disposition: 'approve_with_debt' }); }, 'final-review', /CONCERNS/],
    ['final-review: result is blocked', (f) => { f.finalReview = finalReview({ disposition: 'blocked' }); }, 'final-review', /not approve/],
    ['final-review: the store verdict contradicts the marker', (f) => { f.runRow = runRow({ geminiVerdict: 'REJECT' }); }, 'final-review', /REJECT/],
    ['final-review: the store recorded no verdict', (f) => { f.runRow = runRow({ geminiVerdict: null }); }, 'final-review', /final-review-unrecorded/],
    ['post-audit-delta: a path changed after the audit', (f) => { f.delta = { ok: false, reason: 'scripts/x.mjs: outside the ship-step allowlist' }; }, 'post-audit-delta', /outside the ship-step allowlist/],
    ['post-audit-delta: not measured', (f) => { f.delta = null; }, 'post-audit-delta', /not measured/],
    ['sensitive-path', (f) => { f.changedPaths = ['scripts/x.mjs', '.env']; }, 'sensitive-path', /\.env/],
    ['migration', (f) => { f.changedPaths = ['supabase/migrations/20261118_x.sql']; }, 'migration', /migration/],
    ['repo-policy', (f) => { f.changedPaths = ['.github/workflows/ci.yml']; }, 'repo-policy', /\.github/],
  ];
  // `ids` lists every row that must refuse: a fact two rows share (the run id, the evidence marker, the store row) refuses both,
  // and the FIRST id is the one whose own reason the pattern matches.
  for (const [name, mutate, want, re] of cases) {
    const ids = Array.isArray(want) ? want : [want];
    it(name, () => {
      const f = GOOD(); mutate(f);
      const v = evaluateShippedHead(f);
      assert.equal(v.ok, false, 'must refuse');
      assert.deepEqual(failing(v), ids, `expected exactly ${ids.join(', ')} to fail: ${v.refusals.join(' | ')}`);
      assert.match(reasonOf(v, ids[0]), re);
    });
  }
  it('an empty or unresolvable change set fails all three path rows, never a vacuous pass', () => {
    for (const changedPaths of [[], null]) {
      const f = GOOD(); f.changedPaths = changedPaths;
      assert.deepEqual(failing(evaluateShippedHead(f)), ['sensitive-path', 'migration', 'repo-policy']);
    }
  });
  it('an ordinary file passes every path rule (the direction it must NOT fire)', () => {
    const f = GOOD(); f.changedPaths = ['scripts/lib/x.mjs', 'docs/plans/x.md', 'docs/status/entries/2026-11-18-070000-x.md'];
    assert.equal(evaluateShippedHead(f).ok, true);
  });
  it('an empty fact object refuses everything, never throws', () => {
    const v = evaluateShippedHead({});
    assert.equal(v.ok, false);
    assert.deepEqual(failing(v), [...SHIPPED_HEAD_CONDITIONS]);
  });
});

// ---- the ship-step delta grammar (C4) --------------------------------------------------------------------------------------
const PLAN_OLD = ['# Plan: X', '- **Status**: Draft', '', '## Context', 'body', '', '## Phase 1', 'work', ''].join('\n');
const entryName = 'docs/status/entries/2026-11-18-070000-ship-x.md';

describe('isShipStepDelta: what a ship may add after the audit', () => {
  it('(a) a new status entry file passes', () => {
    assert.equal(isShipStepDelta({ status: 'A', rel: entryName, oldText: null, newText: '## Ship\nx\n' }), null);
  });
  it('(a) a status entry with a malformed name refuses', () => {
    assert.match(isShipStepDelta({ status: 'A', rel: 'docs/status/entries/notes.md', oldText: null, newText: 'x' }), /name/);
  });
  it('(a) an EXISTING entry being modified refuses (entries are immutable)', () => {
    assert.match(isShipStepDelta({ status: 'M', rel: entryName, oldText: 'a', newText: 'b' }), /new file/);
  });
  it('(c) a plan: Status line plus an appended Implementation Log passes', () => {
    const next = PLAN_OLD.replace('Draft', 'Implemented') + '\n## Implementation Log\n- shipped\n';
    assert.equal(isShipStepDelta({ status: 'M', rel: 'docs/plans/x.md', oldText: PLAN_OLD, newText: next }), null);
  });
  it('(c) a plan that ALREADY has a log may gain lines inside it', () => {
    const withLog = PLAN_OLD + '## Implementation Log\n- r1\n';
    const next = withLog + '- r2 shipped\n';
    assert.equal(isShipStepDelta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: next }), null);
  });
  it('(c) the NORMAL case: a plan the branch changed before its audit gets only a ship edit after it', () => {
    // The audited tree already holds the branch edit (a Context line), and the ship adds Status + Log only.
    const audited = PLAN_OLD.replace('body', 'body, as audited');
    const next = audited.replace('Draft', 'Implemented') + '\n## Implementation Log\n- shipped\n';
    assert.equal(isShipStepDelta({ status: 'M', rel: 'docs/plans/x.md', oldText: audited, newText: next }), null);
  });
  it('(c) a plan body edit outside Status and the log refuses', () => {
    const next = PLAN_OLD.replace('work', 'different work');
    assert.match(isShipStepDelta({ status: 'M', rel: 'docs/plans/x.md', oldText: PLAN_OLD, newText: next }), /outside/);
  });
  it('(c) a plan edit to the Status line AND a body line refuses on the body line', () => {
    const next = PLAN_OLD.replace('Draft', 'Implemented').replace('body', 'changed');
    assert.match(isShipStepDelta({ status: 'M', rel: 'docs/plans/x.md', oldText: PLAN_OLD, newText: next }), /outside/);
  });
  it('(c) deleting a body line refuses', () => {
    const next = PLAN_OLD.replace('body\n', '');
    assert.match(isShipStepDelta({ status: 'M', rel: 'docs/plans/x.md', oldText: PLAN_OLD, newText: next }), /outside/);
  });
  it('(c) CRLF on one side does not read as a whole-file change', () => {
    const next = (PLAN_OLD.replace('Draft', 'Implemented') + '\n## Implementation Log\n- shipped\n').replace(/\n/g, '\r\n');
    assert.equal(isShipStepDelta({ status: 'M', rel: 'docs/plans/x.md', oldText: PLAN_OLD, newText: next }), null);
  });
  it('(b) legacy status.md: lines inserted before the first entry pass; an edit below it refuses', () => {
    const old = ['# Status', 'intro', '', '## 2026-11-17 old entry', 'old body', ''].join('\n');
    const good = ['# Status', 'intro', '', '## 2026-11-18 new entry', 'new body', '', '## 2026-11-17 old entry', 'old body', ''].join('\n');
    const bad = old.replace('old body', 'rewritten');
    assert.equal(isShipStepDelta({ status: 'M', rel: 'status.md', oldText: old, newText: good }), null);
    assert.match(isShipStepDelta({ status: 'M', rel: 'status.md', oldText: old, newText: bad }), /status\.md/);
  });
  it('a delete refuses', () => {
    assert.match(isShipStepDelta({ status: 'D', rel: 'docs/plans/x.md', oldText: PLAN_OLD, newText: null }), /delet/);
  });
  it('a rename half refuses', () => {
    assert.match(isShipStepDelta({ status: 'R', rel: 'docs/plans/x.md', oldText: PLAN_OLD, newText: PLAN_OLD }), /status/);
  });
  it('code after the audit refuses', () => {
    assert.match(isShipStepDelta({ status: 'M', rel: 'scripts/x.mjs', oldText: 'a', newText: 'b' }), /allowlist/);
  });
  it('a file too large to verify refuses (fail closed)', () => {
    const big = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
    const bigNext = big.replace('line 2000', 'changed 2000');
    assert.match(isShipStepDelta({ status: 'M', rel: 'docs/plans/x.md', oldText: big, newText: bigNext }), /too large|outside/);
  });
});
