#!/usr/bin/env node
/**
 * @fileoverview One-command installer for claude-engineering-skills.
 *
 * Usage:
 *   npx github:Lbstrydom/claude-engineering-skills /path/to/repo
 *   node install.mjs /path/to/repo [--dry-run] [--ref <branch|tag|sha>] [--yes]
 *
 * ## What this is, and what it deliberately is NOT
 *
 * A **thin bootstrapper**. It acquires a verified copy of the bundle and then
 * DELEGATES every concern to the one implementation that already owns it:
 *
 *   skills + runners + gitignore + manifest -> scripts/sync-to-repos.mjs
 *   legacy-surface inspection               -> lib/install/legacy-surfaces.mjs
 *   legacy-surface removal                  -> scripts/install-skills.mjs --uninstall-legacy
 *
 * It owns **no file lists**. The previous version carried a hardcoded
 * `SCRIPTS = ['openai-audit.mjs', 'shared.mjs', …]` (7 of ~570 files, with no
 * `lib/**` import closure — so every install was a guaranteed MODULE_NOT_FOUND),
 * a hardcoded skill list naming `audit-loop` which no longer exists (1 of 15
 * skills actually installed), a write to the retired `.github/skills/` surface,
 * and a pre-push hook that ran a source-repo-only script inside the consumer.
 * Every one of those was a hand-maintained duplicate of machinery that already
 * existed in a correct, tested form. They are deleted rather than corrected:
 * `resolveBundle`'s import-graph closure is the right answer, and a second list
 * is how the first one rotted.
 *
 * ## Contract
 *
 * Bundle source is a CONSTANT read from this package's own `repository.url` —
 * never `git remote`, never an env override. `npx github:…` may execute an
 * unpacked tarball with no `.git` at all, and deriving the source from the
 * execution context would additionally let whatever repo the operator happens to
 * be standing in decide what gets installed. `--ref` is resolved to an immutable
 * SHA and printed before anything is written.
 *
 * `--dry-run` is whole-run: the cache is still acquired (there is nothing to
 * rehearse without it), the sync runs in dry-run mode, env prompts are SKIPPED,
 * and the legacy migration inspects and reports only — it never deletes in any
 * mode. A dry run that removed the legacy copy while writing no replacement
 * would leave the machine with neither, from the one command that promised to
 * change nothing.
 *
 * Plan: docs/plans/repo-scoped-skill-surfaces-and-installer.md §2 D6a-D6e.
 *
 * @module install
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

import { createPrompter } from './scripts/lib/install/prompt.mjs';

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', B = '\x1b[1m', D = '\x1b[2m', X = '\x1b[0m';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));

const KNOWN_FLAGS = ['--dry-run', '--ref', '--yes', '--help', '-h'];
const KNOWN_DOCTOR_FLAGS = ['--ref', '--json', '--gate', '--only', '--help', '-h'];

const KEYS = [
  { name: 'OPENAI_API_KEY', req: true, hint: 'GPT auditing (required)' },
  { name: 'GEMINI_API_KEY', req: false, hint: 'Gemini independent final review' },
  { name: 'ANTHROPIC_API_KEY', req: false, hint: 'Claude Opus fallback reviewer, brief generation' },
  { name: 'AUDIT_DB_URL', req: false, hint: 'cloud learning store Postgres DSN (Supabase Connect -> Session pooler)' },
  { name: 'PERSONA_TEST_APP_URL', req: false, hint: 'default app URL for /persona-test (e.g. https://myapp.railway.app)' },
];

/**
 * The canonical bundle source — a pure function of the package manifest.
 *
 * Takes `pkg` rather than reading it, so the hermetic end-to-end test can drive
 * the real bootstrap against a local fixture remote through the module seam. That
 * is deliberately the ONLY injection point: an env var or config override would
 * reintroduce exactly what this constant exists to prevent — an ambient value
 * choosing which code gets cloned and executed.
 *
 * @param {{repository?: string|{url?: string}}} pkg
 * @returns {string} git-cloneable URL
 */
