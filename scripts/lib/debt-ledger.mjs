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
 * **Storage: one file per entry** (`.audit/tech-debt/entries/<topicId>.json`,
 * docs/plans/debt-ledger-per-entry-files.md; upstream report d338aa8a). The
 * legacy single file `.audit/tech-debt.json` is still read, and still WRITTEN
 * while it is committed and not yet migrated; an untracked one is migrated
 * automatically on the next write. Which form a write uses is decided under the
 * lock (`openForWrite`); the forms themselves live in `debt-ledger-files.mjs`
 * and the move between them in `debt-ledger-migration.mjs`. There is no
 * `lastUpdated` in either form any more — see `writeLegacyFile`.
 *
 * Mutations go through ONE lock (`withLedgerLock`, the same lock name
 * pre-upgrade tooling takes) with atomic temp-file + rename per file (fix H3).
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
import { execFileSync } from 'node:child_process';
import { atomicWriteFileSync } from './file-io.mjs';
import { blockingSleep } from './retry-transient-fs.mjs';
import { PersistedDebtEntrySchema, normalizeClassificationEnvelope } from './schemas.mjs';
import { readDebtEventsLocal, deriveMetricsFromEvents, DEFAULT_DEBT_EVENTS_PATH } from './debt-events.mjs';
import { ignoredUntrackedPaths } from './disowned-paths.mjs';
import {
  resolveLedgerLocation, topicIdFilenameProblem, entryFilePath, serializeEntryForDisk,
  serializeLedgerForDisk, canonicalEqual, assertLedgerPathSafe, readBytesOrNull, isDirectory,
  readEntryDir, readBudgetsFile, parseLegacyBytes, withLedgerLock, legacyTrackingState,
  TransientLedgerReadError,
} from './debt-ledger-files.mjs';
import { migrateLegacyLedgerLocked } from './debt-ledger-migration.mjs';
import { DEBT_LEDGER_STEM } from './bundle-generated-stores.mjs';

/**
 * The ledger's location, named — for backward compatibility — by its LEGACY
 * file. Either spelling resolves to both forms (`resolveLedgerLocation`), so
 * every existing `--ledger x.json` argument still names the same ledger.
 */
export const DEFAULT_DEBT_LEDGER_PATH = `${DEBT_LEDGER_STEM}.json`;

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
 * Asked of whichever storage form holds the ledger: the legacy file while it
 * exists, else the per-entry directory (plan §2.6 — a consumer that commits its
 * ledger re-includes the directory, so the same question stays answerable).
 *
 * @param {string|{legacyFile: string, dir: string}} target resolved ledger path, or a ledger location
 * @param {boolean} [cloudMirrored] see above; omit when unknown
 */
function assertLedgerDurability(target, cloudMirrored) {
  if (_durabilityWarned) return;
  const absPath = typeof target === 'string'
    ? target
    : (fs.existsSync(target.legacyFile) ? target.legacyFile : target.dir);
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

// Warn-once, sibling to `_durabilityWarned` above — same rationale (a run
// checks health many times; the same notice repeated is a notice nobody reads).
let _trackedWarned = false;

/**
 * Is `absPath` TRACKED by git (in the index / committed to history)?
 *
 * **Not the inverse of `ignoredUntrackedPaths`** (round-1 plan-audit M1 — the
 * first draft of this module got this wrong). "Ignored AND untracked" has a
 * third complement besides "tracked": a file that is untracked but matches NO
 * ignore pattern (e.g. nobody has `git add`ed it yet). That state is exactly
 * as invisible to `git merge` as an ignored one, so treating "not
 * ignored-and-untracked" as "merge-exposed" would false-positive on it.
 * TRACKED is the actual precondition for merge exposure, and needs a direct
 * check — the standard idiom already used independently three times in this
 * repo (`worktree-identity.mjs`, `remove-legacy-synced.mjs::isTracked`,
 * `sync-divergence.mjs`), not a fourth copy consolidated here (out of scope
 * for this fix; a candidate for extraction if a fifth caller appears).
 *
 * @param {string} absPath resolved path to check
 * @param {string} repoRoot
 * @returns {{tracked: boolean, degraded: boolean}} `degraded:true` means git
 *   could not be consulted (not a work tree, git absent, or the path escapes
 *   the repo) — `tracked` is then meaningless, not a confirmed `false`.
 */
export function isLedgerTracked(absPath, repoRoot) {
  const rel = path.relative(repoRoot, absPath).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { tracked: false, degraded: true };
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', rel], {
      cwd: repoRoot, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true,
    });
    return { tracked: true, degraded: false };
  } catch (err) {
    // Exit 1 = definitively not tracked. Anything else (128 = not a work
    // tree, ENOENT = git absent, etc.) means we could not determine it.
    if (err && err.status === 1) return { tracked: false, degraded: false };
    return { tracked: false, degraded: true };
  }
}

