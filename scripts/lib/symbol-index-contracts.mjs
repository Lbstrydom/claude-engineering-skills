/**
 * @fileoverview Zod data + presentation contracts for architectural memory.
 * Single source of truth for shapes that cross module boundaries (per M3).
 *
 * Two groups:
 * - DATA contracts: what flows from learning-store / RPC to consumers
 * - PRESENTATION contracts: what arch-render functions return
 *
 * @module scripts/lib/symbol-index-contracts
 */

import { z } from 'zod';

// ── Symbol identity & shape ─────────────────────────────────────────────────

export const SymbolKindEnum = z.enum([
  'function', 'class', 'component', 'hook', 'route',
  'method', 'constant', 'type', 'other',
]);

/**
 * One row from `symbol_index` joined to `symbol_definitions`.
 * Embedding NOT included (consumers don't need 700+ floats; only RPCs do).
 * `definitionId` MUST be present (per Gemini G3) for backend consumers /
 * diagnostics / cross-snapshot joins.
 */
export const SymbolRecordSchema = z.object({
  id:              z.string().uuid(),         // snapshot row id
  definitionId:    z.string().uuid(),         // stable per-repo identity
  refreshId:       z.string().uuid(),
  repoId:          z.string().uuid(),
  filePath:        z.string(),
  startLine:       z.number().int().nullable(),
  endLine:         z.number().int().nullable(),
  symbolName:      z.string(),
  kind:            SymbolKindEnum,
  signatureHash:   z.string(),
  purposeSummary:  z.string().nullable(),
  domainTag:       z.string().nullable(),
});

export const ScoredSymbolRecordSchema = SymbolRecordSchema.extend({
  score:           z.number().min(0).max(1),
  hopScore:        z.number().min(0).max(1),
  // NULLABLE by contract (plan §2.1 C3): null means the symbol has no
  // embedding for the active (model, dim, signature), i.e. NO EVIDENCE. It is
  // deliberately not defaulted to 0 — a fabricated 0 bands as `review`, which
  // asserts "considered and rejected" about something never compared.
  similarityScore: z.number().min(-1).max(1).nullable(),
  // `scored` lets a consumer distinguish absence from a low score without
  // having to probe for null.
  scored:          z.boolean().optional(),
  // Why the band came out as it did — `uncalibrated-repo`, `below-noise-floor`,
  // `not-distinctive`, `above-floor-and-distinctive`, `no-embedding`. Without
  // this a `review` is unattributable, and "the repo has no calibration" looks
  // identical to "we compared and it was weak".
  bandReason:      z.string().optional(),
  // Gap to the runner-up. The floor alone is fragile under hubness; this is
  // what says the top hit is DISTINCTIVE rather than merely above a number.
  cliff:           z.number().nullable().optional(),
  // `reuse` / `extend` retired (C7-REVISED): the derived cutoffs were 0.01
  // apart against ~0.008 run-to-run variance, and the reuse-vs-extend choice
  // depends on dependency direction, API shape and ownership — none of which a
  // cosine distance expresses. `precedent` = "existing code merits a look".
  recommendation:  z.enum(['unscored', 'review', 'precedent', 'justify-divergence']),
});

// ── Query args ──────────────────────────────────────────────────────────────

/**
 * Args for `getNeighbourhoodForIntent` — kind filter pushed into RPC per R3 M1.
 */
export const NeighbourhoodQueryArgsSchema = z.object({
  repoUuid:          z.string().min(1),
  targetPaths:       z.array(z.string()).default([]),
  intentDescription: z.string().min(1),
  k:                 z.number().int().positive().default(50),
  kind:              z.array(SymbolKindEnum).optional(),
});

// ── Result envelopes ────────────────────────────────────────────────────────

export const NeighbourhoodResultSchema = z.object({
  cloud:     z.boolean(),
  refreshId: z.string().uuid().nullable(),
  records:   z.array(ScoredSymbolRecordSchema),
  totalCandidatesConsidered: z.number().int().nonnegative(),
  truncated:                 z.boolean(),
  hint:                      z.string().nullable(),
});

export const DriftReportSchema = z.object({
  refreshId:           z.string().uuid().nullable(),
  generatedAt:         z.string(),
  driftScore:          z.number().nonnegative(),
  threshold:           z.number().positive(),
  duplicationPairs:    z.number().int().nonnegative(),
  layeringViolations:  z.number().int().nonnegative(),
  namingDivergences:   z.number().int().nonnegative(),
  status:              z.enum(['GREEN', 'AMBER', 'RED', 'INSUFFICIENT_DATA']),
});

// ── Refresh lifecycle ───────────────────────────────────────────────────────

export const RefreshModeEnum = z.enum(['full', 'incremental']);
export const RefreshStatusEnum = z.enum(['running', 'published', 'aborted']);
export const RetentionClassEnum = z.enum([
  'active', 'rollback', 'weekly_checkpoint', 'transient', 'aborted',
]);

export const RefreshRunSchema = z.object({
  id:                z.string().uuid(),
  repoId:            z.string().uuid(),
  mode:              RefreshModeEnum,
  status:            RefreshStatusEnum,
  walkStartCommit:   z.string().nullable(),
  walkEndCommit:     z.string().nullable(),
  retentionClass:    RetentionClassEnum,
  startedAt:         z.string(),
  completedAt:       z.string().nullable(),
});

// ── Symbol definitions (stable identity per R2 H7) ──────────────────────────

export const SymbolDefinitionSchema = z.object({
  id:             z.string().uuid(),
  repoId:         z.string().uuid(),
  canonicalPath:  z.string(),
  symbolName:     z.string(),
  kind:           SymbolKindEnum,
  firstSeenAt:    z.string(),
  lastSeenAt:     z.string(),
  archivedAt:     z.string().nullable(),
});

// ── Extracted-symbol record (pre-storage) ───────────────────────────────────
// What `extract.mjs` emits per symbol; what `summarise.mjs` and `embed.mjs`
// enrich and pass to the upserter.

export const ExtractedSymbolSchema = z.object({
  filePath:       z.string(),
  symbolName:     z.string(),
  kind:           SymbolKindEnum,
  startLine:      z.number().int().nullable(),
  endLine:        z.number().int().nullable(),
  signature:      z.string(),
  bodyText:       z.string(),       // the gate may have already redacted; if so, '[SECRET_REDACTED]'
  signatureHash:  z.string(),       // sha256(name + normalised_signature + sha256(normalised_body))
  isExported:     z.boolean(),
  // populated by downstream stages:
  purposeSummary: z.string().nullable().optional(),
  embedding:      z.array(z.number()).nullable().optional(),
  embeddingModel: z.string().nullable().optional(),
  embeddingDim:   z.number().int().nullable().optional(),
});

// ── Layering violation record ───────────────────────────────────────────────

export const LayeringViolationSchema = z.object({
  ruleName: z.string(),
  fromPath: z.string(),
  toPath:   z.string(),
  severity: z.enum(['error', 'warn', 'info']),
  comment:  z.string().nullable(),
});

// ── Presentation contracts ──────────────────────────────────────────────────

export const RenderedNeighbourhoodCalloutSchema = z.object({
  markdown:           z.string(),
  appendixMarkdown:   z.string(),
  truncatedAt:        z.number().int().nonnegative(),
});

export const RenderedArchitectureMapSchema = z.object({
  markdown:     z.string(),
  bytesWritten: z.number().int().nonnegative(),
});

export const RenderedDriftIssueSchema = z.object({
  markdown:         z.string(),
  topClustersShown: z.number().int().nonnegative(),
  longTailHidden:   z.number().int().nonnegative(),
});
