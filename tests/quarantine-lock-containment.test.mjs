/**
 * @fileoverview Structural guard: EVERY mutation of the quarantine file happens
 * inside the quarantine lock.
 *
 * ## Why this exists — the honest version
 *
 * The property that matters is "an acknowledged append is never lost". The
 * obvious way to test that is to race two writers and look for a lost line.
 * That was tried and it does NOT discriminate: with the lock removed, the
 * durability test in `brainstorm-session-store.test.mjs` stayed GREEN at 2x12
 * writes (under `QUARANTINE_CAP`, so the trim never fires and there is nothing
 * to race) and again at 2x80 (once the file is at the cap, lost updates leave
 * it AT the cap, so a count cannot tell them apart). Constructing a genuinely
 * discriminating probe needs a controllable interleaving — a writer paused
 * between the trim's read and its rename — and `atomicWriteFileSync` offers no
 * seam for one.
 *
 * So the property is decomposed into two claims that ARE each reliably
 * testable, rather than left as a race nobody can observe:
 *
 *   1. `withFileLockSync` provides mutual exclusion.
 *      -> proven behaviourally by the cross-process exclusion test in
 *         `tests/file-lock.test.mjs`, which spawns two real OS processes and
 *         fails on overlapping critical sections.
 *   2. `appendQuarantine` performs ALL of its mutation inside that lock.
 *      -> proven HERE, structurally.
 *
 * (1) AND (2) together imply the durability property. Neither alone does, and
 * (2) is the half that a refactor silently breaks — which is exactly what
 * happened historically: the original design appended outside the lock and
 * trimmed separately, and the resulting race was invisible to every test.
 *
 * This is an AST check, not a regex: it resolves the import binding, so a
 * local shadowing `withFileLockSync` cannot satisfy it, and it reads lexical
 * containment rather than "the two names appear near each other".
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';

// @babel/traverse ships CJS; under ESM the callable lands on .default
// (and on .default.default under some resolutions).
const traverse = _traverse?.default?.default ?? _traverse?.default ?? _traverse;

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const STORE = path.join(REPO_ROOT, 'scripts', 'lib', 'brainstorm', 'session-store.mjs');
const LOCK_FN = 'withFileLockSync';
const CRITICAL_SECTION = 'writeQuarantineLocked';

// No plugin list: this repo is plain ESM, and `importAssertions` was REMOVED
// in Babel 8 (it throws at validatePlugins before parsing anything). Caught by
// the vacuous-pass guard below, which is the whole reason that guard exists —
// without it, a parse that yields zero sites is indistinguishable from a file
// with nothing to flag.
function parseModule(src) {
  return parse(src, { sourceType: 'module' });
}

/**
 * Every call to `calleeName`, paired with whether it is lexically inside a
 * callback argument of a `lockName(...)` call whose callee resolves to the
 * file-lock import.
 */
function analyseContainment(src) {
  const ast = parseModule(src);
  const sites = [];

  traverse(ast, {
    CallExpression(callPath) {
      if (callPath.node.callee.type !== 'Identifier') return;
      if (callPath.node.callee.name !== CRITICAL_SECTION) return;

      // Walk up looking for an enclosing lock call. Containment is checked by
      // ANCESTRY, not proximity: being on the next line is not being inside.
      let inLock = false;
      let bindingResolved = false;
      let p = callPath.parentPath;
      while (p) {
        if (p.isCallExpression()
            && p.node.callee.type === 'Identifier'
            && p.node.callee.name === LOCK_FN) {
          inLock = true;
          // The name must resolve to the file-lock IMPORT, not a local of the
          // same name — otherwise a shadowing stub would satisfy the guard.
          const binding = p.scope.getBinding(LOCK_FN);
          bindingResolved = !!binding
            && binding.path.isImportSpecifier?.()
            && binding.path.parentPath?.node?.source?.value?.includes('file-lock');
          break;
        }
        p = p.parentPath;
      }
      sites.push({
        line: callPath.node.loc?.start?.line ?? 0,
        inLock,
        bindingResolved,
      });
    },
  });

  return sites;
}

describe('quarantine mutation is lock-contained (structural half of the durability property)', () => {
  const src = fs.readFileSync(STORE, 'utf-8');

  it('vacuous-pass guard: the critical section is actually called somewhere', () => {
    const sites = analyseContainment(src);
    assert.ok(
      sites.length > 0,
      `found no call to ${CRITICAL_SECTION} — a rename would make this whole guard pass having checked nothing`,
    );
  });

  it(`every ${CRITICAL_SECTION} call is lexically inside a ${LOCK_FN} callback`, () => {
    const escaped = analyseContainment(src).filter(s => !s.inLock);
    assert.deepEqual(
      escaped, [],
      `an unlocked mutation path is the exact defect this design removed — `
      + `an append landing after the trim's read but before its rename goes to `
      + `the OLD inode and vanishes. Offending line(s): ${escaped.map(s => s.line).join(', ')}`,
    );
  });

  it(`the ${LOCK_FN} it is inside resolves to the file-lock import, not a local shadow`, () => {
    const unresolved = analyseContainment(src).filter(s => s.inLock && !s.bindingResolved);
    assert.deepEqual(
      unresolved, [],
      'a local or stub named withFileLockSync must not satisfy this guard — '
      + `offending line(s): ${unresolved.map(s => s.line).join(', ')}`,
    );
  });

  // The guard has to be able to say NO, or it proves nothing. This runs it
  // against a deliberately-broken copy of the real module rather than a toy,
  // so it exercises the same code shape the production file has.
  it('NEGATIVE CONTROL: reports an escape when the lock is removed', () => {
    const unlocked = src.replace(
      /const outcome = withFileLockSync\([\s\S]*?\n  \);/,
      `const outcome = { ok: true, value: ${CRITICAL_SECTION}(qPath, invalidLines) };`,
    );
    assert.notEqual(unlocked, src, 'the mutation must actually have applied');

    const sites = analyseContainment(unlocked);
    assert.ok(sites.length > 0, 'the broken copy must still call the critical section');
    assert.ok(
      sites.some(s => !s.inLock),
      'the guard failed to notice an unlocked mutation — it cannot detect the regression it exists for',
    );
  });

  it('NEGATIVE CONTROL: a same-named local shadow does not satisfy the guard', () => {
    const shadowed = src.replace(
      `import { withFileLock, withFileLockSync } from '../file-lock.mjs';`,
      `import { withFileLock } from '../file-lock.mjs';\n`
      + `const withFileLockSync = (_p, _o, fn) => ({ ok: true, value: fn() });`,
    );
    assert.notEqual(shadowed, src, 'the shadow mutation must actually have applied');

    const sites = analyseContainment(shadowed);
    assert.ok(
      sites.some(s => s.inLock && !s.bindingResolved),
      'a local stub named withFileLockSync was accepted as the real lock',
    );
  });
});
