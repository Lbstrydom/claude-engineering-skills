#!/usr/bin/env node
/**
 * @fileoverview Thin CLI for the synchronous Fable-5.2-vs-Opus-5.5 coordinator
 * decision experiment. One-off, pre-registered, NOT a collector.
 *
 * Plan: docs/plans/fable-vs-opus-decision-eval.md
 *
 *   node scripts/model-eval-decision.mjs freeze
 *   node scripts/model-eval-decision.mjs run --phase rehearsal --cap-usd 10 --budget-scope autonomous
 *   node scripts/model-eval-decision.mjs run --phase variance --cap-usd 10 --budget-scope autonomous
 *   node scripts/model-eval-decision.mjs run --phase main --reps 4 --cap-usd 40 --confirm-main
 *   node scripts/model-eval-decision.mjs report --run-id variance
 *   node scripts/model-eval-decision.mjs spot-agree --run-id main
 *   node scripts/model-eval-decision.mjs cross-grade --run-id main --cap-usd 25 --budget-scope main --confirm-cross-grade
 *
 * Every arm call goes through createAnthropicClient({backend:'sdk'}) — passed
 * explicitly, never the ambient CLAUDE_BACKEND (the cli backend drops options
 * and adds a ~164K-token prefix per call). Exit 4 = budget stop (shared with
 * the sibling model-eval CLIs); 2 = preflight; 1 = crash.
 *
 * @module scripts/model-eval-decision
 */

import './lib/load-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { assertKnownFlags, finishAndExit } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { BUDGET_STOPPED_EXIT_CODE, RunPreflightError } from './lib/model-eval/cli-shared.mjs';
import { loadCorpus, freezeManifest } from './lib/model-eval/decision/corpus.mjs';
import { armPromptHash } from './lib/model-eval/decision/arm.mjs';
import { judgePromptHash } from './lib/model-eval/decision/judge.mjs';
import { runDecisionEval, buildSummary, PHASES } from './lib/model-eval/decision/runner.mjs';
import { renderSpotSample, parseSpotAgreement } from './lib/model-eval/decision/spot-sample.mjs';
import { sumScopeSpend, createMeter } from './lib/model-eval/decision/meter.mjs';
import { DECISION_EVAL_CONTRACT_EPOCH } from './lib/model-eval/decision/corpus.mjs';
import { runCrossGrade, evaluateCrossGrade, makeGeminiInvoker, GEMINI_MAX_OUTPUT_TOKENS } from './lib/model-eval/decision/cross-grade.mjs';
import { DEFAULT_JUDGE_MAX_OUTPUT_TOKENS } from './lib/model-eval/decision/judge.mjs';

export const DEFAULT_ROOT = path.join('docs', 'research', 'fable-vs-opus-decision-eval');
const KNOWN_FLAGS = ['--confirm-cross-grade', '--budget-scope', '--phase', '--cap-usd', '--reps', '--seed', '--run-id', '--root', '--confirm-main', '--judge-reasoning'];

function flag(argv, name) { const i = argv.indexOf(name); if (i < 0) return undefined; const v = argv[i + 1]; return v && !v.startsWith('--') ? v : ''; }
function has(argv, name) { return argv.includes(name); }
const promptHashes = () => ({ arm: armPromptHash(), judge: judgePromptHash() });
const readJsonl = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** A run id / scope becomes a directory and a lock-file name: no separators, no `..` (audit R2 H1). */
function assertSafeName(label, v) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(v)) || String(v).includes('..')) throw new RunPreflightError('bad_arg', `${label} must be a plain name ([A-Za-z0-9._-], no path separators), got "${v}"`);
}

function gitSha() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Spend preflight: both provider keys, BEFORE anything is constructed or billed. */
function assertCredentials(env = process.env) {
  const missing = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'].filter((k) => !env[k]);
  if (missing.length) throw new RunPreflightError('missing_credentials', `missing ${missing.join(', ')} — the sdk arm and the cross-vendor judge both need a key; nothing was spent`);
}

