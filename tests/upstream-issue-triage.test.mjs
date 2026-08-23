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
  parseEnvelope, writeEnvelope, drainOutbox, upstreamTransition,
  OUTBOX_ENVELOPE_VERSION, VALID_SEVERITIES,
} from '../scripts/lib/upstream/commands.mjs';
import { LEGAL_TRANSITIONS, listUpstreamIssues } from '../scripts/lib/store/upstream-issues.mjs';

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

test('freshness: shaInHistory null/undefined (ancestry check errored) is UNKNOWN, not current/stale (closes round-5 audit M11)', () => {
  // resolveGitFacts deliberately leaves shaInHistory:null when the ancestry
  // check itself failed to run — "unknown, not absent" (its own comment).
  // This used to fall through to the distance-based verdict just like
  // sourceDirty:null did before round-3 M13.
  for (const v of [null, undefined]) {
    const r = classifyReportFreshness({
      reportedSha: SHA, shaInHistory: v, distanceAhead: 4, sourceDirty: false,
    });
    assert.equal(r.verdict, 'unknown', `shaInHistory=${v} must be unknown, not stale/current`);
    assert.equal(r.reason, 'sha-history-unverified');
  }
});

test('freshness: a non-numeric or negative distanceAhead is unknown, not current (closes round-6 audit M2)', () => {
  for (const bad of [NaN, 'not-a-number', -5, -0.5]) {
    const r = classifyReportFreshness({
      reportedSha: SHA, shaInHistory: true, distanceAhead: bad, sourceDirty: false,
    });
    assert.equal(r.verdict, 'unknown', `distanceAhead=${bad} must be unknown, not current/stale`);
    assert.equal(r.reason, 'distance-invalid');
  }
});

test('freshness: git unavailable → unknown, NOT current', () => {
  const r = classifyReportFreshness({
    reportedSha: SHA, shaInHistory: true, distanceAhead: null, sourceDirty: false,
  });
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reason, 'git-unavailable');
});

// The 2026-08-01 incident, as an executable case. A consumer report was stamped
// 10 commits behind while running code from a commit that did not yet exist:
// another session's uncommitted work had been synced 30 minutes earlier, and
// the manifest stamps HEAD while the sync ships working-tree bytes. The verdict
// said `stale/behind-head`, which reads as "re-sync and it goes away", and a
// real report was nearly dismissed on that basis.
test('freshness: a dirty source tree makes the distance unusable, not just imprecise', () => {
  const r = classifyReportFreshness({
    reportedSha: SHA, shaInHistory: true, distanceAhead: 10, ageDays: 0, sourceDirty: true,
  });
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reason, 'source-tree-dirty');
  assert.equal(r.distanceAhead, 10,
    'the measurement is still reported — only the verdict built on it is refused');
});

test('freshness: dirty at distance 0 is NOT current — the bundle may be AHEAD of its stamp', () => {
  // The subtle half. `distanceAhead === 0` normally means "at HEAD", but a
  // dirty sync can put the consumer ahead of the sha it was stamped with, so
  // there is no direction in which the verdict is safe.
  const r = classifyReportFreshness({
    reportedSha: SHA, shaInHistory: true, distanceAhead: 0, sourceDirty: true,
  });
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reason, 'source-tree-dirty');
});

test('freshness: sourceDirty === false (confirmed clean) uses the distance-based verdict', () => {
  const r = classifyReportFreshness({
    reportedSha: SHA, shaInHistory: true, distanceAhead: 4, sourceDirty: false,
  });
  assert.equal(r.verdict, 'stale');
  assert.equal(r.reason, 'behind-head');
});

test('freshness: sourceDirty null/absent is UNKNOWN provenance, not "clean" (closes round-3 audit M13)', () => {
  // Every manifest published before the field existed reads null here. This
  // used to fall through to the distance-based verdict (the exact bug this
  // test previously enshrined as correct) — an unverified provenance report
  // could read `current`. readBundleStamp's own docstring: "absence must
  // never read as clean" — this is the caller-side half of that contract.
  for (const v of [null, undefined]) {
    const r = classifyReportFreshness({
      reportedSha: SHA, shaInHistory: true, distanceAhead: 4, sourceDirty: v,
    });
    assert.equal(r.verdict, 'unknown', `sourceDirty=${v} must be unknown, not stale/current`);
    assert.equal(r.reason, 'source-dirty-unknown');
  }
});

