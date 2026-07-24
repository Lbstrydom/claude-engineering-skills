/**
 * @fileoverview Observed domain-dependency artefact — schema + constants
 * + pure compute/merge fns shared by writer (render-mermaid) and reader
 * (collect-reference).
 *
 * Plan: docs/plans/observed-domain-deps.md
 *
 * Two-layer model:
 *   - observed (this file's on-disk envelope): evidence layer from the
 *     symbol_file_imports table, regenerated every arch:render.
 *   - manual (domain-map.json::allowedDeps): intent layer the import
 *     graph cannot see (dynamic imports, intentionally-forbidden edges,
 *     framework wiring).
 *
 * The reader merges both into a provenance-tagged form; archTiers reads
 * the flattened view.
 *
 * Domain: `shared-lib` (Gemini-R2-M2). Lives at `scripts/lib/` not
 * `scripts/lib/dashboard/` so both the writer (`scripts/symbol-index/`,
 * arch-memory domain) and the reader (`scripts/lib/dashboard/`) can
 * import it without crossing into each other's domains.
 *
 * @module scripts/lib/observed-deps
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import { tagDomain, makeFastTagger } from './symbol-index/domain-tagger.mjs';

export const OBSERVED_FILE = '.audit-loop/domain-deps-observed.json';
export const OBSERVED_VERSION = 1;

// Schema is the on-disk envelope contract. Tightened per R1-L3:
// - generatedAt must be ISO-8601 (datetime, not arbitrary string)
// - domainMapDigest fixed to lowercase-hex sha256 (already 64 chars)
/**
 * Coverage block — §2.1.6b of the coverage-honesty plan.
 *
 * OPTIONAL by design. Every envelope written before this feature lacks it, and
 * those must keep parsing; the reader maps an absent block to
 * `unknown`/`not_measured`, never to `verified` (absence is not evidence of
 * cleanliness). `schemaVersion` is present from day one so a future shape
 * change is a version bump rather than a guess at the reader.
 *
 * Counts are `.nullable()` because a failed or timed-out extraction has NO
 * measurement — null, not 0. Zero is a measurement; conflating the two is how
 * a failed cruise reads as an empty repo.
 */
