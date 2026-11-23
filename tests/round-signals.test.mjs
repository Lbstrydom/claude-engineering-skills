import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUND_SIGNALS_VERSION, SIGNAL_THRESHOLDS, parsePostImageHunks, postImageHunks, citedLocation,
  reopenRate, severityDrift, retired, computeRoundSignals, renderRoundSignals, importanceSelector,
} from '../scripts/lib/audit/round-signals.mjs';

const S1 = 'a'.repeat(40); const S2 = 'b'.repeat(40); const S3 = 'c'.repeat(40);

const DIFF = [
  'diff --git a/a.mjs b/a.mjs', '--- a/a.mjs', '+++ b/a.mjs', '@@ -9,2 +10,5 @@', '-o1', '-o2', '+n1', '+n2', '+n3', '+n4', '+n5',
  'diff --git a/old/c.mjs b/new/c.mjs', 'similarity index 90%', 'rename from old/c.mjs', 'rename to new/c.mjs', '--- a/old/c.mjs', '+++ b/new/c.mjs', '@@ -1 +1,2 @@', '-o1', '+n1', '+n2',
  'diff --git a/gone.mjs b/gone.mjs', '--- a/gone.mjs', '+++ /dev/null', '@@ -1,3 +0,0 @@', '-o1', '-o2', '-o3',
  'diff --git a/b.mjs b/b.mjs', '--- a/b.mjs', '+++ b/b.mjs', '@@ -3,0 +3 @@', '+n1',
].join('\n');

/** A fake git keyed on the subcommand; every sha reachable unless listed in `bad`. */
function fakeGit({ diffs = {}, bad = [], notAncestor = false, calls = [] } = {}) {
  return (args) => {
    calls.push(args);
    if (args[0] === 'cat-file') return { status: bad.some((b) => args[2].startsWith(b)) ? 128 : 0, stdout: '' };
    if (args[0] === 'merge-base') return { status: notAncestor ? 1 : 0, stdout: '' };
    if (args.includes('diff')) return { status: 0, stdout: diffs[args[args.length - 1]] ?? '' };
    return { status: 1, stdout: '' };
  };
}
const F = (tid, severity, file, line) => ({ tid, severity, _primaryFile: file, ...(line ? { line } : {}) });
const select = importanceSelector([[{ severity: 'HIGH' }]]).select;
const topicOf = (f) => f.tid;

test('parsePostImageHunks: post-image ranges, rename maps to NEW path, deletion skipped, omitted count = 1', () => {
  const m = parsePostImageHunks(DIFF);
  assert.deepEqual(m.get('a.mjs'), [[10, 14]]);
  assert.deepEqual(m.get('new/c.mjs'), [[1, 2]]);
  assert.deepEqual(m.get('b.mjs'), [[3, 3]]);
  assert.equal(m.has('old/c.mjs'), false);
  assert.equal(m.has('gone.mjs'), false);
});

test('reopenRate: exact figure 2/4 = 0.5 fires (rename-aware); 1/4 does not', () => {
  const git = fakeGit({ diffs: { [`${S2}..${S3}`]: DIFF } });
  const mk = (lines) => [
    { round: 2, auditedSha: S2, findings: [] },
    { round: 3, auditedSha: S3, findings: lines },
  ];
  const fires = reopenRate({ round: 3, select, git, rounds: mk([F('1', 'HIGH', 'a.mjs', 12), F('2', 'HIGH', 'a.mjs', 20), F('3', 'MEDIUM', 'new/c.mjs', 2), F('4', 'HIGH', 'b.mjs', 50)]) });
  assert.deepEqual([fires.measured, fires.value, fires.fires, fires.hits, fires.located], [true, 0.5, true, 2, 4]);
  const quiet = reopenRate({ round: 3, select, git, rounds: mk([F('1', 'HIGH', 'a.mjs', 12), F('2', 'HIGH', 'a.mjs', 20), F('3', 'MEDIUM', 'a.mjs', 30), F('4', 'HIGH', 'b.mjs', 50)]) });
  assert.deepEqual([quiet.measured, quiet.value, quiet.fires], [true, 0.25, false]);
});

