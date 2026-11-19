import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stampAuditRound } from '../scripts/lib/finalize-outcomes.mjs';
import { verifyMain } from '../scripts/verify-findings.mjs';
import { validateVerifyItem, VerifyArtifactSchema } from '../scripts/lib/audit/contested-findings.mjs';
import { canonicalJson, sha256 } from '../scripts/lib/audit/call-record.mjs';
import { captureTargetIdentity } from '../scripts/lib/audit/target-identity.mjs';
import { makeVerifyRepo, finding } from './helpers/verify-repo.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SID = 'audit-code-1-1';
const QUOTE = 'export function fooBar()';

const SRC = 'export function fooBar() {\n  return 1;\n}\n';
const PASSING_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('scrubbed', () => { assert.equal(process.env.OPENAI_API_KEY, undefined); });\n";
const MOVING_TEST = "import fs from 'node:fs';\nimport { test } from 'node:test';\ntest('moves the tree', () => { fs.appendFileSync('src/a.js', '// moved\\n'); });\n";

/** A fake verifier: refutes with a quote from E1, unless told otherwise. Counts its calls. */
function fakeModel({ fail = new Set(), model = 'gpt-6.1-fake', reply = null } = {}) {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts.passName);
    if ([...fail].some((id) => opts.passName.endsWith(id))) throw Object.assign(new Error('rate limited'), { status: 429 });
    const result = reply ?? { verdict: 'refuted', evidenceRefs: ['E1'], quote: QUOTE, reason: 'the code shows it', severityIfConfirmed: 'HIGH' };
    return { result, model };
  };
  fn.calls = calls;
  return fn;
}