/**
 * Warn once when a LEGACY single-file debt ledger is tracked by git — the
 * precondition for both merge failure modes of that form: silent duplication
 * (`findDuplicateTopicIds`, docs/plans/debt-ledger-merge-safety.md) and the
 * routine conflicts of upstream report d338aa8a. A ledger in per-entry storage
 * is merge-safe by construction (a topicId is a filename), so it never warns:
 * the old "can silently duplicate" sentence would be false for it. By default this
 * repo's `.gitignore` ignores `.audit/` entirely (verified: `git ls-files
 * .audit/` is empty here and, per this module's own header, in every
 * consumer checked) — a consumer only hits this warning by deviating from
 * that default. Informational, not prescriptive (mirrors
 * `assertLedgerDurability`'s tone for its own unknown-cloud-mirror case):
 * this repo does not know why a consumer chose to track the file, so it
 * states the exposure and the mitigation rather than recommending untracking.
 *
 * @param {string} absPath resolved ledger path
 * @param {string} [repoRoot=process.cwd()]
 */
export function warnIfLedgerTracked(absPath, repoRoot = process.cwd()) {
  if (_trackedWarned) return;
  const { legacyFile } = resolveLedgerLocation(absPath);
  if (!fs.existsSync(legacyFile)) return; // per-entry storage (or none): nothing to warn about
  const { tracked, degraded } = isLedgerTracked(legacyFile, repoRoot);
  if (degraded || !tracked) return;
  _trackedWarned = true;
  const rel = path.relative(repoRoot, legacyFile).split(path.sep).join('/');
  process.stderr.write(
    `  [debt] ${rel} is a single-file debt ledger tracked by git — two branches that both record debt `
    + `conflict on it, and a plain \`git merge\` can silently duplicate topicId entries. Move it to `
    + `per-entry files in ONE commit on your default branch (debt-ledger-migrate.mjs; see the `
    + `consumer-adoption runbook). Until then, run \`node scripts/debt-health-check.mjs `
    + `--fail-on-duplicates\` on every pull_request-triggered CI run.\n`,
  );
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
  'clean-checkout-sandbox', // neither form exists (gitignored; fresh clone, CI, linked worktree)
  'ledger-unreadable',      // exists but cannot be read (EACCES/EPERM/EISDIR, or a read that kept racing a mutation)
]);

/**
 * Hydrate persisted debt entries with the event-derived fields (recurrence,
 * escalation). One definition for both sources: the local cache hydrates from
 * the local event log, store rows from the store's `debt_events`.
 *
 * @param {object[]} entries - persisted entries
 * @param {object[]} events - DebtEvent-shaped
 * @returns {object[]}
 */
export function hydrateDebtEntries(entries, events) {
  const metrics = deriveMetricsFromEvents(events);
  return entries.map((entry) => {
    const m = metrics.get(entry.topicId) || {
      distinctRunCount: 0,
      occurrences: 0,
      matchCount: 0,
      escalated: false,
    };
    return {
      ...entry,
      distinctRunCount: m.distinctRunCount,
      occurrences: m.occurrences,
      matchCount: m.matchCount,
      lastSurfacedRun: m.lastSurfacedRun,
      lastSurfacedAt: m.lastSurfacedAt,
      escalated: m.escalated,
      escalatedAt: m.escalatedAt,
    };
  });
}

