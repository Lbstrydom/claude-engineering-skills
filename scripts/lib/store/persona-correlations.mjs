/**
 * @fileoverview `persona_audit_correlations` — persona↔audit ground truth, and
 * the reads built over it.
 *
 * Split out of `plans-ship.mjs` (cross-skill-command-registry Phase 6). That
 * module is now a re-export barrel and remains the import name every consumer
 * uses; this file is where the correlation domain actually lives.
 *
 * This is the highest-leverage row in the cross-skill loop: a persona P0/P1
 * that corroborates an audit finding is ground truth about user-visible
 * impact, and it re-weights `computeReward` from 40/30/30 to 35/25/25/15.
 * Phase 7 adds the parent-ownership join to the write here — the correlation
 * writer lives in THIS file, not in `store/persona.mjs`.
 *
 * @module scripts/lib/store/persona-correlations
 */

import { isCloudEnabled } from './repo.mjs';
import { many, one, upsert, deleteWhere, withTx } from '../db/query.mjs';
import { assertParentOwnership, ownedReadPredicate } from './ownership.mjs';
import { PERSONA_FINDING_HASH_VERSION, PERSONA_FINDING_HASH_SHAPE } from '../persona/audit-correlator.mjs';

// ── persona_audit_correlations ─────────────────────────────────────────────

