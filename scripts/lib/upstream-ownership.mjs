/**
 * @fileoverview The single oracle for "is this path maintained upstream, or is
 * it this repo's to fix?".
 *
 * Two independent sources, unioned, because neither covers the other's hole:
 *
 *   1. **Ignored AND untracked, UNDER THE TOOLING ROOT** (`disowned-paths.mjs`,
 *      scoped to `scripts/.claude-skills/**`) — the tree a consumer gitignores.
 *      Says nothing about surfaces a consumer COMMITS, and nothing about
 *      anything outside that root: a consumer's own gitignored build output is
 *      theirs, not ours (upstream ad8fcbd3).
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
 * **That sentence was true and the code contradicted it** until 2026-09-04
 * (upstream ad8fcbd3). It is left standing, rather than softened, because it
 * states the invariant correctly and the defect was that nothing compared the
 * claim to the returned value — a docstring naming the failure mode it then
 * commits is precisely the shape review does not catch. The union is now
 * asymmetric on purpose: the sidecar is an ALLOWLIST and is authoritative
 * everywhere, while git-ignore state is a heuristic trusted only inside
 * `scripts/.claude-skills/**`.
 *
 * @module scripts/lib/upstream-ownership
 */
import fs from 'node:fs';
import path from 'node:path';

import { ignoredUntrackedPaths } from './disowned-paths.mjs';
import {
  isUsableSidecar, comparisonKey, OWNED_SIDECAR_RELATIVE_PATH,
} from './sync-owned-sidecar.mjs';
import { LAYOUT_CONSTANTS } from './sync-path-map.mjs';

/**
 * The one prefix the git-ignore half may speak about, derived from the layout
 * oracle rather than spelled here — `sync-path-map.mjs` is the single source of
 * truth for where the sync puts things, and a second hand-typed copy of
 * `scripts/.claude-skills` is exactly the drift that rule exists to prevent.
 */
const TOOLING_PREFIX = `${LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR}/`;

/**
 * Is this path inside the synced tooling tree — the only region where "ignored
 * and untracked" is evidence of UPSTREAM ownership?
 *
 * Compared on the same case-folded reduction the lookups use, because the
 * consumers of this module run on Windows and macOS.
 *
 * @param {string} rel forward-slash repo-relative path
 * @returns {boolean}
 */
function underToolingRoot(rel) {
  return comparisonKey(rel).startsWith(comparisonKey(TOOLING_PREFIX));
}

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
  //
  // SCOPED TO THE TOOLING ROOT (upstream ad8fcbd3, wine-cellar-app, 2026-09-04).
  // Unscoped, this half read "ignored AND untracked" as "upstream-owned", and
  // those are different claims. `disowned-paths.mjs` answers "is this file part
  // of this repo's corpus?" — a generated artifact rightly answers no, and that
  // no was being read as "someone else owns it". Measured in a consumer:
  // 5 of 5 entries the partition excluded were false positives, four of them
  // citing a `public/index.html` rendered from a TRACKED template and gitignored
  // for exactly the reason this repo's own generated-artifact policy prescribes.
  // It is 100% that repo's code, and the report told them to file it at us.
  //
  // The consequence was worse than noise: excluded entries leave the leverage
  // ranking, so two HIGH findings — one about persisting a generated AES key —
  // silently stopped being ranked. That is strictly worse than not partitioning
  // at all, which is why the module docstring's "conservative direction" claim
  // was false as written: over-claiming upstream ownership is the DANGEROUS
  // direction, and this half was doing it.
  const ignoredKeys = new Set(
    [...git.paths].filter((p) => underToolingRoot(p)).map((p) => comparisonKey(p)),
  );
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
  if (git.degraded) blindTo.push(`every gitignored-and-untracked path under ${TOOLING_PREFIX}`);

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