const MAX_READ_ATTEMPTS = 5;
const UNREADABLE_CODES = new Set(['EACCES', 'EPERM', 'EISDIR', 'EBUSY']);

function sameBytes(a, b) {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}

/**
 * The one AUTHORITATIVE view of a ledger, shared by reads and by every mutation
 * precondition (plan §2.2/§2.4) — two definitions of "which entries exist" is how
 * a read path and a write path drift apart.
 *
 *  - v2 only            → the entry files.
 *  - legacy only        → the legacy file, exactly as before (duplicates included,
 *                         so `findDuplicateTopicIds` still sees them).
 *  - both, untracked    → the union (an interrupted automatic migration). An id
 *                         whose copies DIFFER keeps its directory copy in
 *                         `entries` — dropping it would make a recorded debt
 *                         re-surface as new on every audit — and is listed in
 *                         `conflicts`, which every writer refuses.
 *  - both, tracked/unknown → the entry files ONLY. Absence from the directory
 *                         cannot distinguish "deleted after migration" from "not
 *                         migrated yet", so a legacy-only id is pending a
 *                         reconcile and exists for no purpose until then.
 *
 * Returns null when neither form exists.
 */
function buildState(location, legacyBytes, dirEntries, dirBudgets) {
  if (dirEntries === null) {
    const legacy = parseLegacyBytes(legacyBytes, location.legacyFile);
    return {
      storage: 'legacy', entries: legacy.entries, budgets: legacy.budgets ?? {},
      conflicts: [], pendingReconcile: null,
    };
  }
  const dirBudgetValue = dirBudgets.present ? dirBudgets.budgets : undefined;
  if (legacyBytes === null) {
    return {
      storage: 'v2', entries: dirEntries, budgets: dirBudgetValue ?? {},
      conflicts: [], pendingReconcile: null,
    };
  }
  const legacy = parseLegacyBytes(legacyBytes, location.legacyFile);
  const inDir = new Map(dirEntries.map((e) => [e.topicId, e]));
  const tracking = legacyTrackingState(location.legacyFile);
  if (tracking !== 'untracked') {
    const legacyOnly = [];
    const differing = [];
    for (const e of legacy.entries) {
      const d = inDir.get(e.topicId);
      if (d === undefined) legacyOnly.push(e.topicId);
      else if (!canonicalEqual(d, e)) differing.push(e.topicId);
    }
    return {
      storage: 'both', entries: dirEntries, budgets: dirBudgetValue ?? {},
      conflicts: [], pendingReconcile: { tracking, legacyOnly, differing },
    };
  }
  const conflicts = [];
  const union = new Map(inDir);
  for (const e of legacy.entries) {
    const d = union.get(e.topicId);
    if (d === undefined) union.set(e.topicId, e);
    else if (!canonicalEqual(d, e) && !conflicts.some((c) => c.topicId === e.topicId)) {
      conflicts.push({ topicId: e.topicId, reason: 'legacy-copy-differs' });
    }
  }
  let budgets = dirBudgetValue ?? legacy.budgets ?? {};
  if (dirBudgetValue !== undefined && legacy.budgets !== undefined && !canonicalEqual(dirBudgetValue, legacy.budgets)) {
    conflicts.push({ topicId: 'budgets', reason: 'budgets-differ' });
    budgets = dirBudgetValue;
  }
  return {
    storage: 'both',
    entries: [...union.values()].sort((a, b) => String(a.topicId).localeCompare(String(b.topicId))),
    budgets, conflicts, pendingReconcile: null,
  };
}

