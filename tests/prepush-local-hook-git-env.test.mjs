/**
 * @fileoverview The consumer's `.githooks/pre-push.local` must run WITHOUT git's
 * repo-pointing environment (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ...).
 *
 * THE DEFECT (consumer report, 2026-10-08). Git exports repo-pointing variables
 * into a hook, and GIT_DIR beats cwd. Measured on git 2.54.0.windows.1 with a
 * `env | grep ^GIT_` pre-push hook:
 *
 *   - main checkout:              GIT_PREFIX only
 *   - LINKED WORKTREE:            GIT_DIR=<common>/.git/worktrees/<name>, GIT_PREFIX
 *   - `--git-dir/--work-tree`:    GIT_DIR, GIT_WORK_TREE, GIT_PREFIX
 *   - caller-exported GIT_DIR:    GIT_DIR, GIT_PREFIX
 *
 * `finish` ran the local hook with a bare `sh "$LOCAL_HOOK"`, so a consumer test
 * suite pushed from a linked worktree inherited GIT_DIR; its fixtures' `git init`
 * + `git config user.name ...` in a tmp dir wrote `core.bare=true` and a fake
 * identity into the SHARED .git/config. Every Claude Code session pushes from a
 * linked worktree, so this was the ordinary case, not an exotic one.
 *
 * TWO LAYERS, each with a negative control that runs the SAME fixture against
 * the pre-fix (v8) invocation and must see the leak — otherwise a green here
 * could mean the fixture never exported anything:
 *   1. a REAL `git push` from a linked worktree, so git itself does the export
 *      (no simulated env), reproducing the reported config pollution;
 *   2. the hook body run directly with EVERY name in GIT_LOCAL_ENV_VARS set, for
 *      the names a real push only exports in rarer invocations.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { _internals } from '../scripts/install-prepush-hook.mjs';
import { GIT_LOCAL_ENV_VARS } from '../scripts/lib/git-env-sanitize.mjs';
import { hasBash } from './lib/hook-test-helpers.mjs';
import { gitFixtureEnv } from './helpers/fixtures.mjs';

const { HOOK_BODY } = _internals;
const HAS_BASH = hasBash();
const HAS_GIT = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

const FIXED_INVOCATION = /\(\n\s*unset \$GIT_LOCAL_ENV_BASELINE[^\n]*\n\s*exec sh "\$LOCAL_HOOK"\n\s*\) \|\| exit \$\?/;
/** The v8 body, byte-for-byte at the one line this fix changed. */
function preFixBody() {
  const mutant = HOOK_BODY.replace(FIXED_INVOCATION, 'sh "$LOCAL_HOOK" || exit $?');
  assert.notEqual(mutant, HOOK_BODY, 'negative control could not locate the fixed invocation');
  return mutant;
}

/**
 * The local hook a consumer would write: records what it inherited, where git
 * discovery lands, then does exactly what the reporting consumer's fixtures did.
 */
const LOCAL_HOOK = [
  '#!/bin/sh',
  'env | grep "^GIT_" > "$PROBE_DIR/env.txt" || :',
  'git rev-parse --show-toplevel > "$PROBE_DIR/toplevel.txt" 2>&1 || :',
  'scratch="$PROBE_DIR/scratch"; mkdir -p "$scratch"; cd "$scratch"',
  'git init -q 2>/dev/null || :',
  'git config user.name Fake-Fixture-Identity 2>/dev/null || :',
  'exit "${LOCAL_EXIT:-0}"',
  '',
].join('\n');

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', env: gitFixtureEnv() });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed:\n${r.stderr}`);
  return r.stdout.trim();
}

/** Same form on both sides of a comparison: forward slashes, no case games. */
const norm = (p) => fs.realpathSync.native(p).replaceAll('\\', '/').toLowerCase();

