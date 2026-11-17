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
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
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
    const r = spawnSync('git', ['show', `${BASE_SHA}:scripts/sync-to-repos.mjs`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
    if (r.error) throw r.error; // git itself is missing: a real failure, never a skip
    if (r.status !== 0) {
      // Skip ONLY for the documented case (the base commit is absent, e.g. a shallow clone); any other git failure fails loudly.
      if (/bad object|unknown revision|invalid object name|not a valid object|bad revision/i.test(r.stderr)) { t.skip(`${BASE_SHA} not available (shallow clone)`); return; }
      assert.fail(`git show ${BASE_SHA} failed: ${r.stderr}`);
    }
    const src = r.stdout.replace(/\r\n/g, '\n');
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

  test('anything after -- is an ERROR: discarding `-- --dry-run` would turn a safety flag into a real sync', () => {
    for (const a of [['--', '--dry-run'], ['--target', 'wine', '--', '--dry-run'], ['--', 'x']]) {
      const p = parseSyncArgv(a);
      assert.ok(p.errors.some((e) => /after "--"/.test(e)), JSON.stringify(a));
      assert.ok('error' in selectTargets(p, REPOS), 'must not fall through to a selection');
    }
    assert.equal(parentDryRun(['node', 'x.mjs', '--', '--dry-run']), true, 'red evidence: the parent honoured it');
    assert.deepEqual(parseSyncArgv(['--dry-run', '--']).errors, [], 'a bare trailing -- is harmless');
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

describe('CLI wiring — spawns forms that mean "ALL consumers" or a REAL sync on the parent code', () => {
  // SAFETY PRECONDITION (code-audit R1 H17): these spawns are safe ONLY against the fixed CLI. On the
  // parent, a trailing `--target` syncs every registered consumer and `--dry-run=true` runs for real.
  // So no spawn runs unless the CLI under test reads its flags through the parser and the selector.
  const cliSource = fs.readFileSync(path.join(ROOT, 'scripts/sync-to-repos.mjs'), 'utf8');
  // Text AND behaviour (code-audit R3 H1): the CLI source must route through the parser/selector, AND the parser it
  // imports (this very module) must, in-process, reject every argv about to be spawned. A middle revision whose
  // parser stops rejecting passes the text check alone, which is exactly the case this behavioural half closes.
  const DANGEROUS_ARGV = [['--', '--dry-run'], ['--target'], ['--dry-run=true']];
  const fixedCli = /parseSyncArgv\(process\.argv\.slice\(2\)\)/.test(cliSource)
    && /selectTargets\(ARGV, REPOS\)/.test(cliSource)
    && DANGEROUS_ARGV.every((a) => parseSyncArgv(a).errors.length > 0);
  const run = (args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/sync-to-repos.mjs'), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, MODEL_CATALOG_REFRESH: 'skip' },
  });

  // An argv rejection must happen BEFORE any work: exit 2 and nothing on stdout (the run header, target lines and
  // every consumer write come after the argv check), so no consumer was reached (code-audit R2 H1).
  const assertAbortedBeforeWork = (r, pattern) => {
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, pattern);
    assert.equal(r.stdout, '', 'stdout must be empty: the run never started');
  };

  test('precondition: the CLI under test is the fixed one (else NO spawn runs)', () => {
    assert.ok(fixedCli, 'scripts/sync-to-repos.mjs does not use the parser: spawning it with these argv would sync the REAL consumers');
  });

  test('-- --dry-run exits 2 (the parent honoured it; silently discarding it would run for real)', (t) => {
    if (!fixedCli) return t.skip('unfixed CLI: refusing to spawn');
    assertAbortedBeforeWork(run(['--', '--dry-run']), /after "--"/);
  });

  test('trailing --target exits 2 and names the problem, before any target header', (t) => {
    if (!fixedCli) return t.skip('unfixed CLI: refusing to spawn');
    assertAbortedBeforeWork(run(['--target']), /--target requires a value/);
  });

  test('an unknown flag (--dry-runn) still exits 2 — the assertKnownFlags guard, by behaviour', (t) => {
    if (!fixedCli) return t.skip('unfixed CLI: refusing to spawn');
    assertAbortedBeforeWork(run(['--dry-runn']), /unknown flag/);
  });

  test('--dry-run=true exits 2 instead of running a real sync', (t) => {
    if (!fixedCli) return t.skip('unfixed CLI: refusing to spawn');
    assertAbortedBeforeWork(run(['--dry-run=true']), /takes no value/);
  });

  // The VALID-invocation path (`--target-path <fixture> --no-prompt` reaching a real target and producing the consumer
  // layout, exit 0, idempotent) is covered end to end by tests/sync-target-path.test.mjs, which drives this same CLI
  // through the parser. Not duplicated here with a weaker assertion (code-audit R2 M1).
});
