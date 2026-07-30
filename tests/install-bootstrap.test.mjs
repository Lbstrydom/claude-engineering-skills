/**
 * `install.mjs` — the bootstrapper's structural contract.
 *
 * These are lint-grade assertions, and they are here because the failures they
 * catch were REAL in the previous version of this file, not hypothetical:
 *
 *   - a hardcoded `SCRIPTS` list of 7 files with no import closure (guaranteed
 *     MODULE_NOT_FOUND on first use);
 *   - a hardcoded skill list naming `audit-loop`, a skill that no longer exists,
 *     so 1 of 15 skills was installed;
 *   - a write to `.github/skills/`, a surface retired 2026-07-28 that AGENTS.md
 *     asserts no write path can resurrect — this file was an unaccounted-for
 *     fourth one;
 *   - deriving anything from `git remote`, which under `npx github:…` may be
 *     absent or may name the OPERATOR'S repo rather than the bundle's.
 *
 * The behavioural contract lives in `install-bootstrap-e2e.test.mjs`; source
 * assertions alone would pass a rename.
 *
 * Plan: docs/plans/repo-scoped-skill-surfaces-and-installer.md §2 D6a/D6b/D6d.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'install.mjs');
const RAW = fs.readFileSync(CLI, 'utf8');
const execFileAsync = promisify(execFile);

/**
 * Source with comments removed.
 *
 * Load-bearing for this whole file: `install.mjs`'s docstring deliberately NAMES
 * what was removed and why (`SCRIPTS`, `audit-loop`, `.github/skills/`, the
 * pre-push hook), because a future reader needs to know those were deleted on
 * purpose rather than overlooked. A naive scan of the raw text therefore flags
 * the very documentation that prevents the regression. Scanning CODE keeps both:
 * the explanation stays, and the assertion still means "no such code".
 */
const SRC = RAW
  .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments, incl. the fileoverview
  .replace(/(^|[^:])\/\/.*$/gm, '$1');   // line comments, sparing `https://`

