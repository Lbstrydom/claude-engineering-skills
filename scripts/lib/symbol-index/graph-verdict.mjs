/**
 * @fileoverview The single oracle for "is this observed graph trustworthy?".
 *
 * Mirrors `gateUnverifiedReason` (`lib/visual/drift.mjs:89`) and nav-audit's
 * capture-status rollup: ONE pure function that both the CLI exit code and the
 * dashboard cell consume, so the two can never disagree about whether a graph
 * may be believed. Two independent verdict implementations is how a green cell
 * ends up rendered against an `unverified` envelope.
 *
 * Plan: docs/plans/observed-graph-coverage-honesty.md §2.1.3 / §2.1.4
 *
 * @module scripts/lib/symbol-index/graph-verdict
 */

/** Closed status set. `unknown` is NOT a synonym for `verified` anywhere. */
export const GRAPH_STATUS = Object.freeze({
  VERIFIED: 'verified',
  DEGRADED: 'degraded',
  UNVERIFIED: 'unverified',
  UNKNOWN: 'unknown',
});

/** Closed reason enum — every non-verified status names exactly why. */
export const GRAPH_REASON = Object.freeze({
  EXTRACTION_FAILED: 'extraction_failed',
  EXTRACTION_TIMEOUT: 'extraction_timeout',
  NOT_MEASURED: 'not_measured',
  STALE_MEASUREMENT: 'stale_measurement',
  EMPTY_UNIVERSE: 'empty_universe',
  ZERO_CRUISED: 'zero_cruised',
  ZERO_ATTRIBUTED: 'zero_attributed',
  BUDGET_EXCEEDED: 'budget_exceeded',
  BELOW_FLOOR: 'below_floor',
  BELOW_ATTRIBUTION_FLOOR: 'below_attribution_floor',
});

export const COVERAGE_DEFAULTS = Object.freeze({
  floor: 0.90,
  attributionFloor: 0.50,
  maxCruiseMs: 120_000,
  hardTimeoutMs: 300_000,
  enforce: false,
  sampleCap: 20,
});

/**
 * Normalize the `coverage` block of `.audit-loop/domain-map.json`.
 *
 * Defaulting happens HERE and only here. `graphVerdict` does no defaulting of
 * its own — two defaulting sites is how the CLI and the dashboard would drift
 * to different thresholds while both looking correct.
 *
 * Never throws: an invalid value logs once and falls back (#16 Graceful
 * Degradation). A malformed domain-map must not take down `arch:render`.
 *
 * @param {object|undefined} raw - the `coverage` key, if present
 * @param {(msg: string) => void} [warn]
 */
export function parseCoverageConfig(raw, warn = () => {}) {
  const out = { ...COVERAGE_DEFAULTS };
  if (raw == null) return out;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warn('[coverage] `coverage` in domain-map.json is not an object — using defaults');
    return out;
  }
  const ratio = (k) => {
    const v = raw[k];
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      warn(`[coverage] \`${k}\` must be a number in [0,1] — using default ${out[k]}`);
      return;
    }
    out[k] = v;
  };
  const positiveInt = (k) => {
    const v = raw[k];
    if (v === undefined) return;
    if (!Number.isInteger(v) || v <= 0) {
      warn(`[coverage] \`${k}\` must be a positive integer — using default ${out[k]}`);
      return;
    }
    out[k] = v;
  };
  ratio('floor');
  ratio('attributionFloor');
  positiveInt('maxCruiseMs');
  positiveInt('hardTimeoutMs');
  if (raw.enforce !== undefined) {
    if (typeof raw.enforce !== 'boolean') {
      warn('[coverage] `enforce` must be a boolean — using default false');
    } else {
      out.enforce = raw.enforce;
    }
  }
  if (raw.sampleCap !== undefined) {
    if (!Number.isInteger(raw.sampleCap) || raw.sampleCap < 0 || raw.sampleCap > 100) {
      warn('[coverage] `sampleCap` must be an integer in [0,100] — using default 20');
    } else {
      out.sampleCap = raw.sampleCap;
    }
  }
  // Forward-compat: a consumer on an older sync may carry keys we don't know.
  for (const k of Object.keys(raw)) {
    if (!(k in COVERAGE_DEFAULTS)) warn(`[coverage] ignoring unknown key \`${k}\``);
  }
  // A hard timeout at or below the soft budget means the soft budget can never
  // report — the run is always killed first. Repair rather than reject.
  if (out.hardTimeoutMs <= out.maxCruiseMs) {
    warn(`[coverage] hardTimeoutMs (${out.hardTimeoutMs}) must exceed maxCruiseMs `
      + `(${out.maxCruiseMs}) or the soft budget can never fire — using ${out.maxCruiseMs * 2}`);
    out.hardTimeoutMs = out.maxCruiseMs * 2;
  }
  return out;
}

