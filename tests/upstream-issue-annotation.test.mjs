/**
 * @fileoverview The non-lifecycle `annotation` event — the correction channel
 * `upstream_issue_events` did not have.
 *
 * Tier-1 (test-first, deterministic seams) per AGENTS.md testing doctrine: the
 * event vocabulary, the state fold, the CLI-boundary refusals, the note
 * resolution, and the JS↔SQL parity. All pure — the store's SQL is exercised by
 * the container schema-drift step, not from here.
 *
 * **Each block asserts the direction that must NOT fire as well as the one that
 * must.** An annotation is only useful if it is invisible to state derivation,
 * and "invisible" is the failure mode a one-directional test cannot see: a fold
 * that silently dropped every event would also pass "annotation does not change
 * the state".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EVENT_KINDS, LIFECYCLE_EVENTS, NON_LIFECYCLE_EVENTS, ANNOTATION_EVENT,
  isLifecycleEvent, foldEventsToState,
} from '../scripts/lib/upstream/events.mjs';
import {
  upstreamAnnotate, upstreamHistory, renderIssueHistory, resolveNoteInput,
  parseAnnotationEnvelope, parseEnvelope, drainAnnotationOutbox,
} from '../scripts/lib/upstream/commands.mjs';
import { LEGAL_TRANSITIONS } from '../scripts/lib/store/upstream-issues.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UUID = '0f5d87a2-1111-4222-8333-444455556666';
const EVENT_UUID = '11111111-2222-4333-8444-555566667777';

// ── The vocabulary oracle ───────────────────────────────────────────────────

test('annotation is declared, and declared as NON-lifecycle', () => {
  assert.ok(EVENT_KINDS.includes(ANNOTATION_EVENT));
  assert.ok(NON_LIFECYCLE_EVENTS.includes(ANNOTATION_EVENT));
  assert.equal(isLifecycleEvent(ANNOTATION_EVENT), false);
  // The direction that must NOT fire: the four lifecycle values stay lifecycle.
  for (const e of ['reported', 'acknowledged', 'fixed', 'wont_fix']) {
    assert.equal(isLifecycleEvent(e), true, `${e} must remain a lifecycle event`);
  }
  assert.equal(new Set(EVENT_KINDS).size, EVENT_KINDS.length, 'no duplicate event values');
});

test('an annotation can never be a lifecycle destination — the state machine excludes it structurally', () => {
  assert.ok(!Object.keys(LEGAL_TRANSITIONS).includes(ANNOTATION_EVENT));
  for (const [from, tos] of Object.entries(LEGAL_TRANSITIONS)) {
    assert.ok(!tos.includes(ANNOTATION_EVENT), `${from} must not be able to transition to ${ANNOTATION_EVENT}`);
  }
});

// ── foldEventsToState ───────────────────────────────────────────────────────

test('fold: annotations are skipped, and the surrounding lifecycle still resolves', () => {
  const withAnnotation = foldEventsToState([
    { event: 'reported' },
    { event: 'acknowledged' },
    { event: ANNOTATION_EVENT },
    { event: 'fixed' },
    { event: ANNOTATION_EVENT },
  ]);
  assert.deepEqual(withAnnotation, { state: 'fixed', unknown: [] });

  // The same stream with the annotations removed must fold identically —
  // otherwise "skipped" is really "consumed something".
  const without = foldEventsToState([
    { event: 'reported' }, { event: 'acknowledged' }, { event: 'fixed' },
  ]);
  assert.deepEqual(without, withAnnotation);
});

test('fold: an annotation-only stream has NO state, and that is not the same as unknown', () => {
  assert.deepEqual(foldEventsToState([{ event: ANNOTATION_EVENT }]), { state: null, unknown: [] });
  // A value the vocabulary does not declare is reported, never silently skipped
  // the way a known non-lifecycle event is — collapsing the two would make an
  // unrecognised log read as a clean annotated one.
  assert.deepEqual(
    foldEventsToState([{ event: 'reported' }, { event: 'teleported' }]),
    { state: 'open', unknown: ['teleported'] },
  );
});

test('fold: `reported` folds to `open`, since there is no `reported` state', () => {
  assert.equal(foldEventsToState([{ event: 'reported' }]).state, 'open');
  assert.ok(Object.keys(LEGAL_TRANSITIONS).includes('open'));
  assert.ok(!Object.keys(LEGAL_TRANSITIONS).includes('reported'));
});

test('fold: an empty stream is null, never a guessed default', () => {
  assert.deepEqual(foldEventsToState([]), { state: null, unknown: [] });
  assert.deepEqual(foldEventsToState(undefined), { state: null, unknown: [] });
});

// ── upstreamAnnotate — the CLI boundary + the write-ahead queue ─────────────

/**
 * A store stub plus a throwaway repo root.
 *
 * `repoRoot` is NEVER omitted in these tests: `upstreamAnnotate` is write-ahead,
 * so a default of `process.cwd()` would scatter envelopes into this repo's own
 * `.audit/` while the suite runs.
 */
