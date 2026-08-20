/**
 * @fileoverview Tier-1 tests for the containment-adjacency detector.
 * Plan: docs/plans/adjacency-check-containment.md (Cluster B, Phase 3).
 *
 * **The fixture IS the defect.** `legacy-production-audit@59f196f.mjs.txt` is a
 * frozen full-file snapshot at the commit where the cloud-FP fix landed — the
 * moment WS-C (`populateFindingMetadata` trapped inside
 * `if (mergedLedger.entries.length > 0)`) was there to be found and eight audit
 * rounds across two model families did not find it. The flagship test below
 * asserts this detector finds it from the commit's REAL hunk coordinate.
 *
 * A full file, not the 139-line branch, because Babel numbers a fragment from
 * line 1 while the real hunk anchor is 2403 — a fragment fixture makes the
 * flagship test structurally unable to pass. It also preserves the real scope
 * chain, which the WS-C verdict depends on (`allFindings` is declared OUTSIDE
 * the branch; in a fragment it would resolve as an undeclared global and the
 * test would agree with reality by luck rather than by structure).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parseSource } from '../scripts/lib/ast.mjs';
import {
  parseHunkTargets,
  findEnclosingConditional,
  enumerateBlockStatements,
  classifyStatementDependence,
  runAdjacencyAnalysis,
} from '../scripts/lib/audit/adjacency-detector.mjs';
import { INCOMPLETENESS_KINDS } from '../scripts/lib/audit/adjacency-state.mjs';
import { adjacencyConfig } from '../scripts/lib/config.mjs';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/adjacency/legacy-production-audit@59f196f.mjs.txt');
const source = fs.readFileSync(FIXTURE, 'utf-8');

/** Classify every top-level statement of the container holding `line`. */
function classifyContainerAt(line) {
  const { ast } = parseSource(source);
  const found = findEnclosingConditional(ast, line);
  if (!found) return null;
  const statements = enumerateBlockStatements(found.branchPath);
  return {
    found,
    rows: statements.map((s) => ({
      line: s.node.loc.start.line,
      dependence: classifyStatementDependence(s, { conditionNode: found.conditionNode, branchPath: found.branchPath }),
    })),
  };
}

describe('THE PIN — the defect eight audit rounds missed', () => {
  test('resolves the real ledger branch from the real hunk anchor', () => {
    // Commit 59f196f's actual hunk header for this file: @@ -2349,6 +2400,7 @@
    // → new-side lines 2400-2406, which land inside the branch at 2366-2505.
    const { found } = classifyContainerAt(2403);
    assert.equal(found.ifPath.node.loc.start.line, 2366);
    assert.equal(found.ifPath.node.loc.end.line, 2505);
    assert.equal(found.branchKind, 'consequent');
  });

  test('WS-C: the populateFindingMetadata loop is INDEPENDENT (trapped)', () => {
    const { rows } = classifyContainerAt(2403);
    const wsc = rows.find((r) => r.line === 2368);
    assert.ok(wsc, 'expected a statement at line 2368');
    assert.equal(
      wsc.dependence,
      'independent',
      'the loop reads only `allFindings` (declared OUTSIDE the branch) and an import — ' +
      'it has zero dependence on the ledger condition, which is exactly why it should never have been nested here',
    );
  });

  test('MIRROR: genuinely dependent statements are NOT flagged', () => {
    // Without this the suite could "pass" by calling everything independent.
    const { rows } = classifyContainerAt(2403);
    const expected = {
      2372: 'references-condition',  // suppressReRaises(allFindings, mergedLedger, …) — reads the condition subject
      2376: 'consumes-in-branch',    // reads `kept`, declared in-branch at 2372
      2386: 'consumes-in-branch',    // the fpTracker loop (WS-B) — reads `kept`
      2403: 'consumes-in-branch',    // reopenedSet = new Set(reopened)
      2405: 'consumes-in-branch',    // allFindings.push(...kept, ...reopened)
    };
    for (const [line, dependence] of Object.entries(expected)) {
      const row = rows.find((r) => r.line === Number(line));
      assert.ok(row, `expected a statement at line ${line}`);
      assert.equal(row.dependence, dependence, `line ${line}`);
    }
  });

  test('precision: a small minority of the branch is flagged', () => {
    // Recall matters more than precision here (the bouncer prunes downstream),
    // but a rule that flags most of a branch is noise, not signal. Measured on
    // the real branch: 5 independent of 26 top-level statements.
    const { rows } = classifyContainerAt(2403);
    const independent = rows.filter((r) => r.dependence === 'independent');
    assert.equal(rows.length, 26, 'the real branch has 26 top-level statements');
    assert.ok(independent.length <= 8, `expected a minority flagged, got ${independent.length}/26`);
    assert.ok(independent.length >= 1, 'must still find WS-C');
  });
});

