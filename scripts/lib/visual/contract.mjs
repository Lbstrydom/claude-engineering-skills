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
  // Cross-field validation: every theme referenced by a token source must exist,
  // and every surface needs at least one sourceGlob to be gate-attributable.
  const themeNames = new Set(data.themes.map((t) => t.name));
  for (const ts of data.tokenSources) {
    if (ts.theme && !themeNames.has(ts.theme)) {
      return { contract: null, present: true, error: `tokenSource '${ts.path}' references theme '${ts.theme}' not declared in themes[] (have: ${[...themeNames].join(', ') || 'none'})` };
    }
  }
  return { contract: data, present: true, error: null };
}

/**
 * Does a contract file exist on disk?
 * @param {string} root
 * @returns {boolean}
 */
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
 * @param {string} root
 * @param {object} contract
 * @param {{force?: boolean}} [opts]
 * @returns {{ok: boolean, path: string, error?: string}}
 */
export function writeContract(root, contract, { force = false } = {}) {
  const file = path.join(root, CONTRACT_FILE);
  if (!force && fs.existsSync(file)) {
    return { ok: false, path: file, error: `${CONTRACT_FILE} already exists — pass force to replace` };
  }
  // Validate before writing so we never persist an invalid contract.
  const result = VisualContractSchema.safeParse(contract);
  if (!result.success) {
    return { ok: false, path: file, error: `refusing to write invalid contract: ${result.error.issues[0]?.message ?? 'invalid'}` };
  }
  atomicWriteFileSync(file, `${JSON.stringify(contract, null, 2)}\n`);
  return { ok: true, path: file };
}
