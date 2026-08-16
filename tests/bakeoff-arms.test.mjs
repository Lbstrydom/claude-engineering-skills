/**
 * @fileoverview Arm derivation + `ResolvedScope` resolution (D1, D1c).
 *
 * Split out of `final-review-bakeoff.test.mjs` (Phase 1, plan:
 * comparison-tooling-consolidation.md); imports redirected to their real
 * homes in Phase 2 (D2) — `scripts/lib/bakeoff/arms.mjs` + `scope.mjs`.
 *
 * @module tests/bakeoff-arms
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import nodeOs from 'node:os';

import {
  deriveArms, transportForModel, computeCollectLock, resolveArms,
} from '../scripts/lib/bakeoff/arms.mjs';
import { armRequestFingerprint, classifyArmCollisions } from '../scripts/lib/comparison/fingerprint.mjs';
import {
  createResolvedScope, assertResolvedScope, assertScopeMatches,
  UnresolvedScopeError, ScopeMismatchError,
} from '../scripts/lib/bakeoff/scope.mjs';
import { parseCampaignConfig } from '../scripts/lib/campaign/config.mjs';

/**
 * The LEGACY hardcoded arms — the byte-for-byte reference `deriveArms`'s
 * output is tested against. No longer a live production symbol anywhere
 * (D1 removed the runtime fallback; D2/Phase 2 completes the move by
 * inlining this as a fixture literal rather than importing a frozen
 * constant a production module no longer needs to export). In run order.
 * Arm 1 IS the ordinary gate config.
 */
const LEGACY_ARMS = Object.freeze([
  { id: 'opus', env: { FINAL_REVIEW_SHADOW: 'claude-opus', FINAL_REVIEW_PROMPT_CACHE: '1' } },
  { id: 'solo-opus', solo: true, args: ['--provider', 'claude-opus'], env: { FINAL_REVIEW_SHADOW: '', FINAL_REVIEW_PROMPT_CACHE: '1' } },
  // Explicitly blanked, not merely omitted: every arm must be a function of this
  // table alone, never of whatever the operator happens to have exported. The
  // flag is inert on the OpenRouter transport anyway — stating it keeps that a
  // property of the config rather than a coincidence of the wire shape.
  { id: 'kimi', env: { FINAL_REVIEW_SHADOW: 'openrouter', FINAL_REVIEW_SHADOW_MODEL: 'moonshotai/kimi-k2-thinking', FINAL_REVIEW_PROMPT_CACHE: '' } },
]);

const REAL_CAMPAIGN = JSON.parse(nodeFs.readFileSync('.campaigns/final-review-2026q3.json', 'utf-8'));
const campaign = () => parseCampaignConfig(JSON.parse(JSON.stringify(REAL_CAMPAIGN))).config;
const tmpDir = (tag) => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), tag));

/**
 * Frozen fixtures for the tests that assert live `.campaigns/*.json` CONTENT
 * directly (Phase 5 revision, plan: comparison-tooling-consolidation.md D3) —
 * arm ids, model names, envelope scope, the control arm's pinned model.
 *
 * Pinned here rather than read live, following `tests/comparison-core.test.mjs`'s
 * `HISTORICAL_SUBSET` pattern: both committed campaign files are legitimately
 * mutable (an arm was already added to `final-review-scoped-2026q3.json` once,
 * 2026-08-14, re-locking the cohort on purpose — see this plan's own §1 incident
 * (c)), and a test pinned to disk content can only be "fixed" by bumping its
 * expected value when that happens, which destroys the guarantee it exists to
 * give. A frozen snapshot means the assertion is about THIS input, run through
 * today's `deriveArms`/`createResolvedScope`, forever — not about whatever the
 * campaign file happens to say today. General derivation-logic tests elsewhere
 * in this file (declaration order, replicate marking, solo-arm shape, …) keep
 * reading the live `campaign()` helper deliberately: they exercise the
 * transformation on ANY well-formed config and do not hardcode expectations
 * about specific arm names, so they are not the "asserts live content
 * directly" class this fixture exists for.
 */
