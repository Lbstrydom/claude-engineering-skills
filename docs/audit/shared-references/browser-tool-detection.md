---
summary: The browser-driver contract — capabilities, driver table, selection order, minimum sets, degraded/blocked evidence.
---

# Browser Tool Detection — the driver contract

This is the canonical copy. Generated copies live at
`skills/<skill>/references/browser-tool-detection.md` for every skill that
drives a browser through the host. **Edit this file, never a copy.**

<!-- host-contract: browser-driver; caps=navigate,readText,evaluate,click,type,keyboard,screenshot,wait,currentUrl -->

**This file is the ONE detection oracle.** `/persona-test` and `/click-test`
both resolve their driver here; neither defines its own tier list. A second
copy of this *ladder* is a defect — the per-skill copies below are generated
from this file and byte-checked, which is a different thing from a hand-kept
duplicate. See "No second tier list" at the end.

The `caps=` list in the marker is the closed vocabulary of §1, and a test
asserts the two agree. The **driver roster is §2's table alone** — it was
briefly duplicated into the marker as a `drivers=` field, which is a second
source of truth for the very registry §2 exists to hold, and contradicted this
document's own promise that adding a host is one table row.

It is a **contract**, not a preference list: a driver qualifies by the
capabilities it declares, and the consuming skill states the minimum set it
needs. Naming a vendor is how a row is labelled, never how a driver is chosen —
that is what lets a new host be added as one table row.

---

## 1. Capability vocabulary (CLOSED set)

A driver supports a capability only if it meets the semantics below. Nine
members, and no others — if you find yourself needing a tenth, add it here
rather than describing it in prose at a call site.

| Capability | Supported means |
|---|---|
| `navigate` | Loads a URL **and waits for the document to be ready**. A one-shot fetch does NOT satisfy it — there is no live document to wait on |
| `readText` | Given a URL, returns that page's text content. Self-sufficient: it does not require `navigate` first, which is what lets a one-shot fetcher provide it |
| `evaluate` | Runs arbitrary JS **in page context** and returns a serialisable result. A fetch-and-parse tool does **NOT** satisfy this, however good its HTML parsing |
| `click` | Dispatches a real click at an element resolved by selector or ref |
| `type` | Enters text into a focused or selector-resolved field |
| `keyboard` | Sends a named key (`Escape`, `Tab`, `Enter`) independent of any field |
| `screenshot` | Captures a raster image of the viewport or an element |
| `wait` | Waits for a condition (selector, load state, timeout) before continuing |
| `currentUrl` | Reports the URL after navigation and redirects |

`evaluate` and `readText` carry the weight of the whole contract. They are
deliberately separate: a static fetcher gives you `readText` and can never give
you `evaluate`, and `/click-test`'s entire DOM scan is one `evaluate` call.

---

## 2. Driver table — capabilities are DECLARED here, not negotiated

Three distinct steps, and conflating them is the defect this section exists to
prevent:

1. **Presence probe** — are this driver's tools available at all?
2. **Declaration** — read its row below. The row says what the driver is
   *expected* to support. A host does not answer capability questions, so this
   step is a table lookup and selection stays deterministic.
3. **Verification** — for an `expected` row only, **exercise** the consumer's
   minimum set once before relying on it (§ below). This is an action, not a
   question: you call the tool and observe.

Presence is step 1 and proves only step 1. Treating a successful response from
*some* browser tool as proof of all nine capabilities collapses 1 into 3, which
is precisely how a partial host surface gets selected on a promise it never
made.

| Driver | Detect by | Row is | navigate | readText | evaluate | click | type | keyboard | screenshot | wait | currentUrl |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `playwright-mcp` | `browser_navigate` responds | **pinned** — one server, versioned tool set | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `copilot-browser` | host-native browser tools respond (VS Code Copilot, GA 2026-07) | **expected** — verify per session | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `brightdata` | `mcp__brightdata__*` responds AND account configured | **pinned** | ✓ | ✓ | ✗ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ |
| `static-fetch` | the host's page-fetch tool responds | **expected** — role, not a product | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

**A row's ticks are a claim, and for an `expected` row the claim must be
checked before it is relied on.** "Some browser tools responded" cannot
establish that the host implements every semantic above — least of all
arbitrary page-context `evaluate`, ref-resolved interaction, named-key
dispatch, or condition-based `wait`. A host that ships a partial browser
surface would otherwise be selected on a promise it never made, and fail
mid-run rather than at selection.

