/**
 * @fileoverview Canonical Zod schemas and derived JSON Schemas for the audit loop.
 * Single source of truth for finding shapes used by all reviewers (GPT + Gemini).
 * Zod schemas are the primary definition; JSON Schemas are derived explicitly.
 * @module scripts/lib/schemas
 */

import { z } from 'zod';

// ── Classification Schema (SonarQube-style, Phase B) ─────────────────────────

/**
 * Optional nested envelope — all fields within are required WHEN the envelope is present.
 * This keeps schema evolution safe: absent = old format, present = new format fully specified.
 */
export const ClassificationSchema = z.object({
  sonarType: z.enum(['BUG', 'VULNERABILITY', 'CODE_SMELL', 'SECURITY_HOTSPOT']).describe(
    'SonarQube classification: BUG=broken behavior, VULNERABILITY=exploitable flaw, ' +
    'CODE_SMELL=maintainability debt, SECURITY_HOTSPOT=needs manual security review'
  ),
  effort: z.enum(['TRIVIAL', 'EASY', 'MEDIUM', 'MAJOR', 'CRITICAL']).describe(
    'Fix effort estimate: TRIVIAL=<5min, EASY=<30min, MEDIUM=<2h, MAJOR=<1day, CRITICAL=architectural rewrite'
  ),
  sourceKind: z.enum(['MODEL', 'REVIEWER', 'LINTER', 'TYPE_CHECKER']).describe(
    'Stable source category. MODEL=primary auditor (GPT/Claude), REVIEWER=final-gate (Gemini/Opus), ' +
    'LINTER/TYPE_CHECKER=tool output (Phase C).'
  ),
  sourceName: z.string().max(64).describe(
    'Specific tool/model name: "gpt-5.4", "claude-opus-4-1", "gemini-3.1-pro-preview", "eslint", etc.'
  ),
});

// ── Finding Schema ───────────────────────────────────────────────────────────

const FindingBase = {
  id: z.string().max(10).describe('Finding ID, e.g. H1, M3, L2, G1'),
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  category: z.string().max(80).describe('Category: e.g. "DRY Violation", "Missing Error Handling"'),
  section: z.string().max(120).describe('Which plan/code section or file this relates to'),
  detail: z.string().max(600).describe('What is wrong and why it matters'),
  risk: z.string().max(500).describe('What could go wrong if not fixed'),
  recommendation: z.string().max(600).describe('Specific, actionable fix — NOT a quick fix, must be sustainable'),
  is_quick_fix: z.boolean().describe('TRUE if the recommendation is a band-aid rather than a proper fix.'),
  is_mechanical: z.boolean().describe('TRUE if fix is deterministic with exactly one correct answer.'),
  principle: z.string().max(150).describe('Which engineering/UX principle this violates')
};

/**
 * ProducerFindingSchema — what LLMs emit. Classification is REQUIRED.
 * Used as response schema for GPT / Gemini / Claude audit calls.
 */
export const ProducerFindingSchema = z.object({
  ...FindingBase,
  classification: ClassificationSchema,
});

/**
 * FindingVerificationSchema — metadata the deterministic finding-verification
 * gate (scripts/lib/audit/finding-verification.mjs) attaches to a finding
 * AFTER the LLM produced it. The model's own fields stay immutable; the
 * verdict reads `verdictSeverity` / `countsTowardVerdict`, not `severity`.
 * Plan: docs/plans/adaptive-context-blast-radius.md (audit H1, M2, G1, G2).
 *
 * - `refuted`               — entity provably exists; the "missing" claim
 *                             is a context-window artifact. ONLY this
 *                             outcome downgrades (verdictSeverity LOW,
 *                             countsTowardVerdict false).
 * - `confirmed`             — a FILE is provably absent (fs is complete).
 * - `requires_verification` — could not deterministically prove falsity
 *                             (missing-symbol claim — the AST index is
 *                             incomplete; or unresolvable / sensitive /
 *                             out-of-scope). Original severity preserved.
 */
