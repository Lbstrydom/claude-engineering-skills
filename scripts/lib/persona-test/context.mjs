/**
 * @fileoverview Resolve a `PersonaRunContext` once at runner start; threaded
 * through every cross-skill write so candidate-spec, persona-session, and
 * correlation rows share a single identity.
 *
 * Phase 1 of docs/plans/persona-test-consistency-mode.md (resolves R2-H4).
 *
 * @module scripts/lib/persona-test/context
 */
import { execFileSync } from 'node:child_process';
import { PersonaRunContextSchema } from './schemas.mjs';

/**
 * @typedef {object} ResolveOpts
 * @property {string} repoId        - UUID of the repo in the audit store (resolved via cross-skill.mjs).
 * @property {string|null} personaId
 * @property {string} journeyKey    - Usually `canary.name`; for ad-hoc runs, a slug.
 * @property {string} [deploymentId]
 * @property {string} [planId]
 */

/**
 * @param {string} repoRoot         - Absolute path; passed for git probes.
 * @param {object} env              - process.env at runner start.
 * @param {ResolveOpts} args
 * @returns {import('./schemas.mjs').PersonaRunContext}
 */
export function resolvePersonaRunContext(repoRoot, env, args) {
  if (!args || typeof args !== 'object') {
    throw new Error('resolvePersonaRunContext: args is required');
  }
  if (!args.repoId) {
    // Refused at the boundary — candidate writes need a resolved repo id
    // (Gemini-R5-G2: NULL repo_id would silently allow duplicate candidates
    // through the partial unique index).
    throw new Error(
      'resolvePersonaRunContext: BAD_INPUT — consistency mode requires a resolved repoId. ' +
      'Call `cross-skill.mjs resolve-repo-identity` first.',
    );
  }
  if (!args.journeyKey) {
    throw new Error('resolvePersonaRunContext: BAD_INPUT — journeyKey is required');
  }

  const commitSha = safeGit(repoRoot, ['rev-parse', 'HEAD']);
  const branch    = safeGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);

  const ctx = {
    repoId: args.repoId,
    personaId: args.personaId ?? null,
    journeyKey: args.journeyKey,
    deploymentId: args.deploymentId ?? null,
    planId: args.planId ?? null,
    commitSha,
    branch,
  };

  const result = PersonaRunContextSchema.safeParse(ctx);
  if (!result.success) {
    throw new Error(
      `resolvePersonaRunContext: schema validation failed: ${result.error.message}`,
    );
  }
  return result.data;
}

function safeGit(cwd, args) {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() || null;
  } catch {
    return null;
  }
}
