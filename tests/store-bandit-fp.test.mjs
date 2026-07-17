/**
 * @fileoverview DB-free tests for the FP-pattern sync seam
 * (scripts/lib/store/bandit-fp.mjs) + the tracker's dirty-pattern payload
 * (scripts/lib/findings-tracker.mjs).
 *
 * Regression guards for the 2026-07-17 Disk IO Budget incident: the sync
 * wrote repo_id = NULL, which Postgres unique constraints treat as distinct,
 * so ON CONFLICT never matched and every audit run re-inserted the entire
 * local tracker as new rows (403k garbage rows in 3 days). The reader
 * compounded it by selecting columns that no migration ever declared — the
 * error was swallowed and it returned empty forever.
 *
 * Per testing doctrine the INSERT/SELECT round trip is NOT asserted against
 * a mock; what IS asserted, DB-free: the row builder can never emit a null
 * repo_id, the read column list is migration-backed, and cloud-off degrades
 * gracefully.
 */
process.env.AUDIT_DB_URL = ''; // must precede the dynamic imports below

const {
  buildFpPatternRows,
  syncFalsePositivePatterns,
  loadFalsePositivePatterns,
  fpPatternReadColumns,
} = await import('../scripts/lib/store/bandit-fp.mjs');
const { FalsePositiveTracker } = await import('../scripts/lib/findings-tracker.mjs');
const { GLOBAL_REPO_ID } = await import('../scripts/lib/config.mjs');

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations'
);

const SAMPLE_UUID = 'a1b2c3d4-0000-4000-8000-000000000001';
const SAMPLE_PATTERNS = {
  'bug / logic error::HIGH::correctness': {
    dismissed: 6, accepted: 0, ema: 0.05,
    decayedAccepted: 0, decayedDismissed: 5.5,
    scope: 'global', fileExtension: 'unknown',
  },
  'dry violation::MEDIUM::single source of truth::e89ab30aa7d1a6aa::mjs::repo+fileType': {
    category: 'dry violation', severity: 'MEDIUM', principle: 'single source of truth',
    fileExtension: 'mjs', scope: 'repo+fileType',
    dismissed: 2, accepted: 3, ema: 0.6,
    decayedAccepted: 2.8, decayedDismissed: 1.9,
  },
};

// ── buildFpPatternRows: repo_id can never be null ──────────────────────────

test('buildFpPatternRows: null repoId falls back to GLOBAL sentinel, never null', () => {
  const rows = buildFpPatternRows(null, SAMPLE_PATTERNS);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.repo_id, GLOBAL_REPO_ID);
  }
});

test('buildFpPatternRows: a repo *fingerprint* (non-UUID) also falls back to sentinel', () => {
  const rows = buildFpPatternRows('e89ab30aa7d1a6aa', SAMPLE_PATTERNS);
  for (const row of rows) assert.equal(row.repo_id, GLOBAL_REPO_ID);
});

test('buildFpPatternRows: a real repo UUID passes through', () => {
  const rows = buildFpPatternRows(SAMPLE_UUID, SAMPLE_PATTERNS);
  for (const row of rows) assert.equal(row.repo_id, SAMPLE_UUID);
});

// ── buildFpPatternRows: structured dimensions ──────────────────────────────

test('buildFpPatternRows: structured fields come from the pattern object when present', () => {
  const rows = buildFpPatternRows(SAMPLE_UUID, SAMPLE_PATTERNS);
  const scoped = rows.find(r => r.scope === 'repo+fileType');
  assert.equal(scoped.category, 'dry violation');
  assert.equal(scoped.severity, 'MEDIUM');
  assert.equal(scoped.principle, 'single source of truth');
  assert.equal(scoped.file_extension, 'mjs');
  assert.equal(scoped.dismissed, 2);
  assert.equal(scoped.accepted, 3);
  assert.equal(scoped.ema, 0.6);
  assert.equal(scoped.decayed_accepted, 2.8);
  assert.equal(scoped.decayed_dismissed, 1.9);
});

test('buildFpPatternRows: legacy keys parse category/severity/principle from the key', () => {
  const rows = buildFpPatternRows(SAMPLE_UUID, SAMPLE_PATTERNS);
  const legacy = rows.find(r => r.pattern_value.startsWith('bug / logic error'));
  assert.equal(legacy.category, 'bug / logic error');
  assert.equal(legacy.severity, 'HIGH');
  assert.equal(legacy.principle, 'correctness');
  assert.equal(legacy.scope, 'global');
});

