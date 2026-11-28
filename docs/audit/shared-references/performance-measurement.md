---
summary: Budgets as percentile × factor, CPU-time guards, browser step timings, a load-harness recipe.
---

# Performance Measurement

How to measure a performance claim so the number means something, and how
`/persona-test` and `/click-test` time the steps they already take. This is a
method, not a tool: CES ships no load harness, no profiler and no
performance gate. Every rule below came from a measured miss.

This is the canonical copy. Consuming skills carry a `references/performance-measurement.md`
synced by `node scripts/sync-shared-audit-refs.mjs` and drift-checked in
`npm run check`. **Edit this file, never a copy.**

## 1. A budget is a measured percentile times a stated factor

A budget is `round(measured pNN × factor)`, written down with what was
measured, when, and the triggers that make it stale. A guessed number is not a
budget, nor is a single run; a sourced objective (an SLO, a customer
requirement) is a target to measure against, not yet a budget.

- Measure the percentile (p50 typical, p90 user-facing, p99 a promised tail)
  over enough runs to be stable — run it twice and compare first.
- State the factor and why (1.5× headroom on a shared host is common).
- Name the **re-measure triggers** (a new query on the path, a dataset 10×
  larger, a runtime upgrade, a host change), or the budget outlives what it measured.

`step-timing-contract.json` enforces the equation: `budgetMs` must equal
`round(basis.measuredMs × basis.factor)`, and `remeasureWhen` needs ≥1 entry.

## 2. Guard an algorithm with CPU time, not wall time

On a shared machine wall time measures the neighbours. A test guarding "this
stays linear" times `process.cpuUsage()` (or counts operations), with an
input big enough that the quadratic version is unmistakable — a regex
re-scanning all earlier text went from 59 s to 0.24 s once fixed; a guard at
2× the fixed cost catches the regression with room to spare.

## 3. Before/after: interleave on one machine, under a lease

Run A, B, A, B … on the same machine in one session, never "before today,
after tomorrow". Hold the machine's shared lease (no concurrent test suite or
build) for the whole series. Report each arm's median and spread; a
difference inside the spread is no difference.

## 4. See the guard fail on its injected defect

A performance guard is trusted only after it has failed: re-inject the slow
version (the per-row prepare, the inverted timeout, the unbounded read), watch
the guard go red, remove it, watch it go green. A guard that has never failed
may be measuring nothing.

## 5. Assert the workload's size

The test asserts the input it ran on — row count, bytes, token count — before
it asserts the time. A fixture that shrank to 10 rows passes every budget. The
same holds in production telemetry: a latency figure without its payload size
cannot be compared across runs.

## 6. Warm cold dependencies first

The first call pays for connection setup, JIT, a cold cache or a sleeping
service. Discard warm-up runs and say how many; or, when cold start IS the
thing measured, say so and measure only that.

## 7. Step timings in /persona-test and /click-test

The skill times every step it takes in the live app, inside the page. Where a
driver round-trip cannot be excluded, the reading is an upper bound (below).

**Flow.** (1) `node scripts/cross-skill.mjs step-timing-ready --json '{}'`
(add `"contractPath"` for a non-default contract) returns the ready settings
and a `contractDigest` — defaults `{selector: null, quietMs: 500, timeoutMs:
10000}` when the app declares none (`selector: null` means `document.readyState
=== 'complete'`); click-test's `--ready-selector` / `--ready-timeout` override
the returned values. On a non-zero exit, measure with the defaults and keep the
error for the report. (2) Time each step (below). (3) Write
`{steps, attemptedIds, ready, contractDigest}` (plus the same `contractPath`
as step 1, if any) to a file — `ready` is the settings you actually measured
with, after any override — and pipe it to
`node scripts/cross-skill.mjs judge-step-timings --stdin`. Render its output; on
a non-zero exit render `STEP TIMINGS — unmeasured (judge refused: <message>)`
and finish the run anyway.

**Step entry**: `{id, route, kind: "navigate"|"action", durationMs,
unmeasuredReason?}` — `route` is the pathname (no query or hash). One entry per
navigation or action ATTEMPTED, failures included. `attemptedIds` is the id of
every attempt from the skill's own log, kept apart from the entries
(persona-test: one per Act step, `stepCount.completed` of them; click-test:
one per route navigation attempted per device plus one per trigger
attempted); an attempt with no entry reads `missing`, an entry with no
attempt is refused. A step carrying an `unmeasuredReason` is unmeasured
whatever its duration.

