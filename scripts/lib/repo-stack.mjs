/**
 * @fileoverview Repo stack detection — pure functions used by the
 * `cross-skill.mjs detect-stack` subcommand. Shared detection logic for
 * /plan-backend, /plan-frontend, /ship which each run this at their Phase 0.
 *
 * All functions are synchronous; filesystem + `git ls-files` only. No
 * network, no cache. (`git ls-files` is a subprocess used by the
 * architecture-intent Java detection — bounded, falls back to root markers
 * when the repo is not a git checkout.)
 * @module scripts/lib/repo-stack
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const PYTHON_MARKERS = ['pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py', 'uv.lock'];
const JS_MARKERS = ['package.json'];
const JAVA_ROOT_MARKERS = [
  'pom.xml', 'build.gradle', 'build.gradle.kts',
  'settings.gradle', 'settings.gradle.kts',
];

/**
 * Detect the repo's primary stack.
 * @param {string} [cwd] — defaults to process.cwd()
 * @returns {{
 *   stack: 'js-ts' | 'python' | 'mixed' | 'unknown',
 *   pythonFramework: 'fastapi' | 'django' | 'flask' | 'none' | null,
 *   detectedFrom: string[],
 *   stackKinds: Array<'js-ts'|'python'|'java'|'postgres'>,
 * }}
 *
 * Note: `stack` and `stackKinds` are intentionally different models.
 * `stack` (consumed by /plan's principle-profile selector) stays the
 * 4-value enum. `stackKinds` (consumed by the arch-intent adapter
 * selector) is the per-stack list and is the ONLY field that carries
 * `java`/`postgres` — those have no /plan profile, so widening `stack`
 * would break that selector. Deliberate split.
 */
export function detectRepoStack(cwd = process.cwd()) {
  const detectedFrom = [];

  const jsMarkers = JS_MARKERS.filter(m => fs.existsSync(path.join(cwd, m)));
  const pyMarkers = PYTHON_MARKERS.filter(m => fs.existsSync(path.join(cwd, m)));
  detectedFrom.push(...jsMarkers, ...pyMarkers);

  // Validate package.json has deps (empty shell doesn't count as JS/TS stack)
  let hasJs = false;
  if (jsMarkers.length > 0) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      hasJs = !!(
        (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) ||
        (pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0)
      );
    } catch {
      hasJs = false;
    }
  }

  const hasPy = pyMarkers.length > 0;

  let stack;
  if (hasJs && hasPy) stack = 'mixed';
  else if (hasJs) stack = 'js-ts';
  else if (hasPy) stack = 'python';
  else stack = 'unknown';

  const pythonFramework = hasPy ? detectPythonFramework(cwd) : null;

  // Architecture-intent extension: list of stack kinds for per-stack
  // adapter selection.  For non-mixed: singleton or empty.
  const stackKinds = [];
  if (hasJs) stackKinds.push('js-ts');
  if (hasPy) stackKinds.push('python');
  if (hasJavaSources(cwd)) {
    stackKinds.push('java');
    // detectedFrom holds only JS/Python markers at this point, so any Java
    // root markers present are appended unconditionally.
    detectedFrom.push(...JAVA_ROOT_MARKERS.filter(m => fs.existsSync(path.join(cwd, m))));
  }

  return { stack, pythonFramework, detectedFrom, stackKinds };
}

/**
 * Data-driven Java detection (architecture-intent PR-B). True when EITHER a
 * Java build marker sits in the repo root (fast path) OR `git ls-files`
 * reports at least one `.java` file (covers monorepos with nested modules
 * and no root marker). The `git ls-files` call is wrapped — a non-git repo
 * falls back to the root-marker fast path only.
 *
 * The top-level `stack` field is NOT extended to a Java value; only
 * `stackKinds` gains `java`, which is all the arch-intent adapter selector
 * reads.
 *
 * @param {string} cwd
 * @returns {boolean}
 */
export function hasJavaSources(cwd = process.cwd()) {
  if (JAVA_ROOT_MARKERS.some(m => fs.existsSync(path.join(cwd, m)))) return true;
  try {
    // --cached --others --exclude-standard: tracked AND untracked-not-ignored,
    // so a freshly-added (uncommitted) .java file is still detected — matches
    // how adapter-contract.mjs::inventoryFiles enumerates source files.
    // maxBuffer raised to 64 MiB: the default 1 MiB overflows in large
    // monorepos (>~12k .java files) and would throw maxBuffer-exceeded.
    const out = execSync('git ls-files --cached --others --exclude-standard -- "*.java"', {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\n').some(l => l.trim().length > 0);
  } catch {
    return false; // not a git repo — fast path already returned false
  }
}

/**
 * Detect the Python framework from pyproject.toml / requirements.txt / Pipfile
 * by looking for framework package names in dependency declarations. Prefers
 * the first match in order FastAPI → Django → Flask. Does not parse TOML
 * properly — a substring match is sufficient for detection.
 * @param {string} cwd
 * @returns {'fastapi'|'django'|'flask'|'none'}
 */
export function detectPythonFramework(cwd = process.cwd()) {
  const candidates = ['pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py'];
  let deps = '';
  for (const f of candidates) {
    const p = path.join(cwd, f);
    if (fs.existsSync(p)) {
      try { deps += '\n' + fs.readFileSync(p, 'utf8').toLowerCase(); } catch { /* skip unreadable */ }
    }
  }
  // manage.py is a strong Django signal even without deps file
  if (fs.existsSync(path.join(cwd, 'manage.py'))) return 'django';
  if (/\bfastapi\b/.test(deps)) return 'fastapi';
  if (/\bdjango\b/.test(deps)) return 'django';
  if (/\bflask\b/.test(deps)) return 'flask';
  return 'none';
}

/**
 * Detect the Python environment manager — used by /ship for pre-push tool discovery.
 * Caller must opt in (skills that don't need this pay nothing).
 * @param {string} cwd
 * @returns {'poetry'|'uv'|'pipenv'|'venv'|'none'}
 */
export function detectPythonEnvironmentManager(cwd = process.cwd()) {
  if (fs.existsSync(path.join(cwd, 'poetry.lock'))) return 'poetry';
  if (fs.existsSync(path.join(cwd, 'uv.lock')) || fs.existsSync(path.join(cwd, 'uv.toml'))) return 'uv';
  if (fs.existsSync(path.join(cwd, 'Pipfile.lock'))) return 'pipenv';
  if (fs.existsSync(path.join(cwd, '.venv')) || fs.existsSync(path.join(cwd, 'venv'))) return 'venv';
  return 'none';
}
