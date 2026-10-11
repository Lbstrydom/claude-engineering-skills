/**
 * @fileoverview Unregistered work: worktrees and local branches holding work that no live fleet claim
 * covers, each given ONE verdict from an ordered contract (docs/plans/fleet-unclaimed-work-and-switch-friction.md
 * §2.1). The one predicate behind `status`'s section, the footer's cache, `handover` and `archive`.
 *
 * Each candidate is described by three independent facts, then the first matching contract row wins:
 *   L  local changes — staged, unstaged and untracked paths (the sync receipt split out);
 *   C  committed work off base — none | pushed | unpushed | unknown;
 *   E  evidence the committed work landed — landed | duplicate | none | incomplete.
 * A failed probe or an unknown count is never read as "nothing here": it is `unverified` (row 1a).
 *
 * Callers pass the facts they already gathered, so evidence costs no extra git or gh call here. The probe is
 * the light `archiveReport` (no ignored scan, no size walk — the measured cost, plan M2), and the whole scan
 * runs inside ONE absolute deadline: every subprocess is clipped to it, and what it never reached is
 * DISCLOSED (`partial`, `notProbed`), never silently dropped. There is no fairness guarantee across runs.
 *
 * @module scripts/lib/fleet/unregistered
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../file-io.mjs';
import { samePath } from '../harness-paths.mjs';
import { RECEIPT_PATH } from '../sync-receipt.mjs';
import { listWorktrees, patchId as gitPatchId, runGit } from './git-facts.mjs';
import { archiveReport } from './lifecycle.mjs';
import { isIdleTip, landedReason, toMs } from './overlap.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Files a sync leaves dirty on purpose (`sync-pr.mjs` never opens a PR for a receipt-only change). */
export const SYNC_OWNED_PATHS = Object.freeze([RECEIPT_PATH]);
/** `.fleet.json` `staleWorktreeDays` default: unlanded work idle longer than this is "possibly abandoned". */
export const DEFAULT_STALE_WORKTREE_DAYS = 3;
/** The scan's bounds: one absolute deadline per surface, and a per-call cap under it. */
export const UNREGISTERED_BUDGET = Object.freeze({ statusMs: 60_000, handoverMs: 120_000, probeTimeoutMs: 30_000 });
/** Captured tips per placement `rev-list` (200 × 41 chars ≈ 8 KB of argv, far under the Windows 32 KB limit). */
export const PLACEMENT_CHUNK = 200;
/** The closed verdict set. */
export const VERDICTS = Object.freeze(['unlanded', 'superseded', 'unverified', 'sync-owned']);

/** The per-item risk counts every surface prints. */
export const RISK_KINDS = Object.freeze(['staged', 'unstaged', 'untracked', 'unpushed']);

/**
 * The ordered verdict contract; the first matching row wins. Pure.
 * @param {{probed: boolean, local?: string[], syncOwned?: string[], committed: 'none'|'pushed'|'unpushed'|'unknown',
 *   evidence: 'landed'|'duplicate'|'none'|'incomplete', unverified?: string[], duplicateOf?: string|null}} f
 * @returns {null|{verdict: string, row: string, blocks: boolean, preserved: string, reason: string, via?: string, syncOwnedDirty?: true}}
 *   null = nothing local and nothing off base: not listed.
 */
