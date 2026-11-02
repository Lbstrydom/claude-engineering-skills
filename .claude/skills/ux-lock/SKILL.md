---
name: ux-lock
description: |
  Generate Playwright e2e specs. Two modes:
    1. LOCK mode — pin a fix's DOM contract so it doesn't regress (default).
    2. VERIFY mode — check that a /plan plan was actually implemented
       by parsing its Acceptance Criteria section and driving the live URL.
  VERIFY mode grades a plan against a RUNNING app. To judge the plan document
  itself, before anything is built, that is /audit-plan.
  Triggers on: "ux lock", "lock ux", "lock in the fix", "write regression spec",
  "generate e2e test for", "regression test for commit", "lock this fix",
  "verify the plan", "verify plan implementation", "check the plan was built",
  "audit frontend implementation", "did we ship the plan".
  Full command syntax: see the Usage section in this skill.
---

# UX Lock — Playwright Spec Generator & Plan Verifier

> **This skill's last line is an end marker naming the skill between em-dashes, after
> the Reference files table.** If that last line is not in your context (context
> compaction keeps only the start of a skill), re-read
> `.claude/skills/ux-lock/SKILL.md` in full before continuing — the later steps still apply.

> **Worktree preflight** — in a linked git worktree the synced tooling tree
> `scripts/.claude-skills/` is absent — it is gitignored, so `git worktree add`
> does not populate it, and every command below that uses it dies on a bare
> `MODULE_NOT_FOUND`. Run `npm run skills:hydrate` first. If this repo defines
> no such script, add it from `references/worktree-preflight.md`.

## Usage

```
Usage:
  /ux-lock <commit-or-description> [--url <base-url>]                     — lock mode
  /ux-lock verify <plan.md> [--url <base-url>]                            — verify mode
Examples:
  /ux-lock "modal closes before retry"
  /ux-lock abc1234
  /ux-lock "role=list on wine grid" --url https://myapp.railway.app
  /ux-lock verify docs/plans/<name>.md --url https://myapp.railway.app
```

Two modes, one skill. Both drive Playwright against semantic DOM contracts.

- **LOCK mode** (default): generate an e2e spec that pins a fix's DOM contract.
- **VERIFY mode** (`verify <plan.md>`): parse the plan's Acceptance Criteria
  section (from a `/plan` plan) and run one assertion per criterion
  against the live URL — producing a pass/fail grade for the plan.

Read the first word of `$ARGUMENTS`:

<!-- host-contract: input-acquisition; grammar=subcommand; empty=ask-and-stop -->

**Where `$ARGUMENTS` comes from** — orchestrator-supplied input first, else
the host's verbatim invocation suffix, else the span of the user's **current**
message naming this skill or its subject. Never inferred from surrounding
conversation. This site is `subcommand`; on empty input, ask whether to LOCK a fix or VERIFY a plan and stop — the two modes read different inputs and write different artifacts.
Full contract: `references/input-acquisition.md`.


- `verify` → **Mode: VERIFY**
- otherwise → **Mode: LOCK**

---

## DOM-contract rule (both modes) — covers LOCATION and assertion

The spec must **locate and assert** on public DOM contracts, not implementation
details. Avoiding `toHaveClass()` while locating via `page.locator('#id')` still
ships all the brittleness — the rule constrains both halves:

| Good (stable) | Bad (brittle) |
|---|---|
| `page.getByRole('button', { name: 'Add bottle' })` | `page.locator('#add-btn')` |
| `page.getByTestId('cellar-grid')` | `page.locator('.grid-abc')` |
| Element with `role="list"` exists | Element has class `wine-list-v3` |
| Modal closes when action button clicked | Internal state variable changes |
| Button is `aria-disabled` when form invalid | CSS opacity is 0.5 |
| Navigation to `/cellar` shows grid | `document.querySelector('.grid-abc')` |

**Selector priority ladder (location)** — take the FIRST rung that works:

1. `page.getByRole(role, { name })` — first choice
2. `page.getByLabel(...)` / `page.getByPlaceholder(...)` — form controls
3. `page.getByText(...)` — static user-visible copy
4. `page.getByTestId(...)` — when no accessible handle exists
5. CSS `#id` / `.class` — **last resort only**, and it must carry a justification
   marker on the same line or the line above:
   `// selector-policy: structural — <why no semantic handle is possible>`
   (the reason is mandatory; the run pipeline lints unmarked structural selectors
   — warn by default, `--strict-selectors` fails the run)

