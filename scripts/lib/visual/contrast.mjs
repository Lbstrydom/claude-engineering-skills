/**
 * @fileoverview WCAG contrast math (plan §2 decision 3, §2b-G) — pure relative
 * luminance + ratio. Used by the contrast tier ONLY where the backdrop is
 * deterministically solid (see effective-background.mjs). Hard test-first.
 *
 * @module scripts/lib/visual/contrast
 */

/**
 * Parse a normalized `r,g,b[,a]` string (tokens.normalizeColor output) into rgba.
 * @param {string} norm
 * @returns {{r:number,g:number,b:number,a:number}|null}
 */
export function parseRgba(norm) {
  if (typeof norm !== 'string') return null;
  const parts = norm.split(',').map((p) => parseFloat(p.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) return null;
  const a = parts.length >= 4 && !Number.isNaN(parts[3]) ? parts[3] : 1;
  return { r: parts[0], g: parts[1], b: parts[2], a };
}

/**
 * Alpha-composite `fg` over an OPAQUE `bg` (a=1 assumed for bg).
 * @param {{r:number,g:number,b:number,a:number}} fg
 * @param {{r:number,g:number,b:number}} bg
 * @returns {{r:number,g:number,b:number}}
 */
export function composite(fg, bg) {
  const a = clamp01(fg.a ?? 1);
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
  };
}

/** WCAG relative luminance of an opaque sRGB color (0..1). */
export function relativeLuminance({ r, g, b }) {
  const [R, G, B] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/**
 * WCAG contrast ratio between two opaque colors (1..21).
 * @param {{r:number,g:number,b:number}} c1
 * @param {{r:number,g:number,b:number}} c2
 * @returns {number}
 */
export function contrastRatio(c1, c2) {
  const l1 = relativeLuminance(c1);
  const l2 = relativeLuminance(c2);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
}

/**
 * Compute the effective contrast ratio of normalized foreground text over a
 * resolved opaque backdrop. Returns null when either side can't be parsed.
 * @param {string} fgNorm - normalized `r,g,b[,a]`
 * @param {string} bgNorm - normalized OPAQUE `r,g,b`
 * @returns {number|null}
 */
export function textContrast(fgNorm, bgNorm) {
  const fg = parseRgba(fgNorm);
  const bg = parseRgba(bgNorm);
  if (!fg || !bg) return null;
  const composed = composite(fg, { r: bg.r, g: bg.g, b: bg.b });
  return contrastRatio(composed, { r: bg.r, g: bg.g, b: bg.b });
}

function clamp01(n) { return Math.max(0, Math.min(1, n)); }
