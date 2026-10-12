/**
 * @fileoverview `fleet prune` — which local branches and worktrees can be removed
 * with nothing lost, PROVEN from fleet's own evidence. By default read-only: it
 * prints the exact commands and runs none of them. `--apply` runs EXACTLY that
 * list — a candidate's structured `steps` are the single source for both the
 * printed commands and the executed ones — behind guards the plan alone cannot
 * give: the branch tip must still be the judged tip, no session may have
 * registered the branch since, and git's own refusals (a dirty or locked
 * worktree, an unmerged `-d`) are never overridden with `--force`. A remote
 * branch is deleted only with `--remote`, leased on the judged tip.
 *
 * A branch is a candidate only when the default status view would hide it as
 * `merged` (its tip is already in base: ahead 0) or `landed` (merged evidence —
 * the merged-PR head or a squash patch-id that postdates the fork — covers its
 * EXACT tip). `idle` is never a candidate: age is not evidence of anything.
 * Those hide rules already require: no registered session, no open PR, a
 * complete PR list, and a clean worktree.
 *
 * A candidate with a worktree must then pass `archiveReport` (the archive-check
 * evidence): no staged, unstaged, untracked or ignored-and-unlisted files and
 * nothing unverifiable. Its "unpushed commits" are NOT a risk here — the branch's
 * exact tip is proven merged, so the content is on base even when the remote
 * branch was deleted after a squash merge. Everything else excludes, with the
 * reason, so an excluded branch says what to look at.
 *
 * Never a candidate: the base branch, the main checkout's worktree, the worktree
 * this command runs in, a LOCKED worktree (git's own "in use" marker — an
 * agent or tool holding it, even on a branch that has not moved off base yet),
 * and a worktree another worktree's `core.hooksPath` lies inside (removing it
 * would silently disable that worktree's hooks; `hooks-path-guard.mjs`, re-checked
 * by `--apply` under the lock).
 *
 * Cleanliness is judged HERE, by `archiveReport`, not by the status probe
 * (which only probes up to a cap and may leave a worktree unchecked): the hide
 * rule is evaluated as if clean, then the archive evidence decides.
 *
 * @module scripts/lib/fleet/prune
 */
import path from 'node:path';
import { ArgvError } from '../cli-io.mjs';
import { gatherFacts, buildStatusFrom } from './facts.mjs';
import { DEFAULT_STALE_WORKTREE_DAYS, hideReason, idleMsFrom, landedReason } from './overlap.mjs';
import { archiveReport } from './lifecycle.mjs';
import { headOf, isAncestor, listWorktrees, remoteRefOid, repoToplevel, runGit } from './git-facts.mjs';
import { hooksPathDependents, hooksPathRefusals } from './hooks-path-guard.mjs';
import { transact } from './registry.mjs';
import { renderCommand } from './shell-quote.mjs';
import { samePath as samePathOnPlatform } from '../harness-paths.mjs';
import { ok } from './commands.mjs';
import { branchRefFiles, lastActivity, provablyIdle } from './unregistered.mjs';
import { renderOrphans, scanOrphanDirs } from './prune-orphans.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The agent step no CLI can perform, printed at the end of every prune run (plan §2.6 y). */
export const SESSION_LIST_CHECK = 'Before --apply: confirm in the desktop session list that no session, pinned or dormant included, uses these directories or branches';

const REMOTE_TIMEOUT_MS = 30_000;

// Platform-aware path identity (case and separators fold only on win32) — the helper handover and unregistered use.
const samePath = (a, b) => Boolean(a && b) && samePathOnPlatform(a, b);

/**
 * @param {{cwd: string, config: object, now: Date, env: NodeJS.ProcessEnv, cmd: string}} ctx
 * @param {{facts?: object, report?: typeof archiveReport}} [deps] test seams
 */
