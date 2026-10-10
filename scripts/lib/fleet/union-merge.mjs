/**
 * @fileoverview Keep-both-sides resolution for APPEND-ONLY files (a plan's log,
 * a decisions index) that two parallel branches each append to — the conflict
 * storyline hit on every land.
 *
 * All-or-nothing, decided before anything is written:
 *  1. **Eligibility.** Every conflicted path must match `.fleet.json`
 *     `appendOnlyGlobs`, have ALL THREE index stages (base, ours, theirs — so
 *     add/add, modify/delete and rename conflicts are ineligible), be a regular
 *     file with the same mode on both sides, be text (no NUL in any stage), and
 *     ACTUALLY be append-only: neither side deletes or rewrites a base line (a
 *     glob is a declaration, not proof). One ineligible path ⇒ nothing is
 *     touched; the conflict stays ordinary.
 *  2. **Compute** every resolution first, byte for byte: the three stages are
 *     materialised by git itself (`checkout-index --stage=all --temp`) and merged
 *     in place by `git merge-file --union` — no blob ever passes through a
 *     JavaScript string, so no encoding can be altered.
 *  3. **Write + stage.** Only ever inside a THROWAWAY worktree (train or
 *     restack): any failure is reported and the caller abandons that worktree,
 *     so a half-resolved tree is never visible to anyone.
 *
 * Plan: docs/plans/fleet-consumer-feedback-oct.md §2.5.
 *
 * @module scripts/lib/fleet/union-merge
 */
import fs from 'node:fs';
import path from 'node:path';
import micromatch from 'micromatch';

const REGULAR = new Set(['100644', '100755']);

/**
 * Parse `git ls-files -u -z` (`<mode> <oid> <stage>\t<path>\0`) into per-path stages.
 * @returns {Map<string, Record<string, {mode: string, oid: string}>>}
 */
export function parseUnmerged(text) {
  const out = new Map();
  for (const rec of String(text).split('\0')) {
    const m = /^(\d{6}) ([0-9a-f]{40,64}) ([123])\t(.+)$/s.exec(rec);
    if (!m) continue;
    const [, mode, oid, stage, p] = m;
    if (!out.has(p)) out.set(p, {});
    out.get(p)[stage] = { mode, oid };
  }
  return out;
}

/**
 * Why `p` cannot be union-resolved on its index stages alone, or null. Pure.
 * @param {string} p
 * @param {Record<string, {mode: string, oid: string}>} stages
 * @param {string[]} globs
 */
export function ineligibility(p, stages, globs) {
  if (!globs.length || !micromatch.isMatch(p, globs, { dot: true })) return 'not in appendOnlyGlobs';
  for (const s of ['1', '2', '3']) if (!stages[s]) return `stage ${s} missing (${s === '1' ? 'add/add' : 'modify/delete or rename'} conflict)`;
  if (!REGULAR.has(stages['1'].mode) || !REGULAR.has(stages['2'].mode) || !REGULAR.has(stages['3'].mode)) return 'not a regular file';
  if (stages['2'].mode !== stages['3'].mode) return 'file mode differs between the two sides';
  return null;
}

/**
 * Does `side` only ADD lines to `base`? True when every base line survives, in
 * order, in `side` (insertions anywhere are fine; a deleted or rewritten base
 * line is not append-only). Lines are compared WITH their terminators, so "a\n"
 * and "a" differ: dropping a final newline is an edit, and so is adding one to
 * an unterminated last line (the safe direction — that stays an ordinary conflict).
 * @param {Buffer} base
 * @param {Buffer} side
 */
export function onlyAdds(base, side) {
  // Split AFTER each LF, keeping it: the terminator is part of the line's identity.
  const lines = (buf) => buf.toString('latin1').split(/(?<=\n)/).filter((l) => l !== '');
  const b = lines(base);
  const s = lines(side);
  let j = 0;
  for (const line of b) {
    while (j < s.length && s[j] !== line) j += 1;
    if (j >= s.length) return false;
    j += 1;
  }
  return true;
}

