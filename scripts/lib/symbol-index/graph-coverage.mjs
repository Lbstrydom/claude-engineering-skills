/**
 * @fileoverview The observed-graph coverage contract, as pure functions.
 *
 * The observed import graph has always reported what SURVIVED and never what
 * it dropped, across three independent loss sites (the `COMMON_SOURCE_DIRS`
 * allowlist, the edge filters in `extract.mjs`, and the untagged-domain skip in
 * `observed-deps.mjs`). A repo can therefore be missing most of its edges while
 * every surface reads authoritative — measured 2026-07-18: 2% of files
 * invisible here, 1% on one consumer, **68% on another**.
 *
 * This module is the measurement half of the fix. It is deliberately pure (no
 * fs, no db, no clock) so the whole contract is Tier-1 testable — see
 * AGENTS.md "Testing doctrine". The verdict half lives in `graph-verdict.mjs`.
 *
 * Plan: docs/plans/observed-graph-coverage-honesty.md §2.1
 *
 * @module scripts/lib/symbol-index/graph-coverage
 */
import path from 'node:path';

/**
 * Extensions dependency-cruiser can resolve **when the matching transpiler is
 * installed**. Exported so the cruise targets, the coverage denominator, and
 * the spike all derive from ONE list — three private copies is how the layers
 * drifted apart in the first place.
 *
 * **This list is a CANDIDATE set, not a capability claim** (2026-09-04). Half
 * of it is conditional: dep-cruiser parses `.ts`/`.tsx`/`.mts`/`.cts` only when
 * it can resolve `typescript`, `.vue` only with `vue-template-compiler`, and so
 * on — it reports the truth per install via its own `allExtensions` export.
 * Read as a claim, this constant fabricated coverage: a consumer whose entire
 * application is TypeScript, installed under pnpm's strict layout (so
 * `typescript` is not hoisted to a resolvable location), had **522 of 675**
 * eligible files silently unparseable while the graph reported `outcome: 'ok'`
 * and `Layering violations: 0` — measured in a consumer repo 2026-09-04.
 * `assessParserAvailability` is the half that asks instead of asserting.
 */
export const CRUISABLE_EXTENSIONS = Object.freeze([
  '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.tsx', '.mts', '.cts',
  '.vue', '.svelte',
]);

const CRUISABLE_SET = new Set(CRUISABLE_EXTENSIONS);

/**
 * The single place path spelling is decided.
 *
 * Load-bearing: dep-cruiser emits module paths relative to the process CWD, not
 * to the repo being cruised. Run with `cwd !== repoRoot` it produces
 * `../other-repo/src/x.ts` — and `extract.mjs` drops `..`-prefixed edges
 * outright. Production happens to set `cwd === repoRoot`
 * (`refresh.mjs` resolves `repoRoot` from `process.cwd()`), so the two spellings
 * coincide today; relying on that is an implicit contract, and this function is
 * how we stop relying on it.
 *
 * `base` is what a RELATIVE `p` is resolved against, and it is not always
 * `repoRoot` (round-1 audit, be-services MEDIUM). dep-cruiser emits paths
 * relative to the process CWD, so resolving its output against `repoRoot` is
 * only correct when the two coincide — the very assumption this function
 * exists to remove. It happened to produce the right answer for the measured
 * `../<repo>/src/x.ts` spelling because that path walks back INTO the repo,
 * but that is a coincidence of layout, not a property. Callers holding
 * cruiser output pass `{base: process.cwd()}`; `base` defaults to `repoRoot`
 * for callers holding already-repo-relative or absolute paths.
 *
 * @param {string} p - absolute, or relative to `base`
 * @param {string} repoRoot
 * @param {{base?: string}} [opts]
 * @returns {string} repo-relative, forward-slash, lower-cased on Windows
 */
export function normalizeRepoPath(p, repoRoot, { base } = {}) {
  if (typeof p !== 'string' || p.length === 0) return '';
  const abs = path.resolve(base || repoRoot, p);
  let rel = path.relative(repoRoot, abs).split(path.sep).join('/');
  // Windows filesystems are case-insensitive; `normalizePath()` elsewhere in
  // this repo lower-cases for the same reason (see AGENTS.md accepted debt).
  if (process.platform === 'win32') rel = rel.toLowerCase();
  return rel;
}

