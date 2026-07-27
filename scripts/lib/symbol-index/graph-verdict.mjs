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
  MALFORMED_MEASUREMENT: 'malformed_measurement',
});

/**
 * Node's setTimeout/setInterval delay ceiling (2^31 - 1 ms, ~24.8 days). A
 * delay above this is silently CLAMPED to it (not honored) rather than
 * rejected — see the Node docs for setTimeout. `maxCruiseMs`/`hardTimeoutMs`
 * are both consumed as timer delays downstream, so config validation must
 * enforce this ceiling itself; Node will not tell the caller it happened.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export const COVERAGE_DEFAULTS = Object.freeze({
  floor: 0.90,
  attributionFloor: 0.50,
  maxCruiseMs: 120_000,
  // `hardTimeoutMs` is the extract subprocess's **idle** (inactivity) threshold
  // — the longest the child may go with NO stdout output before it is treated
  // as wedged (docs/plans/extract-idle-timeout.md). It is NOT a total-duration
  // bound: the child streams a `progress` record per file, so a healthy run of
  // any size keeps resetting it. The `hardTimeoutMs > maxCruiseMs` repair below
  // is exactly the liveness invariant — the idle threshold must exceed the
  // longest *expected* silent phase, which (after the per-file heartbeat) is the
  // coverage cruise. (Name retained for config back-compat; a rename is a
  // mechanical follow-up if a second silent phase ever appears.)
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
 * The `warn` callback receives `(msg, kind)` where kind is:
 *   'invalid' — a key we ACT on had a bad type/range, so the effective policy
 *               is not the one that was written. A gate must treat this as
 *               fatal (§2.1.4 binding).
 *   'unknown' — a key we do not recognise. This is the forward-compat path: a
 *               consumer on an older sync may carry keys from a newer schema.
 *               It must NOT be fatal, or the compat mechanism becomes the
 *               breakage it exists to prevent (Cluster B final gate, HIGH).
 * Existing callers that take only `msg` are unaffected.
 *
 * @param {object|undefined} raw - the `coverage` key, if present
 * @param {(msg: string, kind?: 'invalid'|'unknown') => void} [warn]
 */