**How to verify an `expected` row — exercise it, do not ask about it.** After
selecting the driver and **before the first scan or journey step**, run each
capability in the consumer's minimum set once against the target URL, using the
§6 mapping:

| Capability | Verification that counts |
|---|---|
| `navigate` | navigate to the URL and get a ready document |
| `readText` | get back non-empty page text |
| `evaluate` | evaluate `1+1` in page context and get `2` — a tool that returns HTML instead has **not** passed |
| `click` / `type` / `keyboard` | the tool exists and accepts a selector/ref or key argument without erroring |
| `wait` | accepts a selector or timeout condition |
| `currentUrl` | returns a URL string after the navigate above |
| `screenshot` | returns image data |

A capability that errors, is absent, or answers in a different shape is
**treated as unsupported** — strike it from the driver's row and re-run
selection (§3). If nothing then satisfies the minimum set, the outcome is
`degraded` or `blocked` per §5. Never a run that proceeds and discovers the gap
halfway through, and never a row believed because the driver answered *some*
other call.

A **pinned** row is fixed by a versioned server contract and needs no
per-session check; if that server's tool set changes, the row changes here.

`static-fetch` is whatever single-page fetch tool the host provides — it is a
**role**, not a product. Do not hard-code one host's tool name; if the host has
no such tool, the row is simply unavailable.

---

## 3. Selection — ONE ordered rule

Probe in this order and select the **first driver that satisfies the caller's
minimum set**:

```
playwright-mcp → copilot-browser → brightdata → static-fetch
```

The order *is* the preference, and it is ordered on one principle:
**credential-free drivers first**. There is no separate tie-breaker — with
first-match over a fixed order, a tie-breaker could never fire.

**Own-app short-circuit.** Skip `brightdata` entirely for an own app — it is a
paid anti-bot service and your own app needs no such thing. Log
`[OWN APP] BrightData skipped for own-app hostname`.

**Ownership is proven by loopback or by declaration, never by a shared
wildcard.** `*.railway.app`, `*.vercel.app` and `*.netlify.app` are
*hosting-provider* domains — millions of apps live under them, and almost none
of them are yours. Treating the wildcard as proof of ownership would classify
an arbitrary third party's site as an own app.

| Signal | Own app? |
|---|---|
| `localhost`, `127.0.0.1`, `::1`, `0.0.0.0` | **yes** — loopback cannot be someone else's |
| host ends `.local` / `.internal` | **yes** — non-routable by definition |
| host matches `PERSONA_TEST_APP_URL`, or a registered persona's `appUrl` | **yes** — the operator declared it |
| host is a PaaS wildcard (`*.railway.app`, `*.vercel.app`, `*.netlify.app`, `*.up.railway.app`) | **only if** it also matches a declared URL above |
| anything else | **no** |

An undeclared PaaS host is treated as external. That is the safe direction: the
cost is one unnecessary BrightData attempt, whereas the reverse silently drives
a stranger's production site as though it were yours.

Log the chosen driver once at session start and use it consistently — never
mix driver families mid-session.

---

## 4. Minimum capability sets, per consumer

No skill may say "the interaction set" without listing it.

| Consumer | Minimum set | If unmet |
|---|---|---|
| `/click-test` | `navigate`, `evaluate`, `click`, `keyboard`, `wait`, `currentUrl` | `blocked` — its DOM scan IS an `evaluate` call, so a static fetcher can never serve it |
| `/persona-test` — full journey | `navigate`, `click`, `type`, `evaluate`, `screenshot`, `wait`, `currentUrl` | fall to read-only degraded |
| `/persona-test` — read-only degraded | `readText` alone | `blocked` |

**Precedence: this table decides, §5 only names the outcomes.** A consumer
declares its own fallback in the "If unmet" column, and that column wins. §5
defines what `ok` / `degraded` / `blocked` *mean* and what evidence each
requires — it does not grant a degraded mode to a consumer whose row has none.

Concretely, and this is the case that reads ambiguously otherwise:
**`/click-test` has NO degraded mode.** Its complete set is mandatory, so any
absence is `blocked`, however much of the surface is present. A partial driver
does not earn it a reduced scan — a DOM audit that skipped the DOM would report
"no findings" about a page nobody examined.

