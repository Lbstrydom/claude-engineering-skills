import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { checkpointFor, buildCheckpointSection, renderPostSixDefault, STEP_BACK_CHECKPOINTS } from '../scripts/lib/audit/step-back-card.mjs';
import { createStepBackProvider, STEP_BACK_ARM_MODELS } from '../scripts/lib/audit/step-back-provider.mjs';

const S = (c) => c.repeat(40);
const DIFF = ['--- a/a.mjs', '+++ b/a.mjs', '@@ -1 +1,3 @@', '-o', '+n1', '+n2', '+n3'].join('\n');
const git = (args) => (args.includes('diff') ? { status: 0, stdout: DIFF } : { status: 0, stdout: '' });
const f = (id, line) => ({ id, severity: 'HIGH', _primaryFile: 'a.mjs', affectedFiles: ['a.mjs'], line });
const rounds = [
  { round: 1, auditedSha: S('1'), findings: [f('A', 1)] },
  { round: 2, auditedSha: S('2'), findings: [f('B', 1)] },
  { round: 3, auditedSha: S('3'), findings: [f('C', 2)] }, // line 2 is inside the +1,3 hunk -> reopen 1/1
];
const base = { sid: 's', mode: 'code', auditDir: '.', deps: { readRounds: () => ({ rounds, unmeasured: null }), readLedger: () => ({ entries: null, unmeasured: 'no ledger' }), git, repoFiles: () => ['a.mjs'], archNeighbours: null,
  buildPack: async () => ({ text: 'PACK', skipLog: [], files: [] }) } };

test('checkpointFor: code rounds 3 and 6 only (card requested for 4 / 7); plan audits never', () => {
  assert.deepEqual(STEP_BACK_CHECKPOINTS.code, [3, 6]);
  assert.equal(checkpointFor({ mode: 'code', round: 4 }), 3);
  assert.equal(checkpointFor({ mode: 'code', round: 7 }), 6);
  assert.equal(checkpointFor({ mode: 'code', round: 5 }), null);
  assert.equal(checkpointFor({ mode: 'plan', round: 4 }), null);
});

test('section at round 3: prints signals, fires on reopen, never calls a provider without --step-back', async () => {
  let called = 0;
  const s = await buildCheckpointSection({ ...base, round: 4, provider: async () => { called++; return { text: '' }; } });
  assert.equal(s.checkpoint, 3); assert.equal(s.record.state, 'signals-fired'); assert.equal(called, 0);
  assert.match(s.lines.join('\n'), /reopenRate: 1  FIRES/);
  assert.match(s.lines.join('\n'), /--step-back/);
  assert.match(s.lines.join('\n'), /UNMEASURED/, 'retired is unmeasured without a ledger and says so');
});

test('--step-back with a fake provider: valid defect names a focus note but the human decides; invalid output admits none', async () => {
  const ok = await buildCheckpointSection({ ...base, round: 4, stepBack: true, model: 'm', provider: async ({ user }) => ({ text: JSON.stringify({ action: 'defect', topicId: 't', evidenceNeeded: user }), usage: { input_tokens: 1, output_tokens: 1 } }) });
  assert.equal(ok.record.state, 'step-back-valid'); assert.equal(ok.record.next.roundAdmitted, false);
  const bad = await buildCheckpointSection({ ...base, round: 4, stepBack: true, provider: async () => ({ text: '{"action":"continue"}' }) });
  assert.equal(bad.record.state, 'step-back-invalid'); assert.equal(bad.record.next.roundAdmitted, false);
  const none = await buildCheckpointSection({ ...base, round: 4, stepBack: true, provider: null });
  assert.equal(none.record.state, 'step-back-unavailable');
});

test('--step-back with quiet signals does not invoke the reviewer', async () => {
  const quietRounds = rounds.map((r) => ({ ...r, findings: [] }));
  let called = 0;
  const s = await buildCheckpointSection({ ...base, deps: { ...base.deps, readRounds: () => ({ rounds: quietRounds }) }, round: 4, stepBack: true, provider: async () => { called++; return { text: '' }; } });
  assert.equal(called, 0); assert.match(s.lines.join('\n'), /not run/);
});

test('after round 6: the default is stop-to-debt or a human; --past-cap for 7-8; caps unchanged', async () => {
  assert.match(renderPostSixDefault({ mode: 'code', round: 7 }), /STOP-TO-DEBT or a human.*--past-cap/s);
  assert.equal(renderPostSixDefault({ mode: 'code', round: 6 }), null);
  assert.equal(renderPostSixDefault({ mode: 'plan', round: 7 }), null);
  const s = await buildCheckpointSection({ ...base, round: 7 });
  assert.equal(s.checkpoint, 6);
  assert.match(s.lines.join('\n'), /rounds 7-8 only with --past-cap/);
  const { AUDIT_ROUND_CAPS } = await import('../scripts/lib/audit/round-cap.mjs');
  assert.deepEqual([AUDIT_ROUND_CAPS.code.soft, AUDIT_ROUND_CAPS.code.absolute], [6, 8]);
});

test('missing round result for the checkpoint is unmeasured, never quiet', async () => {
  const s = await buildCheckpointSection({ ...base, deps: { ...base.deps, readRounds: () => ({ rounds: null, unmeasured: 'no results' }) }, round: 4 });
  assert.equal(s.signals, null); assert.match(s.lines[0], /UNMEASURED.*unmeasured/s);
});

test('default providers use sentinels and an injected client (never a live call here)', async () => {
  assert.deepEqual(STEP_BACK_ARM_MODELS, { same: 'latest-gpt', different: 'latest-pro', higher: 'latest-opus' });
  let seen;
  const p = createStepBackProvider('same', { resolve: (m) => `resolved:${m}`, client: { responses: { create: async (a) => { seen = a; return { output_text: 'x', usage: { input_tokens: 3, output_tokens: 2 } }; } } } });
  assert.equal(p.model, 'resolved:latest-gpt');
  const r = await p.call({ system: 's', user: 'u' });
  assert.equal(seen.model, 'resolved:latest-gpt'); assert.equal(r.usage.input_tokens, 3);
  assert.throws(() => createStepBackProvider('nope'));
});

test('CLI: --selfcheck-relocation and an unknown --step-back-arm', () => {
  const run = (...a) => spawnSync(process.execPath, ['scripts/audit-structural-card.mjs', ...a], { encoding: 'utf8', env: { ...process.env, AUDIT_DB_URL: '' } });
  assert.equal(run('--selfcheck-relocation').stdout.trim(), 'OK');
  const bad = run('--sid', 'x', '--mode', 'code', '--round', '4', '--no-write', '--step-back-arm', 'bogus');
  assert.equal(bad.status, 2);
});

test('R3-M6: the suggested --step-back command carries the current --dir and --plan', async () => {
  const s = await buildCheckpointSection({ ...base, round: 4, auditDir: '/tmp/my audit', planFile: 'docs/plans/x.md' });
  const line = s.lines.find((l) => l.startsWith('A signal fired'));
  assert.match(line, /--dir "\/tmp\/my audit" --plan "docs\/plans\/x\.md" --step-back/);
});
