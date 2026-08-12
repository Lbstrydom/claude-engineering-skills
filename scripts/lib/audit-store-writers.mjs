/**
 * @fileoverview The audit-store writer registrations — the registry's ONLY
 * bootstrap.
 *
 * Plan: `docs/plans/audit-store-write-durability.md`, Phase 3 (decision 1b).
 *
 * **Why this module exists at all.** The registry in `durable-write.mjs` is
 * process-local. The plan's first draft put the `registerWriter` calls in
 * `legacy-production-audit.mjs`, and the audit caught the contradiction: the
 * operator drain (`cross-skill.mjs write-spill drain`) runs in a FRESH process
 * that never loads the orchestrator, so it would have found zero handlers and
 * quarantined every artifact it was asked to replay. Registrations therefore
 * live here, and both the orchestrator and the CLI import this one module.
 *
 * **`replay` IS the live write path.** Each handler below is what
 * `durableWrite` awaits live *and* what a later drain calls on the spilled
 * payload — one code path, so a replay cannot drift from the write it is
 * replaying. That is also why the payloads are plain data: a spilled artifact is
 * read back by a different process, and a closure cannot be serialised.
 *
 * **Which writers may be replayed.** Only a writer that declares a `rowKey`,
 * because at-least-once replay against a non-idempotent writer would corrupt the
 * very rows this exists to protect. Today that is `audit.findings` (arbitrated
 * by the `(run_id, finding_fingerprint)` unique index, migration 20260812070000)
 * and `audit.runComplete` (an UPDATE keyed on `run_id`, idempotent by
 * construction). The other three are `lost`-only in v1: they gain a counted,
 * surfaced failure without a replay path nobody has designed. Adding one later
 * is a `rowKey` here plus its constraint — not a change to `durableWrite`.
 *
 * @module scripts/lib/audit-store-writers
 */

import { registerWriter, registeredWriters } from './durable-write.mjs';
import {
  recordFindings, recordPassStats, recordSuppressionEvents, recordRunComplete,
} from './store/runs-findings.mjs';
import { syncBanditArms, syncFalsePositivePatterns } from './store/bandit-fp.mjs';

/**
 * Turn a store receipt into a `durableWrite` result.
 *
 * The store functions swallow their own errors (findings telemetry must never
 * fail an audit) and report `{applied, rows, reason?, error?}`. The durability
 * seam needs the opposite for a FAILED write: the error has to reach
 * `isConnectionScoped` / `normalizePostgresError`, which classify on
 * `err.code`, so that a store outage aborts the drain while a poison row
 * quarantines. Rethrowing the ORIGINAL error object — never a stringified copy —
 * is what preserves that.
 *
 * A receipt with `applied: false` and no error is NOT thrown: nothing is wrong
 * with the artifact. Two sub-cases, and they must not share an outcome:
 *
 *  - DECLINED — the store is off, or there is no pool. Nothing was attempted, so
 *    the write did not fail; `declined: true` maps it to `skipped`, which keeps
 *    a local-only run from filing every write as `lost` and reporting itself
 *    `incomplete`. This is the supported degraded mode, not a fault.
 *  - NOT APPLIED — the write was attempted and did not land (`run-row-absent`).
 *    That IS a failure of this write, and it keeps the normal spilled/lost
 *    treatment so the artifact survives for the next drain.
 */
const DECLINED_REASONS = new Set(['cloud-off', 'no-pool', 'no-run-id']);

async function receipt(promise) {
  const r = await promise;
  if (r?.error) throw r.error;
  const applied = r?.applied === true;
  return {
    applied,
    rows: r?.rows ?? 0,
    reason: r?.reason,
    declined: !applied && DECLINED_REASONS.has(r?.reason),
  };
}

let _registered = false;

/**
 * Populate the registry. Idempotent — safe to call from every entry point, and
 * called once at module load so a bare `import` is enough (the plan's contract:
 * "the registry is populated by importing that one module").
 */
