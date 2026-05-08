# Plan: Adaptive Learning Expansion v1

- **Date**: 2026-05-08
- **Status**: Approved-with-known-debt (v2.4 — 4 Gemini deliberation rounds; loop stopped per /audit-plan SKILL guidance after persistent rigor-pressure)
- **Phasing**: This master plan is split into 3 sub-plans for staged delivery — see §0a below. Each sub-plan is a self-contained `/cycle` invocation; this master plan stays as the canonical reference for engineering principles, sustainability notes, risk register, and promotion gates.
- **Author**: Claude + Louis
- **Scope**: backend (js-ts; consumes audit-orchestration + learning-store + supabase domains)

> **Note for code auditors**: paths under `.github/workflows/`, `secrets/`,
> `src/auth.js`, illustrative `cluster_label` values, and `audit_id` are
> mentioned only as fixtures or auditor-visible naming hints — they are
> NOT all files this plan creates. The actual files this plan creates
> are listed in §6 (File-Level Plan) only.

---

## 0a. Phasing — three /cycle invocations

This master plan is delivered as 3 phases. Each phase is a self-contained sub-plan that runs as its own `/cycle`. Phases are sequential (later phases depend on earlier ones) but each ships standalone value.

| Phase | Sub-plan | What ships | Dependencies | Est. effort |
|---|---|---|---|---|
| **1. Foundation + Auto-Deferral + Weekly Review** | [`adaptive-learning-phase-1-foundation.md`](./adaptive-learning-phase-1-foundation.md) | Schema migration (full); `decision-logger` primitive; `deferral-classifier` + stored procs; weekly review CLI + GH workflow; `pass_selection` telemetry hook; `getWriteClient()` separation. **Biggest UX win** — replaces per-finding deferral prompts. | none (first phase) | ~2 days impl + audit |
| **2. Live Quickfix Learner** | [`adaptive-learning-phase-2-quickfix.md`](./adaptive-learning-phase-2-quickfix.md) | `beta-posterior.mjs` + `cold-start.mjs` primitives; `quickfix-stats.mjs` (the one live learner); `quickfix-patterns.mjs` synchronous-hot-path integration with persisted state machine; `backfill-outcomes.mjs` for hit→outcome reconciliation. | Phase 1 (schema, decision-logger, learning-store) | ~1 day impl + audit |
| **3. Replay Framework + Remaining Telemetry** | [`adaptive-learning-phase-3-replay.md`](./adaptive-learning-phase-3-replay.md) | `replay.mjs` engine + CLI; `convergence_predict` telemetry hook in `openai-audit.mjs` per-round; `arch_memory_band` telemetry hook in `neighbourhood-query.mjs`; `backfill-outcomes.mjs` extended with arch-memory detector. **Enables v2 promotions.** | Phase 1; reuses Phase 2's `beta-posterior.mjs` + `backfill-outcomes.mjs` | ~1 day impl + audit |

**Per-phase /cycle invocation**:

```bash
/cycle code docs/plans/adaptive-learning-phase-1-foundation.md
# (after Phase 1 ships)
/cycle code docs/plans/adaptive-learning-phase-2-quickfix.md
# (after Phase 2 ships, OR in parallel with Phase 2 since it touches different files)
/cycle code docs/plans/adaptive-learning-phase-3-replay.md
```

Each sub-plan has its own File-Level Plan + ACs + test plan scoped to what THAT phase ships. The master plan (this doc) remains the source of truth for the v1 vision, principles, sustainability, and v2 graduation gates — sub-plans link back here rather than copying the content.

---

## 0. Revision Notes (v2 — multiple iterations)

### Audit history

| Round | Verdict | Key issue class |
|---|---|---|
| GPT R1 | NEEDS_REVISION (H:6 M:4 L:1) | Initial scope-too-wide concerns |
| GPT R2 | SIGNIFICANT_GAPS (H:4 M:3) | Fix sufficiency |
| GPT R3 | NEEDS_REVISION (H:5 M:2 L:1) | Rigor pressure → STOP per SKILL |
| Gemini v1 | CONCERNS_REMAINING | 2 MEDIUM (regex, RLS), 1 wrongly-dismissed (CLI stdout) |
| Gemini v2 | REJECT | Hallucinated SQL columns, broken stored proc |
| Gemini v3 | CONCERNS_REMAINING | Cross-tenant leak, API contract, idempotency |
| Gemini v4 | REJECT | Views security_invoker, sync hot-path, CI outbox loss |

After Gemini v4, the audit loop was halted per /audit-plan SKILL guidance (Gemini cap is round 2; we ran 4). All Gemini-v4 concrete findings have been addressed in the plan body. Each subsequent round surfaced architectural concerns at progressively deeper levels of detail rather than re-raising the same issues — interpretation: rigor pressure, not unfixed bugs. Plan status flipped to **Approved-with-known-debt**: implementation may proceed; residual deferred concerns are tracked in §10 Out of Scope.



This plan was revised after a 2-round multi-LLM brainstorm (OpenAI gpt-5
+ Gemini 2.x Pro) pressure-tested the v1 strategic choices. Key changes
vs v1:

