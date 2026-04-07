# Claude Engineering Skills

A bundle of **4 AI-pair-programming skills** for planning, auditing, and shipping code. Works with Claude Code, VS Code Copilot, Cursor, Windsurf, and any terminal.

Includes a **multi-model audit loop** -- Claude plans/codes, GPT-5.4 audits, Gemini 3.1 Pro does independent final review -- with adaptive learning that improves both auditor and reviewer prompts over time.

> Renamed from `claude-audit-loop`. GitHub auto-redirects old URLs.

## Skills

| Skill | Purpose | Invoke |
|-------|---------|--------|
| **[audit-loop](skills/audit-loop/SKILL.md)** | Self-driving plan-audit-fix loop with 3 models + adaptive learning | `/audit-loop code docs/plans/X.md` |
| **[plan-backend](skills/plan-backend/SKILL.md)** | Backend architecture planning with 20 engineering principles | `/plan-backend` |
| **[plan-frontend](skills/plan-frontend/SKILL.md)** | Frontend UX + implementation planning with Gestalt principles | `/plan-frontend` |
| **[ship](skills/ship/SKILL.md)** | Pre-push quality gate: test, lint, format, commit, push | `/ship` |

All skills support **JavaScript/TypeScript** and **Python** (FastAPI, Django, Flask) with automatic stack detection.

## Quick Start

```bash
# 1. Clone this repo (once)
git clone https://github.com/Lbstrydom/claude-engineering-skills.git
cd claude-engineering-skills

# 2. Run the setup wizard
node setup.mjs

# 3. Done — skills are available in every repo you open in VS Code
#    Run `git pull` in this repo anytime to get updates (auto-installs via hook)
```

The setup wizard configures API keys, selects your learning database (none / SQLite / Supabase / Postgres), installs skills globally, and sets up a git hook for auto-updates.

### Install skills into a specific repo

For Copilot/Cursor/Agents support in a specific repo (not just Claude Code):

```bash
node scripts/install-skills.mjs --local --target /path/to/your/repo --force
```

This copies SKILL.md files, installs npm dependencies, and sets up `.gitignore` patterns.

## Three-Model Audit Architecture

```
Claude/Copilot (plans + implements)
    |
    v
GPT-5.4 (5 parallel audit passes: structure, wiring, backend, frontend, sustainability)
    |
    v (deliberation: accept / challenge / compromise)
Gemini 3.1 Pro (independent final review: bias, consensus, missed issues)
    |
    v
Adaptive Learning (bandit arms, FP tracker, meta-assessment, prompt evolution)
```

### What the audit loop does

1. **GPT-5.4 audits** your code in 5 focused passes (structure, wiring, backend, frontend, sustainability)
2. **Claude triages** each finding -- accept, challenge, or defer
3. **GPT deliberates** on challenges -- sustain, overrule, or compromise
4. **Fixes are applied**, then R2+ re-audits with suppression of already-resolved findings
5. **Gemini 3.1 Pro** provides an independent final review (catches blind spots in the GPT-Claude loop)
6. **Debt review** triggers automatically when deferred findings reach critical mass
7. **Meta-assessment** periodically evaluates audit-loop quality and recommends prompt improvements

### CLI entry point

```bash
# Full orchestrated loop (all steps)
node scripts/audit-loop.mjs code docs/plans/my-feature.md

# Or via npm
npm run audit -- code docs/plans/my-feature.md

# Individual scripts
node scripts/openai-audit.mjs code docs/plans/X.md     # GPT audit only
node scripts/gemini-review.mjs review <plan> <transcript>  # Gemini review only
node scripts/meta-assess.mjs --force                    # Meta-assessment
node scripts/check-deps.mjs                             # Dependency check
```

### Scope control

```bash
# Default: audit only git-changed files (recommended)
node scripts/openai-audit.mjs code <plan> --scope diff

# Exclude vendored/upstream files
node scripts/openai-audit.mjs code <plan> --exclude-paths 'scripts/**,vendor/**'

# Or use a .auditignore file (one glob per line)
echo 'scripts/**' > .auditignore
```

## Learning System

The audit loop gets smarter over time:

| Component | What it does |
|-----------|-------------|
| **Thompson Sampling** | Selects the best-performing prompt variant per pass (bandit arms) |
| **FP Tracker** | Tracks recurring false positives with exponential decay; auto-suppresses patterns with <15% acceptance |
| **Meta-Assessment** | Every ~4 runs, evaluates FP rate, severity calibration, convergence speed; recommends prompt changes |
| **Prompt Evolution** | Creates experimental prompt variants, tests them via bandit, promotes winners |
| **Debt Review** | Clusters deferred findings by file/principle/recurrence; ranks refactor candidates by leverage |

Learning applies to **both GPT audit passes and Gemini final review**.

## Supported Platforms

| Platform | Skill Location | How to Invoke |
|----------|---------------|---------------|
| **Claude Code** (CLI, VS Code, Desktop) | `~/.claude/skills/<name>/` (global) | `/<skill-name>` |
| **VS Code Copilot** | `.github/skills/<name>/` (per-repo) | `/<skill-name>` in Copilot Chat |
| **Cursor** | `.github/skills/` or `.cursor/rules/` | `/<skill-name>` or terminal |
| **Windsurf** | `.github/skills/` | `/<skill-name>` or terminal |
| **Any terminal** | N/A | `node scripts/audit-loop.mjs` |

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `OPENAI_API_KEY` | **Yes** | -- | GPT-5.4 auditing |
| `GEMINI_API_KEY` | No | -- | Gemini final review + Flash context briefs |
| `ANTHROPIC_API_KEY` | No | -- | Claude Opus fallback + Haiku context briefs |
| `AUDIT_STORE` | No | `noop` | Storage adapter: `noop`, `sqlite`, `supabase`, `postgres` |
| `SUPABASE_AUDIT_URL` | No | -- | Cloud learning store URL (when AUDIT_STORE=supabase) |
| `SUPABASE_AUDIT_ANON_KEY` | No | -- | Cloud learning store key |
| `AUDIT_POSTGRES_URL` | No | -- | Postgres connection (when AUDIT_STORE=postgres) |
| `META_ASSESS_INTERVAL` | No | `4` | Run meta-assessment every N audits |

## Storage Adapters

| Adapter | Config | Use case |
|---------|--------|----------|
| `noop` (default) | No config needed | Local JSON files only, zero cloud |
| `sqlite` | `AUDIT_STORE=sqlite` | Local cross-repo persistence |
| `supabase` | `SUPABASE_AUDIT_URL` + key | Existing Supabase users |
| `postgres` | `AUDIT_POSTGRES_URL` | Generic cloud Postgres |
| `github` | `AUDIT_GITHUB_TOKEN` + owner/repo | GitHub-only infra |

## Python Support

Each planning skill auto-detects your repo's stack:

- **JS/TS**: `package.json` present
- **Python**: `pyproject.toml`, `requirements.txt`, `Pipfile`, `setup.py`, or `uv.lock` present
- **Mixed**: both present -- routes to the profile matching the task's cited files

Python framework detection: **FastAPI**, **Django**, **Flask** (falls back to generic Python principles).

## Security

- `.env` files are gitignored; API keys are never logged
- Sensitive file patterns excluded from external API calls
- All subprocess calls use `execFileSync` (no shell string interpolation)
- Installer verifies SHA checksums against manifest before writing files

See [SECURITY.md](SECURITY.md) for vulnerability reporting and verification instructions.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and PR guidelines.

## License

MIT -- see [LICENSE](LICENSE)
