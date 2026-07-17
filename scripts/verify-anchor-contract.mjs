#!/usr/bin/env node
/**
 * @fileoverview `verify-anchor-contract` — the MANDATORY live-provider
 * acceptance probe for the evidence-anchor path contract
 * (docs/plans/evidence-anchor-path-contract.md §9a, Phase 7).
 *
 * WHY THIS EXISTS (and why a green `npm test` is not a substitute): static
 * tests can prove our schema is refinement-free and that
 * `makeProducerFindingV3Schema` narrows `diffPathId` to an enum. They CANNOT
 * prove that a live *provider* honours that enum. The bug this plan fixes
 * lived under a green suite for weeks; this script is the ship gate that a
 * green suite could never be.
 *
 * WHAT IS REAL HERE (the seam under test — 100% production code, no fakes):
 *   committed diff → `buildDiffPathMap` (+ its sensitive-path filtering)
 *   → `renderDiffPathTable` → `makeProducerFindingV3Schema` (the enum)
 *   → `readFilesAsContext`/`redactSecrets` (the real payload + egress path)
 *   → a LIVE provider call with the real tool/response schema
 *   → `prepareCandidates` (the untrusted producer boundary)
 *   → `runStage0EvidenceTriage` → the counters this script grades.
 * The probe never constructs its own payload: it hands `runTieredAuditPipeline`
 * a ctx and lets production assemble, redact and send it. If it built its own
 * prompt it would stop testing the real seam and the whole probe would be
 * theatre (§9a).
 *
 * WHAT IS DELIBERATELY NOT EXERCISED: Stage 1 and Stage 2. EVERY acceptance
 * counter is frozen before Stage 1 starts, so real triage/adjudication calls
 * would add cost, latency and failure modes strictly downstream of the thing
 * under test — a Gemini outage must never turn a demonstrated acceptance into
 * "could not run". Both are injected `providers.*` adapters (the pipeline's
 * own documented injection seam), so they are no-ops here and say so in the
 * evidence file. This is scope, not stubbing-out-the-test: nothing the probe
 * grades is downstream of them.
 *
 * FIXTURE: a COMMITTED revision, never the working tree. An uncommitted tree
 * makes the result unreproducible and drags unrelated files into the payload —
 * the exact confound that broke a real run on 2026-07-17.
 *
 * EXIT SEMANTICS (load-bearing — the anti-green rule):
 *   0 — acceptance MET for every requested generator.
 *   1 — acceptance FAILED (counters present, criteria unmet).
 *   2 — COULD NOT RUN (provider unavailable, bad rev, incomplete run).
 * `2` is NEVER conflated with `0`: "couldn't check" must never read as
 * "checked and clean".
 *
 * Usage:
 *   node scripts/verify-anchor-contract.mjs [--rev <sha>] [--generator sonnet|glm|all]
 *                                           [--json] [--out <file>]
 *
 * `--out` has no default on purpose: the evidence artefact is Category A
 * (derived from live provider state, carries timestamps) and must land on a
 * gitignored path the caller chooses — this script will not silently create
 * one.
 *
 * @module scripts/verify-anchor-contract
 */

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runTieredAuditPipeline, TieredUnavailableError } from './lib/audit/tiered-pipeline.mjs';
import { filterDiffFiles, formatSkipLog } from './lib/sensitive-paths.mjs';
import { isSafeGitRevision, exitCodeFor } from './lib/vcs.mjs';
import { createAnthropicClient } from './lib/anthropic-client.mjs';
import { createOpenAIClient } from './lib/openai-client.mjs';
import { ossStructuredCall } from './lib/oss-structured-output.mjs';
import { resolveModel } from './lib/model-resolver.mjs';
import { auditShadowConfig, tieredAuditConfig } from './lib/config.mjs';
import { atomicWriteFileSync } from './lib/file-io.mjs';
import { findRepoRootFromScript } from './lib/assert-repo-root.mjs';