function harness(result = { ok: true, cloud: true, created: true }) {
  const calls = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-annotate-'));
  return {
    calls,
    repoRoot: dir,
    fn: async (a) => { calls.push(a); return typeof result === 'function' ? result(a) : result; },
    queued: () => {
      const box = path.join(dir, '.audit', 'upstream-annotation-outbox');
      try {
        return fs.readdirSync(box).filter((f) => f.endsWith('.json'))
          .map((f) => JSON.parse(fs.readFileSync(path.join(box, f), 'utf-8')));
      } catch { return []; }
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  };
}

test('annotate: the FULL uuid is required — a prefix is refused BEFORE any write', async () => {
  const h = harness();
  try {
    const res = await upstreamAnnotate({ repoRoot: h.repoRoot, annotateFn: h.fn, id: '0f5d87a2', note: 'a correction' });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'BAD_INPUT');
    assert.match(res.errors[0], /FULL uuid/);
    assert.equal(h.calls.length, 0, 'a refused annotation must not reach the store');
    assert.equal(h.queued().length, 0, 'nor may it be queued — a refusal is not a pending write');
  } finally { h.cleanup(); }
});

test('annotate: a non-hex id is refused (the LIKE-wildcard hazard), and so is an absent one', async () => {
  const h = harness();
  try {
    for (const bad of ['%', '________', 'not-an-id', '', null]) {
      const res = await upstreamAnnotate({ repoRoot: h.repoRoot, annotateFn: h.fn, id: bad, note: 'x' });
      assert.equal(res.ok, false, `id ${JSON.stringify(bad)} must be refused`);
    }
    assert.equal(h.calls.length, 0);
    assert.equal(h.queued().length, 0);
  } finally { h.cleanup(); }
});

test('annotate: an empty or whitespace-only note is refused — an annotation IS its note', async () => {
  const h = harness();
  try {
    for (const bad of [null, undefined, '', '   ', '\n\t ']) {
      const res = await upstreamAnnotate({ repoRoot: h.repoRoot, annotateFn: h.fn, id: UUID, note: bad });
      assert.equal(res.ok, false, `note ${JSON.stringify(bad)} must be refused`);
      assert.match(res.errors[0], /--note is required/);
    }
    assert.equal(h.calls.length, 0);
    assert.equal(h.queued().length, 0);
  } finally { h.cleanup(); }
});

test('annotate: a full uuid with a real note reaches the store, trimmed and redacted', async () => {
  const h = harness();
  try {
    const res = await upstreamAnnotate({
      repoRoot: h.repoRoot, annotateFn: h.fn, id: UUID,
      note: '  the elided sentence, restored  ', actor: 'me',
    });
    assert.equal(res.ok, true);
    assert.equal(res.spooled, false);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].id, UUID);
    assert.equal(h.calls[0].note, 'the elided sentence, restored');
    assert.equal(h.calls[0].actor, 'me');
    // The event id the caller minted is the one the store was asked to use.
    assert.match(h.calls[0].eventId, /^[0-9a-f-]{36}$/);
    assert.equal(res.eventId, h.calls[0].eventId);
    // Applied ⇒ the write-ahead envelope is gone. A queue that keeps a landed
    // write replays it forever.
    assert.equal(h.queued().length, 0, 'a successful write must clear its envelope');
  } finally { h.cleanup(); }
});

test('annotate: the id is lower-cased before it is shape-checked, so an upper-case uuid works', async () => {
  const h = harness();
  try {
    const res = await upstreamAnnotate({ repoRoot: h.repoRoot, annotateFn: h.fn, id: UUID.toUpperCase(), note: 'x' });
    assert.equal(res.ok, true);
    assert.equal(h.calls[0].id, UUID);
  } finally { h.cleanup(); }
});

