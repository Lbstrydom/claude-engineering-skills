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
const runRow = (extra = {}) => ({ repoId: REPO, roundConvergedAfter: 4, auditedTree: TREE, auditedSha: SHA, geminiVerdict: 'APPROVE', ...extra });

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
    ['evidence: the store records a different audited COMMIT than the marker', (f) => { f.runRow = runRow({ auditedSha: 'f'.repeat(40) }); }, 'evidence', /audited COMMIT is not corroborated/],
    ['evidence: the store recorded no audited commit', (f) => { f.runRow = runRow({ auditedSha: null }); }, 'evidence', /audited COMMIT is not corroborated/],
    ['evidence: the marker is from BEFORE the audit converged (round 3 < converged-after 4)', (f) => { f.evidence = evidence({ round: 3 }); f.finalReview = finalReview({ round: 3 }); }, 'evidence', /from before it converged/],
    ['evidence: the store records the run on another branch', (f) => { f.runRow = runRow({ branch: 'claude/other' }); }, 'evidence', /store records the run on branch/],
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
/** Modes default to a regular file on both sides: the mode rules are tested explicitly below. */
const delta = (o) => isShipStepDelta({ oldMode: '100644', newMode: '100644', ...o });
const PLAN_OLD = ['# Plan: X', '- **Status**: Draft', '', '## Context', 'body', '', '## Phase 1', 'work', ''].join('\n');
const entryName = 'docs/status/entries/2026-11-18-070000-ship-x.md';

describe('isShipStepDelta: what a ship may add after the audit', () => {
  it('(a) a new status entry file passes', () => {
    assert.equal(delta({ status: 'A', rel: entryName, oldText: null, newText: '## Ship\nx\n' }), null);
  });
  it('(a) a status entry with a malformed name refuses', () => {
    assert.match(delta({ status: 'A', rel: 'docs/status/entries/notes.md', oldText: null, newText: 'x' }), /name/);
  });
  it('(a) an EXISTING entry being modified refuses (entries are immutable)', () => {
    assert.match(delta({ status: 'M', rel: entryName, oldText: 'a', newText: 'b' }), /new file/);
  });
  it('(c) a plan: Status line plus an appended Implementation Log passes', () => {
    const next = PLAN_OLD.replace('Draft', 'Implemented') + '\n## Implementation Log\n- shipped\n';
    assert.equal(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: PLAN_OLD, newText: next }), null);
  });
  it('(c) a plan that ALREADY has a log may gain lines inside it', () => {
    const withLog = PLAN_OLD + '## Implementation Log\n- r1\n';
    const next = withLog + '- r2 shipped\n';
    assert.equal(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: next }), null);
  });
  it('(c) the NORMAL case: a plan the branch changed before its audit gets only a ship edit after it', () => {
    // The audited tree already holds the branch edit (a Context line), and the ship adds Status + Log only.
    const audited = PLAN_OLD.replace('body', 'body, as audited');
    const next = audited.replace('Draft', 'Implemented') + '\n## Implementation Log\n- shipped\n';
    assert.equal(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: audited, newText: next }), null);
  });
  it('(c) a plan body edit outside Status and the log refuses', () => {
    const next = PLAN_OLD.replace('work', 'different work');
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: PLAN_OLD, newText: next }), /existing line \d+ was changed or removed/);
  });
  it('(c) a plan edit to the Status line AND a body line refuses on the body line', () => {
    const next = PLAN_OLD.replace('Draft', 'Implemented').replace('body', 'changed');
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: PLAN_OLD, newText: next }), /existing line \d+ was changed or removed/);
  });
  it('(c) deleting a body line refuses', () => {
    const next = PLAN_OLD.replace('body\n', '');
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: PLAN_OLD, newText: next }), /existing line \d+ was changed or removed/);
  });
  it('(c) CRLF on one side does not read as a whole-file change', () => {
    const next = (PLAN_OLD.replace('Draft', 'Implemented') + '\n## Implementation Log\n- shipped\n').replace(/\n/g, '\r\n');
    assert.equal(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: PLAN_OLD, newText: next }), null);
  });
  it('(b) legacy status.md: lines inserted before the first entry pass; an edit below it refuses', () => {
    const old = ['# Status', 'intro', '', '## 2026-11-17 old entry', 'old body', ''].join('\n');
    const good = ['# Status', 'intro', '', '## 2026-11-18 new entry', 'new body', '', '## 2026-11-17 old entry', 'old body', ''].join('\n');
    const bad = old.replace('old body', 'rewritten');
    assert.equal(delta({ status: 'M', rel: 'status.md', oldText: old, newText: good }), null);
    assert.match(delta({ status: 'M', rel: 'status.md', oldText: old, newText: bad }), /status\.md/);
  });
  it('a delete refuses', () => {
    assert.match(delta({ status: 'D', rel: 'docs/plans/x.md', oldText: PLAN_OLD, newText: null }), /delet/);
  });
  it('a rename half refuses', () => {
    assert.match(delta({ status: 'R', rel: 'docs/plans/x.md', oldText: PLAN_OLD, newText: PLAN_OLD }), /status/);
  });
  it('code after the audit refuses', () => {
    assert.match(delta({ status: 'M', rel: 'scripts/x.mjs', oldText: 'a', newText: 'b' }), /allowlist/);
  });
  it('a file too large to verify refuses (fail closed)', () => {
    const big = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
    const bigNext = big.replace('line 2000', 'changed 2000');
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: big, newText: bigNext }), /too large|changed or removed/);
  });
});

