/**
 * @fileoverview The single canonical gate-eligibility contract (plan §2b-H,
 * GPT-R2-H4 + Gemini-G2-2). Every section references THIS — the risk register,
 * §2a-B, and the acceptance tests — so the gate model can't drift across the plan.
 *
 * A finding is gate-eligible iff, on the changed surface:
 *   (a) its surfaceId's sourceGlobs ∩ changedPaths ≠ ∅, OR
 *   (b) contractChanged and the finding's surface is among the changed surfaces, OR
 *   (c) the finding's property family is served by a changed token source, OR
 *   (d) changedPaths ∩ globalStyleGlobs ≠ ∅ — a global stylesheet / shared-ui
 *       component edit cascades into every surface (G2-2: "scope by impact, not
 *       authorship").
 * No merge-base (changedPaths == null) → empty (never false-block).
 *
 * Pure (glob matching is self-contained). Tested: tests/visual-changed-scope.test.mjs.
 *
 * @module scripts/lib/visual/changed-scope
 */
import { TOKEN_FAMILIES } from './schema.mjs';
import { globMatch } from '../glob-match.mjs';

/** Map an audited property/family to its token family for rule (c). */
function familyOfFinding(finding) {
  const p = String(finding?.property || '').toLowerCase();
  if (TOKEN_FAMILIES.includes(p)) return p; // inferred outliers carry the family directly
  if (/color|background/.test(p)) return 'colors';
  if (/radius/.test(p)) return 'radius';
  if (/border.*width|^border-width/.test(p)) return 'borderWidth';
  if (/font-size/.test(p)) return 'fontSize';
  if (/line-height/.test(p)) return 'lineHeight';
  if (/font-weight/.test(p)) return 'fontWeight';
  if (/shadow/.test(p)) return 'shadow';
  if (/padding|margin|gap|width|height|flex|grid/.test(p)) return 'spacing';
  return null;
}

/**
 * @param {object} args
 * @param {Set<string>|string[]|null} args.changedPaths - merge-base diff; null → no scope
 * @param {boolean} [args.contractChanged]
 * @param {string[]} [args.changedTokenFamilies] - families whose token source changed
 * @param {object[]} args.surfaces - contract surfaces ({id, sourceGlobs})
 * @param {string[]} [args.globalStyleGlobs]
 * @param {object[]} args.findings - gate-eligible-class findings to filter
 * @returns {object[]} the subset that should actually block
 */
export function resolveChangedScope({
  changedPaths, allSurfaces = false, contractChanged = false, changedTokenFamilies = [],
  surfaces = [], globalStyleGlobs = [], findings = [],
}) {
  const surfaceById = new Map(surfaces.map((s) => [s.id, s]));

  // `--scope full`: gate the WHOLE contracted surface — every gate-eligible finding
  // attributed to a declared surface blocks (then the baseline ratchet filters it).
  // This is DISTINCT from `changedPaths == null` (no merge-base), which must stay a
  // no-op; conflating the two made `--gate --scope full` silently evaluate nothing.
  if (allSurfaces) return findings.filter((f) => f.surfaceId != null && surfaceById.has(f.surfaceId));

  if (changedPaths == null) return []; // no merge-base → never false-block
  const changed = changedPaths instanceof Set ? changedPaths : new Set(changedPaths);
  const changedArr = [...changed];

  // Rule (d): any global-style edit → all surfaces eligible.
  const globalHit = globalStyleGlobs.some((g) => changedArr.some((p) => globMatch(g, p)));

  const changedFamilies = new Set(changedTokenFamilies);

  return findings.filter((f) => {
    if (globalHit) return true;                                   // (d)
    const surface = f.surfaceId ? surfaceById.get(f.surfaceId) : null;
    if (surface) {
      const globs = surface.sourceGlobs || [];
      if (globs.some((g) => changedArr.some((p) => globMatch(g, p)))) return true; // (a)
      if (contractChanged) return true;                            // (b)
    }
    const fam = familyOfFinding(f);                                // (c)
    if (fam && changedFamilies.has(fam)) return true;
    return false;
  });
}

// Re-exported so existing importers are unaffected. The implementation moved
// out of `visual/` when `security/` began routing on it — a shared decision
// primitive should not live inside one of its two consumers. Note this is an
// import+export, not a bare `export … from`: the two call sites above need the
// binding in local scope.
export { globMatch };