test('annotate: a secret in the note is redacted before it reaches the shared store', async () => {
  const h = harness();
  try {
    await upstreamAnnotate({
      repoRoot: h.repoRoot, annotateFn: h.fn, id: UUID,
      note: 'the token was sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    assert.ok(!h.calls[0].note.includes('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      'the raw secret must not survive into the stored note');
  } finally { h.cleanup(); }
});

// ── Cloud-off: the note is QUEUED, never discarded ──────────────────────────

test('annotate: cloud-off queues the note instead of returning a success that wrote nothing', async () => {
  const h = harness();
  try {
    const res = await upstreamAnnotate({
      repoRoot: h.repoRoot, annotateFn: h.fn, id: UUID,
      note: 'the elided sentence, restored', actor: 'me', cloudEnabled: false,
    });
    assert.equal(res.ok, true);
    assert.equal(res.cloud, false);
    assert.equal(res.spooled, true, 'cloud-off must SPOOL — the defect was a success envelope over a discarded note');
    assert.equal(h.calls.length, 0, 'the store must not be called when cloud is off');

    const queued = h.queued();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].payload.note, 'the elided sentence, restored');
    assert.equal(queued[0].payload.issueId, UUID);
    assert.equal(queued[0].payload.eventId, res.eventId);
    assert.ok(fs.existsSync(res.path), 'the envelope path returned to the operator must exist');
  } finally { h.cleanup(); }
});

test('annotate: the note is redacted BEFORE it is written to disk, not only before the store', async () => {
  // The envelope is a plaintext file in the repo; redacting only on the store
  // path would put the secret on disk instead of in the database.
  const h = harness();
  try {
    const res = await upstreamAnnotate({
      repoRoot: h.repoRoot, annotateFn: h.fn, id: UUID, cloudEnabled: false,
      note: 'the token was sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    assert.equal(res.spooled, true);
    assert.ok(!fs.readFileSync(res.path, 'utf-8').includes('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'));
  } finally { h.cleanup(); }
});

test('annotate: a transient store failure leaves the note queued and says so', async () => {
  const h = harness({ ok: false, cloud: true, error: 'connection refused' });
  try {
    const res = await upstreamAnnotate({
      repoRoot: h.repoRoot, annotateFn: h.fn, id: UUID, note: 'a correction',
    });
    assert.equal(res.spooled, true);
    assert.equal(res.error, 'connection refused');
    assert.equal(h.queued().length, 1, 'a failed write must stay in the queue');
  } finally { h.cleanup(); }
});

test('annotate: a TERMINAL refusal is not queued — retrying it forever would block the queue', async () => {
  // The direction that must not fire. `notFound`/`ambiguous` are facts about
  // the target, not the store; the drain is capped and oldest-first, so one
  // permanently-failing envelope at the head starves everything behind it.
  for (const terminal of [{ notFound: true }, { ambiguous: true }]) {
    const h = harness({ ok: false, cloud: true, ...terminal });
    try {
      const res = await upstreamAnnotate({
        repoRoot: h.repoRoot, annotateFn: h.fn, id: UUID, note: 'a correction',
      });
      assert.equal(res.ok, false, `${JSON.stringify(terminal)} must surface as a failure`);
      assert.equal(res.spooled, false);
      assert.equal(h.queued().length, 0, `${JSON.stringify(terminal)} must not be left in the queue`);
    } finally { h.cleanup(); }
  }
});

// ── The annotation outbox: parse + drain ───────────────────────────────────

const envelope = (over = {}) => ({
  v: 1,
  fingerprint: EVENT_UUID,
  payload: { issueId: UUID, eventId: EVENT_UUID, note: 'a correction', actor: null, ...over },
  createdAt: '2026-08-30T00:00:00.000Z',
});

test('outbox: the annotation validator requires BOTH uuids and a non-empty note', () => {
  assert.ok(parseAnnotationEnvelope(JSON.stringify(envelope())));
  // Each field, one at a time — a validator that passes because ONE check does
  // all the work is the shape a single happy-path assertion cannot see.
  assert.equal(parseAnnotationEnvelope(JSON.stringify(envelope({ issueId: '0f5d87a2' }))), null,
    'a PREFIX issueId must be refused: the queued write cannot be re-aimed');
  assert.equal(parseAnnotationEnvelope(JSON.stringify(envelope({ eventId: undefined }))), null,
    'no eventId means no idempotent replay — a retry would duplicate the note');
  assert.equal(parseAnnotationEnvelope(JSON.stringify(envelope({ note: '   ' }))), null);
  assert.equal(parseAnnotationEnvelope(JSON.stringify(envelope({ actor: 42 }))), null);
});

test('outbox: a REPORT envelope is not accepted by the annotation validator, and vice versa', () => {
  // Why the two live in separate directories: one validator per payload shape,
  // each total over its own frame. A union predicate would let a malformed
  // report validate as a well-formed annotation and be applied as one.
  const report = {
    v: 1,
    fingerprint: 'a'.repeat(64),
    payload: { title: 't', body: 'b', severity: 'MEDIUM', affectedPath: 'scripts/x.mjs' },
  };
  assert.equal(parseAnnotationEnvelope(JSON.stringify(report)), null);
  assert.equal(parseEnvelope(JSON.stringify(envelope())), null);
});

test('outbox: draining applies a queued annotation and clears it', async () => {
  const h = harness();
  try {
    const res = await upstreamAnnotate({
      repoRoot: h.repoRoot, annotateFn: h.fn, id: UUID, note: 'a correction', cloudEnabled: false,
    });
    assert.equal(h.queued().length, 1);

    const drained = await drainAnnotationOutbox({ repoRoot: h.repoRoot, annotateFn: h.fn });
    assert.equal(drained.state, 'drained');
    assert.equal(drained.drained, 1);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].eventId, res.eventId,
      'the drain must replay the SAME event id, or the retry is a second row');
    assert.equal(h.queued().length, 0);
  } finally { h.cleanup(); }
});

