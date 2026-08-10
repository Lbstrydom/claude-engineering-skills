/**
 * Tier 1 — the campaigns dashboard section, rendered against fixture envelopes.
 *
 * Plan: docs/plans/model-comparison-campaigns.md §2.5d (two panes), §3 (UX
 * decisions), §4 (escaping + its negative control), §9 case 8.
 *
 * Asserts on the emitted HTML string. No browser: the markup contract is a
 * pure function of the envelope, and the things a browser is genuinely needed
 * for (the clipboard interaction, tab activation) live in
 * `tests/e2e/campaigns-page.spec.mjs`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import sectionCampaigns from '../scripts/lib/dashboard/sections/campaigns.mjs';
import { buildUi } from '../scripts/lib/dashboard/helpers.mjs';
import { overrideCommandFor, buildReviewRows, collectCampaigns } from '../scripts/lib/dashboard/collect-campaigns.mjs';

const ui = buildUi();
const OK = { status: 'ok', detail: '' };

/** A campaign whose gates are unmet — the ordinary state of a live campaign. */
function campaignFixture(over = {}) {
  return {
    id: 'final-review-2026q3',
    lockDigest: 'c41218f9b71cb200',
    targetN: 12,
    replicates: ['solo-opus'],
    collected: true,
    cohortSuperseded: false,
    analysisTimeFields: { targetN: 12, calibration: { sampleRate: 0.2 }, decisionRule: { floorMargin: 0.5 } },
    overhead: { spendUsd: 0.42, costEvidence: 'known', attempts: 3 },
    calibration: { opus: { assigned: 5, dispositioned: 2, overrideRate: 0.2, selfFamilyShare: 1 } },
    adjudication: { unadjudicatedFindings: 3, humanQueuePending: 1 },
    review: [],
    state: 'COLLECTING',
    stateReason: '5 of 12 snapshots complete',
    decisionEligible: false,
    watermark: { label: 'NOT DECISION-ELIGIBLE', failing: [{ id: 'n-complete', detail: '5 complete of 12 target' }] },
    advisories: [],
    nComplete: 5,
    completion: { rows: [], complete: [], incomplete: [{ snapshotId: 'snap07', missingArms: ['kimi'] }] },
    floor: { perArm: { opus: { accepted: 9, perSnapshot: 1.8, clears: true, clearsRelative: true, clearsAbsolute: true } } },
    spend: { opus: { spendUsd: 17.82, costEvidence: 'known', attempts: 1 } },
    cost: { evaluated: false, perArm: {}, reason: 'floor stage not reached' },
    verdict: null,
    ...over,
  };
}

const envelope = (over = {}) => ({ campaigns: [campaignFixture()], degraded: false, degradedReason: null, declaredIds: ['final-review-2026q3'], ...over });

describe('campaigns section — panes and ordering', () => {
  it('renders the evidence pane BEFORE standings in document order', () => {
    const html = sectionCampaigns({ src: OK, campaigns: envelope() }, ui);
    const ev = html.indexOf('data-testid="campaign-evidence"');
    const st = html.indexOf('data-testid="campaign-standings"');
    assert.ok(ev >= 0 && st >= 0, 'both panes must render');
    assert.ok(ev < st, 'the eye must cross the gates before reaching the numbers they qualify');
  });

  it('both panes are ARIA-named regions', () => {
    const html = sectionCampaigns({ src: OK, campaigns: envelope() }, ui);
    assert.match(html, /role="region" aria-label="Campaign evidence quality"/);
    assert.match(html, /role="region" aria-label="Campaign standings"/);
  });

  it('watermarks the standings AND names every failing gate', () => {
    const html = sectionCampaigns({
      src: OK,
      campaigns: envelope({ campaigns: [campaignFixture({
        watermark: { label: 'NOT DECISION-ELIGIBLE', failing: [
          { id: 'n-complete', detail: '5 complete of 12 target' },
          { id: 'calibration-sample', detail: 'opus: 2/5' },
        ] },
      })] }),
    }, ui);
    assert.match(html, /NOT DECISION-ELIGIBLE/);
    // Text + reason, not colour: a gate that does not say why reads as
    // arbitrary, and colour alone fails both accessibility and screenshots.
    assert.match(html, /n-complete/);
    assert.match(html, /calibration-sample/);
    assert.match(html, /5 complete of 12 target/);
  });

  it('names the incomplete snapshots and the arms they are missing', () => {
    const html = sectionCampaigns({ src: OK, campaigns: envelope() }, ui);
    assert.match(html, /snap07/);
    assert.match(html, /missing kimi/);
  });
});

