/**
 * @fileoverview Canonical destination-id normalizer (plan §4a.A/§4a.F).
 *
 * A destination's canonical id collapses cosmetic and dynamic variation so
 * `/projects/[id]`, `/projects/:id`, and `/projects/123` map to ONE id
 * (`/projects/:param`) — this is what neutralises the dynamic-route false-positive
 * trap. Adapters own router-specific resolution (relative→absolute, etc.) and
 * call this shared normalizer for the canonical-form rules.
 *
 * @module scripts/lib/nav/normalize
 */

/**
 * @param {string} raw - a route/path string or a view symbol
 * @returns {{ids: string[], confidence: 'high'|'medium'|'low'}}
 *   ids: 1 id normally; 2 when an optional segment yields with/without variants.
 */
export function normalizeDestination(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return { ids: ['<dynamic>'], confidence: 'low' };

  // Fully computed/opaque target (a bare template expression with no static
  // prefix) → opaque, low confidence (excluded from hard-gates by the model).
  // Checked BEFORE the view-symbol branch so `${base}` isn't mistaken for a view.
  if (/^\$\{|^[`'"]?\s*\+/.test(raw)) return { ids: ['<dynamic>'], confidence: 'low' };

  // View-symbol destinations (VIEWS.WINES, 'drink-soon') pass through verbatim —
  // they have no path syntax to normalise.
  if (!raw.includes('/') && !/[[\]:*().${}]/.test(raw)) {
    return { ids: [raw.trim()], confidence: 'high' };
  }

  let p = raw.trim();
  let confidence = 'high';

  // Detect an optional dynamic segment BEFORE stripping query (its trailing `?`
  // otherwise looks like a query delimiter): React `:id?` or Next `[[id]]`.
  const optional = /:[A-Za-z0-9_]+\?(?=$|\/)/.test(p) || /\[\[[^.\]][^\]]*\]\]/.test(p);

  // Strip query + hash.
  p = p.replace(/[?#].*$/, '');
  // A computed template-literal tail lowers confidence but keeps the static prefix.
  if (/\$\{/.test(p)) confidence = 'low';
  // Next route groups: /(marketing)/about → /about
  p = p.replace(/\/\([^)]*\)/g, '');
  // Catch-all / splat: [...slug], [[...slug]], * → :rest
  p = p.replace(/\[\[?\.\.\.[^\]]+\]\]?/g, ':rest').replace(/(^|\/)\*(\/|$)/g, '$1:rest$2');

  // Dynamic segments → :param  ([[id]], [id], :id, ${id}) — but never clobber :rest.
  p = p
    .replace(/\[\[[^\]]+\]\]/g, ':param')
    .replace(/\[[^\]]+\]/g, ':param')
    .replace(/:(?!rest\b)[A-Za-z0-9_]+\??/g, ':param')
    .replace(/\$\{[^}]*\}/g, ':param');

  // Collapse trailing slash (but keep root "/").
  if (p.length > 1) p = p.replace(/\/+$/, '');
  // Collapse duplicate slashes.
  p = p.replace(/\/{2,}/g, '/');
  if (p === '') p = '/';

  if (optional) {
    // Emit both the with-param and without-param variants.
    const without = p.replace(/\/:param$/, '') || '/';
    return { ids: dedupe([p, without]), confidence };
  }
  return { ids: [p], confidence };
}

function dedupe(arr) {
  return [...new Set(arr)];
}

/**
 * Apply an app-root namespace to a canonical id (plan §4a.F multiplicity rule).
 * Single-app repos pass appRoot=null → bare id.
 * @param {string} id
 * @param {string|null} appRoot
 * @returns {string}
 */
export function namespaceId(id, appRoot) {
  return appRoot ? `${appRoot}#${id}` : id;
}
