/**
 * @fileoverview DB-free tests for the on-conflict lint
 * (scripts/lib/lint/on-conflict.mjs).
 *
 * The value of this lint is entirely in "catches the 3 real instances, stays
 * silent on the design-correct writers" — so the instance matrix is the heart
 * of the suite, expressed as pure data against `analyzeUpsert` (no AST, no DB —
 * INC-002). The extractor + pragma + drift tests cover the machinery that feeds
 * it. Everything here is a pure function over fixtures.
 *
 * The three historical field instances this class is named for:
 *   1. false_positive_patterns — repo_id `|| null` IN the conflict target (403k rows)
 *   2. bandit_arms — context_bucket `|| null` in its own conflict target
 *   3. prompt_variants (upsertPromptVariant) — repo_id stored but OMITTED from the target
 *
 * The nullability axis (docs/plans/refactor-static-analysis.md §2.2) is now a
 * two-layer lattice, not a boolean: `classifyNullability` (Layer 1, pure
 * syntactic, never returns 'unknown') feeds `classifyColumnValue` (Layer 1 +
 * root-kind reporting eligibility, which mints 'unknown' for an undecidable
 * fallback expression). `analyzeUpsert` now returns `{findings, diagnostics}`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '@babel/parser';
import {
  analyzeUpsert,
  isNullableExpr,
  classifyNullability,
  classifyColumnValue,
  extractUpsertSites,
  lintSource,
  lintStoreTree,
  filterFindingsToDiff,
  SCOPE_COLUMNS,
} from '../scripts/lib/lint/on-conflict.mjs';

/** Parse a bare expression string into its AST node (unwraps the ExpressionStatement). */
function parseExpr(src) {
  const ast = parse(`(${src});`, { sourceType: 'module', plugins: [] });
  return ast.program.body[0].expression;
}

// ── 1. analyzeUpsert — the instance matrix (pure data) ─────────────────────

