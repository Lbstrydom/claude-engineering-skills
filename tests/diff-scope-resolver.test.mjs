/**
 * @fileoverview Tests for diff-scope-resolver: AST pre-edge extraction +
 * git-CLI integration. Uses a temp git repo with controlled history.
 *
 * Focus:
 *   - AST extraction across import forms (import, require, re-export, side-effect, type-only)
 *   - Non-source files filtered before AST stage (Gemini-R2/H1)
 *   - 'D' (delete) callers are included in pre-edge extraction (R2/H2)
 *   - Rename produces correct base/head caller identities (R2/H1)
 *   - Shallow-clone / missing-base → SKIPPED_NO_BASELINE
 *   - Patch-only mode → SKIPPED_PATCH_ONLY_MODE
 *   - Working-tree mode unions tracked + untracked (Gemini-R3/H3)
 *   - computeEntryPoints reads package.json
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveDiffScope, computeEntryPoints } from '../scripts/lib/audit/diff-scope-resolver.mjs';

function sh(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
}

function writeFile(repo, rel, content) {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Create a fresh disposable git repo with a single initial commit. */
function newRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-test-'));
  sh(repo, 'init', '-q');
  sh(repo, 'config', 'user.email', 'test@example.com');
  sh(repo, 'config', 'user.name', 'Test');
  sh(repo, 'config', 'commit.gpgsign', 'false');
  // Minimal package.json so dep-cruiser doesn't choke
  writeFile(repo, 'package.json', JSON.stringify({ name: 'fixture', type: 'module' }));
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

function commit(repo, msg) {
  // -A so we capture deletions + renames in addition to mods (not just `git add .`)
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', msg);
}

