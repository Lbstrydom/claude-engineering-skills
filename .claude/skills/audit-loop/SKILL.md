---
name: audit-loop
description: |
  Self-driving plan-audit-fix loop using Claude for planning and GPT-5.4 for independent auditing.
  Claude and GPT-5.4 operate as PEERS — Claude can accept, partially accept, or challenge any finding.
  Challenged findings go through a deliberation round where GPT-5.4 can sustain, overrule, or compromise.
  Automates the full cycle: plan creation → GPT-5.4 audit → Claude deliberation → fix → re-audit → repeat.
  Triggers on: "audit loop", "plan and audit", "run the audit loop", "auto-audit",
  "plan-audit-fix loop", "iterate on the plan", "GPT audit".
  Usage: /audit-loop <task-description>           — Full cycle: plan + audit loop
  Usage: /audit-loop plan <plan-file>             — Audit an existing plan iteratively
  Usage: /audit-loop code <plan-file>             — Audit code against plan iteratively
  Usage: /audit-loop full <task-description>      — Plan + implement + audit code
---

# Self-Driving Plan-Audit-Deliberate-Fix Loop

You are orchestrating an automated quality loop. The user expects a **clear, structured experience**
with visible progress — not walls of raw JSON and scattered explanations.

**CRITICAL UX RULE**: After every phase, display a **status card** (the boxed format shown below).
The user should always know: what just happened, what was decided, what's next, and how long it will take.

**Input**: `$ARGUMENTS` — either a task description, or `plan|code|full <path>` for targeted modes.

---

## Step 0 — Parse Mode, Validate, and Show Kickoff Card

Determine the operating mode from `$ARGUMENTS`:

| Input Pattern | Mode | What Happens |
|---------------|------|-------------|
| `plan docs/plans/X.md` | PLAN_AUDIT | Audit existing plan iteratively |
| `code docs/plans/X.md` | CODE_AUDIT | Audit code against existing plan iteratively |
| `full <description>` | FULL_CYCLE | Plan → audit plan → implement → audit code |
| `<description>` (no keyword) | PLAN_CYCLE | Plan → audit plan → fix → repeat |

**Validate prerequisites**:
- For PLAN_AUDIT/CODE_AUDIT: verify the plan file exists
- Verify `OPENAI_API_KEY` is set (check with a quick node command)
- If missing, tell the user and stop

**Display kickoff card**:

```
═══════════════════════════════════════════════════════════
  AUDIT LOOP — Starting
  Plan: docs/plans/my-feature.md
  Mode: CODE AUDIT (multi-pass parallel)
  Estimated time: ~3-5 min per round (max 4 rounds)
═══════════════════════════════════════════════════════════
```

---

## Step 1 — Plan Generation (if needed)

Only for PLAN_CYCLE or FULL_CYCLE modes. Otherwise skip.

Generate the plan using `/plan-backend` or `/plan-frontend` patterns, save to `docs/plans/<name>.md`.

---

## Step 2 — Run GPT-5.4 Audit

Run the audit script and **show real-time pass progress** by reading stderr:

```bash
node scripts/openai-audit.mjs code <plan-file> --json 2>audit-stderr.log 1>audit-stdout.log
```

While waiting (or after completion), read `audit-stderr.log` and display:

```
⏳ Running GPT-5.4 audit (Round 1)...
  ✓ Structure     22s  (3 findings)
  ✓ Wiring        24s  (1 finding)
  ✓ Backend      173s  (8 findings)
  ✓ Frontend     104s  (5 findings)
  ✗ Sustainability  — timed out (will retry)
```

Parse the JSON output from `audit-stdout.log`.

### 2.1 Handle Failed Passes

If `_failed_passes` is non-empty, show clearly and offer options:

```
⚠️ 1 of 6 passes failed: be-services timed out (180s, 12 files)
   The other 5 passes produced 33 findings.

   A) Re-run failed pass with reasoning: medium (faster)
   B) Continue with partial results (33 findings is substantial)
   C) Split further and retry
```

Wait for user choice. Do NOT silently continue with 0 findings from a failed pass.

### 2.2 Show Audit Results Card

After parsing, show a clear summary — NOT raw JSON:

```
═══════════════════════════════════════════════════════════
  📋 GPT-5.4 AUDIT RESULTS — Round 1
═══════════════════════════════════════════════════════════
  Verdict: SIGNIFICANT_ISSUES
  Findings: 21 total
    🔴 HIGH:   6    (must fix)
    🟡 MEDIUM: 10   (should fix)
    ⚪ LOW:    5    (nice to fix)

  Quick-fix warnings: 3 (band-aids GPT flagged)
  Time: 5m 12s | Cost: ~$0.45

  Top findings:
    [H1] Missing auth middleware on /api/pairing-lab/chat
    [H2] No input validation on candidate_wines array
    [H3] Sensitive files not excluded from API context
    [M1] DRY violation — scoring logic in two places
    [M2] No loading state on recommendation panel
═══════════════════════════════════════════════════════════
```