export const FindingVerificationSchema = z.object({
  verification: z.enum(['refuted', 'confirmed', 'requires_verification']),
  verificationReason: z.string().max(300),
  citedEntity: z.object({
    kind: z.enum(['file', 'symbol']),
    name: z.string().max(300),
    fromFile: z.string().max(300).nullable(),
    exportName: z.string().max(200).nullable(),
  }).nullable(),
  verdictSeverity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  countsTowardVerdict: z.boolean(),
});

/**
 * PersistedFindingSchema — what we read from storage. Classification is OPTIONAL/nullable.
 * Old findings written before Phase B have no classification; must still validate.
 * `verification` is attached only to findings the gate classified as
 * existence-claims; absent on all others (they count toward the verdict
 * normally).
 */
export const PersistedFindingSchema = z.object({
  ...FindingBase,
  classification: ClassificationSchema.nullable().optional(),
  verification: FindingVerificationSchema.optional(),
});

/**
 * Backward-compatible alias — existing imports of `FindingSchema` use the permissive
 * persisted schema. Enforcement happens at producer boundaries via ProducerFindingSchema.
 */
export const FindingSchema = PersistedFindingSchema;

// ── Zod-to-Gemini Schema Conversion ─────────────────────────────────────────

/**
 * Keys unsupported by Gemini's responseSchema structured output API.
 * Gemini returns 400 INVALID_ARGUMENT if any of these appear.
 */
const GEMINI_UNSUPPORTED_KEYS = new Set([
  '$schema', 'additionalProperties', 'maxLength', 'minLength',
  'default', '$ref', 'minItems', 'maxItems', 'pattern',
  'exclusiveMinimum', 'exclusiveMaximum',
]);

/**
 * Strip Gemini-unsupported JSON Schema keys recursively.
 * @param {*} obj - JSON Schema node
 * @returns {*} Cleaned node
 */
function stripJsonSchemaExtras(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(stripJsonSchemaExtras);
  const cleaned = {};
  for (const [k, v] of Object.entries(obj)) {
    if (GEMINI_UNSUPPORTED_KEYS.has(k)) continue;
    cleaned[k] = stripJsonSchemaExtras(v);
  }
  return cleaned;
}

/**
 * Convert a Zod schema to Gemini-compatible JSON Schema.
 * Strips all Gemini-unsupported keys (maxLength, default, pattern, etc.).
 * Single source of truth: Zod schema → derived JSON Schema.
 * @param {import('zod').ZodType} zodSchema - Any Zod schema
 * @returns {object} Gemini-compatible JSON Schema
 */
export function zodToGeminiSchema(zodSchema) {
  const raw = z.toJSONSchema(zodSchema);
  return stripJsonSchemaExtras(raw);
}

// ── Derived JSON Schema ──────────────────────────────────────────────────────
// Generated from FindingSchema — single source of truth

export const FindingJsonSchema = zodToGeminiSchema(FindingSchema);

// ── Wiring Issue Schema ──────────────────────────────────────────────────────

export const WiringIssueSchema = z.object({
  frontend_call: z.string().max(120),
  backend_route: z.string().max(120),
  status: z.enum(['wired', 'broken', 'missing']),
  detail: z.string().max(300)
});

// ── Ledger Core Fields (shared by session + debt ledgers — Phase D) ─────────

/**
 * Fields shared by both the session ledger (R2+ deliberation) and the debt ledger
 * (Phase D persistent memory). Extracted for DRY; each ledger composes its own
 * schema from this base plus its own specific fields.
 */
const LedgerCoreFields = {
  topicId: z.string(),
  semanticHash: z.string(),
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  category: z.string(),
  section: z.string(),
  detailSnapshot: z.string(),
  affectedFiles: z.array(z.string()),
  affectedPrinciples: z.array(z.string()),
  pass: z.string(),
  classification: ClassificationSchema.nullable().optional(),
};

// ── Adjudication Ledger Schemas (session — R2+ deliberation) ────────────────

/**
 * Zod 4 schema for a single session-ledger entry.
 * Phase D adds a `source` discriminator with default 'session' for backward-compat:
 * old ledger files without the field continue to validate as session entries.
 */
