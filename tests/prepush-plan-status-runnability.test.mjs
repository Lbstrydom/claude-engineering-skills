/**
 * @fileoverview The plan-status gate in the managed pre-push hook must (a) hand
 * node a path node can actually resolve, and (b) say whether it RAN.
 *
 * THE DEFECT (measured 2026-09-06 in the wine-cellar-app consumer, on a branch
 * whose diff was two workflow deletions and two decision docs — no plan at all):
 *
 *     Error: Cannot find module 'C:\c\GIT\claude-engineering-skills\scripts\check-plan-status.mjs'
 *         code: 'MODULE_NOT_FOUND'
 *     [prepush-hook] a plan changed in this push has a non-conforming Status — fix it or set PLAN_STATUS_DISABLE=1
 *
 * Two independent bugs, stacked:
 *
 * 1. PATH. Discovery derived MAIN_PARENT with plain `pwd`, which on git-bash
 *    prints the MSYS form `/c/GIT`. That reaches node.exe intact only while the
 *    MSYS runtime rewrites argv; `MSYS_NO_PATHCONV=1` and `MSYS2_ARG_CONV_EXCL=*`
 *    both switch that off, and plenty of tooling sets them. Node then resolves
 *    `/c/GIT/...` against the CURRENT DRIVE root — hence the `C:\c\GIT` in the
 *    error, a drive letter glued onto a POSIX path. `pwd -W` prints `C:/GIT`
 *    directly, so nothing downstream depends on a rewrite that may not happen.
 *
 * 2. HONESTY. `--drift` exits 0=clean / 1=violations, and a node that never
 *    started also exits 1 — so the exit code ALONE cannot separate "read the
 *    Status lines and found a violation" from "read nothing". The gate rendered
 *    the second as the first: a specific factual claim ("a plan changed in this
 *    push has a non-conforming Status") that was false twice over. A gate whose
 *    failure message misidentifies the cause teaches the operator to reach for
 *    PLAN_STATUS_DISABLE=1 reflexively, which retires the gate without anyone
 *    deciding to — and that is exactly what happened.
 *
 * WHY THE BEHAVIOURAL CASES RUN THE REAL BODY. A regex over HOOK_BODY pins the
 * spelling of the fix, not its effect; the pre-fix body passes several plausible
 * spellings of "use a native path" while still failing. So the cases below
 * execute the emitted shell against real fixtures, and each carries a RED
 * CONTROL asserting the situation the fix exists for is actually present.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { _internals } from '../scripts/install-prepush-hook.mjs';
import { hasBash } from './lib/hook-test-helpers.mjs';

const { HOOK_BODY } = _internals;
const HAS_BASH = hasBash();
const IS_WINDOWS = process.platform === 'win32';

function withTmp(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-status-'));
  try {
    return fn(base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

/** Run a shell fragment, returning `{status, stdout, stderr}`. */
function runSh(script, { cwd, env } = {}) {
  const file = path.join(cwd, '.probe.sh');
  fs.writeFileSync(file, script);
  return spawnSync('bash', [file], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_AUDIT_LOOP_DIR: '', ...env },
  });
}

/** The MAIN_PARENT derivation, lifted verbatim from the emitted body. */
function mainParentFragment() {
  const lines = HOOK_BODY.split('\n');
  const i = lines.findIndex(l => l.trim().startsWith('MAIN_PARENT="$(cd "$COMMON_GIT_DIR/../.."'));
  assert.ok(i >= 0, 'MAIN_PARENT derivation not found in HOOK_BODY');
  return [
    'COMMON_GIT_DIR="."',
    lines[i].trim(),
    'echo "MAIN_PARENT=$MAIN_PARENT"',
    '',
  ].join('\n');
}

/**
 * The plan-status gate block, lifted verbatim, with STATUS_CLI supplied by the
 * caller. Everything before it in the hook is discovery, which
 * prepush-worktree-anchor.test.mjs already covers.
 */
function planStatusFragment() {
  const lines = HOOK_BODY.split('\n');
  const start = lines.findIndex(l => l.startsWith('if [ "$PLAN_STATUS_DISABLE" != "1" ]; then'));
  assert.ok(start >= 0, 'plan-status gate not found in HOOK_BODY');
  const end = lines.indexOf('fi', start);
  assert.ok(end > start, 'plan-status gate has no terminator');
  return ['STATUS_CLI="$1"', lines.slice(start, end + 1).join('\n'), 'echo "REACHED_END"', ''].join('\n');
}

