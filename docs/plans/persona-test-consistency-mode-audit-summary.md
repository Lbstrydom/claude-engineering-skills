# Audit Summary — Persona-Test Consistency Mode

- **Plan**: [docs/plans/persona-test-consistency-mode.md](persona-test-consistency-mode.md)
- **Date**: 2026-05-20
- **Audit scope**: `--scope plan` (all 22 files mentioned in the plan, across 5 commits e6e731a → 2d65dfb)
- **Rounds**: 4 (audit-code) + 3 (Gemini final review) = **7 total**
- **Verdict**: Final Gemini-v3 CONCERNS_REMAINING; 3 of 4 R3 findings fixed, 1 was Gemini-hallucinated (verified). Coherence reached **Strong**.
- **Cumulative fixes**: ~34 findings addressed inline across 7 rounds
- **Cumulative deferred/dismissed**: ~130 findings absorbed into §11b residual debt or marked pre-existing-out-of-scope

## Trajectory

| Round | Verdict | HIGH | MEDIUM | LOW | Fixed this round | Notes |
|---|---|---|---|---|---|---|
| R1 | SIGNIFICANT_ISSUES | 15 | 24 | 3  | 11 | Architectural gaps + spec compliance |
| R2 | INCOMPLETE | 12 | 22 | 2  | 10 | R1 fix regressions + new edge cases |
| R3 | INCOMPLETE | 7  | 23 | 8  | 4  | Bugs introduced by R2 fixes |
| R4 | SIGNIFICANT_ISSUES | 8  | 22 | 6  | 2  | Plateaued; 6 of 8 are repeat-dismissed |

## Key fixes by round

**R1 — Architecture + spec compliance**:
- H3: CLI repo-scoping at `cmdRecordRegressionSpec`
- H4: Re-validate JSONB on promote read (Zod parse before render)
- H5: Redact fail-closed on depth cap + cycle detection
- H7: Per-kind assertion templates in candidate-spec
- H8: Hard errors for unknown actions / missing routes / missing locator
- H10/H15: `kind` in canary suppression + verify shape matching
- H13: `unresolved-ground-truth` finding instead of silent skip in diffClaims
- M8: Manifest resolver absoluteness + regular-file check
- M10: Loud stderr when candidate persistence disabled
- M21: Drop selector from fingerprint identity (use scope+key instead)