export const LedgerEntrySchema = z.object({
  ...LedgerCoreFields,
  source: z.literal('session').default('session'),
  adjudicationOutcome: z.enum(['dismissed', 'accepted', 'severity_adjusted']),
  remediationState: z.enum(['pending', 'planned', 'fixed', 'verified', 'regressed']),
  originalSeverity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  ruling: z.enum(['sustain', 'overrule', 'compromise', 'defer']),
  rulingRationale: z.string(),
  resolvedRound: z.number(),
});

/**
 * Minimal schema for batch-ledger write entries (pre-adjudication).
 * Less strict than LedgerEntrySchema — entries may not yet have ruling/rationale.
 * Addresses H9: both write paths now validate against formal schemas.
 */
export const BatchLedgerEntrySchema = z.object({
  topicId: z.string().min(1),
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  findingId: z.string().optional(),
  category: z.string().optional(),
  section: z.string().optional(),
  detail: z.string().optional(),
  round: z.number().optional(),
  adjudicationOutcome: z.enum(['dismissed', 'accepted', 'severity_adjusted', 'pending']).optional(),
  remediationState: z.enum(['pending', 'planned', 'fixed', 'verified', 'regressed']).optional(),
});

/** Zod 4 schema for the full adjudication ledger. */
export const AdjudicationLedgerSchema = z.object({
  version: z.literal(1),
  entries: z.array(LedgerEntrySchema),
  /** Arbitrary metadata preserved on round-trip (runsSinceDebtReview, sessionId, etc.) */
  meta: z.record(z.unknown()).optional(),
});

// ── Debt Ledger Schemas (Phase D) ───────────────────────────────────────────

/**
 * Valid deferral reasons. Each reason has its own required-field contract
 * enforced via refinement (per §2.4 of Phase D plan).
 */
export const DeferredReasonEnum = z.enum([
  'out-of-scope',         // valid, out-of-scope, no extra required fields
  'blocked-by',           // valid, any scope, requires blockedBy
  'deferred-followup',    // valid, any scope, requires followupPr
  'accepted-permanent',   // valid, any scope, requires approver + approvedAt
  'policy-exception',     // valid, any scope, requires policyRef + approver
]);

/**
 * Fields persisted at defer-time. The schema uses a refinement to enforce
 * per-reason required fields without a discriminated union (which would
 * explode into 5 separate object shapes and complicate read sites).
 */
const DebtEntryPersistedFields = {
  ...LedgerCoreFields,
  source: z.literal('debt'),
  deferredReason: DeferredReasonEnum,
  deferredAt: z.string().datetime(),
  deferredRun: z.string().max(40),
  deferredRationale: z.string().min(20).max(400),
  // Per-reason required fields (enforced via superRefine below):
  blockedBy: z.string().max(200).optional(),
  followupPr: z.string().max(120).optional(),
  approver: z.string().max(120).optional(),
  approvedAt: z.string().datetime().optional(),
  policyRef: z.string().max(200).optional(),
  // Owner (populated from CODEOWNERS or --owner flag):
  owner: z.string().max(120).optional(),
  // Identity mitigation (fix H4):
  contentAliases: z.array(z.string().max(12)).max(20).default([]),
  // Sensitivity flag (fix H6):
  sensitive: z.boolean().default(false),
};

function enforceDeferredReasonRequiredFields(entry, ctx) {
  const required = {
    'blocked-by': ['blockedBy'],
    'deferred-followup': ['followupPr'],
    'accepted-permanent': ['approver', 'approvedAt'],
    'policy-exception': ['policyRef', 'approver'],
  }[entry.deferredReason] || [];
  for (const field of required) {
    if (!entry[field]) {
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: `deferredReason "${entry.deferredReason}" requires ${field}`,
      });
    }
  }
}

/**
 * PersistedDebtEntrySchema — what's actually stored on disk in .audit/tech-debt.json.
 * NO runtime-derived fields like occurrences, lastSurfacedAt, escalated — those
 * come from event-log replay (fix H1b). Writers use this schema.
 */
export const PersistedDebtEntrySchema = z.object(DebtEntryPersistedFields)
  .superRefine(enforceDeferredReasonRequiredFields);

