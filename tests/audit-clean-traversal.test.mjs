/**
 * @fileoverview Traversal safety for `audit-clean.mjs::collectCandidates`.
 *
 * The defect this guards: `walk()` used `statSync`, which FOLLOWS symlinks, and
 * recursed through anything reporting `isDirectory()`. Paired with the only
 * `recurse: true` entry — whose regex is `/./`, matching every basename — a
 * symlinked `.audit-loop/cache` turned `npm run audit:clean -- --apply` into a
 * recursive delete of files OUTSIDE the repo. The trigger is not an attacker
 * but an ordinary `ln -s /mnt/big/audit-cache .audit-loop/cache`.
 *
 * Two tiers, deliberately: the COLLECTOR is unit-tested in-process, while the
 * DELETION SINK is driven through the real CLI in a subprocess — only the sink
 * can prove nothing was unlinked.
 *
 * Plan: docs/plans/audit-cleanup-traversal-safety.md
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { trySymlink } from './helpers/fs-symlink-test-utils.mjs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { collectCandidates, _internals } from '../scripts/audit-clean.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'scripts', 'audit-clean.mjs'); // absolute: cwd is the fixture, not the repo

const tmpDirs = [];
function mkTmp(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `audit-clean-${label}-`));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ }
  }
});

/** A collecting reporter — makes the diagnostic contract assertable without stderr capture. */
function spy() {
  const msgs = [];
  return { warn: (m) => msgs.push(m), msgs };
}

const AGED = new Date(Date.now() - 30 * 86400000);
function agedFile(p, content = 'x') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  fs.utimesSync(p, AGED, AGED);
  return p;
}

// M6 (code-audit r2): this file's symlinks are always directory symlinks, so
// every call site below passes 'dir' to the shared trySymlink directly rather
// than through a same-named local wrapper — a wrapper with an identical name
// and near-identical body was itself flagged as a near-duplicate of the
// helper it delegates to (compounding the exact class of drift the shared
// helper was extracted to prevent — see tests/helpers/fs-symlink-test-utils.mjs
// for the false ⟷ real-failure distinction this narrow catch preserves).

const MATCH_ALL = /./;
// The real cutoff shape: `main()` computes `Date.now() - ageDays * 86400000`.
// Using a bare `Date.now()` would classify a file written milliseconds ago as
// "aged" and make the age gate untestable.
const CUTOFF = () => Date.now() - 14 * 86400000;

describe('collectCandidates — symlinks are a boundary it never crosses', () => {
  it('THE regression: a symlinked ROOT yields no candidates and warns', (t) => {
    // The documented trigger: `ln -s /mnt/big/audit-cache .audit-loop/cache`.
    // withFileTypes alone does NOT cover this — readdirSync has already opened
    // `dir` by the time it returns Dirents, so the target's children come back
    // as normal files. Only the lstat root guard closes it.
    const root = mkTmp('root');
    const outside = path.join(root, 'outside');
    agedFile(path.join(outside, 'important.txt'), 'unrelated user data');
    const cache = path.join(root, 'cache');
    if (!trySymlink(outside, cache, 'dir')) {
      t.skip('symlink creation unavailable (needs Developer Mode/elevation) — traversal NOT verified on this host');
      return;
    }

    const out = [];
    const s = spy();
    collectCandidates(cache, MATCH_ALL, true, CUTOFF(), out, s);

    assert.deepEqual(out, [], 'a symlinked root must yield ZERO candidates — its target is outside the swept tree');
    assert.equal(s.msgs.length, 1, 'the skip must be disclosed, not silent');
    assert.match(s.msgs[0], /symlink/i);
    assert.ok(s.msgs[0].includes(cache), 'the warning must name the offending path to be actionable');
    assert.equal(fs.existsSync(path.join(outside, 'important.txt')), true);
  });

  it('a symlinked ENTRY is not traversed, and warns naming the link', (t) => {
    const root = mkTmp('entry');
    const outside = path.join(root, 'outside');
    agedFile(path.join(outside, 'important.txt'));
    const cache = path.join(root, 'cache');
    fs.mkdirSync(cache, { recursive: true });
    const link = path.join(cache, 'link');
    if (!trySymlink(outside, link, 'dir')) {
      t.skip('symlink creation unavailable — entry-traversal NOT verified on this host');
      return;
    }

    const out = [];
    const s = spy();
    collectCandidates(cache, MATCH_ALL, true, CUTOFF(), out, s);

    assert.equal(out.length, 0, 'nothing inside the link target may be collected');
    assert.ok(s.msgs.some(m => m.includes(link)), 'the skipped link must be named');
    assert.equal(fs.existsSync(path.join(outside, 'important.txt')), true);
  });

  it('the link ITSELF is never a candidate (it would be deleted under re:/./)', (t) => {
    const root = mkTmp('linkself');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    const cache = path.join(root, 'cache');
    fs.mkdirSync(cache, { recursive: true });
    const link = path.join(cache, 'link');
    if (!trySymlink(outside, link, 'dir')) {
      t.skip('symlink creation unavailable — link-deletion NOT verified on this host');
      return;
    }
    fs.lutimesSync?.(link, AGED, AGED); // age the link itself where supported

    const out = [];
    collectCandidates(cache, MATCH_ALL, true, CUTOFF(), out, spy());

    assert.equal(out.some(c => c.p === link), false,
      'guards the half-fix: stopping recursion but letting the link fall into the file branch would delete the user\'s cache link');
  });
});

