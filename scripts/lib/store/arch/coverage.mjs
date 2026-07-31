/**
 * @fileoverview symbol_refresh_coverage — the observed graph's honesty record.
 *
 * Owns 3 exports: recordGraphCoverage, getGraphCoverage, copyForwardCoverage.
 *
 * Sibling of `imports.mjs`; same best-effort posture as the rest of the store
 * layer — a cloud failure degrades the measurement, it never fails the
 * refresh, because the symbol index is independently valuable (#16).
 *
 * ONE deliberate asymmetry with the rest of the store: a read that fails does
 * NOT return an empty/clean-looking result. It returns null, and the caller
 * maps null to `unknown`/`not_measured`. In a feature whose entire purpose is
 * refusing to overclaim, a swallowed read error that renders as "verified"
 * would be the bug reborn.
 *
 * Plan: docs/plans/observed-graph-coverage-honesty.md §2.1.7
 *
 * @module scripts/lib/store/arch/coverage
 */

import { one, upsert } from '../../db/query.mjs';
import { isCloudEnabled } from '../repo.mjs';
import { CoverageSchema } from '../../coverage-schema.mjs';

/**
 * Persist the coverage record for a refresh.
 *
 * `payload` is the whole §2.1.6b object; the promoted columns are derived from
 * it here, in ONE place, so they cannot disagree with the jsonb they summarise.
 *
 * jsonb is passed RAW — `serializeWriteParam` in the db layer handles it
 * (AGENTS.md "jsonb-safe write seam"). Hand-stringifying would double-encode.
 *
 * @param {string} refreshId - the snapshot this coverage BELONGS to
 * @param {object} coverage - the §2.1.6b record
 * @returns {Promise<{recorded: boolean, reason?: string}>}
 */
export async function recordGraphCoverage(refreshId, coverage) {
  if (!refreshId || !coverage || typeof coverage !== 'object') {
    return { recorded: false, reason: 'invalid-input' };
  }
  if (!await isCloudEnabled()) return { recorded: false, reason: 'cloud-disabled' };

  // The write boundary must actually ENFORCE CoverageSchema, not just declare
  // it (round-2 audit M2/M4): before this fix, only `coverage.verdict?.status`
  // truthiness was checked, so any object with a status string — including one
  // that contradicts its own extraction/stale fields per the schema's
  // cross-field precedence check — was written verbatim.
  const validation = CoverageSchema.safeParse(coverage);
  if (!validation.success) {
    process.stderr.write(`  [coverage] schema validation failed — NOT persisted: ${validation.error.issues.map((i) => i.message).join('; ')}\n`);
    return { recorded: false, reason: 'schema-invalid' };
  }

  // Read from `validation.data`, NOT the raw input. Zod object schemas STRIP
  // unknown keys, so the parsed value and the caller's object are not the same
  // thing — persisting the raw one would write unvalidated extra fields into
  // the jsonb payload and make the schema's output not the source of truth for
  // what lands in the row. Validating and then using the unvalidated object is
  // the subtler half of "the write boundary must ENFORCE the schema".
  const validated = validation.data;
  const status = validated.verdict.status;
  const reason = validated.verdict.reason ?? null;

  try {
    const res = await upsert('symbol_refresh_coverage', [{
      refresh_id: refreshId,
      status,
      reason,
      stale: validated.stale === true,
      measured_at: validated.measuredAt,
      // When copied forward, the measuring run is NOT this refresh. Preserving
      // it is what lets the dashboard say "measured 3 refreshes ago" rather
      // than implying this run measured anything.
      measured_refresh_id: validated.refreshId || refreshId,
      payload: validated,
    }], { onConflict: ['refresh_id'], update: 'all' });
    // A non-throwing upsert is NOT proof of persistence — an RLS policy or a
    // no-op conflict resolution can return zero rows without error. Claiming
    // `recorded: true` on that basis is the unverified-write-success class
    // AGENTS.md rates HIGH, and here it would mean the render later reads no
    // coverage and renders `unknown` while the refresh logged success.
    const rowCount = res?.rowCount ?? 0;
    if (rowCount === 0) {
      process.stderr.write('  [coverage] upsert affected 0 rows — coverage NOT persisted\n');
      return { recorded: false, reason: 'zero-rows-affected' };
    }
    return { recorded: true };
  } catch (err) {
    // Loud on stderr, never thrown: the symbol index still publishes.
    process.stderr.write(`  [coverage] persist failed: ${err.message}\n`);
    return { recorded: false, reason: `db-error: ${err.message}` };
  }
}

/**
 * Read the coverage record for a refresh.
 *
 * Returns `null` for BOTH "no row" and "read failed" — the caller must map
 * null to `unknown`/`not_measured`, never to a clean verdict. The two are
 * deliberately not distinguished in the return value because the correct
 * handling is identical: we do not know, so we must not claim.
 *
 * @param {string} refreshId
 * @returns {Promise<object|null>} the §2.1.6b payload, or null
 */
