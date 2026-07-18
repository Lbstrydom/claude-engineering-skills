# Plan: Audit-Loop Meta-Assessment System

- **Date**: 2026-04-06
- **Status**: Complete
- **Author**: Claude + Louis

## 1. Context Summary

### What exists today

The audit-loop already collects rich outcome data:

| Data source | Path | What it records |
|---|---|---|
| **outcomes.jsonl** | `.audit/outcomes.jsonl` | Every finding: severity, pass, accepted/dismissed, semanticHash, pipelineVariant, auditorProvider |
| **fp-tracker.json** | `.audit/fp-tracker.json` | Per-pattern EMA of false positive likelihood (auto-suppresses at <15% acceptance) |
| **bandit-state.json** | `.audit/bandit-state.json` | Thompson Sampling alpha/beta per prompt variant — tracks which prompts produce accepted findings |
| **Supabase** | `audit_runs`, `audit_findings`, `finding_adjudication_events` | Cloud mirror of above + cross-repo aggregation |

The **refine-prompts.mjs** system already reads outcomes and uses an LLM to suggest prompt improvements. It computes `computePassEWR()` (effectiveness-weighted reward) and `computePassEffectiveness()` (acceptance rate, signal score) per pass.

The **evolve-prompts.mjs** system creates prompt experiments, tracks them through the bandit, and promotes/kills variants based on convergence.

### What's missing

Nobody asks: **"Is the audit loop itself getting better over time?"** The individual components (bandit, FP tracker, prompt refinement) each optimize locally, but there's no system-level view that answers:

- Are we producing fewer false positives than 10 audits ago?
- Are HIGHs actually leading to code changes, or are they severity-inflated?
- Is the Gemini final gate catching things GPT misses, or just adding noise?
- Is pipeline variant B (Gemini auditor) outperforming variant A (GPT auditor)?
- Are we converging faster or slower over time?

### What we can reuse

- `loadOutcomes()` — reads the full outcome history
- `computePassEffectiveness()` — acceptance rate + signal score per pass
- `computePassEWR()` — effectiveness-weighted reward with confidence interval
- `FalsePositiveTracker.getReport()` — suppression stats per pattern
- `PromptBandit.getStats()` — arm performance stats
- `appendOutcome()` — for storing assessment records in JSONL
- `refine-prompts.mjs` — already has the LLM-driven prompt suggestion pipeline

## 2. Proposed Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                   Audit Run Completes                        │
│  outcomes.jsonl ← appendOutcome() with pipelineVariant tag  │
└──────────────────────────┬──────────────────────────────────┘
                           │
                    (every 3-5 runs)
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              meta-assess.mjs (new script)                    │
│                                                              │
│  Phase 1: Gather metrics (deterministic, no LLM)             │
│    ├─ FP rate per pass (dismissed / total)                   │
│    ├─ Recurring FP patterns (fp-tracker EMA < 0.3)           │
│    ├─ Signal quality (findings with remediationState=fixed)  │
│    ├─ Severity calibration (HIGH acceptance vs M/L)          │
│    ├─ Convergence speed (avg rounds to threshold per run)    │
│    ├─ Pipeline variant comparison (A vs B outcomes)          │
│    └─ Gemini gate value (new findings that were accepted)    │
│                                                              │
│  Phase 2: LLM assessment (GPT or Gemini Flash)               │
│    ├─ Receives metrics + sampled outcome examples             │
│    ├─ Identifies systemic patterns                           │
│    ├─ Recommends specific prompt changes                     │
│    └─ Outputs structured MetaAssessmentSchema                │
│                                                              │
│  Phase 3: Act on assessment                                  │
│    ├─ Feed recommendations to refine-prompts.mjs             │
│    ├─ Adjust FP suppression thresholds                       │
│    ├─ Flag passes needing prompt evolution                   │
│    └─ Store assessment in .audit/meta-assessments.jsonl      │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

