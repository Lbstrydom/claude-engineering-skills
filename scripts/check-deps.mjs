#!/usr/bin/env node
/**
 * @fileoverview Pre-flight dependency check for audit-loop scripts.
 *
 * Validates that required npm packages are installed and API keys are set.
 * Run before `openai-audit.mjs` or `gemini-review.mjs` to surface setup
 * issues early with clear remediation steps.
 *
 * Usage:
 *   node scripts/check-deps.mjs           # Human-readable output
 *   node scripts/check-deps.mjs --json    # Machine-readable JSON
 *   node scripts/check-deps.mjs --fix     # Attempt to install missing packages
 *
 * Environment comes from the canonical loader (`lib/load-env.mjs`): the shell,
 * then the repo's `.env` (found from any subdirectory or linked worktree), then
 * the shared `~/.audit-loop.env` — the layering every other entry point sees,
 * so "is OPENAI_API_KEY set?" here answers what the audit itself will see.
 *
 * `--fix` is judged by RE-PROBING `node_modules` after the install, never by
 * the installer's exit code, and the report (human or `--json`) is the
 * post-fix state. A fix that leaves anything it tried to install still
 * missing exits non-zero.
 */
import './lib/load-env.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertKnownFlags, ArgvError, finishAndExit } from './lib/cli-io.mjs';
import {
  detectPackageManager, packageManagerInvocation, displayCommand,
} from './lib/package-manager.mjs';
import { installTimeouts, isInstallTimeout, isInstalledPackage } from './lib/install/deps.mjs';

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m';

/**
 * Required packages — the audit loop won't function without these.
 * Each entry: [package-name, what-needs-it, is-required]
 */
const REQUIRED_PACKAGES = [
  ['openai', 'GPT-5.4 auditor (openai-audit.mjs)', true],
  ['zod', 'Schema validation', true],
  ['dotenv', 'Environment variable loading', true],
  ['picomatch', 'Glob matching (lib/glob.mjs: --exclude-paths, fleet claims, budgets)', true],
];

/**
 * Optional packages — audit runs without them but with reduced capability.
 */
const OPTIONAL_PACKAGES = [
  ['@google/genai', 'Gemini final review + brief generation', 'GEMINI_API_KEY'],
  ['@anthropic-ai/sdk', 'Claude Opus fallback for Gemini', 'ANTHROPIC_API_KEY'],
  ['pg', 'Cloud learning store (Postgres driver)', 'AUDIT_DB_URL'],
  ['proper-lockfile', 'Atomic writes for debt ledger', null],
];

/**
 * Environment variables — checked but not required (graceful degradation).
 */
const ENV_VARS = [
  ['OPENAI_API_KEY', 'GPT-5.4 auditor', true],
  ['GEMINI_API_KEY', 'Gemini final review (Step 7)', false],
  ['ANTHROPIC_API_KEY', 'Claude Opus fallback', false],
  ['AUDIT_DB_URL', 'Cloud learning store (Postgres DSN)', false],
];

const KNOWN_FLAGS = ['--json', '--fix'];

/**
 * Is `pkg` installed anywhere Node would find it from `fromDir`?
 *
 * Walks the `node_modules` chain Node's resolver walks (a linked worktree with
 * no `node_modules` of its own resolves from the main checkout's), asking each
 * level the shared {@link isInstalledPackage} question. A filesystem probe
 * rather than `require.resolve`, because ONE predicate has to answer both
 * before and after an in-process install, and a resolver is not obliged to
 * re-read a tree it has already looked at.
 *
 * @param {string} pkg
 * @param {string} fromDir
 * @returns {boolean}
 */
