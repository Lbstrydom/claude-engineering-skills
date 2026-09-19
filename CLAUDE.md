# CLAUDE.md — Claude Code-Specific Addendum

@./AGENTS.md

> **Shared project context lives in [AGENTS.md](./AGENTS.md).** That's the
> canonical file — both Claude and other coding agents (Copilot, Cursor,
> Windsurf, Codex CLI) read it. Edit shared rules there, not here. This file
> holds Claude Code-only material that doesn't apply to other agents.

## Claude Code-only Notes

### Windows MCP override (Playwright)

If Playwright MCP tools don't appear in Claude Code after installing Chromium
and restarting, add this to `~/.claude/settings.json`:

```json
"mcpServers": {
  "playwright": {
    "command": "npx.cmd",
    "args": ["@playwright/mcp@latest", "--headless"]
  }
}
```

Then restart Claude Code. Windows requires `npx.cmd` (the `.cmd` wrapper)
rather than bare `npx` for Claude Code's process spawner to resolve it
correctly. Other agents (Copilot, Cursor) configure MCP differently —
this override does not apply to them.

### Memory & the `#`-key

During a Claude Code session, press `#` to have Claude auto-incorporate
learnings into memory. Default target: **AGENTS.md** (canonical, shared with
teammates). Only use this CLAUDE.md for learnings that are genuinely
Claude-specific (slash commands, hooks, MCP overrides). When in doubt,
prefer AGENTS.md.

Auto-memory directory (managed by the harness, do not hand-edit unless
removing stale entries):
`~/.claude/projects/<repo-slug>/memory/`

### Plugin evals (pilot)

`.claude-plugin/plugin.json` + `evals/` at repo root let `claude plugin eval`
test whether a skill's SKILL.md prose actually steers Claude to the right
skill for an ambiguous prompt (e.g. `/plan` vs `/audit-plan`, `/explain` vs
`/investigate`) — a surface `npm test` doesn't cover, since that suite only
exercises `scripts/lib/**`. **CLI-only, by design**: Copilot/Cursor have no
equivalent feature, and the eval sandbox never reads `.claude/skills/`, so it
cannot affect the Copilot-native distribution surface either way. Pilot
cases, cost guidance, and how to extend it:
[`docs/reference/plugin-evals.md`](docs/reference/plugin-evals.md). Cheap
smoke check: `claude plugin eval . --tag pilot --runs 1 --ablation none`.
