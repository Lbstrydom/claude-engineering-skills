/**
 * @fileoverview WAL-hardening regression guards for transaction.mjs.
 *
 * Distinct from transaction.test.mjs (happy paths + rollback) and
 * lifecycle.test.mjs (recovery). Every case here is a REGRESSION GUARD for a
 * specific defect found during the plan audit — each one fails against the
 * design that preceded it. Plan:
 * docs/plans/install-transaction-wal-hardening.md
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  executeTransaction,
  recoverFromJournal,
  _internals,
} from '../../scripts/lib/install/transaction.mjs';
import { acquireLock, releaseLock } from '../../scripts/lib/file-store.mjs';
import { globalSurfaceRoot } from '../../scripts/lib/install/surface-paths.mjs';

const tmpDirs = [];
function mkTmp(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `txn-hard-${label}-`));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ }
  }
});

const journalIn = (root) => path.join(root, '.audit-loop-install-txn.json');

function writeRawJournal(root, body) {
  const p = journalIn(root);
  fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  return p;
}

describe('containment — allowedRoots, not a single repoRoot (Gemini-G1)', () => {
  it('accepts a MIXED-scope journal spanning repoRoot AND the global surface root', () => {
    // THE regression guard for the audit's most dangerous defect: a single-root
    // rule rejects every global-scope write, quarantines a valid journal, and
    // (via the durable blocker) permanently blocks installs.
    const repo = mkTmp('mixed');
    const repoTarget = path.join(repo, 'in-repo.md');
    const globalTarget = path.join(globalSurfaceRoot(), 'some-skill', 'SKILL.md');

    const v = _internals.validateJournal({
      version: 1,
      stage: 'staged',
      staged: [
        { absPath: repoTarget, tmpPath: `${repoTarget}.tmp.1` },
        { absPath: globalTarget, tmpPath: `${globalTarget}.tmp.2` },
      ],
      deletes: [],
    }, [repo, globalSurfaceRoot()]);

    assert.equal(v.ok, true, `mixed-scope journal must validate, got: ${v.error}`);
  });

  it('still rejects a path outside EVERY allowed root (INC-001 protection retained)', () => {
    const repo = mkTmp('escape');
    const outside = path.join(os.tmpdir(), 'definitely-not-in-repo.md');
    const v = _internals.validateJournal({
      stage: 'staged',
      staged: [{ absPath: outside, tmpPath: `${outside}.tmp.1` }],
    }, [repo, globalSurfaceRoot()]);
    assert.equal(v.ok, false);
    assert.match(v.error, /escapes allowed roots/);
  });

  it('rejects a NON-EXISTENT target reached through a SYMLINKED ancestor (INC-001 class)', (t) => {
    const repo = mkTmp('symlink-ancestor');
    const outside = mkTmp('symlink-outside');
    const link = path.join(repo, 'generated-link');
    try {
      fs.symlinkSync(outside, link, 'dir');
    } catch (err) {
      // Windows needs Developer Mode/elevation. Skip LOUDLY — a vacuous pass
      // on a containment test is exactly the false-green we guard against.
      t.skip(`symlink creation unavailable (${err.code}) — containment-via-symlink case NOT verified on this host`);
      return;
    }
    // Lexically inside repo; canonically outside. The target does NOT exist,
    // which is why realpath-only-if-exists (the round-1 design) missed it.
    const target = path.join(link, 'new-file.md');
    assert.equal(fs.existsSync(target), false, 'precondition: target must not exist');

    assert.equal(
      _internals.isWithinAllowedRoots(target, [repo]),
      false,
      'a symlinked ancestor must not smuggle a path outside the allowed roots',
    );
  });

  it('rejects a literal ../ embedded in the un-resolved tail', () => {
    // path.join() eagerly collapses '..' segments itself, so building `sneaky`
    // with path.join would hand isWithinAllowedRoots() an already-resolved
    // absolute path outside repo — passing for the wrong reason (Gemini
    // gate G1, code-audit round). A template literal preserves the literal
    // '..' tokens so this actually exercises path.resolve()'s own collapse
    // inside the function under test, not the test's own setup.
    const repo = mkTmp('dotdot');
    const sneaky = `${repo}${path.sep}sub${path.sep}..${path.sep}..${path.sep}escaped.md`;
    assert.equal(_internals.isWithinAllowedRoots(sneaky, [repo]), false);
  });

  it('accepts an ordinary not-yet-existing path inside the repo', () => {
    const repo = mkTmp('ordinary');
    assert.equal(_internals.isWithinAllowedRoots(path.join(repo, 'a', 'b', 'c.md'), [repo]), true);
  });
});

describe('journal version compatibility (R2-H1)', () => {
  it('accepts a LEGACY versionless journal — the exact in-flight crash this exists to recover', () => {
    const repo = mkTmp('legacy');
    const t = path.join(repo, 'f.md');
    const v = _internals.validateJournal(
      { stage: 'staged', staged: [{ absPath: t, tmpPath: `${t}.tmp.1` }] },
      [repo],
    );
    assert.equal(v.ok, true, `legacy journal must remain recoverable, got: ${v.error}`);
  });

  it('rejects an explicit FUTURE version it cannot read', () => {
    const repo = mkTmp('future');
    const t = path.join(repo, 'f.md');
    const v = _internals.validateJournal(
      { version: 99, stage: 'staged', staged: [{ absPath: t, tmpPath: `${t}.tmp.1` }] },
      [repo],
    );
    assert.equal(v.ok, false);
  });
});

describe('staged-pair structural invariant (R3-H3)', () => {
  it('rejects a journal whose tmpPath is not its own absPath + .tmp.<suffix>', () => {
    const repo = mkTmp('pair');
    const a = path.join(repo, 'a.md');
    const b = path.join(repo, 'b.md');
    fs.writeFileSync(a, 'a'); fs.writeFileSync(b, 'b');
    // Both in-repo, so containment passes — only the pair invariant catches it.
    const v = _internals.validateJournal(
      { stage: 'renaming', staged: [{ absPath: b, tmpPath: a }] },
      [repo],
    );
    assert.equal(v.ok, false);
    assert.match(v.error, /tmpPath is not its own absPath/);
  });
});

describe('durable quarantine blocker (R3-H2 / Gemini-G2-H2)', () => {
  it('quarantines a corrupt journal instead of deleting it, and reports the path', () => {
    const repo = mkTmp('quarantine');
    const jp = writeRawJournal(repo, '{ this is not valid json');

    const rec = recoverFromJournal(jp, { repoRoot: repo });

    assert.equal(rec.recovered, false);
    assert.ok(rec.error, 'a corrupt journal must report an error');
    assert.ok(rec.quarantined, 'a corrupt journal must be quarantined, never deleted');
    assert.equal(fs.existsSync(rec.quarantined), true, 'the quarantined record must exist on disk');
    assert.equal(fs.existsSync(jp), false, 'the live journal is moved aside');
    // The evidence must survive — this is why we quarantine rather than delete.
    const rec2 = JSON.parse(fs.readFileSync(rec.quarantined, 'utf8'));
    assert.match(rec2.raw, /not valid json/);
    assert.equal(rec2.originJournalPath, jp);
  });

  it('an UNRESOLVED quarantined journal durably blocks a later transaction', () => {
    // The R3-H2 regression: quarantine moves the journal away, so without a
    // blocker the NEXT run sees no journal and proceeds over partial state.
    const repo = mkTmp('blocker');
    const jp = writeRawJournal(repo, '{ corrupt');
    const rec = recoverFromJournal(jp, { repoRoot: repo });
    assert.ok(rec.quarantined);
    assert.equal(fs.existsSync(jp), false, 'precondition: no live journal remains');

    const result = executeTransaction({
      writes: [{ absPath: path.join(repo, 'new.md'), content: 'x' }],
      journalPath: jp,
      repoRoot: repo,
    });

    assert.equal(result.success, false, 'must refuse while a quarantined journal is unresolved');
    assert.match(result.error, /quarantined/);
    assert.equal(fs.existsSync(path.join(repo, 'new.md')), false, 'nothing may be written while blocked');
  });

  it('unblocks once the operator removes the quarantined record', () => {
    const repo = mkTmp('unblock');
    const jp = writeRawJournal(repo, '{ corrupt');
    const rec = recoverFromJournal(jp, { repoRoot: repo });
    fs.unlinkSync(rec.quarantined); // the human resolution step

    const result = executeTransaction({
      writes: [{ absPath: path.join(repo, 'new.md'), content: 'x' }],
      journalPath: jp,
      repoRoot: repo,
    });
    assert.equal(result.success, true);
    assert.equal(fs.readFileSync(path.join(repo, 'new.md'), 'utf8'), 'x');
  });

  it('an unrelated file-store quarantine record does NOT block installs', () => {
    const repo = mkTmp('unrelated');
    const qdir = _internals.quarantineDir(repo);
    fs.mkdirSync(qdir, { recursive: true });
    fs.writeFileSync(path.join(qdir, 'bandit-state.json.123.json'), '{}');

    const result = executeTransaction({
      writes: [{ absPath: path.join(repo, 'ok.md'), content: 'y' }],
      journalPath: journalIn(repo),
      repoRoot: repo,
    });
    assert.equal(result.success, true, 'the blocker must be scoped to this journal basename');
  });
});

describe('pre-existing journal refusal (R1-H5)', () => {
  it('refuses to start when a live journal already exists', () => {
    const repo = mkTmp('preexisting');
    const t = path.join(repo, 'x.md');
    writeRawJournal(repo, { version: 1, stage: 'staged', staged: [{ absPath: t, tmpPath: `${t}.tmp.1` }], deletes: [] });

    const result = executeTransaction({
      writes: [{ absPath: path.join(repo, 'new.md'), content: 'x' }],
      journalPath: journalIn(repo),
      repoRoot: repo,
    });
    assert.equal(result.success, false);
    assert.match(result.error, /run recovery first/);
  });
});

describe('lock contention — deterministic, no test hook (R3-M2)', () => {
  it('returns the documented contention error and writes nothing while the lock is held', () => {
    // The test IS the contender: acquireLock/releaseLock are exported for
    // exactly this. No subprocess, no production hook, no timing luck.
    const repo = mkTmp('lock');
    const jp = journalIn(repo);
    const lockPath = `${jp}.lock`;
    const target = path.join(repo, 'locked.md');

    acquireLock(lockPath);
    try {
      const result = executeTransaction({
        writes: [{ absPath: target, content: 'x' }],
        journalPath: jp,
        repoRoot: repo,
      });
      assert.equal(result.success, false);
      assert.match(result.error, /another install is in progress/);
      assert.equal(fs.existsSync(target), false, 'a lock failure must be a clean no-op');
      assert.equal(fs.existsSync(jp), false, 'no journal may be written on lock failure');
    } finally {
      releaseLock(lockPath);
    }
  });

  it('succeeds once the lock is released', () => {
    const repo = mkTmp('lock-release');
    const jp = journalIn(repo);
    const lockPath = `${jp}.lock`;
    acquireLock(lockPath);
    releaseLock(lockPath);

    const result = executeTransaction({
      writes: [{ absPath: path.join(repo, 'ok.md'), content: 'x' }],
      journalPath: jp,
      repoRoot: repo,
    });
    assert.equal(result.success, true);
  });

  it('a repo-only transaction takes ONLY the repo lock (no gratuitous global lock)', () => {
    const repo = mkTmp('lock-scope-repo');
    const jp = journalIn(repo);
    executeTransaction({
      writes: [{ absPath: path.join(repo, 'a.md'), content: 'x' }],
      journalPath: jp, repoRoot: repo,
    });
    // Nothing touched the global surface, so it must not have been serialised.
    assert.equal(fs.existsSync(path.join(globalSurfaceRoot(), '.install.lock')), false);
  });

  it('releases the lock after a successful transaction', () => {
    const repo = mkTmp('lock-freed');
    const jp = journalIn(repo);
    executeTransaction({ writes: [{ absPath: path.join(repo, 'a.md'), content: 'x' }], journalPath: jp, repoRoot: repo });
    assert.equal(fs.existsSync(`${jp}.lock`), false, 'the lock must not leak past the finally');
  });
});

describe('fsync degradation is reported, never silent (R3-M1)', () => {
  // Note on what is and isn't asserted here: a genuinely benign code
  // (ENOTSUP/EINVAL) can't be produced on demand without mocking `fs` at the
  // module boundary, which this repo's testing doctrine discourages (it tests
  // the mock). So we assert the two branches we CAN produce for real — the
  // critical hard-abort and the non-critical degrade-and-report — plus the
  // allowlist's exact membership, which is what routes between them.

  it('a CRITICAL fsync failure with a non-benign cause throws (hard abort)', () => {
    const d = mkTmp('fsync-critical');
    const fd = fs.openSync(path.join(d, 'f'), 'w');
    fs.closeSync(fd); // now a stale fd — a real bug, not a capability limit
    assert.throws(
      () => _internals.fsyncFile(fd, { critical: true, what: 'journal' }),
      /fsync failed for journal/,
      'the WAL is worthless if its own write may not have landed — this must never degrade',
    );
  });

  it('a NON-CRITICAL fsync failure degrades and reports instead of throwing', () => {
    const d = mkTmp('fsync-noncritical');
    const fd = fs.openSync(path.join(d, 'f'), 'w');
    fs.closeSync(fd);
    const r = _internals.fsyncFile(fd, { critical: false, what: 'journal directory' });
    assert.equal(r.ok, false);
    assert.ok(r.degraded.code, 'a degradation must carry its errno code');
    assert.equal(r.degraded.what, 'journal directory');
  });

  it('the benign allowlist is exactly ENOTSUP + EINVAL (capability signals only)', () => {
    // Guards against re-widening it to EBADF/EPERM/EISDIR, which are real
    // faults: on a critical fsync those must abort, not silently degrade.
    const { BENIGN_FSYNC_CODES } = _internals;
    assert.deepEqual([...BENIGN_FSYNC_CODES].sort(), ['EINVAL', 'ENOTSUP']);
  });

  it('fsyncDir degrades rather than throwing on a missing directory', (t) => {
    if (process.platform === 'win32') {
      t.skip('win32 does not attempt directory fsync at all — see the no-cry-wolf case below');
      return;
    }
    const r = _internals.fsyncDir(path.join(os.tmpdir(), 'no-such-dir-' + process.pid), 'target directory');
    assert.equal(r.ok, false);
    assert.equal(r.degraded.what, 'target directory');
  });

  it('a clean install on a normal filesystem reports ZERO degradations (no crying wolf)', () => {
    // Found by an end-to-end run, not by review: before the win32 guard, every
    // Windows install emitted 4 "durability degraded" warnings, because win32
    // has no fd-level directory fsync to begin with. A warning that always
    // fires carries no information and would drown a real one.
    const repo = mkTmp('no-wolf');
    const result = executeTransaction({
      writes: [{ absPath: path.join(repo, 'a.md'), content: 'x' }],
      journalPath: journalIn(repo),
      repoRoot: repo,
    });
    assert.equal(result.success, true);
    assert.deepEqual(
      result.degradations, [],
      `an ordinary install on a healthy filesystem must be silent; got: ${JSON.stringify(result.degradations)}`,
    );
  });

  it('a successful transaction reports degradations as an array (never undefined)', () => {
    const repo = mkTmp('degradations');
    const result = executeTransaction({
      writes: [{ absPath: path.join(repo, 'a.md'), content: 'x' }],
      journalPath: journalIn(repo),
      repoRoot: repo,
    });
    assert.equal(result.success, true);
    assert.ok(Array.isArray(result.degradations), 'callers must always be able to iterate degradations');
  });
});

describe('stage tracker — the staging window leaks nothing (R2-H5)', () => {
  it('a failure PARTWAY THROUGH staging cleans up the temp files already created', () => {
    // The R2-H5 regression: the old 5-state tracker had no `staging` state, so
    // a failure here reported `journal-written` — documented as "nothing has
    // changed on disk yet" — and cleaned nothing while temp files existed.
    // Failure injected deterministically via ENOTDIR: `blocker` is a FILE, so
    // mkdirSync of `blocker/sub` throws on the second write, after the first
    // has already staged its temp file.
    const repo = mkTmp('staging-fail');
    const good = path.join(repo, 'first.md');
    const blocker = path.join(repo, 'blocker');
    fs.writeFileSync(blocker, 'i am a file, not a directory');
    const doomed = path.join(blocker, 'sub', 'second.md');

    const result = executeTransaction({
      writes: [
        { absPath: good, content: 'staged ok' },
        { absPath: doomed, content: 'cannot be staged' },
      ],
      journalPath: journalIn(repo),
      repoRoot: repo,
    });

    assert.equal(result.success, false, 'a staging failure must fail the transaction');
    // Pin the test's PREMISE: ENOTDIR proves we reached the staging-phase
    // mkdir, i.e. the failure landed inside the `staging` window with a temp
    // file already on disk. Without this, the test could silently start
    // passing by failing earlier and cleaning up nothing.
    assert.match(result.error, /ENOTDIR/, 'must fail at the staging mkdir, not earlier');

    // The load-bearing assertion: no `.tmp.` residue anywhere in the repo.
    const leaked = fs.readdirSync(repo).filter(n => n.includes('.tmp.'));
    assert.deepEqual(leaked, [], `staging-phase temp files leaked: ${leaked.join(', ')}`);
    assert.equal(fs.existsSync(good), false, 'no target may be created by a failed staging');
    assert.equal(fs.existsSync(journalIn(repo)), false, 'the journal is cleaned — nothing was renamed');
  });
});

describe('recovery surfaces skipped deletes (Gemini-G2-M1)', () => {
  it('recoverFromJournal reports an expectedSha conflict-skip instead of swallowing it', () => {
    const repo = mkTmp('recover-skip');
    const victim = path.join(repo, 'user-modified.md');
    fs.writeFileSync(victim, 'the user changed this');

    // A 'renaming'-stage journal with a delete whose expectedSha no longer matches.
    writeRawJournal(repo, {
      version: 1,
      stage: 'renaming',
      staged: [],
      deletes: [{ absPath: victim, expectedSha: 'deadbeefcafe' }],
    });

    const rec = recoverFromJournal(journalIn(repo), { repoRoot: repo });

    assert.equal(rec.recovered, true);
    assert.equal(fs.existsSync(victim), true, 'orphan protection must spare the user-modified file');
    assert.equal(rec.skippedDeletes.length, 1, 'the skip must reach the caller, not be swallowed');
    assert.match(rec.skippedDeletes[0].reason, /CONFLICT_DELETION_SKIPPED/);
    assert.equal(rec.skippedDeletes[0].absPath, victim);
  });

  it('recoverFromJournal reconciles deletes recorded in a renaming-stage journal (R1-Fix3)', () => {
    const repo = mkTmp('recover-delete');
    const orphan = path.join(repo, 'orphan.md');
    fs.writeFileSync(orphan, 'should be deleted');
    writeRawJournal(repo, {
      version: 1, stage: 'renaming', staged: [], deletes: [{ absPath: orphan, expectedSha: null }],
    });

    const rec = recoverFromJournal(journalIn(repo), { repoRoot: repo });
    assert.equal(rec.recovered, true);
    assert.equal(fs.existsSync(orphan), false, 'a crash mid-Phase-4 must still finish its deletes');
  });

  it('a LEGACY versionless journal recovers end-to-end rather than being quarantined', () => {
    const repo = mkTmp('legacy-e2e');
    const target = path.join(repo, 'rolled-forward.md');
    const tmp = `${target}.tmp.legacy`;
    fs.writeFileSync(tmp, 'content from a pre-upgrade crash');
    // No `version` field — exactly what the currently-deployed code writes.
    writeRawJournal(repo, { stage: 'renaming', staged: [{ absPath: target, tmpPath: tmp }], deletes: [] });

    const rec = recoverFromJournal(journalIn(repo), { repoRoot: repo });

    assert.equal(rec.recovered, true, 'a legacy journal must recover, not quarantine');
    assert.ok(!rec.quarantined, 'quarantining a legacy journal would destroy the crash it exists to fix');
    assert.equal(rec.rolledForward, 1);
    assert.equal(fs.readFileSync(target, 'utf8'), 'content from a pre-upgrade crash');
  });
});

describe('journal writes carry the current version (R2-H1)', () => {
  it('writeJournal stamps version so a future reader can reject what it cannot parse', () => {
    const repo = mkTmp('stamp');
    const jp = journalIn(repo);
    _internals.writeJournal(jp, { stage: 'staged', staged: [], deletes: [] });
    const body = JSON.parse(fs.readFileSync(jp, 'utf8'));
    assert.equal(body.version, _internals.JOURNAL_VERSION);
  });
});

describe('writeJournal cleans up its temp file when the final rename fails (0b7661a0/22bb5573/aea521d8/ee735643)', () => {
  it('an exhausted-retry rename failure does not leak the .tmp.* journal file', () => {
    // Subprocess pattern (matches every other renameSync-failure test in this
    // file) so the monkeypatch never leaks into other tests sharing the
    // process-global fs module.
    const repo = mkTmp('journal-rename-fails');
    const jp = journalIn(repo);
    const txnUrl = pathToFileURL(path.join(process.cwd(), 'scripts/lib/install/transaction.mjs')).href;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import path from 'node:path';
      const jp = ${JSON.stringify(jp)};
      const real = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (String(to) === jp) {
          // Non-retryable code (retrySync only retries EPERM/EBUSY) — fails
          // on the first attempt, matching an exhausted-retry outcome.
          throw Object.assign(new Error('EACCES: forced journal-rename failure'), { code: 'EACCES' });
        }
        return real(from, to);
      };
      const { _internals } = await import(${JSON.stringify(txnUrl)});
      let threw = false;
      try {
        _internals.writeJournal(jp, { stage: 'staged', staged: [], deletes: [] });
      } catch { threw = true; }
      const dir = fs.readdirSync(path.dirname(jp));
      const leaked = dir.filter((f) => f.startsWith(path.basename(jp) + '.tmp.'));
      console.log(JSON.stringify({ threw, leaked }));
    `], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 });

    let out;
    try { out = JSON.parse((r.stdout || '').trim().split('\n').pop()); }
    catch { assert.fail(`probe failed: ${r.stdout}\n${r.stderr}`); }

    assert.equal(out.threw, true, 'writeJournal must still propagate the rename failure');
    assert.deepEqual(out.leaked, [], `no .tmp.* journal file may remain on disk: ${JSON.stringify(out.leaked)}`);
  });
});

describe('the lock covers the SHARED global surface, not just the repo (code-audit H6)', () => {
  // A transaction legitimately spans repoRoot AND ~/.claude/skills. The
  // repo-local journal lock serialises same-repo installs only — two DIFFERENT
  // consumer repos would each hold their own journal lock while racing the same
  // global skill paths. Driven as a subprocess so HOME can be redirected: the
  // real global surface must never be touched by a test.
  const probe = (body) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lockhome-'));
    tmpDirs.push(home);
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', body], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    return r;
  };

  it('blocks a DIFFERENT repo while the global surface lock is held, then allows it', () => {
    const txnUrl = pathToFileURL(path.join(process.cwd(), 'scripts/lib/install/transaction.mjs')).href;
    const spUrl = pathToFileURL(path.join(process.cwd(), 'scripts/lib/install/surface-paths.mjs')).href;
    const fsUrl = pathToFileURL(path.join(process.cwd(), 'scripts/lib/file-store.mjs')).href;
    const r = probe(`
      import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
      const { executeTransaction } = await import(${JSON.stringify(txnUrl)});
      const { globalSurfaceRoot } = await import(${JSON.stringify(spUrl)});
      const { acquireLock, releaseLock } = await import(${JSON.stringify(fsUrl)});
      const repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'repoB-'));
      const gRoot = globalSurfaceRoot();
      fs.mkdirSync(gRoot, { recursive: true });
      const globalLock = path.join(gRoot, '.install.lock');
      const target = path.join(gRoot, 'demo', 'SKILL.md');
      // A global-scoped transaction anchors its journal — and so its journal
      // lock — globally. Asserting on a repo-local lock path here would pass
      // vacuously, since no such lock is ever taken for this transaction.
      const jLock = path.join(os.homedir(), '.audit-loop-install-txn.json.lock');
      acquireLock(globalLock);
      let blocked, wroteNothing, lockLeaked;
      try {
        const r1 = executeTransaction({ writes: [{ absPath: target, content: 'B' }], repoRoot: repoB });
        blocked = r1.success === false && /another install is in progress/.test(r1.error || '');
        wroteNothing = !fs.existsSync(target);
        lockLeaked = fs.existsSync(jLock);
      } finally { releaseLock(globalLock); }
      const r2 = executeTransaction({ writes: [{ absPath: target, content: 'B' }], repoRoot: repoB });
      console.log(JSON.stringify({ blocked, wroteNothing, lockLeaked, thenSucceeds: r2.success, globalLockCleaned: !fs.existsSync(globalLock) }));
      fs.rmSync(repoB, { recursive: true, force: true });
    `);
    const line = (r.stdout || '').trim().split('\n').pop();
    let out;
    try { out = JSON.parse(line); } catch { assert.fail(`probe failed: ${r.stdout}\n${r.stderr}`); }

    assert.equal(out.blocked, true, 'a second repo must not race the shared global surface');
    assert.equal(out.wroteNothing, true, 'a blocked transaction must be a clean no-op');
    assert.equal(out.lockLeaked, false, 'the journal lock must be released when the global surface lock fails');
    assert.equal(out.thenSucceeds, true, 'the install proceeds once the global lock frees');
    assert.equal(out.globalLockCleaned, true, 'the global lock must not leak');
  });
});

describe('the WAL barrier: journal durable BEFORE any target mutation', () => {
  it('a valid renaming-stage journal already exists when the first target rename fires', () => {
    // The contract that makes this module a WAL at all — "created + fsynced
    // before any write occurs". Asserting it needs an observation DURING the
    // transaction: post-hoc state cannot distinguish a real WAL from an
    // implementation that writes the journal after the targets, or none at all.
    // So intercept the filesystem seam in a subprocess and look at the disk at
    // the instant of the first target rename.
    const repo = mkTmp('wal-order');
    const txnUrl = pathToFileURL(path.join(process.cwd(), 'scripts/lib/install/transaction.mjs')).href;
    const jp = journalIn(repo);
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      const jp = ${JSON.stringify(jp)};
      const realRename = fs.renameSync;
      let observed = null;
      fs.renameSync = (from, to) => {
        // Ignore the journal's own tmp->journal rename; we want the first TARGET.
        if (observed === null && String(to) !== jp) {
          let journal = null;
          try { journal = JSON.parse(fs.readFileSync(jp, 'utf8')); } catch { /* absent/corrupt */ }
          observed = {
            journalExisted: journal !== null,
            stage: journal?.stage ?? null,
            recordsThisTarget: (journal?.staged || []).some(s => s.absPath === String(to)),
            targetNotYetWritten: !fs.existsSync(String(to)),
          };
        }
        return realRename(from, to);
      };
      const { executeTransaction } = await import(${JSON.stringify(txnUrl)});
      const res = executeTransaction({
        writes: [{ absPath: ${JSON.stringify(path.join(repo, 'target.md'))}, content: 'x' }],
        deletes: [], repoRoot: ${JSON.stringify(repo)},
      });
      console.log(JSON.stringify({ ...observed, success: res.success }));
    `], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 });

    const out = JSON.parse((r.stdout || '').trim().split('\n').pop());
    assert.equal(out.success, true, `transaction must succeed: ${r.stderr}`);
    assert.equal(out.journalExisted, true, 'the WAL must be on disk before the first target is mutated');
    assert.equal(out.stage, 'renaming', 'and must already record that renaming has begun');
    assert.equal(out.recordsThisTarget, true, 'and must name the very target about to be renamed');
    assert.equal(out.targetNotYetWritten, true, 'sanity: this really is the pre-mutation instant');
  });
});

describe('recovery reports degradations through the same channel (code-audit R2-H2)', () => {
  it('recoverFromJournal always returns a degradations array', () => {
    // Recovery performs the same renames as the transaction, so it needs the
    // same fsync barrier AND the same reporting — otherwise the "never silent"
    // guarantee has a hole on exactly the crash path it exists to serve.
    const repo = mkTmp('recover-degradations');
    const target = path.join(repo, 'x.md');
    const tmp = `${target}.tmp.1`;
    fs.writeFileSync(tmp, 'pending');
    writeRawJournal(repo, { version: 1, stage: 'renaming', staged: [{ absPath: target, tmpPath: tmp }], deletes: [] });

    const rec = recoverFromJournal(journalIn(repo), { repoRoot: repo });

    assert.equal(rec.recovered, true);
    assert.ok(Array.isArray(rec.degradations), 'callers must always be able to iterate rec.degradations');
    assert.deepEqual(rec.degradations, [], 'a healthy filesystem recovery must be silent');
  });

  it('the no-journal result also carries the array (uniform shape for the caller)', () => {
    const repo = mkTmp('recover-none');
    const rec = recoverFromJournal(journalIn(repo), { repoRoot: repo });
    assert.equal(rec.recovered, false);
    assert.deepEqual(rec.degradations, []);
    assert.ok(!rec.error, 'no journal is the benign case — it must not look like a failure');
  });
});

describe('a crashed run does not block installs forever (code-audit R4-H2)', () => {
  it('a STALE lock left by a SIGKILLed install is broken automatically', () => {
    // releaseLock cannot run through SIGKILL/power loss, so the primitive's
    // stale-age takeover is what stops an orphaned lock blocking forever. That
    // is also precisely why the 60s default is right and R1's 300_000 was not:
    // a longer age prolongs exactly this window.
    const repo = mkTmp('stale-lock');
    const jp = journalIn(repo);
    const lockPath = `${jp}.lock`;
    // A lock whose recorded timestamp is 10 minutes old — what a killed process leaves.
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `999999\n${Date.now() - 600_000}`);

    const result = executeTransaction({
      writes: [{ absPath: path.join(repo, 'a.md'), content: 'x' }],
      journalPath: jp, repoRoot: repo,
    });

    assert.equal(result.success, true, 'a stale lock must be broken, not honoured forever');
    assert.equal(fs.readFileSync(path.join(repo, 'a.md'), 'utf8'), 'x');
  });

  it('a FRESH lock is still honoured (staleness must not mean "ignore the lock")', () => {
    const repo = mkTmp('fresh-lock');
    const jp = journalIn(repo);
    const lockPath = `${jp}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `999999\n${Date.now()}`);

    const result = executeTransaction({
      writes: [{ absPath: path.join(repo, 'a.md'), content: 'x' }],
      journalPath: jp, repoRoot: repo,
    });
    assert.equal(result.success, false, 'a live holder must still win');
    assert.match(result.error, /another install is in progress/);
  });
});

