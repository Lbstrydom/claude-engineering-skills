# Experiment 5 — Blind Adjudication Rubric

Frozen 2026-09-20, before any arm ran. Governs how the human labels
`blind-adjudication.csv` for `docs/plans/reviewer-cost-value-experiment.md`.
The adjudicator never opens `.blind-map.json`; every row is judged without
knowing which arm produced it.

## Columns the adjudicator owns

| Column | Values | Rule |
|---|---|---|
| `label` | `proven` / `actionable` / `plausible` / `false` | Evidence bar below. Same vocabulary and factors as experiment 1 (`proven` 1.0, `actionable` 0.6, others 0). |
| `cluster` | short stable id, e.g. `c-rateLimiter-noRefill` | Canonical **defect identity**. Two findings are one cluster iff fixing one root cause would resolve both. Same file, different root cause → different clusters. Different wording, same root cause → same cluster. |
| `sev` | `HIGH` / `MEDIUM` / `LOW` | Assigned **per cluster** from the impact rubric below. Applied once; every row in the cluster carries the same `sev`. |
| `sevReason` | one line | Which impact test fired, e.g. "reachable path returns wrong status code". |

The finding's *emitted* severity stays in its own column for calibration
and is never copied into `sev`.

## Evidence bar for `label`

- **proven** — the adjudicator can point at the defect in the diff (file +
  hunk) **and** state the concrete wrong behaviour, or has a reproduction
  (a test, a command, a trace). "It looks wrong" is not proven.
- **actionable** — real, but the fix or the exact trigger is not nailed
  down; the adjudicator can name what a fix would change. A finding that
  is correct but describes a MEDIUM as a HIGH is still `actionable` (or
  `proven`) — severity inflation is handled by `sev`, not by `label`.
- **plausible** — could be true; cannot be confirmed or refuted from the
  diff and surrounding code within ~5 minutes. Counts as noise, not credit.
- **false** — refuted by the diff or the code it cites; or restates
  something the diff explicitly handles; or cites a file/line that does not
  exist (the existence gate's `refuted` class).

Scope-contamination findings (about generated artifacts, gitignored output,
or files the commit did not touch) are `false`. A finding that is true of
pre-existing code the commit did not touch is `plausible` at most — the
experiment measures review of the *change*.

## Impact rubric for `sev` (per cluster)

| `sev` | Test (any one suffices) |
|---|---|
| **HIGH** | Incorrect behaviour on a **reachable** path (wrong result, wrong status, silent no-op where an action was expected); data loss or corruption; a security exposure (auth bypass, secret egress, injection); a crash on a normal input. |
| **MEDIUM** | Incorrect only on an edge or degraded path (empty input, provider error, race under concurrency) that the code plausibly reaches; a maintainability hazard that will produce a HIGH later (duplicated invariant, unguarded assumption, silent fallback that masks failure). |
| **LOW** | Style, naming, clarity, non-functional duplication, a comment that is wrong, a test that could be stronger. |

Tie-break: if unsure between two tiers, take the **lower** — an inflated
`sev` gives an arm credit it did not earn, which is the bias this column
exists to remove.

## Clustering rules

1. Read every row for a commit before assigning any cluster.
2. One cluster per root cause. A ×3 union arm raising the same defect three
   times yields three rows, one cluster, one credit.
3. A finding that names two independent defects is split: label the
   stronger one and add a note; do not create a compound cluster.
4. Gate rows (Flash/Pro net-new) cluster exactly like pass rows.

## What the adjudicator does NOT decide

Cost, eligibility, `best`, `winner`, cohort membership — all of that is
`score --decide` reading the sealed map after labelling is complete. The
adjudicator's only outputs are the four columns above.

## Time budget and stopping

Target ~12 minutes per commit across all its rows. If a commit's rows exceed
40, label the first 40 in file order and mark the remainder `plausible`
with `sevReason: "unreviewed — over cap"`; the verdict reports the count.
