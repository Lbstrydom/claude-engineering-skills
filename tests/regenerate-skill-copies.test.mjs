/**
 * @fileoverview `--dry-run` must not touch the filesystem.
 *
 * The bug this guards (2026-07-20): copyFileIfChanged and syncSkillToDests both
 * ran `fs.mkdirSync` UNCONDITIONALLY, ahead of the `opts.dryOrCheck` branch. So
 * `regenerate-skill-copies.mjs --keep-github-skills --dry-run` materialised 31
 * empty `.github/skills/<name>/` directories, which then hard-failed
 * `check-stale-skill-surface --gate` (a `.github/skills` tree shadows
 * `.claude/skills` for Copilot). A safety flag that still mutates the
 * filesystem is the same defect class as one that gets silently dropped — the
 * operator asked to be SHOWN, and the tool did something. mkdir now lives on
 * the write path only; this pins it.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { _internals } from '../scripts/regenerate-skill-copies.mjs';

const { copyFileIfChanged, removeStaleGithubSkills } = _internals;
const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'regenerate-skill-copies.mjs');

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

describe('copyFileIfChanged — --dry-run creates nothing', () => {
  it('dryOrCheck does NOT mkdir the destination parent', () => {
    const src = path.join(tmp, 'src.md');
    fs.writeFileSync(src, 'hello');
    // A destination whose parent directory does not exist yet.
    const dst = path.join(tmp, 'brand', 'new', 'dir', 'out.md');

    const result = copyFileIfChanged(src, dst, { dryOrCheck: true });

    assert.equal(result, 'wrote', 'it still REPORTS the pending write (a create)');
    assert.equal(fs.existsSync(path.dirname(dst)), false, 'but must not have created the directory');
    assert.equal(fs.existsSync(dst), false, 'and must not have written the file');
  });

  it('the write path DOES mkdir + write (the fix did not disable real writes)', () => {
    const src = path.join(tmp, 'src.md');
    fs.writeFileSync(src, 'hello');
    const dst = path.join(tmp, 'brand', 'new', 'dir', 'out.md');

    const result = copyFileIfChanged(src, dst, { dryOrCheck: false });

    assert.equal(result, 'wrote');
    assert.equal(fs.existsSync(dst), true, 'the parent was created and the file written');
    assert.equal(fs.readFileSync(dst, 'utf-8'), 'hello');
  });

  it('an identical destination is unchanged in BOTH modes (no write, no mkdir)', () => {
    const src = path.join(tmp, 'src.md');
    const dst = path.join(tmp, 'out.md');
    fs.writeFileSync(src, 'same');
    fs.writeFileSync(dst, 'same');
    assert.equal(copyFileIfChanged(src, dst, { dryOrCheck: true }), 'unchanged');
    assert.equal(copyFileIfChanged(src, dst, { dryOrCheck: false }), 'unchanged');
  });
});

/**
 * The bug this guards (2026-08-08): `copyFileIfChanged` hashed RAW working-tree
 * bytes, so a destination differing from its source only by line endings read
 * as changed. `.gitattributes` pins `* text=auto eol=lf`, so git reports both
 * trees clean and considers them identical content — the check disagreed with
 * git. Observed live in a worktree whose `.claude/skills/**` landed as CRLF
 * while `skills/**` landed as LF: all 67 destinations reported "differ from
 * source", which fails `skills:check` and sends the operator to regenerate,
 * committing an EOL flip as if it were content. Same class as the
 * `skills.manifest.json` bundleVersion bug that AGENTS.md already records.
 *
 * Both directions are pinned: EOL-only must be `unchanged`, and a real content
 * difference must still be `wrote`. Without the second case the fix could pass
 * by comparing nothing at all.
 */
