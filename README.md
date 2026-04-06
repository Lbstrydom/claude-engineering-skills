# Claude Engineering Skills

A bundle of **5 AI-pair-programming skills** for planning, auditing, and shipping code. Works with Claude Code, VS Code Copilot, Cursor, Windsurf, and any terminal.

Includes a **multi-model audit loop** — Claude plans/codes, GPT-5.4 audits, Gemini 3.1 Pro does independent final review — with adaptive learning that improves over time.

> Renamed from `claude-audit-loop`. GitHub auto-redirects old URLs.

## Skills

| Skill | Purpose | Invoke |
|-------|---------|--------|
| **[audit-loop](skills/audit-loop/SKILL.md)** | Self-driving plan-audit-fix loop with 3 models + adaptive learning | `/audit-loop plan docs/plans/X.md` |
| **[plan-backend](skills/plan-backend/SKILL.md)** | Backend architecture planning with 20 engineering principles | `/plan-backend` |
| **[plan-frontend](skills/plan-frontend/SKILL.md)** | Frontend UX + implementation planning with Gestalt principles | `/plan-frontend` |
| **[ship](skills/ship/SKILL.md)** | Pre-push quality gate: test, lint, format, commit, push | `/ship` |
| **[audit](skills/audit/SKILL.md)** | Single-pass plan audit against engineering principles | `/audit` |

All 5 skills support **JavaScript/TypeScript** and **Python** (FastAPI, Django, Flask) with automatic stack detection.

## Quick Start

```bash
git clone https://github.com/Lbstrydom/claude-engineering-skills.git
cd claude-engineering-skills
node setup.mjs --target /path/to/your/project
```

Or install manually — copy the skill files you need:

```bash
# Claude Code
cp skills/<skill-name>/SKILL.md /path/to/project/.claude/skills/<skill-name>/SKILL.md

# VS Code Copilot / Cursor / Windsurf
cp skills/<skill-name>/SKILL.md /path/to/project/.github/skills/<skill-name>/SKILL.md
```

## Python Support

Each planning skill auto-detects your repo's stack:

- **JS/TS**: `package.json` present
- **Python**: `pyproject.toml`, `requirements.txt`, `Pipfile`, `setup.py`, or `uv.lock` present
- **Mixed**: both present — routes to the profile matching the task's cited files

Python framework detection: **FastAPI**, **Django**, **Flask** (falls back to generic Python principles).

## Three-Model Audit Architecture

```
Claude/Copilot (plans + implements)
    |
    v
GPT-5.4 (5 parallel audit passes: structure, wiring, backend, frontend, sustainability)
    |
    v (deliberation: accept / challenge / compromise)
Gemini 3.1 Pro (independent final review: bias, consensus, missed issues)
```

## Supported Platforms

| Platform | Skill Location | How to Invoke |
|----------|---------------|---------------|
| **Claude Code** (CLI, VS Code, Desktop) | `.claude/skills/<name>/` | `/<skill-name>` |
| **VS Code Copilot** | `.github/skills/<name>/` | `/<skill-name>` in Copilot Chat |
| **Cursor** | `.github/skills/` or `.cursor/rules/` | `/<skill-name>` or terminal |
| **Windsurf** | `.github/skills/` | `/<skill-name>` or terminal |
| **Any terminal** | N/A | `node scripts/openai-audit.mjs` |

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `OPENAI_API_KEY` | **Yes** | -- | GPT-5.4 auditing |
| `GEMINI_API_KEY` | No | -- | Gemini final review + Flash context briefs |
| `ANTHROPIC_API_KEY` | No | -- | Claude Opus fallback + Haiku context briefs |
| `SUPABASE_AUDIT_URL` | No | -- | Cloud learning store URL |
| `SUPABASE_AUDIT_ANON_KEY` | No | -- | Cloud learning store key |

## Roadmap

This repo follows a [multi-phase plan](docs/plans/skill-bundle-mega-plan.md):

- **Phase E** -- Skill consolidation + Python profiles + rename (current)
- **Phase F** -- Installer + update infrastructure
- **Phase G** -- Pluggable storage adapters (SQLite, Postgres, GitHub)
- **Phase H** -- Public distribution hardening (signing, releases)
- **Phase I** -- CLAUDE.md hygiene + sprawl control

## License

MIT
