/**
 * @fileoverview The v16 hook's pure deciders and its version inspector (docs/plans/hook-fidelity-and-v15-field-gaps.md §2.1, §2.2, §2.5).
 * The hook-level behaviour (the real body, a real origin) is tests/prepush-hook-v16.test.mjs; this file pins each decider's failure
 * directions, the trailer sync:pr writes, the lane exit table the hook's case arms depend on, and the hook-version inspector against real
 * repositories (ordinary hook, linked worktree, relative core.hooksPath) with DIFFERENT versions in source and target.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  parseSyncBundleTrailer, decideLanding, decideSyncLane, SYNC_BUNDLE_TRAILER,
} from '../scripts/lib/prepush-lanes.mjs';
import { buildPrText } from '../scripts/lib/sync-pr.mjs';
import { EXIT_FOR } from '../scripts/lib/prepush-archive-lane.mjs';
import { _internals } from '../scripts/install-prepush-hook.mjs';
import {
  PREPUSH_HOOK_VERSION, installedHookVersion, inspectInstalledHook, effectiveHookPath, hookEpilogueLines, HOOK_MARKER,
} from '../scripts/lib/prepush-hook-version.mjs';
import { gitFixtureEnv } from './helpers/fixtures.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'c'.repeat(40);
const ZERO = '0'.repeat(40);

describe('parseSyncBundleTrailer', () => {
  it('reads exactly one trailer in the last paragraph', () => {
    assert.equal(parseSyncBundleTrailer(`title\n\nbody\n\n${SYNC_BUNDLE_TRAILER}: ${SHA}\n`), SHA);
  });
  it('refuses two, a short sha, prose that merely contains the word, and a trailer outside the last paragraph', () => {
    assert.equal(parseSyncBundleTrailer(`t\n\n${SYNC_BUNDLE_TRAILER}: ${SHA}\n${SYNC_BUNDLE_TRAILER}: ${OTHER}`), null);
    assert.equal(parseSyncBundleTrailer(`t\n\n${SYNC_BUNDLE_TRAILER}: abc123`), null);
    assert.equal(parseSyncBundleTrailer('t\n\nwe mention Sync-Bundle in prose'), null);
    assert.equal(parseSyncBundleTrailer(`t\n\n${SYNC_BUNDLE_TRAILER}: ${SHA}\n\nmore text after`), null);
    assert.equal(parseSyncBundleTrailer(''), null);
  });
  it('sync:pr\'s own commit message round-trips through it (producer and consumer cannot drift)', () => {
    const { message } = buildPrText({ repo: 'o/r', commitSha: SHA, surface: ['.claude/skills/x/SKILL.md'], leftBehind: [], consumerName: 'c' });
    assert.equal(parseSyncBundleTrailer(message), SHA);
    assert.doesNotMatch(message, /^AI-/m, 'the AI-* trailer namespace stays reserved for ship-commit');
  });
});

describe('decideLanding', () => {
  const tag = (n = 't') => ({ remoteRef: `refs/tags/${n}`, localSha: SHA });
  const held = () => 0;
  it('none only when every ref is a tag whose commits the destination holds', () => {
    assert.deepEqual(decideLanding({ entries: [tag('a'), tag('b')], malformed: 0, tips: [SHA, SHA], unpublishedCount: held }), { kind: 'none', tags: 2 });
  });
  it('code for: a branch update, a malformed line, an unresolved tip, an unknown or non-zero unpublished count, no published ref', () => {
    const base = { entries: [tag()], malformed: 0, tips: [SHA], unpublishedCount: held };
    assert.equal(decideLanding({ ...base, entries: [{ remoteRef: 'refs/heads/main', localSha: SHA }] }).kind, 'code');
    assert.equal(decideLanding({ ...base, malformed: 1 }).kind, 'code');
    assert.equal(decideLanding({ ...base, tips: [null] }).kind, 'code');
    assert.equal(decideLanding({ ...base, unpublishedCount: () => null }).kind, 'code');
    assert.equal(decideLanding({ ...base, unpublishedCount: () => 3 }).kind, 'code');
    assert.equal(decideLanding({ ...base, entries: [{ remoteRef: 'refs/tags/x', localSha: ZERO }], tips: [] }).kind, 'code');
  });
});

describe('decideSyncLane - each failure direction', () => {
  const owned = () => true;
  const good = () => ({
    entries: [{ localRef: 'refs/heads/chore/sync-aaaaaaaa', localSha: SHA, remoteRef: 'refs/heads/chore/sync-aaaaaaaa', remoteSha: ZERO }], malformed: 0,
    exportedBase: OTHER, exportedHead: SHA,
    commits: [{ sha: SHA, parents: [OTHER], message: `t\n\n${SYNC_BUNDLE_TRAILER}: ${'b'.repeat(40)}` }],
    basePublished: true,
    changes: [{ status: 'M', path: '.claude/skills/x/SKILL.md' }],
    receiptEntry: { source: { repo: 'o/r', commitSha: 'b'.repeat(40) } },
    isOwned: owned, gitignoreBlockOnly: null,
  });
  it('the good shape passes', () => assert.equal(decideSyncLane(good()).syncLane, true));
  const bad = [
    ['two ref updates', (f) => { f.entries.push({ ...f.entries[0], remoteRef: 'refs/tags/x' }); }],
    ['a tag, not a branch', (f) => { f.entries[0].remoteRef = 'refs/tags/x'; }],
    ['a different pushed commit than the exported range', (f) => { f.exportedHead = OTHER; }],
    ['two commits', (f) => { f.commits.push(f.commits[0]); }],
    ['a merge commit', (f) => { f.commits[0].parents.push(SHA); }],
    ['a parent that is not the range base', (f) => { f.commits[0].parents = [SHA]; }],
    ['a new branch whose base the destination was not shown to hold', (f) => { f.basePublished = null; }],
    ['rewritten history (remote tip is not the base)', (f) => { f.entries[0].remoteSha = SHA; }],
    ['no trailer', (f) => { f.commits[0].message = 'plain'; }],
    ['a receipt for another bundle', (f) => { f.receiptEntry.source.commitSha = OTHER; }],
    ['no receipt', (f) => { f.receiptEntry = null; }],
    ['unknown changes', (f) => { f.changes = null; }],
    ['a path the sync does not own', (f) => { f.isOwned = ({ path: p }) => p !== '.claude/skills/x/SKILL.md'; }],
    ['a .gitignore edit that is not block-only', (f) => { f.changes.push({ status: 'M', path: '.gitignore' }); f.gitignoreBlockOnly = () => false; }],
    ['a .gitignore edit with no oracle', (f) => { f.changes.push({ status: 'M', path: '.gitignore' }); }],
  ];
  for (const [name, mutate] of bad) {
    it(`NEGATIVE: ${name} is not sanctioned`, () => {
      const f = good(); mutate(f);
      const d = decideSyncLane(f);
      assert.equal(d.syncLane, false);
      assert.ok(d.reason.length > 0);
    });
  }
  it('an update (non-zero remote tip equal to the base) needs no publication proof', () => {
    const f = good(); f.entries[0].remoteSha = OTHER; f.basePublished = null;
    assert.equal(decideSyncLane(f).syncLane, true);
  });
  it('a block-only .gitignore edit rides along', () => {
    const f = good(); f.changes.push({ status: 'M', path: '.gitignore' }); f.gitignoreBlockOnly = () => true;
    assert.equal(decideSyncLane(f).syncLane, true);
  });
});

describe('the archive lane exit table the hook reads', () => {
  const body = _internals.HOOK_BODY;
  it('EXIT_FOR is clean 0, findings/error 1, not-applicable 3 - the very pairs the consumer hook\'s case arms accept', () => {
    assert.deepEqual({ ...EXIT_FOR }, { clean: 0, findings: 1, error: 1, 'not-applicable': 3 });
    for (const [outcome, code] of Object.entries(EXIT_FOR)) {
      if (outcome === 'error' || outcome === 'findings') assert.ok(body.includes(`${code}:findings|${code}:error`) || body.includes(`1:findings|1:error`));
    }
    assert.ok(body.includes('0:clean)'));
    assert.ok(body.includes('3:not-applicable)'));
  });
});

describe('hook-version inspector', () => {
  const env = gitFixtureEnv();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hookver-'));
  const run = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const init = (dir) => { fs.mkdirSync(dir, { recursive: true }); run(tmp, 'init', '-q', dir); run(dir, 'config', 'user.email', 't@t.t'); run(dir, 'config', 'user.name', 't'); fs.writeFileSync(path.join(dir, 'f'), 'x'); run(dir, 'add', '-A'); run(dir, 'commit', '-qm', 'i'); };
  const hookText = (v) => `#!/bin/sh\n${HOOK_MARKER}\n# hook-version: ${v}\nexit 0\n`;
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

  const source = path.join(tmp, 'source');       // the repo the sync runs FROM: its own hook is v99
  const ordinary = path.join(tmp, 'ordinary');
  const main = path.join(tmp, 'main');
  const wt = path.join(tmp, 'wt');
  const custom = path.join(tmp, 'custom');
  init(source); put(path.join(source, '.git', 'hooks', 'pre-push'), hookText(99));
  init(ordinary); put(path.join(ordinary, '.git', 'hooks', 'pre-push'), hookText(15));
  init(main); run(main, 'worktree', 'add', '-q', '-b', 'b', wt); put(path.join(main, '.git', 'hooks', 'pre-push'), hookText(15));
  init(custom); run(custom, 'config', 'core.hooksPath', '.githooks'); put(path.join(custom, '.githooks', 'pre-push'), hookText(PREPUSH_HOOK_VERSION));
  put(path.join(custom, '.git', 'hooks', 'pre-push'), hookText(1));   // the decoy: NOT the effective hook

  it('reads the version marker', () => { assert.equal(installedHookVersion(hookText(15)), 15); assert.equal(installedHookVersion('no marker'), null); });
  it('an ordinary repo\'s stale hook is named, and the SOURCE repo\'s own v99 hook is never what is read', () => {
    assert.deepEqual(inspectInstalledHook(ordinary), { state: 'stale', installed: 15 });
    const prev = process.cwd(); process.chdir(source);
    try { assert.deepEqual(inspectInstalledHook(ordinary), { state: 'stale', installed: 15 }); } finally { process.chdir(prev); }
  });
  it('a linked worktree resolves to the shared hooks dir, as an absolute path', () => {
    const p = effectiveHookPath(wt);
    assert.ok(path.isAbsolute(p), p);
    assert.deepEqual(inspectInstalledHook(wt), { state: 'stale', installed: 15 });
  });
  it('a relative core.hooksPath resolves to the EFFECTIVE hook, not the decoy under .git/hooks', () => {
    assert.deepEqual(inspectInstalledHook(custom), { state: 'current', installed: PREPUSH_HOOK_VERSION });
  });
  it('absent, unmanaged and unresolvable are each said, never silence', () => {
    const bare = path.join(tmp, 'bare'); init(bare);
    assert.deepEqual(inspectInstalledHook(bare), { state: 'absent' });
    const foreign = path.join(tmp, 'foreign'); init(foreign); put(path.join(foreign, '.git', 'hooks', 'pre-push'), '#!/bin/sh\necho mine\n');
    assert.equal(inspectInstalledHook(foreign).state, 'not-inspected');
    assert.match(inspectInstalledHook(foreign).why, /not managed/);
    assert.equal(inspectInstalledHook(path.join(tmp, 'nope')).state, 'not-inspected');
  });
  it('the epilogue lines name the exact command per stale consumer and skip current and missing paths', () => {
    const lines = hookEpilogueLines([
      { name: 'ordinary', alias: 'ord', path: ordinary },
      { name: 'custom', alias: 'cus', path: custom },
      { name: 'gone', alias: 'g', path: path.join(tmp, 'does-not-exist') },
    ]);
    assert.deepEqual(lines, [`ordinary: pre-push hook v15 installed, the bundle is v${PREPUSH_HOOK_VERSION} - npm run hooks:install -- --target ord`]);
  });
  it('cleanup', () => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
});