/**
 * HydratedDebtEntrySchema — persisted fields PLUS derived runtime fields.
 * What readDebtLedger() returns after replaying the event log. Used by
 * suppression + debt-review + status card.
 */
export const HydratedDebtEntrySchema = z.object({
  ...DebtEntryPersistedFields,
  // Derived from event log:
  occurrences: z.number().int().min(0).default(0),     // alias for distinctRunCount
  distinctRunCount: z.number().int().min(0).default(0),
  matchCount: z.number().int().min(0).default(0),
  lastSurfacedRun: z.string().max(40).optional(),
  lastSurfacedAt: z.string().datetime().optional(),
  escalated: z.boolean().default(false),
  escalatedAt: z.string().datetime().optional(),
}).superRefine(enforceDeferredReasonRequiredFields);

/** Convenience alias at read sites. */
export const DebtEntrySchema = HydratedDebtEntrySchema;

/**
 * DebtEventSchema — individual event-log line.
 * Event types:
 *   deferred   — entry added to ledger
 *   surfaced   — entry matched by suppression (one per topicId per run)
 *   reopened   — entry's files in --changed (not a suppression)
 *   escalated  — --escalate-recurring gate flipped escalated=true
 *   resolved   — entry removed (underlying issue fixed)
 *   reconciled — offline→cloud sync marker (fix R3-H3)
 */
export const DebtEventSchema = z.object({
  ts: z.string().datetime(),
  runId: z.string().max(40),
  topicId: z.string().optional(),                    // absent on 'reconciled' marker
  event: z.enum(['deferred', 'surfaced', 'reopened', 'escalated', 'resolved', 'reconciled']),
  matchCount: z.number().int().min(1).optional(),    // only on 'surfaced' events
  rationale: z.string().max(400).optional(),         // on 'deferred' and 'resolved'
  resolutionRationale: z.string().max(400).optional(), // on 'resolved'
  resolvedBy: z.string().max(40).optional(),         // runId that resolved, on 'resolved'
});

/**
 * DebtLedgerSchema — the top-level .audit/tech-debt.json shape.
 * Entries use PersistedDebtEntrySchema (no derived fields).
 */
export const DebtLedgerSchema = z.object({
  version: z.literal(1),
  entries: z.array(PersistedDebtEntrySchema),
  budgets: z.record(z.string(), z.number().int().min(0)).optional(),
  lastUpdated: z.string().datetime().optional(),
});

// ── Debt Review Schemas (Phase D.3) ─────────────────────────────────────────

/**
 * ClusterSchema — a group of debt entries identified by the LLM as related.
 * Kinds:
 *   file        — entries citing the same module
 *   principle   — entries violating the same engineering principle
 *   recurrence  — entries with high distinctRunCount (systemic signal)
 */
export const ClusterSchema = z.object({
  id: z.string().max(40).describe('Stable cluster id, e.g. cluster-god-module-openai'),
  title: z.string().max(120),
  kind: z.enum(['file', 'principle', 'recurrence']),
  entries: z.array(z.string()).max(50).describe('topicIds of member entries'),
  rationale: z.string().max(500),
});

/**
 * RefactorCandidateSchema — a proposed refactor pass that would resolve
 * one or more clusters. LLM proposes clusterId + effort + risks; server
 * computes leverageScore from resolved entries' sonarType weights.
 */
export const RefactorCandidateSchema = z.object({
  clusterId: z.string().max(40),
  targetModules: z.array(z.string().max(120)).max(10),
  resolvedTopicIds: z.array(z.string()).max(50),
  effortEstimate: z.enum(['TRIVIAL', 'EASY', 'MEDIUM', 'MAJOR', 'CRITICAL']),
  effortRationale: z.string().max(400),
  risks: z.array(z.string().max(200)).max(5),
  rollbackStrategy: z.string().max(400),
});

/**
 * DebtReviewResultSchema — the full LLM output contract for debt-review.
 * leverageScore is computed server-side (see lib/debt-review-helpers.mjs)
 * and added to RefactorCandidates post-validation. budgetViolations are
 * also server-computed from the debt ledger + budgets map.
 */
