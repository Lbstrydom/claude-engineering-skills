/**
 * Gate-honesty matrix for computeFixLifecycleUpdates (fix-lifecycle plan §9).
 * The predicate is the whole ballgame: over-marking inverts the vacuous-green.
 * Each case is a fixture ledger entry + synthetic current-round findings + a
 * changedFiles set → the expected transition (or none).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFixLifecycleUpdates, applyLifecycleUpdates } from '../scripts/lib/ledger.mjs';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const FILE = 'src/a.mjs';
const TEXT = { category: 'Null deref', section: 'src/a.mjs:10', detail: 'null dereference on user input in the parse path' };

const ledgerEntry = (o) => ({
  topicId: o.topicId ?? 't1', semanticHash: o.hash ?? 'fp-1',
  pass: 'backend', category: TEXT.category, section: TEXT.section,
  detailSnapshot: TEXT.detail, affectedFiles: [FILE],
  affectedPrinciples: [], source: o.source ?? 'session',
  adjudicationOutcome: o.adj, remediationState: o.rem,
  originalSeverity: 'HIGH', severity: 'HIGH', ruling: 'sustain',
  rulingRationale: 'x', resolvedRound: 1,
});
const currentMatch = () => [{ ...TEXT, _pass: 'backend', _primaryFile: FILE, _hash: 'fp-1' }];

function run({ adj, rem, source, changed, current }) {
  const ledger = { entries: [ledgerEntry({ adj, rem, source })] };
  const { updates } = computeFixLifecycleUpdates(ledger, current ?? [], changed ?? [], 2);
  return updates;
}

// ── A1 pending → fixed matrix ──────────────────────────────────────────────
test('1. accepted + scope changed + no longer raised → fixed', () => {
  const u = run({ adj: 'accepted', rem: 'pending', changed: [FILE], current: [] });
  assert.equal(u.length, 1); assert.equal(u[0].action, 'mark-fixed');
  assert.equal(u[0].findingFingerprint, 'fp-1');
});
test('2. accepted + scope UNCHANGED + not raised → no transition (flaky-omission guard)', () => {
  assert.equal(run({ adj: 'accepted', rem: 'pending', changed: [], current: [] }).length, 0);
});
test('3. accepted + scope changed + STILL raised → no fix (still open)', () => {
  const u = run({ adj: 'accepted', rem: 'pending', changed: [FILE], current: currentMatch() });
  assert.equal(u.length, 0);
});
test('4. dismissed disappearing → never fixed', () => {
  assert.equal(run({ adj: 'dismissed', rem: 'pending', changed: [FILE], current: [] }).length, 0);
});
test('5. severity_adjusted + scope changed + gone → fixed (Gemini-gate G2)', () => {
  const u = run({ adj: 'severity_adjusted', rem: 'pending', changed: [FILE], current: [] });
  assert.equal(u.length, 1); assert.equal(u[0].action, 'mark-fixed');
});
test('6. already fixed + gone → no duplicate transition (idempotent)', () => {
  assert.equal(run({ adj: 'accepted', rem: 'fixed', changed: [FILE], current: [] }).length, 0);
});
test('7. debt source → never fixed', () => {
  assert.equal(run({ adj: 'accepted', rem: 'pending', source: 'debt', changed: [FILE], current: [] }).length, 0);
});
test('8. stage1-mechanical source → never fixed', () => {
  assert.equal(run({ adj: 'accepted', rem: 'pending', source: 'stage1-mechanical', changed: [FILE], current: [] }).length, 0);
});

// ── A2 fixed → regressed matrix ────────────────────────────────────────────
test('9. fixed + scope changed + re-raised → regressed', () => {
  const u = run({ adj: 'accepted', rem: 'fixed', changed: [FILE], current: currentMatch() });
  assert.equal(u.length, 1); assert.equal(u[0].action, 'mark-regressed');
});
test('10. fixed + re-raised but scope UNCHANGED → no regression (would be suppressed)', () => {
  assert.equal(run({ adj: 'accepted', rem: 'fixed', changed: [], current: currentMatch() }).length, 0);
});
test('11. fixed + scope changed + NOT re-raised → stays fixed', () => {
  assert.equal(run({ adj: 'accepted', rem: 'fixed', changed: [FILE], current: [] }).length, 0);
});
test('12. regressed + scope changed + gone → re-fixed (A1 regressed branch)', () => {
  const u = run({ adj: 'accepted', rem: 'regressed', changed: [FILE], current: [] });
  assert.equal(u.length, 1); assert.equal(u[0].action, 'mark-fixed');
});

// ── applyLifecycleUpdates: conditional apply + no adjudication crosstalk ────
test('apply commits mark-fixed and leaves adjudicationOutcome untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-'));
  try {
    const p = join(dir, 'ledger.json');
    writeFileSync(p, JSON.stringify({ version: 1, entries: [ledgerEntry({ adj: 'severity_adjusted', rem: 'pending' })] }));
    const { committed } = applyLifecycleUpdates(p, [{ action: 'mark-fixed', topicId: 't1', resolvedRound: 2 }]);
    assert.equal(committed.length, 1);
    const e = JSON.parse(readFileSync(p, 'utf8')).entries[0];
    assert.equal(e.remediationState, 'fixed');
    assert.equal(e.adjudicationOutcome, 'severity_adjusted', 'A must NOT rewrite the adjudication axis');
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});
test('apply mark-regressed sets regressed WITHOUT touching adjudicationOutcome (Gemini-gate-2)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-'));
  try {
    const p = join(dir, 'ledger.json');
    writeFileSync(p, JSON.stringify({ version: 1, entries: [ledgerEntry({ adj: 'accepted', rem: 'fixed' })] }));
    const { committed } = applyLifecycleUpdates(p, [{ action: 'mark-regressed', topicId: 't1', resolvedRound: 2 }]);
    assert.equal(committed.length, 1);
    const e = JSON.parse(readFileSync(p, 'utf8')).entries[0];
    assert.equal(e.remediationState, 'regressed');
    assert.equal(e.adjudicationOutcome, 'accepted');
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});
test('apply skips (no clobber) when the on-disk entry no longer satisfies the guard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-'));
  try {
    const p = join(dir, 'ledger.json');
    // Entry already fixed on disk → a stale mark-fixed must be skipped, not re-applied.
    writeFileSync(p, JSON.stringify({ version: 1, entries: [ledgerEntry({ adj: 'accepted', rem: 'fixed' })] }));
    const { committed } = applyLifecycleUpdates(p, [{ action: 'mark-fixed', topicId: 't1', resolvedRound: 9 }]);
    assert.equal(committed.length, 0, 'stale update must be skipped');
    const e = JSON.parse(readFileSync(p, 'utf8')).entries[0];
    assert.equal(e.resolvedRound, 1, 'must not have rewritten the entry');
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});
