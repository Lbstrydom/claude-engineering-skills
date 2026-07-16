# Persona-test consistency mode — adoption playbook

Distilled from the wine-cellar-app Phase 1 adoption (rounds 1–7,
~6 hours total, 7 surfaces annotated, 2 canaries deployed, 1 real
product bug + 1 upstream rig bug surfaced). This playbook compresses
that experience into a 10-step linear sequence so the next adopter
(e.g. ai-organiser) lands at the same outcome in **≤2 hours**.

Companion docs:
- [docs/reference/consistency-contract.md](../reference/consistency-contract.md) — the attribute contract
- [./template-surfaces.json](./template-surfaces.json) — minimal manifest
- [./template-canary.json](./template-canary.json) — minimal canary

---

## The 10 steps

### 1. Install Playwright

```bash
npm install playwright
npx playwright install chromium
```

One-time. The rig drives Playwright directly (NOT MCP); installs are
needed in both the dev machine and CI environments.

---

### 2. Pick ONE state-rendering surface to annotate first

**Recommended starting point: your app's persistent status chip / banner.**

A status chip is the ideal first surface because:
- Single element, single engine field (low cognitive load)
- Visible on every authenticated view (the canary doesn't need a deep journey)
- Projects an enum that's easy to verify by eye

Resist the temptation to annotate everything at once. The first run will
surface adoption friction you couldn't predict — fix the contract on ONE
surface, then expand.

---

### 3. Annotate the surface render site

Add the three attributes to the rendered element on EVERY state branch:

```js
el.setAttribute('data-engine-claim', 'stateV2');
el.setAttribute('data-engine-value', String(stateV2 ?? 'unavailable'));
el.setAttribute('data-freshness',
  freshness === 'stale' ? 'stale' : 'current');
```

**The null-grounded rule** (most common adoption mistake — wine-cellar
round 7): when the engine value is unknown (loading, no data yet) →
`data-engine-value=""` + `data-freshness="absent"`. When the engine has
a real value of `0` (or empty / null result) → `data-engine-value="0"`
+ `data-freshness="current"`. The two are DIFFERENT semantics; the rig
distinguishes them.

If your surface has a hidden/empty branch, annotate it too — per
contract, even hidden surfaces declare their no-claim state.

---

### 4. Pick a stable locator

`data-engine-claim` declares WHAT the surface projects; the manifest's
`locator` declares HOW to find it. Order of preference:

| Locator | Recommended for |
|---|---|
| `{kind:'id', id:'X'}` | Surface has a stable HTML id (most common) |
| `{kind:'testid', id:'X'}` | Surface has a stable `data-testid` |
| `{kind:'role', role:'X', name:'Y'}` | ARIA-labelled element |
| `{kind:'label', text:'X'}` | Form labels |
| `{kind:'css', selector:'X'}` | Last resort — emits a P2 "prefer semantic" warning |

CSS locators work but emit `css-locator-prefer-semantic` warnings on
every canary run. Wine-cellar round 6 added `kind:'id'` after the
default `testid` couldn't target HTML id elements cleanly — bonus from
that round, available to you.

---

### 5. Author surfaces.json

Copy [`template-surfaces.json`](./template-surfaces.json) to
`<your-repo>/.persona-test/surfaces.json`. Replace the starter content
with YOUR surface's actual locator + engineField + networkSource.

**Get the `urlPattern` right.** Open devtools network tab, find the
response your surface reads from, copy the URL (or a regex that matches
it). The `jsonPath` is the field within that response — dotted notation
(`a.b.c`) for nested, `[]` notation for collection arrays.

---

### 6. Author a canary

Copy [`template-canary.json`](./template-canary.json) to
`<your-repo>/.persona-test/canaries/first-canary.json`. Adapt the
`routes` + `journeySteps` to navigate to the view where your annotated
surface renders.

**For auth-walled apps** (wine-cellar round 2 footgun — most real SPAs):
do NOT use `authBootstrap: {kind: 'none'}` — your canary will land on
the public landing page and the chip will never mount. Use:

- `kind: 'storageState'` — pre-seeded auth cookies/localStorage. Run
  `npx playwright codegen <url>`, sign in manually, save the storage
  state to `.persona-test/storage-states/authed.json`. Programmatic
  seeding works too — see wine-cellar's `scripts/seed-storage-state.mjs`.
- `kind: 'token'` — bearer-token auth via env var. Simpler if your API
  accepts `Authorization: Bearer <token>` and the SPA doesn't need
  pre-existing localStorage state.

---

### 7. Run the canary against staging or prod

```bash
node scripts/persona-consistency-run.mjs \
  --canary first-canary \
  --url https://your-staging-url
```

Possible exit codes:
| Code | Meaning |
|---|---|
| 0 | Healthy — canary expectations met |
| 2 | Broken — canary's `expectedContradictions` not met (e.g. `min:1` but found 0). Check ledger; may mean your annotation isn't deployed yet OR the rig found a real bug. |
| 3 | Fatal — manifest invalid, Playwright disconnected. Check error. |
| 5 | Playwright not installed. Run `npx playwright install chromium`. |
| 6 | App-error — journey couldn't walk (e.g. element timed out). Check stepFailureReason in ledger. |

Read the session ledger at `.persona-test/sessions/<sid>.json` for the
full witness + contradictions.

---

### 8. Fix what the first run surfaces

Likely first-run findings (wine-cellar saw them all):

| Finding | Fix |
|---|---|
| `unannotated-surface` | Your locator matched an element but the element has no `data-engine-claim`. Either: (a) you forgot to annotate (most likely); (b) the branch you forgot to annotate (loading/hidden/error); (c) the annotation is in code you haven't deployed yet. |
| `missing-surface` | The locator matched ZERO elements on the page. Either the surface doesn't render in this view (use `appliesTo.routePattern`) OR the journey hasn't reached the right state yet (add a `wait` step). |
| `value-mismatch` | The DOM value AND the engine value disagree — this is the rig doing exactly what you built it for! Investigate the divergence. |
| `stale-projection` | DOM declares `data-freshness="stale"` + the surface is visible. Real cross-time inconsistency. Investigate WHY the surface's data is stale. |
| `manifest-network-await-timeout` warning | The rig waited (default 3s) for your declared `networkSource.urlPattern` but didn't see it fire. Either your endpoint is slow (bump `awaitTimeoutMs` on the source) OR the journey didn't trigger it. |

---

### 9. Wire CI

After 2-3 successful local runs, add a workflow to run the canary on
every push + on a schedule. Reference wine-cellar's pattern:
`/.github/workflows/consistency-canary.yml` in that repo.

Key gotchas (wine-cellar round 7):

- **PR pre-merge gating is incoherent** when the canary runs against
  the deployed prod URL — the PR's code isn't deployed yet. Use
  POST-DEPLOY monitoring on main + schedule instead. PR pre-merge
  gating requires Railway PR-preview deploys + a `/api/version`
  build-id endpoint (deferred work for most adopters).
- **Add a baseline allowlist** at `.persona-test/baseline.json` for
  known on-going conditions you don't want flapping every CI run.
  30-day TTL per entry — prevents the allowlist becoming a graveyard.
- **Read-only canary contract** — every `click` step must carry
  `readOnly: true`. Destructive clicks (apply, delete) are rejected
  at canary load time. Avoids polluting prod.

---

### 10. Iterate — expand to ≤7 surfaces, then stop

Wine-cellar landed at 7 annotated surfaces covering 6 of 8 historical
bug classes. Recommended Phase 1 stopping point: cover the **6 most
load-bearing** state surfaces in your app, then operationalise.

Annotating every surface is **unbounded**. The 80/20 is the load-bearing
ones — typically chip / banner / status indicators + a count or two.
Stop when:

- Your last 3 canary runs found only known-baseline findings
- Adding more surfaces stops surfacing new bug classes
- CI has run green-or-baseline-only for ≥7 consecutive days

Then declare Phase 1 complete. Phase 2 (more surfaces, PR pre-merge
gating, semantic-prose comparison) becomes its own plan.

---

## Round-by-round gotchas log (wine-cellar, 2026-05)

Rounds 1–7 each surfaced specific friction. The fixes landed in this
upstream's commits below; you inherit them all. Listed here so you
understand WHY the rig has the shape it does — and what to look out
for in case any of these regress in your environment.

### Round 1 — first run
- **Schema couldn't target HTML `id`** without falling back to `css` locator + warning. **Fixed**: added `kind: 'id'` to the locator discriminator.
- **Locator string mangled** with a `.` prefix on every selector. **Fixed**: capture lib no longer prepends `.`.
- **`css-locator-prefer-semantic` was emitted as `value-mismatch` P0** (wrong kind). **Fixed**: moved to `step.warnings[]` with `RigWarningKind: 'css-locator-prefer-semantic'`.
- **`appliesTo.requiresState` field accepted by schema but ignored** by diff engine. **Fixed in round 7**: `activeStateTags` now derived by the runner from chip-style domClaims.

### Round 2 — auth-walled SPAs
- **`authBootstrap: {kind:'none'}` template default lands on public page** for any auth-walled app. **Fixed**: docs/reference/consistency-contract.md gained "Auth-walled surfaces — the first-run footgun" section.
- **3000ms default network-await too short for real SPA endpoints** that do real computation. **Fixed**: bumped default; per-source override via `awaitTimeoutMs`.

### Round 3 — staged rollout
- **`expectedContradictions: {min: 1}` self-test trivially satisfied** by rig-internal findings (locator warnings). **Fixed**: only real-state contradictions count toward `min`.
- **`unannotated-surface` vs `missing-surface` was conflated** — both fired the same kind when a locator matched but no attribute. **Fixed**: distinct kinds; unannotated-surface message walks 3 root causes (not annotated / not deployed / typo).

### Round 4 — first deploy
- **Annotation in local source but not on prod URL** = silent `missing-surface` finding that looked like rig confusion. **Fixed**: unannotated-surface message explicitly mentions deploy gap as a root cause.

### Round 5 — stale-tolerant chips
- **`severityFloor: P0` for SWR-style chip** fires P0 on every page load (intentional stale = P0 noise). **Resolution**: docs/reference/consistency-contract.md severity-floor table clarifies P1 for documented stale-tolerant UX.

### Round 6 — multi-step canary
- **Hidden DOM elements with `hidden=""` attr` but matching locator** fired `unannotated-surface` even when the JS code was on a different render path. **Fix on adopter side**: annotate ALL render branches (visible AND hidden) with the contract attributes.
- **Cross-surface divergence detected** — chip says `major` while CTA card hides itself (slow `/analyse` data). **Fix on adopter side**: derive the slow surface's loading shell from the fast surface's state. See docs/reference/consistency-contract.md §Cross-surface loading derivation.

### Round 7 — operationalisation
- **`appliesTo.routePattern` honoured ONLY on missing-surface path**, not on unannotated-surface path. **Fixed in upstream commit 777c03e**: `detectUnannotatedSurfaces` now calls `appliesToCurrent` before the locator probe.
- **`requiresState` field accepted but `activeStateTags` never populated**. **Fixed in same commit**: runner derives `activeStateTags` from any chip-style domClaim (engineField ∈ stateV2/state/mode/status).
- **Stale-projection P1 fires on every page load** for cellars in mid-recompute state. **Adopter fix in WS1a**: on-read lazy recompute self-heals divergent-stale projections.
- **Chip refresh() inflight race** dropped revision bumps mid-flight. **Adopter fix**: `_pendingRevision` snapshot + convergence re-fire in finally-block.

If you hit a NEW class of friction not listed above — **open an
upstream issue against `claude-engineering-skills`**. That's how the
rig got this good in 7 rounds.

---

## You'll know it's working when…

- A canary run produces a session ledger with `domClaims` AND
  `networkClaims` both populated (rig sees both sides)
- The ledger's `contradictions[]` is empty OR contains only conditions
  you can explain
- A repeat run against the same prod state produces the same ledger
  (deterministic; idempotency-replay works)
- `baseline-check` reports `✓ all findings are within the baseline
  allowlist` on the CI runs

You're at parity with wine-cellar after round 7. From here, the only
remaining work is adding more surfaces and watching the 7-day green
streak.
