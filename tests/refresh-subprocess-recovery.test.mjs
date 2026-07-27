/**
 * @fileoverview Tier-1 tests for `scripts/symbol-index/refresh-subprocess.mjs`'s
 * 8b timed-out-full recovery decision — extracted from `refresh.mjs`
 * (docs/plans/tiered-pipeline-refresh-god-module-decomposition.md Phase 5).
 *
 * This is the DIRECT regression lock for the round-2 `recoveredTouchedSet`
 * contract bug (the plan's round-1 wiring-table draft specified an
 * UNCONDITIONAL `touchedSet` destructure that would have silently discarded
 * a valid step-6 value on the ordinary incremental path; caught in round 2
 * and fixed to a conditional rebind — see refresh.mjs's own comment at its
 * call site).
 *
 * Two tiers, reusing this repo's own established split for the identical
 * problem one layer down (tests/subprocess-idle-timeout.test.mjs's own
 * documented Tier A/Tier B split):
 *
 * - **Tier A** (below): `shouldAttemptTimeoutRecovery`/`buildTimeoutRecovery`
 *   are both pure, plain-data functions — deterministic, no DB, no
 *   subprocess, no mocking needed.
 * - **Tier B** (real end-to-end `main()` run against a disposable DB +
 *   genuinely-idle child process, proving a `recoveredTouchedSet` returned
 *   by `runExtractSummariseEmbed` is the SAME set `main()`'s copy-forward
 *   call receives): NOT implemented here. Constructing a deterministic
 *   genuinely-idle extract subprocess (rather than a real ts-morph parse,
 *   which cannot be reliably wedged on demand) proved impractical within
 *   this phase, exactly the contingency the plan's own Testing Strategy
 *   names ("if constructing a genuinely-idle child process deterministically
 *   proves impractical within Phase 5, Tier A's direct-call proof is the
 *   acceptance floor and the Tier-B gap is recorded honestly ... rather than
 *   claimed done"). Recorded here rather than silently skipped: the
 *   behavioural proof that `refresh.mjs`'s conditional rebind
 *   (`if (recoveredTouchedSet) touchedSet = recoveredTouchedSet;`) actually
 *   wires the two together stays at the level of direct source inspection,
 *   not an executed integration test.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shouldAttemptTimeoutRecovery, buildTimeoutRecovery, writeFilesManifestIfRestricted } from '../scripts/symbol-index/refresh-subprocess.mjs';

const SYMLINK_UNSUPPORTED = new Set(['EPERM', 'EACCES']);
function trySymlink(target, linkPath, type = 'file') {
  try { fs.symlinkSync(target, linkPath, type); return true; }
  catch (err) { if (SYMLINK_UNSUPPORTED.has(err.code)) return false; throw err; }
}

describe('writeFilesManifestIfRestricted (b021576b/e86a9cbb)', () => {
  const written = [];
  after(() => {
    while (written.length) {
      const p = written.pop();
      try { fs.unlinkSync(p); } catch { /* best-effort */ }
    }
  });

  it('null restrictFiles returns null — no manifest written', () => {
    const result = writeFilesManifestIfRestricted(null);
    assert.equal(result, null);
  });

  it('an empty array WRITES a manifest (b021576b — zero-file scope is not "unrestricted")', () => {
    const result = writeFilesManifestIfRestricted([]);
    assert.ok(result, 'must write a manifest even for a zero-file scope');
    written.push(result);
    assert.ok(fs.existsSync(result));
    assert.equal(fs.readFileSync(result, 'utf-8').trim(), '');
  });

  it('a non-empty array writes the newline-delimited file list', () => {
    const result = writeFilesManifestIfRestricted(['a.mjs', 'b/c.mjs']);
    written.push(result);
    assert.equal(fs.readFileSync(result, 'utf-8'), 'a.mjs\nb/c.mjs\n');
  });

  it('refuses to write through a pre-existing symlink at the (randomized) manifest path (e86a9cbb)', () => {
    // Simulate an attacker having pre-staged a symlink at the exact path this
    // function is about to compute — not generally possible in practice given
    // the random suffix, but this proves the `wx` flag itself closes the race
    // regardless of predictability: writeFileSync must refuse, never follow it.
    const outsideTarget = path.join(os.tmpdir(), `e86a9cbb-outside-target-${process.pid}.txt`);
    fs.writeFileSync(outsideTarget, 'pre-existing content that must survive untouched');
    written.push(outsideTarget);

    const originalRandom = Math.random;
    const originalNow = Date.now;
    let plantedLink = null;
    try {
      // Force a deterministic suffix so we can pre-stage the exact path.
      Math.random = () => 0.5;
      Date.now = () => 1234567890;
      const suffix = `${process.pid}-1234567890-${Math.floor(0.5 * 0xFFFFFF).toString(16)}`;
      plantedLink = path.join(os.tmpdir(), `arch-refresh-files-${suffix}.txt`);
      if (!trySymlink(outsideTarget, plantedLink, 'file')) return; // host can't create symlinks — skip

      assert.throws(
        () => writeFilesManifestIfRestricted(['x.mjs']),
        /EEXIST/,
        'wx must refuse to write through a pre-existing path, symlink or not',
      );
      assert.equal(
        fs.readFileSync(outsideTarget, 'utf-8'),
        'pre-existing content that must survive untouched',
        'the symlink target must never be overwritten',
      );
    } finally {
      Math.random = originalRandom;
      Date.now = originalNow;
      if (plantedLink) { try { fs.unlinkSync(plantedLink); } catch { /* best-effort */ } }
    }
  });
});

