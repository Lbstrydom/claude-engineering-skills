/**
 * @fileoverview Was this branch's work merged into base? Two INDEPENDENT signals,
 * each with its own provenance, plus the git-only "what did base gain since I
 * forked" facts a rebase obligation needs.
 *
 *  - `listMergedPullRequests` — `gh pr list --state merged` (bounded). A squash
 *    merge never makes a branch tip an ancestor of base, so ancestry alone reads
 *    squash-merged work as unlanded; the PR's recorded head is the evidence.
 *  - `squashPatchIds` — git only, works with `gh` absent: the patch-ids of base's
 *    recent first-parent commits. A branch whose whole-diff patch-id equals one of
 *    them was squash-merged as that commit.
 *  - `mergedEvidenceFor` — the ONE predicate every reader (status, deriveDone,
 *    hideReason, next, restack) asks. Silence of one signal is never read as the
 *    other's answer: an unqueried source is `known:false`, not `merged:false`.
 *  - `baseAdvance` — first-parent commits on base since a branch's merge-base,
 *    each with its files, so "base gained a change touching your files" needs no
 *    changed-path data from `gh`.
 *
 * Nothing here throws and nothing here writes.
 *
 * Plan: docs/plans/fleet-consumer-feedback-oct.md §2.1.
 *
 * @module scripts/lib/fleet/merged-facts
 */
import { runGit, CANON_DIFF_CONFIG, CANON_DIFF_FLAGS, isAncestor } from './git-facts.mjs';
import { classifyGhFailure, ghSpawnFailure, spawnGh, repoFromPrUrl } from './gh-facts.mjs';
import { OID_PATTERN } from './contracts.mjs';

/** Fields of the merged-PR listing (all real `gh pr list --json` fields — see the recorded fixture). */
export const MERGED_PR_FIELDS = Object.freeze([
  'number', 'headRefName', 'headRefOid', 'mergedAt', 'mergeCommit', 'url', 'baseRefName', 'isCrossRepository',
]);
/** `gh pr list --state merged --limit`; a result of exactly this many rows cannot prove there are no more. */
export const MERGED_LIMIT = 100;
/** First-parent commits of base whose patch-ids are compared against branch patch-ids. */
export const SQUASH_DEPTH = 200;
/** First-parent commits of base read for one branch's base-advance facts. */
export const ADVANCE_DEPTH = 500;

const notQueried = (reason, extra = {}) => ({ queried: false, complete: false, reason, ...extra });

/**
 * Parse `gh pr list --state merged --json …` stdout. Pure; never throws. A row
 * without its identity (number, head ref, head oid) is skipped AND counted, so a
 * partial list never reads as a complete one.
 * @param {string} text
 * @param {{limit?: number}} [opts]
 */
export function parseMergedList(text, { limit = MERGED_LIMIT } = {}) {
  let rows;
  try { rows = JSON.parse(String(text)); } catch { return notQueried('gh returned unparseable JSON (merged PRs)', { prs: [] }); }
  if (!Array.isArray(rows)) return notQueried('gh returned a non-list (merged PRs)', { prs: [] });
  const prs = []; let invalid = 0;
  for (const r of rows) {
    const oidOk = typeof r?.headRefOid === 'string' && new RegExp(`^${OID_PATTERN}$`).test(r.headRefOid);
    if (!r || !Number.isInteger(r.number) || typeof r.headRefName !== 'string' || !oidOk) { invalid += 1; continue; }
    prs.push({
      number: r.number, headRef: r.headRefName, headOid: r.headRefOid, baseRef: r.baseRefName ?? null,
      mergedAt: typeof r.mergedAt === 'string' ? r.mergedAt : null,
      mergeOid: typeof r.mergeCommit?.oid === 'string' ? r.mergeCommit.oid : null,
      repo: repoFromPrUrl(r.url), isCrossRepository: Boolean(r.isCrossRepository),
    });
  }
  const reasons = [];
  if (rows.length >= limit) reasons.push(`merged PR list may be truncated at ${limit}`);
  if (invalid) reasons.push(`${invalid} malformed merged PR record${invalid === 1 ? '' : 's'} skipped`);
  return { queried: true, complete: reasons.length === 0, limit, prs, ...(reasons.length ? { reason: reasons.join('; ') } : {}) };
}

/**
 * Recently merged PRs into `base`.
 * @param {string} cwd
 * @param {{base: string, ghBin?: string, env?: NodeJS.ProcessEnv, limit?: number}} opts
 */
