/**
 * @fileoverview Single oracle for "which package manager does this repo use,
 * and how do I invoke it without a shell".
 *
 * **Why this exists.** `ensureAuditDeps` hardcoded `npm install --save-dev`.
 * Measured 2026-08-15 in a scratch pnpm repo, that command does not merely
 * write a competing lockfile — npm cannot read pnpm's symlinked tree at all and
 * dies with `Cannot destructure property 'package' of 'node.target'`. A plain
 * npm repo in the same parent directory took the identical command cleanly, so
 * the failure is the layout, not the environment. Consumer dependency
 * auto-install has therefore never worked in a pnpm repo, and the manual
 * command it printed on failure was the same broken npm one.
 *
 * **Detection has to be right in BOTH directions.** The inverse is equally
 * destructive and much quieter: `pnpm add` inside an npm repo succeeds and
 * leaves a `pnpm-lock.yaml` sitting next to `package-lock.json` (also measured).
 * So a wrong answer here corrupts a consumer either way, which is why an
 * ambiguous repo resolves to `ambiguous` rather than to a guess.
 *
 * @module scripts/lib/package-manager
 */
import fs from 'node:fs';
import path from 'node:path';

/** Package managers this module can drive. */
export const SUPPORTED_PACKAGE_MANAGERS = Object.freeze(['npm', 'pnpm', 'yarn', 'bun']);

/**
 * Lockfile → manager. Order is the precedence used when a repo somehow carries
 * more than one; it only decides which name leads the `candidates` list, since
 * a multi-lockfile repo is reported `ambiguous` and never auto-installed into.
 */
const LOCKFILES = Object.freeze([
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
]);

/** corepack's own shape: `<name>@<semver>[+<hash>]`. */
const PACKAGE_MANAGER_FIELD_RE = /^([a-z]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(\+[0-9A-Za-z.]+)?$/;

/**
 * Read the corepack `packageManager` field, which is the only *declared*
 * signal — a lockfile is an artifact, this is an intent.
 *
 * Distinguishes three outcomes, not two — collapsing "absent" and "present
 * but broken" into one `null` (round-1 audit H6/M3/M17, 2026-08-15) let a
 * TYPO'd declaration (`pnmp@8.0.0`, or a name outside
 * {@link SUPPORTED_PACKAGE_MANAGERS}) fall straight through to lockfile
 * guessing — silently overriding the very intent this field exists to
 * declare. A malformed declaration must block, the same as an ambiguous
 * lockfile pair does, never be treated as "no opinion."
 *
 * A FOURTH outcome, added round-2 (audit M8, 2026-08-15): `package.json`
 * exists but fails to even PARSE. That is not "no opinion" either — a repo
 * with broken JSON has a bigger problem than which package manager it uses,
 * and silently guessing from a lockfile while its manifest is unreadable is
 * misleading. Kept distinct from "no package.json at all", which genuinely
 * is no-opinion (plenty of non-JS repos have none, and callers that care
 * already check existence separately — e.g. `ensureAuditDeps`'s
 * `hasPackageJson`).
 *
 * @param {string} repoRoot
 * @returns {{name: string, invalid: false} | {name: null, invalid: false}
 *   | {name: null, invalid: true, raw: string}}
 */
function declaredPackageManager(repoRoot) {
  const pkgPath = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return { name: null, invalid: false };

  let field;
  try {
    field = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).packageManager;
  } catch (err) {
    return { name: null, invalid: true, raw: `package.json: ${err.message}` };
  }
  if (field === undefined) return { name: null, invalid: false };
  if (typeof field !== 'string') return { name: null, invalid: true, raw: String(field) };
  const m = PACKAGE_MANAGER_FIELD_RE.exec(field.trim().toLowerCase());
  if (!m || !SUPPORTED_PACKAGE_MANAGERS.includes(m[1])) {
    return { name: null, invalid: true, raw: field };
  }
  return { name: m[1], invalid: false };
}

/**
 * Determine the package manager governing `repoRoot`.
 *
 * Precedence: declared `packageManager` field → lockfile on disk → npm default.
 * A repo carrying two or more managers' lockfiles is `ambiguous:true` unless a
 * `packageManager` field settles it, because picking one would write into a
 * tree the other owns. A `packageManager` field that IS present but does not
 * parse (bad name or bad version shape) is `invalidDeclaration:true` and
 * likewise never falls through to a guess — see {@link declaredPackageManager}.
 *
 * @param {string} repoRoot — absolute path to the repo root
 * @returns {{name: string, source: 'declared'|'lockfile'|'default',
 *   ambiguous: boolean, invalidDeclaration: boolean, candidates: string[]}}
 */