export function classifyUnregistered({ probed, local = [], syncOwned = [], committed, evidence, unverified = [], duplicateOf = null }) {
  const extra = syncOwned.length ? { syncOwnedDirty: true } : {};
  const commits = committed === 'pushed' || committed === 'unpushed';
  // 1a: a failed probe proves nothing, so nothing is assumed safe.
  if (!probed) return { verdict: 'unverified', row: '1a', blocks: true, preserved: 'unknown', reason: `not measured: ${unverified[0] ?? 'probe failed'}`, ...extra };
  if (committed === 'unknown') return { verdict: 'unverified', row: '1a', blocks: true, preserved: 'unknown', reason: 'commits off base could not be counted', ...extra };
  if (!local.length && evidence === 'incomplete' && committed === 'unpushed') {
    return { verdict: 'unverified', row: '1b', blocks: true, preserved: 'none', reason: 'commits no remote-tracking ref holds; whether they landed is unknown (merged evidence incomplete)', ...extra };
  }
  if (!local.length && evidence === 'incomplete' && committed === 'pushed') {
    return { verdict: 'unverified', row: '1c', blocks: false, preserved: 'remote', reason: 'a remote-tracking ref (as of the last fetch) holds the commits; whether they landed is unknown (merged evidence incomplete)', ...extra };
  }
  if (local.length) {
    const landedPart = commits && (evidence === 'landed' || evidence === 'duplicate') ? '; the committed part is already landed' : '';
    return { verdict: 'unlanded', row: '2', blocks: true, preserved: 'none', reason: `${local.length} uncommitted file(s)${landedPart}`, ...extra };
  }
  if (commits && evidence === 'landed') return { verdict: 'superseded', row: '3', blocks: false, via: 'landed', preserved: 'base', reason: 'its commits are on base', ...extra };
  if (commits && evidence === 'duplicate') {
    return { verdict: 'superseded', row: '3', blocks: false, via: 'duplicate', preserved: 'claim', reason: `same patch as ${duplicateOf ?? 'a live claim'} — leave it until that claim lands`, ...extra };
  }
  if (commits) {
    return committed === 'pushed'
      ? { verdict: 'unlanded', row: '4', blocks: false, preserved: 'remote', reason: 'commits a remote-tracking ref (as of the last fetch) holds, not on base', ...extra }
      : { verdict: 'unlanded', row: '4', blocks: true, preserved: 'none', reason: 'commits no remote-tracking ref holds', ...extra };
  }
  if (syncOwned.length) return { verdict: 'sync-owned', row: '5', blocks: false, preserved: 'n/a', reason: `only the sync receipt is dirty (${syncOwned.join(', ')})` };
  return null;
}

/** Is this item "possibly abandoned": idle past the stale window AND holding work that has not landed? */
export const isAbandoned = (item) => item.stale === true && (item.verdict === 'unlanded' || (item.verdict === 'unverified' && item.blocks));

/**
 * Ranking within "possibly abandoned" (u): work that exists nowhere else first, then most commits ahead,
 * then longest idle. A comparator for `Array.prototype.sort`.
 */
export function rankAbandoned(a, b) {
  const only = (x) => (x.preserved === 'none' ? 0 : 1);
  return (only(a) - only(b)) || ((b.ahead ?? 0) - (a.ahead ?? 0)) || ((b.idleDays ?? -1) - (a.idleDays ?? -1));
}

/** The admin `HEAD` a worktree's `.git` points at (moved by creation and every HEAD change), or null. */
function adminHeadPath(worktree) {
  const dotGit = path.join(worktree, '.git');
  let st;
  try { st = fs.statSync(dotGit); } catch { return null; }
  if (st.isDirectory()) return path.join(dotGit, 'HEAD');
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    return m ? path.join(path.resolve(worktree, m[1]), 'HEAD') : null;
  } catch { return null; }
}

/**
 * Last activity of a worktree: the greatest of the HEAD commit time, its admin `HEAD` mtime, the directory's
 * birth time (where reported) and the newest mtime among its dirty paths. Each term is a lower bound on
 * activity, never proof of death. Dirty paths are stat'ed until the deadline; the rest are counted.
 * @returns {{at: number|null, notStatted: number}}
 */
export function lastActivity({ worktree, tipTime = null, dirty = [], deadlineAt = null, clock = Date.now, stat = fs.statSync }) {
  const terms = [toMs(tipTime)];
  if (worktree) {
    const admin = adminHeadPath(worktree);
    if (admin) { try { terms.push(stat(admin).mtimeMs); } catch { /* absent: no term */ } }
    try { const b = stat(worktree).birthtimeMs; if (b > 0) terms.push(b); } catch { /* no term */ }
  }
  // The maximum is kept incrementally: a spread over every dirty path would hit the engine's argument limit.
  let at = null;
  const take = (t) => { if (Number.isFinite(t) && (at === null || t > at)) at = t; };
  terms.forEach(take);
  let notStatted = 0;
  for (const p of dirty) {
    if (deadlineAt !== null && clock() >= deadlineAt) { notStatted += 1; continue; }
    try { take(stat(path.join(worktree, p)).mtimeMs); } catch { /* deleted path: no term */ }
  }
  return { at, notStatted };
}

