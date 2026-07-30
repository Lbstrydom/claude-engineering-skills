/**
 * @fileoverview Single source of truth for the consumer-repo list.
 * Imported by `scripts/sync-to-repos.mjs`, `scripts/install-prepush-hook.mjs`,
 * and any future per-repo tooling.  Adding a new consumer repo here
 * auto-extends every script that consumes this list.
 *
 * Each entry has:
 *   - `name`:  human/display name + GitHub repo basename
 *   - `alias`: short flag for `--target <alias>`
 *   - `path`:  absolute filesystem path on the dev machine; resolved via
 *              `import.meta.dirname` so the constant works regardless of
 *              cwd at invocation time
 *
 * @module scripts/lib/consumer-repos
 */
import fs from 'node:fs';
import path from 'node:path';

// `import.meta.dirname` resolves to scripts/lib/, so '../..' is the
// claude-audit-loop repo root.
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/**
 * This bundle's own repo root, canonicalised.
 *
 * Exported because `resolveAdHocTarget` must refuse it, and the containment test
 * has to compare REAL paths — a checkout reached through a symlink (`/var` →
 * `/private/var`, a junctioned drive) would otherwise look like a different
 * directory and slip past.
 *
 * **Resolution failure is NOT silently degraded to `path.resolve`.** An earlier
 * version caught the error and fell back to lexical normalisation, which quietly
 * weakened the S2 comparison to a string test at exactly the moment
 * canonicalisation could not be established — the opposite of failing closed. It
 * is resolved lazily and cached so a module-load-time filesystem hiccup cannot
 * make importing this module throw; the throw lands on the caller that actually
 * needs the guarantee.
 *
 * @returns {string} canonical absolute path to this repo's root
 * @throws {Error} if the source root cannot be canonicalised
 */
let _sourceRepoRootCache = null;
export function sourceRepoRoot() {
  if (_sourceRepoRootCache) return _sourceRepoRootCache;
  try {
    _sourceRepoRootCache = fs.realpathSync(REPO_ROOT);
  } catch (err) {
    throw new Error(
      `cannot canonicalise the source repo root ${REPO_ROOT} (${err.code}) — `
      + 'refusing to compare containment against a non-canonical path',
    );
  }
  return _sourceRepoRootCache;
}

/**
 * Eagerly-resolved convenience binding for callers (tests, diagnostics) that
 * just want the value. Falls back to the lexical form ONLY for display; every
 * security decision goes through `sourceRepoRoot()`, which throws instead.
 */
export const SOURCE_REPO_ROOT = (() => {
  try { return sourceRepoRoot(); } catch { return path.resolve(REPO_ROOT); }
})();

// Public, committed consumer entries.
const BASE_REPOS = [
  { name: 'wine-cellar-app', alias: 'wine', path: path.resolve(REPO_ROOT, '..', 'wine-cellar-app') },
  { name: 'ai-organiser',    alias: 'ai',   path: path.resolve(REPO_ROOT, '..', 'ai-organiser') },
];

/**
 * Local, GITIGNORED override for private/corporate consumers that must NOT be
 * named in this public repo. Create `scripts/lib/consumer-repos.local.json` on
 * the dev machine (see consumer-repos.local.example.json). Shape:
 *   { "repos": [ { "name": "...", "alias": "work", "path": "../audit-loop" } ] }
 * `path` may be absolute or relative to the repo root. Never committed.
 * @returns {Array<{name:string,alias:string,path:string}>}
 */
