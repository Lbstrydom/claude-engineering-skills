/**
 * @fileoverview Phase D — debt ledger read/write/merge.
 *
 * **`.audit/tech-debt.json` IS NOT COMMITTED STATE — and which copy is
 * authoritative depends on the run's mode, so this file does not get to say.**
 *
 * This header used to assert it "is committed, human-approved state" — the same
 * false premise `debt-memory.mjs` corrected on 2026-09-04, left standing in the
 * module a reader actually opens to find out what the file is. It is a claim
 * about the consumer's git configuration, made by a file that cannot see it:
 * `.gitignore` ignores all of `.audit/` in this repo and in every consumer
 * checked, so the declared source of truth was untracked, per-machine, and
 * survived nothing. Measured here that day: local 106 entries, cloud 136,
 * overlap 69 — 37 entries on exactly ONE disk. A consumer then repeated the cost
 * by trusting the sentence, putting its own ownership overlay beside the ledger
 * on its strength, and finding it silently uncommitted.
 *
 * **The correction is not "the cloud store is the source of truth" either.**
 * That was this header's first repair, and plan-audit R1 (H1) caught it as a
 * SECOND false universal: `debt-memory.mjs` chooses the authoritative source
 * PER RUN — cloud when `isCloudEnabled()` and a repo id resolves, local
 * otherwise — and the very incident that prompted this work logged
 * `Cloud store not configured — using local mode`. In that mode this file is not
 * a cache of anything; it is the only copy that exists, and telling an operator
 * their state is safe elsewhere would be the original defect with the polarity
 * flipped. Replacing one universal claim with another is not a fix.
 *
 * So the only durable fact this module can assert about itself is the one it can
 * CHECK: `assertLedgerDurability` reports whether this path survives a checkout,
 * and says nothing about whether a cloud copy exists. For which source a given
 * run is using, read `debt-memory.mjs`.
 *
 * Mutations go through a single-writer lock (`proper-lockfile`) with atomic
 * temp-file + rename to protect against concurrent writers (fix H3).
 *
 * Persistence model:
 *  - On-disk: PersistedDebtEntry (no derived fields) via PersistedDebtEntrySchema
 *  - In-memory after readDebtLedger(): HydratedDebtEntry (+ event-derived fields)
 *
 * Reads hydrate entries from event log (local JSONL or cloud — caller decides).
 * Writers NEVER persist derived fields — they come from events at read time.
 *
 * @module scripts/lib/debt-ledger
 */

import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { atomicWriteFileSync, normalizePath } from './file-io.mjs';
import { PersistedDebtEntrySchema, DebtLedgerSchema } from './schemas.mjs';
import { readDebtEventsLocal, deriveMetricsFromEvents, DEFAULT_DEBT_EVENTS_PATH } from './debt-events.mjs';
import { ignoredUntrackedPaths } from './disowned-paths.mjs';

export const DEFAULT_DEBT_LEDGER_PATH = '.audit/tech-debt.json';

const LOCK_RETRIES = 5;
const LOCK_STALE_MS = 30_000;

// Warn-once per process: a run writes the ledger many times, and the same
// notice repeated is a notice nobody reads.
let _durabilityWarned = false;

