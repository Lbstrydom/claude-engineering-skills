/**
 * @fileoverview Dashboard render helpers — the ONLY module that defines
 * `escapeHtml`, `jsonScriptSafe`, panels + tab/status markup.
 *
 * Plan: docs/plans/sustainability-cleanup-batch.md (WS2).
 *
 * Imported only by `render.mjs` (orchestrator); section modules under
 * `sections/` receive these helpers via the `ui` argument from the
 * orchestrator — NEVER import this file directly. Enforced by
 * `tests/dashboard-section-contract.test.mjs`.
 *
 * @module scripts/lib/dashboard/helpers
 */

// ── Encoders (mandatory — see plan §4) ───────────────────────────────────

/**
 * HTML-escape a value for element content or a double-quoted attribute.
 * @param {unknown} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Serialize an object for embedding inside a `<script type="application/json">`
 * block. Escapes `<` `>` `&` and the U+2028/U+2029 line separators so the
 * literal `</script>` can never close the block and the JSON survives HTML
 * parsing.
 *
 * Note: <U+2028> and <U+2029> are JS *line terminators* and cannot appear
 * literally inside a regex source — use the explicit \u-escape form.
 *
 * @param {unknown} obj
 * @returns {string}
 */
export function jsonScriptSafe(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// ── Small markup helpers ─────────────────────────────────────────────────

/** Statuses that warrant the warning-panel treatment (vs ok / missing-optional). */
export const NON_OK = new Set(['invalid', 'unexpected-error']);

export function statusDot(status) {
  if (status === 'ok') return '<span class="status-dot status-ok"></span>';
  if (status === 'missing-optional') return '<span class="status-dot status-warn"></span>';
  return '<span class="status-dot status-err"></span>';
}

/** A visible warning panel for an `invalid` / `unexpected-error` source. */
export function warningPanel(name, src) {
  return `<div class="panel warn-panel">
    <p class="warn-title">${statusDot(src.status)}Source "${escapeHtml(name)}" is ${escapeHtml(src.status)}</p>
    <p class="empty">${escapeHtml(src.detail || 'No detail provided.')}</p>
  </div>`;
}

/** An empty-state panel. */
export function emptyPanel(testId, msg) {
  const id = testId ? ` data-testid="${escapeHtml(testId)}"` : '';
  return `<div class="panel empty"${id}>${escapeHtml(msg)}</div>`;
}

export function tab(id, label, selected) {
  return `<button role="tab" id="tab-${escapeHtml(id)}" aria-controls="panel-${escapeHtml(id)}" `
    + `aria-selected="${selected ? 'true' : 'false'}" tabindex="${selected ? '0' : '-1'}">`
    + `${escapeHtml(label)}</button>`;
}

export function panel(id, selected, inner) {
  return `<div role="tabpanel" id="panel-${escapeHtml(id)}" aria-labelledby="tab-${escapeHtml(id)}"`
    + `${selected ? '' : ' hidden'}>${inner}</div>`;
}

/**
 * Split a usage line — `<command>  — <description>` (or `… # comment`) — into
 * its two parts, so the card can render the command + description as a
 * wrapping list instead of a single clipped line.
 */
export function splitUsage(line) {
  const m = String(line).match(/^(.*?)\s+(?:[—–]|#)\s+(.+)$/);
  return m
    ? { cmd: m[1].trim(), desc: m[2].trim() }
    : { cmd: String(line).trim(), desc: '' };
}

/**
 * Build the canonical `ui` object that the orchestrator passes to every
 * section. Frozen so sections can't mutate it accidentally. Exporting a
 * builder (not the literal object) keeps the contract testable without
 * making the bundle part of the public render.mjs surface.
 */
export function buildUi() {
  return Object.freeze({
    escapeHtml,
    warningPanel,
    emptyPanel,
    statusDot,
    tab,
    panel,
    splitUsage,
    NON_OK,
  });
}
