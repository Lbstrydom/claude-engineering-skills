# Available skills (18 total)

Run `node scripts/skills-help.mjs <name>` for detail on one skill,
or `/skills <name>` from inside Claude.

| Skill | One-liner |
|---|---|
| `/ai-context-management` | Manage AGENTS.md and CLAUDE.md alignment across a repo so Claude, Copilot, Cursor, Windsurf, and other AI agents share the same project context. |
| `/audit-code` | Iteratively audit code against a plan with GPT + an independent final gate (Gemini, else Claude). |
| `/audit-plan` | Iteratively audit a plan file (docs/plans/*.md) with GPT + final gate (Gemini/Claude). |
| `/brainstorm` | Multi-LLM concept-level brainstorming. |
| `/click-test` | Structural DOM audit of a live app — walk every interactive element and assert semantic-HTML contracts (duplicate IDs, orphan labels, inputs without names, ARIA misuse, heading hierarchy, missing alt text, undersized touch targets). |
| `/cycle` | End-to-end feature cycle orchestrator. |
| `/explain` | Explain WHY a piece of code is structured the way it is. |
| `/fleet` | Coordinate SEVERAL CONCURRENT AI coding sessions (desktop chips, linked worktrees, a shared tree): see who is doing what, stop two sessions building the same thing, and land ready branches with ONE combined test run after explicit human approval. |
| `/harness-retro` | Post-session retro for the AI harness itself: mechanically scan recent Claude Code session transcripts for failures that RECUR across sessions (tool errors, denials, hook errors and blocks, refusals, retries, user corrections), check what the harness already has, then judge each ranked candidate and PROPOSE the lowest enforcing layer (hook/gate > script > reference doc > AGENTS.md) with the failure it prevents, the exact change and a positive-control test. |
| `/investigate` | Settle a factual claim about this repo with a measurement, not a recollection. |
| `/nav-audit` | Static, code-derived navigation / information-architecture audit — the system-level third lens complementing /persona-test (journey-level) and /click-test (page-level). |
| `/persona-test` | Persona-driven exploratory browser testing against a live URL. |
| `/plan` | Unified architecture + UX planner with engineering principles. |
| `/security-strategy` 🔒 | On-demand maintenance of the per-repo security memory: bootstrap an initial threat model + add/append incidents to docs/security-strategy.md with proper marker comments, then refresh the Supabase index. |
| `/ship-checked` 🔒 | Our /ship: syncs docs, runs the repo's checks, then commits and pushes. |
| `/skills` 🔒 | Quick reference for every available skill in this repo — name, one-line purpose, triggers, usage examples — without having to open each individual SKILL.md document. |
| `/ux-lock` | Generate Playwright e2e specs. |
| `/visual-audit` | Math-first, deterministic visual/paint inspection — the 4th UX lens, complementing persona-test (journey), click-test (page), and nav-audit (system). |

🔒 = `disable-model-invocation: true` — Claude Code and VS Code Copilot will not auto-trigger it; invoke explicitly via `/<name>`. Each locked skill also states the rule in its body, for hosts that ignore the key.
