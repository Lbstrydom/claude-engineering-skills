/**
 * @fileoverview GitHub facts for /fleet — open PRs and their checks, or an
 * explicit "not queried".
 *
 * `gh` missing, unauthenticated, offline or pointed at a non-GitHub remote all
 * become `{queried:false, reason}`; a caller renders that as
 * `PRs: not queried (<reason>)`, never as an empty list. Nothing here throws.
 *
 * Only REAL `gh pr list/view --json` field names are requested. The recorded
 * field list in `tests/fixtures/fleet/gh-pr-view-fields.json` is the contract a
 * test checks `PR_LIST_FIELDS` / `PR_VIEW_FIELDS` against, so a fake `gh` in a
 * later test cannot accept a field the real CLI would reject.
 *
 * Plan: docs/plans/fleet-multi-session-coordination.md §2 (source identity), §7.
 *
 * @module scripts/lib/fleet/gh-facts
 */
import { spawnSync } from 'node:child_process';
import { runGit, headOf } from './git-facts.mjs';

/** Fields `listPullRequests` requests from `gh pr list`. */
export const PR_LIST_FIELDS = Object.freeze([
  'number', 'title', 'url', 'state', 'isDraft', 'isCrossRepository',
  'headRefName', 'headRefOid', 'headRepository', 'headRepositoryOwner',
  'baseRefName', 'baseRefOid', 'updatedAt', 'autoMergeRequest', 'mergeStateStatus',
]);

/**
 * Fields of the SECOND, optional `gh pr list` call. `statusCheckRollup` lives
 * apart from the PR list because a token that cannot read check rollups 403s the
 * whole call it rides in — one column's fault must not cost the table.
 */
export const PR_CHECK_FIELDS = Object.freeze(['number', 'headRefOid', 'statusCheckRollup']);

/** Checks state of a PR whose rollup was not (or could not be) matched. Never a pass. */
export const UNKNOWN_CHECKS = Object.freeze({ state: 'unknown', total: null });

/** Fields `land --confirm` requests from `gh pr view` (§2: not `baseRepository`). */
export const PR_VIEW_FIELDS = Object.freeze([
  'state', 'baseRefName', 'headRefOid', 'mergeCommit', 'url',
]);

const GH_TIMEOUT_MS = 30_000;

function nowIso() { return new Date().toISOString(); }

/**
 * Classify a failed `gh` run into a short reason. Prose-shaped on purpose and
 * every unrecognised failure is still a reason — never an empty list.
 * @param {string} stderr
 * @returns {string}
 */
export function classifyGhFailure(stderr) {
  const s = String(stderr);
  if (/gh auth login|not logged in|authentication|GH_TOKEN|HTTP 401/i.test(s)) return 'gh not authenticated';
  if (/none of the git remotes|not a git repository|could not determine|no git remotes/i.test(s)) return 'no GitHub remote';
  if (/could not resolve host|network|timed out|dial tcp|connection/i.test(s)) return 'gh offline';
  const first = s.trim().split('\n')[0];
  return `gh failed: ${first || 'no output'}`;
}

const CHECKS_FORBIDDEN_RE = /HTTP 403|Resource not accessible|insufficient (?:scope|permission)/i;

/** Reason for a failed CHECKS call: a 403 names the token, anything else is the generic reason. */
export function classifyChecksFailure(stderr) {
  return CHECKS_FORBIDDEN_RE.test(String(stderr)) ? 'checks not readable with this token (403)' : classifyGhFailure(stderr);
}

/**
 * `owner/name` from a PR url (`https://github.com/o/n/pull/7`); `baseRepository`
 * is not a `gh pr` JSON field, so the url is the source.
 * @param {string} url
 * @returns {string|null}
 */
