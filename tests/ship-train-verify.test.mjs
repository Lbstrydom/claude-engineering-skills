/**
 * @fileoverview Stateless ship-train verification (plan §2.8): source identity,
 * claim TRUTH (not equality with a stored decision), the final merge OID,
 * interleaving, and the publication gate.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  readAiTrailers, judgeSourceIdentity, checkClaimTruth, verifyTrain, publicationClearance, MAX_UPDATE_LINKS,
} from '../scripts/lib/ship-train/verify.mjs';
import { composeSquashMessage } from '../scripts/lib/ship-train/provenance.mjs';

const oid = (c) => c.repeat(40);
const RUN = 'bd49abc4-243e-42cc-85ec-e5d14328841d';
const PR_COMMITS = [{ oid: oid('1'), tree: oid('a') }, { oid: oid('2'), tree: oid('b') }];
const run = (over = {}) => ({ id: RUN, auditedTree: oid('b'), auditedSha: oid('2'), roundConvergedAfter: 3, ...over });
const msg = (decision, models = ['claude', 'gpt']) => composeSquashMessage({ number: 7, title: 'x', commitSubjects: ['c'], decision, models }).message;

describe('readAiTrailers', () => {
  test('a composed squash message reads back as a parseable block', () => {
    const r = readAiTrailers(msg({ gate: 'converged', runId: RUN, auditedTree: null }));
    assert.equal(r.parseable, true);
    assert.equal(r.trailers['AI-Gate'], 'converged');
  });
  test("GitHub's default body (block buried mid-list) is unparseable", () => {
    assert.equal(readAiTrailers('t (#9)\n\n* a\n\nAI-Skill: ship\nAI-Gate: waived\n\n* b\n').parseable, false);
  });
  test('a duplicated key is reported, not reduced to its last value', () => {
    assert.deepEqual(readAiTrailers('t\n\nAI-Gate: passed\nAI-Gate: converged\n').duplicates, ['AI-Gate']);
  });
});

describe('judgeSourceIdentity (plan R4 H1)', () => {
  test('the merged head IS the pinned oid', () => {
    assert.deepEqual(judgeSourceIdentity({ pinnedOid: oid('1'), links: [], reachedOid: oid('1') }), { ok: true, reason: null });
  });
  test("a chain of fleet serial's own updates leading back to the pinned oid", () => {
    const links = [{ oid: oid('9'), verdict: 'own' }, { oid: oid('8'), verdict: 'own' }];
    assert.equal(judgeSourceIdentity({ pinnedOid: oid('1'), links, reachedOid: oid('1') }).ok, true);
  });
  test('a head the PR gained after pinning (foreign link) fails', () => {
    const r = judgeSourceIdentity({ pinnedOid: oid('1'), links: [{ oid: oid('9'), verdict: 'foreign', reason: 'not a two-parent merge' }], reachedOid: oid('9') });
    assert.equal(r.ok, false);
    assert.match(r.reason, /not fleet serial's own base-only update \(foreign: not a two-parent merge\)/);
  });
  test('a foreign link fails even when the walk reports reaching the pinned oid (the own-link rule alone)', () => {
    const links = [{ oid: oid('9'), verdict: 'own' }, { oid: oid('8'), verdict: 'foreign', reason: 'extra content' }];
    assert.equal(judgeSourceIdentity({ pinnedOid: oid('1'), links, reachedOid: oid('1') }).ok, false);
  });
  test('an unverifiable link fails as unverifiable', () => {
    assert.match(judgeSourceIdentity({ pinnedOid: oid('1'), links: [{ oid: oid('9'), verdict: 'unverifiable', reason: 'fetch failed' }], reachedOid: oid('9') }).reason, /unverifiable/);
  });
  test('an all-own walk that never reaches the pinned oid fails', () => {
    const links = Array.from({ length: MAX_UPDATE_LINKS }, (_, i) => ({ oid: String(i).repeat(40), verdict: 'own' }));
    assert.match(judgeSourceIdentity({ pinnedOid: oid('1'), links, reachedOid: oid('5') }).reason, /does not lead back/);
  });
});

describe('checkClaimTruth — the §2.8 truth list', () => {
  const truth = (decision, { tree = oid('b'), r = run(), commits = PR_COMMITS } = {}) =>
    checkClaimTruth({ message: msg(decision), tree, prCommits: commits, run: r });

  test('passed: true when the trailer is the commit tree, the run audited that tree, is bound and converged', () => {
    assert.equal(truth({ gate: 'passed', runId: RUN, auditedTree: oid('b') }).true, true);
  });
  test("passed: false when AI-Audited-Tree is not the commit's own tree", () => {
    const r = truth({ gate: 'passed', runId: RUN, auditedTree: oid('b') }, { tree: oid('c') });
    assert.match(r.problems.join('|'), /is not the commit's tree/);
  });
  test('passed: false when the run audited a different tree than the trailer claims', () => {
    const r = truth({ gate: 'passed', runId: RUN, auditedTree: oid('b') }, { r: run({ auditedTree: oid('a') }) });
    assert.match(r.problems.join('|'), /audited tree .*not the claimed/);
  });
  test('converged: true when bound and converged; false when unconverged or unbound', () => {
    assert.equal(truth({ gate: 'converged', runId: RUN, auditedTree: null }).true, true);
    assert.match(truth({ gate: 'converged', runId: RUN, auditedTree: null }, { r: run({ roundConvergedAfter: null }) }).problems.join('|'), /did not converge/);
    assert.match(truth({ gate: 'converged', runId: RUN, auditedTree: null }, { r: run({ auditedTree: oid('f') }) }).problems.join('|'), /not the tree of any commit/);
  });
  test('waived: true when the run relates by tree or sha; false when unrelated', () => {
    assert.equal(truth({ gate: 'waived', runId: RUN, auditedTree: null }, { r: run({ auditedTree: oid('f'), auditedSha: oid('2') }) }).true, true);
    assert.match(truth({ gate: 'waived', runId: RUN, auditedTree: null }, { r: run({ auditedTree: oid('f'), auditedSha: oid('9') }) }).problems.join('|'), /unrelated/);
  });
  test('not-run: true with no run id', () => {
    assert.equal(truth({ gate: 'not-run', runId: null, auditedTree: null }, { r: null }).true, true);
  });
  test('a run from another repo or a plan-mode run resolves to null, making every audit-backed claim false (plan R5 H1)', () => {
    for (const gate of ['passed', 'converged', 'waived']) {
      const r = truth({ gate, runId: RUN, auditedTree: gate === 'passed' ? oid('b') : null }, { r: null });
      assert.equal(r.true, false, gate);
      assert.match(r.problems.join('|'), /not a code-mode run of this repository/, gate);
    }
  });
  test('an under-claim (converged on the exact audited tree) is TRUE and noted', () => {
    const r = truth({ gate: 'converged', runId: RUN, auditedTree: null }, { tree: oid('b') });
    assert.equal(r.true, true);
    assert.match(r.notes.join('|'), /under-claim/);
  });
  test('an unparseable block and a duplicated key are false', () => {
    assert.equal(checkClaimTruth({ message: 'x', tree: oid('b'), prCommits: PR_COMMITS, run: run() }).true, false);
    const dup = msg({ gate: 'converged', runId: RUN, auditedTree: null }).replace('AI-Gate: converged\n', 'AI-Gate: converged\nAI-Gate: passed\n');
    assert.match(checkClaimTruth({ message: dup, tree: oid('b'), prCommits: PR_COMMITS, run: run() }).problems.join('|'), /appears more than once/);
  });
});

describe('verifyTrain + publicationClearance', () => {
  const claim = { gate: 'converged', runId: RUN, auditedTree: null };
  const src = (pr, mergeOid, over = {}) => ({
    pr, merged: { mergeOid, message: msg(claim), tree: oid('c') }, identity: { ok: true, reason: null }, prCommits: PR_COMMITS, run: run(), ...over,
  });
  const chainOf = (...oids) => oids.map((o, i) => ({ oid: o, subject: `c${i}` }));

  test('a clean train: final merge is the last train merge in first-parent order, clear to publish', () => {
    const v = verifyTrain({ sources: [src(1, oid('5')), src(2, oid('6'))], chain: chainOf(oid('5'), oid('6')) });
    assert.equal(v.finalMergeOid, oid('6'));
    assert.deepEqual(v.actualGates, { 1: 'converged', 2: 'converged' });
    assert.deepEqual(publicationClearance(v), { clear: true, blocks: [] });
  });

  test('the log PR landing first does not become the final merge', () => {
    const v = verifyTrain({ sources: [src(9, oid('4')), src(1, oid('5'))], chain: chainOf(oid('4'), oid('5')) });
    assert.equal(v.finalMergeOid, oid('5'));
  });

  test('interleaved foreign commits block until --accept-interleaved; commits after the final merge never count', () => {
    const v = verifyTrain({ sources: [src(1, oid('5')), src(2, oid('6'))], chain: chainOf(oid('5'), oid('7'), oid('6'), oid('8')) });
    assert.deepEqual(v.interleaved.map((c) => c.oid), [oid('7')]);
    assert.equal(publicationClearance(v).blocks[0].flag, '--accept-interleaved');
    assert.equal(publicationClearance(v, { acceptInterleaved: true }).clear, true);
  });

  test('a false claim blocks until --accept-provenance-mismatch', () => {
    const bad = src(2, oid('6'), { run: run({ roundConvergedAfter: null }) });
    const v = verifyTrain({ sources: [src(1, oid('5')), bad], chain: chainOf(oid('5'), oid('6')) });
    assert.deepEqual(v.falseClaims, [2]);
    assert.equal(publicationClearance(v).blocks[0].flag, '--accept-provenance-mismatch');
    assert.equal(publicationClearance(v, { acceptProvenanceMismatch: true }).clear, true);
  });

  test('an unmerged source, a foreign head, and an off-chain merge block with NO override', () => {
    const v = verifyTrain({
      sources: [src(1, oid('5')), { pr: 2, merged: null, identity: null, prCommits: [], run: null },
        src(3, oid('6'), { identity: { ok: false, reason: 'foreign head' } }), src(4, oid('9'))],
      chain: chainOf(oid('5'), oid('6')),
    });
    assert.deepEqual([v.unmerged, v.identityFailures, v.offChain], [[2], [3], [4]]);
    const c = publicationClearance(v, { acceptInterleaved: true, acceptProvenanceMismatch: true });
    assert.equal(c.clear, false);
    assert.ok(c.blocks.every((b) => b.flag === null), JSON.stringify(c.blocks));
  });

  test('an identity failure ALONE blocks publication with no override flag', () => {
    const v = verifyTrain({ sources: [src(1, oid('5')), src(2, oid('6'), { identity: { ok: false, reason: 'foreign head' } })], chain: chainOf(oid('5'), oid('6')) });
    assert.deepEqual([v.unmerged, v.offChain, v.falseClaims], [[], [], []], 'identity is the only failure here');
    const c = publicationClearance(v, { acceptInterleaved: true, acceptProvenanceMismatch: true });
    assert.equal(c.clear, false);
    assert.deepEqual(c.blocks.map((b) => b.flag), [null]);
    assert.match(c.blocks[0].reason, /did not test: #2/);
  });

  test('a foreign-head merge is not train evidence: it cannot become the final merge', () => {
    const v = verifyTrain({ sources: [src(1, oid('5')), src(2, oid('6'), { identity: { ok: false, reason: 'x' } })], chain: chainOf(oid('5'), oid('6')) });
    assert.equal(v.finalMergeOid, oid('5'));
  });
});