function withWorkspace(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-gitenv-'));
  try {
    return fn(base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function readProbe(probe) {
  const envTxt = fs.existsSync(path.join(probe, 'env.txt'))
    ? fs.readFileSync(path.join(probe, 'env.txt'), 'utf-8') : null;
  const names = envTxt === null ? null
    : envTxt.split('\n').filter(Boolean).map((l) => l.slice(0, l.indexOf('=')));
  const top = path.join(probe, 'toplevel.txt');
  return { names, toplevel: fs.existsSync(top) ? fs.readFileSync(top, 'utf-8').trim() : null };
}

/**
 * A consumer with a bare remote and a LINKED worktree; the managed hook is
 * installed via a local core.hooksPath (a global hooksPath would otherwise win).
 */
function makeWorktreeConsumer(base, body) {
  const remote = path.join(base, 'remote.git');
  const main = path.join(base, 'main');
  const wt = path.join(base, 'wt');
  const hooks = path.join(base, 'hooks');
  git(['init', '-q', '--bare', remote], base);
  git(['init', '-q', '-b', 'main', main], base);
  git(['config', 'user.email', 'fixture@example.invalid'], main);
  git(['config', 'user.name', 'Fixture'], main);
  git(['commit', '-q', '--allow-empty', '-m', 'seed'], main);
  git(['remote', 'add', 'origin', remote], main);
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, 'pre-push'), body, { mode: 0o755 });
  git(['config', 'core.hooksPath', hooks.replaceAll('\\', '/')], main);
  git(['worktree', 'add', '-q', '-b', 'feature', wt], main);
  fs.mkdirSync(path.join(wt, '.githooks'));
  fs.writeFileSync(path.join(wt, '.githooks', 'pre-push.local'), LOCAL_HOOK);
  return { main, wt };
}

function realPush(base, body, extraEnv = {}) {
  const { main, wt } = makeWorktreeConsumer(base, body);
  const probe = path.join(base, 'probe');
  fs.mkdirSync(probe);
  const configBefore = fs.readFileSync(path.join(main, '.git', 'config'), 'utf-8');
  const r = spawnSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/feature'], {
    cwd: wt,
    encoding: 'utf-8',
    env: {
      ...gitFixtureEnv(),
      PROBE_DIR: probe.replaceAll('\\', '/'),
      CLAUDE_AUDIT_LOOP_DIR: '',
      PREPUSH_LOCAL_DISABLE: '',
      AUDIT_PREPUSH_DISABLE: '',
      ...extraEnv,
    },
  });
  const configAfter = fs.readFileSync(path.join(main, '.git', 'config'), 'utf-8');
  return { ...r, ...readProbe(probe), wt, configBefore, configAfter };
}

describe('managed pre-push hook — a real push from a linked worktree', () => {
  it('runs pre-push.local with no GIT_DIR, discovering the worktree from cwd', (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    withWorkspace((base) => {
      const got = realPush(base, HOOK_BODY);
      assert.equal(got.status, 0, got.stderr);
      assert.ok(got.names, `local hook did not run:\n${got.stderr}`);
      assert.deepEqual(got.names.filter((n) => GIT_LOCAL_ENV_VARS.includes(n)), [],
        `pre-push.local inherited git's repo-pointing env:\n${got.names.join('\n')}`);
      assert.equal(norm(got.toplevel), norm(got.wt), 'discovery from cwd must still find the pushing worktree');
      assert.equal(got.configAfter, got.configBefore, "the local hook's fixture repo wrote into the shared .git/config");
    });
  });

  it('NEGATIVE CONTROL: the pre-fix invocation leaks GIT_DIR and pollutes the shared config', (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    withWorkspace((base) => {
      const got = realPush(base, preFixBody());
      assert.ok(got.names, `local hook did not run:\n${got.stderr}`);
      // If git stops exporting GIT_DIR from a linked worktree, the case above
      // passes having tested nothing — this is what would say so.
      assert.ok(got.names.includes('GIT_DIR'), `git did not export GIT_DIR here:\n${got.names.join('\n')}`);
      assert.match(got.configAfter, /Fake-Fixture-Identity/,
        'fixture did not reproduce the reported pollution of the shared .git/config');
    });
  });

  it('keeps the local hook exit code authoritative through the subshell', (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    withWorkspace((base) => {
      const got = realPush(base, HOOK_BODY, { LOCAL_EXIT: '3' });
      assert.ok(got.names, 'local hook did not run');
      assert.notEqual(got.status, 0, 'a failing pre-push.local must still refuse the push');
      const landed = spawnSync('git', ['rev-parse', '--verify', '-q', 'refs/heads/feature'], {
        cwd: path.join(base, 'remote.git'), env: gitFixtureEnv(),
      });
      assert.notEqual(landed.status, 0, 'the ref reached the remote despite the local hook refusing');
    });
  });
});

