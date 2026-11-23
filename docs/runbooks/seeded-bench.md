# Runbook — seeded-defect benchmark, Pilot 1 (meta step-back A/B)

Plan: [`docs/plans/seeded-defect-benchmark.md`](../plans/seeded-defect-benchmark.md) §2, §6. This runbook covers **Pilot 1 only**;
Pilot 2 (seeded detection) has no pieces built yet.

**Spend** (Louis, 2026-11-23, "Approve all"): **$125 hard total** — $10 matcher calibration, $15 dress rehearsal, $100 pilot. Every paid run
takes a hard `--max-usd` enforced **per provider call from metered usage** at the four seams (`scripts/lib/llm-budget.mjs`), never from a
preflight estimate (a replay preflight once estimated 8× low). A run that reaches its cap stops (exit 5). Any spend beyond $125, a repeat run
or Pilot 2 needs a new approval. **Source repos**: CES, wine-cellar-app, ai-organiser. Never a work repo (the freezer excludes any repo not
in `AUTHORISED_REPOS`).

## 0. Rules that are easy to get wrong

- **Pin the revision.** A paid `continue` refuses to start outside a `npm run fixture:create` worktree (`assertPinnedFixture`). Never run it from a shared tree.
- **Trust the ledger, not a local log.** The spend figure is `<results>.budget.jsonl` (`readLedgerSummary`); the results JSONL carries the same per-run delta.
- **Indeterminate calls block resume.** A killed run leaves a `reserved` record whose full reservation stays counted; `reconcile` it with provider-dashboard evidence before continuing.
- **The cli backend is refused while a budget is active** (it cannot enforce `max_tokens`); judges and the meta reviewer run on the sdk pin.
- **A rerun is a repeat run**, a new approval. Never re-run a failed paid step to "fix" it without asking the coordinator.

## 1. Freeze and partition (free)

```powershell
node scripts/step-back-replay.mjs export --branches "<csv>" --since 2026-07-01 --repo-id <audit_repos.id> --out C:/tmp/pilot1/export-<repo>.json
node scripts/step-back-replay.mjs freeze --pilot meta-ab --export C:/tmp/pilot1/export-a.json,C:/tmp/pilot1/export-b.json --repos-file C:/tmp/pilot1/repos.json --seed seeded-bench-v1-pilot1 --out C:/tmp/pilot1/dataset.json
```

`repos.json` maps `audit_repos.id` → `{name, localPath}` (local clone used to restore the tree). The freeze writes `dataset.json` and
`dataset.snapshots.json`; the dataset hash is an identity (two freezes of one export and seed are byte-identical). Sessions are partitioned
**by session** into `calibration`, `rehearsal` (5 points), `pilot` (16, ≥ 6 code) and `repeat` (the rest); the loader refuses a run whose set does not match its purpose.

**Decision point** = a session at the moment the meta-review fires: plan T1 (round 4), code T1 (round 7), code T2 (round 4, signal fires). The
checkpoint state is the store reconstruction (`buildExportSnapshot`), sealed with a digest. The tree each run audits is the audited sha of the
**next recorded run** (what production would audit). Branches `main`/`master`/`HEAD` are excluded (their runs are many unrelated sessions).

## 2. Validate without spend

```powershell
node scripts/step-back-replay.mjs continue --dataset C:/tmp/pilot1/dataset.json --set pilot --dry-run
```

Restores every point in a throwaway case tree and checks the gate's computed trigger, the T2 round signal, the plan file and the diff scope.
A `BAD` row is unrecoverable: re-freeze (new seed = new partition = a deviation to record) before any spend.

## 3. Matcher calibration gate ($10) — before any pilot aggregate

```powershell
node scripts/step-back-replay.mjs calibrate-draw --dataset C:/tmp/pilot1/dataset.json --seed seeded-bench-v1-cal --out-dir C:/tmp/pilot1/cal
# Louis labels C:/tmp/pilot1/cal/calibration-worksheet.md blind (Label: same|partial|different ; Restates: <ids>|none), then:
node scripts/step-back-replay.mjs calibrate-score --out-dir C:/tmp/pilot1/cal --labels C:/tmp/pilot1/cal/calibration-worksheet.md --max-usd 10 --confirm-spend
```

