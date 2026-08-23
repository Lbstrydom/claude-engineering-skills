/**
 * @fileoverview Store-backed outcome source for `meta-assess.mjs`.
 *
 * `resolveOutcomeSource` is the single decision point for "where does the
 * periodic self-assessment read its data from" — cloud store (`audit_findings`
 * + `audit_pass_stats` via `fetchCloudMetrics`) or the local
 * `.audit/outcomes.jsonl` fallback (`loadOutcomes`). Every branch, every
 * validity rule, and every field shape here is traced to a specific finding
 * in docs/plans/meta-assess-store-backed-source.md — read that plan's §2 (Key
 * design decisions, D1–D6, M1) and §9 (Testing Strategy) before changing
 * anything; the comments below cite the finding that shaped each decision
 * rather than re-deriving the reasoning inline.
 *
 * Deliberately does NOT resolve repo identity itself (D1a) — `repoId` (or
 * `source:'local'`, which ignores it) always arrives already decided by the
 * caller (`meta-assess.mjs`'s `main()`), which is what keeps this module a
 * pure function of well-formed inputs, testable via `deps` injection (D1c)
 * with no database and no ESM mocking framework.
 *
 * @module scripts/lib/assessment-source
 */

import { fetchCloudMetrics } from '../audit-metrics.mjs';
import { loadOutcomes } from './findings-outcomes.mjs';
import { classifyDbConnectionError } from './db/client.mjs';

const KNOWN_ADJUDICATION_OUTCOMES = new Set(['accepted', 'severity_adjusted', 'dismissed']);

// D1d's five genuine-unavailability causes `classifyDbConnectionError` names
// explicitly. NOT `classified.cause !== 'unknown'` — that function's fallback
// return is `{ cause: code || 'unknown' }`, so a real Postgres error code it
// doesn't recognise (e.g. `42703 undefined_column`, exactly what Gemini G1
// caught in this plan's own SQL) comes back with `cause: '42703'`, which is
// truthy and not the literal string 'unknown' — an `!== 'unknown'` check
// would misclassify that as genuine unavailability and silently swallow the
// `queryError` on precisely the bug class D1d exists to surface.
const CLASSIFIED_UNAVAILABILITY_CAUSES = new Set([
  'unreachable', 'tls-rejected', 'auth-failed', 'database-missing', 'schema-missing',
]);
const KNOWN_SEVERITIES = new Set(['HIGH', 'MEDIUM', 'LOW']);

// ── adaptFindingsToOutcomes ─────────────────────────────────────────────────

/**
 * Map raw `audit_findings` rows (as returned by `fetchCloudMetrics`, widened
 * per M1/D5) onto outcome-shaped records `computeAssessmentMetrics` can
 * consume, plus an `excluded` tally so a window with many invalid rows is
 * visible rather than silently thinned (§9).
 *
 * Validity rules (audit-plan R1/M2, complete enumeration):
 *   - `adjudication_outcome`: 'accepted'/'severity_adjusted' -> accepted:true;
 *     'dismissed' -> accepted:false; NULL -> excluded (not coerced to false —
 *     an unadjudicated finding is not a false positive); any other non-null
 *     value -> excluded + unrecognisedOutcomeCount (mirrors
 *     classifyFinalReviewOutcome's "unknown user_action degrades loudly" rule).
 *   - `severity` not one of HIGH/MEDIUM/LOW -> excluded + invalidSeverityCount.
 *   - `created_at`/`round_raised` missing or unparseable -> excluded +
 *     invalidDateCount/missingRoundCount respectively (never defaulted).
 *
 * `repoFingerprint` and `promptVariantMeasured` are deliberately NOT set here
 * (D1b/M1, D5) — `repo_id` is not a real column on `audit_findings`, and
 * "measurable across the whole window" is a resolver-level question. The
 * caller (`resolveOutcomeSource`) sets `repoFingerprint` from its own
 * already-known `repoId` and computes `promptVariantMeasured` over the
 * returned `records`.
 *
 * @param {Array<{severity?: string, adjudication_outcome?: string|null,
 *   pass_name?: string, created_at?: string|Date, round_raised?: number,
 *   prompt_variant_id?: string|null}>} findings
 * @returns {{records: Array<{accepted: boolean, severity: string,
 *   timestamp: number, round: number, promptVariantId: string|null}>,
 *   excluded: {unrecognisedOutcomeCount: number, invalidSeverityCount: number,
 *   invalidDateCount: number, missingRoundCount: number}}}
 */