describe('isShipStepDelta: the hardened grammar (code-audit round 1)', () => {
  const withLog = PLAN_OLD + '## Implementation Log\n- r1 first entry\n- r2 second entry\n';
  it('the log is APPEND-ONLY: rewriting an existing entry refuses', () => {
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: withLog.replace('r1 first entry', 'r1 REWRITTEN') }), /existing line \d+ was changed or removed.*append-only/);
  });
  it('the log is APPEND-ONLY: deleting an existing entry refuses', () => {
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: withLog.replace('- r2 second entry\n', '') }), /append-only/);
  });
  it('a log the ship CREATES mid-document refuses: a heading dropped into Context must not turn the prose around it into "log"', () => {
    const sneaky = PLAN_OLD.replace('body\n', 'body\n\n## Implementation Log\nsmuggled prose that is not a log\n');
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: PLAN_OLD, newText: sneaky }), /must be the last section/);
  });
  it('a look-alike Status line lower down is body text, not the Status field', () => {
    const old = PLAN_OLD.replace('work', '- **Status**: Draft (a quoted example)');
    const next = old.replace('(a quoted example)', '(rewritten)');
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: old, newText: next }), /existing line \d+ was changed or removed/);
  });
  it('the plan\'s real Status field still changes (the control for the look-alike case)', () => {
    assert.equal(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: PLAN_OLD, newText: PLAN_OLD.replace('Draft', 'Complete') }), null);
  });
  for (const mode of ['120000', '160000', '100755', null]) {
    it(`an ADDED status entry with mode ${mode} is not a regular file: refuses`, () => {
      assert.match(delta({ status: 'A', rel: entryName, oldText: null, newText: 'x', newMode: mode }), /not a regular file/);
    });
  }
  it('a plan whose mode changed (or became a symlink) is not a plain line edit: refuses', () => {
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: PLAN_OLD, newText: PLAN_OLD, newMode: '120000' }), /regular-file edit/);
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: PLAN_OLD, newText: PLAN_OLD, oldMode: '100644', newMode: '100755' }), /regular-file edit/);
  });
  it('a new log heading inserted INSIDE the final section (ahead of that section\'s own text) must be appended after the whole document', () => {
    const sneaky = PLAN_OLD.replace('## Phase 1\nwork\n', '## Phase 1\n## Implementation Log\nwork\n');
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: PLAN_OLD, newText: sneaky }), /appended after the whole existing document|existing line/);
  });
  it('a log appended AFTER the final section\'s text is the legitimate shape (the control)', () => {
    assert.equal(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: PLAN_OLD, newText: PLAN_OLD + '\n## Implementation Log\n- shipped\n' }), null);
  });
  it('a LARGE insertion is bounded (never an unbounded per-line rescan) and still correct under the cap', () => {
    const big = Array.from({ length: 50_000 }, (_, i) => `- entry ${i}`).join('\n');
    const t0 = Date.now();
    assert.equal(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: PLAN_OLD, newText: `${PLAN_OLD}\n## Implementation Log\n${big}\n` }), null);
    assert.ok(Date.now() - t0 < 5000, `a 50k-line log insertion took ${Date.now() - t0}ms`);
    const huge = Array.from({ length: 250_000 }, (_, i) => `- entry ${i}`).join('\n');
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: PLAN_OLD, newText: `${PLAN_OLD}\n## Implementation Log\n${huge}\n` }), /too large/);
  });
  it('a SECOND log heading inserted ahead of the real log cannot re-label old prose as "log"', () => {
    const withLog = PLAN_OLD + '## Implementation Log\n- r1\n';
    const sneaky = withLog.replace('## Phase 1\n', '## Implementation Log\nplanted prose\n## Phase 1\n');
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: sneaky }), /more than one .*Implementation Log/);
  });
  it('blank lines are NOT a free pass: a whitespace change outside the log refuses; the separator above a created log is allowed', () => {
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: PLAN_OLD, newText: PLAN_OLD.replace('## Context', '\n## Context') }), /added outside the Status field|existing line/);
    assert.equal(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: PLAN_OLD, newText: PLAN_OLD + '\n## Implementation Log\n- shipped\n' }), null);
  });
  it('text the ship ADDS that opens an HTML comment it does not close refuses (it would swallow what follows the log)', () => {
    const withLog = PLAN_OLD + '## Implementation Log\n- r1\n## Later\ntext after\n';
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: withLog.replace('- r1\n', '- r1\n- r2 <!-- never closed\n') }), /HTML comment it does not close/);
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: withLog.replace('- r1\n', '- r1\n- r2 <!-- a closed note -->\n') }), /contains "</, 'even a BALANCED comment is refused: the forbidden set rejects < outright');
  });
  it('text the ship adds that opens a code fence it does not close refuses', () => {
    const withLog = PLAN_OLD + '## Implementation Log\n- r1\n';
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: withLog + '```js\nunclosed\n' }), /code fence it does not close/);
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: withLog + '```js\nclosed\n```\n' }), /contains a run of backticks or tildes/, 'a CLOSED fence is balanced, but a log line may not be a fence (the pivot)');
  });
  it('a whole document over the size bound refuses BEFORE it is split, even when almost all of it is unchanged', () => {
    const huge = 'x'.repeat(9_000_000);
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: huge, newText: huge + '\n' }), /too large to verify/);
  });
  it('an unknown mode refuses (never a pass)', () => {
    assert.match(isShipStepDelta({ status: 'A', rel: entryName, newText: 'x' }), /not a regular file \(mode unknown\)/);
  });
});

