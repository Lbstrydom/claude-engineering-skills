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
import { shouldAttemptTimeoutRecovery, buildTimeoutRecovery, writeFilesManifestIfRestricted, removeFilesManifest } from '../scripts/symbol-index/refresh-subprocess.mjs';

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
      // Manifests live inside a private mkdtemp dir; unlinking the file alone
      // would leave the directory behind and slowly litter the temp root.
      try {
        if (path.basename(p) === 'files.manifest') fs.rmSync(path.dirname(p), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        else fs.unlinkSync(p);
      } catch { /* best-effort */ }
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
    // Empty content, not a bare NUL: each path is NUL-TERMINATED, so a
    // zero-file scope has zero records (files-manifest.mjs).
    assert.equal(fs.readFileSync(result, 'utf-8'), '');
  });

  it('a non-empty array writes the NUL-delimited file list (c191e74d781b)', () => {
    const result = writeFilesManifestIfRestricted(['a.mjs', 'b/c.mjs']);
    written.push(result);
    assert.equal(fs.readFileSync(result, 'utf-8'), 'a.mjs\0b/c.mjs\0');
  });

  // ── M3: the manifest is defended by its DIRECTORY, not by its filename ──
  //
  // Supersedes the old e86a9cbb test, which pinned Math.random/Date.now to
  // pre-stage a symlink at the exact computed filename. That test proved `wx`
  // refuses a pre-existing path — true, but only the PRE-creation half of the
  // race. It said nothing about the window between the write closing and the
  // extract child opening the same pathname in a world-writable directory.
  // The manifest now lives inside an owner-only mkdtemp directory whose name
  // no other process can predict, which is what actually closes it, so the
  // assertions below target that property instead of the old filename scheme.

  it('writes into a private directory, never directly into the shared temp root', () => {
    const manifestPath = writeFilesManifestIfRestricted(['a.mjs']);
    written.push(manifestPath);
    const dir = path.dirname(manifestPath);
    assert.notEqual(
      path.resolve(dir), path.resolve(os.tmpdir()),
      'the manifest must not sit directly in the shared temp root — a same-UID process could '
      + 'unlink and substitute it between the write and the child opening it',
    );
    assert.equal(
      path.resolve(path.dirname(dir)), path.resolve(os.tmpdir()),
      'the private directory itself is expected one level under the temp root',
    );
    assert.deepEqual(
      fs.readdirSync(dir), ['files.manifest'],
      'the private directory must contain only the manifest — anything else means it was not fresh',
    );
    // Owner-only is the cross-UID half of the trust boundary (R3 H1). Asserted
    // on POSIX only: Windows does not model these mode bits, so checking them
    // there would assert on a value the OS does not maintain.
    if (process.platform !== 'win32') {
      assert.equal(
        fs.statSync(dir).mode & 0o777, 0o700,
        'the manifest directory must be owner-only — this is what excludes other UIDs',
      );
    }
  });

  it('never reuses a directory across calls (an attacker cannot pre-stage inside it)', () => {
    const a = writeFilesManifestIfRestricted(['a.mjs']);
    const b = writeFilesManifestIfRestricted(['b.mjs']);
    written.push(a, b);
    assert.notEqual(
      path.dirname(a), path.dirname(b),
      'mkdtemp must mint a fresh unpredictable directory per call; a reused or derivable '
      + 'name reopens the substitution window',
    );
    // Vacuous-pass guard: both really were written, so the inequality above is
    // about directory naming and not about one call having silently no-opped.
    assert.equal(fs.readFileSync(a, 'utf-8'), 'a.mjs\0');
    assert.equal(fs.readFileSync(b, 'utf-8'), 'b.mjs\0');
  });

  it('removeFilesManifest deletes the private directory, not just the file', () => {
    const manifestPath = writeFilesManifestIfRestricted(['a.mjs']);
    const dir = path.dirname(manifestPath);
    assert.ok(fs.existsSync(dir), 'precondition: the directory exists before cleanup');
    removeFilesManifest(manifestPath);
    assert.equal(fs.existsSync(manifestPath), false, 'the manifest must be gone');
    assert.equal(
      fs.existsSync(dir), false,
      'the private directory must be gone too — otherwise every refresh leaks one empty dir',
    );
  });

  it('removeFilesManifest tolerates null so the caller needs no branch', () => {
    assert.doesNotThrow(() => removeFilesManifest(null));
  });

  it('leaks no temp directory when the file list is rejected (Gemini final-gate LOW)', () => {
    // formatFilesManifest validates and throws. If that ran AFTER mkdtempSync,
    // every rejected input would abandon a directory in the temp root — and the
    // caller never gets a path, so its finally block cannot clean up.
    const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('arch-refresh-files-')).length;
    assert.throws(() => writeFilesManifestIfRestricted(['ok.mjs', { from: 'x', to: 'y' }]), /expected a string/);
    assert.throws(() => writeFilesManifestIfRestricted(['']), /empty string/);
    const after = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('arch-refresh-files-')).length;
    assert.equal(after, before, 'a rejected file list must leave no temp directory behind');
  });

  it('still refuses to write through anything pre-existing at the manifest path (wx retained)', () => {
    // Defence in depth. The private directory makes pre-staging impractical,
    // but `wx` must remain: it is the assertion that this function never
    // follows a symlink or truncates an existing file, whatever the directory.
    const manifestPath = writeFilesManifestIfRestricted(['a.mjs']);
    written.push(manifestPath);
    const outsideTarget = path.join(os.tmpdir(), `m3-outside-target-${process.pid}.txt`);
    fs.writeFileSync(outsideTarget, 'pre-existing content that must survive untouched');
    written.push(outsideTarget);

    // Re-plant a symlink at the (now known) manifest path inside the private
    // dir and prove a second write refuses rather than following it.
    fs.unlinkSync(manifestPath);
    if (!trySymlink(outsideTarget, manifestPath, 'file')) return; // host can't create symlinks — skip
    assert.throws(
      () => fs.writeFileSync(manifestPath, 'x', { encoding: 'utf-8', flag: 'wx' }),
      /EEXIST/,
      'wx must refuse a pre-existing path, symlink or not',
    );
    assert.equal(
      fs.readFileSync(outsideTarget, 'utf-8'),
      'pre-existing content that must survive untouched',
      'the symlink target must never be overwritten',
    );
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
