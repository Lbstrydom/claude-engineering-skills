/**
 * @fileoverview The `--require` refusals happen at the CLI door, before any read, store write or model call (exit 2,
 * naming the offending path). Spawned, because the exit code and the stderr are the contract.
 *
 * The child env is scrubbed of every provider credential and store DSN: a refusal must not depend on whose machine runs it,
 * and a run that got past the door would have nothing to spend.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAN = 'docs/plans/copilot-feedback-item4.md';

function runCli(args) {
  const env = { ...process.env, LEARNING_DISABLE: '1', MODEL_CATALOG_REFRESH: 'skip', AUDIT_DB_URL: '', AUDIT_NO_PREFLIGHT: '1' };
  for (const k of Object.keys(env)) if (/^(AZURE_|OPENAI_|ANTHROPIC_|GEMINI_|GOOGLE_)/.test(k)) delete env[k];
  return spawnSync(process.execPath, ['scripts/openai-audit.mjs', ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
}

describe('openai-audit --require: refused at the door (exit 2, nothing read or sent)', () => {
  it('a path outside the repository refuses and names the path', () => {
    const r = runCli(['code', PLAN, '--require', '../outside-the-repo.txt']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--require refused/);
    assert.match(r.stderr, /\.\.\/outside-the-repo\.txt: resolves outside the repository/);
  });
  it('a flag with no value refuses (an empty list must never read as "nothing required")', () => {
    const r = runCli(['code', PLAN, '--require']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--require needs a value/);
  });
  it('a plan audit refuses: only a code audit reads files, and a silently ignored declaration is the defect', () => {
    const r = runCli(['plan', PLAN, '--require', 'package-lock.json']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /applies to a code audit/);
  });
  it('control: the same invocation WITHOUT --require falls through to the usage check (exit 1, not 2)', () => {
    // An unknown mode stops at the usage message, before any read or spend; a valid mode would start a real, paid audit.
    const r = runCli(['bogus-mode', PLAN]);
    assert.equal(r.status, 1, r.stderr);
    assert.doesNotMatch(r.stderr, /--require refused/);
  });
});
