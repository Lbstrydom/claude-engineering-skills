---
summary: VERIFY mode — criterion parser wiring, translation rules, per-criterion run+record protocol.
---

# VERIFY Mode — Plan Verification Protocol

VERIFY mode grades a `/plan` plan against its live implementation
by parsing its Acceptance Criteria section, generating one Playwright
`test()` per criterion, running the spec, and recording per-criterion
outcomes keyed by stable `criterion_hash` for time-series tracking.

## Step V0 — Parse the plan

Read the plan file at the path in `$ARGUMENTS` (first positional after
`verify`). Parse the Acceptance Criteria section via the shared parser. Set the plan path in a
variable first — never paste free-form values inline into the JS string
(command-template injection + PowerShell reserves `<`/`>`, so placeholder
commands can't even be pasted):

```bash
node scripts/lib/plan-criteria-parser.mjs "$PLAN"
```

Set `PLAN` to the plan path first (`export PLAN=…`; PowerShell:
`$env:PLAN='…'`). Passing the path as an
argument keeps free-form values out of a JS string — and the command form is
what the consumer sync can relocate, which an `import '…/scripts/lib/…'`
specifier inside `node -e` is not.

Returns `{ criteria: [...], errors: [...], found: boolean }`.

- `found = false` → tell the user the plan has no Acceptance Criteria
  section; offer to run `/plan` to add one, or have them add it manually.
- `errors.length > 0` → print and stop — malformed criteria need fixing
  first.

Register the plan:

```bash
node scripts/cross-skill.mjs upsert-plan --json '{
  "path": "<plan-path>",
  "skill": "plan",
  "status": "in_progress"
}'
```

Capture `planId`.

## Step V1 — Base URL resolution

Priority: `--url` flag → `E2E_BASE_URL` → `PERSONA_TEST_APP_URL` → ask.

## Step V2 — Generate one spec, N tests

Create `tests/e2e/verify-<plan-slug>.spec.js` (slug = lowercased plan
filename without extension, hyphens only).

Template:

```javascript
import { test, expect } from '@playwright/test';
import { loginAsTestUser } from './helpers/auth.js';
import { expectNoA11yViolations } from './helpers/axe.js';

/**
 * Plan verification — generated from <plan-path>
 * Plan ID: <planId>
 * Criteria: <N> total (<p0> P0, <p1> P1, <p2> P2, <p3> P3)
 * DO NOT HAND-EDIT — regenerated each time /ux-lock verify runs.
 */

test.describe('Plan verify: <plan-slug>', () => {
  <for each criterion c, emit>
  test(`[${c.severity}] [${c.category}] ${c.description}`, {
    tag: [`@${c.severity}`, `@${c.category}`, '@plan-verify'],
    // REQUIRED — the deterministic runner (scripts/ux-lock-run.mjs verify) maps
    // each test result back to its plan criterion by this annotation. Naming the
    // test by prose is NOT enough: the hash can't be recovered from the title.
    // `<c.hash>` is the parser's criterion_hash (sha256(SEVERITY|category|description)[:16]).
    annotation: [{ type: 'criterion_hash', description: '<c.hash>' }]
  }, async ({ page }) => {
    // Setup: <c.setup ?? 'direct navigation'>
    await page.goto('/');
    <translate c.setup text into Playwright actions>

    // Assert: <c.assertion ?? c.description>
    <translate c.assertion text into expect(...) calls>
  });
  <endfor>
});
```

## Translation rules (critical)

The quality of verification depends on honest translation. Every `locator` below
is built via the selector ladder — `getByRole` → `getByLabel`/`getByPlaceholder`
→ `getByText` → `getByTestId` → justified-structural CSS as last resort with the
`// selector-policy: structural — <reason>` marker (same policy as LOCK mode; the
runner lints the generated spec).

| Assertion hint contains | Emit |
|---|---|
| `getByRole(...)` literal | Keep as-is in the spec |
| `axe-core` / `WCAG` / `violations == 0` | `await expectNoA11yViolations(page, { include: '[data-testid="…"]' })` (or a justified-structural include) |
| `viewport` / `<N>px` / `mobile` / `desktop` | `await page.setViewportSize({ width: <N>, height: ... })` before other actions |
| `visible` / `shown` | `await expect(page.getByRole(…)).toBeVisible()` |
| `hidden` / `not visible` | `await expect(page.getByRole(…)).toBeHidden()` |
| `click` / `press` / `submit` | `await page.getByRole('button', { name: … }).click()` |
| `count == N` / `has N items` | `await expect(page.getByRole('listitem')).toHaveCount(N)` (or the criterion's named container) |
| `role=` / `aria-*=` | `getByTestId(…)` → `toHaveAttribute(<name>, <value>)` |
| `text matches` / `contains` | `toHaveText(/.../i)` or `toContainText(/.../i)` |

If a criterion can only be expressed via a class selector and the implementation
is in-repo, prefer adding a semantic hook (SKILL Step 1.5 ladder: native
semantics → `data-testid` → accurate ARIA only). If no hook can be added, flag
the criterion as un-verifiable in Step V5 and skip it rather than emitting a
brittle assertion — flagging it un-verifiable is legitimate; **dropping it
from the Step V6 report is not** (`references/verification-discipline.md` §7).

## Step V3 — Register the generated spec

> **Ownership split (so V3 and V4–V5 don't read as a contradiction):** V3
> registers the SPEC artefact (a `regression_specs` row — cross-skill CLI,
> below). The deterministic runner in V4–V5 owns the RUN rows
> (`plan_verification_runs` + `plan_verification_items`) and never registers
> verify specs itself. One registration, many runs.

```bash
node scripts/cross-skill.mjs record-regression-spec --json '{
  "specPath": "tests/e2e/verify-<plan-slug>.spec.js",
  "description": "Plan verification for <plan-path>",
  "assertionCount": <total criteria>,
  "domContractTypes": [<unique set of categories across the plan>],
  "sourceKind": "plan-verify",
  "sourceFindingId": "<planId from V0>",
  "sourceFindingType": "plan"
}'
```

Capture `specId`.

## Step V4–V5 — Run + record in ONE deterministic call

`scripts/ux-lock-run.mjs verify` runs the spec, re-parses the plan's criteria
(so the `criterion_hash` set matches the authored spec's annotations exactly),
maps each test result back to its criterion via the `criterion_hash`
annotation, and writes BOTH `plan_verification_runs` (totals) and
`plan_verification_items` (one row per EXPECTED criterion) — no manual run,
parse, `record-plan-verify-run`, or `record-plan-verify-items`:

```bash
node scripts/ux-lock-run.mjs verify \
  --plan docs/plans/<plan>.md \
  --spec tests/e2e/verify-<plan-slug>.spec.js \
  --plan-id <planId> --commit <sha> --url <baseUrl> --strict-selectors
```

Pass `--strict-selectors` — a verify spec is newly generated by this skill, so
the selector-policy lint should FAIL it (exit 6) rather than warn if the
generation slipped an unmarked structural selector through (same rule as LOCK
mode Step 3).

Coverage guarantees (the runner enforces them, plan §2.3):

- **Every expected criterion gets a row.** A criterion with no matching test →
  `passed:false`, `errorMessage:"no matching test result"`. Multiple results
  for one `criterion_hash` → fail if ANY failed. A duplicate expected hash is
  recorded once (warned).
- **Orphan tests** (a `test()` whose `criterion_hash` matches no parsed
  criterion) are logged + counted in the run summary but **NOT** inserted as
  items — the items table is strictly per-expected-criterion, so its time-series
  never gets a fabricated row.
- `--plan-id` is required to persist (the `plans` row UUID); without it the run
  prints but records nothing. Cloud off → run + print, skip recording. **Verify
  is a report, not a blocker** — it exits 0 even when criteria fail (consistent
  with the existing `/ux-lock verify` contract below; `/ship` gates via the
  status rubric + `plan_satisfaction`). A non-zero exit means the spec could not
  RUN (Playwright missing → 5, fatal → 3), not that a criterion failed.

This depends on the spec template emitting the `criterion_hash` annotation per
test (Step V2 above) — without it the runner cannot map results to criteria.

## Step V6 — Report

```
═══════════════════════════════════════
  PLAN VERIFY — <plan-path>
  Spec: tests/e2e/verify-<plan-slug>.spec.js
  URL:  <baseUrl>
  Commit: <commit-sha>

  Criteria: <N> total  (<passed> passed · <failed> failed · <skipped> skipped)
    P0: <passed>/<evaluated_p0> passing   (<skipped_p0> not evaluated)
    P1: <passed>/<evaluated_p1> passing   (<skipped_p1> not evaluated)
    P2: <passed>/<total_p2> passing
    P3: <passed>/<total_p3> passing

  Satisfaction: <pct>%   (<passed>/<total>)
  Status: <PLAN_SATISFIED | PLAN_PARTIAL | PLAN_NOT_SHIPPED>

  Failing P0 criteria (if any):
    ✗ [visibility] Cellar grid is visible after login
        Timeout 5000ms exceeded — getByRole('grid') never resolved
    ✗ [interaction] Wine card opens detail modal on click
        Expected dialog to be visible; found none

  Skipped P0/P1 criteria (if any — un-verifiable, NOT a failure, but not
  evaluated either; see the rubric below):
    ⊘ [interaction] Wine card supports drag-to-reorder
        No semantic hook available; flagged un-verifiable in Step V5
═══════════════════════════════════════
```

`evaluated = total − skipped`, per severity — a skipped criterion counts
toward neither `passed` nor `failed`, and the report says so explicitly
rather than shrinking the denominator silently.

**`Criteria: N total`'s per-severity split reports P0 and P1 both, since
either can carry skipped criteria** — a P0-only view left P1 skips invisible.
P2/P3 never carry a skipped-denominator split; they cannot affect the status
rubric (below), so the plain `passed/total` form is sufficient there.

**Zero-evaluated rendering**: when `evaluated_<severity> = 0` (every
criterion at that severity was skipped), render `not evaluated (0 evaluated;
N skipped)` in place of the `<passed>/<evaluated>` fraction — a bare `0/0`
reads as either total success or a calculation error, and it is neither.
This is a rendering rule only: the precedence table below already routes an
all-skipped severity to `PLAN_PARTIAL` without any special case, because
"zero skipped among P0/P1" (rule 3) fails whenever `skipped > 0`.

**Status rubric — a full, mutually-exclusive, first-match-wins precedence
table**, not three independent conditions:

1. `PLAN_NOT_SHIPPED` — any P0 criterion **FAILED** (evaluated, not passing).
2. `PLAN_PARTIAL` — not (1), AND (any P0 or P1 **SKIPPED**, OR any P1
   FAILED).
3. `PLAN_SATISFIED` — all P0 and P1 criteria evaluated (zero skipped among
   P0/P1) AND passing.

First match wins. A failed P0 always reads `PLAN_NOT_SHIPPED` regardless of
what else in the run is skipped — one criterion is exactly one of
passed/failed/skipped, so the coexistence question is about the run-level
*label* across different criteria, and precedence resolves it directly.
**P2/P3 skipped criteria never affect the label.**

**This label is model-emitted report prose — no script computes it, and it
is neither persisted nor parsed.** `/ship`'s gate reads
`plan_satisfaction.failing_p0_criteria` directly from the store (which
already excludes skipped items — see `supabase/migrations/
20260704120000_plan_verify_skipped.sql`), never this label. A skipped P0 is
therefore invisible to the `/ship` gate **by design** — correctly excluded
from failures — which is exactly why this report is the only place it can
surface, and why omitting the skipped line above would be silent, not
merely incomplete.

## Failure policy

`/ux-lock verify` exits 0 even when criteria fail — it is a **report**,
not a blocker. To gate shipping on verification, `/ship` reads
`plan_satisfaction.failing_p0_criteria` via
`cross-skill.mjs plan-satisfaction --plan-id <id>` and can be configured
to treat a non-empty list as a block reason.
