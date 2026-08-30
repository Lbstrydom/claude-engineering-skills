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
import { ANNOTATION_EVENT } from '../upstream/events.mjs';

/**
 * Legal lifecycle transitions. `fixed` / `wont_fix` are terminal.
 *
 * This map is also what keeps the non-lifecycle `annotation` event out of the
 * state machine STRUCTURALLY rather than by convention: it is neither a key
 * nor a destination here, so `transitionUpstreamIssue` rejects it as an illegal
 * transition from every state. Annotations are written by
 * `recordUpstreamIssueAnnotation`, which touches no column of `upstream_issues`.
 */
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
  // All-or-nothing (round-3 audit M17): a PARTIAL cursor (only one of the two
  // fields) used to be silently treated as "no cursor at all", handing back
  // page 1 instead of surfacing that the cursor was malformed — a caller
  // paging through results could quietly restart from the top, or `--before`
  // hand-edited/truncated by an operator would decode to something wrong
  // without any signal.
  if (opts.before != null) {
    if (!opts.before.createdAt || !opts.before.id) {
      return {
        ok: false, cloud: true, rows: [], nextCursor: null,
        error: 'before cursor must have both createdAt and id, or be omitted entirely',
      };
    }
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
 * Every TERMINAL (fixed|wont_fix) row's id/state/disposition — the reconciler's
 * DB side (consumer-friction-doctor plan §2.4, round-1 audit H2/M13).
 *
 * Deliberately unpaged, unlike `listUpstreamIssues`: a reconciliation pass
 * that silently drops rows past a page limit is the exact "adjacency
 * incomplete" failure class this repo already treats as a false-green — this
 * table has ~20 terminal rows today, and even at 10x that a single query is
 * still cheap. If it ever needs paging, that is a deliberate later change,
 * not a default inherited from an unrelated list view.
 *
 * @returns {Promise<{ok: boolean, cloud: boolean, rows: Array<{issueId: string, state: string, disposition: string|null}>, error?: string}>}
 */
export async function listTerminalUpstreamIssues() {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, rows: [] };
  try {
    const rows = await many(
      `SELECT id, state, disposition FROM upstream_issues WHERE state IN ('fixed', 'wont_fix') ORDER BY created_at`,
      [],
    );
    return { ok: true, cloud: true, rows: rows.map((r) => ({ issueId: r.id, state: r.state, disposition: r.disposition })) };
  } catch (err) {
    process.stderr.write(`  [upstream] listTerminalUpstreamIssues failed: ${err.message}\n`);
    return { ok: false, cloud: true, rows: [], error: err.message };
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
 * @param {{id: string, to: string, note?: string|null, commit?: string|null, actor?: string|null, disposition?: string|null}} args
 */
export async function transitionUpstreamIssue({
  id, to, note = null, commit = null, actor = null, disposition = null,
}) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false };

  try {
    return await withTx(async () => {
      // Accept a PREFIX, the way git accepts a short sha. A full uuid is 36
      // characters an operator has to copy exactly, off a card that may have
      // rendered it truncated — and the failure was a raw Postgres type error,
      // so the papercut did not even explain itself. Callers must pre-validate
      // the shape (upstreamTransition does): `%` and `_` are LIKE wildcards, and
      // a bare `%` here would match every row and then "resolve" to whichever
      // sorted first.
      //
      // LIMIT 2, not 1 — the second row is what makes ambiguity DETECTABLE. A
      // LIMIT 1 would silently transition an arbitrary issue, which is worse
      // than the error this replaces because it looks like it worked.
      const matches = await many(
        `SELECT id, state FROM upstream_issues WHERE id::text LIKE $1 || '%' ORDER BY id LIMIT 2`,
        [id],
      );
      if (matches.length === 0) return { ok: false, cloud: true, notFound: true };
      if (matches.length > 1) {
        return {
          ok: false, cloud: true, ambiguous: true,
          error: `id "${id}" matches more than one issue — use more characters`,
        };
      }
      const current = matches[0];
      // Every write below keys on the RESOLVED id, never the caller's prefix:
      // `updateWhere(..., {id})` with a prefix matches nothing (uuid equality,
      // not LIKE), so the update would report 0 rows and be misread as the
      // concurrent-modification conflict below.
      const resolvedId = current.id;

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
      // `chk_upstream_terminal_has_disposition` mirrors this: a terminal
      // state (fixed|wont_fix) must carry a disposition, and a non-terminal
      // state must not. `upstreamTransition` (the CLI-level caller) already
      // enforces this and formats the wire string; this is the DB-boundary
      // half — necessary because a future second writer, an admin console,
      // or a hand-run UPDATE could otherwise bypass the CLI-level check.
      if (to === 'fixed' || to === 'wont_fix') patch.disposition = disposition;

      const res = await updateWhere(
        'upstream_issues', patch, { id: resolvedId, state: current.state }, { returning: ['id'] },
      );
      const updated = Array.isArray(res) ? res.length : (res?.rowCount ?? 0);
      if (updated !== 1) {
        return {
          ok: false, cloud: true, conflict: true,
          error: 'state changed under us — re-read and retry',
        };
      }

      await insertReturning('upstream_issue_events', {
        issue_id: resolvedId, event: to, note, actor,
      });
      return { ok: true, cloud: true, id: resolvedId, from: current.state, to };
    });
  } catch (err) {
    process.stderr.write(`  [upstream] transitionUpstreamIssue failed: ${err.message}\n`);
    return { ok: false, cloud: true, error: err.message };
  }
}