describe('classification rules', () => {
  test("a statement's OWN locals are not branch dependencies", () => {
    // The bug this detector found in itself: `for (const f of allFindings)`
    // declares `f` in-branch and reads it, which made WS-C look dependent.
    const { ast } = parseSource(`
      function outer(){
        const outerThing = [];
        if (cond) {
          for (const x of outerThing) { use(x); }
        }
      }`);
    const found = findEnclosingConditional(ast, 5);
    const [stmt] = enumerateBlockStatements(found.branchPath);
    assert.equal(classifyStatementDependence(stmt, { conditionNode: found.conditionNode, branchPath: found.branchPath }), 'independent');
  });

  test('PRODUCES-FOR-BRANCH: a declaration consumed later in-branch is machinery', () => {
    const { ast } = parseSource(`
      function outer(){
        if (cond) {
          const acc = [];
          acc.push(1);
        }
      }`);
    const found = findEnclosingConditional(ast, 4);
    const [decl] = enumerateBlockStatements(found.branchPath);
    assert.equal(classifyStatementDependence(decl, { conditionNode: found.conditionNode, branchPath: found.branchPath }), 'produces-for-branch');
  });

  test('MIRROR: a declaration NOT consumed in-branch stays independent', () => {
    // Guards the refinement above from collapsing into "every declaration".
    const { ast } = parseSource(`
      function outer(){
        if (cond) {
          const unused = [];
        }
      }`);
    const found = findEnclosingConditional(ast, 4);
    const [decl] = enumerateBlockStatements(found.branchPath);
    assert.equal(classifyStatementDependence(decl, { conditionNode: found.conditionNode, branchPath: found.branchPath }), 'independent');
  });

  test('GUARD CLAUSE: a control-flow terminator is never trapped', () => {
    // Found by running this detector against its own newly-written code: the
    // only two candidates it produced were `if (!m) continue;` and
    // `if (n < min) { warn(…); return min; }` — both false positives. A
    // return/continue/break/throw inside a conditional IS the conditional's
    // purpose; hoisting it out changes control flow rather than relocating a
    // computation, so it cannot be "merely nested".
    for (const src of [
      'function f(){ for (const m of xs) { if (!m) continue; } }',
      'function f(){ if (bad) return null; }',
      'function f(){ if (bad) throw new Error("x"); }',
      'function f(){ for (;;) { if (done) break; } }',
    ]) {
      const { ast } = parseSource(src);
      const found = findEnclosingConditional(ast, 1);
      assert.ok(found, `expected a container in: ${src}`);
      for (const stmt of enumerateBlockStatements(found.branchPath)) {
        const dep = classifyStatementDependence(stmt, { conditionNode: found.conditionNode, branchPath: found.branchPath });
        assert.notEqual(dep, 'independent', `guard clause misflagged in: ${src}`);
      }
    }
  });

  test('MIRROR: the guard rule does NOT suppress a real trapped statement', () => {
    // Without this, "return/continue is never trapped" could quietly widen into
    // "nothing is trapped" — the WS-C pin above is the other half of this guard.
    const { ast } = parseSource(`
      function outer(){
        const outerThing = [];
        if (cond) {
          for (const x of outerThing) { use(x); }
        }
      }`);
    const found = findEnclosingConditional(ast, 5);
    const [stmt] = enumerateBlockStatements(found.branchPath);
    assert.equal(classifyStatementDependence(stmt, { conditionNode: found.conditionNode, branchPath: found.branchPath }), 'independent');
  });

  test('`var` is function-scoped, so a var declared in-branch is not an in-branch binding', () => {
    const { ast } = parseSource(`
      function outer(){
        if (cond) {
          var hoisted = 1;
          sink(hoisted);
        }
      }`);
    const found = findEnclosingConditional(ast, 5);
    const rows = enumerateBlockStatements(found.branchPath)
      .map((s) => classifyStatementDependence(s, { conditionNode: found.conditionNode, branchPath: found.branchPath }));
    assert.ok(!rows.includes('consumes-in-branch'), 'a hoisted var is function-scoped, not branch-scoped');
  });
});

