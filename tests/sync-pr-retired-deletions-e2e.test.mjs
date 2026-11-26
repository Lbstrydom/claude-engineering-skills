/**
 * @fileoverview The REAL sync's gc retires a tracked skill, and `sync-pr` commits that deletion — the evidence chain
 * (manifest -> receipt bytes -> `gcDeleted`) is produced by `sync-to-repos.mjs` itself, not hand-built (audit R1 M1/M2 on
 * the sibling `sync-pr-retired-deletions.test.mjs`, whose synthetic fixture covers the edge cases).
 *
 * The retired skill is seeded the way a previous sync leaves one: committed in the consumer and recorded in the gitignored
 * manifest at its exact hash, while upstream no longer ships it — precisely the `ship` -> `ship-checked` state. A skill
 * the consumer wrote is deleted by hand in the same tree and must stay out of the commit. Tier 3 (consumer sync seam).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { seedInstalledDeps, runSyncCli, whySyncFailed, git } from './helpers/consumer-fixture.mjs';
import { planConsumerPr, gatherConsumerFacts, runConsumerPr, branchNameFor } from '../scripts/lib/sync-pr.mjs';
import { classifyRepo } from '../scripts/sync-status.mjs';
import { MANIFEST_RELATIVE_PATH } from '../scripts/lib/sync-manifest.mjs';
import { RECEIPT_PATH } from '../scripts/lib/sync-receipt.mjs';
import { gitFixtureEnv } from './helpers/fixtures.mjs';

const RETIRED = '.claude/skills/retired-upstream/SKILL.md';
const USER_SKILL = '.claude/skills/my-own/SKILL.md';
const commitAll = (cwd, msg) => { git(['add', '-A'], cwd); git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg], cwd); };

function run(cmd, args, { cwd, input } = {}) {
  if (cmd === 'gh') return { status: 0, stdout: { create: 'https://github.com/o/r/pull/9\n', list: '[]' }[args[1]] ?? '', stderr: '' };
  const r = spawnSync(cmd, args, { cwd, input, encoding: 'utf-8', env: gitFixtureEnv(), windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

let tmp, consumer;
before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ces-retire-e2e-')));
  const origin = path.join(tmp, 'origin.git');
  consumer = path.join(tmp, 'consumer');
  git(['init', '-q', '--bare', '-b', 'main', origin], tmp);
  fs.mkdirSync(consumer);
  git(['init', '-q', '--initial-branch=main'], consumer);
  for (const [k, v] of [['user.email', 'test@example.invalid'], ['user.name', 'Retire E2E'], ['core.autocrlf', 'false'],
    ['core.hooksPath', path.join(tmp, 'no-hooks')]]) git(['config', k, v], consumer);
  git(['remote', 'add', 'origin', origin], consumer);
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'retire-fixture', type: 'module' }, null, 2));
  seedInstalledDeps(consumer);
  fs.writeFileSync(path.join(consumer, '.gitignore'), '');
  commitAll(consumer, 'init');

  const first = await runSyncCli(['--target-path', consumer, '--no-prompt']);
  assert.equal(first.code, 0, whySyncFailed(first));
  // What a previous bundle left: the skill committed, and its exact bytes recorded in the manifest.
  const body = 'a skill upstream has since renamed\n';
  fs.mkdirSync(path.dirname(path.join(consumer, RETIRED)), { recursive: true });
  fs.writeFileSync(path.join(consumer, RETIRED), body);
  fs.mkdirSync(path.dirname(path.join(consumer, USER_SKILL)), { recursive: true });
  fs.writeFileSync(path.join(consumer, USER_SKILL), 'mine\n');
  const manifestPath = path.join(consumer, MANIFEST_RELATIVE_PATH);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  manifest.files[RETIRED] = `sha256:${crypto.createHash('sha256').update(body).digest('hex')}`;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  commitAll(consumer, 'previous sync PR');
  git(['push', '-q', '-u', 'origin', 'main'], consumer);
});
after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

describe('real sync retires a tracked skill; sync-pr commits the deletion', () => {
  it('the sync deletes the retired skill, records it, and the sync PR commit deletes it and nothing the consumer owns', async () => {
    const second = await runSyncCli(['--target-path', consumer, '--no-prompt']);
    assert.equal(second.code, 0, whySyncFailed(second));
    assert.equal(fs.existsSync(path.join(consumer, RETIRED)), false, 'gc retired the unedited skill');
    const receipt = JSON.parse(fs.readFileSync(path.join(consumer, RECEIPT_PATH), 'utf-8'));
    assert.ok(receipt.recentSyncs[0].gcDeleted.includes(RETIRED), 'the sync recorded the retirement');
    fs.rmSync(path.join(consumer, USER_SKILL), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

    const classified = classifyRepo(consumer);
    assert.equal(classified.ok, true, classified.error);
    const manifest = JSON.parse(fs.readFileSync(path.join(consumer, MANIFEST_RELATIVE_PATH), 'utf-8'));
    const facts = gatherConsumerFacts(run, consumer, { commitSha: manifest.commitSha });
    assert.equal(facts.ok, true, facts.error);
    const plan = planConsumerPr({ consumerName: 'retire-fixture', classified, manifest, ...facts });
    assert.equal(plan.action, 'pr', `${plan.reason}: ${plan.detail}`);
    const result = await runConsumerPr({ plan, repoRoot: consumer, baseBranch: facts.baseBranch, currentBranch: facts.currentBranch, merge: false, run });
    assert.equal(result.ok, true, result.error);

    const branch = branchNameFor(manifest.commitSha);
    const changed = git(['diff', '--name-status', '--no-renames', `${branch}^`, branch], consumer);
    assert.match(changed, new RegExp(`^D\t${RETIRED.replace(/[.*+?^${}()|[\]\/]/g, '\$&')}$`, 'm'), changed);
    assert.ok(git(['ls-tree', '-r', '--name-only', branch], consumer).split('\n').includes(USER_SKILL), 'the consumer\'s own skill survives');
  });
});
