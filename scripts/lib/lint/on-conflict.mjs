/**
 * @fileoverview Mechanical lint for a recurring, expensive defect class in the
 * cloud store's write path: **the ON CONFLICT target and the row's real
 * identity disagree.** Three field instances motivated it, all "conflict
 * target ≠ stored identity":
 *
 *   1. `false_positive_patterns` — `repo_id` written as `repoId || null` while
 *      `repo_id` was IN the conflict target. Postgres treats NULLs as DISTINCT,
 *      so a null-repo row never matched its own conflict key → the upsert
 *      degraded to an insert every run → 403k duplicate rows, Disk-IO budget
 *      depleted (fixed: 718ca90 + migration 20260717120000).
 *   2. `bandit_arms` — same shape: `context_bucket || null` in its own conflict
 *      target (fixed: migration 20260718090000).
 *   3. `prompt_variants` (`upsertPromptVariant`) — the mirror image: `repo_id`
 *      is STORED on the row but OMITTED from the conflict target
 *      `['pass_name','variant_name']`, so one repo's row would silently
 *      overwrite another's on a shared DSN.
 *
 * Two gating rules, each proven by a real instance — no rule without a
 * requirement (AGENTS.md right-sizing):
 *
 *   - **nullable-conflict-key** (instances 1, 2): a column IN the conflict
 *     target whose written value can be null (`x || null`, `x ?? null`, literal
 *     `null`/`undefined`, or a nullable conditional). NULLs are DISTINCT → the
 *     upsert can never match → unbounded duplicate rows.
 *   - **omitted-scope-identity** (instance 3): a tenancy/scope column
 *     (`repo_id`/`user_id`/`repo_name`) written on the row but absent from a
 *     DO-UPDATE/DO-NOTHING conflict target → cross-tenant overwrite or lost row.
 *
 * **A third, honest state for the nullability axis.** `isNullableExpr` used to
 * answer a three-valued question ("can this be null?") with a boolean — every
 * shape it did not recognise (a bare identifier, a member read, an awaited
 * call) fell through to `false`, silently treated as "definitely non-null"
 * exactly like a proven-safe literal. `classifyNullability`/`classifyColumnValue`
 * (below) replace it with a `'nullable' | 'non-null' | 'unknown' | 'opaque'`
 * lattice: an `unknown` conflict-target column value emits a
 * `unresolved-conflict-key-nullability` **diagnostic** (not a gating finding —
 * "I can't decide" is not "you have a bug"), routed through the same
 * `@on-conflict-ok` pragma as findings. The scope is deliberate: only a
 * fallback expression (`a || b` / `a ? b : c`) whose default branch isn't a
 * literal is `unknown`; a bare column read stays the quiet `opaque` state,
 * because flagging every one of the 74 such writes in the live store would be
 * a permanently-red strict gate for a shape none of the three real defect
 * instances exhibited (all three were explicit `|| null` fallbacks). See
 * docs/plans/refactor-static-analysis.md §2.2 for the full census that decided
 * this boundary.
 *
 * **Honesty over coverage.** Instances 1 and 2 lived INSIDE builder functions
 * (`buildBanditArmRows`, `buildFpPatternRows`), not inline literals — so a lint
 * that only read inline `[{...}]` would report "store clean" while structurally
 * blind to exactly where the worst instance lived. The extractor therefore
 * resolves a row argument through one level of local builder-function or
 * const-binding indirection AND through `.map()` callbacks. A call site it
 * CANNOT resolve is reported as an `unresolved-upsert-rows` **diagnostic**, never
 * silently treated as clean (the vacuous-green trap this repo names repeatedly).
 * The standing gate is the test asserting the live store tree has zero findings
 * AND zero unresolved sites — so a future upsert shape the lint can't read turns
 * that test red instead of passing blind.
 *
 * Pure-core + AST-shell, mirroring `buildFpPatternRows` (pure) + its sync shell:
 * `analyzeUpsert` is a pure function over already-extracted data (all instances
 * are DB-free fixtures against it); `extractUpsertSites` is the Babel extractor
 * that feeds it. No DB, no network.
 *
 * @module scripts/lib/lint/on-conflict
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSource } from '../ast.mjs';

/** Tenancy/scope columns whose omission from a conflict target is a
 *  cross-scope-overwrite bug. Deliberately small + explicit — a broad
 *  "any *_id" heuristic would false-flag legitimate non-scope keys. */
export const SCOPE_COLUMNS = new Set(['repo_id', 'user_id', 'repo_name']);

/** The db-layer helper whose calls we analyze. Single helper today
 *  (`upsert(table, rows, opts)`); a new upsert wrapper must be added here or
 *  its call sites are invisible (and the live-tree test won't cover them). */
const UPSERT_CALLEES = new Set(['upsert']);

