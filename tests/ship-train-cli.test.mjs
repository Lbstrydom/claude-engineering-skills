/**
 * @fileoverview ship-train CLI verbs driven through an injected context:
 * fake gh/git/fleet/store, real receipt files in a temp dir. No network, no
 * store, no merges (docs/plans/ship-trains.md §2.1, §7 Phase 3).
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  runPlan, runPrepare, runMessage, runVerify, runAbandon, parsePrList, flagValue, singlePr, readBasePinning, TrainRefusal,
} from '../scripts/lib/ship-train/commands.mjs';
import { readReceipt, updateReceipt } from '../scripts/lib/ship-train/receipt.mjs';
import { publicationClearance } from '../scripts/lib/ship-train/verify.mjs';
import { composeSquashMessage } from '../scripts/lib/ship-train/provenance.mjs';
import { ArgvError } from '../scripts/lib/cli-io.mjs';

const oid = (c) => c.repeat(40);
const BASE = oid('e');
const RUN = 'bd49abc4-243e-42cc-85ec-e5d14328841d';
const REPO = 'Lbstrydom/claude-engineering-skills';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-train-cli-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/**
 * A fake world: PRs keyed by number with commits [{oid, tree, subject}] and a
 * change list; a store returning `runs`; fleet sessions by branch.
 */
