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
    const entries = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.repos) ? raw.repos : []);
    return entries
      .filter((e) => e && e.name && e.alias && e.path)
      .map((e) => ({
        name:  String(e.name),
        alias: String(e.alias),
        path:  path.isAbsolute(e.path) ? e.path : path.resolve(REPO_ROOT, e.path),
      }));
  } catch (err) {
    process.stderr.write(`  [consumer-repos] ignoring malformed consumer-repos.local.json: ${err.message}\n`);
    return [];
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