export function registerAuditStoreWriters() {
  if (_registered) return registeredWriters();
  _registered = true;

  // ── audit.findings ────────────────────────────────────────────────────────
  // The only batch writer with a real idempotency key, and the reason Phase 1
  // shipped a migration. `rowKey` is PER ROW, not per payload: the payload is a
  // whole batch, so a payload-level key would evaluate to one value for every
  // spilled batch and an upsert would overwrite unrelated findings (the plan's
  // Gemini R2 HIGH).
  //
  // Be precise about what this function DOES, because the honest answer is
  // narrower than it looks: `durableWrite` reads its PRESENCE (that is what
  // makes this writer spill-eligible) and never invokes it. The idempotency it
  // declares is enforced by the database — `audit_findings_run_fingerprint_uniq_full`
  // — and applied by `recordFindings`'s upsert and its intra-batch collapse,
  // neither of which calls back into here. So this is a DECLARATION of the key,
  // not the mechanism that applies it. `tests/audit-store-durability-call-site.test.mjs`
  // pins it to the same column tuple as the index so the declaration and the
  // constraint cannot drift apart silently.
  registerWriter('audit.findings', {
    schemaVersion: 1,
    rowKey: (row) => `${row.run_id}:${row.finding_fingerprint}`,
    replay: (payload) => receipt(
      recordFindings(payload.runId, payload.findings, payload.passName, payload.round),
    ),
  });

  // ── audit.runComplete ─────────────────────────────────────────────────────
  // Keyed on the run row itself. Spill-eligible because a LOST completion write
  // does not leave a neutral row — it leaves a WRONG one: the run stays at its
  // `recordRunStart` values, so a finished run is indistinguishable from one
  // still executing. That is a second false zero inside the mechanism added to
  // report the first, which is why the completion write is not exempt from the
  // contract it records.
  registerWriter('audit.runComplete', {
    schemaVersion: 1,
    rowKey: (row) => `${row.run_id}`,
    replay: (payload) => receipt(recordRunComplete(payload.runId, payload.stats)),
  });

  // ── audit.passStats ───────────────────────────────────────────────────────
  // No key: `audit_pass_stats` is an append-only INSERT with no unique
  // constraint, so a replay would double-count the very telemetry the A/B
  // stopping rules read. `lost`-only is the honest v1.
  registerWriter('audit.passStats', {
    schemaVersion: 1,
    replay: (payload) => receipt(
      recordPassStats(payload.runId, payload.passName, payload.stats, payload.round),
    ),
  });

  // ── audit.suppressionEvents ───────────────────────────────────────────────
  // Same shape, same reason: a plain multi-row INSERT into `suppression_events`.
  registerWriter('audit.suppressionEvents', {
    schemaVersion: 1,
    replay: (payload) => receipt(
      recordSuppressionEvents(payload.runId, payload.suppressionResult),
    ),
  });

  // ── learning.banditArms ───────────────────────────────────────────────────
  // This one IS idempotent at the database (it upserts on
  // `(pass_name, variant_id, context_bucket)`), and is still deliberately
  // keyless here: the payload is a snapshot of live bandit state with no
  // run scope, so replaying a stale snapshot hours later would overwrite newer
  // arm statistics with older ones. "Idempotent" is not "safe to replay late" —
  // the two questions are different, and only the second one licenses a spill.
  registerWriter('learning.banditArms', {
    schemaVersion: 1,
    replay: (payload) => receipt(syncBanditArms(payload.arms)),
  });

  // ── learning.fpPatterns ───────────────────────────────────────────────────
  // The FIFTH fire-and-forget write in the orchestrator's cloud block, which
  // the plan's own trace missed and the Cluster B audit caught (H4/M12). It was
  // `.catch(log)` with no await inside `writeLearningState`, so the pool's
  // `allowExitOnIdle: true` could kill it in flight — the exact mechanism that
  // left 25/25 code runs with un-updated completion rows in July.
  //
  // In scope by IMPACT, not authorship: decision 6 says every audit-store write
  // in that block goes through the seam, and shipping "the writes are no longer
  // fire-and-forget" while one still is would be the claim this plan exists to
  // stop. Keyless — the local FP tracker file IS the durable copy and a stale
  // dirty subset replayed later would overwrite newer patterns. Registering it
  // keyless buys exactly what it needs: an await, a counted outcome, and a
  // guarantee it is never replayed.
  registerWriter('learning.fpPatterns', {
    schemaVersion: 1,
    replay: (payload) => receipt(syncFalsePositivePatterns(payload.repoId, payload.patterns)),
  });

  return registeredWriters();
}

// Side-effecting import, deliberately: the plan's bootstrap contract is that
// importing this module populates the registry. The function above stays
// exported so a test can assert idempotency and a caller can be explicit.
registerAuditStoreWriters();
