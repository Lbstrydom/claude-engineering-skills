/**
 * @fileoverview `fleet restack <branch>` — the commonest chore after a squash
 * merge: a stacked branch still carries its parent's (now squashed) commits, so
 * replay ONLY its own commits onto the fresh base and prove nothing changed.
 *
 * Three separated stages:
 *  1. **construct** in a THROWAWAY worktree at `onto`, with no consumer hooks
 *     (cherry-pick has no `--no-verify`; an empty `core.hooksPath` is the train's
 *     own mechanism). A conflict confined to `appendOnlyGlobs` is union-resolved;
 *     any other conflict aborts, removes the worktree and reports — never a half
 *     state anywhere a user can see.
 *  2. **validate** — patch-id of `from..oldTip` vs `onto..candidate`, excluding
 *     `.fleet.json` `restackIgnore`.
 *  3. **publish** — ONLY through `git update-ref` with an expected old value:
 *     a new `<branch>-restack` (or `-restack-mismatch` when the patch differs), or,
 *     with `--replace`, the branch itself when it is checked out NOWHERE. A
 *     checked-out branch is never moved by fleet (a check-then-reset is not
 *     atomic); the owning session adopts the new ref itself.
 * Never pushes; prints the commands.
 *
 * Plan: docs/plans/fleet-consumer-feedback-oct.md §2.5.
 *
 * @module scripts/lib/fleet/restack
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ArgvError } from '../cli-io.mjs';
import { CANON_DIFF_CONFIG, CANON_DIFF_FLAGS, headOf, listWorktrees, parsePatchId, resolveMeasurementBase } from './git-facts.mjs';
import { listMergedPullRequests } from './merged-facts.mjs';
import { resolveUpstream } from './facts.mjs';
import { listTrains } from './registry.mjs';
import { resolveAppendOnly } from './union-merge.mjs';
import { defaultDeps, noHooksDir } from './train.mjs';
import { currentBranch, failed, ok, refused } from './commands.mjs';
import { renderCommand } from './shell-quote.mjs';

const short = (o) => String(o ?? '?').slice(0, 12);

/** Patch-id of the diff `a..b` excluding `ignore` globs; `null` for an empty diff. */
export function rangePatchId(git, cwd, a, b, ignore = []) {
  // `:(top)` makes the comparison repo-wide whatever directory the CLI runs from.
  const spec = ['--', ':(top)', ...ignore.map((g) => `:(top,exclude,glob)${g}`)];
  const d = git([...CANON_DIFF_CONFIG, 'diff', ...CANON_DIFF_FLAGS, a, b, ...spec], cwd);
  if (!d.ok) return { ok: false, reason: d.reason };
  if (d.stdout === '') return { ok: true, patchId: null };
  const p = git(['patch-id', '--stable'], cwd, { input: d.stdout });
  return p.ok ? { ok: true, patchId: parsePatchId(p.stdout) } : { ok: false, reason: p.reason };
}

/**
 * The stacked-on parent a branch was built from: among merged PR heads that are
 * STRICT ancestors of the tip, the CLOSEST one (fewest commits between it and the
 * tip) — ancestry decides, never merge time.
 *  - `{kind:'parent', oid, pr}` — found;
 *  - `{kind:'none'}` — the merged-PR list was complete and no head is an ancestor
 *    (the merge-base with `onto` is then the honest range start);
 *  - `{kind:'unknown', reason}` — the list was not read, or was truncated: a
 *    squash-merged parent cannot be ruled out, so a range is never guessed.
 */
export function inferFrom({ git, cwd, oldTip, merged }) {
  if (!merged?.queried) return { kind: 'unknown', reason: `merged PRs not read (${merged?.reason ?? 'unknown reason'})` };
  let best = null;
  for (const p of merged.prs) {
    if (p.headOid === oldTip || p.isCrossRepository) continue;
    if (git(['merge-base', '--is-ancestor', p.headOid, oldTip], cwd).status !== 0) continue;
    const n = git(['rev-list', '--count', `${p.headOid}..${oldTip}`], cwd);
    const dist = n.ok ? Number.parseInt(n.stdout.trim(), 10) : NaN;
    if (!Number.isInteger(dist)) continue;
    if (!best || dist < best.dist) best = { kind: 'parent', oid: p.headOid, pr: p.number, dist };
  }
  // A truncated list cannot prove the ancestor it found is the CLOSEST one (or that there is none).
  if (merged.complete === false) return { kind: 'unknown', reason: `the merged-PR list may be truncated (${merged.reason ?? 'incomplete'})` };
  return best ?? { kind: 'none' };
}

