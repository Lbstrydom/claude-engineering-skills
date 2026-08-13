/**
 * @fileoverview Plans-domain registry commands (docs/plans/cross-skill-command-registry.md
 * — Cluster B, Phase 3; `plan-satisfaction` joins in Phase 4).
 *
 * Behaviour-preserving moves of the legacy handlers: same envelope fields,
 * same refusal codes and exit codes, same ordering of store-touching
 * operations. Persistence goes through `ctx.deps` only.
 */
import { CommandError } from '../dispatch.mjs';

/**
 * `upsert-plan` — register a plan artefact, return its UUID.
 *
 * Moved from `cmdUpsertPlan`. The store's discriminated reasons keep their
 * legacy mapping: `write-failed` → PLAN_WRITE_FAILED, `invalid-input` →
 * BAD_INPUT (a caller bug on a command line someone typed). A skill that saw
 * `{ok:true, planId:null}` proceeded as though the plan simply was not
 * registered — the reading that made an outage invisible.
 */
export async function upsertPlanCmd(ctx) {
  const p = ctx.payload();
  if (!p.path || !p.skill) throw new CommandError('BAD_INPUT', 'path and skill are required');
  if (!ctx.cloud.enabled) return { ...ctx.degrade(), planId: null };
  const scope = await ctx.resolveScope();
  const repoId = scope.kind === 'scoped' ? scope.repoId : null;
  const res = await ctx.deps.upsertPlan(repoId, {
    path: p.path,
    skill: p.skill,
    status: p.status,
    principlesCited: p.principlesCited,
    focusAreas: p.focusAreas,
    commitSha: p.commitSha || ctx.git.commitSha(),
    checksum: p.checksum,
  });
  if (!res.ok && res.reason === 'write-failed') {
    throw new CommandError('PLAN_WRITE_FAILED', res.message, { cloud: true });
  }
  if (!res.ok && res.reason === 'invalid-input') {
    throw new CommandError('BAD_INPUT', res.message, { cloud: true });
  }
  // Any OTHER `!res.ok` is still a failure (audit CB-r4). Mapping only the two
  // reasons known TODAY meant a reason added later fell through to
  // `{ok:false, planId:null}` at exit 0 — the store would grow a new failure
  // mode and this command would silently start reporting it as a non-event.
  // Closed-set handling, so the fall-through cannot exist.
  if (!res.ok) {
    throw new CommandError('PLAN_WRITE_FAILED',
      `upsertPlan failed with an unhandled reason "${res.reason ?? 'unknown'}"${res.message ? `: ${res.message}` : ''}`,
      { cloud: true, reason: res.reason ?? null });
  }
  // An `ok:true` receipt carrying no id is a MALFORMED receipt, not a
  // successful write (audit CC-r1). Without this, a store regression that
  // returned `{ok:true, planId:null}` would surface as `ok:false` at exit 0 —
  // re-creating the exact shape this handler just closed, one field over.
  if (!res.planId) {
    throw new CommandError('PLAN_WRITE_UNVERIFIED',
      'upsertPlan reported success but returned no planId — refusing to report a write it cannot evidence',
      { cloud: true });
  }
  const planId = res.planId;
  // Deterministic arm-eval capture (toggle-gated; detached) — fires when the
  // plan skill includes the original task text in this upsert payload, so
  // capture is part of PERSISTING the plan rather than a skippable trailing
  // step. No-op when the per-repo toggle is off.
  if (p.taskText && String(p.taskText).trim()) {
    try {
      const { maybeFireArmEvalCaptureDetached } = await import('../../arm-eval/capture-trigger.mjs');
      maybeFireArmEvalCaptureDetached({ experimentType: 'plan-authoring', task: p.taskText });
    } catch { /* never block plan persistence on capture */ }
  }
  // Every `!res.ok` now throws, so this is unconditionally a success — the
  // softFail exemption this entry used to need is GONE (audit CB-r4). Kept as
  // `ok: !!planId` only to preserve the field shape a skill reads.
  return { ok: !!planId, cloud: true, planId };
}

/**
 * `update-plan-status` — set a plan's lifecycle status.
 *
 * Moved from `cmdUpdatePlanStatus`. `path` is the ergonomic entry point (a
 * human deciding a plan is done knows the path, not the UUID). Scope resolves
 * on BOTH entry paths — supplying an explicit `planId` used to skip scoping
 * entirely, so the UPDATE could land on another repo's plan row.
 */
