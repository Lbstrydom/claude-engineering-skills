# Runbook: model-comparison campaigns

**What it is** — a declarative way to answer "is model X better than model Y for
role Z, and is it worth the money?" with evidence you can defend. You commit a
campaign file; the runner derives its arms from it; an agent adjudicates each
finding **blind**; you review a sample; a two-stage rule produces a verdict.

**When you need it** — a model ships and you want to know whether to switch, and
you want the answer to survive someone asking "how do you know?".

**Design + rationale**: [`docs/plans/model-comparison-campaigns.md`](../plans/model-comparison-campaigns.md).

> **Every command below pastes as-is.** Real values, never `<angle-brackets>` —
> PowerShell reserves `<`, and an unpasteable example is an example nobody runs.
> Substitute your own campaign id and finding uuid.

---

## The five steps

```
declare → collect → adjudicate → review → decide
```

Each one refuses rather than guesses when its inputs are wrong. That is the
feature: the failure this machinery exists to prevent is a confident number
nobody can trace.

---

## 1. Declare

Create `.campaigns/my-campaign.json` — **committed and reviewed**, like
`.requirements/`. It is data, never code: the synced runner must never execute a
file a consumer wrote.

```json
{
  "schemaVersion": 1,
  "id": "final-review-2026q3",
  "role": "final_review_shadow",
  "decision": { "type": "select_default", "incumbent": "claude-opus" },
  "arms": [
    { "id": "opus", "model": "claude-opus", "mode": "shadow" },
    { "id": "solo-opus", "model": "claude-opus", "mode": "primary", "type": "replicate" },
    { "id": "kimi", "model": "moonshotai/kimi-k2-thinking", "mode": "shadow" }
  ],
  "controls": {
    "reasoningEffort": "high",
    "promptTemplateId": "final-review-shadow@4",
    "outputSchemaId": "final-review@3",
    "maxOutputTokens": 32000,
    "toolPolicy": "structured-output-only",
    "temperature": 0
  },
  "adjudicator": {
    "model": "latest-opus",
    "promptTemplateId": "campaign-adjudicate@1",
    "outputSchemaId": "adjudication-verdict@1"
  },
  "calibration": { "sampleRate": 0.2 },
  "targetN": 12,
  "decisionRule": {
    "floorMetric": "accepted_high_med_per_snapshot",
    "floorMargin": 0.5,
    "tiebreak": "cost_per_accepted",
    "costCeilingUsdPerAccepted": 8
  }
}
```

Validation is **strict and closed**: an unknown key rejects. A typo'd
`reasoningEfort` fails loudly instead of silently running at a provider default —
an unpinned control is how a comparison becomes uninterpretable *after* you have
paid for it.

**Rules that catch a config which parses but means nothing:**

| Rule | Why |
|---|---|
| `targetN >= 12` | Below it the verdict engine emits INCONCLUSIVE anyway; a smaller N buys a cheaper campaign that answers nothing |
| At least 2 non-replicate arms | One arm is not a comparison |
| `decision.incumbent` names exactly one non-replicate arm's model | The baseline must be unambiguous |
| A `replicate` shares its model with a non-replicate arm | A replicate of nothing is a mislabelled scenario |
| At most one `mode: "primary"` | The shadow protocol has one primary |
| `floorMargin >= 0` | A negative margin lets a strictly worse arm clear the floor |

**Declare a replicate deliberately.** Two arms sending a byte-identical request
are a *reroll*, not a comparison. The runner computes each arm's fingerprint
**before spending** and refuses unless the duplicate is declared
`"type": "replicate"`. Discovering it afterwards means the aggregate was already
wrong.

### 1a. The auditor role — a manifest, not a campaign file

Everything above (steps 1–5) is the `final_review_shadow` role. The
**auditor** role answers a narrower question — "which of these candidate
audit-generator routes is cheapest among the ones that clear their own
recall/false-positive floor?" — over one synchronous run of the curated
known-defect corpus, not a multi-day shadow campaign. It shares the SAME
manifest schema (arms, controls, subject) but is declared and run
differently: no `.campaigns/*.json`, no `targetN`/`decisionRule`, no
adjudicator, no calibration sample. `role must be "auditor"` is enforced at
load — a `final_review_shadow` manifest is refused by name, not with a
generic parse error.

