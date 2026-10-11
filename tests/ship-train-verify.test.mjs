/**
 * @fileoverview Ship-train post-landing verification (plan T6, §2.8, §9):
 * claims checked against the ACTUAL persisted decision, interleaved foreign
 * commits, the publication pin, and landing order.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { verifyLanded, checkCommitClaims, readAiTrailers, publicationClearance } from '../scripts/lib/ship-train/verify.mjs';
import { composeSquashMessage } from '../scripts/lib/ship-train/provenance.mjs';

const oid = (c) => c.repeat(40);
const RUN = 'bd49abc4-243e-42cc-85ec-e5d14328841d';

const claims = (over = {}) => ({ gate: 'converged', runId: RUN, auditedTree: null, models: ['claude', 'gpt'], ...over });
const msgFor = (pr, c) => composeSquashMessage({ number: pr, title: `pr ${pr}`, commitSubjects: ['x'], decision: c, models: c.models }).message;

function receipt({ plannedGate = 'converged', actualClaims = claims(), landingOrder = [202, 203, 210] } = {}) {
  const sel = (pr, gate) => ({ pr, decision: { gate } });
  const actual = (c) => ({ headOid: oid('1'), baseOid: oid('e'), basePinning: 'none', claims: c, subject: 's', bodySha256: 'f'.repeat(64), bodyPath: 'p', at: 't' });
  return {
    selected: [sel(202, plannedGate), sel(203, 'converged')],
    logPr: { number: 210, headOid: oid('3') },
    landingOrder,
    actual: { 202: actual(actualClaims), 203: actual(claims()), 210: actual(claims({ gate: 'not-run', runId: null, models: ['claude'] })) },
  };
}

const merged = (over = {}) => ({
  202: { mergeOid: oid('a'), message: msgFor(202, claims()), tree: oid('7') },
  203: { mergeOid: oid('b'), message: msgFor(203, claims()), tree: oid('8') },
  210: { mergeOid: oid('c'), message: msgFor(210, claims({ gate: 'not-run', runId: null, models: ['claude'] })), tree: oid('9') },
  ...over,
});
const chainOf = (...oids) => oids.map((o, i) => ({ oid: o, subject: `c${i}` }));

describe('readAiTrailers / checkCommitClaims', () => {
  test('a composed squash message reads back as a parseable AI-* block', () => {
    const r = readAiTrailers(msgFor(202, claims()));
    assert.equal(r.parseable, true);
    assert.equal(r.trailers['AI-Gate'], 'converged');
  });

  test("GitHub's default squash body (trailers buried mid-list) is reported as unparseable", () => {
    const githubDefault = 'feat: x (#9)\n\n* ship it\n\nAI-Skill: ship\nAI-Gate: waived\n\n* follow-up commit\n';
    const r = checkCommitClaims({ message: githubDefault, tree: oid('7') }, claims());
    assert.deepEqual(r.problems, ['no parseable AI-* trailer block on the merge commit']);
  });

  test('a body that matches the plan but not the persisted actual claim is rejected', () => {
    const planLike = msgFor(202, claims({ gate: 'passed', auditedTree: oid('7') }));
    const r = checkCommitClaims({ message: planLike, tree: oid('7') }, claims());
    assert.ok(r.problems.some((p) => /AI-Gate is "passed", persisted claim "converged"/.test(p)), r.problems.join('|'));
  });

  test('a passed claim whose AI-Audited-Tree is not the commit tree leaves identity unproven', () => {
    const c = claims({ gate: 'passed', auditedTree: oid('7') });
    const r = checkCommitClaims({ message: msgFor(202, c), tree: oid('6') }, c);
    assert.equal(r.identityUnproven, true);
  });

  test('a passed claim whose commit carries NO AI-Audited-Tree also leaves identity unproven (round-1 M9)', () => {
    const c = claims({ gate: 'passed', auditedTree: oid('7') });
    const withoutTree = msgFor(202, c).replace(/^AI-Audited-Tree: .*\n/m, '');
    const r = checkCommitClaims({ message: withoutTree, tree: oid('7') }, c);
    assert.equal(r.identityUnproven, true);
    assert.ok(r.problems.some((p) => /AI-Audited-Tree is missing/.test(p)), r.problems.join('|'));
  });

  test('a duplicated AI-* key is reported, never reduced to its last value (round-1 H2/M10)', () => {
    const doubled = msgFor(202, claims()).replace('AI-Gate: converged\n', 'AI-Gate: passed\nAI-Gate: converged\n');
    assert.deepEqual(readAiTrailers(doubled).duplicates, ['AI-Gate']);
    const r = checkCommitClaims({ message: doubled, tree: oid('7') }, claims());
    assert.ok(r.problems.some((p) => /AI-Gate appears more than once/.test(p)), r.problems.join('|'));
  });
});

describe('verifyLanded', () => {
  test('a clean train: every PR ok, final merge is the last train merge, nothing interleaved', () => {
    const v = verifyLanded({ receipt: receipt(), merged: merged(), chain: chainOf(oid('a'), oid('b'), oid('c')), at: 't' });
    assert.deepEqual(Object.values(v.perPr).map((p) => p.ok), [true, true, true]);
    assert.equal(v.finalMergeOid, oid('c'));
    assert.deepEqual(v.interleaved, []);
    assert.equal(v.publicationBlocked, false);
    assert.equal(v.orderOk, true);
  });

  test('a foreign merge between two train merges is recorded as interleaved, not hidden (round-2 H1)', () => {
    const v = verifyLanded({ receipt: receipt(), merged: merged(), chain: chainOf(oid('a'), oid('d'), oid('b'), oid('c')), at: 't' });
    assert.deepEqual(v.interleaved.map((c) => c.oid), [oid('d')]);
    assert.equal(v.finalMergeOid, oid('c'));
  });

  test('a commit landing AFTER the final train merge is excluded from interleaved', () => {
    const v = verifyLanded({ receipt: receipt(), merged: merged(), chain: chainOf(oid('a'), oid('b'), oid('c'), oid('f')), at: 't' });
    assert.deepEqual(v.interleaved, []);
    assert.equal(v.finalMergeOid, oid('c'));
  });

  test('update-branch turned planned passed into actual converged: verified against actual, one planned-vs-actual entry', () => {
    const v = verifyLanded({ receipt: receipt({ plannedGate: 'passed' }), merged: merged(), chain: chainOf(oid('a'), oid('b'), oid('c')), at: 't' });
    assert.equal(v.perPr['202'].ok, true);
    assert.deepEqual(v.plannedVsActual, [{ pr: 202, planned: 'passed', actual: 'converged' }]);
  });

  test('a passed tree mismatch blocks publication', () => {
    const c = claims({ gate: 'passed', auditedTree: oid('7') });
    const m = merged({ 202: { mergeOid: oid('a'), message: msgFor(202, c), tree: oid('6') } });
    const v = verifyLanded({ receipt: receipt({ plannedGate: 'passed', actualClaims: c }), merged: m, chain: chainOf(oid('a'), oid('b'), oid('c')), at: 't' });
    assert.equal(v.publicationBlocked, true);
    assert.match(v.blockedReason, /#202/);
  });

  test('the log PR landing first: final merge is still the LAST observed train merge, and order is checked', () => {
    const v = verifyLanded({ receipt: receipt({ landingOrder: [210, 202, 203] }), merged: merged(), chain: chainOf(oid('c'), oid('a'), oid('b')), at: 't' });
    assert.equal(v.finalMergeOid, oid('b'));
    assert.equal(v.orderOk, true);
    const wrong = verifyLanded({ receipt: receipt({ landingOrder: [202, 203, 210] }), merged: merged(), chain: chainOf(oid('c'), oid('a'), oid('b')), at: 't' });
    assert.equal(wrong.orderOk, false);
  });

  test('merge evidence for a PR outside the train blocks publication and never moves the final merge (round-1 H1)', () => {
    const m = merged({ 999: { mergeOid: oid('d'), message: msgFor(999, claims()), tree: oid('6') } });
    const v = verifyLanded({ receipt: receipt(), merged: m, chain: chainOf(oid('a'), oid('b'), oid('c'), oid('d')), at: 't' });
    assert.equal(v.finalMergeOid, oid('c'));
    assert.equal(v.publicationBlocked, true);
    assert.match(v.blockedReason, /#999/);
  });

  test('an unmerged PR and a merge commit off the destination chain are problems', () => {
    const m = merged();
    delete m['203'];
    const v = verifyLanded({ receipt: receipt(), merged: m, chain: chainOf(oid('c')), at: 't' });
    assert.deepEqual(v.perPr['203'].problems, ['not merged']);
    assert.match(v.perPr['202'].problems.join('|'), /not on the first-parent chain/);
  });
});

describe('publicationClearance — the one predicate sync must pass (round-2 H1)', () => {
  const verified = (over = {}) => ({ phase: 'verified', verify: { interleaved: [], finalMergeOid: oid('c'), publicationBlocked: false, blockedReason: null }, ...over });

  test('a clean verified train is clear', () => {
    assert.deepEqual(publicationClearance(verified()), { clear: true, blocks: [] });
  });

  test('an unverified op is never clear, and no flag can clear it', () => {
    const r = publicationClearance({ phase: 'landed' });
    assert.equal(r.clear, false);
    assert.equal(r.blocks[0].flag, null);
  });

  test('interleaved commits block until an amendment accepts EXACTLY them', () => {
    const base = verified({ phase: 'verified-interleaved', verify: { interleaved: [{ oid: oid('d'), subject: 'x' }, { oid: oid('e'), subject: 'y' }], finalMergeOid: oid('c'), publicationBlocked: false, blockedReason: null } });
    assert.equal(publicationClearance(base).blocks[0].flag, '--accept-interleaved');
    assert.equal(publicationClearance({ ...base, publicationAmendment: { acceptedOids: [oid('d')], at: 't' } }).clear, false);
    assert.equal(publicationClearance({ ...base, publicationAmendment: { acceptedOids: [oid('d'), oid('e')], at: 't' } }).clear, true);
  });

  test('a provenance block clears only with the invocation acknowledgement', () => {
    const b = verified({ verify: { interleaved: [], finalMergeOid: oid('c'), publicationBlocked: true, blockedReason: '#202: tree' } });
    assert.equal(publicationClearance(b).blocks[0].flag, '--accept-provenance-mismatch');
    assert.equal(publicationClearance(b, { acceptProvenanceMismatch: true }).clear, true);
  });
});