/**
 * Warn when the ledger's own path is ignored-and-untracked — i.e. when what is
 * being written here survives only this checkout.
 *
 * WHY A CHECK AND NOT A SENTENCE (consumer report, 2026-09-04). The module
 * header used to simply assert the ledger was committed state. Nothing verified
 * it, and it was false: a consumer's `.gitignore` carries `.audit/`, so the 8
 * entries `/audit-code` captured that day existed only in the worktree that
 * captured them — the main checkout still showed the original 34, and deleting
 * the worktree would have lost them. Anything placed BESIDE the ledger inherits
 * the problem, which is how their ownership overlay went there and was silently
 * never committed. This is a claim about the consumer's git configuration, and
 * `git check-ignore` is already in this toolchain, so it gets checked.
 *
 * WARN, NEVER REFUSE. Ignored + a configured cloud store is a supported setup
 * (`debt-memory.mjs` picks the authoritative source per run), so failing the
 * write would break it. What was missing was not permission but VISIBILITY.
 *
 * IT REPORTS ONLY WHAT IT PROVES. The probe answers one question — does this
 * path survive a checkout — and the message says exactly that, then names the
 * discriminator (`AUDIT_DB_URL`) rather than asserting a cloud copy exists.
 * An earlier draft told the operator "the cloud store is the durable source of
 * truth", which is false in local mode — the mode the incident that prompted
 * this work was actually in (`Cloud store not configured — using local mode`),
 * and where this file is the only copy there is. Checking one fact and
 * announcing a different one is how the original defect happened.
 *
 * The predicate is the one oracle — `ignoredUntrackedPaths`, asked of this one
 * candidate: ignored AND untracked, so a ledger that is tracked despite matching
 * an ignore pattern is correctly left alone. Its `degraded` flag (git absent,
 * not a work tree) means "could not verify", which is NOT the same as "verified
 * durable" and therefore stays silent rather than claiming either.
 *
 * IT IS SILENT ON THE HAPPY PATH. `cloudMirrored` is the caller's answer to
 * "does a durable copy of this exist elsewhere", and it is a TRI-STATE:
 *
 *  - `true`  — a cloud store is the authoritative source and this file mirrors
 *    it. Gitignored is then the INTENDED state, and warning about it every run
 *    is a nag on a correct configuration — which is how operators learn to skip
 *    warnings, including the ones that matter. Silent.
 *  - `false` — local mode. This file is the only copy there is, so the warning
 *    is loud and carries the remedy. This is the state the consumer incident
 *    was actually in (`Cloud store not configured — using local mode`).
 *  - `undefined` — the caller does not know. State the fact and the
 *    discriminator, once, without prescribing an action for a setup that may
 *    well be correct.
 *
 * The mode is PROPAGATED, never owned: `debt-memory.mjs::selectEventSource`
 * already decides it per run, and a second owner here would recreate the
 * two-sources-of-truth problem this whole change exists to close. That is the
 * distinction the Gemini gate drew when it faulted the first version —
 * declining to own the mode is right; declining to *accept* it was not.
 *
 * @param {string} absPath resolved ledger path
 * @param {boolean} [cloudMirrored] see above; omit when unknown
 */
function assertLedgerDurability(absPath, cloudMirrored) {
  if (_durabilityWarned) return;
  // A durable copy exists elsewhere — gitignored is the intended state here, so
  // there is nothing to report. Latch nothing: a later local-mode write in the
  // same process still deserves its warning.
  if (cloudMirrored === true) return;
  try {
    const repoRoot = process.cwd();
    const rel = path.relative(repoRoot, absPath).split(path.sep).join('/');
    // Outside the repo entirely — git ownership is not the right question.
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    // `warnOnDegraded:false` — this probe only decides whether to print the
    // advisory below. Outside a work tree the oracle's own stderr warning would
    // replace a quiet "cannot tell" with a loud, unrelated ownership warning on
    // every temp-dir write; `degraded` already tells us to stay silent.
    const { paths, degraded } = ignoredUntrackedPaths(repoRoot, [rel], { warnOnDegraded: false });
    if (degraded || !paths.has(rel)) return;
    _durabilityWarned = true;
    process.stderr.write(
      cloudMirrored === false
        // Known local-only: this file IS the state. Loud, and actionable.
        ? `  [debt] ${rel} is gitignored and untracked, and no cloud store is configured — these entries `
          + `exist ONLY in this checkout and are lost with it. Set AUDIT_DB_URL, or un-ignore this path to `
          + `commit them.\n`
        // Unknown: state the fact and the discriminator. No imperative — the
        // setup may be entirely correct, and prescribing a fix for it is the nag.
        : `  [debt] ${rel} is gitignored and untracked, so it does not survive this checkout. With a cloud `
          + `store configured (AUDIT_DB_URL) that is expected — this file is a local mirror; without one it `
          + `is the only copy. See debt-memory.mjs for which source a run uses.\n`,
    );
  } catch {
    // Never let a diagnostic break a write.
  }
}

