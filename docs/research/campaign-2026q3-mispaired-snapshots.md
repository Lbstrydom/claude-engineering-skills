# final-review-scoped-2026q3 — mis-paired snapshot quarantine

**Status**: Quarantine record. Findings from the snapshots listed below MUST NOT
count as evidence for this campaign's verdict.
**Cohort lock**: `e52eec728688fcab`
**Recorded**: 2026-08-19

## What happened

Every arm in a bake-off snapshot reviews `--transcript` (an audit deliberation)
against `--plan` (the design document it supposedly audited). For CODE-mode
transcripts I selected the plan by inspecting the transcript's own
`changed_files`. For PLAN-mode transcripts I did not: plan-mode transcripts carry
no `plan_file` field, and instead of deriving the plan from the findings' cited
sections — a one-command check, demonstrated below — I chose a plausible-looking
plan. That is a guess presented as a decision, and it was mine, not a tool
failure.

The consequence: reviewers were asked to judge a deliberation against an
unrelated design document. Their findings are noise, not signal, and they
entered clustering and per-arm statistics as if they were real.

**Nothing in the pipeline could detect it** — which is the separate, structural
half of this and belongs to the identity-binding plan, not to this record:
transcripts carry no plan identity, snapshot ids hash only the transcript, and
`bakeoff-collect.mjs` validates only that both paths exist, never that they
relate.

## Method

The subject of a plan-mode transcript is recoverable from the `.mjs` filenames
its findings cite:

```bash
node -e "const j=require('./.audit/<transcript>.json');
  console.log([...new Set((j.rounds||[]).flatMap(r=>(r.findings||[]).map(f=>String(f.section||''))).join(' ').match(/[a-z0-9-]+\.mjs/g)||[])])"
```

## Verdict per snapshot

| snapshot | transcript | cited files | paired with | verdict |
|---|---|---|---|---|
| `2bb342bdd692` | `1786682916-v2` | `accepted-debt-check`, `accepted-debt-registry`, `check-accepted-debt` | final-review-scoped-second-reviewer | **QUARANTINE** — subject is accepted-debt |
| `307a360d0d52` | `1786682916-v3` | `accepted-debt-check`, `accepted-debt-registry`, `check-accepted-debt` | final-review-scoped-second-reviewer | **QUARANTINE** — subject is accepted-debt |
| `bf6f7fa76385` | `1786682531` | `contract`, `render-mermaid`, `refresh-subprocess` | final-review-scoped-second-reviewer | **QUARANTINE** — subject is unrelated |
| `f856348bee59` | `1786693285` | `gemini-review`, `model-pricing`, `bakeoff-collect` | final-review-scoped-second-reviewer | KEEP — subject matches |
| `0cbedea17330` | `1786884107-v2` | `campaign`, `plan-file-coverage-check` | comparison-tooling-consolidation | KEEP — subject matches |
| `3424675910f8` | `1786884107` | `campaign`, `plan-file-coverage-check` | comparison-tooling-consolidation | KEEP — subject matches |
| `9c21abac9363` | `audit-code-1786690255-v2` | (code-mode; plan chosen from `changed_files`) | accepted-debt-table-verification | KEEP — derived, not guessed |
| `669282a85cf1` | `audit-code-1786690255` | (code-mode; plan chosen from `changed_files`) | accepted-debt-table-verification | KEEP — derived, not guessed |
| `3a4ba613a7c0` | `1755500000-v4` | (event-wiring plan audit) | event-wiring-symmetry | KEEP — subject matches |

Not in the cohort but same defect class, worth noting so it is not re-collected
as-is: `audit-plan-1786884107-transcript-v3.json` was paired with
`role-agnostic-comparison-core.md` while citing the same
`campaign`/`plan-file-coverage-check` files as its v1/v2 siblings, which were
paired with `comparison-tooling-consolidation.md`. At most one of those pairings
can be right.

## Effect on the campaign

- **3 of 9 collected snapshots are quarantined.** Usable evidence is 5 complete
  snapshots plus one incomplete, against a `targetN` of 12.
- Any per-arm finding count reported before 2026-08-19 includes quarantined
  findings and is **not** a basis for comparison. This includes the raw
  cluster-contribution figures (opus 16 / qwen 14 / gemini-control 7 / kimi 7 /
  deepseek 6 / grok 3) reported that day.
- The store has **no quarantine mechanism**: these snapshots are still present,
  still promoted, and still counted by `campaign.mjs status`. This file is the
  only record. Adding a real exclusion is part of the identity-binding plan;
  until it exists, `N complete` OVERSTATES usable evidence by 3.

## Re-collection

Each quarantined snapshot should be re-collected with the correct plan. The
transcripts are intact in `.audit/transcripts` (the durability fix archives
them), so no audit needs re-running — only the bake-off collection, at roughly
$4/snapshot. Correct pairings:

| transcript | correct plan |
|---|---|
| `audit-plan-1786682916-transcript-v2.json` | `docs/plans/accepted-debt-table-verification.md` |
| `audit-plan-1786682916-transcript-v3.json` | `docs/plans/accepted-debt-table-verification.md` |
| `audit-plan-1786682531-transcript.json` | identify from cited files before collecting — do NOT guess again |

Re-collection produces the same content-derived `snapshotId` (the id hashes the
transcript, not the plan), so a re-run supersedes rather than adding a snapshot.
That is itself a symptom worth fixing: **the plan is not part of snapshot
identity, so two snapshots reviewing different plans against one transcript are
indistinguishable.**