describe('campaigns section — unknown is a word', () => {
  it('renders unpriced spend as "unknown", never $0.00', () => {
    const html = sectionCampaigns({
      src: OK,
      campaigns: envelope({ campaigns: [campaignFixture({
        spend: { kimi: { spendUsd: 0, costEvidence: 'unknown', attempts: 2 } },
      })] }),
    }, ui);
    const cell = html.match(/data-testid="campaign-spend-kimi">([^<]*)/);
    assert.ok(cell, 'the spend cell must exist');
    // Trimmed: the retry marker follows in its own element, so the cell's own
    // text node carries a trailing space.
    assert.equal(cell[1].trim(), 'unknown');
    assert.ok(!/\$0\.0000|\$0\.00/.test(html), 'a zero here would claim the call was measured and cost nothing');
  });

  it('renders unknown adjudication overhead as the word too', () => {
    const html = sectionCampaigns({
      src: OK,
      campaigns: envelope({ campaigns: [campaignFixture({ overhead: { spendUsd: null, costEvidence: 'unknown', attempts: 2 } })] }),
    }, ui);
    assert.match(html, /unknown<\/em>|unknown over 2 attempt/);
  });

  it('renders an unknown override rate as the word, not 0%', () => {
    const html = sectionCampaigns({
      src: OK,
      campaigns: envelope({ campaigns: [campaignFixture({
        calibration: { opus: { assigned: 0, dispositioned: 0, overrideRate: null, selfFamilyShare: null } },
      })] }),
    }, ui);
    assert.ok(!/>0%</.test(html), '"we never measured" must not render as "we measured no disagreement"');
    assert.match(html, /unknown/);
  });

  it('shows the attempt count when an arm was retried, so a re-run-heavy arm is visible rather than merely expensive', () => {
    const html = sectionCampaigns({
      src: OK,
      campaigns: envelope({ campaigns: [campaignFixture({ spend: { flaky: { spendUsd: 5, costEvidence: 'known', attempts: 3 } } })] }),
    }, ui);
    assert.match(html, /3 attempts/);
  });
});