/**
 * Read the ledger's authoritative state without a lock — reads are the hot path
 * of every audit, `readDebtLedger` is synchronous and the lock is not.
 *
 * Optimistic whole read, in a fixed order (plan §2.2): (1) the legacy file's
 * BYTES, (2) the directory, (3) the legacy bytes again.
 *
 * The ORDER is what makes a concurrent migration safe: migration writes the
 * directory BEFORE it shrinks or deletes the legacy file, so anything missing
 * from a legacy snapshot taken first was already in the directory when it is
 * listed second. Reading the directory first is the defect — a reader that
 * listed it before entry A arrived and read the legacy file after it shrank
 * would return a ledger without A (pinned in tests/debt-ledger.test.mjs).
 *
 * The re-check (3) is the general guard: any OTHER concurrent change to the
 * legacy bytes, and a file listed then gone, restarts the whole read. Bytes,
 * not existence — a shrink changes no existence at all.
 *
 * @param {ReturnType<typeof resolveLedgerLocation>} location
 * @param {{fs?: typeof fs, onDirectoryRead?: () => void}} [opts] - test seams
 * @returns {ReturnType<typeof buildState>|null} null when neither form exists
 * @throws {TransientLedgerReadError} when every attempt raced a mutation
 */
export function readLedgerState(location, { fs: fsImpl = fs, onDirectoryRead } = {}) {
  assertLedgerPathSafe(location, location.legacyFile, { expect: 'file' });
  let lastErr;
  for (let attempt = 1; attempt <= MAX_READ_ATTEMPTS; attempt++) {
    try {
      const before = readBytesOrNull(location.legacyFile, fsImpl);
      const dirExists = isDirectory(location.dir, fsImpl);
      if (!dirExists && before === null) return null;
      let dirEntries = null;
      let dirBudgets = { present: false, budgets: undefined };
      if (dirExists) {
        dirEntries = readEntryDir(location, { fs: fsImpl });
        dirBudgets = readBudgetsFile(location, { fs: fsImpl });
        if (onDirectoryRead) onDirectoryRead();
      }
      const after = readBytesOrNull(location.legacyFile, fsImpl);
      if (!sameBytes(before, after)) throw new TransientLedgerReadError('the legacy file changed during the read');
      return buildState(location, before, dirEntries, dirBudgets);
    } catch (err) {
      if (!(err instanceof TransientLedgerReadError)) throw err;
      lastErr = err;
      if (attempt < MAX_READ_ATTEMPTS) blockingSleep(10 * attempt);
    }
  }
  throw lastErr;
}

let _stateWarned = false;

/** One stderr line per process for a state an operator must act on. */
function warnStateOnce(state) {
  if (_stateWarned) return;
  if (state.conflicts.length) {
    _stateWarned = true;
    process.stderr.write(
      `  [debt] ${state.conflicts.length} debt-ledger record(s) differ between the per-entry files and the legacy file `
      + `(${state.conflicts.slice(0, 5).map((c) => c.topicId).join(', ')}${state.conflicts.length > 5 ? ', …' : ''}). `
      + 'Writers refuse them until resolved: node <tooling>/debt-ledger-migrate.mjs --prefer dir|legacy\n',
    );
  } else if (state.pendingReconcile) {
    _stateWarned = true;
    const p = state.pendingReconcile;
    process.stderr.write(
      `  [debt] a committed legacy debt ledger sits beside the per-entry ledger (${p.legacyOnly.length} id(s) only in it, `
      + `${p.differing.length} differing) — it is IGNORED until reconciled, so nothing deleted after the migration comes back. `
      + 'Reconcile it: node <tooling>/debt-ledger-migrate.mjs --stale-ref HEAD^2 (the stale branch\'s pre-merge tip; see the consumer-adoption runbook)\n',
    );
  }
}

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
 * a count is never printed without its source. `conflicts` / `pendingReconcile`
 * (per-entry storage, plan §2.2) are empty/null in every ordinary state.
 *
 * Corruption still THROWS (fail-loud). Unavailable is a weaker statement than
 * corrupt and must not swallow it: a malformed ledger is a defect to fix, not a
 * measurement that could not be taken.
 *
 * Plan: docs/plans/backlog-and-drift-reduction.md §2 "availability contract";
 * storage forms: docs/plans/debt-ledger-per-entry-files.md.
 *
 * @param {object} [opts]
 * @param {string} [opts.ledgerPath=DEFAULT_DEBT_LEDGER_PATH] - either spelling (`x.json` or `x`)
 * @param {object[]|null} [opts.events=null] - Pre-fetched events; if null, reads local log
 * @param {string} [opts.eventsPath=DEFAULT_DEBT_EVENTS_PATH]
 * @returns {{ version: 1, entries: object[], available: boolean, reason: string|null,
 *   budgets: Record<string, number>, conflicts: Array<{topicId: string, reason: string}>,
 *   pendingReconcile: object|null, storage: 'v2'|'legacy'|'both'|null }}
 */
