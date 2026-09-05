/**
 * @fileoverview One merge rule, one serialiser — the two ledger write paths may
 * not drift apart.
 *
 * WHY. `upstreamTransition` (every `upstream fix` / `wont-fix`) writes ONE entry
 * through `upsertDispositionLedgerEntry`; `--apply` writes MANY through
 * `mergeLedgerEntry` + `serialiseDispositionLedger`. Those were two full copies
 * of the same merge rule and the same `_description` blob, while the single-entry
 * function's own docstring claimed it was "read → merge → write over the same
 * rule" — so a future edit to the merge rule would have been made once, in the
 * path the author happened to be reading, and the other would have kept the old
 * behaviour silently. Found by the consolidated Gemini gate, 2026-09-05.
 *
 * This asserts an EQUIVALENCE, not a behaviour: it is green today whether or not
 * the composition exists, and its entire value is that it goes red the moment the
 * two spellings disagree. Negative control performed at authoring time — mutating
 * the merge rule in one path only, and confirming this suite fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  DISPOSITION_LEDGER_PATH, upsertDispositionLedgerEntry, mergeLedgerEntry,
  serialiseDispositionLedger,
} from '../scripts/lib/upstream/disposition-ledger.mjs';
import { withFileLock } from '../scripts/lib/file-lock.mjs';

/** `recordedAt` is a clock read — normalise it so the comparison is about the RULE. */
function stripClock(text) {
  return text.replace(/"recordedAt": "[^"]*"/g, '"recordedAt": "<clock>"');
}

async function withTempRepo(seedEntries, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-ledger-'));
  try {
    const p = path.join(root, DISPOSITION_LEDGER_PATH);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (seedEntries) fs.writeFileSync(p, serialiseDispositionLedger(seedEntries));
    return await fn(root, p);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

const CASES = [
  {
    name: 'first-ever entry into an absent ledger',
    seed: null,
    entry: { issueId: 'u1', state: 'fixed', disposition: { kind: 'test', ref: 'tests/a.test.mjs' }, storeFingerprint: 'abc123' },
  },
  {
    name: 're-transition REPLACES the prior entry for that issue',
    seed: [{ schemaVersion: 1, issueId: 'u1', storeFingerprint: 'abc123', state: 'wont_fix', disposition: { kind: 'exemption', reason: 'old' }, recordedAt: '2020-01-01T00:00:00.000Z' }],
    entry: { issueId: 'u1', state: 'fixed', disposition: { kind: 'probe', ref: 'p1' }, storeFingerprint: 'abc123' },
  },
  {
    name: 'a re-write with no fingerprint PRESERVES the prior one',
    seed: [{ schemaVersion: 1, issueId: 'u1', storeFingerprint: 'abc123', state: 'fixed', disposition: { kind: 'probe', ref: 'p1' }, recordedAt: '2020-01-01T00:00:00.000Z' }],
    entry: { issueId: 'u1', state: 'wont_fix', disposition: { kind: 'exemption', reason: 'r' }, storeFingerprint: null },
  },
  {
    name: 'entries sort by issueId regardless of insertion order',
    seed: [{ schemaVersion: 1, issueId: 'u9', state: 'fixed', disposition: { kind: 'probe', ref: 'p9' }, recordedAt: '2020-01-01T00:00:00.000Z' },
           { schemaVersion: 1, issueId: 'u2', state: 'fixed', disposition: { kind: 'probe', ref: 'p2' }, recordedAt: '2020-01-01T00:00:00.000Z' }],
    entry: { issueId: 'u5', state: 'fixed', disposition: { kind: 'probe', ref: 'p5' }, storeFingerprint: null },
  },
];

for (const c of CASES) {
  test(`single-entry and batch write paths agree — ${c.name}`, async () => {
    const viaSingle = await withTempRepo(c.seed, async (root, p) => {
      await upsertDispositionLedgerEntry(root, c.entry);
      return fs.readFileSync(p, 'utf-8');
    });
    const viaBatch = serialiseDispositionLedger(mergeLedgerEntry(c.seed ?? [], c.entry));

    assert.equal(stripClock(viaSingle), stripClock(viaBatch),
      'the single-entry writer and the batch writer must produce byte-identical '
      + 'ledgers — two spellings of one merge rule is how they drift apart');
  });
}

test('the written bytes are exactly what the one serialiser produces', async () => {
  const entry = { issueId: 'u1', state: 'fixed', disposition: { kind: 'probe', ref: 'p1' }, storeFingerprint: 'f1' };
  const written = await withTempRepo(null, async (root, p) => {
    await upsertDispositionLedgerEntry(root, entry);
    return fs.readFileSync(p, 'utf-8');
  });
  // Not a tautology: it pins the `_description` blob and the trailing newline to
  // ONE source, which is the half a hand-rolled copy silently forks.
  assert.ok(written.endsWith('}\n'), 'ledger must end with exactly one newline');
  assert.equal(
    stripClock(written).replace(/"recordedAt": "<clock>"/, '"recordedAt": "<clock>"'),
    stripClock(serialiseDispositionLedger(mergeLedgerEntry([], entry))),
  );
});

/**
 * The lock is only as strong as its least-disciplined participant.
 *
 * `applyMissingDispositions` (`--apply`) does its read-modify-write inside
 * `withFileLock`. That buys nothing if the OTHER writer of the same file —
 * every `upstream fix` / `wont-fix` — reads and writes outside it: the two
 * interleave and the later write silently drops the earlier one's entry.
 * Found by the consolidated Gemini gate as G2, 2026-09-05, and confirmed:
 * only the batch path held the lock.
 *
 * Deterministic rather than racy: the test HOLDS the lock, starts the writer
 * without awaiting it, yields the event loop, and asserts nothing landed —
 * then releases and asserts it did. No sleep decides the outcome.
 */
test('the single-entry writer waits for the ledger lock', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-ledger-lock-'));
  try {
    const ledger = path.join(root, DISPOSITION_LEDGER_PATH);
    fs.mkdirSync(path.dirname(ledger), { recursive: true });

    let releaseHolder;
    const holderReleased = new Promise((r) => { releaseHolder = r; });
    let writerPromise;
    let landedWhileHeld = null;

    await withFileLock(`${ledger}.lock`, {}, async () => {
      writerPromise = upsertDispositionLedgerEntry(root, {
        issueId: 'u1', state: 'fixed', disposition: { kind: 'probe', ref: 'p1' }, storeFingerprint: null,
      });
      // Yield generously — the writer's lock acquisition retries with backoff,
      // so "it did not land" must survive more than a single microtask turn.
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 20));
      landedWhileHeld = fs.existsSync(ledger);
      releaseHolder();
      await holderReleased;
    });

    await writerPromise;

    assert.equal(landedWhileHeld, false,
      'the single-entry writer wrote while another holder owned the ledger lock — '
      + 'a concurrent `upstream fix` and `--apply` can then lose a disposition');
    assert.ok(fs.existsSync(ledger), 'the write must still land once the lock is free');
    assert.match(fs.readFileSync(ledger, 'utf-8'), /"issueId": "u1"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
