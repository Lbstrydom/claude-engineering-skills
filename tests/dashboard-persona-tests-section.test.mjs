/**
 * @fileoverview Regression coverage for scripts/lib/dashboard/sections/persona-tests.mjs
 * (WS3, docs/plans/persona-nav-feedback-recovery.md) — code-audit M1/L1
 * fix: a malformed telemetry shape or an unparseable timestamp used to
 * throw / render "NaN days ago" instead of degrading honestly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import sectionPersonaTests, { _daysAgoForTests as daysAgo } from '../scripts/lib/dashboard/sections/persona-tests.mjs';
import { buildUi } from '../scripts/lib/dashboard/helpers.mjs';

describe('_daysAgoForTests (persona-tests section)', () => {
  it('returns null for an absent timestamp', () => {
    assert.equal(daysAgo(null), null);
    assert.equal(daysAgo(undefined), null);
    assert.equal(daysAgo(''), null);
  });

  it('returns null (never NaN) for an unparseable timestamp — code-audit L1 fix', () => {
    assert.equal(daysAgo('not-a-date'), null);
    // JS's Date constructor is notably lenient (some numeric-looking
    // fragments parse as valid-but-wrong dates); use an input with an
    // out-of-range component, which reliably produces Invalid Date.
    assert.equal(daysAgo('2024-13-45'), null);
  });

  it('returns 0 for a timestamp in the last 24h', () => {
    assert.equal(daysAgo(new Date().toISOString()), 0);
  });

  it('returns a positive integer for an older timestamp', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
    assert.equal(daysAgo(tenDaysAgo), 10);
  });
});

describe('sectionPersonaTests — defensive shape handling (code-audit M1 fix)', () => {
  const ui = buildUi();

  it('renders the empty panel when personaTests is missing-optional', () => {
    const html = sectionPersonaTests({ src: { status: 'missing-optional', detail: 'no repo identity' }, personaTests: null }, ui);
    assert.match(html, /no repo identity/);
  });

  it('renders the empty panel when cloud is false, never throws', () => {
    const html = sectionPersonaTests({ src: { status: 'ok', detail: '' }, personaTests: { cloud: false, latestByPersona: [], trend: [], correlations: { total: 0, byType: [] } } }, ui);
    assert.match(html, /No persona sessions recorded yet/);
  });

  it('degrades to a warning panel (never throws) on a malformed telemetry shape', () => {
    const malformed = { cloud: true, latestByPersona: null, trend: undefined, correlations: {} };
    assert.doesNotThrow(() => sectionPersonaTests({ src: { status: 'ok', detail: '' }, personaTests: malformed }, ui));
    const html = sectionPersonaTests({ src: { status: 'ok', detail: '' }, personaTests: malformed }, ui);
    assert.match(html, /malformed|warn-panel/);
  });

  it('renders latest-by-persona cards + trend table + correlation line for valid data', () => {
    const data = {
      cloud: true,
      latestByPersona: [{ persona: 'Pieter', verdict: 'PASS', p0Count: 0, p1Count: 1, createdAt: new Date().toISOString() }],
      trend: [{ persona: 'Pieter', verdict: 'PASS', p0Count: 0, p1Count: 1, createdAt: new Date().toISOString() }],
      correlations: { total: 3, byType: [{ type: 'confirmed_hit', count: 2 }, { type: 'audit_missed', count: 1 }] },
    };
    const html = sectionPersonaTests({ src: { status: 'ok', detail: '' }, personaTests: data }, ui);
    assert.match(html, /Pieter/);
    assert.match(html, /confirmed_hit/);
  });

  it('shows the "correlation loop has not fired yet" callout when sessions exist but correlations are zero', () => {
    const data = {
      cloud: true,
      latestByPersona: [{ persona: 'Pieter', verdict: 'PASS', p0Count: 0, p1Count: 0, createdAt: new Date().toISOString() }],
      trend: [{ persona: 'Pieter', verdict: 'PASS', p0Count: 0, p1Count: 0, createdAt: new Date().toISOString() }],
      correlations: { total: 0, byType: [] },
    };
    const html = sectionPersonaTests({ src: { status: 'ok', detail: '' }, personaTests: data }, ui);
    assert.match(html, /has not fired yet/);
  });
});