/**
 * The canonical eligible-source-file universe — the coverage DENOMINATOR.
 *
 * NOT the cruise target list. An earlier design derived targets from this too,
 * which is unified discovery (design (e)) smuggled in under another name: it
 * would change the graph this work only claims to MEASURE. Targets stay
 * `COMMON_SOURCE_DIRS`; this is the yardstick held against them, so the
 * allowlist's blindness surfaces as a number rather than a silent behaviour
 * change.
 *
 * `isTooLarge` supplies §2.1.1's third clause, `size <= MAX_FILE_BYTES`. It is
 * injected rather than statted here so this module stays pure (Tier 1) — the
 * caller already holds `fs` and, in `extract.mjs`'s case, already stats every
 * file. Omitting it entirely was a real contract gap: a file the pipeline
 * refuses to read still counted against the denominator, understating coverage
 * on exactly the repos most likely to have generated monsters.
 *
 * @param {string[]} files - whole-repo inventory (SKIP_DIRS already applied)
 * @param {{repoRoot: string, isTooLarge?: (absPath: string) => boolean}} opts
 * @returns {string[]} sorted, de-duplicated, normalized repo-relative paths
 */
export function eligibleFiles(files, { repoRoot, isTooLarge } = {}) {
  if (!Array.isArray(files) || typeof repoRoot !== 'string') return [];
  const out = new Set();
  for (const f of files) {
    if (typeof f !== 'string' || f.length === 0) continue;
    if (!CRUISABLE_SET.has(path.extname(f).toLowerCase())) continue;
    if (typeof isTooLarge === 'function' && isTooLarge(f)) continue;
    const rel = normalizeRepoPath(f, repoRoot);
    // A path that escapes the repo is not part of this repo's universe.
    if (rel === '' || rel.startsWith('../')) continue;
    out.add(rel);
  }
  return Array.from(out).sort();
}

/**
 * Of the eligible files, how many carry an extension this dep-cruiser install
 * has **no parser for**?
 *
 * The distinction this exists to draw: a file the cruise missed because it sits
 * outside `COMMON_SOURCE_DIRS` is a *targeting* gap you can close by widening
 * the allowlist; a file the cruise cannot read at all is a *capability* gap you
 * close by installing a transpiler. Both used to land in the same `uncruised`
 * number, so the remedy was unguessable — the consumer report that produced
 * this function had to be diagnosed from outside the tool.
 *
 * Pure, like the rest of this module: availability is the CALLER's observation
 * (`allExtensions` from dependency-cruiser), injected rather than probed.
 *
 * `availableExtensions == null` means the caller could not ask. That is
 * reported as `known: false` with `unparseable: null` — the absence of a
 * measurement, never "all extensions are available" (AGENTS.md: unknown is not
 * a synonym for verified).
 *
 * @param {string[]} eligible - repo-relative eligible paths
 * @param {string[]|null|undefined} availableExtensions - dep-cruiser's
 *   `allExtensions` filtered to `available === true`, as `.ext` strings
 * @returns {{known: boolean, unavailableExtensions: string[],
 *            unparseable: number|null, byExtension: Record<string, number>}}
 */
export function assessParserAvailability(eligible, availableExtensions) {
  if (!Array.isArray(availableExtensions)) {
    return { known: false, unavailableExtensions: [], unparseable: null, byExtension: {} };
  }
  const avail = new Set(availableExtensions.map((e) => String(e).toLowerCase()));
  const byExtension = {};
  let unparseable = 0;
  for (const f of Array.isArray(eligible) ? eligible : []) {
    if (typeof f !== 'string') continue;
    const ext = path.extname(f).toLowerCase();
    if (avail.has(ext)) continue;
    unparseable++;
    byExtension[ext] = (byExtension[ext] || 0) + 1;
  }
  return {
    known: true,
    // Only the candidates this pipeline actually admits — an extension
    // dep-cruiser knows about but `eligibleFiles` never yields (`.coffee`,
    // `.csx`) is not a gap in THIS graph and would be noise in the report.
    unavailableExtensions: CRUISABLE_EXTENSIONS.filter((e) => !avail.has(e)),
    unparseable,
    byExtension,
  };
}

