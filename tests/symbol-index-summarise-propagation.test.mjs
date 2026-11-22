/**
 * INTEGRATION coverage for the completeness verdict's path from the provider
 * response to the stdout envelope.
 *
 * Why a separate, subprocess-driven suite. The same Silent-Data-Loss concern
 * was raised in four consecutive audit rounds; the fourth raise was not about
 * the fix but about the TEST: the unit tests in
 * `symbol-index-summary-budget.test.mjs` exercise `assessBatchCompleteness`
 * only, so reverting `main()` to derive `complete` from a null count would have
 * left them all green — "despite the comments claiming they guard against that
 * regression". That was accurate, and it is the vacuous-pass case
 * (`references/verification-discipline.md` §3) in its purest form: the guard's
 * stated subject was a layer it never touched.
 *
 * So this drives the real CLI end to end — stdin records in, stdout envelope
 * out — with a fake `claude` binary standing in for the provider via the cli
 * backend, whose `normaliseCliOutput` carries `stop_reason` through. Nothing is
 * stubbed inside `summarise.mjs`, so `summariseBatch`'s return shape and
 * `main()`'s aggregation are both on the measured path.
 *
 * @module tests/symbol-index-summarise-propagation
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUMMARISE = path.join(REPO_ROOT, 'scripts', 'symbol-index', 'summarise.mjs');

let tmpDir;

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'summarise-prop-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

/**
 * A stand-in for the `claude` binary. The cli backend's `normaliseCliOutput`
 * reads `stop_reason` off this envelope, which is how a truncation signal
 * reaches `summariseBatch` without stubbing anything inside it.
 */
function writeFakeClaude({ result, stopReason }) {
  const scriptPath = path.join(tmpDir, 'fake-claude.mjs');
  const payload = JSON.stringify({
    result,
    stop_reason: stopReason,
    usage: { input_tokens: 10, output_tokens: 20 },
    total_cost_usd: 0.0001,
    num_turns: 1,
  });
  fs.writeFileSync(
    scriptPath,
    `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(payload)});});\n`,
  );
  if (process.platform === 'win32') {
    const cmdPath = path.join(tmpDir, 'fake-claude.cmd');
    fs.writeFileSync(cmdPath, `@echo off\r\nnode "${scriptPath}" %*\r\n`);
    return cmdPath;
  }
  const shPath = path.join(tmpDir, 'fake-claude.sh');
  fs.writeFileSync(shPath, `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`, { mode: 0o755 });
  return shPath;
}

function symbolRecord(i) {
  return JSON.stringify({
    type: 'symbol',
    symbolName: `sym${i}`,
    kind: 'function',
    filePath: `src/mod${i}.mjs`,
    startLine: 1,
    endLine: 9,
    bodyText: `function sym${i}() { return ${i}; }`,
  });
}

/**
 * Generous, because the summariser loads `config.mjs` and the model resolver on
 * a cold start and CI startup varies — but FINITE, which is the point. Without
 * it a regression that stalls the summariser, or a fake provider left waiting
 * on stdin, blocks the test worker indefinitely instead of failing: node then
 * reports the parent's cancellation rather than the defect, which is how a real
 * hang reads as unrelated flakiness.
 */
const SUBPROCESS_TIMEOUT_MS = 120_000;

/** Run the real summariser CLI against the fake provider; return its envelope. */
function runSummariser({ result, stopReason, symbols = 2 }) {
  const bin = writeFakeClaude({ result, stopReason });
  const stdin = Array.from({ length: symbols }, (_, i) => symbolRecord(i + 1)).join('\n') + '\n';
  const r = spawnSync(process.execPath, [SUMMARISE], {
    cwd: REPO_ROOT,
    input: stdin,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    timeout: SUBPROCESS_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env: {
      ...process.env,
      // The cli backend needs no API key, which is what lets this run offline.
      CLAUDE_BACKEND: 'cli',
      CLAUDE_BIN: bin,
      ANTHROPIC_API_KEY: '',
      AZURE_OPENAI_ENDPOINT: '',
      ARCH_INDEX_BATCH_SIZE: String(symbols),
      LEARNING_DISABLE: '1',
      AUDIT_DB_URL: '',
      MODEL_CATALOG_REFRESH: 'skip',
    },
  });
  // A TIMEOUT OR SPAWN FAILURE IS NOT AN EMPTY RESULT. `spawnSync` reports a
  // timeout as `error.code === 'ETIMEDOUT'` with a null status, which would
  // otherwise fall through to "no summary envelope" and fail on a misleading
  // assertion about completeness instead of naming the hang. Fail here, loudly,
  // carrying stderr — the assertion that follows can then only be about the
  // thing it claims to test.
  if (r.error) {
    const timedOut = r.error.code === 'ETIMEDOUT';
    assert.fail(
      `summariser subprocess ${timedOut ? `timed out after ${SUBPROCESS_TIMEOUT_MS}ms` : 'failed to run'}`
      + ` (${r.error.code || r.error.message}). stderr: ${(r.stderr || '(empty)').slice(0, 800)}`,
    );
  }
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
  const records = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return {
    status: r.status,
    signal: r.signal,
    stderr: r.stderr || '',
    records,
    summary: records.find(x => x.type === 'summary') || null,
  };
}