function isCheckedOut(cwd, branch) {
  const l = listWorktrees(cwd);
  if (!l.queried) return { known: false, reason: l.reason };
  const w = l.worktrees.find((x) => x.branch === branch && !x.bare);
  return { known: true, at: w?.path ?? null };
}

/**
 * Replay the commits `from..oldTip` onto `onto` in worktree `wt`.
 * @returns {{ok: true, candidate: string, unioned: string[]} | {ok: false, reason: string, files?: string[]}}
 */
function construct({ deps, cwd, wt, onto, commits, globs, hooksDir }) {
  const add = deps.git(['-c', `core.hooksPath=${hooksDir}`, 'worktree', 'add', '--detach', wt, onto], cwd);
  if (!add.ok) return { ok: false, reason: `could not create the restack worktree: ${add.reason}` };
  const ident = deps.git(['var', 'GIT_COMMITTER_IDENT'], wt).ok ? [] : ['-c', 'user.name=fleet', '-c', 'user.email=fleet@localhost'];
  const wgit = (args, opts) => deps.git([...ident, '-c', `core.hooksPath=${hooksDir}`, '-c', 'core.editor=true', ...args], wt, opts);
  const unioned = [];
  for (const c of commits) {
    const r = wgit(['cherry-pick', '--allow-empty', c]);
    if (r.ok) continue;
    const unmerged = wgit(['diff', '--name-only', '--diff-filter=U']);
    const files = unmerged.ok ? unmerged.stdout.split('\n').filter(Boolean) : [];
    if (!files.length) {
      // Not a content conflict: most often the change is already in `onto` (an empty pick).
      const staged = wgit(['diff', '--cached', '--quiet']);
      if (staged.status === 0) { if (wgit(['cherry-pick', '--skip']).ok) continue; }
      wgit(['cherry-pick', '--abort']);
      return { ok: false, reason: `cherry-pick of ${short(c)} failed: ${r.reason}` };
    }
    const u = resolveAppendOnly({ dir: wt, git: (a, o) => wgit(a, o), globs });
    if (!u.ok) {
      wgit(['cherry-pick', '--abort']);
      return { ok: false, reason: `conflict replaying ${short(c)} — ${u.ineligible ? u.reason : `not resolved: ${u.reason}`}`, files };
    }
    unioned.push(...u.resolved);
    const cont = wgit(['cherry-pick', '--continue']);
    if (!cont.ok) { wgit(['cherry-pick', '--abort']); return { ok: false, reason: `could not continue after resolving ${u.resolved.join(', ')}: ${cont.reason}` }; }
  }
  const head = wgit(['rev-parse', 'HEAD']);
  return head.ok ? { ok: true, candidate: head.stdout.trim(), unioned } : { ok: false, reason: `cannot read the restacked head: ${head.reason}` };
}

/**
 * `fleet restack [<branch>] [--onto <ref>] [--from <oid>] [--replace]`.
 * @param {object} ctx
 * @param {Record<string, any>} flags
 * @param {string[]} positionals
 * @param {ReturnType<typeof defaultDeps>} [deps]
 */
