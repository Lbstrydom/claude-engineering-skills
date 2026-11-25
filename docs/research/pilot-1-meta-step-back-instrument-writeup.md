# Pilot 1 (meta step-back A/B): instrument write-up and re-run gate

- **Date**: 2026-11-25
- **Verdict**: **branch 1, Invalid** (plan `docs/plans/seeded-defect-benchmark.md` §2.3). 22 of 32 pairs valid, floor 24.
  No miss rate, yield or judge result was computed, and nothing was labelled.
- **Scope**: the T1 (code round cap) decision only. T2 is excluded by deviation 1.
- **Revision**: `a56bf445` (pinned fixture). Dataset hash `da95b239…`.

Figure labels: `measured` = read from the run files or the store; `derived` = arithmetic on measured figures;
`expected` = a forecast.

## 1. What ran (`measured`)

| Run | Cost | Result |
|---|---|---|
| 64 runs (16 points × 2 arms × 2 replicates) | $28.87 | 20 valid pairs; 12 invalid, all CONTINUE `canary-missed` |
| Rerun of the 12 invalid CONTINUE runs (deviation: pilot-only driver, no code change) | $4.65 | 2 recovered → 22 valid pairs |
| Canary probe, one point, backend sub-passes | $0.65 | see §4 |

The rerun was approved in chat before it ran. It had no committed deviation record, which is one more reason its two
recovered pairs are diagnostics only (§6).

## 2. Economics (step 1)

### 2.1 Spend by decision path (`measured`, first run, 32 META runs)

| Decision path | Runs | Reviewer billed | Meta cost | Round ran |
|---|---|---|---|---|
| Reviewer `stop`, honoured | 12 | yes | $7.51 | 0 |
| Reviewer `stop`, downgraded by the guard (`high-not-settled`) | 6 | yes | $5.06 | 0 |
| Reviewer `stop`, downgraded by the guard (`unverified-settled`) | 4 | yes | $4.05 | 0 |
| No open topic: reviewer not called | 10 | no | $0 | 0 |
| **Total** | 32 | 22 | **$16.62** | **0** |

- Mean per rendered decision $0.755; mean per META run $0.519 (`derived`).
- Mean valid CONTINUE round $0.372 (22 runs).
- Over the 22 valid pairs: META $9.97, CONTINUE $8.19, cost saved **−21.8%**. A diagnostic, not a verdict.

### 2.2 What a stop avoids in production

The pre-registered frame charges a stop with one avoided round. Measured from the store (`audit_runs`, code mode,
experiment rows excluded), the rounds a session ran from round 7 onward:

| Era | Sessions | Reached round 6 | Reached round 7 | Mean rounds ≥7 | Mean / median GPT cost of rounds ≥7 |
|---|---|---|---|---|---|
| Cap enforced (from 2026-10-26; gate added `43c8f30f`) | 692 | 69 | 10 | 1.40 | $0.69 / $0.33 |
| Before the cap | 1351 | 339 | 223 | 3.16 | $1.88 / $0.29 |

Limits: sessions are reconstructed (same repo, branch and plan file; a new session when the round number stops rising
or after 48 h), because session ids exist only from 2026-11-23. A session's era is that of its last round. A missing cost
would count as zero; no round from 7 onward lacked one on this read. The cost is the store's estimate for GPT passes. Agent
tokens spent fixing findings are **not measured**. The final gate runs after a stop too, so a stop does not avoid it.
Query: appendix.

### 2.3 Break-even (`derived`)

Keep needs cost saved ≥ 25%, so the avoided cost per decision must be at least $0.519 / 0.75 = **$0.69**.

| What a stop is credited with | Avoided | Cost saved, if every decision stops | Keep reachable on cost? |
|---|---|---|---|
| One round (pre-registered) | $0.37 | −40% | **No** |
| Whole tail, a human always overriding the cap (cap-enforced mean, n=10) | $0.69 | +25% | At the boundary only |
| Whole tail, median session | $0.33 | −56% | **No** |
| Whole tail × observed share of round-6 sessions that ran round 7 (10/69) | $0.10 | about −400% | **No** |

The last row treats 10/69 as the override rate. It is an upper bound on overrides: a session can also converge at 6.

### 2.4 The counterfactual

With the meta-review off, production **refuses** at the cap (exit 4 and the structural card), and a human decides.
The CONTINUE arm models a human who always overrides. The reviewer rendered 22 decisions and all 22 were `stop`, so it
admitted no round that production without it would not already have refused. The two workflows still differ: an honoured
stop (12 runs) settles the decision without asking a human, where meta-off leaves a card that a human may override. The
step-back's possible value at T1 is therefore saved human attention and avoided overrides. This pilot measures neither,
and the 10/69 share is observational: it is not an override rate measured with the meta-review off.

**Conclusion.** The one-round frame alone made Keep unreachable, which is a pre-registration flaw. Correcting it does
not rescue Keep except under "a human always overrides", at the boundary, on 10 sessions. On the economics, the honest
answer for the T1 step-back is branch 2, **Turn off** (`AUDIT_META_REVIEW=off` default). That is a gate change and
Louis's decision. This is not the pilot's pre-registered verdict, which remains Invalid. It says nothing about T2.

## 3. Default refusals (step 2, `measured`, no spend)