**Navigate step**: the moment navigate returns, `evaluate` ARM, then WAIT with
`START = 0` (the document's own clock starts at its navigation).
**Action step**: `evaluate` ARM just before the action and keep the epoch it
returns; act; WAIT with `START` = that epoch. Both ends are epoch, so an
action that loads a new document is timed from the action to ready there —
run ARM again in the new document before WAIT.

```js
// ARM — before an action; idempotent. Returns the epoch start.
(() => {
  const w = window;
  if (!w.__stTrack) {
    w.__stTrack = { gen: 0, inflight: 0, last: performance.now() };
    const t = w.__stTrack, bump = () => { t.last = performance.now(); };
    // A request belongs to the arm generation it started in; an older one never touches the count or the clock.
    const start = () => { t.inflight++; bump(); return t.gen; };
    const end = (g) => { if (g === t.gen) { t.inflight--; bump(); } };
    const f = w.fetch;
    w.fetch = function (...a) { const g = start();
      return f.apply(this, a).finally(() => end(g)); };
    // fetch resolves on HEADERS: count the body read too (same microtask turn, so no gap).
    for (const m of ['text', 'json', 'arrayBuffer', 'blob', 'formData']) {
      const o = Response.prototype[m];
      Response.prototype[m] = function (...a) { const g = start(); return o.apply(this, a).finally(() => end(g)); };
    }
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...a) { const g = start();
      this.addEventListener('loadend', () => end(g), { once: true });
      return send.apply(this, a); };
    new MutationObserver(bump).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  const t = w.__stTrack;
  t.gen++; t.inflight = 0; t.last = t.armedAt = performance.now();
  return performance.timeOrigin + performance.now();
})()
```

```js
// WAIT — resolves {durationMs} or {unmeasuredReason}. Substitute SELECTOR
// (a JSON string or null), QUIET_MS, TIMEOUT_MS, START (0 for navigate, the
// arm epoch for action). Re-run ARM first in a new document.
new Promise((resolve) => {
  const t = window.__stTrack, t0 = performance.now();
  if (!t) return resolve({ unmeasuredReason: 'no-in-page-timing' }); // ARM did not run here
  const ready = () => (SELECTOR ? !!document.querySelector(SELECTOR) : document.readyState === 'complete');
  let readyAt = null;
  const tick = () => {
    const now = performance.now();
    if (now - t0 > TIMEOUT_MS) return resolve({ unmeasuredReason: 'timeout' });
    if (!ready()) readyAt = null; else if (readyAt === null) readyAt = now;
    if (readyAt !== null && t.inflight === 0 && now - t.last >= QUIET_MS) {
      // Activity after arming moves the end; the arm itself does not.
      const settled = Math.max(readyAt, t.last > t.armedAt ? t.last : 0); // when the page last changed
      const end = START ? performance.timeOrigin + settled : settled;
      return resolve({ durationMs: Math.round(end - START) });
    }
    setTimeout(tick, 25);
  };
  tick();
})
```

The time ends where the page last changed (ready became true, or the last
request or mutation after arming), not where the quiet window closed; polling
adds up to 25 ms. A step already settled at WAIT's first look (a navigate, or an action
that finished before the driver returned) uses that look — an **upper bound**
that includes the driver's return, so it reads long, never short, and never
turns an over-budget page green (a late WAIT reads slow).
Activity: `fetch`, XHR, body reads, every DOM mutation. Not counted: images,
scripts, styles, WebSocket/SSE, `body.getReader()` streams. A page that never
stops mutating reads `timeout`.

**Known limit**: a request a new document fires before ARM runs is not
counted (its render still is). With an init-script hook (Playwright's
`addInitScript`) install ARM there; otherwise use a ready selector the page
sets only once its data has rendered.

**Unmeasured, never guessed**: bound hit → `timeout`; navigation error →
`navigation-failed`; no `evaluate` in the driver, or wrapping refused →
`no-in-page-timing`; page error during the wait → `page-error`; send
`durationMs: null` with the reason. The judge reads a step with no duration
as `unmeasured`, and the run as `unmeasured` if any step is, if any attempt
was not sent (`missing`), or if there were none — `within-budget` only when
every step was sent, timed and budgeted (an over-budget step in an incomplete
run still shows in `counts`). Without a contract the times are `reported`
only, and so are times measured with ready settings other than the
contract's (`readyOverridden: true`): a budget holds only for the predicate it
was measured under.

**The report section** lists each step (`id route kind ms budget status`),
then `overall` and the counts. One sample against a p90 budget is a reason to
measure again (§1), not a regression verdict — say so in the section.

**The contract** (`step-timing-contract.json` at the repo root; the commands
load it, refuse a sensitive or escaping path, and never return its text):

```json
{
  "version": 1,
  "ready": { "selector": "[data-app-ready]", "quietMs": 500, "timeoutMs": 10000 },
  "budgets": [
    { "route": "/wines*", "kind": "navigate", "budgetMs": 1800,
      "basis": { "percentile": "p90", "measuredMs": 1200, "factor": 1.5,
                 "measuredAt": "2026-11-20", "remeasureWhen": ["new list query", "dataset 10x"] } }
  ]
}
```

A route is exact or ends in one `*` (prefix); an exact route beats every
prefix, the longest prefix wins, and two budgets for one `(route, kind)` are
refused. `timeoutMs` must be at least `quietMs + 1000`, or an idle page could
never settle before its bound. The judge's output carries each matched
budget's percentile, measured value, factor and date — not `remeasureWhen`.

## 8. Load-harness recipe (a recipe — CES ships no harness)

When a plan names concurrent users, a pilot, a load test or a latency target,
the plan states its budget per §1 and, if it needs a load test, builds one to
this recipe in the app's own repo:

- **One isolated browser context per virtual user** (own cookies and storage),
  **ramped up** in steps, never all at once — a step change hides where the
  knee is.
- **A ready predicate and an action-correlated settle** per step, as §7: time
  to "the user can act", not to the `load` event.
- **Report p50, p90 and p99** per step and per ramp level, with the sample
  count beside each.
- **A timeout is a failure**, counted in the error rate — never dropped from
  the percentile, which would make a saturated system look fast.
- **Exit non-zero when a budget is exceeded**, so CI and a person read the
  same verdict.
- **Refuse production**: the harness takes an allowlist of test hosts and
  exits on anything else.
- **Sign-in is left to a person**: the harness reuses a saved session state a
  person created for a test account; it never types credentials.
