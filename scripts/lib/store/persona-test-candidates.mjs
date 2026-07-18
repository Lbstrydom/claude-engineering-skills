/**
 * @fileoverview Cloud-write store for the persona_test_candidates table
 * (migration 139). Phase 3 WS-PIPE1 closes the loop from canary findings
 * → aggregated candidates → /ship-promoted UX-lock spec stubs.
 *
 * Plan: wine-cellar-app/docs/plans/persona-test-consistency-phase3.md — WS-PIPE1.
 *
 * ## Why a separate domain module
 *
 *   persona.mjs handles persona_test_sessions (the durable session-level
 *   record). This module handles persona_test_candidates (the
 *   aggregation table). Different lifecycle, different access pattern
 *   (UPSERT with occurrences++ vs append-only INSERT), different
 *   downstream consumer (promote-canary-candidates vs persona registry).
 *
 * ## Cross-repo isolation (audit-r2/H4)
 *
 *   Every function MUST scope on `(repo_name, fingerprint)` — never
 *   `fingerprint` alone. The PK partitioning is enforced at the SQL
 *   layer, but a forgotten scope at the JS layer could SELECT another
 *   repo's rows in a future feature.
 *
 * @module scripts/lib/store/persona-test-candidates
 */

import { many, upsert, updateWhere } from '../db/query.mjs';
import { isCloudEnabled } from './repo.mjs';

const SEVERITY_RANK = Object.freeze({ P0: 0, P1: 1, P2: 2, P3: 3 });

/**
 * Idempotent UPSERT — first-time insert creates a row with occurrences=1;
 * re-insert with the same `(repo_name, fingerprint)` increments
 * occurrences and bumps `last_seen` to NOW(). Other fields stay frozen
 * at their first-seen values.
 *
 * Returns the row's identity + the post-increment occurrences count so
 * callers can log "this fingerprint has now surfaced N times".
 *
 * @param {Object} args
 * @param {string} args.repoName
 * @param {string} args.fingerprint
 * @param {string} args.canaryName
 * @param {string} args.surfaceId
 * @param {'P0'|'P1'|'P2'|'P3'} args.severity
 * @returns {Promise<{ok: boolean, cloud: boolean, occurrences?: number, firstSeen?: string, lastSeen?: string}>}
 */
export async function upsertPersonaTestCandidate(args) {
  if (!args?.repoName || !args?.fingerprint || !args?.canaryName
      || !args?.surfaceId || !SEVERITY_RANK[args.severity]) {
    return { ok: false, cloud: await isCloudEnabled() };
  }
  if (!await isCloudEnabled()) return { ok: false, cloud: false };

  try {
    // ON CONFLICT (repo_name, fingerprint) DO UPDATE:
    //   - occurrences = occurrences + 1
    //   - last_seen = NOW()
    //   - proposed_at is NOT touched (keeps already-proposed state intact)
    //   - first_seen, canary_name, surface_id, severity: FROZEN (preserves
    //     historical-first-sighting context — operators rely on it for
    //     "when did this first surface?" forensics)
    const rows = await upsert(
      'persona_test_candidates',
      [{
        repo_name: args.repoName,
        fingerprint: args.fingerprint,
        canary_name: args.canaryName,
        surface_id: args.surfaceId,
        severity: args.severity
      }],
      {
        onConflict: ['repo_name', 'fingerprint'],
        // 'all' would clobber first_seen + occurrences — we want a
        // surgical update so this is a custom UPDATE clause via the
        // raw-SQL escape hatch below. The `upsert` helper doesn't
        // expose increment expressions, so we fall through to a raw
        // ON CONFLICT execution.
        update: 'ignore',
        returning: ['occurrences', 'first_seen', 'last_seen']
      }
    );
    // If the UPSERT was a no-op (existing row), `rows` is empty —
    // run the surgical increment + bump separately. This branch is
    // the recurrence path (the common case after first-sighting).
    if (rows.length === 0) {
      const updated = await updateWhere(
        'persona_test_candidates',
        {},
        { repo_name: args.repoName, fingerprint: args.fingerprint },
        {
          // Raw SET expression for the increment — `updateWhere`'s
          // primary `patch` is just the WHERE-equality columns;
          // expression SET is via the `rawSet` escape hatch (if it
          // exists in this helper version) OR by falling back to
          // a direct `many(...)` call.
          returning: ['occurrences', 'first_seen', 'last_seen']
        }
      );
      // updateWhere() with empty patch is a NO-OP. Do an explicit
      // SQL UPDATE for the increment.
      const incr = await many(
        `UPDATE persona_test_candidates
            SET occurrences = persona_test_candidates.occurrences + 1,
                last_seen = NOW()
          WHERE repo_name = $1 AND fingerprint = $2
       RETURNING occurrences, first_seen, last_seen`,
        [args.repoName, args.fingerprint]
      );
      if (incr.length === 0) {
        // Lost a race with a concurrent insert that landed AFTER our
        // upsert's ON CONFLICT DO NOTHING fired. Retry once.
        const retry = await upsert(
          'persona_test_candidates',
          [{
            repo_name: args.repoName,
            fingerprint: args.fingerprint,
            canary_name: args.canaryName,
            surface_id: args.surfaceId,
            severity: args.severity
          }],
          { onConflict: ['repo_name', 'fingerprint'], update: 'ignore', returning: ['occurrences', 'first_seen', 'last_seen'] }
        );
        if (retry.length === 0) {
          return { ok: false, cloud: true };
        }
        return { ok: true, cloud: true, occurrences: retry[0].occurrences, firstSeen: retry[0].first_seen, lastSeen: retry[0].last_seen };
      }
      return { ok: true, cloud: true, occurrences: incr[0].occurrences, firstSeen: incr[0].first_seen, lastSeen: incr[0].last_seen };
    }
    return { ok: true, cloud: true, occurrences: rows[0].occurrences, firstSeen: rows[0].first_seen, lastSeen: rows[0].last_seen };
  } catch (err) {
    process.stderr.write(`  [persona-test-candidates] upsert failed: ${err.message}\n`);
    return { ok: false, cloud: true };
  }
}

