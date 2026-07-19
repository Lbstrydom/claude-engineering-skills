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
 * The pure heart: given one already-extracted upsert site, return its findings.
 * Everything here is plain data — the entire instance matrix is tested against
 * this function with no AST and no DB.
 *
 * @param {object} site
 * @param {string} site.table            - table name (or '<dynamic>')
 * @param {string[]} site.columns        - top-level columns written on the row
 * @param {Record<string,{nullable:boolean}>} site.columnExprs - per-column value facts
 * @param {string[]|null} site.conflictTarget - normalized onConflict columns, or null (plain insert / unresolved)
 * @param {boolean} [site.hasSpread]      - row object contains a spread (columns may be incomplete)
 * @param {number} [site.line]            - the upsert call's start line
 * @param {number} [site.endLine]         - the upsert call's end line (for drift range)
 * @returns {Array<{rule:string, table:string, column:string, line:number, endLine:number, message:string}>}
 */
export function analyzeUpsert(site) {
  const { table = '<dynamic>', columns = [], columnExprs = {}, conflictTarget, hasSpread = false, line = 0, endLine = line } = site;
  const findings = [];
  const at = { table, line, endLine };

  // A plain insert (no onConflict) has no upsert identity — neither rule applies.
  if (!Array.isArray(conflictTarget) || conflictTarget.length === 0) return findings;

  const targetSet = new Set(conflictTarget);

  // Rule 1 — nullable-conflict-key (instances 1, 2). Sound even with a spread:
  // a spread cannot make an EXPLICITLY nullable conflict-key column non-nullable.
  for (const col of conflictTarget) {
    if (columnExprs[col]?.nullable) {
      findings.push({
        ...at,
        rule: 'nullable-conflict-key',
        column: col,
        message: `conflict-target column "${col}" is written with a nullable value — NULLs are DISTINCT in a unique index, so the upsert can never match and degrades to unbounded INSERTs (the 403k-row / bandit_arms class). Guarantee it non-null on this path (see isSyncableRepoId / a sentinel default).`,
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
  return findings;
}

// ── AST extraction ─────────────────────────────────────────────────────────

/** Is this value-expression node capable of yielding null/undefined? Precise,
 *  not heuristic: only the shapes the instances actually use. `a || null`,
 *  `a ?? null`, literal `null`/`undefined`, or a conditional with a nullable
 *  branch. Crucially `arm.contextBucket || GLOBAL_CONTEXT_BUCKET` is NOT
 *  nullable (right side is a non-null identifier) — so the FIXED bandit builder
 *  is not false-flagged, while the pre-fix `|| null` is. */
export function isNullableExpr(node) {
  if (!node || typeof node.type !== 'string') return false;
  if (node.type === 'NullLiteral') return true;
  if (node.type === 'Identifier' && node.name === 'undefined') return true;
  if (node.type === 'LogicalExpression') {
    // `a && b` evaluates to `a` when `a` is falsy (so `null && x` IS null) and to
    // `b` otherwise — nullable if EITHER operand is. This is a deliberate OVER-
    // approximation: `false && null` / `0 && null` actually evaluate to the
    // falsy-but-non-null left, yet we report them nullable. That's the SAFE
    // direction for a safety gate (a false-positive nullable-conflict-key, which
    // drift + the pragma absorb, never a missed real one), and the excluded case
    // — a literal-falsy left `&&` a value, as a DB column — does not occur.
    // `a || b` / `a ?? b` return the fallback `b` whenever `a` is absent, so
    // `a`'s nullness is masked by a non-null `b`: nullable iff the fallback is.
    if (node.operator === '&&') return isNullableExpr(node.left) || isNullableExpr(node.right);
    return isNullableExpr(node.right);
  }
  if (node.type === 'ConditionalExpression') {
    return isNullableExpr(node.consequent) || isNullableExpr(node.alternate);
  }
  return false;
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

/** Pull `{columns, columnExprs, hasSpread}` from an ObjectExpression row. */
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
    columnExprs[name] = { nullable: isNullableExpr(prop.value) };
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
const SUPPRESSION_RE = /@on-conflict-ok:\s*(.*)$/;

/** Find a suppression pragma governing an upsert call at `callLine` (1-based). */
function findSuppression(sourceLines, callLine) {
  for (let ln = callLine; ln >= Math.max(1, callLine - 2); ln--) {
    const m = (sourceLines[ln - 1] || '').match(SUPPRESSION_RE);
    if (m) return { reason: m[1].trim(), line: ln };
  }
  return null;
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
  const [tableArg, rowsArg, optsArg] = node.arguments || [];
  const table = tableArg?.type === 'StringLiteral' ? tableArg.value : '<dynamic>';

  const pragma = findSuppression(sourceLines, line);
  if (pragma && pragma.reason === '') {
    diagnostics.push({ kind: 'unreasoned-suppression', table, line,
      message: `@on-conflict-ok at line ${pragma.line} carries no reason — a suppression must state WHY the conflict target is correct, or it's indistinguishable from hiding the bug.` });
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
  const suppression = pragma && pragma.reason !== '' ? pragma : null;
  sites.push({ table, columns, columnExprs, conflictTarget, hasSpread, line, endLine, suppression });
}

/**
 * Lint one source string.
 * @returns {{findings:Array, suppressed:Array, diagnostics:Array}} — `findings`
 * are live (gating); `suppressed` are findings a reasoned pragma silenced (each
 * carries `.suppressionReason`); diagnostics include unresolved/parse/pragma-
 * hygiene notes.
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
    const siteFindings = analyzeUpsert(site);
    if (site.suppression) {
      // A pragma over a site that produces NO finding is stale — surface it so
      // suppressions don't outlive the thing they excused (mirrors the
      // duplication wave's orphaned-pragma check).
      if (siteFindings.length === 0) {
        diagnostics.push({ kind: 'orphaned-suppression', table: site.table, line: site.suppression.line,
          message: `@on-conflict-ok at line ${site.suppression.line} suppresses nothing — the finding it excused is gone; remove the pragma.` });
      }
      for (const f of siteFindings) suppressed.push({ ...f, file: rel, suppressionReason: site.suppression.reason });
    } else {
      for (const f of siteFindings) findings.push({ ...f, file: rel });
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
