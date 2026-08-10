import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  computeLockDigest, lockFilePath, writeLockFile, readLockFile,
  receiptPath, maxAttemptOnDisk, resolveNextAttempt,
  claimReceipt, completeReceipt, markReceiptRecorded, scanReceipts,
} from '../scripts/lib/campaign/lock.mjs';

const repoRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-lock-'));

const LOCK_INPUTS = {
  schemaVersion: 1,
  configDigest: 'abcdef0123456789',
  resolvedModels: { opus: 'claude-opus-5', kimi: 'moonshotai/kimi-k2-thinking' },
  providerRoutes: { opus: 'anthropic', kimi: 'openrouter' },
  reasoningEffort: 'high',
  promptTemplateHash: 'p'.repeat(16),
  outputSchemaHash: 's'.repeat(16),
  adjudicatorModel: 'latest-opus',
  pricingVersion: '2026-07-01',
  eligibilityRule: 'mode=code,plan-resolvable,audited_sha-present',
  armIds: ['opus', 'kimi', 'solo-opus'],
};
const armRun = (repoRoot) => ({ campaignId: 'c1', cohortDigest: 'deadbeefdeadbeef', snapshotId: 'aabbccddeeff', armId: 'opus', repoRoot });

describe('lockDigest — the epoch nobody has to remember to bump', () => {
  it('is stable, and independent of arm DECLARATION order', () => {
    const a = computeLockDigest(LOCK_INPUTS);
    const b = computeLockDigest({ ...LOCK_INPUTS, armIds: ['solo-opus', 'kimi', 'opus'] });
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.equal(a, b, 'reordering arms in the config must not orphan evidence');
  });

  it('CHANGES on every meaning-changing input — that is what orphans a cohort', () => {
    const before = computeLockDigest(LOCK_INPUTS);
    const mutations = {
      configDigest: 'ffffffffffffffff',
      resolvedModels: { opus: 'claude-opus-6', kimi: 'moonshotai/kimi-k2-thinking' },
      providerRoutes: { opus: 'azure', kimi: 'openrouter' },
      reasoningEffort: 'low',
      promptTemplateHash: 'q'.repeat(16),
      outputSchemaHash: 't'.repeat(16),
      adjudicatorModel: 'latest-sonnet',
      pricingVersion: '2026-09-01',
      eligibilityRule: 'mode=code',
      armIds: ['opus', 'kimi'],           // dropping an arm mixes two populations
    };
    for (const [key, value] of Object.entries(mutations)) {
      assert.notEqual(computeLockDigest({ ...LOCK_INPUTS, [key]: value }), before, `${key} must be part of the epoch`);
    }
  });

  it('refuses a missing input rather than silently producing a different epoch', () => {
    for (const key of Object.keys(LOCK_INPUTS)) {
      const partial = { ...LOCK_INPUTS };
      delete partial[key];
      assert.throws(() => computeLockDigest(partial), new RegExp(key), `omitting ${key} must throw`);
    }
  });
});

describe('lock file — a cache, never the authority', () => {
  it('round-trips, and a torn file reads as a miss rather than throwing', () => {
    const root = repoRoot();
    writeLockFile('c1', { lockDigest: 'x'.repeat(16), resolvedAt: 'now' }, { repoRoot: root });
    assert.equal(readLockFile('c1', { repoRoot: root }).lockDigest, 'x'.repeat(16));

    fs.writeFileSync(lockFilePath('c1', { repoRoot: root }), '{ this is not json');
    assert.equal(readLockFile('c1', { repoRoot: root }), null, 'the store holds the authority; a torn cache is a miss');
    assert.equal(readLockFile('never-written', { repoRoot: root }), null);
  });
});

