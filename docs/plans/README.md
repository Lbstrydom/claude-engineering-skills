# Plans index

> **Generated file — do not edit.** Regenerate with `npm run plans:index`.
> Freshness is enforced by `npm run plans:index:check` in the pre-push `check`.

Plans are indexed by their `Status:` line, **not** by directory. A plan keeps
the same path for its whole lifecycle — moving completed plans into an archive
directory silently broke every inbound reference to them, which is why the
archiver was deleted ([`reference-integrity-gate.md`](./reference-integrity-gate.md)
Cluster C). A path is an identity; status is a fact that changes. This index is
the derived view that makes status navigable without touching identity.

**9 active · 178 terminal · 27 audit summaries · 4 reference docs**

---

## Active

Work that is not finished — `Draft`, `Approved`, or `In Progress`.
This is the list to read when asking "what is in flight?".

| Plan | Status | Notes |
|---|---|---|
| [Event-Wiring Symmetry Check](./event-wiring-symmetry.md) | `Draft` |  |
| [Final-Review Shadow Bake-Off (marginal-value re-test)](./final-review-shadow-bakeoff.md) | `In Progress` | activated 2026-07-31 — see §0 Activation Addendum |
| [Learning / Persona / Quickfix Reliability Debt (2026-07-26 triage)](./refactor-learning-persona-quickfix-2026-07.md) | `Draft` | re-scoped to the 7 entries that are still real. |
| [Miscellaneous Small-Cluster Debt (2026-07-26 triage)](./refactor-misc-small-items-2026-07.md) | `Draft` | items resolved individually as picked up (see per-item status below), not implemented as one batch |
| [A transactional commit boundary for `ship-commit`](./ship-commit-transaction.md) | `Draft` |  |
| [Standing Queue Burndown — the three gates that fire on every ship](./standing-queue-burndown.md) | `In Progress` | Q1 38 code rows, Q2 unknown (reader reports no total), Q3 68 actionable; measured 2026-08-09 |
| [Tiered Recall-Weighted Audit Pipeline](./tiered-recall-audit-pipeline.md) | `In Progress` | implementation complete (Clusters A-F implemented |
| [Unremediated-acceptance backlog — fix the mechanism, then the rows](./unremediated-acceptance-backlog.md) | `Approved` |  |
| [Worktree-identity guards for multi-step skills](./worktree-identity-guards.md) | `Draft` |  |

## Superseded / abandoned

Decided against, replaced, or overtaken — these did **not** ship as written.
Listed openly (not collapsed) because "why did we not do this?" is asked far
more often than "how did this ship?", and the answer is usually here.

| Plan | Notes |
|---|---|
| [Phase G.2 — SQLite + Postgres Adapters + Shared Conformance](./phase-g2-sqlite-postgres-adapters.md) | 2026-05-23 update — the Postgres half shipped via the later `postgres-parity.md` plan: `scripts/lib/db/` is… |
| [Phase G.3 — GitHub Adapter (Branch + Issues)](./phase-g3-github-adapter.md) | 2026-05-23 update — NOT shipped. Project committed to a single-backend (Postgres) architecture via `postgre… |
| [Proposal: Theme-parity contrast **delta** — catch "color that didn't adapt to dark mode"](./theme-parity-contrast-delta.md) | historical brainstorm note — not a live to-do). The smallest |

## Complete

Shipped. Kept in place so every inbound reference — including the ones in
source comments that no docs linter sees — stays valid.

<details>
<summary>Show all 175 completed plans</summary>

| Plan | Status | Notes |
|---|---|---|
| [Adaptive context "blast radius" + deterministic finding-verification gate](./adaptive-context-blast-radius.md) | `Complete` |  |
| [Adaptive Learning — Phase 1 (Foundation + Auto-Deferral + Weekly Review)](./adaptive-learning-phase-1-foundation.md) | `Complete` | shipped as commit `0bde3ab` on 2026-05-08; schema migration applied 2026-05-09 |
| [Adaptive Learning — Phase 2 (Live Quickfix Learner)](./adaptive-learning-phase-2-quickfix.md) | `Complete` | shipped as commit `cf9a89b` on 2026-05-08 |
| [Adaptive Learning — Phase 3 (Replay Framework + Remaining Telemetry)](./adaptive-learning-phase-3-replay.md) | `Complete` | shipped as commit `e40a40e` on 2026-05-08 |
| [Adaptive Learning Expansion v1](./adaptive-learning-v1.md) | `Complete` | v1) — all 3 phases shipped (commits 0bde3ab, cf9a89b, e40a40e), schema migration applied to Supabase projec… |
| [Containment-Adjacency Check — a mechanical wave that asks "what else is in this branch?"](./adjacency-check-containment.md) | `Complete` | all three clusters implemented, tested and gated |
| [AI Context Sync — Reconcile Drift, Detect Drift, Copilot Slash-Command Parity](./ai-context-sync.md) | `Complete` | all 6 phases shipped 2026-04-26 / 2026-04-27 |
| [allowTiered — per-call execution gate for tiered pipeline / shadow](./allow-tiered-callsite-gate.md) | `Complete` | audited (`/audit-code`, 1 GPT round + Gemini APPROVE, 0 new findings), shipped, verified via direct repro +… |
| [Anthropic Backend Routing (Agent SDK credit prep)](./anthropic-backend-routing.md) | `Complete` | implemented + audited (R1→R3 + Gemini |
| [Arch-Memory & Audit-Pipeline Observability Hardening (13-item punch list)](./arch-audit-pipeline-observability-hardening.md) | `Complete` | all 13 items implemented + tested (74 new/updated |
| [Architectural-Drift Duplication Cleanup — Consolidate Real Dupes + Exclusion Mechanism](./arch-drift-duplication-cleanup.md) | `Complete` | implemented (Cluster A: 8 planned + 2 mid-audit-discovered duplicate consolidations + 4 pragmas; Cluster B:… |
| [Architecture-Intent PR-B — Python & Java Adapters](./arch-intent-pr-b-python-java-adapters.md) | `Complete` | implemented + audited via /cycle; /audit-code → Gemini APPROVE 2026-05-15; see audit summary at docs/plans/… |
| [Architecture-Intent PR-C — Postgres Adapter](./arch-intent-pr-c-postgres-adapter.md) | `Complete` | implemented + audited via /cycle; /audit-code 2 GPT + 2 Gemini rounds 2026-05-15, all findings fixed, Gemin… |
| [Arch-Memory Consultation — Close the Query/Index Asymmetry](./arch-memory-band-recalibration.md) | `Complete` |  |
| [Arch-Memory Planning Anchor](./arch-memory-planning-anchor.md) | `Complete` | shipped — `/plan` Phase 0.5 "Architectural-memory Neighbourhood" + `/audit-code` Phase 0.5 "Architectural-m… |
| [Architectural Memory — Backend](./architectural-memory-backend.md) | `Complete` | shipped — `scripts/symbol-index/{refresh,extract,summarise,embed,render-mermaid,drift,duplicates,prune}.mjs… |
| [Architectural Memory — Human-Facing Surfaces](./architectural-memory-frontend.md) | `Complete` | shipped — `Neighbourhood considered` callout fires in `/plan` Phase 0.5 + `/audit-code` Phase 0.5; `docs/ar… |
| [Architectural Memory](./architectural-memory.md) | `Complete` | shipped — master plan; 6 tables live (symbol_index/definitions/embeddings/file_imports/layering_violations/… |
| [Architecture-Intent Framework + JS Adapter (PR-A of 3)](./architecture-intent-framework.md) | `Complete` | all 3 PRs shipped (PR-A framework + JS/TS adapter, commit `6c6be92`; PR-B Python + Java adapters, commit `1… |
| [Unified arm-evaluation framework (blinded Claude-judge, human-anchored)](./arm-eval-framework.md) | `Complete` | built 2026-07-02 via `/cycle code --autonomous` (2 clusters). Audit-plan converged (GPT R1–R3 plateau; Gemi… |
| [Adopt `atomicWriteFileSync`/`retrySync` at the 9 Remaining Raw-`renameSync` Sites](./atomic-write-adoption-remaining-sites.md) | `Complete` | audit-plan gate: Gemini APPROVE round 4; audit-code gate: Gemini APPROVE round 2, 2 GPT rounds |
| [Audit-Backlog-Triage Hardening (7-item punch list)](./audit-backlog-triage-hardening.md) | `Complete` | all 7 items implemented + tested (50+ new/updated |
| [Plan — audit-clean.mjs traversal safety](./audit-cleanup-traversal-safety.md) | `Complete` |  |
| [Duplication Audit Wave for /audit-code](./audit-code-duplication-wave.md) | `Complete` | shipped as commit `138dec8` (2026-07-14). Implemented via `/cycle --autonomous` (2 execution clusters, each… |
| [Audit-Effectiveness Experiment — cheap credible traction on "what's the cost-effective, high-quality code-audit setup"](./audit-effectiveness-experiment.md) | `Complete` | every §12.6 CLI this plan specifies was built (`scripts/ledger-decompose.mjs`, `scripts/defect-harvest.mjs`… |
| [Audit-Loop Reliability & Intelligence Improvements](./audit-loop-improvements.md) | `Complete` | shipped — reliability + intelligence improvements landed across `scripts/openai-audit.mjs` (P0 reduce fallb… |
| [Split `/audit-loop` into `/audit-plan` + `/audit-code`](./audit-loop-skill-split.md) | `Complete` | all 6 phases shipped 2026-04-27 |
| [Claude Audit Loop v1.0](./audit-loop-v1.md) | `Complete` |  |
| [Audit Orchestrator Hardening](./audit-orchestrator-hardening.md) | `Complete` | implemented (9 phases, 5 clusters), audit-code |
| [Plan — Consumer-side audit-tool staleness check (Option A)](./audit-tool-staleness-check.md) | `Complete` |  |
| [Azure Embedding-Deployment Discovery + Provenance Truth](./azure-embed-deployment-discovery.md) | `Complete` | 2026-07-17) — all 3 clusters implemented + audited; consolidated Gemini gate APPROVE (0 findings); live-ver… |
| [Azure AI Foundry Work Profile](./azure-work-profile.md) | `Complete` |  |
| [/brainstorm Skill + Architecture-Map Discoverability + VS Code Mermaid](./brainstorm-and-arch-discoverability.md) | `Complete` | shipped — `/brainstorm` skill + `scripts/brainstorm-round.mjs` + 7 modules under `scripts/lib/brainstorm/` … |
| [`/brainstorm --with-arch` — codebase architecture context for external LLMs](./brainstorm-arch-context.md) | `Complete` |  |
| [Brainstorm-skill upgrades + Quick-fix detection (v1)](./brainstorm-quickfix-v1.md) | `Complete` | shipped — both halves: `/brainstorm` enhancements (see brainstorm-and-arch-discoverability) + quick-fix det… |
| [Wire the Cloud FP-Pattern Read Loop into Audit Suppression](./cloud-fp-suppression-read-loop.md) | `Complete` | implemented + audited. Plan audit: 5 GPT + 2 Gemini |
| [Harden consumer deployment — prevent silent local-patching of synced tooling](./consumer-deployment-hardening.md) | `Complete` | all three phases built, tested, and deployed (the |
| [Audit Context Brief Generator](./context-brief.md) | `Complete` | shipped — `scripts/lib/context.mjs` (`readProjectContextForPass`, `readRepoProfile`, `generateBriefViaGemin… |
| [VS Code GitHub Copilot compatibility audit + fixes](./copilot-compat-audit.md) | `Complete` |  |
| [Cross-Model Finding Matching](./cross-model-finding-matching.md) | `Complete` | implemented + audited |
| [Read-only Audit-Run Findings Viewer (dashboard module)](./dashboard-audit-run-viewer.md) | `Complete` | implemented + audited — see Implementation Log |
| [Dashboard "Purpose" view — v2 (coverage, reverse-link, live health)](./dashboard-purpose-view-v2.md) | `Complete` |  |
| [Dashboard "Purpose" view — v3 (per-domain health + outcome×domain matrix)](./dashboard-purpose-view-v3.md) | `Complete` |  |
| [Dashboard "Purpose" view — outcome/requirement map](./dashboard-purpose-view.md) | `Complete` | v1 shipped — `purpose.mjs` renders the Purpose tab; extended by `dashboard-purpose-view-v2.md` + `-v3.md`, … |
| [Resolve the `dashboard → scripts` layering edge (skills-help extraction)](./dashboard-skills-index-layering.md) | `Complete` |  |
| [Dashboard UX — category/workflow clusters, new-user orientation, tiered-shadow panel](./dashboard-ux-clusters-and-shadow-panel.md) | `Complete` |  |
| [Dead-Code Detection — Phase 1 (Orphan-Introduced Check)](./dead-code-phase-1-orphan-introduced.md) | `Complete` |  |
| [Debt Burndown — Workstreams A–E (master)](./debt-burndown-workstreams.md) | `Complete` | 2026-07-19) — all workstreams closed and traced against the code, not against their labels. WS-D and WS-E/E… |
| [Determinism Follow-ups — Model-Independent Outcome Capture + Deterministic ux-lock Runners](./determinism-follow-ups.md) | `Complete` | both workstreams implemented, audited, and shipped |
| [Deterministic `/audit-code` outcome capture for rounds 1..N-1 (orchestrator-only)](./deterministic-outcome-capture.md) | `Complete` | shipped 2026-06-29. Audit trail: v1 hook+queue design REJECTED by Gemini (coherence *Weak*, over-engineered… |
| [Device-profile emulation for persona-driven + structural browser tests](./device-profile-emulation.md) | `Complete` | implemented in this repo; shareable brief for porting elsewhere |
| [Discovery-Portfolio Secret-Redaction Gap](./discovery-portfolio-secret-redaction.md) | `Complete` | implemented, `/audit-code` converged over 5 rounds (18 dogfooding-artifact findings dismissed via GPT rebut… |
| [Dismissed-FP Reopen Policy (split `dismissed` from `fixed`)](./dismissed-fp-reopen-policy.md) | `Complete` | closed 2026-07-22) — this plan's committed scope was |
| [Dogfooding Ergonomics v1](./dogfooding-ergonomics-v1.md) | `Complete` | shipped 2026-05-09; archive auto-moves this file via `/ship` Step 5.5 |
| [Domain-Map Reconciliation (architecture-intent backlog)](./domain-map-reconciliation.md) | `Complete` | Phases A/B (`f94371c`) + C (`144be83`, `500f3aa`), 2026-07-17. Gemini final gate: APPROVE. |
| [Egress secret coverage — the two layers are not independent](./egress-secret-coverage-gap.md) | `Complete` | option B implemented 2026-07-19; §4e records a correction to §1 |
| [Evidence-Anchor Path Contract — stop Stage 0 discarding valid findings as fabricated](./evidence-anchor-path-contract.md) | `Complete` | both clusters shipped + gate-clear (consolidated Gemini APPROVE). |
| [Plan-Declared Execution Clustering Across the Skill Chain](./execution-clustering-skill-chain.md) | `Complete` |  |
| [Idle-timeout the extract subprocess (stop the coverage-sized SIGKILL truncating symbol extraction)](./extract-idle-timeout.md) | `Complete` |  |
| [Field-Reported /plan → /audit-plan Defects](./field-report-audit-plan-defects.md) | `Complete` | shipped in `cd862249`, `3a9dde1d`, `49bef636`; this |
| [Background-safe & provider-agnostic final-review gate](./final-review-background-safe-provider-agnostic.md) | `Complete` |  |
| [Close the final-review credit loop + admit a cheap shadow](./final-review-credit-and-cheap-shadow.md) | `Complete` |  |
| [Shadow Final-Review Reviewer (A/B test final-gate effectiveness)](./final-review-shadow-reviewer.md) | `Complete` | verified built; status corrected from Approved during archive triage 2026-06-27 |
| [Friction-Feedback Loop (recurrence-aware quality signal)](./friction-feedback-loop.md) | `Complete` | built Clusters A–C 2026-06-28; `/audit-code` R1 found 8 genuine in-scope bugs — all fixed; consolidated Gem… |
| [Friction Log + Weekly Digest Surface (v1)](./friction-log-and-digest-v1.md) | `Complete` | shipped 2026-05-09; schema applied to live Supabase; auto-archived via `/ship` Step 5.5 |
| [Gate-contract authoring — bind the surveyed gates, ratchet the rest](./gate-contract-authoring.md) | `Complete` |  |
| [Gate inventory — the 13 uncontracted skills](./gate-contract-expansion-inventory.md) | `Complete` | status corrected 2026-07-22 (was stale at `In Progress`). |
| [Gate-contract expansion — bind stated gates to enforcers](./gate-contract-expansion.md) | `Complete` | status corrected 2026-07-22 (was stale at `Draft`). All |
| [Gate-honesty defects confirmed by blind adjudication](./gate-honesty-adjudicated-defects.md) | `Complete` |  |
| [Gemini 3.1 Pro Final Reviewer](./gemini-final-reviewer.md) | `Complete` |  |
| [Gemini-gate scope-error fix](./gemini-gate-scope-fix.md) | `Complete` | applied 2026-05-11 |
| [Close the GIT_DIR/GIT_WORK_TREE Env-Leak Class (full blast radius)](./git-env-leak-sustainability.md) | `Complete` |  |
| [Closing the Green-but-Unrealized Gap](./green-but-unrealized.md) | `Complete` | implemented 2026-08-01; both clusters shipped, consolidated Gemini gate APPROVE — see Implementation Log. A… |
| [Closing the "GREEN ≠ REALIZED" gap](./green-not-realized.md) | `Complete` | all three clusters shipped (2026-06-28). A: efficacy-lints (AST, Gemini APPROVE). B: runtime-truth audit ru… |
| [Harden `scripts/lib/install/transaction.mjs`'s WAL Crash-Safety Contract](./install-transaction-wal-hardening.md) | `Complete` |  |
| [Cross-Domain Layering + Mutation-Contract Cleanup](./layering-and-mutation-contracts.md) | `Complete` | shipped 2026-07-31 — see Implementation Log |
| [Honest failure across the learning / brainstorm / persona-promote seams](./learning-persona-quickfix-honest-failure.md) | `Complete` | 2026-08-09) — all 5 phases shipped across 3 clusters; |
| [Learning-Store Signal Recovery — Identity, Outcomes, Dead Loops](./learning-store-signal-recovery.md) | `Complete` | Clusters A–D landed 2026-06-03/04 with their own |
| [Learning System v2 — Adaptive Prompt Evolution & Contextual Bandits](./learning-system-v2.md) | `Complete` | shipped — Supabase tables `learning_decisions`, `recurring_finding_clusters`, `bandit_arms`, `false_positiv… |
| [Pipeline liveness + canonical-path enforcement (WS3 follow-up)](./liveness-and-canonical-paths.md) | `Complete` |  |
| [Local Navigable Dashboard Subsystem](./local-dashboard.md) | `Complete` | shipped as 8f98d46 (initial), follow-ups 53d1413, 94a1668, 63f5e70, 371142d, 0da1881 |
| [Local Disposable DB Test Container](./local-db-test-container.md) | `Complete` |  |
| [Local Weekly Maintenance Checks (opt-in)](./local-maintenance-checks.md) | `Complete` | implemented (retroactive plan — written after implementation, for /audit-code |
| [Audit-Loop Meta-Assessment System](./meta-assessment-system.md) | `Complete` |  |
| [Migration ↔ compat-bootstrap coupling — assert the surface, don't relocate the DDL](./migration-bootstrap-coupling.md) | `Complete` | 2026-07-19) — implemented; §5 questions settled empirically, and Q2 resolved to an option the plan had not … |
| [Migration-drift detector for the audit-loop store](./migration-drift-detector.md) | `Complete` | code shipped (edffa19), operator bootstrap done via Supabase CLI, expected-schema regenerated (b13552d), --… |
| [Model A/B/C effectiveness experiment harness (auditor-model selection from real data)](./model-ab-experiment-harness.md) | `Complete` | built + audited 2026-07-01; see Implementation Log |
| [Model-A/B/C auditor harness — v2 (composition arms + outcome-based scoring)](./model-ab-harness-v2.md) | `Complete` | built 2026-07-01 via `/cycle code --autonomous` (2 clusters). Audit-plan: GPT R1–R3 H:7→4→4 plateau; Gemini… |
| [Model-Comparison Campaigns — declarative arms, AI-first adjudication, decision-grade dashboard](./model-comparison-campaigns.md) | `Complete` | shipped 2026-08-10 via `/cycle --autonomous` |
| [Model Swap-In Evaluation Harness](./model-swap-eval-harness.md) | `Complete` |  |
| [Provider-Agnostic Model-Tier — Observation + Abstraction (instrument before routing)](./model-tier-observation.md) | `Complete` | verified built; status corrected from Approved during archive triage 2026-06-27 |
| [Multi-Language Audit Support + Linter Pre-Pass + SonarQube Taxonomy](./multi-language-and-linter-integration.md) | `Complete` | master — all three sub-phases shipped: see `phase-a-language-aware-analysis.md`, `phase-b-sonarqube-classif… |
| [nav-audit Debt — Digest Completeness + Live/Static Decoupling](./nav-audit-debt-digest-decouple.md) | `Complete` | GPT 3-round + Gemini APPROVE; implemented 2026-06-26 |
| [`/nav-audit` — Static Navigation / Information-Architecture Audit Skill](./nav-audit-skill.md) | `Complete` | implemented via `/cycle code --autonomous` + debt remediation; shipped 2026-06-25 — see §13 |
| [/nav-audit v1.1 — Live-DOM Layer Attribution, Bootstrap, Static Re-scope](./nav-audit-v1.1-live-attribution.md) | `Complete` | implemented via /cycle --autonomous + dashboard persistence; shipped 2026-06-25 — see §13 |
| [/nav-audit v1.2 — Container-Authoritative Live Attribution](./nav-audit-v1.2-container-authoritative.md) | `Complete` | shipped 2026-06-26 — GPT+Gemini audited, 115 nav tests green |
| [nav-audit v1.3 — Live-Evidence Findings + Multi-State Capture](./nav-audit-v1.3-live-findings.md) | `Complete` | verified built; status corrected from Approved during archive triage 2026-06-27. GPT 3-round + Gemini 2-rou… |
| [nav-audit v1.4 — Capture Honesty + Activation Back-off](./nav-audit-v1.4-capture-honesty.md) | `Complete` | GPT+Gemini audited; implemented 2026-06-26 |
| [Observed-import-graph domain deps for the Architecture tab](./observed-domain-deps.md) | `Complete` |  |
| [Observed-Graph Coverage Honesty](./observed-graph-coverage-honesty.md) | `Complete` | Phases 1-6 shipped and audited (Clusters A, B, C). |
| [Observed-Graph Discovery Unification (evidence-layer architecture)](./observed-graph-discovery-unification.md) | `Complete` | #1 RESOLVED 2026-07-22, and it inverts the premise: |
| [OpenAI prompt prefix-caching for the audit pipeline](./openai-prefix-cache.md) | `Complete` | implemented + verified 2026-05-11 (PR-1..5 shipped; Gemini final review APPROVE |
| [OSS/OpenRouter Call Reliability Hardening](./oss-call-reliability-hardening.md) | `Complete` | implemented (all 12 File-Level Plan items), GPT code-audit ran the full 6-round cap (H:2→2→0→2→2→0 — 4 genu… |
| [Persona Click-Path Capture → nav-audit Reachability Seeding](./persona-clickpath-nav-seeding.md) | `Complete` | 2026-06-27 — built via `/cycle` autonomous, both clusters; consolidated Gemini gate APPROVE round 2). See I… |
| [Version `personaFindingHash` (route/expected context) + safe backfill](./persona-finding-hash-versioning.md) | `Complete` | implemented + audited (3 GPT + 3 Gemini plan-audit rounds; 5 GPT + 2 Gemini code-audit rounds — see Audit T… |
| [Persona/Nav feedback-loop recovery — deterministic correlator, nav-audit v2 persistence, telemetry surfacing, outcome labels](./persona-nav-feedback-recovery.md) | `Complete` | all 4 workstreams (WS1-WS4) implemented across 4 |
| [Persona-Test Consistency Mode + UX-Lock Capture Library](./persona-test-consistency-mode.md) | `Complete` | shipped 2026-05-20; status line was stale at "Audited" from the pre-implementation phase. Plan ran 7 phases… |
| [Phase A — Language-Aware Code Analysis](./phase-a-language-aware-analysis.md) | `Complete` | shipped — `scripts/lib/repo-stack.mjs::detectRepoStack` is the production artefact; consumed by `/plan`, `/… |
| [Phase B — SonarQube Classification for Findings](./phase-b-sonarqube-classification.md) | `Complete` | shipped — `scripts/lib/rule-metadata.mjs` carries the 41 `sonarType` mappings used by every finding pass. S… |
| [Phase C — Linter Pre-Pass Integration](./phase-c-linter-pre-pass.md) | `Complete` | shipped — `scripts/lib/linter.mjs` + the "Phase 0 Tool Pre-Pass" wave at the top of `openai-audit.mjs`. Vis… |
| [Phase D — Persistent Tech-Debt Memory](./phase-d-tech-debt-memory.md) | `Complete` | shipped — `.audit/tech-debt.json` ledger + `scripts/lib/debt-ledger.mjs` (+ cloud `debt_entries` Supabase t… |
| [Phase E — Skill Consolidation + Python Profiles + Rename](./phase-e-skill-consolidation-python.md) | `Complete` | shipped — `/audit-plan` + `/audit-code` skill split done (see `audit-loop-skill-split.md`); repo renamed to… |
| [Phase F — Install + Update Infrastructure](./phase-f-install-update-infra.md) | `Complete` | shipped — `install.mjs` (one-shot `npx github:Lbstrydom/...` installer) + `scripts/install-prepush-hook.mjs… |
| [Phase G.1 — Storage Interface + Facade + noop + Supabase refactor](./phase-g1-storage-interface-noop-supabase.md) | `Complete` | shipped — `scripts/lib/db/` (client/query/rpc/errors) + 10 store modules under `scripts/lib/store/` (arch-m… |
| [Phase H — Public-Distribution Hardening](./phase-h-public-distribution.md) | `Complete` | shipped — `install.mjs` (one-shot installer with key collection) + `scripts/check-deps.mjs` (dependency aud… |
| [Phase I — CLAUDE.md / AGENTS.md Hygiene + Sprawl Control](./phase-i-claudemd-hygiene.md) | `Complete` | shipped — `/ai-context-management` skill + `scripts/check-context-drift.mjs` (the strict-mode drift gate; r… |
| [Plan-audit learning parity + AGENTS.md sprawl cap](./plan-audit-parity-and-agents-md-cap.md) | `Complete` |  |
| [Postgres Parity — One Postgres Code Path for the Audit-Loop Store](./postgres-parity.md) | `Complete` | 2026-07-18 — the one deferred follow-up was retired, not |
| [Predictive Audit Strategy — Data Loop Completion & Intelligence](./predictive-audit-strategy.md) | `Complete` | shipped — `predictiveConfig` block exported from `scripts/lib/config.mjs` (explorationInterval, freshnessWi… |
| [Git-Native Provenance Trailers (F1) + Executable Gate-Honesty Suite (F2)](./provenance-trailers-and-gate-honesty.md) | `Complete` | implemented via `/cycle --autonomous` (Cluster A: 5×GPT + 1 rebuttal, converged; Cluster B: 3×GPT + 3 rebut… |
| [Quickfix Mechanical Blind-Spot Patterns](./quickfix-blindspot-patterns.md) | `Complete` | plan-audit (3 GPT rounds + 4 Gemini rounds) converged as documented below; implemented (`scripts/lib/quickf… |
| [Adaptive Audit Intelligence — Efficiency, Learning, and Continuous Improvement](./r2-efficiency.md) | `Complete` | shipped — R2+ mode is the canonical audit re-run path: `R2_ROUND_MODIFIER` + `buildRulingsBlock` in `script… |
| [Fix `redactSecrets` Positional-Collision Bug](./redact-secrets-positional-collision-fix.md) | `Complete` |  |
| [Arch-Memory / Symbol-Index Pipeline Debt (2026-07-26 triage)](./refactor-arch-memory-symbol-index-2026-07.md) | `Complete` | closed 2026-08-09) — 22 items fixed, 1 closed by |
| [Architecture-Debt Backlog Remainder (2026-07-26 triage)](./refactor-architecture-debt-remainder-2026-07.md) | `Complete` | all 3 items shipped. §2 via a sibling plan; §1 via |
| [Audit-Pipeline Reliability Debt (2026-07-26 triage)](./refactor-audit-pipeline-reliability-2026-07.md) | `Complete` | code-audited (3 GPT rounds + Gemini gate, APPROVE), shipped |
| [Refactor autofix-security — containment, dedup, and silent-failure fixes in `scripts/lib/claudemd/autofix.mjs`](./refactor-autofix-security.md) | `Complete` | implemented + audited (3 GPT + 3 Gemini plan-audit |
| [CLAUDE.md Autofix + Skill-Copy Governance Debt (2026-07-26 triage)](./refactor-claudemd-skills-governance-2026-07.md) | `Complete` | both halves shipped, under *sibling* plans rather |
| [Refactor evidence-integrity — bind anchor locations to their verified match, and parse Git diff headers unambiguously (`scripts/lib/audit/evidence-triage.mjs`)](./refactor-evidence-integrity.md) | `Complete` | implemented via `/cycle code --autonomous` (3 GPT |
| [Failure-Contract Refactor — Stop Reporting Dependency Failure As Success](./refactor-failure-contract.md) | `Complete` | implemented + audited (3 GPT + 2 Gemini plan-audit |
| [Install-Transaction WAL + VCS Parsing Debt (2026-07-26 triage)](./refactor-install-wal-vcs-2026-07.md) | `Complete` |  |
| [Model-Eval / Pricing Debt (2026-07-26 triage)](./refactor-model-eval-pricing-2026-07.md) | `Complete` |  |
| [Refactor skill-governance — remove the `.github/skills/` escape hatch everywhere it still exists](./refactor-skill-governance.md) | `Complete` |  |
| [Refactor static-analysis — make "I can't tell" representable in the repo's own guards and lints](./refactor-static-analysis.md) | `Complete` | implemented, code-audited (Cluster A: 6 GPT |
| [Refactor symbol-index — close the progress-channel sensitive-path disclosure and the drift pragma-cap re-opener](./refactor-symbol-index.md) | `Complete` | implemented via `/cycle code --autonomous` (3 GPT |
| [vcs-protocol Tech-Debt Cluster — Verification & Ledger Reconciliation](./refactor-vcs-protocol.md) | `Complete` | §4 ledger reconciliation executed 2026-08-01; no |
| [Visual-Audit Contract Validation Debt (2026-07-26 triage)](./refactor-visual-audit-contract-2026-07.md) | `Complete` | all 8 entries closed (7 via `visual-contract-semantic-validation.md`; `fa6e120c` 2026-08-09, see Closing Note |
| [Repo-Wide Reference-Integrity Gate](./reference-integrity-gate.md) | `Complete` | all three clusters implemented, converged, final-gated |
| [Remediation-State Fix-Lifecycle Writer (un-starve `unlocked_fixes` + the /ship missing-spec gate)](./remediation-state-fix-lifecycle.md) | `Complete` |  |
| [Repo-Scoped Skill Surfaces + a Third-Party-Usable Installer](./repo-scoped-skill-surfaces-and-installer.md) | `Complete` |  |
| [Requirements Layer — a materialized view of the codebase's de-facto requirements](./requirements-layer.md) | `Complete` |  |
| [Robustness Hardening & R2+ Ledger Auto-Write](./robustness-and-ledger-wiring.md) | `Complete` | shipped — `scripts/lib/ledger.mjs` exports `writeLedgerEntry` + tracks the two-axis state model (`adjudicat… |
| [Sast-Routing, Sandbox Integrity & Migration-Adoption Hardening (7-item punch list)](./sast-sandbox-backlog-hardening.md) | `Complete` | all 7 items implemented + tested (19 new/updated |
| [SAST Triage — Route, Never Suppress](./sast-triage-routing.md) | `Complete` |  |
| [Isolate engineering-skills tooling in consumer repos under `scripts/.claude-skills/`](./scripts-claude-skills-isolation.md) | `Complete` | 2026-06-02) — archived to docs/completed/. All phases done; both consumers migrated. Phases 0/1/5 (source i… |
| [Proactive Security Memory v1](./security-memory-v1.md) | `Complete` | shipped — `/security-strategy` skill + `scripts/security-memory/` (refresh-incidents, parse-strategy, incid… |
| [Remove the legacy fallback from the tiered-SHADOW path](./shadow-no-legacy-fallback.md) | `Complete` | implemented 2026-07-17 via `/cycle --autonomous`. Plan-audit: 3 GPT rounds (7 findings, all fixed) + Gemini… |
| [Shadow write-gate + orchestrator smoke execution](./shadow-write-gate-and-orchestrator-smoke.md) | `Complete` |  |
| [Shared cloud-config file for consumer repos](./shared-cloud-config.md) | `Complete` |  |
| [Shared-Env Loading Root-Fix + Contract Guard (+ cache-seed experiment record)](./shared-env-loading-root-fix.md) | `Complete` |  |
| [Close Two Sibling-Path Defects (bandit_arms NULL key + local FP tracker in the ledger branch)](./sibling-path-suppression-defects.md) | `Complete` | implemented + audited via `/cycle --autonomous` |
| [Mega-Plan: Skill-Bundle Consolidation + Public Distribution](./skill-bundle-mega-plan.md) | `Complete` | parent — split into sub-phases E (skill consolidation) / F (install + update infra) / G.1 (storage interfac… |
| [Skill Progressive Disclosure Refactor](./skill-progressive-disclosure-refactor.md) | `Complete` | all phases A, B.1, B.2, C1–C6, D, E shipped and tested |
| [Global skill-surface shadow detection + capture-honesty and repo-scoping fixes](./skill-shadow-and-capture-honesty.md) | `Complete` | Clusters B, C, E implemented + audited; consolidated |
| [Stage 0 Evidence-Relevance Split (Tiered-Recall Audit Pipeline)](./stage0-evidence-relevance-split.md) | `Complete` | implemented 2026-07-16; all 3 clusters landed via `/cycle --autonomous`. Plan-audit: 3 GPT rounds + 2 Gemin… |
| [Sustainability cleanup batch — god-module split + monolithic renderer decomp + refresh.mjs hardening](./sustainability-cleanup-batch.md) | `Complete` | WS1 (efca5ea), WS2 (13a0af9), WS3 (this commit |
| [symbol-index bugs — patches for arch:refresh --force + arch:duplicates thin-delegate](./symbol-index-bugs.md) | `Complete` | applied 2026-05-11 |
| [Symbol-Index / Arch-Memory Pipeline Reliability Hardening](./symbol-index-pipeline-reliability-hardening.md) | `Complete` | all 5 execution clusters (A-E) built and audited via `/cycle --autonomous` on 2026-07-27; consolidated Gemi… |
| [Sync ownership from content, not a tracked artifact](./sync-ownership-from-content.md) | `Complete` | all sections (§0 rollback detection, §A content-derived |
| [Tech Debt Wave 2 — Responsibility Splits & Safety Fixes](./tech-debt-wave-2.md) | `Complete` | shipped — `scripts/shared.mjs` god-module split into focused `scripts/lib/*.mjs` files: `code-analysis.mjs`… |
| [Tech Debt Wave 3 — Lint Modernization + Cognitive-Complexity Sweep](./tech-debt-wave-3.md) | `Complete` | all 5 PRs shipped 2026-04-27 |
| [Tiered Testing Doctrine + Egress/Relocation Behavioral-Gap Backfill](./testing-doctrine-and-egress-relocation-gaps.md) | `Complete` |  |
| [Tier-1 tooling fixes (from the wine-cellar-app session feedback)](./tier1-tooling-fixes.md) | `Complete` | 2026-06-28 — /audit-code GPT R3 PASS; Gemini R2 APPROVE |
| [Decompose `tiered-pipeline.mjs` and `refresh.mjs::main()` God-Modules](./tiered-pipeline-refresh-god-module-decomposition.md) | `Complete` | implemented autonomously via `/cycle --autonomous` |
| [Tiered-shadow cloud persistence + report CLI cross-repo aggregation](./tiered-shadow-cloud-persistence.md) | `Complete` |  |
| [Distinguish "nothing to clean up" from "cleanup failed" in the install WAL](./transaction-wal-cleanup-failure-distinction.md) | `Complete` |  |
| [Upstream Issue Reports (consumer → source bug channel)](./upstream-issue-reports.md) | `Complete` | all 4 phases shipped 2026-07-31 — see Audit Trail + Implementation Log |
| [/ux-lock selector policy — locate semantically, lint the drift](./ux-lock-selector-policy.md) | `Complete` | implemented + code-audited 2026-07-04; consolidated |
| [Harden vcs.mjs's git-output parsing and find-rmsync-sites.mjs's scope resolution](./vcs-parsing-and-rmsync-scope-hardening.md) | `Complete` |  |
| [Verification-Discipline Cluster — close the six upstream findings of 2026-08-07](./verification-discipline-cluster.md) | `Complete` | implemented via /cycle --autonomous; union gate APPROVE |
| [`visual-audit` — the visual/paint inspection skill (4th UX lens)](./visual-audit-skill.md) | `Complete` | built autonomously via /cycle across 3 clusters; see Implementation Log |
| [visual-audit "theme-safety" v1 — catch "color that didn't adapt"](./visual-audit-theme-safety-v1.md) | `Complete` | implemented + shipped 2026-07-01 (via /cycle code --autonomous |
| [visual-audit Theme-safety v2 — two-theme contrast parity-delta + full-DOM sweep](./visual-audit-theme-safety-v2.md) | `Complete` |  |
| [Unify visual-contract.json read/write semantic validation](./visual-contract-semantic-validation.md) | `Complete` |  |
| [Harden Filesystem Operations Against Transient Windows EPERM/EBUSY](./windows-fs-transient-error-hardening.md) | `Complete` | audit-plan gate: Gemini APPROVE round 4; audit-code gate: Gemini APPROVE round 1, 3 GPT rounds |

</details>

## Audit summaries

Companion `*-audit-summary.md` records. Exempt from the status vocabulary
(they carry a free-text convergence sentence by convention).

<details>
<summary>Show all 27 audit summaries</summary>

| Plan | Notes |
|---|---|
| [Audit Summary — Architecture-Intent PR-B (Python & Java Adapters)](./arch-intent-pr-b-audit-summary.md) |  |
| [Audit Summary — Architecture-Intent PR-C (Postgres Adapter)](./arch-intent-pr-c-audit-summary.md) |  |
| [Audit Summary — brainstorm-arch-context](./brainstorm-arch-context-audit-summary.md) |  |
| [Audit Summary — discovery-portfolio-secret-redaction](./discovery-portfolio-secret-redaction-audit-summary.md) |  |
| [Audit Summary — gemini-gate-scope-fix](./gemini-gate-scope-fix-audit-summary.md) |  |
| [Audit Summary — git-env-leak-sustainability](./git-env-leak-sustainability-audit-summary.md) |  |
| [Learning System v2 — Audit Summary](./learning-system-v2-audit-summary.md) |  |
| [Audit Summary — Local Dashboard Subsystem](./local-dashboard-audit-summary.md) |  |
| [Audit Summary — openai-prefix-cache](./openai-prefix-cache-audit-summary.md) |  |
| [Audit Summary — Persona-Test Consistency Mode](./persona-test-consistency-mode-audit-summary.md) |  |
| [Phase B Audit Summary](./phase-b-sonarqube-classification-audit-summary.md) |  |
| [Phase C Audit Summary](./phase-c-linter-pre-pass-audit-summary.md) |  |
| [Phase E Plan Audit Summary](./phase-e-skill-consolidation-python-audit-summary.md) |  |
| [Phase F Plan Audit Summary](./phase-f-install-update-infra-audit-summary.md) |  |
| [Phase G.1 Plan Audit Summary](./phase-g1-storage-interface-noop-supabase-audit-summary.md) |  |
| [Phase G.2 Plan Audit Summary](./phase-g2-sqlite-postgres-adapters-audit-summary.md) |  |
| [Phase G.3 Plan Audit Summary](./phase-g3-github-adapter-audit-summary.md) |  |
| [Phase H Plan Audit Summary](./phase-h-public-distribution-audit-summary.md) |  |
| [Phase I Plan Audit Summary](./phase-i-claudemd-hygiene-audit-summary.md) |  |
| [Postgres-Parity M1 — `/audit-code` Summary](./postgres-parity-m1-audit-summary.md) |  |
| [Postgres-Parity M3 + M4 — `/audit-code` Summary](./postgres-parity-m3m4-audit-summary.md) |  |
| [Audit summary — arch-memory / symbol-index manifest transport](./refactor-arch-memory-symbol-index-2026-07-audit-summary.md) |  |
| [Audit Summary — refactor-architecture-debt-remainder-2026-07](./refactor-architecture-debt-remainder-2026-07-audit-summary.md) |  |
| [Audit Summary — Requirements Layer](./requirements-layer-audit-summary.md) |  |
| [Audit Summary — symbol-index-bugs](./symbol-index-bugs-audit-summary.md) |  |
| [Audit Summary — vcs-parsing-and-rmsync-scope-hardening](./vcs-parsing-and-rmsync-scope-hardening-audit-summary.md) |  |
| [Audit Summary: visual-contract-semantic-validation](./visual-contract-semantic-validation-audit-summary.md) |  |

</details>

## Reference documents

Files in `docs/plans/` with no `Status:` line — contract matrices,
inventories, and notes rather than plans.

<details>
<summary>Show all 4 reference documents</summary>

| Plan | Notes |
|---|---|
| [Browser MCP Tooling + Skill Sync Improvements](./browser-mcp-and-tooling.md) |  |
| [Postgres-Parity — Contract Matrix (M0 #5)](./postgres-parity-contract-matrix.md) |  |
| [Postgres-Parity — Non-core Dependency Inventory (M0 #1)](./postgres-parity-non-core-inventory.md) |  |
| [Postgres-Parity — Migration Schema-Coupling Audit (M0 #2)](./postgres-parity-schema-coupling.md) |  |

</details>