/**
 * The pure heart: given one already-extracted upsert site, return its findings
 * and diagnostics. Everything here is plain data — the entire instance matrix
 * is tested against this function with no AST and no DB.
 *
 * @param {object} site
 * @param {string} site.table            - table name (or '<dynamic>')
 * @param {string[]} site.columns        - top-level columns written on the row
 * @param {Record<string,{nullability:'nullable'|'non-null'|'unknown'|'opaque'}>} site.columnExprs - per-column value facts
 * @param {string[]|null} site.conflictTarget - normalized onConflict columns, or null (plain insert / unresolved)
 * @param {boolean} [site.hasSpread]      - row object contains a spread (columns may be incomplete)
 * @param {number} [site.line]            - the upsert call's start line
 * @param {number} [site.endLine]         - the upsert call's end line (for drift range)
 * @param {string} [site.callId]          - `${start}:${end}` byte span of the upsert CallExpression, for diagnostic identity
 * @returns {{findings: Array<{rule:string, table:string, column:string, line:number, endLine:number, message:string}>, diagnostics: Array<{kind:string, table:string, column:string, line:number, endLine:number, callId:string, message:string}>}}
 */
export function analyzeUpsert(site) {
  const { table = '<dynamic>', columns = [], columnExprs = {}, conflictTarget, hasSpread = false, line = 0, endLine = line, callId = null } = site;
  const findings = [];
  const diagnostics = [];
  const at = { table, line, endLine };

  // A plain insert (no onConflict) has no upsert identity — neither rule applies.
  if (!Array.isArray(conflictTarget) || conflictTarget.length === 0) return { findings, diagnostics };

  const targetSet = new Set(conflictTarget);

  // Rule 1 — nullable-conflict-key (instances 1, 2). Sound even with a spread:
  // a spread cannot make an EXPLICITLY nullable conflict-key column non-nullable.
  // A definite 'nullable' always wins over 'unknown' — a provable finding must
  // never be downgraded to a non-gating diagnostic.
  for (const col of conflictTarget) {
    const nullability = columnExprs[col]?.nullability;
    if (nullability === 'nullable') {
      findings.push({
        ...at,
        rule: 'nullable-conflict-key',
        column: col,
        message: `conflict-target column "${col}" is written with a nullable value — NULLs are DISTINCT in a unique index, so the upsert can never match and degrades to unbounded INSERTs (the 403k-row / bandit_arms class). Guarantee it non-null on this path (see isSyncableRepoId / a sentinel default).`,
      });
    } else if (nullability === 'unknown') {
      diagnostics.push({
        kind: 'unresolved-conflict-key-nullability',
        table, line, endLine, callId,
        column: col,
        message: `conflict-target column "${col}" is written with a fallback expression this lint cannot classify as null-safe (the default branch isn't a literal) — verify by hand that it can never be null, or add "// @on-conflict-ok(${col}): <reason>" once confirmed.`,
      });
    }
  }

  // Rule 2 — omitted-scope-identity (instance 3). An EXPLICITLY-written scope
  // column omitted from the target is provably stored AND provably omitted — a
  // real finding whether or not the row also has a spread (audit R2-H1: the R1
  // fix over-suppressed these). A spread only creates uncertainty about scope
  // columns we CAN'T see (columns supplied entirely by the spread) — that gap is
  // surfaced separately by lintSource's `indeterminate-row` diagnostic, not by
  // hiding the provable omissions.
  for (const col of columns) {
    if (SCOPE_COLUMNS.has(col) && !targetSet.has(col)) {
      findings.push({
        ...at,
        rule: 'omitted-scope-identity',
        column: col,
        message: `scope column "${col}" is stored on the row but absent from the conflict target [${conflictTarget.join(', ')}] — one scope's row will silently overwrite (DO UPDATE) or drop (DO NOTHING) another's. Add "${col}" to the conflict target AND its backing unique constraint (verify pg_constraint — a missing constraint makes ON CONFLICT throw, not overwrite).`,
      });
    }
  }
  return { findings, diagnostics };
}

// ── AST extraction ─────────────────────────────────────────────────────────

/** A literal (of any of these types) can never be null/undefined. */
const NON_NULL_LITERAL_TYPES = new Set([
  'StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'BigIntLiteral',
  'TemplateLiteral', 'ObjectExpression', 'ArrayExpression', 'NewExpression',
]);

/**
 * Layer 1 (docs/plans/refactor-static-analysis.md §2.2.1) — classify a
 * value-expression node's nullability. Three values; **never** returns
 * `'unknown'` (that value is minted by `classifyColumnValue` alone, at the
 * root-eligibility layer). A dynamic read — a bare `Identifier`,
 * `MemberExpression`, `CallExpression`, `AwaitExpression`, … — is `'opaque'`:
 * the fix this replaces `isNullableExpr` for is exactly that such a read is
 * NOT evidence of non-nullity, unlike a literal.
 *
 * Precedence: a provable `'nullable'` always wins over `'opaque'` in the two
 * compound (`&&`, `?:`) arms below — a definite finding must never be
 * downgraded to a non-gating diagnostic.
 *
 * @param {object} node
 * @returns {'nullable'|'non-null'|'opaque'}
 */
