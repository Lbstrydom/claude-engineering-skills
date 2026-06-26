/**
 * @fileoverview Declared-token extraction — the static spine (plan §2 decision 2,
 * §2a TIER 1, §2b-D). Parses the app's declared design scale from its token
 * SOURCES into an allowed-set + a `TokenIndex` (value → token metadata), so the
 * live layer can reconcile computed values against *declared intent* rather than
 * guessing. Inferred clustering is the noisy fallback for token-less apps —
 * report-only, never gating.
 *
 * Adapter registry (strategy-over-switch, plan §6 seam): a new token source =
 * one new adapter. v1 sources (plan §2a tokens.mjs / M1):
 *   - css-vars : `:root { --x: v }` custom properties (+ scoped/theme blocks)
 *   - json     : a plain / Style-Dictionary tokens.json
 *   - tailwind : JS/CJS/MJS configs ONLY (a .ts config is NOT executed by this
 *                plain-ESM tool → warning + require a generated json)
 *
 * Also exports normalization helpers (normalizeColor/normalizeLength) reused by
 * reconcile-tokens.mjs + theme-parity.mjs so the canonical-value space is shared.
 *
 * @module scripts/lib/visual/tokens
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TOKEN_FAMILIES } from './schema.mjs';

const REM_PX = 16; // canonical rem→px base for reconciling rem tokens vs computed px

// ── Normalization (shared canonical-value space) ────────────────────────────

/**
 * Canonicalize a color string to `r,g,b` or `r,g,b,a` (a in [0,1], 3dp). Returns
 * null when not a recognizable color (so callers can skip rather than guess).
 * @param {string} input
 * @returns {string|null}
 */
export function normalizeColor(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (!s || s === 'transparent') return s === 'transparent' ? '0,0,0,0' : null;

  // #rgb / #rgba / #rrggbb / #rrggbbaa
  const hex = s.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    if (h.length === 8) {
      const a = +(parseInt(h.slice(6, 8), 16) / 255).toFixed(3);
      return `${r},${g},${b},${a}`;
    }
    return `${r},${g},${b}`;
  }

  // rgb()/rgba()
  const rgb = s.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) {
    const parts = rgb[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const [r, g, b] = parts.slice(0, 3).map((p) => Math.round(parseFloat(p)));
    if ([r, g, b].some((n) => Number.isNaN(n))) return null;
    if (parts.length >= 4) {
      const a = +parseFloat(parts[3]).toFixed(3);
      return Number.isNaN(a) ? `${r},${g},${b}` : `${r},${g},${b}${a >= 1 ? '' : `,${a}`}`;
    }
    return `${r},${g},${b}`;
  }
  return null;
}

/**
 * Canonicalize a CSS length to a px number string (rounded to 0.1px). rem/em are
 * converted at the canonical 16px base. Returns null for non-lengths (auto, %, …).
 * @param {string|number} input
 * @returns {string|null}
 */
