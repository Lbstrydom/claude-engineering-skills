#!/usr/bin/env node
/**
 * @fileoverview `campaign.mjs` — the campaign operator CLI.
 *
 * Plan: docs/plans/model-comparison-campaigns.md §2.5c (adjudication protocol),
 * §5 (resume semantics), §7a (persistence), §7b Phase 3.
 *
 * Commands use REAL values, never angle-bracket placeholders: PowerShell
 * reserves `<`, so a `--campaign <id>` line is unpasteable on the platform half
 * this repo's operators are on (AGENTS.md operator-doc convention).
 *
 *   node scripts/campaign.mjs status               --campaign final-review-2026q3
 *   node scripts/campaign.mjs cluster              --campaign final-review-2026q3 --recluster
 *   node scripts/campaign.mjs adjudicate           --campaign final-review-2026q3 --limit 10
 *   node scripts/campaign.mjs override             --finding FINDING_UUID --verdict dismissed --note "why"
 *   node scripts/campaign.mjs verdict              --campaign final-review-2026q3
 *   node scripts/campaign.mjs reconcile            --campaign final-review-2026q3
 *   node scripts/campaign.mjs declare-inconclusive --campaign final-review-2026q3 --reason "why"
 *   node scripts/campaign.mjs --selfcheck-relocation
 *
 * **The adjudicator VERIFIES; it does not judge.** Every verdict records a
 * `method` — `verified` when the claim was settled against the tree at the
 * snapshot's own `audited_sha`, `unverifiable` when it could not be. Anything
 * the instrument cannot settle routes to the human queue rather than being
 * auto-accepted: LLM re-judgement of historical findings measured 52% agreement
 * with a human here, while verification against code is instrument-settleable.
 * That distinction is the entire reason these verdicts are worth recording.
 *
 * **Tool policy: explicitly none.** The adjudicator runs forced-structured-
 * output with no tool loop. Retrieval happens HERE, in the CLI, where it is
 * deterministic, bounded, sensitive-path-gated and reproducible from the
 * receipt. Giving the model a `git show` tool would put an unbounded, unlogged
 * read loop inside a spend-bearing blind adjudication — the opposite of what
 * makes these verdicts auditable.
 *
 * @module scripts/campaign
 */

import path from 'node:path';
import process from 'node:process';
import { z } from 'zod';

import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import { selectCampaignConfig, ANALYSIS_TIME_FIELDS, canonicalJson } from './lib/campaign/config.mjs';
import {
  receiptPath, resolveNextAttempt, claimReceipt, completeReceipt, markReceiptRecorded, scanReceipts,
} from './lib/campaign/lock.mjs';
import { evaluateCampaign, assessThresholdSensitivity } from './lib/campaign/verdict.mjs';
// D2 (comparison-tooling-consolidation.md, Phase 2): these used to come from
// `bakeoff-collect.mjs`, one entry point importing another — the move to
// `scripts/lib/bakeoff/**` is the point where that gets corrected too, so
// campaign.mjs imports the library modules directly like every other
// consumer, rather than routing through a sibling CLI.
import { resolveArms } from './lib/bakeoff/arms.mjs';
import { readLog } from './lib/bakeoff/log.mjs';
// Phase 3 (D2): cited-source windowing, the adjudication contract, and
// log-promotion mechanics moved to scripts/lib/campaign/**. `repoId` moved
// alongside `promoteFromLog` (it needed it, and this module may not import
// the CLI to get it back) — the CLI's own remaining caller imports it here.
import { resolveCitedSources } from './lib/campaign/cited-source.mjs';
import {
  AdjudicationVerdictSchema, ADJUDICATION_TOOL, ADJUDICATION_SYSTEM_PROMPT,
  normaliseVerdict, routesToHumanQueue, clusterSnapshotFindings, renderAdjudicationSummary,
} from './lib/campaign/adjudicate.mjs';
import {
  repoId, classifyLogEntry, isArmRetried, resolvePromotionAttempts, promoteFromLog,
} from './lib/campaign/promote.mjs';
import { findingMatchConfig, FINDING_MATCH_SCHEMA_VERSION } from './lib/config.mjs';
import { resolveModel } from './lib/model-resolver.mjs';
import { costFromUsage } from './lib/model-pricing.mjs';
import { createAnthropicClient } from './lib/anthropic-client.mjs';
import * as store from './lib/store/campaign.mjs';

const KNOWN_FLAGS = Object.freeze([
  '--campaign', '--finding', '--verdict', '--note', '--reason', '--limit',
  '--dry-run', '--recluster', '--actor', '--json',
  '--selfcheck-relocation', '--help', '-h',
]);

const VERBS = Object.freeze(['status', 'cluster', 'adjudicate', 'override', 'verdict', 'reconcile', 'declare-inconclusive']);

// ── CLI plumbing ────────────────────────────────────────────────────────────

function arg(name, argv = process.argv) {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? null : (argv[i + 1] ?? null);
}

function requireArg(name, argv = process.argv) {
  const v = arg(name, argv);
  if (!v || v.startsWith('--')) throw new ArgvError(`--${name} <value> is required`);
  return v;
}

