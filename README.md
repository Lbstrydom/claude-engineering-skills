# Claude Audit Loop — Adaptive Audit Intelligence

A self-driving **plan → audit → deliberate → fix → re-audit** loop with **adaptive learning**. Uses three AI models as peers: your coding assistant (Claude/Copilot), **GPT-5.4** as independent auditor, and **Gemini 3.1 Pro** as final arbiter.

Works with **any codebase, any AI assistant, any IDE**. The system learns from every audit run — improving prompt quality, suppressing false positives, and adapting to your codebase over time.

## Supported Platforms

| Platform | Skill Location | How to Invoke |
|----------|---------------|---------------|
| **Claude Code** (CLI, VS Code, Desktop) | `.claude/skills/audit-loop/` | `/audit-loop plan docs/plans/X.md` |
| **VS Code Copilot** | `.github/skills/audit-loop/` | `/audit-loop` in Copilot Chat |
| **Cursor** | `.github/skills/` or `.cursor/rules/` | `/audit-loop` or terminal |
| **Windsurf** | `.github/skills/` | `/audit-loop` or terminal |
| **JetBrains** | `.github/skills/` | Terminal |
| **Any terminal** | N/A | `node scripts/openai-audit.mjs` |

## Quick Start

```bash
git clone https://github.com/Lbstrydom/claude-audit-loop.git
cd claude-audit-loop
node setup.mjs --target /path/to/your/project
```

The setup script:
1. Checks Node.js 18+
2. Installs all dependencies (`openai`, `zod`, `dotenv`, `@google/genai`, `@anthropic-ai/sdk`, `@supabase/supabase-js`)
3. Copies all 7 scripts to your project
4. Installs skills for Claude Code, VS Code Copilot, Cursor, Windsurf, JetBrains
5. Sets up `.env` with API keys (OpenAI required, Gemini + Anthropic + Supabase optional)

## Three-Model Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Claude/Copilot (your assistant)                         │
│  Plans code, implements fixes, deliberates on findings   │
└──────────┬──────────────────────────────────────────────┘
           ▼
┌─────────────────────────────────────────────────────────┐
│  GPT-5.4 (independent auditor)                           │
│  Multi-pass parallel audit: structure, wiring, backend,  │
│  frontend, sustainability — with adaptive learning       │
└──────────┬──────────────────────────────────────────────┘
           ▼ (deliberation: accept/challenge/compromise)
┌─────────────────────────────────────────────────────────┐
│  Gemini 3.1 Pro (final arbiter)                          │
│  Independent review: bias detection, false consensus,    │
│  missed issues, over-engineering flags                    │
└─────────────────────────────────────────────────────────┘
```

## Features

### Core Audit Loop
- **5 parallel audit passes**: structure, wiring, backend, frontend, sustainability
- **Peer deliberation**: accept / challenge / compromise — neither model blindly defers
- **Convergence**: 0 HIGH, ≤2 MEDIUM, 0 quick-fix warnings → stable for 2 rounds

### Adaptive Intelligence (Phases 1-7)

| Phase | Feature | Status |
|-------|---------|--------|
| **1** | R2+ Efficiency — adjudication ledger, composable prompts, post-output suppression | ✅ Implemented |
| **1.5** | Map-Reduce — full codebase coverage for 200+ file repos, no truncation | ✅ Implemented |
| **2** | Repo-Aware Tuning — auto-detect stack, skip irrelevant passes, inject focus areas | ✅ Implemented |
| **3** | Cloud Learning Store — Supabase, cross-IDE persistence, outcome logging | ✅ Implemented |
| **4** | Effectiveness Tracking — signal-to-noise scoring, EMA false positive learning | ✅ Implemented |
| **5** | TextGrad-lite — LLM-generated prompt refinements, human-approved | ✅ Implemented |
| **6** | Thompson Sampling — bandit prompt variant selection, RLHF-lite rewards | ✅ Implemented |
| **7** | Predictive Strategy — ML-based pass/effort selection | 📊 Collecting data (50 runs needed) |

### Platform Agnostic
- Auto-detects project context from `CLAUDE.md`, `Agents.md`, or `.github/copilot-instructions.md`
- Context brief generator condenses any instruction file into audit-relevant facts (Haiku → Flash → regex)

## Usage

### With AI Assistant (Claude Code / Copilot)

```bash
/audit-loop plan docs/plans/my-feature.md     # Audit plan quality
/audit-loop code docs/plans/my-feature.md     # Audit code against plan
/audit-loop full add user authentication      # Plan → audit → implement → audit code
```

### Direct CLI

```bash
# Round 1 — full audit
node scripts/openai-audit.mjs code docs/plans/X.md --out result.json