export function classifyNullability(node) {
  if (!node || typeof node.type !== 'string') return 'opaque';
  if (node.type === 'NullLiteral') return 'nullable';
  if (node.type === 'Identifier' && node.name === 'undefined') return 'nullable';
  if (NON_NULL_LITERAL_TYPES.has(node.type)) return 'non-null';
  if (node.type === 'LogicalExpression') {
    if (node.operator === '&&') {
      // `a && b` evaluates to `a` when `a` is falsy (so `null && x` IS null) and
      // to `b` otherwise — nullable if EITHER operand is. This is a deliberate
      // OVER-approximation: `false && null` / `0 && null` actually evaluate to
      // the falsy-but-non-null left, yet we report them nullable. That's the
      // SAFE direction for a safety gate (a false-positive `nullable`, which
      // drift + the pragma absorb, never a missed real one), and the excluded
      // case — a literal-falsy left `&&` a value, as a DB column — does not occur.
      const left = classifyNullability(node.left);
      const right = classifyNullability(node.right);
      if (left === 'nullable' || right === 'nullable') return 'nullable';
      if (left === 'opaque' || right === 'opaque') return 'opaque';
      return 'non-null';
    }
    // `a || b` / `a ?? b` return the fallback `b` whenever `a` is absent, so
    // `a`'s class is irrelevant — the fallback alone decides the result.
    return classifyNullability(node.right);
  }
  if (node.type === 'ConditionalExpression') {
    const cons = classifyNullability(node.consequent);
    const alt = classifyNullability(node.alternate);
    if (cons === 'nullable' || alt === 'nullable') return 'nullable';
    if (cons === 'opaque' || alt === 'opaque') return 'opaque';
    return 'non-null';
  }
  return 'opaque';
}

/**
 * Layer 2 — Layer 1 plus the root-kind reporting-eligibility gate
 * (docs/plans/refactor-static-analysis.md §2.2.1). Only the ROOT node of a
 * conflict-target column's value is consulted here; recursion never emits —
 * `classifyNullability` already did the recursive walk.
 *
 * `'unknown'` is minted ONLY for an `'opaque'` root whose node kind is a
 * `LogicalExpression` or `ConditionalExpression` (a fallback whose default
 * branch this lint couldn't classify) — never for a bare read (`refreshId`,
 * `row.importerPath`), which stays the quiet `'opaque'`. Relabelling a bare
 * read as `'non-null'` to keep it quiet would be exactly the laundering this
 * module's honesty doctrine exists to remove one layer down; `'opaque'` stays
 * an honest "undecidable, and out of this rule's declared scope."
 *
 * @param {object} node
 * @returns {'nullable'|'non-null'|'unknown'|'opaque'}
 */
export function classifyColumnValue(node) {
  const layer1 = classifyNullability(node);
  if (layer1 !== 'opaque') return layer1;
  if (node?.type === 'LogicalExpression' || node?.type === 'ConditionalExpression') return 'unknown';
  return 'opaque';
}

/** Precise, not heuristic: only the shapes the instances actually use. `a ||
 *  null`, `a ?? null`, literal `null`/`undefined`, or a conditional with a
 *  nullable branch. Crucially `arm.contextBucket || GLOBAL_CONTEXT_BUCKET` is
 *  NOT nullable (right side is a non-null identifier) — so the FIXED bandit
 *  builder is not false-flagged, while the pre-fix `|| null` is.
 *
 *  Kept as a thin boolean projection of `classifyNullability` for existing
 *  callers/tests (#18 backward compat) — behaviour is byte-identical, since
 *  the new `'opaque'` value is only distinguishable from `'non-null'` above
 *  this wrapper. */
export function isNullableExpr(node) {
  return classifyNullability(node) === 'nullable';
}

/** Normalize an `onConflict` value node into a column-name array, or null when
 *  it isn't a static string / string[] we can read. */
function readConflictTarget(node) {
  if (!node) return null;
  if (node.type === 'StringLiteral') return [node.value];
  if (node.type === 'ArrayExpression') {
    const cols = [];
    for (const el of node.elements) {
      if (el?.type === 'StringLiteral') cols.push(el.value);
      else return null; // a non-literal element → can't read the target statically
    }
    return cols;
  }
  return null; // Identifier / ternary (e.g. plans-ship's `isCandidate ? [...] : [...]`) → unresolved
}

/** Pull `{columns, columnExprs, hasSpread}` from an ObjectExpression row.
 *  Uses `classifyColumnValue` (not `classifyNullability`) — this is the
 *  component that still has the AST, so it's where the root-eligibility
 *  layer must run; `analyzeUpsert` is deliberately AST-free and does a pure
 *  lookup on the stored `nullability` value. */
