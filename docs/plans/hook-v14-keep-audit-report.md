# Plan: Consumer pre-push hook v14 — keep the audit's report

- **Date**: 2026-10-24
- **Status**: In Progress — implemented on `claude/hook-keeps-audit-report-bb2000`, pending audit and merge
- **Author**: Claude (fleet chip for CES: Coordinator; proposal p-20261024142941-39f0)
- **Scope**: backend (consumer pre-push hook, `scripts/install-prepush-hook.mjs`; no UI)

## 1. Problem

The hook's advisory audit writes its result envelope and the step's output to `mktemp` files and deleted both (`rm -f "$AUDIT_OUT" "$AUDIT_REPORT"`) as soon as `audit-outcome` had read the verdict. When the push returned, the H/M findings were gone: wine hit this on #1171, #1181 and #1183 (2026-10-24), and this repo's rule that a fresh audit over the merged tree must be triaged could not be met without two extra `/audit-code` rounds per PR.

## 2. Decisions

1. **Keep, don't delete.** Files live in the consumer's gitignored `.audit/prepush/` (`.audit/*` is in the managed block): `<pushed-tree-sha>.report.json` (the audit's envelope) and `<pushed-tree-sha>.output.log` (the step's stdout/stderr). Keyed by tree, so a re-push of the same tree overwrites its own pair, and the key is the one `audit-reuse` already speaks.
2. **Same creation safety.** `mkdir -p` the directory, then `mktemp` *inside it* (exclusive, no predictable-path fallback), rename to the tree-keyed names after the outcome is read. A directory/file that cannot be created BLOCKS the push and runs no audit. A failed rename keeps the `.tmp.*` file and prints that path.
3. **Print on every outcome** (pass / findings / unmeasured / timeout), after the verdict lines. An empty file is not a kept path: the line says `none exists (the audit wrote nothing)`. On a timeout (124, still a refusal) whatever was written is kept.
4. **Bounded.** Newest `AUDIT_PREPUSH_KEEP_REPORTS` (default 20; invalid or `0` falls back to 20, never to deleting everything) of each kind; stale `.tmp.*` older than a day removed; pruning is best-effort and never changes the outcome.
5. **No new runner subcommand** — the v13 capability guard is unchanged; consumers need a sync + `hooks:install`.

### Right-sizing

Band-aid: print the findings to the terminal only (lost in scrollback, nothing to open later). Over-built: persist findings into the audit store from the hook (the store already holds them for `audit-code` runs; the pre-push audit is the case where the hook is the only holder of the envelope, and a file is enough). The file is the smallest thing that is a true function of the problem.

## 3. Acceptance criteria

- The report survives the push, on pass, findings, unmeasured (exit 3 and crash) and timeout, at `.audit/prepush/<tree>.*`, and the path is printed (`tests/prepush-hook-v14.test.mjs`).
- A timeout keeps partial output, or says none exists; no empty stubs remain.
- Retention keeps the newest N of each kind, never the files just written; a bad knob never deletes everything.
- A squatting file at `.audit/prepush` refuses the push with no audit run.
- Each test fails against v13's hook (seen: 10/10 fail).

## 4. Out of scope

Surfacing kept reports in `/ship` or a `triage` command; storing them in the audit store.
