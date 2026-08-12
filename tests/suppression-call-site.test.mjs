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
    else if (src[i] === '}') { depth--; if (depth === 0) {
      // KNOWN LIMITATION (Gemini consolidated-gate finding): this counter
      // doesn't tokenize, so an unmatched brace inside a string/template/
      // comment within the branch skews the range — and a TRUNCATED range
      // makes the "not inside the branch" pins pass vacuously (silent
      // false-green, the dangerous direction). Sanity-guard: the branch is
      // known to contain the suppression composition's ledger merge; if the
      // computed range lost it, the range is wrong — fail loudly instead.
      const range = src.slice(open, i);
      assert.ok(range.includes('mergedLedger'), 'ledgerBranchRange sanity: computed range lost its own landmark content — brace counting skewed (string/template brace inside the branch?)');
      assert.ok(i - open > 200, 'ledgerBranchRange sanity: implausibly small range — brace counting skewed');
      return { start: open, end: i };
    } }
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

// ── The learningWritesAllowed gate (shadow-write-gate plan, Phase 2) ────────
//
// The 2026-07-18 H1 leak: syncBanditArms/syncFalsePositivePatterns were keyed
// only on object presence, so an observation-only (noCloudRecording) shadow
// run mutated cloud learning state while running concurrently with the real
// audit. These pins hold the policy in place syntactically; the smoke test
// executes both sides of it.

test('learningWritesAllowed is declared once and derives from noCloudRecording', () => {
  const decls = src.match(/const\s+learningWritesAllowed\s*=\s*!noCloudRecording\s*;/g) || [];
  assert.equal(decls.length, 1, 'exactly one declaration, derived from the flag');
});

test('every learning-state sink sits under the writeLearningState gate', () => {
  // docs/plans/audit-backlog-triage-hardening.md item 1 (2026-07-23):
  // collapsed the 5 independent `if (learningWritesAllowed)` / `if (X &&
  // learningWritesAllowed)` call sites this test used to pin into ONE choke
  // point, `writeLearningState(allowed, fn)` — grep it to enumerate every
  // writer instead of re-deriving the list from 5 differently-shaped
  // conditionals. Assertions below pin the NEW shape, same invariant: every
  // sink is unreachable when learningWritesAllowed is false.
  assert.match(src, /^function writeLearningState\(allowed, fn\) \{\s*\n\s*if \(!allowed\) return;\s*\n\s*return fn\(\);\s*\n\}/m,
    'the single choke point every learning-state write must go through');

  // The bandit-arms cloud sink + bandit.flush share one writeLearningState call.
  //
  // The SINK MOVED (durability plan Phase 3, 2026-08-12): the raw
  // `syncBanditArms(...)` call is now `durableWrite('learning.banditArms', …)`,
  // which routes to the same store function through the write-ahead seam. The
  // invariant is unchanged and so is its strength — what changed is the name of
  // the thing that must sit inside the gate. A regex is used on the EXTRACTED
  // block rather than across the file, because a lazy match spanning the closing
  // brace would happily find a later `writeLearningState` and pass with the sink
  // outside the gate — which is the one thing this test exists to refuse.
  // Anchored on the flush, not on the first `if (bandit)` — there are two such
  // blocks (the earlier one registers arms) and picking the wrong one is how a
  // scan like this passes while asserting nothing about the real sink.
  const flushIdx = src.indexOf('bandit.flush();');
  assert.ok(flushIdx > 0, 'the bandit flush/sync block must exist');
  const banditIdx = src.lastIndexOf('\n  if (bandit) {', flushIdx);
  assert.ok(banditIdx > 0, 'bandit.flush must sit inside an `if (bandit)` block');
  const banditBlock = src.slice(banditIdx, src.indexOf('\n  }', flushIdx));
  assert.match(banditBlock, /writeLearningState\(learningWritesAllowed,\s*async\s*\(\)\s*=>\s*\{/,
    'the bandit block must open with a writeLearningState gate');
  assert.match(banditBlock, /bandit\.flush\(\);/, 'bandit.flush must be inside that gate');
  assert.match(banditBlock, /durableWrite\('learning\.banditArms'/,
    'the bandit-arms cloud sink must be inside that same gate');
  // syncFalsePositivePatterns has its own.
  assert.match(src, /if\s*\(fpTracker\)\s*\{[\s\S]{0,900}?writeLearningState\(learningWritesAllowed,\s*\(\)\s*=>\s*\{[\s\S]{0,300}?syncFalsePositivePatterns\(/,
    'syncFalsePositivePatterns must be routed through writeLearningState');
  // No sink calls writeLearningState with a literal `true` (that would
  // silently re-open the ungated leak this whole mechanism exists to close).
  const hardcodedAllowed = src.match(/writeLearningState\(\s*true\s*,/g) || [];
  assert.equal(hardcodedAllowed.length, 0, 'no writeLearningState call site may hardcode allowed=true');

  // The LOCAL bandit reward stream (audit R2-H1): the per-finding
  // appendOutcome loop must be gated too — a shadow's findings would
  // otherwise train the real bandit.
  assert.match(src, /writeLearningState\(learningWritesAllowed,\s*\(\)\s*=>\s*\{\s*for\s*\(const f of allFindings\)\s*\{[\s\S]{0,200}?appendOutcome\(/,
    'the outcomes.jsonl append loop must be gated via writeLearningState');
  // And the orphan-metrics emits (audit R1-H1): both sites inside
  // runOrphanIntroducedPass gate on the threaded flag via writeLearningState.
  const emitGates = src.match(/writeLearningState\(learningWritesAllowed,\s*\(\)\s*=>\s*emitOrphanRunMetrics\(/g) || [];
  assert.equal(emitGates.length, 2, `both emitOrphanRunMetrics sites gated (found ${emitGates.length})`);
});

test('the non-persisting view swap exists, references the gate, and precedes the first bandit use', () => {
  const swapIdx = src.indexOf('bandit = bandit.nonPersistingView()');
  assert.ok(swapIdx > 0, 'the view swap line must exist');
  const swapLineStart = src.lastIndexOf('\n', swapIdx);
  const swapContext = src.slice(Math.max(0, swapLineStart - 200), swapIdx);
  assert.match(swapContext, /!learningWritesAllowed\s*&&\s*bandit/, 'the swap is keyed on the gate');
  // The swap must precede EVERY other use of the local `bandit` binding —
  // a refactor hoisting a use above it silently re-opens the local channel.
  for (const use of ['bandit.addArm(', 'bandit.flush(', 'syncBanditArms(bandit.arms)']) {
    const useIdx = src.indexOf(use);
    assert.ok(useIdx === -1 || useIdx > swapIdx, `${use} must come after the view swap`);
  }
});
