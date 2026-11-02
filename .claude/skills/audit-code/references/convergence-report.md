---
summary: Step 6–7 detail — census bookkeeping, example report card, source-repo steps, cross-surface clause, RUN_ID history.
---

# Convergence report and final-gate detail — Steps 6–7

## Step 6 — the per-round execution record

**A per-round execution record.** `arch-memory` is resolved **once**, by
Step 0.5, before any round's Step 2 begins, and is never re-seeded — Step 0.5
is not inside the round loop, so a design that "transitions" it per round is
chronologically unexecutable. Its single resolved value (`completed` /
`unavailable` under `--scope=full`; `ineligible` under `--scope=diff`, since
Step 0.5 is `--scope=full only`) is carried forward and rendered identically
in every round's census. The five passes and three mechanical waves ARE
seeded fresh each round: at Step 2's round start, seed one row per
pass/wave identifier `pending`; each owning step transitions only its own
row(s) on its own invocation. An aborted round finalizes every untouched
pass/wave row as `not-reached` at round-end, never leaving it `pending` (a
mid-round state, never a reportable one). Step 6 renders the current
round's finalized pass/wave rows plus the once-resolved `arch-memory` row —
not cumulative across rounds for the former.

`not-reached` is rare here: all five passes and three mechanical waves
execute unconditionally every round by design, and Step 5.0b's full-scope
detector re-run is mandatory for convergence to be assessed at all. If it
appears, it signals an aborted run (killed process, hard timeout).

## Step 6 — example report card

```
═══════════════════════════════════════
  CONVERGED (1 errored · 1 unavailable — see census) — Round 4
  Final: H:0 M:2 L:1
  Rounds: 4 | Time: 14m | Cost: ~$0.20
  Files changed: 6
  Remaining (accepted): [M3], [M7]

  CENSUS
    structure          completed
    wiring              completed
    backend             errored      (timeout after 90s)
    frontend            completed
    sustainability      completed
    quickfix (wave)     completed
    duplication (wave)  completed
    adjacency (wave)    completed
    arch-memory         unavailable  (AUDIT_DB_URL unset)
    file coverage       uncovered    (PARTIAL — 3 of 12 changed source file(s) not fully audited; 2 unrecognised file type(s): xyz ×2)
═══════════════════════════════════════
```

The suffix names **every kind present, with its own count** — never
hardcode one kind: a census with two non-`completed` rows of two different
kinds (as above) that names only one silently drops the other from the
top-level verdict, which is exactly the "issues masked by coverage gaps"
failure this section exists to prevent. A round with only `ineligible` rows
(an expected scope exclusion, e.g. no frontend passes on a backend-only
diff) names them `ineligible`, never folded into "errored" — mislabelling
an expected exclusion as a failure is its own honesty bug.

## Step 6.5 — telemetry dashboard in a consumer

Skip silently in
consumer repos. The dashboard is opt-in there, not absent: the builder syncs,
but the sync never adds npm scripts, so a consumer runs
`node scripts/build-dashboard.mjs telemetry` by path (`--help` lists every
mode). Never blocks the audit.

This refreshes the gitignored `dashboard/telemetry.html` so the just-run
audit's findings are visible in the local dashboard. Print the link:

```
Telemetry dashboard: file://<abs-path>/dashboard/telemetry.html
```

`telemetry.html` is gitignored — never staged, never committed.

## Step 6.5b — why the solo author-model control runs from here

The solo control is a *centralized* research baseline:
its blind human adjudication happens in one place, and a single source-repo run already
sweeps sibling repos' shadow commits via `SOLO_CONTROL_REPO_ROOTS`. So it collects
data for ALL local repos from here — it does not fragment across consumers.

Standing policy: whenever the model-A/B/C shadow (`arm-eval`) toggle is ON, keep the
**solo author-model baseline** current — clean Sonnet-5 + Fable-5 cold-diff over the
same shadow commits. This is the null-hypothesis control the A/B/C arms lack (do the
external auditor pipelines earn their keep vs a capable model reviewing the diff bare,
and is the *cheap* model already good enough?). See `docs/research/runbooks/solo-control-experiment.md`.

