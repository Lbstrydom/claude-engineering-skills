/**
 * @fileoverview Tier-1 contract tests for the shared AST primitive
 * (`scripts/lib/ast.mjs`) — the generic half promoted out of `nav/ast.mjs`
 * to close two `shared-lib → nav-audit` forbidden edges.
 * Plan: docs/plans/adjacency-check-containment.md §D6 (Cluster A).
 *
 * Two things are pinned here:
 *   1. **The move is transparent** — `nav/ast.mjs` re-exports the generic
 *      symbols, so its existing callers cannot notice the split.
 *   2. **The three-outcome parse contract** (Cluster-A audit M6+M10) — a
 *      recovered/partial parse must be distinguishable from a clean one.
 *      Before this, both returned `{error: null}` and a syntactically broken
 *      file read as clean.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseSource, walk, componentNameOf } from '../scripts/lib/ast.mjs';
import * as navAst from '../scripts/lib/nav/ast.mjs';

describe('ast.mjs — the move is transparent to nav/ast.mjs callers', () => {
  test('nav/ast.mjs re-exports the generic symbols', () => {
    assert.equal(typeof navAst.parseSource, 'function');
    assert.equal(typeof navAst.walk, 'function');
    assert.equal(typeof navAst.componentNameOf, 'function');
  });

  test('re-exports are the SAME function objects, not copies', () => {
    // A copy would drift; identity proves there is exactly one implementation.
    assert.equal(navAst.parseSource, parseSource);
    assert.equal(navAst.walk, walk);
    assert.equal(navAst.componentNameOf, componentNameOf);
  });

  test('nav-specific helpers stayed behind in nav/ast.mjs', () => {
    // The scope rule for the shared module: a symbol belongs there only if it
    // is meaningful without knowing what the caller is FOR. These are not.
    for (const nav of ['classifyTarget', 'jsxLabel', 'jsxAttr', 'jsxTagName', 'calleeName', 'unwrapObjectExpression']) {
      assert.equal(typeof navAst[nav], 'function', `${nav} should remain on nav/ast.mjs`);
    }
  });
});

describe('parseSource — three outcomes, not two (audit M6/M10)', () => {
  test('CLEAN: valid source → ast, no error, no recovered diagnostics', () => {
    const r = parseSource('const a = 1; if (a) { b(); }');
    assert.ok(r.ast, 'expected an AST');
    assert.equal(r.error, null);
    assert.deepEqual(r.recoveredErrors, []);
  });

  test('HARD FAILURE: unparseable source → null ast + an error string', () => {
    const r = parseSource('const = = = ((((');
    assert.equal(r.ast, null);
    assert.equal(typeof r.error, 'string');
    assert.ok(r.error.length > 0);
    assert.deepEqual(r.recoveredErrors, []);
  });

  test('RECOVERED: partial parse surfaces diagnostics that used to be discarded', () => {
    // Babel returns a usable-looking AST here, and the PRE-FIX contract reported
    // `{error: null}` — indistinguishable from a clean parse. That is the bug.
    const r = parseSource('let a = 1; let a = 2;');
    assert.ok(r.ast, 'Babel error-recovery still yields a partial AST');
    assert.equal(r.error, null, 'error keeps its old semantics — additive fix');
    assert.ok(r.recoveredErrors.length > 0, 'the diagnostic must NOT be silently dropped');
    assert.match(r.recoveredErrors[0], /already been declared/);
  });

  test('recoveredErrors are plain strings (serialisable, no Babel internals)', () => {
    const r = parseSource('function f(){ super(); }');
    assert.ok(r.recoveredErrors.length > 0);
    for (const e of r.recoveredErrors) assert.equal(typeof e, 'string');
    assert.equal(JSON.stringify(r.recoveredErrors), JSON.stringify(r.recoveredErrors), 'must round-trip through JSON');
  });

  test('THE DISCRIMINATION PIN: clean and recovered are distinguishable', () => {
    // The whole point. A consumer needing sound structural coverage (enumerate
    // every statement, prove a symbol absent) must be able to tell these apart —
    // otherwise it analyses a truncated tree and reports a false clean.
    const clean = parseSource('const a = 1;');
    const recovered = parseSource('let a = 1; let a = 2;');
    assert.equal(clean.recoveredErrors.length, 0);
    assert.ok(recovered.recoveredErrors.length > 0);
    assert.notEqual(
      clean.recoveredErrors.length > 0,
      recovered.recoveredErrors.length > 0,
      'a broken-but-recovered parse must not read the same as a clean one',
    );
  });

  test('`return` outside a function is CONFIG, not a diagnostic', () => {
    // allowReturnOutsideFunction is deliberately on; it must not manufacture a
    // recovery diagnostic, or every module-level `return` would read as broken.
    const r = parseSource('return 5;');
    assert.ok(r.ast);
    assert.deepEqual(r.recoveredErrors, []);
  });
});

describe('walk — structural traversal', () => {
  test('visits nested nodes and tracks the enclosing named function', () => {
    const { ast } = parseSource('function outer(){ const x = 1; }');
    const seen = [];
    walk(ast, (node, ctx) => {
      if (node.type === 'VariableDeclarator') seen.push(ctx.enclosing);
    });
    assert.deepEqual(seen, ['outer']);
  });

  test('MIRROR: reports undefined enclosing at module top level', () => {
    // Guards against a walker that always reports *some* name — the suite must
    // not be able to pass by inventing an enclosing scope.
    const { ast } = parseSource('const x = 1;');
    const seen = [];
    walk(ast, (node, ctx) => {
      if (node.type === 'VariableDeclarator') seen.push(ctx.enclosing);
    });
    assert.deepEqual(seen, [undefined]);
  });

  test('carries a 1-indexed line number', () => {
    const { ast } = parseSource('\n\nconst x = 1;');
    let line = null;
    walk(ast, (node, ctx) => {
      if (node.type === 'VariableDeclarator') line = ctx.line;
    });
    assert.equal(line, 3);
  });
});

describe('componentNameOf', () => {
  test('names function, class, and arrow-assigned declarations', () => {
    const cases = [
      ['function foo(){}', 'foo'],
      ['class Bar {}', 'Bar'],
      ['const Baz = () => {};', 'Baz'],
      ['const Qux = function(){};', 'Qux'],
    ];
    for (const [src, expected] of cases) {
      let got = null;
      const { ast } = parseSource(src);
      walk(ast, (node) => { const n = componentNameOf(node); if (n) got = n; });
      assert.equal(got, expected, `expected ${expected} from ${src}`);
    }
  });

  test('MIRROR: returns null for a plain value binding', () => {
    const { ast } = parseSource('const n = 42;');
    let got = null;
    walk(ast, (node) => { const n = componentNameOf(node); if (n) got = n; });
    assert.equal(got, null, 'a non-callable binding is not a component');
  });
});