/** Resolve the campaign config + derived lock, refusing ambiguity. */
function loadCampaign(campaignId) {
  const selected = selectCampaignConfig({ campaignId });
  if (!selected.ok) throw new ArgvError(selected.message);
  const resolved = resolveArms({ campaignId: selected.config.id });
  // `resolved.arms` is a STALE field name from before D1's ResolvedScope
  // migration (Phase 1) — resolveArms's return shape moved the arm list to
  // `resolved.scope.arms`, and this call site was never updated because
  // nothing here destructures `.arms` from `loadCampaign`'s own return (grep
  // confirmed: every call site reads only `{config, lock}` /
  // `{config, lock, configDigest}`). Fixed anyway — a currently-unread field
  // silently being `undefined` is exactly the kind of latent bug that
  // detonates the day a caller starts reading it.
  return { config: selected.config, configDigest: selected.configDigest, lock: resolved.lock, arms: resolved.scope.arms };
}

/** Cloud-off is a hint and exit 0, never a crash: a repo may legitimately run
 *  campaigns with no store, and the local bake-off log still exists. */
function cloudOffNotice(verb) {
  process.stdout.write(`campaign ${verb}: the cloud store is off (AUDIT_DB_URL unset) — nothing to read.\n`
    + '  Local collection still works; set AUDIT_DB_URL to record and adjudicate.\n');
}

// ── Verbs ───────────────────────────────────────────────────────────────────

/**
 * Thin wrapper over the shared store reader — the CLI's only job here is to
 * resolve the repo identity, which the dashboard collector resolves its own way.
 * The ASSEMBLY lives in the store seam so `status`, `verdict` and the
 * dashboard cannot disagree about what a campaign's state is.
 */
async function readCohortEvidence({ config, lock }) {
  return store.loadCohortEvidence({ repoId: await repoId(), config, lock });
}

/**
 * Re-cluster the cohort at a BAND of matcher thresholds, so `verdict.mjs` can
 * ask whether the decision depends on the calibration.
 *
 * The band brackets both cutoffs far more widely than any re-calibration would
 * plausibly land — including "no clustering at all" — because the point is to
 * show the decision survives the threshold being WRONG, not to explore near it.
 * `current` is included so the reported set always contains the value in force.
 */
function buildSensitivityVariants(ev) {
  const { threshold, coverageFloor, withinArmThreshold } = findingMatchConfig;
  const VARIANTS = [
    { label: `current (cross ${threshold}, within ${withinArmThreshold})`, cross: threshold, within: withinArmThreshold },
    { label: 'cross-permissive (0.05)', cross: 0.05, within: withinArmThreshold },
    { label: 'cross-strict (0.40)', cross: 0.40, within: withinArmThreshold },
    { label: 'within-permissive (0.15)', cross: threshold, within: 0.15 },
    { label: 'within-strict (0.70)', cross: threshold, within: 0.70 },
    { label: 'no clustering at all', cross: 1.01, within: 1.01 },
  ];

  const bySnapshot = new Map();
  for (const f of ev.findings) {
    if (!bySnapshot.has(f.snapshot_id)) bySnapshot.set(f.snapshot_id, []);
    bySnapshot.get(f.snapshot_id).push({
      findingId: f.finding_id, armId: f.arm_id, section: f.primary_file,
      category: f.category, detail: f.detail_snapshot, severity: f.severity,
    });
  }
  const eventsFor = (id) => ev.eventsByFinding?.[id] ?? [];

  return VARIANTS.map((v) => {
    const clusters = [];
    for (const [snapshotId, rows] of bySnapshot) {
      const res = clusterSnapshotFindings(rows, { threshold: v.cross, coverageFloor, withinArmThreshold: v.within });
      if (res.coverage === 'unknown') continue;
      for (const c of res.clusters) {
        clusters.push({
          clusterId: c.canonicalFindingId, snapshotId,
          members: c.members.map((m) => ({ ...m, events: eventsFor(m.findingId) })),
        });
      }
    }
    return { label: v.label, clusters };
  });
}

async function verbStatus(campaignId, { asJson }) {
  const { config, lock } = loadCampaign(campaignId);
  const ev = await readCohortEvidence({ config, lock });
  if (!ev.ok) {
    // Local-only readout: the bake-off log is the collection record even when
    // nothing has been promoted into the store yet. Reporting "0 snapshots"
    // here would read as a measurement of an empty campaign.
    const local = readLog().filter((e) => e.campaignId === config.id);
    process.stdout.write(`campaign ${config.id}: ${ev.reason}\n`
      + `  local bake-off log: ${local.length} snapshot(s) collected under lock ${lock?.lockDigest ?? 'n/a'}\n`
      + '  run `campaign.mjs reconcile` if receipts exist but rows do not.\n');
    return 0;
  }
  const result = evaluateCampaign({
    config, snapshots: ev.snapshots, clusters: ev.clusters, adjudication: ev.adjudication,
    calibration: ev.calibration, clustering: ev.clustering, cohortSuperseded: ev.cohortSuperseded,
    declaredInconclusive: ev.declaredInconclusive, ruleChangedAfterFirstArmRun: ev.ruleChangedAfterFirstArmRun,
    sensitivity: assessThresholdSensitivity({ config, snapshots: ev.snapshots, variants: buildSensitivityVariants(ev) }),
  });
  if (asJson) { process.stdout.write(`${JSON.stringify({ ...result, overhead: ev.overhead }, null, 2)}\n`); return 0; }

  const L = [];
  L.push(`campaign ${config.id} — ${result.state}`);
  L.push(`  ${result.stateReason}`);
  L.push(`  lock ${lock?.lockDigest ?? 'n/a'}${ev.cohortSuperseded ? ' (SUPERSEDED)' : ''}`);
  L.push(`  N complete: ${result.nComplete} / ${config.targetN}`);
  for (const row of result.completion.incomplete) {
    L.push(`    incomplete ${row.snapshotId}: missing ${row.missingArms.join(', ')}`);
  }
  L.push('  spend per arm (ALL attempts, superseded included — a retried arm was paid for twice):');
  for (const [armId, s] of Object.entries(result.spend)) {
    const money = s.costEvidence === 'known' ? `$${s.spendUsd.toFixed(4)}` : 'unknown';
    L.push(`    ${armId}: ${money}${s.attempts > 1 ? ` over ${s.attempts} attempts` : ''}`);
  }
  L.push(`  adjudication overhead: ${ev.overhead.costEvidence === 'known' ? `$${Number(ev.overhead.spendUsd).toFixed(4)}` : 'unknown'} over ${ev.overhead.attempts ?? 0} attempt(s)`);
  L.push('  calibration:');
  for (const [armId, c] of Object.entries(ev.calibration.perArm)) {
    L.push(`    ${armId}: sample ${c.dispositioned}/${c.assigned} reviewed · override rate ${c.overrideRate == null ? 'unknown' : `${(c.overrideRate * 100).toFixed(0)}%`} · self-family ${c.selfFamilyShare == null ? 'unknown' : `${(c.selfFamilyShare * 100).toFixed(0)}%`}`);
  }
  if (result.watermark) {
    L.push(`  ${result.watermark.label} — failing gates:`);
    for (const g of result.watermark.failing) L.push(`    ${g.id}: ${g.detail}`);
  }
  for (const a of result.advisories) L.push(`  advisory ${a.id}: ${a.detail}`);
  if (result.sensitivity?.assessed) {
    L.push(`  matcher sensitivity: ${result.sensitivity.invariant ? 'INVARIANT' : 'DECISION FLIPS'} — ${result.sensitivity.reason}`);
  }
  L.push(`  analysis-time fields (outside every digest): ${ANALYSIS_TIME_FIELDS.join(', ')}`);
  process.stdout.write(`${L.join('\n')}\n`);
  return 0;
}

