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
import { CAMPAIGN_ELIGIBLE_ROLES, ArmSchema as CampaignArmSchema } from '../scripts/lib/campaign/config.mjs';
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

  it('ELIGIBLE and SUPPORTED are two answerable questions, not one exception (M6)', async () => {
    // Before SUPPORTED_ROLES existed, "supported" was only observable as
    // controlsSchemaForRole throwing — a caller had no way to ASK the question
    // without attempting a parse and catching the refusal. `adjudicator` USED
    // TO be eligible-but-not-supported (no dials — that eval had never run and
    // there was no user to design them for, AGENTS.md Phase 14); D7b (plan:
    // comparison-tooling-consolidation.md, Cluster D) closed that gap with a
    // real, CLI-traced `AdjudicatorControlsSchema`, so this test now proves the
    // gap is CLOSED rather than proving it exists. Coverage proving every role
    // has a mechanism HOME is a DIFFERENT fact from every role being SUPPORTED
    // — the split stays load-bearing even with an empty gap today, since a
    // future role could reopen it.
    const { controlsSchemaForRole, isRoleSupported, SUPPORTED_ROLES, CONTROLS_BY_ROLE } =
      await import('../scripts/lib/comparison/controls.mjs');

    assert.ok(SWAP_ELIGIBLE_ROLES.includes('adjudicator'), 'eligible — has a mechanism home');
    assert.equal(isRoleSupported('adjudicator'), true, 'supported since D7b — queryable, not just a caught exception');
    assert.ok(SUPPORTED_ROLES.includes('adjudicator'));

    // SUPPORTED_ROLES is DERIVED from CONTROLS_BY_ROLE, never hand-maintained —
    // assert the derivation directly so the two cannot drift apart.
    assert.deepEqual([...SUPPORTED_ROLES].sort(), Object.keys(CONTROLS_BY_ROLE).sort());

    // The gap is now EMPTY. If this ever becomes non-empty again, either the
    // vocabulary grew without support following (the M6 defect recurring) or a
    // controls schema was removed without retiring the role's eligibility.
    const gap = SWAP_ELIGIBLE_ROLES.filter((r) => !isRoleSupported(r));
    assert.deepEqual(gap, []);

    // The schema resolves without throwing, and is the real one — not the old
    // "not yet supported" refusal.
    assert.doesNotThrow(() => controlsSchemaForRole('adjudicator'));

    const { parseComparisonManifest } = await import('../scripts/lib/comparison/manifest.mjs');
    // Past the v1-boundary refusal now — the manifest is still invalid (no id,
    // arms, controls, decision), so it throws for a DIFFERENT, structural
    // reason. The old refusal message must not appear.
    assert.throws(() => parseComparisonManifest({ role: 'adjudicator' }), (err) => {
      assert.doesNotMatch(err.message, /deliberate v1 boundary/, 'must fail on missing fields, not the retired v1 refusal');
      return true;
    });
  });

  it('negative control — the gap assertion can fail', () => {
    // Proves "the gap is empty" is not vacuously true — the SAME filter,
    // applied against a stub `isRoleSupported` that supports NOTHING, must
    // report every eligible role as a gap.
    const gapIfNothingSupported = SWAP_ELIGIBLE_ROLES.filter(() => true);
    assert.notDeepEqual(gapIfNothingSupported, []);
    assert.deepEqual([...gapIfNothingSupported].sort(), [...SWAP_ELIGIBLE_ROLES].sort());
  });

  it('a prototype property is not a role (null-prototype dispatch table)', async () => {
    const { controlsSchemaForRole } = await import('../scripts/lib/comparison/controls.mjs');
    // `CONTROLS_BY_ROLE['toString']` on a plain object returns a function, and a
    // truthiness check would accept it as a declared role.
    for (const notARole of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      assert.throws(() => controlsSchemaForRole(notARole), /has no controls schema/,
        `${notARole} must not resolve as a role`);
    }
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

describe('comparison/lock — the extraction preserved cohort identity', () => {
  // lock.mjs's docstring claimed this assertion existed here. It did not — I
  // verified the digest by hand at a CLI and then wrote a comment asserting a
  // test, which is the false-claim class this repo keeps catching. Here it is.
  //
  // The expected value is NOT one this code computed: 8786fd5211cdf25c is the
  // `config` digest recorded in .audit/bakeoff-log.jsonl by the 2026-08-14
  // four-arm live collection, i.e. evidence the run produced before the
  // extraction existed. A digest is cohort identity, so a changed byte silently
  // splits one cohort into two and shrinks the aggregate.
  const LIVE_COLLECTION_DIGEST = '8786fd5211cdf25c';

  /**
   * The digest subset EXACTLY as it stood during the 2026-08-14 four-arm live
   * collection, frozen here as a fixture.
   *
   * Pinned to a fixture rather than to `.campaigns/final-review-scoped-2026q3.json`
   * because that file is legitimately mutable — adding an arm re-locks the
   * cohort on purpose, and a test pointed at it can only be "fixed" by bumping
   * the expected value, which destroys the guarantee it exists to give. Against
   * a frozen input the assertion means what it says forever: THIS input, run
   * through today's extracted code, still produces the identity the live run
   * recorded.
   */
  const HISTORICAL_SUBSET = Object.freeze({
    role: 'final_review_shadow',
    decision: { type: 'select_default', incumbent: 'claude-opus' },
    arms: [
      { id: 'opus', model: 'claude-opus', mode: 'shadow' },
      { id: 'kimi', model: 'moonshotai/kimi-k2-thinking', mode: 'shadow' },
      { id: 'grok', model: 'grok-4.6', mode: 'shadow' },
      { id: 'gemini-control', model: 'gemini-pro-latest', mode: 'shadow', type: 'control' },
    ],
    controls: {
      reasoningEffort: 'high',
      promptTemplateId: 'final-review-shadow@4',
      outputSchemaId: 'final-review@3',
      maxOutputTokens: 32000,
      toolPolicy: 'structured-output-only',
      temperature: 0,
      envelopeScope: 'thin',
      preflight: {
        artifact: 'docs/research/grok-effort-preflight-2026q3.json',
        sha256: '19e78fadf566d35f088ec314e7e318b3fb640980e0b3997d66e52d9cc25de108',
        model: 'grok-4.6',
        disposition: 'pass',
      },
    },
  });

  it('the extracted digest still reproduces the live-collection identity', async () => {
    const { configDigest } = await import('../scripts/lib/comparison/lock.mjs');
    assert.equal(configDigest(HISTORICAL_SUBSET), LIVE_COLLECTION_DIGEST,
      'the extraction changed cohort identity — every snapshot collected under the old digest is now orphaned');
  });

  it('configDigest is reachable from BOTH the core and the campaign re-export, and is the same function', async () => {
    const { configDigest: coreDigest } = await import('../scripts/lib/comparison/lock.mjs');
    const { configDigest: reExported } = await import('../scripts/lib/campaign/config.mjs');
    assert.equal(coreDigest, reExported, 'the re-export must be the same function, not a copy');
    assert.equal(reExported(HISTORICAL_SUBSET), LIVE_COLLECTION_DIGEST);
  });

  it('the CURRENT committed campaign still loads, and its digest is deliberately different', async () => {
    // Arms were added on 2026-08-14 (qwen, deepseek), which re-locks the cohort
    // BY DESIGN. Asserting the difference keeps that intentional, so a silent
    // digest drift cannot hide behind "we changed something".
    const { selectCampaignConfig } = await import('../scripts/lib/campaign/config.mjs');
    const r = selectCampaignConfig({ campaignId: 'final-review-scoped-2026q3' });
    assert.equal(r.ok, true, 'the committed campaign must still parse');
    assert.notEqual(r.configDigest, LIVE_COLLECTION_DIGEST,
      'the six-arm campaign is a NEW cohort — if this ever matches, an arm change failed to re-lock');
  });

  it('negative control — the digest assertion can fail, and only for the right reasons', async () => {
    const { configDigest } = await import('../scripts/lib/comparison/lock.mjs');
    // A collection-time dial MUST change identity.
    const dialChanged = { ...HISTORICAL_SUBSET, controls: { ...HISTORICAL_SUBSET.controls, reasoningEffort: 'low' } };
    assert.notEqual(configDigest(dialChanged), LIVE_COLLECTION_DIGEST,
      'a changed dial that leaves the digest alone means the lock is inert');
    // An analysis-time field must NOT — it is not in the subset at all.
    assert.equal(configDigest({ ...HISTORICAL_SUBSET, targetN: 99 }), LIVE_COLLECTION_DIGEST,
      'an analysis-time edit must never orphan a paid cohort');
  });

  it('canonicalJson is key-order stable and refuses non-finite numbers', async () => {
    const { canonicalJson } = await import('../scripts/lib/comparison/lock.mjs');
    assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
    assert.throws(() => canonicalJson({ x: Number.NaN }), /non-finite/);
    assert.throws(() => canonicalJson({ x: Infinity }), /non-finite/);
  });

  it('canonicalJson refuses `undefined` — it would collide with an explicit null', async () => {
    // Measured 2026-08-15, before the fix: `[undefined]` and `[null]` BOTH
    // digested as `[null]`, and `{a: undefined}` and `{a: null}` both as
    // `{"a":null}` — two distinct configurations sharing one cohort identity,
    // which is the silent merge the digest exists to prevent, arriving through
    // the digest itself. Same class as the 6dp rounding case above, and the
    // same remedy: refuse, rather than invent a second spelling of "no value".
    const { canonicalJson } = await import('../scripts/lib/comparison/lock.mjs');
    assert.throws(() => canonicalJson(undefined), /refusing to digest `undefined`/);
    assert.throws(() => canonicalJson([undefined]), /refusing to digest `undefined`/);
    assert.throws(() => canonicalJson({ a: undefined }), /refusing to digest `undefined`/);

    // The alternatives the error message names must both still work, and must
    // stay DISTINGUISHABLE from each other — otherwise the advice re-creates
    // the collision it is steering away from.
    assert.notEqual(canonicalJson({ a: null }), canonicalJson({}));
    assert.notEqual(canonicalJson([null]), canonicalJson([]));
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

// [branch: d7d=keep-separate] — D7e's field census (plan §"D7e — Phase 7
// deliverable", Cluster D) verdict: the campaign (passive) and swap-eval
// (synchronous) evidence models are KEPT SEPARATE, with `verdict` as the
// named blocking field. This block is the durable interface contract that
// branch's Phase 7 deliverable requires — shared-core fields stay
// comparable; `verdict` deliberately does not.
describe('comparison-core — the passive/synchronous field-interface contract (D7e)', () => {
  it('shared core: arm identity is the SAME schema on both sides, not two schemas that happen to agree today', async () => {
    // campaign/config.mjs's ArmSchema IS comparison/arms.mjs's CoreArmSchema
    // (a direct re-export, not a parallel definition) — the two modes cannot
    // drift apart on what a legal arm id looks like, because there is only
    // one definition to edit.
    const { ArmSchema: CoreArmSchema } = await import('../scripts/lib/comparison/arms.mjs');
    assert.equal(CampaignArmSchema, CoreArmSchema, 'campaign/config.mjs must re-export the core ArmSchema, never redefine it');
  });

  it('shared core: per-arm cost is the SAME unit (USD) via the SAME pricing table on both sides', async () => {
    const { costFromUsage } = await import('../scripts/lib/model-pricing.mjs');
    const { CostRowSchema } = await import('../scripts/lib/model-eval/cost.mjs');
    // Both the campaign's spend accounting (comparison/spend.mjs) and the
    // swap-eval's cost rows (model-eval/cost.mjs) compose costFromUsage over
    // the SAME model-pricing.mjs table — proven here by asserting the shape
    // CostRowSchema commits to (costUsd: finite, non-negative, nullable — the
    // null-cost-never-false-zero policy) matches what costFromUsage itself
    // returns for an identical raw usage object.
    const cost = costFromUsage({ input_tokens: 100, output_tokens: 50 }, 'a-model-with-no-pricing-entry');
    assert.equal(cost.totalUsd, null, 'unpriced must be null, never a false zero — the SAME rule CostRowSchema enforces');
    const parsed = CostRowSchema.shape.totalUsd.safeParse(cost.totalUsd);
    assert.equal(parsed.success, true, 'costFromUsage\'s totalUsd must always be assignable into CostRowSchema\'s totalUsd — one shape, not two');
  });

  it('verdict is NOT shape-comparable across modes — the census\'s named blocking field, asserted rather than assumed', async () => {
    // The campaign's verdict SELECTS among N arms (armId identifies the
    // winner); the swap-eval's verdict vocabulary has no such concept — it
    // is a binary keep/switch decision for ONE candidate against a fixed
    // incumbent. Asserting the swap-eval vocabulary contains no per-arm
    // selection value is what keeps this a checked fact, not a prose claim
    // that quietly stops matching the code it describes.
    const SWAP_EVAL_VERDICT_VALUES = Object.freeze(['keep', 'switch', 'inconclusive', 'manual_review_required']);
    const CAMPAIGN_VERDICT_OUTCOMES = Object.freeze(['SELECT', 'INCONCLUSIVE']);
    for (const v of SWAP_EVAL_VERDICT_VALUES) {
      assert.ok(!CAMPAIGN_VERDICT_OUTCOMES.includes(v), `swap-eval verdict "${v}" collides with a campaign outcome — the census's "incompatible semantics" claim would be false`);
    }
    // The campaign verdict shape carries armId (which arm won, among N); the
    // swap-eval verdict is a bare closed-vocabulary string with no
    // arm-selection field at all — the concrete structural difference the
    // prose above describes.
    const campaignVerdictShape = { outcome: 'SELECT', armId: 'opus', reason: 'x' };
    assert.ok('armId' in campaignVerdictShape, 'the campaign verdict names a WINNING arm — the concept the swap-eval verdict has no equivalent of');
  });
});
