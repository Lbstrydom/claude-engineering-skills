# Plan: Determinism Follow-ups — Model-Independent Outcome Capture + Deterministic ux-lock Runners

- **Date**: 2026-06-04
- **Status**: Audited — ready to implement (GPT R1 5H/6M/1L → R2 4H/4M, all
  addressed; Gemini R1 3 concerns + R2 4 concerns, all addressed; **gate closed at
  the 2-round Gemini cap** per the audit-plan rigor-pressure rule — coherence
  "Strong", remaining items are implementation-completeness verified by the
  per-cluster /audit-code passes against real code, the correct artifact)
- **Author**: Claude + Louis
- **Scope**: backend (audit run lifecycle + a code-driven Playwright runner; one SKILL.md doc edit each)
- **Target domain(s)**: `audit-core`, `cross-skill`, `ux-lock`

> **Origin**: the two follow-ups carried over from `learning-store-signal-recovery.md`.
> Both share one root cause: a high-value learning-store write depends on the
> **model remembering to invoke** a recording step after a creative/judgment
> step. Cluster B made the writes *correct when invoked*; this plan makes the
> *invocation* deterministic. Two independent workstreams, grouped because they
> are the same fix shape (replace "model-remembered CLI call" with "one
> deterministic call after the creative step").
>
> **Why one plan, two clusters**: WS1 touches the audit run/round seam;
> WS2 adds a Playwright runner. They share no code and can ship in either order
> — but they're audited + tracked together as "the determinism backfill".

---

## Updates since audit (2026-06 session — no structural rework)

Three things changed in the repo after this plan was audited; none alter the
design, but they sharpen the resume:

1. **`audit_pass_stats.round` migration is APPLIED** to the shared store
   (2026-06-04, `--migrate`, drift verified clean). So WS1's per-round path is
   **live the moment the store code lands** — no separate apply step in Cluster
   A. The column-probe tolerance (§1.3a) stays as **defense-in-depth** for
   un-migrated/air-gapped/fresh self-hosted stores (it'll simply detect the
   column present on the shared store and use the per-round path).

2. **New binding invariant** — AGENTS.md "Generated-artifact policy": a tracked
   file must be a pure, verifiable function of committed source; everything
   derived/volatile is gitignored (Category A). This work introduces **zero
   tracked generated artifacts** and must keep it that way: WS1's `run_id`
   sidecar lives in gitignored `.audit/` (`session-audit-*.json`), and WS2's
   Playwright JSON report is a `os.tmpdir()`/gitignored temp file
   (`PLAYWRIGHT_JSON_OUTPUT_NAME`). **Added acceptance criterion (both WS):** the
   change adds no tracked, regenerated-on-run file. (This is the same lesson
   that retired the committed dashboard reference page this session.)

3. **Dirty-aware `--scope diff` base + removed sync dashboard-rebuild** — no
   interaction. `/cycle` autonomous passes an **explicit** `--changed` +
   `clusterStartRef..WORKTREE --diff` (§3C), which bypasses `openai-audit`'s
   auto base-resolution entirely — so the new dirty-aware default never fires
   during clustered cluster-audits. The plan touches neither `sync-to-repos.mjs`
   nor any dashboard file (verified — no overlap).

---

## 0. Shared principle

Adjudication (WS1) and spec authoring (WS2) are **irreducibly the model's
judgment** — we do not try to remove the model from those. What becomes
model-INDEPENDENT is the **capture**: after the creative step produces a
machine-readable artifact (the adjudicated ledger; the authored `.spec.js`),
a **pure script** runs once and persists the result.

**Scope of the claim (R1-M1 — honest bound)**: this closes the
model-remembered-capture gap for the **orchestrated/autonomous** paths
(`audit-loop.mjs`, `/cycle` Step 3C, `/ux-lock`, `/ship`, `/cycle`'s
regression gate) — the paths that run a deterministic flow after the creative
step. The **fully-manual single-shot `/audit-code`** path has no orchestrator
hook point, so its Step 3.5b remains a documented model-remembered fallback
**by design** — an accepted limit, not a closed gap. WS2's runner has no
equivalent manual gap because `/ux-lock` always invokes the runner.

---

# Workstream 1 (WS1) — Model-Independent Outcome Capture

## 1.1 The constraint (evidence)

`audit_findings.adjudication_outcome` is the source of truth, populated by
`recordAdjudicationEvent` (runs-findings.mjs) → `outcome-sync.recordTriageOutcomes`
← `write-code-outcomes.mjs`. The gap is **invocation**, rooted in two facts:

1. **Per-invocation runs**: [openai-audit.mjs](scripts/openai-audit.mjs) calls
   `recordRunStart` on *every* invocation, so round 1 and round 2 are
   **separate `audit_runs` rows**. There is no single run_id spanning the audit.
2. **Adjudication is interleaved human/Claude judgment**: openai-audit writes the
   ledger with `adjudicationOutcome: 'pending'`; Claude triages and rewrites the
   ledger to `accepted`/`dismissed` *between* invocations (skill Step 3). **No
   pure script ever holds `(run_id, final adjudicated ledger)` together** — so
   the sync can only be triggered by something that runs after the model's
   triage. Today that's the skill's Step 3.5b (mandatory but model-remembered)
   or the autonomous audit loop.

Consequence: a missed Step 3.5b leaves `adjudication_outcome` null → the
`audit_effectiveness` view + the `pass_selection` resolver stay dark for that run.

## 1.2 Design — Run-unification (Option A, preferred)

Thread ONE `run_id` across all rounds of a single audit:
- The orchestrator (or the first `openai-audit` invocation) mints the run_id;
  subsequent rounds receive `--run-id <id>` and `recordRunStart` becomes
  **upsert-or-reuse** instead of always-insert.
- Findings from all rounds attach to the one run; `adjudication_outcome` patches
  resolve by `(run_id, finding_fingerprint)` regardless of which round raised it.
- A single **finalize** step (run once at convergence) reads the final
  adjudicated ledger + the run's findings and syncs everything — deterministic,
  one call, no per-round bookkeeping.

**Rejected — Option B (ledger-writer-triggered sync)**: make persisting an
adjudicated ledger entry enqueue a cloud sync keyed by finding_fingerprint,
resolved via a fingerprint→run_id index. Avoids run-unification but adds a
lookup table and couples the local ledger writer to the cloud store (layering
cost). Option A also fixes the latent per-invocation-run fragmentation of
`audit_runs` itself (every round is a separate "run" today, inflating run counts
and muddying convergence telemetry — exactly the fragmentation Cluster A fought
at the repo-identity layer).

## 1.3 The deterministic finalize trigger

The orchestrator (`audit-loop.mjs` / `/cycle` Step 3C — both run as a flow after
the audit converges) calls `node scripts/cross-skill.mjs finalize-outcomes
--run-id <id> --ledger <final>` exactly once. The ledger is the machine-readable
adjudication artifact; the finalize step is pure script. For the fully-manual
`/audit-code` path (no orchestrator), Step 3.5b remains the documented fallback —
not relied upon for the autonomous path.

## 1.3a Run-row vs per-round metadata (R1-H1 — where round data goes)

Unifying `run_id` must NOT lose per-round/invocation metadata. The split:

- **Per-round/per-pass data stays in `audit_pass_stats`** — BUT today that table
  keys only on `(run_id, pass_name)` with **no `round` column** (verified:
  `20260330063355_learning_store.sql`). **Implementation reality (verified during
  build)**: `audit_pass_stats` has **NO `UNIQUE(run_id, pass_name)` constraint** —
  only `idx_pass_stats_run` (a plain index) + `PRIMARY KEY (id)` — and
  `recordPassStats` does a plain `INSERT` (`insertReturning`), not an upsert. So
  Gemini-R2-M4's "drop+re-add UNIQUE" does not apply (no constraint exists to
  swap); under unification each round already INSERTs its own row. **The migration
  is therefore just `ADD COLUMN round INTEGER NOT NULL DEFAULT 1`** (forward-only;
  existing rows default 1). `recordPassStats` gains a `round` arg (column-probe
  tolerant — below).