export const CoverageSchema = z.object({
  schemaVersion: z.literal(1),
  verdict: z.object({
    status: z.enum(['verified', 'degraded', 'unverified', 'unknown']),
    // Closed enum, not z.string() — matches graph-verdict.mjs's GRAPH_REASON
    // and the symbol_refresh_coverage table's own CHECK constraint literally
    // (duplicated rather than imported for the same cross-domain reason as
    // the superRefine above: shared-lib cannot depend on arch-memory).
    // Round-3 audit M2: an unconstrained string let an invalid reason cross
    // the application-schema boundary and rely on the DB CHECK constraint as
    // the only backstop, surfacing as a less-informative 'db-error' instead
    // of 'schema-invalid' at the earliest validation point.
    reason: z.enum([
      'extraction_failed', 'extraction_timeout', 'not_measured',
      'stale_measurement', 'empty_universe', 'zero_cruised',
      'zero_attributed', 'budget_exceeded', 'below_floor',
      'below_attribution_floor',
    ]).nullable(),
  }),
  measuredAt: z.iso.datetime(),
  refreshId: z.string().min(1),
  stale: z.boolean(),
  extraction: z.object({
    outcome: z.enum(['ok', 'failed', 'timedOut']),
    eligible: z.number().int().nonnegative().nullable(),
    cruised: z.number().int().nonnegative().nullable(),
    ratio: z.number().min(0).max(1).nullable(),
    elapsedMs: z.number().nonnegative().nullable(),
    edges: z.object({
      external: z.number().int().nonnegative(),
      selfEdge: z.number().int().nonnegative(),
      escaping: z.number().int().nonnegative(),
      persisted: z.number().int().nonnegative(),
    }).nullable(),
    samples: z.object({ uncruised: z.array(z.string()) }),
  }).nullable(),
  attribution: z.object({
    candidates: z.number().int().nonnegative(),
    attributed: z.number().int().nonnegative(),
    attributable: z.number().int().nonnegative(),
    ratio: z.number().min(0).max(1).nullable(),
    edges: z.object({
      malformed: z.number().int().nonnegative(),
      untaggedFrom: z.number().int().nonnegative(),
      untaggedTo: z.number().int().nonnegative(),
      untaggedBoth: z.number().int().nonnegative(),
      sameDomain: z.number().int().nonnegative(),
      attributed: z.number().int().nonnegative(),
    }),
    samples: z.object({ untagged: z.array(z.string()) }),
  }).nullable(),
}).superRefine((val, ctx) => {
  // Cross-field trust-precedence check, mirroring graph-verdict.mjs's
  // rows 1-4 (the config-INDEPENDENT precedence rows only — rows 8-10
  // depend on the per-repo floor/budget config and are deliberately NOT
  // re-validated here, since a legitimate config difference between
  // measurement time and validation time could otherwise reject a real
  // record). Not importing graph-verdict.mjs directly: this module is
  // `shared-lib` domain and graph-verdict.mjs is `arch-memory` domain;
  // domain-map.json's allowedDeps only permits arch-memory -> shared-lib,
  // not the reverse, so the literal checks below are duplicated on purpose
  // rather than crossing that boundary.
  // These four checks are FIRST-MATCH-WINS, mirroring graph-verdict.mjs's own
  // precedence order exactly (extraction failure/timeout is rows 1-2, checked
  // BEFORE staleness at row 4) — not independent ANDed constraints (round-1
  // audit H2). A copied-forward row whose prior measurement never succeeded
  // (extraction.outcome 'failed'/'timedOut') is real and reachable —
  // copyForwardCoverage preserves that verdict rather than downgrading it to
  // stale_measurement — so checking `stale` unconditionally alongside the
  // extraction-outcome checks would demand verdict.status be BOTH 'unknown'
  // AND 'unverified' simultaneously for that exact record, an impossible
  // requirement that would reject a legitimate persisted shape.
  const { verdict, stale, extraction, attribution } = val;
  // Mirrors symbol_refresh_coverage's own CHECK constraint bit-for-bit:
  // (status = 'verified') = (reason IS NULL). 'verified' is the only status
  // that may carry no reason, and it must not carry one — every other
  // status names exactly why.
  if ((verdict.status === 'verified') !== (verdict.reason === null)) {
    ctx.addIssue({ code: 'custom', path: ['verdict', 'reason'], message: `verdict.status==='verified' iff verdict.reason===null (matches the symbol_refresh_coverage table's own CHECK constraint) — got status="${verdict.status}", reason=${JSON.stringify(verdict.reason)}` });
    return;
  }
  // Each branch below checks BOTH status AND the specific reason literal
  // that row names in graph-verdict.mjs (round-4 audit M1/M2) — checking
  // status alone let a mismatched-but-enum-valid reason through, e.g.
  // {extraction.outcome:'failed', status:'unverified', reason:'zero_cruised'}
  // would have passed despite 'zero_cruised' not being what a failed
  // extraction actually produces.
  if (extraction?.outcome === 'failed') {
    if (verdict.status !== 'unverified' || verdict.reason !== 'extraction_failed') {
      ctx.addIssue({ code: 'custom', path: ['verdict'], message: `extraction.outcome==='failed' requires verdict={status:'unverified',reason:'extraction_failed'} (checked before staleness, matching graph-verdict.mjs's precedence), got status="${verdict.status}" reason=${JSON.stringify(verdict.reason)}` });
    }
    return;
  }
  if (extraction?.outcome === 'timedOut') {
    if (verdict.status !== 'unverified' || verdict.reason !== 'extraction_timeout') {
      ctx.addIssue({ code: 'custom', path: ['verdict'], message: `extraction.outcome==='timedOut' requires verdict={status:'unverified',reason:'extraction_timeout'} (checked before staleness, matching graph-verdict.mjs's precedence), got status="${verdict.status}" reason=${JSON.stringify(verdict.reason)}` });
    }
    return;
  }
  if (stale === true) {
    if (verdict.status !== 'unknown' || verdict.reason !== 'stale_measurement') {
      ctx.addIssue({ code: 'custom', path: ['verdict'], message: `stale===true requires verdict={status:'unknown',reason:'stale_measurement'} — a copied-forward row whose prior measurement succeeded can never read verified/degraded/unverified, got status="${verdict.status}" reason=${JSON.stringify(verdict.reason)}` });
    }
    return;
  }
  if (extraction == null) {
    if (verdict.status !== 'unknown' || verdict.reason !== 'not_measured') {
      ctx.addIssue({ code: 'custom', path: ['verdict'], message: `a null extraction (pre-feature envelope) requires verdict={status:'unknown',reason:'not_measured'}, got status="${verdict.status}" reason=${JSON.stringify(verdict.reason)}` });
    }
    return;
  }
  // Rows 5-7 (round-5 audit H3/H5): the vacuity guards are ALSO
  // config-independent — they reference only extraction.eligible/cruised and
  // attribution.attributable/attributed, never `config` — so the earlier
  // "rows 8-10 depend on config, deliberately not re-validated" note was
  // over-broad; only rows 8-10 (budget/floor thresholds) actually need a
  // config value this schema doesn't have access to. Rows 5-7 can and must
  // be checked here too, closing the full config-independent precedence
  // chain (rows 1-7) rather than stopping partway through it.
  if (!extraction.eligible) {
    if (verdict.status !== 'unverified' || verdict.reason !== 'empty_universe') {
      ctx.addIssue({ code: 'custom', path: ['verdict'], message: `extraction.eligible falsy requires verdict={status:'unverified',reason:'empty_universe'}, got status="${verdict.status}" reason=${JSON.stringify(verdict.reason)}` });
    }
    return;
  }
  if (!extraction.cruised) {
    if (verdict.status !== 'unverified' || verdict.reason !== 'zero_cruised') {
      ctx.addIssue({ code: 'custom', path: ['verdict'], message: `extraction.cruised falsy requires verdict={status:'unverified',reason:'zero_cruised'}, got status="${verdict.status}" reason=${JSON.stringify(verdict.reason)}` });
    }
    return;
  }
  if (attribution && attribution.attributable > 0 && attribution.attributed === 0) {
    if (verdict.status !== 'unverified' || verdict.reason !== 'zero_attributed') {
      ctx.addIssue({ code: 'custom', path: ['verdict'], message: `attribution.attributable>0 with attribution.attributed===0 requires verdict={status:'unverified',reason:'zero_attributed'}, got status="${verdict.status}" reason=${JSON.stringify(verdict.reason)}` });
    }
  }
  // Remaining reachable cases (a genuinely non-vacuous extraction/attribution)
  // fall through to graph-verdict.mjs's config-DEPENDENT rows 8-10 (budget/
  // floor/attribution-floor thresholds) — deliberately not re-validated
  // here, since a legitimate per-repo config difference between measurement
  // time and validation time could otherwise reject a real record.
});