describe('collectCandidates — normal behaviour is preserved', () => {
  it('real subdirectories still recurse (no over-correction into "skip all dirs")', () => {
    const cache = mkTmp('recurse');
    const nested = agedFile(path.join(cache, 'sub', 'deep', 'old.json'));

    const out = [];
    collectCandidates(cache, MATCH_ALL, true, CUTOFF(), out, spy());

    assert.deepEqual(out.map(c => c.p), [nested]);
  });

  it('recurse:false does not descend', () => {
    const cache = mkTmp('norecurse');
    agedFile(path.join(cache, 'sub', 'old.json'));
    const top = agedFile(path.join(cache, 'top.json'));

    const out = [];
    collectCandidates(cache, MATCH_ALL, false, CUTOFF(), out, spy());

    assert.deepEqual(out.map(c => c.p), [top]);
  });

  it('age and KEEP gates still exclude, through the new Dirent path', () => {
    const cache = mkTmp('gates');
    const aged = agedFile(path.join(cache, 'old.json'));
    fs.writeFileSync(path.join(cache, 'fresh.json'), 'new');            // too new
    const keep = [..._internals.KEEP][0];
    agedFile(path.join(cache, keep));                                    // aged but KEEP-listed

    const out = [];
    collectCandidates(cache, MATCH_ALL, true, CUTOFF(), out, spy());

    assert.deepEqual(out.map(c => c.p), [aged], `only the aged non-KEEP file qualifies (KEEP sample: ${keep})`);
  });
});

describe('collectCandidates — filesystem errors warn, absence is silent', () => {
  it('a real error (ENOTDIR) warns and the sweep continues', () => {
    // Portable fixture, chosen by measurement: point the walk AT a plain file.
    // `readdirSync(<file>)` throws ENOTDIR on both win32 and POSIX.
    // (The plan first specified `<file>/child`, calling it "deterministic +
    // portable" — it is not: on win32 `lstatSync` of that path returns ENOENT,
    // which this classifier correctly treats as benign, so the case silently
    // passed as "absent". Measured, not assumed.) Permission fixtures are also
    // out: they differ on Windows and are bypassed by elevated CI.
    const root = mkTmp('enotdir');
    const blocker = path.join(root, 'blocker');
    fs.writeFileSync(blocker, 'i am a file, not a directory');

    const out = [];
    const s = spy();
    assert.doesNotThrow(() => collectCandidates(blocker, MATCH_ALL, true, CUTOFF(), out, s));

    assert.equal(out.length, 0);
    assert.equal(s.msgs.length, 1, 'a real filesystem error must never read as a clean sweep');
    assert.match(s.msgs[0], /ENOTDIR/);
    assert.ok(s.msgs[0].includes(blocker), 'the warning must name the offending path');
    // Unsatisfiable against the pre-fix design: existsSync() returned true for a
    // file, then readdirSync threw UNCAUGHT out of the CLI. Regression guard.
  });

  it('a MISSING directory is silent (no crying wolf)', () => {
    const out = [];
    const s = spy();
    collectCandidates(path.join(mkTmp('absent'), 'nope'), MATCH_ALL, true, CUTOFF(), out, s);

    assert.deepEqual(out, []);
    assert.deepEqual(s.msgs, [],
      'most repos lack most TRANSIENT dirs — warning on ENOENT would fire every run and train operators to ignore the channel');
  });
});