# Round 2+ — R2+ mode with ledger + diff
node scripts/openai-audit.mjs code docs/plans/X.md \
  --round 2 --ledger ledger.json --diff changes.patch \
  --changed src/routes/wines.js --passes backend,sustainability

# Gemini final review
node scripts/gemini-review.mjs review docs/plans/X.md transcript.json

# Learning tools
node scripts/bandit.mjs stats                    # Prompt variant performance
node scripts/refine-prompts.mjs backend --suggest # LLM prompt suggestions
node scripts/phase7-check.mjs                     # Phase 7 readiness counter
```

### CLI Flags

| Flag | Purpose |
|------|---------|
| `--round <n>` | R2+ mode: rulings injection, suppression, diff annotations |
| `--ledger <file>` | Adjudication ledger for R2+ suppression |
| `--diff <file>` | Unified diff for line-level change annotations |
| `--changed <list>` | Files modified this round (authoritative for reopen detection) |
| `--files <list>` | All files for audit context (changed + dependents) |
| `--passes <list>` | Which passes to run |
| `--out <file>` | Write JSON to file, summary to stdout |

## Project Structure

```
claude-audit-loop/
├── scripts/
│   ├── openai-audit.mjs        # GPT-5.4 multi-pass auditor (R1 + R2+ modes)
│   ├── shared.mjs              # Shared utilities, schemas, ledger, suppression
│   ├── gemini-review.mjs       # Gemini 3.1 Pro independent reviewer
│   ├── bandit.mjs              # Thompson Sampling prompt selection
│   ├── refine-prompts.mjs      # TextGrad-lite prompt refinement CLI
│   ├── learning-store.mjs      # Supabase cloud learning store
│   └── phase7-check.mjs        # Phase 7 readiness counter
├── .claude/skills/audit-loop/  # Claude Code skill
├── .github/skills/audit-loop/  # VS Code Copilot / Cursor / Windsurf skill
├── supabase/migrations/        # Learning store schema
├── setup.mjs                   # Cross-platform installer
├── CLAUDE.md                   # Project context for auditors
├── docs/plans/                 # Feature plans (audited)
└── .env.example                # Environment variable template
```

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `OPENAI_API_KEY` | **Yes** | — | GPT-5.4 auditing |
| `GEMINI_API_KEY` | No | — | Gemini final review + Flash context briefs |
| `ANTHROPIC_API_KEY` | No | — | Haiku context briefs (best quality) |
| `SUPABASE_AUDIT_URL` | No | — | Cloud learning store URL |
| `SUPABASE_AUDIT_ANON_KEY` | No | — | Cloud learning store key |
| `SUPPRESS_SIMILARITY_THRESHOLD` | No | `0.35` | Jaccard threshold for R2+ suppression |

## Cost Estimates

| Codebase | Files | Round 1 | Round 2+ (R2+ mode) | Full audit (4 rounds) |
|----------|-------|---------|---------------------|----------------------|
| Tiny | 3 | ~$0.15 | ~$0.04 | ~$0.30 |
| Small | 8 | ~$0.35 | ~$0.10 | ~$0.65 |
| Medium | 15 | ~$0.65 | ~$0.15 | ~$1.10 |
| Large | 50+ | ~$1.50 | ~$0.30 | ~$2.40 |

R2+ mode saves ~78% per round via rulings injection + post-output suppression.
Gemini final review: ~$0.30 per audit (one-time at convergence).

## Security

- **Sensitive file exclusion**: `.env`, `.pem`, `.key`, `secret`, `credential`, `token` patterns never sent to APIs
- **Path traversal guard**: Only files within cwd are read
- **No key logging**: API keys never printed
- **RLS on cloud store**: Each user only sees their own audit data

## License

MIT