describe('container resolution', () => {
  test('a hunk at function-body level yields NO container', () => {
    // Real line 2361 in the fixture — the `reopenedSet` declaration, which sits
    // deliberately OUTSIDE the branch.
    assert.equal(classifyContainerAt(2361), null);
  });

  test('nearest-wins: a nested conditional resolves to the inner branch', () => {
    const { ast } = parseSource(`
      function outer(){
        if (a) {
          stuff();
          if (b) {
            target();
          }
        }
      }`);
    const found = findEnclosingConditional(ast, 6);
    assert.equal(found.ifPath.node.test.name, 'b', 'must resolve the tightest enclosing branch');
  });

  test('unbraced branch resolves as a one-statement container', () => {
    // A block-only implementation silently skips these — a false green.
    const { ast } = parseSource('function f(){ if (ok) doWork(); }');
    const found = findEnclosingConditional(ast, 1);
    assert.ok(found, 'an unbraced branch is still a container');
    assert.equal(enumerateBlockStatements(found.branchPath).length, 1);
  });

  test('a hunk in the `test` expression is NOT a change inside the branch', () => {
    const { ast } = parseSource(`
      function f(){
        if (someCondition > 0) {
          body();
        }
      }`);
    assert.equal(findEnclosingConditional(ast, 3), null, 'editing the condition must not enumerate the body');
  });

  test('an else branch resolves as its own container', () => {
    const { ast } = parseSource(`
      function f(){
        if (a) { x(); }
        else { y(); }
      }`);
    const found = findEnclosingConditional(ast, 4);
    assert.equal(found.branchKind, 'alternate');
  });

  test('BUG (fp=2cdf1c6a): deleting the FIRST/ONLY statement of a braced ' +
       'conditional must still resolve the container — `headStart` alone ' +
       'lands on the `if (…) {` line and is excluded as a condition edit', () => {
    // Real `git diff --unified=0` output for deleting `doA();` from
    //   if (x) {          <- new-file line 2
    //     doA();          <- deleted (old-file line 3)
    //     doB();          <- new-file line 3 after the deletion
    //   }
    const diff = [
      'diff --git a/f.js b/f.js',
      '--- a/f.js',
      '+++ b/f.js',
      '@@ -3 +2,0 @@ if (x) {',
      '-  doA();',
      '',
    ].join('\n');
    const newFile = 'line1\nif (x) {\n  doB();\n}\nline6\n';

    const { targets: [t] } = parseHunkTargets(diff);
    const { ast } = parseSource(newFile);

    const resolved = t.anchorLines
      .map((line) => findEnclosingConditional(ast, line))
      .filter(Boolean);
    assert.equal(resolved.length, 1, 'exactly one anchor must resolve the container');
    assert.equal(resolved[0].ifPath.node.loc.start.line, 2, 'must resolve to the real if-statement');
  });
});