// ── Meta-Assessment Schema ──────────────────────────────────────────────────

export const MetaAssessmentSchema = z.object({
  window: z.object({
    fromRun: z.number(),
    toRun: z.number(),
    outcomeCount: z.number(),
    dateRange: z.string().max(100),
  }),
  metrics: z.object({
    fpRate: z.object({
      overall: z.number(),
      byPass: z.record(z.number()),
      trend: z.enum(['improving', 'stable', 'worsening']),
    }),
    signalQuality: z.object({
      findingsLeadingToChanges: z.number(),
      totalFindings: z.number(),
      changeRate: z.number(),
    }),
    severityCalibration: z.object({
      highAcceptanceRate: z.number(),
      mediumAcceptanceRate: z.number(),
      lowAcceptanceRate: z.number(),
      miscalibrated: z.boolean(),
    }),
    convergenceSpeed: z.object({
      avgRoundsToConverge: z.number(),
      medianRoundsToConverge: z.number(),
      trend: z.enum(['faster', 'stable', 'slower']),
    }),
  }),
  diagnosis: z.string().max(2000),
  recommendations: z.array(z.object({
    type: z.enum(['prompt_change', 'threshold_adjustment', 'pass_config', 'pipeline_config']),
    target: z.string().max(100),
    action: z.string().max(500),
    rationale: z.string().max(300),
    priority: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  })).max(10),
  overallHealth: z.enum(['healthy', 'needs_attention', 'degraded']),
});

// ── Debt Review Schema ──────────────────────────────────────────────────────

export const DebtReviewResultSchema = z.object({
  summary: z.object({
    totalEntries: z.number().int().min(0),
    clustersIdentified: z.number().int().min(0),
    oldestEntryDays: z.number().int().min(0),
    staleEntries: z.array(z.string()).max(100).describe('topicIds older than --ttl-days'),
  }),
  clusters: z.array(ClusterSchema).max(20),
  refactorPlan: z.array(RefactorCandidateSchema).max(10),
  reasoning: z.string().max(1500),
});

// ── Execution Meta Schema (P0 — audit pipeline status) ──────────────────────

/**
 * Canonical reduce execution status values — used by ReduceStatus constant and
 * ExecutionMetaSchema. String literals so they work both as a Zod enum and as
 * plain object properties without import coupling.
 */
export const REDUCE_STATUS_VALUES = /** @type {const} */ ([
  'ok', 'parse_error', 'timeout', 'model_error', 'budget_exceeded', 'skipped'
]);

/**
 * Explicit reduce execution status — avoids conflating success-with-zero vs failure.
 * Import this constant instead of using raw strings.
 */
export const ReduceStatus = Object.freeze({
  OK: 'ok',
  PARSE_ERROR: 'parse_error',
  TIMEOUT: 'timeout',
  MODEL_ERROR: 'model_error',
  BUDGET_EXCEEDED: 'budget_exceeded',
  SKIPPED: 'skipped',
});

/**
 * Optional execution-meta block added to audit result objects.
 * Typed SSOT — all execution status flags live here, not as ad-hoc top-level booleans.
 */
export const ExecutionMetaSchema = z.object({
  reduceStatus: z.enum(REDUCE_STATUS_VALUES).optional(),
  reduceSkipped: z.boolean().optional(),
  suppressionUnavailable: z.boolean().optional(),
  passesSkipped: z.array(z.string()).optional(),
  predictionUsed: z.boolean().optional(),
}).optional();

// ── Repo Stack Detection (Phase A) ──────────────────────────────────────────

/**
 * Canonical output shape for `cross-skill.mjs detect-stack`.
 * Shared by plan-backend, plan-frontend, ship — see scripts/lib/repo-stack.mjs.
 */
