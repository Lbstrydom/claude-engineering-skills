/**
 * @fileoverview The end of a session's life: `release` (retire a claim now,
 * instead of waiting for its lease to lapse) and `archive-check` (what removing
 * a worktree would destroy).
 *
 * `archive-check` is read-only and fails CLOSED: exit 0 only when every probe ran
 * and found nothing at risk; anything at risk is `AT RISK` (exit 3); a probe that
 * could not run makes an otherwise clean answer `UNVERIFIED` (exit 3) — an
 * incomplete inspection is never reported as clean. Sizes are display-only.
 *
 * Plan: docs/plans/fleet-consumer-feedback-oct.md §2.3.
 *
 * @module scripts/lib/fleet/lifecycle
 */
import fs from 'node:fs';
import path from 'node:path';
import micromatch from 'micromatch';
import { ArgvError } from '../cli-io.mjs';
import { runGit, listWorktrees } from './git-facts.mjs';
import { listPullRequests } from './gh-facts.mjs';
import { readSessions, transact } from './registry.mjs';
import { isTerminalState } from './overlap.mjs';
import { classifyEntries, parsePorcelainZ } from './worktree-status.mjs';
import { currentBranch, lockFailed, nowIso, ok, refused, selfId } from './commands.mjs';

/** Size walk bounds: display only, so over budget is "not measured", never a verdict change. */
export const SIZE_WALK = Object.freeze({ maxFiles: 5_000, deadlineMs: 10_000 });
/** The fixed "what do you still owe?" checklist (participant rule 7's report fields). */
export const OWED = Object.freeze([
  'final report: branch, PR numbers, the files you changed, any waitingOn',
  'every deliverable outside git (reports, decks, screenshots) copied somewhere durable',
  'open questions handed to the user, not left in this transcript',
]);