export function bundleSource(pkg) {
  const raw = typeof pkg?.repository === 'string' ? pkg.repository : pkg?.repository?.url;
  if (!raw) {
    throw new Error('package.json has no `repository.url` — cannot determine the bundle source');
  }
  return String(raw).replace(/^git\+/, '').replace(/\.git$/, '') + '.git';
}

function parseArgs(argv) {
  const args = { target: null, dryRun: false, ref: null, yes: false, help: false };
  const positionals = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    if (a === '--dry-run') { args.dryRun = true; continue; }
    if (a === '--yes') { args.yes = true; continue; }
    if (a === '--ref') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) throw new Error('--ref requires a value');
      args.ref = v;
      continue;
    }
    if (a.startsWith('-')) {
      throw new Error(
        `unknown flag "${a}". Accepted: ${KNOWN_FLAGS.join(', ')}. `
        + 'Refusing to run rather than ignore it.',
      );
    }
    positionals.push(a);
  }
  if (positionals.length > 1) {
    throw new Error(`expected one target directory, got ${positionals.length}: ${positionals.join(', ')}`);
  }
  args.target = positionals[0] ?? null;
  return args;
}

/**
 * Parse `install.mjs doctor [target] [flags]`. Called only after `argv[2] ===
 * 'doctor'` has already been detected by the caller — scanning starts at
 * index 3 so the literal subcommand word is never mistaken for a flag or the
 * target positional.
 */
export function parseDoctorArgs(argv) {
  const args = { target: null, ref: null, json: false, gate: false, only: null, help: false };
  const positionals = [];
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    if (a === '--json') { args.json = true; continue; }
    if (a === '--gate') { args.gate = true; continue; }
    if (a === '--ref') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) throw new Error('--ref requires a value');
      args.ref = v;
      continue;
    }
    if (a === '--only') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) throw new Error('--only requires a value');
      args.only = v;
      continue;
    }
    if (a.startsWith('-')) {
      throw new Error(
        `unknown flag "${a}". Accepted: ${KNOWN_DOCTOR_FLAGS.join(', ')}. `
        + 'Refusing to run rather than ignore it.',
      );
    }
    positionals.push(a);
  }
  if (positionals.length > 1) {
    throw new Error(`expected at most one target directory, got ${positionals.length}: ${positionals.join(', ')}`);
  }
  args.target = positionals[0] ?? null;
  return args;
}

function doctorUsage() {
  console.log(`${B}claude-engineering-skills doctor${X} — diagnose consumer-adoption friction

${B}Usage (RECOMMENDED — pinned to an immutable commit)${X}
  npx github:Lbstrydom/claude-engineering-skills#<sha> doctor [target-repo] [options]

${B}Usage (quick — resolves the default branch tip; less strict)${X}
  npx github:Lbstrydom/claude-engineering-skills doctor [target-repo] [options]
  node install.mjs doctor [target-repo] [options]

Runs every probe this bundle knows about (worktree hydration, package-manager
identity, sync isolation, DB/API-key setup, browser prerequisites, ...)
against [target-repo] (default: the current directory) and prints a fix for
each finding. Advisory by default (exit 0); pass --gate for a CI-style exit
code.

${B}Two-stage provenance — why the pinned form is the default recommendation${X}
(docs/runbooks/consumer-adoption.md §Diagnostics): stage 0 — fetching THIS
installer via \`npx github:...\` follows npx's own spec resolution, and an
UNPINNED spec (no \`#<sha>\`) resolves the default branch TIP at request time —
mutable, not integrity-verified; stage 1 — install.mjs then resolves --ref (or
the default branch) to an immutable SHA before acquiring the bundle doctor.mjs
runs from, which is reproducible regardless. \`--ref\` alone does NOT cover
stage 0 — it is parsed only after stage 0's code is already fetched and
running. The \`#<sha>\` form above is an ordinary npx capability that pins BOTH
stages at once; prefer it whenever you can supply a known-good commit.

\`npx\` requires Node.js + npm on YOUR machine (a stage-0 bootstrap prerequisite,
independent of whatever package manager [target-repo] itself uses).

${B}Options${X}
  --ref <branch|tag|sha>   Bundle version to diagnose FROM (default: the remote's default branch)
  --json                   Machine-readable output
  --gate                   Non-zero exit iff a repo-state probe failed
  --only <id,id,...>       Narrow the printed report (never narrows --gate's exit-code set)
`);
}