/**
 * The precedence table, first match wins.
 *
 * Order is the contract: a failure can never be masked by a ratio that happens
 * to look fine. Rows 5-7 are the vacuity guards — neither a cruise that
 * returned nothing nor a graph where every edge was dropped as untagged may
 * read `verified` (AGENTS.md "audit your success paths"). Row 7 is the
 * 68%-invisible consumer specifically: without it, full extraction coverage
 * with zero attributed edges would still render green.
 *
 * @param {{extraction?: object|null, attribution?: object|null,
 *          stale?: boolean, config?: object}} input
 * @returns {{status: string, reason: string|null}}
 */
export function graphVerdict({
  extraction = null, attribution = null, stale = false, config = COVERAGE_DEFAULTS,
} = {}) {
  const S = GRAPH_STATUS;
  const R = GRAPH_REASON;

  // 1-2. Extraction never produced a measurement.
  if (extraction?.outcome === 'failed') {
    return { status: S.UNVERIFIED, reason: R.EXTRACTION_FAILED };
  }
  if (extraction?.outcome === 'timedOut') {
    return { status: S.UNVERIFIED, reason: R.EXTRACTION_TIMEOUT };
  }
  // 3. Pre-feature envelope. Absence is never evidence of cleanliness.
  if (extraction == null) {
    return { status: S.UNKNOWN, reason: R.NOT_MEASURED };
  }
  // 4. Copied forward from an earlier run. Coverage is a full-run measurement;
  //    an incremental refresh never inherits a verdict, because file CONTENT
  //    can change (adding imports, making them untagged) while the file LIST —
  //    the only thing a cheap digest could compare — stays byte-identical.
  if (stale === true) {
    return { status: S.UNKNOWN, reason: R.STALE_MEASUREMENT };
  }
  // 5-6. Extraction vacuity guards.
  if (!extraction.eligible) {
    return { status: S.UNVERIFIED, reason: R.EMPTY_UNIVERSE };
  }
  if (!extraction.cruised) {
    return { status: S.UNVERIFIED, reason: R.ZERO_CRUISED };
  }
  // 7. Attribution vacuity guard.
  if (attribution && attribution.attributable > 0 && attribution.attributed === 0) {
    return { status: S.UNVERIFIED, reason: R.ZERO_ATTRIBUTED };
  }
  // 8-10. Degradations.
  if (Number.isFinite(extraction.elapsedMs) && extraction.elapsedMs > config.maxCruiseMs) {
    return { status: S.DEGRADED, reason: R.BUDGET_EXCEEDED };
  }
  if (Number.isFinite(extraction.ratio) && extraction.ratio < config.floor) {
    return { status: S.DEGRADED, reason: R.BELOW_FLOOR };
  }
  if (attribution && Number.isFinite(attribution.ratio)
      && attribution.ratio < config.attributionFloor) {
    return { status: S.DEGRADED, reason: R.BELOW_ATTRIBUTION_FLOOR };
  }
  return { status: S.VERIFIED, reason: null };
}

/**
 * Gate helper — the exit-code decision, kept next to the verdict so the two
 * cannot drift.
 *
 * Deliberately NOT consulted by `arch:render`: that command must always exit 0
 * so a non-zero gate can never abort the `dashboard:setup && ` chain precisely
 * when there is a degraded graph to display. `arch:coverage-gate` owns this.
 *
 * @returns {number} 0 = pass/report-only · 2 = gate failed (never 1; 1 stays "tool error")
 */
export function coverageGateExitCode(verdict, config = COVERAGE_DEFAULTS) {
  if (!config.enforce) return 0;
  const bad = verdict?.status === GRAPH_STATUS.DEGRADED
    || verdict?.status === GRAPH_STATUS.UNVERIFIED;
  return bad ? 2 : 0;
}