const FROZEN_CAMPAIGN = Object.freeze({
  schemaVersion: 1, id: 'final-review-2026q3', role: 'final_review_shadow',
  decision: { type: 'select_default', incumbent: 'claude-opus' },
  arms: [
    { id: 'opus', model: 'claude-opus', mode: 'shadow' },
    { id: 'solo-opus', model: 'claude-opus', mode: 'primary', type: 'replicate' },
    { id: 'kimi', model: 'moonshotai/kimi-k2-thinking', mode: 'shadow' },
  ],
  controls: {
    reasoningEffort: 'high', promptTemplateId: 'final-review-shadow@4', outputSchemaId: 'final-review@3',
    maxOutputTokens: 32000, toolPolicy: 'structured-output-only', temperature: 0, envelopeScope: 'full',
  },
  adjudicator: { model: 'latest-opus', promptTemplateId: 'campaign-adjudicate@1', outputSchemaId: 'adjudication-verdict@1' },
  calibration: { sampleRate: 0.2 }, targetN: 12,
  decisionRule: { floorMetric: 'accepted_high_med_per_snapshot', floorMargin: 0.5, tiebreak: 'cost_per_accepted', costCeilingUsdPerAccepted: 8 },
});

const FROZEN_SCOPED_CAMPAIGN = Object.freeze({
  schemaVersion: 1, id: 'final-review-scoped-2026q3', role: 'final_review_shadow',
  decision: { type: 'select_default', incumbent: 'claude-opus' },
  arms: [
    { id: 'opus', model: 'claude-opus', mode: 'shadow' },
    { id: 'kimi', model: 'moonshotai/kimi-k2-thinking', mode: 'shadow' },
    { id: 'grok', model: 'grok-4.6', mode: 'shadow' },
    { id: 'qwen', model: 'qwen/qwen3.8-max', mode: 'shadow' },
    { id: 'deepseek', model: 'deepseek/deepseek-v4-pro', mode: 'shadow' },
    { id: 'gemini-control', model: 'gemini-pro-latest', mode: 'shadow', type: 'control' },
  ],
  controls: {
    reasoningEffort: 'high', promptTemplateId: 'final-review-shadow@4', outputSchemaId: 'final-review@3',
    maxOutputTokens: 32000, toolPolicy: 'structured-output-only', temperature: 0, envelopeScope: 'thin',
    preflight: {
      artifact: 'docs/research/grok-effort-preflight-2026q3.json',
      sha256: '19e78fadf566d35f088ec314e7e318b3fb640980e0b3997d66e52d9cc25de108',
      model: 'grok-4.6', disposition: 'pass',
    },
  },
  adjudicator: { model: 'latest-opus', promptTemplateId: 'campaign-adjudicate@1', outputSchemaId: 'adjudication-verdict@1' },
  calibration: { sampleRate: 0.2 }, targetN: 12,
  decisionRule: { floorMetric: 'accepted_high_med_per_snapshot', floorMargin: 0.5, tiebreak: 'cost_per_accepted', costCeilingUsdPerAccepted: 8 },
});

/** Same transformation `resolveArms` applies internally, over a frozen input
 *  instead of a disk read — deriveArms + createResolvedScope, the two steps
 *  these tests actually exercise. */
function resolveFrozenScope(frozenJson) {
  const { config } = parseCampaignConfig(JSON.parse(JSON.stringify(frozenJson)));
  const arms = deriveArms(config);
  const scope = createResolvedScope(config.id, arms, config.controls?.envelopeScope ?? null);
  return { source: `campaign:${config.id}`, scope, config };
}

// ── deriveArms — the refactor must change no request ────────────────────────
// docs/plans/model-comparison-campaigns.md §7b Phase 2, D4.

