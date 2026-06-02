#!/usr/bin/env node
/**
 * @fileoverview Build a consumer's `.persona-test/surfaces.json` from per-fragment
 * `*.persona-test.json` files colocated with the surface code they describe.
 *
 * This is ENGINEERING-SKILLS tooling (persona-test consistency mode), synced into
 * consumer repos under `scripts/.claude-skills/` and invoked as a CLI from the
 * consumer repo root. The consumer owns its fragments + the committed
 * `.persona-test/surfaces.json`; this builder (and the `SurfaceManifestSchema`
 * it validates against) is owned upstream so every consumer shares one merge +
 * collision-detection + validation implementation.
 *
 * ## Why fragments
 *
 * A monolithic `.persona-test/surfaces.json` is a single CODEOWNERS choke-point —
 * every annotation change funnels through one rig-owner because GitHub CODEOWNERS
 * can't reason about individual JSON entries inside a file. Per-fragment files
 * colocated with the surface code let ownership follow path globs naturally: the
 * team that owns the source owns its annotation.
 *
 * ## SSoT contract
 *
 * The **fragments** are the source of truth. `.persona-test/surfaces.json` is a
 * derived, committed artifact (so the runner reads it without a build step).
 * This script regenerates it deterministically — same fragments in, same JSON
 * out (sorted by surface id; trailing newline; 2-space indent).
 *
 * ## Repo root resolution
 *
 * `ROOT` is the CONSUMER repo root, taken from `SURFACES_ROOT` or `process.cwd()`
 * — NOT from `import.meta` — because this script is synced into the gitignored
 * `scripts/.claude-skills/` tree, so a `import.meta.dirname/..` walk would land
 * inside the tooling tree, not the consumer repo. Run it from the repo root
 * (the `surfaces:build` npm script does this).
 *
 * ## CLI
 *
 *   node scripts/.claude-skills/build-surfaces-manifest.mjs            # write (idempotent)
 *   node scripts/.claude-skills/build-surfaces-manifest.mjs --verify   # exit 1 if stale
 *
 * `--verify` is what the consumer's contract test calls. A fragment edit that
 * forgets to regenerate the merged file fails the assertion + prints the paths.
 *
 * ## Collision rules (audit-r3/M2)
 *
 *   1. Every `surface.id` is unique across all fragments.
 *   2. Every `(locator-canonical, engineField.field)` tuple is unique —
 *      catches two fragments accidentally dual-annotating the same DOM
 *      element with the same claim.
 *
 * Violations fail with `exit code 2` and print every fragment path that
 * contributed the colliding entry.
 *
 * @module scripts/build-surfaces-manifest
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SurfaceManifestSchema } from './lib/persona-test/schemas.mjs';

/**
 * Consumer repo root. Synced into `scripts/.claude-skills/`, so resolve from the
 * working directory (the repo the CLI is invoked in), never from `import.meta`.
 */
const ROOT = process.env.SURFACES_ROOT || process.cwd();
const OUT = join(ROOT, '.persona-test', 'surfaces.json');
const FRAGMENT_SUFFIX = '.persona-test.json';

/**
 * Directories whose contents are NEVER walked for fragments. `.persona-test/`
 * itself is excluded because the merged output lives there — picking it up
 * as a fragment would be circular. `.claude-skills/` is excluded so the synced
 * tooling tree never contributes fragments.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.persona-test',
  '.claude-skills',
  'logs',
  'tmp',
  '.brainstorm',
  '.husky',
  'coverage'
]);

/**
 * Recursively walk `root` and yield every absolute path that ends with the
 * fragment suffix.
 *
 * @param {string} root — absolute path
 * @returns {string[]}
 */
function findFragments(root) {
  const results = [];
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const absPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        queue.push(absPath);
      } else if (entry.isFile() && entry.name.endsWith(FRAGMENT_SUFFIX)) {
        results.push(absPath);
      }
    }
  }
  // Sort so traversal order is stable across platforms (Windows readdir
  // returns case-insensitive ordering; this normalises to POSIX-sorted).
  results.sort();
  return results;
}

/**
 * Canonical string form for a locator — used for collision detection.
 * Two locators are considered "the same DOM element" if their canonical
 * strings match.
 *
 * @param {Object} locator
 * @returns {string}
 */
