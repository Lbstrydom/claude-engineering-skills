/**
 * @fileoverview An audit marker is evidence for THIS branch's history, or it is not evidence (fleet p-20261015130416-f9f9).
 *
 * Replay of the incident (2026-10-15): `.audit/last-audit-run.json` was written by the audit of branch
 * `fix/audit-generated-stores`; the next `/ship` commit was on `fix/audit-unadmitted-files`. `ship-commit` compared the
 * worktree identity to the caller's own `--expect-*` flags (which matched) and never compared the MARKER's `auditedBranch` /
 * `auditedSha` to the commit being made, so it stamped `AI-Gate: converged` and the other branch's `AI-Run-ID`. Caught only by
 * reading the trailer back.
 *
 * Fix under test: a marker whose `auditedBranch` differs from the committing branch, or whose `auditedSha` is not an ancestor
 * of HEAD, is treated as ABSENT (no AI-Run-ID, gate limited to not-run), and ship-commit says so.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeGitRunner, gitFixtureEnv, makeRepoTemplate } from './helpers/fixtures.mjs';
import { makeRunCli } from './helpers/run-cli.mjs';
import { identityArgs, scopeArgs } from './helpers/worktree-guard-args.mjs';
const { checkEvidenceProvenance } = await import('../scripts/lib/commit-trailers.mjs'); // namespace read: a missing export fails the unit tests, not the whole file

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/ship-commit.mjs');
const RUN_ID = 'ecae388d-c176-4182-9d27-0210b919b844';
let repo;
const git = makeGitRunner(() => repo);
const runCli = makeRunCli(CLI, {
  cwd: () => repo,
  command: process.execPath,
  buildEnv: (cwd) => ({ ...gitFixtureEnv(), AUDIT_DB_URL: '', HOME: cwd, USERPROFILE: cwd }),
});

const newRepo = makeRepoTemplate((dir) => {
  const g = (args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8', env: gitFixtureEnv() });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`);
  };
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  g(['config', 'commit.gpgsign', 'false']);
  fs.mkdirSync(path.join(dir, 'skills', 'ship'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n');
  g(['add', 'README.md']);
  g(['commit', '-q', '-m', 'seed']);
});
beforeEach(() => { repo = newRepo('ship-prov-'); });
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

const head = () => git(['rev-parse', 'HEAD']).trim();
const branch = () => git(['symbolic-ref', '--short', 'HEAD']).trim();

function arrange() {
  fs.mkdirSync(path.join(repo, '.claude', 'tmp'), { recursive: true });
  const mf = path.join('.claude', 'tmp', 'msg.txt');
  fs.writeFileSync(path.join(repo, mf), 'feat: subject\n\nbody\n');
  fs.writeFileSync(path.join(repo, 'work.txt'), `payload ${Date.now()}\n`);
  git(['add', 'work.txt']);
  return mf;
}
function marker(extra = {}) {
  fs.mkdirSync(path.join(repo, '.audit'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.audit', 'last-audit-run.json'),
    JSON.stringify({ runId: RUN_ID, ts: new Date(Date.now() + 60_000).toISOString(), ...extra }));
}
const run = (mf, gate) => runCli(['--message-file', mf, '--skill', 'ship', '--models', 'claude', '--gate', gate, ...identityArgs(repo), ...scopeArgs(repo, 'work.txt')]);

describe('checkEvidenceProvenance (the pure rule)', () => {
  const fresh = (o = {}) => ({ state: 'fresh', runId: RUN_ID, ts: 'x', ...o });
  const yes = () => true;
  const no = () => false;

  it('a marker from another branch is refused, naming both branches', () => {
    const v = checkEvidenceProvenance({ evidence: fresh({ auditedBranch: 'fix/audit-generated-stores' }), committingBranch: 'fix/audit-unadmitted-files', isAncestor: yes });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'branch-mismatch');
    assert.match(v.detail, /fix\/audit-generated-stores/);
    assert.match(v.detail, /fix\/audit-unadmitted-files/);
  });
  it('an audited sha that is not an ancestor of HEAD is refused', () => {
    const v = checkEvidenceProvenance({ evidence: fresh({ auditedBranch: 'main', auditedSha: 'a'.repeat(40) }), committingBranch: 'main', isAncestor: no });
    assert.deepEqual([v.ok, v.reason], [false, 'sha-not-ancestor']);
  });
  it('a stale marker is judged the same way', () => {
    const v = checkEvidenceProvenance({ evidence: { state: 'stale', runId: RUN_ID, ts: 'x', auditedBranch: 'other' }, committingBranch: 'main', isAncestor: yes });
    assert.equal(v.ok, false);
  });

  // The directions it must NOT fire: a gate that also refuses honest evidence is the cried-wolf gate.
  it('control: same branch + ancestor sha is accepted', () => {
    assert.equal(checkEvidenceProvenance({ evidence: fresh({ auditedBranch: 'main', auditedSha: 'b'.repeat(40) }), committingBranch: 'main', isAncestor: yes }).ok, true);
  });
  it('control: a legacy marker with no branch/sha is accepted (it supports not-run/waived; it cannot support passed)', () => {
    assert.equal(checkEvidenceProvenance({ evidence: fresh(), committingBranch: 'main', isAncestor: no }).ok, true);
  });
  it('control: a marker captured DETACHED (auditedBranch null) is not a branch mismatch', () => {
    assert.equal(checkEvidenceProvenance({ evidence: fresh({ auditedBranch: null }), committingBranch: 'main', isAncestor: yes }).ok, true);
  });
  it('control: absent, opted-out and malformed evidence are not this rule\'s business', () => {
    for (const state of ['absent', 'opted-out', 'malformed', 'unreadable']) {
      assert.equal(checkEvidenceProvenance({ evidence: { state }, committingBranch: 'main', isAncestor: no }).ok, true, state);
    }
  });
  it('a detached commit against a marker that names a branch is a mismatch', () => {
    assert.equal(checkEvidenceProvenance({ evidence: fresh({ auditedBranch: 'main' }), committingBranch: null, isAncestor: yes }).ok, false);
  });
});

describe('ship-commit CLI: the incident, replayed', () => {
  it('a marker from ANOTHER branch: --gate not-run now lands without its AI-Run-ID (it used to be refused as "an audit ran after HEAD")', () => {
    const mf = arrange();
    marker({ auditedBranch: 'fix/audit-generated-stores', auditedSha: head() });
    const r = run(mf, 'not-run');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /audit evidence IGNORED/);
    assert.match(r.stderr, /fix\/audit-generated-stores/);
    const body = git(['log', '-1', '--format=%B']);
    assert.match(body, /AI-Gate: not-run/);
    assert.doesNotMatch(body, /AI-Run-ID/, 'the other branch\'s run id must not be stamped on this commit');
  });

  it('...and claiming a verified or waived gate on it is refused, not stamped', () => {
    const mf = arrange();
    marker({ auditedBranch: 'fix/audit-generated-stores', auditedSha: head() });
    for (const gate of ['converged', 'passed', 'waived']) {
      const r = run(mf, gate);
      assert.equal(r.status, 2, `${gate}: ${r.stderr}`);
    }
    assert.equal(git(['rev-list', '--count', 'HEAD']).trim(), '1', 'nothing was committed');
  });

  it('an audited sha that is not in this branch\'s history is ignored the same way', () => {
    const mf = arrange();
    marker({ auditedBranch: branch(), auditedSha: 'c'.repeat(40) });
    const r = run(mf, 'not-run');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /not an ancestor/);
    assert.doesNotMatch(git(['log', '-1', '--format=%B']), /AI-Run-ID/);
  });

  describe('unborn HEAD (audit-code R1-H1): the first commit of a fresh repo is judged too', () => {
    function fresh(markerExtra) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-prov-fresh-'));
      const g = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf-8', env: gitFixtureEnv() });
      g(['init', '-q', '-b', 'main']); g(['config', 'user.email', 't@e.c']); g(['config', 'user.name', 'T']); g(['config', 'commit.gpgsign', 'false']);
      fs.mkdirSync(path.join(dir, 'skills', 'ship'), { recursive: true });
      fs.mkdirSync(path.join(dir, '.claude', 'tmp'), { recursive: true });
      fs.mkdirSync(path.join(dir, '.audit'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.claude', 'tmp', 'msg.txt'), ['feat: first commit', '', 'body', ''].join('\n'));
      fs.writeFileSync(path.join(dir, '.audit', 'last-audit-run.json'), JSON.stringify({ runId: RUN_ID, ts: new Date(Date.now() + 60_000).toISOString(), ...markerExtra }));
      fs.writeFileSync(path.join(dir, 'work.txt'), 'x');
      g(['add', 'work.txt']);
      const r = runCli(['--message-file', path.join('.claude', 'tmp', 'msg.txt'), '--skill', 'ship', '--models', 'claude', '--gate', 'not-run', '--path', 'work.txt'], dir);
      const body = g(['log', '-1', '--format=%B']).stdout;
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return { r, body };
    }
    it('a marker naming ANOTHER branch is ignored on the first commit', () => {
      const { r, body } = fresh({ auditedBranch: 'fix/somewhere-else' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /audit evidence IGNORED \(branch-mismatch\)/);
      assert.doesNotMatch(body, /AI-Run-ID/);
    });
    it('a marker with an audited sha is ignored: it cannot be an ancestor of a history that does not exist', () => {
      const { r, body } = fresh({ auditedBranch: 'main', auditedSha: 'd'.repeat(40) });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /not an ancestor/);
      assert.doesNotMatch(body, /AI-Run-ID/);
    });
  });

  it('control: the marker of THIS branch, audited sha an ancestor of HEAD, is still evidence (waived keeps its AI-Run-ID)', () => {
    const mf = arrange();
    marker({ auditedBranch: branch(), auditedSha: head() });
    const r = run(mf, 'waived');
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /IGNORED/);
    const body = git(['log', '-1', '--format=%B']);
    assert.match(body, new RegExp(`AI-Run-ID: ${RUN_ID}`));
    assert.match(body, /AI-Gate: waived/);
  });
});

// ── fleet p-20261015194540-f757: a rebase moves the audited sha out of HEAD without touching the branch's own patches ──────────────
describe('checkEvidenceProvenance - range-diff equivalence (the pure rule)', () => {
  const fresh = (o = {}) => ({ state: 'fresh', runId: RUN_ID, ts: 'x', auditedBranch: 'feat', auditedSha: 'a'.repeat(40), auditedTree: 'b'.repeat(40), ...o });
  const no = () => false;
  it('a non-ancestor audited sha is accepted when the branch\'s own patches are the audited commits\', and the result says so', () => {
    let asked = null;
    const v = checkEvidenceProvenance({ evidence: fresh(), committingBranch: 'feat', isAncestor: no, patchEquivalence: (sha, tree) => { asked = [sha, tree]; return { equivalent: true, commits: 2 }; } });
    assert.deepEqual(v, { ok: true, equivalence: { kind: 'range-diff', commits: 2, auditedSha: 'a'.repeat(40) } });
    assert.deepEqual(asked, ['a'.repeat(40), 'b'.repeat(40)]);
  });
  it('NOT equivalent -> still refused, and the detail carries the comparison\'s reason', () => {
    const v = checkEvidenceProvenance({ evidence: fresh(), committingBranch: 'feat', isAncestor: no, patchEquivalence: () => ({ equivalent: false, reason: 'the patches differ: audited 2 own commit(s), pushed 3' }) });
    assert.deepEqual([v.ok, v.reason], [false, 'sha-not-ancestor']);
    assert.match(v.detail, /not range-diff-equivalent.*pushed 3/);
  });
  it('equivalence never rescues a BRANCH mismatch, and is never consulted for an ancestor (the cheap, stronger rule wins)', () => {
    const boom = () => { throw new Error('must not be asked'); };
    assert.equal(checkEvidenceProvenance({ evidence: fresh({ auditedBranch: 'other' }), committingBranch: 'feat', isAncestor: no, patchEquivalence: () => ({ equivalent: true, commits: 1 }) }).reason, 'branch-mismatch');
    assert.deepEqual(checkEvidenceProvenance({ evidence: fresh(), committingBranch: 'feat', isAncestor: () => true, patchEquivalence: boom }), { ok: true });
  });
  it('without a predicate the v12 behaviour is byte-identical (a rebased marker is refused)', () => {
    const v = checkEvidenceProvenance({ evidence: fresh(), committingBranch: 'feat', isAncestor: no });
    assert.deepEqual([v.ok, v.reason], [false, 'sha-not-ancestor']);
    assert.doesNotMatch(v.detail, /range-diff/);
  });
});

describe('ship-commit CLI: a ship whose audit predates a pure rebase (the #262 case)', () => {
  /** feature = [A, B] on main; audited at its tip; then main moves and the feature is rebased onto it. */
  function auditedThenRebased({ amendAfterRebase = false } = {}) {
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(['checkout', '-q', '-b', 'feat']);
    for (const [f, t] of [['a.txt', 'a1\na2\n'], ['b.txt', 'b1\nb2\n']]) { fs.writeFileSync(path.join(repo, f), t); git(['add', f]); git(['commit', '-q', '-m', `add ${f}`]); }
    const audited = head();
    const auditedTree = git(['rev-parse', 'HEAD^{tree}']).trim();
    git(['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(repo, 'main-only.txt'), 'moved\n'); git(['add', 'main-only.txt']); git(['commit', '-q', '-m', 'main moves']);
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(['checkout', '-q', 'feat']);
    git(['rebase', 'main']);
    if (amendAfterRebase) { fs.writeFileSync(path.join(repo, 'b.txt'), 'b1\nB2\n'); git(['commit', '-q', '-a', '--amend', '--no-edit']); }
    assert.notEqual(git(['rev-parse', 'HEAD']).trim(), audited, 'fixture: the audited commit is no longer HEAD');
    return { audited, auditedTree };
  }

  it('the rebased ship keeps its AI-Run-ID, says RANGE-DIFF-EQUIVALENT, and may claim waived (it could never claim passed: the tree moved)', () => {
    const { audited, auditedTree } = auditedThenRebased();
    const mf = arrange();
    marker({ auditedBranch: 'feat', auditedSha: audited, auditedTree });
    const r = run(mf, 'waived');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /RANGE-DIFF-EQUIVALENT.*2 own commit\(s\)/);
    assert.doesNotMatch(r.stderr, /IGNORED/);
    assert.match(git(['log', '-1', '--format=%B']), new RegExp(`AI-Run-ID: ${RUN_ID}`));
  });
  it('NEGATIVE CONTROL: the same rebase with one byte changed afterwards is IGNORED exactly as in v12 (no AI-Run-ID, nothing verified)', () => {
    const { audited, auditedTree } = auditedThenRebased({ amendAfterRebase: true });
    const mf = arrange();
    marker({ auditedBranch: 'feat', auditedSha: audited, auditedTree });
    const r = run(mf, 'not-run');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /audit evidence IGNORED \(sha-not-ancestor\).*not range-diff-equivalent/);
    assert.doesNotMatch(git(['log', '-1', '--format=%B']), /AI-Run-ID/);
  });
});
