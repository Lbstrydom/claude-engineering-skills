/**
 * @fileoverview Assembly-level egress test (plan D3).
 *
 * The gate (`tests/sensitive-egress.test.mjs`) tests the sensitive-path
 * classifier in isolation. This tests the *composition* that real audits use:
 * `readFilesAsContext` → `safeReadFile` → realpath containment — the chain that
 * assembles the LLM audit payload. An egress regression at this integration
 * point would not be caught by the gate-level tests.
 *
 * Ground-truth signatures (read from scripts/lib/audit-scope.mjs):
 *  - `safeReadFile(relPath, cwdBoundary)` resolves relPath against the PROCESS
 *    cwd, then rejects any realpath escaping cwdBoundary (+ sensitive + size).
 *  - `readFilesAsContext(filePaths, opts)` filters sensitive paths, delegates
 *    per-file reads to safeReadFile with cwdBoundary = path.resolve('.'), and
 *    appends a "[N sensitive file(s) excluded …]" footer when it drops any.
 *  - `classifyFiles` does NOT filter sensitive files (pure routing) — not tested
 *    for egress here.
 *
 * Plan: docs/plans/testing-doctrine-and-egress-relocation-gaps.md (D3).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isSensitiveFile,
  safeReadFile,
  readFilesAsContext,
} from '../scripts/lib/audit-scope.mjs';

const BENIGN_MARKER = 'BENIGN_MARKER_aaa';
const SECRET_MARKER = 'SECRET_TOKEN_zzz';

function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('readFilesAsContext includes benign content and excludes a sensitive file (two-sided)', (t) => {
  const dir = mkdtemp('audit-scope-egress-');
  const prevCwd = process.cwd();
  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  fs.writeFileSync(path.join(dir, 'benign.js'), `export const x = "${BENIGN_MARKER}";\n`);
  fs.writeFileSync(path.join(dir, '.env'), `API_KEY=${SECRET_MARKER}\n`);

  // readFilesAsContext uses cwdBoundary = path.resolve('.'), so chdir in.
  process.chdir(dir);
  const out = readFilesAsContext(['benign.js', '.env']);

  // (a) benign content + header present → proves real, non-empty inclusion.
  assert.ok(out.includes(BENIGN_MARKER), 'benign content must be included');
  assert.ok(out.includes('### benign.js'), 'benign file header must be present');
  // (b) secret content + header absent → the leak invariant.
  assert.ok(!out.includes(SECRET_MARKER), 'secret content must NOT leak into the assembled context');
  assert.ok(!out.includes('### .env'), '.env must not appear as an included file header');
  // (c) exclusion footer present → proves active exclusion, not a silent empty return.
  assert.match(out, /sensitive file\(s\) excluded/, 'must report the sensitive exclusion (not silently drop)');
});

test('safeReadFile fail-closed: rejects a symlink whose realpath escapes the boundary', (t) => {
  if (process.platform === 'win32') return; // symlink semantics differ; mirrors sensitive-egress skipOnWin
  const boundary = mkdtemp('audit-scope-bound-');
  const outside = mkdtemp('audit-scope-outside-');
  const prevCwd = process.cwd();
  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(boundary, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const secret = path.join(outside, 'secret.txt');
  fs.writeFileSync(secret, 'pretend secret');
  fs.symlinkSync(secret, path.join(boundary, 'notes.txt'));

  // safeReadFile resolves relPath against process.cwd(), using boundary only as
  // the containment check — so chdir into boundary to exercise the escape branch.
  process.chdir(boundary);
  const result = safeReadFile('notes.txt', boundary);
  assert.equal(result, null, 'a symlink resolving outside the boundary must be rejected (null)');
});

test('readFilesAsContext (end-to-end chain) excludes a symlink escaping cwd', (t) => {
  // Covers the full assembly chain — readFilesAsContext → safeReadFile →
  // realpath containment — not just safeReadFile in isolation. A regression
  // where readFilesAsContext stops delegating containment would surface here.
  if (process.platform === 'win32') return; // mirrors sensitive-egress skipOnWin
  const dir = mkdtemp('audit-scope-chain-');
  const outside = mkdtemp('audit-scope-chain-out-');
  const prevCwd = process.cwd();
  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const secret = path.join(outside, 'escape.txt');
  fs.writeFileSync(secret, `LEAK_VIA_SYMLINK_${SECRET_MARKER}`);
  fs.symlinkSync(secret, path.join(dir, 'link.txt'));

  process.chdir(dir);
  const out = readFilesAsContext(['link.txt']);
  assert.ok(!out.includes('LEAK_VIA_SYMLINK'), 'a symlink escaping cwd must not leak its target content through the full chain');
  assert.ok(!out.includes('### link.txt'), 'the escaping symlink must not be emitted as an included block');
});

// NOTE: the cwd-mutating tests above are sequential-only (node --test runs
// tests within a file sequentially by default). Do not add `concurrency` here
// without removing the process.chdir() — readFilesAsContext resolves its
// boundary from path.resolve('.'), so the chdir is intrinsic to exercising it.
test('sensitive path is excluded at the integration layer', () => {
  // One integration assertion — pattern enumeration stays in sensitive-paths.test.mjs (DRY).
  assert.equal(isSensitiveFile('.env'), true);
  assert.equal(readFilesAsContext(['.env']).includes('### .env'), false);
});