| Change | Reason |
|---|---|
| **Cut from 5 inference loops to 1 live (quickfix) + 4 telemetry-only loggers** | Both LLMs converged: shipping 5 concurrent learners locks in assumptions before validation; the cost of building inference is non-trivial (correctness tests, replay infra, on-call). Logging is cheap; inference is expensive. |
| **Drop pass-selector inference from v1 (telemetry only)** | Reward-signal frequency imbalance: dev-action signal fires per PR, persona signal fires per persona-test session. In repos with sparse persona testing (e.g. `claude-audit-loop` = zero persona sessions), reward collapses to dev-laziness signal → Goodhart trap. Also: persona density is per-repo, so the gate must be per-repo when we promote. |
| **Drop convergence-predictor inference from v1 (telemetry only)** | Both LLMs flagged as low-ROI. Existing "stop at rigor pressure" heuristic already works; this learner solves a problem that isn't pressing. |
| **Drop arch-memory threshold tuning inference from v1 (telemetry only)** | "Re-import within 30min" success heuristic is fragile (Gemini); modifies the *primary* defence against architectural drift, so a bad tuner pollutes architecture (Claude's R1 take). |
| **Add `learning_decisions` generic log table + offline replay framework** | Gemini: shadow data without replay infra is dead weight. OpenAI: per-learner canaries + IPS logs are non-negotiable. So: build the keystone infra in v1, even though only 1 learner uses it live. |
| **Add `persona_density_per_repo` view** | Per-repo gate prerequisite for promoting pass-selector in v2. Cheap to add now; expensive to retrofit later. |
| **Sticky-issue weekly review payload cap of 7** | Both yielded on "kill it" given local evidence (memory-health.yml works), but warned: auto-deferral could flood the channel. Hard cap protects engagement culture. |

Net file count: v1 was 14 new files; v2 is **12 new files (1 live learner, 4 telemetry-only loggers via shared primitive)**. The deferred 3 learners get promoted from v2 onward, gated on the data their telemetry-only loggers will have collected.

---

## 1. Context Summary

**Why this plan**: We have Thompson Sampling on prompt-variant selection
today (`scripts/bandit.mjs`) and ~17 Supabase tables capturing audit
pipeline outcomes, but most decisions in the pipeline are still
hardcoded. The bandit pattern (define arms, define context features,
define reward, hook into the decision point) is general — it can wrap
any hardcoded decision where we have outcome data.

**What v1 actually ships** (per §0 revision):
- **One live learner**: quickfix pattern weights (cleanest reward signal — accept/suppress is binary).
- **Four telemetry-only loggers** (decision logged, no live action) for: pass selection, convergence prediction, arch-memory thresholds, auto-deferral classifier outcomes. These accumulate cold-start data so v2 promotion isn't a 3-month wait.
- **Auto-deferral + weekly sticky issue**: replaces mid-audit "defer this finding?" prompts.
- **Offline replay framework**: keystone infrastructure for graduating telemetry-only loggers to live.
- **Per-repo persona-density view**: gate prerequisite for any future learner whose reward depends on user-impact signal.

### Detected scope + stack

- **Scope**: backend (explicit `--scope=backend`)
- **Stack**: js-ts (per `npm run detect-stack`)
- **Target domain(s)**: `audit-orchestration`, `learning-store`, `shared-lib`, `supabase`
- ⚠ **Cross-domain work** — touches 4 domains; intentional for a learning-system feature that spans the whole pipeline. Each touch is bounded to its domain.
- ⚠ **Untagged path**: `.github/workflows/learning-weekly-review.yml` — `.github/workflows/**` doesn't match any rule in `.audit-loop/domain-map.json`. Same situation as `architectural-drift.yml` and `memory-health.yml` workflows — accepted as v1 limit.

### Architectural-memory neighbourhood (Phase 0.5)

22 close hits (similarity 0.55–0.78), all expected — every one of them
is in `learning-store.mjs` or `openai-audit.mjs`. Notable reuse-rather-
than-new candidates:

| Existing symbol | Path | Why it matters |
|---|---|---|
| `runMultiPassCodeAudit` | `scripts/openai-audit.mjs:773-1864` | The wave dispatcher I touch with **logging only** in v1 (`recordDecision('pass_selection', ...)`) — no behavior change. |
| `recordPassStats` / `updatePassStatsPostDeliberation` / `recordRunComplete` | `scripts/learning-store.mjs` | Existing finding-lifecycle write helpers; the new auto-deferral flow extends them, doesn't replace them. |
| `syncBanditArms` / `loadBanditArms` | `scripts/learning-store.mjs:598/625` | Existing bandit persistence pattern. Quickfix-stats reuses the same shape; deferred learners do NOT need new arm tables — they use the generic `learning_decisions` log. |
| `getPassEffectiveness` / `getPassTimings` | `scripts/learning-store.mjs:806/306` | Already aggregate per-pass stats per repo. Replay framework reads from these views. |
| `bandit.mjs::Beta posterior math` | `scripts/bandit.mjs` | Pure math factored into `scripts/lib/learning/beta-posterior.mjs`. |
| `persona_test_sessions` table | `supabase/migrations/...persona...` | Source for `persona_density_per_repo` view. |

### Security incident neighbourhood (Phase 0.5c)

0 records. No past security incidents apply to learning infrastructure.
Standard service-role-only RLS pattern (per `security_incidents`
hardening) applies to new tables.

### Patterns reused vs new

| Reused | Why |
|---|---|
| `bandit.mjs` Beta posterior math (factored into `lib/learning/beta-posterior.mjs`) | Same statistical primitive |
| `learning-store.mjs::getWriteClient`, `recordPassStats`, etc. | All Supabase writes; service-role-only |
| `meta-assess.mjs` periodic evaluation pattern | The replay/rebuild CLI mirrors meta-assess's rebuild flow |
| `memory-health.mjs` sticky GitHub issue pattern | Weekly review uses identical pattern (label `learning-weekly-review`) |
| `architectural-drift.yml` workflow template | Mondays 09:00 UTC cron alongside memory-health (same auth + token pattern) |
| `cross-skill.mjs` subcommand registration | New subcommands `learning-stats`, `learning-rebuild`, `learning-review`, `learning-replay` |
| `.audit/quickfix-hits.jsonl` telemetry already accumulating | Quickfix-stats reads it as input — zero new data collection needed |
| RLS service-role-only (security_incidents pattern) | New tables follow the same ACL discipline |

| New | Why |
|---|---|
| `scripts/lib/learning/` directory | Co-locate primitives + the one live learner + telemetry-logger; existing `scripts/bandit.mjs` stays prompt-variant-only |
| `scripts/lib/learning/beta-posterior.mjs` | Pure shared math — used by quickfix today + future graduated learners |
| `scripts/lib/learning/cold-start.mjs` | Pure: minimum-sample threshold guard, fallback wrapper |
| `scripts/lib/learning/quickfix-stats.mjs` | **The one live learner.** Per-repo pattern weight learner. |
| `scripts/lib/learning/decision-logger.mjs` | **Generic primitive.** Wraps a hardcoded decision: log context + choice + outcome to `learning_decisions` table. Used by 4 telemetry-only points. |
| `scripts/lib/learning/replay.mjs` | **Offline replay primitive.** Given a `decision_type`, a candidate decision function, and historical context+outcome rows from `learning_decisions`, compute counterfactual reward distribution. Keystone for v2 promotion. |
| `scripts/learning/weekly-review.mjs` | Pulls clusters → 3-section markdown digest → sticky GH issue |
| `scripts/learning/replay.mjs` | CLI for `npm run learning:replay <decision_type>` — produces a report comparing baseline vs candidate policy on historical data |
| `learning_decisions` table | Generic decision log. Composite identity `(audit_run_id, decision_type, round, sequence)` with UNIQUE constraint. Columns: `decision_id uuid PK, audit_run_id uuid FK, decision_type text, round int, sequence int, repo_id uuid FK, context jsonb, choice jsonb, outcome jsonb, context_hash text, created_at timestamptz, outcome_at timestamptz`. Outcomes are UPDATE on the same row (not separate inserts) so the row identity = event identity. Drives shadow-mode telemetry + replay. |
| `recurring_finding_clusters` table + `no_brainer_recommendations` view | The "address now" feed |
| `persona_density_per_repo` view | Per-repo gate for graduating reward-coupled learners (pass-selector v2). |
| `audit_runs.diff_complexity` column | Pass-selector context feature (logged-only in v1) |
| `audit_runs.round_converged_after` + `rigor_pressure_round` columns | Convergence-predictor training data (logged-only in v1) |
| `audit_findings.user_action` + `dismiss_reason` + `fix_commit_sha` + `time_to_resolution_ms` columns | Closes the feedback loop on every finding — needed by quickfix + auto-deferral live, by every other learner once promoted |

---

## 2. Proposed Architecture

```
┌───────────────────────────────────────────────────────────────────────────┐
│  scripts/lib/learning/                                                    │
│   ├─ beta-posterior.mjs    (pure math; used by quickfix; future learners) │
│   ├─ cold-start.mjs        (pure: sample-threshold guard, fallback wrap)  │
│   ├─ quickfix-stats.mjs    (LIVE — Beta posterior on pattern hit-accept)  │
│   ├─ decision-logger.mjs   (generic: log context+choice+outcome)          │
│   └─ replay.mjs            (offline replay engine; reads learning_decisions)│
│                                                                            │
│  Live learner contract (quickfix only in v1):                             │
│    - select / predict / score                                             │
│    - CLI: --stats | --rebuild | --reset                                   │
│    - env opt-out: LEARNING_<NAME>=off  +  global LEARNING_DISABLE=1       │
│    - cold-start guard: minimum-sample threshold below which it falls back │
│                                                                            │
│  Telemetry-only contract (4 points in v1):                                │
│    - call decision-logger.recordDecision(type, context, choice, outcome)  │
│    - existing hardcoded behavior unchanged                                │
│    - data accumulates in learning_decisions for v2 promotion              │
└───────────────────────────────────────────────────────────────────────────┘
            │                                                    │
            ▼                                                    ▼
┌─────────────────────────────────┐             ┌─────────────────────────────────┐
│  scripts/openai-audit.mjs       │             │  scripts/learning/              │
│   (wired into existing flow)    │             │   weekly-review.mjs             │
│                                 │             │   replay.mjs (CLI)              │
│  Before wave dispatch (v1):     │             │                                 │
│    diff_complexity computed     │             │  weekly-review:                 │
│    recordDecision(              │             │   reads no_brainer_recs view    │
│      'pass_selection',          │             │   reads recurring clusters      │
│      {scope,domains,fileCount}, │             │   → 3-section markdown digest   │
│      {chose: 'all'},            │             │   → CAPPED at 7 items total     │
│      {outcome: pending})         │             │   → posts to sticky GH issue   │
│    [no behavior change]         │             │                                 │
│                                 │             │  replay:                        │
│  After each round settles:      │             │   reads learning_decisions      │
│    recordDecision(              │             │   for given decision_type       │
│      'convergence_predict',     │             │   simulates candidate policy    │
│      {round,findings,history},  │             │   reports counterfactual        │
│      {chose: 'continue'},       │             │   reward distribution           │
│      {outcome: hit_max?})       │             └─────────────────────────────────┘
│    [advisory log line, no stop] │                            │
│                                 │                            ▼
│  At triage time:                │             ┌─────────────────────────────────┐
│    auto-deferral classification │             │  .github/workflows/             │
│    (no per-finding prompt)      │             │   learning-weekly-review.yml   │
│    writes user_action='deferred'│             │   (Mondays 09:00 UTC)           │
│    + dismiss_reason              │             └─────────────────────────────────┘
│    recordDecision(               │
│      'auto_deferral',            │
│      {finding,scope,heur},       │
│      {chose: class},             │
│      {outcome: pending})         │
└─────────────────────────────────┘
            │
            ▼
┌────────────────────────────────────────────────────────────────┐
│  Supabase                                                       │
│   New columns on audit_runs + audit_findings                    │
│   New table: recurring_finding_clusters (RLS service-role only) │
│   New table: learning_decisions       (RLS service-role only)   │
│   New view:  no_brainer_recommendations (filters clusters)      │
│   New view:  persona_density_per_repo                           │
│                                                                  │
│   Extended writes via learning-store.mjs:                       │
│   - recordRunComplete now stamps round_converged_after          │
│   - recordFindings stamps user_action when triage decides        │
│   - new fn recordRecurringClusterUpsert                         │
│   - new fn recordDecision (generic — used by 4 telemetry pts)   │
└────────────────────────────────────────────────────────────────┘
            │
            ▼
┌────────────────────────────────────────────────────────────────┐
│  scripts/lib/quickfix-patterns.mjs                              │
│  scripts/lib/neighbourhood-query.mjs                            │
│   (read-side integration)                                        │
│                                                                  │
│  matchPatterns()         reads .audit/quickfix-pattern-stats.json│
│                          and skips low-acceptance patterns       │
│                          [LIVE — only learner that affects flow] │
│                                                                  │
│  recommendationFromSimilarity() v1: still uses hardcoded         │
│                          0.90/0.85/0.75 thresholds.              │
│                          Calls recordDecision('arch_memory_band',│
│                          ctx, {band: rec}, {outcome: pending})   │
│                          [TELEMETRY ONLY]                        │
└────────────────────────────────────────────────────────────────┘
```

### Key design decisions (cite engineering principles)

- **#5 Single source of truth + #2 SRP**: Beta-posterior math factored out into `lib/learning/beta-posterior.mjs`. Used by quickfix today; reusable by future graduated learners. The existing `bandit.mjs` (prompt variants) is left untouched at v1 (separate concern, separate context features) but documented as a candidate for migration in §5 sustainability notes.

- **#1 DRY + #20 Long-term flexibility**: Live learners share the same interface (`select`/`predict`/`score`, `--stats`/`--rebuild`/`--reset`, env opt-out, cold-start guard, JSON cache file under `.audit/`). Telemetry-only points share the `recordDecision()` API. Adding a 5th decision point of either type means following the recipe — no refactor.

- **#11 Testability + #12 Validation**: Every learner has pure functions for its decision logic so tests don't need Supabase. Schema validation via Zod on cache file reads + `learning_decisions` row writes. Cold-start fallback is unit-tested.

- **#15 Graceful degradation**: Quickfix returns existing hardcoded behavior when (a) cloud is offline, (b) cache file missing, (c) below cold-start sample threshold, (d) env opt-out set, OR (e) global `LEARNING_DISABLE=1` set. Telemetry-only points fail-silent on `recordDecision` write errors. The audit pipeline never breaks because a learner is unavailable.

- **#16 Backward compat**: Schema is purely additive. All new columns NULLABLE. Old rows continue to work. Quickfix without a stats file = current behavior.

- **#19 Observability**: Every live decision logs rationale to stderr with `[learning:<name>]` prefix. Every telemetry-only point logs `[learning:tel:<name>] logged decision <id>` so users can grep what's accumulating.

- **#11 Testability + #14 Transaction safety**: Auto-deferral writes (audit_findings.user_action + recurring_clusters upsert + learning_decisions row) are best-effort separate writes; not wrapped in a transaction (matches existing `recordFindings` + `recordPassStats` pattern). Failure of any one doesn't crash the audit.

### Data flow

1. **Pre-audit (pass selection — TELEMETRY ONLY in v1)**:
   - `openai-audit.mjs` computes `diff_complexity` from `git diff --stat` + `compute-target-domains` result
   - Persists into `audit_runs.diff_complexity` via `recordRunStart`
   - Calls `recordDecision('pass_selection', {scope, domains, fileCount, complexity}, {chose: 'all'}, null)` — outcome filled at audit completion
   - All 6 passes always run — no behavior change

2. **Per-round (convergence prediction — TELEMETRY ONLY in v1)**:
   - After each round's findings settle, `recordDecision('convergence_predict', {round, currentFindings, deltaPattern}, {chose: 'continue'}, null)`
   - Existing max-rounds + rigor-pressure rules are still the only stop signal
   - At completion: backfill `outcome` rows for this run with `{converged_at: round, hit_max: bool, hit_rigor_pressure: bool}`

3. **At triage (auto-deferral — LIVE, deterministic-only + class-allowlist + scope-mode gate)**:
   - **Scope-mode gate (Gemini-v3 wrongly-dismissed-H3 fix)**: auto-deferral is ONLY active when `--scope diff`. In `--scope plan` and `--scope full`, findings without an explicit `<!-- audit:accept-v1 -->` plan marker route to `needs_triage` — never auto-deferred. Rationale: in non-diff scopes, "cited file not in HEAD~1..HEAD" is uninformative (most findings are about pre-existing code that the audit deliberately scoped IN), so the SCM evidence path is incorrect. This restriction is documented at the classifier API boundary.
   - **Two gates must BOTH hold for auto-defer to fire (in --scope diff only)**:
     - **Gate 1 — Class allowlist**: the finding's `category` must be in the AUTO_DEFERRABLE_CLASSES allowlist (defined as a constant in `scripts/lib/audit/deferral-classifier.mjs`). Permitted classes are local-only rule types: `style`, `formatting`, `unused-import`, `dead-code-local`, `comment-quality`, `naming-local`, `magic-number-local`. Semantic/cross-file/contract-level findings are NEVER auto-deferred regardless of file-scope evidence — they always route to `needs_triage`. Forbidden classes include but are not limited to: `security`, `correctness`, `performance-critical`, `concurrency`, `data-integrity`, `api-contract`, `cross-file-coupling`, anything tagged `is_mechanical=false`.
     - **Gate 2 — Deterministic SCM evidence** (must match ONE):
       - `out-of-scope`: ALL cited file paths NOT in `git diff --name-only HEAD~1..HEAD` (deterministic)
       - `pre-existing`: every cited line in `git blame` predates the run-start commit (deterministic)
       - `accepted-v1`: every cited file/symbol matches an explicit `<!-- audit:accept-v1: <file-glob> :: <reason> -->` marker in the plan (deterministic, syntax defined in §6 schema notes)
       - `rigor-pressure`: R3+ AND same finding hash appeared in R(n-1) AND R(n-2) (deterministic from ledger)
   - **Ambiguous OR class-disallowed findings get `user_action='needs_triage'`** (NOT `'deferred'`) and surface in the weekly review's "Awaiting triage" section. The system never silently defers a finding that fails either gate.
   - Deferral is performed via the `defer_finding(finding_id, dismiss_reason, evidence jsonb)` Postgres stored procedure (defined in §6 schema) which performs all writes — `audit_findings.user_action`, `recurring_finding_clusters` upsert, `learning_decisions` row — in one transaction. Caller doesn't manage cross-row consistency.
   - Audit summary card: `Auto-deferred N findings (deterministic); M findings need triage — review weekly via npm run learning:weekly-review`

4. **Post-audit (write-back)**:
   - `recordRunComplete` stamps `round_converged_after` + `rigor_pressure_round`
   - Backfill `learning_decisions.outcome` for any rows from this run (pass_selection, convergence_predict)
   - `recurring_finding_clusters` upsert: each finding hash matching an open cluster bumps `occurrence_count`, updates `last_seen` + `severity_history`

5. **Edit-time (quickfix learning — LIVE, hook-instrumented outcomes)**:
   - `.audit/quickfix-hits.jsonl` accumulates hits in real-time via the existing prospective hook (each hit gets a unique `hit_id`)
   - **Outcome events are emitted at the moment they happen** (not reconstructed via git archeology):
     - On hit: `recordDecision('quickfix_hit', {pattern, file, hit_id}, {action: 'flagged'}, null)`
     - On apply (file edited within 30min of hit, line still matches): hook calls `recordDecision` outcome update with `{outcome: 'accept'}`
     - On suppress (subsequent edit adds `// quickfix-hook:ignore` to same line): hook updates with `{outcome: 'suppress'}`
     - On ignore (file edited but line removed without ignore-marker): hook updates with `{outcome: 'ignore'}`
   - **Canonical store**: `learning_decisions` (cloud) for raw events. `.audit/quickfix-pattern-stats.json` is a derived cache, regenerated from `learning_decisions` on `--rebuild` (or every N audits via TTL). The cache file carries a `source_hash` checksum of the underlying rows; `matchPatterns()` invalidates if checksum mismatches.
   - **Git-log archeology is bootstrap-only**: `npm run learning:quickfix-rebuild --bootstrap` reconstructs historical accept/suppress signals from git for repos that adopted the hook before the cloud-decision pattern shipped. Steady-state training reads cloud rows.
   - `matchPatterns()` reads the stats file and skips low-acceptance patterns

6. **Neighbourhood query (arch-memory recommendation — TELEMETRY ONLY in v1)**:
   - `recommendationFromSimilarity()` uses the existing hardcoded 0.90/0.85/0.75 thresholds — no change
   - Calls `recordDecision('arch_memory_band', {repoId, similarity, sym}, {band: rec}, null)` with composite key `(audit_run_id=null since this is outside an audit run, decision_type='arch_memory_band', round=null, sequence=incremented per process)` — outcome filled by `backfill-outcomes.mjs` which watches for re-import vs new-symbol within 30min

7. **Weekly review (cron)**:
   - `.github/workflows/learning-weekly-review.yml` runs Mondays 09:00 UTC
   - Calls `node scripts/learning/weekly-review.mjs`
   - Pulls from `no_brainer_recommendations` view + stale-deferral query
   - **Hard cap: 7 items total** (5 no-brainers + 2 fresh deferrals); overflow shown as a count with a CLI command to see the full list
   - If results are empty, posts/updates sticky GitHub issue with "All quiet this week" or skips entirely (configurable)

8. **Offline replay (manual / scheduled)**:
   - `npm run learning:replay <decision_type>` reads `learning_decisions` for that type, applies a candidate policy function, computes counterfactual reward distribution
   - Used to validate a deferred learner is ready for promotion: e.g. `npm run learning:replay pass_selection --policy ./candidate.mjs --since 30d` shows what the candidate WOULD have decided vs what actually happened

### Scoring functions (cite #11 testability — all pure)

**Quickfix pattern acceptance** (`quickfix-stats.computeAcceptance`) — **LIVE**:
```
alpha = accept_count
beta  = suppress_count + (hit_count − accept_count − suppress_count)
acceptance_rate = alpha / (alpha + beta)
```
Skip pattern when `acceptance_rate < 0.20 AND total_hits >= 10`.

**Pass-selection bandit reward** (`pass-selector.computeReward`) — **TELEMETRY ONLY in v1; fully implemented as a pure function for replay**:
```
reward = (HIGH_kept + 0.5 * MEDIUM_kept) / costUsd
       + 2.0 * personaCorrelationConfirmedHits  // ground truth bonus
       - 0.5 * dismissedFalsePositives           // penalty
```
Where `*_kept` = findings that survived triage. **v2 promotion gate**:
the per-repo `persona_density_per_repo.density_30d >= 4` (i.e. ≥4
persona-test sessions in past 30 days) AND replay shows ≤5% recall loss
on historical data vs all-pass baseline.

**Convergence predictor** (`convergence-predictor.predict`) — **TELEMETRY ONLY in v1**:
Computed during replay only; no live use. Heuristic-with-data-driven-weights spec deferred to v2.

**Arch-memory threshold tuning** — **TELEMETRY ONLY in v1**:
v1 just records `(similarity, band, outcome)` triples. Tuning logic deferred to v2 once we have ≥50 outcomes per (repo, band) cell.

---

## 3. Phase 1.5 — Execution Model

**Are any planned operations dependent on others?** Yes — three chains:

### Chain 1: Schema → write paths → learners (sequential)

- A1 (migration) MUST land before any code can read/write the new columns/tables
- B1 (decision-logger) is the foundation for all telemetry; depends on A1
- B2 (write-path additions in `learning-store.mjs`) extend the schema in code; depend on A1
- C1 (quickfix-stats live), F1 (auto-deferral), F2 (weekly-review) all depend on B1+B2

Atomicity: per-component. Quickfix functions even if telemetry-only loggers are absent. Auto-deferral functions even if recurring-clusters table is absent (degrades gracefully).

### Chain 2: Per-feature implementation order

Within Chain 1's ordering, components are largely independent. Implement
in priority order (smallest blast radius first):

1. **A1 (migration)** — purely additive, low risk
2. **B1 + B2 (decision-logger + write paths)** — enables everything
3. **F1 + F2 + F3 (auto-deferral + weekly review)** — biggest UX impact; users immediately stop being prompted per finding
4. **C1 + C2 (quickfix pattern weights)** — smallest *live* learner; cleanest reward
5. **B3 (telemetry hooks in openai-audit.mjs + neighbourhood-query.mjs)** — 4 `recordDecision()` calls; no behavior change
6. **D1 + D2 (replay framework + CLI)** — graduates v2 candidates; needed before any v2 promotion

Tests written alongside each component (TDD).

### Chain 3: Workflow + sync (final)

- F3 (workflow yml) lands AFTER F2 (the script it invokes)
- Sync to consumer repos AFTER all of A–F merge (single coherent shipment)

### Failure semantics

- **Migration fails**: rollback via `supabase migration repair` (manual). New columns/tables are additive so partial application leaves system functional with old behavior.
- **`recordDecision` write fails**: caller logs warning to stderr, audit continues. Telemetry has gaps; audit functionality unaffected.
- **Quickfix stats write fails**: cached locally to `.audit/learning-outbox/`; weekly cron reconciles. Pattern matching falls back to default behavior.
- **Workflow fails**: same as memory-health pattern — surfaced in GitHub Actions UI, no impact on users.

### Concurrency model

All writes via existing `getWriteClient()` (single Supabase client per
process). No new locks needed — schema is per-row idempotent (`recurring_finding_clusters` uses `cluster_hash` UNIQUE with INSERT...ON CONFLICT; `learning_decisions` is append-only).

---

## 4. Engineering Principles in Play (Phase 2)

- **#1 DRY**: `lib/learning/beta-posterior.mjs` shared; `decision-logger.mjs` unifies all 4 telemetry-only points; `replay.mjs` is the single offline-evaluation engine
- **#2 SRP**: each module is one concern (math / cold-start / quickfix-learner / generic-logger / replay-engine / weekly-review)
- **#5 SSOT**: cold-start threshold, payload cap, replay-window defaults all single-sourced as module constants with env overrides
- **#11 Testability**: pure decision functions exposed (`computeAcceptance`, `recordDecision` validation, `replay.simulate`) — testable without Supabase
- **#12 Validation**: Zod schemas on every cache file load + every Supabase row write
- **#13 Idempotency**: `recurring_finding_clusters` upsert by cluster_hash; `learning_decisions` append-only with natural dedup via (audit_run_id, decision_type, context_hash); replays leave state unchanged
- **#14 Transaction safety**: separate writes per row (matches existing pattern); no cross-row consistency invariants requiring transactions
- **#15 Graceful degradation**: quickfix cold-start fallback; offline cloud → use defaults; missing cache file → recompute or use defaults; global `LEARNING_DISABLE=1` disables all live learning + telemetry in one env var (instant rollback)
- **#16 Backward compat**: schema purely additive; all new columns NULLABLE; old rows continue to function
- **#17 Performance**: quickfix-stats reads cache once per session; `decision-logger` writes are async-fire-and-forget at audit boundaries; replay framework is opt-in (CLI invocation)
- **#19 Observability**: structured stderr logs (`[learning:<name>]` prefix at every decision point); weekly review surfaces aggregate state to humans
- **#20 Long-term flexibility**: graduating a telemetry-only point to a live learner = (1) write a candidate policy fn, (2) replay against historical data, (3) confirm metrics, (4) hook the policy into the existing `recordDecision` site behind an env flag. Five steps, no refactor.

---

## 5. Sustainability

### Assumptions that could change

1. **`.audit/` directory is per-repo** — if we ever add cross-repo workspace support, the cache files need to be repo-scoped. Currently safe.
2. **Beta posterior is the right model for quickfix** — for binary outcomes (accept/reject) it's standard. v2 candidates may need different distributions; replay framework is model-agnostic so this is forward-compatible.
3. **Weekly cadence for review** — matches existing memory-health workflow. Configurable via cron string in v1.1.
4. **Cold-start threshold of 30 samples per cell** — pulled from the existing prompt-bandit's threshold. May tune per-feature in v1.1 once we see real data.
5. **Auto-deferral classifier heuristic is stable** — out-of-scope/pre-existing/accepted-v1/rigor-pressure are deterministic from existing data. If we add more classes, replay framework lets us validate.
6. **Persona-density threshold of 4 sessions / 30d** — empirical, from the brainstorm discussion. Tune once we see actual session counts per repo (`SELECT * FROM persona_density_per_repo`).

### Architecture flexibility checklist

- ✅ **Data-driven over logic-driven**: thresholds, weights, sample minimums all in env or constants module, not scattered in business logic
- ✅ **Strategy pattern**: each live learner is a separate file; new learners are new files, not branches in a giant if/else
- ✅ **Composable pipeline**: each learner can be disabled via env var without affecting others; the audit pipeline degrades gracefully
- ✅ **Abstraction boundaries**: `learning-store.mjs` is the Supabase write boundary; learners read/write through it; swapping storage = changing one module
- ✅ **Migration path** (v1→v2 promotion): replay-validate → enable behind env flag → ramp → make default. The shadow → live promotion path is the design's keystone.

### Promotion gates (v1 telemetry-only → v2 live)

When promoting a deferred learner, ALL of these must hold:

1. ≥30 days of `learning_decisions` data with `outcome` populated
2. `npm run learning:replay <decision_type>` shows the candidate policy meets type-specific bar:
   - **pass_selection**: ≤5% recall loss vs all-pass baseline; cost reduction ≥X% (X to be set after seeing distribution)
   - **convergence_predict**: ≤2% false-stop rate (run that would have found new HIGH if continued)
   - **arch_memory_band**: ≥10% precision lift on `reuse` band (i.e. when posterior says "reuse", the actual outcome was reuse) for at least one repo
3. **For pass_selection only**: per-repo `persona_density_per_repo.density_30d >= 4` — promote per repo, not globally
4. Hard floors apply when promoted:
   - pass_selection: never skip sentinel passes (structure, quickfix); top-K cheap passes always run
   - arch_memory_band: never lower `reuse` band below 0.85, never raise above 0.92

### What v2 might look like

- **Pass-selection live (per repo, gated)**: with 30+ days of telemetry + persona-density gate satisfied, ship as live behind `LEARNING_PASS_SELECTOR=on` env flag, then ramp
- **Arch-memory threshold live (per repo)**: with ≥50 outcomes per (repo, band) cell, ship per-band thresholds with hard floors
- **Convergence predictor live (advisory)**: with ≥30 days of telemetry, surface as "predicted to stop next round" annotation; existing rules stay as hard caps
- **Cross-repo aggregation**: `recurring_finding_clusters` could roll up across repos
- **Cost-per-quality-unit dashboards**
- **ML-based time-to-fix prediction**
- **Plan-section heat tracking**
- **Brainstorm-round outcome tracking**
- **Migration of `bandit.mjs` (prompt-variants) to use shared `beta-posterior.mjs`**

---

## 6. File-Level Plan

### Schema

| File | Action | Role |
|---|---|---|
| `supabase/migrations/20260508120000_adaptive_learning_v1.sql` | NEW | All schema additions in one migration. RLS service-role only on new tables (consistent with security_incidents pattern). Contents below. |

**Schema details for the migration** (all column references verified against existing migrations — `audit_findings` real columns: `id, user_id, run_id, finding_fingerprint, pass_name, severity, category, primary_file, detail_snapshot, prompt_variant_id, round_raised, created_at`; `audit_runs.repo_id REFERENCES audit_repos(id)`; `persona_test_sessions.repo_name TEXT`):

```
-- (1) audit_runs additions
ALTER TABLE audit_runs ADD COLUMN diff_complexity jsonb;
ALTER TABLE audit_runs ADD COLUMN round_converged_after int;
ALTER TABLE audit_runs ADD COLUMN rigor_pressure_round int;

-- (2) audit_findings additions (Gemini G1 fix — verified column names against existing schema)
ALTER TABLE audit_findings ADD COLUMN user_action text
  CHECK (user_action IN ('fix-now','deferred','dismissed','needs_triage','accepted-permanent'));
ALTER TABLE audit_findings ADD COLUMN dismiss_reason text;
ALTER TABLE audit_findings ADD COLUMN fix_commit_sha text;
ALTER TABLE audit_findings ADD COLUMN time_to_resolution_ms bigint;

-- (3) recurring_finding_clusters — UNIQUE on (repo_id, cluster_hash); FK to audit_repos (NOT 'repos')
CREATE TABLE recurring_finding_clusters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id uuid NOT NULL REFERENCES audit_repos(id),
  cluster_hash text NOT NULL,
  severity_history text[] NOT NULL DEFAULT '{}',
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  occurrence_count int NOT NULL DEFAULT 1,
  latest_finding_id uuid REFERENCES audit_findings(id),
  files_affected text[] NOT NULL DEFAULT '{}',
  cluster_label text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','fixed','accepted-debt','escalated')),
  UNIQUE (repo_id, cluster_hash)
);
CREATE INDEX recurring_clusters_repo_last_seen_idx
  ON recurring_finding_clusters (repo_id, last_seen DESC);

-- (4) learning_decisions — stable non-null decision_key UNIQUE
CREATE TABLE learning_decisions (
  decision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_key text NOT NULL UNIQUE,             -- STABLE non-null event identity
  -- decision_key format:
  --   audit-bound:  '<audit_run_id>:<decision_type>:r<round>:s<sequence>'
  --   off-audit:    '<decision_type>:<external_id>' where external_id is a
  --                 stable persistent identifier (hit_id for quickfix_hit,
  --                 sha256(repo_id|context_hash) for arch_memory_band, etc.)
  audit_run_id uuid REFERENCES audit_runs(id),  -- nullable for off-audit decisions
  decision_type text NOT NULL,
  round int,                                     -- nullable for non-round decisions
  sequence int,                                  -- nullable for off-audit decisions
  external_id text,                              -- nullable; populated for off-audit (hit_id, etc.)
  repo_id uuid REFERENCES audit_repos(id),       -- audit_repos (NOT 'repos')
  context jsonb NOT NULL,
  context_hash text NOT NULL,                    -- sha256 of canonicalised context
  choice jsonb NOT NULL,
  outcome jsonb,                                 -- nullable; set later via UPDATE
  created_at timestamptz NOT NULL DEFAULT now(),
  outcome_at timestamptz,
  CONSTRAINT decision_key_audit_or_external CHECK (
    (audit_run_id IS NOT NULL AND round IS NOT NULL AND sequence IS NOT NULL) OR
    (external_id IS NOT NULL)
  )
);
CREATE INDEX learning_decisions_type_created_idx
  ON learning_decisions (decision_type, created_at DESC);
CREATE INDEX learning_decisions_outcome_pending_idx
  ON learning_decisions (decision_type, created_at)
  WHERE outcome IS NULL;
-- Gemini G3 fix + Gemini-v4 wrongly-dismissed-R3-H4 fix: hot-path index for
-- the unresolved-quickfix-hit lookup. Includes outcome IS NULL in the
-- predicate so the partial index covers the live state-machine query
-- (SELECT WHERE decision_type='quickfix_hit' AND repo_id=$1 AND outcome IS NULL).
CREATE INDEX learning_decisions_quickfix_unresolved_idx
  ON learning_decisions (decision_type, repo_id, created_at)
  WHERE decision_type = 'quickfix_hit' AND outcome IS NULL;

-- (5) defer_finding stored procedure — single transactional write boundary
-- Gemini wrongly-dismissed-H1 fix: explicit decision_key in INSERT;
-- ON CONFLICT now targets the decision_key UNIQUE (matches new schema).
-- Gemini G1 fix: column names verified — audit_findings.run_id (NOT audit_run_id),
-- audit_findings.primary_file (NOT file), JOIN to audit_runs for repo_id.
-- Idempotency note (Gemini-v3 G3 fix): the proc is gated at the TOP by
-- decision_key existence. If the same (audit_run_id, round, sequence) is
-- replayed, the proc returns early without bumping occurrence_count or
-- re-updating audit_findings. Retries are safe.
CREATE OR REPLACE FUNCTION defer_finding(
  p_finding_id uuid,
  p_dismiss_reason text,
  p_evidence jsonb,
  p_cluster_hash text,
  p_severity text,
  p_audit_run_id uuid,
  p_round int,
  p_sequence int
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_repo_id uuid;
  v_files text[];
  v_decision_key text;
BEGIN
  v_decision_key := p_audit_run_id::text || ':auto_deferral:r' || p_round::text || ':s' || p_sequence::text;

  -- Idempotency gate: if this decision was already recorded, return without
  -- repeating side effects. Wraps the whole proc in a single dedup contract.
  IF EXISTS (SELECT 1 FROM learning_decisions WHERE decision_key = v_decision_key) THEN
    RETURN;
  END IF;

  -- audit_findings has no repo_id; derive via audit_runs.
  -- audit_findings.primary_file is single TEXT; wrap into array for files_affected.
  SELECT ar.repo_id, ARRAY[af.primary_file]
    INTO v_repo_id, v_files
    FROM audit_findings af
    JOIN audit_runs ar ON ar.id = af.run_id
    WHERE af.id = p_finding_id;

  UPDATE audit_findings
    SET user_action = 'deferred',
        dismiss_reason = p_dismiss_reason
    WHERE id = p_finding_id;

  INSERT INTO recurring_finding_clusters
    (repo_id, cluster_hash, severity_history, files_affected, latest_finding_id)
    VALUES (v_repo_id, p_cluster_hash, ARRAY[p_severity], v_files, p_finding_id)
    ON CONFLICT (repo_id, cluster_hash) DO UPDATE SET
      occurrence_count = recurring_finding_clusters.occurrence_count + 1,
      last_seen = now(),
      severity_history = array_append(recurring_finding_clusters.severity_history, p_severity),
      -- Gemini-v4 G5 fix: append new files (deduped) so multi-file recurrences
      -- preserve the full file list, not just the first occurrence.
      files_affected = (
        SELECT array_agg(DISTINCT f)
        FROM unnest(recurring_finding_clusters.files_affected || v_files) AS f
      ),
      latest_finding_id = p_finding_id;

  INSERT INTO learning_decisions
    (decision_key, audit_run_id, decision_type, round, sequence, repo_id,
     context, context_hash, choice, outcome, outcome_at)
    VALUES (v_decision_key, p_audit_run_id, 'auto_deferral', p_round, p_sequence, v_repo_id,
      p_evidence, encode(sha256(p_evidence::text::bytea), 'hex'),
      jsonb_build_object('class', p_dismiss_reason),
      jsonb_build_object('finding_id', p_finding_id),
      now());
END$$;

-- (6) Same boundary for needs_triage transitions
-- Gemini G1 fix: audit_findings has no repo_id; derive via audit_runs JOIN.
CREATE OR REPLACE FUNCTION mark_finding_needs_triage(
  p_finding_id uuid, p_reason text,
  p_audit_run_id uuid, p_round int, p_sequence int,
  p_evidence jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_repo_id uuid; v_dec_key text;
BEGIN
  SELECT ar.repo_id INTO v_repo_id
    FROM audit_findings af
    JOIN audit_runs ar ON ar.id = af.run_id
    WHERE af.id = p_finding_id;

  UPDATE audit_findings
    SET user_action = 'needs_triage',
        dismiss_reason = p_reason
    WHERE id = p_finding_id;

  v_dec_key := p_audit_run_id::text || ':needs_triage_route:r' || p_round::text || ':s' || p_sequence::text;
  INSERT INTO learning_decisions
    (decision_key, audit_run_id, decision_type, round, sequence, repo_id,
     context, context_hash, choice, outcome, outcome_at)
    VALUES (v_dec_key, p_audit_run_id, 'needs_triage_route', p_round, p_sequence, v_repo_id,
      p_evidence, encode(sha256(p_evidence::text::bytea), 'hex'),
      jsonb_build_object('reason', p_reason),
      jsonb_build_object('finding_id', p_finding_id),
      now())
    ON CONFLICT (decision_key) DO NOTHING;
END$$;

-- (7) Views
-- Gemini G1 fix: column names verified — audit_findings has no `title`,
-- `repo_id`, or `audit_run_id`. Use `category` for title, `detail_snapshot`
-- for body, JOIN to audit_runs for repo_id, use `run_id` not `audit_run_id`.
-- Gemini G2 fix: severity ordering uses CASE expression (single source);
-- pending_triage_findings uses the same expression as JS sort comparators.

-- Gemini-v4 G1 fix: WITH (security_invoker = true) makes the view honour the
-- caller's RLS rather than the creator's. Without this, views bypass RLS by
-- default in Postgres ≤ 14 / opt-in in 15+, leaking data to anon callers.
CREATE VIEW no_brainer_recommendations
  WITH (security_invoker = true) AS
  SELECT * FROM recurring_finding_clusters
  WHERE occurrence_count >= 3 AND status = 'open'
    AND ('HIGH' = ANY(severity_history)
         OR (occurrence_count >= 5 AND 'MEDIUM' = ANY(severity_history)))
  ORDER BY occurrence_count DESC, last_seen DESC LIMIT 50;

-- pending_triage_findings — explicit query contract for weekly-review
CREATE VIEW pending_triage_findings
  WITH (security_invoker = true) AS
  SELECT af.id,
         ar.repo_id,                                     -- repo via JOIN, not on audit_findings
         af.severity,
         af.category AS title,                           -- audit_findings has no `title`
         af.detail_snapshot AS body,                     -- audit_findings has no `body`/`description`
         af.dismiss_reason,
         af.primary_file,                                -- single TEXT, NOT `file`
         af.created_at,
         ar.commit_sha, ar.branch                        -- both exist on audit_runs
  FROM audit_findings af
  JOIN audit_runs ar ON ar.id = af.run_id                -- run_id, NOT audit_run_id
  WHERE af.user_action = 'needs_triage'
  ORDER BY
    CASE WHEN af.severity = 'HIGH' THEN 0
         WHEN af.severity = 'MEDIUM' THEN 1
         ELSE 2 END,                                      -- single SSOT for severity rank
    af.created_at DESC;

-- persona_density_per_repo — LEFT JOIN with COALESCE so 0-session repos appear
-- audit_repos (NOT 'repos'); persona_test_sessions joins via repo_name (TEXT).
CREATE VIEW persona_density_per_repo
  WITH (security_invoker = true) AS
  SELECT r.id AS repo_id, r.name AS repo_name,
    COALESCE(
      count(pts.id) FILTER (WHERE pts.created_at > now() - interval '30 days'),
      0
    )::int AS density_30d
  FROM audit_repos r
  LEFT JOIN persona_test_sessions pts ON pts.repo_name = r.name
  GROUP BY r.id, r.name;

-- (8) RLS on new tables — service-role only
ALTER TABLE recurring_finding_clusters ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_decisions ENABLE ROW LEVEL SECURITY;
-- (no policies → anon and authenticated reads return empty)

-- (8b) Stored-procedure privilege hardening (R3 H2 fix)
-- Both procs use SECURITY DEFINER + locked search_path; default EXECUTE on
-- DEFINER functions is granted to PUBLIC by Postgres, so we explicitly
-- revoke and re-grant only to the service role. Procedures live in the
-- default schema since Supabase auto-exposes RPCs from `public`; the
-- locked search_path prevents schema-resolution attacks.
ALTER FUNCTION defer_finding(uuid, text, jsonb, text, text, uuid, int, int)
  SET search_path = pg_catalog, public;
ALTER FUNCTION mark_finding_needs_triage(uuid, text, uuid, int, int, jsonb)
  SET search_path = pg_catalog, public;
REVOKE EXECUTE ON FUNCTION defer_finding(uuid, text, jsonb, text, text, uuid, int, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION defer_finding(uuid, text, jsonb, text, text, uuid, int, int) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION mark_finding_needs_triage(uuid, text, uuid, int, int, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION mark_finding_needs_triage(uuid, text, uuid, int, int, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION defer_finding(uuid, text, jsonb, text, text, uuid, int, int) TO service_role;
GRANT EXECUTE ON FUNCTION mark_finding_needs_triage(uuid, text, uuid, int, int, jsonb) TO service_role;

-- (9) Plan-marker syntax for accepted-v1 deferrals (documented contract)
-- A finding may be auto-deferred with class='accepted-v1' if the plan file
-- contains a marker matching the finding's cited file + symbol:
--   <!-- audit:accept-v1: <file-glob> :: <symbol-or-rationale> -->
-- The classifier is a pure function on the plan content + finding citation.
```

### Shared library (Phase 2 #1 DRY)

| File | Action | Role |
|---|---|---|
| `scripts/lib/learning/beta-posterior.mjs` | NEW | Pure math: `betaPosterior(alpha, beta) → {mean, ci_low, ci_high}`, `thompsonSample({alpha, beta})`, `updatePosterior({prior, observation})`. Used by quickfix-stats today; reusable by future graduated learners. (#1 DRY, #11 testability) |
| `scripts/lib/learning/cold-start.mjs` | NEW | Pure: `hasEnoughSamples({totalSamples, threshold})`, `withFallback(predictFn, fallbackFn, samples, threshold)`. Shared cold-start guard. (#15 graceful degradation) |
| `scripts/lib/learning/decision-logger.mjs` | NEW | Generic primitive with **bounded telemetry queue + disk outbox**. Public API: **single-object signature** `recordDecision({decisionType, repoId, auditRunId, round, sequence, externalId, context, choice, outcome})` (Gemini-v3 G2 — canonical signature; never positional). Validates via Zod, derives `decision_key` (audit-bound: `${audit_run_id}:${decision_type}:r${round}:s${sequence}`; off-audit: `${decision_type}:${external_id}`), enqueues into a per-process queue (default cap: 256). **Overflow policy with per-type sub-queues (Gemini-v3 G4 + Gemini-v4 G3 fix)**: the queue is partitioned by `decision_type` with each type getting its own bounded sub-queue (default cap: 64 per type, 5 active types in v1 → ~320 total capacity). When a type's sub-queue overflows, drop the OLDEST entry of THAT TYPE only — high-frequency `auto_deferral` events cannot evict low-frequency `pass_selection` events. Per-type `droppedCount` counters; rate-limited stderr warning (1/sec/type). All counters surface in the audit-end summary card. Drop-oldest within a type preserves recency. `flush()` drains synchronously at: (a) audit-run end, (b) `process.on('SIGINT')`, (c) `process.on('beforeExit')`. **Outbox model — environment-aware (Gemini-v4 G4 fix)**: detect ephemeral CI runtime via `process.env.CI` or `process.env.GITHUB_ACTIONS`. (a) **Local runs** (default): on flush failure, each failed entry is atomically written as a JSON file at `.audit/learning-outbox/<created_at>-<decision_key_hash>.json` (write-temp-then-rename). `reconcileOutbox()` runs at next audit-run START. (b) **CI runs** (ephemeral FS): outbox is DISABLED; flush failures fall back to **synchronous retry with exponential backoff** (3 attempts, 200ms/600ms/1.8s) before giving up. If all retries fail, increment `lostInCI` counter, log loud stderr error, continue. Telemetry loss in CI is logged + counted but never crashes the run. Backfill API: `backfillOutcome({decisionKey, outcome})` updates by `decision_key` — idempotent. (#1 DRY, #14 transaction safety, #15 graceful degradation) |
| `scripts/lib/learning/replay.mjs` | NEW | Offline replay engine. Public API: `replay({decisionType, sinceMs, candidatePolicy, baselinePolicy, rewardFn}) → {baselineDist, candidateDist, deltaSummary}`. Reads `learning_decisions` rows; for each, runs both policies on the historical context; computes counterfactual reward stats. Used by `npm run learning:replay`. (#11 testability — pure given fixture rows) |

### Live learner — Quickfix pattern weights

| File | Action | Role |
|---|---|---|
| `scripts/lib/learning/quickfix-stats.mjs` | NEW | The one live learner. Public API: `loadStats() → {patternName: {alpha, beta, acceptanceRate, totalHits}}`, `shouldSkipPattern(patternName, stats) → boolean`. CLI: `--stats | --rebuild [--bootstrap]`. **Canonical source of truth**: `learning_decisions` table (decision_type='quickfix_hit', joined to outcomes). The `--rebuild` (default) reads from cloud, computes per-pattern Beta posteriors, writes derived `.audit/quickfix-pattern-stats.json` with `source_hash` (sha256 of underlying row IDs+outcomes). `--bootstrap` is the legacy path: walks `.audit/quickfix-hits.jsonl` + `git log` for repos that adopted the hook before cloud-decisions shipped. Steady-state training is cloud-only. (#11 testability, #5 SSOT) |
| `scripts/lib/quickfix-patterns.mjs` | EDIT | **Synchronous-hot-path contract preserved (Gemini-v4 G2 fix)**: `matchPatterns()` MUST stay synchronous + I/O-free for editor-hook performance. (1) At start of `matchPatterns()`, load stats from cache **synchronously** via `fs.readFileSync` (cheap — single file read). Cache is trusted for the duration of the process. NO Supabase query on the hot path. Freshness is enforced by an OUT-OF-BAND reconciler: a `quickfix:rebuild` daemon trigger fires on a periodic schedule (audit-end + weekly cron) to refresh the cache file. If the cache file is stale by the time `matchPatterns()` reads it, the worst case is one session of slightly-out-of-date pattern weights — acceptable. For each pattern, `shouldSkipPattern()` — if true, log once per session and skip. Respects `LEARNING_DISABLE=1` and `LEARNING_QUICKFIX=off`. (2) **Hook-time outcome instrumentation via PERSISTED state machine**: when a pattern hit fires, generate `hit_id` (uuid), insert row into `learning_decisions` immediately with `decision_key='quickfix_hit:<hit_id>'`, `outcome=null`. The hook does NOT spawn an in-process watcher. Outcome resolution happens via TWO complementary paths: (a) **Subsequent hook invocations**: every Edit/Write hook call checks `learning_decisions` for unresolved hits on this file (cheap indexed query) and updates outcomes based on current file state; (b) **Scheduled reconciler** (`backfill-outcomes.mjs --type quickfix_hit`, run by weekly cron + on-demand): walks unresolved hits older than 30min, applies same logic against the current file state, writes outcomes. No in-memory state survives process exit. (#15 graceful degradation, #14 transaction safety, #16 backward compat, #19 observability) |

### Telemetry-only loggers (4 points)

| File | Action | Role |
|---|---|---|
| `scripts/openai-audit.mjs` | EDIT | (1) Pre-wave: compute `diff_complexity`. Persist via `recordDiffComplexity`. Call `recordDecision({decisionType: 'pass_selection', repoId, auditRunId, round: 0, sequence: 0, context: {scope, domains, fileCount, complexity}, choice: {chose: 'all'}, outcome: null})` (Gemini-v3 G2 fix — single-object signature is canonical). (2) Per-round: `recordDecision({decisionType: 'convergence_predict', repoId, auditRunId, round: N, sequence: 0, context: {round, currentFindings, deltaPattern}, choice: {chose: 'continue'}, outcome: null})`. (3) **At triage — deterministic classifier only**: for each finding, run `classifyDeferralEvidence(finding, runContext) → {class, evidence, isDeterministic}`. If `isDeterministic === true` → call stored proc `defer_finding(finding_id, class, evidence, cluster_hash, severity, audit_run_id, round, sequence)`. If `isDeterministic === false` → call stored proc `mark_finding_needs_triage(finding_id, reason, audit_run_id, round, sequence)`. The classifier is a pure fn (#11 testability). (4) Post-audit: call `flush()` on the decision-logger queue; backfill outcomes for `pass_selection` + `convergence_predict` rows from this run via composite-key lookup. (5) Audit summary card: `Auto-deferred N findings (deterministic); M findings need triage — review weekly via npm run learning:weekly-review`. (#15 graceful degradation, #19 observability) |
| `scripts/lib/audit/deferral-classifier.mjs` | NEW | Pure function `classifyDeferralEvidence(finding, runContext) → {class, evidence, isDeterministic}`. Inputs: finding (with `cited_files`, `cited_lines`, `hash`), runContext (with `changed_files`, `run_start_commit`, `plan_content`, `prior_round_hashes`). Output classes: `out-of-scope`, `pre-existing`, `accepted-v1`, `rigor-pressure`, OR `null` (no deterministic match → caller routes to needs_triage). Tested exhaustively — every class has a positive + negative fixture. The plan-marker syntax (`<!-- audit:accept-v1: ... -->`) is parsed by this module's `parseAcceptV1Markers(planContent)` helper. (#11 testability, #2 SRP) |
| `scripts/lib/neighbourhood-query.mjs` | EDIT | After `recommendationFromSimilarity()` returns its band: call `recordDecision('arch_memory_band', {repoId, similarity, sym, intent}, {band: rec}, null)`. No behavior change to recommendation logic in v1. A separate periodic backfill (run by weekly cron) compares this decision against subsequent commit history (re-import within 30min = reuse-correct, new sibling = wrong) and updates `outcome`. (#16 backward compat) |
| `scripts/learning-store.mjs` | EDIT | Add (all routed through `cross-skill.mjs` per project rule when called from CLI entrypoints; direct calls allowed only from in-process audit-runtime code where `getWriteClient()` is already established): `loadQuickfixStats(repoId)`, `syncQuickfixStats(repoId, stats)`, `insertLearningDecision({decisionType, repoId, auditRunId, round, sequence, context, choice, outcome})` — uses composite key UNIQUE for idempotency, `backfillLearningOutcome({decisionType, auditRunId, round, sequence, outcome})`, `reconcileFailedWrites()` (drains `.audit/learning-outbox/` on next process start), `recordDiffComplexity(runId, complexity)`, `recordConvergenceState(runId, {round_converged_after, rigor_pressure_round})`. **Stored-procedure callers**: `callDeferFinding(...)` and `callMarkFindingNeedsTriage(...)` — thin wrappers around the SQL functions. Cluster upsert is now inside the stored procedure, NOT a separate `upsertRecurringCluster` API — single transactional boundary. (#1 DRY, #13 idempotency, #14 transaction safety) |
| `scripts/lib/stores/supabase-store.mjs` | EDIT | **Service-role separation (Gemini G2 fix)**: existing `getClient()` returns the anon-keyed client for read-only/RLS-public queries. Add a separate `getWriteClient()` factory that returns a service-role-keyed client. Caller selects: anon for `getPersonaSessionsByRepo` and similar policy-protected reads; service_role for any write to the new RLS-service-role-only tables (`learning_decisions`, `recurring_finding_clusters`) and the stored-procedure callers (`defer_finding`, `mark_finding_needs_triage`). The service-role client requires `SUPABASE_AUDIT_SERVICE_ROLE_KEY` env var; if missing, write operations short-circuit to local outbox + log warning (graceful degradation). Anon-keyed writes to service-role-only tables would silently fail at the RLS boundary — this fix prevents that failure mode. (#15 graceful degradation, plan-level invariant: writes to new tables MUST use service_role) |
| `scripts/learning-store.mjs` (Gemini G2 follow-up) | EDIT | Every write to the new tables (insertLearningDecision, callDeferFinding, callMarkFindingNeedsTriage, syncQuickfixStats, etc.) calls `getWriteClient()` from `supabase-store.mjs` (NOT `getClient()`). Reads of `persona_density_per_repo` view use anon client (the view is publicly readable). Test asserts: anon-client write attempt against `learning_decisions` returns RLS rejection (proves the boundary works). |
| `scripts/cross-skill.mjs` | EDIT | New subcommands: `learning-record` (thin wrapper around `recordDecision` for external callers), `learning-stats` (prints quickfix stats), `learning-replay <decision_type>` (delegates to `scripts/learning/replay.mjs`), `learning-weekly-review` (delegates to `scripts/learning/weekly-review.mjs`), `learning-backfill-outcomes` (delegates to `scripts/learning/backfill-outcomes.mjs`). Centralises auth, commit_sha derivation, and graceful no-op when cloud is offline. The `package.json` scripts call these subcommands rather than invoking the underlying scripts directly. (#1 DRY, project rule "all cross-skill writes go through scripts/cross-skill.mjs") |

### Auto-deferral + weekly review

| File | Action | Role |
|---|---|---|
| `scripts/learning/weekly-review.mjs` | NEW | **Per-repo scoping (Gemini-v3 G1 fix — cross-tenant data leak)**: the script identifies the active repo via `LEARNING_REPO_NAME` env var (passed by the GH workflow per consumer repo) → resolves to `audit_repos.id` once at startup → all three queries are filtered by that repo_id. Views stay global; the SCRIPT scopes them. If `LEARNING_REPO_NAME` is missing the script aborts with a clear error (no global posts allowed). Pulls from THREE explicit query contracts (each with `WHERE repo_id = $1`): `no_brainer_recommendations` view filtered, `pending_triage_findings` view filtered, `recurring_finding_clusters WHERE last_seen < now() - interval '30 days' AND status='open' AND repo_id = $1` (stale deferrals). **Section ordering** (deterministic): (1) Awaiting triage [HIGH severity priority], (2) No-brainer fix-now, (3) Stale deferrals. **Cap allocation** with explicit overflow rule: total cap of 7 items distributed greedily by section priority — first fill section 1 up to 3 items, then section 2 up to 3 items, then section 3 up to 1 item. Each section shows overflow as `(...and N more — see full list: npm run learning:stats)`. Severity ordering uses a single SQL `CASE WHEN severity='HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END` (R3 L1 fix) — same expression in views and JS sort comparators. → Markdown digest posted/updated as sticky GH issue with label `learning-weekly-review`. Skip post if all 3 sections empty (configurable). **CLI output contract (Gemini missed-M2 fix)**: stdout is JSON-only (the digest object). Human-readable markdown is written to stderr (operator visibility) AND, when `--out <file>` is supplied, to the file (consumed by the GH-issue poster). `--dry-run` flag prints the JSON to stdout + the markdown to stderr without posting. Default invocation (no flags) writes JSON to stdout + posts to GH; `--format markdown` switches stdout to markdown for human-only invocations. Schema of stdout JSON documented in module's JSDoc. (#2 SRP, #19 observability, #5 SSOT — stdout is for machine consumers only) |
| `scripts/learning/replay.mjs` | NEW | CLI wrapper. Args: `<decision_type> [--policy <module-path>] [--since <duration>] [--repo <name>] [--format json|markdown]`. Imports the candidate policy fn (default: a built-in baseline that mimics current hardcoded behavior), calls `replay()` from the lib. **CLI output contract (Gemini missed-M2 fix)**: stdout is JSON by default (the comparison-result object — schema documented in JSDoc). `--format markdown` switches stdout to a human-readable comparison table. Progress logs go to stderr. Used to validate v2 promotion candidates. |
| `scripts/learning/backfill-outcomes.mjs` (CLI contract addition) | EDIT (already NEW above; add output contract here) | stdout: JSON summary `{processed: N, updated: N, skipped: N, errors: []}`. stderr: per-row progress log lines. No human-readable markdown on stdout. |
| `.github/workflows/learning-weekly-review.yml` | NEW | Cron: `0 9 * * 1` (Mondays 09:00 UTC). Runs `npm run learning:weekly-review`. Same auth + GH token pattern as `memory-health.yml`. Includes a final step that runs `npm run learning:backfill-outcomes` (a cheap script that backfills outcome fields for arch_memory_band rows older than 24h based on git history). |
| `package.json` | EDIT | All `learning:*` scripts route through `cross-skill.mjs` (per M3 fix): `"learning:weekly-review": "node scripts/cross-skill.mjs learning-weekly-review"`, `"learning:quickfix-rebuild": "node scripts/lib/learning/quickfix-stats.mjs --rebuild"`, `"learning:quickfix-bootstrap": "node scripts/lib/learning/quickfix-stats.mjs --rebuild --bootstrap"`, `"learning:replay": "node scripts/cross-skill.mjs learning-replay"`, `"learning:stats": "node scripts/cross-skill.mjs learning-stats"`, `"learning:backfill-outcomes": "node scripts/cross-skill.mjs learning-backfill-outcomes"`. (#19 observability) |
| `scripts/learning/backfill-outcomes.mjs` | NEW | Backfill job for telemetry-only outcomes. Pulls `learning_decisions` rows with `outcome IS NULL AND created_at < now() - interval '24h'`. For each `decision_type`, applies a type-specific outcome detector (e.g. for `arch_memory_band`: check if a re-import of the candidate symbol appeared in commits within 30min of the decision). Updates `outcome` column. Run by weekly workflow + on-demand CLI. (#11 testability — pure outcome detector per type) |

### Documentation

| File | Action | Role |
|---|---|---|
| `AGENTS.md` | EDIT | New "Learning System" section. Document: (1) the live learner (quickfix), (2) the 4 telemetry-only points (what they log, why), (3) opt-outs (`LEARNING_DISABLE=1`, `LEARNING_QUICKFIX=off`), (4) how to interpret the weekly review issue, (5) how to graduate a telemetry-only point to live (the replay → validate → flag-flip recipe), (6) the per-repo persona-density gate for pass_selection. |
| `README.md` | EDIT | Quick-reference row pointing at `npm run learning:stats`, `npm run learning:replay`, and the weekly-review issue. |

### Tests (Phase 2 #11 testability)

| File | Action | Coverage |
|---|---|---|
| `tests/learning-beta-posterior.test.mjs` | NEW | Beta math: `betaPosterior(0,0)` → uniform, `betaPosterior(10,2)` → high mean, CI bounds, `thompsonSample` returns within [0,1], `updatePosterior` adds to right side |
| `tests/learning-cold-start.test.mjs` | NEW | `hasEnoughSamples`, `withFallback` returns fallback below threshold, returns predict above |
| `tests/learning-quickfix-stats.test.mjs` | NEW | `--rebuild` from synthetic .jsonl + git log fixtures, `shouldSkipPattern` threshold logic, cache file round-trip, env opt-out (`LEARNING_QUICKFIX=off` and `LEARNING_DISABLE=1` both bypass) |
| `tests/learning-decision-logger.test.mjs` | NEW | Validates input shape with Zod (rejects malformed); successful insert writes to mock store; failed insert writes to local jsonl fallback; backfill updates only matching rows |
| `tests/learning-replay.test.mjs` | NEW | Given fixture `learning_decisions` rows + a candidate policy, replay returns expected counterfactual distribution; baseline-vs-candidate delta correctly summarised; empty input returns degenerate-but-valid result |
| `tests/learning-weekly-review.test.mjs` | NEW | Empty state → no issue posted; populated state → 3-section digest; **payload cap of 7 enforced** (overflow count rendered, not item list); --dry-run prints without posting |
| `tests/learning-backfill-outcomes.test.mjs` | NEW | For arch_memory_band: synthetic decision row + simulated git log → outcome correctly classified as reuse-correct/wrong/uncertain; null-outcome rows older than 24h are picked up; rows newer than 24h are skipped |

---

## 7. Risk & Trade-off Register

### Trade-offs

| Trade | Why we chose it |
|---|---|
| 1 live learner + 4 telemetry-only vs 5 live | Per brainstorm: shipping 5 concurrent learners locks in assumptions before validation. Logging is cheap; inference is expensive (correctness tests, replay infra, on-call). v2 graduates by replay-validate → flag-flip. |
| Generic `learning_decisions` log + `decision-logger` primitive vs per-decision tables | DRY. One log table + one writer covers all 4 telemetry points. Future telemetry points are 1-call additions. |
| Heuristic auto-deferral classifier (no per-finding prompts) | User explicitly redirected — they noticed deferrals were being missed during audit. Trade-off: heuristic may misclassify some findings; weekly review surfaces drift. |
| Weekly cadence for review (not daily, not monthly) | Matches existing memory-health workflow. Daily would over-noise on quiet weeks. Monthly might miss urgent recurring patterns. |
| Hard payload cap of 7 in weekly review | Per brainstorm: protects engagement culture in the sticky-issue surface. Auto-deferral could theoretically generate dozens; cap forces "top N" presentation. |
| Cold-start threshold of 30 samples | Matches existing prompt-bandit. Genuinely arbitrary; tune in v1.1. |
| Beta posterior over more sophisticated models for quickfix | Right tool for binary outcomes. Deferred learners may need different distributions; replay framework is model-agnostic. |
| Per-repo persona-density gate (rather than global) | Per-repo cadence variance is real (wine-cellar = heavy, claude-audit-loop = zero). A global gate either over-suppresses (wine-cellar gets blocked) or under-suppresses (claude-audit-loop gets a Goodhart trap). |
| Replay framework as v1 keystone (even though only 1 learner ships live) | Per brainstorm: "shadow data without replay infra is dead weight." Building it once now means all future graduations are 1-day jobs, not 1-week. |

### Risks

| Risk | Mitigation |
|---|---|
| Quickfix pattern auto-disable based on noisy initial signal | Threshold is `< 0.20 acceptance AND >= 10 hits` — needs both. Single-digit hit counts don't trigger disable. |
| Telemetry-only points generate write load on every audit | `recordDecision` enqueues into a bounded per-process queue (cap 256); flush() drains at audit-end + SIGINT + beforeExit (per M2 fix). Drains synchronous so the audit-end summary reflects the actual telemetry state. JSONL fallback + `reconcileFailedWrites()` at next audit start handles transient cloud failures with idempotent composite-key upsert. |
| Decision-row identity collisions across rounds OR for off-audit events | Stable non-null `decision_key text NOT NULL UNIQUE` is the primary uniqueness contract (per R2 H3 fix). Audit-bound format: `${audit_run_id}:${decision_type}:r${round}:s${sequence}`. Off-audit format: `${decision_type}:${external_id}` (e.g. `quickfix_hit:<hit_id>`). CHECK constraint enforces that exactly one of (audit-bound fields) OR (external_id) is populated. Outcome backfill is idempotent — UPDATE by `decision_key`. |
| Auto-deferral misclassifies a semantic/cross-file finding as "out-of-scope" because the cited file isn't in --changed | **Class allowlist** (per R2 H1 fix): only local-only rule types (style, formatting, unused-import, dead-code-local, naming-local, magic-number-local, comment-quality) can be auto-deferred. Semantic/cross-file/contract-level/security/correctness findings are NEVER auto-deferred regardless of file-scope evidence — they always route to `needs_triage`. Two-gate model: (Gate 1) class allowlist must pass, (Gate 2) deterministic SCM evidence must hold. |
| Quickfix outcome watcher loses state on process exit | **Persisted state machine** (per R2 H4 fix): hits are written to `learning_decisions` IMMEDIATELY with `outcome=null`. No in-memory watcher. Outcome resolution via two paths: (a) subsequent hook invocations check unresolved hits on the file, (b) scheduled reconciler walks unresolved-and-stale hits. State survives process crash, SIGKILL, machine reboot. |
| Cache freshness check is hand-wavy ("5% drift") | **Monotonic watermark** (per R2 M1 fix): cache stores `(max_outcome_at, total_row_count)`. On each consultation, run `SELECT max(outcome_at), count(*) FROM learning_decisions WHERE ...` (cheap with index); if mismatch → trigger background rebuild AND fall back to default behavior. No partial-stale-cache use. |
| persona_density_per_repo missing rows for repos with 0 sessions | View defined as `repos LEFT JOIN persona_test_sessions ... GROUP BY repos.id` with `COALESCE(count, 0)` (per R2 M2 fix). Every repo appears with explicit 0 density; no NULL handling required in callers. |
| Two outbox models (jsonl + DB) confuse failure semantics | **Single disk-outbox model** (per R2 M3 fix): one file per failed write at `.audit/learning-outbox/<created_at>-<key_hash>.json`. Atomic via temp+rename. `reconcileOutbox()` runs at audit-run start; idempotent via `decision_key` UNIQUE. No DB outbox. |
| Weekly review section ordering / cap allocation undefined | **Explicit allocation** (per R2 H2 fix): total cap 7. Greedy fill: section 1 (Awaiting triage, HIGH first) up to 3, then section 2 (No-brainer fix-now) up to 3, then section 3 (Stale deferrals) up to 1. Each section shows `(...and N more — see full list: npm run learning:stats)` on overflow. Backed by explicit views: `pending_triage_findings`, `no_brainer_recommendations`, `recurring_finding_clusters` filtered. |
| Recurring-cluster hash collision across repos | UNIQUE constraint is `(repo_id, cluster_hash)` per H4 fix. Hash collisions across repos do not overwrite. v2 cross-repo aggregation deferred; current schema is forward-compatible (add a global cluster-definition table later without backfill). |
| Multi-table deferral writes leave system in inconsistent state | All deferral writes (`audit_findings.user_action`, `recurring_finding_clusters` upsert, `learning_decisions` insert) happen inside the `defer_finding` Postgres stored procedure (per M1 fix) — single transactional boundary. Caller cannot leave partial state. |
| Quickfix outcome reconstruction via git archeology unreliable for live learner | Hook-time outcome instrumentation (per M4 fix): outcomes emitted at apply/suppress/ignore moment via `outcomeWatcher` (30min timeout). Git-log archeology kept only for `--bootstrap` of repos that adopted the hook before cloud-decisions shipped. |
| Two sources of truth for quickfix stats (cache + cloud) | `learning_decisions` is canonical; `.audit/quickfix-pattern-stats.json` is a derived cache with `source_hash` (sha256 of underlying row identities) — invalidated when cache hash diverges from cloud row count by >5% (per H3 fix). Cache rebuild is `--rebuild` (cloud-only) or `--rebuild --bootstrap` (legacy git path). |
| Direct DB writes from learning scripts bypass cross-skill auth/no-op semantics | All CLI entrypoints route through `scripts/cross-skill.mjs` subcommands per M3 fix; package.json scripts invoke the subcommands. In-process audit-runtime calls remain direct (already authed via `getWriteClient`). |
| `learning_decisions` table grows unbounded | v1 just lets it grow — Supabase free tier is 500MB, ~10KB per decision means 50M decisions before pressure. Add a cleanup job in v1.1 (archive `outcome != null AND created_at > 90d`). |
| Auto-deferral misclassifies a real bug as pre-existing | **Deterministic-only auto-defer** (per H1 fix): the classifier never auto-defers without SCM evidence. Ambiguous findings go to `user_action='needs_triage'` (a distinct state) and surface in the weekly review's "Awaiting triage" section. The system never silently defers without evidence. The evidence payload is recorded in `learning_decisions.context` for every deferral. |
| Sticky GH issue spammed with auto-deferrals | Hard cap of 7 items; skip-post-when-empty; configurable. |
| Backfill job for arch_memory_band outcomes is wrong (e.g. miscounts re-imports) | Pure-function detector with unit-test fixtures; failures are silent (outcome stays null) so no learning happens; weekly job is idempotent. |
| Promotion gates too strict / too lax in v2 | Gates documented in §5 are starting points; replay framework lets us iterate before committing live. |
| New audit_runs columns slow inserts | Columns are NULLABLE + indexed only on existing columns. Insert path unchanged in cost. |
| Service-role key needed for the GH workflow | Same pattern as memory-health — secret already configured. |
| `LEARNING_DISABLE=1` global kill switch fails silently | Tested as part of `learning-quickfix-stats.test.mjs`; documented in AGENTS.md. |
| Persona-density view query on hot path | View, not materialized. Only consulted when graduating pass_selection (rare manual step), not per-audit. |

### Deliberately deferred to v2

- Pass-selection bandit live (telemetry-only in v1; promote per-repo via persona-density gate)
- Convergence predictor live (telemetry-only in v1; promote when ≥30d data + replay shows ≤2% false-stop rate)
- Arch-memory threshold tuning live (telemetry-only in v1; promote when ≥50 outcomes per (repo, band) cell)
- Plan-section heat tracking
- Brainstorm-round outcome tracking
- Cross-repo aggregation views
- Cost-per-quality-unit dashboards
- ML-based time-to-fix prediction
- Migration of `bandit.mjs` (prompt-variants) to use shared `beta-posterior.mjs`
- Per-language quickfix pattern weights
- `learning_decisions` cleanup job
- The original Feature 5 design (per-finding deferral classifier) — REPLACED by F1+F2+F3 weekly-review system per user direction

---

## 8. Testing Strategy

- **Unit (Node test runner)**: every learner's pure functions exhaustively tested (cold-start, threshold-crossing, posterior math, CLI argv, decision-logger validation, replay engine, backfill-outcome detectors). Approach: failing test → implementation → green.
- **Integration**: `weekly-review.mjs --dry-run` against synthetic Supabase fixtures (sqlite-style local store via existing pattern). Verifies digest formatting, hard cap of 7, skip-post-when-empty.
- **Schema migration**: applied to live Supabase via `supabase db push --include-all`; verified post-apply that anon SELECT returns empty body on new tables (RLS deny-by-default working). Verify `persona_density_per_repo` view returns one row per repo with sane count.
- **Replay framework**: integration test runs the replay against a canned `learning_decisions` fixture + a known policy and asserts the counterfactual distribution matches expected.
- **Backwards-compat**: existing tests for `bandit.mjs`, `learning-store.mjs`, `quickfix-patterns.mjs`, `neighbourhood-query.mjs`, `openai-audit.mjs` MUST stay green. Any failure = regression.
- **Observability**: each learner's stderr log line greppable for telemetry-driven analysis.

---

## 9. Acceptance Criteria

| ID | Criterion | Verification |
|---|---|---|
| AC1 | Migration applied: `audit_runs` has columns `diff_complexity`, `round_converged_after`, `rigor_pressure_round` | `supabase db remote commit` succeeds; verify via psql `\d audit_runs` |
| AC2 | Migration applied: `audit_findings` has columns `user_action`, `dismiss_reason`, `fix_commit_sha`, `time_to_resolution_ms` | psql `\d audit_findings` |
| AC3 | Migration applied: `recurring_finding_clusters` table exists with RLS enabled + service-role-only access | anon SELECT returns `200 OK + []`; service-role can read/write |
| AC4 | Migration applied: `learning_decisions` table exists with RLS enabled + service-role-only access AND UNIQUE constraint on `(audit_run_id, decision_type, round, sequence)` | anon SELECT returns `200 OK + []`; service-role can read/write; duplicate insert rejected |
| AC4b | Migration applied: `recurring_finding_clusters` UNIQUE on `(repo_id, cluster_hash)` (NOT just `cluster_hash`) | psql `\d recurring_finding_clusters` shows the composite UNIQUE |
| AC4c | Migration applied: stored procedures `defer_finding(...)` and `mark_finding_needs_triage(...)` exist and run all writes in one transaction | unit test: invoke proc with synthetic finding; assert all 3 rows materialise OR none do |
| AC4d | Migration applied: `audit_findings.user_action` CHECK constraint includes `needs_triage` value | psql introspection |
| AC5 | Migration applied: `no_brainer_recommendations` view exists | psql `\d+ no_brainer_recommendations` |
| AC6 | Migration applied: `persona_density_per_repo` view exists and returns one row per repo | psql `SELECT * FROM persona_density_per_repo` returns rows for known repos |
| AC7 | `scripts/lib/learning/beta-posterior.mjs` exports `betaPosterior`, `thompsonSample`, `updatePosterior` | `node -e "import('./scripts/lib/learning/beta-posterior.mjs').then(m => console.log(Object.keys(m)))"` |
| AC8 | `scripts/lib/learning/decision-logger.mjs` exports `recordDecision` and validates input via Zod (rejects malformed) | unit test |
| AC9 | `scripts/lib/learning/replay.mjs` exports `replay` and returns expected counterfactual distribution on fixture | unit test |
| AC10 | `quickfix-stats.--rebuild` correctly classifies hit→accept→suppress from synthetic .jsonl + git log | unit test |
| AC11 | `matchPatterns()` skips a pattern with `acceptance < 0.20 AND total_hits >= 10` | unit test |
| AC12 | `LEARNING_QUICKFIX=off` AND `LEARNING_DISABLE=1` both bypass quickfix learner (each independently) | integration test |
| AC13 | `recordDecision('pass_selection', ...)` fires once per audit run; row appears in `learning_decisions` | integration test against test Supabase project (or sqlite mode) |
| AC14 | `recordDecision('convergence_predict', ...)` fires once per round; rows appear with correct `audit_run_id` | integration test |
| AC15 | `recordDecision('arch_memory_band', ...)` fires once per neighbourhood query | integration test |
| AC16 | `recordDecision('auto_deferral', ...)` fires for each deferred finding | integration test |
| AC17 | Auto-deferral writes `user_action='deferred'`, `dismiss_reason=<class>`, recurring_clusters upsert — **inside the `defer_finding` stored procedure transaction** | integration test (failure-injection: kill connection mid-proc, assert all-or-nothing) |
| AC17b | `classifyDeferralEvidence(finding, runContext)` returns `isDeterministic=false` for findings without SCM evidence; caller routes to `mark_finding_needs_triage` | unit test per class with positive + negative fixtures |
| AC17c | Plan-marker syntax `<!-- audit:accept-v1: <file> :: <reason> -->` parsed correctly by `parseAcceptV1Markers()` | unit test |
| AC17d | Findings without deterministic evidence get `user_action='needs_triage'` (NOT `'deferred'`); weekly review surfaces them in "Awaiting triage" section | integration test |
| AC17e | `decision-logger` flush() drains queue at audit-end AND on SIGINT; failed writes spill to `.audit/learning-outbox/`; `reconcileFailedWrites()` drains on next process start (idempotent) | integration test with simulated cloud outage |
| AC17f | Quickfix outcome events emitted at hook-time via `outcomeWatcher`: edit-within-30min → `accept`, ignore-marker added → `suppress`, line-removed → `ignore`, timeout → `no_action` | integration test against synthetic file edits |
| AC17g | All `learning:*` package.json scripts invoke `scripts/cross-skill.mjs` subcommands (NOT direct script paths) | grep `package.json` |
| AC17h | `learning_decisions` outcome backfill is idempotent — running backfill twice produces same final state | unit test |
| AC17i | `decision_key` is stable + non-null + UNIQUE; audit-bound format `<run>:<type>:r<round>:s<seq>`; off-audit format `<type>:<external_id>` | unit test + DB introspection |
| AC17j | CHECK constraint `decision_key_audit_or_external` rejects rows missing both audit fields AND external_id | DB integration test |
| AC17k | `pending_triage_findings` view returns rows where `audit_findings.user_action = 'needs_triage'`, ordered HIGH-first | DB integration test |
| AC17l | `persona_density_per_repo` returns one row per repo with `density_30d=0` for repos with no persona sessions | DB integration test |
| AC17m | Auto-deferral class allowlist enforced: a `security` or `correctness`-class finding NEVER gets auto-deferred even with `out-of-scope` evidence | unit test on classifier |
| AC17n | Quickfix outcome resolved via persisted state — kill the hook process between hit and resolution; subsequent hook invocation OR `backfill-outcomes.mjs` correctly resolves the outcome from current file state | integration test |
| AC17o | Cache freshness uses monotonic watermark — synthetic test: cache `(max_outcome_at=T, count=10)`, cloud now has `(max_outcome_at=T+1, count=11)` → triggers rebuild | unit test |
| AC17p | Disk outbox: failed write creates exactly one file at `.audit/learning-outbox/<ts>-<hash>.json` (atomic via temp+rename); `reconcileOutbox()` deletes successful files, leaves failed; idempotent against duplicate calls | unit test |
| AC17q | Weekly review enforces section allocation: 3 from triage, 3 from no-brainers, 1 from stale; overflow shown as count with CLI command | unit test against synthetic populated state |
| AC17r | Stored procedures `defer_finding` and `mark_finding_needs_triage` have `EXECUTE` revoked from `PUBLIC`, `anon`, `authenticated`; only `service_role` retains EXECUTE; `search_path` is locked to `pg_catalog, public` (R3 H2 fix) | psql introspection: `\df+ defer_finding` shows the GRANTS list and `proconfig` value |
| AC17s | Single failure-recovery contract: ONLY `.audit/learning-outbox/` directory is referenced (no JSONL fallback paths) (R3 M1 fix) | grep `learning-failed-writes.jsonl` returns 0 results in source/docs |
| AC17t | Severity ordering uses a single `CASE` expression / enum mapping in BOTH views and JS sort code; no two implementations diverge (R3 L1 fix) | unit test asserts views and JS sort produce identical orderings on identical inputs |
| AC17u | `getWriteClient()` exists in `supabase-store.mjs` and uses `SUPABASE_AUDIT_SERVICE_ROLE_KEY` (Gemini G2 fix); writes to `learning_decisions` / `recurring_finding_clusters` use `getWriteClient()`, NOT `getClient()` | grep + integration test: anon-client write to `learning_decisions` returns RLS rejection |
| AC17v | Missing `SUPABASE_AUDIT_SERVICE_ROLE_KEY` env triggers graceful degradation (writes go to local outbox + warning logged); audit pipeline does NOT crash | integration test |
| AC17w | All `learning:*` CLI tools emit JSON to stdout by default; markdown/human-readable goes to stderr or `--out <file>` (Gemini missed-M2 fix); `--format markdown` switches stdout to markdown explicitly | unit + integration test per CLI |
| AC17x | Stdout JSON schema for each `learning:*` CLI is documented in module JSDoc and validated by a Zod schema in tests | unit test |
| AC17y | All SQL column references verified against actual schema (Gemini G1 fix): `audit_findings.run_id` (not `audit_run_id`), `audit_findings.primary_file` (not `file`), `audit_findings.category`/`detail_snapshot` (not `title`/`body`), JOINs to `audit_runs` for repo_id, `audit_repos` (not `repos`), `persona_test_sessions.repo_name` (not `repo_id`) | migration `supabase db push` succeeds without column-not-found errors |
| AC17z | Stored procedures `defer_finding` and `mark_finding_needs_triage` populate `decision_key` in INSERT and use `ON CONFLICT (decision_key) DO NOTHING` (Gemini wrongly-dismissed-H1 fix) | unit test invokes proc, asserts row inserted with valid decision_key; second invocation with same key is a no-op |
| AC17aa | `pending_triage_findings` view orders rows by `CASE WHEN severity='HIGH' THEN 0 ...` (Gemini G2 fix); same expression as JS sort comparator | unit test asserts identical ordering |
| AC17bb | Migration creates partial index `learning_decisions_quickfix_repo_idx` on `(decision_type, repo_id) WHERE decision_type='quickfix_hit'` (Gemini G3 fix) | psql `\d+ learning_decisions` shows the index |
| AC17cc | `weekly-review.mjs` requires `LEARNING_REPO_NAME` env var; aborts with clear error if missing; all 3 queries filter by resolved repo_id (Gemini-v3 G1 cross-tenant fix) | unit test: missing env → exit 1; populated env → results contain only that repo's rows |
| AC17dd | `recordDecision` API accepts ONLY single-object signature (Gemini-v3 G2); all call sites in openai-audit.mjs, neighbourhood-query.mjs, quickfix-patterns.mjs use `recordDecision({...})` form | grep + lint test |
| AC17ee | `defer_finding` proc is idempotent — calling it twice with the same `(audit_run_id, round, sequence)` does NOT bump `recurring_finding_clusters.occurrence_count` twice (Gemini-v3 G3 fix) | unit test: invoke proc twice; assert occurrence_count = 1 |
| AC17ff | `decision-logger` queue overflow: 257th enqueue drops the oldest, increments `droppedCount`, emits rate-limited stderr warning (Gemini-v3 G4 fix) | unit test simulates burst of 300 enqueues at cap=256 |
| AC17gg | Auto-deferral is gated to `--scope diff` only; in `--scope plan`/`--scope full`, ambiguous findings route to `needs_triage` regardless of SCM evidence (Gemini-v3 wrongly-dismissed-H3 fix) | unit test: classifier with `--scope full` + `out-of-scope` evidence returns `null` (no auto-defer); routes to needs_triage |
| AC17hh | All three new views are created `WITH (security_invoker = true)` so they honour caller RLS rather than creator privileges (Gemini-v4 G1 fix) | psql: `SELECT viewname, definition FROM pg_views WHERE viewname IN ('no_brainer_recommendations','pending_triage_findings','persona_density_per_repo')` shows the option |
| AC17ii | `matchPatterns()` is fully synchronous: no Supabase queries, no async I/O on the hot path; cache freshness enforced by out-of-band reconciler (Gemini-v4 G2 fix) | unit test asserts `matchPatterns()` is not async (Function.constructor name check); grep confirms no `await` / no Supabase imports in the hot path |
| AC17jj | Decision-logger uses per-type sub-queues with independent caps + per-type drop counters (Gemini-v4 G3 fix); high-frequency events cannot evict low-frequency events | unit test: enqueue 200 auto_deferral + 1 pass_selection at cap=64/type; assert pass_selection survives |
| AC17kk | Outbox is environment-aware: local writes spill to `.audit/learning-outbox/`; CI runs (`process.env.CI` truthy) use synchronous retry with backoff instead (Gemini-v4 G4 fix); telemetry loss in CI is counted via `lostInCI` and logged, never crashes | unit test simulates CI env + flush failure; assert no outbox file written, lostInCI incremented |
| AC17ll | `recurring_finding_clusters` upsert preserves the full deduped `files_affected` array via `array_agg(DISTINCT)` (Gemini-v4 G5 fix); recurrences across multiple files keep all files in the array | unit test: upsert same cluster_hash twice with different files; assert files_affected has both, no duplicates |
| AC17mm | Hot-path index for unresolved quickfix hits includes the `outcome IS NULL` predicate (Gemini-v4 wrongly-dismissed-R3-H4 fix); EXPLAIN on the lookup query shows index usage with no Filter step | psql `EXPLAIN SELECT * FROM learning_decisions WHERE decision_type='quickfix_hit' AND repo_id=$1 AND outcome IS NULL` |
| AC18 | `recurring_finding_clusters` upsert: same hash twice bumps `occurrence_count` | unit test |
| AC19 | `weekly-review.mjs --dry-run` prints 3-section digest from synthetic data | integration test |
| AC20 | `weekly-review.mjs` enforces hard cap of 7 items; overflow shown as count | unit test |
| AC21 | `weekly-review.mjs` skips posting when all 3 sections are empty | integration test |
| AC22 | `.github/workflows/learning-weekly-review.yml` exists with cron `0 9 * * 1` | grep |
| AC23 | `npm run learning:replay <decision_type>` produces a comparison report from fixture data | integration test |
| AC24 | `backfill-outcomes.mjs` updates rows older than 24h based on outcome detector; rows newer than 24h are skipped | unit test |
| AC25 | `audit_findings.user_action` stamp on every triage outcome (no NULL leaks for processed findings) | integration test |
| AC26 | `audit_runs.round_converged_after` stamped on completion | integration test |
| AC27 | All existing tests stay green (no regressions in bandit, learning-store, quickfix-patterns, neighbourhood-query, openai-audit) | `npm test` exit 0 modulo pre-existing vendoring-provenance fail |
| AC28 | All new tests added per File-Level Plan §6 | grep test files |
| AC29 | `npm run learning:stats` prints quickfix stats | integration |
| AC30 | Sync to consumer repos: all new `scripts/lib/learning/*.mjs` + `scripts/learning/*.mjs` files present | post-sync `ls /c/GIT/wine-cellar-app/scripts/lib/learning/` |
| AC31 | AGENTS.md "Learning System" section exists with all components + opt-outs + promotion recipe documented | grep |

---

## 10. Out of Scope (Future) — including R3 audit-driven deferrals

The R1+R2 audit rounds drove substantial in-scope refinement (8 findings each, all addressed in plan edits). R3 returned H:5 M:2 L:1 — the HIGH count went UP from R2's 4, triggering the rigor-pressure stop rule. The two genuine bugs in R3 (H2 stored-proc privilege hardening, M1 jsonl cleanup) plus L1 (severity enum) were addressed inline; the four remaining R3 HIGHs are scope-pressure refinements deferred here with rationale:

| R3 Finding | Why deferred from v1 | Future trigger |
|---|---|---|
| **R3 H1** Shared `buildDecisionKey()` contract between JS and SQL; separate event identity from logical dedupe | The `decision_key` text format spec is precise enough for v1 (audit-bound: `<run>:<type>:r<round>:s<seq>`; off-audit: `<type>:<external_id>`). Both JS callers and SQL stored procs build the string from the same inputs. A shared library function is good hygiene but not blocking — v1 has 2 builders (JS + SQL) and a test that asserts they produce identical output for the same inputs. | If a 3rd builder appears (e.g. a Python script writing decisions) → factor a single source. |
| **R3 H3** Persist audited scope (base SHA, head SHA, exact changed file list, scope mode) as a first-class run artifact at run start | **Partial fix in v1, full deferral to v2**: my prior dismissal was wrong (Gemini-v3 wrongly-dismissed-H3). For `--scope full`, "the cited file isn't in `git diff HEAD~1..HEAD`" is uninformative since most findings are about pre-existing code. **Inline fix for v1**: the auto-deferral classifier short-circuits in `--scope full` and `--scope plan` — it ONLY auto-defers in `--scope diff` mode. In other scopes, all findings without an `<!-- audit:accept-v1 -->` plan marker route to `needs_triage`. This is a hard correctness gate, NOT a behavior loss (the alternative is silently mislabelling findings). Defer the broader "first-class scope artifact" cleanup to v2. | When `replay.mjs` starts needing the same scope data → promote to `audit_runs.scope_artifact jsonb` column with full base/head SHA + changed-file list. |
| **R3 H4** Dedicated `quickfix_hits` table for live state machine; keep `learning_decisions` as the audit trail | Valid architectural critique: hot-path hit-state queries (`SELECT WHERE outcome IS NULL AND repo_id = $1 AND file_path = $2`) on the generic `learning_decisions` table will work but are not optimal. The partial index on `(decision_type, created_at) WHERE outcome IS NULL` mitigates this for v1 volumes (~10s of hits per session per repo). v2 splits when the partial index gets >100K rows OR when query latency exceeds 100ms p95. | Volume threshold OR latency regression in monitoring. |
| **R3 H5** Run-level pass outcome matrix (`audit_run × pass`) for replay | Same shape as R3 H3 — defer until `replay.mjs` actually needs it. v1's pass_selection telemetry rows on `learning_decisions` carry the `choice` (which passes ran) and `outcome` (per-pass kept/dismissed counts) sufficient for a coarse-grained replay. v2 promotes to a dedicated `audit_pass_outcomes` table when replay needs per-pass cost/latency reconstructed from raw timing data. | When a replay run produces ambiguous reward computations because the per-pass timing data isn't available. |

### Other deferred items (carried from v1)


- **v2 learner promotions** (each requires replay-validate → flag-flip; per-repo gates per §5):
  - Pass-selection live (per repo, gated on `persona_density_per_repo.density_30d >= 4`)
  - Convergence predictor live (advisory; existing rules stay as hard caps)
  - Arch-memory threshold tuning live (per repo, with hard floors)
- Plan-section heat tracking (which sections users edit post-generation)
- Brainstorm-round outcome tracking (did synthesis lead to a plan?)
- Cross-repo aggregation views
- Cost-per-quality-unit dashboards
- ML-based time-to-fix prediction
- Migration of existing `scripts/bandit.mjs` to use shared `beta-posterior.mjs` (consolidate v2)
- Per-language quickfix pattern weights
- Recurring-cluster cleanup job (archive `status='fixed'` + last_seen >180d)
- `learning_decisions` cleanup job (archive `outcome != null AND created_at > 90d`)
- The ORIGINAL Feature 5 design (per-finding deferral classifier) — replaced by auto-deferral + weekly review per user direction
