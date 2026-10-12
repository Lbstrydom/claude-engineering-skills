/**
 * @fileoverview `fleet archive <worktree|branch|path|id> [--apply] [--discard-ignored] [--include-fresh]` —
 * preserve a worktree's work as a local `archive/*` tag, verify it, then remove the worktree
 * (docs/plans/fleet-unclaimed-work-and-switch-friction.md §2.3).
 *
 * Dry run by default. `--apply` runs the chain:
 *   resolve → refuse anything it cannot preserve → snapshot into a TEMPORARY index (the worktree, its real
 *   index and every ref untouched) → deterministic commit (fixed identity, HEAD's date) → tag → verify the tag's
 *   tree → under the registry lock: revalidate → `git worktree remove --force` → check the directory is gone.
 * Planning and the revalidation both refuse while another worktree's `core.hooksPath` lies inside this one
 * (`hooks-path-guard.mjs`): removing it would silently disable that worktree's hooks.
 *
 * Revalidation order is load-bearing, because hashing WRITES objects: `add -A` into even a temporary index puts
 * blobs into the shared object database. So the cheap, write-free checks come first — both status listings byte
 * for byte (a new path changes them), then the sensitive-path and size gates over the (now proven unchanged) path
 * set — and only then the two tree hashes: the working tree (a second temporary index) and the real index
 * (`write-tree`). Neither tree alone is enough: a second edit to an already-modified file leaves the status text
 * unchanged (only the working-tree oid catches it), and staging a new version then restoring the file leaves the
 * working tree unchanged (only the real-index oid catches it).
 *
 * The verb never pushes (this repo is public and the sensitive-path gate is path-based) and never deletes a
 * branch. Coordination is cooperative: the remaining window is the milliseconds between the last compare and the
 * delete, and the output says so rather than claiming quiescence.
 *
 * @module scripts/lib/fleet/archive
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArgvError } from '../cli-io.mjs';
import { samePath } from '../harness-paths.mjs';
import { classifyPath, resolveAndClassify } from '../sensitive-paths.mjs';
import { failed, ok, refused } from './commands.mjs';
import { headOf, listWorktrees, repoToplevel, runGit } from './git-facts.mjs';
import { hooksPathDependents, hooksPathRefusals } from './hooks-path-guard.mjs';
import { archiveReport, resolveArchiveTarget } from './lifecycle.mjs';
import { DEFAULT_STALE_WORKTREE_DAYS, isTerminalState } from './overlap.mjs';
import { readSessions, transact } from './registry.mjs';
import { renderCommand } from './shell-quote.mjs';
import { lastActivity, provablyIdle } from './unregistered.mjs';
import { IGNORED_STATUS_ARGS, STATUS_ARGS, parsePorcelainZ } from './worktree-status.mjs';

/** The preservation set may not exceed this: a build-artefact tree stays out of the object database. */
export const ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
/** The fixed snapshot identity: a literal local string, so no user identity is read and no `user.name` is needed. */
export const SNAPSHOT_IDENTITY = Object.freeze({ name: 'fleet archive', email: 'fleet-archive@localhost' });
export const SNAPSHOT_MESSAGE = 'fleet archive: snapshot of uncommitted work';
const DAY_MS = 24 * 60 * 60 * 1000;
export const SESSION_LIST_CHECK = 'Before --apply: confirm in the desktop session list that no session, pinned or dormant included, uses this directory or branch';

/** A detached worktree's tag stem: every character git may refuse becomes `-`; nothing left → `detached`. */
export function sanitiseTagStem(name) {
  const s = String(name).replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '').replace(/\.{2,}/g, '.');
  return s || 'detached';
}

/**
 * Does a directory ENTRY exist? `lstat`, so a dangling symlink (an entry git records) counts — `existsSync` follows
 * links and would call it absent. Only ENOENT is absence; any other error counts as present, so the path is kept
 * in the forced add and the postcondition, where git itself then succeeds or fails loudly.
 */
export function entryExists(p) {
  try { fs.lstatSync(p); return true; } catch (e) { return e?.code !== 'ENOENT'; }
}