**Rules**:
- Locate via the ladder above; assert on semantic HTML (`role`, `aria-*`,
  `data-testid`) — never CSS classes
- Assert on user-visible behaviour (click → result) — never internal state
- Assert on accessibility (axe-core) when the fix touched a11y
- Never import the app's own modules into the spec process — drive the UI
  (see `references/scope-and-limitations.md`)

---

## Mode: LOCK

### Step 0 — Understand the fix

1. If a commit hash is provided, read the commit message and diff
   (substitute the real hash for `$HASH`):
   ```bash
   git show $HASH --stat
   git show $HASH
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

### Step 1.5 — Ensure a semantic handle exists

If the fixed surface exposes no role/label/testid the ladder can target, the lock
task INCLUDES adding one to the app markup — the surface is already being touched
at fix time. The hook itself has a ladder (accuracy over convenience):

1. **Native semantic HTML / visible label** — when the element genuinely warrants
   it (clickable `div` → `button`; unlabelled input gains a `<label>`). A real
   accessibility improvement — verify with the spec's axe assertion.
2. **`data-testid`** — the default otherwise. Genuinely behaviour-neutral.
3. **`role` / `aria-label`** — ONLY when it accurately describes the element's
   function. Wrong ARIA is worse for screen-reader users than none; never add it
   purely to make a test targetable — that's what `data-testid` is for.

### Step 2 — Generate the spec

Use the template + fix-type assertion map in
`references/lock-mode-spec-generation.md`. One file per fix, named
`tests/e2e/<ticket-or-round>-<description>.spec.js`.

### Step 2.5 — Prove the spec RED before you record it

**A spec that has never failed is not a lock.** You have the fix and the spec in
hand right now; this is the only moment the proof is cheap.

1. Revert the fix (`git stash` the fix hunk, or restore the pre-fix file).
2. Run the spec → **confirm RED**, and read the failure: it must fail *because
   the fixed behaviour is absent*, not because the page 404'd, the selector was
   wrong, or the app failed to boot.
3. Restore the fix → confirm GREEN.
4. Note the red output in the spec's header comment.

A spec can pass before the fix too, when its assertion cannot tell the guarded
outcome from an incidental one. → `references/history-and-evidence.md` §Step 2.5 —
read when a spec's RED/GREEN result is ambiguous.

**Watch for the spec that goes red for the wrong reason** — that is the same
failure wearing the opposite mask, and it is why step 2 says read the text.

→ `references/verification-discipline.md` §3.

### Step 3 — Run + record (deterministic — ONE call)

The spec is authored (Step 2). Execution and recording are now a single
deterministic call — the runner runs `npx playwright test`, parses the JSON
report from a file (never stdout), and writes BOTH the `regression_specs` and
`regression_spec_runs` rows itself. This replaces the old model-remembered
sequence (run → hand-parse → `record-regression-spec` → `record-regression-spec-run`)
that left the tables empty whenever a step was skipped or mis-parsed:

```bash
SPEC=tests/e2e/*.spec.js
COMMIT=$(git rev-parse HEAD)
node scripts/ux-lock-run.mjs spec --spec "$SPEC" --commit "$COMMIT" --run-context manual --source-kind manual --strict-selectors
```

→ `references/history-and-evidence.md` §Step 3 — read when `regression_spec_runs`
looks empty or under-attributed in the store.

Pass `--strict-selectors` for newly generated specs (recommended — a spec you
just authored has no excuse for unmarked structural selectors; the flag fails
the run instead of warning). Omit it only when re-running legacy suites.

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

Grade a `/plan` plan against its live implementation. Each
criterion in the Acceptance Criteria section becomes one Playwright `test()`;
per-criterion outcomes are recorded with a stable `criterion_hash` for
time-series tracking across verify runs.

### Step V0 — Parse the plan

Read the plan at the path in `$ARGUMENTS` (first positional after

<!-- host-contract: input-acquisition; grammar=subcommand; empty=ask-and-stop -->
_This site: `subcommand` — verify requires a plan path; ask for it and stop rather than grading the app against a guessed plan._

`verify`). Parse the Acceptance Criteria section using `scripts/lib/plan-criteria-parser.mjs`.

If `found = false` → plan has no Acceptance Criteria; offer to add one.
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
COMMIT=$(git rev-parse HEAD)
node scripts/ux-lock-run.mjs verify --plan docs/plans/*.md --spec tests/e2e/verify-*.spec.js --plan-id PLAN_UUID --commit "$COMMIT" --url BASE_URL --strict-selectors
```

(`--strict-selectors`: verify specs are newly generated, so the selector-policy
lint fails rather than warns on an unmarked structural selector. Note V3
registers the SPEC row via cross-skill; this call owns only the RUN rows.)

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
  fail; a non-zero exit means the spec could not RUN (PW missing / fatal), not
  that a criterion failed. Exit 4 (`error.code: PERSIST_FAILED`) means it RAN
  but its run or criterion rows were NOT recorded.
- **Nothing gates on this today** — `/ship` never queries `plan_satisfaction`
  as a gate; do not tell the user a failing verify blocks shipping.
  → `references/history-and-evidence.md` §Steps V3–V5 — read when asked whether
  verify gates `/ship`, or before claiming it does.

The verify-spec template MUST emit each test with
`{ annotation: [{ type: 'criterion_hash', description: '<hash>' }] }` — naming
the test by prose is NOT enough (the hash can't be recovered from a title).
Full template + translation rules: `references/verify-mode-generation.md`.

### Step V6 — Report

Emit the satisfaction summary with pass/fail/**skipped** counts per severity +
the list of failing P0 criteria. **A skipped P0/P1 is neither a pass nor a
failure and must be rendered as its own line — never silently dropped**, since
it is invisible to the `/ship` gate by design (the store correctly excludes
skipped items from `failing_p0_criteria`) and this report is the only place
it can surface. Status rubric is a full precedence table, not three
independent conditions: `PLAN_NOT_SHIPPED` (any P0 failed) →
`PLAN_PARTIAL` (any P0/P1 skipped, or any P1 failed) → `PLAN_SATISFIED` (all
P0+P1 evaluated and passing). Full template + precedence table:
`references/verify-mode-generation.md`.

### Failure policy

Verify exits 0 even on fail — it's a report, not a blocker. The result is
readable via `cross-skill.mjs plan-satisfaction --plan-id <id>`
(`failing_p0_criteria`), but no step reads it to gate a ship today (see the
"Nothing gates on this today" rule above).

---

## When to use this skill

- **After /audit-code convergence**: lock in the fixes before moving on
- **After a /persona-test P0 fix**: prevent recurrence
- **After any production bug fix**: before closing the issue
- **Before a major refactor**: baseline the current behaviour
- **After /plan implementation**: `verify` mode grades the implementation

---

## Integration with other skills

- **/audit-code** converges → **/ux-lock** locks in fixes
- **/persona-test** finds P0 → fix → **/ux-lock** prevents recurrence
- **/ship** warns if recent fixes lack regression specs
- **/plan** produces Acceptance Criteria → **/ux-lock verify** grades implementation

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
| `references/input-acquisition.md` | Where a skill's arguments come from on any host, and what to do when there are none. | Reading $ARGUMENTS on a host that does not substitute it, or deciding what empty input means at a site. |
| `references/lock-mode-spec-generation.md` | LOCK mode — full Playwright spec template + fix-type assertion map + persistence recipe. | Mode: LOCK, about to write the spec body OR register it. |
| `references/verify-mode-generation.md` | VERIFY mode — criterion parser wiring, translation rules, per-criterion run+record protocol. | Mode: VERIFY, Steps V0–V6 (parsing, generating, running, recording). |
| `references/scope-and-limitations.md` | Where /ux-lock works well, where it doesn't (Obsidian/Electron), and fallback strategies. | Target is an Obsidian plugin / Electron app / CLI / anti-bot-protected URL, OR bootstrapping Playwright harness from scratch, OR user is on Windows and Playwright MCP tools aren't appearing. |
| `references/verification-discipline.md` | Verification discipline — pinned citations, figure provenance, two-direction proof, attribution, consumer-side checks. | Step 2.5 — the spec is written and must be proven RED against the un-fixed code before it is run and recorded. ALSO Step V6 — about to emit the VERIFY report, to apply §7's skipped-criteria rule. |
| `references/history-and-evidence.md` | The measured cases behind Step 2.5's RED proof, the Step 3 store diagnosis, and why nothing gates on verify today. | Step 2.5 RED/GREEN is ambiguous, OR the store's spec-run rows look empty, OR asked whether verify gates `/ship`. |
| `references/worktree-preflight.md` | Worktree preflight remedy — the skills:hydrate npm script to add when a linked worktree lacks the tooling tree. | A command dies with `MODULE_NOT_FOUND` in a linked worktree AND this repo has no `skills:hydrate` script. |

— end of /ux-lock —
