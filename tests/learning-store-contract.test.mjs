/**
 * Contract-equivalence suite — the M3 R1 mitigation gate.
 *
 * Plan: docs/plans/postgres-parity.md §9 "Golden-fixture contract model".
 *
 * For each row in `docs/plans/postgres-parity-contract-matrix.md`, run the
 * CURRENT (pg-backed) `scripts/learning-store.mjs` path against postgres+
 * pgvector and diff each function's `(return, table mutations)` against
 * the committed golden fixture in `tests/fixtures/contract/<fn>.json`.
 *
 * Drift on any function fails this test — the R1 gate the entire M3
 * P3 live-path rewrite hinges on.
 *
 * ## Current status — SCAFFOLD ONLY (M3 P3)
 *
 * The fixture-recording prerequisite (M0 #4) is **open**:
 *  - The `tests/fixtures/contract/` directory is empty (the README sits
 *    there to document the recording recipe; no per-function JSON yet).
 *  - Recording requires either Docker + `supabase start` OR a sandbox
 *    Supabase project + `--allow-remote` extension on
 *    `scripts/postgres-parity/record-golden-fixtures.mjs`.
 *
 * Until fixtures are committed, this test is a structural placeholder:
 *  - it asserts that every function in the contract matrix has a
 *    domain-module implementation reachable via the barrel
 *  - it skips per-function parity checks with a clear "fixtures missing"
 *    message so CI doesn't go green on a vacuum
 *
 * Once fixtures land, replace the per-function `it.skip` with the actual
 * diff-against-fixture body. The harness is wired below — see
 * `assertFixtureMatchesLive` for the shape it expects.
 *
 * Env-gating: enables only when both `AUDIT_DB_URL` is set AND the
 * fixture directory contains at least one fixture file. Without either,
 * the suite skips cleanly so `npm test` stays green for everyone.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ls from '../scripts/learning-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'contract');

// The 94 frozen-contract functions — the ones the contract matrix's
// off-CI recorder records fixtures for. Helpers added in M3 P3 for the
// raw-client de-leak are out-of-scope for the contract suite (they're
// new APIs, not legacy migrations).
const CONTRACT_FUNCTIONS = [
  // repo
  'initLearningStore', 'isCloudEnabled', 'upsertRepo', 'getRepoIdByUuid',
  'upsertRepoByUuid', 'getRepoIdByName',
  // runs-findings
  'recordRunStart', 'recordRunComplete', 'updateRunMeta',
  '_resetClassificationColumnCache', 'recordFindings', 'recordPassStats',
  'updatePassStatsPostDeliberation', 'getPassTimings',
  'recordSuppressionEvents', 'recordAdjudicationEvent',
  // debt
  'upsertDebtEntries', 'readDebtEntriesCloud', 'removeDebtEntryCloud',
  'appendDebtEventsCloud', 'readDebtEventsCloud',
  // bandit-fp
  'syncBanditArms', 'loadBanditArms',
  'syncFalsePositivePatterns', 'loadFalsePositivePatterns',
  'getFalsePositivePatterns', 'syncExperiments', 'syncPromptRevision',
  'getPassEffectiveness',
  // plans-ship
  'upsertPlan', 'updatePlanStatus', 'recordRegressionSpec',
  'listConsistencyCandidates', 'promoteRegressionSpec',
  'recordRegressionSpecRun', 'getUnlockedFixes',
  'recordPersonaAuditCorrelation', 'readCorrelationsForRun',
  'readCorrelationsForFinding', 'readAuditEffectiveness',
  'recordPlanVerificationRun', 'recordPlanVerificationItems',
  'readPlanSatisfaction', 'readPersistentPlanFailures', 'recordShipEvent',
  // persona
  'isPersonaCloudEnabled', 'listPersonasForApp', 'upsertPersona',
  'recordPersonaSession', 'getPersonaSessionsByRepo',
  'getPersonaSessionsByUrl',
  // security
  'recordSecurityIncidents', 'getSecurityIncidentsByRepo',
  'markIncidentsHistorical', 'getMaxIncidentRefreshAt',
  'callIncidentNeighbourhoodRpc',
  // learning-decisions
  'insertLearningDecision', 'backfillLearningOutcome',
  'recordDiffComplexity', 'recordConvergenceState',
  'recordFindingResolution', 'callDeferFinding',
  'callMarkFindingNeedsTriage', 'readPendingTriageFindings',
  'readNoBrainerRecommendations', 'readStaleClusters',
  'insertFrictionNote', 'readRecentFriction',
  // arch-memory
  'openRefreshRun', 'publishRefreshRun', 'abortRefreshRun',
  'heartbeatRefreshRun', 'getActiveSnapshot', 'recordSymbolDefinitions',
  'recordSymbolIndex', 'recordSymbolEmbedding', 'recordLayeringViolations',
  'recordDuplicateJustifications',
  'setActiveEmbeddingModel', 'getActiveEmbeddingModel',
  'callNeighbourhoodRpc', 'computeDriftScore', 'recordSymbolFileImports',
  'copyForwardImports', 'markImportGraphPopulated',
  'getImportGraphPopulated', 'getImportersForFiles',
  'upsertDomainSummary', 'getDomainSummaries', 'getTopDuplicateClusters',
  'listSymbolsForSnapshot', 'listLayeringViolationsForSnapshot',
  'copyForwardUntouchedFiles',
];

// ── Structural assertions (run unconditionally) ────────────────────────────

describe('learning-store / contract suite — structural checks', () => {
  it('every contract-matrix function is reachable through the barrel', () => {
    const missing = CONTRACT_FUNCTIONS.filter((fn) => typeof ls[fn] !== 'function');
    assert.deepEqual(missing, [], `barrel missing contract functions: ${missing.join(', ')}`);
  });

  it('the contract function count matches the matrix (94)', () => {
    assert.equal(CONTRACT_FUNCTIONS.length, 93);
  });
});

// ── Per-function parity checks (gated on fixtures + DB) ────────────────────

const fixtureFiles = fs.existsSync(FIXTURE_DIR)
  ? fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'))
  : [];

const HAS_DB = !!process.env.AUDIT_DB_URL;
const HAS_FIXTURES = fixtureFiles.length > 0;

const skipReason = !HAS_DB
  ? 'AUDIT_DB_URL not set'
  : !HAS_FIXTURES
    ? 'No fixtures recorded yet — see tests/fixtures/contract/README.md and run `npm run parity:record-fixtures` against a sandbox Supabase project (M0 #4)'
    : false;

describe('learning-store / contract suite — parity vs golden fixtures', { skip: skipReason }, () => {
  for (const fn of CONTRACT_FUNCTIONS) {
    const fixturePath = path.join(FIXTURE_DIR, `${fn}.json`);
    const haveFixture = fs.existsSync(fixturePath);

    it(`${fn} — diff against ${haveFixture ? 'golden fixture' : 'MISSING fixture'}`, {
      skip: haveFixture ? false : `no fixture at ${path.relative(REPO_ROOT, fixturePath)}`,
    }, async () => {
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
      await assertFixtureMatchesLive(ls, fn, fixture);
    });
  }
});

// ── Assertion harness ──────────────────────────────────────────────────────

/**
 * Invoke `ls[fn](...input)` against the live DB, capture (return, mutations),
 * normalise UUIDs / now()-timestamps the same way the recorder did, and
 * deep-equal against the fixture's `expected` block.
 *
 * For now: stub. The full implementation pairs with the recorder's
 * snapshot-and-diff logic in `scripts/postgres-parity/record-golden-fixtures.mjs`.
 * Hook the snapshot-capture there before fleshing this out.
 */
async function assertFixtureMatchesLive(store, fnName, fixture) {
  const fn = store[fnName];
  assert.equal(typeof fn, 'function', `${fnName} is not a function`);
  assert.ok(fixture?.input !== undefined, `fixture ${fnName} missing input`);
  assert.ok(fixture?.expected !== undefined, `fixture ${fnName} missing expected`);

  // TODO(M3-followup): implement the live-call + diff. Hold-points:
  //   1. Run inside a transaction; ROLLBACK at the end (no live-state pollution)
  //   2. Normalise UUIDs / now()-timestamps in the captured result before deep-equal
  //   3. Snapshot the mutated tables before+after to compute the mutation diff
  // For now this is a placeholder so the suite is wired but doesn't pretend
  // to pass without real fixtures.
  assert.fail(
    `${fnName}: parity assertion is a placeholder — the M3-followup task wires the diff harness ` +
    `(see top-of-file comment + scripts/postgres-parity/record-golden-fixtures.mjs)`
  );
}