// ── Read ────────────────────────────────────────────────────────────────────

/**
 * Closed enum of reasons a ledger read produced no measurement.
 *
 * `clean-checkout-sandbox` deliberately matches the vocabulary
 * `scripts/check-stale-skill-surface.mjs:203-206` already uses for the
 * identical class, so the two read alike in an operator's terminal.
 */
export const LEDGER_UNAVAILABLE_REASONS = Object.freeze([
  'clean-checkout-sandbox', // the file does not exist (gitignored; fresh clone, CI, linked worktree)
  'ledger-unreadable',      // exists but cannot be read (EACCES/EPERM/EISDIR)
]);

/**
 * Read the debt ledger, hydrating entries with event-derived fields.
 *
 * **Returns an availability discriminator, and that is the point.** This
 * function used to return `{ version: 1, entries: [] }` on ENOENT, which made
 * "the ledger is absent" and "the ledger is present and empty" the same value —
 * so no caller *could* tell them apart, and five scripts reported clean having
 * read nothing (`debt-pr-comment.mjs` posted that claim onto pull requests; in
 * CI, where `.audit/` never exists, it was the default outcome).
 *
 * The shape is ADDITIVE: `entries` keeps its meaning, so an existing caller
 * that destructures only `{ entries }` behaves exactly as before. Callers that
 * report health MUST read `available` and say `unverifiable` when it is false —
 * a count is never printed without its source.
 *
 * Corruption still THROWS (fail-loud). Unavailable is a weaker statement than
 * corrupt and must not swallow it: a malformed ledger is a defect to fix, not a
 * measurement that could not be taken.
 *
 * Plan: docs/plans/backlog-and-drift-reduction.md §2 "availability contract".
 *
 * @param {object} [opts]
 * @param {string} [opts.ledgerPath=DEFAULT_DEBT_LEDGER_PATH]
 * @param {object[]|null} [opts.events=null] - Pre-fetched events; if null, reads local log
 * @param {string} [opts.eventsPath=DEFAULT_DEBT_EVENTS_PATH]
 * @returns {{ version: 1, entries: object[], available: boolean, reason: string|null }}
 */
