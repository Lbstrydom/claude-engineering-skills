/**
 * @fileoverview The single source of truth for a plan's lifecycle status
 * vocabulary — the markdown spellings, the DB spellings, and the one function
 * that reconciles them.
 *
 * **Why this lives in shared-lib and not in `plan-status.mjs` (2026-07-20).**
 * Two domains legitimately need this vocabulary: the **plan** domain, which
 * parses a plan's `Status:` line from markdown, and the **stores** domain
 * (`plans-ship.mjs`), which validates a status before a DB write against the
 * `plans_status_check` CHECK constraint. When the vocabulary lived in
 * `scripts/lib/plan-*.mjs` (the plan domain), `plans-ship.mjs` importing it
 * created a `stores → plan` edge that is not in `allowedDeps` — a real
 * architecture violation the mechanical arch pass flags. Moving the shared
 * contract to shared-lib resolves it: both `plan → shared-lib` and
 * `stores → shared-lib` are allowed edges, and there is still exactly ONE
 * definition. Splitting the vocabulary (some in plan, some in stores) was the
 * rejected alternative — that recreates the three-definitions-one-vocabulary
 * drift migration `20260718120000` exists to kill.
 *
 * This module has no imports by design — a shared contract that depended on
 * either consumer domain would reintroduce a cycle.
 *
 * @module scripts/lib/status-vocabulary
 */

/**
 * The CLOSED status vocabulary. Anything else is `unrecognized`.
 *
 * Three kinds, because deliberately-shelved work is neither of the other two
 * (consumer report, 2026-07-20). `Parked` was previously unrepresentable, and
 * the three available spellings were all wrong: `Draft` is false (it is not
 * being drafted), `Superseded` is false (nothing replaced it), and leaving it
 * non-conforming makes the plan INVISIBLE to selection — so it can never be
 * audited, which is the precise failure this vocabulary exists to prevent.
 *
 * `parked` is deliberately NOT folded into `active` (the report's own fallback
 * suggestion): an audit must not chase parked work for progress, and `active`
 * is exactly the bucket that gets chased. It is not `terminal` either — parked
 * work can resume, and filing it as finished would lose that.
 *
 * Adding a kind is not free: `generate-plans-index.mjs` derives its bucket
 * straight from `kind`, so a kind with no rendering branch silently vanishes
 * from the index — the same invisibility, one layer along. Any new kind needs
 * a section there and a decision in `context-staleness.mjs`.
 */
export const PLAN_STATUS_VOCABULARY = Object.freeze({
  terminal: ['Complete', 'Superseded'],
  active: ['Draft', 'Approved', 'In Progress'],
  parked: ['Parked'],
});

/**
 * Normalise a status token to its STORE spelling: lowercase, spaces to
 * underscores (`In Progress` → `in_progress`). The markdown surface and the
 * `plans_status_check` CHECK constraint spell the same vocabulary two ways;
 * this is the one place that reconciles them.
 */
export function toDbPlanStatus(token) {
  return typeof token === 'string' ? token.trim().toLowerCase().replace(/\s+/g, '_') : token;
}

/**
 * The DB-side vocabulary, DERIVED from the markdown one above rather than
 * restated. The store's `plans_status_check` CHECK constraint must accept
 * exactly this set.
 *
 * `abandoned` is additionally accepted: already-persisted data that predates
 * the vocabulary and maps to no markdown token, so the CHECK keeps it (see
 * migration 20260718120000). Restating this list anywhere else would recreate
 * the three-definitions-one-vocabulary drift that migration exists to kill.
 */
export const DB_PLAN_STATUSES = Object.freeze([
  // Derived from EVERY kind, not an enumerated subset — a new kind that the
  // CHECK constraint rejects would make its plans unwritable to the store
  // while reading as valid in markdown.
  ...Object.values(PLAN_STATUS_VOCABULARY).flat().map(toDbPlanStatus),
  'abandoned',
]);