Draws from **calibration-set sessions only**: findings of round *r* against ledger entries first seen before *r* (the "source arm" stratum is the
audit mode, since the two pilot arms exist only after the pilot runs). Both judges (`latest-opus`, `latest-pro`) are scored against the human labels;
the Jaccard-0.15 scorer is the negative control. **Accept**: precision ≥ 0.90, recall ≥ 0.85, filter recall ≥ 0.95, per-arm gap ≤ 0.05, ≥ 15 `same`
pairs per arm, for **both** judges. Below the bar the pilots stop (no fallback to the file/line filter). `inconclusive` = grow the labels.

## 4. Dress rehearsal ($15) and pilot ($100)

```powershell
node scripts/run-heartbeat.mjs run --run-id seeded-bench-pilot1 --stale-after 900 -- node scripts/step-back-replay.mjs continue --dataset C:/tmp/pilot1/dataset.json --set rehearsal --replicates 1 --max-usd 15 --confirm-spend --results C:/tmp/pilot1/rehearsal.jsonl
node scripts/run-heartbeat.mjs run --run-id seeded-bench-pilot1 --stale-after 900 -- node scripts/step-back-replay.mjs continue --dataset C:/tmp/pilot1/dataset.json --set pilot --replicates 2 --max-usd 100 --confirm-spend --results C:/tmp/pilot1/pilot.jsonl
```

Each point runs META (the production gate, meta-review on) then CONTINUE (`--no-meta-review`; at T1 the refused card step then `--past-cap
"seeded-bench continuation control"`), per replicate. Arms share every other argument and the child env (`AUDIT_CANARY=1`, store writes off).
A META stop records its debt command and never runs it. The rehearsal asserts every evidence field is non-null (the C5 fill-check) and is
**discarded** from the pilot.

## 5. Novelty, blind labelling, decision

```powershell
node scripts/step-back-replay.mjs novelty --dataset C:/tmp/pilot1/dataset.json --results C:/tmp/pilot1/pilot.jsonl
node scripts/step-back-replay.mjs worksheet --dataset C:/tmp/pilot1/dataset.json --results C:/tmp/pilot1/pilot.jsonl --seed seeded-bench-v1-pilot1 --out-dir C:/tmp/pilot1/out
# Louis labels pilot1-worksheet.md (REAL | RIGOUR_CHASING | NOT_A_DEFECT | WRONG | UNDETERMINED), then:
node scripts/step-back-replay.mjs score --pilot meta-ab --dataset C:/tmp/pilot1/dataset.json --results C:/tmp/pilot1/pilot.jsonl --out-dir C:/tmp/pilot1/out --labels C:/tmp/pilot1/out/pilot1-worksheet.md
```

The sheet pools findings of both arms, shuffled and source-blinded; every novel MEDIUM+ finding (novel under **either** judge) is labelled by a
human — nothing the rule reads rests on a judge label. The key file stays with the operator, never the labeller. An unlabelled or
`UNDETERMINED` finding makes the score INCOMPLETE.

## 6. Decision rule (pre-registered; `decideMetaPilot`)

First match wins: **1 invalid** (valid pairs < 24 of 32, or completion < 75% / arm gap > 10 points) · **2 turn off** (cost saved < 0, or |S| ≥ 5 and
miss rate > 40%) · **3 inconclusive** (|S| < 5) · **4 keep** (miss ≤ 20%, cost saved ≥ 25%, admission yield ≥ 0.8 or undefined) · **5 inconclusive**.
Both judges must land on the same branch, else inconclusive. A result is **advisory** until a repeat run on a fresh draw lands on the same
branch (§0.3); a repeat is a new spend approval.

## 7. Reconciling an indeterminate call

```powershell
node scripts/step-back-replay.mjs reconcile --ledger C:/tmp/pilot1/pilot.jsonl.budget.jsonl --call-id <id from the ledger summary> --evidence "provider dashboard: no usage recorded for this request" --cost-usd 0
```

Never put a backtick in `--evidence` (the shell runs it).

## Known limits (stated, not hidden)

- The store era predates the meta-review, so no point has pre-checkpoint meta events to restore; the ledger is reconstructed from store events (the audit's own semantic hash is not stored — the fingerprint stands in, identically for both arms).
- A T2 point whose checkpoint-3 signal is quiet is not a decision point (unrecoverable at validation).
- One continuation round per point; a META fall-through to the production refusal counts as META not running the round, exactly as production behaves.
- One human adjudicator (the plan's C4 limit); judge-vs-human agreement is reported, not used.
