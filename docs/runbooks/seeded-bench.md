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

## 3. Matcher calibration — evidence only (amendment 2)

The §1.4 calibration ran once (2026-11-23, $2.2286 of $10, pinned to main `f74cc844`) and came back **INCONCLUSIVE**: the 80-pair prevalence sample held 8
judge-positive pairs (6 correct), all pairs were code audits, and Gemini returned malformed JSON on 4 pairs. That verdict is final for epoch v1 and is never
rewritten. [Amendment 2](../experiments/seeded-bench/amendment-2-novelty-audit.md) (epoch `seeded-bench-v2`, approved by Louis in chat 2026-11-23) replaces the
pre-pilot certification with a **pilot-time audit** (§5). Novelty and scoring now refuse to run without the signed amendment
(`--amendment docs/experiments/seeded-bench/amendment-2-novelty-audit.json`) and the calibration report of the same dataset (`--calibration`, whose judge stamps pin
the judges). `calibrate-draw` and `calibrate-score` stay available for evidence and judge-vs-human agreement; do not re-run them without a new approval.

## 4. Dress rehearsal ($15) and pilot ($100)

```powershell
node scripts/run-heartbeat.mjs run --run-id seeded-bench-pilot1 --stale-after 900 -- node scripts/step-back-replay.mjs continue --dataset C:/tmp/pilot1/dataset.json --set rehearsal --replicates 1 --max-usd 15 --confirm-spend --results C:/tmp/pilot1/rehearsal.jsonl
node scripts/run-heartbeat.mjs run --run-id seeded-bench-pilot1 --stale-after 900 -- node scripts/step-back-replay.mjs continue --dataset C:/tmp/pilot1/dataset.json --set pilot --replicates 2 --max-usd 100 --confirm-spend --results C:/tmp/pilot1/pilot.jsonl
```

Each point runs META (the production gate, meta-review on) then CONTINUE (`--no-meta-review`; at T1 the refused card step then `--past-cap
"seeded-bench continuation control"`), per replicate. Arms share every other argument and the child env (`AUDIT_CANARY=1`, store writes off).
A META stop records its debt command and never runs it. The rehearsal asserts every evidence field is non-null (the C5 fill-check) and is
**discarded** from the pilot.

## 5. Novelty, blind labelling, audit, decision

```powershell
node scripts/step-back-replay.mjs novelty --dataset C:/tmp/pilot1/dataset.json --results C:/tmp/pilot1/pilot.jsonl --calibration C:/tmp/pilot1/cal/calibration-report.json --amendment docs/experiments/seeded-bench/amendment-2-novelty-audit.json --confirm-spend
node scripts/step-back-replay.mjs worksheet --dataset C:/tmp/pilot1/dataset.json --results C:/tmp/pilot1/pilot.jsonl --amendment docs/experiments/seeded-bench/amendment-2-novelty-audit.json --seed seeded-bench-v2-pilot1 --out-dir C:/tmp/pilot1/out
# Louis labels pilot1-worksheet.md (REAL | RIGOUR_CHASING | NOT_A_DEFECT | WRONG | KNOWN | UNDETERMINED), then:
node scripts/step-back-replay.mjs score --pilot meta-ab --dataset C:/tmp/pilot1/dataset.json --results C:/tmp/pilot1/pilot.jsonl --out-dir C:/tmp/pilot1/out --labels C:/tmp/pilot1/out/pilot1-worksheet.md --amendment docs/experiments/seeded-bench/amendment-2-novelty-audit.json
```

A finding is **hidden from the human only when BOTH judges (Opus and Gemini) call it `same`** as a prior ledger entry; a judge that fails, is unparseable or
disagrees sends the finding to the human. The sheet pools every surfaced finding of both arms plus a seeded sample of **80** hidden ones, stratified by arm (all of an arm's if fewer),
shuffled and source-blinded; each shows up to ten earlier ledger entries from the same file, and always every entry the judges matched, and the human decides novelty (`KNOWN` = it restates one). Nothing the rule reads
rests on a judge label. The key file stays with the operator.

**The audit.** Each audited hidden finding the human does not call `KNOWN` is a false suppression. It passes iff the one-sided 95% Clopper–Pearson upper bound of
false suppressions ÷ audited is ≤ 0.15 for each arm and pooled (**at most 2 of 40 per arm, 6 of 80 pooled**). If it fails, `score` prints `audit-failed` (exit 1) and reports no decision: rebuild the worksheet with
`worksheet --audit all` into a NEW `--out-dir` (the worksheet command never overwrites a sheet a human may have labelled, and refuses a sampled rebuild after a failed audit) and label every hidden finding. An unlabelled or `UNDETERMINED` shown finding makes the score INCOMPLETE (exit 1).

## 6. Decision rule (pre-registered; `decideMetaPilot`)

First match wins: **1 invalid** (valid pairs < 24 of 32, or completion < 75% / arm gap > 10 points) · **2 turn off** (cost saved < 0, or |S| ≥ 5 and
miss rate > 40%) · **3 inconclusive** (|S| < 5) · **4 keep** (miss ≤ 20%, cost saved ≥ 25%, admission yield ≥ 0.8 or undefined) · **5 inconclusive**.
The decision is computed once, on human-labelled counts. A result is **advisory** until a repeat run on a fresh draw lands on the same
branch (§0.3); a repeat is a new spend approval.

## 7. Reconciling an indeterminate call

```powershell
node scripts/step-back-replay.mjs reconcile --ledger C:/tmp/pilot1/pilot.jsonl.budget.jsonl --call-id <id from the ledger summary> --evidence "provider dashboard: no usage recorded for this request" --cost-usd 0
```

Never put a backtick in `--evidence` (the shell runs it).

## Known limits (stated, not hidden)

- The store era predates the meta-review, so no point has pre-checkpoint meta events to restore; the ledger is reconstructed from store events (the audit's own semantic hash is not stored — the fingerprint stands in, identically for both arms).
- The v1 calibration gate was inconclusive (amendment 2 records why); the judges are an audited filter, not a certified one.
- A T2 point whose checkpoint-3 signal is quiet is not a decision point (unrecoverable at validation).
- One continuation round per point; a META fall-through to the production refusal counts as META not running the round, exactly as production behaves.
- One human adjudicator (the plan's C4 limit); judge-vs-human agreement is reported, not used.
