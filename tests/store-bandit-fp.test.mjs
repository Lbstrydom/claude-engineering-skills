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
  buildFpReadQuery,
  isSyncableRepoId,
} = await import('../scripts/lib/store/bandit-fp.mjs');
const { FalsePositiveTracker } = await import('../scripts/lib/findings-tracker.mjs');
const {
  GLOBAL_REPO_ID, clampFpReadLimit, FP_READ_LIMIT_MIN, FP_READ_LIMIT_MAX, FP_READ_LIMIT_DEFAULT,
  learningConfig,
} = await import('../scripts/lib/config.mjs');

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

test('buildFpPatternRows: the structured field WINS over the key — proven with a discriminating fixture', () => {
  // The test above cannot actually prove its own name: SAMPLE_PATTERNS' key
  // replicates its structured values verbatim, so `p.category` and
  // `key.split('::')[0]` return the same answer and the assertion passes either
  // way. A tautological test. This one makes the two sources DISAGREE, so only
  // the structured-field path can satisfy it.
  const rows = buildFpPatternRows(SAMPLE_UUID, {
    'key-category::LOW::key-principle': {
      category: 'object-category', severity: 'HIGH', principle: 'object-principle',
      scope: 'repo', fileExtension: 'ts',
      dismissed: 1, accepted: 0, ema: 0.1, decayedDismissed: 1, decayedAccepted: 0,
    },
  });
  assert.equal(rows[0].category, 'object-category', 'p.category must win over the key segment');
  assert.equal(rows[0].severity, 'HIGH');
  assert.equal(rows[0].principle, 'object-principle');
  assert.equal(rows[0].pattern_value, 'key-category::LOW::key-principle', 'the key is still the identity');
});

test('buildFpPatternRows: a "::"-bearing value survives when structured fields are present', () => {
  // The legacy key parser splits on '::', so a value containing '::' (a C++
  // namespace, say) cannot round-trip through the key. Structured fields are
  // what make such a pattern safe — pin that they are honoured.
  const rows = buildFpPatternRows(SAMPLE_UUID, {
    'std::vector misuse::HIGH::correctness': {
      category: 'std::vector misuse', severity: 'HIGH', principle: 'correctness',
      scope: 'repo', dismissed: 1, accepted: 0, ema: 0.1,
    },
  });
  assert.equal(rows[0].category, 'std::vector misuse', 'must not be truncated to "std"');
  assert.equal(rows[0].severity, 'HIGH', 'must not be shifted to "vector"');
});

test('buildFpPatternRows: legacy keys parse category/severity/principle from the key', () => {
  const rows = buildFpPatternRows(SAMPLE_UUID, SAMPLE_PATTERNS);
  const legacy = rows.find(r => r.pattern_value.startsWith('bug / logic error'));
  assert.equal(legacy.category, 'bug / logic error');
  assert.equal(legacy.severity, 'HIGH');
  assert.equal(legacy.principle, 'correctness');
  assert.equal(legacy.scope, 'global');
});

test('buildFpPatternRows: auto_suppress requires >= minFpSamples AND ema < 0.15', () => {
  // The sample floor is CONFIGURABLE (MIN_FP_SAMPLES) and production derives it
  // from learningConfig — so the test must derive it too. Hardcoding 5 here
  // would let the writer's threshold and the reader's ESS gate drift apart
  // without any test noticing, which is the exact coupling that silently hides
  // rows from the global-scope read.
  const rows = buildFpPatternRows(SAMPLE_UUID, SAMPLE_PATTERNS);
  const legacy = rows.find(r => r.pattern_value.startsWith('bug / logic error'));
  const scoped = rows.find(r => r.scope === 'repo+fileType');
  const min = learningConfig.minFpSamples;

  // legacy: 6 dismissed + 0 accepted, ema 0.05 → suppress iff 6 >= min
  assert.equal(legacy.auto_suppress, 6 >= min && 0.05 < 0.15);
  // scoped: 2 + 3 = 5 samples but ema 0.6 → the ema arm alone must veto it
  assert.equal(scoped.auto_suppress, false, 'ema >= 0.15 vetoes regardless of sample count');
  // the persisted threshold IS the configured floor — not a literal
  assert.equal(legacy.suppress_threshold, min);
});

