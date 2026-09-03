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
 * category as a changelog. A sync that changes nothing rewrites nothing (see
 * `receiptShouldWrite` below), so it does not churn on no-op syncs.
 *
 * ## Why the record is a LIST, not one object (v2, upstream report `1fb43574`)
 *
 * v1 held a single object, rewritten wholesale each run. The sync writes it to
 * the working tree and does NOT commit it, so the record only becomes durable
 * when a human commits — and any second sync inside that window overwrote the
 * first's `created` / `updated` lists and source commit, with nothing anywhere
 * recording the loss. Reproduced by construction 2026-09-03: sync A created 771
 * files, sync B (no commit between) created 1, and the receipt then read
 * `created: 1` with A's 771 paths, timestamp and commit sha unrecoverable —
 * untracked, absent from `HEAD`, absent from every object in the repo.
 *
 * The premise that design rested on —
 * `repo-scoped-skill-surfaces-and-installer.md:484`, *"Concurrency: none.
 * Single-operator CLI; withFileLock already guards the receipt"* — is wrong
 * twice: no lock has ever guarded this file, and a lock could not help if one
 * did. The race is not between two writers; it is between a WRITE and a COMMIT
 * performed by a human at an unbounded later time. One operator running several
 * agent sessions against one checkout is the ordinary case, not an edge case.
 *
 * So the file holds a BOUNDED LIST of recent syncs, newest first. Entry 0 still
 * answers "what did the last sync do"; a second session's sync is ADDITIVE, so
 * it can no longer destroy a record it did not produce; and because each entry
 * names its own source commit and timestamp, a session that finds a dirty
 * receipt carrying an entry it did not produce has no attestation problem — it
 * commits a log, it does not vouch for a sync it never observed.
 *
 * Self-committing (the other candidate) was rejected: the sync deliberately
 * never commits in a consumer, that repo's working tree is the human's, and a
 * commit would fire their hooks and bundle unrelated staged work.
 *
 * The one thing a reader must never do is CLOBBER a shape it cannot judge — a
 * consumer synced from a NEWER bundle carries a version this code cannot merge,
 * and rewriting it would destroy exactly the history this exists to keep.
 * `readSyncReceipt` reports `unsupported`; the caller then declines to write.
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
export const RECEIPT_VERSION = 2;

/**
 * How many sync entries the file retains, newest first.
 *
 * Bounded because it is read in diffs and a fresh install's entry carries ~750
 * paths. Ten covers the window this exists for — several agent sessions against
 * one checkout between two human commits — while a steady-state entry (0
 * created, a handful updated) costs a few lines. Entries leave by AGE, which is
 * a property of the file rather than of whoever synced last, and
 * `olderSyncsDropped` says so out loud so a reader never mistakes the window for
 * the whole history.
 */
export const RECEIPT_HISTORY_LIMIT = 10;

/** A one-line explanation IN the artifact, for the reader meeting it in a diff. */
const NOTE = 'Written by the claude-engineering-skills sync. Committed on purpose: it is the only '
  + 'in-repo record that a sync ran and what it touched (scripts/.sync-manifest.json is gitignored). '
  + 'recentSyncs is append-only, newest first: entry 0 is the latest sync, and older entries may be '
  + 'runs from other sessions that are not committed yet. Declare deliberate divergence in '
  + '.sync-overrides.json; do not hand-edit this file.';

/**
 * Build ONE sync's entry. PURE.
 *
 * Every list is sorted, so two syncs that touched the same set produce
 * byte-identical entries and the diff shows only what actually moved.
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
export function buildReceiptEntry({
  syncedAt, source, created = [], updated = [], gcDeleted = [],
  overridesHeld = [], divergedOverwritten = [], divergenceRefused = [], unchanged = 0,
}) {
  const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return {
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

/** An entry is anything carrying the one field every reader keys on. */
const looksLikeEntry = (e) => !!e && typeof e === 'object' && !Array.isArray(e)
  && typeof e.syncedAt === 'string';

