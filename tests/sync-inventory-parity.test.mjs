/**
 * @fileoverview sync-inventory.mjs hand-maintains a mirror of sync-to-repos.mjs's
 * entry-point arrays (it cannot import the CLI module directly — see its
 * header note on why consumer-repos.mjs path arithmetic is source-only), and
 * every array carries a "keep in lock-step" comment pointing back at
 * sync-to-repos.mjs as authoritative. Comments are not enforcement: the two
 * drifted silently — sync-to-repos.mjs's CORE_ENTRY grew four
 * local-maintenance-checks entries (maintenance-checks.mjs, memory-health.mjs,
 * check-model-freshness.mjs, context-staleness.mjs) plus several standalone
 * operator CLIs that sync-inventory.mjs never picked up, so every consumer of
 * getSyncInventoryForRepo/getAllConsumerInventories (the isolation verifier,
 * the relocation guard, and install/deps.mjs's derived npm-dependency
 * computation) had a blind spot for those files' entire transitive closure.
 *
 * This test diffs the two modules' entry-point arrays directly so the class
 * cannot recur silently again.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { _internals as syncToRepos } from '../scripts/sync-to-repos.mjs';
import { _internals as syncInventory } from '../scripts/lib/sync-inventory.mjs';

/** @returns {{onlyInA: string[], onlyInB: string[]}} sorted, de-duplicated set diff */
function diffArrays(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  return {
    onlyInA: [...setA].filter((x) => !setB.has(x)).sort(),
    onlyInB: [...setB].filter((x) => !setA.has(x)).sort(),
  };
}

function assertSameSet(a, b, { aLabel, bLabel }) {
  const { onlyInA, onlyInB } = diffArrays(a, b);
  assert.deepEqual(
    { onlyInA, onlyInB },
    { onlyInA: [], onlyInB: [] },
    `${aLabel} and ${bLabel} have drifted.\n` +
      `  Only in ${aLabel}: ${JSON.stringify(onlyInA)}\n` +
      `  Only in ${bLabel}: ${JSON.stringify(onlyInB)}\n` +
      'sync-to-repos.mjs is authoritative — reconcile scripts/lib/sync-inventory.mjs to match.',
  );
}

