# Plan: Consumer pre-push hook v13 — v12's first day in the field

- **Date**: 2026-10-24
- **Status**: Complete — shipped in #289 (status reconciled against merged PRs 2026-10-25)
- **Author**: Claude (fleet chip for CES: Coordinator; proposals eb21, f757, 33e2)
- **Scope**: backend (consumer pre-push hook, step runner, ship provenance; no UI)

## 1. Problem

Hook v12 (#285/#286) refused unmeasured audits and reused same-tree audits. Its first day produced three defects:

1. **The budget was too tight.** storyline Phase 6: 23 files / 1,208 lines got 881s and the audit took 882s; a #429 audit took ~14 minutes. A gate that refuses every big push gets overridden by budget raises.
2. **A rebase or cherry-pick recovery defeated reuse and provenance.** Both key on a tree or a commit; a squash-divergence recovery moves the tree without touching the branch's own diff, so a converged ~14 minute audit was redone, and a ship that only rebased recorded `AI-Gate: not-run` (`checkEvidenceProvenance` refuses an audited sha that left HEAD's history).
3. **No plan selected = no audit, silently.** When the selector resolves nothing (none touched among several active, or none active) the hook exits at `finish` with a status line only. storyline #431 pushed code with nothing measured and was not reported UNMEASURED.

## 2. Decisions

### 2.1 Budget — refit from MEASURED durations

Source: the store's `audit_runs` (`mode='code'`, `total_duration_ms` against `diff_files_changed`), 3000 most recent rows 2026-09-14..2026-10-24, three repos. The population that matches a pre-push audit is **round 1** (610 rows): a hook audit is a fresh invocation with no ledger; later rounds are 2-3x faster (p50 313s vs 133s).

| files changed | n | p50 | p90 | p95 |
|---|---|---|---|---|
| 3-6 | 111 | 121s | 240s | 349s |
| 6-10 | 140 | 274s | 512s | 559s |
| 10-16 | 112 | 390s | 643s | 697s |
| 16-25 | 106 | 459s | 716s | 837s |
| 25-40 | 52 | 551s | 807s | 855s |
| 40-80 | 36 | 655s | 965s | 1167s |

`600 + 30*files` (cap 2700) covers 100% of the 610 rows and 99.3% with 25% headroom for the hook's own startup and preflight; v12's `300 + 20*files + 0.1*lines` covered 94.4%. **Lines are dropped:** `diff_lines_changed` is populated on 122 of the 610 round-1 rows and correlates less with wall time than files do (0.10 vs 0.27) — a line term added a guess, not a measurement.

*Right-sizing.* Band-aid = raise the constants until storyline passes. Over-built = per-model, per-pass cost model. This is the smallest function the data supports: one slope, one intercept, one cap, with the query that re-derives it recorded in the `BUDGET` doc comment.

### 2.2 One patch-equivalence predicate for reuse (eb21) and provenance (f757)

`scripts/lib/patch-equivalence.mjs`: the branch's own commits (those `origin/main` lacks) are compared by a **content fingerprint** of each commit's diff, as a **multiset**, between the audited tip and the pushed tip. *Audit R1 correction:* the first cut used `git patch-id --stable`, which ignores whitespace (a re-indent keeps its patch id), so it is only a candidate matcher at best and was dropped; the fingerprint hashes the `-U0 --binary --no-renames --no-textconv --no-ext-diff` diff minus `index` lines and hunk line numbers. A range holding a **merge commit** is never compared (a merge's own changes are in no non-merge commit). Consumers: `prepush-step.mjs audit-reuse` (→ `reuse-equivalent <run> <round> <commits>`; hook prints `range-diff-equivalent`) and `checkEvidenceProvenance` (→ `ok` with an `equivalence` field; ship-commit prints RANGE-DIFF-EQUIVALENT). Conservative everywhere: unresolvable ref, merge commit in the range, empty-diff commit, >200 commits, zero own commits, an audit of an uncommitted tree (its sha is only the parent), a missing `auditedSha`, any git failure → not equivalent, with the reason named. Store convergence is still required for reuse; the AI-Gate tree comparison still follows, so equivalence supports `converged`, never `passed`.

### 2.3 No plan selected → UNMEASURED (33e2)

`openai-audit.mjs code <plan-file>` requires a plan and its A1 guard refuses a scope that matches none of the plan's files, so a plan-less audit means a synthetic plan and an unverified scope — spend the repo cannot observe. **Decision: report UNMEASURED and refuse by default**, same override (`AUDIT_PREPUSH_ALLOW_UNMEASURED=1`) as v12. Exempt: sync-bookkeeping-only and docs-only pushes (docs by extension `md mdx markdown txt rst`, not by directory). An unknown push range is refused. A selector *crash* is the same path, named as such. The pushed file list is read with `--no-renames`, so a code file renamed to a docs path lists BOTH endpoints (audit R1 H1). The decision lives in `prepush-audit-gate.mjs` (`decideNoPlanGate`) behind a `no-plan` step-runner subcommand, so it is testable without bash.

*Follow-up if noisy:* a repo that keeps every plan Complete will now see refusals on code pushes; the fix is a plan-less audit, not a softer default.

## 3. Rollout

Hook body changed and the hook demands the new `no-plan` capability: consumers need `npm run sync -- --target <name>` **and** `npm run hooks:install -- --target <name>`.

## 4. Acceptance

- Both directions tested in the same commit: `tests/prepush-hook-v13.test.mjs`, `tests/patch-equivalence.test.mjs`, `tests/ship-commit-evidence-provenance.test.mjs`, and the v12 tests updated for the new behaviour.
- The `fail-closed-on-signal` block is byte-identical in both hooks (untouched).
