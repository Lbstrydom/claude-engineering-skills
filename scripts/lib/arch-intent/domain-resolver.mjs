/**
 * @fileoverview Domain resolution + allowedDeps checking. Shared by all
 * adapters. Pure functions of (filePath, rules, allowedDeps) → result.
 *
 * @module scripts/lib/arch-intent/domain-resolver
 */

import { minimatch } from 'minimatch';

/**
 * The pseudo-domain assigned to external dependencies (node_modules,
 * `node:` built-ins, vendored libs). Always allowed as a target.
 * Excluded from deadIntent computation (won't have local files by definition).
 */
export const VENDOR_DOMAIN = 'vendor';

/**
 * Resolve a file path to its domain via first-match-wins glob rules.
 * Path separators are normalised to forward-slash before matching.
 *
 * @param {string} filePath - **repo-relative path** (NOT absolute — rules
 *   are written as repo-relative globs and won't match absolute paths).
 *   Callers should normalise via path.relative(repoRoot, abs) before this.
 *   The function defensively normalises path separators (Windows backslash
 *   → forward-slash) but does NOT strip an absolute prefix.
 * @param {Array<{pattern: string, domain: string}>} rules
 * @returns {string|null} domain name, or null if no rule matched
 */
export function resolveFileToDomain(filePath, rules) {
  if (!filePath || !Array.isArray(rules) || rules.length === 0) return null;
  const normalised = String(filePath).replaceAll('\\', '/');
  for (const rule of rules) {
    if (minimatch(normalised, rule.pattern, { dot: true })) {
      return rule.domain;
    }
  }
  return null;
}

/**
 * Check whether a dependency edge from one domain to another is allowed.
 * Semantics:
 *   - Same-domain edges are ALWAYS allowed (no need to enumerate self).
 *   - `vendor` as target is ALWAYS allowed (external deps).
 *   - Otherwise: edge allowed iff `allowedDeps[from]` includes `to`.
 *   - Missing `allowedDeps` (null) → caller decides; this function returns false.
 *
 * @param {string} fromDomain
 * @param {string} toDomain
 * @param {Object<string, string[]>|null} allowedDeps
 * @returns {boolean}
 */
export function checkDepAllowed(fromDomain, toDomain, allowedDeps) {
  if (fromDomain === toDomain) return true;
  if (toDomain === VENDOR_DOMAIN) return true;
  if (allowedDeps == null) return false;
  const allowed = allowedDeps[fromDomain];
  if (!Array.isArray(allowed)) return false;
  return allowed.includes(toDomain);
}

/**
 * Compute the set of declared domains for deadIntent / semantic-validation
 * purposes. Union of:
 *   - every `rules[].domain`
 *   - every key in `allowedDeps`
 *   - every value in `allowedDeps[k]`
 *   - every key in `description`
 *
 * Pseudo-domains (`vendor`) are EXCLUDED — they don't correspond to local
 * files and would otherwise always appear as dead.
 *
 * @param {{rules: Array, allowedDeps?: Object, description?: Object}} domainMap
 * @returns {Set<string>}
 */
export function computeDeclaredDomains(domainMap) {
  const set = new Set();
  for (const r of domainMap.rules || []) set.add(r.domain);
  for (const k of Object.keys(domainMap.allowedDeps || {})) set.add(k);
  for (const arr of Object.values(domainMap.allowedDeps || {})) {
    for (const t of arr) set.add(t);
  }
  for (const k of Object.keys(domainMap.description || {})) set.add(k);
  set.delete(VENDOR_DOMAIN); // pseudo-domain
  return set;
}