/**
 * Normalise a parsed receipt file into entries, newest first.
 *
 * Four statuses, and the difference between the last two is the whole point:
 *
 *   - `absent`      — no file. Write freely.
 *   - `ok`          — understood; `entries` is the history to prepend onto. A
 *                     v1 single object normalises to ONE entry, so upgrading a
 *                     consumer PRESERVES the record it already had instead of
 *                     spending it on the migration.
 *   - `unreadable`  — present but conveys nothing (corrupt JSON, no entries).
 *                     Nothing can be lost by rewriting it.
 *   - `unsupported` — a FUTURE version, holding a record this code cannot
 *                     merge. The caller must decline to write rather than
 *                     replace a newer bundle's history with an older shape.
 *
 * @param {unknown} raw — the parsed file contents, or null/undefined when absent
 * @returns {{status: 'absent'|'ok'|'unreadable'|'unsupported', entries: object[], dropped: number, version: number|null}}
 */
export function readSyncReceipt(raw) {
  if (raw === null || raw === undefined) {
    return { status: 'absent', entries: [], dropped: 0, version: null };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'unreadable', entries: [], dropped: 0, version: null };
  }
  const version = typeof raw.version === 'number' ? raw.version : null;
  if (version !== null && version > RECEIPT_VERSION) {
    return { status: 'unsupported', entries: [], dropped: 0, version };
  }
  if (version === RECEIPT_VERSION) {
    const entries = Array.isArray(raw.recentSyncs) ? raw.recentSyncs.filter(looksLikeEntry) : [];
    const dropped = Number.isInteger(raw.olderSyncsDropped) && raw.olderSyncsDropped >= 0
      ? raw.olderSyncsDropped
      : 0;
    return entries.length > 0
      ? { status: 'ok', entries, dropped, version }
      : { status: 'unreadable', entries: [], dropped, version };
  }
  // v1 — or an unversioned object from some earlier hand: one entry.
  if (looksLikeEntry(raw)) {
    const { version: _version, _note: _note2, ...entry } = raw;
    return { status: 'ok', entries: [entry], dropped: 0, version };
  }
  return { status: 'unreadable', entries: [], dropped: 0, version };
}

/** The newest recorded sync, or null — i.e. "what did the last sync do". */
export function latestReceiptEntry(readResult) {
  return readResult?.entries?.[0] ?? null;
}

/**
 * Should this sync be recorded?
 *
 * Two conditions, and the first is the load-bearing one:
 *
 *   1. the run PROPAGATED something — then the timestamp is the fact being
 *      recorded, and it is written even when the touched set is identical to
 *      last time's (syncing the same file twice is two events, not one);
 *   2. otherwise, only when the entry would differ from the newest one already
 *      on record — so a no-op sync does not re-dirty a tracked file, which is
 *      the churn the generated-artifact policy exists to prevent.
 *
 * `syncedAt` and the source stamp are excluded from (2)'s comparison for that
 * reason: on a no-op run they are the only things that move, and they are
 * describing nothing.
 *
 * @param {object|null} prevEntry — the newest entry already on record
 * @param {object} nextEntry
 * @returns {boolean}
 */
export function receiptShouldWrite(prevEntry, nextEntry) {
  const c = nextEntry.counts || {};
  const propagated = (c.created || 0) + (c.updated || 0)
    + (c.gcDeleted || 0) + (c.divergedOverwritten || 0);
  if (propagated > 0) return true;
  if (!prevEntry || typeof prevEntry !== 'object') return true;
  const strip = (r) => JSON.stringify({
    created: r.created,
    updated: r.updated,
    gcDeleted: r.gcDeleted,
    overridesHeld: r.overridesHeld,
    divergedOverwritten: r.divergedOverwritten,
    divergenceRefused: r.divergenceRefused,
  });
  return strip(prevEntry) !== strip(nextEntry);
}

/**
 * Compose the file body: the new entry prepended to the retained history.
 *
 * @param {{entries: object[], dropped: number}|null} prior — from `readSyncReceipt`
 * @param {object} entry — from `buildReceiptEntry`
 * @param {number} [limit]
 * @returns {object}
 */
export function appendReceiptEntry(prior, entry, limit = RECEIPT_HISTORY_LIMIT) {
  const all = [entry, ...(prior?.entries ?? [])];
  const retained = all.slice(0, Math.max(1, limit));
  return {
    version: RECEIPT_VERSION,
    _note: NOTE,
    olderSyncsDropped: (prior?.dropped ?? 0) + (all.length - retained.length),
    recentSyncs: retained,
  };
}