export function adaptFindingsToOutcomes(findings) {
  const records = [];
  const excluded = {
    unrecognisedOutcomeCount: 0,
    invalidSeverityCount: 0,
    invalidDateCount: 0,
    missingRoundCount: 0,
  };

  for (const f of findings ?? []) {
    const outcome = f?.adjudication_outcome ?? null;
    if (outcome === null) continue; // unadjudicated — not a false positive, not counted as excluded
    if (!KNOWN_ADJUDICATION_OUTCOMES.has(outcome)) {
      excluded.unrecognisedOutcomeCount++;
      continue;
    }

    if (!KNOWN_SEVERITIES.has(f?.severity)) {
      excluded.invalidSeverityCount++;
      continue;
    }

    const ts = f?.created_at ? new Date(f.created_at).getTime() : NaN;
    if (!Number.isFinite(ts)) {
      excluded.invalidDateCount++;
      continue;
    }

    const round = f?.round_raised;
    if (!Number.isInteger(round)) {
      excluded.missingRoundCount++;
      continue;
    }

    records.push({
      accepted: outcome === 'accepted' || outcome === 'severity_adjusted',
      severity: f.severity,
      timestamp: ts,
      round,
      promptVariantId: f?.prompt_variant_id ?? null,
    });
  }

  return { records, excluded };
}

// ── passRatesFromPassStats ──────────────────────────────────────────────────

/**
 * Aggregate `audit_pass_stats` rows into the D2a per-pass shape. Two nesting
 * levels (R2/H4): the OUTER `measured`/`reason` covers "no pass-stat rows at
 * all this window"; each INNER pass entry carries its own `measured`.
 *
 * `dismissRate`'s denominator is `decided` (`accepted + dismissed`), NOT
 * `raised` (R2/H3 — corrects an R1 formula that hid low adjudication
 * coverage: 100 raised / 1 dismissed reads as 1% under `raised`, but the
 * pass's real adjudicated-outcome FP rate is 50% over the 2 decided).
 *
 * Validity rules (R1/M2, extended R4/M3):
 *   - raised/accepted/dismissed non-finite, negative, non-integer, or outside
 *     Number.isSafeInteger -> row excluded, counted in invalidRowCount (never
 *     clamped — clamping a count is a fabricated measurement).
 *   - accepted + dismissed > raised -> excluded, invalidRowCount (impossible
 *     state, never silently trusted).
 *   - missing/empty pass_name -> excluded, invalidRowCount.
 *
 * `findings_raised`/`findings_accepted`/`findings_dismissed` are `integer`
 * columns (verified against migration 20260330063355_learning_store.sql —
 * not `numeric`), so node-pg parses them as native JS numbers; this repo's
 * documented "Postgres numeric arrives as a string" footgun does not apply.
 *
 * @param {Array<{pass_name?: string, findings_raised?: number,
 *   findings_accepted?: number, findings_dismissed?: number}>} passStats
 * @returns {{byPass: Record<string, {raised:number, accepted:number,
 *   dismissed:number, decided:number, coverage:number|null,
 *   dismissRate:number|null, measured:boolean}>, measured: boolean,
 *   reason: string|null, invalidRowCount: number}}
 */
