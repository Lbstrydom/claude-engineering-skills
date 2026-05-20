/**
 * @fileoverview Shape detection for the skills fit-check diagnostic.
 *
 * Pure filesystem inspection — no LLM, no network, no Supabase. Synchronous
 * by design so the CLI can finish in <2s on cold start.
 *
 * Returns a ShapeProfile describing what the rules module then matches
 * against to label each skill FITS / PARTIAL / MISMATCH.
 *
 * @module scripts/lib/fit-check/detect
 */

import fs from 'node:fs';
import path from 'node:path';
import { detectRepoStack } from '../repo-stack.mjs';

/**
 * Framework signature → label. Order matters — first match wins, so the
 * most-specific framework signatures (Obsidian plugin via manifest.json)
 * come before the generic ones (any package.json + react = react-spa).
 *
 * Each entry: { label, requires: string[] (filesystem markers that must
 * ALL exist), pkgSignals?: (pkg) => boolean (extra package.json check) }.
 * `label` is the framework name surfaced in the ShapeProfile.
 */
const FRAMEWORK_RULES = [
  // Obsidian plugin — manifest.json with minAppVersion is the unambiguous
  // signal. Must come before any package.json-based detection because some
  // plugin repos also have a vite/esbuild config that would otherwise win.
  {
    label: 'obsidian-plugin',
    test: (cwd) => hasJsonMarker(cwd, 'manifest.json', (m) => typeof m.minAppVersion === 'string'),
  },
  { label: 'nextjs',  test: (cwd) => existsAny(cwd, ['next.config.js', 'next.config.mjs', 'next.config.ts']) || pkgHas(cwd, 'next') },
  { label: 'remix',   test: (cwd) => existsAny(cwd, ['remix.config.js', 'remix.config.mjs']) || pkgHas(cwd, '@remix-run/react') },
  { label: 'astro',   test: (cwd) => existsAny(cwd, ['astro.config.js', 'astro.config.mjs', 'astro.config.ts']) || pkgHas(cwd, 'astro') },
  { label: 'sveltekit', test: (cwd) => existsAny(cwd, ['svelte.config.js']) && pkgHas(cwd, '@sveltejs/kit') },
  { label: 'nuxt',    test: (cwd) => existsAny(cwd, ['nuxt.config.js', 'nuxt.config.ts']) || pkgHas(cwd, 'nuxt') },
  { label: 'vite-spa', test: (cwd) => existsAny(cwd, ['vite.config.js', 'vite.config.mjs', 'vite.config.ts']) || pkgHas(cwd, 'vite') },
  { label: 'express', test: (cwd) => pkgHas(cwd, 'express') },
  { label: 'fastify', test: (cwd) => pkgHas(cwd, 'fastify') },
  { label: 'fastapi', test: (cwd) => pyDepHas(cwd, 'fastapi') },
  { label: 'django',  test: (cwd) => pyDepHas(cwd, 'django') || existsAny(cwd, ['manage.py']) },
  { label: 'flask',   test: (cwd) => pyDepHas(cwd, 'flask') },
];

/**
 * Detect the shape of an adopter's repo.
 *
 * @param {string} cwd — absolute path to the repo root
 * @returns {ShapeProfile}
 *
 * @typedef {object} ShapeProfile
 * @property {'js-ts'|'python'|'mixed'|'unknown'} stack
 * @property {string|null} pythonFramework
 * @property {string} framework — one of FRAMEWORK_RULES.label or 'generic-node'/'generic-python'/'unknown'
 * @property {boolean} hasUiRoutes — has HTML/SPA surface (next/vite/astro/sveltekit/nuxt)
 * @property {boolean} hasHttpBoundary — has HTTP routes/API a Playwright capture could observe
 * @property {boolean} hasCliBin — package.json bin field, or known CLI signatures
 * @property {boolean} isPlugin — Obsidian plugin or similar embedded runtime
 * @property {boolean} hasPlaywright — @playwright/test in deps OR playwright.config.* present
 * @property {boolean} hasSupabase — @supabase/supabase-js in deps OR SUPABASE_* env vars
 * @property {string|null} testRunner — vitest | jest | mocha | node-test | pytest | null
 * @property {boolean} hasPlansDir — docs/plans/ directory present
 * @property {boolean} hasEngineClaimAnnotations — grep hit for data-engine-claim
 * @property {boolean} hasPersonaTestManifest — .persona-test/surfaces.json present
 * @property {string[]} detectedFrom — the markers we found, for transparency
 */