---

## 5. Three statuses, each with its required evidence

A partial surface is **never** silently a pass. `degraded` is a real,
reportable outcome — it is not a synonym for `blocked`, and not a synonym for
success.

| Status | When | Required evidence | Permitted stages |
|---|---|---|---|
| `ok` | the consumer's full minimum set is met | driver name + the capabilities matched | all |
| `degraded` | read-only set met, interaction set not | driver name + **the missing capabilities, named** + a `[DEGRADED MODE]` banner at the top of the report | observation only. **No** interaction, flow or state-change stage may be reported as run |
| `blocked` | read-only set unmet | driver name + missing capability + each driver's probe-failure reason | none — abort before scanning |

**A `degraded` run must not report a clean verdict.** Its findings carry the
degraded status, and stages it could not run are reported as not-run rather
than as passing. This is the repo's capture-honesty rule: a partial capture
degrades to `unverified`, never to "verified / 0 findings".

Blocked output:

```
[BLOCKED] No driver satisfies the required capability set.
  Required: navigate, evaluate, click, keyboard, wait, currentUrl
  - playwright-mcp : <probe failure>
  - copilot-browser: <probe failure>
  - brightdata     : <probe failure or "not configured">
  - static-fetch   : present, missing evaluate/click/keyboard
Fix one of the above and retry.
```

---

## 6. Operation mapping

Bind the vocabulary to each driver's own call shape. Add a column when you add
a driver row.

| Capability | `playwright-mcp` | `copilot-browser` | `brightdata` | `static-fetch` |
|---|---|---|---|---|
| navigate | `browser_navigate({url})` | the host's navigate tool | `brightdata_session_open({url})` | — |
| readText | page snapshot / text | the host's page-text tool | `brightdata_scrape_as_markdown` | fetch result body |
| evaluate | `browser_evaluate({function})` | the host's JS-evaluate tool | — | — |
| click | `browser_click({selector})` | the host's click tool | `brightdata_session_click` | — |
| type | `browser_type({selector, text})` | the host's type tool | `brightdata_session_type` | — |
| keyboard | `browser_press_key({key})` | the host's key tool | — | — |
| screenshot | `browser_take_screenshot()` | the host's screenshot tool | `brightdata_session_screenshot` | — |
| wait | `browser_wait_for({selector\|time})` | the host's wait tool | poll `brightdata_session_*` until ready | — |
| currentUrl | read from `browser_snapshot` / navigate result | the host's page-context or tab listing | `brightdata_session_*` response url | — |
| close *(not a capability — lifecycle)* | `browser_close()` | the host's tab-close tool | `brightdata_session_close` | — |

Every one of the nine vocabulary members has a row. `close` is listed for
completeness but is session lifecycle, not a capability — no minimum set
requires it. A missing row for a vocabulary member is a defect in this table,
not a licence to improvise at the call site.

Host-native tool names are deliberately described by role rather than spelled
out: they vary by host and version, and a stale literal name reads as a missing
capability. Match on what the tool *does*.

---

## No second tier list

`/click-test` cites this file and states only its minimum set. If you are about
to write a `## Tier` heading in any other skill, stop — that is the two-oracles
defect. Two ladders drift, and the drift is silent because each reads correct on
its own. `tests/skill-consumer-refs.test.mjs` asserts no host-driven browser
skill contains a `## Tier` heading.

---

## Prerequisites and the Windows spawn failure

`playwright-mcp` needs `npx playwright install chromium` run once. If its tools
never appear, that step was likely skipped — the server exits silently when
Chromium is missing.

**Windows: a stdio MCP server launched as bare `npx` fails to spawn.** Measured
on Windows 11, `spawn('npx')` without a shell returns **ENOENT**, because `npx`
is a `.cmd` script rather than an executable. Update your editor first — this is
reported fixed in VS Code 1.111+ — then, if it still fails, override the launch
command for the host you are on:

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

An absolute path to `npx.cmd` works too. Both are community workarounds rather
than vendor-endorsed fixes — the upstream VS Code issue was closed without a
documented fix — so treat them as a fallback after upgrading, and keep the
change machine-local. (This bundle's own source repo runs an MCP-parity gate
comparing `command` exactly across the two config files, so a committed
Windows-only override there needs a declared exception; your repo has no such
constraint.)
