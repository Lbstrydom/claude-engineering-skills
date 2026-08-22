/**
 * @fileoverview Pure disposition schema/logic for the upstream-report ratchet
 * (consumer-friction-doctor plan §2.4). Every function here is pure — no fs,
 * no git, no DB — mirroring `scripts/lib/gate-honesty/ratchet.mjs`'s
 * pure-set/impure-shell split: `check-upstream-probe-coverage.mjs` does the
 * fs/git reads and calls `computeDispositionDivergences` with plain data.
 *
 * **Why this exists.** A closed upstream report (`state: fixed|wont_fix`)
 * previously required nothing but a commit sha. The ratchet requires a
 * `disposition` naming EITHER a doctor probe that now detects the failure
 * class, a tracked regression test that closes it, or a written exemption —
 * so closing a report can no longer be a no-op. The three-way split is
 * empirical, not aesthetic: the measured base rate (§1) is ~5 of 20 closed
 * reports are environment/adoption classes a probe CAN detect, and ~15 are
 * ordinary code defects a probe structurally cannot ("LIMIT 20 with no ORDER
 * BY" has no environment signature) — a probe-or-exempt binary would push
 * 75% of closures into `exempt`, and an exemption everyone uses is not a
 * ratchet.
 *
 * @module scripts/lib/upstream/dispositions
 */

export const DISPOSITION_KINDS = Object.freeze(['probe', 'test', 'exempt']);

/**
 * The catch-all sentinel `backfill-upstream-dispositions.mjs` writes for any
 * terminal row closed in the race window between migration generation and
 * deployment (plan §2.4). Shared with `computeLedgerReconciliation` below so
 * the two never drift on the literal string — a row carrying this EXACT
 * value is always a "needs human review" flag, never a real disposition
 * anyone researched (round-1 audit M13/H11 — GPT: "the race must be made
 * operationally visible", not merely tolerated).
 */
export const LEGACY_UNTRACKED_TRANSITION = 'exempt:legacy-untracked-transition';

/** Ledger schema version — bump on a breaking shape change. */
export const LEDGER_SCHEMA_VERSION = 1;

/**
 * The tracked-test glob a `test:` disposition's path must match. Mirrors
 * `run-tests.mjs`'s own collection set — `tests/fixtures/**` holds INPUTS to
 * suites, not suites themselves, and would be an unfixable false positive if
 * cited (the same distinction `check-db-suite-enrolment.mjs`'s
 * `NOT_A_SUITE_DIR` makes).
 */
export const TEST_GLOB_PREFIX = 'tests/';
export const TEST_GLOB_SUFFIX = '.test.mjs';
export const TEST_GLOB_EXCLUDE_PREFIX = 'tests/fixtures/';

/**
 * `probe:<id>` / `test:<path>` / `exempt:<reason>` -> `{kind, value}`.
 *
 * Splits on the FIRST colon only — a `test:` path is always repo-relative
 * POSIX (never a Windows drive letter, so no ambiguity), and an `exempt:`
 * reason is free-text prose that may legitimately contain a colon of its own
 * ("reason: this is pre-2026 legacy state").
 *
 * @param {string} raw e.g. `"probe:hydration/remedy-missing"`
 * @returns {{ok: true, kind: string, value: string} | {ok: false, error: string}}
 */
export function parseDisposition(raw) {
  const s = String(raw ?? '');
  const i = s.indexOf(':');
  if (i === -1) {
    return {
      ok: false,
      error: `--disposition "${raw}" is not of the form <kind>:<value> — expected one of `
        + `${DISPOSITION_KINDS.map((k) => `${k}:...`).join(', ')}`,
    };
  }
  const kind = s.slice(0, i).trim();
  const value = s.slice(i + 1).trim();
  if (!DISPOSITION_KINDS.includes(kind)) {
    return {
      ok: false,
      error: `--disposition kind "${kind}" is not one of ${DISPOSITION_KINDS.join('|')}`,
    };
  }
  if (!value) {
    return { ok: false, error: `--disposition "${raw}" has an empty value after "${kind}:"` };
  }
  return { ok: true, kind, value };
}

