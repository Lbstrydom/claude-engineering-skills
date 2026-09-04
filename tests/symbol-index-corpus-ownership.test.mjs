/**
 * @fileoverview The symbol index must measure the REPO, not whatever happens to
 * sit on disk beneath it.
 *
 * Reported by a consumer 2026-09-04 and reproduced against that repo before any
 * code changed:
 *
 *   - **76.8% of the walked corpus (3,963 of 5,158 files) was
 *     gitignored-and-untracked.** The largest single contributor was
 *     `scripts/.claude-skills/` — 553 files of this very bundle — indexed as
 *     the consumer's own code and then counted against them by the duplication
 *     score. Of the 14 duplicate clusters left after they had cleaned up every
 *     one of their own, all 14 were inside the bundle, so GREEN
 *     (`score <= threshold * 0.5`) was unreachable no matter what they did.
 *   - **522 of 675 eligible files had no parser available**, because
 *     dependency-cruiser resolves `.ts` only when it can resolve `typescript`,
 *     and pnpm's strict layout does not hoist it. The graph still reported
 *     `outcome: 'ok'`, and `arch:drift` still printed `Layering violations: 0`
 *     — a sentence that reads as "no violations" and means "nothing measured".
 *
 * Both are the same failure: a measurement that succeeds having measured the
 * wrong thing, or nothing. The tests below pin the two mechanisms that stop it
 * and — deliberately — the directions in which each must NOT fire.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  enumerateFiles,
  enumerateFilesWithOwnership,
  coverageUniverse,
} from '../scripts/symbol-index/extract.mjs';
import {
  assessParserAvailability,
  assessExtractionCoverage,
  assertExtractionExhaustive,
  EXTRACTION_EDGE_BUCKETS,
  CRUISABLE_EXTENSIONS,
} from '../scripts/lib/symbol-index/graph-coverage.mjs';
import { CoverageSchema } from '../scripts/lib/coverage-schema.mjs';

const EXTRACT = path.resolve(import.meta.dirname, '..', 'scripts', 'symbol-index', 'extract.mjs');

let repo;
const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
const write = (rel, body) => {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};
const rel = (abs) => path.relative(repo, abs).split(path.sep).join('/');

before(() => {
  // `os.tmpdir()`, matching tests/disowned-paths.test.mjs — not the repo, which
  // would make the fixture's own .gitignore part of THIS repo's git state.
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'symidx-corpus-')));
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);

  write('.gitignore', 'vendored/\nscripts/.claude-skills/\n');
  // Owned source, with a real internal import between two files.
  write('src/owned.mjs', "import { helper } from './helper.mjs';\nexport function owned() { return helper(); }\n");
  write('src/helper.mjs', 'export function helper() { return 1; }\n');
  // A gitignored, vendored tree that looks exactly like source and imports
  // within itself — the shape that produced 1,508 intra-bundle edges. It lives
  // under `scripts/` on purpose: `scripts` is one of extract.mjs's cruise
  // targets, so this is the tree whose edges the graph would otherwise persist.
  // (Placed outside a target dir it proves nothing about edges, because the
  // cruise never reaches it — an earlier draft of this test made exactly that
  // mistake and passed vacuously.)
  write('scripts/.claude-skills/tool.mjs', "import { dep } from './dep.mjs';\nexport function vendoredOnly() { return dep(); }\n");
  write('scripts/.claude-skills/dep.mjs', 'export function dep() { return 2; }\n');
  // Owned code in the same target dir — the graph must keep these.
  write('scripts/owned-script.mjs', "import { helper } from '../src/helper.mjs';\nexport function script() { return helper(); }\n");
  write('vendored/blob.mjs', 'export function vendoredOnly() { return 4; }\n');
  // Ignored by pattern but TRACKED anyway: the repo owns it, and the filter
  // must not take it. This is the direction a check-ignore-only predicate
  // gets wrong.
  write('vendored/kept.mjs', 'export function deliberatelyTracked() { return 3; }\n');

  git(['add', '.gitignore', 'src/owned.mjs', 'src/helper.mjs', 'scripts/owned-script.mjs']);
  git(['add', '-f', 'vendored/kept.mjs']);
  git(['commit', '-q', '-m', 'initial']);
});

after(() => {
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('enumerateFilesWithOwnership — the corpus is the repo, not the disk', () => {
  it('excludes gitignored-and-untracked files from the walk', () => {
    const r = enumerateFilesWithOwnership(repo, null);
    const kept = r.files.map(rel);
    assert.equal(r.degraded, false);
    assert.ok(kept.includes('src/owned.mjs'), 'owned source must survive');
    assert.ok(!kept.includes('vendored/blob.mjs'), 'a gitignored, untracked file must be dropped');
    assert.ok(r.disowned.has('vendored/blob.mjs'));
    assert.ok(r.disowned.has('scripts/.claude-skills/tool.mjs'),
      'the bundle itself is not the consumer-owned corpus');
    assert.equal(r.walked, kept.length + r.disowned.size);
  });

  it('KEEPS a tracked file that matches an ignore pattern — ignored is not the predicate', () => {
    // The direction the guard must NOT fire in. A repo that deliberately tracks
    // something under one of its own ignore patterns still owns it, and
    // dropping it would silently shrink the index with no error anywhere.
    const kept = enumerateFilesWithOwnership(repo, null).files.map(rel);
    assert.ok(kept.includes('vendored/kept.mjs'));
  });

  it('fails OPEN and says so when git cannot answer', () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'symidx-nogit-'));
    try {
      fs.writeFileSync(path.join(notARepo, 'a.mjs'), 'export const a = 1;\n');
      const r = enumerateFilesWithOwnership(notARepo, null);
      assert.equal(r.degraded, true, 'a non-work-tree must be reported as unverified');
      assert.equal(r.disowned, null, 'null = nothing was classified, not "nothing is disowned"');
      assert.equal(r.files.length, 1, 'fail-open: the un-filtered walk is still returned');
      assert.match(r.warning, /ownership was NOT verified/);
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('passes a restricted run through without asking git', () => {
    let asked = 0;
    const spy = (...a) => { asked++; return { paths: new Set(), degraded: false, warning: null }; };
    const r = enumerateFilesWithOwnership(repo, ['src/owned.mjs'], spy);
    assert.equal(asked, 0, 'an explicit --files list is already scoped by its caller');
    assert.equal(r.disowned, null);
    assert.equal(r.files.length, 1);
  });

  it('enumerateFiles remains the RAW walker — ownership is the wrapper', () => {
    // The split is deliberate: `observed-graph-discovery-spike.mjs` exists to
    // measure what the walker sees before any policy is applied, so silently
    // filtering here would change the thing the spike measures.
    const raw = enumerateFiles(repo, null).map(rel);
    assert.ok(raw.includes('vendored/blob.mjs'), 'the raw walker sees everything under SKIP_DIRS');
    const owned = enumerateFilesWithOwnership(repo, null).files.map(rel);
    assert.ok(!owned.includes('vendored/blob.mjs'));
    assert.ok(raw.length > owned.length);
  });

  it('coverageUniverse reuses the full-run walk and re-walks otherwise', () => {
    const walk = { files: ['a'], disowned: new Set(), degraded: false, walked: 1, warning: null };
    const fresh = { files: ['b'], disowned: null, degraded: false, walked: 1, warning: null };
    assert.equal(coverageUniverse(repo, null, walk, () => fresh), walk);
    assert.equal(coverageUniverse(repo, [], walk, () => fresh), fresh);
  });
});

describe('assessParserAvailability — ask dep-cruiser, never assume', () => {
  it('reports known:false with a NULL count when availability cannot be observed', () => {
    const r = assessParserAvailability(['a.ts'], null);
    assert.equal(r.known, false);
    assert.equal(r.unparseable, null, 'null is the absence of a measurement, not zero');
    assert.deepEqual(r.unavailableExtensions, []);
  });

  it('counts eligible files whose extension has no parser, broken down by extension', () => {
    const r = assessParserAvailability(
      ['a.mjs', 'b.ts', 'c.ts', 'd.tsx', 'e.js'],
      ['.js', '.mjs', '.cjs', '.jsx'],
    );
    assert.equal(r.known, true);
    assert.equal(r.unparseable, 3);
    assert.deepEqual(r.byExtension, { '.ts': 2, '.tsx': 1 });
    assert.ok(r.unavailableExtensions.includes('.ts'));
    assert.ok(!r.unavailableExtensions.includes('.mjs'));
  });

  it('names only extensions this pipeline actually admits', () => {
    // dep-cruiser knows about .coffee; `eligibleFiles` never yields one, so
    // listing it as a gap would be noise the reader cannot act on.
    const r = assessParserAvailability([], ['.js']);
    for (const ext of r.unavailableExtensions) {
      assert.ok(CRUISABLE_EXTENSIONS.includes(ext), `${ext} is not an admitted extension`);
    }
  });

  it('reports zero unparseable when every eligible extension is available', () => {
    const r = assessParserAvailability(['a.mjs', 'b.js'], ['.js', '.mjs']);
    assert.equal(r.unparseable, 0);
  });

  it('rides along on the extraction coverage record', () => {
    const cov = assessExtractionCoverage({
      outcome: 'ok', eligible: ['a.ts'], cruisedSources: [], repoRoot: repo,
      availableExtensions: ['.js'],
    });
    assert.equal(cov.parser.unparseable, 1);
    // A failed extraction has no measurement of any kind, parser included.
    assert.equal(assessExtractionCoverage({ outcome: 'failed' }).parser, null);
  });
});

describe('extraction edge buckets stay exhaustive', () => {
  it('sums every declared bucket', () => {
    const edges = Object.fromEntries(EXTRACTION_EDGE_BUCKETS.map((k, i) => [k, i + 1]));
    const total = EXTRACTION_EDGE_BUCKETS.reduce((s, _, i) => s + i + 1, 0);
    const cov = assessExtractionCoverage({ eligible: [], edges });
    assert.equal(assertExtractionExhaustive(cov, total).ok, true);
  });

  it('still fails when a filter drops an edge into no bucket', () => {
    const cov = assessExtractionCoverage({ eligible: [], edges: { persisted: 1 } });
    const r = assertExtractionExhaustive(cov, 2);
    assert.equal(r.ok, false, 'an unaccounted-for drop is the bug this assertion exists for');
    assert.equal(r.actual, 1);
  });
});

describe('extract.mjs end-to-end — a gitignored tree reaches neither index nor graph', () => {
  it('indexes only owned files and persists only owned edges', () => {
    const out = execFileSync(process.execPath, [EXTRACT, '--root', repo, '--mode', 'full'], {
      encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024,
    });
    const records = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const symbolFiles = new Set(records.filter((r) => r.type === 'symbol').map((r) => r.filePath));
    const imports = records.filter((r) => r.type === 'import');

    assert.ok(symbolFiles.size > 0, 'the fixture must produce symbols at all (vacuity guard)');
    for (const f of symbolFiles) {
      assert.ok(!f.startsWith('scripts/.claude-skills/'), `indexed a disowned file: ${f}`);
      assert.ok(!f.startsWith('vendored/') || f === 'vendored/kept.mjs',
        `indexed a disowned file: ${f}`);
    }
    assert.ok([...symbolFiles].some((f) => f === 'src/owned.mjs'),
      'the owned file must still be indexed — the filter must not empty the index');

    for (const e of imports) {
      for (const p of [e.importer, e.imported]) {
        assert.ok(!p.startsWith('scripts/.claude-skills/') && !p.startsWith('vendored/'),
          `persisted a disowned edge: ${e.importer} -> ${e.imported}`);
      }
    }
    assert.ok(
      imports.some((e) => e.importer === 'scripts/owned-script.mjs' && e.imported === 'src/helper.mjs'),
      'the owned edge must survive — the filter must not empty the graph',
    );

    const coverage = records.find((r) => r.type === 'coverage');
    assert.ok(coverage, 'a full run must emit a coverage record');
    assert.ok(coverage.extraction.edges.disowned > 0,
      'dropped edges must be COUNTED, not silently discarded');
    assert.equal(coverage.extraction.parser.known, true);
  });
});

describe('CoverageSchema — an unmeasured bucket stays unmeasured', () => {
  const envelope = (edges) => ({
    schemaVersion: 1,
    verdict: { status: 'degraded', reason: 'below_floor' },
    measuredAt: new Date().toISOString(),
    refreshId: 'r1',
    stale: false,
    extraction: {
      outcome: 'ok', eligible: 10, cruised: 3, ratio: 0.3, elapsedMs: 5,
      edges, samples: { uncruised: [] },
    },
    attribution: null,
  });

  it('leaves a pre-feature envelope\u2019s new buckets ABSENT, not zero', () => {
    // Audit R1 M14. `.default(0)` made "this run never counted disowned edges"
    // render as "this run found no disowned edges" — the false zero the whole
    // change exists to remove, written into its own schema.
    const r = CoverageSchema.safeParse(envelope({ external: 1, selfEdge: 0, escaping: 0, persisted: 2 }));
    assert.equal(r.success, true);
    assert.equal(Object.hasOwn(r.data.extraction.edges, 'disowned'), false);
    assert.equal(Object.hasOwn(r.data.extraction.edges, 'unresolved'), false);
  });

  it('keeps a current envelope\u2019s buckets verbatim', () => {
    const r = CoverageSchema.safeParse(envelope({
      external: 1, selfEdge: 0, escaping: 0, unresolved: 3, disowned: 4, persisted: 2,
    }));
    assert.equal(r.success, true);
    assert.equal(r.data.extraction.edges.disowned, 4);
    assert.equal(r.data.extraction.edges.unresolved, 3);
  });

  it('a historical envelope still reconciles against the exhaustivity sum', () => {
    // Absent must not poison the sum to NaN — that would report a MISSING
    // BUCKET as a failed census, the loudest possible false alarm.
    const legacy = { external: 1, selfEdge: 0, escaping: 0, persisted: 2 };
    assert.equal(assertExtractionExhaustive({ edges: legacy }, 3).ok, true);
  });
});
