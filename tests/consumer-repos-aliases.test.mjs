/**
 * @fileoverview Registry aliases are the ONLY consumer label the population line prints, so they are validated at
 * load: bounded charset, unique, and never one of the line's own anonymous labels (`self`, `sibling-<n>`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assertAliasesValid, CONSUMER_REPOS } from '../scripts/lib/consumer-repos.mjs';

const ok = (...aliases) => aliases.map((alias) => ({ alias }));

describe('assertAliasesValid', () => {
  it('accepts bounded, unique, non-reserved aliases (and the real registry satisfies it)', () => {
    assert.doesNotThrow(() => assertAliasesValid(ok('wine', 'ai', 'a-b-1', 'x'.repeat(32), 'sibling', 'selfish', 'sibling-x', 'sibling-')));
    assert.doesNotThrow(() => assertAliasesValid(CONSUMER_REPOS));
  });

  it('refuses the reserved labels: self and sibling-<n>', () => {
    for (const bad of ['self', 'sibling-1', 'sibling-42', 'sibling-007']) {
      assert.throws(() => assertAliasesValid(ok('wine', bad)), /reserved/, bad);
    }
  });

  it('still refuses a bad charset, an over-long alias and a duplicate', () => {
    for (const bad of ['Has_Underscore', 'UPPER', '', 'x'.repeat(33), 'a b']) assert.throws(() => assertAliasesValid(ok(bad)), /invalid alias/, bad);
    assert.throws(() => assertAliasesValid([{ alias: 5 }]), /invalid alias/);
    assert.throws(() => assertAliasesValid(ok('wine', 'wine')), /more than one entry/);
  });
});
