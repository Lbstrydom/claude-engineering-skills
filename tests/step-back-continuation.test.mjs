/**
 * Pilot 1 (docs/plans/seeded-defect-benchmark.md §2): freeze + partition, the continuation contract, and the pre-registered
 * decision rule. Offline: every provider is injected, nothing here spends.
 *
 * Controls: the gate is the REAL `gateRoundCap` reading the RESTORED files with the production readers (a restore that wrote the
 * wrong sid, round or ledger shape would make the gate see nothing); the arms' argv differ in exactly the meta flags (red on a
 * deliberately leaky arm); `decideMetaPilot` is walked row by row including a 1-1 split, a zero CONTINUE sum and precedence.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gateRoundCap } from '../scripts/lib/audit/round-cap-gate.mjs';
import { readMetaLog, metaLogPath, foldMetaLog } from '../scripts/lib/audit/meta-review.mjs';
import { topicOf } from '../scripts/lib/audit/cap-productivity.mjs';
import { freezeMetaPilot, assertPartition, pointsFor, verifySnapshots, seededShuffle } from '../scripts/lib/audit/step-back-pilot-freeze.mjs';
import {
  buildArmInvocations, stripMetaFlags, restorePointFiles, validateTrigger, classifyOutcome, sidFor, runContinuation, childEnv, toAuditLedgerEntries, CONTINUATION_PAST_CAP_REASON,
} from '../scripts/lib/audit/step-back-continuation.mjs';
import { decideMetaPilot, decideMetaPilotBothJudges, scoreMetaRuns } from '../scripts/lib/audit/meta-pilot-decision.mjs';

const T0 = Date.parse('2026-11-01T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

/** A synthetic export: `spec` = [{repo, branch, mode, n, gapH?, startH?, noShaAt?}]. Every finding gets a ruled event. */
function makeExport(spec) {
  const runs = []; const findings = []; const events = [];
  spec.forEach((s, si) => {
    for (let i = 0; i < s.n; i++) {
      const id = `run-${si}-${i + 1}`;
      const at = T0 + (s.startH ?? si * 1000) * 3_600_000 + i * (s.gapH ?? 1) * 3_600_000;
      runs.push({ id, repo_id: s.repo, branch: s.branch, audited_sha: s.noShaAt === i + 1 ? null : `${String(si).padStart(2, '0')}${String(i + 1).padStart(2, '0')}`.padEnd(40, 'a'), diff_ref: null, created_at: iso(at), mode: s.mode, plan_file: s.noPlan ? null : 'docs/plans/p.md' });
      for (const k of [0, 1]) {
        const fid = `f-${si}-${i + 1}-${k}`;
        findings.push({ id: fid, run_id: id, finding_fingerprint: `fp-${si}-${k}`, severity: k ? 'MEDIUM' : 'HIGH', category: '[backend] x', primary_file: `src/f${k}.mjs`, detail_snapshot: `detail ${si}-${k}`, round_raised: i + 1, created_at: iso(at) });
        events.push({ id: `e-${fid}`, finding_id: fid, adjudication_outcome: 'accepted', remediation_state: 'fixed', ruling: 'sustain', round: i + 1, created_at: iso(at + 60_000), superseded_at: null, overrides_event_id: null });
      }
    }
  });
  return { version: 1, exportedAt: '2026-11-23T00:00:00Z', runs, findings, events, exportSha256: 'x' };
}
const REPOS = { rCES: { name: 'Lbstrydom/claude-engineering-skills', localPath: '/x/ces' }, rWine: { name: 'Lbstrydom/wine-cellar-app', localPath: '/x/wine' }, rWork: { name: 'louis-strydom_wartsila/storyline', localPath: '/x/work' } };

const bigSpec = () => [
  ...Array.from({ length: 8 }, (_, i) => ({ repo: 'rWine', branch: `feat/w${i}`, mode: 'code', n: 7 })),
  ...Array.from({ length: 8 }, (_, i) => ({ repo: 'rCES', branch: `feat/c${i}`, mode: 'plan', n: 4 })),
  { repo: 'rWork', branch: 'feat/work', mode: 'code', n: 9 },
  { repo: 'rWine', branch: 'main', mode: 'code', n: 30 },
];

