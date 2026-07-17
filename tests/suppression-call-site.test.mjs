/**
 * @fileoverview CALL-SITE pin for the post-output suppression composition.
 *
 * Plan: docs/plans/sibling-path-suppression-defects.md (WS-B/WS-C, R3-M2).
 *
 * WHY A SOURCE-ASSERTION TEST. This gap has recurred three times across two
 * plans: a correct seam with a wrong call site erased every finding
 * (cloud-FP R3-H1), a contract with no callable boundary (R4-H2), and the same
 * again here (R2-H3). Each time the answer was "the seam is tested; the call
 * site is review-time" — a concession, not a solution. The pure suites in
 * tests/suppression-policy.test.mjs prove the seam's LOGIC; they structurally
 * cannot see whether the orchestrator calls it, calls it once, calls it
 * unconditionally, or uses its result.
 *
 * The repo already had the answer: tests/anthropic-client-migration.test.mjs
 * greps for any bare `new Anthropic()` outside the factory;
 * tests/relocation-guard.test.mjs asserts the --selfcheck-relocation handler
 * string is present. Both pin a call-site invariant by reading source text — no
 * pipeline, no mock, no LLM, none of the machinery the doctrine forbids.
 *
 * HONEST LIMITS. This is a SYNTACTIC pin, not a semantic proof: it cannot show
 * the call does the right thing (the pure suites do that), and a sufficiently
 * creative refactor could satisfy the text while breaking the intent. It is
 * deliberately a guard against regression to a KNOWN-BAD SHAPE — the shape that
 * defines both WS-B and WS-C. Matchers are kept loose (find the landmark,
 * compare indices) rather than brittle regexes over formatting.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'scripts', 'lib', 'audit', 'legacy-production-audit.mjs'
);
const src = fs.readFileSync(SRC, 'utf8');

/**
 * Index range of the `if (mergedLedger.entries.length > 0) { … }` block, by
 * brace matching. Landmark-based: immune to line-number drift, which is exactly
 * what bit the sibling plan (a file-plan anchor was wrong by 100 lines and
 * pointed INSIDE this branch — it would have recreated the bug it claimed to fix).
 */
function ledgerBranchRange() {
  const open = src.indexOf('if (mergedLedger.entries.length > 0)');
  assert.notEqual(open, -1, 'the ledger branch landmark moved — update this test deliberately');
  const braceStart = src.indexOf('{', open);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return { start: open, end: i }; }
  }
  throw new Error('unbalanced braces from the ledger branch');
}

test('runSuppressionPasses is called exactly once', () => {
  const calls = src.match(/runSuppressionPasses\(/g) || [];
  assert.equal(calls.length, 1, 'exactly one composition call site — two would double-suppress');
});

test('the composition call is OUTSIDE the ledger branch (the invariant WS-B and WS-C exist to fix)', () => {
  // THE pin. Nested inside, each pass becomes conditional on unrelated local
  // ledger state — a run with an empty merged ledger (exactly the case each pass
  // serves) would suppress nothing. That nesting is the whole defect.
  const { end } = ledgerBranchRange();
  const call = src.indexOf('runSuppressionPasses(');
  assert.notEqual(call, -1, 'the composition call is missing entirely');
  assert.ok(call > end, 'runSuppressionPasses must be called AFTER the ledger branch closes, never inside it');
});

test('the composition call is unconditional — no `if` guards it', () => {
  const call = src.indexOf('runSuppressionPasses(');
  const decl = src.lastIndexOf('const passes', call);
  assert.notEqual(decl, -1, 'expected `const passes = runSuppressionPasses(...)`');
  // Look at the statement that precedes the declaration: it must not be an
  // `if (...)` opening a block around it.
  const preceding = src.slice(Math.max(0, decl - 200), decl);
  assert.ok(
    !/\bif\s*\([^)]*\)\s*\{\s*$/.test(preceding),
    'the call must not be wrapped in a conditional — null tracker AND null policy are already no-ops'
  );
});

test('the composition RESULT is assigned back to _suppressionData', () => {
  // The omission the plan's own R3-H1 caught in a withdrawn draft: computing the
  // synthesized envelope and then dropping it silently re-creates the
  // no-provenance hole the synthesis exists to close.
  assert.match(
    src,
    /_suppressionData\s*=\s*passes\.suppressionData/,
    'the seam’s returned/synthesized envelope must reach _suppressionData'
  );
});

test('allFindings is replaced from the pass result', () => {
  const call = src.indexOf('runSuppressionPasses(');
  const after = src.slice(call, call + 600);
  assert.match(after, /allFindings\.length\s*=\s*0/, 'expected the clear-then-push replacement');
  assert.match(after, /allFindings\.push\(\.\.\.passes\.findings\)/, 'findings must come from the pass result');
});

test('WS-C: populateFindingMetadata runs BEFORE the ledger branch, and not inside it', () => {
  // It is the ONLY producer of _primaryFile/affectedFiles, and consumers outside
  // the branch read them (.audit/outcomes.jsonl, audit_findings.primary_file).
  // Nested, a no-ledger run silently records the raw section string and [].
  const { start, end } = ledgerBranchRange();
  const enrich = src.indexOf('populateFindingMetadata(f, f._pass)');
  assert.notEqual(enrich, -1, 'the enrichment loop is missing');
  assert.ok(enrich < start, 'enrichment must run BEFORE the ledger branch opens');

  const inBranch = src.slice(start, end);
  assert.ok(
    !/for \(const f of allFindings\)\s*\{\s*populateFindingMetadata/.test(inBranch),
    'the in-branch enrichment loop must be REMOVED, not duplicated — two call sites is a second source of truth'
  );
});

test('WS-B: the local fpTracker loop has not crept back into the ledger branch', () => {
  const { start, end } = ledgerBranchRange();
  const inBranch = src.slice(start, end);
  assert.ok(
    !/fpTracker\.shouldSuppress\(/.test(inBranch),
    'the local tracker loop belongs in runLocalFpPass, outside the branch — this is the regression to a known-bad shape'
  );
});

test('no DANGLING reference to a local the refactor removed', () => {
  // Found the hard way: after the composition moved into runSuppressionPasses,
  // a downstream consumer still read `cloudPass.suppressedCount` — a
  // ReferenceError that would crash EVERY cloud-enabled R2+ run. The whole
  // suite (6,700+ tests) was green, because nothing executes
  // runLegacyProductionAudit; only running the real audit surfaced it.
  //
  // These names were locals of the pre-lift composition. If one reappears, a
  // refactor has left a reference to something that no longer exists.
  for (const gone of ['cloudPass', 'localPass', 'fpSuppressed']) {
    assert.ok(
      !new RegExp(`\\b${gone}\\b`).test(src),
      `\`${gone}\` no longer exists — a reference to it is a ReferenceError at runtime, and no unit test executes this function`
    );
  }
});

test('the module actually LOADS — the cheapest guard against a crash no unit test sees', async () => {
  // Deliberately not a mock: importing the real module resolves every top-level
  // binding. It would not have caught the cloudPass ReferenceError (that lives
  // inside a function body), which is precisely why the dangling-reference pin
  // above exists alongside it.
  const mod = await import('../scripts/lib/audit/legacy-production-audit.mjs');
  assert.equal(typeof mod.runLegacyProductionAudit, 'function');
});
