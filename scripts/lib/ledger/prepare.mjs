/**
 * @fileoverview THE preparation pipeline for every ledger event
 * (docs/plans/own-model-decision-ledger.md decision 4). Every producer — verbs,
 * fleet hooks, handover — calls this BEFORE any persistence or spool write, so
 * privacy shaping can never be skipped by a path that "just spools".
 *
 * PURE given its context: no I/O, no clock, no store. The impure parts
 * (resolving the repo, reading the eligibility flag, the purge generation) are
 * gathered by the caller into `ctx`.
 *
 *   1. ingress validation (strict, bounded)
 *   2. repo shaping by flag (content vs structure-only)
 *   3. secret redaction of every narrative string; a post-redaction scan hit REFUSES
 *   4. stamping (event id, schema/redaction versions, purge generation, session hash)
 *   5. persisted-contract validation of the result
 *
 * @module scripts/lib/ledger/prepare
 */
import crypto from 'node:crypto';
import { redactSecrets, scanForSecrets } from '../secret-patterns.mjs';
import {
  parseIngress, parsePersisted, LEDGER_SCHEMA_VERSION, REDACTION_VERSION,
} from './schemas.mjs';
import { shapeForRepo } from './repo-shape.mjs';
import { mintEventId } from './work-item.mjs';

/** The narrative string fields of a `full` payload, as accessors over a payload copy. */
function narrativeSlots(p) {
  const slots = [];
  for (const k of ['brief_text', 'brief_ref', 'rationale', 'state_summary', 'proposal_text', 'revision_text']) {
    if (typeof p[k] === 'string') slots.push([p, k]);
  }
  if (Array.isArray(p.options)) {
    for (const o of p.options) for (const k of ['label', 'summary']) if (typeof o[k] === 'string') slots.push([o, k]);
  }
  return slots;
}

/**
 * Redact every narrative string in place on a COPY; refuse if a secret survives.
 * @returns {{ok: true, payload: object, redactions: number} | {ok: false, reason: string}}
 */
export function redactPayload(payload) {
  const copy = structuredClone(payload);
  let redactions = 0;
  for (const [obj, key] of narrativeSlots(copy)) {
    const r = redactSecrets(obj[key]);
    redactions += r.redacted.length;
    obj[key] = r.text;
    if (scanForSecrets(obj[key]).matched) return { ok: false, reason: `secret-survived-redaction:${key}` };
  }
  return { ok: true, payload: copy, redactions };
}

/** A 16-hex handle of a raw session id; the raw id never leaves the producer. */
export const sessionHandle = (id) => (typeof id === 'string' && id ? crypto.createHash('sha256').update(id).digest('hex').slice(0, 16) : null);

/**
 * @typedef {object} PrepareContext
 * @property {{id: string|null, name: string|null}} repo        canonical repo (resolved by the caller)
 * @property {true|false|null|'unknown'} flag                   eligibility; 'unknown' = lookup failed
 * @property {number} purgeGeneration                           last generation seen from the store (0 if never)
 * @property {number} [nowMs]
 * @property {string|null} [toolSha]
 * @property {string|null} [policyVersion]
 */

/**
 * @param {unknown} raw ingress event
 * @param {PrepareContext} ctx
 * @returns {{ok: true, event: object, redactions: number} | {ok: false, state: 'refused', reason: string}}
 */
export function prepareLedgerEvent(raw, ctx) {
  const ing = parseIngress(raw);
  if (!ing.ok) return { ok: false, state: 'refused', reason: `ingress:${ing.error}` };
  const e = ing.event;
  const shaped = shapeForRepo(e.kind, e.payload, ctx.flag);
  const red = shaped.content_state === 'full' ? redactPayload(shaped.payload) : { ok: true, payload: shaped.payload, redactions: 0 };
  if (!red.ok) return { ok: false, state: 'refused', reason: red.reason };

  const eventId = e.event_id ?? mintEventId(ctx.nowMs);
  const persisted = {
    kind: e.kind,
    event_id: eventId,
    work_item_id: e.work_item_id ?? null,
    // A decision's own stable id (plan decision 2): the handle a later correction or outcome points at. A producer that did not
    // set one gets its event id, so no decision is ever unreferenceable.
    decision_id: e.decision_id ?? (e.kind === 'decision' ? eventId : null),
    parent_decision_id: e.parent_decision_id ?? null,
    parent_event_id: e.parent_event_id ?? null,
    repo_id: ctx.repo?.id ?? null,
    repo_name: ctx.repo?.name ?? null,
    coordinator: e.coordinator,
    actor: e.actor,
    event_at: e.event_at,
    purge_generation: ctx.purgeGeneration ?? 0,
    schema_version: LEDGER_SCHEMA_VERSION,
    redaction_version: REDACTION_VERSION,
    tool_sha: e.tool_sha ?? ctx.toolSha ?? null,
    policy_version: e.policy_version ?? ctx.policyVersion ?? null,
    session_ref: sessionHandle(e.session_id),
    content_state: shaped.content_state,
    training_eligible: shaped.training_eligible,
    eligibility_basis: shaped.eligibility_basis,
    payload: red.payload,
  };
  const v = parsePersisted(persisted);
  if (!v.ok) return { ok: false, state: 'refused', reason: `persisted:${v.error}` };
  return { ok: true, event: v.event, redactions: red.redactions };
}
