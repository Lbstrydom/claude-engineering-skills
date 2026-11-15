/**
 * @fileoverview The sync's own run artifacts — the committed ownership sidecar (`scripts/.sync-owned.json`) and the receipt
 * (`.sync-receipt.json`) — are sync OUTPUT on every run, never files "we no longer sync". Reported by the wine coordinator
 * (2026-11-15): a dry run advised both as "likely renamed upstream" with their citations counted, and the same session's
 * `sync:pr` then committed fresh copies of both as sync-owned. The GC signal was the wrong one: `patchManifestWithExtraHashes`
 * records both in the manifest after the payload, so the NEXT run's prior manifest held them while its payload destinations did
 * not. Tier 3 (consumer sync contract): the unit test pins the planner; this proves the wiring through two real syncs.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { seedInstalledDeps, runSyncCli, whySyncFailed, git } from './helpers/consumer-fixture.mjs';
import { planGarbageCollection, SYNC_RUN_ARTIFACTS } from '../scripts/lib/sync-gc.mjs';
import { OWNED_SIDECAR_RELATIVE_PATH } from '../scripts/lib/sync-owned-sidecar.mjs';
import { RECEIPT_PATH } from '../scripts/lib/sync-receipt.mjs';
import { MANIFEST_RELATIVE_PATH } from '../scripts/lib/sync-manifest.mjs';

describe('planGarbageCollection never advises the sync\'s own run artifacts as orphans', () => {
  it('both artifacts are skipped; a genuinely retired tracked file is still advised (negative control)', () => {
    assert.deepEqual([...SYNC_RUN_ARTIFACTS].sort(), [RECEIPT_PATH, OWNED_SIDECAR_RELATIVE_PATH].sort());
    const plan = planGarbageCollection({
      priorFiles: { [OWNED_SIDECAR_RELATIVE_PATH]: 'sha256:a', [RECEIPT_PATH]: 'sha256:b', 'docs/retired.md': 'sha256:c' },
      intendedDests: new Set(), toolingDir: 'scripts/.claude-skills', exists: () => true,
    });
    assert.deepEqual(plan.orphanedTracked, ['docs/retired.md']);
    assert.deepEqual(plan.deletions, []);
  });
});

describe('two real syncs: the second does not call the sidecar or the receipt "no longer synced"', { timeout: 600_000 }, () => {
  let tmp;
  let consumer;
  const RETIRED = 'docs/retired-upstream.md';
  const sync = (extra = []) => runSyncCli(['--target-path', consumer, '--no-prompt', ...extra]);

  before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ces-run-artifacts-')));
    consumer = path.join(tmp, 'consumer');
    fs.mkdirSync(consumer, { recursive: true });
    git(['init', '--initial-branch=main'], consumer);
    git(['config', 'user.email', 'test@example.invalid'], consumer);
    git(['config', 'user.name', 'Run Artifacts Test'], consumer);
    fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'run-artifacts-fixture', type: 'module' }, null, 2));
    seedInstalledDeps(consumer);
    fs.writeFileSync(path.join(consumer, '.gitignore'), '');
    git(['add', '-A'], consumer);
    git(['commit', '-m', 'init', '--no-gpg-sign'], consumer);
  });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  it('first sync writes both artifacts and records them in the manifest (the precondition the defect needs)', async () => {
    const r = await sync();
    assert.equal(r.code, 0, whySyncFailed(r));
    const manifest = JSON.parse(fs.readFileSync(path.join(consumer, MANIFEST_RELATIVE_PATH), 'utf-8'));
    for (const rel of SYNC_RUN_ARTIFACTS) {
      assert.ok(fs.existsSync(path.join(consumer, rel)), `${rel} was written`);
      assert.ok(manifest.files[rel], `${rel} is in the manifest — what makes the next run's gc see it at all`);
    }
    // Positive control: a tracked file the PREVIOUS sync owned and upstream no longer ships. The next run must advise it, or the
    // "not advised" assertions below could pass merely because the advisory never ran.
    fs.mkdirSync(path.join(consumer, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(consumer, RETIRED), 'retired upstream\n');
    manifest.files[RETIRED] = 'sha256:0000';
    fs.writeFileSync(path.join(consumer, MANIFEST_RELATIVE_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
  });

  for (const mode of [['--dry-run'], []]) {
    it(`the next ${mode.length ? 'dry run' : 'real sync'} does not advise either as an orphan`, async () => {
      const r = await sync(mode);
      assert.equal(r.code, 0, whySyncFailed(r));
      const out = String(r.out); // the advisory's words and paths survive its colour codes intact
      const orphanBlock = out.split('\n').filter((l, i, all) => /we no longer sync/.test(l) || /we no longer sync/.test(all[i - 1] ?? '')).join('\n');
      for (const rel of SYNC_RUN_ARTIFACTS) {
        assert.ok(!orphanBlock.includes(rel), `${rel} advised as no longer synced:\n${orphanBlock}`);
      }
      assert.ok(orphanBlock.includes(RETIRED), `the advisory ran and named the genuinely retired file:\n${out.slice(-3000)}`);
    });
  }
});