export function passRatesFromPassStats(passStats) {
  const rows = passStats ?? [];
  let invalidRowCount = 0;
  /** @type {Record<string, {raised:number, accepted:number, dismissed:number}>} */
  const sums = {};

  for (const r of rows) {
    const pass = r?.pass_name;
    if (typeof pass !== 'string' || pass.length === 0) { invalidRowCount++; continue; }

    const raised = r?.findings_raised;
    const accepted = r?.findings_accepted;
    const dismissed = r?.findings_dismissed;
    const isValidCount = (n) => Number.isInteger(n) && Number.isSafeInteger(n) && n >= 0;
    if (!isValidCount(raised) || !isValidCount(accepted) || !isValidCount(dismissed)) {
      invalidRowCount++;
      continue;
    }
    if (accepted + dismissed > raised) { invalidRowCount++; continue; }

    if (!sums[pass]) sums[pass] = { raised: 0, accepted: 0, dismissed: 0 };
    sums[pass].raised += raised;
    sums[pass].accepted += accepted;
    sums[pass].dismissed += dismissed;
  }

  const passNames = Object.keys(sums);
  if (passNames.length === 0) {
    return { byPass: {}, measured: false, reason: 'no pass-stat rows in window', invalidRowCount };
  }

  const byPass = {};
  for (const pass of passNames) {
    const { raised, accepted, dismissed } = sums[pass];
    const decided = accepted + dismissed;
    const coverage = raised > 0 ? decided / raised : null;
    const measured = decided > 0;
    byPass[pass] = {
      raised, accepted, dismissed, decided, coverage,
      dismissRate: measured ? dismissed / decided : null,
      measured,
    };
  }

  return { byPass, measured: true, reason: null, invalidRowCount };
}

// ── resolveOutcomeSource ─────────────────────────────────────────────────────

/** @type {{fetchCloudMetrics: typeof fetchCloudMetrics, loadOutcomes: typeof loadOutcomes}} */
const REAL_DEPS = { fetchCloudMetrics, loadOutcomes };

function emptyCoverage() {
  return { recordsTotal: 0, recordsExcluded: 0, passStatRowsTotal: 0, passStatRowsExcluded: 0 };
}

function timeWindow(days, sinceIso) {
  return { mode: 'time', days, sinceIso, windowSize: null };
}

function countWindow(windowSize) {
  return { mode: 'count', days: null, sinceIso: null, windowSize };
}

/**
 * Resolve where `meta-assess.mjs` reads its outcome data from — the ONE
 * decision point (D1). `repoId` arrives already resolved (or `null` for
 * `source:'local'`, which ignores it); this function never resolves identity
 * itself (D1a).
 *
 * @param {object} args
 * @param {number} [args.days] - store time-window in days (assessmentConfig.windowDays)
 * @param {string|null} [args.repoId] - resolved `audit_repos.id`; unused when source:'local'
 * @param {'auto'|'store'|'local'} [args.source]
 * @param {string} [args.localPath] - path to the local outcomes JSONL fallback
 * @param {{fetchCloudMetrics?: typeof fetchCloudMetrics, loadOutcomes?: typeof loadOutcomes}} [args.deps]
 * @returns {Promise<{records: object[], byPass: object|null,
 *   provenance: 'store'|'local'|'none'|'store-unavailable',
 *   scope: 'repo'|'unresolved', coverage: object, window: object,
 *   queryError?: {cause: string, message: string}}>}
 */