export function listMergedPullRequests(cwd, { base, ghBin = 'gh', env, limit = MERGED_LIMIT }) {
  const res = spawnGh(cwd, ['pr', 'list', '--state', 'merged', '--base', base, '--limit', String(limit), '--json', MERGED_PR_FIELDS.join(',')], { ghBin, env });
  if (res.error) return notQueried(ghSpawnFailure(res, 'merged PRs'), { prs: [] });
  if (res.status !== 0) return notQueried(classifyGhFailure(res.stderr), { prs: [] });
  return parseMergedList(res.stdout, { limit });
}

/**
 * Parse `git patch-id --stable` output (`<patch-id> <commit>` per line) into a
 * patch-id → commit map. The FIRST (newest) commit wins for a repeated patch.
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parsePatchIdPairs(text) {
  const out = new Map();
  const re = new RegExp(`^(${OID_PATTERN})\\s+(${OID_PATTERN})\\s*$`);
  for (const line of String(text).split('\n')) {
    const m = re.exec(line.trim());
    if (m && !out.has(m[1])) out.set(m[1], m[2]);
  }
  return out;
}

/**
 * Patch-ids of the newest `depth` first-parent commits of `baseRev`, computed with
 * the SAME canonical diff settings `patchId` uses, so the two compare.
 * @param {string} cwd
 * @param {string} baseRev
 * @param {{depth?: number, git?: typeof runGit}} [opts]
 * @returns {{queried: boolean, complete: boolean, byPatchId: Map<string, string>, reason?: string}}
 */
export function squashPatchIds(cwd, baseRev, { depth = SQUASH_DEPTH, git = runGit } = {}) {
  const log = git([...CANON_DIFF_CONFIG, 'log', '--first-parent', '-p', ...CANON_DIFF_FLAGS, '--format=commit %H', '-n', String(depth), baseRev], cwd, { timeoutMs: 60_000 });
  if (!log.ok) return { ...notQueried(`squash detection: ${log.reason}`), byPatchId: new Map() };
  if (log.stdout === '') return { queried: true, complete: true, byPatchId: new Map() };
  const pid = git(['patch-id', '--stable'], cwd, { input: log.stdout, timeoutMs: 60_000 });
  if (!pid.ok) return { ...notQueried(`squash detection: ${pid.reason}`), byPatchId: new Map() };
  const count = git(['rev-list', '--first-parent', '--count', baseRev], cwd);
  const total = count.ok ? Number.parseInt(count.stdout.trim(), 10) : null;
  // Older history than the window is simply not compared; say so rather than imply it was.
  const complete = Number.isInteger(total) && total <= depth;
  return { queried: true, complete, byPatchId: parsePatchIdPairs(pid.stdout), ...(complete ? {} : { reason: `squash detection covers the newest ${depth} first-parent commits of base` }) };
}

/**
 * THE merged predicate. Was the COMMITTED work of `branch` (tip `tipOid`) merged
 * into base? This speaks only about committed history — whether the session is
 * finished also depends on its worktree (see `deriveDone`).
 *
 * @param {object} a
 * @param {string} a.branch
 * @param {string|null} a.tipOid
 * @param {string|null} [a.patchId] the branch's whole-diff patch-id (`patchId()`), when known
 * @param {{queried: boolean, prs?: object[]}} [a.mergedPrs]
 * @param {{queried: boolean, byPatchId?: Map<string, string>}} [a.squash]
 * @param {(x: string, y: string) => {ok: boolean, value?: boolean}} [a.ancestor] is x an ancestor of y?
 * @param {(from: string, to: string) => number|null} [a.countRange] commits in from..to
 * @returns {{known: boolean, merged: boolean|'partially', via?: 'pr'|'squash', pr?: number, commit?: string|null, extraCommits?: number|null}}
 */
export function mergedEvidenceFor({ branch, tipOid, patchId = null, mergedPrs, squash, ancestor = () => ({ ok: false }), countRange = () => null }) {
  if (!tipOid) return { known: false, merged: false };
  // Every source is consulted before a verdict: complete-merge evidence outranks a partial one
  // (a branch partially merged by an old PR may have been fully squash-merged since).
  let partial = null;
  if (mergedPrs?.queried) {
    // Newest first: a branch name reused after an old merge must match its newest PR.
    const named = (mergedPrs.prs ?? []).filter((p) => p.headRef === branch && !p.isCrossRepository)
      .sort((x, y) => String(y.mergedAt ?? '').localeCompare(String(x.mergedAt ?? '')));
    for (const p of named) {
      if (p.headOid === tipOid) return { known: true, merged: true, via: 'pr', pr: p.number, commit: p.mergeOid, extraCommits: 0 };
      const contained = ancestor(tipOid, p.headOid);
      if (contained.ok && contained.value) return { known: true, merged: true, via: 'pr', pr: p.number, commit: p.mergeOid, extraCommits: 0 };
      const extends_ = ancestor(p.headOid, tipOid);
      if (extends_.ok && extends_.value && !partial) {
        partial = { known: true, merged: 'partially', via: 'pr', pr: p.number, commit: p.mergeOid, extraCommits: countRange(p.headOid, tipOid) };
      }
      // Same name, unrelated history (a reused branch name): not this branch's PR.
    }
  }
  if (squash?.queried && patchId && squash.byPatchId?.has(patchId)) {
    return { known: true, merged: true, via: 'squash', commit: squash.byPatchId.get(patchId), extraCommits: 0 };
  }
  if (partial) return partial;
  // "Not merged" needs BOTH sources to be complete for THIS branch: the PR list (not truncated) and the
  // squash window (reaching back past the branch's fork point — a squash pushed without a PR is only
  // visible there). Anything less is `known:false`; every consumer stays on the safe side.
  const complete = Boolean(mergedPrs?.queried && mergedPrs.complete !== false) && Boolean(squash?.queried && (squash.complete || squash.coversFork === true));
  return { known: complete, merged: false, ...(complete ? {} : { reason: 'merged evidence incomplete (PR list truncated or not queried; squash window short)' }) };
}

