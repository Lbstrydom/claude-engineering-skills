#!/usr/bin/env node
/**
 * @fileoverview Remediation-state verification reconciler — OUT-OF-BAND.
 *
 * `accepted`/`severity_adjusted` findings stuck at `remediation_state`
 * `pending`/`planned` converge to `fixed` only when the live-round lifecycle
 * (`computeFixLifecycleUpdates`/`reconcileRemediationProjection`,
 * scripts/lib/ledger.mjs, scripts/lib/store/runs-findings.mjs) happens to see
 * them — session-scoped, round-diff-scoped, 14-day-bounded (see
 * docs/plans/remediation-state-verification-reconciler.md §1). This tool is
 * the safety net for everything that machinery structurally cannot reach: it
 * reads `audit_findings` directly (no ledger, no age bound), gates on "did
 * the file actually change since acceptance", and — where it did — asks an
 * LLM whether the finding is still reproducible against the current code.
 *
 * SAFE BY DEFAULT: dry-run unless `--apply` (mirrors scripts/semantic-suppress.mjs).
 * Kill switch: AUDIT_REMEDIATION_RECONCILE_ENABLED=false.
 *
 * Usage:
 *   node scripts/remediation-reconcile.mjs                    # dry-run report
 *   node scripts/remediation-reconcile.mjs --apply             # verify + write
 *   node scripts/remediation-reconcile.mjs --apply --cap 5      # bound to 5 files
 *   node scripts/remediation-reconcile.mjs --apply --model latest-sonnet
 *
 * @module scripts/remediation-reconcile
 */
import './lib/load-env.mjs';
import { assertKnownFlags, emit } from './lib/cli-io.mjs';
import { isCloudEnabled, resolveRepoForStore } from './lib/store/repo.mjs';
import { getStaleAcceptedFindingsForVerification, countStaleAcceptedFindingsForVerification } from './lib/store/plans-ship.mjs';
import { applyRemediationVerificationResults, initLearningStore } from './learning-store.mjs';
import { createAnthropicClient, isClaudeAvailable } from './lib/anthropic-client.mjs';
import { resolveModel } from './lib/model-resolver.mjs';
import { gitCommitSha } from './lib/vcs.mjs';
import {
  selectFindingsNeedingCheck, groupByFile, buildFileChangeStateFn, buildSensitivePathPredicate,
  readCurrentFileForVerification, readDiffForVerification, callVerifier, planWriteActions, mechanicalResolvedAction,
} from './lib/remediation-verification.mjs';

export const KNOWN_FLAGS = Object.freeze(['--selfcheck-relocation', '--apply', '--cap', '--model']);

const G = '\x1b[32m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const arg = (argv, n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

// No `--cap` means UNCAPPED (bounded only by ROW_FETCH_LIMIT below), not some
// hidden default — the two call sites make opposite choices on purpose: /ship
// Step 0.5e passes an explicit small `--cap` (it pays this in wall-clock and $
// on every push), the weekly-maintenance entry passes none (a periodic
// cadence already bounds total spend, and the whole point of that path is
// full-backlog convergence).
/** How many rows to fetch as raw material for grouping-by-file, which --cap (in files) then slices. */
const ROW_FETCH_LIMIT = 200;

