/**
 * @fileoverview Which registered sessions a branch is stacked on, read from git at claim time (work-consumer report
 * 2026-11-27: claims on branches stacked over an unlanded parent recorded base `main` and were BLOCKED by that parent's own
 * claim). One fact, two consumers: the nearest ancestor is the claim's inferred stack base, and every ancestor is exempt
 * from blocking it (`decideClaim`'s `ancestors`).
 *
 * An ANCESTOR is a registered, non-terminal, branch-kind session whose local tip is reachable from this branch's head and
 * NOT from the repo base. Reachability from the base is the exclusion that matters: a session with no commits of its own
 * sits at the base's tip, which every branch contains, so without it two fresh siblings would exempt each other. A tip
 * EQUAL to the head counts (a fresh child with no commits yet is still stacked on its parent).
 *
 * Read before the lock, like every other claim fact: a session registered after the read is not an ancestor, so it is
 * judged as before (the safe side). Any git failure is `{queried:false}`, which callers read as "no ancestors" — today's
 * behaviour, never an exemption.
 *
 * @module scripts/lib/fleet/stack-ancestry
 */
import { headOf, runGit } from './git-facts.mjs';
import { isTerminalState } from './overlap.mjs';

/**
 * @param {string} cwd
 * @param {{branch: string|null, selfId: string, sessions: object[], baseBranch: string, baseRev: string}} args
 *   `baseRev` is the commit (or name) overlap is measured from — the same base, so "not landed" means one thing
 * @returns {{queried: true, ancestors: Array<{id: string, branch: string, oid: string}>, nearest: {id: string, branch: string, oid: string}|null, ambiguous: string[]|null}
 *   | {queried: false, reason: string, ancestors: [], nearest: null, ambiguous: null}}
 */
export function stackAncestry(cwd, { branch, selfId, sessions, baseBranch, baseRev }) {
  const none = (reason) => ({ queried: false, reason, ancestors: [], nearest: null, ambiguous: null });
  if (!branch) return none('no branch (a detached claim has no ancestry)');
  const byBranch = new Map();
  for (const s of sessions ?? []) {
    const b = s.source?.kind === 'branch' ? s.source.branch : null;
    if (!b || b === branch || b === baseBranch || s.id === selfId || isTerminalState(s.state)) continue;
    // Two records on one branch name: the branch is ambiguous as a parent, so it is not one.
    byBranch.set(b, byBranch.has(b) ? null : s);
  }
  if (!byBranch.size) return { queried: true, ancestors: [], nearest: null, ambiguous: null };
  const head = headOf(cwd, `refs/heads/${branch}`);
  if (!head.ok) return none(`${branch} could not be resolved`);
  const r = runGit(['for-each-ref', `--merged=${head.oid}`, `--no-merged=${baseRev}`, '--format=%(refname:short)%00%(objectname)', 'refs/heads'], cwd);
  if (!r.ok) return none(r.reason ?? 'for-each-ref failed');
  const ancestors = [];
  for (const line of r.stdout.split('\n')) {
    const [name, oid] = line.split('\0');
    const s = name ? byBranch.get(name) : undefined;
    if (s && oid) ancestors.push({ id: s.id, branch: name, oid });
  }
  if (!ancestors.length) return { queried: true, ancestors, nearest: null, ambiguous: null };
  const oids = [...new Set(ancestors.map((a) => a.oid))];
  let independent = oids;
  if (oids.length > 1) {
    const ind = runGit(['merge-base', '--independent', ...oids], cwd);
    if (!ind.ok) return { queried: true, ancestors, nearest: null, ambiguous: ancestors.map((a) => a.branch) };
    independent = ind.stdout.split('\n').map((x) => x.trim()).filter(Boolean);
  }
  return { queried: true, ancestors, ...nearestOf(ancestors, independent) };
}

/**
 * The nearest ancestor: the one session holding the single tip no other ancestor tip descends from. Two independent tips (a
 * branch that merged two parents) or two sessions on that one tip cannot be ordered, so none is picked.
 * @param {Array<{id: string, branch: string, oid: string}>} ancestors
 * @param {string[]} independentOids - `git merge-base --independent` over the ancestors' tips
 * @returns {{nearest: object|null, ambiguous: string[]|null}}
 */
export function nearestOf(ancestors, independentOids) {
  if (!ancestors.length) return { nearest: null, ambiguous: null };
  const tips = new Set(independentOids);
  const top = ancestors.filter((a) => tips.has(a.oid));
  if (tips.size === 1 && top.length === 1) return { nearest: top[0], ambiguous: null };
  return { nearest: null, ambiguous: (top.length ? top : ancestors).map((a) => a.branch).sort() };
}
