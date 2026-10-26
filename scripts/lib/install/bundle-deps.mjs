/**
 * @fileoverview Read the bundle's own npm-dependency declaration, and report on it.
 *
 * The WRITE half lives in `scripts/generate-bundle-deps.mjs`, which is
 * source-repo-only because it walks the consumer registry. This half syncs: it
 * is what lets `check-setup.mjs` answer "is every package this bundle imports
 * actually installed here?" in a consumer, where the derived set
 * (`bundleDeps()` in `./deps.mjs`) is unreachable by construction.
 *
 * Deliberately imports NOTHING source-only — no `./deps.mjs`, no
 * `../sync-inventory.mjs`. The curated optional set and the generated-spec
 * allowlist are INJECTED by the generator rather than imported here, because
 * importing either would drag the consumer registry into every consumer's
 * bundle through the closure walk.
 *
 * @module scripts/lib/install/bundle-deps
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

import { detectPackageManager, displayAddDev } from '../package-manager.mjs';
import { sanitizeGitEnv } from '../git-env-sanitize.mjs';

/** Bundle-relative location. Lives beside the other `lib/` assets in both layouts. */
export const BUNDLE_DEPS_FILENAME = 'bundle-deps.json';
export const BUNDLE_DEPS_RELATIVE_PATH = `scripts/lib/${BUNDLE_DEPS_FILENAME}`;

/**
 * Read the declaration from a bundle, in EITHER layout.
 *
 * Callers resolve it relative to their OWN location, so one call works at
 * `scripts/` (source) and `scripts/.claude-skills/` (consumer).
 *
 * Returns null when absent or malformed — an older bundle predates this file,
 * and that must degrade to "cannot check" rather than "nothing to check".
 *
 * @param {string} scriptsDir directory holding the CLI doing the reading
 * @returns {{packages: Array<{name: string, required: boolean, importers: string[]}>,
 *   generatedSpecPackages?: {packages: string[]}}|null}
 */
export function readBundleDeps(scriptsDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(scriptsDir, 'lib', BUNDLE_DEPS_FILENAME), 'utf-8'));
    return Array.isArray(raw?.packages) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Is `pkg` resolvable from `repoRoot`?
 *
 * **Probe by RESOLUTION, never by `<repoRoot>/node_modules/<pkg>`.** That path
 * test is right for `ensureAuditDeps`, which is deciding what to install into a
 * main checkout. It is wrong for a health check: a linked worktree has no
 * `node_modules` of its own and inherits the main checkout's by node's own
 * walk-up, so the path test reported 13 of 16 packages missing on an install
 * where every one of them imports fine (measured 2026-09-07 — check-setup's
 * Browser section resolved `playwright` in the same run this called it absent).
 * `createRequire` asks the question node itself asks. pnpm needs no adjustment:
 * every dep here is direct, and pnpm resolves direct dependencies normally.
 *
 * A resolution error that is NOT `MODULE_NOT_FOUND` means the package was found
 * and only a subpath was refused (an `exports` map without `./package.json`),
 * which is presence, not absence.
 */
export function makeInstalledProbe(repoRoot) {
  const requireFrom = createRequire(path.join(repoRoot, 'bundle-deps-probe.cjs'));
  return (pkg) => {
    try { requireFrom.resolve(pkg); return true; }
    catch (err) { return err?.code !== 'MODULE_NOT_FOUND'; }
  };
}

/**
 * Report the install state of every declared package into a check-setup report.
 *
 * **Why this exists at all.** Until 2026-09-07 that health check special-cased
 * exactly ONE dependency — playwright — and the comment justifying that makes
 * the general argument itself: leaving it to the runners made the check
 * "structurally unable to report the one dependency four skills cannot run
 * without". The reasoning covers the other fifteen, and it did not cover them:
 * check-setup exited 0 on an install missing `ts-morph` (upstream ea23dfda).
 *
 * @param {{section: Function, pass: Function, warn: Function, fail: Function}} report
 * @param {string} repoRoot the repo being checked
 * @param {string} scriptsDir where the calling CLI lives
 * @param {{installed?: (pkg: string) => boolean, assessDeclared?: typeof assessDeclaredBundleDeps}} [io] injected for tests
 */
