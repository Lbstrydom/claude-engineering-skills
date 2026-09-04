/**
 * @fileoverview Shared AST module locating `process.exit()` calls that follow a
 * **stdout** write in the same function — the class `finishAndExit` exists to
 * remove.
 *
 * **The defect.** `cli-io.mjs`'s `finishAndExit` docstring names it as observed,
 * not theoretical: on Windows `process.stdout` to a PIPE is asynchronous, and
 * `npm run x`, `x | tee` and a CI capture are all pipes. `process.exit()`
 * discards whatever has not flushed, so the tail of a report vanishes with no
 * error anywhere. Where the stdout write is a JSON envelope a caller parses,
 * the failure is worse than lossy: a truncated envelope is a parse error
 * attributed to the wrong thing, or — if the truncation lands on a complete-
 * looking prefix — a silently short result.
 *
 * **Why an AST and not a grep.** Three of the distinctions this detector has to
 * make are invisible to text:
 *   - `process.stderr.write(...)` before an exit is NOT the class (stderr is
 *     synchronous enough for the skip messages, and every symbol-index CLI has
 *     one). A line-proximity grep cannot tell the two channels apart once the
 *     write and the exit are several lines apart.
 *   - a write inside a NESTED function that lexically precedes the exit has not
 *     necessarily executed. "Same function" means same nearest-enclosing
 *     function node, which only an AST knows.
 *   - `process` / `console` may be shadowed by a local. Resolution goes through
 *     `scope.getBinding`, the repo's established primitive
 *     (`find-rmsync-sites.mjs`, `import-binding.mjs`), so a shadowed identifier
 *     correctly does not match.
 *
 * **Soundness over recall.** A recovered (partial) Babel tree is a HARD failure
 * here, not a silently-smaller result — `parseSource`'s own docstring warns that
 * a consumer needing sound structural coverage reads a truncated tree as clean.
 * A detector for a silent-truncation class must not itself report a false green
 * by truncation.
 *
 * @module scripts/lib/find-stdout-exit-sites
 */

import nodePath from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import { resolvesToNamedImport } from './import-binding.mjs';

// @babel/traverse ships CJS; under ESM the callable lands on .default (and on
// .default.default via some interop paths). Same normalisation as
// find-rmsync-sites.mjs / adjacency-detector.mjs.
const traverse = _traverse?.default?.default ?? _traverse?.default ?? _traverse;

/**
 * The documented `--selfcheck-relocation` smoke contract (AGENTS.md §"CLI smoke
 * contract") is `console.log('OK'); process.exit(0);` VERBATIM, and
 * `check-cli-flags.mjs`-adjacent tooling asserts that literal shape across
 * `CLI_SMOKE_SET`. Rewriting it per-file would break the contract in exactly the
 * files the contract exists to standardise. It is exempted STRUCTURALLY — by the
 * enclosing `if` test naming the flag — rather than by a path allowlist, so a
 * new CLI adopting the contract needs no edit here, and a stdout write smuggled
 * into some OTHER `if` block is still reported.
 */
const SELFCHECK_FLAG = '--selfcheck-relocation';

/** Node types that open a new function scope. */
const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
]);

/**
 * `console` methods that write to **stdout**. `error`/`warn`/`trace` go to
 * stderr and are deliberately absent — including them would report the stderr
 * case this class explicitly excludes.
 */
const CONSOLE_STDOUT_METHODS = new Set(['log', 'info', 'debug', 'dir', 'table']);

/**
 * Resolve a member-expression property to its static name, or null when it is
 * computed with a non-literal key (`obj[k]`) — unknowable statically, and
 * treated as "not a match" rather than guessed.
 * @param {object} callee a MemberExpression / OptionalMemberExpression node
 * @returns {string|null}
 */
function staticPropertyName(callee) {
  if (!callee.computed && callee.property.type === 'Identifier') return callee.property.name;
  if (callee.computed && callee.property.type === 'StringLiteral') return callee.property.value;
  return null;
}