function fakeCtx({ prs, runs = [], fleet = {}, pinning = { rules: [], protection: '404' }, store = 'ok', landed = null, notes = [] }) {
  const gh = (args) => {
    const [a0, a1, a2] = args;
    if (a0 === 'api' && /\/rules\/branches\//.test(a1)) return JSON.stringify(pinning.rules);
    if (a0 === 'api' && /\/rulesets\/\d+$/.test(a1)) return JSON.stringify(pinning.rulesets[a1.split('/').at(-1)]);
    if (a0 === 'api' && /\/protection$/.test(a1)) {
      if (pinning.protection === '404') throw Object.assign(new Error('gh: Branch not protected (HTTP 404)'), { stderr: 'Branch not protected (HTTP 404)' });
      return JSON.stringify(pinning.protection);
    }
    if (a0 === 'pr' && a1 === 'view') {
      const n = Number(a2);
      if (landed?.[n]) return JSON.stringify(landed[n].view);
      const p = prs[n];
      return JSON.stringify({ number: n, title: p.title, state: p.state ?? 'OPEN', isDraft: false, headRefOid: p.commits.at(-1).oid, headRefName: p.branch, baseRefName: 'main' });
    }
    throw new Error(`fake gh: unexpected ${args.join(' ')}`);
  };
  const byRef = (ref) => {
    const m = /^refs\/ship-train\/pr\/(\d+)$/.exec(ref);
    return m ? prs[Number(m[1])].commits.at(-1).oid : null;
  };
  const prOfHead = (h) => Object.values(prs).find((p) => p.commits.at(-1).oid === h);
  const git = (args) => {
    const [cmd] = args;
    if (cmd === 'fetch') return '';
    if (cmd === 'rev-parse') {
      const ref = args[1];
      if (ref.startsWith('refs/ship-train/base/')) return `${landed?.tip ?? BASE}\n`;
      if (byRef(ref)) return `${byRef(ref)}\n`;
      const t = /^([0-9a-f]{40})\^\{tree\}$/.exec(ref);
      if (t) {
        const head = prOfHead(t[1]);
        if (head) return `${head.commits.at(-1).tree}\n`;
        if (landed?.trees?.[t[1]]) return `${landed.trees[t[1]]}\n`;
      }
      throw new Error(`fake git rev-parse ${ref}`);
    }
    if (cmd === 'merge-base') return `${BASE}\n`;
    if (cmd === 'log' && args.includes('--first-parent')) return landed.chain.map((c) => `${c.oid}\t${c.subject}`).join('\n');
    if (cmd === 'log' && args[1] === '-1') return landed.messages[args[3]];
    if (cmd === 'log') {
      const head = args.at(-1).split('..')[1];
      const p = prOfHead(head);
      return args.includes('--format=%s') ? p.commits.map((c) => c.subject).join('\n') : p.commits.map((c) => `${c.oid} ${c.tree}`).join('\n');
    }
    if (cmd === 'diff') {
      const p = prOfHead(args.at(-1));
      return p.changes.map(([s, f]) => `${s}\0${f}\0`).join('');
    }
    throw new Error(`fake git: unexpected ${args.join(' ')}`);
  };
  return {
    cwd: dir,
    git,
    gh,
    repo: () => REPO,
    fleetStatus: () => JSON.stringify({ status: { base: { name: 'main' }, items: Object.entries(fleet).map(([branch, s]) => ({ branch, state: s.state, ready: { oid: s.oid }, pr: { number: s.pr } })) } }),
    closure: () => new Set(['scripts/ship-commit.mjs']),
    gitCommonDir: () => dir,
    store: {
      resolveRepoRowIdForRead: async () => (store === 'ok' ? { ok: true, repoRowId: 'repo-1' } : { ok: false, reason: store }),
      findCodeRunCandidates: async ({ trees, oids }) => ({ ok: true, rows: runs.filter((r) => trees.includes(r.auditedTree) || oids.includes(r.auditedSha)) }),
    },
    writePendingNote: (sha, text) => { notes.push({ sha, text }); return `note-${sha.slice(0, 8)}`; },
    now: () => new Date('2026-10-11T23:30:00Z'),
  };
}

const PR202 = { title: 'fix(store): x', branch: 'fix/a', commits: [{ oid: oid('1'), tree: oid('a'), subject: 'fix: one' }], changes: [['M', 'scripts/ship-commit.mjs']] };
const PR203 = { title: 'docs: y', branch: 'docs/b', commits: [{ oid: oid('2'), tree: oid('b'), subject: 'docs: two' }], changes: [['M', 'docs/x.md']] };
const PR204 = { title: 'feat: z', branch: 'feat/c', commits: [{ oid: oid('3'), tree: oid('c'), subject: 'feat: three' }], changes: [['M', 'scripts/internal.mjs']] };
const converged = (tree, sha) => ({ id: RUN, auditedTree: tree, auditedSha: sha, roundConvergedAfter: 2, createdAt: '2026-10-11T20:00:00Z', auditorModels: ['gpt-6.1-sol'], finalReviewModel: 'gemini-3.1-pro-preview', authorModel: null });
const readyFleet = { 'fix/a': { state: 'ready', oid: oid('1'), pr: 202 }, 'docs/b': { state: 'ready', oid: oid('2'), pr: 203 }, 'feat/c': { state: 'ready', oid: oid('3'), pr: 204 } };
const opts = (over = {}) => ({ prs: [], composer: 'claude', overrides: { waive: [], allowUnaudited: [], endOfDay: false }, ...over });

describe('argv helpers', () => {
  test('parsePrList unions repeated and comma-separated values', () => {
    assert.deepEqual(parsePrList(['x', '--pr', '202,203', '--pr=204', '--pr', '202'], '--pr'), [202, 203, 204]);
  });
  test('parsePrList refuses a non-number and a missing value', () => {
    assert.throws(() => parsePrList(['--pr', 'abc'], '--pr'), ArgvError);
    assert.throws(() => parsePrList(['--pr'], '--pr'), ArgvError);
    assert.throws(() => parsePrList(['--pr', '--json'], '--pr'), ArgvError);
  });
  test('options after a POSIX -- terminator are positional, not flags (round-1 M11)', () => {
    assert.deepEqual(parsePrList(['--pr', '202', '--', '--pr', '204'], '--pr'), [202]);
    assert.equal(flagValue(['--', '--op', 's-x'], '--op'), null);
  });
  test('a single-value flag refuses a list or a repeat instead of keeping the first (round-1 M3)', () => {
    assert.equal(singlePr(['--log-pr', '210'], '--log-pr'), 210);
    assert.throws(() => singlePr(['--log-pr', '210,211'], '--log-pr'), ArgvError);
    assert.throws(() => flagValue(['--op', 'a', '--op=b'], '--op'), ArgvError);
  });
});

describe('readBasePinning', () => {
  const ctxWith = (pinning) => fakeCtx({ prs: {}, pinning });
  test('no ruleset and a 404 protection read → none', () => {
    assert.equal(readBasePinning(ctxWith({ rules: [], protection: '404' }), REPO, 'main').verdict, 'none');
  });
  const strictRule = [{ type: 'required_status_checks', ruleset_id: 7, parameters: { strict_required_status_checks_policy: true } }];
  test('a strict ruleset that is active with NO bypass actors → strict', () => {
    const r = readBasePinning(ctxWith({ rules: strictRule, rulesets: { 7: { enforcement: 'active', bypass_actors: [] } }, protection: '404' }), REPO, 'main');
    assert.equal(r.verdict, 'strict');
  });
  test('a strict ruleset with a bypass actor, or not active, does NOT pin the base (round-1 M6)', () => {
    const bypass = { 7: { enforcement: 'active', bypass_actors: [{ actor_type: 'RepositoryRole', actor_id: 5 }] } };
    assert.equal(readBasePinning(ctxWith({ rules: strictRule, rulesets: bypass, protection: '404' }), REPO, 'main').verdict, 'none');
    const evaluate = { 7: { enforcement: 'evaluate', bypass_actors: [] } };
    assert.equal(readBasePinning(ctxWith({ rules: strictRule, rulesets: evaluate, protection: '404' }), REPO, 'main').verdict, 'none');
  });
  test('classic strict checks pin the base only with enforce_admins on', () => {
    const p = (admins) => ({ required_status_checks: { strict: true }, enforce_admins: { enabled: admins } });
    assert.equal(readBasePinning(ctxWith({ rules: [], protection: p(true) }), REPO, 'main').verdict, 'strict');
    assert.equal(readBasePinning(ctxWith({ rules: [], protection: p(false) }), REPO, 'main').verdict, 'none');
  });
  test('an unreadable protection API fails closed to none and says so', () => {
    const ctx = ctxWith({ rules: [] });
    ctx.gh = () => { throw Object.assign(new Error('HTTP 500'), { stderr: 'server error' }); };
    const r = readBasePinning(ctx, REPO, 'main');
    assert.equal(r.verdict, 'none');
    assert.match(r.evidence, /unreadable.*fail-closed/);
  });
});

describe('plan', () => {
  test('defaults to fleet-ready PRs; tiers, bindings and planned gates per PR', async () => {
    const ctx = fakeCtx({ prs: { 202: PR202, 203: PR203, 204: PR204 }, runs: [converged(oid('a'), oid('1')), { ...converged(oid('c'), oid('3')), id: 'run-204' }], fleet: readyFleet });
    const env = await runPlan(ctx, opts());
    assert.deepEqual(env.prs.map((p) => [p.pr, p.tier, p.decision?.gate ?? p.refusal.code]), [
      [202, 'urgent', 'converged'], [203, 'ride-along', 'not-run'], [204, 'standard', 'converged'],
    ]);
    assert.equal(env.basePinning.verdict, 'none');
    assert.equal(env.due.due, true);
    assert.equal(env.trainReady, true);
    assert.deepEqual(env.prs[0].decision.models, ['claude', 'gemini', 'gpt']);
  });

  test('a strict destination turns an at-head converged audit into passed', async () => {
    const ctx = fakeCtx({ prs: { 202: PR202 }, runs: [converged(oid('a'), oid('1'))], fleet: readyFleet,
      pinning: { rules: [{ type: 'required_status_checks', ruleset_id: 7, parameters: { strict_required_status_checks_policy: true } }], rulesets: { 7: { enforcement: 'active', bypass_actors: [] } }, protection: '404' } });
    const env = await runPlan(ctx, opts({ prs: [202] }));
    assert.equal(env.prs[0].decision.gate, 'passed');
    assert.equal(env.prs[0].decision.auditedTree, oid('a'));
  });

  test('an unaudited standard PR is refused with its override named; a non-ready session is blocked', async () => {
    const ctx = fakeCtx({ prs: { 204: PR204 }, fleet: { 'feat/c': { state: 'working', oid: oid('3'), pr: 204 } } });
    const env = await runPlan(ctx, opts({ prs: [204], overrides: { waive: [], allowUnaudited: [], endOfDay: true } }));
    assert.equal(env.prs[0].refusal.code, 'unaudited');
    assert.equal(env.prs[0].refusal.override, '--allow-unaudited');
    assert.match(env.prs[0].blockers.join('|'), /not fleet-ready/);
    assert.equal(env.trainReady, false);
  });

  test('a store that cannot be read refuses non-ride-alongs and lets ride-alongs through as not-run', async () => {
    const ctx = fakeCtx({ prs: { 202: PR202, 203: PR203 }, fleet: readyFleet, store: 'cloud-off' });
    const env = await runPlan(ctx, opts({ prs: [202, 203] }));
    assert.equal(env.storeState, 'cloud-off');
    assert.equal(env.prs[0].refusal.code, 'store-unavailable');
    assert.equal(env.prs[1].decision.gate, 'not-run');
  });

  test('a ready session registered for a DIFFERENT PR on the same branch is a blocker (round-1 H3)', async () => {
    const ctx = fakeCtx({ prs: { 202: PR202 }, runs: [converged(oid('a'), oid('1'))], fleet: { 'fix/a': { state: 'ready', oid: oid('1'), pr: 999 } } });
    const env = await runPlan(ctx, opts({ prs: [202] }));
    assert.match(env.prs[0].blockers.join('|'), /registered for PR #999, not #202/);
    assert.equal(env.trainReady, false);
  });

  test('the destination is fleet\'s resolved base; a fleet status without one is refused', async () => {
    const ctx = fakeCtx({ prs: { 202: PR202 }, fleet: readyFleet });
    ctx.fleetStatus = () => JSON.stringify({ status: { items: [] } });
    await assert.rejects(runPlan(ctx, opts({ prs: [202] })), /no usable base branch/);
  });

  test('no PRs named and none fleet-ready → refusal', async () => {
    await assert.rejects(runPlan(fakeCtx({ prs: {}, fleet: {} }), opts()), TrainRefusal);
  });
});

describe('prepare', () => {
  test('writes a receipt with the planning snapshot; refuses when the train is not ready', async () => {
    const ctx = fakeCtx({ prs: { 202: PR202, 203: PR203 }, runs: [converged(oid('a'), oid('1'))], fleet: readyFleet });
    const env = await runPrepare(ctx, opts({ prs: [202, 203] }));
    const r = readReceipt(dir, env.opId);
    assert.equal(r.phase, 'prepared');
    assert.deepEqual(r.selected.map((s) => [s.pr, s.decision.gate]), [[202, 'converged'], [203, 'not-run']]);
    assert.equal(r.basePinning.verdict, 'none');

    const notReady = fakeCtx({ prs: { 204: PR204 }, fleet: readyFleet });
    await assert.rejects(runPrepare(notReady, opts({ prs: [204] })), (e) => e instanceof TrainRefusal && e.details.refusals.length === 1);
  });

  test('a ride-along-only set is not due and cannot be prepared', async () => {
    const ctx = fakeCtx({ prs: { 203: PR203 }, fleet: readyFleet });
    await assert.rejects(runPrepare(ctx, opts({ prs: [203], overrides: { waive: [], allowUnaudited: [], endOfDay: true } })),
      (e) => e instanceof TrainRefusal && e.details.due.due === false);
  });

  test('--op --log-pr records the log PR and moves prepared → log-opened', async () => {
    const ctx = fakeCtx({ prs: { 202: PR202, 210: { title: 'ship train log', branch: 'ship/train', commits: [{ oid: oid('9'), tree: oid('9'), subject: 'log' }], changes: [] } }, runs: [converged(oid('a'), oid('1'))], fleet: readyFleet });
    const { opId } = await runPrepare(ctx, opts({ prs: [202] }));
    const env = await runPrepare(ctx, opts({ op: opId, logPr: 210 }));
    assert.equal(env.phase, 'log-opened');
    assert.deepEqual(readReceipt(dir, opId).logPr, { number: 210, headOid: oid('9') });
    await assert.rejects(runPrepare(ctx, opts({ op: opId, logPr: 202 })), /already a train source|log-opened/);
  });
});

describe('message', () => {
  test('renders the squash subject and a body ending in the AI-* block', async () => {
    const ctx = fakeCtx({ prs: { 202: PR202 }, runs: [converged(oid('a'), oid('1'))], fleet: readyFleet });
    const env = await runMessage(ctx, opts({ prs: [202] }));
    assert.equal(env.subject, 'fix(store): x (#202)');
    assert.match(env.body, /\nAI-Gate: converged\nAI-Run-ID: bd49abc4-243e-42cc-85ec-e5d14328841d\n$/);
  });
  test('needs exactly one PR', async () => {
    await assert.rejects(runMessage(fakeCtx({ prs: {} }), opts({ prs: [1, 2] })), ArgvError);
  });
});

describe('verify / abandon', () => {
  const LOG = { title: 'ship train log', branch: 'ship/train', commits: [{ oid: oid('4'), tree: oid('4'), subject: 'log' }], changes: [['M', 'status.md']] };

  async function landedOp({ interleave = false } = {}) {
    const ctx0 = fakeCtx({ prs: { 202: PR202, 204: PR204, 210: LOG }, runs: [converged(oid('a'), oid('1')), { ...converged(oid('c'), oid('3')), id: 'run-204' }], fleet: readyFleet });
    const { opId } = await runPrepare(ctx0, opts({ prs: [202, 204] }));
    await runPrepare(ctx0, opts({ op: opId, logPr: 210 }));
    const r = readReceipt(dir, opId);
    // Stand in for Cluster B's land: persist actual decisions, then mark landed.
    updateReceipt(dir, opId, (d) => { d.phase = 'built'; d.trainId = 't-20261011233000-0001'; d.landingOrder = [202, 204, 210]; });
    const logClaims = { gate: 'not-run', runId: null, auditedTree: null, models: ['claude'] };
    updateReceipt(dir, opId, (d) => {
      d.phase = 'landing';
      d.actual = Object.fromEntries([
        ...r.selected.map((s) => [String(s.pr), {
          headOid: s.headOid, baseOid: BASE, basePinning: 'none',
          claims: { gate: s.decision.gate, runId: s.decision.runId, auditedTree: s.decision.auditedTree, models: s.decision.models },
          subject: 's', bodySha256: 'f'.repeat(64), bodyPath: 'p', at: 't',
        }]),
        ['210', { headOid: oid('4'), baseOid: BASE, basePinning: 'none', claims: logClaims, subject: 's', bodySha256: 'f'.repeat(64), bodyPath: 'p', at: 't' }],
      ]);
    });
    updateReceipt(dir, opId, (d) => { d.phase = 'landed'; });
    const msg = (s) => composeSquashMessage({ number: s.pr, title: s.title, commitSubjects: ['x'], decision: s.decision, models: s.decision.models }).message;
    const [m202, m204, m210] = [oid('5'), oid('6'), oid('0')];
    const chain = interleave
      ? [{ oid: m202, subject: 'a' }, { oid: oid('7'), subject: 'foreign' }, { oid: m204, subject: 'b' }, { oid: m210, subject: 'log' }]
      : [{ oid: m202, subject: 'a' }, { oid: m204, subject: 'b' }, { oid: m210, subject: 'log' }];
    const notes = [];
    const ctx = fakeCtx({
      prs: {}, notes,
      landed: {
        tip: chain.at(-1).oid,
        202: { view: { state: 'MERGED', mergeCommit: { oid: m202 } } },
        204: { view: { state: 'MERGED', mergeCommit: { oid: m204 } } },
        210: { view: { state: 'MERGED', mergeCommit: { oid: m210 } } },
        chain,
        messages: {
          [m202]: msg(r.selected[0]),
          [m204]: msg(r.selected[1]),
          [m210]: composeSquashMessage({ number: 210, title: 'log', commitSubjects: ['log'], decision: logClaims, models: logClaims.models }).message,
        },
        trees: { [m202]: oid('8'), [m204]: oid('9'), [m210]: oid('b') },
      },
    });
    return { opId, ctx, notes };
  }

  test('verify on a clean landing: verified, final merge recorded, no pending note', async () => {
    const { opId, ctx, notes } = await landedOp();
    const env = await runVerify(ctx, { op: opId });
    assert.equal(env.phase, 'verified');
    assert.equal(readReceipt(dir, opId).verify.finalMergeOid, oid('0'));
    assert.deepEqual(env.deviations, []);
    assert.deepEqual(env.clearance, { clear: true, blocks: [] });
    assert.equal(notes.length, 0);
  });

  test('verify with an interleaved foreign commit: verified-interleaved and a pending note', async () => {
    const { opId, ctx, notes } = await landedOp({ interleave: true });
    const env = await runVerify(ctx, { op: opId });
    assert.equal(env.phase, 'verified-interleaved');
    // Recorded is not enough: the publication predicate refuses until the
    // interleaved oid is accepted into an amendment (round-2 H1).
    assert.equal(env.clearance.clear, false);
    assert.equal(env.clearance.blocks[0].flag, '--accept-interleaved');
    const amended = updateReceipt(dir, opId, (d) => { d.publicationAmendment = { acceptedOids: [oid('7')], at: 't' }; });
    assert.deepEqual(publicationClearance(amended), { clear: true, blocks: [] });
    assert.equal(notes.length, 1);
    assert.match(notes[0].text, /interleaved/);
  });

  test('re-verify refreshes the record and computes clearance from the FRESH state (round-3 H2)', async () => {
    const { opId, ctx } = await landedOp();
    assert.equal((await runVerify(ctx, { op: opId })).clearance.clear, true);
    // The log PR's merge commit is later found carrying a different gate claim.
    const m210 = oid('0');
    const orig = ctx.git;
    ctx.git = (args) => (args[0] === 'log' && args[1] === '-1' && args[3] === m210
      ? composeSquashMessage({ number: 210, title: 'log', commitSubjects: ['log'], decision: { gate: 'waived', runId: RUN, auditedTree: null }, models: ['claude'] }).message
      : orig(args));
    const env = await runVerify(ctx, { op: opId });
    assert.equal(env.firstVerify, false);
    assert.equal(env.clearance.clear, false);
    assert.equal(readReceipt(dir, opId).verify.publicationBlocked, true);
  });

  test('a refused re-verify (the train changed under its record) blocks publication durably (round-4 H1/H2)', async () => {
    const { opId, ctx } = await landedOp();
    assert.equal((await runVerify(ctx, { op: opId })).clearance.clear, true);
    // A foreign commit now appears before the final merge: clean → interleaved.
    const orig = ctx.git;
    ctx.git = (args) => (args[0] === 'log' && args.includes('--first-parent')
      ? [`${oid('5')}\ta`, `${oid('7')}\tforeign`, `${oid('6')}\tb`, `${oid('0')}\tlog`].join('\n')
      : orig(args));
    await assert.rejects(runVerify(ctx, { op: opId }), (e) => e instanceof TrainRefusal && /changed under its record/.test(e.message));
    const after = readReceipt(dir, opId);
    assert.equal(after.phase, 'verified');
    assert.equal(after.verify.interleaved.length, 0, 'the original record is kept, not overwritten');
    assert.equal(after.revocation.freshPhase, 'verified-interleaved');
    const c = publicationClearance(after);
    assert.equal(c.clear, false);
    assert.equal(c.blocks.find((b) => /revoked/.test(b.reason)).flag, null);
  });

  test('interleaved → clean on re-verify is recorded as a revocation the receipt can hold (round-5 H1/H3)', async () => {
    const { opId, ctx } = await landedOp({ interleave: true });
    await runVerify(ctx, { op: opId });
    const orig = ctx.git;
    ctx.git = (args) => (args[0] === 'log' && args.includes('--first-parent')
      ? [`${oid('5')}\ta`, `${oid('6')}\tb`, `${oid('0')}\tlog`].join('\n')
      : orig(args));
    await assert.rejects(runVerify(ctx, { op: opId }), /now verifies as verified/);
    const after = readReceipt(dir, opId); // validates: the old interleaved record stays intact
    assert.equal(after.phase, 'verified-interleaved');
    assert.equal(after.revocation.freshPhase, 'verified');
    assert.equal(publicationClearance(after).clear, false);
  });

  test('a receipt that changes while verify is computing is never clobbered (round-5 H2)', async () => {
    const { opId, ctx } = await landedOp();
    const orig = ctx.git;
    ctx.git = (args) => {
      if (args[0] === 'log' && args.includes('--first-parent')) {
        // A concurrent writer lands between verify's read and its write.
        updateReceipt(dir, opId, (d) => { d.trainId = 't-20261011233000-0002'; });
      }
      return orig(args);
    };
    await assert.rejects(runVerify(ctx, { op: opId }), /changed while it was being verified/);
    const after = readReceipt(dir, opId);
    assert.equal(after.phase, 'landed');
    assert.equal(after.trainId, 't-20261011233000-0002');
  });

  test('verify refuses before the train has landed', async () => {
    const ctx = fakeCtx({ prs: { 202: PR202 }, runs: [converged(oid('a'), oid('1'))], fleet: readyFleet });
    const { opId } = await runPrepare(ctx, opts({ prs: [202] }));
    await assert.rejects(runVerify(ctx, { op: opId }), TrainRefusal);
  });

  test('abandon works before landing and is refused after it', async () => {
    const ctx = fakeCtx({ prs: { 202: PR202 }, runs: [converged(oid('a'), oid('1'))], fleet: readyFleet });
    const { opId } = await runPrepare(ctx, opts({ prs: [202] }));
    assert.equal((await runAbandon(ctx, { op: opId })).phase, 'abandoned');
    const { opId: landedId, ctx: c2 } = await landedOp();
    await assert.rejects(runAbandon(c2, { op: landedId }), (e) => e.code === 'ILLEGAL_TRANSITION');
  });
});

describe('the real CLI process', () => {
  const script = path.resolve('scripts/ship-train.mjs');
  const node = (args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (e) {
      return { code: e.status, out: `${e.stdout}${e.stderr}` };
    }
  };
  test('--selfcheck-relocation prints OK and exits 0', () => {
    const r = node(['--selfcheck-relocation']);
    assert.equal(r.code, 0);
    assert.match(r.out, /^OK$/m);
  });
  test('an unknown verb and an unknown flag both exit 2', () => {
    assert.equal(node(['land']).code, 2);
    assert.equal(node(['plan', '--frobnicate']).code, 2);
  });
});
