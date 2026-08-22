/**
 * @fileoverview `regression_specs` + `regression_spec_runs` — the /ux-lock
 * write path.
 *
 * Split out of `plans-ship.mjs` (cross-skill-command-registry Phase 6). That
 * module is now a re-export barrel and remains the import name every consumer
 * uses; this file is where the regression-spec domain actually lives.
 *
 * **The upsert arbiters here are PARTIAL indexes**, so every branch must send a
 * `conflictWhere` matching one — Postgres cannot infer a partial index without
 * it and raises 42P10, which the writer's catch would turn into "recorded
 * nothing, silently". `tests/regression-spec-multi-finding-lock.test.mjs`
 * statically asserts the literal conflict targets in this file for that reason.
 *
 * @module scripts/lib/store/regression-specs
 */

import path from 'node:path';
import { isCloudEnabled } from './repo.mjs';
import { one, upsert } from '../db/query.mjs';
import { runWindowCountQuery } from './window-count-query.mjs';
import { buildOwnedInsert, classifyOwnedWrite } from './ownership.mjs';

// ── regression_specs ───────────────────────────────────────────────────────

/**
 * Record a regression spec authored by /ux-lock. Every row upserts by
 * (repo_id, spec_path); `unit-test` additionally discriminates on
 * source_finding_id.
 *
 * The 'persona-consistency-candidate' kind was RETIRED 2026-08-11 along with
 * the promotion path — a candidate row was an un-materialised spec, and
 * nothing consumes them now. `persona-consistency-locked` rows (already
 * promoted, spec on disk) are untouched and still redact their JSONB columns.
 *
 * Pre-egress redaction applies to the three JSONB columns (witness_snapshot,
 * contradiction_payload, journey_context) on locked rows (Gemini-R6-G3).
 *
 * **Returns a discriminated result** (plan §2b F2, 2026-08-12). It returned a
 * bare `null` for EIGHT distinct causes — cloud-off, five separate input
 * refusals, an upsert that returned no row, and a caught DB failure — and its
 * CLI caller wrote `ok: !!specId`, so a store outage and a missing description
 * were the same envelope. Cloud-off is `{ok:false, cloud:false, reason:'cloud-off'}`
 * so a caller can report a supported mode as such rather than as a failure.
 *
 * @returns {Promise<{ok:true, cloud:boolean, specId:string}
 *          |{ok:false, cloud:boolean, specId:null,
 *            reason:'cloud-off'|'invalid-input'|'retired-kind'|'write-failed',
 *            message:string, error?:Error}>}
 */