export function normalizeLength(input) {
  if (typeof input === 'number') return `${round1(input)}px`;
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  const m = s.match(/^(-?[\d.]+)(px|rem|em)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (Number.isNaN(n)) return null;
  const unit = m[2] || 'px';
  const px = unit === 'px' ? n : n * REM_PX;
  return `${round1(px)}px`;
}

/** Canonicalize a unitless or px value by family (colors→color, lengths→px,
 *  fontWeight→integer, shadow→trimmed lowercase). */
export function normalizeByFamily(family, value) {
  if (value == null) return null;
  if (family === 'colors') return normalizeColor(String(value));
  if (family === 'fontWeight') {
    const map = { normal: '400', bold: '700' };
    const v = String(value).trim().toLowerCase();
    return map[v] || (/^\d+$/.test(v) ? v : null);
  }
  if (family === 'shadow') return String(value).trim().toLowerCase().replace(/\s+/g, ' ') || null;
  // spacing/radius/borderWidth/fontSize/lineHeight are lengths (lineHeight may be unitless)
  if (family === 'lineHeight' && /^[\d.]+$/.test(String(value).trim())) return String(parseFloat(value));
  return normalizeLength(value);
}

function round1(n) { return Math.round(n * 10) / 10; }

// ── Adapter registry ────────────────────────────────────────────────────────

const LENGTH_RE = /^-?[\d.]+(px|rem|em)$/;

/** Heuristic family for a CSS custom-property name + value. */
function familyForVar(name, value) {
  const n = name.toLowerCase();
  const isLength = LENGTH_RE.test(String(value).trim());
  if (normalizeColor(value)) return 'colors';
  if (/radius|rounded/.test(n)) return 'radius';
  if (/shadow|elevation/.test(n)) return 'shadow';
  if (/font-?weight|weight/.test(n)) return 'fontWeight';
  if (/line-?height|leading/.test(n)) return 'lineHeight';
  if (/font-?size|text-?size/.test(n)) return 'fontSize';
  // A `--font-*` / `--text-*` / `--*-font-*` token whose VALUE is a length is a
  // font SIZE — apps name the type scale `--font-sm`/`--btn-font-lg` without the
  // literal "size" (shakedown #1: 260 on-scale sizes were misfiled as spacing).
  // Weight (unitless) + lineHeight already matched above; font-family is non-length.
  if (isLength && /\bfont\b|font-|text-|\btext\b/.test(n)) return 'fontSize';
  if (/border|stroke/.test(n)) return 'borderWidth';
  if (/space|spacing|gap|margin|padding|\bpad\b|inset/.test(n)) return 'spacing';
  if (isLength) return 'spacing';
  return null;
}

const cssVarsAdapter = {
  type: 'css-vars',
  detect: (p) => /\.css$/i.test(p),
  extract(absPath, theme) {
    const out = { values: {}, warnings: [] };
    let css;
    try { css = fs.readFileSync(absPath, 'utf-8'); }
    catch (err) { out.warnings.push(`css-vars: cannot read ${absPath}: ${err.message}`); return out; }
    // Match every `--name: value;` declaration (across :root and scoped blocks).
    const re = /(--[\w-]+)\s*:\s*([^;}{]+)[;}]/g;
    let m;
    while ((m = re.exec(css))) {
      const name = m[1].trim();
      const value = m[2].trim();
      if (value.startsWith('var(')) continue; // alias — resolved transitively below
      const fam = familyForVar(name, value);
      if (!fam) continue;
      pushToken(out.values, fam, { value, varName: name, theme: theme ?? null });
    }
    return out;
  },
};

const jsonAdapter = {
  type: 'json',
  detect: (p) => /\.json$/i.test(p),
  extract(absPath, theme) {
    const out = { values: {}, warnings: [] };
    let data;
    try { data = JSON.parse(fs.readFileSync(absPath, 'utf-8')); }
    catch (err) { out.warnings.push(`json: cannot read/parse ${absPath}: ${err.message}`); return out; }
    // Walk: a key matching a family contributes its leaf values to that family.
    // Style-Dictionary `{ value }` leaves are unwrapped.
    walkJson(data, null, out.values, theme ?? null);
    return out;
  },
};

const tailwindAdapter = {
  type: 'tailwind',
  detect: (p) => /tailwind\.config\.(c?js|mjs|ts)$/i.test(p),
  async extract(absPath, theme) {
    const out = { values: {}, warnings: [] };
    if (/\.ts$/i.test(absPath)) {
      out.warnings.push(`tailwind: ${path.basename(absPath)} is a TS config — this plain-ESM tool will not execute it; point tokenSources at a generated tokens.json (e.g. \`npx tailwindcss --dump\` / Style-Dictionary).`);
      return out;
    }
    let mod;
    try { mod = await import(pathToFileURL(absPath).href); }
    catch (err) { out.warnings.push(`tailwind: cannot import ${absPath}: ${err.message}`); return out; }
    const cfg = mod?.default ?? mod;
    const theme1 = { ...(cfg?.theme ?? {}), ...(cfg?.theme?.extend ?? {}) };
    const MAP = {
      colors: 'colors', spacing: 'spacing', padding: 'spacing', margin: 'spacing', gap: 'spacing',
      borderRadius: 'radius', borderWidth: 'borderWidth', fontSize: 'fontSize',
      lineHeight: 'lineHeight', fontWeight: 'fontWeight', boxShadow: 'shadow',
    };
    for (const [twKey, fam] of Object.entries(MAP)) {
      const group = theme1[twKey];
      if (group && typeof group === 'object') flattenTwGroup(group, fam, out.values, theme ?? null);
    }
    return out;
  },
};

