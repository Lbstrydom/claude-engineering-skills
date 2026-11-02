---
summary: Consistency-mode runner steps (Step C2) and the Step C4 report fence, including the RIG BROKEN callout.
---

# Consistency mode — runner steps and report fence

Companion to `consistency-mode.md` (grammar, contradiction kinds, exit codes).

## What the runner does (SKILL.md Step C2)

Use this mode to detect cross-step UI/state contradictions (the engine says
"infeasible" but a CTA says "Reorganise") against a registered canary journey.

The runner:
1. Resolves `surfaces.json` from `.persona-test/` → `<repo-root>/` → `src/` (first match wins).
2. Loads `.persona-test/canaries/<name>.json` and validates against `CanaryDefinitionSchema`.
3. Drives Playwright through `canary.journeySteps[]` deterministically (no LLM in the loop).
4. Captures `{surfaceClaims, networkClaims}` synchronously per step via `scripts/lib/ux-lock/capture.mjs`.
5. Diffs DOM vs network ground truth via `scripts/lib/persona-test/consistency.mjs`.
6. Emits candidate `regression_specs` rows for P1+ contradictions (fingerprint-upserted).
7. Verifies the canary's `expectedContradictions` and decides the exit code.

## Report fence (SKILL.md Step C4)

Render this fence to stdout:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  CONSISTENCY MODE REPORT
  Canary: <name>
  URL: <url>
  Verdict: <healthy | broken | partial | fatal | app-error>
  Exit: <code>
  Contradictions: <n>   Candidates emitted: <n>   Warnings: <n>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FINDINGS
────────────────────────────────────────────────────
  [<severity>] <kind> at <surfaceId>.<engineField>
     DOM:      <value>   (data-freshness="<freshness>")
     Engine:   <value>
     Selector: <selector>
     Detail:   <one-line>
  ...

OVERALL: <one-line verdict>
```

Sort findings by severity (P0 first), tie-break by surfaceId. If the canary
verdict is `broken`, lead with a one-line callout above the report:

```
⚠ RIG BROKEN — canary expected min:N contradictions, found M.
  Manifest drift or attribute regression suspected — fix before next run.
```

---