/**
 * Append a correction / added-context note to an issue's log WITHOUT moving it
 * through the lifecycle.
 *
 * **Why this is not a transition.** The log is append-only by trigger and
 * `upstream_issues.state` is CHECK'd to four values, so a note stored with a
 * mistake in it previously had two repairs and both were wrong: rewrite the
 * append-only row, or emit a second terminal event — corrupting the lifecycle
 * record to fix a typo. This writes an `annotation` event and touches NO column
 * of `upstream_issues`: not `state`, not `disposition`, not even `updated_at`.
 * `updated_at` is deliberate — it is the lifecycle's timestamp, read by triage
 * as "when did this issue last MOVE", and bumping it for a note would make an
 * annotated-but-stalled report look freshly worked.
 *
 * Because it writes no `upstream_issues` row, it is invisible to
 * `tests/upstream-single-writer-census.test.mjs`'s single-terminal-writer rule
 * by construction rather than by exemption, and it writes no disposition-ledger
 * entry — so the full-uuid requirement its caller enforces is NOT the ledger's
 * (`upstreamAnnotate` states the reason it has instead).
 *
 * Durability is the caller's write-ahead outbox
 * (`upstream/commands.mjs` `ANNOTATION_OUTBOX_DIR`), not the audit-store spill
 * queue — see the exemption entry in
 * `tests/audit-store-durability-call-site.test.mjs`.
 *
 * Legal from ANY state including the terminal ones — annotating a closed report
 * is the case that motivated this.
 *
 * Prefix resolution mirrors `transitionUpstreamIssue`: the same `LIMIT 2`
 * ambiguity detection, and the same requirement that callers pre-validate the
 * id's shape, because `%` and `_` are LIKE wildcards living in the DATA, where
 * parameterisation does not reach.
 *
 * **`eventId` makes a replay idempotent, and it is the reason this write can be
 * queued at all.** An annotation has no natural unique key — two identical
 * corrections minutes apart are two legitimate rows — so a retry after a lost
 * acknowledgement would silently duplicate the note, which is exactly the shape
 * an append-only log cannot then repair. A caller that may retry (the write-ahead
 * outbox) therefore mints the row's PRIMARY KEY up front and passes it here, and
 * the insert arbitrates on it: `upstream_issue_events.id` is a real uuid PK, and
 * a logical key would not have been a legal `ON CONFLICT` target. Omitted ⇒ the
 * column default generates one, which is correct for a caller that never retries.
 *
 * `created: false` means the row was already there — a REPLAY, not a failure.
 *
 * @param {{id: string, note: string, actor?: string|null, eventId?: string|null}} args
 * @returns {Promise<{ok: boolean, cloud: boolean, id?: string, state?: string, eventId?: string, created?: boolean, notFound?: boolean, ambiguous?: boolean, error?: string}>}
 */
