/**
 * @fileoverview Single source of truth for theme-safety v1 SCOPE — the native form
 * controls both producers target, shared so the static lint (interactive-color-lint)
 * and the runtime check (unadapted-color) can't drift apart (audit M5).
 *
 * @module scripts/lib/visual/theme-safety-scope
 */

/** Native form-control tags the UA styles `color` on directly (v1 scope). */
export const FORM_CONTROL_TAGS = new Set(['button', 'select', 'input', 'textarea']);

/** `<input type>` values that paint user-visible text whose `color` must adapt.
 *  Excludes checkbox/radio/range/color/file/hidden/image/submit-glyph-less etc.
 *  (audit L3 — those don't render adaptable text). Submit/reset/button DO paint a
 *  label. `null`/absent type defaults to `text`. */
export const TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'email', 'url', 'tel', 'password', 'number',
  'date', 'datetime-local', 'month', 'week', 'time',
  'submit', 'reset', 'button',
]);

/** Is this extract node a text-bearing native form control in v1 scope? */
export function isTextBearingFormControl(node) {
  const tag = String(node?.tag || '').toLowerCase();
  if (!FORM_CONTROL_TAGS.has(tag)) return false;
  if (tag === 'input') {
    const t = String(node?.inputType || 'text').toLowerCase();
    return TEXT_INPUT_TYPES.has(t);
  }
  return true;
}

/** Selector-text match for the static lint (can't see `<input type>` from CSS —
 *  a broad `input` match is a documented advisory limit). */
export const CONTROL_SELECTOR_RE = /(^|[\s>+~])(button|select|input|textarea)([\s>+~:.[]|$)|\.btn(\b|[-_])/i;