/**
 * The pinned known-good fixture revision (§9a: "a pinned known-good sha
 * recorded in the script; `--rev` overrides").
 *
 * Chosen because it is small (3 files), is real security-relevant code rather
 * than prose, and its files still resolve on disk. NOTE the inherent drift:
 * production assembles the payload from the CURRENT working-tree content of
 * the changed files (`readFilesAsContext` reads disk, by design — the probe
 * must not fork that path), while the diff-path table comes from the pinned
 * rev. That is tolerable — a quote taken from current content still verifies
 * head-side (`outside_hunk_in_head`) — but if this rev's files drift far
 * enough that the generator can no longer produce a verifiable quote, repin
 * rather than weakening the acceptance criteria.
 */
const DEFAULT_FIXTURE_REV = 'cee4448';

/** The generators §9a's acceptance must cover. A sonnet-only pass is NOT acceptance (R1/H4). */
const GENERATORS = Object.freeze(['sonnet', 'glm']);

/**
 * The three acceptance criteria, named so the evidence file records WHICH one
 * failed rather than just that something did.
 *
 * `discoveryContradictedRaw` is deliberately absent: a claim the diff
 * disproves is the MODEL's evidence failure, working as designed — billing it
 * to our contract would be this plan's own misattribution running backwards.
 */
const ACCEPTANCE_CRITERIA = Object.freeze([
  { counter: 'stage0Verified', test: (n) => n > 0, expectation: '> 0' },
  { counter: 'discoveryMalformedRaw', test: (n) => n === 0, expectation: '=== 0' },
  { counter: 'stage0MalformedTripwire', test: (n) => n === 0, expectation: '=== 0' },
]);

/** @param {string} name @param {string|null} dflt */
function argOption(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  const next = i >= 0 ? process.argv[i + 1] : undefined;
  return next !== undefined && !next.startsWith('--') ? next : dflt;
}

// ── Acceptance grading (pure — the seam the hermetic tests drive) ──────────

/**
 * Grade ONE generator's probe outcome against §9a's criteria.
 *
 * An absent or non-numeric counter is `could_not_run`, NEVER a silent 0 — a
 * missing counter reading as "0 malformed, therefore clean" is precisely the
 * anti-green class this plan exists to kill.
 *
 * @param {{generator: string, status: string, counters?: object|null, reason?: string}} result
 * @returns {{generator: string, outcome: 'accepted'|'failed'|'could_not_run', reason?: string, failedCriteria?: string[], counters?: object|null}}
 */
export function gradeGeneratorResult(result) {
  const generator = result?.generator ?? 'unknown';
  if (result?.status !== 'ok') {
    return { generator, outcome: 'could_not_run', reason: result?.reason || 'unknown reason', counters: result?.counters ?? null };
  }
  const counters = result.counters;
  if (!counters || typeof counters !== 'object') {
    return { generator, outcome: 'could_not_run', reason: 'counters_absent: the run reported no _stageBreakdown', counters: null };
  }
  const missing = ACCEPTANCE_CRITERIA
    .filter((c) => !Number.isFinite(counters[c.counter]))
    .map((c) => c.counter);
  if (missing.length > 0) {
    return {
      generator,
      outcome: 'could_not_run',
      reason: `counters_incomplete: ${missing.join(', ')} absent or non-numeric — an unread counter must never grade as 0`,
      counters,
    };
  }
  const failedCriteria = ACCEPTANCE_CRITERIA
    .filter((c) => !c.test(counters[c.counter]))
    .map((c) => `${c.counter} ${c.expectation} (was ${counters[c.counter]})`);
  return failedCriteria.length === 0
    ? { generator, outcome: 'accepted', counters }
    : { generator, outcome: 'failed', failedCriteria, counters };
}