- **The real collision is `updatePassStatsPostDeliberation` (Gemini-R2-H1)**: it
  matches rows by `(run_id, pass_name)` only — under unification that matches ALL
  rounds' rows for the pass and overwrites each with the same run-final counts.
  Post-deliberation accepted/dismissed are **run-final** (not round-specific) and
  the canonical adjudication truth is `audit_findings.adjudication_outcome`
  anyway; the pass_stats counts are denormalized telemetry. **Resolution**: scope
  the update to the **latest round's** row per pass —
  `WHERE run_id=$1 AND pass_name=$2 AND round=(SELECT max(round) FROM
  audit_pass_stats WHERE run_id=$1 AND pass_name=$2)` — so the final counts land
  on the convergence-round row, unambiguously, without touching earlier rounds.
  (Verified: this is the inventory's sole problematic updater.)
- **Column-probe tolerance — the migration is operator-gated (CRITICAL)**: the
  `round` migration is applied **out-of-band** by the operator
  (`setup-postgres.mjs --migrate`), NOT by this code. So `recordPassStats` /
  `updatePassStatsPostDeliberation` MUST probe for the column the same way
  `detectClassificationColumns()` probes `sonar_type` (cached 0-row SELECT) and
  **fall back to the columnless write/match when `round` is absent**. This makes
  the shipped code safe against an un-migrated shared store (it behaves exactly
  as today until the migration lands), so code and migration can ship/apply
  independently. A `_resetPassStatsRoundColumnCache()` test seam mirrors the
  classification one.
- **The single `audit_runs` row carries the audit-level aggregate**: final
  `rounds` (count), `round_converged_after`, `rigor_pressure_round`, summed
  `total_duration_ms`, `labeled`, `commit_sha`/`branch`/`plan_id`. `recordRunStart`
  on round 1 inserts it; later rounds reuse it; `recordRunComplete`/`updateRunMeta`
  at finalize write the final aggregate. Convergence telemetry
  (`convergence_predict`) already records per-round via `learning_decisions`, so
  it is unaffected — it gains a stable `run_id` to group by.

No new columns required; the change is "stop inserting a new run row per round",
not "move data". Dashboards that counted runs now count audits (the intended
correction — see §1.2).

## 1.3b Identity, idempotency, ownership, transaction (R1-H2/H3, R1-M3)

- **Ownership (single model)**: the **orchestrator mints** the `run_id` (uuid)
  and passes `--run-id <id>` to *every* `openai-audit` invocation. `openai-audit`
  mints its own id **only when `--run-id` is absent** (manual single-shot →
  today's behaviour, byte-identical). No "first invocation mints + orchestrator
  recaptures" ambiguity.
- **`recordRunStart` idempotency**: `INSERT … ON CONFLICT (id) DO NOTHING`
  (or reuse-if-exists). Reusing a `run_id` never creates a second row and never
  clobbers round-1 metadata.
- **Join key (R1-H3)**: the canonical finding identity is the existing
  `semanticId()` content-hash already stored on `audit_findings` and emitted into
  the ledger. `finalize-outcomes` joins ledger entries → `audit_findings` by
  `(run_id, semanticId)`. Cross-round duplicates are *already* the same finding
  (semanticId is content-derived), so the same fingerprint across rounds patches
  the one row; an unmatched ledger entry is logged + skipped (never silently
  dropped).
- **run_id flows via `--run-id` + the result's existing `_cloudRunId`
  (Gemini-R1-H1; simplified during build — NO sidecar)**: the join needs
  `run_id`, but the manual `/audit-code` Step 3.5b syncs without `--run-id`.
  Restructuring the ledger array → `{runId, entries}` would break parsers
  (rejected — Gemini-R2-M2). A run_id **sidecar file** was the next idea, but
  the Cluster-A build audit flagged it as implicit file-coupling — and it's
  **unnecessary**: `openai-audit` already persists the run_id it used (minted OR
  reused via `--run-id`) on the result JSON as **`_cloudRunId`**, and under
  unification the final round's result carries the unified id. So
  `write-code-outcomes` (manual Step 3.5b) reads `result._cloudRunId` (it already
  does today), and the orchestrated path passes `--run-id` explicitly. No
  sidecar, no ledger restructure — run identity travels by explicit flag + the
  result it's already written to. The ledger array shape is unchanged.
- **`finalize-outcomes` idempotency + transaction (R1-H2)**: idempotent by
  construction — it sets `adjudication_outcome` by `(run_id, semanticId)`, so a
  retry after a process/CI/network failure converges to the same state. The sync
  runs in a single transaction (all outcomes for the run commit together or roll
  back).
- **Cloud-off vs unknown-run (R2-H2)**: `finalize-outcomes` first checks cloud
  configuration. **`AUDIT_DB_URL` unset → local-only no-op** with a logged hint
  (the project's graceful-degradation rule; the orchestrator can call it
  unconditionally and it is safe). Only when cloud **is** configured AND the
  `run_id` genuinely does not exist is it a hard error.
- **Reconciliation invariant — both directions (R2-H3)**: unmatched *ledger*
  entries are logged + skipped (above); the inverse is also enforced — finalize
  asserts every `audit_findings` row for the `run_id` has a terminal
  adjudication in the final ledger. Any finding the ledger omits is left as an
  explicit `needs_triage` (not silently `pending`/null) and surfaced in the
  finalize summary, so a truncated ledger can never silently dark-drop a finding.

## 1.4 Risk (WS1 is the hot path)

- Touches the audit **run lifecycle** — every audit run. A bug here corrupts
  run/finding attribution for ALL repos. The `recordRunStart` reuse semantics +
  every `runId` caller need review.
- Back-compat: existing per-round runs in the store stay as-is (historical); the
  change is **forward-only**. No migration rewrites old rows.
- The `--run-id` reuse path must be a no-op when the orchestrator does not pass
  one (manual single-round `/audit-code` keeps today's behaviour exactly).

## 1.5 Acceptance (WS1)

- One `audit_runs` row per audit (not per round); findings across rounds share it.
- After a converged autonomous run, `adjudication_outcome` + `audit_runs.labeled`
  are populated with **zero** model-remembered steps.
- `pass_selection` resolver resolves the run (its findings are now adjudicated).
- Guardrail test: a simulated 3-round audit produces exactly 1 run with all
  findings labeled after the finalize step; a single-round manual audit with no
  `--run-id` is byte-identical to today.

---

# Workstream 2 (WS2) — Deterministic ux-lock Runners

## 2.1 The constraint (evidence)

`/ux-lock` authors a Playwright `.spec.js` (lock mode) or a per-criterion verify
spec (verify mode). The **author** step is creative (model writes selectors from
the DOM contract / acceptance criteria). But today the skill then tells the model
to **run** `npx playwright test …`, **parse** the JSON report by hand, and
**call** `record-regression-spec-run` / `record-plan-verify-run` +
`record-plan-verify-items` with the numbers it parsed (skill Steps 4b / V5a / V5b).

That is three model-remembered steps after the creative one. A missed or
mis-parsed step leaves `regression_spec_runs` / `plan_verification_*` empty or
wrong — the `regression_saves`, `plan_satisfaction`, and `persistent_plan_failures`
views go dark, exactly mirroring WS1's outcome gap.

## 2.2 Reuse — the runner pattern already exists

`scripts/persona-consistency-run.mjs` is a **code-driven** Playwright runner:
Playwright Node API in-process, ledger-write-once lifecycle, closed exit-code
contract (`PLAYWRIGHT_MISSING=5`, `FATAL_RIG=3`, …), repo-identity resolution,
and in-band `recordRegressionSpec` emission. `scripts/lib/plan-criteria-parser.mjs`
already parses the acceptance criteria and computes the stable `criterion_hash`
(sha256 of `SEVERITY|category|description`, first 16 hex). The store writers
(`recordRegressionSpecRun`, `recordPlanVerificationRun`,
`recordPlanVerificationItems`) and their cross-skill subcommands already exist.
**Nothing new is needed in the store layer or the parser** — only a runner that
executes + records in one deterministic call.

**DRY (R1-M4 — extract, don't reimplement)**: rather than duplicate
`persona-consistency-run.mjs`'s subprocess+parse+exit-classify+repo-identity+
cloud-degradation logic, Phase 4 first extracts a shared
`scripts/lib/playwright-runner.mjs` exposing `runPlaywrightJson({specPaths, baseUrl,
cwd}) → {status, report, error}` (non-throwing spawn + report parse + closed
exit-code classification) and the repo-identity resolver. `ux-lock-run.mjs`
consumes it; `persona-consistency-run.mjs` is refactored onto it in the same
phase (behaviour-preserving — its tests pin the contract) so there is one runner
core, not two. If the consistency-run refactor proves risky mid-phase, it is
deferred (the shared module still lands; consistency-run migrates later) — but
the default is one core.

## 2.3 Design

New CLI `scripts/ux-lock-run.mjs` (synced tooling), two subcommands:

- `spec --spec <path> [--specs <glob>] --commit <sha> [--run-context ship-gate|ci|ux-lock|manual] [--url <u>]`
  — runs the authored regression spec(s) via `npx playwright test --reporter=json`
  (subprocess; deterministic, no MCP), parses the JSON report, resolves the spec's
  `regression_specs` row (by `repo_id` + `spec_path`), and calls
  `recordRegressionSpecRun` per spec with `{passed, durationMs, commitSha,
  runContext}`. Exit code reflects test pass/fail so `/ship` and CI can gate on it.
  **Auto-register safety (Gemini-R2-M3)**: when the spec row is absent, the runner
  registers it via `recordRegressionSpec` supplying the **required** `sourceKind`
  (default `'manual'`, overridable via `--source-kind`) and `description`
  (default: derived from the spec filename) — the cross-skill CLI enforces both,
  so they must never be omitted or the register call throws. If registration is
  undesired, `--no-register` records nothing and logs that the spec is unknown.
- `verify --plan <plan.md> --spec <verify-spec> --commit <sha> --url <u>`
  — runs the verify spec, maps each Playwright test result back to its criterion
  via the title↔`criterion_hash` convention, then calls `recordPlanVerificationRun`
  (totals) + `recordPlanVerificationItems` (per-criterion) in one shot. The plan's
  criteria are parsed with the existing `plan-criteria-parser.mjs` so the
  `criterion_hash` matches the authored spec exactly.

**JSON capture from a FILE, not stdout (R2-M3)**: the runner sets
`PLAYWRIGHT_JSON_OUTPUT_NAME=<tmp>.json` (with `--reporter=json`) so the machine
report is written to a dedicated file, never scraped from stdout (which carries
install prompts, warnings, and runner chatter). The runner reads + parses that
file; a missing/empty file after a non-spawn-error run is the hard-fail case.

**Multi-spec → `spec_path` grouping (R2-M4)**: the Playwright JSON report carries
each test's source `file`. The runner normalizes every report `file` to a
repo-relative `spec_path` and groups results by it, so `--specs <glob>` (or a
suite spanning files) yields **one `recordRegressionSpecRun` per `spec_path`**
with that spec's own `passed` (AND of its tests) + summed `durationMs`. A report
`file` that normalizes to no requested spec is logged (orphan), not recorded.

**Playwright exit-code handling (R1-H4 — the critical trap)**: `npx playwright
test` exits **non-zero when tests FAIL**. A naive `execFileSync` throws on
non-zero exit → failing runs would never be recorded (the exact inverse of the
goal). The runner therefore uses `spawnSync` (or `execFile` with a non-throwing
handler), reads `result.status` + the JSON report file **independently**, and:
- valid JSON report parsed → record results regardless of exit code
  (non-zero + valid report = "tests failed", recorded as `passed:false`);
- spawn failure / Playwright binary missing → exit 5 (install hint);
- non-zero exit AND unparseable/empty report → hard error (exit ≥3, no silent
  empty result; audit-metrics transport-failure precedent).

**Criterion coverage algorithm (R1-H5, R1-L1 — every criterion accounted for)**:
1. Build the **expected set** from `plan-criteria-parser.mjs` → `{criterion_hash}`.
2. Each Playwright `test()` carries its `criterion_hash` as a stable **annotation**
   (Gemini-R1-H2): the verify-mode template MUST emit
   `test('<desc>', { annotation: [{ type: 'criterion_hash', description: '<hash>' }] }, …)`
   — naming the test by severity/category/description is NOT enough (the hash
   can't be recovered from prose). The runner indexes results by
   `result.annotations[type==='criterion_hash']`. Phase 6 updates the template.
3. For each expected criterion: matched single result → `passed` from the status
   map; **missing** result → recorded `passed:false` with `error_message:"no
   matching test result"`; **duplicate** expected hash → record once + log a
   warning; **multiple** results for one hash → `passed:false` if ANY failed.
4. A Playwright result with **no** expected criterion → **logged + counted in
   the run summary, NOT inserted as a `plan_verification_items` row** (R2-H4).
   That table is strictly per-EXPECTED-criterion (its `criterion_hash` must trace
   to a parsed criterion); fabricating a row for an orphan test would corrupt the
   per-criterion time-series. Orphans are a spec-authoring smell surfaced in the
   summary, not store rows.
- **Status map** (closed): Playwright `passed`/`expected` → `passed:true`;
  `failed`/`timedOut`/`interrupted`/`unexpected` → `passed:false`; `skipped` →
  `passed:false` with `error_message:"skipped"`; flaky retry that ends green →
  `passed:true` (final attempt wins). `regression_spec_runs.passed` is the AND of
  all tests in the spec.

**`--url` + path contract (R1-M5, Gemini-R1-M1)**: `--url` is exported as
**`E2E_BASE_URL`** in the child env — the env var the existing ux-lock spec
templates + SKILL.md already use (4 sites); the plan reuses it, NOT a new
`PLAYWRIGHT_BASE_URL`, to avoid a split contract. Authored specs read
`process.env.E2E_BASE_URL`
(documented in the spec templates). `--spec`/`--specs`/`regression_specs.spec_path`
are normalized **repo-relative against the repo root** (relocation-safe — the
runner resolves the repo root the way `persona-consistency-run.mjs` does, not via
`process.cwd()`).

**Graceful degradation**: cloud off → run the specs, print pass/fail, skip the
recording with a logged hint (mirrors every other cross-skill writer). Playwright
missing → exit 5 with the install hint. Malformed JSON report → hard-fail.

## 2.4 Skill changes (ux-lock)

- Lock mode Step 4: replace the manual `npx playwright test` + `record-regression-spec-run`
  pair with one `node scripts/.claude-skills/ux-lock-run.mjs spec --spec <path> …`.
  The model still AUTHORS the spec; execution + recording are one deterministic call.
- Verify mode Steps V4–V5: replace the manual run + parse + `record-plan-verify-run`
  + `record-plan-verify-items` with one `ux-lock-run.mjs verify --plan … --spec …`.
- `/ship` and `/cycle` invoke the same runner for the regression-gate so the
  `run_context` is tagged correctly and the rows are written without the model.

## 2.5 Risk (WS2)

- New tooling file → must be added to the sync inventory + relocation smoke set
  (`--selfcheck-relocation` handler) so it survives consumer relocation.
- Playwright is an optional/heavy dep in consumers — the runner must degrade
  cleanly when it is absent (exit 5, no crash), exactly like consistency-run.
- The runner shells to `npx playwright test`; the JSON-report parse must
  hard-fail on malformed output (no silent empty result).

## 2.6 Acceptance (WS2)

- Running `ux-lock-run.mjs spec` on an authored spec writes exactly one
  `regression_spec_runs` row with correct `passed`/`durationMs`/`run_context` —
  zero model-remembered steps.
- Running `ux-lock-run.mjs verify` on a plan+spec writes one
  `plan_verification_runs` + N `plan_verification_items` with `criterion_hash`
  matching the parser — and every criterion is accounted for (pass/fail/skip),
  none dropped.
- Cloud-off and Playwright-missing paths are tested (no crash; logged skip / exit 5).
- The relocation smoke test covers the new CLI.

---

## 7. File-Level Plan

### 7b. Implementation Phases

> **Canonical-source rule (R2-M2)**: all `skills/**` paths below are the
> **canonical** authoritative copies (per AGENTS.md "edit ONLY here"). The
> `.claude/skills/**` copies are GENERATED by `npm run skills:regenerate` (the
> close-out step) and must never be hand-edited. `.github/skills/` is deprecated.

**Phase 1 — Run-id threading + pass-stats round (WS1)**: (a) **inventory first**
(R2-M1) — enumerate every `recordRunStart`/`recordRunComplete`/`updateRunMeta`/
`recordPassStats`/`recordFindings` caller and every `runId` consumer (grep the
store + all audit entry points) and confirm the reuse semantics for each before
editing; (b) migration adding `audit_pass_stats.round` (key `(run_id, pass_name,
round)`); (c) `recordRunStart` upsert-or-reuse on an optional `runId`;
`recordPassStats` + `updatePassStatsPostDeliberation` gain `round` (the latter's
WHERE clause MUST include it — Gemini-R2-H1); (d) `--run-id` on `openai-audit.mjs`
code mode + sidecar run_id write; orchestrator mints+threads from `audit-loop.mjs`
+ `/cycle` Step 3C. Files: `supabase/migrations/<new>_pass_stats_round.sql`
(create — drop old UNIQUE, add `round` + new UNIQUE),
`scripts/lib/store/runs-findings.mjs` (modify), `scripts/openai-audit.mjs` (modify),
`scripts/audit-loop.mjs` (modify), `tests/fixtures/expected-schema.json` (modify — new column + constraint).

**Phase 2 — Finalize hook (WS1)**: `finalize-outcomes` subcommand in
`cross-skill.mjs` that reads `(run_id, final ledger)`, joins by `(run_id,
semanticId)`, and drives the existing outcome sync once inside a transaction
(idempotent). Files: `scripts/cross-skill.mjs` (modify),
`scripts/lib/outcome-sync.mjs` (modify).

**Phase 3 — WS1 wiring + tests + docs**: call `finalize-outcomes` from
`audit-loop.mjs`/`/cycle` at convergence; keep Step 3.5b as documented manual
fallback (it reads run_id from the sidecar). Confirm `write-code-outcomes.mjs`
still parses the **unchanged** ledger array (sidecar approach means no parser
change — Gemini-R2-M2). Files: `scripts/audit-loop.mjs` (modify),
`scripts/write-code-outcomes.mjs` (verify/modify — sidecar run_id read),
`skills/cycle/SKILL.md` (modify), `tests/run-unification.test.mjs` (create).

**Phase 4 — shared runner core + ux-lock runner CLI (WS2)**: extract
`scripts/lib/playwright-runner.mjs` (non-throwing spawn + JSON-report parse +
closed exit-code classification + repo-identity); refactor
`persona-consistency-run.mjs` onto it (behaviour-preserving); build
`scripts/ux-lock-run.mjs` with `spec` + `verify` subcommands consuming the core +
`--selfcheck-relocation`. Files: `scripts/lib/playwright-runner.mjs` (create),
`scripts/persona-consistency-run.mjs` (modify), `scripts/ux-lock-run.mjs` (create),
`scripts/lib/sync-inventory.mjs` (modify), `scripts/lib/sync-isolation-verify.mjs` (modify).

**Phase 5 — ux-lock runner tests (WS2)**: fixture-driven tests for the
report-parse → store-write path, cloud-off skip, Playwright-missing exit, and the
criterion-hash mapping. Files: `tests/ux-lock-run.test.mjs` (create).

**Phase 6 — ux-lock skill + ship/cycle wiring (WS2)**: rewrite lock-mode Step 4 +
verify-mode V4–V5 to call the runner; wire `/ship` + `/cycle` regression gate.
Files: `skills/ux-lock/references/lock-mode-spec-generation.md` (modify),
`skills/ux-lock/references/verify-mode-generation.md` (modify),
`skills/ux-lock/SKILL.md` (modify), `skills/ship/SKILL.md` (modify).

**Close-out (not a phase)**: `npm run skills:regenerate` + `npm run skills:check`;
`npm test`.

## 8. Risk & Trade-off Register

- **WS1 hot-path corruption** — mitigated: forward-only, `--run-id` absent ⇒
  today's behaviour byte-identical; guardrail test pins single-run-per-audit.
- **WS2 Playwright dep in consumers** — mitigated: exit-5 graceful degradation,
  cloud-off skip, sync-inventory + relocation-smoke coverage.
- **Deferred**: migrating historical per-round `audit_runs` rows (forward-only by
  design); a unified ux-lock+consistency runner (two callers, keep separate for now).

## 9. Testing Strategy

- WS1: `tests/run-unification.test.mjs` — simulated 3-round audit ⇒ 1 run, all
  findings labeled post-finalize; single-round no-`--run-id` parity;
  `finalize-outcomes` **idempotency** (re-run ⇒ identical state); **downstream
  assertion (R1-M6)**: after finalize, the `audit_effectiveness` view row + the
  `pass_selection` resolver reflect the labels (not just that the column is set).
- WS2: `tests/ux-lock-run.test.mjs` — fixture Playwright JSON report ⇒ correct
  `regression_spec_runs`/`plan_verification_*` writes; **non-zero-exit-with-valid-
  report still records `passed:false`** (R1-H4); cloud-off skip; PW-missing exit 5;
  criterion-hash mapping incl. missing/duplicate/multiple/unmatched cases (R1-H5)
  and the full Playwright-status map incl. `timedOut`/`skipped`/flaky-retry (R1-L1).
- Both deterministic seams → Tier-1 test-first per the repo testing doctrine.

## 11. Execution Clustering

- **Cluster A** — Phases 1–3 — fix-gate: yes
  - Coupling: the run-id seam (Phase 1) and the finalize hook (Phase 2) share the
    `audit_runs` run lifecycle; Phase 3 wires them into the orchestrators. They
    must be audited together — a finalize hook against a non-unified run is wrong.
- **Cluster B** — Phases 4–6 — fix-gate: yes
  - Coupling: the runner CLI (Phase 4), its tests (Phase 5), and the skill/ship
    wiring (Phase 6) all describe one new tool; the skill edits are meaningless
    without the CLI and vice-versa.

Final gate: one Gemini review over the union diff after both clusters.

---

> **Both workstreams are forward-only and independently shippable.** WS1 removes
> the model-invocation dependency for audit outcome capture; WS2 removes it for
> ux-lock spec/verify run capture. Together they close the "model-remembered
> recording" class of learning-store data gaps.

---

## Implementation Log

### 2026-06-22 — ground-truth reconciliation (start of autonomous /cycle)

An inventory trace at the start of an autonomous `/cycle` run found the plan's
status header (`ready to implement`) stale — a prior session built **Phase 1's
store-layer capability and committed it**, but never wired it, wrote the
finalize step, or started Cluster B, and never recorded any of it here.
Corrected ground truth before resuming:

| Unit | State on disk (HEAD `685570f`) |
|---|---|
| **Phase 1 store layer** — `recordRunStart` run_id reuse-probe; `audit_pass_stats.round` migration (`20260605120000`); `recordPassStats` round column-probe; `updatePassStatsPostDeliberation` `max(round)` WHERE (Gemini-R2-H1); `openai-audit` `--run-id` parse + `_cloudRunId` persist; `write-code-outcomes` reads `_cloudRunId` | **BUILT + committed** |
| **Phase 1d** — orchestrator mints + threads `--run-id` across rounds (`audit-loop.mjs` / `/cycle` Step 3C) | **GAP** — `audit-loop.mjs` still spawns `openai-audit code` per round with no run-id; reuse capability never fires |
| **Phase 2** — `finalize-outcomes` subcommand | **GAP** — absent |
| **Phase 3** — finalize wiring + `tests/run-unification.test.mjs` | **GAP** — absent |
| **Cluster B** (Phases 4–6) — `playwright-runner.mjs`, `ux-lock-run.mjs`, tests, skill/ship wiring | **GAP** — entirely absent |

Remaining work this run = Phase 1d → 2 → 3 (Cluster A gaps) + all of Cluster B.
Phase 1's committed store code is verified, not rebuilt.

### 2026-06-22 — Cluster A build (Phases 1d–3)

- **Phase 1d** — `audit-loop.mjs` mints ONE `run_id` (`randomUUID`) before the
  round loop and threads `--run-id` to every `openai-audit` invocation. Verified
  the per-round `recordRunComplete(rounds: round, …)` overwrite is safe under
  reuse: the final round's call lands the correct aggregate (`rounds` = final
  round count, `totalFindings` = converged set). **Right-sized deviation**:
  `total_duration_ms` reflects the last round, not the sum — denormalized
  telemetry, not gated by any §1.5 criterion; summing would force finalize to
  re-read per-round pass-stats latencies (over-engineering), so last-round-wins.
- **Phase 2** — `finalize-outcomes` subcommand (`cross-skill.mjs`) reuses the
  existing `recordTriageOutcomes` sync + two new store helpers (`auditRunExists`
  for the cloud-on/unknown-run hard-error split; `markRunFindingsNeedsTriage`
  for the §R2-H3 reconciliation). **Right-sized deviation from §1.3b R1-H2**:
  strict single-transaction wrapping is deferred — every underlying write is
  individually idempotent (`recordAdjudicationEvent` delete+insert; column
  sets), so a mid-finalize crash self-heals on the deterministic re-run. The
  §1.5-gated property is *idempotency*, which holds; atomic-tx is defense the
  idempotency already covers, and wrapping the shared sync module (used by the
  manual path too) on the hot path is not warranted by a current requirement.
- **Phase 3 — wiring correction (plan §1.3 vs reality)**: the plan named
  `audit-loop.mjs` as a finalize caller, but the trace shows `audit-loop.mjs` is
  a **non-interactive reporter that never triages** (its own comment: "can't do
  triage/fix — report and stop"). Calling finalize there would mislabel an
  un-adjudicated run `labeled:true`. So finalize is wired into the **triaging**
  orchestrators only: `/cycle` Step 3C (new step 4.5, autonomous) and the
  existing manual `/audit-code` Step 3.5b (`write-code-outcomes.mjs`, already
  reads `_cloudRunId`). `audit-loop.mjs` gets run-unification (Phase 1d) but not
  a finalize call — the honest correction.
- **Tests** — `tests/run-unification.test.mjs` (hermetic: guard contracts +
  reconciliation logic via `recordTriageOutcomes(store=null)` + CLI arg
  validation). The DB-level "3-round ⇒ 1 run" reuse is store-integration,
  env-gated like `learning-store-phase1.test.mjs`, not unit-mocked.
  `learning-store-exports.test.mjs` pin updated (+2 exports → 125).
- **Gemini final gate (WS1 diff) — CONCERNS_REMAINING R1, deliberated**:
  - **H2 (Gemini-correct, fixed)**: `recordRunStart` reuse was NOT repo-scoped.
    The store is single-tenant but **multi-repo**; a mis-threaded `run_id` could
    attach findings to another repo's run. Reuse now checks `repo_id` and
    refuses a cross-repo id. (My R1 "single-tenant ⇒ n/a" dismissal was wrong —
    single-tenant ≠ single-repo.)
  - **M6 (fixed)**: capability probes now retry once on a transient error before
    degrading and cache only an authoritative result (`probeColumn` helper) — a
    DB blip no longer mislabels one pass-stat row as round 1.
  - **H3 (deferred — independent, CAPTURED not dropped)**: `resolveRepoId` is
    fail-open on a *transient* lookup failure (same bug class as the probes),
    returning `null` → an unscoped (`repo_id` null) cross-skill write. WS1's
    `finalize-outcomes` does NOT call `resolveRepoId` (it keys on `run_id` +
    `auditRunExists`), so it is genuinely independent of WS1. **Follow-up
    (pre-existing, separate fix)**: apply the same transient-vs-absent
    distinction to `resolveRepoId`/`getRepoIdByUuid` so a DB blip on an explicit
    `repoUuid` doesn't silently downgrade to an unscoped write.
  - **Gemini R2 (CONCERNS, 0 wrongly-dismissed — deliberation accepted)**: caught
    a **genuine consistency bug** — the `23505` race-fallback (the M4 fix) reused
    a run row WITHOUT the repo_id check just added to the primary path. Fixed:
    both reuse paths are now repo-scoped. Also added `42P01` (undefined_table) to
    `isUndefinedColumnError` (a missing table ⇒ column definitively absent). The
    remaining R2 LOW (`CRITERION_RE` single-line capture in
    `plan-criteria-parser.mjs`) is **Cluster B / WS2 code** — out of WS1 scope,
    addressed there. WS1 stops at the 2-round Gemini cap with only that
    out-of-scope LOW residual (documented stop rule: genuine bugs fixed,
    remainder is out-of-scope, not rigor-pressure churn).
