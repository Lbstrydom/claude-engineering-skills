# Audit summary: sync-to-repos failure honesty

- **Plan**: [sync-to-repos-failure-honesty.md](sync-to-repos-failure-honesty.md)
- **Date**: 2026-10-13
- **Session**: `audit-code-1791879647152-35124`
- **Outcome**: Gemini final gate `approve` in round 2 of 2, with 0 blocking findings and 0 debt. GPT reached its 6-round cap; the last fix (R6 H1) landed after R6, and it was covered by the round-2 final gate and the adoption e2e.

## Rounds

| Round | Scope | Result | Disposition |
|---|---|---|---|
| R1 | `--scope diff --base be057735` | H:2 M:5 | 5 fixed (`-z` NUL-delimited git grep, incomplete search ≠ 0, merged e2e steps, plan drift), 2 dismissed (M2 is the pre-existing documented sync-to-repos/sync-inventory duplication; M5 is an adjacency enumeration-cap notice) |
| R2 | R1 fixes | PASS | |
| R3 | R1 fixes plus neighbours | PASS | detector census clean |
| R4 | `scripts/sync-to-repos.mjs` with `--allow-infra-scope` | PASS | **weak evidence**: the file is 147K chars, and the passes rendered at most 15.6K, head-cut |
| — | adversarial review agent over `git diff be057735..HEAD` (substitute for the unread hunks) | 0 HIGH/MEDIUM, 2 LOW | both fixed: keep the journal for a failed write with no base; carry a GC failure only while the path resolves |
| R5 | LOW fixes | H:2 M:1 | all fixed: the missing-source skip carries its base; `mayStillExist` drops an entry only on a confirmed absence |
| R6 | R5 fixes | H:1 | fixed: the keep-journal decision uses `mayStillExist` |
| Gemini R1 / R2 | full change | APPROVE / APPROVE | |

## Census

| Row | State |
|---|---|
| structure, wiring, backend, sustainability | completed |
| frontend | ineligible (no frontend files) |
| quickfix / duplication waves | completed |
| adjacency wave | completed, but R1 hit the `maxContainers=20` enumeration bound (incomplete) |
| arch-memory | ineligible (`--scope diff`) |
| file coverage | **uncovered**: `scripts/sync-to-repos.mjs` is audit-infrastructure (excluded by default). When admitted with `--allow-infra-scope` it is windowed and head-cut, so most changed hunks were never rendered to a GPT pass. The adversarial agent read the full diff instead. |

## Tests (red → green)

- `tests/sync-failure-accounting-e2e.test.mjs`: red at be057735 for each stated reason (H3, H4, H2, H7, H1, H8; log kept locally), then green. The later "adoptable" case was red with the keep-journal guard disabled and green with it.
- Negative controls run during this session, each red with the fix reverted:
  - `matchOverride` without the match-time ban;
  - GC with `path.join` in place of containment;
  - git grep without `-z`;
  - `mayStillExist` with existsSync semantics;
  - `syncMigrations` with the old catch-all.
- Sync-related suites: 696/696 passed after the main commit; later deltas were re-run per file.
