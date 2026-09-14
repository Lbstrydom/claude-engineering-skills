/**
 * @fileoverview D12 lifecycle host (event-wiring-symmetry,
 * docs/plans/event-wiring-symmetry.md §2) — extracted from `lib/ledger.mjs`
 * (2026-09-14, `scripts/lib/ledger.mjs`'s own `size:ratchet:gate` refused a
 * further grow-in-place after `dismissLifecycle` was added) so this feature's
 * persistent state lives beside its own detector (`event-wiring.mjs`,
 * `event-wiring-corpus.mjs`, `event-wiring-pass.mjs`) rather than inside the
 * generically-named adjudication ledger, whose `entries[]`-oriented functions
 * (`writeLedgerEntry`, `batchWriteLedger`, suppression) share nothing with
 * this file beyond the on-disk JSON shape.
 *
 * A durable per-fingerprint lifecycle record extending the SAME ledger file a
 * repo already writes (a `lifecycle` map alongside `entries` — see #10, one
 * artifact, one lock, no parallel store). Records track a runtime condition
 * (a dispatch with no consumer) across time, closed by OBSERVATION (a
 * listener appearing, the dispatch disappearing, every remaining site
 * pragma-suppressed, or a human dismissal), never by inference from silence.
 *
 * @module scripts/lib/audit/event-wiring-lifecycle-store
 */

import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';

import { atomicWriteFileSync } from '../file-io.mjs';

