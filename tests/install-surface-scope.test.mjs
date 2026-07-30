/**
 * @fileoverview `install-skills.mjs` must not install, and must say so.
 *
 * ## What this file used to guard, and why it changed
 *
 * Incident (2026-07-19): the source repo's post-merge hook ran
 * `install-skills.mjs --local --surface claude --force` after every `git pull`.
 * That is a GLOBAL-surface run — it wrote `~/.claude/skills` only — but it also
 * called `ensureAuditGitignore(repoRoot)`/`ensureAuditDeps(repoRoot)`
 * unconditionally, so every pull appended a consumer-shaped managed block to the
 * SOURCE repo's `.gitignore`. The fix at the time was a repo-scope guard keyed on
 * `authoritativeScopesFor(args.surface)`, and these tests pinned it.
 *
 * That guard is now GONE, along with the whole install path — not regressed.
 * Field evidence in 2026-07 showed the deeper defect: the global surface writes
 * layout-dependent runner paths into a layout-agnostic directory shared by every
 * repo, so `~/.claude/skills/ship/SKILL.md` cited `scripts/ship-commit.mjs` while
 * the correct consumer copy cited `scripts/.claude-skills/ship-commit.mjs`. No
 * scope guard fixes that; only removing the surface does.
 *
 * So the property under test is now stronger and simpler: **no invocation of this
 * CLI can write a skill file anywhere.** The repo-scope-leak class the old tests
 * guarded is closed a fortiori — there is no install path left to leak from.
 *
 * Plan: docs/plans/repo-scoped-skill-surfaces-and-installer.md §2 D2/D3/D3a.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'install-skills.mjs');
const execFileAsync = promisify(execFile);

const SRC = fs.readFileSync(CLI, 'utf8');

/** Run the CLI, resolving on ANY exit code so we can assert on it. */
async function run(argv, cwd = REPO_ROOT) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...argv], { cwd });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/**
 * Recursively list every file under `dir` (relative paths), or [] if absent.
 * Used to assert on what a run actually WROTE, rather than on what the source
 * text looks like.
 */
function listFiles(dir, base = dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(abs, base, out);
    else out.push(path.relative(base, abs));
  }
  return out;
}

// THE semantic guarantee, asserted behaviourally.
//
// The source-regex tests below are cheap canaries, but they cannot carry this
// contract on their own: a future implementation that restored writes under
// renamed helpers, direct `fs.writeFileSync` calls, or a brand-new resolution
// path would sail past every `doesNotMatch`, and a harmless rename would fail
// them without changing behaviour. So the contract — *no invocation of this CLI
// writes a skill file anywhere* — is tested by running the invocations and
// diffing the trees.
describe('install-skills / no invocation writes anything (semantic)', () => {
  const RETIRED_INVOCATIONS = [
    [],
    ['--surface', 'claude'],
    ['--surface', 'agents'],
    ['--surface', 'both'],
    ['--surface', 'copilot'],
    ['--local'],
    ['--remote'],
    ['--skills', 'ship'],
    ['--local', '--surface', 'claude', '--force'],   // the exact retired post-merge command
  ];

  for (const argv of RETIRED_INVOCATIONS) {
    test(`\`${argv.join(' ') || '(no args)'}\` writes no file to home or repo`, async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-skills-sem-'));
      try {
        const home = path.join(tmp, 'home');
        const repo = path.join(tmp, 'repo');
        fs.mkdirSync(home, { recursive: true });
        fs.mkdirSync(repo, { recursive: true });

        const before = { home: listFiles(home), repo: listFiles(repo) };
        // `--force` is not a known flag any more, so drop it and rely on the
        // retired-flag refusal that precedes any write regardless.
        const cleaned = argv.filter(a => a !== '--force');
        await execFileAsync(process.execPath, [CLI, ...cleaned], {
          cwd: repo,
          env: { ...process.env, HOME: home, USERPROFILE: home },
        }).catch(() => { /* every retired invocation is expected to exit non-zero */ });

        assert.deepEqual(listFiles(home), before.home,
          `home tree changed — a retired invocation wrote something: ${argv.join(' ')}`);
        assert.deepEqual(listFiles(repo), before.repo,
          `repo tree changed — a retired invocation wrote something: ${argv.join(' ')}`);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    });
  }
});

