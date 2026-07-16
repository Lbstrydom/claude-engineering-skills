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
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
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
  // every count query bounds the window (one interval predicate per query) —
  // 4 now: recentHigh, plansFailing, refusedSecrets, + v3 highByFile.
  assert.equal((src.match(/now\(\) - \(\$2 \* interval '1 day'\)/g) || []).length, 4);
  // v3 highByFile: repo-scoped (r.repo_id) + grouped by file.
  assert.match(src, /GROUP BY f\.primary_file/);
});

test('windowDays is clamped to a positive integer range', async () => {
  // The clamp is internal; assert the source pins [1,365] floor (no DB needed).
  const src = fs.readFileSync(new URL('../scripts/lib/store/purpose-health.mjs', import.meta.url), 'utf-8');
  assert.match(src, /Math\.max\(1, Math\.min\(365, raw\)\)/);
});

// ── v3 Part A: pure attribution + classifier ──────────────────────────────

const { attributeHighByFile, classifyPurposeBadges } = __test__;
const A_RULES = [
  { pattern: 'a/**', domain: 'da' },
  { pattern: 'b/**', domain: 'db' },
];
const A_DP = { da: ['p1'], db: ['p1', 'p2'] };   // db serves two purposes
const A_PIDS = ['p1', 'p2', 'preserve-trust-safety'];

test('attributeHighByFile: tags files → domains → purposes; multi-purpose counts each', () => {
  const r = attributeHighByFile([
    { file: 'a/x.mjs', n: 2 },   // da → p1
    { file: 'b/y.mjs', n: 1 },   // db → p1 AND p2
  ], { rules: A_RULES, domainPurposesCfg: A_DP, purposeIds: A_PIDS });
  assert.equal(r.attributionAvailable, true);
  assert.equal(r.highTally.p1, 3);   // 2 + 1
  assert.equal(r.highTally.p2, 1);
  assert.equal(r.unattributable, 0);
});

test('attributeHighByFile: null file / non-path / no-purpose domain → unattributable', () => {
  const r = attributeHighByFile([
    { file: null, n: 1 },           // null → unattributable
    { file: 'Structure', n: 1 },    // section-name, no rule match → unattributable
    { file: 'zzz/none.mjs', n: 2 }, // matches no rule → unattributable
  ], { rules: A_RULES, domainPurposesCfg: A_DP, purposeIds: A_PIDS });
  assert.equal(r.unattributable, 4);
  assert.equal(r.highTally.p1, 0);
});

test('attributeHighByFile: a sensitive file is skipped (never attributed)', () => {
  const r = attributeHighByFile([{ file: '.env', n: 3 }], { rules: A_RULES, domainPurposesCfg: A_DP, purposeIds: A_PIDS });
  assert.equal(r.unattributable, 3);
  assert.equal(r.highTally.p1, 0);
});

test('attributeHighByFile: null highByFile → attribution unavailable', () => {
  const r = attributeHighByFile(null, { rules: A_RULES, domainPurposesCfg: A_DP, purposeIds: A_PIDS });
  assert.equal(r.attributionAvailable, false);
  assert.equal(r.unattributable, null);
});

const PURPS = [
  { id: 'p1', label: 'P1' },
  { id: 'preserve-trust-safety', label: 'Trust' },
  { id: 'empty', label: 'Empty' },
];

test('classifier: HIGH in a purpose domain → at-risk; clean → ok; no domains → na', () => {
  const b = classifyPurposeBadges({
    purposes: PURPS,
    domainCountByPurpose: { p1: 2, 'preserve-trust-safety': 1, empty: 0 },
    highTally: { p1: 2, 'preserve-trust-safety': 0, empty: 0 },
    refusedSecrets: 0, attributionAvailable: true,
  });
  const by = Object.fromEntries(b.map((x) => [x.id, x]));
  assert.equal(by.p1.health, 'at-risk');
  assert.equal(by['preserve-trust-safety'].health, 'ok');
  assert.equal(by.empty.health, 'na');           // no domains → na, not false ok
});

test('classifier: trust-safety stays on refusedSecrets when HIGH attribution unavailable', () => {
  const b = classifyPurposeBadges({
    purposes: PURPS,
    domainCountByPurpose: { p1: 2, 'preserve-trust-safety': 1, empty: 0 },
    highTally: { p1: 0, 'preserve-trust-safety': 0, empty: 0 },
    refusedSecrets: 2, attributionAvailable: false,    // HIGH unavailable, secrets available
  });
  const by = Object.fromEntries(b.map((x) => [x.id, x]));
  assert.equal(by.p1.health, 'na');                       // HIGH-only purpose → na
  assert.equal(by['preserve-trust-safety'].health, 'at-risk'); // still judged on secrets
});

test('classifier: trust-safety na only when BOTH signals unavailable', () => {
  const b = classifyPurposeBadges({
    purposes: PURPS, domainCountByPurpose: { 'preserve-trust-safety': 1, p1: 1, empty: 0 },
    highTally: { 'preserve-trust-safety': 0, p1: 0, empty: 0 },
    refusedSecrets: null, attributionAvailable: false,
  });
  assert.equal(b.find((x) => x.id === 'preserve-trust-safety').health, 'na');
});

test('attributeHighByFile: a duplicate pid in a domain array counts ONCE (no double-count)', () => {
  const r = attributeHighByFile([{ file: 'a/x.mjs', n: 2 }],
    { rules: A_RULES, domainPurposesCfg: { da: ['p1', 'p1'] }, purposeIds: A_PIDS });
  assert.equal(r.highTally.p1, 2);   // not 4
});