/**
 * The `install.mjs doctor <target>` bootstrap (consumer-friction-doctor plan
 * §2.3a/§2.6). Acquires the bundle via the SAME SHA-pinned `resolveBundle`
 * stage 1 uses for a real install — never a second acquisition mechanism —
 * then invokes the ACQUIRED copy's `scripts/doctor.mjs` with an EXPLICIT
 * `--consumer-root <target>`. `doctor.mjs` never guesses `subjectRoot` on
 * this path; guessing here is exactly the class of target-root confusion
 * R1-H1 exists to close (the npx bootstrap runs from a transient checkout
 * that is NOT the repo being diagnosed).
 *
 * @returns {Promise<number>} the doctor's own exit code, passed through
 */
export async function runDoctor({
  pkg, target, ref = null, json = false, gate = false, only = null,
  // Seams, injected ONLY by the hermetic test (mirrors bootstrap()'s own
  // installDepsFn/onStep split). `resolveRefFn`/`acquireBundleFn` need a real
  // git remote and `installDepsFn` needs a registry, so the offline test
  // substitutes all three; `spawnDoctorFn` substitutes the actual doctor run.
  // What is NOT stubbed — and is exactly the thing R1-H1 cares about — is the
  // ARGV this function builds: the real code path from `target` to
  // `--consumer-root <target>` always runs, so a test can assert that flag
  // carries the fixture's target, never the (here, entirely fake) bundleRoot.
  // None of the four is reachable from the CLI or the environment.
  resolveRefFn = resolveRef,
  acquireBundleFn = acquireBundle,
  installDepsFn = installDeps,
  spawnDoctorFn = (execPath, argv, opts) => execFileSync(execPath, argv, opts),
}) {
  // In --json mode stdout is reserved for doctor.mjs's OWN single JSON
  // payload (inherited straight through below) — this wrapper's progress
  // lines go to stderr instead, or they would interleave with that payload
  // and produce unparseable output for a machine caller.
  const say = json ? (msg) => process.stderr.write(`${msg}\n`) : (msg) => console.log(msg);

  const sourceUrl = bundleSource(pkg);
  const resolved = resolveRefFn(sourceUrl, ref);
  say(`  Source: ${sourceUrl}`);
  say(`  Version: ${resolved.label} @ ${resolved.sha.slice(0, 12)}`);

  const { withFileLock } = await import('./scripts/lib/file-lock.mjs').catch(() => ({ withFileLock: null }));
  const lock = lockPath(cacheRoot());
  fs.mkdirSync(path.dirname(lock), { recursive: true });

  const doWork = () => {
    const bundleRoot = acquireBundleFn(sourceUrl, resolved.sha);
    say(`  ${G}✓${X} bundle ready at ${bundleRoot}`);

    // doctor.mjs's own transitive deps (e.g. `pg`, for the setup/audit-supabase
    // probe) must be present in the acquired checkout — same requirement a
    // real install has, and the same step bootstrap() already runs.
    installDepsFn(bundleRoot);
    say(`  ${G}✓${X} dependencies installed`);

    const doctorArgv = [
      path.join(bundleRoot, 'scripts', 'doctor.mjs'),
      '--consumer-root', target,
      '--bundle-sha', resolved.sha,
      ...(json ? ['--json'] : []),
      ...(gate ? ['--gate'] : []),
      ...(only ? ['--only', only] : []),
    ];
    try {
      spawnDoctorFn(process.execPath, doctorArgv, { cwd: bundleRoot, stdio: 'inherit' });
      return 0;
    } catch (err) {
      // execFileSync throws on a non-zero child exit; `err.status` carries the
      // real code (--gate's 1, a usage error's 2) — pass it through rather than
      // collapsing every non-zero result to a generic 1.
      return typeof err.status === 'number' ? err.status : 1;
    }
  };

  return withFileLock ? withFileLock(lock, { maxWaitMs: 120_000 }, doWork) : doWork();
}

