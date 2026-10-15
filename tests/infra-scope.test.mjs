/**
 * @fileoverview The final reviewer gets the audit's infra scope (fleet p-20261015065849-095b, p-…4cc2).
 *
 * `isAuditInfraFile` withholds ~65 of this tool's own modules so a consumer's synced copy is not audited as the consumer's
 * code. In THIS repo they are the code under review: #247's final review covered "PARTIAL, 14 files unmeasured" (incl.
 * debt-ledger.mjs) and AI-Gate still read converged; #258/#259 printed `NONE: …file-taxonomy.mjs`.
 * Plan: docs/plans/audit-unadmitted-files.md §8 (PR 3).
 *
 * The behavioural red is the REQUEST that leaves the process (a changed infra file's content is, or is not, in it), not an
 * intermediate value.
 */
process.env.FINAL_REVIEW_MODEL = 'test-model';
process.env.AUDIT_EXPORTS_FOR_TESTS = '1';
process.env.MODEL_CATALOG_REFRESH = 'skip';
process.env.LEARNING_DISABLE = '1';
process.env.AUDIT_DB_URL = '';
process.env.AUDIT_NO_PREFLIGHT = '1';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runFinalReview } = await import('../scripts/gemini-review.mjs');
const { resolveInfraScope } = await import('../scripts/lib/audit-scope.mjs');
const { isSourceRepoRoot } = await import('../scripts/lib/is-source-repo.mjs');
const { resolveFinalReviewInfraScope, selectFinalReviewCodePaths } = await import('../scripts/lib/final-review/scope.mjs');
const { REVIEW_FLAGS, parseReviewArgs } = await import('../scripts/lib/final-review/review-args.mjs');

const VALID_REVIEW = JSON.stringify({
  verdict: 'APPROVE',
  deliberation_quality: { claude_bias_detected: false, gpt_false_positive_count: 0, deliberation_was_fair: true, quality_summary: 'ok' },
  new_findings: [], wrongly_dismissed: [], over_engineering_flags: [],
  architectural_coherence: 'Strong', overall_reasoning: 'ok',
});
const fakeClient = (sink) => ({
  chat: { completions: { create: async (body) => {
    sink.request = body.messages.find((m) => m.role === 'user')?.content ?? '';
    return { choices: [{ message: { content: VALID_REVIEW }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  } } },
});

const INFRA = 'scripts/lib/debt-ledger.mjs';
const PLAIN = 'src/a.mjs';
const INFRA_MARKER = 'INFRA_MARKER_DEBT_LEDGER';
const PLAIN_MARKER = 'PLAIN_MARKER_SRC_A';

function makeRepo(pkgName) {
  const dir = mkdtempSync(join(tmpdir(), 'infra-scope-'));
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  if (pkgName) writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkgName }));
  writeFileSync(join(dir, INFRA), `// ${INFRA_MARKER}\nexport const x = 1;\n`);
  writeFileSync(join(dir, PLAIN), `// ${PLAIN_MARKER}\nexport const y = 2;\n`);
  return dir;
}

