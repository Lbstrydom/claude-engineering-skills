/**
 * @fileoverview A store module must not CALL a function that only a sibling
 * store module defines.
 *
 * THE DEFECT THIS LOCKS (cross-skill-command-registry Cluster E, 2026-08-12).
 * Splitting `plans-ship.mjs` into six domain modules cut between
 * `recordPlanVerificationRun` and the `insertRunRowWithPolicyFallback` helper it
 * calls. Each new module's imports were derived from the ORIGINAL file's import
 * list, which by construction cannot know about a reference that was *intra*-file
 * before the cut — so the call became a free variable.
 *
 * Why it survived a green suite, and why a static check rather than a unit test:
 *
 *  - The ReferenceError is raised INSIDE the writer's own `try`, and its `catch`
 *    returns `null` — the same value it returns for cloud-off and for a missing
 *    planId. So every cloud-enabled /ux-lock-verify run would have recorded
 *    nothing and reported it as an ordinary absence.
 *  - `npm test` was 11,582 green with it live. Nothing exercises that writer's
 *    cloud path (a live DSN is forbidden in the default suite), and `node --check`
 *    cannot see it: a free variable is legal syntax, resolved at call time.
 *
 * The class generalises past this one cut — any future store split, or a
 * function moved between modules, reintroduces it — so the guard is mechanical
 * over the DIRECTORY rather than a fixture pinned to today's modules.
 *
 * RETIREMENT PREDICATE: delete this file the day `npm run check` runs a real JS
 * linter with `no-undef` over `scripts/lib/store/**`. This is a hand-rolled
 * approximation of one lint rule, kept only because there is no linter here
 * (the audit's Phase 0 reports `js/eslint not available`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STORE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/lib/store');

/** Comments quote helper names in prose; an analysis that reads them reports fiction. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Top-level `function` / `const` / `let` declarations. */
function topLevelDefs(src) {
  const names = new Set();
  for (const re of [
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm,
    /^(?:export\s+)?(?:const|let)\s+(\w+)/gm,
  ]) {
    for (const m of src.matchAll(re)) names.add(m[1]);
  }
  return names;
}

/** Names pulled in by `import { a, b as c }` — the alias is what's in scope. */
function importedNames(src) {
  return new Set([...src.matchAll(/import\s+\{([^}]*)\}/g)]
    .flatMap((m) => m[1].split(','))
    .map((s) => s.trim().split(/\s+as\s+/).pop())
    .filter(Boolean));
}

/**
 * Names bound ANYWHERE in a file as a local: a parameter, or a nested
 * `const`/`let`/`var`.
 *
 * Needed because a same-named local is not a free variable, and this is not a
 * scope-aware analysis. Run against the live tree the first version reported
 * `campaign.mjs calls redact() — defined in friction.mjs`, which is a
 * dependency-INJECTED parameter (`buildBlindRow(src, redact)`) and entirely
 * correct. That is the argument for verifying a promoted check against the
 * whole tree and not only against the defect that motivated it.
 *
 * Deliberately over-broad — a name bound as a local ANYWHERE in the file
 * exempts it EVERYWHERE in that file. So the check can miss a genuine free
 * variable whose name happens to be a parameter elsewhere. That direction is
 * the right one to be wrong in: a false positive on correct injected code gets
 * the whole check disabled, while the residual false negative needs a name
 * collision inside one module to hide.
 */
function locallyBound(src) {
  const names = new Set();
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)/g)) names.add(m[1]);
  // Parameter lists: `function f(a, b)`, `(a, b) =>`, `a =>`.
  const params = [
    ...src.matchAll(/function\s*\*?\s*\w*\s*\(([^)]*)\)/g),
    ...src.matchAll(/\(([^)]*)\)\s*=>/g),
  ].map((m) => m[1]);
  for (const list of params) {
    for (const p of list.split(',')) {
      const n = p.trim().replace(/^\.\.\./, '').split(/[=:\s]/)[0].replace(/[{}[\]]/g, '');
      if (n) names.add(n);
    }
  }
  for (const m of src.matchAll(/(\w+)\s*=>/g)) names.add(m[1]);
  return names;
}

/**
 * The detector, as a pure function of a `{file: source}` map, so the controls
 * below can drive it with fabricated sources rather than by damaging the repo.
 */
