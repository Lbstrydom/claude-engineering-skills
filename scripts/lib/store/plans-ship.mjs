/**
 * @fileoverview Cross-skill data-loop domain — plans, regression specs,
 * persona↔audit correlations, plan verification, ship events.
 *
 * Part of the postgres-parity M3 split. 13 functions covering the
 * plans / ux-lock / persona-correlation / ship feedback loop (migration
 * 20260419120000_cross_skill_data_loop.sql + 20260419130000_plan_verify.sql).
 *
 * @module scripts/lib/store/plans-ship
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import { findRepoRootFromCwd } from '../assert-repo-root.mjs';
import { many, one, insertReturning, upsert, updateWhere, deleteWhere, withTx } from '../db/query.mjs';
import { getPool } from '../db/client.mjs';
import { isCloudEnabled } from './repo.mjs';
// Imported, never re-declared — `plan-status.mjs` is the single source of
// truth for the vocabulary and for the markdown↔store spelling reconciliation.
// Not re-exported: the `learning-store.mjs` barrel is a functions-only surface.
// Import the status vocabulary from shared-lib, NOT from plan-status.mjs (plan
// domain) — a `stores → plan` edge is not in allowedDeps. status-vocabulary.mjs
// is the single definition; both this store and the plan-domain parser import
// it. See status-vocabulary.mjs for why the shared contract lives there.
import { DB_PLAN_STATUSES, toDbPlanStatus } from '../status-vocabulary.mjs';
import { PERSONA_FINDING_HASH_VERSION, PERSONA_FINDING_HASH_SHAPE } from '../persona/audit-correlator.mjs';

// ── plans ──────────────────────────────────────────────────────────────────

/**
 * Validate + normalise a plan path before it becomes a durable identifier.
 *
 * Added 2026-07-20 after an audit of the live store found three non-plans
 * registered in `plans`: the literal string `--help` (an unconsumed CLI flag
 * that `upsert-plan` accepted as a path) and two absolute session-scratchpad
 * paths under AppData/Temp that no longer exist. Nothing read them, but
 * `plans` is the join target for `audit_runs.plan_id`, so junk rows quietly
 * degrade every effectiveness query built over it.
 *
 * Lexical only — deliberately no `realpathSync`. Registering a path is not
 * egress (no content is read or sent), so the symlink-resolution that
 * `requirements/extract.mjs` needs for `--files` would be cost without a
 * threat here. Containment is still enforced, which is what rejects the
 * scratchpad paths.
 *
 * Normalising to a repo-relative POSIX path also closes a latent idempotence
 * hole: `plans` is unique on `(repo_id, path)`, so the same plan referenced
 * once absolutely and once relatively used to INSERT two rows rather than
 * update one.
 *
 * @param {string} rawPath
 * @param {{repoRoot?: string}} [opts]
 * @returns {{ok:true, path:string}
 *          |{ok:false, reason:'empty'|'flag-like'|'not-markdown'|'escapes-repo', message:string}}
 */
export function validatePlanPath(rawPath, opts = {}) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    return { ok: false, reason: 'empty', message: 'plan path is empty' };
  }
  const raw = rawPath.trim();

  // A leading `-` is an unconsumed CLI flag, never a path. This is precisely
  // how `--help` became a plan row.
  if (raw.startsWith('-')) {
    return {
      ok: false, reason: 'flag-like',
      message: `refusing a flag-like plan path (unconsumed CLI argument?): ${raw}`,
    };
  }
  if (!/\.md$/i.test(raw)) {
    return {
      ok: false, reason: 'not-markdown',
      message: `refusing a plan path that is not a .md document: ${raw}`,
    };
  }

  // Default to the caller's GIT REPO ROOT, not cwd. `process.cwd()` was wrong
  // whenever a plan-recording command ran from a subdirectory: a valid absolute
  // in-repo plan path resolved outside the cwd and was rejected as
  // `escapes-repo` (debt 0fd6bf8f, reproduced from `scripts/` before fixing).
  //
  // Fixing the DEFAULT rather than threading `repoRoot` through every caller is
  // deliberate. There are four callers across three modules, and a threaded
  // parameter is inert until all of them pass it — a fix that looks done and
  // changes nothing. Outside a git checkout the resolver falls back to the same
  // directory this used before, so nothing regresses.
  const root = path.resolve(opts.repoRoot ?? findRepoRootFromCwd());
  // Normalise separators BEFORE containment, so the check and the returned
  // identifier read the same string.
  //
  // They used to disagree on POSIX: `path.resolve` treats `\` as an ordinary
  // filename character there, so `..\scratch.md` resolved to `<root>/..\scratch.md`
  // and PASSED containment — while the `rel` computed below converts `\`→`/` and
  // handed back `../scratch.md`, a traversal-shaped key that is then stored as
  // `plans.path` and used as the `getPlanIdByPath` lookup key. Verified on POSIX
  // semantics 2026-08-12. On Windows `path.resolve` already treats `\` as a
  // separator, so this is a no-op there; this file's tooling syncs to Linux
  // consumers, which is where the two spellings diverged.
  const normalised = raw.replace(/\\/g, '/');
  const abs = path.resolve(root, normalised);
  // Windows drive-letter and path casing vary between callers (`C:/GIT/...`
  // vs `c:/git/...`), so containment compares case-insensitively there. The
  // RETURNED path is still derived from the real resolve, never the lowered
  // copy — we normalise the comparison, not the data.
  // darwin included since 2026-08-12: macOS filesystems are case-INSENSITIVE by
  // default, so a win32-only test rejected a valid in-repo plan whenever the
  // caller's spelling of the root differed in case from the resolved one
  // (`/Users/Foo/repo/docs/x.md` under a root read as `/Users/foo/repo`), and
  // conversely let two spellings of one file produce two distinct `rel` keys —
  // two `plans` rows for the same document. Same reasoning that put win32 here.
  const ci = process.platform === 'win32' || process.platform === 'darwin';
  const cmp = (s) => (ci ? s.toLowerCase() : s);
  if (cmp(abs) !== cmp(root) && !cmp(abs).startsWith(cmp(root) + path.sep)) {
    return {
      ok: false, reason: 'escapes-repo',
      message: `refusing a plan path outside the repo root (scratchpad or temp file?): ${raw}`,
    };
  }

  const rel = path.relative(root, abs).replace(/\\/g, '/');
  if (!rel) {
    return { ok: false, reason: 'escapes-repo', message: `plan path resolves to the repo root itself: ${raw}` };
  }
  return { ok: true, path: rel };
}

/**
 * Upsert a plan artefact. Returns the plan UUID so audit_runs can link.
 * Idempotent on `(repo_id, path)`.
 */
export async function upsertPlan(repoId, plan) {
  if (!plan?.path || !plan?.skill) return null;
  if (!await isCloudEnabled()) return null;
  // Validated HERE rather than at the CLI boundary because `upsertPlan` is the
  // real chokepoint — three callers reach it (cross-skill.mjs, the code-audit
  // path in legacy-production-audit.mjs, and plan-audit-cloud.mjs), and two of
  // those pass a user-supplied `--plan` argument straight through. Guarding
  // only the CLI would have left the audit paths open, which is where the
  // scratchpad rows most likely entered.
  //
  // Returns null rather than throwing: every caller already treats a null plan
  // id as "no plan linkage" and continues, so a bad path costs the link, never
  // the audit. The warning is what makes it non-silent.
  const validated = validatePlanPath(plan.path);
  if (!validated.ok) {
    process.stderr.write(`  [learning] upsertPlan: ${validated.message}\n`);
    return null;
  }
  if (!repoId) {
    // Idempotence is claimed on (repo_id, path), a FULL unique index. A NULL
    // repo_id is distinct from every other NULL in Postgres, so a null here
    // INSERTs a duplicate plan row on every call instead of updating — same
    // defect class as recordRegressionSpec's repoId guard. Refuse.
    process.stderr.write('  [learning] upsertPlan: requires a resolved repoId (NULL would duplicate on the (repo_id, path) unique index)\n');
    return null;
  }
  try {
    // The `|| null` below is defensive residue that reads as nullable to the lint;
    // the early return above makes it unreachable. Left in place rather than dropped
    // so the column's real DB nullability stays honest at the call site.
    // @on-conflict-ok: repoId is provably non-null — the early return above rejects a falsy repoId, naming this exact defect class; detecting that needs flow analysis.
    const rows = await upsert('plans', [{
      repo_id: repoId || null,
      path: validated.path,   // repo-relative POSIX — see validatePlanPath
      skill: plan.skill,
      status: plan.status || 'draft',
      principles_cited: plan.principlesCited || [],   // jsonb — serialized by the db-layer seam
      focus_areas: plan.focusAreas || [],
      commit_sha: plan.commitSha || null,
      checksum: plan.checksum || null,
      updated_at: new Date().toISOString(),
    }], { onConflict: ['repo_id', 'path'], update: 'all', returning: ['id'] });
    return rows[0]?.id ?? null;
  } catch (err) {
    process.stderr.write(`  [learning] upsertPlan failed: ${err.message}\n`);
    return null;
  }
}

