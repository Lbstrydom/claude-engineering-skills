/**
 * @fileoverview Dashboard collector for the model-comparison campaigns page.
 *
 * Plan: docs/plans/model-comparison-campaigns.md §2.5d (two panes), §4
 * (collector/renderer split), §9 case 8 (store-offline degrades, never reads as
 * "no campaigns").
 *
 * Mirrors `collect-nav.mjs`'s degradation contract: a pure read returning
 * `status: missing-optional | ok | unexpected-error`, so the renderer shows a
 * cause instead of an empty pane.
 *
 * **Three absences that must never look alike**, because each licenses a
 * different action and this page is a decision console:
 *   - `missing-optional` — no `.campaigns/` directory. This repo has not
 *     adopted campaigns; nothing is wrong.
 *   - `degraded: true` — a campaign IS declared but the store could not be
 *     read. Standings are WITHHELD rather than rendered from nothing: a
 *     watermarked zero and an unmeasured zero are the same pixels, and the
 *     second is the failure this plan exists to prevent.
 *   - `ok` with `collected: false` — declared, cohort not yet recorded. That is
 *     a measurement, and it renders as one.
 *
 * **Lock drift is read as RECORDED supersession, not re-resolved here.**
 * Computing the current lock needs `bakeoff-collect.mjs`'s resolver, which is
 * audit orchestration — a dependency a presentation-layer collector should not
 * take (it is the same boundary the repo already flags four times elsewhere).
 * It is also unnecessary: a meaning-changing drift creates a NEW cohort row, so
 * "the latest cohort is not the one carrying rows" and `superseded_at` together
 * ARE the drift signal, as recorded. The page says so, and points at
 * `campaign.mjs status` for a live re-resolution.
 *
 * @module scripts/lib/dashboard/collect-campaigns
 */
import { selectCampaignConfig, ANALYSIS_TIME_FIELDS } from '../campaign/config.mjs';
import { evaluateCampaign, terminalEvent } from '../campaign/verdict.mjs';
import { loadCohortEvidence } from '../store/campaign.mjs';
import { isCloudEnabled } from '../store/repo.mjs';

/** The override command the page renders per finding, prefilled and copyable. */
export function overrideCommandFor(findingId) {
  return `node scripts/campaign.mjs override --finding ${findingId} --verdict dismissed --note ""`;
}

/**
 * Flatten one cohort's findings into review rows.
 *
 * UNBLINDED on purpose — this is the human reviewer's console, not the
 * adjudicator's worksheet. The blindness contract in `store/campaign.mjs`
 * governs what the MODEL sees; showing the arm here is the entire point of the
 * human calibration pass, and hiding it would make the override rate
 * uninterpretable.
 */
export function buildReviewRows(evidence) {
  const eventsByFinding = new Map();
  for (const cluster of evidence.clusters ?? []) {
    for (const m of cluster.members ?? []) eventsByFinding.set(m.findingId, m.events ?? []);
  }
  return (evidence.findings ?? []).map((f) => {
    const term = terminalEvent(eventsByFinding.get(f.finding_id) ?? []);
    return {
      findingId: f.finding_id,
      armId: f.arm_id,
      snapshotId: f.snapshot_id,
      severity: f.severity,
      category: f.category,
      section: f.primary_file,
      detail: f.detail_snapshot,
      auditedSha: f.audited_sha,
      // `null`, never "pending": a finding nothing has ruled on and one an
      // adjudicator declined to settle are different facts.
      outcome: term?.adjudicationOutcome ?? null,
      method: term?.method ?? null,
      adjudicatorKind: term?.adjudicatorKind ?? null,
      overrideCommand: overrideCommandFor(f.finding_id),
    };
  });
}

/**
 * @param {string} [root]
 * @param {object} [deps] - injected for hermetic tests; production uses the defaults.
 * @returns {Promise<{campaigns: object}>}
 */
