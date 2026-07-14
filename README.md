# Claude Engineering Skills

A bundle of **AI-pair-programming skills** for planning, auditing, testing, and shipping code. Works with Claude Code, VS Code Copilot, Cursor, Windsurf, and any terminal.

Three-model audit loop (Claude plans/codes, GPT audits, Gemini reviews) with adaptive learning, real-user persona testing against live URLs, and an architectural-memory layer that catches duplicate-function drift before code gets written.

## Quick Reference

**Slash commands** (Claude Code / Copilot / Cursor):

> **VS Code Copilot users**: skills load through TWO native mechanisms — the
> committed `.claude/skills/**` directory is auto-discovered by Copilot's
> [Agent Skills](https://code.visualstudio.com/docs/agent-customization/agent-skills)
> (the cross-agent open standard; also read by Copilot CLI and the cloud
> agent), and `.github/prompts/*.prompt.md` provides the same commands as
> classic slash-command prompt files. [`AGENTS.md`](AGENTS.md) is picked up
> automatically as always-on project instructions. No configuration needed.

| When you want to… | Command |
|---|---|
| Design a feature (auto-detects backend / frontend / full-stack) | `/plan <task>` |
| Run the whole feature flow on autopilot | `/cycle <task>` |
| Iterate on a plan with GPT + Gemini (max 3 rounds) | `/audit-plan <plan-file>` |
| Audit code against its plan (multi-pass + Gemini final) | `/audit-code <plan-file>` |
| QA a deployed app as a persona (Playwright + P0–P3) | `/persona-test "<persona>" <url>` |
| Lock a fix's behaviour with a Playwright spec | `/ux-lock <commit-or-description>` |
| Pre-push quality gate (test + lint + commit + push) | `/ship` |
| "Why is this code shaped this way?" | `/explain <file:line>` |
| Brainstorm with multiple LLMs (you drive convergence) | `/brainstorm <topic>` (add `--with-gemini`) |
| Sync AGENTS.md / CLAUDE.md across all AI agents | `/ai-context-management audit` |
| Bootstrap or add to per-repo security memory (incident log) | `/security-strategy bootstrap` · `/security-strategy add-incident` |

**Architectural-memory** (terminal):

| Command | What it does |
|---|---|
| `npm run arch:refresh` | Incremental: re-extract changed files, copy-forward the rest |
| `npm run arch:refresh:full` | Full rebuild from scratch |
| `npm run arch:render` | Generate `docs/architecture-map.md` (Mermaid + flat tables) |
| `npm run arch:drift` | Compute drift score for active snapshot |
| `npm run arch:duplicates` | List top cross-file duplicate clusters (refactor targets) |
| `npm run security:refresh` | Re-parse `docs/security-strategy.md` and refresh the security_incidents Supabase index (auto-runs post-push from `/ship`) |

**Requirements layer** (terminal) — a materialized view of the codebase's de-facto invariants, surfaced to `/audit-code` as a rubric:

| Command | What it does |
|---|---|
| `node scripts/requirements.mjs extract --files <a,b,…> [--runs N]` | Extract de-facto requirements from the given files (LLM ×N, merged) → `.requirements/candidates.json` + `gaps.json` |
| `node scripts/requirements.mjs reconcile` | Fold candidates + gap assessments + hand-curated `.requirements/overrides.json` into `.requirements/ledger.json` |
| `node scripts/requirements.mjs index` | Print the active requirements index |
| `node scripts/requirements.mjs render` | Render the ledger as a human-readable map → `docs/requirements-map.md` (Mermaid pie + grouped tables) |

Once `.requirements/ledger.json` exists, `/audit-code` automatically injects in-scope invariants as a rubric. See [`.requirements/README.md`](.requirements/README.md).

**Workflow**:

```
Full cycle (one command):       /cycle <task>     ← runs everything end-to-end

Atomic chain:
  /plan → /audit-plan → (you implement) → /audit-code → /persona-test → /ux-lock → /ship

Side-channels (anytime):
  /brainstorm   — second opinion with OpenAI/Gemini, manual convergence
  /explain      — read-only context synthesis from arch-memory + git
  Arch-memory   — auto-fires on UserPromptSubmit when prompt contains "fix" /
  consult hook    "add" / "implement" etc. — catches drift before it lands
```

---

<!-- arch-map-discoverability:start -->
## Architecture

See [`docs/architecture-map.md`](docs/architecture-map.md) — generated index of every symbol in this repo, grouped by domain, with Mermaid diagrams. Regenerated on `/ship` or via `npm run arch:render`.
<!-- arch-map-discoverability:end -->

## Quick Start

```bash
git clone https://github.com/Lbstrydom/claude-engineering-skills.git
cd claude-engineering-skills
node setup.mjs
```

The wizard configures API keys, installs all skills globally, and sets up a git hook for auto-updates. Re-run `git pull` anytime to get updates.

To install into a specific repo (Copilot/Cursor/Agents support):

```bash
node scripts/install-skills.mjs --local --target /path/to/your/repo --force
```

### API keys

The wizard prompts for these (only `OPENAI_API_KEY` is required to start;
everything else degrades gracefully when absent — see
[`.env.example`](.env.example) for the full annotated list):

| Key | Unlocks |
|---|---|
| `OPENAI_API_KEY` | GPT auditor (required) |
| `GEMINI_API_KEY` | Gemini independent final review (falls back to Claude Opus) |
| `ANTHROPIC_API_KEY` | Claude Opus fallback reviewer, brief generation |
| `OPENROUTER_API_KEY` | OSS models (GLM) — tiered-pipeline discovery/triage, model-eval candidates |
| `AUDIT_DB_URL` | Cloud learning store (Supabase Postgres) — optional, local-only mode works without it |

### Corporate / Azure setup

Running behind **Azure AI Foundry / Azure OpenAI** (restricted-model
enterprise environments): the whole bundle runs on an opt-in Azure profile —
GPT via Azure OpenAI, the final reviewer via Foundry-hosted Claude, Azure
embeddings — activated purely by env vars, with zero drift from the public
setup (no Azure env set → byte-identical public behavior).

```bash
cp defaults/work-profile.env.example .env   # then fill in your endpoints + deployments
```

Full guide: [`docs/azure-work-profile.md`](docs/azure-work-profile.md)
(endpoint/deployment reference, provider precedence, quotas, rollback).

## Skills

All skills support **JS/TS** and **Python** (FastAPI, Django, Flask) with automatic stack detection.

| Skill | Purpose |
|-------|---------|
| **[plan](skills/plan/SKILL.md)** | Unified planner — auto-detects backend/frontend/full-stack scope, lazy-loads the right principle set |
| **[audit-plan](skills/audit-plan/SKILL.md)** | Iteratively audit a plan with GPT + Gemini final gate (max 3 rounds, rigor-pressure stop) |
| **[audit-code](skills/audit-code/SKILL.md)** | Multi-pass code audit, R2+ ledger suppression, debt capture, Gemini final review |
| **[cycle](skills/cycle/SKILL.md)** | End-to-end orchestrator: plan → audit-plan → impl gate → audit-code → persona-test → ux-lock → ship |
| **[explain](skills/explain/SKILL.md)** | Synthesises arch-memory + git history + AGENTS.md principles to answer "why is this here?" |
| **[ux-lock](skills/ux-lock/SKILL.md)** | Generates Playwright e2e specs that lock fixes' public DOM contracts (role, aria, data-testid — not CSS classes); verify-mode grades a plan against live impl |
| **[persona-test](skills/persona-test/SKILL.md)** | Drives a browser as a persona against a live URL → P0–P3 findings + qualitative debrief; results auto-correlate with audit findings |
| **[ship](skills/ship/SKILL.md)** | Pre-push quality gate; warns on open persona-test P0s + missing regression specs |
| **[brainstorm](skills/brainstorm/SKILL.md)** | Concept-level multi-LLM thinking partner; user-driven manual convergence |
| **[ai-context-management](skills/ai-context-management/SKILL.md)** | Keeps AGENTS.md / CLAUDE.md aligned across Claude / Copilot / Cursor / Windsurf |

**Deprecated aliases** (kept for muscle memory): `/plan-backend` and `/plan-frontend` → `/plan` with scope hint; `/audit-loop` → `/cycle` (chained) or atomic `/audit-plan` / `/audit-code`.

**Cross-skill data flow**: every skill writes to a shared Supabase store via `scripts/cross-skill.mjs`. Plans link to audit runs (`plan_id`); ux-lock's Playwright specs link to source findings; persona-test P0/P1s become bandit reward labels; ship logs gate outcomes. See views: `audit_effectiveness`, `unlocked_fixes`, `regression_saves`, `ship_gate_effectiveness`.

### Discovering skills (cheatsheet `/skills`)

Don't memorise every skill — surface them on demand. The `/skills` skill reads SKILL.md frontmatter directly (so the listing can never drift) and renders a compact reference. Five entry points:

| Where you are | How to invoke |
|---|---|
| Claude Code (CLI / VS Code extension) | `/skills`, `/skills <name>`, `/skills --search "<term>"` |
| GitHub Copilot Chat (VS Code, JetBrains) | `/skills` (auto-generated `.github/prompts/skills.prompt.md` shim) |
| Cursor / Windsurf Chat | `/skills` (same prompt-files convention) |
| VS Code Command Palette | `Cmd/Ctrl+Shift+P → Run Task → Skills: List all` (also `Skills: Detail for one skill`, `Skills: Search`, `Skills: Open SKILLS-INDEX.md`) |
| Plain terminal | `npm run skills:help` (or `npm run skills:help -- <name>`, `npm run skills:help -- --search "<term>"`) |
| Just browsing | [`docs/SKILLS-INDEX.md`](docs/SKILLS-INDEX.md) — auto-generated by `npm run skills:index` |

## Three-Model Audit Architecture

```
Claude/Copilot (plans + implements)
    ↓
GPT (5 parallel passes: structure, wiring, backend, frontend, sustainability)
    ↓ deliberation: accept / challenge / compromise
Gemini 3.1 Pro (independent final review: bias, consensus, missed issues)
    ↓
Adaptive learning (bandit arms, FP tracker, meta-assessment, prompt evolution)
```

1. **GPT audits** in 5 focused passes
2. **Claude triages** each finding — accept, challenge, or defer
3. **GPT deliberates** on challenges — sustain, overrule, or compromise
4. **Fixes applied**, then R2+ re-audits with suppression of resolved findings
5. **Gemini 3.1 Pro** independent final review (catches blind spots in the GPT-Claude loop)
6. **Debt review** triggers when deferred findings reach critical mass
7. **Meta-assessment** periodically evaluates audit-loop quality, recommends prompt changes

**CLI entry point** (when not in an AI skill orchestrator):

```bash
node scripts/audit-loop.mjs code docs/plans/X.md            # Full orchestrated loop
node scripts/openai-audit.mjs code docs/plans/X.md          # GPT audit only
node scripts/gemini-review.mjs review <plan> <transcript>   # Gemini review only
```

**Scope control**: default audits only git-changed files. Override with `--scope full`, `--exclude-paths 'vendor/**'`, or a `.auditignore` file.

## Learning System

The audit loop gets smarter over time:

| Component | What it does |
|-----------|-------------|
| **Thompson Sampling** | Selects best-performing prompt variant per pass (bandit arms) |
| **FP Tracker** | Tracks recurring false positives with exponential decay; auto-suppresses patterns with <15% acceptance |
| **Meta-Assessment** | Every ~4 runs: evaluates FP rate, severity calibration, convergence speed; recommends prompt changes |
| **Prompt Evolution** | Creates experimental prompt variants, tests them via bandit, promotes winners |
| **Debt Review** | Clusters deferred findings by file/principle/recurrence; ranks refactor candidates by leverage |
| **User-Impact Reward** | Bandit also rewards findings that `/persona-test` later confirmed in a live browser |

Learning applies to **both** GPT audit passes and Gemini final review.

## Architectural Memory

Per-repo symbol-index in Supabase (with embeddings) catches duplicate-function drift before code gets written.

**Indexes**: every function, class, component, hook, route, method, and exported constant — name, file path, signature, body checksum, LLM-generated 1-line purpose summary, embedding vector. Snapshot-isolated per refresh.

**Catches drift via 5 surfaces**:
1. **Plan-time** — `/plan` consults the index in Phase 0.5; near-duplicates appear as a "Neighbourhood considered" callout
2. **Ad-hoc-fix time** — `UserPromptSubmit` hook auto-fires on intent verbs (`fix`, `add`, `implement`, etc.) and prepends a consultation callout to Claude's context
3. **Audit-time** — `/audit-code --scope=full` inlines the full symbol catalogue
4. **Drift sweep** — weekly GH workflow opens a sticky issue when cosine-similar symbol pairs cluster
5. **Render** — committed `docs/architecture-map.md` with Mermaid C4 diagrams per domain

**Setup per consumer repo**:

```bash
# Requires AUDIT_DB_URL (the cloud learning store DSN) in .env, then:
npm run arch:refresh:full
git add .audit-loop/repo-id docs/architecture-map.md package.json
git commit -m "feat(arch-memory): initial index"
```

**Cost**: ~$0.50 for first full refresh of a 1000-symbol repo (Haiku purpose summaries + Gemini `gemini-embedding-001`). Steady-state ~$0 thanks to signature-hash caching. Per-prompt hook consultation: ~$0.0003.

**Tracked in consumer repos**: `.audit-loop/repo-id`, `.audit-loop/domain-map.json` (path-based domain rules), `docs/architecture-map.md`, `package.json` arch:* scripts. Synced runtime files (`scripts/lib/symbol-index/*`, `scripts/symbol-index/*`, `.claude/hooks/arch-memory-check.sh`) are gitignored — managed by `npm run sync` from the source repo.

## Browser Tools

`/persona-test` and `/ux-lock` use Playwright via `.mcp.json` (auto-discovered by Claude Code). Required first-time install:

```bash
npx playwright install chromium
```

Windows users — see [CLAUDE.md](CLAUDE.md#claude-code-only-notes) for the `npx.cmd` MCP override needed by Claude Code's process spawner.

## Supported Platforms

| Platform | Skill location | Invoke |
|----------|---------------|--------|
| **Claude Code** (CLI, VS Code, Desktop) | `~/.claude/skills/<name>/` | `/<skill-name>` |
| **VS Code Copilot** | `.github/prompts/<name>.prompt.md` | `/<skill-name>` in Copilot Chat |
| **Cursor** | `.github/prompts/` or `.cursor/rules/` | `/<skill-name>` or terminal |
| **Windsurf** | `.github/prompts/` | `/<skill-name>` or terminal |
| **Any terminal** | N/A | `node scripts/audit-loop.mjs` |

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `OPENAI_API_KEY` | **Yes** | GPT auditing |
| `GEMINI_API_KEY` | No | Gemini final review + Flash context briefs |
| `ANTHROPIC_API_KEY` | No | Claude Opus fallback + Haiku purpose summaries |
| `AUDIT_DB_URL` | No | Postgres DSN for the cloud learning store (Supabase pooler or self-hosted). Unset → local-only mode |
| `AUDIT_DB_SSL_MODE` | No | `require` (default) / `no-verify` (Supabase poolers) / `disable` (localhost non-TLS) |
| `META_ASSESS_INTERVAL` | No | Run meta-assessment every N audits (default 4) |
| `ARCH_RENDER_MAX_SYMBOLS` | No | Cap on symbols pulled into the rendered map (default 50000) |
| `ARCH_DRIFT_SCORE_THRESHOLD` | No | Drift score above this is RED (default 20) |
| `PERSONA_TEST_APP_URL` | No | Default app URL for `/persona-test list` |
| `PERSONA_TEST_REPO_NAME` | No | Repo name for cross-referencing audit findings |

## Learning Store

Set `AUDIT_DB_URL` to a Postgres 13+ DSN to enable cloud / cross-repo
persistence (debt ledger, audit history, bandit arms, FP patterns). Works
against Supabase (Session pooler, port 5432), self-hosted Postgres, RDS,
Neon, Railway, etc. Requires the `pgvector` and `pg_trgm` extensions.

Unset → local JSON files only, single audit session, zero cloud. See
[AGENTS.md → Postgres-Parity Store](AGENTS.md#postgres-parity-store-m1m4)
for the connection model + setup recipe.

## Security

- `.env` files are gitignored; API keys are never logged
- Sensitive file patterns excluded from external API calls
- All subprocess calls use `execFileSync` (no shell string interpolation)
- Brainstorm topic is run through `redactSecrets()` before sending to providers
- Installer verifies SHA checksums against manifest before writing files

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and PR guidelines.

## License

MIT — see [LICENSE](LICENSE)
