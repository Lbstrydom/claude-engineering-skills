/**
 * Cluster A (docs/plans/prepush-convergence-cluster-a.md, Phase 2 / fleet df45): `maxContainers=20` stopped the adjacency wave on a
 * 26-file diff and reported only the FIRST skipped file. The bound now scales with the diff unless the operator pinned it, and a
 * cap that still bites names what it skipped.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runAdjacencyAnalysis, effectiveMaxContainers, MAX_CONTAINERS_CEILING } from '../scripts/lib/audit/adjacency-detector.mjs';
import { INCOMPLETENESS_KINDS } from '../scripts/lib/audit/adjacency-state.mjs';
import { adjacencyConfig, clampAdjacencyBound } from '../scripts/lib/config.mjs';

const BOUNDS = {
  maxChangedFiles: 60, maxChangedLines: 20000, maxDiffBytes: 2e6, maxSourceFileBytes: 1e6,
  maxContainers: 20, maxStatementsPerContainer: 40, maxCandidates: 25, maxExcerptChars: 3000,
  maxCandidateChars: 8000, maxPromptChars: 60000,
};
// One `if` container per file, anchored on the added line (line 2 of the source).
const SRC = 'const x = 1;\nif (x) {\n  console.log(x);\n}\n';
const pathOf = (i) => `src/f${String(i).padStart(2, '0')}.mjs`;
const run = (n, bounds) => runAdjacencyAnalysis({
  repoRoot: process.cwd(),
  auditBaseCommit: 'HEAD',
  bounds,
  adapters: {
    numstat: () => ({ ok: true, files: Array.from({ length: n }, (_, i) => ({ path: pathOf(i), added: 1, deleted: 0, binary: false })), totalChangedLines: n }),
    unifiedDiff: () => ({
      ok: true, truncated: false,
      diffText: Array.from({ length: n }, (_, i) => `diff --git a/${pathOf(i)} b/${pathOf(i)}\n@@ -2,0 +3,1 @@\n+  console.log(x);\n`).join(''),
    }),
    classifyPath: () => ({ category: null }),
    statSize: () => SRC.length,
    readFile: () => SRC,
  },
});
const capNotes = (r) => r.incompleteness.filter((i) => i.kind === INCOMPLETENESS_KINDS.ENUMERATION_BOUND && /maxContainers/.test(i.detail));

describe('effectiveMaxContainers - pure', () => {
  test('unpinned: scales with the diff, never below the configured floor, never above the ceiling', () => {
    const b = { maxContainers: 20, scaleContainersWithDiff: true };
    assert.equal(effectiveMaxContainers(b, 5), 20);
    assert.equal(effectiveMaxContainers(b, 26), 52);
    assert.equal(effectiveMaxContainers(b, 10_000), MAX_CONTAINERS_CEILING);
  });

  test('pinned (operator set ADJACENCY_MAX_CONTAINERS): the pin wins, exactly', () => {
    assert.equal(effectiveMaxContainers({ maxContainers: 20, scaleContainersWithDiff: false }, 26), 20);
  });

  test('hand-built bounds with no flag keep the historical fixed behaviour', () => {
    assert.equal(effectiveMaxContainers({ maxContainers: 20 }, 26), 20);
  });
});

describe('adjacencyConfig - the pin is derived from the environment', () => {
  test('clampAdjacencyBound is unchanged and the shipped config scales by default', () => {
    assert.equal(clampAdjacencyBound(undefined, { min: 1, max: 500, dflt: 20, name: 'maxContainers' }), 20);
    assert.equal(adjacencyConfig.scaleContainersWithDiff, process.env.ADJACENCY_MAX_CONTAINERS === undefined);
  });
});

describe('runAdjacencyAnalysis - the 26-file diff from the field report', () => {
  test('26 files with scaling on: every container is enumerated and no maxContainers incompleteness is reported', async () => {
    const r = await run(26, { ...BOUNDS, scaleContainersWithDiff: true });
    assert.equal(capNotes(r).length, 0, JSON.stringify(r.incompleteness));
    assert.equal(r.coverage.containersEnumerated, 26);
  });

  test('NEGATIVE CONTROL: the same diff under a fixed cap of 20 is cut, and the report names the skipped files and their count', async () => {
    const r = await run(26, { ...BOUNDS, scaleContainersWithDiff: false });
    assert.equal(r.coverage.containersEnumerated, 20);
    const notes = capNotes(r);
    assert.equal(notes.length, 1);
    assert.match(notes[0].detail, /^maxContainers=20 reached — remaining files not enumerated/, 'the control-marker prefix must survive');
    for (let i = 20; i < 26; i += 1) assert.ok(notes[0].detail.includes(pathOf(i)), `${pathOf(i)} not named in: ${notes[0].detail}`);
    assert.ok(!notes[0].detail.includes(pathOf(0)), 'an enumerated file must not be listed as skipped');
  });

  test('a long skipped list is bounded to ten names plus a count', async () => {
    const r = await run(40, { ...BOUNDS, maxContainers: 5, scaleContainersWithDiff: false });
    const d = capNotes(r)[0].detail;
    assert.match(d, /\(\+25 more\)/);
    assert.equal((d.match(/src\/f\d\d\.mjs/g) || []).length, 10);
  });
});
