/**
 * @fileoverview Zod schemas for the requirements layer.
 * Plan: docs/plans/requirements-layer.md.
 *
 * Three distinct contracts (audit H2 — a *candidate* is by definition
 * observed-in-code, so the gap classes are not all candidate properties):
 *   RequirementCandidateSchema — what extraction emits (a hypothesis)
 *   GapAssessmentSchema        — what gap-challenge emits, keyed by candidate
 *   RequirementSchema          — the reconciled active requirement
 *   RequirementsLedgerSchema   — the persisted .requirements/ledger.json
 *   OverridesSchema            — the hand-curated .requirements/overrides.json
 *
 * @module scripts/lib/requirements/schema
 */
import { z } from 'zod';

export const REQUIREMENT_KINDS = ['security', 'safety', 'correctness', 'behavioural', 'persistence'];
export const GAP_CLASSES = ['none', 'observed-but-unintended', 'untested', 'contradictory'];
export const REQUIREMENT_STATUSES = ['active', 'needs-review', 'superseded', 'inferred-only'];

/**
 * The canonical requirement-id shape — `REQ-<kind>-<hash8>`. SINGLE source of
 * truth (audit M5/M6): every id-bearing field reuses this, so `requirementId`
 * and `conflictsWith` get the same constraint as the minting `id`. The kind
 * segment is bound to `REQUIREMENT_KINDS` — the regex cannot drift from the
 * enum (audit M6).
 */
export const RequirementIdSchema = z.string().regex(
  new RegExp(`^REQ-(?:${REQUIREMENT_KINDS.join('|')})-[0-9a-f]{8}$`),
);

/** WHERE a requirement is declared/evidenced — multi-valued (audit H3). */
const ProvenanceSchema = z.object({
  file: z.string().min(1).max(300),
  anchor: z.string().max(200),
});

/**
 * What `extract` emits — a DE-FACTO observation, a hypothesis, not yet a
 * confirmed requirement. `id` is content-seeded then frozen (see ledger).
 */
export const RequirementCandidateSchema = z.object({
  id: RequirementIdSchema,
  assertion: z.string().min(8).max(200),
  kind: z.enum(REQUIREMENT_KINDS),
  checkable: z.boolean(),
  provenance: z.array(ProvenanceSchema).min(1),
  appliesTo: z.array(z.string().max(300)),       // files/globs the invariant GOVERNS
  evidence: z.object({
    code: z.array(z.string().max(300)),
    tests: z.array(z.string().max(300)),
  }),
  seenInRuns: z.number().int().min(1),
  confidence: z.enum(['high', 'medium', 'low']),
});

/**
 * A raw extraction item — what the LLM emits BEFORE id-assignment + merge.
 * Validated per-item at the extraction boundary (audit M4/M12/H1) so a
 * malformed item is dropped, not allowed to poison the whole batch. Every
 * field `mergeRequirements` later reads is typed here — the structural
 * fields are NOT `passthrough`-ignored, because a string where an array is
 * expected would crash the merge (audit H1). Unknown extra keys are
 * stripped. Optional fields are tolerated absent; `mergeRequirements`
 * defaults them.
 */
export const RawExtractionItemSchema = z.object({
  // `min(8)` is aligned with RequirementCandidateSchema.assertion — a too-short
  // assertion must be DROPPED here as malformed, not pass the batch and then
  // abort the whole `CandidatesFileSchema.parse` write (Gemini new-finding).
  // `max(500)` stays lenient — `mergeRequirements` truncates to 200.
  assertion: z.string().min(8).max(500),
  kind: z.enum(REQUIREMENT_KINDS),
  checkable: z.boolean().optional(),
  provenance: z.array(z.object({
    file: z.string(),
    anchor: z.string().optional(),
  })).optional(),
  appliesTo: z.array(z.string()).optional(),
  evidence: z.object({
    code: z.array(z.string()).optional(),
    tests: z.array(z.string()).optional(),
  }).optional(),
});

/**
 * What `gap-challenge` emits — a separate assessment keyed by candidate id.
 * The refine encodes the state invariant (audit M7): a `contradictory` gap is
 * meaningless without the ids it contradicts, so it MUST name `conflictsWith`.
 * `classifyGaps` coerces a contradictory-but-empty LLM response to `none`, so
 * this refinement never rejects our own writer — it guards hand-edits + drift.
 */
export const GapAssessmentSchema = z.object({
  requirementId: RequirementIdSchema,
  gap: z.enum(GAP_CLASSES),
  conflictsWith: z.array(RequirementIdSchema),   // requirement ids (gap=contradictory)
  rationale: z.string().max(400),
}).refine(
  (g) => g.gap !== 'contradictory' || g.conflictsWith.length > 0,
  { message: "a 'contradictory' gap must name at least one id in conflictsWith", path: ['conflictsWith'] },
);

/** The reconciled active requirement (candidate + gap + override applied). */
export const RequirementSchema = RequirementCandidateSchema.extend({
  status: z.enum(REQUIREMENT_STATUSES),
  gap: GapAssessmentSchema.nullable(),
});

/** Reject collections that carry a duplicate requirement id (audit M7). */
const uniqueIds = (key) => (arr) => new Set(arr.map(key)).size === arr.length;

/** The persisted ledger — the SINGLE source of truth (the index is derived). */
export const RequirementsLedgerSchema = z.object({
  generatedAt: z.string().min(1),
  commitSha: z.string().nullable(),
  extractionSourceSha: z.string().nullable(),
  coveredFiles: z.array(z.string()),
  requirements: z.array(RequirementSchema)
    .refine(uniqueIds((r) => r.id), { message: 'duplicate requirement id in ledger' }),
  // reworded-candidate-id → frozen-ledger-id (audit G3 — keyed by what
  // extraction produces, routing to the frozen id). Both sides are
  // requirement ids — enforce that (Gemini new-finding).
  identityAliases: z.record(RequirementIdSchema, RequirementIdSchema),
});

/**
 * `.requirements/overrides.json` — hand-curated, keyed by frozen requirement
 * id. `accept` → force active; `reject` → drop; `assertion` → an edited text.
 */
export const OverrideEntrySchema = z.object({
  decision: z.enum(['accept', 'reject']).optional(),
  assertion: z.string().min(8).max(200).optional(),
  note: z.string().max(400).optional(),
}).refine(
  // A note-only / empty entry expresses no delta — reject it as a no-op so a
  // mistyped override surfaces instead of silently doing nothing (audit L4).
  (o) => o.decision !== undefined || o.assertion !== undefined,
  { message: 'an override entry must set `decision` or `assertion` (a note alone is a no-op)' },
);
// Keyed by the FROZEN requirement id (audit M5) — a stale or mistyped key
// is rejected so it surfaces rather than silently overriding nothing.
export const OverridesSchema = z.record(RequirementIdSchema, OverrideEntrySchema);

/** Candidates file = extraction output before reconcile. */
export const CandidatesFileSchema = z.object({
  generatedAt: z.string().min(1),
  extractionSourceSha: z.string().nullable(),
  coveredFiles: z.array(z.string()),
  candidates: z.array(RequirementCandidateSchema)
    .refine(uniqueIds((c) => c.id), { message: 'duplicate requirement id in candidates' }),
});

/** Gaps file = gap-challenge output (one assessment per candidate id). */
export const GapsFileSchema = z.object({
  generatedAt: z.string().min(1),
  assessments: z.array(GapAssessmentSchema)
    .refine(uniqueIds((g) => g.requirementId), { message: 'duplicate requirementId in assessments' }),
});
