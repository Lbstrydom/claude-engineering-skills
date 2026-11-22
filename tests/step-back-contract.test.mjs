import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  StepBackSchema, parseStepBackOutput, buildStepBackPack, initialStepBackRecord, applyStepBackOutcome,
  approveStop, stopDebtIntents, runStepBack, STEP_BACK_STATES,
} from '../scripts/lib/audit/step-back.mjs';
import { buildCheckpointSnapshot } from '../scripts/lib/audit/step-back-snapshot.mjs';

// ── (a) schema ───────────────────────────────────────────────────────────────
test('schema: accepts exactly the three actions; continue and empty files are rejected', () => {
  assert.ok(StepBackSchema.safeParse({ action: 'structural', files: ['a.mjs'] }).success);
  assert.ok(StepBackSchema.safeParse({ action: 'stop', items: [{ topicId: 't1', premise: 'p' }] }).success);
  assert.ok(StepBackSchema.safeParse({ action: 'defect', topicId: 't1', evidenceNeeded: 'a repro' }).success);
  assert.equal(StepBackSchema.safeParse({ action: 'continue' }).success, false);
  assert.equal(StepBackSchema.safeParse({ action: 'structural', files: [] }).success, false);
  assert.equal(StepBackSchema.safeParse({ action: 'stop', items: [] }).success, false);
  assert.equal(StepBackSchema.safeParse({ action: 'defect', topicId: 't1' }).success, false);
  assert.equal(StepBackSchema.safeParse({ action: 'structural', files: ['a'], extra: 1 }).success, false, 'strict: no stray keys');
});

test('schema: emitted JSON schema is a oneOf/anyOf of exactly three variants and has no continue', () => {
  const js = z.toJSONSchema(StepBackSchema);
  const variants = js.oneOf || js.anyOf;
  assert.equal(variants.length, 3);
  const actions = variants.map((v) => v.properties.action.const).sort();
  assert.deepEqual(actions, ['defect', 'stop', 'structural']);
  assert.equal(JSON.stringify(js).includes('continue'), false);
  const structural = variants.find((v) => v.properties.action.const === 'structural');
  assert.equal(structural.properties.files.minItems, 1);
  assert.deepEqual([...structural.required].sort(), ['action', 'files']);
});

test('parseStepBackOutput: fenced JSON ok; prose and continue are invalid', () => {
  assert.equal(parseStepBackOutput('```json\n{"action":"defect","topicId":"t","evidenceNeeded":"x"}\n```').ok, true);
  assert.equal(parseStepBackOutput('I would continue.').ok, false);
  assert.equal(parseStepBackOutput('{"action":"continue"}').ok, false);
});

// ── (b) pack egress — TIER 3: each planted leak absent from the pack ─────────
const GH_SECRET = `ghp_${'0123456789abcdefghijABCDEFGHIJ012345'}`;

function plant() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pack-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-home-'));
  const w = (rel, body, base = root) => { const p = path.join(base, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p; };
  w('src/a.mjs', `import './b.mjs';\nexport const TOKEN = '${GH_SECRET}';\nexport const a = 1;\n`);
  w('src/b.mjs', 'export const b = 2;\n');
  w('src/c.mjs', "import { a } from './a.mjs';\nexport const c = a;\n");
  w('.env', 'DB_SECRET=ENVSENTINEL-9f3a\n');
  w('secrets/leak.mjs', "import '../src/a.mjs';\nexport const L = 'SECRETSDIRSENTINEL';\n");
  w('.ssh/id_rsa', 'SSHSENTINEL-in-home', home);
  w('plan.md', '# Plan\nDo the thing.\n');
  let symlinks = 'real';
  try {
    fs.symlinkSync(path.join(home, '.ssh', 'id_rsa'), path.join(root, 'src', 'notes.txt'));      // escapes the repo into ~/.ssh
    fs.symlinkSync(path.join(root, '.env'), path.join(root, 'src', 'innocent.mjs'));              // stays in repo, resolves to .env
  } catch { symlinks = 'unavailable'; }
  const repoFiles = ['src/a.mjs', 'src/b.mjs', 'src/c.mjs', '.env', 'secrets/leak.mjs', 'src/notes.txt', 'src/innocent.mjs', 'plan.md'];
  const finding = (id, file) => ({ id, severity: 'HIGH', category: 'x', section: file, detail: 'd', _primaryFile: file, affectedFiles: [file] });
  const rounds = [{ round: 1, auditedSha: 'a'.repeat(40), findings: [finding('H1', 'src/a.mjs'), finding('H2', '.env'), finding('H3', 'src/notes.txt'), finding('H4', 'src/innocent.mjs')] }];
  return { root, home, repoFiles, rounds, symlinks };
}