export function detectPackageManager(repoRoot) {
  const found = [];
  for (const [file, name] of LOCKFILES) {
    if (fs.existsSync(path.join(repoRoot, file)) && !found.includes(name)) found.push(name);
  }

  const declared = declaredPackageManager(repoRoot);
  if (declared.invalid) {
    // Do NOT fall through to lockfile evidence: the repo tried to declare an
    // authoritative manager and got it wrong, which is a configuration error
    // to surface, not silent permission to guess from whatever lockfile
    // happens to be lying around (possibly stale, from before a migration).
    return {
      name: found[0] || 'npm', source: 'declared', ambiguous: false,
      invalidDeclaration: true, candidates: found,
    };
  }
  if (declared.name) {
    // An explicit valid declaration is authoritative and de-ambiguates by itself.
    return { name: declared.name, source: 'declared', ambiguous: false, invalidDeclaration: false, candidates: found };
  }
  if (found.length === 1) {
    return { name: found[0], source: 'lockfile', ambiguous: false, invalidDeclaration: false, candidates: found };
  }
  if (found.length > 1) {
    return { name: found[0], source: 'lockfile', ambiguous: true, invalidDeclaration: false, candidates: found };
  }
  return { name: 'npm', source: 'default', ambiguous: false, invalidDeclaration: false, candidates: [] };
}

/**
 * First existing path among `candidates`, else null.
 * @param {string[]} candidates
 * @returns {string|null}
 */
