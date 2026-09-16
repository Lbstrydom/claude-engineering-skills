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
 *   node scripts/skills-hydrate.mjs                    # hydrate (or explain why not)
 *   node scripts/skills-hydrate.mjs --from <repo-path>  # hydrate from a named checkout
 *   node scripts/skills-hydrate.mjs --json             # machine-readable result
 *
 * `--from` (or `SKILLS_SOURCE`) exists because the git-derived source is
 * undefined in a plain clone: `actions/checkout` produces a checkout whose git
 * common dir is itself, so it resolves as its own main checkout and there is
 * nowhere to copy from. See the `no-tooling-here` branch below — in CI the
 * right answer is usually to INSTALL the bundle rather than to hydrate, and the
 * message names that command in the reader's OWN package-manager dialect
 * (`displayDlx`), never a hardcoded `npx` a corepack-managed pnpm image may
 * not have.
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
import { detectPackageManager, displayDlx } from './lib/package-manager.mjs';

const KNOWN_FLAGS = ['--json', '--from'];
/**
 * Env fallback for `--from`, so a CI step can set the source once rather than
 * threading a flag through every invocation.
 */
export const SOURCE_ENV_VAR = 'SKILLS_SOURCE';
/** The one directory this hydrates — the synced consumer tooling tree. */
export const SYNCED_TOOLING_DIR = 'scripts/.claude-skills';
/**
 * The tooling tree's STAMP, and the second thing hydration must carry.
 *
 * `scripts/.sync-manifest.json` is a SIBLING of the tooling directory,
 * gitignored by the same rule that makes hydration necessary in the first
 * place — so a hydrator that thinks in terms of "the tooling tree" copies the
 * code and leaves the provenance behind. Every hydrated worktree then ran with
 * `readBundleStamp` returning null: upstream reports filed as
 * "version unknown (no-stamp)", `lib/doctor/probes.mjs` unable to run its
 * orphan or staleness probe, and `check-audit-tool-version` /
 * `npm-script-enumerator` / `remove-legacy-synced` blind with it. Reported by
 * a consumer 2026-09-07 (upstream 5bc7ff30) whose own hand-rolled hydrator had
 * made the identical omission independently — the split is easy to miss, not
 * something one consumer got wrong.
 *
 * Deliberately a local literal rather than an import of
 * `lib/sync-manifest.mjs`'s `MANIFEST_RELATIVE_PATH`: this script must run in a
 * freshly-added worktree, which is exactly the tree that may not have
 * `node_modules` yet, and that module pulls in `zod`. Hydration crashing on a
 * missing dependency would break the one command that has to work first.
 * Agreement is enforced instead by `tests/skills-hydrate.test.mjs`, which
 * imports both and compares them — N copies stay legal, disagreement does not.
 */
export const SYNCED_MANIFEST_PATH = 'scripts/.sync-manifest.json';
/** This bundle's own package name; here the tooling is tracked, not synced. */
const SOURCE_REPO_NAME = 'claude-engineering-skills';
/** The argv `displayDlx` renders, and the npm-dialect fallback for a pure caller. */
export const INSTALL_ARGV = Object.freeze(['github:Lbstrydom/claude-engineering-skills', '.']);
export const DEFAULT_INSTALL_COMMAND = `npx ${INSTALL_ARGV.join(' ')}`;

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
 * @param {boolean} [facts.manifestExists] - does the sync manifest exist in main?
 * @returns {{action:'copy'|'noop'|'fail', code:string, message:string, from?:string, to?:string,
 *   items?: Array<{rel:string, from:string, to:string, present:boolean, recursive:boolean}>}}
 */