describe('receipt paths are repo-root contained', () => {
  it('refuses a campaign id that escapes, even though the schema also blocks it', () => {
    const root = repoRoot();
    // Defence-in-depth: this is the guard that still holds if the config
    // pattern is ever loosened. Depth matters and is worth stating — the id is
    // joined under `.audit/campaigns/`, so it takes FOUR levels to clear the
    // repo root. A shallower traversal is contained by construction (it lands
    // back inside the repo), which is why it is asserted as contained rather
    // than quietly assumed to throw.
    assert.throws(() => receiptPath({ ...armRun(root), campaignId: `${'../'.repeat(4)}evil`, attempt: 1 }), /escapes the repo root/);
    // The arm id is embedded MID-FILENAME (`<snapshot>--<arm>--<attempt>`), so
    // its first `..` is absorbed into the literal segment `<snapshot>--..` and
    // it takes one more level than the campaign id to clear the root. Measured,
    // not guessed: 6 is contained, 7 escapes.
    assert.throws(() => receiptPath({ ...armRun(root), armId: `${'../'.repeat(7)}evil`, attempt: 1 }), /escapes the repo root/);
    assert.doesNotThrow(() => receiptPath({ ...armRun(root), armId: `${'../'.repeat(6)}evil`, attempt: 1 }));

    // The two non-obvious CONTAINED cases, pinned so nobody "hardens" them into
    // false positives. A shallow traversal normalises back inside the repo, and
    // `path.join` treats an absolute second argument as an ordinary segment
    // rather than resetting to it — so both land under the root. Ugly, but
    // contained, which is exactly what this guard promises; the schema's id
    // pattern is what rejects them as inputs.
    assert.doesNotThrow(() => receiptPath({ ...armRun(root), campaignId: '../../etc', attempt: 1 }));
    assert.doesNotThrow(() => receiptPath({ ...armRun(root), campaignId: path.resolve(os.tmpdir(), 'elsewhere'), attempt: 1 }));
  });

  it('requires a positive integer attempt', () => {
    const root = repoRoot();
    for (const bad of [0, -1, 1.5, null, 'one']) {
      assert.throws(() => receiptPath({ ...armRun(root), attempt: bad }), /attempt must be/);
    }
  });

  it('includes the attempt, so a --force retry cannot collide with its predecessor', () => {
    const root = repoRoot();
    const one = receiptPath({ ...armRun(root), attempt: 1 });
    const two = receiptPath({ ...armRun(root), attempt: 2 });
    assert.notEqual(one, two);
    assert.match(path.basename(one), /--1\.receipt\.json$/);
  });
});

describe('attempt resolution reads DISK ∪ DB, never the DB alone', () => {
  it('a claimed-but-unrecorded receipt still advances the attempt (the wedge)', () => {
    // The exact failure this rule exists for: the runner claims attempt 1 and
    // crashes BEFORE the store write. No row exists, so a DB-only resolver
    // returns 1 forever, collides on `wx`, reads it as a lost race, and exits —
    // including under --force. The arm-run becomes unrunnable, silently.
    const root = repoRoot();
    const run = armRun(root);
    assert.equal(resolveNextAttempt({ ...run, dbMaxAttempt: 0 }), 1, 'first attempt with nothing anywhere');

    assert.equal(claimReceipt({ ...run, attempt: 1 }).ok, true);
    assert.equal(maxAttemptOnDisk(run), 1);
    assert.equal(resolveNextAttempt({ ...run, dbMaxAttempt: 0 }), 2, 'disk knows about the crashed attempt even though the DB does not');
  });

  it('takes the max of the two sources, not either one', () => {
    const root = repoRoot();
    const run = armRun(root);
    claimReceipt({ ...run, attempt: 1 });
    claimReceipt({ ...run, attempt: 2 });
    assert.equal(resolveNextAttempt({ ...run, dbMaxAttempt: 0 }), 3, 'disk ahead of db');
    assert.equal(resolveNextAttempt({ ...run, dbMaxAttempt: 7 }), 8, 'db ahead of disk');
  });

  it('counts only receipts for the SAME arm-run', () => {
    const root = repoRoot();
    const run = armRun(root);
    claimReceipt({ ...run, attempt: 5 });
    assert.equal(resolveNextAttempt({ ...run, armId: 'kimi', dbMaxAttempt: 0 }), 1, 'another arm must not inherit an attempt number');
    assert.equal(resolveNextAttempt({ ...run, snapshotId: 'ffffffffffff', dbMaxAttempt: 0 }), 1, 'another snapshot likewise');
  });
});

