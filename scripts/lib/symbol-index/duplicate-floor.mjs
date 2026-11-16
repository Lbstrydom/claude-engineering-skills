/**
 * @fileoverview The size floor for duplicate clusters — the ONE place its
 * default, its input contract, its reported state and its exit rule live.
 *
 * A 2-5 line helper (`sleep`, `sha256`) copied across test files is not
 * refactor debt, but exact-signature clustering reported it and inflated the
 * drift score (storyline's nightly drift job failed 7 of 8 runs on exactly
 * five such clusters). The floor itself is a SQL predicate inside
 * `top_duplicate_clusters` and `drift_score`
 * (supabase/migrations/20261030130000_duplicate_min_lines_floor.sql) so the
 * list and the score share one population; this module owns everything
 * around it:
 *
 *   - `resolveMinLines` — flag > env > default, one parser for every consumer.
 *     A malformed value is a hard error, never a silent fall back to the
 *     default (a typo'd `--min-lines 1O` must not quietly run with 6).
 *   - `buildFloorState` — one structured `floor` object, so "applied", "off",
 *     "store cannot honour it" and "count unavailable" are four different
 *     states and none of them can render as `0 suppressed`.
 *   - `floorExitCode` — an unsupported store is exit 0 only when the floor was
 *     the INHERITED default; a floor the operator asked for by name and the
 *     store cannot honour is exit 2.
 *
 * @module scripts/lib/symbol-index/duplicate-floor
 */

/**
 * CES's default: suppress symbols spanning FEWER than this many lines, i.e.
 * 5 lines or fewer — the reported class (`sleep`, `sha256`, `claim` helpers).
 * A function with real logic is ≥6 lines and still clusters. Override per run
 * with `--min-lines N` or `ARCH_DUPLICATE_MIN_LINES`; `0` disables the floor.
 */
export const DEFAULT_DUPLICATE_MIN_LINES = 6;

/** Upper bound: anything larger is a typo, not a size floor. */
export const MAX_DUPLICATE_MIN_LINES = 10000;

export const MIN_LINES_ENV = 'ARCH_DUPLICATE_MIN_LINES';

export class FloorArgError extends Error {}

function parseMinLines(raw, label) {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) {
    throw new FloorArgError(
      `${label} must be an integer between 0 and ${MAX_DUPLICATE_MIN_LINES} (0 disables the floor); got "${text}"`);
  }
  const n = Number(text);
  if (n > MAX_DUPLICATE_MIN_LINES) {
    throw new FloorArgError(`${label} must be at most ${MAX_DUPLICATE_MIN_LINES}; got ${n}`);
  }
  return n;
}

/**
 * Resolve the effective floor. Precedence: flag > env > default.
 * `flag === undefined` means the flag was not passed; a flag passed without a
 * value arrives as `null`/'' and is an error, not "unset".
 *
 * @param {{flag?: string|null, env?: string|undefined}} [sources]
 * @returns {{minLines: number, source: 'flag'|'env'|'default'}}
 * @throws {FloorArgError}
 */
export function resolveMinLines({ flag, env = process.env[MIN_LINES_ENV] } = {}) {
  if (flag !== undefined) return { minLines: parseMinLines(flag, '--min-lines'), source: 'flag' };
  if (env !== undefined && env !== '') return { minLines: parseMinLines(env, MIN_LINES_ENV), source: 'env' };
  return { minLines: DEFAULT_DUPLICATE_MIN_LINES, source: 'default' };
}

/**
 * Extract `--min-lines <N>` / `--min-lines=<N>` from argv. Returns `undefined`
 * when absent and `null` when present with no value (so `resolveMinLines`
 * rejects it instead of treating it as unset).
 * @param {string[]} argv
 * @returns {string|null|undefined}
 */
export function readMinLinesFlag(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') break; // POSIX terminator: everything after it is positional
    if (argv[i] === '--min-lines') {
      const v = argv[i + 1];
      return v === undefined || v.startsWith('--') ? null : v;
    }
    if (argv[i].startsWith('--min-lines=')) return argv[i].slice('--min-lines='.length);
  }
  return undefined;
}

/**
 * The single reported state of the floor.
 *
 * @param {{minLines: number, source: string}} resolved
 * @param {{stats?: object|null, unsupported?: boolean}} [outcome]
 *   `stats` is `drift_score().duplication_floor` (null/undefined = the count
 *   could not be read); `unsupported` = the store lacks the floor migration.
 */
export function buildFloorState(resolved, { stats = null, unsupported = false } = {}) {
  const base = { minLines: resolved.minLines, source: resolved.source };
  if (resolved.minLines === 0) {
    return { ...base, enabled: false, applied: false, reason: 'disabled', suppressedClusters: 0 };
  }
  if (unsupported) {
    return { ...base, enabled: true, applied: false, reason: 'store-not-migrated', suppressedClusters: null };
  }
  // A count is a non-negative integer NUMBER or it is unavailable: Number('')
  // and Number(false) are 0, and a malformed RPC payload must never read as a
  // measured zero.
  const n = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
  if (!stats || n(stats.suppressed_clusters) === null) {
    return { ...base, enabled: true, applied: true, reason: 'count-unavailable', suppressedClusters: null };
  }
  return {
    ...base, enabled: true, applied: true, reason: null,
    suppressedClusters: n(stats.suppressed_clusters),
    clustersBefore: n(stats.clusters_before),
    clustersAfter: n(stats.clusters_after),
    pairsBefore: n(stats.pairs_before),
    pairsAfter: n(stats.pairs_after),
    rowsSuppressed: n(stats.rows_suppressed),
  };
}

/**
 * Exit code the floor state forces. 2 = infra ("cannot verify"), matching the
 * rest of arch:duplicates; null = no opinion. An unsupported store with an
 * INHERITED default degrades visibly (un-floored list, exit unchanged); an
 * EXPLICIT floor the store cannot honour is a failure — the operator asked for
 * a measurement this store cannot make.
 * @param {ReturnType<typeof buildFloorState>} state
 * @returns {2|null}
 */
export function floorExitCode(state) {
  return state.reason === 'store-not-migrated' && state.source !== 'default' ? 2 : null;
}

/**
 * Human-readable lines for the floor state. Never prints "0" for an unknown.
 * @param {ReturnType<typeof buildFloorState>} state
 * @returns {string[]}
 */
export function renderFloorLines(state) {
  const how = `--min-lines ${state.minLines} (from ${state.source})`;
  if (!state.enabled) return [`  floor: OFF (${how}) — symbols of every size are clustered`];
  if (state.reason === 'store-not-migrated') {
    return [`  floor: NOT APPLIED — ${how}, but this store has not applied the floor migration; `
      + 'showing the UN-FLOORED list (may over-report; if truncated, real clusters can fall off the page — raise --limit). Run the store migration.'];
  }
  if (state.reason === 'count-unavailable') {
    return [`  floor: ${how} applied; suppressed clusters UNKNOWN (count query failed)`];
  }
  return [`  floor: ${how} — suppressed ${state.suppressedClusters} cluster(s) `
    + `(${state.rowsSuppressed} symbol(s) under ${state.minLines} lines)`];
}