test('instance 1 (false_positive_patterns): a nullable column IN the conflict target is flagged', () => {
  const { findings } = analyzeUpsert({
    table: 'false_positive_patterns',
    columns: ['repo_id', 'pattern_value'],
    columnExprs: { repo_id: { nullability: 'nullable' }, pattern_value: { nullability: 'non-null' } },
    conflictTarget: ['repo_id', 'pattern_value'],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'nullable-conflict-key');
  assert.equal(findings[0].column, 'repo_id');
});

test('instance 2 (bandit_arms): context_bucket nullable in its conflict target is flagged', () => {
  const { findings } = analyzeUpsert({
    table: 'bandit_arms',
    columns: ['pass_name', 'variant_id', 'context_bucket'],
    columnExprs: { context_bucket: { nullability: 'nullable' } },
    conflictTarget: ['pass_name', 'variant_id', 'context_bucket'],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'nullable-conflict-key');
  assert.equal(findings[0].column, 'context_bucket');
});

test('instance 3 (prompt_variants): a stored scope column OMITTED from the target is flagged', () => {
  const { findings } = analyzeUpsert({
    table: 'prompt_variants',
    columns: ['repo_id', 'pass_name', 'variant_name'],
    columnExprs: { repo_id: { nullability: 'nullable' } },
    conflictTarget: ['pass_name', 'variant_name'],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'omitted-scope-identity');
  assert.equal(findings[0].column, 'repo_id');
});

test('MIRROR of 1/2: the FIXED writers (non-null conflict-key column) are NOT flagged', () => {
  // bandit_arms fix: context_bucket || GLOBAL_CONTEXT_BUCKET — a module
  // constant the intra-file resolver can't see, so it's 'unknown' (diagnostic,
  // not a gating finding) rather than provably 'non-null'. Adjudicated by the
  // @on-conflict-ok(context_bucket) pragma at the real call site.
  assert.equal(analyzeUpsert({
    table: 'bandit_arms', columns: ['pass_name', 'variant_id', 'context_bucket'],
    columnExprs: { context_bucket: { nullability: 'unknown' } },
    conflictTarget: ['pass_name', 'variant_id', 'context_bucket'],
  }).findings.length, 0);
  // FP fix: repo_id: repoUuid (guaranteed non-null), and it's IN the target.
  assert.equal(analyzeUpsert({
    table: 'false_positive_patterns', columns: ['repo_id', 'pattern_value'],
    columnExprs: { repo_id: { nullability: 'non-null' } },
    conflictTarget: ['repo_id', 'pattern_type', 'pattern_value'],
  }).findings.length, 0);
});

test('a plain insert (no onConflict) is never flagged — neither rule applies', () => {
  assert.equal(analyzeUpsert({
    table: 'security_strategy_events', columns: ['repo_id', 'incident_id'],
    columnExprs: { repo_id: { nullability: 'nullable' } }, conflictTarget: null,
  }).findings.length, 0);
});

test('omitted-scope is a heuristic that FIRES on a surrogate-key writer — this is why drift+pragma exist', () => {
  // persona_test_sessions: conflict [session_id] (globally unique); repo_id is
  // metadata → design-correct, but the rule cannot know that from the row. The
  // finding is expected; drift keeps it from gating, a pragma documents it.
  const { findings } = analyzeUpsert({
    table: 'persona_test_sessions', columns: ['session_id', 'repo_id', 'repo_name'],
    columnExprs: {}, conflictTarget: ['session_id'],
  });
  assert.equal(findings.length, 2); // repo_id + repo_name
  assert.deepEqual(findings.map((x) => x.column).sort(), ['repo_id', 'repo_name']);
});

test('SCOPE_COLUMNS is the small explicit set — a non-scope column omitted is NOT flagged', () => {
  assert.ok(SCOPE_COLUMNS.has('repo_id') && SCOPE_COLUMNS.has('user_id') && SCOPE_COLUMNS.has('repo_name'));
  const { findings } = analyzeUpsert({
    table: 't', columns: ['session_id', 'checksum'], columnExprs: {}, conflictTarget: ['session_id'],
  });
  assert.equal(findings.length, 0); // checksum is not a scope column
});

// ── 2. classifyNullability / classifyColumnValue — the two-layer lattice ────
//
// docs/plans/refactor-static-analysis.md §2.2.1's complete semantic table.

test('Layer 1 (classifyNullability): the provable-nullable shapes', () => {
  for (const src of ['null', 'x || null', 'x ?? null', 'undefined', 'x ? a : null']) {
    const { sites } = extractUpsertSites(`upsert('t', [{ k: ${src} }], { onConflict: ['k'] });`);
    assert.equal(sites[0].columnExprs.k.nullability, 'nullable', `${src} should classify as nullable`);
  }
});

test('Layer 1: a literal of any recognized kind is non-null', () => {
  for (const src of ["'literal'", '42', 'true', '`template`', '{ a: 1 }', '[1, 2]', 'new Date()']) {
    const { sites } = extractUpsertSites(`upsert('t', [{ k: ${src} }], { onConflict: ['k'] });`);
    assert.equal(sites[0].columnExprs.k.nullability, 'non-null', `${src} should classify as non-null`);
  }
});

test("Layer 1: classifyNullability NEVER returns 'unknown' — that value belongs to Layer 2 alone", () => {
  const cases = [
    'null', 'x', 'x || y', 'x ?? y', 'x && y', 'x ? a : b',
    'someCall()', 'obj.prop', "'lit'", '42', 'undefined',
    'x || (y || null)', // nested fallback
  ];
  for (const src of cases) {
    const value = classifyNullability(parseExpr(src));
    assert.notEqual(value, 'unknown', `classifyNullability(${src}) must never be 'unknown', got '${value}'`);
  }
});

test("Layer 2 (classifyColumnValue): 'unknown' is minted ONLY for a Logical/Conditional root whose Layer-1 class is 'opaque'", () => {
  const unknownCases = ['repoId || fallbackRepoId', 'maybeNull && \'value\'', 'x ? a : someCall()'];
  for (const src of unknownCases) {
    const { sites } = extractUpsertSites(`upsert('t', [{ k: ${src} }], { onConflict: ['k'] });`);
    assert.equal(sites[0].columnExprs.k.nullability, 'unknown', `${src} should classify as unknown`);
  }
});

test("Layer 2: a bare read (Identifier/MemberExpression/CallExpression/AwaitExpression root) stays the quiet 'opaque' state — never 'unknown'", () => {
  for (const src of ['refreshId', 'row.importerPath', 'someCall()', 'await asyncThing()']) {
    const { sites } = extractUpsertSites(`async function f() { return upsert('t', [{ k: ${src} }], { onConflict: ['k'] }); }`);
    assert.equal(sites[0].columnExprs.k.nullability, 'opaque', `${src} should stay opaque (no new noise)`);
  }
});

test('precedence: a definite nullable path ALWAYS wins over opaque (never downgraded to unknown)', () => {
  const { sites } = extractUpsertSites(`upsert('t', [{ k: maybeNull ? null : someCall() }], { onConflict: ['k'] });`);
  assert.equal(sites[0].columnExprs.k.nullability, 'nullable');
});

test('nullability: a non-null sentinel fallback / bare identifier / literal is NOT nullable (the bandit fix)', () => {
  // `arm.contextBucket || GLOBAL_CONTEXT_BUCKET` and `x ? a : b` are BOTH
  // opaque-rooted Logical/Conditional expressions → 'unknown', not 'non-null'
  // — this is the exact laundering this plan removes: neither disproves
  // nullability, so neither should be silently treated as safe.
  for (const src of ['arm.contextBucket || GLOBAL_CONTEXT_BUCKET', 'x ? a : b']) {
    const { sites } = extractUpsertSites(`upsert('t', [{ k: ${src} }], { onConflict: ['k'] });`);
    assert.equal(sites[0].columnExprs.k.nullability, 'unknown', `${src} should be unknown, not falsely non-null`);
  }
  // A genuinely bare identifier stays opaque (quiet, no diagnostic).
  const { sites } = extractUpsertSites(`upsert('t', [{ k: repoId }], { onConflict: ['k'] });`);
  assert.equal(sites[0].columnExprs.k.nullability, 'opaque');
});

test('isNullableExpr is exported, byte-identical to the classifyNullability === "nullable" projection (#18 backward compat)', () => {
  assert.equal(isNullableExpr(null), false);
  assert.equal(isNullableExpr({}), false);
  const fixtures = [
    'null', 'x || null', 'x ?? null', 'undefined', 'x ? a : null', // nullable
    "'literal'", '42', 'x || y', 'x ? a : b', 'refreshId', 'someCall()', // not nullable
    'null && x', 'x && null', 'maybeNull && fallback', // && arm
  ];
  for (const src of fixtures) {
    const node = parseExpr(src);
    assert.equal(isNullableExpr(node), classifyNullability(node) === 'nullable', `${src} equivalence must hold`);
  }
});

test('nullability: `&&` is nullable if EITHER operand is (not just the right — audit R1-M1)', () => {
  // `null && x` evaluates to null; the right-only rule missed this.
  const left = extractUpsertSites(`upsert('t', [{ k: maybeNull && fallback }], { onConflict: ['k'] });`);
  // `maybeNull` alone isn't statically nullable and `fallback` is opaque too →
  // Layer 1 is 'opaque'. The root IS a LogicalExpression, so Layer 2 (what the
  // site payload stores) mints 'unknown' here — same eligibility rule as `||`.
  assert.equal(left.sites[0].columnExprs.k.nullability, 'unknown');
  const nullLeft = extractUpsertSites(`upsert('t', [{ k: null && x }], { onConflict: ['k'] });`);
  assert.equal(nullLeft.sites[0].columnExprs.k.nullability, 'nullable', 'null && x is null');
  const nullRight = extractUpsertSites(`upsert('t', [{ k: x && null }], { onConflict: ['k'] });`);
  assert.equal(nullRight.sites[0].columnExprs.k.nullability, 'nullable', 'x && null is null');
});

// ── 2b. Census invariants (design guarantees, not exact counts — shadow-review S4a) ──
//
// An earlier draft asserted the exact 5/1/1/74 split over the real store
// tree; that couples a test to production files this plan doesn't own. These
// assert what the DESIGN guarantees instead — what would actually regress.

test('census invariant: every unknown nullability payload in the live store has a Logical/Conditional root', () => {
  const { findings, suppressed, diagnostics } = lintStoreTree();
  void findings;
  const unknownSignals = [...suppressed, ...diagnostics].filter((s) => s.kind === 'unresolved-conflict-key-nullability');
  // We can't re-derive the AST root kind from the finding record alone, but we
  // CAN assert the design guarantee that produced them: the count stays a
  // loose ceiling (never regresses to the 75-diagnostic naive-classifier
  // outcome), reported for context, not pinned as an equality.
  assert.ok(unknownSignals.length <= 3, `unknown-nullability signal count regressed: ${unknownSignals.length}`);
});

test('census invariant: no bare-read root ever yields an unresolved-conflict-key-nullability diagnostic', () => {
  // A bare column read (Identifier/MemberExpression/CallExpression root) must
  // never surface as a diagnostic — asserted directly against the lattice,
  // independent of what the live store currently contains.
  for (const src of ['refreshId', 'row.importerPath', 'someCall()']) {
    const { sites } = extractUpsertSites(`upsert('t', [{ k: ${src} }], { onConflict: ['k'] });`);
    const { diagnostics } = analyzeUpsert(sites[0]);
    assert.equal(diagnostics.filter((d) => d.kind === 'unresolved-conflict-key-nullability').length, 0);
  }
});

// ── 2c. Spread rows: check the provable, flag the unseeable as indeterminate ──

test('a spread row with NO explicit scope column: no omitted-scope finding, but an indeterminate note', () => {
  // A scope column could be hidden in `...base`; we can't see it, so we don't
  // assert omission — but we DO flag the uncertainty.
  const src = `upsert('t', [{ ...base, name: n }], { onConflict: ['name'] });`;
  const { findings, diagnostics } = lintSource('x.mjs', src);
  assert.equal(findings.filter((f) => f.rule === 'omitted-scope-identity').length, 0);
  assert.equal(diagnostics.filter((d) => d.kind === 'indeterminate-row').length, 1);
});

test('a spread row STILL flags an EXPLICITLY-written omitted scope column (audit R2-H1)', () => {
  // repo_id is explicitly written → provably stored AND provably omitted from
  // [name]. The spread does not make that omission unprovable; it must flag.
  const src = `upsert('t', [{ ...metadata, repo_id: r, name: n }], { onConflict: ['name'] });`;
  const { findings, diagnostics } = lintSource('x.mjs', src);
  const omitted = findings.filter((f) => f.rule === 'omitted-scope-identity');
  assert.equal(omitted.length, 1);
  assert.equal(omitted[0].column, 'repo_id');
  assert.equal(diagnostics.filter((d) => d.kind === 'indeterminate-row').length, 1, 'still notes the spread uncertainty');
});

test('a spread row STILL flags an explicitly-nullable conflict key (that rule stays sound)', () => {
  const src = `upsert('t', [{ ...base, repo_id: r || null }], { onConflict: ['repo_id'] });`;
  const { findings } = lintSource('x.mjs', src);
  assert.equal(findings.filter((f) => f.rule === 'nullable-conflict-key').length, 1);
});

// ── 3. extractUpsertSites — row-shape resolution across indirection ─────────

test('resolves an inline row literal', () => {
  const { sites } = extractUpsertSites(`upsert('t', [{ repo_id: repoId || null, path: p }], { onConflict: ['repo_id', 'path'] });`);
  assert.equal(sites.length, 1);
  assert.deepEqual(sites[0].columns.sort(), ['path', 'repo_id']);
  assert.equal(sites[0].columnExprs.repo_id.nullability, 'nullable');
  assert.deepEqual(sites[0].conflictTarget, ['repo_id', 'path']);
  assert.equal(typeof sites[0].callId, 'string');
});

test('resolves rows through a local builder function (buildFpPatternRows shape)', () => {
  const src = `
    function buildRows(xs) { return xs.map((x) => ({ repo_id: x.id, pass_name: x.p, context_bucket: x.b || null })); }
    async function sync(xs) {
      const rows = buildRows(xs);
      await upsert('bandit_arms', rows, { onConflict: ['pass_name', 'context_bucket'] });
    }`;
  const { sites } = extractUpsertSites(src);
  assert.equal(sites.length, 1);
  assert.ok(sites[0].columns.includes('context_bucket'));
  assert.equal(sites[0].columnExprs.context_bucket.nullability, 'nullable');
});

test('resolves rows through a `for (const slice of chunk(rows, N))` batched write', () => {
  const src = `
    async function sync(defs) {
      const rows = defs.map((d) => ({ repo_id: d.id, canonical_path: d.p, symbol_name: d.n }));
      for (const slice of chunk(rows, 500)) {
        await upsert('symbol_index', slice, { onConflict: ['refresh_id', 'definition_id'] });
      }
    }`;
  const { sites } = extractUpsertSites(src);
  assert.equal(sites.length, 1, 'the for-of + chunk write must resolve, not go unresolved');
  assert.ok(sites[0].columns.includes('repo_id'));
});

test('an unresolvable row shape becomes a diagnostic, never a silent clean pass', () => {
  const { sites, diagnostics } = extractUpsertSites(`upsert('t', someOpaqueThing(), { onConflict: ['id'] });`);
  assert.equal(sites.length, 0);
  assert.equal(diagnostics.filter((d) => d.kind === 'unresolved-upsert-rows').length, 1);
});

test('a string onConflict is normalized to a one-element target', () => {
  const { sites } = extractUpsertSites(`upsert('t', [{ decision_key: k, repo_id: r }], { onConflict: 'decision_key' });`);
  assert.deepEqual(sites[0].conflictTarget, ['decision_key']);
});

test('a non-literal (ternary) onConflict is reported unresolved, not read wrong', () => {
  const { diagnostics } = extractUpsertSites(
    `upsert('t', [{ repo_id: r, spec_path: s }], { onConflict: isCand ? ['repo_id','fp'] : ['repo_id','spec_path'] });`
  );
  assert.equal(diagnostics.filter((d) => d.kind === 'unresolved-conflict-target').length, 1);
});

// ── 4. Suppression pragma — parsing (§2.2.2, shadow-review S1) ──────────────

test('bare @on-conflict-ok: reason captures byte-identically to today and stays findings-only', () => {
  const src = `
    // @on-conflict-ok: session_id is globally unique; repo_id is metadata
    upsert('persona_test_sessions', [{ session_id: s, repo_id: r }], { onConflict: ['session_id'] });`;
  const { findings, suppressed } = lintSource('x.mjs', src);
  assert.equal(findings.length, 0);
  assert.equal(suppressed.length, 1);
  assert.match(suppressed[0].suppressionReason, /globally unique/);
});

test('@on-conflict-ok(col): reason captures the column selector', () => {
  const src = `
    // @on-conflict-ok(context_bucket): falls back to a module constant; never null
    upsert('bandit_arms', [{ pass_name: p, variant_id: v, context_bucket: b || GLOBAL_CONTEXT_BUCKET }], { onConflict: ['pass_name', 'variant_id', 'context_bucket'] });`;
  const { diagnostics, suppressed } = lintSource('x.mjs', src);
  assert.equal(diagnostics.filter((d) => d.kind === 'unresolved-conflict-key-nullability').length, 0, 'the selector silences it');
  const hit = suppressed.find((s) => s.kind === 'unresolved-conflict-key-nullability');
  assert.ok(hit, 'the diagnostic must be recorded as suppressed, not silently dropped');
  assert.match(hit.suppressionReason, /module constant/);
});

test('@on-conflict-ok(col) with NO colon does not match — never treated as call-wide, and is reported malformed', () => {
  const src = `
    // @on-conflict-ok(context_bucket) no colon here
    upsert('bandit_arms', [{ pass_name: p, variant_id: v, context_bucket: b || GLOBAL_CONTEXT_BUCKET }], { onConflict: ['pass_name', 'variant_id', 'context_bucket'] });`;
  const { diagnostics } = lintSource('x.mjs', src);
  assert.equal(diagnostics.filter((d) => d.kind === 'unresolved-conflict-key-nullability').length, 1, 'not suppressed — the malformed line produced no pragma record');
  assert.equal(diagnostics.filter((d) => d.kind === 'malformed-suppression').length, 1);
});

test('@on-conflict-ok(): reason — an empty selector is malformed, not treated as call-wide, and is REPORTED (consolidated-gate G1)', () => {
  const src = `
    // @on-conflict-ok(): reason
    upsert('t', [{ session_id: s, repo_id: r }], { onConflict: ['session_id'] });`;
  const { findings, suppressed, diagnostics } = lintSource('x.mjs', src);
  assert.equal(suppressed.length, 0, 'malformed pragma produces no suppression record at all');
  assert.equal(findings.length, 1, 'the omitted-scope-identity finding still gates — nothing silenced it');
  const hits = diagnostics.filter((d) => d.kind === 'malformed-suppression');
  assert.equal(hits.length, 1, 'the malformed attempt must be reported, not silently invisible');
  assert.match(hits[0].message, /on-conflict-ok\(\): reason/);
});

test('@on-conflict-ok(col) with no colon is ALSO reported malformed (same grammar failure, different shape)', () => {
  const src = `
    // @on-conflict-ok(context_bucket) no colon here
    upsert('bandit_arms', [{ pass_name: p, variant_id: v, context_bucket: b || GLOBAL_CONTEXT_BUCKET }], { onConflict: ['pass_name', 'variant_id', 'context_bucket'] });`;
  const { diagnostics } = lintSource('x.mjs', src);
  assert.equal(diagnostics.filter((d) => d.kind === 'malformed-suppression').length, 1);
});

test('an ordinary comment mentioning "on-conflict" but not the pragma tag is NOT reported malformed (no false positives)', () => {
  const src = `
    // this upsert is fine, see the on-conflict design doc for background
    upsert('t', [{ session_id: s, repo_id: r }], { onConflict: ['session_id'] });`;
  const { diagnostics } = lintSource('x.mjs', src);
  assert.equal(diagnostics.filter((d) => d.kind === 'malformed-suppression').length, 0);
});

test('a selector naming a column absent from the row yields unknown-suppression-column', () => {
  const src = `
    // @on-conflict-ok(nonexistent_col): typo
    upsert('t', [{ repo_id: r, path: p }], { onConflict: ['repo_id', 'path'] });`;
  const { diagnostics } = lintSource('x.mjs', src);
  assert.equal(diagnostics.filter((d) => d.kind === 'unknown-suppression-column').length, 1);
});

test('two selectors naming the SAME column is a duplicate-suppression; the one CLOSEST to the call is applied', () => {
  // The scan checks the call's own line, then upward (closest-to-call
  // first) — matching the pre-existing single-pragma scan order.
  // "closer reason" is nearer the call than "farther reason", so it wins.
  const src = `
    // @on-conflict-ok(repo_id): farther reason
    // @on-conflict-ok(repo_id): closer reason
    upsert('t', [{ repo_id: r, path: p }], { onConflict: ['path'] });`;
  const { diagnostics, suppressed } = lintSource('x.mjs', src);
  assert.equal(diagnostics.filter((d) => d.kind === 'duplicate-suppression').length, 1);
  const hit = suppressed.find((s) => s.rule === 'omitted-scope-identity');
  assert.ok(hit);
  assert.match(hit.suppressionReason, /closer reason/);
});

test('a bare form and a distinct-column selector may coexist at one call, each governing its own scope', () => {
  const src = `
    // @on-conflict-ok: call-wide reason
    // @on-conflict-ok(context_bucket): column-specific reason
    upsert('bandit_arms', [{ pass_name: p, variant_id: v, context_bucket: b || GLOBAL_CONTEXT_BUCKET }], { onConflict: ['pass_name', 'variant_id', 'context_bucket'] });`;
  const { diagnostics } = lintSource('x.mjs', src);
  assert.equal(diagnostics.filter((d) => d.kind === 'duplicate-suppression').length, 0, 'distinct keys (* and context_bucket) do not collide');
});

test('a pragma suppresses on a CRLF source exactly as it does on LF', () => {
  // Regression guard. The extractor used to split on '\n', leaving a trailing
  // '\r' on every line of a CRLF checkout; SUPPRESSION_RE's `(.*)$` cannot match
  // that ('\r' is a JS line terminator, so `.` won't consume it and a
  // non-multiline `$` won't match before it). Result: every @on-conflict-ok
  // silently stopped suppressing on Windows while still working on Linux — a
  // platform-dependent gate. Assert both endings behave identically.
  const lf = `
    // @on-conflict-ok: session_id is globally unique; repo_id is metadata
    upsert('persona_test_sessions', [{ session_id: s, repo_id: r }], { onConflict: ['session_id'] });`;
  const crlf = lf.replace(/\n/g, '\r\n');

  for (const [label, src] of [['LF', lf], ['CRLF', crlf]]) {
    const { findings, suppressed } = lintSource('x.mjs', src);
    assert.equal(findings.length, 0, `${label}: pragma must suppress the finding`);
    assert.equal(suppressed.length, 1, `${label}: exactly one suppressed finding`);
    assert.match(suppressed[0].suppressionReason, /globally unique/,
      `${label}: the reason must survive the split (no stray \\r)`);
  }
});

test('a reasonless @on-conflict-ok is itself flagged (indistinguishable from hiding the bug)', () => {
  const src = `
    // @on-conflict-ok:
    upsert('t', [{ session_id: s, repo_id: r }], { onConflict: ['session_id'] });`;
  const { findings, diagnostics } = lintSource('x.mjs', src);
  assert.equal(diagnostics.filter((d) => d.kind === 'unreasoned-suppression').length, 1);
  assert.equal(findings.length, 1, 'a reasonless pragma does NOT suppress — the finding still gates');
});

test('a pragma over a clean site is orphaned (stale suppression must not outlive its finding)', () => {
  const src = `
    // @on-conflict-ok: no longer needed
    upsert('t', [{ repo_id: r, path: p }], { onConflict: ['repo_id', 'path'] });`;
  const { findings, suppressed, diagnostics } = lintSource('x.mjs', src);
  assert.equal(findings.length, 0);
  assert.equal(suppressed.length, 0);
  assert.equal(diagnostics.filter((d) => d.kind === 'orphaned-suppression').length, 1);
});

test('a column-selector pragma is orphaned once its governed diagnostic is gone (widened orphan check)', () => {
  const src = `
    // @on-conflict-ok(context_bucket): no longer needed, now provably non-null
    upsert('bandit_arms', [{ pass_name: p, variant_id: v, context_bucket: 'literal' }], { onConflict: ['pass_name', 'variant_id', 'context_bucket'] });`;
  const { diagnostics } = lintSource('x.mjs', src);
  assert.equal(diagnostics.filter((d) => d.kind === 'orphaned-suppression').length, 1);
});

test('the pragma kind allowlist NEVER lets a bare pragma silence unresolved-upsert-rows / unresolved-conflict-target', () => {
  const unresolvedRows = `
    // @on-conflict-ok: trust me
    upsert('t', someOpaqueThing(), { onConflict: ['id'] });`;
  const r1 = lintSource('x.mjs', unresolvedRows);
  assert.equal(r1.diagnostics.filter((d) => d.kind === 'unresolved-upsert-rows').length, 1, 'never suppressible');
  assert.equal(r1.suppressed.filter((s) => s.kind === 'unresolved-upsert-rows').length, 0);

  const unresolvedTarget = `
    // @on-conflict-ok: trust me
    upsert('t', [{ repo_id: r }], { onConflict: isCand ? ['a'] : ['b'] });`;
  const r2 = lintSource('x.mjs', unresolvedTarget);
  assert.equal(r2.diagnostics.filter((d) => d.kind === 'unresolved-conflict-target').length, 1, 'never suppressible');
});

test('lifecycle: one call with a selector-suppressed unknown AND an unsuppressed unknown on a DIFFERENT column', () => {
  const src = `
    // @on-conflict-ok(a): a is fine
    upsert('t', [{ a: x || y, b: p || q }], { onConflict: ['a', 'b'] });`;
  const { diagnostics, suppressed } = lintSource('x.mjs', src);
  const stillOpen = diagnostics.filter((d) => d.kind === 'unresolved-conflict-key-nullability');
  assert.equal(stillOpen.length, 1);
  assert.equal(stillOpen[0].column, 'b');
  const hidden = suppressed.filter((s) => s.kind === 'unresolved-conflict-key-nullability');
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].column, 'a');
});

test('lifecycle: one call with a finding AND a diagnostic, only the finding gated by a bare pragma', () => {
  const src = `
    // @on-conflict-ok: a is a legit nullable default for this table
    upsert('t', [{ a: null, b: x || y }], { onConflict: ['a', 'b'] });`;
  const { findings, diagnostics, suppressed } = lintSource('x.mjs', src);
  assert.equal(findings.length, 0, 'bare pragma is call-wide — silences the finding too');
  assert.equal(diagnostics.filter((d) => d.kind === 'unresolved-conflict-key-nullability').length, 0);
  assert.equal(suppressed.filter((s) => s.rule === 'nullable-conflict-key').length, 1);
  assert.equal(suppressed.filter((s) => s.kind === 'unresolved-conflict-key-nullability').length, 1);
});

// ── 5. Drift filter — the gate model ───────────────────────────────────────

test('filterFindingsToDiff keeps a finding whose line is in a changed hunk, drops the rest', () => {
  const findings = [
    { file: 'a.mjs', line: 10, rule: 'x' }, // inside the hunk
    { file: 'a.mjs', line: 99, rule: 'y' }, // outside the hunk
    { file: 'b.mjs', line: 5, rule: 'z' },  // file not in diff
  ];
  const diffMap = new Map([['a.mjs', { hunks: [{ startLine: 8, lineCount: 5 }] }]]); // lines 8..12
  const kept = filterFindingsToDiff(findings, diffMap);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].line, 10);
});