/** Parse `checkout-index --stage=all --temp -z` output: `<t1> <t2> <t3>\t<path>\0` (a `.` for a missing stage). */
function parseTempStages(text) {
  const out = new Map();
  for (const rec of String(text).split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    out.set(rec.slice(tab + 1), rec.slice(0, tab).split(' '));
  }
  return out;
}

/**
 * Resolve the CURRENT conflict in worktree `dir` if (and only if) every
 * conflicted path is eligible.
 * @param {{dir: string, git: (args: string[], opts?: object) => {ok: boolean, status?: number|null, stdout: string, reason?: string|null}, globs: string[]}} a
 * @returns {{ok: true, resolved: string[]} | {ok: false, ineligible?: Array<{path: string, why: string}>, reason: string}}
 */
export function resolveAppendOnly({ dir, git, globs }) {
  const u = git(['ls-files', '-u', '-z']);
  if (!u.ok) return { ok: false, reason: `cannot list conflicts: ${u.reason}` };
  const conflicts = parseUnmerged(u.stdout);
  if (!conflicts.size) return { ok: false, reason: 'no unmerged paths (the conflict is not a content conflict)' };
  const ineligible = [];
  for (const [p, stages] of conflicts) {
    const why = ineligibility(p, stages, globs);
    if (why) ineligible.push({ path: p, why });
  }
  if (ineligible.length) return { ok: false, ineligible, reason: `not union-resolvable: ${ineligible.map((x) => `${x.path} (${x.why})`).join('; ')}` };

  // Materialise every stage as a real file — git writes the bytes, JavaScript never decodes them.
  const paths = [...conflicts.keys()];
  const temps = [];
  const cleanup = () => { for (const t of temps) { try { fs.rmSync(path.join(dir, t), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort: the worktree is throwaway */ } } };
  try {
    const co = git(['checkout-index', '--stage=all', '--temp', '-z', '--', ...paths]);
    if (!co.ok) return { ok: false, reason: `cannot materialise the conflict stages: ${co.reason}` };
    const staged = parseTempStages(co.stdout);
    for (const t of staged.values()) temps.push(...t.filter((x) => x && x !== '.'));
    const results = [];
    for (const p of paths) {
      const t = staged.get(p);
      if (!t || t.some((x) => !x || x === '.')) return { ok: false, reason: `stage files for ${p} were not materialised` };
      const [base, ours, theirs] = t.map((x) => fs.readFileSync(path.join(dir, x)));
      if ([base, ours, theirs].some((buf) => buf.includes(0))) {
        return { ok: false, ineligible: [{ path: p, why: 'binary content' }], reason: `not union-resolvable: ${p} (binary content)` };
      }
      if (!onlyAdds(base, ours) || !onlyAdds(base, theirs)) {
        return { ok: false, ineligible: [{ path: p, why: 'a side deletes or rewrites base lines (not append-only)' }], reason: `not union-resolvable: ${p} is not append-only on both sides` };
      }
      // merge-file writes the union into the OURS temp file in place: byte-level, no decoding.
      const m = git(['merge-file', '--union', t[1], t[0], t[2]]);
      if (!m.ok && m.status !== 0) return { ok: false, reason: `merge-file failed for ${p}: ${m.reason}` };
      results.push({ p, from: path.join(dir, t[1]) });
    }
    for (const { p, from } of results) {
      try { fs.copyFileSync(from, path.join(dir, p)); } catch (e) { return { ok: false, reason: `cannot write ${p}: ${e.message} — abandon this worktree` }; }
      const a = git(['add', '--', p]);
      if (!a.ok) return { ok: false, reason: `cannot stage ${p}: ${a.reason} — abandon this worktree` };
    }
    return { ok: true, resolved: results.map((r) => r.p) };
  } catch (e) {
    return { ok: false, reason: `union resolution failed: ${e.message} — abandon this worktree` };
  } finally {
    cleanup();
  }
}
