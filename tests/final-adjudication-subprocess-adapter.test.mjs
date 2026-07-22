/**
 * @fileoverview Tier 2 subprocess-boundary tests for
 * `createGeminiReviewSubprocessAdapters` (tiered-recall audit pipeline
 * Phase 12) — closes audit-plan fix M1's gap: `tests/run-final-review-harness.test.mjs`
 * covers `runFinalReview`/`runAdjudicatorOnlyReview` via direct function
 * calls; THIS file covers the subprocess boundary itself (cwd/path
 * resolution, CLI arg parsing, exit codes, `--out` file I/O, temp-dir
 * lifecycle) by spawning the REAL `scripts/gemini-review.mjs` CLI, mirroring
 * `tests/audit-no-files-cli.test.mjs`'s subprocess-test pattern.
 *
 * Negative/early-exit path: GEMINI_API_KEY/ANTHROPIC_API_KEY unset — a
 * deterministic early-exit, no live call.
 *
 * Success path: `gemini-review.mjs --provider fixture` (test-only, rejected
 * outside NODE_ENV=test) skips all real provider construction and writes a
 * canned, schema-valid result straight to `--out` — spawned via the REAL
 * adapter, asserting exit 0, correct verdict-mapping parse, and temp-dir
 * cleanup after a SUCCESSFUL run too (the negative-path tests only prove
 * cleanup-on-failure).
 *
 * Temp-dir-removed assertions capture the EXACT directory `invokeGeminiReviewSubprocess`
 * created for THIS call (via a thin `execFile` wrapper reading the
 * transcript-path argument) rather than diffing an `os.tmpdir()` directory
 * listing — `node --test` runs test FILES concurrently by default and
 * `tests/final-adjudication-egress.test.mjs` (as well as other tests in
 * THIS file) legitimately create/remove `audit-adjudication-*` dirs under
 * the SAME shared OS tmpdir at the same time, which made a generic
 * before/after prefix-scan diff flaky.
 *
 * Plan: docs/plans/tiered-recall-audit-pipeline.md Phase 12.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGeminiReviewSubprocessAdapters } from '../scripts/lib/audit/final-adjudication.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Wraps the real `execFile` so a test can learn exactly which private temp
 * directory `invokeGeminiReviewSubprocess` created for THIS call — args[3]
 * is always `transcriptPath` (see the fixed arg order in
 * `final-adjudication.mjs::invokeGeminiReviewSubprocess`).
 * @param {{dir?: string}} captured - mutated in place with `.dir`
 */
function captureExecFileDir(captured) {
  return (file, args, options, callback) => {
    captured.dir = path.dirname(args[3]);
    return execFile(file, args, options, callback);
  };
}

/** Env with both provider keys explicitly emptied — dotenv (loaded inside the
 * child) does not override already-present env keys, so this reliably
 * disables live-provider selection regardless of the developer's local .env. */
function noKeyEnv(extra = {}) {
  return {
    ...process.env,
    GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '',
    MODEL_CATALOG_REFRESH: 'skip', LEARNING_DISABLE: '1', AUDIT_DB_URL: '',
    ...extra,
  };
}

// A real, existing, definitely-non-sensitive repo file — resolveAndClassify
// fails CLOSED (sensitive) on a path it cannot fs.realpathSync (ENOENT), so
// these adapter tests (which exercise the subprocess/provider boundary, NOT
// the sensitive-egress gate — see tests/final-adjudication-egress.test.mjs
// for that) must reference a file that actually exists under REPO_ROOT.
const REAL_FILE = 'AGENTS.md';

function mkEnvelope({ file = REAL_FILE, id = 'H1', severity = 'HIGH' } = {}) {
  return {
    candidateId: `envelope:${id}`,
    canonicalFinding: {
      id, severity, category: 'Test', section: file, detail: 'a real bug',
      anchor: { oldFile: file, newFile: file },
    },
    evidenceAlternatives: [],
    stageDecisions: [],
  };
}