async function verbVerdict(campaignId, { asJson }) {
  const { config, lock } = loadCampaign(campaignId);
  const ev = await readCohortEvidence({ config, lock });
  if (!ev.ok) { process.stdout.write(`campaign ${config.id}: ${ev.reason} — no verdict is computable.\n`); return 3; }
  const result = evaluateCampaign({
    config, snapshots: ev.snapshots, clusters: ev.clusters, adjudication: ev.adjudication,
    calibration: ev.calibration, clustering: ev.clustering, cohortSuperseded: ev.cohortSuperseded,
    declaredInconclusive: ev.declaredInconclusive, ruleChangedAfterFirstArmRun: ev.ruleChangedAfterFirstArmRun,
    sensitivity: assessThresholdSensitivity({ config, snapshots: ev.snapshots, variants: buildSensitivityVariants(ev) }),
  });
  if (asJson) { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return result.decisionEligible ? 0 : 3; }

  const L = [`campaign ${config.id} verdict — state ${result.state}`];
  L.push(`  floor (incumbent ${result.floor.incumbentArmId} at ${result.floor.incumbentPerSnapshot}/snapshot, margin ${result.floor.floorMargin} → threshold ${result.floor.threshold}):`);
  for (const [armId, f] of Object.entries(result.floor.perArm)) {
    L.push(`    ${armId}: ${f.accepted} accepted → ${f.perSnapshot}/snapshot — ${f.clears ? 'CLEARS' : `blocked (relative ${f.clearsRelative ? 'ok' : 'fail'}, above-zero ${f.clearsAbsolute ? 'ok' : 'fail'})`}`);
  }
  if (result.cost.evaluated) {
    L.push('  cost per accepted:');
    for (const [armId, c] of Object.entries(result.cost.perArm)) {
      L.push(`    ${armId}: ${c.costPerAccepted == null ? 'undefined (0 accepted)' : `$${c.costPerAccepted.toFixed(4)}`}${c.withinCeiling === false ? ' — over ceiling' : ''}`);
    }
  } else {
    L.push(`  cost stage NOT evaluated: ${result.cost.reason}`);
  }
  L.push(result.verdict
    ? `  VERDICT: ${result.verdict.outcome}${result.verdict.armId ? ` ${result.verdict.armId}` : ''} — ${result.verdict.reason}`
    : `  VERDICT: not decision-eligible — ${result.watermark.failing.map((g) => g.id).join(', ')}`);
  process.stdout.write(`${L.join('\n')}\n`);
  return result.decisionEligible ? 0 : 3;
}

async function verbCluster(campaignId, { recluster }) {
  const { config, lock } = loadCampaign(campaignId);
  const ev = await readCohortEvidence({ config, lock });
  if (!ev.ok) { process.stdout.write(`campaign ${config.id}: ${ev.reason}\n`); return 3; }
  const { written, refused } = await clusterCohort(ev, { recluster });
  process.stdout.write(`campaign ${config.id}: wrote ${written} cluster(s) under matcher v${FINDING_MATCH_SCHEMA_VERSION} @ ${findingMatchConfig.threshold}\n`);
  for (const r of refused) process.stdout.write(`  REFUSED ${r.snapshotId}: ${r.reason}\n`);
  // A refusal is reported, not fatal: the snapshot keeps its evidence and
  // `verdict.mjs` watermarks on the missing attribution rather than guessing.
  return 0;
}

/**
 * Cluster every snapshot that needs it. Extracted so `reconcile` can run it
 * automatically after promotion — §7a/R3-H4 specifies clustering happens "at the
 * end of a collect that completes a snapshot", and `reconcile` IS the
 * collect→store step. Left as its own verb too, because re-clustering at a new
 * matcher threshold is a deliberate analysis-time act, not a side effect.
 */