export function checkBundleDependencies(report, repoRoot, scriptsDir, io = {}) {
  report.section('Bundle dependencies');
  const declared = readBundleDeps(scriptsDir);
  if (!declared) {
    report.warn(
      'bundle-deps.json not found',
      'this bundle predates the dependency declaration — the install cannot be verified',
      'Re-sync from claude-engineering-skills to pick it up.');
    return;
  }
  const installed = io.installed ?? makeInstalledProbe(repoRoot);
  const missingRequired = declared.packages.filter((p) => p.required && !installed(p.name));
  const missingOptional = declared.packages.filter((p) => !p.required && !installed(p.name));
  const pm = detectPackageManager(repoRoot).name;

  if (missingRequired.length) {
    report.fail(
      `${missingRequired.length} required package(s) missing`,
      // Name an importer, so the report answers "why does this bundle need it?"
      // rather than asserting a need the reader has to take on faith.
      missingRequired.map((p) => `${p.name} (imported by ${p.importers[0]}${p.importers.length > 1 ? ` +${p.importers.length - 1} more` : ''})`).join(', '),
      displayAddDev(pm, missingRequired.map((p) => p.name), repoRoot));
  } else {
    report.pass('Required packages', `${declared.packages.filter((p) => p.required).length} present`);
  }

  if (missingOptional.length) {
    report.warn(
      `${missingOptional.length} optional package(s) missing`,
      `${missingOptional.map((p) => p.name).join(', ')} — features degrade, imports still resolve`,
      displayAddDev(pm, missingOptional.map((p) => p.name), repoRoot));
  }

  // PRESENT is not DECLARED (proposal d93e). A hoisted or hand-installed copy satisfies every probe above, and the next install may
  // drop it - the sync has always only WARNED on this, in a block that scrolls past. The doctor is where it must be a verdict: a
  // required package the consumer's package.json does not durably declare FAILS, with the exact command for its package manager.
  const assess = io.assessDeclared ?? assessDeclaredBundleDeps;
  const decl = assess(repoRoot, scriptsDir);
  if (!decl.measured) {
    // Unmeasurable is SAID, never a pass.
    report.warn('Declared bundle packages not checked', decl.reason, 'Run from a repo with a readable package.json and the synced bundle-deps.json.');
  } else {
    const wanted = [...decl.undeclared, ...decl.optionalOnly];
    const importerOf = (p) => `${p.name} (imported by ${p.importer ?? 'the bundle'})`;
    if (wanted.length) {
      report.fail(
        `${wanted.length} required package(s) not declared in package.json`,
        `${wanted.map(importerOf).join(', ')} - present only if hoisted or hand-installed, and the next install may drop them`
          + `${decl.optionalOnly.length ? ` (${decl.optionalOnly.length} sit in optionalDependencies, which tolerates omission)` : ''}`,
        decl.command ?? decl.pmNote ?? `declare ${wanted.map((p) => p.name).join(', ')} as devDependencies`);
    }
    if (decl.uncommitted.length) {
      report.warn(
        `${decl.uncommitted.length} required package(s) declared but not committed`,
        `${decl.uncommitted.map((p) => p.name).join(', ')} - ${decl.committedKnown ? 'commit package.json and the lockfile' : 'HEAD could not be read'}`);
    }
    if (!wanted.length && !decl.uncommitted.length) {
      report.pass('Declared bundle packages', `package.json declares all ${decl.required} required packages`);
    }
  }

  // A DIFFERENT claim, reported separately: nothing in the bundle imports these,
  // the specs /ux-lock GENERATES do. Absent is only a problem for a consumer
  // that runs those specs, so this informs rather than warns.
  const spec = declared.generatedSpecPackages?.packages ?? [];
  if (spec.length) {
    const specMissing = spec.filter((p) => !installed(p));
    report.pass(
      'Generated-spec packages',
      specMissing.length
        ? `${spec.length - specMissing.length}/${spec.length} present — ${specMissing.join(', ')} needed only to RUN the specs /ux-lock generates (${displayAddDev(pm, specMissing, repoRoot)})`
        : `${spec.length}/${spec.length} present`);
  }
}

// ── Declaration, not presence ───────────────────────────────────────────────
//
// THE GAP THIS CLOSES (2026-10-13). `picomatch` became a REQUIRED bundle
// package (importer lib/glob.mjs) and nothing told storyline at sync time; two
// of its chips crashed on `Cannot find package 'picomatch'` and the package was
// hand-installed. Every existing probe stayed green, for one shared reason:
// each asks whether the package is PRESENT (`ensureAuditDeps`: a
// `node_modules/<pkg>/package.json` path; `checkBundleDependencies` above:
// `require.resolve`). A transitively hoisted or hand-installed copy satisfies
// both, so nothing is installed and nothing is declared — until a dependency
// upgrade drops the transitive copy, or pnpm prunes the undeclared one on its
// next install. Measured that day: storyline, wine-cellar-app and ai-organiser
// all import picomatch without declaring it.
//
// The durable question is the consumer's own manifest: does `package.json`
// declare it, and is that declaration COMMITTED? Reported, never installed —
// the remedy edits a consumer-owned manifest and lockfile with the consumer's
// own package manager.