export async function collectCampaigns(root = process.cwd(), deps = {}) {
  const select = deps.selectCampaignConfig ?? selectCampaignConfig;
  const cloudOn = deps.isCloudEnabled ?? isCloudEnabled;
  const loadEvidence = deps.loadCohortEvidence ?? loadCohortEvidence;

  let selected;
  try {
    selected = select({ campaignId: null });
  } catch (err) {
    // A malformed committed config is a REAL error, not an absence — it is the
    // one file a consumer hand-edits, and a schema rejection is exactly the loud
    // failure `.strict()` exists to produce.
    return wrap({ status: { status: 'unexpected-error', detail: `campaign config invalid: ${err.message}` } });
  }
  if (!selected.ok && selected.code === 'none') {
    return wrap({ status: { status: 'missing-optional', detail: 'no .campaigns/ config — this repo has not declared a model-comparison campaign' } });
  }
  // Ambiguity is not an error HERE. The CLI must refuse to pick a campaign for a
  // spend-bearing run; a read-only page can and should show every one.
  const ids = selected.ok ? [selected.config.id] : selected.available;

  if (!await cloudOn()) {
    return wrap({
      status: { status: 'ok', detail: '' },
      degraded: true,
      degradedReason: 'store unavailable (AUDIT_DB_URL unset) — standings withheld rather than rendered from nothing',
      declaredIds: ids,
    });
  }

  const repoId = deps.repoId !== undefined ? deps.repoId : await resolveRepoId();
  const rows = [];
  for (const id of ids) {
    const one = select({ campaignId: id });
    if (!one.ok) continue;
    const { config } = one;

    let evidence;
    try {
      // `lock: null` → the store returns the LATEST cohort, which is what a
      // reader wants: the newest contract's evidence, with its own digest.
      evidence = await loadEvidence({ repoId, config, lock: null });
    } catch (err) {
      return wrap({
        status: { status: 'ok', detail: '' },
        degraded: true,
        degradedReason: `store read failed: ${err.message} — standings withheld`,
        declaredIds: ids,
      });
    }

    const base = {
      id,
      targetN: config.targetN,
      replicates: config.arms.filter((a) => a.type === 'replicate').map((a) => a.id),
      analysisTimeFields: analysisTimeOf(config),
      lockDigest: evidence.lockDigest ?? null,
    };
    if (!evidence.ok) {
      rows.push({ ...base, collected: false, collectedReason: evidence.reason });
      continue;
    }
    rows.push({
      ...base,
      collected: true,
      cohortSuperseded: evidence.cohortSuperseded,
      overhead: evidence.overhead,
      calibration: evidence.calibration?.perArm ?? {},
      adjudication: evidence.adjudication,
      review: buildReviewRows(evidence),
      ...evaluateCampaign({
        config,
        snapshots: evidence.snapshots, clusters: evidence.clusters,
        adjudication: evidence.adjudication, calibration: evidence.calibration,
        clustering: evidence.clustering, cohortSuperseded: evidence.cohortSuperseded,
        declaredInconclusive: evidence.declaredInconclusive,
        ruleChangedAfterFirstArmRun: evidence.ruleChangedAfterFirstArmRun,
      }),
    });
  }
  return wrap({ status: { status: 'ok', detail: '' }, campaigns: rows, declaredIds: ids });
}

/** Named, not implied — the standings pane states which analysis-time values
 *  produced a verdict, because they sit outside every digest and a reader would
 *  otherwise be guessing which rule they are looking at. */
function analysisTimeOf(config) {
  return Object.fromEntries(ANALYSIS_TIME_FIELDS.map((f) => [f, config[f]]));
}

async function resolveRepoId() {
  try {
    const { resolveRepoForStore } = await import('../store/repo.mjs');
    const { generateRepoProfile } = await import('../context.mjs');
    const ref = await resolveRepoForStore({ profile: generateRepoProfile() });
    return ref?.repoRowId ?? null;
  } catch { return null; }
}

function wrap({ status, campaigns = [], degraded = false, degradedReason = null, declaredIds = [] }) {
  return { campaigns: { status, campaigns, degraded, degradedReason, declaredIds } };
}