test('buildFpPatternRows: auto_suppress requires >=5 samples AND ema < 0.15', () => {
  const rows = buildFpPatternRows(SAMPLE_UUID, SAMPLE_PATTERNS);
  const legacy = rows.find(r => r.pattern_value.startsWith('bug / logic error'));
  const scoped = rows.find(r => r.scope === 'repo+fileType');
  assert.equal(legacy.auto_suppress, true);   // 6 samples, ema 0.05
  assert.equal(scoped.auto_suppress, false);  // 5 samples but ema 0.6
});

// ── Schema guard: written/read columns are migration-backed ───────────────

function declaredFpPatternColumns() {
  const columns = new Set();
  const constraintKeywords = new Set([
    'UNIQUE', 'PRIMARY', 'FOREIGN', 'CHECK', 'CONSTRAINT',
  ]);
  for (const file of fs.readdirSync(MIGRATIONS_DIR)) {
    if (!file.endsWith('.sql')) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

    // CREATE TABLE block
    const createMatch = sql.match(
      /CREATE TABLE (?:IF NOT EXISTS )?false_positive_patterns\s*\(([\s\S]*?)\);/i
    );
    if (createMatch) {
      for (const rawLine of createMatch[1].split('\n')) {
        const word = rawLine.trim().split(/[\s(]+/)[0];
        if (word && !constraintKeywords.has(word.toUpperCase())) {
          columns.add(word.replace(/"/g, '').toLowerCase());
        }
      }
    }

    // ADD COLUMN statements
    for (const m of sql.matchAll(
      /ALTER TABLE false_positive_patterns\s+ADD COLUMN (?:IF NOT EXISTS )?(\w+)/gi
    )) {
      columns.add(m[1].toLowerCase());
    }
  }
  return columns;
}

test('every column the reader selects is declared by a migration', () => {
  const declared = declaredFpPatternColumns();
  assert.ok(declared.size > 5, 'migration parser found the table');
  for (const col of fpPatternReadColumns()) {
    assert.ok(declared.has(col), `reader selects undeclared column: ${col}`);
  }
});

test('every column the writer emits is declared by a migration', () => {
  const declared = declaredFpPatternColumns();
  const [row] = buildFpPatternRows(null, SAMPLE_PATTERNS);
  for (const col of Object.keys(row)) {
    assert.ok(declared.has(col), `writer emits undeclared column: ${col}`);
  }
});

// ── Cloud-off graceful degradation ─────────────────────────────────────────

test('syncFalsePositivePatterns: cloud off → no-op, no throw', async () => {
  await syncFalsePositivePatterns(null, SAMPLE_PATTERNS);
});

test('loadFalsePositivePatterns: cloud off → empty shape', async () => {
  const r = await loadFalsePositivePatterns(SAMPLE_UUID);
  assert.deepEqual(r, { repoPatterns: [], globalPatterns: [] });
});

// ── FalsePositiveTracker dirty-pattern payload ─────────────────────────────

function makeTracker(initial = {}) {
  return new FalsePositiveTracker('unused.json', {
    store: { load: () => initial, save: () => {} },
  });
}

test('dirtyPatterns: fresh tracker (even with loaded state) starts empty', () => {
  const tracker = makeTracker({
    'old::HIGH::stale': { dismissed: 9, accepted: 0, ema: 0.1, decayedAccepted: 0, decayedDismissed: 8 },
  });
  assert.deepEqual(tracker.dirtyPatterns(), {});
});

test('dirtyPatterns: legacy record() marks exactly the touched key', () => {
  const tracker = makeTracker();
  tracker.record({ category: 'Bug', severity: 'HIGH', principle: 'x' }, false);
  const dirty = tracker.dirtyPatterns();
  assert.deepEqual(Object.keys(dirty), ['bug::HIGH::x']);
});

test('dirtyPatterns: scoped record() marks all three scope keys, pre-loaded state stays clean', () => {
  const tracker = makeTracker({
    'old::HIGH::stale': { dismissed: 9, accepted: 0, ema: 0.1, decayedAccepted: 0, decayedDismissed: 8 },
  });
  tracker.record({ category: 'Bug', severity: 'HIGH', principle: 'x' }, false, 'fp1234567890abcd', 'src/a.mjs');
  const dirty = tracker.dirtyPatterns();
  assert.equal(Object.keys(dirty).length, 3);
  assert.ok(!('old::HIGH::stale' in dirty), 'untouched pre-loaded key must not sync');
});