describe('parseHunkTargets — anchors', () => {
  test('every added line is an anchor, not just the hunk head', () => {
    const diff = [
      'diff --git a/x.mjs b/x.mjs',
      '--- a/x.mjs',
      '+++ b/x.mjs',
      '@@ -10,0 +10,3 @@',
      '+one();',
      '+two();',
      '+three();',
      '',
    ].join('\n');
    const { targets: [t] } = parseHunkTargets(diff);
    assert.deepEqual(t.anchorLines, [10, 11, 12]);
  });

  test('a PURE DELETION still yields an anchor', () => {
    // `+c,0` has zero `+` lines. An added-lines-only rule returns [] here and
    // deletions are silently ignored — killing the case deletion handling exists for.
    // `c` is the line BEFORE the gap and `c+1` is the line the gap closed onto —
    // both are pushed, because `c` alone lands on the `if (…) {` line when the
    // deleted statement was the container's first/only one, which
    // findEnclosingConditional's test-expression exclusion then discards.
    const diff = [
      'diff --git a/x.mjs b/x.mjs',
      '--- a/x.mjs',
      '+++ b/x.mjs',
      '@@ -10,3 +9,0 @@',
      '-gone();',
      '',
    ].join('\n');
    const { targets: [t] } = parseHunkTargets(diff);
    assert.deepEqual(t.anchorLines, [9, 10], 'both the pre-gap line and the line the gap closed onto are anchors');
  });

  test('anchors are deduplicated and sorted', () => {
    const diff = [
      'diff --git a/x.mjs b/x.mjs',
      '@@ -1,0 +5,1 @@',
      '+b();',
      '@@ -9,0 +2,1 @@',
      '+a();',
      '',
    ].join('\n');
    const { targets: [t] } = parseHunkTargets(diff);
    assert.deepEqual(t.anchorLines, [2, 5]);
  });

  test('a file with no hunks produces no target', () => {
    const { targets, undecodableCount } = parseHunkTargets('diff --git a/x.mjs b/x.mjs\n');
    assert.deepEqual(targets, []);
    assert.equal(undecodableCount, 0);
  });

  test('empty/absent diff text is handled', () => {
    assert.deepEqual(parseHunkTargets(''), { targets: [], undecodableCount: 0 });
    assert.deepEqual(parseHunkTargets(null), { targets: [], undecodableCount: 0 });
  });

  test('an added line whose OWN content starts with "+" (rendering as "+++" on the wire) is still counted as an anchor (round-1 code-audit H1)', () => {
    // The diff-marker '+' followed by source content '++counter;' renders as
    // the literal wire text '+++counter;' — indistinguishable BY PREFIX ALONE
    // from a `+++ b/file` header line, but this line is inside a hunk body
    // (after the `@@` marker), where a real file header can never appear.
    const diff = [
      'diff --git a/x.mjs b/x.mjs',
      '--- a/x.mjs',
      '+++ b/x.mjs',
      '@@ -10,0 +10,2 @@',
      '+++counter;',
      '+normal();',
      '',
    ].join('\n');
    const { targets: [t] } = parseHunkTargets(diff);
    assert.deepEqual(t.anchorLines, [10, 11], 'both added lines counted, including the one starting with "+"');
  });

  test('a pathDecodeFailed section (§4.2) is skipped from targets, COUNTED not silently dropped (final-gate shadow finding, round 3)', () => {
    // Genuinely asymmetric, unquoted, no rename/copy metadata — resolveHeaderPaths
    // returns null, so this section carries newPath: null.
    const diff = [
      'diff --git a/left.js b/right.js',
      '--- a/left.js',
      '+++ b/right.js',
      '@@ -1,0 +1,1 @@',
      '+one();',
      '',
    ].join('\n');
    assert.doesNotThrow(() => parseHunkTargets(diff));
    const { targets, undecodableCount } = parseHunkTargets(diff);
    assert.deepEqual(targets, [], 'no target for an unresolved path — nothing to name');
    assert.equal(undecodableCount, 1, 'but the skip itself is counted, never silent');
  });
});

