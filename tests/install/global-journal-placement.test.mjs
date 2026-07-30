/**
 * @fileoverview The stranded-global-journal guard — cross-repo WAL placement.
 *
 * THE DEFECT THIS EXISTS FOR: a mixed-scope transaction mutates BOTH `<repoRoot>`
 * and the SHARED `~/.claude/skills/` surface, but wrote its journal only to
 * `<repoRoot>/`. Repo A crashing mid-global-rename therefore stranded the only
 * recovery record inside repo A — invisible to repo B, whose reconcile scan
 * covers only its own root and the home dir. Repo B then broke A's stale global
 * lock (60s) and installed straight over the half-applied global state,
 * falsifying the plan's own guarantee that an unresolved partial transaction
 * durably blocks installs.
 *
 * These cases are driven as real subprocesses with a REDIRECTED HOME: the crash
 * has to be a genuine process death (no catch, no finally, no lock release), and
 * the real `~/.claude/skills` must never be touched.
 *
 * Plan: docs/plans/install-transaction-wal-hardening.md
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { recoverFromJournal, _internals } from '../../scripts/lib/install/transaction.mjs';
import { globalSurfaceRoot } from '../../scripts/lib/install/surface-paths.mjs';

const REPO = process.cwd();
const TXN_URL = pathToFileURL(path.join(REPO, 'scripts', 'lib', 'install', 'transaction.mjs')).href;
const INSTALL_URL = pathToFileURL(path.join(REPO, 'scripts', 'install-skills.mjs')).href;

const tmpDirs = [];
function mkTmp(label) {
  // realpathSync: macOS/Windows temp dirs are symlinked (/var -> /private/var),
  // and containment resolves symlinks — an unresolved root would false-fail.
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `gjp-${label}-`)));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ }
  }
});

/** Env for a child that must believe `home` is the user's home directory. */
const homeEnv = (home) => ({ ...process.env, HOME: home, USERPROFILE: home });

const skillsRoot = (home) => path.join(home, '.claude', 'skills');
const globalTarget = (home, name) => path.join(skillsRoot(home), 'demo', name);

function runNode(script, home) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO, encoding: 'utf8', timeout: 60_000, env: homeEnv(home),
  });
}

/**
 * Repo A: start a mixed-scope transaction and HARD-CRASH after the first rename
 * lands in the global surface. `process.exit` unwinds nothing — no catch, no
 * finally, no lock release — which is exactly the crash the WAL exists for.
 */