test('freshness: behind HEAD → stale, carrying distance and age', () => {
  const r = classifyReportFreshness({
    reportedSha: SHA, shaInHistory: true, distanceAhead: 28, ageDays: 3, sourceDirty: false,
  });
  assert.equal(r.verdict, 'stale');
  assert.equal(r.distanceAhead, 28);
  assert.equal(r.ageDays, 3);
});

test('freshness: at HEAD with confirmed-clean provenance → current', () => {
  const r = classifyReportFreshness({
    reportedSha: SHA, shaInHistory: true, distanceAhead: 0, sourceDirty: false,
  });
  assert.equal(r.verdict, 'current');
});

test('freshness: age alone never makes a verdict — no invented staleness threshold', () => {
  const r = classifyReportFreshness({
    reportedSha: SHA, shaInHistory: true, distanceAhead: 0, ageDays: 9999, sourceDirty: false,
  });
  assert.equal(r.verdict, 'current', 'a very old bundle that is still at HEAD is current');
  assert.equal(r.ageDays, 9999, 'age is reported…');
});

// ── listUpstreamIssues: the `before` cursor is all-or-nothing (round-3 audit M17) ──
//
// A fake, unreachable DSN is enough here: the partial-cursor check returns
// before any query is issued, so no real DB connection is ever attempted.
// Same technique as tests/mark-findings-remediation.test.mjs's DB-error path.

test('listUpstreamIssues rejects a PARTIAL before cursor (createdAt with no id) rather than silently paging from the top', async () => {
  const prev = process.env.AUDIT_DB_URL;
  process.env.AUDIT_DB_URL = 'postgresql://nobody@127.0.0.1:1/nonexistent';
  try {
    const r = await listUpstreamIssues({ before: { createdAt: '2026-01-01T00:00:00Z' } });
    assert.equal(r.ok, false);
    assert.match(r.error, /before cursor must have both/);
  } finally {
    if (prev === undefined) delete process.env.AUDIT_DB_URL; else process.env.AUDIT_DB_URL = prev;
  }
});

