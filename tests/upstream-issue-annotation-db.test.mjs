/**
 * @fileoverview The `annotation` event against a REAL Postgres.
 *
 * Its sibling `tests/upstream-issue-annotation.test.mjs` is pure and covers the
 * vocabulary, the fold, and the CLI-boundary refusals. Everything asserted HERE
 * is a property only the database has, and a mock would fabricate every one of
 * them:
 *
 *  - the widened `event` CHECK actually accepts `annotation` (and still rejects
 *    a value outside the set);
 *  - the annotation-needs-a-note CHECK fires on NULL *and* on whitespace, which
 *    a NOT NULL could not express and a JS-side check cannot prove;
 *  - the append-only trigger is UNCHANGED — an annotation event still cannot be
 *    UPDATEd, which is the property that makes appending the only repair;
 *  - `recordUpstreamIssueAnnotation` mutates NO column of `upstream_issues`,
 *    `updated_at` included — the claim its docstring makes, and the one a unit
 *    test with a stubbed store cannot check at all;
 *  - a TERMINAL issue can still be annotated. That is the case the feature
 *    exists for, and it is a fact about the store's own guards, not about the
 *    CLI's.
 *
 * Enrolled in `ISOLATED_SUITE_FILES` (scripts/db-test-container.mjs) AND in
 * `.github/workflows/postgres-parity.yml`. **Two edits, always** — a DB suite
 * named by no runner skips itself everywhere and node reports the skip as a
 * pass, which is how 15 suites here went years without ever executing.
 *
 * Every case runs inside a transaction that is rolled back via a sentinel
 * throw, so nothing persists into the shared container schema.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { ANNOTATION_EVENT, EVENT_KINDS } from '../scripts/lib/upstream/events.mjs';

const TEST_DSN = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_DSN ? false : 'set AUDIT_DB_TEST_URL (a disposable test DB) to run';

// Point the db client at the TEST DSN before it is imported. Never the live store.
if (TEST_DSN) process.env.AUDIT_DB_URL = TEST_DSN;

const ROLLBACK = 'ROLLBACK_SENTINEL';

/**
 * Seed a repo + one upstream issue in the CURRENT transaction and hand back its
 * id. Written with raw SQL rather than the store's own writers so a regression
 * in those cannot silently change what this suite is testing against.
 *
 * @param {Function} one
 * @param {{state?: string}} [opts]
 */
async function seedIssue(one, { state = 'open' } = {}) {
  const uuid = crypto.randomUUID();
  // No ON CONFLICT clause: `audit_repos` has no unique constraint on
  // `repo_uuid` (only the pkey on `id`), so one would be a `42P10` — a logical
  // key is not an arbiter. A freshly minted uuid per call cannot collide anyway.
  const repo = await one(
    `INSERT INTO audit_repos (repo_uuid, name) VALUES ($1::uuid, $2) RETURNING id`,
    [uuid, `annotation-suite/${uuid.slice(0, 8)}`],
  );
  const terminal = state === 'fixed' || state === 'wont_fix';
  const issue = await one(
    `INSERT INTO upstream_issues
       (repo_id, title, body, severity, affected_path, state, fixed_in_commit, disposition, fingerprint)
     VALUES ($1, 'a report', 'a body', 'MEDIUM', 'scripts/.claude-skills/x.mjs', $2, $3, $4, $5)
     RETURNING id, updated_at`,
    [
      repo.id, state,
      state === 'fixed' ? 'abc1234' : null,
      terminal ? 'test:tests/upstream-issue-annotation.test.mjs' : null,
      `fp-${uuid}`,
    ],
  );
  await one(
    `INSERT INTO upstream_issue_events (issue_id, event) VALUES ($1, 'reported') RETURNING id`,
    [issue.id],
  );
  return issue;
}