/**
 * Resolve a plan UUID from its path, so a human can mark a plan terminal by
 * the name they actually know it by rather than by hunting a UUID.
 *
 * Applies the same normalisation `upsertPlan` writes through, so a lookup by
 * `docs/plans/<name>.md` matches a row registered from an absolute path.
 *
 * @returns {Promise<{ok:true, planId:string, path:string}
 *                  |{ok:false, reason:'invalid-path'|'not-found'|'cloud-off', message:string}>}
 */
export async function getPlanIdByPath(repoId, rawPath) {
  const validated = validatePlanPath(rawPath);
  if (!validated.ok) return { ok: false, reason: 'invalid-path', message: validated.message };
  if (!await isCloudEnabled()) return { ok: false, reason: 'cloud-off', message: 'cloud store is disabled' };
  if (!repoId) return { ok: false, reason: 'not-found', message: 'no resolved repoId — cannot scope a plan lookup' };
  try {
    const row = await one(
      'SELECT id, path FROM plans WHERE repo_id = $1 AND path = $2',
      [repoId, validated.path],
    );
    if (!row) {
      return {
        ok: false, reason: 'not-found',
        message: `no plan registered at ${validated.path} for this repo — run the /plan flow first, or check the path`,
      };
    }
    return { ok: true, planId: row.id, path: row.path };
  } catch (err) {
    // NOT 'not-found'. A thrown query is a LOOKUP FAILURE — the plan may well
    // exist. Labelling it `not-found` told the operator "no plan registered at
    // <path> — run the /plan flow first", i.e. blamed their input for the store
    // being unreachable, and invited them to re-register a plan that is already
    // there. Same failure-state collapse as `resolveRepoForStore` returning null
    // for both absence and error (cross-skill-cli-integrity F7); the caller can
    // now tell the two apart.
    return { ok: false, reason: 'lookup-failed', message: `plan lookup failed: ${err.message}` };
  }
}

/** Update a plan's status. Returns { ok, rowCount }. */
export async function updatePlanStatus({ repoId, planId, status }) {
  if (!planId || !await isCloudEnabled()) return { ok: false, rowCount: 0 };
  // Accept the MARKDOWN spelling of the same token, not just the DB one.
  // `skills/plan/SKILL.md` instructs `Draft | Approved | In Progress |
  // Complete` while the CHECK constraint stores `in_progress` etc., so a human
  // following our own docs types `Complete` and would otherwise be rejected for
  // a difference in casing convention between two surfaces — not a real
  // disagreement about the value. Same vocabulary, one spelling normaliser.
  const normalised = toDbPlanStatus(status);

  // Reject an out-of-vocabulary status BEFORE the write. The CHECK constraint
  // would catch it anyway, but as an opaque `23514` the caller cannot act on —
  // and the whole point of this path is that a human types the status by hand.
  if (!DB_PLAN_STATUSES.includes(normalised)) {
    process.stderr.write(
      `  [learning] updatePlanStatus: '${status}' is not a valid status (expected one of: ${DB_PLAN_STATUSES.join(', ')})\n`,
    );
    return { ok: false, rowCount: 0 };
  }
  try {
    // TENANT SCOPE IS A SQL PREDICATE, NOT A CALLER VARIABLE. Resolving a repoId
    // in the CLI constrains nothing — the mutation itself must carry both keys, or an
    // explicit `planId` can update a row owned by another repo. Required, because an
    // undefined would silently widen the WHERE clause.
    if (!repoId) {
      process.stderr.write('  [learning] updatePlanStatus: repoId is required (refusing an unscoped update)\n');
      return { ok: false, rowCount: 0, reason: 'repo-scope-required' };
    }
    const { rowCount } = await updateWhere('plans',
      { status: normalised, updated_at: new Date().toISOString() },
      { id: planId, repo_id: repoId }
    );
    // 0 rows means EITHER a stale planId OR a plan owned by a DIFFERENT repo — both
    // are refusals, never phantom successes. The cross-tenant case is new: before the
    // repo_id predicate, that update would have succeeded against another repo's row.
    if (rowCount === 0) {
      process.stderr.write(
        `  [learning] updatePlanStatus: no row updated for planId=${planId} in repo ${repoId} `
        + '(stale id, or the plan belongs to another repo)\n',
      );
    }
    return { ok: rowCount > 0, rowCount, reason: rowCount === 0 ? 'plan-not-in-repo' : undefined };
  } catch (err) {
    process.stderr.write(`  [learning] updatePlanStatus failed: ${err.message}\n`);
    return { ok: false, rowCount: 0 };
  }
}

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
 * Insert a run row that may carry the optional `selector_policy_violations`
 * column (migration 20260703200000). EXACTLY undefined_column (42703) on a row
 * that carries the column → the consumer DB predates the migration: retry ONCE
 * without the field so the run row itself isn't lost, with a single warning
 * naming the pending migration. Any OTHER error propagates to the caller's
 * existing handling — never a broader swallow (db-write-seam rule).
 *
 * `insertFn` is injectable for tests (defaults to the real insertReturning).
 */
export async function insertRunRowWithPolicyFallback(table, row, opts = undefined, insertFn = insertReturning) {
  try {
    return await insertFn(table, row, opts);
  } catch (err) {
    if (err?.code === '42703' && 'selector_policy_violations' in row) {
      process.stderr.write(`  [learning] ${table}.selector_policy_violations missing — run setup-postgres --migrate; recording without it\n`);
      const { selector_policy_violations: _dropped, ...rest } = row;
      return await insertFn(table, rest, opts);
    }
    throw err;
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

/**
 * Recent fixes lacking a regression spec (from the `unlocked_fixes` view).
 * Optionally scoped to a repo.
 */
/**
 * Resolve an explicit scope argument for the cross-repo /ship-nudge readers
 * (`unlocked_fixes`, `unremediated_acceptances`).
 *
 * WHY THIS EXISTS. These readers previously took a bare `repoId` and treated
 * *absent* as "every repository" — so a caller that simply forgot to pass one
 * silently got cross-tenant rows. That is not hypothetical: a consumer repo
 * reported an unlocked-fix backlog of 207 that belonged entirely to a DIFFERENT
 * repository (its own true count was 0), and a second unscoped call site existed
 * for months without anyone noticing.
 *
 * Patching the known callers would leave the footgun armed for the next one, so
 * the unsafe default is removed at the DATA-ACCESS boundary instead: global
 * access now has to be *asked for*. This is INC-002's lesson restated — an
 * omitted argument is not a safety gate.
 *
 * EVERY view in this family routes through here. `getUnremediatedAcceptances`
 * did not, and reproduced the identical defect one `/ship` step later (0.5e):
 * invoked with no flags it returned rows spanning multiple repos, which the
 * skill then told the operator to count as `unremediated_count` for THIS repo.
 * A new repo-bearing reader added to this module belongs on this fence too —
 * that is the whole point of it being one shared function.
 *
 * @param {{repoId?: string|null, allRepos?: boolean}|string|null|undefined} scope
 * @param {string} fnName
 * @returns {{repoId: string|null, allRepos: boolean}}
 */
function resolveExplicitRepoScope(scope, fnName) {
  if (scope && typeof scope === 'object' && !Array.isArray(scope)) {
    const { repoId = null, allRepos = false } = scope;
    if (allRepos && repoId) {
      throw new Error(`${fnName}: pass EITHER {repoId} OR {allRepos:true}, never both — the intent is ambiguous.`);
    }
    if (allRepos) return { repoId: null, allRepos: true };
    if (typeof repoId === 'string' && repoId) return { repoId, allRepos: false };
  }
  throw new Error(
    `${fnName}: an explicit scope is required — pass {repoId:'<uuid>'} or {allRepos:true}. ` +
    'An omitted/blank scope used to mean "every repository", which leaked another repo\'s ' +
    'findings into a consumer\'s output; it is now a hard error rather than a silent widening.',
  );
}

/**
 * Default page size for the /ship-nudge readers below. Unchanged from the bare
 * `LIMIT 20` these carried before pagination existed, deliberately: the default
 * output of every caller stays byte-identical, so threading `limit`/`offset`
 * cannot quietly change what an operator sees.
 */
const NUDGE_PAGE_DEFAULT = 20;
/** Upper bound on one page. These feed a nudge; the counters report scale. */
const NUDGE_PAGE_MAX = 200;

/**
 * Clamp caller-supplied paging for a nudge reader.
 *
 * Nonsense in (0, -5, NaN, 10_000) must not become nonsense in SQL, and must
 * not silently mean "everything" either — an unbounded read of a view that has
 * run to 232 rows is not what any of these call sites wants.
 *
 * @param {{limit?: number|string|null, offset?: number|string|null}} [opts]
 * @returns {{limit: number, offset: number}}
 */
export function resolveNudgePage(opts = {}) {
  const rawLimit = Number(opts?.limit);
  const rawOffset = Number(opts?.offset);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), NUDGE_PAGE_MAX)
    : NUDGE_PAGE_DEFAULT;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  return { limit, offset };
}

