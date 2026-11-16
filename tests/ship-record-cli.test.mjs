/**
 * @fileoverview The ship record catch-up verbs over a real temp git repo and a fake gh
 * (scripts/lib/ship-record/commands.mjs, facts.mjs). Plan: docs/plans/ship-record-catchup.md §2.1a, §2.2, §2.5, §9.
 *
 * The idempotency oracle: a second `catchup --write` writes 0 files and emits 0 events. Plus: the listing bisects past
 * one window; a gh failure is unmeasured; events reconcile on the next run after a lost write; two floors stop.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { listMergedSince, inBandRecorded, githubSlugFromRemote, resolveBase } from '../scripts/lib/ship-record/facts.mjs';
import { runStatus, runCatchup, runFloor, runInit, RecordRefusal, reconcileEvents } from '../scripts/lib/ship-record/commands.mjs';
import { renderInitReadme } from '../scripts/lib/ship-record/entry.mjs';
import { renderFloorMarker } from '../scripts/lib/ship-record/state.mjs';

const gitIn = (dir) => (args) => {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ?? null };
};
const must = (g, args) => { const r = g(args); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };

/** A repo whose origin/main holds: the marker, a floor (covering #1), then squash commits for #2 (with its own entry), #3, #4. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-record-cli-'));
  const g = gitIn(dir);
  must(g, ['init', '-q', '-b', 'main']);
  must(g, ['remote', 'add', 'origin', 'https://github.com/o/r.git']);
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const commit = (msg) => { must(g, ['add', '-A']); must(g, ['commit', '-q', '-m', msg]); return must(g, ['rev-parse', 'HEAD']); };
  write('docs/status/entries/README.md', renderInitReadme());
  write('docs/plans/p.md', '# Plan\n\n## Implementation Log\n');
  write('docs/status/entries/2026-11-10-000000-record-floor.md', `## 2026-11-10 — Record floor\n${renderFloorMarker({ mergedThrough: '2026-11-10T00:00:00Z', covered: [1] })}\n`);
  const s1 = commit('chore: floor (#1)');
  write('docs/status/entries/2026-11-11-000000-own-entry.md', '## 2026-11-11 — shipped\n');
  write('scripts/two.mjs', 'x');
  const s2 = commit('feat: two (#2)');
  write('scripts/three.mjs', 'x');
  write('docs/plans/p.md', '# Plan\n\n## Implementation Log\n- edited\n');
  const s3 = commit('feat: three (#3)\n\nAI-Gate: converged');
  write('scripts/four.mjs', 'x');
  const s4 = commit('fix: four (#4)');
  must(g, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  const prs = [
    { number: 1, mergedAt: '2026-11-09T12:00:00Z', mergeCommit: { oid: s1 }, headRefName: 'b1', url: 'https://github.com/o/r/pull/1' },
    { number: 2, mergedAt: '2026-11-11T01:00:00Z', mergeCommit: { oid: s2 }, headRefName: 'b2', url: 'https://github.com/o/r/pull/2' },
    { number: 3, mergedAt: '2026-11-11T02:00:00Z', mergeCommit: { oid: s3 }, headRefName: 'b3', url: 'https://github.com/o/r/pull/3' },
    { number: 4, mergedAt: '2026-11-12T03:00:00Z', mergeCommit: { oid: s4 }, headRefName: 'b4', url: 'https://github.com/o/r/pull/4' },
  ];
  return { dir, g, prs, shas: { s1, s2, s3, s4 } };
}

/** A fake gh answering `pr list --search merged:A..B` from a PR set. */
function fakeGh(prs, { fail = false, calls = [] } = {}) {
  return (args) => {
    calls.push(args);
    if (fail) return { status: 1, stdout: '', stderr: 'HTTP 401: Bad credentials', error: null };
    const q = args[args.indexOf('--search') + 1];
    const [, from, to] = /^merged:(\S+)\.\.(\S+)$/.exec(q);
    const limit = Number(args[args.indexOf('--limit') + 1]);
    const hit = prs.filter((p) => { const d = p.mergedAt.slice(0, 10); return d >= from && d <= to; }).slice(0, limit);
    return { status: 0, stdout: JSON.stringify(hit), stderr: '', error: null };
  };
}

const NOW = new Date('2026-11-13T00:00:00Z');
const ctxFor = (fx, extra = {}) => ({
  cwd: fx.dir, repoRoot: fx.dir, runners: { git: fx.g, gh: fakeGh(fx.prs, extra.gh ?? {}) }, now: () => NOW, cmd: 'node scripts/ship-record.mjs',
  backlog: () => 'Backlog 2026-11-13T00:00Z: Q1 unmeasured', events: extra.events ?? null,
});

