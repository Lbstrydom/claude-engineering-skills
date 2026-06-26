/**
 * @fileoverview The static layer's finding producer (plan §2 decision / M3) — a
 * report-only coherence lint over the token sources, runnable WITHOUT a browser.
 * It's the reason a no-`--verify` run isn't empty. NEVER gate-eligible.
 *
 *   - token_unreferenced       : a declared token var never appears as `var(--x)`
 *                                in the usage corpus (contracted source globs)
 *   - token_undefined_reference: source uses `var(--x)` for a name not in the index
 *
 * (token_duplicate_definition is emitted upstream by tokens.extractAllowedSet as a
 * warning; surfaced here too when passed in.)
 *
 * @module scripts/lib/visual/source-coherence
 */

/**
 * @param {object} args
 * @param {object} args.tokenIndex - from tokens.buildTokenIndex
 * @param {string} [args.usageCorpus] - concatenated contracted source (CSS/TSX) text
 * @param {string[]} [args.duplicateWarnings] - pass-through from token extraction
 * @returns {Array<{class:string, severity:'info', detail:string}>}
 */
export function runSourceCoherence({ tokenIndex, usageCorpus = '', duplicateWarnings = [] } = {}) {
  const out = [];
  const declaredVars = collectVarNames(tokenIndex);

  // Names actually referenced in the corpus.
  const usedVars = new Set();
  for (const m of String(usageCorpus).matchAll(/var\(\s*(--[\w-]+)/g)) usedVars.add(m[1]);

  if (usageCorpus) {
    for (const name of declaredVars) {
      if (!usedVars.has(name)) {
        out.push({ class: 'token_unreferenced', severity: 'info', detail: `declared token ${name} is never referenced via var(${name}) in the contracted source` });
      }
    }
    for (const name of usedVars) {
      if (!declaredVars.has(name)) {
        out.push({ class: 'token_undefined_reference', severity: 'info', detail: `source references var(${name}) but it is not defined in any declared token source` });
      }
    }
  }

  for (const w of duplicateWarnings) {
    if (typeof w === 'string' && w.startsWith('token_duplicate_definition')) {
      out.push({ class: 'token_duplicate_definition', severity: 'info', detail: w });
    }
  }
  return out;
}

function collectVarNames(tokenIndex) {
  const names = new Set();
  const families = tokenIndex?.families || {};
  for (const list of Object.values(families)) {
    for (const tok of list || []) if (tok.varName && tok.varName.startsWith('--')) names.add(tok.varName);
  }
  return names;
}
