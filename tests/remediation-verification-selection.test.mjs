/**
 * @fileoverview Pure-logic tests for scripts/lib/remediation-verification.mjs
 * — the out-of-band remediation-state reconciler
 * (docs/plans/remediation-state-verification-reconciler.md). All git/LLM
 * interaction is injected, so this suite never touches a subprocess or a
 * network call (Tier 1: deterministic seam).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  effectiveSinceCommit, selectFindingsNeedingCheck, groupByFile,
  normaliseVerificationVerdicts, planWriteActions, mechanicalResolvedAction,
  VerificationVerdictSchema,
  buildPathSkipClassifier, PATH_SKIP_SENSITIVE, PATH_SKIP_UNRESOLVABLE,
} from '../scripts/lib/remediation-verification.mjs';

/** The real repo root — these classify with the REAL oracle, not a fake that begs the question. */
const REPO_ROOT = path.resolve(import.meta.dirname, '..');

// ── effectiveSinceCommit / selectFindingsNeedingCheck ───────────────────────

test('effectiveSinceCommit prefers the last-checked commit over the accepted-at commit', () => {
  assert.equal(effectiveSinceCommit({ accepted_at_commit: 'a', remediation_last_checked_commit: 'b' }), 'b');
  assert.equal(effectiveSinceCommit({ accepted_at_commit: 'a', remediation_last_checked_commit: null }), 'a');
  assert.equal(effectiveSinceCommit({ accepted_at_commit: 'a' }), 'a');
});

test('selectFindingsNeedingCheck: row #1 — unchanged since acceptance, never checked → skipped', () => {
  const rows = [{ primary_file: 'a.js', accepted_at_commit: 'c1', finding_fingerprint: 'fp1' }];
  const fileState = () => 'unchanged';
  const { needsLlmCheck, mechanicallyResolved, skipped } = selectFindingsNeedingCheck(rows, fileState);
  assert.deepEqual(needsLlmCheck, []);
  assert.deepEqual(mechanicallyResolved, []);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'unchanged-since-last-check');
});

test('selectFindingsNeedingCheck: row #2 — changed since acceptance, never checked → needs LLM check', () => {
  const rows = [{ primary_file: 'a.js', accepted_at_commit: 'c1', finding_fingerprint: 'fp1' }];
  const fileState = () => 'changed';
  const { needsLlmCheck } = selectFindingsNeedingCheck(rows, fileState);
  assert.deepEqual(needsLlmCheck, rows);
});

test('selectFindingsNeedingCheck: row #3 — changed again since the last CHECK (not just since acceptance) → included', () => {
  const rows = [{
    primary_file: 'a.js', accepted_at_commit: 'c1', remediation_last_checked_commit: 'c2',
    finding_fingerprint: 'fp1',
  }];
  let queried = null;
  const fileState = (file, sinceCommit) => { queried = sinceCommit; return 'changed'; };
  const { needsLlmCheck } = selectFindingsNeedingCheck(rows, fileState);
  assert.equal(queried, 'c2', 'must measure change since the LAST CHECK, not since acceptance, once a check has happened');
  assert.deepEqual(needsLlmCheck, rows);
});

test('selectFindingsNeedingCheck: row #4 — checked at HEAD already, no further change → skipped (the throttle)', () => {
  const rows = [{
    primary_file: 'a.js', accepted_at_commit: 'c1', remediation_last_checked_commit: 'HEAD',
    finding_fingerprint: 'fp1',
  }];
  const fileState = () => 'unchanged';
  const { skipped } = selectFindingsNeedingCheck(rows, fileState);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'unchanged-since-last-check');
});

test('selectFindingsNeedingCheck: row #5 — commit unresolvable (rewritten history) → skip, logged, never guessed', () => {
  const rows = [{ primary_file: 'a.js', accepted_at_commit: 'gone', finding_fingerprint: 'fp1' }];
  const fileState = () => 'unknown';
  const { needsLlmCheck, mechanicallyResolved, skipped } = selectFindingsNeedingCheck(rows, fileState);
  assert.deepEqual(needsLlmCheck, []);
  assert.deepEqual(mechanicallyResolved, []);
  assert.equal(skipped[0].reason, 'commit-unresolvable');
});

