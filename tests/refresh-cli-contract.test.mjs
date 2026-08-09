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
import { gitInitWithEmptyCommit as gitInit, gitFixtureEnv } from './helpers/fixtures.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const REFRESH_SRC = path.join(REPO_ROOT, 'scripts/symbol-index/refresh.mjs');

function mkdtemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-cli-'));
}

function gitAddAll(dir) {
  spawnSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore', env: gitFixtureEnv() });
}

function gitCommit(dir, msg) {
  spawnSync('git', ['commit', '-m', msg], { cwd: dir, stdio: 'ignore', env: gitFixtureEnv() });
}

function headSha(dir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, env: gitFixtureEnv() }).toString().trim();
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

      const r = vcs.gitDiffWithWorkingTree(dir, baseline, { env: gitFixtureEnv() });
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
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
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
      spawnSync('git', ['mv', 'src/foo.ts', '.env.local'], { cwd: dir, stdio: 'ignore', env: gitFixtureEnv() });
      gitCommit(dir, 'rename to sensitive');

      const r = vcs.gitDiffWithWorkingTree(dir, baseline, { env: gitFixtureEnv() });
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
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
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
      const incDiff = vcs.gitDiffWithWorkingTree(dir, baseline, { env: gitFixtureEnv() });
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
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

// ── Source-inspection: refresh.mjs (+ its siblings) wire the helpers correctly ──
// docs/plans/tiered-pipeline-refresh-god-module-decomposition.md: VCS-scope +
// sensitive-path filtering relocated to refresh-file-scope.mjs, walk-start-commit
// resolution to refresh-lock.mjs, and the extract/summarise/embed subprocess
// pipeline (including the sibling-script resolution + --files-from manifest) to
// refresh-subprocess.mjs. `vcs.exitCodeFor` and the top-level `vcs` import stay
// in refresh.mjs itself (used by its own catch block).

