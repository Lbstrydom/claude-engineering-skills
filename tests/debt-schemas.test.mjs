/**
 * @fileoverview Phase D — schema tests.
 * Covers persisted/hydrated split, per-reason required fields, source markers.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PersistedDebtEntrySchema,
  HydratedDebtEntrySchema,
  DebtEntrySchema,
  DebtEventSchema,
  DebtLedgerSchema,
  LedgerEntrySchema,
  DeferredReasonEnum,
  ClusterSchema,
  RefactorCandidateSchema,
  DebtReviewResultSchema,
} from '../scripts/lib/schemas.mjs';

const baseEntry = {
  source: 'debt',
  topicId: 'abc12345',
  semanticHash: 'hash01',
  severity: 'HIGH',
  category: 'Test Category',
  section: 'src/x.js:10',
  detailSnapshot: 'some details about the finding',
  affectedFiles: ['src/x.js'],
  affectedPrinciples: ['SRP'],
  pass: 'backend',
  deferredReason: 'out-of-scope',
  deferredAt: '2026-04-05T10:00:00.000Z',
  deferredRun: 'audit-r1',
  deferredRationale: 'this is a sufficiently long rationale string',
  contentAliases: [],
  sensitive: false,
  // §2 Fix A — classification-or-explicit-unavailable disjunction
  // (docs/plans/debt-ledger-persisted-record-contract.md): every persisted
  // entry needs one of `classification` / `classificationUnavailableReason`.
  classificationUnavailableReason: 'not-provided-by-capture-source',
};

test('PersistedDebtEntrySchema — accepts valid out-of-scope entry', () => {
  const r = PersistedDebtEntrySchema.safeParse(baseEntry);
  assert.equal(r.success, true, r.error?.message);
});

test('PersistedDebtEntrySchema — rejects deferredRationale < 20 chars', () => {
  const r = PersistedDebtEntrySchema.safeParse({ ...baseEntry, deferredRationale: 'too short' });
  assert.equal(r.success, false);
});

test('PersistedDebtEntrySchema — rejects invalid deferredReason', () => {
  const r = PersistedDebtEntrySchema.safeParse({ ...baseEntry, deferredReason: 'lazy' });
  assert.equal(r.success, false);
});

test('PersistedDebtEntrySchema — blocked-by without blockedBy fails', () => {
  const r = PersistedDebtEntrySchema.safeParse({ ...baseEntry, deferredReason: 'blocked-by' });
  assert.equal(r.success, false);
  assert.match(r.error.message, /blockedBy/);
});

test('PersistedDebtEntrySchema — blocked-by with blockedBy passes', () => {
  const r = PersistedDebtEntrySchema.safeParse({
    ...baseEntry, deferredReason: 'blocked-by', blockedBy: 'owner/repo#42',
  });
  assert.equal(r.success, true, r.error?.message);
});

test('PersistedDebtEntrySchema — deferred-followup without followupPr fails', () => {
  const r = PersistedDebtEntrySchema.safeParse({ ...baseEntry, deferredReason: 'deferred-followup' });
  assert.equal(r.success, false);
  assert.match(r.error.message, /followupPr/);
});

test('PersistedDebtEntrySchema — accepted-permanent requires approver AND approvedAt', () => {
  const missing = PersistedDebtEntrySchema.safeParse({
    ...baseEntry, deferredReason: 'accepted-permanent', approver: 'alice',
  });
  assert.equal(missing.success, false);
  assert.match(missing.error.message, /approvedAt/);

  const complete = PersistedDebtEntrySchema.safeParse({
    ...baseEntry,
    deferredReason: 'accepted-permanent',
    approver: 'alice',
    approvedAt: '2026-04-05T10:00:00.000Z',
  });
  assert.equal(complete.success, true, complete.error?.message);
});

test('PersistedDebtEntrySchema — policy-exception requires policyRef AND approver', () => {
  const r = PersistedDebtEntrySchema.safeParse({
    ...baseEntry, deferredReason: 'policy-exception', policyRef: 'SEC-001', approver: 'alice',
  });
  assert.equal(r.success, true, r.error?.message);
});

test('PersistedDebtEntrySchema — source must be literal "debt"', () => {
  const r = PersistedDebtEntrySchema.safeParse({ ...baseEntry, source: 'session' });
  assert.equal(r.success, false);
});

// ── §2 Fix A — classification-or-explicit-unavailable disjunction ──────────
// docs/plans/debt-ledger-persisted-record-contract.md

test('PersistedDebtEntrySchema — rejects an entry with neither classification nor classificationUnavailableReason', () => {
  const { classificationUnavailableReason, ...withoutReason } = baseEntry;
  const r = PersistedDebtEntrySchema.safeParse(withoutReason);
  assert.equal(r.success, false);
  assert.match(r.error.message, /classification/);
});

test('PersistedDebtEntrySchema — accepts an entry with a real classification and no reason', () => {
  const { classificationUnavailableReason, ...withoutReason } = baseEntry;
  const r = PersistedDebtEntrySchema.safeParse({
    ...withoutReason,
    classification: { sonarType: 'BUG', effort: 'EASY', sourceKind: 'MODEL', sourceName: 'gpt-5.6' },
  });
  assert.equal(r.success, true, r.error?.message);
});

test('PersistedDebtEntrySchema — rejects a blank/whitespace-only classificationUnavailableReason (M3)', () => {
  const r = PersistedDebtEntrySchema.safeParse({ ...baseEntry, classificationUnavailableReason: '   ' });
  assert.equal(r.success, false);
});

test('PersistedDebtEntrySchema — supersededBy cannot equal the entry\'s own topicId', () => {
  const r = PersistedDebtEntrySchema.safeParse({ ...baseEntry, supersededBy: baseEntry.topicId });
  assert.equal(r.success, false);
  assert.match(r.error.message, /supersededBy/);
});

test('PersistedDebtEntrySchema — supersededBy naming a DIFFERENT topicId passes', () => {
  const r = PersistedDebtEntrySchema.safeParse({ ...baseEntry, supersededBy: 'other-topic-99' });
  assert.equal(r.success, true, r.error?.message);
});

describe('normalizeClassificationEnvelope', () => {
  test('no-op when classification is already present', async () => {
    const { normalizeClassificationEnvelope } = await import('../scripts/lib/schemas.mjs');
    const entry = { ...baseEntry, classification: { sonarType: 'BUG', effort: 'EASY', sourceKind: 'MODEL', sourceName: 'x' } };
    delete entry.classificationUnavailableReason;
    assert.deepEqual(normalizeClassificationEnvelope(entry), entry);
  });

  test('no-op when classificationUnavailableReason is already a non-blank string', async () => {
    const { normalizeClassificationEnvelope } = await import('../scripts/lib/schemas.mjs');
    const entry = { ...baseEntry, classificationUnavailableReason: 'legacy-backfill' };
    assert.deepEqual(normalizeClassificationEnvelope(entry), entry);
  });

  test('injects a default reason when both classification and reason are absent', async () => {
    const { normalizeClassificationEnvelope } = await import('../scripts/lib/schemas.mjs');
    const { classificationUnavailableReason, ...withoutReason } = baseEntry;
    const result = normalizeClassificationEnvelope(withoutReason);
    assert.equal(result.classificationUnavailableReason, 'not-provided-by-capture-source');
  });

  test('a blank/whitespace-only reason is NOT treated as already-set — the default is still injected', async () => {
    const { normalizeClassificationEnvelope } = await import('../scripts/lib/schemas.mjs');
    const result = normalizeClassificationEnvelope({ ...baseEntry, classificationUnavailableReason: '   ' });
    assert.equal(result.classificationUnavailableReason, 'not-provided-by-capture-source');
  });
});

test('HydratedDebtEntrySchema — accepts derived fields', () => {
  const r = HydratedDebtEntrySchema.safeParse({
    ...baseEntry,
    occurrences: 3,
    distinctRunCount: 3,
    matchCount: 7,
    lastSurfacedRun: 'audit-r5',
    lastSurfacedAt: '2026-04-05T15:00:00.000Z',
    escalated: true,
    escalatedAt: '2026-04-05T16:00:00.000Z',
  });
  assert.equal(r.success, true, r.error?.message);
});

test('HydratedDebtEntrySchema — derived fields default to 0/false when absent', () => {
  const r = HydratedDebtEntrySchema.safeParse(baseEntry);
  assert.equal(r.success, true);
  assert.equal(r.data.occurrences, 0);
  assert.equal(r.data.distinctRunCount, 0);
  assert.equal(r.data.matchCount, 0);
  assert.equal(r.data.escalated, false);
});

test('DebtEntrySchema === HydratedDebtEntrySchema (alias)', () => {
  assert.equal(DebtEntrySchema, HydratedDebtEntrySchema);
});

test('DebtEventSchema — accepts all event types', () => {
  const events = ['deferred', 'surfaced', 'reopened', 'escalated', 'resolved', 'reconciled'];
  for (const ev of events) {
    const r = DebtEventSchema.safeParse({
      ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'a', event: ev,
    });
    assert.equal(r.success, true, `event=${ev}: ${r.error?.message}`);
  }
});

test('DebtEventSchema — rejects invalid event type', () => {
  const r = DebtEventSchema.safeParse({
    ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'a', event: 'frozen',
  });
  assert.equal(r.success, false);
});

test('DebtEventSchema — topicId optional (for reconciled markers)', () => {
  const r = DebtEventSchema.safeParse({
    ts: '2026-04-05T10:00:00.000Z', runId: 'r1', event: 'reconciled',
  });
  assert.equal(r.success, true, r.error?.message);
});

test('DebtEventSchema — surfaced may carry matchCount', () => {
  const r = DebtEventSchema.safeParse({
    ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'a', event: 'surfaced', matchCount: 3,
  });
  assert.equal(r.success, true);
  assert.equal(r.data.matchCount, 3);
});

test('LedgerEntrySchema — backward compat (source defaults to "session")', () => {
  // Old ledger without source field should still validate
  const r = LedgerEntrySchema.safeParse({
    topicId: 'a', semanticHash: 'b',
    adjudicationOutcome: 'dismissed', remediationState: 'pending',
    severity: 'HIGH', originalSeverity: 'HIGH',
    category: 'c', section: 's', detailSnapshot: 'd',
    affectedFiles: [], affectedPrinciples: [],
    ruling: 'sustain', rulingRationale: 'r',
    resolvedRound: 1, pass: 'p',
  });
  assert.equal(r.success, true, r.error?.message);
  assert.equal(r.data.source, 'session');
});

test('DebtLedgerSchema — accepts empty ledger', () => {
  const r = DebtLedgerSchema.safeParse({ version: 1, entries: [] });
  assert.equal(r.success, true);
});

test('DebtLedgerSchema — rejects version != 1', () => {
  const r = DebtLedgerSchema.safeParse({ version: 2, entries: [] });
  assert.equal(r.success, false);
});

test('DebtLedgerSchema — budgets map accepts globs with numbers', () => {
  const r = DebtLedgerSchema.safeParse({
    version: 1,
    entries: [],
    budgets: { 'scripts/lib/**': 20, 'scripts/openai-audit.mjs': 5 },
  });
  assert.equal(r.success, true);
});

test('DeferredReasonEnum — 5 valid reasons', () => {
  assert.deepEqual(DeferredReasonEnum.options.sort(), [
    'accepted-permanent', 'blocked-by', 'deferred-followup', 'out-of-scope', 'policy-exception',
  ]);
});

// ── Debt Review Schemas ─────────────────────────────────────────────────────

test('ClusterSchema — valid file cluster', () => {
  const r = ClusterSchema.safeParse({
    id: 'file:src/x.js',
    title: 'src/x.js — 3 entries',
    kind: 'file',
    entries: ['t1', 't2', 't3'],
    rationale: 'Three debt entries cite this module, candidate for refactor.',
  });
  assert.equal(r.success, true, r.error?.message);
});

test('ClusterSchema — rejects invalid kind', () => {
  const r = ClusterSchema.safeParse({
    id: 'x', title: 't', kind: 'lolwhat', entries: [], rationale: 'r',
  });
  assert.equal(r.success, false);
});

test('RefactorCandidateSchema — valid candidate', () => {
  const r = RefactorCandidateSchema.safeParse({
    clusterId: 'file:src/x.js',
    targetModules: ['src/x.js'],
    resolvedTopicIds: ['t1', 't2'],
    effortEstimate: 'MEDIUM',
    effortRationale: 'Extracting helper module touches 3 call sites.',
    risks: ['Break callers relying on internal exports'],
    rollbackStrategy: 'Revert commit, restore old module.',
  });
  assert.equal(r.success, true, r.error?.message);
});

test('RefactorCandidateSchema — rejects invalid effort', () => {
  const r = RefactorCandidateSchema.safeParse({
    clusterId: 'x', targetModules: [], resolvedTopicIds: [],
    effortEstimate: 'EASY_PEASY',
    effortRationale: 'r', risks: [], rollbackStrategy: 'r',
  });
  assert.equal(r.success, false);
});

test('DebtReviewResultSchema — valid full result', () => {
  const r = DebtReviewResultSchema.safeParse({
    summary: { totalEntries: 5, clustersIdentified: 2, oldestEntryDays: 90, staleEntries: [] },
    clusters: [],
    refactorPlan: [],
    reasoning: 'Quiet ledger, no refactor needed.',
  });
  assert.equal(r.success, true, r.error?.message);
});

test('DebtReviewResultSchema — rejects missing summary', () => {
  const r = DebtReviewResultSchema.safeParse({
    clusters: [], refactorPlan: [], reasoning: 'r',
  });
  assert.equal(r.success, false);
});