describe('isShipStepDelta: markup balance in BOTH grammars (PR A audit round 2)', () => {
  it('an HTML comment opened in status.md ABOVE the first entry is refused (it would swallow every entry below it)', () => {
    const old = ['# Status', 'intro', '', '## 2026-11-17 old entry', 'old body', ''].join('\n');
    const bad = ['# Status', 'intro', '<!-- never closed', '', '## 2026-11-17 old entry', 'old body', ''].join('\n');
    const good = ['# Status', 'intro', '<!-- a closed note -->', '', '## 2026-11-17 old entry', 'old body', ''].join('\n');
    assert.match(delta({ status: 'M', rel: 'status.md', oldText: old, newText: bad }), /HTML comment it does not close/);
    assert.equal(delta({ status: 'M', rel: 'status.md', oldText: old, newText: good }), null, 'a balanced comment is fine (the control)');
  });
  it('a backtick fence closed by a TILDE fence is still unclosed (type must match), in both grammars', () => {
    const withLog = PLAN_OLD + '## Implementation Log\n- r1\n';
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: withLog + '```js\ncode\n~~~\n' }), /code fence/);
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: withLog + '````\n```\n' }), /code fence/, 'a shorter closer does not close a longer opener');
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: withLog + '````js\ncode\n````\n' }), /contains a run of backticks or tildes/);
  });
});

