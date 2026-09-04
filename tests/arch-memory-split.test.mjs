/**
 * @fileoverview WS1 regression — arch-memory.mjs split into 6 sub-modules.
 *
 * Plan: docs/plans/sustainability-cleanup-batch.md (WS1 §6 / §8).
 *
 * Three layers:
 *   1. EXPECTED_EXPORTS manifest — the exact public-function set, all
 *      resolved through the barrel as `typeof === 'function'`.
 *   2. Per-module behavioral path — cloud-disabled neutral value matrix.
 *   3. Cross-module separation — no sub-module imports a sibling.
 */
import { describe, it, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool } from '../scripts/lib/db/client.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCH_DIR = path.join(REPO_ROOT, 'scripts/lib/store/arch');

// ── 1. Explicit export manifest (Gemini-r2-G1: GET_REFRESH_RUN_COLUMNS is
//      file-private and NOT in this list) ─────────────────────────────────────
//
// The COUNT lives in the assertion below and nowhere else (audit R4 L2). Two
// stale prose figures — "36" here and "31" there — disagreed with each other
// and with the array, because a comment restating a number a test already pins
// is a second source of truth that nothing updates.

const EXPECTED_EXPORTS = [
  // arch/refresh-runs.mjs — 10 fns
  'openRefreshRun',
  'publishRefreshRun',
  'abortRefreshRun',
  'heartbeatRefreshRun',
  'getRefreshRun',
  'findStaleRunningRefresh',
  'listPrunableRefreshRuns',
  'deleteRefreshRuns',
  'demoteRefreshRuns',
  'listRollbacksForRepo',
  // arch/snapshots.mjs — 3 fns
  'getActiveSnapshot',
  'setActiveEmbeddingModel',
  'getActiveEmbeddingModel',
  // Per-repo band calibration (plan §2.1 C4-REVISED) — arch/snapshots.mjs.
  'recordBandCalibration',
  'getBandCalibration',
  // Pure decision function, not a store operation — exported so the R3 H1
  // branch (an unverified refresh pointer) is testable without a database.
  // See tests/active-snapshot-pointer.test.mjs.
  'resolveActiveSnapshot',
  'sampleSnapshotEmbeddings',
  // arch/symbols.mjs — 9 fns
  'recordSymbolDefinitions',
  'recordSymbolIndex',
  'recordSymbolEmbedding',
  'recordSymbolEmbeddings',
  'recordLayeringViolations',
  'recordDuplicateJustifications',
  'listSymbolsForSnapshot',
  // symbol-index-pipeline-reliability-hardening Theme 2 — capped-pool
  // detector for drift.mjs's pragma reconciliation.
  'countSymbolsForSnapshot',
  // Bounded null-summary re-queue (plan §2.1 C9) — arch/symbols.mjs.
  'listFilesNeedingSummaryRetry',
  'recordSummaryOutcomes',
  'listLayeringViolationsForSnapshot',
  'copyForwardUntouchedFiles',
  // arch/imports.mjs — 6 fns
  'recordSymbolFileImports',
  'copyForwardImports',
  'listFileImportsForSnapshot',
  'markImportGraphPopulated',
  'getImportGraphPopulated',
  'getImportersForFiles',
  'getFreshImportersOrNull',
  'resolveImportGraphFreshness',
  // arch/coverage.mjs — 3 fns (observed-graph coverage honesty)
  'recordGraphCoverage',
  'getGraphCoverage',
  'copyForwardCoverage',
  // arch/domain-summaries.mjs — 2 fns
  'upsertDomainSummary',
  'getDomainSummaries',
  // arch/neighbourhood.mjs — 3 fns
  'callNeighbourhoodRpc',
  'computeDriftScore',
  'getTopDuplicateClusters',
];

