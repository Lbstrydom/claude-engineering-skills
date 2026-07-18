/**
 * @fileoverview Containment-adjacency detector — the mechanical stage of the
 * adjacency audit wave. Given a change that landed INSIDE a conditional, it
 * enumerates that conditional's other top-level statements and classifies each
 * as genuinely condition-dependent or merely nested ("trapped").
 *
 * Plan: docs/plans/adjacency-check-containment.md (Cluster B, Phases 3-4).
 *
 * **Why this exists.** Three defects in two days shared one meta-failure: a fix
 * scoped to the instance that hurt, not the class. The decisive one —
 * `populateFindingMetadata` trapped inside `if (mergedLedger.entries.length > 0)`
 * — was never reported by ANY audit: 5 GPT rounds + 3 Gemini rounds across two
 * model families examined that exact file and found its *sibling* defect in the
 * same 139-line branch, but not one round asked **what else is in this branch**.
 * A hand-sweep found it in minutes. That is a question problem, not an attention
 * problem, so the fix is a mechanism rather than a prompt.
 *
 * **Enumeration is never the LLM's job.** Failing to enumerate is the
 * demonstrated failure mode, so this module is pure syntax with no model in the
 * loop — the same argument `efficacy-lints.mjs` makes for itself ("LLMs can't
 * reliably count tokens / trace coverage"). Against the real branch this rule
 * classifies exactly 1 of 6 top-level statements as independent, and that one is
 * the defect eight rounds missed. The LLM bouncer downstream only ever *judges*
 * what it is handed; it never decides what exists.
 *
 * **Known, deliberate limits** (stated, not silent):
 *   - `git diff <base>` does not include **untracked** files, so a brand-new
 *     file's conditionals are not analysed. Defensible for this wave's purpose:
 *     the trapped-statement class is about a *pre-existing* container you just
 *     changed inside — in a file you just wrote, you wrote all of it.
 *   - Containers are **conditionals only** (`IfStatement` branches), never
 *     functions — this is what bounds the whole design (a 600-line function is
 *     never enumerated), and never loops/`try`/`switch`, where "why is this
 *     nested?" has an obvious non-defect answer.
 *
 * @module scripts/lib/audit/adjacency-detector
 */

import fs from 'node:fs';
import path from 'node:path';
import _traverse from '@babel/traverse';

import { parseSource } from '../ast.mjs';
import { gitNumstatWithWorkingTree, gitUnifiedDiffWithWorkingTree, isSafeGitRevision } from '../vcs.mjs';
import { parseAllDiffSections, parseHunkHeader } from './evidence-triage.mjs';
import { resolveAndClassify } from '../sensitive-paths.mjs';
import { scanEgressPayload } from '../sensitive-egress-gate.mjs';
import { INCOMPLETENESS_KINDS } from './adjacency-state.mjs';

// @babel/traverse ships CJS; under ESM the callable lands on .default (and on
// .default.default via some interop paths). Normalise once, loudly.
const traverse = _traverse?.default?.default ?? _traverse?.default ?? _traverse;

/** Source extensions whose AST we can meaningfully walk. */
const SOURCE_EXT_RE = /\.(m?[jt]sx?|c[jt]s)$/;

function log(msg) { process.stderr.write(`  [adjacency] ${msg}\n`); }

/** Build the real (non-injected) adapter bundle. Separated so tests can override
 *  one piece without re-wiring the whole set — the duplication wave's shape. */
function defaultAdapters() {
  return {
    numstat: (cwd, rev) => gitNumstatWithWorkingTree(cwd, rev),
    unifiedDiff: (cwd, rev, opts) => gitUnifiedDiffWithWorkingTree(cwd, rev, opts),
    readFile: (p) => fs.readFileSync(p, 'utf-8'),
    statSize: (p) => fs.statSync(p).size,
    classifyPath: (p, repoRoot) => resolveAndClassify(p, { repoRoot }),
    scanPayload: (text) => scanEgressPayload(text),
  };
}

const incompleteness = (kind, scope, detail) => ({ kind, scope, detail });

