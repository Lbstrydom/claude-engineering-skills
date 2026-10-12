/**
 * @fileoverview Stale hydrated tooling warning (docs/plans/fleet-unclaimed-work-and-switch-friction.md §2.4 c).
 * Every "says nothing" case has a control that warns.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots, makeFleetRepo, scrubbedEnv, tmpRoot } from './helpers/fleet-repo.mjs';
import { HYDRATE_HINT, staleBundleWarning } from '../scripts/lib/fleet/bundle-stamp.mjs';

after(cleanupFleetRoots);

const stamp = (root, commitSha, generatedAt) => {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', '.sync-manifest.json'), JSON.stringify({ commitSha, generatedAt }));
};

function setup() {
  const fx = makeFleetRepo();
  const wt = path.join(tmpRoot('stamp-wt-'), 'linked');
  git(['worktree', 'add', '-q', '-b', 'linked', wt, 'main'], fx.repo);
  const syncedIn = (root) => path.join(root, 'scripts', '.claude-skills');
  return { fx, wt, syncedIn };
}

describe('staleBundleWarning', () => {
  it('a linked worktree whose stamp is OLDER than the main checkout\'s warns, naming the remedy', () => {
    const { fx, wt, syncedIn } = setup();
    stamp(fx.repo, 'b'.repeat(40), '2026-10-11T12:00:00Z');
    stamp(wt, 'a'.repeat(40), '2026-10-01T12:00:00Z');
    const w = staleBundleWarning({ scriptDir: syncedIn(wt) });
    assert.match(w, /older than the main checkout's/);
    assert.ok(w.includes(HYDRATE_HINT));
  });
  it('a linked worktree with NO stamp warns', () => {
    const { fx, wt, syncedIn } = setup();
    stamp(fx.repo, 'b'.repeat(40), '2026-10-11T12:00:00Z');
    assert.match(staleBundleWarning({ scriptDir: syncedIn(wt) }), /no bundle stamp \(missing\)/);
  });
  it('controls: the same stamp, a newer stamp, the main checkout itself, and the source repo layout say nothing', () => {
    const { fx, wt, syncedIn } = setup();
    stamp(fx.repo, 'b'.repeat(40), '2026-10-11T12:00:00Z');
    stamp(wt, 'b'.repeat(40), '2026-10-11T12:00:00Z');
    assert.equal(staleBundleWarning({ scriptDir: syncedIn(wt) }), null, 'same commit');
    stamp(wt, 'c'.repeat(40), '2026-10-12T12:00:00Z');
    assert.equal(staleBundleWarning({ scriptDir: syncedIn(wt) }), null, 'newer here');
    assert.equal(staleBundleWarning({ scriptDir: syncedIn(fx.repo) }), null, 'the main checkout is the reference');
    assert.equal(staleBundleWarning({ scriptDir: path.join(wt, 'scripts'), cwd: wt }), null, 'tracked scripts/ (the source repo) is never checked');
  });
  it('identity is the EXECUTING copy, not the working directory: run from the main checkout, the stale copy still warns', () => {
    const { fx, wt, syncedIn } = setup();
    stamp(fx.repo, 'b'.repeat(40), '2026-10-11T12:00:00Z');
    stamp(wt, 'a'.repeat(40), '2026-10-01T12:00:00Z');
    assert.match(staleBundleWarning({ scriptDir: syncedIn(wt) }) ?? '', /older than the main checkout's/);
    assert.equal(staleBundleWarning({ scriptDir: syncedIn(fx.repo) }), null, "control: the main checkout's own copy");
  });
});

describe('the CLI boundary (a real fleet.mjs run from a synced copy)', () => {
  // The real scripts/ tree, reached as <worktree>/scripts/.claude-skills through a junction, run with symlinks preserved
  // so the CLI sees the consumer layout. node_modules is junctioned beside it so its imports resolve.
  const SCRIPTS = fileURLToPath(new URL('../scripts', import.meta.url));
  let nodeModules = path.dirname(createRequire(import.meta.url).resolve('zod'));
  while (path.basename(nodeModules) !== 'node_modules') nodeModules = path.dirname(nodeModules);
  const runCopy = (wt, args) => spawnSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main',
    path.join(wt, 'scripts', '.claude-skills', 'fleet.mjs'), ...args], { cwd: wt, encoding: 'utf8', env: scrubbedEnv({ FLEET_TELEMETRY: 'off' }) });
  const consumer = () => {
    const { fx, wt } = setup();
    fs.mkdirSync(path.join(wt, 'scripts'), { recursive: true });
    fs.symlinkSync(SCRIPTS, path.join(wt, 'scripts', '.claude-skills'), 'junction');
    fs.symlinkSync(nodeModules, path.join(wt, 'node_modules'), 'junction');
    return { fx, wt };
  };

  it('an older stamp: the warning is on stderr (one line), stdout is exactly one JSON value; an equal stamp says nothing (control)', () => {
    const { fx, wt } = consumer();
    stamp(fx.repo, 'b'.repeat(40), '2026-10-11T12:00:00Z');
    stamp(wt, 'a'.repeat(40), '2026-10-01T12:00:00Z');
    const r = runCopy(wt, ['status', '--json']);
    assert.match(r.stderr, /^fleet: this worktree's synced tooling \(aaaaaaaaaaaa\) is older than the main checkout's \(bbbbbbbbbbbb\) — run npm run skills:hydrate\n/);
    assert.equal(JSON.parse(r.stdout).verb, 'status', 'stdout parses as one JSON value');
    assert.equal(r.status, 0, r.stderr);
    stamp(wt, 'b'.repeat(40), '2026-10-11T12:00:00Z');
    const same = runCopy(wt, ['status', '--json']);
    assert.doesNotMatch(same.stderr, /synced tooling/);
    assert.equal(same.status, 0, same.stderr);
  });
  it('an unknown verb from a stale copy names the remedy; from a fresh copy it does not (control)', () => {
    const { fx, wt } = consumer();
    stamp(fx.repo, 'b'.repeat(40), '2026-10-11T12:00:00Z');
    stamp(wt, 'a'.repeat(40), '2026-10-01T12:00:00Z');
    const r = runCopy(wt, ['no-such-verb']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown verb "no-such-verb" — this worktree's tooling may be stale; run npm run skills:hydrate/);
    stamp(wt, 'b'.repeat(40), '2026-10-11T12:00:00Z');
    assert.doesNotMatch(runCopy(wt, ['no-such-verb']).stderr, /may be stale/);
  });
});
