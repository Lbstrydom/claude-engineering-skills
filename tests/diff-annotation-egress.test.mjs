/**
 * @fileoverview Assembly-level egress test for readFilesAsAnnotatedContext —
 * the sibling implementation to audit-scope-egress.test.mjs's readFilesAsContext
 * coverage. Two separate implementations both needed the identical
 * redact-by-default fix (Gemini round-2 M3, deferred as an independent DRY
 * gap, not this plan's job) — this file locks the annotated-context path
 * specifically, including the diff-hunk boundary interaction that the plain
 * (non-annotated) path doesn't have to worry about.
 *
 * Plan: docs/plans/discovery-portfolio-secret-redaction.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { readFilesAsAnnotatedContext, _annotationMarkers } from '../scripts/lib/diff-annotation.mjs';
import { assertEgressSafe } from '../scripts/lib/sensitive-egress-gate.mjs';
import { mkdtemp } from './helpers/fixtures.mjs';

/** Escape a literal string for safe interpolation into a RegExp. */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const DSN = 'postgresql://user:hunter2@host.example.com/db';

test('readFilesAsAnnotatedContext default (redact:true) redacts a secret-shaped string', (t) => {
  const dir = mkdtemp('diff-annot-redact-default-');
  const prevCwd = process.cwd();
  t.after(() => { process.chdir(prevCwd); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  fs.writeFileSync(path.join(dir, 'app.js'), `const dsn = "${DSN}";\nconst x = 1;\n`);
  const diffMap = new Map([['app.js', { hunks: [{ startLine: 2, lineCount: 1 }] }]]);

  process.chdir(dir);
  const out = readFilesAsAnnotatedContext(['app.js'], diffMap);

  assert.ok(!out.includes('hunter2'), 'the DSN password must be redacted by default');
  assert.ok(out.includes('[REDACTED:dsn-password]'), 'a redaction marker must be present');
});

test('readFilesAsAnnotatedContext with explicit redact:false preserves the raw secret', (t) => {
  const dir = mkdtemp('diff-annot-redact-optout-');
  const prevCwd = process.cwd();
  t.after(() => { process.chdir(prevCwd); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  fs.writeFileSync(path.join(dir, 'app.js'), `const dsn = "${DSN}";\nconst x = 1;\n`);
  const diffMap = new Map([['app.js', { hunks: [{ startLine: 2, lineCount: 1 }] }]]);

  process.chdir(dir);
  const out = readFilesAsAnnotatedContext(['app.js'], diffMap, { redact: false });

  assert.ok(out.includes(DSN), 'redact:false must preserve the raw secret verbatim');
});

test('full chain: readFilesAsAnnotatedContext (default redact) → assertEgressSafe does not throw', (t) => {
  const dir = mkdtemp('diff-annot-fullchain-');
  const prevCwd = process.cwd();
  t.after(() => { process.chdir(prevCwd); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  fs.writeFileSync(path.join(dir, 'app.js'), `const dsn = "${DSN}";\nconst x = 1;\n`);
  const diffMap = new Map([['app.js', { hunks: [{ startLine: 2, lineCount: 1 }] }]]);

  process.chdir(dir);
  const out = readFilesAsAnnotatedContext(['app.js'], diffMap);

  assert.doesNotThrow(() => assertEgressSafe(out, { label: 'test' }));
});

test('unredacted output correctly reports egressSafe:false with dsn-password (named expected values, L3 fix)', (t) => {
  const dir = mkdtemp('diff-annot-egresssafe-');
  const prevCwd = process.cwd();
  t.after(() => { process.chdir(prevCwd); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  fs.writeFileSync(path.join(dir, 'app.js'), `const dsn = "${DSN}";\nconst x = 1;\n`);
  const diffMap = new Map([['app.js', { hunks: [{ startLine: 2, lineCount: 1 }] }]]);

  process.chdir(dir);
  const out = readFilesAsAnnotatedContext(['app.js'], diffMap, { redact: false });

  assert.throws(
    () => assertEgressSafe(out, { label: 'test' }),
    /dsn-password/,
    'the unredacted path must throw with dsn-password named in the error',
  );
});

test('multi-line PEM redaction does not desync diff-hunk CHANGED/UNCHANGED annotation markers (Gemini round 2+3 fix)', (t) => {
  const dir = mkdtemp('diff-annot-pem-boundary-');
  const prevCwd = process.cwd();
  t.after(() => { process.chdir(prevCwd); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  const headerLines = Array.from({ length: 5 }, (_, i) => `const a${i} = 1;`);
  const pemLines = [
    '-----BEGIN RSA PRIVATE KEY-----',
    ...Array.from({ length: 10 }, (_, i) => `b64line${i}`),
    '-----END RSA PRIVATE KEY-----',
  ];
  const changedLines = Array.from({ length: 5 }, (_, i) => `const b${i} = ${i};`);
  const allLines = [...headerLines, ...pemLines, ...changedLines];
  fs.writeFileSync(path.join(dir, 'app.js'), allLines.join('\n'));

  // Computed, not hand-counted: the changed hunk starts right after the
  // header + PEM block, 1-indexed against the ORIGINAL (pre-redaction) file.
  const startLine = headerLines.length + pemLines.length + 1;
  const diffMap = new Map([['app.js', { hunks: [{ startLine, lineCount: changedLines.length }] }]]);

  process.chdir(dir);
  const out = readFilesAsAnnotatedContext(['app.js'], diffMap);

  assert.ok(out.includes('[REDACTED:pem-private-key]'), 'PEM block must be redacted');

  const changedBlockMatch = out.match(/\/\/ ── CHANGED ──([\s\S]*?)\/\/ ── END CHANGED ──/);
  assert.ok(changedBlockMatch, 'a CHANGED block must be present');
  for (let i = 0; i < changedLines.length; i++) {
    assert.ok(
      changedBlockMatch[1].includes(`const b${i} = ${i};`),
      `const b${i} must fall inside the CHANGED block (line-count-preserving redaction keeps hunk ranges aligned)`,
    );
  }

  // Markers are LINE comments (2026-07-26 — a block-comment marker corrupts any
  // file whose hunk boundary falls inside a JSDoc; see
  // tests/diff-annotation-marker-safety.test.mjs). Derived from the exported
  // marker constants rather than re-hardcoded, so the next format change updates
  // this matcher instead of silently zeroing it out.
  const unchangedBlocks = [...out.matchAll(
    new RegExp(`${escapeRe(_annotationMarkers.UNCHANGED_OPEN)}\\n([\\s\\S]*?)${escapeRe(_annotationMarkers.UNCHANGED_CLOSE)}`, 'g'),
  )].map(m => m[1]);
  // NON-VACUITY GUARD. Without this the whole check below is a no-op when the
  // matcher stops matching: the loop body simply never runs and the test reads
  // green having verified nothing. That is exactly what happened when the marker
  // format changed under the old hardcoded regex — this test passed while
  // checking zero blocks. "Can this go green without checking anything?" is the
  // repo's own success-path rule (AGENTS.md); here the answer must be no.
  assert.ok(
    unchangedBlocks.length > 0,
    'precondition: at least one UNCHANGED block must be found — a zero match makes the leak assertions below vacuous',
  );
  for (const block of unchangedBlocks) {
    for (let i = 0; i < changedLines.length; i++) {
      assert.ok(!block.includes(`const b${i} = ${i};`), `const b${i} must NOT leak into an UNCHANGED block`);
    }
  }
});
