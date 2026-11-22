---
summary: Enforced GPT round cap (plan 3/5, code 6/8), exit 4 CAPPED, and the structural-or-stop card read at the cap.
---

# Round cap and the structural-or-stop card

This is the canonical copy. Consuming skills carry a `references/round-cap-and-structural-card.md`
synced by `node scripts/sync-shared-audit-refs.mjs` and drift-checked in
`npm run check`. **Edit this file, never a copy.**

## The cap is enforced in code

`openai-audit.mjs` refuses a round past the cap before it spends anything — no catalog refresh, no
brief, no provider call. It is the GPT sibling of the Gemini gate's 2-round cap.

| Audit | Soft cap | Absolute cap |
|---|---|---|
| `plan` | 3 | 5 |
| `code` | 6 | 8 |

- **Within the soft cap**: runs as before. `--past-cap` on such a round is refused (`PAST_CAP_UNNEEDED`).
- **Past the soft cap, up to the absolute cap**: refused with **exit 4 (`CAPPED`)** and the card below,
  until `--past-cap "<why this round will converge>"` (15+ characters) is given AND the card for that exact
  round exists on disk. The sequence is: the refusal builds the card, you read it, you re-run the same command
  with `--past-cap`. The reason and a card summary are recorded on the run (`audit_runs.past_cap_reason`,
  `past_cap_card`) and on the round result (`_roundCap`).
- **Past the absolute cap**: always refused. `--past-cap` cannot lift it.
- **Exit 4 means stop, never retry.** It is not an error (1) and not an INCOMPLETE round (3). Do not re-run
  with different arguments, restart at round 1 under a new session id, or call the API another way. A refusal
  writes no `--out` file and no gate evidence, so a stop can never read as a pass.
- `--round` and `audit-loop.mjs --max-rounds` are parsed strictly (`3junk`, `1.5`, `0` are refused). The
  positional mode is authoritative; `--mode` must agree with it (`MODE_CONFLICT`). `audit-loop.mjs` defaults
  `--max-rounds` to `min(4, soft cap)` and refuses a limit above the soft cap without `--past-cap` at startup.

The cap counts the `--round` you pass within one session id. It is a per-invocation guard.

## "Another round" continues the SID

The cap counts rounds within one session id, so a fresh SID restarts it, and a fresh SID at round 1 also has no ledger (no
rulings injection, no `_priorRuling` links). PR #395's four "one more round" runs each started a new SID for that reason.

- A further round on the **same change** (same plan, branch and diff base) continues the SID:
  `--round <N+1> --ledger .audit/<SID>-ledger.json`, with the R2+ diff and changed-file arguments.
- A new SID is for a **different subject** (a new plan, or a re-scoped base the old ledger does not describe). Say so on the
  round card: `new SID: <reason>`.
- A round that would cross the soft cap is the card's CONTINUE choice, through `--past-cap "<reason>"`. A new SID is not a
  way around the cap.

This is guidance for the operator, not a gate: code cannot tell "the same change under a new SID" from a legitimate new audit.

## The structural-or-stop card

At the soft cap an audit that has not converged is usually not short of rigour; it is chasing something the
plan cannot see. wine's 55-round plan audit was chasing three missing shared primitives (document identity,
a lock registry, lot enrichment) — 16 of its 17 design defects were absorbed by them.

Build the card on demand, before the cap forces it:

```bash
node scripts/audit-structural-card.mjs --sid "$SID" --mode plan --round 4 --plan "$PLAN_FILE"
```

It clusters this audit's findings across rounds (same category and a shared file; plan findings also by cited
section) and looks each cluster up in the debt ledger, recurring clusters, pending triage, upstream issues,
unremediated acceptances, fleet proposals and — for the top three recurrent clusters — architectural memory.
Each cluster gets a verdict from an ordered table:

| Verdict | Meaning |
|---|---|
| **STRUCTURAL** | recurs in 2+ rounds AND shares a file with a backlog item, or has an architectural precedent: the concern lives outside this plan |
| **LOCAL** | recurs, uncorroborated, and every source answered: a design defect of this plan |
| **LOCAL?** | uncorroborated, but a source was unreadable or not asked: *unmeasured*, never shown as LOCAL |
| **POLISH** | seen in one round, or every finding LOW |

Read it as evidence for a human call, not as an instruction:

- A source that could not be read is **named with its reason**. The card never says "no structural pattern".
- Every match prints what it matched on (`via`), so an over-match on a hub file is visible.
- The card always asks: *would one missing shared capability remove several of these clusters?* It is a
  question, not a verdict. Nothing is created: no debt, no proposal.
- It states the **last triaged round's acceptance rate** and the HIGH trend, read from the ledger. At
  ≥ ⅔, on a card past the soft cap, it prints `⚠ AT THE CAP WHILE PRODUCTIVE`: if the run stops there, the
  cap stopped it, not convergence. **Carry that line into the final report** (rounds, acceptance at the last
  round), so the stop is not read as convergence. A card past the soft cap is also recorded as an
  observation-only `round_cap_reached` learning decision (stderr says whether it was) — the cap was REACHED
  with that productivity, not proof the run stopped: a CONTINUE is recorded on the run as `past_cap_reason`.
  So the cap policy can be decided on data later; the card does not change the policy or admit another round.

## Round signals and the step-back (code rounds 3 and 6)

