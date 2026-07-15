/**
 * @fileoverview Non-blocking behaviour test for the opportunistic
 * weekly-maintenance block added to install-prepush-hook.mjs's HOOK_BODY.
 *
 * HOOK_BODY is a private template literal (not exported — importing the
 * module directly would run its main() and write real hook files into
 * every consumer repo). Instead this extracts the snippet as raw text by
 * marker, matching the technique in hook-snippet-behaviour.test.mjs, and
 * runs it under `bash -e` with a mocked `node` shim.
 *
 * The load-bearing assertion: the block must be genuinely BACKGROUNDED, not
 * just exit-code-suppressed — round-1 code-audit H1 found the original
 * `node ... || true` still ran synchronously (`|| true` only swallows the
 * exit code), so `git push` could block for up to ~40 minutes once overdue.
 * The fix wraps the invocation in a detached `( cmd & )` subshell writing to
 * a log file instead of the hook's inherited stderr; this test proves BOTH
 * that the parent shell returns immediately (never blocks) AND that the
 * backgrounded process still actually ran (polls the log file — detaching
 * must not silently mean "never launches").
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasBash } from './lib/hook-test-helpers.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(__filename, '..', '..');
const SOURCE_FILE = path.join(REPO_ROOT, 'scripts', 'install-prepush-hook.mjs');

/**
 * Extract the FULL HOOK_BODY template literal (not just the maintenance
 * snippet) — needed to prove the round-4 Gemini gate G1 regression stays
 * fixed: the maintenance block must run even when `docs/plans` is absent,
 * which only the real ORDERING relative to that early `exit 0` can prove.
 * HOOK_BODY isn't exported (importing the module runs its main()).
 */