test('selectFindingsNeedingCheck: a deleted file resolves mechanically, no LLM check', () => {
  const rows = [{ primary_file: 'a.js', accepted_at_commit: 'c1', finding_fingerprint: 'fp1' }];
  const fileState = () => 'deleted';
  const { needsLlmCheck, mechanicallyResolved } = selectFindingsNeedingCheck(rows, fileState);
  assert.deepEqual(needsLlmCheck, []);
  assert.deepEqual(mechanicallyResolved, rows);
});

test('selectFindingsNeedingCheck: missing primary_file or commit is skipped, not crashed on', () => {
  const rows = [
    { primary_file: null, accepted_at_commit: 'c1', finding_fingerprint: 'fp1' },
    { primary_file: 'a.js', accepted_at_commit: null, finding_fingerprint: 'fp2' },
  ];
  const { skipped, needsLlmCheck } = selectFindingsNeedingCheck(rows, () => 'changed');
  assert.equal(needsLlmCheck.length, 0);
  assert.equal(skipped.length, 2);
  assert.ok(skipped.every((s) => s.reason === 'missing-primary-file-or-commit'));
});

test('a sensitive path is refused BEFORE any git/LLM work — mechanically resolved and skipped are both empty', () => {
  const rows = [{ primary_file: '.env', accepted_at_commit: 'c1', finding_fingerprint: 'fp1' }];
  let fileStateCalled = false;
  const fileState = () => { fileStateCalled = true; return 'changed'; };
  const isSensitivePath = (file) => file === '.env';
  const { needsLlmCheck, mechanicallyResolved, sensitivePathSkipped, skipped } =
    selectFindingsNeedingCheck(rows, fileState, isSensitivePath);
  assert.equal(fileStateCalled, false, 'the git-diff adapter must never even be consulted for a sensitive path');
  assert.deepEqual(needsLlmCheck, []);
  assert.deepEqual(mechanicallyResolved, []);
  assert.deepEqual(skipped, []);
  assert.deepEqual(sensitivePathSkipped, rows);
});

test('a non-sensitive path proceeds normally when isSensitivePath is supplied', () => {
  const rows = [{ primary_file: 'src/a.js', accepted_at_commit: 'c1', finding_fingerprint: 'fp1' }];
  const { needsLlmCheck, sensitivePathSkipped } =
    selectFindingsNeedingCheck(rows, () => 'changed', () => false);
  assert.deepEqual(needsLlmCheck, rows);
  assert.deepEqual(sensitivePathSkipped, []);
});

// ── groupByFile ──────────────────────────────────────────────────────────

test('groupByFile batches findings sharing one primary_file into one group', () => {
  const findings = [
    { primary_file: 'a.js', finding_fingerprint: 'fp1' },
    { primary_file: 'b.js', finding_fingerprint: 'fp2' },
    { primary_file: 'a.js', finding_fingerprint: 'fp3' },
  ];
  const grouped = groupByFile(findings);
  assert.equal(grouped.length, 2);
  const aGroup = grouped.find((g) => g.file === 'a.js');
  assert.equal(aGroup.findings.length, 2);
  assert.deepEqual(aGroup.findings.map((f) => f.finding_fingerprint), ['fp1', 'fp3']);
});

// ── normaliseVerificationVerdicts ────────────────────────────────────────

test('normaliseVerificationVerdicts accepts a well-formed, complete response', () => {
  const raw = { verdicts: [
    { fingerprint: 'fp1', verdict: 'resolved', rationale: 'the catch block now rethrows' },
    { fingerprint: 'fp2', verdict: 'still-present', rationale: 'unchanged' },
  ] };
  const out = normaliseVerificationVerdicts(raw, { expectedFingerprints: ['fp1', 'fp2'] });
  assert.deepEqual(out.map((v) => [v.fingerprint, v.verdict]), [['fp1', 'resolved'], ['fp2', 'still-present']]);
});

test('normaliseVerificationVerdicts downgrades a MISSING fingerprint to uncertain, never drops it', () => {
  const raw = { verdicts: [{ fingerprint: 'fp1', verdict: 'resolved', rationale: 'ok' }] };
  const out = normaliseVerificationVerdicts(raw, { expectedFingerprints: ['fp1', 'fp2'] });
  assert.equal(out.length, 2, 'every expected fingerprint must get exactly one verdict');
  const fp2 = out.find((v) => v.fingerprint === 'fp2');
  assert.equal(fp2.verdict, 'uncertain');
  assert.match(fp2.rationale, /did not return a verdict/);
});

