/**
 * @fileoverview Tier-3 (consumer-sync contract) tests for untrackNewlyIgnored.
 * Uses a real temp git repo — a silent break here ships untracking behaviour
 * into consumer repos we can't observe, so it lands with its test.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { untrackNewlyIgnored, gitignoreToRegExp } from '../scripts/lib/sync-untrack.mjs';

let repo;
const git = (cmd) => execSync(`git ${cmd}`, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' });
const isTracked = (p) => {
  try { git(`ls-files --error-unmatch -- "${p}"`); return true; } catch { return false; }
};

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'untrack-'));
  git('init -q');
  git('config user.email t@t.t');
  git('config user.name t');
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

function write(rel, body = 'x') {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return rel;
}

describe('untrackNewlyIgnored', () => {
  it('untracks an already-committed file once the managed pattern ignores it', () => {
    write('.audit/cache-metrics.jsonl', '{}\n');
    git('add -A'); git('commit -qm init');
    assert.ok(isTracked('.audit/cache-metrics.jsonl'), 'precondition: tracked');
    // pattern now exists in .gitignore
    write('.gitignore', '.audit/cache-metrics.jsonl\n');
    git('add .gitignore'); git('commit -qm ignore');

    const removed = untrackNewlyIgnored(repo, ['.audit/cache-metrics.jsonl']);
    assert.deepEqual(removed, ['.audit/cache-metrics.jsonl']);
    assert.ok(!isTracked('.audit/cache-metrics.jsonl'), 'now untracked');
    assert.ok(fs.existsSync(path.join(repo, '.audit/cache-metrics.jsonl')), 'working copy preserved');
  });

  it('is idempotent — a second run finds nothing', () => {
    write('.audit/cache-metrics.jsonl');
    git('add -A'); git('commit -qm init');         // tracked before the pattern exists
    write('.gitignore', '.audit/cache-metrics.jsonl\n');
    git('add .gitignore'); git('commit -qm ignore');
    const first = untrackNewlyIgnored(repo, ['.audit/cache-metrics.jsonl']);
    assert.deepEqual(first, ['.audit/cache-metrics.jsonl'], 'first run untracks it');
    const second = untrackNewlyIgnored(repo, ['.audit/cache-metrics.jsonl']);
    assert.deepEqual(second, [], 'nothing left to untrack');
  });

  it('matches the glob shapes (observed / verify-result) but never a non-matching tracked file', () => {
    write('.audit-loop/visual-observed.json');
    write('.audit-loop/nav-verify-result.json');
    write('.audit-loop/migrations/0001_init.sql'); // tracked consumer artifact — must survive
    write('src/app.js');                            // consumer's own file — must survive
    git('add -A'); git('commit -qm init');          // all tracked BEFORE the patterns exist
    write('.gitignore', '.audit-loop/*-observed.json\n.audit-loop/*-verify-result.json\n');
    git('add .gitignore'); git('commit -qm ignore');

    const removed = untrackNewlyIgnored(repo, ['.audit-loop/*-observed.json', '.audit-loop/*-verify-result.json']);
    assert.deepEqual(removed.sort(), ['.audit-loop/nav-verify-result.json', '.audit-loop/visual-observed.json']);
    assert.ok(isTracked('.audit-loop/migrations/0001_init.sql'), 'tracked migration untouched');
    assert.ok(isTracked('src/app.js'), 'consumer source untouched');
  });

  it('gitignore `*` does NOT cross `/` — a nested path is never swept', () => {
    // A pattern's single-segment `*` must not match a deeper path (faithful
    // gitignore semantics), so a consumer file that merely lives under our dir
    // but in a sub-directory is safe.
    write('.audit-loop/nested/deep-observed.json'); // deeper than the pattern's segment
    git('add -A'); git('commit -qm init');
    const removed = untrackNewlyIgnored(repo, ['.audit-loop/*-observed.json']);
    assert.deepEqual(removed, [], 'nested path not matched by single-segment *');
    assert.ok(isTracked('.audit-loop/nested/deep-observed.json'));
  });

  it('gitignoreToRegExp: `*` maps to [^/]* and metachars are escaped', () => {
    const re = gitignoreToRegExp('.audit-loop/*-observed.json');
    assert.ok(re.test('.audit-loop/visual-observed.json'));
    assert.ok(re.test('.audit-loop/nav-graph-observed.json'));
    assert.ok(!re.test('.audit-loop/sub/x-observed.json'), '* must not cross /');
    assert.ok(!re.test('.audit-loop/visual-observed.jsonx'), 'anchored at end');
    assert.ok(!re.test('xx.audit-loop/visual-observed.json'), 'anchored at start');
    // the `.` is escaped, not a wildcard
    assert.ok(!re.test('xaudit-loop/visual-observed.json'));
    assert.ok(gitignoreToRegExp('.audit/cache-metrics.jsonl').test('.audit/cache-metrics.jsonl'));
  });

  it('untracks a committed arm-eval session export but spares the consumer’s own docs/', () => {
    // In a consumer, docs/arm-eval/sessions/* are local runtime exports (cloud
    // arm_eval_* is the authoritative capture); the pattern must untrack a
    // previously-committed one without touching the consumer's own docs tree.
    write('docs/arm-eval/sessions/20260702-163710Z__plan__prospective__t__h.md');
    write('docs/arm-eval/worksheets/queue.md');
    write('docs/architecture-map.md');     // consumer's own doc — must survive
    write('docs/plans/feature.md');        // consumer's own doc — must survive
    git('add -A'); git('commit -qm init'); // all tracked BEFORE the patterns exist

    const pats = ['docs/arm-eval/sessions/*', 'docs/arm-eval/worksheets/*'];
    const removed = untrackNewlyIgnored(repo, pats);
    assert.deepEqual(
      removed.sort(),
      ['docs/arm-eval/sessions/20260702-163710Z__plan__prospective__t__h.md', 'docs/arm-eval/worksheets/queue.md'],
    );
    assert.ok(isTracked('docs/architecture-map.md'), 'consumer own doc untouched');
    assert.ok(isTracked('docs/plans/feature.md'), 'consumer own plan untouched');
    assert.ok(fs.existsSync(path.join(repo, 'docs/arm-eval/sessions/20260702-163710Z__plan__prospective__t__h.md')), 'working copy preserved');
  });

  it('dryRun reports without modifying the index', () => {
    write('.audit/cache-metrics.jsonl');
    git('add -A'); git('commit -qm init');         // tracked before the pattern exists
    write('.gitignore', '.audit/cache-metrics.jsonl\n');
    git('add .gitignore'); git('commit -qm ignore');
    const removed = untrackNewlyIgnored(repo, ['.audit/cache-metrics.jsonl'], { dryRun: true });
    assert.deepEqual(removed, ['.audit/cache-metrics.jsonl']);
    assert.ok(isTracked('.audit/cache-metrics.jsonl'), 'dry-run left the index untouched');
  });
});
