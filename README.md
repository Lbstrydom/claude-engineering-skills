# Claude Audit Loop

A self-driving **plan → audit → deliberate → fix → re-audit** loop that uses **Claude** (Opus/Sonnet) for planning and fixing, and **GPT-5.4** as an independent auditor. The two models operate as **peers** — Claude can challenge GPT findings, and GPT can sustain, overrule, or compromise.

Works with any codebase. No hardcoded paths or project-specific config — the script adapts to your project size automatically.

## How It Works

```
┌──────────────────────────────────────────────────────────┐
│  Claude creates/updates plan or code                      │
└──────────┬───────────────────────────────────────────────┘
           ▼
┌──────────────────────────────────────────────────────────┐
│  GPT-5.4 audits independently (multi-pass, parallel)      │
│                                                            │
│  Wave 1: Structure + Wiring    (reasoning: low)  ~25s     │
│  Wave 2: Backend + Frontend    (reasoning: high) ~90-170s │
│  Wave 3: Sustainability        (reasoning: medium) ~90s   │
└──────────┬───────────────────────────────────────────────┘
           ▼
┌──────────────────────────────────────────────────────────┐
│  Claude deliberates on each finding:                      │
│    ✅ ACCEPT — fix as recommended                         │
│    🔄 PARTIAL ACCEPT — problem real, but better fix       │
│    ❌ CHALLENGE — finding is wrong (cites evidence)       │
└──────────┬───────────────────────────────────────────────┘
           ▼ (challenged findings only)
┌──────────────────────────────────────────────────────────┐
│  GPT-5.4 deliberation round:                              │
│    🔴 SUSTAIN — GPT holds, Claude must fix                │
│    🟢 OVERRULE — Claude was right, finding dismissed      │
│    🟡 COMPROMISE — modified recommendation                │
└──────────┬───────────────────────────────────────────────┘
           ▼
┌──────────────────────────────────────────────────────────┐
│  Claude fixes surviving findings                          │
│  Loop back to audit (max 4 rounds)                        │
│                                                            │
│  Converges when:                                          │
│    • 0 HIGH findings                                      │
│    • ≤ 2 MEDIUM findings                                  │
│    • 0 quick-fix warnings                                 │
└──────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Install in your project

```bash
# Copy into your project
cp -r scripts/openai-audit.mjs <your-project>/scripts/
cp -r .claude/skills/audit-loop <your-project>/.claude/skills/

# Install dependencies (if not already present)
cd <your-project>
npm install openai zod dotenv
```

Or install as a standalone tool:

```bash
git clone https://github.com/Lbstrydom/claude-audit-loop.git
cd claude-audit-loop
npm install
```

### 2. Set your API key

```bash
cp .env.example .env
# Edit .env and add your OpenAI API key
```

### 3. Use with Claude Code

The `/audit-loop` skill is available in Claude Code (CLI and VS Code):

```bash
# Audit an existing plan iteratively
/audit-loop plan docs/plans/my-feature.md

# Audit code against a plan iteratively
/audit-loop code docs/plans/my-feature.md

# Full cycle: plan → audit plan → implement → audit code
/audit-loop full add user authentication

# Just plan + audit loop
/audit-loop add a REST API for notifications
```

### 4. Use the script directly (without Claude Code)

```bash
# Audit a plan
node scripts/openai-audit.mjs plan docs/plans/my-feature.md

# Audit code against a plan
node scripts/openai-audit.mjs code docs/plans/my-feature.md

# Get JSON output (for piping to other tools)
node scripts/openai-audit.mjs plan docs/plans/my-feature.md --json

