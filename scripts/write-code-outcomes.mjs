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
import 'dotenv/config'; // load .env for standalone CLI use (matches sibling CLIs)
import { finalizeRoundOutcomes, loadAuditInputs, parseResultPath } from './lib/finalize-outcomes.mjs';
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
    else if (argv[i] === '--round') {
      // An explicitly-supplied round must validate exactly (a positive integer)
      // or abort — never coerce ("2abc"→2) or silently drop ("abc"). `Number`
      // (not `parseInt`) rejects trailing-garbage; the round-source reconciler
      // in main() then treats this as one authoritative source.
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        console.error(`--round must be a positive integer (got ${JSON.stringify(raw)})`);
        process.exit(1);
      }
      args.round = n;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.result || !args.ledger) {
    console.error('Usage: node scripts/write-code-outcomes.mjs --result <path> --ledger <path> [--round N]');
    process.exit(1);
  }

  // Load + shape-validate via the single shared contract (loadAuditInputs) —
  // same permissive schema the orchestrator + /cycle use; no duplicate parser.
  let result, ledger;
  try {
    ({ result, ledger } = loadAuditInputs({ resultPath: args.result, ledgerPath: args.ledger }));
  } catch (err) {
    console.error(`Failed to load audit inputs (result=${args.result}, ledger=${args.ledger}): ${err.message}`);
    process.exit(1);
  }

  const runId = result._cloudRunId || null;
  // The filename is the authoritative source for BOTH the session id and the
  // round; derive them together so the idempotency key (`${sid|runId}:${round}`)
  // and the persisted round can't silently disagree with the artifact.
  const { sid, round: filenameRound } = parseResultPath(args.result);
  // Reconcile every declared round source (CLI flag, result payload, filename).
  // Require all explicitly-present integer sources to agree; fail closed on a
  // conflict so an artifact is never persisted under the wrong round.
  const declaredRounds = [...new Set(
    [args.round, result.round, filenameRound].filter(v => Number.isInteger(v) && v >= 1),
  )];
  if (declaredRounds.length > 1) {
    console.error(
      `Round conflict among --round / result.round / filename (${declaredRounds.join(' vs ')}); `
      + 'refusing to persist outcomes under an ambiguous round.',
    );
    process.exit(1);
  }
  let round = declaredRounds[0];
  if (round === undefined) {
    process.stderr.write('  [write-code-outcomes] WARN: no round in --round/result.round/filename; defaulting to 1\n');
    round = 1;
  }
  // `sid` (from the filename) gives the cloud-off / no-run-id idempotency key a
  // stable component; warn when neither it nor a cloud run id is available.
  if (!sid && !runId) {
    // Neither a cloud run id nor a convention-derived sid → the local append
    // can't be marker-guarded (idempotency degrades to unguarded). Fail loud,
    // not silent (mirrors the plan's resolver no-match WARN).
    process.stderr.write(
      `  [write-code-outcomes] WARN: could not derive a session id from ${args.result} `
      + `(expected …-r<N>-result.json) and no _cloudRunId present; local idempotency guard disabled for this run\n`,
    );
  }

  await initLearningStore().catch(() => { /* cloud optional */ });
  // isCloudEnabled() is async — without await, `cloud` is a (truthy) Promise and
  // the store is built even when the cloud is off (Cluster B / Gemini follow-up).
  const cloud = await isCloudEnabled();
  // finalizeRoundOutcomes writes the cloud branch only when both `store` and the
  // result's `_cloudRunId` are present; pass null when cloud is off so it cleanly
  // degrades to the local `.audit/outcomes.jsonl` write.
  const store = cloud
    ? { recordAdjudicationEvent, updatePassStatsPostDeliberation, updateRunMeta }
    : null;

  // Delegate to the single shared finalize (same logic as the orchestrator + /cycle).
  const status = await finalizeRoundOutcomes({ result, ledger, round, store, sid });

  const cloudState = !cloud ? 'off' : runId ? (status.cloudOk ? 'ok' : 'failed') : 'no-run-id';
  process.stderr.write(
    `  [write-code-outcomes] round ${round}: ${status.labelled}/${status.total} `
    + `findings labelled · cloud=${cloudState}${status.skippedLocal ? ' · local skipped' : ''}\n`,
  );
  // Compact stdout — keep the operation status scalars; never emit the full
  // `enriched` payload (status/payload separation, M8).
  const { enriched: _enriched, ...compact } = status;
  process.stdout.write(`${JSON.stringify({ ok: true, runId, cloud, cloudState, ...compact })}\n`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