// ─── cleanup-failure-distinction plan (docs/plans/transaction-wal-cleanup-failure-distinction.md) ───

describe('Phase 1 snapshot loop — no existsSync probe, classified read only', () => {
  it('a genuinely absent target reads undefined via readFileSync ENOENT alone', () => {
    const repo = mkTmp('snap-absent');
    const target = path.join(repo, 'never-existed.md');
    const result = executeTransaction({
      writes: [{ absPath: target, content: 'new content' }],
      journalPath: journalIn(repo), repoRoot: repo,
    });
    assert.equal(result.success, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'new content');
  });

  it('Phase 1 adds no SECOND existsSync probe on the snapshot target — the TOCTOU race is gone by construction', () => {
    // existsSync(target) legitimately fires ONCE already, from the unrelated,
    // pre-existing containment/scope check (touchesGlobalSurface ->
    // isWithinAllowedRoots), which runs before Phase 1 and this plan does not
    // touch. Before this fix, Phase 1's OWN snapshot loop added a SECOND,
    // redundant existsSync(w.absPath) probe followed by a separate read —
    // the TOCTOU gap. This test asserts that second call is gone: the target
    // is existsSync-probed at most once in the whole transaction.
    const repo = mkTmp('snap-toctou');
    const target = path.join(repo, 'x.md');
    fs.writeFileSync(target, 'original');
    const txnUrl = pathToFileURL(path.join(process.cwd(), 'scripts/lib/install/transaction.mjs')).href;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      const target = ${JSON.stringify(target)};
      let existsSyncCallsOnTarget = 0;
      const real = fs.existsSync;
      fs.existsSync = (p, ...rest) => {
        if (String(p) === target) existsSyncCallsOnTarget++;
        return real(p, ...rest);
      };
      const { executeTransaction } = await import(${JSON.stringify(txnUrl)});
      const res = executeTransaction({
        writes: [{ absPath: target, content: 'updated' }],
        repoRoot: ${JSON.stringify(repo)},
      });
      console.log(JSON.stringify({ existsSyncCallsOnTarget, success: res.success }));
    `], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 });
    const out = JSON.parse((r.stdout || '').trim().split('\n').pop());
    assert.equal(out.success, true, `transaction must succeed: ${r.stderr}`);
    assert.equal(out.existsSyncCallsOnTarget, 1, 'the target must be existsSync-probed exactly once (containment only) — Phase 1 must add no second, redundant probe');
  });

  it('a non-ENOENT snapshot read failure aborts BEFORE any journal write, staging, or mutation', () => {
    // A directory where a file is expected forces EISDIR on readFileSync,
    // deterministically and portably (no chmod/EACCES cross-platform concerns).
    const repo = mkTmp('snap-eisdir');
    const target = path.join(repo, 'a-directory');
    fs.mkdirSync(target);
    const other = path.join(repo, 'unrelated.md');
    fs.writeFileSync(other, 'must remain untouched');

    const result = executeTransaction({
      writes: [
        { absPath: other, content: 'should never be written' },
        { absPath: target, content: 'cannot snapshot a directory' },
      ],
      journalPath: journalIn(repo), repoRoot: repo,
    });

    assert.equal(result.success, false, 'a non-ENOENT snapshot read failure must abort the whole transaction');
    assert.equal(fs.existsSync(journalIn(repo)), false, 'no journal may be written on a precondition abort');
    assert.equal(fs.readFileSync(other, 'utf8'), 'must remain untouched', 'no partial mutation of other targets');
    const leaked = fs.readdirSync(repo).filter(n => n.includes('.tmp.'));
    assert.deepEqual(leaked, [], `precondition abort must leave zero .tmp residue: ${leaked.join(', ')}`);
  });
});

describe('attemptDelete() — discriminated result, kind is the sole discriminant', () => {
  it('kind: absent when the target does not exist', () => {
    const repo = mkTmp('ad-absent');
    const r = _internals.attemptDelete({ absPath: path.join(repo, 'nope.md') });
    assert.deepEqual(r, { kind: 'absent' });
  });

  it('kind: deleted (no degradation) on a normal successful unlink', () => {
    const repo = mkTmp('ad-deleted');
    const target = path.join(repo, 'x.md');
    fs.writeFileSync(target, 'x');
    const r = _internals.attemptDelete({ absPath: target });
    assert.equal(r.kind, 'deleted');
    assert.equal(fs.existsSync(target), false);
  });

  it('kind: conflict-skipped when expectedSha mismatches (user-modified)', () => {
    const repo = mkTmp('ad-conflict');
    const target = path.join(repo, 'x.md');
    fs.writeFileSync(target, 'user changed this');
    const r = _internals.attemptDelete({ absPath: target, expectedSha: 'deadbeefcafe' });
    assert.equal(r.kind, 'conflict-skipped');
    assert.match(r.reason, /CONFLICT_DELETION_SKIPPED/);
    assert.equal(fs.existsSync(target), true, 'orphan protection must spare the user-modified file');
  });

  it('kind: delete-failed when unlink genuinely fails (target is a non-empty directory)', () => {
    const repo = mkTmp('ad-failed');
    const dir = path.join(repo, 'not-a-file');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'child.md'), 'x'); // non-empty -> unlinkSync on the dir fails
    const r = _internals.attemptDelete({ absPath: dir });
    assert.equal(r.kind, 'delete-failed');
    assert.match(r.reason, /DELETE_FAILED/);
  });
});

describe('normal-completion delete-failure gating — kind-based, not reason-string (round-4 M1, round-6 M1, round-7 M1)', () => {
  it('a kind:delete-failed outcome retains the journal and surfaces deleteFailures', () => {
    const repo = mkTmp('normal-delete-failed');
    const dir = path.join(repo, 'blocked-delete');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'child.md'), 'x'); // forces DELETE_FAILED via ENOTEMPTY

    const result = executeTransaction({
      writes: [{ absPath: path.join(repo, 'new.md'), content: 'x' }],
      deletes: [{ absPath: dir }],
      journalPath: journalIn(repo), repoRoot: repo,
    });

    assert.equal(result.success, true, 'the writes/renames genuinely succeeded');
    assert.equal(result.deleteFailures.length, 1, 'deleteFailures must be unconditionally present and populated');
    assert.equal(fs.existsSync(journalIn(repo)), true, 'the journal must be retained, not cleaned up');
  });

  it('a kind:conflict-skipped outcome does NOT retain the journal', () => {
    const repo = mkTmp('normal-conflict-skipped');
    const victim = path.join(repo, 'victim.md');
    fs.writeFileSync(victim, 'user-modified');

    const result = executeTransaction({
      writes: [{ absPath: path.join(repo, 'new.md'), content: 'x' }],
      deletes: [{ absPath: victim, expectedSha: 'deadbeefcafe' }],
      journalPath: journalIn(repo), repoRoot: repo,
    });

    assert.equal(result.success, true);
    assert.equal(result.deleteFailures.length, 0, 'a conflict-skip is a complete, non-failure outcome');
    assert.equal(fs.existsSync(journalIn(repo)), false, 'cleanup must proceed on a conflict-skip alone');
    assert.equal(fs.existsSync(victim), true);
  });

  it('deleteFailures is present (empty array) even on a fail() result — never undefined', () => {
    const repo = mkTmp('normal-fail-deletefailures');
    writeRawJournal(repo, { version: 1, stage: 'staged', staged: [], deletes: [] }); // pre-flight block
    const result = executeTransaction({
      writes: [{ absPath: path.join(repo, 'new.md'), content: 'x' }],
      journalPath: journalIn(repo), repoRoot: repo,
    });
    assert.equal(result.success, false);
    assert.deepEqual(result.deleteFailures, [], 'fail() must carry deleteFailures unconditionally, matching skippedDeletes/degradations');
  });
});

describe('cleanupJournal() context-aware messaging (Gemini gate round-1 finding G2)', () => {
  it('a normal-completion cleanup failure logs "success" context, never "rollback"', () => {
    const repo = mkTmp('cleanup-ctx-success');
    const jp = journalIn(repo);
    const txnUrl = pathToFileURL(path.join(process.cwd(), 'scripts/lib/install/transaction.mjs')).href;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      const jp = ${JSON.stringify(jp)};
      const real = fs.unlinkSync;
      fs.unlinkSync = (p) => {
        if (String(p) === jp) throw Object.assign(new Error('EBUSY: forced cleanup failure'), { code: 'EBUSY' });
        return real(p);
      };
      let captured = '';
      const origWrite = process.stderr.write;
      process.stderr.write = (chunk, ...args) => { captured += chunk; return origWrite.call(process.stderr, chunk, ...args); };
      const { executeTransaction } = await import(${JSON.stringify(txnUrl)});
      const result = executeTransaction({
        writes: [{ absPath: ${JSON.stringify(path.join(repo, 'new.md'))}, content: 'x' }],
        journalPath: jp, repoRoot: ${JSON.stringify(repo)},
      });
      process.stderr.write = origWrite;
      console.log(JSON.stringify({ success: result.success, captured }));
    `], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 });

    let out;
    try { out = JSON.parse((r.stdout || '').trim().split('\n').pop()); }
    catch { assert.fail(`probe failed: ${r.stdout}\n${r.stderr}`); }

    assert.equal(out.success, true, 'the install itself must still succeed despite the cleanup failure');
    assert.match(out.captured, /a successful install/, 'a success-context cleanup failure must say so');
    assert.doesNotMatch(out.captured, /rollback completed/i, 'a normal install failure must NEVER claim a rollback occurred (Gemini G2)');
  });
});

