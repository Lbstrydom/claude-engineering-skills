# Plan: Predictive Audit Strategy — Data Loop Completion & Intelligence
- **Date**: 2026-04-17
- **Status**: Draft
- **Author**: Claude + Louis
- **Replaces**: Previous Phase 7 plan (2026-04-01) — rewritten after data analysis
- **Data audit**: 100 runs, 1,634 findings, 9,190 FP patterns, 444 pass stats — **0 outcome labels**

---

## 1. Context — Why the Previous Plan Was Wrong

The original Phase 7 plan assumed we had labeled outcome data (accepted/dismissed per
finding per pass) and just needed prediction algorithms. A data audit revealed that
**none of the outcome data actually flows to the learning store**:

| Data Point | Schema Exists | Written | Queryable | Status |
|---|---|---|---|---|
| findings raised per pass | ✓ | ✓ | ✓ | Working |
| findings accepted per pass | ✓ | ✗ (hardcoded 0) | ✗ | **BROKEN** |
| findings dismissed per pass | ✓ | ✗ (hardcoded 0) | ✗ | **BROKEN** |
| per-finding adjudication | ✓ (table exists) | ✗ (never called) | ✗ | **DEAD CODE** |
| bandit reward signal | ✓ | ✗ (findingEditLinks empty) | ✗ | **INCOMPLETE** |
| outcomes.jsonl accepted field | ✓ | ✗ (hardcoded `true`) | local only | **BROKEN** |
| Gemini findings accuracy | ✗ | ✗ | ✗ | **NOT TRACKED** |

**Root cause**: `openai-audit.mjs` records findings at raise time but never updates
them after deliberation. The orchestrator (`audit-loop.mjs` or the skill) performs
triage in-memory but never writes outcomes back to the learning store.

### What IS working

- **FP patterns** (9,190 entries) — local tracker has real accept/dismiss rates with EMA decay
- **Pass timing** (444 records) — real latency + token costs per pass per run
- **Bandit arms** (14 entries) — Thompson sampling for prompt variants, partial rewards from deliberation quality
- **Repo profiles** — stack detection, file counts, pass relevance filtering

---

## 2. Success Metrics — What "Truly Useful" Means

Before building prediction, define what we're optimizing for:

### Primary Metrics (measure every run)

| Metric | Definition | Target | Current |
|---|---|---|---|
| **Precision** | accepted / raised | >60% | Unknown (0/0) |
| **Cost per accepted finding** | total_tokens × price / accepted_count | <$0.05 | Unknown |
| **Time to converge** | minutes from R1 start to APPROVE | <15 min | ~12 min avg |
| **False positive rate** | dismissed / raised | <40% | Unknown |
| **Gemini value-add** | new_findings from Gemini not in GPT | >0 per run | Not tracked |

### Derived Metrics (compute weekly/monthly)

| Metric | Definition | Target |
|---|---|---|
| **Pass ROI** | (accepted findings × severity weight) / (pass token cost) | Rank passes by ROI |
| **Model agreement** | % findings where GPT raises, Claude accepts, Gemini confirms | >70% |
| **Learning velocity** | FP rate reduction per 10 runs | Measurable decline |
| **Debt velocity** | items resolved / items created per period | >0.5 ratio |
| **Bandit convergence** | EWR variance across prompt variants | Decreasing |

### Per-Model Performance (the 3-model lens)

| Model | Role | Track | Why |
|---|---|---|---|
| **GPT-5.4** | Auditor | Precision per pass, false positive categories, token efficiency | Is it finding real bugs or generating noise? |
| **Claude** | Triager | Dismiss rate, wrongly-dismissed rate (per Gemini), bias patterns | Is it protecting its own code? |
| **Gemini** | Arbiter | New findings count, wrongly-dismissed catches, verdict accuracy | Is it adding value beyond GPT? |

---

## 3. Architecture — 5 Phases