export function readDebtLedger({
  ledgerPath = DEFAULT_DEBT_LEDGER_PATH,
  events = null,
  eventsPath = DEFAULT_DEBT_EVENTS_PATH,
} = {}) {
  const unavailable = (reason) => ({
    version: 1, entries: [], available: false, reason, budgets: {}, conflicts: [], pendingReconcile: null, storage: null,
  });
  const location = resolveLedgerLocation(ledgerPath);
  let state;
  try {
    state = readLedgerState(location);
  } catch (err) {
    // Exists but unreadable — or every attempt raced a concurrent mutation.
    // Never a measurement, so never an empty ledger. Content errors carry no
    // code and still throw.
    if (err instanceof TransientLedgerReadError || (err && UNREADABLE_CODES.has(err.code))) {
      return unavailable('ledger-unreadable');
    }
    throw err;
  }
  if (state === null) return unavailable('clean-checkout-sandbox');
  warnStateOnce(state);
  const hydrated = hydrateDebtEntries(state.entries, events ?? readDebtEventsLocal(eventsPath));
  return {
    version: 1,
    entries: hydrated,
    available: true,
    reason: null,
    budgets: state.budgets,
    conflicts: state.conflicts,
    pendingReconcile: state.pendingReconcile,
    storage: state.storage,
  };
}

/**
 * The PERSISTED entries — the authoritative view, without the event-derived
 * fields `readDebtLedger` adds. For a caller that rewrites an entry: persisting
 * a hydrated view would write recurrence metrics back into the ledger.
 *
 * @param {string} [ledgerPath=DEFAULT_DEBT_LEDGER_PATH]
 * @returns {object[]} [] when no ledger exists
 */
export function readPersistedDebtEntries(ledgerPath = DEFAULT_DEBT_LEDGER_PATH) {
  const state = readLedgerState(resolveLedgerLocation(ledgerPath));
  return state ? state.entries : [];
}

/**
 * Is there a ledger, in either storage form? For the call sites that must not
 * conflate "absent" with "present and empty" before they read.
 *
 * @param {string} [ledgerPath=DEFAULT_DEBT_LEDGER_PATH]
 * @returns {boolean}
 */
export function debtLedgerExists(ledgerPath = DEFAULT_DEBT_LEDGER_PATH) {
  const location = resolveLedgerLocation(ledgerPath);
  return fs.existsSync(location.legacyFile) || isDirectory(location.dir);
}

// ── Serialization ───────────────────────────────────────────────────────────

// The legacy single-file serializer now lives with the other storage primitives
// (debt-ledger-files.mjs) so the migration module can use it without an import
// cycle; re-exported here, where every existing caller imports it from.
export { serializeLedgerForDisk };

// ── Write (single lock, storage form chosen under it) ───────────────────────

let _legacyModeWarned = false;

/**
 * Decide the storage form for a mutation — UNDER the lock (plan §2.4):
 *
 *  1. v2 directory exists, or nothing exists → v2 (a fresh ledger is always v2).
 *  2. Legacy only, definitively untracked → migrate it automatically, then v2.
 *     An untracked file has no git consequences; that is the ONLY fact that
 *     makes an unattended migration safe.
 *  3. Legacy only, tracked or unknown → keep writing the legacy file (without
 *     `lastUpdated`). A writer runs inside a feature branch; migrating there
 *     would delete a committed file in N parallel branches while others still
 *     edit it. Committed state moves in one deliberate commit (the CLI).
 *  4. Both, untracked → fold the legacy file in, then v2. Both, tracked or
 *     unknown → v2 only; the legacy file waits for a reconcile, untouched —
 *     editing it would change the blob a stale-branch reconcile verifies.
 *
 * @returns {{kind: 'legacy'} | {kind: 'v2', state: object}}
 */
