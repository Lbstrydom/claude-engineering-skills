/**
 * @fileoverview Tier 1 — the campaign and the manifest enforce the SAME
 * `final_review_shadow` safety rules (Cluster A round 5, M4/M5).
 *
 * Before this: `campaign/config.mjs`'s `CampaignConfigSchema` and
 * `comparison/manifest.mjs`'s `ComparisonManifestSchema` each carried an
 * independent copy of the controls shape and the xAI-preflight safety check.
 * A `final_review_shadow` config parsed through the manifest path could
 * declare an unattested xAI arm — the exact thing the campaign path refuses —
 * because the safety rule existed on only one of the two entry points that
 * both accept the same role. These tests assert the parity directly, on both
 * entry points, rather than trusting that one being fixed means the other is.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CampaignConfigSchema } from '../scripts/lib/campaign/config.mjs';
import { parseComparisonManifest } from '../scripts/lib/comparison/manifest.mjs';

const BASE_ARMS = [
  { id: 'opus', model: 'claude-opus', mode: 'shadow' },
  { id: 'grok', model: 'grok-4.6', mode: 'shadow' },
];
const BASE_CONTROLS = {
  reasoningEffort: 'high', promptTemplateId: 'a@1', outputSchemaId: 'b@1',
  maxOutputTokens: 32000, toolPolicy: 'structured-output-only', temperature: 0,
  envelopeScope: 'thin',
};

function campaignConfig(overrides = {}) {
  return {
    schemaVersion: 1, id: 'parity-test',
    decision: { type: 'select_default', incumbent: 'claude-opus' },
    arms: BASE_ARMS,
    controls: BASE_CONTROLS,
    adjudicator: { model: 'latest-opus', promptTemplateId: 'x@1', outputSchemaId: 'y@1' },
    calibration: { sampleRate: 0.2 },
    targetN: 12,
    decisionRule: { floorMetric: 'accepted_high_med_per_snapshot', floorMargin: 0.5, tiebreak: 'cost_per_accepted', costCeilingUsdPerAccepted: 8 },
    role: 'final_review_shadow',
    ...overrides,
  };
}

function manifestConfig(overrides = {}) {
  return {
    schemaVersion: 1, id: 'parity-test', role: 'final_review_shadow',
    decision: { type: 'select_default', incumbent: 'claude-opus' },
    arms: BASE_ARMS,
    controls: BASE_CONTROLS,
    ...overrides,
  };
}

describe('campaign and manifest entry points enforce the SAME xAI-preflight rule', () => {
  it('BOTH refuse an unattested xAI arm', () => {
    assert.equal(CampaignConfigSchema.safeParse(campaignConfig()).success, false,
      'the campaign path already refused this — guard against it silently starting to accept');
    assert.throws(() => parseComparisonManifest(manifestConfig()), /preflight is REQUIRED/,
      'the manifest path must refuse it too — this is the exact bypass M4 found');
  });

  it('BOTH accept a passing, matching preflight', () => {
    const preflight = { artifact: 'docs/research/grok-effort-preflight-2026q3.json', sha256: '19e78fadf566d35f088ec314e7e318b3fb640980e0b3997d66e52d9cc25de108', model: 'grok-4.6', disposition: 'pass' };
    assert.equal(CampaignConfigSchema.safeParse(campaignConfig({ controls: { ...BASE_CONTROLS, preflight } })).success, true);
    assert.doesNotThrow(() => parseComparisonManifest(manifestConfig({ controls: { ...BASE_CONTROLS, preflight } })));
  });

  it('BOTH refuse a FAILING preflight disposition', () => {
    const preflight = { artifact: 'x', sha256: '1'.repeat(64), model: 'grok-4.6', disposition: 'fail' };
    assert.equal(CampaignConfigSchema.safeParse(campaignConfig({ controls: { ...BASE_CONTROLS, preflight } })).success, false);
    assert.throws(() => parseComparisonManifest(manifestConfig({ controls: { ...BASE_CONTROLS, preflight } })), /disposition/);
  });

  it('BOTH refuse envelopeScope "gap" — campaign-ineligible (KD-5)', () => {
    const gapArms = [BASE_ARMS[0], { id: 'opus2', model: 'claude-opus', mode: 'shadow', type: 'control' }];
    assert.equal(
      CampaignConfigSchema.safeParse(campaignConfig({ arms: gapArms, decision: { type: 'select_default', incumbent: 'claude-opus' }, controls: { ...BASE_CONTROLS, envelopeScope: 'gap' } })).success,
      false,
    );
    assert.throws(
      () => parseComparisonManifest(manifestConfig({ arms: [BASE_ARMS[0], { id: 'opus3', model: 'claude-opus', mode: 'primary' }], controls: { ...BASE_CONTROLS, envelopeScope: 'gap' } })),
      /campaign-ineligible/,
    );
  });

  it('NEGATIVE CONTROL: the auditor role never runs this check — it has neither field to check', () => {
    // auditor's controls shape has no envelopeScope/preflight at all; asserting
    // this proves the conditional dispatch in manifest.mjs actually gates on
    // role rather than accidentally running unconditionally (which would throw
    // a confusing error on a shape that was never meant to have these fields).
    const auditorManifest = {
      schemaVersion: 1, id: 'auditor-parity', role: 'auditor',
      decision: { type: 'select_default', incumbent: 'gpt-5.6-terra' },
      arms: [{ id: 'a', model: 'gpt-5.6-terra', mode: 'shadow' }, { id: 'b', model: 'zai/glm-5.2', mode: 'shadow' }],
      controls: {
        reasoningEffort: 'high', promptTemplateId: 'a@1', outputSchemaId: 'b@1',
        maxOutputTokens: 32000, toolPolicy: 'structured-output-only', temperature: 0,
        passes: ['structure'], scope: 'diff', rounds: 3,
      },
    };
    assert.doesNotThrow(() => parseComparisonManifest(auditorManifest),
      'the final-review-shadow-only check must not fire for a role that has no envelopeScope/preflight fields');
  });
});