export function isPackageReachable(pkg, fromDir) {
  let dir = path.resolve(fromDir);
  for (;;) {
    if (path.basename(dir) !== 'node_modules'
      && isInstalledPackage(path.join(dir, 'node_modules'), pkg)) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * The package root an install must target: the nearest `package.json` at or
 * above the script — the tree the probe reads. Never `cwd`: installing into a
 * tree the probe does not read can only ever look like a failed fix.
 *
 * @param {string} fromDir
 * @returns {string|null}
 */
export function findPackageRoot(fromDir) {
  let dir = path.resolve(fromDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Probe packages + env. Called again after `--fix` so the report is the
 * post-install truth, not the snapshot that queued the install.
 *
 * @param {{probeDir: string, env?: NodeJS.ProcessEnv}} opts
 */
export function probeDeps({ probeDir, env = process.env }) {
  const results = { required: [], optional: [], env: [], allOk: true };

  for (const [pkg, purpose, required] of REQUIRED_PACKAGES) {
    const installed = isPackageReachable(pkg, probeDir);
    results.required.push({ package: pkg, installed, purpose, required });
    if (!installed) results.allOk = false;
  }

  for (const [pkg, purpose, envGate] of OPTIONAL_PACKAGES) {
    const installed = isPackageReachable(pkg, probeDir);
    const envSet = envGate ? !!env[envGate] : true;
    results.optional.push({ package: pkg, installed, purpose, envGate, envSet });
  }

  for (const [key, purpose, required] of ENV_VARS) {
    const set = !!env[key];
    results.env.push({ key, set, purpose, required });
    if (required && !set) results.allOk = false;
  }
  return results;
}

/**
 * Packages `--fix` should install: every missing required package, plus each
 * missing optional one whose feature is actually wanted (its env gate is set,
 * or it has none).
 *
 * @param {ReturnType<typeof probeDeps>} results
 * @returns {string[]}
 */
export function packagesToFix(results) {
  return [
    ...results.required.filter(r => !r.installed).map(r => r.package),
    ...results.optional
      .filter(r => !r.installed && (r.envSet || !r.envGate))
      .map(r => r.package),
  ];
}

/**
 * Default installer: the manager's own JS entry under this node, no shell.
 *
 * The child's stdout goes to OUR stderr (fd 2), never our stdout: stdout is
 * the report channel, and under `--json --fix` a package manager's progress
 * lines ahead of the JSON would make the output unparseable.
 *
 * @param {string} pm
 * @param {string[]} args
 * @param {{cwd: string, timeoutMs: number,
 *   invocation?: ReturnType<typeof packageManagerInvocation>}} opts
 *   `invocation` is injectable so a test can stand in a noisy fake manager.
 */
export function execInstall(pm, args, { cwd, timeoutMs, invocation = packageManagerInvocation(pm) }) {
  const { bin, prefix, shell } = invocation;
  execFileSync(bin, [...prefix, ...args], {
    cwd, stdio: ['ignore', 2, 'inherit'], timeout: timeoutMs, shell,
  });
}

/**
 * Restore missing packages with the repo's OWN package manager, then decide
 * the outcome by re-probing — never by the exit code (pnpm exits non-zero on
 * `ERR_PNPM_IGNORED_BUILDS` after a complete install; a cap-kill may already
 * have landed every package; a clean exit can still leave one absent).
 *
 * Runs a plain `<pm> install`: every package checked here is declared in
 * `package.json`, so "missing" means the declared tree was never restored.
 * The old `npm install <pkg>` re-resolved to the newest release and rewrote
 * the manifest, which would silently replace an exact pin (zod is pinned for
 * its v4 API) with a caret range.
 *
 * Automated install is npm/pnpm only, matching `ensureAuditDeps`: those are
 * the managers whose `node_modules` layout the probe can verify. An ambiguous
 * or invalid declaration is handed back, never guessed.
 *
 * @param {{wanted: string[], root: string|null, probeDir: string,
 *   install?: typeof execInstall, timeoutMs?: number}} opts
 * @returns {{outcome: 'fixed'|'partial'|'failed'|'refused', root: string|null,
 *   packageManager: string|null, command: string|null, attempted: string[],
 *   stillMissing: string[], timedOut: boolean, error: string|null, reason?: string}}
 */
export function fixMissing({
  wanted, root, probeDir, install = execInstall,
  timeoutMs = installTimeouts().requiredMs,
}) {
  const refuse = (packageManager, reason, command = null) => ({
    outcome: 'refused', root, packageManager, command, attempted: [],
    stillMissing: [...wanted], timedOut: false, error: null, reason,
  });
  if (!root) return refuse(null, 'no package.json at or above the script — nothing to install into');

  const pm = detectPackageManager(root);
  if (pm.invalidDeclaration) {
    return refuse(pm.name, 'package.json "packageManager" field is present but unrecognised — not guessing');
  }
  if (pm.ambiguous) {
    return refuse(pm.name,
      `multiple lockfiles (${pm.candidates.join(', ')}) and no "packageManager" field — not guessing`);
  }
  const command = displayCommand(pm.name, ['install']);
  if (pm.name !== 'npm' && pm.name !== 'pnpm') {
    return refuse(pm.name, `automated install supports npm/pnpm only — run it yourself: ${command}`, command);
  }

  let err = null;
  try {
    install(pm.name, ['install'], { cwd: root, timeoutMs });
  } catch (e) {
    err = e;
  }
  const stillMissing = wanted.filter(p => !isPackageReachable(p, probeDir));
  let outcome = 'fixed';
  if (stillMissing.length === wanted.length) outcome = 'failed';
  else if (stillMissing.length > 0) outcome = 'partial';
  return {
    outcome, root, packageManager: pm.name, command, attempted: [...wanted], stillMissing,
    timedOut: isInstallTimeout(err),
    error: err ? String(err.message || err).split('\n')[0].slice(0, 300) : null,
  };
}

/** The hand-typed restore command, in the repo's own package manager. */
function remedyCommand(scriptDir) {
  const root = findPackageRoot(scriptDir);
  const pm = root ? detectPackageManager(root) : null;
  if (!pm || pm.ambiguous || pm.invalidDeclaration) return 'install with your package manager';
  return displayCommand(pm.name, ['install']);
}

/**
 * The whole CLI as a function of its inputs, so a test can drive `--fix` with
 * a fake installer. Returns the exit code; the caller owns exiting.
 *
 * @param {{argv?: string[], scriptDir?: string, env?: NodeJS.ProcessEnv,
 *   install?: typeof execInstall, out?: (s: string) => void,
 *   err?: (s: string) => void}} [opts]
 * @returns {number}
 */
export function run({
  argv = process.argv.slice(2), scriptDir = import.meta.dirname, env = process.env,
  install, out = (s) => process.stdout.write(`${s}\n`),
  err = (s) => process.stderr.write(`${s}\n`),
} = {}) {
  assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'check-deps', from: 0 });
  // Modes are read from the SAME span assertKnownFlags validated: it stops at
  // the POSIX `--` terminator, so `-- --fix` must not run an install.
  const end = argv.indexOf('--');
  const flags = end === -1 ? argv : argv.slice(0, end);
  const jsonMode = flags.includes('--json');
  const fixMode = flags.includes('--fix');

  let results = probeDeps({ probeDir: scriptDir, env });
  let fix = null;

  const wanted = packagesToFix(results);
  if (fixMode && wanted.length > 0) {
    err(`${D}Installing: ${wanted.join(' ')}${X}`);
    fix = fixMissing({
      wanted, root: findPackageRoot(scriptDir), probeDir: scriptDir,
      ...(install ? { install } : {}),
    });
    // Everything reported below is the POST-fix state.
    results = probeDeps({ probeDir: scriptDir, env });
    if (fix.outcome === 'refused') {
      err(`${R}Not installing${X}: ${fix.reason}`);
    } else if (fix.outcome === 'fixed') {
      err(`${G}✓ Installed and verified present${X} via ${fix.packageManager}`);
      if (fix.timedOut) err(`  ${Y}○${X} install exceeded its cap, but every package verified present`);
      else if (fix.error) err(`  ${Y}○${X} ${fix.packageManager} reported: ${fix.error}`);
    } else {
      const why = fix.timedOut
        ? 'install exceeded its cap and was killed (raise AUDIT_DEPS_INSTALL_TIMEOUT_MS)'
        : (fix.error || 'packages absent after install');
      err(`${R}Install ${fix.outcome}${X}: ${why}`);
      err(`  Still missing: ${fix.stillMissing.join(', ')}`);
      err(`  Try manually: cd ${fix.root} && ${fix.command}`);
    }
  }

  const code = results.allOk && (fix === null || fix.outcome === 'fixed') ? 0 : 1;

  if (jsonMode) {
    out(JSON.stringify(fix ? { ...results, fix } : results, null, 2));
    return code;
  }

  out(`\n${D}Audit-loop dependency check${X}\n`);

  out('Required packages:');
  const missingRequired = [];
  for (const r of results.required) {
    const icon = r.installed ? `${G}✓${X}` : `${R}✗${X}`;
    out(`  ${icon} ${r.package} — ${r.purpose}`);
    if (!r.installed) missingRequired.push(r.package);
  }

  out('\nOptional packages:');
  const missingOptional = [];
  for (const r of results.optional) {
    const icon = r.installed ? `${G}✓${X}` : `${Y}○${X}`;
    const note = !r.installed && r.envGate && !r.envSet
      ? ` ${D}(${r.envGate} not set — not needed)${X}`
      : !r.installed ? ` ${Y}(missing — ${r.purpose} will degrade)${X}` : '';
    out(`  ${icon} ${r.package} — ${r.purpose}${note}`);
    if (!r.installed && (r.envSet || !r.envGate)) missingOptional.push(r.package);
  }

  out('\nEnvironment:');
  for (const r of results.env) {
    const icon = r.set ? `${G}✓${X}` : r.required ? `${R}✗${X}` : `${Y}○${X}`;
    const note = !r.set && !r.required ? ` ${D}(optional)${X}` : '';
    out(`  ${icon} ${r.key} — ${r.purpose}${note}`);
  }

  out('');
  if (missingRequired.length > 0) {
    out(`${R}Missing required packages:${X} ${missingRequired.join(', ')}`);
  }
  if (missingOptional.length > 0) {
    out(`${Y}Missing optional packages:${X} ${missingOptional.join(', ')}`);
  }
  if (missingRequired.length > 0 || missingOptional.length > 0) {
    out(`  Run: ${remedyCommand(scriptDir)}  (or: node scripts/check-deps.mjs --fix)`);
  }
  if (fix && fix.outcome !== 'fixed') {
    out(`${R}--fix did not complete${X} (${fix.outcome}) — see above`);
  }

  if (code === 0) out(`${G}All checks passed${X} — ready to run audit-loop`);
  return code;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  let code;
  try {
    code = run();
  } catch (e) {
    if (e instanceof ArgvError || e?.code === 'ARGV_ERROR') {
      process.stderr.write(`${e.message}\n`);
      code = 2;
    } else {
      process.stderr.write(`check-deps: ${e?.stack || e}\n`);
      code = 1;
    }
  }
  await finishAndExit(code);
}
