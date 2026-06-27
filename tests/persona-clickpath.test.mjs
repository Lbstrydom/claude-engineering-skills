/**
 * @fileoverview Tier-1 tests for persona-clickpath → nav reachability seeding
 * (plan: docs/completed/persona-clickpath-nav-seeding.md). Covers the security
 * controls (schema strictness, URL sanitization, cap/drop), the reader unnest, the
 * evidence→personaIntents mapping, and the bootstrap-ranking #5 fix — all pure, no DB.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ClickPathStepSchema } from '../scripts/lib/schemas.mjs';
import { sanitizeStepUrl, buildSanitizedClickPath, unnestReachabilityRows } from '../scripts/lib/store/persona.mjs';
import { mapPersonasToIntents, slugifyDestination } from '../scripts/lib/nav/persona-seed.mjs';
import { draftContractFromLive, buildDraftCaptureWarning } from '../scripts/lib/nav/bootstrap-draft.mjs';
import { bootstrapContract } from '../scripts/lib/nav/contract.mjs';

// ── ClickPathStepSchema (security: closed enum + .strict) ──
test('ClickPathStepSchema: closed action enum, .strict rejects an injected value key', () => {
  assert.ok(ClickPathStepSchema.safeParse({ action: 'click', url: '/x', targetText: 'Go' }).success);
  assert.ok(!ClickPathStepSchema.safeParse({ action: 'frobnicate', url: '/x' }).success, 'non-enum action rejected');
  assert.ok(!ClickPathStepSchema.safeParse({ action: 'type', url: '/x', value: 'SECRET' }).success, '.strict rejects `value`');
  assert.ok(!ClickPathStepSchema.safeParse({ action: 'click', url: '/x', targetText: 'a'.repeat(81) }).success, 'targetText cap');
});

// ── buildSanitizedClickPath: cap (truncate not reject) + drop-invalid + counts ──
test('buildSanitizedClickPath truncates to 40 (not reject) and reports counts', () => {
  const raw = Array.from({ length: 55 }, (_, i) => ({ action: 'click', url: `/p${i}`, targetText: null }));
  const r = buildSanitizedClickPath(raw);
  assert.equal(r.steps.length, 40);
  assert.equal(r.truncated, true);
  assert.equal(r.dropped, 0);
});

test('buildSanitizedClickPath drops invalid/injected entries, keeps the session', () => {
  const r = buildSanitizedClickPath([
    { action: 'click', url: '/cellar', targetText: 'Cellar' },
    { action: 'type', url: '/login', value: 'hunter2' }, // injected → dropped
    { action: 'bogus', url: '/x' },                       // bad enum → dropped
  ]);
  assert.equal(r.steps.length, 1);
  assert.equal(r.dropped, 2);
  assert.equal(r.steps[0].url, '/cellar');
});

// ── sanitizeStepUrl (the security control) ──
test('sanitizeStepUrl strips origin, collapses tokens, redacts secret query, keeps routing', () => {
  assert.equal(sanitizeStepUrl('https://staging.private.app/cellar?view=cellar'), '/cellar?view=cellar');
  assert.equal(sanitizeStepUrl('https://x/reset/SECRETtoken123'), '/reset/:param');                  // auth keyword
  assert.equal(sanitizeStepUrl('https://x/reset-password/abc'), '/reset-password/:param');            // compound slug
  assert.equal(sanitizeStepUrl('https://x/users/jane%40example.com'), '/users/:param');               // encoded email
  assert.match(sanitizeStepUrl('https://x/login?code=123456&otp=999&view=cellar'), /code=:param.*otp=:param.*view=cellar/); // short tokens redacted, routing kept
  assert.equal(sanitizeStepUrl('https://x/#/wines/42'), '/#/wines/42');                                // hash-route preserved; short id is not a secret
  assert.equal(sanitizeStepUrl('https://x/#/wines/a1b2c3d4-e5f6-7890-abcd-ef1234567890'), '/#/wines/:param'); // uuid in hash route collapsed
  assert.match(sanitizeStepUrl('https://x/cb#access_token=SECRET&state=ok'), /access_token=:param/); // OAuth hash redacted
  assert.equal(sanitizeStepUrl('mailto:a@b.com'), '');                                                 // non-http → empty
});

test('sanitizeStepUrl: a hash ROUTE with its own query is not mangled as an OAuth token bag (Gemini HIGH)', () => {
  // `#/wines?view=today` starts with `/` → it is a SPA route, not `#token=…`.
  assert.equal(sanitizeStepUrl('https://x/#/wines?view=today'), '/#/wines?view=today');
  assert.equal(sanitizeStepUrl('https://x/#/wines/42?code=123456'), '/#/wines/42?code=:param'); // route path kept, secret query redacted
});

test('sanitizeStepUrl: parsed-protocol guard drops control-char-obfuscated schemes (Gemini LOW)', () => {
  assert.equal(sanitizeStepUrl('java\nscript:alert(1)'), ''); // new URL normalizes → javascript: → dropped
  assert.equal(sanitizeStepUrl('JAVASCRIPT:alert(1)'), '');
});

// ── reader unnest: dedupe + sessions count + most-recent clickedText ──
test('unnestReachabilityRows dedupes by url, counts sessions, picks most-recent non-null label', () => {
  // rows MUST be created_at DESC (most recent first)
  const rows = [
    { persona: 'pieter', created_at: '2026-06-27T00:00:00+00:00', click_path: [{ action: 'click', url: '/cellar', targetText: 'My Cellar' }] },
    { persona: 'pieter', created_at: '2026-06-26T00:00:00+00:00', click_path: [{ action: 'click', url: '/cellar', targetText: 'Cellar (old label)' }, { action: 'click', url: '/pairing', targetText: null }] },
    { persona: 'anna', created_at: '2026-06-25T00:00:00+00:00', click_path: [{ action: 'click', url: '/cellar', targetText: 'Cellar' }] },
  ];
  const out = unnestReachabilityRows(rows);
  const pieter = out.find((x) => x.persona === 'pieter');
  const cellar = pieter.reached.find((r) => r.url === '/cellar');
  assert.equal(cellar.sessions, 2, 'cellar reached in 2 pieter sessions');
  assert.equal(cellar.clickedText, 'My Cellar', 'most-recent non-null label wins');
  assert.equal(cellar.lastSeen, '2026-06-27T00:00:00+00:00');
  assert.equal(out.find((x) => x.persona === 'anna').reached.length, 1);
});

// ── evidence → personaIntents mapping ──
test('mapPersonasToIntents normalizes URLs, drops unnormalizable, slugs intentId, dedupes', () => {
  const personas = [{
    persona: 'pieter',
    reached: [
      { url: 'http://localhost:3000/cellar', clickedText: 'Cellar' },
      { url: 'http://localhost:3000/cellar', clickedText: 'Cellar again' },             // identical → deduped
      { url: 'mailto:x@y.com', clickedText: 'Email' },                                  // unnormalizable → dropped
      { url: 'https://external.com/wines', clickedText: 'External' },                   // cross-origin → dropped
    ],
  }];
  const seeds = mapPersonasToIntents(personas, 'http://localhost:3000');
  assert.equal(seeds.length, 1, 'one deduped, normalizable destination');
  assert.equal(seeds[0].source, 'persona-test-evidence');
  assert.equal(seeds[0].destination, '/cellar');
  assert.equal(seeds[0].intentId, 'cellar');
  assert.equal(slugifyDestination('/wines/:param'), 'wines-param');
});

test('seeded personaIntents round-trip through bootstrapContract with the right authority', () => {
  const { contract } = bootstrapContract({
    personaIntents: [{ personaId: 'pieter', intentId: 'cellar', destination: '/cellar', source: 'persona-test-evidence' }],
  });
  const intent = contract.personas[0].intents[0];
  assert.equal(intent.source, 'persona-test-evidence');
  assert.equal(intent.requiredInLayer, null, 'left for the human reviewer');
  assert.equal(intent.id, 'cellar');
});

// ── #5 bootstrap ranking: sticky bar > hamburger ──
test('draftContractFromLive ranks a role-less sticky bar primary over a hamburger (#5)', () => {
  const ev = [
    { target: 'cellar', containerCandidates: [{ selector: '.app-bottom-bar', sticky: true }] },
    { target: 'pairing', containerCandidates: [{ selector: '.app-bottom-bar', sticky: true }] },
    { target: 'settings', containerCandidates: [{ selector: '.hamburger-drawer', sticky: false }] },
    { target: 'help', containerCandidates: [{ selector: '.hamburger-drawer', sticky: false }] },
  ];
  const r = draftContractFromLive(ev);
  assert.deepEqual(r.navLayers.primary, ['.app-bottom-bar']);
  assert.deepEqual(r.navLayers.secondary, ['.hamburger-drawer']);
});

test('draftContractFromLive: mobile-only hamburger is primary when no bar exists', () => {
  const ev = [
    { target: 'a', containerCandidates: [{ selector: '.hamburger', sticky: true }] },
    { target: 'b', containerCandidates: [{ selector: '.hamburger', sticky: true }] },
  ];
  assert.deepEqual(draftContractFromLive(ev).navLayers.primary, ['.hamburger']);
});

test('draftContractFromLive: an all-secondary bar promoted to primary is not also in secondary (Gemini MED)', () => {
  // Only a SECONDARY_RE-matching bar exists (no primary, no undecided) → it is
  // promoted to primary and must NOT remain in secondary.
  const ev = [
    { target: 'a', containerCandidates: [{ selector: '.breadcrumb-row', sticky: false }] },
    { target: 'b', containerCandidates: [{ selector: '.breadcrumb-row', sticky: false }] },
  ];
  const { primary, secondary } = draftContractFromLive(ev).navLayers;
  assert.deepEqual(primary, ['.breadcrumb-row']);
  assert.ok(!secondary.includes('.breadcrumb-row'), 'promoted bar must not appear in both layers');
});

// ── buildDraftCaptureWarning — capture-honesty warning selection (field-test #3/#4) ──
test('buildDraftCaptureWarning: empty nav shell warns specifically, even WITH storage-state (expired-token hole)', () => {
  const w = buildDraftCaptureWarning({ emptyNavShells: ['#primary-nav'], hasStorageState: true });
  assert.match(w, /#primary-nav/);
  assert.match(w, /EMPTY/);
  assert.match(w, /storage-state/);
});

test('buildDraftCaptureWarning: no shell + no storage-state → generic warning', () => {
  const w = buildDraftCaptureWarning({ emptyNavShells: [], hasStorageState: false });
  assert.match(w, /WITHOUT --storage-state/);
});

test('buildDraftCaptureWarning: no shell + storage-state present → silent (null)', () => {
  assert.equal(buildDraftCaptureWarning({ emptyNavShells: [], hasStorageState: true }), null);
});
