/**
 * @fileoverview Upstream issue-report triage contract.
 *
 * Tier-1 (test-first, deterministic seams) per AGENTS.md testing doctrine: the
 * freshness rule, the fingerprint, path validation, the outbox envelope, and
 * the JS↔SQL lifecycle parity. All pure — the git adapter is the only impure
 * part and it is deliberately kept out of these assertions.
 *
 * Plan: docs/plans/upstream-issue-reports.md (Cluster B, Phase 3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  classifyReportFreshness, annotatePriorFix, computeFingerprint,
  validateAffectedPath, readBundleStamp, validateReportInput,
  parseEnvelope, writeEnvelope, drainOutbox,
  OUTBOX_ENVELOPE_VERSION, VALID_SEVERITIES,
} from '../scripts/lib/upstream/commands.mjs';
import { LEGAL_TRANSITIONS } from '../scripts/lib/store/upstream-issues.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SHA = 'a'.repeat(40);

// @duplicate-justification: target=tests/brainstorm-arch-context.test.mjs:mkTmp reason=a
// two-line mkdtemp wrapper is the idiomatic per-suite fixture helper in this repo;
// extracting a shared test util to save one line would add a cross-suite import
// dependency for no behavioural gain (the over-engineering cliff).
function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function rmTmp(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

// ── classifyReportFreshness: one case per precedence row (the table is total) ──

test('freshness: no stamp → unknown, never current', () => {
  for (const bad of [null, undefined, '', 'not-a-sha', 123]) {
    const r = classifyReportFreshness({ reportedSha: bad });
    assert.equal(r.verdict, 'unknown', `${bad} must be unknown`);
    assert.equal(r.reason, 'no-stamp');
  }
});

test('freshness: sha absent from this history → unknown(sha-not-in-history)', () => {
  const r = classifyReportFreshness({ reportedSha: SHA, shaInHistory: false, distanceAhead: 5 });
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reason, 'sha-not-in-history');
});

test('freshness: git unavailable → unknown, NOT current', () => {
  const r = classifyReportFreshness({ reportedSha: SHA, shaInHistory: true, distanceAhead: null });
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reason, 'git-unavailable');
});

test('freshness: behind HEAD → stale, carrying distance and age', () => {
  const r = classifyReportFreshness({
    reportedSha: SHA, shaInHistory: true, distanceAhead: 28, ageDays: 3,
  });
  assert.equal(r.verdict, 'stale');
  assert.equal(r.distanceAhead, 28);
  assert.equal(r.ageDays, 3);
});

test('freshness: at HEAD → current', () => {
  const r = classifyReportFreshness({ reportedSha: SHA, shaInHistory: true, distanceAhead: 0 });
  assert.equal(r.verdict, 'current');
});

test('freshness: age alone never makes a verdict — no invented staleness threshold', () => {
  const r = classifyReportFreshness({
    reportedSha: SHA, shaInHistory: true, distanceAhead: 0, ageDays: 9999,
  });
  assert.equal(r.verdict, 'current', 'a very old bundle that is still at HEAD is current');
  assert.equal(r.ageDays, 9999, 'age is reported…');
});

// ── annotatePriorFix: the direction fixture ─────────────────────────────────
//
// This is the inversion an audit round caught. The intuitive reading is
// backwards, so both directions are pinned explicitly: an implementation that
// swaps them must fail BOTH of these, not neither.

test('prior fix: fix NOT an ancestor of the bundle → the bundle PREDATES the fix', () => {
  assert.equal(annotatePriorFix({ ancestry: 'lacks-fix' }), 'bundle-predates-fix');
});

test('prior fix: fix IS an ancestor of the bundle → the bundle ALREADY CONTAINED it', () => {
  assert.equal(annotatePriorFix({ ancestry: 'contains-fix' }), 'bundle-contains-fix');
});

test('prior fix: unresolvable or absent ancestry → undetermined, never a guess', () => {
  assert.equal(annotatePriorFix({ ancestry: 'unresolvable' }), 'undetermined');
  assert.equal(annotatePriorFix({}), 'undetermined');
});

// ── Fingerprint ─────────────────────────────────────────────────────────────

test('fingerprint: two reports differing ONLY in body must not collide', () => {
  const base = { repoUuid: 'r', title: 't', affectedPath: 'p', reportedBundleSha: SHA };
  assert.notEqual(
    computeFingerprint({ ...base, body: 'first defect' }),
    computeFingerprint({ ...base, body: 'a completely different defect' }),
    'without the body hash, the UNIQUE key silently overwrites one real report with another',
  );
});

test('fingerprint: an identical retry de-duplicates', () => {
  const r = { repoUuid: 'r', title: 't', affectedPath: 'p', reportedBundleSha: SHA, body: 'b' };
  assert.equal(computeFingerprint(r), computeFingerprint(r));
});

test('fingerprint: field boundaries cannot shift (delimited encoding)', () => {
  // Bare concatenation would hash these identically — the collision an audit
  // round flagged, on a column that is a UNIQUE key.
  const a = computeFingerprint({ repoUuid: 'r', title: 'foo', affectedPath: 'bar', reportedBundleSha: SHA, body: 'x' });
  const b = computeFingerprint({ repoUuid: 'r', title: 'fo', affectedPath: 'obar', reportedBundleSha: SHA, body: 'x' });
  assert.notEqual(a, b);
});

// ── Path validation ─────────────────────────────────────────────────────────

test('affected path: the motivating wrong path is NOT recognised', () => {
  // The 2026-07-31 report named `scripts/install.mjs`; the real file is root
  // `install.mjs`, and neither is a synced consumer file. This is the check
  // that catches it locally, before the report is ever filed.
  const manifest = { files: { 'scripts/.claude-skills/cross-skill.mjs': 'sha256:x' } };
  assert.equal(validateAffectedPath('scripts/install.mjs', manifest).recognised, false);
});

test('affected path: a genuine synced file IS recognised', () => {
  const manifest = { files: { 'scripts/.claude-skills/gemini-review.mjs': 'sha256:x' } };
  assert.equal(validateAffectedPath('scripts/.claude-skills/gemini-review.mjs', manifest).recognised, true);
});

test('affected path: Windows backslashes normalise before the lookup', () => {
  // Manifest keys are always POSIX. Without normalisation every Windows
  // operator would have a correct report stamped `path_recognised: false`,
  // defeating the check.
  const manifest = { files: { 'scripts/.claude-skills/ship-commit.mjs': 'sha256:x' } };
  const r = validateAffectedPath('scripts\\.claude-skills\\ship-commit.mjs', manifest);
  assert.equal(r.recognised, true);
  assert.equal(r.normalised, 'scripts/.claude-skills/ship-commit.mjs');
});

test('affected path: no manifest → null (not checked), never a false negative', () => {
  assert.equal(validateAffectedPath('anything', null).recognised, null);
  assert.equal(validateAffectedPath('anything', { files: {} }).recognised, null);
});

// ── Bundle stamp ────────────────────────────────────────────────────────────

test('readBundleStamp: absent / malformed / null-sha manifests never throw', () => {
  const dir = mkTmp('ces-stamp-');
  try {
    assert.equal(readBundleStamp(dir), null, 'absent manifest');

    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts', '.sync-manifest.json'), '{not json');
    assert.equal(readBundleStamp(dir), null, 'malformed manifest');

    fs.writeFileSync(
      path.join(dir, 'scripts', '.sync-manifest.json'),
      JSON.stringify({ commitSha: null, generatedAt: '2026-07-31T00:00:00Z', files: {} }),
    );
    const s = readBundleStamp(dir);
    assert.equal(s.commitSha, null, 'a null sha reads as UNKNOWN, not as an error');
  } finally { rmTmp(dir); }
});

test('readBundleStamp: reads this repo-shaped manifest when present', () => {
  const dir = mkTmp('ces-stamp2-');
  try {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'scripts', '.sync-manifest.json'),
      JSON.stringify({ commitSha: SHA, generatedAt: '2026-07-31T00:00:00Z', files: { 'a.mjs': 'sha256:y' } }),
    );
    const s = readBundleStamp(dir);
    assert.equal(s.commitSha, SHA);
    assert.deepEqual(Object.keys(s.files), ['a.mjs']);
  } finally { rmTmp(dir); }
});

// ── Input validation ────────────────────────────────────────────────────────

test('report input: rejects empty body, oversize title, bad severity, escaping path', () => {
  const ok = { title: 't', body: 'b', severity: 'MEDIUM', affectedPath: 'scripts/x.mjs' };
  assert.deepEqual(validateReportInput(ok), []);

  assert.ok(validateReportInput({ ...ok, body: '   ' }).length, 'empty body rejected');
  assert.ok(validateReportInput({ ...ok, title: 'x'.repeat(201) }).length, 'oversize title rejected');
  assert.ok(validateReportInput({ ...ok, severity: 'medium' }).length, 'lowercase severity rejected');
  assert.ok(validateReportInput({ ...ok, affectedPath: '../../etc/passwd' }).length, 'path escape rejected');
  assert.ok(validateReportInput({ ...ok, affectedPath: '/abs/path' }).length, 'absolute path rejected');
});

// ── Outbox envelope ─────────────────────────────────────────────────────────

test('envelope: malformed / wrong-version / invalid payload all parse to null', () => {
  assert.equal(parseEnvelope('{not json'), null);
  assert.equal(parseEnvelope(JSON.stringify({ v: 999, fingerprint: 'f', payload: {} })), null);
  assert.equal(parseEnvelope(JSON.stringify({ v: OUTBOX_ENVELOPE_VERSION, fingerprint: '', payload: {} })), null);
  assert.equal(
    parseEnvelope(JSON.stringify({
      v: OUTBOX_ENVELOPE_VERSION, fingerprint: 'f',
      payload: { title: 't', body: 'b', severity: 'nope', affectedPath: 'p' },
    })),
    null,
    'an out-of-set severity is not a usable payload',
  );
});

test('drain: a poison envelope is quarantined, never deleted and never retried forever', async () => {
  const dir = mkTmp('ces-outbox-');
  try {
    const od = path.join(dir, '.audit', 'upstream-outbox');
    fs.mkdirSync(od, { recursive: true });
    fs.writeFileSync(path.join(od, 'bad.json'), '{corrupt');

    const res = await drainOutbox({ repoRoot: dir, recordFn: async () => ({ ok: true, cloud: true }) });
    assert.equal(res.rejected, 1);
    assert.equal(res.drained, 0);
    assert.ok(fs.existsSync(path.join(od, 'rejected', 'bad.json')), 'quarantined, not deleted');
    assert.ok(!fs.existsSync(path.join(od, 'bad.json')), 'removed from the active queue');
  } finally { rmTmp(dir); }
});

test('drain: a successful upsert removes the envelope; a failure leaves it', async () => {
  const dir = mkTmp('ces-outbox2-');
  try {
    const env = {
      v: OUTBOX_ENVELOPE_VERSION, fingerprint: 'fp1', repoUuid: null,
      payload: { title: 't', body: 'b', severity: 'LOW', affectedPath: 'scripts/x.mjs' },
      createdAt: new Date().toISOString(),
    };
    const file = writeEnvelope(dir, env);
    assert.ok(fs.existsSync(file));

    const fail = await drainOutbox({ repoRoot: dir, recordFn: async () => ({ ok: false }) });
    assert.equal(fail.failed, 1);
    assert.ok(fs.existsSync(file), 'a failed write must not lose the report');

    const good = await drainOutbox({ repoRoot: dir, recordFn: async () => ({ ok: true, cloud: true }) });
    assert.equal(good.drained, 1);
    assert.ok(!fs.existsSync(file));
  } finally { rmTmp(dir); }
});

test('drain: cloud-off (cloud:false) leaves the envelope for a later run', async () => {
  const dir = mkTmp('ces-outbox3-');
  try {
    const file = writeEnvelope(dir, {
      v: OUTBOX_ENVELOPE_VERSION, fingerprint: 'fp2', repoUuid: null,
      payload: { title: 't', body: 'b', severity: 'LOW', affectedPath: 'scripts/x.mjs' },
      createdAt: new Date().toISOString(),
    });
    const res = await drainOutbox({ repoRoot: dir, recordFn: async () => ({ ok: true, cloud: false }) });
    assert.equal(res.drained, 0);
    assert.ok(fs.existsSync(file), 'never discarded just because the store was unreachable');
  } finally { rmTmp(dir); }
});

test('drain: a missing outbox directory is a silent no-op', async () => {
  const dir = mkTmp('ces-outbox4-');
  try {
    const res = await drainOutbox({ repoRoot: dir, recordFn: async () => ({ ok: true, cloud: true }) });
    assert.deepEqual(res, { drained: 0, rejected: 0, failed: 0 });
  } finally { rmTmp(dir); }
});

// ── JS ↔ SQL lifecycle parity ───────────────────────────────────────────────

test('lifecycle: the JS transition map and the SQL CHECK declare the same states', () => {
  const sql = fs.readFileSync(
    path.join(REPO_ROOT, 'supabase', 'migrations', '20260731120000_upstream_issues.sql'),
    'utf-8',
  );
  const m = /state\s+TEXT NOT NULL DEFAULT 'open'\s*\n?\s*CHECK \(state IN \(([^)]*)\)\)/.exec(sql);
  assert.ok(m, 'could not locate the state CHECK constraint in the migration');
  const sqlStates = m[1].split(',').map((s) => s.trim().replace(/'/g, '')).sort();

  const jsStates = Object.keys(LEGAL_TRANSITIONS).sort();
  assert.deepEqual(
    jsStates, sqlStates,
    'the state set is declared in two places; adding one without the other is a runtime CHECK violation',
  );

  // Every destination the JS map can produce must also be a declared state.
  for (const [from, tos] of Object.entries(LEGAL_TRANSITIONS)) {
    for (const to of tos) {
      assert.ok(sqlStates.includes(to), `${from} → ${to} targets a state the DB does not allow`);
    }
  }
});

test('lifecycle: fixed and wont_fix are terminal', () => {
  assert.deepEqual(LEGAL_TRANSITIONS.fixed, []);
  assert.deepEqual(LEGAL_TRANSITIONS.wont_fix, []);
});

test('severity set matches the SQL CHECK', () => {
  const sql = fs.readFileSync(
    path.join(REPO_ROOT, 'supabase', 'migrations', '20260731120000_upstream_issues.sql'),
    'utf-8',
  );
  const m = /CHECK \(severity IN \(([^)]*)\)\)/.exec(sql);
  assert.ok(m, 'could not locate the severity CHECK');
  const sqlSev = m[1].split(',').map((s) => s.trim().replace(/'/g, '')).sort();
  assert.deepEqual([...VALID_SEVERITIES].sort(), sqlSev);
});

// ── Git adapter (impure, but the three-way outcome is load-bearing) ──────────
//
// `shaInHistory` must distinguish "in HEAD's history" / "genuinely not" /
// "could not tell". An audit round caught the original `rev-parse --verify`
// implementation collapsing the last two into `false`, which would have
// reported a broken checkout as the confident claim "that sha is not ours".

import { execSync } from 'node:child_process';
import { resolveGitFacts } from '../scripts/lib/upstream/commands.mjs';

const IN_GIT = fs.existsSync(path.join(REPO_ROOT, '.git'));

test('git facts: a real ancestor of HEAD resolves true',
  { skip: IN_GIT ? false : 'no .git' }, () => {
    const anc = execSync('git rev-parse HEAD~3', { cwd: REPO_ROOT, encoding: 'utf-8' }).trim();
    const f = resolveGitFacts({ reportedSha: anc, repoRoot: REPO_ROOT });
    assert.equal(f.shaInHistory, true);
    assert.ok(f.distanceAhead >= 3, 'distance is measured from the reported sha to HEAD');
  });

test('git facts: an unknown object yields null (cannot tell), never false',
  { skip: IN_GIT ? false : 'no .git' }, () => {
    const f = resolveGitFacts({ reportedSha: 'b'.repeat(40), repoRoot: REPO_ROOT });
    assert.equal(f.shaInHistory, null, 'an unresolvable object is unknown, not "not ours"');
  });

test('git facts: outside a checkout yields null, not a false negative', () => {
  const dir = mkTmp('ces-nogit-');
  try {
    const f = resolveGitFacts({ reportedSha: 'a'.repeat(40), repoRoot: dir });
    assert.equal(f.shaInHistory, null);
    assert.equal(f.distanceAhead, null);
  } finally { rmTmp(dir); }
});

test('git facts: a malformed sha short-circuits without touching git', () => {
  const f = resolveGitFacts({ reportedSha: 'not-a-sha', repoRoot: REPO_ROOT });
  assert.equal(f.shaInHistory, null);
  assert.equal(f.ancestry.size, 0);
});
