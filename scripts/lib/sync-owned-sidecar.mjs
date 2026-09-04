/**
 * @fileoverview `scripts/.sync-owned.json` — the COMMITTED answer to "is this
 * file mine to fix, or upstream's?".
 *
 * **Why a second file next to the manifest.** Ownership of a synced path is
 * knowable three ways, and each has a hole:
 *
 *   - **Git-ignore state.** Works for `scripts/.claude-skills/**`, which is
 *     gitignored in a consumer. Says nothing about `.claude/hooks/**` and
 *     `.claude/skills/**`, which consumers COMMIT.
 *   - **The content banner** (`sync-banner.mjs`). Works for most payload, but a
 *     `SKILL.md` cannot carry one — YAML frontmatter has to be the first bytes
 *     of the file — and the hooks do not carry one either. Verified against a
 *     live consumer 2026-09-04: neither surface had a banner.
 *   - **`scripts/.sync-manifest.json`.** Covers everything, and is *gitignored
 *     in both source and consumers* (deliberately — its timestamp + HEAD sha
 *     made it churn on every push). So it is absent from every fresh clone,
 *     which is to say from CI.
 *
 * The union of those holes is real and was measured: a consumer's own
 * duplication-policy verifier reported **32 violations and 1 mixed-owner triage
 * with the manifest absent, and 31 / 0 with it present** — the extra violation
 * being this bundle's own `readStdin` cluster across three of its hooks,
 * reported to the consumer as their problem to fix. They cannot fix it.
 *
 * **Why it does not simply un-gitignore the manifest.** The manifest carries a
 * `generatedAt` timestamp and a source `commitSha`, so committing it puts a
 * dirty file in the tree after every sync — the churn the generated-artifact
 * policy (AGENTS.md, category A) exists to keep out. This sidecar carries the
 * path SET and nothing else: no digests, no clock, no sha. It changes only when
 * the set of managed paths changes, which is a real and reviewable event, and
 * two runs of one sync produce byte-identical output. That makes it a
 * category-B artifact — committed, and a pure function of what was synced.
 *
 * @module scripts/lib/sync-owned-sidecar
 */

/** Where the sidecar lands in a consumer, relative to the consumer root. */
export const OWNED_SIDECAR_RELATIVE_PATH = 'scripts/.sync-owned.json';

/** Bumped when the SHAPE changes, so a reader can refuse an unknown one. */
export const OWNED_SIDECAR_VERSION = 1;

/**
 * Build the sidecar document from the destination paths a sync wrote.
 *
 * Deterministic by construction: separators normalised, duplicates removed,
 * sorted by the same case-folded key the comparison contract advertises. A
 * committed artifact that reordered between runs would be churn with no
 * information in it.
 *
 * @param {string[]} destPaths - consumer-root-relative destination paths
 * @param {{repo?: string}} [opts]
 * @returns {{version: number, source: string, comparison: string, note: string, paths: string[]}}
 */
export function buildOwnedSidecar(destPaths, { repo = 'Lbstrydom/claude-engineering-skills' } = {}) {
  const seen = new Map();
  // Sort BEFORE de-duplicating (audit R5 L1). Two paths differing only in case
  // collapse to one entry, and "first spelling wins" made WHICH spelling
  // survives a function of input order — so two builds of the same set could
  // differ, in a file whose entire justification is that they cannot. The
  // suite's determinism test passed only because its fixture had no
  // case-equivalent pair: a vacuous green. Sorting first makes the retained
  // spelling a property of the SET, not of the walk that produced it.
  const candidates = (Array.isArray(destPaths) ? destPaths : [])
    .filter((p) => typeof p === 'string' && p.length > 0)
    .map((p) => p.split('\\').join('/').replace(/^\.\//, ''))
    .sort();
  for (const normalised of candidates) {
    const key = normalised.toLowerCase();
    if (!seen.has(key)) seen.set(key, normalised);
  }
  return {
    version: OWNED_SIDECAR_VERSION,
    source: repo,
    // Load-bearing, and stated in the artifact rather than assumed by each
    // reader: a consumer's debt ledger cited `.claude/skills/*/skill.md` while
    // the manifest spelled `SKILL.md`, and six upstream-owned entries were
    // classified as the consumer's own work until the comparison was
    // case-folded. Windows and macOS filesystems are case-insensitive; the
    // paths below are recorded in their true case, and MUST be compared
    // case-insensitively.
    comparison: 'case-insensitive',
    note: 'Files listed here are maintained upstream. Do not patch them locally — '
      + 'a local edit is overwritten by the next sync and leaves the bug live for every other '
      + 'consumer. Report it instead: node scripts/.claude-skills/cross-skill.mjs upstream report '
      + '--affected-path <path>.',
    paths: [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, v]) => v),
  };
}

/**
 * Is `relPath` upstream-owned according to a loaded sidecar?
 *
 * Exported so a consumer-side gate has one predicate to call rather than
 * re-deriving the case rule — the drift that produced this file in the first
 * place. An unrecognised or malformed sidecar answers `false` (not owned),
 * because over-claiming ownership silently excuses a consumer's own defects.
 *
 * @param {{version?: number, paths?: string[]}|null} sidecar
 * @param {string} relPath
 * @returns {boolean}
 */
/**
 * The ONE spelling both sides of a path comparison must be reduced to.
 *
 * Audit R4 M12: the query side stripped a leading `./` and the stored side did
 * not, so a hand-edited sidecar entry `./a.mjs` never matched a query for
 * `a.mjs`. Normalising one side of a comparison is the recurring shape of this
 * whole change — a check that runs, and answers about something other than
 * what was asked.
 *
 * @param {string} p
 * @returns {string}
 */
export function comparisonKey(p) {
  return p.split('\\').join('/').replace(/^\.\//, '').toLowerCase();
}

/**
 * Is this parsed document one a reader may take answers from? The SINGLE
 * oracle for that question.
 *
 * Four rounds of this audit found the same defect in four places, each time
 * because two functions decided sidecar validity separately and drifted:
 * unsupported version (R2 M13), a non-string entry (R2 M1 — fixed on one side
 * only, re-raised as R3 M6), `./` normalised on one side of the comparison
 * (R4 M12), and finally a DOCUMENT-level disagreement — `isUpstreamOwned`
 * reading the valid entries out of a half-malformed `paths` array while
 * `upstream-ownership.mjs` rejected the whole file (R5 M3/M14). Every
 * individual fix was correct and none of them closed the class, because the
 * class was TWO PREDICATES, not one bad predicate.
 *
 * Validity is ALL-OR-NOTHING deliberately: a `paths` array with a bad entry is
 * a corrupt committed artifact, and answering from the entries that happen to
 * parse is how a partially-broken file yields confidently partial answers.
 *
 * @param {object|null|undefined} sidecar
 * @returns {boolean}
 */
export function isUsableSidecar(sidecar) {
  if (!sidecar || sidecar.version !== OWNED_SIDECAR_VERSION) return false;
  if (!Array.isArray(sidecar.paths)) return false;
  return sidecar.paths.every((p) => typeof p === 'string');
}

export function isUpstreamOwned(sidecar, relPath) {
  if (!isUsableSidecar(sidecar)) return false;
  if (typeof relPath !== 'string' || relPath.length === 0) return false;
  const key = comparisonKey(relPath);
  return sidecar.paths.some((p) => comparisonKey(p) === key);
}
