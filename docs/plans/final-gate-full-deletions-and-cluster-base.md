# Plan: The final gate can reach Code: FULL — deleted files, and `/cycle`'s cluster `--base`
- **Date**: 2026-11-28
- **Status**: In Progress
- **Author**: Claude + Louis
- **Scope**: backend — stack `js-ts` (universal engineering principles)
- **Target domain(s)**: `audit-orchestration`, `shared-lib`, skills prose (`skills/cycle/**`)
- **Source**: upstream reports `aeaca1fd` (a deleted changed file counts as unmeasured) and `dd3e4276` (`/cycle`'s cluster
  audit command never passes `--base`), both confirmed against source at `067057e9`.

---

## 1. Context Summary

Both defects stop the final reviewer's code coverage reaching `Code: FULL` on a change that the reviewer did see in full.

### Defect 1 — `aeaca1fd`: a deleted changed file is "unmeasured" (pinned to `067057e9`)

| Claim | Where |
|---|---|
| A changed path that is neither rendered whole nor cut lands in `changedMissing` | `scripts/lib/final-review/code-coverage.mjs:115-124` |
| `unreadChangedLines` returns null without a line count, and a deleted file has none | `scripts/lib/hunk-window.mjs:115` |
| A null measurement is pushed to `changedUnmeasured` and sets `complete = false` | `code-coverage.mjs:138-141` |
| So the state is `partial` — or `none` when the deletion is the only changed file — and `applyCoverageGate` downgrades `none` APPROVE → CONCERNS | `code-coverage.mjs:155-170`, `:258-260` |
| `exists(p)` is consulted only to keep the path off the `NONE:` list | `code-coverage.mjs:134-135` |
| `gemini-review.mjs` already drops deleted files from `codePaths` | `scripts/gemini-review.mjs:278` (`deps.exists`) |
| The required-subjects summary already gets it right: `n-a`, "deleted in the diff" | `code-coverage.mjs:314` |

A deleted file has nothing on disk to show, so "the reviewer did not see its lines" is not a coverage gap. Today it reads
as one, so a change that deletes a file can never be `full`.

### Defect 2 — `dd3e4276`: the cluster audit never passes `--base` (pinned to `067057e9`)

| Claim | Where |
|---|---|
| The block between the `cycle:cluster-audit-command` markers reads only `filesCsv`, `diffPath`, `allowInfraScopeRequired` | `skills/cycle/SKILL.md:322-330` |
| `cycle-cluster-scope.mjs` already emits the resolved `base` | `scripts/cycle-cluster-scope.mjs:266` |
| Without `--base`, `resolveAllowlistBase` returns null for an allowlist round (its doc names this exact case) | `scripts/lib/finalize-outcomes.mjs:97` |
| So no `_diffBase` is stamped and the final reviewer has no hunk evidence: "no diff base recorded" | `scripts/lib/audit/final-review-hunks.mjs:62` |
| The same hand-assembled command sits in REMEDIATE's R4 | `skills/cycle/references/remediate-mode.md:119` |

The root cause is not the one missing flag: it is that the audit argv is **re-assembled by hand in prose** from fields of
a JSON the code already computed. Any flag the code knows and the prose forgets is silently dropped.

## 2. Proposed Architecture

### 2.1 Deletions (defect 1)

**Confirmed deletion = absent on disk AND git reports `D` for the path.** Absence alone is not enough: a path typed
wrong, or a file another session removed outside the diff, is a real gap and must stay unmeasured (the failure
direction that shows a gap instead of hiding one).

- `scripts/lib/audit/final-review-hunks.mjs` (audit-orchestration, already owns git for the final review) gains
  `resolveFinalReviewDeletions({ base, changedFiles, run })` → `{ isDeleted(p), source }`. It runs
  `git diff --name-status -z --no-renames <base>` when a base is recorded (committed + staged + unstaged deletions since
  the audit's base; `--no-renames` so a rename's old path reads `D`) and ONLY that — a path added after the base and
  removed again was never deleted relative to it (plan audit R2-H3); `git diff ... HEAD` only when no base is recorded, parsed by the EXISTING `parseNameStatusZ`
  (`file-coverage.mjs`) — no second parser. A failed git call contributes nothing: unknown ⇒ not deleted ⇒ today's
  unmeasured behaviour (fail toward showing the gap). Paths compare via `normalizePath`.
- `resolveFinalReviewHunks` returns it alongside `hunksFor`, so `gemini-review.mjs` changes by one argument
  (`isDeleted: hunks.isDeleted` — the same option name the callee reads) — that file sits at 995 lines under the 1000-line size ratchet.
