/**
 * @fileoverview Would removing worktree W silently disarm another worktree's git hooks?
 *
 * `core.hooksPath` may name a directory inside a linked worktree (a session pointed its siblings at the hooks it
 * was editing). Remove that worktree and git runs NO hook for them: a missing hooks directory is not an error, so a
 * pre-push gate stops without a word. That is how a PR was pushed ungated on 2026-10-12, caught only from an empty
 * hook log. `fleet archive` and `fleet prune --apply` ask this module before removing anything.
 *
 * For every OTHER live, non-bare worktree it asks git where that worktree's hooks are (`rev-parse --git-path hooks`,
 * run there: it honours `core.hooksPath` from `config.worktree` or the inherited repo-level, global or system value,
 * and is the default `<common dir>/hooks` when unset), then walks that path the way the filesystem does — one
 * component at a time, following each symlink or junction — and refuses when ANY entry it passes through lies
 * inside W or is W. The destination alone is not enough: `A/.githooks` linking to `/shared/hooks` dangles once A is
 * gone. Anything that cannot be read or walked is UNVERIFIED and refuses: "could not tell" must never leave here
 * as "no dependents". A worktree whose directory is gone is skipped — no hook runs in a working tree that does not
 * exist.
 *
 * @module scripts/lib/fleet/hooks-path-guard
 */
import fs from 'node:fs';
import path from 'node:path';
import { samePath } from '../harness-paths.mjs';
import { runGit } from './git-facts.mjs';
import { renderCommand } from './shell-quote.mjs';

const MAX_SYMLINK_HOPS = 40;

/**
 * realpath of `p`, or — when `p` does not exist — of its deepest existing ancestor with the rest re-joined: the
 * canonical spelling (case, 8.3 names, symlinked parents) of a location that may not exist yet.
 * @returns {{ok: true, path: string} | {ok: false, reason: string}}
 */
export function realpathLenient(p, { realpath = fs.realpathSync.native } = {}) {
  const rest = [];
  let cur = p;
  for (;;) {
    try { return { ok: true, path: path.join(realpath(cur), ...rest.reverse()) }; } catch (e) {
      if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') return { ok: false, reason: `realpath ${cur}: ${e?.code ?? e?.message}` };
    }
    const parent = path.dirname(cur);
    if (parent === cur) return { ok: false, reason: `no part of ${p} exists` };
    rest.push(path.basename(cur));
    cur = parent;
  }
}

/**
 * Every directory entry the filesystem passes through to reach absolute path `p`, in order, symlink and junction
 * entries and their targets included; past the first missing entry the rest is joined lexically (there is no disk
 * left to consult). POSIX resolves `..` physically, after the symlink before it; the Win32 API collapses `..`
 * lexically before it touches the disk, so on win32 so does this.
 * @returns {string[]} throws on any lstat/readlink failure other than absence, and on a symlink loop
 */
export function traversedEntries(p, { lstat = fs.lstatSync, readlink = fs.readlinkSync, platform = process.platform } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const entries = [];
  let hops = 0;
  let pending = platform === 'win32' ? P.resolve(p) : p;
  for (;;) {
    const { root } = P.parse(pending);
    const parts = pending.slice(root.length).split(platform === 'win32' ? /[\\/]+/ : /\/+/).filter(Boolean);
    let cur = root; let next = null;
    for (let i = 0; i < parts.length; i++) {
      const c = parts[i];
      if (c === '.') continue;
      if (c === '..') { cur = P.dirname(cur); continue; }
      const entry = P.join(cur, c);
      entries.push(entry);
      let st;
      try { st = lstat(entry); } catch (e) {
        if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') throw e;
        let t = entry;
        for (const r of parts.slice(i + 1)) { if (r === '.') continue; t = r === '..' ? P.dirname(t) : P.join(t, r); entries.push(t); }
        return entries;
      }
      if (!st.isSymbolicLink()) { cur = entry; continue; }
      if (++hops > MAX_SYMLINK_HOPS) throw Object.assign(new Error(`more than ${MAX_SYMLINK_HOPS} symlinks resolving ${p}`), { code: 'ELOOP' });
      const target = String(readlink(entry)).replace(/^\\\\\?\\/, ''); // a junction's target may carry the \\?\ prefix
      const rest = parts.slice(i + 1).join(P.sep);
      const base = P.isAbsolute(target) ? target : `${cur}${cur.endsWith(P.sep) ? '' : P.sep}${target}`;
      next = rest ? `${base}${P.sep}${rest}` : base;
      break;
    }
    if (next === null) return entries;
    pending = platform === 'win32' ? P.resolve(next) : next;
  }
}

/** Is `p` the directory `dir` or inside it? Compared by path COMPONENT (`A/..hooks` is inside A); case folds on win32. */
export function isWithin(p, dir) {
  if (samePath(p, dir)) return true;
  const rel = path.relative(dir, p);
  return rel !== '' && !path.isAbsolute(rel) && rel.split(/[\\/]/)[0] !== '..';
}

/**
 * Where a worktree's hooks are, as git itself answers, with the scope that set it and every entry the path walks.
 * @returns {{ok: true, scope: string, value: string, entries: string[]} | {ok: false, reason: string}}
 */
