# Plan: Audit honesty — unadmitted changed files, and the bundle's own generated stores
- **Date**: 2026-10-15
- **Status**: Approved (audit-plan converged 2026-10-15; implementation pending)
- **Author**: Claude + Louis
- **Scope**: backend (audit CLIs + `scripts/lib/**`; no UI) · stack `js-ts`
- **Target domain(s)**: `audit-orchestration`, `shared-lib`, `skills-content`, `tech-debt`
- ⚠ **Cross-domain work** — the crossing is intentional: the one classification oracle (`shared-lib`) feeds the round verdict (`audit-orchestration`); `tech-debt` only re-sources a path constant (PR 2).
- **Upstream reports**: `57bd3de9` (PR 1, ships first) · `3b84d8bb` (PR 2, after PR 1 merges). Coordinator rule 13: one plan, sequential PRs. Each report is closed only after its own PR merges.

Neighbourhood considered: `get-neighbourhood` returned only `review` bands (`summariseCodeCoverage`, `runAdjacencyAnalysis`, …) — nothing above this repo's noise floor. Every change below extends an existing function; no new near-duplicate.

## 1. Context Summary

### 1.1 The two reports

**57bd3de9 (wine, 2026-10-15).** A PR changed `tests/eval/fixtures/compactionToolFacts.jsonl`, the fixture that defines what the eval counts as a fact. The taxonomy has no `.jsonl` row, so the file was `uncovered` → `not-admitted`. The round printed `uncovered: jsonl 1` / `not-admitted: 1`, coverage partial/warn, and the verdict was still **PASS** (and converged). The Gemini gate reported `Code: NONE` and downgraded to CONCERNS only when the file was sent alone; inside a normal multi-file group it read `Code: PARTIAL` with an anonymous count. A load-bearing data file passed two gates unread.

**3b84d8bb (wine, 2026-10-15).** Since CES #247 the tech-debt ledger is one file per entry (`.audit/tech-debt/entries/<id>.json`, committed in consumers). An ordinary migration PR touched hundreds of those generated files; `--scope diff` counted them against adjacency's `maxChangedFiles` (default 60), so the round went `INPUT_BOUND` / PARTIAL. The only levers were raising the global bound or accepting a PARTIAL round.

### 1.2 Code Trace (pinned to `423789e4`)

- `matchFileKind` `scripts/lib/file-taxonomy.mjs:191 (423789e4)` — `DECLARATIVE_DEFS` at `:86` lists `.json/.jsonc/.json5`, no `.jsonl`/`.ndjson` → rule 4 `uncovered`.
- `classifyFileCoverage` `scripts/lib/language-profiles.mjs:314 (423789e4)` delegates to it; `buildCoverageReport` `scripts/lib/audit/file-coverage.mjs:396 (423789e4)` sets `outcome = 'not-admitted'` for `non-code`/`uncovered`; `:341-343` counts an uncovered not-admitted file as required + short → `status: partial`, `gate: warn`.
- The verdict: `computeAuditVerdict` (`scripts/lib/audit/findings-pipeline.mjs:350`) downgrades to INCOMPLETE only on `incomplete`, which `finding-assembly.mjs:859 (423789e4)` sets for failed passes or `coverage.gate === 'fail'`. `warn` changes nothing.
- Convergence: `evaluateConvergenceWithDetectors` `scripts/lib/audit/convergence.mjs:66 (423789e4)` withholds convergence only for `changedLinesUnreadTotal(coverage) > 0` (`changed-lines-unread`, upstream 58f4e3a5). An uncovered file has `changedLinesUnread: null`, so it never blocks. `run-finalization.mjs:135` puts `_convergence` on the round JSON; `run-persistence.mjs` reads it for `AI-Gate`.
- Summary line: `formatAuditSummaryLine` `findings-pipeline.mjs:397 (423789e4)` appends `— not convergence evidence` only for changed-lines-unread. `formatCoverageSuffix` `scripts/lib/coverage-format.mjs:51` words the uncovered case as `N unrecognised file type(s): jsonl ×1` — no statement that the file was never read.
- `audit-loop.mjs` `countFindings` `:76` / `isConverged` `:94 (423789e4)` never read `_convergence`, so even `changed-lines-unread` converges there (its banner prints the suffix, but says `Converged`).
- Gemini: `gemini-review.mjs:306` (full envelope) renders `transcript.code_files` = the round's admitted files, so an unadmitted file is absent. `summariseCodeCoverage` `scripts/lib/final-review/code-coverage.mjs:44 (423789e4)` records it as `not-requested` → `changedUnmeasured`; with ≥1 other file seen, `state: 'partial'`; `formatCodeCoverageSegment` `:198` prints only a count. `applyCoverageGate` `:223` downgrades only `state === 'none'`.
- Adjacency: `runAdjacencyAnalysis` `scripts/lib/audit/adjacency-detector.mjs:578 (423789e4)` compares `ns.files.length` (raw `git diff --numstat`, `vcs.mjs:534`) with `adjacencyConfig.maxChangedFiles` (`config.mjs:675`, default 60). No path is ever subtracted.
- Ledger paths: `DEFAULT_DEBT_LEDGER_PATH = '.audit/tech-debt.json'` `scripts/lib/debt-ledger.mjs:76`; `resolveLedgerLocation` `scripts/lib/debt-ledger-files.mjs:44` derives `entries/` and `budgets.json` under `.audit/tech-debt/`. `RECEIPT_PATH = '.sync-receipt.json'` `scripts/lib/sync-receipt.mjs:77`.