test('outbox: a drain that cannot apply leaves the note queued for the next one', async () => {
  const h = harness({ ok: false, cloud: true, error: 'store down' });
  try {
    await upstreamAnnotate({
      repoRoot: h.repoRoot, annotateFn: h.fn, id: UUID, note: 'a correction', cloudEnabled: false,
    });
    const drained = await drainAnnotationOutbox({ repoRoot: h.repoRoot, annotateFn: h.fn });
    assert.equal(drained.drained, 0);
    assert.equal(drained.failed, 1);
    assert.equal(h.queued().length, 1, 'silence is not success — an unapplied write stays queued');
  } finally { h.cleanup(); }
});

test('outbox: a cloud-off drain does not clear the queue', async () => {
  // The store resolves {ok:true, cloud:false} having persisted nothing. Deleting
  // on that would lose the note — the same trap `drainOutbox` names for reports.
  const h = harness({ ok: true, cloud: false });
  try {
    await upstreamAnnotate({
      repoRoot: h.repoRoot, annotateFn: h.fn, id: UUID, note: 'a correction', cloudEnabled: false,
    });
    const drained = await drainAnnotationOutbox({ repoRoot: h.repoRoot, annotateFn: h.fn });
    assert.equal(drained.drained, 0);
    assert.equal(h.queued().length, 1);
  } finally { h.cleanup(); }
});

test('outbox: a REPLAY of an already-applied annotation clears the queue, not fails it', async () => {
  // `created: false` means the row is already in the store — which is exactly
  // what "durably applied" means. Treating it as a failure would queue a
  // landed write forever.
  const h = harness({ ok: true, cloud: true, created: false });
  try {
    await upstreamAnnotate({
      repoRoot: h.repoRoot, annotateFn: h.fn, id: UUID, note: 'a correction', cloudEnabled: false,
    });
    const drained = await drainAnnotationOutbox({ repoRoot: h.repoRoot, annotateFn: h.fn });
    assert.equal(drained.drained, 1);
    assert.equal(h.queued().length, 0);
  } finally { h.cleanup(); }
});

test('outbox: a terminal refusal is QUARANTINED, so it cannot starve the queue behind it', async () => {
  const h = harness({ ok: false, cloud: true, notFound: true });
  try {
    await upstreamAnnotate({
      repoRoot: h.repoRoot, annotateFn: h.fn, id: UUID, note: 'a correction', cloudEnabled: false,
    });
    const drained = await drainAnnotationOutbox({ repoRoot: h.repoRoot, annotateFn: h.fn });
    assert.equal(drained.rejected, 1, 'a terminal refusal is a rejection, not a retryable failure');
    assert.equal(drained.failed, 0);
    assert.equal(h.queued().length, 0, 'it must leave the queue…');
    const rej = path.join(h.repoRoot, '.audit', 'upstream-annotation-outbox', 'rejected');
    assert.equal(fs.readdirSync(rej).length, 1, '…but the operator\'s text must survive as evidence');
  } finally { h.cleanup(); }
});