describe('facts', () => {
  it('parses GitHub remotes and resolves the base triple', () => {
    assert.equal(githubSlugFromRemote('git@github.com:o/r.git'), 'o/r');
    assert.equal(githubSlugFromRemote('https://gitlab.com/o/r'), null);
    const fx = fixture();
    const b = resolveBase({ git: fx.g });
    assert.deepEqual([b.branch, b.ref, b.repo], ['main', 'refs/remotes/origin/main', 'o/r']);
    assert.match(resolveBase({ git: fx.g }, { branch: 'develop' }).reason, /git fetch origin develop/);
  });
  it('in-band = this merge ADDED an entry; a modification is not', () => {
    const fx = fixture();
    assert.equal(inBandRecorded({ git: fx.g }, fx.shas.s2), true);
    assert.equal(inBandRecorded({ git: fx.g }, fx.shas.s3), false);
    assert.equal(inBandRecorded({ git: fx.g }, 'f'.repeat(40)), null);
  });
  it('bisects past one window and stays complete; a single-day overflow is partial', () => {
    const prs = Array.from({ length: 1200 }, (_, i) => ({ number: i + 1, mergedAt: new Date(Date.UTC(2026, 9, 1) + Math.floor(i / 40) * 86_400_000).toISOString(), mergeCommit: { oid: 'a'.repeat(40) }, headRefName: 'b', url: '' }));
    const r = listMergedSince({ gh: fakeGh(prs) }, { repo: 'o/r', branch: 'main', fromIso: '2026-10-01T00:00:00Z', toIso: '2026-10-30T23:00:00Z', limit: 500 });
    assert.equal(r.ok, true);
    assert.equal(r.complete, true);
    assert.equal(r.prs.length, 1200);
    const crowded = listMergedSince({ gh: fakeGh(prs) }, { repo: 'o/r', branch: 'main', fromIso: '2026-10-01T00:00:00Z', toIso: '2026-10-01T00:00:00Z', limit: 40 });
    assert.equal(crowded.complete, false);
    assert.match(crowded.partialReason, /2026-10-01/);
  });
});