function firstExisting(candidates) {
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Locate a JS entry point that a package manager can be driven through under
 * the CURRENT node binary.
 *
 * **Why not just spawn the binary.** On Windows the manager on PATH is a
 * `.cmd`, and Node >= 22.19 refuses to spawn `.cmd` without `shell: true`
 * (CVE-2024-27980 hardening): bare `pnpm` is ENOENT and `pnpm.cmd` is EINVAL —
 * measured, identical to the npm failure `npmInvocation` was written for.
 * `shell: true` would fix the spawn and reopen quoting pitfalls on argv that
 * carries package names, so instead we run the manager's own JS entry.
 *
 * npm has `npm-cli.js` beside the node binary. pnpm and yarn do not ship with
 * node, but **corepack does**, and `node corepack.js pnpm …` drives them with
 * no shell (verified 2026-08-15, including in a repo with no `packageManager`
 * field). bun is not a corepack manager and has no bundled JS entry, so it
 * falls through to the bare-binary path.
 *
 * That bare-binary path returns `shell: true` on Windows (round-1 AND
 * round-2 audit H1/H4/M6, 2026-08-15 — flagged again after round 1's
 * "restrict reachability + document it" compromise proved insufficient: a
 * caught EINVAL is still a manager that never actually runs on Windows, which
 * is the exact defect this module exists to fix, not accept). Safe here
 * specifically because every argv reaching this branch, in every current
 * caller, is either a fixed literal (`'playwright'`, `'--version'`,
 * `'install'`, `'chromium'`) or an internally-curated package name from this
 * repo's own `bundleDeps()`/`OPTIONAL_DEPS` — never externally-supplied
 * input. `{bin, prefix}` alone (the npm/pnpm/yarn JS-entry paths) stay
 * shell-free, so this is the ONLY branch that opts in, and callers must
 * pass this `shell` field through explicitly rather than hardcoding `false`.
 *
 * @param {string} pm
 * @returns {{bin: string, prefix: string[], viaCorepack: boolean, shell: boolean}}
 */
export function packageManagerInvocation(pm) {
  const nodeDir = path.dirname(process.execPath);

  if (pm === 'npm') {
    const cli = firstExisting([
      path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ]);
    if (cli) return { bin: process.execPath, prefix: [cli], viaCorepack: false, shell: false };
  }

  if (pm === 'pnpm' || pm === 'yarn') {
    const corepack = firstExisting([
      path.join(nodeDir, 'node_modules', 'corepack', 'dist', 'corepack.js'),
      path.join(nodeDir, '..', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js'),
    ]);
    if (corepack) return { bin: process.execPath, prefix: [corepack, pm], viaCorepack: true, shell: false };
  }

  // No bundled JS entry (bun, or an unusual node layout). Round-3 audit M2,
  // 2026-08-15: this used to hardcode `${pm}.cmd` on Windows, which is wrong
  // for bun specifically — unlike npm/pnpm/yarn (Node.js scripts needing a
  // `.cmd`/`.ps1` wrapper shim on Windows), bun ships as a single native
  // binary, so its real name there is `bun.exe`. Rather than guess a second
  // extension, use the BARE name with `shell: true` on Windows: cmd.exe's own
  // PATH + PATHEXT resolution finds whichever extension (.exe/.cmd/.bat)
  // actually exists, so this is correct regardless of which one a given
  // manager or node layout uses — no extension guess to get wrong.
  return {
    bin: pm,
    prefix: [],
    viaCorepack: false,
    shell: process.platform === 'win32',
  };
}

/**
 * True when `repoRoot` is the ROOT of a pnpm workspace — the one case `pnpm
 * add` refuses to touch without an explicit `-w`/`--workspace-root` flag
 * (`ERR_PNPM_ADDING_TO_ROOT`, ~pnpm 7+), on the theory that adding to the
 * workspace root is usually a mistake. Detected by the same signal pnpm
 * itself uses — presence of `pnpm-workspace.yaml` — not a lockfile guess: a
 * workspace and a plain single-package pnpm repo both carry `pnpm-lock.yaml`,
 * so the lockfile can't tell them apart.
 * @param {string} repoRoot
 * @returns {boolean}
 */
export function isPnpmWorkspaceRoot(repoRoot) {
  return fs.existsSync(path.join(repoRoot, 'pnpm-workspace.yaml'));
}

/**
 * Per-manager argv for "add these as dev dependencies".
 *
 * `--legacy-peer-deps` is npm-only and deliberately not translated: it bypasses
 * ESLint / framework peer-dep conflicts that are orthogonal to the audit loop,
 * and the other managers neither accept the flag nor fail the same way.
 *
 * `repoRoot` is optional and pnpm-only: pass it when the target might be a
 * pnpm workspace root, so `-w` can be added ahead of time rather than
 * discovered from a failed install. Omitted (or not a workspace root) →
 * byte-identical to before this parameter existed. Found live 2026-08-30 in
 * a consumer whose `pnpm-workspace.yaml` made every automated dep-install
 * silently fail at the root with no lasting record beyond a stderr line the
 * sync log scrolled past — the consumer worked around it by hand-adding the
 * same 11 packages.
 *
 * @param {string} pm
 * @param {string[]} pkgs
 * @param {string} [repoRoot]
 * @returns {string[]}
 */
export function addDevDepsArgs(pm, pkgs, repoRoot = null) {
  switch (pm) {
    case 'pnpm':
      return ['add', '-D', ...(repoRoot && isPnpmWorkspaceRoot(repoRoot) ? ['-w'] : []), ...pkgs];
    case 'yarn':
      return ['add', '-D', ...pkgs];
    case 'bun':
      return ['add', '-d', ...pkgs];
    case 'npm':
    default:
      return ['install', '--save-dev', '--legacy-peer-deps', ...pkgs];
  }
}

/**
 * Per-manager argv for "run this package binary".
 * @param {string} pm
 * @param {string[]} argv — e.g. ['playwright', 'install', 'chromium']
 * @returns {string[]}
 */
export function execBinaryArgs(pm, argv) {
  switch (pm) {
    case 'pnpm':
    case 'yarn':
      return ['exec', ...argv];
    case 'bun':
      return ['x', ...argv];
    case 'npm':
    default:
      return ['exec', '--', ...argv];
  }
}

/**
 * The human-facing form of a command — what we print in a hint or a failure
 * message. Always the manager as a user types it (`pnpm add -D x`), never the
 * `node <cli.js>` transport we actually spawn, which would be unusable advice.
 *
 * @param {string} pm
 * @param {string[]} args
 * @returns {string}
 */
export function displayCommand(pm, args) {
  return [pm, ...args].join(' ');
}

/**
 * Human-facing "add these dev dependencies" line.
 *
 * Deliberately NOT `displayCommand(pm, addDevDepsArgs(pm, pkgs))`: that carries
 * npm's `--legacy-peer-deps`, which is an automation workaround for peer-dep
 * conflicts in someone else's tree, not something to tell a human to type.
 * Use this in setup hints; use {@link addDevDepsArgs} for the command we run.
 *
 * `repoRoot` is optional and pnpm-only, mirroring {@link addDevDepsArgs} — a
 * hand-typed command must carry `-w` too, or a workspace-root user copies
 * advice that fails the exact same way the automated install did.
 *
 * @param {string} pm
 * @param {string[]} pkgs
 * @param {string} [repoRoot]
 * @returns {string}
 */
export function displayAddDev(pm, pkgs, repoRoot = null) {
  switch (pm) {
    case 'pnpm':
      return ['pnpm', 'add', '-D', ...(repoRoot && isPnpmWorkspaceRoot(repoRoot) ? ['-w'] : []), ...pkgs].join(' ');
    case 'yarn':
      return ['yarn', 'add', '-D', ...pkgs].join(' ');
    case 'bun':
      return ['bun', 'add', '-d', ...pkgs].join(' ');
    case 'npm':
    default:
      return ['npm', 'i', '-D', ...pkgs].join(' ');
  }
}

/**
 * Run a binary that the repo ALREADY has as a dependency. Display-only.
 *
 * **Not `pnpm dlx`** — that is the trap this function exists to avoid.
 * Measured 2026-08-15 in a repo with playwright 1.62.1 installed:
 * `npx playwright --version` used the local binary and fetched nothing, while
 * `pnpm dlx playwright --version` resolved and downloaded a fresh copy into a
 * temp store regardless. So translating `npx <local-bin>` to `pnpm dlx` turns a
 * local invocation into an unpinned registry fetch on every run — more
 * supply-chain exposure, not less, for a package the lockfile already pins.
 *
 * `dlx`/`bunx` are for running something you have NOT installed — a different
 * question, asked by exactly one call site (`displayDlx` below, for the
 * install-the-bundle remedy). Keep the two apart: they are opposites, and
 * reaching for the wrong one is how a local invocation becomes an unpinned
 * fetch, or an install command becomes a no-op.
 *
 * @param {string} pm
 * @param {string[]} argv
 * @returns {string}
 */
export function displayExec(pm, argv) {
  switch (pm) {
    case 'pnpm':
      return ['pnpm', 'exec', ...argv].join(' ');
    case 'yarn':
      return ['yarn', 'exec', ...argv].join(' ');
    case 'bun':
      // `bun x`, matching {@link execBinaryArgs}'s actual spawn — NOT the
      // standalone `bunx` binary. Round-2 audit M7/M1, 2026-08-15: this
      // module could not empirically verify bun's local-vs-fetch behavior
      // (no bun binary in this environment, unlike npm/pnpm which WERE
      // measured above), and the plan's own acceptance criteria bar emitting
      // `bunx` for an already-depended-on package. Aligning the display
      // string to the subcommand form this module actually spawns removes
      // the unverified claim and the display/execution mismatch at once,
      // without asserting a behavioral fact about `bunx` this module cannot
      // back up.
      return ['bun', 'x', ...argv].join(' ');
    case 'npm':
    default:
      // npx prefers node_modules/.bin before fetching — verified above.
      return ['npx', ...argv].join(' ');
  }
}

/**
 * Run a package the repo does NOT have installed — the fetch-and-run dialect.
 *
 * The exact opposite of {@link displayExec}, and deliberately a separate
 * function rather than a flag on it: the two answer opposite questions and the
 * failure of confusing them is silent in both directions (`pnpm exec
 * github:owner/repo` simply does not fetch, and `pnpm dlx <local-bin>` fetches
 * something the lockfile already pins).
 *
 * Its one caller today is `skills-hydrate.mjs`'s remedy for a plain clone,
 * which must tell a consumer how to INSTALL this bundle. That string was
 * hardcoded to `npx` and read by a pnpm consumer (audit R1 H3, 2026-09-04) —
 * `npx` happens to work wherever npm is on PATH, but a corepack-managed pnpm
 * CI image need not have it.
 *
 * **yarn deliberately falls back to `npx`.** `yarn dlx` is Berry-only; Yarn
 * Classic has no equivalent, and this module does not probe the yarn major
 * version. Emitting `yarn dlx` for an unknown yarn would be an unverified
 * claim — the same reason {@link displayExec} refuses to emit `bunx`. `npx` is
 * the honest lowest common denominator there, not an oversight.
 *
 * @param {string} pm
 * @param {string[]} argv
 * @returns {string}
 */
export function displayDlx(pm, argv) {
  switch (pm) {
    case 'pnpm':
      return ['pnpm', 'dlx', ...argv].join(' ');
    case 'bun':
      return ['bun', 'x', ...argv].join(' ');
    case 'yarn':
    case 'npm':
    default:
      return ['npx', ...argv].join(' ');
  }
}

/**
 * The `npx playwright install chromium` line, in the dialect of whichever
 * manager governs `repoRoot`.
 *
 * Exists because that string was hardcoded in seven modules and every one of
 * them told a pnpm user to run a command for a manager they may not have. One
 * oracle so a new call site cannot reintroduce the npm-only spelling.
 *
 * @param {string} [repoRoot] — defaults to cwd
 * @returns {string}
 */
export function playwrightInstallHint(repoRoot = process.cwd()) {
  const { name } = detectPackageManager(repoRoot);
  return displayExec(name, ['playwright', 'install', 'chromium']);
}

/**
 * The hint for a repo that does not have the playwright PACKAGE at all — it
 * needs the dependency first, then the browser binary.
 *
 * Kept distinct from {@link playwrightInstallHint} because the two states are
 * genuinely different and the fix differs: "package missing" needs both halves,
 * "browser binary missing" needs only the second. Collapsing them tells a user
 * with no playwright installed to run a binary they do not have.
 *
 * @param {string} [repoRoot] — defaults to cwd
 * @returns {string}
 */
export function playwrightBootstrapHint(repoRoot = process.cwd()) {
  const { name } = detectPackageManager(repoRoot);
  return `${displayAddDev(name, ['playwright'], repoRoot)} && ${displayExec(name, ['playwright', 'install', 'chromium'])}`;
}