describe('verify-findings: states, exit codes and the cap', () => {
  let repo;
  beforeEach(() => { repo = makeVerifyRepo({ 'src/a.js': SRC, 'tests/t.test.mjs': PASSING_TEST, 'tests/move.test.mjs': MOVING_TEST }); });
  afterEach(() => repo.cleanup());

  function seed(n, { stamp = true } = {}) {
    const findings = Array.from({ length: n }, (_, i) => finding(`H${i + 1}`, { _hash: `hash${i}` }));
    const tree = captureTargetIdentity(repo.root).auditedTree;
    repo.audit(`${SID}-r1-result.json`, { findings, round: 1, _sid: SID, ...(stamp ? { _auditedTree: tree } : {}) });
    const triage = Object.fromEntries(findings.map((f) => [f.id, { action: 'rebut' }]));
    repo.audit('triage.json', triage);
    return { findings, triage };
  }
  const run = (over, deps) => verifyMain({ sid: SID, round: 1, max: 10, triagePath: '.audit/triage.json', out: '.audit/v.json', tests: [], ...over }, { repoRoot: repo.root, ...deps });

  it('12 contested with --max 10, one call lost to a 429: 9 verified, 1 failed, 2 over-cap, exit 3, complete:false', async () => {
    seed(12);
    const model = fakeModel({ fail: new Set(['H3']) });
    const r = await run({}, { callModel: model });
    assert.equal(r.exit, 3);
    assert.equal(model.calls.length, 10, 'the two over-cap findings were never sent');
    const art = JSON.parse(fs.readFileSync(path.join(repo.root, '.audit/v.json'), 'utf-8'));
    assert.ok(VerifyArtifactSchema.safeParse(art).success);
    assert.deepEqual(art.counts, { verified: 9, inconclusive: 0, overCap: 2, failed: 1 });
    assert.equal(art.complete, false);
    assert.equal(r.envelope.ok, false);
    assert.deepEqual(art.items.find((i) => i.state === 'failed').failure, { stage: 'call', category: 'http-429' });
    assert.deepEqual(r.envelope.routing.map((x) => x.state).sort(), ['failed', 'over-cap', 'over-cap']);
  });
  it('a clean run is complete, exit 0, and the recorded model is the response\'s own', async () => {
    seed(2);
    const r = await run({}, { callModel: fakeModel({ model: 'gpt-6.1-served' }) });
    assert.equal(r.exit, 0);
    const art = JSON.parse(fs.readFileSync(path.join(repo.root, '.audit/v.json'), 'utf-8'));
    assert.deepEqual(art.items.map((i) => [i.state, i.model]), [['verified', 'gpt-6.1-served'], ['verified', 'gpt-6.1-served']]);
    assert.equal(art.items[0].family.selfFamily, true, 'same-family verification is shown, not hidden');
  });
  it('a quote that is not in the pack is demoted to inconclusive and routed to rebuttal', async () => {
    seed(1);
    const r = await run({}, { callModel: fakeModel({ reply: { verdict: 'refuted', evidenceRefs: ['E1'], quote: 'something the code never says', reason: 'x', severityIfConfirmed: 'LOW' } }) });
    const art = JSON.parse(fs.readFileSync(path.join(repo.root, '.audit/v.json'), 'utf-8'));
    assert.equal(art.items[0].state, 'inconclusive');
    assert.equal(art.items[0].demotedFrom, 'refuted');
    assert.deepEqual(r.envelope.routing, [{ findingId: 'H1', state: 'inconclusive' }]);
  });
  it('--model latest-sonnet exits 1 and sends nothing', async () => {
    seed(1);
    const model = fakeModel();
    const r = await run({ model: 'latest-sonnet' }, { callModel: model });
    assert.equal(r.exit, 1);
    assert.match(r.envelope.error, /unsupported verifier model family/);
    assert.equal(model.calls.length, 0);
  });
  it('GPT sentinels are accepted', async () => {
    seed(1);
    assert.equal((await run({ model: 'latest-gpt-mini' }, { callModel: fakeModel() })).exit, 0);
  });

  describe('inputs and outputs', () => {
    it('a round result with no audited-tree stamp is refused: nothing ties the evidence to what the round read', async () => {
      seed(1, { stamp: false });
      const model = fakeModel();
      const r = await run({}, { callModel: model });
      assert.equal(r.exit, 2);
      assert.match(r.envelope.error, /no audited-tree stamp/);
      assert.equal(model.calls.length, 0);
    });
    it('--out is required, and may not alias the result, ledger or triage', async () => {
      seed(1);
      await assert.rejects(run({ out: null }, { callModel: fakeModel() }), /--out <artifact> is required/);
      await assert.rejects(run({ out: `.audit/${SID}-r1-result.json` }, { callModel: fakeModel() }), /would overwrite/);
      await assert.rejects(run({ out: '.audit/triage.json' }, { callModel: fakeModel() }), /would overwrite/);
    });
    it('--out may not alias a PRIOR round result either', async () => {
      seed(1);
      repo.audit(`${SID}-r2-result.json`, JSON.parse(fs.readFileSync(path.join(repo.root, '.audit', `${SID}-r1-result.json`), 'utf-8')));
      await assert.rejects(verifyMain({ sid: SID, round: 2, max: 10, out: `.audit/${SID}-r1-result.json`, tests: [] }, { repoRoot: repo.root, callModel: fakeModel() }), /would overwrite/);
    });
    it('--check of an empty or malformed artifact fails its schema instead of reporting success', async () => {
      seed(1);
      repo.audit('empty.json', {});
      const r = await verifyMain({ sid: SID, round: 1, check: '.audit/empty.json' }, { repoRoot: repo.root });
      assert.equal(r.exit, 2);
      assert.match(r.envelope.error, /fails its schema/);
    });
    it('the verifier prompt is redacted: a secret in a finding id or category never reaches the model', async () => {
      const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
      const f = finding('H1', { category: `[be] leak ${TOKEN}` });
      repo.audit(`${SID}-r1-result.json`, { findings: [f], round: 1, _sid: SID, _auditedTree: captureTargetIdentity(repo.root).auditedTree });
      repo.audit('triage.json', { H1: { action: 'rebut' } });
      let sent = '';
      await run({}, { callModel: async (o) => { sent = JSON.stringify(o.messages); return { result: { verdict: 'inconclusive', evidenceRefs: [], quote: '', reason: 'x', severityIfConfirmed: 'LOW' }, model: 'gpt-x' }; } });
      assert.ok(sent.length > 0 && !sent.includes(TOKEN));
    });
    it('history is context only: a quote taken from it is demoted', async () => {
      seed(1);
      const model = fakeModel({ reply: { verdict: 'refuted', evidenceRefs: ['E4'], quote: 'export function fooBar()', reason: 'x', severityIfConfirmed: 'LOW' } });
      await run({}, { callModel: model });
      const art = JSON.parse(fs.readFileSync(path.join(repo.root, '.audit/v.json'), 'utf-8'));
      const hist = art.items[0].evidence.pack.find((i) => i.provenance.source === 'history');
      assert.equal(hist.eligible, false);
    });
  });

  describe('snapshot: the evidence is about the audited bytes', () => {
    it('an edit between the round and the verification exits 2 before acquisition', async () => {
      seed(1);
      repo.write('src/a.js', `${SRC}// edited after the round\n`);
      const model = fakeModel();
      const r = await run({}, { callModel: model });
      assert.equal(r.exit, 2);
      assert.match(r.envelope.error, /tree moved/);
      assert.equal(model.calls.length, 0);
    });
    it('a --run-test test that writes a tracked file exits 2, tree moved during verification, with 0 model calls', async () => {
      seed(1);
      const model = fakeModel();
      const r = await run({ tests: ['tests/move.test.mjs'] }, { callModel: model });
      assert.equal(r.exit, 2);
      assert.match(r.envelope.error, /tree moved during verification/);
      assert.equal(model.calls.length, 0);
    });
    it('on a dirty audited tree the grep evidence is the working-tree bytes, not HEAD', async () => {
      repo.write('src/a.js', `${SRC}export const marker = fooBar; // dirty only\n`);
      seed(1);
      const model = fakeModel();
      await run({}, { callModel: model });
      const art = JSON.parse(fs.readFileSync(path.join(repo.root, '.audit/v.json'), 'utf-8'));
      const grep = art.items[0].evidence.pack.find((i) => i.provenance.source === 'grep');
      assert.match(grep.text, /dirty only/);
    });
  });

  describe('--run-test: the operator names it', () => {
    it('an untracked path and a non-test path are refused', async () => {
      repo.write('tests/untracked.test.mjs', PASSING_TEST);
      seed(1);
      await assert.rejects(run({ tests: ['tests/untracked.test.mjs'] }, { callModel: fakeModel() }), /tracked file that matches the test glob/);
      await assert.rejects(run({ tests: ['src/a.js'] }, { callModel: fakeModel() }), /tracked file that matches the test glob/);
    });
    it('a test named only inside finding text is never run', async () => {
      const findings = [finding('H1', { detail: 'Run tests/move.test.mjs and see the `fooBar` function change.' })];
      repo.audit(`${SID}-r1-result.json`, { findings, round: 1, _sid: SID, _auditedTree: captureTargetIdentity(repo.root).auditedTree });
      repo.audit('triage.json', { H1: { action: 'rebut' } });
      const r = await run({}, { callModel: fakeModel() });
      assert.equal(r.exit, 0, 'the moving test did not run, so the tree did not move');
      const art = JSON.parse(fs.readFileSync(path.join(repo.root, '.audit/v.json'), 'utf-8'));
      assert.ok(!art.items[0].evidence.pack.some((i) => i.provenance.source === 'test'));
    });
    it('a tracked test runs in a scrubbed env and its summary is context, never quotable proof', async () => {
      seed(1);
      const saved = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key-0123456789';
      try {
        const r = await run({ tests: ['tests/t.test.mjs'] }, { callModel: fakeModel() });
        assert.equal(r.exit, 0);
      } finally { if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved; }
      const art = JSON.parse(fs.readFileSync(path.join(repo.root, '.audit/v.json'), 'utf-8'));
      const t = art.items[0].evidence.pack.find((i) => i.provenance.source === 'test');
      assert.match(t.text, /# pass 1/);
      assert.match(t.text, /# fail 0/, 'a pass means the child never saw OPENAI_API_KEY');
      assert.equal(t.eligible, false);
    });
  });
});

describe('the artifact boundary (validateVerifyItem, --check, and the ledger writer)', () => {
  let repo; let resultPath; let art;
  beforeEach(async () => {
    repo = makeVerifyRepo({ 'src/a.js': SRC });
    const findings = [finding('H1', { _hash: 'a1' }), finding('H2', { _hash: 'a2' })];
    resultPath = path.join(repo.root, '.audit', `${SID}-r1-result.json`);
    repo.audit(`${SID}-r1-result.json`, { findings, round: 1, _sid: SID, _auditedTree: captureTargetIdentity(repo.root).auditedTree });
    repo.audit('triage.json', { H1: { action: 'rebut' }, H2: { action: 'rebut' } });
    await verifyMain({ sid: SID, round: 1, max: 10, triagePath: '.audit/triage.json', out: '.audit/v.json', tests: [] }, { repoRoot: repo.root, callModel: fakeModel() });
    art = () => JSON.parse(fs.readFileSync(path.join(repo.root, '.audit/v.json'), 'utf-8'));
  });
  afterEach(() => repo.cleanup());
  const check = (a, id = 'H1') => validateVerifyItem(a, id, { repoRoot: repo.root, resultPath });
  const reHash = (a, id) => { const it = a.items.find((i) => i.source.findingId === id); it.evidence.packHash = sha256(canonicalJson(it.evidence.pack)); };

  it('the untouched artifact is accepted (negative control)', () => assert.deepEqual(check(art()).ok, true));
  it('refuses a wrong sid, a wrong round, an edited result file, an unknown finding id and a duplicate item', () => {
    assert.match(check({ ...art(), sid: 'audit-code-9-9' }).reason, /sid\/round mismatch/);
    assert.match(check({ ...art(), round: 2 }).reason, /sid\/round mismatch/);
    assert.match(check(art(), 'H99').reason, /not in round/);
    const dup = art(); dup.items.push(structuredClone(dup.items[0]));
    assert.match(check(dup).reason, /duplicate/);
    fs.appendFileSync(resultPath, ' ');
    assert.match(check(art()).reason, /hash mismatch/);
  });
  it('refuses a tampered pack (packHash mismatch)', () => {
    const a = art(); a.items[0].evidence.pack[1].text += ' extra';
    assert.match(check(a).reason, /packHash mismatch/);
  });
  it('tamper control: a fabricated quote in a cited code item with a RECOMPUTED packHash is refused by re-acquisition', () => {
    const a = art();
    const it = a.items[0];
    it.evidence.pack[1].text += '\nif (never) { /* fabricated line that refutes the finding */ }';
    it.evidence.quote = 'fabricated line that refutes the finding';
    reHash(a, 'H1');
    const r = check(a);
    assert.equal(r.ok, false);
    assert.match(r.reason, /does not match what the repo yields/);
  });
  it('the schema rejects an artifact with an unknown key', () => assert.match(check({ ...art(), extra: 1 }).reason, /^schema/));
  it('the tree moving after verification refuses an item that relies on current code', () => {
    repo.write('src/a.js', `${SRC}// moved\n`);
    assert.match(check(art()).reason, /tree moved/);
  });
  it('a stored verdict that no longer validates is refused (a quote that is not in the re-acquired items)', () => {
    const a = art(); a.items[0].evidence.quote = 'a long quote that the code does not contain';
    assert.match(check(a).reason, /no longer validates/);
  });

  describe('--check shows triage only what still validates', () => {
    it('prints a [verify:] line for each passing item and none for an invalid one', async () => {
      const r = await verifyMain({ sid: SID, round: 1, check: '.audit/v.json' }, { repoRoot: repo.root });
      assert.equal(r.envelope.lines.filter((l) => l.includes('[verify: refuted')).length, 2);
      assert.deepEqual(r.lines, [], 'stdout carries one JSON envelope, not loose lines');
      repo.write('src/a.js', `${SRC}// moved\n`);
      const moved = await verifyMain({ sid: SID, round: 1, check: '.audit/v.json' }, { repoRoot: repo.root });
      assert.equal(moved.envelope.lines.filter((l) => l.includes('[verify:')).length, 0);
      assert.equal(moved.exit, 3, 'an item that no longer validates fails the check and is routed to rebuttal');
      assert.deepEqual(moved.envelope.invalid.map((i) => i.findingId).sort(), ['H1', 'H2']);
    });
  });

  describe('round-3 hardening', () => {
    it('--check of an incomplete artifact (a failed item) exits 3 and is not ok', async () => {
      const a = art(); a.items[0] = { source: a.items[0].source, contestKind: a.items[0].contestKind, state: 'failed', failure: { stage: 'call', category: 'http-429' } };
      a.complete = false; a.counts = { verified: 1, inconclusive: 0, overCap: 0, failed: 1 };
      repo.audit('incomplete.json', a);
      const r = await verifyMain({ sid: SID, round: 1, check: '.audit/incomplete.json' }, { repoRoot: repo.root });
      assert.equal(r.exit, 3);
      assert.equal(r.envelope.ok, false);
    });
    it('a test item marked eligible in an edited artifact is refused, even with a recomputed packHash', async () => {
      await verifyMain({ sid: SID, round: 1, max: 10, triagePath: '.audit/triage.json', out: '.audit/vt.json', tests: [] }, { repoRoot: repo.root, callModel: fakeModel() });
      const a = JSON.parse(fs.readFileSync(path.join(repo.root, '.audit/vt.json'), 'utf-8'));
      const it = a.items[0];
      it.evidence.pack.push({ tag: `E${it.evidence.pack.length}`, provenance: { source: 'test', path: 't.test.mjs', rev: 'audited-tree', run: 'node --test' }, text: 'not ok 1 - forged', eligible: true });
      reHash(a, 'H1');
      assert.match(check(a).reason, /cannot be eligible/);
    });
    it('the CLI process emits an {ok:false} JSON envelope for a bad argument', () => {
      const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'verify-findings.mjs'), '--sid', 'x'], { encoding: 'utf-8' });
      assert.equal(r.status, 2);
      assert.equal(JSON.parse(r.stdout.trim().split('\n').pop()).ok, false);
    });
  });

  describe('the ledger writer: verification is evidence, never a ruling', () => {
    const WRITE = path.join(REPO_ROOT, 'scripts', 'write-ledger-entries.mjs');
    const write = (triage) => {
      repo.audit('t2.json', triage);
      return spawnSync(process.execPath, [WRITE, '--result', resultPath, '--ledger', path.join(repo.root, '.audit', `${SID}-ledger.json`), '--triage', path.join(repo.root, '.audit', 't2.json'), '--no-finalize'], { cwd: repo.root, encoding: 'utf-8', env: { ...process.env, AUDIT_DB_URL: '' } });
    };
    const ledger = () => JSON.parse(fs.readFileSync(path.join(repo.root, '.audit', `${SID}-ledger.json`), 'utf-8')).entries;
    const row = (over = {}) => ({ outcome: 'accepted', state: 'planned', ruling: 'sustain', why: 'valid, scheduled', ...over });

    it('a refuted verdict with an accepted triage yields an accepted entry; only declared reliance leaves a pointer, and no verification data is copied', () => {
      const packHash = art().items[0].evidence.packHash;
      const r = write({ H1: row({ reliesOn: { artifact: '.audit/v.json', packHash, verdict: 'refuted' } }), H2: row() });
      assert.equal(r.status, 0, r.stderr);
      const [e1, e2] = ledger();
      assert.equal(e1.adjudicationOutcome, 'accepted');
      assert.deepEqual(e1.reliesOn, { artifact: '.audit/v.json', packHash, verdict: 'refuted' });
      assert.equal(e2.reliesOn, undefined);
      assert.ok(!JSON.stringify(ledger()).includes('quote'), 'no verification data in the ledger');
    });
    it('a row that relies on verification which no longer validates refuses the WHOLE batch; rows without reliesOn write normally', () => {
      const packHash = art().items[0].evidence.packHash;
      repo.write('src/a.js', `${SRC}// moved after verification\n`);
      const refused = write({ H1: row({ outcome: 'dismissed', ruling: 'overrule', dismissReasonClass: 'false-positive', reliesOn: { artifact: '.audit/v.json', packHash, verdict: 'refuted' } }), H2: row() });
      assert.equal(refused.status, 2);
      assert.match(refused.stderr, /triage row H1 relied on verification that no longer validates .*re-triage/);
      assert.equal(fs.existsSync(path.join(repo.root, '.audit', `${SID}-ledger.json`)), false, 'nothing was written');
      const ok = write({ H1: row(), H2: row() });
      assert.equal(ok.status, 0, ok.stderr);
    });
    it('a reliesOn that omits the verdict, or names a different one, refuses the batch', () => {
      const packHash = art().items[0].evidence.packHash;
      assert.match(write({ H1: row({ reliesOn: { artifact: '.audit/v.json', packHash } }), H2: row() }).stderr, /must be \{artifact, packHash, verdict\}/);
      assert.match(write({ H1: row({ reliesOn: { artifact: '.audit/v.json', packHash, verdict: 'confirmed' } }), H2: row() }).stderr, /verdict is now refuted/);
    });
    it('a reliesOn whose packHash is not the artifact\'s refuses the batch', () => {
      const r = write({ H1: row({ reliesOn: { artifact: '.audit/v.json', packHash: 'not-the-hash', verdict: 'refuted' } }), H2: row() });
      assert.equal(r.status, 2);
      assert.match(r.stderr, /packHash differs/);
    });
  });
});