---

## Step 3 — Claude Deliberation

**You are a peer, not a subordinate.** Review each finding using your codebase knowledge.

### 3.1 Check Convergence (Stability Algorithm)

Convergence requires BOTH a quality threshold AND stability:

**Quality threshold** (necessary):
- `highCount === 0`
- `mediumCount <= 2`
- `quickFixCount === 0`

**Stability check** (also necessary — fixes often introduce new issues):

Track across rounds:
- `previousFindingIds` — set of finding IDs from last round
- `newFindingsThisRound` — findings whose category+detail don't match any from previous round
- `consecutiveStableRounds` — counter, resets to 0 whenever new findings appear

```
Stability Rules:
  1. After EVERY fix round, a mandatory verification audit runs (even if threshold is met)
  2. If the verification audit finds NEW findings (not seen in prior rounds) → not stable, fix and re-audit
  3. Stability = quality threshold met for 2 consecutive rounds with zero new findings
  4. Maximum 6 rounds total (raised from 4 to allow stabilization)
  5. If round 6 reached without stability: present remaining findings to user
```

**How to detect "new" findings:**
Compare each finding's `category + section + detail` (normalized lowercase, trimmed) against all
findings from the previous round. If >70% of words overlap, it's the same finding (possibly
re-worded by GPT). If <70% overlap, it's genuinely new — likely caused by a fix.

**Convergence state tracking** (maintain across rounds):

```
Round 1: 7H 5M 1L (13 total)           → fix →
Round 2: 1H 3M 0L (4 total, 1 new)     → fix → [not stable: new finding]
Round 3: 0H 2M 1L (3 total, 0 new)     → threshold met, stable round 1 of 2
Round 4: 0H 1M 0L (1 total, 0 new)     → threshold met, stable round 2 of 2 → CONVERGED ✓
```

**Show stability in the round transition card:**

```
═══════════════════════════════════════════════════════════
  ROUND 3 → ROUND 4
═══════════════════════════════════════════════════════════
  HIGH:    0 ✓  |  MEDIUM: 2 (≤2 ✓)  |  LOW: 1
  Quick fixes: 0 ✓
  New findings this round: 0 ✓

  Stability: 1/2 consecutive clean rounds
  Need 1 more clean round to confirm stability...
═══════════════════════════════════════════════════════════
```

If max rounds reached without stability:

```
═══════════════════════════════════════════════════════════
  ⚠️ MAX ROUNDS REACHED (6) — Not fully stable
═══════════════════════════════════════════════════════════
  Quality threshold: MET (0H, 2M, 0 quick-fix)
  Stability: NOT MET (new findings still appearing)

  This suggests fixes are creating oscillating issues.

  Remaining findings (3):
    [M2] Input validation too strict — added in R4, relaxed in R5, re-flagged in R6
    [M5] Error message wording inconsistency
    [L1] Unused import from Round 3 fix

  Options:
    A) Accept current state — these are minor and non-blocking
    B) Run 1 more round with reasoning: low (faster stability check)
    C) Fix remaining items manually
═══════════════════════════════════════════════════════════
```

### 3.2 Form Your Position on Each Finding

For each finding, decide:
- **ACCEPT** — valid, will fix
- **PARTIAL ACCEPT** — problem real but severity wrong, or you have a better fix
- **CHALLENGE** — finding is wrong (cite specific evidence: file paths, CLAUDE.md, conventions)

### 3.3 Show Deliberation Card

```
═══════════════════════════════════════════════════════════
  🤔 CLAUDE DELIBERATION — Round 1
═══════════════════════════════════════════════════════════
  ✅ Accepted:    12 findings (will fix)
  🔄 Partial:     4 findings (better fix proposed)
  ❌ Challenged:  5 findings (cited evidence)

  Sending 9 contested findings to GPT-5.4 for resolution...
═══════════════════════════════════════════════════════════
```

### 3.4 Send Rebuttal (if any challenges/partials)

Write rebuttal to temp file, run:
```bash
node scripts/openai-audit.mjs rebuttal <plan-file> <rebuttal-file> --json
```

### 3.5 Show Resolution Card

