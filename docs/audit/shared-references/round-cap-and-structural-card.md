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

## The human call

Present the card to the operator (the user, or the coordinator) with three choices, and record the choice in
the plan's audit trail:

1. **STOP** — accept the remaining findings as debt (`node scripts/debt-auto-capture.mjs …`).
2. **STRUCTURAL** — plan the shared primitive first (`/plan`, `node scripts/fleet.mjs propose …`), then return.
3. **CONTINUE** — one more round with `--past-cap "<reason>"`; not available past the absolute cap.

An agent may recommend; the call is the operator's. A `past_cap_reason` on a run whose card showed
`structural > 0` is the signal a coordinator reviews.

## Reading the numbers

`audit_runs.dismissed_count` / `accepted_count` count adjudicated finding **rows** in the run: a concern raised
in two rounds is two rows and counts twice, the same per-row meaning `total_findings` has. Plan triage seldom
dismisses (34 dismissals against 2,392 acceptances since 2026-10-04), so the acceptance-rate early stop rarely
fires on its own; the cap and the card are what end a plan audit.
