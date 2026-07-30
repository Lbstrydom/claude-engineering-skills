/**
 * @fileoverview Read-only inspector for the RETIRED skill-install surfaces.
 *
 * Three callers need to know whether a machine still carries skill trees written
 * by the pre-retirement installer — `install.mjs` (to offer migration),
 * `sync-to-repos.mjs` (to warn), and `install-skills.mjs --uninstall-legacy` (to
 * delete). This module is the single oracle all three consult, so they cannot
 * disagree about what "still there" means.
 *
 * **It never writes and never deletes.** It returns the bounded member set; the
 * delete itself stays behind `computeDeletes` + the WAL transaction. That split
 * is deliberate: an inspector that could also delete would be a second delete
 * path, and the whole point of the retirement is that there is exactly one of
 * each thing.
 *
 * ## Two roots, two receipts — not one
 *
 * The obvious mistake (and the one an earlier draft of the plan made) is to speak
 * of "the global receipt". There are **two** retired surfaces recorded at
 * **different scopes**:
 *
 * | Surface  | Tree                             | Receipt                                        |
 * |----------|----------------------------------|------------------------------------------------|
 * | `claude` | `~/.claude/skills/`              | `~/.audit-loop-install-receipt.json`           |
 * | `agents` | `<repoRoot>/.agents/skills/`     | `<repoRoot>/.audit-loop-install-receipt.json`  |
 *
 * An inspector reading only the global receipt reports `absent` for a repo
 * carrying a stale `.agents/skills/` tree — a **false clean**, which is exactly
 * the success-path failure class this bundle's own doctrine forbids.
 *
 * ## States are a fold over per-member classification
 *
 * Defining the three surface states directly leaves a real gap: a valid receipt
 * with one member already deleted by hand matches neither "every member present
 * and unmodified" nor "modified / unreadable" — and that partially-cleaned state
 * is the *common* one. So members are classified first and the surface state is
 * a fold, which is exhaustive by construction.
 *
 * `homeRoot` / `repoRoot` are injected rather than read from `os.homedir()` here,
 * so the hermetic tests and the CI fixture can drive this without touching a real
 * `$HOME`.
 *
 * Plan: docs/plans/repo-scoped-skill-surfaces-and-installer.md §2 D6b/D6c.
 *
 * @module scripts/lib/install/legacy-surfaces
 */
import fs from 'node:fs';
import path from 'node:path';

import { globalSurfaceRoot, receiptPath, managedFileAbsPath } from './surface-paths.mjs';
import { readReceipt } from './receipt.mjs';
// The digest the receipts were WRITTEN with. Re-deriving it here (even
// identically) would let the two sides drift into disagreeing about what
// "unmodified" means, which decides whether a file gets deleted.
import { computeFileSha } from './conflict-detector.mjs';

/**
 * The retired surfaces this module can CLEAN UP, as data.
 *
 * One entry per surface, so adding or retiring another is a single edit rather
 * than three call-site changes. `scope` selects which receipt records it —
 * matching `partitionManagedFilesByScope`'s `global` / `repo` split exactly.
 *
 * ## Why this list is SHORTER than `surface-paths.mjs`'s retired-surface table
 *
 * The two lists answer different questions and are deliberately not the same
 * set — they are named apart so the difference reads as intent, not drift:
 *
 * | List | Question | Members |
 * |---|---|---|
 * | `surface-paths.mjs::RETIRED_INSTALL_SURFACES` | which `--surface` values must be REFUSED, and with what message? | copilot, claude, agents, both |
 * | this list | which trees can this bundle safely DELETE? | claude, agents |
 *
 * `copilot` (`.github/skills/`) is absent here on purpose. It was retired
 * 2026-07-28, before receipts covered it, so there is no receipt recording what
 * this bundle put there — and the one rule this module cannot break is
 * "membership comes from a receipt, never from reading the directory". Deleting
 * an unrecorded tree would be exactly the unbounded enumeration S3 forbids.
 * `scripts/check-stale-skill-surface.mjs` owns detecting a stale
 * `.github/skills/` and telling the operator to remove it by hand; that split
 * (detect here, delete only what we can prove we wrote) is the correct one.
 */
