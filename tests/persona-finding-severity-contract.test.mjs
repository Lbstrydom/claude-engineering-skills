/**
 * @fileoverview Pins the ONE field name that decides whether a persona
 * finding is P0/P1 — the seam where the WS1 correlator silently produced
 * zero rows for its entire life.
 *
 * THE DEFECT (measured 2026-08-11 on the live store). Every consumer of a
 * persona finding read `finding.code`, but `skills/persona-test/SKILL.md`
 * has told the agent to emit `severity` since 2026-04-19 (cb1679ba) — the
 * report fence renders `[P<n>]` and the finding contract reads "Every
 * finding needs `element`, `observed`, `fix`, `severity`, `confidence`".
 * There is no `code` anywhere in the authoring contract. All 7 live
 * sessions carry `{fix,title,element,observed,severity,confidence}`.
 * `isP0OrP1` therefore matched 0 of 7 sessions' findings while the stored
 * `p0_count`/`p1_count` said 2, 3 and 3 — so `runAutoCorrelate` returned
 * `no-p0p1-findings`, the SAME reason a legitimately clean session gets,
 * and `persona_audit_correlations` stayed empty store-wide.
 *
 * Why the correlator's own tests never caught it: every fixture in
 * `persona-audit-correlator.test.mjs` is built from a `code`-shaped
 * factory, so the suite proved the reader against a shape production has
 * never emitted. This file asserts the CONTRACT shape instead.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  personaSeverityCode, isP0OrP1, isSeverityUnderstated, personaFindingHash,
  decideCorrelations,
} from '../scripts/lib/persona/audit-correlator.mjs';

const noRoute = () => new Map();

/**
 * Byte-for-byte the shape `skills/persona-test/SKILL.md` Phase 3 specifies
 * and every live session stores — `severity`, no `code`, no `step`, no
 * `expected`.
 */
const contractFinding = (over = {}) => ({
  fix: 'Await the bulk delete and refresh the inventory views.',
  title: 'Bulk delete succeeds server-side but the row stays on screen',
  element: '.wine-list-island BulkActionBar delete',
  observed: 'Rows remain visible after a successful bulk delete.',
  severity: 'P1',
  confidence: 0.9,
  ...over,
});

/** The undocumented legacy spelling the readers were originally written against. */
const legacyFinding = (over = {}) => ({
  code: 'P0', step: 1, element: 'Checkout button',
  observed: 'Checkout page crashes on click.', ...over,
});

const auditFinding = (over = {}) => ({
  id: 'audit-1', run_id: 'run-1', finding_fingerprint: 'ffffffff',
  severity: 'HIGH', category: 'crash', primary_file: 'src/pages/checkout.tsx',
  detail_snapshot: 'Checkout page throws on click event.',
  run_created_at: '2026-07-13T00:00:00Z',
  ...over,
});

describe('personaSeverityCode — the single oracle for a persona finding severity', () => {
  it('reads the DOCUMENTED `severity` field (SKILL.md Phase 3 contract)', () => {
    assert.equal(personaSeverityCode({ severity: 'P0' }), 'P0');
    assert.equal(personaSeverityCode({ severity: 'P1' }), 'P1');
  });

  it('still reads the legacy `code` field, so old fixtures/sessions keep working', () => {
    assert.equal(personaSeverityCode({ code: 'P0' }), 'P0');
  });

  it('prefers `severity` when a finding carries both (it is the documented field)', () => {
    assert.equal(personaSeverityCode({ severity: 'P1', code: 'P0' }), 'P1');
  });

  it('normalises case/whitespace and degrades to empty string, never throws', () => {
    assert.equal(personaSeverityCode({ severity: ' p0 ' }), 'P0');
    assert.equal(personaSeverityCode({}), '');
    assert.equal(personaSeverityCode(null), '');
    assert.equal(personaSeverityCode({ severity: 3 }), '');
  });
});