/** Render `{kind, value}` back to the `<kind>:<value>` wire form. */
export function formatDisposition({ kind, value }) {
  return `${kind}:${value}`;
}

/**
 * Is `path` a legal `test:` disposition target — TRACKED (not merely present
 * on disk; an untracked file proves nothing about CI) and matching the
 * enforced test glob?
 *
 * @param {string} path repo-relative, POSIX-separated
 * @param {{trackedFiles: Set<string>}} data injected — the caller resolved
 *   `git ls-files` once, not per-entry
 * @returns {{ok: boolean, reason?: string}}
 */
export function isLegalTestDisposition(path, { trackedFiles }) {
  if (!trackedFiles.has(path)) {
    return { ok: false, reason: `"${path}" is not a tracked file (git ls-files) — an untracked file proves nothing about CI` };
  }
  if (!path.startsWith(TEST_GLOB_PREFIX) || !path.endsWith(TEST_GLOB_SUFFIX)) {
    return { ok: false, reason: `"${path}" does not match ${TEST_GLOB_PREFIX}**/*${TEST_GLOB_SUFFIX}` };
  }
  if (path.startsWith(TEST_GLOB_EXCLUDE_PREFIX)) {
    return { ok: false, reason: `"${path}" is under ${TEST_GLOB_EXCLUDE_PREFIX} — fixtures are inputs to a suite, not a suite` };
  }
  return { ok: true };
}

/**
 * Validate one ledger entry's SHAPE (schema-level — the cross-referential
 * probe/test/duplicate checks live in `computeDispositionDivergences`, which
 * needs the whole ledger to detect a duplicate `issueId`).
 *
 * @param {unknown} entry
 * @returns {string[]} problems; empty means shape-valid
 */
