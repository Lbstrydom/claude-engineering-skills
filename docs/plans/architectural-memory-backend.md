# Plan: Architectural Memory — Backend

- **Date**: 2026-05-01
- **Status**: Complete (shipped — `scripts/symbol-index/{refresh,extract,summarise,embed,render-mermaid,drift,duplicates,prune}.mjs` + 6 Supabase tables. Status line corrected 2026-05-23.)
- **Author**: Claude + Louis
- **Scope**: Backend half of the architectural-memory feature. The companion
  document `architectural-memory-frontend.md` covers rendered-markdown +
  Mermaid surfaces. Both will be merged into `architectural-memory.md`
  for `/audit-plan`.

---

## 1. Context Summary

### What exists today

`claude-audit-loop` has a sophisticated learning store but no codified
**architectural memory** of the consumer repos it audits. Key observations
from Phase 1 exploration:

- **Cross-skill data loop already in place**:
  `supabase/migrations/20260419120000_cross_skill_data_loop.sql` introduced
  `plans`, `regression_specs`, `persona_audit_correlations`, `ship_events`.
  All writes flow through `scripts/cross-skill.mjs` — graceful no-op when
  Supabase is off, Zod-validated payloads, error-normalised output.
- **Memory-health gate is the closest precedent**:
  `scripts/memory-health.mjs` + `.github/workflows/memory-health.yml`
  + `supabase/migrations/20260421163525_memory_health.sql` form a
  weekly trigger pattern (RPC → render Markdown → sticky GH issue,
  auto-close on green) that this plan should mirror exactly.
- **Static analysis already partially exists**:
  `scripts/lib/code-analysis.mjs` builds dependency graphs and audit
  units in-process — but the result is ephemeral. Nothing is persisted
  per-symbol across runs.
- **Audit is diff-scoped by default**: cross-file duplication is
  invisible at audit time. Drift only surfaces during full-scope
  audits, which are rare.
- **Model resolution discipline**: `scripts/lib/config.mjs` reads every
  model ID through `resolveModel()` sentinels (`latest-haiku`, `latest-flash`).
  No concrete model IDs in new code.
- **Migration style**: idempotent (`CREATE TABLE IF NOT EXISTS`, `ALTER ... IF NOT EXISTS`),
  RLS enabled with anon-permissive policies (`anon_all_<table>`), pg_trgm
  already enabled in the project.
- **Test runner**: Node built-in `node --test`; tests live in `tests/*.test.mjs`.

### Patterns to reuse

| Need | Reuse |
|---|---|
| Cross-skill writer | `scripts/cross-skill.mjs` subcommand pattern (parsePayload, isCloudEnabled, emit JSON) |
| Migration shape | `20260421163525_memory_health.sql` (RPC + indexes + extension enable) |
| Weekly trigger | `.github/workflows/memory-health.yml` (sticky issue, auto-close) |
| Model selection | `scripts/lib/model-resolver.mjs` sentinels via `config.mjs` |
| Atomic writes | `atomicWriteFileSync()` from `scripts/lib/file-io.mjs` |
| Per-skill consultation | `scripts/cross-skill.mjs detect-stack` is the prior art for skill→CLI calls |

### What is new

- A persisted **per-repo symbol index** (Supabase + pgvector).
- Symbol extraction via **dependency-cruiser** (new npm dep).
- LLM-derived **purpose_summary** per symbol (one-line, signature-hash cached).
- A **plan-time consultation API** (`getNeighbourhood`) wired into
  `plan-backend`, `plan-frontend`, and `audit-code --scope=full`.
- A **weekly architectural-drift sweep** mirroring `memory-health`.

### Known user-visible issues

`PERSONA_TEST_REPO_NAME` is unset for `claude-audit-loop` itself
(this repo is the tooling, not a consumer app). No persona sessions
to consult. Skipping the persona pre-step.

---

## 2. Phase 1.5 — Execution Model

The feature has genuine inter-operation dependencies — this is not a
collection of independent operations.

### Dependency graph

```
extract (dep-cruiser walk)
   │
   ├─► normalise + signature_hash compute      [pure, deterministic]
   │      │
   │      ├─► cache-hit? skip downstream LLM/embed
   │      │
   │      └─► cache-miss → batch summarise (Haiku)
   │                          │
   │                          └─► batch embed (Gemini text-embedding-004)
   │                                 │
   │                                 └─► upsert symbol_index row
   │
   └─► dep-cruiser rules → upsert symbol_layering_violations
```

### Chains and atomicity

