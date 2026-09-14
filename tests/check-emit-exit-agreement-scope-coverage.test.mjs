/**
 * @fileoverview Regression test for the opt-out census's SCOPE, not its
 * identity-tracking (that's swap-detection.test.mjs) or sandbox-honesty
 * (that's sandbox-honesty.test.mjs).
 *
 * Until 2026-09-14 `listTrackedMjs` only enumerated `scripts/**\/*.mjs`, so a
 * `softFail` opt-out declared in a root-level entry point (`install.mjs`,
 * `setup.mjs`), a `.claude/hooks/*.mjs` executable, or any `.js`/`.cjs` file
 * was structurally invisible to the gate — not exempted with a reason, simply
 * unrepresentable, contradicting the module's own docstring claim to count
 * opt-outs "across the repo's CLIs" (final-review-credit-queue fp a36bc428,
 * fp 6fd5e0c2, fp 088dc200 — three audit rounds raising the same gap).
 *
 * @module tests/check-emit-exit-agreement-scope-coverage
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gitInit, commit, mkdtemp } from './helpers/fixtures.mjs';
import { scanOptOuts } from '../scripts/check-emit-exit-agreement.mjs';

describe('scanOptOuts scope — root-level and .claude/hooks/ CLIs are no longer invisible', () => {
  it('counts an opt-out in a ROOT-LEVEL .mjs entry point (install.mjs-shaped)', () => {
    const dir = mkdtemp('check-emit-exit-scope-root-');
    try {
      gitInit(dir);
      commit(
        dir,
        'install.mjs',
        "import { emit } from './scripts/lib/cli-io.mjs';\nemit(env, { softFail: true, reason: 'root-level' });\n",
        'add root-level opt-out',
      );
      const hits = scanOptOuts(dir);
      assert.equal(hits.length, 1, 'a root-level .mjs opt-out must be counted, not invisible');
      assert.equal(hits[0].file, 'install.mjs');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('counts an opt-out in a .claude/hooks/*.mjs executable', () => {
    const dir = mkdtemp('check-emit-exit-scope-hooks-');
    try {
      gitInit(dir);
      fs.mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true });
      commit(
        dir,
        '.claude/hooks/example-hook.mjs',
        "import { emit } from '../../scripts/lib/cli-io.mjs';\nemit(env, { softFail: true, reason: 'hook' });\n",
        'add hook opt-out',
      );
      const hits = scanOptOuts(dir);
      assert.equal(hits.length, 1, 'a .claude/hooks/*.mjs opt-out must be counted, not invisible');
      assert.equal(hits[0].file, '.claude/hooks/example-hook.mjs');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('counts an opt-out in a root-level .cjs file too', () => {
    const dir = mkdtemp('check-emit-exit-scope-cjs-');
    try {
      gitInit(dir);
      commit(
        dir,
        'legacy-tool.cjs',
        "const { emit } = require('./scripts/lib/cli-io.mjs');\nemit(env, { softFail: true, reason: 'cjs' });\n",
        'add cjs opt-out',
      );
      const hits = scanOptOuts(dir);
      assert.equal(hits.length, 1, 'a root-level .cjs opt-out must be counted');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('still ignores an unrelated top-level doc/config file with no opt-out', () => {
    const dir = mkdtemp('check-emit-exit-scope-noise-');
    try {
      gitInit(dir);
      commit(dir, 'README.md', '# nothing to see here\n', 'add readme');
      const hits = scanOptOuts(dir);
      assert.equal(hits.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