/**
 * Record a correlation between a persona finding and an audit finding —
 * the highest-leverage ground-truth labelling for the bandit reward.
 * Discriminated result so the auto-correlator (WS1) can count
 * `writeFailed` in its `correlationSummary` — cloud-off / invalid-input
 * are `ok: true` (nothing to write, not a failure); a real write failure
 * is `ok: false`.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function recordPersonaAuditCorrelation(personaSessionId, correlation, opts = {}) {
  if (!personaSessionId || !await isCloudEnabled()) return { ok: true };
  // Was a silent `{ok:true}` no-op (findings eef38861/bc8cea53) — indistinguishable
  // from a real write, so a producer bug (a missing field on an emitted
  // correlation) never surfaced anywhere. Both callers already handle
  // `ok:false` from the hash-shape check just below, so failing loud here is
  // free and closes the same masked-bug class that check was written for.
  if (!correlation?.personaFindingHash || !correlation?.correlationType || !correlation?.personaSeverity) {
    return {
      ok: false,
      error: 'personaFindingHash, correlationType, and personaSeverity are all required — got '
        + JSON.stringify({
          personaFindingHash: correlation?.personaFindingHash ?? null,
          correlationType: correlation?.correlationType ?? null,
          personaSeverity: correlation?.personaSeverity ?? null,
        }),
    };
  }
  // Gemini gate R2 shadow finding 6277c9df: this function stamps
  // `hash_version: PERSONA_FINDING_HASH_VERSION` unconditionally below, but
  // until now applied no shape check on `personaFindingHash` itself — unlike
  // `upsertPersonaFindingOutcome`'s write-schema regex, the manual
  // `record-correlation` CLI repair path could supply an arbitrary or
  // v1-shaped (8-hex) value and have it persisted confidently mislabeled v2.
  // Loud rejection (not a silent `{ok:true}` no-op like the field-presence
  // guard above) — both callers already handle `ok:false` (the CLI surfaces
  // it via WRITE_FAILED; the automatic decideCorrelations loop logs and
  // continues), so failing loud here costs nothing and catches a real bug
  // class instead of persisting it.
  if (!PERSONA_FINDING_HASH_SHAPE.test(correlation.personaFindingHash)) {
    return {
      ok: false,
      error: `personaFindingHash must be a 64-hex (v2) hash — got ${JSON.stringify(correlation.personaFindingHash)}`,
    };
  }
  // Declared OUTSIDE the try so the catch can tell a deliberate ownership
  // rollback from a genuine database failure — the throw is how the
  // transaction is aborted, not what the caller should be told.
  let refusal = null;
  try {
    await withTx(async () => {
      // PARENT OWNERSHIP (D7 / Phase 7). `personaSessionId` is an opaque uuid
      // the caller supplies, and this used to write against it without proving
      // the session exists or belongs to any resolvable repo.
      //
      // Transaction-scoped rather than the join form the other three writers
      // use, and the reason is recorded in ownership.mjs: this is an UPSERT
      // whose two conflict targets are PARTIAL indexes reached through the
      // shared `upsert()` helper, and scripts/lib/lint/on-conflict.mjs finds
      // upsert sites by CALLEE NAME. Raw CTE SQL here would remove the store's
      // highest-leverage write from that lint's coverage — trading one guard
      // for another rather than adding one. Inside this transaction there is no
      // TOCTOU window, and the check lives in the WRITER, where a caller cannot
      // forget it. `one()` is transaction-scoped here via withTx's async store.
      const owned = await assertParentOwnership(
        { parentTable: 'persona_test_sessions', parentId: personaSessionId, repoId: opts.repoId ?? null },
        (text, values) => one(text, values),
      );
      if (!owned.ok) {
        refusal = owned;
        throw new Error(owned.message);
      }
      // Cross-tenant guard (findings 62bee23e/0d5c4c8d): `assertParentOwnership`
      // above proves `personaSessionId` belongs to `opts.repoId`, but
      // `auditFindingId`/`auditRunId` are a SEPARATE caller-supplied identity
      // with no join through the session — a wrong id threaded in (the
      // documented threat model, ownership.mjs) could correlate this repo's
      // session against another repo's audit row, corrupting bandit-reward
      // ground truth for both. Only enforced when the caller resolved a repo
      // scope (`opts.repoId`); an unscoped call already relaxes the tenant
      // predicate the same way `assertParentOwnership` does above.
      if (opts.repoId != null && correlation.auditRunId) {
        const run = await one(`SELECT repo_id FROM audit_runs WHERE id = $1`, [correlation.auditRunId]);
        if (!run) {
          refusal = { reason: 'audit-run-not-found', message: `auditRunId ${correlation.auditRunId} does not exist` };
          throw new Error(refusal.message);
        }
        if (run.repo_id !== opts.repoId) {
          refusal = { reason: 'audit-run-cross-tenant', message: `auditRunId ${correlation.auditRunId} belongs to a different repo than the resolved scope` };
          throw new Error(refusal.message);
        }
      }
      if (opts.repoId != null && correlation.auditFindingId) {
        const finding = await one(
          `SELECT ar.repo_id FROM audit_findings af JOIN audit_runs ar ON ar.id = af.run_id WHERE af.id = $1`,
          [correlation.auditFindingId],
        );
        if (!finding) {
          refusal = { reason: 'audit-finding-not-found', message: `auditFindingId ${correlation.auditFindingId} does not exist` };
          throw new Error(refusal.message);
        }
        if (finding.repo_id !== opts.repoId) {
          refusal = { reason: 'audit-finding-cross-tenant', message: `auditFindingId ${correlation.auditFindingId} belongs to a different repo than the resolved scope` };
          throw new Error(refusal.message);
        }
      }
      // Retire any auto-emitted `audit_missed` (NULL audit_finding_id) row
      // for this exact (session, hash) pair FIRST — a manual repair that
      // corrects a false miss into a real match must not leave BOTH rows
      // in place (the ground truth would then simultaneously say "missed"
      // AND "confirmed" for the same finding, double-counting in the
      // bandit reward / audit_effectiveness). Harmless no-op when no such
      // row exists (a fresh manual correlation, or one repairing a
      // manual-only row). Plan: docs/plans/persona-nav-feedback-recovery.md
      // WS1 (Gemini gate round-2 finding).
      const row = {
        persona_session_id: personaSessionId,
        persona_finding_hash: correlation.personaFindingHash,
        persona_severity: correlation.personaSeverity,
        audit_finding_id: correlation.auditFindingId || null,
        audit_run_id: correlation.auditRunId || null,
        correlation_type: correlation.correlationType,
        match_score: correlation.matchScore ?? null,
        match_rationale: correlation.matchRationale || null,
        matcher_version: correlation.matcherVersion ?? null,
        // Stamped unconditionally, not threaded through `correlation` — this
        // function is the SOLE writer to persona_audit_correlations (both
        // the automatic decideCorrelations path and the manual
        // `record-correlation` CLI repair path), and there is no scenario
        // where a row written today should carry anything other than the
        // CURRENT hash-identity version (unlike matcher_version, which is a
        // genuinely call-site-varying value).
        // docs/plans/persona-finding-hash-versioning.md, Gemini gate R3 G2.
        hash_version: PERSONA_FINDING_HASH_VERSION,
      };
      if (correlation.auditFindingId) {
        // Retiring the stale NULL row first — see the function doc above.
        await deleteWhere('persona_audit_correlations', {
          persona_session_id: personaSessionId,
          persona_finding_hash: correlation.personaFindingHash,
          audit_finding_id: null,
        });
        // Real match: the 3-column unique constraint is the correct
        // conflict target (audit_finding_id is non-null here, so
        // Postgres's normal NOT-DISTINCT equality applies).
        // The lint reads the row builder's `audit_finding_id: null` DEFAULT, which this
        // branch overwrites. The null shape is handled by the else branch's partial index
        // (`conflictWhere: audit_finding_id IS NULL`) — the correct Postgres remedy for
        // NULL-distinct, not an instance of the 403k-row bug.
        // @on-conflict-ok: audit_finding_id is provably non-null on this branch — it is the `if (correlation.auditFindingId)` guard condition; detecting that needs flow analysis.
        const writeResult = await upsert('persona_audit_correlations', [row],
          { onConflict: ['persona_session_id', 'persona_finding_hash', 'audit_finding_id'], update: 'all' });
        // Finding 4133080f: the write result used to be discarded here, so a
        // 0-row upsert (unreachable today with `update: 'all'`, but not an
        // invariant this code establishes) still returned unconditional
        // success. Assert what was actually written rather than assume it.
        if (!writeResult || writeResult.rowCount !== 1) {
          refusal = { reason: 'write-not-confirmed', message: `expected 1 row written, got rowCount=${writeResult?.rowCount ?? 'unknown'}` };
          throw new Error(refusal.message);
        }
      } else {
        // audit_missed: audit_finding_id IS NULL is never equal to itself
        // under a plain column-list constraint (Postgres NULLs are
        // distinct), so ON CONFLICT (a,b,c) can never fire here — the
        // partial 2-column unique index (uq_correlations_missed) is the
        // ONLY conflict target that can dedupe this shape.
        const writeResult = await upsert('persona_audit_correlations', [row], {
          onConflict: ['persona_session_id', 'persona_finding_hash'],
          conflictWhere: 'audit_finding_id IS NULL',
          update: 'all',
        });
        if (!writeResult || writeResult.rowCount !== 1) {
          refusal = { reason: 'write-not-confirmed', message: `expected 1 row written, got rowCount=${writeResult?.rowCount ?? 'unknown'}` };
          throw new Error(refusal.message);
        }
      }
    });
    return { ok: true };
  } catch (err) {
    // An ownership refusal is a REFUSAL, not a crash: it rolled the transaction
    // back deliberately, so it is reported with its own reason rather than as an
    // opaque write failure. A caller can then tell a dangling session id from a
    // cross-tenant one from a database outage — three causes that produced one
    // indistinguishable `{ok:false, error}` before D7.
    if (refusal) return { ok: false, reason: refusal.reason, error: refusal.message };
    process.stderr.write(`  [learning] recordPersonaAuditCorrelation failed: ${err.message}\n`);
    return { ok: false, error: err.message };
  }
}

/**
 * Retire the auto-emitted `audit_missed` correlation(s) for a
 * `persona_finding_hash` when a human dismisses/wont-fixes it via WS4's
 * outcome labels — a dismissal is a durable, repo-wide judgment that the
 * finding was never a real audit miss (e.g. an LLM hallucination), so its
 * ground-truth row must be retired the same way a manual repair retires
 * one (Gemini gate round-3 finding). Scoped ACROSS ALL SESSIONS **FOR THE
 * SAME REPO** — code-audit H5 fix (Cluster 3): the original version's
 * DELETE predicate had NO repo scope at all despite this docstring's own
 * claim, so two different repos coincidentally producing the same
 * `persona_finding_hash` (the hash has no repo/session context baked in —
 * WS1's design) could cross-contaminate each other's ground truth. Joins
 * through `persona_test_sessions.repo_id` since `persona_audit_correlations`
 * itself carries no repo column (only `persona_session_id`) —
 * `deleteWhere`'s flat-equality builder can't express a JOIN, so this uses
 * a raw parameterized statement via the same `many()` primitive every
 * other read in this module uses. `confirmed_hit`/`severity_understated`
 * rows are untouched (a status label doesn't contest a correlation's
 * truth). Best-effort: never throws.
 * @returns {Promise<number>} rows deleted
 */
