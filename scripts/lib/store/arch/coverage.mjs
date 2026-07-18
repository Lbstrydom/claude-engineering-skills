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

  const status = coverage.verdict?.status;
  const reason = coverage.verdict?.reason ?? null;
  if (!status) return { recorded: false, reason: 'missing-verdict' };

  try {
    await upsert('symbol_refresh_coverage', [{
      refresh_id: refreshId,
      status,
      reason,
      stale: coverage.stale === true,
      measured_at: coverage.measuredAt,
      // When copied forward, the measuring run is NOT this refresh. Preserving
      // it is what lets the dashboard say "measured 3 refreshes ago" rather
      // than implying this run measured anything.
      measured_refresh_id: coverage.refreshId || refreshId,
      payload: coverage,
    }], { onConflict: ['refresh_id'], update: 'all' });
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
    return row?.payload ?? null;
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
 * `stale: true` forces `unknown`/`stale_measurement` at precedence row 4.
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
export async function copyForwardCoverage({ fromRefreshId, toRefreshId }) {
  if (!fromRefreshId || !toRefreshId) return { copied: false, reason: 'invalid-input' };
  const prior = await getGraphCoverage(fromRefreshId);
  if (!prior) return { copied: false, reason: 'no-prior-coverage' };

  const stale = {
    ...prior,
    stale: true,
    // measuredAt + refreshId are preserved from the ORIGINAL measurement —
    // that is the whole point of copying forward rather than re-stamping.
    verdict: { status: 'unknown', reason: 'stale_measurement' },
  };
  const res = await recordGraphCoverage(toRefreshId, stale);
  return { copied: res.recorded, reason: res.reason };
}
