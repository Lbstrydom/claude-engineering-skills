# MCP tooling — Playwright (persona-test) and Mermaid validation (plan diagrams)

**What it is**: how the two MCP servers this repo registers in `.mcp.json` (and
mirrors in `.vscode/mcp.json`) are set up and used — Playwright MCP for the
browser-driving skills, and `mcp-mermaid` for validating plan diagrams.

**When you need it**: a fresh machine where `/persona-test` shows no browser
tools; a Windows MCP spawn failure; or a Mermaid diagram that renders on GitHub
but breaks elsewhere.

**Why it lives here**: AGENTS.md is loaded every session and enforced at 92,000
characters (`npm run context:check`); setup recipes are subsystem-grade detail
that belongs in `docs/` behind a short stub. These passages were relocated from
AGENTS.md on 2026-10-03, verbatim apart from formatting and link paths.

---

## Browser tool setup (persona-test)

`/persona-test` drives a real browser. **Playwright MCP is the preferred tool** —
it's free, no credentials needed, works on your own apps.

`.mcp.json` is included in this repo. Claude Code auto-discovers it and prompts you
to enable Playwright MCP on first open. Just click **Allow** when prompted.

**First-time setup — install the browser:**

```bash
npx playwright install chromium
```

This is required before the MCP server will start. Without it, the server crashes
silently and no tools appear.

**Verify it's working:**

```bash
npx @playwright/mcp@latest --version   # should print a version number
```

**Windows users** — Claude Code may need an MCP override; see
[CLAUDE.md](../../CLAUDE.md#claude-code-only-notes).

BrightData Scraping Browser is also supported (handles anti-bot/CAPTCHA) but
requires a paid account and KYC approval. Playwright is preferred for testing your
own apps.

## Mermaid validation (for plan diagrams)

Two surfaces for catching broken Mermaid before it ships:

- **Interactive (during plan generation)** — `.mcp.json` registers `mcp-mermaid`.
  Claude Code prompts to enable on first open (same flow as Playwright MCP). VS Code
  registers the same server from `.vscode/mcp.json`. The tool is
  **`mcp__mermaid__generate_mermaid_diagram`** (server name `mermaid` ⇒ that
  prefix); call it with `outputType: "mermaid"` to validate without rendering —
  invalid syntax returns an MCP error with the parser's line/column. No API key
  needed. It complements `plans:lint`, which catches renderer-strictness bugs the
  parser accepts (measured: the MCP passes `SG1 -.- B`). This bullet said
  `mcp__claude_ai_Mermaid_*` until 2026-09-02 — a server this repo never
  registered, so `/plan`'s validation step had never run.
- **Pre-push (static lint)** — `npm run plans:lint` scans `docs/plans/*.md` for two
  classes of bugs that GitHub renders leniently but VS Code preview / stricter
  renderers reject:
  - **ERROR `subgraph-as-edge-endpoint`** — using a `subgraph` ID as an edge
    endpoint (`SG1 -.- other`). Mermaid graph syntax doesn't allow this; anchor the
    edge to a node *inside* the subgraph.
  - **WARN `unquoted-special-chars-in-label`** — node label brackets containing
    `<br/>` or non-ASCII chars (em-dash, etc.) without surrounding quotes. The
    bracketed-but-unquoted form parses in current Mermaid but breaks in older
    bundled versions. Always use `ID["..."]` when the label has special chars.

Runs as part of `npm run check` (the pre-push hook). ERRORs block; WARNs are
advisory. Why narrow rule coverage: the full Mermaid parser is in the 76MB
`mermaid` package, too heavy for one lint. `@mermaid-js/parser` (lightweight
alternative) doesn't yet handle flowchart/graph — we'll switch when it does. Until
then, this regex linter + the MCP cover the gap.
