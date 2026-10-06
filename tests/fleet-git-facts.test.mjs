/**
 * @fileoverview /fleet Phase 1 — git and gh facts. Throwaway repos, one per
 * hazard: stale base, identical patch-ids, a deleted worktree directory,
 * unreachable remotes, `gh` absent. Plan §9.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import {
  parseWorktreePorcelain, parseNulList, parseBranchRefs, parseLsRemote, parsePatchId,
  listWorktrees, listBranches, changedFiles, patchId, gitCommonDir, headOf, isAncestor,
  tipCommitTime, remoteRefOid, resolveRemoteUrls, baseFreshness, runGit,
} from '../scripts/lib/fleet/git-facts.mjs';
import {
  listPullRequests, PR_LIST_FIELDS, PR_VIEW_FIELDS, summariseChecks, repoFromPrUrl,
  normalisePr, prSourceIdentity, prLocalRef, classifyGhFailure, parsePrList, validatePrRow, PR_LIMIT,
} from '../scripts/lib/fleet/gh-facts.mjs';

const roots = [];
function tmp(prefix = 'fleet-gf-') {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(d);
  return d;
}
after(() => { for (const d of roots) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

/** A repo on `main` with one commit containing x.txt and y.txt. */
function makeRepo() {
  const dir = tmp();
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 't@example.com'], dir);
  git(['config', 'user.name', 'T'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
  fs.writeFileSync(path.join(dir, 'y.txt'), 'y\n');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
  return dir;
}
function commitFile(dir, name, body, msg = `edit ${name}`) {
  fs.writeFileSync(path.join(dir, name), body);
  git(['add', name], dir);
  git(['commit', '-q', '-m', msg], dir);
}

describe('pure parsers', () => {
  it('parseWorktreePorcelain handles spaces, detached, prunable (NUL records)', () => {
    const text = [
      'worktree C:/a b/main', 'HEAD aaaa', 'branch refs/heads/main', '',
      'worktree C:/a b/wt', 'HEAD bbbb', 'detached', '',
      'worktree C:/gone', 'HEAD cccc', 'branch refs/heads/feat/x', 'prunable gitdir file points to non-existent location', '',
    ].join('\0') + '\0';
    const w = parseWorktreePorcelain(text);
    assert.equal(w.length, 3);
    assert.equal(w[0].path, 'C:/a b/main');
    assert.equal(w[0].branch, 'main');
    assert.equal(w[1].detached, true);
    assert.equal(w[1].branch, null);
    assert.equal(w[2].prunable, true);
    assert.equal(w[2].branch, 'feat/x');
  });
  it('parseNulList / parseBranchRefs / parseLsRemote / parsePatchId', () => {
    assert.deepEqual(parseNulList('a b\0c\0'), ['a b', 'c']);
    assert.deepEqual(parseBranchRefs('refs/heads/feat/a\u0000abc\u0000100\n'), [{ name: 'feat/a', oid: 'abc', tipTime: 100000, counts: null }]);
    const oid = 'a'.repeat(40);
    assert.equal(parseLsRemote(`${oid}\trefs/heads/main\n${'b'.repeat(40)}\trefs/heads/main2\n`, 'refs/heads/main'), oid);
    assert.equal(parseLsRemote('', 'refs/heads/main'), null);
    assert.equal(parsePatchId(`${oid} ${'c'.repeat(40)}\n`), oid);
    assert.equal(parsePatchId(''), null);
  });
});

describe('hazard: stale base must not inflate the change set', () => {
  it('three-dot diff excludes commits that landed on base after the fork; freshness says behind', () => {
    const remote = tmp('fleet-origin-');
    git(['init', '-q', '--bare', '-b', 'main'], remote);
    const dir = makeRepo();
    git(['remote', 'add', 'origin', remote], dir);
    git(['push', '-q', 'origin', 'main'], dir);
    git(['checkout', '-q', '-b', 'f1'], dir);
    commitFile(dir, 'y.txt', 'y changed\n');
    git(['checkout', '-q', 'main'], dir);

    // Someone else lands a change to x.txt on origin/main; we fetch but do not fast-forward.
    const other = tmp('fleet-other-');
    git(['clone', '-q', remote, other], other);
    git(['config', 'user.email', 'o@example.com'], other);
    git(['config', 'user.name', 'O'], other);
    commitFile(other, 'x.txt', 'x moved on\n');
    git(['push', '-q', 'origin', 'main'], other);
    git(['fetch', '-q', 'origin'], dir);

    const cf = changedFiles(dir, 'origin/main', 'f1');
    assert.equal(cf.queried, true);
    assert.deepEqual(cf.files, ['y.txt'], 'x.txt is base drift, not this branch\'s change');
    // The two-dot form WOULD have flagged x.txt — the false conflict this guards against.
    const twoDot = git(['diff', '--name-only', 'origin/main', 'f1'], dir).split('\n').sort();
    assert.deepEqual(twoDot, ['x.txt', 'y.txt']);

    const fr = baseFreshness(dir, { base: 'main', upstream: 'origin/main' });
    assert.equal(fr.freshness.state, 'behind');
    assert.equal(fr.freshness.behindBy, 1);
  });
});

describe('hazard: identical patch-ids on two branches', () => {
  it('equal diffs share a patch-id; a different diff does not; empty diff is null', () => {
    const dir = makeRepo();
    git(['checkout', '-q', '-b', 'a'], dir);
    commitFile(dir, 'y.txt', 'same change\n', 'a1');
    git(['checkout', '-q', 'main'], dir);
    git(['checkout', '-q', '-b', 'b'], dir);
    commitFile(dir, 'y.txt', 'same change\n', 'b-different-message');
    git(['checkout', '-q', 'main'], dir);
    git(['checkout', '-q', '-b', 'c'], dir);
    commitFile(dir, 'y.txt', 'other change\n', 'c1');
    git(['checkout', '-q', 'main'], dir);
    git(['branch', 'empty'], dir);

    const pa = patchId(dir, 'main', 'a');
    const pb = patchId(dir, 'main', 'b');
    const pc = patchId(dir, 'main', 'c');
    assert.equal(pa.queried, true);
    assert.match(pa.patchId, /^[0-9a-f]{40}/);
    assert.equal(pa.patchId, pb.patchId);
    assert.notEqual(pa.patchId, pc.patchId);
    assert.equal(patchId(dir, 'main', 'empty').patchId, null);
    assert.equal(patchId(dir, 'main', 'no-such-branch').queried, false);
  });
});

describe('hazard: a deleted worktree directory is reported missing, not dropped', () => {
  it('lists the worktree with missing:true and prunable:true', () => {
    const dir = makeRepo();
    const wt = path.join(tmp('fleet-wt-'), 'my wt');
    git(['worktree', 'add', '-q', '-b', 'feat/gone', wt], dir);
    let r = listWorktrees(dir);
    assert.equal(r.queried, true);
    const present = r.worktrees.find((w) => w.branch === 'feat/gone');
    assert.equal(present.missing, false);
    assert.equal(present.prunable, false);

    fs.rmSync(wt, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    r = listWorktrees(dir);
    const gone = r.worktrees.find((w) => w.branch === 'feat/gone');
    assert.ok(gone, 'must not be dropped');
    assert.equal(gone.missing, true);
    assert.equal(gone.prunable, true);
  });
});

describe('branches, ancestry, time, common dir', () => {
  it('listBranches reports ahead/behind and tip time; helpers agree with git', () => {
    const dir = makeRepo();
    git(['checkout', '-q', '-b', 'feat/a'], dir);
    commitFile(dir, 'y.txt', '1\n');
    commitFile(dir, 'y.txt', '2\n');
    git(['checkout', '-q', 'main'], dir);
    commitFile(dir, 'x.txt', 'main moved\n');
    const br = listBranches(dir, 'main');
    assert.equal(br.queried, true);
    const a = br.branches.find((b) => b.name === 'feat/a');
    assert.equal(a.ahead, 2);
    assert.equal(a.behind, 1);
    assert.equal(typeof a.tipTime, 'number');
    assert.equal(br.branches.find((b) => b.name === 'main').ahead, 0);

    assert.equal(headOf(dir, 'feat/a').oid, git(['rev-parse', 'feat/a'], dir));
    assert.equal(headOf(dir, 'nope').ok, false);
    assert.deepEqual(isAncestor(dir, 'main~1', 'main'), { ok: true, value: true });
    assert.deepEqual(isAncestor(dir, 'feat/a', 'main'), { ok: true, value: false });
    assert.equal(isAncestor(dir, 'nope', 'main').ok, false);
    const t = tipCommitTime(dir, 'feat/a');
    assert.equal(t.ok, true);
    assert.ok(Math.abs(t.at - Date.now()) < 60_000);
    const cd = gitCommonDir(dir);
    assert.equal(cd.ok, true);
    assert.equal(path.basename(cd.dir), '.git');
  });
});

describe('remote facts never fall back to local state', () => {
  it('ls-remote answers from the remote; absent ref is oid:null; bogus URL is ok:false', () => {
    const remote = tmp('fleet-origin-');
    git(['init', '-q', '--bare', '-b', 'main'], remote);
    const dir = makeRepo();
    git(['remote', 'add', 'origin', remote], dir);
    git(['push', '-q', 'origin', 'main'], dir);
    const head = git(['rev-parse', 'main'], dir);
    assert.deepEqual(remoteRefOid(dir, remote, 'refs/heads/main'), { ok: true, oid: head });
    assert.deepEqual(remoteRefOid(dir, remote, 'refs/heads/absent'), { ok: true, oid: null });
    // A local remote-tracking ref exists, but the URL is unreachable: must NOT use it.
    const bogus = path.join(tmp('fleet-none-'), 'does-not-exist.git');
    const r = remoteRefOid(dir, bogus, 'refs/heads/main');
    assert.equal(r.ok, false);
    assert.ok(r.reason);
  });
  it('resolveRemoteUrls returns fetch URL and every push URL', () => {
    const dir = makeRepo();
    git(['remote', 'add', 'origin', 'https://example.invalid/o/r.git'], dir);
    let u = resolveRemoteUrls(dir, 'origin');
    assert.equal(u.fetchUrl, 'https://example.invalid/o/r.git');
    assert.deepEqual(u.pushUrls, ['https://example.invalid/o/r.git']);
    git(['remote', 'set-url', '--add', '--push', 'origin', 'https://example.invalid/a.git'], dir);
    git(['remote', 'set-url', '--add', '--push', 'origin', 'https://example.invalid/b.git'], dir);
    u = resolveRemoteUrls(dir, 'origin');
    assert.equal(u.pushUrls.length, 2, 'two push URLs must be visible so the caller can refuse');
    assert.equal(resolveRemoteUrls(dir, 'nope').ok, false);
  });
});

describe('gh facts', () => {
  it('gh absent (PATH scrubbed) => not queried with a reason, never an empty list', () => {
    const dir = makeRepo();
    const empty = tmp('fleet-nopath-');
    const env = { ...process.env, PATH: empty, Path: empty };
    const r = listPullRequests(dir, { env });
    assert.equal(r.queried, false);
    assert.equal(r.reason, 'gh not installed');
    assert.deepEqual(r.prs, []);
  });
  it('a nonexistent gh binary is the same honest answer', () => {
    const r = listPullRequests(os.tmpdir(), { ghBin: path.join(os.tmpdir(), 'definitely-not-gh') });
    assert.equal(r.queried, false);
    assert.ok(r.reason);
  });
  it('every requested --json field is a member of the recorded real field list', () => {
    const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/fleet/gh-pr-view-fields.json', import.meta.url), 'utf-8'));
    for (const f of PR_LIST_FIELDS) assert.ok(fixture.list.includes(f), `pr list field ${f} not in real list`);
    for (const f of PR_VIEW_FIELDS) assert.ok(fixture.view.includes(f), `pr view field ${f} not in real list`);
    assert.ok(!PR_VIEW_FIELDS.includes('baseRepository'));
    assert.ok(!fixture.view.includes('baseRepository'), 'baseRepository is not a gh pr field');
  });
  it('failure classification, repo-from-url, check summary, identity', () => {
    assert.equal(classifyGhFailure('To get started with GitHub CLI, please run:  gh auth login'), 'gh not authenticated');
    assert.equal(classifyGhFailure('none of the git remotes configured for this repository'), 'no GitHub remote');
    assert.match(classifyGhFailure('weird'), /^gh failed: weird/);
    assert.equal(repoFromPrUrl('https://github.com/o/n/pull/7'), 'o/n');
    assert.equal(repoFromPrUrl('nope'), null);
    assert.deepEqual(summariseChecks([]), { state: 'none', total: 0 });
    assert.equal(summariseChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }]).state, 'success');
    assert.equal(summariseChecks([{ status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }]).state, 'failure');
    assert.equal(summariseChecks([{ status: 'IN_PROGRESS', conclusion: '' }]).state, 'pending');
    assert.equal(summariseChecks([{ state: 'SUCCESS' }]).state, 'success');
    const pr = normalisePr({
      number: 7, title: 't', url: 'https://github.com/o/n/pull/7', state: 'OPEN', headRefName: 'feat/x',
      headRefOid: 'a'.repeat(40), headRepository: { name: 'n' }, headRepositoryOwner: { login: 'fork' },
      baseRefName: 'main', baseRefOid: 'b'.repeat(40), isDraft: false, isCrossRepository: true, statusCheckRollup: [],
    });
    assert.deepEqual(prSourceIdentity(pr), {
      kind: 'pr', branch: 'feat/x', repo: 'o/n', prNumber: 7, headRepo: 'fork/n', headRef: 'feat/x', baseRef: 'main',
    });
    assert.equal(prLocalRef(7), 'refs/fleet/pr/7');
    assert.throws(() => prLocalRef(-1));
  });
});