export function planPrune(ctx, { facts = null, report = archiveReport } = {}) {
  const f = facts ?? gatherFacts({ cwd: ctx.cwd, config: ctx.config, now: ctx.now, env: ctx.env, cmd: ctx.cmd });
  const status = buildStatusFrom(f);
  const base = ctx.config.baseBranch;
  const hctx = { prsComplete: status.sources?.prs?.complete === true, now: status.observedAt ?? null, idleMs: idleMsFrom(ctx.config) };
  const wt = listWorktrees(ctx.cwd);
  const mainCheckout = wt.queried ? (wt.worktrees.find((w) => !w.bare)?.path ?? null) : null;
  const here = repoToplevel(ctx.cwd);
  const candidates = [];
  const excluded = [];
  const notJudged = [];
  if (!hctx.prsComplete) notJudged.push('the open-PR list is incomplete or was not read, so no branch can be shown to have no open PR');
  // Without the worktree list a branch's checkout cannot be found, so no branch is judged removable.
  if (!wt.queried) return { candidates, excluded, notJudged: [...notJudged, `the worktree list could not be read (${wt.reason}), so no branch can be shown to be checked out nowhere`], orphans: null, upstreamGone: [] };
  const staleMs = (ctx.config.staleWorktreeDays ?? DEFAULT_STALE_WORKTREE_DAYS) * DAY_MS;
  // Every `branch.*` config key, read once (names only; matched in JS, so no regex escaping of branch names). Exit 1
  // is git's "no match" — none at all; any other failure is UNREAD (null), never "no config".
  let configKeys;
  const branchConfigKeys = () => {
    if (configKeys === undefined) {
      const r = runGit(['config', '--local', '--name-only', '--get-regexp', '^branch\\.'], ctx.cwd);
      configKeys = r.ok ? String(r.stdout).split('\n').map((k) => k.trim()).filter(Boolean) : r.status === 1 ? [] : null;
    }
    return configKeys;
  };
  // The EXACT subsection: `branch.<name>.<var>` where <var> has no dot. A prefix test would let branch `foo` claim
  // `branch.foo.bar.remote`, which belongs to branch `foo.bar`.
  const hasBranchSection = (keys, name) => keys.some((k) => k.startsWith(`branch.${name}.`) && !k.slice(`branch.${name}.`.length).includes('.'));
  const tipTimeOf = new Map((f.branches?.branches ?? []).map((b) => [b.name, b.tipTime ?? null]));
  const nowMs = ctx.now instanceof Date ? ctx.now.getTime() : Date.now();
  // Two sources of candidates. (1) status items (branches with work or a session) that the
  // hide rules call merged/landed. (2) local branches with NOTHING ahead of base: status does
  // not list those at all, yet they are the plainest "merged" case — same rules applied here.
  const inputs = [];
  for (const item of status.items) {
    if (item.kind !== 'branch' || !item.branch) continue;
    // hideReason gates (untracked, no open PR, complete PR list); landedReason names WHY it is removable.
    const reason = hideReason(item.worktree ? { ...item, worktreeClean: true } : item, hctx) && landedReason(item);
    if (reason) inputs.push({ ...item, reason });
  }
  const listed = new Set(status.items.map((i) => i.branch).filter(Boolean));
  const tracked = new Set((f.registry?.sessions ?? []).map((s) => s.source?.branch).filter(Boolean));
  const openHeads = new Set((f.prs?.prs ?? []).filter((p) => !p.isCrossRepository).map((p) => p.headRef));
  if (hctx.prsComplete) {
    for (const b of f.branches?.branches ?? []) {
      if (landedReason({ ahead: b.ahead }) !== 'merged' || b.name === base || listed.has(b.name) || tracked.has(b.name) || openHeads.has(b.name)) continue;
      const w = wt.queried ? wt.worktrees.find((x) => x.branch === b.name && !x.bare) : null;
      inputs.push({ branch: b.name, oid: b.oid, worktree: w?.path ?? null, reason: 'merged', merged: null });
    }
  }
  for (const item of inputs) {
    const { reason } = item;
    if (item.branch === base) continue;
    const wtRec = item.worktree && wt.queried ? wt.worktrees.find((w) => samePath(w.path, item.worktree)) : null;
    if (wtRec?.locked) { excluded.push({ branch: item.branch, worktree: item.worktree, reason: 'its worktree is locked (in use)' }); continue; }
    // `update-ref -d` (unlike `branch -d`) does not refuse a branch some checkout still has: every checkout counts.
    const checkouts = wt.worktrees.filter((w) => !w.bare && w.branch === item.branch);
    if (checkouts.length > 1) { excluded.push({ branch: item.branch, reason: `it is checked out in ${checkouts.length} worktrees` }); continue; }
    // The evidence (and the unpushed discount below) covers exactly the judged tip: a worktree elsewhere is not covered.
    if (wtRec && item.oid && wtRec.head !== item.oid) {
      excluded.push({ branch: item.branch, worktree: item.worktree, reason: `its worktree HEAD ${String(wtRec.head).slice(0, 12)} is not the judged tip ${item.oid.slice(0, 12)}` });
      continue;
    }
    if (item.worktree && (samePath(item.worktree, mainCheckout) || (here.ok && samePath(item.worktree, here.dir)))) {
      excluded.push({ branch: item.branch, reason: `checked out in ${samePath(item.worktree, mainCheckout) ? 'the main checkout' : 'this worktree'}` });
      continue;
    }
    const via = reason === 'merged' ? 'tip already in base' : `landed (${item.merged?.via === 'squash' ? `squash ${String(item.merged.commit).slice(0, 12)}` : `PR #${item.merged?.pr}`})`;
    // `steps` is the one record of what removal means: the printed `commands` and `--apply` both read it.
    const steps = [];
    if (item.worktree) {
      // branch:null — the PR question is already answered (hideReason requires pr === null), and
      // asking gh once per branch would make prune as slow as the clutter it removes.
      const r = report(ctx, { branch: null, worktree: item.worktree });
      // Unpushed commits are not a risk here ONLY because the worktree's HEAD is the judged tip (checked above),
      // whose exact commits the merged evidence covers.
      const risky = Object.entries(r.risks).filter(([k, v]) => k !== 'unpushed' && v.length);
      if (risky.length || r.unverified.length) {
        excluded.push({
          branch: item.branch, worktree: item.worktree,
          reason: risky.length ? `worktree holds ${risky.map(([k, v]) => `${v.length} ${k}`).join(', ')}` : `cannot verify the worktree: ${r.unverified[0]}`,
        });
        continue;
      }
      // Another worktree whose core.hooksPath lies inside this one would lose its hooks without a word (2026-10-12).
      const hooks = hooksPathRefusals(hooksPathDependents(item.worktree, wt.worktrees), item.worktree);
      if (hooks.length) { excluded.push({ branch: item.branch, worktree: item.worktree, reason: hooks.join('; ') }); continue; }
      steps.push({ kind: 'worktree', argv: ['git', 'worktree', 'remove', item.worktree] });
    }
    // Bound to the judged commit: `update-ref -d <ref> <oid>` refuses when the branch no longer points at it, so a
    // printed command run later, or an executed one racing a push, never deletes commits nobody judged.
    if (!item.oid) { excluded.push({ branch: item.branch, reason: 'its tip was not recorded, so a delete could not be bound to it' }); continue; }
    steps.push({ kind: 'branch', argv: ['git', 'update-ref', '-d', `refs/heads/${item.branch}`, item.oid] });
    // `branch -d` also drops `branch.<name>.*` (upstream, merge); `update-ref -d` does not. Removed after the ref, and
    // only when the section exists now — so the step never fails on "no such section" and stops a later candidate.
    const keys = branchConfigKeys();
    if (keys === null) { excluded.push({ branch: item.branch, reason: 'the branch configuration could not be read, so its cleanup cannot be planned' }); continue; }
    if (hasBranchSection(keys, item.branch)) {
      steps.push({ kind: 'config', argv: ['git', 'config', '--remove-section', `branch.${item.branch}`] });
    }
    // The REMOTE branch is a separate decision: the evidence covers the LOCAL tip only. Suggest deleting
    // the remote branch only when its tip IS that tip or an ancestor of it (its commits are a subset of
    // what landed); a remote that moved on, or diverged, is named and left alone. The judgement reads
    // the LAST-FETCHED origin/<b>, so the printed delete carries it as a lease: git refuses the delete
    // if the remote branch is no longer at the tip that was judged (someone pushed since the fetch).
    const remote = headOf(ctx.cwd, `refs/remotes/origin/${item.branch}`);
    let remoteStep = null; let remoteNote = null;
    if (remote.ok) {
      const covered = remote.oid === item.oid || (item.oid && isAncestor(ctx.cwd, remote.oid, item.oid).value === true);
      if (covered) remoteStep = { kind: 'remote', argv: ['git', 'push', `--force-with-lease=refs/heads/${item.branch}:${remote.oid}`, 'origin', '--delete', item.branch] };
      else remoteNote = `origin/${item.branch} is at ${remote.oid.slice(0, 12)}, not covered by the landed tip — left alone`;
    }
    const act = lastActivity({ worktree: item.worktree ?? null, tipTime: tipTimeOf.get(item.branch) ?? null, refFiles: branchRefFiles(ctx.cwd, item.branch) });
    // Not provably idle (recent, unknown or future-dated) is FRESH: a just-started session's branch looks exactly like this.
    const fresh = !provablyIdle(act, nowMs, staleMs);
    candidates.push({
      branch: item.branch, reason, via, worktree: item.worktree ?? null, oid: item.oid ?? null,
      fresh, idleDays: act.at === null || act.at > nowMs ? null : Math.floor((nowMs - act.at) / DAY_MS),
      steps, remoteStep, commands: steps.map((st) => renderCommand(st.argv)),
      remote: remoteStep ? renderCommand(remoteStep.argv) : null, ...(remoteNote ? { remoteNote } : {}),
    });
  }
  const roots = [...new Set([mainCheckout ? path.join(mainCheckout, '.claude', 'worktrees') : null, ctx.config.worktreeRoot].filter(Boolean))];
  return { candidates, excluded, notJudged, orphans: scanOrphanDirs({ roots, worktrees: wt.worktrees, archiveIgnore: ctx.config.archiveIgnore ?? [] }), upstreamGone: upstreamGoneBranches(ctx.cwd) };
}

