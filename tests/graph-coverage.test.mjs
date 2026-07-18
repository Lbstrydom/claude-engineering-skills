/**
 * @fileoverview Tier-1 tests for the observed-graph coverage contract.
 *
 * The highest-value assertions in this file are the VACUITY GUARDS: a cruise
 * that measured nothing, or a graph where every edge was dropped, must never
 * read `verified`. That is the failure this whole feature exists to end — a
 * surface reporting green without having checked anything (AGENTS.md, "audit
 * your success paths"). Everything else here is precedence-table bookkeeping.
 *
 * Plan: docs/plans/observed-graph-coverage-honesty.md §2.1
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  CRUISABLE_EXTENSIONS, normalizeRepoPath, eligibleFiles,
  assessExtractionCoverage, assessAttributionCoverage, assertAttributionExhaustive,
} from '../scripts/lib/symbol-index/graph-coverage.mjs';
import {
  graphVerdict, parseCoverageConfig, coverageGateExitCode,
  GRAPH_STATUS, GRAPH_REASON, COVERAGE_DEFAULTS,
} from '../scripts/lib/symbol-index/graph-verdict.mjs';

const ROOT = process.platform === 'win32' ? 'C:/repo' : '/repo';
const rel = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** Minimal healthy extraction, so each test varies exactly one thing. */
const okExtraction = (over = {}) => ({
  outcome: 'ok', eligible: 100, cruised: 100, ratio: 1, elapsedMs: 1000,
  edges: { external: 0, selfEdge: 0, escaping: 0, persisted: 10 },
  samples: { uncruised: [] }, ...over,
});

describe('normalizeRepoPath', () => {
  it('makes an absolute path repo-relative with forward slashes', () => {
    assert.equal(normalizeRepoPath(path.join(ROOT, 'src', 'a.ts'), ROOT), rel('src/a.ts'));
  });

  it('collapses the cwd-relative spelling dep-cruiser emits when cwd != repoRoot', () => {
    // The real artifact: run from a sibling dir, dep-cruiser emits
    // `../repo/src/a.ts`. Both spellings must land on one identity, or the
    // coverage numerator silently misses every file.
    assert.equal(normalizeRepoPath('../repo/src/a.ts', ROOT), rel('src/a.ts'));
  });

  it('returns empty for junk rather than throwing', () => {
    for (const v of [null, undefined, '', 42, {}]) {
      assert.equal(normalizeRepoPath(v, ROOT), '');
    }
  });
});

describe('eligibleFiles', () => {
  it('keeps only cruisable extensions', () => {
    const files = ['src/a.ts', 'src/b.js', 'docs/c.md', 'db/d.sql', 'x.json']
      .map((f) => path.join(ROOT, f));
    assert.deepEqual(eligibleFiles(files, { repoRoot: ROOT }),
      [rel('src/a.ts'), rel('src/b.js')].sort());
  });

  it('covers every declared extension — the list is the contract', () => {
    const files = CRUISABLE_EXTENSIONS.map((e, i) => path.join(ROOT, `f${i}${e}`));
    assert.equal(eligibleFiles(files, { repoRoot: ROOT }).length, CRUISABLE_EXTENSIONS.length);
  });

  it('de-duplicates paths that differ only in spelling', () => {
    const files = [path.join(ROOT, 'src/a.ts'), '../repo/src/a.ts'];
    assert.deepEqual(eligibleFiles(files, { repoRoot: ROOT }), [rel('src/a.ts')]);
  });

  it('drops paths that escape the repo', () => {
    assert.deepEqual(eligibleFiles(['../other/x.ts'], { repoRoot: ROOT }), []);
  });

  it('returns [] on bad input instead of throwing', () => {
    assert.deepEqual(eligibleFiles(null, { repoRoot: ROOT }), []);
    assert.deepEqual(eligibleFiles(['a.ts'], {}), []);
  });
});

