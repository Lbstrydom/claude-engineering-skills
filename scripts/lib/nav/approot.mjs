/**
 * @fileoverview Monorepo app-root resolution (plan §4a.F, debt-2). When a repo
 * declares `appRoots` in nav-contract.json, each source file is assigned to the
 * longest matching app-root prefix and its destination ids/anchors are namespaced
 * `<appRoot>#<id>` so two apps' `/settings` stay distinct. Single-app repos
 * declare no appRoots → bare ids.
 *
 * @module scripts/lib/nav/approot
 */

/**
 * @param {string} sourceLoc - a repo-relative path (optionally with `:line`)
 * @param {string[]} appRoots - declared app-root prefixes (e.g. ['apps/web', 'apps/admin'])
 * @returns {string|null} the longest matching app root, or null
 */
export function appRootForPath(sourceLoc, appRoots) {
  if (!Array.isArray(appRoots) || appRoots.length === 0 || typeof sourceLoc !== 'string') return null;
  const p = sourceLoc.replace(/\\/g, '/').replace(/:\d+(?::\d+)?$/, '');
  let best = null;
  for (const root of appRoots) {
    const norm = String(root).replace(/\\/g, '/').replace(/\/+$/, '');
    if (p === norm || p.startsWith(norm + '/')) {
      if (!best || norm.length > best.length) best = norm;
    }
  }
  return best;
}
