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

  {
    // NOT a slash-skill — a capability several skills lean on (/plan Phase 0.5,
    // the arch-memory hook, /audit-code's duplication wave). It earns an entry
    // because it is the one capability that fails on a LANGUAGE axis rather
    // than a shape axis, and nothing else surfaced that.
    //
    // Field report (2026-07-20): a Python consumer restored node_modules, ran
    // `arch:refresh`, and got `unsupported-stack`; render then wrote its
    // repo-not-registered stub. Every step reported itself honestly, but the
    // constraint was only discoverable by spending the effort and reading a
    // skip line. `symbol-index/refresh.mjs` short-circuits on
    // `stack !== 'js-ts' && stack !== 'mixed'` — the extractor is JS/TS-only
    // in v1 — so this verdict must track THAT condition exactly.
    skill: 'architectural memory (arch:refresh / arch:render)',
    evaluate: (p) => {
      // `stack` is a 4-value enum and cannot express "js-ts repo that also
      // carries .java" — that reports plain `js-ts`, clears the gate, and has
      // its Java half dropped exactly like a mixed repo's Python half. Check
      // stackKinds so the coarser enum's blind spot doesn't read as FITS.
      const unindexed = (p.stackKinds || []).filter(k => k === 'python' || k === 'java');
      if (p.stack === 'js-ts' && unindexed.length === 0) {
        return { label: 'FITS', reason: 'Symbol extractor supports js-ts.' };
      }
      if (p.stack === 'js-ts') {
        return {
          label: 'PARTIAL',
          reason: `Indexed as js-ts, but this repo also carries ${unindexed.join(', ')} sources — only JS/TS files are indexed.`,
          setup: 'Read the generated map as covering the JS/TS half ONLY. Do not treat "no duplicate found" as authoritative for the other sources.',
        };
      }
      // `mixed` clears refresh.mjs's stack gate, so the map BUILDS — but the
      // extractor's extension allowlist (sensitive-egress-gate.mjs
      // DEFAULT_EXT_ALLOWLIST) is .js/.jsx/.mjs/.cjs/.ts/.tsx/.vue/.svelte.
      // Every .py file is counted as `skippedExt`. The resulting map looks
      // complete while covering only the JS/TS half — a quieter failure than
      // the Python-only case, which at least aborts loudly. Say so.
      if (p.stack === 'mixed') {
        return {
          label: 'PARTIAL',
          reason: 'Mixed stack: the map builds, but only JS/TS files are indexed — .py sources are skipped as skippedExt.',
          setup: 'Read the generated map as covering the JS/TS half ONLY. Do not treat "no duplicate found" as authoritative for Python code.',
        };
      }
      return {
        label: 'MISMATCH',
        reason: p.stack === 'python'
          ? 'Symbol extraction is JS/TS-only in v1; arch:refresh skips Python with reason=unsupported-stack and arch:render writes a stub map.'
          : 'No JS/TS manifest with dependencies detected; arch:refresh skips and arch:render writes a stub map.',
        setup: 'No action available — the other skills do not depend on this. /plan, /audit-plan, /audit-code and the browser lenses work without an indexed repo.',
      };
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
        setup: 'set PERSONA_TEST_APP_URL in .env (deployed URL), OR pass a URL directly ' +
          '("/persona-test \\"<persona>\\" http://localhost:3000", "/cycle ... --persona-url <url>") ' +
          'if you only run a local dev server; Playwright MCP must be enabled in your client.',
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