describe('refresh.mjs wiring (source inspection)', () => {
  const src = fs.readFileSync(REFRESH_SRC, 'utf-8');
  const fileScopeSrc = fs.readFileSync(path.join(REPO_ROOT, 'scripts/symbol-index/refresh-file-scope.mjs'), 'utf-8');
  const lockSrc = fs.readFileSync(path.join(REPO_ROOT, 'scripts/symbol-index/refresh-lock.mjs'), 'utf-8');
  const subprocessSrc = fs.readFileSync(path.join(REPO_ROOT, 'scripts/symbol-index/refresh-subprocess.mjs'), 'utf-8');

  it('imports vcs.mjs (refresh.mjs) and sensitive-paths.mjs (refresh-file-scope.mjs)', () => {
    assert.match(src, /import \* as vcs from '\.\.\/lib\/vcs\.mjs';/);
    assert.match(fileScopeSrc, /from '\.\.\/lib\/sensitive-paths\.mjs'/);
  });

  it('removes the inline gitDiffWithWorkingTree definition', () => {
    assert.doesNotMatch(src, /^function gitDiffWithWorkingTree\(/m,
      'refresh.mjs must no longer carry an inline VCS helper');
    assert.doesNotMatch(src, /^function gitCommitSha\(/m);
    assert.doesNotMatch(src, /^function isSafeGitRevision\(/m);
  });

  it('exits via vcs.exitCodeFor on structured failures', () => {
    assert.match(src, /vcs\.exitCodeFor\(/);
    // The "vcs failure:" message is built by throwVcsError, relocated to
    // refresh-file-scope.mjs (its only call site).
    assert.match(fileScopeSrc, /vcs failure:/);
  });

  it('applies filterDiffFiles with BOTH categories on incremental diff', () => {
    assert.match(fileScopeSrc, /filterDiffFiles\([^)]*\['sensitive',\s*'generatedNoise'\]\)/);
  });

  it('emits skip log via formatSkipLog', () => {
    assert.match(fileScopeSrc, /formatSkipLog\(/);
  });

  it('routes gitCommitSha result through {ok, sha} destructure', () => {
    // Look for either `shaResult.ok` or `sha.ok` style branching. Relocated to
    // refresh-lock.mjs's resolveWalkStartCommit.
    assert.match(lockSrc, /vcs\.gitCommitSha\(/);
    assert.match(lockSrc, /\.ok\s*\?/, 'expected `.ok ? … : null`-style structured handling');
  });

  it('resolves sibling pipeline scripts via import.meta.dirname, not a cwd-relative path', () => {
    // Regression: spawning `node scripts/symbol-index/extract.mjs` (cwd-relative)
    // is MODULE_NOT_FOUND in a consumer, where the tooling lives under
    // scripts/.claude-skills/symbol-index/. Siblings must resolve off THIS file
    // (refresh-subprocess.mjs, where the sibling() helper + the spawns now live —
    // it is itself a sibling of extract/summarise/embed.mjs, same directory as
    // refresh.mjs, so import.meta.dirname resolves identically).
    assert.match(subprocessSrc, /import\.meta\.dirname/, 'must resolve siblings off import.meta.dirname');
    // Match the array-spawn form `['scripts/symbol-index/extract.mjs'` (the bug),
    // not prose mentioning the path — so the explanatory comment doesn't trip it.
    assert.doesNotMatch(subprocessSrc, /\[\s*['"]scripts\/symbol-index\/(extract|summarise|embed)\.mjs['"]/,
      'no cwd-relative sibling spawn path (breaks silently in consumers)');
  });

  it('hands the touched-file list to extract via --files-from manifest, not a giant argv', () => {
    // Regression: a large incremental changeset (1600+ files on Windows) used
    // to overflow the OS command line via `--files <comma-joined>` → spawn
    // ENAMETOOLONG. The list must now go through a temp manifest file.
    // Relocated to refresh-subprocess.mjs's runExtractSummariseEmbed.
    assert.match(subprocessSrc, /--files-from/, 'extract must be invoked with --files-from');
    assert.doesNotMatch(subprocessSrc, /extractArgs\.push\('--files',/,
      'refresh-subprocess.mjs must not pass the file list as a --files argv (ENAMETOOLONG risk)');
    assert.match(subprocessSrc, /unlinkSync\(filesManifest\)/, 'manifest must be cleaned up');
  });
});

// ── Functional: extract.mjs --files-from manifest handoff ────────────────

describe('extract.mjs --files-from (ENAMETOOLONG fix)', () => {
  const EXTRACT_SRC = path.join(REPO_ROOT, 'scripts/symbol-index/extract.mjs');

  it('reads the file list from a NUL-delimited manifest and extracts only those files', () => {
    const dir = mkdtemp();
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'alpha.ts'), 'export function alphaFn() { return 1; }\n');
      fs.writeFileSync(path.join(dir, 'src', 'beta.ts'), 'export function betaFn() { return 2; }\n');
      // Manifest lists only alpha.ts — beta.ts must NOT be extracted.
      const manifest = path.join(dir, 'files.txt');
      fs.writeFileSync(manifest, 'src/alpha.ts\0');

      const res = spawnSync('node', [
        EXTRACT_SRC, '--root', dir, '--mode', 'incremental', '--files-from', manifest,
      ], { encoding: 'utf-8' });

      assert.equal(res.status, 0, `extract exited ${res.status}: ${res.stderr}`);
      const symbols = res.stdout.split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(r => r && r.type === 'symbol');
      const names = symbols.map(s => s.symbolName);
      assert.ok(names.includes('alphaFn'), `expected alphaFn; got ${JSON.stringify(names)}`);
      assert.ok(!names.includes('betaFn'), 'betaFn was not in the manifest — must not be extracted');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

// NOTE: end-to-end subprocess invocations of refresh.mjs are gated by
// `assertRepoRoot` and require AUDIT_DB_URL to reach the new VCS error
// codes (the cloud-disabled early-exit short-circuits before any vcs.* call).
// That coverage lives in the opt-in `npm run check:integration` smoke (plan
// §6 WS3 testing strategy) — not in the default hermetic test suite.