describe('campaigns section — review rows', () => {
  const withFindings = () => envelope({ campaigns: [campaignFixture({
    review: [{
      findingId: '11111111-2222-3333-4444-555555555555',
      armId: 'opus', severity: 'HIGH', category: 'Backend', section: 'scripts/x.mjs',
      detail: 'the cost column sums only live rows', outcome: 'accepted', method: 'verified',
      adjudicatorKind: 'agent', overrideCommand: overrideCommandFor('11111111-2222-3333-4444-555555555555'),
    }],
  })] });

  it('gives every finding a copy-override button carrying the prefilled command', () => {
    const html = sectionCampaigns({ src: OK, campaigns: withFindings() }, ui);
    assert.match(html, /aria-label="Copy override command"/);
    assert.match(html, /data-copy="node scripts\/campaign\.mjs override --finding 11111111-2222-3333-4444-555555555555/);
    // The command is VISIBLE too, not only in an attribute — the operator may
    // read or select it without the button.
    assert.match(html, /data-testid="campaign-override-cmd">node scripts\/campaign\.mjs override --finding /);
  });

  it('carries the command in a data- attribute, never an inline onclick built from a finding id', () => {
    const html = sectionCampaigns({ src: OK, campaigns: withFindings() }, ui);
    assert.ok(!/onclick=/i.test(html), 'an inline handler built from model-authored content is the injection sink');
  });

  it('an unadjudicated finding says so — never a manufactured "pending"', () => {
    const rows = buildReviewRows({
      findings: [{ finding_id: 'f1', arm_id: 'a', severity: 'HIGH', category: 'X', primary_file: 'p', detail_snapshot: 'd' }],
      clusters: [],
    });
    assert.equal(rows[0].outcome, null);
    const html = sectionCampaigns({ src: OK, campaigns: envelope({ campaigns: [campaignFixture({ review: rows })] }) }, ui);
    assert.match(html, /<em>unadjudicated<\/em>/);
  });
});

describe('campaigns section — degradation (§9 case 8)', () => {
  it('store-offline OMITS standings and says why', () => {
    const html = sectionCampaigns({
      src: OK,
      campaigns: { campaigns: [], degraded: true, degradedReason: 'store unavailable (AUDIT_DB_URL unset) — standings withheld', declaredIds: ['x'] },
    }, ui);
    assert.ok(!html.includes('data-testid="campaign-standings"'),
      'an empty standings table and an unmeasured one are the same pixels');
    assert.match(html, /Store unavailable/i);
    assert.match(html, /data-testid="campaign-evidence"/, 'the evidence pane still renders — it is what carries the reason');
  });

  it('no .campaigns/ directory is an empty state, NOT a degradation', () => {
    const html = sectionCampaigns({ src: { status: 'missing-optional', detail: 'no .campaigns/ config' }, campaigns: { campaigns: [] } }, ui);
    assert.ok(!/Store unavailable/i.test(html), '"not adopted" and "could not read" license different actions');
    assert.match(html, /no \.campaigns\/ config/);
  });

  it('a collector error surfaces as a warning panel, never a silent empty pane', () => {
    const html = sectionCampaigns({ src: { status: 'unexpected-error', detail: 'campaign config invalid: bad key' }, campaigns: { campaigns: [] } }, ui);
    assert.match(html, /campaign config invalid/);
  });

  it('a declared-but-uncollected campaign renders its reason and omits standings', () => {
    const html = sectionCampaigns({
      src: OK,
      campaigns: envelope({ campaigns: [campaignFixture({ collected: false, collectedReason: 'no cohort recorded for this campaign under the current lock' })] }),
    }, ui);
    assert.match(html, /no cohort recorded/);
    assert.ok(!html.includes('data-testid="campaign-standings"'));
  });

  it('a superseded cohort SAYS so — orphaned evidence must not read as current', () => {
    const html = sectionCampaigns({ src: OK, campaigns: envelope({ campaigns: [campaignFixture({ cohortSuperseded: true })] }) }, ui);
    assert.match(html, /SUPERSEDED/);
  });
});

describe('collector fault isolation + event sourcing (consolidated gate G2, G3)', () => {
  it('G2: one campaign failing to load does NOT hide the healthy ones', async () => {
    // An early `return` in the loop discarded every campaign already collected,
    // so a single corrupt cohort blanked the whole tab. A localized failure must
    // not cascade into a total one.
    const configs = {
      good: { id: 'good', targetN: 12, arms: [{ id: 'a', model: 'm' }], calibration: {}, decisionRule: {}, decision: { incumbent: 'm' } },
      bad: { id: 'bad', targetN: 12, arms: [{ id: 'a', model: 'm' }], calibration: {}, decisionRule: {}, decision: { incumbent: 'm' } },
    };
    const out = await collectCampaigns('/repo', {
      isCloudEnabled: async () => true,
      repoId: 'r1',
      selectCampaignConfig: ({ campaignId }) => (campaignId == null
        ? { ok: false, code: 'ambiguous', available: ['good', 'bad'] }
        : { ok: true, config: configs[campaignId] }),
      loadCohortEvidence: async ({ config }) => {
        if (config.id === 'bad') throw new Error('cohort row corrupt');
        return { ok: false, reason: 'no cohort recorded', lockDigest: null };
      },
    });
    const ids = out.campaigns.campaigns.map((c) => c.id);
    assert.deepEqual(ids.sort(), ['bad', 'good'], 'the healthy campaign must survive its neighbour failing');
    const bad = out.campaigns.campaigns.find((c) => c.id === 'bad');
    assert.match(bad.collectedReason, /cohort row corrupt/, 'and the failure names itself rather than vanishing');
  });

  it('G3: adjudication events come from the store map, not the cluster projection', () => {
    // Clusters are written per COMPLETE snapshot, so sourcing events from them
    // silently hid every verdict on an incomplete snapshot and rendered those
    // findings as permanently unadjudicated — exactly where a human most needs
    // to see what was ruled.
    const rows = buildReviewRows({
      findings: [{ finding_id: 'f-incomplete', arm_id: 'opus', severity: 'HIGH', category: 'X', primary_file: 'p', detail_snapshot: 'd' }],
      clusters: [],   // the finding's snapshot is incomplete → no cluster set
      eventsByFinding: {
        'f-incomplete': [{ id: 'e1', adjudicatorKind: 'human', adjudicationOutcome: 'accepted', method: 'override', createdAt: 't', supersededAt: null }],
      },
    });
    assert.equal(rows[0].outcome, 'accepted');
    assert.equal(rows[0].adjudicatorKind, 'human');
  });

  it('G3 NEGATIVE CONTROL: with no event map the row is honestly unadjudicated', () => {
    const rows = buildReviewRows({
      findings: [{ finding_id: 'f1', arm_id: 'opus', severity: 'HIGH', category: 'X', primary_file: 'p', detail_snapshot: 'd' }],
      clusters: [], eventsByFinding: {},
    });
    assert.equal(rows[0].outcome, null, 'absence must read as absence, never as a ruling');
  });
});

describe('campaigns section — escaping (§4)', () => {
  // This page renders the least trustworthy content in the repo: model-authored
  // finding prose and free-text human override notes.
  const NASTY = '</script><img src=x onerror="alert(1)"><b>bold</b>';

  function nastyEnvelope() {
    return envelope({ campaigns: [campaignFixture({
      review: [{
        findingId: 'f-nasty', armId: NASTY, severity: 'HIGH', category: NASTY,
        section: NASTY, detail: NASTY, outcome: null, method: null, adjudicatorKind: null,
        overrideCommand: overrideCommandFor('f-nasty'),
      }],
    })] });
  }

  it('emits no unescaped markup from a hostile finding detail', () => {
    const html = sectionCampaigns({ src: OK, campaigns: nastyEnvelope() }, ui);
    assert.ok(!html.includes('<img src=x'), 'an injected tag survived into the document');
    assert.ok(!html.includes('</script>'), 'the literal closing tag could break out of an inline script block');
    assert.ok(!html.includes('onerror="alert(1)"'));
    assert.match(html, /&lt;img src=x/, 'it must appear, escaped, rather than be dropped');
  });

  it('NEGATIVE CONTROL: the same fixture DOES leak when escaping is bypassed', () => {
    // Without this the assertion above could pass vacuously — e.g. if the
    // renderer ever stopped emitting `detail` at all, or the fixture stopped
    // reaching the row. A test that cannot fail is not a test.
    const passthroughUi = { ...ui, escapeHtml: (s) => String(s ?? '') };
    const leaked = sectionCampaigns({ src: OK, campaigns: nastyEnvelope() }, passthroughUi);
    assert.ok(leaked.includes('<img src=x'), 'the control must reproduce the leak the real renderer prevents');
    assert.ok(leaked.includes('onerror="alert(1)"'));
  });

  it('escapes the copy-command ATTRIBUTE separately from its text context', () => {
    const html = sectionCampaigns({ src: OK, campaigns: nastyEnvelope() }, ui);
    const attr = html.match(/data-copy="([^"]*)"/);
    assert.ok(attr, 'the data-copy attribute must be present and properly quoted');
    assert.ok(!attr[1].includes('"'), 'a raw quote would terminate the attribute early');
  });

  it('escapes a hostile campaign id — it reaches an attribute-adjacent context', () => {
    const html = sectionCampaigns({ src: OK, campaigns: envelope({ campaigns: [campaignFixture({ id: NASTY, collected: false, collectedReason: 'x' })] }) }, ui);
    assert.ok(!html.includes('<img src=x'));
  });

  it('escapes the degraded reason — it can carry a store error message', () => {
    const html = sectionCampaigns({ src: OK, campaigns: { campaigns: [], degraded: true, degradedReason: NASTY, declaredIds: [NASTY] } }, ui);
    assert.ok(!html.includes('<img src=x'));
  });
});
