/**
 * @fileoverview Regression test for the sandbox-honesty fix to
 * `scanOptOuts` (scripts/check-emit-exit-agreement.mjs).
 *
 * The gate's own docblock claims to be "a pure, deterministic function of
 * committed source" (docs/plans/cross-skill-command-registry.md §2b F4 +
 * AGENTS.md's generated-artifact policy), but it used to enumerate its
 * scan population with a raw `fs.readdirSync` walk over `scripts/` — the
 * WORKING TREE, not git's index. An untracked scratch file containing an
 * `emit(..., {softFail:true})`-shaped statement would inflate `hits.length`
 * without ever being committed, so the gate's verdict depended on what
 * happened to be sitting on disk, not on anything a reviewer could see in
 * `git diff`. Fixed by switching to `git ls-files` (mirrors
 * `check-gate-poison-pills.mjs`'s `listTracked`, precedent for this exact
 * swap in this repo).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gitInit, commit, mkdtemp } from './helpers/fixtures.mjs';
import { scanOptOuts } from '../scripts/check-emit-exit-agreement.mjs';

describe('scanOptOuts (sandbox-honesty)', () => {
  it('ignores an untracked file — only committed opt-outs count', () => {
    const dir = mkdtemp('check-emit-exit-honesty-');
    try {
      gitInit(dir);
      fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      commit(
        dir,
        'scripts/tracked.mjs',
        "import { emit } from './lib/cli-io.mjs';\nemit(env, { softFail: true, reason: 'known-exempt' });\n",
        'add tracked opt-out',
      );

      const committedOnly = scanOptOuts(dir);
      assert.equal(committedOnly.length, 1, 'the committed opt-out must be counted');

      // Now drop an UNTRACKED file with the same shape into the working
      // tree, without `git add`-ing it.
      fs.writeFileSync(
        path.join(dir, 'scripts', 'scratch.mjs'),
        "import { emit } from './lib/cli-io.mjs';\nemit(env, { softFail: true, reason: 'untracked' });\n",
      );

      const withUntracked = scanOptOuts(dir);
      assert.equal(
        withUntracked.length,
        1,
        'an untracked file must NOT change the gate result — it would violate ' +
          'sandbox-honesty (a check reading uncommitted state and calling it deterministic)',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