describe('deriveArms — the refactor must change no request', () => {
  it('the derived arms are BYTE-IDENTICAL to the hardcoded table they replace', () => {
    // This is the whole safety argument for Phase 2. `ARMS` was a frozen table
    // whose env/args decide what is actually sent, so deriving it from a config
    // is only safe if the wire shape is unchanged — and "unchanged" has to mean
    // key-for-key, not "looks equivalent". `LEGACY_ARMS`'s one remaining honest
    // role (D1c): it is no longer a runtime fallback, only this fixture.
    //
    // Against FROZEN_CAMPAIGN, not the live campaign() helper (Phase 5
    // revision) — this assertion is specifically about the committed file's
    // CONTENT matching the legacy table, so it must not silently start
    // passing/failing on an unrelated future edit to that file.
    const derived = deriveArms(parseCampaignConfig(JSON.parse(JSON.stringify(FROZEN_CAMPAIGN))).config);
    assert.equal(derived.length, LEGACY_ARMS.length);
    for (const [i, legacy] of LEGACY_ARMS.entries()) {
      const got = derived[i];
      assert.equal(got.id, legacy.id, `arm ${i} id`);
      assert.deepEqual(got.env, legacy.env, `arm ${legacy.id} env must match key-for-key`);
      assert.deepEqual(got.args ?? undefined, legacy.args ?? undefined, `arm ${legacy.id} args`);
      assert.equal(got.solo ?? undefined, legacy.solo ?? undefined, `arm ${legacy.id} solo`);
      // env key ORDER too: the spawn env is how a reader diffs two runs, and a
      // reordered object reads as a change.
      assert.equal(JSON.stringify(got.env), JSON.stringify(legacy.env), `arm ${legacy.id} env key order`);
    }
  });

  it('preserves DECLARATION order — the two Opus arms stay adjacent', () => {
    // Order is not cosmetic: adjacency keeps the second identical Opus prompt
    // inside the 5-minute cache TTL. Sorting for tidiness would change no
    // request and no result, only whether that send is billed at 1.0x or 0.1x.
    assert.deepEqual(deriveArms(campaign()).map((a) => a.id), ['opus', 'solo-opus', 'kimi']);
    const reordered = campaign();
    reordered.arms = [reordered.arms[2], reordered.arms[0], reordered.arms[1]];
    assert.deepEqual(deriveArms(reordered).map((a) => a.id), ['kimi', 'opus', 'solo-opus'], 'config order is the run order, verbatim');
  });

  it('a primary arm runs with NO shadow, blanked explicitly rather than omitted', () => {
    const solo = deriveArms(campaign()).find((a) => a.id === 'solo-opus');
    assert.equal(solo.solo, true);
    assert.deepEqual(solo.args, ['--provider', 'claude-opus']);
    assert.equal(solo.env.FINAL_REVIEW_SHADOW, '', 'an arm must be a function of the config, never of the ambient environment');
    assert.ok('FINAL_REVIEW_SHADOW' in solo.env, 'blanked, not absent — an absent var inherits whatever the operator exported');
  });

  it('marks declared replicates so model-level metrics can exclude them', () => {
    assert.deepEqual(deriveArms(campaign()).filter((a) => a.replicate).map((a) => a.id), ['solo-opus']);
  });
});

describe('transportForModel — the HOW the config deliberately does not express', () => {
  it('classifies each family onto its wire shape', () => {
    assert.equal(transportForModel('claude-opus').route, 'anthropic');
    assert.equal(transportForModel('claude-opus').promptCache, '1', 'cache multipliers are an Anthropic-only feature');
    assert.equal(transportForModel('moonshotai/kimi-k2-thinking').route, 'openrouter');
    assert.equal(transportForModel('moonshotai/kimi-k2-thinking').shadowModel, 'moonshotai/kimi-k2-thinking');
    assert.equal(transportForModel('gemini-pro-latest').route, 'gemini');
  });

  it('a concrete Claude model rides in SHADOW_MODEL; the bare family token does not', () => {
    assert.equal(transportForModel('claude-opus').shadowModel, null, 'omitted so the derived arm stays byte-identical');
    assert.equal(transportForModel('claude-opus-5').shadowModel, 'claude-opus-5');
  });

  it('REFUSES an unknown family instead of guessing a token', () => {
    // A fabricated FINAL_REVIEW_SHADOW value does not fail here — it fails
    // inside a spawned reviewer, after the arm is counted as attempted.
    for (const bad of ['llama-3', 'mistral-large', '', null]) {
      assert.throws(() => transportForModel(bad), /no transport for model|must be a non-empty string/);
    }
  });
});

