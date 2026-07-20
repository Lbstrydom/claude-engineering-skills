/**
 * @fileoverview Phase 3 per-session JSON ledger — atomic writes; mandatory
 * persistence for every terminal state.
 *
 * Plan: docs/plans/persona-test-consistency-mode.md.
 *
 * Critical guarantees (resolves R1-H6, R2-H2, Gemini-G1):
 *   - The ledger file is opened (with a minimal initial record) BEFORE any
 *     work begins. If the destination is not writable the runner fails fast
 *     at exit 4 (LEDGER_PERSIST_FAILED) BEFORE doing anything else.
 *   - Every terminal state — healthy / broken / partial / fatal / app-error
 *     — persists a closed ledger before process exit. Zero-step ledgers are
 *     a first-class valid record (manifest-missing produces one).
 *   - Atomic writes via the project's `atomicWriteFileSync` (temp + rename).
 *   - `normaliseForReplay(ledger)` strips ALL nondeterministic operational
 *     telemetry so two runs of the same canary + same fixtureSeed produce
 *     byte-identical normalised output (Gemini-R4-G3 + R5).
 *
 * @module scripts/lib/persona-test/ledger
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../file-io.mjs';
import { SessionLedgerSchema } from './schemas.mjs';

export const SESSIONS_DIR = path.join('.persona-test', 'sessions');

/**
 * @typedef {object} OpenLedgerOpts
 * @property {string|null} canaryName
 * @property {string}      journeyKey
 * @property {string|null} [fixtureSeed]
 * @property {string}      [now]            - ISO timestamp injected for tests; otherwise new Date()
 * @property {string}      [outPath]        - Override the ledger destination (the runner's `--out`).
 *                                            Relative paths resolve against repoRoot; absolute are
 *                                            honoured, since a CI artifact dir is a legitimate target.
 */

/**
 * Open a ledger and write the initial record. Returns a handle exposing
 * step appends, candidate id tracking, verdict updates, and close.
 *
 * The initial record is persisted IMMEDIATELY (before any step runs) so a
 * runner crash during journey execution still leaves a record with
 * `rigVerdict='fatal'` + `truncated:true` — never an empty session file.
 *
 * @param {string} repoRoot
 * @param {string} sessionId
 * @param {OpenLedgerOpts} opts
 * @returns {{
 *   ledgerPath: string,
 *   state: object,
 *   appendStep(stepRecord: object): void,
 *   recordCandidate(specId: string): void,
 *   setVerdicts(updates: object): void,
 *   close(): object,
 * }}
 */
export function openLedger(repoRoot, sessionId, opts) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new Error('openLedger: repoRoot is required');
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('openLedger: sessionId is required');
  }
  if (!opts || typeof opts.journeyKey !== 'string' || opts.journeyKey.length === 0) {
    throw new Error('openLedger: opts.journeyKey is required');
  }

  // `outPath` honours the runner's `--out`. It was parsed and documented in
  // --help but never threaded here (#41, open 2026-05-21): callers who passed
  // it got the default path with no error, so a CI step uploading a fixed
  // artifact path silently found nothing. An output path the operator typed is
  // deliberately NOT contained to repoRoot — a CI artifact directory outside
  // the checkout is the motivating use case.
  const ledgerPath = opts.outPath
    ? path.resolve(repoRoot, opts.outPath)
    : path.join(repoRoot, SESSIONS_DIR, `${sessionId}.json`);
  // mkdir the ACTUAL parent, not SESSIONS_DIR — an --out into a fresh directory
  // must not fail the write-once probe that exists to fail fast at exit 4.
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });

  const startedAt = opts.now || new Date().toISOString();

  // Initial record — pessimistic defaults. `close()` resolves them.
  const ledger = {
    schemaVersion: 1,
    sessionId,
    canaryName: opts.canaryName ?? null,
    journeyKey: opts.journeyKey,
    fixtureSeed: opts.fixtureSeed ?? null,
    authKind: opts.authKind ?? 'none',
    startedAt,
    steps: [],
    candidateSpecIds: [],
    rigVerdict: 'fatal',
    canaryVerdict: 'not-applicable',
    failureReason: 'session-not-yet-closed',
    stepFailureReason: null,
    truncated: true,
    endedAt: startedAt,
  };

  // Write-once probe: confirms the path is writable before the runner does
  // anything else. If this throws, the runner exits 4 immediately.
  persist(ledgerPath, ledger);

  return {
    ledgerPath,
    state: ledger,

    appendStep(stepRecord) {
      ledger.steps.push(stepRecord);
      persist(ledgerPath, ledger);
    },

    recordCandidate(specId) {
      if (!ledger.candidateSpecIds.includes(specId)) {
        ledger.candidateSpecIds.push(specId);
      }
      persist(ledgerPath, ledger);
    },

    setVerdicts(updates) {
      if (!updates || typeof updates !== 'object') return;
      if (typeof updates.rigVerdict === 'string')       ledger.rigVerdict = updates.rigVerdict;
      if (typeof updates.canaryVerdict === 'string')    ledger.canaryVerdict = updates.canaryVerdict;
      if (updates.failureReason !== undefined)          ledger.failureReason = updates.failureReason;
      if (updates.stepFailureReason !== undefined)      ledger.stepFailureReason = updates.stepFailureReason;
      if (typeof updates.truncated === 'boolean')       ledger.truncated = updates.truncated;
      // No persist here — close() does the final write. setVerdicts is an
      // in-memory operation so multiple updates batch into one disk write.
    },

    close(now) {
      ledger.endedAt = now || new Date().toISOString();
      // If still at the pessimistic default, the caller forgot to set verdicts —
      // we DON'T silently mask that. The schema validates rigVerdict ∈ enum;
      // 'fatal' + 'session-not-yet-closed' is a clear sentinel.
      if (ledger.failureReason === 'session-not-yet-closed' && ledger.rigVerdict === 'fatal') {
        // Leave as-is — this is the "abort before verdict" signal, valid.
      }
      const result = SessionLedgerSchema.safeParse(ledger);
      if (!result.success) {
        throw new Error(`closeLedger: schema validation failed: ${result.error.message}`);
      }
      persist(ledgerPath, result.data);
      return result.data;
    },
  };
}

