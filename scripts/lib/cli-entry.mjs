/**
 * @fileoverview "Was this module started as the script, or imported?" —
 * answered on CANONICAL paths.
 *
 * Node realpaths the main module before it builds `import.meta.url`, but
 * `process.argv[1]` keeps the path as typed. The usual guard,
 * `import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href`,
 * therefore compares a resolved path with an unresolved one, and is false
 * whenever the script is reached through a symlink or Windows junction — the
 * module then imports cleanly, skips `main()`, and exits 0 having done nothing.
 * Measured on `sync-to-repos.mjs` (2026-10-13): through a junction to the
 * checkout, `--no-such-flag` exited 0 with no output, where the canonical path
 * exits 2. A sync that silently does not run reads as a sync that found
 * nothing to do.
 *
 * So both sides go through `fs.realpathSync` — the same JS realpath Node's main
 * loader applies — and win32 compares case-insensitively. When canonicalisation
 * fails (an argv path that does not exist), the comparison falls back to the
 * lexical one the old guard made, so this is never weaker than what it replaces.
 *
 * @module scripts/lib/cli-entry
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} metaUrl  the caller's `import.meta.url`
 * @param {string|undefined} [argv1]  defaults to `process.argv[1]`
 * @param {{realpath?: (p: string) => string, platform?: string}} [opts]
 * @returns {boolean}
 */
export function isInvokedAsScript(metaUrl, argv1 = process.argv[1], {
  realpath = fs.realpathSync, platform = process.platform,
} = {}) {
  if (!argv1) return false;
  let self;
  try { self = fileURLToPath(metaUrl); } catch { return false; }
  const invoked = path.resolve(argv1);
  const canon = (p) => { try { return realpath(p); } catch { return null; } };
  const a = canon(invoked);
  const b = canon(self);
  const same = (x, y) => (platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y);
  if (a && b) return same(a, b);
  return same(invoked, self);
}
