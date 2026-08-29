/**
 * @fileoverview `.sync-receipt.json` — the sync's in-repo trace.
 *
 * ## Why a COMMITTED artifact, against the generated-artifact policy
 *
 * AGENTS.md's policy sends any generated file carrying volatile provenance
 * (timestamps, HEAD shas) to Category A — gitignored — because a tracked file
 * whose dirtiness carries no information is churn. This file carries a
 * timestamp and a commit sha and is nevertheless COMMITTED, deliberately, and
 * the policy's own test is why: *does its dirtiness carry information?* Here it
 * is the only information there is.
 *
 * The manifest already records what a sync wrote — and is gitignored, which is
 * precisely why the 2026-08-29 reversion (upstream report `5b1a121e`) was
 * invisible: four pieces of merged work were reverted, `git status` showed
 * ordinary uncommitted edits, and nothing in the repo said a sync had run. The
 * receipt is not a derived view of source; it is an EVENT RECORD, the same
 * category as a changelog. A sync that changes nothing rewrites nothing (the
 * builder is content-addressed below), so it does not churn on no-op syncs.
 *
 * ## What it is for
 *
 * 1. A reviewer sees `.sync-receipt.json` in a diff and knows a sync ran, from
 *    which upstream commit, and what it touched — before approving a PR whose
 *    other 40 files were written by a tool.
 * 2. CI can read it without any of the sync's own machinery: it is committed,
 *    so it reaches linked worktrees, which the gitignored manifest never does.
 * 3. `overridesHeld[].upstreamMoved` makes a STALE override visible. An override
 *    freezes a path; it must not also freeze the consumer's knowledge that
 *    upstream has since changed it.
 *
 * ## Deliberately NOT in it
 *
 * Per-file hashes. That is the manifest's job, it would be 751 lines of noise
 * in every review, and duplicating it here would create a second spelling of
 * the ownership record — the drift this repo keeps paying for.
 *
 * @module scripts/lib/sync-receipt
 */

/** Where the receipt lives, relative to the consumer root. */
export const RECEIPT_PATH = '.sync-receipt.json';

/** Bump when a field's MEANING changes, so a reader can refuse a shape it cannot judge. */
export const RECEIPT_VERSION = 1;

/**
 * Build the receipt value. PURE.
 *
 * Every list is sorted, so two syncs that touched the same set produce
 * byte-identical bodies and the diff shows only what actually moved.
 *
 * @param {object} input
 * @param {string} input.syncedAt — ISO timestamp
 * @param {{repo: string, branch: string|null, commitSha: string|null, sourceDirty: boolean|null}} input.source
 * @param {string[]} input.created
 * @param {string[]} input.updated
 * @param {string[]} input.gcDeleted
 * @param {Array<{path: string, reason: string, upstreamMoved: boolean}>} input.overridesHeld
 * @param {Array<{path: string, reason: string}>} input.divergedOverwritten
 * @param {Array<{path: string, reason: string}>} input.divergenceRefused
 * @param {number} input.unchanged
 * @returns {object}
 */
export function buildReceipt({
  syncedAt, source, created = [], updated = [], gcDeleted = [],
  overridesHeld = [], divergedOverwritten = [], divergenceRefused = [], unchanged = 0,
}) {
  const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return {
    version: RECEIPT_VERSION,
    // A one-line explanation IN the artifact. A reader meeting this file in a
    // diff for the first time is exactly the reader who needs it, and they have
    // no reason to know which of 751 synced paths would explain it.
    _note: 'Written by the claude-engineering-skills sync. Committed on purpose: it is the only '
      + 'in-repo record that a sync ran and what it touched (scripts/.sync-manifest.json is gitignored). '
      + `Declare deliberate divergence in .sync-overrides.json; do not hand-edit this file.`,
    syncedAt,
    source: {
      repo: source?.repo ?? null,
      branch: source?.branch ?? null,
      commitSha: source?.commitSha ?? null,
      // `null` means "not determined" and must never read as clean — the same
      // contract `buildConsumerManifest` holds for this field.
      sourceDirty: typeof source?.sourceDirty === 'boolean' ? source.sourceDirty : null,
    },
    counts: {
      created: created.length,
      updated: updated.length,
      unchanged,
      gcDeleted: gcDeleted.length,
      overridesHeld: overridesHeld.length,
      divergedOverwritten: divergedOverwritten.length,
      divergenceRefused: divergenceRefused.length,
    },
    created: [...created].sort(),
    updated: [...updated].sort(),
    gcDeleted: [...gcDeleted].sort(),
    overridesHeld: [...overridesHeld].sort(byPath),
    divergedOverwritten: [...divergedOverwritten].sort(byPath),
    // Paths the sync REFUSED to write because they carry consumer changes.
    // Recorded because a partial sync is a state a reviewer must be able to see
    // from the repo alone: these destinations are deliberately behind upstream.
    divergenceRefused: [...divergenceRefused].sort(byPath),
  };
}

/**
 * Should this receipt be written?
 *
 * Two conditions, and the first is the load-bearing one:
 *
 *   1. the run PROPAGATED something — then the timestamp is the fact being
 *      recorded, and it is written even when the touched set is identical to
 *      last time's (syncing the same file twice is two events, not one);
 *   2. otherwise, only when the body would differ — so a no-op sync does not
 *      re-dirty a tracked file, which is the churn the generated-artifact
 *      policy exists to prevent.
 *
 * `syncedAt` and the source stamp are excluded from (2)'s comparison for that
 * reason: on a no-op run they are the only things that move, and they are
 * describing nothing.
 *
 * @param {object|null} prev
 * @param {object} next
 * @returns {boolean}
 */
export function receiptShouldWrite(prev, next) {
  const c = next.counts || {};
  const propagated = (c.created || 0) + (c.updated || 0)
    + (c.gcDeleted || 0) + (c.divergedOverwritten || 0);
  if (propagated > 0) return true;
  if (!prev || typeof prev !== 'object') return true;
  const strip = (r) => JSON.stringify({
    version: r.version,
    created: r.created,
    updated: r.updated,
    gcDeleted: r.gcDeleted,
    overridesHeld: r.overridesHeld,
    divergedOverwritten: r.divergedOverwritten,
    divergenceRefused: r.divergenceRefused,
  });
  return strip(prev) !== strip(next);
}
