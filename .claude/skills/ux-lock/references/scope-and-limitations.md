---
summary: Where /ux-lock works well, where it doesn't (Obsidian/Electron), and fallback strategies.
---

# Scope + Limitations

## Do NOT import app modules into the spec

A spec must drive the UI (`page.goto` + user actions). Importing the app's own
source or deployed ES modules into the Playwright spec process is prohibited —
it couples the spec to the bundle layout instead of the user contract, and the
lock silently dies on any build/framework migration (observed in the wild: two
consumer shell-mode specs imported deployed app modules directly and every
assertion bypassed the UI).

- **Approved**: drive the UI; import only test-local helpers (`./helpers/…`),
  `@playwright/test`, and ordinary npm test deps.
- **If unavoidable**: `page.evaluate` against the live page. Structural
  `querySelector` calls inside it need the
  `// selector-policy: structural — <reason>` marker like any other call site.
- **Enforced**: the run pipeline's `app-module-import` lint class flags app-source
  imports (static, dynamic `import()`, and `require`) in every spec it runs,
  including transitively through local helpers — warn by default,
  `--strict-selectors` fails the run.

The "Mock HTML harness" approach below (rendering components in a standalone
page) is different and fine — the page renders the component; the spec process
imports nothing.

## Works for

Web apps served via URL:
- Express, Next.js, Nuxt, SvelteKit, Remix, Astro — anywhere HTTP reaches
- Deployed to Railway, Vercel, Netlify, Fly, Render, etc.
- Local dev servers (`localhost:*`) — Playwright attaches fine

Playwright navigates to `baseURL`, drives the DOM, asserts on elements.
Both LOCK and VERIFY modes require a URL the browser can reach.

## Limited for — Obsidian plugins (Electron apps)

Playwright can't attach to Obsidian's Electron process. For Obsidian
plugins, use these approaches instead:

1. **Unit test the plugin's logic with vitest** — not e2e. Extract
   view-model and business logic so it's testable without Electron.
2. **Mock HTML harness** — render the plugin's UI components in a
   standalone HTML page and run Playwright against that.
3. **Persona-test against dev tools** — use `/persona-test` with
   Playwright MCP driving Obsidian's dev tools window if exposed.
4. **Full Electron e2e** — `_electron.launch()` works but is heavy.
   Reserve for critical user flows only.

When refactoring Obsidian plugin code, ship LOCK specs for the **pure
logic** (parser, normaliser, diff algorithms) via vitest instead.

## Limited for — CLI apps

No DOM → no Playwright. For CLI regression, prefer:
- Snapshot tests (input → output stdout/stderr match)
- Exit-code tests
- Running the CLI inside a subprocess + asserting on formatted output

LOCK mode is not the right tool here. Don't force it.

## Degraded — browser available but app has anti-bot

If the target URL is behind anti-bot (CAPTCHA, Cloudflare challenge,
rate-limit fingerprinting):

- LOCK mode: consider testing against a local dev deployment instead of
  the anti-bot production URL. The contract is the same; the environment
  is friendlier.
- VERIFY mode: same — verify against staging/dev, not a CAPTCHA-protected
  production URL. `plan_satisfaction` records are per-commit, so you
  can verify on dev, then promote.

`/persona-test` has BrightData support for anti-bot URLs; `/ux-lock`
currently does not. Raise a follow-up if you need it.

## Helpers assumed

Both modes expect:

- `tests/e2e/helpers/auth.js` with `loginAsTestUser(page)` — handles the
  session/cookie setup the tests need.
- `tests/e2e/helpers/axe.js` with `expectNoA11yViolations(page, opts)` —
  thin wrapper around `@axe-core/playwright`.

If these don't exist in the target repo, bootstrap from the template:

```bash
cp scripts/templates/playwright-config.js playwright.config.js
mkdir -p tests/e2e/helpers
cp scripts/templates/e2e-helpers/* tests/e2e/helpers/
npm install -D @playwright/test axe-core @axe-core/playwright
npx playwright install chromium
```

## Windows Playwright MCP caveat

If `npx playwright install chromium` ran but Playwright tools still
don't appear in Claude Code, add this override to `~/.claude/settings.json`:

```json
"mcpServers": {
  "playwright": {
    "command": "npx.cmd",
    "args": ["@playwright/mcp@latest", "--headless"]
  }
}
```

Restart Claude Code. Windows requires the `.cmd` wrapper for process
spawning — bare `npx` doesn't resolve through Claude Code's spawner.