test('listUpstreamIssues rejects a PARTIAL before cursor (id with no createdAt)', async () => {
  const prev = process.env.AUDIT_DB_URL;
  process.env.AUDIT_DB_URL = 'postgresql://nobody@127.0.0.1:1/nonexistent';
  try {
    const r = await listUpstreamIssues({ before: { id: 'aaaaaaaa-1111-2222-3333-444444444444' } });
    assert.equal(r.ok, false);
    assert.match(r.error, /before cursor must have both/);
  } finally {
    if (prev === undefined) delete process.env.AUDIT_DB_URL; else process.env.AUDIT_DB_URL = prev;
  }
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

test('drain: a missing outbox directory reports EMPTY, not just zeroes', async () => {
  // Contract widened 2026-08-11 (docs/plans/audit-store-write-durability.md,
  // decision 1e): the counters keep their meaning, and a discriminated `state`
  // is added. It used to return the same `{drained:0,rejected:0,failed:0}` for
  // "nothing to do" and for "I could not read the directory" — the vacuous-pass
  // shape. `empty` is the assertion; the sibling test below is the other half.
  const dir = mkTmp('ces-outbox4-');
  try {
    const res = await drainOutbox({ repoRoot: dir, recordFn: async () => ({ ok: true, cloud: true }) });
    assert.deepEqual(res, { state: 'empty', drained: 0, rejected: 0, failed: 0 });
  } finally { rmTmp(dir); }
});

test('drain: an UNREADABLE outbox is unavailable, never a clean zero', async () => {
  // The negative control for the test above. Without it, "empty" and "broken"
  // are still one state as far as the suite is concerned.
  const dir = mkTmp('ces-outbox5-');
  try {
    // A regular FILE where the outbox directory should be: readdir fails with
    // ENOTDIR, which is the readable stand-in for a permissions failure and
    // behaves identically on Windows and POSIX.
    const outbox = path.join(dir, '.audit', 'upstream-outbox');
    fs.mkdirSync(path.dirname(outbox), { recursive: true });
    fs.writeFileSync(outbox, 'not a directory');

    const res = await drainOutbox({ repoRoot: dir, recordFn: async () => ({ ok: true, cloud: true }) });
    assert.equal(res.state, 'unavailable', 'an unreadable outbox must not report empty');
    assert.match(res.reason, /readdir failed/);
    assert.equal(res.drained, 0);
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

// ── --id shape validation (upstreamTransition) ───────────────────────────────
//
// `upstream_issues.id` is a uuid column, so a non-uuid --id used to reach
// Postgres and return `invalid input syntax for type uuid: "96a829f8"` wrapped
// in code EXCEPTION — a database type error presented as an unhandled fault
// when it was really a malformed argument. Hit live 2026-08-10 pasting a short
// id off a rendered card, which is also why prefixes are now accepted.
//
// The wildcard rows are the load-bearing ones: the store resolves a prefix with
// `id::text LIKE $1 || '%'`, and LIKE reads `%` and `_` as wildcards. They live
// in the DATA, so parameterisation does not neutralise them — an unfiltered `%`
// would match every issue and then "resolve" to whichever sorted first.
// `transitionFn` throws here: reaching the store at all is the failure.
const REJECT_ID = () => { throw new Error('store must not be reached for a malformed --id'); };

for (const [label, id] of [
  ['non-hex', 'zzz'],
  ['a LIKE percent wildcard', '%'],
  ['a LIKE underscore wildcard', '________'],
  ['percent smuggled after valid hex', '96a829f8%'],
  ['too short to disambiguate', '897aa6'],
  ['an empty string', ''],
]) {
  test(`upstreamTransition rejects ${label} without touching the store`, async () => {
    const res = await upstreamTransition({
      id, to: 'acknowledged', transitionFn: REJECT_ID, repoRoot: REPO_ROOT,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'BAD_INPUT');
  });
}

test('upstreamTransition passes a valid prefix through, normalised', async () => {
  // Vacuous-pass guard for the block above: if the regex rejected everything,
  // those tests would all pass while the command was simply broken.
  let seen = null;
  const res = await upstreamTransition({
    id: '  96A829F8  ', to: 'acknowledged', repoRoot: REPO_ROOT,
    transitionFn: (a) => { seen = a; return { ok: true, cloud: true }; },
  });
  assert.equal(res.ok, true, 'a legal 8-hex prefix must reach the store');
  assert.equal(seen.id, '96a829f8', 'trimmed + lowercased before the LIKE match');
});

test('upstreamTransition accepts a full uuid unchanged', async () => {
  let seen = null;
  await upstreamTransition({
    id: '96a829f8-d2b9-457a-b5ab-530b5530dad8', to: 'acknowledged', repoRoot: REPO_ROOT,
    transitionFn: (a) => { seen = a; return { ok: true, cloud: true }; },
  });
  assert.equal(seen.id, '96a829f8-d2b9-457a-b5ab-530b5530dad8');
});

// ── renderWorksheet: path_recognised is a TRI-state ───────────────────────────
//
// Consumers are told to check this field, so the worksheet must not collapse
// `null` ("no manifest — nothing was checked") into `true` ("checked, and it
// is upstream-owned"). Reported by Lbstrydom/wine-cellar-app 2026-08-11: a
// report filed with a CORRECT consumer-relative bundle key still landed
// `path_recognised: null`, and the worksheet rendered it identically to a
// verified path. The null case is the common one — the sync manifest is
// gitignored in consumers, so any un-resynced clone reports null.

import { renderWorksheet } from '../scripts/lib/upstream/commands.mjs';

const worksheetRow = (pathRecognised) => renderWorksheet([{
  id: '96a829f8-d2b9-457a-b5ab-530b5530dad8',
  severity: 'MEDIUM',
  title: 'T',
  repo_name: 'owner/repo',
  affected_path: 'scripts/.claude-skills/x.mjs',
  path_recognised: pathRecognised,
  freshness: { verdict: 'unknown', reason: 'no-stamp', distanceAhead: null, ageDays: null },
  priorFixes: [],
}]).split('\n').find((l) => l.trim().startsWith('path '));

test('worksheet: path_recognised true → no ownership caveat', () => {
  const line = worksheetRow(true);
  assert.ok(line, 'subject probe: the path row must render');
  assert.doesNotMatch(line, /unverified|NOT an upstream-owned/);
});

test('worksheet: path_recognised false → says NOT upstream-owned', () => {
  assert.match(worksheetRow(false), /NOT an upstream-owned synced file/);
});

test('worksheet: path_recognised null → says unverified, never silent', () => {
  const line = worksheetRow(null);
  assert.match(line, /ownership unverified/);
  // The load-bearing assertion: null must not read like true.
  assert.notEqual(line, worksheetRow(true));
});

// ── Provenance survives being invoked from a subdirectory ────────────────────
//
// Root cause of the "path_recognised stays null on a correctly-keyed report"
// defect (Lbstrydom/wine-cellar-app, 2026-08-11). `cross-skill.mjs upstream`
// derived repoRoot from process.cwd(), so running it from any subdirectory
// silently lost the sync manifest — and with it bundle_sha, generated_at and
// path_recognised. The degraded result is indistinguishable from "this
// consumer has no manifest", which is why it read as a benign tri-state
// instead of a bug.

import { findRepoRootFromCwd } from '../scripts/lib/assert-repo-root.mjs';

test('repoRoot resolution: a subdirectory resolves to the repo root', () => {
  const root = findRepoRootFromCwd(REPO_ROOT);
  const fromSub = findRepoRootFromCwd(path.join(REPO_ROOT, 'scripts', 'lib'));
  assert.equal(
    path.resolve(fromSub), path.resolve(root),
    'a nested cwd must resolve to the same repo root, or provenance is lost',
  );
});

test('bundle stamp: found via the resolver, lost via a raw cwd', () => {
  // Hermetic fixture — deliberately NOT this repo. The sync manifest is
  // gitignored, so asserting against it would pass here and fail in the
  // clean pre-push worktree, where no manifest exists (sandbox-honesty rule).
  const dir = mkTmp('upstream-root-');
  try {
    execSync('git init', { cwd: dir, stdio: 'ignore' });
    const root = fs.realpathSync(dir);
    fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'scripts', '.sync-manifest.json'),
      JSON.stringify({
        commitSha: SHA, generatedAt: '2026-08-11T16:52:06.798Z', sourceDirty: false,
        files: { 'scripts/.claude-skills/persona-consistency-promote.mjs': 'abc' },
      }),
    );
    const sub = path.join(root, 'scripts', 'lib');

    // Negative control — the exact pre-fix behaviour. Kept so the assertion
    // below cannot go vacuous if readBundleStamp ever walks up on its own.
    assert.equal(
      readBundleStamp(sub), null,
      'readBundleStamp takes a repo ROOT; a raw subdir must not resolve',
    );
    // Subject probe + the fix: resolve first, then read.
    const viaResolver = readBundleStamp(findRepoRootFromCwd(sub));
    assert.ok(viaResolver, 'subject probe: the fixture manifest must be findable');
    assert.equal(viaResolver.commitSha, SHA);

    // The consumer-visible consequence: ownership goes from unverifiable to true.
    const key = 'scripts/.claude-skills/persona-consistency-promote.mjs';
    assert.equal(validateAffectedPath(key, readBundleStamp(sub)).recognised, null);
    assert.equal(validateAffectedPath(key, viaResolver).recognised, true);
  } finally {
    rmTmp(dir);
  }
});
