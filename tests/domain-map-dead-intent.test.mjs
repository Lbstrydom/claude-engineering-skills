/**
 * Dead-intent guard for THIS repo's real .audit-loop/domain-map.json.
 *
 * tests/arch-intent-contract.test.mjs already covers computeDeadIntent's
 * logic on synthetic fixtures. Nothing asserted it against the map we
 * actually ship — so `{"pattern": "scripts/ship.mjs"}` kept pointing at a
 * file renamed to ship-commit.mjs, silently owning zero paths while
 * ship-commit.mjs fell through to the `scripts/**` catch-all. It survived
 * because the one hygiene signal that would have flagged it (the dashboard
 * Purpose tab) had `ship` listed in codelessDomains, which suppresses it.
 *
 * Plan: docs/plans/domain-map-reconciliation.md item 9.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  inventoryAllPaths,
  computeDeadIntent,
} from '../scripts/lib/arch-intent/adapter-contract.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP_PATH = path.join(REPO_ROOT, '.audit-loop', 'domain-map.json');

describe('domain-map.json dead-intent guard (real map)', () => {
  const domainMap = JSON.parse(fs.readFileSync(MAP_PATH, 'utf-8'));

  it('every declared domain owns at least one path', () => {
    const dead = computeDeadIntent(inventoryAllPaths(REPO_ROOT, domainMap), domainMap);
    assert.deepEqual(
      dead,
      [],
      `Declared domain(s) own zero paths: ${dead.join(', ')}. `
      + 'Either the rule pattern is stale (a file was renamed/moved — fix the pattern), '
      + 'or the domain is genuinely gone (remove it from rules + allowedDeps + domainPurposes). '
      + 'Do NOT silence this by adding it to codelessDomains — that key means '
      + '"owns paths, but none with indexable code symbols", not "owns nothing".'
    );
  });

  it('every codelessDomains entry owns paths but no source files', () => {
    // Guards the misuse that masked the dead `ship` rule: codelessDomains is
    // for markdown/SQL-only domains, and is NOT an exemption list for a rule
    // that matches nothing.
    const codeless = domainMap.codelessDomains ?? [];
    const owned = new Set(inventoryAllPaths(REPO_ROOT, domainMap).values());
    for (const d of codeless) {
      assert.ok(
        owned.has(d),
        `codelessDomains lists "${d}" but it owns zero paths — that's a dead rule `
        + 'masquerading as a codeless domain. Fix the rule or drop the domain.'
      );
    }
  });
});
