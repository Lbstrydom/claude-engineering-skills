/**
 * @fileoverview Barrel re-export for shared utilities.
 * All functionality has been split into focused modules under lib/.
 * This file preserves backwards compatibility — consumers can import from
 * './shared.mjs' or directly from './lib/<module>.mjs'.
 * @module scripts/shared
 */

// ── Schemas ─────────────────────────────────────────────────────────────────
export {
  FindingSchema,
  FindingJsonSchema,
  WiringIssueSchema,
  LedgerEntrySchema,
  AdjudicationLedgerSchema,
  zodToGeminiSchema
} from './lib/schemas.mjs';

// ── File I/O ────────────────────────────────────────────────────────────────
export {
  atomicWriteFileSync,
  normalizePath,
  safeInt,
  readFileOrDie,
  isSensitiveFile,
  readFilesAsContext,
  readFilesAsAnnotatedContext,
  writeOutput,
  parseDiffFile,
  extractPlanPaths,
  classifyFiles
} from './lib/file-io.mjs';

// ── Ledger & R2+ Suppression ────────────────────────────────────────────────
export {
  generateTopicId,
  writeLedgerEntry,
  populateFindingMetadata,
  jaccardSimilarity,
  suppressReRaises,
  buildRulingsBlock,
  R2_ROUND_MODIFIER,
  buildR2SystemPrompt,
  computeImpactSet
} from './lib/ledger.mjs';

// ── Code Analysis & Chunking ────────────────────────────────────────────────
export {
  estimateTokens,
  extractImportBlock,
  splitAtFunctionBoundaries,
  chunkLargeFile,
  extractExportsOnly,
  buildDependencyGraph,
  buildAuditUnits,
  REDUCE_SYSTEM_PROMPT,
  measureContextChars
} from './lib/code-analysis.mjs';

// ── Findings & Learning ─────────────────────────────────────────────────────
export {
  semanticId,
  formatFindings,
  appendOutcome,
  loadOutcomes,
  computePassEffectiveness,
  computePassEWR,
  applyLazyDecay,
  effectiveSampleSize,
  recordWithDecay,
  extractDimensions,
  buildPatternKey,
  FalsePositiveTracker,
  setRepoProfileCache,
  compactOutcomes,
  createRemediationTask,
  trackEdit,
  verifyTask,
  persistTask,
  loadTasks,
  updateTask
} from './lib/findings.mjs';

// ── Project Context & Repo Profiling ────────────────────────────────────────
export {
  generateRepoProfile,
  initAuditBrief,
  readProjectContext,
  readProjectContextForPass,
  extractPlanForPass,
  buildHistoryContext
} from './lib/context.mjs';

// ── File Store ──────────────────────────────────────────────────────────────
export {
  MutexFileStore,
  AppendOnlyStore,
  readJsonlFile
} from './lib/file-store.mjs';

// ── Config (Learning v2) ────────────────────────────────────────────────────
export {
  GLOBAL_CONTEXT_BUCKET,
  GLOBAL_REPO_ID,
  UNKNOWN_FILE_EXT,
  PASS_NAMES,
  normalizeLanguage
} from './lib/config.mjs';

// ── RNG ─────────────────────────────────────────────────────────────────────
export { createRNG, reservoirSample } from './lib/rng.mjs';

// ── Prompt Registry ─────────────────────────────────────────────────────────
export {
  revisionId,
  saveRevision,
  loadRevision,
  getActiveRevisionId,
  getActivePrompt,
  promoteRevision,
  abandonRevision,
  bootstrapFromConstants
} from './lib/prompt-registry.mjs';

// ── Sanitizer ───────────────────────────────────────────────────────────────
export { sanitizeOutcomes, sanitizePath, redactSecrets } from './lib/sanitizer.mjs';

// ── Suppression Policy ──────────────────────────────────────────────────────
export {
  resolveSuppressionPolicy,
  formatPolicyForPrompt,
  shouldSuppressFinding
} from './lib/suppression-policy.mjs';
