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
 * **Two known limits, both measured rather than assumed.** A third — aliased
 * streams (`const out = process.stdout; out.write(x)`) — WAS on this list,
 * justified by "0 instances in the repo today". Round-2 adjudication rejected
 * that reasoning and it was right: **a documented limit is not enforcement**,
 * and this gate's claim is that a new instance cannot appear unnoticed. A zero
 * measurement says nothing about what an author writes tomorrow. Aliases now
 * resolve (`resolvesToStdoutAlias`), fail-closed on reassignment.
 *   - **Cross-module helpers.** Indirect writers resolve through the file's OWN
 *     call graph only. A helper imported from another module that writes stdout
 *     is not followed — that needs whole-program resolution, and this stays a
 *     per-file detector.
 *   - **An async helper called without `await`.** Its writes have not happened
 *     when a following `process.exit` runs, so the exit is a different defect
 *     (output never produced) and `finishAndExit` would not fix it — reporting
 *     it here would be a false positive. Measured 2026-09-04: **0 of 60**
 *     indirect sites in this repo have that shape, so nothing is built for it;
 *     if one appears, this is the note that says it is known and unhandled.
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
import { resolvesToNamedImport, resolvesToModuleBinding } from './import-binding.mjs';

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
  const binding = identPath.scope.getBinding(name);
  if (binding === undefined) return true;   // the ambient global
  // An EXPLICIT ESM import of the same global counts too:
  // `import process from 'node:process'` is the identical object, but it
  // creates a binding — and the first cut read any binding as "shadowed" and
  // skipped the file wholesale. Measured when the Gemini gate raised it
  // (2026-09-04): FOUR files under scripts/ import process that way, so every
  // exit in campaign.mjs, db-suites-gate.mjs, efficacy-lints-check.mjs and
  // nav-audit.mjs was silently invisible to the census. A blind spot that
  // swallows whole files is the worst shape this detector can have, because it
  // reports those files as clean.
  return resolvesToModuleBinding(identPath, { moduleSources: MODULE_SOURCES_FOR[name] ?? new Set() });
}

/**
 * The module specifiers whose default/namespace import IS the ambient global.
 * `node:console`'s import is the same console object; the bare specifiers are
 * the legacy spellings Node still resolves.
 */
const MODULE_SOURCES_FOR = {
  process: new Set(['node:process', 'process']),
  console: new Set(['node:console', 'console']),
};

/**
 * Whether an identifier resolves to a local binding holding `process.stdout`.
 *
 * **Fail-closed on reassignment.** A binding initialised to `process.stdout` but
 * written to later (`let out = process.stdout; … out = somethingElse`) still
 * counts. Reporting a site that turns out to be safe costs one `--update`
 * decision a human makes with the code in front of them; MISSING one costs a
 * silently truncated envelope nobody sees. The two errors are not symmetric, so
 * the tie goes to reporting.
 *
 * @param {import('@babel/traverse').NodePath} identPath the member-expression object
 * @returns {boolean}
 */
