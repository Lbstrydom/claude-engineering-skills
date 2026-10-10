/**
 * @fileoverview `fleet_events` — one row per /fleet CLI invocation, written by
 * the telemetry drain (`cross-skill.mjs fleet-telemetry flush`), read back as
 * measurements by `fleet-telemetry stats` and the skill census.
 *
 * Only EVENTS are stored; every metric is derived at read time, so a metric can
 * be added or corrected later over the history already collected:
 *   - golden signals per verb — traffic, latency p50/p95, errors, refusals;
 *   - session flow — sessions started / released / abandoned, claim→release
 *     lead time, refusals and rework (restacks) per session;
 *   - weakness signals — top refusal and error classes, argv misuse,
 *     unexpected error kinds, WAIT (pending) outcomes;
 *   - saturation — board size and hold time seen by `status`;
 *   - versions — latency and error rate per synced tool commit, so a release
 *     that regresses shows up against its predecessor.
 *
 * Plan: docs/plans/fleet-telemetry.md.
 *
 * @module scripts/lib/store/fleet-events
 */
import { many, upsert } from '../db/query.mjs';
import { describeSchemaFault, isSchemaFaultSqlstate } from '../db/errors.mjs';
import { isCloudEnabled } from './repo.mjs';
import { isSyncableRepoId } from './bandit-fp.mjs';
import { runWindowCountQuery } from './window-count-query.mjs';

/**
 * Insert events, idempotent on `event_id` (a re-drained event is a no-op).
 *
 * @returns {Promise<{ok:boolean, cloud:boolean, written?:number, reason?:string, error?:string}>}
 */
export async function recordFleetEvents(repoId, repoName, events) {
  if (!Array.isArray(events) || events.length === 0) return { ok: true, cloud: false, written: 0, reason: 'empty' };
  // A repo id is REQUIRED: an unscoped fleet event can never be read back by
  // any per-repo query, so writing one would only lose it more quietly.
  if (repoId == null) return { ok: false, cloud: false, reason: 'missing-repo-id' };
  if (!isSyncableRepoId(repoId)) {
    return { ok: false, cloud: false, reason: 'invalid-repo-id', error: `recordFleetEvents: repoId "${String(repoId)}" is not a valid audit_repos UUID` };
  }
  if (!await isCloudEnabled()) return { ok: false, cloud: false, reason: 'cloud-off' };
  try {
    // Spool event (lib/fleet/telemetry.mjs, already schema-checked by the drain) → row.
    // Written inline so the ON CONFLICT lint can read the conflict-key column's value.
    // @on-conflict-ok: event_id is a UUIDv4 minted once per invocation by the capture side, so it identifies the event globally and repo_id/repo_name cannot change which rows conflict; a conflict is only ever the SAME event re-drained (the drain is at-least-once), and flush refuses a spool from another repository and an unresolved repo, so one event can never arrive under two scopes. DO NOTHING keeps the first write.
    const res = await upsert('fleet_events', events.map((e) => ({
      event_id: e.eventId,
      repo_id: repoId,
      repo_name: repoName || null,
      verb: e.verb,
      mode: e.mode ?? null,
      outcome: e.outcome,
      exit_code: e.exitCode ?? null,
      duration_ms: e.durationMs,
      session_id: e.sessionId ?? null,
      reason_class: e.reasonClass ?? null,
      tool_sha: e.toolSha ?? null,
      detail: e.detail ?? {}, // jsonb — serialized by the db-layer seam
      created_at: e.occurredAt,
    })), { onConflict: 'event_id', update: 'ignore' });
    return { ok: true, cloud: true, written: res?.rowCount ?? 0 };
  } catch (err) {
    const schema = describeSchemaFault(err, 'recordFleetEvents');
    if (schema) process.stderr.write(schema);
    return {
      ok: false, cloud: true,
      reason: isSchemaFaultSqlstate(err?.code) ? 'schema-fault' : 'write-failed',
      error: err.message,
    };
  }
}

/** Census window counts (one row per invocation). */
export async function getFleetEventWindowCounts(repoId, { currentStart, priorStart, now }) {
  return runWindowCountQuery({
    repoGuard: repoId, table: 'fleet_events',
    params: [repoId, currentStart, now, priorStart],
    errorLabel: 'getFleetEventWindowCounts',
  });
}