/**
 * Promotion-time query: candidates eligible for proposal stub
 * generation. Filters mirror `.persona-test/promotion-policy.json`
 * thresholds but the filter parameters are passed in (so policy lives
 * in the caller, not duplicated here).
 *
 * @param {Object} args
 * @param {string} args.repoName
 * @param {number} args.ageDays — last_seen ≥ now() - this many days
 * @param {number} args.occurrencesFloor — occurrences ≥ this
 * @param {'P0'|'P1'|'P2'|'P3'} args.severityFloor — severity at-or-above this
 * @returns {Promise<Object[]>}
 */
export async function listPersonaTestCandidates(args) {
  if (!args?.repoName || !await isCloudEnabled()) return [];

  const ageDays = Number.isFinite(args.ageDays) ? args.ageDays : 7;
  const occurrencesFloor = Number.isFinite(args.occurrencesFloor) ? args.occurrencesFloor : 3;
  const floorRank = SEVERITY_RANK[args.severityFloor];
  if (floorRank === undefined) return [];

  // Severity is stored as P0..P3. Map to in-range via the rank — the
  // query stays scope-on-(repo_name, fingerprint) safe by always
  // anchoring on `repo_name`.
  const eligibleSeverities = Object.entries(SEVERITY_RANK)
    .filter(([, rank]) => rank <= floorRank)
    .map(([sev]) => sev);
  if (eligibleSeverities.length === 0) return [];

  try {
    return await many(
      `SELECT repo_name, fingerprint, canary_name, surface_id, severity,
              first_seen, last_seen, occurrences, proposed_at
         FROM persona_test_candidates
        WHERE repo_name = $1
          AND last_seen > NOW() - $2::interval
          AND occurrences >= $3
          AND severity = ANY($4)
          AND proposed_at IS NULL
        ORDER BY last_seen DESC
        LIMIT 100`,
      [args.repoName, `${ageDays} days`, occurrencesFloor, eligibleSeverities]
    );
  } catch (err) {
    process.stderr.write(`  [persona-test-candidates] list failed: ${err.message}\n`);
    return [];
  }
}

/**
 * Mark a candidate as proposed (stub written, awaiting review).
 * Sets `proposed_at = NOW()`. Idempotent — re-stamping is a no-op
 * because the WHERE clause includes `proposed_at IS NULL`.
 *
 * @param {Object} args
 * @param {string} args.repoName
 * @param {string} args.fingerprint
 * @returns {Promise<{ok: boolean, cloud: boolean, rowsAffected: number}>}
 */
export async function markPersonaTestCandidateProposed(args) {
  if (!args?.repoName || !args?.fingerprint) {
    return { ok: false, cloud: await isCloudEnabled(), rowsAffected: 0 };
  }
  if (!await isCloudEnabled()) return { ok: false, cloud: false, rowsAffected: 0 };

  try {
    const r = await many(
      `UPDATE persona_test_candidates
          SET proposed_at = NOW()
        WHERE repo_name = $1
          AND fingerprint = $2
          AND proposed_at IS NULL
     RETURNING repo_name`,
      [args.repoName, args.fingerprint]
    );
    return { ok: true, cloud: true, rowsAffected: r.length };
  } catch (err) {
    process.stderr.write(`  [persona-test-candidates] markProposed failed: ${err.message}\n`);
    return { ok: false, cloud: true, rowsAffected: 0 };
  }
}

// `SEVERITY_RANK` is intentionally module-internal — it's an
// implementation detail of the rank-aware severity filter. Public
// surface = the three async functions above; the upstream contract
// test (`tests/learning-store-exports.test.mjs`) pins this set.