describe('freeze + partition (§2.1)', () => {
  const a = freezeMetaPilot({ exp: makeExport(bigSpec()), repos: REPOS, seed: 's1' });

  test('a work repo and an ambiguous branch are excluded, never sampled', () => {
    assert.ok(a.dataset.points.every((p) => p.repo !== 'louis-strydom_wartsila/storyline'));
    assert.ok(a.dataset.points.every((p) => p.branch !== 'main'));
    assert.ok(a.dataset.excluded.some((e) => /not authorised/.test(e.reason)));
    assert.ok(a.dataset.excluded.some((e) => /interleaves/.test(e.reason)));
  });
  test('code sessions of 7 runs yield a T2 (checkpoint 3) and a T1 (checkpoint 6) point; plan sessions of 4 a T1 at 3', () => {
    const code = a.dataset.points.filter((p) => p.mode === 'code'); const plan = a.dataset.points.filter((p) => p.mode === 'plan');
    assert.deepEqual([...new Set(code.map((p) => `${p.trigger}@${p.checkpoint}->${p.round}`))].sort(), ['T1@6->7', 'T2@3->4']);
    assert.deepEqual([...new Set(plan.map((p) => `${p.trigger}@${p.checkpoint}->${p.round}`))], ['T1@3->4']);
    // the tree a point audits is the NEXT run's sha (what production would audit), and the snapshot is sealed
    const p = code.find((x) => x.trigger === 'T1');
    assert.equal(p.treeSha, a.snapshots[p.pointId] && makeExport(bigSpec()).runs.find((r) => r.id === p.runIds[6]).audited_sha);
  });
  test('the four sets are disjoint by SESSION, the pilot meets its code floor and never overshoots 16', () => {
    assert.ok(assertPartition(a.dataset));
    const by = a.dataset.counts.bySet;
    assert.ok(by.pilot.points <= 16 && by.pilot.points >= 12, JSON.stringify(by));
    assert.ok(by.pilot.code >= 6, JSON.stringify(by));
    assert.ok(by.rehearsal.points <= 5 && by.rehearsal.points >= 1);
    const sets = new Map(); for (const p of a.dataset.points.filter((x) => x.status === 'recoverable')) { const s = sets.get(p.sessionId); assert.ok(!s || s === p.set); sets.set(p.sessionId, p.set); }
  });
  test('deterministic: the same export, repos and seed freeze byte-identically; another seed repartitions', () => {
    const b = freezeMetaPilot({ exp: makeExport(bigSpec()), repos: REPOS, seed: 's1' });
    assert.equal(b.dataset.datasetHash, a.dataset.datasetHash);
    assert.notEqual(freezeMetaPilot({ exp: makeExport(bigSpec()), repos: REPOS, seed: 's2' }).dataset.datasetHash, a.dataset.datasetHash);
    assert.deepEqual(seededShuffle(['a', 'b', 'c', 'd'], 'k'), seededShuffle(['d', 'c', 'b', 'a'], 'k'), 'input order never matters');
  });
  test('the loader refuses a purpose/set mismatch and a tampered sidecar or dataset', () => {
    assert.throws(() => pointsFor({ dataset: a.dataset, set: 'pilot', purpose: 'rehearsal' }), /may not read/);
    assert.ok(pointsFor({ dataset: a.dataset, set: 'rehearsal', purpose: 'rehearsal' }).length >= 1);
    assert.ok(verifySnapshots({ dataset: a.dataset, snapshots: a.snapshots }));
    const id = Object.keys(a.snapshots)[0];
    const bad = structuredClone(a.snapshots); bad[id].ledgerEntries.push({ topicId: 'sneaky' });
    assert.throws(() => verifySnapshots({ dataset: a.dataset, snapshots: bad }), /does not match/);
    const ds = structuredClone(a.dataset); ds.seed = 'other';
    assert.throws(() => verifySnapshots({ dataset: ds, snapshots: a.snapshots }), /recorded hash/);
  });
  test('a next run with no audited_sha, a session that ends at the checkpoint, and a missing plan file are not points', () => {
    const r = freezeMetaPilot({ exp: makeExport([{ repo: 'rCES', branch: 'a', mode: 'plan', n: 4, noShaAt: 4 }, { repo: 'rCES', branch: 'b', mode: 'plan', n: 3 }, { repo: 'rCES', branch: 'c', mode: 'plan', n: 4, noPlan: true }]), repos: REPOS, seed: 's' });
    assert.equal(r.dataset.counts.recoverable, 0);
    assert.equal(r.dataset.points.length, 2); assert.ok(r.dataset.points.every((p) => p.status === 'unrecoverable'));
  });
});