export function parseCoverageConfig(raw, warn = () => {}) {
  const out = { ...COVERAGE_DEFAULTS };
  if (raw == null) return out;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warn('[coverage] `coverage` in domain-map.json is not an object — using defaults', 'invalid');
    return out;
  }
  const ratio = (k) => {
    const v = raw[k];
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      warn(`[coverage] \`${k}\` must be a number in [0,1] — using default ${out[k]}`, 'invalid');
      return;
    }
    out[k] = v;
  };
  const positiveInt = (k) => {
    const v = raw[k];
    if (v === undefined) return;
    if (!Number.isInteger(v) || v <= 0) {
      warn(`[coverage] \`${k}\` must be a positive integer — using default ${out[k]}`, 'invalid');
      return;
    }
    // `maxCruiseMs`/`hardTimeoutMs` are both consumed as setTimeout/setInterval
    // delays in scripts/lib/subprocess.mjs. Node clamps (does not honor) a
    // delay above this ceiling — accepting a larger value here would silently
    // configure a timeout that never behaves as configured. Reject rather than
    // clamp, matching this function's existing fail-closed-with-default posture.
    if (v > MAX_TIMER_DELAY_MS) {
      warn(`[coverage] \`${k}\` (${v}) exceeds Node's max timer delay `
        + `(${MAX_TIMER_DELAY_MS}) — a larger value is clamped, not honored — using default ${out[k]}`, 'invalid');
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
      warn('[coverage] `enforce` must be a boolean — using default false', 'invalid');
    } else {
      out.enforce = raw.enforce;
    }
  }
  if (raw.sampleCap !== undefined) {
    if (!Number.isInteger(raw.sampleCap) || raw.sampleCap < 0 || raw.sampleCap > 100) {
      warn('[coverage] `sampleCap` must be an integer in [0,100] — using default 20', 'invalid');
    } else {
      out.sampleCap = raw.sampleCap;
    }
  }
  // Forward-compat: a consumer on an older sync may carry keys we don't know.
  for (const k of Object.keys(raw)) {
    if (!(k in COVERAGE_DEFAULTS)) warn(`[coverage] ignoring unknown key \`${k}\``, 'unknown');
  }
  // The idle threshold must exceed the longest expected silent phase — the
  // coverage cruise (bounded by maxCruiseMs). At or below it, a slow-but-working
  // cruise's silence would trip the idle kill, AND the soft budget could never
  // report first. Repair rather than reject. (Pre-idle this guard read "the soft
  // budget can never fire"; the arithmetic is identical, the reason is now
  // liveness — see COVERAGE_DEFAULTS.hardTimeoutMs.)
  if (out.hardTimeoutMs <= out.maxCruiseMs) {
    // `maxCruiseMs * 2` can itself exceed MAX_TIMER_DELAY_MS when maxCruiseMs
    // is already large (audit round-1 H1/M6) — the positiveInt() ceiling check
    // above only bounds RAW input, it can't see this repair's own arithmetic.
    // Clamp rather than reintroduce an unhonourable timer value.
    const repaired = Math.min(out.maxCruiseMs * 2, MAX_TIMER_DELAY_MS);
    warn(`[coverage] hardTimeoutMs (${out.hardTimeoutMs}) must exceed maxCruiseMs `
      + `(${out.maxCruiseMs}) — the idle threshold must clear the cruise's silent window — using ${repaired}`, 'invalid');
    out.hardTimeoutMs = repaired;
    if (out.hardTimeoutMs <= out.maxCruiseMs) {
      // maxCruiseMs itself is already at/near Node's timer ceiling — no valid
      // hardTimeoutMs can both clear the cruise window and stay under
      // MAX_TIMER_DELAY_MS. Fall back to defaults for both rather than publish
      // an internally-contradictory config.
      warn(`[coverage] maxCruiseMs (${out.maxCruiseMs}) leaves no valid hardTimeoutMs under Node's max timer delay `
        + `(${MAX_TIMER_DELAY_MS}) — falling back to defaults for both`, 'invalid');
      out.maxCruiseMs = COVERAGE_DEFAULTS.maxCruiseMs;
      out.hardTimeoutMs = COVERAGE_DEFAULTS.hardTimeoutMs;
    }
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
  // 8-10. Degradations. A non-finite measurement is tracked in `missing`
  // rather than silently skipped — the old `Number.isFinite(X) && X > …`
  // guard let a malformed X (NaN, undefined, a stringified number) fall
  // through to VERIFIED indistinguishably from "healthy", which is exactly
  // the silent-green failure mode this whole module exists to prevent. A
  // present-and-degraded field still wins even if a sibling is separately
  // missing — each field's own finite-check gates its own degradation
  // return, and only the fallthrough case consults `missing`.
  const missing = [];
  if (Number.isFinite(extraction.elapsedMs)) {
    if (extraction.elapsedMs > config.maxCruiseMs) {
      return { status: S.DEGRADED, reason: R.BUDGET_EXCEEDED };
    }
  } else {
    missing.push('elapsedMs');
  }
  if (Number.isFinite(extraction.ratio)) {
    if (extraction.ratio < config.floor) {
      return { status: S.DEGRADED, reason: R.BELOW_FLOOR };
    }
  } else {
    missing.push('ratio');
  }
  if (attribution) {
    if (Number.isFinite(attribution.ratio)) {
      if (attribution.ratio < config.attributionFloor) {
        return { status: S.DEGRADED, reason: R.BELOW_ATTRIBUTION_FLOOR };
      }
    } else {
      missing.push('attributionRatio');
    }
  }
  if (missing.length > 0) {
    return { status: S.UNKNOWN, reason: R.MALFORMED_MEASUREMENT, missing };
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