describe('isShipStepDelta: HTML comments are judged in DOCUMENT ORDER (PR A audit round 3)', () => {
  const withLog = PLAN_OLD + '## Implementation Log\n- r1\n## Later\ntext after\n';
  const add = (line) => withLog.replace('- r1\n', `- r1\n${line}\n`);
  it('"-->" then "<!--" has EQUAL counts but leaves a comment open: refused', () => {
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: add('- r2 --> and <!-- unfinished') }), /closes an HTML comment it did not open/);
  });
  it('a closer with no opener is refused; an opener nested in an open comment is refused; a proper pair is fine', () => {
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: add('- r2 stray -->') }), /did not open/);
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: add('- r2 <!-- a <!-- b -->') }), /inside one it has not closed/);
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: add('- r2 <!-- a --> and <!-- b -->') }), /contains "</, 'a proper pair is balanced, and still refused by the forbidden set');
  });
});

describe('isShipStepDelta: markup is judged IN CONTEXT (PR A audit round 4)', () => {
  const withLog = PLAN_OLD + '## Implementation Log\n- r1 first entry\n- r2 audited paragraph\n';
  it('two fence lines that BALANCE among the additions but surround an existing paragraph are refused (the paragraph would become code)', () => {
    const surrounded = withLog.replace('- r2 audited paragraph\n', '```\n- r2 audited paragraph\n```\n');
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: surrounded }), /would render in a different context/);
  });
  it('a comment pair that balances among the additions but wraps an existing line is refused', () => {
    const wrapped = withLog.replace('- r1 first entry\n', '<!--\n- r1 first entry\n-->\n');
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: wrapped }), /would render in a different context/);
  });
  it('plain list items added AFTER every existing line are fine (the control), and so is prose', () => {
    assert.equal(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: withLog + '- r3 shipped\n\nA closing note in plain prose.\n' }), null);
  });
  it('the same holds for the legacy status.md log', () => {
    const old = ['# Status', 'intro', '', '## 2026-11-17 old entry', 'old body', ''].join('\n');
    const bad = ['# Status', '```', 'intro', '```', '', '## 2026-11-17 old entry', 'old body', ''].join('\n');
    assert.match(delta({ status: 'M', rel: 'status.md', oldText: old, newText: bad }), /different context|rewritten|changed or removed/);
  });
});

describe('isShipStepDelta: raw HTML, headings and fenced delimiters (PR A audit round 5)', () => {
  const withLog = PLAN_OLD + '## Implementation Log\n- r1\n## Next steps\nunchanged section\n';
  const add = (line) => withLog.replace('- r1\n', `- r1\n${line}\n`);
  it('a raw HTML block started in the log (<pre>) is refused: it would swallow the unchanged section after it', () => {
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: add('<pre>') }), /raw HTML block/);
  });
  it('a heading added inside the log (any level, a tab after the hashes) is refused: it starts a new section', () => {
    for (const h of ['# Revised scope', '## Sneaky', '###\tTabbed', '#']) assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: add(h) }), /adds a heading|added outside the Status field/, h);
  });
  it('the ONE allowed heading is the log\'s own, when the ship creates the log (the control)', () => {
    assert.equal(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: PLAN_OLD, newText: PLAN_OLD + '\n## Implementation Log\n- shipped\n' }), null);
  });
  it('a fenced HTML example in the log is refused: not for its comment (delimiters inside a fence are literal) but because a log line may not be a fence', () => {
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: add('```html\n<!-- placeholder\n```') }), /contains a run of backticks or tildes/);
  });
  it('the legacy status.md log still accepts a new ENTRY heading (its entries are headings)', () => {
    const old = ['# Status', 'intro', '', '## 2026-11-17 old entry', 'old body', ''].join('\n');
    const good = ['# Status', 'intro', '', '## 2026-11-18 new entry', 'new body', '', '## 2026-11-17 old entry', 'old body', ''].join('\n');
    assert.equal(delta({ status: 'M', rel: 'status.md', oldText: old, newText: good }), null);
  });
});

