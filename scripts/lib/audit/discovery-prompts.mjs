/**
 * @fileoverview Prompt + schema construction for the tiered discovery
 * generators and the Stage 1 triager. Pure — no I/O, no provider calls
 * (those live in `./tiered-provider-calls.mjs`).
 *
 * Extracted from `tiered-pipeline.mjs` (docs/plans/tiered-pipeline-refresh-god-module-decomposition.md).
 *
 * @module scripts/lib/audit/discovery-prompts
 */

import { z } from 'zod';
import { makeProducerFindingV3Schema, clampToJsonSchemaLimits } from '../schemas.mjs';
import { renderDiffPathTable } from './diff-path-map.mjs';

/**
 * RETIRED (evidence-anchor-path-contract Phase 6): `normalizeModifiedAnchorPaths`.
 *
 * It mirrored `oldFile`↔`newFile` across a `'modified'` anchor because
 * `EvidenceAnchorSchema.superRefine` demanded both and GLM only ever sent one.
 * That was a band-aid on the wrong layer: the real defect was ASKING the model
 * for `oldFile`/`newFile`/`fileStatus` at all. They are facts about the diff,
 * not claims about the finding — Gate A always re-verified them against the
 * real diff anyway, i.e. they were never trusted as model input, so asking for
 * them yielded zero information and existed only as a failure surface (plan D1).
 *
 * They are now DERIVED from our own diff-path map by `prepareCandidates`, so
 * there is nothing left to mirror. `clampToJsonSchemaLimits` (the maxLength/
 * maxItems half of the same lenient-ingestion pipe) is RETAINED — OSS routers
 * still accept our JSON Schema without enforcing string/array limits.
 */

/**
 * Return a deep copy of `jsonSchema` with `maxLength` removed from every
 * property named `fieldName`, at any depth.
 *
 * The one consumer is the discovery generators' lenient clamping: clamping is a
 * length-only repair that saves a verbose-but-genuine finding, but it must not
 * touch a field whose VALUE is semantically checked downstream. `quote` is the
 * only such field — Gate A matches it verbatim — so truncating it converts our
 * own repair into a false "the model's evidence was wrong" verdict.
 *
 * Derived from the schema rather than a hardcoded prose-field allowlist, so a
 * new capped field is clamped automatically and cannot drift.
 *
 * Pure; never mutates the input (the strict schema is shared with the GLM path).
 *
 * @param {object} jsonSchema
 * @param {string} fieldName
 * @returns {object}
 */