/**
 * Map each diff hunk to the set of new-side lines it touches.
 *
 * **A hunk is a SET of anchors, not one.** A unified-diff hunk spans multiple
 * lines: edit an `if` condition AND add a statement in its body in one
 * contiguous hunk, and a single head-of-hunk anchor lands on the *condition* —
 * whereupon the test-expression exclusion discards the whole hunk and the body
 * change that actually landed inside the branch is never enumerated. So every
 * added/changed new-side line is an anchor, and the exclusion applies per
 * anchor. `--unified=0` makes this exact: with no context lines, a hunk's `+`
 * lines are precisely its changes.
 *
 * **A pure deletion has zero `+` lines and still has an anchor.** `@@ -a,b +c,0 @@`
 * contains no `+` lines at all, so an added-lines-only rule yields an empty set
 * and deletions are silently ignored — killing the very case the deletion
 * handling exists for. Fallback: the `+c` insertion position. That position is a
 * *claim*, honoured only if it demonstrably resolves inside a container in the
 * current parsed source (see `findEnclosingConditional`), never a trusted location.
 *
 * @param {string} diffText
 * @returns {{newPath:string, oldPath:string, fileStatus:string, anchorLines:number[]}[]}
 */
export function parseHunkTargets(diffText) {
  const out = [];
  for (const { section, fileStatus, oldPath, newPath } of parseAllDiffSections(diffText)) {
    const anchorLines = [];
    const lines = section.split('\n');
    let cursor = null;
    for (const line of lines) {
      const hunk = parseHunkHeader(line);
      if (hunk) {
        cursor = { next: hunk.headStart, added: [] , start: hunk.headStart, count: hunk.headCount };
        // A pure-deletion hunk (headCount === 0) contributes its insertion
        // anchor immediately — it will emit no `+` lines to collect.
        if (hunk.headCount === 0) anchorLines.push(hunk.headStart);
        continue;
      }
      if (!cursor) continue;
      if (line.startsWith('+') && !line.startsWith('+++')) {
        anchorLines.push(cursor.next);
        cursor.next += 1;
      }
      // With --unified=0 there are no context lines; a '-' line advances the
      // base side only, so the new-side cursor deliberately does not move.
    }
    if (anchorLines.length > 0) {
      out.push({ newPath, oldPath, fileStatus, anchorLines: [...new Set(anchorLines)].sort((a, b) => a - b) });
    }
  }
  return out;
}

/**
 * The nearest enclosing `IfStatement` **branch** containing `line`, or null.
 *
 * Uses `@babel/traverse` for the whole walk — container AND scope — because
 * Babel's `Scope`/`getBinding` API lives on `NodePath`, which only exists inside
 * a real `traverse()` run. An earlier design paired a hand-rolled ancestor-chain
 * walker with `path.scope` lookups; that is technically impossible (a raw node
 * carries no `.scope`), and using one traversal removes the custom machinery
 * rather than adding to it.
 *
 * Two normal AST forms are handled explicitly, because getting either wrong is a
 * silent recall failure:
 *   - **Unbraced branches** (`if (ok) doWork();`) — the branch is an
 *     `ExpressionStatement`, not a `BlockStatement`. A block-only implementation
 *     skips every single-statement branch. Such a branch can never yield a
 *     "what else is here?" finding, but it must resolve as a *container* so the
 *     coverage counts stay honest.
 *   - **A hunk in the `test` expression** — editing `if (x > 0)` on its own line
 *     is not a change *inside* the branch, and enumerating the body would be a
 *     false trigger. A line inside `test`'s span resolves to null.
 *
 * @param {object} ast
 * @param {number} line - 1-indexed
 * @returns {{ifPath:object, conditionNode:object, branchPath:object, branchKind:'consequent'|'alternate'}|null}
 */
