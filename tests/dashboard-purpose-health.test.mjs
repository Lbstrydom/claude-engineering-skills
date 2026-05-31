/**
 * @fileoverview Purpose Health telemetry section (dashboard v2 Part 3) —
 * renderer (pure: badge colour+label, escaping, empty/repo-wide states) and the
 * collector's graceful ENOENT path. Cloud-dependent counts are not unit-tested
 * here (they need a DB); the live E2E covers them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sectionPurposeHealth from '../scripts/lib/dashboard/sections/purpose-health.mjs';
import { buildUi } from '../scripts/lib/dashboard/helpers.mjs';
import { __test__ } from '../scripts/lib/dashboard/collect-telemetry.mjs';

const { collectPurposeHealth } = __test__;

function fixture(overrides = {}) {
  return {
    asOf: '2026-05-31T10:00:00.000Z',
    windowDays: 30,
    repoWide: { recentHighFindings: 3, plansWithFailingCriteria: 1, refusedSecrets: 0 },
    purposeBadges: [
      { id: 'preserve-trust-safety', label: 'Preserve trust & safety', health: 'ok', scope: 'purpose-specific', reason: '0 refused secret(s) in 30d' },
      { id: 'deliver-quality-audits', label: 'Deliver quality audits', health: 'na', scope: 'repo-wide-only', reason: 'repo-wide only — see summary' },
    ],
    ...overrides,
  };
}

// ── renderer ─────────────────────────────────────────────────────────────

test('renders repo-wide summary + per-purpose table', () => {
  const html = sectionPurposeHealth({ src: { status: 'ok', detail: '' }, purposeHealth: fixture() }, buildUi());
  assert.match(html, /3<\/strong> recent HIGH/);
  assert.match(html, /1<\/strong> plan\(s\) with failing P0\/P1/);
  assert.match(html, /Preserve trust &amp; safety/);
});

test('health is conveyed by TEXT label, not colour alone (WCAG 1.4.1)', () => {
  const html = sectionPurposeHealth({ src: { status: 'ok', detail: '' }, purposeHealth: fixture() }, buildUi());
  assert.match(html, /health-ok">🟢 ok/);
  assert.match(html, /health-na">⚪ n\/a/);
});

test('null repo-wide metrics render as — (em dash), never crash', () => {
  const html = sectionPurposeHealth({ src: { status: 'ok', detail: '' }, purposeHealth: fixture({ repoWide: { recentHighFindings: null, plansWithFailingCriteria: null, refusedSecrets: null } }) }, buildUi());
  assert.match(html, /<strong>—<\/strong> recent HIGH/);
});

test('escapes dynamic reason/label text', () => {
  const html = sectionPurposeHealth({ src: { status: 'ok', detail: '' }, purposeHealth: fixture({
    purposeBadges: [{ id: 'x', label: '<script>x</script>', health: 'na', scope: 'repo-wide-only', reason: 'a & "b"' }],
  }) }, buildUi());
  assert.doesNotMatch(html, /<script>x/);
  assert.match(html, /&lt;script&gt;/);
});

test('empty / missing-optional → non-error panel mentioning AUDIT_DB_URL', () => {
  const html = sectionPurposeHealth({ src: { status: 'missing-optional', detail: 'needs a cloud database connection (AUDIT_DB_URL)' }, purposeHealth: { asOf: '', windowDays: 30, repoWide: {}, purposeBadges: [] } }, buildUi());
  assert.match(html, /AUDIT_DB_URL/);
});

test('NON_OK source → warning panel', () => {
  const html = sectionPurposeHealth({ src: { status: 'unexpected-error', detail: 'boom' }, purposeHealth: fixture() }, buildUi());
  assert.match(html, /unexpected-error/);
});

// ── collector ENOENT path (no cloud needed) ──────────────────────────────

test('collectPurposeHealth on a root with no domain-map → missing-optional (ENOENT, graceful)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = await collectPurposeHealth(root);
  assert.equal(r.status.status, 'missing-optional');
  assert.deepEqual(r.data.purposeBadges, []);
});

// ── M22: repo-scoping is a correctness invariant (shared multi-tenant DB) ──

test('all purpose-health queries are repo-scoped + ::int cast + windowed', () => {
  const src = fs.readFileSync(new URL('../scripts/lib/store/purpose-health.mjs', import.meta.url), 'utf-8');
  // audit_findings⋈audit_runs scoped via r.repo_id; plans via p.repo_id; events via repo_id.
  assert.match(src, /r\.repo_id = \$1/);          // recentHighFindings
  assert.match(src, /p\.repo_id = \$1/);          // plansWithFailingCriteria
  assert.match(src, /WHERE repo_id = \$1[\s\S]*?event_kind = 'refused_secret'/); // refusedSecrets
  // bigint → int so the Zod number boundary doesn't crash on a pg string —
  // both count shapes used by the 3 queries carry the cast.
  assert.match(src, /count\(\*\)::int/);
  assert.match(src, /count\(DISTINCT i\.plan_id\)::int/);
  // every count query bounds the window (one interval predicate per query).
  assert.equal((src.match(/now\(\) - \(\$2 \* interval '1 day'\)/g) || []).length, 3);
});

test('windowDays is clamped to a positive integer range', async () => {
  // The clamp is internal; assert the source pins [1,365] floor (no DB needed).
  const src = fs.readFileSync(new URL('../scripts/lib/store/purpose-health.mjs', import.meta.url), 'utf-8');
  assert.match(src, /Math\.max\(1, Math\.min\(365, raw\)\)/);
});