export function cmdRestack(ctx, flags, positionals, deps = defaultDeps({ now: () => ctx.now })) {
  const branch = positionals[0] ?? currentBranch(ctx.cwd);
  if (!branch) throw new ArgvError('fleet restack: name the branch (HEAD is detached)');
  const tip = headOf(ctx.cwd, `refs/heads/${branch}`);
  if (!tip.ok) return refused(`no local branch ${branch}`);
  const oldTip = tip.oid;
  const base = ctx.config.baseBranch;
  let onto;
  if (flags['--onto'] !== undefined) {
    const o = deps.git(['rev-parse', '--verify', '--quiet', `${flags['--onto']}^{commit}`], ctx.cwd);
    if (!o.ok) return refused(`--onto ${flags['--onto']} does not resolve to a commit`);
    onto = o.stdout.trim();
  } else {
    const { upstream } = resolveUpstream(ctx.cwd, base, listTrains(ctx.dir).trains);
    const m = resolveMeasurementBase(ctx.cwd, { base, upstream });
    if (!m.ok) return refused(`cannot resolve the base ${base}: ${m.reason}`);
    onto = m.oid;
  }
  let from; let fromWhy;
  if (flags['--from'] !== undefined) {
    const f = deps.git(['rev-parse', '--verify', '--quiet', `${flags['--from']}^{commit}`], ctx.cwd);
    if (!f.ok) return refused(`--from ${flags['--from']} does not resolve to a commit`);
    from = f.stdout.trim(); fromWhy = '--from';
  } else {
    const inferred = inferFrom({ git: deps.git, cwd: ctx.cwd, oldTip, merged: listMergedPullRequests(ctx.cwd, { base, env: ctx.env }) });
    if (inferred.kind === 'unknown') {
      return refused(`cannot tell which of ${branch}'s commits are its own: ${inferred.reason}. A squash-merged parent's commits would be replayed again — pass --from <the parent's last commit>`);
    }
    if (inferred.kind === 'parent') { from = inferred.oid; fromWhy = `head of merged PR #${inferred.pr}`; } else {
      const mb = deps.git(['merge-base', onto, oldTip], ctx.cwd);
      if (!mb.ok) return refused(`${branch} and ${short(onto)} share no history`);
      from = mb.stdout.trim(); fromWhy = `merge-base with ${short(onto)}`;
    }
  }
  const anc = deps.git(['merge-base', '--is-ancestor', from, oldTip], ctx.cwd);
  if (anc.status !== 0) return refused(`${short(from)} is not an ancestor of ${branch}`);
  const merges = deps.git(['rev-list', '--merges', `${from}..${oldTip}`], ctx.cwd);
  if (!merges.ok) return failed(`cannot list ${from}..${branch}: ${merges.reason}`);
  if (merges.stdout.trim()) return refused(`${branch} has merge commits since ${short(from)} (${merges.stdout.trim().split('\n').map(short).join(', ')}); restack replays linear history only`);
  const list = deps.git(['rev-list', '--reverse', `${from}..${oldTip}`], ctx.cwd);
  if (!list.ok) return failed(`cannot list ${from}..${branch}: ${list.reason}`);
  const commits = list.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!commits.length) return refused(`${branch} has no commits of its own after ${short(from)} (${fromWhy})`);

  // ── construct ──
  const wt = path.join(ctx.config.worktreeRoot, 'restack', `${branch.replace(/[^A-Za-z0-9._-]+/g, '-')}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const hooks = noHooksDir();
  let built;
  const cleanupNotes = [];
  try {
    built = construct({ deps, cwd: ctx.cwd, wt, onto, commits, globs: ctx.config.appendOnlyGlobs ?? [], hooksDir: hooks.dir });
  } catch (e) {
    built = { ok: false, reason: `restack failed: ${e.message}` };
  } finally {
    // Each cleanup runs on its own; a failure is REPORTED, never allowed to mask the result or the other cleanup.
    try {
      const rm = deps.removeWorktree({ dir: wt, cwd: ctx.cwd });
      if (rm && rm.ok === false) cleanupNotes.push(`the throwaway worktree ${wt} was not fully removed — run git worktree prune`);
    } catch (e) { cleanupNotes.push(`removing ${wt} failed: ${e.message}`); }
    try { hooks.cleanup(); } catch (e) { cleanupNotes.push(`removing the empty hooks dir failed: ${e.message}`); }
  }
  const head = `restack ${branch}: ${commits.length} commit(s) from ${short(from)} (${fromWhy}) onto ${short(onto)}`;
  const notes = cleanupNotes.map((n) => `  note: ${n}`);
  if (!built.ok) {
    return { ok: false, code: 'refused', reason: built.reason, text: [`${head} — NOT restacked: ${built.reason}`, ...(built.files?.length ? [`  conflicting files: ${built.files.join(', ')}`] : []), '  nothing was written; the branch is unchanged', ...notes].join('\n') };
  }

  if (built.candidate === onto) {
    return { ok: false, code: 'refused', reason: 'every commit is already in the base', text: `${head} — nothing to restack: every commit is already in ${short(onto)} (the branch has landed); nothing was written` };
  }

  // ── validate ──
  // Union-resolved files differ BY DESIGN (both sides kept), so they join the exclusions and are disclosed.
  const ignore = [...new Set([...(ctx.config.restackIgnore ?? []), ...built.unioned])];
  const before = rangePatchId(deps.git, ctx.cwd, from, oldTip, ignore);
  const after = rangePatchId(deps.git, ctx.cwd, onto, built.candidate, ignore);
  if (!before.ok || !after.ok) return failed(`cannot compare patches: ${before.reason ?? after.reason}`);
  let equal = before.patchId === after.patchId;
  const lost = [];
  for (const file of [...new Set(built.unioned)]) {
    const mine = deps.git(['diff', '--no-color', '--no-ext-diff', '--unified=0', from, oldTip, '--', `:(top)${file}`], ctx.cwd);
    const result = deps.git(['show', `${built.candidate}:${file}`], ctx.cwd);
    if (!mine.ok || !result.ok) { lost.push(`${file} (could not compare)`); continue; }
    const have = new Set(result.stdout.split('\n'));
    const added = mine.stdout.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
    if (added.some((l) => !have.has(l))) lost.push(file);
  }
  if (lost.length) equal = false;
  const lines = [head];
  if (lost.length) lines.push(`  append-only files that did NOT keep all of ${branch}'s added lines: ${lost.join(', ')}`);
  if (built.unioned.length) lines.push(`  append-only files merged keeping both sides: ${[...new Set(built.unioned)].join(', ')}`);
  lines.push(`  patch-id ${equal ? 'EQUAL' : 'DIFFERS'}${ignore.length ? ` (excluding ${ignore.join(', ')})` : ''}`);

  // ── publish ──
  const create = (name) => deps.git(['update-ref', `refs/heads/${name}`, built.candidate, ''], ctx.cwd);
  if (!equal) {
    const diag = `${branch}-restack-mismatch`;
    const w = create(diag);
    const diff = deps.git(['diff', '--name-only', `${from}..${oldTip}`], ctx.cwd);
    lines.push(w.ok ? `  wrote ${diag} @ ${short(built.candidate)} for inspection; ${branch} was NOT changed${flags['--replace'] ? ' (--replace ignored: the patch differs)' : ''}` : `  could not write ${diag}: ${w.reason}`);
    if (diff.ok) lines.push(`  compare: git diff ${from}..${oldTip} vs git diff ${onto}..${built.candidate}`);
    return { ok: false, code: 'refused', reason: 'patch differs', candidate: built.candidate, text: lines.join('\n') };
  }
  if (flags['--replace']) {
    const co = isCheckedOut(ctx.cwd, branch);
    if (!co.known) return failed(`cannot tell where ${branch} is checked out (${co.reason}); nothing was moved`);
    if (co.at) {
      const w = create(`${branch}-restack`);
      if (!w.ok) return failed(`could not write ${branch}-restack: ${w.reason}`);
      lines.push(`  ${branch} is checked out at ${co.at}, so fleet did not move it; wrote ${branch}-restack @ ${short(built.candidate)}`,
        `  to adopt it, in that worktree: ${renderCommand(['git', 'reset', '--keep', `${branch}-restack`])}`);
    } else {
      const w = deps.git(['update-ref', `refs/heads/${branch}`, built.candidate, oldTip], ctx.cwd);
      if (!w.ok) return failed(`${branch} moved while restacking (expected ${short(oldTip)}); nothing was replaced — candidate ${short(built.candidate)}`);
      lines.push(`  replaced ${branch}: ${short(oldTip)} -> ${short(built.candidate)} (old tip ${oldTip})`);
    }
  } else {
    const w = create(`${branch}-restack`);
    if (!w.ok) return failed(`could not write ${branch}-restack (it may already exist): ${w.reason}`);
    lines.push(`  wrote ${branch}-restack @ ${short(built.candidate)}; ${branch} is unchanged`);
  }
  lines.push(`  push when ready: ${renderCommand(['git', 'push', '--force-with-lease', 'origin', `${flags['--replace'] ? branch : `${branch}-restack`}:${branch}`])}`);
  lines.push(...notes);
  return ok({ branch, from, onto, candidate: built.candidate, equal, unioned: built.unioned, text: lines.join('\n') });
}