export function hooksLocation(worktree, { git = runGit, lstat, readlink } = {}) {
  // `-z --show-scope`: "<scope>\0<value>\0". Exit 1 is git's "unset at every scope": hooks are then the default.
  const cfg = git(['config', '--show-scope', '-z', '--type=path', '--get', 'core.hooksPath'], worktree);
  if (!cfg.ok && cfg.status !== 1) return { ok: false, reason: `core.hooksPath could not be read (${cfg.reason})` };
  const [scope, value] = cfg.ok ? String(cfg.stdout).split('\0') : ['default', null];
  if (cfg.ok && value === undefined) return { ok: false, reason: `unparseable git config output ${JSON.stringify(cfg.stdout)}` };
  // The path git uses for hooks: relative to the worktree's top level (this cwd), where git runs them.
  const loc = git(['rev-parse', '--git-path', 'hooks'], worktree);
  if (!loc.ok) return { ok: false, reason: `the hooks directory could not be resolved (${loc.reason})` };
  const raw = loc.stdout.replace(/\r?\n$/, '');
  if (!raw) return { ok: false, reason: 'git named no hooks directory' };
  const abs = path.isAbsolute(raw) ? raw : `${worktree}${path.sep}${raw}`;
  try { return { ok: true, scope: scope || 'unknown', value: value ?? raw, entries: traversedEntries(abs, { lstat, readlink }) }; } catch (e) {
    return { ok: false, reason: `the hooks path ${JSON.stringify(raw)} cannot be walked (${e?.code ?? e?.message})` };
  }
}

/** The remedy for a dependency, by the scope that set the value: re-point it at `target`, never rewrite shared config. */
export function remedyFor({ worktree, scope }, mainCheckout, target) {
  const main = mainCheckout ?? worktree;
  if (scope === 'worktree') return renderCommand(['git', '-C', worktree, 'config', '--worktree', 'core.hooksPath', target]);
  if (scope === 'local') return renderCommand(['git', '-C', main, 'config', '--local', 'core.hooksPath', target]);
  // A global or system value is shared with other repositories: override it for THIS repository only.
  if (scope === 'global' || scope === 'system') return `${renderCommand(['git', '-C', main, 'config', '--local', 'core.hooksPath', target])} (a repository-local override; review the ${scope} setting itself)`;
  return `re-point the hooks directory of ${worktree} (${scope} scope) outside the worktree being removed`;
}

/**
 * Which other worktrees' hooks live inside `target`, or pass through it?
 * @param {string} target the worktree about to be removed
 * @param {Array<{path: string, bare?: boolean, missing?: boolean}>} worktrees a `git worktree list` (main first)
 * @returns {{ok: boolean, dependents: Array<{worktree: string, scope: string, value: string, via: string, remedy: string}>, unreadable: Array<{worktree: string, reason: string}>}}
 *   `ok` is true only when every other worktree was read and none depends on `target`.
 */
export function hooksPathDependents(target, worktrees, { git = runGit, realpath = fs.realpathSync.native, lstat, readlink } = {}) {
  const dependents = []; const unreadable = [];
  const done = () => ({ ok: !dependents.length && !unreadable.length, dependents, unreadable });
  let targetReal;
  try { targetReal = realpath(target); } catch (e) {
    unreadable.push({ worktree: target, reason: `the worktree being removed cannot be realpathed (${e?.code ?? e?.message})` });
    return done();
  }
  // The DEEPEST entry inside `target` (the link or directory that dies with it, not merely `target` itself), compared
  // by canonical spelling: the entry's parent realpathed, its own name kept.
  const insideTarget = (entries) => {
    let hit = null;
    for (const e of entries) {
      const parent = realpathLenient(path.dirname(e), { realpath });
      if (!parent.ok) throw Object.assign(new Error(parent.reason), { code: 'EUNRESOLVED' });
      const canonical = path.join(parent.path, path.basename(e));
      if (isWithin(canonical, targetReal)) hit = canonical;
    }
    return hit;
  };
  const located = [];
  for (const w of worktrees) {
    if (w.bare || w.missing || samePath(w.path, target)) continue;
    const loc = hooksLocation(w.path, { git, lstat, readlink });
    if (!loc.ok) { unreadable.push({ worktree: w.path, reason: loc.reason }); continue; }
    let via;
    try { via = insideTarget(loc.entries); } catch (e) { unreadable.push({ worktree: w.path, reason: `the hooks path cannot be resolved (${e.message})` }); continue; }
    located.push({ w, loc });
    if (via) dependents.push({ worktree: w.path, scope: loc.scope, value: loc.value, via });
  }
  // The re-point target: the main checkout's own hooks directory when that is not itself inside `target`.
  const mainCheckout = worktrees.find((x) => !x.bare)?.path ?? null;
  const mainLoc = located.find((x) => samePath(x.w.path, mainCheckout));
  const mainSafe = mainLoc && !dependents.some((d) => samePath(d.worktree, mainCheckout));
  const fallback = path.join(mainCheckout ?? '<main checkout>', '.githooks');
  const remedyTarget = mainSafe ? (realpathLenient(mainLoc.loc.entries.at(-1), { realpath }).path ?? fallback) : fallback;
  for (const d of dependents) d.remedy = remedyFor(d, mainCheckout, remedyTarget);
  return done();
}

/** The refusal lines for a verdict: one per dependent worktree and one per unread one; empty when `ok`. */
export function hooksPathRefusals(verdict, target) {
  const remedies = [...new Set(verdict.dependents.map((d) => d.remedy))];
  return [
    ...verdict.dependents.map((d) => `${d.worktree} runs its git hooks from inside ${target} (hooks path ${JSON.stringify(d.value)}, ${d.scope} scope, via ${d.via}): removing it would silently disable that worktree's pre-push gate`),
    ...(remedies.length ? [`re-point first: ${remedies.join('  ·  ')}`] : []),
    ...verdict.unreadable.map((u) => `cannot rule out a hooks dependency on ${target}: ${u.worktree}: ${u.reason}`),
  ];
}
