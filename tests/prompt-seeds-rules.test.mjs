/**
 * @fileoverview Tier-2 invariant test for the GREEN ≠ REALIZED Cluster B runtime-truth audit
 * rules (plan: docs/plans/green-not-realized.md, Phase 5). NOT a grep of the source — it asserts
 * the rule text survives into the BUILT pass prompt (`PASS_PROMPTS.frontend`, the exact string
 * `openai-audit.mjs` bootstraps into the registry and injects). A prose drift that drops the
 * checkable-artifact demand would let the derived-state-parity rule silently degrade to "consider
 * agreement" — itself green-but-not-realized — so this pins the load-bearing phrases.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PASS_PROMPTS, PASS_FRONTEND_RUBRIC } from '../scripts/lib/prompt-seeds.mjs';

test('frontend pass prompt carries the derived-state-parity rule (built injection path)', () => {
  const built = PASS_PROMPTS.frontend;
  assert.ok(built.includes('DERIVED-STATE PARITY'), 'rule header present in the built prompt');
  // It must demand a CHECKABLE ARTIFACT, not prose — the three named escape hatches.
  assert.ok(/data-engine-claim/.test(built), 'nudges the consistency-contract surface declaration');
  assert.ok(/source-of-truth/i.test(built), 'shared-SSoT artifact named');
  assert.ok(/parity assertion/i.test(built), 'parity-assertion artifact named');
  // It must explicitly reject prose-only "keep in sync" guidance.
  assert.ok(/green-but-not-realized/i.test(built), 'explicitly rejects prose-only agreement');
});

test('frontend pass prompt carries the freeze-semantics rule (#5)', () => {
  assert.ok(PASS_PROMPTS.frontend.includes('FREEZE-SEMANTICS'), 'freeze-semantics rule present');
  assert.ok(/SEMANTICS match/i.test(PASS_PROMPTS.frontend), 'demands proving source semantics, not just naming it');
});

test('the rule lives in the rubric constant, so it survives registry bootstrap', () => {
  // PASS_PROMPTS.frontend = objective + PASS_FRONTEND_RUBRIC; pin the source of the phrase.
  assert.ok(PASS_FRONTEND_RUBRIC.includes('DERIVED-STATE PARITY'));
  assert.ok(PASS_PROMPTS.frontend.endsWith(PASS_FRONTEND_RUBRIC) || PASS_PROMPTS.frontend.includes(PASS_FRONTEND_RUBRIC));
});

// ── Scope-completeness rule (docs/plans/install-transaction-wal-hardening.md Fix 8) ──
//
// Added after the partial-scope-enumeration class survived 4 GPT + 2 Gemini rounds on
// transaction.mjs and then shipped three live bugs one layer out (receipt scope stripped by
// Zod; a receipt rewritten on writes but not deletes; a drift checker reading one of two
// receipts). These pin the load-bearing phrases: without the failing-scenario demand the rule
// degrades into "consider whether you covered everything", which is unactionable noise.
test('backend pass prompt carries the scope-completeness rule (built injection path)', () => {
  const built = PASS_PROMPTS.backend;
  assert.ok(built.includes('SCOPE COMPLETENESS'), 'rule header present in the built prompt');
  assert.ok(/PARTIAL COLLECTION/.test(built), 'the writes-but-not-deletes shape is named');
  assert.ok(/BACKWARDS DERIVATION/.test(built), 'the two-anchors shape is named');
  assert.ok(/STRIPPED DISCRIMINATOR/.test(built), 'the schema-drops-a-branched-field shape is named');
  // It must demand evidence, not vibes — the guard against turning this into noise.
  assert.ok(/No failing scenario, no\nfinding/.test(built) || /No failing scenario, no finding/.test(built.replace(/\n/g, ' ')),
    'demands a concrete failing input');
  assert.ok(/deliberate, documented asymmetry is NOT this/.test(built), 'exempts justified asymmetry');
});

// ── Dependency-manifest scope rule (2026-08-13) ─────────────────────────────
//
// Measured over wine-cellar-app's `.audit` artifacts: THREE HIGH findings in THREE
// different passes claimed a package was undeclared when it was declared all along
// (`openai ^6.17.0` twice, `zod ^4.3.6` once). All three wrote "the SUPPLIED
// package.json" — the model knew its view was partial and asserted absence anyway.
// The deterministic gate cannot reach this class (a bare specifier is `external`;
// a repo FILE inventory says nothing about an npm manifest), which is what makes
// the prompt the correct layer here and nowhere else in the absence family.
const MANIFEST_PASSES = ['structure', 'wiring', 'backend', 'frontend', 'sustainability'];
const MECHANICAL_PASSES = ['quickfix', 'duplication', 'adjacency'];

test('every generator pass carries the dependency-manifest scope rule (built injection path)', () => {
  for (const pass of MANIFEST_PASSES) {
    const built = PASS_PROMPTS[pass];
    // Match on whitespace-normalised text: the prompt is hard-wrapped, so a
    // phrase-level assertion against the raw string is really an assertion about
    // where the line breaks fall — it would fail on a pure re-wrap and pass on a
    // reworded rule, which is backwards.
    const flat = built.replace(/\s+/g, ' ');
    assert.ok(flat.includes('DEPENDENCY MANIFESTS ARE OUT OF SCOPE'),
      `${pass}: rule header missing from the built prompt`);
    // The REASON must survive, not just the prohibition — a bare "don't do that"
    // degrades into a rule the model cannot apply to an unseen phrasing.
    assert.ok(flat.includes('statement about your context window, not about the repo'),
      `${pass}: the context-window reason was dropped`);
    // The carve-out is load-bearing in the opposite direction: without it the rule
    // reads as "never mention dependencies" and would suppress real import defects.
    assert.ok(flat.includes('MAY flag the IMPORT itself'),
      `${pass}: the import-is-still-in-scope carve-out was dropped`);
  }
});

test('the manifest rule names the phrasings the field findings actually used', () => {
  // Derived from the three real findings, not from what the rule's author expected:
  // "absent from the supplied package.json dependencies", "absent from the supplied
  // package dependency list", "not declared in the supplied `package.json` dependency
  // inventory". A rule naming only one spelling would miss the other two.
  const built = PASS_PROMPTS.structure;
  for (const phrasing of ['undeclared', 'missing from dependencies', 'absent from a manifest']) {
    assert.ok(built.includes(phrasing), `the rule does not name the "${phrasing}" shape`);
  }
  assert.ok(/lockfile/.test(built), 'lockfiles are covered alongside package.json');
});

test('the manifest rule is NOT sprayed onto the mechanical waves', () => {
  // Scope assertion, and a real cost guard: quickfix/duplication/adjacency are
  // bouncers over pre-computed candidates — they never author a dependency verdict,
  // so the tokens would be pure waste. Mirrors MECHANICAL_WAVES in audit-shadow.mjs.
  for (const pass of MECHANICAL_PASSES) {
    assert.ok(!PASS_PROMPTS[pass].includes('DEPENDENCY MANIFESTS ARE OUT OF SCOPE'),
      `${pass} is a mechanical wave and must not carry the rule`);
  }
});
