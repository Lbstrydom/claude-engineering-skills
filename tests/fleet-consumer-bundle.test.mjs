/**
 * @fileoverview consumerBundleState (docs/plans/fleet-handover-winddown.md §2.8, proposal 7970): the sync's own dry run is the
 * oracle, read through its one summary line. That line is a prose contract between a CLI and this reader, so the fixtures
 * below are the tool's REAL output (captured 2026-10-21 from `sync-to-repos --dry-run --target wine`), colours included, and an
 * unmatched line is `unknown`, never `current`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { consumerBundleState, parseSyncDryRun, syncCommands } from '../scripts/lib/fleet/consumer-bundle.mjs';

const E = '\u001b';
const tail = (summary) => [
  `  ${E}[32m+1 new${E}[0m  ${E}[33m~7 updated${E}[0m  ${E}[2m960 unchanged${E}[0m  ${E}[2m855 remapped${E}[0m  ${E}[2m2 held${E}[0m`,
  `  ${E}[2m✓ package.json declares all 13 required bundle packages${E}[0m`,
  '', '────────────────────────────────────────',
  `${E}[33mDRY RUN complete${E}[0m — no files written`,
  summary, '', 'Run without --dry-run to apply.',
].join('\n');

describe('parseSyncDryRun — the summary line of the real tool', () => {
  it('changes pending is behind, with the counts; none pending is current (control)', () => {
    assert.deepEqual(parseSyncDryRun(tail('  Would create: 1  update: 7  unchanged: 960')), { state: 'behind', create: 1, update: 7 });
    assert.deepEqual(parseSyncDryRun(tail('  Would create: 0  update: 0  unchanged: 968')), { state: 'current', create: 0, update: 0 });
    assert.equal(parseSyncDryRun(tail('  Would create: 0  update: 2  unchanged: 966')).state, 'behind', 'updates alone are behind');
  });
  it('a run the real sync would refuse, or one that printed no summary, is unknown — never current', () => {
    const abort = `  ${E}[31mwould ABORT${E}[0m  2 unowned collision(s); will not overwrite.\n${tail('  Would create: 0  update: 0  unchanged: 968')}`;
    assert.equal(parseSyncDryRun(abort).state, 'unknown');
    assert.match(parseSyncDryRun(abort).reason, /ABORT/);
    for (const junk of ['', 'DRY RUN complete — no files written', tail('  Would create: some  update: few')]) assert.equal(parseSyncDryRun(junk).state, 'unknown', JSON.stringify(junk.slice(0, 40)));
    assert.equal(parseSyncDryRun(undefined).state, 'unknown');
  });
});

describe('the producer-consumer contract: the REAL sync dry run (M8)', () => {
  // Captured strings cannot notice the producer's wording change; this runs the actual tool against a throwaway consumer
  // (`--target-path`, which writes nothing in --dry-run) and reads what it really printed.
  const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const real = (dir) => (args, cwd) => spawnSync(process.execPath, args.map((a, i) => (args[i - 1] === '--target' ? dir : a === '--target' ? '--target-path' : a)), { cwd, encoding: 'utf8', timeout: 120_000 });
  it('an empty consumer is behind (the bundle would be created); the state is read from the tool\'s own summary line, not unknown', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-contract-'));
    try {
      const r = consumerBundleState(REPO_ROOT, 'throwaway', { run: real(dir) });
      assert.equal(r.state, 'behind', JSON.stringify(r));
      assert.ok(r.create > 0 && r.update === 0, JSON.stringify(r));
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
  it('the dry run wrote nothing in the throwaway consumer (control: the oracle is read-only)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-contract-ro-'));
    try {
      consumerBundleState(REPO_ROOT, 'throwaway', { run: real(dir) });
      assert.deepEqual(fs.readdirSync(dir), []);
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

describe('consumerBundleState — asks the sync, from the source MAIN checkout', () => {
  it('runs the dry run for the target in the given directory and reports what it printed', () => {
    const seen = [];
    const run = (args, cwd) => { seen.push({ args, cwd }); return { status: 0, stdout: tail('  Would create: 0  update: 3  unchanged: 9'), stderr: '' }; };
    assert.deepEqual(consumerBundleState('/src/main', 'wine-cellar-app', { run }), { state: 'behind', create: 0, update: 3 });
    assert.deepEqual(seen, [{ args: ['scripts/sync-to-repos.mjs', '--dry-run', '--no-prompt', '--target', 'wine-cellar-app'], cwd: '/src/main' }]);
  });
  it('M3: each probe gets only what is left of the winddown budget, and a spent budget is unknown rather than skipped', () => {
    const seen = [];
    const run = (args, cwd, timeout) => { seen.push(timeout); return { status: 0, stdout: tail('  Would create: 0  update: 0  unchanged: 9'), stderr: '' }; };
    consumerBundleState('/s', 'a', { run, timeoutMs: 30_000 });
    consumerBundleState('/s', 'b', { run, timeoutMs: 500_000 });
    assert.deepEqual(seen, [30_000, 120_000], 'capped by the remaining budget, never above one probe\'s own limit');
    const spent = consumerBundleState('/s', 'c', { run, timeoutMs: 0 });
    assert.deepEqual([spent.state, /budget was spent/.test(spent.reason), seen.length], ['unknown', true, 2], 'no probe started once the budget was gone');
  });
  it('a failed or unrunnable dry run is unknown with the reason', () => {
    assert.equal(consumerBundleState('/s', 'x', { run: () => ({ status: 1, stdout: '', stderr: 'boom' }) }).state, 'unknown');
    const err = consumerBundleState('/s', 'x', { run: () => ({ status: null, error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) }) });
    assert.deepEqual([err.state, /ETIMEDOUT/.test(err.reason)], ['unknown', true]);
  });
  it('the commands that bring a consumer current are run from the main checkout and never merge', () => {
    assert.deepEqual(syncCommands('wine-cellar-app'), ['node scripts/sync-to-repos.mjs --target wine-cellar-app', 'node scripts/sync-pr.mjs --target wine-cellar-app --no-merge']);
  });
});
