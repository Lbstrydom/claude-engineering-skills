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
 * Plan: docs/completed/testing-doctrine-and-egress-relocation-gaps.md (D3).
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
  buildRedactedAuditContext,
} from '../scripts/lib/audit-scope.mjs';
import { assertEgressSafe } from '../scripts/lib/sensitive-egress-gate.mjs';

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
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
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

test('readFilesAsContext redacts a same-string-collision DSN at the real secret position, not an earlier coincidental occurrence (2026-07-16)', (t) => {
  const dir = mkdtemp('audit-scope-egress-collision-');
  const prevCwd = process.cwd();
  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  fs.writeFileSync(path.join(dir, 'dsn.js'), 'export const url = "postgresql://admin:admin@realhost.example.com:5432/prod";\n');
  process.chdir(dir);
  const out = readFilesAsContext(['dsn.js']);

  assert.ok(out.includes('postgresql://admin:[REDACTED:dsn-password]@realhost.example.com:5432/prod'), 'the real password position must be redacted');
  assert.ok(!out.includes(':admin@'), 'the real password must not survive in plaintext at ANY position');
});

test('safeReadFile fail-closed: rejects a symlink whose realpath escapes the boundary', (t) => {
  if (process.platform === 'win32') return; // symlink semantics differ; mirrors sensitive-egress skipOnWin
  const boundary = mkdtemp('audit-scope-bound-');
  const outside = mkdtemp('audit-scope-outside-');
  const prevCwd = process.cwd();
  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(boundary, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    fs.rmSync(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
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
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    fs.rmSync(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
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

// ── Discovery-portfolio secret-redaction fixes ──────────────────────────
// Plan: docs/plans/discovery-portfolio-secret-redaction.md.
// A secret-shaped string INSIDE an otherwise-ordinary, non-sensitive-path
// file (a CI workflow's placeholder DB password, etc.) was not caught by
// the path-level isSensitiveFile filter above — these tests cover that gap.

const DSN = 'postgresql://user:hunter2@host.example.com/db';

test('readFilesAsContext default (redact:true) redacts a secret-shaped string inside an ordinary file', (t) => {
  const dir = mkdtemp('audit-scope-redact-default-');
  const prevCwd = process.cwd();
  t.after(() => { process.chdir(prevCwd); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  fs.writeFileSync(path.join(dir, 'ci.yml'), `env:\n  DB_URL: ${DSN}\n`);
  process.chdir(dir);
  const out = readFilesAsContext(['ci.yml']);

  assert.ok(!out.includes('hunter2'), 'the DSN password must be redacted by default');
  assert.ok(out.includes('[REDACTED:dsn-password]'), 'a redaction marker must be present');
  assert.ok(out.includes('### ci.yml'), 'the file itself must still be included (only content is redacted, not path-excluded)');
});

test('readFilesAsContext with explicit redact:false is byte-identical to pre-plan behaviour', (t) => {
  const dir = mkdtemp('audit-scope-redact-optout-');
  const prevCwd = process.cwd();
  t.after(() => { process.chdir(prevCwd); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  fs.writeFileSync(path.join(dir, 'ci.yml'), `env:\n  DB_URL: ${DSN}\n`);
  process.chdir(dir);
  const out = readFilesAsContext(['ci.yml'], { redact: false });

  assert.ok(out.includes(DSN), 'redact:false must preserve the raw secret verbatim');
});

test('a secret spanning the truncation boundary is fully redacted, not leaked as a partial prefix (H2 regression guard)', (t) => {
  const dir = mkdtemp('audit-scope-boundary-');
  const prevCwd = process.cwd();
  t.after(() => { process.chdir(prevCwd); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  // maxPerFile lands partway through the DSN's password segment — if
  // truncation ran BEFORE redaction (the pre-fix order), the retained
  // prefix would contain an un-redacted partial password fragment.
  const content = 'x'.repeat(40) + DSN + 'y'.repeat(40);
  fs.writeFileSync(path.join(dir, 'app.js'), content);
  process.chdir(dir);
  const out = readFilesAsContext(['app.js'], { maxPerFile: 55 });

  assert.ok(!out.includes('hunter2'), 'no fragment of the password may survive truncation');
});

test('buildRedactedAuditContext still returns UNREDACTED content + correct egress flags (decision 11 — model-A/B/C fairness)', (t) => {
  const dir = mkdtemp('audit-scope-decision11-');
  const prevCwd = process.cwd();
  t.after(() => { process.chdir(prevCwd); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  fs.writeFileSync(path.join(dir, 'app.js'), `const dsn = "${DSN}";\n`);
  process.chdir(dir);
  const result = buildRedactedAuditContext(['app.js']);

  assert.ok(result.context.includes('hunter2'), 'buildRedactedAuditContext must still see raw content — the new safe default must NOT apply here');
  assert.equal(result.egressSafe, false);
  assert.ok(result.egressPatterns.includes('dsn-password'));
});

test('full chain: readFilesAsContext (default redact) → assertEgressSafe does not throw', (t) => {
  const dir = mkdtemp('audit-scope-fullchain-');
  const prevCwd = process.cwd();
  t.after(() => { process.chdir(prevCwd); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  fs.writeFileSync(path.join(dir, 'app.js'), `const dsn = "${DSN}";\n`);
  process.chdir(dir);
  const out = readFilesAsContext(['app.js']);

  assert.doesNotThrow(() => assertEgressSafe(out, { label: 'test' }));
});
