/**
 * Determinism follow-ups WS1 — run-unification + deterministic outcome finalize.
 *
 * Scope of THIS file (hermetic, no DB): the deterministic seam added by Phase 2
 *  - the `markRunFindingsNeedsTriage` / `auditRunExists` input-validation
 *    contracts (short-circuit guards that never touch the DB),
 *  - the finalize **reconciliation** logic — given findings + a ledger, which
 *    findings stay `pending` (→ needs_triage) vs get labelled — exercised
 *    through `recordTriageOutcomes(store=null, …)`, the same enrichment the
 *    `finalize-outcomes` subcommand drives,
 *  - the `finalize-outcomes` CLI argument validation.
 *
 * The DB-level guarantee the plan §1.5 names ("a simulated 3-round audit ⇒ 1
 * run with all findings labelled; single-round no-`--run-id` byte-identical")
 * is a STORE-INTEGRATION property: it depends on `recordRunStart`'s
 * `ON CONFLICT (id)` reuse-probe against a live `audit_runs` table, which is
 * only exercised when `AUDIT_DB_URL` is configured (mirrors
 * learning-store-phase1.test.mjs, which env-gates the same way). It is NOT
 * unit-mockable here without standing up a hermetic Postgres, so it is left to
 * the integration env rather than asserted against a fake.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { recordTriageOutcomes } from '../scripts/lib/outcome-sync.mjs';
import { generateTopicId } from '../scripts/lib/ledger.mjs';
import { markRunFindingsNeedsTriage, auditRunExists } from '../scripts/learning-store.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function mkFinding(id, overrides = {}) {
  return {
    id,
    severity: 'HIGH',
    category: 'correctness',
    section: 'scripts/foo.mjs',
    detail: `finding ${id}`,
    _pass: 'backend',
    _hash: `hash-${id}`,
    ...overrides,
  };
}

// ── markRunFindingsNeedsTriage — input-validation contract (no DB) ──────────

describe('markRunFindingsNeedsTriage — guards short-circuit before any query', () => {
  it('returns {updated:0} when runId is absent', async () => {
    const r = await markRunFindingsNeedsTriage(null, ['hash-1']);
    assert.deepEqual(r, { updated: 0 });
  });

  it('returns {updated:0} for an empty fingerprint list (no query attempted)', async () => {
    // A valid runId but empty list short-circuits at the length guard — so this
    // holds regardless of whether cloud is configured in the test env.
    const r = await markRunFindingsNeedsTriage('00000000-0000-0000-0000-000000000000', []);
    assert.deepEqual(r, { updated: 0 });
  });

  it('returns {updated:0} when fingerprints is not an array', async () => {
    const r = await markRunFindingsNeedsTriage('00000000-0000-0000-0000-000000000000', null);
    assert.deepEqual(r, { updated: 0 });
  });
});

describe('auditRunExists — absent runId never probes', () => {
  it('returns false for a null runId', async () => {
    assert.equal(await auditRunExists(null), false);
  });
});

// ── finalize reconciliation logic (store=null → no DB, no cloud) ────────────

describe('finalize reconciliation — pending detection drives needs_triage', () => {
  it('a ledger that adjudicates nothing leaves every finding pending', async () => {
    const findings = [mkFinding('H1'), mkFinding('H2')];
    const { enriched } = await recordTriageOutcomes(null, null, findings, { entries: [] }, { round: 2 });
    assert.equal(enriched.length, 2);
    assert.ok(enriched.every(f => f.adjudicationOutcome === 'pending'),
      'no ledger entry ⇒ all pending ⇒ all needs_triage candidates');
  });

  it('a partial ledger labels the adjudicated finding and leaves the rest pending', async () => {
    const labelled = mkFinding('H1');
    const omitted = mkFinding('H2');
    const ledger = {
      entries: [
        { topicId: generateTopicId(labelled), adjudicationOutcome: 'accepted', remediationState: 'fixed' },
      ],
    };
    const { enriched } = await recordTriageOutcomes(null, null, [labelled, omitted], ledger, { round: 2 });
    const byId = Object.fromEntries(enriched.map(f => [f.id, f.adjudicationOutcome]));
    assert.equal(byId.H1, 'accepted', 'ledger-adjudicated finding is labelled');
    assert.equal(byId.H2, 'pending', 'ledger-omitted finding stays pending (→ needs_triage at finalize)');
  });
});

// ── finalize-outcomes CLI — argument validation ─────────────────────────────

function runFinalize(args) {
  try {
    const out = execFileSync('node', ['scripts/cross-skill.mjs', 'finalize-outcomes', ...args], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout: out, status: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', status: err.status ?? 1 };
  }
}

function lastJsonLine(stdout) {
  const lines = stdout.trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* skip non-JSON (config banner) */ }
  }
  return null;
}

describe('finalize-outcomes CLI — required-arg validation', () => {
  it('emits BAD_INPUT AND exits non-zero when required args are missing', () => {
    const { stdout, status } = runFinalize([]);
    const json = lastJsonLine(stdout);
    assert.ok(json, 'should emit a JSON line');
    assert.equal(json.ok, false);
    assert.equal(json.error.code, 'BAD_INPUT');
    assert.notEqual(status, 0, 'a validation failure must exit non-zero (emitError exit 2)');
  });

  it('emits BAD_INPUT AND exits non-zero when the result file cannot be read', () => {
    const { stdout, status } = runFinalize([
      '--run-id', '00000000-0000-0000-0000-000000000000',
      '--ledger', 'tests/run-unification.test.mjs', // any readable file
      '--result', 'does/not/exist.json',
    ]);
    const json = lastJsonLine(stdout);
    assert.ok(json && json.ok === false);
    assert.equal(json.error.code, 'BAD_INPUT');
    assert.notEqual(status, 0, 'an unreadable result file must exit non-zero');
  });
});
