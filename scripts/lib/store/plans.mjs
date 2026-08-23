/**
 * @fileoverview The `plans` table — path validation, upsert, id lookup, status.
 *
 * Split out of `plans-ship.mjs` (cross-skill-command-registry Phase 6). That
 * module is now a re-export barrel and remains the import name every consumer
 * uses; this file is where the plans domain actually lives.
 *
 * `plans` is the join target for `audit_runs.plan_id`, so a junk row here
 * degrades every effectiveness query built over it — which is why
 * `validatePlanPath` exists and why `upsertPlan` reports a discriminated
 * `{ok, reason}` rather than a bare null.
 *
 * @module scripts/lib/store/plans
 */

import path from 'node:path';
import { findRepoRootFromCwd } from '../assert-repo-root.mjs';
import { isCloudEnabled } from './repo.mjs';
import { one, upsert, updateWhere } from '../db/query.mjs';
import { runWindowCountQuery } from './window-count-query.mjs';
import { DB_PLAN_STATUSES, toDbPlanStatus } from '../status-vocabulary.mjs';

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

  // The identifier must be derived by the SAME comparison that admitted the
  // path. `path.relative` is case-sensitive on POSIX — including darwin, whose
  // filesystem is not — so on a case-insensitive platform the containment check
  // above could PASS a differently-cased root while `path.relative` answered
  // `../../Foo/repo/docs/x.md`: a traversal-shaped string, stored as `plans.path`
  // and used as the `getPlanIdByPath` lookup key. Adding darwin to `ci` (earlier
  // today) fixed the false rejection and left this half behind — the containment
  // and the identifier stopped agreeing about what the root is, which is the
  // same two-halves-disagree defect the `\`→`/` normalisation above records one
  // line earlier. Slicing is safe precisely because containment already
  // established that `abs` starts with `root` under `cmp`.
  const rel = (ci
    ? abs.slice(root.length).replace(/^[\\/]+/, '')
    : path.relative(root, abs)
  ).replace(/\\/g, '/');
  if (!rel) {
    return { ok: false, reason: 'escapes-repo', message: `plan path resolves to the repo root itself: ${raw}` };
  }
  return { ok: true, path: rel };
}

/**
 * Upsert a plan artefact. Idempotent on `(repo_id, path)`.
 *
 * **Returns a DISCRIMINATED RESULT, never a bare id** (durability plan
 * decision 6, Phase 5). This function used to return `null` for five different
 * things — missing input, cloud off, an out-of-repo path, an unresolved repoId,
 * and a caught DB failure — and every caller read that one value as "no plan".
 * A store outage was therefore indistinguishable from "this run has no plan",
 * which is shape B of the defect this plan exists for: *failure wearing
 * success's clothes*. The audit paths then proceeded to record a run with
 * `plan_id: null`, which reads as a deliberate ad-hoc audit rather than as lost
 * linkage.
 *
 * Mirrors `getPlanIdByPath` below, which already had this shape — the two are
 * the same question asked in two directions and should answer alike.
 *
 * @returns {Promise<{ok:true, planId:string}
 *                  |{ok:false, reason:'cloud-off'|'invalid-input'|'write-failed',
 *                    message:string, error?:unknown}>}
 *   - `cloud-off`     — the store is disabled. Today's normal path; proceed silently.
 *   - `invalid-input` — missing `path`/`skill`, a path outside the repo, or an
 *                       unresolved `repoId`. A caller bug: log and proceed.
 *   - `write-failed`  — the DB rejected it or was unreachable. REPORT it; this
 *                       is the one that must never be read as "no plan".
 */
