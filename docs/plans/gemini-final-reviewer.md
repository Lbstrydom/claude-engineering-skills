# Plan: Gemini 3.1 Pro Final Reviewer
- **Date**: 2026-03-29
- **Status**: Complete
- **Author**: Claude + Louis

---

## 1. Context Summary

### What exists today

The audit-loop system is a **two-model peer review** pipeline:

1. **Claude** (Opus/Sonnet) — plans code, implements fixes, deliberates on findings
2. **GPT-5.4** (`openai-audit.mjs`) — independent auditor with multi-pass code analysis, plan review, and rebuttal deliberation

The pipeline is: Plan → GPT Audit → Claude Deliberation → GPT Rebuttal → Fix → Loop → Converge.

After convergence, **Step 6.5** runs an "Opus Deep Review" — but this is Claude reviewing its own work. The user correctly identifies this as biased: Claude authored the code, so it has motivated reasoning to approve it.

### What we can reuse

- **`callGPT()` pattern** — timeout management, abort controller, usage tracking, graceful degradation via `safeCallGPT()`. The Gemini caller should follow the same contract.
- **Zod schemas** — `FindingSchema`, `CodeAuditResultSchema` structure. Gemini 3.1 Pro supports structured JSON output, but via its own JSON schema format (not Zod directly). We'll convert Zod schemas to JSON Schema for Gemini.
- **`readProjectContextForPass()`** — targeted CLAUDE.md extraction. The Gemini reviewer gets the full context (like plan/rebuttal mode).
- **`readFilesAsContext()`** — file reading with truncation and sensitive file filtering.
- **`extractPlanPaths()`** — plan file discovery.
- **`semanticId()`** — content-hashed finding IDs for cross-model dedup.
- **Output helpers** — `writeOutput()`, `formatFindings()`.

### What is new

- A new script: `gemini-review.mjs` — standalone Gemini 3.1 Pro reviewer
- A new `review` mode that receives the full audit trail and renders an independent verdict
- Updated SKILL.md Step 6.5 to invoke Gemini instead of Opus self-review

---

## 2. Proposed Architecture

### Component Diagram

```
openai-audit.mjs (existing)     gemini-review.mjs (NEW)
       │                                │
       │  GPT-5.4 audit results         │  Full audit trail input
       │  + deliberation results        │  (plan + code + findings +
       │                                │   rebuttals + resolutions)
       ▼                                ▼
┌──────────────┐              ┌──────────────────┐
│  Claude      │  converges   │  Gemini 3.1 Pro  │
│  Orchestrator│ ──────────►  │  Final Review    │
│  (SKILL.md)  │              │  (independent)    │
└──────────────┘              └──────────────────┘
                                       │
                                       ▼
                              Independent verdict:
                              - Missed issues
                              - Motivated reasoning flags
                              - Bias detection
                              - Final quality gate
```

### Data Flow

1. Claude + GPT-5.4 loop converges (Steps 2-6 as today)
2. Claude assembles the **full audit transcript** (plan, code files, all GPT findings across rounds, all Claude rebuttals, all GPT rulings, final finding state)
3. Claude calls `node scripts/gemini-review.mjs review <plan-file> <transcript-file> [--out <file>]`
4. Gemini 3.1 Pro receives the transcript and renders an independent verdict
5. Claude processes the verdict — fixes accepted items, challenges disagreements
6. If Gemini raises HIGH findings, one more GPT verification round runs (not Gemini re-reviewing itself)

### Key Design Decisions

