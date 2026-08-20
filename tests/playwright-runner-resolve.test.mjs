/**
 * @fileoverview Regression coverage for scripts/lib/playwright-runner.mjs's
 * dependency-resolution contract — previously unlocked (no
 * tests/playwright-runner*.test.mjs existed at all).
 *
 * Two behaviors locked here (round-1 audit H1/H3, 2026-08-15):
 *
 * 1. `resolvePlaywrightCli` falls back from `@playwright/test/cli` to the
 *    BASE `playwright` package's own `bin` entry when the dedicated test
 *    package isn't installed — this is the runner half of the cross-file
 *    contract with `scripts/lib/install/deps.mjs`'s `OPTIONAL_DEPS` (which
 *    provisions plain `playwright`, not `@playwright/test`).
 * 2. `runPlaywrightJson` must NEVER fall through to a package-manager `exec`
 *    when local resolution fails — an npm/npx-family exec for a package not
 *    found locally can silently fetch an unpinned copy from the registry.
 *    Asserted by injecting `_resolveCli`/`_spawn` so the test never actually
 *    spawns a subprocess or needs Playwright installed in THIS repo (it
 *    genuinely isn't — see install-deps-contract.test.mjs's contract test).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolvePlaywrightCli, runPlaywrightJson, RUN_STATUS } from '../scripts/lib/playwright-runner.mjs';

let TMP;
before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-runner-resolve-')); });
after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
});

/** A scratch repo with a fake node_modules/playwright (base package), no @playwright/test. */
function repoWithBasePlaywright(name) {
  const root = path.join(TMP, name);
  const pwDir = path.join(root, 'node_modules', 'playwright');
  fs.mkdirSync(pwDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(pwDir, 'package.json'), JSON.stringify({ name: 'playwright', version: '1.62.0', bin: 'cli.js' }));
  fs.writeFileSync(path.join(pwDir, 'cli.js'), '// stub CLI entry, never executed by this test\n');
  return root;
}

function repoWithNeitherPackage(name) {
  const root = path.join(TMP, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  return root;
}

describe('resolvePlaywrightCli — fallback to the base package', () => {
  it('resolves the BASE playwright package\'s own CLI via its "bin" field when @playwright/test is absent', () => {
    const root = repoWithBasePlaywright('base-pw-repo');
    const resolved = resolvePlaywrightCli(root);
    assert.equal(resolved, path.join(root, 'node_modules', 'playwright', 'cli.js'));
  });

  it('throws (like require.resolve) when NEITHER package is installed', () => {
    const root = repoWithNeitherPackage('no-pw-repo');
    assert.throws(() => resolvePlaywrightCli(root));
  });
});

describe('runPlaywrightJson — no exec-fallback when resolution fails', () => {
  it('returns PLAYWRIGHT_MISSING and NEVER invokes _spawn when the CLI cannot be resolved locally', () => {
    // The H1 defect this guards: an earlier version fell back to the repo's
    // package-manager `exec`/`npx`, which for npm can resolve and RUN a copy
    // fetched from the registry when nothing resolves locally. The fix
    // removed that fallback entirely — assert the spawn function is simply
    // never called on this path.
    let spawnCalls = 0;
    const _spawn = () => { spawnCalls++; return { status: 0 }; };
    const _resolveCli = () => { throw new Error('not installed'); };

    const result = runPlaywrightJson({ specPaths: ['e2e/example.spec.js'], cwd: TMP, _spawn, _resolveCli });

    assert.equal(result.status, RUN_STATUS.PLAYWRIGHT_MISSING);
    assert.equal(spawnCalls, 0, 'must never spawn anything (no exec-through-package-manager fallback) when local resolution fails');
    assert.match(result.error, /not installed/);
  });

  it('when resolution succeeds, spawns the resolved CLI directly under the current Node binary — never through npx/exec', () => {
    let capturedArgs = null;
    const _spawn = (bin, args) => {
      capturedArgs = { bin, args };
      // Simulate a report file NOT being written (this test only cares about
      // the invocation shape, not the report-parsing path).
      return { status: 0, stderr: '' };
    };
    const _resolveCli = () => path.join(TMP, 'node_modules', 'playwright', 'cli.js');

    runPlaywrightJson({ specPaths: ['e2e/example.spec.js'], cwd: TMP, _spawn, _resolveCli });

    assert.ok(capturedArgs, '_spawn must have been called');
    assert.equal(capturedArgs.bin, process.execPath, 'must run under the current Node binary, never a shelled-out npx/exec');
    assert.deepEqual(
      capturedArgs.args,
      [path.join(TMP, 'node_modules', 'playwright', 'cli.js'), 'test', 'e2e/example.spec.js', '--reporter=json'],
    );
  });
});
