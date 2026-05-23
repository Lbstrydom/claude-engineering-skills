import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isPathSensitive,
  isExtensionAllowlisted,
  containsSecrets,
  redactSecrets,
  gateSymbolForEgress,
  SECRET_REDACTED,
} from '../scripts/lib/sensitive-egress-gate.mjs';

describe('isPathSensitive', () => {
  it('blocks .env and variants', () => {
    assert.ok(isPathSensitive('.env'));
    assert.ok(isPathSensitive('.env.local'));
    assert.ok(isPathSensitive('.env.production'));
    assert.ok(isPathSensitive('packages/app/.env'));
  });
  it('blocks key files', () => {
    assert.ok(isPathSensitive('keys/server.pem'));
    assert.ok(isPathSensitive('id_rsa'));
    assert.ok(isPathSensitive('id_rsa.pub'));
    assert.ok(isPathSensitive('certs/cert.crt'));
  });
  it('blocks secrets/ and credentials*', () => {
    assert.ok(isPathSensitive('secrets/api.key'));
    assert.ok(isPathSensitive('config/credentials.json'));
  });
  it('blocks lockfiles (low signal, large noise)', () => {
    assert.ok(isPathSensitive('package-lock.json'));
    assert.ok(isPathSensitive('yarn.lock'));
  });
  it('lets normal source through', () => {
    assert.equal(isPathSensitive('scripts/openai-audit.mjs'), false);
    assert.equal(isPathSensitive('src/components/Modal.tsx'), false);
  });
  it('handles Windows-style paths', () => {
    assert.ok(isPathSensitive('packages\\app\\.env'));
  });
});

describe('isExtensionAllowlisted', () => {
  it('allows JS/TS/component extensions', () => {
    for (const p of ['x.js', 'y.mjs', 'z.ts', 'a.tsx', 'b.vue', 'c.svelte']) {
      assert.ok(isExtensionAllowlisted(p), `expected ${p} allowed`);
    }
  });
  it('rejects non-source extensions', () => {
    for (const p of ['x.json', 'y.md', 'z.yaml', 'a.lock']) {
      assert.equal(isExtensionAllowlisted(p), false, `expected ${p} rejected`);
    }
  });
});

describe('containsSecrets', () => {
  it('detects an AWS-style key', () => {
    assert.ok(containsSecrets('const k = "AKIAIOSFODNN7EXAMPLE";'));
  });
  it('returns false for clean code', () => {
    assert.equal(containsSecrets('function add(a, b) { return a + b; }'), false);
  });
  it('returns false for empty', () => {
    assert.equal(containsSecrets(''), false);
    assert.equal(containsSecrets(null), false);
  });
});

describe('redactSecrets', () => {
  it('strips a real-looking key from a payload', () => {
    const payload = '{"hint": "use AKIAIOSFODNN7EXAMPLE here"}';
    const out = redactSecrets(payload);
    assert.equal(out.includes('AKIAIOSFODNN7EXAMPLE'), false);
  });
});

describe('gateSymbolForEgress', () => {
  it('skips by path for sensitive files', () => {
    const r = gateSymbolForEgress({ filePath: '.env', bodyText: 'foo' });
    assert.equal(r.action, 'skip-path');
  });
  it('skips by extension for non-allowlisted', () => {
    const r = gateSymbolForEgress({ filePath: 'README.md', bodyText: 'foo' });
    assert.equal(r.action, 'skip-extension');
  });
  it('redacts content with secret-pattern body', () => {
    const r = gateSymbolForEgress({
      filePath: 'src/x.mjs',
      bodyText: 'const k = "AKIAIOSFODNN7EXAMPLE";',
    });
    assert.equal(r.action, 'redact-content');
  });
  it('sends clean code from allowlisted path', () => {
    const r = gateSymbolForEgress({
      filePath: 'src/x.mjs',
      bodyText: 'function add(a,b){return a+b;}',
    });
    assert.equal(r.action, 'send');
  });
});

describe('SECRET_REDACTED constant', () => {
  it('is a non-empty marker', () => {
    assert.ok(SECRET_REDACTED && SECRET_REDACTED.length > 0);
  });
});

// ── WS-CANON additions — redactSecrets fail-closed contract ────────────
// Plan: docs/plans/liveness-and-canonical-paths.md WS-CANON #9.