describe('changedFiles keeps both endpoints of a rename', () => {
  it('a pure rename out of a claimed directory reports old AND new path', () => {
    const dir = makeRepo();
    fs.mkdirSync(path.join(dir, 'src/export'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src/format'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/export/csv.mjs'), 'export const csv = 1;\n'.repeat(20));
    git(['add', '.'], dir);
    git(['commit', '-q', '-m', 'add csv'], dir);
    git(['checkout', '-q', '-b', 'feat/mv'], dir);
    git(['mv', 'src/export/csv.mjs', 'src/format/csv.mjs'], dir);
    git(['commit', '-q', '-m', 'rename'], dir);
    // even with rename detection forced on in user config, both paths appear
    git(['config', 'diff.renames', 'true'], dir);
    const r = changedFiles(dir, 'main', 'feat/mv');
    assert.deepEqual([...r.files].sort(), ['src/export/csv.mjs', 'src/format/csv.mjs']);
  });
});

describe('patchId does not depend on user git config', () => {
  it('same change => same id under diff.noprefix, color.ui=always, diff.external, quotepath', () => {
    const dir = makeRepo();
    git(['checkout', '-q', '-b', 'a'], dir);
    commitFile(dir, 'y.txt', 'changed\n');
    const plain = patchId(dir, 'main', 'a').patchId;
    assert.match(plain, /^[0-9a-f]{40}/);
    git(['config', 'diff.noprefix', 'true'], dir);
    git(['config', 'color.ui', 'always'], dir);
    git(['config', 'diff.mnemonicPrefix', 'true'], dir);
    git(['config', 'core.quotepath', 'true'], dir);
    git(['config', 'diff.external', 'echo EXTERNAL-DIFF-OUTPUT'], dir);
    assert.equal(patchId(dir, 'main', 'a').patchId, plain);
  });
});

