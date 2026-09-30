/**
 * @fileoverview The four mechanical waves must not report a clean result over a change they could not read
 * (docs/plans/file-coverage-contract-and-csharp.md, Phase 5; audit-plan R1-M4).
 *
 * The defect (storyline, 2026-09-30): given a diff of twelve C# files, orphan-introduced, event-wiring-symmetry,
 * duplication and adjacency each filtered it to EMPTY and reported success — `ANALYZED_CLEAN — 0 findings`,
 * `Duplication: clean`, `Adjacency: not-triggered` (documented as "we looked; nothing changed inside a conditional").
 * Nothing had been examined, and each line was byte-for-byte what an examined clean change prints.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { waveEligibility, ineligibleReason, eligibilityNote, waveRecord } from '../scripts/lib/audit/wave-eligibility.mjs';
import { defaultResponses } from './helpers/multi-pass-audit-fixtures.mjs';

const isJs = (p) => /\.(m?[jt]sx?|c[jt]s)$/.test(p);

describe('waveEligibility (pure)', () => {
  it('four states: no_changes / ineligible / partial / full', () => {
    assert.equal(waveEligibility([], isJs).state, 'no_changes');
    assert.equal(waveEligibility(['a.cs', 'b.cs'], isJs).state, 'ineligible');
    assert.equal(waveEligibility(['a.cs', 'b.ts'], isJs).state, 'partial');
    assert.equal(waveEligibility(['a.js', 'b.ts'], isJs).state, 'full');
  });

  it('counts are exact, duplicates collapse, and the ineligible files are named', () => {
    const e = waveEligibility(['a.cs', 'a.cs', 'b.ts', '', null, 'c.go'], isJs);
    assert.deepEqual({ changed: e.changed, eligible: e.eligible }, { changed: 3, eligible: 1 });
    assert.deepEqual(e.ineligibleFiles, ['a.cs', 'c.go']);
  });

  it('the wording: ineligible says NOTHING was examined; partial says k of n; full says nothing', () => {
    assert.match(ineligibleReason(waveEligibility(['a.cs', 'b.cs'], isJs), 'js/ts'), /0 of 2 changed file\(s\) are js\/ts; nothing was examined/);
    assert.equal(eligibilityNote(waveEligibility(['a.cs', 'b.ts'], isJs), 'js/ts'), 'examined 1 of 2 changed file(s) (js/ts only)');
    assert.equal(eligibilityNote(waveEligibility(['a.ts'], isJs), 'js/ts'), '');
    assert.equal(eligibilityNote(waveEligibility(['a.cs'], isJs), 'js/ts'), '', 'the ineligible case has its own sentence');
  });

  it('waveRecord projects into the ledger vocabulary', () => {
    assert.equal(waveRecord(waveEligibility(['a.cs'], isJs), 'js/ts').state, 'ineligible');
    assert.equal(waveRecord(waveEligibility(['a.cs', 'b.ts'], isJs), 'js/ts').state, 'partial');
    assert.equal(waveRecord(waveEligibility(['b.ts'], isJs), 'js/ts').state, 'completed');
    assert.equal(waveRecord(waveEligibility(['b.ts'], isJs), 'js/ts', 'errored', 'boom').state, 'errored');
    assert.equal(waveRecord(null, 'js/ts', 'unavailable', 'no snapshot').state, 'unavailable');
    assert.equal(waveRecord(waveEligibility(['a.cs', 'b.ts'], isJs), 'js/ts', 'errored', 'boom').state, 'errored', 'a wave that failed is errored, not partial');
  });

  it('is never `clean`: an ineligible record carries no clean vocabulary', () => {
    const r = waveRecord(waveEligibility(['a.cs'], isJs), 'js/ts');
    assert.doesNotMatch(JSON.stringify(r), /clean|ANALYZED|not-triggered/i);
  });
});

// ── through the real orchestrator ───────────────────────────────────────────

process.env.AUDIT_EXPORTS_FOR_TESTS = '1';
process.env.MODEL_CATALOG_REFRESH = 'skip';
process.env.LEARNING_DISABLE = '1';
process.env.AUDIT_DB_URL = '';
process.env.AUDIT_NO_PREFLIGHT = '1';
const audit = await import('../scripts/openai-audit.mjs');
const { runMultiPassCodeAudit } = audit.__testExports;

const CS = 'tests/fixtures/csharp/Sample.Legacy.cs';
const PLAN = `# Fixture\n\nModify \`${CS}\`.\n`;
const stub = () => ({ responses: { parse: async (p) => { throw new Error(`unstubbed ${p?.text?.format?.name}`); } } });
const OPTS = { noTools: true, noDebtLedger: true, noLedger: true, scopeMode: 'plan' };
const wave = (res, id) => res._coverage.waves.find((w) => w.id === id);

describe('duplication + adjacency over a C#-only change (orchestrator)', () => {
  it('duplication: a detector that says `clean` over a C#-only change is reported INELIGIBLE, and the ledger says so', async () => {
    const res = await runMultiPassCodeAudit(stub(), PLAN, '', false, null, '', {
      ...OPTS, passFilter: ['duplication'], changedFiles: [CS],
      __runDuplicationAnalysis: async () => ({ state: 'clean', deterministicFindings: [], semanticCandidates: [] }),
    });
    const summary = res.overall_reasoning;
    assert.match(summary, /Duplication: INELIGIBLE — 0 of 1 changed file\(s\) are js\/ts; nothing was examined/);
    assert.doesNotMatch(summary, /Duplication: clean/);
    assert.equal(wave(res, 'duplication').state, 'ineligible');
    assert.equal(wave(res, 'duplication').changed, 1);
  });

  it('duplication negative control: over a JS change the same `clean` still prints clean', async () => {
    const res = await runMultiPassCodeAudit(stub(), PLAN.replace(CS, 'scripts/lib/rng.mjs'), '', false, null, '', {
      ...OPTS, passFilter: ['duplication'], changedFiles: ['scripts/lib/rng.mjs'], allowInfraScope: true,
      __runDuplicationAnalysis: async () => ({ state: 'clean', deterministicFindings: [], semanticCandidates: [] }),
    });
    assert.match(res.overall_reasoning, /Duplication: clean — no candidates over threshold\./);
    assert.equal(wave(res, 'duplication').state, 'completed');
  });

  it('duplication partial: a mixed change says how much it examined', async () => {
    const res = await runMultiPassCodeAudit(stub(), PLAN, '', false, null, '', {
      ...OPTS, passFilter: ['duplication'], changedFiles: [CS, 'scripts/lib/rng.mjs'], allowInfraScope: true,
      __runDuplicationAnalysis: async () => ({ state: 'clean', deterministicFindings: [], semanticCandidates: [] }),
    });
    assert.match(res.overall_reasoning, /clean — no candidates over threshold \(examined 1 of 2 changed file\(s\) \(js\/ts only\)\)\./);
    assert.equal(wave(res, 'duplication').state, 'partial');
  });

  it('adjacency: `not-triggered` over a C#-only change becomes INELIGIBLE, never "we looked"', async () => {
    const res = await runMultiPassCodeAudit(stub(), PLAN, '', false, null, '', {
      ...OPTS, passFilter: ['adjacency'], changedFiles: [CS],
      __runAdjacencyAnalysis: async () => ({ coverage: { containersEnumerated: 0, statementsJudged: 0 }, candidates: [], incompleteness: [], threw: null }),
    });
    assert.match(res.overall_reasoning, /Adjacency: INELIGIBLE — 0 of 1 changed file\(s\) are js\/ts/);
    assert.doesNotMatch(res.overall_reasoning, /Adjacency: not-triggered/);
    assert.equal(wave(res, 'adjacency').state, 'ineligible');
  });
});

// ── orphan-introduced + event-wiring against a real (temporary) git repo ────

describe('orphan-introduced + event-wiring over a C#-only commit', () => {
  let repo; let base;
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-elig-'));
    git('init', '--quiet', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'readme.md'), '# r\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'base');
    base = git('rev-parse', 'HEAD');
    fs.mkdirSync(path.join(repo, 'svc'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'svc', 'A.cs'), 'class A { }\n');
    fs.writeFileSync(path.join(repo, 'svc', 'B.cs'), 'class B { }\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'csharp only');
  });
  after(() => fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  it('the orphan diff-scope resolver reports how many changed files it filtered away', async () => {
    const { resolveDiffScope } = await import('../scripts/lib/audit/diff-scope-resolver.mjs');
    const scope = await resolveDiffScope({ repoPath: repo, baseRef: base, headRef: 'HEAD' });
    assert.deepEqual(scope.eligibility, { changed: 2, eligible: 0 });
    assert.equal(scope.changedFiles.length, 0);
  });

  it('runOrphanIntroducedPass → SKIPPED_INELIGIBLE, not the ANALYZED_CLEAN it would go on to report', async () => {
    const { runOrphanIntroducedPass } = await import('../scripts/lib/audit/orphan-pass.mjs');
    const archReport = {
      _meta: { 'js-ts': { allFiles: ['x.js'], callersByTarget: {}, targetsByCaller: {} } },
      perStackResults: [{ stackKind: 'js-ts', status: 'ok' }], violations: [], unmappedFiles: [], deadIntent: [],
    };
    const out = await runOrphanIntroducedPass({
      archReport, repoRoot: repo, baseRef: base, headRef: 'HEAD', runId: 'r', planContent: null, ledger: null, learningWritesAllowed: false,
    });
    assert.equal(out.state, 'SKIPPED_INELIGIBLE');
    assert.match(out.result.result.summary, /INELIGIBLE — 0 of 2 changed file\(s\) are js\/ts; nothing was examined/);
    assert.equal(out.result._wave.state, 'ineligible');
    assert.notEqual(out.state, 'ANALYZED_CLEAN');
  });

  it('runEventWiringSymmetryPass → SKIPPED_INELIGIBLE', async () => {
    const { runEventWiringSymmetryPass } = await import('../scripts/lib/audit/event-wiring-pass.mjs');
    const out = await runEventWiringSymmetryPass({
      repoRoot: repo, auditBaseCommit: base, runId: 'r', ledger: null, planContent: null, learningWritesAllowed: false,
    });
    assert.equal(out.state, 'SKIPPED_INELIGIBLE');
    assert.match(out.result.result.summary, /INELIGIBLE — 0 of 2 changed file\(s\) are js\/ts\/html/);
    assert.equal(out.result._wave.state, 'ineligible');
  });

  it('negative control: adding one JS file to the same commit makes both waves eligible again (partial)', async () => {
    fs.writeFileSync(path.join(repo, 'svc', 'c.js'), 'export const c = 1;\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'add js');
    const { resolveDiffScope } = await import('../scripts/lib/audit/diff-scope-resolver.mjs');
    const scope = await resolveDiffScope({ repoPath: repo, baseRef: base, headRef: 'HEAD' });
    assert.deepEqual(scope.eligibility, { changed: 3, eligible: 1 });
    const { runEventWiringSymmetryPass } = await import('../scripts/lib/audit/event-wiring-pass.mjs');
    const out = await runEventWiringSymmetryPass({ repoRoot: repo, auditBaseCommit: base, runId: 'r', ledger: null, planContent: null, learningWritesAllowed: false });
    assert.notEqual(out.state, 'SKIPPED_INELIGIBLE');
    assert.equal(out.result._wave?.state, 'partial');
    assert.match(out.result.result.summary, /examined 1 of 3 changed file\(s\) \(js\/ts\/html only\)/);
  });
});

describe('the ledger carries every mechanical wave', () => {
  it('waves[] is present on a round and each entry is in the closed vocabulary', async () => {
    const res = await runMultiPassCodeAudit(stub(), PLAN, '', false, null, '', {
      ...OPTS, passFilter: ['duplication', 'adjacency'], changedFiles: [CS],
      __runDuplicationAnalysis: async () => ({ state: 'clean', deterministicFindings: [], semanticCandidates: [] }),
      __runAdjacencyAnalysis: async () => ({ coverage: { containersEnumerated: 0, statementsJudged: 0 }, candidates: [], incompleteness: [], threw: null }),
    });
    const ids = res._coverage.waves.map((w) => w.id).sort();
    assert.deepEqual(ids, ['adjacency', 'duplication', 'event-wiring-symmetry', 'orphan-introduced']);
    for (const w of res._coverage.waves) assert.ok(['completed', 'ineligible', 'partial', 'errored', 'unavailable'].includes(w.state), `${w.id}: ${w.state}`);
    assert.ok(res._coverage.waves.find((w) => w.id === 'orphan-introduced').state === 'unavailable', 'a wave excluded by --passes is unavailable, not completed');
  });

  it('defaultResponses stays importable (harness sanity)', () => {
    assert.ok(defaultResponses());
  });
});
