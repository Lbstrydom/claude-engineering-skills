---
name: ux-lock
description: |
  Generate Playwright e2e specs. Two modes:
    1. LOCK mode — pin a fix's DOM contract so it doesn't regress (default).
    2. VERIFY mode — check that a /plan-frontend plan was actually implemented
       by parsing its Acceptance Criteria (Section 9) and driving the live URL.
  Triggers on: "ux lock", "lock ux", "lock in the fix", "write regression spec",
  "generate e2e test for", "regression test for commit", "lock this fix",
  "verify the plan", "verify plan implementation", "check the plan was built",
  "audit frontend implementation", "did we ship the plan".
  Usage:
    /ux-lock <commit-or-description> [--url <base-url>]                     — lock mode
    /ux-lock verify <plan.md> [--url <base-url>]                            — verify mode
  Examples:
    /ux-lock "modal closes before retry"
    /ux-lock abc1234
    /ux-lock "role=list on wine grid" --url https://myapp.railway.app
    /ux-lock verify docs/plans/cellar-grid-redesign.md --url https://myapp.railway.app
---

# UX Lock — Playwright Spec Generator & Plan Verifier

Two modes, one skill. Both drive Playwright against semantic DOM contracts.

- **LOCK mode** (default): generate an e2e spec that pins a fix's DOM contract.
- **VERIFY mode** (`verify <plan.md>`): parse the plan's Acceptance Criteria
  (Section 9 of a `/plan-frontend` plan) and run one assertion per criterion
  against the live URL — producing a pass/fail grade for the plan.

Read the first word of `$ARGUMENTS`:

- `verify` → **Mode: VERIFY**
- otherwise → **Mode: LOCK**

---

## DOM-contract rule (both modes)

The spec must assert on **public DOM contracts**, not implementation details:

| Good assertions (stable) | Bad assertions (brittle) |
|---|---|
| Element with `role="list"` exists | Element has class `wine-list-v3` |
| Modal closes when action button clicked | Internal state variable changes |
| Button is `aria-disabled` when form invalid | CSS opacity is 0.5 |
| Navigation to `/cellar` shows grid | `document.querySelector('.grid-abc')` |

**Rules**:
- Assert on semantic HTML (`role`, `aria-*`, `data-testid`) — never CSS classes
- Assert on user-visible behaviour (click → result) — never internal state
- Assert on accessibility (axe-core) when the fix touched a11y

---

## Mode: LOCK

### Step 0 — Understand the fix

1. If a commit hash is provided, read the commit message and diff:
   ```bash
   git show <hash> --stat
   git show <hash>
   ```
2. Extract: what was broken, what was fixed, which files changed, which
   DOM elements are involved.
3. If a description is provided instead, ask clarifying questions only if
   the DOM contract is ambiguous.

### Step 1 — Check existing harness

```bash
ls tests/e2e/helpers/        # auth, axe helpers
cat playwright.config.*       # base URL, projects, timeouts
ls tests/e2e/*.spec.*         # existing specs for naming convention
```

If no Playwright setup exists, offer to bootstrap from the template.
See `references/scope-and-limitations.md` for the bootstrap commands.

### Step 2 — Generate the spec

Use the template + fix-type assertion map in
`references/lock-mode-spec-generation.md`. One file per fix, named
`tests/e2e/<ticket-or-round>-<description>.spec.js`.

### Step 3 — Run + record (deterministic — ONE call)

The spec is authored (Step 2). Execution and recording are now a single
deterministic call — the runner runs `npx playwright test`, parses the JSON
report from a file (never stdout), and writes BOTH the `regression_specs` and
`regression_spec_runs` rows itself. This replaces the old model-remembered
sequence (run → hand-parse → `record-regression-spec` → `record-regression-spec-run`)
that left the tables empty whenever a step was skipped or mis-parsed:

```bash
node scripts/ux-lock-run.mjs spec \
  --spec tests/e2e/<new-spec>.spec.js \
  --commit <sha> --run-context ux-lock \
  --source-kind manual [--url <base-url>]
```

- **Auto-registers** the spec (upsert by `repo_id` + `spec_path`, supplying the
  required `source_kind` + a derived `description`) and records this run's
  pass/fail + duration. `--no-register` skips registration (records nothing).
- **Exit code reflects test pass/fail** — non-zero means the spec failed, so you
  (and `/ship`/CI) see it. A *failing* run is still recorded as `passed:false`
  (not silently dropped).
- **Graceful**: cloud off → runs + prints, skips recording with a hint;
  Playwright missing → exit 5 (install hint); malformed report → hard error.
- No hand-parsing, no shell-quoting of free text (the runner owns the writes).

If the spec itself fails for environment reasons, debug: base URL via
`E2E_BASE_URL` (the runner sets it from `--url`); auth via `E2E_BEARER_TOKEN`;
timing via `await page.waitForSelector(...)`. `source_kind` selection +
multi-spec (`--specs`) details: `references/lock-mode-spec-generation.md`.

### Step 5 — Report

```
═══════════════════════════════════════
  REGRESSION SPEC — Created
  File: tests/e2e/<name>.spec.js
  Assertions: <n>
  Passes: ✓ chromium-desktop, ✓ chromium-mobile
  Recorded: spec-id <uuid> (source: <sourceKind>)
═══════════════════════════════════════
```

