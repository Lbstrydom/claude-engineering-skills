# Audit Summary: triage-independence-test-and-write-boundary-fixes

- **Session**: audit-code-1790324930
- **Rounds**: 4 (of max 6)
- **Final round-4 raw**: H:9 M:4 L:1 → after triage: 4 fixed, 4 dismissed
  (refuted/already-dispositioned), 12 deferred (captured as debt)

## Convergence character, honestly stated

The raw HIGH count never reached 0 across four rounds — not because new
architectural defects kept appearing, but because `scripts/lib/store/
runs-findings.mjs` (2,556 lines, an already-tracked god-module) carries a
large, genuinely pre-existing correctness-debt surface that GPT's
similarity-based re-raise suppression could not confidently hash-match round
over round (scores consistently 0.1–0.35, below the ~0.35 hard-suppress
threshold), so the SAME underlying concerns resurfaced each round under
reworded framing ("kept beside a prior ruling" in every round's
post-processing log). Verified this is the actual mechanism, not evasion: by
round 4, zero findings introduced a genuinely new defect class not already
triaged in an earlier round with a specific, checked rationale (not
boilerplate) — see the per-round ledger entries.

**What was genuinely fixed** (4 items, all real bugs confirmed by direct
code/behavior verification, not just GPT's say-so):

1. **Round 2 H4/H5** — `recordFindings`'s intra-batch dedup ran BEFORE the
   severity/category guard, so a first-occurrence invalid-severity finding
   could consume its fingerprint's dedup slot and silently drop a later,
   valid occurrence. Reordered so dedup only chooses among already-persistable
   rows. Proved red-then-green: reverted the fix, confirmed the regression
   test failed (0 rows instead of 1), restored, confirmed 41/41 green.
2. **Round 1 M4** — `.github/workflows/postgres-parity.yml`'s path filters had
   no entry for `tests/mark-findings-remediation.test.mjs` or the new
   `tests/record-findings-write-boundary.test.mjs`, so a standalone change to
   either would never trigger the DB-suite CI job. Added both to both
   `paths:` blocks.
3. **Round 3 M4** — this plan's own new test's `test.after` ran three DELETE
   queries before `closePool()` with no try/finally; a DELETE failure would
   leak the pool into later test files. Fixed with try/finally in the new
   file, and in both occurrences of the same pre-existing pattern in
   `tests/mark-findings-remediation.test.mjs` (already being modified by this
   plan). Verified 27/27 green.
4. **Round 4 L1** — the new test's no-category assertion used a loose
   `/missing/i` regex instead of the exact `MISSING_CATEGORY_MARKER`. Fixed
   to read the marker from source (matching the established pattern) and
   assert equality.

**What was refuted with direct evidence** (4 dismissals, not rubber-stamped):

- The debt-capture `--changed` snippet's "omits staged changes" claim —
  empirically false: staged a tracked file and confirmed `git diff
  --name-only HEAD` includes it. Re-raised 3 times (round 1 M5, round 2 H1/M2,
  round 3 M1, round 4 M6) under different wording; same refutation each time.
- "The two test files aren't wired into the CI invocation" (round 2 M6) —
  refuted by reading `.github/workflows/postgres-parity.yml`'s actual
  `node --test` command list directly; both were already present.
- Two pre-existing test-quality nits about `mark-findings-remediation.test.mjs`'s
  cloud-off tests (round 2 M1, re-raised rounds 3–4) — real but unrelated to
  anything this plan changed.
- The god-module size concern (round 1 M2, re-raised) — already tracked and
  accepted in `.file-size-baseline.json`, this plan's own growth justified
  and re-baselined with reasoning, not hidden.

**What was deferred as debt** (captured via `debt-auto-capture.mjs`, 48
entries total across 4 rounds — the same-file-batch nudge this plan itself
built fired correctly every round, 19→23→30→40 same-file citations,
confirming it works): a large, real, pre-existing correctness surface in
`runs-findings.mjs` — unscoped repo-identity checks in functions this plan
did not touch (`recordRunStart`, `recordAdjudicationEvent`), unverified
persistence outcomes in `reconcileRemediationProjection`, a fingerprint-only
dedup that also ignores `pass_name`/bucket at the level of DIFFERENT
functions than the one this plan fixed, check-then-write races in the
final-review credit-flow path, and non-atomic multi-statement writes this
plan's own fix touched but did not restructure (documented rationale each
round: fixing the atomicity is a larger architectural change than this
plan's declared two-bug + triage-process scope). **Flagged as a dedicated
follow-up** (`task_a8ffb5cb` via `spawn_task`) rather than silently left —
per this plan's own "Scope is decided by impact, not authorship" fix, every
deferral above states the two-part independence test explicitly, not
boilerplate.

## Census

| Pass/wave | State |
|---|---|
| structure | ineligible (`--passes backend,sustainability` scoped rounds 2–4) |
| wiring | ineligible (same) |
| backend (`be-services`) | completed, all 4 rounds |
| frontend | ineligible (backend-only plan scope) |
| sustainability | completed, all 4 rounds |
| quickfix (wave) | completed |
| duplication (wave) | skipped (`--passes`, rounds 2–4) |
| adjacency (wave) | skipped (`--passes`, rounds 2–4) |
| arch-memory | ineligible (`--scope=full` only; this ran `--scope diff`) |
| detector re-run (Step 5.0b) | completed — `blocked:false, checked:0` (no
  cross-cutting findings registered; every finding this plan raised was
  single-file) |

## Files changed (final)

`scripts/lib/store/runs-findings.mjs`, `scripts/debt-auto-capture.mjs`,
`.github/workflows/postgres-parity.yml`, `scripts/db-test-container.mjs`,
`AGENTS.md`, `skills/audit-code/SKILL.md`,
`skills/audit-code/references/debt-capture.md`, `skills/audit-plan/SKILL.md`
(+ `.claude/skills/**` regenerated copies, `.file-size-baseline.json`,
`.skill-consumer-refs-baseline.json`, `skills.manifest.json` — all mechanical
re-baselines), `tests/mark-findings-remediation.test.mjs`,
`tests/store-finding-verification-persistence.test.mjs`,
`tests/final-review-persistence-isolation.test.mjs`,
`tests/learning-store-exports.test.mjs`,
`tests/record-findings-write-boundary.test.mjs` (new),
`tests/debt-auto-capture-same-file-nudge.test.mjs` (new).

**Test suite**: 16,297 tests, 1 fail (expected — the manifest-hashes-
committed-source test compares against `git show HEAD`, which cannot match
an uncommitted working tree by construction; verified this holds even at a
clean HEAD checkout, resolves automatically once committed), 40 skipped
(DB-gated, no local `AUDIT_DB_TEST_URL` for the plain run). Separately: the
sanctioned `node scripts/db-test-container.mjs suites` run (proper
concurrency + destructive-suite isolation) — 0 failures, exit 0, including
both new/modified DB-integration tests.