describe('install-skills / the install path is gone (source canaries)', () => {
  test('no repo-mutating install side effect remains in the source', () => {
    // The 2026-07-19 incident's two call sites. Their absence — not their
    // gating — is what makes the leak unreachable now.
    assert.doesNotMatch(SRC, /ensureAuditGitignore\(/, 'the gitignore write must be gone, not gated');
    assert.doesNotMatch(SRC, /ensureAuditDeps\(/, 'the dependency install must be gone, not gated');
  });

  test('the source no longer resolves skill write targets at all', () => {
    assert.doesNotMatch(SRC, /resolveSkillFiles\(/, 'no skill-file target resolution');
    assert.doesNotMatch(SRC, /resolveSkillTargets\(/, 'no surface target resolution');
  });

  test('the module states why, and names the replacement', () => {
    assert.match(SRC, /no longer install/i);
    assert.match(SRC, /sync-to-repos\.mjs --target-path/);
    assert.match(SRC, /skill-surface-ownership\.md/);
  });
});

describe('install-skills / retired invocations are refused, never silently ignored', () => {
  test('a bare invocation exits 2 with the replacement hint (functional)', async () => {
    const r = await run([]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /no longer installs skills/);
    assert.match(r.stderr, /sync-to-repos\.mjs --target-path/);
  });

  for (const flag of ['--surface', '--local', '--remote', '--skills']) {
    test(`${flag} is refused by name (functional)`, async () => {
      const argv = flag === '--surface' ? [flag, 'claude'] : flag === '--skills' ? [flag, 'ship'] : [flag];
      const r = await run(argv);
      assert.equal(r.code, 2);
      assert.match(r.stderr, new RegExp(`${flag}`), 'the retired flag must be named back to the operator');
    });
  }

  test('a retired flag cannot be smuggled in alongside --uninstall-legacy', async () => {
    const r = await run(['--uninstall-legacy', '--surface', 'claude']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /retired and cannot be combined/);
  });

  // docs/plans/refactor-skill-governance.md round-1 audit H1 — the parseArgs
  // switch has no default case for this flag's VALUE form, so bare-deleting the
  // arm would make it silently ignored rather than rejected.
  test('the source carries an explicit exit-2 case for --keep-github-skills, not a bare removal', () => {
    const arm = /case '--keep-github-skills':([\s\S]*?)break;/.exec(SRC);
    assert.ok(arm, 'expected a case arm for --keep-github-skills');
    assert.match(arm[1], /process\.exit\(2\)/, 'must exit 2, not silently fall through');
  });

  test('--keep-github-skills exits 2 with a diagnostic (functional)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-skills-'));
    try {
      const r = await run(['--target', tmp, '--keep-github-skills']);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /--keep-github-skills was removed/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  test('--help exits 0 and does not install anything', async () => {
    const r = await run(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /no longer install/i);
  });

  test('an unknown flag aborts rather than being ignored', async () => {
    // A mutating command must never proceed past a token it did not understand.
    const r = await run(['--uninstall-legacy', '--dry-runn']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown flag "--dry-runn"/);
  });

  // The brake-loss shape: `assertKnownFlags` checks flag NAMES, so without a
  // separate guard `--home --dry-run` resolves the string "--dry-run" into a home
  // path and leaves dryRun false — the operator asked for a rehearsal and would
  // have got a real delete against a nonsense root.
  for (const flag of ['--home', '--target', '--repo-root']) {
    test(`${flag} refuses to swallow a following flag as its value`, async () => {
      const r = await run(['--uninstall-legacy', flag, '--dry-run']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /must not swallow another flag/);
    });

    test(`${flag} with no value at all is an error, not a default`, async () => {
      const r = await run(['--uninstall-legacy', flag]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /requires a directory path/);
    });
  }

  // The same brake-loss wearing an equals sign. `assertKnownFlags` validates the
  // NAME half of `--flag=value`, so `--home=/somewhere` passed the gate and then
  // fell through the whole-token switch — leaving `home` null and acting on the
  // AMBIENT home. Verified before the fix: `--home=/tmp/x` printed
  // `Home: C:\Users\User`. On the one command that deletes from `$HOME`, a flag
  // that is accepted and then ignored is worse than one that is rejected.
  test('--home=<path> is honoured, not silently dropped', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-skills-eq-'));
    try {
      const home = path.join(tmp, 'h');
      const repo = path.join(tmp, 'r');
      fs.mkdirSync(home, { recursive: true });
      fs.mkdirSync(repo, { recursive: true });
      const r = await run([`--uninstall-legacy`, `--home=${home}`, `--repo-root=${repo}`]);
      assert.equal(r.code, 0);
      assert.match(r.stdout, new RegExp(home.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&')),
        'the =-form value must reach the run, not the ambient home');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  test('an =-value on a flag that takes none is refused', async () => {
    const r = await run(['--uninstall-legacy', '--dry-run=1']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /does not take a value/);
  });

  test('an empty =-value is refused rather than treated as absent', async () => {
    const r = await run(['--uninstall-legacy', '--home=']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /requires a value/);
  });
});

// The success-path adversarial question (AGENTS.md pre-ship rule 3): can this
// return green without having checked anything? A no-op must NAME the state it
// observed, so "clean" is a claim about the tree rather than about the code path.
describe('install-skills / --uninstall-legacy is honest when there is nothing to do', () => {
  test('a pristine home + repo reports `clean` explicitly and exits 0', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-skills-'));
    try {
      const home = path.join(tmp, 'home');
      const repo = path.join(tmp, 'repo');
      fs.mkdirSync(home, { recursive: true });
      fs.mkdirSync(repo, { recursive: true });

      const r = await run(['--uninstall-legacy', '--home', home, '--repo-root', repo]);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /clean/, 'a no-op must name the state it observed');
      assert.match(r.stdout, /Nothing to do/i);
      // And it must have looked at the roots it was TOLD to look at.
      assert.match(r.stdout, new RegExp(home.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&')));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  test('re-running is idempotent', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-skills-'));
    try {
      const home = path.join(tmp, 'home');
      const repo = path.join(tmp, 'repo');
      fs.mkdirSync(home, { recursive: true });
      fs.mkdirSync(repo, { recursive: true });
      const a = await run(['--uninstall-legacy', '--home', home, '--repo-root', repo]);
      const b = await run(['--uninstall-legacy', '--home', home, '--repo-root', repo]);
      assert.equal(a.code, 0);
      assert.equal(b.code, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
