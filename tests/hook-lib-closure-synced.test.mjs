/**
 * @fileoverview A hook's runtime library must reach consumers (upstream 3b84d8bb follow-up).
 *
 * `.claude/hooks/*` load their classifier from the tooling tree at runtime (`scripts/lib` in the source repo,
 * `scripts/.claude-skills/lib` in a consumer). When `file-taxonomy.mjs` gained an import, two hook tests failed on CI
 * because their fixture listed the library by hand. The fixture is fixed (it derives the closure now); this guard closes the
 * REAL risk behind it: that a module a hook needs is missing from what the sync ships, so a consumer's hook goes silently
 * inert exactly as the fixture's did.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { libClosureOf } from './helpers/lib-closure.mjs';
import { getSyncClosure } from '../scripts/lib/sync-inventory.mjs';

const HOOK_LIBRARY_ENTRIES = [
  'scripts/lib/sensitive-paths.mjs',   // .claude/hooks/syntax-check.mjs
  'scripts/lib/quickfix-patterns.mjs', // .claude/hooks/quickfix-scan.mjs
];

describe('every library a hook loads is in the consumer sync closure', () => {
  const shipped = new Set(getSyncClosure().files);

  it('the sync closure is non-empty and carries the hook entries (vacuous-pass guard)', () => {
    assert.ok(shipped.size > 100, `sync closure has ${shipped.size} files`);
    for (const entry of HOOK_LIBRARY_ENTRIES) assert.ok(shipped.has(entry), `${entry} must be synced`);
  });

  for (const entry of HOOK_LIBRARY_ENTRIES) {
    it(`${entry}: its whole import closure ships`, () => {
      const missing = libClosureOf(entry).map((rel) => `scripts/lib/${rel}`).filter((f) => !shipped.has(f));
      assert.deepEqual(missing, [], `a consumer hook could not load: ${missing.join(', ')}`);
    });
  }

  it('the closure includes the module whose absence broke the fixtures (negative control)', () => {
    assert.ok(libClosureOf('scripts/lib/sensitive-paths.mjs').includes('bundle-generated-stores.mjs'));
  });
});
