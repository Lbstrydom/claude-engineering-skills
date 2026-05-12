/**
 * @fileoverview Architecture-intent config loader. Reads
 * `.audit-loop/domain-map.json`, validates via Zod + semantic checks,
 * returns a typed object.
 *
 * Does NOT extend the existing `loadDomainRules()` in domain-tagger —
 * that's used by symbol-index and stays backward-compatible. This is a
 * NEW entry point specifically for arch-intent strictness.
 *
 * @module scripts/lib/arch-intent/load-config
 */

import fs from 'node:fs';
import path from 'node:path';
import { DomainMapSchema } from '../schemas.mjs';
import { ArchIntentConfigError } from './errors.mjs';
import { validateDomainMapSemantics } from './semantic-validator.mjs';

const DOMAIN_MAP_RELATIVE = '.audit-loop/domain-map.json';

/**
 * Load + validate arch-intent config.
 *
 * @param {string} repoRoot - absolute path to repo root
 * @returns {{
 *   rules: Array<{pattern: string, domain: string}>,
 *   allowedDeps: Object<string, string[]>|null,
 *   description: Object<string, string>,
 *   _warnings: string[],
 *   _present: boolean,
 *   _path: string,
 * }}
 * @throws {ArchIntentConfigError} on missing file, bad JSON, schema failure, or semantic failure
 */
export function loadArchIntentConfig(repoRoot) {
  const file = path.join(repoRoot, DOMAIN_MAP_RELATIVE);
  if (!fs.existsSync(file)) {
    throw new ArchIntentConfigError(`domain-map.json not found at ${file}`, { configFile: file });
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new ArchIntentConfigError(`Invalid JSON in ${file}: ${err.message}`, { configFile: file });
  }
  const parsed = DomainMapSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ArchIntentConfigError(
      `Schema validation failed for ${file}: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      { configFile: file }
    );
  }

  // Semantic validation (throws on hard failures, returns warnings for soft)
  const { warnings } = validateDomainMapSemantics(parsed.data, file);

  // Per decision 12: missing `allowedDeps` field maps to `null` (not `{}`).
  // Zod's `.nullable().optional()` returns undefined for missing → coerce.
  const allowedDeps = parsed.data.allowedDeps === undefined ? null : parsed.data.allowedDeps;

  return {
    rules: parsed.data.rules,
    allowedDeps,
    description: parsed.data.description ?? {},
    _warnings: warnings,
    _present: true,
    _path: file,
  };
}