function allLedgerRows(root) {
  const runs = path.join(root, 'runs');
  if (!fs.existsSync(runs)) return [];
  return fs.readdirSync(runs).flatMap((d) => readJsonl(path.join(runs, d, 'ledger.jsonl')));
}

/**
 * Pre-commit review of every artifact a run wrote (plan §2.3, M1): secret
 * shapes via the egress scanner, and private-consumer terms from the
 * gitignored env DECISION_EVAL_PRIVATE_TERMS (comma list — the terms are
 * themselves never committed). Unconfigured terms read as NOT safe, never clean.
 */
export function scanArtifacts(runDir, scan, env = process.env) {
  const terms = String(env.DECISION_EVAL_PRIVATE_TERMS || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  const secretFindings = [];
  let privateTermHits = 0;
  for (const f of fs.readdirSync(runDir)) {
    const text = fs.readFileSync(path.join(runDir, f), 'utf8');
    const r = scan(text);
    if (!r.safe) secretFindings.push({ file: f, patterns: r.patterns });
    const lower = text.toLowerCase();
    for (const t of terms) if (lower.includes(t)) privateTermHits += 1;
  }
  const privacyTermsConfigured = terms.length > 0;
  return { secretFindings, privateTermHits, privacyTermsConfigured, safeToCommit: privacyTermsConfigured && secretFindings.length === 0 && privateTermHits === 0 };
}

/**
 * One process per budget scope (plan audit R3 H2): an exclusive lock file,
 * released on any exit this process controls. A KILLED process leaves it
 * behind on purpose — the next run refuses until a human has reconciled the
 * dead run's open reservation (already charged at worst case by
 * sumScopeSpend) and removed the lock. Shared by `run` and `cross-grade`.
 */
/**
 * Persisted run evidence may only be (re)evaluated against the corpus it was produced under:
 * same corpus hash, contract epoch and prompt hashes. Refuses otherwise.
 */
function assertRunMatchesCorpus(summary, manifest) {
  const bad = [];
  if (summary.corpusSha256 !== manifest.corpusSha256) bad.push(`corpus ${String(summary.corpusSha256).slice(0, 12)} ≠ current ${manifest.corpusSha256.slice(0, 12)}`);
  if (summary.contractEpoch !== manifest.contractEpoch) bad.push(`epoch ${summary.contractEpoch} ≠ current ${manifest.contractEpoch}`);
  if (JSON.stringify(summary.promptHashes ?? null) !== JSON.stringify(manifest.promptHashes)) bad.push('prompt hashes differ');
  if (bad.length) throw new RunPreflightError('corpus_mismatch', `run ${summary.runId} was produced under a different corpus (${bad.join('; ')}) — reproduce it at its own revision`);
}

async function withScopeLock(root, budgetScope, runId, fn) {
  fs.mkdirSync(path.join(root, 'runs'), { recursive: true });
  const lockPath = path.join(root, 'runs', `.budget-${budgetScope}.lock`);
  let lockFd;
  try { lockFd = fs.openSync(lockPath, 'wx'); } catch (err) {
    if (err.code === 'EEXIST') throw new RunPreflightError('scope_locked', `${lockPath} exists — another run holds budget scope "${budgetScope}", or one crashed; reconcile its open reservation, then delete the lock`);
    throw err;
  }
  fs.writeSync(lockFd, JSON.stringify({ runId, pid: process.pid }));
  fs.closeSync(lockFd);
  try { return await fn(); } finally { fs.unlinkSync(lockPath); }
}

async function cmdFreeze(root) {
  const m = freezeManifest(path.join(root, 'corpus'), { promptHashes: promptHashes() });
  process.stdout.write(`frozen ${Object.keys(m.cases).length} case(s), corpus ${m.corpusSha256.slice(0, 12)}, epoch ${m.contractEpoch}\n`);
  return 0;
}

async function cmdRun(argv, root) {
  const phase = flag(argv, '--phase');
  if (!PHASES[phase]) throw new RunPreflightError('bad_arg', `--phase must be one of ${Object.keys(PHASES).join('|')}`);
  const capUsd = Number(flag(argv, '--cap-usd'));
  if (!Number.isFinite(capUsd) || capUsd <= 0) throw new RunPreflightError('bad_arg', '--cap-usd <positive USD> is required for any spend-bearing run');
  if (phase === 'main' && !has(argv, '--confirm-main')) throw new RunPreflightError('main_not_confirmed', 'the main comparison needs Louis\'s explicit budget approval; pass --confirm-main only once that approval exists');
  const reps = flag(argv, '--reps') !== undefined ? Number(flag(argv, '--reps')) : undefined;
  const seed = flag(argv, '--seed') !== undefined ? Number(flag(argv, '--seed')) : undefined;
  const judgeReasoningFlag = flag(argv, '--judge-reasoning');
  const runId = flag(argv, '--run-id') || phase;
  assertSafeName('--run-id', runId);
  const runDir = path.join(root, 'runs', runId);
  // One cap per budget scope across runs (rehearsal + variance share the autonomous cap).
  // The autonomous phases must NAME their scope: defaulting to the run id gives the
  // rehearsal and the variance phase separate $10 caps (audit R1 H2/H13).
  const scopeFlag = flag(argv, '--budget-scope');
  if (phase !== 'main' && !scopeFlag) throw new RunPreflightError('bad_arg', `--budget-scope <name> is required for --phase ${phase} (the rehearsal and variance phases share one cap: use "autonomous")`);
  const budgetScope = scopeFlag || runId;
  assertSafeName('--budget-scope', budgetScope);

  const { manifest, cases } = loadCorpus(path.join(root, 'corpus'), { promptHashes: promptHashes() });
  assertCredentials();

  const { createAnthropicClient } = await import('./lib/anthropic-client.mjs');
  const { createOpenAIClient } = await import('./lib/openai-client.mjs');
  const { resolveModel } = await import('./lib/model-resolver.mjs');
  const { assertEgressSafe, scanEgressPayload } = await import('./lib/sensitive-egress-gate.mjs');
  const { zodTextFormat } = await import('openai/helpers/zod');
  // redactor:null — the corpus is this public repo's own code, dense with long
  // identifiers the blanket redactor would rewrite (corrupting the very input
  // under test). assertEgressSafe on every payload is the secret gate instead.
  const anthropic = await createAnthropicClient({ backend: 'sdk', redactor: null });
  const openai = await createOpenAIClient({ purpose: 'gpt' });
  const judgeModel = resolveModel('latest-gpt', { silent: true });

  // One process per budget scope (plan audit R3 H2): an exclusive lock file,
  // released on any exit this process controls. A KILLED process leaves it
  // behind on purpose — the next run refuses until a human has reconciled the
  // dead run's open reservation (already charged at worst case by
  // sumScopeSpend) and removed the lock.
  return withScopeLock(root, budgetScope, runId, runLocked);

  async function runLocked() {
  // Everything that reads shared state happens UNDER the lock: reading the ledger
  // first let another process spend and release between the read and the lock,
  // leaving this run a stale balance (audit R1 H3/H12).
  const initialSpentUsd = sumScopeSpend(allLedgerRows(root), budgetScope);
  if (initialSpentUsd >= capUsd) throw new RunPreflightError('budget_exhausted', `budget scope "${budgetScope}" already spent $${initialSpentUsd.toFixed(4)} of $${capUsd}`);
  // Run identity = the directory, claimed atomically (non-recursive mkdir). Keying on
  // calls.jsonl missed a run stopped at the judge checkpoint (grades/ledger, no
  // calls), and a per-SCOPE lock does not exclude two scopes naming one run id
  // (audit R1 H9/H19/M4).
  try { fs.mkdirSync(runDir); } catch (err) {
    if (err.code === 'EEXIST') throw new RunPreflightError('run_exists', `${runDir} already exists — evidence is append-only; pick a new --run-id`);
    throw err;
  }
  const append = (file) => (row) => fs.appendFileSync(path.join(runDir, file), JSON.stringify(row) + '\n');
  const summary = await runDecisionEval({
    phase, runId, cases, manifest, capUsd, reps, seed, gitSha: gitSha(), budgetScope, initialSpentUsd,
    anthropic, openai, judgeModel, judgeReasoning: judgeReasoningFlag === undefined ? undefined : (judgeReasoningFlag || null),
    zodTextFormat, assertEgressSafe,
    sink: { call: append('calls.jsonl'), grade: append('grades.jsonl'), ledger: append('ledger.jsonl') },
    log: (m) => process.stderr.write(`  [decision-eval] ${m}\n`),
  });
  writeSummaryAndSheet(runDir, summary, cases);
  summary.artifactScan = scanArtifacts(runDir, scanEgressPayload);
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  process.stdout.write(oneLine(summary) + '\n');
  return summary.stop?.kind === 'BudgetStop' ? BUDGET_STOPPED_EXIT_CODE : (summary.stop ? 1 : 0);
  }
}

function writeSummaryAndSheet(runDir, summary, cases) {
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  const calls = readJsonl(path.join(runDir, 'calls.jsonl'));
  const grades = readJsonl(path.join(runDir, 'grades.jsonl'));
  const caseById = Object.fromEntries(cases.map((c) => [c.id, c]));
  const items = summary.spotSampleIds.map((gid) => {
    const r = calls.find((x) => x.gradeId === gid);
    const gs = grades.filter((g) => g.gradeId === gid && g.status === 'scored');
    return { gradeId: gid, caseId: r.caseId, question: caseById[r.caseId].question, decision: caseById[r.caseId].rubric.decision, text: r.text, judgeCorrect: gs.length === 2 && gs.every((g) => g.score.correct === true), judgeSplit: gs.length === 2 && gs[0].score.correct !== gs[1].score.correct };
  });
  fs.writeFileSync(path.join(runDir, 'spot-sample.md'), renderSpotSample(items, { runId: summary.runId }));
}

function oneLine(s) {
  const arms = Object.entries(s.perArm).map(([a, p]) => `${a}: q=${p.meanQ} s_w=${p.sw} correct=${p.correct}/${p.outputs}`).join('; ');
  return `[decision-eval] ${s.phase} ${s.runId}: run $${s.spend.runSpentUsd}, scope "${s.spend.budgetScope}" $${s.spend.scopeSpentUsd} / cap $${s.spend.capUsd}; ${arms}; controls ${s.instrument.controls.passed}/${s.instrument.controls.total}; credible=${s.instrument.credible}${s.stop ? `; STOP ${s.stop.kind}: ${s.stop.message}` : ''}`;
}

/** Rebuild summary.json purely from the persisted rows (no spend). */
async function cmdReport(argv, root) {
  const runId = flag(argv, '--run-id');
  if (!runId) throw new RunPreflightError('bad_arg', '--run-id required');
  assertSafeName('--run-id', runId);
  const runDir = path.join(root, 'runs', runId);
  const prior = JSON.parse(fs.readFileSync(path.join(runDir, 'summary.json'), 'utf8'));
  const { manifest, cases } = loadCorpus(path.join(root, 'corpus'), { promptHashes: promptHashes() });
  assertRunMatchesCorpus(prior, manifest);
  const calls = readJsonl(path.join(runDir, 'calls.jsonl'));
  const grades = readJsonl(path.join(runDir, 'grades.jsonl'));
  const ledger = readJsonl(path.join(runDir, 'ledger.jsonl'));
  // cross-grade appends its own rows (runId `<runId>-xgrade`) to this ledger: the run's spend is its own rows only.
  const ownLedger = ledger.filter((r) => r.runId === runId);
  const items = [
    ...calls.filter((r) => r.gradeId).map((r) => ({ gradeId: r.gradeId, kind: 'arm', caseId: r.caseId, rep: r.rep })),
    ...[...new Map(grades.filter((g) => g.kind !== 'arm').map((g) => [g.gradeId, { gradeId: g.gradeId, kind: g.kind, caseId: g.caseId, rep: g.rep }])).values()],
  ];
  // Pre-registered 2026-11-15T15:52Z: the two cross-vendor graders replace the human marks.
  const cross = fs.existsSync(path.join(runDir, 'cross-grades.jsonl')) ? crossEvaluation(runDir, prior, grades, cases) : null;
  const spot = cross ? { source: 'cross-grade', agreement: cross.spotAgreement, certified: cross.certified, exceptions: cross.exceptions, sampleSize: cross.sampleSize }
    : fs.existsSync(path.join(runDir, 'spot-sample.md')) ? parseSpotAgreement(fs.readFileSync(path.join(runDir, 'spot-sample.md'), 'utf8'), { expectedIds: prior.spotSampleIds }) : null;
  const d = prior.design;
  const summary = buildSummary({
    phase: prior.phase, runId, manifest, cases, arms: d.arms, reps: d.reps, seed: d.seed, effort: d.effort, maxTokens: d.maxTokens,
    judgeModel: d.judgeModel, judgeReasoning: d.judgeReasoning, gitSha: prior.gitSha, calls, grades, items,
    spentUsd: ownLedger.length ? ownLedger[ownLedger.length - 1].spentUsd : (prior.spend.scopeSpentBeforeUsd ?? 0), capUsd: prior.spend.capUsd, stop: prior.stop,
    budgetScope: prior.spend.budgetScope ?? null, scopeSpentBeforeUsd: prior.spend.scopeSpentBeforeUsd ?? 0,
    spotAgreement: spot?.agreement ?? undefined,
  });
  summary.spotAgreement = spot;
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  // Rebuilding summary.json must not drop the pre-commit artifact scan (audit R2 M2): re-run it.
  const { scanEgressPayload } = await import('./lib/sensitive-egress-gate.mjs');
  summary.artifactScan = scanArtifacts(runDir, scanEgressPayload);
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  process.stdout.write(oneLine(summary) + '\n');
  return 0;
}

async function cmdSpotAgree(argv, root) {
  const runId = flag(argv, '--run-id');
  if (!runId) throw new RunPreflightError('bad_arg', '--run-id required');
  assertSafeName('--run-id', runId);
  const runDir = path.join(root, 'runs', runId);
  // The persisted draw is the authoritative sample, not the editable worksheet (audit R3 H1/M1).
  const expectedIds = JSON.parse(fs.readFileSync(path.join(runDir, 'summary.json'), 'utf8')).spotSampleIds;
  const r = parseSpotAgreement(fs.readFileSync(path.join(runDir, 'spot-sample.md'), 'utf8'), { expectedIds });
  process.stdout.write(JSON.stringify(r) + '\n');
  return 0;
}

const CROSS_GRADERS = ['gpt', 'gemini'];

/** Cross-grader controls: every case's frozen gold and trap answers. */
function crossControls(cases) {
  return cases.flatMap((c) => [
    { gradeId: `xc-${c.id}-gold`, kind: 'control-gold', caseId: c.id, text: c.controls.gold },
    { gradeId: `xc-${c.id}-trap`, kind: 'control-trap', caseId: c.id, text: c.controls.trap },
  ]);
}

function crossEvaluation(runDir, summary, grades, cases) {
  const ev = evaluateCrossGrade({
    rows: readJsonl(path.join(runDir, 'cross-grades.jsonl')), primaryGrades: grades.filter((g) => g.kind === 'arm'),
    sampleIds: summary.spotSampleIds, graders: CROSS_GRADERS, controlIds: crossControls(cases).map((c) => c.gradeId),
  });
  const prev = fs.existsSync(path.join(runDir, 'cross-grade.json')) ? JSON.parse(fs.readFileSync(path.join(runDir, 'cross-grade.json'), 'utf8')) : {};
  // Spend, stop and the artifact scan are written by the spending run; a recompute keeps them.
  for (const k of ['spend', 'stop', 'artifactScan']) if (prev[k] !== undefined) ev[k] = prev[k];
  fs.writeFileSync(path.join(runDir, 'cross-grade.json'), JSON.stringify(ev, null, 2) + '\n');
  return ev;
}

/** Re-grade the main run's persisted spot sample with GPT + Gemini (pre-registered 2026-11-15T15:52Z). */
async function cmdCrossGrade(argv, root) {
  const runId = flag(argv, '--run-id');
  if (!runId) throw new RunPreflightError('bad_arg', '--run-id required');
  assertSafeName('--run-id', runId);
  const capUsd = Number(flag(argv, '--cap-usd'));
  if (!Number.isFinite(capUsd) || capUsd <= 0) throw new RunPreflightError('bad_arg', '--cap-usd <positive USD> is required');
  const budgetScope = flag(argv, '--budget-scope');
  if (!budgetScope) throw new RunPreflightError('bad_arg', '--budget-scope required (the scope of the main run)');
  assertSafeName('--budget-scope', budgetScope);
  if (!has(argv, '--confirm-cross-grade')) throw new RunPreflightError('bad_arg', 'cross-grade spends: pass --confirm-cross-grade');
  const runDir = path.join(root, 'runs', runId);
  const summaryPath = path.join(runDir, 'summary.json');
  if (!fs.existsSync(summaryPath)) throw new RunPreflightError('bad_arg', `${summaryPath} missing — finish the run first`);
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  if (summary.phase !== 'main') throw new RunPreflightError('bad_arg', 'cross-grade is pre-registered for the main run only');
  if (!Array.isArray(summary.spotSampleIds) || summary.spotSampleIds.length === 0) throw new RunPreflightError('bad_arg', 'summary has no spot sample');
  // Pre-registered: metered under the MAIN run's scope and cap, never a fresh scope with its own budget.
  if (budgetScope !== summary.spend?.budgetScope) throw new RunPreflightError('bad_arg', `--budget-scope "${budgetScope}" is not the main run's scope "${summary.spend?.budgetScope}"`);
  const outPath = path.join(runDir, 'cross-grades.jsonl');
  if (fs.existsSync(outPath)) throw new RunPreflightError('run_exists', `${outPath} exists — evidence is append-only`);
  const { manifest, cases } = loadCorpus(path.join(root, 'corpus'), { promptHashes: promptHashes() });
  assertRunMatchesCorpus(summary, manifest);
  // The cap is the MAIN run's approved cap, never a fresh one supplied here (focused audit R2 H1).
  if (capUsd !== summary.spend?.capUsd) throw new RunPreflightError('bad_arg', `--cap-usd ${capUsd} is not the main run's approved cap ${summary.spend?.capUsd}`);
  // Every sampled item must resolve to a persisted arm output BEFORE any credential or client is touched.
  const calls = readJsonl(path.join(runDir, 'calls.jsonl'));
  const unresolved = summary.spotSampleIds.filter((gid) => !calls.some((x) => x.gradeId === gid && typeof x.text === 'string'));
  if (unresolved.length) throw new RunPreflightError('bad_arg', `spot-sample item(s) ${unresolved.join(', ')} have no persisted arm output in calls.jsonl`);
  const missing = ['OPENAI_API_KEY', 'GEMINI_API_KEY'].filter((k) => !process.env[k]);
  if (missing.length) throw new RunPreflightError('missing_credentials', `missing ${missing.join(', ')} — nothing was spent`);

  const { createOpenAIClient } = await import('./lib/openai-client.mjs');
  const { resolveModel } = await import('./lib/model-resolver.mjs');
  const { assertEgressSafe, scanEgressPayload } = await import('./lib/sensitive-egress-gate.mjs');
  const { zodTextFormat } = await import('openai/helpers/zod');
  const { GoogleGenAI } = await import('@google/genai');
  const { zodToGeminiSchema } = await import('./lib/schemas.mjs');
  const graders = [
    { name: 'gpt', model: resolveModel('latest-gpt', { silent: true }), client: await createOpenAIClient({ purpose: 'gpt' }), maxOutputTokens: DEFAULT_JUDGE_MAX_OUTPUT_TOKENS },
    { name: 'gemini', model: resolveModel('latest-pro', { silent: true }), invoke: makeGeminiInvoker({ genai: new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }), toGeminiSchema: zodToGeminiSchema }), maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS, reasoningEffort: null },
  ];
  const sample = summary.spotSampleIds.map((gid) => { const r = calls.find((x) => x.gradeId === gid); return { gradeId: gid, kind: 'arm', caseId: r.caseId, text: r.text }; });
  const caseById = Object.fromEntries(cases.map((c) => [c.id, c]));
  const xRunId = `${runId}-xgrade`;

  return withScopeLock(root, budgetScope, xRunId, async () => {
    // Re-checked UNDER the lock: two invocations can both pass the pre-check above.
    if (fs.existsSync(outPath)) throw new RunPreflightError('run_exists', `${outPath} exists — evidence is append-only`);
    const initialSpentUsd = sumScopeSpend(allLedgerRows(root), budgetScope);
    if (initialSpentUsd >= capUsd) throw new RunPreflightError('budget_exhausted', `budget scope "${budgetScope}" already spent ${initialSpentUsd.toFixed(4)} of ${capUsd}`);
    const meter = createMeter({ capUsd, initialSpentUsd, contractEpoch: DECISION_EVAL_CONTRACT_EPOCH,
      append: (row) => fs.appendFileSync(path.join(runDir, 'ledger.jsonl'), JSON.stringify({ runId: xRunId, budgetScope, ...row }) + '\n') });
    const { stop } = await runCrossGrade({
      graders, controls: crossControls(cases), sample, caseById, meter, epoch: DECISION_EVAL_CONTRACT_EPOCH, runId: xRunId,
      zodTextFormat, assertEgressSafe, sink: (row) => fs.appendFileSync(outPath, JSON.stringify(row) + '\n'),
      log: (m) => process.stderr.write(`  [decision-eval:xgrade] ${m}\n`),
    });
    const grades = readJsonl(path.join(runDir, 'grades.jsonl'));
    const ev = crossEvaluation(runDir, summary, grades, cases);
    ev.spend = { runSpentUsd: +(meter.spentUsd - initialSpentUsd).toFixed(4), scopeSpentUsd: +meter.spentUsd.toFixed(4), capUsd, budgetScope };
    ev.stop = stop;
    fs.writeFileSync(path.join(runDir, 'cross-grade.json'), JSON.stringify(ev, null, 2) + '\n');
    ev.artifactScan = scanArtifacts(runDir, scanEgressPayload);
    fs.writeFileSync(path.join(runDir, 'cross-grade.json'), JSON.stringify(ev, null, 2) + '\n');
    const ctl = CROSS_GRADERS.map((g) => `${g} ${ev.graderControls[g].passed}/${ev.graderControls[g].graded}`).join(', ');
    process.stdout.write(`[decision-eval:xgrade] ${runId}: controls ${ctl}; exceptions ${ev.exceptions}/${ev.sampleSize}; certified=${ev.certified}; spent ${ev.spend.runSpentUsd} (scope ${ev.spend.scopeSpentUsd} / ${capUsd})${stop ? `; STOP ${stop.kind}: ${stop.message}` : ''}\n`);
    return stop?.kind === 'BudgetStop' ? BUDGET_STOPPED_EXIT_CODE : (stop ? 1 : 0);
  });
}

export async function main(argv = process.argv) {
  const sub = argv[2];
  const root = flag(argv, '--root') || DEFAULT_ROOT;
  try {
    assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'model-eval-decision', from: 3 });
    if (sub === 'freeze') return await cmdFreeze(root);
    if (sub === 'run') return await cmdRun(argv, root);
    if (sub === 'report') return await cmdReport(argv, root);
    if (sub === 'spot-agree') return await cmdSpotAgree(argv, root);
    if (sub === 'cross-grade') return await cmdCrossGrade(argv, root);
    throw new RunPreflightError('bad_arg', 'usage: model-eval-decision <freeze|run|report|spot-agree|cross-grade> [flags]');
  } catch (err) {
    if (err instanceof RunPreflightError || err?.name === 'CorpusIntegrityError' || err?.name === 'ArgvError') {
      process.stderr.write(`[decision-eval] preflight: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
}

if (isInvokedAsScript(import.meta.url)) {
  main().then((code) => finishAndExit(code), async (err) => {
    process.stderr.write(`[decision-eval] crashed: ${err?.stack || err}\n`);
    await finishAndExit(1);
  });
}