function canonicalLocator(locator) {
  if (!locator || typeof locator !== 'object') return '<invalid>';
  if (locator.kind === 'id') return `id:${locator.id}`;
  if (locator.kind === 'css') return `css:${locator.selector}`;
  if (locator.kind === 'role') return `role:${locator.role}:${locator.name || ''}`;
  if (locator.kind === 'text') return `text:${locator.text}`;
  return JSON.stringify(locator);
}

/**
 * Parse a fragment file and return `{ surfaces, collections, path }`.
 * Throws on invalid JSON or schema violations with a useful message.
 *
 * @param {string} absPath
 * @returns {{path: string, surfaces: Object[], collections: Object[]}}
 */
function loadFragment(absPath) {
  const text = readFileSync(absPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`[build-surfaces] invalid JSON in ${absPath}: ${err.message}`);
  }
  const surfaces = Array.isArray(parsed.surfaces) ? parsed.surfaces : [];
  const collections = Array.isArray(parsed.collections) ? parsed.collections : [];
  // Each fragment must contribute at least one surface OR one collection —
  // empty fragments are a code smell (someone deleted the last annotation
  // but forgot the file).
  if (surfaces.length === 0 && collections.length === 0) {
    throw new Error(
      `[build-surfaces] fragment ${absPath} is empty — delete the file `
      + 'or restore the annotation it used to carry.'
    );
  }
  return { path: absPath, surfaces, collections };
}

/**
 * Merge an array of loaded fragments into a single manifest and detect
 * collisions. Returns `{manifest, errors}` — errors is non-empty when any
 * id or (locator, field) tuple is duplicated; the caller decides whether
 * to throw or report.
 *
 * @param {{path: string, surfaces: Object[], collections: Object[]}[]} fragments
 * @returns {{manifest: Object, errors: string[]}}
 */
function mergeFragments(fragments) {
  const errors = [];

  /** @type {Map<string, string[]>} surfaceId → contributing fragment paths */
  const surfaceById = new Map();
  /** @type {Map<string, string[]>} `${locator}|${field}` → contributing fragment paths */
  const claimByLocatorField = new Map();
  /** @type {Map<string, string[]>} collectionId → contributing fragment paths */
  const collectionById = new Map();

  const mergedSurfaces = [];
  const mergedCollections = [];

  for (const frag of fragments) {
    const relPath = relative(ROOT, frag.path).split(sep).join('/');

    for (const surface of frag.surfaces) {
      const id = surface?.id;
      if (typeof id !== 'string' || !id) {
        errors.push(`${relPath}: surface missing or empty "id"`);
        continue;
      }
      const prev = surfaceById.get(id);
      if (prev) {
        prev.push(relPath);
      } else {
        surfaceById.set(id, [relPath]);
        mergedSurfaces.push(surface);
      }

      const locKey = canonicalLocator(surface.locator);
      const fields = Array.isArray(surface.engineFields) ? surface.engineFields : [];
      for (const ef of fields) {
        const field = ef?.field;
        if (typeof field !== 'string' || !field) continue;
        const tupleKey = `${locKey}|${field}`;
        const tuplePrev = claimByLocatorField.get(tupleKey);
        if (tuplePrev) {
          tuplePrev.push(relPath);
        } else {
          claimByLocatorField.set(tupleKey, [relPath]);
        }
      }
    }

    for (const col of frag.collections) {
      const id = col?.id;
      if (typeof id !== 'string' || !id) {
        errors.push(`${relPath}: collection missing or empty "id"`);
        continue;
      }
      const prev = collectionById.get(id);
      if (prev) {
        prev.push(relPath);
      } else {
        collectionById.set(id, [relPath]);
        mergedCollections.push(col);
      }
    }
  }

  // Surface-id collisions.
  for (const [id, paths] of surfaceById) {
    if (paths.length > 1) {
      errors.push(
        `surface id "${id}" declared by multiple fragments:\n`
        + paths.map((p) => `    - ${p}`).join('\n')
      );
    }
  }
  // Collection-id collisions.
  for (const [id, paths] of collectionById) {
    if (paths.length > 1) {
      errors.push(
        `collection id "${id}" declared by multiple fragments:\n`
        + paths.map((p) => `    - ${p}`).join('\n')
      );
    }
  }
  // (locator, field) tuple collisions.
  for (const [tupleKey, paths] of claimByLocatorField) {
    if (paths.length > 1) {
      const [loc, field] = tupleKey.split('|');
      errors.push(
        `(locator, engineField) tuple "${loc}" + "${field}" claimed by multiple fragments:\n`
        + paths.map((p) => `    - ${p}`).join('\n')
      );
    }
  }

  // Sort for diff stability.
  mergedSurfaces.sort((a, b) => a.id.localeCompare(b.id));
  mergedCollections.sort((a, b) => a.id.localeCompare(b.id));

  const manifest = {
    $schema: '../scripts/lib/persona-test/schemas.mjs#SurfaceManifestSchema',
    version: 1,
    collections: mergedCollections,
    surfaces: mergedSurfaces
  };

  return { manifest, errors };
}