describe('the oracle: is the bundle\'s own code under review here?', () => {
  let src; let consumer; let bare;
  before(() => { src = makeRepo('claude-engineering-skills'); consumer = makeRepo('some-consumer-app'); bare = makeRepo(null); });
  after(() => { for (const d of [src, consumer, bare]) rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  test('the source repo admits it; a consumer, and a repo with no package.json, do not (fail closed)', () => {
    assert.deepEqual(resolveInfraScope({ flag: false, repoRoot: src }), { admitted: true, source: 'source-repo' });
    assert.deepEqual(resolveInfraScope({ flag: false, repoRoot: consumer }), { admitted: false, source: null });
    assert.deepEqual(resolveInfraScope({ flag: false, repoRoot: bare }), { admitted: false, source: null });
    assert.deepEqual(resolveInfraScope({ flag: false, repoRoot: join(src, 'does', 'not', 'exist') }), { admitted: false, source: null });
  });
  test('the explicit flag admits it anywhere, and is reported as the source', () => {
    assert.deepEqual(resolveInfraScope({ flag: true, repoRoot: consumer }), { admitted: true, source: 'flag' });
  });
  test('isSourceRepoRoot is the path-taking predicate', () => {
    assert.equal(isSourceRepoRoot(src), true);
    assert.equal(isSourceRepoRoot(consumer), false);
  });
});

describe('the final reviewer inherits the audit\'s decision', () => {
  const consumerOracle = () => ({ admitted: false, source: null });
  const sourceOracle = () => ({ admitted: true, source: 'source-repo' });
  const tx = (admittedFlags) => ({ rounds: admittedFlags.map((a) => ({ round: 1, ...(a === undefined ? {} : { _infraScope: { admitted: a } }) })) });

  test('flag > transcript round > oracle, each reported as its source', () => {
    assert.deepEqual(resolveFinalReviewInfraScope({ flag: true, transcript: tx([false]), repoRoot: '.', oracle: consumerOracle }), { admitted: true, source: 'flag' });
    assert.deepEqual(resolveFinalReviewInfraScope({ flag: false, transcript: tx([false, true]), repoRoot: '.', oracle: consumerOracle }), { admitted: true, source: 'transcript' });
    assert.deepEqual(resolveFinalReviewInfraScope({ flag: false, transcript: tx([false]), repoRoot: '.', oracle: sourceOracle }), { admitted: true, source: 'source-repo' });
  });
  test('control: nothing admits it ⇒ not admitted; older transcripts with no field fall through to the oracle', () => {
    assert.deepEqual(resolveFinalReviewInfraScope({ flag: false, transcript: tx([false, undefined]), repoRoot: '.', oracle: consumerOracle }), { admitted: false, source: null });
    assert.deepEqual(resolveFinalReviewInfraScope({ flag: false, transcript: { raw: 'markdown' }, repoRoot: '.', oracle: consumerOracle }), { admitted: false, source: null });
    assert.deepEqual(resolveFinalReviewInfraScope({ flag: false, transcript: null, repoRoot: '.', oracle: consumerOracle }), { admitted: false, source: null });
  });
  test('the review CLI accepts --allow-infra-scope', () => {
    assert.ok(REVIEW_FLAGS.includes('--allow-infra-scope'));
    assert.equal(parseReviewArgs(['review', 'p.md', 't.json', '--allow-infra-scope']).allowInfraScope, true);
    assert.equal(parseReviewArgs(['review', 'p.md', 't.json']).allowInfraScope, false);
  });
});

describe('code-path selection', () => {
  const exists = () => true;
  const deps = { exists, isSensitive: () => false, isSensitiveLexical: () => false, isInfra: (p) => p.endsWith('debt-ledger.mjs') || p.endsWith('file-taxonomy.mjs') };
  const noPlanPaths = () => ({ found: [] });
  const sel = (over) => selectFinalReviewCodePaths({ reduced: false, transcript: {}, planContent: '', infraAdmitted: false, deps, extractPlanPaths: noPlanPaths, ...over });

  test('reduced scope: infra excluded and counted unless admitted', () => {
    const transcript = { changed_files: [INFRA, PLAIN] };
    const off = sel({ reduced: true, transcript });
    assert.deepEqual(off.codePaths, [PLAIN]);
    assert.equal(off.codeExcluded.infra, 1);
    const on = sel({ reduced: true, transcript, infraAdmitted: true });
    assert.deepEqual(on.codePaths.sort(), [INFRA, PLAIN].sort());
    assert.equal(on.codeExcluded.infra, 0);
  });
  test('full scope: an infra path IN code_files is kept only when admitted', () => {
    const transcript = { code_files: [PLAIN, INFRA], changed_files: [PLAIN, INFRA] };
    assert.deepEqual(sel({ transcript }).codePaths, [PLAIN]);
    assert.deepEqual(sel({ transcript, infraAdmitted: true }).codePaths.sort(), [INFRA, PLAIN].sort());
  });
  test('audit-plan R1-H1: an infra file the audit EXCLUDED (absent from code_files, present in changed_files) is added when admitted, not otherwise', () => {
    const transcript = { code_files: [PLAIN], changed_files: [PLAIN, INFRA] };
    assert.deepEqual(sel({ transcript }).codePaths, [PLAIN]);
    assert.deepEqual(sel({ transcript, infraAdmitted: true }).codePaths.sort(), [INFRA, PLAIN].sort());
  });
  test('admitted, but a sensitive, deleted or undeclared infra path is never added', () => {
    const transcript = { code_files: [PLAIN], changed_files: [PLAIN, INFRA] };
    assert.deepEqual(sel({ transcript, infraAdmitted: true, deps: { ...deps, exists: (p) => p !== INFRA } }).codePaths, [PLAIN], 'deleted');
    assert.deepEqual(sel({ transcript, infraAdmitted: true, deps: { ...deps, isSensitive: (p) => p === INFRA } }).codePaths, [PLAIN], 'sensitive');
    assert.deepEqual(sel({ transcript: { code_files: [PLAIN] }, infraAdmitted: true }).codePaths, [PLAIN], 'no changed_files adds nothing');
  });
  test('control: a deeper path sharing an infra basename was never infra (unchanged)', () => {
    const transcript = { code_files: ['scripts/lib/persona-test/schemas.mjs'], changed_files: [] };
    assert.deepEqual(sel({ transcript, deps: { ...deps, isInfra: () => false } }).codePaths, ['scripts/lib/persona-test/schemas.mjs']);
  });
});

describe('end to end: the REQUEST that leaves the process (the behavioural red)', () => {
  let src; let consumer; let prevCwd;
  before(() => { prevCwd = process.cwd(); src = makeRepo('claude-engineering-skills'); consumer = makeRepo('some-consumer-app'); });
  after(() => { process.chdir(prevCwd); for (const d of [src, consumer]) rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  // The audit EXCLUDED the infra file, so code_files lacks it (exactly the #258/#259/#247 transcripts).
  const transcriptOf = (extraRound = {}) => JSON.stringify({
    audit_mode: 'code',
    rounds: [{ round: 1, verdict: 'PASS', findings: [], ...extraRound }],
    code_files: [PLAIN],
    changed_files: [PLAIN, INFRA],
  });

  for (const scope of ['full', 'thin']) {
    test(`${scope} envelope, run IN the source repo: a changed infra file's content reaches the reviewer`, async () => {
      process.chdir(src);
      const sink = {};
      const { envelope } = await runFinalReview('openai-compatible', fakeClient(sink), 'Plan.', transcriptOf(), 'ctx', 'code', null, { envelopeScope: scope });
      assert.ok(sink.request.includes(PLAIN_MARKER), 'control: the ordinary file is rendered');
      assert.ok(sink.request.includes(INFRA_MARKER), 'the changed infra file was withheld from the final reviewer');
      assert.equal(envelope.infraScope.admitted, true);
      assert.equal(envelope.infraScope.source, 'source-repo');
    });

    test(`${scope} envelope, run in a CONSUMER: unchanged — the infra file stays withheld and is said to be`, async () => {
      process.chdir(consumer);
      const sink = {};
      const { envelope } = await runFinalReview('openai-compatible', fakeClient(sink), 'Plan.', transcriptOf(), 'ctx', 'code', null, { envelopeScope: scope });
      assert.ok(sink.request.includes(PLAIN_MARKER));
      assert.ok(!sink.request.includes(INFRA_MARKER), 'a consumer must keep excluding the synced tooling copy');
      assert.equal(envelope.infraScope.admitted, false);
    });
  }

  test('a consumer inherits the audit\'s explicit admission from the round (the /cycle --allow-infra-scope path)', async () => {
    process.chdir(consumer);
    const sink = {};
    const { envelope } = await runFinalReview('openai-compatible', fakeClient(sink), 'Plan.', transcriptOf({ _infraScope: { admitted: true } }), 'ctx', 'code');
    assert.ok(sink.request.includes(INFRA_MARKER));
    assert.equal(envelope.infraScope.source, 'transcript');
  });
});

describe('the audit records its decision on the round (audit-plan D8)', () => {
  const CS = 'tests/fixtures/csharp/Sample.Legacy.cs';
  const stub = (responses) => ({ responses: { parse: async (params) => {
    const name = params?.text?.format?.name;
    if (!(name in responses)) throw new Error('unstubbed pass ' + name);
    return { status: 'completed', output: [], output_parsed: responses[name], usage: { input_tokens: 1, output_tokens: 1, prompt_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  } } });
  const OPTS = { passFilter: ['structure', 'wiring', 'backend', 'sustainability', 'quickfix'], noTools: true, noDebtLedger: true, noLedger: true, scopeMode: 'plan', coverageChanged: [{ path: CS, changeKind: 'modified' }] };
  for (const admitted of [true, false]) {
    test('allowInfraScope=' + admitted + ' is written to the round as _infraScope.admitted', async () => {
      const { runMultiPassCodeAudit } = (await import('../scripts/openai-audit.mjs')).__testExports;
      const { defaultResponses } = await import('./helpers/multi-pass-audit-fixtures.mjs');
      const plan = ['# Plan', '', `Modify \`${CS}\`.`, ''].join('\n');
      const res = await runMultiPassCodeAudit(stub(defaultResponses()), plan, '', false, null, '', { ...OPTS, allowInfraScope: admitted });
      assert.deepEqual(res._infraScope, { admitted });
    });
  }
});
