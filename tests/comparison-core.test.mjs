/**
 * @fileoverview Tier 1 (test-first, deterministic) — the role vocabulary and
 * the per-mechanism eligibility subsets.
 *
 * The defect this locks: two disjoint role enums that could not see each other
 * (`ROLES` in model-eval/contracts.mjs, `role: z.enum(['final_review_shadow'])`
 * in campaign/config.mjs). The fix is a shared VOCABULARY plus per-mechanism
 * ELIGIBILITY subsets — and the subtle failure the audit caught is that a
 * *reference-equality* drift test is unsatisfiable here: a consumer whose
 * eligible set IS `ROLES` accepts every role, which defeats the whole split and
 * would route an auditor manifest into the passive collector.
 *
 * So the assertions are subset + coverage, in BOTH directions.
 *
 * Plan: docs/plans/role-agnostic-comparison-core.md D1.
 */

import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ROLES, RoleSchema, assertEligibleSubset, assertRoleCoverage } from '../scripts/lib/comparison/roles.mjs';
import { CAMPAIGN_ELIGIBLE_ROLES } from '../scripts/lib/campaign/config.mjs';
import { SWAP_ELIGIBLE_ROLES } from '../scripts/lib/model-eval/contracts.mjs';

describe('comparison/roles — the vocabulary', () => {
  it('names every LLM role in this repo\'s audit chain', () => {
    // Pinned deliberately: adding a role is a decision, and it must come with a
    // home (see the coverage test below) rather than appearing here alone.
    assert.deepEqual([...ROLES].sort(), ['adjudicator', 'auditor', 'final_review_shadow']);
  });

  it('is frozen — a consumer cannot mutate the shared vocabulary', () => {
    assert.ok(Object.isFrozen(ROLES));
  });

  it('RoleSchema accepts exactly the vocabulary', () => {
    for (const r of ROLES) assert.equal(RoleSchema.safeParse(r).success, true, `${r} must parse`);
    assert.equal(RoleSchema.safeParse('reviewer').success, false);
    assert.equal(RoleSchema.safeParse('').success, false);
  });
});

describe('comparison/roles — eligibility is a SUBSET, not the vocabulary', () => {
  it('the campaign accepts only final_review_shadow', () => {
    assert.deepEqual([...CAMPAIGN_ELIGIBLE_ROLES], ['final_review_shadow']);
  });

  it('the swap-eval accepts auditor + adjudicator', () => {
    assert.deepEqual([...SWAP_ELIGIBLE_ROLES].sort(), ['adjudicator', 'auditor']);
  });

  it('NEITHER consumer is reference-equal to ROLES — that is the point', () => {
    // The load-bearing negative. If a consumer ever re-exported the vocabulary
    // as its own validator, the passive campaign collector would accept an
    // `auditor` campaign — the sixth collector AGENTS.md forbids by name.
    assert.notEqual(CAMPAIGN_ELIGIBLE_ROLES, ROLES);
    assert.notEqual(SWAP_ELIGIBLE_ROLES, ROLES);
    assert.ok(CAMPAIGN_ELIGIBLE_ROLES.length < ROLES.length, 'campaign eligibility must be a strict subset');
    assert.ok(SWAP_ELIGIBLE_ROLES.length < ROLES.length, 'swap eligibility must be a strict subset');
  });

  it('the campaign refuses the auditor role at the schema boundary', async () => {
    const { CampaignConfigSchema } = await import('../scripts/lib/campaign/config.mjs');
    const fs = await import('node:fs');
    const cfg = JSON.parse(fs.readFileSync('.campaigns/final-review-scoped-2026q3.json', 'utf-8'));
    assert.equal(CampaignConfigSchema.safeParse(cfg).success, true, 'guard: the committed campaign still parses');
    cfg.role = 'auditor';
    assert.equal(CampaignConfigSchema.safeParse(cfg).success, false,
      'an auditor campaign must not parse — that would route it into the passive collector');
  });
});

describe('comparison/roles — coverage, in both directions', () => {
  it('every role is claimed by exactly one mechanism', () => {
    assert.deepEqual(
      assertRoleCoverage({ campaign: CAMPAIGN_ELIGIBLE_ROLES, swapEval: SWAP_ELIGIBLE_ROLES }),
      { ok: true },
    );
  });

  it('an UNCLAIMED role fails — a name nothing can run', () => {
    // Direction 1: the vocabulary grew without giving the new role a home.
    assert.throws(
      () => assertRoleCoverage({ campaign: ['final_review_shadow'], swapEval: ['auditor'] }),
      /adjudicator.*no.*mechanism accepts|no mechanism accepts them/s,
    );
  });

  it('an OVERLAPPING role fails — two mechanisms both believing they own it', () => {
    // Direction 2, and the dangerous one: this is what "the campaign quietly
    // acquired the auditor" would look like.
    assert.throws(
      () => assertRoleCoverage({
        campaign: ['final_review_shadow', 'auditor'],
        swapEval: ['auditor', 'adjudicator'],
      }),
      /claimed by both/,
    );
  });

  it('assertEligibleSubset rejects an invented role, a duplicate, and an empty set', () => {
    assert.throws(() => assertEligibleSubset(['reviewer'], 'x'), /not in the vocabulary/);
    assert.throws(() => assertEligibleSubset(['auditor', 'auditor'], 'x'), /duplicate/);
    assert.throws(() => assertEligibleSubset([], 'x'), /non-empty/);
    assert.throws(() => assertEligibleSubset(null, 'x'), /non-empty/);
  });

  it('negative control — the coverage assertion can fail', () => {
    // Guards against a vacuous pass: if assertRoleCoverage ever became a no-op
    // returning {ok:true} unconditionally, the two direction tests above would
    // still "pass" only because assert.throws would fail. Prove the happy path
    // and a failing path are distinguishable.
    assert.doesNotThrow(() => assertRoleCoverage({ a: ['auditor', 'adjudicator'], b: ['final_review_shadow'] }));
    assert.throws(() => assertRoleCoverage({ a: ['auditor'] }));
  });
});