test('pack egress: planted .env, symlinks into sensitive paths, and a secret-shaped string are all absent', async () => {
  const { root, repoFiles, rounds, symlinks } = plant();
  const pack = await buildStepBackPack({ repoRoot: root, planFile: 'plan.md', ledgerEntries: [], rounds, repoFiles, topicOf: (f) => `topic-${f.id}` });
  for (const needle of ['ENVSENTINEL', 'SSHSENTINEL', 'SECRETSDIRSENTINEL', GH_SECRET, 'ghp_0123456789']) {
    assert.equal(pack.text.includes(needle), false, `pack must not contain ${needle}`);
  }
  assert.match(pack.text, /\[REDACTED/, 'the secret-shaped string is redacted, not dropped silently');
  // The legitimate content is present, proving the pack is not simply empty.
  assert.ok(pack.text.includes('export const b = 2;'), 'one-hop import included');
  assert.ok(pack.text.includes('export const c = a;'), 'one-hop importer included');
  assert.ok(pack.files.some((f) => f.path === 'src/a.mjs' && f.role === 'cited'));
  assert.ok(pack.text.includes('Do the thing.'));
  // Excluded files are COUNTED and the skip log carries no raw sensitive paths.
  assert.ok(pack.excluded.sensitive >= 1);
  assert.ok(pack.skipLog.length > 0);
  assert.equal(pack.skipLog.join('\n').includes('.env'), false, 'skip log aggregates, never names the sensitive path');
  if (symlinks === 'real') assert.ok(pack.excluded.sensitive >= 3, '.env + two symlinks counted');
  assert.equal(pack.files.some((f) => ['.env', 'src/notes.txt', 'src/innocent.mjs', 'secrets/leak.mjs'].includes(f.path)), false);
});

test('pack egress: a symlink that escapes into ~/.ssh is excluded even when resolved by an injected fs (no symlink privilege needed)', async () => {
  const { root, home, repoFiles, rounds } = plant();
  const real = fs;
  const target = path.join(home, '.ssh', 'id_rsa');
  const fakeFs = Object.create(real);
  fakeFs.realpathSync = (p) => (p.endsWith(path.join('src', 'notes.txt')) ? target : real.realpathSync(p));
  const original = real.readFileSync;
  fakeFs.readFileSync = (p, ...rest) => (p.endsWith(path.join('src', 'notes.txt')) ? original(target, ...rest) : original(p, ...rest));
  const pack = await buildStepBackPack({ repoRoot: root, planFile: 'plan.md', ledgerEntries: [], rounds, repoFiles, fsImpl: fakeFs, topicOf: (f) => f.id });
  assert.equal(pack.text.includes('SSHSENTINEL'), false);
  assert.ok(pack.skipped.some((s) => s.path === 'src/notes.txt' && s.pattern === 'escaped-repo'));
});

test('pack egress: a classification error fails closed (file excluded, counted)', async () => {
  const { root, repoFiles, rounds } = plant();
  const boom = Object.create(fs);
  boom.realpathSync = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
  const pack = await buildStepBackPack({ repoRoot: root, planFile: null, ledgerEntries: [], rounds, repoFiles, fsImpl: boom, topicOf: (f) => f.id });
  assert.equal(pack.files.length, 0);
  assert.ok(pack.excluded.sensitive + pack.excluded.unreadable > 0);
  assert.equal(pack.text.includes(GH_SECRET), false);
});

test('pack: ledger, rounds and arch neighbours are redacted too; the arch seam only sees gate-passed files; it is deterministic', async () => {
  const { root, repoFiles, rounds } = plant();
  rounds[0].findings[0].detail = `leaked ${GH_SECRET} in prose`;
  let seen = null;
  const arch = async ({ files }) => { seen = files; return [{ symbol: 'x', purposeSummary: `has ${GH_SECRET}` }]; };
  const args = { repoRoot: root, planFile: 'plan.md', ledgerEntries: [{ topicId: 't', detailSnapshot: GH_SECRET }], rounds, repoFiles, archNeighbours: arch, topicOf: (f) => f.id };
  const a = await buildStepBackPack(args);
  const b = await buildStepBackPack(args);
  assert.equal(a.text, b.text, 'same inputs, byte-identical pack');
  assert.equal(a.text.includes(GH_SECRET), false);
  assert.deepEqual(seen, ['src/a.mjs']);
  assert.ok(a.text.includes('<arch-neighbours>'));
});

// ── (c) snapshot: no look-ahead ──────────────────────────────────────────────
function auditDirWith({ checkpoint = 3, lateEntry = false, missingLedger = false, metaSha = null, missingSha = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-audit-'));
  const sid = 'audit-code-test-1';
  for (let n = 1; n <= 5; n++) {
    fs.writeFileSync(path.join(dir, `${sid}-r${n}-result.json`), JSON.stringify({
      round: n, _auditedSha: missingSha && n === checkpoint ? null : String(n).repeat(40).slice(0, 40).replace(/[^0-9a-f]/g, 'a'),
      verdict: 'SIGNIFICANT_ISSUES', findings: [{ id: `H${n}`, severity: 'HIGH', _hash: `hash-round-${n}`, _primaryFile: 'src/a.mjs', affectedFiles: ['src/a.mjs'] }],
    }));
  }
  if (!missingLedger) {
    const entries = [1, 2, 3].map((n) => ({ topicId: `topic-${n}`, firstSeenRound: n, lastSeenRound: n, round: n, adjudicationOutcome: 'accepted' }));
    if (lateEntry) entries.push({ topicId: 'topic-LATE', firstSeenRound: 4, lastSeenRound: 4, round: 4 });
    fs.writeFileSync(path.join(dir, `${sid}-r${checkpoint}-ledger.json`), JSON.stringify({ version: 1, meta: metaSha ? { round: checkpoint, auditedSha: metaSha } : {}, entries }));
  }
  // The FINAL ledger holds topics raised later; the builder must never open it.
  fs.writeFileSync(path.join(dir, `${sid}-ledger.json`), JSON.stringify({ entries: [{ topicId: 'topic-FINAL-ONLY', firstSeenRound: 5 }] }));
  return { dir, sid };
}

test('snapshot: built from round results <= checkpoint and the per-round ledger; no pack carries a later topic', async () => {
  const { dir, sid } = auditDirWith();
  const snap = buildCheckpointSnapshot({ sid, checkpoint: 3, auditDir: dir });
  assert.equal(snap.ok, true);
  assert.deepEqual(snap.snapshot.rounds.map((r) => r.round), [1, 2, 3]);
  assert.equal(snap.snapshot.paths.some((p) => /-ledger\.json$/.test(p) && !/-r3-ledger\.json$/.test(p)), false, 'final ledger never read');
  const { root, repoFiles } = plant();
  const pack = await buildStepBackPack({
    repoRoot: root, planFile: null, ledgerEntries: snap.snapshot.ledgerEntries, rounds: snap.snapshot.rounds, repoFiles,
    topicOf: (f) => `topic-${f.id.slice(1)}`,
  });
  for (const later of ['topic-LATE', 'topic-FINAL-ONLY', 'hash-round-4', 'topic-4', 'topic-5']) assert.equal(pack.text.includes(later), false, later);
  assert.ok(pack.text.includes('topic-3'));
});

test('snapshot: missing ledger snapshot, missing audited_sha, look-ahead entry and a disagreeing sha are each unrecoverable', () => {
  const am = auditDirWith({ missingLedger: true });
  const a = buildCheckpointSnapshot({ sid: am.sid, checkpoint: 3, auditDir: am.dir });
  assert.equal(a.ok, false); assert.equal(a.status, 'unrecoverable'); assert.match(a.reason, /per-round ledger snapshot/);
  const b = auditDirWith({ missingSha: true });
  assert.match(buildCheckpointSnapshot({ sid: b.sid, checkpoint: 3, auditDir: b.dir }).reason, /no audited_sha/);
  const c = auditDirWith({ lateEntry: true });
  assert.match(buildCheckpointSnapshot({ sid: c.sid, checkpoint: 3, auditDir: c.dir }).reason, /look-ahead/);
  const d = auditDirWith({ metaSha: 'f'.repeat(40) });
  assert.match(buildCheckpointSnapshot({ sid: d.sid, checkpoint: 3, auditDir: d.dir }).reason, /disagrees/);
  const e = auditDirWith();
  const ok = buildCheckpointSnapshot({ sid: e.sid, checkpoint: 3, auditDir: e.dir });
  assert.equal(ok.snapshot.provenance, 'file-name+entry-rounds');
});

// ── (d) state machine ────────────────────────────────────────────────────────
const sig = (anyFires, unmeasured = []) => ({ anyFires, unmeasured });

test('state machine: quiet admits a round, fired does not; unmeasured is never presented as a clean quiet', () => {
  const quiet = initialStepBackRecord({ round: 3, signals: sig(false) });
  assert.deepEqual([quiet.state, quiet.next.roundAdmitted, quiet.triggerMeasured], ['signals-quiet', true, true]);
  const blind = initialStepBackRecord({ round: 3, signals: sig(false, ['retired']) });
  assert.deepEqual([blind.state, blind.triggerMeasured, blind.unmeasured], ['signals-quiet', false, ['retired']]);
  const fired = initialStepBackRecord({ round: 3, signals: sig(true) });
  assert.deepEqual([fired.state, fired.next.roundAdmitted], ['signals-fired', false]);
  assert.ok(STEP_BACK_STATES.includes(fired.state));
});

test('state machine: structural/stop/defect transitions; invalid and unavailable admit no round; stop writes no debt without approval', () => {
  const fired = initialStepBackRecord({ round: 6, signals: sig(true) });
  const structural = applyStepBackOutcome(fired, { kind: 'valid', output: { action: 'structural', files: ['a.mjs'] } });
  assert.deepEqual([structural.state, structural.next.roundAdmitted], ['step-back-valid', false]);
  const defect = applyStepBackOutcome(fired, { kind: 'valid', output: { action: 'defect', topicId: 't', evidenceNeeded: 'e' } });
  assert.equal(defect.next.roundAdmitted, false, 'a valid defect never admits the next round by itself'); assert.deepEqual(defect.next.focusNote, { topicId: 't', evidenceNeeded: 'e' });
  const stop = applyStepBackOutcome(fired, { kind: 'valid', output: { action: 'stop', items: [{ topicId: 't1', premise: 'p' }] } });
  assert.equal(stop.debtWritten, false); assert.equal(stop.next.debtWrite, 'pending-human-approval');
  assert.deepEqual(stopDebtIntents(stop), [], 'a stop never writes debt by itself');
  const approved = approveStop(stop, { by: 'Louis' });
  assert.equal(stopDebtIntents(approved).length, 1);
  assert.throws(() => approveStop(structural, { by: 'Louis' }));
  const inv = applyStepBackOutcome(fired, { kind: 'invalid', raw: 'continue', error: 'bad' });
  const una = applyStepBackOutcome(fired, { kind: 'unavailable', reason: 'timeout' });
  for (const r of [inv, una]) assert.equal(r.next.roundAdmitted, false);
  assert.equal(inv.raw, 'continue');
  assert.throws(() => applyStepBackOutcome(initialStepBackRecord({ round: 3, signals: sig(false) }), { kind: 'unavailable', reason: 'x' }));
});

test('runStepBack: fake provider valid / invalid / throwing / absent', async () => {
  const fired = initialStepBackRecord({ round: 3, signals: sig(true) });
  const pack = { text: 'PACK' };
  let seen;
  const ok = await runStepBack({ record: fired, pack, provider: async (a) => { seen = a; return { text: '{"action":"defect","topicId":"t","evidenceNeeded":"e"}', usage: { input_tokens: 10, output_tokens: 5 } }; }, model: 'm' });
  assert.equal(ok.record.state, 'step-back-valid'); assert.equal(seen.user, 'PACK'); assert.equal(seen.model, 'm'); assert.equal(ok.usage.input_tokens, 10);
  assert.equal((await runStepBack({ record: fired, pack, provider: async () => ({ text: '{"action":"continue"}' }) })).record.state, 'step-back-invalid');
  assert.equal((await runStepBack({ record: fired, pack, provider: async () => { throw new Error('429'); } })).record.state, 'step-back-unavailable');
  assert.equal((await runStepBack({ record: fired, pack, provider: null })).record.state, 'step-back-unavailable');
});