test('reopenRate: zero denominator is 0 with measured true; boundary 0.5 fires, just under does not', () => {
  const git = fakeGit({ diffs: { [`${S2}..${S3}`]: DIFF } });
  const rounds = [{ round: 2, auditedSha: S2, findings: [] }, { round: 3, auditedSha: S3, findings: [{ severity: 'LOW', _primaryFile: 'a.mjs', line: 12 }] }];
  const r = reopenRate({ round: 3, select, git, rounds });
  assert.deepEqual([r.measured, r.value, r.fires], [true, 0, false]); // LOW filtered by the severity proxy
});

test('reopenRate: findings that cite no lines are unmeasured, never quiet', () => {
  const git = fakeGit({ diffs: { [`${S2}..${S3}`]: DIFF } });
  const r = reopenRate({ round: 3, select, git, rounds: [{ round: 2, auditedSha: S2, findings: [] }, { round: 3, auditedSha: S3, findings: [F('1', 'HIGH', 'a.mjs')] }] });
  assert.equal(r.measured, false); assert.equal(r.fires, false); assert.match(r.reason, /cite no lines/);
});

test('reopenRate: line parsed from "<file>:<n>" prose when no line field', () => {
  assert.deepEqual(citedLocation({ _primaryFile: 'a.mjs', detail: 'see a.mjs:12-13 and more' }), { file: 'a.mjs', ranges: [[12, 13]] });
});

test('missing audited_sha, unreachable commit and non-ancestor are each measured:false with a reason', () => {
  assert.match(postImageHunks({ base: null, head: S3 }, fakeGit()).reason, /missing audited_sha/);
  assert.match(postImageHunks({ base: S2, head: S3 }, fakeGit({ bad: [S2.slice(0, 8)] })).reason, /unreachable/);
  assert.match(postImageHunks({ base: S2, head: S3 }, fakeGit({ notAncestor: true })).reason, /rewritten/);
  const rounds = [{ round: 2, auditedSha: S2, findings: [] }, { round: 3, auditedSha: S3, findings: [F('1', 'HIGH', 'a.mjs', 12)] }];
  const r = reopenRate({ round: 3, select, rounds, git: fakeGit({ notAncestor: true }) });
  assert.deepEqual([r.measured, r.fires], [false, false]);
});

test('same sha for both rounds is an empty fix range (measured), not an error', () => {
  const h = postImageHunks({ base: S2, head: S2 }, fakeGit());
  assert.equal(h.measured, true); assert.equal(h.hunks.size, 0);
});

test('severityDrift: exact median -1 over 3 files fires; +0 does not; <2 files is unmeasured', () => {
  const rounds = (b) => [
    { round: 2, findings: [F('1', 'HIGH', 'a.mjs'), F('2', 'HIGH', 'b.mjs'), F('3', 'MEDIUM', 'c.mjs')] },
    { round: 3, findings: b },
  ];
  // a: 3->2 (-1), b: 3->2 (-1), c: 2->2 (0)  => median -1
  const fires = severityDrift({ round: 3, select, rounds: rounds([F('4', 'MEDIUM', 'a.mjs'), F('5', 'MEDIUM', 'b.mjs'), F('6', 'MEDIUM', 'c.mjs')]) });
  assert.deepEqual([fires.measured, fires.value, fires.fires], [true, -1, true]);
  const quiet = severityDrift({ round: 3, select, rounds: rounds([F('4', 'HIGH', 'a.mjs'), F('5', 'MEDIUM', 'b.mjs'), F('6', 'MEDIUM', 'c.mjs')]) });
  assert.deepEqual([quiet.value, quiet.fires], [0, false]);
  const few = severityDrift({ round: 3, select, rounds: rounds([F('4', 'MEDIUM', 'a.mjs')]) });
  assert.equal(few.measured, false); assert.match(few.reason, /only 1 file/);
});