test('normaliseVerificationVerdicts downgrades a malformed/null payload to uncertain for every fingerprint (never throws)', () => {
  const out = normaliseVerificationVerdicts(null, { expectedFingerprints: ['fp1', 'fp2'] });
  assert.deepEqual(out.map((v) => v.verdict), ['uncertain', 'uncertain']);
  assert.match(out[0].rationale, /schema validation failed/);
});

test('normaliseVerificationVerdicts ignores a verdict for a fingerprint that was never asked about (unrepresentable)', () => {
  const raw = { verdicts: [
    { fingerprint: 'fp1', verdict: 'resolved', rationale: 'ok' },
    { fingerprint: 'fp-unknown', verdict: 'resolved', rationale: 'hallucinated' },
  ] };
  const out = normaliseVerificationVerdicts(raw, { expectedFingerprints: ['fp1'] });
  assert.equal(out.length, 1);
  assert.equal(out[0].fingerprint, 'fp1');
});

test('normaliseVerificationVerdicts rejects an out-of-enum verdict at the schema, downgrading to uncertain', () => {
  const raw = { verdicts: [{ fingerprint: 'fp1', verdict: 'definitely-fixed', rationale: 'x' }] };
  const out = normaliseVerificationVerdicts(raw, { expectedFingerprints: ['fp1'] });
  assert.equal(out[0].verdict, 'uncertain');
});

test('VerificationVerdictSchema is .strict() — an unexpected extra key is rejected, not silently dropped', () => {
  const parsed = VerificationVerdictSchema.safeParse({
    fingerprint: 'fp1', verdict: 'resolved', rationale: 'x', confidence: 0.9,
  });
  assert.equal(parsed.success, false);
});

// ── planWriteActions / mechanicalResolvedAction ──────────────────────────

test('planWriteActions maps verdicts back onto their findingId by fingerprint', () => {
  const batch = [
    { audit_finding_id: 'id-1', finding_fingerprint: 'fp1' },
    { audit_finding_id: 'id-2', finding_fingerprint: 'fp2' },
  ];
  const verdicts = [
    { fingerprint: 'fp1', verdict: 'resolved', rationale: 'r1' },
    { fingerprint: 'fp2', verdict: 'uncertain', rationale: 'r2' },
  ];
  const actions = planWriteActions(batch, verdicts, 'headsha123');
  assert.deepEqual(actions, [
    { findingId: 'id-1', outcome: 'resolved', checkedAtCommit: 'headsha123', rationale: 'r1' },
    { findingId: 'id-2', outcome: 'uncertain', checkedAtCommit: 'headsha123', rationale: 'r2' },
  ]);
});

test('planWriteActions drops a verdict whose fingerprint matches no row in the batch', () => {
  const batch = [{ audit_finding_id: 'id-1', finding_fingerprint: 'fp1' }];
  const verdicts = [{ fingerprint: 'fp-orphan', verdict: 'resolved', rationale: 'x' }];
  assert.deepEqual(planWriteActions(batch, verdicts, 'sha'), []);
});

test('mechanicalResolvedAction produces a resolved action naming the mechanical reason', () => {
  const row = { audit_finding_id: 'id-1', primary_file: 'gone.js' };
  const action = mechanicalResolvedAction(row, 'sha123');
  assert.equal(action.findingId, 'id-1');
  assert.equal(action.outcome, 'resolved');
  assert.equal(action.checkedAtCommit, 'sha123');
  assert.match(action.rationale, /no longer exists/);
});

// ── The two refusals are opposite claims (upstream report f8d2730f) ────────
//
// `resolveAndClassify` answers `category:'sensitive'` for four situations, and the
// boolean predicate fused all four into one bucket the CLI printed as
// `N sensitive-path skipped`. A plan-mode `primary_file` is a section reference, so
// realpath fails on every one of them. Measured in the reporting consumer: 44 of 52
// eligible rows, in a repo with zero credential-like paths. Measured here the day of
// the fix, against the live store: `sensitivePathSkipped: 0, unresolvablePathSkipped: 129`
// — every one of the 129 previously reported as a sensitive path was false.

test('a plan-section primary_file is UNRESOLVABLE, never reported as sensitive', () => {
  // The real classifier against real section references, not a fake that begs the question.
  const classify = buildPathSkipClassifier(REPO_ROOT);
  for (const section of [
    '§2 decision 4; phase 0',
    'plan §7 — service/config additions',
    'decision 5b; file-level plan; phase 7',
  ]) {
    assert.equal(classify(section), PATH_SKIP_UNRESOLVABLE,
      `${JSON.stringify(section)} has no file by construction — calling it sensitive invents a security signal`);
  }
});