```
Phase 0 — Close the Data Loop (FOUNDATION)
  ↓ outcomes flow to Supabase
Phase 1 — Observability Dashboard (MEASURE)
  ↓ know where we stand
Phase 2 — Cost & Time Prediction (PREDICT)
  ↓ immediate UX value
Phase 3 — Smart Pass Selection (OPTIMIZE)
  ↓ skip low-value passes
Phase 4 — Strategy Evaluation (EVOLVE)
  ↓ compare bandit algorithms, cross-repo learning
```

Each phase is independently shippable. Phase 0 is the only prerequisite.

---

## 4. Phase 0 — Close the Data Loop (P0, Foundation)

### Problem

Six data gaps prevent any prediction or optimization:

1. `audit_pass_stats.findings_accepted` hardcoded to 0 at write time, never updated
2. `audit_findings` has no adjudication outcome columns
3. `finding_adjudication_events` table exists but `recordAdjudicationEvent()` is never called
4. `.audit/outcomes.jsonl` writes `accepted: true` always (never updated after triage)
5. `findingEditLinks` for bandit reward is never populated
6. Gemini's new findings have no accuracy feedback loop

### Fix: Wire Outcomes Back

#### 4A. openai-audit.mjs — Set adjudicationOutcome on findings

After the orchestrator performs triage (Step 3), enrich each finding with the outcome
before calling `recordRunComplete()`:

```javascript
// In the orchestrator, after triage:
for (const finding of allFindings) {
  const ledgerEntry = ledger.entries.find(e => e.topicId === finding._topicId);
  if (ledgerEntry) {
    finding.adjudicationOutcome = ledgerEntry.adjudicationOutcome;
    finding.remediationState = ledgerEntry.remediationState;
  }
}
```

This makes the existing `recordRunComplete()` filter work — it already checks
`f.adjudicationOutcome === 'accepted'` but the field was never set.

#### 4B. learning-store.mjs — Update pass stats after deliberation

Add `updatePassStatsPostDeliberation(runId, passStats)`:

```javascript
// Called after triage with computed per-pass outcomes:
// { structure: { accepted: 2, dismissed: 5 }, backend: { accepted: 8, dismissed: 3 }, ... }
async updatePassStatsPostDeliberation(runId, passOutcomes) {
  for (const [passName, counts] of Object.entries(passOutcomes)) {
    await this._supabase.from('audit_pass_stats')
      .update({
        findings_accepted: counts.accepted,
        findings_dismissed: counts.dismissed,
        findings_compromised: counts.compromised || 0,
      })
      .eq('run_id', runId)
      .eq('pass_name', passName);
  }
}
```

#### 4C. learning-store.mjs — Record adjudication events

Call the existing `recordAdjudicationEvent()` function after triage:

```javascript
// For each triaged finding:
await store.recordAdjudicationEvent(runId, findingId, {
  adjudicationOutcome: 'accepted', // or 'dismissed', 'severity_adjusted'
  remediationState: 'pending',     // updated later after fix
  ruling: 'sustain',               // or 'overrule', 'compromise'
  round: currentRound,
});
```

#### 4D. outcomes.jsonl — Update accepted field after triage

```javascript
// After triage, update the outcome record:
appendOutcome(logPath, {
  ...originalOutcome,
  accepted: ledgerEntry.adjudicationOutcome === 'accepted',
  reward: computeRewardFromOutcome(ledgerEntry),
});
```

#### 4E. Track Gemini accuracy

When Gemini raises new findings and Claude deliberates:

```javascript
// In gemini-review.mjs or the orchestrator:
for (const gf of geminiResult.new_findings) {
  appendOutcome(logPath, {
    findingId: gf.id,
    pass: 'gemini-new',
    severity: gf.severity,
    accepted: claudeAcceptedIt, // boolean from deliberation
    model: 'gemini',
    category: gf.category,
  });
}

for (const wd of geminiResult.wrongly_dismissed) {
  appendOutcome(logPath, {
    findingId: wd.original_finding_id,
    pass: 'gemini-wrongly-dismissed',
    accepted: claudeAcceptedIt,
    model: 'gemini',
    recommendedSeverity: wd.recommended_severity,
  });
}
```