describe('isShipStepDelta: the PLAIN-LOG-LINE whitelist (PR A audit round 6, the pivot)', () => {
  const withLog = PLAN_OLD + '## Implementation Log\n- r1\n## Next steps\nunchanged section\n';
  const add = (line) => withLog.replace('- r1\n', `- r1\n${line}\n`);
  for (const [name, line] of [
    ['a link reference definition (it can re-point links elsewhere in the document)', '[ref]: https://example.com'],
    ['a setext underline (it turns the line above into a heading)', '---'],
    ['a setext underline of equals signs', '==='],
    ['a block quote', '> quoted'],
    ['a table row', '| a | b |'],
    ['a 4-space indented code line', '    code'],
    ['a raw HTML tag', '<div>'],
  ]) {
    it(`refuses ${name}`, () => {
      assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: add(line) }), /contains|setext|not a plain list item|added outside the Status field|starts with #|raw HTML block/);
    });
  }
  for (const line of ['- a bullet', '* another', '+ plus', '1. numbered', '2) paren', 'Plain prose.', '**bold lead** then text', '`code` first', '(parenthesised)', '"quoted" start', '  - indented bullet']) {
    it(`accepts a plain line: ${JSON.stringify(line)}`, () => {
      assert.equal(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: add(line) }), null);
    });
  }
  it('a plain line added OUTSIDE the log is still refused by location (the whitelist is in addition to it)', () => {
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: withLog.replace('unchanged section\n', 'unchanged section\nplain but in the wrong section\n') }), /added outside the Status field/);
  });
});

describe('isShipStepDelta: section boundaries follow Markdown headings (PR A audit round 6)', () => {
  it('a SETEXT heading after the log ends it: a plain line added below it is outside the log (refused by location)', () => {
    const old = PLAN_OLD + '## Implementation Log\n- r1\nNext steps\n----------\nunchanged\n';
    const next = old.replace('unchanged\n', 'unchanged\nplain but below the setext heading\n');
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: old, newText: next }), /added outside the Status field/);
  });
  it('an INDENTED level-two ATX heading ends the log too', () => {
    const old = PLAN_OLD + '## Implementation Log\n- r1\n   ## Indented heading\nunchanged\n';
    const next = old.replace('unchanged\n', 'unchanged\nplain but below the heading\n');
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: old, newText: next }), /added outside the Status field/);
  });
  it('a line added INSIDE the log, before such a heading, is still accepted (the control)', () => {
    const old = PLAN_OLD + '## Implementation Log\n- r1\nNext steps\n----------\nunchanged\n';
    assert.equal(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: old, newText: old.replace('- r1\n', '- r1\n- r2\n') }), null);
  });
});

describe('isShipStepDelta: a reference definition INSIDE a container is still a definition (PR A, the round past the cap)', () => {
  const withLog = PLAN_OLD + '## Implementation Log\n- r1\n## Next steps\nSee [proof] for details.\n';
  const add = (line) => withLog.replace('- r1\n', `- r1\n${line}\n`);
  for (const line of ['- [proof]: https://example.invalid', '* [proof]: https://example.invalid', '1. [proof]: https://example.invalid', '- - [proof]: https://example.invalid', '  - [proof]: https://example.invalid', '-\t[proof]: https://example.invalid']) {
    it(`refuses ${JSON.stringify(line)}`, () => {
      assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: add(line) }), /contains "\["/);
    });
  }
  it('a list item that merely mentions a bracket is refused too: the forbidden set is strict about [ and ] (the measured cost: 1.3% of real log lines)', () => {
    assert.match(delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: add('- see [proof] and [x](https://example.com) for details') }), /contains "\["/);
  });
});

// ---- the named forbidden set (audit past-cap round 2: "no Markdown metacharacters", chosen from what the ship writes) ----------------
import fs from 'node:fs';
import path from 'node:path';
import { LOG_LINE_FORBIDDEN_CHARS, LOG_LINE_ALLOWED_INLINE } from '../scripts/lib/ship-record/authority.mjs';
import { planLogSuggestion } from '../scripts/lib/ship-record/entry.mjs';

