/**
 * @fileoverview Phase D — unified debt-memory facade.
 *
 * Presents a single API to the audit runner and chooses the authoritative
 * source (cloud vs local) at run start. A single audit run never mixes sources
 * (fix R2-H1). Offline runs get reconciled to cloud on next connect (fix R3-H3).
 *
 * Storage precedence:
 *   1. Cloud — when isCloudEnabled() && repoId resolved → primary
 *   2. Local — otherwise, or on cloud failure → .audit/local/debt-events.jsonl
 *
 * **The private cloud store is the source of truth; `.audit/tech-debt.json` is
 * a machine-local cache.** This docstring used to assert the opposite — that
 * "the COMMITTED debt ledger at .audit/tech-debt.json is the durable,
 * human-approved state" and cloud was its mirror. That premise was false and
 * load-bearing: `.gitignore` ignores all of `.audit/` (`git ls-files .audit/`
 * is empty), so the declared source of truth was untracked, per-machine, and
 * survived nothing, while the declared "mirror" was the only durable copy.
 *
 * Measured 2026-09-04 on this repo, which is what the inversion cost: local 106
 * entries, cloud 136, overlap only 69 — 37 entries existed on ONE disk and
 * nowhere else, and 67 the local reader could not see. Because a resolve
 * deletes from both stores, a resolve run from another worktree shrank the
 * cloud and left this disk's copy forever: 0 of the 106 local entries carried a
 * cloud `resolved` event, against 393 resolved topics in the store.
 *
 * Events are the fast-changing, per-run telemetry. Stored in whichever source
 * the run picked.
 *
 * Plan: docs/plans/backlog-and-drift-reduction.md (A1, A7).
 *
 * @module scripts/lib/debt-memory
 */

import fs from 'node:fs';
import {
  DEFAULT_DEBT_LEDGER_PATH, readDebtLedger, writeDebtEntries, removeDebtEntry,
  mergeLedgers, markSuperseded as markSupersededLocal,
} from './debt-ledger.mjs';
import {
  DEFAULT_DEBT_EVENTS_PATH, appendDebtEventsLocal, readDebtEventsLocal,
  deriveMetricsFromEvents,
} from './debt-events.mjs';
import {
  removeDebtEntryCloud, readDebtEntriesCloud,
  appendDebtEventsCloud, readDebtEventsCloud, markSupersededCloud,
  enrichDebtEntriesWithAliases,
} from '../learning-store.mjs';
import { embedText, findingEmbeddingSpace } from './embed-text.mjs';
import { durableWrite } from './durable-write.mjs';
// Side-effecting import: populates the durable-write registry. This is the
// registry's ONLY bootstrap, and a fresh process (the operator drain, a CLI)
// finds zero handlers without it.
import './audit-store-writers.mjs';

/**
 * The authoritative source for this run's debt events.
 * One source per run — never mixed.
 */
export const EventSource = Object.freeze({
  CLOUD: 'cloud',
  LOCAL: 'local',
  DISABLED: 'disabled',
});

// ── Source selection ────────────────────────────────────────────────────────

/**
 * Pick the authoritative debt-event source for this run.
 * Never throws; logs the choice to stderr for auditability.
 *
 * @param {object} opts
 * @param {boolean} [opts.noDebtLedger=false] - Hard opt-out
 * @param {boolean} [opts.readOnly=false] - Block all event writes
 * @param {string|null} [opts.repoId=null] - Cloud repo UUID (null = no cloud)
 * @returns {{ source: string, canWrite: boolean, repoId: string|null }}
 */
export function selectEventSource({ noDebtLedger = false, readOnly = false, repoId = null, cloudEnabled = false } = {}) {
  if (noDebtLedger) {
    process.stderr.write('  [debt] --no-debt-ledger → disabled\n');
    return { source: EventSource.DISABLED, canWrite: false, repoId: null };
  }
  // `cloudEnabled` is supplied by the caller (which has already awaited the
  // async isCloudEnabled()). Keeping the resolved boolean as a parameter lets
  // this stay a pure, synchronous decision function.
  if (cloudEnabled && repoId) {
    process.stderr.write(`  [debt] event source: cloud (repo_id=${repoId.slice(0, 8)}…)\n`);
    return { source: EventSource.CLOUD, canWrite: !readOnly, repoId };
  }
  process.stderr.write('  [debt] event source: local (.audit/local/debt-events.jsonl)\n');
  return { source: EventSource.LOCAL, canWrite: !readOnly, repoId: null };
}

