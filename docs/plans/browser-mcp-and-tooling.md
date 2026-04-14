# Plan: Browser MCP Tooling + Skill Sync Improvements

## Objective
Improve the persona-test skill and supporting infrastructure for the claude-audit-loop engineering skills bundle.

## Changes in scope

### 1. Browser tier reorder (SKILL.md)
- Playwright MCP promoted to Tier 1 (preferred for own apps — free, direct)
- BrightData demoted to Tier 2/3 (only for external anti-bot sites)
- Own-app domain detection added: *.railway.app, *.vercel.app, *.netlify.app skip BrightData
- G1 guard updated to cover all own-app domains, not just localhost
- Action table column order updated to match new tier priority

### 2. Playwright MCP configuration
- ~/.claude/settings.json: mcpServers.playwright added (npx @playwright/mcp@latest --headless)
- .vscode/mcp.json created for VSCode Copilot Chat MCP support
- Tier 4 error message updated with exact setup instructions for both editors

### 3. check-setup.mjs (new script)
- Validates env vars and Supabase tables for all active features
- Probes tables directly via sb.from(name).select('*').limit(0), checks error.code 42P01
- Supports --repo-path, --fix, --json flags
- Exit 0 = all pass, exit 1 = failures; warnings are non-blocking
- Integrated into sync-to-repos.mjs post-sync validation

### 4. debt-auto-capture.mjs (new script)
- Single-command replacement for manual Step 3.6 debt capture boilerplate
- Reads ruling='defer' entries from adjudication ledger
- Transforms via buildDebtEntry(), writes to .audit/tech-debt.json
- Supports --reason, --dry-run flags

### 5. sync-to-repos.mjs updates
- EDITOR_FILES array added (.vscode/mcp.json)
- Post-sync check-setup.mjs validation run for each repo
- Persona-test SKILL files added to sync targets

## Success criteria
- All repos (wine-cellar-app, ai-organiser) have identical SKILL.md versions
- check-setup.mjs passes green on all repos
- Playwright MCP correctly selected as Tier 1 for *.railway.app URLs
- No BrightData probes wasted on own-app tests