export const ObservedDepsSchema = z.object({
  version: z.literal(OBSERVED_VERSION),
  refreshId: z.string().min(1),
  domainMapDigest: z.string().regex(/^[0-9a-f]{64}$/),
  generatedAt: z.iso.datetime(),
  deps: z.record(z.string(), z.array(z.string())),
  coverage: CoverageSchema.optional(),
});

// Gemini-R2-G2: keys that would trigger prototype-pollution via [[Set]]
// when domain-map.json carries `__proto__` / `constructor` / `prototype`
// (e.g. `{"__proto__": [...]}` parsed by JSON.parse becomes an OWN key on
// modern Node). A domain name reaching a PLAIN-OBJECT assignment
// (`result[from] = ...`) as `__proto__` doesn't add a key at all — it
// reassigns the object's prototype via `Object.prototype.__proto__`'s
// accessor. Hoisted above both `computeObservedDomainDepsWithCoverage` (the
// upstream computation, which builds its intermediate result in a `Map` —
// safe — but converts to a plain object at the end) and `mergeDomainDeps`
// (the downstream merge) so both stages of the pipeline apply the identical
// guard, closing the asymmetry where only the merge layer filtered these.
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function computeDomainMapDigest(rules) {
  const canonical = JSON.stringify(
    Array.isArray(rules)
      ? rules.map((r) => ({ pattern: r.pattern, domain: r.domain }))
      : []
  );
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Pure compute — produces the on-disk `deps` shape from a list of file
 * import edges plus domain rules.
 *
 * Excluded:
 *   - self-loops (importer and imported tag to the same domain)
 *   - edges where either endpoint is untagged (no rule matched)
 *
 * @param {Array<{importer: string, imported: string}>} edges
 * @param {Array<{pattern: string, domain: string}>} rules
 * @returns {Object<string, string[]>} `{[fromDomain]: [toDomain, ...sorted, unique]}`
 */
export function computeObservedDomainDeps(edges, rules) {
  return computeObservedDomainDepsWithCoverage(edges, rules).deps;
}

/**
 * Same computation, but ALSO returns why each dropped edge was dropped.
 *
 * `computeObservedDomainDeps` above silently skipped untagged edges — the
 * docstring even declared it intended — and the only stderr line downstream
 * reported what SURVIVED (`N domains, M edges`). On one consumer that made 68%
 * of files invisible with nothing warning. The skip itself is correct and
 * unchanged; what changes is that it is now countable.
 *
 * Buckets are mutually exclusive and exhaustive. `malformed` and `sameDomain`
 * exist because the loop genuinely drops those cases too — omitting them (as
 * the first design did) would break the exhaustivity assertion on live data.
 *
 * @param {Array<{importer: string, imported: string}>} edges
 * @param {Array<{pattern: string, domain: string}>} rules
 * @param {{sampleCap?: number}} [opts]
 * @returns {{deps: Object<string,string[]>, buckets: object, untaggedSamples: string[]}}
 */
export function computeObservedDomainDepsWithCoverage(edges, rules, { sampleCap = 20 } = {}) {
  const buckets = {
    malformed: 0, untaggedFrom: 0, untaggedTo: 0,
    untaggedBoth: 0, sameDomain: 0, attributed: 0,
  };
  const untaggedSamples = [];
  const cap = Number.isFinite(sampleCap) ? Math.max(0, Math.min(100, Math.trunc(sampleCap))) : 20;
  const sample = (p) => {
    if (untaggedSamples.length < cap && !untaggedSamples.includes(p)) untaggedSamples.push(p);
  };

  const out = new Map();
  if (!Array.isArray(edges) || !Array.isArray(rules)) {
    return { deps: {}, buckets, untaggedSamples };
  }
  // Gemini-R3-G1: matchGlob() rebuilds a RegExp per call. With ~2000 edges
  // × 47 rules × 2 endpoints = ~190K compilations per render, that's the
  // hot path. Precompile each rule's regex ONCE outside the edge loop, then
  // do plain re.test() inside. ~50× faster on this repo; scales linearly.
  const fastTag = makeFastTagger(rules);
  for (const e of edges) {
    if (!e || typeof e.importer !== 'string' || typeof e.imported !== 'string') {
      buckets.malformed++;
      continue;
    }
    const fromDomain = fastTag(e.importer);
    const toDomain = fastTag(e.imported);
    if (!fromDomain && !toDomain) {
      buckets.untaggedBoth++; sample(e.importer); sample(e.imported); continue;
    }
    if (!fromDomain) { buckets.untaggedFrom++; sample(e.importer); continue; }
    if (!toDomain) { buckets.untaggedTo++; sample(e.imported); continue; }
    if (fromDomain === toDomain) { buckets.sameDomain++; continue; }
    buckets.attributed++;
    if (!out.has(fromDomain)) out.set(fromDomain, new Set());
    out.get(fromDomain).add(toDomain);
  }
  // R2-L4: sort outer `from` keys too, not just inner targets. The on-disk
  // file is consumed by humans (git diffs, dashboard) — deterministic key
  // order means re-runs over identical input produce identical bytes.
  const sortedFroms = Array.from(out.keys()).sort((a, b) => a.localeCompare(b));
  const result = {};
  for (const from of sortedFroms) {
    // Guard against `from` reassigning result's prototype (see DANGEROUS_KEYS
    // above) — `out` is a Map, safe as an intermediate, but this plain-object
    // assignment is exactly the unsafe [[Set]] the merge layer already guards.
    if (DANGEROUS_KEYS.has(from)) continue;
    result[from] = Array.from(out.get(from)).sort((a, b) => a.localeCompare(b));
  }
  untaggedSamples.sort();
  return { deps: result, buckets, untaggedSamples };
}

/**
 * Merge observed + manual deps into a provenance-tagged form.
 *
 * Manual entries with an empty `[]` array are preserved (the key appears
 * in the output with an empty list) — that's an explicit declaration
 * that the domain is self-contained, not absence of data.
 *
 * @param {Object<string, string[]>} observed
 * @param {Object<string, string[]>} manual
 * @returns {Object<string, Array<{to: string, source: 'observed'|'manual'|'both'}>>}
 */
export function mergeDomainDeps(observed, manual) {
  observed = observed || {};
  manual = manual || {};
  const fromDomains = new Set([
    ...Object.keys(observed),
    ...Object.keys(manual),
  ]);
  const result = {};
  for (const from of fromDomains) {
    if (DANGEROUS_KEYS.has(from)) continue;
    // Gemini-R2-M7: validate inner array values are strings before they
    // reach .localeCompare() / .sort() — a mis-typed allowedDeps with
    // numeric or null entries would otherwise crash the dashboard pipeline.
    const obsList = Array.isArray(observed[from])
      ? observed[from].filter((v) => typeof v === 'string' && v.length > 0)
      : [];
    const manList = Array.isArray(manual[from])
      ? manual[from].filter((v) => typeof v === 'string' && v.length > 0)
      : [];
    const obsSet = new Set(obsList);
    const manSet = new Set(manList);
    const allTos = new Set([...obsSet, ...manSet]);
    const merged = [];
    for (const to of allTos) {
      if (DANGEROUS_KEYS.has(to)) continue;
      const inObs = obsSet.has(to);
      const inMan = manSet.has(to);
      const source = (inObs && inMan) ? 'both' : (inObs ? 'observed' : 'manual');
      merged.push({ to, source });
    }
    merged.sort((a, b) => a.to.localeCompare(b.to));
    result[from] = merged;
  }
  return result;
}

/**
 * Flatten the provenance-tagged merge to the `{from: [to,...]}` shape
 * that `archTiers()` consumes. Provenance labels are dropped here.
 *
 * @param {Object<string, Array<{to: string, source: string}>>} merged
 * @returns {Object<string, string[]>}
 */
export function flattenMergedDeps(merged) {
  const result = {};
  for (const [from, list] of Object.entries(merged || {})) {
    result[from] = (Array.isArray(list) ? list : [])
      .map((e) => e.to)
      .filter((t) => typeof t === 'string')
      .sort((a, b) => a.localeCompare(b));
  }
  return result;
}
