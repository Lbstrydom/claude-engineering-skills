/**
 * @fileoverview The /ship-nudge readers — the `unlocked_fixes` and
 * `unremediated_acceptances` view families, and the one repo fence they share.
 *
 * Split out of `plans-ship.mjs` (cross-skill-command-registry Phase 6). That
 * module is now a re-export barrel and remains the import name every consumer
 * uses.
 *
 * **This is a SIXTH module where the plan specified five, and the extra one is
 * load-bearing.** The plan's five domains were the five tables; these readers
 * span two view families that belong to none of them — `unlocked_fixes` sits
 * across `audit_findings` and `regression_specs`, `unremediated_acceptances`
 * across `audit_findings` and `finding_adjudication_events`. Filing them under
 * the table each *resembles* would have split `resolveExplicitRepoScope` in
 * two, and that function's own docstring is explicit that being ONE shared
 * function is the whole point: the 207-vs-0 cross-tenant leak recurred
 * precisely because a sibling reader was added without taking the fence. A
 * mechanical refactor that duplicates a single-oracle fence is not mechanical.
 *
 * Three properties are asserted STATICALLY against this file's source by
 * `tests/cross-skill-unlocked-scope.test.mjs` — every nudge-view reader routes
 * through the fence, every paged read imposes its own TOTAL order before its
 * LIMIT, and each capped reader has a counter. So:
 *
 *   **Keep the SQL and the ORDER BY literal, spelled out per branch.**
 *
 * A hoisted `const order` interpolated as `${order}`, or a `FROM ${view}`, is
 * invisible to a static scan: the guard goes green while reading the
 * placeholder. That is not hypothetical — an interpolated view name silently
 * removed two of seven readers from the fence scan on 2026-08-11, and the
 * remaining five still cleared the floor of the day. The scan's floors are set
 * AT the real counts for that reason; raise them deliberately when a reader is
 * added.
 *
 * @module scripts/lib/store/ship-nudges
 */

import { isCloudEnabled } from './repo.mjs';
import { many } from '../db/query.mjs';

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
    // `=== true`, not truthiness. Every caller today passes a real boolean
    // (`ctx.hasFlag('all-repos')` or the literal `true`), so this changes no
    // reachable behaviour — but on a TENANT boundary "truthy counts as yes" is
    // the wrong default to leave armed. A JSON payload carrying
    // `{"allRepos": "false"}` would otherwise authorise a cross-repo read by
    // being a non-empty string, and this fence exists precisely because global
    // access must be ASKED for. Under the strict test a non-boolean falls
    // through to the throw below — a refusal, never a widening.
    if (allRepos === true && repoId) {
      throw new Error(`${fnName}: pass EITHER {repoId} OR {allRepos:true}, never both — the intent is ambiguous.`);
    }
    if (allRepos === true) return { repoId: null, allRepos: true };
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
 * **Reads `unlocked_fixes_all`, NOT the windowed `unlocked_fixes` (fixed
 * 2026-08-29).** The sampler above is windowed on purpose — it feeds a
 * pre-push nudge, and an unbounded nudge becomes noise. This lookup is the
 * CLOSE path, and an obligation does not expire just because the reminder
 * stopped printing it. Scoped to the windowed view, it refused every row past
 * 14 days: measured on this repo, all 125 `agedOut` rows (73 code / 52 plan)
 * that `/ship` Step 0.5b had just told the operator to "lock, or write off"
 * were unclosable by the only command the step names. The step's own
 * "waiting is not a way to clear this gate" line was therefore unfollowable —
 * waiting was the only thing that could happen to them.
 *
 * The read and the writer agreed about the KEY (`audit_finding_id` is
 * projected by both) and disagreed about the ROW SET, which is why
 * `view-writer-key-contract.test.mjs`'s projection axis could not see it. That
 * file now carries an eligibility axis too.
 *
 * @param {{repoId: string, findingId: string}} a
 * @returns {Promise<object|null>}
 */
export async function findUnlockedFixInRepo({ repoId, findingId }) {
  if (!repoId || !findingId) throw new Error('findUnlockedFixInRepo: both repoId and findingId are required');
  if (!await isCloudEnabled()) return null;
  try {
    const rows = await many(
      `SELECT * FROM unlocked_fixes_all WHERE repo_id = $1 AND audit_finding_id = $2 LIMIT 1`,
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

/**
 * Embeddings for a set of findings, for read-time work-unit grouping.
 *
 * Returns a Map so a caller can tell "this finding has no embedding" from "this
 * finding is not in the result" — the two are the same thing here, and both must
 * surface as `unclustered` rather than being dropped. A finding with no
 * embedding was never COMPARED to anything; treating that as "belongs to no
 * unit" would be indistinguishable from "compared and found unrelated".
 *
 * Scoping: `finding_embeddings` carries no `repo_id` of its own, so this is
 * scoped by the caller supplying ids it already read under a repo scope — the
 * same unit `persistKeptEmbeddings` trusts. It reads nothing the caller could
 * not already read.
 *
 * @param {string[]} findingIds
 * @returns {Promise<Map<string, number[]>>}
 */
export async function getFindingEmbeddings(findingIds) {
  const out = new Map();
  if (!Array.isArray(findingIds) || findingIds.length === 0) return out;
  if (!await isCloudEnabled()) return out;
  try {
    const rows = await many(
      `SELECT finding_id, embedding::text AS vec
         FROM finding_embeddings
        WHERE finding_id = ANY($1::uuid[]) AND embedding IS NOT NULL`,
      [findingIds]);
    for (const r of rows) {
      const vec = String(r.vec).slice(1, -1).split(',').map(Number);
      if (vec.length > 0 && vec.every(Number.isFinite)) out.set(r.finding_id, vec);
    }
  } catch (err) {
    // Degrade to "nothing embedded" → every row reports `unclustered`, which is
    // honest (we compared nothing) and never blocks the gate it serves.
    process.stderr.write(`  [learning] getFindingEmbeddings failed: ${err.message}\n`);
  }
  return out;
}