export const TOKEN_ADAPTERS = [cssVarsAdapter, jsonAdapter, tailwindAdapter];

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract the allowed-set + TokenIndex from a contract's tokenSources.
 * @param {string} root - repo root (token-source paths are resolved against it)
 * @param {object} contract - parsed visual-contract.json
 * @returns {Promise<{allowedSet: object, tokenIndex: object, warnings: string[]}>}
 */
export async function extractAllowedSet(root, contract) {
  const sources = Array.isArray(contract?.tokenSources) ? contract.tokenSources : [];
  const families = {};        // family → [{ value(normalized), varName, sourceFile, theme }]
  const warnings = [];
  const seen = new Map();     // `${family}:${value}:${theme}` → first source (dup diagnostics)

  for (const src of sources) {
    const adapter = TOKEN_ADAPTERS.find((a) => a.type === src.type) || TOKEN_ADAPTERS.find((a) => a.detect(src.path));
    if (!adapter) { warnings.push(`no adapter for token source ${src.path} (type=${src.type})`); continue; }
    const abs = path.resolve(root, src.path);
    const res = await adapter.extract(abs, src.theme);
    warnings.push(...res.warnings);
    const scope = Array.isArray(src.families) && src.families.length ? new Set(src.families) : null;
    for (const [fam, list] of Object.entries(res.values)) {
      if (scope && !scope.has(fam)) continue;
      for (const tok of list) {
        const norm = normalizeByFamily(fam, tok.value);
        if (norm == null) continue;
        const dupKey = `${fam}:${norm}:${tok.theme ?? ''}`;
        if (seen.has(dupKey)) {
          warnings.push(`token_duplicate_definition: ${fam} value ${norm}${tok.theme ? ` (theme ${tok.theme})` : ''} defined in both ${seen.get(dupKey)} and ${src.path}`);
          continue;
        }
        seen.set(dupKey, src.path);
        (families[fam] ||= []).push({ value: norm, varName: tok.varName ?? null, sourceFile: src.path, theme: tok.theme ?? null });
      }
    }
  }

  const inferredMode = sources.length === 0 || Object.keys(families).length === 0;
  const allowedSet = { families, inferredMode, warnings };
  const tokenIndex = buildTokenIndex(families);
  return { allowedSet, tokenIndex, warnings };
}

/**
 * Build a TokenIndex for fast membership + provenance lookup (plan §2b-D).
 * @param {Record<string, Array<{value:string,varName:string|null,theme:string|null}>>} families
 * @returns {{has: (family:string, value:string, theme?:string|null)=>boolean, varFor: (family:string, value:string)=>string|null, families: object}}
 */
export function buildTokenIndex(families) {
  const byKey = new Map(); // `${family}:${value}` → { themes:Set, varName }
  for (const [fam, list] of Object.entries(families || {})) {
    for (const tok of list) {
      const k = `${fam}:${tok.value}`;
      const e = byKey.get(k) || { themes: new Set(), varName: tok.varName };
      if (tok.theme) e.themes.add(tok.theme);
      if (!e.varName && tok.varName) e.varName = tok.varName;
      byKey.set(k, e);
    }
  }
  return {
    families,
    has(family, value, theme = null) {
      const e = byKey.get(`${family}:${value}`);
      if (!e) return false;
      // A theme-scoped token only counts for its theme (or theme-agnostic tokens).
      if (theme && e.themes.size && !e.themes.has(theme)) return false;
      return true;
    },
    varFor(family, value) {
      return byKey.get(`${family}:${value}`)?.varName ?? null;
    },
  };
}

