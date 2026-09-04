/**
 * @fileoverview Cluster A / Phase 6 — every script the SYNCED maintenance
 * runner spawns must itself be synced.
 *
 * `scripts/maintenance-checks.mjs` ships to consumer repos and spawns its
 * checks as subprocesses. Four of them were declared nowhere in the sync
 * inventory (`debt-ledger-claims-check`, `debt-capture-trail-check`,
 * `check-accepted-debt`, `slice-recurrence-check`), so a consumer's weekly
 * maintenance run died on MODULE_NOT_FOUND for each — the failure class
 * recorded at `scripts/sync-to-repos.mjs:430-437` from a live wine-cellar-app
 * incident on 2026-07-22.
 *
 * **This test derives the spawn list from the runner's own source** rather than
 * restating it. A hand-maintained mirror of the list would drift exactly the way
 * the inventory drifted, and would be the second source of truth that caused
 * this. The filesystem/source is the only side that can see a script no list
 * mentions.
 *
 * Plan: docs/plans/backlog-and-drift-reduction.md Phase 6.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(REPO, 'scripts', 'maintenance-checks.mjs');

/**
 * Every `{ script: '<name>.mjs' }` the runner declares. Derived, not restated.
 * Matches both `script: 'x.mjs'` and `script: 'dir/x.mjs'`.
 */
function spawnedScripts() {
  const src = fs.readFileSync(RUNNER, 'utf-8');
  const out = new Set();
  for (const m of src.matchAll(/script:\s*'([^']+\.mjs)'/g)) out.add(m[1]);
  return [...out].sort();
}

/**
 * Scripts spawned only by a `sourceRepoOnly: true` check.
 *
 * These are NOT gaps. The runner short-circuits such a check in a consumer with
 * a clean "source-repo-only" skip before it ever spawns, precisely so a
 * deliberately-unsynced script does not surface as MODULE_NOT_FOUND. Today that
 * is `check-accepted-debt.mjs`, whose ACCEPTED_DEBT_ROWS registry is hardcoded
 * to THIS repo's AGENTS.md rows — syncing it would report a consumer's whole
 * table unregistered forever (pinned in tests/cli-smoke-set-sync-parity.test.mjs).
 *
 * Derived from the runner rather than hardcoded, so a check that gains or loses
 * the flag is reflected here automatically.
 */
function sourceRepoOnlyScripts() {
  const src = fs.readFileSync(RUNNER, 'utf-8');
  const out = new Set();
  for (const block of src.split(/\n {2}\{\n/).slice(1)) {
    if (!/sourceRepoOnly:\s*true/.test(block)) continue;
    for (const m of block.matchAll(/script:\s*'([^']+\.mjs)'/g)) out.add(m[1]);
  }
  return out;
}

describe('sync inventory covers everything maintenance-checks.mjs spawns', () => {
  test('the derivation itself finds a plausible spawn set (guards a vacuous pass)', () => {
    const scripts = spawnedScripts();
    assert.ok(
      scripts.length >= 8,
      `expected the runner to declare many spawned scripts, found ${scripts.length} — `
      + 'if the `script:` literal shape changed, this test would silently pass having checked nothing',
    );
  });

  test('every spawned script is declared in the sync inventory', async () => {
    const { _internals } = await import('../scripts/lib/sync-inventory.mjs');
    // Flatten every declared list under `_internals` (CORE_ENTRY, DEBT_ENTRY,
    // …), so this does not depend on which list a script happens to live in —
    // only on it being declared SOMEWHERE.
    const declared = new Set(
      Object.values(_internals)
        .filter(Array.isArray)
        .flat()
        .filter((v) => typeof v === 'string'),
    );
    assert.ok(
      declared.size >= 20,
      `expected a populated inventory, got ${declared.size} entries — a near-empty `
      + 'set would make the assertion below fail for the wrong reason (or, inverted, pass vacuously)',
    );

    const exempt = sourceRepoOnlyScripts();
    const missing = [];
    for (const rel of spawnedScripts()) {
      if (exempt.has(rel)) continue; // skipped in a consumer before it is spawned
      const candidates = [`scripts/${rel}`, rel];
      if (!candidates.some((c) => declared.has(c))) missing.push(rel);
    }

    assert.deepEqual(
      missing, [],
      'maintenance-checks.mjs is synced to consumers and spawns these; a script it '
      + 'spawns but the inventory omits is a MODULE_NOT_FOUND in every consumer '
      + '(sync-to-repos.mjs:430-437, live 2026-07-22).',
    );
  });

  test('every spawned script actually exists in this repo', () => {
    const missing = spawnedScripts().filter((rel) => !fs.existsSync(path.join(REPO, 'scripts', rel)));
    assert.deepEqual(missing, [], 'the runner names a script that is not here');
  });
});

describe('the source-repo-only escape hatch is real, not a loophole', () => {
  test('at least one check uses it, and its script is genuinely unsynced', async () => {
    // Guards the exemption from becoming a way to quietly drop a script from
    // the sync: if `sourceRepoOnly` ever stopped being used, this test would
    // fail rather than silently exempting nothing.
    const exempt = sourceRepoOnlyScripts();
    assert.ok(exempt.size >= 1, 'no check declares sourceRepoOnly — has the flag been renamed?');

    const inventory = await import('../scripts/lib/sync-inventory.mjs');
    const declared = new Set(
      Object.values(inventory._internals).filter(Array.isArray).flat().filter((v) => typeof v === 'string'),
    );
    for (const rel of exempt) {
      assert.ok(
        !declared.has(`scripts/${rel}`),
        `${rel} is marked sourceRepoOnly yet IS synced — one of the two is wrong`,
      );
    }
  });
});
