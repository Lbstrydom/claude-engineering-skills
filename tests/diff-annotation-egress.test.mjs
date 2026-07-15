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
import os from 'node:os';
import path from 'node:path';

import { readFilesAsAnnotatedContext } from '../scripts/lib/diff-annotation.mjs';
import { assertEgressSafe } from '../scripts/lib/sensitive-egress-gate.mjs';

const DSN = 'postgresql://user:hunter2@host.example.com/db';

function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('readFilesAsAnnotatedContext default (redact:true) redacts a secret-shaped string', (t) => {
  const dir = mkdtemp('diff-annot-redact-default-');
  const prevCwd = process.cwd();
  t.after(() => { process.chdir(prevCwd); fs.rmSync(dir, { recursive: true, force: true }); });

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
  t.after(() => { process.chdir(prevCwd); fs.rmSync(dir, { recursive: true, force: true }); });

  fs.writeFileSync(path.join(dir, 'app.js'), `const dsn = "${DSN}";\nconst x = 1;\n`);
  const diffMap = new Map([['app.js', { hunks: [{ startLine: 2, lineCount: 1 }] }]]);

  process.chdir(dir);
  const out = readFilesAsAnnotatedContext(['app.js'], diffMap, { redact: false });

  assert.ok(out.includes(DSN), 'redact:false must preserve the raw secret verbatim');
});

test('full chain: readFilesAsAnnotatedContext (default redact) → assertEgressSafe does not throw', (t) => {
  const dir = mkdtemp('diff-annot-fullchain-');
  const prevCwd = process.cwd();
  t.after(() => { process.chdir(prevCwd); fs.rmSync(dir, { recursive: true, force: true }); });

  fs.writeFileSync(path.join(dir, 'app.js'), `const dsn = "${DSN}";\nconst x = 1;\n`);
  const diffMap = new Map([['app.js', { hunks: [{ startLine: 2, lineCount: 1 }] }]]);

  process.chdir(dir);
  const out = readFilesAsAnnotatedContext(['app.js'], diffMap);

  assert.doesNotThrow(() => assertEgressSafe(out, { label: 'test' }));
});

test('unredacted output correctly reports egressSafe:false with dsn-password (named expected values, L3 fix)', (t) => {
  const dir = mkdtemp('diff-annot-egresssafe-');
  const prevCwd = process.cwd();
  t.after(() => { process.chdir(prevCwd); fs.rmSync(dir, { recursive: true, force: true }); });

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
  t.after(() => { process.chdir(prevCwd); fs.rmSync(dir, { recursive: true, force: true }); });

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

  const unchangedBlocks = [...out.matchAll(
    /\/\* ━━━━ UNCHANGED CONTEXT.*?━━━━ \*\/([\s\S]*?)\/\* ━━━━ END UNCHANGED CONTEXT ━━━━ \*\//g,
  )].map(m => m[1]);
  for (const block of unchangedBlocks) {
    for (let i = 0; i < changedLines.length; i++) {
      assert.ok(!block.includes(`const b${i} = ${i};`), `const b${i} must NOT leak into an UNCHANGED block`);
    }
  }
});