/** Clip a git call to the scan deadline; past it, the call is not made and says so. */
function clippedGit(git, { deadlineAt, clock, cap }) {
  return (args, cwd, opts = {}) => {
    if (deadlineAt === null) return git(args, cwd, { timeoutMs: cap, ...opts });
    const left = deadlineAt - clock();
    if (left <= 0) return { ok: false, stdout: '', reason: `scan deadline passed before git ${args[0]}` };
    return git(args, cwd, { ...opts, timeoutMs: Math.min(opts.timeoutMs ?? cap, left) });
  };
}

const countOf = (r) => { const n = r.ok ? Number.parseInt(String(r.stdout).trim(), 10) : NaN; return Number.isInteger(n) ? n : null; };

/**
 * Every worktree and local branch holding work no live claim covers, each with its verdict.
 *
 * Candidates: every worktree (not bare, missing or prunable) no live claim covers, and every local branch that
 * is ahead of the measured base OR whose ahead count is unknown, covered by no claim and checked out in no
 * listed worktree. Selection is independent of push status: a clean worktree whose commits were pushed but
 * never landed is a candidate (the case the idle hide buries).
 *
 * @param {string} repo
 * @param {{config?: object, now?: Date, env?: object}} ctx
 * @param {{worktrees?: string[], branches?: string[]}} [claimed] what live claims cover
 * @param {{facts?: object|null, list?: typeof listWorktrees, report?: typeof archiveReport, git?: typeof runGit,
 *   patchIdOf?: (rev: string) => string|null, deadlineAt?: number|null, clock?: () => number, stat?: typeof fs.statSync}} [deps]
 * @returns {{queried: boolean, reason?: string, items: object[], partial: boolean, notProbed: number, staleDays: number,
 *   branchesUnknown?: string}} `partial` is true when candidates were not probed OR the branch inventory was not read.
 */
