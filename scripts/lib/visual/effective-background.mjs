/**
 * @fileoverview Resolve the effective opaque backdrop behind a text node so the
 * contrast tier never reads a `transparent` computed background (plan §2b-G,
 * Gemini-G1 + G2-M1). The ancestor WALK happens in-browser (extract.mjs), which
 * emits a `backgroundStack` — the ordered list of layered background colors from
 * the node outward to <body>. This PURE module only composites that stack:
 *
 *   - blend translucent layers top→down until an opaque layer is reached;
 *   - if the stack bottoms out still translucent (no declared page bg), assume the
 *     UA canvas default (white in light, the emulated dark canvas in dark) rather
 *     than degrading every check to `unverified` (G2-M1);
 *   - if any layer is a gradient/image/unresolvable marker, return `unverified`
 *     so a gateable `contrast_failure` never fires on an unknown backdrop.
 *
 * @module scripts/lib/visual/effective-background
 */
import { parseRgba, composite } from './contrast.mjs';

/** Sentinel a node emits when a background layer is a gradient/image/unresolvable. */
export const UNRESOLVABLE = 'unresolvable';

/** UA canvas defaults per theme (G2-M1). Dark uses a near-black canvas matching
 *  the `prefers-color-scheme: dark` UA canvas. */
const CANVAS = { light: { r: 255, g: 255, b: 255 }, dark: { r: 18, g: 18, b: 18 } };

/**
 * @param {Array<string>} backgroundStack - normalized `r,g,b[,a]` strings or
 *        UNRESOLVABLE, ordered node→body (index 0 = node's own background).
 * @param {{theme?: string}} [opts]
 * @returns {{status:'resolved', color:string} | {status:'unverified', reason:string}}
 */
export function resolveEffectiveBackground(backgroundStack, { theme = 'light' } = {}) {
  const stack = Array.isArray(backgroundStack) ? backgroundStack : [];
  // Accumulate from the bottom UP so we composite correctly: start at the canvas,
  // then paint each layer (body→node) on top. But a gradient/image anywhere in the
  // visible stack means we can't know the true backdrop → unverified.
  if (stack.includes(UNRESOLVABLE)) {
    return { status: 'unverified', reason: 'gradient/image/unresolvable background layer' };
  }

  // Bottom layer = UA canvas default for the theme.
  let acc = CANVAS[theme] || CANVAS.light;
  // Paint body→node (reverse of node→body order), compositing each translucent
  // layer over the accumulated opaque color.
  for (let i = stack.length - 1; i >= 0; i--) {
    const rgba = parseRgba(stack[i]);
    if (!rgba) continue; // unparseable single layer — skip; canvas/lower layers stand
    if (rgba.a <= 0) continue; // fully transparent — no contribution
    acc = composite(rgba, acc);
  }
  return { status: 'resolved', color: `${acc.r},${acc.g},${acc.b}` };
}