describe('rollback-failed marker — retained-and-marked, not quarantined (round-4/5/6 H1)', () => {
  // Both targets are plain files under repo/, so Phase 2 (staging) succeeds
  // for both. A subprocess fs.renameSync patch then: (a) fails the SECOND
  // target's Phase-3 rename (forcing the catch with stage === 'renaming' and
  // 'good' already in writtenPaths from its own successful Phase-3 rename),
  // and (b) fails the FIRST target's rename the second time it's called —
  // which is rollback's own restore attempt. This is the only way to inject
  // a failure inside rollbackPartialTransaction(), which is not exported.
  it('a rollback restore failure marks the journal rollback-failed AT ITS ORIGINAL PATH, blocking future installs, without recoverFromJournal ever rolling it forward', () => {
    const repo = mkTmp('rollback-failed-marker');
    const good = path.join(repo, 'first.md');
    fs.writeFileSync(good, 'original content');
    const doomed = path.join(repo, 'second.md');
    const jp = journalIn(repo);

    const txnUrl = pathToFileURL(path.join(process.cwd(), 'scripts/lib/install/transaction.mjs')).href;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      const good = ${JSON.stringify(good)};
      const doomed = ${JSON.stringify(doomed)};
      let goodRenamedOnce = false;
      const real = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (String(to) === doomed) {
          throw Object.assign(new Error('EACCES: forced Phase-3 failure on second target'), { code: 'EACCES' });
        }
        if (String(to) === good) {
          if (goodRenamedOnce) {
            throw Object.assign(new Error('EACCES: forced rollback-restore failure'), { code: 'EACCES' });
          }
          goodRenamedOnce = true;
        }
        return real(from, to);
      };
      const { executeTransaction, recoverFromJournal } = await import(${JSON.stringify(txnUrl)});
      const res = executeTransaction({
        writes: [
          { absPath: good, content: 'updated content' },
          { absPath: doomed, content: 'never gets renamed into place' },
        ],
        journalPath: ${JSON.stringify(jp)}, repoRoot: ${JSON.stringify(repo)},
      });
      const journalExists = fs.existsSync(${JSON.stringify(jp)});
      const journalBody = journalExists ? JSON.parse(fs.readFileSync(${JSON.stringify(jp)}, 'utf8')) : null;
      const blockedRetry = executeTransaction({
        writes: [{ absPath: ${JSON.stringify(path.join(repo, 'another.md'))}, content: 'y' }],
        journalPath: ${JSON.stringify(jp)}, repoRoot: ${JSON.stringify(repo)},
      });
      const rec = recoverFromJournal(${JSON.stringify(jp)}, { repoRoot: ${JSON.stringify(repo)} });
      console.log(JSON.stringify({
        txnSuccess: res.success,
        rollbackFailures: res.rollbackFailures,
        journalExists, stage: journalBody?.stage ?? null,
        blockedRetrySuccess: blockedRetry.success, blockedRetryError: blockedRetry.error,
        recRecovered: rec.recovered, recRolledForward: rec.rolledForward, recError: rec.error,
      }));
    `], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 });

    let out;
    try { out = JSON.parse((r.stdout || '').trim().split('\n').pop()); }
    catch { assert.fail(`probe failed: ${r.stdout}\n${r.stderr}`); }

    assert.equal(out.txnSuccess, false, 'the original transaction must fail (Phase 3 blocked on the second target)');
    assert.ok(out.rollbackFailures && out.rollbackFailures.length > 0, `the forced restore failure must be reported: ${JSON.stringify(out)}`);
    assert.equal(out.journalExists, true, 'the journal must remain AT ITS ORIGINAL PATH — not quarantined, not deleted');
    assert.equal(out.stage, 'rollback-failed', 'the on-disk stage must no longer read renaming');
    assert.equal(out.blockedRetrySuccess, false, 'the pre-flight check must block a subsequent install');
    assert.equal(out.recRecovered, false, 'recoverFromJournal must refuse to act on a rollback-failed journal');
    assert.equal(out.recRolledForward, 0, 'recovery must NEVER roll this transaction forward');
    assert.match(out.recError, /rollback/, 'the refusal must explain why');
  });
});

describe('ENOENT scoping in rollback restore — Gemini gate round-2 finding G1 (data-loss regression guard)', () => {
  // The critical correction: ENOENT is safe-to-ignore only in the DELETE
  // sub-branch (snapshot === undefined). In the RESTORE sub-branch (writing
  // back captured content), ENOENT means the restore genuinely failed and
  // must be reported, never silently treated as success.
  it('ENOENT while restoring a captured snapshot is a REAL failure, not exempted', () => {
    const repo = mkTmp('rollback-enoent-restore');
    const restoreTarget = path.join(repo, 'existing.md');
    fs.writeFileSync(restoreTarget, 'must be restored on rollback');
    const doomed = path.join(repo, 'second.md');
    const jp = journalIn(repo);

    const txnUrl = pathToFileURL(path.join(process.cwd(), 'scripts/lib/install/transaction.mjs')).href;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      const restoreTarget = ${JSON.stringify(restoreTarget)};
      const doomed = ${JSON.stringify(doomed)};
      // Both targets stage successfully; force the SECOND target's Phase-3
      // rename to fail (after the first's own Phase-3 rename already
      // succeeded), then force rollback's restore write for the FIRST target
      // to throw ENOENT — the data-loss scenario a missing parent directory
      // would produce for real.
      const realRename = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (String(to) === doomed) {
          throw Object.assign(new Error('EACCES: forced Phase-3 failure on second target'), { code: 'EACCES' });
        }
        return realRename(from, to);
      };
      const realWrite = fs.writeFileSync;
      fs.writeFileSync = (p, content, ...rest) => {
        if (String(p).includes(restoreTarget + '.tmp.')) {
          throw Object.assign(new Error('ENOENT: forced restore failure'), { code: 'ENOENT' });
        }
        return realWrite(p, content, ...rest);
      };
      const { executeTransaction } = await import(${JSON.stringify(txnUrl)});
      const res = executeTransaction({
        writes: [
          { absPath: restoreTarget, content: 'updated content' },
          { absPath: doomed, content: 'never gets renamed into place' },
        ],
        journalPath: ${JSON.stringify(jp)}, repoRoot: ${JSON.stringify(repo)},
      });
      console.log(JSON.stringify({ success: res.success, rollbackFailures: res.rollbackFailures }));
    `], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 });

    let out;
    try { out = JSON.parse((r.stdout || '').trim().split('\n').pop()); }
    catch { assert.fail(`probe failed: ${r.stdout}\n${r.stderr}`); }

    assert.equal(out.success, false);
    assert.ok(
      out.rollbackFailures && out.rollbackFailures.some(f => f.absPath === restoreTarget),
      `an ENOENT during snapshot RESTORE must be reported as a rollback failure (data-loss guard), got: ${JSON.stringify(out.rollbackFailures)}`,
    );
  });

  it('ENOENT while deleting a never-existed target (undefined snapshot) is exempted (benign TOCTOU)', () => {
    // This is the delete sub-branch's legitimate exemption: writtenPaths only
    // ever contains already-renamed files, so this documents the contract via
    // a direct successful-rollback case (no injected failure needed) — the
    // undefined-snapshot path deletes a brand-new file cleanly.
    const repo = mkTmp('rollback-enoent-delete');
    const blocker = path.join(repo, 'blocker');
    fs.writeFileSync(blocker, 'i am a file, not a directory');
    const doomed = path.join(blocker, 'sub', 'second.md');
    const brandNew = path.join(repo, 'brand-new.md');

    const result = executeTransaction({
      writes: [
        { absPath: brandNew, content: 'never existed before' },
        { absPath: doomed, content: 'cannot be staged' },
      ],
      journalPath: journalIn(repo), repoRoot: repo,
    });

    assert.equal(result.success, false);
    assert.equal(fs.existsSync(brandNew), false, 'the rolled-back new file must be gone');
    assert.deepEqual(result.rollbackFailures, [], 'a clean delete-branch rollback must report zero failures');
  });
});