async function run(argv, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...argv], {
      cwd: REPO_ROOT, timeout: 60_000, ...opts,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('install.mjs — owns no file lists', () => {
  test('no hardcoded runner-script list', () => {
    // The specific rot: `const SCRIPTS = ['openai-audit.mjs', …]`.
    assert.doesNotMatch(SRC, /\bSCRIPTS\s*=/, 'a hardcoded script list must not return');
    assert.doesNotMatch(SRC, /openai-audit\.mjs/, 'no individual runner may be named here');
    assert.doesNotMatch(SRC, /gemini-review\.mjs/);
  });

  test('no hardcoded skill list', () => {
    assert.doesNotMatch(SRC, /skillNames\s*=/);
    assert.doesNotMatch(SRC, /audit-loop/, 'the deleted audit-loop skill must not be referenced');
  });

  test('no hardcoded dependency list — the sync owns deps', () => {
    assert.doesNotMatch(SRC, /\bDEPS\s*=/);
  });

  test('it delegates to the sync engine rather than copying files itself', () => {
    assert.match(SRC, /sync-to-repos\.mjs/);
    assert.match(SRC, /--target-path/);
    // No direct file copying into the target.
    assert.doesNotMatch(SRC, /copyFileSync/, 'deployment is the sync engine\'s job');
  });
});

describe('install.mjs — retired surfaces stay retired', () => {
  test('never writes .github/skills/', () => {
    assert.doesNotMatch(SRC, /\.github['"\s,)\]]*.{0,12}skills/s,
      '.github/skills/ was retired 2026-07-28 — no write path may resurrect it');
  });

  test('never writes .cursor/rules or a pre-push hook into the consumer', () => {
    assert.doesNotMatch(SRC, /\.cursor/);
    assert.doesNotMatch(SRC, /pre-push/, 'the old version installed a source-repo-only hook here');
  });

  test('does not write to the machine-global skills surface', () => {
    // Assert the PROPERTY, not a loose substring: an earlier version of this test
    // used a fuzzy `.claude.{0,12}skills` pattern and flagged both the --help
    // text and the `~/.claude-engineering-skills` BUNDLE CACHE, neither of which
    // is a skills surface. What actually matters is that this file never joins a
    // global skills path and never reaches for the retired surface's resolver.
    assert.doesNotMatch(SRC, /['"]\.claude['"]\s*,\s*['"]skills['"]/,
      'must not construct a global ~/.claude/skills path');
    assert.doesNotMatch(SRC, /globalSurfaceRoot/,
      'the retired global surface resolver has no business here');
    // The cache under $HOME is fine and is NOT a skills surface — it holds the
    // bundle checkout. Pin that it stays a sibling name, not a skills path.
    assert.match(SRC, /'\.claude-engineering-skills',\s*'bundle'/);
  });
});

describe('install.mjs — bundle source is a constant (D6d)', () => {
  test('the source URL comes from bundleSource(pkg), never from a remote', () => {
    // `git remote get-url` DOES appear, and legitimately: it validates that the
    // CACHE's origin matches the constant, so a cache repointed by an earlier run
    // is deleted rather than fetched into. That is the opposite of deriving the
    // source from ambient state — but the two are easy to confuse, so pin the
    // distinction rather than banning the string.
    const remoteReads = [...SRC.matchAll(/get-url/g)];
    assert.equal(remoteReads.length, 1, 'exactly one remote read: the cache-origin check');
    assert.match(SRC, /=== sourceUrl/,
      'the remote read must be COMPARED against the canonical source, not used as it');
    assert.match(SRC, /const sourceUrl = bundleSource\(pkg\)/,
      'the source must be derived from the package manifest');
  });

  test('has no environment override for the source URL', () => {
    assert.doesNotMatch(SRC, /CES_BUNDLE_SOURCE/, 'an env override would reintroduce ambient source selection');
    // The cache LOCATION is overridable — that selects where a verified bundle is
    // stored, never what is fetched.
    assert.match(SRC, /CES_BUNDLE_CACHE/);
  });

  test('bundleSource is a pure function of a passed-in package object', async () => {
    const { bundleSource } = await import('../install.mjs');
    assert.equal(
      bundleSource({ repository: { url: 'https://github.com/o/r' } }),
      'https://github.com/o/r.git',
    );
    assert.equal(bundleSource({ repository: 'git+https://github.com/o/r.git' }),
      'https://github.com/o/r.git');
    assert.throws(() => bundleSource({}), /repository\.url/);
  });

  test("this package.json actually declares the repository (or bundleSource cannot work)", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    assert.ok(pkg.repository?.url, 'package.json must declare repository.url');
    assert.equal(pkg.bin['claude-engineering-skills'], 'install.mjs',
      'the public npx entry point must keep working');
  });
});

describe('install.mjs — CLI grammar', () => {
  test('--help exits 0 and describes the repo-scoped model', async () => {
    const r = await run(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /REPO-SCOPED/);
    assert.match(r.stdout, /skill-surface-ownership\.md/);
  });

  test('an unknown flag is refused, not ignored', async () => {
    const r = await run([os.tmpdir(), '--nope']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown flag "--nope"/);
  });

  test('--ref requires a value', async () => {
    const r = await run([os.tmpdir(), '--ref']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--ref requires a value/);
  });

  test('a second positional is an error, not silently ignored', async () => {
    const r = await run([os.tmpdir(), os.tmpdir()]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /expected one target directory/);
  });

  test('a missing target in non-interactive mode errors rather than guessing cwd', async () => {
    const r = await run([]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /target directory is required/);
  });

  test('a non-existent target is rejected before any work', async () => {
    const r = await run([path.join(os.tmpdir(), 'ces-definitely-not-here')]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Directory not found/);
  });
});

describe('install.mjs — the legacy migration never deletes without consent (D6b)', () => {
  test('the delete is gated on BOTH interactivity and an explicit answer', () => {
    // Asserted on source because the behaviour is a guard, and the e2e suite
    // proves the non-interactive path writes nothing.
    assert.match(SRC, /if \(!interactive\)/,
      'a non-interactive run must not reach the delete');
    assert.match(SRC, /--uninstall-legacy/,
      'removal must be delegated to the one command that owns it');
    // `--yes` means "do not prompt", NOT "you may delete my home directory".
    assert.match(SRC, /never auto-deletes|may do|without consent/i);
  });

  test('sync runs BEFORE the migration, so a repo is never left with neither copy', () => {
    const syncIdx = SRC.indexOf('runSync(bundleRoot');
    const migrateIdx = SRC.indexOf('migrateLegacy(bundleRoot');
    assert.ok(syncIdx > 0 && migrateIdx > 0);
    assert.ok(syncIdx < migrateIdx,
      'the correct copy must exist before the shadowing one is removed');
  });
});