describe('D4 — rerolls are classified before spend, never discovered after', () => {
  it('detects that opus and solo-opus send an IDENTICAL request', () => {
    const fps = classifyArmCollisions(campaign()).fingerprints;
    assert.equal(fps.opus, fps['solo-opus'], 'shadow-vs-primary is not a difference in the REQUEST');
    assert.notEqual(fps.opus, fps.kimi);
  });

  it('permits the collision BECAUSE solo-opus is a declared replicate', () => {
    assert.equal(classifyArmCollisions(campaign()).ok, true);
  });

  it('REFUSES an undeclared duplicate — a reroll masquerading as a comparison', () => {
    const cfg = campaign();
    delete cfg.arms.find((a) => a.id === 'solo-opus').type;
    const r = classifyArmCollisions(cfg);
    assert.equal(r.ok, false);
    assert.match(r.message, /IDENTICAL request/);
    assert.match(r.message, /solo-opus/);
    assert.match(r.message, /Refusing before spend/);
  });

  it('the fingerprint keys on the request, not on ids or mode', () => {
    const cfg = campaign();
    const before = armRequestFingerprint(cfg.arms[0], cfg.controls);
    assert.equal(armRequestFingerprint({ ...cfg.arms[0], id: 'renamed', mode: 'primary' }, cfg.controls), before,
      'renaming an arm or flipping its mode does not change what is sent');
    assert.notEqual(armRequestFingerprint(cfg.arms[0], { ...cfg.controls, reasoningEffort: 'low' }), before,
      'a control dial DOES change what is sent');
  });
});

describe('collect-time lock', () => {
  it('changes when resolved reality changes, and is honest about what it can see', () => {
    const cfg = campaign();
    const arms = deriveArms(cfg);
    const base = computeCollectLock(cfg, 'cfgdigest00000000', arms);
    assert.match(base.lockDigest, /^[0-9a-f]{16}$/);
    // The stated limitation is carried in the record, not buried in a comment:
    // this lock sees a DECLARED template change, not an undeclared edit to the
    // template body (assembled inside gemini-review — Cluster B's).
    assert.equal(base.promptTemplateSource, 'declared-id');

    const swapped = { ...cfg, adjudicator: { ...cfg.adjudicator, model: 'latest-sonnet' } };
    assert.notEqual(computeCollectLock(swapped, 'cfgdigest00000000', arms).lockDigest, base.lockDigest);
    assert.notEqual(computeCollectLock(cfg, 'DIFFERENT0000000', arms).lockDigest, base.lockDigest);
    const effort = { ...cfg, controls: { ...cfg.controls, reasoningEffort: 'low' } };
    assert.notEqual(computeCollectLock(effort, 'cfgdigest00000000', arms).lockDigest, base.lockDigest);
  });
});

// ── resolveArms — D1: derived from the committed campaign, no other source ──