Omit the `Recorded:` line when cloud mode is off.

---

## Mode: VERIFY

Grade a `/plan-frontend` plan against its live implementation. Each
criterion in Section 9 becomes one Playwright `test()`; per-criterion
outcomes are recorded with a stable `criterion_hash` for time-series
tracking across verify runs.

### Step V0 — Parse the plan

Read the plan at the path in `$ARGUMENTS` (first positional after
`verify`). Parse Section 9 using `scripts/lib/plan-criteria-parser.mjs`.

If `found = false` → plan has no Acceptance Criteria; offer to add Section 9.
If `errors.length > 0` → print + stop (malformed criteria).

Register the plan → capture `planId`.

### Step V1 — Resolve base URL

Priority: `--url` flag → `E2E_BASE_URL` → `PERSONA_TEST_APP_URL` → ask.

### Step V2 — Generate one spec, N tests

Create `tests/e2e/verify-<plan-slug>.spec.js` with one `test()` per
criterion, using the translation-rules table.

Full template + translation rules + persistence protocol:
`references/verify-mode-generation.md`.

### Step V3–V5 — Run + record (deterministic — ONE call)

After authoring the verify spec (one `test()` per criterion, each carrying its
`criterion_hash` as an annotation — see the reference), run + record in one
deterministic call. The runner runs the spec, maps each test result back to its
criterion via the `criterion_hash` annotation, and writes the
`plan_verification_runs` + `plan_verification_items` rows itself — replacing the
old model-remembered run → parse → `record-plan-verify-run` →
`record-plan-verify-items` sequence:

```bash
node scripts/ux-lock-run.mjs verify \
  --plan docs/plans/<plan>.md --spec tests/e2e/<verify-spec>.spec.js \
  --plan-id <plan-uuid> --commit <sha> --url <base-url>
```

- **Every criterion is accounted for** (plan §2.3): a criterion with no matching
  test → `passed:false` ("no matching test result"); multiple results for one
  hash → fail if ANY failed; a test with no expected criterion (orphan) is
  logged + counted but NOT inserted (the items table is strictly
  per-expected-criterion).
- The `criterion_hash` is recomputed from the plan by the runner (via
  `plan-criteria-parser.mjs`), so it matches the authored spec's annotation
  exactly. Pass `--plan-id` (the `plans` row UUID) or the run is not recorded.
- **Graceful**: cloud off → runs + prints, skips recording; Playwright missing →
  exit 5. **Verify is a report, not a blocker** — it exits 0 even when criteria
  fail (gating is `/ship`'s job via the status rubric + `plan_satisfaction`); a
  non-zero exit means the spec could not RUN (PW missing / fatal), not that a
  criterion failed.

The verify-spec template MUST emit each test with
`{ annotation: [{ type: 'criterion_hash', description: '<hash>' }] }` — naming
the test by prose is NOT enough (the hash can't be recovered from a title).
Full template + translation rules: `references/verify-mode-generation.md`.

### Step V6 — Report

Emit the satisfaction summary with pass/fail counts per severity + the
list of failing P0 criteria. Status rubric: `PLAN_SATISFIED` (all P0+P1
pass) / `PLAN_PARTIAL` / `PLAN_NOT_SHIPPED` (≥1 P0 fails). Template in
`references/verify-mode-generation.md`.

### Failure policy

Verify exits 0 even on fail — it's a report, not a blocker. To gate
shipping, `/ship` reads `plan_satisfaction.failing_p0_criteria` via
`cross-skill.mjs plan-satisfaction --plan-id <id>`.

---

## When to use this skill

- **After /audit-loop convergence**: lock in the fixes before moving on
- **After a /persona-test P0 fix**: prevent recurrence
- **After any production bug fix**: before closing the issue
- **Before a major refactor**: baseline the current behaviour
- **After /plan-frontend implementation**: `verify` mode grades the implementation

---

## Integration with other skills

- **/audit-loop** converges → **/ux-lock** locks in fixes
- **/persona-test** finds P0 → fix → **/ux-lock** prevents recurrence
- **/ship** warns if recent fixes lack regression specs
- **/plan-frontend** produces Section 9 → **/ux-lock verify** grades implementation

---

## Scope + limitations

Works for web apps served via URL. Limited for Obsidian/Electron apps,
CLI tools, and anti-bot-protected URLs. Full guidance:
`references/scope-and-limitations.md`.

---

## Reference files

This skill's canonical flow is above. The files below cover specialised
situations — read them only when the trigger applies.

| File | Summary | Read when |
|---|---|---|
| `references/lock-mode-spec-generation.md` | LOCK mode — full Playwright spec template + fix-type assertion map + persistence recipe. | Mode: LOCK, about to write the spec body OR register it. |
| `references/verify-mode-generation.md` | VERIFY mode — criterion parser wiring, translation rules, per-criterion run+record protocol. | Mode: VERIFY, Steps V0–V6 (parsing, generating, running, recording). |
| `references/scope-and-limitations.md` | Where /ux-lock works well, where it doesn't (Obsidian/Electron), and fallback strategies. | Target is an Obsidian plugin / Electron app / CLI / anti-bot-protected URL, OR bootstrapping Playwright harness from scratch, OR user is on Windows and Playwright MCP tools aren't appearing. |
