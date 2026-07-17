/**
 * @fileoverview install-skills.mjs::reconcileJournals — the fail-closed
 * caller boundary for the WAL.
 *
 * Regression guard for the R2-H2 -> R3-H1 lineage: the quarantine/abort signal
 * exists in transaction.mjs, but it is only worth anything if the CALLER acts
 * on it. An earlier design gated on `rec.quarantined` alone, which silently
 * ignored the lock-contention failure result added later — so the install
 * would proceed over unrecovered state. The contract is now "any truthy
 * `error` is fatal".
 *
 * Driven as a subprocess because the abort is `process.exit(1)`.
 * Plan: docs/plans/install-transaction-wal-hardening.md
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REPO = process.cwd();
const tmpDirs = [];
function mkRepo(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `reconcile-${label}-`));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ }
  }
});

/**
 * Import install-skills.mjs's reconcileJournals in a child process and run it
 * against `repoRoot`. The script guards `main()` behind an isMain check, so
 * importing it does not run an install.
 *
 * HOME is redirected to a throwaway directory. `reconcileJournals` scans the
 * GLOBAL journal anchor (`~/.audit-loop-install-txn.json`) as well as the
 * repo's, so without this every case here would read — and potentially act on —
 * the developer's real home directory.
 */
function runReconcile(repoRoot) {
  // pathToFileURL: a bare Windows absolute path ('C:\\...') is not a valid ESM
  // specifier — the loader rejects it as protocol 'c:'.
  const modUrl = pathToFileURL(path.join(REPO, 'scripts', 'install-skills.mjs')).href;
  const home = mkRepo('home');
  const script = `
    const m = await import(${JSON.stringify(modUrl)});
    const fn = m._internals?.reconcileJournals;
    if (typeof fn !== 'function') { console.error('NO_EXPORT'); process.exit(3); }
    fn(${JSON.stringify(repoRoot)});
    console.log('PROCEEDED');
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

describe('reconcileJournals — fail-closed on any error (R2-H2 / R3-H1)', () => {
  it('ABORTS the install when a journal is corrupt (and reports the quarantine path)', () => {
    const repo = mkRepo('corrupt');
    fs.writeFileSync(path.join(repo, '.audit-loop-install-txn.json'), '{ not valid json');

    const r = runReconcile(repo);

    assert.notEqual(r.status, 3, `reconcileJournals must be exported for testing: ${r.stderr}`);
    assert.equal(r.status, 1, `a corrupt journal must abort the install, got status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
    assert.doesNotMatch(r.stdout || '', /PROCEEDED/, 'the install must NOT continue past unresolved state');
    assert.match(r.stderr, /ABORT/);
    assert.match(r.stderr, /quarantined/i, 'the operator needs the quarantine path to resolve the block');
  });

  it('PROCEEDS silently when no journal exists (the only benign case)', () => {
    const repo = mkRepo('clean');
    const r = runReconcile(repo);
    assert.equal(r.status, 0, `a clean repo must not be blocked: ${r.stderr}`);
    assert.match(r.stdout, /PROCEEDED/);
  });

  it('PROCEEDS after recovering a valid journal, reporting what it did', () => {
    const repo = mkRepo('recoverable');
    const target = path.join(repo, 'rolled.md');
    const tmp = `${target}.tmp.abc`;
    fs.writeFileSync(tmp, 'pending content');
    fs.writeFileSync(path.join(repo, '.audit-loop-install-txn.json'), JSON.stringify({
      version: 1, stage: 'renaming', staged: [{ absPath: target, tmpPath: tmp }], deletes: [],
    }));

    const r = runReconcile(repo);

    assert.equal(r.status, 0, `a recoverable journal must not abort: ${r.stderr}`);
    assert.match(r.stdout, /Journal recovered/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'pending content', 'roll-forward must complete');
  });

  it('ABORTS on an error result that carries NO quarantine path (lock contention)', () => {
    // The R3-H1 contract is "ANY truthy rec.error is fatal", adopted precisely
    // because gating on the `quarantined` flag silently ignored the newer
    // lock-contention result. Every other case here sets error AND quarantined,
    // so a revert to `if (rec.quarantined)` would keep the suite green — the
    // exact regression the rule exists to prevent. This is the only case that
    // pins error-without-quarantine.
    const repo = mkRepo('contended');
    const target = path.join(repo, 'pending.md');
    const tmp = `${target}.tmp.abc`;
    fs.writeFileSync(tmp, 'pending');
    fs.writeFileSync(path.join(repo, '.audit-loop-install-txn.json'), JSON.stringify({
      version: 1, stage: 'renaming', staged: [{ absPath: target, tmpPath: tmp }], deletes: [],
    }));
    // A FRESH lock: a live holder, so acquireLock exhausts its fixed 5s wait and
    // throws rather than breaking it as stale. Contention by construction — no
    // subprocess race, no timing luck (plan R3-M2).
    fs.writeFileSync(path.join(repo, '.audit-loop-install-txn.json.lock'), `999999\n${Date.now()}`);

    const r = runReconcile(repo);

    assert.equal(r.status, 1, `a lock-contended recovery must abort, not fall through: ${r.stdout} ${r.stderr}`);
    assert.doesNotMatch(r.stdout || '', /PROCEEDED/, 'the install must not proceed over unrecovered state');
    assert.match(r.stderr, /another install is in progress/);
    assert.doesNotMatch(r.stderr, /quarantined to/, 'nothing was quarantined — this is the error-only path');
    assert.equal(fs.existsSync(tmp), true, 'a blocked recovery must not touch the pending state');
  });

  it('ABORTS on a containment-violating journal rather than acting on it', () => {
    const repo = mkRepo('escape');
    const outside = path.join(os.tmpdir(), `escaped-${process.pid}.md`);
    fs.writeFileSync(path.join(repo, '.audit-loop-install-txn.json'), JSON.stringify({
      version: 1, stage: 'renaming',
      staged: [{ absPath: outside, tmpPath: `${outside}.tmp.1` }], deletes: [],
    }));

    const r = runReconcile(repo);

    assert.equal(r.status, 1, 'a journal naming a path outside every allowed root must abort');
    assert.doesNotMatch(r.stdout || '', /PROCEEDED/);
  });
});
