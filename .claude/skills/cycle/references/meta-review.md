---
summary: Automatic meta-review at the round cap: triggers, guard, records, overrides, opt-out.
---

# The automatic meta-review at the round cap

> **GENERATED COPY — do not edit.** The canonical is
> [`docs/audit/shared-references/meta-review.md`](https://github.com/Lbstrydom/claude-engineering-skills/blob/main/docs/audit/shared-references/meta-review.md).
> Regenerate with `node scripts/sync-shared-audit-refs.mjs`; `npm run check`
> fails on drift. Links above were re-spelled for this location — a target
> outside this skill's own directory becomes an absolute upstream URL,
> because this copy is copied again into `.claude/skills/`, then into
> consumer repos, and a packaged skill ships only its own directory — no
> relative path reaches anything else. So this file is NOT byte-identical
> to the canonical by design.
The design and its rationale are the upstream plan for this feature (source repo only).

When an audit reaches its cap, or a code audit shows a spinning signal, a stronger reviewer from a **different vendor**
steps back from the loop and decides whether more rounds pay off. Its interest is the repository's sustainability,
efficiency and effectiveness, not rigour for its own sake: it names rigour-chasing (polish, re-raised settled concerns)
and stops it, and it looks for a **structural** cause in the repo (a missing shared primitive, a seam that keeps
breaking, a stale doc) and proposes that fix as its own plan or PR. It runs inside `openai-audit.mjs`'s round-cap
gate, so it is the default path on every host.

## When it fires

| Trigger | When | Audits |
|---|---|---|
| **T1** at the cap (**off by default**) | a round refused past the soft cap (plan 4-5, code 7-8), with `AUDIT_META_REVIEW_T1=on` | plan and code |
| **T2** a spinning signal | code round 4, when a round signal fired at checkpoint 3 | code only |

It never fires past the absolute cap, for a session with no prior round results, or when opted out.

**T1 is off unless you opt in** (`AUDIT_META_REVIEW_T1=on`). A pilot on code audits found the decision cost more than
the round it avoided, and it admitted none of the rounds it judged; plan-mode T1 was switched off with it, unmeasured.
Off, a refused round exits 4 with the human card, no reviewer is called, and an admission recorded earlier is ignored.

## The reviewer

`latest-opus` pinned to the sdk backend (gated on `isClaudeAvailableFor('sdk')`, never a cli fallback), else
`latest-pro`. An arm in the **auditor's** vendor family is skipped; an unknown auditor family admits no reviewer.
One attempt is one call: a 120 s deadline, no retries (SDK-internal ones included), a session budget of 3 calls
(code) or 2 (plan). It reads the step-back's egress-gated pack (sensitive paths excluded and counted, every body
secret-redacted), plus a header naming the open-topic inventory.

## It decides within bounds

It answers **admit** (1-2 rounds, naming open topics), **stop** (every open topic, each with a kind:
`rigour-chasing`, `settled`, `marginal`, `false-premise`) or **structural** (cause, evidence files, proposed fix).
There is no bare continue. A deterministic guard decides whether the answer is **honoured** or **downgraded** to
the human path; it never raises a cap.

| Verdict | Honoured when | Honoured effect |
|---|---|---|
| admit (T1) | every named topic is open | the round runs, stamped `meta-review <attemptId>`, up to `min(round-1+n, absolute)` |
| stop | it covers every open topic; every HIGH is `settled`, and settled means the ledger ruled it in an earlier round or the auditor stamped it `_priorRuling` | exit 4 `META_STOP` and the debt command |
| structural | every evidence file was in the pack; no open HIGH is unruled | exit 4 `META_STRUCTURAL`, cause and proposed fix printed, the debt command |
| any stop at T2 | as above, **and** the last round is measured unproductive (< ⅔ accepted) | exit 4 before the soft cap |

Downgraded, unavailable, invalid or truncated → **today's behaviour**: T1 exits 4 with the human card; T2 runs the round.

## Gate-loosening parts (Louis approves before merge)

- **L1** — an admitted round past the soft cap runs without a human `--past-cap`.
- **L2** — a code audit can stop at round 4, before the soft cap (only when measured unproductive).
- **L3** — after an honoured stop/structural, the skills run the debt capture themselves:
  `node scripts/debt-auto-capture.mjs --meta-decision .audit/<sid>-meta-review.jsonl --decision <attemptId> --run <sid>`.
  A non-zero exit there is an **incomplete handoff**: report it with the counts, never "stopped clean".

## Every decision is recorded

`.audit/<sid>-meta-review.jsonl` is append-only (`reserve`, `decision`, `override`, `revoke`, `debt-capture`), written
before anything is acted on. Each decision carries its inputs (signals, productivity, inventory, pack hash), verdict,
guard result, model, tokens and cost (`usage`, `estimate` when a sent request returned no usage, `none` when nothing
was sent). An allowlisted projection (ids, counts, enums; no paths or prose) goes to the learning store as
`meta_review_decision`. The structural-or-stop card prints the session's decisions.

## Overrides and opt-out

- A T1 stop: re-run with `--past-cap "<why>"`, as before; it is recorded as an override of that decision.
- A T2 stop: re-run the same round with `--meta-override "<why, 15+ chars>"`; refused when there is nothing to override.
- An admission: `node scripts/audit-structural-card.mjs --sid "$SID" --mode code --revoke-meta-admission --by "<name>" --reason "<why>"`.
- T1 on: `AUDIT_META_REVIEW_T1=on`. T2 needs no setting.
- Off for one run: `--no-meta-review`; off everywhere: `AUDIT_META_REVIEW=off` (`npm test` sets it). Both beat the T1 opt-in.
- A held `.audit/<sid>.meta-review.lock` fails closed to the human path; if no audit of that session is running, a
  crashed one left it: delete it. An attempt **reserved with no decision** (a crash mid-call) also fails closed, for
  that attempt only, and the log keeps it (append-only, charged to the budget): take the human path for that round
  (`--past-cap`, or `--meta-override` at code round 4), or `--no-meta-review`. A changed plan, diff or HEAD is a new attempt.

## What the operator does with the result

| Exit / code | Do |
|---|---|
| 0, `meta-review <attemptId>` in the cap line | continue the loop: this round was admitted |
| 4 `META_STOP` | run the printed debt command, report the stop with its decision id |
| 4 `META_STRUCTURAL` | run the debt command, propose the structural fix (`/plan`, `node scripts/fleet.mjs propose`) |
| 4 `PAST_CAP_REQUIRED` | the human card, as before (the meta-review was downgraded or unavailable; the stderr line says which) |