function readRowObject(objExpr) {
  const columns = [];
  const columnExprs = {};
  let hasSpread = false;
  for (const prop of objExpr.properties || []) {
    if (prop.type === 'SpreadElement' || prop.type === 'SpreadProperty') { hasSpread = true; continue; }
    if (prop.type !== 'ObjectProperty' && prop.type !== 'Property') continue;
    if (prop.computed) { hasSpread = true; continue; } // a computed key is an unknown column
    const key = prop.key;
    const name = key?.type === 'Identifier' ? key.name : key?.type === 'StringLiteral' ? key.value : null;
    if (name == null) continue;
    columns.push(name);
    columnExprs[name] = { nullability: classifyColumnValue(prop.value) };
  }
  return { columns, columnExprs, hasSpread };
}

/** Extract the row ObjectExpression a callback returns (implicit `x => ({...})`
 *  or a block body with `return {...}`). */
function rowObjectFromCallback(cb, scope, depth = 0) {
  if (!cb) return null;
  const body = cb.body;
  if (!body) return null;
  if (body.type === 'ObjectExpression') return body; // arrow implicit-return
  if (body.type === 'BlockStatement') {
    for (const stmt of body.body || []) {
      if (stmt.type === 'ReturnStatement' && stmt.argument) {
        const found = resolveRowObject(stmt.argument, scope, depth + 1);
        if (found) return found;
      }
    }
  }
  return null;
}

/**
 * Resolve a `rows` argument node to the ObjectExpression describing one row,
 * following bounded intra-file indirection: array literals, `.map()` callbacks,
 * local const bindings, and local builder-function calls. `scope` is a resolver
 * `{getFunction(name), getBinding(name)}` searching the enclosing scope chain
 * innermost-first (a `const rows = buildRows(...)` is a *function-local* binding,
 * not module-level). Returns the ObjectExpression or null (→ unresolved).
 */
function resolveRowObject(node, scope, depth = 0) {
  if (!node || depth > 6) return null;
  switch (node.type) {
    case 'ObjectExpression':
      return node;
    case 'ArrayExpression': {
      // `[{...}]` or `[buildRow(x)]` — inspect the first element.
      const first = (node.elements || [])[0];
      return first ? resolveRowObject(first, scope, depth + 1) : null;
    }
    case 'CallExpression': {
      const callee = node.callee;
      // `xs.map(cb)` — the row is what the callback returns.
      if (callee?.type === 'MemberExpression' && callee.property?.name === 'map') {
        return rowObjectFromCallback(node.arguments?.[0], scope, depth + 1);
      }
      // `chunk(rows, N)` — the store's batched-write helper. A chunk's element
      // is a sub-array of `rows`, so the row shape is `rows`'s row shape.
      if (callee?.type === 'Identifier' && ARRAY_PASSTHROUGH_FNS.has(callee.name)) {
        return resolveRowObject(node.arguments?.[0], scope, depth + 1);
      }
      // `buildRows(args)` — a local builder function.
      const fn = callee?.type === 'Identifier' ? scope?.getFunction(callee.name) : null;
      if (fn) return rowObjectFromFunction(fn, scope, depth + 1);
      return null;
    }
    case 'Identifier': {
      // `const rows = <expr>` OR a `for (const slice of <iterable>)` binding.
      const init = scope?.getBinding(node.name);
      if (init && init.__iterOf) return resolveRowObject(init.__iterOf, scope, depth + 1);
      if (init) return resolveRowObject(init, scope, depth + 1);
      return null;
    }
    default:
      return null;
  }
}