/**
 * Produce the on-disk JSON string for a manifest. Mirrors the formatting
 * `.persona-test/surfaces.json` was committed with: 2-space indent, LF
 * line endings, trailing newline.
 *
 * @param {Object} manifest
 * @returns {string}
 */
function renderManifest(manifest) {
  return JSON.stringify(manifest, null, 2) + '\n';
}

/**
 * Exported for unit tests that need to drive the merge step with
 * synthetic fragments without touching the filesystem.
 */
export { mergeFragments, canonicalLocator, renderManifest };

/**
 * Programmatic entry — used by the consumer's contract test.
 *
 * @returns {{manifest: Object, errors: string[], fragments: string[], rendered: string}}
 */
export function buildSurfacesManifest() {
  const fragmentPaths = findFragments(ROOT);
  const fragments = fragmentPaths.map(loadFragment);
  const { manifest, errors } = mergeFragments(fragments);
  if (errors.length === 0) {
    // Final schema validation — catches anything the per-fragment checks
    // missed (e.g. malformed engineField shapes).
    const result = SurfaceManifestSchema.safeParse(manifest);
    if (!result.success) {
      const issues = (result.error?.issues || result.error?.errors || []).map(
        (i) => `${(i.path || []).join('.')}: ${i.message}`
      );
      errors.push(`merged manifest fails SurfaceManifestSchema:\n    ${issues.join('\n    ')}`);
    }
  }
  return {
    manifest,
    errors,
    fragments: fragmentPaths.map((p) => relative(ROOT, p).split(sep).join('/')),
    rendered: renderManifest(manifest)
  };
}

/** CLI entry. */
function main() {
  const args = new Set(process.argv.slice(2));
  const verify = args.has('--verify');
  const verbose = args.has('--verbose');

  const { manifest, errors, fragments, rendered } = buildSurfacesManifest();

  if (verbose) {
    console.log(`[build-surfaces] discovered ${fragments.length} fragment(s):`);
    for (const p of fragments) console.log(`  - ${p}`);
  }

  if (errors.length) {
    console.error('[build-surfaces] FAILED with errors:');
    for (const err of errors) console.error(`  ${err}`);
    process.exit(2);
  }

  let existing = null;
  try { existing = readFileSync(OUT, 'utf8'); } catch (_) { /* file may not exist */ }

  if (verify) {
    if (existing !== rendered) {
      console.error(
        '[build-surfaces] DRIFT — .persona-test/surfaces.json is out of sync with fragments.\n'
        + '    Run `node scripts/.claude-skills/build-surfaces-manifest.mjs` to regenerate, then re-stage the file.'
      );
      process.exit(1);
    }
    if (verbose) {
      console.log(
        `[build-surfaces] ok — ${manifest.surfaces.length} surfaces / `
        + `${manifest.collections.length} collections in sync`
      );
    }
    return;
  }

  if (existing === rendered) {
    if (verbose) console.log('[build-surfaces] no changes (already current)');
    return;
  }
  writeFileSync(OUT, rendered, 'utf8');
  console.log(
    `[build-surfaces] wrote ${relative(ROOT, OUT).split(sep).join('/')} — `
    + `${manifest.surfaces.length} surfaces, ${manifest.collections.length} collections`
  );
}

// Skip main() when imported as a module (e.g. by the contract test).
const isDirectInvocation =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectInvocation) main();
