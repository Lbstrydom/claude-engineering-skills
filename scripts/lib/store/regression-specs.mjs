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
 * 'unit-test'` excludes `/ship-checked`'s `lock-with-test` rows, which share this
 * table but belong to a different skill.
 *
 * @param {string} repoId
 * @param {{currentStart: string, priorStart: string, now: string}} bounds ISO timestamps
 * @returns {Promise<{current: number, prior: number, allTime: number}|null>}
 */
export async function getRegressionSpecWindowCounts(repoId, { currentStart, priorStart, now }) {
  return runWindowCountQuery({
    repoGuard: repoId, table: 'regression_specs', extraFilter: { column: 'source_kind', value: 'unit-test', op: '!=' },
    params: [repoId, currentStart, now, priorStart],
    errorLabel: 'getRegressionSpecWindowCounts',
  });
}

/**
 * Every recorded lock's cited `spec_path` for a repo — the raw material for the
 * dangling-citation check the /ship-checked lock nudge reports.
 *
 * **Why the check cannot live in SQL.** Postgres cannot stat a file. Existence is a
 * property of the CALLER's working tree, so the query returns citations and the caller
 * resolves them through `classifyTestPath` — the same oracle `lock-with-test` already
 * refuses on, rather than a second spelling of "does this path exist".
 *
 * **Why a READ-side check is the primary instrument** (upstream report `b2c9a63f`, and
 * the upstream evidence contradicts the report's first option). A citation's truth is not
 * a property of the moment it was written. Measured here 2026-09-06: 3 of 235 rows cite a
 * path that no longer resolves, all three `source_kind: 'unit-test'` — i.e. written BY
 * `lock-with-test`, which DOES validate existence — and all three deleted by one commit,
 * `e833b2aa` ("retire the consistency candidate promotion path"). They were true when
 * recorded and were invalidated afterwards by a legitimate refactor, so a write-time check
 * would have caught **zero** of them. The reporter's three were the opposite case (tests
 * on unmerged branches, true-soon). Only a read-time check catches both.
 *
 * It matters because a lock REMOVES a finding from `unlocked_fixes` — that view's only
 * lock predicate is `EXISTS (SELECT 1 FROM regression_specs …)`. A dangling citation
 * therefore reads as coverage forever, and the view whose entire job is surfacing
 * unlocked fixes will never mention it again. An obligation discharged by silence, which
 * is the exact failure `agedOut` was added for one axis over.
 *
 * Cloud-off and query failure both return `[]` — this feeds a non-blocking nudge and must
 * never break a push. The CALLER distinguishes "no dangling locks" from "not measured";
 * an empty array here is not a clean bill of health on its own.
 *
 * @param {string} repoId
 * @returns {Promise<Array<{specPath: string, sourceKind: string|null, sourceFindingId: string|null, createdAt: string|null}>>}
 */
export async function getRecordedSpecPaths(repoId) {
  if (!repoId) return [];
  if (!await isCloudEnabled()) return [];
  try {
    const { many } = await import('../db/query.mjs');
    const rows = await many(
      `SELECT spec_path, source_kind, source_finding_id, created_at
         FROM regression_specs
        WHERE repo_id = $1 AND spec_path IS NOT NULL
        ORDER BY created_at DESC`,
      [repoId],
    );
    return rows.map((r) => ({
      specPath: r.spec_path,
      sourceKind: r.source_kind ?? null,
      sourceFindingId: r.source_finding_id ?? null,
      createdAt: r.created_at ? String(r.created_at) : null,
    }));
  } catch (err) {
    process.stderr.write(`  [learning] getRecordedSpecPaths failed: ${err.message}\n`);
    return [];
  }
}

// ── Re-pointing and removing a lock ────────────────────────────────────────

/**
 * Every regression-spec row this repo holds for one finding.
 *
 * The read half of `repoint`/`delete`: those operate on a row identified by
 * (repo, finding), and that pair is NOT unique by construction — the unit-test
 * arbiter is (repo_id, spec_path, source_finding_id), so a finding can legally
 * carry rows citing two different paths. The caller therefore has to SEE the
 * candidates before it can act on one, and a command that silently picked the
 * newest would be guessing which citation the operator meant.
 *
 * Cloud-off and a query failure are DISTINCT here, unlike `getRecordedSpecPaths`
 * above: this feeds a write, not a nudge, and a write must not proceed on a
 * read that never happened.
 *
 * @param {string} repoId
 * @param {string} sourceFindingId
 * @returns {Promise<{ok:true, cloud:true, rows:Array<{id:string, specPath:string|null,
 *            description:string|null, sourceKind:string|null, createdAt:string|null}>}
 *          |{ok:false, cloud:boolean, reason:'cloud-off'|'invalid-input'|'read-failed', message:string}>}
 */
export async function getRegressionSpecsForFinding(repoId, sourceFindingId) {
  if (!repoId || !sourceFindingId) {
    return { ok: false, cloud: true, reason: 'invalid-input', message: 'repoId and sourceFindingId are both required' };
  }
  if (!await isCloudEnabled()) {
    return { ok: false, cloud: false, reason: 'cloud-off', message: 'cloud store is disabled' };
  }
  try {
    const { many } = await import('../db/query.mjs');
    const rows = await many(
      `SELECT id, spec_path, description, source_kind, created_at
         FROM regression_specs
        WHERE repo_id = $1 AND source_finding_id = $2
        ORDER BY created_at ASC`,
      [repoId, sourceFindingId],
    );
    return {
      ok: true,
      cloud: true,
      rows: rows.map((r) => ({
        id: r.id,
        specPath: r.spec_path ?? null,
        description: r.description ?? null,
        sourceKind: r.source_kind ?? null,
        createdAt: r.created_at ? String(r.created_at) : null,
      })),
    };
  } catch (err) {
    process.stderr.write(`  [learning] getRegressionSpecsForFinding failed: ${err.message}\n`);
    return { ok: false, cloud: true, reason: 'read-failed', message: err.message };
  }
}

/**
 * Re-point an existing lock at a different test file.
 *
 * **UPDATE, deliberately — not delete-then-insert.** The row's `id` is the
 * parent of any `regression_spec_runs` children, and `created_at` is when the
 * obligation was first discharged. Re-creating the row would orphan the runs
 * and reset the date, turning "this lock has been in place since July" into
 * "this lock is new" — a claim the re-point never established. That is why the
 * consumer's local repair (upstream 429683ac) used UPDATE too.
 *
 * **Why this could not be done with the existing verbs.** `lock-with-test`
 * refuses an already-locked finding, correctly, because its job is to discharge
 * an OPEN obligation. `record-regression-spec` cannot re-point either: for
 * `unit-test` the arbiter includes `spec_path`, so a call naming a NEW path
 * does not conflict — it INSERTS a second row and leaves the stale citation
 * standing. So the read side reported dangling locks (`danglingLocks`) that no
 * write side could clear.
 *
 * **Scoped by `repo_id` in the WHERE clause, not just by the id.** A spec id is
 * a uuid an operator can paste from anywhere, and a cross-tenant UPDATE is the
 * same fence `lock-with-test` grew after it adopted a foreign row's repo_id.
 *
 * A write returning no row is `write-failed`, never `ok` — Postgres reports
 * success for an UPDATE that matched nothing.
 *
 * @param {string} repoId
 * @param {{specId: string, specPath: string, description: string}} change
 * @returns {Promise<{ok:true, cloud:true, specId:string, specPath:string}
 *          |{ok:false, cloud:boolean, reason:'cloud-off'|'invalid-input'|'write-failed', message:string}>}
 */
export async function repointRegressionSpec(repoId, { specId, specPath, description } = {}) {
  if (!repoId || !specId || !specPath || !description?.trim()) {
    return {
      ok: false,
      cloud: true,
      reason: 'invalid-input',
      message: 'repoId, specId, specPath and a non-empty description are all required — '
        + 'an unexplained re-point is as unverifiable as an unexplained lock',
    };
  }
  if (!await isCloudEnabled()) {
    return { ok: false, cloud: false, reason: 'cloud-off', message: 'cloud store is disabled' };
  }
  try {
    const row = await one(
      `UPDATE regression_specs
          SET spec_path = $1, description = $2, updated_at = now()
        WHERE id = $3 AND repo_id = $4
        RETURNING id, spec_path`,
      [specPath, description, specId, repoId],
    );
    if (!row?.id) {
      return {
        ok: false,
        cloud: true,
        reason: 'write-failed',
        message: `no regression spec "${specId}" in this repo — the UPDATE matched nothing`,
      };
    }
    return { ok: true, cloud: true, specId: row.id, specPath: row.spec_path };
  } catch (err) {
    process.stderr.write(`  [learning] repointRegressionSpec failed: ${err.message}\n`);
    return { ok: false, cloud: true, reason: 'write-failed', message: err.message };
  }
}

/**
 * Remove a lock entirely.
 *
 * The honest counterpart to re-pointing: where NO test discharges the finding,
 * the row is a false claim, and deleting it returns the finding to
 * `unlocked_fixes` where it can be raised again. Re-pointing it at some
 * loosely-related file to make the dangling count go down would be the band-aid
 * — it keeps the number clean and the claim false.
 *
 * Same repo fence and same no-row-means-failure rule as `repointRegressionSpec`.
 *
 * @param {string} repoId
 * @param {string} specId
 * @returns {Promise<{ok:true, cloud:true, specId:string, specPath:string|null}
 *          |{ok:false, cloud:boolean, reason:'cloud-off'|'invalid-input'|'write-failed', message:string}>}
 */
export async function deleteRegressionSpec(repoId, specId) {
  if (!repoId || !specId) {
    return { ok: false, cloud: true, reason: 'invalid-input', message: 'repoId and specId are both required' };
  }
  if (!await isCloudEnabled()) {
    return { ok: false, cloud: false, reason: 'cloud-off', message: 'cloud store is disabled' };
  }
  try {
    const row = await one(
      'DELETE FROM regression_specs WHERE id = $1 AND repo_id = $2 RETURNING id, spec_path',
      [specId, repoId],
    );
    if (!row?.id) {
      return {
        ok: false,
        cloud: true,
        reason: 'write-failed',
        message: `no regression spec "${specId}" in this repo — the DELETE matched nothing`,
      };
    }
    return { ok: true, cloud: true, specId: row.id, specPath: row.spec_path ?? null };
  } catch (err) {
    process.stderr.write(`  [learning] deleteRegressionSpec failed: ${err.message}\n`);
    return { ok: false, cloud: true, reason: 'write-failed', message: err.message };
  }
}
