import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { recordSuiteRun, readSuiteRunRecord, gitCommonDir } from '../scripts/lib/suite-run-record.mjs';
import { completeRun, adjudicateRun } from '../scripts/run-tests.mjs';
import { GUARD_REPORT_VERSION } from '../scripts/lib/test-guard-reporter.mjs';

const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const run = (over = {}) => ({ preflight: false, tierSkip: null, userArgs: [], exitCode: 0, wallMs: 1234, files: 7, ...over });
const GREEN = JSON.stringify({ version: GUARD_REPORT_VERSION, failures: [] });

/** A temp repo with one commit and a LINKED worktree: the pre-push sandbox and every chip run from the latter. */
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'suite-run-wt-')));
  roots.push(root);
  const main = path.join(root, 'main'); fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const linked = path.join(root, 'linked');
  git(main, 'worktree', 'add', '-q', '-b', 'side', linked);
  return { main, linked };
}

describe('recordSuiteRun at the runner seam', () => {
  it('a write from a LINKED worktree lands in the common dir the main checkout reads', () => {
    const { main, linked } = fixture();
    const r = recordSuiteRun({ ...run(), cwd: linked });
    assert.deepEqual({ written: r.written, kind: r.kind, note: r.note }, { written: true, kind: 'full', note: null });
    assert.equal(gitCommonDir(linked), gitCommonDir(main));
    const read = readSuiteRunRecord(gitCommonDir(main), 'full', new Date());
    assert.equal(read.measured, true);
    assert.equal(read.value.ms, 1234);
    assert.equal(read.value.files, 7);
    assert.match(read.value.head, /^[0-9a-f]{40}$/);
  });
  it('a tier-skip run writes the branch kind and leaves full untouched', () => {
    const { main } = fixture();
    assert.equal(recordSuiteRun({ ...run({ tierSkip: { skipped: [] } }), cwd: main }).kind, 'branch');
    const dir = gitCommonDir(main);
    assert.equal(readSuiteRunRecord(dir, 'branch', new Date()).measured, true);
    assert.equal(readSuiteRunRecord(dir, 'full', new Date()).measured, false);
  });
  for (const [label, over] of [
    ['a preflight', { preflight: true }],
    ['a caller-narrowed run', { userArgs: ['tests/a.test.mjs'] }],
    ['a caller-narrowed tier run', { tierSkip: { skipped: [] }, userArgs: ['tests/a.test.mjs'] }],
    ['a failing run', { exitCode: 1 }],
    ['a signal-killed run', { exitCode: 143 }],
  ]) {
    it(`${label} writes nothing`, () => {
      const { main } = fixture();
      const r = recordSuiteRun({ ...run(over), cwd: main });
      assert.equal(r.written, false);
      assert.equal(fs.existsSync(path.join(gitCommonDir(main), 'suite-runs')), false);
    });
  }
  it('a throwing write returns a note and does not throw', () => {
    const { main } = fixture();
    const r = recordSuiteRun({ ...run(), cwd: main, write: () => { const e = new Error('disk full'); e.code = 'ENOSPC'; throw e; } });
    assert.equal(r.written, false);
    assert.match(r.note, /not written \(ENOSPC\)/);
  });
  it('a pathological thrown value still returns a note', () => {
    const { main } = fixture();
    const nasty = { get message() { throw new Error('x'); } };
    const r = recordSuiteRun({ ...run(), cwd: main, write: () => { throw nasty; } });
    assert.equal(r.written, false);
    assert.match(r.note, /not written/);
  });
  it('outside a git work tree it notes instead of throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-git-')); roots.push(dir);
    const r = recordSuiteRun({ ...run(), cwd: dir, commonDirOf: () => null });
    assert.equal(r.written, false);
    assert.match(r.note, /no git common dir/);
  });
});

describe('completeRun: the record is evidence, never part of the verdict', () => {
  const base = { status: 0, reportText: GREEN, timingText: null, tierSkip: null, userArgs: [], wallMs: 5000, cwd: process.cwd() };
  const spy = () => { const calls = []; return { calls, record: (a) => { calls.push(a); return { written: true, kind: 'full', note: null }; } }; };
  const quiet = () => ({ written: false, kind: null, note: null });

  it('hands the recorder the ADJUDICATED exit code, not the raw child status', () => {
    const s = spy();
    // status 0 with no guard report: adjudicateRun fails closed, so the recorder must see non-zero, not the raw 0
    const raw = adjudicateRun({ status: 0, reportText: null });
    assert.notEqual(raw.exitCode, 0, 'precondition: this fixture must fail closed');
    const out = completeRun({ ...base, reportText: null, record: s.record });
    assert.equal(out.exitCode, raw.exitCode);
    assert.equal(s.calls[0].exitCode, raw.exitCode);
  });
  it('passes the exact measured duration and the caller scope through', () => {
    const s = spy();
    completeRun({ ...base, wallMs: 4321.5, userArgs: ['tests/a.test.mjs'], record: s.record });
    assert.equal(s.calls[0].wallMs, 4321.5);
    assert.deepEqual(s.calls[0].userArgs, ['tests/a.test.mjs']);
  });
  it('a recorder that returns a failure note leaves the exit code unchanged and prints the note', () => {
    const plain = completeRun({ ...base, record: quiet });
    const noted = completeRun({ ...base, record: () => ({ written: false, kind: 'full', note: 'suite-run record: not written (ENOSPC)' }) });
    assert.equal(plain.exitCode, 0);
    assert.equal(noted.exitCode, 0);
    assert.ok(noted.lines.includes('suite-run record: not written (ENOSPC)'));
  });
  it('a recorder that THROWS leaves the exit code unchanged and still yields a note', () => {
    const out = completeRun({ ...base, record: () => { throw Object.assign(new Error('boom'), { code: 'EIO' }); } });
    assert.equal(out.exitCode, 0);
    assert.ok(out.lines.some((l) => /not written \(EIO\)/.test(l)));
  });
  it('a failing run stays failing whatever the recorder does', () => {
    const out = completeRun({ ...base, status: 1, record: () => { throw new Error('x'); } });
    assert.equal(out.exitCode, 1);
  });
  it('a preflight is reported to the recorder as a preflight (so it records nothing)', () => {
    const s = spy();
    completeRun({ ...base, preflight: { skipped: [], expected: new Set() }, record: s.record });
    assert.equal(s.calls[0].preflight, true);
  });
  it('end to end with the real recorder: a green full run is filed once, from a linked worktree', () => {
    const { main, linked } = fixture();
    const out = completeRun({ ...base, cwd: linked });
    assert.equal(out.exitCode, 0);
    const read = readSuiteRunRecord(gitCommonDir(main), 'full', new Date());
    assert.equal(read.measured, true);
    assert.equal(read.value.ms, 5000);
  });
  it('end to end with the real recorder: a run the guard fails closed files nothing', () => {
    const { main, linked } = fixture();
    const out = completeRun({ ...base, reportText: null, cwd: linked });
    assert.notEqual(out.exitCode, 0);
    assert.equal(readSuiteRunRecord(gitCommonDir(main), 'full', new Date()).measured, false);
  });
});
