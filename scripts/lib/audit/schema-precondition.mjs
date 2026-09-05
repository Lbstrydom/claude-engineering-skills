/**
 * @fileoverview Pre-spend refusal: does the audit store actually have the migrations
 * this checkout ships?
 *
 * **The defect this closes (measured 2026-09-05, this repo).** A store one migration
 * behind the working tree rejects the `audit_runs` INSERT — `assertSchemaRealized`
 * throws `ERR_SCHEMA_BEHIND` on the write path — so `recordRunStart` returns null and
 * NOTHING downstream can record the run: no gate-evidence marker, no convergence
 * verdict, and the commit that follows reads `AI-Gate: not-run`, the value that
 * otherwise means *nobody audited this*. Two multi-round audits converged at `PASS`,
 * exited 0, and lost their provenance exactly that way, announcing it only as
 * `[durable-write] … 2 lost`.
 *
 * **Why refuse rather than warn, and why HERE rather than at the end.** The ordering
 * made the loss near-unavoidable: `ship-commit` already blocks until the migration is
 * applied, but by the time it says so the audit has run against the un-migrated store
 * and burned its evidence — which cannot be reconstructed after the fact, because a
 * marker cannot be back-dated and hand-writing one is forgery the store cross-check
 * exists to catch. So the natural sequence (audit → ship → "oh, migrate" → ship)
 * *guaranteed* the downgrade. Asking the same question before the first LLM call
 * inverts the trap instead of documenting it, and it is the same
 * verify-the-precondition-before-spend rule the arm-eval harness applies to credentials.
 *
 * **The measurement is not ours.** `checkMigrationRealization` is `ship-commit`'s own
 * oracle, extracted so ship time and audit time cannot drift into two definitions of
 * "realized" — and it is fail-OPEN by construction: cloud off, no ledger, unreachable
 * database and every other uncertainty return `behind:false`. Only a definite filename
 * set difference refuses. A gate that fires on an unmeasurable condition gets bypassed,
 * and then it protects nothing.
 *
 * @module scripts/lib/audit/schema-precondition
 */

import { checkMigrationRealization } from '../db/schema-realization.mjs';

/** Set to `1` to audit anyway, accepting local-only findings and a `not-run` trailer. */
export const SCHEMA_BEHIND_OVERRIDE_ENV = 'AUDIT_ALLOW_SCHEMA_BEHIND';

/**
 * One sentence naming BOTH sides of the comparison.
 *
 * The remediation applies DDL, so it is only safe to follow if the reader can see which
 * directory was compared against which database — an operator with two of each reads an
 * unqualified "the database" as whichever one they had in mind.
 *
 * @param {{missing: string[], dir: string, db: string|null}} realization
 * @returns {string}
 */
export function describeSchemaBehind({ missing, dir, db }) {
  const shown = missing.slice(0, 3).join(', ')
    + (missing.length > 3 ? `, +${missing.length - 3} more` : '');
  return `${db ? `database ${db}` : 'the database'} is behind this revision: ${missing.length} `
    + `migration(s) bundled in ${dir} are absent from public.audit_loop_migrations (${shown}).`;
}

/**
 * Pure decision: proceed, refuse, or proceed-under-protest.
 *
 * Split out from the CLI so the refusal is testable without spawning a process — the
 * branch that matters most is the one that must NOT fire, and every fail-open reason
 * reaches it as `behind:false`.
 *
 * `message` is a complete, newline-terminated block or `''`; the caller owns the exit
 * code, because only it knows what exiting means in its own contract.
 *
 * @param {{realization: {behind: boolean, missing?: string[], dir?: string, db?: string|null, command?: string, reason?: string}, override: boolean}} input
 * @returns {{proceed: boolean, reason: string, message: string}}
 */
export function decideSchemaPrecondition({ realization, override }) {
  if (!realization?.behind) {
    return { proceed: true, reason: realization?.reason ?? 'realized', message: '' };
  }
  const what = describeSchemaBehind(realization);
  if (override) {
    return {
      proceed: true,
      reason: 'override',
      message: `  [schema] WARNING: ${what}\n`
        + `  [schema] ${SCHEMA_BEHIND_OVERRIDE_ENV}=1 — continuing. This run cannot be registered, so its\n`
        + '           findings are local-only and a commit from this tree will read `AI-Gate: not-run`.\n',
    };
  }
  return {
    proceed: false,
    reason: 'schema-behind',
    message: `Error: ${what}\n`
      + 'This audit would run to completion, print a verdict, and lose its provenance: the run row\n'
      + 'cannot be registered, so no gate-evidence marker is written and a commit from this tree\n'
      + 'reads `AI-Gate: not-run` however clean the audit was. Refusing before spending, not after.\n'
      + `Run: ${realization.command}      then re-run this audit.\n`
      + `Override (audit anyway, accepting local-only results): ${SCHEMA_BEHIND_OVERRIDE_ENV}=1\n`,
  };
}

/**
 * Ask the store, then decide. Never throws: an unmeasurable answer is `proceed`.
 *
 * @param {{cwd?: string, env?: Record<string, string|undefined>, check?: typeof checkMigrationRealization}} [opts]
 * @returns {Promise<{proceed: boolean, reason: string, message: string}>}
 */
export async function assertStoreSchemaRealized({
  cwd = process.cwd(), env = process.env, check = checkMigrationRealization,
} = {}) {
  const realization = await check(cwd);
  return decideSchemaPrecondition({
    realization,
    override: env[SCHEMA_BEHIND_OVERRIDE_ENV] === '1',
  });
}