export async function recordRegressionSpec(repoId, spec) {
  if (!await isCloudEnabled()) {
    return { ok: false, cloud: false, specId: null, reason: 'cloud-off', message: 'cloud store is disabled' };
  }
  if (!spec?.sourceKind) {
    return { ok: false, cloud: true, specId: null, reason: 'invalid-input', message: 'recordRegressionSpec requires spec.sourceKind' };
  }
  // RETIRED 2026-08-11: refuse the candidate kind outright rather than let it
  // fall through to the spec_path branch, where it would be rejected for a
  // MISLEADING reason ("spec_path is required") on a stale consumer still
  // running the old runner. Name what actually happened.
  if (spec.sourceKind === 'persona-consistency-candidate') {
    process.stderr.write(
      '  [learning] recordRegressionSpec: source_kind persona-consistency-candidate '
      + 'was retired 2026-08-11 with the promotion path; re-sync the bundle '
      + '(npm run sync) — this row was NOT written\n',
    );
    return { ok: false, cloud: true, specId: null, reason: 'retired-kind', message: 'source_kind persona-consistency-candidate was retired 2026-08-11 with the promotion path — re-sync the bundle (npm run sync)' };
  }
  if (!spec.specPath) {
    process.stderr.write('  [learning] recordRegressionSpec: spec_path is required\n');
    return { ok: false, cloud: true, specId: null, reason: 'invalid-input', message: 'spec_path is required' };
  }
  if (!repoId) {
    // The (repo_id, spec_path) unique constraint is a FULL index; a NULL
    // repo_id is distinct from every other NULL in Postgres, so the upsert
    // would silently INSERT a duplicate on every re-run instead of updating.
    // Refuse rather than accrue dupes.
    process.stderr.write('  [learning] recordRegressionSpec: rows require a resolved repoId (NULL would duplicate on the (repo_id, spec_path) unique index)\n');
    return { ok: false, cloud: true, specId: null, reason: 'invalid-input', message: 'rows require a resolved repoId (a NULL would duplicate on the (repo_id, spec_path) unique index)' };
  }
  if (spec.sourceKind === 'unit-test' && !spec.sourceFindingId) {
    // A unit-test lock's identity IS the finding it pins: without one the row
    // asserts nothing, and the (repo_id, spec_path, source_finding_id) index
    // could not dedupe it. Refused here rather than left to the CHECK so the
    // caller gets a reason instead of a raised constraint name.
    process.stderr.write('  [learning] recordRegressionSpec: unit-test rows require sourceFindingId — a lock that names no finding pins nothing\n');
    return { ok: false, cloud: true, specId: null, reason: 'invalid-input', message: 'unit-test rows require sourceFindingId — a lock that names no finding pins nothing' };
  }
  if (!spec.description) {
    return { ok: false, cloud: true, specId: null, reason: 'invalid-input', message: 'spec.description is required' };
  }

  const row = {
    repo_id: repoId || null,
    spec_path: spec.specPath ?? null,
    description: spec.description,
    commit_sha: spec.commitSha || null,
    assertion_count: spec.assertionCount || 0,
    dom_contract_types: spec.domContractTypes || [], // jsonb — serialized by the db-layer seam
    source_kind: spec.sourceKind,
    source_finding_id: spec.sourceFindingId || null,
    source_finding_type: spec.sourceFindingType || null,
    updated_at: new Date().toISOString(),
  };
  // WS-C3 manual review (2026-07-19, revised 2026-08-01) — the lint reports
  // this target as `unresolved-conflict-target` because the branch is not
  // statically readable. Reviewed by hand and CORRECT on all three:
  //   - unit-test     → (repo_id, spec_path, source_finding_id)
  //   - everything else → (repo_id, spec_path)
  // `repo_id` is provably non-null on every path — each branch above returns
  // early on a falsy repoId, naming the duplicate-row consequence. No scope
  // column is stored-but-omitted. Left dynamic: collapsing it to literals
  // would need three upsert call sites for one logical write.
  //
  // WHY unit-test carries `source_finding_id` in its key (migration
  // 20260801120000). Under /ux-lock, one spec file pins one fix, so
  // (repo, path) IS the row identity. A unit/integration test routinely covers
  // several findings, so keying on the path alone made each new lock REASSIGN
  // the previous one — the finding silently returned to `unlocked_fixes` while
  // the call still reported `locked:true`. The identity of a unit-test lock is
  // which FINDING the file pins, not the file.
  //
  // Every arbiter is now a PARTIAL unique index, so each needs a `WHERE`
  // matching the index predicate or Postgres cannot infer it (42P10 on every
  // write). Predicates are byte-aligned with the migrations:
  //   unit-test → idx_regression_specs_unit_test_lock        (20260801120000)
  //   other     → idx_regression_specs_path_nonunit          (20260801120000)
  // A total index trivially satisfies any predicate, so these also work
  // against the pre-20260801120000 schema — the migration may lag the code.
  // The candidate arbiter is gone with the promotion path; its index and column
  // are dropped by migration 20260811150000.
  const isUnitTest = spec.sourceKind === 'unit-test';
  let onConflict;
  let conflictWhere;
  if (isUnitTest) {
    onConflict = ['repo_id', 'spec_path', 'source_finding_id'];
    conflictWhere = "source_kind = 'unit-test'";
  } else {
    onConflict = ['repo_id', 'spec_path'];
    conflictWhere = "source_kind <> 'unit-test' AND spec_path IS NOT NULL";
  }
  try {
    const rows = await upsert('regression_specs', [row], {
      onConflict, conflictWhere, update: 'all', returning: ['id'],
    });
    const specId = rows[0]?.id ?? null;
    if (!specId) {
      // Postgres reports success for an upsert that affected nothing, so a
      // missing returned id is an UNVERIFIED write, not an absent spec. Same
      // branch upsertPlan grew in Cluster B, for the same reason.
      const message = 'upsert returned no row — the write did not verify';
      process.stderr.write(`  [learning] recordRegressionSpec: ${message}\n`);
      return { ok: false, cloud: true, specId: null, reason: 'write-failed', message };
    }
    return { ok: true, cloud: true, specId };
  } catch (err) {
    process.stderr.write(`  [learning] recordRegressionSpec failed: ${err.message}\n`);
    return { ok: false, cloud: true, specId: null, reason: 'write-failed', message: err.message, error: err };
  }
}