/** The preservation set from a status listing: every staged, unstaged and untracked path, plus what cannot be kept. */
export function classifyListing(stdout) {
  const set = new Set(); const partial = []; const unmerged = [];
  for (const e of parsePorcelainZ(stdout)) {
    if (e.x === '!' && e.y === '!') continue;
    set.add(e.path);
    if ('U'.includes(e.x) || 'U'.includes(e.y) || (e.x === 'A' && e.y === 'A') || (e.x === 'D' && e.y === 'D')) unmerged.push(e.path);
    else if (e.x !== ' ' && e.x !== '?' && e.y !== ' ' && e.y !== '?') partial.push(e.path);
  }
  return { set: [...set].sort(), partial, unmerged };
}

/** The sensitive and size gates over a path set. Pure over its probes; deleted paths copy nothing and are classified lexically. */
export function gateContent(worktree, paths, { classify = resolveAndClassify, lexical = classifyPath, lstat = fs.lstatSync } = {}) {
  const sensitive = []; const unmeasured = []; let bytes = 0;
  for (const p of paths) {
    const abs = path.join(worktree, p);
    let st = null;
    try { st = lstat(abs); } catch (e) { if (e.code !== 'ENOENT') unmeasured.push(p); }
    const category = st ? classify(p, { repoRoot: worktree }).category : lexical(p);
    if (category === 'sensitive') sensitive.push(p);
    if (st && st.isFile()) bytes += st.size;
    else if (st && st.isSymbolicLink()) bytes += st.size;
    else if (st && !st.isFile()) unmeasured.push(p); // a directory or special entry in a status listing: not measured
  }
  return { sensitive, unmeasured, bytes, overCap: bytes > ARCHIVE_MAX_BYTES };
}

/**
 * Tree of the WORKING TREE via a temporary index (`read-tree HEAD`, `add -A`, `write-tree`); the real index is untouched.
 * A sibling of `vcs.mjs`'s `gitWorktreeTree` on purpose: this one runs INSIDE the registry lock, so every call goes
 * through `runGit` (time-bounded, git environment sanitised) and an injectable `git` (the race tests); that one is
 * an unbounded `execSync` with the caller's environment, which could hold the lock indefinitely.
 */
function workingTreeOid(git, worktree, tmpDir, label, seedTree, preserve = []) {
  // Seeded from the REAL index's tree, not HEAD: a staged path that ignore rules cover (`git add -f`) is in the
  // preservation set, and a plain `add -A` over a HEAD-seeded index would leave it out. Partially staged paths are
  // refused earlier, so real-index tree + every working-tree change is the whole preservation set — except an
  // intent-to-add entry (`git add -N`), which `write-tree` leaves out of the seed and `add -A` skips when ignore
  // rules cover it. So every preservation path still on disk is then added by name, forced.
  const env = { GIT_INDEX_FILE: path.join(tmpDir, `index-${label}`) };
  for (const args of [['read-tree', seedTree], ['add', '-A']]) {
    const r = git(args, worktree, { env });
    if (!r.ok) return { ok: false, reason: `git ${args.join(' ')} (temporary index): ${r.reason}` };
  }
  const onDisk = preserve.filter((p) => entryExists(path.join(worktree, p)));
  if (onDisk.length) {
    // On stdin, NUL-separated (no argv limit, no quoting) and `--literal-pathspecs`: a file named `:(glob)*` or `*`
    // is that file, never a pattern that stages others.
    const f = git(['--literal-pathspecs', 'add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], worktree, { env, input: `${onDisk.join('\0')}\0` });
    if (!f.ok) return { ok: false, reason: `git add -f (preservation set, temporary index): ${f.reason}` };
  }
  const w = git(['write-tree'], worktree, { env });
  return w.ok ? { ok: true, oid: w.stdout.trim() } : { ok: false, reason: `git write-tree (temporary index): ${w.reason}` };
}

/** Everything the snapshot and the revalidation compare, captured once. */
function capture(git, worktree) {
  const head = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], worktree);
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], worktree);
  const main = git(STATUS_ARGS, worktree, { timeoutMs: 30_000 });
  const ign = git(IGNORED_STATUS_ARGS, worktree, { timeoutMs: 30_000 });
  // `symbolic-ref --quiet` exits 1 for a detached HEAD — that, and only that, means "no branch"; any other failure
  // is an unread fact, never a silent "detached".
  const branchError = !branch.ok && branch.status !== 1 ? `git symbolic-ref failed: ${branch.reason}` : null;
  return {
    head: head.ok ? head.stdout.trim() : null, branch: branch.ok ? branch.stdout.trim() : null,
    status: main.ok ? main.stdout : null, ignored: ign.ok ? ign.stdout : null,
    errors: [head.ok ? null : 'HEAD does not resolve (an unborn branch has nothing to archive)', branchError, main.ok ? null : `git status failed: ${main.reason}`, ign.ok ? null : `git status --ignored failed: ${ign.reason}`].filter(Boolean),
  };
}

