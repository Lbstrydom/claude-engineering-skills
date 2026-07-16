/**
 * @fileoverview Per-skill applicability rules for the fit-check diagnostic.
 *
 * Each entry is `{ skill, evaluate }` where `evaluate(profile)` returns
 * a verdict object `{ label, reason, setup? }`:
 *
 *   - `label: 'FITS'`     — drop in, the shape matches
 *   - `label: 'PARTIAL'`  — works but needs setup (described in `setup`)
 *   - `label: 'MISMATCH'` — unlikely to apply to this shape; `reason` explains
 *
 * Rules are evaluated left-to-right; the first verdict returned wins. Each
 * skill returns exactly one verdict.
 *
 * Adding a new skill = one entry here + one fixture-driven assertion in
 * tests/skills-fit-check.test.mjs.
 *
 * @module scripts/lib/fit-check/rules
 */

export const SKILLS = [
  // ── Universal skills — work in any Node/Python repo with an API key ─────
  {
    skill: '/plan',
    evaluate: (p) => ({
      label: 'FITS',
      reason: 'Universal planner; no stack assumptions.',
    }),
  },
  {
    skill: '/audit-plan',
    evaluate: (p) => ({
      label: 'FITS',
      reason: 'Iterative plan refinement; works on any plan document.',
    }),
  },
  {
    skill: '/audit-code',
    evaluate: (p) => {
      if (p.stack === 'unknown') {
        return {
          label: 'PARTIAL',
          reason: 'No recognised stack (package.json or pyproject.toml).',
          setup: 'audit will still run on whatever files exist; you may want to add a recognised manifest first.',
        };
      }
      return { label: 'FITS', reason: `Multi-pass code audit for ${p.stack}.` };
    },
  },
  {
    skill: '/ship',
    evaluate: (p) => {
      if (!p.testRunner && p.stack !== 'unknown') {
        return {
          label: 'PARTIAL',
          reason: 'No test runner detected.',
          setup: 'install vitest/jest/pytest (or use --no-tests to acknowledge), otherwise ship will block on the test gate.',
        };
      }
      return { label: 'FITS', reason: 'Commit + push with pre-push gates.' };
    },
  },

  // ── UI testing skills — shape-bound ────────────────────────────────────
  {
    skill: '/ux-lock (lock mode)',
    evaluate: (p) => {
      if (p.isPlugin) {
        return {
          label: 'MISMATCH',
          reason: 'Obsidian plugin UI is not URL-addressable; Playwright cannot navigate to it the way the skill expects.',
        };
      }
      // ux-lock generates Playwright specs that assert on rendered DOM —
      // requires a UI surface, not just an HTTP boundary. Pure API repos
      // (FastAPI / Express-only / etc.) have no DOM to lock.
      if (!p.hasUiRoutes) {
        return {
          label: 'MISMATCH',
          reason: 'No UI routes detected; ux-lock generates Playwright specs for rendered DOM.',
        };
      }
      if (!p.hasPlaywright) {
        return {
          label: 'PARTIAL',
          reason: 'UI surface present but Playwright is not installed.',
          setup: 'npm i -D @playwright/test && npx playwright install chromium',
        };
      }
      return { label: 'FITS', reason: 'Playwright + UI routes detected.' };
    },
  },
  {
    skill: '/ux-lock verify',
    evaluate: (p) => {
      if (p.isPlugin) {
        return {
          label: 'MISMATCH',
          reason: 'Plugin UI is not URL-addressable; verify mode launches a browser at a URL.',
        };
      }
      if (!p.hasUiRoutes) {
        return {
          label: 'MISMATCH',
          reason: 'No UI routes; verify mode grades a plan against a rendered surface.',
        };
      }
      if (!p.hasPlansDir) {
        return {
          label: 'PARTIAL',
          reason: 'UI present but no docs/plans/ directory yet.',
          setup: 'run /plan first to author a Section 10 acceptance-criteria block, then verify can grade it.',
        };
      }
      if (!p.hasPlaywright) {
        return {
          label: 'PARTIAL',
          reason: 'Plans exist but Playwright is not installed.',
          setup: 'npm i -D @playwright/test && npx playwright install chromium',
        };
      }
      return { label: 'FITS', reason: 'Plans + Playwright + UI routes detected.' };
    },
  },
  {
    skill: '/persona-test (exploratory)',
    evaluate: (p) => {
      if (p.isPlugin) {
        return {
          label: 'PARTIAL',
          reason: 'Plugin runtime — the URL-launch path does not apply, but CDP-attach can drive it.',
          setup: 'see scripts/persona-harness/driver.mjs in the ai-organiser repo for the CDP pattern; the skill bundle does not yet ship this adapter.',
        };
      }
      if (!p.hasUiRoutes && !p.hasHttpBoundary) {
        return {
          label: 'MISMATCH',
          reason: 'No web surface; exploratory mode drives a deployed URL via Playwright MCP.',
        };
      }
      return {
        label: 'PARTIAL',
        reason: 'Web surface detected.',
        setup: 'set PERSONA_TEST_APP_URL in .env (deployed URL); Playwright MCP must be enabled in your client.',
      };
    },
  },
  {
    skill: '/persona-test (consistency mode)',
    evaluate: (p) => {
      if (p.isPlugin) {
        return {
          label: 'MISMATCH',
          reason: 'Consistency mode captures HTTP responses for ground-truth; plugins have no HTTP boundary between engine and DOM.',
        };
      }
      if (!p.hasHttpBoundary) {
        return {
          label: 'MISMATCH',
          reason: 'No HTTP API boundary; consistency mode diffs DOM claims against captured network responses.',
        };
      }
      if (p.hasPersonaTestManifest && p.hasEngineClaimAnnotations) {
        return { label: 'FITS', reason: 'data-engine-claim annotations + surfaces.json manifest already present.' };
      }
      const missing = [];
      if (!p.hasEngineClaimAnnotations) missing.push('data-engine-claim attributes on key surfaces (see docs/reference/consistency-contract.md)');
      if (!p.hasPersonaTestManifest)    missing.push('.persona-test/surfaces.json manifest + a broken-canary journey under .persona-test/canaries/');
      return {
        label: 'PARTIAL',
        reason: 'Shape fits but the contract is not yet adopted.',
        setup: `to enable: ${missing.join('; ')}.`,
      };
    },
  },
  {
    skill: '/ship Step 5.6 (consistency promotion)',
    evaluate: (p) => {
      if (p.isPlugin || !p.hasHttpBoundary) {
        return {
          label: 'MISMATCH',
          reason: 'Depends on consistency-mode adoption, which does not apply to this shape.',
        };
      }
      if (!p.hasPersonaTestManifest) {
        return {
          label: 'PARTIAL',
          reason: 'Consistency mode not yet adopted.',
          setup: 'authorise /persona-test consistency mode first; promotion engages automatically once candidates exist.',
        };
      }
      return { label: 'FITS', reason: 'Consistency mode adopted; promotion engages automatically.' };
    },
  },
];

/**
 * Apply every rule to a profile, returning a list of verdicts.
 * @param {import('./detect.mjs').ShapeProfile} profile
 * @returns {Array<{skill: string, label: 'FITS'|'PARTIAL'|'MISMATCH', reason: string, setup?: string}>}
 */
export function applyRules(profile) {
  return SKILLS.map((rule) => ({
    skill: rule.skill,
    ...rule.evaluate(profile),
  }));
}

/**
 * Group verdicts by label, preserving rule order within each group.
 * @param {ReturnType<typeof applyRules>} verdicts
 */
export function groupByLabel(verdicts) {
  return {
    fits:     verdicts.filter((v) => v.label === 'FITS'),
    partial:  verdicts.filter((v) => v.label === 'PARTIAL'),
    mismatch: verdicts.filter((v) => v.label === 'MISMATCH'),
  };
}