The earlier summary "20 default refusals, 12 reviewer stops" invited the reading that the meta call failed 20 times.
It did not fail once:

- 10 runs (5 points, both replicates): no open topic in the last round, so no reviewer call was made. This is the
  intended behaviour added by #512.
- 10 runs: a valid `stop` verdict that the guard downgraded to the human card.
- No parse, timeout, budget or model failure occurred. There is no fallback to fix, and the primary analysis counting
  these as production does is correct.

## 4. The instrument (canary)

First run, CONTINUE arm, detections per planted pass (`measured`):

| Pass | Detected / planted |
|---|---|
| frontend (UI canary) | 8 / 8 |
| be-services | 25 / 30 |
| be-routes | 3 / 8 |
| backend | 0 / 2 |

Probe on one point (3 repeats per condition): without the R2+ framing be-routes 1/3 and be-services 0/3; with it 0/3
and 3/3. Misses occur with no framing, so the framing is not needed to cause them. Three repeats on one point cannot
show it has no effect. The working explanation is lens sensitivity: one `src/access` role assignment is outside what
the be-routes and be-services lenses reliably report.

**Bias in the 22.** Exclusion is not random: it removes the points that run the weak lenses.

## 5. Re-run plan (conditional; not recommended)

This is an outline, not a pre-registration: nothing here may be run from it. Run it only if Louis wants a measured miss rate despite §2, for instance to judge the step-back on quality rather
than cost. It would then need a new pre-registration, because the cost condition of the decision table cannot pass.

A miss, a novel finding, an actionable label and the judge keep the definitions of plan §2.2 and §1.4. The signed
pre-registration must fix the thresholds, the interval method (exact one-sided binomial is proposed) and what happens
when too few stop points remain (Inconclusive).

1. **Decision rule first.** Replace "cost saved" with a stated avoided-cost frame and counterfactual (meta off =
   refusal), or drop cost from Keep. Signed before any run.
2. **Instrument.** One fixed canary per lens, within that lens's remit, in a file the pass receives; be-routes is
   exercised through backend. No seed bank. Calibrate on the 30 calibration-set points, never on re-run points. Gate on
   the whole run (≥ 85% of at least 20 calibration runs detect every planted canary); a lens that fails is excluded in
   advance and named, points whose round needs that lens are not eligible, the whole-run gate is recomputed on the rest,
   and the claim covers only them. One canary shows that the lens saw that defect, not its general sensitivity. Freeze before the confirmatory run.
3. **Validity.** Fixed batch with a hard cap. No "run until N valid". A run lost to a provider or infrastructure failure is rerun once, same point,
   replicate and arm, so the pair is preserved; a canary miss never is. Attrition ceiling 25%. Report the miss rate with all excluded
   pairs counted as missed and as not missed.
4. **Sample size.** Distinct stop points, not runs. With zero misses, 5 points bound the miss rate only below 45%;
   14 are needed for below 20% (one-sided 95%). Draw 24 points from the repeat set, 1 replicate, plus a second CONTINUE
   replicate on 8 of them for A/A variance. Points are
   chosen by a seeded shuffle and frozen with the dataset hash before any run. A wider interval than 20% is a predeclared, informative Inconclusive.
5. **Fallbacks.** Counted as production counts them. Reviewer-rendered decisions are reported separately. A change to
   the meta call is a new pinned treatment revision.

**Cost (`expected`)**: canary calibration ≈ $5; 24 META runs × $0.52 ≈ $12; 32 CONTINUE runs × $0.40 ≈ $13; judge
≈ $5. About **$35**, hard cap **$50**. Human labelling of novel findings is additional and unpriced. Every call goes through one budget ledger
(plan §2.6) holding that cap, calibration, reruns and judge included. Each paid step needs its own signed approval.

## 6. Salvage

The 22 pairs, the rerun rows and the probe are diagnostics (ledger, decision paths, A/A spread, adjudication
practice). They are never pooled into a later confirmatory result.

## Appendix: tail query

```sql
with r as (
  select repo_id, coalesce(branch,'') b, plan_file, rounds, coalesce(total_cost_estimate,0) c, created_at,
    case when lag(rounds) over w is null or rounds <= lag(rounds) over w
              or created_at - lag(created_at) over w > interval '48 hours' then 1 else 0 end st
  from audit_runs where mode='code' and experiment_tag is null and rounds>=1
  window w as (partition by repo_id, coalesce(branch,''), plan_file order by created_at)),
s as (select *, sum(st) over (partition by repo_id,b,plan_file order by created_at) k from r),
g as (select repo_id,b,plan_file,k, max(rounds) mx, count(*) filter (where rounds>=7) n7,
        sum(c) filter (where rounds>=7) c7, max(created_at) last from s group by 1,2,3,4)
select last >= '2026-10-26' as cap_enforced, count(*) sessions,
  count(*) filter (where mx>=6) reached6, count(*) filter (where mx>=7) reached7,
  avg(n7) filter (where mx>=7) mean_tail_rounds, avg(c7) filter (where mx>=7) mean_tail_usd,
  percentile_cont(0.5) within group (order by c7) filter (where mx>=7) p50_tail_usd
from g group by 1;
```

Read 2026-11-25 against one store; the figures move as new runs arrive. Run files (local, not committed):
`pilot.jsonl`, `rerun.jsonl` and their `.budget.jsonl` ledgers.
