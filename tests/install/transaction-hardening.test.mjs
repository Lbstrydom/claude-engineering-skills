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
    const repo = mkTmp('dotdot');
    const sneaky = path.join(repo, 'sub', '..', '..', 'escaped.md');
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
