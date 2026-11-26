# Audit summary — test-runner-hang-guard

- **Plan**: [`test-runner-hang-guard.md`](test-runner-hang-guard.md) (revision 2)
- **Date**: 2026-11-26
- **Session**: `audit-code-1795728511480-92916`
- **Scope**: `--scope diff` R1 over `d5c6a3b0` (11 files), then R2+ diff-scoped to each round's fix commit.
- **Audited head**: R6, the commit after `c61657fa`. Final gate: APPROVE in round 1 (R5) and round 2 (R6), 0 blocking.

## Result — final gate APPROVE (round 5 PASS, H:0 M:1 fixed)

| Round | Verdict | H | M | Accepted / dismissed | Notable |
|---|---|---|---|---|---|
| R1 | SIGNIFICANT_ISSUES | 9 | 9 | 16 / 2 | owner (ppid) filter, supersede on pid reuse, last-occurrence `--test-timeout`, stall-check errors fail the run, `finishAndExit` on setup errors, bounded controls; H9 sustained on rebuttal → end-of-run record reconciliation |
| R2 | SIGNIFICANT_ISSUES | 1 | 3 | 4 / 0 | reconciliation rejects seq gaps, missing load, unended tests, and an unavailable inventory; glob-named files |
| R3 | SIGNIFICANT_ISSUES | 1 | 1 | 2 / 0 | any named regular file is instrumented (extensionless included) |
| R4 | SIGNIFICANT_ISSUES | 2 | 1 | 3 / 0 | named-file manifest instead of one env string; operands after `--` |
| R5 | PASS | 0 | 1 | 1 / 0 | the manifest variable is scrubbed from children |
| R6 | PASS | 0 | 0 | — | delta after a full-suite failure of the watchdog control under load: the watchdog now stops each live test child's tree before the runner's; the control waits for termination |

Dismissed (R1): M8, a coverage bound of the adjacency wave (`maxContainers`), not a defect; M9, the preload has no static
importer by design (node loads it through `--import`). M7 (duplication with fleet's private `isTestFile`) carries a
`@duplicate-justification` pragma: different contract, and shared-lib may not import fleet.

GPT stopped after R5 at PASS with its one finding fixed: rounds 3-5 had narrowed to argument-parsing edge cases of
explicitly named files. The final gate (Gemini) returned APPROVE, `gateDisposition: approve`, 0 blocking, 0 debt.

## Census (R1)

| Identifier | State |
|---|---|
| structure, wiring, backend, frontend, sustainability | completed |
| quickfix, duplication | completed |
| adjacency | uncovered (`maxContainers=33` reached; R2-R5 re-read the changed files narrowly) |
| arch-memory | ineligible (`--scope=diff`) |

## Negative controls (each mechanism disabled, its control seen red, then restored)

no stall kill · no watchdog kill · no preload · pairing by name (unit test; the real-runner control cannot see it, both
instances print alike) · watchdog below the stall limit · stall limit below 2x the slowest test · first-occurrence timeout ·
no named-file instrumentation · no owner filter · no supersede · a swallowed stall-check error.
Not controlled deterministically: the Windows reap from the dead runner's pid (a `taskkill /T` snapshot race, seen once under
load and not reproducible on demand).
