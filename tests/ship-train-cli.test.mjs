/**
 * @fileoverview ship-train CLI verbs driven through an injected context:
 * fake gh/git/fleet/store. No network, no store, no merges, and no ship-train
 * state anywhere (docs/plans/ship-trains.md §2.1, §7 Phase 3).
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  runPlan, runMessage, runVerify, parsePrList, flagValue, hasOption, githubSlugFromUrl, readBasePinning, TrainRefusal,
} from '../scripts/lib/ship-train/commands.mjs';
import { composeSquashMessage } from '../scripts/lib/ship-train/provenance.mjs';
import { ArgvError } from '../scripts/lib/cli-io.mjs';

const oid = (c) => c.repeat(40);
const BASE = oid('e');
const RUN = 'bd49abc4-243e-42cc-85ec-e5d14328841d';
const REPO = 'Lbstrydom/claude-engineering-skills';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-train-cli-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

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
      // plan: diff <merge-base> <head>; verify: diff <squash>^1 <squash>.
      const last = args.at(-1);
      const landedPr = landed && Object.entries(landed).find(([, v]) => v?.view?.mergeCommit?.oid === last);
      const p = prOfHead(last) ?? (landedPr ? prs[landedPr[0]] : undefined);
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
  test('boolean flags honour the -- terminator too (code R1 H3/M4)', () => {
    assert.equal(hasOption(['--end-of-day'], '--end-of-day'), true);
    assert.equal(hasOption(['--', '--end-of-day'], '--end-of-day'), false);
  });
  test('the repo identity comes from the GitHub remote URL, every form; anything else is refused (code R1 H1)', () => {
    for (const u of ['https://github.com/Lbstrydom/claude-engineering-skills.git', 'git@github.com:Lbstrydom/claude-engineering-skills.git', 'ssh://git@github.com/Lbstrydom/claude-engineering-skills', 'https://github.com/Lbstrydom/claude-engineering-skills/\n']) {
      assert.equal(githubSlugFromUrl(u), 'Lbstrydom/claude-engineering-skills', u);
    }
    assert.throws(() => githubSlugFromUrl('https://gitlab.com/a/b.git'), TrainRefusal);
  });
  test('options after a POSIX -- terminator are positional, not flags (round-1 M11)', () => {
    assert.deepEqual(parsePrList(['--pr', '202', '--', '--pr', '204'], '--pr'), [202]);
    assert.equal(flagValue(['--', '--op', 's-x'], '--op'), null);
  });
  test('a single-value flag refuses a repeat instead of keeping the first (round-1 M3)', () => {
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

  test('a schema fault in the store stops the plan instead of degrading to store-unavailable (round-6 H2)', async () => {
    const ctx = fakeCtx({ prs: { 203: PR203 }, fleet: readyFleet });
    ctx.store.resolveRepoRowIdForRead = async () => ({ ok: false, fatal: true, reason: 'schema-fault: 42703' });
    await assert.rejects(runPlan(ctx, opts({ prs: [203] })), (e) => e instanceof TrainRefusal && /rejected the provenance query/.test(e.message));
    const ctx2 = fakeCtx({ prs: { 203: PR203 }, fleet: readyFleet });
    ctx2.store.findCodeRunCandidates = async () => ({ ok: false, fatal: true, reason: 'schema-fault: 42P01' });
    await assert.rejects(runPlan(ctx2, opts({ prs: [203] })), /schema-fault: 42P01/);
  });

  test('no PRs named and none fleet-ready → refusal', async () => {
    await assert.rejects(runPlan(fakeCtx({ prs: {}, fleet: {} }), opts()), TrainRefusal);
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

describe('verify (stateless, over the fleet manifest)', () => {
  const LOG = { title: 'ship train log', branch: 'ship/train', commits: [{ oid: oid('4'), tree: oid('4'), subject: 'log' }], changes: [['M', 'status.md']] };
  const TRAIN = 't-20261011233000-0001';
  const decision = (gate, runId = RUN) => ({ gate, runId, auditedTree: null });
  const msgFor = (pr, d, models = ['claude', 'gpt']) => composeSquashMessage({ number: pr, title: `pr ${pr}`, commitSubjects: ['x'], decision: d, models }).message;

  /**
   * A landed train: fleet manifest pinning 202 + 204 + the log PR 210, GitHub
   * reporting each MERGED, and main's first-parent chain. `over` swaps facts.
   */
  function landedWorld(over = {}) {
    const m = { 202: oid('5'), 204: oid('6'), 210: oid('0') };
    const chain = over.chain ?? [{ oid: m[202], subject: 'a' }, { oid: m[204], subject: 'b' }, { oid: m[210], subject: 'log' }];
    const notes = [];
    const ctx = fakeCtx({
      // A head substituted for 202 gets its own commit list (the pinned commit +
      // the new head) so git facts resolve; identity is what is under test.
      prs: { 202: PR202, 204: PR204, 210: LOG, ...(over.head202 ? { 9202: { ...PR202, commits: [...PR202.commits, { oid: over.head202, tree: oid('a'), subject: 'update' }] } } : {}) },
      notes,
      landed: {
        tip: chain.at(-1).oid,
        202: { view: { state: 'MERGED', mergeCommit: { oid: m[202] }, headRefOid: over.head202 ?? oid('1') } },
        204: { view: { state: 'MERGED', mergeCommit: { oid: m[204] }, headRefOid: oid('3') } },
        210: { view: { state: 'MERGED', mergeCommit: { oid: m[210] }, headRefOid: oid('4') } },
        chain,
        messages: {
          [m[202]]: over.msg202 ?? msgFor(202, decision('converged')),
          [m[204]]: msgFor(204, decision('converged', 'c3d1f6a2-0000-4000-8000-000000000204')),
          [m[210]]: msgFor(210, decision('not-run', null), ['claude']),
        },
        trees: { [m[202]]: oid('8'), [m[204]]: oid('9'), [m[210]]: oid('b') },
      },
    });
    const runs = {
      [RUN]: { id: RUN, auditedTree: oid('a'), auditedSha: oid('1'), roundConvergedAfter: 2 },
      'c3d1f6a2-0000-4000-8000-000000000204': { id: 'c3d1f6a2-0000-4000-8000-000000000204', auditedTree: oid('c'), auditedSha: oid('3'), roundConvergedAfter: 1 },
      ...(over.runs ?? {}),
    };
    ctx.store.findCodeRunForRepo = async ({ runId }) => ({ ok: true, run: runs[runId] ?? null });
    ctx.readTrain = (id) => (id === TRAIN ? {
      ok: true,
      train: {
        trainId: TRAIN, mergeMethod: 'pr', baseOid: BASE,
        destination: { remote: 'origin', ref: 'refs/heads/main', expectedOid: BASE },
        sources: [202, 204, 210].map((pr) => ({ id: `s${pr}`, oid: { 202: oid('1'), 204: oid('3'), 210: oid('4') }[pr], prNumber: pr, repo: REPO })),
      },
    } : { ok: false, reason: 'no such train' });
    ctx.classifyUpdate = over.classifyUpdate ?? (() => ({ verdict: 'foreign', reason: 'not expected in this fixture' }));
    return { ctx, notes };
  }

  test('a clean landed train: every claim true, final merge is the last train merge, clear to publish, no state written', async () => {
    const { ctx, notes } = landedWorld();
    const before = fs.readdirSync(dir);
    const env = await runVerify(ctx, { train: TRAIN });
    assert.equal(env.finalMergeOid, oid('0'));
    assert.deepEqual(env.actualGates, { 202: 'converged', 204: 'converged', 210: 'not-run' });
    assert.deepEqual(env.deviations, []);
    assert.deepEqual(env.clearance, { clear: true, blocks: [] });
    assert.equal(notes.length, 0, 'no note unless --write-note');
    assert.deepEqual(fs.readdirSync(dir), before, 'stateless: verify writes nothing');
  });

  test("a PR's own commits are measured from the squash's first parent, never from the train base (code R2 H1)", async () => {
    const { ctx } = landedWorld();
    const ranges = [];
    const orig = ctx.git;
    ctx.git = (args) => { if (args[0] === 'log' && !args.includes('--first-parent') && args[1] !== '-1') ranges.push(args.at(-1)); return orig(args); };
    await runVerify(ctx, { train: TRAIN });
    // Every per-PR range starts at <squash>^1 — an update-branch's imported
    // commits (an earlier train merge among them) are on that side and excluded.
    assert.deepEqual(ranges, [`${oid('5')}^1..${oid('1')}`, `${oid('6')}^1..${oid('3')}`, `${oid('0')}^1..${oid('4')}`]);
  });

  test('re-running verify gives the same answer (nothing to go stale)', async () => {
    const { ctx } = landedWorld();
    const a = await runVerify(ctx, { train: TRAIN });
    const b = await runVerify(ctx, { train: TRAIN });
    assert.deepEqual(a, b);
  });

  test('--write-note files the actual gates for the next status entry', async () => {
    const { ctx, notes } = landedWorld();
    await runVerify(ctx, { train: TRAIN, writeNote: true });
    assert.equal(notes.length, 1);
    assert.match(notes[0].text, /Actual gates: #202 converged, #204 converged, #210 not-run/);
  });

  test('interleaved foreign commit: blocked until --accept-interleaved', async () => {
    const chain = [{ oid: oid('5'), subject: 'a' }, { oid: oid('7'), subject: 'foreign' }, { oid: oid('6'), subject: 'b' }, { oid: oid('0'), subject: 'log' }];
    const { ctx } = landedWorld({ chain });
    const env = await runVerify(ctx, { train: TRAIN });
    assert.equal(env.clearance.blocks[0].flag, '--accept-interleaved');
    assert.match(env.deviations.join('|'), /1 foreign commit/);
    assert.equal((await runVerify(ctx, { train: TRAIN, acks: { acceptInterleaved: true } })).clearance.clear, true);
  });

  test('a PR merged at a head the train did not test blocks with NO override (plan R4 H1)', async () => {
    const { ctx } = landedWorld({ head202: oid('d') }); // classifyUpdate says foreign
    const env = await runVerify(ctx, { train: TRAIN, acks: { acceptInterleaved: true, acceptProvenanceMismatch: true } });
    assert.equal(env.clearance.clear, false);
    assert.ok(env.clearance.blocks.some((b) => /did not test: #202/.test(b.reason) && b.flag === null));
  });

  test("a head that is fleet serial's own base-only update of the pinned oid is the same source", async () => {
    const { ctx } = landedWorld({ head202: oid('d'), classifyUpdate: ({ h, priorHead }) => ({ verdict: h === oid('d') && priorHead === oid('1') ? 'own' : 'foreign' }) });
    const orig = ctx.git;
    ctx.git = (args) => (args[0] === 'rev-parse' && args[1] === `${oid('d')}^1` ? `${oid('1')}\n` : orig(args));
    const env = await runVerify(ctx, { train: TRAIN });
    assert.deepEqual(env.clearance, { clear: true, blocks: [] });
  });

  test('a claim naming another repository\'s run is false (repo-scoped, code-mode lookup)', async () => {
    const { ctx } = landedWorld({ runs: { [RUN]: undefined } });
    const env = await runVerify(ctx, { train: TRAIN });
    assert.match(env.deviations.join('|'), /#202: run .* is not a code-mode run of this repository/);
    assert.equal(env.clearance.blocks[0].flag, '--accept-provenance-mismatch');
  });

  test('a schema fault in the run lookup stops verify (fatal, never a silent "no run")', async () => {
    const { ctx } = landedWorld();
    ctx.store.findCodeRunForRepo = async () => ({ ok: false, fatal: true, reason: 'schema-fault: 42703' });
    await assert.rejects(runVerify(ctx, { train: TRAIN }), /rejected the provenance query/);
  });

  test('a train built for another repository is refused, not verified against this one (code R1 H1)', async () => {
    const { ctx } = landedWorld();
    ctx.repo = () => 'someone/else';
    await assert.rejects(runVerify(ctx, { train: TRAIN }), /was built for .* but origin here is someone\/else/);
  });

  test('an unknown train is refused; a non-pr train is refused', async () => {
    const { ctx } = landedWorld();
    await assert.rejects(runVerify(ctx, { train: 't-20261011233000-9999' }), /no such train/);
    const orig = ctx.readTrain;
    ctx.readTrain = (id) => { const t = orig(id); t.train.mergeMethod = 'direct-squash'; return t; };
    await assert.rejects(runVerify(ctx, { train: TRAIN }), /pr-mode trains only/);
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
