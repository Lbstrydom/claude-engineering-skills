---
summary: LOCK mode — full Playwright spec template + fix-type assertion map + persistence recipe.
---

# LOCK Mode — Spec Generation

LOCK mode pins a fix's public DOM contract so the fix doesn't silently
regress. The generated spec asserts on semantic contracts (roles, aria-*,
data-testid, axe violations), never on CSS classes or internal state.

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

    // Drive the component/feature directly
    // ...

    // Assert on public DOM contract
    await expect(page.locator('...')).toBeVisible();
    // or: await expect(page.locator('...')).toHaveAttribute('role', 'list');
    // or: await expect(page.locator('...')).toHaveCount(n);
  });

  test('a11y — no WCAG violations', async ({ page }) => {
    await page.goto('/');
    // Set up the state that triggers the fix
    // ...
    await expectNoA11yViolations(page, { include: '#relevant-container' });
  });
});
```

## Fix-type → assertion map

| Fix type | Assertions |
|---|---|
| **Missing attribute** (role, aria-*) | `toHaveAttribute('role', 'list')` |
| **Modal behaviour** | Element appears → action → element disappears |
| **Data rendering** | Container has expected child count or text |
| **Navigation** | Click → URL changes → content visible |
| **Form validation** | Invalid state → button disabled; valid → enabled |
| **Error handling** | Trigger error → error message visible → recovery works |
| **Accessibility** | `expectNoA11yViolations` on the relevant container |

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
  --source-kind audit-loop-fix    # or persona-test-p0 | persona-test-p1 | manual
  # [--specs <glob>]   run + group a suite by spec_path (one run row per file)
  # [--url <base-url>] exported to the spec as E2E_BASE_URL
  # [--no-register]    record nothing (spec is unknown / throwaway)
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
| Commit from `/audit-loop` converged fix | `audit-loop-fix` |
| Commit or description tied to a `/persona-test` P0 | `persona-test-p0` |
| Same for P1 | `persona-test-p1` |
| Plain-text description / manual use | `manual` |