describe('managed pre-push hook — every git-local name is stripped', () => {
  function runBody(body, consumer, probe, extraEnv = {}) {
    const script = path.join(consumer, '.hook.sh');
    fs.writeFileSync(script, body);
    const gitDir = path.join(consumer, '.git').replaceAll('\\', '/');
    // Every baseline name set, as a `--git-dir`/`-c`-heavy invocation could.
    const poisoned = Object.fromEntries(GIT_LOCAL_ENV_VARS.map((n) => [n, '']));
    Object.assign(poisoned, {
      GIT_DIR: gitDir,
      GIT_WORK_TREE: consumer.replaceAll('\\', '/'),
      GIT_INDEX_FILE: `${gitDir}/index`,
      GIT_OBJECT_DIRECTORY: `${gitDir}/objects`,
      GIT_COMMON_DIR: gitDir,
      GIT_PREFIX: '',
    });
    const r = spawnSync('bash', [script, 'origin', 'https://example.invalid'], {
      cwd: consumer,
      encoding: 'utf-8',
      input: '',
      env: {
        ...gitFixtureEnv(), ...poisoned,
        PROBE_DIR: probe.replaceAll('\\', '/'),
        CLAUDE_AUDIT_LOOP_DIR: '', PREPUSH_LOCAL_DISABLE: '', AUDIT_PREPUSH_DISABLE: '',
        ...extraEnv,
      },
    });
    return { ...r, ...readProbe(probe) };
  }

  function makeConsumer(base) {
    const consumer = path.join(base, 'consumer');
    const probe = path.join(base, 'probe');
    fs.mkdirSync(probe);
    git(['init', '-q', consumer], base);
    fs.mkdirSync(path.join(consumer, '.githooks'));
    fs.writeFileSync(path.join(consumer, '.githooks', 'pre-push.local'), LOCAL_HOOK);
    return { consumer, probe };
  }

  it('none of GIT_LOCAL_ENV_VARS reaches pre-push.local', (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    withWorkspace((base) => {
      const { consumer, probe } = makeConsumer(base);
      const got = runBody(HOOK_BODY, consumer, probe);
      assert.equal(got.status, 0, got.stderr);
      assert.ok(got.names, `local hook did not run:\n${got.stderr}`);
      assert.deepEqual(got.names.filter((n) => GIT_LOCAL_ENV_VARS.includes(n)), []);
      assert.equal(norm(got.toplevel), norm(consumer));
    });
  });

  it('NEGATIVE CONTROL: the pre-fix invocation passes every poisoned name through', (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    withWorkspace((base) => {
      const { consumer, probe } = makeConsumer(base);
      const got = runBody(preFixBody(), consumer, probe);
      assert.ok(got.names, `local hook did not run:\n${got.stderr}`);
      for (const n of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR']) {
        assert.ok(got.names.includes(n), `fixture failed to export ${n}; the case above proves nothing`);
      }
    });
  });

  it('propagates the local hook exit code unchanged out of the subshell', (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    withWorkspace((base) => {
      const { consumer, probe } = makeConsumer(base);
      const got = runBody(HOOK_BODY, consumer, probe, { LOCAL_EXIT: '3' });
      assert.ok(got.names, 'local hook did not run');
      assert.equal(got.status, 3, got.stderr);
    });
  });

  it('emits the shared baseline verbatim — one list, not two', () => {
    const line = HOOK_BODY.match(/^GIT_LOCAL_ENV_BASELINE="([^"]*)"$/m);
    assert.ok(line, 'GIT_LOCAL_ENV_BASELINE is not defined in the hook body');
    assert.deepEqual(line[1].split(' '), GIT_LOCAL_ENV_VARS);
  });

  it('bumped the version so consumers re-install', () => {
    const v = Number(HOOK_BODY.match(/# hook-version: (\d+)/)[1]);
    assert.ok(v >= 9, `hook-version must be >= 9 for this fix, got ${v}`);
  });
});