function openForWrite(location) {
  const legacyExists = readBytesOrNull(location.legacyFile) !== null;
  if (legacyExists) {
    const tracking = legacyTrackingState(location.legacyFile);
    if (tracking === 'untracked') {
      migrateLegacyLedgerLocked(location, { auto: true });
    } else if (!isDirectory(location.dir)) {
      if (!_legacyModeWarned) {
        _legacyModeWarned = true;
        process.stderr.write(
          `  [debt] ${path.basename(location.legacyFile)} is a ${tracking === 'tracked' ? 'committed' : 'possibly committed'} `
          + 'single-file debt ledger, so it is still written in that form, and two branches that both record debt can '
          + 'conflict on it. Move it to per-entry files in ONE commit on your default branch: '
          + 'node <tooling>/debt-ledger-migrate.mjs (see the consumer-adoption runbook).\n',
        );
      }
      return { kind: 'legacy' };
    }
  }
  if (!isDirectory(location.dir)) {
    assertLedgerPathSafe(location, location.entriesDir);
    fs.mkdirSync(location.entriesDir, { recursive: true });
  }
  return { kind: 'v2', state: readLedgerState(location) };
}

/** Read + validate the legacy file under the lock (corruption throws). */
function readLegacyForWrite(location) {
  const bytes = readBytesOrNull(location.legacyFile);
  if (bytes === null) return { version: 1, entries: [] };
  try {
    return parseLegacyBytes(bytes, location.legacyFile).raw;
  } catch (err) {
    throw new Error(`Debt ledger corrupted: ${err.message}`);
  }
}

/**
 * Rewrite the legacy file. `lastUpdated` is never written and is STRIPPED from
 * a file that still carries one: it was volatile provenance in a committed file
 * that every writer bumped, which made any two branches that recorded debt
 * conflict (plan §1, conflict source 1).
 */
function writeLegacyFile(location, raw, entries) {
  atomicWriteFileSync(location.legacyFile, serializeLedgerForDisk({
    version: 1,
    // `budgets` preserved — a write path once dropped it silently.
    ...(raw.budgets ? { budgets: raw.budgets } : {}),
    entries,
  }));
}

/**
 * Merge one validated incoming entry onto its existing record: preserve the
 * original deferral, take the incoming mutable fields, union `contentAliases`.
 */
function mergeEntry(existing, incoming) {
  if (!existing) return incoming;
  const mergedAliases = Array.from(new Set([
    ...(existing.contentAliases || []),
    ...(incoming.contentAliases || []),
  ]));
  return {
    ...existing,
    ...incoming,
    deferredAt: existing.deferredAt,       // immutable
    deferredRun: existing.deferredRun,     // immutable
    contentAliases: mergedAliases,
  };
}

/** Schema-normalise + validate one incoming entry; null + reason when invalid. */
function validateIncoming(entry) {
  // §2 Fix A — normalized HERE, at the actual write boundary, not only in the
  // `persistDebtEntries` facade: `debt-auto-capture.mjs` and `debt-backfill.mjs
  // --promote` both call `writeDebtEntries` directly. Idempotent.
  const validated = PersistedDebtEntrySchema.safeParse(normalizeClassificationEnvelope(entry));
  if (!validated.success) return { error: validated.error.message.slice(0, 300) };
  return { value: validated.data };
}

