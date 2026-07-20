# Audit-loop internals — script responsibilities and key patterns

Moved out of `AGENTS.md` (2026-07-20) under its own progressive-disclosure rule:
subsystem-grade detail belongs in `docs/` with a short stub in AGENTS.md, because
AGENTS.md is loaded every session and size is a cost.

Two corrections were applied during the move rather than carried across
verbatim — the section had gone stale in exactly the way its own preamble warns
about, which is part of why it was the one condensed. Both are marked
**[corrected 2026-07-20]**.

> **This file is hand-maintained prose about a handful of load-bearing modules.
> It is NOT a module tree.** For "where does symbol X live", use the generated
> per-symbol index [`docs/architecture-map.md`](../architecture-map.md), which
> cannot go stale silently.

## Script responsibilities

- **`lib/*.mjs`** — focused modules. Import directly from `./lib/<module>.mjs`
  for explicit deps, or from the `./shared.mjs` barrel for convenience. Schemas
  (`lib/schemas.mjs`) are the single source of truth (JSON Schemas derived via
  `zodToGeminiSchema()`).

- **`openai-audit.mjs`** — 5-pass parallel code audit (structure, wiring,
  backend, frontend, sustainability). Plan audit. Rebuttal deliberation. Uses
  GPT with `responses.parse()` + Zod schemas. Integrates bandit reward updates
  and cloud sync.

- **`gemini-review.mjs`** — independent final review (**MANDATORY — not gated by
  convergence**). Receives the full audit transcript; detects bias, false
  consensus, missed issues. Default Gemini 3.1 Pro (16K thinking budget), and
  **provider-agnostic** via one abort-correct `callReviewer` seam plus a
  `PROVIDERS` descriptor catalog — gemini / claude-opus / azure-claude (both
  shapes) / `openai-compatible` / `openrouter`. Recipe:
  [`azure-work-profile.md`](../runbooks/azure-work-profile.md)
  §Provider-agnostic final review. Background-safe: guaranteed process
  termination (idempotent `finishAndExit` + hard-deadline watchdog), so a
  detached run cannot hang on a lingering SDK socket. Claude deliberates on
  CONCERNS, then the reviewer re-verifies.

- **`learning-store.mjs`** — **[corrected 2026-07-20]** a thin *barrel* over the
  domain modules in `scripts/lib/store/`, not a store itself. Postgres-parity M3
  split the former 2,832-line god module into **9 focused domain modules** and
  rewrote every PostgREST call as raw SQL through the `db/` seam; M4 removed
  `@supabase/supabase-js` entirely. The 93 frozen public-contract functions keep
  identical signatures and return shapes, so callers did not notice. `getReadClient`
  / `getWriteClient` / `getPersonaSupabase` are **no longer exported** — the pool
  is an implementation detail of `lib/db/client.mjs`. Graceful degradation (#16)
  is preserved: every function returns a neutral value when cloud mode is off.
  Detail: [`postgres-parity.md`](../plans/postgres-parity.md) §2, §7 P3.

## Key patterns

- **Adaptive sizing** — `computePassLimits()` scales token limits and timeouts to
  context size.
- **Graceful degradation** — `safeCallGPT()` catches failures and returns empty
  results instead of crashing.
- **Semantic dedup** — content-hash IDs (`semanticId()`) give exact cross-round
  and cross-model finding matching.
- **Targeted context** — `readProjectContextForPass()` sends only the relevant
  AGENTS.md sections per pass (~1500 chars vs 8000).
- **Sensitive file filtering** — `.env`, credentials and keys never reach an
  external API.
- **Atomic persistence** — `atomicWriteFileSync()`: temp file + rename, for
  crash-safe writes (ledger, bandit, FP tracker).
- **Fuzzy file discovery** — when plan paths do not match exact filenames, Phase
  2 extracts PascalCase/backtick identifiers and matches them against repo files.
- **Schema validation at boundaries** — `callGemini()` throws on validation
  failure; `writeLedgerEntry()` validates entries before write.
- **Thompson sampling** — `PromptBandit`: Beta posterior updates from
  deliberation outcomes, **[corrected 2026-07-20]** persisted through the `db/`
  seam (previously described as "synced to Supabase").
- **Closed Gemini loop** — Step 7.1: Claude deliberates on Gemini findings, fixes,
  then **Gemini** re-verifies (not GPT).