**R2 — Hardening + my-own-bug fixes**:
- H1: loadCanary checks canaries/ dir for symlink escape
- H3/H10: Refuse promotion when journey has `evaluate` step (plan §11b TODO comment isn't a lock)
- H4: Proper cycle detection via ancestor stack (was shared WeakSet, misclassified diamonds)
- H5: Emit `unresolved-ground-truth` when DOM is absent + no net captured
- H6: Redact BEFORE truncate in semantic-compare (was truncate-then-redact, could split secrets)
- H7/H12: Bumped fingerprint slice to 16 chars + refuse missing fingerprint
- H8: try/catch around `opts.callLLM` (provider errors → uncertain verdict)
- H11: Validate regex patterns at manifest load time (Zod refinement)

**R3 — Boundary tightening**:
- H1: verifyExpectations strict-guards non-array contradictions
- H3: Pre-arm `postWait` event waits via `Promise.all([wait, action])` pattern
- H4: `contradictionStepIndex` field in journey context for explicit replay-boundary contract
- H6: `fs.renameSync` ownership check (idempotent re-runs allowed via byte-equal compare; otherwise refuse)

**R4 — Final fixes**:
- H3: `redact()` error message before putting in semantic-compare verdict reason
- H8: Promote thread `contradictionStepIndex` through to renderCandidateSpec

## Out-of-scope / accepted-as-debt

All absorbed into [docs/plans/persona-test-consistency-mode.md §11b](persona-test-consistency-mode.md#11b-known-limitations--accepted-at-v1):

- **Plan-doc drift** (R1-H1/H2 + M1/M2/M3, re-surfaced R3-H1, R4-H1): `shared-store.mjs`, `llm-cost.mjs`, `persona-consistency-bootstrap.mjs`, `tests/cross-skill.test.mjs` referenced in plan but not concrete files. Plan §11b documents the reconciliation: cache/lockfile concerns inlined into `ledger.mjs` + `semantic-compare.mjs`; cost inline; bootstrap = §11b deferral; tests under `cross-skill-*.test.mjs` cover the surface; canaries belong in consumer repos.
- **Network listener has no public drain** (R1-H6): plan-accepted async fire-and-forget; in-flight responses only land in cumulative store, not the already-returned witness.
- **Promote is journal-based, not 2PC** (R1-H9 + R4-H6): plan-committed design; `reconcilePromotionJournal` covers every crash window.
- **resolveRepoId is MVP stub** (R1-H12, R2-H2, R3-H2, R4-H2/H7): pre-existing in `cross-skill.mjs` before this plan.
- **Dashboard a11y findings** (R1-H11, R4-H5): pre-existing in `dashboard/index.html`, unrelated to this plan.
- **Model resolver parse bugs** (R1-H14, R2 M9): pre-existing in `model-resolver.mjs`.
- **Manifest-stale `repo_id NULL` allowed at DB layer** (R3-H5): plan committed to partial unique index with `repo_id IS NOT NULL` predicate — CLI refuses NULL repoId, partial index protects the DB; full NOT NULL constraint is a v2 hardening.
- **Various pre-existing `cross-skill.mjs` god-file + error-swallowing** patterns (R1-M4/M14/M15/M18, R2-various): pre-existing patterns; refactor is its own plan.

## Final state at audit-code exit

- 27 cumulative fixes shipped in code (lib + scripts + schemas + tests)
- 125 findings deferred to debt or dismissed as pre-existing/out-of-scope
- Test suite: **2644/2644 pass**, 0 fail, 17 skip
- Audit-code STOPPED at R4 per the "HIGH count plateaus or increases → STOP" rule.

## Audit-code → Gemini progression

R1→R2→R3 showed clear convergence (15→12→7). R4 surfaced 8 HIGH; 2 were genuinely new (R4-H3 error leakage, R4-H8 dropped step index — both bugs from my R3 fixes), the other 6 were re-surfaces of already-dismissed issues that varied slightly in wording. The audit-code skill's convergence rule "HIGH plateaus or rises → STOP" fired at R4.

## Gemini final review — 3 rounds

- **Gemini-R1 CONCERNS_REMAINING / Adequate coherence**: 3 findings — G1 (reconcile-journal trust without DB), G2 (`undefined → null` coercion in capture), R4-M4 wrongly_dismissed (plan mandates cross-skill CLI for `list-consistency-candidates`). All 3 fixed.
- **Gemini-R2 CONCERNS / Strong coherence**: 3 findings — G1 (scope null/undefined strict-eq, defensive fix), G2 (`coerceDomKey` never wired into diffClaims), G3 + R4-M4 (plan §11 Boundary 2 mandates cross-skill CLI for `promote-regression-spec` and `record-ship-event` too). Coherence rose to Strong. All 3 fixed.
- **Gemini-R3 CONCERNS_REMAINING / Strong coherence**: 4 findings — G1 (defensive redact at CLI boundary), G2 (claimed `keyNative === null` typo that doesn't exist in code — **Gemini hallucination, verified by direct grep**), G3 (`execFileSync` catch ignores err.stdout), G4 (semantic-compare missing model-allowlist per plan §11 Boundary 1 step 3). 3 fixed; G2 dismissed as hallucination.

## Why we stopped at Gemini-R3

7 audit rounds total. Each Gemini round still finds 3-4 real bugs, but the rate of NEW issues is now ≤ the rate of my-edits-introducing-bugs (R2 introduced H4 cycle/H6 truncate/H8 try-catch; R3 introduced H3 leak/H8 stepIndex-drop; Gemini-R2 introduced G3 stdout-swallow). Coherence is Strong; the rig is functionally complete. Per plan §11b: "Diminishing returns at round 7; further iteration would be rigor-pressure. Plan committed to ship at this state."

Final state: code committed, plan §11b updated to absorb known limitations as residual debt, ready to /ship.