/** Find the row ObjectExpression a builder function returns. */
function rowObjectFromFunction(fnNode, scope, depth) {
  const body = fnNode?.body;
  if (!body) return null;
  // Arrow with an expression body: `const build = (x) => xs.map(...)`.
  if (body.type !== 'BlockStatement') return resolveRowObject(body, scope, depth + 1);
  for (const stmt of body.body || []) {
    if (stmt.type === 'ReturnStatement' && stmt.argument) {
      const found = resolveRowObject(stmt.argument, scope, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/** Array helpers that pass their first-arg's row shape through unchanged, so
 *  `upsert('t', chunk(rows, N)[i])` resolves to `rows`'s row. Deliberately tiny
 *  (only `chunk`, the store's batching helper) — a broad list would resolve
 *  through transforms that CHANGE the row shape and mis-report columns. */
const ARRAY_PASSTHROUGH_FNS = new Set(['chunk']);

/** Record a `const/let NAME = init` or `function NAME` declaration into a frame,
 *  routing function-valued initializers to `functions` (so a builder bound to a
 *  const is still callable) and everything else to `bindings`. */
function recordDeclaration(node, frame) {
  let decl = node;
  if (node.type === 'ExportNamedDeclaration' && node.declaration) decl = node.declaration;
  if (decl.type === 'FunctionDeclaration' && decl.id) {
    frame.functions.set(decl.id.name, decl);
  } else if (decl.type === 'VariableDeclaration') {
    for (const d of decl.declarations) {
      if (d.id?.type !== 'Identifier' || !d.init) continue;
      if (FUNCTION_TYPES.has(d.init.type)) frame.functions.set(d.id.name, d.init);
      else frame.bindings.set(d.id.name, d.init);
    }
  } else if ((decl.type === 'ForOfStatement' || decl.type === 'ForInStatement') && decl.right) {
    // `for (const slice of chunk(rows, N))` — bind `slice` to an element-of
    // marker so a `upsert('t', slice, …)` resolves through to the row shape.
    const left = decl.left;
    const id = left?.type === 'VariableDeclaration' ? left.declarations?.[0]?.id : left;
    if (id?.type === 'Identifier') frame.bindings.set(id.name, { __iterOf: decl.right });
  }
}

/** Collect every declaration reachable from `root` WITHOUT crossing into a
 *  nested function body — so a function frame sees its own `const rows = …`
 *  even when it lives inside a `try`/`if`, but not a sibling function's. */
function collectFrame(root, { crossFunctions } = {}) {
  const frame = { functions: new Map(), bindings: new Map() };
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node.type !== 'string') continue;
    recordDeclaration(node, frame);
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue;
      const child = node[key];
      const children = Array.isArray(child) ? child : [child];
      for (const c of children) {
        if (!c || typeof c.type !== 'string') continue;
        // Don't descend into a nested function's body when collecting a frame
        // (its locals belong to ITS frame), unless we're building the module frame.
        if (!crossFunctions && c !== root && FUNCTION_TYPES.has(c.type)) continue;
        stack.push(c);
      }
    }
  }
  return frame;
}

/** A resolver over a chain of frames, searching innermost-first. */
function makeResolver(chain) {
  return {
    getFunction(name) {
      for (let i = chain.length - 1; i >= 0; i--) if (chain[i].functions.has(name)) return chain[i].functions.get(name);
      return null;
    },
    getBinding(name) {
      for (let i = chain.length - 1; i >= 0; i--) if (chain[i].bindings.has(name)) return chain[i].bindings.get(name);
      return null;
    },
  };
}

/** An inline adjudication that a flagged-but-correct site is intentional. Must
 *  carry a non-empty reason. Placed on, or up to two lines above, the `upsert`
 *  call. The 6 design-correct-but-flagged store writers (surrogate/global keys,
 *  guard-narrowed nullability) are the reason this exists: drift-only gating
 *  keeps them quiet today, and this is the escape hatch for the rare case where
 *  an edit to one of their lines re-surfaces the finding. */
// Optional column-selector form (docs/plans/refactor-static-analysis.md §2.2.2):
// `@on-conflict-ok(<column>): reason` governs the exact {callId, column} signal
// for that one column (findings AND the unresolved-conflict-key-nullability
// diagnostic); the bare form (no parens, column: null below) stays call-wide,
// findings-only — byte-identical to the pre-existing behaviour. The colon is
// NOT optional and the identifier class requires >=1 char, so
// `@on-conflict-ok(col)` (no colon) and `@on-conflict-ok(): reason` (empty
// selector) both fail to match this strict form — SUPPRESSION_ATTEMPT_RE below
// still recognizes them as an ATTEMPTED pragma so they are reported malformed
// rather than silently invisible (consolidated-gate G1).
const SUPPRESSION_RE = /@on-conflict-ok(?:\(([A-Za-z_][A-Za-z0-9_]*)\))?:\s*(.*)$/;

/** Loose detector for "this line looks like an @on-conflict-ok pragma attempt",
 *  used only to distinguish a malformed pragma from an ordinary comment once
 *  SUPPRESSION_RE has already failed to match it. */
const SUPPRESSION_ATTEMPT_RE = /@on-conflict-ok\b/;

/**
 * Find every suppression pragma governing an upsert call at `callLine`
 * (1-based), scanning the call's own line and up to two lines above it. A
 * bare form and one or more distinct-column selectors may legitimately
 * coexist above one call (each governs a different signal) — this returns
 * every match in scan order (closest to the call first); the caller
 * reconciles duplicate keys (`column ?? '*'`). `malformed` carries every line
 * that looks like a pragma attempt but doesn't match the strict grammar
 * (e.g. `@on-conflict-ok(): reason`, `@on-conflict-ok(col)` with no colon) —
 * these must be reported, never silently treated as call-wide.
 * @returns {{records: Array<{column: string|null, reason: string, line: number}>, malformed: Array<{line: number, text: string}>}}
 */
function findSuppressions(sourceLines, callLine) {
  const records = [];
  const malformed = [];
  for (let ln = callLine; ln >= Math.max(1, callLine - 2); ln--) {
    const rawLine = sourceLines[ln - 1] || '';
    const m = rawLine.match(SUPPRESSION_RE);
    if (m) {
      records.push({ column: m[1] ?? null, reason: m[2].trim(), line: ln });
    } else if (SUPPRESSION_ATTEMPT_RE.test(rawLine)) {
      malformed.push({ line: ln, text: rawLine.trim() });
    }
  }
  return { records, malformed };
}

/**
 * Extract every `upsert(...)` site in a source string, resolving each row arg
 * against its enclosing function scope chain.
 * @param {string} source
 * @returns {{sites: Array<object>, diagnostics: Array<object>, parseError: string|null}}
 */
export function extractUpsertSites(source) {
  const { ast, error } = parseSource(source);
  if (!ast) return { sites: [], diagnostics: [], parseError: error };
  const program = ast.type === 'File' ? ast.program : ast;
  // Split on \r?\n, NOT '\n'. On a CRLF working tree a bare-'\n' split leaves a
  // trailing '\r' on every line, and SUPPRESSION_RE's `(.*)$` cannot match it —
  // JS treats '\r' as a line terminator, so `.` won't consume it and a
  // non-multiline `$` won't match before it. Every @on-conflict-ok pragma then
  // silently stops suppressing on Windows checkouts while still working on LF
  // ones, making the gate platform-dependent (found while landing WS-C2).
  const sourceLines = source.split(/\r?\n/);

  // Module frame: all top-level declarations INCLUDING builder functions (whose
  // bodies we DO want to resolve into). crossFunctions:true so `export function
  // buildFpPatternRows` is registered even though it's a function.
  const moduleFrame = { functions: new Map(), bindings: new Map() };
  for (const stmt of program?.body || []) recordDeclaration(stmt, moduleFrame);

  const sites = [];
  const diagnostics = [];

  const recur = (node, chain) => {
    if (!node || typeof node.type !== 'string') return;

    // Entering a function: push a frame of ITS locals (not crossing further nested fns).
    let childChain = chain;
    if (FUNCTION_TYPES.has(node.type) && node.body) {
      childChain = [...chain, collectFrame(node.body)];
    }

    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && UPSERT_CALLEES.has(node.callee.name)) {
      processUpsertCall(node, makeResolver(childChain), sites, diagnostics, sourceLines);
    } else if (node.type === 'CallExpression') {
      // Fail-closed coverage self-check (audit 89fe6988/4bfc55b0, 2026-07-17):
      // a call whose name LOOKS upsert-shaped but isn't a recognized
      // `upsert` identifier call is invisible to the check above — either a
      // new local wrapper (`upsertBatch(...)`) the maintainer forgot to
      // register, or a raw client method call (`x.upsert(...)`,
      // `x.from(t).upsert(...)`) that bypasses the db/query.mjs facade
      // entirely. Neither is caught by the query.mjs-export guard or the
      // import-alias guard (tests/on-conflict-lint.test.mjs R1-M2/R2-M2),
      // which only see the RECOGNIZED `upsert` identifier's surface.
      // Matched against the START of an identifier (`upsertBatch`, not
      // `buildFrictionUpsertPayload` — a payload BUILDER, not a write) and
      // the WHOLE property name for a member call (the real client method
      // is always exactly `.upsert(...)`, never `.upsertFoo(...)`).
      const calleeName = node.callee?.type === 'Identifier' ? node.callee.name
        : node.callee?.type === 'MemberExpression' && !node.callee.computed ? node.callee.property?.name
        : null;
      const looksUpsertLike = node.callee?.type === 'Identifier' ? /^upsert/i.test(calleeName || '')
        : /^upsert$/i.test(calleeName || '');
      if (calleeName && looksUpsertLike) {
        diagnostics.push({
          kind: 'unrecognized-upsert-like-callee', table: '<unknown>', line: node.loc?.start?.line ?? 0,
          message: `call to "${calleeName}(...)" looks upsert-shaped but is not in UPSERT_CALLEES and is not a plain \`upsert(...)\` call — this write path's row/conflict-target shape is NOT analyzed (this flags EXISTENCE only, not nullable-key/scope-identity correctness — full analysis of an arbitrary unrecognized wrapper is out of scope, see docs/plans/audit-backlog-triage-hardening.md item 6). Register it in UPSERT_CALLEES if it is a real db-layer write wrapper so \`analyzeUpsert\` can actually check it, or route it through the recognized \`upsert\` helper.`,
        });
      }
    }

    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue;
      const child = node[key];
      const children = Array.isArray(child) ? child : [child];
      for (const c of children) if (c && typeof c.type === 'string') recur(c, childChain);
    }
  };
  recur(program, [moduleFrame]);

  return { sites, diagnostics, parseError: error };
}

