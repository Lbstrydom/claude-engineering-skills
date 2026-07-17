/**
 * @fileoverview The gate's invoker must itself be installed.
 *
 * `npm run check` is this repo's ONLY gate — no workflow runs it on push or PR
 * (`npm test` runs solely in release.yml, on a version tag; migration-drift.yml
 * fires on push but only runs `setup-postgres --check-drift`). Until 2026-07-17
 * `check` was invoked exclusively by an UNTRACKED `.git/hooks/pre-push` that
 * nothing installed, so a fresh clone had zero gates while AGENTS.md cited "the
 * pre-push hook" six times as established. That is the same defect the gates
 * catch — a check that exists and is never invoked — one level up.
 *
 * These pin the wiring AND the two ways a tracked hook silently fails to run:
 * a non-executable mode, and CRLF line endings (`/bin/bash^M: bad interpreter`).
 * Both are easy to ship from Windows, where git neither tracks the exec bit by
 * default nor keeps LF in the working tree.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = process.cwd();
const HOOKS = ['pre-push', 'post-checkout', 'post-merge'];
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8'));

const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf-8' }).trim();

describe('the hooks are tracked and auto-wired', () => {
  it('every active hook has a tracked source in .githooks/', () => {
    for (const h of HOOKS) {
      assert.ok(
        fs.existsSync(path.join(REPO, '.githooks', h)),
        `.githooks/${h} missing — core.hooksPath supersedes .git/hooks/ wholesale, so an untracked hook simply stops running`,
      );
    }
  });

  it('`prepare` wires core.hooksPath, so a fresh clone is gated on first npm install', () => {
    assert.match(
      pkg.scripts.prepare || '',
      /install-git-hooks\.mjs/,
      'without a prepare lifecycle the hook install is a documented-but-manual step — which is precisely what did not happen',
    );
  });

  it('pre-push actually runs the gate (not merely present)', () => {
    const body = fs.readFileSync(path.join(REPO, '.githooks', 'pre-push'), 'utf-8');
    assert.match(body, /npm run check/, 'the pre-push hook must invoke the check chain');
  });
});

describe('a tracked hook must be able to RUN on a POSIX clone', () => {
  it('is committed executable (mode 100755)', () => {
    // `git add` from Windows defaults to 100644; a 100644 hook is silently
    // ignored by git on Linux/macOS — it fails open, with no error.
    const out = git(['ls-files', '-s', '--', '.githooks']);
    assert.ok(out, '.githooks must be tracked');
    for (const line of out.split('\n')) {
      const [mode, , , file] = line.split(/\s+/);
      assert.equal(mode, '100755', `${file} is ${mode} — a non-executable hook never runs on POSIX`);
    }
  });

  it('is committed with LF endings and an intact shebang', () => {
    // A CRLF hook dies with `/bin/bash^M: bad interpreter`. .gitattributes pins
    // `* text=auto eol=lf`; this asserts the RESULT rather than trusting it.
    for (const h of HOOKS) {
      const buf = execFileSync('git', ['show', `:.githooks/${h}`], { cwd: REPO, maxBuffer: 1e7 });
      assert.equal(
        buf.filter(b => b === 0x0d).length, 0,
        `.githooks/${h} has CR bytes in the index — POSIX clones get "bad interpreter"`,
      );
      assert.match(buf.toString('utf-8').split('\n')[0], /^#!\/bin\/(ba)?sh$/, `${h} needs a valid shebang`);
    }
  });
});
