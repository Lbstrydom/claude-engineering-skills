/**
 * Hermetic tests for `scripts/verify-anchor-contract.mjs` — the live-provider
 * acceptance probe (docs/plans/evidence-anchor-path-contract.md §9a, Phase 7).
 *
 * NO live provider calls, no network, no git fixture. Per AGENTS.md's Tier-2
 * doctrine, the exit semantics are driven by injecting fake per-run counter
 * arrays into the exported pure grader (`gradeGeneratorRuns`) — mocking a whole
 * provider to assert orchestration order would test the mock, not the contract.
 *
 * The thing a live provider honouring the enum can only be PROVEN by is the
 * probe itself; these tests prove the probe cannot lie about the answer — and,
 * post-§9a-correction, that it grades a RATE across n runs rather than a
 * per-run zero that flakes on expected single-field variance.
 */

import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  evaluateAcceptance,
  gradeGeneratorRuns,
  parseGeneratorArg,
  parseRunsArg,
} from '../scripts/verify-anchor-contract.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'verify-anchor-contract.mjs');

/** A counter set that MEETS every §9a criterion. `discoveryContradictedRaw` is
 *  non-zero on purpose: a model claim the diff disproves is the model's error,
 *  and must never fail OUR contract's acceptance. */
const baseCounters = Object.freeze({
  discoveryRawFindings: 6,
  discoveryMalformedRaw: 0,
  discoveryContradictedRaw: 2,
  stage0Verified: 4,
  stage0Rejected: 0,
  stage0MalformedTripwire: 0,
});

/** One `ok` run with `over` merged into its counters. */
const run = (over = {}) => ({ status: 'ok', counters: { ...baseCounters, ...over } });
/** n identical accepting runs. */
const okRuns = (n = 3) => Array.from({ length: n }, () => run());
/** A generator group for evaluateAcceptance. */
const group = (generator, runs = okRuns()) => ({ generator, runs });

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
  assert.equal(typeof gradeGeneratorRuns, 'function');
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

test('--runs defaults to 3 — the n≥3 sample §9a\'s rate criterion needs', () => {
  assert.deepEqual(parseRunsArg(null), { ok: true, runs: 3 });
  assert.deepEqual(parseRunsArg(undefined), { ok: true, runs: 3 });
});

test('--runs accepts any positive integer (1 = a deliberate cheap live smoke)', () => {
  assert.equal(parseRunsArg('5').runs, 5);
  assert.equal(parseRunsArg('1').runs, 1);
});

test('--runs rejects zero, negatives and non-integers (a bad sample is could-not-run)', () => {
  assert.equal(parseRunsArg('0').ok, false);
  assert.equal(parseRunsArg('-2').ok, false);
  assert.equal(parseRunsArg('abc').ok, false);
  assert.equal(parseRunsArg('2.5').ok, false);
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

test('an invalid --runs exits 2 before any provider is constructed', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--runs', '0'], {
    encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr || '', /--runs must be/);
});

// ── Per-generator AGGREGATE grading (the RATE-not-a-zero rule) ─────────────

test('grade: all runs meet every criterion → accepted', () => {
  assert.equal(gradeGeneratorRuns('sonnet', okRuns()).outcome, 'accepted');
});

test('grade: a per-run 50%-malformed run does NOT fail if the AGGREGATE is under ceiling (the flake fix)', () => {
  // §9a's exact scenario: Sonnet returned 1 raw / 1 malformed (per-run 100%),
  // then 5 raw / 0 malformed — same code, opposite verdicts under `=== 0`. The
  // aggregate absorbs it.
  const g = gradeGeneratorRuns('sonnet', [
    run({ discoveryRawFindings: 2, discoveryMalformedRaw: 1 }), // 0.5 ALONE
    run({ discoveryRawFindings: 10, discoveryMalformedRaw: 0 }),
    run({ discoveryRawFindings: 10, discoveryMalformedRaw: 0 }),
  ]);
  assert.equal(g.outcome, 'accepted'); // 1/22 = 0.045 < 0.34
  assert.ok(g.aggregate.malformedRate < 0.34);
});