describe('resolveArms — selection is a refusal, never a silent fallback', () => {
  it('derives from a NAMED committed campaign', () => {
    // With two real committed campaigns, "no campaignId" is correctly
    // ambiguous — see the dedicated test below for that real, repo-level case.
    const r = resolveArms({ campaignId: 'final-review-2026q3' });
    assert.equal(r.source, 'campaign:final-review-2026q3');
    assert.equal(r.scope.arms.length, 3);
    assert.equal(r.scope.campaignId, 'final-review-2026q3');
    assert.ok(r.lock.lockDigest);
  });

  it('derives from the NEW scoped campaign, with the scoped controls intact', () => {
    // Against FROZEN_SCOPED_CAMPAIGN, not a live `resolveArms({campaignId})`
    // disk read (Phase 5 revision) — this assertion names the exact arm set
    // and envelope scope the committed file declared when written, which is
    // legitimately mutable (an arm was already added once, re-locking the
    // cohort on purpose — see this plan's §1 incident (c)) and must not
    // silently start asserting a different "NEW" every time it changes again.
    const r = resolveFrozenScope(FROZEN_SCOPED_CAMPAIGN);
    assert.equal(r.source, 'campaign:final-review-scoped-2026q3');
    // `gemini-control` joined on 2026-08-14 as a declared CONTROL arm — Gemini
    // is the incumbent primary reviewer, so running it in the shadow slot
    // separates "is Opus the better second reviewer" from "is a fresh second
    // look worth anything at all".
    assert.deepEqual(r.scope.arms.map((a) => a.id).sort(), ['deepseek', 'gemini-control', 'grok', 'kimi', 'opus', 'qwen']);
    assert.equal(r.config.controls.envelopeScope, 'thin');
    assert.equal(r.config.controls.preflight.disposition, 'pass');
    assert.equal(r.scope.expectedScope, 'thin', 'the scope carries the same envelope the config declares');
  });

  it('the control arm is COLLECTED but not scored, and pins a concrete model', () => {
    const r = resolveFrozenScope(FROZEN_SCOPED_CAMPAIGN);
    const control = r.scope.arms.find((a) => a.id === 'gemini-control');
    assert.ok(control, 'the control arm must still be collected — it is evidence, just not a candidate');
    // On a DERIVED arm, `replicate` means "collected but not scored": it gates
    // neither completeness nor the standings. If this flips to false the
    // control starts gating snapshot completeness and can enter the verdict —
    // the two things a control must never do.
    assert.equal(control.replicate, true, 'a control must be excluded from scoring and completeness');
    // The three scored arms are unaffected.
    for (const id of ['opus', 'kimi', 'grok', 'qwen', 'deepseek']) {
      assert.equal(r.scope.arms.find((a) => a.id === id).replicate, false, `${id} must remain a scored arm`);
    }
    // Concrete id, not the bare family token: the gemini branch of
    // `transportForModel` forwards its model verbatim, and `resolveModel`
    // passes 'gemini' through unchanged, so the bare token would ship a
    // nonexistent model id and 404 on every snapshot.
    assert.equal(control.env.FINAL_REVIEW_SHADOW_MODEL, 'gemini-pro-latest');
    assert.equal(control.env.FINAL_REVIEW_SHADOW, 'gemini');
  });

  it('the REAL `.campaigns/` directory is ambiguous with no --campaign — refuses, names both', () => {
    // This is production behaviour, not a synthetic fixture: with two real
    // committed campaigns, `--progress` / a bare collect with no --campaign
    // must refuse rather than silently picking one — the same "never guess
    // which campaign ran" rule the synthetic ambiguity test below also checks,
    // now exercised against this repo's actual .campaigns/ contents.
    assert.throws(() => resolveArms({}), /pass --campaign.*final-review-2026q3.*final-review-scoped-2026q3|pass --campaign.*final-review-scoped-2026q3.*final-review-2026q3/);
  });

  it('a repo with NO campaign config REFUSES — "no campaign, no run" (D1)', () => {
    // Was a silent fallback to `LEGACY_ARMS`. `bakeoff-collect.mjs` ships to no
    // consumer (sync-to-repos.mjs confirms it), and this repo itself has two
    // committed campaigns, so the branch was already unreachable here — D1
    // deletes it rather than leaving an unreachable-but-still-silent fallback.
    assert.throws(() => resolveArms({ dir: tmpDir('no-campaigns-') }), UnresolvedScopeError);
  });

  it('THROWS on ambiguity rather than falling back or picking one', () => {
    // Falling back to the legacy table here would run a DIFFERENT comparison
    // than either declared campaign, silently.
    const dir = tmpDir('two-campaigns-');
    const a = campaign(); a.id = 'alpha';
    const b = campaign(); b.id = 'beta';
    nodeFs.writeFileSync(nodePath.join(dir, 'a.json'), JSON.stringify(a));
    nodeFs.writeFileSync(nodePath.join(dir, 'b.json'), JSON.stringify(b));
    assert.throws(() => resolveArms({ dir }), /pass --campaign/);
    assert.equal(resolveArms({ dir, campaignId: 'beta' }).source, 'campaign:beta');
  });

  it('an undeclared collision refuses at RESOLVE time — before any arm is spawned', () => {
    const dir = tmpDir('collide-campaign-');
    const cfg = campaign();
    // A SECOND kimi arm, undeclared. Note what this does not do: stripping
    // `type` from solo-opus instead would trip the incumbent-ambiguity rule
    // first (two non-replicate arms would then carry the incumbent model), so
    // the config would be refused by the schema and D4 would never run — a
    // refusal either way, but not a test of this rule.
    cfg.arms.push({ id: 'kimi-again', model: 'moonshotai/kimi-k2-thinking', mode: 'shadow' });
    nodeFs.writeFileSync(nodePath.join(dir, 'c.json'), JSON.stringify(cfg));
    assert.throws(() => resolveArms({ dir }), /D4/);
  });
});