describe('listBranches: one process on the fast path, honest fallback, per-branch reasons', () => {
  function manyBranches(n) {
    const dir = makeRepo();
    for (let i = 0; i < n; i += 1) {
      git(['checkout', '-q', '-b', `b${i}`, 'main'], dir);
      commitFile(dir, `f${i}.txt`, `${i}\n`);
    }
    git(['checkout', '-q', 'main'], dir);
    commitFile(dir, 'x.txt', 'main moved\n');
    return dir;
  }
  const counting = () => { const calls = []; return { calls, exec: (args, cwd, o) => { calls.push(args); return runGit(args, cwd, o); } }; };

  it('spawns a constant number of git processes for 30 branches (ahead-behind atom)', () => {
    const dir = manyBranches(30);
    const many = counting();
    const r = listBranches(dir, 'main', { exec: many.exec });
    assert.equal(r.queried, true);
    assert.equal(r.partial, undefined);
    assert.equal(r.branches.length, 31);
    assert.equal(many.calls.length, 1, `expected one for-each-ref, got ${JSON.stringify(many.calls.map((c) => c[0]))}`);
    const b7 = r.branches.find((b) => b.name === 'b7');
    assert.deepEqual([b7.ahead, b7.behind], [1, 1]);
    const small = counting();
    listBranches(manyBranches(3), 'main', { exec: small.exec });
    assert.equal(small.calls.length, many.calls.length, 'process count must not grow with branch count');
  });
  it('the per-branch fallback yields the same counts', () => {
    const dir = manyBranches(5);
    const fast = listBranches(dir, 'main');
    const c = counting();
    const slow = listBranches(dir, 'main', { exec: c.exec, aheadBehind: false });
    assert.ok(c.calls.some((a) => a[0] === 'rev-list'));
    const key = (r) => r.branches.map((b) => [b.name, b.ahead, b.behind]);
    assert.deepEqual(key(slow), key(fast));
  });
  it('an unresolvable base falls back, keeps a reason per branch and is partial', () => {
    const dir = manyBranches(2);
    const r = listBranches(dir, 'no-such-base');
    assert.equal(r.queried, true);
    assert.equal(r.partial, true);
    assert.ok(r.branches.every((b) => b.ahead === null && b.countsReason));
  });
  it('one failing branch keeps its reason beside the null counts; the block is partial', () => {
    const dir = manyBranches(2);
    const bad = git(['rev-parse', 'b0'], dir);
    const exec = (args, cwd, o) => (args[0] === 'rev-list' && args.some((a) => a.includes(bad))
      ? { ok: false, status: 128, stdout: '', stderr: '', reason: 'git rev-list exited 128: injected' }
      : runGit(args, cwd, o));
    const r = listBranches(dir, 'main', { exec, aheadBehind: false });
    assert.equal(r.queried, true);
    assert.equal(r.partial, true);
    const b0 = r.branches.find((b) => b.name === 'b0');
    const b1 = r.branches.find((b) => b.name === 'b1');
    assert.deepEqual([b0.ahead, b0.behind, b0.countsReason], [null, null, 'git rev-list exited 128: injected']);
    assert.equal(b1.ahead, 1);
    assert.equal(b1.countsReason, undefined);
  });
});