export const CLEANABLE_LEGACY_SURFACES = Object.freeze([
  Object.freeze({
    surface: 'claude',
    scope: 'global',
    describe: '~/.claude/skills/',
    root: ({ homeRoot }) => globalSurfaceRoot(homeRoot),
  }),
  Object.freeze({
    surface: 'agents',
    scope: 'repo',
    describe: '<repo>/.agents/skills/',
    root: ({ repoRoot }) => path.join(repoRoot, '.agents', 'skills'),
  }),
]);

/**
 * Classify ONE receipt member against what is actually on disk.
 *
 * - `present-clean`    — on disk, digest matches the receipt → safe to delete
 * - `present-modified` — on disk, digest differs (the user edited it) → never delete
 * - `absent`           — already gone → nothing to delete, drops out of the receipt
 *
 * An unreadable-but-existing file is treated as `present-modified`: we cannot
 * prove we own its current bytes, and "cannot prove" must never resolve to
 * "delete it" (fail closed).
 *
 * @param {{path: string, sha: string, scope?: string}} member
 * @param {string} repoRoot
 * @returns {{absPath: string, expectedSha: string, classification: string}}
 */
function classifyMember(member, repoRoot) {
  const absPath = managedFileAbsPath(member, repoRoot);
  const out = { absPath, expectedSha: member.sha, classification: 'absent' };

  // Existence is checked separately from the digest because `computeFileSha`
  // collapses every read failure to `null`, and the two failures mean opposite
  // things here: "already cleaned up" (fine, skip it) versus "present but
  // unprovable" (never delete it).
  //
  // `lstatSync`, NOT `existsSync`: existsSync FOLLOWS symlinks, so a dangling
  // symlink sitting at a receipt member's path reports "absent" while the
  // directory entry is very much still there. We would then drop the member from
  // the receipt as already-cleaned and leave the link behind permanently
  // unowned. lstat sees the entry itself, which is what "is something here?"
  // has to mean for a path we may delete.
  try {
    fs.lstatSync(absPath);
  } catch (err) {
    if (err.code === 'ENOENT') return out;              // genuinely gone
    out.classification = 'present-modified';            // EACCES/ELOOP/… — fail closed
    out.reason = `cannot stat (${err.code}) — ownership cannot be proven`;
    return out;
  }

  const actual = computeFileSha(absPath);
  if (actual === null) {
    out.classification = 'present-modified';
    out.reason = 'present but unreadable — ownership cannot be proven';
    return out;
  }
  out.actualSha = actual;
  out.classification = actual === member.sha ? 'present-clean' : 'present-modified';
  if (out.classification === 'present-modified') out.reason = 'modified since install';
  return out;
}

/**
 * Fold member classifications into the surface's state.
 *
 * Exhaustive by construction — every combination of the three member
 * classifications maps to exactly one state:
 *   any `present-modified`            → blocked  (we must not delete it)
 *   else any `present-clean`          → removable
 *   else (all `absent`, or no members) → absent
 */
function foldState(members) {
  if (members.some(m => m.classification === 'present-modified')) return 'blocked';
  if (members.some(m => m.classification === 'present-clean')) return 'removable';
  return 'absent';
}

/**
 * Inspect one retired surface.
 *
 * @param {object} descriptor one of CLEANABLE_LEGACY_SURFACES
 * @param {{homeRoot?: string, repoRoot: string}} roots
 */