describe('verbs', () => {
  it('status classifies: #2 in-band, #3 and #4 unrecorded, #1 covered by the floor', () => {
    const env = runStatus(ctxFor(fixture()));
    assert.equal(env.state, 'measured');
    assert.deepEqual(env.counts, { merged: 3, recorded: 1, unrecorded: 2, unknown: 0, withTrailers: null });
    assert.deepEqual(env.unrecorded.map((p) => p.number), [3, 4]);
    assert.equal(env.remedy, 'node scripts/ship-record.mjs catchup --write');
  });
  it('a gh failure is UNMEASURED, never 0', () => {
    const env = runStatus(ctxFor(fixture(), { gh: { fail: true } }));
    assert.equal(env.state, 'unmeasured');
    assert.equal(env.counts.unrecorded, null);
    assert.match(env.reason, /Bad credentials|authent|401/i);
  });
  it('catchup dry run writes nothing; --write writes per-PR + run entries; a rerun is a no-op', async () => {
    const fx = fixture();
    const dry = await runCatchup(ctxFor(fx), {});
    assert.equal(dry.wrote.length, 0);
    assert.equal(dry.wouldWrite.length, 2);
    const first = await runCatchup(ctxFor(fx), { write: true, events: false });
    assert.deepEqual(first.wrote.filter((p) => /-pr-\d+\.md$/.test(p)).map((p) => path.basename(p)), ['2026-11-11-020000-pr-3.md', '2026-11-12-030000-pr-4.md']);
    assert.ok(first.wrote.some((p) => p.endsWith('-record-catchup.md')));
    assert.deepEqual(first.suggestions.map((s) => [s.plan, s.pr]), [['docs/plans/p.md', 3]]);
    const second = await runCatchup(ctxFor(fx), { write: true, events: false });
    assert.equal(second.wrote.length, 0, 'the idempotency oracle: a rerun writes nothing');
    const pr3 = fs.readFileSync(path.join(fx.dir, 'docs/status/entries/2026-11-11-020000-pr-3.md'), 'utf8');
    assert.match(pr3, /^## 2026-11-11 — #3 feat: three\n<!-- ship-record v1 pr=3 merge=/);
    assert.match(pr3, /`AI-Gate: converged`/);
  });
  it('a recorded entry on the base tree counts as recorded next time (marker evidence)', async () => {
    const fx = fixture();
    await runCatchup(ctxFor(fx), { write: true, events: false });
    must(fx.g, ['add', '-A']); must(fx.g, ['commit', '-q', '-m', 'docs: record (#5)']); must(fx.g, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const env = runStatus(ctxFor(fx));
    assert.deepEqual([env.counts.recorded, env.counts.unrecorded], [3, 0]);
    assert.equal(env.remedy, null);
  });
  it('two floors on the base tree: every verb refuses', async () => {
    const fx = fixture();
    fs.writeFileSync(path.join(fx.dir, 'docs/status/entries/2026-11-12-000000-record-floor.md'), renderFloorMarker({ mergedThrough: '2026-11-12T00:00:00Z', covered: [2] }));
    must(fx.g, ['add', '-A']); must(fx.g, ['commit', '-q', '-m', 'x']); must(fx.g, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    assert.equal(runStatus(ctxFor(fx)).state, 'ambiguous-floor');
    await assert.rejects(runCatchup(ctxFor(fx), { write: true }), RecordRefusal);
    assert.throws(() => runFloor(ctxFor(fx), { write: true }), /already exists/);
  });
  it('init then floor in a repo without the marker', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-record-init-'));
    const g = gitIn(dir);
    must(g, ['init', '-q', '-b', 'main']); must(g, ['remote', 'add', 'origin', 'https://github.com/o/r.git']);
    fs.writeFileSync(path.join(dir, 'status.md'), '# Project Status Log\n\n## 2026-11-01 — old work\n');
    must(g, ['add', '-A']); must(g, ['commit', '-q', '-m', 'init']); must(g, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const ctx = { ...ctxFor({ dir, g, prs: [] }) };
    assert.equal(runStatus(ctx).state, 'no-marker');
    assert.equal(runStatus(ctx).remedy, 'node scripts/ship-record.mjs init');
    runInit(ctx);
    assert.throws(() => runInit(ctx), /already exists/);
    const f = runFloor(ctx, { write: true });
    assert.equal(f.wrote.length, 1);
    assert.match(fs.readFileSync(path.join(dir, f.wrote[0]), 'utf8'), /last log entry before this floor: status\.md: 2026-11-01/);
  });
  it('a floor refuses an incomplete listing', () => {
    const fx = fixture();
    fs.rmSync(path.join(fx.dir, 'docs/status/entries/2026-11-10-000000-record-floor.md'));
    must(fx.g, ['add', '-A']); must(fx.g, ['commit', '-q', '-m', 'x']); must(fx.g, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    assert.throws(() => runFloor(ctxFor(fx, { gh: { fail: true } }), { write: true }), /not authenticated|Bad credentials|401/);
  });
});

describe('event reconciliation', () => {
  const port = (store, { failWrites = 0 } = {}) => {
    let fails = failWrites;
    return {
      resolveRepoId: async () => ({ ok: true, repoId: null }),
      find: async (_r, shas) => ({ ok: true, cloud: true, present: new Set(shas.filter((s) => store.has(s))) }),
      record: async (_r, e) => { if (fails > 0) { fails--; return { ok: false, cloud: true, reason: 'write-failed' }; } store.add(e.commitSha); return { ok: true, cloud: true }; },
    };
  };
  it('a lost write is retried by the next run; then everything is existing', async () => {
    const fx = fixture();
    const store = new Set();
    const NOWX = { ...ctxFor(fx), now: () => new Date('2026-11-13T00:00:00Z') };
    const a = await runCatchup({ ...NOWX, events: port(store, { failWrites: 1 }) }, { write: true });
    assert.equal(a.events.lost, 1);
    assert.equal(a.ok, false, 'a lost event write exits non-zero');
    const b = await runCatchup({ ...NOWX, events: port(store) }, { write: true });
    assert.equal(b.wrote.length, 0);
    assert.deepEqual([b.events.written, b.events.existing, b.events.lost], [1, 1, 0]);
    const c = await runCatchup({ ...NOWX, events: port(store) }, { write: true });
    assert.deepEqual([c.events.written, c.events.existing], [0, 2], 'the second rerun emits 0 events');
  });
  it('a failed existence read loses the batch loudly, never re-inserts it', async () => {
    const st = { prs: [{ number: 9, status: 'recorded', by: 'marker', mergeCommit: 'c'.repeat(40), mergedAt: '2026-11-12T00:00:00Z' }] };
    const ev = await reconcileEvents({ now: () => NOW, events: { resolveRepoId: async () => ({ ok: true, repoId: null }), find: async () => ({ ok: false, cloud: true, reason: 'schema-fault' }), record: async () => assert.fail('must not write') } }, st, []);
    assert.deepEqual([ev.lost, ev.written], [1, 0]);
  });
});
