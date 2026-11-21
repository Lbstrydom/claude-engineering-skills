import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EXPORT_SQL, exportRows, buildExportSnapshot, freezeFromExport, effectiveEvent, branchRuns } from '../scripts/lib/audit/step-back-export.mjs';
import { createRevisionFs, parseLsTree } from '../scripts/lib/audit/step-back-gitfs.mjs';
import { runReplay, renderDryRun } from '../scripts/lib/audit/step-back-replay.mjs';
import { buildStepBackPack } from '../scripts/lib/audit/step-back.mjs';

const at = (h, m = 0) => `2026-11-20T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
const SHA = (c) => c.repeat(40);

function fixture() {
  const runs = [
    { id: 'r1', branch: 'b1', audited_sha: SHA('1'), created_at: at(10), plan_file: 'plan.md' },
    { id: 'r2', branch: 'b1', audited_sha: SHA('2'), created_at: at(11), plan_file: 'plan.md' },
    { id: 'r3', branch: 'b1', audited_sha: SHA('3'), created_at: at(12), plan_file: 'plan.md' },
    { id: 'r4', branch: 'b1', audited_sha: SHA('4'), created_at: at(13), plan_file: 'plan.md' },
    { id: 'm1', branch: 'b2', audited_sha: SHA('5'), created_at: at(10), plan_file: 'plan.md' },
    { id: 'm2', branch: 'b2', audited_sha: SHA('6'), created_at: at(11), plan_file: 'plan.md' },
    { id: 'm3', branch: 'b2', audited_sha: null, created_at: at(12), plan_file: 'plan.md' },
    { id: 'c1', branch: 'ctl', audited_sha: SHA('7'), created_at: at(10), plan_file: 'plan.md' },
    { id: 'c2', branch: 'ctl', audited_sha: SHA('8'), created_at: at(11), plan_file: 'plan.md' },
  ];
  const f = (id, run_id, fp, severity = 'HIGH', file = 'src/a.mjs') => ({ id, run_id, finding_fingerprint: fp, severity, category: 'c', primary_file: file, detail_snapshot: `detail ${fp}`, round_raised: 1, created_at: at(10) });
  const findings = [f('F1', 'r1', 'fp-F1'), f('F2', 'r3', 'fp-F2'), f('F3', 'r1', 'fp-F3'), f('F4', 'r4', 'fp-LATE'), f('F5', 'r2', 'fp-F5'), f('G1', 'm1', 'fp-G1')];
  const ev = (id, finding_id, outcome, round, created_at, extra = {}) => ({ id, finding_id, adjudication_outcome: outcome, remediation_state: 'pending', ruling: null, round, created_at, superseded_at: null, overrides_event_id: null, ...extra });
  const events = [
    ev('E1', 'F1', 'accepted', 1, at(10, 30)), ev('E2', 'F1', 'dismissed', 2, at(11, 30)), ev('E3', 'F1', 'accepted', 4, at(13, 30)), // E3: round 4, after the cutoff
    ev('E4', 'F2', 'accepted', 3, at(13, 30)),                                                                                        // written after run 4 existed
    ev('E5', 'F3', 'accepted', 1, at(10, 40), { superseded_at: at(12, 30) }),                                                         // superseded before the cutoff
    ev('E7', 'F5', 'accepted', 2, at(11, 10)), ev('E6', 'F5', 'dismissed', 2, at(11, 20), { overrides_event_id: 'E7' }),              // E6 overrides E7
    ev('E8', 'G1', 'accepted', 1, at(10, 30)),
  ];
  return { version: 1, since: '2026-11-19', branches: ['b1', 'b2', 'ctl'], runs, findings, events };
}

test('ordinal rounds; no look-ahead: an event after the cutoff or from a later round is ignored', () => {
  const exp = fixture();
  assert.deepEqual(branchRuns(exp, 'b1').map((r) => r.id), ['r1', 'r2', 'r3', 'r4']);
  const s = buildExportSnapshot({ exp, branch: 'b1', checkpoint: 3 });
  assert.equal(s.ok, true);
  const byId = Object.fromEntries(s.snapshot.ledgerEntries.map((e) => [e.findingId, e]));
  assert.equal(byId.F1.adjudicationOutcome, 'dismissed', 'E3 (round 4, after cutoff) is ignored');
  assert.equal(byId.F2, undefined, 'E4 was written after run 4 existed');
  assert.deepEqual(s.snapshot.rounds.map((r) => r.round), [1, 2, 3]);
  assert.equal(JSON.stringify(s.snapshot).includes('fp-LATE'), false, 'a finding first raised after the checkpoint is absent');
  assert.equal(s.snapshot.auditedSha, SHA('3'));
});

test('superseded and overridden events are not effective as of the cutoff', () => {
  const exp = fixture();
  const byId = Object.fromEntries(buildExportSnapshot({ exp, branch: 'b1', checkpoint: 3 }).snapshot.ledgerEntries.map((e) => [e.findingId, e]));
  assert.equal(byId.F3, undefined, 'E5 superseded at 12:30, before the 13:00 cutoff');
  assert.equal(byId.F5.adjudicationOutcome, 'dismissed', 'E6 overrides E7');
  const evs = [{ id: 'X', round: 1, created_at: at(10), adjudication_outcome: 'accepted', superseded_at: at(14), overrides_event_id: null }];
  assert.equal(effectiveEvent(evs, { cutoffMs: Date.parse(at(13)) }).id, 'X', 'superseded only AFTER the cutoff still counts as of the cutoff');
  assert.equal(effectiveEvent(evs, { cutoffMs: Date.parse(at(15)) }), null);
});

test('missing audited_sha is unrecoverable; fewer than 3 rounds is a control; truth is final-event based and kept apart', () => {
  const exp = fixture();
  const m = buildExportSnapshot({ exp, branch: 'b2', checkpoint: 3 });
  assert.deepEqual([m.ok, m.status], [false, 'unrecoverable']);
  assert.match(m.reason, /no audited_sha/);
  const { dataset, scoring } = freezeFromExport({ exp, exportPath: 'x.json', spec: { prs: [
    { pr: 1, label: 'bad', branch: 'b1' }, { pr: 2, label: 'bad', branch: 'b2' }, { pr: 3, label: 'converged', branch: 'ctl' }, { pr: 4, label: 'bad', branch: 'nope' }] } });
  const by = Object.fromEntries(dataset.prs.map((p) => [p.pr, p]));
  assert.deepEqual(by[1].checkpoints.map((c) => [c.checkpoint, c.status]), [[3, 'recoverable']]);
  assert.equal(by[2].checkpoints[0].status, 'unrecoverable');
  assert.equal(by[3].control, true);
  assert.deepEqual(by[3].checkpoints, []);
  assert.equal(by[4].status, 'unrecoverable');
  // F1's FINAL event is E3 (accepted, round-1 finding); F2's is E4 (round 3); F3 superseded; F5 dismissed.
  assert.deepEqual(scoring.truth[1].acceptedHighRounds, [1, 3]);
  assert.equal(JSON.stringify(dataset).includes('acceptedHighRounds'), false);
});

test('export is read-only: every statement is a SELECT with no write keyword', async () => {
  for (const sql of Object.values(EXPORT_SQL)) {
    assert.match(sql, /^SELECT /);
    assert.equal(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT)\b/i.test(sql), false);
  }
  const seen = [];
  const exp = fixture();
  const query = async (sql) => { seen.push(sql); return { rows: sql === EXPORT_SQL.runs ? exp.runs : sql === EXPORT_SQL.findings ? exp.findings : exp.events }; };
  const out = await exportRows({ branches: ['b1'], since: '2026-11-19', query });
  assert.deepEqual(seen, [EXPORT_SQL.runs, EXPORT_SQL.findings, EXPORT_SQL.events]);
  assert.equal(out.runs.length, exp.runs.length);
});

function fakeGit(files, { badSha = false } = {}) {
  const tree = `${files.map((f) => `${f.mode || '100644'} blob ${f.oid}\t${f.path}`).join('\0')}\0`;
  return {
    git: (args) => {
      if (args[0] === 'ls-tree') return badSha ? { status: 128, stdout: '' } : { status: 0, stdout: tree };
      if (args[0] === 'show') { const f = files.find((x) => `${SHA('3')}:${x.path}` === args[1]); return f ? { status: 0, stdout: f.body } : { status: 128, stdout: '' }; }
      return { status: 1, stdout: '' };
    },
    readBatch: (oids) => new Map(files.filter((f) => oids.includes(f.oid)).map((f) => [f.oid, f.body])),
  };
}
const FILES = [
  { path: 'src/a.mjs', oid: 'o1', body: "import './b.mjs';\nexport const a = 'AT-REVISION';\n" },
  { path: 'src/b.mjs', oid: 'o2', body: 'export const b = 2;\n' },
  { path: 'src/c.mjs', oid: 'o3', body: "import './a.mjs';\nexport const c = 3;\n" },
  { path: 'src/link.mjs', oid: 'o4', mode: '120000', body: 'a.mjs' },
  { path: '.env', oid: 'o5', body: 'ENVSENTINEL=1' },
  { path: 'plan.md', oid: 'o6', body: '# plan at revision\n' },
];

test('gitfs: content at the revision; symlink entries, missing and sensitive paths excluded and counted; bad sha refused', async () => {
  const g = fakeGit(FILES);
  const rev = createRevisionFs({ sha: SHA('3'), git: g.git, readBatch: g.readBatch });
  assert.equal(rev.ok, true);
  assert.deepEqual(parseLsTree('100644 blob abc\tsrc/x y.mjs\0')[0], { mode: '100644', oid: 'abc', path: 'src/x y.mjs' });
  const mk = (id, file) => ({ id, severity: 'HIGH', category: 'c', section: file, detail: 'd', _primaryFile: file, affectedFiles: [file] });
  const pack = await buildStepBackPack({
    repoRoot: rev.root, fsImpl: rev.fs, planFile: 'plan.md', ledgerEntries: [], repoFiles: rev.repoFiles, topicOf: (f) => f.id,
    rounds: [{ round: 1, auditedSha: SHA('3'), findings: [mk('1', 'src/a.mjs'), mk('2', 'src/link.mjs'), mk('3', 'src/gone.mjs'), mk('4', '.env')] }],
  });
  assert.ok(pack.text.includes('AT-REVISION'), 'content comes from the revision');
  assert.ok(pack.text.includes('plan at revision'));
  assert.ok(pack.text.includes('export const b = 2;') && pack.text.includes('export const c = 3;'), 'one-hop import and importer');
  assert.equal(pack.text.includes('ENVSENTINEL'), false);
  assert.deepEqual(pack.skipped.map((s) => s.path).sort(), ['src/gone.mjs', 'src/link.mjs']);
  assert.equal(pack.excluded.sensitive + pack.excluded.unreadable, 2);
  assert.equal(path.isAbsolute(rev.root), true);
  assert.equal(createRevisionFs({ sha: SHA('3'), git: fakeGit(FILES, { badSha: true }).git, readBatch: () => new Map() }).ok, false);
  assert.equal(createRevisionFs({ sha: 'not-a-sha' }).ok, false);
});

test('dry-run over a synthetic export: planned calls and estimate; controls and unrecoverable listed; no provider call', async () => {
  const exp = fixture();
  const { dataset } = freezeFromExport({ exp, exportPath: 'x.json', spec: { prs: [
    { pr: 1, label: 'bad', branch: 'b1' }, { pr: 2, label: 'bad', branch: 'b2' }, { pr: 3, label: 'converged', branch: 'ctl' }] } });
  const g = fakeGit(FILES);
  let calls = 0;
  const res = await runReplay({ dataset, arms: ['none', 'same', 'different'], dryRun: true, deps: {
    readExport: () => exp, openRevision: ({ sha }) => createRevisionFs({ sha, git: g.git, readBatch: g.readBatch }),
    makeProvider: (arm) => ({ model: arm === 'same' ? 'gpt-5.5' : 'gemini-3.1-pro-preview', call: async () => { calls++; return { text: '' }; } }),
  } });
  assert.equal(calls, 0);
  assert.equal(res.plan.length, 2, 'PR 1 R3 x two paid arms');
  assert.deepEqual(res.controls.map((c) => c.pr), [3]);
  assert.deepEqual(res.unrecoverable.map((u) => [u.pr, u.checkpoint]), [[2, 3]]);
  const text = renderDryRun({ ...res, maxUsd: 20 });
  assert.match(text, /planned calls: 2 \(1 PR-checkpoints\), estimated total \$\d+\.\d\d against a hard stop of \$20\.00/);
  assert.match(text, /controls \(no checkpoint, no call\): #3 \(2 rounds\)/);
  assert.match(text, /unrecoverable.*#2 R3 \(run 3 has no audited_sha\)/);
});