describe('oid shape is exactly 40 or 64 hex', () => {
  const o = (n) => 'a'.repeat(n);
  it('parseLsRemote and parsePatchId accept 40/64 and reject 39/41/63', () => {
    for (const [n, okExpected] of [[40, true], [41, false], [63, false], [64, true], [39, false]]) {
      assert.equal(parseLsRemote(`${o(n)}\trefs/heads/main\n`, 'refs/heads/main') !== null, okExpected, `ls-remote ${n}`);
      assert.equal(parsePatchId(`${o(n)} ${o(40)}\n`) !== null, okExpected, `patch-id ${n}`);
    }
  });
});

describe('gh list robustness', () => {
  const row = (over = {}) => ({ number: 1, title: 't', url: 'https://github.com/o/n/pull/1', state: 'OPEN', headRefName: 'f', headRefOid: 'a'.repeat(40), baseRefName: 'main', baseRefOid: 'b'.repeat(40), statusCheckRollup: [], ...over });
  it('malformed rows never throw: [null], [1], non-list, non-array checks, null check record', () => {
    const t = (v) => parsePrList(JSON.stringify(v));
    for (const bad of [[null], [1], [[]], ['x']]) {
      const r = t(bad);
      assert.equal(r.queried, true);
      assert.equal(r.complete, false, JSON.stringify(bad));
      assert.deepEqual(r.prs, []);
      assert.equal(r.invalid.length, 1);
    }
    assert.deepEqual([t({ number: 1 }).queried, t({ number: 1 }).reason], [false, 'gh returned a non-list']);
    assert.equal(parsePrList('not json').queried, false);
    const nullCheck = t([row({ statusCheckRollup: [null] })]);
    assert.equal(nullCheck.complete, false);
    assert.match(nullCheck.invalid[0].reason, /non-object/);
    assert.equal(t([row({ statusCheckRollup: 'x' })]).invalid.length, 1);
    assert.equal(t([row({ number: 'one' })]).invalid.length, 1);
    assert.equal(validatePrRow(row()), null);
    const mixed = t([row(), null]);
    assert.deepEqual([mixed.prs.length, mixed.invalid.length, mixed.complete], [1, 1, false]);
    assert.equal(summariseChecks([null]).state, 'pending', 'a malformed check record is never a pass');
  });
  it('a result of exactly --limit rows is queried:true but complete:false with a reason', () => {
    const rows = Array.from({ length: PR_LIMIT }, (_, i) => row({ number: i + 1 }));
    const r = parsePrList(JSON.stringify(rows));
    assert.deepEqual([r.queried, r.complete, r.limit], [true, false, PR_LIMIT]);
    assert.match(r.reason, /truncated at 200/);
    const short = parsePrList(JSON.stringify(rows.slice(1)));
    assert.deepEqual([short.complete, short.reason], [true, undefined]);
  });
});

