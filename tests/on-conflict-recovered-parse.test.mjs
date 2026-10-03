/**
 * @fileoverview Defect 91d3f4eb — a RECOVERED parse (parseSource's outcome 2:
 * partial AST, `error: null`, `recoveredErrors` non-empty) linted exactly like
 * a clean file, and `--strict` did not gate the `parse-error` diagnostic that a
 * HARD parse failure does produce. Two halves: the extractor/lint surface the
 * recovery, and the strict predicate treats `parse-error` as a failure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { extractUpsertSites, lintSource, isStrictFailureDiagnostic } from '../scripts/lib/lint/on-conflict.mjs';
import { parseSource } from '../scripts/lib/ast.mjs';

// `let a` after `const a` is a redeclaration: Babel recovers (1 error), keeps the AST.
const RECOVERED_PREFIX = 'const a = 1; let a = 2;\n';
const NULLABLE_UPSERT = "upsert('t', [{ repo_id: x || null, k: 1 }], { onConflict: ['repo_id', 'k'] });\n";

test('instrument check: the fixture really is a recovered parse (ast kept, error null, 1 recovered error)', () => {
  const r = parseSource(RECOVERED_PREFIX + NULLABLE_UPSERT);
  assert.ok(r.ast, 'a partial AST must be returned');
  assert.equal(r.error, null);
  assert.equal(r.recoveredErrors.length, 1);
});

test('a recovered parse is reported as a parse-error diagnostic, naming the count and the first message', () => {
  const { diagnostics } = lintSource('store/x.mjs', RECOVERED_PREFIX + NULLABLE_UPSERT);
  const pe = diagnostics.filter((d) => d.kind === 'parse-error');
  assert.equal(pe.length, 1, `expected one parse-error, got ${JSON.stringify(diagnostics)}`);
  assert.match(pe[0].message, /^recovered parse \(1\): .*already been declared/);
  assert.equal(pe[0].file, 'store/x.mjs');
});

test('the sites in a recovered parse are STILL analysed — the provable finding is not hidden by the diagnostic', () => {
  const { sites, parseError } = extractUpsertSites(RECOVERED_PREFIX + NULLABLE_UPSERT);
  assert.equal(sites.length, 1);
  assert.match(parseError, /^recovered parse \(1\):/);
  const { findings } = lintSource('store/x.mjs', RECOVERED_PREFIX + NULLABLE_UPSERT);
  assert.deepEqual(findings.map((f) => [f.rule, f.column]), [['nullable-conflict-key', 'repo_id']]);
});

test('negative control: a clean file has no parse-error diagnostic and a null parseError', () => {
  const clean = "const a = 1;\n" + NULLABLE_UPSERT;
  assert.equal(extractUpsertSites(clean).parseError, null);
  assert.equal(lintSource('store/x.mjs', clean).diagnostics.filter((d) => d.kind === 'parse-error').length, 0);
});

test('a HARD parse failure still reports its own message unchanged (not relabelled "recovered")', () => {
  assert.equal(parseSource('upsert(\n').ast, null, 'instrument check: this fixture is a hard failure, not a recovery');
  const { diagnostics } = lintSource('store/x.mjs', 'upsert(\n');
  const pe = diagnostics.filter((d) => d.kind === 'parse-error');
  assert.equal(pe.length, 1);
  assert.match(pe[0].message, /^Unexpected token/);
  assert.doesNotMatch(pe[0].message, /recovered parse/);
});

test('--strict predicate: parse-error and unresolved-* fail; other advisory kinds do not', () => {
  assert.equal(isStrictFailureDiagnostic({ kind: 'parse-error' }), true);
  assert.equal(isStrictFailureDiagnostic({ kind: 'unresolved-upsert-rows' }), true);
  assert.equal(isStrictFailureDiagnostic({ kind: 'unresolved-conflict-key-nullability' }), true);
  for (const kind of ['indeterminate-row', 'orphaned-suppression', 'unrecognized-upsert-like-callee', 'malformed-suppression']) {
    assert.equal(isStrictFailureDiagnostic({ kind }), false, kind);
  }
  assert.equal(isStrictFailureDiagnostic({}), false);
  assert.equal(isStrictFailureDiagnostic(undefined), false);
});

test('end to end: the recovered-parse diagnostic from lintSource is exactly what --strict gates on', () => {
  const { diagnostics } = lintSource('store/x.mjs', RECOVERED_PREFIX + NULLABLE_UPSERT);
  assert.ok(diagnostics.some(isStrictFailureDiagnostic), 'strict would exit 3 for this file');
  const clean = lintSource('store/x.mjs', 'const a = 1;\n' + NULLABLE_UPSERT);
  assert.equal(clean.diagnostics.some(isStrictFailureDiagnostic), false);
});

test('the CLI gates --strict through the shared predicate (wiring pin, with a negative control)', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'scripts', 'on-conflict-lint.mjs'), 'utf-8');
  const wired = /diagnostics\.filter\(isStrictFailureDiagnostic\)/;
  assert.match(src, wired, 'the strict filter must be the shared predicate — a private startsWith("unresolved") filter drops parse-error');
  const reverted = src.replace(wired, "diagnostics.filter((d) => d.kind?.startsWith('unresolved'))");
  assert.doesNotMatch(reverted, wired, 'instrument check: the pin fails on the pre-fix filter');
  assert.match(src, /import \{[^}]*isStrictFailureDiagnostic[^}]*\} from '\.\/lib\/lint\/on-conflict\.mjs'/);
});

test('the live store tree contains no parse-error diagnostic (the new recovery path adds no noise there)', () => {
  const cli = path.resolve(import.meta.dirname, '..', 'scripts', 'on-conflict-lint.mjs');
  const r = spawnSync(process.execPath, [cli, '--all', '--json'], { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
  const report = JSON.parse(r.stdout);
  assert.ok(report.filesScanned > 0, 'vacuous-pass guard: the tree was actually scanned');
  assert.deepEqual(report.diagnostics.filter((d) => d.kind === 'parse-error'), []);
});
