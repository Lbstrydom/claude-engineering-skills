---
summary: Sanctioned pattern for auth-gated exploratory testing via MCP-server storageState, not in-session injection.
---

# Auth Bootstrap — Exploratory Mode

Loaded when Phase 1's target app sits behind a login wall and the persona
needs to reach authenticated surfaces (not just the public shell).

## Why this exists

Exploratory mode drives the browser through MCP tool calls
(`browser_navigate`, `browser_click`, …) — there is no per-call lever
equivalent to `--mode consistency`'s `authBootstrap` (`CanaryDefinitionSchema`
in [`scripts/lib/persona-test/schemas.mjs`](../../../scripts/lib/persona-test/schemas.mjs)),
which owns Playwright directly and can pass `storageState` at
`context.newContext()` time. Without a documented answer, the natural
workaround is to reach for `browser_evaluate` and inject a session token
into `localStorage`/cookies by hand — **do not do this**. It is
indistinguishable, from the client's safety heuristics, from a prompt
trying to exfiltrate or plant credentials via the page, and gets
(correctly) blocked.

The real lever is one level up: **the Playwright MCP server itself**
accepts session-wide auth flags at launch (`npx @playwright/mcp --help`):

```
--storage-state <path>   path to the storage state file for isolated sessions.
--secrets <path>         path to a file containing secrets in dotenv format.
```

These apply to the whole MCP session, before any tool call — which is
exactly the scope exploratory mode needs.

## The sanctioned pattern

1. **Write a small per-repo bootstrap script** (not part of this bundle —
   it's app-specific sign-in logic) that:
   - Launches Playwright directly (`chromium.launch()`),
   - Drives the *real* sign-in flow (navigate to the login page, fill
     credentials read from env vars — never hardcoded),
   - Calls `context.storageState({ path: '.auth/state.json' })` to persist
     cookies + localStorage.

   This mirrors `newAuthedContext`'s `storageState` branch in
   [`scripts/persona-consistency-run.mjs`](../../../scripts/persona-consistency-run.mjs)
   almost line for line — consistency mode already solved this; exploratory
   mode just needs the same artifact handed to a different consumer.

2. **Gitignore the state file.** It contains live session cookies/tokens —
   treat it exactly like `.env` (see `sensitive-paths.mjs`'s `sensitive`
   category in the root AGENTS.md). `.auth/` or `.auth/state.json` is a
   reasonable convention; add it to the consumer repo's `.gitignore`.

3. **Point the MCP server at it** in `.mcp.json`:

   ```json
   "playwright": {
     "type": "stdio",
     "command": "npx",
     "args": ["-y", "@playwright/mcp@latest", "--headless", "--storage-state", ".auth/state.json"]
   }
   ```

4. **Reconnect the MCP server** (restart the client / re-approve the
   server) — `.mcp.json` is read at connect time, not per tool call. This
   makes auth bootstrap a **one-time per-session setup step**, not
   something the exploration loop can toggle mid-run.

If credential handling needs to go through `--secrets` instead of a
storage-state file (e.g., a bearer-token API rather than cookie session),
verify the installed `@playwright/mcp` version's exact secrets-file
contract before relying on it — `--help` only documents the flag's shape,
not the redaction guarantees, and those can change between releases.

## What this does NOT change

- **Phase 3's login-wall special case still applies** when no bootstrap is
  configured — a login wall hit mid-exploration (not resolved by any of
  the above) is real signal, not a setup bug. See Phase 3 for how that
  degrades the run's OVERALL verdict.
- **This is still static for the session.** Unlike consistency mode, you
  cannot flip auth on/off between Plan→Act→Reflect steps, and pair mode's
  two personas share one MCP server connection — if one persona needs
  authenticated access and the other needs the logged-out shell, that's a
  `--mode consistency` case, not exploratory.
- **click-test** drives the same Playwright MCP connection (see
  `references/browser-tool-detection.md`) and inherits this bootstrap
  identically — no separate setup there.
