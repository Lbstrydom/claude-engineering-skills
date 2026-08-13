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

/**
 * DELIBERATELY NO `line`/`startLine`/`endLine` FIELD HERE (decided 2026-07-26,
 * investigating docs/plans/tiered-recall-audit-pipeline.md "Addendum 2026-07-26
 * (continued) — the overlapCount question"). `section` is free text with no
 * required location format — confirmed the dominant real shape: a census of
 * this repo's own findings found 0/10 matching `file:LINE`, and every one of 10
 * historical `tiered_shadow_observations` rows read 100% unlocalized on the
 * LEGACY side too (this schema is what the legacy 5-pass GPT audit, Gemini
 * final review, and the model-A/B/C shadow all emit against).
 *
 * A model-self-reported line was considered and REJECTED for this shared
 * schema: unlike the tiered pipeline (which has a diff/hunk-verification
 * apparatus — `evidence-triage.mjs`'s `findQuoteLineInHunk`/
 * `resolveAnchorLocation` — and now attaches a genuinely VERIFIED `_primaryLine`
 * to tiered findings, checked against the real diff, never trusted blind), the
 * legacy 5-pass audit has no equivalent substrate to check a claimed line
 * against. Adding an unverifiable `line` field here would recreate the exact
 * problem this investigation started from — a number a consumer would have to
 * trust despite no way to tell a correct claim from a hallucinated one (proven
 * concretely: this session's own `HEAD_ANCHOR` test fixture self-reports line
 * 12 for a quote whose REAL, verified line is 11 — a real, not hypothetical,
 * one-line-off model claim that nothing would have caught before the tiered
 * fix, and that adding an unverified field HERE would not catch either).
 *
 * The legacy path therefore stays intentionally, permanently unlocalized-by-
 * design — not an oversight, a `defer` with the load-bearing reason named:
 * verified-but-narrow beats broad-but-untrustworthy for a field a production-
 * flip metric (`overlapCount`) reads. Revisit only if a verification substrate
 * for the legacy path is ever built (there is none today — it has no
 * diff/hunk-anchor apparatus at all, unlike the tiered pipeline).
 */
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
 * DuplicationBouncerResponseSchema — the duplication audit wave's (Wave 5)
 * LLM classification-stage contract. Deliberately NOT `ProducerFindingSchema`-
 * shaped: round-2 gate finding H4 established that letting the model author
 * `is_quick_fix`/`is_mechanical` directly on a full finding object means a
 * model could silently defeat convergence by omitting/misreporting the flag.
 * This schema exposes ONLY a keep/drop decision + severity + rationale per
 * candidate id — the orchestration-side mapper (`mapBouncerDecisionsToFindings`,
 * scripts/lib/audit/duplication-report.mjs) constructs the actual finding and
 * hardcodes `is_quick_fix: true` / `is_mechanical: true` as literals the model
 * cannot influence. `decisions.length` is capped in code (against the same
 * candidate count the detector itself bounds via `maxDuplicationCandidates`)
 * by the caller validating array length before/after parse, not by a Zod
 * `.max()` here — the cap is operator-configurable (env var), so baking a
 * fixed number into the schema would drift from `symbolIndexConfig` silently.
 *
 * Plan: docs/plans/audit-code-duplication-wave.md §2 / §4 Phase 3 (round-3 H2).
 */
export const DuplicationBouncerResponseSchema = z.object({
  decisions: z.array(z.object({
    candidateId: z.string().max(20),
    decision: z.enum(['keep', 'drop']),
    severity: z.enum(['MEDIUM', 'HIGH']),
    rationale: z.string().max(300),
  })),
});

/**
 * AdjacencyBouncerResponseSchema — the containment-adjacency wave's LLM
 * judgement contract. Deliberately the SAME narrow shape as
 * `DuplicationBouncerResponseSchema`, and for the same reason recorded above:
 * a model that can author `is_quick_fix`/`is_mechanical` on a full finding
 * object can silently defeat convergence by omitting or misreporting the flag.
 * This schema exposes ONLY a keep/drop decision per candidate id; the
 * orchestration-side mapper (`mapDecisionsToFindings`,
 * scripts/lib/audit/adjacency-report.mjs) constructs the finding and hardcodes
 * those flags as literals the model cannot influence.
 *
 * The bouncer's job here is narrow by design (plan §D5): the mechanical stage
 * has ALREADY enumerated the container and computed scope-dependence — the
 * model never decides what exists, only whether a mechanically-independent
 * statement is genuinely trapped or is a legitimate-but-nested one (a bare log
 * line being the named residual class). `decisions.length` is validated in code
 * against the detector's own `maxCandidates` bound rather than a Zod `.max()`,
 * because that cap is operator-configurable and baking a number in here would
 * drift from `adjacencyConfig` silently.
 *
 * Plan: docs/plans/adjacency-check-containment.md §D5.
 */
