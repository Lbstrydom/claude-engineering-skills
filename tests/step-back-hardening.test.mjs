import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildStepBackPack, initialStepBackRecord, runStepBack, parseStepBackOutput, STEP_BACK_SYSTEM_PROMPT, TRUNCATION_ORDER } from '../scripts/lib/audit/step-back.mjs';
import { createRevisionFs, gitBatchReader } from '../scripts/lib/audit/step-back-gitfs.mjs';

const rec = () => initialStepBackRecord({ round: 3, signals: { anyFires: true, unmeasured: [] } });

test('H12/H17: a topicId the checkpoint does not know makes the output invalid; known ones pass', async () => {
  assert.equal(parseStepBackOutput('{"action":"defect","topicId":"ghost","evidenceNeeded":"e"}', { knownTopics: ['t1'] }).ok, false);
  assert.match(parseStepBackOutput('{"action":"stop","items":[{"topicId":"t1","premise":"p"},{"topicId":"ghost","premise":"p"}]}', { knownTopics: ['t1'] }).error, /ghost/);
  assert.equal(parseStepBackOutput('{"action":"defect","topicId":"t1","evidenceNeeded":"e"}', { knownTopics: ['t1'] }).ok, true);
  assert.equal(parseStepBackOutput('{"action":"structural","files":["a.mjs"]}', { knownTopics: [] }).ok, true, 'structural names files, not topics');
  const out = await runStepBack({ record: rec(), pack: { text: 'P', topics: ['t1'] }, provider: async () => ({ text: '{"action":"defect","topicId":"ghost","evidenceNeeded":"e"}' }) });
  assert.equal(out.record.state, 'step-back-invalid');
  assert.equal(out.record.next.roundAdmitted, false);
});

test('M7/H19: the prompt does not push an uncertain reviewer toward defect', () => {
  assert.equal(/pick defect/i.test(STEP_BACK_SYSTEM_PROMPT), false);
  assert.match(STEP_BACK_SYSTEM_PROMPT, /rejected as invalid/);
});

function bigRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cap-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'plan.md'), `# plan\n${'plan text '.repeat(2000)}`);
  fs.writeFileSync(path.join(root, 'src', 'a.mjs'), `import './b.mjs';\n${'// cited body\n'.repeat(3000)}`);
  fs.writeFileSync(path.join(root, 'src', 'b.mjs'), `export const b = 1;\n${'// import body\n'.repeat(3000)}`);
  fs.writeFileSync(path.join(root, 'src', 'c.mjs'), `import './a.mjs';\n${'// importer body\n'.repeat(3000)}`);
  const f = { id: 'H1', severity: 'HIGH', category: 'c', section: 'src/a.mjs', detail: 'x'.repeat(3000), _primaryFile: 'src/a.mjs', affectedFiles: ['src/a.mjs'] };
  return { root, args: { repoRoot: root, planFile: 'plan.md', ledgerEntries: [{ topicId: 't', detailSnapshot: 'y'.repeat(5000) }], rounds: [{ round: 1, findings: [f] }], repoFiles: ['plan.md', 'src/a.mjs', 'src/b.mjs', 'src/c.mjs'], topicOf: () => 'tH1' } };
}

test('M1/M8: totalChars bounds the WHOLE pack (markup included); sections shrink in the declared order and it is reported', async () => {
  const { args } = bigRepo();
  const full = await buildStepBackPack(args);
  assert.ok(full.text.length > 60_000);
  const limit = 40_000;
  const capped = await buildStepBackPack({ ...args, limits: { perFileChars: 60_000, totalChars: limit, maxImporterScan: 5000, maxArchNeighbours: 8 } });
  assert.ok(capped.text.length <= limit, `pack ${capped.text.length} > ${limit}`);
  assert.ok(capped.truncations.length > 0 && capped.notes.some((n) => /over 40000/.test(n)));
  const order = capped.truncations.map((t) => TRUNCATION_ORDER.indexOf(t.section));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'least central sections shrink first');
  assert.ok(capped.text.includes('<plan'), 'the plan is the last to shrink');
  assert.deepEqual(capped.topics, ['t', 'tH1']);
});

test('H10/M13: the batch reader fails (never returns a short blob) on a bad child or a truncated stream', () => {
  const ok = createRevisionFs({ sha: 'a'.repeat(40), git: () => ({ status: 0, stdout: '100644 blob o1\tsrc/a.mjs\0' }), readBatch: () => { throw new Error('git cat-file failed (status 128)'); } });
  assert.equal(ok.ok, false);
  assert.match(ok.reason, /blob read failed/);
  assert.equal(typeof gitBatchReader, 'function');
  const missing = createRevisionFs({ sha: 'a'.repeat(40), git: () => ({ status: 0, stdout: '100644 blob o1\tsrc/a.mjs\0' }), readBatch: () => new Map() });
  assert.equal(missing.ok, false, 'a requested blob that did not come back is a failure');
});