```json
{
  "schemaVersion": 1,
  "id": "auditor-screen-2026q3",
  "role": "auditor",
  "decision": { "type": "select_default", "incumbent": "latest-gpt" },
  "arms": [
    { "id": "gpt", "model": "latest-gpt", "mode": "primary" },
    { "id": "sonnet", "model": "latest-sonnet", "mode": "shadow" }
  ],
  "controls": {
    "reasoningEffort": "medium",
    "promptTemplateId": "auditor-v1",
    "outputSchemaId": "auditor-v1",
    "maxOutputTokens": 4096,
    "toolPolicy": "none",
    "temperature": 0,
    "passes": ["structure"],
    "scope": "diff",
    "rounds": 1
  }
}
```

Run it directly — no `bakeoff-collect.mjs`, no `reconcile`:

```bash
node scripts/model-eval-auditor.mjs --manifest auditor-screen-2026q3.json --tier screen
```

**`--candidate` and `--manifest` are mutually exclusive**, and the CLI
refuses the combination before any provider call — `--manifest` is a
*driver*, not a supplemental input: it expands into one real `--candidate`
invocation per scored arm (a genuine spawned child process each), so the
"must supply a candidate" requirement is satisfied at every actual
execution, not bypassed by declaring arms instead. At least two SCORED arms
(`type` unset or `"scored"`, never `"control"`/`"replicate"`) are required —
a manifest with fewer refuses at schema validation, zero provider calls.

Each scored arm's run persists to `model_eval_runs`, linked to one
`model_eval_comparisons` row keyed on `(repo, manifest id, config digest,
lock schema version)` — re-running the SAME manifest (byte-identical digest)
resumes into the same cohort rather than double-charging an arm that already
succeeded (the same D5a resume/retry contract the campaign role uses).
`node scripts/cross-skill.mjs get-neighbourhood` and this repo's own
architectural-memory tooling read `model_eval_comparisons`/`model_eval_runs`
directly — there is no dashboard tab for the auditor role today; the
Campaigns tab (step 4 below) is `final_review_shadow`-only.

A manifest declaring a subject path (`corpusPath`/`diffPath`/
`transcriptDir`) that resolves to a sensitive location — lexically or via a
symlink — refuses at **load**, before any provider call, non-zero exit.

---

## 2. Collect

**Collect in a pinned fixture, not the shared working tree.** A snapshot spawns
6 arms over 15–25 minutes and the store refuses one whose arms disagree about the
commit ("one snapshot is one revision"). Two snapshots and ~$13 were destroyed on
2026-08-17 — once by a rebase mid-collection, once by a **concurrent agent
session** committing while collection ran. Several sessions routinely work this
repo in one tree, so this is not something care prevents.

```bash
npm run fixture:create -- --name bakeoff-2026q3 --rev HEAD --campaign final-review-scoped-2026q3
```

That pins the revision, links `node_modules`, and **verifies every declared arm's
credential before anything is spent** — a missing key does not error at runtime,
it makes the arm record as SKIPPED and the snapshot is rejected only after the
other arms have billed. Full guide:
[`pinned-revision-fixture.md`](pinned-revision-fixture.md).

Then, from inside the fixture — note the **absolute** transcript path, because
`.audit/` is gitignored and therefore absent from the fixture:

```bash
node scripts/bakeoff-collect.mjs --transcript C:/GIT/claude-engineering-skills/.audit/transcript.json --plan docs/plans/model-comparison-campaigns.md
```

> **Transcript-starved? Look in the archive.** `.audit/` holds only the working
> copies (`audit-clean.mjs` caps them at the newest 25), and a transcript
> produced by an audit inside a throwaway agent worktree used to be **deleted
> with that worktree** — which is why `final-review-scoped-2026q3` stalled at
> 7/12 snapshots while this repo audited constantly. Every transcript is now
> mirrored at write time into **`<main checkout>/.audit/transcripts/`**, the
> durable archive; `npm run audit:transcripts:harvest` sweeps any linked
> worktree that predates the mirror. Feed the collector from there when the
> working copy is gone. Plan:
> [`audit-transcript-durability.md`](../plans/audit-transcript-durability.md).