describe('audit-clean --apply — the deletion sink, sandboxed', () => {
  /**
   * MANDATORY isolation. `main()` also calls `sweepStaleOrphanPreimages`, which
   * scans the REAL os.tmpdir() and rm's `orphan-preimage-*` worktrees older than
   * 1h — under --apply that is an irreversible delete of real files outside the
   * fixture. TRANSIENT paths are also RELATIVE (resolved from cwd). So: cwd at
   * the fixture, absolute script path, and TMPDIR/TEMP/TMP redirected.
   */
  function runApply(fixtureRoot, sandboxTmp, extraArgs = []) {
    return spawnSync(process.execPath, [CLI, '--apply', '--age-days', '0', ...extraArgs], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, TMPDIR: sandboxTmp, TEMP: sandboxTmp, TMP: sandboxTmp },
    });
  }

  it('the sandbox actually applies (a silently-failing sandbox would make the next test destructive AND green)', () => {
    const sandbox = mkTmp('sandbox-check');
    const r = spawnSync(process.execPath, ['-e', 'console.log(require("os").tmpdir())'], {
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: sandbox, TEMP: sandbox, TMP: sandbox },
    });
    assert.equal(fs.realpathSync(r.stdout.trim()), fs.realpathSync(sandbox),
      'os.tmpdir() must resolve to the throwaway dir — otherwise --apply sweeps the developer\'s real temp');
  });

  it('deletes nothing through a symlinked cache root, and says so', (t) => {
    const fixture = mkTmp('sink');
    const sandbox = mkTmp('sink-tmp');
    const outside = path.join(fixture, 'outside');
    const victim = agedFile(path.join(outside, 'important.txt'), 'unrelated user data');
    // The real shape: <fixture>/.audit-loop/cache, the one recurse:true entry.
    fs.mkdirSync(path.join(fixture, '.audit-loop'), { recursive: true });
    const cache = path.join(fixture, '.audit-loop', 'cache');
    if (!trySymlink(outside, cache, 'dir')) {
      t.skip('symlink creation unavailable — sink NOT verified on this host');
      return;
    }

    const r = runApply(fixture, sandbox);

    assert.equal(r.status, 0, `best-effort cleaner must exit 0: ${r.stderr}`);
    assert.equal(fs.existsSync(victim), true, 'THE assertion: --apply must not delete through a symlinked cache root');
    assert.equal(fs.readFileSync(victim, 'utf8'), 'unrelated user data');
    assert.equal(fs.existsSync(cache), true, 'the operator\'s cache link must survive');
    assert.match(r.stderr, /symlink/i, 'the skip must be disclosed on the real CLI, not just in-process');
  });

  it('still deletes a genuinely aged in-tree cache file (the tool must remain useful)', () => {
    const fixture = mkTmp('sink-positive');
    const sandbox = mkTmp('sink-positive-tmp');
    const doomed = agedFile(path.join(fixture, '.audit-loop', 'cache', 'stale.json'));

    const r = runApply(fixture, sandbox);

    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(doomed), false, 'guards over-correcting into "never delete anything"');
  });
});

describe('listStalePreimages — "never looked" is not "none found" (code-audit R2-M1)', () => {
  it('reports scanned:true and an array on a healthy temp dir', () => {
    const r = _internals.listStalePreimages({ warn: () => {} });
    assert.equal(r.scanned, true);
    assert.ok(Array.isArray(r.stale));
  });

  it('reports scanned:FALSE when the scan could not happen, so the caller cannot claim a count', () => {
    // A warning alone is not enough: the summary line is the authoritative-
    // looking output, and "0 stale worktree(s)" reads clean regardless of what
    // was printed above it. Drive a real failure by pointing os.tmpdir() at a
    // plain FILE (ENOTDIR — portable, per the collector's fixture).
    const root = mkTmp('preimage-fail');
    const asFile = path.join(root, 'not-a-dir');
    fs.writeFileSync(asFile, 'x');
    const orig = os.tmpdir;
    os.tmpdir = () => asFile;
    try {
      const msgs = [];
      const r = _internals.listStalePreimages({ warn: m => msgs.push(m) });
      assert.equal(r.scanned, false, 'a failed scan must be distinguishable from an empty one');
      assert.deepEqual(r.stale, []);
      assert.equal(msgs.length, 1);
      assert.match(msgs[0], /SKIPPED this run/);
    } finally {
      os.tmpdir = orig;
    }
  });
});
