/**
 * @fileoverview Tests for the hybrid secret/PII pre-write gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySecrets, preWriteSecretGate } from '../scripts/lib/security/secret-classifier.mjs';

test('high-confidence secret → refused', () => {
  const r = preWriteSecretGate('leaked key sk-abcdefghijklmnopqrstuvwxyz0123456789');
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'refused');
  assert.ok(r.events.some(e => e.event_kind === 'refused_secret'));
  assert.match(r.detail, /openai-key/);
});

test('AWS key and JWT are refused', () => {
  assert.equal(preWriteSecretGate('AKIAIOSFODNN7EXAMPLE').kind, 'refused');
  assert.equal(preWriteSecretGate('tok eyJhbGciOiJ.eyJzdWIiOiIx.sig').kind, 'refused');
});

test('email is redacted, not refused', () => {
  const r = preWriteSecretGate('contact john@acme.com about the incident');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'redacted');
  assert.doesNotMatch(r.content, /john@acme\.com/);
  assert.match(r.content, /REDACTED-EMAIL/);
  assert.ok(r.events.some(e => e.event_kind === 'redacted_secret'));
});

test('phone number is redacted', () => {
  const r = preWriteSecretGate('call 555-867-5309 for details');
  assert.equal(r.kind, 'redacted');
  assert.match(r.content, /REDACTED-PHONE/);
});

test('clean text passes through unchanged', () => {
  const r = preWriteSecretGate('all clean text here describing a Threat Model');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'clean');
  assert.equal(r.content, 'all clean text here describing a Threat Model');
  assert.equal(r.events.length, 0);
});

test('proper names are detected but NOT auto-redacted', () => {
  const hits = classifySecrets('Threat Model written by Jane Doe');
  assert.ok(hits.lowConfidence.some(h => h.pattern === 'proper-name'));
  const r = preWriteSecretGate('Threat Model written by Jane Doe');
  // proper-name is warn-only → content unchanged, treated as clean
  assert.equal(r.content, 'Threat Model written by Jane Doe');
  assert.equal(r.kind, 'clean');
});

test('classifySecrets handles empty input', () => {
  assert.deepEqual(classifySecrets(''), { highConfidence: [], lowConfidence: [] });
});
