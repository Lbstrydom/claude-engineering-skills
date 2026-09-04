/**
 * @fileoverview Pure classifier for local-vs-store debt reconciliation.
 *
 * **Why this exists.** `.audit/tech-debt.json` is a machine-local cache and the
 * private store is the source of truth, but nothing ever reconciled them.
 * Measured on this repo 2026-09-04: local 106 entries, store 136, overlap 69 —
 * **37 entries existed on one disk and nowhere else**, and 67 store entries were
 * invisible to every local reader. `debt-memory.mjs` had a reconcile path for
 * local *events* only; local *entries* had no route home at all.
 *
 * **The hard part is not the diff, it is what absence MEANS.** A local entry
 * missing from `debt_entries` is ambiguous:
 *   - it was never mirrored (a failed write) → it must be PUSHED, or it is lost;
 *   - it was resolved remotely (resolution deletes the row and keeps the event)
 *     → it must be PRUNED, or the local cache grows forever.
 * Absence alone cannot separate those, and guessing wrong in the first
 * direction destroys the exact data this module exists to recover.
 *
 * **And "has a resolved event" is not good enough either.** A debt topic's
 * lifecycle is not monotonic — this repo has 34 `reopened` events. Resolved in
 * July, reopened in August, re-deferred locally, mirror fails: a naive "any
 * resolved event" test deletes precisely the orphan it should push. So the
 * predicate is recency-ordered and entry-relative, and **every ambiguity
 * resolves toward keeping the data**.
 *
 * No I/O — the whole decision is unit-testable without a database, the same
 * shape as `knip-gate.mjs`'s `diffAgainstBaseline`.
 *
 * Plan: docs/plans/backlog-and-drift-reduction.md §2 A8, Phase 3.
 *
 * @module scripts/lib/debt-reconcile
 */

/** Events that can be a topic's latest lifecycle state, most-closing first. */
export const RESOLVED_EVENT = 'resolved';
export const REOPENED_EVENT = 'reopened';

/**
 * Clock-skew tolerance between the local cache's `deferredAt` and the store's
 * event timestamps. Within this window the ordering is not trustworthy, so the
 * entry is treated as non-prunable rather than compared.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

function parseTs(value) {
  if (value == null) return null;
  const t = Date.parse(value instanceof Date ? value.toISOString() : String(value));
  return Number.isFinite(t) ? t : null;
}

/**
 * Decide whether one local entry is provably closed in the store.
 *
 * Returns true ONLY on unambiguous evidence. Every other case — no event, a
 * later reopen, an unparseable or missing timestamp, a resolve older than the
 * entry, or an ordering inside the skew tolerance — returns false, which routes
 * the entry to `localOnly` and therefore to a push. Keeping an already-closed
 * entry costs a stale cache row; deleting a live one costs the finding.
 *
 * @param {object} entry - local ledger entry (needs `deferredAt`)
 * @param {{event: string, ts: string}|null|undefined} latest - the topic's most recent lifecycle event
 * @returns {boolean}
 */
export function isProvablyResolvedRemotely(entry, latest) {
  if (!latest || latest.event !== RESOLVED_EVENT) return false;

  const eventTs = parseTs(latest.ts);
  const entryTs = parseTs(entry?.deferredAt);
  if (eventTs === null || entryTs === null) return false;

  // The resolve must POSTDATE this entry, beyond the skew tolerance. A resolve
  // older than the entry describes a previous lifecycle instance; this local
  // row is a later re-deferral that simply never mirrored.
  return eventTs - entryTs > CLOCK_SKEW_TOLERANCE_MS;
}

/**
 * Pick a topic's latest lifecycle event from an unordered event list.
 *
 * At equal timestamps `reopened` outranks `resolved` — the safe direction,
 * because it makes the entry non-prunable. Without a deterministic tie-break a
 * same-millisecond pair would decide by list order, which is not a contract.
 *
 * @param {Array<{event: string, ts: string}>} events
 * @returns {{event: string, ts: string}|null}
 */
export function latestLifecycleEvent(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  let best = null;
  let bestTs = -Infinity;
  for (const e of events) {
    const ts = parseTs(e?.ts);
    if (ts === null) continue;
    if (ts > bestTs) { best = e; bestTs = ts; continue; }
    if (ts === bestTs && e?.event === REOPENED_EVENT) best = e; // tie → safer state
  }
  return best;
}

/**
 * Classify every local entry against the store.
 *
 * @param {object} input
 * @param {object[]} input.localEntries - entries from the local cache
 * @param {Array<{topicId: string}>} input.cloudEntries - rows currently in `debt_entries`
 * @param {Map<string, {event: string, ts: string}>} input.latestEventByTopic - per-topic latest lifecycle event
 * @returns {{both: object[], localOnly: object[], cloudOnly: object[], locallyResolved: object[]}}
 */
export function classifyReconciliation({ localEntries, cloudEntries, latestEventByTopic }) {
  const local = Array.isArray(localEntries) ? localEntries : [];
  const cloudIds = new Set((Array.isArray(cloudEntries) ? cloudEntries : []).map((r) => r.topicId));
  const latest = latestEventByTopic instanceof Map ? latestEventByTopic : new Map();

  const both = [];
  const localOnly = [];
  const locallyResolved = [];

  for (const entry of local) {
    if (cloudIds.has(entry.topicId)) { both.push(entry); continue; }
    if (isProvablyResolvedRemotely(entry, latest.get(entry.topicId))) {
      locallyResolved.push(entry);
    } else {
      // Unmirrored, or ambiguous. Both route to push — the safe direction.
      localOnly.push(entry);
    }
  }

  const localIds = new Set(local.map((e) => e.topicId));
  const cloudOnly = (Array.isArray(cloudEntries) ? cloudEntries : [])
    .filter((r) => !localIds.has(r.topicId));

  return { both, localOnly, cloudOnly, locallyResolved };
}

/**
 * The reconcile postcondition, stated honestly.
 *
 * A `spilled` push means the entry is genuinely still absent from the store
 * until a later drain, so "zero orphans" is not assertable at that moment.
 * `localOnly === spilled` is the true steady state; zero is reached only when
 * every push was `written`.
 *
 * @param {{localOnly: number, spilled: number}} counts
 * @returns {{satisfied: boolean, detail: string}}
 */
export function evaluatePostcondition({ localOnly, spilled }) {
  if (localOnly === spilled) {
    return spilled === 0
      ? { satisfied: true, detail: 'no local-only entries remain' }
      : { satisfied: true, detail: `${spilled} entr(ies) spilled and awaiting drain — not yet in the store` };
  }
  return {
    satisfied: false,
    detail: `${localOnly} local-only entr(ies) remain against ${spilled} spilled`,
  };
}