```
═══════════════════════════════════════════════════════════
  ⚖️  GPT-5.4 RESOLUTION
═══════════════════════════════════════════════════════════
  🔴 Sustained (GPT holds):  2  — Claude must fix
  🟢 Overruled (Claude won):  2  — findings dismissed
  🟡 Compromise:               1  — modified recommendation

  Post-deliberation: 1 HIGH | 7 MEDIUM | 3 LOW | 2 dismissed
═══════════════════════════════════════════════════════════
```

---

## Step 4 — Fix All Surviving Findings

**ALL HIGH findings MUST be fixed.** MEDIUM findings are fixed until ≤2 remain.
LOW findings are fixed if easy (mechanical), otherwise left for the user.

### 4.1 Fix and Show Every Change

For EACH fix, show what you did in a compact format:

```
═══════════════════════════════════════════════════════════
  🔧 FIXING — 17 findings to address
═══════════════════════════════════════════════════════════

  Auto-fixed (mechanical):
    ✓ [H3] Added SENSITIVE_PATTERNS filter to readFilesAsContext()
         → scripts/openai-audit.mjs lines 371-385
    ✓ [M6] Fixed MAX_OUTPUT_TOKENS → MAX_OUTPUT_TOKENS_CAP
         → scripts/openai-audit.mjs line 459
    ✓ [L2] Removed console.log from production code
         → src/services/pairing/pairingLab.js line 42

  Fixed per recommendation:
    ✓ [H1] Added requireCellarEdit middleware to POST /chat
         → src/routes/pairingLab.js line 18
    ✓ [H2] Added Zod validation for candidate_wines array
         → src/schemas/pairingLab.js (new schema)
    ✓ [M1] Extracted shared scoring to wineStyleMatcher.js
         → src/services/shared/wineStyleMatcher.js
    ✓ [M2] Added loading skeleton to recommendation panel
         → public/js/pairingLab/results.js

  Compromises applied:
    ✓ [M5] Added retry with backoff (GPT wanted circuit breaker,
         Claude proposed simpler retry — compromised on 3 retries)
         → src/services/pairing/pairingLab.js lines 55-72

  Skipped (LOW, non-critical):
    · [L1] Naming inconsistency in CSS — cosmetic only
    · [L3] TODO comment in test — tracked in backlog
═══════════════════════════════════════════════════════════
```

### 4.2 Ask User Only for Genuine Decisions

If any findings require a design choice between valid alternatives, batch them:

```
  ⚠️  2 items need your decision:

  A) [M8] Transaction wrapping on batch update
     → GPT: Add BEGIN/COMMIT/ROLLBACK (data integrity)
     → Claude: Low-risk operation, adds 15ms latency
     → Which approach?

  B) [M9] Split pairingLab.js (380 lines)
     → GPT: Extract photo parsing into separate module
     → Claude: Agree, but keep in same directory
     → Proceed with split?
```

Wait for response. Apply choices. Then continue.

---

## Step 5 — Mandatory Verification Audit + Loop

**CRITICAL**: After every fix round, ALWAYS re-audit — even if the threshold appears met.
Fixes frequently introduce new issues. Skipping verification is the #1 cause of
"it passed audit but broke in production."

### 5.1 Re-run Audit (Verification)

Go back to Step 2. Run the full audit again on the now-modified codebase.

### 5.2 Detect New Findings (Fix Regression Check)

After parsing the new round's results, compare against the previous round:

For each finding in this round, check if it existed in the prior round:
- **Same finding** = category + section overlap >70% of words (GPT may re-word slightly)
- **New finding** = <70% overlap — this was likely CAUSED by a fix

Track:
- `newFindingCount` — findings that didn't exist last round
- `resolvedFindingCount` — findings from last round that are now gone
- `recurringFindingCount` — findings that persist across rounds

### 5.3 Show Round Transition Card (with Stability)

```
═══════════════════════════════════════════════════════════
  ROUND 2 → ROUND 3 (Verification)
═══════════════════════════════════════════════════════════
  HIGH:    1 → 0  ✓
  MEDIUM:  3 → 2  ✓ (target: ≤2)
  LOW:     2 → 1
  Quick fixes: 0  ✓

  Finding churn:
    Resolved: 3 (fixed successfully)
    Recurring: 2 (persisted, minor)
    ⚠️ New: 1 (introduced by Round 2 fixes!)
      → [M8] Missing null check in retry logic (added in R2 fix for M5)

  Stability: 0/2 — new findings appeared, resetting counter
  Files changed this round: 4
  Fixing new finding, then re-auditing...
═══════════════════════════════════════════════════════════
```

### 5.4 Stability Decision