/**
 * The three-way exit contract over every requested generator.
 *
 * Precedence — a definite FAILURE (1) outranks a COULD-NOT-RUN (2): both are
 * non-zero (the anti-green rule holds either way), and a real, actionable
 * contract violation is the more useful signal to surface. Zero requires
 * every requested generator to be `accepted`; an empty request list is
 * `could_not_run`, never a vacuous pass.
 *
 * @param {Array<{generator: string, status: string, counters?: object|null, reason?: string}>} results
 * @returns {{exitCode: 0|1|2, verdict: 'accepted'|'failed'|'could_not_run', perGenerator: Array<object>}}
 */
export function evaluateAcceptance(results) {
  const perGenerator = (Array.isArray(results) ? results : []).map(gradeGeneratorResult);
  if (perGenerator.length === 0) {
    return { exitCode: 2, verdict: 'could_not_run', perGenerator };
  }
  if (perGenerator.some((g) => g.outcome === 'failed')) {
    return { exitCode: 1, verdict: 'failed', perGenerator };
  }
  if (perGenerator.some((g) => g.outcome === 'could_not_run')) {
    return { exitCode: 2, verdict: 'could_not_run', perGenerator };
  }
  return { exitCode: 0, verdict: 'accepted', perGenerator };
}

/**
 * Resolve `--generator` to the list to probe.
 * @param {string|null} raw
 * @returns {{ok: true, generators: string[]} | {ok: false, message: string}}
 */
export function parseGeneratorArg(raw) {
  const value = (raw ?? 'all').trim();
  if (value === 'all') return { ok: true, generators: [...GENERATORS] };
  if (GENERATORS.includes(value)) return { ok: true, generators: [value] };
  return { ok: false, message: `--generator must be one of: ${[...GENERATORS, 'all'].join(' | ') } (got ${JSON.stringify(value)})` };
}

// ── The committed fixture ─────────────────────────────────────────────────

/**
 * Run one git command, classifying failure into a VcsErrorCode-shaped error.
 *
 * NOTE (reported, not papered over): `vcs.mjs` exposes no committed-rev
 * unified-diff primitive — `gitDiffWithWorkingTree` is name-status only AND
 * working-tree-inclusive, which is exactly what §9a's fixture rule forbids.
 * So this is a probe-local read using vcs.mjs's vocabulary (`isSafeGitRevision`
 * to validate, VcsErrorCode names to classify, `exitCodeFor` recorded in the
 * evidence) rather than a new shared primitive, which would land outside this
 * phase's file scope.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @param {string} [wantedRev]
 * @returns {{ok: true, stdout: string} | {ok: false, error: {code: string, message: string}}}
 */
function runGit(args, cwd, wantedRev) {
  let res;
  try {
    res = spawnSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return { ok: false, error: { code: 'EXEC_FAILED', message: err?.message || String(err) } };
  }
  if (res.error) {
    const code = res.error.code === 'ENOENT' ? 'GIT_BINARY_MISSING' : 'EXEC_FAILED';
    return { ok: false, error: { code, message: res.error.message } };
  }
  if (res.status !== 0) {
    const stderr = String(res.stderr || '').trim();
    if (/not a git repository/i.test(stderr)) return { ok: false, error: { code: 'NOT_A_GIT_REPOSITORY', message: stderr.slice(0, 200) } };
    // `Needed a single revision` is git's message for an unresolvable
    // `rev-parse --verify <sha>` — vcs.mjs's own classifier does not match it
    // either, so a nonexistent sha classified as WORKING_TREE_UNREADABLE
    // rather than BAD_REVISION. Both exit 2 here, so it is a diagnosis bug,
    // not a verdict bug; it is still worth naming correctly in the evidence.
    if (/unknown revision|bad revision|ambiguous argument|needed a single revision/i.test(stderr)) {
      return { ok: false, error: { code: 'BAD_REVISION', message: `git did not resolve ${wantedRev ?? args.join(' ')}: ${stderr.slice(0, 160)}` } };
    }
    return { ok: false, error: { code: 'WORKING_TREE_UNREADABLE', message: stderr.slice(0, 200) || 'git command failed' } };
  }
  return { ok: true, stdout: res.stdout || '' };
}

