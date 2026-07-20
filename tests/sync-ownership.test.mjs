/**
 * @fileoverview Content-derived ownership (`classifyOwnership`).
 *
 * This function stands between a sync and a consumer's own file, so it is
 * guarded on BOTH directions: it must adopt what is provably ours (or the
 * consumer silently stops receiving updates — the failure this replaced), and
 * it must refuse everything else (or we overwrite someone's work).
 *
 * Tier-3 seam per AGENTS.md: the consumer-sync contract, where a break ships
 * silently to repos we cannot observe.
 *
 * Plan: docs/plans/sync-ownership-from-content.md
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOwnership, describeEvidence } from '../scripts/lib/sync-ownership.mjs';

const BANNER = '⚠ UPSTREAM-OWNED — DO NOT EDIT HERE. Synced from claude-engineering-skills';

describe('classifyOwnership — adopts what is provably ours', () => {
  test('a file carrying the banner is ours, even if it differs from source', () => {
    // The banner survives local edits, and an edited synced file is still OURS
    // (an in-place edit is a governance violation, not a change of authorship).
    const r = classifyOwnership({
      destContent: `${BANNER}\nexport const x = 'locally edited';\n`,
      sourceContent: 'export const x = 1;\n',
      bannerMarker: BANNER,
    });
    assert.deepEqual(r, { provable: true, evidence: 'banner' });
  });

  test('a non-bannered file byte-identical to source is ours', () => {
    // The .audit-loop/migrations/*.sql case: SQL is not banner-injected, so
    // identity is the only available proof. It is a sound one — if the bytes
    // already equal what we would write, adopting discards nothing.
    const sql = 'ALTER TABLE plans ADD COLUMN x int;\n';
    const r = classifyOwnership({ destContent: sql, sourceContent: sql, bannerMarker: BANNER });
    assert.deepEqual(r, { provable: true, evidence: 'identical-to-source' });
  });

  test('the banner proof is checked BEFORE identity', () => {
    // Ordering matters for the evidence label the operator reads: a bannered
    // file that also matches should report the stronger, authorship-based proof.
    const same = `${BANNER}\nexport const x = 1;\n`;
    const r = classifyOwnership({ destContent: same, sourceContent: same, bannerMarker: BANNER });
    assert.equal(r.evidence, 'banner');
  });
});

describe('classifyOwnership — refuses everything else (fails closed)', () => {
  test('a consumer-authored file collides', () => {
    // The case the guard exists for. Must never be adopted.
    const r = classifyOwnership({
      destContent: '// consumer-authored\nexport const mine = 1;\n',
      sourceContent: 'export const x = 1;\n',
      bannerMarker: BANNER,
    });
    assert.deepEqual(r, { provable: false, evidence: 'none' });
  });

  test('unreadable or empty destination is never ours', () => {
    for (const destContent of [null, undefined, '', 0, {}]) {
      const r = classifyOwnership({ destContent, sourceContent: 'x', bannerMarker: BANNER });
      assert.equal(r.provable, false, `destContent=${JSON.stringify(destContent)} must not be provable`);
      assert.equal(r.evidence, 'unreadable');
    }
  });

  test('an EMPTY banner marker cannot make everything ours', () => {
    // ''.includes('') is vacuously true — without the length guard this single
    // bug would auto-adopt every file at every destination, silently disarming
    // the collision guard entirely. The highest-consequence failure here.
    const r = classifyOwnership({
      destContent: '// consumer-authored\n',
      sourceContent: 'something else',
      bannerMarker: '',
    });
    assert.deepEqual(r, { provable: false, evidence: 'none' });
  });

  test('a missing source comparand does not fabricate identity', () => {
    // sourceContent is null for banner-injected/rewritten payload. A file with
    // no banner and no comparand must collide, not slip through.
    for (const sourceContent of [null, undefined, '']) {
      const r = classifyOwnership({
        destContent: '// consumer-authored\n', sourceContent, bannerMarker: BANNER,
      });
      assert.deepEqual(r, { provable: false, evidence: 'none' });
    }
  });

  test('near-identical content still collides — identity is exact, not fuzzy', () => {
    const r = classifyOwnership({
      destContent: 'ALTER TABLE plans ADD COLUMN x int;\n',
      sourceContent: 'ALTER TABLE plans ADD COLUMN x INT;\n', // case differs
      bannerMarker: BANNER,
    });
    assert.equal(r.provable, false);
  });
});

describe('describeEvidence', () => {
  test('every evidence value has distinct, non-empty operator text', () => {
    const values = ['banner', 'identical-to-source', 'unreadable', 'none'];
    const seen = values.map(describeEvidence);
    for (const s of seen) assert.ok(s && s.length > 0);
    assert.equal(new Set(seen).size, values.length, 'evidence descriptions must be distinguishable');
  });
});
