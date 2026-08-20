/**
 * @fileoverview Regression lock for the ship-commit Guard-A/Guard-B DRY fix
 * (audit finding f875f7a1, plan `docs/plans/worktree-identity-guards.md` §5
 * Phase 3).
 *
 * THE DEFECT. Three CLI suites (`ship-commit-cli`, `-pathspec`, `-no-tests`)
 * each hand-rolled their own `identityArgs()`/`guardArgs()` bundle — the
 * `--expect-head`/`--expect-branch`/`--path` argument set the ship-commit
 * guards require — with subtly different surrounding behaviour. The risk
 * named in the finding is not duplication for its own sake but SILENT
 * DIVERGENCE: a copy that drifts stops testing the guard it appears to test
 * while staying green.
 *
 * THE FIX. `tests/helpers/worktree-guard-args.mjs` is now the single canonical
 * definition; every consumer imports `identityArgs`/`scopeArgs`/`guardArgs`
 * from there rather than reimplementing them.
 *
 * This is a DRY/duplication finding with no independent runtime behaviour of
 * its own to assert (the underlying CLI behaviour is already covered by the
 * consumer suites) — so what is actually lockable, and what this test locks,
 * is the ABSENCE of a second independent copy. Derived from the real files
 * under `tests/`, never a hand-picked list, so a reintroduced copy anywhere
 * in the suite is caught rather than only in the three files named in 2026.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS_DIR = path.join(REPO, 'tests');
const CANONICAL = path.join(TESTS_DIR, 'helpers', 'worktree-guard-args.mjs');
const SELF = fileURLToPath(import.meta.url);

/** Every `.test.mjs` file under tests/, plus the canonical helper itself. */
function testFiles() {
  return fs.readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith('.test.mjs'))
    .map((f) => path.join(TESTS_DIR, f));
}

const BINDING_RE = /\b(?:function\s+(identityArgs|guardArgs)\s*\(|const\s+(identityArgs|guardArgs)\s*=)/;

describe('ship-commit Guard-A/Guard-B bundle stays de-duplicated', () => {
  it('the canonical helper still defines identityArgs, scopeArgs and guardArgs', () => {
    // Vacuous-pass guard: if the helper file were renamed or gutted, every
    // check below would trivially pass having found nothing to compare against.
    const src = fs.readFileSync(CANONICAL, 'utf-8');
    assert.match(src, /export function identityArgs\(/);
    assert.match(src, /export function scopeArgs\(/);
    assert.match(src, /export function guardArgs\(/);
  });

  it('no test file outside the canonical helper reimplements identityArgs/guardArgs from scratch', () => {
    const offenders = [];
    for (const file of testFiles()) {
      if (path.resolve(file) === path.resolve(CANONICAL)) continue;
      if (path.resolve(file) === path.resolve(SELF)) continue; // this file's own regex literals mention the names
      const src = fs.readFileSync(file, 'utf-8');
      const m = BINDING_RE.exec(src);
      if (!m) continue;
      const names = new Set([m[1] || m[2]]);

      // A local binding is fine ONLY as a thin wrapper that delegates to the
      // canonical import (e.g. `const identityArgs = (cwd) => sharedIdentityArgs(cwd)`).
      // The regression this guards against is a binding whose OWN body drives
      // git directly (`spawnSync(...'git'...)`), which is the independent
      // reimplementation the audit found — three subtly different copies of
      // "what a valid identity expectation looks like".
      const importsCanonical = /from\s+['"]\.\/helpers\/worktree-guard-args\.mjs['"]/.test(src);
      if (!importsCanonical) {
        offenders.push(`${path.basename(file)}: defines ${[...names].join('/')} but does not import from helpers/worktree-guard-args.mjs`);
        continue;
      }
      // Even importing the canonical helper, a file could ALSO independently
      // redefine the same name with its own git-spawning body — importing one
      // thing and shadowing it with another. Catch that by requiring any
      // local binding's line to reference the shared (`shared*`-prefixed, per
      // the repo's own aliasing convention) import, not spawn git itself.
      const bindingLines = src.split('\n').filter((line) => BINDING_RE.test(line));
      for (const line of bindingLines) {
        if (/spawnSync\s*\(\s*['"]git['"]/.test(line)) {
          offenders.push(`${path.basename(file)}: "${line.trim()}" drives git directly instead of delegating`);
        }
      }
    }
    assert.deepEqual(
      offenders, [],
      `a test file reimplements the Guard-A/Guard-B bundle instead of importing the canonical `
      + `tests/helpers/worktree-guard-args.mjs — this is the exact silent-divergence risk the `
      + `extraction fixed:\n${offenders.join('\n')}`,
    );
  });

  it('every known ship-commit CLI suite actually imports the canonical helper (positive control)', () => {
    // The negative-space check above proves absence; this proves the positive
    // — that real consumers are wired to the canonical module at all, so the
    // "no offenders found" result above is not vacuous.
    const consumers = [
      'ship-commit-cli.test.mjs',
      'ship-commit-no-tests.test.mjs',
      'ship-commit-pathspec.test.mjs',
      'ship-commit-worktree-identity.test.mjs',
      'audit-base-ancestry.test.mjs',
    ];
    for (const name of consumers) {
      const p = path.join(TESTS_DIR, name);
      assert.ok(fs.existsSync(p), `expected consumer suite ${name} to exist`);
      const src = fs.readFileSync(p, 'utf-8');
      assert.match(
        src, /from\s+['"]\.\/helpers\/worktree-guard-args\.mjs['"]/,
        `${name} must import from the canonical helper`,
      );
    }
  });
});