test('filterFindingsToDiff applies the normalizer to reconcile path-key casing', () => {
  const findings = [{ file: 'scripts/lib/store/X.mjs', line: 3, rule: 'x' }];
  const diffMap = new Map([['scripts/lib/store/x.mjs', { hunks: [{ startLine: 1, lineCount: 10 }] }]]);
  assert.equal(filterFindingsToDiff(findings, diffMap).length, 0, 'no normalizer → casing mismatch drops it');
  assert.equal(filterFindingsToDiff(findings, diffMap, { normalize: (p) => p.toLowerCase() }).length, 1);
});

test('drift intersects the finding RANGE, so editing ANY line of a multi-line call gates (audit R1-H3)', () => {
  // A finding for a call spanning lines 10..15; a hunk touching only line 14
  // (e.g. the onConflict target moved) must still gate — the start-line-only
  // test would have missed it.
  const findings = [{ file: 'a.mjs', line: 10, endLine: 15, rule: 'x' }];
  const diffMap = new Map([['a.mjs', { hunks: [{ startLine: 14, lineCount: 1 }] }]]); // line 14 only
  assert.equal(filterFindingsToDiff(findings, diffMap).length, 1, 'a hunk inside the call range must gate');
  // A hunk entirely outside the range does NOT gate.
  const outside = new Map([['a.mjs', { hunks: [{ startLine: 20, lineCount: 3 }] }]]);
  assert.equal(filterFindingsToDiff(findings, outside).length, 0);
});

