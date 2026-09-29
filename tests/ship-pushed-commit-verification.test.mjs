/**
 * @fileoverview /ship Step 6.8's "the pushed commit" row must describe a
 * verification that can actually reproduce the pre-push run.
 *
 * Upstream report 94345e35 (wine-cellar-app, 2026-09-29), measured on one sha:
 * a bare clone + install + tests read 16423 passed / 220 skipped against the
 * pre-push gate's 16445 / 198 — green, and a different suite. A linked worktree
 * at the sha + install + `skills:hydrate` reproduced 16445 / 198 exactly.
 * Injecting the main checkout's `.env` via NODE_OPTIONS broke 16 CLI-contract
 * tests. The row said "clone … runs green in the clone", which reads as
 * verified while comparing nothing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'ship', 'SKILL.md'), 'utf-8');

/** The table row whose first cell is exactly `artifact`, within Step 6.8. */
function step68Row(artifact) {
  const start = SKILL.indexOf('## Step 6.8');
  assert.ok(start !== -1, 'Step 6.8 heading not found');
  const end = SKILL.indexOf('\n## ', start + 1);
  const section = SKILL.slice(start, end === -1 ? undefined : end);
  const row = section.split('\n').find((l) => l.startsWith(`| ${artifact} |`));
  assert.ok(row, `no "${artifact}" row in Step 6.8`);
  return row;
}

describe('/ship Step 6.8 — the pushed-commit row reproduces the pre-push run', () => {
  const row = step68Row('the pushed commit');

  it('provisions a detached worktree at the sha and hydrates the tooling tree', () => {
    assert.match(row, /git worktree add --detach/);
    assert.match(row, /skills:hydrate/);
  });

  it('runs the pre-push command and compares BOTH passed and skipped counts', () => {
    assert.match(row, /command the pre-push hook runs/);
    assert.match(row, /passed and the skipped count/);
  });

  it('warns against injecting .env into the test process', () => {
    assert.match(row, /Do not inject the main checkout's `\.env`/);
  });

  it('limits a bare clone to repos where no test reads the tooling tree', () => {
    assert.match(row, /bare `git clone` is valid only when no test reads the tooling tree/);
  });

  it('control: the synced-bundle row keeps its MAIN-checkout rule', () => {
    const bundle = step68Row('the synced consumer bundle');
    assert.match(bundle, /run \*in the consumer's MAIN checkout\*/);
    assert.match(bundle, /A linked worktree cannot answer this/);
  });
});
