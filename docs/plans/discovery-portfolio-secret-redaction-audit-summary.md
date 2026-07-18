# Audit Summary — discovery-portfolio-secret-redaction

**Plan**: [`docs/plans/discovery-portfolio-secret-redaction.md`](discovery-portfolio-secret-redaction.md)
**Result**: CONVERGED — 5 GPT rounds, Gemini final gate **APPROVE**
**Files changed**: `scripts/lib/audit-scope.mjs`, `scripts/lib/diff-annotation.mjs`,
`scripts/lib/secret-patterns.mjs`, `tests/audit-scope-egress.test.mjs`,
`tests/sensitive-egress.test.mjs`, `tests/tiered-pipeline-wiring.test.mjs`,
`tests/diff-annotation-egress.test.mjs` (new), plan doc (1-line fix)

## What shipped

`readFilesAsContext`/`readFilesAsAnnotatedContext` now default to
`redact: true` (safe-by-default), redacting secret-shaped content before
truncation/annotation. `buildRedactedAuditContext` explicitly opts out
(decision 11, model-A/B fairness). `scanForSecrets` strips its own
`[REDACTED:...]` markers before re-testing (the plan's core bug).
`redactSecrets` is now line-count-preserving, so a multi-line PEM
redaction never desyncs diff-hunk annotation. `tiered-pipeline.mjs`
needed zero code changes — confirmed via a static-pin regression test.
Full suite: 5298 tests, 0 failures.

## Notable finding — a dogfooding artifact, not a code defect

Rounds 1, 3, 4, and 5 each re-raised variants of one false premise: that
the test fixtures (`const DSN = 'postgresql://user:hunter2@...'`) were
"already redacted." Root cause: `/audit-code`'s own context assembly reads
subject source files through `readFilesAsContext` — the exact function
this plan flipped to `redact: true` by default. Reading the test files'
own source (to show GPT for review) triggers the same redaction the tests
are proving works, so GPT saw `[REDACTED:dsn-password]` in place of the
raw fixture and concluded the test was vacuous. The actual runtime tests
never go through this pathway (each writes its fixture to a temp file and
calls the real implementation directly) — verified via `node --check`,
direct `grep` of the raw on-disk fixtures, and the full passing test
suite, every round. GPT overruled all 8 (round 1) + 3 (round 3) + 4
(round 4) + 3 (round 5) = 18 instances of this premise once shown the
evidence. Gemini's final review independently reached the same diagnosis
unprompted (`gpt_false_positive_count: 22`) and confirmed the dismissals
were correctly evidenced, not rubber-stamped.

## Genuine findings fixed

- **Round 4, M2**: plan header (line 9) said "opt-in redaction mode" — a
  stale remnant from before round-1's design flip to safe-by-default.
  Fixed directly to match the rest of the plan.

## Deferred (pre-existing, out-of-scope debt — captured to `.audit/tech-debt.json`)

12 Architecture-pass findings (repo-wide domain-map coupling: `learning-store`,
`shared-lib`, `dashboard`, `cross-skill-bridge`, `persona-test`,
`audit-orchestration`→stores, dead `ship`/`skills-content` domains, missing
test-domain rule) — none cite a file this plan touches; none of the new
code calls/depends on the cited paths. One pre-existing test-quality nit
(`tests/tiered-pipeline-wiring.test.mjs`'s existing `elapsedMs`-only
assertion, untouched by this plan's diff) deferred as independent.

## Gemini final gate

`verdict: APPROVE`. `new_findings: 0`, `wrongly_dismissed: 0`,
`over_engineering_flags: 0`, `architectural_coherence: Strong`.