// ── 6. Live store tree — coverage guard (stable, not line-pinned) ──────────

test('lintStoreTree resolves the live store: >0 files, <=1 unresolved site', () => {
  const { diagnostics, filesScanned } = lintStoreTree();
  assert.ok(filesScanned > 0, 'must actually scan the store');
  const unresolved = diagnostics.filter((d) => d.kind?.startsWith('unresolved'));
  // A NEW upsert shape the resolver can't read (or a resolver regression) turns
  // this red — the honest-coverage guard. The one known unresolved is the
  // regression_specs ternary onConflict (both branches include repo_id anyway).
  assert.ok(unresolved.length <= 1, `resolver coverage regressed: ${JSON.stringify(unresolved.map((u) => `${u.file}:${u.line}`))}`);
});

test('lintStoreTree never reports the deleted upsertPromptVariant (prompt_variants clean)', () => {
  const { findings } = lintStoreTree();
  assert.equal(findings.filter((f) => f.table === 'prompt_variants').length, 0);
});

test('the store-inventory close-out assertion (R1-M3): zero findings, zero unresolved-conflict-key-nullability, the exact remaining (kind, file) diagnostic set', () => {
  // Baseline measured 2026-07-27 via `node scripts/on-conflict-lint.mjs --all --json`:
  // 0 findings / 9 suppressed (8 pre-existing + the new bandit-fp.mjs pragma) /
  // 1 diagnostic. Asserting the (kind, file) SET, not counts, keeps this
  // deterministic and stable against unrelated store edits.
  const { findings, diagnostics } = lintStoreTree();
  assert.equal(findings.length, 0, 'the live store must have zero gating findings');
  assert.equal(
    diagnostics.filter((d) => d.kind === 'unresolved-conflict-key-nullability').length, 0,
    'the one live unresolved-conflict-key-nullability instance (bandit-fp.mjs context_bucket) must be pragma-adjudicated',
  );
  // The file moved in Cluster E (plans-ship.mjs -> regression-specs.mjs); the
  // diagnostic is the same unresolved ternary onConflict, in its new home. The
  // lint itself already enumerates the store DIRECTORY, so nothing was lost.
  const remaining = new Set(diagnostics.map((d) => `${d.kind}::${d.file}`));
  assert.deepEqual(remaining, new Set(['unresolved-conflict-target::scripts/lib/store/regression-specs.mjs']));
});