/**
 * Attempt a statement expected to FAIL, without poisoning the surrounding
 * transaction.
 *
 * Postgres aborts the whole transaction on the first error — every later
 * statement then returns `25P02` (transaction aborted) regardless of its own
 * merits. Testing three refusals in one transaction without savepoints
 * therefore proves only the FIRST of them, and the other two "pass" for a
 * reason that has nothing to do with the constraint under test. Caught by this
 * suite failing on `'25P02' !== '23514'` rather than by review.
 *
 * @returns {Promise<string>} the SQLSTATE code, or 'ACCEPTED' if it succeeded
 */
async function expectRefusal(many, sql, params) {
  await many('SAVEPOINT sp_probe', []);
  try {
    await many(sql, params);
    await many('RELEASE SAVEPOINT sp_probe', []);
    return 'ACCEPTED';
  } catch (err) {
    await many('ROLLBACK TO SAVEPOINT sp_probe', []);
    return err.code ?? String(err.message);
  }
}

/** Run `body` inside a transaction that is always rolled back. */
async function inRolledBackTx(body) {
  const { withTx } = await import('../scripts/lib/db/query.mjs');
  let captured;
  await assert.rejects(
    withTx(async () => { captured = await body(); throw new Error(ROLLBACK); }),
    new RegExp(ROLLBACK),
  );
  return captured;
}

test('the widened CHECK accepts `annotation` and still rejects a value outside the set', { skip }, async () => {
  const { one, many } = await import('../scripts/lib/db/query.mjs');
  const { closePool } = await import('../scripts/lib/db/client.mjs');
  try {
    const got = await inRolledBackTx(async () => {
      const issue = await seedIssue(one);
      const ok = await one(
        `INSERT INTO upstream_issue_events (issue_id, event, note)
         VALUES ($1, $2, 'a correction') RETURNING id, event`,
        [issue.id, ANNOTATION_EVENT],
      );
      // The direction that must NOT fire: a value the CHECK does not name is
      // still refused, so "accepts annotation" is not "accepts anything".
      const refused = await expectRefusal(
        many,
        `INSERT INTO upstream_issue_events (issue_id, event, note) VALUES ($1, 'teleported', 'x')`,
        [issue.id],
      );
      return { ok, refused };
    });
    assert.equal(got.ok.event, ANNOTATION_EVENT);
    assert.equal(got.refused, '23514', 'an undeclared event value must raise a check_violation');
  } finally { await closePool().catch(() => {}); }
});

test('every declared event value is actually insertable — the JS vocabulary is not aspirational', { skip }, async () => {
  const { one } = await import('../scripts/lib/db/query.mjs');
  const { closePool } = await import('../scripts/lib/db/client.mjs');
  try {
    const accepted = await inRolledBackTx(async () => {
      const issue = await seedIssue(one);
      const out = [];
      for (const event of EVENT_KINDS) {
        // A note on every row: harmless for the lifecycle events, required for
        // the annotation, so one loop covers the whole set.
        const r = await one(
          `INSERT INTO upstream_issue_events (issue_id, event, note)
           VALUES ($1, $2, 'n') RETURNING event`,
          [issue.id, event],
        );
        out.push(r.event);
      }
      return out;
    });
    assert.deepEqual([...accepted].sort(), [...EVENT_KINDS].sort());
  } finally { await closePool().catch(() => {}); }
});

test('an annotation with a NULL or whitespace-only note is refused by the database', { skip }, async () => {
  const { one, many } = await import('../scripts/lib/db/query.mjs');
  const { closePool } = await import('../scripts/lib/db/client.mjs');
  try {
    const codes = await inRolledBackTx(async () => {
      const issue = await seedIssue(one);
      const out = {};
      for (const [label, note] of [['null', null], ['blank', '   '], ['empty', '']]) {
        out[label] = await expectRefusal(
          many,
          `INSERT INTO upstream_issue_events (issue_id, event, note) VALUES ($1, $2, $3)`,
          [issue.id, ANNOTATION_EVENT, note],
        );
      }
      // The direction that must NOT fire: a LIFECYCLE event keeps its nullable
      // note. A blanket NOT NULL on the column would have broken `ack`.
      out.ackWithNoNote = await expectRefusal(
        many,
        `INSERT INTO upstream_issue_events (issue_id, event, note) VALUES ($1, 'acknowledged', NULL)`,
        [issue.id],
      );
      return out;
    });
    assert.equal(codes.null, '23514');
    assert.equal(codes.blank, '23514');
    assert.equal(codes.empty, '23514');
    assert.equal(codes.ackWithNoNote, 'ACCEPTED',
      'a lifecycle event must keep its nullable note — an `ack` legitimately carries none');
  } finally { await closePool().catch(() => {}); }
});