const num = (v) => (v == null ? null : Number(v));

/**
 * Derived measurements over `[sinceIso, now)` for one repo.
 *
 * @param {string} repoId
 * @param {{sinceIso: string, untilIso?: string, limit?: number}} opts window is [sinceIso, untilIso)
 * @returns {Promise<object|null>} null when cloud is off / repo unresolved; `{error}` on a query fault
 */
export async function readFleetTelemetry(repoId, { sinceIso, untilIso = new Date().toISOString(), limit = 10 }) {
  if (!repoId || !await isCloudEnabled()) return null;
  const n = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const p = [repoId, sinceIso, untilIso];
  // ONE window predicate for every query, and ONE failure predicate: a crash
  // ('error') or a mis-invocation ('argv') — the sibling metrics must agree.
  const W = 'repo_id = $1 AND created_at >= $2 AND created_at < $3';
  const FAILED = "outcome IN ('error', 'argv')";
  try {
    const verbs = await many(
      `SELECT verb, mode, count(*)::int AS n,
              count(*) FILTER (WHERE outcome = 'ok')::int AS ok,
              count(*) FILTER (WHERE outcome = 'refused')::int AS refused,
              count(*) FILTER (WHERE outcome = 'pending')::int AS pending,
              count(*) FILTER (WHERE outcome = 'error')::int AS error,
              count(*) FILTER (WHERE outcome = 'argv')::int AS argv,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms,
              max(duration_ms) AS max_ms
         FROM fleet_events WHERE ${W}
        GROUP BY verb, mode ORDER BY n DESC`, p);
    const flow = await many(
      // A LIFECYCLE runs from one successful claim to its END: the first release
      // (done or abandoned) after it and before the session's next claim, else the
      // next claim, else open. Every per-lifecycle aggregate uses that one end, so
      // a reused session id yields several lifecycles, a release with no claim in
      // the window pairs with nothing, and nothing after a release is counted.
      `WITH e AS (
         SELECT session_id, verb, mode, outcome, created_at
           FROM fleet_events WHERE ${W} AND session_id IS NOT NULL),
       c AS (
         SELECT session_id, created_at AS claimed_at,
                lead(created_at) OVER (PARTITION BY session_id ORDER BY created_at) AS next_claim_at
           FROM e WHERE verb = 'claim' AND outcome = 'ok'),
       r AS (
         SELECT c.*,
                (SELECT x.created_at FROM e x
                  WHERE x.session_id = c.session_id AND x.verb = 'release' AND x.outcome = 'ok'
                    AND x.created_at >= c.claimed_at AND (c.next_claim_at IS NULL OR x.created_at < c.next_claim_at)
                  ORDER BY x.created_at LIMIT 1) AS ended_at,
                (SELECT x.mode FROM e x
                  WHERE x.session_id = c.session_id AND x.verb = 'release' AND x.outcome = 'ok'
                    AND x.created_at >= c.claimed_at AND (c.next_claim_at IS NULL OR x.created_at < c.next_claim_at)
                  ORDER BY x.created_at LIMIT 1) AS end_mode
           FROM c),
       s AS (
         SELECT session_id, claimed_at,
                CASE WHEN end_mode = 'done' THEN ended_at END AS released_at,
                coalesce(end_mode = 'abandoned', false) AS abandoned,
                (SELECT count(*) FROM e x WHERE x.session_id = r.session_id AND x.outcome = 'refused'
                    AND x.created_at >= r.claimed_at AND x.created_at < coalesce(r.ended_at, r.next_claim_at, 'infinity'))::int AS refusals,
                (SELECT count(*) FROM e x WHERE x.session_id = r.session_id AND x.verb = 'restack' AND x.outcome = 'ok'
                    AND x.created_at >= r.claimed_at AND x.created_at < coalesce(r.ended_at, r.next_claim_at, 'infinity'))::int AS restacks,
                (SELECT count(*) FROM e x WHERE x.session_id = r.session_id AND x.verb = 'ready' AND x.outcome = 'ok'
                    AND x.created_at >= r.claimed_at AND x.created_at < coalesce(r.ended_at, r.next_claim_at, 'infinity'))::int AS readies
           FROM r)
       SELECT count(*) FILTER (WHERE claimed_at IS NOT NULL)::int AS started,
              count(*) FILTER (WHERE released_at IS NOT NULL)::int AS released,
              count(*) FILTER (WHERE abandoned)::int AS abandoned,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM released_at - claimed_at))
                FILTER (WHERE released_at IS NOT NULL AND claimed_at IS NOT NULL) AS lead_p50_s,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM released_at - claimed_at))
                FILTER (WHERE released_at IS NOT NULL AND claimed_at IS NOT NULL) AS lead_p90_s,
              avg(refusals) AS refusals_per_session,
              avg(restacks) AS restacks_per_session,
              avg(readies) AS readies_per_session
         FROM s`, p);
    const reasons = await many(
      `SELECT outcome, verb, reason_class, count(*)::int AS n
         FROM fleet_events
        WHERE ${W} AND outcome IN ('refused', 'error', 'argv', 'pending')
          AND reason_class IS NOT NULL
        GROUP BY outcome, verb, reason_class ORDER BY n DESC LIMIT ${n}`, p);
    const errorKinds = await many(
      `SELECT detail->>'errorKind' AS kind, count(*)::int AS n
         FROM fleet_events WHERE ${W} AND detail ? 'errorKind'
        GROUP BY 1 ORDER BY n DESC`, p);
    const saturation = await many(
      `SELECT count(*)::int AS observations,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY (detail->>'items')::int) AS items_p50,
              max((detail->>'items')::int) AS items_max,
              avg(CASE WHEN detail->>'held' = 'true' THEN 1 ELSE 0 END) AS held_fraction,
              count(*) FILTER (WHERE (detail->>'registryInvalid')::int > 0)::int AS registry_invalid_seen
         FROM fleet_events
        WHERE ${W} AND verb = 'status' AND outcome = 'ok' AND detail ? 'items'`, p);
    const versions = await many(
      `SELECT coalesce(tool_sha, 'source') AS tool, count(*)::int AS n,
              min(created_at) AS first_seen,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE verb = 'status') AS status_p95_ms,
              count(*) FILTER (WHERE verb = 'status')::int AS status_n,
              avg(CASE WHEN ${FAILED} THEN 1 ELSE 0 END) AS error_rate
         FROM fleet_events WHERE ${W}
        GROUP BY 1 ORDER BY first_seen DESC LIMIT ${n}`, p);
    const f = flow[0] ?? {};
    const s = saturation[0] ?? {};
    return {
      goldenSignals: verbs.map((v) => ({
        verb: v.verb, mode: v.mode, n: v.n, ok: v.ok, refused: v.refused, pending: v.pending, error: v.error, argv: v.argv,
        errorRate: v.n ? Number(((v.error + v.argv) / v.n).toFixed(3)) : null,
        p50Ms: num(v.p50_ms), p95Ms: num(v.p95_ms), maxMs: num(v.max_ms),
      })),
      sessionFlow: {
        started: f.started ?? 0, released: f.released ?? 0, abandoned: f.abandoned ?? 0,
        leadTimeP50Hours: f.lead_p50_s == null ? null : Number((Number(f.lead_p50_s) / 3600).toFixed(2)),
        leadTimeP90Hours: f.lead_p90_s == null ? null : Number((Number(f.lead_p90_s) / 3600).toFixed(2)),
        refusalsPerSession: num(f.refusals_per_session),
        restacksPerSession: num(f.restacks_per_session),
        readiesPerSession: num(f.readies_per_session),
      },
      topReasons: reasons,
      errorKinds,
      saturation: {
        observations: s.observations ?? 0, itemsP50: num(s.items_p50), itemsMax: num(s.items_max),
        heldFraction: num(s.held_fraction), registryInvalidSeen: s.registry_invalid_seen ?? 0,
      },
      versions: versions.map((v) => ({ tool: v.tool, n: v.n, statusN: v.status_n, firstSeen: v.first_seen, statusP95Ms: num(v.status_p95_ms), errorRate: num(v.error_rate) })),
    };
  } catch (err) {
    const schema = describeSchemaFault(err, 'readFleetTelemetry');
    if (schema) process.stderr.write(schema);
    return { error: err.message, schemaFault: Boolean(schema) };
  }
}
