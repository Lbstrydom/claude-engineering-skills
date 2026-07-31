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
// `CoverageSchema` moved to ./coverage-schema.mjs (shared-lib) on 2026-07-31: it is a
// contract shared with `stores`, and keeping it here made that an undeclared
// stores -> arch-memory edge. Imported (not re-exported) — see the plan, L1.
import { CoverageSchema } from './coverage-schema.mjs';

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
