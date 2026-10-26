/**
 * @fileoverview Event contracts for the own-model decision ledger
 * (docs/plans/own-model-decision-ledger.md decisions 2, 4, 5, 7).
 *
 * TWO contracts, deliberately:
 *   - INGRESS  — what a producer sends. Content fields present and bounded.
 *   - PERSISTED — what is stored and spooled. Content fields are optional and are
 *     valid ABSENT when `content_state = 'structural'`, so an event legitimately
 *     stripped at capture still validates when a later flush replays it.
 *
 * `structural` payloads are an ALLOWLIST (`.strict()`): a field is persisted for a
 * repo that forbids content only if it is validated structure — an id, enum, count,
 * hash, or a `ref` matching a closed grammar. Anything narrative is not on the list.
 *
 * @module scripts/lib/ledger/schemas
 */
import { z } from 'zod';

export const LEDGER_SCHEMA_VERSION = 1;
export const REDACTION_VERSION = 1;

export const KINDS = Object.freeze(['task', 'decision', 'correction', 'outcome', 'usage']);
export const COORDINATORS = Object.freeze(['CES', 'WCA', 'STO', 'AIO', 'other']);
export const ACTORS = Object.freeze(['coordinator', 'louis', 'chip', 'system']);
export const CONTENT_STATES = Object.freeze(['full', 'structural']);
export const OUTCOME_KINDS = Object.freeze(['merged', 'reverted', 'reworked', 'abandoned', 'ci-red', 'incident', 'converged', 'cap-hit', 'observed-clean']);
export const CORRECTION_CLASSES = Object.freeze(['safety', 'scope', 'style', 'new-info']);
export const CORRECTION_SOURCES = Object.freeze(['chat', 'approval', 'button']);
export const TASK_KINDS = Object.freeze(['chip', 'audit', 'sync', 'merge', 'plan']);
/** `audit` is NOT a usage source: audit cost comes only from audit_runs (plan decision 12). */
export const USAGE_SOURCES = Object.freeze(['chip', 'coordinator', 'other']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The closed grammar for a structural reference (no spaces, no free text). */
export const REF_GRAMMAR = /^(pr:\d{1,7}|sha:[0-9a-f]{40,64}|run:[0-9a-f-]{36}|path:[A-Za-z0-9._/@-]{1,200})$/;
export const OPTION_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const uuid = z.string().regex(UUID);
const workItem = z.string().regex(UUIDV7);
const ref = z.string().regex(REF_GRAMMAR);
const sha = z.string().regex(/^[0-9a-f]{40,64}$/);
const optionId = z.string().regex(OPTION_ID);
const text = (n) => z.string().min(1).max(n);

// ── structural fields per kind (the persistence allowlist) ───────────────────
const taskStruct = { task_kind: z.enum(TASK_KINDS), brief_ref: ref.optional() };
const decisionStruct = {
  options: z.array(z.object({ id: optionId }).strict()).min(1).max(12),
  chosen_option_id: optionId,
  override_of: uuid.optional(),
  snapshot: z.boolean().optional(),
};
const correctionStruct = { class: z.enum(CORRECTION_CLASSES), source: z.enum(CORRECTION_SOURCES) };
const outcomeStruct = {
  kind: z.enum(OUTCOME_KINDS), ref, merge_sha: sha.optional(),
  observation_window_days: z.number().int().min(0).max(365).optional(),
};
const usageStruct = {
  // Closed grammars, not free text: structural fields skip redaction, so a string here must not be able to carry narrative or a secret.
  source: z.enum(USAGE_SOURCES), provider: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/), model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,79}$/),
  input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0),
  cost_usd: z.number().min(0), latency_ms: z.number().int().min(0).optional(),
};

/** Narrative fields by kind: these exist ONLY in a `full` event (or as option label/summary). */
export const CONTENT_FIELDS = Object.freeze({
  task: ['brief_text'],
  decision: ['rationale', 'state_summary', 'options[].label', 'options[].summary'],
  correction: ['proposal_text', 'revision_text'],
  outcome: [],
  usage: [],
});

const taskContent = { brief_text: text(4000).optional() };
const decisionContent = { rationale: text(2000).optional(), state_summary: text(4000).optional() };

const optionIngress = z.object({ id: optionId, label: text(200), summary: text(1000).optional() }).strict();
const optionFull = z.object({ id: optionId, label: text(200).optional(), summary: text(1000).optional() }).strict();

