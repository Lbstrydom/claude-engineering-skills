/**
 * @fileoverview Phase D — debt-capture tests.
 * Verifies the finding→debt transform: sensitivity detection, secret redaction,
 * per-reason field pass-through, and triage suggestions.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeSensitivity,
  buildDebtEntry,
  suggestDeferralCandidate,
} from '../scripts/lib/debt-capture.mjs';
import { PersistedDebtEntrySchema } from '../scripts/lib/schemas.mjs';

const benignFinding = {
  _hash: 'abcd1234',
  _primaryFile: 'src/regular.js',
  _pass: 'backend',
  affectedFiles: ['src/regular.js'],
  affectedPrinciples: ['DRY'],
  severity: 'MEDIUM',
  category: 'Code Smell',
  section: 'src/regular.js:42',
  detail: 'some repeated pattern across three helpers — refactor to shared util',
  principle: 'DRY',
  classification: {
    sonarType: 'CODE_SMELL',
    effort: 'EASY',
    sourceKind: 'MODEL',
    sourceName: 'gpt-5.4',
  },
};

const baseCaptureArgs = {
  deferredReason: 'out-of-scope',
  deferredRationale: 'pre-existing concern, not in this phase scope for refactor',
  deferredRun: 'audit-123',
};

// ── computeSensitivity ──────────────────────────────────────────────────────

describe('computeSensitivity', () => {
  test('benign finding → not sensitive', () => {
    const r = computeSensitivity(benignFinding);
    assert.equal(r.sensitive, false);
    assert.deepEqual(r.reasons, []);
  });

  test('sensitive file path flags sensitive', () => {
    const f = { ...benignFinding, affectedFiles: ['.env'] };
    const r = computeSensitivity(f);
    assert.equal(r.sensitive, true);
    assert.ok(r.reasons.some(x => x.startsWith('path:')));
  });

  test('secret in detail flags sensitive', () => {
    const f = { ...benignFinding, detail: 'found api_key=sk-abc123def456ghi789jkl012mno345 in code' };
    const r = computeSensitivity(f);
    assert.equal(r.sensitive, true);
    assert.ok(r.reasons.some(x => x.startsWith('content:detail:')));
  });

  test('secret in category flags sensitive', () => {
    const f = { ...benignFinding, category: 'leaked AKIAIOSFODNN7EXAMPLE' };
    const r = computeSensitivity(f);
    assert.equal(r.sensitive, true);
  });
});

// ── buildDebtEntry ──────────────────────────────────────────────────────────

describe('buildDebtEntry', () => {
  test('benign finding → valid PersistedDebtEntry', () => {
    const { entry, sensitivity, redactions } = buildDebtEntry(benignFinding, baseCaptureArgs);
    assert.equal(sensitivity.sensitive, false);
    assert.equal(redactions.length, 0);
    assert.equal(entry.source, 'debt');
    assert.equal(entry.topicId, 'abcd1234');
    assert.equal(entry.sensitive, false);
    assert.equal(entry.deferredReason, 'out-of-scope');
    const parsed = PersistedDebtEntrySchema.safeParse(entry);
    assert.equal(parsed.success, true, parsed.error?.message);
  });

  test('redacts secrets in detail BEFORE persistence', () => {
    const f = { ...benignFinding, detail: 'leaked api_key=sk-abc123def456ghi789jkl012mno345 badly' };
    const { entry, redactions } = buildDebtEntry(f, baseCaptureArgs);
    assert.match(entry.detailSnapshot, /\[REDACTED:openai-key\]/);
    assert.equal(entry.detailSnapshot.includes('sk-abc123'), false);
    assert.equal(entry.sensitive, true);
    assert.ok(redactions.some(r => r.field === 'detail'));
  });

  test('redacts secrets in deferredRationale too', () => {
    const { entry, redactions } = buildDebtEntry(benignFinding, {
      ...baseCaptureArgs,
      deferredRationale: 'leaked sk-abc123def456ghi789jkl012mno345 in the old code, deferred',
    });
    assert.match(entry.deferredRationale, /REDACTED/);
    assert.equal(entry.sensitive, true);
    assert.ok(redactions.some(r => r.field === 'deferredRationale'));
  });

  test('path-based sensitive flag persists', () => {
    const f = { ...benignFinding, affectedFiles: ['.env.production'] };
    const { entry, sensitivity } = buildDebtEntry(f, baseCaptureArgs);
    assert.equal(entry.sensitive, true);
    assert.equal(sensitivity.sensitive, true);
  });

  test('blocked-by reason requires blockedBy field', () => {
    const { entry } = buildDebtEntry(benignFinding, {
      ...baseCaptureArgs,
      deferredReason: 'blocked-by',
      blockedBy: 'owner/repo#42',
    });
    assert.equal(entry.deferredReason, 'blocked-by');
    assert.equal(entry.blockedBy, 'owner/repo#42');
    const parsed = PersistedDebtEntrySchema.safeParse(entry);
    assert.equal(parsed.success, true, parsed.error?.message);
  });

  test('accepted-permanent requires approver + approvedAt', () => {
    const { entry } = buildDebtEntry(benignFinding, {
      ...baseCaptureArgs,
      deferredReason: 'accepted-permanent',
      approver: 'alice',
      approvedAt: '2026-04-05T12:00:00.000Z',
    });
    const parsed = PersistedDebtEntrySchema.safeParse(entry);
    assert.equal(parsed.success, true, parsed.error?.message);
  });

  test('detailSnapshot truncated to 600 chars', () => {
    const long = 'x'.repeat(1000);
    const f = { ...benignFinding, detail: long };
    const { entry } = buildDebtEntry(f, baseCaptureArgs);
    assert.equal(entry.detailSnapshot.length, 600);
  });

  test('classification envelope copied from finding', () => {
    const { entry } = buildDebtEntry(benignFinding, baseCaptureArgs);
    assert.deepEqual(entry.classification, benignFinding.classification);
  });

  test('deferredAt is ISO timestamp', () => {
    const { entry } = buildDebtEntry(benignFinding, baseCaptureArgs);
    assert.ok(!Number.isNaN(Date.parse(entry.deferredAt)));
  });

  test('affectedFiles defaults to _primaryFile when absent', () => {
    const f = { ...benignFinding, affectedFiles: undefined, _primaryFile: 'src/only.js' };
    const { entry } = buildDebtEntry(f, baseCaptureArgs);
    assert.deepEqual(entry.affectedFiles, ['src/only.js']);
  });

  test('empty contentAliases on fresh entry', () => {
    const { entry } = buildDebtEntry(benignFinding, baseCaptureArgs);
    assert.deepEqual(entry.contentAliases, []);
  });
});

// ── suggestDeferralCandidate ────────────────────────────────────────────────

describe('suggestDeferralCandidate', () => {
  test('out-of-scope finding → candidate', () => {
    const r = suggestDeferralCandidate(
      { severity: 'HIGH', _primaryFile: 'src/legacy.js', affectedFiles: ['src/legacy.js'] },
      { changedFiles: ['src/new.js'] }
    );
    assert.equal(r.isCandidate, true);
    assert.match(r.reason, /out-of-scope/);
  });

  test('in-scope HIGH → must-fix (not candidate)', () => {
    const r = suggestDeferralCandidate(
      { severity: 'HIGH', _primaryFile: 'src/new.js', affectedFiles: ['src/new.js'] },
      { changedFiles: ['src/new.js'] }
    );
    assert.equal(r.isCandidate, false);
    assert.match(r.reason, /must fix/);
  });

  test('in-scope MEDIUM → in-scope caveat', () => {
    const r = suggestDeferralCandidate(
      { severity: 'MEDIUM', _primaryFile: 'src/new.js', affectedFiles: ['src/new.js'] },
      { changedFiles: ['src/new.js'] }
    );
    assert.equal(r.isCandidate, false);
    assert.match(r.reason, /in-scope/);
  });

  test('no changedFiles → everything is out-of-scope candidate', () => {
    const r = suggestDeferralCandidate(
      { severity: 'HIGH', _primaryFile: 'src/any.js', affectedFiles: ['src/any.js'] },
      {}
    );
    assert.equal(r.isCandidate, true);
  });

  test('partial path overlap counts as in-scope', () => {
    // file 'src/new.js' with changedFiles 'new.js' — substring match both ways
    const r = suggestDeferralCandidate(
      { severity: 'HIGH', affectedFiles: ['src/new.js'] },
      { changedFiles: ['new.js'] }
    );
    assert.equal(r.isCandidate, false);
  });
});
