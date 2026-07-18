/**
 * @fileoverview Tier-1 tests for the adjacency wave's state factory.
 * Plan: docs/plans/adjacency-check-containment.md §D9 / §D9a (Cluster B, Phase 2).
 *
 * These pin the two defects the plan audit found in this design before a line
 * was written:
 *   - R1-H2: a single mutually-exclusive status DISCARDED facts (a `capped`
 *     return would have thrown away real findings).
 *   - R1-H3: one `unavailable` conflated "no diff by design" with "required
 *     control could not run", both silent — the exact vacuous-green the plan
 *     rejects for caps, reintroduced one state over.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ADJACENCY_STATES,
  INCOMPLETENESS_KINDS,
  buildAdjacencyState,
  assertCleanIsEarned,
  blocksConvergence,
} from '../scripts/lib/audit/adjacency-state.mjs';

const candidate = (id = 'c1') => ({ id, dependence: 'independent' });
const incomplete = (kind = INCOMPLETENESS_KINDS.ENUMERATION_BOUND, detail = 'cap hit') =>
  ({ kind, scope: 'file.mjs', detail });
/** A run that genuinely looked at something — the coverage `clean` requires. */
const looked = { coverage: { containersEnumerated: 2, statementsJudged: 9 } };

describe('the four "nothing to report" states are distinguishable', () => {
  test('NOT_APPLICABLE: no diff contract by design', () => {
    const r = buildAdjacencyState({ diffContractAvailable: false });
    assert.equal(r.state, ADJACENCY_STATES.NOT_APPLICABLE);
    assert.equal(r.incompleteness.length, 0);
  });

  test('NOT_APPLICABLE: wave not selected', () => {
    const r = buildAdjacencyState({ selected: false });
    assert.equal(r.state, ADJACENCY_STATES.NOT_APPLICABLE);
  });

  test('NOT_TRIGGERED: looked, but nothing landed inside a conditional', () => {
    const r = buildAdjacencyState({ coverage: { containersEnumerated: 0, statementsJudged: 0 } });
    assert.equal(r.state, ADJACENCY_STATES.NOT_TRIGGERED);
  });

  test('CLEAN: enumerated real containers, judged real statements, none trapped', () => {
    const r = buildAdjacencyState({ ...looked });
    assert.equal(r.state, ADJACENCY_STATES.CLEAN);
  });

  test('CONTROL_UNAVAILABLE: asked to look, could not — NOT silent', () => {
    const r = buildAdjacencyState({
      incompleteness: [incomplete(INCOMPLETENESS_KINDS.PARSE_FAILURE, 'unparseable')],
    });
    assert.equal(r.state, ADJACENCY_STATES.CONTROL_UNAVAILABLE);
    assert.ok(blocksConvergence(r), 'a required control that could not run must block');
  });

  test('R1-H3 PIN: "no diff by design" and "could not look" are DIFFERENT states', () => {
    const byDesign = buildAdjacencyState({ diffContractAvailable: false });
    const couldNot = buildAdjacencyState({
      incompleteness: [incomplete(INCOMPLETENESS_KINDS.INPUT_BOUND, 'diff too large')],
    });
    assert.notEqual(byDesign.state, couldNot.state);
    assert.equal(blocksConvergence(byDesign), false, 'honest absence is silent');
    assert.equal(blocksConvergence(couldNot), true, 'a failed required control is loud');
  });

  test('all four are pairwise distinct in the RESULT OBJECT, not just in stderr', () => {
    const states = new Set([
      buildAdjacencyState({ diffContractAvailable: false }).state,
      buildAdjacencyState({}).state,
      buildAdjacencyState({ ...looked }).state,
      buildAdjacencyState({ incompleteness: [incomplete(INCOMPLETENESS_KINDS.PARSE_FAILURE)] }).state,
    ]);
    assert.equal(states.size, 4, 'the cloud-FP lesson: distinguishable in data, not only in logs');
  });
});

