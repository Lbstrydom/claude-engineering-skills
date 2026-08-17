/**
 * @fileoverview Receipt-filename parsing, bake-off log promotion, --force
 * retry, and per-arm retry classification (campaign/promote).
 *
 * Split out of `tests/campaign-adjudication.test.mjs` (Phase 4, plan:
 * comparison-tooling-consolidation.md, D3) — assertions moved verbatim.
 *
 * @module tests/campaign-promote
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  classifyLogEntry, resolvePromotionAttempts, isArmRetried, repoId,
} from '../scripts/lib/campaign/promote.mjs';

// ── repoId: cloud-off / unresolved must stay a quiet null; a real store ─────
// failure must THROW, not collapse into the same null (bake-off-campaign
// gate G1) ───────────────────────────────────────────────────────────────

describe('repoId', () => {
  it('cloud off (no AUDIT_DB_URL) resolves to null, not a throw', async () => {
    const saved = process.env.AUDIT_DB_URL;
    delete process.env.AUDIT_DB_URL;
    try {
      assert.equal(await repoId(), null);
    } finally {
      if (saved === undefined) delete process.env.AUDIT_DB_URL;
      else process.env.AUDIT_DB_URL = saved;
    }
  });
  // The `kind:'error'` → throw path (a real DB connectivity/auth failure)
  // needs a broken-but-live connection to exercise honestly and is covered
  // at the CLI boundary instead: an uncaught throw from here propagates
  // through `promoteFromLog` to `main()`'s top-level `.catch()` in
  // campaign.mjs, which already exits non-zero on any thrown error — the
  // behaviour this fix relies on, not a new contract this test would invent.
});

// ── receipt-name parsing (consolidated gate G1) ─────────────────────────────

describe('receipt filename parsing', () => {
  it('round-trips an arm id containing a DOUBLE hyphen', async () => {
    // `solo--opus` is a legal arm id (`^[a-z0-9][a-z0-9-]*$`), and a greedy
    // parse read it as snapshotId="abcdef123456--solo", armId="opus". Both then
    // fail the caller's equality check, the receipt is SILENTLY skipped,
    // maxAttemptOnDisk returns 0, and every later run collides on `wx` — the
    // permanent wedge resolveNextAttempt exists to prevent, with the worst
    // possible symptom.
    const lock = await import('../scripts/lib/campaign/lock.mjs');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-'));
    const args = { campaignId: 'c1', cohortDigest: 'd1', snapshotId: 'abcdef123456', armId: 'solo--opus', repoRoot: root };
    const claim = lock.claimReceipt({ ...args, attempt: 1 });
    assert.equal(claim.ok, true);

    const max = lock.maxAttemptOnDisk(args);
    assert.equal(max, 1, 'the receipt just written must be visible to the disk scan');
    assert.equal(lock.resolveNextAttempt({ ...args, dbMaxAttempt: 0 }), 2, 'a wedge would resolve 1 forever');

    const scanned = lock.scanReceipts('c1', { repoRoot: root });
    assert.equal(scanned.length, 1);
    assert.equal(scanned[0].snapshotId, 'abcdef123456');
    assert.equal(scanned[0].armId, 'solo--opus');
    assert.equal(scanned[0].attempt, 1);
  });

  it('still parses the ordinary single-hyphen arm id', async () => {
    const lock = await import('../scripts/lib/campaign/lock.mjs');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt2-'));
    const args = { campaignId: 'c1', cohortDigest: 'd1', snapshotId: 'abcdef123456', armId: 'solo-opus', repoRoot: root };
    lock.claimReceipt({ ...args, attempt: 3 });
    const scanned = lock.scanReceipts('c1', { repoRoot: root });
    assert.equal(scanned[0].armId, 'solo-opus');
    assert.equal(scanned[0].attempt, 3);
  });
});

// ── promotion: the producer for the arm-run spine ───────────────────────────

describe('bake-off log promotion', () => {
  const ctx = { campaignId: 'camp', lockDigest: 'lock1', shaByRunId: { r1: 'abc123', r2: 'abc123', r3: 'def456' } };

  it('promotes a well-formed entry and derives audited_sha from the arms\' runs', () => {
    const cls = classifyLogEntry({
      snapshotId: 's1', campaignId: 'camp', lockDigest: 'lock1', transcript: 't.json',
      arms: { opus: { runId: 'r1', costUsd: 1.5 }, kimi: { runId: 'r2', costUsd: 0.4 } },
    }, ctx);
    assert.equal(cls.eligible, true);
    assert.equal(cls.auditedSha, 'abc123');
    assert.deepEqual(cls.armRuns.map((a) => [a.armId, a.costStatus]), [['opus', 'priced'], ['kimi', 'priced']]);
  });

  it('an entry with no lockDigest is INELIGIBLE — never adopted into the current cohort', () => {
    // This is the five-false-greens rule: evidence collected under an unknown
    // contract cannot be relabelled into a cohort it was not produced under.
    const cls = classifyLogEntry({ snapshotId: 's1', campaignId: 'camp', arms: { opus: { runId: 'r1' } } }, ctx);
    assert.equal(cls.eligible, false);
    assert.match(cls.reason, /unknown contract/);
  });

  it('an entry under a SUPERSEDED lock is its own cohort, not this one', () => {
    const cls = classifyLogEntry({ snapshotId: 's1', campaignId: 'camp', lockDigest: 'oldlock', arms: { opus: { runId: 'r1' } } }, ctx);
    assert.equal(cls.eligible, false);
    assert.match(cls.reason, /superseded lock oldlock/);
  });

  it('arms disagreeing about the commit are not one snapshot', () => {
    const cls = classifyLogEntry({
      snapshotId: 's1', campaignId: 'camp', lockDigest: 'lock1',
      arms: { opus: { runId: 'r1' }, kimi: { runId: 'r3' } },
    }, ctx);
    assert.equal(cls.eligible, false);
    assert.match(cls.reason, /one snapshot is one revision/);
  });

  it('an unresolvable revision is ineligible, never promoted with a guessed sha', () => {
    const cls = classifyLogEntry({ snapshotId: 's1', campaignId: 'camp', lockDigest: 'lock1', arms: { opus: { runId: 'unknown' } } }, ctx);
    assert.equal(cls.eligible, false);
    assert.match(cls.reason, /unadjudicatable/);
  });

  it('a missing cost is UNPRICED, never 0 — an unrecorded charge must not read as free', () => {
    const cls = classifyLogEntry({
      snapshotId: 's1', campaignId: 'camp', lockDigest: 'lock1',
      arms: { opus: { runId: 'r1' }, kimi: { runId: 'r2', costUsd: 0 } },
    }, ctx);
    assert.deepEqual(cls.armRuns.map((a) => [a.armId, a.costUsd, a.costStatus]),
      [['opus', null, 'unpriced'], ['kimi', 0, 'priced']],
      'a genuinely measured 0 stays priced; an ABSENT cost is unpriced');
  });

  it('an errored arm still promotes, carrying its error — a silent gap is never allowed', () => {
    const cls = classifyLogEntry({
      snapshotId: 's1', campaignId: 'camp', lockDigest: 'lock1',
      arms: { opus: { runId: 'r1', costUsd: 1 }, kimi: { error: 'exit 1' } },
    }, ctx);
    assert.equal(cls.eligible, true);
    assert.equal(cls.armRuns.find((a) => a.armId === 'kimi').error, 'exit 1');
  });
});

// ── --force promotion (gap 2) ───────────────────────────────────────────────

describe('promotion attempt resolution (--force)', () => {
  it('first promotion is attempt 1 and supersedes nothing', () => {
    assert.deepEqual(resolvePromotionAttempts({ existingAttempt: 0, forced: false }),
      { skip: false, plans: [{ attempt: 1, supersedePrior: false }] });
  });

  it('re-running reconcile on an already-promoted arm SKIPS — idempotence, not a second charge', () => {
    assert.deepEqual(resolvePromotionAttempts({ existingAttempt: 1, forced: false }),
      { skip: true, plans: [] });
  });

  it('a FORCED re-collection appends attempt N+1 and supersedes the prior live row', () => {
    // Never an overwrite: the earlier attempt stays readable and its spend still
    // counts, which is exactly why armSpend sums superseded rows. Before --force
    // existed this branch was unreachable, so the attempt column, the partial
    // unique index and the receipt-attempt protocol were machinery no operator
    // action could trigger.
    assert.deepEqual(resolvePromotionAttempts({ existingAttempt: 1, forced: true }),
      { skip: false, plans: [{ attempt: 2, supersedePrior: true }] });
    assert.deepEqual(resolvePromotionAttempts({ existingAttempt: 4, forced: true }),
      { skip: false, plans: [{ attempt: 5, supersedePrior: true }] });
  });

  it('a garbage attempt count is treated as none, never as a negative attempt', () => {
    for (const bogus of [null, undefined, -3, NaN, 'two']) {
      assert.deepEqual(resolvePromotionAttempts({ existingAttempt: bogus, forced: true }),
        { skip: false, plans: [{ attempt: 1, supersedePrior: false }] });
    }
  });

  // ── several attempts inside ONE entry (automatic retry-on-timeout) ────────

  it('an entry carrying TWO attempts promotes both — the timed-out one is not free', () => {
    // The collector retries a timed-out arm automatically, so one log entry can
    // hold a superseded attempt and the live one. Promoting only the live one
    // would report a recovered arm as costing what a first-try arm cost.
    assert.deepEqual(resolvePromotionAttempts({ existingAttempt: 0, recordedAttempts: 2 }),
      { skip: false, plans: [{ attempt: 1, supersedePrior: false }, { attempt: 2, supersedePrior: true }] });
  });

  it('re-running reconcile over a 2-attempt entry SKIPS — still idempotent', () => {
    // The direction that must NOT fire: a second reconcile pass over an entry
    // already fully promoted must append nothing, or every run doubles the
    // arm's recorded spend.
    assert.deepEqual(resolvePromotionAttempts({ existingAttempt: 2, recordedAttempts: 2 }),
      { skip: true, plans: [] });
  });

  it('a reconcile interrupted halfway RESUMES at the missing attempt, tail-aligned', () => {
    // n < K is a resumable state, not an invisible one: attempt 1 is already
    // stored, so only attempt 2 is planned — and the caller drops the first
    // K - plans.length recorded attempts to match.
    assert.deepEqual(resolvePromotionAttempts({ existingAttempt: 1, recordedAttempts: 2 }),
      { skip: false, plans: [{ attempt: 2, supersedePrior: true }] });
  });

  it('a FORCED re-collection of a 2-attempt entry appends BOTH after everything stored', () => {
    assert.deepEqual(resolvePromotionAttempts({ existingAttempt: 2, recordedAttempts: 2, forced: true }),
      { skip: false, plans: [{ attempt: 3, supersedePrior: true }, { attempt: 4, supersedePrior: true }] });
  });

  it('a garbage recordedAttempts falls back to one attempt, never to zero rows', () => {
    // Zero planned rows would silently promote NOTHING for the arm, which reads
    // downstream as an arm that never ran rather than one we failed to record.
    for (const bogus of [null, undefined, 0, -2, NaN, 'two']) {
      assert.deepEqual(resolvePromotionAttempts({ existingAttempt: 0, recordedAttempts: bogus }),
        { skip: false, plans: [{ attempt: 1, supersedePrior: false }] });
    }
  });
});

describe('classifyLogEntry — superseded attempts survive into promotion', () => {
  const ctx = { campaignId: 'camp', lockDigest: 'lock1', shaByRunId: { r1: 'sha1', r0: 'sha0' } };

  it('projects each superseded attempt with its own run id and unpriced cost', () => {
    const cls = classifyLogEntry({
      snapshotId: 's1', campaignId: 'camp', lockDigest: 'lock1',
      arms: {
        qwen: {
          runId: 'r1', costUsd: 0.41,
          supersededAttempts: [{ attempt: 1, runId: 'r0', errorCategory: 'timeout', costUsd: null }],
        },
      },
    }, ctx);
    assert.equal(cls.eligible, true);
    const qwen = cls.armRuns.find((a) => a.armId === 'qwen');
    assert.equal(qwen.costStatus, 'priced');
    assert.equal(qwen.supersededAttempts.length, 1);
    assert.equal(qwen.supersededAttempts[0].auditRunId, 'r0');
    assert.equal(qwen.supersededAttempts[0].costStatus, 'unpriced');
    assert.equal(qwen.supersededAttempts[0].costUsd, null);
  });

  it('a superseded attempt at a DIFFERENT commit does not make the snapshot ineligible', () => {
    // The trap: a human-invoked retry can land days later at another HEAD, so
    // its superseded run legitimately carries a different audited_sha. Folding
    // that into the one-snapshot-one-revision check would punish the snapshot
    // for having been retried. The revision that must be single is the LIVE
    // attempt's — that is what adjudication verifies findings against.
    const cls = classifyLogEntry({
      snapshotId: 's1', campaignId: 'camp', lockDigest: 'lock1',
      arms: { qwen: { runId: 'r1', costUsd: 0.41, supersededAttempts: [{ attempt: 1, runId: 'r0', costUsd: null }] } },
    }, ctx);
    assert.equal(cls.eligible, true, 'r0 resolves sha0 and r1 sha1 — only the live one may count');
    assert.equal(cls.auditedSha, 'sha1');
  });

  it('an arm with no retry history projects an EMPTY superseded list, never a fabricated one', () => {
    const cls = classifyLogEntry({
      snapshotId: 's1', campaignId: 'camp', lockDigest: 'lock1', arms: { opus: { runId: 'r1', costUsd: 1 } },
    }, ctx);
    assert.deepEqual(cls.armRuns.find((a) => a.armId === 'opus').supersededAttempts, []);
  });
});

// ── per-arm retry promotion (D5) ────────────────────────────────────────────

describe('isArmRetried — the per-arm marker promotion actually keys on', () => {
  it('THE HEADLINE CASE: only the named arm reads as retried', () => {
    const entry = { retriedArmIds: ['grok'] };
    assert.equal(isArmRetried(entry, 'grok'), true);
    assert.equal(isArmRetried(entry, 'opus'), false, 'opus was carried forward unchanged and must not be re-promoted');
    assert.equal(isArmRetried(entry, 'kimi'), false);
  });

  it('a plain (non-retry) entry: no arm is retried', () => {
    assert.equal(isArmRetried({ arms: { opus: {} } }, 'opus'), false);
  });

  it('legacy whole-entry forced:true (pre-D5 log lines, no retriedArmIds field): every arm is retried', () => {
    // Before retriedArmIds existed, `forced: true` meant the WHOLE entry was
    // a re-collection — every arm present in it was, by definition, a retry.
    // A log line written before this change must promote exactly the same
    // way it always did.
    assert.equal(isArmRetried({ forced: true }, 'opus'), true);
    assert.equal(isArmRetried({ forced: true }, 'anyArmAtAll'), true);
  });

  it('NEGATIVE CONTROL: retriedArmIds present but empty means nothing is retried, even with legacy forced also set', () => {
    // retriedArmIds, when present, is authoritative — an explicit empty list
    // is a real fact ("this entry retried nothing"), not a reason to fall
    // back to the legacy blanket flag.
    assert.equal(isArmRetried({ forced: true, retriedArmIds: [] }, 'opus'), false);
  });

  it('a missing or malformed entry never throws and reads as not-retried', () => {
    assert.equal(isArmRetried(undefined, 'opus'), false);
    assert.equal(isArmRetried({}, 'opus'), false);
    assert.equal(isArmRetried({ retriedArmIds: 'not-an-array' }, 'opus'), false);
  });
});