### 1.3 Prior decision this plan revises (and why)

`docs/plans/file-coverage-contract-and-csharp.md` §"gate: warn" decided an uncovered file changes **wording only**: "failing on *any* uncovered file would make every repo with one unknown file type unable to converge — the cried-wolf gate." That held when nothing let a repo state "this file is not reviewable". It does now: `.auditignore` / `--exclude-paths` make a path `excluded-user`, and an excluded uncovered file is outside `required` (`file-coverage.mjs:331`, no warn). So withholding convergence no longer traps a repo: there is a one-line declaration that clears it, and the declaration is the explicit acceptance AGENTS.md prefers to a silent shortcut. Its later sibling (`changed-lines-unread`, 58f4e3a5) already withholds convergence on a measured shortfall; this is the same family.

## 2. Proposed Architecture

```mermaid
graph LR
  TX["file-taxonomy.mjs<br/>matchFileKind"] --> FC["file-coverage.mjs<br/>class + outcome"]
  GS["bundle-generated-stores.mjs<br/>(PR 2)"] --> TX
  FC --> CF["coverage-format.mjs<br/>unreviewedUnrecognisedFiles"]
  CF --> CV["convergence.mjs<br/>unrecognised-files-unreviewed"]
  CF --> SL["findings-pipeline.mjs<br/>summary line"]
  CV --> AL["audit-loop.mjs<br/>isConverged"]
  TX --> GC["final-review/code-coverage.mjs<br/>per-file NONE"]
  GS --> AD["adjacency-detector.mjs<br/>count excludes stores"]
```

### 2.1 PR 1 — upstream 57bd3de9