| Condition | Action |
|-----------|--------|
| Threshold NOT met | Fix findings → re-audit (back to Step 3) |
| Threshold met BUT new findings appeared | Fix new findings → re-audit (stability counter resets to 0) |
| Threshold met AND 0 new findings (stable round 1/2) | Re-audit one more time (mandatory second stable round) |
| Threshold met AND 0 new findings for 2 consecutive rounds | **CONVERGED** → Step 6 |
| Round 6 reached without stability | Present to user with options (Step 6 fallback) |

---

## Step 6 — Convergence: Show Final Report

When converged (or max rounds reached):

```
═══════════════════════════════════════════════════════════
  ✅ CONVERGED — Round 4 (stable for 2 consecutive rounds)
═══════════════════════════════════════════════════════════
  Final: 0 HIGH | 2 MEDIUM | 1 LOW
  Rounds: 4 (2 fix + 2 verification) | Total time: 14m 18s | Cost: ~$1.20

  Stability journey:
    R1: 13 findings → fixed 10 → R2: 4 findings (1 new from fixes!)
    R2: fixed 2 → R3: 3 findings (0 new ✓, stable 1/2)
    R3: no fixes needed → R4: 3 findings (0 new ✓, stable 2/2) → CONVERGED

  Deliberation stats:
    Challenged: 6 | Sustained: 2 | Overruled: 2 | Compromise: 2
    Claude win rate: 67% (4/6 challenges accepted or compromised)

  Fix regressions caught: 1
    → [M8] Missing null check in retry logic (caused by R1 fix for M5)

  Files changed:
    ✓ scripts/openai-audit.mjs (security fix, constant fix)
    ✓ src/routes/pairingLab.js (auth, validation)
    ✓ src/services/pairing/pairingLab.js (retry, split, null check)
    ✓ src/schemas/pairingLab.js (new validation)
    ✓ public/js/pairingLab/results.js (loading state)
    ✓ tests/unit/services/pairing/pairingLab.test.js (new)

  Remaining (accepted, non-blocking):
    [M3] CSS naming inconsistency — cosmetic
    [M7] Missing JSDoc on 2 helpers — hygiene

  📄 Full report: docs/plans/<name>-audit-summary.md
═══════════════════════════════════════════════════════════
```

**Save the full report** to `docs/plans/<name>-audit-summary.md` with:
- Round-by-round progress table
- All deliberation outcomes
- Files changed with line-level detail
- Remaining items and why they were accepted
- Total cost and timing

---

## Step 7 — Transition to Code Audit (FULL_CYCLE only)

After plan audit converges:
1. Show: "Plan approved. Starting implementation..."
2. Implement the plan
3. Show: "Implementation complete. Starting code audit loop..."
4. Run Steps 2-6 with CODE_AUDIT mode

---

## UX Rules (MANDATORY)

1. **Status cards after EVERY phase** — use the boxed `═══` format shown above
2. **Never dump raw JSON** — always parse and present structured summaries
3. **Show every fix** — the user must see what changed, in which file, and why
4. **Time estimates** — show estimated time at the start of each phase
5. **Cost tracking** — calculate approximate cost from token usage and show it
6. **One question batch** — collect ALL user decisions into one prompt, not multiple
7. **Files changed summary** — always list modified files at convergence
8. **No silent fixes** — even auto-fixes must be listed (just don't ask permission)
9. **Progress indicators** — show ⏳ before long operations, ✓/✗ after each pass
10. **Round transitions** — clear before/after comparison at each round boundary

## Cost Estimation

Approximate costs (GPT-5.4, March 2026):
- Input: ~$2.50 / 1M tokens
- Output: ~$10.00 / 1M tokens
- Formula: `cost ≈ (input_tokens × 2.5 + output_tokens × 10) / 1_000_000`
- Show as: `Cost: ~$X.XX` after each audit pass

---

## Key Principles

1. **Peer Relationship**: Claude and GPT-5.4 are equals. Neither blindly defers.
2. **Fix Everything That Survived**: ALL HIGH must be fixed. MEDIUM until ≤2. LOW optional.
3. **Show Your Work**: Every fix is visible. Every decision is transparent.
4. **Respect the User's Time**: Batch decisions. Show progress. Give estimates.
5. **No Quick Fixes**: Band-aids are rejected by both models.
6. **Deliberation Is Final**: GPT's ruling on a challenge is accepted. No infinite debate.
7. **Graceful Degradation**: Failed passes don't crash — offer recovery options.

---

## Compatibility

This skill works identically in:
- **Claude Code CLI** (terminal)
- **Claude Code in VS Code** (integrated terminal)
- **Any Claude Code environment** that has access to `node` and `OPENAI_API_KEY`