export function readDebtLedger({
  ledgerPath = DEFAULT_DEBT_LEDGER_PATH,
  events = null,
  eventsPath = DEFAULT_DEBT_EVENTS_PATH,
} = {}) {
  const absPath = path.resolve(ledgerPath);
  if (!fs.existsSync(absPath)) {
    return { version: 1, entries: [], available: false, reason: 'clean-checkout-sandbox' };
  }

  let text;
  try {
    text = fs.readFileSync(absPath, 'utf-8');
  } catch (err) {
    // Exists but unreadable — EACCES/EPERM/EISDIR, or a read that raced an
    // atomic replace. Never a measurement, so never an empty ledger.
    if (err && err.code === 'ENOENT') {
      return { version: 1, entries: [], available: false, reason: 'clean-checkout-sandbox' };
    }
    return { version: 1, entries: [], available: false, reason: 'ledger-unreadable' };
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Debt ledger corrupted at ${absPath}: ${err.message}`);
  }

  // Validate structure before hydration
  if (!raw || !Array.isArray(raw.entries)) {
    throw new Error(`Debt ledger corrupted: missing entries array at ${absPath}`);
  }

  // Hydrate each entry with event-derived metrics
  const eventStream = events ?? readDebtEventsLocal(eventsPath);
  const metrics = deriveMetricsFromEvents(eventStream);

  const hydrated = [];
  for (const entry of raw.entries) {
    const m = metrics.get(entry.topicId) || {
      distinctRunCount: 0,
      occurrences: 0,
      matchCount: 0,
      escalated: false,
    };
    hydrated.push({
      ...entry,
      distinctRunCount: m.distinctRunCount,
      occurrences: m.occurrences,
      matchCount: m.matchCount,
      lastSurfacedRun: m.lastSurfacedRun,
      lastSurfacedAt: m.lastSurfacedAt,
      escalated: m.escalated,
      escalatedAt: m.escalatedAt,
    });
  }

  return { version: 1, entries: hydrated, available: true, reason: null };
}

// ── Write (single-writer, locked) ───────────────────────────────────────────

/**
 * Write or merge entries into the debt ledger under a file lock.
 * On topicId match with an existing entry: updates mutable fields in place
 * (rationale, classification, owner, etc). Does NOT insert duplicates.
 *
 * Invalid entries are returned in `rejected[]` with a per-entry reason,
 * matching Phase B's batchWriteLedger contract. Caller decides whether to
 * proceed or surface the failures.
 *
 * @param {object[]} entries - PersistedDebtEntry-shaped (no derived fields)
 * @param {object} [opts]
 * @param {string} [opts.ledgerPath=DEFAULT_DEBT_LEDGER_PATH]
 * @returns {Promise<{ inserted: number, updated: number, total: number, rejected: Array<{entry, reason}> }>}
 */
export async function writeDebtEntries(entries, { ledgerPath = DEFAULT_DEBT_LEDGER_PATH, cloudMirrored } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { inserted: 0, updated: 0, total: 0, rejected: [] };
  }

  const absPath = path.resolve(ledgerPath);
  assertLedgerDurability(absPath, cloudMirrored);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });

  // proper-lockfile requires the locked file to exist.
  if (!fs.existsSync(absPath)) {
    atomicWriteFileSync(absPath, JSON.stringify({ version: 1, entries: [] }, null, 2));
  }

  let release;
  try {
    release = await lockfile.lock(absPath, {
      retries: { retries: LOCK_RETRIES, minTimeout: 100, maxTimeout: 1000 },
      stale: LOCK_STALE_MS,
    });
  } catch (err) {
    throw new Error(
      `Failed to acquire debt-ledger lock at ${absPath}: ${err.message}. ` +
      `Another audit-loop run may be mutating the ledger. ` +
      `If stuck, inspect ${absPath}.lock and remove if clearly stale.`
    );
  }

  try {
    // Read current state under lock
    let current = { version: 1, entries: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
      if (raw && Array.isArray(raw.entries)) current = raw;
      else throw new Error('missing entries array');
    } catch (err) {
      throw new Error(`Debt ledger corrupted: ${err.message}`);
    }

    const byTopic = new Map(current.entries.map(e => [e.topicId, e]));
    const rejected = [];
    let inserted = 0, updated = 0;

    for (const entry of entries) {
      const validated = PersistedDebtEntrySchema.safeParse(entry);
      if (!validated.success) {
        rejected.push({ entry, reason: validated.error.message.slice(0, 300) });
        continue;
      }
      const validEntry = validated.data;

      if (byTopic.has(validEntry.topicId)) {
        // Merge: preserve original deferredAt/deferredRun, update mutable fields,
        // union contentAliases.
        const existing = byTopic.get(validEntry.topicId);
        const mergedAliases = Array.from(new Set([
          ...(existing.contentAliases || []),
          ...(validEntry.contentAliases || []),
        ]));
        byTopic.set(validEntry.topicId, {
          ...existing,
          ...validEntry,
          deferredAt: existing.deferredAt,       // immutable
          deferredRun: existing.deferredRun,     // immutable
          contentAliases: mergedAliases,
        });
        updated++;
      } else {
        byTopic.set(validEntry.topicId, validEntry);
        inserted++;
      }
    }

    // Sort by topicId for stable diffs (makes merges localized)
    const sortedEntries = [...byTopic.values()].sort((a, b) => a.topicId.localeCompare(b.topicId));
    const next = {
      version: 1,
      entries: sortedEntries,
      lastUpdated: new Date().toISOString(),
    };
    atomicWriteFileSync(absPath, JSON.stringify(next, null, 2) + '\n');

    return {
      inserted,
      updated,
      total: sortedEntries.length,
      rejected,
    };
  } finally {
    try { await release(); } catch { /* lock already released / stale */ }
  }
}

/**
 * Remove a debt entry (soft-delete not supported — the audit trail lives in
 * the event log). Operates under the same lock.
 *
 * @param {string} topicId
 * @param {object} [opts]
 * @returns {Promise<boolean>} true if an entry was removed
 */
export async function removeDebtEntry(topicId, { ledgerPath = DEFAULT_DEBT_LEDGER_PATH } = {}) {
  const absPath = path.resolve(ledgerPath);
  if (!fs.existsSync(absPath)) return false;

  let release;
  try {
    release = await lockfile.lock(absPath, {
      retries: { retries: LOCK_RETRIES, minTimeout: 100, maxTimeout: 1000 },
      stale: LOCK_STALE_MS,
    });
  } catch (err) {
    throw new Error(`Failed to acquire debt-ledger lock: ${err.message}`);
  }

  try {
    const raw = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
    if (!raw || !Array.isArray(raw.entries)) return false;
    const before = raw.entries.length;
    const after = raw.entries.filter(e => e.topicId !== topicId);
    if (after.length === before) return false;
    atomicWriteFileSync(absPath, JSON.stringify({
      version: 1,
      entries: after,
      lastUpdated: new Date().toISOString(),
    }, null, 2) + '\n');
    return true;
  } finally {
    try { await release(); } catch { /* ignore */ }
  }
}

// ── Merge (session + debt → suppression input) ─────────────────────────────

/**
 * Merge session and debt ledgers for suppressReRaises() input.
 * On topicId collision, SESSION wins (fix M1) — active R2+ decisions override
 * historical debt state for the duration of the current audit run.
 *
 * Debt entries retain their `source: 'debt'` marker so suppressReRaises()
 * can apply source-aware filtering (fix H2).
 *
 * @param {{entries: object[]}} sessionLedger
 * @param {{entries: object[]}} debtLedger - Hydrated
 * @returns {{version: 1, entries: object[]}}
 */
export function mergeLedgers(sessionLedger, debtLedger) {
  const byTopic = new Map();
  // Debt first, session second → session wins collisions
  for (const e of (debtLedger?.entries || [])) {
    byTopic.set(e.topicId, { ...e, source: 'debt' });
  }
  for (const e of (sessionLedger?.entries || [])) {
    byTopic.set(e.topicId, { ...e, source: 'session' });
  }
  return { version: 1, entries: [...byTopic.values()] };
}

// ── Matching (contentAliases) ───────────────────────────────────────────────

/**
 * Check whether a candidate finding's content hash matches any debt entry's
 * topicId OR contentAliases.
 * @param {string} candidateHash - 8-char hex from semanticId()
 * @param {object[]} debtEntries - Hydrated debt entries
 * @returns {object|null} The matched entry, or null
 */
export function findDebtByAlias(candidateHash, debtEntries) {
  if (!candidateHash) return null;
  for (const e of debtEntries) {
    if (e.topicId === candidateHash) return e;
    if ((e.contentAliases || []).includes(candidateHash)) return e;
  }
  return null;
}

/**
 * Test surface — same underscore-prefix convention as `file-io.mjs` /
 * `anthropic-client.mjs`. `assertLedgerDurability` is warn-once via a
 * module-global latch, so a test asserting it fires must be able to clear it;
 * without the reset, the second test in a file passes having checked nothing.
 */
export const _internals = {
  assertLedgerDurability,
  _resetDurabilityWarning() { _durabilityWarned = false; },
};
