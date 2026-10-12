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
 * A win32 link target without its `\\?\` namespace prefix: `\\?\UNC\srv\share\x` is `\\srv\share\x`, `\\?\C:\x` is
 * `C:\x`. win32 only — on POSIX a backslash is an ordinary filename character.
 */
export function unNamespace(target) {
  if (/^\\\\\?\\UNC\\/i.test(target)) return `\\\\${target.slice(8)}`;
  return target.replace(/^\\\\\?\\/, '');
}

/**
 * Every directory entry the filesystem passes through to reach absolute path `p`, in order, symlink and junction
 * entries and their targets included; past the first missing entry the rest is joined lexically (there is no disk
 * left to consult). POSIX resolves `..` physically, after the symlink before it; the Win32 API collapses `..`
 * lexically before it touches the disk, so on win32 so does this.
 * @returns {{entries: string[], resolved: string}} the entries walked, and — SEPARATELY, because a trailing `..`
 *   means the last entry walked is not where the path ends — the location it resolves to. Throws on any
 *   lstat/readlink failure other than absence, and on a symlink loop.
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
        return { entries, resolved: t };
      }
      if (!st.isSymbolicLink()) { cur = entry; continue; }
      if (++hops > MAX_SYMLINK_HOPS) throw Object.assign(new Error(`more than ${MAX_SYMLINK_HOPS} symlinks resolving ${p}`), { code: 'ELOOP' });
      const target = platform === 'win32' ? unNamespace(String(readlink(entry))) : String(readlink(entry));
      const rest = parts.slice(i + 1).join(P.sep);
      const base = P.isAbsolute(target) ? target : `${cur}${cur.endsWith(P.sep) ? '' : P.sep}${target}`;
      next = rest ? `${base}${P.sep}${rest}` : base;
      break;
    }
    if (next === null) return { entries, resolved: cur };
    pending = platform === 'win32' ? P.resolve(next) : next;
  }
}

/**
 * The canonical spelling of a walked entry (case, 8.3 short names, symlinked parents). An existing entry that is not
 * a link is realpathed whole — its own name may be a short-name alias; a link or an absent entry keeps its own name
 * under a canonical parent, since realpathing a link would follow it away from the entry being judged.
 * @returns {{ok: true, path: string} | {ok: false, reason: string}}
 */
export function canonicalEntry(e, { realpath = fs.realpathSync.native, lstat = fs.lstatSync } = {}) {
  let st = null;
  try { st = lstat(e); } catch (err) { if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') return { ok: false, reason: `lstat ${e}: ${err?.code ?? err?.message}` }; }
  if (st && !st.isSymbolicLink()) {
    try { return { ok: true, path: realpath(e) }; } catch (err) { return { ok: false, reason: `realpath ${e}: ${err?.code ?? err?.message}` }; }
  }
  const parent = realpathLenient(path.dirname(e), { realpath });
  return parent.ok ? { ok: true, path: path.join(parent.path, path.basename(e)) } : parent;
}

/** Is `p` the directory `dir` or inside it? Compared by path COMPONENT (`A/..hooks` is inside A); case folds on win32. */
export function isWithin(p, dir) {
  if (samePath(p, dir)) return true;
  const rel = path.relative(dir, p);
  return rel !== '' && !path.isAbsolute(rel) && rel.split(/[\\/]/)[0] !== '..';
}

/**
 * Where a worktree's hooks are, as git itself answers, with the scope that set it and every entry the path walks.
 * @returns {{ok: true, scope: string, value: string, entries: string[], resolved: string} | {ok: false, reason: string}}
 */
export function hooksLocation(worktree, { git = runGit, lstat, readlink, readdir = fs.readdirSync } = {}) {
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
  try {
    const walked = traversedEntries(abs, { lstat, readlink });
    // One level down: a hook in that directory (`pre-push`) may itself be a link into another worktree. Absent
    // directory → no hooks; any other read failure throws, and refuses.
    let names = [];
    try { names = readdir(walked.resolved, { withFileTypes: true }); } catch (e) { if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') throw e; }
    const hookLinks = names.filter((d) => d.isSymbolicLink()).flatMap((d) => traversedEntries(path.join(walked.resolved, d.name), { lstat, readlink }).entries);
    return { ok: true, scope: scope || 'unknown', value: value ?? raw, entries: [...walked.entries, ...hookLinks], resolved: walked.resolved };
  } catch (e) {
    return { ok: false, reason: `the hooks path ${JSON.stringify(raw)} cannot be walked (${e?.code ?? e?.message})` };
  }
}

/**
 * The remedy for a dependency, by the scope that set the value: re-point it at `target`, never rewrite shared config.
 * With no `target` (no existing hooks directory outside the removed worktree is known) no command is printed: a
 * guessed directory would make the dependency disappear while losing the hooks it was there to run.
 */
export function remedyFor({ worktree, scope }, mainCheckout, target) {
  if (!target) return `move or re-install the hooks into a directory outside the worktree being removed, then point core.hooksPath (${scope} scope) at it — the main checkout has no existing hooks directory outside it, so there is no known-good one to point at`;
  const main = mainCheckout ?? worktree;
  // A shell comment, so the line stays pasteable: what the command restores, and what it does NOT verify.
  const note = "# the hooks directory the main checkout itself uses (its configuration, not a check that its gates are installed)";
  if (scope === 'worktree') return `${renderCommand(['git', '-C', worktree, 'config', '--worktree', 'core.hooksPath', target])}  ${note}`;
  if (scope === 'local') return `${renderCommand(['git', '-C', main, 'config', '--local', 'core.hooksPath', target])}  ${note}`;
  // A global or system value is shared with other repositories: override it for THIS repository only.
  if (scope === 'global' || scope === 'system') return `${renderCommand(['git', '-C', main, 'config', '--local', 'core.hooksPath', target])}  ${note}; a repository-local override — review the ${scope} setting itself`;
  return `re-point the hooks directory of ${worktree} (${scope} scope) outside the worktree being removed`;
}

/**
 * Which other worktrees' hooks live inside `target`, or pass through it?
 * @param {string} target the worktree about to be removed
 * @param {Array<{path: string, bare?: boolean, missing?: boolean}>} worktrees a `git worktree list` (main first)
 * @returns {{ok: boolean, dependents: Array<{worktree: string, scope: string, value: string, via: string, remedy: string}>, unreadable: Array<{worktree: string, reason: string}>}}
 *   `ok` is true only when every other worktree was read and none depends on `target`.
 */
export function hooksPathDependents(target, worktrees, { git = runGit, realpath = fs.realpathSync.native, stat = fs.statSync, lstat, readlink, readdir } = {}) {
  const dependents = []; const unreadable = [];
  const done = () => ({ ok: !dependents.length && !unreadable.length, dependents, unreadable });
  let targetReal;
  try { targetReal = realpath(target); } catch (e) {
    unreadable.push({ worktree: target, reason: `the worktree being removed cannot be realpathed (${e?.code ?? e?.message})` });
    return done();
  }
  // The DEEPEST entry inside `target` (the link or directory that dies with it, not merely `target` itself), compared
  // by canonical spelling.
  const insideTarget = (entries) => {
    let hit = null;
    for (const e of entries) {
      const c = canonicalEntry(e, { realpath, ...(lstat ? { lstat } : {}) });
      if (!c.ok) throw Object.assign(new Error(c.reason), { code: 'EUNRESOLVED' });
      if (isWithin(c.path, targetReal)) hit = c.path;
    }
    return hit;
  };
  const located = [];
  for (const w of worktrees) {
    if (w.bare || w.missing || samePath(w.path, target)) continue;
    const loc = hooksLocation(w.path, { git, lstat, readlink, readdir });
    if (!loc.ok) { unreadable.push({ worktree: w.path, reason: loc.reason }); continue; }
    let via;
    try { via = insideTarget(loc.entries); } catch (e) { unreadable.push({ worktree: w.path, reason: `the hooks path cannot be resolved (${e.message})` }); continue; }
    located.push({ w, loc });
    if (via) dependents.push({ worktree: w.path, scope: loc.scope, value: loc.value, via });
  }
  // The re-point target: where the main checkout's own hooks resolve, when that is an existing DIRECTORY and does not
  // depend on `target`. Otherwise none — never a guessed directory.
  const mainCheckout = worktrees.find((x) => !x.bare)?.path ?? null;
  const mainLoc = located.find((x) => samePath(x.w.path, mainCheckout));
  let remedyTarget = null;
  if (mainLoc && !dependents.some((d) => samePath(d.worktree, mainCheckout))) {
    // Absent, a file, or unreadable: nothing to point at, so the remedy says what to do instead of naming a path.
    try { const real = realpath(mainLoc.loc.resolved); if (stat(real).isDirectory()) remedyTarget = real; } catch { remedyTarget = null; }
  }
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