> **Trust the store, not the local log.** `LOG_PATH` is the repo-relative
> `.audit/bakeoff-log.jsonl`, so a fixture writes its **own, empty** one. Running
> `--progress` there reads near-zero **regardless of real campaign progress**, and
> it looks exactly like lost work. It is not. `reconcile` (below) against the
> store is the only trustworthy count, and `npm run fixture:verify` prints the
> fixture-local number beside a label saying it is not campaign progress.

Arms are derived from your config — there is no hardcoded table to fork. The
runner stamps every snapshot with a **lock digest** computed over the resolved
reality (models after sentinel resolution, provider routes, reasoning effort,
prompt template, adjudicator, pricing version, eligibility rule, arm set).

Change any of those and prior evidence is **orphaned into its own cohort** —
automatically, with no string to remember to bump. That is the whole point: five
false "window met" reads came from evidence counted under a contract it was not
produced under.

Promote what you collected into the store, and heal anything a crash left behind:

```bash
node scripts/campaign.mjs reconcile --campaign final-review-2026q3
```

`reconcile` does two things and reports both:

- **Promotes** bake-off log entries into the campaign spine. Every refusal is
  named — a snapshot that quietly fails to promote is indistinguishable from one
  never collected, and your denominator would shrink with nobody seeing it.
- **Scans receipts.** `complete` = paid and unrecorded, recoverable.
  `intent` = the true crash window, where paid-or-not is genuinely **unknown**.
  An `intent` receipt is **never auto-retried** — silently re-calling is exactly
  the double-charge the protocol exists to prevent. Exit code 4 means operator
  action is outstanding.

---

## 3. Adjudicate

```bash
node scripts/campaign.mjs adjudicate --campaign final-review-2026q3 --limit 10
```

**One-time setup.** The worksheet needs a per-campaign HMAC key in your
gitignored `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Add it as `CAMPAIGN_HMAC_KEY_FINAL_REVIEW_2026Q3` (the id, uppercased, non-alphanumerics
to `_`). An absent key is a **hard refusal**, never a regenerated one: a new key
produces different row ids and would orphan every human disposition already
recorded. Rotation is unsupported and refused with an explanation rather than
half-implemented.

**The agent VERIFIES; it does not judge.** Each verdict records a `method`:

| method | meaning | counts? |
|---|---|---|
| `verified` + `accepted` | the defect IS present at that revision | yes |
| `verified` + `dismissed` | it is not present, with an absence reason | yes |
| `unverifiable` + `needs_triage` | the instrument could not settle it | **no — routes to you** |

That distinction is why these verdicts are worth recording at all: LLM
*re-judgement* of historical findings measured 52% agreement with a human here,
while verification against code is instrument-settleable.

**Those three pairs are the whole vocabulary, and the rule is a
biconditional**: `needs_triage` if and only if `unverifiable`. The producer
coerces any other pair onto `unverifiable`/`needs_triage` and says so
(`incoherent verdict pair` on stderr), the store refuses it by name, and
Postgres refuses one of the two directions as
`fae_needs_triage_is_unverifiable_chk`. Coercion is always *downward* — the two
fields disagree about whether the claim was settled, and only "not settled"
cannot manufacture evidence. (Measured 2026-08-19: the adjudicator returned
`verified` + `needs_triage`, the database refused it, and paid-for verdicts were
lost while the run reported success.)

**Read the last line — it is arithmetic, not a mood.**

```
  10 row(s) attempted: 4 settled as evidence · 6 routed to the human queue (1 provider failure(s))
