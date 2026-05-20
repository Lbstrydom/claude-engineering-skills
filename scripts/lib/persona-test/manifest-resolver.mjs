/**
 * @fileoverview Resolve `surfaces.json` for a consumer repo by walking a
 * priority-ordered list of candidate locations.
 *
 * Phase 1 of docs/plans/persona-test-consistency-mode.md.
 *
 * Resolution order (the runner tries each in turn):
 *   1. <repo-root>/.persona-test/surfaces.json
 *   2. <repo-root>/persona-test-manifest.json
 *   3. <repo-root>/src/persona-test-surfaces.json
 *
 * Resolves R1-M3 (structured locators in the parsed schema), Gemini-R3-M2
 * (immutable resolver list, no global mutation). Consumers wanting a
 * different order pass an ordered resolver array into `resolveManifest()`
 * directly; the default constant is frozen.
 *
 * Symlink + path-traversal safety: every candidate path is realpath-resolved
 * and refused if the real path lies outside the repo root (a symlink
 * pointing at /etc/passwd or similar would be ignored, not loaded).
 *
 * @module scripts/lib/persona-test/manifest-resolver
 */
import fs from 'node:fs';
import path from 'node:path';
import { SurfaceManifestSchema } from './schemas.mjs';

/**
 * Each resolver is a pure function `(repoRoot: string) => string | null`
 * returning the absolute candidate path for that layout.
 *
 * Frozen — adopters wanting a different layout pass a custom ordered array
 * into `resolveManifest(repoRoot, [...customResolvers, ...DEFAULT_RESOLVERS])`.
 */
export const DEFAULT_RESOLVERS = Object.freeze([
  (repoRoot) => path.join(repoRoot, '.persona-test', 'surfaces.json'),
  (repoRoot) => path.join(repoRoot, 'persona-test-manifest.json'),
  (repoRoot) => path.join(repoRoot, 'src', 'persona-test-surfaces.json'),
]);

/**
 * Resolve the first matching manifest. Returns `null` if no candidate
 * resolved cleanly — the caller exits with a bootstrap message.
 *
 * @param {string} repoRoot - Absolute path to the consumer repo root.
 * @param {ReadonlyArray<(repoRoot: string) => string | null>} [resolvers]
 * @returns {{ path: string, manifest: import('./schemas.mjs').SurfaceManifest } | null}
 * @throws if a candidate exists but fails JSON parse or Zod validation
 *         (cleaner to abort than to silently fall through to a worse match).
 */
export function resolveManifest(repoRoot, resolvers = DEFAULT_RESOLVERS) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new Error('resolveManifest: repoRoot must be a non-empty string');
  }
  if (!Array.isArray(resolvers) || resolvers.length === 0) {
    throw new Error('resolveManifest: resolvers must be a non-empty array');
  }

  let repoReal;
  try {
    repoReal = fs.realpathSync(repoRoot);
  } catch (err) {
    throw new Error(`resolveManifest: repoRoot does not exist: ${repoRoot} (${err.message})`);
  }

  for (const resolver of resolvers) {
    if (typeof resolver !== 'function') continue;

    const candidatePath = resolver(repoRoot);
    if (!candidatePath || typeof candidatePath !== 'string') continue;

    let realPath;
    try {
      realPath = fs.realpathSync(candidatePath);
    } catch (err) {
      if (err.code === 'ENOENT') continue;   // not present at this layout, try next
      throw err;
    }

    // Refuse symlinks that point outside the repo (path-traversal guard).
    const rel = path.relative(repoReal, realPath);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      continue;
    }

    let raw;
    try {
      raw = fs.readFileSync(realPath, 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`resolveManifest: invalid JSON in ${candidatePath}: ${err.message}`);
    }

    const result = SurfaceManifestSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `resolveManifest: schema validation failed for ${candidatePath}: ${result.error.message}`,
      );
    }

    return { path: candidatePath, manifest: result.data };
  }

  return null;
}