test('outbox: an absent queue is `empty`, an unreadable one is not', async () => {
  const h = harness();
  try {
    const none = await drainAnnotationOutbox({ repoRoot: h.repoRoot, annotateFn: h.fn });
    assert.equal(none.state, 'empty', 'a never-used queue is genuinely nothing to do');
    assert.equal(h.calls.length, 0);
  } finally { h.cleanup(); }
});// ── upstreamHistory — a read, so a prefix is fine ───────────────────────────

test('history: a prefix is accepted (it is a read; the store detects ambiguity)', async () => {
  const seen = [];
  const res = await upstreamHistory({ id: '0F5D87A2', historyFn: async (i) => { seen.push(i); return { ok: true, cloud: true, issue: null, events: [] }; } });
  assert.equal(res.ok, true);
  assert.deepEqual(seen, ['0f5d87a2']);
});

test('history: a malformed id is still refused before the store', async () => {
  let called = false;
  const res = await upstreamHistory({ id: 'zz%', historyFn: async () => { called = true; return {}; } });
  assert.equal(res.ok, false);
  assert.equal(called, false);
});

// ── renderIssueHistory ──────────────────────────────────────────────────────

const ISSUE = {
  id: UUID, severity: 'HIGH', title: 'a bug', repo_name: 'owner/consumer',
  affected_path: 'scripts/.claude-skills/x.mjs', state: 'fixed', disposition: 'test:tests/x.test.mjs',
};

test('render: an annotation is labelled as state-neutral, a transition is not', () => {
  const out = renderIssueHistory({
    issue: ISSUE,
    events: [
      { event: 'reported', created_at: '2026-08-01T00:00:00Z', note: null },
      { event: 'fixed', created_at: '2026-08-30T00:00:00Z', note: 'closed with a hole in it' },
      { event: ANNOTATION_EVENT, created_at: '2026-08-30T01:00:00Z', note: 'the elided sentence, restored', actor: 'me' },
    ],
  });
  assert.match(out, /annotation \[does not change state\]/);
  assert.ok(!/fixed \[does not change state\]/.test(out), 'a lifecycle event must NOT be tagged state-neutral');
  assert.match(out, /the elided sentence, restored/);
  assert.match(out, /closed with a hole in it/);
  // No warning: the log folds to `fixed` and so does the row.
  assert.ok(!out.includes('WARNING'), 'an annotated but consistent issue must not warn');
});

test('render: a row/log disagreement is REPORTED, not reconciled', () => {
  const out = renderIssueHistory({
    issue: { ...ISSUE, state: 'wont_fix' },
    events: [{ event: 'reported', created_at: '2026-08-01T00:00:00Z' }, { event: 'fixed', created_at: '2026-08-02T00:00:00Z' }],
  });
  assert.match(out, /WARNING/);
  assert.match(out, /folds to "fixed"/);
  assert.match(out, /row says "wont_fix"/);
});

test('render: an annotation can NEVER be what makes the two disagree', () => {
  // The direction that must not fire. Same row, same lifecycle events, an
  // annotation added: the verdict must be byte-identical apart from the
  // annotation's own line.
  const base = [{ event: 'reported', created_at: '2026-08-01T00:00:00Z' }, { event: 'fixed', created_at: '2026-08-02T00:00:00Z' }];
  const withAnn = [...base, { event: ANNOTATION_EVENT, created_at: '2026-08-03T00:00:00Z', note: 'note' }];
  assert.ok(!renderIssueHistory({ issue: ISSUE, events: base }).includes('WARNING'));
  assert.ok(!renderIssueHistory({ issue: ISSUE, events: withAnn }).includes('WARNING'));
});

test('render: an EMPTY log never reads as a clean history', () => {
  const out = renderIssueHistory({ issue: ISSUE, events: [] });
  assert.match(out, /not an empty history/);
  // …and it must not claim a state disagreement it has no evidence for.
  assert.ok(!out.includes('WARNING'));
});

test('render: an unknown event value is surfaced rather than silently skipped', () => {
  const out = renderIssueHistory({
    issue: ISSUE,
    events: [{ event: 'reported', created_at: '2026-08-01T00:00:00Z' }, { event: 'teleported', created_at: '2026-08-02T00:00:00Z' }],
  });
  assert.match(out, /does not declare: teleported/);
});