/**
 * Extraction-layer coverage: of the eligible source files, how many did the
 * cruise actually see?
 *
 * `outcome` carries the failure states the verdict needs. On `failed`/`timedOut`
 * the counts are **null, not 0** — zero is a measurement, null is the absence
 * of one, and conflating them is exactly how a failed cruise reads as an empty
 * repo (the live bug at `extract.mjs:307`, which returns `{violationCount: 0}`
 * with `importCount` undefined).
 *
 * `cruisedBase` is the directory dep-cruiser's relative `source` values are
 * relative to — its process CWD, not necessarily `repoRoot`.
 *
 * @param {{outcome?: 'ok'|'failed'|'timedOut', eligible?: string[],
 *          cruisedSources?: string[], repoRoot?: string, cruisedBase?: string,
 *          elapsedMs?: number, edges?: object, sampleCap?: number}} input
 */
export function assessExtractionCoverage({
  outcome = 'ok', eligible = [], cruisedSources = [], repoRoot = '',
  cruisedBase = undefined, elapsedMs = null, edges = {}, sampleCap = 20,
  availableExtensions = null,
} = {}) {
  if (outcome !== 'ok') {
    return {
      outcome, eligible: null, cruised: null, ratio: null,
      elapsedMs: elapsedMs ?? null, edges: null, parser: null,
      samples: { uncruised: [] },
    };
  }
  const eligibleSet = new Set(eligible);
  const seen = new Set();
  for (const s of cruisedSources) {
    const rel = normalizeRepoPath(s, repoRoot, { base: cruisedBase });
    // Only modules inside the eligible universe count. dep-cruiser's module
    // list also contains node builtins and npm packages — measured on one
    // consumer, ~20 of 485 "modules" were `crypto`, `fs`, `@babel`, `eslint`.
    // Counting those would inflate the numerator against a source-only
    // denominator and fabricate the ratio.
    if (eligibleSet.has(rel)) seen.add(rel);
  }
  const uncruised = eligible.filter((f) => !seen.has(f));
  return {
    outcome: 'ok',
    eligible: eligible.length,
    cruised: seen.size,
    ratio: eligible.length === 0 ? null : seen.size / eligible.length,
    elapsedMs: elapsedMs ?? null,
    edges: normalizeEdgeBuckets(edges),
    parser: assessParserAvailability(eligible, availableExtensions),
    samples: { uncruised: uncruised.slice(0, clampCap(sampleCap)) },
  };
}

/**
 * The extraction-side edge buckets, named once. `normalizeEdgeBuckets` builds
 * this shape and `assertExtractionExhaustive` sums exactly it — two lists would
 * let a bucket be emitted and never summed, which is the silent-loss-site bug
 * one layer up.
 */
export const EXTRACTION_EDGE_BUCKETS = Object.freeze([
  'external', 'selfEdge', 'escaping', 'unresolved', 'disowned', 'persisted',
]);

/**
 * Extraction-side edge buckets, defaulted so the shape is always complete.
 *
 * Adding a bucket here is half of adding a filter in `extract.mjs` — the other
 * half is `assertExtractionExhaustive` below, which is what stops a new filter
 * from becoming a silent loss site.
 */
function normalizeEdgeBuckets(edges) {
  const e = edges || {};
  const n = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    external: n(e.external),
    selfEdge: n(e.selfEdge),
    escaping: n(e.escaping),
    // An edge dep-cruiser could not resolve. Its `resolved` is the raw
    // specifier (`@workbench/core/persistence`), not a path — persisting one
    // fabricates a file that does not exist and then reports it as an
    // un-attributable endpoint. Measured live in a consumer 2026-09-04: both
    // of that repo's `untaggedTo` attribution samples were bare specifiers.
    unresolved: n(e.unresolved),
    // An edge whose importer or target is gitignored-and-untracked — the
    // consumer does not own it, so it is not that repo's import graph.
    disowned: n(e.disowned),
    persisted: n(e.persisted),
  };
}

function clampCap(cap) {
  if (!Number.isFinite(cap)) return 20;
  return Math.max(0, Math.min(100, Math.trunc(cap)));
}

