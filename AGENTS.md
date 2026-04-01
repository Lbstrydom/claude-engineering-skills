# CLAUDE.md - Audit Loop Project Guidelines

## Project Overview

**Purpose**: Multi-model audit loop — Claude plans/codes, GPT-5.4 audits, Gemini 3.1 Pro does independent final review (Claude Opus fallback).
**Runtime**: Node.js (ESM modules, `"type": "module"`)
**Deployment**: CLI scripts, invoked by AI coding assistants via skills

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
│   ├── file-io.mjs         # File read/write, paths, plan path extraction (incl. fuzzy discovery)
│   ├── ledger.mjs          # Adjudication ledger, R2+ suppression, finding metadata
│   ├── code-analysis.mjs   # Chunking, dependency graphs, audit units, map-reduce
│   ├── context.mjs         # Repo profiling, audit brief generation, CLAUDE.md parsing
│   ├── findings.mjs        # Semantic IDs, FP tracker, outcome logging, formatting
│   └── config.mjs          # Centralized validated config (all env var reads)
├── shared.mjs              # Barrel re-export — backwards-compatible, imports from lib/
├── openai-audit.mjs        # GPT-5.4 multi-pass auditor (plan, code, rebuttal modes)
├── gemini-review.mjs       # Gemini 3.1 Pro independent final reviewer (Claude Opus fallback)
├── bandit.mjs              # Thompson Sampling for prompt variant selection
├── learning-store.mjs      # Supabase cloud persistence for audit outcomes + learning
├── refine-prompts.mjs      # LLM-driven prompt refinement from outcome data
└── phase7-check.mjs        # Pre-flight check for Step 7 readiness

tests/                      # Node.js built-in test runner (node --test)
├── shared.test.mjs         # 33 tests: schemas, atomic writes, ledger, FP tracker
└── bandit.test.mjs         # 14 tests: Thompson Sampling, reward computation

.claude/skills/audit-loop/SKILL.md   # Claude Code skill definition
.github/skills/audit-loop/SKILL.md   # VS Code / Copilot skill definition (identical)
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
- **Targeted context**: `readProjectContextForPass()` sends only relevant CLAUDE.md sections per pass (~1500 chars vs 8000)
- **Sensitive file filtering**: `.env`, credentials, keys are never sent to external APIs
- **Atomic persistence**: `atomicWriteFileSync()` — temp file + rename for crash-safe writes (ledger, bandit, FP tracker)
- **Fuzzy file discovery**: When plan paths don't match exact filenames, Phase 2 extracts PascalCase/backtick identifiers and matches against repo files
- **Schema validation at boundaries**: `callGemini()` throws on validation failure, `writeLedgerEntry()` validates entries before write
- **Thompson Sampling**: `PromptBandit` — Beta posterior updates from deliberation outcomes, synced to Supabase
- **Closed Gemini loop**: Step 7.1 — Claude deliberates on Gemini findings, fixes, then Gemini re-verifies (not GPT)

### Testing

Run: `npm test` (uses Node.js built-in test runner, 47 tests)
Covers: atomic writes, schema derivation, ledger operations, finding identity, FP tracker, bandit posterior, reward computation.

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `OPENAI_API_KEY` | Yes | — | GPT-5.4 access |
| `GEMINI_API_KEY` | No | — | Gemini final review (Step 7 falls back to Claude Opus if absent) |
| `OPENAI_AUDIT_MODEL` | No | `gpt-5.4` | Override GPT model |
| `OPENAI_AUDIT_REASONING` | No | `high` | Reasoning effort |
| `GEMINI_REVIEW_MODEL` | No | `gemini-3.1-pro-preview` | Override Gemini model |
| `GEMINI_REVIEW_TIMEOUT_MS` | No | `120000` | Gemini timeout |
| `ANTHROPIC_API_KEY` | No | — | Claude Haiku fallback for brief generation |
| `CLAUDE_FINAL_REVIEW_MODEL` | No | `claude-opus-4-1` | Override Claude Opus model for Step 7 fallback |
| `BRIEF_MODEL_GEMINI` | No | `gemini-2.5-flash` | Override brief generation Gemini model |
| `BRIEF_MODEL_CLAUDE` | No | `claude-haiku-4-5-20251001` | Override brief generation Claude model |
| `SUPPRESS_SIMILARITY_THRESHOLD` | No | `0.35` | Jaccard threshold for R2+ suppression (0.0-1.0) |
| `SUPABASE_AUDIT_URL` | No | — | Supabase project URL for cloud learning store |
| `SUPABASE_AUDIT_ANON_KEY` | No | — | Supabase anon key (falls back to local-only mode) |

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