test('grade: a SYSTEMATIC malformed rate (>= 0.34 aggregate) fails, even with verified > 0', () => {
  const g = gradeGeneratorRuns('glm', [
    run({ discoveryRawFindings: 6, discoveryMalformedRaw: 4 }),
    run({ discoveryRawFindings: 6, discoveryMalformedRaw: 4 }),
    run({ discoveryRawFindings: 6, discoveryMalformedRaw: 4 }),
  ]);
  assert.equal(g.outcome, 'failed'); // 12/18 = 0.667
  assert.ok(g.failedCriteria.some((c) => /sum\(discoveryMalformedRaw\)/.test(c)), g.failedCriteria.join(' | '));
});

// Corrected 2026-07-18 BY RUNNING IT: this previously asserted `failed`. Both
// Sonnet-5 and GLM-5.2 returned 0 findings 3/3 on the pinned fixture (a clean
// hardening commit; payload verified healthy), and grading that `failed` would
// blame OUR contract for a property of the model + fixture — the plan's own
// central misattribution, pointed the other way. The invariant the test really
// guards (0/0 must never read as clean) is PRESERVED: `could_not_run` is exit
// 2, non-zero.
test('grade: 0 raw findings is could_not_run (contract never exercised), NOT failed — and 0/0 still never reads clean', () => {
  const g = gradeGeneratorRuns('sonnet', [
    run({ discoveryRawFindings: 0, discoveryMalformedRaw: 0, stage0Verified: 0 }),
    run({ discoveryRawFindings: 0, discoveryMalformedRaw: 0, stage0Verified: 0 }),
    run({ discoveryRawFindings: 0, discoveryMalformedRaw: 0, stage0Verified: 0 }),
  ]);
  assert.equal(g.outcome, 'could_not_run');
  assert.match(g.reason, /contract_not_exercised/);
  // Never silently clean: the outcome is non-accepted, so exit stays non-zero.
  assert.notEqual(g.outcome, 'accepted');
});

test('grade: a zero-finding run mixed with real runs sinks the generator to could_not_run, never accepted', () => {
  const g = gradeGeneratorRuns('sonnet', [run(), run({ discoveryRawFindings: 0, stage0Verified: 0 }), run()]);
  assert.equal(g.outcome, 'could_not_run');
  assert.match(g.reason, /contract_not_exercised/);
});

test('grade: a REAL contract break (malformed rate) still fails — could_not_run must not swallow it', () => {
  const g = gradeGeneratorRuns('sonnet', [
    run({ discoveryRawFindings: 6, discoveryMalformedRaw: 6, stage0Verified: 1 }),
    run({ discoveryRawFindings: 6, discoveryMalformedRaw: 6, stage0Verified: 1 }),
    run({ discoveryRawFindings: 6, discoveryMalformedRaw: 6, stage0Verified: 1 }),
  ]);
  assert.equal(g.outcome, 'failed');
});

test('grade: stage0Verified === 0 on even ONE run fails (the literal 1-of-62 defect, required every run)', () => {
  const g = gradeGeneratorRuns('sonnet', [run(), run({ stage0Verified: 0 }), run()]);
  assert.equal(g.outcome, 'failed');
  assert.ok(g.failedCriteria.some((c) => /every run/.test(c)), g.failedCriteria.join(' | '));
});

test('grade: stage0MalformedTripwire aggregate != 0 fails (a hydration regression signal, binary)', () => {
  const g = gradeGeneratorRuns('glm', [run(), run({ stage0MalformedTripwire: 1 }), run()]);
  assert.equal(g.outcome, 'failed');
  assert.ok(g.failedCriteria.some((c) => /stage0MalformedTripwire/.test(c)));
});

test('grade: contradictedRaw > 0 never fails acceptance (the model\'s error, not ours)', () => {
  const g = gradeGeneratorRuns('glm', [
    run({ discoveryContradictedRaw: 9 }), run({ discoveryContradictedRaw: 9 }), run({ discoveryContradictedRaw: 9 }),
  ]);
  assert.equal(g.outcome, 'accepted');
  assert.equal(g.aggregate.totalContradictedRaw, 27); // reported, not gated
});