For a code audit the card (requested for round 4 or 7) also prints three deterministic signals
(the round-signals module): **reopen rate** (findings whose cited lines fall in the post-image hunks of the
fix range, ≥ 0.5 fires), **severity drift** (median per-file change in max severity, ≤ -1 over ≥ 2 files fires) and
**retired** (accepted topics closed; ≤ 1 for two consecutive rounds fires). An unmeasured signal (no `audited_sha`, no cited
lines, no ledger) never fires and is never read as quiet; the card says the trigger is unmeasured.

When one fires, run `node scripts/audit-structural-card.mjs --sid "$SID" --mode code --round <N+1> --step-back`
(`--step-back-arm same|different`; a paid call, never automatic). A fresh-context reviewer reads an egress-gated pack and
returns `structural`, `stop` or `defect`; there is no `continue`. Invalid or unavailable output admits no round. A `stop` is
a proposal: debt is written only after a human approves it.

After round 6 the default is **stop-to-debt or a human**; rounds 7-8 need `--past-cap`. The 6/8 caps are unchanged.

## The human call

Present the card to the operator (the user, or the coordinator) with three choices, and record the choice in
the plan's audit trail:

1. **STOP** — accept the remaining findings as debt (`node scripts/debt-auto-capture.mjs …`).
2. **STRUCTURAL** — plan the shared primitive first (`/plan`, `node scripts/fleet.mjs propose …`), then return.
3. **CONTINUE** — one more round with `--past-cap "<reason>"`; not available past the absolute cap.

### PARTIAL final-gate coverage: reach FULL with disjoint batches

An `APPROVE` whose summary says `Code: PARTIAL, N changed line(s) never shown` is an approve **of the examined
files only**. It is not release-blocking, and it is not a clean approve either — never report it as one. The
cause is budget: the envelope renders whole files until it runs out, then windows or drops the rest.

Reaching FULL needs smaller transcripts, not a bigger budget. **Re-run the same review with `--batch`**: it
packs `changed_files` into disjoint batches under the render budget, checks the partition mechanically
(below), reviews each batch in turn and folds them into one verdict, one disposition and one marker. One
blocked batch blocks the whole review:

```bash
node scripts/gemini-review.mjs review "$PLAN_FILE" ".audit/$SID-transcript.json" --batch --round 1 --run-id "$RUN_ID" --out ".audit/$SID-gemini-result.json"
```

The folded `_batches[]` lists each batch's files, verdict and coverage. A batch still `PARTIAL` (one file
whose changed lines exceed the window budget) is reported, not hidden. **`--batch` partitions the transcript's `changed_files`, the same set an unbatched
review covers, so that set must itself come from the diff:** build the transcript with
`--changed "$(git diff --name-only "$BASE" | paste -sd, -)"`, never from a remembered list. Splitting by hand
(`build-audit-transcript.mjs --changed "<batch files>"`, one review each) is the fallback, and there the
rules below are yours to apply:

One large file per batch is usually enough; `FULL` includes *windowed with every changed line shown*, so a
batch need not render whole. Keep splitting any batch that still reports PARTIAL, and **re-run every batch
after any code change** — otherwise the FULL claim describes bytes you no longer ship.

**Check completeness BOTH ways, mechanically, from `git diff` — never from a file list you are holding in your
head.** Forward: every changed code file appears in exactly one batch. Backward: every batch member is a
changed file, no extras. Plus pairwise disjoint. Measured 2026-11-15 (#361): that check is what caught a
changed file sitting in **no** batch, because the batches had been built from a narrowing used earlier in the
session rather than from the diff. Asserting the union "looks right" is how a file goes unreviewed under a
FULL claim.

### Do not create a NEW file after the last round

Measured 2026-11-15 (PR #361): splitting a module late in the loop — to satisfy `size:ratchet:gate`, whose
own instruction is to split — made the final gate unsatisfiable. The reviewer's envelope is built from the
files the audit **rounds** examined, so a file that exists in none of them is dropped before the reviewer:
coverage `NONE`, gate `blocked`, *"not selected for the envelope"*. That is correct — no reviewer has seen
that file at that sha, and "it is only a move" is an argument, not evidence.

The only mechanical route out is a round past the cap to make it an audited subject, i.e. `--past-cap`. **Do
not reach for it here.** A cap override exists for a round that will converge, not for clearing a gate that is
accurately reporting unaudited code; in a permissioned host it is refused as an oversight bypass, and rightly.

So: **split a file BEFORE the loop, or after the PR lands — never between the last round and the gate.** If a
size ratchet trips mid-loop, the cheaper remedy is to condense the audit narrative the rounds just added to
that file: it belongs in the plan and the audit summary, where it already is, not duplicated at length in the
module. Generalises: **when a guard blocks you, check whether the thing it protects against is the thing you
just did.**

An agent may recommend; the call is the operator's. A `past_cap_reason` on a run whose card showed
`structural > 0` is the signal a coordinator reviews.

## Reading the numbers

`audit_runs.dismissed_count` / `accepted_count` count adjudicated finding **rows** in the run: a concern raised
in two rounds is two rows and counts twice, the same per-row meaning `total_findings` has. Plan triage seldom
dismisses (34 dismissals against 2,392 acceptances since 2026-10-04), so the acceptance-rate early stop rarely
fires on its own; the cap and the card are what end a plan audit.
