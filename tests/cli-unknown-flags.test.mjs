/**
 * `assertKnownFlags` — reject unknown flags instead of ignoring them.
 *
 * Origin (2026-07-20): `symbol-index/refresh.mjs` parsed flags with an
 * if/else-if chain and no `else`, so an unrecognised flag was silently dropped.
 * `refresh.mjs --full --dry-run`, intended as a costing dry run, discarded
 * `--dry-run` and executed a REAL full refresh against the live store. It was
 * killed before publish, but stranded a `running` row holding the per-repo lock
 * that blocks every subsequent refresh.
 *
 * The assumption behind that command was reasonable: the sibling
 * `symbol-index/prune.mjs` DOES support `--dry-run`. A family where one
 * destructive CLI honours a flag and another silently ignores it fails in the
 * dangerous direction — the operator believes they asked for less work than they
 * got.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertKnownFlags, ArgvError } from '../scripts/lib/cli-io.mjs';
import { KNOWN_FLAGS } from '../scripts/symbol-index/refresh.mjs';
import { KNOWN_FLAGS as PRUNE_FLAGS } from '../scripts/symbol-index/prune.mjs';
import { KNOWN_FLAGS as RENDER_FLAGS } from '../scripts/symbol-index/render-mermaid.mjs';
import { KNOWN_FLAGS as RLS_FLAGS, _internals as RLS } from '../scripts/lib/remove-legacy-synced.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const argv = (...flags) => ['node', 'script.mjs', ...flags];

describe('assertKnownFlags', () => {
  const known = ['--full', '--since-commit'];

  it('accepts known flags', () => {
    assert.doesNotThrow(() => assertKnownFlags(argv('--full'), known));
  });

  it('rejects an unknown flag, naming it and what IS accepted', () => {
    assert.throws(
      () => assertKnownFlags(argv('--full', '--dry-run'), known, { cli: 'refresh' }),
      (err) => {
        assert.ok(err instanceof ArgvError);
        assert.equal(err.code, 'ARGV_ERROR');
        assert.match(err.message, /unknown flag "--dry-run"/);
        assert.match(err.message, /--full/, 'must list the accepted flags');
        return true;
      },
    );
  });

  it('accepts --flag=value by checking the name half', () => {
    assert.doesNotThrow(() => assertKnownFlags(argv('--since-commit=abc123'), known));
    assert.throws(() => assertKnownFlags(argv('--nope=1'), known), ArgvError);
  });

  it('ignores positionals — it validates flag NAMES only', () => {
    assert.doesNotThrow(() => assertKnownFlags(argv('somefile.md', '--full', 'other'), known));
  });

  it('stops at `--`, the POSIX end-of-flags marker', () => {
    assert.doesNotThrow(() => assertKnownFlags(argv('--full', '--', '--not-a-flag'), known));
  });

  it('skips argv[0] and argv[1] by default', () => {
    // A script path that happens to look flag-ish must not be validated.
    assert.doesNotThrow(() => assertKnownFlags(['node', '--weird-path.mjs'], known));
  });
});

describe('refresh.mjs — the CLI that motivated this', () => {
  it('KNOWN_FLAGS lists ONLY flags the parser actually handles', () => {
    // The trap this pins: a first draft listed `--selfcheck-relocation` on the
    // assumption refresh.mjs carried the smoke handler its siblings do. It does
    // not, so the guard ACCEPTED the flag, the parser ignored it, and the run
    // proceeded to a real live refresh — the accepted-then-ignored bug
    // reintroduced one layer up. An allowlist entry is a claim the parser does
    // something with it, so assert that claim against the source.
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts', 'symbol-index', 'refresh.mjs'), 'utf-8');
    const body = src.slice(src.indexOf('function parseArgs'), src.indexOf('function logErr'));
    for (const flag of KNOWN_FLAGS) {
      assert.ok(body.includes(`'${flag}'`),
        `${flag} is allow-listed but parseArgs never handles it — it would be accepted and ignored`);
    }
  });

  it('does NOT allow-list --selfcheck-relocation (it has no handler)', () => {
    assert.ok(!KNOWN_FLAGS.includes('--selfcheck-relocation'));
  });

  it('rejects the exact invocation that caused the incident, doing no work', () => {
    // End-to-end through the real binary: exit 2 (bad CLI input), and crucially
    // it must fail BEFORE opening a refresh_run.
    let status = 0; let stderr = '';
    try {
      execFileSync(process.execPath,
        [path.join(REPO_ROOT, 'scripts', 'symbol-index', 'refresh.mjs'), '--full', '--dry-run'],
        { cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    } catch (err) {
      status = err.status; stderr = String(err.stderr || '');
    }
    assert.equal(status, 2, 'unknown flag is bad CLI input → exit 2');
    assert.match(stderr, /unknown flag "--dry-run"/);
    assert.doesNotMatch(stderr, /opened refresh_run/,
      'it must refuse BEFORE acquiring the per-repo lock — that lock is what a '
      + 'killed run strands, blocking every later refresh');
  });
});

describe('prune.mjs — the sibling that fails in the dangerous direction', () => {
  it('rejects a typo of its only flag rather than really pruning', () => {
    // prune DELETES rows. Its sole flag is the one that makes it harmless, so a
    // silently-dropped `--dry-runn` performed a real prune the operator had
    // explicitly asked to only preview. Strictly worse than refresh's failure.
    let status = 0; let stderr = '';
    try {
      execFileSync(process.execPath,
        [path.join(REPO_ROOT, 'scripts', 'symbol-index', 'prune.mjs'), '--dry-runn'],
        { cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    } catch (err) {
      status = err.status; stderr = String(err.stderr || '');
    }
    assert.equal(status, 2, 'usage mistake → exit 2, not 1 (operational failure)');
    assert.match(stderr, /unknown flag "--dry-runn"/);
    assert.doesNotMatch(stderr, /at .*\.mjs:\d+/, 'a stack trace buries the actionable line');
    assert.doesNotMatch(stderr, /pruned=|aborted=\d/, 'must refuse before deleting anything');
  });

  it('KNOWN_FLAGS lists ONLY flags the parser actually handles', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts', 'symbol-index', 'prune.mjs'), 'utf-8');
    const body = src.slice(src.indexOf('function parseArgs'), src.indexOf('const ROLLBACK_KEEP'));
    for (const flag of PRUNE_FLAGS) {
      assert.ok(body.includes(`'${flag}'`), `${flag} is allow-listed but never handled`);
    }
  });
});

describe('render-mermaid.mjs — overwrites a committed artifact', () => {
  // Swept in 2026-07-20 by /audit-code: parseArgs had the same if/no-else
  // shape as the refresh.mjs incident, so `arch:render --dry-run` rendered
  // for REAL — and this CLI overwrites docs/architecture-map.md. It also took
  // `--out` with no value, putting `undefined` into path.resolve and
  // surfacing as an implementation error rather than a usage diagnostic.
  const runRender = (...flags) => {
    let status = 0, stderr = '';
    try {
      execFileSync(process.execPath,
        [path.join(REPO_ROOT, 'scripts', 'symbol-index', 'render-mermaid.mjs'), ...flags],
        { cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    } catch (err) {
      status = err.status; stderr = String(err.stderr || '');
    }
    return { status, stderr };
  };

  it('refuses an unknown flag with exit 2 and no stack trace', () => {
    const { status, stderr } = runRender('--dry-run');
    assert.equal(status, 2, 'usage mistake → exit 2, not 1 (operational failure)');
    assert.match(stderr, /unknown flag "--dry-run"/);
    assert.doesNotMatch(stderr, /at .*\.mjs:\d+/, 'a stack trace buries the actionable line');
    assert.doesNotMatch(stderr, /wrote .*architecture-map/, 'must refuse BEFORE writing the artifact');
  });

  it('rejects --out with no value instead of resolving undefined', () => {
    const { status, stderr } = runRender('--out');
    assert.equal(status, 2);
    assert.match(stderr, /--out requires a file path/);
    assert.doesNotMatch(stderr, /at .*\.mjs:\d+/);
  });

  it('does not double-prefix the diagnostic', () => {
    // assertKnownFlags already leads with the cli name; prefixing again in the
    // catch produced "arch:render: arch:render: unknown flag ...".
    const { stderr } = runRender('--dry-run');
    assert.doesNotMatch(stderr, /arch:render:\s*arch:render:/);
  });

  it('KNOWN_FLAGS lists ONLY flags the parser actually handles', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts', 'symbol-index', 'render-mermaid.mjs'), 'utf-8');
    const body = src.slice(src.indexOf('function parseArgs'), src.indexOf('function commitSha'));
    for (const flag of RENDER_FLAGS) {
      assert.ok(body.includes(`'${flag}'`), `${flag} is allow-listed but never handled`);
    }
  });
});

describe('remove-legacy-synced.mjs — deletes files in someone ELSE\'s repo', () => {
  // The sharpest instance found by a mechanical sweep of every flag-parsing
  // script for genuinely destructive calls (unlink / git rm / DB row deletion /
  // snapshot publication). An earlier eyeball pass claimed refresh and prune
  // were the only two; that was wrong, which is why this sweep was mechanical.

  it('rejects a typo of --dry-run rather than really deleting', () => {
    assert.throws(
      () => RLS.parseArgs(['--consumer-root', '/tmp/x', '--dry-runn']),
      (err) => {
        assert.equal(err.code, 'ARGV_ERROR');
        assert.match(err.message, /unknown flag "--dry-runn"/);
        return true;
      },
    );
  });

  it('parses from index 0 — it receives an already-sliced argv', () => {
    // Getting `from` wrong would silently skip the first two real flags,
    // reopening the hole for exactly the arguments most likely to be typed.
    assert.throws(() => RLS.parseArgs(['--bogus']), { code: 'ARGV_ERROR' });
    assert.doesNotThrow(() => RLS.parseArgs(['--dry-run']));
  });

  it('still accepts every flag it documents, including value-taking ones', () => {
    const parsed = RLS.parseArgs([
      '--consumer-root', '/tmp/consumer', '--legacy-manifest', '/tmp/m.json',
      '--dry-run', '--force-dirty',
    ]);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.forceDirty, true);
    assert.equal(parsed.consumerRoot, '/tmp/consumer');
  });

  it('KNOWN_FLAGS lists ONLY flags the parser actually handles', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts', 'lib', 'remove-legacy-synced.mjs'), 'utf-8');
    const body = src.slice(src.indexOf('function parseArgs'), src.indexOf('function validateRelPath'));
    for (const flag of RLS_FLAGS) {
      assert.ok(body.includes(`'${flag}'`), `${flag} is allow-listed but never handled`);
    }
  });
});
