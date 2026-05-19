# Audit Summary — Local Dashboard Subsystem

- **Plan**: [docs/plans/local-dashboard.md](local-dashboard.md)
- **Date**: 2026-05-19
- **Verdict**: CONVERGED · Gemini final review **APPROVE**

## Code audit (/audit-code)

| Round | Findings | Fixed | Dismissed |
|---|---|---|---|
| R1 | H4 M18 L7 | 14 | 13 (out-of-scope / by-design; H2+H4 conceded by GPT on rebuttal) |
| R2 | H2 M10 L2 | 7 | 7 (ledger-recorded) |
| R3 | H3 M11 L2 | 8 | 6 (ledger-recorded) |
| R4 | H1 M10 L2 | 7 | 6 (over-applied egress rule, raw-row Zod, inherited limits) |

HIGH count 4 → 2 → 3 → 1, driven to 0 in-scope. 36 findings fixed, 32
dismissed with a 13-entry adjudication ledger. Gemini final review:
**APPROVE** — 0 new findings, 0 wrongly-dismissed.

## Notable fixes

- **Security**: HTML/JSON output encoding (escapeHtml + script-safe JSON);
  serve.mjs path containment + Host-header allowlist (DNS-rebinding);
  `no-store` on every response path; secret redaction of error detail.
- **Crash fix**: `openBrowser()` now handles the async child-process
  `error` event (an unhandled one would crash the server).
- **Degraded-mode data loss**: renderer sections (`auditRuns`, `plans`,
  `flows`) now show a warning *prefix* but still render usable fallback
  data instead of discarding it.
- **Error classification**: collectors distinguish `ENOENT` (missing-optional)
  from `EACCES`/other I/O faults (unexpected-error).
- **Purity**: `render.mjs` is pure (assets injected); `getLearningStats()`
  is pure (env fallback moved to the CLI wrapper).
- **Silent-failure fix**: `fetchCloudMetrics()` now inspects Supabase
  `.error` instead of swallowing it as an empty result.

## Deferred (technical debt)

- Per-repo filtering of telemetry Audit-Runs — currently project-wide,
  labelled honestly in the UI. Real filtering = v2.
- `collectRequirements` parses `ledger.json` directly rather than via the
  `lib/requirements` schema — acceptable for a read-only display.

## Verification

- Full suite: **2359 pass / 0 fail** (`npm test`), incl. 19 dashboard tests.
- `npm run dashboard:build` → both pages, exit 0, non-degraded.
- `npm run skills:check` → IN SYNC.