test('an annotation event is still append-only — UPDATE is refused', { skip }, async () => {
  const { one } = await import('../scripts/lib/db/query.mjs');
  const { closePool } = await import('../scripts/lib/db/client.mjs');
  try {
    const err = await inRolledBackTx(async () => {
      const issue = await seedIssue(one);
      const ev = await one(
        `INSERT INTO upstream_issue_events (issue_id, event, note)
         VALUES ($1, $2, 'a correction') RETURNING id`,
        [issue.id, ANNOTATION_EVENT],
      );
      try {
        await one(`UPDATE upstream_issue_events SET note = 'rewritten' WHERE id = $1 RETURNING id`, [ev.id]);
        return 'ACCEPTED';
      } catch (e) { return e.message; }
    });
    assert.match(String(err), /append-only/,
      'the correction channel must not have relaxed the very property it exists to work within');
  } finally { await closePool().catch(() => {}); }
});

test('recordUpstreamIssueAnnotation appends an event and mutates NO upstream_issues column', { skip }, async () => {
  const { one } = await import('../scripts/lib/db/query.mjs');
  const { recordUpstreamIssueAnnotation } = await import('../scripts/lib/store/upstream-issues.mjs');
  const { closePool } = await import('../scripts/lib/db/client.mjs');
  try {
    const got = await inRolledBackTx(async () => {
      // TERMINAL on purpose: annotating a CLOSED report is the case the feature
      // exists for, and the one the lifecycle state machine refuses.
      const issue = await seedIssue(one, { state: 'fixed' });
      const before = await one(`SELECT * FROM upstream_issues WHERE id = $1`, [issue.id]);
      const res = await recordUpstreamIssueAnnotation({
        id: issue.id, note: 'the elided sentence, restored', actor: 'suite',
      });
      const after = await one(`SELECT * FROM upstream_issues WHERE id = $1`, [issue.id]);
      const events = await one(
        `SELECT count(*)::int AS n FROM upstream_issue_events WHERE issue_id = $1 AND event = $2`,
        [issue.id, ANNOTATION_EVENT],
      );
      return { res, before, after, events };
    });
    assert.equal(got.res.ok, true, got.res.error);
    assert.equal(got.res.state, 'fixed', 'the pre-existing state is reported back, not changed');
    assert.ok(got.res.eventId, 'the insert must return the row it claims to have written');
    assert.equal(got.events.n, 1);
    // Whole-row equality, not a hand-listed column set: a column added later
    // would silently escape a per-column check, and "touches nothing" is the
    // claim being made.
    assert.deepEqual(
      JSON.parse(JSON.stringify(got.after)), JSON.parse(JSON.stringify(got.before)),
      'annotating must leave every upstream_issues column untouched, updated_at included',
    );
  } finally { await closePool().catch(() => {}); }
});