- `summariseCodeCoverage` gains `opts.isDeleted` (default `() => false`, so every existing caller is byte-identical).
  For a path that is not rendered and `isDeleted(p) && !exists(p)`: push to a new `changedDeleted` bucket and
  `continue` — it is not in `changedMissing`, not in `changedUnmeasured`, contributes nothing to the line totals, and
  never touches `complete`.
- States: `seen` counts only non-deleted files. A change with present files all shown and some deleted ⇒ `full`
  (the deletions are named). Every changed file deleted ⇒ **`unknown`** ("nothing on disk to measure"), never a vacuous
  `full` (plan audit R1-H1): the reviewer measured nothing. Not `none` either — the gate's premise ("the reviewer was
  handed none of the subject") needs a subject on disk — so its APPROVE is not downgraded, which is the reported bug.
  The coverage instrument measures what the reviewer received of the code ON DISK; removed code is the diff's, and the
  required-subjects `n-a` rule already treats it that way. Wording is byte-identical when nothing is deleted.
- The deletion lookup is lazy (first `isDeleted` call), so a review whose every changed file rendered never runs git, and
  the existing "no base ⇒ git never called" contract of `resolveFinalReviewHunks` holds.
- `formatCodeCoverageSegment` appends `; DELETED: a, b` (names, capped at 5, sensitive paths never named — same policy
  as `NONE:`), so a deletion is reported by name, never silently absorbed.
- `mergeBatchCoverage` (`batching.mjs`) concatenates `changedDeleted`. Batches are disjoint by construction
  (`planDisjointBatches`), so no path repeats. A batch whose every file is a confirmed deletion measured nothing and
  carries no state in the weakest-wins fold (otherwise a 0-byte deleted file packed alone would sink a fully-shown change
  to `unknown`); every batch deletion-only ⇒ `unknown`.

### 2.2 The cluster audit argv (defect 2)

- `cycle-cluster-scope.mjs` takes `--plan <file>` and emits `auditArgv`: the COMPLETE argv for
  `node <sibling>/openai-audit.mjs code <plan> --scope diff --files <csv> --changed <csv> --diff <patch> --base <oid>
  [--allow-infra-scope]`, built by a pure exported `buildClusterAuditArgv(...)` whose script is always the sibling
  `AUDIT_CLI` (no input field can choose it — code audit R1-H5). `null` when the allowlist is empty or no `--plan` was
  given (never a half-argv). The script path resolves next to the scope CLI (`import.meta.url`), so it is correct in this
  repo and in a consumer's `scripts/.claude-skills/`.
- `--audit [-- <extra args>]` on the SAME scope call: the scope is computed fresh and the built argv is spawned in that
  one process. (The first design, `--run-audit <scope.json>`, consumed a JSON written earlier; code audit R1-H1/H5/M1
  showed a stale or edited JSON could then be run. Recomputing removes both: an edit made since the inspecting `--json`
  call fails closed exactly as the scope check always does, and no file chooses what runs.) Extras after `--` are
  appended (`--out`, `--round`, `--ledger`, `--passes`); a PROTECTED flag among them — the audit's scope flags
  (`--scope`, `--files`, `--changed`, `--diff`, `--base`, `--allow-infra-scope`) or this tool's own — is refused (exit 2),
  bare or `=value`; `openai-audit.mjs` validates the rest by name. `--audit` with `--json` is a usage error; `--audit`
  without `--plan` exits 2; an empty allowlist under `--audit` exits 1 (a 0 would read as audited-and-clean). It spawns
  `process.execPath` (never a shell) with `stdio: 'inherit'` and exits with the child's status (signal or spawn failure
  ⇒ 1), so `/audit-code`'s exit 3 / exit 4 reach the caller unchanged.
- Exact commands (plan audit R1-H4). Step 3C and REMEDIATE R4 both run the scope call with `--plan "$PLAN" --json`
  (inspect `emptyAllowlist` / `unchangedDeclared`), then the same call with `--audit -- --out ".audit/$SID-r1-result.json"`.
  Every R2+ round is the same `--audit` call against the SAME base and scope file with `--round N --ledger … --out …`
  after `--` (plan audit R2-H2: the scope is recomputed, so a fix that strays outside it fails closed). The audit's exit
  codes keep `/audit-code`'s meaning (3 = INCOMPLETE, 4 = META_* debt command).