/**
 * Recent fixes lacking a regression spec (from the `unlocked_fixes` view).
 *
 * **Scope is mandatory and explicit** — see `resolveExplicitRepoScope`. Note the
 * page cap: this is a nudge sampler, not an exhaustive reader. Never use it
 * to look up ONE finding by id — under `{allRepos:true}` it returns one page
 * out of hundreds of rows across every repo, so a finding that genuinely exists
 * usually will not be in them.
 *
 * `opts.mode` filters by `audit_mode` **in SQL, before the cap**. A caller that
 * fetched 20 mixed rows and filtered to `code` in JS got an arbitrary subset of
 * a subset: with no ORDER BY, Postgres is free to return different 20 rows per
 * call, so the same backlog reads as a different page each time and code rows
 * beyond the cap are invisible. That is what made the lock worksheet look like
 * it was refilling with "fresh" findings during a sweep. The ORDER BY makes the
 * page a stable prefix rather than an arbitrary sample.
 *
 * `opts.limit`/`opts.offset` page that stable prefix, so the tail past the first
 * page is reachable at all. Without them a caller shown `shown 20 / total 232`
 * can see that rows are missing but has no way to ever read one of them.
 *
 * @param {{repoId?: string|null, allRepos?: boolean}} scope
 * @param {{mode?: 'code'|'plan'|null, limit?: number|null, offset?: number|null,
 *          allAges?: boolean}} [opts]
 */
