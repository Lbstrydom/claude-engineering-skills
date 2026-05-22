/**
 * @fileoverview Regression tests for the 4 Gemini follow-up findings
 * discovered during /audit-code of the observed-deps PR (2026-05-22).
 *
 * Covered:
 *   - getRefreshRun: column allowlist rejects unknown columns
 *   - discoverPlans: chronological sort across mixed date formats
 *   - isSafeGitRevision: rejects leading hyphen (argument-injection guard)
 *   - listPrunableRefreshRuns: documented-as-global JSDoc note present
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── getRefreshRun column allowlist ──────────────────────────────────────────

test('getRefreshRun: known columns accepted; unknown columns throw', async () => {
  const mod = await import('../scripts/lib/store/arch-memory.mjs');
  // Cloud disabled in test env → known-good path returns null silently.
  const ok = await mod.getRefreshRun('some-id', { select: ['walk_start_commit', 'walk_end_commit'] });
  assert.equal(ok, null);

  // Unknown column must throw with the column name in the message.
  await assert.rejects(
    () => mod.getRefreshRun('some-id', { select: ['walk_start_commit', 'evil"--'] }),
    /unknown column.*evil/i,
  );
  await assert.rejects(
    () => mod.getRefreshRun('some-id', { select: ['nonexistent_field'] }),
    /unknown column.*nonexistent_field/i,
  );
});

test('getRefreshRun: non-string select entries rejected', async () => {
  const mod = await import('../scripts/lib/store/arch-memory.mjs');
  await assert.rejects(
    () => mod.getRefreshRun('some-id', { select: [42, null] }),
    /unknown column/i,
  );
});

// ── discoverPlans chronological sort ────────────────────────────────────────

function makePlanFixture(date) {
  return `# Plan: Test\n- **Date**: ${date}\n- **Status**: Draft\n\n## Body\nx\n`;
}

test('discoverPlans: parses mixed date formats chronologically', async () => {
  const { discoverPlans } = await import('../scripts/lib/dashboard/collect-reference.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discoverplans-'));
  fs.mkdirSync(path.join(root, 'docs', 'plans'), { recursive: true });

  // Three plans with three different date formats — chronologically:
  //   2025-01-15 (oldest) < May 1, 2026 < 2026-05-22 (newest)
  // A naive String.localeCompare would order them: "2025-01-15", "2026-05-22",
  // "May 1, 2026" — wrong (May... sorts AFTER 2026... lexically).
  fs.writeFileSync(path.join(root, 'docs/plans/a.md'), makePlanFixture('2025-01-15'));
  fs.writeFileSync(path.join(root, 'docs/plans/b.md'), makePlanFixture('2026-05-22'));
  fs.writeFileSync(path.join(root, 'docs/plans/c.md'), makePlanFixture('May 1, 2026'));

  const result = discoverPlans(root);
  // Expected order (newest first): 2026-05-22, May 1, 2026, 2025-01-15
  const paths = result.active.map((p) => p.path);
  assert.deepEqual(paths, [
    'docs/plans/b.md',          // 2026-05-22
    'docs/plans/c.md',          // May 1, 2026
    'docs/plans/a.md',          // 2025-01-15
  ]);
});

test('discoverPlans: unparseable dates sort to the bottom', async () => {
  const { discoverPlans } = await import('../scripts/lib/dashboard/collect-reference.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discoverplans-bad-'));
  fs.mkdirSync(path.join(root, 'docs', 'plans'), { recursive: true });

  fs.writeFileSync(path.join(root, 'docs/plans/a.md'), makePlanFixture('2026-05-22'));
  fs.writeFileSync(path.join(root, 'docs/plans/b.md'), makePlanFixture('not-a-date'));

  const result = discoverPlans(root);
  const paths = result.active.map((p) => p.path);
  assert.deepEqual(paths, ['docs/plans/a.md', 'docs/plans/b.md']);
  // The unparseable one is flagged malformed
  const bad = result.active.find((p) => p.path === 'docs/plans/b.md');
  assert.equal(bad.malformed, true);
});

test('discoverPlans: two unparseable dates do NOT return NaN from comparator (Gemini-G1)', async () => {
  // Regression: -Infinity - (-Infinity) = NaN, which would violate the
  // Array.sort contract and produce non-deterministic ordering. With the
  // fix (comparison operators instead of subtraction), two unparseable
  // dates compare equal on the timestamp axis and fall through to the
  // path tiebreaker for a stable, deterministic order.
  const { discoverPlans } = await import('../scripts/lib/dashboard/collect-reference.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discoverplans-nan-'));
  fs.mkdirSync(path.join(root, 'docs', 'plans'), { recursive: true });

  // Three plans, all with unparseable dates → all three hit the
  // -Infinity branch; sort must remain stable. NOTE: avoid strings ending
  // in `-N` because Date.parse will interpret them as date fragments
  // (e.g. "garbage-1" → a real timestamp via heuristic parsing). Use
  // pure-alpha gibberish to guarantee NaN.
  fs.writeFileSync(path.join(root, 'docs/plans/zeta.md'),  makePlanFixture('totallygarbagezeta'));
  fs.writeFileSync(path.join(root, 'docs/plans/alpha.md'), makePlanFixture('totallygarbagealpha'));
  fs.writeFileSync(path.join(root, 'docs/plans/mid.md'),   makePlanFixture('totallygarbagemid'));

  const result = discoverPlans(root);
  // All unparseable → tiebreaker is path.localeCompare (asc): alpha, mid, zeta
  const paths = result.active.map((p) => p.path);
  assert.deepEqual(paths, [
    'docs/plans/alpha.md',
    'docs/plans/mid.md',
    'docs/plans/zeta.md',
  ]);
});

// ── isSafeGitRevision argument-injection guard ──────────────────────────────
// isSafeGitRevision is a private function in scripts/symbol-index/refresh.mjs;
// we test the contract via string-matching the regex in the source. Pulling
// in the whole refresh.mjs would initialise the learning store etc.

test('isSafeGitRevision: regex source rejects leading hyphen (Gemini-R4-G1)', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/symbol-index/refresh.mjs'), 'utf-8');
  // The fixed regex is: /^[A-Za-z0-9._\/@{}~^][A-Za-z0-9._\/@{}~^-]*$/
  // The unfixed regex was: /^[A-Za-z0-9._\/@{}~^-]+$/  (note the - inside the +)
  // The fix splits into a first-char class (no `-`) and a tail class (with `-`).
  const fixedRe = /\/\^\[A-Za-z0-9\._\\\/@\{\}~\^\]\[A-Za-z0-9\._\\\/@\{\}~\^-\]\*\$\//;
  assert.match(src, fixedRe);

  // Inline behaviour check: evaluate the regex against safe + unsafe inputs.
  const re = /^[A-Za-z0-9._\/@{}~^][A-Za-z0-9._\/@{}~^-]*$/;
  // Safe revspecs
  assert.equal(re.test('HEAD'), true);
  assert.equal(re.test('HEAD~3'), true);
  assert.equal(re.test('main'), true);
  assert.equal(re.test('origin/main'), true);
  assert.equal(re.test('abc1234'), true);
  assert.equal(re.test('v1.2.3'), true);
  assert.equal(re.test('feature-branch'), true);    // hyphen mid-string still OK
  assert.equal(re.test('@{upstream}'), true);
  // Unsafe: leading hyphen would let git treat input as an option flag.
  assert.equal(re.test('--output=/tmp/pwned'), false);
  assert.equal(re.test('-rf'), false);
  assert.equal(re.test('--help'), false);
});

// ── listPrunableRefreshRuns global-by-design JSDoc note ─────────────────────

test('listPrunableRefreshRuns: GLOBAL BY DESIGN JSDoc note is present', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/lib/store/arch-memory.mjs'), 'utf-8');
  // The note documents design intent so a future audit doesn't "fix" the
  // missing repo_id predicate without understanding the prune policy.
  assert.match(src, /GLOBAL BY DESIGN/);
  assert.match(src, /listPrunableRefreshRuns/);
});
