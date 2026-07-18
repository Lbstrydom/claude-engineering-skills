/**
 * @fileoverview Counted-drop correctness for `observed-deps.mjs`, plus the
 * envelope back-compat that lets this feature ship without invalidating every
 * existing `.audit-loop/domain-deps-observed.json`.
 *
 * The drop at `computeObservedDomainDeps`'s untagged check was silent by
 * design — its own docstring said so — while the only stderr line downstream
 * reported what SURVIVED. On one consumer that hid 68% of files. The skip is
 * unchanged here; what is tested is that it is now COUNTED.
 *
 * Plan: docs/plans/observed-graph-coverage-honesty.md §2.1.2 / §2.1.6b
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeObservedDomainDeps, computeObservedDomainDepsWithCoverage,
  ObservedDepsSchema,
} from '../scripts/lib/observed-deps.mjs';
import { assessAttributionCoverage, assertAttributionExhaustive }
  from '../scripts/lib/symbol-index/graph-coverage.mjs';

const RULES = [
  { pattern: 'src/api/**', domain: 'api' },
  { pattern: 'src/ui/**', domain: 'ui' },
];

describe('computeObservedDomainDepsWithCoverage — counted drops', () => {
  it('classifies every drop reason distinctly', () => {
    const edges = [
      { importer: 'src/ui/a.ts', imported: 'src/api/b.ts' },   // attributed
      { importer: 'src/ui/a.ts', imported: 'src/ui/c.ts' },    // sameDomain
      { importer: 'vendor/x.ts', imported: 'src/api/b.ts' },   // untaggedFrom
      { importer: 'src/ui/a.ts', imported: 'vendor/y.ts' },    // untaggedTo
      { importer: 'vendor/x.ts', imported: 'vendor/y.ts' },    // untaggedBoth
      { importer: 42, imported: 'src/api/b.ts' },              // malformed
      null,                                                     // malformed
    ];
    const { deps, buckets } = computeObservedDomainDepsWithCoverage(edges, RULES);
    assert.deepEqual(buckets, {
      malformed: 2, untaggedFrom: 1, untaggedTo: 1,
      untaggedBoth: 1, sameDomain: 1, attributed: 1,
    });
    assert.deepEqual(deps, { ui: ['api'] });
  });

  it('buckets account for EVERY input edge — nothing vanishes', () => {
    // The property that makes the count trustworthy: if a future filter is
    // added without a bucket, this fails rather than silently under-reporting.
    const edges = Array.from({ length: 37 }, (_, i) => (
      i % 3 === 0 ? { importer: 'src/ui/a.ts', imported: 'src/api/b.ts' }
        : i % 3 === 1 ? { importer: 'vendor/x.ts', imported: 'vendor/y.ts' }
          : { importer: 'src/ui/a.ts', imported: 'src/ui/c.ts' }));
    const { buckets } = computeObservedDomainDepsWithCoverage(edges, RULES);
    const cov = assessAttributionCoverage({ buckets });
    assert.deepEqual(assertAttributionExhaustive(cov, edges.length),
      { ok: true, expected: 37, actual: 37 });
  });

  it('samples untagged paths, capped and de-duplicated', () => {
    const edges = Array.from({ length: 30 }, (_, i) => (
      { importer: `vendor/x${i}.ts`, imported: 'vendor/shared.ts' }));
    const { untaggedSamples } = computeObservedDomainDepsWithCoverage(edges, RULES, { sampleCap: 4 });
    assert.equal(untaggedSamples.length, 4);
    assert.equal(new Set(untaggedSamples).size, 4, 'samples must be unique');
  });

  it('sampleCap 0 disables sampling but keeps counting', () => {
    const edges = [{ importer: 'vendor/x.ts', imported: 'vendor/y.ts' }];
    const r = computeObservedDomainDepsWithCoverage(edges, RULES, { sampleCap: 0 });
    assert.deepEqual(r.untaggedSamples, []);
    assert.equal(r.buckets.untaggedBoth, 1);
  });

  it('bad input yields empty buckets rather than throwing', () => {
    for (const bad of [null, undefined, 'nope', 42]) {
      const r = computeObservedDomainDepsWithCoverage(bad, RULES);
      assert.deepEqual(r.deps, {});
      assert.equal(r.buckets.attributed, 0);
    }
  });
});

describe('computeObservedDomainDeps — unchanged public contract', () => {
  it('still returns the bare deps shape its existing callers expect', () => {
    // The wrapper must be behaviour-preserving: `render-mermaid.mjs` and the
    // dashboard reader both consume this shape today.
    const edges = [
      { importer: 'src/ui/a.ts', imported: 'src/api/b.ts' },
      { importer: 'vendor/x.ts', imported: 'vendor/y.ts' },
    ];
    assert.deepEqual(computeObservedDomainDeps(edges, RULES), { ui: ['api'] });
  });

  it('agrees with the coverage variant on the deps it produces', () => {
    const edges = [
      { importer: 'src/api/a.ts', imported: 'src/ui/b.ts' },
      { importer: 'src/ui/b.ts', imported: 'src/api/a.ts' },
    ];
    assert.deepEqual(
      computeObservedDomainDeps(edges, RULES),
      computeObservedDomainDepsWithCoverage(edges, RULES).deps,
      'the two entry points must never disagree');
  });
});

describe('ObservedDepsSchema — envelope back-compat', () => {
  const base = {
    version: 1,
    refreshId: 'r-1',
    domainMapDigest: 'a'.repeat(64),
    generatedAt: '2026-07-18T10:00:00.000Z',
    deps: { ui: ['api'] },
  };

  it('parses a pre-feature envelope with no coverage block', () => {
    // Every envelope written before this feature lacks `coverage`. If this
    // fails, shipping breaks every consumer's existing artifact.
    const parsed = ObservedDepsSchema.parse(base);
    assert.equal(parsed.coverage, undefined);
  });

  it('parses a full coverage block', () => {
    const parsed = ObservedDepsSchema.parse({
      ...base,
      coverage: {
        schemaVersion: 1,
        verdict: { status: 'degraded', reason: 'below_floor' },
        measuredAt: '2026-07-18T10:00:00.000Z',
        refreshId: 'r-1',
        stale: false,
        extraction: {
          outcome: 'ok', eligible: 100, cruised: 50, ratio: 0.5, elapsedMs: 1234,
          edges: { external: 1, selfEdge: 0, escaping: 0, persisted: 9 },
          samples: { uncruised: ['src/x.ts'] },
        },
        attribution: {
          candidates: 10, attributed: 8, attributable: 9, ratio: 0.888,
          edges: { malformed: 0, untaggedFrom: 1, untaggedTo: 0, untaggedBoth: 0, sameDomain: 1, attributed: 8 },
          samples: { untagged: ['vendor/y.ts'] },
        },
      },
    });
    assert.equal(parsed.coverage.verdict.status, 'degraded');
  });

  it('accepts null counts for a failed extraction', () => {
    // null (no measurement) must be representable, or a failed cruise has to
    // be encoded as 0 and becomes indistinguishable from an empty repo.
    const parsed = ObservedDepsSchema.parse({
      ...base,
      coverage: {
        schemaVersion: 1,
        verdict: { status: 'unverified', reason: 'extraction_timeout' },
        measuredAt: '2026-07-18T10:00:00.000Z',
        refreshId: 'r-1',
        stale: false,
        extraction: {
          outcome: 'timedOut', eligible: null, cruised: null, ratio: null,
          elapsedMs: 300000, edges: null, samples: { uncruised: [] },
        },
        attribution: null,
      },
    });
    assert.equal(parsed.coverage.extraction.cruised, null);
  });

  it('rejects a status outside the closed enum', () => {
    assert.throws(() => ObservedDepsSchema.parse({
      ...base,
      coverage: {
        schemaVersion: 1,
        verdict: { status: 'probably-fine', reason: null },
        measuredAt: '2026-07-18T10:00:00.000Z',
        refreshId: 'r-1', stale: false, extraction: null, attribution: null,
      },
    }));
  });
});