/** Analyze one `upsert(table, rows, opts)` CallExpression node. */
function processUpsertCall(node, resolver, sites, diagnostics, sourceLines) {
  const line = node.loc?.start?.line ?? 0;
  const endLine = node.loc?.end?.line ?? line;
  const callId = `${node.start}:${node.end}`;
  const [tableArg, rowsArg, optsArg] = node.arguments || [];
  const table = tableArg?.type === 'StringLiteral' ? tableArg.value : '<dynamic>';

  // Reconcile raw pragma matches into one record per key (`column ?? '*'`) — a
  // bare form and distinct-column selectors coexist, but two records sharing a
  // key is a copy-paste that isn't governing what the author thinks it is.
  const { records: rawSuppressions, malformed } = findSuppressions(sourceLines, line);
  for (const m of malformed) {
    diagnostics.push({
      kind: 'malformed-suppression', table, line,
      message: `@on-conflict-ok pragma at line ${m.line} ("${m.text}") does not match the required syntax — expected `
        + '`@on-conflict-ok: <reason>` or `@on-conflict-ok(<column>): <reason>`. It is NOT applied (never silently '
        + 'treated as call-wide) — fix the syntax or the finding/diagnostic it was meant to excuse still gates.',
    });
  }
  const suppressions = [];
  const seenKeys = new Map();
  for (const rec of rawSuppressions) {
    const key = rec.column ?? '*';
    const prior = seenKeys.get(key);
    if (prior) {
      diagnostics.push({
        kind: 'duplicate-suppression', table, line,
        message: `duplicate @on-conflict-ok${rec.column ? `(${rec.column})` : ''} suppression at lines ${prior.line} and ${rec.line} — only the first (line ${prior.line}) is applied.`,
      });
      continue;
    }
    seenKeys.set(key, rec);
    suppressions.push(rec);
    if (rec.reason === '') {
      diagnostics.push({
        kind: 'unreasoned-suppression', table, line,
        message: `@on-conflict-ok${rec.column ? `(${rec.column})` : ''} at line ${rec.line} carries no reason — a suppression must state WHY the conflict target is correct, or it's indistinguishable from hiding the bug.`,
      });
    }
  }

  let conflictTarget = null;
  if (optsArg?.type === 'ObjectExpression') {
    const prop = optsArg.properties.find(
      (p) => (p.type === 'ObjectProperty' || p.type === 'Property') && !p.computed && p.key?.name === 'onConflict'
    );
    if (prop) {
      conflictTarget = readConflictTarget(prop.value);
      if (conflictTarget === null) {
        diagnostics.push({ kind: 'unresolved-conflict-target', table, line,
          message: `onConflict for "${table}" is a non-literal expression — its target can't be read statically; analyze by hand.` });
      }
    }
  }

  const rowObj = resolveRowObject(rowsArg, resolver);
  if (!rowObj) {
    diagnostics.push({ kind: 'unresolved-upsert-rows', table, line,
      message: `could not statically resolve the row shape for upsert("${table}") — extend the resolver or inline the row so the lint can see it (a site it can't read must not read as clean).` });
    return;
  }

  const { columns, columnExprs, hasSpread } = readRowObject(rowObj);

  // A selector naming a column absent from this call's row is a typo or a
  // stale pragma — report it rather than silently matching nothing.
  for (const rec of suppressions) {
    if (rec.column && !columns.includes(rec.column)) {
      diagnostics.push({
        kind: 'unknown-suppression-column', table, line,
        message: `@on-conflict-ok(${rec.column}) at line ${rec.line} names a column not present on this upsert's row — check for a typo or a stale pragma.`,
      });
    }
  }

  sites.push({ table, columns, columnExprs, conflictTarget, hasSpread, line, endLine, callId, suppressions });
}