describe('R1-H2 / R2-H2 PIN: the label never suppresses a fact', () => {
  test('candidates AND incompleteness together → BOTH survive', () => {
    // The original design returned one status. `capped` would have discarded
    // these candidates entirely. This is the test that catches that class.
    const r = buildAdjacencyState({
      ...looked,
      candidates: [candidate('c1'), candidate('c2')],
      incompleteness: [incomplete()],
    });
    assert.equal(r.candidates.length, 2, 'findings must not be eaten by a cap in another file');
    assert.equal(r.incompleteness.length, 1, 'incomplete coverage must not be hidden by findings');
    assert.ok(blocksConvergence(r));
  });

  test('candidates pass through by identity — not copied, filtered, or reordered', () => {
    const cands = [candidate('a'), candidate('b')];
    const r = buildAdjacencyState({ ...looked, candidates: cands });
    assert.deepEqual(r.candidates.map((c) => c.id), ['a', 'b']);
  });

  test('incompleteness from a LATE stage still reaches the result', () => {
    // R2-H2: formatting/egress and bouncer stages produce incompleteness AFTER
    // the detector returned. The composer merges them; the factory must carry
    // whatever it is handed.
    const r = buildAdjacencyState({
      ...looked,
      incompleteness: [
        incomplete(INCOMPLETENESS_KINDS.EXCERPT_UNRESOLVABLE, 'payload unsafe'),
        incomplete(INCOMPLETENESS_KINDS.BOUNCER_DEGRADED, 'model call failed'),
      ],
    });
    assert.equal(r.incompleteness.length, 2);
    assert.ok(blocksConvergence(r));
  });
});

describe('THE SEAM PIN: the detector\'s output shape IS the factory\'s input shape', () => {
  test('a real detector-shaped fact object round-trips its coverage', async () => {
    // Found by a live end-to-end run, NOT by any unit test: the factory used to
    // take `containersEnumerated`/`statementsJudged` as flat top-level params
    // while `runAdjacencyAnalysis` returns them nested under `coverage`. Every
    // unit test on both sides passed — each tested its own assumption — and the
    // composed result reported "0 containers, 0 statements" alongside real
    // candidates. This test composes the two shapes instead of trusting either.
    const { runAdjacencyAnalysis } = await import('../scripts/lib/audit/adjacency-detector.mjs');
    const facts = await runAdjacencyAnalysis({
      repoRoot: process.cwd(),
      auditBaseCommit: 'HEAD',
      bounds: {
        maxChangedFiles: 50, maxChangedLines: 20000, maxDiffBytes: 2_000_000,
        maxSourceFileBytes: 1_000_000, maxContainers: 20,
        maxStatementsPerContainer: 40, maxCandidates: 25, maxExcerptChars: 3000,
      },
      adapters: {
        numstat: () => ({ ok: true, files: [{ path: 'a.mjs', added: 1, deleted: 0, binary: false }], totalChangedLines: 1 }),
        unifiedDiff: () => ({ ok: true, truncated: false, diffText: 'diff --git a/a.mjs b/a.mjs\n@@ -3,0 +4,1 @@\n+  sideEffect();\n' }),
        classifyPath: () => ({ category: null }),
        statSize: () => 200,
        readFile: () => 'function f(){\n  const outer = [];\n  if (cond) {\n    sideEffect();\n    use(outer);\n  }\n}\n',
        scanPayload: () => ({ safe: true }),
      },
    });

    const state = buildAdjacencyState(facts);

    // The contradiction this pins: candidates cannot exist without coverage.
    assert.ok(state.coverage.containersEnumerated > 0, 'coverage must survive the hand-off');
    assert.ok(state.coverage.statementsJudged > 0, 'coverage must survive the hand-off');
    if (state.candidates.length > 0) {
      assert.ok(
        state.coverage.containersEnumerated > 0 && state.coverage.statementsJudged > 0,
        'a result reporting candidates with zero coverage is self-contradicting',
      );
    }
  });
});

describe('CLEAN is an assertion, not a default', () => {
  test('clean is UNREACHABLE with zero coverage', () => {
    const r = buildAdjacencyState({ coverage: { containersEnumerated: 0, statementsJudged: 0 } });
    assert.notEqual(r.state, ADJACENCY_STATES.CLEAN);
  });

  test('clean is UNREACHABLE when anything was skipped', () => {
    const r = buildAdjacencyState({ ...looked, incompleteness: [incomplete()] });
    assert.notEqual(r.state, ADJACENCY_STATES.CLEAN);
    assert.equal(r.state, ADJACENCY_STATES.CAPPED);
  });

  test('assertCleanIsEarned THROWS on a hand-built clean with no coverage', () => {
    assert.throws(
      () => assertCleanIsEarned({
        state: ADJACENCY_STATES.CLEAN,
        coverage: { containersEnumerated: 0, statementsJudged: 0 },
        incompleteness: [],
      }),
      /did not run/,
    );
  });

  test('assertCleanIsEarned THROWS on clean alongside incompleteness', () => {
    assert.throws(
      () => assertCleanIsEarned({
        state: ADJACENCY_STATES.CLEAN,
        coverage: { containersEnumerated: 1, statementsJudged: 1 },
        incompleteness: [incomplete()],
      }),
      /partial coverage is not a clean result/,
    );
  });

  test('MIRROR: assertCleanIsEarned accepts a legitimately earned clean', () => {
    // Without this, the guard could pass by rejecting everything.
    const r = buildAdjacencyState({ ...looked });
    assert.doesNotThrow(() => assertCleanIsEarned(r));
  });

  test('assertCleanIsEarned ignores non-clean states', () => {
    const r = buildAdjacencyState({ ...looked, candidates: [candidate()] });
    assert.doesNotThrow(() => assertCleanIsEarned(r));
  });
});

