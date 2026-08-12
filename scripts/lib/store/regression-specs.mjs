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
import { upsert } from '../db/query.mjs';
import { insertRunRowWithPolicyFallback } from './run-row-fallback.mjs';

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
 */
export async function recordRegressionSpec(repoId, spec) {
  if (!await isCloudEnabled()) return null;
  if (!spec?.sourceKind) return null;
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
    return null;
  }
  if (!spec.specPath) {
    process.stderr.write('  [learning] recordRegressionSpec: spec_path is required\n');
    return null;
  }
  if (!repoId) {
    // The (repo_id, spec_path) unique constraint is a FULL index; a NULL
    // repo_id is distinct from every other NULL in Postgres, so the upsert
    // would silently INSERT a duplicate on every re-run instead of updating.
    // Refuse rather than accrue dupes.
    process.stderr.write('  [learning] recordRegressionSpec: rows require a resolved repoId (NULL would duplicate on the (repo_id, spec_path) unique index)\n');
    return null;
  }
  if (spec.sourceKind === 'unit-test' && !spec.sourceFindingId) {
    // A unit-test lock's identity IS the finding it pins: without one the row
    // asserts nothing, and the (repo_id, spec_path, source_finding_id) index
    // could not dedupe it. Refused here rather than left to the CHECK so the
    // caller gets a reason instead of a raised constraint name.
    process.stderr.write('  [learning] recordRegressionSpec: unit-test rows require sourceFindingId — a lock that names no finding pins nothing\n');
    return null;
  }
  if (!spec.description) return null;

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
    return rows[0]?.id ?? null;
  } catch (err) {
    process.stderr.write(`  [learning] recordRegressionSpec failed: ${err.message}\n`);
    return null;
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
 * @returns {Promise<{ok:boolean, cloud:boolean, reason?:string, error?:string}>}
 */
export async function recordRegressionSpecRun(specId, run) {
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
  try {
    await insertRunRowWithPolicyFallback('regression_spec_runs', row);
    return { ok: true, cloud: true };
  } catch (err) {
    process.stderr.write(`  [learning] recordRegressionSpecRun failed: ${err.message}\n`);
    return { ok: false, cloud: true, reason: 'write-failed', error: err.message };
  }
}
