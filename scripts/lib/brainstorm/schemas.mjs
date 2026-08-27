/**
 * @fileoverview Zod schemas for brainstorm-round.mjs.
 * Plan: docs/plans/brainstorm-quickfix-v1.md §10.C, §11.A, §12.C, §15.C.
 *
 * Schema layering:
 *   ProviderResultSchema          — single LLM provider response (boundary)
 *   DebateRoundSchema             — single debate round entry (boundary)
 *   BrainstormEnvelopeV1Schema    — pre-this-plan helper output (legacy)
 *   BrainstormEnvelopeV2Schema    — current helper output (with sid/round/debate)
 *   BrainstormOutputSchema        — public alias = union of V1 + V2 for back-compat
 *   BrainstormEnvelopeWriteSchema — what writers MUST emit (V2 strict)
 *   InsightFrontmatterSchema      — yaml frontmatter of saved insight files
 *
 * @module scripts/lib/brainstorm/schemas
 */
import { z } from 'zod';

export const PROVIDER_STATES = [
  'success',
  'misconfigured',
  'timeout',
  'http_error',
  'empty',
  'malformed',
  'blocked',
  // A response that hit the output-token ceiling mid-answer. Distinct from
  // `success` (it is incomplete and must be labelled as such to the reader)
  // and from `empty` (there IS usable text, which is still worth showing).
  'truncated',
];

/**
 * Every voice /brainstorm can speak with. `azure-claude` is the Azure work
 * profile's second voice (Foundry Claude) — the substitution the final reviewer
 * already makes for Gemini, which has no Azure tenant equivalent. The id
 * deliberately matches `gemini-review.mjs`'s provider registry and the
 * `set-provider azure-claude` CLI, so one name means one thing bundle-wide.
 */
export const BRAINSTORM_PROVIDERS = ['openai', 'gemini', 'azure-claude'];

export const ProviderResultSchema = z.object({
  provider: z.enum(BRAINSTORM_PROVIDERS),
  state: z.enum(PROVIDER_STATES),
  text: z.string().nullable(),
  errorMessage: z.string().nullable(),
  httpStatus: z.number().int().nullable(),
  usage: z
    .object({
      inputTokens: z.number().int().min(0),
      outputTokens: z.number().int().min(0),
    })
    .nullable(),
  latencyMs: z.number().int().min(0),
  estimatedCostUsd: z.number().nullable(),
});

/**
 * Debate round entry. State enum is narrower than ProviderResult — debate
 * is only attempted when both providers succeeded in round 1, so there
 * are no `misconfigured` / `blocked` cases (caught earlier in round 1).
 * Plan §12.A canonical 4-case state machine.
 */
export const DebateRoundSchema = z.object({
  provider: z.enum(BRAINSTORM_PROVIDERS),
  reactingTo: z.enum(BRAINSTORM_PROVIDERS),
  state: z.enum(['success', 'malformed', 'timeout', 'http_error', 'empty']),
  text: z.string().nullable(),
  errorMessage: z.string().nullable(),
  httpStatus: z.number().int().nullable(),
  usage: z
    .object({
      inputTokens: z.number().int().min(0),
      outputTokens: z.number().int().min(0),
    })
    .nullable(),
  latencyMs: z.number().int().min(0),
  estimatedCostUsd: z.number().nullable(),  // Plan §15.C — restored after R3
});

/**
 * V1 envelope — pre-this-plan helper output. Has none of the session
 * metadata. Kept around so legacy fixtures and consumer-repo `.brainstorm/`
 * files written before this plan still parse via the union.
 */
export const BrainstormEnvelopeV1Schema = z.object({
  topic: z.string(),
  redactionCount: z.number().int().min(0),
  // One key per provider that was CALLED. Every id must be listed: a plain
  // `z.object` STRIPS unknown keys rather than rejecting them, and the writer
  // emits `parse`d data — so a missing key here would silently drop the model
  // id from the envelope, and Step 3 renders headings from it.
  resolvedModels: z.object({
    openai: z.string().optional(),
    gemini: z.string().optional(),
    'azure-claude': z.string().optional(),
  }),
  providers: z.array(ProviderResultSchema),
  totalCostUsd: z.number(),
});