// ── Read: hydrated debt ledger ──────────────────────────────────────────────

/**
 * Load the debt ledger, hydrated with event-derived fields from the selected source.
 *
 * @param {object} context - from selectEventSource()
 * @param {object} [opts]
 * @param {string} [opts.ledgerPath=DEFAULT_DEBT_LEDGER_PATH]
 * @param {string} [opts.eventsPath=DEFAULT_DEBT_EVENTS_PATH]
 * @returns {Promise<{ version: 1, entries: object[], eventSource: string }>}
 */
export async function loadDebtLedger(context, {
  ledgerPath = DEFAULT_DEBT_LEDGER_PATH,
  eventsPath = DEFAULT_DEBT_EVENTS_PATH,
} = {}) {
  if (context.source === EventSource.DISABLED) {
    return { version: 1, entries: [], eventSource: EventSource.DISABLED };
  }

  let events = [];
  if (context.source === EventSource.CLOUD) {
    events = await readDebtEventsCloud(context.repoId);
  } else {
    events = readDebtEventsLocal(eventsPath);
  }

  const ledger = readDebtLedger({ ledgerPath, events });
  return { ...ledger, eventSource: context.source };
}

/**
 * Load the debt entries a reporting caller should believe, and SAY which
 * source answered.
 *
 * The contract every health-reporting consumer keys on, per
 * docs/plans/backlog-and-drift-reduction.md §2 "availability contract":
 *
 *   source 'cloud'       — authoritative; counts may be displayed
 *   source 'local'       — a cache; counts may be displayed, but LABELLED
 *   source 'unavailable' — nothing was measured; a count may NOT be displayed
 *
 * Two rules bind every caller, and together they are the whole defect this
 * fixes: **a count is never printed without its source label**, and
 * **`unavailable` never renders as a number.**
 *
 * `unavailable` is returned for every way a read can fail to produce a
 * measurement — an absent or unreadable local cache, unresolvable repo
 * identity, or a cloud read that threw. It is never returned as an empty
 * ledger, because an empty ledger is itself a claim ("there is no debt") and
 * that claim is exactly what was being fabricated.
 *
 * @param {object} context - from selectEventSource()
 * @param {object} [opts]
 * @param {string} [opts.ledgerPath=DEFAULT_DEBT_LEDGER_PATH]
 * @returns {Promise<{entries: object[], source: 'cloud'|'local'|'unavailable',
 *   reason: string|null, degraded: boolean}>}
 */
export async function loadAuthoritativeDebt(context, {
  ledgerPath = DEFAULT_DEBT_LEDGER_PATH,
} = {}) {
  if (context.source === EventSource.DISABLED) {
    return { entries: [], source: 'unavailable', reason: 'debt-ledger-disabled', degraded: false };
  }

  if (context.source === EventSource.CLOUD && context.repoId) {
    try {
      const rows = await readDebtEntriesCloud(context.repoId);
      if (Array.isArray(rows)) {
        return { entries: rows, source: 'cloud', reason: null, degraded: false };
      }
      // A non-array is a malformed response. Never parse it as "no debt".
      return { entries: [], source: 'unavailable', reason: 'cloud-response-malformed', degraded: true };
    } catch (err) {
      return {
        entries: [], source: 'unavailable',
        reason: `cloud-read-failed:${err?.code || 'unknown'}`, degraded: true,
      };
    }
  }

  // Cloud off (or repo identity unresolved) — fall back to the local cache,
  // and say so. A cache is a legitimate answer; an unlabelled one is not.
  if (context.source === EventSource.CLOUD && !context.repoId) {
    return { entries: [], source: 'unavailable', reason: 'repo-identity-unresolved', degraded: true };
  }

  let ledger;
  try {
    ledger = readDebtLedger({ ledgerPath });
  } catch (err) {
    // Corruption is louder than unavailability and must not be softened into
    // it — but a reporting caller still must not print a count.
    return { entries: [], source: 'unavailable', reason: 'ledger-corrupt', degraded: true, error: err.message };
  }
  if (!ledger.available) {
    return { entries: [], source: 'unavailable', reason: ledger.reason, degraded: false };
  }
  return { entries: ledger.entries, source: 'local', reason: null, degraded: false };
}