export async function resolveOutcomeSource({
  days, repoId = null, source = 'auto', localPath = '.audit/outcomes.jsonl', deps = REAL_DEPS,
} = {}) {
  const fetchCloud = deps.fetchCloudMetrics ?? REAL_DEPS.fetchCloudMetrics;
  const loadLocal = deps.loadOutcomes ?? REAL_DEPS.loadOutcomes;

  if (source === 'local') {
    // L1's direct-mode contract: file missing, unreadable, or containing no
    // valid lines all read identically (`loadOutcomes`/`readJsonlFile`
    // already collapse "missing" and "unreadable" into an empty array,
    // logging the distinction to stderr — never in the return shape, per
    // L1's own text). `records.length` is therefore the only signal this
    // function needs: any valid line at all means "the file's other valid
    // lines still contribute" (L1) and provenance is 'local'; genuinely zero
    // valid records means 'none' — DELIBERATELY unlike the post-cloud-failure
    // fallback branches below, which stay 'local' even on an empty result
    // (that is D1's older, unchanged contract for a different scenario).
    const outcomes = loadLocal(localPath);
    return {
      records: outcomes,
      byPass: null,
      provenance: outcomes.length > 0 ? 'local' : 'none',
      scope: 'unresolved',
      coverage: emptyCoverage(),
      window: countWindow(outcomes.length),
    };
  }

  // 'auto' and 'store' both need a query, but `main()` guarantees `repoId`
  // is non-null for both by this point (D1a) — 'store' with an unresolved
  // identity never reaches here at all (main() returns provenance:'none'
  // itself); 'auto' with an unresolved identity is converted to a
  // source:'local' call by main() before this function is invoked. So a
  // null repoId here is a genuine caller error, not a state this function
  // has to classify — it is passed straight through to fetchCloudMetrics,
  // which treats null as project-wide (a contract this module never invokes
  // deliberately, but does not need to defend against here).

  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  let cloud;
  try {
    cloud = await fetchCloud(null, days, repoId);
  } catch (err) {
    const classified = classifyDbConnectionError(err);
    // A RECOGNISED connection-level cause (unreachable, auth-failed, …) is
    // genuine unavailability — fall back silently, matching D1's unchanged
    // behaviour. An UNCLASSIFIED error (a code bug: malformed query, missing
    // column, …) still falls back per the repo's graceful-degradation policy
    // (#16 — this tool must not crash the audit loop), but carries a visible
    // `queryError` so a masked bug reads differently from a clean fallback
    // (D1d — audit-plan R3/M1).
    const isClassified = CLASSIFIED_UNAVAILABILITY_CAUSES.has(classified.cause);
    if (source === 'store') {
      return {
        records: [], byPass: null, provenance: 'store-unavailable', scope: 'repo',
        coverage: emptyCoverage(), window: timeWindow(days, sinceIso),
        ...(isClassified ? {} : { queryError: { cause: classified.cause, message: err.message } }),
      };
    }
    const outcomes = loadLocal(localPath);
    return {
      records: outcomes, byPass: null, provenance: 'local', scope: 'repo',
      coverage: emptyCoverage(), window: countWindow(outcomes.length),
      ...(isClassified ? {} : { queryError: { cause: classified.cause, message: err.message } }),
    };
  }

  if (!cloud) {
    // Pool absent — genuine unavailability, same fallback shape as a thrown
    // classified error above.
    if (source === 'store') {
      return {
        records: [], byPass: null, provenance: 'store-unavailable', scope: 'repo',
        coverage: emptyCoverage(), window: timeWindow(days, sinceIso),
      };
    }
    const outcomes = loadLocal(localPath);
    return {
      records: outcomes, byPass: null, provenance: 'local', scope: 'repo',
      coverage: emptyCoverage(), window: countWindow(outcomes.length),
    };
  }

  // Query succeeded — 'store' provenance regardless of row count (D1/R2H2):
  // a successful empty query is a real, measured absence, never a fallback
  // trigger and never 'none'.
  const { records, excluded } = adaptFindingsToOutcomes(cloud.findings);
  const passRates = passRatesFromPassStats(cloud.passStats);
  const recordsExcludedTotal = Object.values(excluded).reduce((a, b) => a + b, 0);

  const promptVariantMeasured = records.some((r) => r.promptVariantId != null);
  for (const r of records) r.repoFingerprint = repoId; // resolver-level constant (M1/G1) — not read off any row

  return {
    records,
    // D2a: `resolveOutcomeSource().byPass` is the per-pass MAP itself
    // (`passRates.byPass`), never `passRatesFromPassStats`'s whole wrapper
    // object — that wrapper's own `measured`/`reason` describe "no pass-stat
    // rows at all this window", which an empty `{}` map already communicates
    // unambiguously to a consumer, and `invalidRowCount` is folded into
    // `coverage.passStatRowsExcluded` below instead of being duplicated here.
    byPass: passRates.byPass,
    provenance: 'store',
    scope: 'repo',
    coverage: {
      recordsTotal: cloud.findings.length,
      recordsExcluded: recordsExcludedTotal,
      passStatRowsTotal: cloud.passStats.length,
      passStatRowsExcluded: passRates.invalidRowCount,
    },
    window: timeWindow(days, sinceIso),
    promptVariantMeasured,
  };
}
