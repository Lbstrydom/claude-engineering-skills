# Audit Summary — fleet hooks-path removal guard

**Plan**: docs/plans/fleet-unclaimed-work-and-switch-friction.md (the recorded follow-up landed with #216)
**Scope**: --scope diff, base `d65f1e8d` (the branch's two initial commits; R2+ rounds scoped to each fix commit, R4/R5 to the whole branch)
**Rounds**: GPT R1 → R6 (round cap) → Gemini R1
**SID**: audit-code-1791798938742-69072

## What was audited

`scripts/lib/fleet/hooks-path-guard.mjs` (new) and its two callers: `fleet archive` (plan-time refusal + the
re-check under the registry lock before `git worktree remove`) and `fleet prune` (plan-time exclusion + the
re-check under the lock in `--apply`). Incident: 2026-10-12, three worktrees' `core.hooksPath` pointed into a
worktree that was then removed, so git silently ran no pre-push hook and PR #203 was pushed ungated.

## Convergence

| Round | Verdict | H | M | L | Outcome |
|---|---|---|---|---|---|
| GPT R1 | SIGNIFICANT_ISSUES | 6 | 2 | 0 | All accepted: unset value skipped instead of asking git (`--git-path hooks`); a link inside the worktree to an outside dir missed (walk every entry); `..` collapsed lexically before symlinks on POSIX; `A/..hooks` read as outside (component-aware containment); hardcoded `<main>/.githooks` remedy (derive it); global/system remedy rewrote shared config (repo-local override) |
| GPT R2 | SIGNIFICANT_ISSUES | 1 | 2 | 0 | All accepted: remedy target read off traversal order, not the resolved endpoint (a trailing `..`); a guessed fallback directory when the main checkout depends too (print no command) |
| GPT R3 | **PASS** | 0 | 0 | 0 | — |
| GPT R4 (whole branch) | SIGNIFICANT_ISSUES | 3 | 0 | 0 | H1 accepted (an individual hook inside an outside hooks dir linking into the worktree); H2/H3 **deliberated → compromise, LOW**: remedy target must be an existing directory; the required-hooks / executable-bit validation withdrawn |
| GPT R5 (whole branch) | SIGNIFICANT_ISSUES | 3 | 0 | 0 | All accepted, mechanical win32 path spelling: `\\?\` strip on win32 only; `\\?\UNC\` → `\\server\share`; realpath an existing non-link entry whole (8.3 alias of the root) |
| GPT R6 | **PASS** | 0 | 0 | 0 | Round cap reached |
| Gemini R1 | **APPROVE** | — | — | — | `gateDisposition: approve` — 0 new, 0 wrongly dismissed, 0 over-engineering flags; deliberation judged fair |

Not 2/2 stable across the whole branch: R5's three findings were fixed and R6 (scoped to that fix) was clean,
then the round cap was reached. Every GPT finding was accepted or deliberated; none deferred, none dismissed.

## Census (final round)

| Pass / wave | State |
|---|---|
| backend, sustainability | completed (R6) |
| structure, wiring | completed (R4, R5 whole-branch) |
| frontend | ineligible (no frontend files) |
| arch-memory | ineligible (`--scope diff`) |
| detectors | completed — none recorded (no cross-cutting finding), `blocked: false` |
| file coverage | GPT R4–R6: complete. R1: partial — a transient untracked test artifact (`scripts/fleet-link-test-*.mjs`, gone afterwards) entered scope. Gemini: production code (`hooks-path-guard.mjs`, `archive.mjs`, `prune.mjs`, gate contract) rendered in full; the test file and the two skill docs windowed (214 changed lines not shown to it) |

## Verification

- Every fix proven in both directions: each was reverted on its own, its test went red naming the defect, then
  restored green (R1: 5 fixes; R2: 2; R4: 2; R5: 3). One honest limit: on win32 the R2 resolved-endpoint
  wiring cannot go red (the Win32 API collapses `..` before the walk, so the last entry IS the endpoint there); the
  field itself is pinned on every platform by the `traversedEntries` unit test, and the real-filesystem test covers
  the wiring on POSIX.
- Original negative control: with the guard neutralised, every archive and prune guard test failed.
- Full suite (pre-audit): 19,199 tests, 0 fail, 46 skipped, 8m30s (`npm test`, this worktree, 2026-10-12).
- Live read-only probe against this repo's 15 worktrees: no linked worktree is a hooks target (only the main
  checkout, which archive and prune never remove).