describe('copyFileIfChanged — line endings are git\'s business, not content', () => {
  const write = (p, s) => { fs.writeFileSync(p, s); return p; };

  it('treats a CRLF destination as UNCHANGED against an LF source', () => {
    const src = write(path.join(tmp, 'src.md'), 'alpha\nbeta\ngamma\n');
    const dst = write(path.join(tmp, 'dst.md'), 'alpha\r\nbeta\r\ngamma\r\n');
    assert.equal(copyFileIfChanged(src, dst, { dryOrCheck: true }), 'unchanged');
  });

  it('treats an LF destination as UNCHANGED against a CRLF source (both directions)', () => {
    const src = write(path.join(tmp, 'src.md'), 'alpha\r\nbeta\r\n');
    const dst = write(path.join(tmp, 'dst.md'), 'alpha\nbeta\n');
    assert.equal(copyFileIfChanged(src, dst, { dryOrCheck: true }), 'unchanged');
  });

  it('still reports a REAL content difference (not blinded by the fold)', () => {
    const src = write(path.join(tmp, 'src.md'), 'alpha\nbeta\n');
    const dst = write(path.join(tmp, 'dst.md'), 'alpha\r\nbeta\r\nEXTRA\r\n');
    assert.equal(copyFileIfChanged(src, dst, { dryOrCheck: true }), 'wrote');
  });

  it('still reports a difference that is ONLY a lone CR (not part of a CRLF)', () => {
    // A bare CR is not a line ending git normalizes, so it is real content.
    const src = write(path.join(tmp, 'src.md'), 'alpha\nbeta\n');
    const dst = write(path.join(tmp, 'dst.md'), 'alpha\n\rbeta\n');
    assert.equal(copyFileIfChanged(src, dst, { dryOrCheck: true }), 'wrote');
  });
});

describe('importing the module is side-effect free', () => {
  it('exposes _internals without having run main()', () => {
    // If main() ran on import it would regenerate the real .claude/skills tree
    // and process.exit(0), killing this runner — the module-scope-main coupling
    // the isMain guard exists to prevent. Reaching this assertion proves it did
    // not fire.
    assert.equal(typeof copyFileIfChanged, 'function');
    assert.equal(typeof _internals.pruneFilesNotInSource, 'function');
  });
});

