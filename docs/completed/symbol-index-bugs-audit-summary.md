# Audit Summary — symbol-index-bugs

**Plan**: docs/plans/symbol-index-bugs.md
**Scope**: --scope diff (4 files modified + 2 new)
**Rounds**: 3 (R1 → R2 → R3)

## Convergence rationale

Stopped at R3 per repository convention ("Beyond round 2-3 GPT pushes for rigor, not bugs. Stop when HIGH count plateaus." — saved memory `feedback_audit_loop_convergence.md`).

| Round | Verdict | H | M | L | New (vs prior) | Outcome |
|---|---|---|---|---|---|---|
| R1 | NEEDS_FIXES | 0 | 7 | 1 | 8 | 5 in-scope adjudicated, 3 out-of-scope → debt |
| R2 | NEEDS_FIXES | 0 | 4 | 2 | 4 new (re-categorisations) | All re-raises adjudicated; M1/M2 DISMISSED, M3/M4 → LOW |
| R3 | NEEDS_FIXES | 0 | 4 | 2 | 0 (all R1/R2 re-raises) | Convergence stop — no new substantive findings |

HIGH plateau at 0 for all rounds. R3 findings have new fingerprint hashes but are categorical re-issues of R1/R2 concerns already adjudicated.

## Adjudications

### Fixed in implementation

- **M1, M2, L1 (R1)** — Plan path drift. Updated docs/plans/symbol-index-bugs.md to cite the actual repo test path `tests/thin-delegate.test.mjs` and note that `wine-cellar-app` references are historical provenance, not file-path assertions. **GPT R2 confirmation: DISMISSED**.
- **M3 (R1)** — Quick-fix architecture (skip-at-extract vs classify-downstream). GPT compromise: keep the design, but ship visibility preservation in same change-set. **Added `--include-delegates` flag** to extract.mjs + refresh.mjs with debug-only WARNING when used.
- **M4 (R1)** — Brittle heuristic. GPT compromise: tighten regex to require pure argument-passthrough. **Tightened regex** to identifier-or-spread-only args; added 7 new negative tests (`x ?? defaultVal`, `x + 1`, `{...payload, ts}`, ternary, string literal, etc).

### Deferred as out-of-scope debt

(captured in `.audit/tech-debt.json`)

- **M5 (R1)** — Missing IO error handling in extractSymbols — pre-existing.
- **M6 (R1)** — Hardcoded TS enum literals (`99, 99, 100`) — pre-existing.
- **M7 (R1)** — extractSymbols cognitive complexity 47 (was 46; +1 from early-continue) — pre-existing.

### Documented as limitations

- **M3 (R2 LOW compromise)** — Parameter-reordering and closed-over identifiers cannot be detected without parameter info. Added explicit limitation block in `scripts/lib/symbol-index/thin-delegate.mjs` JSDoc.
- **M4 (R2 LOW compromise)** — `--include-delegates` doesn't persist snapshot mode. Added loud WARNING in extract.mjs main() and refresh.mjs; deferred snapshot-mode persistence until real misuse observed.

## Files changed

| File | Change |
|---|---|
| `scripts/symbol-index/refresh.mjs` | +force-abort path (Bug 1); +`--include-delegates` flag passthrough + warning |
| `scripts/symbol-index/extract.mjs` | +`isThinDelegate` filter (Bug 2); +`--include-delegates` flag + warning |
| `scripts/lib/symbol-index/thin-delegate.mjs` | NEW — heuristic helper with argument-passthrough rule + limitation docs |
| `tests/thin-delegate.test.mjs` | NEW — 29 unit cases (15 original + 7 M4 + 5 Gemini-R1 + 2 Gemini-R2) |
| `docs/plans/symbol-index-bugs.md` | Updated test path + M3/M4 audit-ruling annotations |
| `.audit/tech-debt.json` | +3 debt entries (M5/M6/M7 out-of-scope) |

## Gemini final review (Step 7)

| Run | Verdict | New findings | Outcome |
|---|---|---|---|
| Gemini R1 | CONCERNS_REMAINING | 1 — FunctionExpression prefix bug | **Fixed** — added prefix-strip for `name = function(...)` form; 5 new tests cover named/anonymous/return-FE/operator-FE |
| Gemini R2 | CONCERNS_REMAINING | 2 — (a) async function FE false negative, (b) `git log --grep` injection | (a) **Fixed** — added `(?:async\s+)?` to both FE-strip regexes; 2 new tests for async FE. (b) **Dismissed** — `git log --grep` lives in `scripts/explain-history.mjs` which is not in this PR's diff (Gemini hallucination from prior-round context). |

After R2, all valid Gemini concerns scoped to this PR have been resolved. The remaining out-of-scope hallucination is documented here and will not appear in subsequent audits because the file in question isn't in this diff.

## Test results

- `tests/thin-delegate.test.mjs`: 29/29 pass
- Full suite: 1887/1888 pass (1 pre-existing failure in `vendoring-provenance.test.mjs` unrelated to this PR — local-only gitignored provenance is stale)