describe('summarise CLI: the completeness verdict reaches the envelope', () => {
  // THE DEFINING CASE, and the one four rounds of unit tests could not see:
  // every numbered entry present, so every null-count is zero, and the provider
  // still reports it stopped at the ceiling. `complete` must be false.
  it('a full slate + stop_reason max_tokens emits complete:false and truncatedBatches:1', () => {
    const out = runSummariser({ result: '1. does a thing\n2. does another thing', stopReason: 'max_tokens' });
    assert.equal(out.status, 0, `CLI should succeed; stderr: ${out.stderr.slice(0, 400)}`);
    assert.ok(out.summary, 'a summary envelope must be emitted');
    // Since the split-retry change the CUT last entry is not trusted: it is
    // re-asked alone, and this fake truncates that request too, so it ends
    // unsummarised rather than being counted on the strength of a filled slot.
    assert.equal(out.summary.counts.summarised, 1, 'the cut last entry must NOT count as summarised');
    assert.equal(out.summary.counts.missing, 1);
    assert.equal(out.summary.complete, false, 'the verdict must survive the trip from the provider to stdout');
    assert.equal(out.summary.counts.truncatedBatches, 1);
    assert.equal(out.summary.counts.incompleteBatches, 1);
  });

  // POSITIVE CONTROL. Without this the assertion above could be satisfied by a
  // CLI that always reports incomplete, which would be a different bug.
  it('a full slate + stop_reason end_turn emits complete:true', () => {
    const out = runSummariser({ result: '1. does a thing\n2. does another thing', stopReason: 'end_turn' });
    assert.equal(out.status, 0, `stderr: ${out.stderr.slice(0, 400)}`);
    assert.equal(out.summary.complete, true);
    assert.equal(out.summary.counts.incompleteBatches, 0);
    assert.equal(out.summary.counts.truncatedBatches, 0);
    assert.equal(out.summary.counts.summarised, 2);
  });

  it('a short list is incomplete and attributed to the MODEL, not the ceiling', () => {
    const out = runSummariser({ result: '1. only the first one', stopReason: 'end_turn' });
    assert.equal(out.status, 0, `stderr: ${out.stderr.slice(0, 400)}`);
    // The skipped entry is re-asked alone; this fake answers any request with the
    // same one-entry list, so the re-ask succeeds. First attempt still reported.
    assert.equal(out.summary.counts.summarised, 2);
    assert.equal(out.summary.counts.missing, 0);
    assert.equal(out.summary.complete, true);
    assert.equal(out.summary.counts.incompleteBatches, 1);
    assert.equal(out.summary.counts.truncatedBatches, 0, 'nothing says the ceiling was hit — the model skipped one');
  });

  it('the INCOMPLETE batch line names the case on stderr, so an operator can act', () => {
    const cut = runSummariser({ result: '1. a\n2. b', stopReason: 'max_tokens' });
    assert.match(cut.stderr, /INCOMPLETE batch/);
    assert.match(cut.stderr, /all 2 entries present but the last may be cut mid-sentence/);
    const skipped = runSummariser({ result: '1. a', stopReason: 'end_turn' });
    assert.match(skipped.stderr, /INCOMPLETE batch/);
    assert.match(skipped.stderr, /1\/2 symbols have no summary/);
  });

  it('every symbol is still emitted with its purposeSummary, truncated or not', () => {
    const out = runSummariser({ result: '1. first\n2. second', stopReason: 'max_tokens' });
    const syms = out.records.filter(r => r.type === 'symbol');
    assert.equal(syms.length, 2, 'an incomplete batch must not drop records — it must FLAG them');
    assert.deepEqual(syms.map(s => s.purposeSummary), ['first', null], 'the cut entry is left unsummarised, never filled');
  });
});