// ── D1 — the ResolvedScope contract table ───────────────────────────────────

describe('ResolvedScope — createResolvedScope / assertResolvedScope / assertScopeMatches (D1)', () => {
  const ARMS = [{ id: 'a', model: 'm' }, { id: 'b', model: 'm' }];

  it('scope absent — refused', () => {
    assert.throws(() => assertResolvedScope(undefined), UnresolvedScopeError);
    assert.throws(() => assertResolvedScope(null), UnresolvedScopeError);
  });

  it('scope malformed — missing campaignId, missing arms, empty arms — each refused', () => {
    assert.throws(() => assertResolvedScope({ arms: ARMS, expectedScope: null }), UnresolvedScopeError);
    assert.throws(() => assertResolvedScope({ campaignId: 'c', expectedScope: null }), UnresolvedScopeError);
    assert.throws(() => assertResolvedScope({ campaignId: 'c', arms: [], expectedScope: null }), UnresolvedScopeError);
  });

  it('duplicate arm ids — refused', () => {
    assert.throws(
      () => createResolvedScope('c', [{ id: 'a', model: 'm' }, { id: 'a', model: 'm2' }], null),
      UnresolvedScopeError,
    );
  });

  it('a well-formed scope constructs and deep-freezes — mutation attempts are no-ops, not errors', () => {
    const scope = createResolvedScope('c', ARMS, null);
    assert.throws(() => { scope.campaignId = 'other'; }, /Cannot assign|read only/);
    'use strict';
    assert.throws(() => { scope.arms.push({ id: 'z', model: 'm' }); }, /Cannot add|not extensible/);
    assert.throws(() => { scope.arms[0].id = 'z'; }, /Cannot assign|read only/);
  });

  it('deep-freezes nested values too, including ones that arrive SHALLOW-frozen (round-4 M4/M10)', () => {
    // The regression: `Object.freeze({sub: {mutable: true}})` freezes the
    // outer container but leaves `sub` mutable. An early return on
    // `Object.isFrozen(value)` — reasonable-looking, since freezing an
    // already-frozen value looks like a no-op — skips exactly this case,
    // because it never recurses into `sub` to freeze it too.
    const shallowFrozen = Object.freeze({ inner: { mutable: true }, list: [1, 2] });
    const scope = createResolvedScope('c', [{ id: 'a', model: 'm', weird: shallowFrozen, args: ['--x'], env: { K: 'v' } }], null);
    const arm = scope.arms[0];
    assert.throws(() => { arm.weird.inner.mutable = false; }, /Cannot assign|read only/, 'nested value inside a pre-frozen container must still be frozen');
    assert.throws(() => { arm.weird.list.push(3); }, /Cannot add|not extensible/);
    assert.throws(() => { arm.args.push('z'); }, /Cannot add|not extensible/);
    assert.throws(() => { arm.env.K = 'w'; }, /Cannot assign|read only/);
  });

  it('an entry that ACTIVELY claims a DIFFERENT campaign than the scope — ScopeMismatchError', () => {
    const scope = createResolvedScope('campaign-a', ARMS, null);
    assert.throws(() => assertScopeMatches({ campaignId: 'campaign-b' }, scope), ScopeMismatchError);
    assert.throws(() => assertScopeMatches([{ campaignId: 'campaign-a' }, { campaignId: 'campaign-b' }], scope), ScopeMismatchError,
      'a heterogeneous entry set is rejected even when most entries match');
  });

  it('an entry with NO campaignId at all is unaffected — that is D1a\'s separate "unjudgeable" question', () => {
    const scope = createResolvedScope('campaign-a', ARMS, null);
    assert.doesNotThrow(() => assertScopeMatches({ campaignId: null }, scope));
    assert.doesNotThrow(() => assertScopeMatches({}, scope));
    assert.doesNotThrow(() => assertScopeMatches([{ campaignId: 'campaign-a' }, {}], scope),
      'a synthetic pure-logic fixture with no campaignId field must not be rejected');
  });

  it('an entry that matches the scope\'s own campaignId passes', () => {
    const scope = createResolvedScope('campaign-a', ARMS, null);
    assert.doesNotThrow(() => assertScopeMatches({ campaignId: 'campaign-a' }, scope));
  });
});
