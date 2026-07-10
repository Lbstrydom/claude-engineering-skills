/**
 * Tier-1 tests for the Stage 1 mechanical-dismissal ledger routing (tiered-
 * recall pipeline, Cluster D scoped Phase 8). Plan:
 * docs/plans/tiered-recall-audit-pipeline.md.
 * Covers: writeStage1MechanicalLedgerEntry's schema validation + write
 * mechanics, and suppressReRaises' source-aware routing (flows through the
 * fuzzy/reopen path like session, excluded from overruleCountIndex).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeStage1MechanicalLedgerEntry, suppressReRaises, finalizeLedgerOutcomes } from '../scripts/lib/ledger.mjs';

const mkEntry = (overrides = {}) => ({
  topicId: 'topic-1', semanticHash: 'hash1', severity: 'MEDIUM',
  category: 'Dead Code', section: 'src/foo.js:10', detailSnapshot: 'foo() is never called',
  affectedFiles: ['src/foo.js'], affectedPrinciples: [], pass: 'sustainability',
  source: 'stage1-mechanical', adjudicationOutcome: 'dismissed', remediationState: 'pending',
  disproof: 'grep confirms foo() has zero call sites in the diff',
  resolvedRound: 1,
  ...overrides,
});

describe('writeStage1MechanicalLedgerEntry', () => {
  let ledgerPath;
  before(() => { ledgerPath = path.join(os.tmpdir(), `stage1-ledger-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`); });
  after(() => { try { fs.unlinkSync(ledgerPath); } catch { /* ignore */ } });

  it('writes a valid entry and persists it', () => {
    writeStage1MechanicalLedgerEntry(ledgerPath, mkEntry());
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0].source, 'stage1-mechanical');
    assert.equal(ledger.entries[0].disproof, 'grep confirms foo() has zero call sites in the diff');
  });

  it('upserts by topicId rather than appending a duplicate', () => {
    writeStage1MechanicalLedgerEntry(ledgerPath, mkEntry({ detailSnapshot: 'updated detail' }));
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0].detailSnapshot, 'updated detail');
  });

  it('refuses to write an entry missing disproof (schema-invalid)', () => {
    const before2 = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')).entries.length : 0;
    const invalidPath = path.join(os.tmpdir(), `stage1-ledger-invalid-${Date.now()}.json`);
    writeStage1MechanicalLedgerEntry(invalidPath, mkEntry({ disproof: '', topicId: 'topic-invalid' }));
    assert.equal(fs.existsSync(invalidPath), false); // never created — write refused before any file I/O
  });

  it('refuses to write an entry with a non-dismissed adjudicationOutcome (schema requires literal dismissed)', () => {
    const invalidPath = path.join(os.tmpdir(), `stage1-ledger-invalid2-${Date.now()}.json`);
    writeStage1MechanicalLedgerEntry(invalidPath, mkEntry({ adjudicationOutcome: 'accepted', topicId: 'topic-invalid-2' }));
    assert.equal(fs.existsSync(invalidPath), false);
  });
});