/**
 * V2 envelope — current helper output. Adds session metadata and optional
 * debate array. `_synthesised` flags fields that were derived from a V1
 * record by the session-store reader (so callers can tell synthesised
 * data apart from real data).
 */
export const BrainstormEnvelopeV2Schema = BrainstormEnvelopeV1Schema.extend({
  sid: z.string().min(1),
  round: z.number().int().min(0),
  capturedAt: z.string().datetime(),
  schemaVersion: z.literal(2),
  debate: z.array(DebateRoundSchema).optional(),
  _synthesised: z.object({ fields: z.array(z.string()) }).optional(),
  // Arch-context fields (docs/plans/brainstorm-arch-context.md). `.optional()`
  // on V2 is the READ-side back-compat allowance — legacy V2 session rows
  // written before this feature still parse. `loadSession()` normalises
  // missing values to false/0/null. The WriteSchema below promotes them to
  // required so a write-side regression that omits one fails at the boundary.
  archContextAttached: z.boolean().optional(),
  archContextChars: z.number().int().nonnegative().optional(),
  archContextWarning: z.string().nullable().optional(),
  // Focal-artifact context (`--with-artifact`). Nullable-and-optional, NOT
  // promoted to required on write: unlike the arch fields this block is
  // absent for every round that didn't request an artifact, so `null` is a
  // real value meaning "not requested" — distinct from an object whose
  // `attached` is empty, which means "requested and all refused".
  // Debate outcome (`--debate`). `null` means the debate round was NOT
  // REQUESTED; an object means it was requested and did not produce a pair,
  // and says why. Same not-requested-vs-requested-and-empty distinction
  // `artifactContext` draws above, and for the same reason: `debate: []` alone
  // was emitted in BOTH cases, so a skill-following agent rendered no debate
  // block and no explanation after the user had already paid for round 1. When
  // the debate DID run, this is null and `debate` carries the entries.
  debateSkipped: z.object({
    reason: z.enum(['not-a-pair', 'round-1-incomplete']),
    detail: z.string().min(1),
  }).nullable().optional(),
  artifactContext: z.object({
    requested: z.number().int().nonnegative(),
    attached: z.array(z.object({
      path: z.string(),
      bytes: z.number().int().nonnegative(),
      truncated: z.boolean(),
    })),
    refused: z.array(z.object({
      path: z.string(),
      reason: z.string().nullable(),
    })),
    policyAttached: z.boolean(),
  }).nullable().optional(),
});

/**
 * Writers MUST emit V2 strict. Non-V2 writes are bugs. Stricter than V2
 * on reads: the three arch-context fields are promoted to required (key
 * must be present; `archContextWarning` value may still be null), so a
 * write that forgets one fails validation instead of being silently
 * masked by the read-side normalizer.
 */
export const BrainstormEnvelopeWriteSchema = BrainstormEnvelopeV2Schema.required({
  archContextAttached: true,
  archContextChars: true,
  archContextWarning: true,
  // Promoted to required on write for the same reason as the arch fields: the
  // KEY must be present so a writer that forgets it fails at the boundary
  // rather than emitting an envelope where "not requested" and "requested and
  // skipped" are once again indistinguishable. The VALUE may still be null —
  // that is the "not requested / it ran" case.
  debateSkipped: true,
});

/**
 * Public-facing parse target — union with V2 first so V2 records normalise
 * cleanly; V1 records validate via the back-compat path. Either succeeds.
 */
export const BrainstormOutputSchema = z.union([
  BrainstormEnvelopeV2Schema,
  BrainstormEnvelopeV1Schema,
]);

/**
 * Insight frontmatter (saved via /brainstorm save). Per plan §10.A.
 */
export const InsightFrontmatterSchema = z.object({
  sid: z.string().min(1),
  round: z.number().int().min(0),
  topic: z.string().min(1).max(200),
  topicSlug: z.string().min(1),
  capturedAt: z.string().datetime(),
  tags: z.array(z.string()).optional(),
});
