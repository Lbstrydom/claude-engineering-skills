/**
 * @fileoverview Upstream-issue domain — `upstream_issues` + `upstream_issue_events`.
 *
 * The consumer → source bug channel. Consumers file reports about
 * upstream-owned synced tooling; this repo triages them.
 * Plan: docs/plans/upstream-issue-reports.md (Cluster A, Phase 2).
 *
 * Mirrors the `store/debt.mjs` shape: cloud-off is a graceful `{ok:true}`
 * no-op, every write is wrapped, and SQL never leaks into the CLI layer.
 *
 * @module scripts/lib/store/upstream-issues
 */

import { many, one, insertReturning, updateWhere, withTx } from '../db/query.mjs';
import { isCloudEnabled } from './repo.mjs';

/** Legal lifecycle transitions. `fixed` / `wont_fix` are terminal. */
export const LEGAL_TRANSITIONS = Object.freeze({
  open: Object.freeze(['acknowledged', 'fixed', 'wont_fix']),
  acknowledged: Object.freeze(['fixed', 'wont_fix']),
  fixed: Object.freeze([]),
  wont_fix: Object.freeze([]),
});

/** Hard cap on a single `listUpstreamIssues` page — private report bodies. */
export const MAX_LIST_LIMIT = 200;
export const DEFAULT_LIST_LIMIT = 50;

/**
 * Record a report, idempotent on `fingerprint`.
 *
 * The initial `reported` event is inserted in the SAME transaction as the row
 * but **only when the row is genuinely new**. The outbox retries by design
 * (a write can land while its acknowledgement is lost), so an unconditional
 * insert would append a duplicate `reported` event on every replay and turn
 * the append-only log into a false audit trail.
 *
 * @param {object} report
 * @returns {Promise<{ok: boolean, cloud: boolean, created?: boolean, id?: string|null, error?: string}>}
 */
export async function recordUpstreamIssue(report) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false };
  try {
    return await withTx(async () => {
      // ON CONFLICT DO NOTHING + RETURNING: a conflicting insert returns NO
      // row, which is exactly the "already present" signal we gate the event
      // insert on. `insertReturning` cannot express the conflict clause, so
      // this one is hand-written.
      const inserted = await one(
        `INSERT INTO upstream_issues
           (repo_id, title, body, severity, affected_path,
            reported_bundle_sha, reported_bundle_generated_at, reported_source_dirty,
            path_recognised, fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (fingerprint) DO NOTHING
         RETURNING id`,
        [
          report.repoId,
          report.title,
          report.body,
          report.severity,
          report.affectedPath,
          report.reportedBundleSha ?? null,
          report.reportedBundleGeneratedAt ?? null,
          report.reportedSourceDirty ?? null,
          report.pathRecognised ?? null,
          report.fingerprint,
        ],
      );

      if (!inserted) {
        const existing = await one(
          'SELECT id FROM upstream_issues WHERE fingerprint = $1',
          [report.fingerprint],
        );
        return { ok: true, cloud: true, created: false, id: existing?.id ?? null };
      }

      await insertReturning('upstream_issue_events', {
        issue_id: inserted.id,
        event: 'reported',
        note: null,
        actor: report.actor ?? null,
      });
      return { ok: true, cloud: true, created: true, id: inserted.id };
    });
  } catch (err) {
    process.stderr.write(`  [upstream] recordUpstreamIssue failed: ${err.message}\n`);
    return { ok: false, cloud: true, error: err.message };
  }
}

/**
 * Bounded, keyset-paged listing.
 *
 * The cursor is the COMPOSITE `(created_at, id)`. `created_at` alone is not a
 * unique ordering key, so same-timestamp rows would be skipped or repeated
 * between pages.
 *
 * `repoId` is OPTIONAL and defaults to unscoped: this is the source-side triage
 * view and is meant to show every consumer's reports. That is a deliberate
 * consequence of the single-trust-domain model (one `AUDIT_DB_URL`, RLS
 * bypassed by the runtime pool), documented in the plan §3 — not an oversight.
 * The filter exists for the narrower "just this consumer" question.
 *
 * @param {{state?: string|null, repoId?: string|null, limit?: number, before?: {createdAt: string, id: string}|null}} [opts]
 */