describe('arch-memory.mjs barrel — public export contract', () => {
  // Title DERIVED from the array, not a second literal (audit R5 L4): the
  // previous form wrote the number twice in four lines, which is the same
  // two-sources-of-truth shape the stale header comments had.
  test(`exactly ${EXPECTED_EXPORTS.length} public functions in EXPECTED_EXPORTS`, () => {
    assert.equal(EXPECTED_EXPORTS.length, 45);
  });

  // Every public member is a FUNCTION. `SUMMARY_RETRY_CAP` was briefly exported
  // alongside the re-queue helpers and would have been the first non-function
  // on this surface; it was made module-private instead, because the store's
  // own retry policy is not something callers need and weakening this guard to
  // admit one constant costs more than it buys.
  test('every name resolves through the barrel as a function', async () => {
    const mod = await import('../scripts/lib/store/arch-memory.mjs');
    const missing = [];
    const wrongKind = [];
    for (const name of EXPECTED_EXPORTS) {
      const v = mod[name];
      if (v === undefined) missing.push(name);
      else if (typeof v !== 'function') wrongKind.push({ name, type: typeof v });
    }
    assert.deepEqual(missing, [], 'missing exports through barrel');
    assert.deepEqual(wrongKind, [], 'wrong-kind exports through barrel');
  });

  // round-1 code-audit L5: the previous version only checked the LISTED
  // names exist and are functions — it never failed when the barrel started
  // exporting something new/accidental. Exact-set equality closes that gap
  // (an accidental new export, or one forgotten from EXPECTED_EXPORTS,
  // fails loudly here instead of silently widening the public contract).
  test('the barrel exports EXACTLY EXPECTED_EXPORTS — no accidental additions', async () => {
    const mod = await import('../scripts/lib/store/arch-memory.mjs');
    const actual = Object.keys(mod).sort();
    assert.deepEqual(actual, [...EXPECTED_EXPORTS].sort());
  });

  test('GET_REFRESH_RUN_COLUMNS is NOT exported (file-private)', async () => {
    const mod = await import('../scripts/lib/store/arch-memory.mjs');
    assert.equal(mod.GET_REFRESH_RUN_COLUMNS, undefined,
      'GET_REFRESH_RUN_COLUMNS must remain file-private — exposing it leaks the SQL identifier guard');
  });

  test('learning-store.mjs barrel still re-exports every arch name', async () => {
    const mod = await import('../scripts/learning-store.mjs');
    const missing = EXPECTED_EXPORTS.filter((n) => typeof mod[n] !== 'function');
    assert.deepEqual(missing, [], 'top-level learning-store barrel must re-export every arch fn');
  });
});

describe('getFreshImportersOrNull — dirty-tree guard (round-2 plan-audit H2)', () => {
  it('returns null unconditionally when workingTreeDirty is true, regardless of cloud state', async () => {
    const { getFreshImportersOrNull } = await import('../scripts/lib/store/arch-memory.mjs');
    const r = await getFreshImportersOrNull({
      repoUuid: 'repo-x', headSha: 'abc123', workingTreeDirty: true,
      filePath: 'src/a.mjs', changedFiles: ['src/b.mjs'],
    });
    assert.equal(r, null);
  });
});

// ── 2. Per-module cloud-disabled behavioral matrix ───────────────────────────
//
// Cloud is OFF in this test environment (no AUDIT_DB_URL → isCloudEnabled
// returns false). Per the plan §8 cloud-disabled neutral-value contract,
// each public function must return a documented value or throw a
// documented error — never crash with an unhandled exception.

