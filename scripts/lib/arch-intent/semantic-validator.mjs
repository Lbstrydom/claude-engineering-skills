/**
 * @fileoverview Semantic validation for an already-shape-validated
 * domain-map config. Runs AFTER Zod parsing.
 *
 * Checks:
 *   - Every `allowedDeps` key + value references a declared domain (or `vendor`).
 *   - Every `description` key references a declared domain.
 *   - Rule shadowing: a later rule whose pattern is a strict subset of an
 *     earlier rule's pattern is unreachable. Warned, not thrown — operator
 *     may have intentional shadow rules.
 *
 * @module scripts/lib/arch-intent/semantic-validator
 */

import { minimatch } from 'minimatch';
import { ArchIntentConfigError } from './errors.mjs';
import { VENDOR_DOMAIN } from './domain-resolver.mjs';

/**
 * Compute the set of domains declared by the RULES array (the
 * authoritative source). `vendor` is added as a pseudo-domain since
 * it's a legitimate target. Used here AND by isArchIntentReportClean /
 * deadIntent computation — single SoT (M5 fix).
 *
 * NOTE: this is DIFFERENT from computeDeclaredDomains() in
 * domain-resolver.mjs which unions rules + allowedDeps + description.
 * Here we ONLY use rules because validating allowedDeps against
 * declared-from-allowedDeps would be circular.
 */
function rulesDeclaredDomains(parsedMap) {
  const declared = new Set(parsedMap.rules.map(r => r.domain));
  declared.add(VENDOR_DOMAIN);
  return declared;
}

/**
 * @param {{rules: Array, allowedDeps?: Object|null, description?: Object}} parsedMap
 * @param {string} [configFile] - path for error messages
 * @returns {{ warnings: string[] }}
 * @throws {ArchIntentConfigError} on semantic failures
 */
export function validateDomainMapSemantics(parsedMap, configFile = null) {
  const warnings = [];
  const declared = rulesDeclaredDomains(parsedMap);

  // Check allowedDeps keys + values
  if (parsedMap.allowedDeps && typeof parsedMap.allowedDeps === 'object') {
    for (const [from, tos] of Object.entries(parsedMap.allowedDeps)) {
      if (!declared.has(from)) {
        throw new ArchIntentConfigError(
          `allowedDeps key "${from}" is not a declared domain (must appear in rules[].domain)`,
          { configFile, semantic: true }
        );
      }
      for (const to of tos) {
        if (!declared.has(to)) {
          throw new ArchIntentConfigError(
            `allowedDeps["${from}"] references undeclared target domain "${to}"`,
            { configFile, semantic: true }
          );
        }
      }
    }
  }

  // Check description keys
  if (parsedMap.description) {
    for (const k of Object.keys(parsedMap.description)) {
      if (!declared.has(k)) {
        throw new ArchIntentConfigError(
          `description key "${k}" is not a declared domain`,
          { configFile, semantic: true }
        );
      }
    }
  }

  // Rule shadowing — warn only
  for (let i = 0; i < parsedMap.rules.length; i++) {
    for (let j = i + 1; j < parsedMap.rules.length; j++) {
      const earlier = parsedMap.rules[i];
      const later = parsedMap.rules[j];
      // If `later.pattern` matches a strict subset of earlier's matches,
      // it's unreachable.  Simple heuristic: later is more-specific iff
      // it doesn't contain ** AND earlier does, AND a sample expansion of
      // later matches earlier.  Conservative — only catches obvious cases.
      if (earlier.pattern.includes('**') && !later.pattern.includes('**')
          && minimatch(later.pattern, earlier.pattern, { dot: true })) {
        warnings.push(
          `Rule shadowing: "${later.pattern}" (line ${j + 1}) is unreachable — earlier rule "${earlier.pattern}" (line ${i + 1}) already matches it`
        );
      }
    }
  }

  return { warnings };
}