test('grade: any non-ok run sinks the whole generator to could_not_run, never accepted', () => {
  const g = gradeGeneratorRuns('glm', [run(), { status: 'could_not_run', reason: 'provider_unavailable: no key' }, run()]);
  assert.equal(g.outcome, 'could_not_run');
  assert.match(g.reason, /provider_unavailable/);
});

test('grade: an absent or non-numeric counter on any run is could_not_run, never a silent 0', () => {
  const missing = { ...baseCounters };
  delete missing.stage0MalformedTripwire;
  const g = gradeGeneratorRuns('sonnet', [run(), { status: 'ok', counters: missing }, run()]);
  assert.equal(g.outcome, 'could_not_run');
  assert.match(g.reason, /counters_incomplete: stage0MalformedTripwire/);

  const nan = gradeGeneratorRuns('sonnet', [{ status: 'ok', counters: { ...baseCounters, stage0Verified: null } }]);
  assert.equal(nan.outcome, 'could_not_run');
  assert.match(nan.reason, /stage0Verified/);
});

test('grade: an absent counters object is could_not_run, NOT a vacuous pass', () => {
  assert.equal(gradeGeneratorRuns('sonnet', [{ status: 'ok', counters: null }]).outcome, 'could_not_run');
  assert.equal(gradeGeneratorRuns('sonnet', [{ status: 'ok' }]).outcome, 'could_not_run');
});

test('grade: an empty (or nullish) runs array is could_not_run — a generator never executed', () => {
  assert.equal(gradeGeneratorRuns('sonnet', []).outcome, 'could_not_run');
  assert.equal(gradeGeneratorRuns('sonnet', null).outcome, 'could_not_run');
});

test('grade: every unmet criterion is named, not just the first', () => {
  const bad = { discoveryRawFindings: 6, discoveryMalformedRaw: 5, stage0Verified: 0, stage0MalformedTripwire: 2 };
  const g = gradeGeneratorRuns('glm', [run(bad), run(bad), run(bad)]);
  assert.equal(g.outcome, 'failed');
  assert.equal(g.failedCriteria.length, 3); // verified, rate, tripwire
});

// ── The three-way exit mapping (grouped by generator) ──────────────────────

test('exit 0: acceptance MET for every requested generator', () => {
  const e = evaluateAcceptance([group('sonnet'), group('glm')]);
  assert.equal(e.exitCode, 0);
  assert.equal(e.verdict, 'accepted');
});

test('exit 1: acceptance FAILED — aggregate criteria unmet', () => {
  const failing = [run({ discoveryRawFindings: 6, discoveryMalformedRaw: 4 }),
    run({ discoveryRawFindings: 6, discoveryMalformedRaw: 4 }),
    run({ discoveryRawFindings: 6, discoveryMalformedRaw: 4 })];
  const e = evaluateAcceptance([group('sonnet'), group('glm', failing)]);
  assert.equal(e.exitCode, 1);
  assert.equal(e.verdict, 'failed');
});

test('exit 1: a Sonnet pass beside a GLM failure is NOT acceptance (R1/H4)', () => {
  const e = evaluateAcceptance([group('sonnet'), group('glm', [run(), run({ stage0Verified: 0 }), run()])]);
  assert.equal(e.exitCode, 1);
});

test('exit 2: could-not-run is never conflated with a pass', () => {
  const e = evaluateAcceptance([group('sonnet'), { generator: 'glm', runs: [{ status: 'could_not_run', reason: 'provider_unavailable' }] }]);
  assert.equal(e.exitCode, 2);
  assert.equal(e.verdict, 'could_not_run');
  assert.notEqual(e.exitCode, 0);
});

test('exit 2: an incomplete run cannot pass on its zeroed counters', () => {
  // status could_not_run reports zeros because nothing happened, not because
  // nothing was wrong — the vacuous-"met" reading that has burned this
  // pipeline's shadow window three times.
  const zeroed = { ...baseCounters, discoveryRawFindings: 0, discoveryContradictedRaw: 0, stage0Verified: 0 };
  const e = evaluateAcceptance([{ generator: 'sonnet', runs: [{ status: 'could_not_run', reason: 'run_incomplete: runStatus=skipped_no_eligible_files', counters: zeroed }] }]);
  assert.equal(e.exitCode, 2);
});