/**
 * Append a run outcome for a regression spec.
 *
 * Returns a discriminated status rather than `undefined`: this used to swallow
 * every write error to stderr and return nothing, and `cross-skill.mjs`'s
 * `record-regression-spec-run` emitted `{ok:true, cloud:true}` regardless — so a
 * run that never reached the store reported as persisted. Reporting a write you
 * did not verify is the "unverified write success" class this repo audits for.
 *
 * **Parent-joined since D7 / Phase 7.** `specId` is an opaque uuid supplied by
 * the caller, and this used to INSERT against it without proving the spec
 * exists or belongs to any resolvable repo — a dangling id attached a run row
 * to nothing (or FK-errored late), and a spec belonging to another repository
 * was written to happily. The INSERT now selects through the parent in ONE
 * statement, so there is no window and no check a caller can forget.
 *
 * `repoId` is additive and optional: `null` relaxes the TENANT predicate only.
 * The existence join always applies.
 *
 * @param {string} specId
 * @param {object} run
 * @param {{repoId?: string|null}} [opts]
 * @returns {Promise<{ok:boolean, cloud:boolean, reason?:string, error?:string}>}
 */
export async function recordRegressionSpecRun(specId, run, opts = {}) {
  if (!specId) return { ok: false, cloud: false, reason: 'missing-spec-id' };
  if (!await isCloudEnabled()) return { ok: true, cloud: false, reason: 'cloud-off' };
  const row = {
    spec_id: specId,
    commit_sha: run.commitSha || null,
    passed: !!run.passed,
    captured_regression: !!run.capturedRegression,
    duration_ms: run.durationMs || null,
    error_message: run.errorMessage || null,
    run_context: run.runContext || null,
  };
  // Optional selector-policy telemetry (plan: ux-lock-selector-policy).
  if (run.selectorPolicyViolations != null) row.selector_policy_violations = run.selectorPolicyViolations;
  const write = async (omitPolicy) => {
    const cols = Object.keys(row).filter((c) => !(omitPolicy && c === 'selector_policy_violations'));
    const { text, values } = buildOwnedInsert({
      parentTable: 'regression_specs',
      childTable: 'regression_spec_runs',
      columns: cols,
      rows: [cols.map((c) => row[c])],
      parentId: specId,
      repoId: opts.repoId ?? null,
    });
    return classifyOwnedWrite(await one(text, values), 1);
  };
  try {
    const res = await write(false);
    return res.ok ? { ok: true, cloud: true } : { ok: false, cloud: true, reason: res.reason, error: res.message };
  } catch (err) {
    // Same 42703 fallback insertRunRowWithPolicyFallback provided, preserved
    // through the join rewrite: a consumer DB predating migration 20260703200000
    // must still get its run row rather than losing it to one optional column.
    if (err?.code === '42703' && 'selector_policy_violations' in row) {
      process.stderr.write('  [learning] regression_spec_runs.selector_policy_violations missing — run setup-postgres --migrate; recording without it\n');
      try {
        const retry = await write(true);
        return retry.ok ? { ok: true, cloud: true } : { ok: false, cloud: true, reason: retry.reason, error: retry.message };
      } catch (retryErr) {
        process.stderr.write(`  [learning] recordRegressionSpecRun failed: ${retryErr.message}\n`);
        return { ok: false, cloud: true, reason: 'write-failed', error: retryErr.message };
      }
    }
    process.stderr.write(`  [learning] recordRegressionSpecRun failed: ${err.message}\n`);
    return { ok: false, cloud: true, reason: 'write-failed', error: err.message };
  }
}

/**
 * Window-scoped row counts for the skill-efficacy census
 * (docs/plans/skill-efficacy-census.md Phase 2). Counts **specs authored**,
 * not invocations (round-4 M1 fix) — one `/ux-lock` session can author
 * several specs, and a `--verify`-mode session authors none at all, so this
 * row is a proxy, never a direct invocation count. `source_kind !=
 * 'unit-test'` excludes `/ship`'s `lock-with-test` rows, which share this
 * table but belong to a different skill.
 *
 * @param {string} repoId
 * @param {{currentStart: string, priorStart: string, now: string}} bounds ISO timestamps
 * @returns {Promise<{current: number, prior: number, allTime: number}|null>}
 */
export async function getRegressionSpecWindowCounts(repoId, { currentStart, priorStart, now }) {
  return runWindowCountQuery({
    repoGuard: repoId, table: 'regression_specs', extraWhere: "AND source_kind != 'unit-test'",
    params: [repoId, currentStart, now, priorStart],
    errorLabel: 'getRegressionSpecWindowCounts',
  });
}