async function clusterCohort(ev, { recluster = false } = {}) {
  const bySnapshot = new Map();
  for (const f of ev.findings) {
    if (!bySnapshot.has(f.snapshot_id)) bySnapshot.set(f.snapshot_id, []);
    bySnapshot.get(f.snapshot_id).push({
      findingId: f.finding_id, armId: f.arm_id, section: f.primary_file,
      category: f.category, detail: f.detail_snapshot, severity: f.severity,
    });
  }

  let written = 0;
  const refused = [];
  for (const [snapshotId, rows] of bySnapshot) {
    if (!recluster && !ev.clustering.snapshotsMissingClusters.includes(snapshotId)) continue;
    const res = clusterSnapshotFindings(rows, findingMatchConfig);
    if (res.coverage === 'unknown') { refused.push({ snapshotId, reason: res.reason }); continue; }
    const w = await store.writeClusterSet({
      cohortId: ev.cohortId, snapshotId,
      matcherVersion: String(FINDING_MATCH_SCHEMA_VERSION), matcherThreshold: findingMatchConfig.threshold,
      clusters: res.clusters,
    });
    if (!w.ok) { refused.push({ snapshotId, reason: w.error }); continue; }
    written += w.written;
  }
  return { written, refused };
}

async function verbAdjudicate(campaignId, { limit, dryRun }) {
  const { config, lock } = loadCampaign(campaignId);
  const ev = await readCohortEvidence({ config, lock });
  if (!ev.ok) { process.stdout.write(`campaign ${config.id}: ${ev.reason}\n`); return 3; }

  const key = store.requireCampaignHmacKey(config.id);
  const keyRef = store.hmacKeyRefFor(config.id);
  // `--dry-run` previews SPEND, so it must not write. `create: false` keeps the
  // lookup and the key-ref refusal while skipping the insert; the row-set
  // upsert below is skipped for the same reason. (Before this, a `--dry-run`
  // enrolled the worksheet AND recorded real `unverifiable` verdicts for every
  // row whose citations did not resolve — which is why a dry run at
  // `--limit 3` was followed by a real run reporting one fewer pending row.)
  const ws = await store.ensureWorksheet({ cohortId: ev.cohortId, hmacKeyRef: keyRef, create: !dryRun });
  if (!ws.ok) { process.stderr.write(`${ws.error}\n`); return 1; }

  // Build the row set + calibration assignment from the UNBLINDED findings, then
  // persist both before anything is rendered or called.
  const candidates = ev.findings.map((f) => ({
    findingId: f.finding_id, armId: f.arm_id, armRunId: f.arm_run_id, sourceModel: f.source_model,
    auditedSha: f.audited_sha, section: f.primary_file, category: f.category,
    detail: f.detail_snapshot, severity: f.severity,
    // The run's plan document — the citation fallback for a plan-mode finding,
    // whose `primary_file` is a `§`-section and resolves no path at all.
    planFile: f.plan_file ?? null, mode: f.mode ?? null,
    worksheetRowId: store.worksheetRowIdFor(f.finding_id, key),
  }));
  const assigned = store.assignCalibrationSample(candidates, { campaignId: config.id, key, rate: config.calibration.sampleRate });
  if (!dryRun) {
    const persisted = await store.upsertWorksheetRows(ws.id, candidates.map((c) => ({
      worksheetRowId: c.worksheetRowId, findingId: c.findingId, calibrationAssigned: assigned.get(c.worksheetRowId) === true,
    })));
    if (!persisted.ok) { process.stderr.write(`${persisted.error}\n`); return 1; }
  }

  const byRowId = new Map(candidates.map((c) => [c.worksheetRowId, c]));
  // A dry run against a cohort with no worksheet yet has nothing to read, so it
  // previews the rows it WOULD enrol rather than creating them to find out.
  // The projection is the blind one either way — a preview that saw more than
  // the adjudicator sees would be previewing a different run.
  const blindRows = ws.id
    ? await store.loadBlindWorksheet(ws.id, { key, campaignId: config.id })
    : {
      ok: true,
      rows: candidates.map((c) => ({
        worksheet_row_id: c.worksheetRowId, calibration_assigned: assigned.get(c.worksheetRowId) === true,
        agent_event_id: null, severity: c.severity, category: c.category,
        primary_file: c.section, detail_snapshot: c.detail,
      })),
    };
  if (!blindRows.ok) { process.stderr.write(`${blindRows.error}\n`); return 1; }

  const redact = store.buildModelRedactor({ arms: config.arms });
  const adjudicatorModel = resolveModel(config.adjudicator.model);

  // Only rows with no live agent verdict: a re-run must not stack duplicate
  // PAID verdicts, and the partial unique index would supersede the prior one
  // silently if we did not filter here.
  const pending = blindRows.rows.filter((r) => r.agent_event_id == null);
  const todo = Number.isInteger(limit) && limit > 0 ? pending.slice(0, limit) : pending;
  process.stdout.write(`campaign ${config.id}: ${todo.length} row(s) to adjudicate (${pending.length} pending of ${blindRows.rows.length} total)`
    + `${dryRun ? ' — DRY RUN, nothing is written' : ''}\n`);
  if (todo.length === 0) return 0;

  const client = dryRun ? null : await createAnthropicClient({ backend: 'sdk' });
  // Disjoint buckets, one per attempted row — see `renderAdjudicationSummary`.
  // `providerFailures` is the one deliberate SUBSET (of `humanQueue`): a call
  // that produced no verdict still records `unverifiable` and still routes to a
  // human, so counting it as its own bucket would double-count the row.
  let settled = 0; let humanQueue = 0; let providerFailures = 0;
  let unrecorded = 0; let skipped = 0; let previewed = 0; let previewForced = 0; let aborted = false;

  for (const row of todo) {
    // `src` supplies ONLY the store-side facts that are never rendered — the
    // snapshot's revision, the arm-run link, and the source model that
    // `self_family` is computed from. Every field the adjudicator SEES comes
    // from `row`, the blind projection, so the blindness contract is a property
    // of one named query rather than of this loop remembering to be careful.
    const src = byRowId.get(row.worksheet_row_id);
    if (!src) {
      // A worksheet row whose finding is no longer in the cohort's live
      // evidence. Counted, never silent: an unattributable row that vanishes
      // from the arithmetic is how a partial run reads as a complete one.
      skipped += 1;
      process.stderr.write(`  [campaign] row ${row.worksheet_row_id}: no live cohort finding for this worksheet row — skipped\n`);
      continue;
    }
    // `detail` feeds the anchor search, not the prompt path: the store's
    // `primary_file` never carries a line (0 of 3993 measured), so without the
    // prose there is nothing to centre the window on.
    const cited = resolveCitedSources({
      section: row.primary_file, detail: row.detail_snapshot, auditedSha: src.auditedSha, planFile: src.planFile,
    });
    const blind = store.buildBlindRow({
      worksheetRowId: row.worksheet_row_id,
      category: row.category,
      primaryFile: row.primary_file,
      detail: row.detail_snapshot,
      severity: row.severity,
      citedSources: cited.sources,
    }, redact);

    // A row whose citations ALL fail to resolve is forced to `unverifiable`
    // BEFORE the call is made — never sent to the model to guess about.
    // Asking an LLM with no tool access to verify code it cannot see does not
    // produce `unverifiable`; it produces confident hallucinated verification,
    // which is worse than no adjudication because it is scored as evidence.
    if (!cited.resolvedAny) {
      // The dry-run check comes FIRST here. It used to come after this write,
      // so `--dry-run` recorded a real, terminal verdict for every row with an
      // unresolvable citation — the preview an operator runs to decide whether
      // to spend was the one command that mutated the campaign silently.
      if (dryRun) { previewed += 1; previewForced += 1; continue; }
      const w = await writeVerdict({
        src, ws, adjudicatorModel, dryRun,
        verdict: { method: 'unverifiable', outcome: 'needs_triage', evidence: { path: null, sha: src.auditedSha, lineRange: null, quotedSpan: null, absenceReason: 'no cited path resolved at this revision' }, confidence: 0 },
      });
      if (!w.ok) { unrecorded += 1; aborted = true; reportLostVerdict(src, w); break; }
      humanQueue += 1;
      continue;
    }
    if (dryRun) { previewed += 1; continue; }

    const wrRow = await store.resolveWorksheetRowAttempt({ worksheetId: ws.id, worksheetRowId: row.worksheet_row_id });
    const attempt = resolveNextAttempt({
      campaignId: config.id, cohortDigest: adjudicationCohortDir(lock), snapshotId: 'adjudicate',
      armId: row.worksheet_row_id, dbMaxAttempt: wrRow.attempt,
    });
    const receiptArgs = { campaignId: config.id, cohortDigest: adjudicationCohortDir(lock), snapshotId: 'adjudicate', armId: row.worksheet_row_id, attempt };
    const claim = claimReceipt({ ...receiptArgs, body: { kind: 'adjudication', adjudicatorModel } });
    if (!claim.ok) {
      process.stderr.write(`  [campaign] row ${row.worksheet_row_id}: attempt ${attempt} already claimed — another runner holds it; skipping\n`);
      continue;
    }

    const outcome = await callAdjudicator({ client, model: adjudicatorModel, blind });
    completeReceipt({ ...receiptArgs, result: { usage: outcome.usage ?? null, verdict: outcome.verdict ?? null, error: outcome.error ?? null } });

    const cost = costFromUsage(outcome.usage, adjudicatorModel);
    const verdict = outcome.verdict ?? {
      method: 'unverifiable', outcome: 'needs_triage', confidence: 0,
      evidence: { path: null, sha: src.auditedSha, lineRange: null, quotedSpan: null, absenceReason: outcome.error },
    };
    if (!outcome.verdict) {
      providerFailures += 1;
      process.stderr.write(`  [campaign] row ${row.worksheet_row_id}: ${outcome.error} — recording unverifiable, routed to the human queue\n`);
    }
    const w = await writeVerdict({ src, ws, adjudicatorModel, verdict, cost, attempt, worksheetRowUuid: wrRow.id, dryRun });
    if (!w.ok) {
      // NOT `markReceiptRecorded` — `recorded` means the store row is durable,
      // and it is not. The receipt stays `complete` (paid, unrecorded), which is
      // exactly the state `reconcile` reports as recoverable.
      unrecorded += 1;
      aborted = true;
      reportLostVerdict(src, w);
      break;
    }
    markReceiptRecorded(receiptArgs);
    if (routesToHumanQueue(verdict)) humanQueue += 1;
    else settled += 1;
  }

  const summary = renderAdjudicationSummary({
    attempted: todo.length, settled, humanQueue, providerFailures, unrecorded, skipped, previewed, previewForced, aborted, dryRun,
  });
  process.stdout.write(`${summary.lines.join('\n')}\n`);
  if (humanQueue > 0) {
    process.stdout.write('  Rows in the human queue are NOT counted as evidence until dispositioned:\n'
      + '    node scripts/campaign.mjs override --finding FINDING_UUID --verdict accepted --note "why"\n');
  }
  // The exit code carries the write failure. A verb that reports lost evidence
  // in its prose and exits 0 is read as success by every caller checking `$?`
  // (cli-io.mjs `emit({ok:false})` makes the same coupling for JSON verbs).
  return summary.exitCode;
}