test('H11: the default git helpers take the cwd they are given', async () => {
  const { gitRunner } = await import('../scripts/lib/audit/step-back-gitfs.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cwd-'));
  const r = gitRunner(dir)(['rev-parse', '--show-toplevel']);
  assert.notEqual(r.status, 0, 'a non-repo cwd is what git sees, not the process cwd');
});

test('final gate G2: a text section is cut to the RESERVED budget, so only the sections that must shrink do, and the pack fits', async () => {
  const { args } = bigRepo();
  const textOnly = { ...args, rounds: [{ round: 1, findings: [] }], repoFiles: ['plan.md'] };   // no files: only text sections
  const full = await buildStepBackPack(textOnly);
  const limit = full.text.length - 2000;   // cutting the ledger alone (5000 chars) is enough
  const capped = await buildStepBackPack({ ...textOnly, limits: { perFileChars: 60_000, totalChars: limit, maxImporterScan: 5000, maxArchNeighbours: 8 } });
  assert.ok(capped.text.length <= limit, `pack ${capped.text.length} > ${limit}`);
  assert.deepEqual(capped.truncations.map((t) => t.section), ['ledger'], 'rounds and plan must not be cut when the ledger alone suffices');
});

test('R2-H7: truncation always terminates; a budget below the fixed markup is an explicit error, not a hang', { timeout: 20_000 }, async () => {
  const { args } = bigRepo();
  await assert.rejects(() => buildStepBackPack({ ...args, limits: { perFileChars: 60_000, totalChars: 10, maxImporterScan: 5000, maxArchNeighbours: 8 } }), /cannot fit totalChars=10/);
  // A budget that fits only the markup plus a little still completes and stays within it.
  const tight = await buildStepBackPack({ ...args, limits: { perFileChars: 60_000, totalChars: 300, maxImporterScan: 5000, maxArchNeighbours: 8 } }).catch((e) => e);
  assert.ok(tight instanceof Error ? /cannot fit/.test(tight.message) : tight.text.length <= 300);
});

test('R2-M5: an importer that passes classification but cannot be read is recorded in skipped with its reason', async () => {
  const { root, args } = bigRepo();
  const bad = Object.create(fs);
  bad.readFileSync = (p, ...r) => { if (String(p).endsWith('c.mjs')) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return fs.readFileSync(p, ...r); };
  const pack = await buildStepBackPack({ ...args, repoRoot: root, fsImpl: bad });
  assert.ok(pack.skipped.some((s) => s.path === 'src/c.mjs' && s.pattern === 'read-failed' && s.unreadable));
  assert.ok(pack.excluded.unreadable >= 1);
});

test('R3-H8: file and plan paths in pack attributes are redacted like bodies', async () => {
  const { root, args } = bigRepo();
  const secret = 'ghp_0123456789abcdefghijABCDEFGHIJ012345';
  fs.writeFileSync(path.join(root, 'src', `${secret}.mjs`), 'export const z = 1;\n');
  const rounds = [{ round: 1, findings: [{ id: 'H9', severity: 'HIGH', category: 'c', section: 's', detail: 'd', _primaryFile: `src/${secret}.mjs`, affectedFiles: [`src/${secret}.mjs`] }] }];
  const pack = await buildStepBackPack({ ...args, rounds, repoFiles: [...args.repoFiles, `src/${secret}.mjs`] });
  assert.equal(pack.text.includes(secret), false);
  assert.ok(pack.text.includes('<file path="src/[REDACTED'));
});

test('R3-M1: truncation is reported INSIDE the pack as a short <omitted> section', async () => {
  const { args } = bigRepo();
  const pack = await buildStepBackPack({ ...args, limits: { perFileChars: 60_000, totalChars: 40_000, maxImporterScan: 5000, maxArchNeighbours: 8 } });
  assert.ok(pack.text.length <= 40_000);
  assert.match(pack.text, /<omitted>\n[\s\S]*(files not shown|sections shortened)[\s\S]*<\/omitted>/);
  assert.equal((await buildStepBackPack(args)).text.includes('<omitted>'), false, 'a pack that fits has no omitted section');
});

test('R3-M4: the revision prefetch is bounded by the importer-scan limit', () => {
  const files = Array.from({ length: 6 }, (_, i) => ({ path: `src/f${i}.mjs`, oid: `o${i}` }));
  const tree = `${files.map((f) => `100644 blob ${f.oid}\t${f.path}`).join('\0')}\0`;
  let asked = 0;
  const rev = createRevisionFs({ sha: 'a'.repeat(40), maxPrefetch: 2, git: () => ({ status: 0, stdout: tree }), readBatch: (oids) => { asked = oids.length; return new Map(oids.map((o) => [o, 'x'])); } });
  assert.equal(rev.ok, true);
  assert.equal(asked, 2);
});
