/**
 * @fileoverview Tier-1 tests for the friction store seam + breadcrumb.
 * Plan: friction-feedback-loop.md §9. DB-free: the jsonb/pgArray serialization is
 * guarded via the `_builders` seam (the M3 regression class for THIS table), and
 * `reconcileTombstones` safety guards are pure. The generated `resolved` column +
 * upsert idempotency are DB-side and covered by the empirical verify (the doctrine
 * for any new analyzer) — asserting them here would test a mock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _builders } from '../scripts/lib/db/query.mjs';
import { reconcileTombstones, buildFrictionUpsertPayload } from '../scripts/lib/store/friction.mjs';
import { appendInjected, readRecent, breadcrumbPath } from '../scripts/lib/friction/breadcrumb.mjs';

const { buildUpsert } = _builders;

// ── M3 jsonb/pgArray seam for memory_friction (REAL code path — audit M16) ────
// Drives the actual `buildFrictionUpsertPayload` (not a hand-rebuilt copy), so a
// drift in the real redact/pgArray/jsonb assembly fails this test.
test('buildFrictionUpsertPayload → buildUpsert: jsonb raw, text[] via pgArray, secrets redacted', () => {
  const payload = buildFrictionUpsertPayload('r1', {
    memory_name: 'm', source_hash: 'h',
    title: 'leak sk-abc1234567890ABCDEFGHIJKLMNOPQRSTUV here',   // secret → must be redacted
    body_excerpt: 'b',
    scope_tags: ['false-green'],
    files: ['.env', 'scripts/ok.mjs'],                            // .env → must be dropped
    symbols: ['fn'],
    cost: 'M', fingerprint: 'f', trgm_text: 'x', signature_text: 'y',
    mitigation_refs: [{ kind: 'commit', ref: 'abc' }],
  }, { now: '2026-06-28T00:00:00.000Z' });

  // redaction happened on the REAL path
  assert.ok(!payload.title.includes('sk-abc1234567890ABCDEFGHIJKLMNOPQRSTUV'));
  assert.match(payload.title, /REDACTED/);
  // sensitive file dropped (pgArray-wrapped → .value holds the raw array)
  assert.deepEqual(payload.files.value, ['scripts/ok.mjs']);

  const { params } = buildUpsert('memory_friction', [payload], { onConflict: ['repo_id', 'memory_name'], update: 'all' });
  // mitigation_refs is a plain array → JSON-serialized (jsonb-safe)
  assert.ok(params.includes('[{"kind":"commit","ref":"abc"}]'));
  // scope_tags / symbols wrapped in pgArray → stay raw JS arrays (genuine text[])
  assert.ok(params.some((p) => Array.isArray(p) && p[0] === 'false-green'));
  assert.ok(params.some((p) => Array.isArray(p) && p[0] === 'fn'));
});

test('buildFrictionUpsertPayload requires repoId + validates the row (store boundary)', () => {
  assert.throws(() => buildFrictionUpsertPayload(null, {}), /repoId is required/);
  assert.throws(() => buildFrictionUpsertPayload('r1', { memory_name: 'm' }), /./);  // schema rejects incomplete row
});

// ── reconcileTombstones: C5 safety (pure, pre-cloud guards) ───────────────────
test('reconcileTombstones REFUSES to tombstone on an incomplete scan', async () => {
  const r = await reconcileTombstones({ repoId: 'r1', seenNames: [], scanComplete: false });
  assert.deepEqual(r, { tombstoned: 0, skipped: 'incomplete-scan' });
});

test('reconcileTombstones requires repoId', async () => {
  await assert.rejects(() => reconcileTombstones({ seenNames: [], scanComplete: true }), /repoId is required/);
});

// ── breadcrumb: append / prune / readRecent dedup ────────────────────────────
function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'friction-bc-')); }

test('appendInjected writes the C8 line schema (never a body)', async () => {
  const root = tmpRoot();
  const res = await appendInjected({ memory_name: 'friction-a', title: 'A title', repo_id: 'r1' }, { repoRoot: root, now: 1000 });
  assert.equal(res.ok, true);
  const raw = fs.readFileSync(breadcrumbPath(root), 'utf8').trim();
  const obj = JSON.parse(raw);
  assert.deepEqual(Object.keys(obj).sort(), ['memory_name', 'repo_id', 'title', 'ts']);
  assert.equal(obj.ts, 1000);
});

test('appendInjected prunes entries older than the TTL horizon', async () => {
  const root = tmpRoot();
  const dayMs = 24 * 60 * 60 * 1000;
  const now = 100 * dayMs;
  // an ancient entry (well past the default 7-day TTL) then a fresh one
  await appendInjected({ memory_name: 'old', title: 'old' }, { repoRoot: root, now: now - 30 * dayMs });
  await appendInjected({ memory_name: 'new', title: 'new' }, { repoRoot: root, now });
  const lines = fs.readFileSync(breadcrumbPath(root), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.memory_name), ['new']);   // old pruned
});

test('readRecent filters by window + dedups by memory_name (most recent kept)', async () => {
  const root = tmpRoot();
  await appendInjected({ memory_name: 'dup', title: 'first' }, { repoRoot: root, now: 5000 });
  await appendInjected({ memory_name: 'dup', title: 'second' }, { repoRoot: root, now: 6000 });
  await appendInjected({ memory_name: 'other', title: 'o' }, { repoRoot: root, now: 7000 });
  const recent = readRecent(6000, { repoRoot: root });
  // 'dup' first injected at 5000 is below window but its 6000 line qualifies;
  // dedup keeps the most recent 'dup' line (title 'second').
  const dup = recent.find((r) => r.memory_name === 'dup');
  assert.equal(dup.title, 'second');
  assert.ok(recent.find((r) => r.memory_name === 'other'));
});

test('readRecent on an absent breadcrumb → [] (graceful)', () => {
  const recent = readRecent(0, { repoRoot: path.join(os.tmpdir(), 'no-bc-here-zzz') });
  assert.deepEqual(recent, []);
});
