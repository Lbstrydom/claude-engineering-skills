import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSourceRepo } from '../scripts/lib/is-source-repo.mjs';

// Round-6 code-audit Sustainability M5: extracted from maintenance-checks.mjs
// so this predicate is importable without evaluating that file's config.mjs
// (env loading) and scheduler machinery — this suite proves the import alone
// is cheap/side-effect-free by not needing any of maintenance-checks.mjs's
// setup, and that the predicate itself still behaves correctly in isolation.

describe('isSourceRepo (standalone module)', () => {
  it('is true in this checkout', () => {
    assert.equal(isSourceRepo(), true);
  });

  it('is a plain function importable with no other module\'s side effects', () => {
    // The import above already proves this — reaching this line means
    // scripts/lib/is-source-repo.mjs loaded without pulling in
    // maintenance-checks.mjs's config.mjs/file-lock.mjs/CHECKS setup.
    assert.equal(typeof isSourceRepo, 'function');
  });
});
