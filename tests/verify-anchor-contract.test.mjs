/**
 * Hermetic tests for `scripts/verify-anchor-contract.mjs` — the live-provider
 * acceptance probe (docs/plans/evidence-anchor-path-contract.md §9a, Phase 7).
 *
 * NO live provider calls, no network, no git fixture. Per AGENTS.md's Tier-2
 * doctrine, the exit semantics are driven by injecting fake counter objects
 * into the exported pure graders — mocking a whole provider to assert
 * orchestration order would test the mock, not the contract.
 *
 * The thing a live provider honouring the enum can only be PROVEN by is the
 * probe itself; these tests prove the probe cannot lie about the answer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  evaluateAcceptance,
  gradeGeneratorResult,
  parseGeneratorArg,
} from '../scripts/verify-anchor-contract.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'verify-anchor-contract.mjs');

/** A counter set that MEETS every §9a criterion. `discoveryContradictedRaw` is
 *  non-zero on purpose: a model claim the diff disproves is the model's error,
 *  and must never fail OUR contract's acceptance. */
const acceptingCounters = Object.freeze({
  discoveryRawFindings: 6,
  discoveryMalformedRaw: 0,
  discoveryContradictedRaw: 2,
  stage0Verified: 4,
  stage0Rejected: 0,
  stage0MalformedTripwire: 0,
});

const ok = (generator, counters = acceptingCounters) => ({ generator, status: 'ok', counters });

// ── Relocation smoke ──────────────────────────────────────────────────────

test('--selfcheck-relocation prints OK and exits 0', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--selfcheck-relocation'], {
    encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(r.status, 0, `stderr: ${(r.stderr || '').slice(0, 300)}`);
  assert.equal((r.stdout || '').trim(), 'OK');
});

test('importing the module does not execute main()', () => {
  // The pathToFileURL entry guard: if main() ran at import time it would have
  // spawned git and (with keys present) called a provider. Reaching this
  // assertion at all is the proof — the import happened at the top of file.
  assert.equal(typeof evaluateAcceptance, 'function');
  assert.equal(typeof gradeGeneratorResult, 'function');
});

// ── Arg parsing ───────────────────────────────────────────────────────────

test('--generator defaults to all, which covers BOTH sonnet and glm', () => {
  const r = parseGeneratorArg(null);
  assert.equal(r.ok, true);
  assert.deepEqual(r.generators, ['sonnet', 'glm']);
  // R1/H4: a sonnet-only default would ship a fixed Sonnet path beside a
  // broken GLM one.
  assert.deepEqual(parseGeneratorArg('all').generators, ['sonnet', 'glm']);
});

test('--generator accepts each single generator', () => {
  assert.deepEqual(parseGeneratorArg('sonnet').generators, ['sonnet']);
  assert.deepEqual(parseGeneratorArg('glm').generators, ['glm']);
});

test('--generator rejects an unknown value rather than silently defaulting', () => {
  const r = parseGeneratorArg('gpt');
  assert.equal(r.ok, false);
  assert.match(r.message, /sonnet \| glm \| all/);
});

test('an unsafe --rev is refused with exit 2 (could-not-run), never a pass', () => {
  // NOT `--rev --upload-pack=evil`: argOption's repo-wide convention ignores a
  // value starting with `--` and falls back to the default, so that spelling
  // never reaches isSafeGitRevision — it would silently launch a REAL probe
  // run instead of testing the refusal (this test caught exactly that).
  const r = spawnSync(process.execPath, [SCRIPT, '--rev', 'HEAD; rm -rf /'], {
    encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(r.status, 2, `stdout: ${(r.stdout || '').slice(0, 200)}`);
  assert.match(r.stderr || '', /refusing unsafe --rev/);
});

test('an unknown --generator exits 2 before any provider is constructed', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--generator', 'nope'], {
    encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr || '', /--generator must be one of/);
});

// ── Per-generator grading ─────────────────────────────────────────────────

test('grade: all three criteria met → accepted', () => {
  assert.equal(gradeGeneratorResult(ok('sonnet')).outcome, 'accepted');
});

test('grade: contradictedRaw > 0 alone does NOT fail acceptance (the model\'s error, not ours)', () => {
  const g = gradeGeneratorResult(ok('glm', { ...acceptingCounters, discoveryContradictedRaw: 9 }));
  assert.equal(g.outcome, 'accepted');
});

test('grade: stage0Verified === 0 fails — a run that verified nothing is not acceptance', () => {
  const g = gradeGeneratorResult(ok('sonnet', { ...acceptingCounters, stage0Verified: 0 }));
  assert.equal(g.outcome, 'failed');
  assert.deepEqual(g.failedCriteria, ['stage0Verified > 0 (was 0)']);
});

test('grade: discoveryMalformedRaw > 0 fails — OUR contract could not parse the claim', () => {
  const g = gradeGeneratorResult(ok('glm', { ...acceptingCounters, discoveryMalformedRaw: 3 }));
  assert.equal(g.outcome, 'failed');
  assert.deepEqual(g.failedCriteria, ['discoveryMalformedRaw === 0 (was 3)']);
});

test('grade: stage0MalformedTripwire > 0 fails — the tripwire is a regression signal', () => {
  const g = gradeGeneratorResult(ok('sonnet', { ...acceptingCounters, stage0MalformedTripwire: 1 }));
  assert.equal(g.outcome, 'failed');
  assert.deepEqual(g.failedCriteria, ['stage0MalformedTripwire === 0 (was 1)']);
});