function resolvesToStdoutAlias(identPath, depth = 0) {
  // Chains terminate: `const a = process.stdout; const b = a; b.write(x)`.
  // The cap is a guard against a pathological or cyclic chain, not a design
  // limit — three hops is already far past anything real.
  if (depth > 3) return false;
  const binding = identPath.scope.getBinding(identPath.node.name);
  if (!binding) return false;

  const isStdoutMember = (n) => (n?.type === 'MemberExpression' || n?.type === 'OptionalMemberExpression')
    && !n.computed && n.property?.type === 'Identifier' && n.property.name === 'stdout'
    && n.object?.type === 'Identifier' && n.object.name === 'process';

  /** `const {stdout} = process` / `const {stdout: out} = process` (round-3 H1/M3). */
  const isStdoutDestructure = (declarator) => {
    if (declarator?.id?.type !== 'ObjectPattern') return false;
    if (declarator.init?.type !== 'Identifier' || declarator.init.name !== 'process') return false;
    return declarator.id.properties.some((prop) => prop.type === 'ObjectProperty'
      && !prop.computed
      && prop.key?.type === 'Identifier' && prop.key.name === 'stdout'
      && prop.value?.type === 'Identifier' && prop.value.name === identPath.node.name);
  };

  if (binding.path.type === 'VariableDeclarator') {
    const decl = binding.path.node;
    if (isStdoutMember(decl.init) || isStdoutDestructure(decl)) return true;
    // One more hop: this binding may itself hold another alias.
    if (decl.init?.type === 'Identifier') {
      const next = binding.path.get('init');
      if (resolvesToStdoutAlias(next, depth + 1)) return true;
    }
  }
  // …and any later assignment of `process.stdout` (or of another alias) to it.
  return (binding.constantViolations ?? []).some((v) => {
    if (v.node?.type !== 'AssignmentExpression') return false;
    if (isStdoutMember(v.node.right)) return true;
    return v.node.right?.type === 'Identifier' && resolvesToStdoutAlias(v.get('right'), depth + 1);
  });
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

    // An ALIAS: `const out = process.stdout; … out.write(x); process.exit(0)`.
    //
    // Round-2 adjudication. This was a documented limit backed by "0 instances
    // in the repo today", and the adjudicator's correction is the right one:
    // **a documented limit is not enforcement.** The gate's whole claim is that
    // a new instance cannot appear unnoticed; a limit measured at zero protects
    // against nothing an author writes tomorrow, and the census would have gone
    // quietly wrong rather than loudly incomplete.
    if ((prop === 'write' || prop === 'end') && obj.type === 'Identifier') {
      if (resolvesToStdoutAlias(objectPath)) {
        return { kind: 'stdout', how: `${obj.name}.${prop} (stdout alias)`, exitCode: null };
      }
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
      if (found) return isExactSmokeContract(p);
    }
    p = p.parentPath;
  }
  return false;
}

/**
 * Whether an `if` guarded by the self-check flag contains EXACTLY the documented
 * smoke contract and nothing else: `console.log(<string>); process.exit(0);`.
 *
 * **Why the flag alone is not enough** (round-1 audit H6/M1/M12 — three passes
 * raised it independently). Matching only the guard's TEST exempted every stdout
 * write and every exit anywhere beneath it, so
 *
 *     if (argv.includes('--selfcheck-relocation')) {
 *       process.stdout.write(JSON.stringify(hugeReport));   // ← silently exempt
 *       process.exit(0);
 *     }
 *
 * was waved through. The exemption's whole justification is that AGENTS.md
 * pins a LITERAL shape asserted across `CLI_SMOKE_SET`; an exemption broader
 * than the contract it cites is just a hole with a citation on it. Anything
 * that is not that exact two-statement body is now reported, which is also the
 * honest signal — a CLI whose smoke handler has grown extra stdout writes has
 * drifted from the contract and should be fixed there, not excused here.
 *
 * @param {import('@babel/traverse').NodePath} ifPath
 * @returns {boolean}
 */
