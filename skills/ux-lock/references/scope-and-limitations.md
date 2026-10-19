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

## Limited for — Electron / native desktop apps (Obsidian plugins included)

Playwright does not navigate to an Electron app the way it does a URL — there
is no `http(s)://` to `page.goto`. That is a different claim from "Playwright
can't drive it": Playwright's own `_electron` module launches and controls an
Electron process directly, and `chromium.connectOverCDP(...)` attaches to an
already-running one if it exposes a remote-debugging port. **Check the target
repo for an existing mechanism BEFORE assuming none exists or reaching for the
heavier fallbacks below** — a real session concluded persona-testing/locking
"didn't apply" to an Electron app that had a working CDP-driving mechanism the
whole time, because nothing prompted the check. Look for:

- `package.json` scripts like `e2e`, `test:e2e`, `debug`, `electron:debug` —
  often already launch the app with remote debugging enabled.
- The main-process source for `app.commandLine.appendSwitch(
  'remote-debugging-port', …)` or an `--inspect` / `--remote-debugging-port=<port>`
  launch flag.
- An existing Playwright config/helper using `_electron.launch()` or
  `connectOverCDP(...)` — a repo with any prior Electron e2e coverage has
  usually solved this once already.
- README / CONTRIBUTING for a documented debug/devtools workflow.

If found (or quick to add), the LOCK spec drives the app directly instead of
`page.goto(baseURL)` — `ux-lock-run.mjs --spec <path>` does not require `--url`
when the spec sets up its own Electron context; it's only used to seed
`E2E_BASE_URL` for specs that navigate. If no mechanism exists and none is
worth adding for this fix, fall back to:

1. **Unit test the plugin's logic with vitest** — not e2e. Extract
   view-model and business logic so it's testable without Electron.
2. **Mock HTML harness** — render the plugin's UI components in a
   standalone HTML page and run Playwright against that.
3. **Persona-test against dev tools** — use `/persona-test` with a browser
   driver attached to the app's dev-tools window, if exposed. `/persona-test`
   applies the same repo-mechanism check before its own driver ladder
   (its `browser-tool-detection.md` §3 Step 0) — don't re-derive it here.
4. **Full Electron e2e via `_electron.launch()`** — heavier to author.
   Reserve for critical user flows only when the repo has no lighter
   mechanism already wired.

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

If `npx playwright install chromium` ran but Playwright tools still don't
appear, the server is failing to spawn. Bare `npx` is a `.cmd` script rather
than an executable, so a non-shell spawn cannot resolve it — measured on
Windows 11, `spawn('npx')` returns **ENOENT**. Upgrade your editor first
(reported fixed in VS Code 1.111+); if it persists, override the launch command
for the host you are actually on:

**Claude Code** — `~/.claude/settings.json`, then restart:

```json
"mcpServers": {
  "playwright": {
    "command": "npx.cmd",
    "args": ["@playwright/mcp@latest", "--headless"]
  }
}
```

**VS Code / GitHub Copilot** — `.vscode/mcp.json`, whose top-level key is
`servers` (not `mcpServers`), routed through the command processor:

```json
"servers": {
  "playwright": {
    "type": "stdio",
    "command": "cmd",
    "args": ["/c", "npx", "-y", "@playwright/mcp@latest", "--headless"]
  }
}
```

Both are community workarounds rather than vendor-endorsed fixes, and both are
machine-local. (This bundle's own source repo runs an MCP-parity gate that
compares `command` exactly between the two config files, so a committed
Windows-only override there needs a declared exception; your repo has no such
constraint.)

## Running the Playwright CLI from a linked worktree (PowerShell)

Playwright takes `playwright.config.*`, the test tree and the `@playwright/test` it loads from where it is **started**. A
Windows consumer (2026-10-18, Playwright 1.63.0) launched one checkout's Playwright executable while the shell was in another
checkout, then saw `Playwright Test did not expect test.use() to be called here` during discovery. Mixed installs from two checkouts
are the likely cause (the same run succeeded from the matching checkout), but it was not reproduced upstream, so treat it as a
pitfall to rule out, not a diagnosis. Enter the checkout you mean, pass its config explicitly, and use ITS binary:

```powershell
Set-Location C:\work\app-feature-x
node .\node_modules\@playwright\test\cli.js --version
node .\node_modules\@playwright\test\cli.js test --config .\playwright.config.js --list
node .\node_modules\@playwright\test\cli.js install chromium
```

A `--list` that names exactly the specs of this checkout is the check that matters; `node -e "console.log(process.cwd(), require.resolve('@playwright/test'))"`
only shows which package a plain Node process resolves from here, not what the config loads. Under `fleet lease run` the child
inherits the cwd, so `Set-Location` first.