export const StackProfileSchema = z.object({
  ok: z.literal(true),
  stack: z.enum(['js-ts', 'python', 'mixed', 'unknown']),
  pythonFramework: z.enum(['fastapi', 'django', 'flask', 'none']).nullable(),
  environmentManager: z.enum(['poetry', 'uv', 'pipenv', 'venv', 'none']).nullable(),
  detectedFrom: z.array(z.string()),
  // Architecture-intent extension: list of stack kinds for per-stack adapter
  // selection.  For non-mixed: singleton (or empty for 'unknown'). For mixed:
  // multiple entries.  Adapter selection iterates this list.
  stackKinds: z.array(z.enum(['js-ts', 'python', 'java', 'postgres'])).default([]),
});

// ── Architecture-Intent Framework (PR-A) ────────────────────────────────────

/**
 * Domain map config shape — extension of the existing rules-only format.
 * Lives at `.audit-loop/domain-map.json`.
 *
 * `allowedDeps` lifecycle (decision 12):
 *   - field absent OR null → SKIPPED_NO_BASELINE (loader returns null)
 *   - {} (empty object)     → every cross-domain edge forbidden (operator's explicit choice)
 *   - {keys: [values]}      → standard whitelist
 */
export const DomainMapSchema = z.object({
  _comment: z.string().optional(),
  rules: z.array(z.object({
    pattern: z.string().min(1),
    domain: z.string().regex(/^[a-z][a-z0-9_-]{0,49}$/),
  })),
  allowedDeps: z.record(z.string(), z.array(z.string())).nullable().optional(),
  description: z.record(z.string(), z.string()).optional(),
});

/**
 * One violation emitted by an adapter.
 */
export const ArchIntentViolationSchema = z.object({
  fromFile: z.string(),
  toFile: z.string(),
  fromDomain: z.string(),
  toDomain: z.string(),
  ruleViolated: z.enum(['not-in-allowedDeps', 'cycle', 'unknown']).default('not-in-allowedDeps'),
});

/**
 * Per-stack adapter result envelope (decision 13 — fault isolation).
 */
export const ArchIntentPerStackSchema = z.object({
  stackKind: z.string(),
  status: z.enum(['ok', 'error', 'unsupported']),
  report: z.object({
    violations: z.array(ArchIntentViolationSchema),
    _meta: z.record(z.string(), z.unknown()).default({}),
  }).optional(),
  error: z.object({
    message: z.string(),
    kind: z.enum(['config', 'analyzer']),
  }).optional(),
});

/**
 * Top-level report returned by runArchIntentAnalysis. The merge of all
 * successful perStackResults plus inventory-phase results.
 */
export const ArchIntentReportSchema = z.object({
  violations: z.array(ArchIntentViolationSchema).default([]),
  unmappedFiles: z.array(z.string()).default([]),
  deadIntent: z.array(z.string()).default([]),
  analyzerVersion: z.string().default('none'),
  perStackResults: z.array(ArchIntentPerStackSchema).default([]),
  _meta: z.record(z.string(), z.unknown()).default({}),
});

/**
 * GPT response shape for the architecture audit pass.
 *
 * findings MUST be ProducerFindingSchema (what LLMs emit), NOT FindingSchema/
 * PersistedFindingSchema — the persisted shape carries the post-LLM
 * `verification` attachment (`.optional()` without `.nullable()`), which the
 * OpenAI structured-outputs API REJECTS ("all fields must be required"), so
 * the pass failed on every audit and silently degraded to the deterministic
 * fallback. Every other pass already uses ProducerFindingSchema; this was the
 * one divergence. Contract-guarded by tests/schemas-openai-compat.test.mjs.
 */
export const ArchIntentPassSchema = z.object({
  pass_name: z.literal('architecture').default('architecture'),
  findings: z.array(ProducerFindingSchema).default([]),
  summary: z.string().default(''),
});

// ── Orphan-Introduced Check (Dead-Code Phase 1) ─────────────────────────────

/**
 * Pass-state taxonomy for the orphan-introduced detector.
 * Mirrors arch-intent's pass-state model; `ANALYZED_PARTIAL` inherited from
 * upstream arch-intent partial-graph signal (Gemini-R2/M2 fix).
 */
