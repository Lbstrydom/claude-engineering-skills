/**
 * @fileoverview Orphan directories under the worktree roots (plan §2.6 x): directories that are not a
 * `git worktree list` entry and hold no `.git` — what neither `git worktree prune` nor branch pruning can see.
 * Read-only; it prints at most a plain `rmdir` for an EMPTY directory and never a recursive command.
 *
 * The scan follows no link (INC-001's class): a root that is itself a link is skipped with a note; children
 * are read with `lstat`, and a link child is listed as `link — not inspected` and never descended into; each
 * child's realpath must stay under the root's realpath; a directory that cannot be fully read is `unreadable`,
 * never "empty". `ignored-only` (every top-level entry matches `archiveIgnore`, such as `node_modules`) is
 * claimed only after a bounded walk finds no link anywhere inside — and even then it prints "look", not a
 * recursive delete: no recursive form is verified here not to follow a junction, so none is printed.
 *
 * @module scripts/lib/fleet/prune-orphans
 */
import fs from 'node:fs';
import path from 'node:path';
import { samePath } from '../harness-paths.mjs';
import { isIgnoredByConfig } from './lifecycle.mjs';
import { renderCommand } from './shell-quote.mjs';

/** Bound on the link-free walk behind `ignored-only`: past it the directory is "look", never a verdict. */
export const ORPHAN_WALK = Object.freeze({ maxEntries: 5_000, maxRootEntries: 500 });

const isInside = (child, root) => {
  const rel = path.relative(root, child);
  return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
};

/** Does a bounded `lstat` walk find NO link below `dir`? `null` = could not tell (unreadable or over budget). */
function linkFree(dir, budget) {
  // Entries are read ONE AT A TIME (`opendirSync`), so the budget bounds the enumeration itself, not just what is
  // done after a directory of any size has been read into memory.
  let d;
  try { d = fs.opendirSync(dir); } catch { return null; }
  try {
    for (let e = d.readSync(); e !== null; e = d.readSync()) {
      if ((budget.left -= 1) < 0) return null;
      if (e.isSymbolicLink()) return false;
      if (e.isDirectory()) {
        const sub = linkFree(path.join(dir, e.name), budget);
        if (sub !== true) return sub;
      } else if (!e.isFile()) {
        // A junction can read as neither file nor directory through readdir on some platforms: treat as a link.
        try { if (fs.lstatSync(path.join(dir, e.name)).isSymbolicLink()) return false; } catch { return null; }
      }
    }
    return true;
  } catch { return null; } finally { try { d.closeSync(); } catch { /* already closed */ } }
}

/**
 * @param {{roots: string[], worktrees: Array<{path: string}>, archiveIgnore?: string[], platform?: string}} a
 * @returns {{roots: Array<{root: string, note?: string}>, dirs: Array<{path: string, kind: string, files?: number, command?: string}>}}
 */
export function scanOrphanDirs({ roots, worktrees, archiveIgnore = [], platform = process.platform }) {
  const out = { roots: [], dirs: [] };
  for (const root of roots) {
    let st;
    try { st = fs.lstatSync(root); } catch (e) { if (e.code !== 'ENOENT') out.roots.push({ root, note: `unreadable (${e.code ?? e.message})` }); continue; }
    if (st.isSymbolicLink()) { out.roots.push({ root, note: 'the root is a link — skipped, not inspected' }); continue; }
    if (!st.isDirectory()) continue;
    let rootReal;
    try { rootReal = fs.realpathSync.native(root); } catch (e) { out.roots.push({ root, note: `unreadable (${e.code ?? e.message})` }); continue; }
    out.roots.push({ root });
    // Read incrementally under a cap: a root with more entries than that is reported as such, never read whole.
    const children = [];
    let rd;
    try {
      rd = fs.opendirSync(root);
      for (let e = rd.readSync(); e !== null; e = rd.readSync()) {
        if (children.length >= ORPHAN_WALK.maxRootEntries) { out.roots.push({ root, note: `more than ${ORPHAN_WALK.maxRootEntries} entries — the rest were not inspected` }); break; }
        children.push(e);
      }
    } catch (e) { out.roots.push({ root, note: `unreadable (${e.code ?? e.message})` }); continue; } finally { try { rd?.closeSync(); } catch { /* closed */ } }
    for (const c of children) {
      const p = path.join(root, c.name);
      if (worktrees.some((w) => samePath(w.path, p, platform))) continue;
      let cst;
      try { cst = fs.lstatSync(p); } catch { out.dirs.push({ path: p, kind: 'unreadable' }); continue; }
      if (cst.isSymbolicLink()) { out.dirs.push({ path: p, kind: 'link' }); continue; }
      if (!cst.isDirectory()) continue;
      let real;
      try { real = fs.realpathSync.native(p); } catch { out.dirs.push({ path: p, kind: 'unreadable' }); continue; }
      if (!isInside(real, rootReal)) { out.dirs.push({ path: p, kind: 'link' }); continue; }
      if (fs.existsSync(path.join(p, '.git'))) continue; // a repo or an unlisted worktree: git's own business
      // Its top level, read incrementally under the same per-directory cap; past it the directory just "holds" files.
      const names = []; let over = false; let od;
      try {
        od = fs.opendirSync(p);
        for (let e = od.readSync(); e !== null; e = od.readSync()) {
          if (names.length >= ORPHAN_WALK.maxRootEntries) { over = true; break; }
          names.push(e.name);
        }
      } catch { out.dirs.push({ path: p, kind: 'unreadable' }); continue; } finally { try { od?.closeSync(); } catch { /* closed */ } }
      if (over) { out.dirs.push({ path: p, kind: 'holds', files: names.length }); continue; }
      if (!names.length) { out.dirs.push({ path: p, kind: 'empty', command: renderCommand(['rmdir', p], platform) }); continue; }
      const ignoredOnly = names.every((n) => isIgnoredByConfig(`${n}/`, archiveIgnore) || isIgnoredByConfig(n, archiveIgnore));
      if (ignoredOnly && linkFree(p, { left: ORPHAN_WALK.maxEntries }) === true) { out.dirs.push({ path: p, kind: 'ignored-only', files: names.length }); continue; }
      out.dirs.push({ path: p, kind: 'holds', files: names.length });
    }
  }
  return out;
}

const KIND_TEXT = {
  empty: 'empty',
  'ignored-only': 'ignored-only (archiveIgnore entries, no link inside) — look; no recursive delete is printed',
  holds: 'holds files — look',
  link: 'link — not inspected',
  unreadable: 'unreadable — look',
};

/** Text lines for the orphan scan, or [] when there is nothing to say. */
export function renderOrphans(o) {
  if (!o) return [];
  const notes = o.roots.filter((r) => r.note);
  if (!o.dirs.length && !notes.length) return [];
  const lines = ['', `orphan directories under the worktree roots (${o.dirs.length}) — not git worktrees, no .git; nothing is removed:`];
  for (const r of notes) lines.push(`  root ${r.root}: ${r.note}`);
  for (const d of o.dirs) {
    lines.push(`  ${d.path} — ${d.kind === 'holds' ? `holds ${d.files} entr${d.files === 1 ? 'y' : 'ies'} — look` : KIND_TEXT[d.kind]}`);
    if (d.command) lines.push(`    ${d.command}`);
  }
  return lines;
}
