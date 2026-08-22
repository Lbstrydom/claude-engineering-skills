/**
 * @fileoverview `buildDoctorContext` — the SINGLE place bundleRoot/subjectRoot
 * are resolved (consumer-friction-doctor plan §2.3a, closes R1-H1).
 *
 * The load-bearing property under test: `bundleRoot` (where the doctor's own
 * code lives) and `subjectRoot` (the repo being diagnosed) are independently
 * resolved and MUST be allowed to differ — the `install.mjs doctor <target>`
 * bootstrap depends on exactly that divergence.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { execFileSync } from 'node:child_process';
import { buildDoctorContext } from '../scripts/lib/doctor/context.mjs';

let gitDir, nonGitDir, brokenGitDir, worktreeDir, nestedSubDir;

before(() => {
  gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-ctx-git-'));
  execFileSync('git', ['init', '-q'], { cwd: gitDir });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: gitDir });
  execFileSync('git', ['config', 'user.name', 'a'], { cwd: gitDir });
  fs.writeFileSync(path.join(gitDir, 'f.txt'), 'x');
  execFileSync('git', ['add', '.'], { cwd: gitDir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: gitDir });

  nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-ctx-nongit-'));

  // A BARE `.git` directory (no HEAD/config/objects) — round-1 audit H6's
  // sustained point: `fs.existsSync` alone treats this as "has .git" and
  // accepted it; it is not a usable working tree at all.
  brokenGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-ctx-broken-'));
  fs.mkdirSync(path.join(brokenGitDir, '.git'));

  // A linked WORKTREE — its `.git` is a FILE (not a directory), which is
  // the case the original rebuttal defended and GPT conceded. Proves the
  // stricter `git rev-parse` check still accepts this legitimate shape.
  worktreeDir = path.join(gitDir, '..', 'doctor-ctx-worktree-' + path.basename(gitDir));
  execFileSync('git', ['worktree', 'add', worktreeDir, '-b', 'doctor-ctx-wt-branch'], { cwd: gitDir });

  // A NESTED subdirectory of gitDir — `--is-inside-work-tree` alone reports
  // `true` here too (round-3 audit M6), so subjectRoot must normalise to
  // gitDir's own top-level, not this subdirectory.
  nestedSubDir = path.join(gitDir, 'src', 'nested');
  fs.mkdirSync(nestedSubDir, { recursive: true });
});

after(() => {
  try { execFileSync('git', ['worktree', 'remove', '--force', worktreeDir], { cwd: gitDir }); } catch { /* best-effort */ }
  fs.rmSync(gitDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  fs.rmSync(nonGitDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  fs.rmSync(brokenGitDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  fs.rmSync(worktreeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('buildDoctorContext', () => {
  it('with no --consumer-root, subjectRoot === bundleRoot (the common case)', () => {
    const ctx = buildDoctorContext(['node', 'doctor.mjs']);
    assert.equal(ctx.subjectRoot, ctx.bundleRoot);
    assert.ok(ctx.bundleRoot.length > 0);
  });

  it('with --consumer-root pointing at a real git repo, subjectRoot != bundleRoot', () => {
    const ctx = buildDoctorContext(['node', 'doctor.mjs', '--consumer-root', gitDir]);
    assert.notEqual(ctx.subjectRoot, ctx.bundleRoot);
    assert.equal(fs.realpathSync(ctx.subjectRoot), fs.realpathSync(gitDir));
  });

  it('accepts the --consumer-root=<path> form', () => {
    const ctx = buildDoctorContext(['node', 'doctor.mjs', `--consumer-root=${gitDir}`]);
    assert.equal(fs.realpathSync(ctx.subjectRoot), fs.realpathSync(gitDir));
  });

  it('throws on a --consumer-root with no .git — never a silent fallback to bundleRoot', () => {
    assert.throws(
      () => buildDoctorContext(['node', 'doctor.mjs', '--consumer-root', nonGitDir]),
      /not a usable git working tree/,
    );
  });

  it('throws on a BARE .git directory (round-1 audit H6) — existence alone is not a usable working tree', () => {
    assert.throws(
      () => buildDoctorContext(['node', 'doctor.mjs', '--consumer-root', brokenGitDir]),
      /not a usable git working tree/,
    );
  });

  it('accepts a linked WORKTREE, whose .git is a FILE — the case H6\'s rebuttal defended and GPT conceded', () => {
    const ctx = buildDoctorContext(['node', 'doctor.mjs', '--consumer-root', worktreeDir]);
    assert.equal(fs.realpathSync(ctx.subjectRoot), fs.realpathSync(worktreeDir));
  });

  it('normalises a NESTED subdirectory of a repo to the repo\'s own top-level (round-3 audit M6)', () => {
    const ctx = buildDoctorContext(['node', 'doctor.mjs', '--consumer-root', nestedSubDir]);
    assert.equal(fs.realpathSync(ctx.subjectRoot), fs.realpathSync(gitDir));
    assert.notEqual(fs.realpathSync(ctx.subjectRoot), fs.realpathSync(nestedSubDir));
  });

  it('throws on a --consumer-root that does not exist', () => {
    assert.throws(
      () => buildDoctorContext(['node', 'doctor.mjs', '--consumer-root', path.join(os.tmpdir(), 'does-not-exist-xyz')]),
      /does not exist/,
    );
  });

  it('throws when --consumer-root is the LAST argv token (present, no value) — never silently falls back to bundleRoot', () => {
    // Round-1 audit H10: this used to return null (indistinguishable from
    // "flag absent") and silently diagnose bundleRoot instead.
    assert.throws(
      () => buildDoctorContext(['node', 'doctor.mjs', '--consumer-root']),
      /no usable value/,
    );
  });

  it('throws rather than swallowing a FOLLOWING flag as --consumer-root\'s value', () => {
    // Round-1 audit H6: `--consumer-root --gate` used to consume "--gate" as
    // the path, so --gate itself silently never activated.
    assert.throws(
      () => buildDoctorContext(['node', 'doctor.mjs', '--consumer-root', '--gate']),
      /no usable value/,
    );
  });

  it('is driven by the EXPLICIT argv parameter, not real process.argv', () => {
    // Pollute the real process.argv with a flag this call never passes — if
    // buildDoctorContext secretly reads process.argv instead of its parameter,
    // this would throw (no such directory) instead of returning cleanly.
    const saved = process.argv;
    process.argv = [...saved, '--consumer-root', '/nonexistent/should/be/ignored'];
    try {
      const ctx = buildDoctorContext(['node', 'doctor.mjs']);
      assert.equal(ctx.subjectRoot, ctx.bundleRoot);
    } finally {
      process.argv = saved;
    }
  });
});