describe('the log-line forbidden set: one named constant, every character refused, plain lines accepted', () => {
  const withLog = PLAN_OLD + '## Implementation Log\n- r1\n## Next steps\nunchanged section\n';
  const add = (line) => withLog.replace('- r1\n', `- r1\n${line}\n`);
  const run = (line) => delta({ status: 'M', rel: 'docs/plans/x.md', oldText: withLog, newText: add(line) });

  it('the set is exactly [ ] < > | (and the allowed inline markers are the three that cannot cross a block)', () => {
    assert.deepEqual([...LOG_LINE_FORBIDDEN_CHARS], ['[', ']', '<', '>', '|']);
    assert.deepEqual([...LOG_LINE_ALLOWED_INLINE], ['*', '_', '`']);
    for (const c of LOG_LINE_ALLOWED_INLINE) assert.equal(LOG_LINE_FORBIDDEN_CHARS.includes(c), false, 'allowed and forbidden must not overlap');
  });
  for (const c of LOG_LINE_FORBIDDEN_CHARS) {
    it(`refuses a line containing ${JSON.stringify(c)}, anywhere in it, in any list shape`, () => {
      for (const line of [`- text ${c} more`, `prose ${c}`, `1. numbered ${c}`, `- ${c}at the start`]) assert.match(run(line), /contains|raw HTML block|starts a raw/, line);
    });
  }
  for (const [name, line] of [['a run of three backticks', '- uses ``` inline'], ['a run of tildes', '- uses ~~~ inline'], ['a leading #', '# heading'], ['a leading # with indent', '   ## heading'], ['a thematic break', '* * *'], ['a setext underline', '==='], ['a dashed underline', '----']]) {
    it(`refuses ${name}`, () => { assert.notEqual(run(line), null, line); });
  }
  it('accepts the plain shapes a ship writes: bullets, numbered items, prose, emphasis, single backticks, parentheses, quotes', () => {
    for (const line of ['- a bullet', '* another', '+ plus', '1. numbered', '2) paren', 'Plain prose.', '**bold lead** then text', '- uses `code` and *emphasis* and snake_case', '(parenthesised)', '"quoted" start', '  - indented bullet']) assert.equal(run(line), null, line);
  });

  it('PROOF against what the ship writes: of every Implementation Log line in docs/plans, the set refuses only lines with a forbidden character, a fence run or a leading #, and the strict alternative (also refusing * _ and backticks) would refuse far more', () => {
    const dir = path.join(import.meta.dirname, '..', 'docs', 'plans');
    let total = 0; let refused = 0; let strictRefused = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/);
      const i = lines.indexOf('## Implementation Log');
      if (i < 0) continue;
      const e = lines.findIndex((l, n) => n > i && /^## /.test(l));
      for (const l of lines.slice(i + 1, e < 0 ? lines.length : e)) {
        if (!l.trim()) continue;
        total++;
        const old = `${PLAN_OLD}## Implementation Log\n- r1\n`;
        const bad = delta({ status: 'M', rel: 'docs/plans/x.md', oldText: old, newText: `${old}${l}\n` }) !== null;
        if (bad) refused++;
        if (bad || /[*_`]/.test(l)) strictRefused++;
      }
    }
    assert.ok(total > 1000, `the corpus is real (${total} lines)`);
    // The measured costs, as a regression check: the chosen set refuses a minority, and strictness would refuse a clear majority.
    assert.ok(refused / total < 0.5, `the chosen set refuses ${(100 * refused / total).toFixed(1)}% of ${total} real log lines`);
    assert.ok(strictRefused / total > refused / total + 0.2, `the strict alternative refuses ${(100 * strictRefused / total).toFixed(1)}%: it is the cost of making * _ and backticks forbidden too`);
  });

  it('the line ship-record catch-up writes is NOT governed by this grammar: it carries an HTML marker, is accepted by the RECORD grammar, and is refused here (it never rides in a /ship commit)', () => {
    const line = planLogSuggestion({ number: 21, mergeCommit: 'a'.repeat(40), mergedAt: '2026-11-18T10:00:00Z' });
    assert.match(line, /<!-- ship-record pr=21 -->/);
    assert.match(run(line), /contains "<"/);
  });
});