export function repoFromPrUrl(url) {
  const m = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(String(url ?? ''));
  return m ? `${m[1]}/${m[2]}` : null;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** A string, or '' for anything else — never calls a hostile toString. */
const str = (v) => (typeof v === 'string' ? v : '');
const strOrAbsent = (v) => v === undefined || v === null || typeof v === 'string';

/**
 * Collapse `statusCheckRollup` into one honest summary.
 * `none` = no checks reported (not the same as passing). A SKIPPED check does
 * not fail the rollup, but it is COUNTED (`skipped`) rather than silently folded
 * into success: whether a REQUIRED check actually ran is `required-checks.mjs`'s
 * question, and this summary must not read as its answer.
 * @param {Array<object>|null|undefined} rollup
 * @returns {{state: 'success'|'failure'|'pending'|'none', total: number, skipped?: number}}
 */
export function summariseChecks(rollup) {
  const list = Array.isArray(rollup) ? rollup : [];
  if (list.length === 0) return { state: 'none', total: 0 };
  const bad = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED'];
  const good = ['SUCCESS', 'NEUTRAL', 'SKIPPED'];
  let pending = false; let skipped = 0; let failed = false;
  for (const c of list) {
    if (!isObj(c)) { pending = true; continue; } // a malformed record is never a pass
    const verdict = (str(c.conclusion) || str(c.state)).toUpperCase();
    if (verdict === 'SKIPPED') skipped += 1;
    const status = (str(c.status) || 'COMPLETED').toUpperCase();
    if (bad.includes(verdict)) failed = true;
    else if (status !== 'COMPLETED' || !good.includes(verdict)) pending = true;
  }
  return { state: failed ? 'failure' : pending ? 'pending' : 'success', total: list.length, ...(skipped ? { skipped } : {}) };
}

/**
 * Why a raw row cannot be normalised, or null. Validates the row AND each nested
 * check record, so malformed gh output becomes a reported invalid item, never a throw.
 * @returns {string|null}
 */
export function validatePrRow(raw) {
  if (!isObj(raw)) return 'row is not an object';
  if (!Number.isInteger(raw.number) || raw.number <= 0) return 'missing or invalid number';
  if (!strOrAbsent(raw.state) || !strOrAbsent(raw.updatedAt)) return 'state/updatedAt is not a string';
  for (const k of ['isDraft', 'isCrossRepository']) {
    if (raw[k] !== undefined && raw[k] !== null && typeof raw[k] !== 'boolean') return `${k} is not a boolean`;
  }
  for (const [k, sub] of [['headRepository', 'name'], ['headRepositoryOwner', 'login']]) {
    const v = raw[k];
    if (v === undefined || v === null) continue;
    if (!isObj(v) || !strOrAbsent(v[sub])) return `${k}.${sub} is not a string`;
  }
  for (const k of ['headRefName', 'headRefOid', 'baseRefName', 'baseRefOid', 'title', 'url']) {
    if (raw[k] !== undefined && raw[k] !== null && typeof raw[k] !== 'string') return `${k} is not a string`;
  }
  // Identity fields: a row without them cannot be joined to a branch or landed,
  // and reporting it as a complete row would read as "no PR information" rather
  // than "malformed row". `gh pr list` always returns these when requested.
  for (const k of ['headRefName', 'headRefOid', 'baseRefName', 'url']) {
    if (typeof raw[k] !== 'string' || raw[k] === '') return `missing identity field ${k}`;
  }
  return null;
}

/**
 * Why a raw checks row cannot be trusted, or null. A PR whose row fails this is
 * left `unknown` — a malformed rollup is never a pass and never `none`.
 * @returns {string|null}
 */
export function validateChecksRow(raw) {
  if (!isObj(raw)) return 'row is not an object';
  if (!Number.isInteger(raw.number) || raw.number <= 0) return 'missing or invalid number';
  const r = raw.statusCheckRollup;
  if (r === null || r === undefined) return 'statusCheckRollup is absent';
  if (!Array.isArray(r)) return 'statusCheckRollup is not an array';
  if (r.some((c) => !isObj(c))) return 'statusCheckRollup contains a non-object record';
  for (const c of r) {
    for (const k of ['conclusion', 'state', 'status']) if (!strOrAbsent(c[k])) return `check ${k} is not a string`;
  }
  return null;
}

/**
 * Normalise one raw `gh pr list --json` row (call `validatePrRow` first).
 * `checks` starts `unknown`; `attachChecks` upgrades it from a matching row.
 * @param {object} raw
 */
export function normalisePr(raw) {
  const owner = raw.headRepositoryOwner?.login ?? null;
  const name = raw.headRepository?.name ?? null;
  return {
    number: raw.number,
    title: raw.title ?? '',
    url: raw.url ?? null,
    repo: repoFromPrUrl(raw.url),
    headRepo: owner && name ? `${owner}/${name}` : null,
    headRef: raw.headRefName ?? null,
    headOid: raw.headRefOid ?? null,
    baseRef: raw.baseRefName ?? null,
    baseOid: raw.baseRefOid ?? null,
    state: str(raw.state).toLowerCase(),
    isDraft: Boolean(raw.isDraft),
    isCrossRepository: Boolean(raw.isCrossRepository),
    checks: UNKNOWN_CHECKS,
    updatedAt: raw.updatedAt ?? null,
    autoMerge: isObj(raw.autoMergeRequest),
    mergeState: typeof raw.mergeStateStatus === 'string' ? raw.mergeStateStatus.toUpperCase() : null,
  };
}

/** Minutes a green, CLEAN, auto-merge-armed PR may sit unmerged before status calls it a possible hang. */
export const AUTO_MERGE_HANG_MINUTES = 15;

/**
 * Advisory warnings about how a PR is set to merge, from the PR list alone:
 *  - a DRAFT with auto-merge armed merges the moment it is marked ready, on
 *    whatever checks ran (or were skipped) while it was a draft;
 *  - green + CLEAN + auto-merge armed + unmerged for a while: auto-merge may be
 *    hung and need re-arming.
 * @param {ReturnType<typeof normalisePr>} pr
 * @param {number|null} nowMs
 * @returns {string[]}
 */
export function prWarnings(pr, nowMs) {
  const out = [];
  if (!pr) return out;
  if (pr.isDraft && pr.autoMerge) out.push(`PR #${pr.number} is a DRAFT with auto-merge armed — marking it ready merges on draft-time (possibly skipped) checks; disarm auto-merge, mark ready, let required checks run, then merge`);
  const idleMs = nowMs !== null && pr.updatedAt ? nowMs - Date.parse(pr.updatedAt) : NaN;
  // A rollup with skipped checks is not 'green' here: re-arming auto-merge over a skipped REQUIRED check is the #802 defect.
  if (!pr.isDraft && pr.autoMerge && pr.checks?.state === 'success' && !pr.checks.skipped && pr.mergeState === 'CLEAN' && idleMs > AUTO_MERGE_HANG_MINUTES * 60_000) {
    out.push(`PR #${pr.number}: checks green and CLEAN with auto-merge armed, but unmerged for ${Math.round(idleMs / 60_000)} min — auto-merge may be hung; confirm its required checks ran (gh pr checks ${pr.number} --required), then re-arm with gh pr merge ${pr.number} --auto`);
  }
  return out;
}

/** `gh pr list --limit`; a result of exactly this many rows cannot prove there are no more. */
export const PR_LIMIT = 200;

/**
 * Parse `gh pr list --json` stdout. Pure; never throws.
 * `complete:false` when the list may be truncated at `limit` or any row was invalid.
 * @param {string} text
 * @param {{limit?: number, observedAt?: string}} [opts]
 */
export function parsePrList(text, { limit = PR_LIMIT, observedAt = nowIso() } = {}) {
  let rows;
  try { rows = JSON.parse(String(text)); } catch {
    return { queried: false, complete: false, limit, observedAt, reason: 'gh returned unparseable JSON', prs: [] };
  }
  if (!Array.isArray(rows)) return { queried: false, complete: false, limit, observedAt, reason: 'gh returned a non-list', prs: [] };
  const prs = []; const invalid = [];
  rows.forEach((row, index) => {
    const why = validatePrRow(row);
    if (why) { invalid.push({ index, reason: why }); return; }
    // Structural backstop: whatever validation missed, a throw becomes an invalid item.
    try { prs.push(normalisePr(row)); } catch (e) { invalid.push({ index, reason: `could not normalise: ${str(e?.message) || 'error'}` }); }
  });
  const reasons = [];
  if (rows.length >= limit) reasons.push(`PR list may be truncated at ${limit}`);
  if (invalid.length) reasons.push(`${invalid.length} malformed PR record${invalid.length === 1 ? '' : 's'} skipped (${invalid[0].reason})`);
  return {
    queried: true, complete: reasons.length === 0, limit, observedAt, prs,
    ...(invalid.length ? { invalid } : {}), ...(reasons.length ? { reason: reasons.join('; ') } : {}),
  };
}

/**
 * Join the checks listing onto `prs` BY NUMBER (mutates the PR objects).
 * The two listings are separate bounded snapshots, so success of the second call
 * proves nothing about a PR it does not mention: `none` only when a matching,
 * valid row reports an empty rollup; every other PR stays `unknown`.
 * @param {Array<object>} prs
 * @param {string} text - stdout of the checks call
 * @returns {{queried: boolean, missing: number, reason?: string}}
 */
export function attachChecks(prs, text) {
  let rows;
  try { rows = JSON.parse(String(text)); } catch { return { queried: false, missing: prs.length, reason: 'gh returned unparseable checks JSON' }; }
  if (!Array.isArray(rows)) return { queried: false, missing: prs.length, reason: 'gh returned a non-list of checks' };
  const byNumber = new Map();
  for (const row of rows) { if (isObj(row) && Number.isInteger(row.number)) byNumber.set(row.number, row); }
  let missing = 0; let malformed = 0; let moved = 0;
  for (const pr of prs) {
    const row = byNumber.get(pr.number);
    if (!row) { missing += 1; continue; }
    if (validateChecksRow(row)) { missing += 1; malformed += 1; continue; }
    // A force-push between the two calls would attach another revision's checks to this head.
    if (pr.headOid && row.headRefOid !== pr.headOid) { missing += 1; moved += 1; continue; }
    pr.checks = summariseChecks(row.statusCheckRollup);
  }
  const reasons = [];
  if (missing) reasons.push(`${missing} PR${missing === 1 ? '' : 's'} without usable checks${malformed ? ` (${malformed} malformed)` : ''}${moved ? ` (${moved} head moved between queries)` : ''}`);
  return { queried: true, missing, ...(reasons.length ? { reason: reasons.join('; ') } : {}) };
}

/**
 * Spawn `gh` once, never prompting and never coloured. Returns the raw
 * `spawnSync` result; callers classify `error` / `status` themselves (a `gh pr
 * checks` exit 1 or 8 still carries a valid JSON answer, for instance).
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ghBin?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number}} [opts]
 */
export function spawnGh(cwd, args, { ghBin = 'gh', env, timeoutMs = GH_TIMEOUT_MS } = {}) {
  return spawnSync(ghBin, args, {
    cwd, encoding: 'utf-8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...(env ?? process.env), GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
  });
}

/** Reason for a `spawnSync` that never produced a `gh` answer (`res.error`). */
export function ghSpawnFailure(res, what = '') {
  const tag = what ? ` (${what})` : '';
  if (res.error.code === 'ENOENT') return 'gh not installed';
  if (res.error.code === 'ETIMEDOUT') return `gh timed out${tag}`;
  return `gh failed to run${tag}: ${res.error.message}`;
}

function runGh(cwd, ghBin, env, fields) {
  return spawnGh(cwd, ['pr', 'list', '--state', 'open', '--limit', String(PR_LIMIT), '--json', fields.join(',')], { ghBin, env });
}

/**
 * Open PRs for the repo at `cwd`.
 * @param {string} cwd
 * @param {{ghBin?: string, env?: NodeJS.ProcessEnv}} [opts] - `env` lets a test scrub PATH
 * @returns {{queried: boolean, complete: boolean, limit: number, observedAt: string, reason?: string, prs: Array<object>}}
 */
export function listPullRequests(cwd, { ghBin = 'gh', env } = {}) {
  const observedAt = nowIso();
  const res = runGh(cwd, ghBin, env, PR_LIST_FIELDS);
  const no = (reason) => ({ queried: false, complete: false, limit: PR_LIMIT, observedAt, reason, prs: [] });
  if (res.error) return no(ghSpawnFailure(res));
  if (res.status !== 0) return no(classifyGhFailure(res.stderr));
  const core = parsePrList(res.stdout, { observedAt });
  if (!core.queried) return core;
  // Optional second column; its failure never touches the PR list above.
  const cres = runGh(cwd, ghBin, env, PR_CHECK_FIELDS);
  let field;
  if (cres.error) {
    field = { queried: false, missing: core.prs.length, reason: ghSpawnFailure(cres, 'checks') };
  } else if (cres.status !== 0) {
    field = { queried: false, missing: core.prs.length, reason: classifyChecksFailure(cres.stderr) };
  } else {
    field = attachChecks(core.prs, cres.stdout);
  }
  return { ...core, fields: { checks: field } };
}

/**
 * The identity block a session record stores for a PR source. A number or
 * `headRefName` alone does not identify a commit (a fork can share the name),
 * so all five coordinates are kept.
 * @param {ReturnType<typeof normalisePr>} pr
 */
export function prSourceIdentity(pr) {
  return {
    kind: 'pr',
    branch: pr.headRef,
    repo: pr.repo,
    prNumber: pr.number,
    headRepo: pr.headRepo,
    headRef: pr.headRef,
    baseRef: pr.baseRef,
  };
}

/** Local ref a PR head is materialised into — isolated from any same-named branch. */
export function prLocalRef(n) {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid PR number: ${n}`);
  return `refs/fleet/pr/${n}`;
}

/**
 * Fetch `refs/pull/<n>/head` into `refs/fleet/pr/<n>` and require the fetched
 * OID to equal the PR's `headRefOid`. A mismatch or a failed fetch is a refusal
 * with the reason — never a fall-through to a local branch of the same name.
 * @param {string} cwd
 * @param {number} n
 * @param {string} expectedOid
 * @param {{remote?: string}} [opts]
 * @returns {{ok: boolean, ref?: string, oid?: string, reason?: string}}
 */
export function materializePrRef(cwd, n, expectedOid, { remote = 'origin' } = {}) {
  let ref;
  try { ref = prLocalRef(n); } catch (e) { return { ok: false, reason: e.message }; }
  const f = runGit(['fetch', '--no-tags', remote, `+refs/pull/${n}/head:${ref}`], cwd, { timeoutMs: GH_TIMEOUT_MS });
  if (!f.ok) return { ok: false, reason: `could not fetch PR #${n} head: ${f.reason}` };
  const h = headOf(cwd, ref);
  if (!h.ok) return { ok: false, reason: `fetched ref ${ref} does not resolve: ${h.reason}` };
  if (h.oid !== expectedOid) {
    return { ok: false, oid: h.oid, reason: `PR #${n} head ${h.oid.slice(0, 12)} differs from expected ${String(expectedOid).slice(0, 12)}` };
  }
  return { ok: true, ref, oid: h.oid };
}