async function main() {
  const argv = process.argv;
  if (argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'remediation-reconcile' });

  const apply = argv.includes('--apply');
  const rawCap = Number(arg(argv, '--cap', ''));
  const cap = Number.isFinite(rawCap) && rawCap > 0 ? Math.floor(rawCap) : Infinity;
  const model = resolveModel(arg(argv, '--model', process.env.AUDIT_REMEDIATION_RECONCILE_MODEL || 'latest-sonnet'));
  const log = (m) => process.stderr.write(`${m}\n`);

  if (process.env.AUDIT_REMEDIATION_RECONCILE_ENABLED === 'false') {
    emit({ ok: true, cloud: null, enabled: false, reason: 'AUDIT_REMEDIATION_RECONCILE_ENABLED=false' });
    return;
  }

  await initLearningStore();
  if (!await isCloudEnabled()) {
    emit({ ok: true, cloud: false, reason: 'AUDIT_DB_URL unset — nothing to reconcile without the store' });
    return;
  }

  const repoRoot = process.cwd();
  const repo = await resolveRepoForStore({ cwd: repoRoot });
  if (!repo) {
    emit({ ok: false, cloud: true, reason: 'could not resolve this repo in the audit store — run any /audit-code once first' });
    return;
  }
  const repoId = repo.repoRowId;

  const headSha = gitCommitSha(repoRoot);
  if (!headSha.ok) {
    emit({ ok: false, cloud: true, reason: `could not resolve HEAD: ${headSha.error.message}` });
    return;
  }

  const [rows, eligible] = await Promise.all([
    getStaleAcceptedFindingsForVerification(repoId, { limit: ROW_FETCH_LIMIT }),
    countStaleAcceptedFindingsForVerification(repoId),
  ]);

  const fileState = buildFileChangeStateFn(repoRoot);
  const isSensitivePath = buildSensitivePathPredicate(repoRoot);
  const { needsLlmCheck, mechanicallyResolved, sensitivePathSkipped, skipped } =
    selectFindingsNeedingCheck(rows, fileState, isSensitivePath);

  const grouped = groupByFile(needsLlmCheck).slice(0, cap);
  const notExamined = groupByFile(needsLlmCheck).length - grouped.length;

  log(`${B}remediation-reconcile${X} — ${repo.name}: ${eligible} eligible (fetched ${rows.length}), `
    + `${mechanicallyResolved.length} mechanically resolved, ${grouped.length} file(s) to verify `
    + `(${sensitivePathSkipped.length} sensitive-path skipped, ${skipped.length} unchanged/unresolvable), `
    + `${apply ? Y + 'APPLY' + X : Y + 'DRY-RUN' + X}`);
  if (notExamined > 0) log(`  ${Y}${notExamined} more changed file(s) NOT examined this run${X} — raise --cap or re-run (never-checked-first order makes progress across runs)`);

  const actions = mechanicallyResolved.map((row) => mechanicalResolvedAction(row, headSha.sha));

  let resolvedCount = 0, stillPresentCount = 0, uncertainCount = 0, providerFailures = 0, skippedNoCredential = false;

  if (grouped.length > 0) {
    if (!await isClaudeAvailable()) {
      skippedNoCredential = true;
      log(`  ${Y}no Claude credential available — skipping ${grouped.length} file(s) needing LLM verification${X}`);
    } else {
      const client = await createAnthropicClient({ backend: 'sdk' }); // pinned: forced tool_choice needs 'sdk', never the ambient CLAUDE_BACKEND
      for (const { file, findings } of grouped) {
        const sinceCommit = findings[0].remediation_last_checked_commit || findings[0].accepted_at_commit;
        const current = readCurrentFileForVerification(repoRoot, file);
        const diff = readDiffForVerification(repoRoot, sinceCommit);
        const result = await callVerifier({
          client, model, file, findings,
          diffText: diff.diffText,
          currentContent: current.exists ? current.content : null,
          truncated: diff.truncated || current.truncated || !current.exists,
        });
        if (!result.ok) { providerFailures += 1; log(`  ${Y}[${file}] verifier call failed: ${result.error}${X}`); }
        const fileActions = planWriteActions(findings, result.verdicts, headSha.sha);
        for (const a of fileActions) {
          if (a.outcome === 'resolved') resolvedCount += 1;
          else if (a.outcome === 'still-present') stillPresentCount += 1;
          else uncertainCount += 1;
        }
        actions.push(...fileActions);
      }
    }
  }
  resolvedCount += mechanicallyResolved.length;

  console.log(`\n${B}Verdicts:${X} ${G}${resolvedCount} resolved${X}, ${stillPresentCount} still-present, `
    + `${uncertainCount} uncertain${providerFailures > 0 ? `, ${Y}${providerFailures} provider failure(s)${X}` : ''}`);

  if (!apply) {
    emit({
      ok: true, cloud: true, applied: false, repo: repo.name, eligible, examined: grouped.length, notExamined,
      resolved: resolvedCount, stillPresent: stillPresentCount, uncertain: uncertainCount,
      mechanicallyResolved: mechanicallyResolved.length, sensitivePathSkipped: sensitivePathSkipped.length,
      providerFailures, skippedNoCredential,
    });
    console.log(`\n${Y}DRY-RUN${X} — no findings written. Re-run with ${B}--apply${X} to project ${actions.length} verdict(s).`);
    return;
  }

  const { updated, attempted } = await applyRemediationVerificationResults(repoId, actions);
  console.log(`\n${G}Applied${X}: ${updated}/${attempted} verdict(s) projected to the store.`);
  emit({
    ok: true, cloud: true, applied: true, repo: repo.name, eligible, examined: grouped.length, notExamined,
    resolved: resolvedCount, stillPresent: stillPresentCount, uncertain: uncertainCount,
    mechanicallyResolved: mechanicallyResolved.length, sensitivePathSkipped: sensitivePathSkipped.length,
    providerFailures, skippedNoCredential, updated, attempted,
  });
}

main().catch((err) => {
  if (err?.code === 'ARGV_ERROR') { process.stderr.write(`remediation-reconcile: ${err.message}\n`); process.exit(2); }
  process.stderr.write(`remediation-reconcile: fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