/** The only diagnostic kind a pragma may silence — the author holds knowledge
 *  the intra-file resolver lacks about ITS OWN nullability axis. Every other
 *  `unresolved-*`/`parse-error`/`indeterminate-row` kind says "the lint could
 *  not read this site at all," and a pragma that could hide THAT would let an
 *  author silence the coverage self-check this module's honesty doctrine
 *  exists to enforce. A named constant so widening it is a visible edit. */
const SUPPRESSIBLE_DIAGNOSTIC_KINDS = new Set(['unresolved-conflict-key-nullability']);

/**
 * Lint one source string.
 * @returns {{findings:Array, suppressed:Array, diagnostics:Array}} — `findings`
 * are live (gating); `suppressed` are findings AND allowlisted diagnostics a
 * reasoned pragma silenced (each carries `.suppressionReason`); `diagnostics`
 * holds everything else — unresolved/parse/pragma-hygiene notes that can
 * never be suppressed.
 */
export function lintSource(rel, source) {
  const { sites, diagnostics, parseError } = extractUpsertSites(source);
  const findings = [];
  const suppressed = [];
  for (const site of sites) {
    // Explicit columns ARE checked (analyzeUpsert flags provable omissions even
    // under a spread); the residual gap is a scope column supplied ENTIRELY by
    // the spread, which we can't see. Surface that so the site isn't silently
    // assumed fully covered.
    if (site.hasSpread && Array.isArray(site.conflictTarget) && site.conflictTarget.length > 0) {
      diagnostics.push({ kind: 'indeterminate-row', table: site.table, line: site.line,
        message: `row for "${site.table}" contains a spread — explicit columns were checked, but a scope column supplied ENTIRELY via the spread can't be seen and would be missed. Verify the conflict target by hand or inline the spread.` });
    }
    const { findings: siteFindings, diagnostics: siteDiagnostics } = analyzeUpsert(site);
    const suppressions = site.suppressions || [];
    // A reasonless pragma is separately flagged (unreasoned-suppression,
    // emitted in processUpsertCall) but does NOT actively suppress anything —
    // "carries no reason" must not be indistinguishable from "silences this".
    const activeSuppressions = suppressions.filter((s) => s.reason !== '');
    // A bare pragma governs every column (findings-only, back-compat); a
    // column-selector pragma governs only its own column's findings AND the
    // allowlisted diagnostic for that column.
    const bareSuppression = activeSuppressions.find((s) => s.column === null) || null;
    const byColumn = new Map(activeSuppressions.filter((s) => s.column !== null).map((s) => [s.column, s]));

    for (const f of siteFindings) {
      const sup = bareSuppression || byColumn.get(f.column);
      if (sup) suppressed.push({ ...f, file: rel, suppressionReason: sup.reason });
      else findings.push({ ...f, file: rel });
    }

    for (const d of siteDiagnostics) {
      const sup = SUPPRESSIBLE_DIAGNOSTIC_KINDS.has(d.kind) ? (bareSuppression || byColumn.get(d.column)) : null;
      if (sup) suppressed.push({ ...d, file: rel, suppressionReason: sup.reason });
      else diagnostics.push({ ...d, file: rel });
    }

    // Orphan detection: a pragma governing zero findings AND zero allowlisted
    // diagnostics in its declared scope is stale — a suppression must not
    // outlive its cause. Evaluated per ACTIVE record (a reasonless pragma
    // already gets its own unreasoned-suppression diagnostic above and never
    // suppressed anything to begin with, so it can't also be "orphaned") so a
    // bare pragma and a column-selector pragma at the same call are judged
    // independently.
    for (const sup of activeSuppressions) {
      const inScopeFindings = siteFindings.filter((f) => sup.column === null || f.column === sup.column);
      const inScopeDiagnostics = siteDiagnostics.filter(
        (d) => SUPPRESSIBLE_DIAGNOSTIC_KINDS.has(d.kind) && (sup.column === null || d.column === sup.column)
      );
      if (inScopeFindings.length === 0 && inScopeDiagnostics.length === 0) {
        diagnostics.push({
          kind: 'orphaned-suppression', table: site.table, line: sup.line,
          message: `@on-conflict-ok${sup.column ? `(${sup.column})` : ''} at line ${sup.line} suppresses nothing — the finding/diagnostic it excused is gone; remove the pragma.`,
        });
      }
    }
  }
  const tagged = diagnostics.map((d) => ({ ...d, file: rel }));
  if (parseError) tagged.push({ kind: 'parse-error', file: rel, line: 0, message: parseError });
  return { findings, suppressed, diagnostics: tagged };
}

