# Plan: Predictive Audit Strategy (Phase 7)
- **Date**: 2026-04-01
- **Status**: Waiting (requires 50+ audit runs)
- **Author**: Claude + Louis
- **Parent**: audit-loop-adaptive-intelligence (Phases 1-6 complete)
- **Trigger**: When `.audit/outcomes.jsonl` reaches 50+ entries OR `scripts/phase7-check.mjs` fires

---

## Context

The audit-loop system (Phases 1-6) collects outcome data from every audit run: which passes produced findings, which findings were accepted vs dismissed, acceptance rates per category, and per-repo profiles. Phase 7 uses this accumulated data to make audit runs faster and cheaper by predicting what matters before running.

**Current data collection points:**
- Local: `.audit/outcomes.jsonl` — per-finding outcomes from deliberation
- Cloud: `audit_pass_stats` table (Supabase) — pass-level effectiveness per run
- Cloud: `audit_findings` table — individual findings with topicId
- Cloud: `false_positive_patterns` — recurring dismissals

---

## Scope

### 1. Predictive Pass Selection
Given a repo profile (stack, file breakdown, focus areas), predict which passes will produce accepted findings.

**Approach**: Start with heuristic scoring (no ML dependency):
```
passScore(pass, repoProfile) =
  historicalAcceptanceRate(pass, similarRepos) *
  fileRelevanceWeight(pass, changedFiles) *
  recencyDecay(lastUsefulRound)
```

Skip passes where `passScore < 0.1` (historically < 10% acceptance rate for similar repos).

**After 100+ runs**: Train lightweight logistic regression on `(repoFeatures, passName) -> accepted_finding_probability`.

### 2. Reasoning Effort Tuning
Different passes benefit differently from reasoning effort:
- `sustainability` → `high` (cross-cutting analysis benefits from deep reasoning)
- `structure` → `low` (file existence checks are mechanical)
- `backend` → varies by repo complexity

**Approach**: Track `(pass, reasoningEffort, acceptanceRate)` triples. Use Thompson Sampling (Phase 6 bandit) to select effort level per pass.

### 3. Cost Prediction
Before running, estimate: "This audit will cost ~$X and take ~Y minutes."

**Approach**: Linear model from historical data:
```
estimatedCost = sum(passTokenCost[pass] * passRunProbability[pass])
estimatedTime = max(passTime[pass]) + reduceTime
```

Display prediction in kickoff card. User can adjust by removing passes.

### 4. Scheduled Retraining
Every 10 new runs, re-compute:
- Pass effectiveness scores per repo fingerprint
- False positive category EMA thresholds
- Reasoning effort optimal levels

---

## Implementation

### New file: `scripts/predictive-strategy.mjs`

| Function | Purpose |
|----------|---------|
| `predictPassValue(repoProfile, passName)` | Returns 0-1 score |
| `recommendPasses(repoProfile, allPasses)` | Returns sorted passes with scores |
| `predictCost(repoProfile, selectedPasses)` | Returns `{ estimatedTokens, estimatedCostUsd, estimatedMinutes }` |
| `recommendReasoningEffort(passName, repoProfile)` | Returns `'low'` / `'medium'` / `'high'` |
| `retrainModels()` | Recomputes all scoring models from outcomes data |

### Integration points

1. **`openai-audit.mjs`** — Before pass execution, call `recommendPasses()` to filter
2. **SKILL.md** — Display cost prediction in kickoff card
3. **`phase7-check.mjs`** — Already monitors run count, triggers notification

### CLI usage

```bash
# Predict which passes are valuable for this repo
node scripts/predictive-strategy.mjs predict

# Show cost estimate for a full audit
node scripts/predictive-strategy.mjs cost docs/plans/my-plan.md

# Retrain models from accumulated data
node scripts/predictive-strategy.mjs retrain
```

---

## Acceptance Criteria

1. Audit runs with prediction skip >=1 low-value pass (saving tokens)
2. No accepted findings are missed by skipped passes (validated by running full audit periodically)
3. Cost predictions within 30% of actual for 80% of runs
4. `retrainModels()` completes in <5 seconds

---

## Readiness Check

Run `node scripts/phase7-check.mjs` to see current run count. The check fires automatically every 10 runs after the 50th. When ready, this plan moves from "Waiting" to "Active".