/** `mergedEvidenceFor`'s git adapters for a real repo. */
export function gitAdapters(cwd) {
  return {
    ancestor: (x, y) => isAncestor(cwd, x, y),
    countRange: (from, to) => {
      const r = runGit(['rev-list', '--count', `${from}..${to}`], cwd);
      const n = r.ok ? Number.parseInt(r.stdout.trim(), 10) : NaN;
      return Number.isInteger(n) ? n : null;
    },
  };
}

/**
 * Parse `git log --first-parent --name-only -z --format=%x00%H%x00%s` output.
 * Measured shape (git 2.4x): `\0<oid>\0<subject>\0\n<file>\0<file>\0\0<oid>…` —
 * the first file of each record carries a leading newline.
 * @param {string} text
 * @returns {Array<{oid: string, subject: string, pr: number|null, files: string[]}>}
 */
export function parseAdvanceLog(text) {
  const out = [];
  const re = new RegExp(`^(${OID_PATTERN})$`);
  const parts = String(text).split('\0');
  let cur = null;
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    // A record starts with NUL, so its oid always follows an EMPTY part; a file name never does
    // (names follow the subject directly), so a 40-hex file name cannot open a record.
    if (re.test(p) && i + 1 < parts.length && (i === 0 || parts[i - 1] === '')) {
      const [subject, ...rest] = parts[i + 1].split('\n');
      const pr = /\(#(\d+)\)\s*$/.exec(subject);
      cur = { oid: p, subject, pr: pr ? Number(pr[1]) : null, files: [] };
      out.push(cur);
      const first = rest.join('\n').trim();
      if (first) cur.files.push(first);
      i += 1;
      continue;
    }
    const f = p.replace(/^\n+/, '').trim();
    if (cur && f) cur.files.push(f);
  }
  return out;
}

/**
 * What base gained since `branch` forked from it: first-parent commits in
 * `mergeBase(baseRev, tip)..baseRev`, each with its files. Bounded; over the
 * bound is `complete:false`, never a short list read as the whole.
 * @param {string} cwd
 * @param {{baseRev: string, tipOid: string, depth?: number, git?: typeof runGit}} a
 * @returns {{queried: boolean, complete: boolean, commits: object[], mergeBase?: string, reason?: string}}
 */
export function baseAdvance(cwd, { baseRev, tipOid, depth = ADVANCE_DEPTH, git = runGit }) {
  const mb = git(['merge-base', baseRev, tipOid], cwd);
  if (!mb.ok) return { ...notQueried(`no merge-base with ${baseRev}: ${mb.reason ?? 'unrelated histories'}`), commits: [] };
  const mergeBase = mb.stdout.trim();
  const log = git(['log', '--first-parent', '--name-only', '-z', '--no-renames', '--format=%x00%H%x00%s', '-n', String(depth + 1), `${mergeBase}..${baseRev}`], cwd, { timeoutMs: 60_000 });
  if (!log.ok) return { ...notQueried(`base-advance: ${log.reason}`), commits: [], mergeBase };
  const commits = parseAdvanceLog(log.stdout);
  if (commits.length > depth) {
    return { queried: true, complete: false, commits: commits.slice(0, depth), mergeBase, reason: `base advanced by more than ${depth} commits; overlap not fully measured` };
  }
  return { queried: true, complete: true, commits, mergeBase };
}

/** The base-advance commits whose files intersect `myFiles`. */
export function advanceTouching(advance, myFiles) {
  if (!advance?.queried) return [];
  const mine = new Set(myFiles ?? []);
  return advance.commits.map((c) => ({ ...c, files: c.files.filter((f) => mine.has(f)) })).filter((c) => c.files.length > 0);
}

