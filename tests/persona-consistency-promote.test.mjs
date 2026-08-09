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
  rotateAfter,
  CANDIDATE_MAX_PAGES,
  RECONCILE_BATCH_SIZE,
  RECONCILE_MAX_BATCHES_PER_RUN,
} from '../scripts/persona-consistency-promote.mjs';

// ────────────────────────────────────────────────────────────────────────────
// Failure-contract refactor (docs/plans/refactor-failure-contract.md,
// Cluster B) — pure interpreter regression locks
// ────────────────────────────────────────────────────────────────────────────

describe('interpretCandidateListResult', () => {
  it('a genuine success with candidates passes through', () => {
    assert.deepEqual(
      interpretCandidateListResult({ ok: true, candidates: [{ id: 'a' }] }),
      { ok: true, candidates: [{ id: 'a' }], nextCursor: null },
    );
  });

  it('a genuine cloud-off empty result is legitimate, not a failure', () => {
    assert.deepEqual(
      interpretCandidateListResult({ ok: true, cloud: false, candidates: [] }),
      { ok: true, candidates: [], nextCursor: null },
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
    assert.deepEqual(r, { recovered: 0, rolledBack: 0, retained: 0, incomplete: false });
  });

  it('returns 0/0 when the journal dir is empty', async () => {
    fs.mkdirSync(path.join(tmpDir, _internals.JOURNAL_DIR), { recursive: true });
    const r = await reconcilePromotionJournal(tmpDir);
    assert.deepEqual(r, { recovered: 0, rolledBack: 0, retained: 0, incomplete: false });
  });

  it('deletes "finalised" stage entries (already committed; janitor work)', async () => {
    writeJournalEntry('spec-1', { stage: 'finalised', specId: 'spec-1' });
    const r = await reconcilePromotionJournal(tmpDir);
    assert.deepEqual(r, { recovered: 0, rolledBack: 0, retained: 0, incomplete: false });
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
    assert.deepEqual(r, { recovered: 0, rolledBack: 0, retained: 0, incomplete: false });
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


// ────────────────────────────────────────────────────────────────────────────
// Phase 5 — candidate enumeration + targeted reconcile
// docs/plans/learning-persona-quickfix-honest-failure.md section 2, item 7
// ────────────────────────────────────────────────────────────────────────────

describe('interpretCandidateListResult — nextCursor is part of the protocol', () => {
  it('carries a string cursor through', () => {
    const r = interpretCandidateListResult({ ok: true, candidates: [], nextCursor: 'abc' });
    assert.equal(r.ok, true);
    assert.equal(r.nextCursor, 'abc');
  });

  it('defaults a missing cursor to null (end of enumeration)', () => {
    assert.equal(interpretCandidateListResult({ ok: true, candidates: [] }).nextCursor, null);
  });

  it('rejects a non-string cursor as a protocol violation', () => {
    const r = interpretCandidateListResult({ ok: true, candidates: [], nextCursor: 42 });
    assert.equal(r.ok, false, 'an unreadable termination condition must not be silently tolerated');
    assert.match(r.message, /nextCursor/);
  });
});

describe('parseArgs — --resume is a real input, not just advertised', () => {
  // R3-H3: the earlier draft emitted a nextCursor and printed a resume
  // command the CLI had no input for. A resume instruction the tool cannot
  // execute reads as recoverable when it is not.
  it('accepts --resume <cursor>', () => {
    assert.equal(parseArgs(['--resume', 'CURSOR123']).resume, 'CURSOR123');
  });

  it('defaults resume to null', () => {
    assert.equal(parseArgs([]).resume, null);
  });

  it('composes with --auto and --since', () => {
    const a = parseArgs(['--auto', '--resume', 'C', '--since', '2026-01-01T00:00:00Z']);
    assert.equal(a.auto, true);
    assert.equal(a.resume, 'C');
    assert.equal(a.since, '2026-01-01T00:00:00Z');
  });

  it('advertises --resume in the usage text it prints', () => {
    const src = fs.readFileSync('scripts/persona-consistency-promote.mjs', 'utf-8');
    assert.match(src, /--resume <cursor>/, 'an undocumented resume flag is an unusable one');
  });
});

describe('rotateAfter — deterministic, ADVANCING traversal (anti-starvation)', () => {
  // R3-M2. Journals in absent/unknown are RETAINED by the transition table,
  // so a naive "always take the first N in a stable order" pass re-processes
  // the same stuck prefix forever and never reaches the journals behind it.
  const files = ['a.json', 'b.json', 'c.json', 'd.json'];

  it('starts from the beginning with no checkpoint', () => {
    assert.deepEqual(rotateAfter(files, null), files);
  });

  it('resumes AFTER the checkpointed entry', () => {
    assert.deepEqual(rotateAfter(files, 'b'), ['c.json', 'd.json', 'a.json', 'b.json']);
  });

  it('wraps so earlier entries are still reached eventually', () => {
    const r = rotateAfter(files, 'd');
    assert.deepEqual(r, ['a.json', 'b.json', 'c.json', 'd.json']);
  });

  it('every entry is still present exactly once after rotation (nothing is skipped)', () => {
    for (const cp of [null, 'a', 'b', 'c', 'd', 'missing']) {
      assert.deepEqual([...rotateAfter(files, cp)].sort(), [...files].sort(), `checkpoint ${cp}`);
    }
  });

  it('a checkpoint that no longer exists restarts from the beginning', () => {
    assert.deepEqual(rotateAfter(files, 'zzz'), files);
  });
});

describe('reconcile bounds are declared and mirrored from the store', () => {
  it('batch size and per-run cap are explicit numbers, not magic', () => {
    assert.equal(RECONCILE_BATCH_SIZE, 200);
    assert.equal(RECONCILE_MAX_BATCHES_PER_RUN, 5);
    assert.equal(CANDIDATE_MAX_PAGES, 50);
  });

  it('the run cap bounds journals per run to a stated number', () => {
    assert.equal(
      RECONCILE_BATCH_SIZE * RECONCILE_MAX_BATCHES_PER_RUN, 1000,
      'hitting this is incomplete:true, never a silent stop',
    );
  });
});

describe('reconcilePromotionJournal — positive-evidence-only recovery', () => {
  // The whole point of finding B: "not in the candidate list" was read as
  // "already promoted", and a beyond-page-100 candidate looked exactly like
  // that. Recovery now requires POSITIVE evidence.
  it('reports the retained count as a first-class outcome, not a silent skip', async () => {
    const r = await reconcilePromotionJournal(tmpDirForReconcile());
    assert.ok(Object.hasOwn(r, 'retained'), 'retention must be observable');
    assert.ok(Object.hasOwn(r, 'incomplete'), 'a capped run must be observable');
  });

  it('leaves a pending journal untouched when the DB cannot be reached', async () => {
    const dir = tmpDirForReconcile();
    const jdir = path.join(dir, _internals.JOURNAL_DIR);
    fs.mkdirSync(jdir, { recursive: true });
    fs.writeFileSync(path.join(jdir, 'spec-keep.json'), JSON.stringify({
      stage: 'pending', specId: 'spec-keep', candidateFingerprint: 'fp-1',
      tmpPath: path.join(dir, 'x.tmp'), intendedPath: path.join(dir, 'x.spec.js'),
    }));
    await reconcilePromotionJournal(dir);
    assert.equal(
      fs.existsSync(path.join(jdir, 'spec-keep.json')), true,
      'a journal finalised in error destroys the recovery record; retained in error costs one pass',
    );
  });

  it('the source encodes the transition table, and absent is NOT actionable', () => {
    const src = fs.readFileSync('scripts/persona-consistency-promote.mjs', 'utf-8');
    assert.match(src, /state === 'promoted'/, 'promoted must be the only finalising state');
    assert.match(src, /state === 'candidate'/);
    assert.ok(
      !/state !== 'candidate'/.test(src),
      'a negated candidate check is the finding-B shape: everything-not-candidate treated as promoted',
    );
  });
});

function tmpDirForReconcile() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-c-'));
}

// ── §9 case 13 — ONE CASE PER ROW of the §2 recovery transition table ───────
//
// The earlier coverage here was a SOURCE SCAN: it asserted the branch was
// spelled correctly and nothing about what it does. "absent" being
// non-actionable IS finding B, so a suite that cannot drive the branch cannot
// prove the bug is dead. These drive it through the injected resolver.
//
//   promoted   -> the ONLY state that renames + deletes the journal
//   candidate  -> roll back the .tmp, delete the journal
//   absent     -> RETAIN. Not proof of promotion.
//   unknown    -> RETAIN. We could not tell.

describe('reconcilePromotionJournal — the recovery transition table, driven', () => {
  let dir, jdir, e2e;

  function seedPendingJournal(specId, fingerprint) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-'));
    jdir = path.join(dir, _internals.JOURNAL_DIR);
    e2e = path.join(dir, _internals.E2E_DIR);
    fs.mkdirSync(jdir, { recursive: true });
    fs.mkdirSync(e2e, { recursive: true });
    const tmpPath = path.join(e2e, specId + '.spec.js.tmp');
    const intendedPath = path.join(e2e, specId + '.spec.js');
    fs.writeFileSync(tmpPath, '// staged spec body\n');
    fs.writeFileSync(path.join(jdir, specId + '.json'), JSON.stringify({
      stage: 'pending', specId, candidateFingerprint: fingerprint, tmpPath, intendedPath,
    }));
    return { tmpPath, intendedPath, journalPath: path.join(jdir, specId + '.json') };
  }

  function runWith(state) {
    const originalWrite = process.stderr.write;
    process.stderr.write = () => true;
    try {
      return reconcilePromotionJournal(dir, {
        repoId: 'repo-under-test',
        resolveStates: (_root, _repoId, fps) => ({
          ok: true, states: Object.fromEntries(fps.map(f => [f, state])),
        }),
      });
    } finally {
      process.stderr.write = originalWrite;
    }
  }

  it('promoted -> completes the rename and deletes the journal', async () => {
    const { tmpPath, intendedPath, journalPath } = seedPendingJournal('spec-p', 'fp-p');
    const r = await runWith('promoted');
    assert.equal(fs.existsSync(intendedPath), true, 'the spec must be finalised');
    assert.equal(fs.existsSync(tmpPath), false);
    assert.equal(fs.existsSync(journalPath), false, 'the journal is consumed');
    assert.equal(r.recovered, 1);
    assert.equal(r.retained, 0);
  });

  it('candidate -> rolls back the .tmp and deletes the journal', async () => {
    const { tmpPath, intendedPath, journalPath } = seedPendingJournal('spec-c', 'fp-c');
    const r = await runWith('candidate');
    assert.equal(fs.existsSync(intendedPath), false, 'the DB write never landed — nothing to finalise');
    assert.equal(fs.existsSync(tmpPath), false, 'the staged body is rolled back');
    assert.equal(fs.existsSync(journalPath), false);
    assert.equal(r.rolledBack, 1);
  });

  // THE regression test for finding B. A beyond-page-100 candidate presented
  // as exactly this, and the old code renamed and deleted on the strength of it.
  it('absent -> RETAINS: no rename, no journal deletion (finding B)', async () => {
    const { tmpPath, intendedPath, journalPath } = seedPendingJournal('spec-a', 'fp-a');
    const r = await runWith('absent');
    assert.equal(
      fs.existsSync(intendedPath), false,
      'absent is NOT proof of promotion — finalising here destroys the recovery record',
    );
    assert.equal(fs.existsSync(tmpPath), true, 'the staged body must survive for a later pass');
    assert.equal(fs.existsSync(journalPath), true, 'the journal must survive');
    assert.equal(r.retained, 1);
    assert.equal(r.recovered, 0);
    assert.equal(r.rolledBack, 0);
  });

  it('unknown -> RETAINS, same as absent', async () => {
    const { intendedPath, journalPath } = seedPendingJournal('spec-u', 'fp-u');
    const r = await runWith('unknown');
    assert.equal(fs.existsSync(intendedPath), false);
    assert.equal(fs.existsSync(journalPath), true);
    assert.equal(r.retained, 1);
  });

  it('a resolver FAILURE retains — it is never read as absent (an empty map would be)', async () => {
    const { intendedPath, journalPath } = seedPendingJournal('spec-f', 'fp-f');
    const originalWrite = process.stderr.write;
    process.stderr.write = () => true;
    let r;
    try {
      r = await reconcilePromotionJournal(dir, {
        repoId: 'repo-under-test',
        resolveStates: () => ({ ok: false, message: 'store unreachable' }),
      });
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.equal(fs.existsSync(intendedPath), false, 'a failure must never finalise');
    assert.equal(fs.existsSync(journalPath), true);
    assert.equal(r.incomplete, true, 'the run must report that it did not finish');
  });

  // §9 case 15 — the run cap is per-BATCH, and one over the batch size is a
  // SECOND request, not an incomplete run. The R2 draft's own test
  // contradicted its design on exactly this point.
  it('BATCH_SIZE + 1 journals produce a SECOND batch, not an incomplete run', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-batch-'));
    jdir = path.join(dir, _internals.JOURNAL_DIR);
    e2e = path.join(dir, _internals.E2E_DIR);
    fs.mkdirSync(jdir, { recursive: true });
    fs.mkdirSync(e2e, { recursive: true });
    const n = RECONCILE_BATCH_SIZE + 1;
    for (let i = 0; i < n; i += 1) {
      const id = 'spec-' + String(i).padStart(4, '0');
      fs.writeFileSync(path.join(jdir, id + '.json'), JSON.stringify({
        stage: 'pending', specId: id, candidateFingerprint: 'fp-' + i,
        tmpPath: path.join(e2e, id + '.spec.js.tmp'),
        intendedPath: path.join(e2e, id + '.spec.js'),
      }));
    }

    const batchSizes = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = () => true;
    let r;
    try {
      r = await reconcilePromotionJournal(dir, {
        repoId: 'repo-under-test',
        resolveStates: (_root, _repoId, fps) => {
          batchSizes.push(fps.length);
          return { ok: true, states: Object.fromEntries(fps.map(f => [f, 'unknown'])) };
        },
      });
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.equal(batchSizes.length, 2, 'one over the batch size must make a second request');
    assert.deepEqual(batchSizes, [RECONCILE_BATCH_SIZE, 1]);
    assert.equal(r.incomplete, false, 'two batches is well within the per-run cap — not incomplete');
    assert.ok(
      batchSizes.every(sz => sz <= RECONCILE_BATCH_SIZE),
      'no request may exceed the payload bound the store independently enforces',
    );
  });

  it('exceeding the per-RUN cap reports incomplete rather than stopping silently', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-cap-'));
    jdir = path.join(dir, _internals.JOURNAL_DIR);
    e2e = path.join(dir, _internals.E2E_DIR);
    fs.mkdirSync(jdir, { recursive: true });
    fs.mkdirSync(e2e, { recursive: true });
    const n = RECONCILE_BATCH_SIZE * RECONCILE_MAX_BATCHES_PER_RUN + 1;
    for (let i = 0; i < n; i += 1) {
      const id = 'spec-' + String(i).padStart(5, '0');
      fs.writeFileSync(path.join(jdir, id + '.json'), JSON.stringify({
        stage: 'pending', specId: id, candidateFingerprint: 'fp-' + i,
        tmpPath: path.join(e2e, id + '.spec.js.tmp'),
        intendedPath: path.join(e2e, id + '.spec.js'),
      }));
    }
    let calls = 0;
    const originalWrite = process.stderr.write;
    process.stderr.write = () => true;
    let r;
    try {
      r = await reconcilePromotionJournal(dir, {
        repoId: 'repo-under-test',
        resolveStates: (_root, _repoId, fps) => {
          calls += 1;
          return { ok: true, states: Object.fromEntries(fps.map(f => [f, 'unknown'])) };
        },
      });
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.equal(calls, RECONCILE_MAX_BATCHES_PER_RUN, 'the per-run cap bounds requests');
    assert.equal(r.incomplete, true, 'hitting the cap is reported, never a silent stop');
    assert.ok(
      fs.readdirSync(jdir).filter(f => f.endsWith('.json')).length >= n,
      'nothing may be dropped: every unreached journal is still on disk',
    );
  });
});