export async function updatePlanStatusCmd(ctx) {
  const p = ctx.payload();
  if (!p.planId && !p.path) {
    throw new CommandError('BAD_INPUT', 'one of planId or path is required (path is usually what you know)');
  }
  if (!p.status) throw new CommandError('BAD_INPUT', 'status is required');
  if (!ctx.cloud.enabled) return ctx.degrade();

  let planId = p.planId;
  let resolvedPath = null;
  const scope = await ctx.resolveScope();
  const repoId = scope.kind === 'scoped' ? scope.repoId : null;
  if (!planId) {
    const found = await ctx.deps.getPlanIdByPath(repoId, p.path);
    if (!found.ok) {
      // `not-found` (the plan really is not registered) and `lookup-failed`
      // (the store could not be queried) are different facts that used to
      // arrive under one label — a store outage read as "run the /plan flow
      // first" and invited a duplicate registration.
      const code = found.reason === 'lookup-failed' ? 'PLAN_LOOKUP_FAILED' : 'PLAN_NOT_RESOLVED';
      throw new CommandError(code, found.message, { reason: found.reason ?? null }, 1);
    }
    planId = found.planId;
    resolvedPath = found.path;
  }

  // Report the STORE's answer, not a blanket ok: rowCount 0 means a stale id,
  // an invalid status, or a plan owned by a different repo.
  const res = await ctx.deps.updatePlanStatus({ repoId, planId, status: p.status });
  if (!res.ok) {
    throw new CommandError('STATUS_NOT_UPDATED',
      `no row updated for planId=${planId} — stale id, invalid status, or the plan belongs to another repo`,
      { reason: res.reason ?? null }, 1);
  }
  return { ok: true, cloud: true, planId, path: resolvedPath, status: p.status };
}

/**
 * `finalize-outcomes` — deterministic outcome capture after an audit converges.
 *
 * The orchestrator calls this ONCE with the unified `--run-id`, the final
 * adjudicated `--ledger` and the final-round `--result`. It joins ledger →
 * findings by fingerprint, drives the shared outcome sync, then reconciles:
 * any finding the ledger never adjudicated is flagged `needs_triage`, never
 * silently dark-dropped.
 *
 * Idempotent by construction — the underlying writes set state by
 * (run_id, fingerprint) / delete+insert, so a retry after a crash converges.
 */