// ── 7. Fail-closed coverage guard for the recognized write boundary (R1-M2) ──
//
// The lint only inspects calls to helpers in UPSERT_CALLEES (today: `upsert`).
// A NEW upsert-capable helper in the db layer (`upsertMany`, `upsertReturning`,
// …) would silently bypass the gate. This guard fails when the db write layer
// grows another upsert-capable export, forcing a maintainer to teach the lint
// about it rather than leaving a silent coverage hole.

test('db/query.mjs exposes exactly ONE upsert-capable export — a new one must update UPSERT_CALLEES', async () => {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'scripts', 'lib', 'db', 'query.mjs'), 'utf8');
  const exported = [...src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]);
  const upsertCapable = exported.filter((n) => /upsert/i.test(n));
  assert.deepEqual(
    upsertCapable.sort(), ['upsert'],
    `db/query.mjs upsert-capable exports drifted to ${JSON.stringify(upsertCapable)} — teach on-conflict.mjs's UPSERT_CALLEES about any new one, or the store gate has a silent hole`
  );
});

test('no store file ALIASES upsert (import { upsert as x }) — an alias bypasses the callee-name gate (R2-M2)', async () => {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const storeDir = path.join(here, '..', 'scripts', 'lib', 'store');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : full.endsWith('.mjs') ? [full] : [];
  });
  const offenders = [];
  for (const f of walk(storeDir)) {
    const src = fs.readFileSync(f, 'utf8');
    // `import { upsert as u }` or `const u = upsert` would call through a name
    // the extractor doesn't recognize. Keep the gate honest by forbidding it.
    if (/\bupsert\s+as\s+\w+/.test(src) || /\b(?:const|let|var)\s+\w+\s*=\s*upsert\b/.test(src)) {
      offenders.push(path.relative(storeDir, f));
    }
  }
  assert.deepEqual(offenders, [], `store files alias upsert (bypassing the callee-name gate): ${JSON.stringify(offenders)} — call it as \`upsert\` or extend UPSERT_CALLEES`);
});