export function validateLedgerEntryShape(entry) {
  const problems = [];
  if (!entry || typeof entry !== 'object') {
    return ['entry is not an object'];
  }
  if (entry.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${LEDGER_SCHEMA_VERSION}, got ${JSON.stringify(entry.schemaVersion)}`);
  }
  // A real UUID shape (round-1 audit M15) — the previous
  // `[0-9a-f-]{8,36}` accepted any mix of hex/hyphens in that length range,
  // including malformed strings like "aaaa----aaaa" or a bare 8-hex prefix.
  if (typeof entry.issueId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.issueId)) {
    problems.push(`issueId must be a uuid-shaped string, got ${JSON.stringify(entry.issueId)}`);
  }
  if (!['fixed', 'wont_fix'].includes(entry.state)) {
    problems.push(`state must be "fixed" or "wont_fix" (only terminal states carry a disposition), got ${JSON.stringify(entry.state)}`);
  }
  if (!entry.disposition || typeof entry.disposition !== 'object') {
    problems.push('disposition must be an object');
  } else {
    if (!DISPOSITION_KINDS.includes(entry.disposition.kind)) {
      problems.push(`disposition.kind must be one of ${DISPOSITION_KINDS.join('|')}, got ${JSON.stringify(entry.disposition.kind)}`);
    }
    if (typeof entry.disposition.value !== 'string' || !entry.disposition.value.trim()) {
      problems.push('disposition.value must be a non-empty string');
    // eslint-disable-next-line no-control-regex -- deliberately matching control chars to REJECT them
    } else if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(entry.disposition.value)) {
      // Round-4 audit M15: a NUL (or other C0 control) byte passes the
      // non-empty/.trim() check above but Postgres text columns cannot store
      // a NUL byte at all, and the generated backfill SQL's sqlEscape only
      // escapes single quotes — a control character reaching that far
      // produces invalid or silently-mangled SQL rather than a clear
      // rejection at the point the bad data was actually introduced.
      problems.push('disposition.value contains a control character (including NUL), which Postgres cannot store and generated SQL cannot safely escape');
    }
  }
  // Round-2 audit L1: `Date.parse` alone is far more lenient than ISO-8601 —
  // it also accepts "January 1, 2026", "01/01/2026", etc. Every writer in
  // this codebase produces `new Date().toISOString()`, so requiring that
  // exact shape rejects anything a human hand-edited into a technically
  // Date.parse-able but non-ISO string.
  const isoMatch = typeof entry.recordedAt === 'string'
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(entry.recordedAt)
    : null;
  // Round-5 audit L1: the shape regex alone doesn't reject an overflowed
  // calendar value — `Date.parse('2026-02-30T00:00:00Z')` NORMALIZES to
  // March 2 rather than failing, so `Number.isNaN(...)` never catches it.
  // Round-trip the individually-parsed numeric fields (not the whole
  // string — `toISOString()` always emits 3 fractional digits, which would
  // false-reject a legitimate no-fraction timestamp) against the SAME
  // fields read back off the constructed UTC Date; JS silently rolling
  // Feb 30 into March 2 makes those disagree.
  if (!isoMatch) {
    problems.push(`recordedAt must be an ISO-8601 UTC timestamp (e.g. new Date().toISOString()), got ${JSON.stringify(entry.recordedAt)}`);
  } else {
    const [, y, mo, d, h, mi, s] = isoMatch.map(Number);
    const asDate = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
    const roundTrips = !Number.isNaN(asDate.getTime())
      && asDate.getUTCFullYear() === y && asDate.getUTCMonth() === mo - 1 && asDate.getUTCDate() === d
      && asDate.getUTCHours() === h && asDate.getUTCMinutes() === mi && asDate.getUTCSeconds() === s;
    if (!roundTrips) {
      problems.push(`recordedAt is not a real calendar date/time (overflowed field), got ${JSON.stringify(entry.recordedAt)}`);
    }
  }
  return problems;
}

/**
 * The full ratchet-gate rule set, as a PURE function over already-loaded
 * data — mirrors `gate-honesty/ratchet.mjs`'s `computeRatchetDivergences`.
 *
 * @param {object} args
 * @param {Array<object>} args.ledgerEntries parsed `scripts/upstream-dispositions.json`
 * @param {string[]} args.registryProbeIds `probeIds()` from `lib/doctor/registry.mjs`
 * @param {Set<string>} args.trackedTestFiles `git ls-files` output, POSIX paths
 * @returns {{divergences: string[], sharedPathWarnings: string[]}}
 */
export function computeDispositionDivergences({ ledgerEntries, registryProbeIds, trackedTestFiles }) {
  const divergences = [];
  const probeIdSet = new Set(registryProbeIds);
  const seenIssueIds = new Set();
  const testPathCounts = new Map();

  for (const entry of ledgerEntries) {
    const shapeProblems = validateLedgerEntryShape(entry);
    if (shapeProblems.length > 0) {
      divergences.push(`entry ${JSON.stringify(entry?.issueId ?? entry)}: ${shapeProblems.join('; ')}`);
      continue; // cross-referential checks below need a shape-valid entry
    }

    if (seenIssueIds.has(entry.issueId)) {
      divergences.push(`duplicate issueId ${entry.issueId} — exactly one active disposition per upstream issue`);
    }
    seenIssueIds.add(entry.issueId);

    const { kind, value } = entry.disposition;
    if (kind === 'probe') {
      if (!probeIdSet.has(value)) {
        divergences.push(`issue ${entry.issueId}: disposition probe:"${value}" does not resolve in scripts/lib/doctor/registry.mjs`);
      }
    } else if (kind === 'test') {
      const check = isLegalTestDisposition(value, { trackedFiles: trackedTestFiles });
      if (!check.ok) {
        divergences.push(`issue ${entry.issueId}: disposition test:"${value}" is illegal — ${check.reason}`);
      } else {
        testPathCounts.set(value, (testPathCounts.get(value) ?? 0) + 1);
      }
    }
    // kind === 'exempt': the non-empty-value check already ran in
    // validateLedgerEntryShape — no further cross-reference needed.
  }

  // Advisory-only, deterministic (closes R2-M1): a test: path cited by 3+
  // entries is a taxonomy smell worth a human look, never a failure — the
  // schema has no free-text "why is this shared" field, so the gate cannot
  // adjudicate WHY, only COUNT.
  const sharedPathWarnings = [...testPathCounts.entries()]
    .filter(([, count]) => count >= 3)
    .map(([path, count]) => `test:"${path}" is cited by ${count} entries — consider whether that reflects one genuinely broad regression test or an under-specified taxonomy`);

  return { divergences, sharedPathWarnings };
}

/**
 * The reconciler (plan §2.4) — the BIDIRECTIONAL check
 * `computeDispositionDivergences` structurally cannot do, because it only
 * ever sees the ledger file. This function is what makes the ledger-then-DB
 * write ordering's accepted crash-window gap into something ACTUALLY
 * checked, not merely documented (round-1 audit H2, GPT: "a test that
 * asserts the divergence occurs documents the flaw rather than containing
 * it").
 *
 * Two directions, both real:
 *   1. **DB → ledger**: a terminal DB row (`state: fixed|wont_fix`) with no
 *      matching ledger entry. This is the crash-between-ledger-and-DB-write
 *      gap the plan already names, now actually surfaced.
 *   2. **ledger → DB**: a ledger entry whose issueId either doesn't
 *      correspond to a KNOWN db row at all, or whose db row's `state` no
 *      longer matches what the ledger recorded (round-1 audit H2's sharper
 *      point — the ORIGINAL reconciler description only checked direction 1).
 *
 * Also compares the terminal DISPOSITION VALUE itself, not just presence/state
 * (round-2 audit M12 — the original version selected `disposition` from the DB
 * row and then never read it): a row whose disposition text differs from what
 * the ledger recorded for the same issueId is flagged distinctly, since either
 * side could be the stale one (a later, out-of-band DB edit; or a ledger
 * amendment that never got its own migration).
 *
 * Additionally flags any db row carrying the exact
 * `LEGACY_UNTRACKED_TRANSITION` sentinel as `needsReview` — closing M13/H11:
 * the backfill catch-all's usage becomes a visible, actionable item here,
 * not a silent, permanent-looking exemption.
 *
 * Pure — `dbRows`/`ledgerEntries` are both plain data the caller already
 * fetched; this function does no I/O.
 *
 * @param {object} args
 * @param {Array<{issueId: string, state: string, disposition: string|null}>} args.dbRows
 *   every TERMINAL (fixed|wont_fix) `upstream_issues` row, as returned by the store
 * @param {Array<{issueId: string, state: string, disposition: {kind:string,value:string}}>} args.ledgerEntries
 * @returns {{
 *   missingFromLedger: string[],
 *   ledgerOnly: string[],
 *   stateMismatch: string[],
 *   dispositionMismatch: string[],
 *   needsReview: string[],
 * }}
 */
export function computeLedgerReconciliation({ dbRows, ledgerEntries }) {
  const ledgerByIssueId = new Map(ledgerEntries.map((e) => [e.issueId, e]));
  const dbByIssueId = new Map(dbRows.map((r) => [r.issueId, r]));

  const missingFromLedger = [];
  const stateMismatch = [];
  const dispositionMismatch = [];
  const needsReview = [];

  for (const row of dbRows) {
    const entry = ledgerByIssueId.get(row.issueId);
    if (!entry) {
      missingFromLedger.push(row.issueId);
    } else {
      if (entry.state !== row.state) {
        stateMismatch.push(`${row.issueId}: ledger says "${entry.state}", db says "${row.state}"`);
      }
      const ledgerDisposition = entry.disposition ? formatDisposition(entry.disposition) : null;
      if (ledgerDisposition !== row.disposition) {
        dispositionMismatch.push(`${row.issueId}: ledger says "${ledgerDisposition}", db says "${row.disposition}"`);
      }
    }
    if (row.disposition === LEGACY_UNTRACKED_TRANSITION) {
      needsReview.push(row.issueId);
    }
  }

  const ledgerOnly = [...ledgerByIssueId.keys()].filter((id) => !dbByIssueId.has(id));

  return { missingFromLedger, ledgerOnly, stateMismatch, dispositionMismatch, needsReview };
}