export async function recordUpstreamIssueAnnotation({ id, note, actor = null, eventId = null }) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false };
  // An empty note is refused HERE as well as at the CLI and in the CHECK: this
  // is the durable boundary, and the CLI is one of several possible callers.
  if (typeof note !== 'string' || !note.trim()) {
    return { ok: false, cloud: true, error: 'an annotation must carry a non-empty note' };
  }

  try {
    return await withTx(async () => {
      const matches = await many(
        `SELECT id, state FROM upstream_issues WHERE id::text LIKE $1 || '%' ORDER BY id LIMIT 2`,
        [id],
      );
      if (matches.length === 0) return { ok: false, cloud: true, notFound: true };
      if (matches.length > 1) {
        return {
          ok: false, cloud: true, ambiguous: true,
          error: `id "${id}" matches more than one issue — use more characters`,
        };
      }
      const current = matches[0];
      // Hand-written rather than `insertReturning`: the builder cannot express
      // an ON CONFLICT clause (same reason `recordUpstreamIssue`'s insert is
      // hand-written), and the conflict clause is what makes a queued replay
      // safe. `COALESCE($1, gen_random_uuid())` keeps the no-eventId caller on
      // the column's own default behaviour.
      const inserted = await one(
        `INSERT INTO upstream_issue_events (id, issue_id, event, note, actor)
         VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [eventId, current.id, ANNOTATION_EVENT, note, actor],
      );
      // No row back means the PK was already present — this is a REPLAY of a
      // write that already landed, which is a success for the caller and must
      // not be reported as a failure (a retrying outbox would queue it forever).
      // Distinguishable from a first write by `created`.
      if (!inserted) {
        return {
          ok: true, cloud: true, created: false,
          id: current.id, state: current.state, eventId,
        };
      }
      return {
        ok: true, cloud: true, created: true,
        id: current.id, state: current.state, eventId: inserted.id,
      };
    });
  } catch (err) {
    process.stderr.write(`  [upstream] recordUpstreamIssueAnnotation failed: ${err.message}\n`);
    return { ok: false, cloud: true, error: err.message };
  }
}

/**
 * One issue plus its whole append-only event log, chronologically.
 *
 * **This is the read side the log never had.** Until now nothing in the repo
 * SELECTed `upstream_issue_events` at all — every event ever written was
 * write-only, so an annotation added without this would land somewhere no
 * operator surface could show it, which is the write-with-no-reader shape this
 * repo keeps closing rather than a new instance of it.
 *
 * Unpaged, like `listTerminalUpstreamIssues`: an issue's log is a handful of
 * rows by construction (four lifecycle events maximum, plus annotations), and a
 * history view that silently truncated would be worse than useless — the whole
 * point is that the record is complete.
 *
 * `(created_at, id)` ordering, not `created_at` alone: two events written in the
 * same transaction share a `now()`, so the timestamp is not a total order.
 *
 * @param {string} id full uuid or prefix
 * @returns {Promise<{ok: boolean, cloud: boolean, issue?: object|null, events?: Array<object>, notFound?: boolean, ambiguous?: boolean, error?: string}>}
 */
export async function getUpstreamIssueHistory(id) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, issue: null, events: [] };
  try {
    const matches = await many(
      `SELECT i.*, r.name AS repo_name
         FROM upstream_issues i
         LEFT JOIN audit_repos r ON r.id = i.repo_id
        WHERE i.id::text LIKE $1 || '%'
        ORDER BY i.id LIMIT 2`,
      [id],
    );
    if (matches.length === 0) return { ok: false, cloud: true, notFound: true, issue: null, events: [] };
    if (matches.length > 1) {
      return {
        ok: false, cloud: true, ambiguous: true, issue: null, events: [],
        error: `id "${id}" matches more than one issue — use more characters`,
      };
    }
    const issue = matches[0];
    const events = await many(
      `SELECT id, event, note, actor, created_at
         FROM upstream_issue_events
        WHERE issue_id = $1::uuid
        ORDER BY created_at, id`,
      [issue.id],
    );
    return { ok: true, cloud: true, issue, events };
  } catch (err) {
    process.stderr.write(`  [upstream] getUpstreamIssueHistory failed: ${err.message}\n`);
    return { ok: false, cloud: true, issue: null, events: [], error: err.message };
  }
}
