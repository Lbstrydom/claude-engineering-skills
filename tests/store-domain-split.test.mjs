/**
 * @fileoverview The `plans-ship.mjs` domain split, pinned as an inventory.
 *
 * THE FINDINGS THIS LOCKS (aged-out unlocked-fix backlog, worked 2026-08-30):
 * 4f4e2005, 223f0529, e9738f0b, 3ad850f6, 7b3a93cc — five HIGH `[Structure]
 * Missing planned store …` findings raised across four audit runs on
 * 2026-08-12, each reporting that the planned per-domain store modules were
 * absent and the 1,572-line aggregate `scripts/lib/store/plans-ship.mjs` was
 * still the only implementation. The fix was the split
 * (cross-skill-command-registry Phase 6); `plans-ship.mjs` survives as a
 * re-export barrel because it is the import name every consumer already uses.
 *
 * WHY IT NEEDED ITS OWN LOCK. A silent RE-MERGE is invisible to every other
 * suite. The barrel is `export * from` lines, so folding the six siblings back
 * into it leaves the public surface byte-identical: `learning-store-exports`
 * still sees its 93 functions, every consumer import still resolves, and
 * `store-module-free-variables` (the split's *correctness* guard) has ~30 other
 * store modules and would stay above its ≥10 floor. Nothing in `npm test`
 * asserts the modules exist. This does.
 *
 * TWO HALVES, and they fail for different reasons:
 *  1. The barrel's own `export * from './X.mjs'` targets must all resolve —
 *     derived from the barrel source, never a re-typed list, so a module added
 *     to the split later is covered without editing this file.
 *  2. Each planned module must OWN its declared exports. Half 1 alone passes
 *     for a barrel re-exporting six empty files; this is what makes the
 *     inventory mean "the domain lives here".
 *
 * RETIREMENT PREDICATE: delete this file if `plans-ship.mjs` is ever removed
 * outright (a deliberate rename of the public surface) — at that point the
 * consumers import the domain modules directly and their absence is a hard
 * import error, which is a better lock than this one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STORE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/lib/store');
const BARREL = path.join(STORE_DIR, 'plans-ship.mjs');

/**
 * The domain → exports it must own, as the plan assigned them. Deliberately a
 * SUBSET of each module's surface: this pins the ownership the findings named,
 * not today's full export list, so adding a function to a domain does not fail
 * an unrelated test.
 */
const PLANNED_OWNERSHIP = Object.freeze({
  'plans.mjs': ['validatePlanPath', 'upsertPlan', 'getPlanIdByPath', 'updatePlanStatus'],
  'regression-specs.mjs': ['recordRegressionSpec', 'recordRegressionSpecRun'],
  'plan-verification.mjs': ['recordPlanVerificationRun', 'recordPlanVerificationItems'],
  'ship-events.mjs': ['recordShipEvent'],
  'persona-correlations.mjs': ['recordPersonaAuditCorrelation', 'readCorrelationsForRun'],
  // 3ad850f6 / 7b3a93cc named the ownership seam alongside the five, because
  // `assertParentOwnership` had nowhere to live until it existed.
  'ownership.mjs': ['assertParentOwnership', 'ownedReadPredicate', 'buildOwnedInsert'],
});

/** `export * from './x.mjs'` targets, in barrel order. */
function barrelTargets(src) {
  return [...src.matchAll(/export\s+\*\s+from\s+'\.\/([^']+)'/g)].map((m) => m[1]);
}

/** Top-level `export function|const` names declared IN a module (not re-exported). */
function ownExports(src) {
  const names = new Set();
  for (const re of [
    /^export\s+(?:async\s+)?function\s+(\w+)/gm,
    /^export\s+(?:const|let)\s+(\w+)/gm,
  ]) {
    for (const m of src.matchAll(re)) names.add(m[1]);
  }
  return names;
}

describe('plans-ship.mjs is a barrel over real domain modules', () => {
  const barrelSrc = fs.readFileSync(BARREL, 'utf-8');
  const targets = barrelTargets(barrelSrc);

  // Vacuous-pass guard: an empty target list would make every assertion below
  // pass over nothing — exactly the shape a re-merge produces.
  it('re-exports a whole family, not one module', () => {
    assert.ok(targets.length >= 6,
      `expected >=6 'export * from' targets in plans-ship.mjs, found ${targets.length}: ${targets.join(', ')} `
      + '— the domain split was reverted, or the barrel now holds implementation again');
  });

  it('declares no implementation of its own — it is a barrel', () => {
    assert.deepEqual([...ownExports(barrelSrc)], [],
      'plans-ship.mjs declared an export of its own; the domains own the code, this file owns the name');
  });

  it('every re-export target resolves to a real sibling module', () => {
    for (const t of targets) {
      assert.ok(fs.existsSync(path.join(STORE_DIR, t)), `plans-ship.mjs re-exports missing module ./${t}`);
    }
  });
});

describe('each planned store domain exists and owns its exports', () => {
  for (const [module, expected] of Object.entries(PLANNED_OWNERSHIP)) {
    it(`${module} declares ${expected.join(', ')}`, () => {
      const file = path.join(STORE_DIR, module);
      assert.ok(fs.existsSync(file),
        `${module} is absent — this is the exact state the 2026-08-12 audits reported`);
      const owned = ownExports(fs.readFileSync(file, 'utf-8'));
      for (const name of expected) {
        assert.ok(owned.has(name),
          `${module} must DECLARE ${name} — a re-export from elsewhere leaves the domain empty`);
      }
    });
  }

  // Negative control: the ownership reader must be able to return the other
  // answer, or every assertion above passes for a parser that finds nothing.
  it('ownExports finds nothing in a file that only re-exports (control)', () => {
    assert.deepEqual([...ownExports("export * from './a.mjs';\n")], []);
    assert.deepEqual([...ownExports('export function f() {}\n')], ['f']);
  });
});
