/**
 * @fileoverview Repo-dependent shaping of a ledger event
 * (docs/plans/own-model-decision-ledger.md decisions 6, 7). PURE.
 *
 * The decision input is `{flag}` where flag is `true | false | null | 'unknown'`:
 *   - `true`    content kept, event may be trainable;
 *   - `null`    (undecided) content kept, stored `training_eligible = false`;
 *   - `false`   STRUCTURE only (coordinator rule: no storyline content);
 *   - `'unknown'` the lookup could not run or failed — it is NEVER read as `null`,
 *     so it also yields STRUCTURE only.
 *
 * Structure is an allowlist (schemas.mjs `PersistedPayload.structural`), not a
 * denylist of narrative fields.
 *
 * @module scripts/lib/ledger/repo-shape
 */
import { REF_GRAMMAR } from './schemas.mjs';

/** @typedef {true|false|null|'unknown'} RepoFlag */

/** Does this flag allow narrative content to be stored? */
export const contentAllowed = (flag) => flag === true || flag === null;

/** Why the event has the eligibility it has (a short closed label). */
export function eligibilityBasis(flag) {
  if (flag === true) return 'repo-flag-true';
  if (flag === null) return 'repo-flag-undecided';
  if (flag === false) return 'repo-flag-false';
  return 'eligibility-unknown';
}

/**
 * The structural projection of a kind's payload.
 * @param {string} kind
 * @param {object} p ingress payload
 */
export function structuralPayload(kind, p) {
  switch (kind) {
    case 'task':
      return { task_kind: p.task_kind, ...(typeof p.brief_ref === 'string' && REF_GRAMMAR.test(p.brief_ref) ? { brief_ref: p.brief_ref } : {}) };
    case 'decision':
      return {
        options: p.options.map((o) => ({ id: o.id })),
        chosen_option_id: p.chosen_option_id,
        ...(p.override_of ? { override_of: p.override_of } : {}),
        ...(p.snapshot !== undefined ? { snapshot: p.snapshot } : {}),
      };
    case 'correction':
      return { class: p.class, source: p.source };
    default:
      return { ...p };
  }
}

/**
 * Shape an INGRESS payload for the repo flag.
 * @param {string} kind
 * @param {object} payload ingress payload
 * @param {RepoFlag} flag
 * @returns {{content_state: 'full'|'structural', payload: object, training_eligible: boolean, eligibility_basis: string}}
 */
export function shapeForRepo(kind, payload, flag) {
  const full = contentAllowed(flag);
  return {
    content_state: full ? 'full' : 'structural',
    payload: full ? { ...payload } : structuralPayload(kind, payload),
    // Trainable only on an explicit `true`, and only when the content is actually there.
    training_eligible: flag === true && full,
    eligibility_basis: eligibilityBasis(flag),
  };
}
