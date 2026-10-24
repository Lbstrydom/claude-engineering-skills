/**
 * @fileoverview The shared "same patches?" predicate (scripts/lib/patch-equivalence.mjs) against REAL git: the guard rails the two callers
 * (the pre-push hook's audit reuse, /ship's AI-Gate provenance) rely on, in both directions.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { patchRangesEquivalent, ownPatchFingerprints, makeGit, MAX_COMPARED_COMMITS } from '../scripts/lib/patch-equivalence.mjs';
import { git } from './lib/hook-test-helpers.mjs';

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-eq-'));
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'a@example.invalid'], dir);
  git(['config', 'user.name', 'A'], dir);
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); git(['add', rel], dir); };
  put('base.txt', 'base\n'); git(['commit', '-q', '-m', 'seed'], dir);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], dir);
  return { dir, put, rm: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) };
}

describe('patchRangesEquivalent', () => {
  it('cherry-picked commits are equivalent even though every sha and the tree differ (the squash-divergence recovery)', () => {
    const r = repo();
    try {
      git(['checkout', '-q', '-b', 'old'], r.dir);
      r.put('a.txt', 'a\n'); git(['commit', '-q', '-m', 'A'], r.dir);
      r.put('b.txt', 'b\n'); git(['commit', '-q', '-m', 'B'], r.dir);
      const audited = git(['rev-parse', 'HEAD'], r.dir);
      git(['checkout', '-q', 'main'], r.dir);
      r.put('elsewhere.txt', 'x\n'); git(['commit', '-q', '-m', 'main'], r.dir);
      git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], r.dir);
      git(['checkout', '-q', '-b', 'recovered'], r.dir);
      git(['cherry-pick', 'old~1', 'old'], r.dir);
      assert.notEqual(git(['rev-parse', 'HEAD'], r.dir), audited);
      assert.deepEqual(patchRangesEquivalent({ auditedRef: audited, headRef: 'HEAD', cwd: r.dir }), { equivalent: true, commits: 2 });
    } finally { r.rm(); }
  });
  it('order does not matter', () => {
    const r = repo();
    try {
      git(['checkout', '-q', '-b', 'f'], r.dir);
      r.put('a.txt', 'a\n'); git(['commit', '-q', '-m', 'A'], r.dir);
      r.put('b.txt', 'b\n'); git(['commit', '-q', '-m', 'B'], r.dir);
      const audited = git(['rev-parse', 'HEAD'], r.dir);
      git(['checkout', '-q', 'main'], r.dir);
      git(['checkout', '-q', '-b', 'reordered'], r.dir);
      git(['cherry-pick', 'f', 'f~1'], r.dir); // B then A
      assert.equal(patchRangesEquivalent({ auditedRef: audited, headRef: 'HEAD', cwd: r.dir }).equivalent, true);
    } finally { r.rm(); }
  });
  it('multiplicity matters: the same patch twice is not the same patch once (multiset, not set)', () => {
    const idsFor = { AUD: ['p1', 'p1', 'p2'], PUSH: ['p1', 'p2', 'p2'] };
    const fake = (args, input) => {
      if (args[0] === 'rev-parse') return 'ok\n';
      if (args[0] === 'rev-list') return args.includes('--merges') ? '0\n' : '3\n';
      // one commit chunk per id: equal ids -> equal diff bodies -> equal fingerprints
      if (args[0] === 'log') return idsFor[args.includes('AUD') ? 'AUD' : 'PUSH'].map((id, i) => `\u0001sha${i}\ndiff --git a/f b/f\n+${id}\n`).join('');
      return null;
    };
    const v = patchRangesEquivalent({ auditedRef: 'AUD', headRef: 'PUSH', git: fake });
    assert.equal(v.equivalent, false);
    assert.match(v.reason, /1 pushed patch\(es\) were never audited, 1 audited patch\(es\) are not in the push/);
    idsFor.PUSH = ['p2', 'p1', 'p1'];
    assert.deepEqual(patchRangesEquivalent({ auditedRef: 'AUD', headRef: 'PUSH', git: fake }), { equivalent: true, commits: 3 });
  });
  it('zero own commits on either side is NOT equality (nothing to compare)', () => {
    const r = repo();
    try {
      const v = patchRangesEquivalent({ auditedRef: 'HEAD', headRef: 'HEAD', cwd: r.dir });
      assert.equal(v.equivalent, false);
      assert.match(v.reason, /nothing to compare is not equality/);
    } finally { r.rm(); }
  });
  it('fails closed on every unreadable input: bad revision, unresolvable ref, unresolvable default ref', () => {
    const r = repo();
    try {
      git(['checkout', '-q', '-b', 'f'], r.dir);
      r.put('a.txt', 'a\n'); git(['commit', '-q', '-m', 'A'], r.dir);
      assert.match(patchRangesEquivalent({ auditedRef: '--output=/tmp/x', headRef: 'HEAD', cwd: r.dir }).reason, /not a well-formed git revision/);
      assert.match(patchRangesEquivalent({ auditedRef: 'a'.repeat(40), headRef: 'HEAD', cwd: r.dir }).reason, /does not resolve to a commit/);
      assert.match(patchRangesEquivalent({ auditedRef: 'HEAD', headRef: 'HEAD', defaultRef: 'origin/nope', cwd: r.dir }).reason, /default ref origin\/nope does not resolve/);
    } finally { r.rm(); }
  });
  it('an empty commit has no patch id, so the range cannot be compared (not silently skipped)', () => {
    const r = repo();
    try {
      git(['checkout', '-q', '-b', 'f'], r.dir);
      r.put('a.txt', 'a\n'); git(['commit', '-q', '-m', 'A'], r.dir);
      git(['commit', '-q', '--allow-empty', '-m', 'empty'], r.dir);
      const v = ownPatchFingerprints('HEAD', { defaultRef: 'origin/main', git: makeGit(r.dir) });
      assert.equal(v.ok, false);
      assert.match(v.reason, /1 of 2 own commit\(s\).*no comparable patch/);
    } finally { r.rm(); }
  });
  it('a branch longer than the cap is not compared', () => {
    const r = repo();
    try {
      const fake = (args) => {
        if (args[0] === 'rev-list') return args.includes('--merges') ? '0\n' : `${MAX_COMPARED_COMMITS + 1}\n`;
        return 'ok\n';
      };
      const v = ownPatchFingerprints('HEAD', { defaultRef: 'origin/main', git: fake });
      assert.equal(v.ok, false);
      assert.match(v.reason, new RegExp(`exceed the ${MAX_COMPARED_COMMITS}`));
    } finally { r.rm(); }
  });
  it('a git that fails or times out is "not equivalent", never a throw', () => {
    const v = patchRangesEquivalent({ auditedRef: 'HEAD', headRef: 'HEAD', git: () => null });
    assert.equal(v.equivalent, false);
  });
});

// ── audit round 1 (H2/H4/H7 whitespace, H3/H5/H8 merges, H6 presentation config) ─────────────────────────────────────────────────────
import { spawnSync } from 'node:child_process';
describe('patchRangesEquivalent - content-preserving, merge-refusing', () => {
  const patchIdOf = (dir, rev) => {
    const log = spawnSync('git', ['show', '--format=', rev], { cwd: dir, encoding: 'utf8' }).stdout;
    return spawnSync('git', ['patch-id', '--stable'], { cwd: dir, input: log, encoding: 'utf8' }).stdout.split(' ')[0];
  };
  it('NEGATIVE CONTROL: a whitespace-only amendment is NOT equivalent - and `git patch-id --stable` would have called it equal (the instrument sees it)', () => {
    const r = repo();
    try {
      r.put('app.py', 'def f():\n    x = 1\n    return x\n'); git(['add', '.'], r.dir);
      git(['checkout', '-q', '-b', 'audited'], r.dir);
      r.put('app.py', 'def f():\n    x = 1\n    if x:\n        return x\n    return 0\n'); git(['commit', '-q', '-m', 'audited change'], r.dir);
      const audited = git(['rev-parse', 'HEAD'], r.dir);
      git(['checkout', '-q', 'main'], r.dir);
      git(['checkout', '-q', '-b', 'amended'], r.dir);
      git(['cherry-pick', audited], r.dir);
      // Re-indent the new block: semantically different Python, identical to patch-id.
      r.put('app.py', 'def f():\n    x = 1\n    if x:\n    return x\n    return 0\n');
      git(['commit', '-q', '--amend', '--no-edit'], r.dir);
      assert.equal(patchIdOf(r.dir, 'HEAD'), patchIdOf(r.dir, audited), 'instrument check: patch-id --stable IS blind to this edit');
      const v = patchRangesEquivalent({ auditedRef: audited, headRef: 'HEAD', cwd: r.dir });
      assert.equal(v.equivalent, false);
      assert.match(v.reason, /patches differ/);
    } finally { r.rm(); }
  });
  it('CONTROL: the identical change on a base whose NEIGHBOURING lines moved (different context, same added/removed lines) is still equivalent', () => {
    const r = repo();
    try {
      r.put('lib.js', 'a\nb\nc\nd\ne\nf\ng\nh\ni\n'); git(['commit', '-q', '-m', 'lib'], r.dir);
      git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], r.dir);
      git(['checkout', '-q', '-b', 'audited'], r.dir);
      r.put('lib.js', 'a\nb\nc\nd\nE\nf\ng\nh\ni\n'); git(['commit', '-q', '-m', 'edit d'], r.dir);
      const audited = git(['rev-parse', 'HEAD'], r.dir);
      git(['checkout', '-q', 'main'], r.dir);
      r.put('lib.js', 'a\nBB\nc\nd\ne\nf\ng\nHH\ni\n'); git(['commit', '-q', '-m', 'main edits the neighbours'], r.dir);
      git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], r.dir);
      git(['checkout', '-q', '-b', 'moved'], r.dir);
      git(['cherry-pick', audited], r.dir);
      assert.deepEqual(patchRangesEquivalent({ auditedRef: audited, headRef: 'HEAD', cwd: r.dir }), { equivalent: true, commits: 1 });
    } finally { r.rm(); }
  });
  it('a range holding a MERGE commit is never compared: the merge may carry an unaudited change that is in no non-merge commit', () => {
    const r = repo();
    try {
      git(['checkout', '-q', '-b', 'f'], r.dir);
      r.put('a.txt', 'a\n'); git(['commit', '-q', '-m', 'A'], r.dir);
      const audited = git(['rev-parse', 'HEAD'], r.dir);
      git(['checkout', '-q', '-b', 'side', 'main'], r.dir);
      r.put('side.txt', 's\n'); git(['commit', '-q', '-m', 'side'], r.dir);
      git(['checkout', '-q', 'f'], r.dir);
      git(['merge', '-q', '--no-ff', '-m', 'merge side with an evil edit', 'side'], r.dir);
      r.put('a.txt', 'a\nUNAUDITED EDIT MADE DURING THE MERGE\n'); git(['commit', '-q', '--amend', '--no-edit'], r.dir);
      const v = patchRangesEquivalent({ auditedRef: audited, headRef: 'HEAD', cwd: r.dir });
      assert.equal(v.equivalent, false);
      assert.match(v.reason, /merge commit\(s\) of its own/);
      // vacuous-pass guard: the same two refs WITHOUT the merge are comparable (so the refusal above is the merge, not the fixture).
      assert.equal(patchRangesEquivalent({ auditedRef: audited, headRef: audited, cwd: r.dir }).equivalent, true);
    } finally { r.rm(); }
  });
  it('the fingerprint is independent of the operator\'s presentation config (textconv / external diff cannot change the evidence)', () => {
    const r = repo();
    try {
      git(['checkout', '-q', '-b', 'f'], r.dir);
      r.put('doc.bin', 'one\n'); git(['commit', '-q', '-m', 'bin'], r.dir);
      const plain = ownPatchFingerprints('HEAD', { defaultRef: 'origin/main', git: makeGit(r.dir) });
      fs.writeFileSync(path.join(r.dir, '.gitattributes'), '*.bin diff=loud\n');
      git(['config', 'diff.loud.textconv', 'echo REWRITTEN'], r.dir);
      git(['config', 'diff.external', 'echo EXTERNAL'], r.dir);
      const configured = ownPatchFingerprints('HEAD', { defaultRef: 'origin/main', git: makeGit(r.dir) });
      assert.deepEqual(configured, plain);
      assert.equal(plain.ids.length, 1);
    } finally { r.rm(); }
  });
});
