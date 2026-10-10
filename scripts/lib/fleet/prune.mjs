/**
 * @fileoverview `fleet prune` — which local branches and worktrees can be removed
 * with nothing lost, PROVEN from fleet's own evidence. Read-only: it prints the
 * exact commands and runs none of them (removal is irreversible, so a person —
 * or the coordinator they authorised — runs them).
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
 * this command runs in, and a LOCKED worktree (git's own "in use" marker — an
 * agent or tool holding it, even on a branch that has not moved off base yet).
 *
 * Cleanliness is judged HERE, by `archiveReport`, not by the status probe
 * (which only probes up to a cap and may leave a worktree unchecked): the hide
 * rule is evaluated as if clean, then the archive evidence decides.
 *
 * @module scripts/lib/fleet/prune
 */
import path from 'node:path';
import { gatherFacts, buildStatusFrom } from './facts.mjs';
import { hideReason, idleMsFrom } from './overlap.mjs';
import { archiveReport } from './lifecycle.mjs';
import { headOf, isAncestor, listWorktrees, repoToplevel } from './git-facts.mjs';
import { renderCommand } from './shell-quote.mjs';
import { ok } from './commands.mjs';

const samePath = (a, b) => Boolean(a && b) && path.resolve(a).replace(/\\/g, '/').toLowerCase() === path.resolve(b).replace(/\\/g, '/').toLowerCase();

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
  // Two sources of candidates. (1) status items (branches with work or a session) that the
  // hide rules call merged/landed. (2) local branches with NOTHING ahead of base: status does
  // not list those at all, yet they are the plainest "merged" case — same rules applied here.
  const inputs = [];
  for (const item of status.items) {
    if (item.kind !== 'branch' || !item.branch) continue;
    const reason = hideReason(item.worktree ? { ...item, worktreeClean: true } : item, hctx);
    if (reason === 'merged' || reason === 'landed') inputs.push({ ...item, reason });
  }
  const listed = new Set(status.items.map((i) => i.branch).filter(Boolean));
  const tracked = new Set((f.registry?.sessions ?? []).map((s) => s.source?.branch).filter(Boolean));
  const openHeads = new Set((f.prs?.prs ?? []).filter((p) => !p.isCrossRepository).map((p) => p.headRef));
  if (hctx.prsComplete) {
    for (const b of f.branches?.branches ?? []) {
      if (b.ahead !== 0 || b.name === base || listed.has(b.name) || tracked.has(b.name) || openHeads.has(b.name)) continue;
      const w = wt.queried ? wt.worktrees.find((x) => x.branch === b.name && !x.bare) : null;
      inputs.push({ branch: b.name, oid: b.oid, worktree: w?.path ?? null, reason: 'merged', merged: null });
    }
  }
  for (const item of inputs) {
    const { reason } = item;
    if (item.branch === base) continue;
    const wtRec = item.worktree && wt.queried ? wt.worktrees.find((w) => samePath(w.path, item.worktree)) : null;
    if (wtRec?.locked) { excluded.push({ branch: item.branch, worktree: item.worktree, reason: 'its worktree is locked (in use)' }); continue; }
    if (item.worktree && (samePath(item.worktree, mainCheckout) || (here.ok && samePath(item.worktree, here.dir)))) {
      excluded.push({ branch: item.branch, reason: `checked out in ${samePath(item.worktree, mainCheckout) ? 'the main checkout' : 'this worktree'}` });
      continue;
    }
    const via = reason === 'merged' ? 'tip already in base' : `landed (${item.merged?.via === 'squash' ? `squash ${String(item.merged.commit).slice(0, 12)}` : `PR #${item.merged?.pr}`})`;
    const commands = [];
    if (item.worktree) {
      // branch:null — the PR question is already answered (hideReason requires pr === null), and
      // asking gh once per branch would make prune as slow as the clutter it removes.
      const r = report(ctx, { branch: null, worktree: item.worktree });
      const risky = Object.entries(r.risks).filter(([k, v]) => k !== 'unpushed' && v.length);
      if (risky.length || r.unverified.length) {
        excluded.push({
          branch: item.branch, worktree: item.worktree,
          reason: risky.length ? `worktree holds ${risky.map(([k, v]) => `${v.length} ${k}`).join(', ')}` : `cannot verify the worktree: ${r.unverified[0]}`,
        });
        continue;
      }
      commands.push(renderCommand(['git', 'worktree', 'remove', item.worktree]));
    }
    // -d is git's own merged check (works for ahead 0); a squash-landed tip needs -D, justified above.
    commands.push(renderCommand(['git', 'branch', reason === 'merged' ? '-d' : '-D', item.branch]));
    // The REMOTE branch is a separate decision: the evidence covers the LOCAL tip only. Suggest deleting
    // the remote branch only when its tip IS that tip or an ancestor of it (its commits are a subset of
    // what landed); a remote that moved on, or diverged, is named and left alone. The judgement reads
    // the LAST-FETCHED origin/<b>, so the printed delete carries it as a lease: git refuses the delete
    // if the remote branch is no longer at the tip that was judged (someone pushed since the fetch).
    const remote = headOf(ctx.cwd, `refs/remotes/origin/${item.branch}`);
    let remoteCmd = null; let remoteNote = null;
    if (remote.ok) {
      const covered = remote.oid === item.oid || (item.oid && isAncestor(ctx.cwd, remote.oid, item.oid).value === true);
      if (covered) remoteCmd = renderCommand(['git', 'push', `--force-with-lease=refs/heads/${item.branch}:${remote.oid}`, 'origin', '--delete', item.branch]);
      else remoteNote = `origin/${item.branch} is at ${remote.oid.slice(0, 12)}, not covered by the landed tip — left alone`;
    }
    candidates.push({
      branch: item.branch, reason, via, worktree: item.worktree ?? null, oid: item.oid ?? null,
      commands, remote: remoteCmd, ...(remoteNote ? { remoteNote } : {}),
    });
  }
  return { candidates, excluded, notJudged };
}

export function renderPrune(p) {
  const lines = [];
  lines.push(`fleet prune — ${p.candidates.length} removable with nothing lost (read-only: nothing was removed)`);
  for (const n of p.notJudged) lines.push(`  not judged: ${n}`);
  for (const c of p.candidates) {
    lines.push('', `${c.branch} — ${c.via}${c.worktree ? ` · worktree ${c.worktree}` : ''}`);
    for (const cmd of c.commands) lines.push(`    ${cmd}`);
    if (c.remote) lines.push(`    ${c.remote}    # optional: the remote branch too`);
    if (c.remoteNote) lines.push(`    # ${c.remoteNote}`);
  }
  if (p.excluded.length) {
    lines.push('', `kept (${p.excluded.length}) — look before removing:`);
    for (const e of p.excluded) lines.push(`  ${e.branch}: ${e.reason}`);
  }
  return lines.join('\n');
}

export function cmdPrune(ctx) {
  const p = planPrune(ctx);
  return ok({ prune: p, text: renderPrune(p) });
}