#### 4F. Additional telemetry to capture in-skill

The skill orchestrator (SKILL.md) should emit structured data during each run:

| Data Point | When | Where |
|---|---|---|
| Round count to converge | End of audit loop | `audit_runs.rounds` (already works) |
| Triage decision per finding | Step 3 | `finding_adjudication_events` (fix 4C) |
| Fix attempt per finding | Step 4 | `remediation_tasks` (existing, needs wiring) |
| Debt items created | Step 3.6 | `debt_entries` (already works) |
| Suppression stats per round | R2+ post-processing | New: `audit_runs.suppression_stats` JSON column |
| Linter vs GPT overlap | Phase 0 tool pre-pass | New: see Phase 0 linter section |

#### 4G. Linter overlap tracking

The Phase C tool pre-pass runs linters before GPT. Track overlap:

```javascript
// After GPT pass completes, compare with linter findings:
const linterFindings = results.findings.filter(f => f.classification?.sourceKind === 'LINTER');
const gptFindings = results.findings.filter(f => !f.classification?.sourceKind);

// For each linter finding, check if GPT raised a similar one:
const overlap = linterFindings.filter(lf =>
  gptFindings.some(gf => jaccardSimilarity(lf.detail, gf.detail) > 0.4)
);

// Record: { linterCount, gptCount, overlapCount, linterOnlyCount, gptOnlyCount }
// → stored in audit_pass_stats or a new metrics table
```

This answers: "Could linters replace GPT for the structure pass?" and
"What unique value does GPT add beyond deterministic tools?"

### Schema Changes

```sql
-- Add adjudication columns to audit_findings
ALTER TABLE audit_findings ADD COLUMN adjudication_outcome TEXT;
ALTER TABLE audit_findings ADD COLUMN remediation_state TEXT;

-- Add suppression stats to audit_runs
ALTER TABLE audit_runs ADD COLUMN suppression_stats JSONB;

-- Add linter overlap metrics to audit_pass_stats
ALTER TABLE audit_pass_stats ADD COLUMN linter_overlap_count INTEGER DEFAULT 0;
ALTER TABLE audit_pass_stats ADD COLUMN linter_only_count INTEGER DEFAULT 0;
ALTER TABLE audit_pass_stats ADD COLUMN gpt_only_count INTEGER DEFAULT 0;
```

### Tests

- Mock store: verify `updatePassStatsPostDeliberation` sends correct counts
- Verify `recordAdjudicationEvent` is called for each triaged finding
- Verify outcomes.jsonl `accepted` field reflects actual triage decision
- Verify Gemini findings are recorded with `model: 'gemini'` tag
- End-to-end: run a small audit, check all 6 data points are persisted

---

## 5. Phase 1 — Observability (P1, Measure Before Optimizing)

### 5A. CLI metrics command

```bash
node scripts/audit-metrics.mjs                    # show key metrics
node scripts/audit-metrics.mjs --repo wine-cellar # per-repo
node scripts/audit-metrics.mjs --json             # machine-readable
```

Output:
```
═══════════════════════════════════════
  AUDIT LOOP METRICS — Last 30 days
═══════════════════════════════════════

  Runs: 42 | Avg rounds: 2.1 | Avg time: 11.4 min

  PRECISION BY PASS
  backend          72% (186/258)  $0.03/finding  avg 155s
  sustainability   45% (301/670)  $0.08/finding  avg 163s
  structure        31% (62/200)   $0.02/finding  avg 17s
  frontend         28% (68/244)   $0.12/finding  avg 65s
  wiring           19% (6/31)     $0.04/finding  avg 7s

  MODEL PERFORMANCE
  GPT-5.4   precision: 48% | 1634 findings raised
  Claude    dismiss rate: 52% | wrongly dismissed: 3% (per Gemini)
  Gemini    new findings: 12 | value-add: 8 accepted

  LEARNING VELOCITY
  FP rate: 52% → 41% (last 20 runs)
  Bandit convergence: 3/11 arms converged (>50 pulls)
```

