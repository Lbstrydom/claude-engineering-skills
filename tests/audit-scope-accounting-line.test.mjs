import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatScopeAccountingLine, formatFileScopeLine } from '../scripts/lib/audit-scope.mjs';

// Cluster A, Phase 3 (fleet 484f b). The AIO run c375d97d printed
//   "Multi-pass code audit: 94 files in scope (92 from the plan + 2 changed-not-planned), 4 missing, 96 referenced"
// and then, two lines later, "File scope: 29 files -> 28 BE + 1 FE in scope". The audit read 29; the 94 is PLAN ACCOUNTING, printed before the
// --files filter. Read as the audited count it looked like a merge push had widened the scope 3x. It had not.
const AIO = { foundCount: 94, planCount: 92, addedCount: 2, missingCount: 4, referencedCount: 96 };

describe('formatScopeAccountingLine', () => {
  test('unfiltered audit: byte-identical to the historical line', () => {
    assert.equal(
      formatScopeAccountingLine({ ...AIO, filtered: false }),
      '\nMulti-pass code audit: 94 files in scope (92 from the plan + 2 changed-not-planned), 4 missing, 96 referenced\n',
    );
  });

  test('filtered audit (--files / diff): says it is plan accounting and points at the audited scope, never "in scope"', () => {
    const line = formatScopeAccountingLine({ ...AIO, filtered: true });
    assert.match(line, /94 files resolved/);
    assert.match(line, /plan accounting/);
    assert.match(line, /not the audited count/);
    assert.doesNotMatch(line, /files in scope/);
    assert.match(line, /\(92 from the plan \+ 2 changed-not-planned\), 4 missing, 96 referenced/);
  });
});

describe('formatFileScopeLine', () => {
  test('states the count the passes actually read', () => {
    const line = formatFileScopeLine({ filterCount: 29, backend: 28, frontend: 1 });
    assert.match(line, /File scope: 29 files → 28 BE \+ 1 FE in scope/);
    assert.match(line, /audited/);
  });
});
