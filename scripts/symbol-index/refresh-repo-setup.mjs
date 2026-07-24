/**
 * @fileoverview Repo identity resolution + registration for `refresh.mjs`.
 *
 * Extracted from `refresh.mjs` (docs/plans/tiered-pipeline-refresh-god-module-decomposition.md).
 *
 * @module scripts/symbol-index/refresh-repo-setup
 */

import { resolveRepoIdentity, persistRepoIdentity } from '../lib/repo-identity.mjs';
import { upsertRepoByUuid } from '../learning-store.mjs';
import { RepoRegistrationError } from './refresh-errors.mjs';

/**
 * Pure guard: throws `RepoRegistrationError` when `repo` is falsy (the
 * `upsertRepoByUuid` result was null), otherwise returns it unchanged. No
 * I/O, no imports beyond the error class — deterministically unit-testable
 * with a bare `null` input, no store mock required.
 *
 * @param {object|null} repo
 * @returns {object}
 */
export function assertRegisteredRepo(repo) {
  if (!repo) throw new RepoRegistrationError('upsertRepoByUuid returned null — aborting');
  return repo;
}

/**
 * Resolve this repo's identity, persist it, and register it in the learning
 * store. Returns only `{ repoId }` — `identity`/`repo` are never read again
 * anywhere in `main()` after this call's own side effects, so returning them
 * would be exporting dead state as public sibling-module API.
 *
 * Throws `RepoRegistrationError` (via `assertRegisteredRepo`) instead of
 * calling `process.exit()` directly — a library module terminating the
 * process is exactly the case AGENTS.md's Accepted Technical Debt table
 * names as the revisit trigger for `process.exit()` helpers. `refresh.mjs`'s
 * `main()` catches this and performs the exact same `logErr(...);
 * process.exit(1)` it always has — the orchestrator, not the helper, owns
 * process termination.
 *
 * @param {string} repoRoot
 * @returns {Promise<{repoId: string}>}
 */
export async function resolveAndRegisterRepo(repoRoot) {
  const identity = resolveRepoIdentity(repoRoot);
  persistRepoIdentity(identity.repoUuid, repoRoot);
  const repo = assertRegisteredRepo(
    await upsertRepoByUuid({ repoUuid: identity.repoUuid, name: identity.name }),
  );
  return { repoId: repo.id };
}
