/**
 * Playwright over the GENERATED dashboard document — the §10 acceptance
 * criteria for the campaigns page.
 *
 * Plan: docs/plans/model-comparison-campaigns.md §10.
 *
 * **Generated from FIXTURE data, through the real renderer.** Two of the five
 * criteria are unreachable against the live build by construction: P0 needs a
 * store where `N < targetN` and P2 needs the store unreachable *while the page
 * is being built*. Driving the real `renderDocument` over controlled envelopes
 * exercises exactly the code path `build-dashboard.mjs` runs — the document,
 * its inline `dashboard.js`, tab activation, and the clipboard handler — while
 * making the states deterministic. Pointing the spec at whatever the live store
 * happens to contain today would make it assert nothing on most days.
 *
 * The clipboard assertion is why this file exists at all: a string test can see
 * a `data-copy` attribute, but only a browser can prove the delegated handler
 * reads it and writes the clipboard.
 *
 * Run: `npx playwright test tests/e2e/campaigns-page.spec.mjs`
 */
// `playwright/test`, NOT `@playwright/test`. The generated ux-lock specs use the
// latter because they run in CONSUMER repos, which install it explicitly. This
// repo has only the `playwright` package — which re-exports the same runner —
// so importing the scoped name here would make the spec unrunnable in the one
// place it lives, and adding a devDependency to satisfy an import that already
// resolves would be a dependency bought for nothing.
import { test, expect } from 'playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { renderDocument } from '../../scripts/lib/dashboard/render.mjs';
import { loadAssets } from '../../scripts/lib/dashboard/load-assets.mjs';
import { collectReference } from '../../scripts/lib/dashboard/collect-reference.mjs';

const assets = loadAssets();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'campaigns-e2e-'));

/**
 * The base document comes from the REAL collector, with only the campaigns
 * payload swapped.
 *
 * Hand-writing a minimal `ReferenceDataSchema`-valid object was the first
 * attempt and it was wrong on principle as well as in practice (it failed on
 * four `architecture.depsSource` fields): a fixture that mirrors a schema this
 * feature does not own is a second source of truth that drifts silently the
 * next time that schema gains a required field. Collecting once and overriding
 * one key cannot drift, and it keeps the assertion honestly about the generated
 * document rather than about a stub.
 */
let basePromise = null;
async function baseData() {
  if (!basePromise) basePromise = collectReference({ git: { baseSha: 'e2e-fixture', dirty: false } });
  return basePromise;
}

async function pageWith(campaignsEnvelope, name) {
  const base = await baseData();
  const data = {
    ...base,
    sources: { ...base.sources, campaigns: { status: 'ok', detail: '' } },
    campaigns: campaignsEnvelope,
  };
  const html = renderDocument(data, 'reference', assets);
  const file = path.join(tmp, `${name}.html`);
  fs.writeFileSync(file, html);
  return pathToFileURL(file).href;
}

const FINDING_ID = '11111111-2222-3333-4444-555555555555';

function campaign(over = {}) {
  return {
    id: 'final-review-2026q3',
    lockDigest: 'c41218f9b71cb200',
    targetN: 12,
    replicates: ['solo-opus'],
    collected: true,
    cohortSuperseded: false,
    analysisTimeFields: { targetN: 12, decisionRule: { floorMargin: 0.5 } },
    overhead: { spendUsd: 0.42, costEvidence: 'known', attempts: 3 },
    calibration: { opus: { assigned: 5, dispositioned: 5, overrideRate: 0.2, selfFamilyShare: 1 } },
    adjudication: { unadjudicatedFindings: 0, humanQueuePending: 0 },
    review: [{
      findingId: FINDING_ID, armId: 'opus', severity: 'HIGH', category: 'Backend',
      section: 'scripts/x.mjs', detail: 'the cost column sums only live rows',
      outcome: 'accepted', method: 'verified', adjudicatorKind: 'agent',
      overrideCommand: `node scripts/campaign.mjs override --finding ${FINDING_ID} --verdict dismissed --note ""`,
    }],
    state: 'COLLECTING',
    stateReason: '5 of 12 snapshots complete',
    decisionEligible: false,
    watermark: { label: 'NOT DECISION-ELIGIBLE', failing: [{ id: 'n-complete', detail: '5 complete of 12 target' }] },
    advisories: [],
    nComplete: 5,
    completion: { rows: [], complete: [], incomplete: [] },
    floor: { perArm: { opus: { accepted: 9, perSnapshot: 1.8, clears: true, clearsRelative: true, clearsAbsolute: true } } },
    spend: { opus: { spendUsd: 17.82, costEvidence: 'known', attempts: 1 }, kimi: { spendUsd: 0, costEvidence: 'unknown', attempts: 2 } },
    cost: { evaluated: false, perArm: {}, reason: 'floor stage not reached' },
    verdict: null,
    ...over,
  };
}