describe('the round result carries the audited target', () => {
  it('stampAuditRound records _auditedTree and a full-hex _auditedSha, and nothing it was not given', () => {
    const sha = 'a'.repeat(40);
    assert.deepEqual(stampAuditRound({}, 2, null, { auditedTree: 'tree1', auditedSha: sha }), { round: 2, _auditedTree: 'tree1', _auditedSha: sha });
    assert.deepEqual(stampAuditRound({}, 2, null, { auditedTree: null, auditedSha: 'HEAD' }), { round: 2 });
    assert.deepEqual(stampAuditRound({}, 2), { round: 2 });
  });
});

describe('the CLI process', () => {
  const CLI = path.join(REPO_ROOT, 'scripts', 'verify-findings.mjs');
  it('--selfcheck-relocation answers OK', () => {
    const r = spawnSync(process.execPath, [CLI, '--selfcheck-relocation'], { encoding: 'utf-8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /OK/);
  });
  it('an unknown flag and a missing --round exit 2', () => {
    assert.equal(spawnSync(process.execPath, [CLI, '--sid', 'x', '--round', '1', '--bogus'], { encoding: 'utf-8' }).status, 2);
    assert.equal(spawnSync(process.execPath, [CLI, '--sid', 'x'], { encoding: 'utf-8' }).status, 2);
  });
});
