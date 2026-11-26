/**
 * @fileoverview A consumer that TRACKS `.claude/skills/**` goes through an upstream skill rename (`ship` -> `ship-checked`):
 * the sync's gc deletes the retired `ship/` files from the working tree and records them under the receipt's `gcDeleted`.
 * The sync PR must commit those deletions too, or the consumer's main ends with BOTH skills (storyline #625, 2026-11-26).
 *
 * Only a deletion the sync itself recorded may ride: the receipt naming it must be byte-verified by the manifest, and the
 * current manifest must no longer intend the path. A deletion a person made — of a skill the sync never owned, or of any
 * other tracked file — stays uncommitted. Real git throughout; `gh` is the only stub.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { planConsumerPr, gatherConsumerFacts, runConsumerPr, branchNameFor } from '../scripts/lib/sync-pr.mjs';
import { classifyRepo } from '../scripts/sync-status.mjs';
import { createRetirementVerifier, classifyDirtyEntries, isDeletionEntry, RETIREMENT } from '../scripts/lib/sync-status.mjs';
import { buildOwnedSidecar, OWNED_SIDECAR_RELATIVE_PATH } from '../scripts/lib/sync-owned-sidecar.mjs';
import { MANIFEST_RELATIVE_PATH } from '../scripts/lib/sync-manifest.mjs';
import { RECEIPT_PATH, buildReceiptEntry, RECEIPT_VERSION } from '../scripts/lib/sync-receipt.mjs';
import { gitFixtureEnv, makeGitRunner, mkdtemp, rmrfBestEffort } from './helpers/fixtures.mjs';
import { writeFileIn as write } from './helpers/write-file.mjs';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OLD = ['.claude/skills/ship/SKILL.md', '.claude/skills/ship/references/flow.md'];
const NEW = ['.claude/skills/ship-checked/SKILL.md', '.claude/skills/ship-checked/references/flow.md'];
const USER_SKILL = '.claude/skills/my-own/SKILL.md'; // a skill the consumer wrote: never in any sidecar or manifest
const USER_DOC = 'docs/notes.md';
const hashOf = (body) => `sha256:${crypto.createHash('sha256').update(body).digest('hex')}`;

function gitRun(cmd, args, { cwd, input } = {}) {
  if (cmd === 'gh') {
    const stdout = { create: 'https://github.com/o/r/pull/7\n', list: '[]' }[args[1]] ?? '';
    return { status: 0, stdout, stderr: '' };
  }
  const r = spawnSync(cmd, args, { cwd, input, encoding: 'utf-8', env: gitFixtureEnv(), windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

/** A consumer whose main tracks the `ship` skill (sync-owned) plus its own skill and doc, then a sync's rename output on disk. */
function makeRenamedConsumer({ receiptTamper = null } = {}) {
  const root = mkdtemp('sync-pr-retire-');
  const git = makeGitRunner(() => root);
  const origin = path.join(root, 'origin.git');
  git(['init', '-q', '--bare', '-b', 'main', origin]);
  const consumer = path.join(root, 'consumer');
  git(['clone', '-q', origin, consumer]);
  for (const [k, v] of [['user.email', 'test@example.com'], ['user.name', 'Test'], ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'], ['core.hooksPath', path.join(root, 'no-hooks')]]) git(['config', k, v], consumer);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], consumer);

  // The previous sync, committed: the `ship` skill, its sidecar and receipt.
  write(consumer, '.gitignore', `${MANIFEST_RELATIVE_PATH}\n`);
  for (const p of OLD) write(consumer, p, `old ${p}\n`);
  write(consumer, USER_SKILL, 'mine\n');
  write(consumer, USER_DOC, 'notes\n');
  write(consumer, OWNED_SIDECAR_RELATIVE_PATH, `${JSON.stringify(buildOwnedSidecar(OLD), null, 2)}\n`);
  const firstEntry = buildReceiptEntry({ syncedAt: '2026-11-01T00:00:00.000Z', source: { repo: 'x/y', commitSha: 'f'.repeat(40) }, created: OLD });
  write(consumer, RECEIPT_PATH, `${JSON.stringify({ version: RECEIPT_VERSION, recentSyncs: [firstEntry] }, null, 2)}\n`);
  git(['add', '-A'], consumer);
  git(['commit', '-q', '-m', 'previous sync'], consumer);
  git(['push', '-q', 'origin', 'main'], consumer);

  // The rename sync, uncommitted: gc unlinked `ship/`, wrote `ship-checked/`, a new sidecar and a prepended receipt entry.
  fs.rmSync(path.join(consumer, '.claude/skills/ship'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  const files = {};
  for (const p of NEW) files[p] = hashOf(fs.readFileSync(write(consumer, p, `new ${p}\n`)));
  const sidecarBody = `${JSON.stringify(buildOwnedSidecar(NEW), null, 2)}\n`;
  write(consumer, OWNED_SIDECAR_RELATIVE_PATH, sidecarBody);
  files[OWNED_SIDECAR_RELATIVE_PATH] = hashOf(sidecarBody);
  // Stamped NOW, as the real sync stamps it: after every commit above (the reader dates consumption against it).
  const entry = buildReceiptEntry({ syncedAt: new Date(Date.now() + 1000).toISOString(), source: { repo: 'x/y', commitSha: SHA }, created: NEW, gcDeleted: OLD });
  const receiptBody = `${JSON.stringify({ version: RECEIPT_VERSION, recentSyncs: [entry, firstEntry] }, null, 2)}\n`;
  write(consumer, RECEIPT_PATH, receiptBody);
  files[RECEIPT_PATH] = hashOf(receiptBody);
  write(consumer, MANIFEST_RELATIVE_PATH, JSON.stringify({ repo: 'Lbstrydom/claude-engineering-skills', commitSha: SHA, files }));
  if (receiptTamper) write(consumer, RECEIPT_PATH, receiptTamper(receiptBody));

  // A person's own deletions, in the same dirty tree.
  fs.rmSync(path.join(consumer, USER_SKILL), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  fs.rmSync(path.join(consumer, USER_DOC), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  return { root, consumer, git };
}

let fx;
afterEach(() => { if (fx) rmrfBestEffort(fx.root); fx = null; });

describe('sync-pr commits the deletions of skills the sync retired (ship -> ship-checked)', () => {
  it('the sync commit deletes every retired ship/ path, adds ship-checked/, and touches nothing the consumer owns', async () => {
    fx = makeRenamedConsumer();
    const classified = classifyRepo(fx.consumer);
    assert.equal(classified.ok, true, classified.error);
    const facts = gatherConsumerFacts(gitRun, fx.consumer, { commitSha: SHA });
    assert.equal(facts.ok, true, facts.error);
    const manifest = JSON.parse(fs.readFileSync(path.join(fx.consumer, MANIFEST_RELATIVE_PATH), 'utf-8'));
    const plan = planConsumerPr({ consumerName: 'fixture', classified, manifest, ...facts });
    assert.equal(plan.action, 'pr', plan.detail);
    const result = await runConsumerPr({ plan, repoRoot: fx.consumer, baseBranch: facts.baseBranch, currentBranch: facts.currentBranch, merge: false, run: gitRun });
    assert.equal(result.ok, true, result.error);

    const branch = branchNameFor(SHA);
    const status = Object.fromEntries(fx.git(['diff', '--name-status', '--no-renames', `${branch}^`, branch], fx.consumer)
      .trim().split('\n').map((l) => l.split('\t')).map(([s, p]) => [p, s]));
    for (const p of OLD) assert.equal(status[p], 'D', `${p}: the retired path is deleted in the sync commit`);
    for (const p of NEW) assert.equal(status[p], 'A', `${p}: the renamed skill is added`);
    const tree = fx.git(['ls-tree', '-r', '--name-only', branch], fx.consumer).split('\n');
    assert.ok(tree.includes(USER_SKILL), 'a skill the sync never owned is not deleted, though it is gone from disk');
    assert.ok(tree.includes(USER_DOC), 'a consumer doc deleted by hand is not swept into the sync commit');
    assert.ok(!tree.some((p) => p.startsWith('.claude/skills/ship/')), 'main would no longer carry both skills');
    assert.match(plan.body, /\.claude\/skills\/ship\/SKILL\.md` — deleted/, 'the PR body says the path is a deletion, not verified bytes');
  });

  it('a receipt whose bytes the manifest does not vouch for authorises no deletion: the retired paths go to needs-review', () => {
    fx = makeRenamedConsumer({ receiptTamper: (body) => body.replace('"syncedAt": "20', '"syncedAt": "21') });
    const classified = classifyRepo(fx.consumer);
    assert.equal(classified.ok, true, classified.error);
    const owned = classified.syncOwned.map((e) => e.path);
    for (const p of OLD) assert.ok(!owned.includes(p), `${p} must not be committed on an unverified receipt`);
    const review = classified.needsReview.map((e) => e.path);
    for (const p of OLD) assert.ok(review.includes(p), `${p} is named for review, not silently dropped`);
    assert.ok(classified.other.some((e) => e.path === USER_SKILL), 'the consumer\'s own deletion stays theirs');
  });
});


describe('only a CURRENT, clean retirement is evidence (audit R1)', () => {
  it('a retirement already committed never vouches for a later hand deletion of a re-created file', () => {
    fx = makeRenamedConsumer();
    fx.git(['add', '-A'], fx.consumer);
    fx.git(['commit', '-q', '-m', 'rename sync landed'], fx.consumer);
    write(fx.consumer, OLD[0], 'the consumer brought it back as their own\n');
    fx.git(['add', '-A'], fx.consumer);
    fx.git(['commit', '-q', '-m', 'mine now'], fx.consumer);
    fs.rmSync(path.join(fx.consumer, OLD[0]), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    const classified = classifyRepo(fx.consumer);
    assert.equal(classified.ok, true, classified.error);
    assert.ok(!classified.syncOwned.some((e) => e.path === OLD[0]), 'the committed receipt entry still says gcDeleted, but it is consumed');
    assert.ok(classified.other.some((e) => e.path === OLD[0]), 'the deletion is the consumer\'s');
  });

  it('a re-creation committed ALONE while the retirement is still uncommitted consumes it (dated after syncedAt)', () => {
    fx = makeRenamedConsumer();
    write(fx.consumer, OLD[0], 'brought back before the sync PR\n');
    fx.git(['add', '--', OLD[0]], fx.consumer);
    // Committer date after the entry's syncedAt, and the commit holds the OLD receipt.
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const env = { GIT_COMMITTER_DATE: later, GIT_AUTHOR_DATE: later };
    const r = spawnSync('git', ['-C', fx.consumer, 'commit', '-q', '-m', 'mine', '--', OLD[0]], { encoding: 'utf-8', env: { ...gitFixtureEnv(), ...env } });
    assert.equal(r.status, 0, r.stderr);
    fs.rmSync(path.join(fx.consumer, OLD[0]), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    const classified = classifyRepo(fx.consumer);
    assert.equal(classified.ok, true, classified.error);
    assert.ok(!classified.syncOwned.some((e) => e.path === OLD[0]), 'changed after the retirement: the deletion is the consumer\'s');
    assert.ok(classified.syncOwned.some((e) => e.path === OLD[1]), 'positive control: the untouched sibling still rides');
  });

  it('a receipt committed WITHOUT its deletions (the pre-fix sync PR) keeps them pending: they still ride', () => {
    fx = makeRenamedConsumer();
    fx.git(['add', '--', RECEIPT_PATH, OWNED_SIDECAR_RELATIVE_PATH, ...NEW], fx.consumer);
    fx.git(['commit', '-q', '-m', 'old sync PR: receipt and additions only'], fx.consumer);
    const classified = classifyRepo(fx.consumer);
    assert.equal(classified.ok, true, classified.error);
    for (const p of OLD) assert.ok(classified.syncOwned.some((e) => e.path === p), `${p}: untouched since the retirement, still the sync's`);
    assert.ok(classified.other.some((e) => e.path === USER_SKILL));
  });

  it('a merge that carries a side branch\'s edit of the path onto main after the retirement consumes it (first-parent)', () => {
    fx = makeRenamedConsumer();
    const g = (args) => fx.git(args, fx.consumer);
    const synced = fs.readFileSync(path.join(fx.consumer, RECEIPT_PATH), 'utf-8');
    // Park the rename sync's output, branch from the previous sync, and edit the retired skill there.
    g(['stash', 'push', '-u', '-q', '-m', 'fixture-rename-output']);
    g(['switch', '-q', '-c', 'side']);
    write(fx.consumer, OLD[0], 'edited on a side branch\n');
    g(['commit', '-q', '-am', 'side edit']);
    g(['switch', '-q', 'main']);
    g(['stash', 'pop', '-q']);
    g(['add', '--', RECEIPT_PATH, OWNED_SIDECAR_RELATIVE_PATH, ...NEW]);
    g(['commit', '-q', '-m', 'old sync PR: receipt only']);
    g(['merge', '-q', '--no-edit', 'side']);
    assert.equal(fs.readFileSync(path.join(fx.consumer, RECEIPT_PATH), 'utf-8'), synced, 'fixture: the merge kept the rename receipt');
    fs.rmSync(path.join(fx.consumer, OLD[0]), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    const classified = classifyRepo(fx.consumer);
    assert.equal(classified.ok, true, classified.error);
    assert.ok(!classified.syncOwned.some((e) => e.path === OLD[0]), 'the side edit reached main after the retirement: not the sync\'s deletion');
  });

  it('a shallow clone cannot date the last change, so a retirement there is reviewed, never committed', () => {
    fx = makeRenamedConsumer();
    const shallowDir = path.join(fx.root, 'shallow');
    fx.git(['add', '--', RECEIPT_PATH, OWNED_SIDECAR_RELATIVE_PATH, ...NEW], fx.consumer);
    fx.git(['commit', '-q', '-m', 'old sync PR: receipt only'], fx.consumer);
    fx.git(['push', '-q', 'origin', 'main'], fx.consumer);
    fx.git(['clone', '-q', '--depth', '1', `file://${path.join(fx.root, 'origin.git').replaceAll('\\', '/')}`, shallowDir]);
    fs.copyFileSync(path.join(fx.consumer, MANIFEST_RELATIVE_PATH), path.join(shallowDir, MANIFEST_RELATIVE_PATH));
    for (const p of OLD) fs.rmSync(path.join(shallowDir, p), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    const classified = classifyRepo(shallowDir);
    assert.equal(classified.ok, true, classified.error);
    for (const p of OLD) assert.ok(classified.needsReview.some((e) => e.path === p), `${p}: unverified in a shallow clone`);
  });

  it('a malformed working receipt sends every deletion to review, the consumer\'s included — nothing is committed', () => {
    fx = makeRenamedConsumer({ receiptTamper: (body) => body.slice(0, 40) });
    const classified = classifyRepo(fx.consumer);
    assert.equal(classified.ok, true, classified.error);
    for (const p of [...OLD, USER_SKILL, USER_DOC]) assert.ok(classified.needsReview.some((e) => e.path === p), `${p} is reviewed`);
    assert.ok(!classified.syncOwned.some((e) => e.status.includes('D')));
  });

  it('a staged deletion whose path was re-created goes to review, never committed as a deletion', () => {
    fx = makeRenamedConsumer();
    fx.git(['add', '-u', '--', OLD[0]], fx.consumer);
    write(fx.consumer, OLD[0], 'recreated by hand\n');
    const classified = classifyRepo(fx.consumer);
    assert.equal(classified.ok, true, classified.error);
    assert.ok(classified.syncOwned.some((e) => e.path === OLD[1]), 'positive control: the untouched retired sibling is still the sync\'s');
    assert.ok(!classified.syncOwned.some((e) => e.path === OLD[0]));
    assert.ok(classified.needsReview.some((e) => e.path === OLD[0] && e.status === 'D '));
  });
});

describe('createRetirementVerifier — which deletions are the sync\'s (PURE)', () => {
  const P = '.claude/skills/ship/SKILL.md';
  const verify = (receiptEntries, { receiptVerified = true, manifestFiles = {}, committedEntries = [] } = {}) =>
    createRetirementVerifier({ receiptEntries, committedAsOf: () => committedEntries, receiptVerified, manifestFiles })(P);

  it('retired only when the NEWEST uncommitted mention of the path is a gcDeleted', () => {
    assert.equal(verify([{ syncedAt: 'b', gcDeleted: [P] }, { syncedAt: 'a', created: [P] }]), RETIREMENT.RETIRED);
    assert.equal(verify([{ syncedAt: 'b', created: [P] }, { syncedAt: 'a', gcDeleted: [P] }]), null, 'a later sync wrote it again: revoked');
    assert.equal(verify([{ syncedAt: 'a', updated: [P] }]), null);
    assert.equal(verify([]), null, 'no record: not the sync\'s deletion');
  });

  it('an entry in the receipt as of the path\'s last commit is consumed; "cannot tell" is unverified', () => {
    const e = { syncedAt: 'a', gcDeleted: [P] };
    assert.equal(verify([e], { committedEntries: [{ ...e }] }), null);
    assert.equal(verify([{ source: { commitSha: 'c' }, ...e }], { committedEntries: [{ gcDeleted: [P], syncedAt: 'a', source: { commitSha: 'c' } }] }), null,
      'the same run with its keys in another order is still the same run');
    assert.equal(verify([{ syncedAt: 'b', created: [P] }, e], { receiptVerified: false }), RETIREMENT.UNVERIFIED,
      'an unvouched receipt cannot revoke either: a gcDeleted anywhere in it is reviewed');
    assert.equal(verify([e], { committedEntries: null }), RETIREMENT.UNVERIFIED, 'unknown consumption: review, never retired, never silently dropped');
    assert.equal(verify([e], { committedEntries: [{ syncedAt: 'older', created: [P] }] }), RETIREMENT.RETIRED);
  });

  it('exact path identity for the evidence; the manifest-intended exclusion stays case-folded (conservative)', () => {
    assert.equal(verify([{ syncedAt: 'a', gcDeleted: [P.replace('ship', 'Ship')] }]), null, 'Ship/ is a different tracked file');
    assert.equal(verify([{ syncedAt: 'a', gcDeleted: [P] }], { manifestFiles: { [P.toUpperCase()]: 'sha256:x' } }), null);
  });

  it('an unverified receipt names the path for review, never as retired', () => {
    assert.equal(verify([{ syncedAt: 'a', gcDeleted: [P] }], { receiptVerified: false }), RETIREMENT.UNVERIFIED);
    const asOf = () => { throw new Error('git is asked only for a path some entry retired'); };
    assert.equal(createRetirementVerifier({ receiptEntries: [{ syncedAt: 'a', created: [P] }], committedAsOf: asOf, receiptVerified: true, manifestFiles: {} })(P), null);
  });

  it('an unreadable working receipt names nothing, so every deletion is unverified (never "not ours")', () => {
    assert.equal(createRetirementVerifier({ receiptEntries: null, committedAsOf: () => [], receiptVerified: true, manifestFiles: {} })('docs/x.md'), RETIREMENT.UNVERIFIED);
    assert.equal(createRetirementVerifier({ receiptEntries: [{ syncedAt: 'a', gcDeleted: [P] }], committedAsOf: undefined, receiptVerified: true, manifestFiles: {} })(P), RETIREMENT.UNVERIFIED, 'no reader: fail closed');
  });

  it('classifyDirtyEntries: ambiguous index state or a reoccupied path goes to needs-review; renames are not deletions', () => {
    const r = classifyDirtyEntries({
      entries: [
        { status: ' D', path: 'a', origPath: null }, { status: 'D ', path: 'b', origPath: null }, { status: 'AD', path: 'c', origPath: null },
        { status: 'D ', path: 'd', origPath: null }, { status: '??', path: 'd', origPath: null },
        { status: 'D ', path: 'e', origPath: null }, { status: '??', path: 'e/inner.md', origPath: null },
        { status: 'D ', path: 'f/g/SKILL.md', origPath: null }, { status: '??', path: 'f/', origPath: null },
      ],
      isUpstreamOwned: () => false, isVerifiedSyncOutput: () => false,
      retirementOf: (p) => (['a', 'b', 'c', 'd', 'e', 'f/g/SKILL.md'].includes(p) ? RETIREMENT.RETIRED : null),
    });
    assert.deepEqual(r.syncOwned.map((e) => e.path), ['a', 'b']);
    assert.deepEqual(r.needsReview.map((e) => e.path), ['c', 'd', 'e', 'f/g/SKILL.md'], 'f/: a collapsed untracked ancestor');
    assert.equal(isDeletionEntry({ status: 'R ', path: 'n', origPath: 'o' }), false);
    assert.equal(isDeletionEntry({ status: ' M', path: 'n', origPath: null }), false);
  });
});
