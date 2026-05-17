# Available skills (15 total)

Run `node scripts/skills-help.mjs <name>` for detail on one skill,
or `/skills <name>` from inside Claude.

| Skill | One-liner |
|---|---|
| `/ai-context-management` | Manage AGENTS.md and CLAUDE.md alignment across a repo so Claude, Copilot, Cursor, Windsurf, and other AI agents share the same project context. |
| `/audit-code` | Iteratively audit code against a plan with GPT + Gemini final gate. |
| `/audit-loop` | DEPRECATED — use `/cycle` for the full chained workflow, OR `/audit-plan` / `/audit-code` for atomic invocations. |
| `/audit-plan` | Iteratively audit a plan file (docs/plans/*.md) with GPT + Gemini final gate. |
| `/brainstorm` | Multi-LLM concept-level brainstorming. |
| `/cycle` | End-to-end feature cycle orchestrator. |
| `/explain` | Explain WHY a piece of code is structured the way it is. |
| `/persona-test` | Persona-driven exploratory browser testing against a live URL. |
| `/plan` | Unified architecture + UX planner with engineering principles. |
| `/plan-backend` | DEPRECATED — thin alias for `/plan --scope=backend`. |
| `/plan-frontend` | DEPRECATED — thin alias for `/plan --scope=frontend`. |
| `/security-strategy` 🔒 | On-demand maintenance of the per-repo security memory: bootstrap an initial threat model + add/append incidents to docs/security-strategy.md with proper marker comments, then refresh the Supabase index. |
| `/ship` | Sync all project documentation, optionally update a plan, then commit and push to git. |
| `/skills` 🔒 | Quick reference for every available skill in this repo — name, one-line purpose, triggers, usage examples — without having to open each individual SKILL.md document. |
| `/ux-lock` | Generate Playwright e2e specs. |

🔒 = `disable-model-invocation: true` — skill must be invoked explicitly via `/<name>` (Claude will not auto-trigger it).