export function findEnclosingConditional(ast, line) {
  let best = null;
  traverse(ast, {
    IfStatement(p) {
      const testLoc = p.node.test?.loc;
      const inTest = testLoc && line >= testLoc.start.line && line <= testLoc.end.line;

      for (const kind of ['consequent', 'alternate']) {
        const branch = p.node[kind];
        if (!branch?.loc) continue;
        // An `else if` chain: the alternate is another IfStatement, which this
        // same visitor handles on its own. Don't claim it here, or every
        // `else if` body would resolve to the outermost `if`.
        if (kind === 'alternate' && branch.type === 'IfStatement') continue;

        const { start, end } = branch.loc;
        const isBlock = branch.type === 'BlockStatement';
        // For a BRACED block the opening-brace line belongs to the condition
        // (`if (cond) {`), so a change there is a condition edit, not a change
        // to a statement inside — start containment one line lower. This is
        // also what makes the test-expression exclusion automatic for the
        // common case, rather than a second rule that can disagree with it.
        //
        // For an UNBRACED branch (`if (ok) doWork();`) the whole statement can
        // share one line with the test. Diff anchors are line-granular, so we
        // cannot tell condition from body there; we resolve toward the branch,
        // because such a branch holds exactly one statement and therefore can
        // never produce a "what else is in here?" finding — enumerating it is
        // harmless, while skipping it silently loses a container and understates
        // coverage.
        // …but only when the block genuinely spans lines. A single-line block
        // (`else { y(); }`) keeps its content ON the brace line, so the +1 rule
        // would exclude the only line it has — the same one-line ambiguity as
        // the unbraced form, and resolved the same way.
        const isMultiLineBlock = isBlock && end.line > start.line;
        const lo = isMultiLineBlock ? start.line + 1 : start.line;
        if (line < lo || line > end.line) continue;
        if (inTest && isMultiLineBlock) continue;

        const span = end.line - start.line;
        // NEAREST wins: the tightest enclosing branch, so a hunk in a nested
        // `if` resolves to the inner one, not its parent.
        if (!best || span < best.span) {
          best = { ifPath: p, conditionNode: p.node.test, branchPath: p.get(kind), branchKind: kind, span };
        }
      }
    },
  });
  if (!best) return null;
  const { span, ...rest } = best;
  return rest;
}

/**
 * The branch's TOP-LEVEL statements only — never recursing into nested blocks.
 * An unbraced branch normalises to a single-element list.
 * @param {object} branchPath - a NodePath for the consequent/alternate
 * @returns {object[]} NodePaths
 */
export function enumerateBlockStatements(branchPath) {
  if (!branchPath?.node) return [];
  if (branchPath.node.type === 'BlockStatement') {
    const body = branchPath.get('body');
    return Array.isArray(body) ? body : [body];
  }
  // Unbraced single-statement branch — a container with exactly one statement.
  return [branchPath];
}

/** Identifier names read (not merely declared) by this statement, with where
 *  each one's binding lives. Property keys, labels, and declaration ids are
 *  excluded by Babel's own reference resolution — which is exactly why this
 *  uses the binding resolver rather than a hand-rolled identifier sweep. */
export function collectReadBindings(statementPath) {
  const found = new Map();
  const consider = (name, refPath) => {
    if (found.has(name)) return;
    const binding = refPath.scope.getBinding(name);
    found.set(name, { name, binding: binding ?? null });
  };
  if (statementPath.isIdentifier?.() && statementPath.isReferencedIdentifier?.()) {
    consider(statementPath.node.name, statementPath);
  }
  statementPath.traverse({
    ReferencedIdentifier(p) { consider(p.node.name, p); },
  });
  return [...found.values()];
}

/**
 * Classify one top-level statement of a conditional branch.
 *
 *  - `references-condition`  — reads a binding the condition itself reads.
 *                              Genuinely condition-dependent by definition.
 *  - `consumes-in-branch`    — reads a binding DECLARED INSIDE this branch.
 *                              Ambiguous; needs semantic judgement.
 *  - `independent`           — reads neither. Mechanically a candidate for
 *                              "merely nested".
 *
 * A binding declared earlier in the branch counts ONLY if this statement
 * actually reads it — mere textual precedence is not dependence. `var` is
 * function-scoped, so a `var` declared in-branch is NOT an in-branch binding;
 * Babel's `binding.scope` gives that distinction for free rather than by a
 * hand-written rule, and real code in this repo already depends on it.
 */
/** Control-flow terminators. A branch containing one IS a guard clause: the
 *  statement's whole meaning is "when the condition holds, leave". It can never
 *  be trapped, because hoisting it out would change control flow rather than
 *  relocate a computation. Found by running this detector against its own
 *  freshly-written code, where `if (!m) continue;` and
 *  `if (n < min) { warn(…); return min; }` were the only two candidates — both
 *  false positives of exactly this shape. */