/**
 * Inferred clustering fallback (plan §2 decision 2) — for token-less apps. Returns
 * report-only outlier candidates: per family, values used by <`minorityFrac` of
 * nodes when a dominant cluster exists. NEVER gate-eligible.
 * @param {Array<{family:string, value:string}>} observedValues
 * @param {{minorityFrac?:number, dominanceFrac?:number}} [opts]
 * @returns {Array<{family:string, value:string, share:number}>}
 */
export function inferClusters(observedValues, { minorityFrac = 0.1, dominanceFrac = 0.6 } = {}) {
  const byFamily = new Map();
  for (const o of observedValues || []) {
    const norm = normalizeByFamily(o.family, o.value);
    if (norm == null) continue;
    const m = byFamily.get(o.family) || new Map();
    m.set(norm, (m.get(norm) || 0) + 1);
    byFamily.set(o.family, m);
  }
  const out = [];
  for (const [family, counts] of byFamily) {
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    if (total < 5) continue; // too few to infer a scale
    const max = Math.max(...counts.values());
    if (max / total < dominanceFrac) continue; // no dominant cluster → don't flag
    for (const [value, n] of counts) {
      const share = n / total;
      if (share <= minorityFrac && value !== undefined) out.push({ family, value, share: +share.toFixed(3) });
    }
  }
  return out;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function pushToken(values, family, tok) {
  (values[family] ||= []).push(tok);
}

function walkJson(node, keyHint, values, theme, depth = 0) {
  if (depth > 12 || node == null) return;
  // Style-Dictionary leaf: { value: '...' }
  if (typeof node === 'object' && !Array.isArray(node) && 'value' in node && typeof node.value !== 'object') {
    const fam = familyForKey(keyHint) || familyForVar(keyHint || '', node.value);
    if (fam) pushToken(values, fam, { value: String(node.value), varName: keyHint, theme });
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) walkJson(v, keyHint, values, theme, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const fam = familyForKey(k);
      if (fam && (typeof v === 'string' || typeof v === 'number')) {
        pushToken(values, fam, { value: String(v), varName: k, theme });
      } else {
        walkJson(v, familyForKey(k) ? k : keyHint, values, theme, depth + 1);
      }
    }
    return;
  }
  // primitive under a family-keyed parent
  if (keyHint && (typeof node === 'string' || typeof node === 'number')) {
    const fam = familyForKey(keyHint);
    if (fam) pushToken(values, fam, { value: String(node), varName: keyHint, theme });
  }
}

const FAMILY_KEYS = {
  colors: 'colors', color: 'colors',
  spacing: 'spacing', space: 'spacing', padding: 'spacing', margin: 'spacing', gap: 'spacing',
  radius: 'radius', borderradius: 'radius', rounded: 'radius',
  borderwidth: 'borderWidth', border: 'borderWidth',
  fontsize: 'fontSize', fontsizes: 'fontSize', text: 'fontSize',
  lineheight: 'lineHeight', leading: 'lineHeight',
  fontweight: 'fontWeight', fontweights: 'fontWeight', weight: 'fontWeight',
  shadow: 'shadow', boxshadow: 'shadow', shadows: 'shadow', elevation: 'shadow',
};

function familyForKey(k) {
  if (!k) return null;
  const n = String(k).toLowerCase().replace(/[-_\s]/g, '');
  return FAMILY_KEYS[n] || (TOKEN_FAMILIES.includes(k) ? k : null);
}

function flattenTwGroup(group, family, values, theme, varHint = '') {
  for (const [k, v] of Object.entries(group)) {
    const name = varHint ? `${varHint}-${k}` : k;
    if (typeof v === 'string' || typeof v === 'number') {
      pushToken(values, family, { value: String(v), varName: name, theme });
    } else if (Array.isArray(v)) {
      // fontSize can be [size, {lineHeight}] — first element is the size
      if (v.length) pushToken(values, family, { value: String(v[0]), varName: name, theme });
    } else if (v && typeof v === 'object') {
      flattenTwGroup(v, family, values, theme, name);
    }
  }
}