// ── Write: events ───────────────────────────────────────────────────────────

/**
 * Append events to the authoritative source. Emits one 'surfaced' event per
 * (topicId, runId) combination (fix M1) — callers should dedupe before calling.
 *
 * @param {object} context - from selectEventSource()
 * @param {object[]} events - DebtEvent-shaped
 * @param {object} [opts]
 * @returns {Promise<{ written: number, source: string }>}
 */
export async function appendEvents(context, events, { eventsPath = DEFAULT_DEBT_EVENTS_PATH } = {}) {
  if (!context.canWrite || !Array.isArray(events) || events.length === 0) {
    return { written: 0, source: context.source };
  }
  if (context.source === EventSource.CLOUD) {
    const r = await appendDebtEventsCloud(context.repoId, events);
    return { written: r.inserted, source: EventSource.CLOUD };
  }
  if (context.source === EventSource.LOCAL) {
    const written = appendDebtEventsLocal(events, eventsPath);
    return { written, source: EventSource.LOCAL };
  }
  return { written: 0, source: EventSource.DISABLED };
}

// ── Write: debt entries (to both committed JSON + cloud mirror) ─────────────

/**
 * Persist a set of debt entries. Always writes to the committed ledger at
 * `.audit/tech-debt.json` under a file lock. When cloud is active, also
 * mirrors to `debt_entries` table (cloud failures don't block local write).
 *
 * @param {object} context - from selectEventSource()
 * @param {object[]} entries - PersistedDebtEntry-shaped
 * @param {object} [opts]
 * @returns {Promise<{ inserted, updated, total, rejected, cloudMirrored }>}
 */
