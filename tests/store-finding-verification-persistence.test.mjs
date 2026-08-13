/**
 * @fileoverview Guards the persistence leg of the deterministic existence gate
 * (migration 20260813120000).
 *
 * The gate (`scripts/lib/audit/finding-verification.mjs`) attaches a sibling
 * `verification` object to every existence-claim finding. Until this leg it was
 * never written to `audit_findings`: the verdict lived only in a gitignored
 * local artifact and one stderr line, so a HIGH the gate had PROVED false was
 * stored indistinguishably from a real HIGH, and the rate of refuted /
 * requires_verification had no queryable baseline at all.
 *
 * TWO INVARIANTS, and the second is the one worth the file:
 *   1. the verdict reaches its own columns, and
 *   2. `severity` still carries the MODEL's value. Rewriting it with the
 *      gate-effective severity would corrupt the metric the A/B stopping rule
 *      counts (the same rule `recordFindings` already states when it refuses to
 *      fabricate a missing severity) and destroy the model's immutable claim
 *      (audit M2). A test that only checked (1) would pass just as happily
 *      against a version that silently downgraded `severity`.
 *
 * THE FIXTURES COME FROM THE REAL GATE, never hand-written. A hand-built
 * `verification` object would encode what the READER expects — which is the
 * assumption under test — and the prose↔code seam in AGENTS.md exists because
 * exactly that drift (`finding.severity` vs `finding.code`) went undetected for
 * months behind a green suite of reader-shaped fixtures. Here both sides are
 * code, so the test drives the producer and asserts on the consumer: a rename of
 * `verificationReason` on either side fails this file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyExistenceFindings } from '../scripts/lib/audit/finding-verification.mjs';
import { buildFindingRow } from '../scripts/lib/store/runs-findings.mjs';

const ALL_COLUMNS = Object.freeze({
  hasClassification: false,
  hasSourceModel: false,
  hasBucket: false,
  hasStage: false,
  hasArm: false,
  hasIsQuickFix: false,
  hasVerification: true,
});
const CTX = { runId: 'run-1', passName: 'merged', round: 1, columns: ALL_COLUMNS };

/** Run the REAL gate over one finding and return it with its verdict attached. */
function throughGate(finding, repoFiles) {
  return verifyExistenceFindings([finding], { repoFiles, inventoryComplete: true })[0];
}

const REFUTED = () => throughGate(
  { id: 'H1', severity: 'HIGH', category: 'Missing module', section: 'src/app.js',
    detail: 'The module `src/services/zone.js` is missing.' },
  ['src/app.js', 'src/services/zone.js'],
);
const CONFIRMED = () => throughGate(
  { id: 'H2', severity: 'HIGH', category: 'Missing module', section: 'src/app.js',
    detail: 'The module `src/services/nope.js` is missing.' },
  ['src/app.js'],
);
const REQUIRES = () => throughGate(
  { id: 'H3', severity: 'HIGH', category: 'Missing export', section: 'src/app.js',
    detail: 'The export `computeTotal` is missing.' },
  ['src/app.js'],
);

// ── the producer still emits what this test claims it does ──────────────────
// A vacuous-pass guard: if the gate stopped refuting (or the prose stopped
// matching its regexes), every assertion below would hold trivially against a
// finding with no `verification` at all.
test('PRECONDITION: the gate emits all three verdicts for these fixtures', () => {
  assert.equal(REFUTED().verification?.verification, 'refuted');
  assert.equal(CONFIRMED().verification?.verification, 'confirmed');
  assert.equal(REQUIRES().verification?.verification, 'requires_verification');
});

// ── invariant 1: the verdict reaches its own columns ────────────────────────
test('a refuted finding persists its verdict, reason and triage severity', () => {
  const row = buildFindingRow(REFUTED(), CTX);
  assert.equal(row.verification, 'refuted');
  assert.equal(row.verdict_severity, 'LOW');
  assert.match(row.verification_reason, /exists in the repository inventory/);
});

test('confirmed / requires_verification keep the model severity as the triage severity', () => {
  assert.equal(buildFindingRow(CONFIRMED(), CTX).verdict_severity, 'HIGH');
  assert.equal(buildFindingRow(REQUIRES(), CTX).verdict_severity, 'HIGH');
});