/**
 * Whether `identPath` is a genuine reference to the ambient global `name` —
 * i.e. it resolves to NO binding at all. A resolved binding means a local,
 * parameter or import is shadowing the global, so the call is not the one we
 * are looking for.
 * @param {import('@babel/traverse').NodePath} identPath
 * @param {string} name
 * @returns {boolean}
 */
function isAmbientGlobal(identPath, name) {
  if (identPath.node.type !== 'Identifier' || identPath.node.name !== name) return false;
  return identPath.scope.getBinding(name) === undefined;
}

/**
 * Classify a call as a stdout write, a `process.exit`, or neither.
 *
 * @param {import('@babel/traverse').NodePath} path a CallExpression path
 * @param {{cliIoSpec: object|null}} ctx
 * @returns {{kind: 'stdout'|'exit', how: string, exitCode: number|string|null}|null}
 */
function classifyCall(path, { cliIoSpec }) {
  const { callee } = path.node;

  if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
    const prop = staticPropertyName(callee);
    if (prop === null) return null;
    const objectPath = path.get('callee').get('object');
    const obj = objectPath.node;

    // process.exit(...)
    if (prop === 'exit' && isAmbientGlobal(objectPath, 'process')) {
      const arg = path.node.arguments[0];
      const exitCode = arg === undefined
        ? null
        : (arg.type === 'NumericLiteral' ? arg.value : 'dynamic');
      return { kind: 'exit', how: 'process.exit', exitCode };
    }

    // process.stdout.write(...)  /  process.stdout.end(...)
    if ((prop === 'write' || prop === 'end')
      && (obj.type === 'MemberExpression' || obj.type === 'OptionalMemberExpression')
      && staticPropertyName(obj) === 'stdout'
      && isAmbientGlobal(objectPath.get('object'), 'process')) {
      return { kind: 'stdout', how: `process.stdout.${prop}`, exitCode: null };
    }

    // console.log(...) and friends
    if (CONSOLE_STDOUT_METHODS.has(prop) && isAmbientGlobal(objectPath, 'console')) {
      return { kind: 'stdout', how: `console.${prop}`, exitCode: null };
    }

    return null;
  }

  // emit(...) imported from lib/cli-io.mjs — it writes stdout, so
  // `emit(x); process.exit(0)` is the same defect wearing a helper's clothes.
  if (callee.type === 'Identifier' && callee.name === 'emit' && cliIoSpec) {
    if (resolvesToNamedImport(path.get('callee'), cliIoSpec)) {
      return { kind: 'stdout', how: 'emit', exitCode: null };
    }
  }

  return null;
}

/**
 * The nearest ancestor that opens a function scope, or `programNode` for a
 * top-level call. Returned as the raw node so two calls can be compared by
 * reference equality — which is why the module-scope fallback must be the ONE
 * shared program node and not a freshly-built sentinel. The first cut returned
 * `{type:'Program'}` per call, so two top-level statements got two different
 * objects and a top-level `process.stdout.write(...); process.exit(0)` — the
 * very shape a thin CLI wrapper has — was never reported. Caught by a positive
 * control, not by review.
 * @param {import('@babel/traverse').NodePath} path
 * @param {object} programNode
 * @returns {object}
 */
function enclosingFunctionNode(path, programNode) {
  let p = path.parentPath;
  while (p) {
    if (FUNCTION_TYPES.has(p.node.type)) return p.node;
    p = p.parentPath;
  }
  return programNode;
}

/**
 * Whether `path` sits inside an `if` whose test mentions the
 * `--selfcheck-relocation` string literal — the documented CLI smoke contract.
 * @param {import('@babel/traverse').NodePath} path
 * @returns {boolean}
 */
function insideSelfcheckGuard(path) {
  let p = path.parentPath;
  while (p) {
    if (p.node.type === 'IfStatement') {
      let found = false;
      // A shallow structural scan of the test expression only — NOT the whole
      // `if`, so a `--selfcheck-relocation` string appearing in the BODY (a log
      // message, say) cannot exempt an unrelated exit.
      p.get('test').traverse({
        StringLiteral(s) { if (s.node.value === SELFCHECK_FLAG) found = true; },
      });
      if (p.node.test.type === 'StringLiteral' && p.node.test.value === SELFCHECK_FLAG) found = true;
      if (found) return true;
    }
    p = p.parentPath;
  }
  return false;
}

