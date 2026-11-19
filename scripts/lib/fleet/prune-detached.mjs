/**
 * @fileoverview `fleet prune` for worktrees that no branch names: detached-HEAD worktrees and registrations whose directory
 * is gone (docs/plans/fleet-hygiene.md §1.1, proposal f685). Branch pruning enumerates BRANCHES, so these were invisible: a CES
 * checkout carried 13 of 20 registered worktrees that no prune output ever mentioned.
 *
 * "Nothing lost" for a detached HEAD has no merged-tip evidence to lean on, so it means: the worktree is clean (every
 * `archiveReport` risk class counts, `unpushed` and ignored files included), and EVERY commit the registration alone can
 * still reach is held by a remote-tracking ref — the listed HEAD plus both ids of every retained HEAD-reflog entry — with no
 * per-worktree ref or interrupted operation in its admin dir. `git worktree remove` deletes that admin dir with the
 * worktree, so history only it holds would go with it.
 *
 * Never removed here, only listed: a registration whose directory is gone. `git worktree prune` is repository-wide, and no lock
 * fleet holds serialises other git processes, so a registration another process makes prunable between a check and the command
 * would lose its history unjudged. The command is printed for a person to run.
 *
 * @module scripts/lib/fleet/prune-detached
 */
import fs from 'node:fs';
import path from 'node:path';
import { samePath } from '../harness-paths.mjs';
import { CONSUMER_SNAPSHOT_PREFIX, SANDBOX_PREFIX } from '../prepush-sandbox-cleanup.mjs';
import { archiveReport } from './lifecycle.mjs';
import { hooksPathDependents, hooksPathRefusals } from './hooks-path-guard.mjs';
import { gitCommonDir, runGit } from './git-facts.mjs';
import { renderCommand } from './shell-quote.mjs';
import { readSessions, transact } from './registry.mjs';
import { lastActivity, provablyIdle } from './unregistered.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Directories whose own tool sweeps them (a killed run's husk goes at the next push): prune never races that owner. */
export const SELF_SWEEPING_PREFIXES = Object.freeze([SANDBOX_PREFIX, CONSUMER_SNAPSHOT_PREFIX]);
/** A reflog longer than this is kept as unverified rather than read in part. */
export const MAX_REFLOG_LINES = 1000;
/** Bytes read from a reflog or FETCH_HEAD, and distinct commit ids checked, before the registration is kept as unverified. */
export const MAX_EVIDENCE_BYTES = 1_000_000;
export const MAX_EVIDENCE_IDS = 2000;
const MAX_REF_ENTRIES = 5000;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const ZERO = /^0+$/;
/** Admin-dir entries that mean an operation is in progress or a ref exists that only this registration holds. */
const IN_PROGRESS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'];

const empty = () => ({ candidates: [], excluded: [], stale: [], unjudged: 0 });
export const emptyDetached = empty;

/** The admin dir `<common>/worktrees/<id>` whose `gitdir` file points at `<worktreePath>/.git` (works when the directory is gone). */
function adminDirOf(common, worktreePath) {
  const root = path.join(common, 'worktrees');
  let ids;
  try { ids = fs.readdirSync(root); } catch (e) { return { ok: false, reason: `cannot read ${root}: ${e.code ?? e.message}` }; }
  for (const id of ids) {
    let text;
    try { text = fs.readFileSync(path.join(root, id, 'gitdir'), 'utf8').trim(); } catch { continue; }
    if (samePath(path.dirname(text), worktreePath)) return { ok: true, dir: path.join(root, id) };
  }
  return { ok: false, reason: `no admin directory under ${root} points at ${worktreePath}` };
}

/** Any file under `dir` (per-worktree refs). @returns {{found: string|null, unverified: string|null}} */
function anyRefFile(dir) {
  let seen = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return e.code === 'ENOENT' ? null : `cannot read ${d}: ${e.code ?? e.message}`; }
    for (const e of entries) {
      if ((seen += 1) > MAX_REF_ENTRIES) return 'too many per-worktree ref entries to read';
      const p = path.join(d, e.name);
      if (e.isDirectory()) { const r = walk(p); if (r) return r; } else return { file: p };
    }
    return null;
  };
  const r = walk(dir);
  return typeof r === 'string' ? { found: null, unverified: r } : { found: r?.file ?? null, unverified: null };
}

