/**
 * @fileoverview The migration ratchet — legacy-map size may only DECREASE,
 * derived from the frozen inventory (docs/plans/cross-skill-command-registry.md,
 * audit R2-H1).
 *
 * The pin is the count of commands still on the legacy dispatch path. It is
 * NOT free-standing (a free-standing count reads a deleted command as
 * migration progress): the conformance suite asserts the conservation law
 * (`registry ∪ legacy = INVENTORY`, disjoint), so together the two mean
 * "every inventory command is dispatched, and this many remain legacy".
 *
 * Update the pin DOWNWARD in the same commit as each migrated cohort, with a
 * comment naming the cohort (the learning-store-exports pattern). Phase 5
 * flips this file to asserting the legacy map no longer exists.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(new URL('../scripts/cross-skill.mjs', import.meta.url));

// 71 total. Cluster A (Phase 2) migrated the template trio:
//   whoami · record-ship-event · persona-outcomes           → 71 − 3 = 68
const LEGACY_PIN = 68;

describe('cross-skill registry ratchet', () => {
  it(`legacy command count is exactly ${LEGACY_PIN} (decrease-only; update WITH the cohort that moves it)`, () => {
    const r = spawnSync(process.execPath, [CLI_PATH, '--inventory-json'], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const line = r.stdout.split('\n').filter((l) => l.trim().startsWith('{')).pop();
    const { registry, legacy } = JSON.parse(line);
    assert.ok(legacy.length <= LEGACY_PIN,
      `legacy grew (${legacy.length} > ${LEGACY_PIN}) — a new command belongs in the REGISTRY, not the legacy map`);
    assert.equal(legacy.length, LEGACY_PIN,
      `legacy shrank past the pin (${legacy.length} < ${LEGACY_PIN}) — a cohort migrated without moving the pin; `
      + 'update LEGACY_PIN in the same commit so the ratchet stays a measurement');
    assert.equal(registry.length + legacy.length, 71, 'conservation (see conformance suite for the full law)');
  });
});