describe('sync-inventory.mjs stays in lock-step with sync-to-repos.mjs (authoritative)', () => {
  it('CORE_ENTRY ∪ CORE_NON_IMPORTABLE matches sync-to-repos.mjs CORE_ENTRY', () => {
    // sync-inventory.mjs splits its mirror into two arrays (importable vs
    // dynamic-import-only entries); sync-to-repos.mjs keeps them in one list.
    // The union is the thing that must match.
    assertSameSet(
      syncToRepos.CORE_ENTRY,
      [...syncInventory.CORE_ENTRY, ...syncInventory.CORE_NON_IMPORTABLE],
      { aLabel: 'sync-to-repos.mjs CORE_ENTRY', bLabel: 'sync-inventory.mjs CORE_ENTRY+CORE_NON_IMPORTABLE' },
    );
  });

  it('CORE_ASSETS matches (excluding the dynamically-enumerated supabase/migrations/* tail)', () => {
    // sync-to-repos.mjs spreads `...syncMigrations()` directly into its
    // CORE_ASSETS array; sync-inventory.mjs adds the same call's result
    // separately at bundle-time (see its bundleForRepo). Strip the migration
    // files from both sides so the comparison is of the hand-written entries only.
    const stripMigrations = (arr) => arr.filter((f) => !f.startsWith('supabase/migrations/'));
    assertSameSet(
      stripMigrations(syncToRepos.CORE_ASSETS),
      stripMigrations(syncInventory.CORE_ASSETS),
      { aLabel: 'sync-to-repos.mjs CORE_ASSETS', bLabel: 'sync-inventory.mjs CORE_ASSETS' },
    );
  });

  it('LEARNING_ENTRY matches', () => {
    assertSameSet(syncToRepos.LEARNING_ENTRY, syncInventory.LEARNING_ENTRY, {
      aLabel: 'sync-to-repos.mjs LEARNING_ENTRY', bLabel: 'sync-inventory.mjs LEARNING_ENTRY',
    });
  });

  it('ARCH_ENTRY matches', () => {
    assertSameSet(syncToRepos.ARCH_ENTRY, syncInventory.ARCH_ENTRY, {
      aLabel: 'sync-to-repos.mjs ARCH_ENTRY', bLabel: 'sync-inventory.mjs ARCH_ENTRY',
    });
  });

  it('DEBT_ENTRY matches', () => {
    assertSameSet(syncToRepos.DEBT_ENTRY, syncInventory.DEBT_ENTRY, {
      aLabel: 'sync-to-repos.mjs DEBT_ENTRY', bLabel: 'sync-inventory.mjs DEBT_ENTRY',
    });
  });

  it('SYNC_ISOLATION_ENTRY matches', () => {
    assertSameSet(syncToRepos.SYNC_ISOLATION_ENTRY, syncInventory.SYNC_ISOLATION_ENTRY, {
      aLabel: 'sync-to-repos.mjs SYNC_ISOLATION_ENTRY', bLabel: 'sync-inventory.mjs SYNC_ISOLATION_ENTRY',
    });
  });

  it('sync-inventory.mjs never carries a bare relative-form entry (the ./lib/redact.mjs phantom-path class)', () => {
    // A `./`-prefixed entry point normalises (in collectImportClosure) to a
    // repo-ROOT-relative path, not a scripts/-relative one — `./lib/redact.mjs`
    // silently resolved to the nonexistent `lib/redact.mjs` and still ended up
    // in every consumer inventory's `files` list (readFile fails, but the
    // queued path stays in the closure's `visited` set regardless). Every
    // entry-point array here is meant to be repo-root-relative; guard the
    // whole set rather than just the one historical offender.
    const allEntries = [
      ...syncInventory.CORE_ENTRY, ...syncInventory.CORE_NON_IMPORTABLE,
      ...syncInventory.LEARNING_ENTRY, ...syncInventory.ARCH_ENTRY,
      ...syncInventory.DEBT_ENTRY, ...syncInventory.SYNC_ISOLATION_ENTRY,
    ];
    const relativeForm = allEntries.filter((f) => f.startsWith('./') || f.startsWith('../'));
    assert.deepEqual(relativeForm, []);
  });
});

describe('syncMigrations distinguishes "no migrations" from "could not look"', () => {
  // Round-1 audit H3/M7: every readdirSync failure returned [], so EACCES on an
  // existing directory, an I/O failure, or a mis-resolved REPO_ROOT were all
  // indistinguishable from a repo that legitimately has none — and the bundle
  // would ship with its schema silently absent.
  it('an unreadable migrations directory throws instead of reporting none', async () => {
    const { _internals } = await import('../scripts/lib/sync-inventory.mjs');
    const fsMod = await import('node:fs');
    const real = fsMod.default.readdirSync;
    try {
      fsMod.default.readdirSync = () => { const e = new Error('permission denied'); e.code = 'EACCES'; throw e; };
      assert.throws(() => _internals.syncMigrations(), /Refusing to report an empty migration set/);
    } finally {
      fsMod.default.readdirSync = real;
    }
  });

  it('ENOENT still means none — the expected-absence case must stay quiet', async () => {
    // Vacuous-pass guard: a version that threw on everything would satisfy the
    // test above while breaking every repo without a migrations directory.
    const { _internals } = await import('../scripts/lib/sync-inventory.mjs');
    const fsMod = await import('node:fs');
    const real = fsMod.default.readdirSync;
    try {
      fsMod.default.readdirSync = () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; };
      assert.deepEqual(_internals.syncMigrations(), []);
    } finally {
      fsMod.default.readdirSync = real;
    }
  });
});