function isExactSmokeContract(ifPath) {
  if (ifPath.node.alternate) return false;
  const body = ifPath.node.consequent.type === 'BlockStatement'
    ? ifPath.node.consequent.body
    : [ifPath.node.consequent];
  if (body.length !== 2) return false;

  const [logStmt, exitStmt] = body;
  // 1. console.log(<string literal>)  — the payload is a constant, so there is
  //    nothing of variable size to truncate.
  if (logStmt.type !== 'ExpressionStatement') return false;
  const logCall = logStmt.expression;
  if (logCall?.type !== 'CallExpression') return false;
  const lc = logCall.callee;
  if (lc?.type !== 'MemberExpression' || lc.computed
    || lc.object?.type !== 'Identifier' || lc.object.name !== 'console'
    || lc.property?.type !== 'Identifier' || lc.property.name !== 'log') return false;
  if (logCall.arguments.length !== 1 || logCall.arguments[0].type !== 'StringLiteral') return false;

  // 2. process.exit(0) — the literal zero, not a computed code.
  if (exitStmt.type !== 'ExpressionStatement') return false;
  const exitCall = exitStmt.expression;
  if (exitCall?.type !== 'CallExpression') return false;
  const ec = exitCall.callee;
  if (ec?.type !== 'MemberExpression' || ec.computed
    || ec.object?.type !== 'Identifier' || ec.object.name !== 'process'
    || ec.property?.type !== 'Identifier' || ec.property.name !== 'exit') return false;
  return exitCall.arguments.length === 1
    && exitCall.arguments[0].type === 'NumericLiteral'
    && exitCall.arguments[0].value === 0;
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
function isTerminatingStatement(stmtPath, cliIoSpec, { skipTransfers = false, isExiterCall = null } = {}) {
  const stmt = stmtPath?.node;
  if (!stmt) return false;
  // `return` and `throw` end the FUNCTION. `break`/`continue` do NOT — they end
  // an iteration or a switch case and hand control to the code AFTER the loop,
  // which is exactly where a later `process.exit` tends to sit:
  //
  //     for (const x of xs) { process.stdout.write(x); if (done) break; }
  //     process.exit(0);                       // ← truncates everything written
  //
  // Having them here made that a silent false negative: the walk found a `break`
  // after the write and severed the path entirely. Raised by the Gemini gate;
  // it was in the first version of this function. Removing them can only make
  // the detector report MORE, which is the safe direction — and there is no
  // case where a break prevents reaching a later exit, since it moves control
  // toward it.
  if (stmt.type === 'ReturnStatement' || stmt.type === 'ThrowStatement') return !skipTransfers;
  if (stmt.type !== 'ExpressionStatement') return false;

  let exprPath = stmtPath.get('expression');
  // Whether the call was actually AWAITED. Load-bearing for `finishAndExit`,
  // irrelevant for `process.exit`.
  let awaited = false;
  // ONLY `await finishAndExit(n)` — never `void finishAndExit(n)`.
  //
  // `void` discards the promise and returns IMMEDIATELY, so everything after it
  // still runs and every later exit stays reachable. Treating it as a
  // terminator suppressed real findings in exactly the shape AGENTS.md forbids
  // in the same breath as this gate ("never fire `void finishAndExit(code)` and
  // fall through") — the detector was excusing the bug its own invariant names.
  // Round-1 audit H3, raised against a test that asserted the wrong behaviour.
  //
  // Consequence, deliberately: a fire-and-forget `void finishAndExit(n)` before
  // a later exit now REPORTS. That is correct — the write really can still be
  // buffered when that exit fires.
  if (exprPath.node.type === 'AwaitExpression') { awaited = true; exprPath = exprPath.get('argument'); }
  if (exprPath.node.type !== 'CallExpression') return false;
  const callee = exprPath.node.callee;

  // A call to a LOCAL function that exits is itself a terminator. Teaching the
  // detector that such a call IS an exit (so it pairs with earlier writes) but
  // not that it ENDS the path left the mirror-image hole: two calls to the same
  // `finish()` helper paired the first call's write with the second call's
  // exit, though the first call never returns. The same one-sided-check shape,
  // one level in — caught by reading the sites rather than the count.
  if (isExiterCall && isExiterCall(exprPath)) return true;

  // `process.exit(...)` — resolved through the SAME `isAmbientGlobal` oracle the
  // classifier uses. It was an inline `getBinding('process') === undefined`
  // here, which is how fixing the explicit-ESM-import blind spot in ONE of the
  // two spellings produced 16 bogus sites: in a file doing
  // `import process from 'node:process'`, the classifier started seeing exits
  // while this predicate stopped seeing terminators, so the `--selfcheck`
  // block's own exit no longer ended its path and its `console.log('OK')`
  // reached every later exit. Two spellings of one predicate is the
  // single-oracle violation AGENTS.md names; there is now one.
  if (callee.type === 'MemberExpression'
    && !callee.computed && callee.property.type === 'Identifier' && callee.property.name === 'exit'
    && isAmbientGlobal(exprPath.get('callee').get('object'), 'process')) return true;

  // `await finishAndExit(...)` from lib/cli-io.mjs — the remedy for this class.
  //
  // The `await` is REQUIRED. `finishAndExit` is async, so a bare
  // `finishAndExit(0)` returns a promise and execution falls straight through
  // to the next statement — behaviourally identical to the `void` form this
  // function already refuses. The first cut stripped an AwaitExpression when it
  // happened to be there but never checked that it WAS there, so the bare call
  // was accepted as a terminator and silently hid every later exit in the
  // function. That is the round-1 H3 defect surviving in its other spelling:
  // the fix addressed the instance the audit named and stopped. Raised by the
  // Gemini gate, which is exactly the reading H3 should have prompted.
  if (callee.type === 'Identifier' && callee.name === 'finishAndExit' && cliIoSpec) {
    if (!awaited) return false;
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
function pathTerminatesBefore(writePath, stopNode, cliIoSpec, exitPath, isExiterCall) {
  // Every `try` whose CATCH or FINALLY contains the exit. Inside such a try's
  // block, a `throw` or `return` does NOT end the path — it transfers control
  // to exactly where the exit is sitting (Gemini gate, 4th pass):
  //
  //     try   { process.stdout.write(envelope); throw err; }
  //     catch { process.exit(1); }            // ← truncates what try wrote
  //
  // Measured when raised: 4 live sites across 3 files. This is the
  // error-handling path, which is the one most likely to be carrying a JSON
  // envelope, so treating it as dead was the costliest possible place to.
  const caughtBy = new Set();
  for (let q = exitPath?.parentPath; q; q = q.parentPath) {
    const t = q.parentPath?.node;
    if (t?.type === 'TryStatement' && (q.node === t.handler || q.node === t.finalizer)) caughtBy.add(t);
  }

  /** Whether `stmtPath` sits inside the `try` block of a try the exit is caught by. */
  const isInCaughtTry = (stmtPath, caught) => {
    for (let q = stmtPath; q?.parentPath; q = q.parentPath) {
      const t = q.parentPath.node;
      if (t?.type === 'TryStatement' && q.node === t.block && caught.has(t)) return true;
    }
    return false;
  };

  // Which child of a given block sits on the EXIT's ancestor chain — so the
  // scan can stop there instead of running past it.
  const exitChain = new Map();
  for (let q = exitPath; q?.parentPath; q = q.parentPath) exitChain.set(q.parentPath.node, q.node);

  let p = writePath;
  while (p) {
    const parent = p.parentPath;
    if (!parent) return false;
    // The write is INSIDE a `return`/`throw` expression — `return helper(x)`,
    // where `helper` writes. Evaluating it is the last thing the function does,
    // so nothing after it in this function is reachable. The scan below only
    // ever looked at statements AFTER the write's statement, so this case —
    // where the write's own enclosing statement is the terminator — was
    // invisible, and it is the shape of every `if (a) return f(); return g();`
    // dispatcher in the repo.
    if ((p.node.type === 'ReturnStatement' || p.node.type === 'ThrowStatement')
      && !isInCaughtTry(p, caughtBy)) return true;
    // The write IS (or is an argument of) a call to a local function that
    // exits — `finish(shape(...))`, where `finish` writes and then exits. The
    // path ends inside that call, so no later exit in the caller is reachable.
    // Sibling-statement scanning cannot see this: the call is nested in an
    // `if` consequent, and "does a LATER statement unconditionally terminate"
    // is a different question from "does THIS one".
    // NOT guarded by `p !== writePath`: for a synthetic call-site write the
    // write path IS that call, and a helper that both writes and exits ends the
    // path exactly there. A direct `process.stdout.write` is never an exiter
    // call, so this cannot self-terminate a real write.
    if (p.node.type === 'CallExpression' && isExiterCall?.(p)) return true;
    if (parent.node.type === 'BlockStatement' || parent.node.type === 'Program'
      || parent.node.type === 'SwitchCase' || parent.node.type === 'StaticBlock') {
      // `process.exit` / `await finishAndExit` still terminate here — those end
      // the PROCESS, and no catch or finally saves them. Only the transferring
      // forms are neutralised.
      const inCaughtTryBlock = parent.parentPath?.node?.type === 'TryStatement'
        && parent.node === parent.parentPath.node.block
        && caughtBy.has(parent.parentPath.node);
      const key = parent.node.type === 'SwitchCase' ? 'consequent' : 'body';
      const listPaths = parent.get(key);
      const list = parent.node[key] ?? [];
      const idx = list.indexOf(p.node);
      if (idx >= 0) {
        // Stop at the exit's own statement when this block contains it — the
        // COMMON-ANCESTOR level. The first cut skipped that level outright
        // (`parent.node !== stopNode`), and it is precisely where a sibling
        // terminator between the two lives:
        //
        //     if (save) return runSaveMode(args);   // ← writes
        //     return runBrainstormMode(args);       // ← exits
        //
        // Two mutually exclusive paths that the detector paired, because the
        // `return` separating them was never examined. Found by spot-checking
        // the sites the indirect-exit work added rather than trusting the count.
        const stopChild = exitChain.get(parent.node);
        const end = stopChild ? list.indexOf(stopChild) : listPaths.length;
        for (let i = idx + 1; i < (end < 0 ? listPaths.length : end); i++) {
          if (isTerminatingStatement(listPaths[i], cliIoSpec, { skipTransfers: inCaughtTryBlock, isExiterCall })) return true;
        }
      }
    }
    if (parent.node === stopNode) return false;
    p = parent;
  }
  return false;
}

/**
 * A compact, line-independent description of WHERE inside its function an exit
 * sits: the chain of enclosing statement kinds from the function body down to
 * the exit, plus the branch taken at each `if`.
 *
 * **Why identity needs this** (round-2 audit H1/M1). `file::fn::shape#ordinal`
 * still could not tell a REPLACED site from an unchanged one: delete one
 * `write→exit(2)` in `main()` and add another elsewhere in `main()` with the
 * same shape, and the identity set does not move — the swap blind spot, one
 * level down from the one the function name closed. The structural path
 * distinguishes two sites in different branches, which is the overwhelmingly
 * common real shape.
 *
 * It is deliberately NOT a content hash. Content churns on a reworded message
 * and would send people to `--update` reflexively, which is the failure mode
 * the whole line-independent design exists to avoid. Two same-shaped sites in
 * the SAME block still fall back to the ordinal — a residual, documented limit.
 *
 * @param {import('@babel/traverse').NodePath} exitPath
 * @returns {string} e.g. `if>then/try>block` or `` for a straight-line body
 */
function structuralPath(exitPath) {
  const parts = [];
  let child = exitPath;
  let p = exitPath.parentPath;
  while (p && !FUNCTION_TYPES.has(p.node.type) && p.node.type !== 'Program') {
    const n = p.node;
    if (n.type === 'IfStatement') {
      parts.push(n.alternate === child.node ? 'if>else' : 'if>then');
    } else if (n.type === 'TryStatement') {
      parts.push(n.finalizer === child.node ? 'try>finally' : (n.handler === child.node ? 'try>catch' : 'try>block'));
    } else if (n.type === 'SwitchCase') {
      parts.push(n.test ? 'case' : 'default');
    } else if (/^(For|While|DoWhile)/.test(n.type) || n.type === 'ForOfStatement' || n.type === 'ForInStatement') {
      parts.push('loop');
    }
    child = p;
    p = p.parentPath;
  }
  return parts.reverse().join('/');
}

/**
 * A readable name for the function enclosing `path` — the declaration's own
 * name, the variable a function expression is assigned to, or a method's key.
 * `<module>` for top-level code, `<anonymous>` when nothing names it.
 * @param {import('@babel/traverse').NodePath} path
 * @returns {string}
 */
function functionNameOf(path) {
  let p = path.parentPath;
  while (p) {
    const n = p.node;
    if (FUNCTION_TYPES.has(n.type)) {
      if (n.id?.name) return n.id.name;
      if ((n.type === 'ObjectMethod' || n.type === 'ClassMethod') && n.key?.name) return n.key.name;
      const parent = p.parentPath?.node;
      if (parent?.type === 'VariableDeclarator' && parent.id?.type === 'Identifier') return parent.id.name;
      if (parent?.type === 'ObjectProperty' && parent.key?.name) return parent.key.name;
      if (parent?.type === 'AssignmentExpression' && parent.left?.type === 'Identifier') return parent.left.name;
      return '<anonymous>';
    }
    p = p.parentPath;
  }
  return '<module>';
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
function writeReachesExit(write, exit, cliIoSpec, isExiterCall) {
  if (write.node.start >= exit.node.start) return false;
  // Nearest common ancestor, walked from the roots of both ancestries.
  const aw = write.path.getAncestry().slice().reverse().map((p) => p.node);
  const ae = exit.path.getAncestry().slice().reverse().map((p) => p.node);
  let i = 0;
  while (i < aw.length && i < ae.length && aw[i] === ae[i]) i++;
  const common = aw[i - 1];
  // Only the genuinely EXCLUSIVE pair is `consequent` vs `alternate`.
  //
  // The first cut said "different children of an if/ternary/logical ⇒
  // exclusive", which also excluded the CONDITION from the body — and the
  // condition runs FIRST. So `if (writeAndCheck()) { process.exit(0); }` was a
  // silent false negative, as was `hasOutput() && process.exit(0)`. Raised by
  // the Gemini gate; the rule now names the two arms explicitly rather than
  // inferring exclusivity from inequality.
  if (common?.type === 'IfStatement' || common?.type === 'ConditionalExpression') {
    const cw = aw[i]; const ce = ae[i];
    const exclusive = (cw === common.consequent && ce === common.alternate)
      || (cw === common.alternate && ce === common.consequent);
    if (exclusive) return false;
  }
  // A LogicalExpression is never exclusive in the direction that matters: its
  // `left` always evaluates before its `right`, so a write on the left can
  // reach an exit on the right. (`right` may not run — that only makes this an
  // over-approximation, which is the safe direction.)
  return !pathTerminatesBefore(write.path, common, cliIoSpec, exit.path, isExiterCall);
}

/**
 * @typedef {object} StdoutExitSite
 * @property {number} line          1-based line of the `process.exit` call
 * @property {number|string|null} exitCode  literal code, `'dynamic'`, or null for `process.exit()`
 * @property {number} writeLine     1-based line of the LAST reaching stdout write
 * @property {string} writeHow      e.g. `process.stdout.write`, `console.log`, `emit`
 * @property {number} writeCount    how many stdout writes can reach this exit
 * @property {'envelope'|'text'} payload  worst payload reaching it — see `classifyPayload`
 * @property {string} fnName        enclosing function name, for a line-independent site identity
 * @property {string} structure     enclosing branch/loop chain inside that function
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

  // ── Same-file indirect writers (round-1 audit H4/M13) ────────────────────
  //
  // `writeReport(); process.exit(0);` is the same defect as an inline write,
  // and pairing only DIRECT writes missed it. Measured on this repo at the time
  // the gap was raised: 51 further sites across 16 files — a ~28% undercount on
  // a 183-site census whose whole claim is to BE a census.
  // `check-context-drift.mjs:517` was the clearest, exiting straight after an
  // `emitOutput()` helper.
  //
  // Resolution is a fixed point over the file's OWN call graph: a function
  // containing a direct stdout write is a writer, and so is any function that
  // calls one. Callees resolve through `scope.getBinding`, so only a genuine
  // local function counts — a same-named import or parameter does not.
  //
  // **Same-file only, and that bound is deliberate.** Following an IMPORTED
  // helper needs cross-module resolution and a whole-program pass; this stays a
  // per-file detector, so a helper imported from another module is still a
  // known blind spot (§7 of the plan). Bounded under-approximation with the
  // limit written down beats an unbounded one nobody has measured.
  /** @type {Map<object, {payload: 'envelope'|'text'}>} */
  const writerFns = new Map();
  /**
   * Local functions that TERMINATE — `function fatal(m){ …; process.exit(1) }`.
   *
   * The mirror of `writerFns`, added after the Gemini gate asked the question
   * AGENTS.md tells you to ask of any one-sided check: *which side am I
   * iterating, and what is unrepresentable from it?* Writes propagated up the
   * call graph and exits did not, so `process.stdout.write(err); fatal();` was
   * invisible — the write recorded in the caller, the exit in the callee, never
   * paired. Measured when raised: 29 live sites across 14 files.
   * @type {Map<object, {exitCode: number|string|null}>}
   */
  const exiterFns = new Map();
  /** @type {Array<{callPath: object, targetFn: object, fn: object}>} */
  const localCalls = [];

  /** The local function node an Identifier callee resolves to, or null. */
  const resolveLocalFn = (calleePath) => {
    if (calleePath.node.type !== 'Identifier') return null;
    const binding = calleePath.scope.getBinding(calleePath.node.name);
    if (!binding) return null;
    const bp = binding.path;
    if (bp.node.type === 'FunctionDeclaration') return bp.node;
    if (bp.node.type === 'VariableDeclarator'
      && (bp.node.init?.type === 'FunctionExpression' || bp.node.init?.type === 'ArrowFunctionExpression')) {
      return bp.node.init;
    }
    return null;
  };

  /** @type {Map<object, Array<{path:object,node:object,line:number,how:string}>>} */
  const writesByFn = new Map();
  /** @type {Array<{path:object,node:object,fn:object,line:number,exitCode:number|string|null}>} */
  const exits = [];

  traverse(ast, {
    'CallExpression|OptionalCallExpression'(path) {
      const fn = enclosingFunctionNode(path, ast.program);
      const hit = classifyCall(path, { cliIoSpec });
      if (!hit) {
        // Not itself a write or an exit — but it may CALL a local writer, which
        // the fixed point below decides. Record the edge either way; resolving
        // the callee here reuses this traversal's live scope.
        const target = resolveLocalFn(path.get('callee'));
        if (target) localCalls.push({ callPath: path, targetFn: target, fn });
        return;
      }
      if (hit.kind === 'stdout') {
        const payload = classifyPayload(path, hit.how);
        if (!writesByFn.has(fn)) writesByFn.set(fn, []);
        writesByFn.get(fn).push({
          path, node: path.node, line: path.node.loc.start.line, how: hit.how, payload,
        });
        // A function containing a direct write is a writer. `envelope` wins,
        // since the worst payload it can emit is what a caller's exit truncates.
        if (fn !== ast.program) {
          const prior = writerFns.get(fn);
          if (!prior || (prior.payload === 'text' && payload === 'envelope')) writerFns.set(fn, { payload });
        }
        return;
      }
      if (insideSelfcheckGuard(path)) return;
      exits.push({ path, node: path.node, fn, line: path.node.loc.start.line, exitCode: hit.exitCode });
      // A function containing an exit is an exiter. Differing codes collapse to
      // 'dynamic' — the call site cannot know which one fires.
      if (fn !== ast.program) {
        const prior = exiterFns.get(fn);
        if (!prior) exiterFns.set(fn, { exitCode: hit.exitCode });
        else if (prior.exitCode !== hit.exitCode) exiterFns.set(fn, { exitCode: 'dynamic' });
      }
    },
  });

  // Fixed point: a function that calls a writer is itself a writer. Bounded by
  // the number of local functions — each pass must promote at least one to
  // continue, so it terminates even on a cyclic (mutually recursive) graph.
  for (let changed = true; changed;) {
    changed = false;
    for (const { targetFn, fn } of localCalls) {
      const target = writerFns.get(targetFn);
      if (!target || fn === ast.program) continue;
      const prior = writerFns.get(fn);
      if (!prior) { writerFns.set(fn, { payload: target.payload }); changed = true; }
      else if (prior.payload === 'text' && target.payload === 'envelope') {
        writerFns.set(fn, { payload: 'envelope' }); changed = true;
      }
    }
  }

  // Same fixed point for exiters.
  for (let changed = true; changed;) {
    changed = false;
    for (const { targetFn, fn } of localCalls) {
      const target = exiterFns.get(targetFn);
      if (!target || fn === ast.program) continue;
      const prior = exiterFns.get(fn);
      if (!prior) { exiterFns.set(fn, { exitCode: target.exitCode }); changed = true; }
      else if (prior.exitCode !== target.exitCode && prior.exitCode !== 'dynamic') {
        exiterFns.set(fn, { exitCode: 'dynamic' }); changed = true;
      }
    }
  }

  // A call to an exiter IS an exit at the call site.
  for (const { callPath, targetFn, fn } of localCalls) {
    const e = exiterFns.get(targetFn);
    if (!e) continue;
    if (insideSelfcheckGuard(callPath)) continue;
    exits.push({
      path: callPath, node: callPath.node, fn,
      line: callPath.node.loc.start.line,
      exitCode: e.exitCode,
      via: `${callPath.node.callee.name}()`,
    });
  }

  // Every call to a writer counts as a stdout write AT THE CALL SITE, so the
  // existing reachability and ordering logic applies to it unchanged.
  for (const { callPath, targetFn, fn } of localCalls) {
    const w = writerFns.get(targetFn);
    if (!w) continue;
    if (!writesByFn.has(fn)) writesByFn.set(fn, []);
    writesByFn.get(fn).push({
      path: callPath,
      node: callPath.node,
      line: callPath.node.loc.start.line,
      how: `${callPath.node.callee.name}() → stdout`,
      payload: w.payload,
    });
  }
  for (const list of writesByFn.values()) list.sort((a, b) => a.node.start - b.node.start);

  // Resolves a CallExpression path to "does this call a local function that
  // exits?" — closed over the fixed point computed above.
  const isExiterCall = (callPath) => {
    const c = callPath.node.callee;
    if (c?.type !== 'Identifier') return false;
    const target = resolveLocalFn(callPath.get('callee'));
    return Boolean(target && exiterFns.has(target));
  };

  const sites = [];
  for (const exit of exits) {
    const writes = (writesByFn.get(exit.fn) ?? []).filter((w) => writeReachesExit(w, exit, cliIoSpec, isExiterCall));
    if (writes.length === 0) continue;
    const last = writes[writes.length - 1];
    sites.push({
      line: exit.line,
      exitCode: exit.exitCode,
      // For an exit reached through a local helper, the identity must say so —
      // otherwise `fatal()` and a bare `process.exit` in the same function
      // would collide.
      ...(exit.via ? { exitVia: exit.via } : {}),
      // The enclosing function's NAME, for the gate's site identity. A
      // file+shape+ordinal key alone could not tell a removed site from a
      // different one added elsewhere in the same file (round-1 audit H5/M3);
      // the function name is stable under edits above it, unlike a line number.
      fnName: functionNameOf(exit.path),
      // WHERE in the function, structurally — closes the same-shape swap
      // the function name alone could not see (round-2 audit H1/M1).
      structure: structuralPath(exit.path),
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