/** One place that says what a failed verdict write COST, so the two call sites
 *  cannot drift into describing the same loss differently. */
function reportLostVerdict(src, res) {
  process.stderr.write(`  [campaign] verdict write FAILED for finding ${src.findingId}: ${res.error}\n`
    + '  [campaign] the batch is stopping here. A write failure is a contract or schema refusal, not provider\n'
    + '  [campaign] variance — continuing would pay for verdicts that cannot be stored either.\n');
}

/** Receipts live under the cohort the evidence belongs to. */
function adjudicationCohortDir(lock) {
  return lock?.lockDigest ?? 'no-lock';
}

async function writeVerdict({ src, ws, adjudicatorModel, verdict, cost = null, attempt = 1, worksheetRowUuid = null, dryRun = false }) {
  // The dry-run guarantee gets a FUNCTION BOUNDARY rather than resting on the
  // order of two `if`s in the loop. It rested on that order until 2026-08-19,
  // and lost: the unresolved-citation branch wrote a real terminal verdict
  // before the loop ever checked `dryRun`, so the command an operator runs to
  // preview spend silently adjudicated rows. A reordering can happen again; a
  // caller that reaches this line under `--dry-run` now fails loudly instead.
  if (dryRun) throw new Error('writeVerdict must never be reached under --dry-run: a preview that mutates is not a preview');
  const selfFamily = store.isSelfFamily(adjudicatorModel, src.sourceModel);
  const res = await store.recordAgentVerdict({
    findingId: src.findingId, worksheetRowId: src.worksheetRowId, worksheetId: ws.id,
    armRunId: src.armRunId, adjudicatorModel, method: verdict.method, outcome: verdict.outcome,
    evidence: verdict.evidence ?? null, selfFamily,
  });
  // The failure is NOT logged here. It is returned, and the caller counts it,
  // stops the batch and carries it into the exit code — a log line the summary
  // then contradicts with a tidy success count is how this defect stayed
  // invisible through a 195-row campaign.
  // Spend is recorded only when a provider call actually happened, and only
  // when we have the row to hang it on. A missing row is REPORTED rather than
  // silently dropped: an unrecorded charge reads as free, which is lesson (e).
  if (cost) {
    if (!worksheetRowUuid) {
      process.stderr.write(`  [campaign] WARNING: adjudication spend for ${src.findingId} could not be recorded (no worksheet row uuid) — the campaign's overhead line will under-report\n`);
    } else {
      const spend = await store.recordAdjudicationAttempt({
        worksheetRowUuid, attempt, status: verdict.method,
        usage: { input_tokens: cost.inputTokens, output_tokens: cost.outputTokens },
        costUsd: cost.totalUsd, costStatus: cost.totalUsd == null ? 'unpriced' : 'priced',
      });
      // Not fatal — the verdict is the evidence and it landed — but never
      // silent, for the same reason as the branch above.
      if (!spend.ok) {
        process.stderr.write(`  [campaign] WARNING: adjudication spend for ${src.findingId} was NOT recorded (${spend.error}) — the campaign's overhead line will under-report\n`);
      }
    }
  }
  return res;
}

