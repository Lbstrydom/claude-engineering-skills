#!/usr/bin/env node
/**
 * @fileoverview Point git at this repo's TRACKED hooks (`.githooks/`).
 *
 * Runs from the `prepare` npm lifecycle, so a fresh clone gets the gates on its
 * first `npm install` — no documented-but-manual step, which is exactly what
 * failed before.
 *
 * WHY THIS EXISTS. `npm run check` (context + docs + skills + plans + parity +
 * the full suite) is this repo's ONLY gate: no workflow runs it on push or PR
 * (`npm test` runs solely in release.yml on a version tag). Until 2026-07-17 it
 * was invoked exclusively by an UNTRACKED `.git/hooks/pre-push` that nothing
 * installed — not `package.json`, not any script, and there was no tracked copy
 * to install from. A fresh clone therefore had zero gates while AGENTS.md cited
 * "the pre-push hook" six times as an established mechanism. That is the same
 * defect the hooks themselves guard against — a check that exists and is never
 * invoked — sitting one level above the checks.
 *
 * NOT `install-prepush-hook.mjs`: that installs a DIFFERENT hook (an
 * `/audit-code`-on-draft-plans hook) into CONSUMER repos. This is the source
 * repo's own gate.
 *
 * Mechanism: `core.hooksPath` rather than copying into `.git/hooks/`. A copy
 * silently rots the moment the tracked source changes; a pointer cannot. The
 * trade-off is that `core.hooksPath` supersedes `.git/hooks/` wholesale — which
 * is why all three active hooks are tracked, not just pre-push.
 *
 * Safe to run anywhere: a no-op outside a git worktree (npm pack/CI without
 * .git), and it never fails an install — a hook that cannot be wired is a
 * warning, not a broken `npm install`.
 *
 * @module scripts/install-git-hooks
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR = '.githooks';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function main() {
  // A tarball install / CI checkout without .git has nothing to wire.
  try {
    if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') return;
  } catch {
    return; // git absent, or not a repo — silently skip.
  }

  if (!fs.existsSync(path.join(REPO_ROOT, HOOKS_DIR))) {
    process.stderr.write(`[hooks] ${HOOKS_DIR}/ missing — skipping (nothing to point at)\n`);
    return;
  }

  let current = null;
  try { current = git(['config', '--local', '--get', 'core.hooksPath']); } catch { /* unset */ }
  if (current === HOOKS_DIR) return; // Idempotent: already wired, stay quiet.

  try {
    git(['config', '--local', 'core.hooksPath', HOOKS_DIR]);
    process.stderr.write(`[hooks] core.hooksPath -> ${HOOKS_DIR} (pre-push now runs 'npm run check')\n`);
  } catch (err) {
    // Never fail the install over this.
    process.stderr.write(`[hooks] could not set core.hooksPath: ${err.message}\n`);
  }
}

main();