/**
 * What removing this registration would destroy that only it holds. Same evidence for a present worktree and a stale one.
 * @param {{cwd: string}} ctx
 * @param {{path: string, head: string|null}} w a `listWorktrees` entry
 * @returns {{ok: true} | {ok: false, kept: string}} `kept` is the reason, unverified or not
 */
export function registrationHistory(ctx, w, { git = runGit } = {}) {
  const c = gitCommonDir(ctx.cwd);
  if (!c.ok) return { ok: false, kept: `the git common dir could not be read (${c.reason})` };
  // The reflog and per-worktree refs are read as files, which is how the files backend stores them. Another ref storage (reftable)
  // keeps them elsewhere, so "no file" would read as "nothing to lose": fail closed instead.
  const fmt = git(['config', '--get', 'extensions.refstorage'], ctx.cwd);
  // `git config --get` exits 1 for an UNSET key; any other failure means the format is unknown, which is not "files".
  if (!fmt.ok && fmt.status !== 1) return { ok: false, kept: `registration not verified: the ref storage format could not be read (${fmt.reason ?? 'git config failed'})` };
  if (fmt.ok && String(fmt.stdout).trim() && String(fmt.stdout).trim() !== 'files') return { ok: false, kept: `registration not verified: ref storage is ${String(fmt.stdout).trim()}, whose reflog and per-worktree refs are not inspected here` };
  const admin = adminDirOf(c.dir, w.path);
  if (!admin.ok) return { ok: false, kept: `registration not verified: ${admin.reason}` };
  const refs = anyRefFile(path.join(admin.dir, 'refs'));
  if (refs.unverified) return { ok: false, kept: `registration not verified: ${refs.unverified}` };
  if (refs.found) return { ok: false, kept: `a per-worktree ref only this registration holds (${path.relative(admin.dir, refs.found).replaceAll('\\', '/')})` };
  const busy = IN_PROGRESS.find((n) => fs.existsSync(path.join(admin.dir, n)));
  if (busy) return { ok: false, kept: `its admin directory holds ${busy} (an operation in progress or a ref only this registration has)` };
  const ids = new Set();
  if (!w.head || !OID.test(w.head)) return { ok: false, kept: `registration not verified: its HEAD is ${w.head ?? 'not listed'}` };
  ids.add(w.head);
  let log = '';
  const tooBig = (f) => { try { return fs.statSync(f).size > MAX_EVIDENCE_BYTES; } catch { return false; } };
  if (tooBig(path.join(admin.dir, 'logs', 'HEAD'))) return { ok: false, kept: `registration not verified: its HEAD reflog is larger than ${MAX_EVIDENCE_BYTES} bytes` };
  try { log = fs.readFileSync(path.join(admin.dir, 'logs', 'HEAD'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') return { ok: false, kept: `registration not verified: cannot read its HEAD reflog (${e.code ?? e.message})` }; }
  const lines = log.split('\n').filter(Boolean);
  if (lines.length > MAX_REFLOG_LINES) return { ok: false, kept: `registration not verified: its HEAD reflog has ${lines.length} entries (more than ${MAX_REFLOG_LINES})` };
  for (const line of lines) {
    const [a, b] = line.split(' ');
    if (!OID.test(a ?? '') || !OID.test(b ?? '')) return { ok: false, kept: 'registration not verified: a malformed HEAD reflog line' };
    for (const id of [a, b]) if (!ZERO.test(id)) ids.add(id);
  }
  // ORIG_HEAD is the commit a reset/rebase moved HEAD away from: a commit id like any reflog id, not an operation in progress.
  try {
    const orig = fs.readFileSync(path.join(admin.dir, 'ORIG_HEAD'), 'utf8').trim();
    if (!OID.test(orig)) return { ok: false, kept: 'registration not verified: a malformed ORIG_HEAD' };
    ids.add(orig);
  } catch (e) { if (e.code !== 'ENOENT') return { ok: false, kept: `registration not verified: cannot read ORIG_HEAD (${e.code ?? e.message})` }; }
  // FETCH_HEAD is per-worktree and lists fetched commits (first column) that no ref need hold.
  if (tooBig(path.join(admin.dir, 'FETCH_HEAD'))) return { ok: false, kept: `registration not verified: its FETCH_HEAD is larger than ${MAX_EVIDENCE_BYTES} bytes` };
  try {
    for (const line of fs.readFileSync(path.join(admin.dir, 'FETCH_HEAD'), 'utf8').split('\n').filter(Boolean)) {
      const id = line.split(/\s/)[0];
      if (!OID.test(id)) return { ok: false, kept: 'registration not verified: a malformed FETCH_HEAD line' };
      ids.add(id);
    }
  } catch (e) { if (e.code !== 'ENOENT') return { ok: false, kept: `registration not verified: cannot read FETCH_HEAD (${e.code ?? e.message})` }; }
  if (ids.size > MAX_EVIDENCE_IDS) return { ok: false, kept: `registration not verified: ${ids.size} distinct commit ids (more than ${MAX_EVIDENCE_IDS})` };
  // Every id must BE a commit (rev-list alone would accept a blob or tree): one batch call, one line per id.
  const types = git(['cat-file', '--batch-check=%(objecttype)'], ctx.cwd, { input: `${[...ids].join('\n')}\n` });
  const kinds = types.ok ? String(types.stdout).split('\n').filter(Boolean) : [];
  if (!types.ok || kinds.length !== ids.size || kinds.some((k) => k !== 'commit')) return { ok: false, kept: 'registration not verified: an id in HEAD, its reflog, ORIG_HEAD or FETCH_HEAD is missing or is not a commit' };
  // Reachability for the whole set in ONE call; a failure is "unverified" (kept), never "nothing there".
  const rl = git(['rev-list', '--max-count=20', ...ids, '--not', '--remotes'], ctx.cwd);
  if (!rl.ok) return { ok: false, kept: `registration not verified: an id in HEAD, its reflog, ORIG_HEAD or FETCH_HEAD is not a commit here, or git failed (${rl.reason})` };
  const n = String(rl.stdout).split('\n').filter(Boolean).length;
  return n ? { ok: false, kept: `${n >= 20 ? '≥20' : n} commit(s) reachable only through this registration (HEAD or its reflog), no remote-tracking ref holds them` } : { ok: true };
}

const selfSweeper = (p) => SELF_SWEEPING_PREFIXES.find((pre) => path.basename(p).startsWith(pre)) ?? null;
const risksOf = (r) => Object.entries(r.risks).filter(([, v]) => v.length);

/**
 * Judge every detached worktree and every registration whose directory is gone.
 * @param {object} ctx
 * @param {{worktrees: object[], mainCheckout: string|null, here: {ok: boolean, dir?: string}, staleMs: number, nowMs: number,
 *   past: () => boolean, deadlineAt: number|null, clock: () => number, git?: typeof runGit, report?: typeof archiveReport}} a
 */
export function planDetached(ctx, { worktrees, mainCheckout, here, staleMs, nowMs, past, deadlineAt, clock, git = runGit, report = archiveReport }) {
  const out = empty();
  // A worktree a fleet session registered is its owner's, whatever git says; an unreadable registry cannot rule that out.
  const reg = readSessions(ctx.dir);
  const ownerOf = (wp) => reg.sessions.find((x) => x.worktree && samePath(x.worktree, wp));
  for (const w of worktrees) {
    if (w.bare) continue;
    const gone = w.prunable || w.missing;
    // A present worktree on a branch is the branch path's; a registration whose directory is gone is judged here whatever it had checked out.
    if (!gone && (w.branch || !w.detached)) continue;
    if (samePath(w.path, mainCheckout) || (here.ok && samePath(w.path, here.dir))) continue;
    const keep = (reason) => out.excluded.push({ path: w.path, head: w.head, gone, reason });
    if (w.locked) { keep('locked (in use)'); continue; }
    if (gone) {
      if (past()) { out.unjudged += 1; continue; }
      const h = registrationHistory(ctx, w, { git });
      if (h.ok) out.stale.push({ path: w.path, head: w.head, reason: w.prunableReason ?? 'directory gone' }); else keep(h.kept);
      continue;
    }
    if (!reg.complete) { keep('the session registry is unreadable, so "no registered session" cannot be shown'); continue; }
    const session = ownerOf(w.path);
    if (session) { keep(`registered to session ${session.id}`); continue; }
    const owner = selfSweeper(w.path);
    if (owner) { keep(`a pre-push sandbox (${owner}…): the next push's sweep removes it, and prune never races its owner`); continue; }
    if (past()) { out.unjudged += 1; continue; }
    const r = report(ctx, { branch: null, worktree: w.path, ...(deadlineAt === null ? {} : { deadlineAt, clock }) });
    if (r.unverified.length && past()) { out.unjudged += 1; continue; }
    const risks = risksOf(r);
    if (risks.length || r.unverified.length) { keep(risks.length ? `worktree holds ${risks.map(([k, v]) => `${v.length} ${k}`).join(', ')}` : `cannot verify the worktree: ${r.unverified[0]}`); continue; }
    const hooks = hooksPathRefusals(hooksPathDependents(w.path, worktrees, { git }), w.path);
    if (hooks.length) { keep(hooks.join('; ')); continue; }
    const h = registrationHistory(ctx, w, { git });
    if (!h.ok) { keep(h.kept); continue; }
    const tip = git(['show', '-s', '--format=%ct', w.head], ctx.cwd);
    const tipTime = tip.ok && Number.isFinite(Number(String(tip.stdout).trim())) ? Number(String(tip.stdout).trim()) * 1000 : null;
    const act = lastActivity({ worktree: w.path, tipTime });
    const argv = ['git', 'worktree', 'remove', w.path];
    out.candidates.push({
      path: w.path, head: w.head, fresh: !provablyIdle(act, nowMs, staleMs), activityAt: act.at ?? null,
      idleDays: act.at === null || act.at > nowMs ? null : Math.floor((nowMs - act.at) / DAY_MS),
      steps: [{ kind: 'worktree', argv }], commands: [renderCommand(argv)],
    });
  }
  return out;
}

/**
 * Remove the planned detached worktrees, each under `fleet/.lock`, re-checking AT APPLY everything the plan judged. Never forced,
 * never `git worktree prune`. Freshness: a fresh candidate is skipped unless `includeFresh` AND it was fresh in the plan the user
 * saw AND its activity has not advanced since — the flag accepts what was shown, never what happened after.
 * @returns {{results: object[], counts: {removed: number, skipped: number, failed: number}}}
 */
export function applyDetached(ctx, plan, { includeFresh = false, git = runGit, list, report = archiveReport, staleMs, clock = Date.now } = {}) {
  const results = [];
  for (const c of plan?.candidates ?? []) {
    const res = { path: c.path, status: 'removed', reason: null, done: [] };
    const tx = transact(ctx.dir, (t) => {
      if (!t.complete) return { skip: 'the session registry is unreadable, so "no registered session" cannot be re-proved' };
      if (t.sessions.some((s) => s.worktree && samePath(s.worktree, c.path))) return { skip: 'a session has registered this worktree since it was judged' };
      const wts = list(ctx.cwd);
      if (!wts.queried) return { skip: `the worktree list could not be re-read (${wts.reason})` };
      const w = wts.worktrees.find((x) => samePath(x.path, c.path));
      if (!w || w.bare || !w.detached || w.branch) return { skip: 'it is no longer a registered detached worktree' };
      if (w.head !== c.head) return { skip: `its HEAD moved since it was judged (${String(c.head).slice(0, 12)} → ${String(w.head).slice(0, 12)})` };
      if (w.locked) return { skip: 'it is locked now (in use)' };
      if (w.prunable || w.missing) return { skip: 'its directory is gone now' };
      const r = report(ctx, { branch: null, worktree: c.path });
      const risks = risksOf(r);
      if (risks.length || r.unverified.length) return { skip: `its worktree changed since it was judged (${risks.length ? risks.map(([k, v]) => `${v.length} ${k}`).join(', ') : r.unverified[0]})` };
      const h = registrationHistory(ctx, w, { git });
      if (!h.ok) return { skip: `its registration changed since it was judged: ${h.kept}` };
      const hooks = hooksPathRefusals(hooksPathDependents(c.path, wts.worktrees, { git }), c.path);
      if (hooks.length) return { skip: hooks.join('; ') };
      const tip = git(['show', '-s', '--format=%ct', w.head], ctx.cwd);
      const act = lastActivity({ worktree: c.path, tipTime: tip.ok && Number.isFinite(Number(String(tip.stdout).trim())) ? Number(String(tip.stdout).trim()) * 1000 : null });
      const freshNow = !provablyIdle(act, clock(), staleMs);
      if (freshNow) {
        const shown = includeFresh && c.fresh && (act.at ?? null) === c.activityAt;
        if (!shown) return { skip: c.fresh && !includeFresh ? `fresh (last activity ${c.idleDays === null ? 'unknown' : `${c.idleDays}d ago`}): confirm in the session list, then --include-fresh` : 'it has had activity since it was judged (--include-fresh covers only what the plan showed)' };
      }
      for (const st of c.steps) {
        const x = git(st.argv.slice(1), ctx.cwd);
        if (!x.ok) return { failed: `${renderCommand(st.argv)}: ${x.reason ?? 'failed'}` };
        res.done.push(renderCommand(st.argv));
      }
      return {};
    });
    if (!tx.ok) Object.assign(res, { status: 'skipped', reason: 'could not acquire fleet/.lock (contention) — nothing was changed for this worktree' });
    else if (tx.value.skip) Object.assign(res, { status: 'skipped', reason: tx.value.skip });
    else if (tx.value.failed) Object.assign(res, { status: 'failed', reason: tx.value.failed });
    results.push(res);
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  return { results, counts: { removed: count('removed'), skipped: count('skipped'), failed: count('failed') } };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The detached and stale-registration sections of the read-only report. Empty when there is nothing to say. */
export function renderDetached(d) {
  if (!d || (!d.candidates.length && !d.excluded.length && !d.stale.length && !d.unjudged)) return [];
  const lines = [];
  if (d.candidates.length) {
    lines.push('', `detached worktrees (${d.candidates.length}) — HEAD, reflog and files all held elsewhere:`);
    for (const c of d.candidates) {
      lines.push(`  ${c.path} · HEAD ${String(c.head).slice(0, 12)}${c.fresh ? ` · FRESH (activity ${c.idleDays === null ? 'unknown' : `${c.idleDays}d ago`}; --apply skips it without --include-fresh)` : ''}`);
      for (const command of c.commands) lines.push(`      ${command}`);
    }
  }
  const kept = d.excluded.filter((e) => !e.gone);
  if (kept.length) lines.push('', `detached worktrees kept (${kept.length}) — look before removing:`, ...kept.map((e) => `  ${e.path}: ${e.reason}`));
  if (d.unjudged) lines.push(`  not judged: ${plural(d.unjudged, 'detached worktree')} reached after the budget was spent`);
  const goneKept = d.excluded.filter((e) => e.gone);
  if (d.stale.length || goneKept.length) {
    lines.push('', `stale registrations (${d.stale.length}) — directory gone; listed only: \`--apply\` never runs \`git worktree prune\`, which is repository-wide and removes EVERY prunable entry git lists, these and any other:`);
    for (const s of d.stale) lines.push(`  ${s.path} · HEAD ${String(s.head).slice(0, 12)} — its history is held by a remote-tracking ref`);
    for (const e of goneKept) lines.push(`  kept: ${e.path}: ${e.reason}`);
    // Offered only when EVERY registration was judged: one kept or still unjudged would be deleted with the rest.
    if (d.stale.length && !goneKept.length && !d.unjudged) lines.push('      git worktree prune');
    else if (d.unjudged && !goneKept.length) lines.push(`      git worktree prune is NOT offered: ${plural(d.unjudged, 'registration')} (or worktree) not judged within the budget could be deleted with the rest. Re-run \`fleet prune\` unbudgeted.`);
    else if (goneKept.length) lines.push(`      git worktree prune is NOT offered: it would also delete the ${plural(goneKept.length, 'registration')} kept above, whose history only they hold. Rescue those commits first (e.g. \`git branch rescue-<n> <sha>\`), then re-run \`fleet prune\`.`);
  }
  return lines;
}

/** The apply section: what each detached worktree did. */
export function renderDetachedApplied(a) {
  if (!a?.results.length) return [];
  return a.results.map((r) => `  ${r.path}: ${r.status === 'removed' ? 'removed (worktree)' : r.status === 'skipped' ? `skipped — ${r.reason}` : `FAILED — ${r.reason}`}`);
}
