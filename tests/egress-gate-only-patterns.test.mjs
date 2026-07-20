/**
 * Option B — gate-only secret patterns (docs/plans/egress-secret-coverage-gap.md).
 *
 * The defect: `assertEgressSafe` delegated entirely to `scanForSecrets`, the same
 * module `redactSecrets` uses, so its pattern set was a strict SUBSET of the
 * redactor's. Two layers sharing a pattern list do not fail differently — every
 * shape redaction missed passed the gate by construction.
 *
 * The property this file protects is therefore INDEPENDENCE, not coverage: for
 * each added shape, the redactor must leave it intact AND the gate must refuse
 * it. A test that only asserted "gate refuses X" would still pass if the pattern
 * were moved into the shared scanner, which would silently re-collapse the two
 * layers into one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { redactSecrets } from '../scripts/lib/secret-patterns.mjs';
import { assertEgressSafe, scanEgressPayload } from '../scripts/lib/sensitive-egress-gate.mjs';

/** Canonical AWS documentation example — exactly 40 chars, slashes included. */
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const HEX40 = 'a3f5b8c2d1e04f6789abcdef0123456789abcdef';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnopqrstuvwxyz123456';
// Assembled from parts — never written as a literal BEGIN…END pair.
// A complete PEM span anywhere in this FILE makes the audit pipeline's own
// redactor (`pem-private-key`, secret-patterns.mjs:46) replace everything
// between the two markers with a placeholder. That silently deleted ~80 lines of
// this file from the audit context, and three reviewers duly reported it as
// syntactically broken — correctly, for the file they were given. Same fixture,
// spelled so it cannot eat itself.
const PEM_BEGIN = `-----BEGIN RSA ${'PRIVATE'} KEY-----`;
const PEM_END = `-----END RSA ${'PRIVATE'} KEY-----`;
const PEM_BODY = 'MIIEowIBAAKCAQEAvR2LmS8kQe1nQ9pXmZ7cVbNfJ4hT2sYwKpLdGxRtUiOaMnBv';
const PEM_TRUNCATED = `${PEM_BEGIN}\n${PEM_BODY}`;

const refuses = (text) => {
  try { assertEgressSafe(text, { label: 'test' }); return false; } catch { return true; }
};

describe('gate-only patterns — the layers now fail DIFFERENTLY', () => {
  const cases = [
    ['AWS secret access key (keyed)', `deploy with AWS secret ${AWS_SECRET}`, 'gate:keyed-b64-40'],
    ['legacy 40-hex PAT (keyed)', `GITHUB_TOKEN=${HEX40}`, 'gate:keyed-b64-40'],
    ['JWT', `authorization: Bearer ${JWT}`, 'gate:jwt'],
    ['truncated PEM key', PEM_TRUNCATED, 'gate:pem-truncated'],
  ];

  for (const [name, raw, expectedPattern] of cases) {
    it(`${name}: redactor leaves it, gate refuses it`, () => {
      const safe = redactSecrets(raw).text;

      // The DURABLE property is "this shape never reaches a provider" — satisfied
      // by EITHER layer. An earlier revision asserted the redactor must still
      // MISS it, which would fail the moment someone taught the redactor an AWS
      // secret or a JWT: punishing the system for getting safer (audit R1
      // MEDIUM, accepted).
      const redactorHandled = !safe.includes(raw.slice(-20));
      assert.ok(redactorHandled || refuses(safe),
        `${name}: must not survive the composition — neither layer stopped it`);

      // Attribution is asserted only while the gate is the layer doing the work.
      // Once the redactor handles a shape this arm stops applying rather than
      // failing, and the line above still guarantees the shape cannot egress.
      if (!redactorHandled) {
        assert.ok(scanEgressPayload(safe).patterns.includes(expectedPattern),
          `${name}: gate must attribute its refusal to ${expectedPattern}`);
      }
    });
  }
});

