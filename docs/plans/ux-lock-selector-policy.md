# Plan: /ux-lock selector policy — locate semantically, lint the drift

- **Status**: Complete (implemented + code-audited 2026-07-04; consolidated
  Gemini gate over the union diff: APPROVE, 0 findings — see §7 Audit trail)
- **Origin**: Consumer evidence from wine-cellar-app (migration-prep scan, 2026-07-03):
  all 29 generated e2e/UX-lock specs (118 cases) locate elements structurally. Zero
  `getByRole`/`getByLabel`/`getByText` calls in the consumer's `tests/e2e/`. 25/29 specs
  are pure CSS `#id`/`.class` locators; 2 shell-mode specs (`grid-cluster-sublabels`,
  `allocation-v2-clusters`) import deployed-app ES modules directly into the spec
  process. The consumer plans a React migration, which invalidates every structural
  lock — but the fix belongs upstream: the skill keeps generating structural specs for
  every new fix.
- **Scope**: skills/ux-lock (SKILL.md + all 3 references), `scripts/ux-lock-run.mjs`,
  new `scripts/lib/ux-lock/selector-policy.mjs`, `scripts/lib/ux-lock/candidate-spec.mjs`,
  one small migration, tests, docs. **Flow, not stock** — the consumer's existing 29
  specs are explicitly NOT rewritten by this change (their own migration plan owns them).

---

## 1. Root cause (verified in-repo, 2026-07-03)