/** Sections that make a package part of every install of this repo. */
const DURABLE_SECTIONS = ['dependencies', 'devDependencies'];

/**
 * EFFECTIVE declaration, not section membership: npm documents that an
 * `optionalDependencies` entry OVERRIDES a same-name `dependencies` entry, so a
 * package listed in both is still optional and never durable (code-audit H9).
 */
const sectionsOf = (pkg, name) => {
  const optional = Object.hasOwn(pkg?.optionalDependencies ?? {}, name);
  return { optional, durable: !optional && DURABLE_SECTIONS.some((k) => Object.hasOwn(pkg?.[k] ?? {}, name)) };
};

/**
 * The consumer's COMMITTED `package.json`, read from git.
 *
 * `HEAD:./package.json` — the `./` makes git resolve the path relative to
 * `cwd`, so a consumer that is a sub-package of a larger repository reads ITS
 * manifest, not the top-level one. `sanitizeGitEnv` strips `GIT_DIR` /
 * `GIT_WORK_TREE`: the sync runs inside the source repo's pre-push hook, where
 * git exports both and they outrank `cwd` — read naively, this would answer
 * with the SOURCE repo's manifest. Any failure is `known:false`, never a
 * fallback to some other repository's data.
 *
 * @param {string} repoRoot
 * @returns {{known: true, pkg: object} | {known: false}}
 */
export function readCommittedPackageJson(repoRoot) {
  try {
    const text = execFileSync('git', ['show', 'HEAD:./package.json'], {
      cwd: repoRoot, env: sanitizeGitEnv(repoRoot), encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 15_000,
    });
    return { known: true, pkg: JSON.parse(text) };
  } catch {
    return { known: false };
  }
}

/**
 * Which REQUIRED bundle packages does the consumer fail to declare durably?
 *
 * The WORKING-TREE manifest decides the obligation (it is what the next install
 * reads); HEAD is only evidence that the declaration will reach another
 * checkout. Per required package, first matching row wins:
 *
 *   | working tree  | HEAD                                     | bucket       |
 *   |---------------|------------------------------------------|--------------|
 *   | deps/devDeps  | deps/devDeps                             | clean        |
 *   | deps/devDeps  | absent / optional-only / unreadable      | uncommitted  |
 *   | optional      | any                                      | optionalOnly |
 *   | absent        | any (incl. declared — a pending removal) | undeclared   |
 *
 * "optional" means listed in `optionalDependencies`, WHETHER OR NOT it is also
 * in deps/devDeps — the optional entry wins (see `sectionsOf`). Optional
 * tolerates omission and install failure, which is what `required: true` rules
 * out, so it is never clean. `peerDependencies` does not
 * count at all: a peer entry is a requirement on a host, not an install here.
 *
 * Unmeasurable is SAID (`measured:false` + reason), never a zero.
 *
 * @param {string} repoRoot — the consumer
 * @param {string} scriptsDir — the bundle whose bundle-deps.json is the obligation
 * @param {{readCommitted?: (repoRoot: string) => ({known: true, pkg: object}|{known: false})}} [io]
 */
export function assessDeclaredBundleDeps(repoRoot, scriptsDir, { readCommitted = readCommittedPackageJson } = {}) {
  const declared = readBundleDeps(scriptsDir);
  if (!declared) return { measured: false, reason: `${BUNDLE_DEPS_RELATIVE_PATH} is missing or unreadable in the bundle` };
  const pkgPath = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return { measured: false, reason: 'no package.json' };
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); } catch (err) {
    return { measured: false, reason: `package.json does not parse (${err.message})` };
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return { measured: false, reason: 'package.json is not a JSON object' };

  const committed = readCommitted(repoRoot);
  const required = declared.packages.filter((p) => p.required);
  const undeclared = [];
  const optionalOnly = [];
  const uncommitted = [];
  for (const p of required) {
    const item = { name: p.name, importer: p.importers?.[0] ?? null };
    const wt = sectionsOf(pkg, p.name);
    if (wt.durable) {
      if (!committed.known || !sectionsOf(committed.pkg, p.name).durable) uncommitted.push(item);
    } else if (wt.optional) optionalOnly.push(item);
    else undeclared.push(item);
  }

  // The remedy command comes from the package-manager oracle, never a guess:
  // an ambiguous or mis-declared manager gets no command at all.
  const pm = detectPackageManager(repoRoot);
  const toAdd = [...undeclared, ...optionalOnly].map((p) => p.name);
  const unsure = pm.ambiguous || pm.invalidDeclaration;
  return {
    measured: true,
    required: required.length,
    undeclared, optionalOnly, uncommitted,
    committedKnown: committed.known,
    command: toAdd.length && !unsure ? displayAddDev(pm.name, toAdd, repoRoot) : null,
    pmNote: !unsure ? null
      : pm.ambiguous
        ? `package manager is ambiguous (${pm.candidates.join(', ')}) — declare them with the one this repo uses`
        : 'package.json "packageManager" is unrecognised — fix it, then declare them with that manager',
  };
}

