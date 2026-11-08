---
summary: Step 1.5 claims check — every figure in a write-up traces to an artifact and carries its provenance label.
---

# Close-out claims check (Step 1.5)

A write-up is where a measurement turns into a claim, and where most measurement
errors survive review: a sentence nobody re-derived ("identity not retrieved" when it
was retrieved at rank 6), a figure from before a correction, a comparison stated
without its confound, a "done" whose artifact lives on an unmerged branch. No new
tool runs here — this step applies the existing verification doctrine
(`references/verification-discipline.md`) to the documents the change ships, and hands
anything it cannot settle to `/investigate`.

## Which documents

Anything the change adds or edits that reports a result: `docs/research/**`, a results
or analysis doc, a `status.md` entry, a plan's status / audit-trail / implementation log
that states figures, a campaign write-up (the plan's C12 `claims-check` field names it).
Code comments and changelogs are out of scope unless they state a measurement.

## Per figure

For every number, rate, count, ratio or comparison in those documents:

1. **Label** — `measured` (a command ran and printed it), `derived` (computed from
   measured figures — say from which), or `expected` (a prediction or target). An
   unlabelled figure is a finding.
2. **Trace** — the command, query or artifact path it came from, close enough that a
   reader can re-run it. A figure that traces to nothing is not shipped.
3. **Current** — re-derive any figure the change could have moved (a later correction,
   a re-run, a fix). A write-up updated before the last correction is stale.
4. **Qualified** — a comparison names what differs between its two sides (a different
   model, prompt or index is a confound, stated beside the figure); a rate states its
   denominator and the base at which it is trivially satisfied.
5. **Attributed** — a figure that is reproduced is not thereby explained; a stated
   cause needs its own check (`/investigate` reports figure and attribution apart).

Line citations: `node scripts/check-doc-citations.mjs <doc>` (report-only) — pin each
`path:line` to the commit it was read at.

## Per "done"

Every "done", "complete" or "run" in a status report names its artifact, and the
artifact is reachable from the base branch. For a campaign plan:

```bash
node scripts/campaign-contract-check.mjs docs/plans/<name>.md --closeout --rev origin/main
```

## Outcome

Fix what can be fixed in the document. Anything that cannot be settled from the
artifacts goes to `/investigate`; until it is settled, the claim is removed or labelled
`unverified` with the blocked prerequisite named. State the step's result in the ship
summary: `claims check: N figures checked, M fixed` — or `skipped: no write-up in this change`.