export async function upsertPlan(repoId, plan) {
  if (!plan?.path || !plan?.skill) {
    return { ok: false, reason: 'invalid-input', message: 'upsertPlan requires both `path` and `skill`' };
  }
  // Path validation runs BEFORE the cloud check (moved 2026-08-12, Phase 5).
  // A malformed or out-of-repo path is a caller bug whatever the store is
  // doing, and answering `cloud-off` hid it: a local-only user would never
  // learn their plan path was wrong, and would discover it only when enabling
  // the store later. `getPlanIdByPath` below already validated first — these
  // two are the same question asked in opposite directions and must answer
  // alike. Found by the Phase 5 contract test, which asserted the ordering this
  // docstring claimed and got `cloud-off` back.
  // Validated HERE rather than at the CLI boundary because `upsertPlan` is the
  // real chokepoint — three callers reach it (cross-skill.mjs, the code-audit
  // path in legacy-production-audit.mjs, and plan-audit-cloud.mjs), and two of
  // those pass a user-supplied `--plan` argument straight through. Guarding
  // only the CLI would have left the audit paths open, which is where the
  // scratchpad rows most likely entered.
  //
  // Returns a result rather than throwing: a bad path costs the link, never the
  // audit. The warning is what makes it non-silent; the `reason` is what makes
  // it distinguishable from a store failure at the call site.
  const validated = validatePlanPath(plan.path);
  if (!validated.ok) {
    process.stderr.write(`  [learning] upsertPlan: ${validated.message}\n`);
    return { ok: false, reason: 'invalid-input', message: validated.message };
  }
  // Same normalisation `updatePlanStatus` writes through (27caf508): the
  // markdown surface and the `plans_status_check` CHECK constraint spell the
  // same vocabulary two ways, and this was the one write path that skipped
  // reconciling them — a caller passing the markdown spelling ("In Progress")
  // hit a raw CHECK-constraint failure here while the exact same value
  // succeeds through `updatePlanStatus`. Validated alongside the path above,
  // BEFORE the cloud check, for the same reason: a caller bug costs the
  // link whether or not the store is enabled, and a confusing driver-level
  // CHECK-constraint error is worse than a clear one here.
  const normalisedStatus = toDbPlanStatus(plan.status || 'draft');
  if (!DB_PLAN_STATUSES.includes(normalisedStatus)) {
    const message = `upsertPlan: '${plan.status}' is not a valid status (expected one of: ${DB_PLAN_STATUSES.join(', ')})`;
    process.stderr.write(`  [learning] ${message}\n`);
    return { ok: false, reason: 'invalid-input', message };
  }
  if (!await isCloudEnabled()) {
    return { ok: false, reason: 'cloud-off', message: 'cloud store is disabled' };
  }
  if (!repoId) {
    // Idempotence is claimed on (repo_id, path), a FULL unique index. A NULL
    // repo_id is distinct from every other NULL in Postgres, so a null here
    // INSERTs a duplicate plan row on every call instead of updating — same
    // defect class as recordRegressionSpec's repoId guard. Refuse.
    const message = 'upsertPlan requires a resolved repoId (NULL would duplicate on the (repo_id, path) unique index)';
    process.stderr.write(`  [learning] ${message}\n`);
    return { ok: false, reason: 'invalid-input', message };
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
      status: normalisedStatus,
      principles_cited: plan.principlesCited || [],   // jsonb — serialized by the db-layer seam
      focus_areas: plan.focusAreas || [],
      commit_sha: plan.commitSha || null,
      checksum: plan.checksum || null,
      updated_at: new Date().toISOString(),
    }], { onConflict: ['repo_id', 'path'], update: 'all', returning: ['id'] });
    const planId = rows[0]?.id ?? null;
    if (!planId) {
      // An upsert that returned no row did not verify. Postgres reports success
      // for a statement that affected nothing, and reporting `ok:true` with a
      // null id would hand the caller back exactly the ambiguous value this
      // change removes — the unverified-write-success class.
      const message = 'upsert returned no row — the write did not verify';
      process.stderr.write(`  [learning] upsertPlan: ${message}\n`);
      return { ok: false, reason: 'write-failed', message };
    }
    return { ok: true, planId };
  } catch (err) {
    process.stderr.write(`  [learning] upsertPlan failed: ${err.message}\n`);
    return { ok: false, reason: 'write-failed', message: err.message, error: err };
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

/**
 * Window-scoped row counts for the skill-efficacy census
 * (docs/plans/skill-efficacy-census.md Phase 2). Scoped to `skill='plan'`
 * (the `/plan` skill's own rows) — `manual` rows are a different, non-skill
 * source and are excluded per §2's contract table.
 *
 * @param {string} repoId
 * @param {{currentStart: string, priorStart: string, now: string}} bounds ISO timestamps
 * @returns {Promise<{current: number, prior: number, allTime: number}|null>}
 */
export async function getPlanWindowCounts(repoId, { currentStart, priorStart, now }) {
  return runWindowCountQuery({
    repoGuard: repoId, table: 'plans', extraFilter: { column: 'skill', value: 'plan' },
    params: [repoId, currentStart, now, priorStart],
    errorLabel: 'getPlanWindowCounts',
  });
}
