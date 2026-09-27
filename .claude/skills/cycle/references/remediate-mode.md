---
summary: REMEDIATE mode — fix triaged post-ship findings against an accepted plan without replaying the full cycle.
---

# REMEDIATE mode — `/cycle remediate <plan-file> --from <source> <report>`

**Why this exists.** A field report (2026-09-26): two narrow post-ship persona
P1 defects were fixed by replaying the full `/cycle`, which re-planned and
re-audited an already-accepted plan and re-audited the whole dirty tree. What
actually worked, done by hand, was: resume the accepted plan → triage the
persona findings → implement focused fixes → focused `/audit-code` → rerun the
affected persona journey → update evidence → `/ship`. REMEDIATE is that
sequence, named, with the same gates every other mode keeps.

```
/cycle remediate <plan-file> --from persona-test <report.md> [--persona-url <url>] [--autonomous] [--include-p2] [--no-ship]
/cycle remediate <plan-file> --from audit <result.json> [--autonomous] [--no-ship]
```

Both `--from` and the report path are **required**. No report → stop and ask;
never go looking for "the latest" report (the input-acquisition rule: absent
input is never inferred).

## What REMEDIATE skips, and what it never skips

| Step | REMEDIATE | Why |
|---|---|---|
| 1 `/plan` | **skipped** | The plan is the governing document; you are fixing against it, not re-deciding it. |
| 2 `/audit-plan` | **skipped** | See "The accepted-plan skip" below — the skip is YOUR declaration, made by typing `remediate`. |
| 0.5 cross-plan check | runs | The plan exists; its `Depends on:` lines still apply. |
| 0.7 §11 preflight | **not run** | Remediation fixes are not §7b phases; there is no cluster to validate. The fix list below is the scope. |
| 4 `/audit-code` | **runs, focused** | Never skipped. Round cap unchanged: **6 rounds**, `HIGH==0 && MEDIUM<=2 && quickFix==0`. |
| Gemini final gate | **runs** | Unchanged: **max 2 rounds**, with `gemini-gate.md`'s design/correctness exception. |
| 5 `/persona-test` | **affected journeys only** (`--from persona-test`) | Rerunning every persona re-buys the whole exploratory pass. |
| 6 `/ux-lock` | runs per fixed P0/P1 unless `--no-uxlock` | A post-ship regression is exactly what a lock spec exists for. |
| 7 `/ship` | **blocked handoff, always** | Same as every mode: `/ship` refuses programmatic invocation. `--autonomous` never reaches it. |

## R1 — Load the governing plan

Read `<plan-file>`. Confirm it exists and carries a `Status:` line; run Step 0.5's
`check-plan-status.mjs --check-deps`. Do NOT invoke `/plan` or `/audit-plan`.

If the source report's findings plainly fall **outside** the plan's declared
scope (they concern a feature the plan never touched), stop and say so — the
right tool is a new `/cycle <task>` or `/plan`, not remediation against an
unrelated plan.

## R2 — Triage the source report into a fix list

| `--from` | Parse | In scope by default |
|---|---|---|
| `persona-test <report.md>` | the report's P0–P3 finding list, plus its persona name, URL and `Focus:` line | **P0 + P1** (`--include-p2` adds P2) |
| `audit <result.json>` | the `findings[]` array (`id`, `severity`, `category`, `section`, `detail`) | **HIGH** only |

For each in-scope finding decide: **fix** (name the file(s) the fix will touch),
**defer** (with an independence sentence per AGENTS.md's impact test — never
"pre-existing" alone), or **not reproducible** (say what you tried). A finding
you cannot map to a file is not in the fix list yet — investigate it first; do
not guess a scope.

**Record the result in the plan** before touching code, as a dated entry under
the plan's `## Implementation Log` (the section `/ship` Step 5 appends to —
create it at the bottom if absent):

```markdown
### <today> — remediation (source: <report path>)
- Fix: <finding id> <one line> → <file(s)>
- Defer: <finding id> — <independence reason>
- Journeys to rerun: "<persona>" "<focus>"
```

Show the fix list and **pause for the human to confirm it** unless
`--autonomous` was passed. An empty fix list ends the run here: nothing to fix
is a result, report it, do not proceed to an audit of nothing.

## R3 — Implement the focused fixes

Capture the base **before** the first edit, and write the scope file:

```bash
REMEDIATE_START=$(git rev-parse HEAD)
# one path per line: every fix file + the plan itself (its log was just edited)
# + the source report if it lives inside the repo and is untracked/modified
```

- **Default**: pause for the human to implement (card below), resume with the
  same command plus `--baseline-ref "$REMEDIATE_START"`.
- **`--autonomous`**: implement the fix list yourself. A fix that needs a file
  **not** in the scope file stops for confirmation — same rule as Step 3C's
  out-of-cluster stop. Amend the scope file (and the log entry) only with the
  human's yes.

```
═══════════════════════════════════════
  /cycle paused at remediation gate
  Plan:   docs/plans/<name>.md
  Fixes:  <n> (see the plan's Implementation Log)
  Resume: /cycle remediate docs/plans/<name>.md --from <src> <report> --baseline-ref <sha>
═══════════════════════════════════════
```

A resume with no `--baseline-ref` and no captured `REMEDIATE_START` stops —
**never** default the base to HEAD (empty diff = silent skip).