describe('runAdjacencyAnalysis — facts, not a state', () => {
  const bounds = adjacencyConfig;

  test('refuses an unsafe/absent base ref as INPUT_BOUND incompleteness', async () => {
    const r = await runAdjacencyAnalysis({ repoRoot: process.cwd(), auditBaseCommit: null, bounds });
    assert.equal(r.threw, null);
    assert.equal(r.incompleteness[0].kind, INCOMPLETENESS_KINDS.INPUT_BOUND);
    assert.equal(r.candidates.length, 0);
  });

  test('THE COST PIN: the changed-file bound short-circuits BEFORE the diff is materialised', async () => {
    // R3-H1: a bound applied to a string you already built does not bound
    // building it. The unified-diff adapter must never be called.
    let unifiedCalls = 0;
    const r = await runAdjacencyAnalysis({
      repoRoot: process.cwd(),
      auditBaseCommit: 'HEAD',
      bounds: { ...bounds, maxChangedFiles: 0 },
      adapters: {
        numstat: () => ({ ok: true, files: [{ path: 'a.mjs', added: 1, deleted: 0, binary: false }], totalChangedLines: 1 }),
        unifiedDiff: () => { unifiedCalls += 1; return { ok: true, diffText: '', truncated: false }; },
      },
    });
    assert.equal(unifiedCalls, 0, 'the expensive step must not run once the preflight fails');
    assert.equal(r.incompleteness[0].kind, INCOMPLETENESS_KINDS.INPUT_BOUND);
  });

  test('the changed-LINE bound also short-circuits before materialisation', async () => {
    let unifiedCalls = 0;
    await runAdjacencyAnalysis({
      repoRoot: process.cwd(),
      auditBaseCommit: 'HEAD',
      bounds: { ...bounds, maxChangedLines: 1 },
      adapters: {
        numstat: () => ({ ok: true, files: [{ path: 'a.mjs', added: 500, deleted: 500, binary: false }], totalChangedLines: 1000 }),
        unifiedDiff: () => { unifiedCalls += 1; return { ok: true, diffText: '', truncated: false }; },
      },
    });
    assert.equal(unifiedCalls, 0);
  });

  test('a recovered/partial parse is INCOMPLETENESS, never a clean pass', async () => {
    // A truncated tree could miss statements and report a false clean — the
    // exact vacuous green this wave exists to prevent.
    const r = await runAdjacencyAnalysis({
      repoRoot: process.cwd(),
      auditBaseCommit: 'HEAD',
      bounds,
      adapters: {
        numstat: () => ({ ok: true, files: [{ path: 'a.mjs', added: 1, deleted: 0, binary: false }], totalChangedLines: 1 }),
        unifiedDiff: () => ({ ok: true, truncated: false, diffText: 'diff --git a/a.mjs b/a.mjs\n@@ -1,0 +1,1 @@\n+let a=1; let a=2;\n' }),
        classifyPath: () => ({ category: null }),
        statSize: () => 40,
        readFile: () => 'let a = 1; let a = 2;',
      },
    });
    assert.equal(r.incompleteness[0].kind, INCOMPLETENESS_KINDS.PARSE_FAILURE);
    assert.match(r.incompleteness[0].detail, /partial parse/);
  });

  test('a pathDecodeFailed section is reported as PARSE_FAILURE incompleteness, never a silent skip (final-gate shadow finding, round 3)', async () => {
    // Same coverage-honesty discipline as every other skip class in this
    // module — parseHunkTargets used to drop this file with no trace at all.
    const undecodableHeader = 'diff --git a/left.js b/right.js\n--- a/left.js\n+++ b/right.js\n@@ -1,0 +1,1 @@\n+one();\n';
    const r = await runAdjacencyAnalysis({
      repoRoot: process.cwd(),
      auditBaseCommit: 'HEAD',
      bounds,
      adapters: {
        numstat: () => ({ ok: true, files: [{ path: 'left.js', added: 1, deleted: 0, binary: false }], totalChangedLines: 1 }),
        unifiedDiff: () => ({ ok: true, truncated: false, diffText: undecodableHeader }),
      },
    });
    assert.equal(r.incompleteness[0].kind, INCOMPLETENESS_KINDS.PARSE_FAILURE);
    assert.match(r.incompleteness[0].detail, /pathDecodeFailed/);
    assert.equal(r.candidates.length, 0);
  });

  test('a sensitive path is dropped WITHOUT a diagnostic that leaks its existence', async () => {
    const r = await runAdjacencyAnalysis({
      repoRoot: process.cwd(),
      auditBaseCommit: 'HEAD',
      bounds,
      adapters: {
        numstat: () => ({ ok: true, files: [{ path: 'secrets/k.mjs', added: 1, deleted: 0, binary: false }], totalChangedLines: 1 }),
        unifiedDiff: () => ({ ok: true, truncated: false, diffText: 'diff --git a/secrets/k.mjs b/secrets/k.mjs\n@@ -1,0 +1,1 @@\n+x();\n' }),
        classifyPath: () => ({ category: 'sensitive' }),
        readFile: () => { throw new Error('must not read a sensitive file'); },
      },
    });
    assert.equal(r.candidates.length, 0);
    assert.equal(r.incompleteness.length, 0, 'no record may reveal that the path exists');
  });

  test('returns FACTS — never a `state` field (the composer owns that)', async () => {
    const r = await runAdjacencyAnalysis({ repoRoot: process.cwd(), auditBaseCommit: null, bounds });
    assert.ok('coverage' in r && 'candidates' in r && 'incompleteness' in r);
    assert.ok(!('state' in r), 'a state computed here would be stale before it is used');
  });
});