export async function persistDebtEntries(context, entries, { ledgerPath = DEFAULT_DEBT_LEDGER_PATH } = {}) {
  if (context.source === EventSource.DISABLED) {
    return {
      inserted: 0, updated: 0, total: 0, rejected: [],
      cloudMirrored: false, cloudOutcome: 'skipped',
    };
  }

  // §2 Fix A — every entry either carries a classification or an explicit
  // reason it doesn't. Normalization itself lives at the actual write
  // boundaries (`writeDebtEntries`, `upsertDebtEntries`), not here: this
  // facade is not the only caller of either — `debt-auto-capture.mjs` and
  // `debt-backfill.mjs --promote` both call `writeDebtEntries` directly — so
  // normalizing only here would leave those callers unprotected.

  // §2 Fix C — best-effort content aliasing, cloud-only (local mode has no
  // embedding infra to query, so `contentAliases` stays `[]`, unchanged from
  // today). Runs BEFORE the local write so both copies agree. Pool lifecycle
  // stays inside `store/debt.mjs`'s `enrichDebtEntriesWithAliases` — this
  // module (tech-debt domain) never touches `db/client.mjs` directly
  // (`.audit-loop/domain-map.json`'s `allowedDeps` — tech-debt may not
  // depend on stores; routing through the learning-store barrel keeps this
  // an already-declared edge).
  let embeddingsByTopicId = {};
  let embeddingSpace;
  if (context.source === EventSource.CLOUD && context.repoId) {
    try {
      embeddingSpace = findingEmbeddingSpace();
      const embed = async (text) => {
        const { result } = await embedText(text, { dim: embeddingSpace.dim, model: embeddingSpace.requestModel });
        return result;
      };
      const aliasResult = await enrichDebtEntriesWithAliases(entries, {
        repoId: context.repoId, embed, embeddingSpace,
        log: (m) => process.stderr.write(m + '\n'),
      });
      entries = aliasResult.entries;
      embeddingsByTopicId = aliasResult.embeddingsByTopicId;
    } catch (err) {
      process.stderr.write(`  [debt] content-aliasing skipped: ${err.message?.slice(0, 150)}\n`);
    }
  }

  // Write the local cache first so the entry survives a crash mid-call. The
  // cache is NOT the source of truth (see the module docstring) — it is a
  // fast local read and the spill's companion.
  // Propagate the mode this facade already decided. `writeDebtEntries` warns
  // when the ledger is gitignored-and-untracked, and that is only news in LOCAL
  // mode, where this file is the only copy; in CLOUD mode being gitignored is
  // the intended state and warning about it every run is a nag on a correct
  // setup. The ledger module accepts the answer, it does not compute one —
  // `selectEventSource` above owns it.
  const local = await writeDebtEntries(entries, {
    ledgerPath,
    cloudMirrored: context.source === EventSource.CLOUD,
  });

  // Route the store write through the durable seam rather than calling
  // `upsertDebtEntries` directly.
  //
  // This call site was the LAST direct caller of that store function, and its
  // `.catch(e => ({ok:false}))` was how entries went missing: a transient
  // failure set `cloudMirrored:false`, which no caller inspected and nothing
  // retried, so a one-off deferral got exactly one chance to reach the store.
  // The writer it now uses (`debt.entries`, registered in
  // audit-store-writers.mjs) already exists and already declares a `rowKey`
  // backed by the real `UNIQUE (repo_id, topic_id)` constraint, so a failed
  // write SPILLS and is replayed by the existing drain. `debt-auto-capture.mjs`
  // adopted it on 2026-08-27 after reproducing this exact loss in a consumer
  // (local 228 entries against a cloud mirror at 197); this is the other half.
  //
  // The four-outcome result is returned rather than collapsed to a boolean,
  // because `spilled` is NOT `written` — the entry is genuinely still absent
  // from the store until a drain lands, and a caller that cannot tell them
  // apart will assert a zero-orphan postcondition that is not yet true.
  let cloudOutcome = 'skipped';
  let cloudOutcomeError;
  if (context.source === EventSource.CLOUD) {
    // `embeddingsByTopicId` is ALREADY a plain object (never a Map — see
    // populateContentAliases), so it survives durableWrite's JSON spill
    // serialization untouched (§2 Fix C, Gemini gate round-2 G2).
    //
    // A partial-batch schema rejection is NOT surfaced through this outcome
    // (durableWrite's `{outcome, writerId, error}` shape has no field for
    // per-row detail, and is not being widened for one caller) — it is
    // logged directly to stderr by `upsertDebtEntries` the moment it
    // detects rejections (§2 Fix B, round-1 GPT audit H3).
    const r = await durableWrite('debt.entries', {
      repoId: context.repoId, entries, embeddingsByTopicId, embeddingSpace,
    });
    cloudOutcome = r.outcome;
    cloudOutcomeError = r.error;
  }
  return { ...local, cloudOutcome, cloudOutcomeError, cloudMirrored: cloudOutcome === 'written' };
}

/**
 * Remove a debt entry from committed JSON + cloud mirror.
 */
export async function removeDebt(context, topicId, { ledgerPath = DEFAULT_DEBT_LEDGER_PATH } = {}) {
  if (context.source === EventSource.DISABLED) return { removedLocal: false, removedCloud: false };
  const removedLocal = await removeDebtEntry(topicId, { ledgerPath });
  let removedCloud = false;
  if (context.source === EventSource.CLOUD) {
    const r = await removeDebtEntryCloud(context.repoId, topicId).catch(() => ({ ok: false }));
    removedCloud = r.ok;
  }
  return { removedLocal, removedCloud };
}