function extractFullHookBody() {
  const src = fs.readFileSync(SOURCE_FILE, 'utf-8');
  const startMarker = 'const HOOK_BODY = `#!/bin/sh';
  const startIdx = src.indexOf(startMarker);
  if (startIdx < 0) throw new Error('HOOK_BODY template start not found');
  const bodyStart = startIdx + 'const HOOK_BODY = `'.length;
  const endIdx = src.indexOf('\n`;', bodyStart);
  if (endIdx < 0) throw new Error('HOOK_BODY template end not found');
  // The source contains JS-escaped backticks (\`) for literal backticks in
  // the generated shell script (e.g. inside echo messages) — unescape them.
  return src.slice(bodyStart, endIdx).replace(/\\`/g, '`');
}

function extractSnippet() {
  const src = fs.readFileSync(SOURCE_FILE, 'utf-8');
  const marker = '# ── Opportunistic weekly local maintenance';
  const idx = src.indexOf(marker);
  if (idx < 0) throw new Error(`marker not found in ${SOURCE_FILE}: ${marker}`);
  // Stop at the closing `fi` of the guarded block — the hook's own trailing
  // `exit 0` (its final line) is NOT part of this snippet; including it would
  // swallow anything a test appends afterward, since it always terminates
  // the script before reaching it.
  const endMarker = '\nfi\n';
  const endIdx = src.indexOf(endMarker, idx);
  if (endIdx < 0) throw new Error('end marker "fi" not found after snippet start');
  return src.slice(idx, endIdx + endMarker.length);
}

function runSnippet(snippet, { mockExit, maintScriptExists, mockDelayMs = 0 }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-hook-snippet-'));
  try {
    const nodeShim = path.join(tmp, 'node');
    // An optional sleep simulates the real 8-check, minutes-long run — proves
    // the parent reaches SENTINEL_REACHED without waiting for it.
    const sleepLine = mockDelayMs > 0 ? `sleep ${(mockDelayMs / 1000).toFixed(2)}\n` : '';
    fs.writeFileSync(
      nodeShim,
      `#!/bin/sh\n${sleepLine}echo "MOCK maintenance-checks.mjs fired"\nexit ${mockExit}\n`,
      { mode: 0o755 },
    );

    if (maintScriptExists) {
      fs.mkdirSync(path.join(tmp, 'scripts', '.claude-skills'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'scripts', '.claude-skills', 'maintenance-checks.mjs'), '// mock\n');
    }

    const harness = `#!/bin/bash
set -e
cd '${tmp.replace(/'/g, "'\\''")}'
${snippet}
echo "SENTINEL_REACHED"
`;
    const harnessPath = path.join(tmp, 'run.sh');
    fs.writeFileSync(harnessPath, harness, { mode: 0o755 });

    const startedAt = Date.now();
    const r = spawnSync('bash', [harnessPath], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${tmp}${path.delimiter}${process.env.PATH}` },
    });
    const wallMs = Date.now() - startedAt;
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', wallMs, tmp };
  } finally {
    // Caller is responsible for cleanup once done polling the log file —
    // returning tmp here, not removing it, since the backgrounded job may
    // still be writing after bash itself has returned.
  }
}

/** Poll for the log file to contain the mock's output — the backgrounded
 * job runs asynchronously to the harness returning, so a single synchronous
 * read right after spawnSync would race it. */
function waitForLog(tmp, timeoutMs = 2000) {
  const logPath = path.join(tmp, '.audit-loop', 'last-maintenance.log');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, 'utf-8');
      if (content.includes('MOCK maintenance-checks.mjs fired')) return content;
    }
  }
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : null;
}

const BASH_AVAILABLE = hasBash();

describe('maintenance-hook-snippet — opportunistic, backgrounded, never blocks the push', () => {
  let snippet;
  before(() => {
    if (!BASH_AVAILABLE) return;
    snippet = extractSnippet();
  });

  it('extracts the snippet from install-prepush-hook.mjs', (t) => {
    if (!BASH_AVAILABLE) return t.skip('bash not on PATH');
    assert.ok(snippet.length > 0);
    assert.match(snippet, /AUDIT_LOOP_WEEKLY_MAINTENANCE/);
    assert.match(snippet, /--opportunistic/);
    // Round-1 audit H1: must be backgrounded via a detached subshell, not a
    // synchronous `|| true` (which only suppresses the exit code).
    assert.match(snippet, /\(\s*node .* & \)/);
    assert.match(snippet, /last-maintenance\.log/);
  });

  it('synced maintenance-checks.mjs absent → skipped silently, sentinel reached, no log written', (t) => {
    if (!BASH_AVAILABLE) return t.skip('bash not on PATH');
    const r = runSnippet(snippet, { mockExit: 0, maintScriptExists: false });
    try {
      assert.equal(r.status, 0);
      assert.match(r.stdout, /SENTINEL_REACHED/);
      assert.equal(fs.existsSync(path.join(r.tmp, '.audit-loop', 'last-maintenance.log')), false, 'node shim must not fire when the synced file is absent');
    } finally {
      fs.rmSync(r.tmp, { recursive: true, force: true });
    }
  });

  it('a slow (simulated multi-minute) check does NOT block the parent shell', (t) => {
    if (!BASH_AVAILABLE) return t.skip('bash not on PATH');
    const r = runSnippet(snippet, { mockExit: 0, maintScriptExists: true, mockDelayMs: 800 });
    try {
      assert.equal(r.status, 0, `stderr=${r.stderr}`);
      assert.match(r.stdout, /SENTINEL_REACHED/);
      // The whole point of the fix: the parent returns almost immediately,
      // NOT after the (simulated) 800ms check completes.
      assert.ok(r.wallMs < 700, `parent shell took ${r.wallMs}ms — should return well before the 800ms simulated check completes (not blocking)`);
      const log = waitForLog(r.tmp);
      assert.ok(log && log.includes('MOCK maintenance-checks.mjs fired'), 'the backgrounded process must still actually run, not just be detached into nothing');
    } finally {
      fs.rmSync(r.tmp, { recursive: true, force: true });
    }
  });

  it('maintenance-checks.mjs exits 1 (error) → parent shell still reaches sentinel (never blocks push)', (t) => {
    if (!BASH_AVAILABLE) return t.skip('bash not on PATH');
    const r = runSnippet(snippet, { mockExit: 1, maintScriptExists: true });
    try {
      assert.equal(r.status, 0, `parent must continue under set -e despite exit 1; status=${r.status} stderr=${r.stderr}`);
      assert.match(r.stdout, /SENTINEL_REACHED/);
      // Wait for the backgrounded mock to finish before rmSync — on Windows,
      // deleting the tmp dir while the still-running child holds an open
      // handle on the log file throws EBUSY (the whole point of the fix is
      // that the parent returns BEFORE the background job finishes).
      waitForLog(r.tmp);
    } finally {
      fs.rmSync(r.tmp, { recursive: true, force: true });
    }
  });

  it('maintenance-checks.mjs exits 99 (crash) → parent shell still reaches sentinel', (t) => {
    if (!BASH_AVAILABLE) return t.skip('bash not on PATH');
    const r = runSnippet(snippet, { mockExit: 99, maintScriptExists: true });
    try {
      assert.equal(r.status, 0, `parent must continue under set -e despite exit 99; status=${r.status}`);
      assert.match(r.stdout, /SENTINEL_REACHED/);
      waitForLog(r.tmp); // see EBUSY note above
    } finally {
      fs.rmSync(r.tmp, { recursive: true, force: true });
    }
  });
});

describe('maintenance-hook — runs even when the code-audit section early-exits (round-4 Gemini gate G1)', () => {
  // Gemini's Step-7 review caught what 4 GPT rounds missed: the maintenance
  // block was placed at the END of the hook, AFTER the code-audit section's
  // early `exit 0`s for "docs/plans absent" / "no active plan file" — the
  // NORMAL state on most pushes. It would almost never actually run. Fixed
  // by moving it before those exits. This test runs the REAL, FULL hook
  // body (not just the extracted snippet) with no docs/plans directory —
  // the exact condition that used to starve it — and proves the mock still
  // fires before the hook's early exit.
  let fullBody;
  before(() => {
    if (!BASH_AVAILABLE) return;
    fullBody = extractFullHookBody();
  });

  it('extracted body still contains both the maintenance block and the docs/plans early-exit', (t) => {
    if (!BASH_AVAILABLE) return t.skip('bash not on PATH');
    assert.match(fullBody, /AUDIT_LOOP_WEEKLY_MAINTENANCE/);
    assert.match(fullBody, /PLANS_DIR="docs\/plans"/);
    // The maintenance block's marker must appear BEFORE the early-exit line —
    // this is the literal regression Gemini caught.
    const maintIdx = fullBody.indexOf('# ── Opportunistic weekly local maintenance');
    const plansIdx = fullBody.indexOf('PLANS_DIR="docs/plans"');
    assert.ok(maintIdx >= 0 && plansIdx >= 0);
    assert.ok(maintIdx < plansIdx, 'maintenance block must be positioned before the docs/plans early-exit');
  });

  it('fires even when docs/plans does not exist (the exact starved-schedule regression)', (t) => {
    if (!BASH_AVAILABLE) return t.skip('bash not on PATH');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-hook-full-'));
    try {
      const nodeShim = path.join(tmp, 'node');
      fs.writeFileSync(nodeShim, `#!/bin/sh\necho "MOCK maintenance-checks.mjs fired"\nexit 0\n`, { mode: 0o755 });
      fs.mkdirSync(path.join(tmp, 'scripts', '.claude-skills'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'scripts', '.claude-skills', 'maintenance-checks.mjs'), '// mock\n');
      // Deliberately NO docs/plans directory — the common state this regression starved on.

      const hookPath = path.join(tmp, 'hook.sh');
      fs.writeFileSync(hookPath, fullBody, { mode: 0o755 });

      const r = spawnSync('bash', [hookPath], {
        encoding: 'utf-8',
        cwd: tmp,
        env: { ...process.env, PATH: `${tmp}${path.delimiter}${process.env.PATH}` },
      });
      assert.equal(r.status, 0, `hook must still exit 0 (the code-audit section's own early exit); stderr=${r.stderr}`);
      const log = waitForLog(tmp);
      assert.ok(log && log.includes('MOCK maintenance-checks.mjs fired'), 'maintenance block must have fired despite docs/plans being absent');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