export function unregisteredWork(repo, ctx, { worktrees: claimedWorktrees = [], branches: claimedBranches = [] } = {}, deps = {}) {
  const { facts = null, list = listWorktrees, report = archiveReport, git = runGit, deadlineAt = null, clock = Date.now, stat = fs.statSync } = deps;
  const staleDays = ctx.config?.staleWorktreeDays ?? DEFAULT_STALE_WORKTREE_DAYS;
  const base = ctx.config?.baseBranch ?? facts?.base?.name ?? null;
  const baseRev = facts?.baseOid ?? base;
  const cap = UNREGISTERED_BUDGET.probeTimeoutMs;
  const g = clippedGit(git, { deadlineAt, clock, cap });
  const empty = { items: [], partial: false, notProbed: 0, staleDays };
  const wt = list(repo);
  if (!wt.queried) return { queried: false, reason: wt.reason ?? 'git worktree list failed', ...empty };

  // A branch inventory that was not gathered is UNKNOWN, never an empty one: branch-only work would vanish and the
  // scan would read complete. It is carried as `branchesUnknown`, which every consumer treats as NOT MEASURED.
  const branchesUnknown = facts?.branches?.queried ? null : (facts ? `branch inventory not read: ${facts.branches?.reason ?? 'not gathered'}` : 'branch inventory not gathered (no facts)');
  const branchList = branchesUnknown ? [] : facts.branches.branches ?? [];
  const byName = new Map(branchList.map((b) => [b.name, b]));
  const pastDeadline = () => deadlineAt !== null && clock() >= deadlineAt;
  const evidenceOf = facts?.merged?.evidence ?? {};
  const claimedB = new Set(claimedBranches);
  const checkedOut = new Set(wt.worktrees.filter((w) => !w.bare && w.branch).map((w) => w.branch));

  // Duplicate evidence: the whole-diff patch-id of a branch a LIVE claim covers. Computed once, on demand.
  const patchIdOf = deps.patchIdOf ?? ((rev) => { const p = gitPatchId(repo, baseRev, rev); return p.queried ? p.patchId : null; });
  let claimPatches = null;
  // Past the deadline no patch-id is computed: no duplicate is claimed, so the evidence falls to none/incomplete.
  const duplicateOf = (rev) => {
    if (!rev || !baseRev || !claimedB.size) return null;
    if (!claimPatches) {
      claimPatches = new Map();
      for (const b of claimedB) {
        if (pastDeadline()) break;
        const known = facts?.patchIds?.[b];
        const pid = known?.queried ? known.patchId : (byName.get(b)?.oid ? patchIdOf(byName.get(b).oid) : null);
        if (pid) claimPatches.set(pid, b);
      }
    }
    if (pastDeadline()) return null;
    const pid = patchIdOf(rev);
    return pid ? claimPatches.get(pid) ?? null : null;
  };
  /** E for committed work at `tip` on `branch` (null for a detached HEAD). */
  const evidenceFor = (branch, tip) => {
    const ev = branch ? evidenceOf[branch] : undefined;
    // Evidence speaks for the tip it was computed at: a branch that moved since is not covered by it.
    const sameTip = branch && byName.get(branch)?.oid === tip;
    if (ev && sameTip && landedReason({ merged: ev }) === 'landed') return { evidence: 'landed' };
    const dup = duplicateOf(tip);
    if (dup) return { evidence: 'duplicate', duplicateOf: dup };
    if (ev && sameTip && ev.known) return { evidence: 'none' };
    return { evidence: 'incomplete' };
  };

  const candidates = [];
  for (const w of wt.worktrees) {
    if (w.bare || w.missing || w.prunable || claimedWorktrees.some((c) => samePath(c, w.path)) || (w.branch && claimedB.has(w.branch))) continue;
    candidates.push({ kind: 'worktree', w, tipTime: w.branch ? byName.get(w.branch)?.tipTime ?? null : null });
  }
  for (const b of branchList) {
    if (b.name === base || claimedB.has(b.name) || checkedOut.has(b.name) || b.ahead === 0) continue;
    candidates.push({ kind: 'branch', b, tipTime: b.tipTime ?? null });
  }
  // Oldest tip first: a heuristic that front-loads the likeliest abandoned work. Unknown tip times go first.
  candidates.sort((x, y) => (toMs(x.tipTime) ?? -Infinity) - (toMs(y.tipTime) ?? -Infinity));

  const items = [];
  let notProbed = 0;
  let localOnly; // undefined = not asked yet; null = the listing failed
  const nowMs = toMs(ctx.now) ?? clock();
  for (const c of candidates) {
    if (deadlineAt !== null && clock() >= deadlineAt) { notProbed += 1; continue; }
    const item = c.kind === 'worktree' ? probeWorktree(c.w) : probeBranch(c.b);
    if (item) items.push(item);
  }
  return { queried: true, items, partial: notProbed > 0 || Boolean(branchesUnknown), notProbed, staleDays, ...(branchesUnknown ? { branchesUnknown } : {}) };

  function finish(base_, facts_) {
    const verdict = classifyUnregistered(facts_);
    if (!verdict) return null;
    const act = lastActivity({ worktree: base_.worktree, tipTime: base_.tipTime, dirty: base_.dirty, deadlineAt, clock, stat });
    const idleDays = act.at === null || act.at > nowMs ? null : Math.floor((nowMs - act.at) / DAY_MS);
    const stale = isIdleTip(act.at, nowMs, staleDays * DAY_MS);
    const { dirty, tipTime, ...rest } = base_;
    return { ...rest, ...verdict, idleDays, stale, lastActivity: act.at === null ? null : new Date(act.at).toISOString(), ...(act.notStatted ? { mtimeNotStatted: act.notStatted } : {}) };
  }

  function probeWorktree(w) {
    const r = report(ctx, { branch: null, worktree: w.path, scanIgnored: false, probeTimeoutMs: cap, deadlineAt, clock, git });
    // An unborn HEAD (no commit yet) has no commits to lose: its unresolvable HEAD is not a gap in the evidence.
    const unborn = /^0+$/.test(w.head ?? '');
    const unverified = r.unverified.filter((u) => !(unborn && u.startsWith('cannot resolve HEAD')));
    const all = [...new Set([...r.risks.staged, ...r.risks.unstaged, ...r.risks.untracked])];
    const syncOwned = all.filter((p) => SYNC_OWNED_PATHS.includes(p));
    const local = all.filter((p) => !SYNC_OWNED_PATHS.includes(p));
    const unpushed = r.risks.unpushed.length;
    // A branch's measured ahead count speaks for the tip it was measured at; a worktree whose HEAD has moved
    // since is counted afresh from its own HEAD.
    const measured = w.branch ? byName.get(w.branch) : undefined;
    let ahead = measured && measured.oid === w.head ? measured.ahead : undefined;
    let committed;
    if (unborn) committed = 'none';
    else if (w.branch && w.branch === base) {
      // The base's own checkout: "off base" is meaningless, but commits no remote holds exist only here.
      committed = unpushed ? 'unpushed' : 'none';
    } else {
      if (ahead === undefined && baseRev && w.head) ahead = countOf(g(['rev-list', '--count', `${baseRev}..${w.head}`], repo));
      committed = !Number.isInteger(ahead) ? 'unknown' : ahead === 0 ? 'none' : unpushed ? 'unpushed' : 'pushed';
    }
    // The base's own unpushed commits are not a branch that could have landed: evidence 'none' (row 4).
    const ev = (committed === 'pushed' || committed === 'unpushed') && w.branch !== base ? evidenceFor(w.branch ?? null, w.head) : { evidence: 'none' };
    return finish(
      { kind: 'worktree', worktree: path.resolve(w.path), branch: w.branch ?? null, detached: Boolean(w.detached), locked: Boolean(w.locked), head: w.head ?? null,
        ahead: Number.isInteger(ahead) ? ahead : null, committed, evidence: ev.evidence, ...(ev.duplicateOf ? { duplicateOf: ev.duplicateOf } : {}),
        risks: Object.fromEntries(RISK_KINDS.map((k) => [k, (r.risks[k] ?? []).length])), ...(unverified.length ? { unverified } : {}),
        tipTime: w.branch ? byName.get(w.branch)?.tipTime ?? null : null, dirty: all },
      { probed: unverified.length === 0, local, syncOwned, committed, ...ev, unverified },
    );
  }

  /**
   * Placement for branch-only candidates in a few calls: every commit reachable from the CAPTURED tips (the exact
   * oids each verdict is about, never the branches' current tips, which may have moved) that no remote-tracking
   * ref holds. A tip outside that set is reachable from a remote ref, so ALL its commits are (pushed, no
   * per-branch call); only tips inside it pay for a count. Chunked so the argv stays far under the Windows
   * command-line limit. Measured on wine (221 branch-only candidates): 2 calls instead of 221. Any failed chunk
   * falls back to one count per branch — slower, never a guess.
   */
  function localOnlyCommits() {
    if (localOnly !== undefined) return localOnly;
    const tips = [...new Set(candidates.filter((c) => c.kind === 'branch' && Number.isInteger(c.b.ahead)).map((c) => c.b.oid))];
    localOnly = new Set();
    for (let i = 0; i < tips.length; i += PLACEMENT_CHUNK) {
      const r = g(['rev-list', ...tips.slice(i, i + PLACEMENT_CHUNK), '--not', '--remotes'], repo);
      if (!r.ok) { localOnly = null; break; }
      for (const x of String(r.stdout).split('\n')) if (x.trim()) localOnly.add(x.trim());
    }
    return localOnly;
  }

  function probeBranch(b) {
    let committed = 'unknown'; const unverified = []; let unpushed = 0;
    if (Number.isInteger(b.ahead)) {
      const set = localOnlyCommits();
      const n = set && !set.has(b.oid) ? 0 : countOf(g(['rev-list', '--count', b.oid, '--not', '--remotes'], repo));
      if (n === null) unverified.push(`cannot count commits of ${b.name} no remote holds`);
      else { unpushed = n; committed = n > 0 ? 'unpushed' : 'pushed'; }
    }
    const ev = committed === 'unknown' ? { evidence: 'incomplete' } : evidenceFor(b.name, b.oid);
    return finish(
      { kind: 'branch', worktree: null, branch: b.name, detached: false, locked: false, head: b.oid, ahead: Number.isInteger(b.ahead) ? b.ahead : null,
        committed, evidence: ev.evidence, ...(ev.duplicateOf ? { duplicateOf: ev.duplicateOf } : {}),
        risks: { staged: 0, unstaged: 0, untracked: 0, unpushed }, ...(unverified.length ? { unverified } : {}), tipTime: b.tipTime ?? null, dirty: [] },
      { probed: unverified.length === 0, local: [], syncOwned: [], committed, ...ev, unverified },
    );
  }
}