| Chain | Atomicity | Partial-failure semantics |
|---|---|---|
| extract → hash → upsert (cache-hit path) | Per-symbol independent | Skip failed symbol, log, continue. Next run retries via `last_seen_commit` mismatch. |
| summarise → embed → upsert (cache-miss path) | Per-batch (50–100 symbols) | If LLM call fails for a batch, mark symbols as `purpose_summary IS NULL` and emit metric. Subsequent run retries. **Never** commit a row with `embedding IS NULL` AND `purpose_summary IS NOT NULL` (inconsistent state) — wrap as a single transaction per batch. |
| Layering-violations sync | Per-repo bulk replace | Atomic per repo: write to a temp table, swap (or use `INSERT ... ON CONFLICT DO UPDATE` with a sweep of stale rows by `last_seen_at < now() - 5m`). |
| Drift score compute | Read-only RPC | If RPC fails, weekly action exits 2 (infra error), no sticky issue updated — same pattern as memory-health. |

### Concurrency model

- Symbol extraction is single-threaded (dep-cruiser is a single process).
- LLM batching: parallel up to `ARCH_INDEX_LLM_CONCURRENCY` (default 4).
- Embedding batching: parallel up to same concurrency.
- Per-skill consultation (`getNeighbourhood`) is a single read query — no
  concurrency concerns.
- The weekly action uses `concurrency: { group: architectural-drift, cancel-in-progress: false }`
  identical to memory-health.

### Sequencing rule (LOAD-BEARING)

Incremental refresh must read `last_seen_commit` per symbol **before** the
new walk begins. Otherwise a partial walk that fails mid-way could leave
some symbols with stale `last_seen_commit` and trick the next run into
skipping changed files. Guard: store the **walk start commit** at the
top of `refresh.mjs`; only update `last_seen_commit` for a symbol after
its row has been successfully upserted.

---

## 3. Proposed Architecture

### Component diagram

```
                ┌────────────────────────────────────────────┐
                │  scripts/symbol-index/refresh.mjs (CLI)     │
                │  npm run arch:refresh                       │
                └──────────┬──────────────┬───────────┬───────┘
                           │              │           │
                  ┌────────▼─────┐ ┌──────▼─────┐ ┌──▼────────────┐
                  │ extract.mjs  │ │ summarise   │ │ embed.mjs     │
                  │ (dep-cruiser)│ │ .mjs (Haiku)│ │ (Gemini emb.) │
                  └────────┬─────┘ └──────┬─────┘ └──┬────────────┘
                           │              │           │
                           ▼              ▼           ▼
                ┌────────────────────────────────────────────┐
                │  scripts/lib/symbol-index.mjs               │
                │  (in-process API: hash, batch, neighbour)   │
                └──────────┬─────────────────────┬────────────┘
                           │                     │
                ┌──────────▼──────┐     ┌────────▼──────────┐
                │ learning-store   │     │ cross-skill.mjs    │
                │ .mjs (DB I/O)    │     │ (CLI facade)       │
                └──────────┬──────┘     └────────┬──────────┘
                           │                     │
                           ▼                     ▼
                ┌────────────────────────────────────────────┐
                │  Supabase (symbol_index, symbol_layering_   │
                │  violations, RPC: drift_score, neighbour)   │
                └────────────────────────────────────────────┘
                                          ▲
                                          │
                ┌─────────────────────────┴──────────────────┐
                │  Skill consumers                            │
                │   skills/plan-backend/SKILL.md              │
                │   skills/plan-frontend/SKILL.md             │
                │   skills/audit-code/SKILL.md (--scope=full) │
                └────────────────────────────────────────────┘
```

### Data flow

**Refresh (incremental, on /ship)**:
1. `refresh.mjs --since-commit <last-success>` enumerates changed files.
2. Walks file ASTs via dep-cruiser → emits `{path, symbol_name, kind, signature, start_line, end_line}` records.
3. Computes `signature_hash` for each.
4. Queries existing rows by `(repo_id, file_path, symbol_name)` — cache hit when `signature_hash` matches AND `purpose_summary IS NOT NULL` AND `embedding IS NOT NULL`.
5. For cache-miss symbols: batch-summarise (Haiku), batch-embed (Gemini), upsert.
6. Update `last_seen_commit` for all symbols seen this run.
7. Sweep: rows whose `last_seen_commit` < walk-start-commit AND whose file no longer exists OR symbol no longer present → soft-delete (keep history) or hard-delete (configurable; default soft via `archived_at` timestamp).

