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
  assertExtractionExhaustive,
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

  it('rejects a hardTimeoutMs/maxCruiseMs above Node\'s max timer delay instead of silently clamping (arch-audit-pipeline-observability-hardening item 7)', () => {
    const warnings = [];
    const cfg = parseCoverageConfig(
      { hardTimeoutMs: 3_000_000_000, maxCruiseMs: 3_000_000_000 },
      (m) => warnings.push(m));
    assert.equal(cfg.hardTimeoutMs, COVERAGE_DEFAULTS.hardTimeoutMs, 'falls back to default, not the unhonourable value');
    assert.equal(cfg.maxCruiseMs, COVERAGE_DEFAULTS.maxCruiseMs);
    assert.ok(warnings.some((w) => w.includes('hardTimeoutMs') && w.includes('max timer delay')));
    assert.ok(warnings.some((w) => w.includes('maxCruiseMs') && w.includes('max timer delay')));
  });

  it('a maxCruiseMs comfortably under the ceiling still gets a valid, larger hardTimeoutMs from the repair', () => {
    const cfg = parseCoverageConfig({ maxCruiseMs: 1_000_000_000, hardTimeoutMs: 1_000_000_000 });
    assert.equal(cfg.maxCruiseMs, 1_000_000_000);
    assert.ok(cfg.hardTimeoutMs > cfg.maxCruiseMs);
    assert.ok(cfg.hardTimeoutMs <= 2_147_483_647, 'the repaired value must itself never exceed the timer ceiling');
  });

  it('a maxCruiseMs whose doubled repair would exceed the ceiling is clamped to it, not left unhonourable (round-1 audit H1/M6)', () => {
    // 1.5B * 2 = 3B, which exceeds MAX_TIMER_DELAY_MS (2_147_483_647) — the
    // repair step's own arithmetic can overflow the ceiling positiveInt()
    // already enforced on the raw input; it must clamp, not reintroduce it.
    const warnings = [];
    const cfg = parseCoverageConfig({ maxCruiseMs: 1_500_000_000, hardTimeoutMs: 1_000_000_000 }, (m) => warnings.push(m));
    assert.equal(cfg.maxCruiseMs, 1_500_000_000);
    assert.equal(cfg.hardTimeoutMs, 2_147_483_647, 'clamped to the ceiling, not 3,000,000,000');
    assert.ok(warnings.some((w) => w.includes('hardTimeoutMs')));
  });

  it('a maxCruiseMs already AT the ceiling leaves no valid hardTimeoutMs — falls back to defaults for both rather than publish a contradictory config', () => {
    const warnings = [];
    const cfg = parseCoverageConfig({ maxCruiseMs: 2_147_483_647, hardTimeoutMs: 2_147_483_647 }, (m) => warnings.push(m));
    assert.equal(cfg.maxCruiseMs, COVERAGE_DEFAULTS.maxCruiseMs);
    assert.equal(cfg.hardTimeoutMs, COVERAGE_DEFAULTS.hardTimeoutMs);
    assert.ok(warnings.some((w) => w.includes('leaves no valid hardTimeoutMs')));
  });
});

describe('assertExtractionExhaustive (Phase 2 — the drop-site guard)', () => {
  const cov = (edges) => ({ edges });

  it('passes when every cruised edge landed in exactly one bucket', () => {
    const r = assertExtractionExhaustive(
      cov({ external: 20, selfEdge: 0, escaping: 3, persisted: 1672 }), 1695);
    assert.deepEqual(r, { ok: true, expected: 1695, actual: 1695 });
  });

  it('FAILS when a filter drops edges without a bucket — the regression this guards', () => {
    // The scenario: someone adds a fourth `continue` to extract.mjs's edge loop
    // and forgets the counter. The edges vanish, every ratio still looks fine,
    // and the graph is silently lossy again. That is the original bug, reborn.
    const r = assertExtractionExhaustive(
      cov({ external: 20, selfEdge: 0, escaping: 3, persisted: 1600 }), 1695);
    assert.equal(r.ok, false);
    assert.equal(r.actual, 1623);
    assert.equal(r.expected, 1695);
  });

  it('does not fault a failed extraction, which has no counts to account for', () => {
    const failed = assessExtractionCoverage({ outcome: 'failed' });
    assert.equal(failed.edges, null);
    assert.equal(assertExtractionExhaustive(failed, 0).ok, true);
  });

  it('treats a non-finite cruised total as zero rather than throwing', () => {
    const r = assertExtractionExhaustive(
      cov({ external: 0, selfEdge: 0, escaping: 0, persisted: 0 }), undefined);
    assert.deepEqual(r, { ok: true, expected: 0, actual: 0 });
  });
});

describe('normalizeRepoPath — base is not always repoRoot (r1 audit, be-services)', () => {
  it('resolves a cruiser-relative path against the CWD it was emitted from', () => {
    // dep-cruiser emits `source` relative to ITS process CWD. Run from a
    // sibling directory it emits `../repo/src/a.ts`; run from a PARENT it
    // emits `repo/src/a.ts` — and that second spelling resolved against
    // repoRoot yields `repo/src/a.ts` (a path inside the repo that does not
    // exist), silently missing every file from the numerator.
    const parent = process.platform === 'win32' ? 'C:/' : '/';
    assert.equal(normalizeRepoPath('repo/src/a.ts', ROOT, { base: parent }), rel('src/a.ts'));
    // Resolved against repoRoot instead, the same input lands somewhere else
    // entirely — this is the bug the `base` parameter removes.
    assert.notEqual(normalizeRepoPath('repo/src/a.ts', ROOT), rel('src/a.ts'));
  });

  it('defaults base to repoRoot, so repo-relative callers are unchanged', () => {
    assert.equal(normalizeRepoPath('src/a.ts', ROOT), rel('src/a.ts'));
  });

  it('ignores base for absolute paths', () => {
    const other = process.platform === 'win32' ? 'C:/elsewhere' : '/elsewhere';
    assert.equal(normalizeRepoPath(path.join(ROOT, 'src/a.ts'), ROOT, { base: other }),
      rel('src/a.ts'));
  });

  it('threads through assessExtractionCoverage as cruisedBase', () => {
    const parent = process.platform === 'win32' ? 'C:/' : '/';
    const r = assessExtractionCoverage({
      eligible: [rel('src/a.ts')],
      cruisedSources: ['repo/src/a.ts'],
      repoRoot: ROOT,
      cruisedBase: parent,
    });
    assert.equal(r.cruised, 1, 'a correctly-based cruiser path must count');
  });
});

describe('eligibleFiles — the size clause (§2.1.1, contract gap)', () => {
  it('excludes files the pipeline refuses to read', () => {
    // MAX_FILE_BYTES is OUR cap, not dep-cruiser's. A file we never read
    // cannot be "uncruised coverage" — counting it understates coverage on
    // exactly the repos carrying generated/bundled monsters.
    const files = ['src/small.ts', 'src/huge.ts'].map((f) => path.join(ROOT, f));
    const r = eligibleFiles(files, {
      repoRoot: ROOT,
      isTooLarge: (f) => f.includes('huge'),
    });
    assert.deepEqual(r, [rel('src/small.ts')]);
  });

  it('is optional — omitting it keeps the prior behaviour', () => {
    const files = [path.join(ROOT, 'src/a.ts')];
    assert.deepEqual(eligibleFiles(files, { repoRoot: ROOT }), [rel('src/a.ts')]);
  });
});