/**
 * Load the fixture for a COMMITTED rev: the `<rev>~1..<rev>` unified diff, the
 * changed-file list (sensitive-filtered through the canonical
 * `filterDiffFiles`), and the commit message as the run's `planContent`.
 *
 * `planContent` is the commit's own message rather than a pinned plan file: it
 * is what the change was *supposed* to do, it is derivable from `--rev` alone
 * (no second pin, no doc that can be archived out from under the probe), and
 * production redacts it on the same path regardless.
 *
 * @param {string} repoRoot
 * @param {string} rev
 * @returns {{ok: true, fixture: object} | {ok: false, error: {code: string, message: string}}}
 */
function loadCommittedFixture(repoRoot, rev) {
  const shaRes = runGit(['rev-parse', '--verify', `${rev}^{commit}`], repoRoot, rev);
  if (!shaRes.ok) return shaRes;
  const headSha = shaRes.stdout.trim();

  const baseRes = runGit(['rev-parse', '--verify', `${rev}~1^{commit}`], repoRoot, `${rev}~1`);
  if (!baseRes.ok) return baseRes;
  const baseSha = baseRes.stdout.trim();

  const diffRes = runGit(['diff', baseSha, headSha], repoRoot, rev);
  if (!diffRes.ok) return diffRes;
  if (!diffRes.stdout.trim()) {
    return { ok: false, error: { code: 'BAD_REVISION', message: `${rev} produced an empty diff — not a usable fixture` } };
  }

  const nameStatus = runGit(['diff', '--name-status', baseSha, headSha], repoRoot, rev);
  if (!nameStatus.ok) return nameStatus;

  // A DiffShape ({added, modified, deleted, untracked, renamed}) — the same
  // shape `filterDiffFiles` consumes, so the probe's changed-file list passes
  // the canonical sensitive-path gate rather than a hand-rolled one.
  // `untracked` is empty BY CONSTRUCTION: this is a committed rev, not the
  // working tree (§9a).
  const shape = { added: [], modified: [], deleted: [], untracked: [], renamed: [] };
  for (const line of nameStatus.stdout.split('\n')) {
    const m = line.match(/^([AMDR])\d*\s+(.+?)(?:\s+(.+))?$/);
    if (!m) continue;
    if (m[1] === 'A') shape.added.push(m[2]);
    else if (m[1] === 'M') shape.modified.push(m[2]);
    else if (m[1] === 'D') shape.deleted.push(m[2]);
    else if (m[1] === 'R') shape.renamed.push({ from: m[2], to: m[3] });
  }

  const { diff: safeShape, skipped } = filterDiffFiles(shape, ['sensitive']);
  // Deleted paths are excluded: they do not exist to be read, and production's
  // changed-file list is a read list. They remain in `diffText`, so the
  // diff-path table (and therefore the enum) still carries them.
  const changedFiles = [...safeShape.added, ...safeShape.modified, ...safeShape.renamed.map((r) => r.to)];

  const msgRes = runGit(['log', '-1', '--format=%B', headSha], repoRoot, rev);
  if (!msgRes.ok) return msgRes;

  return {
    ok: true,
    fixture: {
      rev, headSha, baseSha,
      diffText: diffRes.stdout,
      changedFiles,
      planContent: msgRes.stdout.trim(),
      skipped,
    },
  };
}

// ── Provider wiring ───────────────────────────────────────────────────────

/**
 * A silenced Anthropic handle: a well-formed, EMPTY `report_findings` tool
 * call. Used when Sonnet is not the generator under test, so every raw finding
 * in the run is attributable to the generator that IS — the pipeline's
 * discovery portfolio always fans out to both required generators and tags
 * nothing with its source, so per-generator counters are only obtainable by
 * isolating one generator per run.
 */