describe('isP0OrP1 accepts the shape persona-test actually emits', () => {
  it('matches a contract-shaped (severity) P1 finding — the live-store regression', () => {
    assert.equal(isP0OrP1(contractFinding()), true);
    assert.equal(isP0OrP1(contractFinding({ severity: 'P0' })), true);
  });

  it('still matches the legacy code-shaped finding', () => {
    assert.equal(isP0OrP1(legacyFinding()), true);
  });

  it('rejects P2/P3 in BOTH spellings — the filter must not widen', () => {
    assert.equal(isP0OrP1(contractFinding({ severity: 'P2' })), false);
    assert.equal(isP0OrP1(contractFinding({ severity: 'P3' })), false);
    assert.equal(isP0OrP1({ code: 'P2' }), false);
    assert.equal(isP0OrP1({}), false);
  });
});

describe('isSeverityUnderstated reads the same oracle', () => {
  it('a contract-shaped P0 against a LOW audit finding is understated', () => {
    assert.equal(isSeverityUnderstated(contractFinding({ severity: 'P0' }), { severity: 'LOW' }), true);
    assert.equal(isSeverityUnderstated(contractFinding({ severity: 'P1' }), { severity: 'LOW' }), false);
  });
});

describe('decideCorrelations on a real live-store session shape', () => {
  // The three sessions that should have correlated and did not:
  // 2026-07-21 (P1=2), 2026-07-28 (P1=3), 2026-08-10 (P0=2 P1=1).
  const session = [
    contractFinding({ severity: 'P0', element: 'Checkout button', observed: 'Checkout page crashes on click.' }),
    contractFinding({ severity: 'P1', element: 'Settings panel', observed: 'Theme toggle does not persist.' }),
    contractFinding({ severity: 'P2', element: 'Footer', observed: 'Copyright year is stale.' }),
  ];

  it('emits one correlation per P0/P1 — not zero (the store-wide empty-table bug)', () => {
    const { emissions, malformed } = decideCorrelations({
      findings: session, clickPath: [], candidates: [auditFinding()],
      alreadyCorrelatedHashes: new Set(),
    });
    assert.equal(malformed, 0);
    assert.equal(emissions.length, 2, 'both P0/P1 findings must be decided; P2 must not be');
  });

  it('stamps a real personaSeverity on every emission — never undefined', () => {
    const { emissions } = decideCorrelations({
      findings: session, clickPath: [], candidates: [auditFinding()],
      alreadyCorrelatedHashes: new Set(),
    });
    // `persona_severity` is a NOT NULL column and `recordPersonaAuditCorrelation`
    // silently no-ops on a falsy one — an undefined here is a dropped write.
    for (const e of emissions) {
      assert.ok(['P0', 'P1'].includes(e.personaSeverity), `expected P0/P1, got ${JSON.stringify(e.personaSeverity)}`);
    }
  });

  it('the P0 against a LOW audit finding routes to severity_understated', () => {
    const { emissions } = decideCorrelations({
      findings: [session[0]], clickPath: [], candidates: [auditFinding({ severity: 'LOW' })],
      alreadyCorrelatedHashes: new Set(),
    });
    assert.equal(emissions[0].correlationType, 'severity_understated');
  });
});

describe('hash back-compatibility — no PERSONA_FINDING_HASH_VERSION bump is owed', () => {
  // Pinned by running the PRE-fix implementation on 2026-08-11. Routing the
  // severity component through `personaSeverityCode` must leave a legacy
  // code-shaped finding's v2 identity byte-identical, so the 0 persisted
  // correlations / 0 outcome rows are not the only thing protecting us.
  it('a legacy code-shaped finding hashes to its pre-fix value', () => {
    assert.equal(
      personaFindingHash(
        { code: 'P0', step: 1, element: 'Checkout button', expected: 'Order confirms', observed: 'Page crashes' },
        new Map([[1, '/checkout']]),
      ),
      'd086343ceee31fcd0910424b79b5d56b7f791109495c01c57885dd4d1ce3439e',
    );
  });

  it('severity and code spellings of the SAME observation share one identity', () => {
    const base = { step: 1, element: 'Checkout button', expected: 'Order confirms', observed: 'Page crashes' };
    assert.equal(
      personaFindingHash({ ...base, severity: 'P0' }, new Map([[1, '/checkout']])),
      personaFindingHash({ ...base, code: 'P0' }, new Map([[1, '/checkout']])),
    );
  });
});