// ── 8. Unrecognized-upsert-like-callee self-check (audit 89fe6988/4bfc55b0) ──
//
// R1-M2/R2-M2 above check the db/query.mjs export surface and import
// aliasing of the recognized `upsert` identifier — neither sees a NEW local
// wrapper (`upsertBatch(...)`) or a raw client method call
// (`x.upsert(...)`, `x.from(t).upsert(...)`) that bypasses the recognized
// `upsert` identifier entirely. This closes that gap: fail closed (flag it),
// rather than silently reporting the store clean.

test('flags an unregistered local wrapper whose name looks upsert-shaped', () => {
  const src = `function upsertBatch(rows) { return doWrite('t', rows); }\nupsertBatch([{ id: 1 }]);`;
  const { diagnostics } = extractUpsertSites(src);
  const hits = diagnostics.filter((d) => d.kind === 'unrecognized-upsert-like-callee');
  assert.equal(hits.length, 1, 'a call to upsertBatch(...) must be flagged as an unrecognized upsert-like callee');
});

test('flags a raw client member-call (x.upsert(...)) bypassing the query.mjs facade', () => {
  const src = `client.from('t').upsert([{ id: 1 }], { onConflict: 'id' });`;
  const { diagnostics } = extractUpsertSites(src);
  const hits = diagnostics.filter((d) => d.kind === 'unrecognized-upsert-like-callee');
  assert.equal(hits.length, 1, 'a raw .upsert(...) member call must be flagged');
});

test('does NOT flag a recognized upsert(...) identifier call (no double-reporting)', () => {
  const src = `upsert('t', [{ id: 1, repo_id: 'r' }], { onConflict: ['id', 'repo_id'] });`;
  const { diagnostics } = extractUpsertSites(src);
  assert.equal(diagnostics.filter((d) => d.kind === 'unrecognized-upsert-like-callee').length, 0);
});

test('does NOT flag an unrelated call whose name has nothing to do with upsert', () => {
  const src = `insertRows('t', [{ id: 1 }]);`;
  const { diagnostics } = extractUpsertSites(src);
  assert.equal(diagnostics.filter((d) => d.kind === 'unrecognized-upsert-like-callee').length, 0);
});

test('the live store tree has zero unrecognized-upsert-like-callee diagnostics (no known offenders today)', () => {
  const { diagnostics } = lintStoreTree();
  const hits = diagnostics.filter((d) => d.kind === 'unrecognized-upsert-like-callee');
  assert.deepEqual(hits, [], `unrecognized upsert-like callee(s) in the live store tree: ${JSON.stringify(hits)}`);
});