describe('staged-discard proportionality — Gemini gate round-2 finding G2', () => {
  it('a tmp-unlink failure during staged-stage recovery does NOT block cleanupJournal', () => {
    const repo = mkTmp('staged-discard-proportional');
    const target = path.join(repo, 'x.md');
    const tmp = `${target}.tmp.1`;
    fs.mkdirSync(tmp); // a DIRECTORY at the tmp path -> unlinkSync fails (ENOTEMPTY/EPERM), not ENOENT
    fs.writeFileSync(path.join(tmp, 'child'), 'x');
    writeRawJournal(repo, { version: 1, stage: 'staged', staged: [{ absPath: target, tmpPath: tmp }], deletes: [] });

    const rec = recoverFromJournal(journalIn(repo), { repoRoot: repo });

    assert.equal(rec.recovered, true);
    assert.equal(fs.existsSync(journalIn(repo)), false, 'a harmless leaked .tmp must NEVER block journal cleanup');
    assert.equal(rec.recoveryFailures.length, 0, 'staged-discard failures must never populate recoveryFailures');
    assert.ok(rec.degradations.some(d => String(d.what).includes(tmp)), 'the failure must still be reported, non-blocking, via degradations');
  });
});

describe('reconcileJournals() exits on recoveryFailures (round-1 H3, round-7 M1 field name)', () => {
  it('a non-empty recoveryFailures list from recoverFromJournal aborts before any new transaction', () => {
    // HOME/USERPROFILE are redirected so reconcileJournals()'s scan of the
    // GLOBAL journal anchor never touches real machine state (matching the
    // "shared global surface" test's own convention above).
    const repo = mkTmp('reconcile-exit');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcilehome-'));
    tmpDirs.push(home);
    const target = path.join(repo, 'x.md');
    const tmp = `${target}.tmp.1`;
    fs.writeFileSync(tmp, 'pending');
    writeRawJournal(repo, {
      version: 1,
      stage: 'renaming',
      staged: [{ absPath: target, tmpPath: tmp }],
      deletes: [],
    });

    const modUrl = pathToFileURL(path.join(process.cwd(), 'scripts/install-skills.mjs')).href;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      const target = ${JSON.stringify(target)};
      const real = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (String(to) === target) {
          throw Object.assign(new Error('EACCES: forced roll-forward failure'), { code: 'EACCES' });
        }
        return real(from, to);
      };
      const { _internals } = await import(${JSON.stringify(modUrl)});
      let exited = false, exitCode = null;
      const origExit = process.exit;
      process.exit = (code) => { exited = true; exitCode = code; throw new Error('__EXIT__'); };
      try {
        _internals.reconcileJournals(${JSON.stringify(repo)});
      } catch (e) {
        if (e.message !== '__EXIT__') throw e;
      } finally {
        process.exit = origExit;
      }
      console.log(JSON.stringify({ exited, exitCode }));
    `], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });

    let out;
    try { out = JSON.parse((r.stdout || '').trim().split('\n').pop()); }
    catch { assert.fail(`probe failed: ${r.stdout}\n${r.stderr}`); }

    assert.equal(out.exited, true, `reconcileJournals must call process.exit on a non-empty recoveryFailures list: ${JSON.stringify(out)}`);
    assert.equal(out.exitCode, 1);
  });
});