export function stripMaxLengthFor(jsonSchema, fieldName) {
  if (jsonSchema == null || typeof jsonSchema !== 'object') return jsonSchema;
  if (Array.isArray(jsonSchema)) return jsonSchema.map((s) => stripMaxLengthFor(s, fieldName));
  const out = {};
  for (const [key, value] of Object.entries(jsonSchema)) {
    if (key === 'properties' && value && typeof value === 'object') {
      const props = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        const walked = stripMaxLengthFor(propSchema, fieldName);
        if (propName === fieldName && walked && typeof walked === 'object' && !Array.isArray(walked)) {
          const { maxLength, ...rest } = walked;
          props[propName] = rest;
        } else {
          props[propName] = walked;
        }
      }
      out[key] = props;
    } else if (value && typeof value === 'object') {
      out[key] = stripMaxLengthFor(value, fieldName);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Shared prompt construction for the Stage 1 triager — used by BOTH the
 * GPT-5.5 default adapter and the validated-manifest (GLM) adapter, so a
 * model swap changes only which primitive answers the same question, never
 * the question itself.
 *
 * audit-orchestrator-hardening Phase 8: receives the minimized, redacted
 * `StageOneTriageInputSchema` DTO `runStage1CheapTriage` builds — never the
 * raw envelope. `dto.anchorQuote`/`dto.causalChain` are already evidence-
 * normalized + redacted by `buildStageOneTriageInput`.
 * @param {import('../schemas.mjs').StageOneTriageInput} dto
 * @returns {{system: string, userPrompt: string}}
 */
export function buildStage1TriagerPrompt(dto) {
  let evidenceBlock = 'Evidence: none available (evidenceStatus=missing) — cannot be dismissed without a concrete disproof; escalate rather than guess.';
  if (dto.evidenceStatus === 'commission' && dto.anchorQuote) {
    evidenceBlock = `Evidence (commission, content-verified by Stage 0):\nCited text:\n${dto.anchorQuote}`;
  } else if (dto.evidenceStatus === 'omission') {
    evidenceBlock = `Evidence (omission):\nCausal chain: ${dto.causalChain ?? '(unavailable)'}\n${dto.anchorQuote ? `Trigger text:\n${dto.anchorQuote}` : ''}`;
  }
  return {
    system: 'You are a cheap Stage-1 triager for a code-audit candidate finding. Decide whether you can DETERMINISTICALLY disprove the finding using ONLY the evidence provided below (e.g. the cited quote does not match the claimed defect, the causal chain trigger does not actually create the claimed obligation). If the evidence is absent or insufficient to check the claim, do NOT attempt a dismissal — a plausible-sounding but ungrounded dismissal is worse than no dismissal.',
    userPrompt: `Finding: ${dto.category ?? ''} — ${dto.detail ?? ''}\nSection: ${dto.section ?? ''}\nSeverity: ${dto.severity ?? ''}\n\n${evidenceBlock}`,
  };
}

/**
 * Build the discovery generators' shared prompt/schema contract from this
 * run's diff-path map: the anchor-contract instruction text, the per-run
 * producer-finding schema (enum-narrowed to the map's own ids), and the two
 * generators' lenient-ingestion wrappers around it.
 *
 * ONE source for both the prompt table and the schema enum (D7 of the
 * tiered-recall plan), so they cannot drift — `diffPathMap` must be the
 * `kind: 'ready'` shape (a non-empty, filtered `entries` array); the caller
 * (`runTieredAuditPipeline`) already resolves that before calling this.
 *
 * @param {{entries: Array<{id: string}>}} diffPathMap
 * @returns {{diffPathTable: string, anchorContract: string, producerFindingSchema: import('zod').ZodType, glmLenientSchema: import('zod').ZodType, glmResponseValidationSchema: import('zod').ZodType, unclampedQuoteSchema: object, sonnetFindingsTool: object}}
 */
export function buildDiscoveryContract(diffPathMap) {
  const diffPathTable = renderDiffPathTable(diffPathMap.entries);
  const producerFindingSchema = makeProducerFindingV3Schema(diffPathMap.entries.map((e) => e.id));
  // The instruction both generators share. `diffPathId` is an ENUM in the schema
  // the provider actually sees — the one row of D1's table a provider CAN
  // enforce — but the enum is a funnel, never a trust boundary (D6):
  // `prepareCandidates` safeParses every response regardless.
  const anchorContract = [
    'ANCHOR CONTRACT — a finding is discarded outright if its anchor breaks these:',
    '- `diffPathId` MUST be an `id` copied EXACTLY from the DIFF-PATH TABLE below. It is the ONLY way to name a file. Never write a path there, and never invent an id.',
    '- Do NOT report paths or file status — we derive those from the id ourselves.',
    '- `quote` MUST be text copied VERBATIM from the code you were given. Never paraphrase, reformat, or reconstruct it — it is verified by exact content match against the real file/diff.',
    '- `side` is "head" for current/added code and "base" for removed code. An `added` file has no base side; a `deleted` file has no head side.',
    '- `startLine`/`endLine` are 1-indexed and must bracket the quote (`startLine <= endLine`).',
    '- commission findings need `anchor`; omission findings need `triggerAnchor` AND `causalChain`.',
    '',
    'DIFF-PATH TABLE — the only files you may cite:',
    diffPathTable,
  ].join('\n');

  // Named for the CONTRACT, not one generator: both generators emit the same
  // `{findings: [...]}` producer shape and both need the same lenient clamping,
  // so a `glm`-prefixed name here would misdescribe it.
  const glmStrictSchema = z.object({ findings: z.array(producerFindingSchema).max(15) });
  const producerResponseJsonSchema = z.toJSONSchema(glmStrictSchema);

  // `quote` must NEVER be clamped (2026-07-18). Every other capped field is
  // prose with no downstream semantic check, so truncating its tail costs a few
  // words and SAVES the finding. `quote` is different in kind: Gate A verifies
  // it VERBATIM against the real diff section, so a truncated quote silently
  // stops matching and the finding is destroyed as `unsupported` — a "the model
  // made an evidence error" verdict caused entirely by OUR truncation.
  const unclampedQuoteSchema = stripMaxLengthFor(producerResponseJsonSchema, 'quote');

  // Lenient ingestion for the discovery generator (2026-07-15): OSS routers
  // accept our JSON Schema but don't enforce maxLength/maxItems, and GLM
  // emitted `principle` fields >150 chars — the strict safeParse inside
  // ossCall then hard-failed the WHOLE response, a required-generator
  // failure. Over-limit strings/arrays are clamped BEFORE validation;
  // genuinely semantic violations (enums, missing fields) still fail loud.
  // z.toJSONSchema on the preprocess pipe resolves to the inner schema, so
  // the provider-facing JSON Schema is unchanged.
  //
  // audit-code fix H3 (round 2): both preprocess clamps below MUST use
  // `unclampedQuoteSchema`, not `producerResponseJsonSchema` — otherwise the
  // "quote must NEVER be clamped" invariant declared just above only actually
  // held for the Sonnet path (whose own clamp already used
  // `unclampedQuoteSchema`), while the GLM path silently truncated `quote`
  // exactly like the pre-2026-07-18 bug this invariant exists to prevent.
  const glmLenientSchema = z.preprocess(
    (v) => clampToJsonSchemaLimits(v, unclampedQuoteSchema),
    glmStrictSchema,
  );

  // Batch-abort hardening (2026-07-22): validates only that `findings` is an
  // array of at most 15 items (still clamped for length first), leaving
  // per-item shape entirely to `prepareCandidates`'s existing
  // `producerSchema.safeParse` — so ONE genuinely malformed finding among up
  // to 15 no longer fails the WHOLE array (a required-generator failure that
  // used to fall the entire tiered run back to legacy).
  const glmResponseValidationSchema = z.preprocess(
    (v) => clampToJsonSchemaLimits(v, unclampedQuoteSchema),
    z.object({ findings: z.array(z.unknown()).max(15) }),
  );

  const sonnetFindingsTool = {
    name: 'report_findings',
    description: 'Report candidate code-audit findings found in the provided code.',
    input_schema: {
      type: 'object',
      properties: {
        findings: {
          type: 'array',
          maxItems: 15,
          items: z.toJSONSchema(producerFindingSchema),
        },
      },
      required: ['findings'],
    },
  };

  return {
    diffPathTable,
    anchorContract,
    producerFindingSchema,
    glmLenientSchema,
    glmResponseValidationSchema,
    unclampedQuoteSchema,
    sonnetFindingsTool,
  };
}