test('render: no angle brackets — operator lines must stay PowerShell-pasteable', () => {
  const out = renderIssueHistory({
    issue: ISSUE, events: [{ event: 'reported', created_at: '2026-08-01T00:00:00Z' }],
  });
  assert.ok(!/[<>]/.test(out), `render must not emit angle brackets:\n${out}`);
  assert.match(out, new RegExp(`upstream annotate --id ${UUID}`));
});

// ── JS ↔ SQL parity, read from the LIVE constraint definition ───────────────

/**
 * The event CHECK as it stands TODAY, not as first written.
 *
 * Migrations are cumulative: `20260731120000` declares the constraint inline
 * and `20260830160000` redefines it. Reading the first file only would pin this
 * test to a definition the database no longer has — which is how a parity test
 * goes green against a set that has moved.
 *
 * @returns {{file: string, values: string[]}}
 */
function liveEventCheck() {
  const dir = path.join(REPO_ROOT, 'supabase', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  let found = null;
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf-8');
    // Both forms: the original inline `event TEXT NOT NULL CHECK (event IN (…))`
    // and a later `ADD CONSTRAINT … CHECK (event IN (…))`. Last one wins.
    for (const m of sql.matchAll(/CHECK\s*\(\s*event\s+IN\s*\(([^)]*)\)\s*\)/gi)) {
      found = { file: f, values: m[1].split(',').map((v) => v.trim().replace(/'/g, '')) };
    }
  }
  return found;
}

test('parity: the JS event vocabulary and the LIVE SQL CHECK declare the same set', () => {
  const live = liveEventCheck();
  assert.ok(live, 'could not locate any event CHECK constraint in supabase/migrations');
  assert.deepEqual(
    [...EVENT_KINDS].sort(), [...live.values].sort(),
    `the event set is declared in two places (${live.file} and lib/upstream/events.mjs); `
    + 'adding one without the other is a runtime CHECK violation',
  );
});

test('parity: the live CHECK is a LATER migration than the original — the fixture is not self-confirming', () => {
  // A negative control for `liveEventCheck` itself: if this ever reads the
  // original migration again, the widening was reverted or never landed, and
  // the parity test above would be asserting the old set against itself.
  assert.notEqual(liveEventCheck().file, '20260731120000_upstream_issues.sql');
});

test('parity: every lifecycle event is also a declared upstream_issues state (or `reported`)', () => {
  const states = new Set(Object.keys(LEGAL_TRANSITIONS));
  for (const e of LIFECYCLE_EVENTS) {
    assert.ok(e === 'reported' || states.has(e), `${e} is a lifecycle event with no matching state`);
  }
  // And the non-lifecycle ones are deliberately NOT states.
  for (const e of NON_LIFECYCLE_EVENTS) {
    assert.ok(!states.has(e), `${e} must not be a state — that is what "non-lifecycle" means`);
  }
});

test('parity: the annotation note CHECK exists and is an implication, not a NOT NULL', () => {
  const sql = fs.readFileSync(
    path.join(REPO_ROOT, 'supabase', 'migrations', '20260830160000_upstream_issue_annotation_event.sql'),
    'utf-8',
  );
  assert.match(sql, /chk_upstream_event_annotation_has_note/);
  // The lifecycle events keep a nullable note (an `ack` legitimately carries
  // none), so a blanket NOT NULL would be the wrong fix and is asserted absent.
  assert.match(sql, /event <> 'annotation' OR \(note IS NOT NULL AND btrim\(note\) <> ''\)/);
  assert.ok(!/ALTER COLUMN note SET NOT NULL/i.test(sql));
});

test('parity: the append-only trigger is NOT relaxed by the annotation migration', () => {
  const sql = fs.readFileSync(
    path.join(REPO_ROOT, 'supabase', 'migrations', '20260830160000_upstream_issue_annotation_event.sql'),
    'utf-8',
  );
  // The whole point is that a correction APPENDS. A migration that dropped the
  // trigger would make annotate redundant and the log untrustworthy.
  assert.ok(!/DROP TRIGGER[\s\S]*upstream_issue_events_no_update/i.test(sql));
  assert.ok(!/upstream_issue_events_append_only/i.test(sql));
});

// ── resolveNoteInput — the shell-interpolation escape hatch ─────────────────

test('note: `--note -` reads stdin, on required AND optional verbs alike', async () => {
  const stdin = async () => 'a note with a `backtick` and a $VAR, verbatim';
  assert.equal(
    await resolveNoteInput({ flag: '-', readStdin: stdin }),
    'a note with a `backtick` and a $VAR, verbatim',
  );
  assert.equal(
    await resolveNoteInput({ flag: '-', readStdin: stdin, required: true }),
    'a note with a `backtick` and a $VAR, verbatim',
  );
});

test('note: an OPTIONAL note with no flag returns null and never touches stdin', async () => {
  // The direction that must not fire. A bare stdin fallback here would block
  // forever on an inherited pipe with no writer, turning an omitted `--note`
  // on `fix` into a hang.
  let read = false;
  const stdin = async () => { read = true; return ''; };
  assert.equal(await resolveNoteInput({ flag: undefined, readStdin: stdin }), null);
  assert.equal(await resolveNoteInput({ flag: null, readStdin: stdin }), null);
  assert.equal(read, false, 'the optional path must not read stdin');
});

test('note: a REQUIRED note with no flag falls back to stdin (the `report --body` pattern)', async () => {
  assert.equal(
    await resolveNoteInput({ flag: undefined, readStdin: async () => 'from stdin', required: true }),
    'from stdin',
  );
});

test('note: an ordinary flag value is passed through untouched, sentinel or not', async () => {
  const stdin = async () => { throw new Error('stdin must not be read'); };
  assert.equal(await resolveNoteInput({ flag: 'plain note', readStdin: stdin }), 'plain note');
  // A note that merely CONTAINS a dash is not the sentinel.
  assert.equal(await resolveNoteInput({ flag: '- leading dash', readStdin: stdin }), '- leading dash');
  assert.equal(await resolveNoteInput({ flag: '', readStdin: stdin }), '',
    'an explicitly empty flag is the caller\'s value, not an absent one — the verb decides if that is legal');
});

test('outbox: an UNREADABLE queue is `unavailable`, never `empty`', async () => {
  // The distinction the whole outbox core exists to preserve: "there is nothing
  // to do" and "I could not look" must not share a return value. Driven by
  // putting a FILE where the directory belongs — `chmod` is a no-op on the
  // platform this repo is developed on, and a guard nobody can drive red is
  // indistinguishable from one that does nothing.
  const h = harness();
  try {
    fs.mkdirSync(path.join(h.repoRoot, '.audit'), { recursive: true });
    fs.writeFileSync(path.join(h.repoRoot, '.audit', 'upstream-annotation-outbox'), 'not a directory');
    const res = await drainAnnotationOutbox({ repoRoot: h.repoRoot, annotateFn: h.fn });
    assert.equal(res.state, 'unavailable');
    assert.match(res.reason, /readdir failed/);
    assert.equal(h.calls.length, 0);
  } finally { h.cleanup(); }
});

test('CLI: `upstream drain` exits NON-ZERO when an outbox could not be read', async () => {
  // The end of that same chain, asserted on the CLI's actual exit code — a
  // caller checking `$?` is the reader this protects, and `emit({ok:false})`
  // only helps if the handler refuses in the first place.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-drain-cli-'));
  try {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.mkdirSync(path.join(dir, '.audit'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.audit', 'upstream-annotation-outbox'), 'not a directory');

    let code = 0; let stdout = '';
    try {
      ({ stdout } = await run(
        process.execPath,
        [path.join(REPO_ROOT, 'scripts', 'cross-skill.mjs'), 'upstream', 'drain'],
        { cwd: dir, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 },
      ));
    } catch (err) { code = err.code; stdout = err.stdout ?? ''; }

    // Cloud may legitimately be off on the machine running this, and a cloud-off
    // drain never looks at the directory at all — so the assertion is
    // conditional on the run having actually reached the outbox. Stated rather
    // than silently skipped: a test that passes without exercising anything is
    // the vacuous pass this suite is built to avoid.
    const line = stdout.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
    const env = line ? JSON.parse(line) : null;
    assert.ok(env, 'the CLI must emit a JSON envelope');
    if (env.cloud === false || env.skipped === 'cloud-off') {
      assert.equal(env.ok, true, 'cloud-off is a supported mode, not a failure');
      return;
    }
    assert.equal(code, 2, 'an unreadable outbox must not exit 0');
    assert.equal(env.ok, false);
    assert.equal(env.error.code, 'DRAIN_UNAVAILABLE');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
