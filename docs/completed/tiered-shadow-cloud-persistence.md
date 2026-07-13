# Tiered-shadow cloud persistence + report CLI cross-repo aggregation

- **Status**: Complete
Date: 2026-07-13

## Context

Following the `allowTiered` fix (docs/completed/allow-tiered-callsite-gate.md),
the user asked to verify Supabase wiring and how progress toward the
plan's pre-registered 10-15-run shadow-validation window would be tracked
across the 3 local repos. This surfaced two things:

1. The shadow-comparison log (`tiered-shadow-compare.mjs`) was local-JSONL-
   only by original design — no way to count total runs across repos.
2. Once real Supabase writes were added, importing `tiered-shadow-
   report.mjs` for its exported functions turned out to ALSO execute the
   full CLI (`main()` had no entry-point guard) — a second real incident-
   class bug (a test importing this file would have made a real cloud
   query using the test runner's own argv).

## Changes

- New table `tiered_shadow_observations` (migration
  `20260713140000_tiered_shadow_observations.sql`) — bare `repo_id` (no
  FK, mirrors `model_eval_runs`; this DB is single-tenant).
- New store module `scripts/lib/store/tiered-shadow.mjs` —
  `appendTieredShadowObservation` (best-effort, never throws) +
  `getTieredShadowObservations` (explicit `repoIds` list, never an
  ambient "all repos" scan).
- `tiered-shadow-compare.mjs`: `recordObservation` now writes to BOTH the
  local JSONL (always) and Supabase (best-effort) — local remains the
  fallback when cloud is off.
- `tiered-shadow-report.mjs`: cloud-first — resolves repo identity for
  the current repo + any `--repos <path,...>` siblings, queries Supabase
  across all of them, falls back to local-only when cloud is off or
  `--log` is explicitly passed. Fixed the missing CLI-entry-point guard
  (`process.argv[1] === import.meta.url` pattern, matching
  `model-eval-auditor.mjs`).
- Archived the 58-entry contaminated local log (real API-calling test
  noise from the `allowTiered` incident's diagnosis window) to
  `.audit/tiered-shadow-log.pre-incident-test-noise.jsonl`; a synthetic
  DB smoke-test row was deleted after verifying the write/read path.

## Tests

- `tests/store-tiered-shadow.test.mjs` — DB-free (schema validation +
  cloud-off graceful degradation).
- `tests/tiered-shadow-compare.test.mjs` — air-gapped (`AUDIT_DB_URL=''`
  via dynamic import, matching the established convention exactly,
  including WHY a static import wouldn't reliably apply the override).
- `tests/tiered-shadow-report.test.mjs` — new regression test for the
  import-safety bug (importing the module must never invoke `main()`).

Full suite: 5018 passed, 0 failed, 20 pre-existing skips (one transient
flake on an interim run did not reproduce). Migration applied to the live
Supabase project; end-to-end write/read verified for real (smoke-test row
deleted afterward).

## Audit trail

`/audit-code --scope diff --max-rounds 1` (round 1, GPT): SIGNIFICANT_ISSUES,
17 findings. Triage (full rationale in the round's adjudication ledger):

- **H1/L1 dismissed (false positive)**: the auditor's `--scope diff`
  round-1 file inventory doesn't see brand-new untracked files outside the
  diff patch — the migration and archived-log files both exist on disk
  (verified directly) and were flagged as "missing" only because of this
  scope gap, not because they're absent.
- **M1/M3/M4/M5 fixed**: `getTieredShadowObservations` now wraps its query
  in try/catch (`{ok:false, cloud:true, rows:[], error}` instead of
  throwing, matching the module's own never-throws contract) and returns
  `truncated:true` when the query LIMIT is hit; the report CLI falls back
  to the local log with a warning on a cloud-read failure and surfaces the
  truncation warning. The tautological `assert.ok(true)` import-safety
  test was replaced with a subprocess test that proves no I/O occurs on
  import.
- **M2 deferred (documented, in-scope)**: full idempotency-key +
  sync/replay reconciliation between the local JSONL and cloud is
  disproportionate (MAJOR effort) for a single-operator ~15-run manual
  counting tool; the existing loud stderr warning on a cloud-append
  failure is the accepted mitigation.
- **M6-M13, L2, L3 deferred (out-of-scope, pre-existing)**: domain-map
  (`allowedDeps`) drift findings the Architecture pass surfaces on any
  audit touching `scripts/lib/store/**`/`dashboard/**`/`scripts/lib/**` —
  this batch adds one more caller through an already-existing, already-
  tolerated pattern; fixing the domain-map declarations is independent of
  this feature's correctness.

Step 7 Gemini final review: **APPROVE** (`deliberation_was_fair: true`,
`claude_bias_detected: false`, "Production ready"). One new LOW finding
(G1): the pre-existing `--selfcheck-relocation` guard sat before the
file's static imports — ESM hoists static imports ahead of any top-level
statement, so the guard never actually skipped module evaluation as
intended, and this batch's new imports (`lib/store/repo.mjs`,
`lib/store/tiered-shadow.mjs`) made that more consequential. Fixed by
moving the guard to the head of `main()`, matching the established
convention in `check-setup.mjs`/`model-eval-auditor.mjs`. Round 2 not
needed — single mechanical fix, re-verified directly
(`--selfcheck-relocation` + the CLI/relocation-guard test suites), full
suite re-confirmed green (5018/0/20).

17 GPT-round findings + outcomes recorded to the cloud learning store via
`write-code-outcomes.mjs` (17/17 labelled).
