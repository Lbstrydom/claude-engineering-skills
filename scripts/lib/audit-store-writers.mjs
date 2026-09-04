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
 * very rows this exists to protect. **The rule is the CONSTRAINT, not a list**:
 * a `rowKey` is legitimate exactly when a real database uniqueness constraint
 * arbitrates it. A writer with no such constraint declares none and is
 * `lost`-only — it gains a counted, surfaced failure without a replay path
 * nobody has designed. Adding one later is a `rowKey` here plus its constraint,
 * never a change to `durableWrite`.
 *
 * Keyed writers as of 2026-09-04, each with the constraint that arbitrates it:
 *   `audit.findings`         — `(run_id, finding_fingerprint)` unique index (20260812070000)
 *   `audit.runComplete`      — UPDATE keyed on `run_id`, idempotent by construction
 *   `audit.convergenceState` — keyed on `run_id`
 *   `audit.diffComplexity`   — keyed on `run_id`
 *   `learning.outcome`       — keyed on `decision_key`
 *   `debt.entries`           — `UNIQUE (repo_id, topic_id)` (see its note below)
 *
 * This paragraph previously named only the first two and called the rest
 * `lost`-only. That went stale as writers were promoted, and the staleness
 * propagated: the requirements extractor lifted it verbatim into
 * `REQ-persistence-7bc1224d`, where it sat `active` with `confidence: high`
 * asserting a two-writer invariant against six in code. Corrected here and in
 * `.requirements/overrides.json` on 2026-09-04. **Keep this list in step with
 * the registrations below** — a stale docstring here becomes a false invariant
 * elsewhere, and the next reader may "restore" it by deleting a `rowKey` that
 * is preventing real data loss.
 *
 * @module scripts/lib/audit-store-writers
 */