/** Local branches whose upstream is gone (`%(upstream:track)` = `[gone]`). Display only: a deleted remote is not evidence the commits landed. */
export function upstreamGoneBranches(cwd, { git = runGit } = {}) {
  const r = git(['for-each-ref', '--format=%(refname:short)%00%(upstream:track)', 'refs/heads'], cwd);
  if (!r.ok) return [];
  return String(r.stdout).split('\n').map((l) => l.split('\0')).filter(([n, t]) => n && /\bgone\b/.test(t ?? '')).map(([n]) => n);
}

const keptLines = (p) => (p.excluded.length
  ? ['', `kept (${p.excluded.length}) — look before removing:`, ...p.excluded.map((e) => `  ${e.branch}: ${e.reason}`)]
  : []);

/**
 * Run the plan: each candidate's `steps` in order (worktree, then branch), then — only with `remote` — its
 * leased remote delete. Per candidate, under `fleet/.lock` and for local git only (never across the
 * network): re-read the registry and the branch tip, because the plan was judged earlier and a session may
 * have registered the branch, or pushed a commit onto it, since. A step that fails stops that candidate, so a
 * branch is never deleted after its worktree failed to go. Nothing is ever forced.
 *
 * @param {{cwd: string, dir: string}} ctx
 * @param {ReturnType<typeof planPrune>} plan
 * @param {{remote?: boolean, git?: typeof runGit, tipOf?: typeof headOf, remoteOf?: typeof remoteRefOid}} [opts] test seams
 */
