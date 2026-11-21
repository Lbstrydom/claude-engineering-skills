/**
 * @fileoverview Assemble a `telemetry-export/v1` document from injected readers.
 *
 * PURE over its `deps`: no I/O here, so every state — a reachable store, a down store, an
 * unregistered repo, a schema fault — is testable without a database or a network.
 *
 * THE RULE THIS FILE EXISTS TO KEEP: a group that could not be read is
 * `{measured:false, reason}` and carries NO counts. It is never filled with zeros, because
 * a zero in a received export is a measurement ("nothing happened this week") and CES reads
 * it as one. Idle and unreadable are different facts; the document says which.
 *
 * Field sources (docs/plans/private-store-telemetry-path.md §2.1 — specified before code):
 *
 *   field                       source                                              window / units
 *   health.store                doctor store-reachability probe                     now
 *   health.drift.*              `setup-postgres --check-drift --live` (migrations   now; counts of
 *                               unapplied / applied-with-different-sha / live       migrations / constraints
 *                               constraints missing or altered)
 *   audit.runs                  count of `audit_runs` rows for the repo             created_at in [from, to)
 *   audit.convergedRuns         …of which `round_converged_after IS NOT NULL`       same
 *   audit.byMode / byVerdict    `audit_runs.mode` / `.gemini_verdict` → enum        same
 *   audit.findingsBy*           `audit_findings` joined to those runs, grouped by   same
 *                               severity / adjudication_outcome / pass_name → enum
 *   upstream.open               `upstream_issues` WHERE state='open' for the repo   created before `to` (the export
 *                                                                                   instant); the snapshot begins a
 *                                                                                   few seconds LATER, so a report
 *                                                                                   opened in that gap is not listed
 *   upstream.open[].id          first 12 hex of sha256(row id) — a display handle,  never a join key
 *   upstream.open[].ageDays     whole days from created_at to `to`
 *
 * All reads for the audit and upstream groups happen in ONE read-only repeatable-read
 * transaction (sources.mjs), so the groups agree with each other.
 *
 * @module scripts/lib/telemetry-export/build
 */
import crypto from 'node:crypto';
import {
  SCHEMA_ID, WINDOW_DAYS, MAX_UPSTREAM_ROWS, SEVERITIES, UPSTREAM_SEVERITIES, AUDIT_MODES, VERDICTS,
  OUTCOMES, PASSES, validateExport,
} from './schema.mjs';
import { assertExportClean } from './redact.mjs';

const DAY_MS = 86_400_000;

/** Map a source value to its closed enum, or `'other'`; counts the misses so the document can say so. */
function toEnum(value, allowed, tally, weight = 1) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (allowed.includes(v)) return v;
  const lower = v.toLowerCase();
  const hit = allowed.find((a) => a.toLowerCase() === lower);
  if (hit) return hit;
  if (tally) tally.n += weight;   // by the grouped row's multiplicity: a source value, not a SQL row
  return 'other';
}

const zeros = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));

/**
 * An aggregate count must be PRESENT and a safe non-negative integer: `Number(x) || 0` turned an
 * absent or garbled count into a measured zero. Digit strings (what pg returns for bigint) and
 * bigints are accepted; nothing else is.
 */
export function strictCount(v, what = 'count') {
  const n = typeof v === 'bigint' ? Number(v) : (typeof v === 'string' && /^[0-9]+$/.test(v) ? Number(v) : v);
  if (!Number.isSafeInteger(n) || n < 0) throw Object.assign(new Error(`${what} is not a non-negative integer`), { code: 'BAD_AGGREGATE' });
  return n;
}

/**
 * @param {{runs: Array<{mode: string|null, gemini_verdict: string|null, converged: boolean, n: number}>,
 *          findings: Array<{severity: string|null, adjudication_outcome: string|null, pass_name: string|null, n: number}>}} rows
 * @param {{n: number}} tally
 */
export function mapAuditRows(rows, tally) {
  const byMode = zeros(AUDIT_MODES);
  const byVerdict = zeros(VERDICTS);
  let runs = 0; let convergedRuns = 0;
  for (const r of rows.runs) {
    const n = strictCount(r.n, 'audit runs');
    runs += n;
    if (r.converged) convergedRuns += n;
    byMode[toEnum(r.mode, AUDIT_MODES, tally, n)] += n;
    // A run with no verdict is `none` (the reviewer did not run / write back), not `other`.
    byVerdict[r.gemini_verdict == null || r.gemini_verdict === '' ? 'none' : toEnum(r.gemini_verdict, VERDICTS, tally, n)] += n;
  }
  const findingsBySeverity = zeros(SEVERITIES);
  const findingsByOutcome = zeros(OUTCOMES);
  const findingsByPass = zeros(PASSES);
  for (const f of rows.findings) {
    const n = strictCount(f.n, 'findings');
    findingsBySeverity[toEnum(f.severity, SEVERITIES, tally, n)] += n;
    findingsByOutcome[f.adjudication_outcome == null || f.adjudication_outcome === '' ? 'pending' : toEnum(f.adjudication_outcome, OUTCOMES, tally, n)] += n;
    findingsByPass[toEnum(f.pass_name, PASSES, tally, n)] += n;
  }
  return { measured: true, runs, convergedRuns, byMode, byVerdict, findingsBySeverity, findingsByOutcome, findingsByPass };
}