/** Read the whole `lifecycle` map from a ledger file. `{}` on ENOENT/corruption. */
function readLifecycleMap(absPath) {
  if (!fs.existsSync(absPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
    return (parsed && typeof parsed.lifecycle === 'object' && parsed.lifecycle !== null) ? parsed.lifecycle : {};
  } catch {
    return {};
  }
}

/**
 * Read one lifecycle record by fingerprint. Not locked — a single-record
 * read has no torn-write hazard to guard against.
 * @param {string} ledgerPath
 * @param {string} fingerprint
 * @returns {object|null}
 */
export function readLifecycle(ledgerPath, fingerprint) {
  const map = readLifecycleMap(path.resolve(ledgerPath));
  return map[fingerprint] ?? null;
}

/**
 * Enumerate open (`disposition: null`) lifecycle records for one `kind`,
 * filtered on the STORED field — never by parsing the fingerprint string
 * (event-wiring-symmetry plan, R1/H1 corrected R2/H3: an earlier draft
 * filtered by fingerprint-prefix, making `kind` a representation detail
 * rather than a stored fact).
 * @param {string} ledgerPath
 * @param {{kind: string}} opts
 * @returns {object[]}
 */
export function listOpenLifecycle(ledgerPath, { kind } = {}) {
  const map = readLifecycleMap(path.resolve(ledgerPath));
  return Object.values(map).filter(r => r.kind === kind && r.disposition === null);
}

/**
 * Single-record read-modify-write primitive `reconcileLifecycle` composes
 * internally — never called in an external loop (that was the R1/H1 draft
 * this plan corrected at R2/H3: N individual locked writes per run instead
 * of one transaction).
 * @param {string} ledgerPath
 * @param {object} record - full lifecycle record, keyed by `record.fingerprint`
 */
export function upsertLifecycle(ledgerPath, record) {
  const absPath = path.resolve(ledgerPath);
  // proper-lockfile's lockSync realpath()s the target — it must already
  // exist. Mirrors mergeMetaLocked's precondition above (found live: this
  // threw ENOENT on a fresh ledger before any entry had ever been written).
  if (!fs.existsSync(absPath)) {
    atomicWriteFileSync(absPath, JSON.stringify({ version: 1, entries: [], lifecycle: {} }, null, 2));
  }
  let release;
  try {
    release = lockfile.lockSync(absPath, { stale: 10000 });
    let ledger = { version: 1, entries: [], lifecycle: {} };
    if (fs.existsSync(absPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
        if (parsed && typeof parsed === 'object') ledger = { entries: [], lifecycle: {}, ...parsed };
      } catch { /* start fresh on corruption, same posture as writeSingleLedgerEntry */ }
    }
    if (!ledger.lifecycle || typeof ledger.lifecycle !== 'object') ledger.lifecycle = {};
    ledger.lifecycle[record.fingerprint] = record;
    atomicWriteFileSync(absPath, JSON.stringify(ledger, null, 2));
  } finally {
    if (release) release();
  }
}

/**
 * Mark an OPEN lifecycle record `dismissed` — a human judgment call ("not a
 * real problem"), distinct from every other disposition, which is set by
 * automatic evidence (a status/coverage observation). The one producer for
 * `disposition: 'dismissed'` (found missing in final-review credit triage,
 * 2026-09-14 — the value was declared in the transition table and read by
 * `applyLifecycleObservation`'s reopen guard, but nothing ever wrote it).
 * Reachable via `node scripts/event-wiring-lifecycle.mjs --ledger <path>
 * --dismiss <eventName> [--reason <text>]`.
 *
 * A single locked read-modify-write, mirroring `upsertLifecycle`'s lock
 * pattern exactly — NOT `readLifecycle` (unlocked) followed by a separate
 * `upsertLifecycle` call, which would read a value that a concurrent
 * `reconcileLifecycle` could change before this write lands, silently
 * dismissing a record based on a stale disposition.
 *
 * Only an OPEN record (`disposition === null`) can be dismissed — dismissal
 * is an operator override of "this is still flagged as a problem", not a
 * way to relabel something evidence already closed. Refuses, rather than
 * overwriting, when the record doesn't exist or isn't open, so a caller
 * can't silently no-op against a typo'd event name or race a concurrent
 * closure.
 *
 * @param {string} ledgerPath
 * @param {string} fingerprint - `${kind}|${eventName}`, matching `readLifecycle`
 * @param {{reason?: string|null, now?: number}} [opts]
 * @returns {{ok: true, record: object} | {ok: false, error: 'not-found'|'not-open', disposition?: string|null}}
 */
export function dismissLifecycle(ledgerPath, fingerprint, { reason = null, now = Date.now() } = {}) {
  const absPath = path.resolve(ledgerPath);
  if (!fs.existsSync(absPath)) return { ok: false, error: 'not-found' };
  let release;
  try {
    release = lockfile.lockSync(absPath, { stale: 10000 });
    let ledger = { version: 1, entries: [], lifecycle: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
      if (parsed && typeof parsed === 'object') ledger = { entries: [], lifecycle: {}, ...parsed };
    } catch { /* corrupt ledger reads as "no records" — reported as not-found below */ }
    if (!ledger.lifecycle || typeof ledger.lifecycle !== 'object') ledger.lifecycle = {};

    const existing = ledger.lifecycle[fingerprint];
    if (!existing) return { ok: false, error: 'not-found' };
    if (existing.disposition !== null) return { ok: false, error: 'not-open', disposition: existing.disposition };

    const record = { ...existing, disposition: 'dismissed', dispositionAt: now, dismissReason: reason };
    ledger.lifecycle[fingerprint] = record;
    atomicWriteFileSync(absPath, JSON.stringify(ledger, null, 2));
    return { ok: true, record };
  } finally {
    if (release) release();
  }
}

/** D12's disposition-transition table, applied to ONE existing (or new) record. Pure. */
function applyLifecycleObservation(existing, obs, now, kind) {
  const fingerprint = `${kind}|${obs.eventName}`;
  const base = existing ?? {
    kind, fingerprint, eventName: obs.eventName, triggers: [],
    firstSeen: now, lastSeen: now, occurrences: 0,
    disposition: null, dispositionAt: null,
    resolvedObservedAt: null, deletionObservedAt: null,
    reopenHistory: [], lastObservedRef: obs.ref, dismissReason: null,
  };
  const record = { ...base, lastObservedRef: obs.ref };

  // Diff-scoped observation (this run's coverage[] — the event is still
  // dispatch-only, or newly so). `triggers` is DATA here, never identity
  // (R3/M2, corrected R4/H1 — see event-wiring-symmetry.md D2b).
  if (obs.coverage) {
    record.lastSeen = now;
    record.occurrences = base.occurrences + 1;
    if (obs.triggers) record.triggers = obs.triggers;
    const { totalDispatchSites, pragmaSuppressedSites } = obs.coverage;
    const fullySuppressed = totalDispatchSites > 0 && pragmaSuppressedSites === totalDispatchSites;
    if (fullySuppressed) {
      if (base.disposition !== null && base.disposition !== 'pragma-suppressed') {
        record.reopenHistory = [...base.reopenHistory, { reopenedAt: now, from: base.disposition }];
      }
      record.disposition = 'pragma-suppressed';
      record.dispositionAt = now;
    } else if (base.disposition !== null && base.disposition !== 'dismissed') {
      // Reopen (R3/M1): the event is dispatch-only again after a terminal
      // disposition — same fingerprint, not a new episode.
      //
      // `dismissed` is excluded (found in final-review credit triage,
      // 2026-09-14): it is a HUMAN judgment call, not a live-checked state
      // like `pragma-suppressed` — the same posture the adjudication
      // ledger's own `adjudicationOutcome: 'dismissed'` convention already
      // takes for regular findings (see `lib/ledger.mjs`'s
      // dismissed-fp-reopen-policy comments). Without this guard, a record a
      // human dismissed would be silently reopened by the very next run that
      // still observes the event as dispatch-only — which is every
      // subsequent run, since a dismissal does not change the underlying
      // code — making the dismissal have no durable effect. A dismissed
      // record stays dismissed until something more specific than "still
      // dispatch-only" reopens it.
      record.disposition = null;
      record.dispositionAt = null;
      record.reopenHistory = [...base.reopenHistory, { reopenedAt: now, from: base.disposition }];
    }
    return record;
  }

  // Corpus-lookup-derived observation (D12 reconciliation — an OPEN record
  // this run's diff never touched, checked directly against the full
  // corpus). Only CLOSING transitions happen here; it never bumps
  // occurrences/lastSeen (it isn't "seeing" the finding again, only
  // confirming/closing its state) and never reopens (a status observation
  // can't distinguish "still exists" from "not diff-touched", so reopening
  // on it would be an inference from absence-of-evidence, not a real one).
  if (obs.status) {
    const { hasProductionListener, hasAnyDispatch, totalDispatchSites, pragmaSuppressedSites } = obs.status;
    // Cluster-B audit-code R2/M2 fix: dispatch-presence checked FIRST. A
    // status observation can't tell a NEWLY-wired listener from a STALE one
    // that happened to already exist while the dispatch was independently
    // removed — `hasProductionListener` alone conflates "someone fixed
    // this" with "the feature was deleted, incidentally leaving an old
    // listener behind". §6's Gemini G1 fix (docs/plans/event-wiring-symmetry.md)
    // explicitly split 'fixed'/'deleted' into evidentially distinct
    // dispositions FOR THIS REASON — 'deleted' is credited only inside its
    // 14-day `deletionObservedAt` window, 'fixed' unconditionally; the
    // original listener-first order let a deletion satisfy the unconditional
    // 'fixed' branch instead, making the 14-day window dead logic exactly
    // like the bug §6's own docstring already warns about for a DIFFERENT
    // conflation. Checking `!hasAnyDispatch` first means a stale listener
    // can never mask a deletion as a wiring fix.
    if (!hasAnyDispatch) {
      record.disposition = 'deleted';
      record.dispositionAt = now;
      record.deletionObservedAt = now;
    } else if (hasProductionListener) {
      record.disposition = 'fixed';
      record.dispositionAt = now;
      record.resolvedObservedAt = now;
    } else if (totalDispatchSites > 0 && pragmaSuppressedSites === totalDispatchSites) {
      record.disposition = 'pragma-suppressed';
      record.dispositionAt = now;
    }
    return record;
  }

  return record;
}

/**
 * THE ONE locked transaction reconciling every observation from a single
 * run — acquires the lock once, reads the ledger once, applies D12's
 * transition table to each observation, writes the WHOLE ledger back once
 * (event-wiring-symmetry plan, R1/H1, corrected R2/H3, R4/M1, R5/H2,
 * Gemini round-3 G1/G2). `ancestryDecisions` is a plain precomputed
 * `Map<storedRef, boolean>` — never a callback, never a git call inside the
 * lock (this file is git-agnostic by design; the caller,
 * event-wiring-corpus.mjs, owns git access and computes ancestry BEFORE
 * calling this).
 *
 * @param {string} ledgerPath
 * @param {{kind: string, observations: Array<{eventName: string, ref: string, coverage?: object, triggers?: string[], status?: object}>, now: number, ancestryDecisions: Map<string, boolean>}} args
 */
export function reconcileLifecycle(ledgerPath, { kind, observations, now, ancestryDecisions }) {
  const absPath = path.resolve(ledgerPath);
  // Same proper-lockfile precondition as upsertLifecycle above.
  if (!fs.existsSync(absPath)) {
    atomicWriteFileSync(absPath, JSON.stringify({ version: 1, entries: [], lifecycle: {} }, null, 2));
  }
  let release;
  try {
    release = lockfile.lockSync(absPath, { stale: 10000 });
    let ledger = { version: 1, entries: [], lifecycle: {} };
    if (fs.existsSync(absPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
        if (parsed && typeof parsed === 'object') ledger = { entries: [], lifecycle: {}, ...parsed };
      } catch { /* start fresh on corruption */ }
    }
    if (!ledger.lifecycle || typeof ledger.lifecycle !== 'object') ledger.lifecycle = {};

    for (const obs of observations) {
      const fingerprint = `${kind}|${obs.eventName}`;
      const existing = ledger.lifecycle[fingerprint] ?? null;
      // Stale-observation guard: an observation for an EXISTING record is
      // only applied when its ref is the record's stored ref or a
      // descendant of it. A non-descendant (or a ref with no entry in the
      // precomputed map — e.g. the ancestry check itself failed/was
      // unreachable) is dropped, fail-closed, never applied.
      if (existing && existing.lastObservedRef && existing.lastObservedRef !== obs.ref) {
        if (ancestryDecisions?.get(existing.lastObservedRef) !== true) continue;
      }
      ledger.lifecycle[fingerprint] = applyLifecycleObservation(existing, obs, now, kind);
    }

    atomicWriteFileSync(absPath, JSON.stringify(ledger, null, 2));
  } finally {
    if (release) release();
  }
}
