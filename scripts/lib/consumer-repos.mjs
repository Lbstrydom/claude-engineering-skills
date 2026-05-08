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
import path from 'node:path';

// `import.meta.dirname` resolves to scripts/lib/, so '../..' is the
// claude-audit-loop repo root.
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

export const CONSUMER_REPOS = Object.freeze([
  Object.freeze({
    name:  'wine-cellar-app',
    alias: 'wine',
    path:  path.resolve(REPO_ROOT, '..', 'wine-cellar-app'),
  }),
  Object.freeze({
    name:  'ai-organiser',
    alias: 'ai',
    path:  path.resolve(REPO_ROOT, '..', 'ai-organiser'),
  }),
]);

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
