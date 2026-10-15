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