describe('arch-memory cloud-disabled neutral-value contract', () => {
  // The npm test environment loads dotenv → AUDIT_DB_URL is typically set.
  // Force cloud-disabled by unsetting the env + draining the cached pool
  // before each subtest; restore after. This isolates the neutral-value
  // contract from whatever cloud state the developer's .env has.
  // resolveDbUrl() now reads the canonical DSN, its deprecated alias, AND the
  // AUDIT_STORE signal, plus loads the shared ~/.audit-loop.env layer. Unset ALL
  // of them (+ disable the shared layer) so cloud is genuinely off here.
  // Also unset the sunset legacy triplet (AGENTS.md: "Sunset in M4") — a
  // repo .env can still carry these even after migrating to AUDIT_DB_URL,
  // and resolveDbUrl() THROWS a migration-nudge error (not a graceful null)
  // when it sees legacy vars with no AUDIT_DB_URL, which a getPool()-direct
  // caller (recordDuplicateJustifications, recordSymbolEmbedding) surfaces
  // as a real test failure instead of the intended cloud-off neutral value.
  const CLOUD_OFF_KEYS = [
    'AUDIT_DB_URL', 'AUDIT_POSTGRES_URL', 'AUDIT_STORE',
    'SUPABASE_AUDIT_URL', 'SUPABASE_AUDIT_ANON_KEY', 'SUPABASE_AUDIT_SERVICE_ROLE_KEY',
  ];
  const saved = {};

  before(async () => {
    saved.disableShared = process.env.AUDIT_LOOP_DISABLE_SHARED;
    for (const k of CLOUD_OFF_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.AUDIT_LOOP_DISABLE_SHARED = '1';
    await closePool();  // drop any pool the prior tests may have created
  });

  after(async () => {
    await closePool();  // drop the no-pool we may have created during these tests
    for (const k of CLOUD_OFF_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    if (saved.disableShared === undefined) delete process.env.AUDIT_LOOP_DISABLE_SHARED;
    else process.env.AUDIT_LOOP_DISABLE_SHARED = saved.disableShared;
  });

  test('getRefreshRun returns null when cloud-off (repoId supplied)', async () => {
    const { getRefreshRun } = await import('../scripts/lib/store/arch-memory.mjs');
    const r = await getRefreshRun('any-id', { repoId: 'any-repo', select: ['id'] });
    assert.equal(r, null);
  });

  test('abortRefreshRun returns {aborted:false} when cloud-off, never throws (consolidated-gate shadow finding)', async () => {
    // Without this guard, abortRefreshRun let updateWhere() reach for a pool
    // that doesn't exist — the one D1 sibling of heartbeatRefreshRun/
    // getRefreshRun that didn't degrade gracefully.
    const { abortRefreshRun } = await import('../scripts/lib/store/arch-memory.mjs');
    const r = await abortRefreshRun({ refreshId: 'any-id', repoId: 'any-repo', reason: 'test' });
    assert.deepEqual(r, { aborted: false });
  });

  test('getRefreshRun throws on unknown column BEFORE checking cloud (validation deterministic)', async () => {
    const { getRefreshRun } = await import('../scripts/lib/store/arch-memory.mjs');
    await assert.rejects(
      () => getRefreshRun('any-id', { select: ['nonexistent_col'] }),
      /unknown column/i,
    );
  });

  test('getRefreshRun throws on a missing repoId — a call-site error, not "not found"', async () => {
    const { getRefreshRun } = await import('../scripts/lib/store/arch-memory.mjs');
    await assert.rejects(
      () => getRefreshRun('any-id', { select: ['id'] }),
      /refreshId and repoId are both required/,
    );
  });

  test('findStaleRunningRefresh returns null when cloud-off', async () => {
    const { findStaleRunningRefresh } = await import('../scripts/lib/store/arch-memory.mjs');
    assert.equal(await findStaleRunningRefresh('repo-x'), null);
  });

  test('listPrunableRefreshRuns returns [] when cloud-off', async () => {
    const { listPrunableRefreshRuns } = await import('../scripts/lib/store/arch-memory.mjs');
    const r = await listPrunableRefreshRuns({ filterCol: 'status', filterVal: 'aborted', retainDays: 7 });
    assert.deepEqual(r, []);
  });

  test('deleteRefreshRuns returns 0 when cloud-off OR empty input', async () => {
    const { deleteRefreshRuns } = await import('../scripts/lib/store/arch-memory.mjs');
    assert.equal(await deleteRefreshRuns([]), 0);
    assert.equal(await deleteRefreshRuns(['x']), 0);  // cloud-off path
  });

  test('demoteRefreshRuns returns 0 when cloud-off OR empty input', async () => {
    const { demoteRefreshRuns } = await import('../scripts/lib/store/arch-memory.mjs');
    assert.equal(await demoteRefreshRuns([], 'transient'), 0);
    assert.equal(await demoteRefreshRuns(['x'], 'transient'), 0);
  });

  test('listRollbacksForRepo returns [] when cloud-off', async () => {
    const { listRollbacksForRepo } = await import('../scripts/lib/store/arch-memory.mjs');
    assert.deepEqual(await listRollbacksForRepo('repo-x'), []);
  });

  test('getActiveSnapshot returns null when cloud-off', async () => {
    const { getActiveSnapshot } = await import('../scripts/lib/store/arch-memory.mjs');
    assert.equal(await getActiveSnapshot('repo-x'), null);
  });

  test('getFreshImportersOrNull returns null when cloud-off', async () => {
    const { getFreshImportersOrNull } = await import('../scripts/lib/store/arch-memory.mjs');
    const r = await getFreshImportersOrNull({
      repoUuid: 'repo-x', headSha: 'abc123', workingTreeDirty: false,
      filePath: 'src/a.mjs', changedFiles: ['src/b.mjs'],
    });
    assert.equal(r, null);
  });

  test('getFreshImportersOrNull returns null on missing required params, before ever reaching cloud', async () => {
    const { getFreshImportersOrNull } = await import('../scripts/lib/store/arch-memory.mjs');
    assert.equal(await getFreshImportersOrNull({ repoUuid: null, headSha: 'abc', workingTreeDirty: false, filePath: 'a.mjs' }), null);
    assert.equal(await getFreshImportersOrNull({ repoUuid: 'x', headSha: null, workingTreeDirty: false, filePath: 'a.mjs' }), null);
    assert.equal(await getFreshImportersOrNull({ repoUuid: 'x', headSha: 'abc', workingTreeDirty: false, filePath: null }), null);
  });

  // round-1 code-audit H2: the cross-file import graph has zero visibility
  // into a same-file dependency between new hunks elsewhere in filePath and
  // the cited pre-existing lines — a directly changed file must resolve to
  // `false` (confidently dependent), and it must do so BEFORE any cloud/DB
  // round-trip (still correct — and cheap — with cloud off).
  test('getFreshImportersOrNull returns false when filePath is itself in changedFiles, even with cloud off', async () => {
    const { getFreshImportersOrNull } = await import('../scripts/lib/store/arch-memory.mjs');
    const r = await getFreshImportersOrNull({
      repoUuid: 'repo-x', headSha: 'abc123', workingTreeDirty: false,
      filePath: 'src/a.mjs', changedFiles: ['src/a.mjs', 'src/b.mjs'],
    });
    assert.equal(r, false);
  });

  // round-1 code-audit M4: an unbounded/invalid maxDepth (Infinity, NaN, a
  // negative number) would defeat `depth >= maxDepth`'s intended bound —
  // validated at the public boundary, before any cloud/DB round-trip.
  test('getFreshImportersOrNull returns null for a non-finite or negative maxDepth, before ever reaching cloud', async () => {
    const { getFreshImportersOrNull } = await import('../scripts/lib/store/arch-memory.mjs');
    for (const maxDepth of [Infinity, NaN, -1, 1.5]) {
      const r = await getFreshImportersOrNull({
        repoUuid: 'repo-x', headSha: 'abc123', workingTreeDirty: false,
        filePath: 'src/a.mjs', changedFiles: ['src/b.mjs'], maxDepth,
      });
      assert.equal(r, null, `expected null for maxDepth=${maxDepth}`);
    }
  });

  test('getActiveEmbeddingModel returns null when cloud-off', async () => {
    const { getActiveEmbeddingModel } = await import('../scripts/lib/store/arch-memory.mjs');
    assert.equal(await getActiveEmbeddingModel('repo-x'), null);
  });

  test('recordSymbolDefinitions returns {} on empty input', async () => {
    const { recordSymbolDefinitions } = await import('../scripts/lib/store/arch-memory.mjs');
    assert.deepEqual(await recordSymbolDefinitions('repo-x', []), {});
  });

  test('recordSymbolIndex returns 0 on empty input', async () => {
    const { recordSymbolIndex } = await import('../scripts/lib/store/arch-memory.mjs');
    assert.equal(await recordSymbolIndex('r', 'p', []), 0);
  });

  test('recordLayeringViolations returns 0 on empty input', async () => {
    const { recordLayeringViolations } = await import('../scripts/lib/store/arch-memory.mjs');
    assert.equal(await recordLayeringViolations('r', 'p', []), 0);
  });

  test('recordDuplicateJustifications returns 0 when cloud-off', async () => {
    const { recordDuplicateJustifications } = await import('../scripts/lib/store/arch-memory.mjs');
    assert.equal(await recordDuplicateJustifications('r', 'p', []), 0);
    assert.equal(await recordDuplicateJustifications('r', 'p', [{ definitionId: 'd1', reason: 'x', target: 't', source: 's' }]), 0);
  });

  test('recordSymbolFileImports returns {inserted: 0} on empty input', async () => {
    const { recordSymbolFileImports } = await import('../scripts/lib/store/arch-memory.mjs');
    assert.deepEqual(await recordSymbolFileImports('r', []), { inserted: 0 });
  });

  test('copyForwardImports returns {copied: 0} when cloud-off', async () => {
    const { copyForwardImports } = await import('../scripts/lib/store/arch-memory.mjs');
    const r = await copyForwardImports({ fromRefreshId: 'a', toRefreshId: 'b', touchedFileSet: new Set() });
    assert.deepEqual(r, { copied: 0 });
  });

  test('listFileImportsForSnapshot returns [] when cloud-off', async () => {
    const { listFileImportsForSnapshot } = await import('../scripts/lib/store/arch-memory.mjs');
    assert.deepEqual(await listFileImportsForSnapshot('refresh-x'), []);
  });

  test('getImportGraphPopulated returns false when cloud-off (repoId supplied)', async () => {
    const { getImportGraphPopulated } = await import('../scripts/lib/store/arch-memory.mjs');
    assert.equal(await getImportGraphPopulated('refresh-x', 'repo-x'), false);
  });

  test('getImportGraphPopulated throws on a missing repoId — a call-site error, not "not populated"', async () => {
    const { getImportGraphPopulated } = await import('../scripts/lib/store/arch-memory.mjs');
    await assert.rejects(() => getImportGraphPopulated('refresh-x'), /refreshId and repoId are both required/);
    await assert.rejects(() => getImportGraphPopulated(null, 'repo-x'), /refreshId and repoId are both required/);
  });

  test('getImportersForFiles returns empty Map when cloud-off OR empty paths', async () => {
    const { getImportersForFiles } = await import('../scripts/lib/store/arch-memory.mjs');
    const r1 = await getImportersForFiles({ refreshId: 'r', paths: [] });
    assert.ok(r1 instanceof Map);
    assert.equal(r1.size, 0);
    const r2 = await getImportersForFiles({ refreshId: 'r', paths: ['x'] });
    assert.ok(r2 instanceof Map);
    assert.equal(r2.size, 0);
  });

  test('getDomainSummaries returns empty Map when cloud-off', async () => {
    const { getDomainSummaries } = await import('../scripts/lib/store/arch-memory.mjs');
    const r = await getDomainSummaries('repo-x');
    assert.ok(r instanceof Map);
    assert.equal(r.size, 0);
  });

  test('listSymbolsForSnapshot returns [] when cloud-off', async () => {
    const { listSymbolsForSnapshot } = await import('../scripts/lib/store/arch-memory.mjs');
    assert.deepEqual(await listSymbolsForSnapshot({ refreshId: 'r' }), []);
  });

  test('countSymbolsForSnapshot returns 0 when cloud-off', async () => {
    const { countSymbolsForSnapshot } = await import('../scripts/lib/store/arch-memory.mjs');
    assert.equal(await countSymbolsForSnapshot({ refreshId: 'r' }), 0);
  });

  test('listLayeringViolationsForSnapshot returns [] when cloud-off', async () => {
    const { listLayeringViolationsForSnapshot } = await import('../scripts/lib/store/arch-memory.mjs');
    assert.deepEqual(await listLayeringViolationsForSnapshot('r'), []);
  });

  test('copyForwardUntouchedFiles returns 0 when cloud-off', async () => {
    const { copyForwardUntouchedFiles } = await import('../scripts/lib/store/arch-memory.mjs');
    const r = await copyForwardUntouchedFiles({
      repoId: 'p', fromRefreshId: 'a', toRefreshId: 'b',
      touchedFileSet: new Set(),
    });
    assert.equal(r, 0);
  });

  test('callNeighbourhoodRpc returns [] when cloud-off', async () => {
    const { callNeighbourhoodRpc } = await import('../scripts/lib/store/arch-memory.mjs');
    const r = await callNeighbourhoodRpc({
      repoId: 'p', refreshId: 'r', targetPaths: [],
      intentEmbedding: [], kindFilter: null, k: 5,
    });
    assert.deepEqual(r, []);
  });

  test('computeDriftScore returns null when cloud-off', async () => {
    const { computeDriftScore } = await import('../scripts/lib/store/arch-memory.mjs');
    const r = await computeDriftScore({ repoId: 'p', refreshId: 'r' });
    assert.equal(r, null);
  });

  test('getTopDuplicateClusters returns [] when cloud-off', async () => {
    const { getTopDuplicateClusters } = await import('../scripts/lib/store/arch-memory.mjs');
    assert.deepEqual(await getTopDuplicateClusters({ repoId: 'p', refreshId: 'r' }), []);
  });
});

// ── 3. Cross-module separation — no sub-module imports a sibling ────────────

describe('arch/ sub-modules do not import each other', () => {
  const SUB_MODULES = [
    'refresh-runs.mjs',
    'snapshots.mjs',
    'symbols.mjs',
    'imports.mjs',
    'domain-summaries.mjs',
    'neighbourhood.mjs',
  ];

  // Allowed imports: ../../db/*, ../repo.mjs, ./_shared.mjs, node:* builtins.
  // FORBIDDEN: importing another sibling under ./
  for (const file of SUB_MODULES) {
    test(`${file} does not import a sibling sub-module`, () => {
      const src = fs.readFileSync(path.join(ARCH_DIR, file), 'utf-8');
      for (const sibling of SUB_MODULES) {
        if (sibling === file) continue;
        const localImport = `from './${sibling.replace('.mjs', '')}.mjs'`;
        assert.ok(!src.includes(localImport),
          `${file} must not import sibling ${sibling} — keeps the split clean`);
      }
    });
  }

  test('_shared.mjs has no cross-sibling imports either', () => {
    const src = fs.readFileSync(path.join(ARCH_DIR, '_shared.mjs'), 'utf-8');
    for (const sibling of SUB_MODULES) {
      const localImport = `from './${sibling.replace('.mjs', '')}.mjs'`;
      assert.ok(!src.includes(localImport),
        `_shared.mjs is the leaf — must not import any sibling`);
    }
  });
});
