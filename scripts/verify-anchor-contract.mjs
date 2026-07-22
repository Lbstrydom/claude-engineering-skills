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
 *                                           [--runs <n>] [--json] [--out <file>]
 *
 * ACCEPTANCE IS A RATE, NOT A ZERO (§9a, corrected 2026-07-17): each generator
 * is probed `--runs` times (default 3) and graded on the AGGREGATE — a single
 * provider-emitted DTO our Zod rejects is expected variance (D6: the enum is a
 * funnel, not a trust boundary), so a per-run `=== 0` recreates the flake this
 * correction removed. The gated criteria are `stage0Verified > 0` on every run,
 * `sum(malformedRaw)/sum(rawFindings) < 0.34` aggregate, and
 * `sum(malformedTripwire) === 0`. `discoveryContradictedRaw` is reported, never
 * gated (the model's evidence error, working as designed).
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
import { argOption } from './lib/cli-io.mjs';

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
 * The acceptance criteria — a RATE, not a zero (§9a, "corrected 2026-07-17, by
 * running it"). The draft's per-run `discoveryMalformedRaw === 0` was refuted
 * empirically: the same fixture flaked 1-raw/1-malformed (exit 1) then
 * 5-raw/0-malformed (exit 0). D6 says the enum is a funnel, not a trust
 * boundary, so an occasional provider-emitted DTO our Zod rejects is *expected
 * variance*, not a contract break. A per-run `=== 0` recreates that flake.
 *
 * So the grade is AGGREGATE across n runs (default 3):
 *   - `stage0Verified > 0` — required on EVERY run (the literal 1-of-62 defect;
 *     a run that verified nothing is the failure this whole plan exists to catch).
 *   - `sum(discoveryMalformedRaw) / sum(discoveryRawFindings) < 0.34` — aggregate;
 *     catches a SYSTEMATIC break (the real bug was ~100%) while tolerating
 *     single-field variance. Divide-by-zero is impossible-by-construction here:
 *     total raw 0 ⇒ nothing verified ⇒ the per-run `stage0Verified > 0` check
 *     already fails, so the rate is never computed on 0/0 (0/0 is NOT "clean").
 *   - `sum(stage0MalformedTripwire) === 0` — post-hydration this class is
 *     unreachable by construction; a non-zero means hydration regressed —
 *     genuinely binary.
 *
 * `discoveryContradictedRaw` is deliberately NOT graded: a claim the diff
 * disproves is the MODEL's evidence failure, working as designed — billing it
 * to our contract would be this plan's own misattribution running backwards.
 */
const MALFORMED_RATE_CEILING = 0.34;

/**
 * Counters that MUST be finite on a usable run. An absent/non-numeric one makes
 * the whole generator `could_not_run` (never a silent 0) — the anti-green rule.
 * `discoveryRawFindings` is here (not gated on its own) because the aggregate
 * rate's denominator needs it.
 */
const REQUIRED_COUNTERS = Object.freeze([
  'stage0Verified', 'discoveryRawFindings', 'discoveryMalformedRaw', 'stage0MalformedTripwire',
]);

/** Human-readable rendering of the criteria for the evidence file. */
const ACCEPTANCE_CRITERIA_DESC = Object.freeze([
  'stage0Verified > 0 (every run)',
  `sum(discoveryMalformedRaw) / sum(discoveryRawFindings) < ${MALFORMED_RATE_CEILING} (aggregate)`,
  'sum(stage0MalformedTripwire) === 0 (aggregate)',
]);

/** §9a: the rate criterion needs "n ≥ 3 runs" to distinguish a systematic break
 *  from single-field variance. 3 is the default sample size. */
const DEFAULT_RUNS = 3;

// ── Acceptance grading (pure — the seam the hermetic tests drive) ──────────

/**
 * Reduce ONE probe run to a decision-grade summary: usable (with finite
 * counters) or not-usable (with the reason it cannot be graded).
 *
 * A non-`ok` status, absent counters, or any REQUIRED counter that is
 * absent/non-numeric all make the run unusable — an unread counter must NEVER
 * grade as a silent 0. A single unusable run makes the whole generator
 * `could_not_run`: you cannot compute an aggregate rate from a run that did
 * not happen, and a partial sample must never read as `accepted`.
 *
 * @param {{status?: string, counters?: object|null, reason?: string}} run
 * @param {number} index
 * @returns {{index: number, usable: boolean, counters?: object, status?: string, reason?: string}}
 */
function summariseRun(run, index) {
  const status = run?.status ?? 'unknown';
  if (status !== 'ok') {
    return { index, usable: false, status, reason: run?.reason || `run ${index}: status=${status}`, counters: run?.counters ?? null };
  }
  const counters = run?.counters;
  if (!counters || typeof counters !== 'object') {
    return { index, usable: false, status, reason: `run ${index}: counters_absent — the run reported no _stageBreakdown`, counters: null };
  }
  const missing = REQUIRED_COUNTERS.filter((c) => !Number.isFinite(counters[c]));
  if (missing.length > 0) {
    return { index, usable: false, status, reason: `run ${index}: counters_incomplete: ${missing.join(', ')} absent or non-numeric — an unread counter must never grade as 0`, counters };
  }
  // A run that produced NO findings never exercised the contract, so it cannot
  // grade it either way (corrected 2026-07-18, by running it: Sonnet-5 AND
  // GLM-5.2 both returned 0 findings 3/3 on the pinned fixture — a hardening
  // commit that is simply clean; payload verified healthy at 63KB diff / 24KB
  // code / map `ready`).
  //
  // Grading that as `failed` would assert "our contract is broken" from an
  // outcome that is a property of the MODEL and the FIXTURE — the exact
  // misattribution this whole plan exists to eliminate (§1: `fabricated`
  // silently absorbing every contract mismatch), merely pointed the other way.
  // It would send a future engineer hunting a defect that does not exist.
  //
  // `could_not_run` is the honest bucket and is still EXIT 2 — non-zero, so
  // "couldn't check" can never read as clean (§9a's anti-green rule). The
  // no-findings case is un-exercised, not unclean.
  if (counters.discoveryRawFindings === 0) {
    return { index, usable: false, status, counters, reason: `run ${index}: contract_not_exercised — the generator produced 0 findings on this fixture, so the anchor contract was never exercised (not a contract failure; pick a fixture with known findable defects)` };
  }
  return { index, usable: true, status, counters };
}

/**
 * Grade ONE generator's n probe runs against §9a's RATE-not-a-zero table.
 *
 * This is the pure, hermetic-test seam. It takes the array of per-run results
 * (each `{status, counters, reason}` from `probeGenerator`) and applies the
 * aggregate criteria; the hermetic tests inject fake multi-run counter arrays
 * here rather than mocking a provider (AGENTS.md Tier-2).
 *
 * @param {string} generator
 * @param {Array<{status?: string, counters?: object|null, reason?: string}>} runs
 * @returns {{generator: string, outcome: 'accepted'|'failed'|'could_not_run', reason?: string, failedCriteria?: string[], aggregate?: object, runs: object[]}}
 */
export function gradeGeneratorRuns(generator, runs) {
  const gen = generator ?? 'unknown';
  const runList = Array.isArray(runs) ? runs : [];
  if (runList.length === 0) {
    return { generator: gen, outcome: 'could_not_run', reason: 'no_runs: the generator was requested but never executed', runs: [] };
  }

  const perRun = runList.map(summariseRun);
  const notUsable = perRun.filter((r) => !r.usable);
  if (notUsable.length > 0) {
    // Any un-gradeable run sinks the whole generator to could_not_run — never
    // a vacuous pass on a partial sample.
    return {
      generator: gen,
      outcome: 'could_not_run',
      reason: `${notUsable.length}/${perRun.length} run(s) not gradeable — ${notUsable[0].reason}`,
      runs: perRun,
    };
  }

  const totalRaw = perRun.reduce((s, r) => s + r.counters.discoveryRawFindings, 0);
  const totalMalformed = perRun.reduce((s, r) => s + r.counters.discoveryMalformedRaw, 0);
  const totalTripwire = perRun.reduce((s, r) => s + r.counters.stage0MalformedTripwire, 0);
  const totalVerified = perRun.reduce((s, r) => s + r.counters.stage0Verified, 0);
  const totalContradicted = perRun.reduce((s, r) => s + (Number(r.counters.discoveryContradictedRaw) || 0), 0);

  const failedCriteria = [];

  // 1. stage0Verified > 0 on EVERY run (the literal 1-of-62 defect).
  const zeroVerified = perRun.filter((r) => !(r.counters.stage0Verified > 0)).map((r) => r.index);
  if (zeroVerified.length > 0) {
    failedCriteria.push(`stage0Verified > 0 required every run (was 0 on run(s): ${zeroVerified.join(', ')})`);
  }

  // 2. Aggregate malformed RATE < ceiling. Divide-by-zero guard RETAINED as
  //    defence in depth: a zero-raw run is now un-gradeable upstream
  //    (`contract_not_exercised`), so totalRaw === 0 is unreachable here — but
  //    if that ever regresses, 0/0 must still never read as a clean rate.
  let malformedRate = null;
  if (totalRaw > 0) {
    malformedRate = totalMalformed / totalRaw;
    if (!(malformedRate < MALFORMED_RATE_CEILING)) {
      failedCriteria.push(`sum(discoveryMalformedRaw)/sum(discoveryRawFindings) < ${MALFORMED_RATE_CEILING} (was ${totalMalformed}/${totalRaw} = ${malformedRate.toFixed(3)})`);
    }
  }

  // 3. Aggregate tripwire sum === 0 — a hydration regression signal, binary.
  if (totalTripwire !== 0) {
    failedCriteria.push(`sum(stage0MalformedTripwire) === 0 (was ${totalTripwire})`);
  }

  const aggregate = {
    runs: perRun.length,
    totalRawFindings: totalRaw,
    totalMalformedRaw: totalMalformed,
    malformedRate,                 // null when totalRaw === 0 (see divide-by-zero guard)
    malformedRateCeiling: MALFORMED_RATE_CEILING,
    totalStage0Verified: totalVerified,
    totalStage0MalformedTripwire: totalTripwire,
    totalContradictedRaw: totalContradicted, // reported, never gates
  };

  return failedCriteria.length === 0
    ? { generator: gen, outcome: 'accepted', aggregate, runs: perRun }
    : { generator: gen, outcome: 'failed', failedCriteria, aggregate, runs: perRun };
}

/**
 * The three-way exit contract over every requested generator.
 *
 * Input is grouped by generator — `[{generator, runs: [...]}, …]` — because
 * §9a's malformed criterion is an AGGREGATE across a generator's runs, not a
 * per-run test. Each group is graded by `gradeGeneratorRuns`.
 *
 * Precedence — a definite FAILURE (1) outranks a COULD-NOT-RUN (2): both are
 * non-zero (the anti-green rule holds either way), and a real, actionable
 * contract violation is the more useful signal to surface. Zero requires every
 * requested generator to be `accepted`; an empty request list is
 * `could_not_run`, never a vacuous pass.
 *
 * @param {Array<{generator: string, runs: Array<object>}>} generatorRuns
 * @returns {{exitCode: 0|1|2, verdict: 'accepted'|'failed'|'could_not_run', perGenerator: Array<object>}}
 */
export function evaluateAcceptance(generatorRuns) {
  const groups = Array.isArray(generatorRuns) ? generatorRuns : [];
  const perGenerator = groups.map((g) => gradeGeneratorRuns(g?.generator, g?.runs));
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

/**
 * Resolve `--runs` to a positive integer. §9a's aggregate malformed rate needs
 * n ≥ 3 runs to tell a systematic contract break from single-field variance, so
 * 3 is the default. A smaller value is permitted (a deliberate cheap live
 * smoke) rather than rejected — the evidence records the count, so a 1-run
 * "pass" is legible as the weak sample it is.
 *
 * @param {string|null} raw
 * @returns {{ok: true, runs: number} | {ok: false, message: string}}
 */
export function parseRunsArg(raw) {
  const value = (raw ?? String(DEFAULT_RUNS)).trim();
  if (!/^\d+$/.test(value)) return { ok: false, message: `--runs must be a positive integer (got ${JSON.stringify(value)})` };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return { ok: false, message: `--runs must be >= 1 (got ${JSON.stringify(value)})` };
  return { ok: true, runs: n };
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
  lines.push(`Anchor-contract acceptance probe — rev ${evidence.rev} (${evidence.headSha.slice(0, 8)}), ${evidence.runsPerGenerator} run(s)/generator`);
  for (const g of evaluation.perGenerator) {
    const gen = (evidence.generators || []).find((e) => e.generator === g.generator) || {};
    lines.push(`  ${g.generator} (${gen.modelUnderTest ?? 'unresolved'}): ${g.outcome.toUpperCase()}`);
    for (const run of (gen.runs || [])) {
      if (run.counters) {
        lines.push(`    run ${run.index}: raw=${run.counters.discoveryRawFindings} malformedRaw=${run.counters.discoveryMalformedRaw} `
          + `contradictedRaw=${run.counters.discoveryContradictedRaw} stage0Verified=${run.counters.stage0Verified} `
          + `stage0MalformedTripwire=${run.counters.stage0MalformedTripwire}`);
      } else {
        lines.push(`    run ${run.index}: ${run.status}${run.reason ? ` — ${run.reason}` : ''}`);
      }
    }
    if (g.aggregate) {
      const rate = g.aggregate.malformedRate === null ? 'n/a (0 raw)' : g.aggregate.malformedRate.toFixed(3);
      lines.push(`    aggregate: malformedRate=${rate} (${g.aggregate.totalMalformedRaw}/${g.aggregate.totalRawFindings}, ceiling ${g.aggregate.malformedRateCeiling}) `
        + `verified=${g.aggregate.totalStage0Verified} tripwire=${g.aggregate.totalStage0MalformedTripwire} contradicted=${g.aggregate.totalContradictedRaw}`);
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

  const runsArg = parseRunsArg(argOption('runs', String(DEFAULT_RUNS)));
  if (!runsArg.ok) {
    process.stderr.write(`${runsArg.message}\n`);
    process.exit(2); // could not run — never a pass
  }
  const runsPerGenerator = runsArg.runs;

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
        schemaVersion: 2, generatedAt: new Date().toISOString(), rev,
        runsPerGenerator,
        verdict: 'could_not_run', exitCode: 2,
        fixtureError: { code, message, vcsExitCodeFor: exitCodeFor(code) },
        generators: [],
      }, null, 2));
    }
    process.exit(2);
  }

  const { fixture } = fixtureResult;
  for (const line of formatSkipLog(fixture.skipped, { logger: 'anchor-probe-fixture' })) process.stderr.write(`  ${line}\n`);
  process.stderr.write(`  [anchor-probe] fixture ${rev} → ${fixture.headSha.slice(0, 8)} (base ${fixture.baseSha.slice(0, 8)}), `
    + `${fixture.changedFiles.length} changed file(s), generators: ${generatorArg.generators.join(', ')}, ${runsPerGenerator} run(s) each\n`);

  // Grouped by generator: §9a's malformed criterion is an AGGREGATE across a
  // generator's n runs, so each generator's runs must stay together.
  const groups = [];
  for (const generator of generatorArg.generators) {
    const runs = [];
    for (let i = 0; i < runsPerGenerator; i += 1) {
      process.stderr.write(`  [anchor-probe] probing ${generator} (run ${i + 1}/${runsPerGenerator})…\n`);
      // Sequential, not Promise.all: two concurrent runs interleave their
      // stderr contract-bug reports, which are the human-readable half of this
      // probe's evidence.
      const r = await probeGenerator(generator, fixture);
      runs.push({ ...r, index: i });
    }
    groups.push({ generator, modelUnderTest: runs[0]?.modelUnderTest ?? null, models: runs[0]?.models ?? null, runs });
  }

  const evaluation = evaluateAcceptance(groups);
  const evidence = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    rev: fixture.rev,
    headSha: fixture.headSha,
    baseSha: fixture.baseSha,
    changedFiles: fixture.changedFiles,
    runsPerGenerator,
    criteria: [...ACCEPTANCE_CRITERIA_DESC],
    // Recorded so the acceptance claim names the model that made it — a
    // sentinel that resolves elsewhere tomorrow must not silently inherit
    // today's verdict.
    resolvedModels: groups.length > 0 ? groups[0].models : null,
    notExercised: ['stage1_triage', 'stage2_adjudication'],
    verdict: evaluation.verdict,
    exitCode: evaluation.exitCode,
    generators: evaluation.perGenerator.map((g) => {
      const group = groups.find((gr) => gr.generator === g.generator) || {};
      return {
        generator: g.generator,
        modelUnderTest: group.modelUnderTest ?? null,
        outcome: g.outcome,
        failedCriteria: g.failedCriteria ?? null,
        reason: g.reason ?? null,
        aggregate: g.aggregate ?? null,
        otherGeneratorSilenced: GENERATORS.filter((x) => x !== g.generator),
        runs: (group.runs || []).map((r) => ({
          index: r.index,
          status: r.status,
          runStatus: r.runStatus ?? null,
          reason: r.reason ?? null,
          counters: r.counters ?? null,
          generatorOutcomes: r.generatorOutcomes ?? [],
        })),
      };
    }),
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