describe('reports-only — output is never trapped', () => {
  /** Classify the single top-level statement of the branch holding `line`. */
  const classifyOne = (src, line) => {
    const { ast } = parseSource(src);
    const found = findEnclosingConditional(ast, line);
    assert.ok(found, `no enclosing conditional at line ${line}`);
    const stmt = enumerateBlockStatements(found.branchPath)
      .find((s) => s.node.loc.start.line <= line && s.node.loc.end.line >= line);
    assert.ok(stmt, `no statement at line ${line}`);
    return classifyStatementDependence(stmt, { conditionNode: found.conditionNode, branchPath: found.branchPath });
  };

  // The field shape, reduced: `if (AS_JSON) { … } else { <human report> }`.
  // Every statement in the else-arm of a format switch reads nothing the
  // condition tests, so the mechanical rule admits the whole arm — and the
  // bouncer graded four console.logs HIGH (wine-cellar-app, 2026-08-13).
  const FORMAT_SWITCH = `
    function main(report, COMMIT, sum) {
      if (AS_JSON) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(COMMIT ? 'COMMITTED' : 'DRY RUN');
        for (const c of report.cellars) {
          if (!c.remap.length) continue;
          console.log(\`  \${c.name} remap \${String(c.remap.length).padEnd(3)}\`);
          for (const r of c.remap.slice(0, 5)) console.log(\`    \${r.row}\`);
        }
        console.log(\`TOTAL \${sum('remap')}\`);
        if (sum('blocked') > 0) {
          console.log('investigate before Cluster C');
        }
      }
    }`;

  test('a bare console.log in an else arm is reports-only', () => {
    assert.equal(classifyOne(FORMAT_SWITCH, 6), 'reports-only');
  });
  test('a loop whose body is only output is reports-only', () => {
    assert.equal(classifyOne(FORMAT_SWITCH, 7), 'reports-only');
  });
  test('output whose ARGUMENTS call helpers is still reports-only', () => {
    assert.equal(classifyOne(FORMAT_SWITCH, 12), 'reports-only', 'sum() in argument position is message-building');
  });
  test('an if wrapping only output is reports-only', () => {
    assert.equal(classifyOne(FORMAT_SWITCH, 13), 'reports-only');
  });

  // ── Negative controls. The class this wave exists to find must survive. ──
  test('a real trapped call is STILL independent', () => {
    const src = `
      function f(allFindings, ctx) {
        if (cloudOn) {
          for (const x of allFindings) populateFindingMetadata(x, ctx);
        }
      }`;
    assert.equal(classifyOne(src, 4), 'independent', 'the WS-C defect shape must not be swallowed');
  });
  test('output MIXED with an assignment is not reports-only', () => {
    const src = `
      function f(state) {
        if (verbose) {
          { console.log('tick'); state.count += 1; }
        }
      }`;
    assert.equal(classifyOne(src, 4), 'independent');
  });
  test('an awaited log is not reports-only (the await may sequence real work)', () => {
    const src = `
      async function f(sink) {
        if (verbose) {
          { await console.log('tick'); }
        }
      }`;
    assert.notEqual(classifyOne(src, 4), 'reports-only');
  });
  test('a bare log() identifier is not an output sink — it could do anything', () => {
    const src = `
      function f() {
        if (verbose) {
          log('tick');
        }
      }`;
    assert.equal(classifyOne(src, 4), 'independent');
  });
  test('logger.info and process.stderr.write ARE sinks', () => {
    const src = `
      function f(payload) {
        if (verbose) {
          { logger.info(payload); process.stderr.write('x'); }
        }
      }`;
    assert.equal(classifyOne(src, 4), 'reports-only');
  });
});
