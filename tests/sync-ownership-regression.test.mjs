/**
 * @fileoverview Ownership-rollback detection (`detectOwnershipRegression`).
 *
 * Guards the signal that would have caught, within ONE sync, the failure that
 * went undetected for five weeks and then recurred on a second consumer: the
 * consumer manifest is a TRACKED file while the files it owns are gitignored,
 * so a merge/reset/checkout reverts the ownership record while its files stay
 * on disk. Everything synced since then reads as an unowned collision and
 * aborts the whole target.
 *
 * Tier-1 seam per AGENTS.md (deterministic input/output), and adjacent to the
 * Tier-3 consumer-sync contract — a break here is silent by construction.
 *
 * Plan: docs/plans/sync-ownership-from-content.md
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectOwnershipRegression } from '../scripts/lib/sync-manifest.mjs';

const manifest = (generatedAt, fileCount) => ({
  generatedAt,
  files: Object.fromEntries(
    Array.from({ length: fileCount }, (_, i) => [`f${i}.mjs`, `sha256:${i}`]),
  ),
});

describe('detectOwnershipRegression', () => {
  test('detects the real incident: manifest older AND smaller', () => {
    // The observed wine-cellar-app case — adopt wrote 549 @ 15:14, a branch
    // merge replaced it with a 533-file record from the previous morning.
    const r = detectOwnershipRegression(
      { generatedAt: '2026-07-20T15:14:11.801Z', fileCount: 549 },
      manifest('2026-07-19T08:55:10.970Z', 533),
    );
    assert.ok(r, 'expected a regression');
    assert.equal(r.shrankBy, 16);
    assert.equal(r.wentBackwards, true);
    assert.equal(r.priorCount, 533);
    assert.equal(r.recordedCount, 549);
  });

  test('detects a shrink even when the timestamp moved FORWARD', () => {
    // A merge can bring in a newer-but-smaller record from another branch.
    // Timestamp alone would miss it, so count must be checked independently.
    const r = detectOwnershipRegression(
      { generatedAt: '2026-07-20T10:00:00.000Z', fileCount: 549 },
      manifest('2026-07-20T11:00:00.000Z', 540),
    );
    assert.ok(r, 'expected a regression');
    assert.equal(r.shrankBy, 9);
    assert.equal(r.wentBackwards, false);
  });

  test('detects a backwards timestamp even when the count is unchanged', () => {
    // Two branches can hold same-size records with different contents.
    const r = detectOwnershipRegression(
      { generatedAt: '2026-07-20T15:00:00.000Z', fileCount: 549 },
      manifest('2026-07-19T09:00:00.000Z', 549),
    );
    assert.ok(r, 'expected a regression');
    assert.equal(r.shrankBy, 0);
    assert.equal(r.wentBackwards, true);
  });

  test('silent on the normal case: same record, or a GROWING one', () => {
    assert.equal(
      detectOwnershipRegression(
        { generatedAt: '2026-07-20T15:00:00.000Z', fileCount: 549 },
        manifest('2026-07-20T15:00:00.000Z', 549),
      ),
      null,
      'an unchanged record is not a regression',
    );
    assert.equal(
      detectOwnershipRegression(
        { generatedAt: '2026-07-20T15:00:00.000Z', fileCount: 549 },
        manifest('2026-07-20T16:00:00.000Z', 560),
      ),
      null,
      'a newer, larger record is the healthy case',
    );
  });

  test('silent when either input is missing — first sync is not a regression', () => {
    // The false-positive that would matter most: a fresh consumer has no
    // watermark, and a warning there would train operators to ignore it.
    assert.equal(detectOwnershipRegression(null, manifest('2026-07-20T15:00:00.000Z', 549)), null);
    assert.equal(detectOwnershipRegression({ generatedAt: '2026-07-20T15:00:00.000Z', fileCount: 549 }, null), null);
    assert.equal(detectOwnershipRegression(null, null), null);
  });

  test('a corrupt watermark degrades to silence, never to a false alarm', () => {
    // Fail toward "nothing to report": a lying diagnostic is worse than none.
    assert.equal(
      detectOwnershipRegression({ generatedAt: 'not-a-date', fileCount: 'NaN' }, manifest('2026-07-20T15:00:00.000Z', 549)),
      null,
      'unparseable count + date must not fabricate a regression',
    );
    assert.equal(
      detectOwnershipRegression({}, manifest('2026-07-20T15:00:00.000Z', 549)),
      null,
      'an empty watermark must not fabricate a regression',
    );
  });

  test('compares timestamps as instants, not strings', () => {
    // Same instant, different UTC offsets. A lexicographic compare would call
    // the +02:00 spelling "earlier" and fabricate a regression.
    assert.equal(
      detectOwnershipRegression(
        { generatedAt: '2026-07-20T15:00:00.000Z', fileCount: 549 },
        manifest('2026-07-20T17:00:00.000+02:00', 549),
      ),
      null,
      'identical instants in different offsets must not read as backwards',
    );
  });
});