export async function retireMissedCorrelationsForHash(repoId, personaFindingHash) {
  // Discriminated since plan §2b F2 (2026-08-12), raised twice by the Cluster E
  // audit. A bare `0` meant "nothing matched" AND "the DELETE failed" — and the
  // two have opposite meanings here: the first says the stale `audit_finding_id
  // IS NULL` rows are gone, the second says they are still there and will keep
  // being counted as missed correlations. `retired` carries the count, so a
  // caller reading only that number is unaffected.
  if (!repoId || !personaFindingHash) {
    return { ok: false, cloud: true, retired: 0, reason: 'invalid-input', message: 'repoId and personaFindingHash are both required' };
  }
  if (!await isCloudEnabled()) {
    return { ok: false, cloud: false, retired: 0, reason: 'cloud-off', message: 'cloud store is disabled' };
  }
  try {
    const rows = await many(
      `DELETE FROM persona_audit_correlations pac
        USING persona_test_sessions pts
        WHERE pac.persona_session_id = pts.id
          AND pts.repo_id = $1
          AND pac.persona_finding_hash = $2
          AND pac.audit_finding_id IS NULL
        RETURNING pac.id`,
      [repoId, personaFindingHash],
    );
    return { ok: true, cloud: true, retired: rows.length };
  } catch (err) {
    process.stderr.write(`  [learning] retireMissedCorrelationsForHash failed: ${err.message}\n`);
    return { ok: false, cloud: true, retired: 0, reason: 'write-failed', message: err.message, error: err };
  }
}