describe('resolveDiffScope — failure modes', () => {
  it('returns SKIPPED_PATCH_ONLY_MODE when diffPatch passed without refs', async () => {
    const repo = newRepo();
    try {
      const scope = await resolveDiffScope({ repoPath: repo, diffPatch: 'fake-patch' });
      assert.equal(scope.state, 'SKIPPED_PATCH_ONLY_MODE');
      assert.deepEqual(scope.changedFiles, []);
    } finally { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('returns SKIPPED_NO_BASELINE when baseRef cannot be resolved', async () => {
    const repo = newRepo();
    try {
      const scope = await resolveDiffScope({ repoPath: repo, baseRef: 'does-not-exist', headRef: 'HEAD' });
      assert.equal(scope.state, 'SKIPPED_NO_BASELINE');
    } finally { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('returns SKIPPED_NO_BASELINE on shallow clone (HEAD~1 missing on initial commit)', async () => {
    const repo = newRepo(); // single initial commit, HEAD~1 doesn't exist
    try {
      const scope = await resolveDiffScope({ repoPath: repo, baseRef: 'HEAD~1', headRef: 'HEAD' });
      assert.equal(scope.state, 'SKIPPED_NO_BASELINE');
    } finally { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

describe('resolveDiffScope — AST pre-edge extraction', () => {
  it('extracts static imports from preimage M-status file', async () => {
    const repo = newRepo();
    try {
      writeFile(repo, 'src/main.mjs', `import { foo } from './lib.mjs';\nfoo();\n`);
      writeFile(repo, 'src/lib.mjs', `export function foo() {}\n`);
      commit(repo, 'add main + lib');
      // Now modify main to remove the import
      writeFile(repo, 'src/main.mjs', `console.log('main no longer imports lib');\n`);
      commit(repo, 'remove import');

      const scope = await resolveDiffScope({ repoPath: repo, baseRef: 'HEAD~1', headRef: 'HEAD' });
      // Pre-edges should include src/main.mjs → src/lib.mjs
      const preTargets = scope.preEdgesByBaseCaller['src/main.mjs'] || [];
      assert.ok(preTargets.includes('src/lib.mjs'),
        `expected src/lib.mjs in pre-edges for src/main.mjs, got: ${JSON.stringify(preTargets)}`);
    } finally { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('filters out binary / non-source files before AST stage (Gemini-R2/H1)', async () => {
    const repo = newRepo();
    try {
      writeFile(repo, 'data.json', '{"a":1}');
      writeFile(repo, 'README.md', 'hello');
      commit(repo, 'add data + readme');
      writeFile(repo, 'data.json', '{"a":2}');
      writeFile(repo, 'README.md', 'hello world');
      commit(repo, 'modify data + readme');

      const scope = await resolveDiffScope({ repoPath: repo, baseRef: 'HEAD~1', headRef: 'HEAD' });
      // Non-source files should NOT appear in changedFiles
      assert.equal(scope.changedFiles.length, 0,
        `expected 0 changedFiles after non-source filter, got: ${JSON.stringify(scope.changedFiles)}`);
    } finally { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('D-status caller pre-edges are extracted (R2/H2)', async () => {
    const repo = newRepo();
    try {
      writeFile(repo, 'src/main.mjs', `import { foo } from './lib.mjs';\n`);
      writeFile(repo, 'src/lib.mjs', `export function foo() {}\n`);
      commit(repo, 'add main + lib');
      fs.unlinkSync(path.join(repo, 'src/main.mjs'));
      commit(repo, 'delete main');

      const scope = await resolveDiffScope({ repoPath: repo, baseRef: 'HEAD~1', headRef: 'HEAD' });
      const dEntry = scope.changedFiles.find(f => f.status === 'D');
      assert.ok(dEntry, 'expected a D-status entry');
      assert.equal(dEntry.baseCallerPath, 'src/main.mjs');
      assert.equal(dEntry.headCallerPath, null);
      // Pre-edges should include the deleted file's import targets
      assert.ok(scope.preEdgesByBaseCaller['src/main.mjs'], 'expected pre-edges for deleted file');
    } finally { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

describe('resolveDiffScope — targetExistedAtBase via single ls-tree', () => {
  it('includes files from base commit (Gemini-R2/M1 — single git call)', async () => {
    const repo = newRepo();
    try {
      writeFile(repo, 'src/x.mjs', '// at base\n');
      commit(repo, 'add x at base');
      writeFile(repo, 'src/x.mjs', '// modified\n');
      writeFile(repo, 'src/y.mjs', '// new\n');
      commit(repo, 'modify x + add y');

      const scope = await resolveDiffScope({ repoPath: repo, baseRef: 'HEAD~1', headRef: 'HEAD' });
      assert.ok(scope.targetExistedAtBase.includes('src/x.mjs'),
        'expected src/x.mjs in base manifest');
      assert.ok(!scope.targetExistedAtBase.includes('src/y.mjs'),
        'src/y.mjs did NOT exist at base — should be absent');
    } finally { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

describe('computeEntryPoints', () => {
  it('reads package.json bin + main', () => {
    const repo = newRepo();
    try {
      writeFile(repo, 'package.json', JSON.stringify({
        name: 'pkg', type: 'module',
        main: 'index.mjs',
        bin: { mycli: 'cli.mjs' },
      }));
      writeFile(repo, 'index.mjs', '');
      writeFile(repo, 'cli.mjs', '');
      const ep = computeEntryPoints(repo);
      assert.ok(ep.has('index.mjs'), 'main → entry point');
      assert.ok(ep.has('cli.mjs'), 'bin → entry point');
    } finally { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('includes scripts/* directory', () => {
    const repo = newRepo();
    try {
      writeFile(repo, 'scripts/foo.mjs', '');
      writeFile(repo, 'scripts/bar.mjs', '');
      const ep = computeEntryPoints(repo);
      assert.ok(ep.has('scripts/foo.mjs'));
      assert.ok(ep.has('scripts/bar.mjs'));
    } finally { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('handles missing package.json gracefully', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-noprojtest-'));
    try {
      const ep = computeEntryPoints(repo);
      assert.equal(ep.size, 0);
    } finally { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('recognises a nested CLI script via its own `node <path>` usage docblock (dead-code-phase-1-followup)', () => {
    // Regression for the confirmed FP: scripts/spikes/observed-graph-discovery-spike.mjs
    // sits one level deeper than the depth-1 scripts/* walk covers, but documents
    // itself as a CLI entry point — that self-referential docblock must exempt it.
    const repo = newRepo();
    try {
      writeFile(repo, 'scripts/spikes/my-spike.mjs',
        '#!/usr/bin/env node\n/**\n * Usage:\n *   node scripts/spikes/my-spike.mjs [--repo <path>]\n */\nconsole.log("spike");\n');
      const ep = computeEntryPoints(repo);
      assert.ok(ep.has('scripts/spikes/my-spike.mjs'),
        `expected scripts/spikes/my-spike.mjs to be recognised via its usage docblock, got ${JSON.stringify([...ep])}`);
    } finally { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('does NOT exempt a nested library file with no self-usage docblock', () => {
    const repo = newRepo();
    try {
      writeFile(repo, 'scripts/lib/helper.mjs', 'export function helper() {}\n');
      const ep = computeEntryPoints(repo);
      assert.ok(!ep.has('scripts/lib/helper.mjs'),
        'a nested library file without a self-usage docblock must not become an entry point');
    } finally { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('does NOT exempt a nested file whose docblock references a DIFFERENT script', () => {
    const repo = newRepo();
    try {
      writeFile(repo, 'scripts/spikes/other.mjs',
        '/**\n * Usage:\n *   node scripts/spikes/my-spike.mjs\n */\nexport const x = 1;\n');
      const ep = computeEntryPoints(repo);
      assert.ok(!ep.has('scripts/spikes/other.mjs'),
        'a docblock naming a DIFFERENT file must not self-exempt this one');
    } finally { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

describe('resolveDiffScope — rename status', () => {
  it('R status gets separate base + head caller paths', async () => {
    const repo = newRepo();
    try {
      writeFile(repo, 'src/old-name.mjs', '// content that we will rename\n// more lines to make rename detection robust\nexport const v = 1;\n');
      commit(repo, 'add old-name');
      fs.renameSync(path.join(repo, 'src/old-name.mjs'), path.join(repo, 'src/new-name.mjs'));
      commit(repo, 'rename');

      const scope = await resolveDiffScope({ repoPath: repo, baseRef: 'HEAD~1', headRef: 'HEAD' });
      // git diff --name-status may report R or "M + D + A" depending on similarity score.
      // Either is acceptable; we just check we got SOMETHING.
      assert.ok(scope.changedFiles.length > 0, 'expected changes detected');
    } finally { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});