/** Groups the surfaces render, in their display order. */
export function groupUnregistered(items) {
  const abandoned = items.filter(isAbandoned).sort(rankAbandoned);
  const rest = items.filter((i) => !isAbandoned(i));
  return {
    abandoned,
    unverified: rest.filter((i) => i.verdict === 'unverified'),
    supersededOnBase: rest.filter((i) => i.verdict === 'superseded' && i.via === 'landed'),
    coveredByClaim: rest.filter((i) => i.verdict === 'superseded' && i.via === 'duplicate'),
    syncOwned: rest.filter((i) => i.verdict === 'sync-owned'),
    fresh: rest.filter((i) => i.verdict === 'unlanded'),
  };
}

// ── derived cache (Category A: never committed) ─────────────────────────────

export const UNREGISTERED_CACHE_FILE = 'unregistered.json';
export const UNREGISTERED_CACHE_SCHEMA_VERSION = 1;
const CacheSchema = z.object({
  schemaVersion: z.literal(UNREGISTERED_CACHE_SCHEMA_VERSION),
  at: z.string(),
  staleDays: z.number().int().positive(),
  partial: z.boolean(),
  notProbed: z.number().int().nonnegative(),
  counts: z.object({
    total: z.number().int().nonnegative(), abandoned: z.number().int().nonnegative(), localOnly: z.number().int().nonnegative(),
    unverified: z.number().int().nonnegative(),
  }).strict(),
}).strict();