export function applyPrune(ctx, plan, { remote = false, includeFresh = false, git = runGit, tipOf = headOf, remoteOf = remoteRefOid, list = listWorktrees, report = archiveReport } = {}) {
  const results = [];
  for (const c of plan.candidates) {
    const res = { branch: c.branch, status: 'removed', done: [], doneKinds: [], reason: null, remote: null };
    if (c.fresh && !includeFresh) {
      results.push({ ...res, status: 'skipped', reason: `fresh (last activity ${c.idleDays === null ? 'unknown' : `${c.idleDays}d ago`}): a just-started session's branch looks like this; confirm in the session list, then --include-fresh` });
      continue;
    }
    const tx = transact(ctx.dir, (t) => {
      if (!t.complete) return { skip: 'the session registry is unreadable, so "no registered session" cannot be re-proved' };
      if (t.sessions.some((s) => s.source?.branch === c.branch)) return { skip: 'a session has registered this branch since it was judged' };
      if (!c.oid) return { skip: 'its tip was not recorded, so it cannot be confirmed unchanged' };
      const tip = tipOf(ctx.cwd, `refs/heads/${c.branch}`);
      if (!tip.ok) return { skip: 'the branch no longer exists' };
      if (tip.oid !== c.oid) return { skip: `its tip moved since it was judged (${c.oid.slice(0, 12)} → ${tip.oid.slice(0, 12)})` };
      // `update-ref -d` does not refuse a checked-out branch, so the checkout facts the plan judged are re-read here,
      // under the lock: exactly the planned worktree (at the judged tip) may have it, or none when none was planned.
      const wts = list(ctx.cwd);
      if (!wts.queried) return { skip: `the worktree list could not be re-read (${wts.reason})` };
      const checkouts = wts.worktrees.filter((w) => !w.bare && w.branch === c.branch);
      const planned = c.worktree ? checkouts.length === 1 && samePath(checkouts[0].path, c.worktree) && checkouts[0].head === c.oid : checkouts.length === 0;
      if (!planned) return { skip: `its checkouts changed since it was judged (${checkouts.length} worktree(s) now have it)` };
      // The worktree's loss evidence is re-read too: `git worktree remove` refuses dirty or untracked files on its own,
      // but not ignored data outside archiveIgnore, which may have appeared since the plan.
      if (c.worktree) {
        const r = report(ctx, { branch: null, worktree: c.worktree });
        const risky = Object.entries(r.risks).filter(([k, v]) => k !== 'unpushed' && v.length);
        if (risky.length || r.unverified.length) return { skip: `its worktree changed since it was judged (${risky.length ? risky.map(([k, v]) => `${v.length} ${k}`).join(', ') : r.unverified[0]})` };
        // So is every OTHER worktree's core.hooksPath: one pointed into this worktree since the plan is refused, and
        // one that cannot be read refuses too.
        const hooks = hooksPathRefusals(hooksPathDependents(c.worktree, wts.worktrees, { git }), c.worktree);
        if (hooks.length) return { skip: hooks.join('; ') };
      }
      for (const st of c.steps) {
        const r = git(st.argv.slice(1), ctx.cwd);
        if (!r.ok) return { failed: `${renderCommand(st.argv)}: ${r.reason ?? 'failed'}` };
        res.done.push(renderCommand(st.argv));
        res.doneKinds.push(st.kind);
      }
      return {};
    });
    if (!tx.ok) Object.assign(res, { status: 'skipped', reason: 'could not acquire fleet/.lock (contention) — nothing was changed for this branch' });
    else if (tx.value.skip) Object.assign(res, { status: 'skipped', reason: tx.value.skip });
    else if (tx.value.failed) Object.assign(res, { status: 'failed', reason: tx.value.failed });
    else if (remote && c.remoteStep) res.remote = deleteRemote(ctx, c, { git, remoteOf });
    results.push(res);
  }
  const count = (pred) => results.filter(pred).length;
  return {
    results,
    counts: {
      removed: count((r) => r.status === 'removed'), skipped: count((r) => r.status === 'skipped'),
      failed: count((r) => r.status === 'failed' || r.remote?.status === 'failed'),
      remoteDeleted: count((r) => r.remote?.status === 'deleted'),
    },
  };
}

