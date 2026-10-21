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
 * the light `archiveReport` (no ignored scan, no size walk — the measured cost, plan M2; the HANDOVER path alone adds
 * one collapsed ignored-files call per otherwise-clean worktree, `ignoredProbe`, and a pushed-tag credit), and the whole scan
 * runs inside ONE absolute deadline: every subprocess is clipped to it, and what it never reached is
 * DISCLOSED (`partial`, `notProbed`), never silently dropped. There is no fairness guarantee across runs.
 *
 * @module scripts/lib/fleet/unregistered
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../file-io.mjs';
import { samePath } from '../harness-paths.mjs';
import { RECEIPT_PATH } from '../sync-receipt.mjs';
import { cacheDirFor, listWorktrees, patchId as gitPatchId, runGit } from './git-facts.mjs';
import { archiveReport, listIgnored } from './lifecycle.mjs';
import { squashPatchIds } from './merged-facts.mjs';
import { DEFAULT_STALE_WORKTREE_DAYS, isIdleTip, isTerminalState, landedReason, toMs } from './overlap.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Files a sync leaves dirty on purpose (`sync-pr.mjs` never opens a PR for a receipt-only change). */
export const SYNC_OWNED_PATHS = Object.freeze([RECEIPT_PATH]);
export { DEFAULT_STALE_WORKTREE_DAYS };
/** The scan's bounds: one absolute deadline per surface, and a per-call cap under it. */
export const UNREGISTERED_BUDGET = Object.freeze({ statusMs: 60_000, handoverMs: 120_000, probeTimeoutMs: 30_000 });
/** Captured tips per placement `rev-list` (200 × 41 chars ≈ 8 KB of argv, far under the Windows 32 KB limit). */
export const PLACEMENT_CHUNK = 200;
/** Ancestry checks spent naming the descendant tags that hold a credited commit (the credit itself is one count). */
const TAG_EVIDENCE_PROBES = 25;
/** The closed verdict set. */
export const VERDICTS = Object.freeze(['unlanded', 'superseded', 'unverified', 'sync-owned']);

/** The per-item risk counts every surface prints. */
export const RISK_KINDS = Object.freeze(['staged', 'unstaged', 'untracked', 'unpushed']);

/**
 * A pre-push sandbox is TOOLING, not work: `scripts/prepush-check.mjs` checks out the commit being pushed into
 * `<os.tmpdir()>/ces-prepush-<8-hex sha>-<pid>`, detached, and removes it afterwards (the prefix is
 * `SANDBOX_PREFIX` in `scripts/lib/prepush-sandbox-cleanup.mjs`, spelled here rather than imported so fleet's
 * synced closure stays small; `tests/fleet-unregistered-surfaces.test.mjs` pins the two spellings together).
 * All three facts must hold — detached, directly under the temp dir, that exact name — so a look-alike
 * directory with a branch checked out, or anywhere else, stays unregistered work.
 */
export const PREPUSH_SANDBOX_RE = /^ces-prepush-[0-9a-f]{8}-\d+$/;

export function isPrepushSandbox(w, { tmpDirs = defaultTmpDirs() } = {}) {
  if (!w?.detached || !PREPUSH_SANDBOX_RE.test(path.basename(String(w.path)))) return false;
  const parent = path.dirname(path.resolve(w.path));
  return tmpDirs.some((t) => samePath(parent, t));
}

/** The OS temp dir, and its realpath where that differs (macOS `/var` → `/private/var`). */
function defaultTmpDirs() {
  const t = os.tmpdir();
  try { const r = fs.realpathSync.native(t); return r === t ? [t] : [t, r]; } catch { return [t]; }
}

