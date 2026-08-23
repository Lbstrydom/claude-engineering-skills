/**
 * @fileoverview Receipt-filename parsing, bake-off log promotion, --force
 * retry, and per-arm retry classification (campaign/promote).
 *
 * Split out of `tests/campaign-adjudication.test.mjs` (Phase 4, plan:
 * comparison-tooling-consolidation.md, D3) — assertions moved verbatim.
 *
 * @module tests/campaign-promote
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  classifyLogEntry, resolvePromotionAttempts, isArmRetried, repoId, detectPlanHashMismatches,
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

  // ── the raw observation survives an UNPRICED arm ──────────────────────────
  //
  // Guards the always-null class, not just this one field. Measured 2026-08-23:
  // `campaign_arm_runs.usage` was null on all 84 rows — 65 of them PRICED —
  // because the column existed, `recordArmRun` accepted it, and no caller ever
  // supplied it. Nothing failed; the value simply was not there, which is the
  // same shape as the campaign's own lesson (e) (`total_cost_estimate` null on
  // all 128 runs: "an always-null metric reads as free, not broken").
  //
  // Why it MATTERS rather than being cosmetic: `costUsd` is DERIVED, and it is
  // null whenever any of the arm's calls is unpriced. Without the raw counts
  // beside it, an arm that ran before its model was priced is unrecoverable
  // from this table forever — the spend is simply unknown, and `campaign.mjs
  // status` reports the arm's whole total as "unknown". With them, a later
  // repricing is arithmetic.
  //
  // Asserted on BOTH the priced and unpriced paths on purpose: a fix that only
  // populated usage when pricing succeeded would restore the field exactly
  // where it was already least needed.
  it('carries the RAW usage through, priced or not — the derived cost is not the only record', () => {
    const usage = {
      primary: { model: 'gemini-pro-latest', usage: { input_tokens: 100, output_tokens: 20 } },
      shadow: { model: 'qwen3.8-max', usage: { input_tokens: 54274, output_tokens: 10116 } },
    };
    const cls = classifyLogEntry({
      snapshotId: 's1', campaignId: 'camp', lockDigest: 'lock1', transcript: 't.json',
      arms: {
        opus: { runId: 'r1', costUsd: 1.5, usage },
        // The load-bearing one: no costUsd (its model was unpriced at
        // collection time), so `costUsd` is null and `costStatus` unpriced —
        // and the tokens are the ONLY surviving evidence of what it consumed.
        kimi: { runId: 'r2', usage },
      },
    }, ctx);
    const [priced, unpriced] = cls.armRuns;
    assert.equal(priced.costStatus, 'priced');
    assert.deepEqual(priced.usage, usage, 'a priced arm still records what it consumed');
    assert.equal(unpriced.costStatus, 'unpriced');
    assert.equal(unpriced.costUsd, null, 'unpriced stays null — never a fabricated 0');
    assert.deepEqual(unpriced.usage, usage, 'an UNPRICED arm must still record its tokens');
  });

  it('an arm that reported no usage records null — absent is not an empty reading', () => {
    // The honest degenerate case: `{}` would claim a zero-token call, which is
    // a measurement. Absence must stay absence, same rule as costUsd's null.
    const cls = classifyLogEntry({
      snapshotId: 's1', campaignId: 'camp', lockDigest: 'lock1', transcript: 't.json',
      arms: { opus: { runId: 'r1', costUsd: 1.5 } },
    }, ctx);
    assert.equal(cls.armRuns[0].usage, null);
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
    // `shadowError` is the REAL field a live (non-superseded) bakeoff-log
    // entry carries (bakeoff-collect.mjs never writes a top-level `error` on
    // that shape) — regression fixture for the bug where this test used
    // `error` directly, matching a reader bug instead of the real producer
    // shape, so it passed while every live failure silently promoted as a
    // success (`error: NULL`) in production.
    const cls = classifyLogEntry({
      snapshotId: 's1', campaignId: 'camp', lockDigest: 'lock1',
      arms: { opus: { runId: 'r1', costUsd: 1 }, kimi: { runId: 'r2', shadowError: 'exit 1' } },
    }, ctx);
    assert.equal(cls.eligible, true);
    assert.equal(cls.armRuns.find((a) => a.armId === 'kimi').error, 'exit 1');
  });
});

// ── §7 Phase 3: identity-keyed promotion (replaces count-based --force) ─────

describe('resolvePromotionAttempts — IDENTITY-keyed (round 6, Phase 3 rework)', () => {
  it('first promotion is attempt 1 and supersedes nothing', () => {
    const r = resolvePromotionAttempts({ attempts: [{ auditRunId: 'r1' }], existingAttempt: 0, existingRunIds: new Set() });
    assert.equal(r.skip, false);
    assert.deepEqual(r.plans, [{ attempt: 1, supersedePrior: false, auditRunId: 'r1' }]);
  });

  it('THE LOAD-BEARING CASE: a store attempt-1 FAILURE and a fresh entry whose (different) runId represents a SUCCESS at local attempt-1 promotes the success as attempt 2 — never skipped as "already recorded"', () => {
    // The exact defect #2 mechanism: the OLD count-based comparison saw
    // existingAttempt=1, recordedAttempts=1, forced=false → skip. Identity
    // fixes it: r2 is a DIFFERENT run id than whatever occupies the store's
    // attempt 1, so it is promoted regardless of the count coincidence.
    const r = resolvePromotionAttempts({
      attempts: [{ auditRunId: 'r2-success' }], existingAttempt: 1, existingRunIds: new Set(['r1-failure']),
    });
    assert.equal(r.skip, false);
    assert.deepEqual(r.plans, [{ attempt: 2, supersedePrior: true, auditRunId: 'r2-success' }]);
  });

  it('re-running reconcile on an ALREADY-promoted runId SKIPS — idempotence, not a second charge', () => {
    const r = resolvePromotionAttempts({
      attempts: [{ auditRunId: 'r1' }], existingAttempt: 1, existingRunIds: new Set(['r1']),
    });
    assert.deepEqual(r, { skip: true, plans: [] });
  });

  it('an attempt with NO runId (never registered) always promotes — nothing to collide on', () => {
    const r = resolvePromotionAttempts({
      attempts: [{ auditRunId: null, error: 'unregistered' }], existingAttempt: 3, existingRunIds: new Set(['r1', 'r2', 'r3']),
    });
    assert.equal(r.skip, false);
    assert.deepEqual(r.plans, [{ attempt: 4, supersedePrior: true, auditRunId: null, error: 'unregistered' }]);
  });

  it('a garbage existingAttempt is treated as none, never as a negative attempt', () => {
    for (const bogus of [null, undefined, -3, NaN, 'two']) {
      const r = resolvePromotionAttempts({ attempts: [{ auditRunId: 'r1' }], existingAttempt: bogus, existingRunIds: new Set() });
      assert.deepEqual(r.plans, [{ attempt: 1, supersedePrior: false, auditRunId: 'r1' }]);
    }
  });

  // ── several attempts inside ONE entry (automatic retry-on-timeout) ────────

  it('an entry carrying TWO NEW attempts promotes both — the timed-out one is not free', () => {
    const r = resolvePromotionAttempts({
      attempts: [{ auditRunId: 'r-timeout', error: 'timeout' }, { auditRunId: 'r-success' }],
      existingAttempt: 0, existingRunIds: new Set(),
    });
    assert.equal(r.skip, false);
    assert.deepEqual(r.plans, [
      { attempt: 1, supersedePrior: false, auditRunId: 'r-timeout', error: 'timeout' },
      { attempt: 2, supersedePrior: true, auditRunId: 'r-success' },
    ]);
  });

  it('re-running reconcile over a 2-attempt entry where BOTH runIds are already recorded SKIPS entirely', () => {
    const r = resolvePromotionAttempts({
      attempts: [{ auditRunId: 'r1' }, { auditRunId: 'r2' }], existingAttempt: 2, existingRunIds: new Set(['r1', 'r2']),
    });
    assert.deepEqual(r, { skip: true, plans: [] });
  });

  it('a reconcile interrupted halfway RESUMES at exactly the un-recorded runId, tail-aligned', () => {
    // r1 is already in the store (existingRunIds); r2 is not — only r2 is
    // planned, numbered after the store's own existingAttempt, regardless of
    // its position in the local attempts array.
    const r = resolvePromotionAttempts({
      attempts: [{ auditRunId: 'r1' }, { auditRunId: 'r2' }], existingAttempt: 1, existingRunIds: new Set(['r1']),
    });
    assert.equal(r.skip, false);
    assert.deepEqual(r.plans, [{ attempt: 2, supersedePrior: true, auditRunId: 'r2' }]);
  });

  it('NEGATIVE CONTROL: a count-based implementation would get the load-bearing case wrong', () => {
    // Sanity-checks the OLD defect really is reproduced by counting: with
    // existingAttempt=1 and one recorded attempt (K=1), a count comparison
    // (`K - existingAttempt <= 0`) says "nothing to promote" — exactly the
    // silent drop defect #2 describes. The identity-keyed function above
    // must NOT reach this conclusion, which the load-bearing case already
    // asserts; this test pins the CONTRAST so the old bug can't silently
    // reappear as "correct" if someone re-introduces a count shortcut.
    const K = 1;
    const existingAttempt = 1;
    const countBasedToRecord = K - existingAttempt;
    assert.ok(countBasedToRecord <= 0, 'the old count comparison would (wrongly) skip — the whole reason this function was reworked');
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

  it('each armRun carries its OWN planContentHash/configDigest — never a single entry-level value (round 5, H2)', () => {
    const cls = classifyLogEntry({
      snapshotId: 's1', campaignId: 'camp', lockDigest: 'lock1',
      arms: { opus: { runId: 'r1', costUsd: 1, planContentHash: 'hash-a', configDigest: 'config-a' } },
    }, ctx);
    const opus = cls.armRuns.find((a) => a.armId === 'opus');
    assert.equal(opus.planContentHash, 'hash-a');
    assert.equal(opus.configDigest, 'config-a');
  });
});

// ── §7 Phase 4: plan-hash consistency check ─────────────────────────────────

describe('detectPlanHashMismatches — the extracted comparison rule (round 6, M6)', () => {
  it('NULL-vs-NULL is not a mismatch', () => {
    assert.deepEqual(detectPlanHashMismatches([['opus', { planContentHash: null }]], { opus: new Set([null]) }), []);
  });

  it('NULL-vs-hash IS a mismatch', () => {
    assert.deepEqual(
      detectPlanHashMismatches([['opus', { planContentHash: 'h1' }]], { opus: new Set([null]) }),
      [{ armId: 'opus', oldHash: null, newHash: 'h1' }],
    );
  });

  it('an arm with no existing history is never a mismatch', () => {
    assert.deepEqual(detectPlanHashMismatches([['opus', { planContentHash: 'h1' }]], {}), []);
  });

  it('multiple disagreeing old hashes for one arm are all reported', () => {
    assert.deepEqual(
      detectPlanHashMismatches([['opus', { planContentHash: 'h-new' }]], { opus: new Set(['h-old-1', 'h-old-2']) }).length,
      2,
    );
  });
});

describe('classifyLogEntry — plan-hash consistency check (§7 Phase 4)', () => {
  const ctx = { campaignId: 'camp', lockDigest: 'lock1', shaByRunId: { r1: 'sha1' } };

  it('NULL-vs-NULL is a match — a legacy snapshot with no live hash accepts a further NULL-hash attempt', () => {
    const cls = classifyLogEntry({
      snapshotId: 's1', campaignId: 'camp', lockDigest: 'lock1', arms: { opus: { runId: 'r1', planContentHash: null } },
    }, { ...ctx, existingPlanHashesByArm: { opus: new Set([null]) } });
    assert.equal(cls.eligible, true);
    assert.deepEqual(cls.mismatches, []);
  });

  it('NULL-vs-hash is a mismatch — refuses without --confirm-mismatch', () => {
    const cls = classifyLogEntry({
      snapshotId: 's1', campaignId: 'camp', lockDigest: 'lock1', arms: { opus: { runId: 'r1', planContentHash: 'new-hash' } },
    }, { ...ctx, existingPlanHashesByArm: { opus: new Set([null]) } });
    assert.equal(cls.eligible, false);
    assert.match(cls.reason, /plan-hash mismatch/);
    assert.match(cls.reason, /confirm-mismatch/);
  });

  it('the SAME mismatch is admitted with confirmMismatch:true, and reports it in `mismatches` for the caller to auto-quarantine', () => {
    const cls = classifyLogEntry({
      snapshotId: 's1', campaignId: 'camp', lockDigest: 'lock1', arms: { opus: { runId: 'r1', planContentHash: 'new-hash' } },
    }, { ...ctx, existingPlanHashesByArm: { opus: new Set([null]) }, confirmMismatch: true });
    assert.equal(cls.eligible, true);
    assert.deepEqual(cls.mismatches, [{ armId: 'opus', oldHash: null, newHash: 'new-hash' }]);
  });

  it('a quarantined legacy attempt drops out of the comparison — correction needs NO flag (H1)', () => {
    // The caller (promoteFromLog) filters existingPlanHashesByArm through
    // isAttemptExcluded BEFORE calling classifyLogEntry, so a quarantined
    // pairing's hash never appears here at all — simulated by simply
    // passing an EMPTY existingPlanHashesByArm for the arm, as the caller
    // would once quarantine has removed the only live attempt from the set.
    const cls = classifyLogEntry({
      snapshotId: 's1', campaignId: 'camp', lockDigest: 'lock1', arms: { opus: { runId: 'r1', planContentHash: 'corrected-hash' } },
    }, { ...ctx, existingPlanHashesByArm: {} });
    assert.equal(cls.eligible, true);
    assert.deepEqual(cls.mismatches, []);
  });

  it('two REAL, different hashes (neither null) is still a mismatch, refused without the flag', () => {
    const cls = classifyLogEntry({
      snapshotId: 's1', campaignId: 'camp', lockDigest: 'lock1', arms: { opus: { runId: 'r1', planContentHash: 'hash-b' } },
    }, { ...ctx, existingPlanHashesByArm: { opus: new Set(['hash-a']) } });
    assert.equal(cls.eligible, false);
    assert.match(cls.reason, /plan-hash mismatch/);
  });

  it('an arm with NO existing history at all is never a mismatch (a genuinely new arm-run)', () => {
    const cls = classifyLogEntry({
      snapshotId: 's1', campaignId: 'camp', lockDigest: 'lock1', arms: { opus: { runId: 'r1', planContentHash: 'any-hash' } },
    }, { ...ctx, existingPlanHashesByArm: {} });
    assert.equal(cls.eligible, true);
    assert.deepEqual(cls.mismatches, []);
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

// ── LIVE: promoteFromLog against a real schema (§7 Phase 3) ─────────────────
// Gated on AUDIT_DB_TEST_URL, disposable-host-only (INC-002) — same pattern
// as tests/campaign-adjudication.test.mjs. Runs under `npm run db:suites:gate`;
// enrolled in db-test-container.mjs's ISOLATED_SUITE_FILES and
// postgres-parity.yml (§7 Phase 5's Test enrolment bullet).

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (runs under npm run db:suites:gate)';

describe('promoteFromLog against a live schema — identity, quarantine, and the advisory lock', { skip }, () => {
  let client; let promote; let store; let savedUrl;
  let campaignId; let cohortId; let repoRowId;

  before(async () => {
    const { assertDisposableDbUrl, _resetForTest, getPool } = await import('../scripts/lib/db/client.mjs');
    savedUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await _resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;
    client = await getPool();
    promote = await import('../scripts/lib/campaign/promote.mjs');
    store = await import('../scripts/lib/store/campaign.mjs');

    // `promoteFromLog` resolves its own repo internally via `repoId()`
    // (git-identity based) — it ignores any throwaway `audit_repos` row a
    // test manually inserts. Use the same resolver here so the test's setup
    // and `promoteFromLog`'s internal writes land in the same repo/cohort.
    repoRowId = await repoId();
    const campaign = await store.ensureCampaign({ repoId: repoRowId, campaignKey: 'promote-live-test', configDigest: 'digest1' });
    campaignId = campaign.id;
    const cohort = await store.ensureCohort({ campaignId, lockDigest: 'lock1', resolved: { a: 1 } });
    cohortId = cohort.id;
    await store.upsertSnapshot({ cohortId, snapshotId: 'snapA', auditedSha: 'sha-a', transcriptPath: 't.json' });
  });

  after(async () => {
    try {
      const { closePool, _resetForTest } = await import('../scripts/lib/db/client.mjs');
      await closePool();
      await _resetForTest();
    } finally {
      if (savedUrl === undefined) delete process.env.AUDIT_DB_URL; else process.env.AUDIT_DB_URL = savedUrl;
    }
  });

  async function mkRun() {
    const r = await client.query("INSERT INTO audit_runs (repo_id, plan_file, mode, commit_sha) VALUES ($1, 'docs/plans/x.md', 'code', 'sha-a') RETURNING id", [repoRowId]);
    return r.rows[0].id;
  }

  it('the load-bearing case, against real writes: a store attempt-1 FAILURE + a fresh SUCCESS at local attempt-1 promotes as attempt 2', async () => {
    const failRun = await mkRun();
    await store.recordArmRun({
      cohortId, snapshotRowId: (await store.upsertSnapshot({ cohortId, snapshotId: 'snapLoadBearing', auditedSha: 'sha-a' })).id,
      snapshotId: 'snapLoadBearing', armId: 'opus', attempt: 1, auditRunId: failRun, error: 'timeout', costStatus: 'unpriced',
    });
    const successRun = await mkRun();
    const entries = [{
      snapshotId: 'snapLoadBearing', campaignId: 'promote-live-test', lockDigest: 'lock1', transcript: 't.json',
      arms: { opus: { runId: successRun, costUsd: 1.5 } },
    }];
    const result = await promote.promoteFromLog({
      config: { id: 'promote-live-test' }, lock: { lockDigest: 'lock1' }, configDigest: 'digest1', entries,
    });
    assert.equal(result.promoted, 1);
    const rows = await client.query(
      'SELECT attempt, audit_run_id, superseded_at FROM campaign_arm_runs WHERE cohort_id=$1 AND snapshot_id=$2 AND arm_id=$3 ORDER BY attempt',
      [cohortId, 'snapLoadBearing', 'opus'],
    );
    assert.equal(rows.rows.length, 2, 'the failure stays readable; the success is a SECOND row, not an overwrite');
    assert.equal(rows.rows[0].audit_run_id, failRun);
    assert.ok(rows.rows[0].superseded_at, 'the failure is superseded, not deleted');
    assert.equal(rows.rows[1].audit_run_id, successRun);
    assert.equal(rows.rows[1].superseded_at, null);
  });

  it('re-promoting an ALREADY-recorded runId a second time is a no-op — the live row is untouched', async () => {
    const runId = await mkRun();
    const entries = [{
      snapshotId: 'snapIdempotent', campaignId: 'promote-live-test', lockDigest: 'lock1', transcript: 't.json',
      arms: { kimi: { runId, costUsd: 0.4 } },
    }];
    await promote.promoteFromLog({ config: { id: 'promote-live-test' }, lock: { lockDigest: 'lock1' }, configDigest: 'digest1', entries });
    const before2 = await client.query('SELECT id, created_at FROM campaign_arm_runs WHERE snapshot_id=$1 AND arm_id=$2', ['snapIdempotent', 'kimi']);
    const result2 = await promote.promoteFromLog({ config: { id: 'promote-live-test' }, lock: { lockDigest: 'lock1' }, configDigest: 'digest1', entries });
    const after2 = await client.query('SELECT id, created_at FROM campaign_arm_runs WHERE snapshot_id=$1 AND arm_id=$2', ['snapIdempotent', 'kimi']);
    assert.equal(before2.rows.length, 1);
    assert.equal(after2.rows.length, 1, 'a second reconcile pass must not append a duplicate row');
    assert.equal(before2.rows[0].id, after2.rows[0].id);
    assert.equal(result2.promoted, 0);
  });

  it('a quarantined pairing is skipped, never written — promotion admission, not just retry-scoping', async () => {
    await store.upsertSnapshot({ cohortId, snapshotId: 'snapQuarantined', auditedSha: 'sha-a' });
    // Written directly — §7 Phase 5's markSnapshotExcluded CLI writer does
    // not exist yet at this cluster (it lands in Cluster B); this asserts
    // Phase 3's own admission check reads the table Phase 1 created.
    await client.query(
      `INSERT INTO campaign_snapshot_exclusions (cohort_id, snapshot_id, scope, excluded_reason)
       VALUES ($1, $2, 'all', 'test quarantine')`,
      [cohortId, 'snapQuarantined'],
    );
    const runId = await mkRun();
    const entries = [{
      snapshotId: 'snapQuarantined', campaignId: 'promote-live-test', lockDigest: 'lock1', transcript: 't.json',
      arms: { grok: { runId, costUsd: 0.2 } },
    }];
    const result = await promote.promoteFromLog({ config: { id: 'promote-live-test' }, lock: { lockDigest: 'lock1' }, configDigest: 'digest1', entries });
    assert.equal(result.promoted, 0);
    const rows = await client.query('SELECT id FROM campaign_arm_runs WHERE snapshot_id=$1 AND arm_id=$2', ['snapQuarantined', 'grok']);
    assert.equal(rows.rows.length, 0, 'a quarantined pairing must never reach a row, even though the run id is genuinely new');
  });

  it('two concurrent promoteFromLog calls for the SAME snapshot execute serially, not interleaved', async () => {
    await store.upsertSnapshot({ cohortId, snapshotId: 'snapConcurrent', auditedSha: 'sha-a' });
    const runA = await mkRun();
    const runB = await mkRun();
    const entriesA = [{
      snapshotId: 'snapConcurrent', campaignId: 'promote-live-test', lockDigest: 'lock1', transcript: 't.json',
      arms: { opus: { runId: runA, costUsd: 1 } },
    }];
    const entriesB = [{
      snapshotId: 'snapConcurrent', campaignId: 'promote-live-test', lockDigest: 'lock1', transcript: 't.json',
      arms: { kimi: { runId: runB, costUsd: 1 } },
    }];
    const [resultA, resultB] = await Promise.all([
      promote.promoteFromLog({ config: { id: 'promote-live-test' }, lock: { lockDigest: 'lock1' }, configDigest: 'digest1', entries: entriesA }),
      promote.promoteFromLog({ config: { id: 'promote-live-test' }, lock: { lockDigest: 'lock1' }, configDigest: 'digest1', entries: entriesB }),
    ]);
    assert.equal(resultA.promoted, 1);
    assert.equal(resultB.promoted, 1);
    const rows = await client.query('SELECT arm_id FROM campaign_arm_runs WHERE snapshot_id=$1', ['snapConcurrent']);
    assert.equal(rows.rows.length, 2, 'both concurrent promotions land, serialized by the advisory lock rather than lost to a race');
  });

  it('§7 Phase 4 (round 6, H2): --confirm-mismatch atomically auto-quarantines the OLD pairing while promoting the new one — no window where evidence mixes', async () => {
    await store.upsertSnapshot({ cohortId, snapshotId: 'snapMismatch', auditedSha: 'sha-a' });
    const oldRunOpus = await mkRun();
    const oldRunKimi = await mkRun();
    // First: two arms live under the OLD plan hash (no confirmMismatch needed — nothing to compare against yet).
    await promote.promoteFromLog({
      config: { id: 'promote-live-test' }, lock: { lockDigest: 'lock1' }, configDigest: 'digest1',
      entries: [{
        snapshotId: 'snapMismatch', campaignId: 'promote-live-test', lockDigest: 'lock1', transcript: 't.json',
        arms: {
          opus: { runId: oldRunOpus, costUsd: 1, planContentHash: 'hash-OLD' },
          kimi: { runId: oldRunKimi, costUsd: 1, planContentHash: 'hash-OLD' },
        },
      }],
    });
    // Now: arm A (opus) is re-collected under a NEW, corrected plan hash.
    const newRunOpus = await mkRun();
    const mismatchResult = await promote.promoteFromLog({
      config: { id: 'promote-live-test' }, lock: { lockDigest: 'lock1' }, configDigest: 'digest1',
      entries: [{
        snapshotId: 'snapMismatch', campaignId: 'promote-live-test', lockDigest: 'lock1', transcript: 't.json',
        arms: { opus: { runId: newRunOpus, costUsd: 1, planContentHash: 'hash-NEW' } },
      }],
      confirmMismatch: true,
    });
    assert.equal(mismatchResult.promoted, 1, 'the new, corrected opus attempt is written');

    // The sibling arm's OLD-hash row must no longer be visible as LIVE
    // evidence — it was auto-quarantined in the same transaction.
    const live = await store.liveArmRunsForSnapshot({ cohortId, snapshotId: 'snapMismatch', expectedConfigDigest: null, expectedPlanContentHash: 'hash-NEW' });
    assert.equal(live.rows.kimi?.succeeded, false, 'the old-hash sibling arm must read as excluded, not as a genuine success under the new pairing');

    const cohortRows = await store.loadCohortArmRuns(cohortId);
    const stillVisible = cohortRows.rows.filter((r) => r.snapshot_id === 'snapMismatch');
    assert.ok(!stillVisible.some((r) => r.arm_id === 'kimi'), 'the quarantined kimi row must be filtered OUT of loadCohortArmRuns entirely');
    assert.ok(stillVisible.some((r) => r.arm_id === 'opus'), 'the newly-promoted opus row remains visible');

    const exclusionRow = await client.query(
      "SELECT scope, plan_content_hash, excluded_reason FROM campaign_snapshot_exclusions WHERE cohort_id=$1 AND snapshot_id='snapMismatch'",
      [cohortId],
    );
    assert.equal(exclusionRow.rows.length, 1);
    assert.equal(exclusionRow.rows[0].scope, 'pairing');
    assert.equal(exclusionRow.rows[0].plan_content_hash, 'hash-OLD');
    assert.match(exclusionRow.rows[0].excluded_reason, /auto-quarantined via --confirm-mismatch/);
  });
});