test('severityDrift: even file count averages the two middle deltas', () => {
  const rounds = [
    { round: 2, findings: [F('1', 'HIGH', 'a.mjs'), F('2', 'HIGH', 'b.mjs')] },
    { round: 3, findings: [F('3', 'MEDIUM', 'a.mjs'), F('4', 'HIGH', 'b.mjs')] }, // -1, 0 -> -0.5
  ];
  const r = severityDrift({ round: 3, select, rounds });
  assert.deepEqual([r.value, r.fires], [-0.5, false]);
});

const entry = (topicId, outcome, files = ['a.mjs']) => ({ topicId, adjudicationOutcome: outcome, affectedFiles: files });

test('retired: fires only when <=1 for TWO consecutive rounds; unverified when file absent from the fix range', () => {
  const git = fakeGit({ diffs: { [`${S2}..${S3}`]: DIFF } });
  const rounds = [
    { round: 1, auditedSha: S1, findings: [F('t1', 'HIGH', 'a.mjs'), F('t2', 'HIGH', 'a.mjs'), F('t3', 'HIGH', 'a.mjs')] },
    { round: 2, auditedSha: S2, findings: [F('t2', 'HIGH', 'a.mjs'), F('t3', 'HIGH', 'a.mjs'), F('t4', 'HIGH', 'a.mjs'), F('t5', 'HIGH', 'z.mjs')] },
    { round: 3, auditedSha: S3, findings: [F('t3', 'HIGH', 'a.mjs'), F('t5', 'HIGH', 'z.mjs')] },
  ];
  const ledger = [entry('t1', 'accepted'), entry('t2', 'accepted'), entry('t3', 'dismissed'), entry('t4', 'accepted', ['z.mjs']), entry('t5', 'accepted', ['z.mjs'])];
  // retired(2): t1 accepted & gone from r2 -> 1. retired(3): t2, t4 accepted & gone from r3 -> 2 (t5 stays).
  const r = retired({ round: 3, select, rounds, ledgerEntries: ledger, topicOf, git });
  assert.equal(r.measured, true); assert.equal(r.value, 2); assert.equal(r.previous, 1); assert.equal(r.fires, false);
  // t4's file z.mjs is not in the fix range hunks (a.mjs, new/c.mjs, b.mjs) => unverified; t2's a.mjs is => verified.
  assert.equal(r.retiredUnverified, 1);

  const quietLedger = [entry('t1', 'accepted'), entry('t2', 'dismissed'), entry('t3', 'dismissed'), entry('t4', 'accepted', ['z.mjs']), entry('t5', 'accepted', ['z.mjs'])];
  const f = retired({ round: 3, select, rounds, ledgerEntries: quietLedger, topicOf, git });
  assert.deepEqual([f.value, f.previous, f.fires], [1, 1, true]);
});

test('retired: no ledger / untriaged previous round is unmeasured; git trouble keeps the count but nulls retiredUnverified', () => {
  const rounds = [
    { round: 1, auditedSha: S1, findings: [F('t1', 'HIGH', 'a.mjs')] },
    { round: 2, auditedSha: S2, findings: [F('t2', 'HIGH', 'a.mjs')] },
    { round: 3, auditedSha: S3, findings: [] },
  ];
  assert.equal(retired({ round: 3, select, rounds, ledgerEntries: null, topicOf, git: fakeGit() }).measured, false);
  assert.match(retired({ round: 3, select, rounds, ledgerEntries: [], topicOf, git: fakeGit() }).reason, /not triaged/);
  const r = retired({ round: 3, select, rounds, ledgerEntries: [entry('t1', 'accepted'), entry('t2', 'accepted')], topicOf, git: fakeGit({ notAncestor: true }) });
  assert.deepEqual([r.measured, r.value, r.retiredUnverified], [true, 1, null]);
});

