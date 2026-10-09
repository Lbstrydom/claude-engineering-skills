/**
 * @fileoverview /fleet — items 2-4 of the storyline feedback.
 * Plan: docs/plans/fleet-storyline-feedback.md §2.2-§2.4.
 *   2. stale untracked items are hidden by default on sufficient evidence only
 *   3. an optional `note` on tiers and checks, printed and recorded
 *   4. `changedFiles` is three-dot (since the merge-base) — pinned
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { git } from './helpers/git.mjs';
import { isStaleUntracked, splitHidden } from '../scripts/lib/fleet/overlap.mjs';
import { probeWorktreeCleanliness, CLEAN_PROBE } from '../scripts/lib/fleet/facts.mjs';
import { parseFleetConfig } from '../scripts/lib/fleet/config.mjs';
import { NOTE_MAX } from '../scripts/lib/fleet/contracts.mjs';
import { renderDryRun, renderBuilt } from '../scripts/lib/fleet/render-train.mjs';
import { renderStatus } from '../scripts/lib/fleet/render.mjs';
import { runChecks } from '../scripts/lib/fleet/checks.mjs';
import { changedFiles } from '../scripts/lib/fleet/git-facts.mjs';
import { makeFleetRepo, commitFile, cleanupFleetRoots } from './helpers/fleet-repo.mjs';

after(cleanupFleetRoots);

// ── 2. hiding ────────────────────────────────────────────────────────────────
const item = (over = {}) => ({
  id: 'old', tracked: false, kind: 'branch', ahead: 0, pr: null, worktree: null, worktreeClean: null,
  state: 'untracked', display: 'untracked', branch: 'old', waitingOn: [], overlaps: [], duplicates: [], findings: [], notes: [], ...over,
});

describe('isStaleUntracked — every unknown keeps the item visible', () => {
  const yes = { prsComplete: true };
  it('ahead 0, no PR, no worktree, complete PR lookup => stale', () => assert.equal(isStaleUntracked(item(), yes), true));
  it('table of everything that must NOT be hidden', () => {
    const cases = {
      'ahead>0': item({ ahead: 2 }),
      'ahead unknown': item({ ahead: null }),
      'has an open PR': item({ pr: { number: 1 } }),
      'tracked session': item({ tracked: true }),
      'detached worktree': item({ kind: 'worktree' }),
      'remote-only PR': item({ kind: 'remote-only' }),
      'dirty worktree': item({ worktree: '/w', worktreeClean: false }),
      'worktree cleanliness unknown': item({ worktree: '/w', worktreeClean: null }),
    };
    for (const [why, it] of Object.entries(cases)) assert.equal(isStaleUntracked(it, yes), false, why);
    assert.equal(isStaleUntracked(item(), { prsComplete: false }), false, 'PR lookup incomplete/unqueried');
  });
  it('a clean attached worktree is stale', () => assert.equal(isStaleUntracked(item({ worktree: '/w', worktreeClean: true }), yes), true));
});

describe('splitHidden — presentation boundary over a COMPLETE status', () => {
  const status = (items, prsComplete = true) => ({ sources: { prs: { complete: prsComplete } }, items });
  it('default hides stale, --all shows everything, registered sessions are never hidden', () => {
    const items = [item({ id: 'old1' }), item({ id: 'old2' }), item({ id: 'live', ahead: 3 }), item({ id: 'sess', tracked: true, ahead: 0 })];
    const s = status(items);
    const v = splitHidden(s);
    assert.deepEqual(v.items.map((i) => i.id), ['live', 'sess']);
    assert.deepEqual(v.hidden, { count: 2, ids: ['old1', 'old2'], unchecked: 0, merged: 2, landed: 0, idle: 0, idleDays: 14 });
    assert.equal(splitHidden(s, { all: true }).items.length, 4);
    assert.equal(s.items.length, 4, 'the input status is never mutated');
  });
  it('PR list incomplete => nothing hidden', () => {
    assert.equal(splitHidden(status([item()], false)).hidden.count, 0);
  });
  it('an ahead-0 worktree of unknown cleanliness stays visible and is counted', () => {
    const v = splitHidden(status([item({ worktree: '/w', worktreeClean: null })]));
    assert.deepEqual([v.items.length, v.hidden.count, v.hidden.unchecked], [1, 0, 1]);
  });
  it('render: a hidden line names the flag; nothing hidden prints nothing', () => {
    const base = {
      registry: { complete: true, invalid: [] }, base: { name: 'main', freshness: null }, observedAt: 't', hold: null,
      sources: { worktrees: { queried: true }, branches: { queried: true }, prs: { queried: true, complete: true } },
      items: [], landingOrder: [], cycles: [], trains: [],
    };
    assert.match(renderStatus(base, { hidden: { count: 3, ids: [], unchecked: 0 } }), /3 hidden \(stale \/ merged\) — use --all/);
    assert.doesNotMatch(renderStatus(base, { hidden: { count: 0, ids: [], unchecked: 0 } }), /hidden/);
    assert.match(renderStatus(base, { hidden: { count: 0, ids: [], unchecked: 2 } }), /2 merged- or idle-looking worktrees shown: cleanliness unchecked/);
  });
});

describe('probeWorktreeCleanliness — bounded', () => {
  const branches = (n) => ({ queried: true, branches: Array.from({ length: n }, (_, i) => ({ name: `b${i}`, ahead: 0 })) });
  const wts = (n) => ({ queried: true, worktrees: Array.from({ length: n }, (_, i) => ({ path: `/w${i}`, branch: `b${i}` })) });
  const args = (n, extra = {}) => ({ branches: branches(n), worktreeList: wts(n), registry: { sessions: [] }, base: 'main', ...extra });

  it('clean / dirty / failed probes map to true / false / null', () => {
    const out = probeWorktreeCleanliness(args(3, { probe: (p) => (p === '/w0' ? { ok: true, stdout: '' } : p === '/w1' ? { ok: true, stdout: ' M x\n' } : { ok: false, stdout: '' }) }));
    assert.deepEqual(out, { '/w0': true, '/w1': false, '/w2': null });
  });
  it('over the candidate cap the remainder is unknown, never probed', () => {
    let calls = 0;
    const out = probeWorktreeCleanliness(args(CLEAN_PROBE.maxCandidates + 5, { probe: () => { calls += 1; return { ok: true, stdout: '' }; } }));
    assert.equal(calls, CLEAN_PROBE.maxCandidates);
    assert.equal(Object.values(out).filter((v) => v === null).length, 5);
  });
  it('past the aggregate deadline the remainder is unknown', () => {
    let t = 0; let calls = 0;
    const out = probeWorktreeCleanliness(args(5, {
      clock: () => t,
      probe: () => { calls += 1; t += CLEAN_PROBE.deadlineMs; return { ok: true, stdout: '' }; },
    }));
    assert.equal(calls, 2, 'one probe at t=0, one at t=deadline (not past it), then stop');
    assert.deepEqual(Object.values(out), [true, true, null, null, null]);
  });
  it('registered branches and non-ahead-0 branches are never candidates; unqueried inputs probe nothing', () => {
    const b = { queried: true, branches: [{ name: 'main', ahead: 0 }, { name: 'sess', ahead: 0 }, { name: 'busy', ahead: 4 }] };
    const w = { queried: true, worktrees: [{ path: '/s', branch: 'sess' }, { path: '/b', branch: 'busy' }] };
    let calls = 0;
    const probe = () => { calls += 1; return { ok: true, stdout: '' }; };
    assert.deepEqual(probeWorktreeCleanliness({ branches: b, worktreeList: w, registry: { sessions: [{ source: { branch: 'sess' } }] }, base: 'main', probe }), {});
    assert.deepEqual(probeWorktreeCleanliness({ branches: { queried: false }, worktreeList: w, registry: {}, base: 'main', probe }), {});
    assert.equal(calls, 0);
  });
});

// ── 3. note ─────────────────────────────────────────────────────────────────
describe('note on tiers and checks', () => {
  const tier = (note) => ({ name: 'packaged', command: ['npm', 'run', 'pack'], stage: 'post-merge', ...(note === undefined ? {} : { note }) });
  const cfg = (note, where = 'tier') => parseFleetConfig(where === 'tier'
    ? { testCommand: { tiers: [{ name: 'unit', command: ['npm', 'test'] }, tier(note)] } }
    : { checks: [{ name: 'c', script: 'scripts/c.mjs', ...(note === undefined ? {} : { note }) }] });

  it('accepted up to the cap on both a tier and a check, absent by default', () => {
    for (const where of ['tier', 'check']) {
      assert.equal(cfg('x'.repeat(NOTE_MAX), where).ok, true, where);
      assert.equal(cfg(undefined, where).ok, true, where);
    }
    assert.equal(cfg('runs on main only because it needs the signing key').value.testCommand[1].note, 'runs on main only because it needs the signing key');
  });
  it('rejected: too long, blank, multi-line, control chars', () => {
    for (const where of ['tier', 'check']) {
      for (const bad of ['x'.repeat(NOTE_MAX + 1), '   ', 'line1\nline2', 'tab\there', 'esc\u001b[31m', '\nreview\n', '\treview']) {
        const r = cfg(bad, where);
        assert.equal(r.ok, false, `${where}: ${JSON.stringify(bad).slice(0, 30)}`);
      }
    }
  });
  it('strictness is intact: an unknown sibling key is still refused', () => {
    assert.equal(parseFleetConfig({ testCommand: { tiers: [{ name: 'u', command: ['npm', 'test'], notes: 'typo' }] } }).ok, false);
  });
  it('printed beside the deferred tier (dry-run and the built-train block), only when set', () => {
    const plan = { baseOid: 'a'.repeat(40), destination: { remote: 'origin', ref: 'refs/heads/main' }, mergeMethod: 'pr', sources: [], testCommand: [{ name: 'unit', stage: 'pre-land', command: ['x'] }, tier('main-only: needs the packaging runner')], deferredTiers: [tier('main-only: needs the packaging runner')] };
    const text = renderDryRun({ plan });
    assert.match(text, /`packaged` tier will run on `main` after landing[^\n]*\n    note: main-only: needs the packaging runner/);
    const none = renderDryRun({ plan: { ...plan, deferredTiers: [tier()] } });
    assert.doesNotMatch(none, /note:/);
    const built = renderBuilt({
      train: { trainId: 't', phase: 'tested', result: 'green', mergeMethod: 'pr', baseOid: 'a'.repeat(40), destination: { remote: 'origin', ref: 'refs/heads/main' }, sources: [], deferredTiers: [tier('why')], tierResults: [{ name: 'unit', result: 'green', note: 'unit note' }], checkResults: [{ name: 'c', severity: 'warn', status: 'ok', note: 'check note', findings: [] }] },
      approvability: { ok: true, reason: 'green' }, cmd: 'fleet',
    });
    assert.match(built, /tier unit: green[^\n]*\n    note: unit note/);
    assert.match(built, /check c \[warn\]: ok\n    note: check note/);
    assert.match(built, /note: why/);
  });
  it('recorded in the check result that lands in the manifest', () => {
    const results = runChecks({
      cwd: process.cwd(), phase: 'land', payload: {},
      checks: [{ name: 'c', script: 'does/not/exist.mjs', severity: 'warn', note: 'why this check exists', runIn: ['land'] }],
    });
    assert.equal(results[0].note, 'why this check exists');
    assert.equal(results[0].status, 'check-failed', 'a missing script still reports, with the note attached');
  });
});

// ── 4. three-dot pin ────────────────────────────────────────────────────────
describe('changedFiles is three-dot (merge-base...branch)', () => {
  it('a base that moved on does not make the branch look like it changed those files', () => {
    const { repo } = makeFleetRepo();
    git(['checkout', '-q', '-b', 'feature'], repo);
    commitFile(repo, 'feature-only.txt', 'f\n');
    git(['checkout', '-q', 'main'], repo);
    commitFile(repo, 'moved-on-in-base.txt', 'm\n'); // base advances AFTER the fork
    const r = changedFiles(repo, 'main', 'feature');
    assert.deepEqual(r.files, ['feature-only.txt']);
    // the two-dot reading is what this guards against: it would add the base-only file
    const twoDot = git(['diff', '--name-only', 'main..feature'], repo).split('\n').filter(Boolean).sort();
    assert.deepEqual(twoDot, ['feature-only.txt', 'moved-on-in-base.txt'], 'the control: two-dot DOES differ, so this test can fail');
  });
  it('the contract is documented where an operator and a future editor will read it', () => {
    for (const f of ['skills/fleet/SKILL.md', 'docs/plans/fleet-multi-session-coordination.md']) {
      assert.match(fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), /three-dot/i, f);
    }
  });
});
