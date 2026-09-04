/**
 * @fileoverview Shape recognisers for `find-stdout-exit-sites` — two questions
 * about WHAT a piece of syntax is, kept apart from the detector's control-flow
 * reasoning about whether a write can reach an exit.
 *
 * Split out when the parent crossed the repo's 1000-line cap. The boundary is a
 * real one rather than a line-count dodge: both functions are pure predicates
 * over a single node's own subtree, share no state with the detector, and take
 * no part in reachability. Neither imports anything, which is why this split —
 * unlike a first attempt that carved along the control-flow seam — introduces
 * no cycle and duplicates no constant. (That attempt copied `FUNCTION_TYPES`
 * into the new module, which would have been a single-oracle violation
 * committed in order to satisfy a size gate.)
 *
 * @module scripts/lib/find-stdout-exit-shapes
 */

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
export function isExactSmokeContract(ifPath) {
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
export function classifyPayload(writePath, how) {
  if (how === 'emit') return 'envelope';
  const isStringify = (n) => n?.type === 'CallExpression'
    && n.callee?.type === 'MemberExpression'
    && !n.callee.computed
    && n.callee.property?.type === 'Identifier' && n.callee.property.name === 'stringify'
    && n.callee.object?.type === 'Identifier' && n.callee.object.name === 'JSON';

  // One hop through a local binding: `const body = JSON.stringify(x);
  // process.stdout.write(body)` is an envelope, and inspecting only the
  // ARGUMENT's own AST called it text. Raised by the Gemini gate; 36
  // `= JSON.stringify` assignments exist under scripts/, so this was
  // understating the half of the census the paydown prioritises on.
  const holdsStringify = (argPath) => {
    if (argPath.node.type !== 'Identifier') return false;
    const b = argPath.scope.getBinding(argPath.node.name);
    if (!b) return false;
    if (b.path.node.type === 'VariableDeclarator') {
      const init = b.path.node.init;
      if (isStringify(init)) return true;
      let nested = false;
      if (init) b.path.get('init').traverse({ CallExpression(c) { if (isStringify(c.node)) nested = true; } });
      if (nested) return true;
    }
    return (b.constantViolations ?? []).some((v) => v.node?.type === 'AssignmentExpression'
      && isStringify(v.node.right));
  };

  let found = false;
  for (const argPath of writePath.get('arguments')) {
    if (found) break;
    if (isStringify(argPath.node) || holdsStringify(argPath)) { found = true; break; }
    argPath.traverse({
      CallExpression(c) { if (isStringify(c.node)) found = true; },
      Identifier(i) { if (!found && i.node !== argPath.node && holdsStringify(i)) found = true; },
    });
  }
  return found ? 'envelope' : 'text';
}
