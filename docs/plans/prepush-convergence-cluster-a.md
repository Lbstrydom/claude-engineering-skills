# Plan: Pre-push convergence and scope honesty (cluster A)
- **Date**: 2026-10-25
- **Status**: Draft
- **Author**: Claude + Louis
- **Scope**: backend (audit core + consumer pre-push hook; no UI)
- **Fleet proposals**: 484f, df45, 70b5, 5c16 · brief: `docs/plans/backlog-triage-2026-10-25.md` §5-A
- **Migrations**: none. **Consumer impact**: audit libs sync (`scripts/lib/**`) AND hook v14→v15 (`hooks:install` rollout, all three consumers).

Scope: `backend`, stack `js-ts`. Principles cited as (#N) from `references/engineering-principles.md`.

## 1. Context Summary

**Code Trace** (all at `ac94d9b6`):
- Hook body `scripts/install-prepush-hook.mjs` (`HOOK_VERSION = 14`, line 168): v7 bookkeeping-only short-circuit → v11 `own-files` merge scope (`--files`, no `--base`) → v12/13 `audit-reuse` → `prepush_audit` → `audit-outcome` → `prepush_keep_audit` (prunes only `*.report.json`, `*.output.log`, `.tmp.*`).
- Outcome mapping `scripts/lib/prepush-audit-gate.mjs` `classifyAuditOutcome` / `decideAuditGate`; CLI seam `scripts/prepush-step.mjs` (`CAPABILITIES`, line 49 — the hook asks capabilities before relying on a subcommand).
- Audit scope: `scripts/lib/audit-scope.mjs` `auditSubjectFileGuard` (:454, throws "0 implementation files reached the prompt" → exit 1 → the hook reads UNMEASURED and refuses). `scripts/lib/plan-paths.mjs` `mergeScopeFiles` = plan ∪ scope; passes are then filtered by `scopeToFileFilter` (`scripts/lib/audit/legacy-production-audit.mjs`:218, applied :819-826).
- Coverage ledger `scripts/lib/audit/file-coverage.mjs` `buildCoverageReport` :381-565; status/gate derivation :522-535; wording `scripts/lib/coverage-format.mjs` `formatCoverageSuffix`; convergence `scripts/lib/audit/convergence.mjs`.
- Adjacency: `scripts/lib/audit/adjacency-detector.mjs` :599 (`maxChangedFiles`) and :642 (`maxContainers`); bounds `scripts/lib/config.mjs` `adjacencyConfig` :668-682.

### Investigation results (the brief asked `/investigate` first; these are `measured` against the AIO run logs and the code)

| # | Claim in the proposal | Verdict | Evidence |
|---|---|---|---|
| 484f(b) | merge push audited 94 files, not 29 — scope widened | **Refuted as a scope defect; real defect is a misleading log line** | `c375d97d…output.log` (AIO worktree): `94 files in scope (92 from the plan…)` is plan ACCOUNTING; the next lines read `File scope: 29 files → 28 BE + 1 FE in scope`, `[map-reduce] 29 files → 21 audit units`. The audit read 29. The "94" is printed before the filter. |
| 484f(a) | a persisted ledger would give cross-push memory | **A carried ledger suppresses nothing today** | All 23 entries of `.tmp-ledger.Sbg7V8` are `pending/pending`. `suppressReRaises` (`scripts/lib/ledger.mjs`:577) only suppresses `dismissed`, `fixed`, `verified` entries; nothing adjudicates on a pre-push. Persisting the ledger by itself is inert. |
| 484f(a) | re-reports are reworded | **Confirmed** (diagnosis note: 0/32 exact file+category overlap) | concern-level identity (`scripts/lib/concern-identity.mjs`) is the only comparator that survives rewording. |
| 5c16 | empty change set reads `complete`/`pass` | **Confirmed by reading the code** | `buildCoverageReport`: `required` counts only reviewable classes; with `required === 0` and `violations` empty it reaches `status = 'complete'`, `gate = 'pass'` (:531, :535) with `changedTotal: 0`. Under `--scope plan|full` there is no diff contract, so `changed` is empty BY DESIGN: the ledger describes changed files, and "complete" there is a vacuous claim over an empty universe. The audit did read the plan's files, so convergence on findings is legitimate; only the ledger's claim is false. |
| 70b5 | diff with no implementation files | **Today: exit 1 UNMEASURED → push refused** | `auditSubjectFileGuard` throws; hook v12 classifier reads exit 1 as "did not run". A package.json-only push cannot pass without `AUDIT_PREPUSH_ALLOW_UNMEASURED=1`. |
| df45 | `maxContainers=20` caps a 26-file diff | **Confirmed** | `adjacency-detector.mjs`:642 reports only the FIRST skipped file (`target.newPath`) and a fixed bound that does not scale with the diff. |

**Neighbourhood considered**: reuse, do not write siblings — `classifyNoPlanPush` (`scripts/lib/prepush-audit-gate.mjs`:238) is the existing "push carries nothing a code audit reads" oracle (docs / bookkeeping) and is extended, not duplicated; `buildConcernIndex`/`matchConcern` (`scripts/lib/concern-identity.mjs`) is the one concern comparator; `classifyFileCoverage` (`scripts/lib/language-profiles.mjs`:314) is the one "is this code" oracle (AGENTS.md: derive from the taxonomy, no extension list).

**Target domains**: audit core, consumer hook. Cross-domain: no. Cluster C edits `scripts/install-prepush-hook.mjs` after this merges.

## 2. Proposed Architecture

```mermaid
graph LR
  subgraph Hook["pre-push hook v15"]
    P[push range] --> NC{"no-code step"}
    NC -- "no reviewable file" --> NCO["NO_CODE_IN_SCOPE (recorded, allowed)"]
    NC -- "has code" --> A[prepush_audit]
    A --> O[audit-outcome]
    O --> R["recurrence line (info only)"]
    O --> K[prepush_keep_audit + prune .tmp-ledger.*]
  end
  subgraph Audit["audit core"]
    A --> COV["buildCoverageReport scopeOutcome"]
    A --> ADJ["adjacency: scaled maxContainers + named skipped files"]
  end
```

### Right-sizing (three lines per structural choice)

**Cross-push memory (484f a).**
- Band-aid: persist the ledger per branch and pass `--ledger`/`--round 2`. Measured inert (all entries pending) and R2 prompts say "not find all issues", which would cut recall on a *different* diff.
- Over-engineered: a pre-push adjudication UI/dismissal channel plus learned suppression.
- **Chosen**: no suppression. Report **recurrence** — which of this push's findings concern the same thing as the previous kept report for the branch, by concern identity — beside the counts, informationally, and prune the orphans. Current requirement: the operator reading `H:28 → 11 → 22` cannot tell new from re-raised. A dismissal channel is a separate design (recorded in §8), not needed to answer that.

**NO_CODE_IN_SCOPE (70b5).**
- Band-aid: treat A1's abort as pass. A green without measuring.
- Over-engineered: a new `audit_runs.verdict` value + migration.
- **Chosen**: decided hook-side, pure, from the pushed file list using the one taxonomy oracle, before any audit spend; a recorded envelope `{outcome:'NO_CODE_IN_SCOPE', files}` and a distinct printed line. No store verdict, no migration.

**Coverage honesty (5c16).** Chosen: an additive derived field `scopeOutcome` on the ledger (`code` | `no-code-in-scope` | `no-change-set`) and `gate: 'warn'` (never `pass`) for the two non-`code` outcomes. No new `status` enum value (every status reader is a closed list).

**Adjacency (df45).** Chosen: the default bound scales with the diff (`max(configured, 2 × changed files)`, hard ceiling 500) unless the operator pinned `ADJACENCY_MAX_CONTAINERS`; when a cap still bites, the incompleteness names the skipped files (bounded list + count). Over-built alternative (per-file budgets) rejected: no current requirement.

### Execution model (Phase 1.5)
All steps independent. One ordering constraint: the hook (cluster 2) calls two new `prepush-step.mjs` subcommands and gates on `capabilities`, so an older source checkout degrades to "run the audit as before" rather than breaking (#13).

## 7. File-Level Plan

| File | Change | Principle |
|---|---|---|
| `scripts/lib/audit/file-coverage.mjs` | derive `scopeOutcome`; `gate:'warn'` when not `code`; add to `CoverageSchema` (strict) | #7, #11 |
| `scripts/lib/coverage-format.mjs` | suffix wording for the two non-`code` outcomes; `scopeOutcome` absent (old ledger) reads as today | #7 |
| `scripts/lib/config.mjs` | `adjacencyConfig.maxContainersPinned` | #4 |
| `scripts/lib/audit/adjacency-detector.mjs` | scaled bound; skipped files named | #19 |
| `scripts/lib/audit/legacy-production-audit.mjs` | the "files in scope" line states plan accounting vs audited count | #19 |
| `scripts/lib/prepush-audit-gate.mjs` | `classifyNoCodePush`, `decideNoCodeGate`, `summariseRecurrence` | #1, #11 |
| `scripts/prepush-step.mjs` | subcommands `no-code`, `recurrence`; `CAPABILITIES` += both | #13 |
| `scripts/install-prepush-hook.mjs` | v15: call the two steps, prune `.tmp-ledger.*`, bump | #14 |
| `.githooks/pre-push` | **audited, expected unchanged** — consumers' managed hook is the installer's `HOOK_BODY`; this repo's own file is separate. Implementation phase confirms and records. | — |
| tests | see §9 | — |

### 7b. Implementation Phases

**Phase 1 — Ledger scope honesty**: `scopeOutcome` + `gate` + wording. Files: `scripts/lib/audit/file-coverage.mjs` (modify), `scripts/lib/coverage-format.mjs` (modify), `tests/coverage-scope-outcome.test.mjs` (create)
**Phase 2 — Adjacency bound**: scale and name the skipped files. Files: `scripts/lib/config.mjs` (modify), `scripts/lib/audit/adjacency-detector.mjs` (modify), `tests/adjacency-container-scaling.test.mjs` (create)
**Phase 3 — Scope accounting line**: Files: `scripts/lib/audit/legacy-production-audit.mjs` (modify), `tests/audit-scope-accounting-line.test.mjs` (create)
**Phase 4 — NO_CODE_IN_SCOPE and recurrence (pure + CLI)**: Files: `scripts/lib/prepush-audit-gate.mjs` (modify), `scripts/prepush-step.mjs` (modify), `tests/prepush-no-code-scope.test.mjs` (create), `tests/prepush-recurrence.test.mjs` (create)
**Phase 5 — Hook v15**: Files: `scripts/install-prepush-hook.mjs` (modify), `tests/install-prepush-hook.test.mjs` (modify)

**Close-out (not a phase)**: `npm run skills:regenerate && npm run skills:check`, `npm run docs:architecture-intent:check`, `npm run size:ratchet:gate` (re-baseline `.file-size-baseline.json` if a file shrinks or `install-prepush-hook.mjs` grows past its entry — oversized files may not grow, so the hook change must net out or be re-baselined with a stated reason), `npm run guards:preflight`.

## 11. Execution Clustering

- **Cluster A1** — Phases 1-3 — fix-gate: yes
  - Coupling: all three change what the audit REPORTS about its own scope; one ledger/suffix vocabulary.
- **Cluster A2** — Phases 4-5 — fix-gate: final
  - Coupling: Phase 5 is the only caller of Phase 4's subcommands; the `capabilities` handshake is the seam the audit must inspect.
- **Final gate**: consolidated Gemini review over the union diff.

Shipping: **two PRs** — A1 (audit libs; consumer `sync` only) then A2 (hook; `hooks:install` rollout). Cluster C starts when A2 merges.

## 8. Risk & Trade-off Register

- **A wrong NO_CODE_IN_SCOPE is green-without-measuring.** Mitigations: fail closed — any file the taxonomy cannot classify (`uncovered`, e.g. an unrecognised extension), any resolve error, an unknown push range, or an unreadable file list is **not** no-code and falls through to the audit; no-code requires a positive classification of EVERY pushed file as `non-code`, docs or sync bookkeeping. A `profiled`, `model-only` or `declarative` file (config the audit reviews) is reviewable ⇒ audited. Both directions tested.
- **Recurrence is informational**: it can neither suppress nor gate, so a wrong match is a wrong sentence, not a wrong verdict. Unreadable previous report ⇒ the line is omitted with a reason, never "0 recurring".
- **`gate:'warn'` instead of `pass`** for non-`code`: anything reading `gate === 'pass'` must be checked (Phase 1 greps the readers; listed in the PR).
- **Hook rollout reaches every consumer on sync.** Capability-gated; older source ⇒ today's behaviour.
- **Deferred, on purpose**: a pre-push dismissal channel (what would let a carried ledger actually suppress). It needs a design of its own; recording it here is the honest scope boundary, not a defer-because-harder: the new code does not depend on it.
- **Open probe (Phase 3)**: whether `--files` + `--base` supplies hunk text so the 29 files get hunk-centred windows. Probe first; change the hook's merge branch only if it is honoured and tested.

## 9. Testing Strategy

Tier 1 (deterministic, test-first, red-then-green):
- `scopeOutcome`: empty `changed` → `no-change-set`, `gate:'warn'`; only non-code files → `no-code-in-scope`; one reviewable file → `code` and today's gate; **negative control**: a ledger with a reviewable-but-unaudited file must stay `partial`/`none`, never relabelled.
- Suffix: old ledger without the field prints byte-identical to today; `{status:'complete'}` alone still `LEDGER INVALID`.
- Adjacency: 26 changed files with enough containers → none skipped; pinned env wins; cap that still bites names the skipped files (bounded) and the count; ceiling 500.
- `classifyNoCodePush`: package.json-only, lockfile-only, image-only → no-code; mixed with one `.mjs` → code; `.jsonl`/unknown extension → NOT no-code; `null` list → NOT no-code; docs-only and bookkeeping behave as `classifyNoPlanPush`.
- Recurrence: reworded same-concern pair matches; unrelated pair does not; missing/corrupt previous report → omitted with reason.
- Hook (Tier 3, same commit): `HOOK_VERSION` 15 marker, capability-absent fallback runs the audit, the no-code branch `finish`es with the distinct line and writes the record, `.tmp-ledger.*` prune never touches this run's kept report. Spawned CLI tests scrub `AZURE_*`.

**Proof plan**: oracle = red test per row above; pass = suite green and the one real-store-shaped fixture: the AIO `c375d97d` `output.log` first lines are used (as text fixture) to assert the new accounting line names both counts.

**Pre-ship empirical verify**: run the new hook in a scratch consumer clone (not a mocked shell): a package.json-only push → `NO_CODE_IN_SCOPE`, allowed; a one-`.mjs` push → audits.

## 10. Acceptance (non-UI)

- [ ] Plan/full-scope audit with no changed files prints a ledger that is not `complete/pass` and a suffix saying not measured.
- [ ] package.json-only push: distinct `NO_CODE_IN_SCOPE`, allowed, recorded; never reported PASS or UNMEASURED.
- [ ] 26-file diff: no `maxContainers` incompleteness at defaults; when it does fire the files are named.
- [ ] `94 files in scope` line no longer readable as the audited count.
- [ ] Hook v15 installed in the three consumers' clones after `hooks:install`; older source checkout degrades safely.
