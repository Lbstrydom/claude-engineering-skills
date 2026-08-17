/**
 * @fileoverview Path resolution for the pinned-revision fixture — where a
 * fixture lives, and what its name is allowed to be.
 *
 * **Why OUTSIDE the repository** (plan: `docs/plans/pinned-revision-fixture.md`
 * §2 Decision 1). The default root is a SIBLING of the main checkout, not
 * `.claude/worktrees/`. Two measured reasons, neither of which is "inside does
 * not work" — it does:
 *
 *   1. `.claude/worktrees/` is the HARNESS's worktree namespace. Claude Code
 *      creates and removes worktrees there, and a fixture must survive
 *      untouched for the 15–25 minutes a snapshot takes while other agent
 *      sessions operate. It is also where the orphan residue accumulates: 11
 *      directories against 3 registered worktrees on 2026-08-18.
 *   2. A repo-walking gate cannot reach what is not in the repo. Inside is
 *      survivable — every enumeration path here is either gitignore-respecting
 *      (`git ls-files --exclude-standard`) or scoped to a named subtree, and
 *      all of `docs:check`, `docs:refs:gate`, `cli:flags:gate`, `npm-args:gate`,
 *      `emit:exit:gate`, `worktree:preflight:gate`, `db:enrolment:gate`,
 *      `knip:gate` and the layering oracle pass with 11 such directories
 *      present. But that safety rests on one `.gitignore` line staying true for
 *      every future walker; outside is safe by construction.
 *
 * The often-cited argument FOR inside — "`.env` discovery resolves for free" —
 * is void: a worktree is its own `repoRoot` either way, so both fall through to
 * the identical `main-worktree` branch of `discoverLocalEnvPath`. Measured from
 * an outside worktree with a competing stray `.env` in an ancestor directory:
 * all ten credentials resolved. `tests/pinned-worktree.test.mjs` pins that
 * branch, so removing it fails a test rather than silently invalidating the
 * decision.
 *
 * `--root` remains available and pointing it at `.claude/worktrees/` is NOT
 * blocked — the evidence says it works. It is simply not the default.
 *
 * @module scripts/lib/pinned-worktree/paths
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * Fixture names, deliberately the same shape as `CAMPAIGN_ID_PATTERN`
 * (`scripts/lib/campaign/config.mjs`).
 *
 * This is a containment control, not a style rule: the name is joined onto an
 * operator-supplied root, so anything permitting `.`, `/` or `\` would let a
 * name escape the root — and `remove` deletes directories. A closed character
 * class cannot express `..` at all, which is a stronger guarantee than
 * normalising and re-checking afterwards.
 */
export const FIXTURE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * @param {string} name
 * @returns {string} the validated name
 * @throws {Error} when the name could escape its root
 */
export function assertFixtureName(name) {
  if (typeof name !== 'string' || !FIXTURE_NAME_PATTERN.test(name)) {
    throw new Error(
      `pinned-worktree: invalid fixture name ${JSON.stringify(name)}. `
      + 'Allowed: lowercase letters, digits and hyphens, starting with a letter or digit, '
      + 'max 64 chars. The name is joined onto a directory that `remove` deletes, so the '
      + 'pattern is a containment control — it cannot express a path separator or `..`.',
    );
  }
  return name;
}

/**
 * Absolute path of the MAIN checkout, from anywhere inside the repository
 * (including a linked worktree).
 *
 * `--git-common-dir` resolves to the main checkout's `.git` even from a linked
 * worktree, which `--show-toplevel` does not — the same derivation
 * `scripts/skills-hydrate.mjs` and `discoverLocalEnvPath` use. `--path-format=absolute`
 * is explicit rather than relying on git's default, which is relative in some
 * invocations and would resolve against the wrong base here.
 *
 * @param {string} [cwd]
 * @returns {string}
 */
export function resolveMainRoot(cwd = process.cwd()) {
  const commonDir = execFileSync(
    'git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd, encoding: 'utf-8' },
  ).trim();
  return path.resolve(path.dirname(commonDir));
}

/**
 * The default root holding all fixtures: a sibling of the main checkout named
 * `<repo>-pinned`.
 *
 * A sibling rather than a temp directory on purpose. A fixture is a working
 * checkout an operator inspects, reruns commands in, and reads logs from over
 * 15–25 minutes; putting it under the OS temp dir invites cleaners and makes it
 * awkward to `cd` to. It also mirrors the hand-made `C:/GIT/ces-bakeoff` that
 * demonstrably worked.
 *
 * @param {string} mainRoot
 * @returns {string}
 */
export function defaultFixtureRoot(mainRoot) {
  const resolved = path.resolve(mainRoot);
  return path.join(path.dirname(resolved), `${path.basename(resolved)}-pinned`);
}

/**
 * Absolute path of one fixture.
 *
 * @param {string} root
 * @param {string} name
 * @returns {string}
 */
export function fixturePath(root, name) {
  return path.join(path.resolve(root), assertFixtureName(name));
}