/** The leased remote delete, outside the registry lock. A remote branch that is already gone is done, not an error. */
function deleteRemote(ctx, c, { git, remoteOf }) {
  const live = remoteOf(ctx.cwd, 'origin', `refs/heads/${c.branch}`);
  if (!live.ok) return { status: 'failed', reason: `cannot read origin: ${live.reason}` };
  if (!live.oid) return { status: 'already-gone' };
  const r = git(c.remoteStep.argv.slice(1), ctx.cwd, { timeoutMs: REMOTE_TIMEOUT_MS });
  return r.ok ? { status: 'deleted' } : { status: 'failed', reason: `${renderCommand(c.remoteStep.argv)}: ${r.reason ?? 'failed'}` };
}

export function renderPrune(p, cmd = null) {
  const lines = [];
  lines.push(`fleet prune — ${p.candidates.length} removable with nothing lost (read-only: nothing was removed)`);
  for (const n of p.notJudged) lines.push(`  not judged: ${n}`);
  for (const c of p.candidates) {
    lines.push('', `${c.branch} — ${c.via}${c.worktree ? ` · worktree ${c.worktree}` : ''}${c.fresh ? ` · FRESH (activity ${c.idleDays === null ? 'unknown' : `${c.idleDays}d ago`}; --apply skips it without --include-fresh)` : ''}`);
    for (const command of c.commands) lines.push(`    ${command}`);
    if (c.remote) lines.push(`    ${c.remote}    # optional: the remote branch too`);
    if (c.remoteNote) lines.push(`    # ${c.remoteNote}`);
  }
  lines.push(...keptLines(p), ...goneLines(p), ...renderOrphans(p.orphans));
  if (p.candidates.length && cmd) lines.push('', `to run exactly these (local only): ${cmd} prune --apply   ·   add --remote for the leased remote deletes`);
  lines.push('', SESSION_LIST_CHECK);
  return lines.join('\n');
}

