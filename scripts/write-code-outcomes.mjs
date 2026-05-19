#!/usr/bin/env node
/**
 * @fileoverview CLI — record code-audit triage outcomes after deliberation.
 *
 * Closes the adaptive-learning data-loop gap: the `/audit-code` flow writes a
 * local adjudication ledger (Step 3.5) but nothing ever persisted the
 * accepted/dismissed outcomes — so the bandit, FP-learning and prompt
 * evolution had no ground-truth signal (`finding_adjudication_events`,
 * `audit_pass_stats.findings_accepted/dismissed`, `audit_runs.labeled` all
 * stayed empty).
 *
 * This bridges the ledger → `scripts/lib/outcome-sync.mjs`, which writes
 * finding_adjudication_events + audit_pass_stats + audit_findings + audit_runs
 * (cloud) and `.audit/outcomes.jsonl` (local, bandit reward).
 *
 * Sibling of `write-plan-outcomes.mjs` — that records PLAN-audit outcomes to
 * the local PlanFpTracker; this records CODE-audit outcomes to the cloud +
 * local outcome stores. Different audit mode, different stores.
 *
 * Usage:
 *   node scripts/write-code-outcomes.mjs \
 *     --result /tmp/audit-code-<sid>-r<N>-result.json \
 *     --ledger /tmp/audit-code-<sid>-ledger.json \
 *     [--round N]
 *
 * Best-effort: a cloud failure logs and falls back to local-only; never throws
 * for the expected "cloud off" / "no run id" cases.
 *
 * @module scripts/write-code-outcomes
 */
import fs from 'node:fs';
import path from 'node:path';
import { recordTriageOutcomes } from './lib/outcome-sync.mjs';
import {
  initLearningStore,
  isCloudEnabled,
  recordAdjudicationEvent,
  updatePassStatsPostDeliberation,
  updateRunMeta,
} from './learning-store.mjs';

function parseArgs(argv) {
  const args = { result: null, ledger: null, round: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--result') args.result = argv[++i];
    else if (argv[i] === '--ledger') args.ledger = argv[++i];
    else if (argv[i] === '--round') args.round = Number.parseInt(argv[++i], 10);
  }
  return args;
}

function readJsonOrDie(label, p) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(p), 'utf-8'));
  } catch (err) {
    console.error(`Failed to read ${label} file (${p}): ${err.message}`);
    process.exit(1);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.result || !args.ledger) {
    console.error('Usage: node scripts/write-code-outcomes.mjs --result <path> --ledger <path> [--round N]');
    process.exit(1);
  }

  const result = readJsonOrDie('result', args.result);
  if (!result || typeof result !== 'object' || !Array.isArray(result.findings)) {
    console.error('result file must be an object with a "findings" array');
    process.exit(1);
  }

  // Ledger is { version, entries: [...] }; tolerate a bare array too.
  const ledgerRaw = readJsonOrDie('ledger', args.ledger);
  const ledger = Array.isArray(ledgerRaw) ? { entries: ledgerRaw } : ledgerRaw;
  if (!ledger || !Array.isArray(ledger.entries)) {
    console.error('ledger file must have an "entries" array');
    process.exit(1);
  }

  const runId = result._cloudRunId || null;
  const round = Number.isInteger(args.round) ? args.round : (result.round || 1);

  await initLearningStore().catch(() => { /* cloud optional */ });
  const cloud = isCloudEnabled();
  // outcome-sync writes the cloud branch only when both `store` and `runId`
  // are present; pass null when cloud is off so it cleanly degrades to the
  // local `.audit/outcomes.jsonl` write.
  const store = cloud
    ? { recordAdjudicationEvent, updatePassStatsPostDeliberation, updateRunMeta }
    : null;

  const { enriched, passCounts, cloudOk } = await recordTriageOutcomes(
    store, runId, result.findings, ledger, { round },
  );

  const labelled = enriched.filter((f) => f.adjudicationOutcome !== 'pending').length;
  const cloudState = !cloud ? 'off' : runId ? (cloudOk ? 'ok' : 'failed') : 'no-run-id';
  process.stderr.write(
    `  [write-code-outcomes] round ${round}: ${labelled}/${result.findings.length} `
    + `findings labelled · cloud=${cloudState}\n`,
  );
  process.stdout.write(`${JSON.stringify({
    ok: true, round, runId, labelled, total: result.findings.length,
    cloud, cloudOk, passCounts,
  })}\n`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
