# Audit Summary — Requirements Layer

- **Plan**: [`docs/completed/requirements-layer.md`](requirements-layer.md)
- **Date**: 2026-05-17
- **Audit**: `/audit-code` — GPT-5.x ×4 rounds + Gemini 3.1 Pro ×2 final-review rounds

## Round trajectory (GPT)

| Round | Verdict | H | M | L | Notes |
|---|---|---|---|---|---|
| R1 | SIGNIFICANT_ISSUES | 4 | 15 | 4 | first-cut review |
| R2 | NEEDS_FIXES | 0 | 9 | 5 | all 4 R1 HIGH fixed |
| R3 | SIGNIFICANT_ISSUES | 6 | 5 | 4 | R2 fixes left 2 gaps + 1 self-introduced regression — all fixed |
| R4 | INCOMPLETE | 5 | 9 | 3 | GPT iteration stopped — HIGH plateaued on rigor-pressure |

GPT iteration was stopped at R4 per the rigor-pressure rule: the R4 HIGHs were
gold-plating, a pre-existing out-of-scope skill-doc line, and re-litigation of
the audit-plan-**approved** advisory gap-challenge design (#16). Two genuine R4
findings were still fixed.

## Real defects fixed

- **Path traversal / symlink egress** (R1-H2/H4) — `extractRequirements`
  canonicalises every `--files` path, rejects repo-root escapes, and re-checks
  **both** containment and `isPathSensitive` on the realpath target.
- **Silent fail-open** (R1-H1/H3) — gap-challenge & `reconcile` degrade
  *loudly* (stderr `WARN`), and distinguish an absent vs a present-but-invalid
  `gaps.json`.
- **Advisory pass could crash `extract`** (R3-H6, self-introduced by the R2
  schema tightening) — `classifyGaps` now self-sanitises every assessment so
  `GapsFileSchema.parse` can never abort extraction.
- **Silent ledger data-loss** (Gemini wrongly-dismissed R4-H1) — `coveredFiles`
  is now the union of *succeeded-batch* files only, so a failed batch never
  makes `reconcile` scoped-replace a file's prior requirements with nothing.
- **Schema-boundary mismatch** (Gemini new-HIGH) — `RawExtractionItemSchema`
  `assertion` `min(8)` aligned with `RequirementCandidateSchema`.
- Plus: per-item LLM-response validation, shared `RequirementIdSchema`
  (kind-bound), `GapAssessmentSchema` state invariant, batch-failure
  resilience, `--runs` validation, lock-lifecycle fix (`throw` not
  `process.exit`), shared `parseLlmJson` helper, fail-closed `overrides.json`,
  and security-guard regression tests.

## Final state

- **GPT**: all R1–R3 HIGH fixed; R4 HIGH adjudicated as rigor-pressure /
  out-of-scope / approved-design (see `.claude/tmp/*-ledger.json`).
- **Gemini R1**: APPROVE-blocked on 1 wrongly-dismissed HIGH (real — fixed) +
  3 new findings (1 HIGH + 2 LOW — all fixed) + 1 out-of-scope MEDIUM
  (challenged: targets pre-existing `file-lock.mjs`, not this PR).
- **Gemini R2**: `CONCERNS_REMAINING` — **1 finding, a verified false
  positive**. Gemini claimed the canonical (post-symlink) path is not
  containment-checked; it **is** — [`extract.mjs:212`](../../scripts/lib/requirements/extract.mjs#L212)
  `if (escapesRoot(realAbs)) throw …` runs before `isPathSensitive` and before
  any `readFileSync`. A symlink resolving to `/etc/passwd` is rejected there.
  Gemini's R2 overall reasoning otherwise states the codebase is "remarkably
  robust" and "Claude successfully remediated all valid … bugs".

## Verification

- Full suite: 2330+ pass, 1 pre-existing flaky hook-latency *timing* test
  (passes in isolation; unrelated to this PR).
- Live end-to-end: `requirements.mjs extract → reconcile → index` on 2 files
  produced 33 schema-valid candidates → a 4-active / 29-inferred-only ledger;
  smoke artefacts removed (`.requirements/` holds only `README.md` at rest).