/**
 * Candidate audit_findings for the auto-correlator — timestamp-ordered
 * AND temporally bounded (WS1: a stale audit run must never stand in as a
 * comparison candidate for a fresh persona session — Gemini gate round-3
 * finding). Returns the last `limit` audit_runs' findings within
 * `sinceDays`, PLUS (regardless of age) the findings of the run whose
 * commit_sha exactly matches `exactCommitSha`, when given. One query, no
 * N+1. Each row carries `run_created_at` (for tie-breaking) and `run_id`.
 *
 * **The `limit` counts runs that HAVE findings, not runs.** Without the
 * EXISTS predicate a run that found nothing still spent one of the five
 * slots, so a repo that converges clean often went blind: 112 of 188 (60%)
 * of wine-cellar-app's `mode=code` runs carry zero findings, and replaying
 * every audit_run as an as-of moment, 44 of 237 (19%) built an entirely
 * empty candidate set — including the 2026-07-28 persona session, whose 3
 * real P1s correlated against nothing. Filtering takes that repo to 8 of
 * 237 (3%) and claude-engineering-skills from 1 of 426 to 0. It only ever
 * widens the window, and only over runs that already exist; an empty
 * result stays reachable (and correct) when nothing in the window found
 * anything. Measured 2026-08-11; guarded by
 * `tests/candidate-audit-findings-window.test.mjs`.
 *
 * Knock-on worth knowing: `decideCorrelations` stamps an `audit_missed`
 * row with the most recent candidate run's id, so that attribution moves
 * from "most recent run" to "most recent run that found something" — the
 * better reading of the two, since a run with no findings cannot
 * meaningfully be the one that missed a thing.
 *
 * Discriminated result — `ok: false` (a real query failure) is distinct
 * from `ok: true, rows: []` (genuinely zero candidates in window): the
 * auto-correlator's `correlationSummary.reason` needs to tell
 * `candidate-read-failed` apart from `no-candidate-runs`, and a bare
 * empty-array-on-error return would collapse that distinction (WS1).
 * @param {{ repoId: string, sinceDays?: number, limit?: number, exactCommitSha?: string|null }} args
 * @returns {Promise<{ok: boolean, rows: object[], error?: string}>}
 */
export async function getCandidateAuditFindings({ repoId, sinceDays = 14, limit = 5, exactCommitSha = null }) {
  if (!repoId || !await isCloudEnabled()) return { ok: true, rows: [] };
  try {
    const runs = await many(
      `SELECT id, created_at FROM audit_runs
        WHERE repo_id = $1
          AND (created_at >= now() - ($2 || ' days')::interval
               OR commit_sha = $3)
          AND EXISTS (SELECT 1 FROM audit_findings af WHERE af.run_id = audit_runs.id)
        ORDER BY created_at DESC
        LIMIT $4`,
      [repoId, String(sinceDays), exactCommitSha, limit],
    );
    if (runs.length === 0) return { ok: true, rows: [] };
    const runIds = runs.map((r) => r.id);
    const runCreatedAt = new Map(runs.map((r) => [r.id, r.created_at]));
    const findings = await many(
      `SELECT id, run_id, finding_fingerprint, severity, category,
              primary_file, detail_snapshot
         FROM audit_findings
        WHERE run_id = ANY($1)`,
      [runIds],
    );
    return { ok: true, rows: findings.map((f) => ({ ...f, run_created_at: runCreatedAt.get(f.run_id) })) };
  } catch (err) {
    process.stderr.write(`  [learning] getCandidateAuditFindings failed: ${err.message}\n`);
    return { ok: false, rows: [], error: err.message };
  }
}