function inspectSurface(descriptor, roots) {
  const root = descriptor.root(roots);
  const rp = receiptPath(descriptor.scope, roots.repoRoot, roots.homeRoot);

  const base = { surface: descriptor.surface, describe: descriptor.describe, root, receiptPath: rp };

  const { receipt, error } = readReceipt(rp);
  if (error) {
    // A receipt we cannot parse is BLOCKED, never "nothing to do". Reporting
    // `absent` here would be the false-clean this module exists to prevent —
    // there may be a full managed tree on disk whose ownership record we simply
    // failed to read.
    return { ...base, state: 'blocked', members: [], blockedReason: `receipt unreadable: ${error}` };
  }
  if (!receipt?.managedFiles?.length) {
    return { ...base, state: 'absent', members: [] };
  }

  // Only members belonging to THIS surface's scope. A repo receipt legitimately
  // carries entries from other (non-skill) managed files; deleting those would
  // be far outside this tool's authority.
  const scoped = receipt.managedFiles.filter((m) => (m.scope ?? 'repo') === descriptor.scope);
  const members = scoped
    .map(m => classifyMember(m, roots.repoRoot))
    // Restrict to files actually under this surface's root — the bounded set.
    .filter(m => isUnder(m.absPath, root));

  const state = foldState(members);
  const blocked = members.filter(m => m.classification === 'present-modified');
  return {
    ...base,
    state,
    members,
    ...(state === 'blocked'
      ? { blockedReason: `${blocked.length} file(s) modified since install` }
      : {}),
  };
}

/** Is `p` inside `root`? Lexical — callers that DELETE re-verify via the containment guard. */
function isUnder(p, root) {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Inspect every retired surface.
 *
 * @param {{homeRoot?: string, repoRoot: string}} roots
 * @returns {{surfaces: object[], overall: 'absent'|'removable'|'blocked', deletable: Array<{absPath: string, expectedSha: string}>}}
 */
export function inspectLegacySurfaces({ homeRoot, repoRoot }) {
  if (!repoRoot) throw new TypeError('inspectLegacySurfaces: repoRoot is required');
  const surfaces = CLEANABLE_LEGACY_SURFACES.map(d => inspectSurface(d, { homeRoot, repoRoot }));

  // Same fold, one level up — `blocked` dominates `removable` dominates `absent`,
  // so the caller's prompt/warn decision can key on one value.
  const overall = surfaces.some(s => s.state === 'blocked')
    ? 'blocked'
    : surfaces.some(s => s.state === 'removable') ? 'removable' : 'absent';

  // The bounded delete set, handed to computeDeletes/the transaction. ONLY
  // `present-clean` members: never enumerated from disk, never a modified file.
  //
  // `overall` and `deletable` answer DIFFERENT questions — do not collapse them:
  //   overall   → may an INSTALL offer to clean up? `blocked` ⇒ warn, never offer.
  //   deletable → what may the EXPLICIT `--uninstall-legacy` command remove?
  // So a `blocked` surface still contributes its clean members here. That is
  // what makes the `partial` cleanup outcome reachable at all; if it did not,
  // one hand-edited file would permanently strand every managed file beside it.
  const deletable = surfaces.flatMap(s => s.members
    .filter(m => m.classification === 'present-clean')
    .map(m => ({ absPath: m.absPath, expectedSha: m.expectedSha })));

  return { surfaces, overall, deletable };
}

/**
 * Render the inspection for a human, without deciding anything.
 *
 * Kept here beside the states it describes so a new state cannot be added
 * without its message — the drift that lets a CLI print "nothing to do" for a
 * state that means the opposite.
 *
 * @param {ReturnType<typeof inspectLegacySurfaces>} inspection
 * @returns {string[]} lines (empty when there is nothing worth saying)
 */
export function describeLegacySurfaces(inspection) {
  const lines = [];
  for (const s of inspection.surfaces) {
    if (s.state === 'absent') continue;
    if (s.state === 'removable') {
      const n = s.members.filter(m => m.classification === 'present-clean').length;
      lines.push(`${s.describe} still holds ${n} file(s) from the retired '${s.surface}' surface (${s.root})`);
    } else {
      lines.push(`${s.describe} cannot be cleaned automatically: ${s.blockedReason} (${s.root})`);
      for (const m of s.members.filter(x => x.classification === 'present-modified')) {
        lines.push(`  - ${m.absPath} — ${m.reason}`);
      }
    }
  }
  return lines;
}

export const _internals = { classifyMember, foldState, inspectSurface, isUnder };
