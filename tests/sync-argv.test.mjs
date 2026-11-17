/**
 * @fileoverview Debt 7798d3cef2ea + 2e26f79ebd92: `--target` / `--target-path`
 * were read as `argv[indexOf(flag) + 1]`, so a flag with no usable value read as
 * ABSENT and the run synced EVERY consumer; `--dry-run=true` passed validation
 * and ran a REAL sync.
 *
 * SAFETY: no test here spawns the CLI with a form that, on the parent code,
 * means "all consumers" — `CONSUMER_REPOS` always merges the real `BASE_REPOS`,
 * so doing so would sync the real consumers. The parent's behaviour is shown by
 * replaying its two expressions (`parentSelect`), pinned to the source of the
 * base commit so the replay cannot drift from what shipped.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSyncArgv, selectTargets, KNOWN_FLAGS } from '../scripts/lib/sync-argv.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_SHA = '8ce88fc2';

// The parent's selection, verbatim (scripts/sync-to-repos.mjs:221-224 and
// :950-952 at 8ce88fc2). `argv` is the full process.argv.
const PARENT_TARGET_EXPR = `const idx = process.argv.indexOf('--target');
  return idx === -1 ? null : process.argv[idx + 1];`;
const PARENT_SELECT_EXPR = `targetFilter
      ? REPOS.filter(r => r.name === targetFilter || r.alias === targetFilter)
      : REPOS;`;
function parentSelect(argv, repos) {
  const idx = argv.indexOf('--target');
  const targetFilter = idx === -1 ? null : argv[idx + 1];
  return targetFilter ? repos.filter((r) => r.name === targetFilter || r.alias === targetFilter) : repos;
}
const parentDryRun = (argv) => argv.includes('--dry-run');

const REPOS = [{ name: 'wine-cellar-app', alias: 'wine' }, { name: 'ai-organiser', alias: 'ai' }];
const sel = (args) => selectTargets(parseSyncArgv(args), REPOS);

describe('parent replay is pinned to the base commit', () => {
  test('the replayed expressions are byte-identical substrings of the base source', (t) => {
    let src;
    try {
      src = execFileSync('git', ['show', `${BASE_SHA}:scripts/sync-to-repos.mjs`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 });
    } catch { t.skip(`${BASE_SHA} not available (shallow clone)`); return; }
    src = src.replace(/\r\n/g, '\n');
    assert.ok(src.includes(PARENT_TARGET_EXPR), 'targetFilter expression drifted from the base');
    assert.ok(src.includes(PARENT_SELECT_EXPR), 'REPOS selection expression drifted from the base');
    assert.ok(src.includes("process.argv.includes('--dry-run')"), 'dry-run read drifted from the base');
  });
});

describe('D1 — a --target that is not a usable value never means "all"', () => {
  const bad = [
    // [label, args, parentSelectsAll] — the parent's fallthrough to ALL is only for a falsy value.
    ['trailing --target', ['--target'], true],
    ['--target ""', ['--target', ''], true],
    ['--target=', ['--target='], true],
    ['--target followed by a flag', ['--target', '--dry-run'], false], // parent: unknown target, exit 1 (safe, but the flag was swallowed)
    ['--target-path trailing', ['--target-path'], false],
    ['--target-path flag-shaped', ['--target-path', '--no-prompt'], false],
  ];
  for (const [label, args, parentSelectsAll] of bad) {
    test(`${label}: ${parentSelectsAll ? 'parent selects ALL (the bug); ' : ''}the parser errors`, () => {
      if (parentSelectsAll) {
        assert.equal(parentSelect(['node', 'x.mjs', ...args], REPOS).length, REPOS.length, 'parent replay must reproduce the bug (red evidence)');
      }
      assert.ok(parseSyncArgv(args).errors.length > 0);
      assert.ok('error' in sel(args));
    });
  }

  test('--target=wine: parent ignored it (selected ALL); the parser selects exactly wine', () => {
    assert.equal(parentSelect(['node', 'x.mjs', '--target=wine'], REPOS).length, REPOS.length);
    const r = sel(['--target=wine']);
    assert.deepEqual(r.repos.map((x) => x.alias), ['wine']);
    assert.equal(r.mode, 'registered');
  });

  test('--target wine and --target ai select one consumer; no flag selects all', () => {
    assert.deepEqual(sel(['--target', 'wine']).repos.map((x) => x.alias), ['wine']);
    assert.deepEqual(sel(['--target', 'ai-organiser']).repos.map((x) => x.alias), ['ai']);
    const all = sel(['--dry-run']);
    assert.equal(all.mode, 'all');
    assert.equal(all.repos.length, 2);
  });

  test('an unknown target is an error, not an empty or full set', () => {
    assert.match(sel(['--target', 'nope']).error, /Unknown target/);
  });

  test('--target-path value is returned and selects path mode', () => {
    const p = parseSyncArgv(['--target-path', 'C:/x/y']);
    assert.deepEqual([p.targetPath, p.errors], ['C:/x/y', []]);
    assert.equal(sel(['--target-path=/tmp/z']).mode, 'path');
  });
});

describe('D15 — grammar', () => {
  test('--dry-run=true: parent reads it as ABSENT (a real sync); the parser rejects it', () => {
    assert.equal(parentDryRun(['node', 'x.mjs', '--dry-run=true']), false, 'red evidence: the parent runs a real sync');
    for (const a of ['--dry-run=true', '--dry-run=false', '--no-prompt=1', '--adopt-orphans=']) {
      assert.ok(parseSyncArgv([a]).errors.length > 0, a);
    }
  });

  test('switches set their flag; a repeated switch is harmless', () => {
    const p = parseSyncArgv(['--dry-run', '--dry-run', '--no-prompt', '--allow-stale-base']);
    assert.deepEqual([p.flags.dryRun, p.flags.noPrompt, p.flags.allowStaleBase, p.flags.adoptOrphans, p.errors], [true, true, true, false, []]);
  });

  test('tokens after -- are ignored, including a switch (parent set dry-run from them)', () => {
    const p = parseSyncArgv(['--', '--dry-run', '--target']);
    assert.deepEqual([p.flags.dryRun, p.target, p.errors], [false, null, []]);
    assert.equal(parentDryRun(['node', 'x.mjs', '--', '--dry-run']), true, 'red evidence: the parent honoured it');
  });

  test('a bare positional before -- is an error; the node/script paths are not part of the input', () => {
    assert.ok(parseSyncArgv(['wine']).errors.length > 0);
    assert.deepEqual(parseSyncArgv(['--dry-run']).errors, []);
  });

  test('duplicate value flag and the two selectors together are errors', () => {
    assert.ok(parseSyncArgv(['--target', 'a', '--target', 'b']).errors.some((e) => /more than once/.test(e)));
    assert.ok(parseSyncArgv(['--target', 'a', '--target-path', '/x']).errors.some((e) => /mutually exclusive/.test(e)));
  });

  test('an unknown flag is left to assertKnownFlags, not mis-parsed', () => {
    assert.deepEqual(parseSyncArgv(['--bogus']).errors, []);
  });

  test('never throws on junk input', () => {
    for (const a of [undefined, null, [], [undefined], [42]]) assert.doesNotThrow(() => parseSyncArgv(a));
  });

  test('KNOWN_FLAGS lists exactly the flags the parser reads', () => {
    assert.deepEqual([...KNOWN_FLAGS].sort(), [
      '--adopt-orphans', '--allow-rollback', '--allow-stale-base', '--dry-run', '--no-prompt',
      '--overwrite-diverged', '--quiet-legacy-check', '--target', '--target-path',
    ]);
  });
});

describe('CLI wiring (spawns only forms that are safe on the parent too: they abort before any target resolves)', () => {
  const run = (args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/sync-to-repos.mjs'), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, MODEL_CATALOG_REFRESH: 'skip' },
  });

  test('trailing --target exits 2 and names the problem, before any target header', () => {
    const r = run(['--target']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--target requires a value/);
    assert.doesNotMatch(r.stdout, /wine-cellar|ai-organiser|storyline/i);
  });

  test('an unknown flag (--dry-runn) still exits 2 — the assertKnownFlags guard, by behaviour', () => {
    const r = run(['--dry-runn']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /unknown flag/);
  });

  test('--dry-run=true exits 2 instead of running a real sync', () => {
    const r = run(['--dry-run=true']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /takes no value/);
  });

  test('a valid --target-path --dry-run on an empty temp dir parses (no argv error)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-argv-'));
    try {
      const r = run(['--target-path', dir, '--dry-run', '--no-prompt']);
      assert.notEqual(r.status, 2, r.stderr);
      assert.doesNotMatch(r.stderr, /requires a value|takes no value|unexpected argument/);
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});