export const AdjacencyBouncerResponseSchema = z.object({
  decisions: z.array(z.object({
    candidateId: z.string().max(80),
    decision: z.enum(['keep', 'drop']),
    severity: z.enum(['MEDIUM', 'HIGH']),
    rationale: z.string().max(300),
  })),
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

// ── Evidence Contract (V2) — tiered-recall pipeline ─────────────────────────
// Plan: docs/plans/tiered-recall-audit-pipeline.md §2 + Phase 1.
// A V2 finding carries verifiable evidence: a `commission` claim cites an
// anchor block (content-verifiable quote + diff-pair identity); an `omission`
// claim cites the TRIGGER that created the unmet obligation (itself a
// commission-type fact, deterministically checkable) plus a free-text causal
// chain. Findings without these fields are V1 (legacy) and normalize to
// `evidenceStatus: 'missing'`. Defined BEFORE PersistedFindingSchema so the
// canonical `FindingSchema` alias includes these fields directly (audit H4 —
// a schema Zod consumers don't know about would silently strip them).

/**
 * EvidenceAnchorSchema — diff-pair-aware, content-verifiable anchor.
 * `oldFile`/`newFile` (not one bare `file`) because renamed/copied/deleted
 * files have different base-side and head-side paths; `side` selects which
 * one the `quote` must match. `headSha` is 'WORKTREE' for uncommitted diffs.
 * superRefine (audit M8) enforces the invariants a bare field-by-field schema
 * can't: line ordering, and that `side` is consistent with `fileStatus` — an
 * `added` file has no base-side content to cite; a `deleted` file has none
 * on the head side.
 */
export const EvidenceAnchorSchema = z.object({
  diffPathId: z.string().max(200).describe('Stable identity for this diff file-pair (from the diff-path map)'),
  oldFile: z.string().max(300).nullable().optional().describe('Base-side path — present for modified/deleted/renamed/copied'),
  newFile: z.string().max(300).nullable().optional().describe('Head-side path — present for modified/added/renamed/copied'),
  fileStatus: z.enum(['modified', 'added', 'deleted', 'renamed', 'copied']),
  side: z.enum(['base', 'head']).describe('Which side of the diff the quote cites'),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  quote: z.string().min(1).max(1000).describe('The actual cited text — content-verified by Stage 0, not line-number-only'),
  symbolName: z.string().max(200).nullable().optional(),
  headSha: z.string().max(64).describe("Commit under audit; the literal 'WORKTREE' for uncommitted diffs"),
}).superRefine((a, ctx) => {
  if (a.startLine > a.endLine) {
    ctx.addIssue({ code: 'custom', path: ['startLine'], message: 'startLine must be <= endLine' });
  }
  if (a.fileStatus === 'added' && a.side === 'base') {
    ctx.addIssue({ code: 'custom', path: ['side'], message: "an 'added' file has no base-side content to cite" });
  }
  if (a.fileStatus === 'deleted' && a.side === 'head') {
    ctx.addIssue({ code: 'custom', path: ['side'], message: "a 'deleted' file has no head-side content to cite" });
  }
  // Round-2b finding #H4 — oldFile/newFile PRESENCE by fileStatus, not just
  // side-vs-content. Line-ordering + side checks above don't stop e.g. a
  // 'renamed' anchor with BOTH paths null from validating.
  if ((a.fileStatus === 'renamed' || a.fileStatus === 'copied') && (!a.oldFile || !a.newFile)) {
    ctx.addIssue({ code: 'custom', path: ['oldFile'], message: `a '${a.fileStatus}' anchor requires both oldFile and newFile` });
  }
  if (a.fileStatus === 'added' && !a.newFile) {
    ctx.addIssue({ code: 'custom', path: ['newFile'], message: "an 'added' anchor requires newFile" });
  }
  if (a.fileStatus === 'deleted' && !a.oldFile) {
    ctx.addIssue({ code: 'custom', path: ['oldFile'], message: "a 'deleted' anchor requires oldFile" });
  }
  // Cluster B audit fix M4 (round 2): 'modified' means the path did NOT
  // change — require BOTH paths present AND equal, not merely "at least
  // one". A modified-file anchor with mismatched or missing paths is exactly
  // the "impossible side/path combination" the finding named.
  if (a.fileStatus === 'modified' && (!a.oldFile || !a.newFile || a.oldFile !== a.newFile)) {
    ctx.addIssue({ code: 'custom', path: ['oldFile'], message: "a 'modified' anchor requires both oldFile and newFile present and equal" });
  }
});

const EvidenceFieldsOptional = {
  evidenceType: z.enum(['commission', 'omission']).optional(),
  anchor: EvidenceAnchorSchema.nullable().optional().describe('commission only: the indicted code'),
  triggerAnchor: EvidenceAnchorSchema.nullable().optional().describe('omission only: the trigger that created the unmet obligation'),
  causalChain: z.string().max(800).nullable().optional().describe('omission only: changed → obligation created → what was searched → why absent'),
};

/**
 * ProducerFindingV2Schema — what NEW (tiered-pipeline) generators emit.
 * evidenceType is REQUIRED; the type-conditional evidence is enforced by
 * superRefine (commission ⇒ anchor; omission ⇒ triggerAnchor + causalChain).
 * Legacy generator call sites keep ProducerFindingSchema (V1) untouched.
 */
export const ProducerFindingV2Schema = z.object({
  ...FindingBase,
  classification: ClassificationSchema,
  ...EvidenceFieldsOptional,
  evidenceType: z.enum(['commission', 'omission']),
}).superRefine((f, ctx) => {
  if (f.evidenceType === 'commission' && !f.anchor) {
    ctx.addIssue({ code: 'custom', path: ['anchor'], message: 'commission finding requires an anchor' });
  }
  if (f.evidenceType === 'omission') {
    if (!f.triggerAnchor) ctx.addIssue({ code: 'custom', path: ['triggerAnchor'], message: 'omission finding requires a triggerAnchor' });
    if (!f.causalChain) ctx.addIssue({ code: 'custom', path: ['causalChain'], message: 'omission finding requires a causalChain' });
  }
});

// ── Producer contract V3 — provider-ENFORCEABLE by construction ──────────────
// (evidence-anchor-path-contract, 2026-07-17)
//
// V2 above is the cautionary tale, kept for its existing callers. Its path
// rules and its commission/omission rule live in `superRefine`, which
// `z.toJSONSchema()` CANNOT express — so the provider never enforced any of
// them. Measured: a real Sonnet call filled the REQUIRED `diffPathId` 4/4 and
// omitted the OPTIONAL `oldFile`/`newFile` 4/4, and Stage 0 destroyed all four
// as `fabricated`. Models behave rationally against the schema they are SHOWN.
//
// V3's rule: every constraint must live in the row the provider can enforce.
//
//   | constraint                    | JSON Schema | provider enforces |
//   |-------------------------------|-------------|-------------------|
//   | required / type / **enum**     | yes         | **yes**           |
//   | cross-field (`superRefine`)    | no          | **no** (ignored)  |
//
// So: paths and fileStatus are DERIVED from our own diff-path map (never
// asked for — Gate A re-verifies them against the real diff anyway, i.e. they
// were never trusted as model input); the id is an `enum` of this run's actual
// files; and the commission/omission conditional becomes a
// `discriminatedUnion`, which emits `oneOf` + per-branch `required`.
//
// V3 MUST stay refinement-free — `tests/provider-contract-enforceable.test.mjs`
// asserts it, and an allowlist entry would disarm that guard on its first use.

/**
 * What a generator emits for an anchor: an id, which side, where, and the
 * quote. Nothing else — a model cannot know a diff-pair's identity, and we
 * already do.
 */
export const ProducerEvidenceAnchorSchema = z.object({
  diffPathId: z.string().max(200).describe('The `id` column from the diff-path table you were given. Copy it exactly.'),
  side: z.enum(['base', 'head']).describe('Which side of the diff the quote is on'),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  quote: z.string().min(1).max(1000).describe('Text copied VERBATIM from the code you were given — never paraphrased'),
  symbolName: z.string().max(200).nullable().optional(),
});

/**
 * Build the per-run producer schema, with `diffPathId` narrowed to an `enum`
 * of THIS diff's ids. The enum is the constraint the provider can actually
 * enforce — but it is a funnel, never a trust boundary (plan D6):
 * `prepareCandidates` `safeParse`s the response regardless.
 *
 * @param {string[]} ids - from `buildDiffPathMap(...).entries` — the SOLE source (D7)
 * @returns {import('zod').ZodType} refinement-free; safe for `z.toJSONSchema`
 */
export function makeProducerFindingV3Schema(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    // `z.enum([])` is not constructible. The caller must handle
    // `{kind:'empty'}`/`{kind:'invalid'}` BEFORE reaching here (plan §7j) —
    // failing loudly beats emitting a schema that cannot match anything.
    throw new Error('makeProducerFindingV3Schema: ids must be non-empty — handle the empty/invalid map before building a schema (§7j)');
  }
  const anchor = ProducerEvidenceAnchorSchema.extend({ diffPathId: z.enum(ids) });
  const base = { ...FindingBase, classification: ClassificationSchema };
  return z.discriminatedUnion('evidenceType', [
    z.object({
      ...base,
      evidenceType: z.literal('commission'),
      anchor,
    }),
    z.object({
      ...base,
      evidenceType: z.literal('omission'),
      triggerAnchor: anchor,
      causalChain: z.string().max(800).describe('changed → obligation created → what was searched → why absent'),
    }),
  ]);
}

/**
 * Schemas handed to a provider via `z.toJSONSchema`. The registry exists so
 * `tests/provider-contract-enforceable.test.mjs` can assert refinement-freeness
 * over ALL of them, and its companion source-scan can assert that every
 * `z.toJSONSchema(` call site's argument is registered — so the list cannot
 * silently fall behind a new provider contract.
 *
 * `ProducerFindingV2Schema` is deliberately ABSENT: it carries superRefine and
 * is the exact anti-pattern the guard forbids. It stays for its existing
 * callers, and Cluster B's Phase 6 migration is what removes it from the
 * provider path.
 */
export const PROVIDER_FACING_SCHEMAS = Object.freeze({
  ProducerEvidenceAnchorSchema,
  // The per-run V3 is dynamic; its refinement-freeness is a property of the
  // factory, so the guard instantiates it with a probe id.
  makeProducerFindingV3Schema,
});

/**
 * PersistedFindingSchema — what we read from storage. Classification is OPTIONAL/nullable.
 * Old findings written before Phase B have no classification; must still validate.
 * `verification` is attached only to findings the gate classified as
 * existence-claims; absent on all others (they count toward the verdict
 * normally). Evidence fields (audit H4) are folded in DIRECTLY — not a
 * parallel "V2" schema — so the ONE canonical `FindingSchema` every existing
 * consumer already imports never silently strips V2 evidence on parse; V1
 * findings validate unchanged since every evidence field is optional.
 */
export const PersistedFindingSchema = z.object({
  ...FindingBase,
  classification: ClassificationSchema.nullable().optional(),
  verification: FindingVerificationSchema.optional(),
  ...EvidenceFieldsOptional,
});

/**
 * Backward-compatible alias — existing imports of `FindingSchema` use the permissive
 * persisted schema. Enforcement happens at producer boundaries via ProducerFindingSchema.
 */
export const FindingSchema = PersistedFindingSchema;

/**
 * Alias retained for callers written against the "V2" name (e.g. this
 * cluster's own tests) — same schema as `PersistedFindingSchema` now that
 * evidence fields live there directly (audit H4 fix collapsed what was
 * originally two parallel schemas into one).
 */
export const PersistedFindingV2Schema = PersistedFindingSchema;

/**
 * The single normalizer every downstream stage consumes (plan Phase 1 —
 * round-1 finding #10). Pure + tolerant: malformed V2 (e.g. commission with
 * no anchor, or an anchor failing EvidenceAnchorSchema's own invariants)
 * degrades to 'missing' (V1 treatment) rather than throwing — enforcement of
 * well-formedness happens at producer boundaries via ProducerFindingV2Schema,
 * never at read time. Audit H5 fix: an anchor/triggerAnchor is validated via
 * `EvidenceAnchorSchema.safeParse`, not merely truthy-checked — a malformed
 * object (bad line ordering, wrong side for its fileStatus) must NOT read as
 * valid evidence.
 *
 * @param {object} finding - raw finding (V1 or V2, producer- or persisted-shape)
 * @returns {{evidenceStatus: 'missing'|'commission'|'omission', anchor: object|null, triggerAnchor: object|null, causalChain: string|null}}
 */
export function normalizeFindingEvidence(finding) {
  const none = { evidenceStatus: 'missing', anchor: null, triggerAnchor: null, causalChain: null };
  if (!finding || typeof finding !== 'object') return none;
  if (finding.evidenceType === 'commission' && EvidenceAnchorSchema.safeParse(finding.anchor).success) {
    return { evidenceStatus: 'commission', anchor: finding.anchor, triggerAnchor: null, causalChain: null };
  }
  if (finding.evidenceType === 'omission' && EvidenceAnchorSchema.safeParse(finding.triggerAnchor).success && finding.causalChain) {
    return { evidenceStatus: 'omission', anchor: null, triggerAnchor: finding.triggerAnchor, causalChain: finding.causalChain };
  }
  return none;
}

// ── Audit Stage Decisions (tiered-recall pipeline) ──────────────────────────
// Plan: docs/plans/tiered-recall-audit-pipeline.md Phase 3 (round-2 finding
// #4). A typed, append-only decision log — replaces the original draft's
// untyped `stageDecisions: {}` on AuditCandidateEnvelope. Every field that
// was previously implied by prose (whether a dismissal has deterministic
// disproof, whether it's ledger-eligible) is now a real, validated field.

export const Stage0DecisionSchema = z.object({
  stage: z.literal('stage0'),
  outcome: z.enum(['verified', 'rejected', 'unverifiable']),
  reasonCode: z.string().max(200),
  evidenceRef: z.string().max(300),
  createdAt: z.string(),
});

export const Stage1DecisionSchema = z.object({
  stage: z.literal('stage1'),
  // `budget_exhausted` added (docs/plans/oss-call-reliability-hardening.md,
  // round-2 H2): mirrors Stage2DecisionSchema's `pending_adjudication`
  // precedent below — a work item the admission guard never started because
  // the reserved Stage-1 wall-clock budget ran out, distinct from
  // `stage1_call_failed` (a real provider/triager failure). Never written to
  // the mechanical-dismissal ledger, so it naturally resurfaces if the
  // underlying finding is rediscovered — same non-loss guarantee
  // `pending_adjudication` already has.
  outcome: z.enum(['mechanical_dismissed', 'escalated', 'confirmed_survivor', 'budget_exhausted']),
  reasonCode: z.string().max(200),
  hasDeterministicDisproof: z.boolean(),
  createdAt: z.string(),
  // Present (never `null`) only when outcome is `escalated` with reasonCode
  // `stage1_call_failed` AND the underlying error was classifyLlmError-
  // classified; absent/null for every other outcome.
  category: z.string().nullable().optional(),
});

export const Stage2DecisionSchema = z.object({
  stage: z.literal('stage2'),
  // `pending_adjudication` added 2026-07-10 (tiered-recall pipeline Phase 11,
  // audit-plan fix H1 round 3): the typed terminal state for a work item
  // Phase 9's FinalAdjudicationBudget skips on per-call timeout / total-budget
  // exhaustion — distinct from the four Gemini-produced verdicts above (no
  // Gemini call happened at all). Retried next round via the existing R2+
  // mechanism, never silently dropped or treated as `confirmed_dismissal`.
  // `pending_security_review` added 2026-07-10 (Phase 12, audit-plan fix H2
  // round 4): the typed terminal state for a candidate whose evidence is
  // sensitive — the mandatory sensitive-egress gate refuses to build a
  // transcript or spawn the reviewer subprocess at all, so this is NEVER a
  // real Gemini verdict. Distinct from `pending_adjudication` (a transient
  // budget-exhaustion skip that's simply retried) — this is a standing
  // classification that needs a HUMAN decision, not a re-attempt. A
  // sensitive-evidence item must NEVER be represented as `confirmed_dismissal`/
  // `verified`/reviewed-and-clean (AGENTS.md "audit your success paths").
  outcome: z.enum(['reversed', 'confirmed_dismissal', 'verified', 'missed_candidate', 'pending_adjudication', 'pending_security_review']),
  reasonCode: z.string().max(200),
  createdAt: z.string(),
});

/** Discriminated union on `stage` — Zod picks the right branch by that field. */
export const AuditStageDecisionV1 = z.discriminatedUnion('stage', [
  Stage0DecisionSchema,
  Stage1DecisionSchema,
  Stage2DecisionSchema,
]);

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
 * Object-schema keys whose *values* are maps of arbitrary user-defined names
 * (Zod field names, $ref targets) rather than JSON Schema keywords. A field
 * literally named "pattern" or "default" must survive filtering when it
 * appears as a key of one of these maps — only actual JSON Schema keyword
 * positions (siblings of "type", etc.) should be stripped.
 */
const JSON_SCHEMA_NAME_MAP_KEYS = new Set(['properties', '$defs', 'definitions']);

/**
 * Strip Gemini-unsupported JSON Schema keys recursively.
 * Shape-aware: does not strip keys inside a name-map (`properties`, `$defs`,
 * `definitions`) since those keys are field/schema names, not JSON Schema
 * keywords — a Zod field named "pattern" or "default" must not be dropped.
 * @param {*} obj - JSON Schema node
 * @returns {*} Cleaned node
 */
function stripJsonSchemaExtras(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(stripJsonSchemaExtras);
  const cleaned = {};
  for (const [k, v] of Object.entries(obj)) {
    if (JSON_SCHEMA_NAME_MAP_KEYS.has(k) && typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const nameMap = {};
      for (const [name, subSchema] of Object.entries(v)) {
        nameMap[name] = stripJsonSchemaExtras(subSchema);
      }
      cleaned[k] = nameMap;
      continue;
    }
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

/**
 * Clamp a parsed LLM reply to a JSON Schema's cosmetic size limits BEFORE
 * strict Zod validation — truncates strings exceeding `maxLength` and slices
 * arrays exceeding `maxItems`, guided by the schema tree. Everything else
 * (enums, types, required fields, semantic invariants) is deliberately left
 * for the real validator to reject.
 *
 * Why this exists (2026-07-15): OpenRouter/OSS providers accept our derived
 * JSON Schema via `response_format: json_schema` but do NOT enforce
 * `maxLength`/`maxItems` — GLM emitted `principle` fields >150 chars, the
 * strict `safeParse` in oss-structured-output.mjs hard-failed the entire
 * discovery response, and the tiered pipeline's required-generator failure
 * fell the whole round back to legacy. For a DISCOVERY generator whose
 * candidates are re-verified by Stage 0/1/2 anyway, an over-long field is
 * cosmetic — truncating is honest; discarding the round is not.
 *
 * Use via `z.preprocess`, which keeps `z.toJSONSchema` working on the
 * wrapped schema (a preprocess pipe converts as its output schema):
 *
 *   const lenient = z.preprocess(
 *     (v) => clampToJsonSchemaLimits(v, z.toJSONSchema(strictSchema)),
 *     strictSchema,
 *   );
 *
 * @param {*} value - parsed (post-JSON.parse) reply value
 * @param {object} jsonSchema - the matching JSON Schema node (z.toJSONSchema output)
 * @returns {*} value with over-limit strings/arrays clamped
 */
export function clampToJsonSchemaLimits(value, jsonSchema) {
  if (jsonSchema == null || typeof jsonSchema !== 'object' || value == null) return value;
  // anyOf/oneOf traversal (experiment-4 gate-1 screen, 2026-07-17): a
  // NULLABLE nested schema (e.g. `EvidenceAnchorSchema.nullable()` on every
  // finding's anchor) is emitted by z.toJSONSchema as
  // `{anyOf: [<real schema>, {type:'null'}]}` — and this walker previously
  // handled only {properties}/{items}/strings, so EVERY limit inside an
  // anchor (quote maxLength:1000 above all) was silently unreachable and
  // never clamped. Measured live: DeepSeek's oversized quotes hard-failed
  // whole responses that this function existed to save. Recurse into the
  // first branch whose shape matches the value's type; no match → untouched
  // (the strict schema still fails loud, exactly as before).
  const branches = jsonSchema.anyOf ?? jsonSchema.oneOf;
  if (Array.isArray(branches)) {
    const branch = branches.find((b) => b && typeof b === 'object' && (
      (typeof value === 'string' && (b.type === 'string' || b.maxLength != null))
      || (Array.isArray(value) && (b.type === 'array' || b.items != null))
      || (typeof value === 'object' && !Array.isArray(value) && (b.type === 'object' || b.properties != null))
    ));
    return branch ? clampToJsonSchemaLimits(value, branch) : value;
  }
  if (typeof value === 'string') {
    // Never truncate enum values — a clipped enum is corruption, not cosmetics.
    if (!jsonSchema.enum && Number.isInteger(jsonSchema.maxLength) && value.length > jsonSchema.maxLength) {
      return value.slice(0, jsonSchema.maxLength);
    }
    return value;
  }
  if (Array.isArray(value)) {
    const capped = Number.isInteger(jsonSchema.maxItems) && value.length > jsonSchema.maxItems
      ? value.slice(0, jsonSchema.maxItems)
      : value;
    return jsonSchema.items ? capped.map((v) => clampToJsonSchemaLimits(v, jsonSchema.items)) : capped;
  }
  if (typeof value === 'object' && jsonSchema.properties) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = Object.hasOwn(jsonSchema.properties, k)
        ? clampToJsonSchemaLimits(v, jsonSchema.properties[k])
        : v;
    }
    return out;
  }
  return value;
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
// ── Audit Run Context / Result (tiered-recall pipeline Phase 11) ───────────
// Plan: docs/plans/tiered-recall-audit-pipeline.md Phase 11 (audit-plan fix
// M1). The shared contract BOTH `runLegacyProductionAudit` and
// `runTieredAuditPipeline` take as input / must satisfy as output, so
// `openai-audit.mjs`'s chooser can treat either branch uniformly.

/**
 * `ctx` carries live, non-serialisable handles (an OpenAI SDK client, a
 * PromptBandit instance, ...) alongside plain data — `z.any()`/`z.unknown()`
 * marks the opaque fields deliberately (this schema documents the shape and
 * is safe to `.safeParse()` defensively, but is not a strict "reject unknown
 * runtime objects" gate the way a pure-data schema would be).
 */
export const AuditRunContextSchema = z.object({
  planContent: z.string(),
  projectContext: z.string().optional(),
  historyContext: z.string().optional(),
  passFilter: z.array(z.string()).nullable().optional(),
  fileFilter: z.array(z.string()).nullable().optional(),
  round: z.number().int().optional(),
  ledgerFile: z.string().nullable().optional(),
  diffFile: z.string().nullable().optional(),
  changedFiles: z.array(z.string()).optional(),
  repoProfile: z.unknown().nullable().optional(),
  bandit: z.unknown().nullable().optional(),
  fpTracker: z.unknown().nullable().optional(),
  noLedger: z.boolean().optional(),
  noTools: z.boolean().optional(),
  strictLint: z.boolean().optional(),
  noDebtLedger: z.boolean().optional(),
  readOnlyDebt: z.boolean().optional(),
  debtLedgerPath: z.string().optional(),
  debtEventsPath: z.string().optional(),
  escalateRecurring: z.number().nullable().optional(),
  scopeMode: z.string().nullable().optional(),
  planFile: z.string().nullable().optional(),
  runId: z.string().nullable().optional(),
  allowInfraScope: z.boolean().optional(),
  // `generatorOutcomes` — initialised to `[]` by `buildAuditRunContext`;
  // `discovery-portfolio.mjs::runDiscoveryPortfolio` mutates it in place so
  // both orchestrators share one place generator/pass outcomes are recorded.
  generatorOutcomes: z.array(z.object({
    model: z.string(),
    role: z.enum(['required', 'optional', 'exploratory']),
    status: z.enum(['succeeded', 'failed', 'skipped']),
  })).optional(),
  // Call-site eligibility for tiered-pipeline / shadow EXECUTION (2026-07-13,
  // shadow-flip incident fix). The env flags (AUDIT_TIERED_PIPELINE_ENABLED /
  // AUDIT_TIERED_SHADOW_ENABLED) express OPERATOR intent ("the window is
  // open") and are global — including to `npm test`, which loads the same
  // shared ~/.audit-loop.env. Whether a specific INVOCATION may execute the
  // tiered pipeline or its shadow (real multi-provider spend beyond the
  // caller-injected openai client) is a per-call property only the
  // production CLI entrypoint asserts. Default false: programmatic callers
  // (test harnesses with stubbed clients, model-eval generation arms) never
  // construct real provider clients or fire the shadow, regardless of env.
  allowTiered: z.boolean().optional(),
  // The provider handles, constructed ONCE by `buildAuditRunContext` via
  // the existing guarded factories, threaded through unchanged — no stage
  // module constructs a provider SDK client itself.
  providers: z.object({
    openai: z.unknown().nullable().optional(),
    anthropicClient: z.unknown().nullable().optional(),
    ossCall: z.unknown().nullable().optional(),
    geminiReviewCall: z.unknown().nullable().optional(),
    // Stage 2's clean-region sampler takes a FILE, not an envelope — a
    // different signature from geminiReviewCall, so it is its own handle
    // (2026-07-13 shadow-wiring fix: the prior design threaded ONE function
    // into both of runFinalAdjudication's adapters, whose signatures differ
    // — reviewCall(envelope) vs cleanRegionCall(file) — so a single handle
    // could never have served both correctly).
    geminiCleanRegionCall: z.unknown().nullable().optional(),
  }).optional(),
  // Deviations from the plan's literal field-enumeration, needed by actual
  // shipped code (audit-plan fix pattern — verified via direct inspection,
  // not assumed from plan prose): `outFile` is read internally by the
  // legacy loop for artifact-path resolution (pass-result recovery cache
  // dir + R2+ prior-round-outcome finalisation), distinct from "write the
  // FINAL result to disk" which stays a CLI-wrapper concern. `model` is the
  // resolved GPT model id (mirrors `./llm-helpers.mjs`'s `MODEL`, threaded
  // through ctx so orchestration-layer code doesn't reach for the mutable
  // module-level binding directly). `sessionCacheHit` is genuinely read by
  // the legacy loop's cloud-telemetry `recordRunComplete` call.
  outFile: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  sessionCacheHit: z.unknown().nullable().optional(),
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
 * Map a `classifyLlmError()` category onto the ReduceStatus it represents.
 *
 * Lives beside the enum on purpose: "which of these six values can a real
 * failure actually produce" is a question about the enum, and keeping the map
 * here makes it answerable — and testable — in one place. Until 2026-08-13 it
 * was answerable only by reading the caller, and the answer was "two":
 * `runMapReducePass` inferred `failed ? MODEL_ERROR : OK` from a boolean,
 * because `safeCallGPT` discarded the classification and returned only
 * `err.message`. `parse_error`, `timeout` and `budget_exceeded` were declared
 * and unreachable — the plan (audit-loop-improvements.md:68) asked for status
 * "from the actual error classification", and only the READ side had landed.
 *
 * Categories are those `classifyLlmError` can yield: the `LlmError` categories
 * constructed in `lib/audit/llm-helpers.mjs` (`incomplete`, `truncated`,
 * `empty`, `schema`, `config`, `sensitive`) plus its own fallbacks
 * (`http-<status>`, `timeout`, `network`, `permanent`).
 *
 * `incomplete` deliberately does NOT map to `budget_exceeded`. The Responses
 * API reports `status:'incomplete'` for several reasons — `max_output_tokens`
 * but also `content_filter` — so claiming "budget" would be a precision the
 * category does not carry. `truncated` is unambiguous (an output item cut at
 * max_tokens) and does map. Unknown categories fall through to `model_error`
 * rather than a new value, so widening the classifier can never silently mint
 * a status this enum has not declared.
 *
 * @param {string|undefined} category A `classifyLlmError()` category.
 * @returns {string} A ReduceStatus value.
 */
export function reduceStatusFromErrorCategory(category) {
  switch (category) {
    // Model replied, but nothing usable could be parsed out of it.
    case 'schema':
    case 'empty':
      return ReduceStatus.PARSE_ERROR;
    case 'timeout':
      return ReduceStatus.TIMEOUT;
    // Output cut at max_tokens — the token budget genuinely ran out.
    case 'truncated':
      return ReduceStatus.BUDGET_EXCEEDED;
    default:
      return ReduceStatus.MODEL_ERROR;
  }
}

/**
 * Optional execution-meta block added to audit result objects.
 *
 * Typed SSOT — all execution status flags live here, not as ad-hoc top-level
 * booleans. ENFORCED as of 2026-08-13 by `buildExecutionMeta()` below, the only
 * supported way to construct the block; both producers in
 * `lib/audit/legacy-production-audit.mjs` go through it. Before that the SSOT
 * claim was decoration: this schema was imported by two files and APPLIED by
 * neither, so every field below was a comment with Zod syntax.
 *
 * STRICT on purpose. A plain `z.object` SILENTLY STRIPS an unknown key
 * (`z.object({a}).parse({aa:true})` → `{}`), so wiring the permissive version in
 * would still have passed a typo'd field name and then dropped it — the exact
 * defect the schema existed to catch. Strictness is what makes a misspelling
 * loud rather than invisible.
 *
 * Why loud matters here: `audit-loop.mjs` reads `suppressionUnavailable` and
 * `ledgerInvalidEntryCount` to decide whether a round may count toward
 * convergence. A mistyped key does not merely blur telemetry — it lets a round
 * that suppressed against a truncated ruling set be counted as clean, defeating
 * the guard `ledgerInvalidEntryCount` was added to provide.
 */
const ExecutionMetaFieldsSchema = z.strictObject({
  reduceStatus: z.enum(REDUCE_STATUS_VALUES).optional(),
  reduceSkipped: z.boolean().optional(),
  suppressionUnavailable: z.boolean().optional(),
  // Entries `validateLedgerForR2` dropped as malformed. `suppressionUnavailable`
  // says suppression could not run AT ALL; this says it ran against a TRUNCATED
  // ruling set — a degraded round that would otherwise be indistinguishable
  // downstream from a clean one. Emitted only when > 0: absent means a complete
  // ledger, and a hard 0 would be a measurement nobody took.
  ledgerInvalidEntryCount: z.number().int().nonnegative().optional(),
  // Per-pass REDUCE degradation, propagated onto the RUN result — `{passName:
  // status}`, and only for passes that degraded (a clean REDUCE emits no block
  // at all, so an entry here always means something went wrong and an absent
  // field means no map-reduce pass degraded).
  //
  // A map, not a single `reduceStatus`, because a run has N passes and any
  // collapse of N statuses into one loses which pass degraded — the only part
  // an operator can act on. Added 2026-08-13: `reduceStatus` was emitted on the
  // PASS result and never propagated (`mergedResult` builds its own block from
  // suppression state alone), so it reached a human only as prose inside
  // `overall_reasoning`. Nothing else carries this: `mapReduceFailureReason`
  // flags only `total_failure` and partial-with-zero-findings, so a pass whose
  // REDUCE parse-errored while its raw MAP findings survived reports
  // `succeeded` with no failureReason.
  reducePassStatuses: z.record(z.string(), z.enum(REDUCE_STATUS_VALUES)).optional(),
  // DECLARED, NOT YET EMITTED (verified 2026-08-13 by repo-wide grep: no
  // producer writes either field, no consumer reads one). They belong to P0-D
  // of docs/plans/audit-loop-improvements.md — pass prediction/skipping — which
  // has not shipped. Kept rather than deleted so that design intent survives
  // the strictness change; when that phase lands its producer must route
  // through `buildExecutionMeta()` like the others.
  passesSkipped: z.array(z.string()).optional(),
  predictionUsed: z.boolean().optional(),
});

/**
 * The `_executionMeta` block as it appears ON a result object: the strict shape
 * above, or absent entirely. Exported for consumers that want to assert a
 * result's block conforms (see tests/run-multi-pass-code-audit-harness.test.mjs).
 */
export const ExecutionMetaSchema = ExecutionMetaFieldsSchema.optional();

/**
 * Build a validated `_executionMeta` block — the single construction point.
 *
 * Keys whose value is `undefined` are dropped, and an all-empty block returns
 * `undefined` rather than `{}`. That preserves the omit-vs-zero convention the
 * producers already relied on: absence means "nothing degraded", whereas a hard
 * `0`/`false` would read as a measurement someone actually took.
 *
 * Throws on an unknown key or a wrong type. Throwing is deliberate — every
 * input is derived inside the pipeline, so a violation can only arise from a
 * code edit, and the alternative (warn and continue) would emit exactly the
 * silently-wrong telemetry this contract exists to prevent.
 *
 * @param {Record<string, unknown>} [fields] Candidate execution-meta fields.
 * @returns {object|undefined} The validated block, or `undefined` if empty.
 */
export function buildExecutionMeta(fields = {}) {
  const present = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(present).length === 0) return undefined;
  const parsed = ExecutionMetaFieldsSchema.safeParse(present);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map(issue => {
      const where = issue.path.length > 0 ? issue.path.join('.') : (issue.keys?.join(', ') ?? '(root)');
      return `${where}: ${issue.message}`;
    })
    .join('; ');
  throw new Error(
    `_executionMeta violates its typed contract (ExecutionMetaSchema, scripts/lib/schemas.mjs) — ${detail}. `
    + 'Add the field to ExecutionMetaSchema if it is genuinely new; do not bypass buildExecutionMeta().',
  );
}

/**
 * Shared output contract. Fields always present on both orchestrators are
 * NOT `.optional()`; the historically-conditional fields (`_failed_passes`,
 * `_executionMeta`, `_suppression`, ...) stay `.optional()`.
 */
export const AuditRunResultSchema = z.object({
  verdict: z.enum(['PASS', 'NEEDS_FIXES', 'SIGNIFICANT_ISSUES', 'INCOMPLETE']),
  files_planned: z.number().int(),
  files_found: z.number().int(),
  files_missing: z.number().int(),
  code_files: z.array(z.string()),
  findings: z.array(z.any()),
  wiring_issues: z.array(WiringIssueSchema),
  quick_fix_warnings: z.array(z.string()),
  dead_code: z.array(z.string()),
  overall_reasoning: z.string(),
  _pass_timings: z.record(z.string(), z.any()),
  _usage: z.record(z.string(), z.any()),
  _cacheMetrics: z.record(z.string(), z.any()),
  _toolCapability: z.record(z.string(), z.any()),
  _sid: z.string(),
  generatorOutcomes: z.array(z.object({
    model: z.string(),
    role: z.enum(['required', 'optional', 'exploratory']),
    status: z.enum(['succeeded', 'failed', 'skipped']),
  })),
  // ADJUDICATED 2026-07-17 (evidence-anchor-path-contract §7j vs
  // shadow-no-legacy-fallback's "why NOT a new runStatus enum value"): the two
  // §7j values ARE in the enum, and this does not overturn the prior note — it
  // applies the note's own tests to different facts. That note rejected
  // `tiered_unavailable` because (a) no consumer needed the distinction,
  // (b) existing persisted rows would need migrating, (c) an honest channel
  // (shadowOk:false + typed error) already existed. Here: (a) §7j's design
  // REQUIRES distinguishing `skipped_no_eligible_files` (legitimate no-op,
  // quiet) from `failed_invalid_diff_input` (OUR bug, loud); (b) these are new
  // states, not renamed ones — zero rows migrate; (c) they arise inside the
  // pipeline itself (production statuses once Phase 14 flips) — no alternative
  // channel exists. Decisively: the pipeline ALREADY emits them — a declared
  // contract that rejects values the system produces is the exact
  // schema-vs-reality divergence this plan exists to kill. Guarded by the
  // emissions⊆enum scan in tests/tiered-pipeline-wiring.test.mjs.
  runStatus: z.enum(['complete', 'incomplete', 'fallback_legacy', 'skipped_no_eligible_files', 'failed_invalid_diff_input']),
  fallbackReason: z.string().optional(),
  // Durable audit-store write outcomes (docs/plans/audit-store-write-durability.md
  // decision 3). Optional because only the legacy orchestrator populates it
  // today; ABSENT is meaningfully different from all-zero — absent says nobody
  // measured, zero says nothing was lost, and collapsing the two would recreate
  // the believable-false-zero this field exists to expose.
  //
  // `lost > 0` is what makes `runStatus` 'incomplete'. Declared here because the
  // enum note above holds for the whole object: a contract that omits values the
  // system emits is the schema-vs-reality divergence these tests exist to kill.
  writeOutcomes: z.object({
    written: z.number(),
    spilled: z.number(),
    lost: z.number(),
    // `skipped` = the store declined (cloud off). Counted, but NOT a failure —
    // only `lost` makes a run incomplete.
    skipped: z.number(),
    byWriter: z.record(z.string(), z.record(z.string(), z.any())),
  }).optional(),
  // Conditional / historically-optional fields:
  _failed_passes: z.array(z.string()).optional(),
  // Was `z.record(z.string(), z.any()).optional()` — "any key of any type",
  // which declared the opposite of what ExecutionMetaSchema claimed two hundred
  // lines below it. Surveyed 2026-08-13 before tightening: the only keys any
  // producer emits are `reduceStatus`/`reduceSkipped` (the reduce-failure pass
  // block) and `suppressionUnavailable`/`ledgerInvalidEntryCount` (the merged
  // run block), and all four are declared, so the permissive record was not
  // load-bearing for anything. The execution-meta section was moved ABOVE this
  // schema in the same change purely so this reference resolves — a `const`
  // declared below would be in the temporal dead zone when this object literal
  // is evaluated at module load.
  _executionMeta: ExecutionMetaSchema,
  _suppression: z.record(z.string(), z.any()).optional(),
  _debtMemory: z.record(z.string(), z.any()).optional(),
  _ledgerRejectedCount: z.number().optional(),
  _ledgerWriteError: z.string().optional(),
  _linterOverlap: z.record(z.string(), z.any()).optional(),
  _cloudRunId: z.string().optional(),
  _modelAbShadow: z.record(z.string(), z.any()).optional(),
  // Added 2026-07-10 (audit-plan fix H1, round 3) — how the Stage 2
  // budget-exhaustion path (Phase 9's FinalAdjudicationBudget) surfaces on
  // the run result the next round's R2+ mechanism reads.
  _stage2BudgetExhausted: z.object({ count: z.number(), itemIds: z.array(z.string()) }).optional(),
  // Added (docs/plans/oss-call-reliability-hardening.md, round-3 H1/H2) —
  // the Stage-1 sibling of `_stage2BudgetExhausted` above, same shape: how
  // the Stage-1 admission guard's skipped candidates surface on the run
  // result (and, via compareAuditRunResults, the persisted shadow log).
  _stage1BudgetExhausted: z.object({ count: z.number(), itemIds: z.array(z.string()) }).optional(),
  // Aggregate tally of classified Stage-1 failure categories this round
  // (e.g. {timeout: 2, network: 1}) — the persisted answer to "classification
  // remains lost for the live sequential Stage-1 production route".
  _stage1FailureCategories: z.record(z.string(), z.number()).optional(),
  pendingAdjudicationItems: z.array(z.string()).optional(),
  // Added 2026-07-10 (Phase 12) — item IDs routed to the NEW
  // `pendingSecurityReview` accumulator (final-adjudication.mjs), distinct
  // from `pendingAdjudicationItems` above. Mirrors that field's shape.
  pendingSecurityReviewItems: z.array(z.string()).optional(),
});

// ── Stage 1 Triager DTO (audit-orchestrator-hardening Phase 8) ─────────────
// Minimized, egress-safe shape `adapters.triagerCall` receives — never the
// full mutable `AuditCandidateEnvelope` (which nests the whole
// canonicalFinding, evidenceAlternatives, stageDecisions). Schema ONLY —
// the builder (`buildStageOneTriageInput`) deliberately lives in
// `scripts/lib/audit/stage1-triage.mjs`, not here: this module is a pure
// Zod-definitions file with no other module's side-effecting logic
// imported into it anywhere in this codebase (confirmed via grep), and the
// builder needs `resolveAndClassify`/`redactSecrets`/`normalizeFindingEvidence`
// — importing those here would risk a circular import (`sensitive-paths.mjs`/
// `redact.mjs` are lower-level utility modules `schemas.mjs` has no existing
// dependency on).
export const StageOneTriageInputSchema = z.object({
  category: z.string().max(80),
  detail: z.string().max(600),
  section: z.string().max(120),
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  evidenceStatus: z.enum(['missing', 'commission', 'omission']),
  anchorQuote: z.string().max(1000).nullable(),
  causalChain: z.string().max(800).nullable(),
  redacted: z.boolean(),
});

// ── Ledger Core Fields (shared by session + debt ledgers — Phase D) ─────────

/**
 * Fields shared by both the session ledger (R2+ deliberation) and the debt ledger
 * (Phase D persistent memory). Extracted for DRY; each ledger composes its own
 * schema from this base plus its own specific fields.
 */
const LedgerCoreFields = {
  topicId: z.string(),
  // The finding's own id, kept as the SECOND join key: `enrichFindings`
  // (outcome-sync.mjs) matches `entry.latestFindingId === finding.id` when the
  // topicId join misses. It was documented as a join key while the schema
  // silently stripped it — a `z.object` drops unknown keys — so every entry
  // written "with latestFindingId" persisted without one and the fallback join
  // could never fire. Optional: entries predating this carry no id.
  latestFindingId: z.string().optional(),
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

/**
 * Stage 1's deterministic dismissals (tiered-recall audit pipeline Phase 8) —
 * a `source` tag distinct from `session`/`debt` so they (a) flow through
 * `suppressReRaises`'s fuzzy/reopen-on-touch path like session entries, and
 * (b) are excluded from the hard-suppress-at-3 `overruleCountIndex`, since a
 * mechanical dismissal reason (e.g. "the cited function doesn't exist") can
 * become false later (the function gets added) in a way a human/GPT judgment
 * overrule never does. Deliberately NOT a session-deliberation entry — no
 * `ruling`/`rulingRationale` fields, since no GPT/human deliberation
 * happened; `disproof` is the deterministic evidence Stage 1 cited instead.
 */
export const Stage1MechanicalLedgerEntrySchema = z.object({
  ...LedgerCoreFields,
  source: z.literal('stage1-mechanical'),
  adjudicationOutcome: z.literal('dismissed'),
  remediationState: z.enum(['pending', 'planned', 'fixed', 'verified', 'regressed']),
  disproof: z.string().min(1),
  resolvedRound: z.number(),
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

// ── Repo Stack Detection (Phase A) ──────────────────────────────────────────

/**
 * Canonical output shape for `cross-skill.mjs detect-stack`.
 * Shared by plan, ship — see scripts/lib/repo-stack.mjs.
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

// ── persona-clickpath → nav reachability seeding (plan: docs/plans/persona-clickpath-nav-seeding.md) ──

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