// docs/plans/refactor-skill-governance.md Phase 1 — removeStaleGithubSkills.
// `ghSkillsDir` is injected (never the real repo's own `.github/skills/`) so
// these tests can never leave a stray shadowing tree behind in this repo.
describe('removeStaleGithubSkills — active delete of a pre-existing .github/skills/', () => {
  it('a missing directory is a silent no-op success', () => {
    const ghSkillsDir = path.join(tmp, 'github-skills-absent');
    const result = removeStaleGithubSkills({ dryOrCheck: false }, {
      ghSkillsDir,
      rmSyncFn: () => { throw new Error('must never be called for a missing directory'); },
    });
    assert.equal(result, 0);
  });

  it('--dry-run/--check report the would-be removal without touching disk', () => {
    const ghSkillsDir = path.join(tmp, 'github-skills');
    fs.mkdirSync(ghSkillsDir, { recursive: true });
    fs.writeFileSync(path.join(ghSkillsDir, 'SKILL.md'), 'stale');

    const result = removeStaleGithubSkills({ dryOrCheck: true }, {
      ghSkillsDir,
      rmSyncFn: () => { throw new Error('--dry-run must never call rmSync'); },
    });

    assert.equal(result, 1, 'reports the pending deletion');
    assert.equal(fs.existsSync(ghSkillsDir), true, 'directory untouched');
  });

  it('a real run actively removes the tree and increments the delete count', () => {
    const ghSkillsDir = path.join(tmp, 'github-skills');
    fs.mkdirSync(ghSkillsDir, { recursive: true });
    fs.writeFileSync(path.join(ghSkillsDir, 'SKILL.md'), 'stale');

    const result = removeStaleGithubSkills({ dryOrCheck: false }, { ghSkillsDir });

    assert.equal(result, 1);
    assert.equal(fs.existsSync(ghSkillsDir), false, 'the tree is actually gone');
  });

  it('round-1 audit M3 — a real removal failure throws before any copy step could run', () => {
    const ghSkillsDir = path.join(tmp, 'github-skills');
    fs.mkdirSync(ghSkillsDir, { recursive: true });

    assert.throws(
      () => removeStaleGithubSkills({ dryOrCheck: false }, {
        ghSkillsDir,
        rmSyncFn: () => { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; },
      }),
      (err) => {
        assert.equal(err.code, 'GITHUB_SKILLS_REMOVAL_FAILED');
        assert.match(err.message, /failed to remove deprecated/);
        assert.match(err.message, /EBUSY/);
        return true;
      },
    );
    // The directory is untouched by the failed attempt — no half-deleted state.
    assert.equal(fs.existsSync(ghSkillsDir), true);
  });

  it('audit-code round-1 H4/M4/H8 — an unreadable (not absent) directory throws, never silently treated as clean', () => {
    // The real bug this guards: the original inspection gate was
    // `!fs.existsSync(ghSkillsDir)`, and existsSync converts EVERY stat
    // failure (not just "doesn't exist") into false — identical to a
    // genuinely-absent path. An lstatFn that throws EACCES must be treated
    // as a real error, never as "nothing here."
    const ghSkillsDir = path.join(tmp, 'github-skills');
    // Deliberately do NOT create ghSkillsDir on real disk — the injected
    // lstatFn is what determines the outcome here, and a genuinely-absent
    // real path must not accidentally satisfy the test.

    assert.throws(
      () => removeStaleGithubSkills({ dryOrCheck: false }, {
        ghSkillsDir,
        lstatFn: () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; },
        rmSyncFn: () => { throw new Error('must never be called — the lstat failure must halt first'); },
      }),
      (err) => {
        assert.equal(err.code, 'GITHUB_SKILLS_REMOVAL_FAILED');
        assert.match(err.message, /cannot inspect deprecated/);
        assert.match(err.message, /EACCES/);
        return true;
      },
    );
  });

  it('a genuinely-absent directory (ENOENT from lstat) is still a clean no-op', () => {
    const ghSkillsDir = path.join(tmp, 'github-skills-does-not-exist');
    const result = removeStaleGithubSkills({ dryOrCheck: false }, {
      ghSkillsDir,
      rmSyncFn: () => { throw new Error('must never be called for a missing directory'); },
    });
    assert.equal(result, 0);
  });

  it('main() validates the source (loadSkillsOrDie + validateAllSkillsOrDie) BEFORE removeStaleGithubSkills (Gemini gate shadow #1, fixed)', () => {
    // Same source-pattern convention tests/install-surface-scope.test.mjs already
    // uses for this exact class of "prove the ordering, not just the existence"
    // concern — main() itself isn't exported (it OVERWRITES the real tree and
    // calls process.exit), so this pins the contract structurally.
    //
    // The real bug this guards: removeStaleGithubSkills used to run FIRST,
    // so a missing/empty skills/ tree or a single skill with a disallowed
    // file was discovered only AFTER the deprecated .github/skills/ tree had
    // already been permanently deleted — destroying it while writing
    // nothing. Both source-validation calls must now precede it.
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'regenerate-skill-copies.mjs'), 'utf8');
    const mainBody = /function main\(\) \{([\s\S]*?)\n\}/.exec(src)[1];
    const loadIdx = mainBody.indexOf('loadSkillsOrDie()');
    const validateIdx = mainBody.indexOf('validateAllSkillsOrDie(skills)');
    const removeIdx = mainBody.indexOf('removeStaleGithubSkills(opts)');
    assert.ok(loadIdx >= 0 && validateIdx >= 0 && removeIdx >= 0, 'all three calls must be present in main()');
    assert.ok(loadIdx < removeIdx, 'loadSkillsOrDie must run before removeStaleGithubSkills — validate the source exists before destroying anything');
    assert.ok(validateIdx < removeIdx, 'validateAllSkillsOrDie must run before removeStaleGithubSkills — validate every skill\'s allowlist before destroying anything');
  });

  it('validateAllSkillsOrDie exits 2 naming every violating skill, without ever calling removeStaleGithubSkills\'s rmSync path', () => {
    // enumerateSkillFiles is read-only, so this is directly testable —
    // no need to spawn a child process for this specific contract.
    const skillsDir = path.join(tmp, 'skills');
    fs.mkdirSync(path.join(skillsDir, 'bad-skill'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'bad-skill', 'not-allowed.exe'), 'x');

    const originalExit = process.exit;
    const originalWrite = process.stderr.write;
    let exitCode, stderrOutput = '';
    process.exit = (code) => { exitCode = code; throw new Error('__exit__'); };
    process.stderr.write = (s) => { stderrOutput += s; return true; };
    try {
      assert.throws(() => _internals.validateAllSkillsOrDie(['bad-skill'], skillsDir), /__exit__/);
    } finally {
      process.exit = originalExit;
      process.stderr.write = originalWrite;
    }
    assert.equal(exitCode, 2);
    assert.match(stderrOutput, /bad-skill/);
  });
});

describe('regenerate-skill-copies.mjs CLI — --keep-github-skills is rejected, not silently ignored', () => {
  it('exits 2 with a diagnostic naming the unknown flag', async () => {
    await assert.rejects(
      execFileAsync(process.execPath, [CLI, '--dry-run', '--keep-github-skills'], { cwd: REPO_ROOT }),
      (err) => {
        assert.equal(err.code, 2);
        assert.match(err.stderr, /unknown flag "--keep-github-skills"/);
        return true;
      },
    );
  });
});