# Send Claude's rebuttals for GPT deliberation
node scripts/openai-audit.mjs rebuttal docs/plans/my-feature.md rebuttal.md --json
```

## What It Checks

### Plan Audits
- **SOLID principles** (all 5), DRY, modularity, no dead code, no hardcoding
- **Sustainability** — will this design accommodate change in 6 months?
- **Specificity** — can a developer implement from this plan without guessing?
- **Gestalt principles** (frontend) — proximity, similarity, continuity, closure
- **State coverage** — loading, error, empty states specified?
- **Data flow** — traceable end-to-end (UI → API → Service → DB)?
- **Vague language** — flags "as needed", "TBD", "handle appropriately"

### Code Audits (5 parallel passes)

| Pass | Focus | Reasoning |
|------|-------|-----------|
| **Structure** | Files exist? Exports match plan? Dependencies correct? | low |
| **Wiring** | Frontend API calls ↔ backend routes match? Auth headers? | low |
| **Backend** | SOLID, DRY, async/await, security, transactions, N+1 | high |
| **Frontend** | Gestalt, CSP, accessibility, state handling, responsive | high |
| **Sustainability** | Quick fixes, dead code, coupling, extension points | medium |

### Quick-Fix Detection
Every finding includes an `is_quick_fix` flag. Band-aid solutions are automatically flagged and rejected — both Claude and GPT enforce sustainable fixes only.

## Adaptive Sizing

The script automatically sizes token limits and timeouts based on your codebase:

| Codebase Size | Files | Max Tokens | Timeout |
|--------------|-------|-----------|---------|
| Tiny | 3 | ~4,500 | 60s |
| Small | 8 | ~7,000 | 77s |
| Medium | 15 | ~12,000 | 110s |
| Large | 25+ | ~19,000 | 157s |

No tuning needed. Hard ceilings (32K tokens, 300s) are configurable via env vars.

If a pass has >12 backend files, it auto-splits into routes + services sub-passes.

## Graceful Degradation

If any pass fails (timeout, token limit, API error):
- The pass returns empty findings (no crash)
- Other passes continue normally
- The `_failed_passes` field in JSON output shows what failed
- The `/audit-loop` skill prompts you with recovery options

## Project Structure

```
claude-audit-loop/
├── scripts/
│   └── openai-audit.mjs      # GPT-5.4 multi-pass audit script
├── .claude/
│   └── skills/
│       └── audit-loop/
│           └── SKILL.md       # Claude Code skill (orchestrator)
├── .env.example               # Environment variable template
├── package.json
└── README.md
```

## Adding to an Existing Project

1. **Copy the files**:
   ```bash
   cp scripts/openai-audit.mjs <project>/scripts/
   mkdir -p <project>/.claude/skills/audit-loop
   cp .claude/skills/audit-loop/SKILL.md <project>/.claude/skills/audit-loop/
   ```

2. **Install dependencies** (skip if already present):
   ```bash
   npm install openai zod dotenv
   ```

3. **Add OPENAI_API_KEY** to your `.env`

4. **Done.** Use `/audit-loop` in Claude Code or run the script directly.

The script reads your project's `CLAUDE.md` (if present) for project-specific conventions and patterns. This gives GPT-5.4 context about your coding standards without any manual configuration.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENAI_API_KEY` | (required) | Your OpenAI API key |
| `OPENAI_AUDIT_MODEL` | `gpt-5.4` | GPT model for auditing |
| `OPENAI_AUDIT_REASONING` | `high` | Reasoning effort: low/medium/high/xhigh |
| `OPENAI_AUDIT_MAX_TOKENS` | `32000` | Hard ceiling for output tokens per pass |
| `OPENAI_AUDIT_TIMEOUT_MS` | `300000` | Hard ceiling for timeout per pass (ms) |
| `OPENAI_AUDIT_SPLIT_THRESHOLD` | `12` | Backend file count that triggers splitting |

## Peer Deliberation Model

Unlike traditional linting where the tool's word is final, this system treats Claude and GPT-5.4 as **equals**:

- **Claude has codebase context** — knows your conventions, patterns, and CLAUDE.md
- **GPT-5.4 has fresh eyes** — catches blind spots from familiarity bias
- **Deliberation is final** — once GPT rules on a challenge (sustain/overrule/compromise), that ruling is accepted. No infinite debate.

This produces better outcomes than either model alone because:
1. False positives get caught (Claude challenges findings that misunderstand project conventions)
2. True issues don't get dismissed (GPT sustains valid findings even when Claude pushes back)
3. Solutions improve (compromises combine both models' insights)

## Example Output

```
# GPT-5.4 Multi-Pass Code Audit Report
- **Model**: gpt-5.4
- **Total time**: structure: 22.0s, wiring: 23.3s, be-routes: 173.1s, frontend: 103.9s, sustainability: 99.0s, total: 302.3s
- **Tokens**: 79865 in / 26128 out (18554 reasoning)
- **Files**: 26 found, 6 missing

## Verdict: **SIGNIFICANT_ISSUES**
- **HIGH**: 15 | **MEDIUM**: 15 | **LOW**: 3

## Findings

### HIGH Severity

#### [H1] [Structure] Missing Planned File: public/js/api/pairingLab.js
- **Detail**: The planned frontend API module is missing...
- **Recommendation**: Create the module following existing api/ patterns...
```

## License

MIT
