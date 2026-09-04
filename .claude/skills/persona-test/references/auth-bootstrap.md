---
summary: Sanctioned auth-gated exploratory-testing pattern via MCP-server storageState, plus its connect-time-race escape hatch.
---

# Auth Bootstrap — Exploratory Mode

Loaded when Phase 1's target app sits behind a login wall and the persona
needs to reach authenticated surfaces (not just the public shell).

## Why this exists

Exploratory mode drives the browser through MCP tool calls
(`browser_navigate`, `browser_click`, …) — there is no per-call lever
equivalent to `--mode consistency`'s `authBootstrap` (`CanaryDefinitionSchema`
in [`scripts/lib/persona-test/schemas.mjs`](https://github.com/Lbstrydom/claude-engineering-skills/blob/main/scripts/lib/persona-test/schemas.mjs)),
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
   [`scripts/persona-consistency-run.mjs`](https://github.com/Lbstrydom/claude-engineering-skills/blob/main/scripts/persona-consistency-run.mjs)
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

## The connect-time race

The MCP server reads `--storage-state` exactly once, at connect (step 4
above) — never again. Two situations then produce an identical-looking
login wall mid-run, and they mean very different things:

- **Token expired since connect.** The file on disk was valid when the
  server connected, but this repo's Supabase access tokens last 1 hour —
  a persona run that reaches an authenticated surface more than an hour
  into the session finds the token the browser is carrying (frozen at
  connect time) has expired, even though sign-in itself was never broken.
  Re-running the bootstrap script mid-session makes this *look* fixed but
  isn't: it writes a fresh token to the file, but nobody re-reads that
  file until the next reconnect, so the browser keeps carrying the old,
  now-expired one. **This is a rig problem, not a product regression.**
- **Bootstrap never worked.** The sign-in flow itself is broken — wrong
  credentials, a changed login form, `storageState` never written, a wrong
  path in `.mcp.json`. **This is a genuine setup regression.**

Do not assume a login wall is the second one. See Phase 3's login-wall
special case in `SKILL.md` for the decision order that tells them apart
before anything gets reported.

## Escape hatch — in-session recovery from the connect-time race

Use this only after Phase 3 has identified a login wall as the
connect-time race above (bootstrap *was* configured, session has been
running a while) — not as a substitute for setting up `storageState` in
the first place, and not for a wall where no bootstrap was ever
configured (that's the P3 branch in Phase 3, not this).

This is narrower than the injection this document opened by prohibiting.
That warning is about the LLM fabricating or planting a credential from an
untrusted source. This instead re-reads a value the *sanctioned* bootstrap
script itself just wrote to a gitignored file on disk, for the one
connection that was already trusted to use it — recovery, not invention.

1. Re-run the bootstrap script from step 1 of the sanctioned pattern above
   to refresh `.auth/state.json` (or your app's equivalent path) with a
   live token.
2. Read that file directly and pull the `origins[].localStorage` entries
   for the target origin — Playwright's `storageState` shape is
   `{cookies: [...], origins: [{origin, localStorage: [{name, value}, ...]}]}`.
3. Navigate to the target origin if not already there, then call
   `browser_evaluate` with a script that does `localStorage.setItem(name,
   value)` for each entry from step 2.
4. Reload (`browser_navigate` to the same URL, or an explicit reload) and
   confirm the login wall is gone.

Two things this cannot fix: an **HttpOnly session cookie** (invisible to
`browser_evaluate` by design — cookies in `storageState.cookies` marked
`httpOnly` can't be set from page script), and a bootstrap that fails even
freshly re-seeded. In either case, stop retrying in-session and reconnect
the MCP server instead (restart the client / re-approve), or fall through
to Phase 3's genuine-misconfiguration branch.

**Never report the escape hatch itself as a finding**, success or failure
— it says nothing about the product. A successful recovery is rig
maintenance: continue the run normally, and the report's Auth coverage
line may note the mid-session refresh as context. A failed recovery *is*
signal, but it's the P1 in Phase 3's third branch, not a note about
`browser_evaluate`.

## What this does NOT change

- **Phase 3's login-wall special case still applies**, and now branches
  three ways: no bootstrap configured (public-surface-only, P3) / the
  escape hatch above recovers it (rig refresh, not a finding) / the escape
  hatch fails after a fresh re-seed (genuine setup regression, P1). See
  Phase 3 for the exact decision order and how each branch affects the
  run's OVERALL verdict.
- **This is still static for the session.** Unlike consistency mode, you
  cannot flip auth on/off between Plan→Act→Reflect steps, and pair mode's
  two personas share one MCP server connection — if one persona needs
  authenticated access and the other needs the logged-out shell, that's a
  `--mode consistency` case, not exploratory.
- **click-test** drives the same Playwright MCP connection (see
  `references/browser-tool-detection.md`) and inherits this bootstrap
  identically — no separate setup there.