describe('assessExtractionCoverage', () => {
  it('counts only modules inside the eligible universe', () => {
    // dep-cruiser's module list also carries node builtins and npm packages —
    // measured on a real consumer, ~20 of 485. Counting them would inflate the
    // numerator against a source-only denominator and fabricate the ratio.
    const r = assessExtractionCoverage({
      eligible: [rel('src/a.ts'), rel('src/b.ts')],
      cruisedSources: [path.join(ROOT, 'src/a.ts'), 'crypto', 'fs', '@babel/core'],
      repoRoot: ROOT,
    });
    assert.equal(r.eligible, 2);
    assert.equal(r.cruised, 1);
    assert.equal(r.ratio, 0.5);
  });

  it('reports NULL counts — not 0 — when extraction did not happen', () => {
    // Zero is a measurement; null is the absence of one. Conflating them is
    // exactly how a failed cruise reads as an empty repo.
    for (const outcome of ['failed', 'timedOut']) {
      const r = assessExtractionCoverage({ outcome, eligible: ['src/a.ts'] });
      assert.equal(r.outcome, outcome);
      assert.equal(r.cruised, null);
      assert.equal(r.eligible, null);
      assert.equal(r.ratio, null);
    }
  });

  it('caps uncruised samples and keeps them deterministic', () => {
    const eligible = Array.from({ length: 50 }, (_, i) => `src/f${String(i).padStart(2, '0')}.ts`);
    const a = assessExtractionCoverage({ eligible, cruisedSources: [], repoRoot: ROOT, sampleCap: 5 });
    const b = assessExtractionCoverage({ eligible, cruisedSources: [], repoRoot: ROOT, sampleCap: 5 });
    assert.equal(a.samples.uncruised.length, 5);
    assert.deepEqual(a.samples.uncruised, b.samples.uncruised, 'sampling must be reproducible');
  });

  it('clamps an absurd sampleCap rather than honouring it', () => {
    const eligible = Array.from({ length: 500 }, (_, i) => `src/f${i}.ts`);
    const r = assessExtractionCoverage({ eligible, cruisedSources: [], repoRoot: ROOT, sampleCap: 9999 });
    assert.ok(r.samples.uncruised.length <= 100);
  });
});

describe('assessAttributionCoverage', () => {
  it('excludes never-attributable edges from the denominator', () => {
    // malformed rows are a data defect and sameDomain edges have no
    // domain-to-domain edge to produce — neither is a domain-map gap, which is
    // what this ratio is meant to detect.
    const r = assessAttributionCoverage({
      buckets: { attributed: 8, untaggedFrom: 2, sameDomain: 40, malformed: 5 },
    });
    assert.equal(r.candidates, 55);
    assert.equal(r.attributable, 10);
    assert.equal(r.ratio, 0.8);
  });

  it('ratio is null (not 0) when nothing was attributable', () => {
    const r = assessAttributionCoverage({ buckets: { sameDomain: 12 } });
    assert.equal(r.ratio, null);
  });

  it('buckets are exhaustive against the persisted edge count', () => {
    const r = assessAttributionCoverage({
      buckets: { attributed: 3, untaggedTo: 1, sameDomain: 2, malformed: 1 },
    });
    assert.deepEqual(assertAttributionExhaustive(r, 7), { ok: true, expected: 7, actual: 7 });
    assert.equal(assertAttributionExhaustive(r, 9).ok, false, 'a miscount must be detectable');
  });
});

