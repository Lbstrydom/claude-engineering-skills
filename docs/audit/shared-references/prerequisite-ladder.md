---
summary: Step 0 prerequisite ladder — absent helper bundle or auditor route, and reporting a run that did not happen.
---

# Prerequisite Ladder — Step 0

Step 0 of `/audit-plan` and `/audit-code` lists prerequisites. This is what to
do when one of them is not there.

This is the canonical copy. Consuming skills carry a
`references/prerequisite-ladder.md` synced by
`node scripts/sync-shared-audit-refs.mjs` and drift-checked in `npm run check`.
**Edit this file, never a copy.**

**The failure this exists to stop.** The audit family used to state
prerequisites and stop — *"Validate: plan file exists, `OPENAI_API_KEY` is
set"* — with nothing said about the other branch. So the flow died mid-run on a
bare `MODULE_NOT_FOUND` or a one-line `Error: OPENAI_API_KEY environment
variable required`, **after** the user had paid to produce the artifact being
audited. Reported by a consumer 2026-08-27. Two of this repo's own skills
already model the answer and neither was applied here: `/ship` degrades and
prints a one-line disclosure, and `references/gemini-gate.md` defines a ladder
for a missing final-reviewer key. That ladder covers the *final reviewer* only —
it says nothing about the GPT legs or about the helper scripts themselves, which
is the gap this file closes.

**Why it matters more here than in `/ship`.** A skipped commit trailer is
cosmetic. A skipped audit gate means *the gate did not run*, and the difference
between "we audited it" and "we said we audited it" has to survive into the
report and the commit.

## Rung 0 — resolve the prerequisite before deciding anything

Run the check first; do not infer availability from a variable name.

> `npm run <script>` below names a **package.json script**, not a package
> manager — pnpm, yarn and bun read the same entry and just invoke it
> differently. Use whichever your repo declares (`package-manager.mjs` is the
> code-level oracle for the same question).

- **Helper bundle** — the scripts this skill invokes live in `scripts/` in this
  source repo and in `scripts/.claude-skills/` in a consumer. In a linked git
  worktree that tree is absent, and the remedy is inlined in the
  **Worktree preflight** block at the top of this skill: run
  `npm run skills:hydrate`, or add the `package.json` entry the block quotes and
  then run it. Re-attempt the step once after hydrating.
- **Auditor route** — ask whether a ROUTE exists, not whether one public
  variable is set. `OPENAI_API_KEY` **or** an active Azure profile
  (`AZURE_OPENAI_ENDPOINT`) both satisfy the GPT leg; `openai-audit.mjs` already
  gates on `!azureConfig.active && !process.env.OPENAI_API_KEY`. `npm run
  check-setup` reports the resolved answer for every leg at once.

A prerequisite that resolves at Rung 0 is not a degradation — proceed normally
and say nothing.

## Rung 1 — the auditor route is absent

The GPT passes are the audit. Without them there is no transcript for the final
reviewer to review, so the whole flow degrades rather than one step.

1. **Say so before doing any work**, in one line, naming the concrete missing
   prerequisite and the resolved alternatives you checked — the same shape
   `/ship` uses. A bare "not applicable" is not a reason.
2. **Offer the substitute, and label it.** Spawn an independent adversarial
   review agent over the same scope with the plan and the diff, exactly as
   `references/gemini-gate.md`'s last rung does for the final reviewer, and record
   its verdict in the same `APPROVE` / `CONCERNS` / `REJECT` shape. This is a
   documented substitute, not a bypass, and it is labelled as one in the report.
3. **Do not present the substitute as the audit.** The report header says
   `AUDIT_DEGRADED — GPT legs unavailable, adversarial-agent substitute` and the
   pass census (Step 6) carries `unavailable` rows naming the prerequisite, per
   `references/verification-discipline.md` §7.

## Rung 2 — the helper bundle is absent and cannot be hydrated

Hydration answers the worktree case. When the tree is genuinely missing — a
consumer that has never synced, or a sync that failed — there is no substitute:
the passes, the ledger writer and the transcript builder are all in that tree.

1. Report `AUDIT_NOT_RUN`, naming the first path that failed to resolve.
2. Point at the one command that fixes it: `npm run sync -- --target <name>`
   from the `claude-engineering-skills` checkout. A consumer cannot repair this
   from inside its own repo — see the upstream-ownership rule in `AGENTS.md`.
3. Stop. Do not hand-roll a substitute for the passes; an audit whose
   instrument is missing has no result to report.

## Rung 3 — make the outcome machine-visible

An audit that did not run has to be distinguishable downstream from one that ran
and passed. The mechanisms already exist — use them rather than inventing a
field:

| Outcome | Pass census (Step 6) | Gate evidence | `/ship` trailer |
|---|---|---|---|
| ran, converged | `completed` rows | `.audit/last-audit-run.json` written | `--gate passed` (store-verified) |
| ran, degraded (Rung 1) | `unavailable` rows naming the prerequisite | written, verdict not `passed` | `--gate not-run` |
| did not run (Rung 2) | no census — say `AUDIT_NOT_RUN` | no marker written | `--gate not-run` |

`AI-Gate: passed` is verdict-verified against the store and fails closed, so a
degraded or absent run cannot claim it — that is the design, not an obstacle to
work around. `not-run` is the honest value and needs no override flag.

**Never let a degraded run reach `/ship` as a silent clean.** The census row and
the report header are what carry the distinction; if neither is present, the
next reader has no way to tell the two apart, which is the state this ladder
exists to prevent.