/**
 * Write or merge entries into the debt ledger under the ledger lock.
 * On topicId match with an existing entry: updates mutable fields in place
 * (rationale, classification, owner, etc). Does NOT insert duplicates.
 *
 * Invalid entries are returned in `rejected[]` with a per-entry reason,
 * matching Phase B's batchWriteLedger contract. Caller decides whether to
 * proceed or surface the failures. Per-entry storage adds two reasons: a topicId
 * that cannot be a filename, and one with an unresolved conflict.
 *
 * Per-entry storage writes N atomic files, not one atomic set: a crash mid-batch
 * leaves the first k entries written, each valid; a retry is idempotent.
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
  const location = resolveLedgerLocation(ledgerPath);
  assertLedgerDurability(location, cloudMirrored);

  return withLedgerLock(location, () => {
    const target = openForWrite(location);
    const rejected = [];
    let inserted = 0;
    let updated = 0;

    if (target.kind === 'legacy') {
      const current = readLegacyForWrite(location);
      const byTopic = new Map(current.entries.map((e) => [e.topicId, e]));
      for (const entry of entries) {
        const v = validateIncoming(entry);
        if (v.error) { rejected.push({ entry, reason: v.error }); continue; }
        if (byTopic.has(v.value.topicId)) updated++; else inserted++;
        byTopic.set(v.value.topicId, mergeEntry(byTopic.get(v.value.topicId), v.value));
      }
      // Sorted by topicId for stable diffs.
      const sorted = [...byTopic.values()].sort((a, b) => a.topicId.localeCompare(b.topicId));
      writeLegacyFile(location, current, sorted);
      return { inserted, updated, total: sorted.length, rejected };
    }

    const { state } = target;
    const byTopic = new Map(state.entries.map((e) => [e.topicId, e]));
    const conflicted = new Set(state.conflicts.map((c) => c.topicId));
    const pending = new Map();
    for (const entry of entries) {
      const v = validateIncoming(entry);
      if (v.error) { rejected.push({ entry, reason: v.error }); continue; }
      const id = v.value.topicId;
      const problem = topicIdFilenameProblem(id);
      if (problem) { rejected.push({ entry, reason: `topicId-not-a-safe-filename: ${problem}` }); continue; }
      if (conflicted.has(id)) { rejected.push({ entry, reason: 'topicId-unresolved-conflict' }); continue; }
      if (byTopic.has(id)) updated++; else inserted++;
      const merged = mergeEntry(byTopic.get(id), v.value);
      byTopic.set(id, merged);
      pending.set(id, merged);
    }
    for (const [id, merged] of pending) {
      const file = entryFilePath(location, id);
      assertLedgerPathSafe(location, file, { expect: 'file' });
      const bytes = serializeEntryForDisk(merged);
      const existing = readBytesOrNull(file);
      if (existing !== null && existing.toString('utf-8') === bytes) continue;
      atomicWriteFileSync(file, bytes);
    }
    return { inserted, updated, total: byTopic.size, rejected };
  });
}

/**
 * Remove a debt entry (soft-delete not supported — the audit trail lives in
 * the event log). Operates under the ledger lock.
 *
 * @param {string} topicId
 * @param {object} [opts]
 * @returns {Promise<boolean>} true if an entry was removed
 * @throws when the entry has an unresolved per-entry/legacy conflict
 */