describe('parsePrList identity completeness', () => {
  it('a row carrying only a number is invalid and marks the list incomplete', () => {
    const r = parsePrList('[{"number":1}]');
    assert.equal(r.complete, false);
    assert.match(validatePrRow({ number: 1 }), /identity field/);
  });
  it('a row with all identity fields validates', () => {
    assert.equal(validatePrRow({
      number: 1, headRefName: 'a', headRefOid: 'a'.repeat(40), baseRefName: 'main', url: 'https://github.com/o/r/pull/1',
    }), null);
  });
});

describe('parsePrList never throws (hostile input)', () => {
  const hostile = [
    '[{"number":1,"statusCheckRollup":[{"conclusion":{"toString":null}}]}]',
    '[{"number":1,"state":{"toString":null}}]',
    '[{"number":1,"title":{"toString":null}}]',
    '[{"number":1,"headRepository":{"name":{"toString":null}}}]',
    '[{"number":1,"headRepositoryOwner":"x"}]',
    '[{"number":1,"headRepository":[]}]',
    '[{"number":1,"isDraft":"yes"}]',
    '[{"number":1,"statusCheckRollup":[[]]}]',
    '[{"number":1,"statusCheckRollup":[{"status":7}]}]',
    '[{"number":1,"statusCheckRollup":[{"state":{"toString":null}}]}]',
    '[{"number":1,"updatedAt":[1]}]',
    '[{"number":1.5}]', '[{"number":0}]', '[{"number":"1"}]', '[{"number":null}]',
    '[{"__proto__":{"number":1}}]',
    '[{"number":1,"__proto__":{"toString":null}}]',
    '[{"number":1,"url":{"toString":null}}]',
    '[[[[]]]]', '[true]', '[false]', '[0]', '[""]', 'null', '"x"', '12', '{}', '',
    `[{"number":1,"title":"${'x'.repeat(2_000_000)}","statusCheckRollup":[[${'['.repeat(50)}${']'.repeat(50)}]]}]`,
  ];
  it('every hostile payload returns an object, and invalid rows mark complete:false', () => {
    for (const text of hostile) {
      let r;
      assert.doesNotThrow(() => { r = parsePrList(text); }, text.slice(0, 80));
      assert.equal(typeof r.queried, 'boolean');
      assert.ok(Array.isArray(r.prs));
      if (r.queried && r.prs.length === 0) assert.equal(r.complete, false, `a row that yielded nothing must flag the list incomplete: ${text.slice(0, 80)}`);
      if (r.invalid?.length) assert.equal(r.complete, false);
    }
  });
  it('the exact reported cases are invalid items, not throws', () => {
    for (const text of ['[{"number":1,"statusCheckRollup":[{"conclusion":{"toString":null}}]}]', '[{"number":1,"state":{"toString":null}}]']) {
      const r = parsePrList(text);
      assert.deepEqual([r.queried, r.complete, r.prs.length, r.invalid.length], [true, false, 0, 1]);
    }
  });
});