**Plan-time consultation (called by /plan-backend or /plan-frontend)**:
1. Skill calls `node scripts/cross-skill.mjs get-neighbourhood --json '{...}'` with `targetPaths` and `intentDescription`.
2. Facade generates an embedding for `intentDescription`.
3. Calls Postgres RPC `symbol_neighbourhood(repo_id, target_paths, intent_embedding, k)`.
4. RPC returns ordered records: 1–2 hop import-graph neighbours unioned with top-k cosine matches.
5. Skill inlines the formatted block (per the frontend plan's spec) into the planning prompt.

**Drift sweep (weekly GH Action)**:
1. `drift.mjs` calls RPC `drift_score(repo_id)`.
2. RPC computes: duplication pairs (cosine > 0.85, same kind, different file), layering violations (count of unresolved), naming divergences (cosine > 0.90 AND name-Levenshtein > 0.5).
3. Score = weighted sum vs thresholds (env-overridable, defaults below).
4. If score crosses threshold → render markdown → workflow opens/updates sticky issue (label `architectural-drift`).
5. If score returns to green → workflow auto-closes (same pattern as memory-health).

### Key design decisions and principles

| # | Decision | Principles |
|---|---|---|
| 1 | Persist per-symbol records in Supabase (not files) | #10 Single Source of Truth, #16 Graceful Degradation (rendered Markdown is regeneration target, not state) |
| 2 | Sentinel-based model selection only | #8 No Hardcoding, #18 Backward Compatibility (model swaps don't break) |
| 3 | All cross-skill writes through `cross-skill.mjs` | #1 DRY, #2 Single Responsibility, #16 Graceful Degradation |
| 4 | Signature-hash cache for LLM/embed reuse | #17 N+1 Prevention (effectively), #19 Observability (cache-hit-rate metric) |
| 5 | RPC-first drift compute (Postgres-side) | #17 N+1 Prevention — pulling all rows to Node and pairwise-comparing is O(n²); SQL with proper indexes does it once |
| 6 | Embedding dim pinned at 768 | #18 Backward Compatibility trade-off — simpler now, documented swap path |
| 7 | Two tables (symbol_index + symbol_layering_violations) | #2 Single Responsibility (different lifecycles, different keys) |
| 8 | `getNeighbourhood` returns scored ordered records | #5 Interface Segregation (skills don't see SQL) |
| 9 | Soft-delete via `archived_at` (not hard delete) | #18 Backward Compat — drift sweep can cite "removed function used to live at..." |
| 10 | Weekly cadence + on-/ship incremental | #7 Modularity (two trigger paths share the same refresh code), #19 Observability (drift trend over time) |

---

## 4. Sustainability Notes

### Assumptions encoded

- **Supabase is the canonical store**. If we move away from Supabase,
  `learning-store.mjs` is the single adapter to swap (matches existing
  pattern). pgvector is not yet a portable abstraction in our code —
  if we ever swap to a non-pgvector store, embedding similarity moves to
  Node-side (acceptable for ≤10K symbols/repo).
- **dependency-cruiser covers our supported stacks**. It handles
  JS/TS/MJS/CJS natively. Python support is via plugin and untested by us;
  v1 ships JS/TS only, with `stack !== 'js-ts'` short-circuiting refresh
  with a friendly warning.
- **Embedding model output is 768-dim**. Documented in `.env.example`.
  Migration to a different dim requires column drop+recreate (one-shot
  pain; documented in rollout).
- **Repo size budget: ≤10K symbols**. Beyond that, ivfflat index quality
  matters more (lists tuning). Documented threshold; revisit if we
  audit a >10K-symbol repo.

### What breaks if requirements change

| Change | What breaks | Containment |
|---|---|---|
| New language support | `extract.mjs` parser must learn it | Adapter pattern: `extractors/<lang>.mjs`, registered by extension |
| New embedding provider | Schema dim, RPC sim function | Documented migration; column drop+recreate |
| New similarity-scoring algorithm | RPC signature | Versioned RPC: `symbol_neighbourhood_v2` (memory-health uses single-version RPC; mirror that until v2 needed) |
| Cross-repo neighbourhood (consumer queries the index of a sibling repo) | Auth model, schema FK | Documented as future scope (see §6) |

### Extension points built in

- `scripts/symbol-index/extractors/` directory ready for per-language extractors.
- `domain_tag` is a free-form text column; can be reassigned by an
  `npm run arch:tag-review` utility (not in v1, sketched in §6).
- `kind` enum is wide (`function`, `class`, `component`, `hook`, `route`,
  `method`, `constant`, `type`, `other`) so new symbol kinds rarely
  require a migration.
- `archived_at` allows reviving deleted symbols if needed (e.g. resurrected feature).

### Pattern we're establishing

This is the **first** persistent per-repo code-state store in
claude-audit-loop. We should design it as a pattern: future stores
(coverage map, perf budget map, dependency-version map) can mirror
its shape — `<thing>_index` table keyed on `(repo_id, identity)`,
with `last_seen_commit` for incremental refresh and a sibling `<thing>_violations`
for cross-cutting flags.

---

## 5. File-Level Plan

### New files

#### `supabase/migrations/20260501120000_symbol_index.sql`

- **Purpose**: Schema for the symbol index, layering violations, and
  the two RPCs (`drift_score`, `symbol_neighbourhood`). Enables `vector`
  extension.
- **Why this file**: #10 Single Source of Truth — schema lives next to
  every other migration; idempotent + RLS-permissive matches house style.
- **Contents** (abbreviated):
  ```sql
  CREATE EXTENSION IF NOT EXISTS vector;

  CREATE TABLE IF NOT EXISTS symbol_index (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_id          UUID NOT NULL REFERENCES audit_repos(id) ON DELETE CASCADE,
    file_path        TEXT NOT NULL,
    symbol_name      TEXT NOT NULL,
    kind             TEXT NOT NULL CHECK (kind IN (
      'function','class','component','hook','route','method','constant','type','other'
    )),
    signature_hash   TEXT NOT NULL,
    purpose_summary  TEXT,
    domain_tag       TEXT,
    embedding        VECTOR(768),
    start_line       INTEGER,
    end_line         INTEGER,
    last_seen_commit TEXT NOT NULL,
    archived_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (repo_id, file_path, symbol_name)
  );
  -- btree indexes
  CREATE INDEX IF NOT EXISTS idx_symbol_index_repo_name
    ON symbol_index (repo_id, symbol_name);
  CREATE INDEX IF NOT EXISTS idx_symbol_index_repo_path
    ON symbol_index (repo_id, file_path);
  CREATE INDEX IF NOT EXISTS idx_symbol_index_repo_domain
    ON symbol_index (repo_id, domain_tag) WHERE archived_at IS NULL;
  -- pgvector ivfflat — created CONCURRENTLY in a follow-up migration
  -- once data is loaded (lists tuning needs row count).
  -- For v1 we ship the index now; can be re-tuned later.
  CREATE INDEX IF NOT EXISTS idx_symbol_index_embedding
    ON symbol_index USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
    WHERE archived_at IS NULL;

  CREATE TABLE IF NOT EXISTS symbol_layering_violations (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_id        UUID NOT NULL REFERENCES audit_repos(id) ON DELETE CASCADE,
    rule_name      TEXT NOT NULL,
    from_path      TEXT NOT NULL,
    to_path        TEXT NOT NULL,
    severity       TEXT NOT NULL CHECK (severity IN ('error','warn','info')),
    comment        TEXT,
    first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at    TIMESTAMPTZ,
    UNIQUE (repo_id, rule_name, from_path, to_path)
  );
  CREATE INDEX IF NOT EXISTS idx_layering_violations_open
    ON symbol_layering_violations (repo_id) WHERE resolved_at IS NULL;

  -- RPC: drift_score(repo_id, sim_dup, sim_name, name_levenshtein)
  -- Returns JSONB: { duplication_pairs: int, layering_violations: int,
  --                  naming_divergences: int, score: numeric, samples: jsonb }

  -- RPC: symbol_neighbourhood(repo_id, target_paths text[],
  --                           intent_embedding vector(768), k int)
  -- Returns SETOF symbol_index_with_score
  -- (combines hop-graph score + cosine similarity)

  -- RLS — match anon-permissive pattern
  ALTER TABLE symbol_index                ENABLE ROW LEVEL SECURITY;
  ALTER TABLE symbol_layering_violations  ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS "anon_all_symbol_index"               ON symbol_index;
  DROP POLICY IF EXISTS "anon_all_symbol_layering_violations" ON symbol_layering_violations;
  CREATE POLICY "anon_all_symbol_index"
    ON symbol_index FOR ALL USING (true) WITH CHECK (true);
  CREATE POLICY "anon_all_symbol_layering_violations"
    ON symbol_layering_violations FOR ALL USING (true) WITH CHECK (true);
  GRANT EXECUTE ON FUNCTION drift_score(UUID, NUMERIC, NUMERIC, NUMERIC)
    TO anon, authenticated;
  GRANT EXECUTE ON FUNCTION symbol_neighbourhood(UUID, TEXT[], VECTOR(768), INTEGER)
    TO anon, authenticated;
  ```

#### `scripts/lib/symbol-index.mjs`

- **Purpose**: In-process API. Pure functions for normalising signatures,
  computing `signature_hash`, batching, ranking. Imported by extract,
  refresh, learning-store. No I/O.
- **Key exports**:
  - `normaliseSignature(symbol)` — strips whitespace, normalises type
    aliases, removes default-value expressions.
  - `signatureHash(normalised)` — sha256.
  - `chunkBatches(symbols, size)` — for parallel LLM/embed.
  - `rankNeighbourhood(records, intentEmbedding)` — Node-side fallback
    when RPC unavailable (combines hop_score + cosine).
- **Why this file**: #2 Single Responsibility, #11 Testability — pure
  functions are unit-testable without DB or LLM.

#### `scripts/symbol-index/extract.mjs`

- **Purpose**: CLI. Uses `dependency-cruiser`'s programmatic API to
  walk the repo. Emits one JSON-line per symbol on stdout.
- **Key flags**: `--root <dir>`, `--since-commit <sha>` (incremental),
  `--config <path>` (dep-cruiser rules).
- **Why this file**: #2 Single Responsibility — one job: parse + emit.

#### `scripts/symbol-index/summarise.mjs`

- **Purpose**: CLI. Reads symbol records from stdin, batches them, calls
  Haiku for one-line purpose summary per symbol, emits enriched records
  on stdout.
- **Why this file**: #2 Single Responsibility — composable with `extract`.

#### `scripts/symbol-index/embed.mjs`

- **Purpose**: CLI. Reads enriched records from stdin, batches them, calls
  Gemini text-embedding-004 (or configured model), emits records with
  embedding arrays on stdout.
- **Why this file**: #2 Single Responsibility — composable.

#### `scripts/symbol-index/refresh.mjs`

- **Purpose**: Orchestrator. Runs extract → summarise → embed → upsert.
  Reads `last_seen_commit` per symbol to skip cache-hits.
- **Key flags**: `--full` (ignore cache, full rebuild), `--since-commit <sha>`,
  `--repo-id <uuid>`.
- **Why this file**: #2 Single Responsibility (orchestration only),
  #14 Transaction Safety (per-batch transaction wrapping).

#### `scripts/symbol-index/drift.mjs`

- **Purpose**: CLI. Calls `drift_score` RPC, evaluates against thresholds,
  renders Markdown report. Mirrors `scripts/memory-health.mjs` exactly.
- **Exit codes**: 0 green, 1 trigger fired, 2 infra error.
- **Why this file**: #1 DRY — pattern reuse from memory-health.

#### `.github/workflows/architectural-drift.yml`

- **Purpose**: Weekly GH Action (Mondays 09:00 UTC, opposite hour from
  memory-health to spread load — 09:30 UTC). Same sticky-issue logic.
- **Label**: `architectural-drift`.
- **Marker**: `<!-- audit-loop:architectural-drift -->`.
- **Why this file**: #1 DRY (mirrors memory-health.yml structure).

#### `tests/symbol-index.test.mjs`

- **Purpose**: Unit tests for `lib/symbol-index.mjs`.
- **Coverage**:
  - `normaliseSignature` — whitespace, default values, type aliases.
  - `signatureHash` — deterministic across runs.
  - `chunkBatches` — edge cases (empty, single, exact-multiple).
  - `rankNeighbourhood` — hop_score + cosine combination, ordering stability.
  - Graceful no-op: when Supabase off, `getNeighbourhood` returns
    `{ records: [], cloud: false }` without throwing.
- **Why this file**: #11 Testability.

### Modified files

#### `scripts/cross-skill.mjs`

- **Changes**:
  - Add subcommand `record-symbol-index` (bulk upsert from JSON payload).
  - Add subcommand `get-neighbourhood` (called by /plan-* skills).
  - Add subcommand `record-layering-violations`.
  - Each follows existing pattern: `parsePayload()` → Zod-validate
    → `isCloudEnabled()` graceful no-op → `learning-store` call → emit.
- **Why**: #1 DRY — single CLI facade for all cross-skill writes.

#### `scripts/learning-store.mjs`

- **New exports**:
  - `recordSymbolIndex(repoId, symbols)` — batch upsert.
  - `recordLayeringViolations(repoId, violations)` — bulk replace pattern.
  - `getNeighbourhood(repoId, targetPaths, intentEmbedding, k)` — RPC call.
  - `computeDriftScore(repoId)` — RPC call.
  - `archiveStaleSymbols(repoId, walkStartCommit)` — soft-delete sweep.
- **Why**: #2 Single Responsibility (DB I/O isolated here).

#### `scripts/lib/config.mjs`

- **Add**:
  ```js
  export const symbolIndexConfig = Object.freeze({
    summariseModel: resolveModel(process.env.ARCH_INDEX_SUMMARY_MODEL || 'latest-haiku'),
    embedModel:     process.env.ARCH_INDEX_EMBED_MODEL || 'text-embedding-004',
    embedDim:       safeInt(process.env.ARCH_INDEX_EMBED_DIM, 768),
    llmConcurrency: safeInt(process.env.ARCH_INDEX_LLM_CONCURRENCY, 4),
    batchSize:      safeInt(process.env.ARCH_INDEX_BATCH_SIZE, 50),
    driftThreshold: parseFloat(process.env.ARCH_DRIFT_SCORE_THRESHOLD || '20'),
    driftSimDup:    parseFloat(process.env.ARCH_DRIFT_SIM_DUP || '0.85'),
    driftSimName:   parseFloat(process.env.ARCH_DRIFT_SIM_NAME || '0.90'),
    driftNameLev:   parseFloat(process.env.ARCH_DRIFT_NAME_LEVENSHTEIN || '0.50'),
  });
  ```
- **Why**: #8 No Hardcoding, #10 Single Source of Truth.

#### `skills/plan-backend/SKILL.md`

- **Changes (Phase 1 enhancement)**:
  - After the persona-test pre-step, add a **Pre-step — Symbol-index neighbourhood**:
    ```bash
    node scripts/cross-skill.mjs get-neighbourhood --json '{
      "targetPaths": [...],
      "intentDescription": "<task summary>"
    }'
    ```
  - Empty / cloud-off response → log a hint `Run \`npm run arch:refresh\` to enable architectural-memory consultation.` and proceed.
  - Non-empty response → inline the formatted block (per frontend plan)
    into the **Context Summary** section as **"Neighbourhood considered"**.
- **Why**: catches drift at the moment when cost of fixing it is lowest
  — before code is written.

#### `skills/plan-frontend/SKILL.md`

- **Same change** as plan-backend, adapted for frontend symbols.

#### `skills/audit-code/SKILL.md`

- **Change (--scope=full path only)**:
  - When `--scope=full` is set, fetch the full `symbol_index` for the
    repo and inline a "Symbol catalogue (top N by domain)" section into
    the audit context.
  - Helps the audit catch cross-file duplication that diff-scope cannot.
- **Why**: #19 Observability — full-scope audits become more useful
  when they have architectural context.

#### `package.json`

- **New scripts**:
  ```json
  "arch:refresh":     "node scripts/symbol-index/refresh.mjs",
  "arch:refresh:full": "node scripts/symbol-index/refresh.mjs --full",
  "arch:render":      "node scripts/symbol-index/render-mermaid.mjs",
  "arch:drift":       "node scripts/symbol-index/drift.mjs"
  ```
- **New deps**:
  ```json
  "dependency-cruiser": "^17.0.0"
  ```
- (Note: `arch:render` is implemented per the frontend plan.)

#### `AGENTS.md`

- **Add row to env vars table**: every new env var listed.
- **Add subsection** under "Cross-Skill Data Loop": "Architectural Memory"
  — points to migration, lists trigger points, links to docs/architecture-map.md.

---

## 6. Risk & Trade-off Register

| # | Risk / Trade-off | Mitigation |
|---|---|---|
| R1 | pgvector extension may be disabled on Supabase free tier or require dashboard enable | Migration uses `CREATE EXTENSION IF NOT EXISTS vector` — fails loudly on apply if blocked. Document in migration comment + `.env.example`. |
| R2 | Embedding dim lock-in (768 only, Gemini-only) | Documented; column drop+recreate is the migration path. v1 ships Gemini default; OpenAI text-embedding-3-small (1536) requires separate migration. |
| R3 | dep-cruiser is JS/TS only in v1 | Refresh short-circuits with friendly warning when `stack !== 'js-ts'`. Python extractor is future scope. |
| R4 | Signature-hash misses body changes that should re-trigger summary | Accepted. Drift sweep's recurring scan catches the case where `purpose_summary` no longer matches the code via similarity check on neighbours. |
| R5 | First-time embed + summarise cost | ≤$0.10 per 1000 symbols (Haiku + Gemini text-embedding-004). Documented. Steady-state cost is near zero (cache). |
| R6 | ivfflat index quality requires ≥1000 rows for `lists=100` | For small repos (<1000 symbols), full-table scan is fine; ivfflat acts as no-op. Documented. |
| R7 | LLM-derived `domain_tag` may be noisy | Accept v1 noise; ship `npm run arch:tag-review` (sketch only) for human override in v2. |
| R8 | Two skills calling `getNeighbourhood` concurrently from a hook may saturate Supabase | Read query is cheap (single RPC); no observable contention expected. Revisit if metrics show. |
| R9 | Cross-repo neighbourhood (consumer queries another repo's index) | Out of scope for v1. Schema supports it (`repo_id` column); RPC would just take a `repo_ids[]` parameter. |
| R10 | `audit-code --scope=full` symbol-catalogue inlining bloats prompt | Cap at 200 symbols by default (top by recency + similarity), env-tunable via `ARCH_AUDIT_FULL_TOPN`. |

### Deliberately deferred

- **Cross-repo neighbourhood**: useful for orgs with many sibling repos.
  Schema-ready; CLI/RPC additions are minor; defer until requested.
- **Auto-refresh on every `git commit` via hook**: too aggressive; weekly + /ship covers it.
- **Custom dep-cruiser rules per consumer repo**: v1 uses default JS/TS rules.
  Per-repo `.dependency-cruiser.cjs` config will be picked up automatically;
  documented but not bundled.
- **Hand-curated `domain_tag` registry in AGENTS.md**: rejected — drift
  between AGENTS.md text and actual domain assignments is its own problem
  this feature is supposed to prevent. LLM-derived + human override CLI
  is the right shape.
- **Visualisation hosted view** (Supabase → web UI): out of scope; the
  committed Markdown is the human surface (per frontend plan).

---

## 7. Testing Strategy

### Unit tests (`tests/symbol-index.test.mjs`)

- `normaliseSignature` handles whitespace, type-alias normalisation, default args.
- `signatureHash` is deterministic across runs and across platforms (LF vs CRLF safe).
- `chunkBatches` correctness for empty/single/multiple/exact-multiple inputs.
- `rankNeighbourhood`:
  - Hop-score-only ranking (when no embedding match).
  - Cosine-only ranking (when no path overlap).
  - Combined score correctly weighs both.
  - Stable ordering on tie (alphabetical fallback).
- Graceful no-op:
  - `learning-store.getNeighbourhood` returns `{records: [], cloud: false}`
    when Supabase env unset.
  - `cross-skill.mjs get-neighbourhood` emits `{ok: true, cloud: false, records: []}`.

### Integration tests (manual / opt-in)

- Run `npm run arch:refresh:full` against a small fixture repo; verify
  symbol_index population.
- Run `getNeighbourhood` with a known intent against a seeded fixture;
  verify expected symbols appear in top-k.
- Apply migration to a clean Supabase project; verify
  `CREATE EXTENSION` succeeds and RPCs are callable.

### Edge cases

- File renamed: extract sees new `file_path`; old row ages out via sweep.
  `domain_tag` and `purpose_summary` lost (recomputed). Acceptable.
- Symbol renamed (signature unchanged): treated as delete + insert
  (different `(file_path, symbol_name)` key). LLM resummary triggered.
- Empty repo (no symbols extracted): refresh emits warning, exits 0.
- Network failure mid-batch: batch transaction rolls back; next refresh
  retries. Idempotent.
- Repo with `git rev-parse HEAD` unavailable (no .git): refresh treats
  as `--full` mode automatically, with warning.

### `npm run check` integration

- `npm test` will pick up `tests/symbol-index.test.mjs` automatically
  (matches the existing `tests/*.test.mjs` glob).
- No new lint rules required.

---

## 8. Rollout

### Phase A — Schema + Library (no behaviour change)

1. Apply migration `20260501120000_symbol_index.sql` to dev Supabase.
2. Land `scripts/lib/symbol-index.mjs` + tests. CI green.
3. Land `scripts/learning-store.mjs` additions (writers + readers).
4. Land `scripts/cross-skill.mjs` subcommands.
5. Smoke: `node scripts/cross-skill.mjs get-neighbourhood --json '{...}'`
   returns `{ok: true, cloud: false, records: []}` without errors when
   Supabase off.

### Phase B — Extract + Refresh

1. Land `scripts/symbol-index/extract.mjs`, `summarise.mjs`, `embed.mjs`.
2. Land `scripts/symbol-index/refresh.mjs`.
3. Run `npm run arch:refresh:full` against `claude-audit-loop` itself
   (eat your own dog food). Inspect populated rows.
4. Verify cost (Haiku tokens used + Gemini embed calls).

### Phase C — Skill Integration

1. Modify `skills/plan-backend/SKILL.md`, `skills/plan-frontend/SKILL.md`
   with the new pre-step.
2. Modify `skills/audit-code/SKILL.md` for full-scope path.
3. Run `npm run skills:regenerate` to sync `.claude/skills/` copies.
4. Manual smoke: invoke `/plan-backend` for a contrived task; verify
   the neighbourhood block appears.

### Phase D — Drift Sweep

1. Land `scripts/symbol-index/drift.mjs`.
2. Land `.github/workflows/architectural-drift.yml`.
3. Trigger via `workflow_dispatch` once; verify report renders + (if
   threshold crossed) sticky issue opens.
4. Document threshold tuning in `AGENTS.md`.

### Phase E — Frontend artifact (per frontend plan)

1. Land `scripts/symbol-index/render-mermaid.mjs`.
2. Generate first `docs/architecture-map.md` for `claude-audit-loop`.
3. Add `arch:render` to /ship checklist.

### Backward compatibility

- All migrations idempotent. Existing tables untouched.
- All new env vars optional (defaults set in `config.mjs`).
- `getNeighbourhood` cloud-off fallback: skills proceed normally with
  a one-line hint. Existing planning behaviour unchanged when Supabase
  is unset.

---

## 9. Acceptance Criteria (Backend, machine-parseable)

> The frontend plan owns the Mermaid + architecture-map.md criteria; this
> section covers backend behaviours verifiable via CLI + DB inspection
> (most are not browser-driven, so are flagged for `/ux-lock verify` only
> where applicable). Format matches the plan-frontend Section 9 spec.

- [P0] [other] Migration `20260501120000_symbol_index.sql` applies cleanly to a fresh Supabase project
  - Setup: `supabase db reset` on a dev project
  - Assert: `psql -c "\dt symbol_index"` returns the table; `\dT vector` returns the extension
- [P0] [other] `getNeighbourhood` returns empty + `cloud: false` when Supabase env unset
  - Setup: `unset SUPABASE_AUDIT_URL SUPABASE_AUDIT_ANON_KEY`
  - Assert: `node scripts/cross-skill.mjs get-neighbourhood --json '{"targetPaths":["x.mjs"],"intentDescription":"y"}'` exits 0 with `{"ok":true,"cloud":false,"records":[]}`
- [P0] [other] `npm test` passes including `tests/symbol-index.test.mjs`
  - Setup: clean checkout, `npm ci`
  - Assert: `npm test` exit code 0; `symbol-index.test.mjs` reports >0 passing tests
- [P0] [other] `npm run arch:refresh` is idempotent on unchanged repo (cache-hit path)
  - Setup: run `npm run arch:refresh` twice in a row on the same commit
  - Assert: second run reports `0 LLM calls, 0 embedding calls` in stderr summary
- [P0] [other] Skill consultation step emits a hint when Supabase is off
  - Setup: invoke `/plan-backend` against this repo with Supabase env unset
  - Assert: planning output contains the literal hint string `npm run arch:refresh`
- [P1] [other] Drift sweep workflow opens a sticky issue when threshold crossed
  - Setup: seed `symbol_index` with 5 known duplication pairs (cosine > 0.85, same kind, different file); set `ARCH_DRIFT_SCORE_THRESHOLD=0`; trigger workflow via `workflow_dispatch`
  - Assert: GitHub API shows one open issue labelled `architectural-drift` containing the marker `<!-- audit-loop:architectural-drift -->`
- [P1] [other] Drift sweep workflow auto-closes when score returns to green
  - Setup: with sticky issue from prior step open, delete the duplication-pair rows; trigger workflow
  - Assert: same issue is now closed; closure comment contains "returned to green"
- [P1] [other] Incremental refresh respects `last_seen_commit`
  - Setup: full refresh; modify one file; run `npm run arch:refresh --since-commit <prior-commit>`
  - Assert: only symbols from the modified file have `updated_at` greater than the prior commit's refresh timestamp
- [P1] [other] Audit-code `--scope=full` includes symbol catalogue in prompt
  - Setup: invoke `npm run audit:code -- --scope=full --plan docs/plans/architectural-memory.md`
  - Assert: audit transcript contains a `Symbol catalogue` section with at least one entry
- [P2] [other] Stack-detection short-circuit when not JS/TS
  - Setup: run `npm run arch:refresh` on a Python-only fixture repo
  - Assert: stderr contains `architectural-memory: Python extraction not yet supported`; exit code 0; no DB writes

---

## Cross-references

- Companion: `docs/plans/architectural-memory-frontend.md` (Mermaid + rendered Markdown).
- Merged: `docs/plans/architectural-memory.md` (audit target).
- Predecessor pattern: `scripts/memory-health.mjs` + `.github/workflows/memory-health.yml`.
- Existing data loop: `supabase/migrations/20260419120000_cross_skill_data_loop.sql`.
