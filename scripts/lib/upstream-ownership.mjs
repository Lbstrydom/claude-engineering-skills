/**
 * @fileoverview The single oracle for "is this path maintained upstream, or is
 * it this repo's to fix?".
 *
 * Two independent sources, unioned, because neither covers the other's hole:
 *
 *   1. **Ignored AND untracked** (`disowned-paths.mjs`) — covers
 *      `scripts/.claude-skills/**`, which a consumer gitignores. Says nothing
 *      about surfaces a consumer COMMITS.
 *   2. **The committed sync sidecar** (`sync-owned-sidecar.mjs`) — covers
 *      `.claude/hooks/**` and `.claude/skills/**`, which are committed,
 *      unignored, and cannot carry a content banner.
 *
 * **Asked of the CANDIDATES, never of the repo** — the same rule
 * `disowned-paths.mjs` records: materialising the whole ignored universe to
 * classify a handful of ledger entries means enumerating `node_modules`.
 *
 * **Two sources, and therefore THREE states, not two.** Reporting only
 * `degraded` (nothing answered) versus not-degraded would repeat this change's
 * own defect one layer up: with git healthy and no sidecar, the gitignore half
 * answers confidently for `scripts/.claude-skills/**` and is *structurally
 * blind* to the committed surfaces — which are the entire reason the sidecar
 * exists. A caller told `degraded: false` would read that as a verified answer
 * for exactly the paths nothing looked at. So:
 *
 *   - `degraded: true`  — NEITHER source spoke. Nothing was classified.
 *   - `partial: true`   — one source spoke; the surfaces the other covers were
 *                         not examined. `blindTo` names them.
 *   - both false        — both sources spoke.
 *
 * Answering `false` under either is the conservative direction on its own
 * terms: over-claiming upstream ownership silently excuses a repo's own
 * defects.
 *
 * @module scripts/lib/upstream-ownership
 */
import fs from 'node:fs';
import path from 'node:path';

import { ignoredUntrackedPaths } from './disowned-paths.mjs';
import {
  isUsableSidecar, comparisonKey, OWNED_SIDECAR_RELATIVE_PATH,
} from './sync-owned-sidecar.mjs';

/**
 * The surfaces only the sidecar can classify: a consumer COMMITS these, so
 * git-ignore state says nothing about them, and neither can carry a sync
 * banner. Named here so `partial` can report what it did not look at rather
 * than merely that something was missing.
 */
const SIDECAR_ONLY_SURFACES = Object.freeze(['.claude/hooks/**', '.claude/skills/**']);


/**
 * Read `scripts/.sync-owned.json` from a repo root. `null` when absent or
 * unparseable — never a throw, and never a fabricated empty document (an empty
 * `paths` array would assert "nothing is upstream-owned", which is a claim).
 *
 * @param {string} repoRoot
 * @returns {object|null}
 */
export function loadOwnedSidecar(repoRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, OWNED_SIDECAR_RELATIVE_PATH), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Build the ownership predicate for a specific candidate set.
 *
 * @param {string} repoRoot
 * @param {string[]} candidates - repo-relative paths to classify
 * @param {{classify?: Function, sidecar?: object|null}} [deps] - injected for tests
 * @returns {{isUpstreamOwned: (relPath: string) => boolean, degraded: boolean,
 *            partial: boolean, blindTo: string[], sources: string[],
 *            warning: string|null}}
 */
export function createUpstreamOwnershipOracle(repoRoot, candidates, deps = {}) {
  const classify = deps.classify ?? ignoredUntrackedPaths;
  const raw = deps.sidecar !== undefined ? deps.sidecar : loadOwnedSidecar(repoRoot);
  // Document validity is `sync-owned-sidecar.mjs`'s call, not a second copy
  // of the rule here — audit R5 M3/M14: this module and `isUpstreamOwned`
  // disagreed about a half-malformed `paths` array precisely because each
  // decided validity for itself.
  const sidecar = isUsableSidecar(raw) ? raw : null;
  const normalised = [...new Set(
    (Array.isArray(candidates) ? candidates : [])
      .filter((p) => typeof p === 'string' && p.length > 0)
      .map((p) => p.split('\\').join('/')),
  )];

  const git = normalised.length > 0
    ? classify(repoRoot, normalised)
    : { paths: new Set(), degraded: false, warning: null };
  const sources = [];
  if (!git.degraded) sources.push('gitignore');
  if (sidecar) sources.push('sync-sidecar');

  // Case-folded, because Windows and macOS filesystems are: a consumer's ledger
  // cited `.claude/skills/*/skill.md` against a manifest spelling `SKILL.md`,
  // and six upstream-owned entries were classified as their own work.
  //
  // Through `comparisonKey` — the SAME reduction the sidecar half uses (Gemini
  // final gate, 2026-09-04). This half only lower-cased, so a query for
  // `./src/f.js` missed a git path recorded as `src/f.js`. That is the fifth
  // instance of one class in this audit, and the last one that was still
  // spelled out by hand instead of delegated: the fix for R4 M12 introduced
  // `comparisonKey` and applied it to the sidecar half only.
  const ignoredKeys = new Set([...git.paths].map((p) => comparisonKey(p)));
  // The sidecar half gets the same O(1) shape (Gemini gate round 2). Delegating
  // to `isUpstreamOwned` per query re-ran `comparisonKey` over every sidecar
  // entry on every call — and a consumer's sidecar lists hundreds of paths
  // while `debt:review` queries it once per cited file. Same reduction, so the
  // two halves cannot drift; only the lookup shape differs.
  const sidecarKeys = sidecar ? new Set(sidecar.paths.map((p) => comparisonKey(p))) : null;

  // What this run did NOT look at. Absent sidecar ⇒ the committed surfaces were
  // never examined; absent git ⇒ every gitignored path was never examined.
  const blindTo = [];
  if (!sidecar) blindTo.push(...SIDECAR_ONLY_SURFACES);
  if (git.degraded) blindTo.push('every gitignored-and-untracked path');

  const degraded = git.degraded && !sidecar;

  return {
    isUpstreamOwned(relPath) {
      if (typeof relPath !== 'string' || relPath.length === 0) return false;
      const rel = relPath.split('\\').join('/');
      const key = comparisonKey(rel);
      return ignoredKeys.has(key) || (sidecarKeys?.has(key) ?? false);
    },
    // Degraded = NEITHER source spoke. Partial = one did and the other's
    // surfaces went unexamined — a distinct state, because "git answered" is
    // not evidence about a path git cannot classify.
    degraded,
    partial: !degraded && blindTo.length > 0,
    blindTo,
    sources,
    warning: git.warning ?? null,
  };
}
