/**
 * @fileoverview Executable smoke test for `runLegacyProductionAudit` — the
 * first test that actually RUNS the ~1,900-line orchestrator.
 *
 * Why it exists (audit M15, 2026-07-18): a refactor left a dangling
 * `cloudPass.suppressedCount` reference that crashed every cloud-enabled R2+
 * run — through 6,767 green tests, because nothing ever executed the
 * function. Source pins are syntactic; this file is the semantic complement.
 *
 * Design (plan: docs/plans/shadow-write-gate-and-orchestrator-smoke.md):
 *  - ZERO passes (`passFilter: []`) — no LLM call is ever attempted. Nothing
 *    is mocked; a whole category of work is simply empty (Tier-2 doctrine:
 *    never mock the provider API).
 *  - Poisoned provider HANDLES in an inert container: the function
 *    legitimately destructures the container (`const { openai } = providers`),
 *    so the container is a plain object — but every handle inside it throws
 *    on ANY property access. A tripwire, not a stub.
 *  - Hermetic (INC-002): `AUDIT_DB_URL = ''` is pinned at MODULE TOP, before
 *    the orchestrator's module graph is evaluated (dynamic import below) —
 *    static imports would evaluate first and could cache env-derived state.
 *    `repoProfile: null` keeps the cloud guard false independently of env.
 *  - Per-variant mkdtemp dirs: the allow-variants assert the bandit state
 *    file EXISTS afterward; the deny-variant asserts it does NOT — separate
 *    dirs make those assertions order-independent under any concurrency.
 *
 * Honest coverage statement: this executes every line reachable with
 * `cloudRunId == null`, on both sides of the learningWritesAllowed gate.
 * Lines strictly inside `if (cloudRunId)` bodies (including the historical
 * crash line itself) remain covered only by the source pins in
 * tests/suppression-call-site.test.mjs.
 *
 * Layered coverage (mutation-verified at implementation): removing the GATE
 * alone leaves variant 3 green — the view still absorbs the local flush;
 * the gate's distinct contribution is the CLOUD channel, invisible in a
 * cloud-off test — and is caught by its source pin. Removing the SWAP alone
 * is likewise pin-caught. Removing BOTH turns variant 3 red here. So: pins
 * catch each mechanism individually (syntactic), this file catches the
 * end-to-end deny contract (behavioural); neither alone is sufficient.
 */
process.env.AUDIT_DB_URL = ''; // must precede the dynamic imports below (INC-002)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { runLegacyProductionAudit } = await import('../scripts/lib/audit/legacy-production-audit.mjs');
const { writeLedgerEntry, buildRulingsBlock } = await import('../scripts/lib/ledger.mjs');
const { PromptBandit } = await import('../scripts/bandit.mjs');
const { FalsePositiveTracker } = await import('../scripts/lib/findings-tracker.mjs');

/** A provider handle whose ANY use throws — asserts zero-pass ⇒ zero provider use. */
function poisonedHandle(name) {
  return new Proxy(function () {}, {
    get(_t, prop) {
      // Engine/runtime probes (then/Symbol.*) must stay inert or awaiting the
      // container would false-trip; every REAL use (responses, messages, call)
      // still throws.
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      throw new Error(`SMOKE_TOUCHED_PROVIDER: ${name}.${String(prop)}`);
    },
    apply() { throw new Error(`SMOKE_TOUCHED_PROVIDER: ${name}()`); },
  });
}

/** Full argument object for the orchestrator — every parameter explicit. */
// A REAL, small, read-only repo file: the orchestrator's own empty-scope
// guard (":1707 — refusing to emit a verdict over code that was never read",
// itself a vacuous-green protection this smoke test immediately ran into)
// aborts when no changed file exists on disk. The audit only READS it.
const REAL_TARGET = 'scripts/lib/rng.mjs';