/** Recursively list `*.mjs` files under a directory. */
function listMjs(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listMjs(full));
    else if (e.isFile() && e.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

/**
 * Lint the cloud store's write path.
 * @param {object} [opts]
 * @param {string} [opts.rootDir] - repo root (defaults to two levels up from here)
 * @param {string} [opts.storeDir] - override the scanned directory (tests)
 * @returns {{findings:Array, diagnostics:Array, filesScanned:number}}
 */
export function lintStoreTree({ rootDir, storeDir } = {}) {
  const root = rootDir || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const dir = storeDir || path.join(root, 'scripts', 'lib', 'store');
  const files = listMjs(dir);
  const findings = [];
  const suppressed = [];
  const diagnostics = [];
  for (const abs of files) {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    const source = fs.readFileSync(abs, 'utf8');
    const res = lintSource(rel, source);
    findings.push(...res.findings);
    suppressed.push(...res.suppressed);
    diagnostics.push(...res.diagnostics);
  }
  return { findings, suppressed, diagnostics, filesScanned: files.length };
}

/**
 * Drift filter: keep only findings whose line falls inside a changed hunk of
 * their file. This is the gate model (mirrors nav-audit/visual-audit): the
 * existing store's design-correct-but-flagged writers never gate, but a NEW or
 * edited upsert with a bad conflict target does — which is exactly when the
 * three historical instances were introduced.
 *
 * A finding spans the whole upsert call (`line`..`endLine`), not one line — an
 * `onConflict` target and a row property live on different lines of the same
 * multi-line call, so editing EITHER must gate. We intersect the call's range
 * with each changed hunk rather than testing the start line alone (audit R1-H3).
 *
 * @param {Array<{file:string, line:number, endLine?:number}>} findings
 * @param {Map<string,{hunks:Array<{startLine:number,lineCount:number}>}>} diffMap
 *        — the shape `parseDiffFile` (scripts/lib/diff-annotation.mjs) returns.
 * @param {object} [opts]
 * @param {(p:string)=>string} [opts.normalize] - align finding.file with the diffMap key format
 * @returns {Array} the subset of findings whose call range intersects a changed hunk
 */
export function filterFindingsToDiff(findings, diffMap, { normalize = (s) => s } = {}) {
  return findings.filter((f) => {
    const entry = diffMap.get(normalize(f.file));
    if (!entry) return false;
    const lo = f.line;
    const hi = f.endLine ?? f.line;
    // Overlap of [lo, hi] with the hunk's [startLine, startLine+lineCount).
    return entry.hunks.some((h) => lo < h.startLine + h.lineCount && hi >= h.startLine);
  });
}