/** The cache record for a scan result. */
export function cacheRecord(scan, now) {
  const abandoned = scan.items.filter(isAbandoned);
  return {
    schemaVersion: UNREGISTERED_CACHE_SCHEMA_VERSION, at: new Date(toMs(now) ?? Date.now()).toISOString(), staleDays: scan.staleDays,
    partial: scan.partial, notProbed: scan.notProbed,
    counts: {
      total: scan.items.length, abandoned: abandoned.length, localOnly: abandoned.filter((i) => i.preserved === 'none').length,
      unverified: scan.items.filter((i) => i.verdict === 'unverified').length,
    },
  };
}

/** Write the derived cache beside `hold.json`. Never throws: a failure is returned for a `warning:` line. */
export function writeUnregisteredCache(dir, record) {
  try {
    CacheSchema.parse(record);
    atomicWriteFileSync(path.join(dir, UNREGISTERED_CACHE_FILE), `${JSON.stringify(record, null, 2)}\n`);
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

/** Read the cache: `{state:'missing'|'unreadable'|'ok', record?, reason?}`. Never throws. */
export function readUnregisteredCache(dir) {
  let text;
  try { text = fs.readFileSync(path.join(dir, UNREGISTERED_CACHE_FILE), 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable', reason: e.code ?? e.message };
  }
  try {
    const parsed = CacheSchema.safeParse(JSON.parse(text));
    return parsed.success ? { state: 'ok', record: parsed.data } : { state: 'unreadable', reason: 'schema mismatch' };
  } catch (e) { return { state: 'unreadable', reason: e.message }; }
}