const silencedAnthropicClient = {
  messages: {
    create: async () => ({
      content: [{ type: 'tool_use', name: 'report_findings', input: { findings: [] } }],
      stop_reason: 'tool_use',
    }),
  },
};

// Both are FACTORIES, not shared literals: `providers.ossCall` is invoked once
// per candidate, and handing every caller the same object reference would let
// one consumer's mutation leak into the next call's "response".

/** Stage 1's triager contract, answered deterministically — no dismissal, so every candidate escalates. */
const stage1NoOp = () => ({ result: { dismissalAttempted: false, disproof: null }, category: null, error: null });

/** The GLM discovery generator, silenced (see `silencedAnthropicClient`). */
const silencedGlmDiscovery = () => ({ result: { findings: [] }, category: null, error: null });

/**
 * Build the provider handles for one probe run: REAL for the generator under
 * test, silenced for the other, deterministic no-ops for everything strictly
 * downstream of the acceptance counters.
 *
 * @param {string} generator - 'sonnet' | 'glm'
 * @returns {Promise<object>} ctx.providers
 */
async function buildProbeProviders(generator) {
  // Forced `backend: 'sdk'` — NOT the ambient CLAUDE_BACKEND. The Sonnet
  // generator needs `tool_choice`, which the cli backend silently drops
  // (AGENTS.md's forced-tool-calling gotcha; the same reason
  // buildAuditRunContext forces it). A probe that inherited the ambient
  // backend would measure the 2026-07-14 incident, not the enum contract.
  const anthropicClient = generator === 'sonnet'
    ? await createAnthropicClient({ backend: 'sdk' })
    : silencedAnthropicClient;

  let ossCall;
  if (generator === 'glm') {
    const ossClient = await createOpenAIClient({
      oss: { baseURL: auditShadowConfig.openrouterBaseUrl, apiKey: auditShadowConfig.openrouterApiKey },
    });
    // Operation-aware: `providers.ossCall` serves BOTH the GLM discovery
    // generator and the Stage 1 triager. Only the former is under test.
    ossCall = (opts) => (opts?.operation === 'discovery_generation'
      ? ossStructuredCall(ossClient, opts)
      : Promise.resolve(stage1NoOp()));
  } else {
    ossCall = (opts) => Promise.resolve(opts?.operation === 'discovery_generation' ? silencedGlmDiscovery() : stage1NoOp());
  }

  return {
    openai: null, // unreachable: `ossCall` is always present, so Stage 1 never takes the GPT default path
    anthropicClient,
    ossCall,
    // Stage 2 — downstream of every counter this probe grades (see the file
    // header). Deterministic pass-throughs, not adjudication.
    geminiReviewCall: async () => ({ verdict: 'verified', rationale: 'probe no-op: Stage 2 is not exercised by the anchor-contract probe' }),
    geminiCleanRegionCall: async () => ({ verdict: 'clean' }),
  };
}

/**
 * Probe ONE generator end-to-end through the real pipeline.
 *
 * @param {string} generator
 * @param {object} fixture
 * @returns {Promise<{generator: string, status: 'ok'|'could_not_run', counters?: object|null, reason?: string, models: object, runStatus?: string, generatorOutcomes?: object[]}>}
 */
