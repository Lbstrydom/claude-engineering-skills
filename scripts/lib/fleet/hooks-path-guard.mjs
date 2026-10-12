/**
 * @fileoverview Would removing worktree W silently disarm another worktree's git hooks?
 *
 * `core.hooksPath` may name a directory inside a linked worktree (a session pointed its siblings at the hooks it
 * was editing). Remove that worktree and git runs NO hook for them: a missing hooksPath directory is not an error,
 * so a pre-push gate stops without a word. That is how a PR was pushed ungated on 2026-10-12, caught only from an
 * empty hook log. `fleet archive` and `fleet prune --apply` ask this module before removing anything.
 *
 * For every OTHER live, non-bare worktree it reads the EFFECTIVE value (`git config --get`, run in that worktree:
 * its `config.worktree` first, else the inherited repo-level, global or system value — exactly what git consults
 * when it runs a hook there), resolves a relative value against that worktree's top level (where git runs hooks),
 * realpaths it and asks whether it lies inside W or is W. A value git cannot read is UNVERIFIED and refuses: the
 * one answer that must never leave here as "no dependents" is "could not tell". A worktree whose directory is gone
 * is skipped — no hook can run in a working tree that does not exist.
 *
 * @module scripts/lib/fleet/hooks-path-guard
 */
import fs from 'node:fs';
import path from 'node:path';
import { samePath } from '../harness-paths.mjs';
import { runGit } from './git-facts.mjs';
import { renderCommand } from './shell-quote.mjs';

/**
 * realpath of `p`, or — when `p` does not exist — of its deepest existing ancestor with the rest re-joined, so a
 * dangling hooksPath under a symlinked or junctioned parent still compares by where it really points.
 * @returns {{ok: true, path: string} | {ok: false, reason: string}}
 */
export function realpathLenient(p, { realpath = fs.realpathSync.native } = {}) {
  const rest = [];
  let cur = path.resolve(p);
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

/** Is `p` the directory `dir` or inside it? Both already realpathed. `path.relative` folds case on win32. */
export function isWithin(p, dir) {
  if (samePath(p, dir)) return true;
  const rel = path.relative(dir, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The remedy for a dependency, by the scope that set the value: re-point it at the main checkout's tracked hooks. */
export function remedyFor({ worktree, scope }, mainCheckout) {
  const target = path.join(mainCheckout ?? '<main checkout>', '.githooks');
  if (scope === 'worktree') return renderCommand(['git', '-C', worktree, 'config', '--worktree', 'core.hooksPath', target]);
  if (scope === 'local') return renderCommand(['git', '-C', mainCheckout ?? worktree, 'config', '--local', 'core.hooksPath', target]);
  if (scope === 'global' || scope === 'system') return renderCommand(['git', 'config', `--${scope}`, 'core.hooksPath', target]);
  return `re-point core.hooksPath (set at ${scope ?? 'an unknown'} scope) for ${worktree} at ${target}`;
}

/**
 * Which other worktrees' hooks live inside `target`?
 * @param {string} target the worktree about to be removed
 * @param {Array<{path: string, bare?: boolean, missing?: boolean}>} worktrees a `git worktree list` (main first)
 * @returns {{ok: boolean, dependents: Array<{worktree: string, scope: string|null, value: string, resolved: string, remedy: string}>, unreadable: Array<{worktree: string, reason: string}>}}
 *   `ok` is true only when every other worktree was read and none depends on `target`.
 */
export function hooksPathDependents(target, worktrees, { git = runGit, realpath = fs.realpathSync.native } = {}) {
  const dependents = []; const unreadable = [];
  const done = () => ({ ok: !dependents.length && !unreadable.length, dependents, unreadable });
  let targetReal;
  try { targetReal = realpath(target); } catch (e) {
    unreadable.push({ worktree: target, reason: `the worktree being removed cannot be realpathed (${e?.code ?? e?.message})` });
    return done();
  }
  const mainCheckout = worktrees.find((w) => !w.bare)?.path ?? null;
  for (const w of worktrees) {
    if (w.bare || w.missing || samePath(w.path, target)) continue;
    // `-z --show-scope`: "<scope>\0<value>\0". `--type=path` expands `~/` as git does when it reads the value.
    const r = git(['config', '--show-scope', '-z', '--type=path', '--get', 'core.hooksPath'], w.path);
    if (!r.ok && r.status === 1) continue; // unset everywhere: hooks are `<common dir>/hooks`, never inside a linked worktree
    if (!r.ok) { unreadable.push({ worktree: w.path, reason: `core.hooksPath could not be read (${r.reason})` }); continue; }
    const [scope, value] = String(r.stdout).split('\0');
    if (value === undefined) { unreadable.push({ worktree: w.path, reason: `unparseable git config output ${JSON.stringify(r.stdout)}` }); continue; }
    const resolved = realpathLenient(path.resolve(w.path, value), { realpath });
    if (!resolved.ok) { unreadable.push({ worktree: w.path, reason: `core.hooksPath ${JSON.stringify(value)} cannot be resolved (${resolved.reason})` }); continue; }
    if (isWithin(resolved.path, targetReal)) {
      const dep = { worktree: w.path, scope: scope || null, value, resolved: resolved.path };
      dependents.push({ ...dep, remedy: remedyFor(dep, mainCheckout) });
    }
  }
  return done();
}

/** The refusal lines for a verdict: one per dependent worktree and one per unread one; empty when `ok`. */
export function hooksPathRefusals(verdict, target) {
  const remedies = [...new Set(verdict.dependents.map((d) => d.remedy))];
  return [
    ...verdict.dependents.map((d) => `${d.worktree} runs its git hooks from inside ${target} (core.hooksPath ${JSON.stringify(d.value)}, ${d.scope ?? 'unknown'} scope): removing it would silently disable that worktree's pre-push gate`),
    ...(remedies.length ? [`re-point first: ${remedies.join('  ·  ')}`] : []),
    ...verdict.unreadable.map((u) => `cannot rule out a hooks dependency on ${target}: ${u.worktree}: ${u.reason}`),
  ];
}
