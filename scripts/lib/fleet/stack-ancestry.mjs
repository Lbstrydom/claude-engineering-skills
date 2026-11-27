/**
 * @fileoverview Which registered sessions a branch is stacked on, read from git at claim time (work-consumer report
 * 2026-11-27: claims on branches stacked over an unlanded parent recorded base `main` and were BLOCKED by that parent's own
 * claim). One fact, two consumers: the nearest ancestor is the claim's inferred stack base, and every ancestor is exempt
 * from blocking it (`decideClaim`'s `ancestors`).
 *
 * An ANCESTOR is a registered, non-terminal, branch-kind session whose local tip is reachable from this branch's head and
 * NOT from the repo base. Reachability from the base is the exclusion that matters: a session with no commits of its own
 * sits at the base's tip, which every branch contains, so without it two fresh siblings would exempt each other. A tip
 * EQUAL to the head counts (a fresh child with no commits yet is still stacked on its parent). Sessions sharing one tip are
 * told apart by the registry (`withoutCoTips`), and the record's own declared base stays an ancestor after its branch moves on.
 *
 * Read before the lock, like every other claim fact: a session registered after the read is not an ancestor, so it is
 * judged as before (the safe side); each fact carries the session's id, gen and branch so the locked read can re-check it is
 * still the same session. Any git failure is `{queried:false}`, which callers read as "no ancestors" — today's
 * behaviour, never an exemption.
 *
 * @module scripts/lib/fleet/stack-ancestry
 */
import { headOf, runGit } from './git-facts.mjs';
import { isTerminalState } from './overlap.mjs';

/**
 * @param {string} cwd
 * @param {{branch: string|null, selfId: string, sessions: object[], baseBranch: string, baseRev: string, declaredBase?: {name: string, anchor: string|null}|null,
 *   forkPointOf?: (session: object) => string|null, prefer?: string|null}} args
 *   `baseRev` is the commit (or name) overlap is measured from — the same base, so "not landed" means one thing;
 *   `declaredBase` is the claiming record's own `baseRef` (when it names a branch other than the repo base) and its anchor;
 *   `forkPointOf` reads a session's recorded fork point; `prefer` (the --base or declared base) breaks a tie on one tip
 * @returns {{queried: true, ancestors: Array<{id: string, gen: number, branch: string, baseRef: string|null, oid: string}>, nearest: {id: string, branch: string, oid: string}|null, ambiguous: string[]|null}
 *   | {queried: false, reason: string, ancestors: [], nearest: null, ambiguous: null}}
 */
export function stackAncestry(cwd, { branch, selfId, sessions, baseBranch, baseRev, declaredBase = null, forkPointOf = () => null, prefer = null }) {
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
  // The full refname, never `%(refname:short)`: a tag sharing a branch's name makes git print `heads/<name>`.
  const r = runGit(['for-each-ref', `--merged=${head.oid}`, `--no-merged=${baseRev}`, '--format=%(refname)%00%(objectname)', 'refs/heads'], cwd);
  if (!r.ok) return none(r.reason ?? 'for-each-ref failed');
  // `baseRef` rides along: a tie on one tip is broken by it, so the locked re-check compares it too.
  const fact = (s, name, oid) => ({ id: s.id, gen: s.gen, branch: name, baseRef: s.source?.baseRef ?? null, oid });
  const found = [];
  for (const line of r.stdout.split('\n')) {
    const [ref, oid] = line.split('\0');
    const name = ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
    const s = name ? byBranch.get(name) : undefined;
    if (s && oid) found.push(fact(s, name, oid));
  }
  // DECLARED bases stay ancestors after their branch moves on: a parent's newer commits are not history of this branch, but
  // the commit a session was stacked at still is. That commit is the ANCHOR (its RECORDED fork point; none recorded, no
  // anchor), never a merge-base, which a rebased or reset parent would still share with this branch. It must be history of
  // this branch AND the declared base's current tip, and not landed; the fact carries it (the commit a re-claim records).
  // Walked up the stack: this claim's own declared base, then each ancestor's (a grandparent that moved on stays one when
  // the parent's recorded fork point is still its history). Each branch is visited once, so a cycle ends.
  const isAnc = (x, y) => runGit(['merge-base', '--is-ancestor', x, y], cwd);
  const nextOf = (s) => ({ name: s.source?.baseRef ?? null, anchor: forkPointOf(s) });
  const queue = [declaredBase, ...found.map((a) => nextOf(byBranch.get(a.branch)))];
  const visited = new Set(found.map((a) => a.branch));
  while (queue.length) {
    const step = queue.shift();
    const dName = step?.name;
    if (!dName || !step.anchor || visited.has(dName)) continue;
    const declared = byBranch.get(dName);
    if (!declared) continue;
    const checks = [isAnc(step.anchor, head.oid), isAnc(step.anchor, `refs/heads/${dName}`), isAnc(step.anchor, baseRev)];
    const failed = checks.find((c) => !c.ok && c.status !== 1);
    if (failed) return none(failed.reason ?? 'merge-base --is-ancestor failed');
    if (!(checks[0].ok && checks[1].ok && !checks[2].ok)) continue;
    visited.add(dName);
    found.push(fact(declared, dName, step.anchor));
    queue.push(nextOf(declared));
  }
  const ancestors = withoutCoTips(found, byBranch, prefer);
  if (!ancestors.length) return { queried: true, ancestors, nearest: null, ambiguous: null };
  const oids = [...new Set(ancestors.map((a) => a.oid))];
  let independent = oids;
  if (oids.length > 1) {
    const ind = runGit(['merge-base', '--independent', ...oids], cwd);
    // Fail closed: an ancestry that cannot be ordered is not measured, so it exempts nobody.
    if (!ind.ok) return none(ind.reason ?? 'merge-base --independent failed');
    independent = ind.stdout.split('\n').map((x) => x.trim()).filter(Boolean);
  }
  return { queried: true, ancestors, ...nearestOf(ancestors, independent) };
}

/**
 * Sessions sharing ONE tip cannot be told apart by git: a fresh child of `parent` sits exactly on parent's tip, so for a third
 * branch cut from that tip both look like ancestors, and two co-children would exempt each other. The registry breaks the tie: a
 * member DECLARED stacked on another member of its group (`source.baseRef`) is that member's co-child, not this branch's
 * ancestor. A group still holding more than one member is dropped whole (it exempts nobody — the safe side). A group holding
 * `prefer` (the claim's --base or declared base) keeps it and the members it is declared stacked on: a fresh grandchild names
 * its parent with --base, since git cannot tell a child of a fresh parent from that parent's sibling.
 * @param {Array<{id: string, gen: number, branch: string, oid: string}>} found
 * @param {Map<string, object|null>} byBranch
 * @param {string|null} [prefer]
 */
export function withoutCoTips(found, byBranch, prefer = null) {
  const byOid = new Map();
  for (const a of found) byOid.set(a.oid, [...(byOid.get(a.oid) ?? []), a]);
  const out = [];
  for (const group of byOid.values()) {
    if (group.length === 1) { out.push(group[0]); continue; }
    const byName = new Map(group.map((a) => [a.branch, a]));
    if (prefer && byName.has(prefer)) {
      // The named base and every member it is declared stacked on, up the group (each visited once).
      for (let n = prefer; n && byName.has(n); n = byBranch.get(n)?.source?.baseRef) { out.push(byName.get(n)); byName.delete(n); }
      continue;
    }
    const roots = group.filter((a) => !byName.has(byBranch.get(a.branch)?.source?.baseRef));
    if (roots.length === 1) out.push(roots[0]);
  }
  return out;
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
