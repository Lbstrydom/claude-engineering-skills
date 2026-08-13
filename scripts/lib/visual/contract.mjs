/**
 * @fileoverview The committed `visual-contract.json` reader/writer + first-run
 * bootstrap skeleton (plan §2 decision 6, §2a-A). Product intent — contracted
 * surfaces, token sources, themes, gate scope — lives in this tiny central file;
 * the observed allowed-set + live findings are tool-generated elsewhere and
 * gitignored.
 *
 * Mirrors scripts/lib/nav/contract.mjs: STRICT schema (typos fail loudly), atomic
 * writes, never clobbers an existing contract without `force`.
 *
 * @module scripts/lib/visual/contract
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../file-io.mjs';
import { VisualContractSchema, CONTRACT_FILE } from './schema.mjs';

/**
 * Cross-field semantic validation beyond the Zod schema — shared by
 * `readContract()` and `writeContract()` so the two boundaries can never
 * diverge (plan: docs/plans/visual-contract-semantic-validation.md).
 *
 * The theme-reference check is never gated by `requireSourceGlobs` — it is
 * a referential-integrity invariant with no legitimate exception, unlike
 * sourceGlobs completeness which a review-queue draft cannot yet satisfy.
 *
 * @param {object} data - schema-valid VisualContract data
 * @param {{requireSourceGlobs?: boolean}} [opts]
 * @returns {string|null} the first violation found, or null if valid
 */
function validateContractSemantics(data, { requireSourceGlobs = true } = {}) {
  const themeNames = new Set(data.themes.map((t) => t.name));
  for (const ts of data.tokenSources) {
    if (ts.theme && !themeNames.has(ts.theme)) {
      return `tokenSource '${ts.path}' references theme '${ts.theme}' not declared in themes[] (have: ${[...themeNames].join(', ') || 'none'})`;
    }
  }
  if (requireSourceGlobs) {
    for (const s of data.surfaces) {
      if (!s.sourceGlobs || s.sourceGlobs.length === 0) {
        return `surface '${s.id}' has no sourceGlobs — every surface must declare at least one sourceGlob to be gate-attributable`;
      }
    }
  }
  return null;
}

/**
 * Read + validate the committed visual-contract.json.
 * @param {string} root
 * @returns {{contract: object|null, present: boolean, error: string|null}}
 */
export function readContract(root) {
  const file = path.join(root, CONTRACT_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return { contract: null, present: false, error: null };
    return { contract: null, present: false, error: `contract unreadable: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { contract: null, present: true, error: `contract malformed JSON: ${err.message}` };
  }
  const result = VisualContractSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path?.length ? ` at ${issue.path.join('.')}` : '';
    return { contract: null, present: true, error: `contract failed schema${where}: ${issue?.message ?? 'invalid'}` };
  }
  const data = result.data;
  const semanticError = validateContractSemantics(data);
  if (semanticError) {
    return { contract: null, present: true, error: semanticError };
  }
  return { contract: data, present: true, error: null };
}

/**
 * Does a contract file exist on disk?
 * @param {string} root
 * @returns {boolean}
 */
// @duplicate-justification: target=scripts/lib/nav/contract.mjs:contractExists reason=nav-audit and visual-audit are a deliberately independent "sister lens" pair (AGENTS.md skill-naming-convention note) -- zero existing nav<->visual imports today, not accidental duplication
export function contractExists(root) {
  return fs.existsSync(path.join(root, CONTRACT_FILE));
}

/**
 * Build a review-queue skeleton contract (plan §2a-A `--bootstrap`). Every field
 * is a placeholder the operator must review; `_note` flags it as unreviewed.
 * @param {object} [opts]
 * @param {string[]} [opts.surfaceSelectors] - draft surface selectors (e.g. from --from-url)
 * @returns {object} a VisualContract-shaped object
 */
export function bootstrapContract({ surfaceSelectors = [] } = {}) {
  const selectors = surfaceSelectors.length ? surfaceSelectors : ['main'];
  return {
    version: 1,
    _note: 'REVIEW QUEUE — drafted by `visual-audit --bootstrap`. Fill sourceGlobs, '
      + 'confirm surfaces/selectors, declare token sources + themes, then remove this note.',
    surfaces: selectors.map((selector, i) => ({
      id: `surface-${i + 1}`,
      label: selector,
      selector,
      sourceGlobs: [],
      excludeSelectors: [],
      allowOverlapWith: [],
      nodeBudget: 400,
      interactiveBudget: 120,
    })),
    tokenSources: [],
    themes: [],
    globalStyleGlobs: [],
    tolerances: { geometryPx: 1, contrastRatio: 4.5 },
    propertyPolicy: {
      tokenAudited: ['colors', 'spacing', 'radius', 'borderWidth', 'fontSize', 'lineHeight', 'fontWeight', 'shadow'],
      mustMatchGeometry: ['width', 'height', 'flex-basis', 'grid-template', 'padding', 'margin'],
    },
  };
}

/**
 * Persist a contract. Refuses to overwrite an existing file unless `force`.
 *
 * `allowDraft` relaxes ONLY the sourceGlobs-completeness invariant (for the
 * `--bootstrap` review-queue skeleton, which cannot satisfy it yet) — the
 * theme-reference referential-integrity check always runs and can always
 * reject the write, regardless of `allowDraft`.
 *
 * @param {string} root
 * @param {object} contract
 * @param {{force?: boolean, allowDraft?: boolean}} [opts]
 * @returns {{ok: boolean, path: string, error?: string}}
 */
export function writeContract(root, contract, { force = false, allowDraft = false } = {}) {
  const file = path.join(root, CONTRACT_FILE);
  // NOTE: deliberately NOT `if (!force && existsSync(file)) return`. That was a
  // time-of-check/time-of-use race against the advertised no-clobber guarantee:
  // another process (a concurrent `--bootstrap`, a second session in a shared
  // tree) could create the contract between the check and the write, and the
  // rename-based atomic write would then silently replace it. The exclusive
  // write below asks the filesystem instead, so there is no window. The early
  // return survives only as a cheap, non-authoritative fast path for the common
  // case — the EEXIST handler at the write is what actually enforces it.
  if (!force && fs.existsSync(file)) {
    return { ok: false, path: file, error: `${CONTRACT_FILE} already exists — pass force to replace` };
  }
  // Validate before writing so we never persist an invalid contract.
  const result = VisualContractSchema.safeParse(contract);
  if (!result.success) {
    return { ok: false, path: file, error: `refusing to write invalid contract: ${result.error.issues[0]?.message ?? 'invalid'}` };
  }
  const semanticError = validateContractSemantics(result.data, { requireSourceGlobs: !allowDraft });
  if (semanticError) {
    return { ok: false, path: file, error: `refusing to write semantically invalid contract: ${semanticError}` };
  }
  // Persist the validated, Zod-normalized result — not the raw caller-owned
  // `contract` object — so what's on disk is exactly what was validated
  // (defaults applied, unknown-key stripping already enforced by `.strict()`).
  try {
    atomicWriteFileSync(file, `${JSON.stringify(result.data, null, 2)}\n`, { exclusive: !force });
  } catch (err) {
    // The authoritative no-clobber answer: another writer won the race between
    // the fast-path check above and this write.
    if (err.code === 'EEXIST') {
      return { ok: false, path: file, error: `${CONTRACT_FILE} already exists — pass force to replace` };
    }
    throw err;
  }
  return { ok: true, path: file };
}
