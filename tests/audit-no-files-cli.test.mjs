/**
 * @fileoverview A1 integration test — the guard must fire END-TO-END through the CLI:
 * a code audit whose plan resolves to ZERO implementation files exits non-zero, prints
 * the refusal, and writes NO (hollow) result file. The pure predicate is unit-tested in
 * audit-subject-file-guard.test.mjs; this locks the WIRING (guard placement + main()'s
 * fail-loud catch) so a future refactor can't silently restore the hollow-verdict bug.
 * Per the testing doctrine this is a "silent regression, likely + expensive" seam.
 *
 * No API call is made: the guard throws BEFORE any GPT pass, so a dummy OpenAI key
 * suffices — BUT `main()` unconditionally runs `initAuditBrief()` first (Gemini Flash
 * → Claude Haiku → regex fallback chain), and Claude Haiku's `sdk`/`cli` backend
 * selection reads `CLAUDE_BACKEND` from the environment. Without pinning it here, a
 * developer machine with `CLAUDE_BACKEND=cli` set locally (routes through a real `claude
 * -p` subprocess) causes this test to make a real, slow LLM call before the guard ever
 * fires — 76-84s observed, dangerously close to the 90s timeout and the actual root
 * cause of this test's documented intermittent CI flakiness. `CLAUDE_BACKEND: 'sdk'`
 * below (paired with the already-empty `ANTHROPIC_API_KEY`) forces the fast, real
 * "no API call is made" regex-only brief fallback the docstring always claimed.
 */
import test from 'node:test';

/**
 * Kill budget for the audit CLI spawns below — a NO-HANG SAFETY NET, not a
 * latency probe.
 *
 * Every assertion in this file is about the CLI's *output and exit code*, so
 * the budget's only job is to separate "terminated" from "hung forever". Sizing
 * it near the observed happy path converts CPU contention into a false failure,
 * and that is exactly what happened: the A1 subtest was killed at 90,207ms
 * against a 90,000ms cap in a pre-push sandbox on 2026-09-04, blocking a push
 * whose content could not affect audit latency — while passing in 35.6s when
 * the file runs alone.
 *
 * 90,000 was doubly wrong because it also COLLIDED with an inner budget: the
 * run's own passes announce `timeout: 90s`, so the wrapper could never
 * accommodate a subject legitimately allowed to spend the whole cap. An outer
 * kill budget must exceed the largest inner budget it contains, with headroom.
 *
 * Declared ONCE and shared by both spawns on purpose. The identical class was
 * fixed twice on 2026-09-04 (`71cc0c40`, and the sync fixture's nested-timeout
 * collision before it) and both write-ups name the same root cause: the
 * reasoning was recorded at one call site while the value the other sites used
 * stayed tight. `tests/prepush-worktree-anchor.test.mjs` has no bearing here;
 * the guard for THIS file is the last assertion in it.
 *
 * A genuine infinite hang — the regression these tests exist to catch — still
 * fails, five minutes later.
 */
const CLI_KILL_BUDGET_MS = 300_000;

/**
 * Env for the audit CLI spawns. `CLAUDE_BACKEND: 'sdk'` (with an empty
 * ANTHROPIC_API_KEY) forces the fast regex-only brief; without it a developer
 * machine with `CLAUDE_BACKEND=cli` routes through a real `claude -p`
 * subprocess and makes a slow LLM call before the guard ever fires.
 */
const CLI_ENV = Object.freeze({
  OPENAI_API_KEY: 'sk-test-dummy-key', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '',
  CLAUDE_BACKEND: 'sdk',
  MODEL_CATALOG_REFRESH: 'skip', LEARNING_DISABLE: '1', AUDIT_DB_URL: '',
});

