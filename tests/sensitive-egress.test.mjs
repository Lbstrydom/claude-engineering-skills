import { describe, it, beforeEach, afterEach } from 'node:test';
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
import { buildRulingsBlock } from '../scripts/lib/ledger.mjs';
import {
  scanForSecrets,
  redactSecrets as redactSecretsRaw,
} from '../scripts/lib/secret-patterns.mjs';

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

describe('redactSecrets (provider-boundary wrapper) — positional collision (2026-07-16)', () => {
  it('redacts the real password, not an earlier same-string occurrence, in a DSN passed to the LLM-provider boundary', () => {
    const out = redactSecrets('postgresql://admin:admin@realhost.example.com:5432/prod');
    assert.equal(out, 'postgresql://admin:[REDACTED:dsn-password]@realhost.example.com:5432/prod');
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
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
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
      fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      fs.rmSync(outside,  { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
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
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
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
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
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
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

// ── Discovery-portfolio secret-redaction fixes ──────────────────────────
// Plan: docs/plans/discovery-portfolio-secret-redaction.md.
//
// Ground zero (Gemini round-1 G1): scanForSecrets/redactSecrets must not
// re-flag redactSecrets' own [REDACTED:pattern-name] output, while still
// flagging a genuine unrelated secret elsewhere in the same text. This is
// the fix that makes everything else in the plan (the readFilesAsContext /
// readFilesAsAnnotatedContext redact-by-default flip) actually work.

describe('scanForSecrets / redactSecrets — marker-stripping regression (Gemini round 1 G1)', () => {
  const DSN = 'postgresql://user:hunter2@host.example.com/db';

  it('a raw DSN password is flagged', () => {
    const r = scanForSecrets(DSN);
    assert.equal(r.matched, true);
    assert.ok(r.patterns.includes('dsn-password'));
  });

  it('redactSecrets output on a DSN no longer re-trips the scanner (the core G1 bug)', () => {
    const { text, redacted } = redactSecretsRaw(DSN);
    assert.ok(redacted.includes('dsn-password'));
    assert.ok(text.includes('[REDACTED:dsn-password]'));
    assert.equal(scanForSecrets(text).matched, false, 'a redacted marker must not re-trigger scanForSecrets');
  });

  it('containsSecrets(redactSecrets(text)) via the fail-closed wrapper is also false (the real call path)', () => {
    const redacted = redactSecrets(DSN); // sensitive-egress-gate.mjs wrapper
    assert.equal(containsSecrets(redacted), false);
  });

  it('a real secret elsewhere in the text is still flagged when a marker is already present', () => {
    const text = 'placeholder: [REDACTED:dsn-password] but also AKIAIOSFODNN7EXAMPLE';
    const r = scanForSecrets(text);
    assert.equal(r.matched, true);
    assert.ok(r.patterns.includes('aws-access-key-id'));
    assert.equal(r.patterns.includes('dsn-password'), false, 'the marker itself must not be re-flagged as a fresh match');
  });

  it('a literal [REDACTED:...]-shaped substring does not concatenate into a false new match (Gemini round 2 G2)', () => {
    // Marker-stripping uses a SPACE, not an empty string — text immediately
    // before/after a marker must not concatenate into a coincidental token.
    const text = 'AKIA[REDACTED:x]OSFODNN7EXAMPLE';
    const r = scanForSecrets(text);
    assert.equal(r.patterns.includes('aws-access-key-id'), false);
  });
});

describe('redactSecrets — line-count preservation (Gemini round 3, root-cause fix)', () => {
  it('multi-line PEM redaction preserves total line count', () => {
    const pemLines = [
      '-----BEGIN RSA PRIVATE KEY-----',
      ...Array.from({ length: 10 }, (_, i) => `b64line${i}`),
      '-----END RSA PRIVATE KEY-----',
    ];
    const before = ['const a = 1;', ...pemLines, 'const b = 2;'];
    const { text: redacted, redacted: patterns } = redactSecretsRaw(before.join('\n'));
    assert.ok(patterns.includes('pem-private-key'));
    assert.equal(redacted.split('\n').length, before.length, 'line count must be preserved after redaction');
    assert.ok(redacted.includes('const b = 2;'), 'content after the PEM block must remain intact');
    assert.ok(!redacted.includes('b64line0'), 'PEM body must actually be redacted, not just counted');
  });

  it('single-line redaction adds zero newlines (capture-group path is unaffected)', () => {
    const text = 'const dsn = "postgresql://user:hunter2@host/db";';
    const { text: redacted } = redactSecretsRaw(text);
    assert.equal(redacted.split('\n').length, 1);
  });
});

// ── Rulings-block rationale egress (Tier 3 HARD — AGENTS.md testing doctrine) ──
//
// Plan: docs/plans/dismissed-fp-reopen-policy.md §"Egress trace".
// `buildRulingsBlock` raises the dismissed-rationale budget 100 → 300 chars, so
// bytes 100-300 of an agent-authored rationale become a NEW outbound payload.
// The trace performed during that plan's audit established: `ossStructuredCall`
// gates via assertEgressSafe, but `createOpenAIClient` and the whole GPT audit
// pass path have NO egress gate — so nothing downstream would catch a secret
// here. The render point IS the boundary; these tests are the gate.
describe('buildRulingsBlock — rationale redaction (expanded 100→300 payload)', () => {
  let tmpDir;
  let ledgerPath;

  const entry = (rationale) => ({
    topicId: 'abcdef123456', pass: 'plan',
    adjudicationOutcome: 'dismissed', remediationState: 'pending',
    category: 'SOLID-SRP', rulingRationale: rationale,
    affectedFiles: ['scripts/foo.mjs'], resolvedRound: 1,
  });

  const render = (rationale) => {
    fs.writeFileSync(ledgerPath, JSON.stringify({ entries: [entry(rationale)] }), 'utf-8');
    return buildRulingsBlock(ledgerPath, 'plan');
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rulings-egress-'));
    ledgerPath = path.join(tmpDir, 'ledger.json');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('a secret at char 150 — inside the NEWLY-admitted 100-300 window — never reaches the block', () => {
    const lead = 'Dismissed because the upstream validator already rejects this input shape; '
      + 'see the deployment note that mentions ';           // ~110 chars
    const rationale = `${lead}AKIAIOSFODNN7EXAMPLE and the rest of the explanation continues here.`;
    const secretAt = rationale.indexOf('AKIAIOSFODNN7EXAMPLE');
    assert.ok(secretAt > 100 && secretAt < 300,
      `fixture must place the secret in the newly-admitted window (was ${secretAt}) — otherwise this test proves nothing`);

    const block = render(rationale);
    assert.ok(!block.includes('AKIAIOSFODNN7EXAMPLE'), 'the secret must not egress');
    assert.match(block, /REDACTED/, 'it is redacted, not silently dropped');
    assert.match(block, /upstream validator/, 'surrounding non-sensitive rationale survives');
  });

  it('redact BEFORE truncate: a secret straddling the 300-char budget is still redacted, not bisected', () => {
    // Truncate-then-redact would slice the DSN mid-token, leaving an
    // unmatchable fragment that the pattern scanner can no longer detect —
    // and that fragment would ship. Ordering is the whole test.
    const filler = 'x'.repeat(285);
    const rationale = `${filler} postgresql://admin:sup3rS3cretPassw0rd@db.example.com:5432/prod`;
    const block = render(rationale);
    assert.ok(!block.includes('sup3rS3cretPassw0rd'), 'no password fragment may survive truncation');
    assert.ok(!/sup3rS3cret/.test(block), 'not even a bisected prefix of the secret');
  });

  it('a clean rationale is untouched (the redactor must not corrupt evidence prose)', () => {
    const rationale = 'The Zod schema at src/schemas/wine.ts:42 accepts style: null — verified by a direct parse.';
    const block = render(rationale);
    assert.match(block, /src\/schemas\/wine\.ts:42/, 'a cited symbol must survive verbatim');
    assert.doesNotMatch(block, /REDACTED/, 'no false-positive redaction of ordinary code citations');
  });
});
