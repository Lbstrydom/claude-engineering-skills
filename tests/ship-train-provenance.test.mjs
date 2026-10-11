/**
 * @fileoverview Ship-train provenance: content binding, the §2.3 gate table,
 * substantiated AI-Models, and a squash message whose AI-* block parses.
 * Tier 1, pure (docs/plans/ship-trains.md §2.3, §9).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  bindAuditRun, decideTrainGate, composeSquashMessage, modelsFromRun, modelToken,
} from '../scripts/lib/ship-train/provenance.mjs';
import { parseMessageTrailers } from '../scripts/lib/commit-trailers.mjs';
import { findCodeRunCandidates, MAX_PR_COMMITS } from '../scripts/lib/store/train-provenance.mjs';

const hex = (c) => c.repeat(40);

const oid = (c) => c.repeat(40);
const C1 = { oid: oid('1'), tree: oid('a') };
const C2 = { oid: oid('2'), tree: oid('b') };
const C3 = { oid: oid('3'), tree: oid('c') };
const COMMITS = [C1, C2, C3];
const run = (over) => ({ id: 'run-0000-0001', auditedSha: null, auditedTree: null, roundConvergedAfter: 2, createdAt: '2026-10-11T10:00:00Z', ...over });

describe('bindAuditRun', () => {
  test('a run whose audited tree equals the head tree binds at the head with no post-audit delta', () => {
    const b = bindAuditRun({ commits: COMMITS, candidates: [run({ auditedTree: C3.tree })] });
    assert.equal(b.kind, 'tree');
    assert.equal(b.boundCommit, C3.oid);
    assert.deepEqual(b.postAuditCommits, []);
  });

  test('a tree match on an earlier commit records the later commits as post-audit delta', () => {
    const b = bindAuditRun({ commits: COMMITS, candidates: [run({ auditedTree: C1.tree })] });
    assert.equal(b.boundCommit, C1.oid);
    assert.deepEqual(b.postAuditCommits, [C2.oid, C3.oid]);
  });

  test('the newest bound commit wins over an older one', () => {
    const b = bindAuditRun({ commits: COMMITS, candidates: [
      run({ id: 'old', auditedTree: C1.tree, createdAt: '2026-10-11T12:00:00Z' }),
      run({ id: 'new', auditedTree: C2.tree, createdAt: '2026-10-11T09:00:00Z' }),
    ] });
    assert.equal(b.run.id, 'new');
  });

  test('on one commit, the newest CONVERGED run wins over a newer unconverged one', () => {
    const b = bindAuditRun({ commits: COMMITS, candidates: [
      run({ id: 'conv', auditedTree: C3.tree, createdAt: '2026-10-11T09:00:00Z' }),
      run({ id: 'unconv', auditedTree: C3.tree, roundConvergedAfter: null, createdAt: '2026-10-11T11:00:00Z' }),
    ] });
    assert.equal(b.run.id, 'conv');
  });

  test('a sha-only match is an ANCESTRY candidate, never a tree binding (must-not-fire)', () => {
    const b = bindAuditRun({ commits: COMMITS, candidates: [run({ auditedSha: C2.oid, auditedTree: oid('f') })] });
    assert.equal(b.kind, 'ancestry');
    assert.equal(b.candidateCommit, C2.oid);
  });

  test('a run on the merge-base is never a candidate (the base is not in commits)', () => {
    const base = oid('9');
    const b = bindAuditRun({ commits: COMMITS, candidates: [run({ auditedSha: base, auditedTree: oid('8') })] });
    assert.deepEqual(b, { kind: 'unbound', reason: 'no-run-matches-a-pr-commit' });
  });

  test('a row matching both tree and sha binds by tree', () => {
    const b = bindAuditRun({ commits: COMMITS, candidates: [run({ auditedSha: C3.oid, auditedTree: C3.tree })] });
    assert.equal(b.kind, 'tree');
  });

  test('no commits → unbound', () => {
    assert.equal(bindAuditRun({ commits: [], candidates: [run({ auditedTree: C1.tree })] }).kind, 'unbound');
  });
});

describe('decideTrainGate — the §2.3 table', () => {
  const bound = (over) => ({ kind: 'tree', run: run({ auditedTree: C3.tree, ...over }), boundIndex: 2, boundCommit: C3.oid, postAuditCommits: [] });
  const decide = (over) => decideTrainGate({ binding: bound(), headTree: C3.tree, basePinning: 'strict', tier: 'urgent', ...over });

  test('tree-bound converged, equal trees, base pinned → passed with the audited tree', () => {
    const d = decide();
    assert.equal(d.gate, 'passed');
    assert.equal(d.auditedTree, C3.tree);
    assert.equal(d.identityProvable, true);
  });

  test('equal trees but base NOT pinned → converged, never passed (must-not-fire, round-1 H1)', () => {
    const d = decide({ basePinning: 'none' });
    assert.equal(d.gate, 'converged');
    assert.equal(d.auditedTree, null);
    assert.equal(d.identityProvable, false);
  });

  test('differing trees (post-audit commits) → converged', () => {
    assert.equal(decide({ headTree: oid('d') }).gate, 'converged');
  });

  test('tree-bound but not converged → refused, naming --waive; with --waive → waived', () => {
    const b = bound({ roundConvergedAfter: null });
    const r = decideTrainGate({ binding: b, headTree: C3.tree, basePinning: 'strict', tier: 'standard' });
    assert.equal(r.gate, null);
    assert.equal(r.refusal.code, 'run-not-converged');
    assert.equal(r.refusal.override, '--waive');
    assert.equal(decideTrainGate({ binding: b, headTree: C3.tree, basePinning: 'strict', tier: 'standard', waive: true }).gate, 'waived');
  });

  test('ancestry only → refused; with --waive → waived carrying that run id', () => {
    const b = { kind: 'ancestry', run: run({ id: 'anc', auditedSha: C2.oid }), candidateCommit: C2.oid };
    assert.equal(decideTrainGate({ binding: b, headTree: C3.tree, basePinning: 'strict', tier: 'urgent' }).refusal.code, 'ancestry-only');
    const w = decideTrainGate({ binding: b, headTree: C3.tree, basePinning: 'strict', tier: 'urgent', waive: true });
    assert.deepEqual([w.gate, w.runId], ['waived', 'anc']);
  });

  test('unbound ride-along → not-run; unbound standard → refused, naming --allow-unaudited', () => {
    const u = { kind: 'unbound', reason: 'x' };
    assert.equal(decideTrainGate({ binding: u, headTree: C3.tree, basePinning: 'none', tier: 'ride-along' }).gate, 'not-run');
    const r = decideTrainGate({ binding: u, headTree: C3.tree, basePinning: 'none', tier: 'standard' });
    assert.equal(r.refusal.override, '--allow-unaudited');
    assert.equal(decideTrainGate({ binding: u, headTree: C3.tree, basePinning: 'none', tier: 'standard', allowUnaudited: true }).gate, 'not-run');
  });

  test('store unavailable: ride-along → not-run, urgent → refused (cannot verify, cannot claim)', () => {
    const s = { kind: 'store-unavailable', reason: 'cloud off' };
    assert.equal(decideTrainGate({ binding: s, headTree: C3.tree, basePinning: 'none', tier: 'ride-along' }).gate, 'not-run');
    assert.equal(decideTrainGate({ binding: s, headTree: C3.tree, basePinning: 'none', tier: 'urgent' }).refusal.code, 'store-unavailable');
  });

  test('an unresolvable head tree refuses outright', () => {
    assert.equal(decide({ headTree: null }).refusal.code, 'no-head-tree');
  });
});

describe('modelsFromRun — substantiated participants only (round-1 M1)', () => {
  test('vendor → line token mapping keeps the existing AI-Models vocabulary', () => {
    assert.equal(modelToken('gpt-6.1-sol'), 'gpt');
    assert.equal(modelToken('gemini-3.1-pro-preview'), 'gemini');
    assert.equal(modelToken('claude-opus-5-5'), 'claude');
    assert.equal(modelToken(null), null);
  });

  test('only final_review_model recorded → composer + that family; nothing assumed', () => {
    const r = modelsFromRun({ finalReviewModel: 'gemini-3.1-pro-preview', auditorModels: [], authorModel: null }, 'claude');
    assert.deepEqual(r.models, ['claude', 'gemini']);
    assert.deepEqual(r.attributionMissing, ['auditor', 'author']);
  });

  test('no gpt or gemini without a recording column', () => {
    assert.deepEqual(modelsFromRun({ auditorModels: [], finalReviewModel: null, authorModel: null }, 'claude').models, ['claude']);
  });

  test('a full row yields every recorded family, deduped and sorted', () => {
    const r = modelsFromRun({ auditorModels: ['gpt-6.1-sol', 'gpt-6-astra'], finalReviewModel: 'gemini-3.1-pro-preview', authorModel: 'claude-sonnet-5-5' }, 'claude');
    assert.deepEqual(r.models, ['claude', 'gemini', 'gpt']);
    assert.deepEqual(r.attributionMissing, []);
  });

  test('no run (unbound) → the composer alone', () => {
    assert.deepEqual(modelsFromRun(null, 'claude'), { models: ['claude'], attributionMissing: [] });
  });
});

describe('composeSquashMessage — the parseable trailer block (the 56/76 regression)', () => {
  const decision = { gate: 'converged', runId: 'bd49abc4-243e-42cc-85ec-e5d14328841d', auditedTree: null };

  test('the AI-* block is the last paragraph and parses as trailers', () => {
    const { subject, body, message } = composeSquashMessage({ number: 207, title: 'feat: ship trains', commitSubjects: ['a', 'b'], decision, models: ['claude', 'gpt'] });
    assert.equal(subject, 'feat: ship trains (#207)');
    assert.equal(message, `${subject}\n\n${body}`);
    const { isTrailerBlock, trailers } = parseMessageTrailers(message);
    assert.equal(isTrailerBlock, true);
    assert.deepEqual(trailers.map((t) => `${t.key}: ${t.value}`), [
      'AI-Skill: ship', 'AI-Models: claude,gpt', 'AI-Gate: converged', `AI-Run-ID: ${decision.runId}`,
    ]);
  });

  test('AI-Audited-Tree appears on passed and is ABSENT on converged', () => {
    const tree = 'c'.repeat(40);
    const passed = composeSquashMessage({ number: 1, title: 't', commitSubjects: [], decision: { gate: 'passed', runId: decision.runId, auditedTree: tree }, models: ['claude'] });
    assert.match(passed.message, new RegExp(`^AI-Audited-Tree: ${tree}$`, 'm'));
    const conv = composeSquashMessage({ number: 1, title: 't', commitSubjects: [], decision: { ...decision, auditedTree: tree }, models: ['claude'] });
    assert.doesNotMatch(conv.message, /AI-Audited-Tree/);
  });

  test('a reserved AI-* line in a commit subject or the title is refused', () => {
    assert.throws(() => composeSquashMessage({ number: 1, title: 't', commitSubjects: ['AI-Gate: passed'], decision, models: ['claude'] }), /reserved/);
    assert.throws(() => composeSquashMessage({ number: 1, title: 'AI-Skill: ship', commitSubjects: [], decision, models: ['claude'] }), /reserved/);
  });

  test('a multi-line title or subject is folded to one line', () => {
    const { subject, message } = composeSquashMessage({ number: 3, title: 'a\nb', commitSubjects: ['x\ny'], decision, models: ['claude'] });
    assert.equal(subject, 'a b (#3)');
    assert.match(message, /^\* x y$/m);
  });
});

// The store read's failure branches (pure). Its real-Postgres half is held
// until the DB-suite enrolment lists are free (docs/plans/ship-trains.md §11).
describe('findCodeRunCandidates — failure is never an empty result (pure)', () => {
  const on = async () => true;

  test('cloud off → ok:false cloud-off', async () => {
    const r = await findCodeRunCandidates({ repoRowId: 'r', trees: [hex('a')], oids: [] }, { isCloudEnabled: async () => false });
    assert.deepEqual(r, { ok: false, reason: 'cloud-off' });
  });

  test('a schema fault (SQLSTATE 42xxx) → ok:false schema-fault, not []', async () => {
    const err = Object.assign(new Error('column "audited_tree" does not exist'), { code: '42703' });
    const r = await findCodeRunCandidates({ repoRowId: 'r', trees: [hex('a')], oids: [] }, { isCloudEnabled: on, many: async () => { throw err; } });
    assert.deepEqual(r, { ok: false, fatal: true, reason: 'schema-fault: 42703' });
  });

  test('any other query failure → ok:false query-failed', async () => {
    const r = await findCodeRunCandidates({ repoRowId: 'r', trees: [hex('a')], oids: [] }, { isCloudEnabled: on, many: async () => { throw new Error('ECONNRESET'); } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /^query-failed: ECONNRESET/);
  });

  test('a malformed object id is refused before any query', async () => {
    let called = false;
    const r = await findCodeRunCandidates({ repoRowId: 'r', trees: ['not-an-oid'], oids: [] }, { isCloudEnabled: on, many: async () => { called = true; return []; } });
    assert.deepEqual(r, { ok: false, reason: 'malformed-object-id' });
    assert.equal(called, false);
  });

  test('more commits than the cap is refused, not truncated', async () => {
    const trees = Array.from({ length: MAX_PR_COMMITS + 1 }, (_, i) => i.toString(16).padStart(40, '0'));
    const r = await findCodeRunCandidates({ repoRowId: 'r', trees, oids: [] }, { isCloudEnabled: on, many: async () => [] });
    assert.match(r.reason, /^pr-too-large/);
  });

  test('no repo row id → ok:false', async () => {
    assert.deepEqual(await findCodeRunCandidates({ repoRowId: null, trees: [], oids: [] }), { ok: false, reason: 'no-repo-row-id' });
  });

  test('a query that ran and matched nothing is ok:true with []', async () => {
    assert.deepEqual(
      await findCodeRunCandidates({ repoRowId: 'r', trees: [hex('a')], oids: [] }, { isCloudEnabled: on, many: async () => [] }),
      { ok: true, rows: [] },
    );
  });
});