describe('shouldAttemptTimeoutRecovery', () => {
  it('true only for {mode: "full", extractionTimedOut: true}', () => {
    assert.equal(shouldAttemptTimeoutRecovery({ mode: 'full', extractionTimedOut: true }), true);
  });

  it('false for every other combination', () => {
    assert.equal(shouldAttemptTimeoutRecovery({ mode: 'incremental', extractionTimedOut: true }), false);
    assert.equal(shouldAttemptTimeoutRecovery({ mode: 'full', extractionTimedOut: false }), false);
    assert.equal(shouldAttemptTimeoutRecovery({ mode: 'incremental', extractionTimedOut: false }), false);
  });
});

describe('buildTimeoutRecovery', () => {
  const finalSymbols = [{ filePath: 'a.js' }, { filePath: 'b.js' }, { filePath: 'a.js' }];

  it('no prior snapshot (null) → both fields null, no recovery attempted', () => {
    assert.deepEqual(
      buildTimeoutRecovery({ priorForRecovery: null, finalSymbols }),
      { timeoutRecovery: null, recoveredTouchedSet: null },
    );
  });

  it('a prior snapshot with no refreshId → still both null (nothing to recover FROM)', () => {
    assert.deepEqual(
      buildTimeoutRecovery({ priorForRecovery: { refreshId: null }, finalSymbols }),
      { timeoutRecovery: null, recoveredTouchedSet: null },
    );
  });

  it('a real prior refreshId → populated shape, recoveredTouchedSet built from finalSymbols filePaths (deduped)', () => {
    const prior = { refreshId: 'prior-run-1' };
    const result = buildTimeoutRecovery({ priorForRecovery: prior, finalSymbols });
    assert.deepEqual(result.timeoutRecovery, { prior });
    assert.ok(result.recoveredTouchedSet instanceof Set);
    assert.deepEqual([...result.recoveredTouchedSet].sort(), ['a.js', 'b.js']);
  });

  it('empty finalSymbols with a real prior → an empty (not null) recoveredTouchedSet', () => {
    const prior = { refreshId: 'prior-run-2' };
    const result = buildTimeoutRecovery({ priorForRecovery: prior, finalSymbols: [] });
    assert.ok(result.recoveredTouchedSet instanceof Set);
    assert.equal(result.recoveredTouchedSet.size, 0);
  });
});