export async function finalizeOutcomesCmd(ctx) {
  const { readFileSync } = await import('node:fs');
  const { finalizeRoundOutcomes } = await import('../../finalize-outcomes.mjs');
  const { isControlMarkerDetail } = await import('../../audit/control-markers.mjs');
  const { semanticId } = await import('../../findings.mjs');
  const { dbConfig } = await import('../../config.mjs');

  const runId = ctx.flag('run-id');
  const ledgerPath = ctx.flag('ledger');
  const resultPath = ctx.flag('result');
  const roundOpt = ctx.flag('round');
  if (!runId || !ledgerPath || !resultPath) {
    throw new CommandError('BAD_INPUT', '--run-id <id> --ledger <path> --result <path> are all required');
  }

  let result; let ledgerRaw;
  try { result = JSON.parse(readFileSync(resultPath, 'utf8')); }
  catch (e) { throw new CommandError('BAD_INPUT', `cannot read --result (${resultPath}): ${e.message}`); }
  try { ledgerRaw = JSON.parse(readFileSync(ledgerPath, 'utf8')); }
  catch (e) { throw new CommandError('BAD_INPUT', `cannot read --ledger (${ledgerPath}): ${e.message}`); }

  if (!result || typeof result !== 'object' || !Array.isArray(result.findings)) {
    throw new CommandError('BAD_INPUT', 'result file must be an object with a "findings" array');
  }
  // Ledger is { entries: [...] }; tolerate a bare array (matches write-code-outcomes).
  const ledger = Array.isArray(ledgerRaw) ? { entries: ledgerRaw } : ledgerRaw;
  if (!ledger || !Array.isArray(ledger.entries)) {
    throw new CommandError('BAD_INPUT', 'ledger file must have an "entries" array');
  }
  // A SUPPLIED --round must be a positive integer. `Number.isInteger` alone
  // accepted 0 and negatives, so `--round 0` finalised round 0 — the outcome
  // the null-coercion fix was written to prevent, reached by another input.
  // An invalid supplied value is REFUSED, never quietly swapped for
  // result.round: silently finalising a different round than the operator
  // named is worse than stopping.
  const roundArg = roundOpt == null ? null : Number(roundOpt);
  if (roundArg !== null && (!Number.isInteger(roundArg) || roundArg < 1)) {
    throw new CommandError('BAD_INPUT',
      `--round must be a positive integer, got "${roundOpt}" — refusing rather than finalising a different round`);
  }
  const round = roundArg ?? (result.round || 1);

  if (!ctx.cloud.enabled) {
    // Cloud off → local-only no-op. `isCloudEnabled()` swallows
    // pool-construction failures, so "no DSN configured" and "DSN configured,
    // server unreachable" arrive identically. Both degrade to the local write —
    // that is the graceful degradation this branch exists for — but they are
    // NOT the same event, and reporting the second as the first told operators
    // their config was missing when their database was merely down.
    const configured = Boolean(dbConfig.url);
    const status = await finalizeRoundOutcomes({ result, ledger, round, store: null, sid: null });
    return {
      ok: true, cloud: false, degraded: configured, runId: null, round,
      labelled: status.labelled, total: status.total, needsTriage: 0, autoDismissed: 0,
      reason: configured ? 'store-unreachable' : 'not-configured',
      hint: configured
        ? 'AUDIT_DB_URL is SET but the store was unreachable — captured locally only, so these outcomes are NOT in the cloud store. Fix connectivity and re-run to finalize this round.'
        : 'AUDIT_DB_URL unset — local-only capture; run npm run setup:cloud to enable cloud finalize',
    };
  }

  // Tri-state: null means the PROBE failed. Reporting that as UNKNOWN_RUN
  // blamed the operator's --run-id for the store being unreachable.
  const runExists = await ctx.deps.auditRunExists(runId);
  if (runExists === null) {
    throw new CommandError('STORE_UNAVAILABLE',
      `cannot verify run_id ${runId}: AUDIT_DB_URL is configured but the store could not be queried. Not treating this as an unknown run — fix connectivity and re-run.`);
  }
  if (!runExists) {
    throw new CommandError('UNKNOWN_RUN',
      `run_id ${runId} not found in audit_runs (cloud is configured) — was --run-id threaded correctly?`);
  }

  const store = {
    recordAdjudicationEvent: ctx.deps.recordAdjudicationEvent,
    updatePassStatsPostDeliberation: ctx.deps.updatePassStatsPostDeliberation,
    updateRunMeta: ctx.deps.updateRunMeta,
  };
  const status = await finalizeRoundOutcomes(
    { result: { ...result, _cloudRunId: runId }, ledger, round, store, sid: runId },
  );
  const { enriched, cloudOk, needsTriage, autoDismissed } = status;
  // Control-marker findings (e.g. ADJACENCY_INCOMPLETE) route to
  // auto_dismissed, not needs_triage — excluded from the echoed list so it
  // doesn't claim a human must look at machine-generated coverage noise.
  const pending = enriched.filter((f) => f.adjudicationOutcome === 'pending' && !isControlMarkerDetail(f.detail));
  const labelled = status.labelled;
  process.stderr.write(
    `  [finalize-outcomes] run ${runId}: ${labelled}/${result.findings.length} labelled · `
    + `${needsTriage} needs_triage · ${autoDismissed} auto_dismissed · cloud=${cloudOk ? 'ok' : 'failed'}\n`,
  );
  const needsTriageFindings = pending.map((f) => ({
    id: f.id, fingerprint: f._hash || semanticId(f),
    severity: f.severity, section: f.section,
  }));
  // `ok:true` alongside `cloudOk:false` is self-contradictory — the line above
  // has already printed `cloud=failed`, and the whole purpose of this command
  // is to finalise the round INTO the store. The counts travel with the error
  // so the local work is not lost from the report.
  if (!cloudOk) {
    throw new CommandError('CLOUD_FINALIZE_FAILED',
      `run ${runId} round ${round}: outcomes were computed but the cloud write FAILED — `
      + 'this round is not finalised in the store; fix connectivity and re-run (the write is idempotent).',
      {
        cloud: true, cloudOk: false, runId, round,
        labelled, total: result.findings.length, needsTriage, autoDismissed, needsTriageFindings,
      }, 1);
  }
  return {
    ok: true, cloud: true, runId, round,
    labelled, total: result.findings.length, needsTriage, autoDismissed, cloudOk,
    needsTriageFindings,
  };
}

/**
 * `plan-satisfaction` — the /ux-lock verify rollup for one plan (Cluster C).
 *
 * Note the legacy ORDER, preserved deliberately: the cloud-off degrade is
 * checked BEFORE `--plan-id` is validated, so a cloud-off invocation with no
 * plan id degrades rather than refusing. Reordering would be a silent
 * contract change on a path /ship reads.
 */
export async function planSatisfactionCmd(ctx) {
  if (!ctx.cloud.enabled) return { ...ctx.degrade(), row: null, persistentFailures: [] };
  const planId = ctx.flag('plan-id');
  if (!planId) throw new CommandError('BAD_INPUT', '--plan-id is required');
  // Read-path tenancy (2026-08-12). `planId` is an opaque uuid the caller
  // supplies, and these views carry no repo of their own — so an unscoped read
  // returns another repository's satisfaction rollup and this command reports
  // it as THIS repo's. That is the 207-vs-0 shape on the read side. `null` for
  // an unresolvable scope relaxes the tenant match, exactly as on the write
  // side; the plan must still exist either way.
  const scope = await ctx.resolveScope();
  const repoId = scope.kind === 'scoped' ? scope.repoId : null;
  const [row, persistent] = await Promise.all([
    ctx.deps.readPlanSatisfaction(planId, { repoId }),
    ctx.deps.readPersistentPlanFailures(planId, { repoId }),
  ]);
  return { ok: true, cloud: true, scopedTo: repoId, row, persistentFailures: persistent };
}