/** What a removal took, named from the KINDS of the steps it ran (a config cleanup is not a worktree). */
const removedWhat = (r) => [r.doneKinds?.includes('worktree') ? 'worktree' : null, 'branch', r.doneKinds?.includes('config') ? 'its config' : null].filter(Boolean).join(' + ');

function renderApplied(p, a) {
  const { removed, skipped, failed, remoteDeleted } = a.counts;
  const lines = [`fleet prune --apply — removed ${removed}, skipped ${skipped}, failed ${failed}${remoteDeleted ? `, ${remoteDeleted} remote deleted` : ''}`];
  for (const n of p.notJudged) lines.push(`  not judged: ${n}`);
  for (const r of a.results) {
    const what = r.status === 'removed' ? `removed (${removedWhat(r)})` : r.status === 'skipped' ? `skipped — ${r.reason}` : `FAILED — ${r.reason}`;
    const rem = !r.remote ? '' : r.remote.status === 'deleted' ? '; remote deleted' : r.remote.status === 'already-gone' ? '; remote already gone' : `; remote FAILED — ${r.remote.reason}`;
    lines.push(`  ${r.branch}: ${what}${rem}`);
  }
  lines.push(...keptLines(p), ...goneLines(p), ...renderOrphans(p.orphans), '', `${SESSION_LIST_CHECK} — a required agent step this command cannot perform`);
  return lines.join('\n');
}

const goneLines = (p) => (p.upstreamGone?.length
  ? ['', `upstream gone (${p.upstreamGone.length}) — display only; a deleted remote is not evidence the commits landed: ${p.upstreamGone.slice(0, 20).join(', ')}${p.upstreamGone.length > 20 ? ', …' : ''}`]
  : []);

export function cmdPrune(ctx, flags = {}) {
  const apply = flags['--apply'] === true;
  const remote = flags['--remote'] === true;
  const includeFresh = flags['--include-fresh'] === true;
  if (remote && !apply) throw new ArgvError('fleet prune: --remote only applies with --apply (it deletes the remote branches the plan judged removable)');
  if (includeFresh && !apply) throw new ArgvError('fleet prune: --include-fresh only applies with --apply');
  const p = planPrune(ctx);
  if (!apply) return ok({ prune: p, text: renderPrune(p, ctx.cmd) });
  const applied = applyPrune(ctx, p, { remote, includeFresh });
  const text = renderApplied(p, applied);
  if (applied.counts.failed) return { ok: false, code: 'error', reason: `${applied.counts.failed} removal(s) failed`, prune: p, applied, text };
  return ok({ prune: p, applied, text });
}