/**
 * One finding per call — isolation, deliberately. A batch lets one row's
 * reasoning contaminate the next, and the whole value of these verdicts is that
 * each is an independent verification against code.
 *
 * Retry once on failure, then hand off. `unverifiable` is the honest terminal
 * state of a call that would not produce a parseable verdict.
 */
async function callAdjudicator({ client, model, blind, attempts = 2 }) {
  let lastError = 'no attempt made';
  let usage = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const resp = await client.messages.create({
        model,
        max_tokens: 4000,
        system: ADJUDICATION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify(blind, null, 2) }],
        tools: [ADJUDICATION_TOOL],
        // Forced structured output. `{backend:'sdk'}` is pinned at construction
        // because the cli backend silently DROPS tools/tool_choice — a caller
        // forcing tool_choice there gets a plain text block back with no error.
        tool_choice: { type: 'tool', name: ADJUDICATION_TOOL.name },
      });
      usage = resp?.usage ?? null;
      const call = resp?.content?.find((b) => b.type === 'tool_use' && b.name === ADJUDICATION_TOOL.name);
      if (!call) { lastError = `no ${ADJUDICATION_TOOL.name} tool call (stop_reason ${resp?.stop_reason ?? 'unknown'})`; continue; }
      const norm = normaliseVerdict(call.input, { worksheetRowId: blind.worksheetRowId });
      if (!norm.ok) { lastError = norm.reason; continue; }
      if (norm.downgraded) process.stderr.write(`  [campaign] ${norm.downgraded}\n`);
      return { verdict: norm.verdict, usage, error: null };
    } catch (err) {
      lastError = err?.message ?? String(err);
    }
  }
  return { verdict: null, usage, error: lastError };
}

async function verbOverride({ findingId, outcome, note, actor }) {
  const res = await store.recordHumanOverride({ findingId, outcome, note, actor });
  if (res.cloud === false) { cloudOffNotice('override'); return 0; }
  if (!res.ok) { process.stderr.write(`${res.error}\n`); return 1; }
  process.stdout.write(`override recorded: finding ${findingId} → ${outcome} (overrides agent event ${res.overrides})\n`);
  return 0;
}