/** Does `refs/tags/<name>` resolve to exactly `snap`, whose tree is exactly `tree`? */
function tagIsSnapshot(git, cwd, name, snap, tree) {
  const c = git(['rev-parse', `refs/tags/${name}^{commit}`], cwd);
  const t = git(['rev-parse', `refs/tags/${name}^{tree}`], cwd);
  return c.ok && t.ok && c.stdout.trim() === snap && t.stdout.trim() === tree;
}

/** Archive tags already made for a branch: `archive/<branch>` and `archive/<branch>-<short oid>`. */
export function existingArchiveTags(git, cwd, branch) {
  // Full refnames: `%(refname:short)` can change shape when a name is ambiguous, so it is no basis for ownership.
  const r = git(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(creatordate:iso-strict)', `refs/tags/archive/${branch}`, `refs/tags/archive/${branch}-*`], cwd);
  // A failed listing is not "no tags": it is returned as such, so the caller never says "nothing archived".
  if (!r.ok) return { ok: false, reason: r.reason ?? 'for-each-ref failed', tags: [] };
  // The glob `archive/<branch>-*` also matches `archive/<branch>-cleanup`: keep only this branch's own names.
  const own = (name) => name === `archive/${branch}` || (name.startsWith(`archive/${branch}-`) && /^[0-9a-f]{12}$/.test(name.slice(`archive/${branch}-`.length)));
  const tags = String(r.stdout).split('\n').filter(Boolean).map((l) => {
    const [ref, oid, peeled, date] = l.split('\0');
    return { name: ref.replace(/^refs\/tags\//, ''), oid: peeled || oid, date };
  });
  return { ok: true, tags: tags.filter((t) => own(t.name)) };
}

/**
 * Judge an archive: every refusal, the preservation set, the tag stem. Read-only.
 * @returns {{target: object, refusals: string[], set: string[], ignored: string[], bytes: number, stem: string|null, capture: object|null, fresh: boolean, idleDays: number|null}}
 */
export function planArchive(ctx, target, { git = runGit, discardIgnored = false, includeFresh = false, list = listWorktrees, report = archiveReport, stat = fs.statSync } = {}) {
  const refusals = [];
  const out = { target, refusals, set: [], ignored: [], bytes: 0, stem: null, capture: null, fresh: false, idleDays: null };
  const wts = list(ctx.cwd);
  if (!wts.queried) { refusals.push(`the worktree list could not be read (${wts.reason})`); return out; }
  const rec = wts.worktrees.find((w) => !w.bare && samePath(w.path, target.worktree));
  if (!rec) { refusals.push(`${target.worktree} is not a \`git worktree list\` entry`); return out; }
  let lst;
  try { lst = fs.lstatSync(target.worktree); } catch (e) { refusals.push(`${target.worktree} cannot be read (${e.code ?? e.message})`); return out; }
  if (lst.isSymbolicLink()) { refusals.push('the worktree root is a symlink or junction — refused (INC-001)'); return out; }
  try {
    if (!samePath(fs.realpathSync.native(target.worktree), fs.realpathSync.native(rec.path))) { refusals.push('the requested path does not resolve to the listed worktree'); return out; }
  } catch (e) { refusals.push(`realpath failed (${e.code ?? e.message})`); return out; }
  const mainPath = wts.worktrees.find((w) => !w.bare)?.path;
  const here = repoToplevel(ctx.cwd);
  if (samePath(rec.path, mainPath)) refusals.push('it is the main checkout');
  if (here.ok && samePath(rec.path, here.dir)) refusals.push('it is the worktree this command runs in');
  if (rec.locked) refusals.push('the worktree is locked (git\'s own "in use" marker)');
  const live = liveClaimOn(ctx.dir, rec.path, rec.branch);
  if (live) refusals.push(`a live claim covers it (${live})`);
  if (fs.existsSync(path.join(rec.path, '.gitmodules'))) refusals.push('.gitmodules exists: a submodule\'s inner changes cannot be snapshotted');
  // Another worktree whose core.hooksPath lies inside this one would lose its hooks without a word (2026-10-12).
  refusals.push(...hooksPathRefusals(hooksPathDependents(rec.path, wts.worktrees, { git }), rec.path));
  if (refusals.length) return out;

  const cap = capture(git, rec.path);
  out.capture = cap;
  refusals.push(...cap.errors);
  const r = report(ctx, { branch: null, worktree: rec.path });
  refusals.push(...r.unverified.map((u) => `not verified: ${u}`));
  if (cap.status !== null) {
    const listing = classifyListing(cap.status);
    out.set = listing.set;
    if (listing.partial.length) refusals.push(`partially staged (staged AND changed again; a working-tree snapshot would drop the staged version): ${listing.partial.slice(0, 10).join(', ')} — stage everything with \`git add -A\` in that worktree, or reset the index, then re-run`);
    const um = git(['ls-files', '-u'], rec.path);
    if (!um.ok) refusals.push(`git ls-files -u failed: ${um.reason}`);
    else if (um.stdout.trim() || listing.unmerged.length) refusals.push(`the index has unmerged entries: ${(listing.unmerged.length ? listing.unmerged : ['(see git ls-files -u)']).slice(0, 10).join(', ')}`);
    const gate = gateContent(rec.path, out.set);
    out.bytes = gate.bytes;
    if (gate.sensitive.length) refusals.push(`sensitive path(s) in the preservation set: ${gate.sensitive.slice(0, 10).join(', ')} — a snapshot would copy them into the object database`);
    if (gate.unmeasured.length) refusals.push(`size not measured for: ${gate.unmeasured.slice(0, 10).join(', ')}`);
    if (gate.overCap) refusals.push(`the preservation set is ${Math.round(gate.bytes / 1048576)} MiB, over the ${ARCHIVE_MAX_BYTES / 1048576} MiB cap`);
  }
  out.ignored = r.risks.ignored ?? [];
  if (out.ignored.length && !discardIgnored) refusals.push(`gitignored data outside archiveIgnore would be lost: ${out.ignored.slice(0, 10).join(', ')} — pass --discard-ignored to accept that`);
  // Fresh: the one liveness signal a CLI can compute. Not proof a dormant pinned session is gone (the session-list step).
  const tip = git(['log', '-1', '--format=%ct', 'HEAD'], rec.path);
  const tipTime = tip.ok && /^\d+$/.test(tip.stdout.trim()) ? Number(tip.stdout.trim()) * 1000 : null;
  const act = lastActivity({ worktree: rec.path, tipTime, dirty: out.set, stat });
  const nowMs = ctx.now instanceof Date ? ctx.now.getTime() : Date.now();
  out.idleDays = act.at === null || act.at > nowMs ? null : Math.floor((nowMs - act.at) / DAY_MS);
  out.fresh = !provablyIdle(act, nowMs, (ctx.config?.staleWorktreeDays ?? DEFAULT_STALE_WORKTREE_DAYS) * DAY_MS);
  if (out.fresh && !includeFresh) refusals.push(`the worktree is fresh (last activity ${out.idleDays === null ? 'unknown' : `${out.idleDays}d ago`}): a just-created session's worktree looks like this — confirm in the session list, then --include-fresh`);
  if (cap.head) out.stem = rec.branch ? `archive/${rec.branch}` : `archive/${sanitiseTagStem(path.basename(rec.path))}-${cap.head.slice(0, 12)}`;
  if (out.stem && !git(['check-ref-format', `refs/tags/${out.stem}`], ctx.cwd).ok) refusals.push(`the tag name ${out.stem} is not a valid ref name`);
  return out;
}

/**
 * Which live claim covers this worktree or branch: its id, `'(registry unreadable)'` when the registry cannot be
 * read completely (a claim may be hiding there — fail closed), or null.
 */
function liveClaimOn(dir, worktree, branch, sessions = null) {
  let list = sessions;
  if (!list) {
    const reg = readSessions(dir);
    if (!reg.complete) return '(registry unreadable)';
    list = reg.sessions;
  }
  const hit = list.find((s) => !isTerminalState(s.state) && ((s.worktree && samePath(s.worktree, worktree)) || (branch && s.source?.branch === branch)));
  return hit ? hit.id : null;
}

/**
 * Run the chain. Returns `{status, tag?, oid?, reason?, leftover?}`: `archived` (exit 0), `aborted` (exit 3,
 * tag and worktree kept), `failed` (exit 1).
 */
export function applyArchive(ctx, plan, { git = runGit, tmpRoot = os.tmpdir(), list = listWorktrees } = {}) {
  const wt = plan.target.worktree;
  const cap = plan.capture;
  const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'fleet-archive-'));
  try {
    // 1. Snapshot. An empty preservation set mints no commit: the tag is HEAD itself.
    let snap = cap.head; let tree;
    const headTree = git(['rev-parse', `${cap.head}^{tree}`], wt);
    if (!headTree.ok) return { status: 'failed', reason: `cannot read HEAD's tree: ${headTree.reason}` };
    // Before the FIRST hash (`add -A` writes blobs): the world must still be the one the plan judged. A path that
    // appeared since — a sensitive one included — changes a listing, so it aborts here, before any object exists.
    const pre = capture(git, wt);
    if (pre.errors.length) return { status: 'aborted', reason: `changed since the plan: ${pre.errors[0]}` };
    if (pre.head !== cap.head || pre.branch !== cap.branch || pre.status !== cap.status || pre.ignored !== cap.ignored) {
      return { status: 'aborted', reason: 'changed since the plan (HEAD, branch or a status listing moved) — nothing was written; re-run' };
    }
    const preGate = gateContent(wt, plan.set);
    if (preGate.sensitive.length || preGate.unmeasured.length || preGate.overCap) return { status: 'aborted', reason: 'the sensitive-path or size gate no longer passes — nothing was written' };
    // The real index's tree: the seed of every working-tree snapshot, and a capture the revalidation compares.
    const realIndex = git(['write-tree'], wt);
    if (!realIndex.ok) return { status: 'failed', reason: `git write-tree (real index): ${realIndex.reason}` };
    const indexTree = realIndex.stdout.trim();
    if (plan.set.length) {
      const w = workingTreeOid(git, wt, tmpDir, 'snapshot', indexTree, plan.set);
      if (!w.ok) return { status: 'failed', reason: w.reason };
      tree = w.oid;
      // Postcondition: every preservation path still on disk IS in the snapshot tree — checked, never assumed.
      const listed = git(['ls-tree', '-r', '-z', '--name-only', tree], wt);
      if (!listed.ok) return { status: 'failed', reason: `cannot list the snapshot tree: ${listed.reason}` };
      const inTree = new Set(String(listed.stdout).split('\0').filter(Boolean));
      const missing = plan.set.filter((p) => entryExists(path.join(wt, p)) && !inTree.has(p));
      if (missing.length) return { status: 'failed', reason: `the snapshot would not hold: ${missing.slice(0, 5).join(', ')} — nothing was tagged or removed` };
      const date = git(['log', '-1', '--format=%ct %z', cap.head], wt);
      if (!date.ok) return { status: 'failed', reason: `cannot read HEAD's date: ${date.reason}` };
      const stamp = date.stdout.trim().replace(/^(\d+) ([+-]\d{4})$/, '$1 $2');
      const env = { GIT_AUTHOR_NAME: SNAPSHOT_IDENTITY.name, GIT_AUTHOR_EMAIL: SNAPSHOT_IDENTITY.email, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_NAME: SNAPSHOT_IDENTITY.name, GIT_COMMITTER_EMAIL: SNAPSHOT_IDENTITY.email, GIT_COMMITTER_DATE: stamp };
      const c = git(['-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', cap.head, '-m', SNAPSHOT_MESSAGE], wt, { env });
      if (!c.ok) return { status: 'failed', reason: `git commit-tree: ${c.reason}` };
      snap = c.stdout.trim();
    } else tree = headTree.stdout.trim();
    // 2. Tag: the stem; taken at another oid → `-<short oid>`; already at this oid → reused (the deterministic case).
    let name = plan.stem;
    for (const candidate of [plan.stem, `${plan.stem}-${snap.slice(0, 12)}`]) {
      name = candidate;
      const have = headOf(ctx.cwd, `refs/tags/${candidate}`);
      if (!have.ok) {
        // Lightweight and unsigned whatever the user's config says: `tag.gpgSign=true` would make a signed annotated tag.
        const t = git(['-c', 'tag.gpgSign=false', 'tag', candidate, snap], ctx.cwd);
        if (!t.ok) return { status: 'failed', reason: `git tag ${candidate}: ${t.reason}` };
        break;
      }
      if (have.oid === snap) break;
      if (candidate !== plan.stem) return { status: 'failed', reason: `tag ${candidate} already exists at another commit` };
    }
    // The tag must name the snapshot COMMIT (ancestry included), and that commit the snapshot tree.
    if (!tagIsSnapshot(git, ctx.cwd, name, snap, tree)) return { status: 'failed', reason: `tag ${name} does not resolve to the snapshot commit and tree`, tag: name };
    // 3. Revalidate under the registry lock (no claim can register this worktree meanwhile), cheap checks first.
    const tx = transact(ctx.dir, (t) => {
      // An incomplete registry may hide the very claim this check exists to see: fail closed, as planning does.
      if (!t.complete) return { abort: 'the session registry is unreadable, so "no live claim" cannot be re-proved' };
      const claim = liveClaimOn(ctx.dir, wt, plan.capture.branch, t.sessions);
      if (claim) return { abort: `a live claim now covers it (${claim})` };
      const now = capture(git, wt);
      if (now.errors.length) return { abort: now.errors[0] };
      if (now.head !== cap.head || now.branch !== cap.branch) return { abort: `HEAD or branch moved (${cap.head.slice(0, 12)} ${cap.branch ?? 'detached'} → ${String(now.head).slice(0, 12)} ${now.branch ?? 'detached'})` };
      if (now.status !== cap.status) return { abort: 'the status listing changed (a path was added, removed, staged or unstaged)' };
      if (now.ignored !== cap.ignored) return { abort: 'the ignored-file listing changed (a new ignored path was never shown to you)' };
      const gate = gateContent(wt, plan.set);
      if (gate.sensitive.length || gate.unmeasured.length || gate.overCap) return { abort: 'the sensitive-path or size gate no longer passes' };
      // Only now hash: the real index first (it seeds the working-tree snapshot), then the working tree.
      const idx = git(['write-tree'], wt);
      if (!idx.ok || idx.stdout.trim() !== indexTree) return { abort: 'the index changed since the snapshot (something was staged)' };
      const again = workingTreeOid(git, wt, tmpDir, 'revalidate', indexTree, plan.set);
      if (!again.ok) return { abort: again.reason };
      if (again.oid !== tree) return { abort: 'file contents changed since the snapshot (working tree)' };
      if (!tagIsSnapshot(git, ctx.cwd, name, snap, tree)) return { abort: `tag ${name} no longer resolves to the verified snapshot commit` };
      // A sibling may have pointed its hooks into this worktree since the plan: re-read every worktree's, fail closed.
      const wtsNow = list(ctx.cwd);
      if (!wtsNow.queried) return { abort: `the worktree list could not be re-read (${wtsNow.reason}), so no hooks dependency can be ruled out` };
      const hooks = hooksPathRefusals(hooksPathDependents(wt, wtsNow.worktrees, { git }), wt);
      if (hooks.length) return { abort: hooks.join('; ') };
      const rm = git(['worktree', 'remove', '--force', wt], ctx.cwd, { timeoutMs: 120_000 });
      return rm.ok ? { removed: true } : { removeFailed: rm.reason };
    });
    if (!tx.ok) return { status: 'aborted', tag: name, oid: snap, reason: 'could not acquire fleet/.lock (contention) — the worktree is kept' };
    if (tx.value.abort) return { status: 'aborted', tag: name, oid: snap, reason: `changed since the snapshot: ${tx.value.abort} — the tag and the worktree are kept` };
    if (tx.value.removeFailed) return { status: 'failed', tag: name, oid: snap, reason: `git worktree remove failed: ${tx.value.removeFailed} (the tag is kept)`, ...(fs.existsSync(wt) ? { leftover: wt } : {}) };
    if (fs.existsSync(wt)) return { status: 'failed', tag: name, oid: snap, leftover: wt, reason: `the directory survived the removal (a file lock?): ${wt} — the tag is kept` };
    return { status: 'archived', tag: name, oid: snap, tree };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function renderPlan(plan, spec, cmd) {
  const t = plan.target;
  const L = [`fleet archive — DRY RUN (nothing written): ${t.worktree}${t.branch ? ` · branch ${t.branch}` : ' · detached'}`];
  if (plan.refusals.length) {
    L.push('  REFUSED — it cannot be preserved as it stands:', ...plan.refusals.map((r) => `    - ${r}`));
  } else {
    L.push(`  preserve: ${plan.set.length} path(s), ${Math.max(0, Math.round(plan.bytes / 1024))} KB${plan.set.length ? '' : ' (nothing uncommitted: the tag points at HEAD itself)'}`);
    for (const p of plan.set.slice(0, 20)) L.push(`    ${p}`);
    if (plan.set.length > 20) L.push(`    +${plan.set.length - 20} more`);
    if (plan.ignored.length) L.push(`  discard (gitignored, --discard-ignored): ${plan.ignored.length} path(s)`, ...plan.ignored.slice(0, 20).map((p) => `    ${p}`));
    L.push(`  tag: ${plan.stem} (lightweight, LOCAL ONLY — fleet never pushes it; a -<oid> suffix if the name is taken)`);
    L.push(`  then: git worktree remove --force ${t.worktree} (the branch is kept)`);
    L.push(`  run: ${renderCommand([...String(cmd).split(' '), 'archive', spec, '--apply', ...(plan.ignored.length ? ['--discard-ignored'] : []), ...(plan.fresh ? ['--include-fresh'] : [])])}`);
  }
  L.push('', SESSION_LIST_CHECK);
  return L.join('\n');
}

/** `fleet archive` CLI entry. */
export function cmdArchive(ctx, flags, positionals, { git = runGit } = {}) {
  const spec = positionals[0];
  if (!spec) throw new ArgvError('fleet archive: name a worktree path, branch or session id');
  const apply = flags['--apply'] === true;
  const target = resolveArchiveTarget(ctx, spec);
  if (!target) return refused(`no session, branch or worktree matches ${JSON.stringify(spec)}`);
  if (target.inventoryError) return refused(target.inventoryError);
  if (!target.worktree) {
    // After a successful removal the target is a branch with no worktree: list what exists, never claim which.
    const listed = target.branch ? existingArchiveTags(git, ctx.cwd, target.branch) : { ok: true, tags: [] };
    if (!listed.ok) return failed(`no worktree for ${JSON.stringify(spec)}, and its archive tags could not be listed (${listed.reason})`);
    const { tags } = listed;
    if (!tags.length) return refused(`no worktree to archive for ${JSON.stringify(spec)}`);
    return ok({ archive: { status: 'already-archived', tags }, text: [`already archived — ${tags.length} tag(s):`, ...tags.map((t) => `  ${t.name} @ ${t.oid.slice(0, 12)} · ${t.date}`)].join('\n') });
  }
  const plan = planArchive(ctx, target, { git, discardIgnored: flags['--discard-ignored'] === true, includeFresh: flags['--include-fresh'] === true });
  const text = renderPlan(plan, spec, ctx.cmd ?? 'fleet');
  if (!apply) return plan.refusals.length ? { ...refused(plan.refusals[0]), archive: { plan }, text } : ok({ archive: { plan }, text });
  if (plan.refusals.length) return { ...refused(plan.refusals[0]), archive: { plan }, text };
  const r = applyArchive(ctx, plan, { git });
  const lines = r.status === 'archived'
    ? [`archived: ${plan.target.worktree} → tag ${r.tag} @ ${r.oid.slice(0, 12)} (tree verified; local only — one disk away from lost until someone publishes it)`, `removed: ${plan.target.worktree}${plan.target.branch ? ` (branch ${plan.target.branch} kept)` : ''}`,
      'coordination is cooperative: an edit in the milliseconds between the last check and the delete is not caught']
    : [`${r.status.toUpperCase()}: ${r.reason}`, ...(r.tag ? [`  tag ${r.tag}${r.oid ? ` @ ${r.oid.slice(0, 12)}` : ''} is kept`] : []), ...(r.leftover ? [`  leftover: ${r.leftover}`] : [])];
  const out = { archive: { plan, result: r }, text: lines.join('\n') };
  if (r.status === 'archived') return ok(out);
  if (r.status === 'aborted') return { ...refused(r.reason), ...out };
  return { ...failed(r.reason), ...out };
}