1. **`skills/ux-lock/SKILL.md` "DOM-contract rule" (lines 38–52)** constrains what is
   **asserted** ("Assert on semantic HTML (`role`, `aria-*`, `data-testid`) — never CSS
   classes") but says nothing about how elements are **located**. The generating model
   satisfies it by avoiding `toHaveClass()` while still locating via
   `page.locator('#id')` / `page.locator('.class')` — which is where the brittleness
   actually lives. The Good/Bad table contains only assertion examples.
2. **`skills/ux-lock/references/lock-mode-spec-generation.md`**: the spec template's
   locator placeholders are neutral (`page.locator('...')`, lines 39–41), so the model
   fills them from whatever the app DOM offers (in a vanilla app: ids/classes). The
   template's own a11y example demonstrates a CSS id:
   `expectNoA11yViolations(page, { include: '#relevant-container' })` (line 48).
3. **`skills/ux-lock/references/verify-mode-generation.md`**: the translation rules
   already say "Never fall back to CSS class selectors" but the emit column is
   locator-agnostic (`await expect(locator).toBeVisible()` etc.) and the axe row emits
   `{ include: '<selector>' }` — no location guidance.
4. **No enforcement anywhere**: `scripts/ux-lock-run.mjs` (`cmdSpec`, `cmdVerify`) runs
   whatever spec it is given; nothing lints generated specs for selector policy, so
   drift is invisible until a consumer measures it.
5. **Sibling generator** `scripts/lib/ux-lock/candidate-spec.mjs` (persona-test
   consistency candidates → `/ship` Step 5.6 promotion): `locatorCall()` already
   supports a semantic-first kind set (`role`/`label`/`testid` before `id`/`css`), but
   `renderAssertion()` **always** emits the contradiction's raw selector as
   `page.locator(sel)` with no justification marker, and structural `locatorCall` kinds
   emit unmarked.

## 2. Design — one ladder, one marker, one lint

### 2.1 Selector priority ladder (the policy)

1. `page.getByRole(role, { name })` — first choice
2. `page.getByLabel(...)` / `page.getByPlaceholder(...)` — form controls
3. `page.getByText(...)` — static user-visible copy
4. `page.getByTestId(...)` — when no accessible handle exists
5. CSS `#id` / `.class` — **last resort only**, and must carry an inline justification
   marker on the same line or the line above:
   `// selector-policy: structural — <why no semantic handle is possible>`

### 2.2 Justification marker grammar

- Literal token + **mandatory non-empty reason**, always:
  `selector-policy: structural — <reason>` (matcher:
  `selector-policy:\s*structural\s*[—–-]+\s*\S`). A bare
  `selector-policy: structural` with no reason does NOT justify anything —
  auto-generators satisfy the rule by emitting a fixed reason string.
- Recognised in `//` line comments and `/* ... */` block comments.
- **Attachment rules (tight, no ranges)** — a marker justifies structural patterns on
  exactly ONE line:
  - marker on the violating line itself (trailing comment), or
  - marker in a comment-only line (or a block comment whose closing `*/` sits) on the
    line **immediately above** the violating line — no blank-line skipping, no
    "covers the next N lines".
  - One marker covers all structural patterns on its single target line; a second
    violating line needs its own marker.
- **Stale markers are surfaced**: a marker with no structural pattern on its target
  line is reported as a `stale-marker` warning, so the exception inventory stays
  auditable rather than accreting dead suppressions.
- Content/marker matching, never line numbers.

### 2.3 Lint semantics (`scripts/lib/ux-lock/selector-policy.mjs`, pure module)

- `scanSpecSource(source, {filePath, testRoot})` →
  `{ violations: [{line, snippet, class}], justifiedCount, staleMarkers: [...] }`.
  Violation `class` is exactly one of THREE values: `structural-selector`,
  `unresolvable-selector`, `app-module-import` — these (unjustified) are what
  strict mode and the DB column count. Stale markers are NOT a violation class;
  they live only in the separate `staleMarkers` array (stderr warning surface).
- **Scan mechanics (multi-line honest, literal-masked)**: call-site + import
  detection runs over source with **comments AND string/template literals masked**,
  via an index→original-line map. Masking comments stops locator-looking text in
  comments from false-matching; masking string literals stops
  `expect(msg).toContain("require('./missing')")` from being detected as an import
  (which would fail-closed on a path that exists only inside a test assertion).
  A detected call's **argument literal** is then extracted from the ORIGINAL source
  at the masked argument's mapped position — so selector classification still sees
  the real string. Multi-line calls, chained calls split across lines, and
  formatted specs are all classified; the violation's reported line = the call
  token's original line; §2.2 marker attachment is evaluated against the ORIGINAL
  source relative to that line. Still string/regex-based (mask + bounded lookahead
  to the argument's first token), no AST dependency.
- **Closure scanning (helpers are part of the spec process)**: for each scanned
  spec, the scanner also follows **relative imports that resolve within the test
  root** (`./helpers/auth.js`, `../helpers/…`) transitively — visited-set + depth
  cap (8) — and applies the SAME selector + import policy to each file. Without
  this, a spec stays lint-clean by moving `import '../../src/app.js'` or
  `page.locator('.structural')` one hop into a local helper (the gate-honesty
  evasion). Helper files may carry §2.2 markers like any spec. An unresolvable or
  unreadable relative import in the closure fails closed (named file, non-zero),
  same as an unreadable spec. The closure walk is the module's one impure entry
  point (`scanSpecClosure(specPath, {testRoot})`, injected `fs` for tests);
  `scanSpecSource` itself stays pure.
- **`testRoot` is resolved deterministically by the runner, per spec file** —
  ladder: explicit `--test-root` flag > a playwright-config `testDir` **that
  contains the spec's path** (multi-project configs yield several `testDir`
  candidates; filter by containment, deepest match wins — first-found-wins would
  misattribute the second project's helpers as outside-root) > nearest ancestor
  directory of the spec named `tests`, `test`, or `e2e` > the spec file's own
  directory. The ladder lives in one exported helper (`resolveTestRoot(specPath,
  {flag, configTestDirs})`), unit-tested, so repos whose e2e tree isn't literally
  `tests/` and multi-project configs resolve predictably.
- **Config reads are tolerant**: `tsconfig.json`/`jsconfig.json` legitimately
  contain comments (JSONC) — the alias-map read strips comments/trailing commas
  before parsing and, on ANY parse failure, degrades to "no alias map" with a
  stderr note (never crashes the runner; unmapped aliases then surface as
  `unresolved-alias-import` warnings, which is the honest degraded state). The
  same tolerance applies to the best-effort `playwright.config.*` `testDir` scrape.
- **Detection is call-site + argument classification, NOT prefix patterns** (a
  prefix-anchored `locator('#…')` regex reads clean on `locator('button#add')` —
  the false-green the policy exists to prevent):
  1. Find selector call sites: `locator(<arg>)` on ANY receiver (`page.locator`,
     chained `row.locator`, `frameLocator`), `querySelector(` /
     `querySelectorAll(` (including inside `page.evaluate` bodies), and
     `page.$(` / `page.$$(`.
  2. Classify the first argument — **allowlist semantics, deny by default** (a
     denylist of CSS forms is a treadmill: ids/classes today, `:nth-child` /
     `[href=…]` / bare-tag positional selectors tomorrow — all equally brittle
     location strategies):
     - **String literal** → NON-structural iff the whole selector (every compound
       in it) consists solely of an optional tag name plus semantic attribute
       selectors from the allowlist: `[data-testid=…]`, `[data-engine-claim=…]`
       (the consistency-contract attribute), `[role=…]`, `[aria-*=…]`.
       `button[aria-label="…"]` is clean; **everything else is structural** —
       ids, classes, bare `button`, `input[name="email"]`, `li:nth-child(2)`,
       `[href="/settings"]`, `:nth-match(...)`, combinators over non-semantic
       operands — and needs the §2.2 marker.
     - **Template literal or non-literal** (identifier, call, concatenation) →
       cannot be statically proven semantic → `unresolvable-selector` violation
       unless justified by a marker.
     - The classifier is exported as `classifySelector(selectorString)` — the single
       policy oracle, reused by generators (work item G) so no second classification
       path can drift.
  3. `getBy*` calls are never flagged.
- **Shell-mode / app-import class** (`app-module-import`): any `import` — static,
  **dynamic `import(...)`**, or `require(...)` — in the spec, classified by
  specifier shape. **The prohibited thing is app SOURCE in the spec process, not
  third-party packages** (an e2e suite legitimately imports `@faker-js/faker`,
  `dotenv`, `date-fns`, …):
  - **Bare npm specifiers** (`lodash`, `@scope/pkg`, `node:*` builtins) → **allowed
    by default** — no allowlist maintenance treadmill for ordinary test deps.
  - **Relative specifiers** → clean iff, resolved against the spec file's path, they
    stay within the test root (so `./helpers/auth.js` and `../helpers/auth.js` from
    `tests/e2e/specs/foo.spec.js` are both clean, and get closure-scanned);
    escaping the test root (`../../src/…`) → violation.
  - **Absolute paths and URL imports** → violation.
  - **Path-alias specifiers** (`~/…`, `@/…` — syntactically distinguishable from
    npm scopes, which always have a name segment after `@`; plus any prefix in an
    optional alias map): resolved via the runner-supplied alias map (repeatable
    `--alias prefix=dir` flag; best-effort tsconfig/jsconfig `paths` read as the
    default source). Alias resolving within the test root → clean + closure-scanned;
    resolving outside → `app-module-import`. An alias with NO configured mapping →
    `unresolved-alias-import`, a **non-counting warning** (fail-closed would break
    legitimate alias-using suites; silently-clean would hide the app-import evasion
    — the warning names the specifier and says how to configure the alias, and the
    closure scan does not follow it). Documented as the v1 limit.
  - A dynamic `import()` with a **non-literal** specifier is a violation (cannot be
    proven safe). **No marker escape for imports** — the approved alternative is
    driving the UI, or `page.evaluate` against the live page (which, if it uses
    `querySelector`, needs the structural marker like any other call site).
- Pure string/content analysis — no AST dependency (line scan + marker lookback per
  §2.2), mirroring the plans:lint right-sizing precedent; classification helpers are
  exported via `_internals` and the known-miss surface (minified one-line specs,
  dynamically-built selector strings) is documented as the extension point to an AST
  pass if misses recur in practice.

### 2.4 Enforcement wiring (`scripts/ux-lock-run.mjs`)

- **Resolver contract — the runner owns it, no Playwright-discovery duplication.**
  `cmdSpec`/`cmdVerify` never rely on Playwright default discovery: they always pass
  explicit spec path(s) (`--spec`, or the `--specs` glob the runner itself expands)
  on the `npx playwright test` command line. The scanner scans **the same resolved,
  deduplicated array the runner passes to Playwright** — one variable, single source
  of truth, so scanner set ≡ executed set by construction.
- **Empty/unreadable-scan honesty**: an empty resolved set exits non-zero as
  unverified; **any unreadable file in a non-empty set fails closed** (non-zero,
  named file) rather than being skipped from the count — the runner must never
  report "0 selector violations" for files it didn't actually scan (green-path
  honesty; same class as the nav-audit `statesCollected===0` guard).
- **Default: warn loudly** — a `SELECTOR POLICY` block on stderr listing each
  unjustified violation (file, line, class, snippet) + stale markers, plus BOTH the
  violation count and the justified count in the end-of-run summary (justified usage
  stays observable, not just violations).
- `--strict-selectors` flag: unjustified violations → exit non-zero (distinct exit
  code, documented in the runner's usage) without running the spec. Default stays
  warn so legacy consumer specs re-run without breaking.
- **Recording — traced end-to-end**: the runner already writes run rows via
  `recordRegressionSpecRun` / `recordPlanVerificationRun`
  ([scripts/lib/store/plans-ship.mjs](../../scripts/lib/store/plans-ship.mjs),
  re-exported through the `learning-store.mjs` barrel). Add an optional
  `selectorPolicyViolations` field to both writers' run payloads (plain integer —
  no jsonb, so the jsonb-safe seam is untouched). Migration
  `supabase/migrations/<ts>_selector_policy_violations.sql`: idempotent
  `ADD COLUMN IF NOT EXISTS selector_policy_violations INTEGER` (nullable) on
  `regression_spec_runs` + `plan_verification_runs`; ships to consumers via the
  existing `.audit-loop/migrations` sync + `setup-postgres --migrate`.
- **Fallback discrimination is exact, not blanket**: only Postgres error code
  `42703` (undefined_column) triggers ONE retry without the new field plus a single
  stderr warning naming the pending migration; every other write error propagates
  through the writers' existing error handling (no new swallow — per the
  db-write-seam HIGH rules). Read side: none in v1 — the column is observation-only
  telemetry until something consumes it (see Non-goals).