function loadLocalRepos() {
  const localPath = path.join(import.meta.dirname, 'consumer-repos.local.json');
  if (!fs.existsSync(localPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    const entries = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.repos) ? raw.repos : null);
    if (entries === null) {
      throw new Error('expected an array, or an object with a `repos` array');
    }
    // VALIDATE, never filter. The previous `.filter(e => e && e.name && e.alias
    // && e.path)` was the same silent-omission defect as swallowing a parse
    // error, one layer in: a structurally-wrong-but-valid-JSON entry (a typo'd
    // key, a missing `alias`) vanished without a word, and the operator's private
    // consumer simply never got synced while the run exited 0. If the file is
    // there, every entry in it must be usable or the run stops.
    return entries.map((e, i) => {
      const missing = ['name', 'alias', 'path'].filter((k) => !e || !e[k]);
      if (missing.length) {
        throw new Error(`entry #${i} is missing required field(s): ${missing.join(', ')}`);
      }
      return {
        name:  String(e.name),
        alias: String(e.alias),
        path:  path.isAbsolute(e.path) ? e.path : path.resolve(REPO_ROOT, e.path),
      };
    });
  } catch (err) {
    // FAIL CLOSED. This file only exists because a developer deliberately
    // created it to register a private/corporate consumer, so "ignore it and
    // carry on" turns an explicitly-configured target into one that silently
    // vanishes from `npm run sync`, `hooks:install` and every other consumer of
    // this list — a green run that skipped the repo the operator most cared
    // about. A stderr line does not fix that: the exit code still says success.
    //
    // The file is absent on almost every machine, so this throw is unreachable
    // in the common case; when it does fire, the operator wanted to know.
    throw new Error(
      `consumer-repos.local.json is present but unreadable/malformed: ${err.message}\n`
      + `  ${localPath}\n`
      + '  Fix or delete it — refusing to run with a private consumer set silently omitted.',
    );
  }
}

// Local entries win on alias/name collision so a developer can repoint a base.
const _merged = [...BASE_REPOS];
for (const local of loadLocalRepos()) {
  const i = _merged.findIndex((r) => r.alias === local.alias || r.name === local.name);
  if (i >= 0) _merged[i] = local; else _merged.push(local);
}

export const CONSUMER_REPOS = Object.freeze(_merged.map((r) => Object.freeze(r)));

/** @returns {string[]} the alias values, useful for CLI help text */
export function consumerAliases() {
  return CONSUMER_REPOS.map(r => r.alias);
}

/**
 * Resolve a `--target <name>` arg to the matching repo entry.
 * Accepts either alias (`wine`) or full name (`wine-cellar-app`).
 *
 * @param {string|null} target
 * @returns {ReadonlyArray<{name:string,alias:string,path:string}>}
 */
export function resolveTargets(target) {
  if (!target) return CONSUMER_REPOS;
  return CONSUMER_REPOS.filter(r => r.alias === target || r.name === target);
}