import { registerWriter, registeredWriters } from './durable-write.mjs';
import {
  recordFindings, recordPassStats, recordSuppressionEvents, recordRunComplete,
} from './store/runs-findings.mjs';
import { syncBanditArms, syncFalsePositivePatterns } from './store/bandit-fp.mjs';
import {
  recordConvergenceState, recordDiffComplexity, backfillLearningOutcome,
} from './store/learning-decisions.mjs';
import { upsertDebtEntries } from './store/debt.mjs';

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
// `no-pool` is deliberately NOT here (final gate G1). The gate's stated
// mechanism is false — `getPool()` returns null only when no DSN resolves, and
// pool exhaustion THROWS from `pool.query`, reaching the catch as
// `write-failed`. But the classification is unfalsifiable in place (that state
// is barely reachable, so no test can distinguish the two readings) and the two
// errors are not symmetric: calling a real failure a decline DELETES the
// envelope and loses the write, while calling a decline a failure only spills
// an artifact a later drain retires. When a classification cannot be pinned
// down, take the side whose mistake is recoverable.
const DECLINED_REASONS = new Set(['cloud-off', 'no-run-id', 'no-repo-identity']);

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
  // The flag is set at the END, not here (audit 2026-08-13 M15). Setting it
  // first means a throw from any `registerWriter` below leaves `_registered`
  // true over a PARTIAL registry — and every later caller then short-circuits
  // on the guard above and gets that partial registry as if it were complete.
  // The failure surfaces later and elsewhere, as `durableWrite` throwing
  // "unregistered id" for a writer whose registration merely never ran, or as
  // a drain quarantining artifacts it should have replayed. An exception here
  // must leave the registry visibly UNinitialised so the next call retries.

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
  // declares is enforced by the database — `audit_findings_run_fingerprint_pass_uniq`
  // — and applied by `recordFindings`'s upsert and its intra-batch collapse,
  // neither of which calls back into here. So this is a DECLARATION of the key,
  // not the mechanism that applies it. `tests/audit-store-durability-call-site.test.mjs`
  // pins it to the same column tuple as the index so the declaration and the
  // constraint cannot drift apart silently.
  //
  // Includes `pass_name` (added 20260812090000, fixing a defect the 2-column
  // version introduced): this writer's own payload always carries
  // `passName: 'merged'`, so the third column never changes VALUE for it — but
  // the DB constraint the row-identity claims to describe now has three
  // columns, and the declaration must say so or the two drift apart the exact
  // way a prior session incident (INC in AGENTS.md's prose↔code seam section)
  // warns about.
  registerWriter('audit.findings', {
    schemaVersion: 1,
    rowKey: (row) => `${row.run_id}:${row.finding_fingerprint}:${row.pass_name}`,
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

  // ── audit.convergenceState ────────────────────────────────────────────────
  // NOT telemetry, despite sitting beside some. This write carries
  // `audited_sha` / `audited_tree`, and `recordConvergenceState`'s own docstring
  // says why they exist: the local `.audit/last-audit-run.json` marker "is a
  // file anyone could hand-author", so the store's pipeline-written copy "is
  // what makes a forged marker detectable". Losing it silently does not break
  // `AI-Gate: passed` (the commit trailer is the self-verifying record), but it
  // removes the cross-check that could CONVICT a forged one — and removes it
  // without saying so.
  //
  // Keyed and spill-eligible for the same reason `audit.runComplete` above is:
  // an idempotent `UPDATE audit_runs … WHERE id = $runId` against a primary key.
  // These two are structurally the same write; treating one as durable and the
  // other as fire-and-forget was an accident of which plan traced which.
  registerWriter('audit.convergenceState', {
    schemaVersion: 1,
    rowKey: (row) => `${row.run_id}`,
    replay: (payload) => receipt(recordConvergenceState(payload.runId, payload.state)),
  });

  // ── audit.diffComplexity ──────────────────────────────────────────────────
  // Genuine telemetry — but the SAME table, the SAME key and the same
  // idempotent UPDATE as the two writers above, so `lost`-only would be a
  // distinction without a difference. The real `lost`-only case is
  // `audit.passStats` below: an append-only INSERT with no unique constraint,
  // where a replay double-counts. Idempotency is the test, not importance.
  registerWriter('audit.diffComplexity', {
    schemaVersion: 1,
    rowKey: (row) => `${row.run_id}`,
    replay: (payload) => receipt(recordDiffComplexity(payload.runId, payload.complexity)),
  });

  // ── learning.outcome ──────────────────────────────────────────────────────
  // The outcome LABEL for a learning decision. Losing these silently is not
  // hypothetical here: audit effectiveness was unmeasurable for a stretch
  // precisely because outcome labels stopped arriving and nothing counted the
  // absence. Idempotent UPDATE keyed on `decision_key`, so a replay re-applies
  // the same label rather than appending a second one.
  registerWriter('learning.outcome', {
    schemaVersion: 1,
    rowKey: (row) => `${row.decision_key}`,
    replay: (payload) => receipt(backfillLearningOutcome({
      decisionKey: payload.decisionKey, outcome: payload.outcome,
    })),
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

  // ── debt.entries ───────────────────────────────────────────────────────────
  // Step 3.6's cloud mirror of `.audit/tech-debt.json` — `debt-auto-capture.mjs`'s
  // `syncToCloud`. Was `lost`-only (an un-registered, fire-and-forget call to
  // `upsertDebtEntries`) on the theory, recorded in
  // `tests/audit-store-durability-call-site.test.mjs`, that `debt_entries` is
  // "recomputed from the findings that produced it on every audit run" — true
  // only for a deferral that gets RE-raised. A one-off deferral, captured once
  // and never revisited, gets exactly one chance to sync; a transient upsert
  // failure on that one chance was permanent. Reproduced in a consumer
  // 2026-08-27: local `tech-debt.json` at 228 entries, cloud mirror at 197 — 31
  // captured locally that never landed in the store, with nothing to retry them.
  // Idempotent on `(repo_id, topic_id)` (the same constraint `upsertDebtEntries`
  // upserts against via `ON CONFLICT`), so it is safely replayable.
  //
  // `upsertDebtEntries` predates the `{applied, reason, error}` shape `receipt()`
  // expects — it returns `{ok, reason?, error?}` (see its own docstring) — so
  // this writer maps it directly rather than through `receipt()`. `reason` is
  // set exactly when `ok:true` reflects nothing attempted ('no-op' | 'cloud-off'),
  // which durableWrite must read as `declined`, not `applied` — conflating the
  // two would mark a cloud-off run's envelope `written` and delete it, so the
  // deferral is never retried once the store comes back.
  registerWriter('debt.entries', {
    schemaVersion: 1,
    rowKey: (row) => `${row.repo_id}:${row.topic_id}`,
    replay: async (payload) => {
      const r = await upsertDebtEntries(payload.repoId, payload.entries);
      if (r.error) throw r.error; // original Error object — isConnectionScoped needs err.code
      if (r.reason) return { applied: false, declined: true, reason: r.reason };
      return { applied: true };
    },
  });

  _registered = true;
  return registeredWriters();
}

// Side-effecting import, deliberately: the plan's bootstrap contract is that
// importing this module populates the registry. The function above stays
// exported so a test can assert idempotency and a caller can be explicit.
registerAuditStoreWriters();