export async function removeDebtEntry(topicId, { ledgerPath = DEFAULT_DEBT_LEDGER_PATH } = {}) {
  if (!debtLedgerExists(ledgerPath)) return false;
  const location = resolveLedgerLocation(ledgerPath);
  return withLedgerLock(location, () => {
    const target = openForWrite(location);
    if (target.kind === 'legacy') {
      const raw = readLegacyForWrite(location);
      const after = raw.entries.filter((e) => e.topicId !== topicId);
      if (after.length === raw.entries.length) return false;
      writeLegacyFile(location, raw, after);
      return true;
    }
    if (target.state.conflicts.some((c) => c.topicId === topicId)) {
      throw new Error(`debt entry ${topicId} has an unresolved conflict between its per-entry file and the legacy file — resolve it with debt-ledger-migrate.mjs --prefer dir|legacy first`);
    }
    // A topicId that cannot be a filename cannot be in the directory. (After the
    // automatic fold in `openForWrite`, an untracked legacy remainder holds only
    // conflicted ids, refused above; a tracked one is read-only by design.)
    if (topicIdFilenameProblem(topicId)) return false;
    const file = entryFilePath(location, topicId);
    assertLedgerPathSafe(location, file, { expect: 'file' });
    if (readBytesOrNull(file) === null) return false;
    fs.rmSync(file, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    return true;
  });
}

/**
 * Link `oldTopicId` to its replacement `newTopicId` by setting the old
 * entry's `supersededBy` field, under the same lock/atomic-write discipline
 * as `writeDebtEntries` (docs/plans/debt-ledger-persisted-record-contract.md
 * §2 Fix D). Verifies BOTH topicIds exist in this LOCAL ledger's authoritative
 * view immediately before writing (round-3 GPT audit H7) — never inferred from
 * an earlier write's outcome.
 *
 * **Local JSON only — no embedding-cache involvement** (Gemini gate round-1
 * G2): this module has no DB pool and no `repoId`; `debt_embeddings` cleanup
 * and any embedding-space concerns live exclusively in `store/debt.mjs`.
 *
 * **Historical-entry compatibility** (Gemini gate round-2 G4): the target
 * entry is run through `normalizeClassificationEnvelope` before
 * re-validation and write-back, so a historical entry with neither
 * `classification` nor `classificationUnavailableReason` is honestly
 * backfilled rather than either persisting a schema-violating row unchecked
 * or refusing supersession for a reason unrelated to `supersededBy`.
 *
 * @param {string} oldTopicId
 * @param {string} newTopicId
 * @param {object} [opts]
 * @param {string} [opts.ledgerPath=DEFAULT_DEBT_LEDGER_PATH]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function markSuperseded(oldTopicId, newTopicId, { ledgerPath = DEFAULT_DEBT_LEDGER_PATH } = {}) {
  if (oldTopicId === newTopicId) return { ok: false, error: 'self-reference' };
  if (!debtLedgerExists(ledgerPath)) return { ok: false, error: 'ledger-not-found' };
  const location = resolveLedgerLocation(ledgerPath);

  return withLedgerLock(location, () => {
    const target = openForWrite(location);
    if (target.kind === 'legacy') {
      const raw = readLegacyForWrite(location);
      const oldIdx = raw.entries.findIndex((e) => e.topicId === oldTopicId);
      if (oldIdx === -1) return { ok: false, error: 'old-topic-not-found' };
      if (!raw.entries.some((e) => e.topicId === newTopicId)) return { ok: false, error: 'new-topic-not-found' };
      const validated = PersistedDebtEntrySchema.safeParse(
        normalizeClassificationEnvelope({ ...raw.entries[oldIdx], supersededBy: newTopicId }),
      );
      if (!validated.success) return { ok: false, error: `schema-rejected: ${validated.error.message.slice(0, 300)}` };
      const entries = [...raw.entries];
      entries[oldIdx] = validated.data;
      writeLegacyFile(location, raw, entries);
      return { ok: true };
    }

    const { state } = target;
    if (state.conflicts.some((c) => c.topicId === oldTopicId || c.topicId === newTopicId)) {
      return { ok: false, error: 'unresolved-conflict' };
    }
    const old = state.entries.find((e) => e.topicId === oldTopicId);
    if (!old) return { ok: false, error: 'old-topic-not-found' };
    if (!state.entries.some((e) => e.topicId === newTopicId)) return { ok: false, error: 'new-topic-not-found' };
    const validated = PersistedDebtEntrySchema.safeParse(normalizeClassificationEnvelope({ ...old, supersededBy: newTopicId }));
    if (!validated.success) return { ok: false, error: `schema-rejected: ${validated.error.message.slice(0, 300)}` };
    const file = entryFilePath(location, oldTopicId);
    assertLedgerPathSafe(location, file, { expect: 'file' });
    atomicWriteFileSync(file, serializeEntryForDisk(validated.data));
    return { ok: true };
  });
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
  _resetWarnings() { _durabilityWarned = false; _trackedWarned = false; _legacyModeWarned = false; _stateWarned = false; },
};