const CONTROL_FLOW_TYPES = new Set(['ReturnStatement', 'ContinueStatement', 'BreakStatement', 'ThrowStatement']);

export function classifyStatementDependence(statementPath, { conditionNode, branchPath }) {
  // A guard clause's terminator is condition-dependent by construction.
  if (CONTROL_FLOW_TYPES.has(statementPath.node?.type)) return 'references-condition';
  const conditionNames = new Set();
  if (conditionNode) {
    const seed = branchPath.getStatementParent?.() ?? branchPath;
    try {
      // Collect identifiers appearing in the condition expression.
      const stack = [conditionNode];
      while (stack.length) {
        const n = stack.pop();
        if (!n || typeof n.type !== 'string') continue;
        if (n.type === 'Identifier') conditionNames.add(n.name);
        for (const k of Object.keys(n)) {
          if (k === 'loc' || k === 'start' || k === 'end') continue;
          const c = n[k];
          if (Array.isArray(c)) stack.push(...c);
          else if (c && typeof c.type === 'string') stack.push(c);
        }
      }
    } catch { /* condition shape is advisory only */ }
    void seed;
  }

  const reads = collectReadBindings(statementPath);
  const branchNode = branchPath.node;
  const stmtLoc = statementPath.node?.loc;

  const inBranch = (binding) => {
    const p = binding?.path;
    if (!p?.node?.loc || !branchNode?.loc) return false;
    // `var` hoists to the function scope — a `var` declared textually inside
    // the branch is NOT an in-branch binding.
    if (binding.kind === 'var' || binding.kind === 'hoisted') return false;
    const b = p.node.loc, br = branchNode.loc;
    const insideBranch = b.start.line >= br.start.line && b.end.line <= br.end.line;
    if (!insideBranch) return false;

    // ── A statement's OWN bindings are not branch dependencies. ──
    // Found by running this detector against the real historical branch: the
    // `for (const f of allFindings) populateFindingMetadata(f, …)` loop — the
    // WS-C defect this entire wave exists to find — was classified
    // `consumes-in-branch` purely because it declares its own loop variable `f`
    // and then reads it. Depending on a local you introduced yourself is not
    // depending on the branch; counting it that way makes every loop and every
    // statement with a local look condition-dependent, which is precisely the
    // false-negative direction that hides trapped statements.
    if (stmtLoc && b.start.line >= stmtLoc.start.line && b.end.line <= stmtLoc.end.line) return false;

    return true;
  };

  for (const r of reads) {
    if (conditionNames.has(r.name)) return 'references-condition';
  }
  for (const r of reads) {
    if (r.binding && inBranch(r.binding)) return 'consumes-in-branch';
  }

  // ── PRODUCES-FOR-BRANCH: a declaration whose binding is consumed by a later
  //    statement inside this branch is branch machinery, not a trapped statement.
  //    Found by running against the real branch: `const debtEvents = []`,
  //    `const surfacedTopics = new Map()`, `let fpSuppressed = []` and three
  //    siblings all read nothing in-branch, so the read-only rule called them
  //    independent — 6 of 11 candidates were this one shape. They are the
  //    *setup half* of in-branch machinery; hoisting them out would be
  //    meaningless. Babel already computed `referencePaths`, so this costs
  //    nothing and removes the largest false-positive class mechanically
  //    instead of spending an LLM call on it.
  if (branchNode?.loc && stmtLoc) {
    const declared = statementPath.getOuterBindingIdentifiers
      ? Object.keys(statementPath.getOuterBindingIdentifiers())
      : [];
    for (const name of declared) {
      const binding = statementPath.scope.getBinding(name);
      if (!binding) continue;
      for (const ref of binding.referencePaths ?? []) {
        const rLoc = ref.node?.loc;
        if (!rLoc) continue;
        const insideBranch = rLoc.start.line >= branchNode.loc.start.line && rLoc.end.line <= branchNode.loc.end.line;
        const insideSelf = rLoc.start.line >= stmtLoc.start.line && rLoc.end.line <= stmtLoc.end.line;
        if (insideBranch && !insideSelf) return 'produces-for-branch';
      }
    }
  }

  return 'independent';
}