export function findCrossModuleFreeVariables(sources) {
  const files = Object.keys(sources);
  const clean = Object.fromEntries(files.map((f) => [f, stripComments(sources[f])]));
  const defs = Object.fromEntries(files.map((f) => [f, topLevelDefs(clean[f])]));
  const imports = Object.fromEntries(files.map((f) => [f, importedNames(clean[f])]));
  const locals = Object.fromEntries(files.map((f) => [f, locallyBound(clean[f])]));

  const out = [];
  for (const f of files) {
    for (const other of files) {
      if (other === f) continue;
      for (const name of defs[other]) {
        if (defs[f].has(name) || imports[f].has(name) || locals[f].has(name)) continue;
        if (new RegExp(`\\b${name}\\s*\\(`).test(clean[f])) {
          out.push({ file: f, name, definedIn: other });
        }
      }
    }
  }
  return out;
}

const storeFiles = fs.readdirSync(STORE_DIR).filter((f) => f.endsWith('.mjs'));
const sources = Object.fromEntries(
  storeFiles.map((f) => [f, fs.readFileSync(path.join(STORE_DIR, f), 'utf-8')]),
);

describe('store modules have no cross-module free variables', () => {
  // Vacuous-pass guards. Both numbers are the measured floor, not slack: this
  // check is worthless if it silently ends up comparing an empty set, which is
  // precisely how it would report "clean" after a bad refactor moved everything.
  it('has modules to compare, and symbols to compare them against', () => {
    assert.ok(storeFiles.length >= 10,
      `expected >=10 store modules, found ${storeFiles.length} — the scan would be near-vacuous`);
    const total = Object.values(sources)
      .reduce((n, src) => n + topLevelDefs(stripComments(src)).size, 0);
    assert.ok(total >= 100,
      `expected >=100 top-level declarations across the store, found ${total} — the detector has nothing to look for`);
  });

  it('detects a call to a symbol only a sibling defines (negative control)', () => {
    // Drives the detector with the EXACT shape of the Cluster E defect, so a
    // green result above means "looked and found nothing", not "looked at
    // nothing". Verified against the real regression before the fix landed.
    const hits = findCrossModuleFreeVariables({
      'a.mjs': 'export function helper(x) { return x; }\n',
      'b.mjs': 'export async function writer() {\n  return await helper(1);\n}\n',
    });
    assert.deepEqual(hits, [{ file: 'b.mjs', name: 'helper', definedIn: 'a.mjs' }]);
  });

  it('does not fire when the caller imports the symbol (false-positive control)', () => {
    const hits = findCrossModuleFreeVariables({
      'a.mjs': 'export function helper(x) { return x; }\n',
      'b.mjs': "import { helper } from './a.mjs';\nexport async function writer() {\n  return await helper(1);\n}\n",
    });
    assert.deepEqual(hits, []);
  });

  it('does not fire on an INJECTED parameter of the same name (false-positive control)', () => {
    // The real shape that broke the first version of this check:
    // `buildBlindRow(src, redact)` in campaign.mjs takes its redactor as an
    // argument, while friction.mjs happens to define a top-level `redact`.
    const hits = findCrossModuleFreeVariables({
      'a.mjs': 'const redact = (s) => s;\nexport function useIt() { return redact("x"); }\n',
      'b.mjs': 'export function buildRow(src, redact) {\n  return { detail: redact(src.detail) };\n}\n',
    });
    assert.deepEqual(hits, []);
  });

  it('does not fire on a name that appears only in a comment', () => {
    const hits = findCrossModuleFreeVariables({
      'a.mjs': 'export function helper(x) { return x; }\n',
      'b.mjs': '// see helper() in a.mjs for why\nexport function other() { return 1; }\n',
    });
    assert.deepEqual(hits, []);
  });

  it('the live store tree is clean', () => {
    const hits = findCrossModuleFreeVariables(sources);
    assert.deepEqual(hits, [],
      'a store module calls a function only a sibling defines — it is a free variable, legal syntax, '
      + 'and it throws only at call time. If the caller wraps it in a try/catch that degrades to null, '
      + 'the write silently stops happening:\n'
      + hits.map((h) => `  ${h.file} calls ${h.name}() — defined in ${h.definedIn}`).join('\n'));
  });
});