test('buildFpPatternRows: the sample-floor boundary tracks the configured minimum', () => {
  const min = learningConfig.minFpSamples;
  const atFloor = { 'x::HIGH::y': { dismissed: min, accepted: 0, ema: 0.05, decayedDismissed: min, decayedAccepted: 0 } };
  const belowFloor = { 'x::HIGH::y': { dismissed: min - 1, accepted: 0, ema: 0.05, decayedDismissed: min - 1, decayedAccepted: 0 } };
  assert.equal(buildFpPatternRows(SAMPLE_UUID, atFloor)[0].auto_suppress, true, 'exactly at the floor qualifies');
  assert.equal(buildFpPatternRows(SAMPLE_UUID, belowFloor)[0].auto_suppress, false, 'one below the floor does not');
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

// ── Repo-identity isolation: the GLOBAL bucket means "cross-repo", not "unknown"
//
// buildFpPatternRows' sentinel fallback (above) guarantees a non-null repo_id —
// that is the 2026-07-17 ON CONFLICT fix and stays. But the sync must not USE it
// to launder an unresolved identity into the cross-repo bucket, because the
// cloud read loop applies GLOBAL patterns to OTHER repos. Before that reader
// existed nothing read GLOBAL and the mislabelling was inert; the reader makes
// it live, so the write side must honour the contract the reader depends on.

test('isSyncableRepoId: only a real UUID may be synced under — a fingerprint must not', () => {
  assert.equal(isSyncableRepoId(SAMPLE_UUID), true);
  // The exact non-UUID shapes buildFpPatternRows would otherwise map onto the
  // GLOBAL sentinel. Each must be refused at the sync boundary instead.
  for (const bad of ['e89ab30aa7d1a6aa', null, undefined, '', GLOBAL_REPO_ID.slice(0, 8), 42, {}]) {
    assert.equal(isSyncableRepoId(bad), false, `must refuse: ${String(bad)}`);
  }
});

test('isSyncableRepoId accepts the GLOBAL sentinel itself (a genuine cross-repo write is legitimate)', () => {
  // The sentinel IS a valid UUID; refusing it would block deliberate global
  // patterns. The guard rejects UNRESOLVED identities, not the global bucket.
  assert.equal(isSyncableRepoId(GLOBAL_REPO_ID), true);
});

// COMPOSITION, not just the predicate (GPT deliberation on R5-H1: "predicate-only
// tests are useful but this pins the actual egress boundary"). A correct predicate
// that isn't wired in protects nothing — that seam-vs-composition gap is exactly
// what shipped bugs earlier in this change's own audit history.
//
// The guard sits ABOVE the cloud check, so seeing its log proves it executed and
// returned BEFORE any pool/upsert work. In this DB-free suite (AUDIT_DB_URL='')
// a cloud-off return is SILENT — so the log can only come from the guard itself.

test('syncFalsePositivePatterns: a fingerprint repoId is refused at the boundary — no write is ever reached', async () => {
  const captured = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { captured.push(String(s)); return true; };
  try {
    await syncFalsePositivePatterns('e89ab30aa7d1a6aa', SAMPLE_PATTERNS);
  } finally {
    process.stderr.write = orig;
  }
  assert.ok(
    captured.some(l => /skipped — repo identity unresolved/.test(l)),
    'the guard must run and refuse — a silent return would mean it never executed'
  );
  assert.ok(
    !captured.some(l => /Synced \d+ FP patterns/.test(l)),
    'no sync may be reported'
  );
});

test('syncFalsePositivePatterns: a null repoId returns silently (ordinary cloud-off / unresolved case, not a mislabel)', async () => {
  const captured = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { captured.push(String(s)); return true; };
  try {
    await syncFalsePositivePatterns(null, SAMPLE_PATTERNS);
  } finally {
    process.stderr.write = orig;
  }
  assert.equal(captured.length, 0, 'must not spam every cloud-off audit with a mislabel warning');
});

test('buildFpPatternRows keeps its defensive sentinel fallback (the ON CONFLICT guard is unchanged)', () => {
  // The refusal lives at the sync boundary; the pure builder must still never
  // emit a null repo_id if it is ever called directly.
  for (const bad of [null, 'e89ab30aa7d1a6aa']) {
    for (const row of buildFpPatternRows(bad, SAMPLE_PATTERNS)) {
      assert.equal(row.repo_id, GLOBAL_REPO_ID);
    }
  }
});

test('loadFalsePositivePatterns: cloud off → both scopes explicitly skipped, never a bare empty', async () => {
  const r = await loadFalsePositivePatterns(SAMPLE_UUID);
  // The envelope must SAY why it is empty. An empty array cannot distinguish
  // "no patterns" from "the read failed", and that difference is a decision
  // input: an unavailable repo scope must not license global suppression.
  assert.equal(r.repo.status, 'skipped');
  assert.equal(r.global.status, 'skipped');
  assert.deepEqual(r.repo.patterns, []);
  assert.deepEqual(r.global.patterns, []);
});

// ── Bounded, deterministically-ordered read (query SHAPE only) ─────────────
//
// Asserts the query the loader builds, not its efficiency: efficiency rests on
// the committed index (20260717190000_fp_pattern_read_index.sql). There is no
// live-DB tier here by design — INC-002.

test('buildFpReadQuery: bounded + deterministic order, fetching limit+1', () => {
  const { sql, params } = buildFpReadQuery(SAMPLE_UUID, 500, true);
  assert.match(sql, /ORDER BY decayed_dismissed DESC, pattern_value ASC/);
  assert.match(sql, /LIMIT \$2/);
  assert.deepEqual(params, [SAMPLE_UUID, 501], 'fetch limit+1 so atLimit reflects real truncation');
});

test('buildFpReadQuery: the REPO scope carries NO auto_suppress predicate', () => {
  // auto_suppress is written as (accepted+dismissed)>=5 AND ema<0.15, so every
  // hierarchy BLOCKER (ema >= 0.15) has auto_suppress=false. Filtering on it
  // would silently delete exactly the rows that stop the scope walk, and a
  // finding matching a repo blocker + a global suppressor would be wrongly
  // suppressed.
  const { sql } = buildFpReadQuery(SAMPLE_UUID, 10, false);
  // Scope to the WHERE clause: auto_suppress is legitimately SELECTed (the
  // policy re-gates on it), it just must not FILTER the repo read.
  const where = sql.match(/WHERE ([\s\S]*?)\n/)[1];
  assert.ok(!/auto_suppress/.test(where), 'repo query must retrieve blockers, not just suppressors');
  assert.equal(where.trim(), 'repo_id = $1');
});

test('buildFpReadQuery: the GLOBAL scope keeps the predicate (safe — it is the last scope)', () => {
  const { sql } = buildFpReadQuery(GLOBAL_REPO_ID, 10, true);
  assert.match(sql, /repo_id = \$1 AND auto_suppress = true/);
});

test('buildFpReadQuery: every selected column is migration-backed', () => {
  const declared = declaredFpPatternColumns();
  const { sql } = buildFpReadQuery(SAMPLE_UUID, 10, false);
  const selected = sql.match(/SELECT ([\s\S]*?) FROM/)[1].split(',').map(s => s.trim());
  for (const col of selected) assert.ok(declared.has(col), `undeclared column in query: ${col}`);
});

// ── Read-limit validation (the loader boundary, not just config) ───────────

test('clampFpReadLimit: malformed input falls back to the default', () => {
  for (const bad of ['abc', undefined, null, '']) {
    assert.equal(clampFpReadLimit(bad, () => {}), FP_READ_LIMIT_DEFAULT);
  }
});

test('clampFpReadLimit: below-minimum values clamp and warn', () => {
  const warnings = [];
  assert.equal(clampFpReadLimit(0, (m) => warnings.push(m)), FP_READ_LIMIT_MIN);
  assert.equal(clampFpReadLimit(-5, (m) => warnings.push(m)), FP_READ_LIMIT_MIN);
  assert.equal(warnings.length, 2);
});

test('clampFpReadLimit: above-maximum values clamp and warn — a bound a typo can disable is not a bound', () => {
  const warnings = [];
  assert.equal(clampFpReadLimit(999999999, (m) => warnings.push(m)), FP_READ_LIMIT_MAX);
  assert.equal(warnings.length, 1);
});

test('clampFpReadLimit: an in-range value passes through and warns nothing', () => {
  const warnings = [];
  assert.equal(clampFpReadLimit(500, (m) => warnings.push(m)), 500);
  assert.equal(warnings.length, 0, 'the normal config-derived path must not warn');
});

test('clampFpReadLimit is idempotent — an already-clamped value never double-warns', () => {
  const warnings = [];
  const once = clampFpReadLimit(999999999, () => {});
  assert.equal(clampFpReadLimit(once, (m) => warnings.push(m)), FP_READ_LIMIT_MAX);
  assert.equal(warnings.length, 0);
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