function makeSmokeInput({ round, noCloudRecording }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-smoke-'));
  const diffFile = path.join(tmp, 'smoke.patch');
  fs.writeFileSync(diffFile, [
    `--- a/${REAL_TARGET}`,
    `+++ b/${REAL_TARGET}`,
    '@@ -1,2 +1,3 @@',
    ' export function smoke() {',
    '+  return 1;',
    ' }',
    '',
  ].join('\n'));

  let ledgerFile = null;
  if (round >= 2) {
    // Produced by the PRODUCTION writer against the PRODUCTION schema
    // (LedgerEntrySchema — every field below is required by it), and the
    // precondition in variant 2 proves the production READ path consumes it.
    ledgerFile = path.join(tmp, 'ledger.json');
    writeLedgerEntry(ledgerFile, {
      topicId: 'smoke-topic',
      semanticHash: 'smoke-hash-1',
      severity: 'LOW',
      category: 'smoke',
      section: 'smoke fixture finding',
      detailSnapshot: 'smoke fixture — dismissed so R2+ has one ruling to load',
      affectedFiles: [REAL_TARGET],
      affectedPrinciples: [],
      pass: 'backend',
      adjudicationOutcome: 'dismissed',
      remediationState: 'pending',
      originalSeverity: 'LOW',
      ruling: 'overrule',
      rulingRationale: 'smoke fixture ruling',
      resolvedRound: 1,
    });
  }

  const ctx = {
    // The subject-file discovery extracts paths from the PLAN CONTENT (the
    // A1 guard aborts otherwise — "0 of 0 resolved"), so the smoke plan must
    // cite its real target the way a real plan does.
    planContent: `# smoke plan\n\nAudit scope: \`${REAL_TARGET}\` (modify).\n`,
    projectContext: '',
    historyContext: '',
    passFilter: [],            // ZERO passes — the load-bearing choice
    fileFilter: null,
    round,
    ledgerFile,
    diffFile,
    changedFiles: [REAL_TARGET],
    auditBaseCommit: null,
    repoProfile: null,         // cloud guard false independently of env
    bandit: new PromptBandit(path.join(tmp, 'bandit-state.json')),
    fpTracker: new FalsePositiveTracker(path.join(tmp, 'fp-tracker.json')),
    noLedger: false,
    noTools: true,
    strictLint: false,
    noDebtLedger: true,
    readOnlyDebt: true,
    debtLedgerPath: path.join(tmp, 'debt-ledger.json'),
    debtEventsPath: path.join(tmp, 'debt-events.jsonl'),
    escalateRecurring: null,
    sessionCacheHit: null,
    scopeMode: 'diff',
    planFile: null,
    runId: null,
    // TRUE (deviation from the plan fixture, found by execution): the smoke
    // target lives in the audit tool's own tree, and extractPlanPaths excludes
    // audit-infra files from a NORMAL audit's subject set — the exact meta-case
    // the --allow-infra-scope flag exists for. With false, every path resolves
    // to nothing and the A1 empty-scope guard (correctly) aborts.
    allowInfraScope: true,
    outFile: null,
    providers: {
      openai: poisonedHandle('openai'),
      anthropicClient: poisonedHandle('anthropicClient'),
      ossCall: poisonedHandle('ossCall'),
      geminiReviewCall: poisonedHandle('geminiReviewCall'),
      geminiCleanRegionCall: poisonedHandle('geminiCleanRegionCall'),
    },
    noCloudRecording,
  };
  return { ctx, tmp, banditStatePath: path.join(tmp, 'bandit-state.json'), ledgerFile };
}

function cleanup(tmp) {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

function assertResultContract(result, { round }) {
  assert.ok(result && typeof result === 'object', 'a result object is returned');
  assert.ok(Array.isArray(result.findings), 'findings is an array');
  if (round >= 2) {
    assert.ok(result._suppression, 'R2+ carries the _suppression block');
  }
}

test('smoke variant 1 — R1 allow-path executes; bandit state persists (the allow side is real)', async () => {
  const { ctx, tmp, banditStatePath } = makeSmokeInput({ round: 1, noCloudRecording: false });
  try {
    // No pre-seeding (audit R1-M4: a test-side addArm persisted the file
    // BEFORE the run, making the assertion provable with the orchestrator's
    // persistence entirely broken). The orchestrator itself registers arms
    // (Phase 6, addArm for every pass) and flushes at the tail — so the
    // file's existence AFTER the run, starting from a bandit whose file does
    // not exist, is attributable only to in-run persistence.
    assert.ok(!fs.existsSync(banditStatePath), 'precondition: nothing persisted before the run');
    const result = await runLegacyProductionAudit(ctx);
    assertResultContract(result, { round: 1 });
    assert.ok(fs.existsSync(banditStatePath), 'allow-path must have persisted bandit state in-run');
  } finally {
    cleanup(tmp);
  }
});

test('smoke variant 2 — R2 allow-path executes the suppression composition with a real ledger', async () => {
  const { ctx, tmp, ledgerFile } = makeSmokeInput({ round: 2, noCloudRecording: false });
  try {
    // Precondition (vacuity guard): the PRODUCTION reader must consume the
    // fixture — a silently-rejected ledger would make this a green empty run.
    const rulings = buildRulingsBlock(ledgerFile, 'backend');
    assert.ok(rulings && rulings.length > 0, 'production reader must load the fixture entry');
    const result = await runLegacyProductionAudit(ctx);
    assertResultContract(result, { round: 2 });
  } finally {
    cleanup(tmp);
  }
});

test('smoke variant 3 — deny-path (noCloudRecording): the bandit state file is NEVER written', async () => {
  const { ctx, tmp, banditStatePath } = makeSmokeInput({ round: 2, noCloudRecording: true });
  try {
    assert.ok(!fs.existsSync(banditStatePath), 'precondition: no state file yet');
    const result = await runLegacyProductionAudit(ctx);
    assertResultContract(result, { round: 2 });
    // The behavioural observable for the whole H1 fix: gate (flush skipped)
    // + view (addArm._save neutered) ⇒ nothing may create this file.
    assert.ok(!fs.existsSync(banditStatePath), 'deny-path must not persist bandit state');
  } finally {
    cleanup(tmp);
  }
});