/**
 * The ordered verdict contract; the first matching row wins. Pure.
 * @param {{probed: boolean, local?: string[], ignored?: string[], syncOwned?: string[], committed: 'none'|'pushed'|'unpushed'|'unknown',
 *   evidence: 'landed'|'duplicate'|'none'|'incomplete', unverified?: string[], duplicateOf?: string|null, heldBy?: 'tag'|null}} f
 *   `ignored` = gitignored paths outside archiveIgnore, measured on the handover path only: like `local`, the only copy may be here.
 *   `heldBy: 'tag'` = the commits are held by a pushed tag verified against the remote now (`committed` is then 'pushed').
 * @returns {null|{verdict: string, row: string, blocks: boolean, preserved: string, reason: string, via?: string, syncOwnedDirty?: true}}
 *   null = nothing local and nothing off base: not listed.
 */
export function classifyUnregistered({ probed, local = [], ignored = [], syncOwned = [], committed, evidence, unverified = [], duplicateOf = null, heldBy = null }) {
  const extra = syncOwned.length ? { syncOwnedDirty: true } : {};
  const commits = committed === 'pushed' || committed === 'unpushed';
  const holder = heldBy === 'tag' ? 'a pushed tag (verified against the remote now)' : 'a remote-tracking ref (as of the last fetch)';
  const unlandedWork = local.length > 0 || ignored.length > 0;
  // 1a: a failed probe proves nothing, so nothing is assumed safe.
  if (!probed) return { verdict: 'unverified', row: '1a', blocks: true, preserved: 'unknown', reason: `not measured: ${unverified[0] ?? 'probe failed'}`, ...extra };
  if (committed === 'unknown') return { verdict: 'unverified', row: '1a', blocks: true, preserved: 'unknown', reason: 'commits off base could not be counted', ...extra };
  if (!unlandedWork && evidence === 'incomplete' && committed === 'unpushed') {
    return { verdict: 'unverified', row: '1b', blocks: true, preserved: 'none', reason: 'commits no remote-tracking ref holds; whether they landed is unknown (merged evidence incomplete)', ...extra };
  }
  if (!unlandedWork && evidence === 'incomplete' && committed === 'pushed') {
    return { verdict: 'unverified', row: '1c', blocks: false, preserved: 'remote', reason: `${holder} holds the commits; whether they landed is unknown (merged evidence incomplete)`, ...extra };
  }
  if (unlandedWork) {
    const landedPart = !commits ? '' : evidence === 'landed' ? '; the committed part is already landed'
      : evidence === 'duplicate' ? `; the committed part is the same patch as ${duplicateOf ?? 'a live claim'}, not landed` : '';
    const what = [local.length ? `${local.length} uncommitted file(s)` : null, ignored.length ? `${ignored.length} gitignored file(s) outside archiveIgnore — the only copy may be here` : null].filter(Boolean).join('; ');
    return { verdict: 'unlanded', row: '2', blocks: true, preserved: 'none', reason: `${what}${landedPart}`, ...extra };
  }
  if (commits && evidence === 'landed') return { verdict: 'superseded', row: '3', blocks: false, via: 'landed', preserved: 'base', reason: 'its commits are on base', ...extra };
  if (commits && evidence === 'duplicate') {
    return { verdict: 'superseded', row: '3', blocks: false, via: 'duplicate', preserved: 'claim', reason: `same patch as ${duplicateOf ?? 'a live claim'} — leave it until that claim lands`, ...extra };
  }
  if (commits) {
    return committed === 'pushed'
      ? { verdict: 'unlanded', row: '4', blocks: false, preserved: 'remote', reason: `commits ${holder} holds, not on base`, ...extra }
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
export function lastActivity({ worktree, tipTime = null, dirty = [], deadlineAt = null, clock = Date.now, stat = fs.statSync, refFiles = [] }) {
  // A term that could not be READ (any error but "absent") or a dirty path the deadline never reached could be the
  // most recent activity: the age is then `unknown`, which every caller treats as fresh — a failed probe must never
  // make a live worktree look idle (and so removable).
  let unknown = false;
  const statOr = (p, pick) => { try { return pick(stat(p)); } catch (e) { if (e?.code !== 'ENOENT') unknown = true; return null; } };
  const terms = [toMs(tipTime)];
  // A branch's reflog (and loose ref) is rewritten whenever the branch is created or moved: a branch made moments
  // ago on a year-old commit is fresh, which its tip time alone would call idle. A stat, never a subprocess.
  if (refFiles === null) unknown = true;
  for (const f of refFiles ?? []) terms.push(statOr(f, (s) => s.mtimeMs));
  if (worktree) {
    const admin = adminHeadPath(worktree);
    if (admin) terms.push(statOr(admin, (s) => s.mtimeMs));
    terms.push(statOr(worktree, (s) => (s.birthtimeMs > 0 ? s.birthtimeMs : null)));
  }
  // The maximum is kept incrementally: a spread over every dirty path would hit the engine's argument limit.
  let at = null;
  const take = (t) => { if (Number.isFinite(t) && (at === null || t > at)) at = t; };
  terms.forEach(take);
  let notStatted = 0;
  for (const p of dirty) {
    if (deadlineAt !== null && clock() >= deadlineAt) { notStatted += 1; continue; }
    take(statOr(path.join(worktree, p), (s) => s.mtimeMs));
  }
  return { at, notStatted, unknown: unknown || notStatted > 0 };
}

/** The files git rewrites when `branch` is created or moved: its reflog and its loose ref (either may be absent). */
export function branchRefFiles(cwd, branch) {
  if (!branch) return [];
  const common = cacheDirFor(cwd);
  // An unresolvable common dir is not "no ref evidence": null makes the activity unknown (fresh), never idle.
  if (!common) return null;
  const segs = String(branch).split('/');
  return [path.join(common, 'logs', 'refs', 'heads', ...segs), path.join(common, 'refs', 'heads', ...segs)];
}

/** Is this activity provably older than the window? Unknown, missing or future-dated is NOT idle. */
export const provablyIdle = (act, nowMs, windowMs) => !act.unknown && isIdleTip(act.at, nowMs, windowMs);

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
  const { facts = null, list = listWorktrees, report = archiveReport, git = runGit, deadlineAt = null, clock = Date.now, stat = fs.statSync, isTooling = isPrepushSandbox,
    refFilesOf = (b) => branchRefFiles(repo, b) } = deps;
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
  const tooling = [];
  for (const w of wt.worktrees) {
    if (w.bare || w.missing || w.prunable || claimedWorktrees.some((c) => samePath(c, w.path)) || (w.branch && claimedB.has(w.branch))) continue;
    if (isTooling(w)) { tooling.push({ worktree: path.resolve(w.path), head: w.head ?? null, kind: 'prepush-sandbox' }); continue; }
    candidates.push({ kind: 'worktree', w, tipTime: w.branch ? byName.get(w.branch)?.tipTime ?? null : null });
  }
  for (const b of branchList) {
    if (b.name === base || claimedB.has(b.name) || checkedOut.has(b.name) || b.ahead === 0) continue;
    candidates.push({ kind: 'branch', b, tipTime: b.tipTime ?? null });
  }
  // Oldest tip first: a heuristic that front-loads the likeliest abandoned work. Unknown tip times go first.
  candidates.sort((x, y) => (toMs(x.tipTime) ?? -Infinity) - (toMs(y.tipTime) ?? -Infinity));

  // The scan is staged, and the ORDER is the contract (docs/plans/fleet-handover-winddown.md §2.4, H1):
  //   1 light probes (a candidate = {base, facts}, not yet classified), 2 tag credit, 3 ignored probe, 4 classification.
  // Credit comes before the ignored probe so a commit a verified tag holds cannot make an item look non-blocking
  // after the one measurement that would have blocked it was skipped; no later stage clears an outstanding measurement.
  const pending = [];
  let notProbed = 0;
  let localOnly; // undefined = not asked yet; null = the listing failed
  const nowMs = toMs(ctx.now) ?? clock();
  for (const c of candidates) {
    if (deadlineAt !== null && clock() >= deadlineAt) { notProbed += 1; continue; }
    pending.push(c.kind === 'worktree' ? probeWorktree(c.w) : probeBranch(c.b));
  }
  // Both stages are opt-in for the handover path: `fleet status` stays local and fast, with no network call.
  if (deps.tagCredit) creditPushedTags(pending);
  if (deps.ignoredProbe) probeIgnored(pending);
  const items = pending.map((p) => finish(p.base, p.facts)).filter(Boolean);
  return { queried: true, items, tooling, candidates: candidates.length, partial: notProbed > 0 || Boolean(branchesUnknown), notProbed, staleDays, ...(branchesUnknown ? { branchesUnknown } : {}) };

  /**
   * Stage 2: a commit a PUSHED TAG holds is remote-held. ONE bounded `ls-remote --tags` for the whole scan, only when an
   * item has commits no remote-tracking ref holds; the tag oids that exist locally are negated on stdin (`--not` does not
   * carry over to stdin lines, so each carries its own `^`). A failed lookup changes no verdict, it adds a note.
   */
  function creditPushedTags(list) {
    const targets = list.filter((p) => p.facts.probed && p.facts.committed === 'unpushed' && p.base.head);
    if (!targets.length) return;
    const note = (reason) => { for (const p of targets) p.base.unverified = [...(p.base.unverified ?? []), `tag credit not measured: ${reason}`]; };
    const tags = lsRemoteTags(g, repo, 'refs/tags/*');
    if (!tags.ok) return note(tags.reason);
    const oids = [...new Set(tags.tags.values())];
    if (!oids.length) return;
    const have = g(['cat-file', '--batch-check'], repo, { input: `${oids.join('\n')}\n` });
    if (!have.ok) return note(`cannot tell which tags exist here (${have.reason})`);
    const local = new Set(String(have.stdout).split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p[1] === 'commit').map((p) => p[0]));
    if (!local.size) return;
    const stdin = `${[...local].map((o) => `^${o}`).join('\n')}\n`;
    for (const p of targets) {
      const n = countOf(g(['rev-list', '--count', '--stdin', p.base.head, '--not', '--remotes'], repo, { input: stdin }));
      if (n !== 0) continue;
      const names = tagsHolding(p.base.head, tags.tags, local);
      Object.assign(p.facts, { committed: 'pushed', heldBy: 'tag' });
      Object.assign(p.base, { committed: 'pushed', heldBy: 'tag', heldByTags: names });
    }
  }

  /**
   * The tags that hold `head`, for the evidence: those AT it first, then (if none is) tags on a descendant, found by
   * ancestry among the tags that exist here, bounded. Credit and its evidence come from the same relationship.
   */
  function tagsHolding(head, tags, localOids) {
    const at = [...tags].filter(([, oid]) => oid === head).map(([name]) => name);
    if (at.length) return at.slice(0, 3);
    const names = [];
    let checked = 0;
    for (const [name, oid] of tags) {
      if (!localOids.has(oid)) continue;
      if (checked++ >= TAG_EVIDENCE_PROBES) break;
      if (g(['merge-base', '--is-ancestor', head, oid], repo).ok) names.push(name);
      if (names.length === 3) break;
    }
    return names;
  }

  /**
   * Stage 3 (handover path only): gitignored files outside `archiveIgnore` are work. One collapsed `git status --ignored`
   * (no size walk) for every worktree that would otherwise read non-blocking or unlisted. The main checkout is not a
   * candidate for removal and holds its own `.env` and caches, so it is skipped. A probe that did not run is
   * UNVERIFIED, which blocks: a measurement the scan never made is not a clean one.
   */
  function probeIgnored(list) {
    const first = wt.worktrees[0];
    const mainPath = first && !first.bare ? first.path : null;
    let patterns = [];
    let patternNote = null;
    try { patterns = ctx.config?.archiveIgnore ?? []; } catch (e) { patternNote = `archiveIgnore not read (${e.message}); every ignored file is listed`; }
    for (const p of list) {
      if (p.base.kind !== 'worktree' || (mainPath && samePath(p.base.worktree, mainPath))) continue;
      const tentative = classifyUnregistered(p.facts);
      if (tentative?.blocks) continue;
      const r = listIgnored(g, p.base.worktree, patterns, cap);
      if (!r.ok) {
        const why = `ignored files not measured: ${r.reason}`;
        p.facts.unverified = [...p.facts.unverified, why];
        p.facts.probed = false;
        p.base.unverified = [...(p.base.unverified ?? []), why];
        continue;
      }
      p.facts.ignored = r.ignored;
      p.base.risks = { ...p.base.risks, ignored: r.ignored.length };
      if (r.ignored.length && patternNote) p.base.unverified = [...(p.base.unverified ?? []), patternNote];
    }
  }

  /** A probed candidate, not yet classified: later stages may still change its facts. */
  function pend(base_, facts_) { return { base: base_, facts: facts_ }; }

  function finish(base_, facts_) {
    const verdict = classifyUnregistered(facts_);
    if (!verdict) return null;
    const act = lastActivity({ worktree: base_.worktree, tipTime: base_.tipTime, dirty: base_.dirty, deadlineAt, clock, stat, refFiles: base_.branch ? refFilesOf(base_.branch) : [] });
    const idleDays = act.at === null || act.at > nowMs ? null : Math.floor((nowMs - act.at) / DAY_MS);
    const stale = provablyIdle(act, nowMs, staleDays * DAY_MS);
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
    return pend(
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
    return pend(
      { kind: 'branch', worktree: null, branch: b.name, detached: false, locked: false, head: b.oid, ahead: Number.isInteger(b.ahead) ? b.ahead : null,
        committed, evidence: ev.evidence, ...(ev.duplicateOf ? { duplicateOf: ev.duplicateOf } : {}),
        risks: { staged: 0, unstaged: 0, untracked: 0, unpushed }, ...(unverified.length ? { unverified } : {}), tipTime: b.tipTime ?? null, dirty: [] },
      { probed: unverified.length === 0, local: [], syncOwned: [], committed, ...ev, unverified },
    );
  }
}

// ── live sessions (shared by status and handover) ───────────────────────────

/**
 * Split a status's registered items the way `status` itself reads them: `live` (still being worked on) and
 * `mergedUnreleased` (derived done from merged evidence, but the registry record is still non-terminal —
 * someone should run `release`). A record already terminal is neither.
 */
export function liveSessionsOf(facts, status) {
  const raw = new Map((facts.registry?.sessions ?? []).map((s) => [s.id, s]));
  const live = []; const mergedUnreleased = [];
  for (const i of status.items) {
    if (!i.tracked) continue;
    if (!isTerminalState(i.state)) live.push(i);
    else if (raw.has(i.id) && !isTerminalState(raw.get(i.id).state)) mergedUnreleased.push(i);
  }
  return { live, mergedUnreleased };
}

/** What claims cover: their worktrees and branches. A merged-unreleased record still covers until released. */
export const coveredBy = (items) => ({ worktrees: items.map((i) => i.worktree).filter(Boolean), branches: items.map((i) => i.branch).filter(Boolean) });

// ── archive tags (v) ────────────────────────────────────────────────────────

/** At most this many `archive/*` tags are judged per scan; the rest are counted, never dropped silently. */
export const ARCHIVE_TAG_LIMIT = 50;
const LS_REMOTE_TIMEOUT_MS = 15_000;

/**
 * The remote's tags matching `pattern` as name -> commit oid: ONE bounded `ls-remote`, which asks the REMOTE (a
 * remote-tracking ref survives a remote deletion; this does not). Shared by the archive-tag scan and the tag credit of
 * the unregistered-work scan, so the two cannot disagree about what the remote holds.
 * @param {(args: string[], cwd: string, opts?: object) => {ok: boolean, stdout: string, reason?: string}} g a (clipped) git runner
 * @returns {{ok: true, tags: Map<string, string>} | {ok: false, reason: string}}
 */
export function lsRemoteTags(g, repo, pattern) {
  const ls = g(['ls-remote', '--tags', 'origin', pattern], repo, { timeoutMs: LS_REMOTE_TIMEOUT_MS });
  if (!ls.ok) return { ok: false, reason: ls.reason ?? 'ls-remote failed' };
  const tags = new Map();
  for (const line of String(ls.stdout).split('\n')) {
    const [oid, ref] = line.split('\t');
    if (!ref || !oid) continue;
    // A peeled `^{}` line names the commit an annotated tag points at: it is the oid that counts.
    const name = ref.replace(/^refs\/tags\//, '').replace(/\^\{\}$/, '');
    if (ref.endsWith('^{}') || !tags.has(name)) tags.set(name, oid.trim());
  }
  return { ok: true, tags };
}

/**
 * `archive/*` tags whose commits are not contained in base, each judged `superseded` (its whole diff against its
 * merge-base with base is empty, or its patch-id is in the squash window) or `unlanded`, and each with where it
 * is preserved — the strength of the evidence kept apart:
 *   `remote`     one bounded `ls-remote` shows the SAME tag name at the SAME oid (verified now);
 *   `last-fetch` a remote-tracking branch contained the commit at the last fetch (weaker: such refs survive a
 *                remote deletion or rewrite);
 *   `unknown`    `ls-remote` failed and no tracking branch has it;
 *   `local-only` otherwise: one disk away from lost.
 * @returns {{queried: boolean, reason?: string, tags: object[], overflow: number, counts: object}}
 */
export function scanArchiveTags(repo, { baseRev, deadlineAt = null, clock = Date.now, git = runGit, patchIdOf = null, squash = null } = {}) {
  const g = clippedGit(git, { deadlineAt, clock, cap: UNREGISTERED_BUDGET.probeTimeoutMs });
  const none = { tags: [], overflow: 0, counts: { unlanded: 0, superseded: 0, 'local-only': 0, 'last-fetch': 0, remote: 0, unknown: 0 } };
  if (!baseRev) return { queried: false, reason: 'no base to compare against', ...none };
  const list = g(['for-each-ref', `--no-merged=${baseRev}`, '--format=%(refname:short)%00%(objectname)%00%(*objectname)', 'refs/tags/archive'], repo);
  if (!list.ok) return { queried: false, reason: list.reason ?? 'for-each-ref failed', ...none };
  const all = String(list.stdout).split('\n').filter(Boolean).map((l) => { const [name, oid, peeled] = l.split('\0'); return { name, oid: peeled || oid }; });
  const judged = all.slice(0, ARCHIVE_TAG_LIMIT);
  const pidOf = patchIdOf ?? ((oid) => { const p = gitPatchId(repo, baseRev, oid); return p.queried ? { id: p.patchId } : null; });
  // Past the deadline the squash window is not read (no tag is then judged: `overflow` says how many were left).
  const pastDeadline = () => deadlineAt !== null && clock() >= deadlineAt;
  // A real run reads it through the memoised `runGit` path; an injected git (a test) is passed through.
  const window = squash ?? (pastDeadline() ? null : squashPatchIds(repo, baseRev, git === runGit ? {} : { git }));
  // One bounded network read for the whole set; its failure is `unknown`, never "local-only".
  let remoteTags = null;
  if (judged.length && !(deadlineAt !== null && clock() >= deadlineAt)) {
    const ls = lsRemoteTags(g, repo, 'refs/tags/archive/*');
    if (ls.ok) remoteTags = ls.tags;
  }
  const tags = [];
  for (const t of judged) {
    // Checked before each per-tag patch-id: a call already started keeps its own timeout, so the overrun is one call.
    if (pastDeadline()) break;
    const pid = pidOf(t.oid);
    const verdict = pid && pid.id === null ? 'superseded' : pid && window?.byPatchId?.has?.(pid.id) ? 'superseded' : 'unlanded';
    let preserved;
    if (remoteTags?.get(t.name) === t.oid) preserved = 'remote';
    else {
      const tracking = g(['branch', '-r', '--contains', t.oid], repo);
      // A failed lookup is not "no tracking branch has it": `local-only` needs BOTH checks to have answered.
      if (tracking.ok && String(tracking.stdout).trim()) preserved = 'last-fetch';
      else preserved = remoteTags === null || !tracking.ok ? 'unknown' : 'local-only';
    }
    tags.push({ name: t.name, oid: t.oid, verdict, preserved });
  }
  const counts = { ...none.counts };
  for (const t of tags) { counts[t.verdict] += 1; if (t.verdict === 'unlanded') counts[t.preserved] += 1; }
  return { queried: true, tags, overflow: all.length - tags.length, counts };
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

/**
 * Where the cache lives: `<git-common-dir>/fleet-cache/`, beside the commit-id cache and OUTSIDE the registry, so
 * `status` stays strictly read-only towards `fleet/` (byte-identical registry, never creates it) and every
 * worktree of a repo reads the same file. Null when the common dir cannot be resolved.
 */
export function unregisteredCacheDir(cwd) {
  const common = cacheDirFor(cwd);
  return common ? path.join(common, 'fleet-cache') : null;
}
export const UNREGISTERED_CACHE_SCHEMA_VERSION = 1;
const CacheSchema = z.object({
  schemaVersion: z.literal(UNREGISTERED_CACHE_SCHEMA_VERSION),
  at: z.string(),
  staleDays: z.number().int().positive(),
  partial: z.boolean(),
  notProbed: z.number().int().nonnegative(),
  branchesUnknown: z.string().optional(),
  counts: z.object({
    candidates: z.number().int().nonnegative(), total: z.number().int().nonnegative(), abandoned: z.number().int().nonnegative(), localOnly: z.number().int().nonnegative(),
    unverified: z.number().int().nonnegative(),
  }).strict(),
}).strict();

/** The cache record for a scan result. */
export function cacheRecord(scan, now) {
  const abandoned = scan.items.filter(isAbandoned);
  return {
    schemaVersion: UNREGISTERED_CACHE_SCHEMA_VERSION, at: new Date(toMs(now) ?? Date.now()).toISOString(), staleDays: scan.staleDays,
    partial: scan.partial, notProbed: scan.notProbed, ...(scan.branchesUnknown ? { branchesUnknown: scan.branchesUnknown } : {}),
    counts: {
      candidates: scan.candidates ?? scan.items.length, total: scan.items.length, abandoned: abandoned.length, localOnly: abandoned.filter((i) => i.preserved === 'none').length,
      unverified: scan.items.filter((i) => i.verdict === 'unverified').length,
    },
  };
}

/** Write the derived cache beside `hold.json`. Never throws: a failure is returned for a `warning:` line. */
export function writeUnregisteredCache(dir, record) {
  try {
    if (!dir) return { ok: false, reason: 'the git common dir could not be resolved' };
    CacheSchema.parse(record);
    fs.mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(path.join(dir, UNREGISTERED_CACHE_FILE), `${JSON.stringify(record, null, 2)}\n`);
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

/** Read the cache: `{state:'missing'|'unreadable'|'ok', record?, reason?}`. Never throws. */
export function readUnregisteredCache(dir) {
  let text;
  if (!dir) return { state: 'unreadable', reason: 'the git common dir could not be resolved' };
  try { text = fs.readFileSync(path.join(dir, UNREGISTERED_CACHE_FILE), 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable', reason: e.code ?? e.message };
  }
  try {
    const parsed = CacheSchema.safeParse(JSON.parse(text));
    return parsed.success ? { state: 'ok', record: parsed.data } : { state: 'unreadable', reason: 'schema mismatch' };
  } catch (e) { return { state: 'unreadable', reason: e.message }; }
}