test('a replayed annotation conflicts on its event id instead of duplicating the note', { skip }, async () => {
  // The property that makes the write-ahead queue safe. Without a
  // client-minted PK there is no `ON CONFLICT` arbiter — an annotation has no
  // natural unique key (two identical corrections minutes apart are two
  // legitimate rows), so a retry after a lost acknowledgement would append a
  // second copy that the append-only log could not then remove.
  const { one } = await import('../scripts/lib/db/query.mjs');
  const { recordUpstreamIssueAnnotation } = await import('../scripts/lib/store/upstream-issues.mjs');
  const { closePool } = await import('../scripts/lib/db/client.mjs');
  try {
    const got = await inRolledBackTx(async () => {
      const issue = await seedIssue(one, { state: 'fixed' });
      const eventId = crypto.randomUUID();
      const first = await recordUpstreamIssueAnnotation({ id: issue.id, note: 'a correction', eventId });
      const replay = await recordUpstreamIssueAnnotation({ id: issue.id, note: 'a correction', eventId });
      const rows = await one(
        `SELECT count(*)::int AS n FROM upstream_issue_events WHERE issue_id = $1 AND event = $2`,
        [issue.id, ANNOTATION_EVENT],
      );
      // The direction that must NOT fire: WITHOUT an eventId, two identical
      // calls are two rows — the default must stay "append", or a genuine
      // second correction would be swallowed as a duplicate.
      await recordUpstreamIssueAnnotation({ id: issue.id, note: 'a correction' });
      await recordUpstreamIssueAnnotation({ id: issue.id, note: 'a correction' });
      const after = await one(
        `SELECT count(*)::int AS n FROM upstream_issue_events WHERE issue_id = $1 AND event = $2`,
        [issue.id, ANNOTATION_EVENT],
      );
      return { first, replay, rows, after, eventId };
    });
    assert.equal(got.first.ok, true, got.first.error);
    assert.equal(got.first.created, true);
    assert.equal(got.first.eventId, got.eventId, 'the row must take the id the caller minted');
    assert.equal(got.replay.ok, true, 'a replay is a SUCCESS — queueing a landed write forever is the failure');
    assert.equal(got.replay.created, false, 'and it must be distinguishable from a first write');
    assert.equal(got.rows.n, 1, 'the replay must not have appended a second copy of the note');
    assert.equal(got.after.n, 3, 'two id-less calls are two rows: the default is still append');
  } finally { await closePool().catch(() => {}); }
});

test('recordUpstreamIssueAnnotation reports a missing issue as notFound, never as a silent success', { skip }, async () => {
  const { recordUpstreamIssueAnnotation } = await import('../scripts/lib/store/upstream-issues.mjs');
  const { closePool } = await import('../scripts/lib/db/client.mjs');
  try {
    const res = await recordUpstreamIssueAnnotation({ id: crypto.randomUUID(), note: 'x' });
    assert.equal(res.ok, false);
    assert.equal(res.notFound, true);
  } finally { await closePool().catch(() => {}); }
});

test('getUpstreamIssueHistory returns the annotation in the stream, chronologically', { skip }, async () => {
  const { one } = await import('../scripts/lib/db/query.mjs');
  const { getUpstreamIssueHistory } = await import('../scripts/lib/store/upstream-issues.mjs');
  const { closePool } = await import('../scripts/lib/db/client.mjs');
  try {
    const got = await inRolledBackTx(async () => {
      const issue = await seedIssue(one, { state: 'fixed' });
      await one(
        `INSERT INTO upstream_issue_events (issue_id, event, note, created_at)
         VALUES ($1, 'fixed', 'closed with a hole in it', now() + interval '1 second') RETURNING id`,
        [issue.id],
      );
      await one(
        `INSERT INTO upstream_issue_events (issue_id, event, note, created_at)
         VALUES ($1, $2, 'the elided sentence, restored', now() + interval '2 seconds') RETURNING id`,
        [issue.id, ANNOTATION_EVENT],
      );
      return getUpstreamIssueHistory(issue.id);
    });
    assert.equal(got.ok, true, got.error);
    assert.deepEqual(got.events.map((e) => e.event), ['reported', 'fixed', ANNOTATION_EVENT]);
    assert.equal(got.events[2].note, 'the elided sentence, restored');
    assert.equal(got.issue.state, 'fixed');
  } finally { await closePool().catch(() => {}); }
});