function runGate(cliPath, tmp) {
  const file = path.join(tmp, '.gate.sh');
  fs.writeFileSync(file, planStatusFragment());
  return spawnSync('bash', [file, cliPath], {
    cwd: tmp,
    encoding: 'utf-8',
    env: { ...process.env, PLAN_STATUS_DISABLE: '' },
  });
}

/** A stand-in CLI honouring the `--selfcheck-relocation` / `--drift` contract. */
function writeFakeCli(dir, { drift }) {
  const p = path.join(dir, 'cli.mjs');
  fs.writeFileSync(p, [
    "if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }",
    "if (process.argv.includes('--drift')) {",
    `  console.error('fake lint output');`,
    `  process.exit(${drift});`,
    '}',
    'process.exit(0);',
    '',
  ].join('\n'));
  return p;
}

describe('managed pre-push hook — MAIN_PARENT is a native path', () => {
  it('does not hand a bare `pwd` to node', () => {
    // The exact pre-fix derivation. Spelling-level, but this one line IS the
    // defect, and pinning its absence stops a revert reading as a refactor.
    assert.doesNotMatch(HOOK_BODY, /MAIN_PARENT="\$\(cd "\$COMMON_GIT_DIR\/\.\.\/\.\." 2>\/dev\/null && pwd\)"/);
  });

  it('prefers `pwd -W`, falling back to `pwd` off Windows', () => {
    assert.match(HOOK_BODY, /pwd -W 2>\/dev\/null \|\| pwd/);
  });

  it('names MSYS argv rewriting as the thing it must not depend on', () => {
    // The reason is the load-bearing part: without it the next author "tidies"
    // `pwd -W` away as a Windows-ism.
    assert.match(HOOK_BODY, /MSYS_NO_PATHCONV/);
    assert.match(HOOK_BODY, /MSYS2_ARG_CONV_EXCL/);
  });

  it('yields a path node resolves even with MSYS argv rewriting OFF', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    if (!IS_WINDOWS) return t.skip('MSYS path conversion only exists on Windows');
    withTmp((tmp) => {
      // `COMMON_GIT_DIR="."` + `cd ./../..` walks two levels up, so run from a
      // grandchild of tmp and the derived parent lands back on tmp itself —
      // where the probe module below lives.
      const cwd = path.join(tmp, 'repo', '.git');
      fs.mkdirSync(cwd, { recursive: true });
      fs.writeFileSync(path.join(tmp, 'probe.mjs'), 'console.log("ran");\n');

      const env = { MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' };
      const got = runSh(mainParentFragment(), { cwd, env });
      assert.equal(got.status, 0, got.stderr);
      const parent = got.stdout.trim().replace(/^MAIN_PARENT=/, '');
      assert.ok(parent, 'derivation produced nothing');

      // RED CONTROL: the pre-fix value, under these env vars, is exactly the
      // reported failure. Without this the green case below proves nothing.
      const posix = runSh('COMMON_GIT_DIR="."\nMAIN_PARENT="$(cd "$COMMON_GIT_DIR/../.." 2>/dev/null && pwd)"\necho "$MAIN_PARENT"\n', { cwd, env });
      const posixParent = posix.stdout.trim();
      // The MSYS form is POSIX-rooted and carries no drive letter — that is the
      // whole problem. (It is `/c/...` for a path on C:, but `/tmp/...` where a
      // mount rewrites it, so assert the SHAPE, not one spelling.)
      assert.match(posixParent, /^\//, `expected a POSIX path from bare pwd, got "${posixParent}"`);
      assert.doesNotMatch(posixParent, /^[A-Za-z]:/, `bare pwd already native — nothing to prove: "${posixParent}"`);
      const broken = spawnSync('node', [`${posixParent}/probe.mjs`], { encoding: 'utf-8', env: { ...process.env, ...env } });
      assert.notEqual(broken.status, 0, 'red control invalid: the pre-fix path resolved');
      assert.match(broken.stderr, /Cannot find module/);
      assert.match(
        broken.stderr, /Cannot find module '[A-Za-z]:\\/,
        'red control invalid: node did not glue a drive letter onto the POSIX path',
      );

      // GREEN: the fixed derivation is already native, so node resolves it.
      assert.match(parent, /^[A-Za-z]:\//, `expected a native path, got "${parent}"`);
      const ok = spawnSync('node', [`${parent}/probe.mjs`], { encoding: 'utf-8', env: { ...process.env, ...env } });
      assert.equal(ok.status, 0, ok.stderr);
      assert.match(ok.stdout, /ran/);
    });
  });
});

describe('managed pre-push hook — plan-status gate distinguishes crash from violation', () => {
  it('probes runnability before interpreting the --drift exit code', () => {
    assert.match(HOOK_BODY, /--selfcheck-relocation/);
    // The probe must come FIRST; ordered the other way it explains a failure
    // it has already misreported.
    const probeAt = HOOK_BODY.indexOf('--selfcheck-relocation');
    const driftAt = HOOK_BODY.indexOf('node "$STATUS_CLI" --drift');
    assert.ok(probeAt > 0 && driftAt > probeAt, 'the runnability probe must precede --drift');
  });

  it('no longer claims a Status violation as the only possible failure', () => {
    // The pre-fix message, verbatim. It is the claim, not the wording, that was
    // wrong — so the assertion is that this exact sentence no longer stands
    // alone as the sole explanation of a non-zero exit.
    assert.doesNotMatch(
      HOOK_BODY,
      /\[prepush-hook\] a plan changed in this push has a non-conforming Status — fix it or set PLAN_STATUS_DISABLE=1/,
    );
  });

  it('says "CANNOT RUN" and names the path when the checker will not start', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    withTmp((tmp) => {
      const missing = path.join(tmp, 'not-here', 'check-plan-status.mjs');
      // RED CONTROL: the fixture must really be absent, or "cannot run" is vacuous.
      assert.equal(fs.existsSync(missing), false);

      const got = runGate(missing, tmp);
      assert.equal(got.status, 1, 'a checker that cannot run must not pass the push');
      assert.match(got.stderr, /CANNOT RUN/);
      assert.match(got.stderr, /NO plan Status was read/);
      assert.ok(
        got.stderr.includes('check-plan-status.mjs'),
        `the message must name the path it could not run:\n${got.stderr}`,
      );
      // The false claim must not appear on this path at all.
      assert.doesNotMatch(got.stderr, /non-conforming Status/);
      assert.doesNotMatch(got.stdout, /REACHED_END/);
    });
  });

  it('quotes the Error line rather than node\'s loader frame', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    withTmp((tmp) => {
      const broken = path.join(tmp, 'broken.mjs');
      fs.writeFileSync(broken, 'import x from "./definitely-not-here.mjs";\n');
      const got = runGate(broken, tmp);
      assert.equal(got.status, 1);
      // `node:internal/modules/...` + `throw err;` are the first lines of the
      // stack and say nothing an operator can act on.
      assert.match(got.stderr, /\|\s+Error\b/);
      assert.doesNotMatch(got.stderr, /\|\s+throw err;/);
    });
  });

  it('still blocks — and says the checker RAN — on a real violation', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    withTmp((tmp) => {
      const cli = writeFakeCli(tmp, { drift: 1 });
      const got = runGate(cli, tmp);
      assert.equal(got.status, 1, 'a genuine violation must still abort the push');
      assert.match(got.stderr, /the checker ran/);
      assert.match(got.stderr, /non-conforming Status/);
      assert.doesNotMatch(got.stderr, /CANNOT RUN/);
      assert.match(got.stderr, /fake lint output/, 'the CLI\'s own report must reach the operator');
    });
  });

  it('passes through when the checker runs and finds nothing', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    withTmp((tmp) => {
      const cli = writeFakeCli(tmp, { drift: 0 });
      const got = runGate(cli, tmp);
      assert.equal(got.status, 0, got.stderr);
      assert.match(got.stdout, /REACHED_END/);
      assert.doesNotMatch(got.stderr, /CANNOT RUN/);
      assert.doesNotMatch(got.stderr, /non-conforming Status/);
    });
  });

  it('is still bypassable by PLAN_STATUS_DISABLE=1', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    withTmp((tmp) => {
      // A checker that cannot run, plus the documented bypass: the escape hatch
      // has to keep working, or the honest message just becomes a wall.
      const file = path.join(tmp, '.gate.sh');
      fs.writeFileSync(file, planStatusFragment());
      const got = spawnSync('bash', [file, path.join(tmp, 'nope.mjs')], {
        cwd: tmp, encoding: 'utf-8', env: { ...process.env, PLAN_STATUS_DISABLE: '1' },
      });
      assert.equal(got.status, 0);
      assert.match(got.stdout, /REACHED_END/);
    });
  });
});

describe('managed pre-push hook — version marker', () => {
  it('bumped, so consumers re-install rather than keeping the broken body', () => {
    assert.match(HOOK_BODY, /# hook-version: (\d+)/);
    const v = Number(HOOK_BODY.match(/# hook-version: (\d+)/)[1]);
    assert.ok(v >= 4, `hook-version must be >= 4 for this fix, got ${v}`);
  });
});
