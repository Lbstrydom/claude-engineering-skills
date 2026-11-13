/**
 * @fileoverview The classification of every step of `check` for the pre-push archive
 * lane (ARCHIVE_LANE_CHECK_CLASSIFICATION, scripts/lib/prepush-archive-lane.mjs).
 * Plan: docs/plans/prepush-archive-lane.md.
 *
 * Split out of tests/prepush-archive-lane.test.mjs so it can be enrolled in
 * `npm run guards:preflight` (GUARD_TESTS): this census is pure (reads package.json,
 * no git/spawn, ~1 s) whereas the lane's own tests are ~58 s of real git. Adding a
 * step to `check` without a row here failed a full-suite run on #351 after a green
 * preflight. ONE copy lives here; the lane's git tests stay in the original file.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARCHIVE_LANE_CHECK_CLASSIFICATION,
  LANE_SCANNERS,
  checkStepNames,
  validateClassification,
} from '../scripts/lib/prepush-archive-lane.mjs';
import { expandedCheckScript } from '../scripts/lib/check-chain.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');

describe('ARCHIVE_LANE_CHECK_CLASSIFICATION', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const steps = checkStepNames(expandedCheckScript(pkg.scripts));

  it('classifies every step of check and names no step check lacks (both directions)', () => {
    assert.ok(steps.length >= 30, `parsed ${steps.length} steps: the census itself must not be vacuous`);
    assert.deepEqual(validateClassification(ARCHIVE_LANE_CHECK_CLASSIFICATION, steps), []);
  });

  it('CONTROL: a new step with no entry is reported, and so is a stale entry', () => {
    assert.match(validateClassification(ARCHIVE_LANE_CHECK_CLASSIFICATION, [...steps, 'secrets:gate']).join('\n'), /"secrets:gate" has no entry/);
    assert.match(validateClassification(ARCHIVE_LANE_CHECK_CLASSIFICATION, steps.slice(1)).join('\n'), /not a step of check/);
  });

  it('CONTROL: a publication-safety step cannot be added by editing the table alone', () => {
    const table = { ...ARCHIVE_LANE_CHECK_CLASSIFICATION, 'secrets:gate': { cls: 'P', reason: 'scans pushed content' } };
    const problems = validateClassification(table, [...steps, 'secrets:gate']).join('\n');
    assert.match(problems, /"secrets:gate" is class P/);
    const mapped = { ...table, 'secrets:gate': { cls: 'P', reason: 'scans pushed content', laneScanner: LANE_SCANNERS[0] } };
    assert.deepEqual(validateClassification(mapped, [...steps, 'secrets:gate']), []);
    const bogus = { ...table, 'secrets:gate': { cls: 'P', reason: 'x', laneScanner: 'nope' } };
    assert.match(validateClassification(bogus, [...steps, 'secrets:gate']).join('\n'), /names no lane scanner/);
  });

  it('rejects an unknown class and an empty reason', () => {
    const problems = validateClassification({ a: { cls: 'Z', reason: ' ' } }, ['a']).join('\n');
    assert.match(problems, /class must be/);
    assert.match(problems, /reason is empty/);
  });

  it('records no class P today — check has no publication-safety step (plan §1.2)', () => {
    assert.deepEqual(Object.values(ARCHIVE_LANE_CHECK_CLASSIFICATION).filter((e) => e.cls === 'P'), []);
  });
});
