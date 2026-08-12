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

// 71 total.
//   Cluster A (Phase 2) — template trio:
//     whoami · record-ship-event · persona-outcomes                → 71 − 3 = 68
//   Cluster B (Phase 3) — mutating writers (21):
//     upsert-plan · update-plan-status · record-regression-spec ·
//     record-regression-spec-run · record-correlation · record-nav-audit-run ·
//     record-plan-verify-run · record-plan-verify-items · add-persona ·
//     record-persona-session · final-review-adjudicate ·
//     final-review-record-fix · learning-record · open-refresh-run ·
//     publish-refresh-run · abort-refresh-run · record-symbol-definitions ·
//     record-symbol-index · record-symbol-embedding ·
//     record-layering-violations · set-active-embedding-model → 68 − 21 = 47
//   Cluster C (Phase 4) — readers (14):
//     plan-satisfaction · audit-effectiveness · detect-stack ·
//     get-nav-first-seen · preview-gate · resolve-repo-identity ·
//     get-active-refresh-id · compute-target-domains · get-callers-for-file ·
//     list-symbols-for-snapshot · list-layering-violations-for-snapshot ·
//     compute-drift-score · get-neighbourhood ·
//     get-incident-neighbourhood                                → 47 − 14 = 33
//   Cluster D (Phase 5) — remaining readers (8):
//     list-personas · get-persona-sessions-by-repo ·
//     get-persona-sessions-by-url · get-reachability-evidence ·
//     get-recent-findings · final-review-stats · final-review-pending ·
//     shadow-overlap                                             → 33 − 8 = 25
const LEGACY_PIN = 25;

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
