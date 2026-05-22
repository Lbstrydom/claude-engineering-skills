/**
 * @fileoverview WS1 regression — arch-memory.mjs split into 6 sub-modules.
 *
 * Plan: docs/plans/sustainability-cleanup-batch.md (WS1 §6 / §8).
 *
 * Three layers:
 *   1. EXPECTED_EXPORTS manifest — exact 31 public functions, all
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
//      file-private, NOT in this list — exactly 31 PUBLIC functions) ────────

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
  // arch/symbols.mjs — 7 fns
  'recordSymbolDefinitions',
  'recordSymbolIndex',
  'recordSymbolEmbedding',
  'recordLayeringViolations',
  'listSymbolsForSnapshot',
  'listLayeringViolationsForSnapshot',
  'copyForwardUntouchedFiles',
  // arch/imports.mjs — 6 fns
  'recordSymbolFileImports',
  'copyForwardImports',
  'listFileImportsForSnapshot',
  'markImportGraphPopulated',
  'getImportGraphPopulated',
  'getImportersForFiles',
  // arch/domain-summaries.mjs — 2 fns
  'upsertDomainSummary',
  'getDomainSummaries',
  // arch/neighbourhood.mjs — 3 fns
  'callNeighbourhoodRpc',
  'computeDriftScore',
  'getTopDuplicateClusters',
];

describe('arch-memory.mjs barrel — public export contract', () => {
  test(`exactly 31 public functions in EXPECTED_EXPORTS`, () => {
    assert.equal(EXPECTED_EXPORTS.length, 31);
  });

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
  let savedAuditDbUrl;

  before(async () => {
    savedAuditDbUrl = process.env.AUDIT_DB_URL;
    delete process.env.AUDIT_DB_URL;
    await closePool();  // drop any pool the prior tests may have created
  });

  after(async () => {
    await closePool();  // drop the no-pool we may have created during these tests
    if (savedAuditDbUrl !== undefined) process.env.AUDIT_DB_URL = savedAuditDbUrl;
  });

  test('getRefreshRun returns null when cloud-off', async () => {
    const { getRefreshRun } = await import('../scripts/lib/store/arch-memory.mjs');
    const r = await getRefreshRun('any-id', { select: ['id'] });
    assert.equal(r, null);
  });

  test('getRefreshRun throws on unknown column BEFORE checking cloud (validation deterministic)', async () => {
    const { getRefreshRun } = await import('../scripts/lib/store/arch-memory.mjs');
    await assert.rejects(
      () => getRefreshRun('any-id', { select: ['nonexistent_col'] }),
      /unknown column/i,
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

  test('getImportGraphPopulated returns false when cloud-off', async () => {
    const { getImportGraphPopulated } = await import('../scripts/lib/store/arch-memory.mjs');
    assert.equal(await getImportGraphPopulated('refresh-x'), false);
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