describe('the continuation contract (§2.1) against the REAL gate', () => {
  const frozen = freezeMetaPilot({ exp: makeExport(bigSpec()), repos: REPOS, seed: 's1' });
  const pt = (mode, trigger) => frozen.dataset.points.find((p) => p.mode === mode && p.trigger === trigger && p.status === 'recoverable');

  function gateHarness({ point, arm }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-restore-'));
    const sid = sidFor({ pointId: point.pointId, arm, rep: 0 });
    const snapshot = frozen.snapshots[point.pointId];
    const { auditDir } = restorePointFiles({ dir, point, snapshot, sid });
    const seen = []; const lines = [];
    const H = snapshot.rounds[snapshot.rounds.length - 1].findings;
    const topics = H.map((f) => topicOf(f));
    const metaDeps = {
      buildPack: async () => ({ text: 'PACK', files: [{ path: 'src/f0.mjs' }], notes: [], truncations: [], excluded: { sensitive: 0, unreadable: 0 }, topics, plan: { path: point.planFile, included: true } }),
      repoFiles: () => [], archNeighbours: null, evidence: () => ({ planSha256: 'p', head: 'h', diffSha256: null }),
      computeSignals: () => ({ version: 1, round: point.checkpoint, importanceSource: 't', anyFires: true, unmeasured: [], signals: { reopenRate: { measured: true, fires: true, value: 1, reason: 't' } } }),
      record: () => 'k', flush: async () => {},
      selectProvider: () => ({ ok: true, arm: 'higher', family: 'claude', auditorFamily: 'gpt', provider: { model: 'claude-opus-5-5', sentinel: 'latest-opus', outputCeilingTokens: 4000, call: async (req) => { seen.push(req); return { text: JSON.stringify({ action: 'admit', assessment: { sustainability: 's', efficiency: 'e', effectiveness: 'x' }, rounds: 1, topics: topics.slice(0, 1), reason: 'a real defect remains' }), usage: { input_tokens: 10, output_tokens: 5, usageMissing: false }, sent: true }; } } }),
    };
    const gate = (argv) => gateRoundCap(argv, { cwd: dir, auditDir, env: {}, write: (l) => lines.push(l), metaReview: true, auditorModel: 'gpt-6', metaDeps, build: async ({ round, mode, planFile }) => ({ card: { version: 1, round, mode, planFile, summary: { clusters: 0 } }, text: 'CARD' }), recordCap: async () => ({ recorded: false, reason: 'test' }) });
    return { dir, auditDir, sid, seen, lines, gate, snapshot };
  }

  for (const [mode, trigger, expectCallBeforeRound] of [['plan', 'T1', true], ['code', 'T1', true], ['code', 'T2', true]]) {
    test(`${mode} ${trigger}: the META invocation reaches the gate with the restored sid, round, ledger and trigger`, async () => {
      const point = pt(mode, trigger);
      const h = gateHarness({ point, arm: 'META' });
      try {
        const { invocations } = buildArmInvocations({ point, arm: 'META', base: 'BASE', sid: h.sid });
        assert.equal(invocations.length, 1);
        const argv = invocations[0].map((a) => (a.startsWith('.audit/') ? path.join(h.dir, a) : a));
        const r = await h.gate(argv);
        assert.equal(r.ok, true, h.lines.join(''));
        assert.equal(r.round, point.round);
        assert.equal(h.seen.length, expectCallBeforeRound ? 1 : 0, 'the meta reviewer was consulted exactly once');
        const fold = foldMetaLog(readMetaLog(metaLogPath(h.auditDir, h.sid)).events);
        const d = [...fold.decisions.values()][0];
        assert.equal(d.trigger, trigger); assert.equal(d.round, point.round);
        assert.ok(d.attemptId.startsWith(`${h.sid}-r${point.round}-${trigger}-`), d.attemptId);
        if (trigger === 'T1') assert.equal(r.roundCap.pastCap, true);
      } finally { fs.rmSync(h.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
    });
  }

  test('CONTINUE at T1: the first invocation is REFUSED with no inference call; the second runs under the production override', async () => {
    const point = pt('code', 'T1');
    const h = gateHarness({ point, arm: 'CONTINUE' });
    try {
      const { invocations } = buildArmInvocations({ point, arm: 'CONTINUE', base: 'BASE', sid: h.sid });
      assert.equal(invocations.length, 2);
      const abs = (inv) => inv.map((a) => (a.startsWith('.audit/') ? path.join(h.dir, a) : a));
      const first = await h.gate(abs(invocations[0]));
      assert.equal(first.ok, false); assert.equal(first.exitCode, 4); assert.equal(first.code, 'PAST_CAP_REQUIRED');
      assert.equal(h.seen.length, 0, '--no-meta-review never reaches a provider');
      const second = await h.gate(abs(invocations[1]));
      assert.equal(second.ok, true, h.lines.join('')); assert.equal(second.roundCap.pastCapReason, CONTINUATION_PAST_CAP_REASON);
      assert.equal(h.seen.length, 0);
    } finally { fs.rmSync(h.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  test('CONTINUE at T2 is one invocation and no provider is reached', async () => {
    const point = pt('code', 'T2');
    const h = gateHarness({ point, arm: 'CONTINUE' });
    try {
      const { invocations } = buildArmInvocations({ point, arm: 'CONTINUE', base: 'BASE', sid: h.sid });
      assert.equal(invocations.length, 1);
      const r = await h.gate(invocations[0].map((a) => (a.startsWith('.audit/') ? path.join(h.dir, a) : a)));
      assert.equal(r.ok, true); assert.equal(h.seen.length, 0);
    } finally { fs.rmSync(h.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  test('the arms differ in EXACTLY the meta flags — and the check is red on a leaky arm', () => {
    for (const point of [pt('plan', 'T1'), pt('code', 'T1'), pt('code', 'T2')]) {
      const sid = sidFor({ pointId: point.pointId, arm: 'META', rep: 0 });
      const meta = buildArmInvocations({ point, arm: 'META', base: 'B', sid }).invocations;
      const cont = buildArmInvocations({ point, arm: 'CONTINUE', base: 'B', sid }).invocations;
      for (const c of cont) assert.deepEqual(stripMetaFlags(c), meta[0]);
      assert.ok(cont.every((c) => c.includes('--no-meta-review')));
      // negative control: an arm that also changed --scope is NOT equal after stripping
      const leaky = [...cont[0], '--exclude-paths', 'x'];
      assert.notDeepEqual(stripMetaFlags(leaky), meta[0]);
    }
    assert.deepEqual(childEnv({ base: {}, ledgerFile: 'L' }).AUDIT_BUDGET_LEDGER, 'L');
  });

  test('a trigger mismatch, or a T2 whose checkpoint signal is quiet, is unrecoverable and never run', () => {
    const point = { ...pt('code', 'T2') };
    const snap = frozen.snapshots[point.pointId];
    assert.equal(validateTrigger({ point: { ...point, round: 6 }, snapshot: snap, dir: '.', signals: () => ({ anyFires: true }) }).ok, false);
    const quiet = validateTrigger({ point, snapshot: snap, dir: '.', signals: () => ({ anyFires: false, unmeasured: [] }), git: () => null });
    assert.equal(quiet.ok, false); assert.match(quiet.reason, /did not fire/);
    assert.equal(validateTrigger({ point, snapshot: snap, dir: '.', signals: () => ({ anyFires: true }), git: () => null }).ok, true);
    assert.equal(validateTrigger({ point: pt('code', 'T1'), snapshot: frozen.snapshots[pt('code', 'T1').pointId], dir: '.' }).ok, true);
  });

  test('restore refuses a snapshot that is not the frozen one, and a pre-existing meta log', () => {
    const point = pt('plan', 'T1'); const sid = 'sb-x';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-restore-'));
    try {
      const bad = structuredClone(frozen.snapshots[point.pointId]); bad.ledgerEntries.push({ topicId: 'z' });
      assert.throws(() => restorePointFiles({ dir, point, snapshot: bad, sid }), /does not match the frozen point/);
      fs.mkdirSync(path.join(dir, '.audit'), { recursive: true }); fs.writeFileSync(metaLogPath(path.join(dir, '.audit'), sid), '');
      assert.throws(() => restorePointFiles({ dir, point, snapshot: frozen.snapshots[point.pointId], sid }), /already exists/);
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  test('the reconstructed ledger carries the fields the audit readers need', () => {
    const e = toAuditLedgerEntries(frozen.snapshots[pt('plan', 'T1').pointId])[0];
    for (const k of ['topicId', 'semanticHash', 'severity', 'category', 'section', 'detail', 'pass', 'ruling', 'rulingRationale', 'resolvedRound', 'originalSeverity']) assert.ok(k in e, k);
    assert.equal(e.pass, 'backend');
  });

  test('runContinuation end to end with an injected audit child: a META stop records the debt command and never runs it', async () => {
    const point = pt('plan', 'T1'); const snapshot = frozen.snapshots[point.pointId];
    const spawned = [];
    let spend = 0;
    const row = await runContinuation({
      point, snapshot, arm: 'META', rep: 0, repoRoot: '/r', auditScript: '/a.mjs', ledgerFile: 'L',
      deps: {
        withTree: async (_w, fn) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tree-')); fs.mkdirSync(path.join(d, 'docs/plans'), { recursive: true }); fs.writeFileSync(path.join(d, 'docs/plans/p.md'), '#'); try { return await fn(d); } finally { fs.rmSync(d, { recursive: true, force: true }); } },
        spawn: (argv) => { spawned.push(argv); spend += 0.9; return { status: 4, stderr: '  [meta-review] STOP (a). Capture the open topics as debt:\n    node scripts/debt-auto-capture.mjs --meta-decision X\nError [META_STOP]: the meta-review ended this audit' }; },
        spentUsd: () => spend,
      },
    });
    assert.equal(row.valid, true); assert.equal(row.stopRun, true); assert.equal(row.roundRan, false); assert.equal(row.stopKind, 'meta-stop');
    assert.equal(spawned.length, 1, 'one invocation; the debt command is NOT executed');
    assert.match(row.debtCommandRecorded, /debt-auto-capture/);
    assert.ok(Math.abs(row.costUsd - 0.9) < 1e-9);
  });

  test('classifyOutcome: every exit shape of both arms', () => {
    const code = { mode: 'code', trigger: 'T1' }; const plan = { mode: 'plan', trigger: 'T1' };
    const ok = { findings: [], verdict: 'NEEDS_FIXES', _canary: { status: 'detected' } };
    const c = (arm, point, inv, result = null) => classifyOutcome({ arm, point, inv, result });
    assert.equal(c('META', code, [{ status: 0, stderr: '' }], ok).valid, true);
    assert.equal(c('META', code, [{ status: 0, stderr: '' }], { ...ok, _canary: { status: 'missed' } }).invalidReason.startsWith('canary-missed'), true);
    assert.equal(c('META', plan, [{ status: 0, stderr: '' }], { findings: [], verdict: 'X' }).valid, true, 'plan audits have no canary');
    assert.equal(c('META', code, [{ status: 4, stderr: 'Error [META_STRUCTURAL]: x' }]).stopKind, 'meta-structural');
    assert.deepEqual(pick(c('META', code, [{ status: 4, stderr: 'Error [PAST_CAP_REQUIRED]: x' }])), { valid: true, stopRun: false, stopKind: 'default-refusal' });
    assert.equal(c('META', code, [{ status: 3, stderr: '' }]).invalidReason.startsWith('pass-lost'), true);
    assert.equal(c('CONTINUE', code, [{ status: 4, stderr: '' }, { status: 5, stderr: 'budget-stop' }]).invalidReason, 'budget-stop');
    assert.equal(c('CONTINUE', code, [{ status: 0, stderr: '' }, { status: 0, stderr: '' }], ok).invalidReason.startsWith('provider-error'), true, 'a card step that did not refuse is not the override path');
    assert.equal(c('CONTINUE', code, [{ status: 4, stderr: '' }, { status: 1, stderr: '' }]).valid, false);
    assert.equal(c('META', code, [{ status: 0, stderr: '' }], null).invalidReason, 'provider-error: no result file');
  });
});
const pick = (x) => ({ valid: x.valid, stopRun: x.stopRun, stopKind: x.stopKind });

describe('decideMetaPilot — every row of §2.3', () => {
  /** n pairs; `spec(i)` -> overrides for META and CONTINUE runs. */
  const mk = (n, spec) => Array.from({ length: n }, (_, i) => i).flatMap((i) => {
    const s = spec(i);
    return [
      { pointId: `p${Math.floor(i / 2)}`, rep: i % 2, arm: 'META', valid: true, stopRun: false, novelActionableHM: 0, novelActionable: 0, costUsd: 1, ...s.meta },
      { pointId: `p${Math.floor(i / 2)}`, rep: i % 2, arm: 'CONTINUE', valid: true, novelActionableHM: 0, novelActionable: 0, costUsd: 3, ...s.cont },
    ];
  });
  const stopsOf = (k) => (i) => (i < k ? { meta: { stopRun: true, costUsd: 1 }, cont: {} } : { meta: { novelActionable: 1, novelActionableHM: 1 }, cont: { novelActionable: 1, novelActionableHM: 1 } });
  const D = (runs) => decideMetaPilot({ runs });

  test('row 4 KEEP: 8 stops, 1 missed (12.5%), cost saved 67%, yield 1', () => {
    const runs = mk(32, (i) => (i < 8 ? { meta: { stopRun: true }, cont: i === 0 ? { novelActionableHM: 1, novelActionable: 1 } : {} } : { meta: { novelActionable: 1, novelActionableHM: 1 }, cont: { novelActionable: 1, novelActionableHM: 1 } }));
    const d = D(runs); assert.equal(d.outcome, 'keep'); assert.equal(d.branch, 4); assert.equal(d.figures.stops, 8); assert.equal(d.figures.missRate, 0.125);
  });
  test('row 2 OFF on miss rate: |S|=5 and 3 missed (60%)', () => {
    const runs = mk(32, (i) => (i < 5 ? { meta: { stopRun: true }, cont: i < 3 ? { novelActionableHM: 1, novelActionable: 1 } : {} } : {}));
    assert.equal(D(runs).branch, 2);
  });
  test('row 2 OFF on cost: META dearer than CONTINUE, even with too few stops (precedence over row 3)', () => {
    const runs = mk(32, (i) => (i < 2 ? { meta: { stopRun: true, costUsd: 9 }, cont: {} } : { meta: { costUsd: 9 }, cont: {} }));
    const d = D(runs); assert.equal(d.branch, 2); assert.match(d.why, /costs more/);
  });
  test('row 3 INCONCLUSIVE: |S|=4 even when everything else looks good', () => {
    const d = D(mk(32, stopsOf(4))); assert.equal(d.branch, 3);
  });
  test('row 5 INCONCLUSIVE: 6 stops with 2 missed (33%) sits between keep and off', () => {
    const runs = mk(32, (i) => (i < 6 ? { meta: { stopRun: true }, cont: i < 2 ? { novelActionableHM: 1, novelActionable: 1 } : {} } : {}));
    assert.equal(D(runs).branch, 5);
  });
  test('row 5 INCONCLUSIVE: keep thresholds missed on admission yield (0.5)', () => {
    const runs = mk(32, (i) => (i < 8 ? { meta: { stopRun: true }, cont: {} } : { meta: { novelActionable: i % 2, novelActionableHM: i % 2 }, cont: { novelActionable: 1, novelActionableHM: 1 } }));
    const d = D(runs); assert.equal(d.branch, 5); assert.ok(d.figures.admissionYield < 0.8);
  });
  test('a ZERO CONTINUE sum leaves yield undefined and its condition is skipped (keep stands)', () => {
    const runs = mk(32, (i) => (i < 8 ? { meta: { stopRun: true }, cont: {} } : { meta: {}, cont: {} }));
    const d = D(runs); assert.equal(d.figures.admissionYield, null); assert.equal(d.branch, 4);
  });
  test('row 1 INVALID: fewer than 24 valid pairs — never scored on the survivors, whatever they say', () => {
    const runs = mk(32, (i) => (i < 10 ? { meta: { valid: false, invalidReason: 'canary-missed' }, cont: {} } : stopsOf(8)(i)));
    const d = D(runs); assert.equal(d.branch, 1); assert.equal(d.figures.invalidPairs.length, 10);
  });
  test('row 1 INVALID: completion differs by > 10 points between arms even with 24+ valid pairs', () => {
    const runs = mk(32, (i) => (i < 7 ? { cont: {}, meta: { valid: false, invalidReason: 'pass-lost' } } : {}));
    // 25 valid pairs but META completed 78% vs CONTINUE 100%
    const d = D(runs); assert.equal(d.branch, 1); assert.ok(d.figures.completion.gapPoints > 10);
  });
  test('precedence: an invalid pilot beats off and keep', () => {
    const runs = mk(32, (i) => (i < 12 ? { meta: { valid: false }, cont: {} } : { meta: { stopRun: true, costUsd: 9 }, cont: {} }));
    assert.equal(D(runs).branch, 1);
  });
  test('both judges: a 1-1 split across branches is INCONCLUSIVE; agreement stands; a single judge is not enough', () => {
    const keep = mk(32, stopsOf(8)); const off = mk(32, (i) => (i < 8 ? { meta: { stopRun: true }, cont: { novelActionableHM: 1, novelActionable: 1 } } : {}));
    const split = decideMetaPilotBothJudges({ byJudge: { opus: keep, pro: off } });
    assert.equal(split.outcome, 'inconclusive'); assert.match(split.why, /disagree/);
    assert.equal(decideMetaPilotBothJudges({ byJudge: { opus: keep, pro: keep } }).outcome, 'keep');
    assert.equal(decideMetaPilotBothJudges({ byJudge: { opus: keep } }).outcome, 'inconclusive');
  });
  test('scoreMetaRuns: only labelled-REAL novel MEDIUM+ findings count; an unlabelled or UNDETERMINED one blocks the score', () => {
    const runs = [{ pointId: 'p', arm: 'CONTINUE', rep: 0, valid: true, costUsd: 1, findings: [{ key: 'a', severity: 'HIGH' }, { key: 'b', severity: 'MEDIUM' }, { key: 'c', severity: 'LOW' }, { key: 'd', severity: 'MEDIUM' }, { key: 'e', severity: 'MEDIUM' }] }];
    const novel = new Map([['a', true], ['b', true], ['c', true], ['d', false], ['e', true]]);
    const labels = new Map([['a', 'REAL'], ['b', 'RIGOUR_CHASING'], ['e', 'UNDETERMINED']]);
    const s = scoreMetaRuns({ runs, novelByFinding: novel, labels });
    assert.equal(s.rows[0].novelActionableHM, 1); assert.equal(s.rows[0].noise, 1);
    assert.equal(s.incomplete, true); assert.deepEqual(s.blocked.map((b) => b.key), ['e']);
  });
});