**D1. Admit `.jsonl` and `.ndjson` (ask 1).** Two rows in `DECLARATIVE_DEFS`, fence `json` — line-delimited JSON is reviewable data exactly as `.json` is. The taxonomy stays the one oracle; every derived list (`AUDITABLE_EXTENSIONS`, `EXTENSION_FENCES`, admission, profiling) picks the rows up with no second edit (#5 SSOT; AGENTS.md "Do NOT hand-keep a 'which files are code' list").

**D2. A changed unrecognised file withholds convergence — qualified PASS, not INCOMPLETE (ask 2).**
- New pure helper `unreviewedUnrecognisedFiles(cov)` in `coverage-format.mjs`: ledger records with `class === 'uncovered' && outcome === 'not-admitted'`. That excludes, by construction: `non-code` (binary, asset, lockfile, generated — expected exclusions), `excluded-user`/`excluded-infra` (declared), `sensitive`, `deleted`. Works on the ledger and the reviewer projection, like its siblings.
- `evaluateConvergenceWithDetectors` gains a fourth requirement after `changed-lines-unread`: `{converged: false, reason: 'unrecognised-files-unreviewed'}` when that list is non-empty. AI-Gate `passed`/`converged` then refuse through the existing `run-persistence` wiring — no new path.
- The verdict word stays `PASS`. **Why not INCOMPLETE:** INCOMPLETE means "this round did not measure the change" — exit 3, the provider-failure class. Here the admitted change *was* measured; one file of an unknown type was not. Making it INCOMPLETE would turn every stray unknown file into an exit-3 run and conflate two different facts. Withholding convergence is what actually stops the ship (it is what `AI-Gate` and the skill's "2 stable rounds" read); the verdict line says why.
- Summary line: `notEvidence` fires when `changedLinesUnreadTotal > 0` **or** the new list is non-empty. `formatCoverageSuffix`'s uncovered phrase becomes `N unrecognised file type(s) never sent to any pass: xyz ×1` (the existing wording plus "never sent to any pass", so the `unrecognised file type` assertions in coverage-surface and final-review-coverage-request still hold) — it says the file was not read, not just that its type is odd. Result: `Verdict: PASS | H:0 M:0 L:0 | 30s | coverage: PARTIAL — 1 of 4 …; 1 unrecognised file type(s) never sent to any pass: xyz ×1 — not convergence evidence`.
- Remedy, printed nowhere new but documented in the skill row: declare the file in `.auditignore` (explicit acceptance), or report the missing type upstream.
- `audit-loop.mjs`: `countFindings` carries `coverageBlocked = COVERAGE_CONVERGENCE_REASONS.has(results._convergence?.reason)` and `isConverged` refuses on it, so the older driver stops printing `Converged` over either coverage shortfall. The reason set is exported from `convergence.mjs` (one list, two readers). Only the coverage reasons — the other `_convergence` reasons have their own established handling in that driver, and widening it further is not this change.

**D3. Gemini names each unreceived file (ask 3).** In `summariseCodeCoverage`, a changed file the reviewer never received (`not-requested` or `budget-omitted`) whose `matchFileKind` kind is **not** `non-code` goes into a new `changedNotReceived: [{path, outcome}]`. `formatCodeCoverageSegment` appends `; NONE: <p1>, <p2> (+N more)` (cap 5). So a multi-file group reads `Code: PARTIAL, changed lines unmeasured for 1 file(s); NONE: tests/eval/x.jsonl`. **Reported, not gated**: `applyCoverageGate`'s policy (`partial` never downgrades) is unchanged, because the round-level convergence block in D2 already stops the chain, and a second mechanical downgrade at a different layer would double-count one fact. `coverageBlockFor` already lists uncovered files to the reviewer; unchanged.

### 2.2 PR 2 — upstream 3b84d8bb

**D4. One registry of the bundle's own generated stores, sourced by the writers.** New dependency-free `scripts/lib/bundle-generated-stores.mjs` exports:
- `DEBT_LEDGER_STEM = '.audit/tech-debt'` — the ledger's one location descriptor. Both forms derive from it exactly as `resolveLedgerLocation` derives them from any path: the legacy file `${stem}.json` and the tree `${stem}/` (holding `entries/` and `budgets.json`). `debt-ledger.mjs`'s `DEFAULT_DEBT_LEDGER_PATH` becomes `` `${DEBT_LEDGER_STEM}.json` `` (audit-plan R1-M1).
- `SYNC_RECEIPT_PATH = '.sync-receipt.json'`, imported by `sync-receipt.mjs` as its `RECEIPT_PATH`.
- `BUNDLE_GENERATED_STORES` — frozen `{path, kind: 'file'|'tree', writer}` entries built from those constants; `isBundleGeneratedStore(relPath)` (slash-normalised, case-insensitive, repo-relative, anchored at the root — `src/.audit/tech-debt.json` is not a store); and `bundleStoreExcludePathspecs()` → git pathspecs `:(top,exclude,icase)<file>` / `:(top,exclude,icase,glob)<tree>/**` for D6.

**Derived, not a second list:** the writers import their default paths from the registry, so writer and classifier read one constant. The test is drift detection, not import enforcement: it resolves `resolveLedgerLocation(DEFAULT_DEBT_LEDGER_PATH)` and asserts its `legacyFile`, an `entries/` child and `budgetsFile` (made repo-relative) all satisfy `isBundleGeneratedStore`, and that `RECEIPT_PATH === SYNC_RECEIPT_PATH`.

**D5. Classification: a generated store is `non-code`.** `matchFileKind` gains a rule 0 — `isBundleGeneratedStore(path)` → `{kind: 'non-code', rule: 'generated-store:<entry>'}`. This is the taxonomy's own documented meaning of `non-code` ("an EXPECTED exclusion: … generated"), and it keeps the module path-only and dependency-free (the registry imports nothing). Downstream, with no further edits: admission drops the files as expected exclusions; the coverage ledger records them `non-code`/`not-admitted`, outside `required` (no warn); D3's per-file NONE skips them.

**D6. The adjacency inputs exclude the stores at the source — git does the partition.** `gitNumstatWithWorkingTree` and `gitUnifiedDiffWithWorkingTree` (`scripts/lib/vcs.mjs:514`, `:567`) gain an optional `pathspecs` argument, appended after `--` (default none ⇒ byte-identical command for every other caller). `runAdjacencyAnalysis` passes `['.', ...bundleStoreExcludePathspecs()]` to **both** calls (audit-plan R1-M2: the acquired patch then never carries store hunks, so `maxDiffBytes` bounds only what is analysed; the bound itself is unchanged).

Rename endpoints are git's own answer, not a path-text parse (R1-M3): with the stores excluded by pathspec, rename detection only ever pairs visible paths, so store→visible arrives as an addition of the visible file, visible→store as a deletion of it, store→store not at all, and visible→visible as an ordinary rename. Counts, line totals and the patch all come from the same pathspec-limited diff, so they cannot disagree.

When the file or line bound fires, a second, cheap numstat limited to the store pathspecs (non-exclude form) supplies M, and the message adds `(M further changed file(s) are bundle-generated stores and were not counted)`. Below the bound nothing extra runs and the output is unchanged. A failed second numstat says `store count unavailable`, never `0`.

**Not done (ask 2 of 3b84d8bb, the consumer glob list):** `.auditignore` is that list already for admission and coverage; the defect was the adjacency count ignoring the bundle's *own* stores, which D6 fixes without a new config surface.

### 2.3 Right-sizing (D2 and D4 introduce new structure)

- **Band-aid:** add `.jsonl` and stop (the next unknown type passes unread the same way); raise `maxChangedFiles` (weakens the bound for every real diff).
- **Over-built:** a new coverage outcome / schema version for "unrecognised", a Gemini-layer downgrade, a configurable consumer exclusion DSL for the diff scope.
- **Chosen:** reuse the existing `uncovered`/`not-admitted` record, the existing `_convergence` → AI-Gate path, and the existing `non-code` meaning. The only new structures are one helper (D2) and one 3-entry registry whose consumers are its writers (D4) — each serves a requirement in the reports.

### 2.4 Execution model

PR 1 and PR 2 are independent in code (PR 2 touches `matchFileKind` at a different rule), but sequenced by policy: PR 2's branch is cut from `main` after PR 1 merges. Within each PR, operations are pure functions; no ordering or atomicity concerns.

## 3. Sustainability Notes

- A new reviewable type is still a one-row taxonomy edit; until it lands, the round says so and withholds convergence — the visible-not-silent property the coverage contract was built for.
- A new bundle-written, committed store is one registry row plus the writer importing its path from it.
- Assumption: consumers use the default ledger path. A `--ledger` override is not recognised as a generated store (documented in the registry header; the override is rare and the cost is today's behaviour, not a regression).

## 4. File-Level Plan

### 4.1 Implementation Phases

**Phase 1 — Red tests (PR 1)**: write the failing tests first and record their failure at `423789e4`. Files: `tests/coverage-orchestrator.test.mjs` (modify), `tests/file-taxonomy.test.mjs` (modify), `tests/file-coverage.test.mjs` (modify), `tests/final-review-code-coverage.test.mjs` (modify), `tests/audit-loop-coverage-convergence.test.mjs` (create).

**Phase 2 — Taxonomy + convergence + summary line (PR 1)**: D1, D2. Files: `scripts/lib/file-taxonomy.mjs` (modify), `scripts/lib/coverage-format.mjs` (modify), `scripts/lib/audit/convergence.mjs` (modify), `scripts/lib/audit/findings-pipeline.mjs` (modify), `scripts/audit-loop.mjs` (modify), `skills/audit-code/SKILL.md` (modify), `skills/audit-code/gate-contract.json` (modify).

**Phase 3 — Gemini per-file NONE (PR 1)**: D3. Files: `scripts/lib/final-review/code-coverage.mjs` (modify).

**Phase 4 — Generated-store registry + adjacency (PR 2)**: D4–D6, with its own red tests first. Files: `scripts/lib/bundle-generated-stores.mjs` (create), `scripts/lib/file-taxonomy.mjs` (modify), `scripts/lib/debt-ledger.mjs` (modify), `scripts/lib/sync-receipt.mjs` (modify), `scripts/lib/vcs.mjs` (modify), `scripts/lib/audit/adjacency-detector.mjs` (modify), `tests/bundle-generated-stores.test.mjs` also carries the `vcs.mjs` pathspec and real-git adjacency tests (one file, one fixture helper; no `tests/vcs.test.mjs` / `tests/adjacency-detector.test.mjs` edit), `tests/bundle-generated-stores.test.mjs` (create), `tests/adjacency-detector.test.mjs` (modify).

**Close-out (not a phase)**: `npm run skills:regenerate`; `npm run skills:size:gate` (the SKILL.md row is generalised in place — net ≤ 0 chars; a shrink is re-baselined DOWN, never up); `npm run guards:preflight`; `node scripts/check-plan-status.mjs`.

### 4.2 Per-file notes

| File | Change | Why |
|---|---|---|
| `scripts/lib/file-taxonomy.mjs` | `.jsonl`, `.ndjson` → declarative `json` (PR 1); rule 0 generated store → `non-code` (PR 2) | #5 one oracle |
| `scripts/lib/coverage-format.mjs` | export `unreviewedUnrecognisedFiles(cov)`; suffix wording | dependency-free wording seam already shared by summary line and envelope |
| `scripts/lib/audit/convergence.mjs` | reason `unrecognised-files-unreviewed`; export `COVERAGE_CONVERGENCE_REASONS` | the one convergence oracle (#5) |
| `scripts/lib/audit/findings-pipeline.mjs` | `notEvidence` on either coverage reason | the verdict line never bare (#19) |
| `scripts/audit-loop.mjs` | `countFindings` → `coverageBlocked`; `isConverged` refuses | same predicate in the older driver (#5) |
| `scripts/lib/final-review/code-coverage.mjs` | `changedNotReceived`; segment names files | ask 3 (#19 observability) |
| `skills/audit-code/SKILL.md`, `gate-contract.json` | the `changed-lines-unread` row generalised to "summary line ends `— not convergence evidence`", naming both reasons and the `.auditignore` remedy | the skill reads the same signal |
| `scripts/lib/bundle-generated-stores.mjs` | registry + predicate | D4 |
| `scripts/lib/debt-ledger.mjs`, `scripts/lib/sync-receipt.mjs` | default path imported from the registry | writer = source (#5) |
| `scripts/lib/vcs.mjs` | optional `pathspecs` on numstat + unified diff (absent ⇒ unchanged command) | D6 |
| `scripts/lib/audit/adjacency-detector.mjs` | both git calls carry the store exclude pathspecs; message names M | D6 |

`openai-audit.mjs` and `scripts/lib/config.mjs` are **not** modified: the summary line flows through `formatAuditSummaryLine`, and the bound's default is unchanged.

## 5. Risk & Trade-off Register

- **Convergence withheld on a harmless unknown file.** Intended; remedy is a one-line `.auditignore` entry. Measured risk is low after D1: the wine case was the only report of its kind.
- **SKILL.md size ratchet.** The row is reworded in place, not added; if it shrinks, the baseline is lowered (tightened).
- **Wording change breaks existing assertions** on `N unrecognised file type(s)` — updated in the same commit; consumers parse the verdict word and `_convergence`, not this phrase (grep confirms no code reader of the phrase).
- **Deferred:** a Gemini-layer downgrade for unreceived files (D3 rationale); a consumer glob list for the diff scope (§2.2).

## 6. Testing Strategy

Red first, each test seen to fail at `423789e4` before the fix, failure output recorded in the PR body.

- **End to end (ask 4)** — `tests/coverage-orchestrator.test.mjs`, real orchestrator with the stubbed client:
  - `.cs` + `fixtures/x.jsonl` changed → before: jsonl `not-admitted`, `_convergence.converged === true`, verdict PASS. After: jsonl `audited` (declarative), coverage `complete`.
  - `.cs` + `svc/notes.xyz` → before: `_convergence.converged === true`. After: verdict `PASS`, `_convergence = {converged:false, reason:'unrecognised-files-unreviewed'}`, summary line ends `— not convergence evidence`.
  - Negative controls (must NOT fire): `.cs` + `logo.png` (non-code) converges; `.cs` + `svc/notes.xyz` listed in `--exclude-paths` converges.
- **Oracle** — `tests/file-coverage.test.mjs`: the convergence matrix over `uncovered` × {not-admitted, excluded-user, sensitive, deleted} and `non-code` × not-admitted; `changed-lines-unread` keeps precedence when both hold.
- **Taxonomy** — `tests/file-taxonomy.test.mjs`: `.jsonl`/`.ndjson`/`.NDJSON` → declarative, fence `json`.
- **Gemini** — `tests/final-review-code-coverage.test.mjs`: a multi-file group with one unreceived `.jsonl`/`.xyz` names it under `NONE:`; an unreceived `.png` is not named; the cap prints `(+N more)`; `applyCoverageGate` still does not downgrade `partial`.
- **audit-loop** — `tests/audit-loop-coverage-convergence.test.mjs`: `countFindings`/`isConverged` (already exported, `scripts/audit-loop.mjs:627 (423789e4)`) refuse on both coverage reasons and accept other results unchanged.
- **PR 2** — registry: `resolveLedgerLocation(DEFAULT_DEBT_LEDGER_PATH)` legacy/entries/budgets all satisfy `isBundleGeneratedStore`; `RECEIPT_PATH === SYNC_RECEIPT_PATH`; both slash styles and case; near-misses `.audit/tech-debt-notes.md` and `src/.audit/tech-debt.json` are not stores. `vcs.mjs`: no `pathspecs` ⇒ argv identical to today. Adjacency, in a real temp git repo: 70 store files + 3 source files does not fire the bound; 61 source + 10 store fires and names `10`; store hunks larger than `maxDiffBytes` with a small source change stays enumerated, and the control (source alone over the byte bound) still fires; the four rename cases (store→visible = addition, visible→store = deletion, store→store = absent, visible→visible = rename). Negative control: 61 source files and no stores fires exactly as today.

## 7. Audit Trail

- **/audit-plan** (SID `audit-plan-1792040978411-43536`): R1 GPT `NEEDS_REVISION` H:0 M:3 L:0 — all three on PR 2 (ledger layout from one stem; store hunks still consumed `maxDiffBytes`; rename endpoints undefined), accepted 3/3 (100%) and folded into D4/D6 + §6. R2 GPT `READY_TO_IMPLEMENT` H:0 M:0 L:0. Stopped at the first clean round (lean route).
- **Final gate** (Gemini, round 1 of 2): `APPROVE`, disposition `approve` — 0 new, 0 wrongly dismissed.
