/**
 * Tier-3 egress wiring pin — arch-memory intent normalization.
 *
 * The normalizer is a NEW external-provider egress surface, and AGENTS.md makes
 * sensitive-path egress a hard test-first seam. The protection is not any single
 * function; it is an ORDER in `neighbourhood-query.mjs`:
 *
 *     redactSecrets(v.intentDescription)   →   assertEgressSafe(safeIntent)
 *       →   normalizeIntentToPurpose(safeIntent)   →   embed
 *
 * The tests added alongside the normalizer assert the pieces (the gate refuses a
 * DSN; the module forwards what it is handed) but NOT the order. Verified by
 * mutation on 2026-07-19: deleting the `assertEgressSafe` call, and separately
 * replacing `redactSecrets(...)` with the raw intent, each left the whole suite
 * green. A seam whose entire job is "credentials never leave the machine" cannot
 * rest on coverage that survives the removal of the guard.
 *
 * Why a SOURCE scan rather than a behavioural spy: `normalizeIntentToPurpose` is
 * invoked with `{ repoRoot }` only, so no client can be injected from outside,
 * and `generateIntentEmbedding` is called directly rather than through the
 * `adapters` object. Making it spy-able would mean threading a new adapter
 * through a caller that is currently someone else's in-flight work. The property
 * being protected — "the gate sits between redaction and the provider call" — is
 * structural anyway, exactly like the single-parser pin in
 * `collector-parser-authority.test.mjs`.
 *
 * KNOWN GAP, deliberately not asserted here: an AWS *secret access key* survives
 * both `redactSecrets` and `assertEgressSafe` and reaches the provider. That is a
 * defect in the layers, not in the wiring, and pinning it here would encode
 * today's leak as expected behaviour. Tracked in
 * `docs/plans/egress-secret-coverage-gap.md`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUERY_SRC = path.join(__dirname, '..', 'scripts', 'lib', 'neighbourhood-query.mjs');

/**
 * Strip comments before scanning. The file documents this exact ordering in
 * prose ("EGRESS ORDER IS LOAD-BEARING: redact → gate → normalize → embed"), so
 * a naive scan would match the documentation and pass even if the code were
 * gutted — the comment-blindness failure this repo has already been bitten by.
 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

test('egress wiring: redact → gate → normalize, in that order, in real code', () => {
  const code = codeOnly(fs.readFileSync(QUERY_SRC, 'utf-8'));

  const redactAt = code.search(/const\s+safeIntent\s*=\s*redactSecrets\s*\(/);
  const gateAt = code.search(/assertEgressSafe\s*\(\s*safeIntent\b/);
  const normalizeAt = code.search(/normalizeIntentToPurpose\s*\(\s*safeIntent\b/);

  assert.notEqual(redactAt, -1,
    'the intent must be redacted into `safeIntent` before anything else — without this the '
    + 'raw intent flows to an external provider');
  assert.notEqual(gateAt, -1,
    'assertEgressSafe(safeIntent) must guard the normalize path; it is the second layer and '
    + 'the only one that refuses rather than rewrites');
  assert.notEqual(normalizeAt, -1,
    'the normalizer must be invoked with `safeIntent` — never with a raw or re-derived intent');

  assert.ok(redactAt < gateAt,
    'redaction must precede the gate, or the gate inspects text that was never cleaned');
  assert.ok(gateAt < normalizeAt,
    'the gate must precede the provider call, or it cannot prevent the send it exists to prevent');
});

test('egress wiring: the normalizer is never handed a raw intent field', () => {
  const code = codeOnly(fs.readFileSync(QUERY_SRC, 'utf-8'));

  // Catches the re-derivation shape a reorder invites: reaching back to the
  // unredacted request field at the provider call instead of using safeIntent.
  assert.ok(!/normalizeIntentToPurpose\s*\(\s*(v\.intentDescription|intentDescription|rawIntent)\b/.test(code),
    'normalizeIntentToPurpose must receive the redacted text, not the request field');
});

test('egress wiring: a gate refusal degrades to the deterministic path (C10)', async () => {
  // Behavioural half. The catch branch must produce embeddable fallback text
  // rather than throwing into the query path or — worse — proceeding to send.
  const { deterministicNormalize } = await import('../scripts/lib/arch-memory/normalize-intent.mjs');
  const out = deterministicNormalize('connect using postgresql://u:p@db/prod for billing');
  assert.ok(typeof out === 'string' && out.length > 0,
    'a refused intent must still yield text to embed, or the consultation silently loses its query');
});

test('the gate refuses a raw DSN password (the layer the wiring depends on)', async () => {
  // Positive control for the pin above: the ordering is only worth asserting if
  // the gate actually refuses something. If this ever stops throwing, the
  // wiring test is guarding an empty guard.
  const { assertEgressSafe } = await import('../scripts/lib/sensitive-egress-gate.mjs');
  assert.throws(
    () => assertEgressSafe('connect using postgresql://user:hunter2trustno1@db.example.com:5432/prod',
      { label: 'arch-memory:normalize-intent' }),
    /egress/i,
  );
});
