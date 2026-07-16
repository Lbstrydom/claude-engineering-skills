---
summary: LOCK mode — full Playwright spec template + fix-type assertion map + persistence recipe.
---

# LOCK Mode — Spec Generation

LOCK mode pins a fix's public DOM contract so the fix doesn't silently
regress. The generated spec locates AND asserts via semantic contracts (roles,
aria-*, data-testid, axe violations), never via CSS classes or internal state.

## Selector policy (locating elements)

Every locator in a generated spec follows the ladder — take the FIRST rung that
works:

1. `page.getByRole(role, { name })`
2. `page.getByLabel(...)` / `page.getByPlaceholder(...)` (form controls)
3. `page.getByText(...)` (static user-visible copy)
4. `page.getByTestId(...)` (no accessible handle exists — add one via SKILL
   Step 1.5 if needed)
5. CSS `#id` / `.class` — last resort ONLY, with a mandatory justification marker
   on the same line or the line above:

   ```javascript
   // selector-policy: structural — third-party widget renders no roles or testids
   await expect(page.locator('#vendor-cal-root')).toBeVisible();
   ```

The run pipeline (`scripts/ux-lock-run.mjs`) lints every spec it runs for
unmarked structural selectors (including inside local helper imports): warn by
default, `--strict-selectors` fails the run. Never import app modules into the
spec — see `references/scope-and-limitations.md`.

## Generated spec template

```javascript
import { test, expect } from '@playwright/test';
import { loginAsTestUser } from './helpers/auth.js';
import { expectNoA11yViolations } from './helpers/axe.js';

/**
 * Regression lock for: <one-line description of fix>
 * Commit: <hash> — <commit message first line>
 * Covers:
 *   - <assertion 1>
 *   - <assertion 2>
 *   - <a11y assertion if applicable>
 */

test.describe('<fix description>', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsTestUser(page);
  });

  test('<primary assertion>', async ({ page }) => {
    await page.goto('/');

    // Drive the feature the way a user would
    await page.getByRole('button', { name: 'Add bottle' }).click();

    // Assert on public DOM contract
    await expect(page.getByRole('dialog', { name: 'Add bottle' })).toBeVisible();
    // or: await expect(page.getByTestId('cellar-grid')).toHaveAttribute('role', 'list');
    // or: await expect(page.getByRole('list')).toHaveCount(n);
  });

  test('a11y — no WCAG violations', async ({ page }) => {
    await page.goto('/');
    // Set up the state that triggers the fix
    // ...
    await expectNoA11yViolations(page, { include: '[data-testid="relevant-container"]' });
  });
});
```

## Fix-type → assertion map

| Fix type | Assertions (locate semantically per the ladder) |
|---|---|
| **Missing attribute** (role, aria-*) | `getByTestId(...)` → `toHaveAttribute('role', 'list')` |
| **Modal behaviour** | `getByRole('dialog')` appears → action → disappears |
| **Data rendering** | `getByRole('list')` / named container has expected child count or text |
| **Navigation** | `getByRole('link', { name })` click → URL changes → content visible |
| **Form validation** | `getByLabel(...)` invalid → `getByRole('button')` disabled; valid → enabled |
| **Error handling** | Trigger error → `getByRole('alert')` visible → recovery works |
| **Accessibility** | `expectNoA11yViolations` with a `[data-testid=…]` (or justified-structural) include |

## Naming convention

```
tests/e2e/<ticket-or-round>-<description>.spec.js
```

Examples: `r18-quality-gate.spec.js`, `fix-modal-close.spec.js`,
`pr42-wine-grid-a11y.spec.js`.

## Persistence — run + record in ONE deterministic call

`scripts/ux-lock-run.mjs spec` (SKILL Step 3) runs the authored spec, parses
the JSON report, and writes BOTH the `regression_specs` row (auto-registered by
`repo_id` + `spec_path`) and the `regression_spec_runs` outcome itself — no
separate `record-regression-spec` / `record-regression-spec-run` calls, no
hand-parsing, no shell-quoting of free text:

```bash
node scripts/ux-lock-run.mjs spec \
  --spec tests/e2e/<name>.spec.js \
  --commit <sha> --run-context ux-lock \
  --source-kind audit-code-fix \  # or persona-test-p0 | persona-test-p1 | manual
  --strict-selectors              # newly generated spec → lint FAILS (exit 6), not warns
  # [--specs <glob>]   run + group a suite by spec_path (one run row per file)
  #                    (globs are Playwright-expanded — NOT combinable with
  #                    --strict-selectors, which needs explicit paths to scan
  #                    before anything executes; warn mode reconciles post-run)
  # [--url <base-url>] exported to the spec as E2E_BASE_URL
  # [--no-register]    record nothing (spec is unknown / throwaway)
  # [--test-root <d>] [--alias prefix=dir]...  selector-policy scan inputs
```

The runner derives the `description` from the spec filename and supplies the
required `source_kind`. Cloud off → it runs + prints and skips recording (no
`specId` needed). A *failing* run is recorded as `passed:false` (the runner's
exit code is non-zero so `/ship`/CI can gate); it is the natural "regression
save" signal — a spec that should pass but doesn't surfaces in the
`regression_saves` view. Multi-spec runs (`--specs`) emit one
`regression_spec_runs` row per `spec_path` (passed = AND of that file's tests).

> Direct `cross-skill.mjs record-regression-spec[-run]` still exists for
> non-Playwright callers, but `/ux-lock` no longer drives them by hand — the
> runner is the single deterministic writer.

## Choosing `source_kind`

| Trigger | source_kind |
|---|---|
| Commit from `/audit-code` converged fix | `audit-code-fix` |
| Commit or description tied to a `/persona-test` P0 | `persona-test-p0` |
| Same for P1 | `persona-test-p1` |
| Plain-text description / manual use | `manual` |