export function detectShape(cwd = process.cwd()) {
  const detectedFrom = [];

  const stackInfo = detectRepoStack(cwd);
  detectedFrom.push(...stackInfo.detectedFrom);

  let framework = pickFramework(cwd);
  if (!framework) {
    if (stackInfo.stack === 'js-ts')   framework = 'generic-node';
    else if (stackInfo.stack === 'python') framework = 'generic-python';
    else framework = 'unknown';
  }

  const hasUiRoutes = ['nextjs', 'remix', 'astro', 'sveltekit', 'nuxt', 'vite-spa'].includes(framework);
  const hasHttpBoundary =
    hasUiRoutes ||
    ['express', 'fastify', 'fastapi', 'django', 'flask'].includes(framework);

  const isPlugin = framework === 'obsidian-plugin';
  const hasCliBin = pkgHasBin(cwd) || existsAny(cwd, ['bin']);

  const hasPlaywright =
    pkgHas(cwd, '@playwright/test') ||
    pkgHas(cwd, 'playwright') ||
    existsAny(cwd, ['playwright.config.js', 'playwright.config.mjs', 'playwright.config.ts']);

  const hasSupabase = pkgHas(cwd, '@supabase/supabase-js');

  const testRunner = detectTestRunner(cwd, stackInfo.stack);

  const hasPlansDir = fs.existsSync(path.join(cwd, 'docs', 'plans')) &&
                      fs.statSync(path.join(cwd, 'docs', 'plans')).isDirectory();

  const hasEngineClaimAnnotations = grepForAnnotations(cwd);

  const hasPersonaTestManifest = fs.existsSync(path.join(cwd, '.persona-test', 'surfaces.json'));

  return {
    stack: stackInfo.stack,
    pythonFramework: stackInfo.pythonFramework,
    framework,
    hasUiRoutes,
    hasHttpBoundary,
    hasCliBin,
    isPlugin,
    hasPlaywright,
    hasSupabase,
    testRunner,
    hasPlansDir,
    hasEngineClaimAnnotations,
    hasPersonaTestManifest,
    detectedFrom,
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function existsAny(cwd, files) {
  return files.some((f) => fs.existsSync(path.join(cwd, f)));
}

function readPkg(cwd) {
  const p = path.join(cwd, 'package.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { return null; }
}

function pkgHas(cwd, depName) {
  const pkg = readPkg(cwd);
  if (!pkg) return false;
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  return Object.prototype.hasOwnProperty.call(deps, depName);
}

function pkgHasBin(cwd) {
  const pkg = readPkg(cwd);
  if (!pkg) return false;
  return !!pkg.bin && (typeof pkg.bin === 'string' || Object.keys(pkg.bin).length > 0);
}

function hasJsonMarker(cwd, file, predicate) {
  const p = path.join(cwd, file);
  if (!fs.existsSync(p)) return false;
  try {
    const json = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return predicate(json);
  } catch { return false; }
}

function pyDepHas(cwd, depName) {
  // Lightweight pyproject.toml scan — string-match, not a full TOML parse.
  // For requirements.txt / Pipfile, same approach. Adopters who use exotic
  // version pins get the same answer; we only need "the dep name appears in
  // the project's dependency declarations" to be true.
  const lc = depName.toLowerCase();
  const filesToCheck = ['pyproject.toml', 'requirements.txt', 'Pipfile'];
  for (const f of filesToCheck) {
    const p = path.join(cwd, f);
    if (!fs.existsSync(p)) continue;
    try {
      const body = fs.readFileSync(p, 'utf-8').toLowerCase();
      // Match `name`, `name>=`, `name==`, `"name"`, `'name'` — but require
      // a word-boundary so `fastapi` doesn't also match `fastapi-extras`.
      const re = new RegExp(`(^|["'\\s,\\[])${lc}([\\s=<>~"'\\],]|$)`, 'm');
      if (re.test(body)) return true;
    } catch { /* ignore */ }
  }
  return false;
}

function pickFramework(cwd) {
  for (const rule of FRAMEWORK_RULES) {
    if (rule.test(cwd)) return rule.label;
  }
  return null;
}

function detectTestRunner(cwd, stack) {
  if (stack === 'python' || stack === 'mixed') {
    if (pyDepHas(cwd, 'pytest')) return 'pytest';
  }
  if (stack === 'js-ts' || stack === 'mixed') {
    if (pkgHas(cwd, 'vitest')) return 'vitest';
    if (pkgHas(cwd, 'jest'))   return 'jest';
    if (pkgHas(cwd, 'mocha'))  return 'mocha';
    const pkg = readPkg(cwd);
    if (pkg?.scripts?.test && /node --test/.test(pkg.scripts.test)) return 'node-test';
  }
  return null;
}

/**
 * Lightweight grep for `data-engine-claim` annotations. Bounded to ~64KB
 * sampling across up to 30 candidate files in `src/`, `app/`, `pages/`,
 * `components/`, and `lib/` — enough signal for the fit-check without
 * scanning the whole repo. False-negative on deeply-nested
 * annotations is acceptable — adopters re-run after deployment anyway.
 */
function grepForAnnotations(cwd) {
  const PROBE_DIRS = ['src', 'app', 'pages', 'components', 'lib', 'ui'];
  const SAMPLE_BYTES = 64 * 1024;
  let scanned = 0;
  for (const dir of PROBE_DIRS) {
    const full = path.join(cwd, dir);
    if (!fs.existsSync(full)) continue;
    try {
      for (const entry of walkBounded(full, 30)) {
        if (scanned >= 30) return false;
        scanned++;
        try {
          const body = readHeadOf(entry, SAMPLE_BYTES);
          if (body.includes('data-engine-claim')) return true;
        } catch { /* ignore individual file errors */ }
      }
    } catch { /* ignore directory errors */ }
  }
  return false;
}

/**
 * Bounded directory walk — yields up to `maxFiles` text-suffix file paths
 * under `root`. Skips node_modules, .git, dist, build, .next, .turbo.
 */
function* walkBounded(root, maxFiles) {
  const TEXT_SUFFIX = /\.(tsx?|jsx?|svelte|vue|astro|html?|md)$/i;
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', '.cache']);
  const stack = [root];
  let yielded = 0;
  while (stack.length && yielded < maxFiles) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (e.isFile() && TEXT_SUFFIX.test(e.name)) {
        yielded++;
        yield full;
        if (yielded >= maxFiles) return;
      }
    }
  }
}

function readHeadOf(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.slice(0, n).toString('utf-8');
  } finally { fs.closeSync(fd); }
}