describe('graphVerdict — precedence table (§2.1.3)', () => {
  const cases = [
    ['extraction failed',   { extraction: okExtraction({ outcome: 'failed' }) },  'unverified', 'extraction_failed'],
    ['extraction timeout',  { extraction: okExtraction({ outcome: 'timedOut' }) }, 'unverified', 'extraction_timeout'],
    ['no coverage block',   { extraction: null },                                  'unknown',    'not_measured'],
    ['copied forward',      { extraction: okExtraction(), stale: true },           'unknown',    'stale_measurement'],
    ['empty universe',      { extraction: okExtraction({ eligible: 0, cruised: 0, ratio: null }) }, 'unverified', 'empty_universe'],
    ['zero cruised',        { extraction: okExtraction({ cruised: 0, ratio: 0 }) }, 'unverified', 'zero_cruised'],
    ['zero attributed',     { extraction: okExtraction(), attribution: { attributable: 10, attributed: 0, ratio: 0 } }, 'unverified', 'zero_attributed'],
    ['over budget',         { extraction: okExtraction({ elapsedMs: 999_999 }) },  'degraded',   'budget_exceeded'],
    ['below floor',         { extraction: okExtraction({ cruised: 10, ratio: 0.1 }) }, 'degraded', 'below_floor'],
    ['below attr floor',    { extraction: okExtraction(), attribution: { attributable: 10, attributed: 1, ratio: 0.1 } }, 'degraded', 'below_attribution_floor'],
    ['healthy',             { extraction: okExtraction(), attribution: { attributable: 10, attributed: 10, ratio: 1 } }, 'verified', null],
  ];
  for (const [name, input, status, reason] of cases) {
    it(`${name} → ${status}${reason ? ` / ${reason}` : ''}`, () => {
      assert.deepEqual(graphVerdict({ ...input, config: COVERAGE_DEFAULTS }), { status, reason });
    });
  }

  it('precedence holds: a failure is never masked by a healthy-looking ratio', () => {
    // Every degradation condition true at once, plus a hard failure. The
    // failure must win, or a broken run could report merely "degraded".
    const v = graphVerdict({
      extraction: okExtraction({ outcome: 'failed', ratio: 0.01, elapsedMs: 999_999 }),
      attribution: { attributable: 10, attributed: 0, ratio: 0 },
      stale: true,
      config: COVERAGE_DEFAULTS,
    });
    assert.deepEqual(v, { status: 'unverified', reason: 'extraction_failed' });
  });

  it('VACUITY GUARD: a zero-coverage graph can never be constructed as verified', () => {
    // The single most important assertion here. If any input combination with
    // no real measurement yields `verified`, the feature is decorative.
    const vacuous = [
      { extraction: null },
      { extraction: okExtraction({ outcome: 'failed' }) },
      { extraction: okExtraction({ outcome: 'timedOut' }) },
      { extraction: okExtraction({ eligible: 0, cruised: 0, ratio: null }) },
      { extraction: okExtraction({ cruised: 0, ratio: 0 }) },
      { extraction: okExtraction(), stale: true },
      { extraction: okExtraction(), attribution: { attributable: 5, attributed: 0, ratio: 0 } },
    ];
    for (const input of vacuous) {
      const v = graphVerdict({ ...input, config: COVERAGE_DEFAULTS });
      assert.notEqual(v.status, GRAPH_STATUS.VERIFIED,
        `vacuous input read as verified: ${JSON.stringify(input)}`);
      assert.ok(v.reason, 'a non-verified verdict must always name its reason');
    }
  });

  it('unknown is not treated as verified by the gate', () => {
    const cfg = { ...COVERAGE_DEFAULTS, enforce: true };
    // `unknown` means "we did not measure" — it must not BLOCK (there is no
    // evidence of a problem) but must not read clean either. The distinction
    // lives in the status, which the dashboard renders differently.
    assert.equal(coverageGateExitCode({ status: GRAPH_STATUS.UNKNOWN }, cfg), 0);
    assert.equal(coverageGateExitCode({ status: GRAPH_STATUS.DEGRADED }, cfg), 2);
    assert.equal(coverageGateExitCode({ status: GRAPH_STATUS.UNVERIFIED }, cfg), 2);
    assert.equal(coverageGateExitCode({ status: GRAPH_STATUS.VERIFIED }, cfg), 0);
  });

  it('report-only mode never blocks, whatever the verdict', () => {
    for (const status of Object.values(GRAPH_STATUS)) {
      assert.equal(coverageGateExitCode({ status }, COVERAGE_DEFAULTS), 0);
    }
  });

  it('every reason the table can emit is in the closed enum', () => {
    const emitted = new Set(cases.map(([, , , reason]) => reason).filter(Boolean));
    for (const r of emitted) {
      assert.ok(Object.values(GRAPH_REASON).includes(r), `reason not in enum: ${r}`);
    }
  });
});

describe('parseCoverageConfig', () => {
  it('returns defaults for absent or non-object input', () => {
    assert.deepEqual(parseCoverageConfig(undefined), COVERAGE_DEFAULTS);
    assert.deepEqual(parseCoverageConfig([]), COVERAGE_DEFAULTS);
    assert.deepEqual(parseCoverageConfig('nope'), COVERAGE_DEFAULTS);
  });

  it('falls back per-key on invalid values and never throws', () => {
    const warnings = [];
    const cfg = parseCoverageConfig(
      { floor: 5, maxCruiseMs: -1, enforce: 'yes', sampleCap: 999 },
      (m) => warnings.push(m));
    assert.equal(cfg.floor, COVERAGE_DEFAULTS.floor);
    assert.equal(cfg.maxCruiseMs, COVERAGE_DEFAULTS.maxCruiseMs);
    assert.equal(cfg.enforce, false);
    assert.equal(cfg.sampleCap, COVERAGE_DEFAULTS.sampleCap);
    assert.equal(warnings.length, 4, 'each invalid key warns exactly once');
  });

  it('accepts valid overrides', () => {
    const cfg = parseCoverageConfig({ floor: 0.5, enforce: true, maxCruiseMs: 5000 });
    assert.equal(cfg.floor, 0.5);
    assert.equal(cfg.enforce, true);
    assert.equal(cfg.maxCruiseMs, 5000);
  });

  it('repairs a hard timeout that would starve the soft budget', () => {
    // hardTimeoutMs <= maxCruiseMs means the run is always killed before the
    // soft budget can report — a config that silently disables a feature.
    const warnings = [];
    const cfg = parseCoverageConfig({ maxCruiseMs: 10_000, hardTimeoutMs: 5_000 },
      (m) => warnings.push(m));
    assert.ok(cfg.hardTimeoutMs > cfg.maxCruiseMs);
    assert.ok(warnings.some((w) => w.includes('hardTimeoutMs')));
  });

  it('warns about unknown keys instead of failing (consumer forward-compat)', () => {
    const warnings = [];
    const cfg = parseCoverageConfig({ futureKey: 1 }, (m) => warnings.push(m));
    assert.deepEqual(cfg, COVERAGE_DEFAULTS);
    assert.ok(warnings.some((w) => w.includes('futureKey')));
  });
});
