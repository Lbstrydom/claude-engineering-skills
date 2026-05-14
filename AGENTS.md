# AGENTS.md — Claude Engineering Skills

> **Canonical project context for all AI coding agents.** Read by Claude Code,
> Claude in VS Code, GitHub Copilot, Cursor, Windsurf, Codex CLI, Gemini CLI.
> Claude users — see [CLAUDE.md](./CLAUDE.md) for Claude Code-specific
> addenda; everything below is shared.

<!-- arch-map-discoverability:start -->
> **Architecture map**: [`docs/architecture-map.md`](docs/architecture-map.md)
> is the live, generated index of every symbol in this repo. Start there
> when you need to find an existing function, class, or component before
> writing a new one.
<!-- arch-map-discoverability:end -->

## Project Overview

**Purpose**: A bundle of 6 AI-pair-programming skills covering the full development quality lifecycle — from planning through code audit to live UX testing and shipping.
**Runtime**: Node.js (ESM modules, `"type": "module"`)
**Deployment**: CLI scripts + skill files, invoked by AI coding assistants (Claude Code, Copilot, Cursor, Windsurf)
**Repo**: Renamed from `claude-audit-loop` to `claude-engineering-skills` (Phase E)

## Skill Chain

```
/plan-backend + /plan-frontend   → architecture & UX planning
        ↓
/audit-plan                      → iterative plan refinement (max 3 rounds, rigor-pressure stop)
        ↓
/audit-code                      → multi-pass code audit (R2+ suppression, debt capture)
        ↓
(/audit-loop dispatches to one of the above by mode keyword)
        ↓
/ux-lock                         → Playwright e2e spec for each fix (locks in DOM contract)
        ↓
deploy to Railway / live URL
        ↓
/persona-test                    → live UX testing as a persona (browser + screenshots)
        ↓
/ship                            → commit + push (with UX P0 warning from persona-test)
```

**Skill file structure** (Phase B.1+ — progressive disclosure):

```
skills/<name>/                   ← authoritative; edit ONLY here
├── SKILL.md                     ← canonical flow; ≤3K tokens target
├── references/<topic>.md        ← rare/edge content, loaded on demand
└── examples/<sample>.md         ← optional output templates

.claude/skills/<name>/            ← generated copy — run `npm run skills:regenerate`
```

> **Note**: `.github/skills/<name>/` was a previously-generated mirror that
> no documented AI tool reads. Deprecated in Phase 4 of ai-context-sync.
> `--keep-github-skills` flag (on `npm run skills:regenerate` and
> `npm run sync`) preserves the old behaviour for one minor release. For
> Copilot teammates, the supported surface is `.github/prompts/` slash-command
> shims (see Phase 3).

Every reference file has `summary:` YAML frontmatter that must byte-match
the parent SKILL.md's reference-index row. `npm run skills:check` enforces
this — see `docs/skill-reference-format.md`.

Each skill is a sibling — they share env vars and Supabase stores but have distinct scopes:
- **plan-***: code that doesn't exist yet. `/plan-frontend` produces a machine-parseable "Section 9 — Acceptance Criteria" that `/ux-lock verify` consumes.
- **audit-plan**: refines plans before implementation (max 3 rounds, rigor-pressure stop). Single-file edits.
- **audit-code**: code that was just written (5-pass parallel static analysis + LLM audit + R2+ suppression).
- **audit-loop**: thin orchestrator dispatching to /audit-plan or /audit-code by input shape.
- **ux-lock**: code that was just fixed (Playwright e2e regression lock). **Verify mode** (`/ux-lock verify <plan.md>`) grades a plan-frontend plan against its live implementation — each criterion becomes a Playwright test case; results populate `plan_verification_runs` + `plan_verification_items`.
- **persona-test**: deployed app (live browser, user flows, UX findings)
- **ship**: packaging and delivery

## Browser Tool Setup (persona-test)

`/persona-test` drives a real browser. **Playwright MCP is the preferred tool** — it's free, no credentials needed, works on your own apps.

`.mcp.json` is included in this repo. Claude Code auto-discovers it and prompts you to enable Playwright MCP on first open. Just click **Allow** when prompted.

**First-time setup — install the browser:**
```bash
npx playwright install chromium
```
This is required before the MCP server will start. Without it, the server crashes silently and no tools appear.

**Verify it's working:**
```bash
npx @playwright/mcp@latest --version   # should print a version number
```