| Decision | Principle | Rationale |
|----------|-----------|-----------|
| Separate script (not embedded in openai-audit.mjs) | **SRP** (#2), **Modularity** (#7) | Different provider, different SDK, different responsibility. Keeps openai-audit.mjs focused on GPT. |
| Gemini reviews transcript, not code directly | **Single pass efficiency** | Gemini's value is the *meta-review* — catching bias and gaps in the Claude-GPT deliberation. Code details are already in the transcript. |
| No Gemini-to-Gemini rebuttal loop | **No infinite debate** | Gemini is the final arbiter. Claude can accept or challenge locally, but no multi-round Gemini loop. Max 2 Gemini rounds. |
| JSON Schema via `responseSchema` (not Zod) | **SDK compatibility** | Google GenAI SDK uses native JSON Schema for structured output, not Zod. We convert from our Zod schemas. |
| Reuse FindingSchema shape | **DRY** (#1), **Single Source of Truth** (#10) | Same finding structure across all three models enables unified tracking. |
| Include code files in transcript | **Context completeness** | Gemini needs to see actual code to detect issues GPT and Claude both missed, not just their opinions about the code. |

---

## 3. Sustainability Notes

### Assumptions that could change
- Gemini 3.1 Pro Preview becomes GA (model ID may change) → configurable via `GEMINI_REVIEW_MODEL` env var
- Google adds native Zod support to their SDK → simplify schema conversion later
- A fourth model becomes available → the script pattern (one file per provider) scales cleanly

### Extension points
- `GEMINI_REVIEW_MODEL` env var allows swapping models without code changes
- Transcript format is provider-agnostic JSON — could feed to any future reviewer
- The `callGemini()` helper follows the same `{result, usage, latencyMs}` contract as `callGPT()` — could be extracted to a shared interface later if needed

### What we deliberately defer
- **Gemini for mid-loop auditing** — today Gemini is final-gate only. Adding it as a parallel mid-loop auditor would be a separate feature.
- **Shared `callModel()` abstraction** — two providers don't justify an abstraction yet. If we add a fourth model, extract then.

---

## 4. File-Level Plan

### 4.1 `scripts/gemini-review.mjs` (NEW)

**Purpose**: Standalone Gemini 3.1 Pro final reviewer script.

**Key exports/functions**:
- `callGemini(ai, opts)` — Single Gemini API call with structured output, timeout, usage tracking. Returns `{result, usage, latencyMs}`. Same contract as `callGPT()`.
- `runFinalReview(ai, transcriptContent, planContent, codeContext)` — Orchestrates the final review call.
- `main()` — CLI entry point.

**CLI interface** (mirrors openai-audit.mjs pattern):
```bash
# Review mode: independent final verdict on full audit transcript
node scripts/gemini-review.mjs review <plan-file> <transcript-file> [--out <file>] [--json]

# Quick test: verify API connectivity
node scripts/gemini-review.mjs ping
```

**Schema**: `GeminiFinalReviewSchema` — structured output:
```javascript
{
  verdict: 'APPROVE' | 'CONCERNS' | 'REJECT',

  // Meta-review: did the Claude-GPT loop work well?
  deliberation_quality: {
    claude_bias_detected: boolean,     // Did Claude dismiss valid findings?
    gpt_false_positives: number,       // How many GPT findings were noise?
    missed_issues: [...],              // Issues neither model caught
    over_engineering_flags: [...],     // Audit pressure causing bloat
  },

  // Independent findings (things Gemini found that both models missed)
  new_findings: [FindingSchema],       // Max 10 — only genuinely new

  // Findings from GPT that Claude dismissed but Gemini thinks were valid
  wrongly_dismissed: [{
    original_finding_id: string,
    reason_claude_was_wrong: string,
    recommended_severity: 'HIGH' | 'MEDIUM' | 'LOW',
  }],

  // Overall assessment
  architectural_coherence: 'Strong' | 'Adequate' | 'Weak',
  overall_reasoning: string,
}
```

**Dependencies**: `@google/genai`, `dotenv`, `zod` (for schema definition, converted to JSON Schema for API call), shared file helpers (inlined or imported from a shared module).

**Why this file**: SRP (#2) — Gemini review is a distinct responsibility from GPT auditing. Modularity (#7) — can be tested and run independently.

### 4.2 `scripts/shared.mjs` (NEW — in `scripts/` directory)

**Purpose**: Extract shared utilities used by both `openai-audit.mjs` and `gemini-review.mjs`.

**Functions to extract**:
- `readFileOrDie(filePath)`
- `readProjectContext()` / `readProjectContextForPass(passName)`
- `extractPlanPaths(planContent)`
- `readFilesAsContext(filePaths, opts)`
- `classifyFiles(filePaths)`
- `isSensitiveFile(relPath)`
- `writeOutput(data, outPath, summaryLine)`
- `formatFindings(findings)`
- `semanticId(finding)` — content-hash for cross-model dedup
- `safeInt(val, fallback)`
- `buildHistoryContext(historyPath)`

**Why this file**: DRY (#1) — these utilities are currently in openai-audit.mjs but needed by both scripts. Extracting prevents copy-paste.

### 4.3 `scripts/openai-audit.mjs` (MODIFY)

**Changes**:
- Import shared utilities from `./shared.mjs` instead of defining them inline
- No functional changes — GPT auditing behavior is unchanged

**Why**: DRY (#1) — deduplicate shared code.

### 4.4 `.claude/skills/audit-loop/SKILL.md` + `.github/skills/audit-loop/SKILL.md` (MODIFY)

**Changes to Step 6.5**:

Replace "Opus Deep Review" with "Gemini Independent Review":

```markdown
## Step 6.5 — Gemini Independent Review (Final Gate)

After GPT-5.4 convergence, run an independent review using Gemini 3.1 Pro —
a third model with no stake in the Claude-GPT deliberation.

### Build Transcript

Assemble `/tmp/audit-$$-transcript.json`:
```json
{
  "plan": "<full plan content>",
  "code_files": ["<file paths included in audit>"],
  "rounds": [
    {
      "round": 1,
      "gpt_findings": [...],
      "claude_positions": [...],
      "gpt_rulings": [...],
      "fixes_applied": [...]
    }
  ],
  "final_state": {
    "remaining_findings": [...],
    "dismissed_findings": [...]
  }
}
```

### Run Review

```bash
node scripts/gemini-review.mjs review <plan-file> /tmp/audit-$$-transcript.json \
  --out /tmp/gemini-$$-result.json 2>/tmp/gemini-$$-stderr.log
```

### Process Verdict

| Gemini Verdict | Action |
|---------------|--------|
| `APPROVE` | Done — proceed to final report |
| `CONCERNS` | Fix new_findings + wrongly_dismissed, run ONE GPT verification round |
| `REJECT` | Present to user — significant issues need human judgment |

**Gemini checks what the loop misses:**
- Claude bias: Did Claude dismiss valid GPT findings to protect its own code?
- False consensus: Did both models miss something obvious?
- Over-engineering: Did audit pressure cause unnecessary complexity?
- Architectural coherence across the full codebase
- Cross-file naming/pattern consistency

Deliberate on Gemini findings locally (ACCEPT/PARTIAL/CHALLENGE).
Fix accepted items. If new HIGH findings, run one GPT verification. Max 2 Gemini rounds.
```

### 4.5 `.env.example` (MODIFY)

Add:
```
# Optional: Gemini API key for independent final review (Step 6.5)
GEMINI_API_KEY=AIza...

# Optional: Override Gemini model (default: gemini-3.1-pro-preview)
# GEMINI_REVIEW_MODEL=gemini-3.1-pro-preview

# Optional: Gemini timeout in ms (default: 120000 = 2 min)
# GEMINI_REVIEW_TIMEOUT_MS=120000
```

### 4.6 `package.json` (MODIFY)

Add script:
```json
"audit:gemini-review": "node scripts/gemini-review.mjs review"
```

---

## 5. Risk & Trade-off Register

| Risk | Mitigation |
|------|------------|
| Gemini 3.1 Pro Preview model ID changes at GA | `GEMINI_REVIEW_MODEL` env var override |
| Gemini structured output less reliable than GPT's `responses.parse()` | Validate with Zod after receiving response; fallback to raw text extraction if schema fails |
| Gemini adds latency to already long loop | Single call, not multi-pass. Expected ~30-60s. Runs only once at convergence. |
| Gemini raises too many false positives on first use | Cap `new_findings` at 10, require HIGH/MEDIUM only for action items |
| Shared module extraction breaks openai-audit.mjs | Both scripts share the same `shared.mjs` — test openai-audit.mjs after extraction |
| `GEMINI_API_KEY` not set | Graceful skip: warn and proceed to final report without Gemini gate. Don't block the loop. |

### Trade-offs made

1. **Separate script vs. unified multi-provider script** — Chose separate for SRP. Trade-off: slight duplication in CLI parsing. Worth it for independent testability.
2. **Transcript-based review vs. direct code review** — Chose transcript. Trade-off: Gemini relies on GPT's code reading. Worth it because Gemini's value is the meta-review (bias detection), and it still gets the code files in the transcript.
3. **Max 2 Gemini rounds vs. unlimited** — Chose cap. Trade-off: might miss cascading issues. Worth it to prevent cost/time explosion. The GPT verification after fixes catches regressions.

### Deliberately deferred

- **Parallel Gemini + GPT auditing mid-loop** — Not needed yet. The final gate is the right insertion point.
- **Gemini for plan audits** — Could add later. Plan audits are less bias-prone (Claude hasn't written code yet).
- **Cost estimation for Gemini** — Google pricing changes frequently. Add after we see real usage.

---

## 6. Testing Strategy

### Manual testing (primary — scripts are CLI tools)

1. **Connectivity**: `node scripts/gemini-review.mjs ping` — verify API key works
2. **Dry run**: Feed a real transcript from a previous audit loop and verify structured output
3. **Graceful degradation**: Unset `GEMINI_API_KEY` and verify the skill skips Step 6.5 cleanly
4. **Timeout handling**: Set `GEMINI_REVIEW_TIMEOUT_MS=5000` and verify timeout message

### Key edge cases

- Transcript is very large (30+ files, 6 rounds) — verify Gemini handles within 1M context
- Gemini returns `REJECT` — verify skill presents to user instead of auto-fixing
- Gemini finds 0 new issues (common case) — verify clean `APPROVE` path
- Gemini structured output fails validation — verify Zod fallback extracts what it can
- `shared.mjs` extraction — verify `openai-audit.mjs` still works identically after refactor

### Regression check

After shared module extraction, run an existing plan audit and code audit through `openai-audit.mjs` to verify no behavioral changes.