describe('enum integrity — both directions', () => {
  test('every state the factory returns is a declared enum value', () => {
    const declared = new Set(Object.values(ADJACENCY_STATES));
    const produced = [
      buildAdjacencyState({ selected: false }),
      buildAdjacencyState({ diffContractAvailable: false }),
      buildAdjacencyState({}),
      buildAdjacencyState({ ...looked }),
      buildAdjacencyState({ ...looked, candidates: [candidate()] }),
      buildAdjacencyState({ ...looked, incompleteness: [incomplete()] }),
      buildAdjacencyState({ incompleteness: [incomplete(INCOMPLETENESS_KINDS.PARSE_FAILURE)] }),
      buildAdjacencyState({ threw: 'BOOM' }),
    ].map((r) => r.state);
    for (const s of produced) assert.ok(declared.has(s), `undeclared state: ${s}`);
  });

  test('every declared state is REACHABLE by some input', () => {
    // The direction the cloud-FP guard omits. An unreachable state is either
    // dead code or a rule nobody can trigger — both worth failing on.
    const reachable = new Set([
      buildAdjacencyState({ selected: false }).state,
      buildAdjacencyState({}).state,
      buildAdjacencyState({ ...looked }).state,
      buildAdjacencyState({ ...looked, candidates: [candidate()] }).state,
      buildAdjacencyState({ ...looked, incompleteness: [incomplete()] }).state,
      buildAdjacencyState({ incompleteness: [incomplete(INCOMPLETENESS_KINDS.PARSE_FAILURE)] }).state,
      buildAdjacencyState({ threw: 'BOOM' }).state,
    ]);
    for (const s of Object.values(ADJACENCY_STATES)) {
      assert.ok(reachable.has(s), `unreachable state: ${s}`);
    }
  });

  test('FAILED wins over everything, and still carries its facts', () => {
    const r = buildAdjacencyState({
      ...looked,
      candidates: [candidate()],
      incompleteness: [incomplete()],
      threw: 'DETECTOR_THREW',
    });
    assert.equal(r.state, ADJACENCY_STATES.FAILED);
    assert.equal(r.reason, 'DETECTOR_THREW');
    assert.equal(r.candidates.length, 1, 'even a failure does not discard what was found');
    assert.ok(blocksConvergence(r));
  });

  test('precedence is deterministic for co-occurring facts', () => {
    const r = buildAdjacencyState({ ...looked, candidates: [candidate()], incompleteness: [incomplete()] });
    assert.equal(r.state, ADJACENCY_STATES.FINDINGS, 'findings outrank capped as a LABEL');
    assert.equal(r.incompleteness.length, 1, '…while the capped fact still rides along');
  });
});

describe('blocksConvergence reads the arrays, never the label', () => {
  test('does not block on the honest-absence states', () => {
    assert.equal(blocksConvergence(buildAdjacencyState({ diffContractAvailable: false })), false);
    assert.equal(blocksConvergence(buildAdjacencyState({})), false);
    assert.equal(blocksConvergence(buildAdjacencyState({ ...looked })), false);
  });

  test('blocks on candidates, on incompleteness, and on failure', () => {
    assert.equal(blocksConvergence(buildAdjacencyState({ ...looked, candidates: [candidate()] })), true);
    assert.equal(blocksConvergence(buildAdjacencyState({ ...looked, incompleteness: [incomplete()] })), true);
    assert.equal(blocksConvergence(buildAdjacencyState({ threw: 'x' })), true);
  });

  test('handles a null/undefined result without throwing', () => {
    assert.equal(blocksConvergence(null), false);
    assert.equal(blocksConvergence(undefined), false);
  });
});
