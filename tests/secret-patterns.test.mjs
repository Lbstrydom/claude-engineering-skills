/**
 * @fileoverview Phase D — secret-pattern scanner tests.
 * Verifies the defense-in-depth redactor catches common secret shapes
 * without corrupting benign text.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SECRET_PATTERNS,
  scanForSecrets,
  redactSecrets,
  redactFields,
} from '../scripts/lib/secret-patterns.mjs';

describe('scanForSecrets', () => {
  test('returns matched=false for empty/non-string input', () => {
    assert.deepEqual(scanForSecrets(''), { matched: false, patterns: [] });
    assert.deepEqual(scanForSecrets(null), { matched: false, patterns: [] });
    assert.deepEqual(scanForSecrets(undefined), { matched: false, patterns: [] });
    assert.deepEqual(scanForSecrets(42), { matched: false, patterns: [] });
  });

  test('detects OpenAI API keys', () => {
    const r = scanForSecrets('OPENAI_KEY=sk-abc123def456ghi789jkl012mno345');
    assert.equal(r.matched, true);
    assert.ok(r.patterns.includes('openai-key'));
  });

  test('detects Anthropic API keys', () => {
    const r = scanForSecrets('ANTHROPIC_API_KEY=sk-ant-abc123def456ghi789jkl012mno345pqr');
    assert.equal(r.matched, true);
    assert.ok(r.patterns.includes('anthropic-key'));
  });

  test('detects Google API keys (exact length)', () => {
    const key = 'AIza' + 'x'.repeat(35);
    const r = scanForSecrets(`API_KEY=${key}`);
    assert.equal(r.matched, true);
    assert.ok(r.patterns.includes('google-key'));
  });

  test('rejects Google-shaped strings of wrong length', () => {
    const tooShort = 'AIza' + 'x'.repeat(30);
    const tooLong = 'AIza' + 'x'.repeat(40);
    assert.equal(scanForSecrets(tooShort).patterns.includes('google-key'), false);
    assert.equal(scanForSecrets(tooLong).patterns.includes('google-key'), false);
  });

  test('detects AWS access key IDs', () => {
    assert.ok(scanForSecrets('AKIAIOSFODNN7EXAMPLE').patterns.includes('aws-access-key-id'));
    assert.ok(scanForSecrets('ASIAIOSFODNN7EXAMPLE').patterns.includes('aws-access-key-id'));
  });

  test('detects GitHub personal access tokens', () => {
    const r = scanForSecrets('ghp_' + 'a'.repeat(36));
    assert.ok(r.patterns.includes('github-pat'));
  });

  test('detects Slack tokens', () => {
    assert.ok(scanForSecrets('xoxb-12345-67890-abcdefghij').patterns.includes('slack-token'));
    assert.ok(scanForSecrets('xoxp-12345-67890-abcdefghij').patterns.includes('slack-token'));
  });

  test('detects Stripe keys (live + test)', () => {
    assert.ok(scanForSecrets('sk_live_' + 'a'.repeat(30)).patterns.includes('stripe-key'));
    assert.ok(scanForSecrets('pk_test_' + 'a'.repeat(30)).patterns.includes('stripe-key'));
  });

  test('detects generic tokens after keywords', () => {
    const r = scanForSecrets('auth_token=AbCdEfGhIjKlMnOpQrStUvWxYz012345==');
    assert.ok(r.patterns.includes('generic-token'));
  });

  test('ignores tokens without keyword context (conservative)', () => {
    // High-entropy string alone isn't flagged — reduces false positives
    const r = scanForSecrets('the hash is AbCdEfGhIjKlMnOpQrStUvWxYz01234');
    assert.equal(r.matched, false);
  });

  test('detects PEM private-key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    assert.ok(scanForSecrets(pem).patterns.includes('pem-private-key'));
  });

  test('benign text produces no match', () => {
    const benign = 'The finding is about scripts/openai-audit.mjs line 42, specifically the loop handling';
    assert.equal(scanForSecrets(benign).matched, false);
  });
});

describe('redactSecrets', () => {
  test('returns input unchanged when no secret present', () => {
    const r = redactSecrets('normal text about refactoring');
    assert.equal(r.text, 'normal text about refactoring');
    assert.deepEqual(r.redacted, []);
  });

  test('replaces OpenAI key with placeholder', () => {
    const r = redactSecrets('OPENAI_KEY=sk-abc123def456ghi789jkl012mno345');
    assert.match(r.text, /\[REDACTED:openai-key\]/);
    assert.equal(r.text.includes('sk-abc123'), false);
  });

  test('preserves keyword, redacts only the value for generic-token', () => {
    const r = redactSecrets('password="verysecurepassword12345678901234567"');
    // The 'password' keyword should remain visible
    assert.match(r.text, /password/);
    // The value should be redacted
    assert.match(r.text, /\[REDACTED:generic-token\]/);
    assert.equal(r.text.includes('verysecurepassword123'), false);
  });

  test('handles multiple secrets in same string', () => {
    const input = 'key1=sk-abc123def456ghi789jkl012mno345 AND key2=AKIAIOSFODNN7EXAMPLE';
    const r = redactSecrets(input);
    assert.ok(r.redacted.includes('openai-key'));
    assert.ok(r.redacted.includes('aws-access-key-id'));
    assert.equal(r.text.includes('sk-abc'), false);
    assert.equal(r.text.includes('AKIAIO'), false);
  });

  test('empty/non-string input returns safely', () => {
    assert.deepEqual(redactSecrets(''), { text: '', redacted: [] });
    assert.deepEqual(redactSecrets(null), { text: '', redacted: [] });
    assert.deepEqual(redactSecrets(undefined), { text: '', redacted: [] });
  });

  test('redacts PEM blocks entirely', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    const r = redactSecrets(`cfg: ${pem} // ok`);
    assert.match(r.text, /\[REDACTED:pem-private-key\]/);
    assert.equal(r.text.includes('MIIEp'), false);
  });
});

describe('redactFields', () => {
  test('returns new object, does not mutate input', () => {
    const input = { a: 'api_key=sk-abc123def456ghi789jkl012mno345', b: 'safe' };
    const r = redactFields(input, ['a', 'b']);
    assert.notEqual(r.obj, input);
    assert.equal(input.a.includes('sk-abc123'), true); // original untouched
  });

  test('redacts only specified fields', () => {
    const r = redactFields(
      { detail: 'sk-abc123def456ghi789jkl012mno345', other: 'sk-abc123def456ghi789jkl012mno345' },
      ['detail']
    );
    assert.match(r.obj.detail, /REDACTED/);
    assert.equal(r.obj.other.includes('sk-abc123'), true);
  });

  test('reports per-field redaction patterns', () => {
    const r = redactFields(
      { a: 'token=sk-abc123def456ghi789jkl012mno345', b: 'ghp_' + 'x'.repeat(36) },
      ['a', 'b']
    );
    const byField = Object.fromEntries(r.redacted.map(x => [x.field, x.patterns]));
    assert.ok(byField.a?.includes('openai-key'));
    assert.ok(byField.b?.includes('github-pat'));
  });

  test('skips non-string fields', () => {
    const r = redactFields({ num: 42, list: [1, 2], s: 'clean' }, ['num', 'list', 's']);
    assert.equal(r.redacted.length, 0);
    assert.equal(r.obj.num, 42);
  });

  test('returns empty report when nothing matched', () => {
    const r = redactFields({ a: 'hello', b: 'world' }, ['a', 'b']);
    assert.deepEqual(r.redacted, []);
  });
});

describe('SECRET_PATTERNS registry', () => {
  test('all patterns have name and regex', () => {
    for (const p of SECRET_PATTERNS) {
      assert.ok(typeof p.name === 'string' && p.name.length > 0);
      assert.ok(p.re instanceof RegExp);
      assert.ok(p.re.flags.includes('g'), `${p.name} must be global`);
    }
  });

  test('registry is frozen', () => {
    assert.throws(() => { SECRET_PATTERNS.push({}); }, TypeError);
  });
});