/**
 * Receipt recovery (§5) + log promotion. `complete` = paid and unrecorded → the
 * row can be inserted. `intent` = the true crash window, where paid-or-not is
 * genuinely UNKNOWN — reported for an operator decision and NEVER auto-retried,
 * because silently re-calling is exactly the double-charge this protocol exists
 * to prevent. That is the honest boundary, not a gap in the design.
 */
/**
 * Record the ANALYSIS-TIME rule, and append `rule_changed` when it moved.
 *
 * §2.5b removes `targetN` / `calibration` / `decisionRule` from every digest on
 * purpose: hashing them would mean editing a cost ceiling destroyed every
 * snapshot ever collected. The stated substitute is that each change appends a
 * `rule_changed` event with before/after and the operator, and `verdict.mjs`
 * watermarks standings whose rule moved after the first arm-run.
 *
 * That substitute had a READER and no WRITER. `verdict.mjs` watermarked on an
 * event nothing ever wrote, and `loadCohortEvidence` read a kind that never
 * appeared — so editing a cost ceiling recorded nothing, the watermark could not
 * fire, and the only protection pre-registration had was inert. A guarantee
 * whose enforcement does not exist is the shape this repo's gate-honesty work
 * exists to catch, and it survived six GPT rounds and two Gemini rounds because
 * an audit compares the diff to the plan and an ABSENCE OF WIRING is not in the
 * diff.
 *
 * It lives on `reconcile` — a write-path verb — deliberately. `status` and
 * `verdict` are reads, and a read that appends events is a read nobody can run
 * twice safely.
 *
 * The FIRST recording is `rule_registered`, not `rule_changed`: declaring a rule
 * is not moving one, and watermarking a campaign for having a rule at all would
 * make the signal meaningless.
 */
async function recordRuleState({ config, campaignId, actor }) {
  if (!campaignId) return { ok: true, recorded: false };
  const current = Object.fromEntries(ANALYSIS_TIME_FIELDS.map((f) => [f, config[f]]));
  const log = await store.listCampaignEvents(campaignId);
  if (log.cloud === false) return { ok: true, recorded: false };

  const prior = [...log.rows]
    .filter((e) => e.kind === 'rule_registered' || e.kind === 'rule_changed')
    .pop();
  if (!prior) {
    await store.appendCampaignEvent({ campaignId, kind: 'rule_registered', actor: actor ?? null, detail: { rule: current } });
    return { ok: true, recorded: true, kind: 'rule_registered' };
  }
  const before = prior.detail?.rule ?? prior.detail?.after ?? null;
  // Canonical JSON so key order can never masquerade as a rule change.
  if (canonicalJson(before) === canonicalJson(current)) return { ok: true, recorded: false, kind: 'unchanged' };

  await store.appendCampaignEvent({
    campaignId, kind: 'rule_changed', actor: actor ?? null,
    detail: { before, after: current },
  });
  return { ok: true, recorded: true, kind: 'rule_changed', before, after: current };
}

async function verbReconcile(campaignId, { actor = null } = {}) {
  const { config, lock, configDigest } = loadCampaign(campaignId);
  const promoted = await promoteFromLog({ config, lock, configDigest, entries: readLog() });
  // `promoteFromLog` (scripts/lib/campaign/promote.mjs) no longer prints the
  // cloud-off notice itself — it cannot import `cloudOffNotice` without
  // reaching back into this entry point (D2's boundary), so it returns
  // `{cloud:false}` and the caller renders it, same as every other verb here.
  if (promoted.cloud === false) cloudOffNotice('reconcile');

  if (promoted.cloud !== false) {
    const ev = await readCohortEvidence({ config, lock });
    if (ev.ok) {
      const ruled = await recordRuleState({ config, campaignId: ev.campaignId, actor });
      if (ruled.kind === 'rule_changed') {
        process.stdout.write('  RULE CHANGED — recorded in campaign_events. Standings collected before this edit are watermarked;\n'
          + '  the evidence survives, and the fact that the goalposts moved is now recorded beside the number.\n');
      } else if (ruled.kind === 'rule_registered') {
        process.stdout.write('  rule registered (baseline) — later edits will append a rule_changed event\n');
      }
      // §7a/R3-H4: clustering runs at the end of the collect→store step, so a
      // completed snapshot is attributable without a second manual command.
      // verdict.mjs refuses attribution on an unclustered complete snapshot, so
      // leaving this to the operator meant the ordinary path watermarked.
      const { written, refused } = await clusterCohort(ev, { recluster: false });
      if (written) process.stdout.write(`  clustered ${written} new cluster(s) under matcher v${FINDING_MATCH_SCHEMA_VERSION}\n`);
      for (const r of refused) process.stdout.write(`  cluster REFUSED ${r.snapshotId}: ${r.reason}\n`);
    }
  }

  const receipts = scanReceipts(config.id);
  const byState = { intent: [], complete: [], recorded: [], unreadable: [] };
  for (const r of receipts) (byState[r.state] ?? (byState[r.state] = [])).push(r);

  process.stdout.write(`campaign ${config.id}: ${receipts.length} receipt(s)\n`
    + `  recorded:   ${byState.recorded.length}\n`
    + `  complete:   ${byState.complete.length} (paid, unrecorded — recoverable)\n`
    + `  intent:     ${byState.intent.length} (crash window — paid-or-not UNKNOWN)\n`
    + `  unreadable: ${byState.unreadable.length}\n`);

  for (const r of byState.complete) {
    process.stdout.write(`  COMPLETE ${r.snapshotId}--${r.armId}--${r.attempt}: ${r.path}\n`);
  }
  for (const r of byState.intent) {
    process.stdout.write(`  INTENT   ${r.snapshotId}--${r.armId}--${r.attempt}: ${r.path}\n`
      + '           NOT auto-retried. Decide whether the provider was charged, then delete the receipt to allow a new attempt.\n');
  }
  for (const r of byState.unreadable) process.stdout.write(`  TORN     ${r.path}\n`);
  // Exit 4 when operator action is outstanding — a reconcile that always exits 0
  // is a reconcile nobody reads.
  return (byState.intent.length + byState.unreadable.length) > 0 ? 4 : 0;
}

