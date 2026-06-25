/**
 * @fileoverview Adapter: Next.js file-based routing (`pages/` + `app/`).
 * Destinations are derived from FILE PATHS, not content. Discovery-only.
 *
 * @module scripts/lib/nav/adapters/next-file
 */
import { normalizeDestination } from '../normalize.mjs';

export const name = 'next-file';

const PAGE_RE = /(^|\/)(pages|app)\//;

export function detect(root, sources) {
  return sources.some((s) => PAGE_RE.test(s.path.replace(/\\/g, '/')));
}

export function discoverDestinations(sources) {
  const out = [];
  for (const s of sources) {
    const p = s.path.replace(/\\/g, '/');
    const id = pathToRoute(p);
    if (id) {
      for (const norm of normalizeDestination(id).ids) out.push({ id: norm, sourceLoc: s.path, raw: p });
    }
  }
  return out;
}

/** Convert a Next file path to a route string (pre-normalization). Returns null
 *  for non-page files (components, api routes, layouts).
 *
 *  NOTE (audit M10 — documented v1 bound): app-router parallel routes (`@slot`),
 *  intercepting routes (`(.)`, `(..)`), and route groups in the URL space are not
 *  fully modelled — route groups are stripped by the normalizer, parallel/
 *  intercepting segments are treated as ordinary path segments. Within the
 *  ~80%-recall contract (plan §2.5); v1.1 enhancement. */
function pathToRoute(p) {
  // app router: app/foo/bar/page.tsx → /foo/bar ; app/page.tsx → /
  let m = p.match(/(^|\/)app\/(.*)\/page\.[jt]sx?$/);
  if (m) return '/' + m[2];
  if (/(^|\/)app\/page\.[jt]sx?$/.test(p)) return '/';
  // pages router: pages/foo/bar.tsx → /foo/bar ; pages/index.tsx → /
  m = p.match(/(^|\/)pages\/(.*)\.[jt]sx?$/);
  if (m) {
    let route = m[2];
    if (route === 'index') return '/';
    route = route.replace(/\/index$/, '');
    // Skip api routes + Next special files.
    if (/^api(\/|$)/.test(route) || /^_(app|document|error)$/.test(route)) return null;
    return '/' + route;
  }
  return null;
}

export function resolveDestination(raw, _ctx = {}) {
  if (typeof raw !== 'string') return null;
  const strLit = raw.trim().match(/^['"`]([^'"`]*)['"`]$/);
  const value = strLit ? strLit[1] : raw.trim();
  if (!value || !value.startsWith('/')) return null;
  return normalizeDestination(value).ids[0] ?? null;
}
