/**
 * @fileoverview The coordinator batch re-check, as a PURE decision: `evaluateShippedHead` (scripts/lib/ship-preauth.mjs) and
 * the path-only post-audit delta `shipEntryRefusal` (scripts/lib/ship-shipped-head.mjs).
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
import fs from 'node:fs';
import path from 'node:path';
import { shipEntryRefusal } from '../scripts/lib/ship-shipped-head.mjs';

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

// ---- the post-audit delta (C4): PATH-ONLY ------------------------------------------------------------------------------------
const refusal = (o) => shipEntryRefusal({ newMode: '100644', ...o });
const entry = 'docs/status/entries/2026-11-18-070000-ship-x.md';

describe('shipEntryRefusal: the only change /ship may make after the audit is a NEW status entry file', () => {
  it('an ADDED regular entry file passes', () => {
    assert.equal(refusal({ status: 'A', rel: entry }), null);
  });
  for (const status of ['M', 'D', 'R', 'C', 'T']) {
    it(`status ${status} on an entry path refuses (only an ADD is allowed)`, () => {
      assert.match(refusal({ status, rel: entry }), /only ADDING one is allowed/);
    });
  }
  for (const [name, rel] of [
    ['a plan edit', 'docs/plans/x.md'],
    ['status.md', 'status.md'],
    ['a source file', 'scripts/a.mjs'],
    ['a file OUTSIDE the entries directory', 'docs/status/other.md'],
    ['a nested path under the entries directory', 'docs/status/entries/sub/x.md'],
    ['a non-markdown file in the entries directory', 'docs/status/entries/x.json'],
    ['a look-alike directory', 'docs/status/entries-x/x.md'],
    ['a name with a trailing newline (JS $ does not match before it)', 'docs/status/entries/x.md' + String.fromCharCode(10)],
    ['a name with an embedded newline', 'docs/status/entries/a' + String.fromCharCode(10) + 'b.md'],
  ]) {
    it(`${name} refuses, even as an add`, () => {
      assert.match(refusal({ status: 'A', rel }), /only a NEW docs\/status\/entries\/\*\.md file/);
    });
  }
  for (const mode of ['120000', '160000', '100755', '040000', null]) {
    it(`an added entry with mode ${mode} refuses (symlink, gitlink, executable, tree or unknown)`, () => {
      assert.match(shipEntryRefusal({ status: 'A', rel: entry, newMode: mode }), /not a regular file/);
    });
  }
  it('the entry CONTENT is never read: any bytes pass, because a new file cannot rewrite audited content', () => {
    assert.equal(shipEntryRefusal.length, 1, 'the decision takes one object and has no text parameter');
    assert.equal(refusal({ status: 'A', rel: entry, newText: '<!-- never closed [x]: https://example.invalid ``` *' }), null);
  });
  it('NEGATIVE CONTROL: the content grammar cannot come back unnoticed (its module, its constants and its callers are gone)', async () => {
    const mod = await import('../scripts/lib/ship-record/authority.mjs');
    for (const gone of ['isShipStepDelta', 'LOG_LINE_FORBIDDEN_CHARS', 'LOG_LINE_ALLOWED_INLINE', 'plainLogLineProblem']) assert.equal(gone in mod, false, `${gone} must not exist`);
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'scripts', 'lib', 'ship-shipped-head.mjs'), 'utf8');
    assert.doesNotMatch(src, /isShipStepDelta|oldText|newText|\bshow\b.*headTree/, 'the delta check reads no file content');
  });
});
