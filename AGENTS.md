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
├── shared.mjs          # Shared utilities (file reading, context extraction, finding dedup)
├── openai-audit.mjs    # GPT-5.4 multi-pass auditor (plan, code, rebuttal modes)
└── gemini-review.mjs   # Gemini 3.1 Pro independent final reviewer

.claude/skills/audit-loop/SKILL.md   # Claude Code skill definition
.github/skills/audit-loop/SKILL.md   # VS Code / Copilot skill definition (identical)
```

### Script Responsibilities

- **shared.mjs**: File I/O, CLAUDE.md context extraction, plan path discovery, sensitive file filtering, semantic finding IDs (content-hash), output formatting. Imported by both other scripts.
- **openai-audit.mjs**: 5-pass parallel code audit (structure, wiring, backend, frontend, sustainability). Plan audit. Rebuttal deliberation. Uses GPT-5.4 with `responses.parse()` + Zod schemas.
- **gemini-review.mjs**: Single-call final review after Claude-GPT convergence. Receives full audit transcript. Detects bias, false consensus, missed issues. Uses Gemini 3.1 Pro first, with Claude Opus fallback.

### Key Patterns

- **Adaptive sizing**: `computePassLimits()` scales token limits and timeouts based on context size
- **Graceful degradation**: `safeCallGPT()` catches failures and returns empty results instead of crashing
- **Semantic dedup**: Content-hash IDs (`semanticId()`) enable exact cross-round and cross-model finding matching
- **Targeted context**: `readProjectContextForPass()` sends only relevant CLAUDE.md sections per pass (~1500 chars vs 8000)
- **Sensitive file filtering**: `.env`, credentials, keys are never sent to external APIs

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `OPENAI_API_KEY` | Yes | — | GPT-5.4 access |
| `GEMINI_API_KEY` | No | — | Gemini final review (Step 6.5 falls back to Claude Opus if absent) |
| `OPENAI_AUDIT_MODEL` | No | `gpt-5.4` | Override GPT model |
| `OPENAI_AUDIT_REASONING` | No | `high` | Reasoning effort |
| `GEMINI_REVIEW_MODEL` | No | `gemini-3.1-pro-preview` | Override Gemini model |
| `GEMINI_REVIEW_TIMEOUT_MS` | No | `120000` | Gemini timeout |
| `ANTHROPIC_API_KEY` | No | — | Claude Haiku fallback for brief generation |
| `CLAUDE_FINAL_REVIEW_MODEL` | No | `claude-opus-4-1` | Override Claude Opus model for Step 6.5 fallback |
| `BRIEF_MODEL_GEMINI` | No | `gemini-2.5-flash` | Override brief generation Gemini model |
| `BRIEF_MODEL_CLAUDE` | No | `claude-haiku-4-5-20251001` | Override brief generation Claude model |
| `SUPPRESS_SIMILARITY_THRESHOLD` | No | `0.35` | Jaccard threshold for R2+ suppression (0.0-1.0) |

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
