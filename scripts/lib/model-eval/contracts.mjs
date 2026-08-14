/**
 * @fileoverview Shared model-eval vocabulary — the single source of truth
 * for the role/tier/status/judge-tier enums every model-eval module uses
 * (round-5 M4 fix: the role enum was independently declared in five
 * modules; a rename in one would silently desync the others). Mode-specific
 * threshold SHAPES deliberately stay in their owning modules — the runtime
 * verdict-input schema (verdict.mjs) and the role-specific config schema
 * (config/schema.mjs) are genuinely different contracts.
 *
 * Plan: docs/plans/model-swap-eval-harness.md — File-Level Plan Phase 1.
 *
 * @module scripts/lib/model-eval/contracts
 */

import { z } from 'zod';
import { assertEligibleSubset } from '../comparison/roles.mjs';

// The vocabulary moved to `comparison/roles.mjs` (2026-08-14) so the campaign
// and swap-eval mechanisms stop carrying disjoint role enums that cannot see
// each other. What stays HERE is this mechanism's ELIGIBILITY — the roles the
// synchronous swap-eval harness accepts — which is deliberately a SUBSET and
// deliberately not `ROLES` itself: `final_review_shadow` is the passive
// campaign's role, and accepting it here would claim a role this harness does
// not run. `assertEligibleSubset` fails loudly on an invented or duplicated
// role name, so the subset cannot silently drift from the vocabulary.
export const SWAP_ELIGIBLE_ROLES = Object.freeze(
  assertEligibleSubset(['auditor', 'adjudicator'], 'SWAP_ELIGIBLE_ROLES'),
);
/** @deprecated Use SWAP_ELIGIBLE_ROLES (this mechanism's subset) or comparison/roles.mjs ROLES (the vocabulary). */
export const ROLES = SWAP_ELIGIBLE_ROLES;
export const RoleSchema = z.enum(SWAP_ELIGIBLE_ROLES);

export const TIERS = Object.freeze(['screen', 'promotion']);
export const TierSchema = z.enum(TIERS);

export const JUDGE_TIERS = Object.freeze(['A', 'B', 'C']);
export const JudgeTierSchema = z.enum(JUDGE_TIERS);

// Process-state statuses (see store/model-eval.mjs — `running`/`pending_shadow`
// are the two non-terminal states for checkpointed runs).
export const RUN_STATUSES = Object.freeze(['completed', 'failed_preflight', 'failed_egress', 'failed_provider', 'running', 'pending_shadow']);
export const RunStatusSchema = z.enum(RUN_STATUSES);
export const TERMINAL_RUN_STATUSES = Object.freeze(['completed', 'failed_preflight', 'failed_egress', 'failed_provider']);
export const TerminalRunStatusSchema = z.enum(TERMINAL_RUN_STATUSES);
export const NON_TERMINAL_RUN_STATUSES = Object.freeze(['running', 'pending_shadow']);
export const NonTerminalRunStatusSchema = z.enum(NON_TERMINAL_RUN_STATUSES);

export const PROVIDERS = Object.freeze(['openai', 'oss', 'azure', 'anthropic', 'google']);
export const ProviderSchema = z.enum(PROVIDERS);

// Bounded percentage for promotion-switch thresholds (round-5 M2 fix): an
// "improves by N%" threshold is only meaningful as a positive percentage;
// 1000% is a generous sanity ceiling, not a semantic bound.
export const SwitchPercentSchema = z.number().positive().max(1000);

// Round-7 audit M3 fix — verdict.mjs::DECISION_TABLE is the sole authority
// for which (verdict, nextAction) pairs are reachable; a persistence layer
// that accepted unrestricted strings could store a value the state machine
// can never produce. These enums are the vocabulary, not the pair-legality
// rule — DECISION_TABLE (verdict.mjs) stays the single place that encodes
// which pairs are valid together.
export const VERDICTS = Object.freeze(['keep', 'switch', 'inconclusive', 'manual_review_required']);
export const VerdictSchema = z.enum(VERDICTS);
export const NEXT_ACTIONS = Object.freeze(['promote_to_full', 'none', 'reject', 'eligible_for_shadow']);
export const NextActionSchema = z.enum(NEXT_ACTIONS);

// Round-7 audit M8 fix — the set of threshold keys that constitute an
// enforceable FLOOR (as opposed to a switch/cost-gate key like
// switchIfCostImprovesByPct, or the allowUnpricedPromotion flag) must be
// declared exactly ONCE and consumed by both verdict.mjs's runtime check
// (fail at first computeVerdict call) and config/schema.mjs's config-time
// refine (fail at CLI startup, before any run spends money) — duplicating
// this specific list independently in both places is exactly the drift
// risk round-7's M4/M6 flagged; the surrounding threshold-key SCHEMAS
// legitimately stay separate (role-scoped config vs role-agnostic runtime,
// round-5 M4), but this one enumerable fact must not.
export const ORACLE_FLOOR_KEYS = Object.freeze(['minRecall', 'maxFalsePositiveRate', 'minF1']);
export const COMPARATIVE_FLOOR_KEYS = Object.freeze(['minRecallRatioVsBaseline', 'maxFalsePositiveRatioVsBaseline', 'minF1VsBaseline', 'maxFalseAcceptDeltaAbs']);

// Round-2 (Cluster B) audit M7 fix — relocated here from route-catalog.mjs.
// audit-arms.mjs (Phase 3) needs CandidateSpecSchema to validate a
// `resolved-route` arm's embedded spec, but its own header comment declares
// it PURE ("no env side effects beyond reading the env object passed to
// resolveArms, no LLM/network/FS") — importing it from route-catalog.mjs
// would transitively pull in that module's `azureConfig` import
// (config.mjs reads process.env at module-evaluation time), a real,
// if narrow, purity violation audit-shadow.mjs's live shadow experiment
// relies on. contracts.mjs imports ONLY zod — genuinely side-effect-free —
// so both route-catalog.mjs and audit-arms.mjs import CandidateSpecSchema
// from here instead of one depending on the other's heavier module.
export const CandidateSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sentinel'), value: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('oss-role'), role: z.enum(['coder', 'reasoner']) }).strict(),
  z.object({ kind: z.literal('azure-deployment'), profile: z.string().min(1) }).strict(),
]);
