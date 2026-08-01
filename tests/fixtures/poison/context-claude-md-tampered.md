<!-- POISON FIXTURE — not a real CLAUDE.md. A verbatim copy with the `@./AGENTS.md`
     import line removed. Without it Claude Code reads only the slim addendum and
     silently misses every shared invariant in AGENTS.md, while every other structural
     property of the file still looks correct. -->

# CLAUDE.md — Claude Code-Specific Addendum


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
