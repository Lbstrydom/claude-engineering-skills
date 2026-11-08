---
summary: Campaign mode — the C1-C12 contract an evaluation or test campaign plan must carry, and the dress-rehearsal gate.
---

# Campaign mode (`/plan --campaign`)

A **campaign** is a plan whose output is a *measurement* — an evaluation, a labelled
test set, a model comparison, a pre-registered experiment — rather than shipped code.
Its failure mode is different: the code can be perfect and the result still wrong,
because the instrument was blind, the test set leaked, the run died at 3 a.m., or the
write-up says something no artifact supports. Every item below exists because a real
campaign failed that way (the back-test is §6 of the test-campaign-controls plan in the
claude-engineering-skills repo); an item that caught nothing was dropped.

Not the model-comparison tool: `scripts/campaign.mjs` (model-comparison campaigns) is a
separate CLI. A **model swap** is never a campaign item — it is a synchronous run of the
model-eval harness when the model ships (no background collector).

## How to write it

Add `- **Mode**: campaign` to the plan header, and a `## Campaign Contract` section with
one `### C<n> — <title>` item per row below. Each required fact is a line
`- **<field>**: <value>` inside its item; an empty value or `TBD` counts as missing.
`/audit-plan` runs the presence check:

```bash
node scripts/campaign-contract-check.mjs docs/plans/<name>.md
```

It proves the plan **declares** each control — never that one ran. Reviewers still judge
whether the declared control is adequate.

## The contract

### C1 — Decision and metric
- **decision**: the decision the result will inform, and who makes it.
- **metric**: the metric, derived from the decision — not chosen because it is available.
- **error-costs**: the cost of each error type, and the base rate at which the metric is
  trivially satisfied (a 100% agreement on inputs with no vintage measures nothing).

### C2 — Split, leakage and sealed test custody
- **split**: how train / calibration / test are split — group-aware by canonical identity
  when the catalogue holds duplicates of one entity.
- **test-set-hash**: the test set's SHA-256 at freeze. A hash proves *identity*, not
  *secrecy*.
- **access-record**: where every access to the sealed set is recorded. "Test once" means
  one recorded, authorised run; a changed rule needs a fresh test set; any analysis
  designed after the results were seen is labelled exploratory.

### C3 — Feasibility and power
- **bound**: before pre-registration, the best result the declared rule could certify,
  as a number. Example: 0 errors in 50 hits gives a one-sided 95% lower bound on
  precision of only about 94.2% (0.05^(1/50)) — a 0.99 floor cannot be certified at 50.
- **assumptions**: what the bound assumes (sample size, error rate, independence), and
  whether the declared rule can produce a non-empty result at all.

### C4 — Instrument and controls
- **controls**: known-answer items that exercise the WHOLE pipeline, including candidate
  generation — not only the final decision. A control the candidate step can never
  surface is the one that finds the blind spot. A control must be indistinguishable from
  a real item: the CES audit canary was skipped in 7 of 12 runs while its path said
  "audit-canary", and in 0 of 6 once renamed.
- **independence**: what the labellers / adjudicators share. Two labellers reading the
  same candidate list are not independent; agreement on "none of these" is not evidence
  the answer is absent. State the number of adjudicators, or the single-adjudicator limit.

### C5 — Declared telemetry
- **telemetry**: every field the analysis will read, named before the run.
- **fill-check**: the day-0 check that each field fills with a real value. A zero is a
  measurement only if something measured it; an empty "reported model" field is a gap.

### C6 — Operations
- **revision**: the pinned revision the run uses — a dedicated worktree at a fixed commit
  (`git worktree add --detach ../pinned-run HEAD`, or the repo's own fixture tool), never
  the shared working tree a concurrent session or rebase can move.
- **model**: the model id requested AND how the id actually served is recorded.
- **spend-limit**: the spend cap, the provider quota checked, and the date of the price
  review (an expired review or a monthly cap is found before the run, not during it).
- **heartbeat**: the run id the job journals under —
  `node scripts/run-heartbeat.mjs run --run-id <id> --stale-after <sec> -- <cmd>`, watched
  per `/fleet` `references/background-runs.md`. Artifact hashes are written by a tool.

### C7 — Dress rehearsal
- **items**: an integer >= 5 — items taken end to end through the REAL pipeline, writing
  real artifacts, before the real run.
- **evidence**: the repo-relative path of the rehearsal's record (hashes verified,
  telemetry filled, canary detected). The real run waits for it.

### C8 — In-run canary
- **canary**: the known-answer item planted per batch or round; a miss makes that batch
  INCOMPLETE, not clean. For a CES audit round this is `AUDIT_CANARY=1`.
- **evidence**: the repo-relative path where canary outcomes are recorded.

### C9 — Contract epoch
- **contract-epoch**: the version stamp every evidence row carries. Evidence counts only
  if produced under the contract the stopping rule validates; a meaning-changing fix
  bumps the epoch and re-collects — never a backfill by date.

### C10 — Deviations
- **ledger**: where deviations are recorded. Anything "outstanding", "differs" or
  off-contract goes to the owner **before** merge, never folded in piecemeal.

### C11 — Done means artifact
- **done-evidence**: the artifact path(s), comma-separated, that prove each "done". At
  close-out they are verified as committed regular files on the base branch:

```bash
node scripts/campaign-contract-check.mjs docs/plans/<name>.md --closeout --rev origin/main
```

An artifact on an unmerged branch, untracked, or a symlink fails; the command prints each
file's SHA-256 for the close-out record.

### C12 — Close-out claims check
- **claims-check**: the write-up(s) the `/ship` close-out claims check runs over: every
  figure traces to an artifact and carries measured / derived / expected
  (`/ship` `references/claims-check.md`).

## The dress-rehearsal gate

The real run does not start until C7's evidence exists and shows, for its N items:
artifacts written where the plan says, hashes verified by the tool that will verify the
real run, every C5 field filled, the C8 canary detected, and a heartbeat journal that
reached `ENDED_OK`. A rehearsal that "mostly worked" is a failed rehearsal — fix and
re-run it; the cost is 5 items, not the campaign.
