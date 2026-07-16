/**
 * @fileoverview Architectural-memory store — THIN BARREL.
 *
 * This file used to be an 838-line god module covering refresh_runs
 * lifecycle, symbol_index, domain_summaries, import-graph, and
 * neighbourhood RPCs. Plan: docs/plans/sustainability-cleanup-batch.md
 * (WS1) split it into 6 focused sub-modules under `arch/` while keeping
 * THIS file at the same path as a barrel re-export — `learning-store.mjs`
 * (and the 18+ caller files behind it) continues to import everything
 * from `'./lib/store/arch-memory.mjs'` unchanged.
 *
 * Export-ownership matrix (locked at plan §6 WS1):
 *
 *   arch/refresh-runs.mjs    — refresh_runs lifecycle + retention (10 fns)
 *     openRefreshRun, publishRefreshRun, abortRefreshRun,
 *     heartbeatRefreshRun, getRefreshRun, findStaleRunningRefresh,
 *     listPrunableRefreshRuns, deleteRefreshRuns, demoteRefreshRuns,
 *     listRollbacksForRepo
 *
 *   arch/snapshots.mjs       — active-snapshot pointer + embed config (3 fns)
 *     getActiveSnapshot, setActiveEmbeddingModel, getActiveEmbeddingModel
 *
 *   arch/symbols.mjs         — symbol_definitions/index/embeddings/violations (8 fns)
 *     recordSymbolDefinitions, recordSymbolIndex, recordSymbolEmbedding,
 *     recordLayeringViolations, recordDuplicateJustifications,
 *     listSymbolsForSnapshot, listLayeringViolationsForSnapshot,
 *     copyForwardUntouchedFiles
 *
 *   arch/imports.mjs         — symbol_file_imports (7 fns)
 *     recordSymbolFileImports, copyForwardImports,
 *     listFileImportsForSnapshot, markImportGraphPopulated,
 *     getImportGraphPopulated, getImportersForFiles
 *
 *   arch/domain-summaries.mjs — per-domain Haiku cache (2 fns)
 *     upsertDomainSummary, getDomainSummaries
 *
 *   arch/neighbourhood.mjs   — RPC adapters: drift + duplicates + neighbourhood (3 fns)
 *     callNeighbourhoodRpc, computeDriftScore, getTopDuplicateClusters
 *
 * Total: 31 public functions (verified in tests/arch-memory-split.test.mjs).
 *
 * GET_REFRESH_RUN_COLUMNS stays file-private inside arch/refresh-runs.mjs
 * (Gemini-r2-G1 — pgsql identifier interpolation guard, not part of the
 * public contract).
 *
 * Notable translation choices preserved from the pre-split file:
 *   - The legacy `withRetry` network-blip wrapper is gone: under the `pg`
 *     driver the connection-failure path is handled by normalizePostgresError
 *     (errors.mjs) classifying SQLSTATE 08* / ECONNRESET as transient.
 *   - `listSymbolsForSnapshot` has a non-trivial JOIN against
 *     symbol_definitions — hand-written SQL (now in arch/symbols.mjs).
 *
 * @module scripts/lib/store/arch-memory
 */

export * from './arch/refresh-runs.mjs';
export * from './arch/snapshots.mjs';
export * from './arch/symbols.mjs';
export * from './arch/imports.mjs';
export * from './arch/domain-summaries.mjs';
export * from './arch/neighbourhood.mjs';