/** INGRESS payloads (what a producer sends). Decision options carry label/summary. */
export const IngressPayload = Object.freeze({
  // brief_ref is free text at ingress (any short label); it is persisted as structure only when it matches the ref grammar.
  task: z.object({ task_kind: z.enum(TASK_KINDS), brief_ref: text(200).optional(), ...taskContent }).strict(),
  decision: z.object({ ...decisionStruct, ...decisionContent, options: z.array(optionIngress).min(1).max(12) }).strict()
    .refine((p) => p.options.some((o) => o.id === p.chosen_option_id), { message: 'chosen_option_id must be one of options[].id' }),
  correction: z.object({ ...correctionStruct, proposal_text: text(4000), revision_text: text(4000) }).strict(),
  outcome: z.object(outcomeStruct).strict(),
  usage: z.object(usageStruct).strict(),
});

/** PERSISTED payloads. `structural` = the strict allowlist; `full` = allowlist + optional content. */
export const PersistedPayload = Object.freeze({
  structural: Object.freeze({
    task: z.object(taskStruct).strict(),
    decision: z.object(decisionStruct).strict(),
    correction: z.object(correctionStruct).strict(),
    outcome: z.object(outcomeStruct).strict(),
    usage: z.object(usageStruct).strict(),
  }),
  full: Object.freeze({
    task: z.object({ task_kind: z.enum(TASK_KINDS), brief_ref: text(200).optional(), ...taskContent }).strict(),
    decision: z.object({ ...decisionStruct, ...decisionContent, options: z.array(optionFull).min(1).max(12) }).strict(),
    correction: z.object({ ...correctionStruct, proposal_text: text(4000).optional(), revision_text: text(4000).optional() }).strict(),
    outcome: z.object(outcomeStruct).strict(),
    usage: z.object(usageStruct).strict(),
  }),
});

const envelope = {
  kind: z.enum(KINDS),
  work_item_id: workItem.nullable().optional(),
  decision_id: uuid.nullable().optional(),
  parent_decision_id: uuid.nullable().optional(),
  parent_event_id: uuid.nullable().optional(),
  coordinator: z.enum(COORDINATORS),
  actor: z.enum(ACTORS),
  event_at: z.string().datetime({ offset: true }),
  tool_sha: z.string().max(64).nullable().optional(),
  policy_version: z.string().max(64).nullable().optional(),
};

/** INGRESS envelope: `session_id` is raw here and hashed by prepare. */
export const IngressEnvelope = z.object({
  ...envelope,
  event_id: uuid.optional(),
  repo: z.string().max(200).nullable().optional(),
  session_id: z.string().max(200).nullable().optional(),
  payload: z.unknown(),
}).strict();

/** PERSISTED envelope: the columns of own_model_ledger a producer fills. */
export const PersistedEnvelope = z.object({
  ...envelope,
  event_id: uuid,
  repo_id: uuid.nullable().optional(),
  repo_name: z.string().max(200).nullable().optional(),
  purge_generation: z.number().int().min(0),
  schema_version: z.number().int(),
  redaction_version: z.number().int(),
  session_ref: z.string().regex(/^[0-9a-f]{16}$/).nullable().optional(),
  content_state: z.enum(CONTENT_STATES),
  training_eligible: z.boolean(),
  eligibility_basis: z.string().max(80).nullable().optional(),
  payload: z.unknown(),
}).strict();

/**
 * Validate an ingress event.
 * @param {unknown} raw
 * @returns {{ok: true, event: object} | {ok: false, error: string}}
 */
export function parseIngress(raw) {
  const env = IngressEnvelope.safeParse(raw);
  if (!env.success) return { ok: false, error: `envelope: ${env.error.issues[0]?.path.join('.')} ${env.error.issues[0]?.message}` };
  const payload = IngressPayload[env.data.kind].safeParse(env.data.payload);
  if (!payload.success) return { ok: false, error: `payload(${env.data.kind}): ${payload.error.issues[0]?.path.join('.')} ${payload.error.issues[0]?.message}` };
  return { ok: true, event: { ...env.data, payload: payload.data } };
}

/**
 * Validate a PERSISTED event against ITS content_state's contract, so a stripped
 * event validates on replay. Also enforces the cross-field rule the DB CHECK holds.
 * @param {unknown} raw
 * @returns {{ok: true, event: object} | {ok: false, error: string}}
 */
export function parsePersisted(raw) {
  const env = PersistedEnvelope.safeParse(raw);
  if (!env.success) return { ok: false, error: `envelope: ${env.error.issues[0]?.path.join('.')} ${env.error.issues[0]?.message}` };
  const e = env.data;
  const payload = PersistedPayload[e.content_state][e.kind].safeParse(e.payload);
  if (!payload.success) return { ok: false, error: `payload(${e.kind}/${e.content_state}): ${payload.error.issues[0]?.path.join('.')} ${payload.error.issues[0]?.message}` };
  if (e.content_state === 'structural' && e.training_eligible) return { ok: false, error: 'a structural event can never be training_eligible' };
  return { ok: true, event: { ...e, payload: payload.data } };
}