### 5B. Per-run summary in session manifest

The `.audit/session-audit-*.json` files should include a structured metrics block:

```json
{
  "metrics": {
    "precision": 0.65,
    "costPerAcceptedFinding": 0.04,
    "roundsToConverge": 2,
    "falsePositiveRate": 0.35,
    "geminiValueAdd": 1,
    "suppressionRate": 0.42,
    "linterOverlapRate": 0.15
  }
}
```

---

## 6. Phase 2 — Cost & Time Prediction (P1, Immediate UX Value)

**Data required**: Pass timing + token counts (ALREADY IN SUPABASE — 444 records).

### 6A. Pre-audit cost estimate

Before running, predict cost and time from historical averages:

```javascript
// predictive-strategy.mjs
predictCost(repoProfile, selectedPasses) {
  let totalTokens = 0, maxLatency = 0;
  for (const pass of selectedPasses) {
    const stats = this._passTimings.get(pass);
    if (!stats) continue;
    totalTokens += stats.avgInputTokens + stats.avgOutputTokens;
    maxLatency = Math.max(maxLatency, stats.avgLatencyMs);
  }
  // Parallel passes: total time ≈ max(wave1) + max(wave2) + max(wave3)
  const estimatedMinutes = maxLatency / 60000 * 1.2; // 20% buffer
  const estimatedCost = totalTokens * 2.5 / 1_000_000; // approximate $/token
  return { estimatedTokens: totalTokens, estimatedCostUsd: estimatedCost, estimatedMinutes };
}
```

Display in kickoff card:
```
═══════════════════════════════════════
  AUDIT LOOP — CODE_AUDIT — Starting
  Plan: docs/plans/X.md | Passes: 3/5
  Estimated: ~$0.12 | ~8 min | ~15K tokens
═══════════════════════════════════════
```

### 6B. Load pass timings from Supabase

```javascript
// In PredictiveStrategy.load():
if (typeof store.getPassTimings === 'function') {
  const timings = await store.getPassTimings();
  for (const row of (timings || [])) {
    this._passTimings.set(row.passName, {
      avgInputTokens: row.avgInputTokens,
      avgOutputTokens: row.avgOutputTokens,
      avgLatencyMs: row.avgLatencyMs,
      runCount: row.runCount,
    });
  }
}
```

Add to learning-store.mjs:
```javascript
async getPassTimings() {
  const { data } = await this._supabase.rpc('get_pass_timing_averages');
  return data;
}
```

Supabase function:
```sql
CREATE OR REPLACE FUNCTION get_pass_timing_averages()
RETURNS TABLE (pass_name TEXT, avg_input_tokens NUMERIC, avg_output_tokens NUMERIC, avg_latency_ms NUMERIC, run_count BIGINT)
AS $$
  SELECT pass_name,
         AVG(input_tokens)::NUMERIC AS avg_input_tokens,
         AVG(output_tokens)::NUMERIC AS avg_output_tokens,
         AVG(latency_ms)::NUMERIC AS avg_latency_ms,
         COUNT(*)::BIGINT AS run_count
  FROM audit_pass_stats
  WHERE input_tokens > 0
  GROUP BY pass_name;
$$ LANGUAGE sql STABLE;
```

---

## 7. Phase 3 — Smart Pass Selection (P2, After Phase 0 data flows)

### 7A. FP-driven pass deprioritization

Use the 9,190 existing FP patterns to identify passes that produce mostly noise
for a given repo:

```javascript
// If >70% of a pass's findings for this repo fingerprint are FP-suppressed,
// recommend skipping (with --predictive-skip flag)
predictActivePasses(repoId, diffStats, allowSkip) {
  for (const [passName, stats] of this._passStats) {
    const fpRate = this._fpTracker.getPassFpRate(passName, repoId);
    const confidence = stats.totalRuns >= 20 ? 1 - fpRate : 1;
    const recommendSkip = allowSkip && fpRate > 0.7 && stats.totalRuns >= 20;
    result.set(passName, { confidence, recommendSkip, fpRate });
  }
}
```

### 7B. Repo-profile-aware pass filtering (enhance existing)

The repo profiler already skips frontend for backend-only repos. Enhance with:

- **Diff-type awareness**: If diff only touches `.md` files, skip backend/frontend
- **File-count scaling**: For <5 files, run structure + sustainability only (wiring/backend add little)
- **Historical pass ROI**: Sort passes by `accepted_findings / token_cost` for this repo

### 7C. Reasoning effort optimization

Track `(pass, reasoning_effort, acceptance_rate)` triples. Use the existing
Thompson Sampling bandit to select effort level:

```javascript
// Bandit arms: "backend:low", "backend:medium", "backend:high"
// Reward = acceptance_rate for that pass in that run
const effortArm = bandit.select(`${passName}:effort`);
// Returns 'low', 'medium', or 'high' based on posterior
```

This requires Phase 0 outcome data flowing to compute acceptance rates.

---

## 8. Phase 4 — Strategy Evaluation (P3, At Critical Mass)

### 8A. Bandit algorithm comparison

At 100+ pulls per arm, retrospectively compare:

| Algorithm | Approach | Strengths |
|---|---|---|
| Thompson Sampling (current) | Beta posterior, random sample | Explores naturally, handles uncertainty |
| UCB1 | Upper confidence bound | Optimal regret bounds, deterministic |
| ε-greedy | Random exploration ε% of time | Simple, predictable exploration |
| Softmax | Boltzmann temperature-based | Smooth exploration/exploitation tradeoff |

Implementation: log all bandit decisions to a replay buffer. Simulate alternative
algorithms offline using the same reward sequence. Compare cumulative regret.

```javascript
// scripts/evaluate-bandits.mjs
// Replays historical arm selections + rewards through each algorithm
// Reports: cumulative reward, regret, convergence speed
```

### 8B. Cross-repo learning

Currently each repo's FP patterns and pass stats are independent. With 3+ repos
and 100+ runs total, we can identify:

- **Universal patterns**: findings that are FP across ALL repos (framework noise)
- **Repo-specific patterns**: findings that are FP only in one repo (context-dependent)
- **Stack patterns**: findings that correlate with stack profile (e.g., SOLID violations
  are 80% FP in pure JS repos but 40% FP in TypeScript repos)

### 8C. Linter effectiveness analysis

With Phase 0 overlap tracking data:

```bash
node scripts/audit-metrics.mjs --linter-analysis
```

Output:
```
  LINTER vs GPT OVERLAP (last 50 runs)
  Linter catches that GPT also raised:    23/45 (51%)
  Linter-only (GPT missed):               22/45 (49%)
  GPT-only (linter missed):              412/480 (86%)
  
  CONCLUSION: Linters add 22 unique findings GPT misses.
  GPT adds 412 findings linters can't catch (architectural).
  Recommendation: keep both. Linters are 100x faster for mechanical issues.
  
  STRUCTURE PASS OPPORTUNITY:
  If linters covered structure pass's mechanical findings,
  structure pass could focus on architectural structure only.
  Estimated savings: 17s/run, $0.008/run.
```

---

## 9. File-Level Plan

### Phase 0 Files