- **Column semantics (defined now so future readers can't misread the trend)**:
  `selector_policy_violations` = count of **unjustified violations only**, summed
  across the three violation classes (`structural-selector`,
  `unresolvable-selector`, `app-module-import`). Justified (marked) usages and
  `stale-marker` warnings are EXCLUDED — they appear in the stderr summary but
  never in the column. Encode this in the migration's `COMMENT ON COLUMN`.
- **Attribution matches row granularity** (Gemini-R3-G1): `cmdSpec` records one
  `regression_spec_runs` row per spec file — each row gets **that spec's own
  count** (the spec + its import closure; a helper shared by two specs counts in
  each importing spec's row, documented). Never write the run-global total onto
  per-spec rows (an N-spec suite would inflate the DB ×N). `cmdVerify`'s
  `plan_verification_runs` is one row per run → it records the run total.
- **Import-legality boundary is the OUTERMOST test-root candidate**
  (Gemini-R3-G2): when a nested project `testDir` (`tests/e2e/mobile`) sits inside
  a broader test tree (`tests/`), legality containment uses the outermost
  candidate, so shared helpers (`tests/e2e/helpers`) imported as `../helpers/…`
  are never flagged as app imports. (The per-spec deepest-`testDir` resolution
  remains for any narrower future use; v1 legality checks use the outermost.)

### 2.5 Missing-semantic-hook step (LOCK mode)

New step between SKILL.md Steps 1 and 2: if the fixed surface exposes no
role/label/testid to target, the lock task INCLUDES adding a semantic hook to the app
markup and asserting on it. **The hook itself has a ladder (accuracy over
convenience)**:

1. **Native semantic HTML / visible label** — when the element genuinely warrants it
   (a clickable `div` becomes a `button`, an unlabelled input gains a `<label>`).
   This is a real accessibility improvement, not just test plumbing — verify with the
   spec's axe assertion.
2. **`data-testid`** — the default when native semantics aren't warranted. Genuinely
   behaviour-neutral: invisible to users and assistive tech.
3. **`role` / `aria-label`** — ONLY when it accurately describes the element's
   function. ARIA changes the accessibility tree; a wrong role or label is worse for
   screen-reader users than none. Never add ARIA purely to make a test targetable —
   that's what `data-testid` is for.

Rationale: the lock is written at fix time, when that surface is already being
touched; hooks added then can also improve real accessibility (tier 1) without
degrading it (tier 3 guard). This makes the ladder achievable in legacy vanilla-DOM
apps instead of aspirational.

### 2.6 Shell-mode prohibition (documented AND enforced)

Specs must drive the UI (`page.goto` + user actions). Importing the app's deployed ES
modules into the spec process is prohibited (couples the spec to the bundle layout, not
the user contract — the two wine-cellar shell-mode specs are the failure exhibit).
Approved alternative: drive the UI; if unavoidable, `page.evaluate` against the live
page (structural `querySelector` inside it needs the §2.2 marker).

Enforcement is NOT docs-only: the §2.3 scanner's `app-module-import` class detects
disallowed imports in every scanned spec, under the same warn/`--strict-selectors`
regime — a pattern already observed in the wild cannot be controlled by documentation
alone.

## 3. Work items

### A. SKILL.md — extend the DOM-contract rule to LOCATION
- Add the §2.1 ladder verbatim under the DOM-contract rule.
- Extend the Good/Bad table with location rows, e.g.
  Good: `page.getByRole('button', { name: 'Add bottle' })` /
  Bad: `page.locator('#add-btn')`;
  Good: `getByTestId('cellar-grid')` / Bad: `page.locator('.grid-abc')`.
- State the marker grammar (§2.2) so a justified last-resort selector is legal.
- Keep SKILL.md within the ≤3K-token budget — deep detail lives in the references;
  run `npm run skills:check` to verify reference-index/frontmatter byte-match.

### B. SKILL.md — missing-semantic-hook step in LOCK mode
- Insert §2.5 as "Step 1.5 — Ensure a semantic handle exists" (or fold into Step 2's
  preamble — implementer's choice, whichever keeps the flow scannable).

### C. references/lock-mode-spec-generation.md — template demonstrates the policy
- Replace `page.locator('...')` placeholders with `getByRole`/`getByTestId` examples.
- Fix the axe include example to a testid (`{ include: '[data-testid="…"]' }`) or a
  documented-structural marker.
- Add a short "Selector policy" section mirroring the §2.1 ladder + §2.2 marker.
- Update fix-type → assertion map rows that imply structural targeting (e.g. "Data
  rendering: container has expected child count" → name the container semantically).
- Update the reference's `summary:` frontmatter if its scope line changes, and the
  SKILL.md reference-index row byte-identically (skills:check enforces).

### D. references/verify-mode-generation.md — same ladder for VERIFY
- Add the ladder to the translation-rules section; make the emit column show semantic
  locator examples; fix the axe row's `'<selector>'` to a semantic/testid include.
- Keep the existing "flag as un-verifiable rather than emit a brittle assertion" rule;
  extend it to cite the ladder (a criterion satisfiable only via `.class` → flag,
  or add the hook per §2.5 when the implementation is in-repo).

### E. Enforcement — lint module + runner wiring + tests
- New `scripts/lib/ux-lock/selector-policy.mjs` per §2.3 (pure, `_internals` export
  pattern per repo convention).
- Wire into `cmdSpec` + `cmdVerify` per §2.4 with `--strict-selectors` + the
  empty-scan-set guard.
- Migration + `42703`-only write fallback per §2.4 (writers:
  `recordRegressionSpecRun` / `recordPlanVerificationRun` in
  `scripts/lib/store/plans-ship.mjs`).
- **Sync/relocation contract (Tier-3 — same commit as the module)**: add
  `{ rel: 'lib/ux-lock/selector-policy.mjs', mustExport: ['scanSpecSource',
  'classifySelector', 'resolveTestRoot'] }` to **`LIB_IMPORT_SET` in
  `scripts/lib/sync-isolation-verify.mjs`** — the single source of truth the
  relocation-guard test and the consumer isolation verifier both read (editing
  `tests/relocation-guard.test.mjs` directly would fork that list). The module has
  no `main()`, so no `--selfcheck-relocation` handler. `sync-to-repos.mjs` picks the module up
  automatically via import-graph closure (no manual file list); the skill docs add no
  new `node scripts/X.mjs` command (only a flag on the existing runner invocation),
  so `sync-rewriter` is unaffected — assert nothing new is needed there rather than
  assuming. Close-out runs `npm run sync:dry` to observe the consumer delta before
  shipping.
- Tests beside the existing suite: `tests/ux-lock-selector-policy.test.mjs` —
  scanner fixtures covering at minimum:
  - unjustified `locator('#x')` → violation; same fixture with the marker on the
    same line AND on the line above → clean;
  - **non-prefix structural forms**: `locator('button#add')`,
    `locator('div.card .title')`, `locator('[class~="active"]')`, a token inside
    `:has(.x)`, chained `row.locator('.cell')` → all violations;
  - **deny-by-default forms** (no id/class at all): `locator('button')`,
    `locator('input[name="email"]')`, `locator('li:nth-child(2)')`,
    `locator('[href="/settings"]')` → all violations;
  - template-literal / non-literal selector argument → `unresolvable-selector`;
  - `querySelector` inside `page.evaluate` → violation; justified → clean;
  - `getByRole(...)`, `locator('[data-testid="x"]')`,
    `locator('[data-engine-claim="x"]')`, `locator('button[aria-label="x"]')` →
    clean;
  - **marker without a reason → still a violation** (reason is mandatory);
    generator fixed-reason strings → clean;
  - marker separated from the violation by a blank line → violation + `stale-marker`;
  - `import { helper } from '../../src/app.js'` → `app-module-import`;
    **dynamic `await import('../../src/app.js')`** and a non-literal dynamic
    specifier → `app-module-import`; `./helpers/auth.js` AND `../helpers/auth.js`
    (within the test root), `@playwright/test`, `node:path`,
    `@axe-core/playwright` → clean;
  - **bare npm deps** `@faker-js/faker`, `lodash`, `dotenv` → clean (no allowlist
    treadmill); alias `@/components/x` with a map resolving into app source →
    `app-module-import`; alias mapped into the test root → clean + closure-scanned;
    unmapped alias → `unresolved-alias-import` warning, not counted;
  - unreadable file in a non-empty set → fail closed;
  - **closure cases**: spec clean but `./helpers/shell.js` imports `../../src/…`
    → `app-module-import` attributed to the helper file; helper containing
    `page.locator('.structural')` → violation; justified helper usage → clean;
    unresolvable relative import in the closure → fail closed; import cycle
    between helpers → terminates via visited-set;
  - **multi-line cases**: `locator(` with the selector argument on the next line
    → classified + marker attaches at the call line; `page.locator('.x')` text
    inside a comment → NOT a violation;
    `expect(msg).toContain("require('./missing')")` → NOT an import (literal
    masking) and does NOT fail-close;
  - `resolveTestRoot` ladder: explicit flag > containing playwright-config
    `testDir` (multi-project: two testDirs, spec in the second → second wins) >
    `tests|test|e2e` ancestor > spec dir;
  - JSONC `tsconfig.json` (comments + trailing comma) → alias map parsed;
    malformed config → degrades to no-alias-map, runner does not crash.
  Runner wiring covered in `tests/ux-lock-run.test.mjs` additions: warn-path counts
  (violations + justified), strict-path exit code, empty-resolved-set → non-zero,
  and the `42703` retry-once-without-field path (plus: any other error code still
  propagates).

### F. Shell-mode prohibition — references/scope-and-limitations.md
- Add §2.6 as an explicit "Do NOT import app modules into the spec" subsection with
  the approved alternative AND a pointer to the `app-module-import` lint class that
  enforces it. (The existing "Mock HTML harness" Obsidian guidance stays — it renders
  components in a page, which is different from importing deployed bundles into the
  Node spec process.)

### G. Sweep sibling spec generators
- `scripts/lib/ux-lock/candidate-spec.mjs`:
  - `locatorCall()` kinds `id`/`css` → emit the marker inline (fixed reason:
    `auto-generated from witness selector — no semantic handle captured`). Semantic
    kinds unchanged. `locatorCall()` **remains the single kind-aware emitter** — no
    second locator-classification path may appear in this module.
  - `renderAssertion()` currently always emits raw `page.locator(sel)`. The
    `Contradiction` schema carries only a raw selector **string**, so **no
    locator-kind reconstruction is attempted** — v1 keeps `page.locator(sel)`. The
    marker is emitted **conditionally**: `candidate-spec.mjs` imports
    `classifySelector()` from `selector-policy.mjs` (the single policy oracle) and
    adds the fixed-reason marker only when the selector classifies structural. A
    consistency-surface selector like `[data-engine-claim="x"]` is semantic per the
    allowlist → no marker → the generator never manufactures its own `stale-marker`
    noise, and there is exactly one classification implementation. If/when the
    contradiction schema gains a structured locator descriptor (`{kind, …}` like
    journey steps), route it through `locatorCall()` — noted as the follow-up, not
    built now.
  - Determinism invariant preserved (byte-identical output for same input);
    update `tests/ux-lock-candidate-spec.test.mjs` expectations (marker present on
    structural emissions; determinism test still passes).
- `/ship` Step 5.6 `.spec.js.proposed` candidate stubs materialise via
  `renderCandidateSpec` — covered by the above; verify during implementation that no
  other template in `skills/ship/**` or `skills/persona-test/references/**` emits
  Playwright locator code (the consistency-mode `surfaces.json` manifest locators are
  capture-side observation locators, already nudged semantic by
  `manifestQualityWarnings` in `scripts/lib/persona-test/consistency.mjs` — out of
  scope; do not touch generators that only READ specs).

### H. Docs, regeneration, consumer note
- `npm run skills:regenerate` (`.claude/skills/**` is a category-B generated artifact;
  `skills:check` enforces freshness).
- `docs/runbooks/consumer-adoption.md`: note that consumers should re-sync
  (`npm run sync --target <name>`) to pick up the policy + lint; existing consumer
  specs are explicitly NOT rewritten — the lint defaults to warn so legacy specs keep
  running; `--strict-selectors` is opt-in per run.
- AGENTS.md ux-lock bullet: one-line mention of the selector-policy ladder + lint.

## 4. Non-goals

- Rewriting wine-cellar-app's existing 29 specs (consumer's migration plan owns them).
- AST-grade selector parsing (line-scan + argument classification is the right-sized
  v1; the known-miss surface is documented and the escalation trigger is misses
  recurring in practice — same posture as plans:lint).
- Linting capture-side manifest locators (persona-consistency `surfaces.json`) — those
  locate for observation, not regression locking, and already have quality warnings.
- Blocking by default — warn-first protects consumers with legacy spec suites.
- Dashboard/read-side surface for `selector_policy_violations` — the column is
  observation-only telemetry in v1; building a reader before anyone consumes the
  signal is the data-nobody-reads over-engineering cliff. Revisit when a consumer
  wants the trend.
- Semantic-locator inference from raw selector strings in `candidate-spec.mjs` (see
  work item G — schema follow-up, not v1).

## 5. Acceptance criteria

1. A dry-run LOCK generation against a demo fix produces a spec whose locators are
   `getByRole`/`getByTestId` (or justified-structural), and the a11y include is
   non-CSS or justified.
2. The lint catches an unjustified `locator('#x')` in a fixture spec (test proves it)
   and passes a justified one (same-line and line-above marker forms). It ALSO
   catches non-prefix structural forms (`button#add`, `div.card .title`, chained
   `row.locator('.cell')`, `[class~=…]`, template-literal arguments) AND
   deny-by-default forms with no id/class at all (`locator('button')`,
   `[name="email"]`, `:nth-child(2)`, `[href=…]`) — proven by the §3E fixture
   matrix. Semantic-allowlist selectors (`[data-testid]`, `[data-engine-claim]`,
   `[role]`, `[aria-*]`, optional tag prefix) are the only clean `locator()` strings.
3. A bare `selector-policy: structural` marker with no reason does NOT suppress a
   violation.
4. An app-module import in a fixture spec (`../../src/…`) is caught as
   `app-module-import` in static, dynamic-`import()`, and `require` forms;
   helper/test-root relatives and bare npm specifiers (`@playwright/test`,
   `node:*`, `@faker-js/faker`, `lodash`) are not. A mapped alias into app source
   is caught; an unmapped alias yields the non-counting `unresolved-alias-import`
   warning.
5. `--strict-selectors` fails the run on an unjustified violation; default mode warns
   and records the count with the run row; on an unmigrated DB the write retries once
   without the field on Postgres `42703` only (any other error still propagates).
6. The runner scans the final resolved spec set (post-glob) AND each spec's
   relative-import closure within the test root; an empty set, an unreadable file,
   or an unresolvable closure import exits non-zero as unverified — never
   "0 violations". A structural locator or app import moved into a local helper is
   still caught (fixture proves it).
7. VERIFY-mode template/translation rules match the same policy.
8. `renderCandidateSpec` output for structural locator kinds carries the marker;
   determinism test still passes.
9. `selector-policy.mjs` is covered by the relocation-guard library-import test.
10. `npm test`, `npm run skills:check`, `npm run check` all green; `npm run sync:dry`
    shows the expected consumer delta and nothing else.

## 6. Test plan

- `tests/ux-lock-selector-policy.test.mjs` — scanner unit tests (full fixture matrix
  per work item E: structural forms incl. non-prefix, unresolvable, imports, marker
  attachment/reason/stale rules, semantic-clean cases).
- `tests/ux-lock-run.test.mjs` — runner wiring: warn output (violations + justified
  counts), strict exit, empty-resolved-set non-zero, count persistence +
  `42703`-only fallback discrimination.
- `tests/ux-lock-candidate-spec.test.mjs` — marker emission + determinism.
- `tests/relocation-guard.test.mjs` — `selector-policy.mjs` import entry (Tier-3,
  same commit as the module).
- Existing suite green (Tier-1 seams untouched except additive).

## 7. Audit trail

- R1 (GPT-5.5, 2026-07-03): SIGNIFICANT_GAPS — H:3 M:4 L:1, all accepted, no
  rebuttals. H1 scanner-false-green → §2.3 rewritten to argument-content
  classification + fixture matrix; H2 sync/relocation Tier-3 → relocation-guard
  entry + sync:dry close-out; H3 shell-mode docs-only → `app-module-import` lint
  class; M1 persistence trace → writers named + `42703`-only fallback; M2 marker
  grammar → reason mandatory + tight attachment + stale-marker; M3 → no semantic
  inference (narrowed); M4 → hook-accuracy ladder; L1 (+ first-run siblings) →
  empty-scan honesty + justified-count observability.
- R2 (GPT-5.5, 2026-07-03): NEEDS_REVISION — H:1 M:3 L:1 (HIGH 3→1), all accepted,
  no rebuttals. H1 denylist-treadmill → classifier flipped to
  **allowlist-semantics/deny-by-default** (`classifySelector` = single exported
  policy oracle); M1 → runner-owned resolved-set contract (scanner set ≡ executed
  set by construction; unreadable-in-set fails closed); M2 self-generated
  stale-markers → candidate-spec reuses `classifySelector`, marker only on
  structural; M3 → dynamic-import coverage + precise allowlist (test-root
  resolution, axe packages named); L1 → column semantics pinned (unjustified
  violations only, `COMMENT ON COLUMN`).
- R3 (GPT-5.5, 2026-07-03): NEEDS_REVISION — H:1 M:2 L:1 (HIGH plateaued 1→1 →
  GPT loop stops at the 3-round cap), all accepted, no rebuttals. H1
  helper-evasion → relative-import **closure scanning** within the test root
  (visited-set, depth 8, fail-closed unresolvables); M1 → deterministic
  `resolveTestRoot` ladder supplied by the runner; M2 → comment-stripped
  multi-line call-site scan with original-line mapping; L1 → violation classes
  fixed at three, `staleMarkers` a separate non-counted field.
- Gemini gate R1 (gemini-3.1-pro, 2026-07-03): CONCERNS — 2 findings, both
  accepted (both missed by all 3 GPT rounds). G1 (HIGH): allowlist accidentally
  prohibited ordinary npm test deps → bare specifiers allowed by default; the
  prohibition targets app SOURCE. G2 (MEDIUM): path aliases (`~/`, `@/`) map into
  app source but look bare → optional alias map (`--alias`, tsconfig `paths`
  best-effort); mapped-outside-test-root → violation; unmapped →
  `unresolved-alias-import` non-counting warning (documented v1 limit).
- Gemini gate R2 (gemini-3.1-pro, 2026-07-03): CONCERNS — 4 findings, all
  accepted. G1 (HIGH, concrete correctness → earns the one-extra-round
  exception): import detection false-matches inside string literals and
  fail-closes on hallucinated paths → string/template literals masked before
  detection (argument literals recovered via index map). G2 (MEDIUM):
  multi-project `testDir` first-found-wins misclassifies → containment filter,
  deepest wins, per-spec resolution. G3 (LOW): JSONC tsconfig would crash
  `JSON.parse` → tolerant read, degrade to no-alias-map. G4 (LOW): relocation
  coverage goes in `LIB_IMPORT_SET` (sync-isolation-verify.mjs), not the test
  file (single source of truth). R3 is the final gate round per the
  genuine-bug exception; further robustness nits will be captured for the code
  audit, not re-gated.
- Gemini gate R3 (gemini-3.1-pro, 2026-07-03): CONCERNS — 2 MEDIUM, zero HIGH;
  finding character decayed to attribution/boundary refinements → **gate STOPPED
  per the cap rule** (2-round cap + one genuine-bug exception round consumed).
  Both folded in, to be verified at code audit: G1 per-spec-row violation
  attribution (never the run-global total ×N); G2 import-legality containment
  uses the outermost test-root candidate (nested project testDir must not flag
  shared sibling helpers). GATE CLOSED — plan approved for implementation.

### Code-audit trail (implementation, 2026-07-03/04)

- Implemented autonomously via `/cycle --autonomous` (degenerate single-cluster).
- CODE R1 (GPT-5.5): H:7 M:14 L:1 → fixed with tests: repoRoot… (see ledger);
  GPT deliberation overruled all 15 disputes in Claude's favor except M5
  compromise (marker provenance wording — applied).
- CODE R2: H:6 M:10 L:3 → 11 fixed with tests (tokenEnv `js()` quoting,
  template-`${}` expression scanning, verify-doc PowerShell-safe/ESM rewrite,
  V3-ownership note, verify `--strict-selectors`, `.jsx` resolver extensions,
  `getElementBy*` call sites, `process.execPath`); GPT deliberation: H4/H6
  dismissed (pre-existing store paths, independent), R2-M4 compromise applied
  (strict + `--specs` glob now fails closed as `SELECTOR_STRICT_GLOB_UNRESOLVED`
  before any execution).
- CODE R3: H:3 M:7 L:1 — decayed to re-raises of deliberation-overruled store
  findings + pre-existing sync-verifier paths → GPT loop stopped at the 3-round
  cap. Net-new nits fixed: nested-template depth safety, prevWord
  regex/division disambiguation, reference-doc strict flag, explicit scan
  inputs (no ambient `opt()`).
- **Consolidated Gemini gate over the union diff (21 files): APPROVE, 0 new
  findings, 0 wrongly-dismissed.** Full suite 4336 passing; `npm run check`
  green; `sync:dry` delta as expected.
- Debt captured (pre-existing, independent — store/sync maintenance):
  `updatePlanStatus` rowCount verification, candidate upsert vs partial unique
  index, NULL-`repo_id` upsert semantics, `RUN_CONTEXTS` schema mirror,
  `walkDir` readdir tolerance in sync-isolation-verify, gate2B manifest-path
  hardcoding, skipped-vs-failed verify criterion distinction.

---

## 11. Implementation clusters

- **Cluster 1 — Policy docs (A, B, C, D, F)**: SKILL.md + 3 references. Pure markdown;
  ends with `npm run skills:regenerate` + `skills:check`.
- **Cluster 2 — Lint + wiring (E)**: `selector-policy.mjs`, `ux-lock-run.mjs`,
  migration, tests. Depends on marker grammar frozen in Cluster 1.
- **Cluster 3 — Sibling generators (G)**: `candidate-spec.mjs` + its tests + the
  ship/persona-test template sweep verification.
- **Cluster 4 — Docs + consumer note (H)**: consumer-adoption.md, AGENTS.md bullet,
  final regenerate + full `npm run check`.

## Implementation Log

### 2026-07-04
- Completed: everything in work items A–H, via `/cycle --autonomous` (degenerate
  single-cluster). New `scripts/lib/ux-lock/selector-policy.mjs`; runner wiring +
  `--strict-selectors`; migration `20260703200000` + 42703-only write fallback;
  candidate-spec markers via the shared `classifySelector`; SKILL.md + 3 references;
  consumer-adoption + AGENTS.md notes; LIB_IMPORT_SET relocation entry; +67 tests.
- Remaining: nothing in scope. Debt captured in §7 (pre-existing store/sync items).
- Deviations from the audited plan (all audit-adjudicated during code rounds):
  (1) strict + `--specs` glob now REFUSES (`SELECTOR_STRICT_GLOB_UNRESOLVED`) instead
  of post-run-only reconcile (GPT R2-M4 compromise — strict must not execute before
  enforcement; warn mode keeps the post-run reconcile);
  (2) auto-marker reason wording states generator provenance + promotion-upgrade
  guidance (GPT R1-M5 compromise);
  (3) scanner hardening beyond plan text: template-`${}` expression visibility,
  prevWord regex/division disambiguation, `getElementBy*` call sites, `.jsx`
  resolver extensions, repoRoot-anchored testRoot walk, comment-context
  sanitization + `js()`-quoted tokenEnv in candidate-spec.
