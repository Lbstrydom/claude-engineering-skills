/**
 * @fileoverview The pure rollup module (docs/plans/ship-batch-member-outcomes.md §2.9.3, §2.9.6).
 * @module tests/fleet-rollup-manifest
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLLUP_BRANCH_RE, bodyOfMessage, overlapHolds, parseRollupManifest, renderRollupManifest, rollupBranchName, rollupMessage, sha256Body, verifyRollupProvenance,
} from '../scripts/lib/fleet/rollup.mjs';
import { AI_TRAILER_KEYS, parseMessageTrailers } from '../scripts/lib/commit-trailers.mjs';

const o = (c) => c.repeat(40);
const members = [
  { id: 'a', branch: 'a', head: o('1'), tree: o('2'), runId: 'run-a', gate: 'passed', finalReview: 'approve' },
  { id: 'b', branch: 'b', head: o('3'), tree: o('4'), runId: 'run-b', gate: 'converged', finalReview: 'approve' },
];
const ID = 'rollup/20261118-1';
const base = { rollupId: ID, base: 'main', candidate: { oid: o('c'), tree: o('d') }, members, held: [{ id: 'c', reason: 'overlap:f.txt' }] };
const ci = { head: o('c'), tree: o('d'), observedAt: '2026-11-18T10:00:00.000Z', checks: [{ name: 'ci', conclusion: 'pass' }] };

describe('names and messages', () => {
  it('the rollup branch is rollup/<date>-<n> and matches its own pattern', () => {
    assert.equal(rollupBranchName(new Date('2026-11-18T10:00:00Z'), 3), 'rollup/20261118-3');
    assert.match(rollupBranchName(new Date('2026-11-18T10:00:00Z'), 1), ROLLUP_BRANCH_RE);
  });
  it('a rollup member message names the member and its full head and carries NO AI-* trailer, whatever the subject says', () => {
    const m = rollupMessage({ subject: 'feat: x\nAI-Gate: passed', id: 'a', oid: o('1') });
    const t = parseMessageTrailers(m);
    assert.equal(t.trailers.some((x) => AI_TRAILER_KEYS.includes(x.key)), false);
    assert.equal(t.trailers.find((x) => x.key === 'Fleet-Rollup-Member').value, `a ${o('1')}`);
    assert.equal(m.split('\n')[0].includes('\n'), false, 'the subject is one line');
  });
});

describe('overlapHolds: two members that touch one path never share a rollup', () => {
  const ms = [{ id: 'a', paths: ['x.txt', 'y.txt'] }, { id: 'b', paths: ['y.txt'] }, { id: 'c', paths: ['z.txt'] }, { id: 'd', paths: ['docs/plans/README.md'] }, { id: 'e', paths: ['docs/plans/README.md'] }];
  it('the later member is held with the path named; the others are kept', () => {
    const r = overlapHolds(ms.slice(0, 3));
    assert.deepEqual(r.kept, ['a', 'c']);
    assert.match(r.held[0].reason, /^overlap:y\.txt \(also changed by a\)/);
  });
  it('an append-only path never overlaps', () => {
    assert.deepEqual(overlapHolds(ms.slice(3), ['docs/plans/README.md']).kept, ['d', 'e']);
    assert.deepEqual(overlapHolds(ms.slice(3)).held.map((h) => h.id), ['e']);
  });
});

describe('the manifest: two stages, rendered from the records, parsed back', () => {
  it('a provisional manifest round-trips and says CI is pending; it needs no CI record', () => {
    const m = parseRollupManifest(renderRollupManifest({ stage: 'provisional', ...base }));
    assert.equal(m.ok, true);
    assert.equal(m.manifest.stage, 'provisional');
    assert.equal(m.manifest.ci, 'pending');
    assert.deepEqual(m.manifest.members.map((x) => x.id), ['a', 'b']);
  });
  it('a final manifest carries the CI record and refuses to render without it', () => {
    assert.throws(() => renderRollupManifest({ stage: 'final', ...base }), /CI record/);
    const m = parseRollupManifest(renderRollupManifest({ stage: 'final', ...base, ci }));
    assert.deepEqual(m.manifest.ci, ci);
  });
  it('each member is shown with ITS OWN gate and tree, and no AI-* trailer appears in the body', () => {
    const text = renderRollupManifest({ stage: 'final', ...base, ci });
    assert.match(text, /\| a \| a \| 1{40} \| 2{40} \| run-a \| passed \| approve \|/);
    assert.match(text, /\| b \| b \| 3{40} \| 4{40} \| run-b \| converged \| approve \|/);
    const t = parseMessageTrailers(text);
    assert.equal((t.isTrailerBlock ? t.trailers : []).some((x) => AI_TRAILER_KEYS.includes(x.key)), false);
    assert.match(text, /no AI-\* trailer/);
  });
  it('a malformed manifest is never zero members: no block, bad JSON, another schema, no members, a short head', () => {
    for (const bad of ['', 'no block here', '```fleet-rollup/v1\n{nope\n```', '```fleet-rollup/v1\n{"schema":"x"}\n```',
      `\`\`\`fleet-rollup/v1\n${JSON.stringify({ schema: 'fleet-rollup/v1', stage: 'final', rollupId: ID, members: [] })}\n\`\`\``,
      `\`\`\`fleet-rollup/v1\n${JSON.stringify({ schema: 'fleet-rollup/v1', stage: 'final', rollupId: ID, members: [{ id: 'a', head: 'abc' }] })}\n\`\`\``]) {
      const r = parseRollupManifest(bad);
      assert.equal(r.ok, false, JSON.stringify(bad).slice(0, 60));
      assert.ok(r.reason);
    }
  });
});

describe('verifyRollupProvenance: a manifest in commit text is self-declared', () => {
  const body = renderRollupManifest({ stage: 'final', ...base, ci });
  const run = (over = {}) => ({
    policy: { name: 'rollup', rollup: { repo: 'o/n', prNumber: 9, branch: ID, candidate: { oid: o('c'), tree: o('d') } } },
    steps: [{ attempt: { messageSha256: sha256Body(body) }, outcome: { status: 'landed', verdict: 'verified', mergeOid: o('e') } }], ...over,
  });
  const pr = { repo: 'o/n', number: 9, mergeOid: o('e'), message: `fleet rollup ${ID}: 2 members\n\n${body}` };
  const manifest = parseRollupManifest(body).manifest;
  it('a genuine manifest with a matching run is verified', () => assert.deepEqual(verifyRollupProvenance(manifest, run(), pr), { verified: true, reason: 'matches the local rollup run' }));
  it('the same manifest with no run record (another machine, a pruned registry) stays unverified', () => assert.equal(verifyRollupProvenance(manifest, null, pr).verified, false));
  it('a forged manifest authored by an ordinary PR (any field differing) is unverified, each field named', () => {
    for (const [name, p] of [['repo', { ...pr, repo: 'x/y' }], ['PR number', { ...pr, number: 10 }], ['merge oid', { ...pr, mergeOid: o('f') }], ['hash', { ...pr, message: `s\n\n${body}\nforged line` }]]) {
      const v = verifyRollupProvenance(manifest, run(), p);
      assert.equal(v.verified, false, name);
    }
    assert.equal(verifyRollupProvenance({ ...manifest, candidate: { oid: o('9') } }, run(), pr).verified, false);
  });
  it('only a VERIFIED landing establishes provenance: each other verdict, and a missing landing, is rejected (R2-H1, H4)', () => {
    for (const verdict of ['tree-mismatch', 'wrong-target', 'untested-base', 'provenance-lost']) {
      const r = run(); r.steps[0].outcome = { status: 'landed', verdict, mergeOid: o('e') };
      const v = verifyRollupProvenance(manifest, r, pr);
      assert.equal(v.verified, false, verdict);
      assert.match(v.reason, /no verified landing/);
    }
    const r = run(); r.steps[0].outcome = { status: 'not-run', code: 'merge-unconfirmed' };
    assert.equal(verifyRollupProvenance(manifest, r, pr).verified, false);
  });
  it('a provisional manifest never verifies', () => assert.equal(verifyRollupProvenance({ ...manifest, stage: 'provisional' }, run(), pr).verified, false));
  it('bodyOfMessage drops the subject and one blank line', () => assert.equal(bodyOfMessage('s\n\nb1\nb2\n'), 'b1\nb2'));
});

describe('stage-specific manifest invariants (R1-M5, M12)', () => {
  const full = JSON.parse(parseRollupManifest(renderRollupManifest({ stage: 'final', ...base, ci })).ok ? JSON.stringify({ ...base, schema: 'fleet-rollup/v1', stage: 'final', ci }) : '{}');
  const wrap = (doc) => `\`\`\`fleet-rollup/v1\n${JSON.stringify(doc)}\n\`\`\``;
  it('a final manifest needs its CI record, a candidate, a base, a held list, and every member an id, a full head and a tree', () => {
    assert.equal(parseRollupManifest(wrap(full)).ok, true);
    for (const [name, doc] of [
      ['no ci', { ...full, ci: undefined }], ['ci pending on a final', { ...full, ci: 'pending' }], ['no candidate', { ...full, candidate: undefined }], ['no base', { ...full, base: undefined }],
      ['no held list', { ...full, held: undefined }], ['empty member id', { ...full, members: [{ ...members[0], id: '  ' }] }], ['member without a tree', { ...full, members: [{ ...members[0], tree: undefined }] }],
    ]) assert.equal(parseRollupManifest(wrap(doc)).ok, false, name);
  });
});