/**
 * Existing correlation hashes for ONE session — the batched existence
 * read the auto-correlator uses to enforce "first hit wins per finding"
 * without a per-finding query (WS1). Discriminated result for the same
 * reason as `getCandidateAuditFindings` — a read failure must map to
 * `correlationSummary.reason = 'existence-check-failed'`, not silently
 * behave as "nothing exists yet" (which would double-emit on a retry).
 * @param {string} personaSessionId
 * @returns {Promise<{ok: boolean, hashes: Set<string>, error?: string}>}
 */
export async function getExistingCorrelationHashesForSession(personaSessionId) {
  if (!personaSessionId || !await isCloudEnabled()) return { ok: true, hashes: new Set() };
  try {
    const rows = await many(
      `SELECT DISTINCT persona_finding_hash FROM persona_audit_correlations WHERE persona_session_id = $1`,
      [personaSessionId],
    );
    return { ok: true, hashes: new Set(rows.map((r) => r.persona_finding_hash)) };
  } catch (err) {
    process.stderr.write(`  [learning] getExistingCorrelationHashesForSession failed: ${err.message}\n`);
    return { ok: false, hashes: new Set(), error: err.message };
  }
}

/**
 * Read correlations for a specific audit_run.
 *
 * `repoId` is additive and OPTIONAL (read-path tenancy close-out, 2026-08-12).
 * The rows carry no repo of their own, so an unscoped read hands another
 * repository's ground truth to a caller that will present it as its own. The
 * tenant reaches the row through the persona SESSION that owns the correlation.
 */
export async function readCorrelationsForRun(auditRunId, { repoId = null } = {}) {
  if (!auditRunId || !await isCloudEnabled()) return [];
  try {
    return await many(
      `SELECT * FROM persona_audit_correlations WHERE audit_run_id = $1 AND `
      + `${ownedReadPredicate({ parentTable: 'persona_test_sessions', idColumnInQuery: 'persona_session_id', idParam: 1, repoParam: 2 })}`,
      [auditRunId, repoId],
    );
  } catch (err) {
    process.stderr.write(`  [learning] readCorrelationsForRun failed: ${err.message}\n`);
    return [];
  }
}

/** Read correlations for a specific audit finding. */
export async function readCorrelationsForFinding(auditFindingId) {
  if (!auditFindingId || !await isCloudEnabled()) return [];
  try {
    return await many(`SELECT * FROM persona_audit_correlations WHERE audit_finding_id = $1`, [auditFindingId]);
  } catch (err) {
    process.stderr.write(`  [learning] readCorrelationsForFinding failed: ${err.message}\n`);
    return [];
  }
}

/** Read the audit_effectiveness view rollup for a repo. */
export async function readAuditEffectiveness(repoId) {
  if (!await isCloudEnabled()) return null;
  try {
    return await one(`SELECT * FROM audit_effectiveness WHERE repo_id = $1 LIMIT 1`, [repoId]);
  } catch (err) {
    process.stderr.write(`  [learning] readAuditEffectiveness failed: ${err.message}\n`);
    return null;
  }
}

/**
 * Per-repo correlation counts by type — WS4 the dashboard tab needs to
 * turn WS1's correlator output into a visible surface ("the correlation
 * loop health line"). `persona_audit_correlations` carries no `repo_id`
 * column (only `persona_session_id`, same as the code-audit H5 fix
 * `retireMissedCorrelationsForHash` closed), so this joins through
 * `persona_test_sessions.repo_id`.
 * @returns {Promise<{ok: boolean, byType: Array<{type: string, count: number}>, total: number, error?: string}>}
 */
export async function readCorrelationCountsByType(repoId) {
  if (!repoId) return { ok: false, byType: [], total: 0, error: 'repoId is required' };
  if (!await isCloudEnabled()) return { ok: true, byType: [], total: 0 };
  try {
    const rows = await many(
      `SELECT pac.correlation_type, count(*) AS n
         FROM persona_audit_correlations pac
         JOIN persona_test_sessions pts ON pts.id = pac.persona_session_id
        WHERE pts.repo_id = $1
        GROUP BY pac.correlation_type`,
      [repoId],
    );
    const byType = rows.map((r) => ({ type: r.correlation_type, count: Number(r.n) || 0 }));
    const total = byType.reduce((sum, r) => sum + r.count, 0);
    return { ok: true, byType, total };
  } catch (err) {
    process.stderr.write(`  [learning] readCorrelationCountsByType failed: ${err.message}\n`);
    return { ok: false, byType: [], total: 0, error: err.message };
  }
}