export async function listUpstreamIssues(opts = {}) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, rows: [], nextCursor: null };

  const limit = Math.min(
    Math.max(1, Number.isFinite(opts.limit) ? Math.trunc(opts.limit) : DEFAULT_LIST_LIMIT),
    MAX_LIST_LIMIT,
  );
  const params = [];
  const where = [];

  if (opts.state) {
    params.push(opts.state);
    where.push(`i.state = $${params.length}`);
  }
  if (opts.repoId) {
    params.push(opts.repoId);
    where.push(`i.repo_id = $${params.length}::uuid`);
  }
  if (opts.before?.createdAt && opts.before?.id) {
    params.push(opts.before.createdAt, opts.before.id);
    where.push(`(i.created_at, i.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(limit + 1);   // over-fetch by one to detect a further page

  try {
    const rows = await many(
      // `created_at_cursor` is the timestamp rendered by POSTGRES, not by JS.
      // Round-tripping through `new Date().toISOString()` truncates Postgres's
      // microsecond precision to milliseconds, which would make the keyset
      // cursor land mid-microsecond and skip or repeat rows — defeating the
      // composite cursor it is part of.
      `SELECT i.*, r.name AS repo_name,
              to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
         FROM upstream_issues i
         LEFT JOIN audit_repos r ON r.id = i.repo_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT $${params.length}`,
      params,
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      ok: true,
      cloud: true,
      rows: page,
      nextCursor: hasMore && last
        ? { createdAt: last.created_at_cursor, id: last.id }
        : null,
    };
  } catch (err) {
    process.stderr.write(`  [upstream] listUpstreamIssues failed: ${err.message}\n`);
    return { ok: false, cloud: true, rows: [], nextCursor: null, error: err.message };
  }
}

/**
 * Candidate prior fixes for a report: `fixed` issues touching the same path.
 *
 * **Cross-repo by design** — the fixed code lives in the source repo, so a fix
 * prompted by one consumer is equally relevant to another consumer's report
 * about the same file.
 *
 * This is EVIDENCE FOR A HUMAN, never a verdict: a file path is not a bug
 * identity (one file holds many independent defects), so "a fixed issue exists
 * touching this path" cannot establish that this report is that bug.
 *
 * @param {string} affectedPath
 * @param {string} excludeId - the report itself
 */
export async function findPriorFixes(affectedPath, excludeId = null) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, rows: [] };
  try {
    const rows = await many(
      `SELECT id, title, fixed_in_commit, repo_id, created_at
         FROM upstream_issues
        WHERE affected_path = $1 AND state = 'fixed'
          AND fixed_in_commit IS NOT NULL
          AND ($2::uuid IS NULL OR id <> $2::uuid)
        ORDER BY created_at DESC
        LIMIT 10`,
      [affectedPath, excludeId],
    );
    return { ok: true, cloud: true, rows };
  } catch (err) {
    process.stderr.write(`  [upstream] findPriorFixes failed: ${err.message}\n`);
    return { ok: false, cloud: true, rows: [], error: err.message };
  }
}

/**
 * Move an issue through its lifecycle. Row UPDATE + event INSERT in one
 * transaction; the UPDATE is guarded on the expected current state so a
 * concurrent transition is detected rather than silently clobbered.
 *
 * A 0-row UPDATE means someone else moved it first — reported as
 * `conflict: true`, never treated as success (an unverified write is an
 * `/audit-code` HIGH in this repo).
 *
 * @param {{id: string, to: string, note?: string|null, commit?: string|null, actor?: string|null}} args
 */
export async function transitionUpstreamIssue({ id, to, note = null, commit = null, actor = null }) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false };

  try {
    return await withTx(async () => {
      const current = await one('SELECT id, state FROM upstream_issues WHERE id = $1', [id]);
      if (!current) return { ok: false, cloud: true, notFound: true };

      const legal = LEGAL_TRANSITIONS[current.state] ?? [];
      if (!legal.includes(to)) {
        return {
          ok: false, cloud: true, illegal: true, from: current.state, to,
          error: `illegal transition ${current.state} → ${to}`
            + (legal.length ? ` (legal: ${legal.join(', ')})` : ' (terminal state)'),
        };
      }

      const patch = { state: to, updated_at: new Date().toISOString() };
      // The CHECK constraint ties these together: only `fixed` may carry a
      // commit, and it must carry one.
      if (to === 'fixed') patch.fixed_in_commit = commit;

      const res = await updateWhere(
        'upstream_issues', patch, { id, state: current.state }, { returning: ['id'] },
      );
      const updated = Array.isArray(res) ? res.length : (res?.rowCount ?? 0);
      if (updated !== 1) {
        return {
          ok: false, cloud: true, conflict: true,
          error: 'state changed under us — re-read and retry',
        };
      }

      await insertReturning('upstream_issue_events', {
        issue_id: id, event: to, note, actor,
      });
      return { ok: true, cloud: true, from: current.state, to };
    });
  } catch (err) {
    process.stderr.write(`  [upstream] transitionUpstreamIssue failed: ${err.message}\n`);
    return { ok: false, cloud: true, error: err.message };
  }
}