/**
 * Triage a stdout write by what it is CARRYING, because the two classes fail
 * differently and only one of them fails silently:
 *
 *   - **`envelope`** — a `JSON.stringify(...)` payload or an `emit(...)` call.
 *     The consumer PARSES this. A truncated envelope is a `SyntaxError`
 *     attributed to whatever the caller happened to be doing, or — when the cut
 *     lands on a complete-looking prefix — a silently short result that no one
 *     ever sees as an error. This is the class worth fixing first.
 *   - **`text`** — a human-readable report or summary line. Truncation loses a
 *     tail. Bad, but it is visible as a lost tail rather than misattributed.
 *
 * Same shape as `check-cli-flags.mjs`'s `classifyPolarity`, and for the same
 * reason: a severity-flat census gets worked top-down, which does the low-value
 * entries first. This is REPORT-ONLY ordering — the drift gate stays
 * triage-blind, because a net-new site is drift whichever payload it carries.
 *
 * @param {import('@babel/traverse').NodePath} writePath
 * @param {string} how
 * @returns {'envelope'|'text'}
 */
function classifyPayload(writePath, how) {
  if (how === 'emit') return 'envelope';
  let found = false;
  for (const argPath of writePath.get('arguments')) {
    if (found) break;
    const isStringify = (n) => n?.type === 'CallExpression'
      && n.callee?.type === 'MemberExpression'
      && !n.callee.computed
      && n.callee.property?.type === 'Identifier' && n.callee.property.name === 'stringify'
      && n.callee.object?.type === 'Identifier' && n.callee.object.name === 'JSON';
    if (isStringify(argPath.node)) { found = true; break; }
    argPath.traverse({ CallExpression(c) { if (isStringify(c.node)) found = true; } });
  }
  return found ? 'envelope' : 'text';
}

/**
 * Statements that end the current path, so nothing after them is reached.
 *
 * **`finishAndExit` counts, and forgetting it made the detector LOUDER as the
 * class was fixed.** Converting `process.stdout.write(x); process.exit(0)` to
 * `… await finishAndExit(0)` removed the terminator this function recognised, so
 * that write suddenly "reached" every later exit in the same function:
 * `symbol-index/refresh.mjs` went from 2 sites to 5 the moment its 2 were fixed.
 * A detector whose own remedy manufactures new findings is worse than useless —
 * it punishes the fix.
 *
 * Resolved through `scope.getBinding` rather than by spelling, so a local
 * helper that happens to be called `finishAndExit` cannot silence a real site.
 * A name-only match errs toward SILENCE here (it hides sites), which is the
 * direction this module refuses everywhere else.
 *
 * @param {import('@babel/traverse').NodePath} stmtPath
 * @param {object|null} cliIoSpec
 */
function isTerminatingStatement(stmtPath, cliIoSpec) {
  const stmt = stmtPath?.node;
  if (!stmt) return false;
  if (stmt.type === 'ReturnStatement' || stmt.type === 'ThrowStatement'
    || stmt.type === 'BreakStatement' || stmt.type === 'ContinueStatement') return true;
  if (stmt.type !== 'ExpressionStatement') return false;

  let exprPath = stmtPath.get('expression');
  // `void finishAndExit(n)` and `await finishAndExit(n)` both wrap the call.
  if (exprPath.node.type === 'AwaitExpression') exprPath = exprPath.get('argument');
  else if (exprPath.node.type === 'UnaryExpression' && exprPath.node.operator === 'void') exprPath = exprPath.get('argument');
  if (exprPath.node.type !== 'CallExpression') return false;
  const callee = exprPath.node.callee;

  // `process.exit(...)`
  if (callee.type === 'MemberExpression'
    && !callee.computed && callee.property.type === 'Identifier' && callee.property.name === 'exit'
    && callee.object.type === 'Identifier' && callee.object.name === 'process'
    && exprPath.get('callee').get('object').scope.getBinding('process') === undefined) return true;

  // `finishAndExit(...)` from lib/cli-io.mjs — the remedy for this very class.
  if (callee.type === 'Identifier' && callee.name === 'finishAndExit' && cliIoSpec) {
    return resolvesToNamedImport(exprPath.get('callee'), { ...cliIoSpec, importedName: 'finishAndExit' });
  }
  return false;
}

