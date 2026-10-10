/**
 * @fileoverview outcomesFromSummary (scripts/lib/dashboard/collect-telemetry.mjs) — the
 * persona-tests outcome panel, read from getPersonaOutcomesSummary's REAL return shape.
 *
 * The first version keyed on a `measured` field that only the CLI wrapper adds; the store
 * function never returns it, so every real summary rendered as "unreadable". The fixture
 * below is a row actually returned by the store (2026-10-10, session 7fb663e2), minus the
 * fields the panel ignores — a hand-written factory would encode the assumption under test.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { outcomesFromSummary } from '../scripts/lib/dashboard/collect-telemetry.mjs';

const REAL = Object.freeze({
  ok: true, cloud: true, sessionId: '7fb663e2-d22c-4eef-8375-84aa87486d6c',
  sessionCreatedAt: '2026-10-10 12:59:20.261602+00',
  persona: 'Software engineer reviewing project health after a burst of changes', verdict: 'Needs work',
  rawP0: 0, rawP1: 1, openP0: 0, openP1: 1, pendingVerificationP0: 0, pendingVerificationP1: 0, staleHashCount: 0,
});

describe('outcomesFromSummary', () => {
  it('a real store row is MEASURED, with its counts', () => {
    assert.deepEqual(outcomesFromSummary(REAL), { measured: true, openP0: 0, openP1: 1, pendingVerification: 0 });
  });

  it('pending verification sums P0 and P1; a numeric string (pg bigint) is accepted', () => {
    const r = outcomesFromSummary({ ...REAL, openP0: '2', pendingVerificationP0: 1, pendingVerificationP1: '3' });
    assert.deepEqual(r, { measured: true, openP0: 2, openP1: 1, pendingVerification: 4 });
  });

  it('a failed read, cloud off, or no session is UNMEASURED with a reason — never zero open', () => {
    assert.match(outcomesFromSummary({ ok: false, error: 'connection refused' }).reason, /connection refused/);
    assert.equal(outcomesFromSummary({ ok: true, cloud: false, sessionId: null }).reason, 'cloud store off');
    assert.match(outcomesFromSummary({ ok: true, cloud: true, sessionId: null }).reason, /no persona-test session/);
    assert.equal(outcomesFromSummary(null).measured, false);
  });

  it('a missing or malformed count is unmeasured, naming the field (H6)', () => {
    for (const bad of [undefined, null, '', 'x', -1, 1.5, Number.NaN]) {
      const r = outcomesFromSummary({ ...REAL, openP1: bad });
      assert.equal(r.measured, false, `openP1=${String(bad)}`);
      assert.match(r.reason, /malformed outcome summary: openP1=/);
    }
  });

  it('a returned error diagnostic is redacted like a thrown one (M2)', () => {
    const r = outcomesFromSummary({ ok: false, error: 'auth failed for postgresql://audit:hunter2secretpassword@db.example:5432/x' });
    assert.ok(!r.reason.includes('hunter2secretpassword'), r.reason);
  });
});
