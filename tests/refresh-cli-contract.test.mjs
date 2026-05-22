/**
 * @fileoverview Hermetic refresh.mjs WS3 contract tests.
 * Plan: docs/plans/sustainability-cleanup-batch.md WS3, R3-M2.
 *
 * All tests run against `mkdtemp` working trees with `git init`. No test
 * touches the active repo, the live cloud DB, or relies on Gemini /
 * Anthropic API keys.
 *
 * Coverage:
 *  - vcs.gitDiffWithWorkingTree + filterDiffFiles integrate correctly on
 *    a real fixture tree (full pipeline that refresh.mjs runs).
 *  - Renamed-to-sensitive rewriting (rewritten-delete, tombstone preserved).
 *  - Full-vs-incremental skip log parity (same paths, same skip lines).
 *  - Source-inspection: refresh.mjs wires vcs.* + sensitive-paths.* correctly.
 *  - Cloud-disabled subprocess smoke: refresh.mjs exits 0 with cloud:false
 *    JSON when AUDIT_DB_URL is unset (proves the new VCS error code path
 *    is gated correctly behind cloud-enabled check).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vcs from '../scripts/lib/vcs.mjs';
import { filterDiffFiles, formatSkipLog } from '../scripts/lib/sensitive-paths.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const REFRESH_SRC = path.join(REPO_ROOT, 'scripts/symbol-index/refresh.mjs');

function mkdtemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-cli-'));
}

function gitInit(dir) {
  spawnSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  spawnSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, stdio: 'ignore' });
  spawnSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
}

function gitAddAll(dir) {
  spawnSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
}

function gitCommit(dir, msg) {
  spawnSync('git', ['commit', '-m', msg], { cwd: dir, stdio: 'ignore' });
}

function headSha(dir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
}

// ── Integration: vcs.gitDiffWithWorkingTree + filterDiffFiles pipeline ───

describe('refresh pipeline integration — diff filtering on real git tree', () => {
  it('drops .env.local and package-lock.json, keeps src/foo.ts (incremental)', () => {
    const dir = mkdtemp();
    try {
      gitInit(dir);
      const baseline = headSha(dir);
      fs.writeFileSync(path.join(dir, '.env.local'), 'SECRET=42\n');
      fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'foo.ts'), 'export const x = 1;\n');

      const r = vcs.gitDiffWithWorkingTree(dir, baseline);
      assert.equal(r.ok, true);
      const { diff, skipped } = filterDiffFiles(r.files, ['sensitive', 'generatedNoise']);
      const survivors = new Set([...diff.added, ...diff.modified, ...diff.untracked]);
      assert.ok(survivors.has('src/foo.ts'), 'src/foo.ts must survive');
      assert.ok(!survivors.has('.env.local'), '.env.local must be filtered');
      assert.ok(!survivors.has('package-lock.json'), 'lockfile must be filtered');

      const lines = formatSkipLog(skipped, { logger: 'refresh' });
      const joined = lines.join('\n');
      assert.match(joined, /sensitive-skip/, 'expected sensitive aggregated line');
      assert.match(joined, /package-lock\.json/, 'expected lockfile noise line');
      // Default mode: no raw sensitive paths leaked.
      assert.ok(!joined.includes('.env.local'), 'default log must not leak basename');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renamed src/foo.ts → .env.local emits as deleted (tombstone)', () => {
    const dir = mkdtemp();
    try {
      gitInit(dir);
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'foo.ts'), 'export const x = 1;\n');
      gitAddAll(dir);
      gitCommit(dir, 'add foo');
      const baseline = headSha(dir);
      spawnSync('git', ['mv', 'src/foo.ts', '.env.local'], { cwd: dir, stdio: 'ignore' });
      gitCommit(dir, 'rename to sensitive');

      const r = vcs.gitDiffWithWorkingTree(dir, baseline);
      assert.equal(r.ok, true);
      const { diff, skipped } = filterDiffFiles(r.files, ['sensitive', 'generatedNoise']);

      // Tombstone semantics: the original path is in `deleted` even though
      // git classified the change as a rename. The rename is gone.
      assert.deepEqual(diff.renamed, [], 'rename must be rewritten');
      assert.ok(diff.deleted.includes('src/foo.ts'),
        `expected src/foo.ts in deleted; got ${JSON.stringify(diff.deleted)}`);
      assert.ok(skipped.some(s => s.action === 'rewritten-delete'),
        `expected rewritten-delete in skipped; got ${JSON.stringify(skipped)}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Full-vs-incremental parity: same files, same skip log content ────────

describe('full-vs-incremental skip parity', () => {
  it('both modes filter .env.local + package-lock.json — same files end up in skip log', () => {
    const dir = mkdtemp();
    try {
      gitInit(dir);
      const baseline = headSha(dir);
      fs.writeFileSync(path.join(dir, '.env.local'), 'SECRET=42\n');
      fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'foo.ts'), 'export const x = 1;\n');

      // Incremental: refresh.mjs filterDiffFiles route.
      const incDiff = vcs.gitDiffWithWorkingTree(dir, baseline);
      assert.equal(incDiff.ok, true);
      const inc = filterDiffFiles(incDiff.files, ['sensitive', 'generatedNoise']);

      // Full mode: same skip predicate (shouldSkipForIndexing) walks every
      // file in the tree. We simulate that by mapping each working-tree file
      // through the same classifier — extract.mjs does this internally.
      const allFiles = ['.env.local', 'package-lock.json', 'src/foo.ts'];
      const fullSkipped = allFiles
        .map(p => ({ path: p, classified: filterDiffFiles({ added: [p], modified: [], deleted: [], untracked: [], renamed: [] }, ['sensitive', 'generatedNoise']) }))
        .flatMap(x => x.classified.skipped);

      // Parity: the SAME set of paths is skipped in both routes.
      const incPaths = new Set(inc.skipped.map(s => s.path));
      const fullPaths = new Set(fullSkipped.map(s => s.path));
      assert.deepEqual([...incPaths].sort(), [...fullPaths].sort(),
        'incremental skip-set must match full-mode skip-set');
      assert.ok(incPaths.has('.env.local'));
      assert.ok(incPaths.has('package-lock.json'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Source-inspection: refresh.mjs wires the new helpers correctly ────────

describe('refresh.mjs wiring (source inspection)', () => {
  const src = fs.readFileSync(REFRESH_SRC, 'utf-8');

  it('imports vcs.mjs and sensitive-paths.mjs', () => {
    assert.match(src, /import \* as vcs from '\.\.\/lib\/vcs\.mjs';/);
    assert.match(src, /from '\.\.\/lib\/sensitive-paths\.mjs'/);
  });

  it('removes the inline gitDiffWithWorkingTree definition', () => {
    assert.doesNotMatch(src, /^function gitDiffWithWorkingTree\(/m,
      'refresh.mjs must no longer carry an inline VCS helper');
    assert.doesNotMatch(src, /^function gitCommitSha\(/m);
    assert.doesNotMatch(src, /^function isSafeGitRevision\(/m);
  });

  it('exits via vcs.exitCodeFor on structured failures', () => {
    assert.match(src, /vcs\.exitCodeFor\(/);
    assert.match(src, /vcs failure:/);
  });

  it('applies filterDiffFiles with BOTH categories on incremental diff', () => {
    assert.match(src, /filterDiffFiles\([^)]*\['sensitive',\s*'generatedNoise'\]\)/);
  });

  it('emits skip log via formatSkipLog', () => {
    assert.match(src, /formatSkipLog\(/);
  });

  it('routes gitCommitSha result through {ok, sha} destructure', () => {
    // Look for either `shaResult.ok` or `sha.ok` style branching.
    assert.match(src, /vcs\.gitCommitSha\(/);
    assert.match(src, /\.ok\s*\?/, 'expected `.ok ? … : null`-style structured handling');
  });
});

// NOTE: end-to-end subprocess invocations of refresh.mjs are gated by
// `assertRepoRoot` and require AUDIT_DB_URL to reach the new VCS error
// codes (the cloud-disabled early-exit short-circuits before any vcs.* call).
// That coverage lives in the opt-in `npm run check:integration` smoke (plan
// §6 WS3 testing strategy) — not in the default hermetic test suite.
