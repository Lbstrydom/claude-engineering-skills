/**
 * @fileoverview Audit-loop persistence store — thin barrel over the
 * domain modules under `scripts/lib/store/`.
 *
 * **This file used to be a 2832-line god module talking directly to
 * `@supabase/supabase-js`.** Postgres-parity M3 split it into 9 focused
 * domain modules and rewrote every PostgREST call as raw SQL through the
 * `db/` seam — see plan: docs/plans/postgres-parity.md §2 "Domain-module
 * split" + §7 P3.
 *
 * What you can rely on:
 *   - **The 93 frozen public-contract functions** (per the contract
 *     matrix `docs/plans/postgres-parity-contract-matrix.md`) are still
 *     exported here with **identical signatures + return shapes**. The
 *     18 caller files don't notice the switch.
 *   - Plus 9 new named exports added for the 5 ex-raw-client callers
 *     (plan §7 P3): `readDecisionsPaginated`, `readUnresolvedDecisions`,
 *     `getRefreshRun`, `findStaleRunningRefresh`, `listPrunableRefreshRuns`,
 *     `deleteRefreshRuns`, `demoteRefreshRuns`, `listRollbacksForRepo`,
 *     `getRefreshWalkAnchor`.
 *   - Graceful-degradation contract (#16) preserved — every function
 *     returns `null` / `[]` / equivalent neutral value when cloud mode
 *     is off.
 *
 * What's NO LONGER exported (intentionally removed per plan §2
 * "Public API surface" / R3/M2):
 *   - `getReadClient` / `getWriteClient` / `getPersonaSupabase` —
 *     these were abstraction breaches. The pool is now an implementation
 *     detail of `scripts/lib/db/client.mjs`. Callers that previously
 *     reached for raw clients now use the per-need named exports above.
 *   - The legacy `_supabase` module-global, `_userId`,
 *     `_personaSupabase`, `_personaInitAttempted` state machinery — all
 *     consumed by the new pg-backed seam.
 *
 * @module scripts/learning-store
 */

// dotenv load preserved — CLI scripts that import this still expect .env
// to have been loaded by the time they start using config.
import dotenv from 'dotenv';
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env', quiet: true });

// Re-export every public function from the 9 domain modules. The
// `export *` form is mechanical + makes a single source-of-truth file
// search ("where is fn X defined?") land in the domain module, not here.
//
// Order is intentionally alphabetical-by-domain so future additions
// land in the right place by analogy.

export * from './lib/store/arch-memory.mjs';
export * from './lib/store/bandit-fp.mjs';
export * from './lib/store/debt.mjs';
export * from './lib/store/friction.mjs';
export * from './lib/store/learning-decisions.mjs';
export * from './lib/store/persona.mjs';
// Phase 3 WS-PIPE1 — persona-test candidate aggregation table.
// Kept as a separate domain from persona.mjs because the lifecycle
// (UPSERT with occurrences++) and consumer (promote-canary-candidates)
// are different from persona_test_sessions.
export * from './lib/store/persona-test-candidates.mjs';
export * from './lib/store/plans-ship.mjs';
export * from './lib/store/repo.mjs';
export * from './lib/store/runs-findings.mjs';
export * from './lib/store/security.mjs';