// ── invariant 2: severity is the MODEL's claim, always ──────────────────────
test('severity is NEVER rewritten to the gate-effective value', () => {
  // The refuted case is the only one where the two differ, so it is the only
  // one that can catch a wired-in `effectiveSeverity`.
  const refuted = buildFindingRow(REFUTED(), CTX);
  assert.equal(refuted.severity, 'HIGH', 'the model said HIGH; the row must still say HIGH');
  assert.notEqual(refuted.severity, refuted.verdict_severity);
  assert.equal(buildFindingRow(CONFIRMED(), CTX).severity, 'HIGH');
});

// ── NULL means "the gate did not look", never "it could not decide" ─────────
test('a finding the gate never classified leaves all three columns NULL', () => {
  const plain = throughGate(
    { id: 'M1', severity: 'MEDIUM', category: 'Quality', section: 'src/app.js',
      detail: 'This function is hard to follow and should be split up.' },
    ['src/app.js'],
  );
  assert.equal(plain.verification, undefined, 'precondition: not an existence claim');
  const row = buildFindingRow(plain, CTX);
  assert.equal(row.verification, null);
  assert.equal(row.verification_reason, null);
  assert.equal(row.verdict_severity, null);
});

// ── un-migrated store: byte-identical rows, not a failure ───────────────────
test('without the columns the row omits them entirely', () => {
  const row = buildFindingRow(REFUTED(), { ...CTX, columns: { ...ALL_COLUMNS, hasVerification: false } });
  for (const c of ['verification', 'verification_reason', 'verdict_severity']) {
    assert.ok(!(c in row), `${c} must be absent, not null — an un-migrated store has no such column`);
  }
  assert.equal(row.severity, 'HIGH');
});

// ── domain enforcement at the write boundary ────────────────────────────────
test('an out-of-domain verdict_severity is coerced to null (round-1 audit M1)', () => {
  // `verdict_severity` was the only one of the three columns with no domain
  // guard, while its sibling `severity` has carried
  // `audit_findings_severity_check` since the table existed. Same blast radius
  // as the verdict above: one bad value would take the whole batch down.
  const row = buildFindingRow(
    { severity: 'HIGH', category: 'x', detail: 'y',
      verification: { verification: 'refuted', verdictSeverity: 'CRITICAL' } },
    CTX,
  );
  assert.equal(row.verdict_severity, null);
  assert.equal(row.verification, 'refuted', 'a bad severity must not discard the verdict beside it');
});

test('the real gate only ever produces in-domain verdict severities', () => {
  // Vacuous-pass guard for the test above: it asserts on a value the gate
  // cannot emit, so without this the domain could be wrong and nothing notices.
  for (const f of [REFUTED(), CONFIRMED(), REQUIRES()]) {
    assert.ok(['HIGH', 'MEDIUM', 'LOW'].includes(buildFindingRow(f, CTX).verdict_severity));
  }
});

test('an out-of-domain verdict is coerced to null, never sent at the CHECK', () => {
  // Not reachable from the real gate — this guards the DB CHECK added by
  // 20260813120000. A constraint violation inside a caller-supplied transaction
  // poisons the tx, so ONE bad value would silently discard the whole batch;
  // that is the failure mode `normaliseBucket` already exists to prevent.
  const row = buildFindingRow(
    { severity: 'HIGH', category: 'x', detail: 'y', verification: { verification: 'bogus', verdictSeverity: 'HIGH' } },
    CTX,
  );
  assert.equal(row.verification, null);
  assert.equal(row.severity, 'HIGH', 'coercing the verdict must not disturb the finding');
});

// ── the columns the writer emits are the columns the migration adds ─────────
test('column names match the migration', async () => {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const path = await import('node:path');
  const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
  const sql = fs.readFileSync(
    path.join(root, 'supabase/migrations/20260813120000_audit_findings_verification.sql'), 'utf8');
  for (const c of ['verification', 'verification_reason', 'verdict_severity']) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${c}\\b`), `migration must add ${c}`);
    assert.ok(c in buildFindingRow(REFUTED(), CTX), `writer must emit ${c}`);
  }
});