test('exit 2: an empty request list is could-not-run, not a vacuous 0', () => {
  assert.equal(evaluateAcceptance([]).exitCode, 2);
  assert.equal(evaluateAcceptance(null).exitCode, 2);
});

test('a definite failure outranks a could-not-run — both are non-zero, the actionable one wins', () => {
  const failing = [run({ discoveryRawFindings: 6, discoveryMalformedRaw: 4 }),
    run({ discoveryRawFindings: 6, discoveryMalformedRaw: 4 }),
    run({ discoveryRawFindings: 6, discoveryMalformedRaw: 4 })];
  const e = evaluateAcceptance([
    group('sonnet', failing),
    { generator: 'glm', runs: [{ status: 'could_not_run', reason: 'provider_unavailable' }] },
  ]);
  assert.equal(e.exitCode, 1);
});

test('every requested generator appears in perGenerator, so a silent drop is visible', () => {
  const e = evaluateAcceptance([group('sonnet'), group('glm')]);
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
    assert.deepEqual(evidence.generators, []);
    assert.equal(evidence.runsPerGenerator, 3); // recorded even on the error path
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

// ── D2: the default input can actually reach exit 0 ────────────────────────

describe('the default fixture bundle', () => {
  const DIR = new URL('../tests/fixtures/anchor-contract/', import.meta.url);

  it('resolves and parses — the check that would have caught the original defect', async () => {
    // Cheap, offline, and the exact class of failure `cee4448` was: a default
    // pointing at something the probe cannot turn into a usable run.
    const fs = await import('node:fs');
    const manifest = JSON.parse(fs.readFileSync(new URL('MANIFEST.json', DIR), 'utf-8'));
    const diff = fs.readFileSync(new URL('known-defects.diff', DIR), 'utf-8');

    assert.match(diff, /^diff --git /m, 'the pinned diff must be a unified diff');
    assert.ok(manifest.files.length > 0, 'the manifest must list the snapshot files');
    for (const f of manifest.files) {
      assert.ok(fs.existsSync(new URL(`files/${f.path}`, DIR)),
        `${f.path} is listed in MANIFEST.json but its snapshot is missing`);
    }
  });

  it('is SELF-CONTAINED — both halves of the model input are committed', async () => {
    // The immutability the plan claimed and a bare committed diff does not
    // deliver: `readFilesAsContext` reads the live worktree, so pinning only the
    // diff freezes the changes while the analysed code drifts underneath.
    const fs = await import('node:fs');
    const manifest = JSON.parse(fs.readFileSync(new URL('MANIFEST.json', DIR), 'utf-8'));
    const diff = fs.readFileSync(new URL('known-defects.diff', DIR), 'utf-8');
    const referenced = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]).filter((p) => p !== '/dev/null');
    for (const p of referenced) {
      assert.ok(manifest.files.some((f) => f.path === p),
        `${p} is referenced by the diff but has no committed snapshot — the bundle is not self-contained`);
    }
  });

  it('carries no sensitive path and no secret shape (Tier 3, same commit)', async () => {
    // The bundle is committed AND sent to a live provider on every run, and
    // deleted content is where credentials survive. The extraction was gated;
    // this is what stops a later edit regressing it.
    const fs = await import('node:fs');
    const { shouldSkipForIndexing } = await import('../scripts/lib/sensitive-paths.mjs');
    const manifest = JSON.parse(fs.readFileSync(new URL('MANIFEST.json', DIR), 'utf-8'));
    for (const f of manifest.files) {
      assert.equal(shouldSkipForIndexing(f.path, ['sensitive']).skip, false,
        `${f.path} classifies as sensitive and must not be in a committed fixture`);
    }
    const bodies = manifest.files.map((f) => fs.readFileSync(new URL(`files/${f.path}`, DIR), 'utf-8')).join('\n');
    assert.doesNotMatch(bodies, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key survived extraction');
    assert.doesNotMatch(bodies, /\bsk-[A-Za-z0-9]{20,}/, 'an API-key shape survived extraction');
  });
});