**Windows users** — Claude Code may need an MCP override; see [CLAUDE.md](./CLAUDE.md#claude-code-only-notes).

BrightData Scraping Browser is also supported (handles anti-bot/CAPTCHA) but requires a paid account and KYC approval. Playwright is preferred for testing your own apps.

---

## Dependencies (CRITICAL — check versions before flagging issues)

| Package | Version | Notes |
|---------|---------|-------|
| `zod` | **4.0.0** | Zod 4 API — NOT Zod 3. `_def.type` is a string (`'object'`, `'array'`, `'enum'`), NOT `_def.typeName` (`'ZodObject'`). `shape` is a direct property on object schemas, NOT `_def.shape()`. `_def.entries` for enums, NOT `_def.values`. |
| `openai` | 6.17.0 | Uses `responses.parse()` with `zodTextFormat()` for structured output |
| `@google/genai` | ^1.47.0 | Google Generative AI SDK. Uses `responseMimeType: 'application/json'` + `responseSchema` for structured output |
| `dotenv` | 17.0.0 | Auto-loads `.env` via `import 'dotenv/config'` |

## Architecture

```
scripts/
├── lib/                    # Focused modules (split from former shared.mjs monolith)
│   ├── schemas.mjs         # Zod schemas + zodToGeminiSchema() — single source of truth
│   ├── file-io.mjs         # Core I/O (atomic writes, paths) + barrel re-exports
│   ├── audit-scope.mjs     # Sensitive file filtering, audit-infra exclusion, context assembly
│   ├── diff-annotation.mjs # Diff parsing, CHANGED/UNCHANGED markers for audit context
│   ├── plan-paths.mjs      # Plan path extraction (regex + fuzzy keyword discovery)
│   ├── ledger.mjs          # Adjudication ledger, R2+ suppression, finding metadata
│   ├── code-analysis.mjs   # Chunking, dependency graphs, audit units, map-reduce
│   ├── context.mjs         # Repo profiling, audit brief generation, AGENTS.md/CLAUDE.md parsing
│   ├── findings.mjs        # Semantic IDs + barrel re-exports for findings subsystem
│   ├── findings-format.mjs # Finding display formatting (pure renderer)
│   ├── findings-tracker.mjs # FP tracker (v2), lazy-decay EMA, multi-scope counters
│   ├── findings-outcomes.mjs # Outcome logging, effectiveness tracking, EWR
│   ├── findings-tasks.mjs  # Remediation task CRUD + persistence
│   └── config.mjs          # Centralized validated config (all env var reads)
├── shared.mjs              # Barrel re-export — backwards-compatible, imports from lib/
├── openai-audit.mjs        # GPT-5.4 multi-pass auditor (plan, code, rebuttal modes) — links audit_runs to commit_sha + plan_id
├── gemini-review.mjs       # Gemini 3.1 Pro independent final reviewer (Claude Opus fallback)
├── bandit.mjs              # Thompson Sampling + user-impact-aware reward (consumes persona_audit_correlations)
├── learning-store.mjs      # Supabase cloud persistence for audit outcomes + learning + cross-skill data loop
├── cross-skill.mjs         # CLI facade invoked by /ux-lock /persona-test /ship — writes plans, regression_specs, persona_audit_correlations, ship_events
├── refine-prompts.mjs      # LLM-driven prompt refinement from outcome data
└── phase7-check.mjs        # Pre-flight check for Step 7 readiness

tests/                      # Node.js built-in test runner (node --test)
├── shared.test.mjs         # 33 tests: schemas, atomic writes, ledger, FP tracker
└── bandit.test.mjs         # 14 tests: Thompson Sampling, reward computation

.claude/skills/audit-loop/SKILL.md   # Claude Code skill definition (generated from skills/)
```

### Script Responsibilities

- **lib/*.mjs**: Focused modules — import directly from `./lib/<module>.mjs` for explicit deps, or from `./shared.mjs` barrel for convenience. Schemas are the single source of truth (JSON Schemas derived via `zodToGeminiSchema()`).
- **openai-audit.mjs**: 5-pass parallel code audit (structure, wiring, backend, frontend, sustainability). Plan audit. Rebuttal deliberation. Uses GPT-5.4 with `responses.parse()` + Zod schemas. Integrates bandit reward updates + Supabase cloud sync.
- **gemini-review.mjs**: Independent final review (MANDATORY — not gated by convergence). Receives full audit transcript. Detects bias, false consensus, missed issues. Uses Gemini 3.1 Pro (16K thinking budget), with Claude Opus fallback. Claude deliberates on CONCERNS, then Gemini re-verifies.
- **learning-store.mjs**: Cloud persistence via Supabase — repos, runs, findings, pass stats, bandit arms, FP patterns, adjudication events. Graceful fallback to local-only mode.

### Key Patterns

- **Adaptive sizing**: `computePassLimits()` scales token limits and timeouts based on context size
- **Graceful degradation**: `safeCallGPT()` catches failures and returns empty results instead of crashing
- **Semantic dedup**: Content-hash IDs (`semanticId()`) enable exact cross-round and cross-model finding matching
- **Targeted context**: `readProjectContextForPass()` sends only relevant AGENTS.md sections per pass (~1500 chars vs 8000)
- **Sensitive file filtering**: `.env`, credentials, keys are never sent to external APIs
- **Atomic persistence**: `atomicWriteFileSync()` — temp file + rename for crash-safe writes (ledger, bandit, FP tracker)
- **Fuzzy file discovery**: When plan paths don't match exact filenames, Phase 2 extracts PascalCase/backtick identifiers and matches against repo files
- **Schema validation at boundaries**: `callGemini()` throws on validation failure, `writeLedgerEntry()` validates entries before write
- **Thompson Sampling**: `PromptBandit` — Beta posterior updates from deliberation outcomes, synced to Supabase
- **Closed Gemini loop**: Step 7.1 — Claude deliberates on Gemini findings, fixes, then Gemini re-verifies (not GPT)

### Testing

Run: `npm test` (uses Node.js built-in test runner, 47 tests)
Covers: atomic writes, schema derivation, ledger operations, finding identity, FP tracker, bandit posterior, reward computation.

## Model Resolution

`scripts/lib/model-resolver.mjs` resolves model IDs so config stops going stale
when providers ship new versions. All model-reading env vars in config.mjs pass
through `resolveModel()`.

**Sentinels** (preferred in `.env`):

| Sentinel            | Picks from                                  |
|---------------------|---------------------------------------------|
| `latest-gpt`        | newest non-mini GPT in the pool             |
| `latest-gpt-mini`   | newest GPT mini variant                     |
| `latest-opus`       | newest Claude Opus                          |
| `latest-sonnet`     | newest Claude Sonnet                        |
| `latest-haiku`      | newest Claude Haiku (prefers undated alias) |
| `latest-pro`        | `gemini-pro-latest` (alias short-circuit)   |
| `latest-flash`      | `gemini-flash-latest`                       |
| `latest-flash-lite` | `gemini-flash-lite-latest`                  |

**Resolution order** in `resolveModel(modelId)`:
1. Apply `DEPRECATED_REMAP` — stale concrete IDs (`gpt-5.2`, `gemini-3-flash`,
   `claude-opus-3`, …) are rewritten to a sentinel with a one-time warning.
2. If the result is a sentinel, merge live catalog ∪ `STATIC_POOL`, then pick
   the newest entry matching the tier. Google's `gemini-{tier}-latest` alias
   is authoritative (short-circuits version heuristics).
3. If result is concrete, return as-is.

**Live catalog** (optional): call `await refreshModelCatalog()` at the top of a
script's `main()` to populate the session cache from the provider's `/models`
endpoint. Silent on failure — falls back to the static pool. CLI self-check:

```bash
node scripts/lib/model-resolver.mjs resolve             # show current resolution
node scripts/lib/model-resolver.mjs catalog             # live catalog delta vs static
```

**Anti-patterns to avoid:**
- Do NOT pin concrete model IDs in new code — use a sentinel (`latest-*`).
- Do NOT drop `-preview` suffixes from Gemini 3 IDs without verifying via
  `curl https://generativelanguage.googleapis.com/v1beta/models?key=$KEY`.
  The bare `gemini-3-flash` / `gemini-3.1-pro` have never shipped — Google
  returns 404.
- Do NOT retry 404. It's a client error (model not found). `classifyLlmError`
  treats any 4xx (except 429) as non-retryable.
- When you catch and rewrap an LLM error, surface `err.status` and the real
  provider message. Don't collapse to `"API error ${status}"` — the provider's
  `error.message` is what tells you which model wasn't found.

**Refreshing the static pool** (quarterly): update `STATIC_POOL` and
`DEPRECATED_REMAP` in `scripts/lib/model-resolver.mjs` and run
`node scripts/lib/model-resolver.mjs resolve` to verify.

## Memory-Health Gate

`scripts/memory-health.mjs` runs three trigger metrics against Supabase to decide
whether our flat `audit_findings` + fingerprint-dedup design is starting to leak
signal that a graph-shaped memory (pgvector + community clustering) would
recover. Three triggers:

| Metric | What it measures | Default trigger |
|---|---|---|
| Fuzzy re-raise rate | New-fingerprint findings whose text matches a prior finding (trigram sim > 0.6) | `> 15%` |
| Cluster density | Median per-repo count of open finding pairs with sim > 0.5 but different fingerprints | `>= 5` |
| Recurrence rate | Fixed findings that reappear in same repo within 30 days under a new fingerprint | `> 10%` |

Runtime is the `memory_health_metrics(window_days)` Postgres RPC added by
`supabase/migrations/20260421120000_memory_health.sql` (uses `pg_trgm`).

**Auto-scheduled** via `.github/workflows/memory-health.yml` — runs every Monday
09:00 UTC, silent when all metrics green, opens/updates a sticky GH issue
(label `memory-health`) when any trigger fires. Auto-closes when metrics
return to green. Run locally: `npm run memory:health` or `npm run memory:health:json`.

**Decision rule**: 0 triggers for 4 weeks → current design is fine. 1 trigger
for 2 consecutive weeks → prototype pgvector similarity. 2+ triggers → build
the full clustering pipeline.

## Learning System (Phase 1)

The adaptive-learning system collects telemetry across audit decision points
(pass selection, convergence prediction, arch-memory band, auto-deferral)
into the `learning_decisions` Supabase table, plus a per-repo
`recurring_finding_clusters` table for recurring-finding aggregation.
Phase 1 ships the foundation; future phases promote individual decision
points to live learners.

**Plan** (Complete v1): `docs/completed/adaptive-learning-v1.md` (master), per-phase plans
`docs/completed/adaptive-learning-phase-{1,2,3}-*.md`.

### Auto-deferral classifier
Scope-gated to `--scope diff` audits only. Two gates BOTH hold for an
auto-defer to fire: (1) finding `category` in the AUTO_DEFERRABLE_CLASSES
allowlist (`style`, `formatting`, `unused-import`, `dead-code-local`,
`comment-quality`, `naming-local`, `magic-number-local`); (2) deterministic
SCM evidence (file not in HEAD~1..HEAD diff, or matched by an explicit plan
marker, or recurring across 2+ rounds). Findings failing either gate route
to `audit_findings.user_action='needs_triage'` and surface in the weekly
review's "Awaiting triage" section.

**Plan-marker syntax** (operators inline these in plan markdown to accept
known v1 limits):
```
<!-- audit:accept-v1: <file-glob> :: <reason> -->
```

### Weekly review
Mondays 09:00 UTC, per consumer repo. Sticky GitHub issue with label
`learning-weekly-review`. Hard cap of 7 items: 3 awaiting triage + 3
no-brainer fix-now (recurring 3+ HIGH or 5+ MEDIUM) + 1 stale deferral
(>30 days). Run locally with `npm run learning:weekly-review --repo <name>`.

### Opt-outs
- `LEARNING_DISABLE=1` — global kill switch; disables all live learning +
  telemetry recording in one env var.
- `LEARNING_QUEUE_CAP_PER_TYPE=64` — bounded sub-queue cap per
  `decision_type`. Defaults to 64; high-frequency event types cannot evict
  low-frequency ones.

### CLI
- `npm run learning:weekly-review` — generate digest, post sticky issue
- `npm run learning:stats --repoName <name>` — counts of pending triage,
  no-brainer recurring, stale deferrals
- `npm run learning:record` — generic decision logger (mostly for tools)
- `npm run learning:quickfix-stats` — Phase 2; print Beta posteriors per pattern
- `npm run learning:quickfix-rebuild` — Phase 2; rebuild stats cache from cloud
- `npm run learning:quickfix-bootstrap` — Phase 2; rebuild from local
  `.audit/quickfix-hits.jsonl` (for repos without cloud history yet)
- `npm run learning:backfill-outcomes` — Phase 2; drain hits JSONL into
  `learning_decisions`, then resolve unresolved outcomes from file state
- `npm run learning:replay <decision_type> [--policy <path>] [--since 30d] [--format markdown]`
  — Phase 3; counterfactual evaluation of a candidate policy against
  historical decisions.  Built-in reward fns: `pass_selection`,
  `convergence_predict`, `arch_memory_band` (per master plan §5).

### Live quickfix learner (Phase 2)

Per-repo Beta posteriors over each quickfix pattern's accept-vs-suppress
outcomes.  The hot path stays synchronous: `matchPatterns()` reads the
derived `.audit/quickfix-pattern-stats.json` cache (`fs.readFileSync`,
no network) and skips patterns whose `acceptanceRate < 0.20 AND
totalHits >= 10` per repo.  Cache freshness is enforced by an
out-of-band reconciler (`backfill-outcomes.mjs`) which the weekly cron
runs BEFORE the digest assembly.

**Hit lifecycle**:
1. `.claude/hooks/quickfix-scan.mjs` fires on Edit/Write — appends one
   record per match to `.audit/quickfix-hits.jsonl` with a uuid `hit_id`.
2. `learning:backfill-outcomes` drains new JSONL entries into
   `learning_decisions` (decision_type=`quickfix_hit`, outcome=null).
3. After 30 minutes, the same reconciler examines the file state at the
   cited path: line removed/changed → `accept`; line gained `// quickfix-hook:ignore`
   → `suppress`; line still present, no marker → `ignore`; file deleted
   → `accept`.  Rows older than 30min that still can't be resolved stay
   pending until the next cycle.
4. On the next weekly cron, `learning:quickfix-rebuild` aggregates the
   resolved outcomes into the cache file; the hot path picks them up.

**Skip-rule env tuning**:
- `LEARNING_QUICKFIX_SKIP_THRESHOLD` (default `0.20`) — minimum acceptance
  rate below which a pattern is skipped.  Lower = more aggressive skip.
- `LEARNING_QUICKFIX_MIN_HITS` (default `10`) — minimum hit count before
  the skip rule applies.  Single-digit hits never trigger.

### Replay framework + remaining telemetry (Phase 3)

Phase 3 ships the **graduation infrastructure** that lets future v2 candidates
promote from telemetry-only to live without a 3-month wait:

**Telemetry hooks**:
- **`convergence_predict`** — `recordDecision` per round in `openai-audit.mjs`
  capturing `{round, highCount, mediumCount, dismissed, totalFindings}`.
  Outcome is resolved out-of-band by reading `audit_runs.round_converged_after`
  + `rigor_pressure_round` once the run finishes (this round vs convergence
  point → `converged-here` / `continued` / `wasted`).
- **`arch_memory_band`** — `recordDecision` per neighbourhood-query record in
  `scripts/lib/neighbourhood-query.mjs`.  Off-audit; `decision_key` format is
  `arch_memory_band:<symbol_index_id>`.  Outcome resolved by scanning git
  history within 30 min of the decision: `reuse-correct` (no edits in dir),
  `wrong-fork` (edits despite reuse recommendation), `extend-correct` (edits
  consistent with extend recommendation), or `uncertain`.

**Replay engine** (`scripts/lib/learning/replay.mjs`): pure counterfactual
evaluator.  Reads historical `learning_decisions`, runs both a baseline
policy + a candidate policy on each row's recorded context, computes
reward distributions + delta summary.  Built-in reward functions encode
the master plan §5 promotion gates for all three decision types.

**Replay CLI** (`scripts/learning/replay.mjs`):
```
npm run learning:replay <decision_type> \
  [--policy <module-path>] \
  [--baseline <module-path>] \
  [--since 30d] \
  [--repo-id <uuid>] \
  [--format json|markdown]
```
Custom policy modules export either `default` or `policy` as a function
mapping `(context) → choice`.  Stdout is JSON by default; markdown
switch produces a comparison table.

**Promotion recipe** (per master plan §5): collect ≥30 days of telemetry,
write a candidate policy fn, run replay, validate metrics (e.g. `pass_selection`
≤5% recall loss; `convergence_predict` ≤2% false-stop rate; `arch_memory_band`
≥10% precision lift on reuse band), then flip a live env flag.

### Environment-aware outbox
On flush failure, decisions spill to `.audit/learning-outbox/` (one JSON
file per failed write, atomic via temp+rename) for replay on next audit
start. In CI runtimes (`process.env.CI` or `GITHUB_ACTIONS` truthy), the
disk outbox is disabled in favour of synchronous retry with exponential
backoff (3 attempts: 200ms/600ms/1.8s); failures are counted as
`lostInCI` and logged but never crash the run.

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `OPENAI_API_KEY` | Yes | — | GPT access (audit model defaults to latest pinned GPT) |
| `GEMINI_API_KEY` | No | — | Gemini final review (Step 7 falls back to Claude Opus if absent) |
| `OPENAI_AUDIT_MODEL` | No | `latest-gpt` | Model sentinel or concrete ID (see "Model Resolution" below) |
| `OPENAI_AUDIT_REASONING` | No | `high` | Reasoning effort |
| `GEMINI_REVIEW_MODEL` | No | `latest-pro` | Gemini model sentinel or concrete ID |
| `GEMINI_REVIEW_TIMEOUT_MS` | No | `120000` | Gemini timeout |
| `ANTHROPIC_API_KEY` | No | — | Claude Haiku fallback for brief generation (sdk backend only) |
| `CLAUDE_BACKEND` | No | `sdk` | Routing for Claude calls: `sdk` (raw API) or `cli` (`claude -p` headless — draws from Max 20x Agent SDK $200/mo credit from 2026-06-15). See "Anthropic Backend Routing" below. |
| `CLAUDE_BIN` | No | `claude` | Path/name of the `claude` CLI (cli backend only) |
| `CLAUDE_FINAL_REVIEW_MODEL` | No | `latest-opus` | Claude Opus override (Step 7 fallback) |
| `BRIEF_MODEL_GEMINI` | No | `latest-flash` | Brief-generation Gemini model |
| `BRIEF_MODEL_CLAUDE` | No | `latest-haiku` | Brief-generation Claude model |
| `META_ASSESS_MODEL` | No | `latest-flash` | Meta-assessment Gemini model |
| `META_ASSESS_GPT_FALLBACK` | No | `latest-gpt-mini` | Meta-assessment GPT fallback when GEMINI_API_KEY is absent |
| `SUPPRESS_SIMILARITY_THRESHOLD` | No | `0.35` | Jaccard threshold for R2+ suppression (0.0-1.0) |
| `SUPABASE_AUDIT_URL` | No | — | Supabase project URL for audit-loop cloud learning store |
| `SUPABASE_AUDIT_ANON_KEY` | No | — | Supabase anon key for audit-loop (falls back to local-only mode) |
| `AUDIT_STORE` | No | auto | Storage backend: `supabase` (REST), `postgres` (direct — use with dedicated pooler on Pro), `sqlite`, `github`, `noop` |
| `AUDIT_STORE_POSTGRES_URL` | No | — | Direct Postgres URL — use dedicated pooler string from Supabase dashboard → Connect (port 6543, transaction mode) for Pro plan |
| `PERSONA_TEST_SUPABASE_URL` | No | — | Supabase project URL for persona-test session memory |
| `PERSONA_TEST_SUPABASE_ANON_KEY` | No | — | Supabase anon key for persona-test |
| `PERSONA_TEST_APP_URL` | No | — | Default app URL for persona-test list/add (per-project `.env`) |
| `PERSONA_TEST_REPO_NAME` | No | — | Repo name for cross-referencing audit-loop findings (per-project `.env`) |
| `MEMORY_HEALTH_WINDOW_DAYS` | No | `30` | Memory-health lookback window |
| `MEMORY_HEALTH_FUZZY_RATE` | No | `0.15` | Fuzzy re-raise rate trigger threshold |
| `MEMORY_HEALTH_CLUSTER_MEDIAN` | No | `5` | Cluster density trigger threshold (median similar pairs/repo) |
| `MEMORY_HEALTH_RECURRENCE_RATE` | No | `0.10` | Fixed-finding recurrence rate trigger threshold |
| `MEMORY_HEALTH_MIN_FINDINGS` | No | `50` | Minimum findings in window to report a trigger (below → INSUFFICIENT_DATA) |
| `SUPABASE_AUDIT_SERVICE_ROLE_KEY` | No (Phase 1) | — | Service-role key required for writes to RLS service-role-only tables (`learning_decisions`, `recurring_finding_clusters`). Missing → graceful degrade to local outbox. |
| `LEARNING_DISABLE` | No | — | Set to `1` to disable all adaptive-learning live behaviour and telemetry recording (single env-var kill switch). |
| `LEARNING_REPO_NAME` | Required for weekly-review | — | Per-repo gate for `weekly-review.mjs`. Aborts if missing — prevents cross-tenant data leakage in the digest issue body. |
| `LEARNING_QUEUE_CAP_PER_TYPE` | No | `64` | Per-`decision_type` bounded sub-queue cap. Increase for high-throughput audits. |

## Anthropic Backend Routing

All Claude API calls go through [`scripts/lib/anthropic-client.mjs`](scripts/lib/anthropic-client.mjs).
The `CLAUDE_BACKEND` env switches the underlying transport without touching
call sites:

| Backend | Transport | Bills against | Use when |
|---|---|---|---|
| `sdk` (default) | `@anthropic-ai/sdk` direct API | `ANTHROPIC_API_KEY` token meter | Today; CI without `claude` CLI installed |
| `cli` | `claude -p --output-format json` subprocess | **Before 2026-06-15**: your interactive Max 20x subscription (same pool as IDE sessions). **From 2026-06-15**: dedicated Max 20x Agent SDK $200/mo credit. | After credit redemption opens; reduces API spend on high-volume scripts |

> ⚠️ **DO NOT flip `CLAUDE_BACKEND=cli` before 2026-06-15.** Until that date,
> every `claude -p` invocation eats from the same subscription pool as your
> interactive Claude Code sessions, so automated scripts would cannibalise
> the IDE budget. From June 15 the pools split and the cli backend draws
> from the dedicated credit. Default stays `sdk` for safety.
>
> **Operational prerequisite — install [`claude-trace`](https://github.com/badlogic/claude-trace) BEFORE flipping the flag.**
> The $200 credit is non-rolling and overage requires manually-enabled
> billing. Without per-call token + cost telemetry you can rack up
> overage charges from things like `npm run arch:refresh` (hundreds of
> Haiku calls) without realising. claude-trace is free, runs locally,
> and gives you the baseline to know whether the credit is generous or
> tight for your usage pattern.

**Migration**: call sites use the factory instead of `new Anthropic({apiKey})`:

```js
const { createAnthropicClient } = await import('./anthropic-client.mjs');
const client = await createAnthropicClient();
const resp = await client.messages.create({ model, max_tokens, system, messages });
```

The adapter exposes the same `.messages.create()` shape as the raw SDK, so
the body of every call site stays identical. The factory caches a single
client per `(backend, apiKey, claudeBin)` key for the process lifetime —
matches the "reuse client created in main()" rule below.

**Already migrated**: [scripts/lib/context.mjs](scripts/lib/context.mjs)
(brief generation), [scripts/lib/neighbourhood-query.mjs](scripts/lib/neighbourhood-query.mjs)
(security-memory consultation), [scripts/lib/llm-wrappers.mjs](scripts/lib/llm-wrappers.mjs)
(shared `callClaude`).

**Pending migration** (still call `new Anthropic()` directly — drop-in swap
when revisited): [scripts/symbol-index/summarise.mjs](scripts/symbol-index/summarise.mjs),
[scripts/symbol-index/summarise-domains.mjs](scripts/symbol-index/summarise-domains.mjs),
[scripts/refine-prompts.mjs](scripts/refine-prompts.mjs),
[scripts/evolve-prompts.mjs](scripts/evolve-prompts.mjs),
[scripts/gemini-review.mjs](scripts/gemini-review.mjs) (Opus fallback paths).

**Smoke test**: `npm run anthropic:ping` invokes a tiny prompt through
whichever backend the env resolves to.

## Cross-Skill Data Loop

Migration `20260419120000_cross_skill_data_loop.sql` closes the feedback loop
between the 6 skills. Every skill writes to a shared learning store via
`scripts/cross-skill.mjs` — graceful no-op when Supabase is off.

### Tables

| Table | Writer | Reader | Purpose |
|-------|--------|--------|---------|
| `plans` | `/plan-backend`, `/plan-frontend`, `openai-audit.mjs` | `/audit-loop`, `/ux-lock verify` | Register plan artefact, link audit_runs via plan_id |
| `regression_specs` | `/ux-lock`, `/ux-lock verify` | `/ship` | Record every Playwright spec authored (lock or verify mode) |
| `regression_spec_runs` | `/ux-lock`, CI | `meta-assess.mjs` | Per-run pass/fail history — `captured_regression=true` is a "save" |
| `persona_audit_correlations` | `/persona-test` | `bandit.mjs` | The highest-leverage table — persona P0/P1 ↔ audit finding ground-truth labels |
| `ship_events` | `/ship` | Dashboards | Outcome log: shipped / blocked / warned / overridden / aborted |
| `plan_verification_runs` | `/ux-lock verify` | `/ship`, dashboards | One row per verify invocation; totals for satisfaction % |
| `plan_verification_items` | `/ux-lock verify` | `/ship`, meta-assess | Per-criterion pass/fail with stable `criterion_hash` for time-series |

### Added columns

| Column | Table | Writer |
|--------|-------|--------|
| `commit_sha`, `branch`, `plan_id` | `audit_runs` | `openai-audit.mjs` in `runMultiPassCodeAudit` |
| `commit_sha`, `deployment_id` | `persona_test_sessions` | `/persona-test` Phase 6 |

### Views

| View | Query for | Used by |
|------|-----------|---------|
| `audit_effectiveness` | User-visible precision + recall per repo | `meta-assess.mjs` (prompt evolution) |
| `unlocked_fixes` | Recent HIGH fixes without a /ux-lock spec | `/ship` Step 0.5b |
| `regression_saves` | Spec runs that caught a real regression | Dashboards |
| `ship_gate_effectiveness` | How often each block reason fires + override rate | Dashboards |
| `plan_satisfaction` | Latest verify run per plan + failing P0/P1 criteria | `/ship`, `/ux-lock verify` report |
| `persistent_plan_failures` | Criteria that have failed ≥2 consecutive runs | Meta-assess (chronic gaps) |

### Bandit reward extension

`computeReward(resolution, evaluationRecord, userImpact)` — when a
`persona_audit_correlations` row exists for a finding, the reward formula
shifts from 40/30/30 (procedural/substantive/deliberation) to
35/25/25/15 with the user-impact term weighted by persona severity. See
`computeUserImpactReward()` in [scripts/bandit.mjs](scripts/bandit.mjs).

**Design rule**: all cross-skill writes go through `scripts/cross-skill.mjs`.
Never hand-write curl POSTs in a SKILL.md for these tables — the CLI handles
auth, graceful no-op, git-derived commit_sha, and error normalisation.

## R2+ Audit Mode (Phase 1)

When `--round >= 2`, the audit script enables three-layer defence against finding churn:

1. **Rulings injection** (Layer 1): `buildRulingsBlock()` formats prior rulings as system-prompt exclusions
2. **R2+ prompts** (Layer 2): `R2_ROUND_MODIFIER` + pass rubric (not "find all issues")
3. **Post-output suppression** (Layer 3): `suppressReRaises()` fuzzy-matches findings against ledger

### R2+ CLI Flags

| Flag | Purpose |
|------|---------|
| `--round <n>` | Round number (triggers R2+ mode if >= 2) |
| `--ledger <path>` | Adjudication ledger JSON (rulings + suppression) |
| `--diff <path>` | Unified diff (git diff output) for line-level annotations |
| `--changed <list>` | Files modified this round (authoritative for reopen detection) |

### Adjudication Ledger

Two-axis state model: `adjudicationOutcome` (dismissed/accepted/severity_adjusted) + `remediationState` (pending/planned/fixed/verified/regressed). Written by orchestrator via `writeLedgerEntry()`.

## Architectural Memory — Pre-fix Consultation (MANDATORY)

The architectural-memory feature (`docs/completed/architectural-memory.md`)
indexes every symbol in this repo into Supabase, with embeddings, so we
can find near-duplicates before writing new code. The `/plan-backend`
and `/plan-frontend` skills consult it automatically. **But ad-hoc
fixes in Claude Code or Copilot bypass the planning skill entirely** —
which is where most architectural drift creeps in.

**Rule** — if you (the AI agent reading this) are about to write a new
function, class, hook, component, route, method, or constant as part of
a fix or feature request, you MUST first run:

```bash
node scripts/cross-skill.mjs get-neighbourhood --json '{
  "targetPaths": ["<files you intend to touch>"],
  "intentDescription": "<one-line summary of what you are about to write>",
  "k": 8
}'
```

Then act on the recommendation column:

- **`reuse`** (cosine ≥ 0.90) — reuse the existing symbol unless the user explicitly wants a sibling. Note the existing symbol in your reply.
- **`extend`** (0.85–0.90) — strongly prefer extending the existing symbol; document why if you create a new one.
- **`justify-divergence`** (0.75–0.85) — write the new code, but explicitly mention in your reply that you saw the similar candidate and why divergence is the right call.
- **`review`** (<0.75) or empty records — proceed greenfield.

**When NOT to consult**:

- Pure bug fixes that change only an existing function's body (no new symbol introduced).
- Trivial edits: typos, formatting, single-line conditional tweaks.
- Doc-only or test-only changes (unless adding new test helpers).
- When the cloud store is offline (`{"cloud": false}`) — log a hint that `npm run arch:refresh` would enable consultation, then proceed.

**Auto-fired via Claude Code hook**: `.claude/hooks/arch-memory-check.sh`
runs on `UserPromptSubmit` whenever the user's prompt contains an intent
verb (`fix`, `add`, `implement`, `create`, `build`, `write`, `refactor`,
`make`, `wire`, `hook`, `introduce`, `replace`, `extend`). If the
consultation fired, you'll see a `> **Architectural-memory consultation**`
callout prepended to the prompt — treat it as authoritative and follow
the recommendation column. If it didn't fire (e.g., the user asked a
question that turned into a fix mid-conversation), run the command
manually as described above.

**Disable per-session** (rare — debugging the hook, or working on the
hook's own tests): set `ARCH_MEMORY_HOOK_DISABLE=1` in env.

**Cost**: each consultation = 1 Gemini embed (~$0.0003) + 1 Supabase
RPC (~50–200ms). Cached on disk by `(intentDescription, model, dim)`
so repeats within 24h are free.

## Security incident memory — Mandatory consultation

Companion to architectural memory. The `/plan` skill auto-fires
`get-incident-neighbourhood` in Phase 0.5b — for ad-hoc fixes outside
`/plan`, manually consult before writing security-relevant code:

```bash
node scripts/cross-skill.mjs get-incident-neighbourhood --json '{
  "targetPaths": ["<files you intend to touch>"],
  "intentDescription": "<one-line summary>",
  "k": 3
}'
```

**When to consult**: any change to auth flows, payment handling, input
parsing, log statements that might carry sensitive data, external API
calls with credentials, file uploads, or anything in a domain previously
mentioned in `docs/security-strategy.md` incidents.

**When NOT to consult**: pure UI tweaks, type-only refactors, test
fixtures, doc-only changes, cosmetic edits.

If the response includes incidents with `mitigation-failing` or
`manual-verification-required` status that match your target paths,
explicitly address them in the design before proposing code.

If `docs/security-strategy.md` doesn't exist for this repo, run
`/security-strategy bootstrap` once to seed it. Single-line
post-push reminders surface security-relevant commits via `/ship`.

---

**Empirical effectiveness test** (run once per repo when deploying, and
after major prompt changes — the recipe is also embedded as comments at
the bottom of `tests/hook-arch-memory-check.test.mjs`):
1. Pick a fix that has known near-duplicates (e.g. for ai-organiser:
   "add a function that watches vault file renames").
2. Two fresh Claude sessions, same prompt:
   - Session A: `ARCH_MEMORY_HOOK_DISABLE=1` (control)
   - Session B: hook enabled (treatment)
3. Record per session: did Claude reuse, mention, or write blind? Token delta.
4. Hook is "effective" if treatment reuses-or-mentions in ≥60% of cases
   vs control's baseline. Run on 5–10 representative prompts.

## Quick-fix detection — two-layer architecture

Plan: `docs/completed/brainstorm-quickfix-v1.md` Feature B.

**Philosophy**: nudge, not gate. Root cause beats shortcut, but explicit
acceptance beats silent shortcut. The system surfaces shortcuts so the
author can decide whether they're warranted, not so they're automatically
blocked.

### Layer 1 — Prospective hook (`.claude/hooks/quickfix-scan.mjs`)

Fires on every Edit / Write via the PostToolUse hook in
`.claude/settings.json`. Pattern-scans the new content for ~12 mechanical
shortcut signatures (empty catch, TODO/FIXME, `@ts-ignore` without
justification, magic numbers in conditionals, masked errors, disabled
assertions, hardcoded localhost/http URLs, …). Pure regex — no LLM, no
network, <200ms target.

When a pattern matches the hook emits a `<system-reminder>` callout
listing the file, snippet (redacted via `redactSecrets()` BEFORE
truncation), and a suggestion. It NEVER blocks the tool call. The
matched line is also appended to `.audit/quickfix-hits.jsonl`
(gitignored) for retrospective analysis.

**Disable mechanisms**:
- `QUICKFIX_HOOK_DISABLE=1` env (whole-session opt-out, e.g. rapid prototyping)
- `// quickfix-hook:ignore` on the same line (per-line opt-out — uses
  language-correct comment syntax: `//` for JS/TS/SCSS, `#` for Python/Bash/Ruby,
  `<!-- ... -->` for HTML, `/* ... */` for CSS)
- Auto-bail on diffs > 80,000 chars (signal drowns in noise on large refactors)
- Sensitive-path short-circuit — files matching `.env`, `secrets/`, `.aws/`,
  `.ssh/`, `*.pem`, `*.key`, etc. are never scanned (path normalised first
  so `C:\repo\.env` and `/Users/.../repo/.env` both match)

Pattern matrix lives in `scripts/lib/quickfix-patterns.mjs` — adding a
new pattern is one entry in the `PATTERNS` array.

### Layer 2 — Retrospective audit pass (`quickfix` in /audit-code)

Wave 4 in `scripts/openai-audit.mjs`. Low-reasoning GPT pass that
catches DESIGN-level shortcuts the regex hook can't see — stub
functions returning constants, tests asserting non-failure rather than
correctness, hardcoded sample data inline where a fixture would be
cleaner, side-issue fixes that mask root causes. Findings emit
`is_quick_fix: true` and the existing `quickFix == 0` convergence
threshold gates them so /audit-code naturally fails until they're
addressed (or accepted via debt-capture).

Why two layers: the hook catches mechanical patterns at edit time
(immediate feedback, low cost). The audit pass catches semantic
shortcuts during PR review (deeper analysis, higher cost). Neither
covers the other's domain; together they cover both axes. See
`docs/completed/brainstorm-quickfix-v1.md` §B for the full spec.

## Personal config — keep it out of the public repo

This repo is **public on GitHub**. The committed `.claude/settings.json`
must contain only project-portable, neutral values. Per-developer
overrides — local paths, machine-specific tweaks, personal allow-rules —
go in **`.claude/settings.local.json`** (gitignored at line 9 of
`.gitignore`).

Most relevant: `permissions.additionalDirectories`. Never add personal
folder paths (other projects, vault locations, AppData paths) to the
committed `settings.json`. The empty-array placeholder is intentional.

See `.claude/settings.local.example.json` for the format. To add your
own paths after cloning:

```bash
cp .claude/settings.local.example.json .claude/settings.local.json
# edit additionalDirectories with your local paths
```

Claude Code merges `settings.json` (project) with `settings.local.json`
(local) automatically — your local entries layer on top of the committed
defaults without polluting the public repo.

## Scope discipline — pre-existing uncommitted changes

When you find uncommitted, unstaged, untracked, or unpushed changes in
the repo that are **unrelated to the current task**: leave them alone.
They are the user's working set, not yours to tidy.

**Rules:**

- **Stage by name only** — never `git add -A`, `git add .`, or `git
  add -u`. Stage exactly the files you modified for the current task.
- **Never auto-commit** pre-existing state to "clean up" — that
  bundles unrelated work into your commit and corrupts blame/history.
- **Never auto-stash** unrelated work — stash conflicts on pop bite
  worse than the original mess.
- **Never `git rm --cached`** legacy tracked-but-gitignored files
  without an explicit user instruction; that change ships to every
  collaborator and isn't reversible by `git pull`.
- **Mention what you saw, once**, in a one-line note: *"Heads-up:
  there are 3 unrelated unstaged files (foo.ts, bar.mjs, baz.json) I
  left untouched."* Then move on — don't relitigate them.
- If the unrelated state genuinely blocks the task (e.g., a half-edited
  file you need to also edit), stop and ask the user how to proceed
  before touching it.

**Why:** Scope expansion is the failure mode this rule prevents.  Without
it, sessions drift from the requested task into repo-hygiene meta-work
the user didn't authorise, and the final commit bundles unrelated work
that's hard to revert cleanly.  Repo hygiene is a separate, dedicated
task — request it explicitly when you want it done.

## Code Style

- ESM modules (`import`/`export`, not `require`)
- `process.stderr.write()` for progress logging (keeps stdout clean for JSON output)
- `--out <file>` pattern: JSON to file, 1-line summary to stdout
- Zod schemas define structured output contracts for all LLM calls
- Functions follow `{result, usage, latencyMs}` return contract

## Do NOT

- Use `_def.typeName` or `_def.shape()` — these are Zod 3 patterns, we use Zod 4
- Send `.env` or credential files to external APIs
- Use `require()` — project is ESM-only
- Create new Anthropic/OpenAI client instances per call — reuse the client created in `main()`

## Accepted Technical Debt

These items were evaluated and deliberately accepted:

| Item | Rationale | Revisit trigger |
|------|-----------|-----------------|
| `atomicWriteFileSync` no fsync | CLI tool, not a database. Rename atomicity protects against process crash (the real failure mode). | Never — unless used in a daemon/server context |
| `atomicWriteFileSync` temp naming (PID+timestamp) | Collision requires same PID + same millisecond + same directory. Probability negligible. | Never |
| `readFileOrDie` process.exit(1) | Name is self-documenting. Only called from CLI entry points. | If ever called from a library context |
| `normalizePath()` lowercasing | Correct for Windows (case-insensitive FS). On case-sensitive Linux, distinct files could collide — acceptable for local-repo auditing. | If deployed as a CI service on Linux |
| Module-global caches (`_repoProfileCache`, `_taskStore`, `_clientCache`) | Safe in CLI-per-invocation model. Each process starts fresh. Anthropic client cache uses effective-resolved env values so two unparameterised calls hit the same entry. `_resetClientCache()` available for tests. | If extracting as a library or running as a long-lived server |
| `anthropic-client.mjs` `_internals` test exports | Mirrors `file-io.mjs`, `shared.mjs` project pattern. Internal helpers (`buildPromptFromMessages`, `normaliseCliOutput`, `quoteWinArg`) need direct test coverage; underscore-prefix signals private. | If we adopt stricter export hygiene project-wide |
