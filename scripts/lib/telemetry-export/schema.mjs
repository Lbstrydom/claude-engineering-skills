/**
 * @fileoverview `telemetry-export/v1` — the ONE schema both the exporter (on a
 * consumer's machine) and the reader (in CES) import.
 *
 * WHY IT EXISTS (docs/plans/private-store-telemetry-path.md). A consumer whose
 * audit store sits on a private network cannot be read by CES. It pushes a small,
 * redacted summary instead, and this schema is what makes "redacted" a property of
 * the DATA SHAPE rather than of a scrubber's mood:
 *
 *   - ALLOWLIST BY CONSTRUCTION. Every object is `.strict()` — an unknown key is a
 *     rejection, never a pass-through — and there is NO free-text field anywhere
 *     (no finding detail, no issue title, no path, no repo name, no hostname). A
 *     field that does not exist cannot leak.
 *   - EVERY STRING HAS A CONTRACT. Classifications are closed enums (the producer maps
 *     a source value to the enum or to `'other'`); identifying and temporal fields are
 *     bounded formats (regex + length). A value outside its contract is a rejection.
 *   - MEASURED, NEVER ZERO-BY-OMISSION. Every group carries `measured`; an unreadable
 *     group is `{measured:false, reason}` and carries NO counts, so it cannot be summed
 *     as zero. A genuine zero is `{measured:true, …0…}` and stays a zero.
 *
 * Versioning: `schema` is a literal. The reader supports the current and previous
 * version; an unknown version is `rejected: unsupported-version`. An additive field is
 * a NEW version (strictness would otherwise make an old reader reject it).
 *
 * @module scripts/lib/telemetry-export/schema
 */
import { z } from 'zod';

export const SCHEMA_ID = 'telemetry-export/v1';

/** Window length in days, fixed by the plan (§2.1) — a figure over a different window is a different figure. */
export const WINDOW_DAYS = 7;
/** Hard cap on upstream rows in one export (§2.1); beyond it `truncated: true`. */
export const MAX_UPSTREAM_ROWS = 200;
/** The reader refuses a larger file without parsing it (§2.1 bounds). */
export const MAX_EXPORT_BYTES = 256 * 1024;

// ── Closed enums ─────────────────────────────────────────────────────────────

export const SEVERITIES = Object.freeze(['HIGH', 'MEDIUM', 'LOW', 'other']);
export const UPSTREAM_SEVERITIES = Object.freeze(['BLOCKER', 'HIGH', 'MEDIUM', 'LOW', 'other']);
export const AUDIT_MODES = Object.freeze(['code', 'plan', 'other']);
export const VERDICTS = Object.freeze(['approve', 'concerns', 'reject', 'none', 'other']);
export const OUTCOMES = Object.freeze(['accepted', 'dismissed', 'severity_adjusted', 'pending', 'other']);
export const PASSES = Object.freeze([
  'structure', 'wiring', 'backend', 'frontend', 'sustainability',
  'quickfix', 'duplication', 'adjacency', 'other',
]);
export const STORE_VERDICTS = Object.freeze(['reachable', 'configured-but-unreachable', 'unconfigured']);
/** Why a group could not be read. Closed, so a reason is never free text. */
export const UNMEASURED_REASONS = Object.freeze([
  'store-unreachable', 'store-unconfigured', 'repo-unregistered', 'repo-unresolved',
  'schema-fault', 'read-failed', 'not-requested',
]);

// ── Bounded formats ──────────────────────────────────────────────────────────

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
/** ISO-8601 UTC with a trailing Z, as `Date#toISOString` writes it. */
const isoUtc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/);
const alias = z.string().regex(/^[a-z0-9-]{1,32}$/);
const hex = (n) => z.string().regex(new RegExp(`^[0-9a-f]{${n}}$`));
const count = z.number().int().nonnegative();

/** `{ENUM_VALUE: count}` over a closed key set, every key present (a missing key would read as an unreported zero). */
const countsOver = (keys) => z.object(Object.fromEntries(keys.map((k) => [k, count]))).strict();

// ── Groups ───────────────────────────────────────────────────────────────────

const unmeasured = z.object({
  measured: z.literal(false),
  reason: z.enum(UNMEASURED_REASONS),
}).strict();

const measuredOr = (shape) => z.union([
  z.object({ measured: z.literal(true), ...shape }).strict(),
  unmeasured,
]);

const health = z.object({
  store: z.enum(STORE_VERDICTS),
  drift: measuredOr({
    unapplied: count,
    shaMismatch: count,
    liveBroken: count,
  }),
}).strict();

const audit = measuredOr({
  runs: count,
  convergedRuns: count,
  byMode: countsOver(AUDIT_MODES),
  byVerdict: countsOver(VERDICTS),
  findingsBySeverity: countsOver(SEVERITIES),
  findingsByOutcome: countsOver(OUTCOMES),
  findingsByPass: countsOver(PASSES),
});

const upstream = measuredOr({
  open: z.array(z.object({
    id: hex(12),
    severity: z.enum(UPSTREAM_SEVERITIES),
    ageDays: count,
  }).strict()).max(MAX_UPSTREAM_ROWS),
  totalOpen: count,
  truncated: z.boolean(),
});

export const TelemetryExportSchema = z.object({
  schema: z.literal(SCHEMA_ID),
  exportId: uuid,
  generatedAt: isoUtc,
  window: z.object({ from: isoUtc, to: isoUtc }).strict(),
  consumerAlias: alias,
  storeFingerprint: hex(16).nullable(),
  toolBundleSha: hex(40).nullable(),
  health,
  audit,
  upstream,
  /** How many source values fell outside their closed enum and were reported as 'other'. Observability only. */
  redactions: count,
}).strict();

/**
 * Shape + cross-field checks the object schema cannot express.
 *
 * @param {unknown} doc
 * @returns {{ok: true, doc: object} | {ok: false, reason: string}}
 */
export function validateExport(doc) {
  const parsed = TelemetryExportSchema.safeParse(doc);
  if (!parsed.success) {
    // First issue only, as a path — never the offending VALUE (it may be the thing that must not be echoed).
    const i = parsed.error.issues[0];
    return { ok: false, reason: `schema: ${i?.code ?? 'invalid'} at ${(i?.path ?? []).join('.') || '(root)'}` };
  }
  const d = parsed.data;
  if (Date.parse(d.window.from) >= Date.parse(d.window.to)) return { ok: false, reason: 'window: from is not before to' };
  if (d.upstream.measured) {
    if (d.upstream.open.length > d.upstream.totalOpen) return { ok: false, reason: 'upstream: more rows than totalOpen' };
    if (d.upstream.truncated !== (d.upstream.open.length < d.upstream.totalOpen)) return { ok: false, reason: 'upstream: truncated flag disagrees with the rows' };
  }
  if (d.audit.measured && d.audit.convergedRuns > d.audit.runs) return { ok: false, reason: 'audit: convergedRuns exceeds runs' };
  if (d.audit.measured) {
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    if (sum(d.audit.byMode) !== d.audit.runs) return { ok: false, reason: 'audit: byMode does not sum to runs' };
    if (sum(d.audit.byVerdict) !== d.audit.runs) return { ok: false, reason: 'audit: byVerdict does not sum to runs' };
    const f = sum(d.audit.findingsBySeverity);
    if (sum(d.audit.findingsByOutcome) !== f || sum(d.audit.findingsByPass) !== f) return { ok: false, reason: 'audit: the finding breakdowns disagree' };
  }
  return { ok: true, doc: d };
}