const gatesUnmet = () => ({ campaigns: [campaign()], degraded: false, degradedReason: null, declaredIds: ['final-review-2026q3'] });

/** The panels are `hidden` until their tab is activated — so every assertion
 *  here goes through a real user interaction, which is the point of using a
 *  browser rather than a string matcher. */
async function openCampaignsTab(page) {
  await page.getByRole('tab', { name: /campaigns/i }).click();
}

test('[P0] standings are watermarked when the gates are unmet, and the watermark names the failing gate', async ({ page }) => {
  await page.goto(await pageWith(gatesUnmet(), 'gates-unmet'));
  await openCampaignsTab(page);
  const standings = page.getByRole('region', { name: /standings/i });
  await expect(standings).toContainText('NOT DECISION-ELIGIBLE');
  await expect(standings).toContainText('n-complete');
  await expect(standings).toContainText('5 complete of 12 target');
});

test('[P0] unknown cost renders as the word, and no cell shows $0.00 for that arm', async ({ page }) => {
  await page.goto(await pageWith(gatesUnmet(), 'unknown-cost'));
  await openCampaignsTab(page);
  const cell = page.getByTestId('campaign-spend-kimi');
  await expect(cell).toContainText('unknown');
  await expect(cell).not.toContainText('$0.00');
});

test('[P1] the evidence pane precedes standings in document order', async ({ page }) => {
  await page.goto(await pageWith(gatesUnmet(), 'dom-order'));
  await openCampaignsTab(page);
  const order = await page.evaluate(() => {
    const ev = document.querySelector('[data-testid="campaign-evidence"]');
    const st = document.querySelector('[data-testid="campaign-standings"]');
    if (!ev || !st) return null;
    // Node.DOCUMENT_POSITION_FOLLOWING === 4 → `st` comes after `ev`.
    return (ev.compareDocumentPosition(st) & 4) === 4;
  });
  expect(order).toBe(true);
});

test('[P1] every finding row carries a copy-override button, and clicking it copies the command', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(await pageWith(gatesUnmet(), 'copy-override'));
  await openCampaignsTab(page);

  const btn = page.getByRole('button', { name: /copy override/i });
  await expect(btn).toHaveCount(1);
  await expect(page.getByTestId('campaign-override-cmd'))
    .toContainText('node scripts/campaign.mjs override --finding ');

  // The interaction a string assertion cannot cover: the delegated handler must
  // actually read `data-copy` and write the clipboard.
  await btn.click();

  // `Copied` EXACTLY — not `/Copied|Copy failed/`. The handler sets one or the
  // other, so a permissive alternation passes on the failure path too and the
  // test would be green with a copy button that copies nothing.
  await expect(btn).toHaveText('Copied');

  // And the clipboard genuinely holds the command. An earlier version guarded
  // this with `if (copied !== null)`, which is a silent skip — the shape that
  // turns "we could not read the clipboard" into "the clipboard was correct".
  // Clipboard permissions are granted above, so a null here is a real failure
  // and says so.
  const copied = await page.evaluate(() => navigator.clipboard.readText().then((t) => t, (e) => `<<read-failed: ${e.message}>>`));
  expect(copied).toContain(`override --finding ${FINDING_ID}`);
});

test('[P2] a store-offline build omits standings and says why', async ({ page }) => {
  await page.goto(await pageWith(
    { campaigns: [], degraded: true, degradedReason: 'store unavailable (AUDIT_DB_URL unset) — standings withheld rather than rendered from nothing', declaredIds: ['final-review-2026q3'] },
    'degraded',
  ));
  await openCampaignsTab(page);
  await expect(page.getByTestId('campaign-standings')).toHaveCount(0);
  await expect(page.getByTestId('campaign-evidence')).toContainText(/store unavailable|withheld/i);
});