async function probeGenerator(generator, fixture) {
  const models = {
    sonnet: resolveModel('latest-sonnet'),
    glm: tieredAuditConfig.discoveryModel,
  };
  const modelUnderTest = models[generator];

  let providers;
  try {
    providers = await buildProbeProviders(generator);
  } catch (err) {
    return { generator, status: 'could_not_run', reason: `provider_unavailable: ${err?.message || String(err)}`, models, modelUnderTest };
  }

  const ctx = {
    providers,
    planContent: fixture.planContent,
    projectContext: '',
    historyContext: '',
    diffText: fixture.diffText,
    changedFiles: fixture.changedFiles,
    commitSha: fixture.headSha,
    auditBaseCommit: fixture.baseSha,
    // The tree is not the fixture: HEAD-derived blame/import-graph freshness
    // cannot describe a past rev, so both adapters correctly degrade to their
    // safe 'unknown' default instead of asserting something they can't know.
    workingTreeDirty: true,
    round: 1,
    runId: `anchor-probe-${generator}-${Date.now()}`,
    bandit: null,
    generatorOutcomes: [],
    // The same "this is not the real run" flag set `buildShadowCtx` uses: every
    // stateful write path off, and — load-bearing — `shadowMode: true` so a
    // required-generator failure throws `TieredUnavailableError` instead of
    // silently burning a full legacy GPT audit and returning legacy findings
    // labelled as a tiered result.
    ledgerFile: null,
    noLedger: true,
    noDebtLedger: true,
    readOnlyDebt: true,
    noCloudRecording: true,
    shadowMode: true,
  };

  try {
    const result = await runTieredAuditPipeline(ctx);
    if (result.runStatus !== 'complete') {
      // Only a `complete` run's counters are decision-grade. A skipped/failed
      // run reports zeros because nothing happened, not because nothing was
      // wrong — grading those zeros is the vacuous-"met" reading that has
      // already burned this pipeline's shadow window three times.
      return {
        generator, status: 'could_not_run', models, modelUnderTest,
        runStatus: result.runStatus,
        reason: `run_incomplete: runStatus=${result.runStatus}${result.fallbackReason ? ` — ${result.fallbackReason}` : ''}`,
        counters: result._stageBreakdown ?? null,
        generatorOutcomes: result.generatorOutcomes,
      };
    }
    return {
      generator, status: 'ok', models, modelUnderTest,
      runStatus: result.runStatus,
      counters: result._stageBreakdown,
      generatorOutcomes: result.generatorOutcomes,
    };
  } catch (err) {
    const kind = err instanceof TieredUnavailableError ? 'tiered_unavailable' : 'pipeline_threw';
    return { generator, status: 'could_not_run', reason: `${kind}: ${err?.message || String(err)}`, models, modelUnderTest };
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────

function renderHuman(evaluation, evidence) {
  const lines = [];
  lines.push(`Anchor-contract acceptance probe — rev ${evidence.rev} (${evidence.headSha.slice(0, 8)})`);
  for (const g of evaluation.perGenerator) {
    const run = evidence.runs.find((r) => r.generator === g.generator) || {};
    const head = `  ${g.generator} (${run.modelUnderTest ?? 'unresolved'}): ${g.outcome.toUpperCase()}`;
    lines.push(head);
    if (g.counters) {
      lines.push(`    raw=${g.counters.discoveryRawFindings} malformedRaw=${g.counters.discoveryMalformedRaw} `
        + `contradictedRaw=${g.counters.discoveryContradictedRaw} stage0Verified=${g.counters.stage0Verified} `
        + `stage0MalformedTripwire=${g.counters.stage0MalformedTripwire}`);
    }
    if (g.failedCriteria) lines.push(`    unmet: ${g.failedCriteria.join('; ')}`);
    if (g.reason) lines.push(`    reason: ${g.reason}`);
  }
  lines.push(`VERDICT: ${evaluation.verdict} (exit ${evaluation.exitCode})`);
  if (evaluation.exitCode === 2) lines.push('  NOTE: exit 2 means COULD NOT RUN — this is NOT a pass.');
  return lines.join('\n');
}

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  const jsonMode = process.argv.includes('--json');
  const outFile = argOption('out', null);
  const rev = argOption('rev', DEFAULT_FIXTURE_REV);

  const generatorArg = parseGeneratorArg(argOption('generator', 'all'));
  if (!generatorArg.ok) {
    process.stderr.write(`${generatorArg.message}\n`);
    process.exit(2); // could not run — never a pass
  }

  if (!isSafeGitRevision(rev)) {
    process.stderr.write(`refusing unsafe --rev: ${JSON.stringify(rev).slice(0, 80)}\n`);
    process.exit(2);
  }

  const repoRoot = findRepoRootFromScript(import.meta.url);
  const fixtureResult = loadCommittedFixture(repoRoot, rev);
  if (!fixtureResult.ok) {
    // Every VCS failure is COULD-NOT-RUN (exit 2), NOT `vcs.exitCodeFor`'s
    // code: that map (1/4/5/127) predates and collides with this script's
    // three-way contract — `EXEC_FAILED → 1` would read as "acceptance FAILED,
    // counters present", which is a lie. The VcsErrorCode and its
    // `exitCodeFor` value are recorded in the evidence for diagnosis instead.
    const { code, message } = fixtureResult.error;
    process.stderr.write(`could not load fixture ${rev}: [${code}] ${message}\n`);
    if (outFile) {
      atomicWriteFileSync(outFile, JSON.stringify({
        schemaVersion: 1, generatedAt: new Date().toISOString(), rev,
        verdict: 'could_not_run', exitCode: 2,
        fixtureError: { code, message, vcsExitCodeFor: exitCodeFor(code) },
        runs: [],
      }, null, 2));
    }
    process.exit(2);
  }

  const { fixture } = fixtureResult;
  for (const line of formatSkipLog(fixture.skipped, { logger: 'anchor-probe-fixture' })) process.stderr.write(`  ${line}\n`);
  process.stderr.write(`  [anchor-probe] fixture ${rev} → ${fixture.headSha.slice(0, 8)} (base ${fixture.baseSha.slice(0, 8)}), `
    + `${fixture.changedFiles.length} changed file(s), generators: ${generatorArg.generators.join(', ')}\n`);

  const results = [];
  for (const generator of generatorArg.generators) {
    process.stderr.write(`  [anchor-probe] probing ${generator}…\n`);
    // Sequential, not Promise.all: two concurrent runs interleave their
    // stderr contract-bug reports, which are the human-readable half of this
    // probe's evidence.
    results.push(await probeGenerator(generator, fixture));
  }

  const evaluation = evaluateAcceptance(results);
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    rev: fixture.rev,
    headSha: fixture.headSha,
    baseSha: fixture.baseSha,
    changedFiles: fixture.changedFiles,
    criteria: ACCEPTANCE_CRITERIA.map((c) => `${c.counter} ${c.expectation}`),
    // Recorded so the acceptance claim names the model that made it — a
    // sentinel that resolves elsewhere tomorrow must not silently inherit
    // today's verdict.
    resolvedModels: results.length > 0 ? results[0].models : null,
    notExercised: ['stage1_triage', 'stage2_adjudication'],
    verdict: evaluation.verdict,
    exitCode: evaluation.exitCode,
    runs: results.map((r) => ({
      generator: r.generator,
      modelUnderTest: r.modelUnderTest,
      status: r.status,
      runStatus: r.runStatus ?? null,
      reason: r.reason ?? null,
      counters: r.counters ?? null,
      generatorOutcomes: r.generatorOutcomes ?? [],
      otherGeneratorSilenced: GENERATORS.filter((g) => g !== r.generator),
    })),
    perGenerator: evaluation.perGenerator,
  };

  if (outFile) atomicWriteFileSync(outFile, JSON.stringify(evidence, null, 2));
  console.log(jsonMode ? JSON.stringify(evidence, null, 2) : renderHuman(evaluation, evidence));
  process.exit(evaluation.exitCode);
}

// CLI entry — only fire main() when executed directly, never when a test
// imports this module for its exported pure graders. Mirrors
// tiered-shadow-report.mjs's pathToFileURL guard (Windows drive-letter
// robustness); the same guard's absence there once turned an import into a
// live cloud query using the test runner's own argv.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`verify-anchor-contract: ${err?.stack || err}\n`);
    process.exit(2); // an unexpected crash is COULD-NOT-RUN, never a pass
  });
}
