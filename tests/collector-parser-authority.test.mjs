/**
 * WS-D — pin the collector's single-parser authority.
 *
 * WS-D's real achievement was a DELETE: `collect-reference.mjs` used to carry
 * its own inline `Status:` regex alongside the canonical `parsePlanStatus`, so
 * two parsers owned one contract and could disagree about whether a plan
 * rendered "Active" while its text said "Complete". The second parser is gone.
 *
 * Nothing prevented it coming back. A behavioural test cannot: a reintroduced
 * regex that happens to agree with the canonical parser today passes every
 * behavioural assertion and only diverges later, on the input nobody wrote a
 * fixture for. That is why this file scans the SOURCE — the property being
 * protected is "there is only one parser", which is a structural fact, not an
 * observable output.
 *
 * Paired with fixtures for the two `ok:false` reasons the collector must keep
 * handling (`duplicate`, `unrecognized`), which previously had no coverage.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COLLECTOR = path.join(__dirname, '..', 'scripts', 'lib', 'dashboard', 'collect-reference.mjs');

// ── The source-scan pin ─────────────────────────────────────────────────────

test('the collector holds no `Status` regex of its own (single-parser authority)', () => {
  const src = fs.readFileSync(COLLECTOR, 'utf-8');

  // Strip comments first. The file legitimately *discusses* the deleted regex
  // and the two-parser hazard in prose, and matching that would make the pin
  // fire on its own documentation — the same comment-blindness class that let a
  // backtick in a comment defeat a scanner elsewhere in this family.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');

  // Any regex literal mentioning Status, or a string-built RegExp over it.
  const statusRegexLiteral = /\/[^/\n]*Status[^/\n]*\/[gimsuy]*/i;
  const statusRegExpCtor = /new\s+RegExp\s*\([^)]*Status/i;

  assert.ok(!statusRegexLiteral.test(code),
    'collect-reference.mjs must not parse `Status:` itself — parsePlanStatus is the sole authority. '
    + 'If a status-shaped regex is genuinely needed here, the contract changed and this pin should be revisited deliberately.');
  assert.ok(!statusRegExpCtor.test(code),
    'a RegExp built from a Status string is the same second parser, one indirection away');

  // Positive control: the pin is worthless if the delegation itself vanished.
  assert.match(code, /parsePlanStatus/,
    'the collector must still delegate to the canonical parser');
});

// ── Fixtures for the two ok:false reasons ───────────────────────────────────

const mkRoot = (prefix) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, 'docs', 'plans'), { recursive: true });
  return root;
};

const cleanup = (root) =>
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

test('discoverPlans: a duplicate-Status plan is surfaced as malformed, not dropped', async () => {
  const { discoverPlans } = await import('../scripts/lib/dashboard/collect-reference.mjs');
  const root = mkRoot('collector-dup-');
  try {
    fs.writeFileSync(path.join(root, 'docs/plans/dup.md'),
      '# Plan: Duplicated\n- **Date**: 2026-07-19\n- **Status**: Draft\n- **Status**: Complete\n\n## Body\nx\n');

    const result = discoverPlans(root);
    const all = [...result.active, ...result.completed];
    const found = all.find((p) => p.path === 'docs/plans/dup.md');

    // The value of this fixture is that it pins the CURRENT true behaviour.
    // An earlier revision of the WS-D notes claimed such a plan vanishes from
    // the dashboard entirely; reading the collector refuted that, and this
    // asserts the refutation so the claim cannot drift back in either direction.
    assert.ok(found, 'a duplicate-Status plan carrying a `Plan:` H1 must still be listed');
    assert.equal(found.malformed, true, 'and must be flagged malformed so the badge renders');
    assert.equal(result.anyMalformed, true);
  } finally { cleanup(root); }
});

test('discoverPlans: an unrecognized Status value is malformed but keeps its raw text', async () => {
  const { discoverPlans } = await import('../scripts/lib/dashboard/collect-reference.mjs');
  const root = mkRoot('collector-unrec-');
  try {
    fs.writeFileSync(path.join(root, 'docs/plans/unrec.md'),
      '# Plan: Odd\n- **Date**: 2026-07-19\n- **Status**: Marinating\n\n## Body\nx\n');

    const result = discoverPlans(root);
    const all = [...result.active, ...result.completed];
    const found = all.find((p) => p.path === 'docs/plans/unrec.md');

    assert.ok(found, 'an unrecognized status must not remove the plan from the index');
    assert.equal(found.malformed, true);
  } finally { cleanup(root); }
});

test('discoverPlans: a well-formed plan is NOT malformed (negative control)', async () => {
  const { discoverPlans } = await import('../scripts/lib/dashboard/collect-reference.mjs');
  const root = mkRoot('collector-ok-');
  try {
    fs.writeFileSync(path.join(root, 'docs/plans/fine.md'),
      '# Plan: Fine\n- **Date**: 2026-07-19\n- **Status**: Draft\n\n## Body\nx\n');
    const result = discoverPlans(root);
    // Without this, the two assertions above could pass on a collector that
    // marks EVERYTHING malformed.
    assert.equal(result.anyMalformed, false);
    assert.equal(result.active.length, 1);
  } finally { cleanup(root); }
});

// ── D-raw: the duplicate branch now names what conflicts ────────────────────

test('parsePlanStatus: duplicate carries the conflicting values, honouring its own docstring', async () => {
  const { parsePlanStatus } = await import('../scripts/lib/plan-status.mjs');
  const parsed = parsePlanStatus(
    '# Plan: X\n- **Date**: 2026-07-19\n- **Status**: Draft\n- **Status**: Complete\n\n## Body\n');

  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'duplicate');
  // The docstring has always promised `raw` is present whenever a Status line
  // was found; the duplicate branch used to contradict it.
  assert.equal(parsed.raw, 'Draft', 'raw is the FIRST value, so single-value consumers keep working');
  assert.deepEqual(parsed.rawStatusValues, ['Draft', 'Complete'], 'in document order');
});

test('a duplicate-Status plan satisfies the collector UNION rule (it plainly HAS a Status line)', async () => {
  const { discoverPlans } = await import('../scripts/lib/dashboard/collect-reference.mjs');
  const root = mkRoot('collector-union-');
  try {
    // No `# Plan:` H1 — inclusion must rest on the Status signal alone. Before
    // the duplicate branch returned `raw`, this plan failed BOTH signals and
    // vanished, despite having two Status lines.
    fs.writeFileSync(path.join(root, 'docs/plans/nohead.md'),
      '# Freeform Title\n- **Date**: 2026-07-19\n- **Status**: Draft\n- **Status**: Complete\n\n## Body\nx\n');

    const result = discoverPlans(root);
    const found = [...result.active, ...result.completed].find((p) => p.path === 'docs/plans/nohead.md');
    assert.ok(found, 'a plan with two Status lines satisfies the "has a Status line" signal');
    assert.equal(found.malformed, true);
    assert.deepEqual(found.statusConflict, ['Draft', 'Complete'],
      'and the surface can name WHICH values disagree');
  } finally { cleanup(root); }
});

test('a healthy plan carries no statusConflict (renderers need no special case)', async () => {
  const { discoverPlans } = await import('../scripts/lib/dashboard/collect-reference.mjs');
  const root = mkRoot('collector-noconflict-');
  try {
    fs.writeFileSync(path.join(root, 'docs/plans/ok.md'),
      '# Plan: Fine\n- **Date**: 2026-07-19\n- **Status**: Draft\n\n## Body\nx\n');
    assert.equal(discoverPlans(root).active[0].statusConflict, null);
  } finally { cleanup(root); }
});