/**
 * Render an assessment as sync-output lines plus a one-line summary for the
 * end-of-run block. `summary` is null ONLY for a measured, fully clean result.
 *
 * @param {ReturnType<typeof assessDeclaredBundleDeps>} r
 * @param {{Y?: string, D?: string, X?: string}} [colors]
 * @returns {{lines: string[], summary: string|null}}
 */
export function formatUndeclaredBundleDeps(r, { Y = '', D = '', X = '' } = {}) {
  if (!r.measured) {
    return {
      lines: [`  ${Y}⚠ could not check which required bundle packages package.json declares${X} ${D}(${r.reason})${X}`],
      summary: `not checked — ${r.reason}`,
    };
  }
  const MAX = 20;
  const list = (items) => [
    ...items.slice(0, MAX).map((p) => `    - ${p.name} ${D}(imported by ${p.importer ?? 'the bundle'})${X}`),
    ...(items.length > MAX ? [`    ${D}… +${items.length - MAX} more${X}`] : []),
  ];
  const names = (items) => items.map((p) => p.name).join(', ');
  const lines = [];
  const parts = [];
  if (r.undeclared.length) {
    lines.push(`  ${Y}⚠ package.json does not declare ${r.undeclared.length} required bundle package(s)${X} `
      + `${D}— any copy present is hoisted or hand-installed, and the next install may drop it${X}`,
    ...list(r.undeclared));
    parts.push(names(r.undeclared));
  }
  if (r.optionalOnly.length) {
    lines.push(`  ${Y}⚠ ${r.optionalOnly.length} required bundle package(s) declared in optionalDependencies${X} `
      + `${D}— optional overrides any same-name dependencies entry and its install may be skipped; move them to devDependencies only${X}`,
    ...list(r.optionalOnly));
    parts.push(`${names(r.optionalOnly)} (optional-only)`);
  }
  if (r.command) lines.push(`    ${D}declare them as devDependencies:${X} ${r.command}`);
  else if (r.pmNote && (r.undeclared.length || r.optionalOnly.length)) lines.push(`    ${D}${r.pmNote}${X}`);
  // The only importers live in the gitignored tooling tree, so a dead-code tool
  // that scans package.json (knip, depcheck) reports the new declaration as
  // unused (wine-cellar-app hit this; it keeps a "synced tooling" ignore group).
  if (r.undeclared.length || r.optionalOnly.length) {
    lines.push(`    ${D}and add them to your knip/depcheck ignore list (e.g. knip ignoreDependencies) — their only importers are in the gitignored synced tooling tree (its lib/${BUNDLE_DEPS_FILENAME} lists them)${X}`);
  }
  if (r.uncommitted.length) {
    lines.push(`  ${Y}⚠ ${r.uncommitted.length} required bundle package(s) declared in the working tree but not in the committed package.json${X} `
      + `${D}— ${r.committedKnown ? 'commit package.json and the lockfile' : 'HEAD could not be read, so the declaration is not known to be committed'}${X}`,
    ...list(r.uncommitted));
    parts.push(`${names(r.uncommitted)} (uncommitted)`);
  }
  if (!parts.length) {
    return { lines: [`  ${D}✓ package.json declares all ${r.required} required bundle packages${X}`], summary: null };
  }
  return { lines, summary: parts.join('; ') };
}

/**
 * The one entry point the sync calls: assess, then format.
 *
 * @param {string} repoRoot
 * @param {string} scriptsDir
 * @param {{Y?: string, D?: string, X?: string}} [colors]
 */
export function reportDeclaredBundleDeps(repoRoot, scriptsDir, colors) {
  return formatUndeclaredBundleDeps(assessDeclaredBundleDeps(repoRoot, scriptsDir), colors);
}