/**
 * Attribution-layer coverage: of the persisted internal edges, how many landed
 * on a domain-to-domain edge rather than being dropped?
 *
 * Buckets are mutually exclusive and exhaustive. Two of them exist only because
 * the real `computeObservedDomainDeps` drops those cases and the first draft of
 * this contract missed both: `malformed` (a non-string endpoint) and
 * `sameDomain` (an intra-domain edge, correctly excluded from a domain graph
 * but still not an *attribution failure*). Without them the exhaustivity
 * assertion below would fire on live data.
 *
 * @param {{buckets?: object, sampleCap?: number, untaggedSamples?: string[]}} input
 */
export function assessAttributionCoverage({
  buckets = {}, sampleCap = 20, untaggedSamples = [],
} = {}) {
  const b = buckets || {};
  const n = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
  const parts = {
    malformed: n(b.malformed),
    untaggedFrom: n(b.untaggedFrom),
    untaggedTo: n(b.untaggedTo),
    untaggedBoth: n(b.untaggedBoth),
    sameDomain: n(b.sameDomain),
    attributed: n(b.attributed),
  };
  const candidates = Object.values(parts).reduce((a, v) => a + v, 0);
  // The denominator for "did attribution work" excludes edges that were never
  // attributable in principle. A malformed row is a data defect, and an
  // intra-domain edge has no domain-to-domain edge to produce — neither is a
  // domain-map gap, which is what this ratio is meant to detect.
  const attributable = parts.attributed
    + parts.untaggedFrom + parts.untaggedTo + parts.untaggedBoth;
  return {
    candidates,
    attributed: parts.attributed,
    attributable,
    ratio: attributable === 0 ? null : parts.attributed / attributable,
    edges: parts,
    samples: { untagged: (untaggedSamples || []).slice(0, clampCap(sampleCap)) },
  };
}

/**
 * Exhaustivity assertion for the EXTRACTION buckets.
 *
 * `external + selfEdge + escaping + unresolved + disowned + persisted ==
 * cruisedEdges`. Trivially true
 * the day it is written — every dependency in `extract.mjs`'s loop lands in
 * exactly one bucket by construction. It exists for the day after: a fourth
 * filter added without a fourth bucket is a new silent loss site, which is the
 * entire bug class this module exists to end. Enforced in code rather than
 * described in prose for the same reason.
 *
 * @param {{edges?: object|null}} extraction - an `assessExtractionCoverage` result
 * @param {number} cruisedEdges - total dependency edges the cruise offered
 * @returns {{ok: boolean, expected: number, actual: number}}
 */
export function assertExtractionExhaustive(extraction, cruisedEdges) {
  const e = extraction?.edges;
  const expected = Number.isFinite(cruisedEdges) ? cruisedEdges : 0;
  // A failed/timedOut extraction has null counts by design — there is no
  // measurement to hold to account, so it cannot fail the assertion.
  if (!e) return { ok: true, expected, actual: expected };
  // `?? 0` per bucket, not a bare sum: this function is also handed edge
  // objects read back from envelopes written before a bucket existed, and
  // `undefined` in a sum poisons the whole thing to NaN — which compares
  // unequal to everything and would report a MISSING BUCKET as a failed
  // exhaustivity check, i.e. the loudest possible false alarm. Absent counts
  // as 0, which still under-sums and still fails when a real filter has no
  // bucket — the property this assertion exists for is preserved.
  const actual = EXTRACTION_EDGE_BUCKETS.reduce((sum, k) => sum + (e[k] ?? 0), 0);
  return { ok: actual === expected, expected, actual };
}

/**
 * Exhaustivity assertion for the attribution buckets — enforced in code rather
 * than described in prose, because a silently-unaccounted-for drop is precisely
 * the class of bug this module exists to end.
 *
 * @returns {{ok: boolean, expected: number, actual: number}}
 */
export function assertAttributionExhaustive(coverage, persistedEdges) {
  const actual = coverage?.candidates ?? 0;
  const expected = Number.isFinite(persistedEdges) ? persistedEdges : 0;
  return { ok: actual === expected, expected, actual };
}