/**
 * Whether the write's own path provably ends before control could reach a LATER
 * statement — i.e. some statement after it, at any block level between the write
 * and `stopNode`, is a `return` / `throw` / `process.exit`.
 *
 * **This is the filter that makes the detector usable.** Without it the repo-wide
 * census reported 401 sites, the large majority of them this exact shape:
 *
 *     if (argv.includes('--help')) { console.log(usage); process.exit(0); }
 *     …600 lines…
 *     process.exit(2);          // ← reported against the help print
 *
 * The help print cannot have buffered anything when the later exit fires,
 * because its own branch already exited. `arch-coverage-gate.mjs` was the
 * clearest case: its ONLY stdout write is the `--selfcheck-relocation`
 * `console.log('OK')`, and it was being paired with all six later exits.
 *
 * The rule is deliberately about TERMINATION, not about branch-ness: a write
 * inside an earlier `if` or a `for` body that falls through IS still reported,
 * because it really can execute and then reach the exit. Only a provably-dead
 * edge is dropped.
 *
 * @param {import('@babel/traverse').NodePath} writePath
 * @param {object} stopNode  the nearest common ancestor node; the walk stops there
 * @returns {boolean}
 */
function pathTerminatesBefore(writePath, stopNode, cliIoSpec) {
  let p = writePath;
  while (p && p.node !== stopNode) {
    const parent = p.parentPath;
    if (!parent) return false;
    if ((parent.node.type === 'BlockStatement' || parent.node.type === 'Program'
      || parent.node.type === 'SwitchCase' || parent.node.type === 'StaticBlock')
      && parent.node !== stopNode) {
      const key = parent.node.type === 'SwitchCase' ? 'consequent' : 'body';
      const listPaths = parent.get(key);
      const idx = (parent.node[key] ?? []).indexOf(p.node);
      if (idx >= 0) {
        for (let i = idx + 1; i < listPaths.length; i++) {
          if (isTerminatingStatement(listPaths[i], cliIoSpec)) return true;
        }
      }
    }
    p = parent;
  }
  return false;
}

/**
 * Whether a stdout write can still have unflushed bytes when `exit` runs.
 *
 * Source order alone is not the question — see `pathTerminatesBefore`. This
 * combines three checks: same enclosing function (already established by the
 * caller), the write lexically first, and the write's path not provably dead.
 *
 * @param {{path: import('@babel/traverse').NodePath, node: object}} write
 * @param {{path: import('@babel/traverse').NodePath, node: object}} exit
 * @param {object|null} cliIoSpec
 * @returns {boolean}
 */
function writeReachesExit(write, exit, cliIoSpec) {
  if (write.node.start >= exit.node.start) return false;
  // Nearest common ancestor, walked from the roots of both ancestries.
  const aw = write.path.getAncestry().slice().reverse().map((p) => p.node);
  const ae = exit.path.getAncestry().slice().reverse().map((p) => p.node);
  let i = 0;
  while (i < aw.length && i < ae.length && aw[i] === ae[i]) i++;
  const common = aw[i - 1];
  // An `if`'s two arms are mutually exclusive: a write in the consequent can
  // never precede an exit in the alternate, whatever the source order says.
  if (common?.type === 'IfStatement' || common?.type === 'ConditionalExpression'
    || common?.type === 'LogicalExpression') {
    const cw = aw[i]; const ce = ae[i];
    if (cw !== ce) return false;
  }
  return !pathTerminatesBefore(write.path, common, cliIoSpec);
}

/**
 * @typedef {object} StdoutExitSite
 * @property {number} line          1-based line of the `process.exit` call
 * @property {number|string|null} exitCode  literal code, `'dynamic'`, or null for `process.exit()`
 * @property {number} writeLine     1-based line of the LAST reaching stdout write
 * @property {string} writeHow      e.g. `process.stdout.write`, `console.log`, `emit`
 * @property {number} writeCount    how many stdout writes can reach this exit
 * @property {'envelope'|'text'} payload  worst payload reaching it — see `classifyPayload`
 */

