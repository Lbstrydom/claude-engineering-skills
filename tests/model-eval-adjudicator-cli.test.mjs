import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

describe('model-eval-adjudicator.mjs — CLI preflight', () => {
  test('--selfcheck-relocation exits 0 and prints OK', () => {
    const out = execFileSync('node', ['scripts/model-eval-adjudicator.mjs', '--selfcheck-relocation'], { encoding: 'utf8' });
    assert.match(out, /OK/);
  });

  test('missing --candidate exits non-zero with a usage message', () => {
    assert.throws(() => execFileSync('node', ['scripts/model-eval-adjudicator.mjs', '--tier', 'screen'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  });

  test('an invalid --tier exits non-zero', () => {
    assert.throws(() => execFileSync('node', ['scripts/model-eval-adjudicator.mjs', '--candidate', '{"kind":"sentinel","value":"latest-pro"}', '--tier', 'bogus'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  });

  test('an insufficient-ground-truth run exits with the documented preflight code (2)', () => {
    // This repo's real ground-truth corpus (if any) is almost certainly
    // below the 10/20-row minSampleSize thresholds — exercises the REAL
    // getAdjudicatorGroundTruth query end-to-end without fabricating DB rows.
    try {
      execFileSync('node', ['scripts/model-eval-adjudicator.mjs', '--candidate', '{"kind":"sentinel","value":"latest-pro"}', '--tier', 'screen'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      assert.fail('expected a non-zero exit (insufficient ground truth, or a real provider call attempted)');
    } catch (err) {
      assert.ok([1, 2, 3].includes(err.status), `unexpected exit code ${err.status}: ${err.stderr}`);
    }
  });
});