/**
 * Link `oldTopicId` to its replacement `newTopicId`, local + cloud.
 * Mirrors `removeDebt`'s `{removedLocal, removedCloud}` shape — two
 * independent mutations, no transaction spanning them (docs/plans/
 * debt-ledger-persisted-record-contract.md §2 Fix D, Gemini gate round-2
 * M7). Local runs first (authoritative, per this module's own established
 * precedence); a cloud failure is reported but never rolls back the local
 * write. Each side verifies BOTH topicIds exist against its OWN store
 * immediately before writing (round-3 GPT audit H7), so a "local yes, cloud
 * not-yet-visible" outcome is reported accurately rather than either side
 * guessing from the other's write receipt.
 *
 * @param {object} context - from selectEventSource()
 * @param {string} oldTopicId
 * @param {string} newTopicId
 * @param {object} [opts]
 * @returns {Promise<{local: {applied: boolean, error?: string}, cloud: {applied: boolean, error?: string}}>}
 */
export async function markDebtSuperseded(context, oldTopicId, newTopicId, { ledgerPath = DEFAULT_DEBT_LEDGER_PATH } = {}) {
  if (context.source === EventSource.DISABLED) {
    return { local: { applied: false, error: 'debt-ledger-disabled' }, cloud: { applied: false, error: 'debt-ledger-disabled' } };
  }
  const localResult = await markSupersededLocal(oldTopicId, newTopicId, { ledgerPath });
  const local = { applied: localResult.ok, error: localResult.error };
  let cloud = { applied: false, error: 'skipped' };
  if (context.source === EventSource.CLOUD) {
    const r = await markSupersededCloud(context.repoId, oldTopicId, newTopicId).catch((err) => ({ ok: false, error: err.message }));
    cloud = { applied: r.ok, error: r.error };
  }
  return { local, cloud };
}

// ── Offline → Cloud reconciliation (fix R3-H3) ──────────────────────────────

const RECONCILED_MARKER_EVENT = 'reconciled';

/**
 * Replay any unreconciled local events to cloud. Idempotent via the cloud
 * UNIQUE constraint — same event inserted twice is silently dropped.
 *
 * After success, appends a `reconciled` marker to the local log so subsequent
 * runs can skip already-reconciled prefix (opportunistic — we also rely on the
 * cloud's idempotent insert).
 *
 * Best-effort only. If the local log is deleted between runs, gap exists.
 *
 * @param {object} context - must have source=CLOUD + repoId
 * @param {object} [opts]
 * @param {string} [opts.eventsPath=DEFAULT_DEBT_EVENTS_PATH]
 * @returns {Promise<{ reconciled: number, skipped: boolean }>}
 */
export async function reconcileLocalToCloud(context, { eventsPath = DEFAULT_DEBT_EVENTS_PATH } = {}) {
  if (context.source !== EventSource.CLOUD || !context.repoId) {
    return { reconciled: 0, skipped: true };
  }
  if (!fs.existsSync(eventsPath)) {
    return { reconciled: 0, skipped: true };
  }

  const localEvents = readDebtEventsLocal(eventsPath);
  if (localEvents.length === 0) return { reconciled: 0, skipped: true };

  // Find the index after the last 'reconciled' marker — skip events before it
  let startIdx = 0;
  for (let i = localEvents.length - 1; i >= 0; i--) {
    if (localEvents[i].event === RECONCILED_MARKER_EVENT) {
      startIdx = i + 1;
      break;
    }
  }
  const toSync = localEvents.slice(startIdx).filter(e => e.event !== RECONCILED_MARKER_EVENT);
  if (toSync.length === 0) return { reconciled: 0, skipped: true };

  const r = await appendDebtEventsCloud(context.repoId, toSync);
  if (r.error) {
    process.stderr.write(`  [debt] reconcile failed: ${r.error}\n`);
    return { reconciled: 0, skipped: false };
  }

  // Write a reconciled marker to the local log
  appendDebtEventsLocal([{
    ts: new Date().toISOString(),
    runId: `reconcile-${Date.now()}`,
    event: RECONCILED_MARKER_EVENT,
  }], eventsPath);

  process.stderr.write(`  [debt] reconciled ${r.inserted}/${toSync.length} local events to cloud (${toSync.length - r.inserted} were already present)\n`);
  return { reconciled: r.inserted, skipped: false };
}

// ── Derived metrics (convenience re-export) ─────────────────────────────────

export { deriveMetricsFromEvents, mergeLedgers };