// Path identity follows the platform: case-folded only where the filesystem is case-insensitive.
const IS_WIN = process.platform === 'win32';
const samePath = (a, b) => (IS_WIN ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

// ── release ─────────────────────────────────────────────────────────────────

/**
 * `fleet release [--id] [--abandoned]` — retire a claim now: the session becomes
 * `done` (or `abandoned`), both existing terminal states, so its paths stop
 * blocking claims and it leaves the landing order. Never refuses on worktree
 * contents (releasing a claim loses nothing); the archive verdict is printed as
 * advice for whoever removes the worktree next.
 */
export function cmdRelease(ctx, flags) {
  const id = selfId(ctx, flags);
  const target = flags['--abandoned'] ? 'abandoned' : 'done';
  const tx = transact(ctx.dir, (t) => {
    const cur = t.sessions.find((s) => s.id === id);
    if (!cur) return { missing: true };
    if (isTerminalState(cur.state)) return { already: cur };
    return { record: t.writeSession({ ...cur, rev: cur.rev + 1, state: target, updatedAt: nowIso(ctx) }) };
  });
  if (!tx.ok) return lockFailed();
  const v = tx.value;
  if (v.missing) return refused(`no session ${id} is registered`);
  const session = v.record ?? v.already;
  const arch = archiveReport(ctx, { session });
  const head = v.already ? `${id} was already ${v.already.state} — nothing changed` : `released: ${id} (${target})`;
  return ok({ id, state: session.state, changed: Boolean(v.record), archive: arch, text: [head, ...renderArchive(arch, { advisory: true })].join('\n') });
}

// ── archive-check ───────────────────────────────────────────────────────────

/**
 * Resolve the target of `archive-check`: a session id, a branch, or a worktree
 * path — in that order. Returns what is known: session, branch, worktree path.
 */
export function resolveArchiveTarget(ctx, spec) {
  const sessions = readSessions(ctx.dir).sessions;
  const wts = listWorktrees(ctx.cwd);
  const worktrees = wts.queried ? wts.worktrees.filter((w) => !w.bare) : [];
  // A failed inventory is carried to the report: "no worktree found" must never read as "nothing to lose".
  const inventory = wts.queried ? {} : { inventoryError: `worktree list failed: ${wts.reason}` };
  const bySession = sessions.find((s) => s.id === spec);
  if (bySession) return { session: bySession, branch: bySession.source?.branch ?? null, worktree: bySession.worktree ?? worktrees.find((w) => w.branch === bySession.source?.branch)?.path ?? null, ...inventory };
  const byBranch = worktrees.find((w) => w.branch === spec);
  if (byBranch) return { session: sessions.find((s) => s.source?.branch === spec) ?? null, branch: spec, worktree: byBranch.path };
  const byPath = worktrees.find((w) => samePath(w.path, spec));
  if (byPath) return { session: sessions.find((s) => s.source?.branch === byPath.branch) ?? null, branch: byPath.branch ?? null, worktree: byPath.path };
  if (runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${spec}^{commit}`], ctx.cwd).ok) return { session: null, branch: spec, worktree: null, ...inventory };
  if (!wts.queried && fs.existsSync(spec)) return { session: null, branch: null, worktree: path.resolve(spec), ...inventory };
  return null;
}

/** A size-walk budget shared across one report, so N paths cannot cost N budgets. */
export function sizeBudget({ bounds = SIZE_WALK, clock = Date.now } = {}) {
  return { files: 0, start: clock(), clock, bounds };
}

/**
 * Bounded size of a path (file or tree), drawing on `budget` (one report-wide
 * budget). `{bytes, complete}`; incomplete = the budget ran out or a read failed.
 */
export function measureSize(abs, { budget = sizeBudget() } = {}) {
  let bytes = 0; let complete = true;
  const walk = (p) => {
    if (!complete) return;
    if (budget.files >= budget.bounds.maxFiles || budget.clock() - budget.start > budget.bounds.deadlineMs) { complete = false; return; }
    let st;
    try { st = fs.lstatSync(p); } catch { complete = false; return; }
    if (st.isDirectory()) {
      let names;
      try { names = fs.readdirSync(p); } catch { complete = false; return; }
      for (const n of names) walk(path.join(p, n));
    } else { budget.files += 1; bytes += st.size; }
  };
  walk(abs);
  return { bytes, complete };
}

/**
 * Is an ignored entry covered by `archiveIgnore`? A FILE matches a pattern as
 * usual. A DIRECTORY entry (`dist/`, collapsed by git) is excluded only by a
 * pattern that covers everything under it — `<prefix>/**` whose prefix matches
 * the directory — never by a pattern that merely matches some imagined child.
 */
export function isIgnoredByConfig(p, patterns) {
  // `p` comes from git porcelain, which always separates with "/": a backslash is a literal filename
  // character on POSIX and must never be read as a separator.
  const isDir = /\/$/.test(String(p));
  const bare = String(p).replace(/\/+$/, '');
  if (!isDir) return micromatch.isMatch(bare, patterns, { dot: true });
  return patterns.some((pat) => pat.endsWith('/**') && micromatch.isMatch(bare, pat.slice(0, -3), { dot: true }));
}

/**
 * Everything removing `worktree` (and deleting `branch`) would lose, plus the
 * reminders. Pure over its probes; `git` injectable for tests.
 * @returns {{verdict: 'CLEAN'|'AT RISK'|'UNVERIFIED', target: object, risks: object, unverified: string[], pr: object|null,
 *   waitingOn: object[], sizes: object, stashes: number|null, owed: readonly string[]}}
 */
export function archiveReport(ctx, { session = null, branch = session?.source?.branch ?? null, worktree = session?.worktree ?? null, inventoryError = null, git = runGit } = {}) {
  const unverified = inventoryError ? [inventoryError] : [];
  const risks = { staged: [], unstaged: [], untracked: [], ignored: [], unpushed: [] };
  const sizes = {};
  const ignore = ctx.config?.archiveIgnore ?? [];
  const budget = sizeBudget();
  // Commits nothing else holds may sit on the recorded branch AND on whatever the worktree has checked
  // out now (it may have switched since registration): both are probed.
  const headRefs = branch ? [`refs/heads/${branch}`] : [];
  if (worktree && fs.existsSync(worktree)) {
    const main = git(['status', '--porcelain=v1', '-z', '--no-renames', '--ignore-submodules=none', '--untracked-files=all'], worktree, { timeoutMs: 30_000 });
    if (!main.ok) unverified.push(`git status failed: ${main.reason}`);
    else {
      const c = classifyEntries(parsePorcelainZ(main.stdout));
      Object.assign(risks, { staged: c.staged, unstaged: c.unstaged, untracked: c.untracked });
    }
    // Ignored entries come from a SECOND call that collapses ignored directories (node_modules/ is one
    // line, not 100k), so the probe stays bounded.
    const ign = git(['status', '--porcelain=v1', '-z', '--no-renames', '--ignored=traditional', '--untracked-files=normal'], worktree, { timeoutMs: 30_000 });
    if (!ign.ok) unverified.push(`git status --ignored failed: ${ign.reason}`);
    else risks.ignored = classifyEntries(parsePorcelainZ(ign.stdout)).ignored.filter((p) => !isIgnoredByConfig(p, ignore));
    // Index flags hide edits from `git status`: skip-worktree (S) and assume-unchanged (lowercase tag).
    const lsv = git(['ls-files', '-v', '-z'], worktree, { timeoutMs: 30_000 });
    if (!lsv.ok) unverified.push(`git ls-files -v failed: ${lsv.reason}`);
    else {
      const hidden = lsv.stdout.split('\0').filter((r) => r.length > 2 && (r[0] === 'S' || /^[a-z]$/.test(r[0]))).map((r) => r.slice(2));
      if (hidden.length) unverified.push(`${hidden.length} file(s) are skip-worktree or assume-unchanged, so git status cannot see edits to them (${hidden.slice(0, 3).join(', ')}${hidden.length > 3 ? ', …' : ''})`);
    }
    for (const p of [...risks.untracked, ...risks.ignored]) sizes[p] = measureSize(path.join(worktree, p), { budget });
    // The worktree's ACTUAL HEAD (detached, or a branch other than the one recorded).
    const h = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], worktree);
    if (h.ok) headRefs.push(h.stdout.trim()); else unverified.push(`cannot resolve HEAD of ${worktree}: ${h.reason ?? 'unborn'}`);
  } else if (worktree) {
    unverified.push(`worktree ${worktree} does not exist`);
  }
  if (headRefs.length) {
    const rl = git(['rev-list', '--max-count=50', ...headRefs, '--not', '--remotes'], ctx.cwd);
    if (!rl.ok) unverified.push(`cannot list unpushed commits of ${branch ?? headRefs[0]}: ${rl.reason}`);
    else risks.unpushed = rl.stdout.split('\n').map((x) => x.trim()).filter(Boolean);
  }
  const st = git(['stash', 'list'], ctx.cwd);
  const stashes = st.ok ? st.stdout.split('\n').filter(Boolean).length : null;
  let pr = null;
  if (branch) {
    const prs = listPullRequests(ctx.cwd, { env: ctx.env });
    pr = prs.queried ? prs.prs.find((p) => p.headRef === branch && !p.isCrossRepository) ?? null : { unknown: prs.reason };
  }
  const atRisk = Object.values(risks).some((l) => l.length);
  const verdict = atRisk ? 'AT RISK' : unverified.length ? 'UNVERIFIED' : 'CLEAN';
  return { verdict, target: { session: session?.id ?? null, branch, worktree }, risks, unverified, pr, waitingOn: session?.waitingOn ?? [], sizes, stashes, owed: OWED };
}

const kb = (b) => `${Math.max(1, Math.round(b / 1024))} KB`;

/** Text lines for an archive report. `minKb` only shortens the listing; every path counted in the verdict. */
export function renderArchive(r, { minKb = 256, advisory = false } = {}) {
  const L = [`${advisory ? 'archive-check (advisory): ' : ''}${r.verdict}${r.target.worktree ? ` — worktree ${r.target.worktree}` : ''}${r.target.branch ? ` · branch ${r.target.branch}` : ''}`];
  const show = (label, list, withSize = false) => {
    if (!list.length) return;
    // A short list is shown whole; a long one is trimmed to the large entries (the verdict counts them all).
    const shown = withSize && list.length > 5 ? list.filter((p) => !r.sizes[p]?.complete || r.sizes[p].bytes >= minKb * 1024) : list;
    L.push(`  ${label} (${list.length}):`);
    for (const p of shown.slice(0, 20)) {
      const sz = withSize ? (r.sizes[p]?.complete ? ` — ${kb(r.sizes[p].bytes)}` : ' — size not measured') : '';
      L.push(`    ${p}${sz}`);
    }
    const hidden = list.length - Math.min(shown.length, 20);
    if (hidden > 0) L.push(`    +${hidden} more${withSize ? ` (smaller than ${minKb} KB or past the first 20)` : ''}`);
  };
  show('staged changes', r.risks.staged);
  show('unstaged changes to tracked files', r.risks.unstaged);
  show('untracked files', r.risks.untracked, true);
  show('gitignored files (not in archiveIgnore)', r.risks.ignored, true);
  if (r.risks.unpushed.length) L.push(`  unpushed commits: ${r.risks.unpushed.length}${r.risks.unpushed.length >= 50 ? '+' : ''} (${r.risks.unpushed.slice(0, 3).map((o) => o.slice(0, 12)).join(', ')}${r.risks.unpushed.length > 3 ? ', …' : ''})`);
  for (const u of r.unverified) L.push(`  NOT VERIFIED: ${u}`);
  if (r.pr?.unknown) L.push(`  open PR: not queried (${r.pr.unknown})`);
  else if (r.pr) L.push(`  open PR: #${r.pr.number}${r.pr.isDraft ? ' (draft)' : ''}`);
  for (const w of r.waitingOn) L.push(`  waiting on ${w.kind}:${w.ref}${w.note ? ` — ${w.note}` : ''}`);
  if (r.stashes) L.push(`  reminder: ${r.stashes} stash entr${r.stashes === 1 ? 'y' : 'ies'} in this repo (stashes are shared across worktrees; not part of the verdict)`);
  L.push('  what do you still owe?', ...r.owed.map((o) => `    - ${o}`));
  return L;
}

/** `fleet archive-check [<id|branch|path>] [--min-kb N]` — read-only. */
export function cmdArchiveCheck(ctx, flags, positionals) {
  const spec = positionals[0] ?? flags['--id'] ?? currentBranch(ctx.cwd);
  if (!spec) throw new ArgvError('fleet archive-check: name a session, branch or worktree path (HEAD is detached)');
  const minKb = flags['--min-kb'] === undefined ? 256 : Number(flags['--min-kb']);
  if (!Number.isInteger(minKb) || minKb < 0) throw new ArgvError(`fleet archive-check: --min-kb must be a whole number of KB (got ${JSON.stringify(flags['--min-kb'])})`);
  const target = resolveArchiveTarget(ctx, spec);
  if (!target) return refused(`no session, branch or worktree matches ${JSON.stringify(spec)}`);
  const r = archiveReport(ctx, target);
  const text = renderArchive(r, { minKb }).join('\n');
  return r.verdict === 'CLEAN' ? ok({ archive: r, text }) : { ok: false, code: 'refused', reason: r.verdict, archive: r, text };
}