/**
 * Run the mechanical adjacency analysis.
 *
 * Returns **FACTS, not a state** — `buildAdjacencyState` is called exactly once,
 * later, by `adjacency-compose.mjs`, over facts merged from every stage.
 * Incompleteness also arises in formatting/egress and bouncer stages that run
 * after this function returns, so a state computed here would be stale by
 * construction and could contradict the very invariants it asserts.
 *
 * @returns {Promise<{coverage:{containersEnumerated:number,statementsJudged:number},
 *   candidates:object[], incompleteness:object[], threw:string|null}>}
 */
export async function runAdjacencyAnalysis({ repoRoot, auditBaseCommit, bounds, adapters } = {}) {
  const a = { ...defaultAdapters(), ...(adapters || {}) };
  const inc = [];
  const candidates = [];
  let containersEnumerated = 0;
  let statementsJudged = 0;
  const done = (threw = null) => ({
    coverage: { containersEnumerated, statementsJudged },
    candidates,
    incompleteness: inc,
    threw,
  });

  try {
    if (!auditBaseCommit || !isSafeGitRevision(auditBaseCommit)) {
      inc.push(incompleteness(INCOMPLETENESS_KINDS.INPUT_BOUND, 'diff', 'no safe auditBaseCommit resolved'));
      return done();
    }

    // ── Preflight BEFORE materialising the diff (a bound applied after the
    //    cost is incurred is not a bound). ──
    const ns = a.numstat(repoRoot, auditBaseCommit);
    if (!ns.ok) {
      inc.push(incompleteness(INCOMPLETENESS_KINDS.INPUT_BOUND, 'diff', `numstat failed: ${ns.error.code}`));
      return done();
    }
    if (ns.files.length > bounds.maxChangedFiles) {
      inc.push(incompleteness(INCOMPLETENESS_KINDS.INPUT_BOUND, 'diff',
        `${ns.files.length} changed files exceeds maxChangedFiles=${bounds.maxChangedFiles} — adjacency not enumerated`));
      return done();
    }
    if (ns.totalChangedLines > bounds.maxChangedLines) {
      inc.push(incompleteness(INCOMPLETENESS_KINDS.INPUT_BOUND, 'diff',
        `${ns.totalChangedLines} changed lines exceeds maxChangedLines=${bounds.maxChangedLines} — adjacency not enumerated`));
      return done();
    }

    const ud = a.unifiedDiff(repoRoot, auditBaseCommit, { maxBytes: bounds.maxDiffBytes });
    if (!ud.ok) {
      inc.push(incompleteness(INCOMPLETENESS_KINDS.INPUT_BOUND, 'diff', `unified diff failed: ${ud.error.code}`));
      return done();
    }

    const targets = parseHunkTargets(ud.diffText).filter((t) => SOURCE_EXT_RE.test(t.newPath));
    if (targets.length === 0) return done();

    const seenContainers = new Set();

    for (const target of targets) {
      if (containersEnumerated >= bounds.maxContainers) {
        inc.push(incompleteness(INCOMPLETENESS_KINDS.ENUMERATION_BOUND, target.newPath,
          `maxContainers=${bounds.maxContainers} reached — remaining files not enumerated`));
        break;
      }

      const gate = a.classifyPath(target.newPath, repoRoot);
      if (gate?.category === 'sensitive') continue; // never read, never reported

      const abs = path.join(repoRoot, target.newPath);
      let size = 0;
      try { size = a.statSize(abs); } catch { continue; } // vanished/untracked — nothing to analyse
      if (size > bounds.maxSourceFileBytes) {
        inc.push(incompleteness(INCOMPLETENESS_KINDS.INPUT_BOUND, target.newPath,
          `file ${size}B exceeds maxSourceFileBytes=${bounds.maxSourceFileBytes} — not parsed`));
        continue;
      }

      // ── ONE read. Reused for parse AND excerpt, so the two can never disagree. ──
      let text;
      try { text = a.readFile(abs); } catch { continue; }

      const { ast, error, recoveredErrors } = parseSource(text);
      if (!ast) {
        inc.push(incompleteness(INCOMPLETENESS_KINDS.PARSE_FAILURE, target.newPath, `unparseable: ${error}`));
        continue;
      }
      if (recoveredErrors.length > 0) {
        // A recovered parse is a PARTIAL tree. Enumerating it could miss
        // statements and report a false clean — the exact vacuous green this
        // wave exists to prevent, so it is incompleteness, not a clean pass.
        inc.push(incompleteness(INCOMPLETENESS_KINDS.PARSE_FAILURE, target.newPath,
          `partial parse (${recoveredErrors.length} recovered diagnostic(s)) — tree may be truncated`));
        continue;
      }

      for (const line of target.anchorLines) {
        const found = findEnclosingConditional(ast, line);
        if (!found) continue; // function-body level, or an unhonoured deletion anchor

        const { ifPath, conditionNode, branchPath, branchKind } = found;
        const loc = ifPath.node.loc;
        const key = `${target.newPath}:${loc.start.line}-${loc.end.line}:${branchKind}`;
        if (seenContainers.has(key)) continue; // one container, however many anchors hit it
        seenContainers.add(key);
        containersEnumerated += 1;

        const statements = enumerateBlockStatements(branchPath);
        if (statements.length > bounds.maxStatementsPerContainer) {
          inc.push(incompleteness(INCOMPLETENESS_KINDS.ENUMERATION_BOUND, target.newPath,
            `container at ${target.newPath}:${loc.start.line} has ${statements.length} statements, ` +
            `exceeds maxStatementsPerContainer=${bounds.maxStatementsPerContainer} — not judged`));
          continue;
        }

        for (const stmtPath of statements) {
          statementsJudged += 1;
          const dependence = classifyStatementDependence(stmtPath, { conditionNode, branchPath });
          if (dependence !== 'independent') continue;
          if (candidates.length >= bounds.maxCandidates) {
            inc.push(incompleteness(INCOMPLETENESS_KINDS.ENUMERATION_BOUND, target.newPath,
              `maxCandidates=${bounds.maxCandidates} reached — further candidates not reported`));
            break;
          }

          const sLoc = stmtPath.node.loc;
          const statementText = sliceLines(text, sLoc.start.line, sLoc.end.line, bounds.maxExcerptChars);
          const conditionText = conditionNode?.loc
            ? sliceLines(text, conditionNode.loc.start.line, conditionNode.loc.end.line, 400)
            : '';

          // ── Egress scan at CONSTRUCTION, not at formatting. ──
          // Unsafe text is never placed in the carrier at all, so no raw secret
          // can reach the composed result, the pass cache, or the --out JSON.
          // Refusal stays VISIBLE as an incompleteness record.
          const { safe } = a.scanPayload(`${statementText}\n${conditionText}`);
          const payload = safe
            ? { safe: true, statementText, conditionText }
            : { safe: false, reason: 'payload-tripped-egress-scan' };
          if (!safe) {
            inc.push(incompleteness(INCOMPLETENESS_KINDS.EXCERPT_UNRESOLVABLE, target.newPath,
              `statement at ${target.newPath}:${sLoc.start.line} withheld — content tripped the egress scan`));
          }

          candidates.push({
            id: `adj-${target.newPath.replace(/[^\w]/g, '_')}-${sLoc.start.line}`,
            canonicalPath: target.newPath,
            egressClassification: { category: gate?.category ?? null },
            span: { startLine: sLoc.start.line, endLine: sLoc.end.line },
            conditionSpan: conditionNode?.loc
              ? { startLine: conditionNode.loc.start.line, endLine: conditionNode.loc.end.line }
              : null,
            containerLine: loc.start.line,
            payload,
            dependence,
          });
        }
      }
    }

    return done();
  } catch (err) {
    log(`failed: ${err.stack || err.message}`);
    return done('ADJACENCY_DETECTOR_FAILED');
  }
}

/** 1-indexed inclusive line slice, bounded. */
function sliceLines(text, startLine, endLine, maxChars) {
  const lines = text.split('\n');
  const from = Math.max(0, startLine - 1);
  const to = Math.min(lines.length, endLine);
  const out = lines.slice(from, to).join('\n');
  return out.length > maxChars ? `${out.slice(0, maxChars)}\n/* … truncated (${out.length}B) … */` : out;
}

export const _internals = Object.freeze({ sliceLines, SOURCE_EXT_RE });