export async function getUnlockedFixes(scope, opts = {}) {
  const { repoId, allRepos } = resolveExplicitRepoScope(scope, 'getUnlockedFixes');
  if (!await isCloudEnabled()) return [];
  const mode = opts?.mode ?? null;
  const { limit, offset } = resolveNudgePage(opts);
  try {
    const preds = [];
    const params = [];
    if (!allRepos) { params.push(repoId); preds.push(`repo_id = $${params.length}`); }
    if (mode) { params.push(mode); preds.push(`audit_mode = $${params.length}`); }
    const where = preds.length ? ` WHERE ${preds.join(' AND ')}` : '';
    params.push(limit, offset);
    // `opts.allAges` reads the unwindowed base view. The default stays the
    // 14-day window: an unbounded ship-time nudge becomes noise and earns
    // `--no-verify`. What the window drops is reachable, not shown by default.
    //
    // The view name is SPELLED OUT per branch rather than interpolated, for the
    // same reason the ORDER BY is duplicated in the sibling below: the static
    // guards in tests/cross-skill-unlocked-scope.test.mjs match `FROM <view>`
    // inside the SQL LITERAL, and `FROM ${source}` is invisible to them. Doing
    // it the short way silently removed this reader from BOTH the repo-fence
    // scan and the order-before-cap scan, and every assertion stayed green
    // because the remaining readers still cleared the vacuous-pass floor — the
    // exact failure those floors exist to make visible, one notch under them.
    if (opts?.allAges) {
      return await many(
        `SELECT * FROM unlocked_fixes_all${where} ORDER BY fixed_at DESC, audit_finding_id ` +
        `LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
    }
    return await many(
      `SELECT * FROM unlocked_fixes${where} ORDER BY fixed_at DESC, audit_finding_id ` +
      `LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
  } catch (err) {
    process.stderr.write(`  [learning] getUnlockedFixes failed: ${err.message}\n`);
    return [];
  }
}

/**
 * Look up ONE unlocked fix by its audit-finding id, **within a repo**.
 *
 * The companion to the LIMIT-20 sampler above, and the reason it exists: the
 * lock-with-test worksheet used to find its target by scanning
 * `getUnlockedFixes(null)`'s 20 cross-repo rows, then adopt whatever
 * `repo_id` the matched row carried. Two defects in one line — a legitimate
 * finding usually was not in those 20 (so the lookup silently missed), and a
 * foreign row's `repo_id` could be written straight into a regression spec.
 *
 * @param {{repoId: string, findingId: string}} a
 * @returns {Promise<object|null>}
 */
export async function findUnlockedFixInRepo({ repoId, findingId }) {
  if (!repoId || !findingId) throw new Error('findUnlockedFixInRepo: both repoId and findingId are required');
  if (!await isCloudEnabled()) return null;
  try {
    const rows = await many(
      `SELECT * FROM unlocked_fixes WHERE repo_id = $1 AND audit_finding_id = $2 LIMIT 1`,
      [repoId, findingId]
    );
    return rows[0] ?? null;
  } catch (err) {
    process.stderr.write(`  [learning] findUnlockedFixInRepo failed: ${err.message}\n`);
    return null;
  }
}

/**
 * How many unlocked fixes exist, split by run mode — the denominator
 * `getUnlockedFixes` cannot report.
 *
 * That function caps at `LIMIT 20`, so a caller counting its rows cannot tell
 * 20 obligations from 232. On 2026-07-29 the real total WAS 232 and /ship had
 * been reporting "20" — an undercount by an order of magnitude, in a nudge
 * whose entire job is to convey scale.
 *
 * `plan` rows are counted separately rather than hidden: a plan finding can
 * never have a `regression_specs` row (there is no code artifact to lock), so
 * it is a permanent non-obligation. Reporting one number that silently mixes
 * the two is how half a backlog reads as real work.
 *
 * Same failure contract as its sibling — cloud-off and query failure both
 * return zeroed counts, because this feeds a non-blocking nudge and must never
 * break a push.
 *
 * @param {string|null} [repoId]
 * @returns {Promise<{total:number, code:number, plan:number}>}
 */
export async function countUnlockedFixes(scope, opts = {}) {
  const { repoId, allRepos } = resolveExplicitRepoScope(scope, 'countUnlockedFixes');
  const empty = { total: 0, code: 0, plan: 0 };
  if (!await isCloudEnabled()) return empty;
  try {
    // The denominator must come from the SAME source as the rows it describes.
    // Counting the windowed view while `getUnlockedFixes({allAges})` paged the
    // unwindowed one would report `shown 5 / total 29` over a 219-row set — a
    // page you cannot tell is short, which is the defect `shown`/`total` exists
    // to prevent, reintroduced one axis over.
    //
    // Four literal branches, not one interpolated string: see the note in
    // `getUnlockedFixes`. The repo-fence scan reads these bodies for
    // `FROM <view>` literals, so an interpolated name drops the reader out.
    const rows = opts?.allAges
      ? (!allRepos
        ? await many(`SELECT audit_mode, count(*)::int AS n FROM unlocked_fixes_all WHERE repo_id = $1 GROUP BY audit_mode`, [repoId])
        : await many(`SELECT audit_mode, count(*)::int AS n FROM unlocked_fixes_all GROUP BY audit_mode`))
      : (!allRepos
        ? await many(`SELECT audit_mode, count(*)::int AS n FROM unlocked_fixes WHERE repo_id = $1 GROUP BY audit_mode`, [repoId])
        : await many(`SELECT audit_mode, count(*)::int AS n FROM unlocked_fixes GROUP BY audit_mode`));
    return rows.reduce((acc, r) => {
      const n = Number(r.n) || 0;
      acc.total += n;
      if (r.audit_mode === 'code') acc.code += n;
      else if (r.audit_mode === 'plan') acc.plan += n;
      return acc;
    }, { ...empty });
  } catch (err) {
    process.stderr.write(`  [learning] countUnlockedFixes failed: ${err.message}
`);
    return empty;
  }
}

/**
 * What the 14-day window EXCLUDED, split by whether it was ever an obligation.
 *
 * `countUnlockedFixes` answers "how many are in the window?". Nothing answered
 * "how many left it unlocked?", so an obligation was discharged by the passage
 * of time and the only trace was a smaller number. Measured 2026-08-11: 94 code
 * findings had aged out against 1 still visible.
 *
 * **`practiceStart` is derived, never configured.** It is this repo's earliest
 * audit-sourced `regression_specs` row — the moment locking was first practised
 * here. Anything that aged out BEFORE it is `prePractice`: you cannot have
 * lapsed a practice you had not started, and a repo that has never locked
 * anything correctly reports `agedOut: 0` rather than indicting itself for a
 * process it never adopted. Deriving it also makes this correct in every
 * consumer without a per-repo constant to keep in step — the shape a synced
 * tool needs.
 *
 * `agedOut` is therefore the number that matters: obligations that existed
 * under a live practice and expired anyway. It should sit at 0.
 *
 * Same failure contract as its siblings — cloud-off and query failure return
 * zeroed counts, because this feeds a non-blocking nudge.
 *
 * @param {{repoId?: string|null, allRepos?: boolean}} scope
 * @returns {Promise<{agedOut:number, prePractice:number, practiceStart:string|null,
 *                    byMode:{code:number, plan:number}}>}
 */
export async function countAgedUnlockedFixes(scope) {
  const { repoId, allRepos } = resolveExplicitRepoScope(scope, 'countAgedUnlockedFixes');
  const empty = { agedOut: 0, prePractice: 0, practiceStart: null, byMode: { code: 0, plan: 0 } };
  if (!await isCloudEnabled()) return empty;
  try {
    const scoped = !allRepos;
    const params = scoped ? [repoId] : [];
    const repoPred = scoped ? `WHERE repo_id = $1` : '';
    // One statement so the practice boundary and the counts are read at a single
    // instant — computing `practiceStart` separately would let a lock landing
    // between the two queries reclassify rows underneath the caller.
    const rows = await many(
      `WITH practice AS (
         SELECT min(created_at) AS started_at
           FROM regression_specs
          WHERE source_finding_type = 'audit'
            ${scoped ? 'AND repo_id = $1' : ''}
       )
       SELECT
         (SELECT started_at FROM practice)                                  AS practice_start,
         a.audit_mode,
         count(*) FILTER (
           WHERE (SELECT started_at FROM practice) IS NOT NULL
             AND a.fixed_at >= (SELECT started_at FROM practice)
         )::int                                                             AS aged_out,
         count(*) FILTER (
           WHERE (SELECT started_at FROM practice) IS NULL
              OR a.fixed_at < (SELECT started_at FROM practice)
         )::int                                                             AS pre_practice
       FROM unlocked_fixes_all a
       ${repoPred}${repoPred ? ' AND' : 'WHERE'} NOT a.is_recent
       GROUP BY a.audit_mode`,
      params
    );
    return rows.reduce((acc, r) => {
      const aged = Number(r.aged_out) || 0;
      acc.agedOut += aged;
      acc.prePractice += Number(r.pre_practice) || 0;
      acc.practiceStart = r.practice_start ? String(r.practice_start) : acc.practiceStart;
      if (r.audit_mode === 'code') acc.byMode.code += aged;
      else if (r.audit_mode === 'plan') acc.byMode.plan += aged;
      return acc;
    }, { ...empty, byMode: { ...empty.byMode } });
  } catch (err) {
    process.stderr.write(`  [learning] countAgedUnlockedFixes failed: ${err.message}\n`);
    return empty;
  }
}

/**
 * Accepted findings that never got a remediation transition (from the
 * `unremediated_acceptances` view).
 *
 * Companion to `getUnlockedFixes`, one step earlier in the lifecycle:
 * `unlocked_fixes` asks "this was fixed — is the fix locked?", this asks
 * "this was accepted — was it ever fixed at all?". Measured 2026-07-27, only
 * 3 of 10 accepted final-review-shadow findings had a confirmed code fix, so
 * `adjudication_outcome = 'accepted'` is NOT evidence of remediation.
 *
 * **Scope is mandatory and explicit** — see `resolveExplicitRepoScope`. This
 * reader carried the pre-fix `if (repoId) … else every repository` shape until
 * 2026-07-30: `/ship` Step 0.5e invokes it with no flags, so a live run
 * returned rows spanning two repos and the skill told the operator to record
 * the count as this repo's `unremediated_count`. It is the same defect as the
 * 207-vs-0 unlocked-fix incident, one step later in the same gate.
 *
 * Same failure contract as getUnlockedFixes: cloud-off and query failure both
 * return `[]` — this is a non-blocking /ship nudge and must never break a push.
 * Note that an INVALID SCOPE still throws: a programming error must not be
 * laundered into an empty nudge, which is what "no obligations" would read as.
 *
 * **The ORDER BY is load-bearing, and borrowing the view's was not enough.**
 * This capped its page with no ordering of its own until 2026-08-10, while the
 * sibling above had carried `ORDER BY fixed_at DESC, audit_finding_id` since the
 * arbitrary-page fix — the third one-sibling-only divergence this file records.
 * It LOOKED correct because `unremediated_acceptances` happens to define an
 * inner `ORDER BY CASE severity … , r.created_at ASC`, and measured on the live
 * store the planner does keep that Sort node under the outer LIMIT, so /ship
 * really was getting HIGH rows first (15 HIGH of 44 total, all inside the page).
 * That is a property of the VIEW TEXT, not of this read: Postgres does not
 * guarantee a subquery's ORDER BY survives into an outer query, and the sibling
 * view deliberately carries no inner sort at all — so the two readers disagreed
 * about where ordering lives, and this one asserted nothing. The skill telling
 * the operator "show at most 5, HIGH first" was relying on that unasserted
 * accident; a `CREATE OR REPLACE VIEW` dropping the inner sort is a pure
 * formatting change that would have silently started hiding HIGH rows.
 *
 * The clause below reproduces the view's intent exactly (so today's output is
 * unchanged by construction) and adds `audit_finding_id` to make the order
 * TOTAL — `accepted_at` alone ties freely, and a non-total order still permutes
 * across pages, which is how a paged reader shows one row twice and skips
 * another.
 *
 * @param {{repoId?: string|null, allRepos?: boolean}} scope
 * @param {{limit?: number|null, offset?: number|null}} [opts]
 */
export async function getUnremediatedAcceptances(scope, opts = {}) {
  const { repoId, allRepos } = resolveExplicitRepoScope(scope, 'getUnremediatedAcceptances');
  if (!await isCloudEnabled()) return [];
  const { limit, offset } = resolveNudgePage(opts);
  // The ORDER BY is spelled out in BOTH branches rather than hoisted into a
  // `const order` and interpolated. That is deliberate: the guard in
  // `tests/cross-skill-unlocked-scope.test.mjs` is a static scan of the SQL
  // literals in this file, and an interpolated clause is invisible to it — the
  // scan would go green while reading `${order}`, which is the vacuous pass the
  // whole harness exists to prevent. Verified by trying it: the hoisted version
  // failed the guard, and that failure is the guard working.
  try {
    // Four literal branches. `opts.allAges` drops BOTH age bounds, so it also
    // surfaces rows under the 7-day maturity floor — deliberately: the flag
    // means "show me everything this nudge is not telling me", and not-yet-due
    // is part of that answer even though it is not a loss.
    //
    // `is_open_disposition` is applied at EVERY age, including here.
    // `--all-ages` means "ignore the time window", NOT "include work that was
    // decided on the merits" — an `accepted-permanent` row is not something the
    // nudge is failing to tell you about. Keeping the filter on both sides is
    // also what preserves the aged-visibility invariant that
    // `allAges.total - windowed.total` IS the temporally-excluded set: let the
    // disposition apply on one side only and that gap silently acquires a
    // second, non-temporal term, and one of the two numbers starts lying.
    // The census — every row regardless of disposition — is
    // `unremediated_acceptances_all` itself, which no filter touches.
    if (opts?.allAges) {
      if (!allRepos) {
        return await many(
          `SELECT * FROM unremediated_acceptances_all WHERE repo_id = $1 AND is_open_disposition ` +
          `ORDER BY CASE severity WHEN 'HIGH' THEN 0 ELSE 1 END, accepted_at ASC, audit_finding_id ` +
          `LIMIT $2 OFFSET $3`,
          [repoId, limit, offset]
        );
      }
      return await many(
        `SELECT * FROM unremediated_acceptances_all WHERE is_open_disposition ` +
        `ORDER BY CASE severity WHEN 'HIGH' THEN 0 ELSE 1 END, accepted_at ASC, audit_finding_id ` +
        `LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
    }
    if (!allRepos) {
      return await many(
        `SELECT * FROM unremediated_acceptances WHERE repo_id = $1 ` +
        `ORDER BY CASE severity WHEN 'HIGH' THEN 0 ELSE 1 END, accepted_at ASC, audit_finding_id ` +
        `LIMIT $2 OFFSET $3`,
        [repoId, limit, offset]
      );
    }
    return await many(
      `SELECT * FROM unremediated_acceptances ` +
      `ORDER BY CASE severity WHEN 'HIGH' THEN 0 ELSE 1 END, accepted_at ASC, audit_finding_id ` +
      `LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
  } catch (err) {
    process.stderr.write(`  [learning] getUnremediatedAcceptances failed: ${err.message}\n`);
    return [];
  }
}

/**
 * How many unremediated acceptances exist, split by run mode — the denominator
 * `getUnremediatedAcceptances` cannot report.
 *
 * The exact defect `countUnlockedFixes` was built for, in the sibling view, two
 * days later and unnoticed because only the `unlocked_fixes` half was fixed.
 * Measured 2026-07-31: `getUnremediatedAcceptances` caps at `LIMIT 20`, /ship
 * reported `rows.length`, and the real total was **129** — a 6x undercount in a
 * nudge whose entire job is to convey scale. The count was then repeated back to
 * the operator as the size of the backlog they were deciding whether to work.
 *
 * `plan` rows are counted separately for the same reason as the sibling, but the
 * meaning differs and is worth stating: a plan-mode row here is NOT a permanent
 * non-obligation (unlike an unlockable plan finding) — it is a plan section that
 * was accepted and never amended, which is real work. It is split out so the
 * caller can say which kind it is, not so it can be discarded.
 *
 * Same failure contract as its siblings — cloud-off and query failure both
 * return zeroed counts; this feeds a non-blocking nudge and must never break a
 * push.
 *
 * @param {string|null|{repoId?: string|null, allRepos?: boolean}} [scope]
 * @returns {Promise<{total:number, code:number, plan:number}>}
 */
/**
 * How many findings were dispositioned `accepted-permanent` — decided on the
 * merits rather than forgotten.
 *
 * **Unwindowed, deliberately.** It counts over `unremediated_acceptances_all`,
 * not the nag window. A windowed count would expire the anti-dumping-ground
 * guarantee exactly when the dumping ground becomes worth auditing: a decision
 * taken 31 days ago would vanish from every reported field, which is the
 * time-based invisibility this whole view family has been fixing.
 *
 * Excluding these rows from the nag (migration
 * `20260811160000_unremediated_acceptances_disposition`) is only honest if the
 * count stays visible — a disposition you cannot see is indistinguishable from
 * a leak. Same failure contract as its siblings: cloud-off and query failure
 * both yield 0; an invalid scope still throws.
 *
 * @param {{repoId?: string|null, allRepos?: boolean}} scope
 * @returns {Promise<number>}
 */
export async function countAcceptedPermanent(scope) {
  const { repoId, allRepos } = resolveExplicitRepoScope(scope, 'countAcceptedPermanent');
  if (!await isCloudEnabled()) return 0;
  try {
    // Literal branches, not an interpolated view name or predicate — the guard
    // in tests/cross-skill-unlocked-scope.test.mjs statically scans the SQL
    // literals in this file, and an interpolated clause is invisible to it.
    const rows = !allRepos
      ? await many(`SELECT count(*)::int AS n FROM unremediated_acceptances_all WHERE repo_id = $1 AND NOT is_open_disposition`, [repoId])
      : await many(`SELECT count(*)::int AS n FROM unremediated_acceptances_all WHERE NOT is_open_disposition`);
    return Number(rows?.[0]?.n) || 0;
  } catch (err) {
    process.stderr.write(`  [learning] countAcceptedPermanent failed: ${err.message}\n`);
    return 0;
  }
}

export async function countUnremediatedAcceptances(scope, opts = {}) {
  const { repoId, allRepos } = resolveExplicitRepoScope(scope, 'countUnremediatedAcceptances');
  const empty = { total: 0, code: 0, plan: 0 };
  if (!await isCloudEnabled()) return empty;
  try {
    // The denominator follows the source the rows came from — see the note on
    // `countUnlockedFixes`. Literal branches, not an interpolated view name.
    const rows = opts?.allAges
      ? (!allRepos
        ? await many(`SELECT audit_mode, count(*)::int AS n FROM unremediated_acceptances_all WHERE repo_id = $1 AND is_open_disposition GROUP BY audit_mode`, [repoId])
        : await many(`SELECT audit_mode, count(*)::int AS n FROM unremediated_acceptances_all WHERE is_open_disposition GROUP BY audit_mode`))
      : (!allRepos
        ? await many(`SELECT audit_mode, count(*)::int AS n FROM unremediated_acceptances WHERE repo_id = $1 GROUP BY audit_mode`, [repoId])
        : await many(`SELECT audit_mode, count(*)::int AS n FROM unremediated_acceptances GROUP BY audit_mode`));
    return rows.reduce((acc, r) => {
      const n = Number(r.n) || 0;
      acc.total += n;
      if (r.audit_mode === 'code') acc.code += n;
      else if (r.audit_mode === 'plan') acc.plan += n;
      return acc;
    }, { ...empty });
  } catch (err) {
    process.stderr.write(`  [learning] countUnremediatedAcceptances failed: ${err.message}\n`);
    return empty;
  }
}

/**
 * What the two age bounds EXCLUDE, split by which bound and by whether the row
 * was ever an obligation.
 *
 * The sibling of `countAgedUnlockedFixes`, with one extra bucket, because this
 * view's window does two different jobs:
 *
 *  - `notYetDue` — under the 7-day MATURITY FLOOR. Not a loss: the row appears
 *    on its own once it ages past the floor. Reported so a reader can tell a
 *    genuinely empty backlog from one whose rows have not matured yet, and
 *    NEVER added to `agedOut`.
 *  - `agedOut` — over the 30-day CEILING, and accepted after this repo started
 *    recording remediations. A real leak: never shown again.
 *  - `prePractice` — over the ceiling but accepted before `practiceStart`. Not
 *    an obligation the repo ever had.
 *
 * `practiceStart` is the earliest remediation this repo ever RECORDED (the
 * analogue of the first regression spec on the locking side), derived from the
 * store rather than configured, for the same reason: it must be correct in
 * every consumer without a constant to keep in step.
 *
 * Same failure contract as its siblings — cloud-off and query failure return
 * zeroed counts, because this feeds a non-blocking nudge.
 *
 * @param {{repoId?: string|null, allRepos?: boolean}} scope
 * @returns {Promise<{agedOut:number, prePractice:number, notYetDue:number,
 *                    practiceStart:string|null, byMode:{code:number, plan:number},
 *                    bySeverity:{HIGH:number, MEDIUM:number}}>}
 */
export async function countAgedUnremediatedAcceptances(scope) {
  const { repoId, allRepos } = resolveExplicitRepoScope(scope, 'countAgedUnremediatedAcceptances');
  const empty = {
    agedOut: 0, prePractice: 0, notYetDue: 0, practiceStart: null,
    byMode: { code: 0, plan: 0 }, bySeverity: { HIGH: 0, MEDIUM: 0 },
  };
  if (!await isCloudEnabled()) return empty;
  try {
    const scoped = !allRepos;
    const params = scoped ? [repoId] : [];
    // One statement, so the practice boundary and the counts are read at a
    // single instant — computing `practiceStart` separately would let a
    // remediation landing between the two queries reclassify rows underneath
    // the caller.
    const rows = scoped
      ? await many(
        `WITH practice AS (
           SELECT min(e.created_at) AS started_at
             FROM finding_adjudication_events e
             JOIN audit_findings f2 ON f2.id = e.finding_id
             JOIN audit_runs r2 ON r2.id = f2.run_id
            WHERE e.remediation_state IN ('fixed','verified') AND r2.repo_id = $1
         )
         SELECT a.audit_mode, a.severity,
                count(*) FILTER (WHERE NOT a.is_mature)::int AS not_yet_due,
                count(*) FILTER (
                  WHERE a.is_mature AND NOT a.is_recent
                    AND (SELECT started_at FROM practice) IS NOT NULL
                    AND a.accepted_at >= (SELECT started_at FROM practice)
                )::int AS aged_out,
                count(*) FILTER (
                  WHERE a.is_mature AND NOT a.is_recent
                    AND ((SELECT started_at FROM practice) IS NULL
                         OR a.accepted_at < (SELECT started_at FROM practice))
                )::int AS pre_practice,
                (SELECT started_at FROM practice) AS practice_start
           FROM unremediated_acceptances_all a
          WHERE a.repo_id = $1 AND a.is_open_disposition AND NOT (a.is_mature AND a.is_recent)
          GROUP BY a.audit_mode, a.severity`,
        params
      )
      : await many(
        `WITH practice AS (
           SELECT min(e.created_at) AS started_at
             FROM finding_adjudication_events e
            WHERE e.remediation_state IN ('fixed','verified')
         )
         SELECT a.audit_mode, a.severity,
                count(*) FILTER (WHERE NOT a.is_mature)::int AS not_yet_due,
                count(*) FILTER (
                  WHERE a.is_mature AND NOT a.is_recent
                    AND (SELECT started_at FROM practice) IS NOT NULL
                    AND a.accepted_at >= (SELECT started_at FROM practice)
                )::int AS aged_out,
                count(*) FILTER (
                  WHERE a.is_mature AND NOT a.is_recent
                    AND ((SELECT started_at FROM practice) IS NULL
                         OR a.accepted_at < (SELECT started_at FROM practice))
                )::int AS pre_practice,
                (SELECT started_at FROM practice) AS practice_start
           FROM unremediated_acceptances_all a
          WHERE a.is_open_disposition AND NOT (a.is_mature AND a.is_recent)
          GROUP BY a.audit_mode, a.severity`,
        params
      );
    return rows.reduce((acc, r) => {
      const aged = Number(r.aged_out) || 0;
      acc.agedOut += aged;
      acc.prePractice += Number(r.pre_practice) || 0;
      acc.notYetDue += Number(r.not_yet_due) || 0;
      acc.practiceStart = r.practice_start ? String(r.practice_start) : acc.practiceStart;
      if (r.audit_mode === 'code') acc.byMode.code += aged;
      else if (r.audit_mode === 'plan') acc.byMode.plan += aged;
      if (r.severity === 'HIGH') acc.bySeverity.HIGH += aged;
      else if (r.severity === 'MEDIUM') acc.bySeverity.MEDIUM += aged;
      return acc;
    }, { ...empty, byMode: { ...empty.byMode }, bySeverity: { ...empty.bySeverity } });
  } catch (err) {
    process.stderr.write(`  [learning] countAgedUnremediatedAcceptances failed: ${err.message}\n`);
    return empty;
  }
}

// ── persona_audit_correlations ─────────────────────────────────────────────

/**
 * Record a correlation between a persona finding and an audit finding —
 * the highest-leverage ground-truth labelling for the bandit reward.
 * Discriminated result so the auto-correlator (WS1) can count
 * `writeFailed` in its `correlationSummary` — cloud-off / invalid-input
 * are `ok: true` (nothing to write, not a failure); a real write failure
 * is `ok: false`.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function recordPersonaAuditCorrelation(personaSessionId, correlation) {
  if (!personaSessionId || !await isCloudEnabled()) return { ok: true };
  if (!correlation?.personaFindingHash || !correlation?.correlationType || !correlation?.personaSeverity) {
    return { ok: true };
  }
  // Gemini gate R2 shadow finding 6277c9df: this function stamps
  // `hash_version: PERSONA_FINDING_HASH_VERSION` unconditionally below, but
  // until now applied no shape check on `personaFindingHash` itself — unlike
  // `upsertPersonaFindingOutcome`'s write-schema regex, the manual
  // `record-correlation` CLI repair path could supply an arbitrary or
  // v1-shaped (8-hex) value and have it persisted confidently mislabeled v2.
  // Loud rejection (not a silent `{ok:true}` no-op like the field-presence
  // guard above) — both callers already handle `ok:false` (the CLI surfaces
  // it via WRITE_FAILED; the automatic decideCorrelations loop logs and
  // continues), so failing loud here costs nothing and catches a real bug
  // class instead of persisting it.
  if (!PERSONA_FINDING_HASH_SHAPE.test(correlation.personaFindingHash)) {
    return {
      ok: false,
      error: `personaFindingHash must be a 64-hex (v2) hash — got ${JSON.stringify(correlation.personaFindingHash)}`,
    };
  }
  try {
    await withTx(async () => {
      // Retire any auto-emitted `audit_missed` (NULL audit_finding_id) row
      // for this exact (session, hash) pair FIRST — a manual repair that
      // corrects a false miss into a real match must not leave BOTH rows
      // in place (the ground truth would then simultaneously say "missed"
      // AND "confirmed" for the same finding, double-counting in the
      // bandit reward / audit_effectiveness). Harmless no-op when no such
      // row exists (a fresh manual correlation, or one repairing a
      // manual-only row). Plan: docs/plans/persona-nav-feedback-recovery.md
      // WS1 (Gemini gate round-2 finding).
      const row = {
        persona_session_id: personaSessionId,
        persona_finding_hash: correlation.personaFindingHash,
        persona_severity: correlation.personaSeverity,
        audit_finding_id: correlation.auditFindingId || null,
        audit_run_id: correlation.auditRunId || null,
        correlation_type: correlation.correlationType,
        match_score: correlation.matchScore ?? null,
        match_rationale: correlation.matchRationale || null,
        matcher_version: correlation.matcherVersion ?? null,
        // Stamped unconditionally, not threaded through `correlation` — this
        // function is the SOLE writer to persona_audit_correlations (both
        // the automatic decideCorrelations path and the manual
        // `record-correlation` CLI repair path), and there is no scenario
        // where a row written today should carry anything other than the
        // CURRENT hash-identity version (unlike matcher_version, which is a
        // genuinely call-site-varying value).
        // docs/plans/persona-finding-hash-versioning.md, Gemini gate R3 G2.
        hash_version: PERSONA_FINDING_HASH_VERSION,
      };
      if (correlation.auditFindingId) {
        // Retiring the stale NULL row first — see the function doc above.
        await deleteWhere('persona_audit_correlations', {
          persona_session_id: personaSessionId,
          persona_finding_hash: correlation.personaFindingHash,
          audit_finding_id: null,
        });
        // Real match: the 3-column unique constraint is the correct
        // conflict target (audit_finding_id is non-null here, so
        // Postgres's normal NOT-DISTINCT equality applies).
        // The lint reads the row builder's `audit_finding_id: null` DEFAULT, which this
        // branch overwrites. The null shape is handled by the else branch's partial index
        // (`conflictWhere: audit_finding_id IS NULL`) — the correct Postgres remedy for
        // NULL-distinct, not an instance of the 403k-row bug.
        // @on-conflict-ok: audit_finding_id is provably non-null on this branch — it is the `if (correlation.auditFindingId)` guard condition; detecting that needs flow analysis.
        await upsert('persona_audit_correlations', [row],
          { onConflict: ['persona_session_id', 'persona_finding_hash', 'audit_finding_id'], update: 'all' });
      } else {
        // audit_missed: audit_finding_id IS NULL is never equal to itself
        // under a plain column-list constraint (Postgres NULLs are
        // distinct), so ON CONFLICT (a,b,c) can never fire here — the
        // partial 2-column unique index (uq_correlations_missed) is the
        // ONLY conflict target that can dedupe this shape.
        await upsert('persona_audit_correlations', [row], {
          onConflict: ['persona_session_id', 'persona_finding_hash'],
          conflictWhere: 'audit_finding_id IS NULL',
          update: 'all',
        });
      }
    });
    return { ok: true };
  } catch (err) {
    process.stderr.write(`  [learning] recordPersonaAuditCorrelation failed: ${err.message}\n`);
    return { ok: false, error: err.message };
  }
}

/**
 * Retire the auto-emitted `audit_missed` correlation(s) for a
 * `persona_finding_hash` when a human dismisses/wont-fixes it via WS4's
 * outcome labels — a dismissal is a durable, repo-wide judgment that the
 * finding was never a real audit miss (e.g. an LLM hallucination), so its
 * ground-truth row must be retired the same way a manual repair retires
 * one (Gemini gate round-3 finding). Scoped ACROSS ALL SESSIONS **FOR THE
 * SAME REPO** — code-audit H5 fix (Cluster 3): the original version's
 * DELETE predicate had NO repo scope at all despite this docstring's own
 * claim, so two different repos coincidentally producing the same
 * `persona_finding_hash` (the hash has no repo/session context baked in —
 * WS1's design) could cross-contaminate each other's ground truth. Joins
 * through `persona_test_sessions.repo_id` since `persona_audit_correlations`
 * itself carries no repo column (only `persona_session_id`) —
 * `deleteWhere`'s flat-equality builder can't express a JOIN, so this uses
 * a raw parameterized statement via the same `many()` primitive every
 * other read in this module uses. `confirmed_hit`/`severity_understated`
 * rows are untouched (a status label doesn't contest a correlation's
 * truth). Best-effort: never throws.
 * @returns {Promise<number>} rows deleted
 */
export async function retireMissedCorrelationsForHash(repoId, personaFindingHash) {
  if (!repoId || !personaFindingHash || !await isCloudEnabled()) return 0;
  try {
    const rows = await many(
      `DELETE FROM persona_audit_correlations pac
        USING persona_test_sessions pts
        WHERE pac.persona_session_id = pts.id
          AND pts.repo_id = $1
          AND pac.persona_finding_hash = $2
          AND pac.audit_finding_id IS NULL
        RETURNING pac.id`,
      [repoId, personaFindingHash],
    );
    return rows.length;
  } catch (err) {
    process.stderr.write(`  [learning] retireMissedCorrelationsForHash failed: ${err.message}\n`);
    return 0;
  }
}

/**
 * Candidate audit_findings for the auto-correlator — timestamp-ordered
 * AND temporally bounded (WS1: a stale audit run must never stand in as a
 * comparison candidate for a fresh persona session — Gemini gate round-3
 * finding). Returns the last `limit` audit_runs' findings within
 * `sinceDays`, PLUS (regardless of age) the findings of the run whose
 * commit_sha exactly matches `exactCommitSha`, when given. One query, no
 * N+1. Each row carries `run_created_at` (for tie-breaking) and `run_id`.
 *
 * **The `limit` counts runs that HAVE findings, not runs.** Without the
 * EXISTS predicate a run that found nothing still spent one of the five
 * slots, so a repo that converges clean often went blind: 112 of 188 (60%)
 * of wine-cellar-app's `mode=code` runs carry zero findings, and replaying
 * every audit_run as an as-of moment, 44 of 237 (19%) built an entirely
 * empty candidate set — including the 2026-07-28 persona session, whose 3
 * real P1s correlated against nothing. Filtering takes that repo to 8 of
 * 237 (3%) and claude-engineering-skills from 1 of 426 to 0. It only ever
 * widens the window, and only over runs that already exist; an empty
 * result stays reachable (and correct) when nothing in the window found
 * anything. Measured 2026-08-11; guarded by
 * `tests/candidate-audit-findings-window.test.mjs`.
 *
 * Knock-on worth knowing: `decideCorrelations` stamps an `audit_missed`
 * row with the most recent candidate run's id, so that attribution moves
 * from "most recent run" to "most recent run that found something" — the
 * better reading of the two, since a run with no findings cannot
 * meaningfully be the one that missed a thing.
 *
 * Discriminated result — `ok: false` (a real query failure) is distinct
 * from `ok: true, rows: []` (genuinely zero candidates in window): the
 * auto-correlator's `correlationSummary.reason` needs to tell
 * `candidate-read-failed` apart from `no-candidate-runs`, and a bare
 * empty-array-on-error return would collapse that distinction (WS1).
 * @param {{ repoId: string, sinceDays?: number, limit?: number, exactCommitSha?: string|null }} args
 * @returns {Promise<{ok: boolean, rows: object[], error?: string}>}
 */
export async function getCandidateAuditFindings({ repoId, sinceDays = 14, limit = 5, exactCommitSha = null }) {
  if (!repoId || !await isCloudEnabled()) return { ok: true, rows: [] };
  try {
    const runs = await many(
      `SELECT id, created_at FROM audit_runs
        WHERE repo_id = $1
          AND (created_at >= now() - ($2 || ' days')::interval
               OR commit_sha = $3)
          AND EXISTS (SELECT 1 FROM audit_findings af WHERE af.run_id = audit_runs.id)
        ORDER BY created_at DESC
        LIMIT $4`,
      [repoId, String(sinceDays), exactCommitSha, limit],
    );
    if (runs.length === 0) return { ok: true, rows: [] };
    const runIds = runs.map((r) => r.id);
    const runCreatedAt = new Map(runs.map((r) => [r.id, r.created_at]));
    const findings = await many(
      `SELECT id, run_id, finding_fingerprint, severity, category,
              primary_file, detail_snapshot
         FROM audit_findings
        WHERE run_id = ANY($1)`,
      [runIds],
    );
    return { ok: true, rows: findings.map((f) => ({ ...f, run_created_at: runCreatedAt.get(f.run_id) })) };
  } catch (err) {
    process.stderr.write(`  [learning] getCandidateAuditFindings failed: ${err.message}\n`);
    return { ok: false, rows: [], error: err.message };
  }
}

/**
 * Existing correlation hashes for ONE session — the batched existence
 * read the auto-correlator uses to enforce "first hit wins per finding"
 * without a per-finding query (WS1). Discriminated result for the same
 * reason as `getCandidateAuditFindings` — a read failure must map to
 * `correlationSummary.reason = 'existence-check-failed'`, not silently
 * behave as "nothing exists yet" (which would double-emit on a retry).
 * @param {string} personaSessionId
 * @returns {Promise<{ok: boolean, hashes: Set<string>, error?: string}>}
 */
export async function getExistingCorrelationHashesForSession(personaSessionId) {
  if (!personaSessionId || !await isCloudEnabled()) return { ok: true, hashes: new Set() };
  try {
    const rows = await many(
      `SELECT DISTINCT persona_finding_hash FROM persona_audit_correlations WHERE persona_session_id = $1`,
      [personaSessionId],
    );
    return { ok: true, hashes: new Set(rows.map((r) => r.persona_finding_hash)) };
  } catch (err) {
    process.stderr.write(`  [learning] getExistingCorrelationHashesForSession failed: ${err.message}\n`);
    return { ok: false, hashes: new Set(), error: err.message };
  }
}

/** Read correlations for a specific audit_run. */
export async function readCorrelationsForRun(auditRunId) {
  if (!auditRunId || !await isCloudEnabled()) return [];
  try {
    return await many(`SELECT * FROM persona_audit_correlations WHERE audit_run_id = $1`, [auditRunId]);
  } catch (err) {
    process.stderr.write(`  [learning] readCorrelationsForRun failed: ${err.message}\n`);
    return [];
  }
}

/** Read correlations for a specific audit finding. */
export async function readCorrelationsForFinding(auditFindingId) {
  if (!auditFindingId || !await isCloudEnabled()) return [];
  try {
    return await many(`SELECT * FROM persona_audit_correlations WHERE audit_finding_id = $1`, [auditFindingId]);
  } catch (err) {
    process.stderr.write(`  [learning] readCorrelationsForFinding failed: ${err.message}\n`);
    return [];
  }
}

/** Read the audit_effectiveness view rollup for a repo. */
export async function readAuditEffectiveness(repoId) {
  if (!await isCloudEnabled()) return null;
  try {
    return await one(`SELECT * FROM audit_effectiveness WHERE repo_id = $1 LIMIT 1`, [repoId]);
  } catch (err) {
    process.stderr.write(`  [learning] readAuditEffectiveness failed: ${err.message}\n`);
    return null;
  }
}

/**
 * Per-repo correlation counts by type — WS4 the dashboard tab needs to
 * turn WS1's correlator output into a visible surface ("the correlation
 * loop health line"). `persona_audit_correlations` carries no `repo_id`
 * column (only `persona_session_id`, same as the code-audit H5 fix
 * `retireMissedCorrelationsForHash` closed), so this joins through
 * `persona_test_sessions.repo_id`.
 * @returns {Promise<{ok: boolean, byType: Array<{type: string, count: number}>, total: number, error?: string}>}
 */
export async function readCorrelationCountsByType(repoId) {
  if (!repoId) return { ok: false, byType: [], total: 0, error: 'repoId is required' };
  if (!await isCloudEnabled()) return { ok: true, byType: [], total: 0 };
  try {
    const rows = await many(
      `SELECT pac.correlation_type, count(*) AS n
         FROM persona_audit_correlations pac
         JOIN persona_test_sessions pts ON pts.id = pac.persona_session_id
        WHERE pts.repo_id = $1
        GROUP BY pac.correlation_type`,
      [repoId],
    );
    const byType = rows.map((r) => ({ type: r.correlation_type, count: Number(r.n) || 0 }));
    const total = byType.reduce((sum, r) => sum + r.count, 0);
    return { ok: true, byType, total };
  } catch (err) {
    process.stderr.write(`  [learning] readCorrelationCountsByType failed: ${err.message}\n`);
    return { ok: false, byType: [], total: 0, error: err.message };
  }
}

// ── plan_verification_runs / plan_verification_items ───────────────────────

/**
 * Record one /ux-lock-verify run; returns the run UUID.
 */
export async function recordPlanVerificationRun(run) {
  if (!run?.planId || !await isCloudEnabled()) return null;
  const row = {
    plan_id: run.planId,
    spec_id: run.specId || null,
    commit_sha: run.commitSha || null,
    url: run.url || null,
    total_criteria: run.totalCriteria || 0,
    passed_count: run.passedCount || 0,
    failed_count: run.failedCount || 0,
    skipped_count: run.skippedCount || 0,
    duration_ms: run.durationMs || null,
    run_context: run.runContext || 'ux-lock-verify',
  };
  // Optional selector-policy telemetry (plan: ux-lock-selector-policy).
  if (run.selectorPolicyViolations != null) row.selector_policy_violations = run.selectorPolicyViolations;
  try {
    const out = await insertRunRowWithPolicyFallback('plan_verification_runs', row, { returning: ['id'] });
    return out?.id ?? null;
  } catch (err) {
    process.stderr.write(`  [learning] recordPlanVerificationRun failed: ${err.message}\n`);
    return null;
  }
}

/**
 * Record per-criterion outcomes for a verification run.
 *
 * Returns `{ok, inserted, reason}` rather than `undefined`. Every failure path
 * below logs to stderr and swallows, so a caller that infers a count from
 * `items.length` reports a persistence result this function never established —
 * which is exactly what `cross-skill.mjs record-plan-verify-items` did. `inserted`
 * is the row count Postgres accepted, not the row count we asked it to accept.
 */
export async function recordPlanVerificationItems(runId, planId, items) {
  if (!runId || !planId || !Array.isArray(items) || items.length === 0) {
    return { ok: false, inserted: 0, reason: 'bad-input' };
  }
  if (!await isCloudEnabled()) return { ok: true, inserted: 0, reason: 'cloud-off' };
  const rows = items.map((item) => ({
    run_id: runId,
    plan_id: planId,
    criterion_hash: item.criterionHash,
    criterion_index: item.criterionIndex,
    severity: item.severity,
    category: item.category,
    description: item.description,
    setup_text: item.setupText || null,
    assert_text: item.assertText || null,
    passed: !!item.passed,
    skipped: !!item.skipped,
    error_message: item.errorMessage || null,
    duration_ms: item.durationMs || null,
  }));
  const pool = await getPool();
  if (!pool) return { ok: false, inserted: 0, reason: 'no-pool' };
  const insertItems = async (omitSkipped) => {
    const cols = Object.keys(rows[0]).filter((c) => !(omitSkipped && c === 'skipped'));
    const params = [];
    const valueGroups = rows.map((row) => {
      const placeholders = cols.map((c) => {
        params.push(row[c]);
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    const res = await pool.query(
      `INSERT INTO plan_verification_items (${cols.map((c) => `"${c}"`).join(', ')})
       VALUES ${valueGroups.join(', ')}`,
      params
    );
    return res?.rowCount ?? 0;
  };
  try {
    return { ok: true, inserted: await insertItems(false) };
  } catch (err) {
    // 42703-only: consumer DB predates the `skipped` column (migration
    // 20260704…) — retry once without it so the per-criterion rows aren't lost.
    if (err?.code === '42703' && 'skipped' in rows[0]) {
      process.stderr.write('  [learning] plan_verification_items.skipped missing — run setup-postgres --migrate; recording without it\n');
      try { return { ok: true, inserted: await insertItems(true) }; }
      catch (retryErr) {
        process.stderr.write(`  [learning] recordPlanVerificationItems failed: ${retryErr.message}\n`);
        return { ok: false, inserted: 0, reason: retryErr.message };
      }
    }
    process.stderr.write(`  [learning] recordPlanVerificationItems failed: ${err.message}\n`);
    return { ok: false, inserted: 0, reason: err.message };
  }
}

/** Read the plan_satisfaction view (latest run + failing P0/P1). */
export async function readPlanSatisfaction(planId) {
  if (!planId || !await isCloudEnabled()) return null;
  try {
    return await one(`SELECT * FROM plan_satisfaction WHERE plan_id = $1 LIMIT 1`, [planId]);
  } catch (err) {
    process.stderr.write(`  [learning] readPlanSatisfaction failed: ${err.message}\n`);
    return null;
  }
}

/** Read criteria failing across recent verification runs. */
export async function readPersistentPlanFailures(planId) {
  if (!planId || !await isCloudEnabled()) return [];
  try {
    return await many(`SELECT * FROM persistent_plan_failures WHERE plan_id = $1`, [planId]);
  } catch (err) {
    process.stderr.write(`  [learning] readPersistentPlanFailures failed: ${err.message}\n`);
    return [];
  }
}

// ── ship_events ────────────────────────────────────────────────────────────

/**
 * Record a /ship outcome.
 *
 * Returns a discriminated status for the same reason as
 * `recordRegressionSpecRun` above — it used to swallow write errors and return
 * `undefined` while its sole caller emitted an unconditional `{ok:true}`.
 *
 * @returns {Promise<{ok:boolean, cloud:boolean, reason?:string, error?:string}>}
 */
export async function recordShipEvent(repoId, event) {
  if (!event?.outcome) return { ok: false, cloud: false, reason: 'missing-outcome' };
  if (!await isCloudEnabled()) return { ok: true, cloud: false, reason: 'cloud-off' };
  try {
    await insertReturning('ship_events', {
      repo_id: repoId || null,
      commit_sha: event.commitSha || null,
      branch: event.branch || null,
      outcome: event.outcome,
      block_reasons: event.blockReasons || [], // jsonb — serialized by the db-layer seam
      open_p0_count: event.openP0Count || 0,
      open_p1_count: event.openP1Count || 0,
      missing_spec_count: event.missingSpecCount || 0,
      overridden_by_user: !!event.overriddenByUser,
      override_flag: event.overrideFlag || null,
      stack_detected: event.stackDetected || null,
      framework: event.framework || null,
      duration_ms: event.durationMs || null,
    });
    return { ok: true, cloud: true };
  } catch (err) {
    process.stderr.write(`  [learning] recordShipEvent failed: ${err.message}\n`);
    return { ok: false, cloud: true, reason: 'write-failed', error: err.message };
  }
}

/**
 * Read ship-event health for a repo (Cluster D / Phase 7 dashboard).
 * Returns per-outcome counts + the most recent events, or null when cloud is
 * off / the query fails. Repo-scoped (the caller resolves the canonical id).
 *
 * @param {string} repoId
 * @param {{limit?: number}} [opts]
 * @returns {Promise<{byOutcome: Array<{outcome:string,count:number}>, recent: object[]}|null>}
 */
export async function readShipEvents(repoId, { limit = 10 } = {}) {
  if (!repoId || !await isCloudEnabled()) return null;
  try {
    const byOutcome = await many(
      `SELECT outcome, count(*)::int AS count FROM ship_events
        WHERE repo_id = $1 GROUP BY outcome ORDER BY count DESC`,
      [repoId],
    );
    const recent = await many(
      `SELECT outcome, branch, commit_sha, overridden_by_user, created_at
         FROM ship_events WHERE repo_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [repoId, limit],
    );
    return { byOutcome, recent };
  } catch (err) {
    process.stderr.write(`  [learning] readShipEvents failed: ${err.message}\n`);
    return null;
  }
}

