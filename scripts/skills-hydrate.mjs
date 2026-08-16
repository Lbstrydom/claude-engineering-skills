#!/usr/bin/env node
/**
 * @fileoverview Hydrate a linked git worktree with the synced tooling tree.
 *
 * **Why this exists.** Sixteen SKILL.md files carry a worktree-preflight marker
 * telling the reader to run `npm run skills:hydrate` first — the marker's
 * presence is enforced by `check-worktree-preflight.mjs`. That gate proved the
 * marker was THERE; nothing proved the command it names could RUN, and in this
 * repo it could not: no such npm script existed, so following the instruction
 * produced `npm error Missing script: "skills:hydrate"` (found 2026-08-14 while
 * running `/ship` from a worktree). That is precisely the class the gate was
 * built to stop — *the instruction ships and the tool does not* — reappearing
 * one level up, in the remedy rather than the subject.
 *
 * **What it does.** `scripts/.claude-skills/` is gitignored in a consumer, and
 * `git worktree add` never populates ignored paths, so the tree is present in
 * the main checkout and absent in every linked worktree. This copies it across.
 * Contract and rationale: `docs/runbooks/consumer-adoption.md` §"Linked git
 * worktrees" → Remedy 1, whose behaviour this reproduces exactly:
 *
 *   - main checkout            → no-op that SAYS so (never re-syncs, so it can
 *                                never mask a stale bundle as a fresh one)
 *   - worktree, tooling absent → exit 1 naming the path, rather than leaving a
 *                                half-populated tree
 *   - worktree, tooling present→ copy, and say what was copied
 *
 * **The source repo is a fourth case, and it is why this is a script rather
 * than the runbook's package.json one-liner.** That one-liner is consumer-
 * shaped: it exits 1 when `scripts/.claude-skills/` is missing. In
 * claude-engineering-skills the tooling is TRACKED at `scripts/` and that
 * directory correctly never exists — so the consumer script would fail here on
 * a repo that has nothing to hydrate and needs nothing hydrated. Detected the
 * same way every other source-repo gate in this bundle detects it
 * (`package.json.name`), and reported as a clean no-op.
 *
 * It copies, so it goes stale: re-run it in each worktree after a re-sync.
 *
 * Usage:
 *   node scripts/skills-hydrate.mjs           # hydrate (or explain why not)
 *   node scripts/skills-hydrate.mjs --json    # machine-readable result
 *
 * Exit codes:
 *   0  hydrated, or a legitimate no-op (main checkout / source repo)
 *   1  a worktree that needs tooling the main checkout does not have
 *   2  usage error
 *
 * @module scripts/skills-hydrate
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';

const KNOWN_FLAGS = ['--json'];
/** The one directory this hydrates — the synced consumer tooling tree. */
export const SYNCED_TOOLING_DIR = 'scripts/.claude-skills';
/** This bundle's own package name; here the tooling is tracked, not synced. */
const SOURCE_REPO_NAME = 'claude-engineering-skills';

/**
 * Resolve the main working tree from the git COMMON dir. In a linked worktree
 * `--git-dir` points at `.git/worktrees/<name>` while `--git-common-dir` points
 * at the main `.git`, so its parent is the main checkout.
 *
 * Assumes the common dir's parent IS the main checkout — true for a normal
 * repo, wrong for a bare-repo-plus-worktrees layout (named in the runbook as a
 * known limit rather than silently handled).
 *
 * @param {(cmd: string, args: string[]) => string} run
 * @returns {string|null} absolute path, or null when git cannot answer
 */
export function resolveMainWorktree(run) {
  try {
    const common = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    // `path.resolve` canonicalises separators: git answers with forward slashes
    // on Windows while `path.resolve` elsewhere yields backslashes, and an
    // un-normalised return would hand callers two spellings of one directory.
    return common ? path.resolve(path.dirname(common)) : null;
  } catch {
    return null;
  }
}

/**
 * PURE decision function — what should hydration do, given the facts? Split out
 * so every branch is unit-testable without a real worktree, a real git, or a
 * real filesystem copy.
 *
 * @param {object} facts
 * @param {string} facts.cwd - the tree we are being run in
 * @param {string|null} facts.mainWorktree - resolved main checkout, or null
 * @param {string|null} facts.packageName - `package.json.name` of the cwd repo
 * @param {boolean} facts.sourceExists - does the tooling tree exist in main?
 * @returns {{action:'copy'|'noop'|'fail', code:string, message:string, from?:string, to?:string}}
 */
export function planHydration({ cwd, mainWorktree, packageName, sourceExists }) {
  if (packageName === SOURCE_REPO_NAME) {
    return {
      action: 'noop',
      code: 'source-repo',
      message: `[hydrate] ${SOURCE_REPO_NAME}: tooling is tracked at scripts/ — nothing to hydrate`,
    };
  }
  if (!mainWorktree) {
    return {
      action: 'fail',
      code: 'no-git',
      message: '[hydrate] could not resolve the main worktree (is this a git repo?)',
    };
  }
  const dest = path.resolve(cwd, SYNCED_TOOLING_DIR);
  const src = path.resolve(mainWorktree, SYNCED_TOOLING_DIR);
  if (src === dest) {
    return {
      action: 'noop',
      code: 'main-checkout',
      message: '[hydrate] main checkout — nothing to do',
    };
  }
  if (!sourceExists) {
    return {
      action: 'fail',
      code: 'no-tooling-in-main',
      message: `[hydrate] no tooling at ${src} — re-sync the main checkout first`,
      from: src,
      to: dest,
    };
  }
  return { action: 'copy', code: 'hydrated', message: `[hydrate] copied ${src}`, from: src, to: dest };
}

function readPackageName(cwd) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8')).name ?? null;
  } catch {
    return null;
  }
}

function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'skills-hydrate' });
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    throw err;
  }
  const asJson = process.argv.includes('--json');
  const cwd = process.cwd();
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', cwd });
  const mainWorktree = resolveMainWorktree(run);
  const src = mainWorktree ? path.resolve(mainWorktree, SYNCED_TOOLING_DIR) : null;

  const plan = planHydration({
    cwd,
    mainWorktree,
    packageName: readPackageName(cwd),
    sourceExists: src ? fs.existsSync(src) : false,
  });

  if (plan.action === 'copy') {
    fs.cpSync(plan.from, plan.to, { recursive: true });
  }
  if (asJson) {
    console.log(JSON.stringify({ ok: plan.action !== 'fail', ...plan }));
  } else {
    (plan.action === 'fail' ? process.stderr : process.stdout).write(`${plan.message}\n`);
  }
  process.exit(plan.action === 'fail' ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('skills-hydrate.mjs')) {
  main();
}