function persist(ledgerPath, ledger) {
  atomicWriteFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

// ────────────────────────────────────────────────────────────────────────────
// normaliseForReplay — strips ALL nondeterministic operational telemetry.
// Two runs with the same canary + same fixtureSeed produce byte-identical
// normalised output.
// ────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} ledger - a parsed SessionLedger
 * @returns {object} a new (deep-cloned) ledger with timestamps + durations
 *                   stripped and arrays sorted by stable key
 */
export function normaliseForReplay(ledger) {
  if (!ledger || typeof ledger !== 'object') {
    throw new Error('normaliseForReplay: ledger must be an object');
  }
  const out = JSON.parse(JSON.stringify(ledger));

  // Top-level timestamps.
  out.startedAt = '';
  out.endedAt = '';

  if (Array.isArray(out.steps)) {
    for (const step of out.steps) {
      step.durationMs = 0;

      if (step.witness) {
        // Strip per-claim timestamps.
        if (Array.isArray(step.witness.networkClaims)) {
          for (const n of step.witness.networkClaims) {
            n.receivedAt = '';
            // sourceUrl is part of the deterministic match key in v1 — keep.
          }
          step.witness.networkClaims.sort(stableCompareNetwork);
        }
        if (Array.isArray(step.witness.domClaims)) {
          step.witness.domClaims.sort(stableCompareDom);
        }
        if (Array.isArray(step.witness.undeclaredDomClaims)) {
          step.witness.undeclaredDomClaims.sort(stableCompareUndeclared);
        }
      }

      // Contradictions, freshness, warnings — already deterministic; sort
      // by stable key so out-of-order emission doesn't change replay output.
      if (Array.isArray(step.contradictions)) step.contradictions.sort(stableCompareContradiction);
      if (Array.isArray(step.freshness))      step.freshness.sort(stableCompareFreshness);
      if (Array.isArray(step.warnings))       step.warnings.sort(stableCompareWarning);
    }
  }

  return out;
}

// Stable comparators — defined once, used both by normaliseForReplay tests
// and by the runner if it wants to render a deterministic report.
function s(v) { return v == null ? '' : String(v); }

function stableCompareDom(a, b) {
  return (
    s(a.surfaceId).localeCompare(s(b.surfaceId)) ||
    s(a.engineField).localeCompare(s(b.engineField)) ||
    s(a.scope).localeCompare(s(b.scope)) ||
    s(a.key).localeCompare(s(b.key))
  );
}
function stableCompareNetwork(a, b) {
  return (
    s(a.surfaceId).localeCompare(s(b.surfaceId)) ||
    s(a.engineField).localeCompare(s(b.engineField)) ||
    s(a.scope).localeCompare(s(b.scope)) ||
    s(a.key).localeCompare(s(b.key))
  );
}
function stableCompareUndeclared(a, b) {
  return (
    s(a.engineField).localeCompare(s(b.engineField)) ||
    s(a.selector).localeCompare(s(b.selector))
  );
}
function stableCompareContradiction(a, b) {
  return (
    s(a.kind).localeCompare(s(b.kind)) ||
    s(a.surfaceId).localeCompare(s(b.surfaceId)) ||
    s(a.engineField).localeCompare(s(b.engineField)) ||
    s(a.scope).localeCompare(s(b.scope)) ||
    s(a.key).localeCompare(s(b.key))
  );
}
function stableCompareFreshness(a, b) {
  return (
    s(a.surfaceId).localeCompare(s(b.surfaceId)) ||
    s(a.engineField).localeCompare(s(b.engineField))
  );
}
function stableCompareWarning(a, b) {
  return (
    s(a.kind).localeCompare(s(b.kind)) ||
    s(a.surfaceId).localeCompare(s(b.surfaceId))
  );
}

// Test-internal exports.
export const _internals = Object.freeze({
  persist,
  stableCompareDom,
  stableCompareNetwork,
  stableCompareUndeclared,
  stableCompareContradiction,
});
