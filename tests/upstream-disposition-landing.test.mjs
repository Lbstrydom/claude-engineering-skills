/**
 * @fileoverview `upstream fix|wont-fix` says what its ledger write left behind
 * (plan: docs/plans/upstream-disposition-landing.md §2.3).
 *
 * The closing command writes the disposition entry into a COMMITTED file in the
 * closer's checkout. On 2026-10-10 nothing told the closer that the entry was
 * uncommitted, or that until it landed every push in the repo would trip the
 * reconcile gate. These tests pin three things: the envelope field
 * (`dispositionFile`), the landing assessment it carries, and the operator notice
 * keyed on BOTH outcomes. A failed store transition must never print commit
 * instructions (plan-audit R1 H1).
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { upstreamTransition } from '../scripts/lib/upstream/commands.mjs';
import { assessDispositionLanding, LANDING_BASE_REF } from '../scripts/lib/upstream/disposition-ledger.mjs';
import { upstreamCmd, renderDispositionFileNotice } from '../scripts/lib/cross-skill/commands/quality.mjs';
import { _resetRepoRootCache } from '../scripts/lib/assert-repo-root.mjs';

const LEDGER_REL = path.join('scripts', 'upstream-dispositions.json');
const ID = 'dddddddd-1111-4222-8333-444444444444';
const DISP = { kind: 'exempt', value: 'synthetic test reason' };
const ENTRY = { issueId: ID, state: 'wont_fix', disposition: DISP };

describe('assessDispositionLanding (pure)', () => {
  const read = (entries) => ({ status: 'read', entries, reason: null });
  it('true when the base carries the same state + disposition (recordedAt ignored)', () => {
    const r = assessDispositionLanding({ entry: ENTRY, baseLedger: read([{ ...ENTRY, recordedAt: 'whenever' }]) });
    assert.equal(r.landed, true);
  });
  it('false when the base lacks the entry', () => {
    assert.equal(assessDispositionLanding({ entry: ENTRY, baseLedger: read([]) }).landed, false);
  });
  it('false when the base carries a DIFFERENT disposition for the issue', () => {
    const r = assessDispositionLanding({
      entry: ENTRY, baseLedger: read([{ ...ENTRY, disposition: { kind: 'exempt', value: 'other' } }]),
    });
    assert.equal(r.landed, false);
    assert.match(r.reason, /DIFFERENT/);
  });
  it('false (determinate) when the base has no ledger at all', () => {
    assert.equal(assessDispositionLanding({ entry: ENTRY, baseLedger: { status: 'absent', entries: null } }).landed, false);
  });
  for (const status of ['unreadable', 'malformed']) {
    it(`null (unknown, never "no") when the base ledger is ${status}`, () => {
      assert.equal(assessDispositionLanding({ entry: ENTRY, baseLedger: { status, entries: null } }).landed, null);
    });
  }
});

describe('renderDispositionFileNotice (pure)', () => {
  const file = (over) => ({
    path: 'scripts/upstream-dispositions.json', written: true, landed: false, base: 'origin/main',
    reason: null, storeTransitioned: true, ...over,
  });
  it('success + not landed: says it is uncommitted, what it causes, and exactly how to land it', () => {
    const text = renderDispositionFileNotice(file({}), ID).join('\n');
    assert.match(text, /UNCOMMITTED/);
    assert.match(text, /upstream:reconcile:gate/);
    assert.match(text, /git add -- scripts\/upstream-dispositions\.json/);
    assert.match(text, /chore\(upstream\): record dddddddd disposition/);
    assert.match(text, /pre-attribution gate FAIL/);
    assert.doesNotMatch(text, /<[a-z]/i, 'PowerShell-safe: no angle-bracket placeholders');
  });
  it('a FAILED store transition never prints commit instructions, and says not to commit', () => {
    const text = renderDispositionFileNotice(file({ storeTransitioned: false }), ID).join('\n');
    assert.match(text, /Do NOT commit/);
    assert.doesNotMatch(text, /git add|git commit|open a PR/);
  });
  it('silent when the entry has already landed, or nothing was written', () => {
    assert.deepEqual(renderDispositionFileNotice(file({ landed: true }), ID), []);
    assert.deepEqual(renderDispositionFileNotice(null, ID), []);
  });
  it('an unknown landing still prints the instructions, naming why it could not tell', () => {
    const text = renderDispositionFileNotice(file({ landed: null, reason: 'no such ref' }), ID).join('\n');
    assert.match(text, /could not be checked \(no such ref\)/);
    assert.match(text, /git add --/);
  });
});

describe('upstreamTransition + the dispatcher (real git, temp repo)', () => {
  let repo, origCwd, savedDsn;
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  before(() => {
    origCwd = process.cwd();
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'disposition-landing-'));
    git('init', '-q');
    git('config', 'user.email', 't@example.invalid');
    git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'README'), 'x\n');
    git('add', 'README');
    git('commit', '-q', '-m', 'root');
    // The base branch every session branches from, as of "the last fetch".
    git('update-ref', LANDING_BASE_REF, 'HEAD');
  });
  after(() => {
    process.chdir(origCwd);
    _resetRepoRootCache();
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  beforeEach(() => {
    savedDsn = process.env.AUDIT_DB_URL;
    delete process.env.AUDIT_DB_URL;
    fs.rmSync(path.join(repo, 'scripts'), { recursive: true, force: true });
  });
  afterEach(() => {
    process.chdir(origCwd);
    _resetRepoRootCache();
    if (savedDsn === undefined) delete process.env.AUDIT_DB_URL; else process.env.AUDIT_DB_URL = savedDsn;
  });

  const close = (transitionFn) => upstreamTransition({
    repoRoot: repo, id: ID, to: 'wont_fix', note: 'reason', disposition: 'exempt:synthetic test reason',
    storeFingerprint: null, transitionFn,
  });

  it('envelope carries dispositionFile: written, NOT landed, store transitioned', async () => {
    const res = await close(async () => ({ ok: true }));
    assert.equal(res.ok, true);
    assert.deepEqual(
      { path: res.dispositionFile.path, written: res.dispositionFile.written, landed: res.dispositionFile.landed,
        base: res.dispositionFile.base, storeTransitioned: res.dispositionFile.storeTransitioned },
      { path: 'scripts/upstream-dispositions.json', written: true, landed: false, base: 'origin/main', storeTransitioned: true },
    );
  });

  it('landed: true once origin/main already carries the same entry', async () => {
    await close(async () => ({ ok: true }));
    git('add', '--', LEDGER_REL);
    git('commit', '-q', '-m', 'land it');
    git('update-ref', LANDING_BASE_REF, 'HEAD');
    const res = await close(async () => ({ ok: true }));
    assert.equal(res.dispositionFile.landed, true);
    git('update-ref', LANDING_BASE_REF, 'HEAD~1');
    git('reset', '-q', '--hard', 'HEAD~1');
  });

  it('a failed store transition is reported as storeTransitioned: false', async () => {
    const res = await close(async () => ({ ok: false, error: 'store unreachable' }));
    assert.equal(res.ok, false);
    assert.equal(res.dispositionFile.written, true);
    assert.equal(res.dispositionFile.storeTransitioned, false);
  });

  it('`ack` writes no ledger entry and carries no dispositionFile', async () => {
    const res = await upstreamTransition({
      repoRoot: repo, id: ID, to: 'acknowledged', storeFingerprint: null, transitionFn: async () => ({ ok: true }),
    });
    assert.equal(res.dispositionFile, undefined);
  });

  const ctxFor = (transitionResult) => ({
    verb: 'wont-fix',
    cloud: { enabled: false },
    flag: (name) => ({ id: ID, note: 'reason', disposition: 'exempt:synthetic test reason' })[name] ?? null,
    hasFlag: () => false,
    resolveScope: async () => ({ kind: 'none' }),
    deps: { transitionUpstreamIssue: async () => transitionResult },
  });
  async function captureStderr(fn) {
    let err = '';
    const orig = process.stderr.write;
    process.stderr.write = (chunk, ...rest) => { err += chunk; return orig.call(process.stderr, chunk, ...rest); };
    try { return { out: await fn(), err: () => err }; } catch (e) { return { thrown: e, err: () => err }; } finally {
      process.stderr.write = orig;
    }
  }

  it('dispatcher: a successful close prints the landing notice and returns dispositionFile', async () => {
    process.chdir(repo);
    _resetRepoRootCache();
    const { out, thrown, err } = await captureStderr(() => upstreamCmd(ctxFor({ ok: true })));
    assert.equal(thrown, undefined, thrown?.message);
    assert.equal(out.dispositionFile.landed, false);
    assert.match(err(), /git add -- scripts\/upstream-dispositions\.json/);
  });

  it('dispatcher: a FAILED close keeps its error and exit, and prints no commit instruction', async () => {
    process.chdir(repo);
    _resetRepoRootCache();
    const { thrown, err } = await captureStderr(() => upstreamCmd(ctxFor({ ok: false, error: 'store unreachable' })));
    assert.ok(thrown, 'the original failure must still throw');
    assert.match(thrown.message, /store unreachable/);
    assert.equal(thrown.extra.dispositionFile.storeTransitioned, false);
    assert.match(err(), /Do NOT commit/);
    assert.doesNotMatch(err(), /git add|git commit/);
  });
});