/**
 * Locate every `process.exit()` that a write to stdout can reach — same
 * enclosing function, lexically earlier, and not on a path that provably
 * terminates first (`pathTerminatesBefore`).
 *
 * It remains an over-approximation of "executed before": a write in an earlier
 * `if` that falls through counts, because it really can run. That direction is
 * correct — the fix (`await finishAndExit(code)`) is right whether or not the
 * write ran on a given invocation, and the alternative is a full CFG.
 *
 * @param {string} sourceText
 * @param {{fromFileAbsPath?: string, cliIoAbsPath?: string}} [opts]
 *   Both are needed to resolve an `emit` identifier to the real cli-io import;
 *   omit them and `emit` call sites are simply not classified as stdout writes.
 * @returns {StdoutExitSite[]}
 * @throws {Error} on a hard parse failure, or on a RECOVERED (partial) parse —
 *   see the module docstring on soundness.
 */
export function findStdoutExitSites(sourceText, opts = {}) {
  const { fromFileAbsPath, cliIoAbsPath } = opts;
  const ast = parse(sourceText, {
    sourceType: 'unambiguous',
    errorRecovery: true,
    plugins: ['jsx', 'typescript', 'decorators-legacy'],
  });
  if (Array.isArray(ast.errors) && ast.errors.length > 0) {
    throw new Error(
      `find-stdout-exit-sites: refusing a recovered (partial) parse — ${ast.errors.length} syntax `
      + `diagnostic(s), first: ${ast.errors[0]?.message ?? ast.errors[0]}. A partial tree would `
      + 'report FEWER sites and read as clean, which is the false green this detector exists to prevent.',
    );
  }

  // `path.resolve` on BOTH halves, not just the spec's: `import-binding`
  // compares the resolved specifier to `moduleAbsPath` with `===`, so a caller
  // passing forward slashes on Windows against a back-slashed resolution never
  // matches and every `emit` site reads clean. Normalising here keeps that trap
  // out of every caller.
  const cliIoSpec = (fromFileAbsPath && cliIoAbsPath)
    ? {
      importedName: 'emit',
      moduleAbsPath: nodePath.resolve(cliIoAbsPath),
      fromFileAbsPath: nodePath.resolve(fromFileAbsPath),
    }
    : null;

  /** @type {Map<object, Array<{path:object,node:object,line:number,how:string}>>} */
  const writesByFn = new Map();
  /** @type {Array<{path:object,node:object,fn:object,line:number,exitCode:number|string|null}>} */
  const exits = [];

  traverse(ast, {
    'CallExpression|OptionalCallExpression'(path) {
      const hit = classifyCall(path, { cliIoSpec });
      if (!hit) return;
      const fn = enclosingFunctionNode(path, ast.program);
      if (hit.kind === 'stdout') {
        if (!writesByFn.has(fn)) writesByFn.set(fn, []);
        writesByFn.get(fn).push({
          path, node: path.node, line: path.node.loc.start.line, how: hit.how,
          payload: classifyPayload(path, hit.how),
        });
        return;
      }
      if (insideSelfcheckGuard(path)) return;
      exits.push({ path, node: path.node, fn, line: path.node.loc.start.line, exitCode: hit.exitCode });
    },
  });

  const sites = [];
  for (const exit of exits) {
    const writes = (writesByFn.get(exit.fn) ?? []).filter((w) => writeReachesExit(w, exit, cliIoSpec));
    if (writes.length === 0) continue;
    const last = writes[writes.length - 1];
    sites.push({
      line: exit.line,
      exitCode: exit.exitCode,
      writeLine: last.line,
      writeHow: last.how,
      writeCount: writes.length,
      // The WORST payload that can reach this exit, not the last one's: an
      // envelope truncated by this exit is an envelope truncated by this exit
      // even if a plain text line was written after it.
      payload: writes.some((w) => w.payload === 'envelope') ? 'envelope' : 'text',
    });
  }
  sites.sort((a, b) => a.line - b.line);
  return sites;
}