function crashMidGlobalRename(repoRoot, home, tag) {
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import os from 'node:os';
    const skills = path.join(os.homedir(), '.claude', 'skills');
    const realRename = fs.renameSync;
    fs.renameSync = (from, to) => {
      const r = realRename(from, to);
      // Crash only on a rename INTO the global surface (never the journal's own).
      if (String(to).startsWith(skills)) process.exit(137);
      return r;
    };
    const { executeTransaction } = await import(${JSON.stringify(TXN_URL)});
    executeTransaction({
      writes: [
        { absPath: ${JSON.stringify(path.join(repoRoot, 'in-repo.md'))}, content: 'repo-${tag}' },
        { absPath: path.join(skills, 'demo', 'one.md'), content: 'global-one-${tag}' },
        { absPath: path.join(skills, 'demo', 'two.md'), content: 'global-two-${tag}' },
      ],
      deletes: [],
      repoRoot: ${JSON.stringify(repoRoot)},
    });
    console.log('DID_NOT_CRASH');
  `;
  return runNode(script, home);
}

/** Repo B: reconcile (fatal on any error), then attempt its own global install. */
function reconcileThenInstall(repoRoot, home, tag) {
  const script = `
    import path from 'node:path';
    import os from 'node:os';
    const skills = path.join(os.homedir(), '.claude', 'skills');
    const m = await import(${JSON.stringify(INSTALL_URL)});
    const { receiptPath } = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'scripts', 'lib', 'install', 'surface-paths.mjs')).href)});
    // Second argument is an OPTIONS BAG, not a positional path. This call used
    // to pass receiptPath('global', repoRoot) here, which the old one-argument
    // body silently ignored — a leftover that would have been reinterpreted as
    // a home root the moment the signature grew.
    void receiptPath;
    m._internals.reconcileJournals(${JSON.stringify(repoRoot)});
    console.log('RECONCILE_PROCEEDED');
    const { executeTransaction } = await import(${JSON.stringify(TXN_URL)});
    const r = executeTransaction({
      writes: [{ absPath: path.join(skills, 'demo', 'one.md'), content: 'global-one-${tag}' }],
      deletes: [],
      repoRoot: ${JSON.stringify(repoRoot)},
    });
    console.log('INSTALL_RESULT ' + JSON.stringify({ success: r.success, error: r.error }));
  `;
  return runNode(script, home);
}

/** In-process recovery of a REPO-anchored journal (never touches the real home). */
function recoverFromJournalIn(repo) {
  return recoverFromJournal(path.join(repo, '.audit-loop-install-txn.json'), { repoRoot: repo });
}

/** Simulate "N ms have already elapsed" for a lock left by a dead process. */
function backdateLock(lockPath, ageMs) {
  if (!fs.existsSync(lockPath)) return false;
  const [pid] = fs.readFileSync(lockPath, 'utf8').split('\n');
  fs.writeFileSync(lockPath, `${pid}\n${Date.now() - ageMs}`);
  return true;
}

describe('scope derivation — one predicate drives every anchored decision', () => {
  // The recurring defect this guards: a scope handled in one place and
  // forgotten in another. These assert the derivation is total and monotone.
  // Pure path predicates — they read the real home but never write to it.
  const { touchesGlobalSurface, anchorFor, anchorForJournal, sameRoot } = _internals;

  it('a delete of a global path counts as touching the surface, exactly like a write', () => {
    // The original lock predicate read only `writes`, so a global-deletes-only
    // transaction took no global lock and anchored its journal in the repo.
    const gTarget = path.join(globalSurfaceRoot(), 'demo', 'gone.md');
    assert.equal(touchesGlobalSurface({ writes: [], deletes: [{ absPath: gTarget }] }), true);
    assert.equal(touchesGlobalSurface({ writes: [{ absPath: gTarget }], deletes: [] }), true);
  });

  it('a purely repo-scoped transaction stays repo-anchored', () => {
    const repo = mkTmp('repo-only');
    assert.equal(touchesGlobalSurface({ writes: [{ absPath: path.join(repo, 'a.md') }], deletes: [] }), false);
    const a = anchorFor(false, repo);
    assert.equal(a.scope, 'repo');
    assert.equal(a.journalPath, path.join(repo, '.audit-loop-install-txn.json'));
  });

  it('a MIXED transaction anchors at the widest surface it touches, not the repo', () => {
    const repo = mkTmp('mixed');
    const a = anchorFor(true, repo);
    assert.equal(a.scope, 'global');
    assert.notEqual(path.dirname(a.journalPath), repo, 'a mixed journal must not be stranded in the repo');
    assert.notEqual(path.dirname(a.quarantineDir), repo, 'nor may its quarantine be');
  });

  it('a caller cannot override a GLOBAL journal into its own repo', () => {
    // Placement is not a caller's choice for a shared-surface transaction:
    // getting it wrong is invisible to the caller and harms other repos.
    const repo = mkTmp('override');
    const sneaky = path.join(repo, '.audit-loop-install-txn.json');
    assert.notEqual(anchorFor(true, repo, sneaky).journalPath, sneaky);
    assert.equal(anchorFor(false, repo, sneaky).journalPath, sneaky, 'repo scope still honours an override');
  });

  it('a journal anchor is read from its LOCATION, so a corrupt journal still routes', () => {
    const repo = mkTmp('anchor-by-location');
    assert.equal(anchorForJournal(path.join(repo, '.audit-loop-install-txn.json'), repo).scope, 'repo');
  });

  it('sameRoot compares identity, resolving symlinks', () => {
    const repo = mkTmp('same');
    assert.equal(sameRoot(repo, repo), true);
    assert.equal(sameRoot(repo, mkTmp('other')), false);
  });
});

describe('originRepoRoot is an identity claim, never an authorisation', () => {
  // The circularity trap: if a journal could name its own allowed root, a
  // corrupt or hostile journal would authorise itself. It is compared ONLY
  // against the recovering process's independently-known root; containment
  // still validates against caller-supplied roots exclusively.
  it('a journal claiming an origin it does not own cannot widen containment', () => {
    const repo = mkTmp('claim');
    const outside = path.join(mkTmp('elsewhere'), 'victim.md');

    // The claim names a root that WOULD contain the escaping path...
    const v = _internals.validateJournal(
      {
        version: 1,
        originRepoRoot: path.dirname(outside),
        stage: 'renaming',
        staged: [{ absPath: outside, tmpPath: `${outside}.tmp.1` }],
        deletes: [],
      },
      [repo, globalSurfaceRoot()], // ...but these are the only roots that count.
    );

    assert.equal(v.ok, false, 'a journal must not be able to authorise its own paths');
    assert.match(v.error, /escapes allowed roots/);
  });

  it('a legacy repo-anchored journal with no origin is still recoverable', () => {
    // Pre-existing journals carry no origin field, and living inside the repo
    // already proves ownership. Rejecting them would quarantine exactly the
    // in-flight crash this module exists to recover.
    const repo = mkTmp('legacy');
    const target = path.join(repo, 'legacy.md');
    const tmp = `${target}.tmp.1`;
    fs.writeFileSync(tmp, 'legacy pending');
    fs.writeFileSync(path.join(repo, '.audit-loop-install-txn.json'), JSON.stringify({
      stage: 'renaming', staged: [{ absPath: target, tmpPath: tmp }], deletes: [],
    }));

    const rec = recoverFromJournalIn(repo);

    assert.equal(rec.recovered, true, `a versionless repo journal must still recover: ${rec.error}`);
    assert.equal(fs.readFileSync(target, 'utf8'), 'legacy pending');
  });
});

describe('stranded global journal — a crash in repo A must block repo B', () => {
  it('repo B REFUSES to install over global state half-applied by a crashed repo A', () => {
    const home = mkTmp('home');
    const repoA = mkTmp('repoA');
    const repoB = mkTmp('repoB');

    // ── Repo A crashes mid-global-rename ────────────────────────────────────
    const crash = crashMidGlobalRename(repoA, home, 'A');
    assert.equal(crash.status, 137, `expected a hard crash, got ${crash.status}: ${crash.stderr}`);

    // The global surface is now HALF-APPLIED: one.md landed, two.md did not.
    assert.equal(fs.readFileSync(globalTarget(home, 'one.md'), 'utf8'), 'global-one-A');
    assert.equal(fs.existsSync(globalTarget(home, 'two.md')), false, 'two.md must still be pending');

    // The recovery record must be discoverable by ANY repo that touches the
    // shared surface — i.e. at the global anchor, not stranded inside repo A.
    const strandedInA = path.join(repoA, '.audit-loop-install-txn.json');
    const globalJournal = path.join(home, '.audit-loop-install-txn.json');
    assert.equal(
      fs.existsSync(globalJournal), true,
      'a transaction that mutates the SHARED global surface must journal at the global anchor, ' +
      `not inside the originating repo (found stranded-in-repoA=${fs.existsSync(strandedInA)})`,
    );

    // ── Time passes; repo A's locks go stale and are breakable ──────────────
    backdateLock(path.join(skillsRoot(home), '.install.lock'), 120_000);
    backdateLock(`${globalJournal}.lock`, 120_000);
    backdateLock(`${strandedInA}.lock`, 120_000);

    // ── Repo B must NOT proceed ────────────────────────────────────────────
    const b = reconcileThenInstall(repoB, home, 'B');
    const out = `${b.stdout}\n${b.stderr}`;

    assert.equal(
      b.status, 1,
      `repo B must ABORT on repo A's unresolved global journal, but exited ${b.status}.\n${out}`,
    );
    assert.match(out, /repoA/i, 'the abort must name the ORIGINATING repo so a human knows where to resolve it');
    assert.doesNotMatch(out, /RECONCILE_PROCEEDED/, 'reconcile must be fatal, not fall through');

    // ── The half-applied global state is untouched ─────────────────────────
    assert.equal(
      fs.readFileSync(globalTarget(home, 'one.md'), 'utf8'), 'global-one-A',
      'repo B must not overwrite global state left by a crashed transaction',
    );
    assert.equal(fs.existsSync(globalJournal), true, 'the blocker must survive — never moved by a foreign repo');
  });

  it('the ORIGINATING repo recovers its own global journal and unblocks everyone', () => {
    const home = mkTmp('home');
    const repoA = mkTmp('repoA');
    const repoB = mkTmp('repoB');

    const crash = crashMidGlobalRename(repoA, home, 'A');
    assert.equal(crash.status, 137, `expected a hard crash: ${crash.stderr}`);

    const globalJournal = path.join(home, '.audit-loop-install-txn.json');
    backdateLock(path.join(skillsRoot(home), '.install.lock'), 120_000);
    backdateLock(`${globalJournal}.lock`, 120_000);

    // Repo A re-runs: it OWNS this journal, so it may roll forward.
    const a = reconcileThenInstall(repoA, home, 'A2');
    const outA = `${a.stdout}\n${a.stderr}`;
    assert.match(outA, /RECONCILE_PROCEEDED/, `repo A must recover its own journal: ${outA}`);
    assert.equal(
      fs.readFileSync(globalTarget(home, 'two.md'), 'utf8'), 'global-two-A',
      'recovery must roll the pending rename forward',
    );
    assert.equal(fs.existsSync(globalJournal), false, 'a recovered journal is cleaned up');

    // With the journal resolved, repo B is unblocked.
    const b = reconcileThenInstall(repoB, home, 'B');
    const outB = `${b.stdout}\n${b.stderr}`;
    assert.match(outB, /RECONCILE_PROCEEDED/, `repo B must be unblocked once A recovered: ${outB}`);
    assert.match(outB, /INSTALL_RESULT \{"success":true/, `repo B's install must succeed: ${outB}`);
  });
});
