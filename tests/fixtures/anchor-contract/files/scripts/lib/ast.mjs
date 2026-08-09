/**
 * @fileoverview Generic JS/TS AST parsing + a lightweight structural walker —
 * the shared-lib primitive. Nothing here is nav-, lint-, or audit-specific.
 *
 * **Why this module exists (domain boundary, not taste).** `parseSource`/`walk`
 * originally lived in `scripts/lib/nav/ast.mjs` (domain `nav-audit`), but two
 * `shared-lib` modules already imported them — `efficacy-lints.mjs` and
 * `lint/on-conflict.mjs` — and `shared-lib`'s `allowedDeps` are `[findings,
 * plan]`. That was a standing forbidden edge (`shared-lib → nav-audit`) in
 * `.audit-loop/domain-map.json`, ×2. A third consumer (`audit-orchestration`'s
 * adjacency wave, whose `allowedDeps` also exclude `nav-audit`) would have made
 * it ×3. Promoting the generic half to `shared-lib` — which every domain may
 * legally depend on — closes all of them at once; `nav/ast.mjs` re-exports these
 * so its own callers are untouched.
 * Plan: docs/plans/adjacency-check-containment.md §D6.
 *
 * **Scope rule for this file**: a symbol belongs here only if it is meaningful
 * without knowing what the caller is FOR. Parsing a source string and walking
 * nodes qualify; `jsxLabel`/`classifyTarget`/`calleeName` do not — they encode
 * nav's notion of a navigation target and stay in `nav/ast.mjs`.
 *
 * **Not a traversal framework.** `walk` is a deliberately small hand-rolled
 * recursive walker with no scope/binding resolution. Callers that need real
 * lexical analysis (`scope.getBinding`) must use `@babel/traverse` directly —
 * its `Scope` API only exists on a `NodePath`, which this walker does not
 * produce. See the adjacency detector for that path.
 *
 * @module scripts/lib/ast
 */
import { parse } from '@babel/parser';

// Babel 8: most ES syntax plugins are on by default; keep only the ones that
// still need explicit opt-in (and NOT the removed `importAssertions`).
const PLUGINS = [
  'jsx',
  'typescript',
  'decorators-legacy',
];

/**
 * Parse a source string to a Babel AST. Error-recovery is on so a single syntax
 * error doesn't lose the whole file; a hard failure returns `{ast:null,error}`.
 *
 * **Three outcomes, not two** (Cluster-A audit M6+M10, found independently by the
 * sustainability and quickfix passes):
 *   1. clean       → `{ast, error:null, recoveredErrors:[]}`
 *   2. **recovered** → `{ast, error:null, recoveredErrors:[…]}` — Babel returned a
 *      **partial** AST and put the syntax diagnostics in `ast.errors`. The old
 *      contract discarded them and returned `error:null`, making a
 *      syntactically-broken file **indistinguishable from a clean one**.
 *   3. hard failure → `{ast:null, error, recoveredErrors:[]}`
 *
 * Why this matters beyond tidiness: a consumer that needs *sound structural
 * coverage* (enumerate every statement in a block, prove a symbol is absent)
 * silently analyses a truncated tree in case 2 and reports a clean result — a
 * false green in exactly the recall path such a consumer exists to provide.
 *
 * **Additive by design**: `error` keeps its old semantics (null on recovery), so
 * the three existing callers (`nav/extract`, `efficacy-lints`, `lint/on-conflict`)
 * are byte-identical. Strictness is **opt-in** — a caller that cannot tolerate a
 * partial tree checks `recoveredErrors.length`. Whether `efficacy-lints` should
 * now route recovered parses to its stripped-source fallback is a real question,
 * but it is that module's policy decision and is deliberately NOT changed here.
 *
 * @param {string} content
 * @returns {{ast: object|null, error: string|null, recoveredErrors: string[]}}
 */
export function parseSource(content) {
  try {
    const ast = parse(content, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: PLUGINS,
    });
    // `ast.errors` is Babel's recovered-diagnostic channel. Normalise to strings
    // so the shape stays serialisable and free of Babel internals.
    const recoveredErrors = Array.isArray(ast?.errors)
      ? ast.errors.map((e) => (typeof e === 'string' ? e : (e?.message ?? String(e))))
      : [];
    return { ast, error: null, recoveredErrors };
  } catch (err) {
    return { ast: null, error: err.message, recoveredErrors: [] };
  }
}

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'range', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens', 'extra']);

/**
 * Recursively walk an AST, invoking `visit(node, ctx)` for every node. `ctx`
 * carries `enclosing` — the nearest named function/class/component ancestor.
 * @param {object} ast - a File node (or any node)
 * @param {(node: object, ctx: {enclosing: string|undefined, line: number}) => void} visit
 */
export function walk(ast, visit) {
  const root = ast && ast.type === 'File' ? ast.program : ast;
  recur(root, undefined);

  function recur(node, enclosing) {
    if (!node || typeof node.type !== 'string') return;
    const named = componentNameOf(node);
    const nextEnclosing = named || enclosing;
    visit(node, { enclosing: nextEnclosing, line: node.loc?.start?.line ?? 0 });
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) if (c && typeof c.type === 'string') recur(c, nextEnclosing);
      } else if (child && typeof child.type === 'string') {
        recur(child, nextEnclosing);
      }
    }
  }
}

/** The component/function name a node introduces, or null. Moved alongside
 *  `walk` because `walk` calls it — leaving it in `nav/ast.mjs` would make the
 *  shared module import back into `nav-audit`, recreating the very edge this
 *  split removes (and a circular one at that). */
export function componentNameOf(node) {
  if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) return node.id.name;
  if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init &&
      (node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression' || node.init.type === 'ClassExpression')) {
    return node.id.name;
  }
  return null;
}