describe('suppressReRaises — stage1-mechanical source routing', () => {
  const mkFinding = (overrides = {}) => ({
    category: 'Dead Code', section: 'src/foo.js:10', detail: 'foo() is never called',
    _pass: 'sustainability', _primaryFile: 'src/foo.js',
    ...overrides,
  });

  it('a stage1-mechanical entry suppresses a matching re-raise, same as a session entry would', () => {
    const ledger = { entries: [mkEntry()] };
    const { kept, suppressed } = suppressReRaises([mkFinding()], ledger, { changedFiles: [] });
    assert.equal(suppressed.length, 1);
    assert.equal(kept.length, 0);
  });

  it('a stage1-mechanical entry reopens when its file is in the changed set (scope directly changed)', () => {
    const ledger = { entries: [mkEntry()] };
    const { reopened } = suppressReRaises([mkFinding()], ledger, { changedFiles: ['src/foo.js'] });
    assert.equal(reopened.length, 1);
  });

  it('does NOT count a stage1-mechanical entry toward overruleCountIndex — 3 mechanical dismissals do not hard-suppress', () => {
    const entries = [
      mkEntry({ topicId: 't1' }),
      mkEntry({ topicId: 't2' }),
      mkEntry({ topicId: 't3' }),
    ];
    const ledger = { entries };
    // A 4th, textually-DIFFERENT finding in the same category+file should NOT be
    // hard-suppressed by ruling-count (it would be, if these 3 counted toward it) —
    // it should instead go through normal fuzzy-match scoring, which won't match
    // (score too low against the 3 dissimilar existing entries) and gets kept.
    const newFinding = mkFinding({ detail: 'a completely different concern about bar() unrelated to foo()' });
    const { kept, suppressed } = suppressReRaises([newFinding], ledger, { changedFiles: [] });
    const hardSuppressed = suppressed.find((s) => s.matchedSource === 'ruling-count');
    assert.equal(hardSuppressed, undefined);
  });

  it('a session entry with adjudicationOutcome=dismissed STILL counts toward overruleCountIndex (no regression to existing behavior)', () => {
    const sessionEntry = {
      topicId: 's1', semanticHash: 'h1', severity: 'MEDIUM', category: 'Dead Code',
      section: 'src/bar.js:5', detailSnapshot: 'bar unused', affectedFiles: ['src/bar.js'],
      affectedPrinciples: [], pass: 'sustainability', source: 'session',
      adjudicationOutcome: 'dismissed', remediationState: 'pending', originalSeverity: 'MEDIUM',
      ruling: 'overrule', rulingRationale: 'r', resolvedRound: 1,
    };
    const ledger = { entries: [sessionEntry, sessionEntry, sessionEntry].map((e, i) => ({ ...e, topicId: `s${i}` })) };
    const newFinding = { category: 'Dead Code', section: 'src/bar.js:5', detail: 'unrelated new text', _pass: 'sustainability', _primaryFile: 'src/bar.js' };
    const { suppressed } = suppressReRaises([newFinding], ledger, { changedFiles: [] });
    const hardSuppressed = suppressed.find((s) => s.matchedSource === 'ruling-count');
    assert.ok(hardSuppressed, 'existing overrule-count hard-suppress behavior must be unchanged for session entries');
  });
});

describe('finalizeLedgerOutcomes — Stage 2 terminal step (Phase 9)', () => {
  it('a reversed envelope produces a mark-regressed ledger update', () => {
    const envelope = { canonicalFinding: { _stage1LedgerTopicId: 't1' }, fingerprint: 'fp1' };
    const { ledgerUpdates } = finalizeLedgerOutcomes({ reversed: [envelope], confirmedDismissal: [], verified: [], missedCandidates: [] });
    assert.equal(ledgerUpdates.length, 1);
    assert.equal(ledgerUpdates[0].action, 'mark-regressed');
    assert.equal(ledgerUpdates[0].topicId, 't1');
  });

  it('a confirmed-dismissal envelope produces a confirm-dismissal ledger update', () => {
    const envelope = { canonicalFinding: { _stage1LedgerTopicId: 't2' }, fingerprint: 'fp2' };
    const { ledgerUpdates } = finalizeLedgerOutcomes({ reversed: [], confirmedDismissal: [envelope], verified: [], missedCandidates: [] });
    assert.equal(ledgerUpdates.length, 1);
    assert.equal(ledgerUpdates[0].action, 'confirm-dismissal');
  });

  it('a verified envelope produces NO ledger update (it was never dismissed)', () => {
    const envelope = { canonicalFinding: {}, fingerprint: 'fp3' };
    const { ledgerUpdates } = finalizeLedgerOutcomes({ reversed: [], confirmedDismissal: [], verified: [envelope], missedCandidates: [] });
    assert.equal(ledgerUpdates.length, 0);
  });

  it('missed candidates are surfaced as newCandidates, never as a ledger write', () => {
    const { ledgerUpdates, newCandidates } = finalizeLedgerOutcomes({
      reversed: [], confirmedDismissal: [], verified: [],
      missedCandidates: [{ file: 'clean.js', finding: { detail: 'a real bug' } }],
    });
    assert.equal(ledgerUpdates.length, 0);
    assert.equal(newCandidates.length, 1);
    assert.equal(newCandidates[0].file, 'clean.js');
  });

  it('handles all-empty input without throwing', () => {
    const result = finalizeLedgerOutcomes({ reversed: [], confirmedDismissal: [], verified: [], missedCandidates: [] });
    assert.deepEqual(result.ledgerUpdates, []);
    assert.deepEqual(result.newCandidates, []);
  });
});