test('retired: NOTHING OPEN to retire is unmeasured, never "0 retired, fires" (a converged audit is not stagnant)', () => {
  // Negative control (the defect, 2026-11-23): rounds 2 and 3 empty, one accepted topic in round 1 -> used to read measured, 0, FIRES.
  const converged = [
    { round: 1, auditedSha: S1, findings: [F('t1', 'HIGH', 'a.mjs')] },
    { round: 2, auditedSha: S2, findings: [] },
    { round: 3, auditedSha: S3, findings: [] },
  ];
  const r = retired({ round: 3, select, rounds: converged, ledgerEntries: [entry('t1', 'accepted')], topicOf, git: fakeGit() });
  assert.deepEqual([r.measured, r.fires], [false, false]);
  assert.match(r.reason, /nothing open to retire/);
  // Only dismissed topics open in the previous round: nothing to retire either.
  const dismissedOnly = [
    { round: 1, auditedSha: S1, findings: [F('t1', 'HIGH', 'a.mjs')] },
    { round: 2, auditedSha: S2, findings: [F('t2', 'HIGH', 'a.mjs')] },
    { round: 3, auditedSha: S3, findings: [F('t2', 'HIGH', 'a.mjs')] },
  ];
  const d = retired({ round: 3, select, rounds: dismissedOnly, ledgerEntries: [entry('t1', 'accepted'), entry('t2', 'dismissed')], topicOf, git: fakeGit() });
  assert.equal(d.measured, false); assert.match(d.reason, /nothing open to retire/);
  // Positive control: genuine stagnation (accepted topics open in both previous rounds, none closed) still FIRES.
  const stuck = [
    { round: 1, auditedSha: S1, findings: [F('t1', 'HIGH', 'a.mjs')] },
    { round: 2, auditedSha: S2, findings: [F('t1', 'HIGH', 'a.mjs')] },
    { round: 3, auditedSha: S3, findings: [F('t1', 'HIGH', 'a.mjs')] },
  ];
  const s = retired({ round: 3, select, rounds: stuck, ledgerEntries: [entry('t1', 'accepted')], topicOf, git: fakeGit() });
  assert.deepEqual([s.measured, s.value, s.previous, s.fires], [true, 0, 0, true]);
});

test('importanceSelector: tag present -> importance; absent -> severity-proxy (>= MEDIUM only)', () => {
  const a = importanceSelector([[{ importance: 'important', severity: 'LOW' }, { importance: 'nit', severity: 'HIGH' }]]);
  assert.equal(a.importanceSource, 'importance');
  assert.equal(a.select([{ importance: 'important', severity: 'LOW' }, { importance: 'nit', severity: 'HIGH' }]).length, 1);
  const b = importanceSelector([[{ severity: 'HIGH' }]]);
  assert.equal(b.importanceSource, 'severity-proxy');
  assert.equal(b.select([{ severity: 'LOW' }, { severity: 'MEDIUM' }]).length, 1);
});

test('computeRoundSignals reads nothing after the checkpoint and lists unmeasured signals; the render says so', () => {
  const rounds = [
    { round: 2, auditedSha: S2, findings: [F('1', 'HIGH', 'a.mjs', 12)] },
    { round: 3, auditedSha: S3, findings: [F('2', 'HIGH', 'a.mjs', 12)] },
    { round: 4, auditedSha: null, findings: [F('LATE', 'HIGH', 'a.mjs', 12)] },
  ];
  const calls = [];
  const s = computeRoundSignals({ round: 3, rounds, ledgerEntries: null, topicOf, git: fakeGit({ diffs: { [`${S2}..${S3}`]: DIFF }, calls }) });
  assert.equal(s.version, ROUND_SIGNALS_VERSION);
  assert.equal(s.signals.reopenRate.value, 1); assert.equal(s.signals.reopenRate.fires, true);
  assert.equal(s.anyFires, true);
  assert.ok(s.unmeasured.includes('retired'));
  assert.equal(s.signals.retired.fires, false);
  assert.match(renderRoundSignals(s), /UNMEASURED/);
  assert.equal(SIGNAL_THRESHOLDS.reopenRate, 0.5);
});