export const OrphanPassStateSchema = z.enum([
  'ANALYZED_CLEAN',
  'ANALYZED_WITH_FINDINGS',
  'ANALYZED_PARTIAL',
  'SKIPPED_NO_BASELINE',
  'SKIPPED_NO_GRAPH',
  'SKIPPED_PATCH_ONLY_MODE',
  'SKIPPED_UNSUPPORTED_STACK',
  'ERROR',
]);

/**
 * One row of `git diff --name-status` after orchestration parsing.
 * R2/H1 fix — explicit base + head caller identities, distinct for renames.
 * Gemini-R3/L1 — 'C' (copy) treated like 'A'.
 */
export const ChangedFileSchema = z.object({
  status: z.enum(['A', 'C', 'M', 'D', 'R']),
  baseCallerPath: z.string().nullable(),
  headCallerPath: z.string().nullable(),
});

/**
 * The fully-resolved diff scope passed into the pure detector.
 * Sets serialised as sorted arrays for Zod-compatibility + JSON portability.
 */
export const DiffScopeSchema = z.object({
  baseRef: z.string().nullable(),
  headRef: z.string().nullable(),
  changedFiles: z.array(ChangedFileSchema).default([]),
  preEdgesByBaseCaller: z.record(z.string(), z.array(z.string())).default({}),
  targetExistedAtBase: z.array(z.string()).default([]),
  entryPoints: z.array(z.string()).default([]),
  state: OrphanPassStateSchema.default('ANALYZED_CLEAN'),
});

/**
 * HEAD graph projection exposed by the js-ts adapter for orphan analysis.
 * R1/M1 fix — directionally explicit. Includes type-only edges per Gemini-R3/H1.
 */
export const HeadGraphMetaSchema = z.object({
  callersByTarget: z.record(z.string(), z.array(z.string())).default({}),
  targetsByCaller: z.record(z.string(), z.array(z.string())).default({}),
  allFiles: z.array(z.string()).default([]),
});

/**
 * Raw orphan finding emitted by the detector (pre-pipeline).
 * `allRemovedCallers` is REQUIRED — used by the pipeline for stable
 * fingerprinting (Gemini-G1 fix). Empty array for born-orphans.
 */
export const OrphanIntroducedFindingSchema = z.object({
  severity: z.literal('MEDIUM'),
  kind: z.literal('orphan-introduced'),
  subKind: z.enum(['left-orphan', 'born-orphan']),
  file: z.string(),
  allRemovedCallers: z.array(z.string()).default([]),
  priorCallers: z.array(z.string()).default([]),
  testCallers: z.array(z.string()).default([]),
  rationale: z.string(),
});

// ── persona-clickpath → nav reachability seeding (plan: docs/completed/persona-clickpath-nav-seeding.md) ──

/**
 * One step of the path a persona walked. `.strict()` is a SECURITY control
 * (R2-M5/R3-H1): an injected `value`/`input` key (a typed credential/PII) is a
 * validation ERROR, used by the store's per-entry drop-invalid — typed input
 * values are never stored. `url` is sanitized + `targetText` redacted server-side
 * before write (in recordPersonaSession), so this only shapes the structure.
 */
export const ClickPathStepSchema = z.object({
  step: z.number().int().nonnegative().optional(),
  action: z.enum(['click', 'navigate', 'type', 'fill', 'select', 'hover', 'scroll', 'press', 'submit', 'wait']),
  url: z.string().min(1),
  targetText: z.string().max(80).nullable().optional(),
}).strict();

/** Request for the `get-reachability-evidence` cross-skill command. */
export const ReachabilityEvidenceRequestSchema = z.object({
  repoName: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),   // per-persona cap
  sinceDays: z.number().int().positive().optional(),
});

/** Response contract: per-persona reached URLs (nav-audit normalizes URL→destination). */
export const ReachabilityEvidenceResponseSchema = z.object({
  ok: z.boolean(),
  cloud: z.boolean(),
  personas: z.array(z.object({
    persona: z.string(),
    reached: z.array(z.object({
      url: z.string(),
      clickedText: z.string().nullable().optional(),
      sessions: z.number().int().nonnegative(),
      lastSeen: z.string().nullable().optional(),
    })),
  })).default([]),
});