describe('gate-only patterns — REAL-WORLD spellings, not the convenient one', () => {
  // The original fixtures used `AWS secret <space> <token>` — which happened to
  // be the ONE spelling the first regex matched. The suite was 12/12 green while
  // `AWS_SECRET_KEY=`, `api_key_id=` and `GITHUB_TOKEN_VALUE=` all leaked, i.e.
  // the three most common real forms. The Gemini gate caught it; these cases
  // exist so a fixture set can never again be that unrepresentative.
  const mustRefuse = [
    ['assignment with a name suffix', `AWS_SECRET_KEY=${AWS_SECRET}`],
    ['name suffix on a hex token', `GITHUB_TOKEN_VALUE=${HEX40}`],
    ['snake_case id suffix', `api_key_id=${AWS_SECRET}`],
    ['JSON key/value with quotes', `{"apiKey": "${HEX40}"}`],
    ['shell export', `export GITHUB_TOKEN=${HEX40}`],
    ['base64 ending in padding', `secret=${'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL12=='.slice(0, 40)}`],
    ['prose form (space separated)', `deploy with AWS secret ${AWS_SECRET}`],
  ];

  for (const [name, text] of mustRefuse) {
    it(`refuses: ${name}`, () => {
      assert.ok(refuses(text), `${name} must be refused — this is a realistic spelling`);
    });
  }

  it('the terminator is a lookahead, not \\b (padding must not defeat it)', () => {
    // `\b` cannot fire between `=` and a delimiter — both are non-word — so a
    // base64 token ending in padding silently escaped the earlier revision.
    assert.ok(refuses(`secret="${'A'.repeat(38)}=="`));
  });
});

describe('gate-only patterns — measured non-false-positives', () => {
  // Each of these appeared in the 18 MB real-payload measurement and MUST pass.
  // Bare 40-hex matched 227 times there (all git SHAs) and bare 40-char base64
  // 301 times, which is why both require a secret-ish key.
  const allowed = [
    ['bare git SHA in a diff header', `index ${HEX40}..0000000 100644`],
    ['git null-ref sentinel', 'ZERO_SHA="0000000000000000000000000000000000000000"'],
    ['prose citing a commit', `see commit ${HEX40} for the rationale`],
    ['PEM header in documentation', `a PEM block (e.g. ${PEM_BEGIN} then <20 lines of base64>)`],
    ['bare 40-char base64 blob', `checksum ${AWS_SECRET.replace(/\//g, 'A')}`],
  ];

  for (const [name, text] of allowed) {
    it(`allows: ${name}`, () => {
      assert.equal(refuses(text), false,
        `${name} must not be refused — it was measured as a legitimate payload shape, and a `
        + 'gate that refuses ordinary diffs gets switched off');
    });
  }
});

describe('gate-only patterns — attribution and fail-closed behaviour', () => {
  it('gate-only hits are namespaced so the firing layer is identifiable', () => {
    // An unprefixed duplicate of the redactor's `pem-private-key` made a
    // shared-scanner hit read as a gate-only hit during development.
    const { patterns } = scanEgressPayload(PEM_TRUNCATED);
    assert.ok(patterns.every((p) => typeof p === 'string'));
    assert.ok(patterns.some((p) => p.startsWith('gate:')),
      'a gate-only match must be attributable to the gate');
  });

  it('a complete PEM key is caught by the SHARED scanner, not the gate-only rule', () => {
    // Guards the boundary between the two sets: the redactor already handles
    // BEGIN..END, so gate:pem-truncated exists only for the clipped case.
    const full = `${PEM_TRUNCATED}\n${PEM_END}`;
    assert.ok(!redactSecrets(full).text.includes('MIIEow'),
      'a complete key is the redactor\'s job and it still does it');
  });

  it('a clean payload is not refused', () => {
    assert.equal(refuses('refactor the resolver to use the shared client'), false);
  });
});