export async function getGraphCoverage(refreshId) {
  if (!refreshId || !await isCloudEnabled()) return null;
  try {
    const row = await one(
      `SELECT payload FROM symbol_refresh_coverage WHERE refresh_id = $1`,
      [refreshId]
    );
    if (!row?.payload) return null;

    // VALIDATE ON READ TOO, not only on write. Rows predating a schema
    // tightening — or inserted by hand — bypass every cross-field invariant the
    // write boundary enforces, and this function's callers render its result as
    // a coverage VERDICT. Returning a structurally invalid payload would let a
    // record that contradicts itself present as evidence, which is the exact
    // failure this module exists to prevent.
    //
    // An invalid payload maps to `null`, deliberately identical to "no row" and
    // "read failed": the doc above states callers must map null to
    // `unknown`/`not_measured`, so an untrustworthy record degrades to "we do
    // not know" rather than to a clean verdict.
    const parsed = CoverageSchema.safeParse(row.payload);
    if (!parsed.success) {
      process.stderr.write(
        `  [coverage] stored payload for ${refreshId} fails the schema — treating as unknown: `
        + `${parsed.error.issues.map((i) => i.message).join('; ')}\n`,
      );
      return null;
    }
    return parsed.data;
  } catch (err) {
    process.stderr.write(`  [coverage] read failed: ${err.message}\n`);
    return null;
  }
}

/**
 * Copy an earlier run's coverage onto a new refresh, marked stale.
 *
 * Mirrors `copyForwardImports`. Coverage is a FULL-RUN measurement, so an
 * incremental refresh inherits the numbers for DISPLAY but never the verdict:
 * `stale: true` forces `unknown`/`stale_measurement` at precedence row 4 —
 * UNLESS the prior extraction never actually succeeded (`failed`/`timedOut`),
 * in which case graph-verdict.mjs's own precedence (rows 1-2, checked BEFORE
 * staleness at row 4) means the verdict was already `unverified` and staying
 * that way is correct: there is nothing that "went stale" about a measurement
 * that never completed. Unconditionally overwriting it to unknown/
 * stale_measurement would launder a genuine extraction failure into a merely
 * "not fresh" reading (round-1 audit H2 — this asymmetry is exactly what
 * observed-deps.mjs's `CoverageSchema` cross-field check now rejects).
 *
 * This is categorical rather than heuristic on purpose. An earlier design
 * compared a digest of the eligible-file LIST, which is false comfort —
 * editing a file's imports (adding edges, making them untagged, making the
 * file uncruisable) leaves the list byte-identical, so the digest matches and
 * a stale `verified` survives.
 *
 * @param {{fromRefreshId: string, toRefreshId: string}} params
 * @returns {Promise<{copied: boolean, reason?: string}>}
 */
export async function copyForwardCoverage({ fromRefreshId, toRefreshId } = {}) {
  if (!fromRefreshId || !toRefreshId) return { copied: false, reason: 'invalid-input' };
  // Copying a refresh's coverage onto ITSELF (round-4 audit H2/M3) would
  // read its own just-persisted row and immediately overwrite it stale —
  // corrupting a genuinely fresh measurement under the guise of "forwarding"
  // it. The function's whole contract is EARLIER run -> NEW refresh; the
  // same id on both sides is never a valid call.
  if (fromRefreshId === toRefreshId) return { copied: false, reason: 'invalid-input' };
  const prior = await getGraphCoverage(fromRefreshId);
  if (!prior) return { copied: false, reason: 'no-prior-coverage' };

  const priorOutcome = prior.extraction?.outcome;
  const neverSucceeded = priorOutcome === 'failed' || priorOutcome === 'timedOut';

  const stale = {
    ...prior,
    stale: true,
    // measuredAt + refreshId are preserved from the ORIGINAL measurement —
    // that is the whole point of copying forward rather than re-stamping.
    verdict: neverSucceeded ? prior.verdict : { status: 'unknown', reason: 'stale_measurement' },
  };
  // Never overwrite a FRESH measurement with a copied-forward stale one — and
  // enforce that IN THE STATEMENT, not as a read-then-write check.
  //
  // `recordGraphCoverage` upserts with `update: 'all'`, i.e. last-one-wins, so a
  // copy-forward could replace a real measurement with older numbers marked
  // `stale` — downgrading genuine evidence to "we don't know", the exact
  // overclaim-in-reverse this module exists to prevent. A read-then-write guard
  // was written first and was wrong for the same reason a CLI-resolved repoId is
  // not a tenant boundary: between the read and the write, the row can change.
  // The `WHERE` below closes that window; Postgres evaluates it as part of the
  // conflict resolution, so there is no interleaving to lose.
  //
  // `xmax = 0` distinguishes a fresh INSERT from an UPDATE, so a genuinely new
  // row is reported as copied while a refused overwrite is not.
  try {
    const row = await one(
      `INSERT INTO symbol_refresh_coverage
         (refresh_id, status, reason, stale, measured_at, measured_refresh_id, payload)
       VALUES ($1, $2, $3, TRUE, $4, $5, $6)
       ON CONFLICT (refresh_id) DO UPDATE
         SET status = EXCLUDED.status, reason = EXCLUDED.reason, stale = EXCLUDED.stale,
             measured_at = EXCLUDED.measured_at,
             measured_refresh_id = EXCLUDED.measured_refresh_id,
             payload = EXCLUDED.payload
         WHERE symbol_refresh_coverage.stale IS TRUE
       RETURNING (xmax = 0) AS inserted`,
      [
        toRefreshId,
        stale.verdict.status,
        stale.verdict.reason ?? null,
        stale.measuredAt,
        stale.refreshId || toRefreshId,
        JSON.stringify(stale),
      ],
    );
    // No row returned = the ON CONFLICT WHERE refused: the destination already
    // holds a NON-stale (real) measurement. That is a correct refusal, not a
    // failure, and it must not be reported as a successful copy.
    if (!row) return { copied: false, reason: 'destination-has-fresh-measurement' };
    return { copied: true };
  } catch (err) {
    process.stderr.write(`  [coverage] copy-forward failed: ${err.message}\n`);
    return { copied: false, reason: `db-error: ${err.message}` };
  }
}
