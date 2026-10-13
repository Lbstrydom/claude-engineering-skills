# Audit summary: cli-entry-guard-migration

- **Plan**: [cli-entry-guard-migration.md](cli-entry-guard-migration.md)
- **SID**: `audit-code-1791884686037-60208` (2026-10-13), base `origin/main` ff3c790b
- **Result**: CONVERGED at round 4 (rounds 3 and 4 clean, file coverage complete). Gemini final gate APPROVE, gate `approve` (0 blocking, 0 debt).

| Round | Scope | Verdict | H/M/L | Coverage |
|---|---|---|---|---|
| 1 | full diff, 135 files | SIGNIFICANT_ISSUES | 29/2/0 | partial: 2 changed lines in `solo-control-audit.mjs` never rendered; 10 audit-infra files excluded by policy |
| 2 | 6 fixed scripts, 2 tests, `solo-control-audit.mjs`, `cli-entry.mjs` | PASS | 0/1/0 | complete |
| 3 | census test + 2 dependents | PASS | 0/0/0 | complete |
| 4 | census test + 4 dependents | PASS | 0/0/0 | complete |

## Dispositions (round 1, 31 findings)

- **Fixed (H5/H16).** Top-level `--selfcheck-relocation` handlers ran at import time and bypassed the entry guard. An AST census found 10. Six sit in modules that have a guard (`audit-clean`, `cache-hitrate-check`, `context-staleness`, `maintenance-checks`, `sync-status`, `workflow-cadence-doctor`), and those six are now gated with `&& isInvokedAsScript(import.meta.url)`. Before the fix, a host importing the HEAD version of `audit-clean` with the flag in its argv printed `OK` and was terminated. After the fix the host survives, and selfcheck still prints `OK` 6/6, directly and through a junction. The other four have no guard: their whole module is the CLI. The census is a test in `tests/cli-entry-guards.test.mjs`. It was red with exactly the six and is green after.
- **Dismissed as invalid (H10/H28).** `check-visual-contract-doc-drift --json` is claimed to exit 0 on drift. It does not: `emit({ok:false})` from `lib/cli-io.mjs` sets `process.exitCode ||= 1`.
- **Dismissed as a coverage notice (M2).** Adjacency caps at 60 changed files. A per-guard loader probe compensates (see the plan §6).
- **Deferred (26), out-of-scope and independent.** These are pre-existing defects inside `main()` of files whose only change is the final entry-guard expression: 20 in `solo-control-audit.mjs`, plus friction-log, ledger-decompose, the requirements-ledger content, CLI option validation and write-then-exit. The guard reads only `import.meta.url` and `process.argv[1]`, and shares no state, column, constraint or transaction with the cited code. All 26 were captured to the debt ledger. Most are "plausible, not reproduced". H11 (friction-log cloud setup sits outside its try) was read and confirmed.

## Round 2

- **Fixed (M1).** The new import-time census read one line at a time. It now reads each top-level `if` condition to its balancing paren, with fixtures in both directions. Proven red by reverting one fix (it names `scripts/audit-clean.mjs:37`), then green.

## Census

| Unit | State |
|---|---|
| structure, wiring, backend, sustainability | completed |
| frontend | ineligible (no frontend files) |
| quickfix (wave) | completed |
| duplication (wave) | completed |
| adjacency (wave) | completed round 1 as control-unavailable: 135 changed files exceeds the cap of 60. Compensated by the loader probe |
| arch-memory | ineligible (`--scope diff`) |
| detectors | completed: 0 recorded, 0 checked |
| file coverage | completed at convergence (rounds 2-4). Round 1 was partial; see the table |
| Gemini envelope | partial: 286 changed lines across the 135-file change were not shown to the final reviewer, so its APPROVE covers the examined files |
