/**
 * @fileoverview Cluster D / Phase 11 — the file-size ratchet's decision logic.
 *
 * The gate exists because, over the 60 days to 2026-09-04, two deliberate
 * decompositions (−3,652 lines) were more than offset by +4,551 lines of
 * unmanaged growth across 11 other files — one of which grew AFTER its
 * decomposition was accepted.
 *
 * Two properties get the most attention here because both have a silent failure
 * mode: the direction the gate must NOT fire (a false failure teaches
 * `--no-verify`), and the ratchet actually tightening (a shrink that merely
 * passes leaves the baseline at the historical high-water mark, so the file can
 * grow back unchallenged — a ratchet that never ratchets).
 *
 * Plan: docs/plans/backlog-and-drift-reduction.md §9.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { diffAgainstBaseline, updatedBaseline, readBaselineState, LIMIT_LINES, TOLERANCE_LINES } from '../scripts/file-size-ratchet.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'file-size-ratchet.mjs');

describe('diffAgainstBaseline — growth', () => {
  test('a baselined file that grows beyond tolerance FAILS', () => {
    const r = diffAgainstBaseline({ 'a.mjs': 1200 }, { 'a.mjs': 1100 });
    assert.deepEqual(r.grew, [{ file: 'a.mjs', was: 1100, now: 1200 }]);
  });

  test('growth WITHIN tolerance does not fire — routine edits must not nag', () => {
    const r = diffAgainstBaseline({ 'a.mjs': 1100 + TOLERANCE_LINES }, { 'a.mjs': 1100 });
    assert.deepEqual(r.grew, [], 'a gate that cries wolf earns --no-verify');
  });

  test('an unbaselined file crossing the limit FAILS as new', () => {
    const r = diffAgainstBaseline({ 'new.mjs': LIMIT_LINES + 5 }, {});
    assert.equal(r.newOver.length, 1);
    assert.equal(r.newOver[0].file, 'new.mjs');
  });
});

describe('diffAgainstBaseline — the two self-cleaning cases are DISTINCT', () => {
  test('shrank but STILL over the limit → ratchet down, stays baselined', () => {
    const r = diffAgainstBaseline({ 'a.mjs': 1100 }, { 'a.mjs': 1200 });
    assert.deepEqual(r.shrank, [{ file: 'a.mjs', was: 1200, now: 1100 }]);
    assert.deepEqual(r.dropped, [], 'still over the limit — it must NOT be dropped');
  });

  test('dropped BELOW the limit → removed from the baseline entirely', () => {
    // Below the limit it no longer appears in `current` at all.
    const r = diffAgainstBaseline({}, { 'a.mjs': 1200 });
    assert.deepEqual(r.dropped, [{ file: 'a.mjs', was: 1200 }]);
    assert.deepEqual(r.shrank, []);
  });

  test('THE TRAP: a still-oversized file removed from the baseline fails as new', () => {
    // This is why the two cases above must not be conflated. Treating "shrank"
    // as "remove it" would drop a 1,100-line file from the baseline, and the
    // very next run would fail it as an unbaselined file over the limit.
    const r = diffAgainstBaseline({ 'a.mjs': 1100 }, {});
    assert.equal(r.newOver.length, 1, 'dropping a still-oversized file makes it instantly fail');
  });
});

describe('the ratchet actually tightens', () => {
  test('after re-baselining a shrink, growing back toward the OLD mark fails', () => {
    // Was 1200, shrank to 1100, baseline ratcheted to 1100.
    const ratcheted = { 'a.mjs': 1100 };
    // Now it creeps back to 1180 — still under the ORIGINAL 1200, and this is
    // exactly what a hold-only ratchet would wave through.
    const r = diffAgainstBaseline({ 'a.mjs': 1180 }, ratcheted);
    assert.equal(r.grew.length, 1, 'regrowth toward the old high-water mark must fail');
  });

  test('a shrink that is never locked in leaves the gate blind to regrowth', () => {
    // The counterfactual the design rejects: baseline stays at 1200.
    const notRatcheted = { 'a.mjs': 1200 };
    const r = diffAgainstBaseline({ 'a.mjs': 1180 }, notRatcheted);
    assert.equal(r.grew.length, 0);
    assert.equal(r.shrank.length, 1,
      'which is why a shrink FAILS asking to be locked in, rather than passing silently');
  });
});

describe('--update-baseline only ratchets DOWN', () => {
  // It used to write every file's CURRENT count. A file that grew within the
  // tolerance passes the gate, so re-baselining one shrunk file also raised
  // the high-water mark of every file that had crept — two agents fixing
  // runs-findings.mjs and gemini-review.mjs each saw seven unrelated files
  // ratchet UP (legacy-production-audit.mjs 1702 -> 1712) on 2026-10-02.
  test('within-tolerance growth is NOT absorbed into the baseline', () => {
    const next = updatedBaseline({ 'crept.mjs': 1712, 'shrunk.mjs': 900 + LIMIT_LINES }, { 'crept.mjs': 1702, 'shrunk.mjs': 2000 });
    assert.equal(next['crept.mjs'], 1702, 'a crept file keeps its old mark');
    assert.equal(next['shrunk.mjs'], 900 + LIMIT_LINES, 'a shrunk file is locked in at its new count');
  });

  test('a file now under the limit leaves the baseline; a newly-oversized one is not admitted', () => {
    const next = updatedBaseline({ 'grown-new.mjs': LIMIT_LINES + 5 }, { 'gone.mjs': 1500 });
    assert.deepEqual(next, {}, 'admitting a new oversized file is a decision, not a side effect of locking in a shrink');
  });

  test('an absent baseline is created from current sizes (bootstrap)', () => {
    assert.deepEqual(updatedBaseline({ 'a.mjs': 1200 }, null), { 'a.mjs': 1200 });
  });
});

describe('--update-baseline bootstraps ONLY from an absent baseline', () => {
  // readBaseline() used to map a parse failure to null, and updatedBaseline(null)
  // bootstraps — so a corrupt baseline was overwritten with every current size,
  // absorbing exactly the growth the ratchet refuses.
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  const withTmp = (fn) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsr-baseline-'));
    try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  };

  test('readBaselineState distinguishes absent, invalid and ok', () => withTmp((dir) => {
    assert.deepEqual(readBaselineState(path.join(dir, 'nope.json')), { kind: 'absent' });
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{ not json');
    assert.equal(readBaselineState(bad).kind, 'invalid');
    for (const [name, body] of [['nofiles', '{}'], ['array', '{"files":[1]}'], ['nonnumeric', '{"files":{"a.mjs":"1200"}}']]) {
      const p = path.join(dir, `${name}.json`);
      fs.writeFileSync(p, body);
      assert.equal(readBaselineState(p).kind, 'invalid', name);
    }
    const ok = path.join(dir, 'ok.json');
    fs.writeFileSync(ok, '{"files":{"a.mjs":1200}}');
    assert.deepEqual(readBaselineState(ok), { kind: 'ok', files: { 'a.mjs': 1200 } });
    fs.writeFileSync(ok, '{"files":{}}');
    assert.deepEqual(readBaselineState(ok), { kind: 'ok', files: {} }, 'an empty files map is a valid baseline, not an invalid one');
  }));

  test('a corrupt baseline is refused, exit 2, and left byte-for-byte untouched', () => withTmp((dir) => {
    const p = path.join(dir, 'baseline.json');
    const corrupt = '{ "files": { "scripts/x.mjs": 1100, ';
    fs.writeFileSync(p, corrupt);
    const r = run('--baseline', p, '--update-baseline');
    assert.equal(r.status, 2, `stderr: ${r.stderr}`);
    assert.match(r.stderr, /refusing --update-baseline/);
    assert.equal(fs.readFileSync(p, 'utf8'), corrupt, 'the corrupt file is not overwritten');
  }));

  test('a well-formed baseline with no files map is refused too, not read as an empty one', () => withTmp((dir) => {
    const p = path.join(dir, 'baseline.json');
    fs.writeFileSync(p, '{"limitLines":1000}');
    const r = run('--baseline', p, '--update-baseline');
    assert.equal(r.status, 2, `stderr: ${r.stderr}`);
    assert.equal(fs.readFileSync(p, 'utf8'), '{"limitLines":1000}');
  }));

  test('NEGATIVE CONTROL: an ABSENT baseline is still bootstrapped (the refusal is not a blanket exit 2)', () => withTmp((dir) => {
    const p = path.join(dir, 'baseline.json');
    const r = run('--baseline', p, '--update-baseline');
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const written = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(typeof written.files, 'object');
    assert.equal(readBaselineState(p).kind, 'ok');
  }));

  test('the gate names an invalid baseline as invalid, not as missing', () => withTmp((dir) => {
    const p = path.join(dir, 'baseline.json');
    fs.writeFileSync(p, 'garbage');
    const r = run('--baseline', p);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /is invalid/);
    assert.doesNotMatch(r.stderr, /no baseline at/);
  }));
});

describe('the direction the gate must NOT fire', () => {
  test('an unchanged tree is clean in every bucket', () => {
    const same = { 'a.mjs': 1500, 'b.mjs': 2000 };
    const r = diffAgainstBaseline(same, { ...same });
    assert.deepEqual([r.grew, r.newOver, r.shrank, r.dropped], [[], [], [], []]);
  });

  test('a file that was always under the limit is invisible to the gate', () => {
    const r = diffAgainstBaseline({}, {});
    assert.deepEqual([r.grew, r.newOver, r.shrank, r.dropped], [[], [], [], []]);
  });
});

// Gate contract: scripts/gate-contracts/size-ratchet-gate.json declares the
// executable gate `size-ratchet-rejects-growth-past-the-baseline`, whose poison
// pill overlays an understated baseline so the real tree reads as growth. The
// pure-logic cases above are what that pill exercises end to end.