async function verbDeclareInconclusive(campaignId, { reason, actor }) {
  const { config, lock } = loadCampaign(campaignId);
  const rid = await repoId();
  const resolved = await store.resolveCohort({ repoId: rid, campaignKey: config.id, lockDigest: lock?.lockDigest ?? null });
  if (resolved.cloud === false) { cloudOffNotice('declare-inconclusive'); return 0; }
  if (!resolved.campaignId) { process.stderr.write(`campaign ${config.id} has no store row yet — nothing to declare against.\n`); return 3; }
  const res = await store.appendCampaignEvent({
    campaignId: resolved.campaignId, kind: 'declared-inconclusive', actor: actor ?? null, detail: { reason },
  });
  if (!res.ok) { process.stderr.write(`${res.error}\n`); return 1; }
  process.stdout.write(`campaign ${config.id}: declared INCONCLUSIVE — ${reason}\n`
    + '  This is terminal and append-only; the evidence stays readable and stops counting.\n');
  return 0;
}

// ── main ────────────────────────────────────────────────────────────────────

// Real values, never angle brackets — PowerShell reserves `<` and an
// unpasteable example is an example nobody runs (AGENTS.md operator-doc
// convention). Substitute your own campaign id and finding uuid.
const USAGE = [
  'Usage (substitute your own campaign id / finding uuid — these examples paste as-is):',
  '  node scripts/campaign.mjs status               --campaign final-review-2026q3 --json',
  '  node scripts/campaign.mjs cluster              --campaign final-review-2026q3 --recluster',
  '  node scripts/campaign.mjs adjudicate           --campaign final-review-2026q3 --limit 10 --dry-run',
  '  node scripts/campaign.mjs override             --finding FINDING_UUID --verdict dismissed --note "why" --actor louis',
  '  node scripts/campaign.mjs verdict              --campaign final-review-2026q3 --json',
  '  node scripts/campaign.mjs reconcile            --campaign final-review-2026q3',
  '  node scripts/campaign.mjs declare-inconclusive --campaign final-review-2026q3 --reason "eligible pool exhausted"',
  '',
  '--verdict is one of: accepted, dismissed, severity_adjusted.',
  'Exit codes: 0 ok · 1 error · 2 bad arguments · 3 not computable · 4 operator action outstanding',
].join('\n');

async function main() {
  const verb = process.argv[2];
  if (!verb || process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!VERBS.includes(verb)) throw new ArgvError(`unknown verb "${verb}" — expected one of: ${VERBS.join(', ')}`);
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'campaign', from: 3 });

  const asJson = process.argv.includes('--json');
  switch (verb) {
    case 'status':      return verbStatus(arg('campaign'), { asJson });
    case 'verdict':     return verbVerdict(arg('campaign'), { asJson });
    case 'cluster':     return verbCluster(arg('campaign'), { recluster: process.argv.includes('--recluster') });
    case 'adjudicate':  return verbAdjudicate(arg('campaign'), {
      limit: arg('limit') == null ? null : Number(arg('limit')),
      dryRun: process.argv.includes('--dry-run'),
    });
    case 'override':    return verbOverride({
      findingId: requireArg('finding'),
      outcome: assertOutcome(requireArg('verdict')),
      note: arg('note'), actor: arg('actor'),
    });
    case 'reconcile':   return verbReconcile(arg('campaign'), { actor: arg('actor') });
    case 'declare-inconclusive': return verbDeclareInconclusive(arg('campaign'), { reason: requireArg('reason'), actor: arg('actor') });
    default:            throw new ArgvError(`unhandled verb "${verb}"`);
  }
}

/** `adjudication_outcome` is CHECK'd; refusing here names the legal set instead
 *  of surfacing a constraint name from Postgres. A human override may NOT write
 *  `needs_triage` — the point of a human disposition is that it DECIDES, and a
 *  human routing a row back to the human queue is a no-op wearing a verdict's
 *  clothes. */
function assertOutcome(value) {
  const legal = ['accepted', 'dismissed', 'severity_adjusted'];
  if (!legal.includes(value)) throw new ArgvError(`--verdict must be one of: ${legal.join(', ')} (got "${value}")`);
  return value;
}

const invokedDirectly = (() => {
  try { return (process.argv[1] || '').replace(/\\/g, '/').toLowerCase().endsWith('/campaign.mjs'); }
  catch { return false; }
})();

if (invokedDirectly) {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  main().then((code) => { process.exitCode = code ?? 0; }).catch((err) => {
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') { process.stderr.write(`${err.message}\n`); process.exit(2); }
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}

export const _internals = Object.freeze({ callAdjudicator, adjudicationCohortDir, assertOutcome, writeVerdict });

/** Exported for the live-schema suite: the rule recorder is store-coupled, so
 *  its contract is only assertable against a real campaign_events table. */
export { recordRuleState };