- `skills/cycle/SKILL.md` and `references/remediate-mode.md` name no audit flag as something to pass; the flag commentary
  (`--files` scopes, `--changed` does not, `--diff` is hunk evidence, `--base` stamps `_diffBase`) stays as prose. The
  SKILL.md block must not grow (`skills:size:gate`; the file is over the 12,000-char cap).

## 3. Sustainability Notes

- A future audit flag the scope tool learns reaches every caller without a prose edit — the class "a flag the code
  knows and the prose forgets" is closed, not just this instance.
- `isDeleted` is injected, so the pure coverage module stays git-free (`shared-lib` does not gain an
  `audit-orchestration` edge).

## 4. File-Level Plan

| File | Change |
|---|---|
| `scripts/lib/final-review/code-coverage.mjs` | `isDeleted` opt; `changedDeleted` bucket; states/reasons; `DELETED:` segment |
| `scripts/lib/audit/final-review-hunks.mjs` | `resolveFinalReviewDeletions`; `isDeleted` on the hunks result |
| `scripts/gemini-review.mjs` | pass `isDeleted` to `summariseCodeCoverage` |
| `scripts/lib/final-review/batching.mjs` | fold `changedDeleted` |
| `scripts/cycle-cluster-scope.mjs` | `--plan`, `auditArgv`, `buildClusterAuditArgv`, `--audit` |
| `skills/cycle/SKILL.md`, `skills/cycle/references/remediate-mode.md` | use `--audit`; regenerate `.claude/skills/**` |
| `tests/final-review-deletions.test.mjs` (new), `tests/cycle-cluster-audit-argv.test.mjs` (new), `tests/cycle-audit-scope-contract.test.mjs` (KD-4b block contract) | tests below |

## 5. Risk & Trade-off Register

| Risk | Mitigation |
|---|---|
| A missing-but-not-deleted file read as deleted hides a gap | Deletion needs git `D` AND absence; a git failure ⇒ not deleted. Negative control below. |
| A deletion-only change reads `full` vacuously | It reads `unknown` (nothing measured), never `full`; `DELETED:` names the files. |
| `--audit` as an arbitrary-exec vector | The script is the constant sibling `AUDIT_CLI`; nothing is read back from a file; `process.execPath`, never a shell. |

## 6. Testing Strategy

Each with a negative control (seen to fail without the fix):

1. A change that deletes a file (git `D`, absent) beside a whole-rendered file ⇒ `state: 'full'`, the path in
   `changedDeleted`, not in `changedUnmeasured`; the segment reads `Code: FULL … DELETED: <path>`. Deletion-only ⇒
   `unknown`, and `applyCoverageGate` does not downgrade. Control: the same input without `isDeleted` ⇒ `partial` / `none`
   + downgrade. Batch fold: full + deletion-only batch ⇒ `full`; deletion-only alone ⇒ `unknown`; a real `unknown` batch
   still sinks the fold.
2. A missing-but-NOT-deleted file (absent, no git `D`) stays `changedUnmeasured`, `partial`; and a git-`D` path that is
   back on disk is judged on its render, never `changedDeleted`.
3. `resolveFinalReviewDeletions` over a real temp git repo: a committed deletion since base, an unstaged deletion with
   no base, a rename's old path; a failing `run` ⇒ nothing deleted. Wiring: `resolveFinalReviewHunks`'s `isDeleted`
   reaches `summariseCodeCoverage` and yields `full` over a real repo (R1-H2).
4. Real-repo `cycle-cluster-scope --plan` ⇒ `auditArgv` carries `--base <oid>` equal to `base`, `--files`/`--changed`
   the same csv, `--diff` the patch; without `--plan` ⇒ `auditArgv: null` and `--audit` exits 2 (control). `--audit`
   really spawns the built argv (the audit's own `--help`, no spend); it fails closed on an edit made after the `--json`
   call (exit 1), an empty allowlist (exit 1), a protected extra and `--json` (exit 2); no input field picks the script;
   the child's exit code 0/3/4 propagates (injected spawn; signal or spawn failure ⇒ 1). The SKILL.md / remediate-mode
   blocks run `--audit` with `--plan` and no longer hand-assemble an `openai-audit.mjs code` line (control: the pre-fix
   block text fails the assertion).

## 7. Implementation phases

- **Phase 1** — defect 1 (code-coverage, final-review-hunks, gemini-review, batching) + tests 1–3.
- **Phase 2** — defect 2 (cycle-cluster-scope, SKILL.md, remediate-mode) + test 4.
- **Close-out** — `npm run skills:regenerate`, `npm run skills:check`, `npm run skills:size:gate`.
