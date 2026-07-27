/**
 * @fileoverview Phase 6 promote-CLI tests.
 *
 * Covers:
 *   - parseArgs flag set
 *   - reconcilePromotionJournal: finalised entries deleted; db-committed
 *     entries complete the rename; pending entries roll back the .tmp
 *   - Two-phase commit: pending stage written before .tmp write; transition
 *     to db-committed before the rename; finalised then deleted
 *   - --help short-circuits
 *
 * The end-to-end promote loop (DB UPDATE) is integration-tested separately;
 * here we exercise the journal reconciliation logic which is the hard part.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseArgs,
  reconcilePromotionJournal,
  promoteCandidates,
  _internals,
  EXIT,
  interpretCandidateListResult,
  evaluateCandidateListOutcome,
  interpretShipEventResult,
  interpretPromoteRegressionSpecResult,
} from '../scripts/persona-consistency-promote.mjs';

// ────────────────────────────────────────────────────────────────────────────
// Failure-contract refactor (docs/plans/refactor-failure-contract.md,
// Cluster B) — pure interpreter regression locks
// ────────────────────────────────────────────────────────────────────────────

describe('interpretCandidateListResult', () => {
  it('a genuine success with candidates passes through', () => {
    assert.deepEqual(
      interpretCandidateListResult({ ok: true, candidates: [{ id: 'a' }] }),
      { ok: true, candidates: [{ id: 'a' }] },
    );
  });

  it('a genuine cloud-off empty result is legitimate, not a failure', () => {
    assert.deepEqual(
      interpretCandidateListResult({ ok: true, cloud: false, candidates: [] }),
      { ok: true, candidates: [] },
    );
  });

  it('a real dependency failure never comes back as an empty ok:true-shaped list (Defect 3)', () => {
    const r = interpretCandidateListResult({ ok: false, error: 'DB down', code: 'EXCEPTION' });
    assert.equal(r.ok, false);
    assert.equal(r.message, 'DB down');
  });

  it('a malformed successful response (missing or non-array candidates) is a protocol violation, not empty (round-1 finding M1)', () => {
    assert.equal(interpretCandidateListResult({ ok: true }).ok, false);
    assert.equal(interpretCandidateListResult({ ok: true, candidates: 'oops' }).ok, false);
  });

  it('a malformed top-level envelope never throws — round-2 fix M2', () => {
    for (const bad of [null, [], 'oops', 42, { ok: 'true' }]) {
      const r = interpretCandidateListResult(bad);
      assert.equal(r.ok, false);
      assert.match(r.message, /invalid response envelope/);
    }
  });
});

describe('evaluateCandidateListOutcome', () => {
  it('a dependency failure yields DEPENDENCY_FAILURE, not zero (round-1 finding M2)', () => {
    const outcome = evaluateCandidateListOutcome({ ok: false, message: 'DB down' });
    assert.equal(outcome.shouldContinue, false);
    assert.equal(outcome.exitCode, EXIT.DEPENDENCY_FAILURE);
    assert.match(outcome.message, /DB down/);
  });

  it('a genuinely empty candidate list yields EXIT.OK', () => {
    const outcome = evaluateCandidateListOutcome({ ok: true, candidates: [] });
    assert.deepEqual(outcome, { shouldContinue: false, exitCode: EXIT.OK, message: 'No pending consistency candidates.' });
  });

  it('a non-empty candidate list continues', () => {
    const outcome = evaluateCandidateListOutcome({ ok: true, candidates: [{ id: 'a' }] });
    assert.deepEqual(outcome, { shouldContinue: true, candidates: [{ id: 'a' }] });
  });
});

describe('interpretShipEventResult', () => {
  it('a genuine cloud-off event is the legitimate case the old buggy guard was supposedly protecting — must keep working', () => {
    assert.deepEqual(interpretShipEventResult({ ok: true, cloud: false }), { ok: true, cloud: false });
  });

  it('a genuine cloud-on success passes through', () => {
    assert.deepEqual(interpretShipEventResult({ ok: true, cloud: true }), { ok: true, cloud: true });
  });

  it('a real failure never reads as {ok:true} (Defect 4 — the actual regression lock)', () => {
    const r = interpretShipEventResult({ ok: false, error: 'EXCEPTION: db timeout' });
    assert.equal(r.ok, false);
    assert.equal(r.message, 'EXCEPTION: db timeout');
  });

  it('ok:true with a missing or non-boolean cloud field is a protocol violation (round-2 finding M1)', () => {
    assert.equal(interpretShipEventResult({ ok: true }).ok, false);
    assert.equal(interpretShipEventResult({ ok: true, cloud: 'false' }).ok, false);
    assert.equal(interpretShipEventResult({ ok: true, cloud: null }).ok, false);
  });

  it('a malformed top-level envelope never throws — round-2 fix M2', () => {
    for (const bad of [null, [], 'oops', 42, { ok: 'true' }]) {
      const r = interpretShipEventResult(bad);
      assert.equal(r.ok, false);
      assert.match(r.message, /invalid response envelope/);
    }
  });
});

describe('interpretPromoteRegressionSpecResult (round-4 fix da923982)', () => {
  it('a genuine success passes through unchanged', () => {
    assert.deepEqual(interpretPromoteRegressionSpecResult({ ok: true, rowsAffected: 3 }), { ok: true, rowsAffected: 3 });
  });

  it('a genuine failure passes through unchanged (behavior-preserving)', () => {
    assert.deepEqual(
      interpretPromoteRegressionSpecResult({ ok: false, error: 'DB down' }),
      { ok: false, rowsAffected: 0, error: 'DB down' },
    );
  });

  it('a malformed top-level envelope never throws — closes this file\'s third, previously-unguarded callCrossSkill consumer', () => {
    for (const bad of [null, [], 'oops']) {
      const r = interpretPromoteRegressionSpecResult(bad);
      assert.equal(r.ok, false);
      assert.equal(r.rowsAffected, 0);
      assert.match(r.error, /invalid response envelope/);
    }
  });

  it('{ok:true, rowsAffected:0} (a genuine number) passes through as-is — the interpreter never second-guesses a zero-row success (round-1 finding ecf391e6)', () => {
    // A Postgres UPDATE blocked by RLS, or a candidate that stopped
    // matching between listing and promotion, can legitimately produce a
    // successful command response with rowsAffected:0. This interpreter's
    // job is only to distinguish a well-formed response from a malformed
    // one — treating a zero-row success as a FAILURE is promoteOne's own
    // job (its existing, unchanged `!updateResult.ok ||
    // updateResult.rowsAffected === 0` check, a few lines below its call
    // to promoteRegressionSpecViaCli).
    assert.deepEqual(
      interpretPromoteRegressionSpecResult({ ok: true, rowsAffected: 0 }),
      { ok: true, rowsAffected: 0 },
    );
  });

  it('a non-integer rowsAffected on an ok:true response is a protocol violation, never silently passed through (round-2 finding c014fb2a)', () => {
    // The actual bug this locks in: `parsed.rowsAffected || 0` (the round-1
    // fix) let a STRING '0' pass through as-is (truthy in JS), and
    // promoteOne's strict `=== 0` guard would then fail to catch it
    // ('0' === 0 is false) — a zero-row DB write could silently proceed as
    // a reported success.
    for (const bad of ['0', '3', null, undefined, 1.5, -1, {}, [], true]) {
      const r = interpretPromoteRegressionSpecResult({ ok: true, rowsAffected: bad });
      assert.equal(r.ok, false, `rowsAffected=${JSON.stringify(bad)} must be rejected, never treated as a valid success`);
      assert.equal(r.rowsAffected, 0);
      assert.match(r.error, /protocol violation/);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// parseArgs
// ────────────────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('reads --auto', () => {
    assert.equal(parseArgs(['--auto']).auto, true);
  });
  it('reads --since', () => {
    assert.equal(parseArgs(['--since', '2026-05-20T00:00:00Z']).since, '2026-05-20T00:00:00Z');
  });
  it('reads --repo-root + --out', () => {
    const a = parseArgs(['--repo-root', '/tmp/x', '--out', 'r.json']);
    assert.equal(a.repoRoot, '/tmp/x');
    assert.equal(a.out, 'r.json');
  });
  it('defaults: auto=false, since=null', () => {
    const a = parseArgs([]);
    assert.equal(a.auto, false);
    assert.equal(a.since, null);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// reconcilePromotionJournal
// ────────────────────────────────────────────────────────────────────────────

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function writeJournalEntry(specId, entry) {
  const dir = path.join(tmpDir, _internals.JOURNAL_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${specId}.json`), JSON.stringify(entry));
}

function journalExists(specId) {
  return fs.existsSync(path.join(tmpDir, _internals.JOURNAL_DIR, `${specId}.json`));
}

describe('reconcilePromotionJournal', () => {
  it('returns counts of 0/0 when the journal dir is missing', async () => {
    const r = await reconcilePromotionJournal(tmpDir);
    assert.deepEqual(r, { recovered: 0, rolledBack: 0 });
  });

  it('returns 0/0 when the journal dir is empty', async () => {
    fs.mkdirSync(path.join(tmpDir, _internals.JOURNAL_DIR), { recursive: true });
    const r = await reconcilePromotionJournal(tmpDir);
    assert.deepEqual(r, { recovered: 0, rolledBack: 0 });
  });

  it('deletes "finalised" stage entries (already committed; janitor work)', async () => {
    writeJournalEntry('spec-1', { stage: 'finalised', specId: 'spec-1' });
    const r = await reconcilePromotionJournal(tmpDir);
    assert.deepEqual(r, { recovered: 0, rolledBack: 0 });
    assert.equal(journalExists('spec-1'), false);
  });

  it('"db-committed" → completes the rename when .tmp exists and final does not', async () => {
    const e2eDir = path.join(tmpDir, _internals.E2E_DIR);
    fs.mkdirSync(e2eDir, { recursive: true });
    const tmpPath   = path.join(e2eDir, 'spec-1.spec.js.tmp');
    const finalPath = path.join(e2eDir, 'spec-1.spec.js');
    fs.writeFileSync(tmpPath, '// generated body');
    writeJournalEntry('spec-1', {
      stage: 'db-committed',
      specId: 'spec-1',
      tmpPath, intendedPath: finalPath,
    });

    const r = await reconcilePromotionJournal(tmpDir);
    assert.equal(r.recovered, 1);
    assert.equal(journalExists('spec-1'), false);
    assert.equal(fs.existsSync(tmpPath), false);
    assert.ok(fs.existsSync(finalPath));
  });

  it('"db-committed" with both .tmp and final present → leaves files alone (journal cleared)', async () => {
    const e2eDir = path.join(tmpDir, _internals.E2E_DIR);
    fs.mkdirSync(e2eDir, { recursive: true });
    const tmpPath   = path.join(e2eDir, 'spec-2.spec.js.tmp');
    const finalPath = path.join(e2eDir, 'spec-2.spec.js');
    fs.writeFileSync(tmpPath,   '// orphan');
    fs.writeFileSync(finalPath, '// good');
    writeJournalEntry('spec-2', {
      stage: 'db-committed',
      specId: 'spec-2',
      tmpPath, intendedPath: finalPath,
    });

    await reconcilePromotionJournal(tmpDir);
    assert.equal(journalExists('spec-2'), false);
    assert.equal(fs.readFileSync(finalPath, 'utf-8'), '// good',
      'final file should not be overwritten on reconcile');
  });

  it('"pending" without DB access → LEAVES the entry untouched (Gemini-final-G1)', async () => {
    // Cloud disabled in test env → reconcile can't disambiguate
    // "DB never committed" from "DB committed but journal not updated".
    // Per G1 fix, the safe action is to leave the journal alone and let
    // a future reconcile with DB access decide. The .tmp file also
    // stays — destroying it without DB confirmation could corrupt a
    // committed promotion.
    const e2eDir = path.join(tmpDir, _internals.E2E_DIR);
    fs.mkdirSync(e2eDir, { recursive: true });
    const tmpPath   = path.join(e2eDir, 'spec-3.spec.js.tmp');
    const finalPath = path.join(e2eDir, 'spec-3.spec.js');
    fs.writeFileSync(tmpPath, '// uncertain');
    writeJournalEntry('spec-3', {
      stage: 'pending',
      specId: 'spec-3',
      tmpPath, intendedPath: finalPath,
      candidateFingerprint: 'fp-deadbeef',
    });

    const r = await reconcilePromotionJournal(tmpDir);
    assert.equal(r.rolledBack, 0, 'cannot roll back without DB confirmation');
    assert.equal(r.recovered, 0);
    assert.equal(journalExists('spec-3'), true,  'entry must remain for future reconcile');
    assert.equal(fs.existsSync(tmpPath), true,   '.tmp must remain — could be a committed-but-unrenamed spec');
    assert.equal(fs.existsSync(finalPath), false);
  });

  it('"pending" with no .tmp file: same — leave for future reconcile (no DB)', async () => {
    writeJournalEntry('spec-4', {
      stage: 'pending',
      specId: 'spec-4',
      tmpPath: path.join(tmpDir, _internals.E2E_DIR, 'never-created.tmp'),
      intendedPath: path.join(tmpDir, _internals.E2E_DIR, 'never-created.spec.js'),
      candidateFingerprint: 'fp-cafebabe',
    });
    const r = await reconcilePromotionJournal(tmpDir);
    assert.equal(r.rolledBack, 0);
    assert.equal(journalExists('spec-4'), true);
  });

  it('malformed journal entries are deleted (don\'t block subsequent reconciles)', async () => {
    const dir = path.join(tmpDir, _internals.JOURNAL_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'malformed.json'), '{ not json');
    const r = await reconcilePromotionJournal(tmpDir);
    assert.deepEqual(r, { recovered: 0, rolledBack: 0 });
    assert.equal(fs.existsSync(path.join(dir, 'malformed.json')), false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// promoteCandidates — short-circuit paths
// ────────────────────────────────────────────────────────────────────────────

describe('promoteCandidates — short circuits', () => {
  it('--help returns exit 0 without doing work', async () => {
    const r = await promoteCandidates({ help: true });
    assert.equal(r.exitCode, EXIT.OK);
    assert.equal(r.promoted, 0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// writeJournal helper smoke test
// ────────────────────────────────────────────────────────────────────────────

describe('_internals.writeJournal', () => {
  it('round-trips a journal entry via atomic write', () => {
    _internals.writeJournal(tmpDir, 'spec-x', { stage: 'pending', specId: 'spec-x' });
    const raw = fs.readFileSync(path.join(tmpDir, _internals.JOURNAL_DIR, 'spec-x.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.stage, 'pending');
    assert.equal(parsed.specId, 'spec-x');
  });
});