describe('final-adjudication subprocess adapter — negative/early-exit path', () => {
  it('--role adjudicator-only is accepted by parseReviewArgs (fails later at provider selection, not arg parsing) — non-zero exit (and the coincident missing --out) both surface as an adapter failure, never silently treated as success; temp dir removed', async () => {
    const captured = {};
    const adapters = createGeminiReviewSubprocessAdapters({
      repoRoot: REPO_ROOT,
      env: noKeyEnv(),
      perCallTimeoutMs: 60000,
      execFileImpl: captureExecFileDir(captured),
    });
    await assert.rejects(() => adapters.reviewCall(mkEnvelope()));
    assert.ok(captured.dir, 'the adapter must have actually attempted a subprocess call');
    assert.ok(!fs.existsSync(captured.dir), 'temp dir must be cleaned up on failure');
  });

  it('cleanRegionCall also surfaces the same non-zero-exit failure and cleans up its temp dir', async () => {
    const captured = {};
    const adapters = createGeminiReviewSubprocessAdapters({
      repoRoot: REPO_ROOT,
      env: noKeyEnv(),
      perCallTimeoutMs: 60000,
      execFileImpl: captureExecFileDir(captured),
    });
    await assert.rejects(() => adapters.cleanRegionCall(REAL_FILE));
    assert.ok(captured.dir);
    assert.ok(!fs.existsSync(captured.dir));
  });

  it('cwd is the repo root — an invalid --role value is rejected by the CLI itself (raw subprocess, not via the adapter)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-review-cli-raw-test-'));
    try {
      const transcriptPath = path.join(dir, 'transcript.json');
      const planPath = path.join(dir, 'plan.md');
      const outPath = path.join(dir, 'result.json');
      fs.writeFileSync(transcriptPath, JSON.stringify({ audit_mode: 'code', changed_files: [], code_files: [], summary: 't', rounds: [{ round: 1, findings: [] }], claude_resolutions: [] }));
      fs.writeFileSync(planPath, '# plan\n');

      let exitCode = 0;
      let output = '';
      try {
        execFileSync(process.execPath, [
          path.join(REPO_ROOT, 'scripts', 'gemini-review.mjs'), 'review', planPath, transcriptPath,
          '--out', outPath, '--role', 'not-a-real-role',
        ], { cwd: REPO_ROOT, encoding: 'utf8', env: noKeyEnv(), timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        exitCode = e.status ?? 1;
        output = `${e.stdout || ''}${e.stderr || ''}`;
      }
      assert.notEqual(exitCode, 0);
      assert.match(output, /--role must be "adjudicator-only"/);
      assert.ok(!fs.existsSync(outPath), 'must not write --out on a rejected --role');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('final-adjudication subprocess adapter — success path (--provider fixture, NODE_ENV=test only)', () => {
  it('--provider fixture is rejected outside NODE_ENV=test', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-review-cli-raw-test-'));
    try {
      const transcriptPath = path.join(dir, 'transcript.json');
      const planPath = path.join(dir, 'plan.md');
      const outPath = path.join(dir, 'result.json');
      fs.writeFileSync(transcriptPath, JSON.stringify({ audit_mode: 'code', changed_files: [], code_files: [], summary: 't', rounds: [{ round: 1, findings: [] }], claude_resolutions: [] }));
      fs.writeFileSync(planPath, '# plan\n');

      let exitCode = 0;
      let output = '';
      try {
        execFileSync(process.execPath, [
          path.join(REPO_ROOT, 'scripts', 'gemini-review.mjs'), 'review', planPath, transcriptPath,
          '--out', outPath, '--provider', 'fixture',
        ], { cwd: REPO_ROOT, encoding: 'utf8', env: noKeyEnv({ NODE_ENV: 'production' }), timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        exitCode = e.status ?? 1;
        output = `${e.stdout || ''}${e.stderr || ''}`;
      }
      assert.notEqual(exitCode, 0);
      assert.match(output, /--provider fixture is test-only/);
      assert.ok(!fs.existsSync(outPath));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('reviewCall via the real subprocess+fixture returns {verdict:"confirmed", rationale} and cleans up its temp dir on success', async () => {
    const captured = {};
    const adapters = createGeminiReviewSubprocessAdapters({
      repoRoot: REPO_ROOT,
      env: noKeyEnv({ NODE_ENV: 'test' }),
      extraCliArgs: ['--provider', 'fixture'],
      perCallTimeoutMs: 60000,
      execFileImpl: captureExecFileDir(captured),
    });
    const response = await adapters.reviewCall(mkEnvelope({ id: 'H7' }));
    assert.equal(response.verdict, 'confirmed');
    assert.equal(typeof response.rationale, 'string');
    assert.ok(captured.dir);
    assert.ok(!fs.existsSync(captured.dir), 'temp dir must be cleaned up on SUCCESS too');
  });

  it('reviewCall maps a fixture-driven wrongly_dismissed hit to {verdict:"reversed", rationale}', async () => {
    const adapters = createGeminiReviewSubprocessAdapters({
      repoRoot: REPO_ROOT,
      env: noKeyEnv({ NODE_ENV: 'test' }),
      extraCliArgs: ['--provider', 'fixture'],
      perCallTimeoutMs: 60000,
      transcriptOverrides: { _fixtureVerdict: 'reversed' },
    });
    const response = await adapters.reviewCall(mkEnvelope({ id: 'H9' }));
    assert.equal(response.verdict, 'reversed');
    assert.equal(response.rationale, 'fixture canned reversal');
  });

  it('cleanRegionCall via the real subprocess+fixture returns {verdict:"clean"} for the default canned (empty) new_findings', async () => {
    const adapters = createGeminiReviewSubprocessAdapters({
      repoRoot: REPO_ROOT,
      env: noKeyEnv({ NODE_ENV: 'test' }),
      extraCliArgs: ['--provider', 'fixture'],
      perCallTimeoutMs: 60000,
    });
    const response = await adapters.cleanRegionCall(REAL_FILE);
    // Verdict contract unchanged; the adapter now also surfaces `_usage`/`_model`
    // (2026-07-22 per-stage cost capture) — present on every post-subprocess
    // return, null when the subprocess emitted none.
    assert.equal(response.verdict, 'clean');
    assert.ok('_usage' in response && '_model' in response, 'metering fields must be surfaced');
  });

  it('cleanRegionCall maps a fixture-driven new_findings hit to {verdict:"missed_candidate", finding}', async () => {
    const adapters = createGeminiReviewSubprocessAdapters({
      repoRoot: REPO_ROOT,
      env: noKeyEnv({ NODE_ENV: 'test' }),
      extraCliArgs: ['--provider', 'fixture'],
      perCallTimeoutMs: 60000,
      transcriptOverrides: { _fixtureVerdict: 'missed_candidate' },
    });
    const response = await adapters.cleanRegionCall(REAL_FILE);
    assert.equal(response.verdict, 'missed_candidate');
    assert.ok(response.finding && typeof response.finding === 'object');
  });
});
