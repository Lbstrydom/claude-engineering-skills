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
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeUpsert,
  isNullableExpr,
  extractUpsertSites,
  lintSource,
  lintStoreTree,
  filterFindingsToDiff,
  SCOPE_COLUMNS,
} from '../scripts/lib/lint/on-conflict.mjs';

// ── 1. analyzeUpsert — the instance matrix (pure data) ─────────────────────

test('instance 1 (false_positive_patterns): a nullable column IN the conflict target is flagged', () => {
  const f = analyzeUpsert({
    table: 'false_positive_patterns',
    columns: ['repo_id', 'pattern_value'],
    columnExprs: { repo_id: { nullable: true }, pattern_value: { nullable: false } },
    conflictTarget: ['repo_id', 'pattern_value'],
  });
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'nullable-conflict-key');
  assert.equal(f[0].column, 'repo_id');
});

test('instance 2 (bandit_arms): context_bucket nullable in its conflict target is flagged', () => {
  const f = analyzeUpsert({
    table: 'bandit_arms',
    columns: ['pass_name', 'variant_id', 'context_bucket'],
    columnExprs: { context_bucket: { nullable: true } },
    conflictTarget: ['pass_name', 'variant_id', 'context_bucket'],
  });
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'nullable-conflict-key');
  assert.equal(f[0].column, 'context_bucket');
});

test('instance 3 (prompt_variants): a stored scope column OMITTED from the target is flagged', () => {
  const f = analyzeUpsert({
    table: 'prompt_variants',
    columns: ['repo_id', 'pass_name', 'variant_name'],
    columnExprs: { repo_id: { nullable: true } },
    conflictTarget: ['pass_name', 'variant_name'],
  });
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'omitted-scope-identity');
  assert.equal(f[0].column, 'repo_id');
});

test('MIRROR of 1/2: the FIXED writers (non-null conflict-key column) are NOT flagged', () => {
  // bandit_arms fix: context_bucket || GLOBAL_CONTEXT_BUCKET → never null.
  assert.equal(analyzeUpsert({
    table: 'bandit_arms', columns: ['pass_name', 'variant_id', 'context_bucket'],
    columnExprs: { context_bucket: { nullable: false } },
    conflictTarget: ['pass_name', 'variant_id', 'context_bucket'],
  }).length, 0);
  // FP fix: repo_id: repoUuid (guaranteed non-null), and it's IN the target.
  assert.equal(analyzeUpsert({
    table: 'false_positive_patterns', columns: ['repo_id', 'pattern_value'],
    columnExprs: { repo_id: { nullable: false } },
    conflictTarget: ['repo_id', 'pattern_type', 'pattern_value'],
  }).length, 0);
});

test('a plain insert (no onConflict) is never flagged — neither rule applies', () => {
  assert.equal(analyzeUpsert({
    table: 'security_strategy_events', columns: ['repo_id', 'incident_id'],
    columnExprs: { repo_id: { nullable: true } }, conflictTarget: null,
  }).length, 0);
});

test('omitted-scope is a heuristic that FIRES on a surrogate-key writer — this is why drift+pragma exist', () => {
  // persona_test_sessions: conflict [session_id] (globally unique); repo_id is
  // metadata → design-correct, but the rule cannot know that from the row. The
  // finding is expected; drift keeps it from gating, a pragma documents it.
  const f = analyzeUpsert({
    table: 'persona_test_sessions', columns: ['session_id', 'repo_id', 'repo_name'],
    columnExprs: {}, conflictTarget: ['session_id'],
  });
  assert.equal(f.length, 2); // repo_id + repo_name
  assert.deepEqual(f.map((x) => x.column).sort(), ['repo_id', 'repo_name']);
});

test('SCOPE_COLUMNS is the small explicit set — a non-scope column omitted is NOT flagged', () => {
  assert.ok(SCOPE_COLUMNS.has('repo_id') && SCOPE_COLUMNS.has('user_id') && SCOPE_COLUMNS.has('repo_name'));
  const f = analyzeUpsert({
    table: 't', columns: ['session_id', 'checksum'], columnExprs: {}, conflictTarget: ['session_id'],
  });
  assert.equal(f.length, 0); // checksum is not a scope column
});

// ── 2. Nullability precision — separates the FIX from the BUG ───────────────
//
// Exercised through the real extraction path (columnExprs[col].nullable is the
// isNullableExpr result), which is what the analyzer actually consumes.

test('nullability: literal null / || null / ?? null / undefined / nullable-ternary are nullable', () => {
  for (const src of ['null', 'x || null', 'x ?? null', 'undefined', 'x ? a : null']) {
    const { sites } = extractUpsertSites(`upsert('t', [{ k: ${src} }], { onConflict: ['k'] });`);
    assert.equal(sites[0].columnExprs.k.nullable, true, `${src} should be nullable`);
  }
});

test('nullability: a non-null sentinel fallback / bare identifier / literal is NOT nullable (the bandit fix)', () => {
  for (const src of ['arm.contextBucket || GLOBAL_CONTEXT_BUCKET', 'repoId', "'literal'", 'x ? a : b']) {
    const { sites } = extractUpsertSites(`upsert('t', [{ k: ${src} }], { onConflict: ['k'] });`);
    assert.equal(sites[0].columnExprs.k.nullable, false, `${src} should NOT be nullable`);
  }
});

test('isNullableExpr is exported and returns false on a non-node', () => {
  assert.equal(isNullableExpr(null), false);
  assert.equal(isNullableExpr({}), false);
});

test('nullability: `&&` is nullable if EITHER operand is (not just the right — audit R1-M1)', () => {
  // `null && x` evaluates to null; the right-only rule missed this.
  const left = extractUpsertSites(`upsert('t', [{ k: maybeNull && fallback }], { onConflict: ['k'] });`);
  // `maybeNull` alone isn't statically nullable, so this stays false — but a
  // literal-null left operand IS:
  assert.equal(left.sites[0].columnExprs.k.nullable, false);
  const nullLeft = extractUpsertSites(`upsert('t', [{ k: null && x }], { onConflict: ['k'] });`);
  assert.equal(nullLeft.sites[0].columnExprs.k.nullable, true, 'null && x is null');
  const nullRight = extractUpsertSites(`upsert('t', [{ k: x && null }], { onConflict: ['k'] });`);
  assert.equal(nullRight.sites[0].columnExprs.k.nullable, true, 'x && null is null');
});

// ── 2b. Spread rows: check the provable, flag the unseeable as indeterminate ──

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
  assert.equal(sites[0].columnExprs.repo_id.nullable, true);
  assert.deepEqual(sites[0].conflictTarget, ['repo_id', 'path']);
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
  assert.equal(sites[0].columnExprs.context_bucket.nullable, true);
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

// ── 4. Suppression pragma ──────────────────────────────────────────────────

test('a reasoned @on-conflict-ok pragma moves a finding to suppressed, not gating', () => {
  const src = `
    // @on-conflict-ok: session_id is globally unique; repo_id is metadata
    upsert('persona_test_sessions', [{ session_id: s, repo_id: r }], { onConflict: ['session_id'] });`;
  const { findings, suppressed } = lintSource('x.mjs', src);
  assert.equal(findings.length, 0);
  assert.equal(suppressed.length, 1);
  assert.match(suppressed[0].suppressionReason, /globally unique/);
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
