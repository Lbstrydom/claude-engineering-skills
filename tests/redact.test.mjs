/**
 * @fileoverview Phase 0 redact module tests.
 *
 * The plan requires `redact(text)` + `redactObject(value)` for the
 * consistency-mode egress boundary (resolves Gemini-R2-M2 + R6-G3).
 *
 * Plan: docs/plans/persona-test-consistency-mode.md.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactObject, _internals } from '../scripts/lib/redact.mjs';

describe('redact', () => {
  it('returns input + zero count for empty string', () => {
    const r = redact('');
    assert.equal(r.redacted, '');
    assert.equal(r.count, 0);
    assert.deepEqual(r.patternsHit, []);
  });

  it('returns empty + zero count for non-string', () => {
    const r = redact(null);
    assert.equal(r.redacted, '');
    assert.equal(r.count, 0);
  });

  it('redacts an OpenAI key', () => {
    const fake = 'sk-' + 'A'.repeat(25);  // synthetic, matches the openai-key regex shape
    const r = redact(`api_key=${fake}`);
    assert.match(r.redacted, /\[REDACTED:openai-key\]/);
    assert.equal(r.count >= 1, true);
    assert.ok(r.patternsHit.includes('openai-key'));
  });

  it('redacts an AWS access key id', () => {
    const fake = 'AKIA' + 'B'.repeat(16);   // shape matches AWS pattern
    const r = redact(`AWS_KEY=${fake}`);
    assert.match(r.redacted, /\[REDACTED:aws-access-key-id\]/);
    assert.ok(r.patternsHit.includes('aws-access-key-id'));
  });

  it('returns the same string when nothing matches', () => {
    const r = redact('the cellar is at capacity');
    assert.equal(r.redacted, 'the cellar is at capacity');
    assert.equal(r.count, 0);
    assert.deepEqual(r.patternsHit, []);
  });
});

describe('redactObject', () => {
  it('returns the same value when no secrets present', () => {
    const obj = { a: 1, b: 'hello', c: [true, null, 'plain string'] };
    const r = redactObject(obj);
    assert.deepEqual(r.redacted, obj);
    assert.equal(r.count, 0);
  });

  it('deep-redacts strings inside nested objects', () => {
    const fake = 'sk-' + 'X'.repeat(25);
    const obj = {
      response: {
        body: { token: `Bearer ${fake}`, status: 'ok' },
      },
      ts: 12345,
    };
    const r = redactObject(obj);
    assert.match(r.redacted.response.body.token, /\[REDACTED:openai-key\]/);
    assert.equal(r.redacted.response.body.status, 'ok', 'non-secret strings untouched');
    assert.equal(r.redacted.ts, 12345, 'non-strings untouched');
    assert.ok(r.count >= 1);
    assert.ok(r.patternsHit.includes('openai-key'));
  });

  it('deep-redacts strings inside arrays', () => {
    const fake = 'AKIA' + 'Y'.repeat(16);   // AWS key shape; doesn't collide with broader sk- pattern
    const r = redactObject({ items: ['plain', fake, { nested: fake }] });
    assert.equal(r.redacted.items[0], 'plain');
    assert.match(r.redacted.items[1], /\[REDACTED:aws-access-key-id\]/);
    assert.match(r.redacted.items[2].nested, /\[REDACTED:aws-access-key-id\]/);
    assert.ok(r.count >= 2);
  });

  it('does not mutate the input', () => {
    const fake = 'sk-' + 'Z'.repeat(25);
    const orig = { token: fake };
    const snapshot = JSON.parse(JSON.stringify(orig));
    redactObject(orig);
    assert.deepEqual(orig, snapshot, 'input must not be mutated');
  });

  it('respects depth cap', () => {
    // Build a tower deeper than the depth cap; the deepest secret should NOT be redacted.
    let inner = { token: 'sk-' + 'A'.repeat(25) };
    for (let i = 0; i < 20; i++) inner = { nested: inner };
    const r = redactObject(inner, { depth: 3 });
    // The redactor returned the original deep subtree past depth 3 untouched.
    // Walking 3 levels in: inner.nested.nested.nested is the cutoff.
    let node = r.redacted;
    for (let i = 0; i < 5; i++) node = node.nested;
    // At this point we're past the depth cap; verify the token remains un-redacted
    // somewhere deeper.
    let cursor = r.redacted;
    while (cursor && cursor.nested) cursor = cursor.nested;
    assert.match(cursor.token, /sk-A{25}/, 'past depth cap, content should be untouched');
  });

  it('handles primitives at the root', () => {
    assert.equal(redactObject(42).redacted, 42);
    assert.equal(redactObject(true).redacted, true);
    assert.equal(redactObject(null).redacted, null);
    assert.equal(redactObject('plain text').redacted, 'plain text');
  });

  it('exposes internal constants for tests', () => {
    assert.equal(typeof _internals.DEFAULT_MAX_DEPTH, 'number');
    assert.equal(typeof _internals.MAX_OBJECT_NODES, 'number');
    assert.ok(_internals.MAX_OBJECT_NODES >= 1000);
  });
});