## R4 — Focused `/audit-code`

Reuse Step 3C's deterministic scoping tool with the remediation scope as a
single pseudo-cluster. It resolves the base, builds the reconciliation set and
**exits non-zero on any edit outside the scope file** — which is exactly the
"never audit the whole dirty tree" guarantee remediation needs on a tree
another session may share.

```bash
git merge-base --is-ancestor "$REMEDIATE_START" HEAD || { echo "base left history - halt"; exit 1; }
node scripts/cycle-cluster-scope.mjs --base "$REMEDIATE_START" --scope-file "$SCOPE_FILE" --out-dir .audit --cluster remediate --json > "$SCOPE_JSON"
FILES=$(node -p "require('./$SCOPE_JSON').filesCsv")
PATCH=$(node -p "require('./$SCOPE_JSON').diffPath")
INFRA=$(node -p "require('./$SCOPE_JSON').allowInfraScopeRequired ? '--allow-infra-scope' : ''")
node scripts/openai-audit.mjs code "$PLAN" --scope diff --files "$FILES" --changed "$FILES" --diff "$PATCH" $INFRA
```

Then follow `/audit-code`'s own loop (R2+ ledger, triage, fix, re-audit) with
the **same `--files`** on every round, and its Gemini final gate. Caps are
`/audit-code`'s, not new ones: **6 audit rounds, 2 final-review rounds**.
Findings about code outside the fix list are triaged by impact exactly as in
any audit — the focused scope bounds what the model *reads*, not what you may
dismiss.

## R5 — Rerun only the affected journeys (`--from persona-test`)

For each journey recorded in R2, resolve the URL as Step 5 does
(`--persona-url` → `PERSONA_TEST_APP_URL` → skip, printed) and run Step 5.0's
preview-gate first. Then:

```
/persona-test "<persona from the report>" <url> "<focus from the report>"
```

Because these defects surfaced **after** ship, a single happy-path pass is not
evidence. For each fixed finding, the rerun must exercise the **stateful
lifecycle** around it: perform the state-changing action, then **reload /
re-navigate and verify the state persisted**, then take the follow-on action a
user would (edit, undo, delete, revisit) and verify again. Say in the summary
which lifecycle steps were exercised per finding.

Verdict per original finding: `fixed` (the lifecycle passes), `still-present`
(back to R3 — counts toward the audit round cap, not a new budget), or
`unverified` (no URL, auth wall, capture failure — name the blocked
prerequisite; `unverified` is never reported as `fixed`). New P0s found on the
rerun block ship exactly as in Step 5.

`--from audit` has no journey to rerun: R5 is skipped and the summary says so.

## R6 — Evidence, ux-lock, handoff

1. Append the outcome to the R2 log entry: per finding `fixed` / `still-present`
   / `unverified`, the audit verdict and rounds, the rerun result.
2. Step 6 `/ux-lock` for each fixed P0/P1 (unless `--no-uxlock`).
3. Step 7's blocked handoff — `Resume with: /ship docs/plans/<name>.md`.
   `/ship` Step 5 then sees the plan path and the log entry.

Summary card:

```
═══════════════════════════════════════
  /cycle remediate — <PLAN-NAME>
  Source:     persona-test docs/…/report.md (2 P1 in scope, 0 deferred)
  Fixes:      2 files + plan log
  Audit-code: 2 rounds, CONVERGED, H:0 M:0 L:1 (focused: 3 files)
  Final gate: Gemini APPROVE
  Rerun:      "Pieter" "adding a bottle" — 2/2 fixed (create→reload→edit→reload)
  Ship:       BLOCKED — run: /ship docs/plans/<name>.md
═══════════════════════════════════════
```

## The accepted-plan skip — why it is a declaration, not a check

The field report also asked for `/audit-plan` to be skipped automatically "when
the governing plan is already accepted and unchanged". That needs a record
answering *was THIS content of the plan audited to convergence?* — and the store
does not hold one (checked 2026-09-27):

- Plan-mode `audit_runs` rows (`scripts/lib/audit/plan-audit-cloud.mjs`
  `registerPlanAuditRun`) record `commit_sha` = **HEAD at capture**, not the
  audited content. A plan is normally audited while dirty, so HEAD's copy of the
  plan is usually *not* the copy that was audited (AGENTS.md's Postgres-parity
  section says the same of `commit_sha` on code runs).
- `audited_tree`/`audited_sha` — the real target identity — are captured only on
  the **code** path (`runMultiPassCodeAudit`), never for plan mode.
- `gemini_verdict` (the APPROVE that ends `/audit-plan`) is written only when
  the orchestrator threads `--run-id`; absent that it is NULL, and NULL cannot
  be told apart from "never approved".
- A plan's `Status:` line is human-authored; it does not change when the plan
  body does, so it cannot say "unchanged".

Building an "accepted?" check on any of these would print a confident yes for a
plan whose audited content no longer exists — the unmeasured-reads-as-clean
shape. So `/cycle` never auto-skips `/audit-plan`. The skip is available only
by **explicitly** choosing `remediate` or `code`, which is the operator saying
"this plan is accepted", in words a reader of the transcript can see. If a
plan-content identity is later persisted (e.g. `audited_tree` on plan-mode
rows, from which the plan blob is `git rev-parse <tree>:<plan-path>`), an
automatic check becomes possible and this section is the place to replace.