/** Spawn the audit CLI; return `{exitCode, output}` with stdout+stderr merged. */
function runAuditCli(args) {
  try {
    execFileSync(process.execPath, args, {
      encoding: 'utf8',
      env: { ...process.env, ...CLI_ENV },
      timeout: CLI_KILL_BUDGET_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, output: '' };
  } catch (e) {
    return { exitCode: e.status ?? 1, output: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('CLI: a code audit over a plan whose files do not exist refuses (exit≠0, no result file)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-a1-'));
  const plan = path.join(dir, 'plan.md');
  const out = path.join(dir, 'result.json');
  fs.writeFileSync(plan, '# Plan\n\nImplement `src/totally-nonexistent-impl-xyz.mjs` and `src/another-ghost-file.mjs`.\n');

  const { exitCode, output } = runAuditCli(['scripts/openai-audit.mjs', 'code', plan, '--scope', 'plan', '--out', out]);

  assert.notEqual(exitCode, 0, `expected non-zero exit; got ${exitCode}. output:\n${output.slice(-800)}`);
  assert.match(output, /0 implementation files|refusing to emit a verdict|reached the prompt/i, 'must print the A1 refusal');
  assert.ok(!fs.existsSync(out), 'must NOT write a hollow result file when refusing');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('CLI: an explicit but unreadable --diff (the base..HEAD range-misuse) fails fast', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-diff-'));
  const plan = path.join(dir, 'plan.md');
  const out = path.join(dir, 'result.json');
  fs.writeFileSync(plan, '# Plan\n\nImplement `src/x.mjs`.\n');

  // `HEAD~1..HEAD` is a git RANGE, not a file → the read throws → must fail fast,
  // not warn-and-proceed (quasi-silent degradation). Fires before any GPT pass.
  const { exitCode, output } = runAuditCli(['scripts/openai-audit.mjs', 'code', plan, '--scope', 'plan', '--diff', 'HEAD~1..HEAD', '--out', out]);

  assert.notEqual(exitCode, 0, `expected non-zero exit; got ${exitCode}. output:\n${output.slice(-800)}`);
  assert.match(output, /not a readable file|git RANGE|unified-diff FILE/i, 'must explain the --diff misuse');
  assert.ok(!fs.existsSync(out), 'must NOT write a result file');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/**
 * The guard the docstring on `CLI_KILL_BUDGET_MS` points at.
 *
 * This class has been fixed three times on one day and recurred each time in the
 * same shape: the reasoning gets written down at ONE call site while the other
 * sites keep a tight literal. A ratchet on the literal is what stops the next
 * edit from quietly reintroducing one — there is no compiler for "this number is
 * a safety net, not a latency probe".
 */
test('every child-process kill budget here is the shared constant, never a literal', () => {
  const src = fs.readFileSync(new URL(import.meta.url), 'utf8')
    // Comments are where the measured values are DOCUMENTED (`timeout: 90s`,
    // the 90,000ms write-up). Scanning them would make the guard fire on its
    // own explanation, and the fix for that is deleting the explanation.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const literals = [...src.matchAll(/timeout:\s*([0-9][0-9_]*)/g)].map(m => m[1]);
  assert.deepEqual(
    literals, [],
    `numeric timeout literal(s) ${literals.join(', ')} — use CLI_KILL_BUDGET_MS. `
    + 'A per-site budget sized near the happy path turns CPU contention into a false failure; '
    + 'see the constant\'s docstring for the three measured recurrences.',
  );
  // Positive control: the regex above must be able to see a literal at all,
  // or the assertion passes because it matched nothing anywhere.
  // Assembled from fragments so the control cannot match ITSELF in the scan above.
  const control = `timeout:${' '}90000`;
  assert.equal([...control.matchAll(/timeout:\s*([0-9][0-9_]*)/g)].length, 1);

  // The budget must clear the largest inner budget the subject can spend. The
  // audit's own passes announce `timeout: 90s`; a wrapper at or below that can
  // never accommodate a subject legitimately using its whole cap.
  const INNER_PASS_BUDGET_MS = 90_000;
  assert.ok(
    CLI_KILL_BUDGET_MS > INNER_PASS_BUDGET_MS * 2,
    `kill budget ${CLI_KILL_BUDGET_MS}ms must clear the ${INNER_PASS_BUDGET_MS}ms inner pass budget with headroom`,
  );
});