describe('redactSecrets — fail-closed contract (WS-CANON)', () => {
  it('returns [REDACTED:redaction-failed] for circular references', () => {
    const obj = { a: 1 };
    obj.self = obj;          // circular — old impl would throw or leak
    const out = redactSecrets(obj);
    // We don't constrain the EXACT string (redactObject may detect
    // the cycle and emit its own placeholder), but the raw payload
    // must never round-trip through. The result must be a string
    // and must not be a literal JSON of the circular structure.
    assert.equal(typeof out, 'string');
    assert.ok(!out.includes('"self":{'), 'must not leak circular ref as JSON');
  });

  it('returns a safe placeholder for BigInt at root (fail-closed)', () => {
    // BigInt cannot be JSON.stringify'd. The OLD impl did JSON.stringify
    // OUTSIDE its try block, so a BigInt input threw the whole function
    // and the catch returned the `text` variable (which on the happy
    // path was the full payload as JSON — direct leak). The new impl
    // routes through redactObject; on stringify-failure it returns the
    // literal `[REDACTED:redaction-failed]` placeholder. Either way the
    // raw payload MUST NOT round-trip.
    const out = redactSecrets({ id: 12345n });
    assert.equal(typeof out, 'string');
    assert.ok(!out.includes('12345'), 'must not leak the BigInt value');
    // Either valid JSON OR the literal placeholder satisfies the
    // fail-closed contract. (redactObject's stringify of a sanitised
    // structure throws on BigInt — that's caught by the outer try and
    // returns the placeholder.)
    const isJson = (() => { try { JSON.parse(out); return true; } catch { return false; } })();
    const isPlaceholder = out === '[REDACTED:redaction-failed]';
    assert.ok(isJson || isPlaceholder, `output must be JSON or placeholder, got: ${out}`);
  });

  it('returns a sanitized JSON string for a normal nested object', () => {
    const out = redactSecrets({
      name: 'foo',
      keys: ['a', 'b'],
      nested: { count: 3 },
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.name, 'foo');
    assert.deepEqual(parsed.keys, ['a', 'b']);
    assert.equal(parsed.nested.count, 3);
  });

  it('string input still routes through the text redactor (regression-lock)', () => {
    // The string path is unchanged — text redactor returns the sanitised
    // text. We're locking the contract that strings don't accidentally
    // get routed through redactObject (which would wrap them in quotes).
    const out = redactSecrets('plain text with no secrets');
    assert.equal(out, 'plain text with no secrets');
  });
});

// ── WS-CANON additions — gateSymbolForEgress with repoRoot ─────────────

describe('gateSymbolForEgress — canonical-path enforcement (WS-CANON)', () => {
  const skipOnWin = process.platform === 'win32';
  function mkdtemp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'egress-canon-')); }

  it('falls back to lexical-only when repoRoot is omitted (back-compat)', () => {
    const r = gateSymbolForEgress({
      filePath: 'src/foo.ts',
      bodyText: 'export function foo() { return 1; }',
    });
    assert.equal(r.action, 'send');
    assert.equal(r.canonicalAbsPath, undefined, 'no canonical without repoRoot');
  });

  it('returns canonicalAbsPath on send when repoRoot is provided', () => {
    const repoRoot = mkdtemp();
    try {
      const target = path.join(repoRoot, 'foo.ts');
      fs.writeFileSync(target, '');
      const r = gateSymbolForEgress({
        filePath: 'foo.ts',
        bodyText: 'export function f() {}',
        repoRoot,
      });
      assert.equal(r.action, 'send');
      assert.ok(r.canonicalAbsPath && r.canonicalAbsPath.endsWith('foo.ts'));
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
  });

  it('returns skip-symlink-escape for a symlink that resolves outside repoRoot', () => {
    if (skipOnWin) return;
    const repoRoot = mkdtemp();
    const outside = mkdtemp();
    try {
      const target = path.join(outside, 'secret.txt');
      fs.writeFileSync(target, 'pretend secret');
      fs.symlinkSync(target, path.join(repoRoot, 'notes.txt'));
      const r = gateSymbolForEgress({
        filePath: 'notes.txt',
        bodyText: 'fake',
        repoRoot,
      });
      assert.equal(r.action, 'skip-symlink-escape');
      assert.match(r.reason, /symlink escape/);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(outside,  { recursive: true, force: true });
    }
  });

  it('returns skip-path with canonical-target reason when symlink points at sensitive intra-repo location', () => {
    if (skipOnWin) return;
    const repoRoot = mkdtemp();
    try {
      const secretsDir = path.join(repoRoot, 'secrets');
      fs.mkdirSync(secretsDir);
      const target = path.join(secretsDir, 'db.yaml');
      fs.writeFileSync(target, '');
      fs.symlinkSync(target, path.join(repoRoot, 'innocent.ts'));
      const r = gateSymbolForEgress({
        filePath: 'innocent.ts',
        bodyText: '',
        repoRoot,
      });
      assert.equal(r.action, 'skip-path');
      assert.match(r.reason, /canonical target/);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
  });

  it('blocks generatedNoise files in the repoRoot branch (Gemini-r2-G2)', () => {
    // Pre-WS-CANON, isPathSensitive() returned true for BOTH sensitive
    // AND generatedNoise (lockfiles, *.min.js, *.map). The first cut of
    // the new repoRoot branch only checked `sensitive`, so a
    // `bundle.min.js` would pass through as `send` because `.js` is on
    // the extension allowlist. Regression-lock the fix.
    const repoRoot = mkdtemp();
    try {
      const target = path.join(repoRoot, 'bundle.min.js');
      fs.writeFileSync(target, 'var x=1');
      const r = gateSymbolForEgress({
        filePath: 'bundle.min.js',
        bodyText: 'var x=1',
        repoRoot,
      });
      assert.equal(r.action, 'skip-path');
      assert.match(r.reason, /generated-noise/);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
  });

  it('blocks package-lock.json (generatedNoise) in repoRoot branch', () => {
    const repoRoot = mkdtemp();
    try {
      const target = path.join(repoRoot, 'package-lock.json');
      fs.writeFileSync(target, '{}');
      const r = gateSymbolForEgress({
        filePath: 'package-lock.json',
        bodyText: '{}',
        repoRoot,
      });
      assert.equal(r.action, 'skip-path');
      assert.match(r.reason, /generated-noise/);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
  });
});