/**
 * `interactive` is computed ONCE and is what every prompt/no-prompt decision
 * keys on — including the legacy-migration split, which must never delete
 * without a human saying yes.
 */
function isInteractive(args) {
  return Boolean(process.stdin.isTTY) && !args.yes;
}

function usage() {
  console.log(`${B}claude-engineering-skills${X} — install the skill bundle into a repo

${B}Usage${X}
  npx github:Lbstrydom/claude-engineering-skills <target-repo> [options]

${B}Options${X}
  --ref <branch|tag|sha>   Bundle version to install (default: the remote's default branch)
  --dry-run                Show what would change; write nothing
  --yes                    Non-interactive; skip prompts (never auto-deletes from your home dir)
  --help                   This message

Skills install REPO-SCOPED into <target>/.claude/skills/, and the runners into
<target>/scripts/.claude-skills/. Nothing is written to your home directory.
See docs/reference/skill-surface-ownership.md.
`);
}

// ── Bundle cache ────────────────────────────────────────────────────────────

function cacheRoot() {
  return process.env.CES_BUNDLE_CACHE
    || path.join(os.homedir(), '.claude-engineering-skills', 'bundle');
}

/** The lock lives BESIDE the cache, so relocating the cache relocates the lock. */
function lockPath(cache) {
  return path.join(path.dirname(cache), '.lock');
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/**
 * Resolve `ref` (or the remote's default branch) to an immutable SHA.
 *
 * Resolved BEFORE anything is fetched or written, and printed, so a moving
 * branch cannot mean two different things within one run.
 */
function resolveRef(sourceUrl, ref) {
  if (ref && /^[0-9a-f]{40}$/i.test(ref)) return { sha: ref, label: ref };
  if (ref) {
    const out = git(['ls-remote', sourceUrl, ref]);
    const sha = out.split(/\s+/)[0];
    if (!sha) throw new Error(`--ref "${ref}" not found at ${sourceUrl}`);
    return { sha, label: ref };
  }
  const symref = git(['ls-remote', '--symref', sourceUrl, 'HEAD']);
  const branch = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(symref)?.[1] ?? 'HEAD';
  const sha = /^([0-9a-f]{40})\s+HEAD$/m.exec(symref)?.[1];
  if (!sha) throw new Error(`could not resolve HEAD at ${sourceUrl}`);
  return { sha, label: branch };
}

/**
 * Acquire or refresh the bundle at an exact SHA.
 *
 * A cache whose `origin` does not match the canonical source is DELETED and
 * re-cloned rather than fetched into — a cache repointed by an earlier run must
 * not be able to persist silently.
 */
function acquireBundle(sourceUrl, sha) {
  const cache = cacheRoot();
  fs.mkdirSync(path.dirname(cache), { recursive: true });

  let reusable = false;
  if (fs.existsSync(path.join(cache, '.git'))) {
    try {
      reusable = git(['remote', 'get-url', 'origin'], cache) === sourceUrl;
    } catch { reusable = false; }
  }
  if (fs.existsSync(cache) && !reusable) {
    fs.rmSync(cache, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }

  if (!fs.existsSync(cache)) {
    git(['clone', '--depth', '1', sourceUrl, cache]);
  }
  try {
    git(['fetch', '--depth', '1', 'origin', sha], cache);
  } catch {
    git(['fetch', 'origin'], cache);   // shallow fetch-by-sha unsupported on some servers
  }
  git(['reset', '--hard', sha], cache);
  return cache;
}

// ── Steps ───────────────────────────────────────────────────────────────────

function installDeps(bundleRoot) {
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['ci', '--omit=dev'], { cwd: bundleRoot, stdio: 'pipe' });
}

/** Delegate the whole deployment. Child process, not import — see D6a. */
function runSync(bundleRoot, target, { dryRun }) {
  const argv = [
    path.join(bundleRoot, 'scripts', 'sync-to-repos.mjs'),
    '--target-path', target,
    '--no-prompt',
    '--quiet-legacy-check',     // this process reports it, and can act on it
    ...(dryRun ? ['--dry-run'] : []),
  ];
  execFileSync(process.execPath, argv, { cwd: bundleRoot, stdio: 'inherit' });
}

/**
 * The D6b/D6c legacy-migration state machine.
 *
 * An install that deploys correct repo-scoped skills while leaving the stranded
 * `~/.claude/skills/**` tree in place has NOT fixed the reported bug — the shadow
 * is still there, with undefined precedence between discovered roots. So this
 * runs on every install.
 *
 * Ordering is sync-FIRST, migration-second: the correct copy must exist before
 * the shadowing one is removed, so an aborted run never leaves a repo with
 * neither.
 */
async function migrateLegacy(bundleRoot, target, { dryRun, interactive, ask }) {
  // `pathToFileURL`, not a bare path: Node's ESM loader rejects an absolute
  // Windows path outright ("Received protocol 'c:'"), so `import(path.join(...))`
  // would have thrown on every Windows install. Caught by the hermetic e2e —
  // which is precisely the class of defect source-only assertions cannot see.
  const { inspectLegacySurfaces, describeLegacySurfaces } = await import(
    pathToFileURL(path.join(bundleRoot, 'scripts', 'lib', 'install', 'legacy-surfaces.mjs')).href
  );

  let inspection;
  try {
    inspection = inspectLegacySurfaces({ repoRoot: target });
  } catch (err) {
    console.log(`  ${Y}⚠${X} could not inspect the retired skill surfaces: ${err.message}`);
    return;
  }

  if (inspection.overall === 'absent') return;

  console.log(`\n${B}Retired skill surfaces${X}`);
  for (const line of describeLegacySurfaces(inspection)) console.log(`  ${Y}•${X} ${line}`);
  console.log(`  ${D}These shadow the repo-scoped copy just installed, with undefined precedence.${X}`);

  const cleanupCmd =
    `node "${path.join(bundleRoot, 'scripts', 'install-skills.mjs')}" --uninstall-legacy --repo-root "${target}"`;

  if (inspection.overall === 'blocked') {
    // Never fails the install: the repo-scoped copy is still an improvement, and
    // refusing to install would withdraw a working fix to punish unrelated state.
    console.log(`  ${Y}Cannot clean automatically${X} — resolve the files above, then run:`);
    console.log(`  ${D}${cleanupCmd}${X}`);
    return;
  }

  if (dryRun) {
    console.log(`  ${Y}DRY RUN${X} — not removing anything. To clean up later:`);
    console.log(`  ${D}${cleanupCmd}${X}`);
    return;
  }

  if (!interactive) {
    // Deleting from $HOME without consent is not something an install may do,
    // and `--yes` means "don't prompt", not "you may delete my home directory".
    console.log(`  ${D}Non-interactive — not removing anything. To clean up:${X}`);
    console.log(`  ${D}${cleanupCmd}${X}`);
    return;
  }

  const answer = await ask(`  Remove the retired copies now? [Y/n] `);
  if (answer && !/^y(es)?$/i.test(answer.trim())) {
    console.log(`  ${D}Left in place. To clean up later: ${cleanupCmd}${X}`);
    return;
  }
  try {
    execFileSync(process.execPath, [
      path.join(bundleRoot, 'scripts', 'install-skills.mjs'),
      '--uninstall-legacy', '--repo-root', target,
    ], { cwd: bundleRoot, stdio: 'inherit' });
  } catch {
    console.log(`  ${Y}⚠${X} cleanup reported a problem — see above. Re-run: ${cleanupCmd}`);
  }
}

async function collectKeys(target, ask) {
  console.log(`\n${B}API keys${X}`);
  const envPath = path.join(target, '.env');
  let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  let changed = false;

  for (const k of KEYS) {
    if (new RegExp(`^${k.name}=`, 'm').test(env)) {
      console.log(`  ${G}✓${X} ${k.name} already set`);
      continue;
    }
    const label = k.req ? `${R}required${X}` : `${D}optional${X}`;
    const val = await ask(`  ${k.name} (${k.hint}, ${label}): `);
    if (val?.trim()) env += `\n${k.name}=${val.trim()}`;
    else {
      env += `\n# ${k.name}=  # ${k.hint}`;
      if (k.req) console.log(`  ${Y}⚠${X} required — set it before running audits`);
    }
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(envPath, env.trim() + '\n');
    console.log(`  ${G}✓${X} .env updated`);
  }
}

/**
 * The whole bootstrap, as one injectable function.
 *
 * `pkg` is a parameter so the hermetic e2e test can point the real code at a
 * fixture remote (D6d) without an env override existing in production.
 */
export async function bootstrap({
  pkg, target, dryRun = false, ref = null, interactive = false, ask = null,
  // Seams, injected ONLY by the hermetic end-to-end test:
  //   installDepsFn — `npm ci` needs a registry, so the offline suite substitutes
  //     a no-op. Everything else in the contract (ref->SHA, cache-origin
  //     validation, delegation args, sync-then-migrate order) runs for real.
  //   onStep — records the ORDER of the phases, because sync-before-migrate is
  //     invisible when both succeed and there is no other way to assert it.
  // Neither has a production caller, and neither can be reached from the CLI or
  // the environment — the bundle SOURCE remains un-overridable (D6d).
  installDepsFn = installDeps,
  onStep = () => {},
}) {
  const sourceUrl = bundleSource(pkg);

  const resolved = resolveRef(sourceUrl, ref);
  console.log(`  Source: ${sourceUrl}`);
  console.log(`  Version: ${resolved.label} @ ${resolved.sha.slice(0, 12)}`);

  const { withFileLock } = await import('./scripts/lib/file-lock.mjs')
    .catch(() => ({ withFileLock: null }));

  const doWork = async () => {
    const bundleRoot = acquireBundle(sourceUrl, resolved.sha);
    onStep('acquire', { bundleRoot, sha: resolved.sha });
    console.log(`  ${G}✓${X} bundle ready at ${bundleRoot}`);

    // BEFORE any target write, so a dependency failure leaves the target
    // completely untouched rather than half-deployed.
    installDepsFn(bundleRoot);
    onStep('deps');
    console.log(`  ${G}✓${X} dependencies installed`);

    console.log(`\n${B}Deploying${X}`);
    runSync(bundleRoot, target, { dryRun });
    onStep('sync');

    // AFTER the sync: the correct copy must exist before the shadowing one is
    // removed, so an aborted run never leaves a repo with neither.
    await migrateLegacy(bundleRoot, target, { dryRun, interactive, ask });
    onStep('migrate');

    if (!dryRun && interactive && ask) await collectKeys(target, ask);
    else if (!dryRun) console.log(`\n${D}Non-interactive — set API keys in ${path.join(target, '.env')}${X}`);

    return bundleRoot;
  };

  const lock = lockPath(cacheRoot());
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  // Signature is (lockPath, opts, fn) — the middle argument is NOT optional in
  // the sense of being omittable, and dropping it silently passes `doWork` as
  // `opts`, leaving `fn` undefined ("fn is not a function"). The clone + npm ci
  // can legitimately take a while, so allow more than the default wait.
  return withFileLock
    ? withFileLock(lock, { maxWaitMs: 120_000 }, doWork)
    : doWork();
}

async function main() {
  // Round-4 audit M3/M12: install.mjs is a top-level CLI entry point and the
  // repo-wide CLI_SMOKE_SET relocation-smoke contract requires this handler
  // on every one — even though install.mjs itself is never a MEMBER of
  // CLI_SMOKE_SET (it is the acquisition tool, not bundle content that gets
  // relocated into a consumer's scripts/.claude-skills/). Exits before ANY
  // network access, bundle acquisition, or install side effect — this only
  // proves install.mjs's OWN imports/paths survived wherever it is running
  // from, not the consumer-relocation property CLI_SMOKE_SET members prove.
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); return 0; }

  // Subcommand dispatch happens BEFORE parseArgs — that parser has no concept
  // of a subcommand and would otherwise consume the literal word "doctor" as
  // the install target positional.
  if (process.argv[2] === 'doctor') {
    let dargs;
    try {
      dargs = parseDoctorArgs(process.argv);
    } catch (err) {
      console.error(`${R}Error${X}: ${err.message}`);
      return 1;
    }
    if (dargs.help) { doctorUsage(); return 0; }

    const target = path.resolve(dargs.target || process.cwd());
    if (!fs.existsSync(target)) {
      console.error(`${R}✗${X} Directory not found: ${target}`);
      return 1;
    }
    // Same stdout-is-reserved-for-JSON reasoning as runDoctor's `say` — this
    // banner is progress narration, not the payload.
    const bannerOut = dargs.json ? process.stderr : process.stdout;
    bannerOut.write(`\n${B}══════════════════════════════════════════════════
  Claude Engineering Skills — Doctor
══════════════════════════════════════════════════${X}\n\n  Target: ${B}${target}${X}\n\n`);

    const pkg = JSON.parse(fs.readFileSync(path.join(SELF_DIR, 'package.json'), 'utf-8'));
    return runDoctor({
      pkg, target, ref: dargs.ref, json: dargs.json, gate: dargs.gate, only: dargs.only,
    });
  }

  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(`${R}Error${X}: ${err.message}`);
    return 1;
  }
  if (args.help) { usage(); return 0; }

  console.log(`
${B}══════════════════════════════════════════════════
  Claude Engineering Skills — Install
══════════════════════════════════════════════════${X}
`);

  const interactive = isInteractive(args);
  const { rl, ask } = interactive ? createPrompter() : { rl: null, ask: null };

  try {
    let target = args.target;
    if (!target) {
      if (!interactive) {
        console.error(`${R}Error${X}: a target directory is required.`);
        console.error('  Usage: npx github:Lbstrydom/claude-engineering-skills <target-repo>');
        return 1;
      }
      target = await ask('  Target repo directory: ');
    }
    target = path.resolve(String(target).trim());
    if (!fs.existsSync(target)) {
      console.error(`${R}✗${X} Directory not found: ${target}`);
      return 1;
    }
    console.log(`  Target: ${B}${target}${X}`);
    if (args.dryRun) console.log(`  ${Y}DRY RUN — nothing will be written${X}`);

    const pkg = JSON.parse(fs.readFileSync(path.join(SELF_DIR, 'package.json'), 'utf-8'));
    await bootstrap({ pkg, target, dryRun: args.dryRun, ref: args.ref, interactive, ask });

    console.log(`
${B}══════════════════════════════════════════════════
  ${args.dryRun ? 'Dry run complete' : '✓ Installed'}
══════════════════════════════════════════════════${X}

  ${D}Plan:${X}        /plan <description>
  ${D}Audit:${X}       /audit-code docs/plans/<name>.md
  ${D}Full cycle:${X}  /cycle <description>

  ${D}Update later — same command:${X}
    npx github:Lbstrydom/claude-engineering-skills ${target}
`);
    return 0;
  } finally {
    rl?.close();
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`
  || import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`;

if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`${R}Install failed${X}: ${err.message}`);
      if (process.env.DEBUG) console.error(err.stack);
      process.exit(1);
    });
}
