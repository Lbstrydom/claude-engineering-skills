/**
 * @fileoverview The sync's edit to a consumer's `.github/copilot-instructions.md`
 * (retiring the old installer's block) must be RECORDED in `.sync-receipt.json`.
 *
 * Upstream report aac80849 (wine-cellar-app, 2026-09-29): the file changed 27 ms
 * before a receipt entry that listed `updated: 2` and named neither it nor the
 * action, so the operator could not attribute an edit to a tracked file. The
 * receipt exists to be the in-repo record of what a sync touched; an edit it
 * does not name is the silence it was built to end.
 *
 * Tier-3 consumer-sync contract: drives the real CLI at a scratch git repo.
 */
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { seedInstalledDeps, runSyncCli, whySyncFailed, git } from './helpers/consumer-fixture.mjs';
import {
  LEGACY_COPILOT_START, LEGACY_COPILOT_END, COPILOT_INSTRUCTIONS_PATH,
} from '../scripts/lib/sync-legacy-copilot-block.mjs';

const BLOCK = `${LEGACY_COPILOT_START}
## Engineering Skills Bundle

This repo uses \`claude-engineering-skills\`.

## Keeping Skills Current
- Check for updates: \`node .audit-loop/bootstrap.mjs check\`
${LEGACY_COPILOT_END}`;
const ORIGINAL = `# Consumer instructions\n\n${BLOCK}\n`;

let tmp;
let consumer;
const abs = (rel) => path.join(consumer, rel);
const receiptFile = () => JSON.parse(fs.readFileSync(abs('.sync-receipt.json'), 'utf-8'));

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ces-legacy-receipt-')));
  consumer = path.join(tmp, 'consumer');
  fs.mkdirSync(path.join(consumer, '.github'), { recursive: true });
  git(['init', '--initial-branch=main'], consumer);
  git(['config', 'user.email', 'test@example.invalid'], consumer);
  git(['config', 'user.name', 'Legacy Receipt Test'], consumer);
  fs.writeFileSync(abs('package.json'), JSON.stringify({ name: 'legacy-receipt-fixture', type: 'module' }, null, 2));
  fs.writeFileSync(abs(COPILOT_INSTRUCTIONS_PATH), ORIGINAL);
  fs.writeFileSync(abs('.gitignore'), '');
  seedInstalledDeps(consumer);
  git(['add', '-A'], consumer);
  git(['commit', '-m', 'init', '--no-gpg-sign'], consumer);
});

after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

describe('sync records the legacy copilot-block retirement in the receipt', () => {
  it('dry-run writes nothing — neither the edit nor a receipt', async () => {
    const r = await runSyncCli(['--target-path', consumer, '--no-prompt', '--dry-run']);
    assert.equal(r.code, 0, whySyncFailed(r));
    assert.equal(fs.readFileSync(abs(COPILOT_INSTRUCTIONS_PATH), 'utf-8'), ORIGINAL);
    assert.equal(fs.existsSync(abs('.sync-receipt.json')), false, 'dry-run wrote a receipt');
  });

  it('a real sync removes the block AND the newest receipt entry names the path and action', async () => {
    const r = await runSyncCli(['--target-path', consumer, '--no-prompt']);
    assert.equal(r.code, 0, whySyncFailed(r));
    assert.equal(fs.readFileSync(abs(COPILOT_INSTRUCTIONS_PATH), 'utf-8'), '# Consumer instructions\n');
    const entry = receiptFile().recentSyncs[0];
    assert.deepEqual(entry.legacyRetired, [{ path: COPILOT_INSTRUCTIONS_PATH, action: 'remove-block' }]);
    assert.equal(entry.counts.legacyRetired, 1);
  });

  it('a follow-up no-op sync does not re-record a retirement it did not perform', async () => {
    const before = receiptFile().recentSyncs.length;
    const r = await runSyncCli(['--target-path', consumer, '--no-prompt']);
    assert.equal(r.code, 0, whySyncFailed(r));
    const after = receiptFile().recentSyncs;
    // Either no entry was added (a no-op sync writes nothing), or the added one
    // records nothing retired — never a copy of the previous run's retirement.
    if (after.length > before) assert.deepEqual(after[0].legacyRetired, []);
    else assert.equal(after.length, before);
  });
});