```

The buckets are disjoint and they close: every attempted row lands in exactly
one of `settled` / `routed` / `FAILED TO RECORD` / `skipped`, and the line says
`ACCOUNTING BUG` rather than a tidy total if they ever do not.
`provider failure(s)` is a subset of `routed`, never an addition.

**A verdict that could not be stored fails the command.** `FAILED TO RECORD`
means a provider call was paid for and its verdict is not in the store, so the
batch stops there (a write failure is a contract or schema refusal, not provider
variance — continuing pays for verdicts that cannot be stored either) and
`adjudicate` exits **1**. The receipt stays in state `complete` (paid,
unrecorded), which is what `reconcile` lists. Accepted counts are incomplete
until those rows are re-adjudicated.

**`--dry-run` writes nothing.** It previews the rows that would be sent to the
adjudicator and the rows that would be forced `unverifiable` with no provider
call (those cost nothing), and it neither creates the worksheet nor records a
verdict.

**The worksheet is blind**, by whitelist and redaction — not by omitting a
column. Finding prose names its own provider ("Opus 5 thinks by default"), so
model ids, provider names and your own arm ids are replaced with placeholders.
Cited repo source is deliberately *not* redacted: it is identical whichever arm
cited it, and this repo's own source legitimately contains model ids.

**A plan-mode finding is verified against the plan.** Its `primary_file` is a
`§`-section, not a path, so there is no file to retrieve and the row used to
reach you having never reached the adjudicator — 107 of 201 findings in cohort
`e52eec728688fcab`, 60% of that campaign's human queue (measured 2026-08-19).
The run's `audit_runs.plan_file` is now cited instead, at the snapshot's own
sha, labelled `kind: "plan-document"` so the adjudicator knows it is reading
prose rather than code. It is a **fallback**: a finding that resolved its own
sources never also drags in the plan. The window is anchored on the finding's
quoted prose first, then on the section title — and when neither matches, the
excerpt is an honest head window whose `truncated: true` routes the row to you
as before.

**A file may be shown as several spans.** A finding can name two places at once
— two sections of a plan, or a span that appears TWICE — and one centred
window answers only the first. Up to three non-contiguous windows are cited per
file, each carrying `windowIndex` of `windowCount`, and the per-file line and
character budgets are **divided** across them: showing three spans costs what
showing one used to (measured: average excerpt bytes per row 12,281 → 12,459,
+1.4%, while anchor coverage went 73.6% → 89.0%). Occurrences close enough to
share a window are clustered into one rather than duplicated — which is how a
heading repeated 120 lines later lands in a single span.

**Re-adjudicating a row that already has a verdict** — `adjudicate` visits only
rows with no live agent verdict, so an improvement to citation resolution
cannot reach the rows it would have helped. `--redo` is the way past that
filter, and it is deliberately narrow:

```bash
node scripts/campaign.mjs adjudicate --campaign final-review-scoped-2026q3 --redo FINDING_UUID,FINDING_UUID --reason "wider citation window"
```

Named findings only, never "everything again". `--reason` is required (a redo
moves numbers that are already published, and the campaign log records why),
ids not in this cohort are refused before any spend, and **a finding a human has
already dispositioned is refused outright** — the override names the agent
verdict it overrides, and that pair is the calibration figure. Prior verdicts
are superseded, not deleted: they were paid for and stay readable. Each run
appends a `verdicts_redone` event carrying the reason and the outcomes.

Findings are verified against the snapshot's **own** `audited_sha`, never the
working tree. A finding that was true when collected and has since been fixed
would otherwise be recorded false — penalising the arm that correctly found a
real defect, by a margin that grows the longer the campaign runs.

---

## 4. Review

Open the dashboard's **Campaigns** tab:

```bash
npm run dashboard
```

Evidence quality comes first, standings second — deliberately. The eye must
cross the gates before it reaches the numbers they qualify. Standings carry a
`NOT DECISION-ELIGIBLE` watermark, in text, **naming every failing gate**, until:

- `N >= targetN` complete snapshots, and
- every finding has a terminal adjudication, and
- every `unverifiable` finding has a human disposition, and
- the assigned calibration sample is dispositioned per arm, and
- every complete snapshot has a cluster set.

Each finding row carries a prefilled override command and a copy button:

```bash
node scripts/campaign.mjs override --finding FINDING_UUID --verdict dismissed --note "why"
```

`--verdict` is one of `accepted`, `dismissed`, `severity_adjusted`. Overrides are
**append-only** and name the agent verdict they override — the pair IS the
calibration datum, and the per-arm override rate is the campaign's published
measure of whether its AI verdicts can be trusted.

**The calibration sample is chosen by the tool, not by you** — otherwise the gate
measures which rows you felt like opening. It covers accepted *and* dismissed
rulings: sampling only accepted rows would never catch a false dismissal, which
is exactly how a high dismissal rate hides a real finding.

---

## 5. Decide

```bash
node scripts/campaign.mjs verdict --campaign final-review-2026q3
```

Two stages, in this order, and the order is the point:

1. **Effectiveness floor.** An arm must be non-inferior to the incumbent
   (`>= incumbent - floorMargin`) **and** score strictly above zero. Both halves
   are load-bearing: without the second, whenever the incumbent scores at the
   margin an arm that found *nothing at all* clears the floor — and it is by
   construction the cheapest thing in the campaign, so it wins.
2. **Cost per accepted**, over the arms that cleared. An arm with 0 accepted has
   cost-per-accepted `null`, never `Infinity` — a computable-looking number
   invites comparison.

The rule exists because the naive one is measurably perverse: on this repo's own
data, cost-only selects the arm that found **one-sixth** of the real defects.

**Refusals that are answers, not errors:**

| Outcome | Meaning |
|---|---|
| `INCONCLUSIVE (incumbent-floor-degenerate)` | the incumbent itself scored below the margin — the cohort did not discriminate, it failed to pose the question |
| `cost stage not evaluated` | some arm-run is unpriced, so `cost_evidence: unknown`. Collection never halts on a pricing gap, but a comparison whose money column is partly imaginary is not a comparison |
| `attribution unavailable` | a complete snapshot has no cluster set — run `campaign.mjs cluster` |

Terminal, when the eligible pool runs dry:

```bash
node scripts/campaign.mjs declare-inconclusive --campaign final-review-2026q3 --reason "eligible pool exhausted at N=9"
```

---

## Pre-registration integrity

`targetN`, `calibration` and the whole `decisionRule` are **analysis-time** —
deliberately outside every digest. Hashing them would mean editing a cost ceiling
destroyed every snapshot ever collected.

They are protected differently: every change appends a `rule_changed` event with
before/after and the operator, and any standings whose rule changed after the
first arm-run was collected carry an advisory saying so. The evidence survives;
the fact that the goalposts moved is recorded next to the number.

Changing a **live** campaign's rule mid-flight is the relabelling this machinery
exists to stop. Let the running campaign finish under its original rule.

---

## Reading the numbers honestly

- **`unknown` is a word on this page**, never `$0.00` and never a blank. A zero
  would be a claim the call was measured and cost nothing.
- **Spend sums every attempt, superseded ones included.** A superseded attempt
  was still paid for; counting only the last one flatters the flakier model.
- **Incomplete-snapshot spend is its own line, on purpose.** "Per-arm spend"
  above answers a different question (money spent across every snapshot,
  complete or not) from "incomplete-snapshot spend" (money that bought
  nothing toward `N`) — the two are deliberately never summed together. A
  real measured collection had **$4.16 of $7.10 spent on incomplete
  snapshots**, invisible in every other number on this page because nothing
  asked the question. `none — no incomplete snapshots` and `unknown (every
  arm unpriced)` are different facts from a real dollar figure — read the
  words, not just the number.
- **Adjudication cost is campaign overhead**, on its own line — never folded into
  an arm's cost-per-accepted, which would penalise the arm that found more.
- **Raw counts sit beside accepted counts.** Raw-count seduction is the measured
  failure here; the cure is adjacency, not hiding.
- **Replicates are collected and reported, never counted** toward model-level
  evidence.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `no .campaigns/ directory` | not adopted | Not an error. Create a config to start. |
| `N campaigns found; pass --campaign` | more than one declared | Name it. The runner never picks for you on a spend-bearing path. |
| `CAMPAIGN_HMAC_KEY_… is not set` | no worksheet key | Generate once, add to `.env`. Never regenerate. |
| Dashboard says "store unavailable — standings withheld" | `AUDIT_DB_URL` unset | Standings are withheld on purpose: an unmeasured zero and a real zero are the same pixels. |
| `not promoted <snapshot>: no lockDigest` | collected before the lock existed | Correct. Evidence from an unknown contract cannot be adopted without relabelling it. |
| `arms recorded 2 different commits` | one snapshot, two revisions | One snapshot is one transcript at one revision — that revision is what adjudication verifies against. |
| Verdict is INCONCLUSIVE with N met | read the reason | A degenerate incumbent and an unknown cost column are different problems with different fixes. |