test('grade: every unmet criterion is named, not just the first', () => {
  const g = gradeGeneratorResult(ok('glm', {
    ...acceptingCounters, stage0Verified: 0, discoveryMalformedRaw: 2, stage0MalformedTripwire: 5,
  }));
  assert.equal(g.failedCriteria.length, 3);
});

test('grade: a non-ok status is could_not_run and carries its reason', () => {
  const g = gradeGeneratorResult({ generator: 'glm', status: 'could_not_run', reason: 'provider_unavailable: no key' });
  assert.equal(g.outcome, 'could_not_run');
  assert.match(g.reason, /provider_unavailable/);
});

test('grade: absent counters are could_not_run, NOT a vacuous pass', () => {
  // The anti-green rule: "no _stageBreakdown" must never read as "0 malformed,
  // therefore clean".
  assert.equal(gradeGeneratorResult({ generator: 'sonnet', status: 'ok', counters: null }).outcome, 'could_not_run');
  assert.equal(gradeGeneratorResult({ generator: 'sonnet', status: 'ok' }).outcome, 'could_not_run');
});

test('grade: a missing or non-numeric criterion counter is could_not_run, never 0', () => {
  const missing = { ...acceptingCounters };
  delete missing.stage0MalformedTripwire;
  const g = gradeGeneratorResult({ generator: 'sonnet', status: 'ok', counters: missing });
  assert.equal(g.outcome, 'could_not_run');
  assert.match(g.reason, /counters_incomplete: stage0MalformedTripwire/);

  const nan = gradeGeneratorResult({ generator: 'sonnet', status: 'ok', counters: { ...acceptingCounters, stage0Verified: null } });
  assert.equal(nan.outcome, 'could_not_run');
  assert.match(nan.reason, /stage0Verified/);
});

// ── The three-way exit mapping ────────────────────────────────────────────

test('exit 0: acceptance MET for every requested generator', () => {
  const e = evaluateAcceptance([ok('sonnet'), ok('glm')]);
  assert.equal(e.exitCode, 0);
  assert.equal(e.verdict, 'accepted');
});

test('exit 1: acceptance FAILED — counters present, criteria unmet', () => {
  const e = evaluateAcceptance([ok('sonnet'), ok('glm', { ...acceptingCounters, discoveryMalformedRaw: 1 })]);
  assert.equal(e.exitCode, 1);
  assert.equal(e.verdict, 'failed');
});

test('exit 1: a Sonnet pass beside a GLM failure is NOT acceptance (R1/H4)', () => {
  const e = evaluateAcceptance([ok('sonnet'), ok('glm', { ...acceptingCounters, stage0Verified: 0 })]);
  assert.equal(e.exitCode, 1);
});

test('exit 2: could-not-run is never conflated with a pass', () => {
  const e = evaluateAcceptance([ok('sonnet'), { generator: 'glm', status: 'could_not_run', reason: 'provider_unavailable' }]);
  assert.equal(e.exitCode, 2);
  assert.equal(e.verdict, 'could_not_run');
  assert.notEqual(e.exitCode, 0);
});

test('exit 2: an incomplete run cannot pass on its zeroed counters', () => {
  // runStatus !== 'complete' reports zeros because nothing happened, not
  // because nothing was wrong — the vacuous-"met" reading that has burned this
  // pipeline's shadow window three times.
  const zeroed = { ...acceptingCounters, discoveryRawFindings: 0, discoveryContradictedRaw: 0, stage0Verified: 0 };
  const e = evaluateAcceptance([{ generator: 'sonnet', status: 'could_not_run', reason: 'run_incomplete: runStatus=skipped_no_eligible_files', counters: zeroed }]);
  assert.equal(e.exitCode, 2);
});

test('exit 2: an empty request list is could-not-run, not a vacuous 0', () => {
  assert.equal(evaluateAcceptance([]).exitCode, 2);
  assert.equal(evaluateAcceptance(null).exitCode, 2);
});

test('a definite failure outranks a could-not-run — both are non-zero, the actionable one wins', () => {
  const e = evaluateAcceptance([
    ok('sonnet', { ...acceptingCounters, discoveryMalformedRaw: 4 }),
    { generator: 'glm', status: 'could_not_run', reason: 'provider_unavailable' },
  ]);
  assert.equal(e.exitCode, 1);
});

test('every requested generator appears in perGenerator, so a silent drop is visible', () => {
  const e = evaluateAcceptance([ok('sonnet'), ok('glm')]);
  assert.deepEqual(e.perGenerator.map((g) => g.generator), ['sonnet', 'glm']);
});

// ── Evidence ──────────────────────────────────────────────────────────────

test('--out writes an evidence file even when the fixture could not load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-probe-'));
  const out = path.join(dir, 'evidence.json');
  try {
    // A syntactically-safe rev that cannot resolve → BAD_REVISION → exit 2,
    // and the evidence must still record WHY rather than leaving no trace.
    const r = spawnSync(process.execPath, [SCRIPT, '--rev', 'deadbeefdeadbeefdeadbeef', '--out', out], {
      encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(r.status, 2, `stdout: ${(r.stdout || '').slice(0, 300)}`);
    const evidence = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(evidence.verdict, 'could_not_run');
    assert.equal(evidence.exitCode, 2);
    assert.equal(evidence.fixtureError.code, 'BAD_REVISION');
    // The VcsErrorCode's exitCodeFor value is recorded for diagnosis but is
    // deliberately NOT the process exit — vcs's 1/4/5/127 map collides with
    // this script's three-way contract.
    assert.equal(evidence.fixtureError.vcsExitCodeFor, 4);
    assert.deepEqual(evidence.runs, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
