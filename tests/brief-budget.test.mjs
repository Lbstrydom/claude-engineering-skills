/**
 * @fileoverview Brief generation must never be able to block an audit.
 *
 * It is OPTIONAL context enrichment — the regex-only brief is a complete
 * fallback — but `initAuditBrief()` is awaited inline by openai-audit.mjs with
 * no watchdog of its own, so a hung provider hung the whole GPT audit
 * (observed as exit 143 in a harness). The `.catch(() => {})` at one call site
 * catches a rejection, which a hang is not.
 *
 * Plan: docs/plans/debt-burndown-workstreams.md §4 WS-B1.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'lib', 'context.mjs'), 'utf-8');

describe('the brief step is bounded', () => {
  it('has ONE wall-clock deadline for the whole step', () => {
    assert.match(SRC, /BRIEF_TOTAL_TIMEOUT_MS/);
    assert.match(SRC, /const deadlineAt = Date\.now\(\) \+ BRIEF_TOTAL_TIMEOUT_MS/,
      'started once — two per-provider budgets must not be able to sum past the total');
  });

  it('each attempt gets min(perAttempt, remaining)', () => {
    assert.match(SRC, /Math\.min\(BRIEF_ATTEMPT_TIMEOUT_MS, left\)/);
  });

  it('skips a provider with no useful room rather than starting it', () => {
    assert.match(SRC, /left < BRIEF_MIN_ATTEMPT_MS/);
    assert.match(SRC, /skipping \$\{label\}/);
  });

  it('passes the budget INTO the transport, not just races it', () => {
    // The transports honour {timeoutMs} and the cli path kills its process
    // tree; racing alone would leave the child running.
    assert.match(SRC, /timeoutMs: budget, signal: controller\.signal/,
      'the Claude leg must hand its budget AND an abort signal to the client');
    assert.match(SRC, /abortSignal: controller\.signal/,
      'the Gemini leg had NO bound at all — it must be abortable');
  });

  it('consumes a late rejection so it cannot surface after fallback', () => {
    assert.match(SRC, /promise\.catch\(\(\) => \{\}\);/);
  });

  it('a timeout degrades to the next provider, never throws', () => {
    // _llmCondense returns null on total failure; the caller uses regex-only.
    assert.match(SRC, /return null; \/\/ Both failed/);
  });

  it('the budget is env-overridable for a slow link', () => {
    assert.match(SRC, /process\.env\.BRIEF_TOTAL_TIMEOUT_MS/);
    assert.match(SRC, /process\.env\.BRIEF_ATTEMPT_TIMEOUT_MS/);
  });
});

describe('the budget actually elapses', () => {
  it('a never-resolving attempt is cut off at its budget', async () => {
    // Exercises the race shape itself rather than the module's providers
    // (which would need real keys): a promise that never settles must lose to
    // the guard, and must do so in about the budget, not at 120s.
    const started = Date.now();
    const never = new Promise(() => {});
    never.catch(() => {});
    let timer;
    const guard = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('budget')), 60); });
    await assert.rejects(() => Promise.race([never, guard]), /budget/);
    clearTimeout(timer);
    assert.ok(Date.now() - started < 5_000, 'must not wait for the default 120s transport timeout');
  });
});
