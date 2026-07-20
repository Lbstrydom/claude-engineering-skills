/**
 * @fileoverview Bidirectional path mapper for consumer-repo tooling isolation.
 *
 * Pure functions, no I/O. Decides where each source-repo-relative path lands
 * in a consumer repo and supports the inverse lookup for migration tooling.
 *
 * Default rule: `scripts/<rest>` → `scripts/.claude-skills/<rest>`.
 * Explicit exceptions (closed set, plan §2 KD #3):
 *   - `scripts/.sync-manifest.json` stays at its canonical path
 *   - `supabase/migrations/*.sql` (source) ↔ `.audit-loop/migrations/*.sql` (consumer)
 *   - `.claude/skills/...`, `.claude/hooks/...`, `.claude/settings.json`,
 *     `.vscode/mcp.json`, `.github/prompts/*.prompt.md` all stay at their
 *     canonical paths (content may be rewritten — different concern).
 *
 * Round-trip invariant: destRelToSourceRel(sourceRelToDestRel(p)) === p
 * for every path the sync handles. Property-tested in sync-path-map.test.mjs.
 *
 * @module scripts/lib/sync-path-map
 */

export const LAYOUT_CONSTANTS = Object.freeze({
  CONSUMER_TOOLING_DIR: 'scripts/.claude-skills',
  MIGRATIONS_SRC_PREFIX: 'supabase/migrations/',
  MIGRATIONS_DEST_PREFIX: '.audit-loop/migrations/',
  // The `--adopt` schema contract. Lives under `tests/fixtures/` in this repo
  // because that is where it is generated and asserted, but it is a RUNTIME
  // asset for consumers — `runAdopt` hard-aborts without it, so `--adopt` (the
  // documented one-time bootstrap for a pre-provisioned DB) was structurally
  // unavailable in every consumer repo: `tests/` is not in the sync closure.
  // Lands beside the migrations, audit-loop-private, for the same reason they
  // do — a consumer's own `supabase/` must not absorb audit-loop assets.
  EXPECTED_SCHEMA_SRC: 'tests/fixtures/expected-schema.json',
  EXPECTED_SCHEMA_DEST: '.audit-loop/expected-schema.json',
  MANIFEST_PATH: 'scripts/.sync-manifest.json',
  MARKER_BEGIN: '# managed-by:claude-engineering-skills-sync — DO NOT EDIT INSIDE',
  MARKER_END: '# /managed-by:claude-engineering-skills-sync',
  IN_PROGRESS_JOURNAL: 'scripts/.sync-in-progress.json',
  // High-water mark of the last ownership record we wrote. Deliberately lives
  // INSIDE the tooling dir, which is gitignored in every consumer: the manifest
  // it shadows is a TRACKED file, so a merge/reset/checkout can roll that
  // manifest backwards while the gitignored files it owns survive — the whole
  // failure this watermark exists to detect. A watermark that git can revert
  // would be reverted by the same operation and detect nothing.
  //
  // Never appears in the manifest, so the GC pass (which iterates prior
  // manifest keys only) cannot delete it.
  // See docs/plans/sync-ownership-from-content.md.
  OWNERSHIP_WATERMARK: 'scripts/.claude-skills/.sync-watermark.json',
});

const STAYS_AT_CANONICAL_PATH_PREFIXES = [
  '.claude/skills/',
  '.claude/hooks/',
  '.github/prompts/',
  '.vscode/',
];

const STAYS_AT_CANONICAL_PATH_EXACT = new Set([
  '.claude/settings.json',
  '.vscode/mcp.json',
  LAYOUT_CONSTANTS.MANIFEST_PATH,
]);

function normalise(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * Is this source path one that stays at its canonical path on the consumer
 * side (i.e. the explicit exceptions row of the path-mapping table)?
 *
 * @param {string} sourceRel
 * @returns {boolean}
 */
export function isExplicitException(sourceRel) {
  const p = normalise(sourceRel);
  if (STAYS_AT_CANONICAL_PATH_EXACT.has(p)) return true;
  for (const prefix of STAYS_AT_CANONICAL_PATH_PREFIXES) {
    if (p.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Map a source-repo-relative path to its consumer-repo-relative destination.
 * Returns the input unchanged for paths that don't match any rule (passthrough),
 * letting unmapped surfaces flow through without behavioural change.
 *
 * **Contract — bijectivity restricted to legal source paths.** The forward
 * map is bijective on inputs that are valid SOURCE paths (i.e. files that
 * actually exist under the source layout: `scripts/<X>`, `supabase/migrations/<X>`,
 * canonical exceptions). The defensive no-op for an input already under
 * `scripts/.claude-skills/` makes the function TOTAL but NOT globally injective:
 * `scripts/foo` and `scripts/.claude-skills/foo` both map to
 * `scripts/.claude-skills/foo`. The no-op exists so a buggy caller that
 * accidentally passes a destination path doesn't get a double-prefix; sync
 * iteration only ever passes source paths so the non-injectivity is
 * unreachable in production. Round-trip
 * `destRelToSourceRel(sourceRelToDestRel(p)) === p` holds for every legal
 * source p — tested in tests/sync-path-map.test.mjs.
 *
 * @param {string} sourceRel
 * @returns {string}
 */
export function sourceRelToDestRel(sourceRel) {
  const p = normalise(sourceRel);

  if (isExplicitException(p)) return p;

  if (p === LAYOUT_CONSTANTS.EXPECTED_SCHEMA_SRC) {
    return LAYOUT_CONSTANTS.EXPECTED_SCHEMA_DEST;
  }

  if (p.startsWith(LAYOUT_CONSTANTS.MIGRATIONS_SRC_PREFIX)) {
    return LAYOUT_CONSTANTS.MIGRATIONS_DEST_PREFIX +
      p.slice(LAYOUT_CONSTANTS.MIGRATIONS_SRC_PREFIX.length);
  }

  if (p.startsWith('scripts/')) {
    const tail = p.slice('scripts/'.length);
    // Already-migrated paths (in case caller passes a dest path by mistake) — no-op.
    if (tail.startsWith('.claude-skills/')) return p;
    return `${LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR}/${tail}`;
  }

  return p;
}

/**
 * Inverse of sourceRelToDestRel: map a consumer destination path back to the
 * source path that produced it. Used by the migration tooling and by the
 * verifier (which only sees destination paths in the consumer's manifest).
 *
 * @param {string} destRel
 * @returns {string}
 */
export function destRelToSourceRel(destRel) {
  const p = normalise(destRel);

  if (isExplicitException(p)) return p;

  // Checked BEFORE the migrations prefix: both live under `.audit-loop/`, and
  // this is an exact path, not a prefix — order keeps the round-trip total.
  if (p === LAYOUT_CONSTANTS.EXPECTED_SCHEMA_DEST) {
    return LAYOUT_CONSTANTS.EXPECTED_SCHEMA_SRC;
  }

  if (p.startsWith(LAYOUT_CONSTANTS.MIGRATIONS_DEST_PREFIX)) {
    return LAYOUT_CONSTANTS.MIGRATIONS_SRC_PREFIX +
      p.slice(LAYOUT_CONSTANTS.MIGRATIONS_DEST_PREFIX.length);
  }

  const isolatedPrefix = `${LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR}/`;
  if (p.startsWith(isolatedPrefix)) {
    return `scripts/${p.slice(isolatedPrefix.length)}`;
  }

  return p;
}

export const _internals = {
  normalise,
  STAYS_AT_CANONICAL_PATH_PREFIXES,
  STAYS_AT_CANONICAL_PATH_EXACT,
};
