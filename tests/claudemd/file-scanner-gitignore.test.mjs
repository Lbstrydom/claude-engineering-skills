/**
 * @fileoverview `scanInstructionFiles` must not judge files the repo does not own.
 *
 * THE DEFECT THIS LOCKS (upstream 5b67666e, filed from a consumer 2026-08-04).
 * The scanner walked with a hardcoded exclusion set and never consulted git, so
 * a consumer that vendored third-party skills got
 * `.agents/skills/<vendor>/CLAUDE.md` — body: the literal string "AGENTS.md",
 * gitignored, not part of that repo's context topology — scanned and raised as
 * `[HIGH] ctx/missing-import`. `context:check --strict` exited 1 on a repo whose
 * real topology was clean, and there was no supported way to scope it out: no
 * CLI flag for `additionalExcludes`, no `excludes` key in the allowlist schema,
 * and `.gitignore` unread. A gate that is red on arrival for a reason the
 * operator cannot fix stops being read.
 *
 * The predicate is IGNORED **AND UNTRACKED** — the second half is load-bearing
 * and has its own test below. `git check-ignore` reports a TRACKED file as
 * ignored whenever a pattern matches, so filtering on ignore-status alone would
 * silently stop judging a committed instruction file that matches one.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { scanInstructionFiles } from '../../scripts/lib/claudemd/file-scanner.mjs';

let repo;
const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf-8', windowsHide: true });
const write = (rel, body) => {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-gi-'));
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

describe('scanInstructionFiles — files the repo does not own', () => {
  it('skips a vendored, gitignored instruction file (the reported case)', () => {
    write('CLAUDE.md', '# thin addendum\n@./AGENTS.md\n');
    write('AGENTS.md', '# canonical\n');
    write('.gitignore', '.agents/skills/\n');
    write('.agents/skills/supabase-postgres-best-practices/CLAUDE.md', 'AGENTS.md');
    git('add', 'CLAUDE.md', 'AGENTS.md', '.gitignore');
    git('commit', '-qm', 'init');

    const found = scanInstructionFiles(repo).files.map((f) => f.path);
    assert.ok(found.includes('CLAUDE.md'), 'the repo\'s own CLAUDE.md must still be scanned');
    assert.ok(
      !found.some((p) => p.startsWith('.agents/')),
      `vendored gitignored file must not be judged; got ${JSON.stringify(found)}`,
    );
  });

  it('STILL judges a tracked file that matches an ignore pattern', () => {
    // The ignored-AND-untracked half. A repo may track a file whose path also
    // matches .gitignore; it is committed, so the repo owns it and it counts.
    write('.gitignore', 'vendored-docs/\n');
    write('vendored-docs/CLAUDE.md', '# tracked despite the pattern\n');
    git('add', '-f', '.gitignore', 'vendored-docs/CLAUDE.md');
    git('commit', '-qm', 'init');

    const found = scanInstructionFiles(repo).files.map((f) => f.path);
    assert.ok(
      found.includes('vendored-docs/CLAUDE.md'),
      `a TRACKED file must be judged even under an ignore pattern; got ${JSON.stringify(found)}`,
    );
  });

  it('degrades to the raw walk outside a git work tree rather than throwing', () => {
    // No `git init` here — the scanner must not depend on git being usable.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-nogit-'));
    try {
      fs.writeFileSync(path.join(bare, 'CLAUDE.md'), '# x\n');
      const found = scanInstructionFiles(bare).files.map((f) => f.path);
      assert.deepEqual(found, ['CLAUDE.md']);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('still skips the vendored file when the repo has a LARGE ignored universe', () => {
    // THE RECURRENCE THIS LOCKS (reported from a consumer 2026-08-10). Every
    // test above passes in a fixture with a handful of ignored files, and that
    // is exactly why the defect survived: the old implementation answered this
    // question by enumerating the repo's ENTIRE ignored-and-untracked set, so
    // one `node_modules` pushed the output past spawnSync's 1 MiB default
    // maxBuffer. ENOBUFS arrived as `r.error`, the guard returned the empty
    // set, and the ownership filter was silently OFF — 28,193 such paths in the
    // source repo, 49,768 in the reporting consumer, meaning the "fixed" gate
    // had never once worked in a repo with dependencies installed.
    write('CLAUDE.md', '# thin addendum\n@./AGENTS.md\n');
    write('AGENTS.md', '# canonical\n');
    write('.gitignore', '.agents/skills/\nbulk/\n');
    write('.agents/skills/supabase-postgres-best-practices/CLAUDE.md', 'AGENTS.md');
    git('add', 'CLAUDE.md', 'AGENTS.md', '.gitignore');
    git('commit', '-qm', 'init');

    const bulk = path.join(repo, 'bulk', 'd'.repeat(60));
    fs.mkdirSync(bulk, { recursive: true });
    for (let i = 0; i < 6000; i++) {
      fs.writeFileSync(path.join(bulk, `f${i}`.padEnd(120, 'x') + '.js'), '');
    }

    // PRECONDITION — without this the test is vacuous, passing on a fixture too
    // small to reach the failure. Assert the old whole-repo query really does
    // blow its buffer here, so this fixture is known to exercise the defect.
    const whole = spawnSync('git', ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'], {
      cwd: repo, encoding: 'utf-8', windowsHide: true,
    });
    assert.equal(
      whole.error?.code, 'ENOBUFS',
      'fixture is too small to reproduce the defect — the whole-repo query must overflow maxBuffer here',
    );

    const found = scanInstructionFiles(repo).files.map((f) => f.path);
    assert.ok(found.includes('CLAUDE.md'), 'the repo\'s own CLAUDE.md must still be scanned');
    assert.ok(
      !found.some((p) => p.startsWith('.agents/')),
      `ownership filter must survive a large ignored universe; got ${JSON.stringify(found)}`,
    );
  });

  it('respectGitignore:false restores the raw walk (explicit opt-out)', () => {
    write('.gitignore', '.agents/skills/\n');
    write('.agents/skills/v/CLAUDE.md', 'AGENTS.md');
    git('add', '.gitignore');
    git('commit', '-qm', 'init');

    const found = scanInstructionFiles(repo, { respectGitignore: false }).files.map((f) => f.path);
    assert.ok(found.some((p) => p.startsWith('.agents/')), 'opt-out must scan the disowned file again');
  });
});