```
outcomes.jsonl + fp-tracker.json + bandit-state.json
    │
    ▼
computeAssessmentMetrics()          ← deterministic, ~0ms
    │
    ▼
shouldRunAssessment()               ← check interval (every 3-5 runs)
    │ (yes)
    ▼
runLLMAssessment(metrics, samples)  ← LLM call (~30s, reasoning: medium)
    │
    ▼
storeAssessment()                   ← append to .audit/meta-assessments.jsonl
    │
    ▼
applyRecommendations()              ← feed into refine-prompts pipeline
```

### Key Design Decisions

| Decision | Principle | Rationale |
|---|---|---|
| Deterministic metrics first, LLM second | **Modularity (#7)** | Metrics are useful even without LLM — can run `--local-only` for quick stats |
| JSONL storage (not JSON) | **Append-only safety** | Same pattern as outcomes.jsonl — crash-safe, immutable history |
| Assessment interval stored in pipeline-state.json | **Single Source of Truth (#10)** | Already tracks run count and variant — natural place for assessment counter |
| LLM receives metrics + examples, not raw data | **Defensive Validation (#12)** | Bounded input size, no sensitive file paths leaked |
| Recommendations feed into existing refine-prompts | **DRY (#1)** | Don't duplicate the prompt refinement pipeline |

## 3. Sustainability Notes

### Assumptions that could change

- **Assessment interval (3-5 runs)**: Might need tuning — too frequent wastes tokens, too rare misses trends. Make configurable via `META_ASSESS_INTERVAL` env var.
- **Single-model assessment**: Currently uses one LLM. Could become a multi-model assessment (GPT assesses Gemini, Gemini assesses GPT) for cross-validation.
- **Local-first storage**: If teams share assessments, need cloud table. Deferred until team features are built.

### Extension points

- `computeAssessmentMetrics()` returns a plain object — easy to add new metrics without changing the LLM prompt
- Schema is versioned — future fields are additive
- Assessment history enables trend detection ("FP rate dropping over time" vs "stagnant")

## 4. File-Level Plan

### New files

#### `scripts/meta-assess.mjs` — Main orchestrator

**Purpose**: Periodic meta-assessment of audit-loop performance.

**Key exports**:
```javascript
// Deterministic metrics computation (no LLM)
export function computeAssessmentMetrics(outcomes, fpTracker, bandit, options)
// → { fpRate, recurringFPs, signalQuality, severityCalibration,
//    convergenceSpeed, pipelineComparison, geminiGateValue, window }

// Check if assessment is due
export function shouldRunAssessment(pipelineStatePath, interval)
// → { shouldRun: boolean, runsSinceLastAssessment: number }

// LLM-driven assessment
export async function runLLMAssessment(client, metrics, sampledOutcomes)
// → MetaAssessmentResult

// Store + act on results
export function storeAssessment(result, assessmentLogPath)
export function formatAssessmentReport(result) // → markdown string
```

**CLI usage**:
```bash
node scripts/meta-assess.mjs                    # Full assessment (metrics + LLM)
node scripts/meta-assess.mjs --metrics-only     # Deterministic metrics only
node scripts/meta-assess.mjs --json             # JSON output
node scripts/meta-assess.mjs --force            # Run even if interval not reached
```

**Dependencies**: `findings.mjs` (loadOutcomes, FalsePositiveTracker), `bandit.mjs` (PromptBandit), `config.mjs`, `openai` (for LLM call)

**Why this file**: Single Responsibility (#2) — assessment is a distinct concern from auditing, prompt refinement, or debt review.

#### `scripts/lib/schemas.mjs` additions — Assessment schema

```javascript
export const MetaAssessmentSchema = z.object({
  window: z.object({
    fromRun: z.number(),
    toRun: z.number(),
    outcomeCount: z.number(),
    dateRange: z.string(),
  }),

  metrics: z.object({
    fpRate: z.object({
      overall: z.number(),          // 0-1
      byPass: z.record(z.number()), // { backend: 0.23, sustainability: 0.45 }
      trend: z.enum(['improving', 'stable', 'worsening']),
    }),
    signalQuality: z.object({
      findingsLeadingToChanges: z.number(), // count
      totalFindings: z.number(),
      changeRate: z.number(),               // 0-1
    }),
    severityCalibration: z.object({
      highAcceptanceRate: z.number(),       // what % of HIGHs were accepted
      mediumAcceptanceRate: z.number(),
      lowAcceptanceRate: z.number(),
      miscalibrated: z.boolean(),           // HIGH acceptance < MEDIUM acceptance = miscalibrated
    }),
    convergenceSpeed: z.object({
      avgRoundsToConverge: z.number(),
      medianRoundsToConverge: z.number(),
      trend: z.enum(['faster', 'stable', 'slower']),
    }),
    pipelineComparison: z.object({
      variantA: z.object({ runs: z.number(), fpRate: z.number(), avgFindings: z.number() }),
      variantB: z.object({ runs: z.number(), fpRate: z.number(), avgFindings: z.number() }),
      betterVariant: z.enum(['A', 'B', 'insufficient_data', 'no_difference']),
    }),
  }),

  diagnosis: z.string().max(2000),     // LLM's interpretation of the metrics
  recommendations: z.array(z.object({
    type: z.enum(['prompt_change', 'threshold_adjustment', 'pass_config', 'pipeline_config']),
    target: z.string().max(100),       // e.g., "sustainability pass prompt", "FP threshold"
    action: z.string().max(500),       // specific change
    rationale: z.string().max(300),    // why
    priority: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  })).max(10),

  overallHealth: z.enum(['healthy', 'needs_attention', 'degraded']),
});
```

### Modified files

#### `scripts/lib/config.mjs` — Add assessment config

```javascript
export const assessmentConfig = Object.freeze({
  interval: safeInt(process.env.META_ASSESS_INTERVAL, 4),  // every N runs
  minOutcomes: safeInt(process.env.META_ASSESS_MIN_OUTCOMES, 20), // need this many outcomes
  windowSize: safeInt(process.env.META_ASSESS_WINDOW, 50), // look at last N outcomes
  model: process.env.META_ASSESS_MODEL || 'gemini-2.5-flash', // cheap model for assessment
});
```

#### `scripts/lib/llm-auditor.mjs` — Add run counter to pipeline-state.json

```javascript
// Existing: { lastVariant, updatedAt, runCount }
// Add: { ..., lastAssessmentAtRun: number }
```

#### `scripts/audit-loop.mjs` — Trigger assessment after audit completes

After Step 8 (debt review), before the summary:
```javascript
// Step 8.5 — Meta-assessment (every N runs)
try {
  const { shouldRunAssessment, ... } = await import('./scripts/meta-assess.mjs');
  const { shouldRun } = shouldRunAssessment('.audit/pipeline-state.json');
  if (shouldRun) {
    banner('META-ASSESSMENT — Loop Performance Review');
    execFileSync('node', ['scripts/meta-assess.mjs', '--out', assessmentOutFile], ...);
  }
} catch { /* non-blocking */ }
```

#### `scripts/openai-audit.mjs` — Increment run counter

After each completed audit, increment `runCount` in pipeline-state.json (already partially done — currently only tracks variant alternation).

### Storage

#### `.audit/meta-assessments.jsonl` — Assessment history

One JSON record per line, append-only:
```json
{
  "timestamp": 1743976800000,
  "window": { "fromRun": 12, "toRun": 16, "outcomeCount": 47 },
  "metrics": { "fpRate": { "overall": 0.34, "byPass": {...}, "trend": "improving" }, ... },
  "diagnosis": "Sustainability pass continues to over-flag architectural opinions...",
  "recommendations": [...],
  "overallHealth": "needs_attention"
}
```

Add to gitignore patterns in `ensureAuditGitignore()`:
```
.audit/meta-assessments.jsonl
```

## 5. Risk & Trade-off Register

| Risk | Mitigation | Severity |
|---|---|---|
| Assessment LLM hallucinates metrics | Metrics are computed deterministically first; LLM only interprets and recommends | LOW — LLM can't change the numbers |
| Assessment too expensive | Use Gemini Flash (cheap) not GPT-5.4; run only every 4 audits | LOW — ~$0.02 per assessment |
| Recommendations are bad | Recommendations feed into `refine-prompts.mjs` which requires human approval before promotion | LOW — human in the loop |
| Insufficient data for meaningful trends | `minOutcomes` threshold (default 20) prevents premature assessment | LOW |
| Pipeline variant comparison biased by repo mix | Deterministic alternation ensures balanced allocation; assessment notes sample sizes | MEDIUM — flag when N < 5 per variant |

### Deliberately deferred

- **Cross-repo aggregation**: Assessment is per-repo. Team-level aggregation requires Supabase schema extension — build when team features are ready.
- **Automated prompt promotion**: Assessment recommends, humans decide. Fully automated promotion is Phase 2.
- **Multi-model cross-assessment**: GPT assessing Gemini's work and vice versa. Interesting but complex — assess value after v1 data.

## 6. Testing Strategy

### Unit tests

| Test | What it covers |
|---|---|
| `computeAssessmentMetrics()` with fixture outcomes | FP rate, signal quality, severity calibration calculations |
| `shouldRunAssessment()` with various run counts | Interval logic, edge cases (first run, exactly at interval) |
| `severityCalibration.miscalibrated` detection | HIGH acceptance < MEDIUM acceptance triggers flag |
| `pipelineComparison.betterVariant` with small N | Returns `insufficient_data` when <5 runs per variant |
| `trend` computation (improving/stable/worsening) | Compares first half vs second half of window |
| Schema validation with edge cases | Empty outcomes, all-dismissed, all-accepted |

### Integration tests

| Test | What it covers |
|---|---|
| Full pipeline: fixtures → metrics → LLM → store | End-to-end with mocked LLM response |
| Assessment triggers at correct interval | Run counter increments and resets properly |
| Recommendations round-trip to refine-prompts | Assessment output is valid input for prompt refinement |

### Key edge cases

- Zero outcomes in window (new repo, first audit)
- All findings dismissed (100% FP rate — degraded health)
- All findings accepted (0% FP — suspicious, might indicate rubber-stamping)
- Only variant A data (variant B never ran — `insufficient_data`)
- Outcomes from before pipeline variant tagging (missing `pipelineVariant` field)

## 7. LLM Assessment Prompt (Draft)

```
You are evaluating the performance of an automated code audit system.

The system uses GPT-5.4 to audit code in 5 parallel passes (structure, wiring,
backend, frontend, sustainability), then Claude deliberates on findings, and
Gemini provides an independent final review.

Below are metrics from the last {window} audit outcomes.

## Metrics

{metrics JSON}

## Sample Outcomes (representative examples)

### Recently Dismissed (potential false positives)
{3-5 dismissed findings with category, severity, pass}

### Recently Accepted (good signal)
{3-5 accepted findings with category, severity, pass}

### Recurring Patterns
{top 5 FP patterns from fp-tracker with EMA scores}

## Your Tasks

1. DIAGNOSE: What patterns do you see? Which passes are underperforming?
   Is severity calibration accurate? Are recurring FPs being handled?

2. RECOMMEND: Suggest specific, actionable changes. Types:
   - prompt_change: modify a pass prompt (cite which pass, what to change)
   - threshold_adjustment: change FP suppression or severity thresholds
   - pass_config: change pass structure (split, merge, reasoning level)
   - pipeline_config: change A/B test weights or model selection

3. OVERALL HEALTH: healthy / needs_attention / degraded

Be concise. Focus on the 2-3 highest-impact recommendations.
```

## 8. Implementation Order

| Step | Effort | Depends on |
|---|---|---|
| 1. Add `MetaAssessmentSchema` to schemas.mjs | EASY | — |
| 2. Add `assessmentConfig` to config.mjs | TRIVIAL | — |
| 3. Build `computeAssessmentMetrics()` (deterministic) | MEDIUM | 1 |
| 4. Build `shouldRunAssessment()` + run counter | EASY | 2 |
| 5. Build `runLLMAssessment()` with prompt | MEDIUM | 1, 3 |
| 6. Build `storeAssessment()` + `formatAssessmentReport()` | EASY | 1 |
| 7. Wire into audit-loop.mjs | EASY | 4 |
| 8. Add `.audit/meta-assessments.jsonl` to gitignore | TRIVIAL | — |
| 9. Write tests | MEDIUM | 3, 4, 5 |
| 10. Connect recommendations to refine-prompts.mjs | MEDIUM | 5, 6 |
