import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'audit-loop.mjs');
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, LEARNING_DISABLE: '1' } });

test('audit-loop refuses a typo of a safety flag instead of running the round', () => {
  const r = run('code', 'docs/plans/does-not-exist.md', '--past-capp', 'because');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown flag "--past-capp"/);
});

test('audit-loop accepts --flag=value for a known flag (guard checks the name half)', () => {
  // Missing plan file stops the run later; the point is that the guard does not refuse it.
  const r = run('code', 'docs/plans/does-not-exist.md', '--scope=diff', '--dry-run');
  assert.doesNotMatch(r.stderr, /unknown flag/);
});

test('a reason value is positional, never checked as a flag', () => {
  const r = run('code', 'docs/plans/does-not-exist.md', '--meta-override', 'admitted round was productive', '--dry-run');
  assert.doesNotMatch(r.stderr, /unknown flag/);
});