| File | Change | Purpose |
|---|---|---|
| `scripts/openai-audit.mjs` | Modify | Set `adjudicationOutcome` on findings after triage; call `recordAdjudicationEvent()` |
| `scripts/learning-store.mjs` | Modify | Add `updatePassStatsPostDeliberation()`, `getPassTimings()`, `recordGeminiOutcome()` |
| `scripts/gemini-review.mjs` | Modify | Record Gemini finding outcomes with `model: 'gemini'` tag |
| `scripts/lib/findings-outcomes.mjs` | Modify | Fix `appendOutcome()` to accept `accepted` parameter (not hardcode `true`) |
| `supabase/migrations/NNN_outcome_columns.sql` | New | ALTER TABLE for adjudication columns + linter overlap |
| `tests/outcome-sync.test.mjs` | New | Verify data loop closure |

### Phase 1 Files

| File | Change |
|---|---|
| `scripts/audit-metrics.mjs` | New — CLI metrics dashboard |
| `scripts/lib/metrics.mjs` | New — metric computation from Supabase data |

### Phase 2 Files

| File | Change |
|---|---|
| `scripts/lib/predictive-strategy.mjs` | Modify — add `predictCost()`, `loadPassTimings()` |
| `scripts/learning-store.mjs` | Modify — add `getPassTimings()` RPC call |
| `supabase/migrations/NNN_timing_function.sql` | New — `get_pass_timing_averages()` function |

### Phase 3 Files

| File | Change |
|---|---|
| `scripts/lib/predictive-strategy.mjs` | Modify — enhance `predictActivePasses()` with FP rates + ROI |
| `scripts/openai-audit.mjs` | Modify — wire pass selection from strategy |
| `scripts/lib/config.mjs` | Modify — add reasoning effort bandit config |

### Phase 4 Files

| File | Change |
|---|---|
| `scripts/evaluate-bandits.mjs` | New — offline bandit algorithm comparison |
| `scripts/lib/cross-repo-learning.mjs` | New — universal vs repo-specific FP patterns |

---

## 10. Risk & Trade-off Register

| Risk | Mitigation |
|---|---|
| Phase 0 changes break existing outcome flow | All changes are additive — existing fields preserved, new fields optional |
| Pass skipping misses real findings | Skip is opt-in only (`--predictive-skip`); periodic full audits validate |
| Supabase schema migration on shared DB | Additive columns only (ALTER ADD, not ALTER DROP); backward compat |
| Bandit comparison is retrospective only | No live A/B testing — replay buffer analysis is risk-free |
| Linter overlap tracking adds latency | <100ms comparison after passes complete; non-blocking |

### Deliberately Deferred

| Item | Reason |
|---|---|
| ML/logistic regression for pass selection | Needs 200+ labeled runs; premature before Phase 0 data flows |
| Real-time cost tracking ($) | Token prices change; estimate is sufficient for planning |
| Cross-organization learning | Only one user (Louis); revisit if the tool gets external adoption |

---

## 11. Implementation Order

```
Phase 0A — Fix appendOutcome accepted field           [30 min]
Phase 0B — Wire adjudicationOutcome in orchestrator    [1 hour]
Phase 0C — Call recordAdjudicationEvent                [30 min]
Phase 0D — Add updatePassStatsPostDeliberation         [1 hour]
Phase 0E — Supabase migration for new columns          [30 min]
Phase 0F — Gemini outcome tracking                     [30 min]
Phase 0G — Linter overlap tracking                     [1 hour]
  → TEST: run 5 audits, verify all data flows          [passive]
Phase 1  — audit-metrics.mjs CLI                       [2 hours]
Phase 2  — Cost/time prediction                        [2 hours]
  → CHECKPOINT: 50 labeled runs, evaluate Phase 3 data [passive]
Phase 3  — Smart pass selection                        [3 hours]
Phase 4  — Strategy evaluation (after 100+ labeled runs) [4 hours]
```

Total active implementation: ~12 hours across 4 phases.
Total wall time: weeks (waiting for labeled runs to accumulate between phases).