/** First 12 hex of sha256 of the row id: a display handle that cannot be mistaken for, or joined to, a store key. */
export function displayId(rowId) {
  return crypto.createHash('sha256').update(String(rowId)).digest('hex').slice(0, 12);
}

/**
 * @param {Array<{id: string, severity: string|null, created_at: string|Date}>} rows oldest first, up to MAX+1
 * @param {number} totalOpen
 * @param {Date} to
 * @param {{n: number}} tally
 */
export function mapUpstreamRows(rows, totalOpen, to, tally) {
  const open = rows.slice(0, MAX_UPSTREAM_ROWS).map((r) => ({
    id: displayId(r.id),
    severity: toEnum(r.severity, UPSTREAM_SEVERITIES, tally),
    ageDays: Math.max(0, Math.floor((to.getTime() - new Date(r.created_at).getTime()) / DAY_MS)),
  }));
  return { measured: true, open, totalOpen, truncated: open.length < totalOpen };
}

/**
 * Drift response → group. The response must be COMPLETE: a missing or malformed list is an unreadable
 * measurement, never an empty one (an absent `unapplied` read as `[]` is "0 migrations behind").
 * Live constraints that were not measured make the whole group unmeasured, not "0 broken".
 */
export function mapDrift(resp) {
  const dd = resp?.drift;
  const live = resp?.liveConstraints;
  const ok = dd && Array.isArray(dd.unapplied) && Array.isArray(dd.shaMismatch)
    && live && live.measured === true && Array.isArray(live.missing) && Array.isArray(live.altered);
  if (!ok) return { measured: false, reason: 'read-failed' };
  return { measured: true, unapplied: dd.unapplied.length, shaMismatch: dd.shaMismatch.length, liveBroken: live.missing.length + live.altered.length };
}

/** Closed reason for an error thrown by a reader. Never the message: it can carry a host. */
export function reasonForError(err) {
  const code = String(err?.code ?? '');
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ECONNRESET'].includes(code)) return 'store-unreachable';
  if (code === 'NO_DB') return 'store-unconfigured';
  if (code === 'BAD_AGGREGATE') return 'read-failed';
  // A typed SQLSTATE in the schema-fault classes (undefined table / column, permission) is a fault, not an absence.
  if (/^(42P01|42703|42501|42883)$/.test(code)) return 'schema-fault';
  return 'read-failed';
}

/**
 * @param {object} p
 * @param {Date} p.now
 * @param {string} p.consumerAlias
 * @param {string|null} p.storeFingerprint
 * @param {string|null} p.toolBundleSha
 * @param {string} p.exportId
 * @param {object} p.deps
 * @param {() => Promise<{configured: boolean, ok?: boolean}>} p.deps.reachability
 * @param {() => Promise<{ok: boolean, drift?: object, reason?: string}>} p.deps.drift
 * @param {(w: {from: Date, to: Date}) => Promise<{status: 'ok', runs: object[], findings: object[], upstream: object[], totalOpen: number}
 *          | {status: 'repo-unregistered'|'repo-unresolved'}>} p.deps.readRows
 * @returns {Promise<object>} a validated, redaction-checked document
 */
export async function buildExport({ now, consumerAlias, storeFingerprint, toolBundleSha, exportId, deps }) {
  const to = now;
  const from = new Date(to.getTime() - WINDOW_DAYS * DAY_MS);
  const tally = { n: 0 };

  const reach = await deps.reachability();
  const store = !reach.configured ? 'unconfigured' : (reach.ok === true ? 'reachable' : 'configured-but-unreachable');

  let drift = { measured: false, reason: store === 'unconfigured' ? 'store-unconfigured' : 'store-unreachable' };
  let audit = { measured: false, reason: drift.reason };
  let upstream = { measured: false, reason: drift.reason };

  if (store === 'reachable') {
    try {
      const d = await deps.drift();
      if (d.ok && d.drift) {
        drift = mapDrift(d.drift);
      } else {
        drift = { measured: false, reason: d.reason === 'store-unreachable' ? 'store-unreachable' : 'read-failed' };
      }
    } catch { drift = { measured: false, reason: 'read-failed' }; }

    try {
      const rows = await deps.readRows({ from, to });
      if (rows.status === 'ok') {
        audit = mapAuditRows({ runs: rows.runs, findings: rows.findings }, tally);
        upstream = mapUpstreamRows(rows.upstream, rows.totalOpen, to, tally);
      } else {
        audit = { measured: false, reason: rows.status };
        upstream = { measured: false, reason: rows.status };
      }
    } catch (err) {
      audit = { measured: false, reason: reasonForError(err) };
      upstream = { measured: false, reason: audit.reason };
    }
  }

  const doc = {
    schema: SCHEMA_ID,
    exportId,
    generatedAt: now.toISOString(),
    window: { from: from.toISOString(), to: to.toISOString() },
    consumerAlias,
    storeFingerprint,
    toolBundleSha,
    health: { store, drift },
    audit,
    upstream,
    redactions: tally.n,
  };

  const v = validateExport(doc);
  if (!v.ok) throw new Error(`telemetry export built an invalid document (${v.reason})`);
  assertExportClean(v.doc);
  return v.doc;
}