The script **self-gates on the toggle** (no-ops when the shadow is off) and is
**incremental** (skips commits already covered), so this is safe to fire
unconditionally after every source-repo audit; sibling-repo shadow commits are swept
at the next source-repo run. Human blind adjudication is a separate offline step
(`solo-control merge` → label → `score`) — never inline. Best-effort: a failure here
is logged and ignored.

## Step 6.6 — how the recommender ranks

It's an advisory
**nudge, never a gate** — the user chooses. The browser lenses (persona/click/nav/visual)
run against the **deployed** app, so at audit time they're "worth running after you
deploy"; `/ship` surfaces them again when the app is live. Ranked by leverage
(unguarded HIGH fix → theme → nav → semantic-DOM → journey), capped at 2, and it
never re-suggests a lens already covered for this commit.

## Step 6.7 — cross-surface honesty clause (GREEN ≠ REALIZED)

A clean static audit is **necessary but not sufficient** for cross-surface agreement.
When the change introduces a user-visible DYNAMIC value (a count / status / total /
eligibility) that DUPLICATES or re-derives a value another surface shows, a green
verdict on the changed file does **not** prove the two will agree at runtime — this
class shipped a P0 past both `/audit-code` and the Gemini gate. If the frontend pass
raised a `derived-state-parity` finding (or you can see this pattern), do not close it
on "looks correct"; require one of the three checkable artifacts (shared SSoT / parity
assertion / a declared `data-engine-claim` surface) and **nudge the author to declare
the value as a `data-engine-claim` surface** so persona-test `--mode consistency`
verifies it at runtime. Affordance/intent judgements stay out of scope — this is only
the "two surfaces must show the same number" check.

## Step 7 — why RUN_ID is read the way it is

```bash
# Pass --run-id <_cloudRunId> when the audit --out JSON carries one, so the
# final-review (and the optional shadow A/B reviewer) persist their per-finding
# results keyed to this audit_run. Read it from the audit result — pass the path
# as an ARGUMENT (process.argv[1]), never embed it as a literal string inside
# the -e source, so the SAME shell that resolved the audit's --out path resolves
# this one identically. (Artifacts now live in repo-relative `.audit/`, which
# every reader resolves the same way; under the old `/tmp/` layout Bash and Node
# disagreed outright — confirmed live 2026-07-26: Bash's /tmp landed in
# AppData/Local/Temp, Node's resolution of the same literal in C:\tmp, and the
# snippet threw MODULE_NOT_FOUND on a file that genuinely existed.) Found by tracing
# WHY a consumer repo's 101 real audit runs, over 30 days, all had a genuine
# Gemini verdict computed (visible in that session's own logs) but NEVER
# persisted to audit_runs — this exact snippet was silently throwing inside
# $(...), which discards the failure and leaves RUN_ID empty with no visible
# error. fs.readFileSync + JSON.parse (not require — this is a data file, not a
# module) with a try/catch fails safe to an empty RUN_ID rather than crashing.
# ROUND = the last round actually run (matches the `-r$ROUND-result.json`
# convention Step 2/Step 3.5b/Step 6.6 already use — NOT a bare `-result.json`).
# gemini-review.mjs itself now warns loudly (2026-07-26) when cloud is enabled
# but --run-id is absent — if you see that warning, the extraction above
# failed; don't ignore it. Omit --run-id only when cloud is genuinely off.
```

## Step 7 — shadow A/B reviewer (optional, observation-only)

**Shadow A/B reviewer (optional, observation-only)**: set `FINAL_REVIEW_SHADOW`
(e.g. `claude-opus`) to run a second blind reviewer in parallel with the
primary — it never gates the build, attributes findings per `source_model`, and
persists the diff for `final-review-stats`. No-op when unset or under an Azure
profile. See `docs/plans/final-review-shadow-reviewer.md`.