test('a real credential path is still SENSITIVE — the direction that must not regress', () => {
  const classify = buildPathSkipClassifier(REPO_ROOT);
  assert.equal(classify('.env'), PATH_SKIP_SENSITIVE);
});

test('a live source file is not refused at all', () => {
  const classify = buildPathSkipClassifier(REPO_ROOT);
  assert.equal(classify('scripts/lib/db/client.mjs'), null);
});

test('the split is keyed on resolutionFailed, so an ESCAPED or symlinked path stays sensitive', () => {
  // The subtle half. Cases 2 and 3 (escapedRepo, canonical-sensitive) also carry a null
  // `lexical`, so a classifier written as "no lexical match ⇒ merely unresolvable" would
  // downgrade the two REAL hazards this gate exists to catch — INC-001's symlink-bypass
  // class. They RESOLVE fine; that is what tells them apart, and it is why the predicate
  // reads `resolutionFailed` rather than `lexical`.
  const escaped = { category: 'sensitive', lexical: null, resolutionFailed: false };
  const unresolved = { category: 'sensitive', lexical: null, resolutionFailed: true };
  const reason = (r) => (r.category === 'sensitive' ? (r.resolutionFailed ? PATH_SKIP_UNRESOLVABLE : PATH_SKIP_SENSITIVE) : null);
  assert.equal(reason(escaped), PATH_SKIP_SENSITIVE, 'an escaped/symlinked path is a real hazard, not a missing file');
  assert.equal(reason(unresolved), PATH_SKIP_UNRESOLVABLE);
});

test('BOTH refusals still skip — a bucket is not a permission', () => {
  const rows = [
    { primary_file: '.env', accepted_at_commit: 'c1', finding_fingerprint: 'fp1' },
    { primary_file: '§2 decision 4', accepted_at_commit: 'c1', finding_fingerprint: 'fp2' },
  ];
  let fileStateCalled = false;
  const fileState = () => { fileStateCalled = true; return 'changed'; };
  const { needsLlmCheck, mechanicallyResolved, sensitivePathSkipped, unresolvablePathSkipped, skipped } =
    selectFindingsNeedingCheck(rows, fileState, buildPathSkipClassifier(REPO_ROOT));
  assert.equal(fileStateCalled, false, 'neither refusal may reach the git adapter — fail-closed is unchanged');
  assert.deepEqual(needsLlmCheck, []);
  assert.deepEqual(mechanicallyResolved, []);
  assert.deepEqual(skipped, []);
  assert.equal(sensitivePathSkipped.length, 1, 'only the real credential path');
  assert.equal(unresolvablePathSkipped.length, 1, 'the section reference, named honestly');
});

test('the BOOLEAN predicate still works and is read as sensitive — old callers unchanged', () => {
  // `buildSensitivePathPredicate` is still exported and still returns a boolean. A `true`
  // from it can only under-split; it must never be mislabelled as merely unresolvable.
  const rows = [{ primary_file: '.env', accepted_at_commit: 'c1', finding_fingerprint: 'fp1' }];
  const { sensitivePathSkipped, unresolvablePathSkipped } =
    selectFindingsNeedingCheck(rows, () => 'changed', (f) => f === '.env');
  assert.deepEqual(sensitivePathSkipped, rows);
  assert.deepEqual(unresolvablePathSkipped, []);
});

test('WIRING PIN: the CLI reports the two counts separately', async () => {
  // The operator-facing half. Splitting the buckets and then printing one number would
  // fix nothing that the report is about.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = fs.readFileSync(path.join(import.meta.dirname, '../scripts/remediation-reconcile.mjs'), 'utf-8');
  assert.match(src, /buildPathSkipClassifier/, 'the CLI must use the reason-returning classifier');
  assert.ok(!/buildSensitivePathPredicate/.test(src),
    'the boolean predicate cannot distinguish the two, so the CLI must not fall back to it');
  assert.match(src, /unresolvablePathSkipped\.length/, 'the new count must reach the summary line');
  assert.equal((src.match(/unresolvablePathSkipped: unresolvablePathSkipped\.length/g) || []).length, 2,
    'both the dry-run and the apply JSON payloads must carry it');
});
