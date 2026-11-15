/**
 * @fileoverview "Can an audit run HERE?" — answered before anything is spent.
 *
 * **The report (work consumer on the Azure profile, 2026-11-15).** A fresh
 * worktree had no auditor route: `skills:hydrate` copies the tooling, never the
 * keys. Nothing said so up front, so the flow reached the prerequisite ladder
 * mid-run and offered the `AUDIT_DEGRADED` substitute as a choice — which the
 * user had ruled must never be offered. What fixed it was the per-user
 * `~/.audit-loop.env`, which the runtime loader already reads in every checkout
 * and worktree, but which no flow named.
 *
 * Three lines, each from an oracle rather than a variable name:
 *   - `audit route:` — the ROUTE oracle (`resolveProviderAvailability('openai')`
 *     over the Azure config built from the SAME layered env the runtime sees),
 *     never `env.OPENAI_API_KEY`. MISSING is a FAIL and names `~/.audit-loop.env`.
 *   - `degraded audits:` — the repo policy flag `AUDIT_FORBID_DEGRADED=1`. When
 *     set, the prerequisite ladder stops at `AUDIT_NOT_RUN` and never offers the
 *     adversarial-agent substitute (`references/prerequisite-ladder.md` Rung 1).
 *   - `line endings:` — `probeEolHazard`, the autocrlf + no-`eol=lf` pair that
 *     breaks byte-identity tests in fresh worktrees.
 *
 * It never reads, copies or prints a `.env` value: the env object is the
 * runtime loader's own composition, and only presence/route names are reported.
 *
 * Lives here, not in `check-setup.mjs`, because that file is at its size ceiling.
 *
 * @module scripts/lib/install/audit-readiness
 */
import { buildAzureConfig } from '../config.mjs';
import { resolveProviderAvailability } from '../brainstorm/provider-availability.mjs';
import { probeEolHazard, EOL_FIX } from '../eol-hazard.mjs';

/** The repo policy flag: `1` forbids offering a degraded (substitute) audit. */
export const FORBID_DEGRADED_VAR = 'AUDIT_FORBID_DEGRADED';

/** Where a key belongs so EVERY checkout and worktree of every repo sees it. */
export const SHARED_ENV_HINT = '~/.audit-loop.env';

/** @param {Record<string,string|undefined>} env */
export function degradedAuditsForbidden(env) {
  return String(env?.[FORBID_DEGRADED_VAR] ?? '').trim() === '1';
}

/**
 * The GPT auditor route for this env. A half-configured Azure profile throws in
 * `buildAzureConfig`; that is a route that does not resolve, reported with the
 * builder's own (redacted) message rather than a stack.
 * @param {Record<string,string|undefined>} env - the runtime loader's composed env
 * @returns {{available: boolean, route: 'azure'|'public'|null, reason: string|null}}
 */
export function resolveAuditRoute(env) {
  let azure;
  try { azure = buildAzureConfig(env); } catch (err) {
    return { available: false, route: null, reason: `Azure profile half-configured: ${err?.message || err}` };
  }
  return resolveProviderAvailability('openai', { env, azure });
}

/**
 * Append the readiness section to a check-setup / doctor report.
 * @param {Record<string,string|undefined>} env
 * @param {import('../doctor/report.mjs').Report} report
 * @param {string} repoPath
 * @param {{probeEol?: typeof probeEolHazard}} [io]
 */
export function checkAuditReadiness(env, report, repoPath, io = {}) {
  report.section('Audit readiness (before any spend)');
  const route = resolveAuditRoute(env);
  if (route.available) {
    report.pass(`audit route: ${route.route}`, route.route === 'azure' ? 'GPT via the Azure work profile' : 'GPT via OPENAI_API_KEY');
  } else {
    report.fail('audit route: MISSING', route.reason || 'no GPT route resolves',
      `Put the key (or the Azure profile) in ${SHARED_ENV_HINT} — per-user, read by every checkout and worktree. `
      + 'Do not copy a .env into the worktree.');
  }
  if (degradedAuditsForbidden(env)) {
    report.info('degraded audits: forbidden', `${FORBID_DEGRADED_VAR}=1 — no route means AUDIT_NOT_RUN; the substitute is never offered`);
  } else {
    report.info('degraded audits: allowed', `set ${FORBID_DEGRADED_VAR}=1 to stop at AUDIT_NOT_RUN instead of offering the substitute`);
  }
  const eol = (io.probeEol ?? probeEolHazard)(repoPath);
  if (!eol.measured) report.info('line endings: not measured', eol.reason || '');
  else if (eol.hazard) report.warn('line endings: CRLF hazard', eol.reason, EOL_FIX);
  else report.pass('line endings: ok', 'no autocrlf rewrite of committed LF files');
  return route;
}
