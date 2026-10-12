/**
 * @fileoverview Stale hydrated tooling (docs/plans/fleet-unclaimed-work-and-switch-friction.md §2.4 c).
 *
 * In a consumer, a linked worktree runs the fleet CLI from its own copy of the synced tree (`scripts/.claude-skills/`,
 * copied in by `npm run skills:hydrate`). That copy does not update when the main checkout is re-synced, so a session
 * can run older tooling than its siblings without knowing it (2026-10-11: a worktree lacked `fleet release` entirely).
 * The copy's bundle stamp is `scripts/.sync-manifest.json` (`commitSha`, `generatedAt`); this compares it with the
 * main checkout's. stderr only — `--json` output stays clean — and never an error: a warning cannot fail a verb.
 * The source repo runs its tracked `scripts/` and is never checked. Identity is the EXECUTING copy's: the checkout is
 * derived from `scriptDir`, never from the working directory, so running one worktree's copy from another directory
 * judges the copy that actually ran.
 *
 * @module scripts/lib/fleet/bundle-stamp
 */
import fs from 'node:fs';
import path from 'node:path';
import { samePath } from '../harness-paths.mjs';
import { gitCommonDir, repoToplevel } from './git-facts.mjs';

export const HYDRATE_HINT = 'npm run skills:hydrate';
const SYNCED_DIR = '.claude-skills';
const MANIFEST = path.join('scripts', '.sync-manifest.json');

function readStamp(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const at = Date.parse(j.generatedAt);
    return { ok: true, commitSha: typeof j.commitSha === 'string' ? j.commitSha : null, at: Number.isFinite(at) ? at : null };
  } catch (e) { return { ok: false, reason: e.code === 'ENOENT' ? 'missing' : 'unreadable' }; }
}

/**
 * The warning for a stale hydrated copy, or null when there is nothing to say (the source repo, the main checkout,
 * or a copy as new as the main checkout's).
 * @param {{scriptDir: string}} a scriptDir = the directory the running fleet.mjs lives in
 * @returns {string|null}
 */
export function staleBundleWarning({ scriptDir }, { top = repoToplevel, common = gitCommonDir } = {}) {
  // Only a synced copy can be stale: `<root>/scripts/.claude-skills/fleet.mjs`.
  const dir = path.resolve(scriptDir);
  if (path.basename(dir) !== SYNCED_DIR || path.basename(path.dirname(dir)) !== 'scripts') return null;
  const root = path.dirname(path.dirname(dir));
  const t = top(root); const c = common(root);
  if (t.ok && !samePath(t.dir, root)) return null; // the copy is not at a checkout's root: not the layout this judges
  if (!t.ok || !c.ok || path.basename(c.dir).toLowerCase() !== '.git') return null;
  const mainRoot = path.dirname(c.dir);
  if (samePath(mainRoot, t.dir)) return null; // the main checkout: its copy IS the reference
  const mine = readStamp(path.join(t.dir, MANIFEST));
  const theirs = readStamp(path.join(mainRoot, MANIFEST));
  if (!theirs.ok) return null; // nothing to compare against: the main checkout has no stamp either
  if (!mine.ok) return `fleet: this worktree's synced tooling has no bundle stamp (${mine.reason}) while the main checkout's is ${String(theirs.commitSha ?? '?').slice(0, 12)} — it may be older; run ${HYDRATE_HINT}`;
  if (mine.commitSha === theirs.commitSha) return null;
  if (mine.at !== null && theirs.at !== null && mine.at >= theirs.at) return null; // newer or equal here
  return `fleet: this worktree's synced tooling (${String(mine.commitSha ?? '?').slice(0, 12)}) is older than the main checkout's (${String(theirs.commitSha ?? '?').slice(0, 12)}) — run ${HYDRATE_HINT}`;
}
