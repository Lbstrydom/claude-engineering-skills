/**
 * @fileoverview Guards for the mutation-testing registry itself.
 *
 * The registry in `scripts/mutation-test.mjs` declares which seams have had
 * their tests PROVEN to detect defects. That makes it load-bearing in a way
 * that rots silently: rename a module or a test file and the entry points at
 * nothing, Stryker mutates an empty set, and the run reports a perfect score
 * having tested nothing — the exact vacuous pass the instrument exists to
 * catch, reproduced inside the instrument.
 *
 * `mutation-test.mjs` has a guard for that. This file exists because a guard
 * nobody has watched FAIL is indistinguishable from one that always passes, and
 * that guard had never been observed failing when it was written.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { TARGETS, validateTargetFiles } from '../scripts/mutation-test.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const onDisk = f => fs.existsSync(path.join(REPO_ROOT, f));

describe('mutation registry — every declared path resolves', () => {
  it('vacuous-pass guard: the registry is not empty', () => {
    assert.ok(
      TARGETS.length > 0,
      'an empty registry makes every assertion below pass having checked nothing',
    );
  });

  for (const target of TARGETS) {
    it(`${target.name} — mutate + test paths all exist`, () => {
      const r = validateTargetFiles(target, onDisk);
      assert.deepEqual(
        r.ok ? [] : r.missing, [],
        `registry entry "${target.name}" points at files that are not on disk. `
        + 'Stryker would mutate an empty set and report 100%.',
      );
    });

    it(`${target.name} — declares WHY it is guarded, plus a floor and a goal`, () => {
      // The `why` is not decoration: it is what stops the registry becoming a
      // list of whatever was easy to score highly on.
      assert.ok(target.why && target.why.length > 40, 'each seam must justify its inclusion');
      for (const field of ['floor', 'goal']) {
        assert.ok(
          Number.isInteger(target[field]) && target[field] > 0 && target[field] <= 100,
          `${field} of 0 or absent would make the target unfailable`,
        );
      }
    });

    // The ratchet invariant, pinned mechanically. A floor ABOVE its goal is
    // incoherent, and a floor quietly lowered to make a red run pass is the one
    // move this instrument exists to prevent — it converts a regression into
    // the new normal.
    it(`${target.name} — floor never exceeds goal`, () => {
      assert.ok(
        target.floor <= target.goal,
        `floor ${target.floor} > goal ${target.goal}: a floor above the goal means the goal is stale, `
        + 'or the floor was set to whatever the run happened to produce',
      );
    });
  }
});

describe('validateTargetFiles — the guard is proven in BOTH directions', () => {
  const target = { name: 't', mutate: ['src/a.mjs'], tests: ['tests/a.test.mjs'] };

  it('passes when every path exists', () => {
    assert.deepEqual(validateTargetFiles(target, () => true), { ok: true });
  });

  // The direction that matters. Without these three, the guard's only observed
  // behaviour would be "passes", which is what an always-true function does too.
  it('FAILS when the source is missing, and names it', () => {
    const r = validateTargetFiles(target, f => f !== 'src/a.mjs');
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ['src/a.mjs']);
  });

  it('FAILS when the test file is missing, and names it', () => {
    const r = validateTargetFiles(target, f => f !== 'tests/a.test.mjs');
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ['tests/a.test.mjs']);
  });

  // An EMPTY list is the purest vacuous pass and it trips no existence check:
  // Stryker with nothing to mutate reports 100%, and a test command with no
  // files "passes". The first version of this guard accepted both.
  it('FAILS on an empty mutate list — Stryker would report 100% having mutated nothing', () => {
    const r = validateTargetFiles({ name: 't', mutate: [], tests: ['a'] }, () => true);
    assert.equal(r.ok, false);
    assert.deepEqual(r.empty, ['mutate']);
  });

  it('FAILS on an empty tests list — a test command with no files trivially passes', () => {
    const r = validateTargetFiles({ name: 't', mutate: ['a'], tests: [] }, () => true);
    assert.equal(r.ok, false);
    assert.deepEqual(r.empty, ['tests']);
  });

  it('names BOTH when both are empty', () => {
    const r = validateTargetFiles({ name: 't', mutate: [], tests: [] }, () => true);
    assert.deepEqual(r.empty, ['mutate', 'tests']);
  });

  it('rejects a non-array where a list is expected, rather than coercing it', () => {
    for (const bad of [null, undefined, 'a.mjs']) {
      const r = validateTargetFiles({ name: 't', mutate: bad, tests: ['a'] }, () => true);
      assert.equal(r.ok, false, `mutate=${JSON.stringify(bad)} must be refused`);
    }
  });

  it('reports EVERY missing path, not just the first', () => {
    const r = validateTargetFiles(target, () => false);
    assert.equal(r.ok, false);
    assert.deepEqual(
      r.missing, ['src/a.mjs', 'tests/a.test.mjs'],
      'stopping at the first miss makes the second one a surprise on the next run',
    );
  });

  // Regression lock for the real event that motivated this file: the registry
  // originally listed `tests/ledger.test.mjs`, which does not exist. The guard
  // was written in the same commit and had never been seen to fire.
  //
  // RETIREMENT PREDICATE — this assertion is deliberately self-cancelling.
  // Asserting "the file is still missing" would encode known debt as a
  // permanent contract: the day someone writes the suite, a test would FAIL for
  // doing the right thing, and the pressure would be to delete the assertion
  // rather than finish the job. So the absent case pins the guard, and the
  // present case fails with the NEXT action instead.
  it('catches a plausible-looking test path that does not exist (retires itself when written)', () => {
    const ledgerTests = 'tests/ledger.test.mjs';
    const historical = { name: 'ledger', mutate: ['scripts/lib/ledger.mjs'], tests: [ledgerTests] };

    if (!onDisk(ledgerTests)) {
      // Debt bb15049a is still open. Prove the guard fires on it.
      const r = validateTargetFiles(historical, onDisk);
      assert.equal(r.ok, false);
      assert.deepEqual(r.missing, [ledgerTests]);
      return;
    }

    // The suite now exists — the debt is payable, and this is the reminder.
    const inRegistry = TARGETS.some(t => t.mutate.includes('scripts/lib/ledger.mjs'));
    assert.ok(
      inRegistry,
      `${ledgerTests} now exists, so debt bb15049a is ready to close: add a 'ledger' entry to `
      + 'TARGETS in scripts/mutation-test.mjs (measure the score first, set floor to it), then '
      + 'resolve the debt with scripts/debt-resolve.mjs. Delete this branch once done.',
    );
  });
});