/** Is `p` the same directory as `root`, or inside it? Both must be REAL paths. */
function isAtOrInside(p, root) {
  const rel = path.relative(root, p);
  // '' means identical. A `..` prefix means outside. `path.isAbsolute` catches a
  // different drive on Windows. Crucially this is NOT a string `startsWith`,
  // which would wrongly claim `<root>-other` is inside `<root>`.
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve an operator-supplied `--target-path <dir>` into the same identity
 * triple the registry yields, so the sync loop cannot tell the two apart.
 *
 * `CONSUMER_REPOS` is the MAINTAINER'S convenience list ("sync all my repos"),
 * not a gate on who may install — this is the function that makes the bundle
 * distributable to anyone. It returns **only** `{name, alias, path}`; the
 * deployment fields (`files`, `unresolved`) are added by `decorateTarget` in
 * sync-to-repos.mjs, which is the single construction site both target sources
 * flow through. That is what prevents an ad-hoc target from drifting from a
 * registered one — one construction site, not two matching field lists.
 *
 * ## Security contract
 *
 * **S1 — canonicalise before deciding (INC-001).** `fs.realpathSync` runs first
 * and every subsequent check, and every downstream write, uses the canonical
 * result. INC-001's recorded lesson is exactly this: a lexically innocent name
 * can resolve somewhere else entirely, so classification must follow resolution.
 * An unresolvable path is a hard error — never a best-effort write.
 *
 * **S2 — refuse this repo and anything inside it.** Syncing the bundle onto
 * itself would run the rewriter over source files in place, converting them to
 * consumer layout silently and destructively. Compared on real paths via
 * `path.relative`, not string prefixes.
 *
 * **S3b — eligibility.** Must exist and be a directory. An EMPTY writable
 * directory is valid: the sync creates `.claude/` and `scripts/.claude-skills/`
 * itself, and a fresh repo is the normal first-install case. A missing
 * `.git`/`package.json` WARNS rather than rejects — a non-Node consumer
 * legitimately adopts the `.claude/skills/**` half alone (the Tier-2 path
 * `classifyConsumerRuntime` already models).
 *
 * @param {string} rawPath operator-supplied path, absolute or cwd-relative
 * @param {{warn?: (msg: string) => void}} [opts]
 * @returns {{name: string, alias: null, path: string}}
 * @throws {Error} on a missing, non-existent, non-directory, or contained path
 */
export function resolveAdHocTarget(rawPath, { warn } = {}) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new Error('--target-path requires a directory path');
  }

  // S1: resolve FIRST. Everything below reasons about `real`, never `rawPath`.
  let real;
  try {
    real = fs.realpathSync(path.resolve(rawPath.trim()));
  } catch (err) {
    throw new Error(
      err.code === 'ENOENT'
        ? `--target-path does not exist: ${rawPath}`
        : `--target-path could not be resolved (${err.code}): ${rawPath}`,
    );
  }

  if (!fs.statSync(real).isDirectory()) {
    throw new Error(`--target-path is not a directory: ${real}`);
  }

  // S2: on the canonical path, so a symlink into the source tree is caught here
  // rather than discovered mid-write.
  assertNotSourceRepo(real, '--target-path');

  // S3b: advisory only.
  if (warn && !fs.existsSync(path.join(real, '.git')) && !fs.existsSync(path.join(real, 'package.json'))) {
    warn(`${real} has no .git or package.json — syncing anyway; is this the repo you meant?`);
  }

  return { name: path.basename(real), alias: null, path: real };
}

/**
 * Refuse a sync destination that is this repo, or inside it.
 *
 * Extracted so REGISTERED targets get the identical guarantee. An earlier
 * revision applied it only to `--target-path`, which meant two targets naming
 * the same directory received materially different safety depending on which
 * flag produced them — and the registry is not automatically trustworthy: its
 * local half (`consumer-repos.local.json`) is an operator-authored file whose
 * `path` is used verbatim. A guarantee that depends on how a value arrived
 * rather than on what it is will eventually be routed around.
 *
 * @param {string} realPath a CANONICAL path (caller must have realpath'd it)
 * @param {string} label how the operator named this target, for the message
 * @throws {Error}
 */
export function assertNotSourceRepo(realPath, label) {
  const src = sourceRepoRoot();
  if (isAtOrInside(realPath, src)) {
    throw new Error(
      `${label} resolves inside the source repo (${src}): ${realPath}\n`
      + '  Syncing the bundle onto itself would rewrite source files into consumer '
      + 'layout in place. Pick a different repo.',
    );
  }
}

/**
 * Canonicalise + containment-check a REGISTERED target's path.
 *
 * Registry entries are allowed not to exist (the sync loop reports and skips
 * them), so a missing directory returns `null` rather than throwing — but any
 * entry that DOES exist is held to the same S1/S2 standard as an ad-hoc target.
 *
 * @param {{name: string, alias: string|null, path: string}} entry
 * @returns {{name: string, alias: string|null, path: string}|null} canonicalised entry, or null if absent
 * @throws {Error} if the entry resolves into the source repo
 */
export function canonicaliseRegistryTarget(entry) {
  let real;
  try {
    real = fs.realpathSync(path.resolve(entry.path));
  } catch {
    return null;   // absent — the caller reports and skips
  }
  assertNotSourceRepo(real, `consumer "${entry.name}"`);
  return { ...entry, path: real };
}
