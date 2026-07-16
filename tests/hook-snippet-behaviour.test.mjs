/**
 * @fileoverview Hook-snippet behaviour test.
 *
 * Extracts the operator-paste migration-drift hook snippet from AGENTS.md
 * (matched by the `managed-by: migration-drift-detector` marker), then
 * runs it through `bash -e` with a mocked `node` shim that returns each
 * of {0,1,2,3}. Asserts the snippet is "advisory, never blocks" —
 * non-zero exits from `--check-drift` MUST NOT abort the parent shell.
 *
 * This is the load-bearing assertion behind the
 * `EXIT=0 ; cmd || EXIT=$?` defensive pattern. If `set -e` ever creeps
 * in and that pattern regresses, this test fires.
 *
 * Plan: docs/plans/migration-drift-detector.md §8 + R3-audit H1.
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
// The operator-paste snippet was moved out of AGENTS.md (kept lean) into the
// Postgres operations runbook; the test follows the content to its new home.
const SNIPPET_DOC = path.join(REPO_ROOT, 'docs', 'runbooks', 'postgres-parity.md');

/**
 * Pull the snippet body out of the runbook. Matches the first ```bash
 * fenced block that contains the marker comment.
 */
function extractSnippet() {
  const src = fs.readFileSync(SNIPPET_DOC, 'utf-8');
  const marker = '# managed-by: migration-drift-detector';
  const idx = src.indexOf(marker);
  if (idx < 0) throw new Error(`marker not found in ${SNIPPET_DOC}: ${marker}`);
  // Walk backwards to find the opening fence.
  const openFence = src.lastIndexOf('```bash', idx);
  const closeFence = src.indexOf('```', idx);
  if (openFence < 0 || closeFence < 0) throw new Error('snippet fences not found');
  return src.slice(openFence + '```bash'.length, closeFence).trim();
}

/**
 * Run the snippet under `bash -e` (set -e enabled) with a mocked `node`
 * binary on PATH that exits with `mockExit`. Returns `{status, stdout, stderr}`.
 */
function runSnippet(snippet, mockExit) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-snippet-'));
  try {
    // Mock `node` shim: a bash script that prints "MOCK node called" then
    // exits with the requested code.
    const nodeShim = path.join(tmp, 'node');
    fs.writeFileSync(
      nodeShim,
      `#!/bin/sh\necho "MOCK node --check-drift fired" >&2\nexit ${mockExit}\n`,
      { mode: 0o755 }
    );

    // Also need a `package.json` so the `[ -f "package.json" ]` test passes.
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"mock"}\n');

    // Wrap the snippet in `set -e` + a sentinel echo after to prove the
    // shell didn't exit early.
    const harness = `#!/bin/bash
set -e
export AUDIT_DB_URL='postgres://mock'
cd '${tmp.replace(/'/g, "'\\''")}'
${snippet}
echo "SENTINEL_REACHED"
`;
    const harnessPath = path.join(tmp, 'run.sh');
    fs.writeFileSync(harnessPath, harness, { mode: 0o755 });

    const r = spawnSync('bash', [harnessPath], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${tmp}${path.delimiter}${process.env.PATH}` },
    });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

// ── tests ──────────────────────────────────────────────────────────────────

// R1-audit H4: previously this used `if (!hasBash()) return;` which silently
// no-ops on Windows-native (no bash). Switched to `t.skip(...)` so the absence
// is REPORTED — under WSL/git-bash on Windows + Linux/macOS, all 5 tests run;
// on Windows-native the suite reports 5 skips, never silent-pass.
const BASH_AVAILABLE = hasBash();

describe('hook-snippet — advisory, never blocks', () => {
  let snippet;
  before(() => {
    if (!BASH_AVAILABLE) return;
    snippet = extractSnippet();
  });

  it('extracts the snippet from AGENTS.md', (t) => {
    if (!BASH_AVAILABLE) return t.skip('bash not on PATH (Windows-native? install git-bash/WSL)');
    assert.ok(snippet.length > 0, 'snippet should not be empty');
    assert.match(snippet, /managed-by: migration-drift-detector/);
    assert.match(snippet, /AUDIT_DB_URL/);
    assert.match(snippet, /\|\| DRIFT_EXIT=\$\?/);
  });

  it('exit 0 → snippet stays silent + parent shell reaches sentinel', (t) => {
    if (!BASH_AVAILABLE) return t.skip('bash not on PATH');
    const r = runSnippet(snippet, 0);
    assert.equal(r.status, 0, `expected status 0 with snippet exit 0; stderr=${r.stderr}`);
    assert.match(r.stdout, /SENTINEL_REACHED/);
    assert.doesNotMatch(r.stderr, /migration-drift detected/);
    assert.doesNotMatch(r.stderr, /ledger missing/);
  });

  it('exit 1 → drift warning + parent shell reaches sentinel (NOT aborted)', (t) => {
    if (!BASH_AVAILABLE) return t.skip('bash not on PATH');
    const r = runSnippet(snippet, 1);
    assert.equal(r.status, 0, `parent must continue under set -e despite exit 1; status=${r.status} stderr=${r.stderr}`);
    assert.match(r.stdout, /SENTINEL_REACHED/, 'sentinel must be reached');
    const combined = r.stdout + r.stderr;
    assert.match(combined, /migration-drift detected/);
    assert.match(combined, /--migrate/);
  });

  it('exit 3 → bootstrap warning + parent shell reaches sentinel', (t) => {
    if (!BASH_AVAILABLE) return t.skip('bash not on PATH');
    const r = runSnippet(snippet, 3);
    assert.equal(r.status, 0, `parent must continue under set -e despite exit 3; status=${r.status}`);
    assert.match(r.stdout, /SENTINEL_REACHED/);
    const combined = r.stdout + r.stderr;
    assert.match(combined, /ledger missing/);
    assert.match(combined, /--adopt/);
  });

  it('exit 2 → generic infra warning + parent shell reaches sentinel', (t) => {
    if (!BASH_AVAILABLE) return t.skip('bash not on PATH');
    const r = runSnippet(snippet, 2);
    assert.equal(r.status, 0, `parent must continue under set -e despite exit 2; status=${r.status}`);
    assert.match(r.stdout, /SENTINEL_REACHED/);
    const combined = r.stdout + r.stderr;
    assert.match(combined, /infra error/);
  });
});