describe('the claim is exclusive-create, and that failure IS the ownership', () => {
  it('a second claim on the same attempt loses, and does not throw', () => {
    const root = repoRoot();
    const run = armRun(root);
    assert.deepEqual(claimReceipt({ ...run, attempt: 1 }).ok, true);
    const second = claimReceipt({ ...run, attempt: 1 });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'claimed', 'a live concurrent runner must skip, not crash');
  });

  it('the claim does NOT overwrite — mutual exclusion survives', () => {
    // atomicWriteFileSync is temp+rename and rename REPLACES, so using it here
    // would have silently destroyed this property while still "looking" like wx.
    const root = repoRoot();
    const run = armRun(root);
    claimReceipt({ ...run, attempt: 1, body: { marker: 'first-writer' } });
    claimReceipt({ ...run, attempt: 1, body: { marker: 'second-writer' } });
    const onDisk = JSON.parse(fs.readFileSync(receiptPath({ ...run, attempt: 1 }), 'utf-8'));
    assert.equal(onDisk.marker, 'first-writer', 'the loser must not have overwritten the winner');
  });
});

describe('receipt lifecycle — intent -> complete -> recorded', () => {
  it('walks the states and keeps the claim body', () => {
    const root = repoRoot();
    const run = armRun(root);
    claimReceipt({ ...run, attempt: 1, body: { requestedAt: 'T0' } });
    const read = () => JSON.parse(fs.readFileSync(receiptPath({ ...run, attempt: 1 }), 'utf-8'));
    assert.equal(read().state, 'intent');

    completeReceipt({ ...run, attempt: 1, result: { costUsd: 1.25, usage: { input_tokens: 10 } } });
    assert.equal(read().state, 'complete');
    assert.equal(read().costUsd, 1.25);
    assert.equal(read().requestedAt, 'T0', 'the claim body survives');

    markReceiptRecorded({ ...run, attempt: 1 });
    assert.equal(read().state, 'recorded');
    assert.equal(read().costUsd, 1.25, 'the paid figure survives the final transition');
  });

  it('refuses to mark a state for an attempt that was never claimed', () => {
    const root = repoRoot();
    const run = armRun(root);
    assert.throws(() => completeReceipt({ ...run, attempt: 1, result: {} }), /no claimed receipt/);
    assert.throws(() => markReceiptRecorded({ ...run, attempt: 1 }), /no claimed receipt/);
  });
});

describe('scanReceipts — the crash window is reported, never guessed at', () => {
  it('surfaces intent and complete distinctly, across cohorts', () => {
    const root = repoRoot();
    const run = armRun(root);
    claimReceipt({ ...run, attempt: 1 });                                    // intent: paid-or-not UNKNOWN
    claimReceipt({ ...run, armId: 'kimi', attempt: 1 });
    completeReceipt({ ...run, armId: 'kimi', attempt: 1, result: { costUsd: 2 } }); // complete: paid, unrecorded
    claimReceipt({ ...run, cohortDigest: '1111111111111111', armId: 'opus', attempt: 1 });

    const all = scanReceipts('c1', { repoRoot: root });
    assert.equal(all.length, 3);
    const byState = Object.fromEntries(all.map((r) => [`${r.cohortDigest}:${r.armId}`, r.state]));
    assert.equal(byState['deadbeefdeadbeef:opus'], 'intent');
    assert.equal(byState['deadbeefdeadbeef:kimi'], 'complete');
    assert.equal(byState['1111111111111111:opus'], 'intent');
    assert.equal(all.find((r) => r.armId === 'kimi').costUsd, 2);
  });

  it('an unreadable receipt is REPORTED, not skipped', () => {
    // A torn receipt in the crash window is precisely what an operator must see.
    const root = repoRoot();
    const run = armRun(root);
    claimReceipt({ ...run, attempt: 1 });
    fs.writeFileSync(receiptPath({ ...run, attempt: 1 }), '{ torn');
    const all = scanReceipts('c1', { repoRoot: root });
    assert.equal(all.length, 1);
    assert.equal(all[0].state, 'unreadable');
  });

  it('an absent campaign directory scans to empty rather than throwing', () => {
    assert.deepEqual(scanReceipts('never-ran', { repoRoot: repoRoot() }), []);
  });
});