export function planHydration({
  cwd, mainWorktree, packageName, sourceExists, manifestExists = false,
  explicitSource = null, installCommand = null,
}) {
  // The remedy must be spelled in the reader's OWN package manager. It was
  // hardcoded to `npx`, and the consumer it was written for runs pnpm (audit
  // R1 H3, 2026-09-04). Injected rather than probed so this function stays
  // pure and every branch remains testable without a real repo.
  const install = installCommand ?? DEFAULT_INSTALL_COMMAND;
  if (packageName === SOURCE_REPO_NAME) {
    return {
      action: 'noop',
      code: 'source-repo',
      message: `[hydrate] ${SOURCE_REPO_NAME}: tooling is tracked at scripts/ — nothing to hydrate`,
    };
  }
  // An explicit source overrides git entirely — it is the answer to "hydrate
  // somewhere git cannot infer a source from", which is every plain clone.
  const base = explicitSource ?? mainWorktree;
  if (!base) {
    return {
      action: 'fail',
      code: 'no-git',
      message: `[hydrate] could not resolve the main worktree (is this a git repo?) — pass --from <path> or set ${SOURCE_ENV_VAR} to name the tooling source explicitly`,
    };
  }
  const dest = path.resolve(cwd, SYNCED_TOOLING_DIR);
  // `--from` names the REPO holding the tooling, the same shape as the resolved
  // main worktree, so the tooling subdirectory is appended either way.
  const src = path.resolve(base, SYNCED_TOOLING_DIR);
  if (src === dest) {
    // A plain clone — which is exactly what `actions/checkout` produces — has
    // its git common dir INSIDE itself, so it resolves as its own main
    // checkout. When the tooling is present that is a true no-op. When it is
    // absent, "nothing to do" is a false green: the caller asked to be
    // hydrated, is not, and the next `arch:*` step dies on a bare
    // MODULE_NOT_FOUND with nothing connecting it to this command. Reported by
    // a consumer 2026-09-04, who could only make CI run by welding the job to a
    // runner-local checkout.
    if (!sourceExists) {
      return {
        action: 'fail',
        code: 'no-tooling-here',
        message: `[hydrate] nothing to hydrate FROM: ${src} does not exist, and this tree is its own main checkout `
          + '(a plain clone, e.g. actions/checkout). `skills:hydrate` copies tooling BETWEEN worktrees of one '
          + 'checkout; it cannot fetch it. In CI, install the bundle instead: '
          + `\`${install}\` — or point this at a checkout that has it with `
          + `--from <path> / ${SOURCE_ENV_VAR}.`,
        from: src,
        to: dest,
      };
    }
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
  // Two items, not one. `from`/`to` stay pointed at the tooling tree for every
  // existing caller; `items` is what the copier and the reporter iterate, so a
  // third asset later is one array entry rather than a second code path.
  const items = [
    { rel: SYNCED_TOOLING_DIR, from: src, to: dest, present: true, recursive: true },
    {
      rel: SYNCED_MANIFEST_PATH,
      from: path.resolve(base, SYNCED_MANIFEST_PATH),
      to: path.resolve(cwd, SYNCED_MANIFEST_PATH),
      present: manifestExists,
      recursive: false,
    },
  ];
  const copied = items.filter((i) => i.present);
  // PARTIAL hydration must be visible on the line an operator actually reads.
  // The old single-item report said "copied <path>" and exited 0 with the stamp
  // silently absent; the nulls only showed up in --json, beside an `ok: true`.
  const message = copied.length === items.length
    ? `[hydrate] copied ${copied.length}/${items.length} items from ${base}: ${items.map((i) => i.rel).join(', ')}`
    : `[hydrate] copied ${copied.length}/${items.length} items from ${base}: ${copied.map((i) => i.rel).join(', ')} `
      + `— but NOT ${items.filter((i) => !i.present).map((i) => i.rel).join(', ')} (absent there). `
      + 'This tree has NO bundle stamp: upstream reports file as "version unknown", and the doctor cannot run its '
      + 'orphan or staleness probe. Re-sync the main checkout to produce the manifest.';
  return { action: 'copy', code: 'hydrated', message, from: src, to: dest, items };
}

/**
 * Delete anything in `dest` that no longer exists in `src`. `fs.cpSync` is a
 * pure overlay — it adds and updates, but never removes, so a file deleted
 * or renamed in the source tree survives in every already-hydrated worktree
 * indefinitely: hydration overlays onto the EXISTING (possibly stale) mirror
 * rather than converging it to an exact snapshot (topicIds 7949a7c28e1c,
 * a1b7f50d0277, d19c7f929169, f19a74763f93). Call AFTER `fs.cpSync` has
 * already added/updated everything current, so nothing is deleted-then-
 * missed by a copy that hasn't run yet.
 *
 * Walks `dest`, not `src` — that is the only tree that can show what no
 * longer belongs there. A directory is removed once it is either absent
 * from `src` or left empty after its own contents were pruned.
 *
 * @param {string} src absolute source directory (the tree of record)
 * @param {string} dest absolute destination directory (the mirror)
 * @returns {string[]} paths removed, relative to `dest`
 */
export function pruneStale(src, dest) {
  const removed = [];
  if (!fs.existsSync(dest)) return removed;
  const rm = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  const walk = (relDir) => {
    const destDir = path.join(dest, relDir);
    for (const entry of fs.readdirSync(destDir, { withFileTypes: true })) {
      const rel = path.join(relDir, entry.name);
      const srcPath = path.join(src, rel);
      const destPath = path.join(dest, rel);
      if (entry.isDirectory()) {
        if (!fs.existsSync(srcPath)) {
          rm(destPath);
          removed.push(rel);
          continue;
        }
        walk(rel);
        if (fs.readdirSync(destPath).length === 0) {
          rm(destPath);
          removed.push(rel);
        }
      } else if (!fs.existsSync(srcPath)) {
        rm(destPath);
        removed.push(rel);
      }
    }
  };
  walk('');
  return removed;
}

/**
 * The explicitly-named tooling source, if any. Flag beats env; both are
 * resolved to an absolute path so the plan's `from`/`to` are comparable.
 *
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} env
 * @param {string} cwd
 * @returns {string|null}
 */
export function resolveExplicitSource(argv, env, cwd) {
  // Stop at the POSIX `--` terminator (audit R5 M6): everything after it is
  // positional by convention, and a hand-rolled scanner that keeps reading
  // finds a `--from` the shell's own conventions say is not a flag.
  const end = argv.indexOf('--');
  const flags = end === -1 ? argv : argv.slice(0, end);

  const eq = flags.find((a) => typeof a === 'string' && a.startsWith('--from='));
  if (eq) {
    const v = eq.slice('--from='.length);
    // A PRESENT but empty/invalid value is an error, not an absence (audit
    // R5 M2). Falling back to SKILLS_SOURCE here would hydrate from a
    // different place than the operator just named — silently doing something
    // other than what was asked, which is the same reason `--out` on
    // arch:drift refuses a flag-shaped value rather than consuming it.
    if (!v) throw new ArgvError('skills-hydrate: --from requires a non-empty path value');
    return path.resolve(cwd, v);
  }
  const i = flags.indexOf('--from');
  if (i !== -1) {
    const value = flags[i + 1];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw new ArgvError('skills-hydrate: --from requires a non-empty path value '
        + `(got ${JSON.stringify(value ?? null)})`);
    }
    return path.resolve(cwd, value);
  }
  const fromEnv = env?.[SOURCE_ENV_VAR];
  return fromEnv ? path.resolve(cwd, fromEnv) : null;
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
  let explicitSource;
  try {
    explicitSource = resolveExplicitSource(process.argv, process.env, cwd);
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    throw err;
  }
  const mainWorktree = resolveMainWorktree(run);
  const base = explicitSource ?? mainWorktree;
  const src = base ? path.resolve(base, SYNCED_TOOLING_DIR) : null;

  const manifestSrc = base ? path.resolve(base, SYNCED_MANIFEST_PATH) : null;

  const plan = planHydration({
    cwd,
    mainWorktree,
    packageName: readPackageName(cwd),
    sourceExists: src ? fs.existsSync(src) : false,
    manifestExists: manifestSrc ? fs.existsSync(manifestSrc) : false,
    explicitSource,
    // Resolved HERE, not inside the pure planner: detection reads the
    // filesystem, and a two-lockfile repo is deliberately left ambiguous by
    // `detectPackageManager` rather than guessed.
    installCommand: displayDlx(detectPackageManager(cwd), [...INSTALL_ARGV]),
  });

  let pruned = [];
  if (plan.action === 'copy') {
    for (const item of plan.items) {
      if (!item.present) continue;
      if (item.recursive) {
        fs.cpSync(item.from, item.to, { recursive: true });
        pruned = pruned.concat(pruneStale(item.from, item.to));
      } else {
        fs.mkdirSync(path.dirname(item.to), { recursive: true });
        fs.copyFileSync(item.from, item.to);
      }
    }
  }
  if (asJson) {
    console.log(JSON.stringify({ ok: plan.action !== 'fail', ...plan, pruned }));
  } else {
    const message = pruned.length > 0 ? `${plan.message} (pruned ${pruned.length} stale item(s))` : plan.message;
    (plan.action === 'fail' ? process.stderr : process.stdout).write(`${message}\n`);
  }
  process.exit(plan.action === 'fail' ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('skills-hydrate.mjs')) {
  main();
}
