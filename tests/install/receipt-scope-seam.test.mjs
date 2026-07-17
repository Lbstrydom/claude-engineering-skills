/**
 * @fileoverview The repo-vs-global receipt seam — guards for the partial-scope
 * enumeration class.
 *
 * Same defect family as the WAL journal-placement fix (see
 * docs/plans/install-transaction-wal-hardening.md Fix 8): a rule that must
 * cover BOTH scopes applied to only one of them. These were found by
 * deliberately hunting that pattern one layer out from transaction.mjs, in its
 * caller and its sibling reader, and all three were live:
 *
 *  1. ManagedFileSchema omitted `scope`, so Zod stripped the discriminator on
 *     read and computeDeletes' global branch became unreachable — every global
 *     file silently un-deletable (guarded in receipt.test.mjs).
 *  2. writeReceiptsByScope guarded on writes only, never deletes.
 *  3. check-skill-updates read only the repo receipt.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import { _internals } from '../../scripts/install-skills.mjs';
import { writeReceipt, buildReceipt, readReceipt } from '../../scripts/lib/install/receipt.mjs';
import { managedFileAbsPath } from '../../scripts/lib/install/surface-paths.mjs';
// The real sha function the checker uses — asserting against a hand-rolled copy
// would let both sides agree on a wrong value.
import { computeFileSha } from '../../scripts/lib/install/conflict-detector.mjs';

const REPO = process.cwd();
const tmpDirs = [];
function mkTmp(label) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `rscope-${label}-`)));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ }
  }
});

const receiptOf = (managedFiles) => buildReceipt({
  bundleVersion: 'v1', sourceUrl: 'https://example.com', surface: 'both', managedFiles,
});

describe('managedFileAbsPath — one decoder for the scope-keyed encoding', () => {
  it('decodes global as absolute and repo as repo-relative', () => {
    const repo = mkTmp('decode');
    const abs = path.join(os.tmpdir(), 'somewhere', 'SKILL.md');
    assert.equal(managedFileAbsPath({ path: abs, scope: 'global' }, repo), abs);
    assert.equal(
      managedFileAbsPath({ path: 'a/b.md', scope: 'repo' }, repo),
      path.join(repo, 'a/b.md'),
    );
  });

  it('treats a missing scope as repo (legacy receipts)', () => {
    const repo = mkTmp('legacy-decode');
    assert.equal(managedFileAbsPath({ path: 'a/b.md' }, repo), path.join(repo, 'a/b.md'));
  });
});

describe('computeDeletes resolves GLOBAL entries (Finding 1 end-to-end)', () => {
  it('a dropped global file produces a delete at its real absolute path', () => {
    // Pre-fix this produced path.join(repoRoot, '<absolute path>') — a path that
    // cannot exist, so attemptDelete short-circuited on !existsSync and returned
    // {deleted:false} with NO skip recorded. Silent orphan, nothing reported.
    const repo = mkTmp('cd-repo');
    const home = mkTmp('cd-home');
    const globalFile = path.join(home, '.claude', 'skills', 'gone', 'SKILL.md');
    fs.mkdirSync(path.dirname(globalFile), { recursive: true });
    fs.writeFileSync(globalFile, 'stale');

    const prevGlobal = receiptOf([{ path: globalFile, sha: 'aaa', skill: 'gone', scope: 'global' }]);
    const deletes = _internals.computeDeletes([], prevGlobal, null, repo);

    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].absPath, globalFile, 'the delete must target the real global path');
    assert.equal(fs.existsSync(deletes[0].absPath), true, 'and that path must actually exist to be deletable');
  });

  it('survives the receipt round-trip — the read must not strip scope', () => {
    // The seam that actually broke: in-memory objects carried `scope`, so any
    // test using them directly passed. Only a round trip through readReceipt
    // exposed it.
    const repo = mkTmp('cd-roundtrip');
    const home = mkTmp('cd-rt-home');
    const globalFile = path.join(home, '.claude', 'skills', 'x', 'SKILL.md');
    const rp = path.join(mkTmp('cd-rt-store'), 'receipt.json');
    writeReceipt(rp, receiptOf([{ path: globalFile, sha: 'aaa', scope: 'global' }]));

    const { receipt } = readReceipt(rp);
    const deletes = _internals.computeDeletes([], receipt, null, repo);

    assert.equal(deletes[0].absPath, globalFile, 'scope must survive the read or the global branch dies');
  });
});

describe('a partial --skills install is not authoritative over other skills', () => {
  // The most dangerous consequence found in this pass. Deletes are computed by
  // diffing the receipt against THIS RUN's write set, so a `--skills explain`
  // install made the other 14 skills look "no longer managed". It was masked
  // while global deletes silently no-op'd; fixing that resolution ARMED it —
  // measured at 112 proposed deletes, against the shared ~/.claude/skills
  // surface every repo reads. Verified end-to-end: 112 -> 0.
  it('leaves UNSELECTED skills alone instead of deleting them', () => {
    const repo = mkTmp('auth-repo');
    const home = mkTmp('auth-home');
    const other = path.join(home, '.claude', 'skills', 'visual-audit', 'SKILL.md');
    const kept = path.join(home, '.claude', 'skills', 'explain', 'SKILL.md');
    const prevGlobal = receiptOf([
      { path: other, sha: 'aaa', skill: 'visual-audit', scope: 'global' },
      { path: kept, sha: 'bbb', skill: 'explain', scope: 'global' },
    ]);

    // This run installs ONLY `explain`, and rewrites explain's file.
    const writes = [{ absPath: kept }];
    const deletes = _internals.computeDeletes(writes, prevGlobal, null, repo, new Set(['explain']));

    assert.deepEqual(deletes, [], 'a one-skill install must not delete the other skills');
  });

  it('still deletes a dropped file WITHIN a selected skill', () => {
    // The guard must not disable legitimate cleanup: a reference file removed
    // from a skill this run IS authoritative over must still go.
    const repo = mkTmp('auth-drop');
    const home = mkTmp('auth-drop-home');
    const gone = path.join(home, '.claude', 'skills', 'explain', 'references', 'old.md');
    const kept = path.join(home, '.claude', 'skills', 'explain', 'SKILL.md');
    const prevGlobal = receiptOf([
      { path: gone, sha: 'aaa', skill: 'explain', scope: 'global' },
      { path: kept, sha: 'bbb', skill: 'explain', scope: 'global' },
    ]);

    const deletes = _internals.computeDeletes([{ absPath: kept }], prevGlobal, null, repo, new Set(['explain']));

    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].absPath, gone);
  });

  it('a FULL install (no --skills) remains authoritative over everything', () => {
    const repo = mkTmp('auth-full');
    const home = mkTmp('auth-full-home');
    const gone = path.join(home, '.claude', 'skills', 'removed-skill', 'SKILL.md');
    const prevGlobal = receiptOf([{ path: gone, sha: 'aaa', skill: 'removed-skill', scope: 'global' }]);

    // null = no filter: a skill genuinely dropped from the manifest is deleted.
    const deletes = _internals.computeDeletes([], prevGlobal, null, repo, null);

    assert.equal(deletes.length, 1, 'a full install must still clean up a skill dropped from the manifest');
    assert.equal(deletes[0].absPath, gone);
  });

  it('retains unselected skills in the receipt so the next run still tracks them', () => {
    const prevGlobal = receiptOf([
      { path: '/abs/visual-audit/SKILL.md', sha: 'aaa', skill: 'visual-audit', scope: 'global' },
      { path: '/abs/explain/SKILL.md', sha: 'bbb', skill: 'explain', scope: 'global' },
    ]);
    const retained = _internals.retainUnmanagedEntries(prevGlobal, new Set(['explain']));
    assert.equal(retained.length, 1);
    assert.equal(retained[0].skill, 'visual-audit', 'the untouched skill must stay in the receipt');
  });
});

describe('writeReceiptsByScope covers writes AND deletes (Finding 2)', () => {
  const manifest = { bundleVersion: 'v2', rawUrlBase: 'https://example.com' };
  const args = { surface: 'claude' };

  it('rewrites a scope whose LAST file was deleted, instead of leaving a stale receipt', () => {
    // A delete changes the managed set exactly as a write does. Guarding on
    // `managed.length > 0` alone left the repo receipt listing files the
    // installer had just removed — check-skill-updates then reports each as
    // `missing` and tells the user to reinstall.
    const repo = mkTmp('wr-repo');
    const repoReceipt = path.join(repo, '.audit-loop-install-receipt.json');
    const globalReceipt = path.join(mkTmp('wr-home'), '.audit-loop-install-receipt.json');
    const prevRepo = receiptOf([{ path: '.agents/skills/plan/SKILL.md', sha: 'old', scope: 'repo' }]);
    writeReceipt(repoReceipt, prevRepo);

    // This install writes ONLY global files — the repo scope is emptied.
    _internals.writeReceiptsByScope(
      [{ path: '/abs/global/SKILL.md', sha: 'new', scope: 'global' }],
      manifest, args, repoReceipt, globalReceipt, { repo: prevRepo, global: null },
    );

    const { receipt } = readReceipt(repoReceipt);
    assert.deepEqual(receipt.managedFiles, [], 'the emptied scope must be rewritten, not left stale');
  });

  it('does not create a receipt for a scope that was always empty', () => {
    const repo = mkTmp('wr-empty');
    const repoReceipt = path.join(repo, '.audit-loop-install-receipt.json');
    const globalReceipt = path.join(mkTmp('wr-empty-home'), '.audit-loop-install-receipt.json');

    _internals.writeReceiptsByScope(
      [{ path: '/abs/global/SKILL.md', sha: 'new', scope: 'global' }],
      manifest, args, repoReceipt, globalReceipt, { repo: null, global: null },
    );

    assert.equal(fs.existsSync(repoReceipt), false, 'an always-empty scope needs no receipt');
    assert.equal(fs.existsSync(globalReceipt), true);
  });
});

describe('check-skill-updates reads BOTH surfaces (Finding 3)', () => {
  it('a GLOBAL-only install reports installed:true, not "No install detected"', () => {
    // The false-green this guards: `--surface claude` writes only the global
    // receipt, so reading the repo receipt alone reported a fully-installed
    // bundle as not installed, exit 0. Verified live before the fix.
    const repo = mkTmp('csu-repo');
    const home = mkTmp('csu-home');
    const skillFile = path.join(home, '.claude', 'skills', 'demo', 'SKILL.md');
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, 'content');
    const sha = computeFileSha(skillFile);

    writeReceipt(path.join(home, '.audit-loop-install-receipt.json'), buildReceipt({
      bundleVersion: 'v9', sourceUrl: 'https://example.com', surface: 'claude',
      managedFiles: [{ path: skillFile, sha, skill: 'demo', scope: 'global' }],
    }));

    const r = spawnSync(process.execPath, [
      path.join(REPO, 'scripts', 'check-skill-updates.mjs'), '--json', '--target', repo,
    ], { cwd: REPO, encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: home, USERPROFILE: home } });

    const out = JSON.parse(r.stdout);
    assert.equal(out.installed, true, `a global-only install must be detected: ${r.stdout} ${r.stderr}`);
    assert.equal(out.files.total, 1);
    assert.equal(out.files.match, 1, 'and its global file must be sha-checked, not reported missing');
  });

  it('still reports installed:false when NEITHER receipt exists', () => {
    const repo = mkTmp('csu-none');
    const home = mkTmp('csu-none-home');
    const r = spawnSync(process.execPath, [
      path.join(REPO, 'scripts', 'check-skill-updates.mjs'), '--json', '--target', repo,
    ], { cwd: REPO, encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: home, USERPROFILE: home } });
    assert.equal(JSON.parse(r.stdout).installed, false);
  });
});

