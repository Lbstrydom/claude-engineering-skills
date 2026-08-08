// decideSeed — eligibility must be assessed INDEPENDENTLY of the env flag.
//
// Before 2026-08-08 this function returned immediately on AUDIT_CACHE_SEED=0,
// so an opted-out run was never assessed and looked identical to one that could
// never have seeded (single unit / prefix too small). Since `units.length <= 1`
// correlates with small audits, the seed-OFF cohort skewed small and the
// hit-rate comparison measured audit SIZE rather than seeding.
//
// These are the assertions that keep the control arm real: an eligible run that
// opts out must still record `seedEligible: true`.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUDIT_EXPORTS_FOR_TESTS = '1';
const { __testExports } = await import('../scripts/lib/audit/legacy-production-audit.mjs');
const { decideSeed } = __testExports;

// A prompt comfortably above the default 1024-token floor (~4 chars/token).
const bigPrompt = () => ({ system: 'x'.repeat(4000), messages: [{ content: 'y'.repeat(4000) }] });
const tinyPrompt = () => ({ system: 'x', messages: [{ content: 'y' }] });
const units = (n) => Array.from({ length: n }, () => ({ files: [], chunk: { imports: '', items: [] } }));

let savedSeed, savedMin;
before(() => { savedSeed = process.env.AUDIT_CACHE_SEED; savedMin = process.env.AUDIT_CACHE_STABLE_PREFIX_MIN; });
after(() => {
  if (savedSeed === undefined) delete process.env.AUDIT_CACHE_SEED; else process.env.AUDIT_CACHE_SEED = savedSeed;
  if (savedMin === undefined) delete process.env.AUDIT_CACHE_STABLE_PREFIX_MIN; else process.env.AUDIT_CACHE_STABLE_PREFIX_MIN = savedMin;
});

describe('decideSeed — the control arm', () => {
  it('opted out but eligible → seedEligible TRUE, seedUsed false, reason env-disabled', () => {
    process.env.AUDIT_CACHE_SEED = '0';
    const d = decideSeed(units(3), 'pass', bigPrompt);
    assert.equal(d.seedUsed, false, 'the env flag must still suppress actual seeding');
    assert.equal(d.seedEligible, true, 'THIS is the control arm — withheld, not impossible');
    assert.equal(d.seedSkipReason, 'env-disabled');
  });

  it('opted out AND ineligible → seedEligible stays false (not a control)', () => {
    process.env.AUDIT_CACHE_SEED = '0';
    const d = decideSeed(units(1), 'pass', bigPrompt);
    assert.equal(d.seedEligible, false);
    assert.equal(d.seedSkipReason, 'units.length<=1');
  });

  it('opted out with too small a prefix → ineligible, not a control', () => {
    process.env.AUDIT_CACHE_SEED = '0';
    process.env.AUDIT_CACHE_STABLE_PREFIX_MIN = '1024';
    const d = decideSeed(units(3), 'pass', tinyPrompt);
    assert.equal(d.seedEligible, false);
    assert.equal(d.seedSkipReason, 'prefix-too-small');
    delete process.env.AUDIT_CACHE_STABLE_PREFIX_MIN;
  });

  it('enabled and eligible → seeds, with no skip reason', () => {
    delete process.env.AUDIT_CACHE_SEED;
    const d = decideSeed(units(3), 'pass', bigPrompt);
    assert.equal(d.seedUsed, true);
    assert.equal(d.seedEligible, true);
    assert.equal(d.seedSkipReason, null);
  });

  it('eligibility does not depend on the env flag — same verdict either way', () => {
    delete process.env.AUDIT_CACHE_SEED;
    const enabled = decideSeed(units(3), 'pass', bigPrompt);
    process.env.AUDIT_CACHE_SEED = '0';
    const disabled = decideSeed(units(3), 'pass', bigPrompt);
    assert.equal(enabled.seedEligible, disabled.seedEligible,
      'the whole point: the flag gates USE, never eligibility');
    assert.notEqual(enabled.seedUsed, disabled.seedUsed);
  });
});
