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

You are orchestrating an automated quality loop that uses **Claude** (you) for planning, deliberation,
and fixing, and **GPT-5.4** as an independent auditor. The two models operate as **peers** — neither
blindly defers to the other. The loop runs until the quality threshold is met, only asking the user
questions when genuinely ambiguous decisions arise.

**Input**: `$ARGUMENTS` — either a task description, or `plan|code|full <path>` for targeted modes.

---

## Step 0 — Parse Mode and Validate

Determine the operating mode from `$ARGUMENTS`:

| Input Pattern | Mode | What Happens |
|---------------|------|-------------|
| `plan docs/plans/X.md` | PLAN_AUDIT | Audit existing plan iteratively |
| `code docs/plans/X.md` | CODE_AUDIT | Audit code against existing plan iteratively |
| `full <description>` | FULL_CYCLE | Plan → audit plan → implement → audit code |
| `<description>` (no keyword) | PLAN_CYCLE | Plan → audit plan → fix → repeat |

**Validate prerequisites**:
- For PLAN_AUDIT/CODE_AUDIT: verify the plan file exists
- For all modes: verify `OPENAI_API_KEY` is set (check with `echo $OPENAI_API_KEY | head -c 5`)
- If OPENAI_API_KEY is missing, tell the user and stop

---

## Step 1 — Plan Generation (if needed)

If mode requires plan generation (PLAN_CYCLE or FULL_CYCLE):

1. **Determine plan type** — Analyse the task description:
   - If it involves routes, services, DB, API → backend plan
   - If it involves UI, components, modals, UX → frontend plan
   - If both → create BOTH plans (backend first, then frontend referencing it)

2. **Generate the plan** using the same approach as `/plan-backend` or `/plan-frontend`:
   - Phase 1: Explore existing codebase thoroughly
   - Phase 2: Apply all engineering principles
   - Phase 3: Assess long-term sustainability
   - Phase 4: Write detailed file-level plan
   - Phase 5: Save to `docs/plans/<name>.md`

3. **Record the plan path** for the audit loop

---

## Step 2 — GPT-5.4 Audit (The Independent Reviewer)

Run the OpenAI audit script:

```bash
node scripts/openai-audit.mjs plan <plan-file> --json 2>&1
```

Or for code audits:
```bash
node scripts/openai-audit.mjs code <plan-file> --json 2>&1
```

**Parse the JSON output** and extract:
- `verdict` — READY_TO_IMPLEMENT / NEEDS_REVISION / SIGNIFICANT_GAPS (plan) or PASS / NEEDS_FIXES / SIGNIFICANT_ISSUES (code)
- `findings` — array of {id, severity, category, detail, recommendation, is_quick_fix, principle}
- `quick_fix_warnings` — items where band-aids were proposed instead of proper fixes
- `ambiguities` — vague language that needs clarification (plan mode only)

**IMPORTANT**: Also save the human-readable report:
```bash
node scripts/openai-audit.mjs plan <plan-file> > docs/plans/<name>-gpt-audit-round-N.md 2>&1
```

### 2.1 Handle Failed Passes (Adaptive Recovery)

After parsing the JSON, check `_failed_passes`. If any passes failed:

1. **Identify what failed and why** — the `_failed_passes` array contains error messages
2. **Tell the user clearly** what happened, how many findings were still produced, and offer options:

```
⚠️ 1 of 6 audit passes failed: be-services timed out (180s, 12 service files)

The other 5 passes produced 33 findings. Your options:

A) Re-run failed pass with reasoning: medium (faster, ~60% of depth)
B) Continue with partial results (33 findings is still substantial)
C) Split the failed pass further and retry
```

3. **If user picks A**: Re-run just the failed scope by calling the script again with
   `OPENAI_AUDIT_REASONING=medium` as env prefix, or adjust the pass manually.
4. **If user picks B**: Continue to deliberation with the findings you have.
   Note in the final report that coverage is partial.
5. **If user picks C**: You (Claude) can manually read the service files and
   split them into two groups, then call the script twice with smaller scopes.

**Do NOT silently continue with 0 findings from failed passes** — the user should know.

---

## Step 3 — Claude Deliberation (CRITICAL — You Are a Peer, Not a Subordinate)

**This is the most important step.** You do NOT blindly accept GPT-5.4's findings.
You are an expert engineer with deep codebase context. For EACH finding, you must form
your own independent assessment.

### 3.1 Convergence Check (First)

Count findings by severity:
- `highCount` = findings where severity === 'HIGH'
- `mediumCount` = findings where severity === 'MEDIUM'
- `quickFixCount` = findings where is_quick_fix === true

**Quality threshold** (loop stops when ALL conditions met):
- `highCount === 0` — NO high-severity findings remaining
- `mediumCount <= 2` — At most 2 medium findings (diminishing returns beyond this)
- `quickFixCount === 0` — No quick fix warnings (all solutions must be sustainable)

If already converged, skip to Step 6.

**Maximum iterations**: 4 rounds. If threshold not met after 4 rounds, present remaining
findings to the user and ask which to address.

### 3.2 Deliberate on Each Finding

For EACH finding from GPT-5.4, form a position:

#### ACCEPT — You agree fully
The finding is valid, the severity is correct, and the recommendation is good.
→ Mark as `accept`. Will be fixed in Step 4.

#### PARTIAL ACCEPT — The problem is real but...
You agree there is an issue, BUT:
- The severity is wrong (e.g., GPT said HIGH, you think MEDIUM because of project-specific context)
- The recommendation is a quick fix — you have a better sustainable solution
- The scope is wrong (e.g., GPT flagged one place but the pattern exists project-wide)
→ Mark as `partial_accept`. Provide your alternative severity and/or recommendation with reasoning.

#### CHALLENGE — You disagree
The finding is wrong because:
- GPT misunderstood a project convention (e.g., this IS the established pattern in CLAUDE.md)
- The codebase context makes this a non-issue (e.g., the "missing validation" is handled upstream)
- The recommendation would break something GPT doesn't know about
- The finding contradicts an intentional design decision documented in the plan
→ Mark as `challenge`. Provide your counter-argument with specific evidence (file paths, code, conventions).

### 3.3 Build the Rebuttal Document

Create a structured rebuttal as a temp file:

```markdown
# Claude Deliberation on GPT-5.4 Audit (Round N)

## Accepted Findings (no challenge)
- H1: Accepted — will fix as recommended
- M2: Accepted — valid concern
- L1: Accepted — minor cleanup

## Partially Accepted Findings

### [H3] DRY Violation: src/services/pairing.js
- **GPT says**: HIGH — duplicated scoring logic across pairingEngine and manualPairing
- **Claude says**: MEDIUM — the duplication is intentional per CLAUDE.md (pairingEngine re-exports
  matchWineToStyle for backward compatibility). The real fix is to extract the 3 lines of shared
  scoring into a helper in shared/wineStyleMatcher.js, NOT to merge the modules.
- **Position**: partial_accept
- **Alternative recommendation**: Extract shared scoring helper to wineStyleMatcher.js. Do NOT
  merge pairingEngine and manualPairing — they have different consumers and lifecycle.

## Challenged Findings

### [H2] Security: Missing cellar_id on /api/profile/api-keys
- **GPT says**: HIGH — query missing cellar_id scope
- **Claude says**: WRONG — /api/profile/api-keys is intentionally auth-only, NOT cellar-scoped.
  API keys belong to the USER, not the cellar. See CLAUDE.md: "auth-only, NOT cellar-scoped".
  The route uses req.user.id, not req.cellarId, by design.
- **Position**: challenge
- **Evidence**: CLAUDE.md line "apiKeys.js — /api/profile/api-keys/* endpoints (user API key
  storage, auth-only, not cellar-scoped)"

### [M5] Performance: Unbounded query in stats endpoint
- **GPT says**: MEDIUM — SELECT without LIMIT
- **Claude says**: This endpoint is called once per cellar load and returns a single aggregate row.
  Adding LIMIT 1 is meaningless on an aggregate query. The real concern (if any) is the aggregation
  cost, not the LIMIT.
- **Position**: challenge
- **Evidence**: The query is `SELECT COUNT(*) ... GROUP BY cellar_id` — inherently bounded by the
  WHERE clause.
```

Save this to a temp file: `docs/plans/<name>-claude-rebuttal-round-N.md`

### 3.4 Send Rebuttal to GPT-5.4

If there are ANY `partial_accept` or `challenge` findings, run the deliberation:

```bash
node scripts/openai-audit.mjs rebuttal <plan-file> docs/plans/<name>-claude-rebuttal-round-N.md --json 2>&1
```

GPT-5.4 will return a resolution for each contested finding:
- **sustain** — GPT holds its position (Claude must fix it)
- **overrule** — GPT agrees with Claude (finding dismissed or severity reduced)
- **compromise** — Modified position (both sides adjust)

### 3.5 Build the Final Finding List

Merge the deliberation results:

| Source | What Happens |
|--------|-------------|
| Claude **accepted** | Fix per GPT's original recommendation |
| GPT **sustained** Claude's challenge | Fix per GPT's recommendation (GPT won this one) |
| GPT **overruled** (Claude was right) | Finding dismissed or severity reduced — no fix needed |
| GPT **compromised** | Fix per the compromise recommendation |
| Claude **partial_accept** + GPT sustained | Fix per GPT's recommendation but at Claude's severity |
| Claude **partial_accept** + GPT compromised | Fix per compromise recommendation |

**IMPORTANT**: If GPT sustains a finding that Claude challenged, Claude MUST respect the ruling
and fix it. The deliberation is the final word — no infinite back-and-forth.

---

## Step 4 — Fix Findings (Post-Deliberation)

Now fix only the findings that survived deliberation.

### 4.1 Apply Auto-Fixes

Fix all auto-fixable findings directly in the plan or code. Track what you fixed.
Auto-fixable = mechanical corrections where there is exactly one correct fix:
Missing async/await, missing cellar_id, raw fetch, dead code removal, missing JSDoc, ||→??, CSP violations.

### 4.2 Apply Accepted + Sustained Recommendations

For each finding that Claude accepted or GPT sustained:
- Apply the fix to the plan or code
- Ensure the fix is SUSTAINABLE — not a band-aid

### 4.3 Apply Compromises

For each compromise resolution:
- Apply the compromise recommendation
- If the compromise still feels like a quick fix, escalate to the user

### 4.4 Replace Quick Fixes

For any finding where the final recommendation has `is_quick_fix === true`:
- Do NOT apply it as-is
- Devise a proper sustainable fix that addresses the root cause

### 4.5 Batch Design Decisions

Collect all findings that require user input into a single numbered list:

```
GPT-5.4 Audit Round 2 — Deliberation complete. 3 items need your decision:

A) [H2] Architecture: Missing transaction wrapping on batch update
   → GPT recommended: Add BEGIN/COMMIT/ROLLBACK with retry
   → Claude challenged: Low-risk operation, transactions add latency
   → GPT sustained: Data integrity outweighs latency concern
   → Your call: Add transactions or accept the risk?

B) [M1] Sustainability: Function exceeds 50 lines
   → GPT + Claude compromised: Split data-fetching from rendering, keep core logic linear
   → Want to proceed with this approach?

C) [M3] UX: No empty state for wine list
   → Show illustration + "Add your first wine" CTA vs show nothing
   → Preference?
```

Wait for the user's response. Apply their choices.

---

## Step 5 — Loop Back to Step 2

After applying all fixes:
1. If plan mode: re-run `node scripts/openai-audit.mjs plan <plan-file> --json`
2. If code mode: re-run `node scripts/openai-audit.mjs code <plan-file> --json`
3. Save the new report as `docs/plans/<name>-gpt-audit-round-N.md`
4. Return to Step 3 (deliberation)

### Loop Status Display

After each round, display a clear status:

```
═══════════════════════════════════════════════════════════
  AUDIT LOOP — Round 2 of 4 (max)
═══════════════════════════════════════════════════════════
  Verdict:  NEEDS_REVISION → NEEDS_REVISION
  HIGH:     5 → 1  (3 fixed, 1 overruled by Claude)
  MEDIUM:   8 → 3  (4 fixed, 1 compromised)
  LOW:      4 → 2  (2 fixed)
  Quick Fix Warnings: 2 → 0

  Deliberation: 2 challenged → 1 sustained, 1 overruled
  Claude win rate: 50% (1 of 2 challenges accepted by GPT)

  Status: NOT CONVERGED — 1 HIGH remaining (GPT sustained)
  Action: Fixing sustained findings...
═══════════════════════════════════════════════════════════
```

---

## Step 6 — Final Report

When the loop converges (or max iterations reached):

1. **Generate summary report** saved to `docs/plans/<name>-audit-summary.md`:

```markdown
# Audit Loop Summary: <Plan Name>
- **Rounds**: N
- **Final Verdict**: READY_TO_IMPLEMENT / PASS
- **Model**: GPT-5.4 (reasoning: high)
- **Total findings processed**: X
  - Accepted by Claude: Y
  - Challenged by Claude: Z
  - GPT sustained (Claude fixed): A
  - GPT overruled (Claude was right): B
  - Compromises reached: C
  - User decisions: D
  - Quick fixes replaced: E

## Round-by-Round Progress
| Round | HIGH | MEDIUM | LOW | Challenged | Sustained | Overruled | Compromised | Verdict |
|-------|------|--------|-----|------------|-----------|-----------|-------------|---------|
| 1     | 5    | 8      | 4   | 3          | 1         | 1         | 1           | SIGNIFICANT_GAPS |
| 2     | 1    | 3      | 2   | 1          | 1         | 0         | 0           | NEEDS_REVISION |
| 3     | 0    | 1      | 1   | 0          | 0         | 0         | 0           | READY_TO_IMPLEMENT |

## Key Deliberation Outcomes
- [H2] Claude challenged "missing cellar_id on api-keys" → GPT overruled (auth-only by design)
- [H3] Claude partial-accepted "DRY violation" → Compromise: extract to shared helper, keep modules separate
- [M5] Claude challenged "unbounded query" → GPT sustained (added LIMIT for defence-in-depth)

## Remaining Items (if any)
- [L1] Minor naming inconsistency — accepted as-is
```

2. **If FULL_CYCLE mode**: After plan audit converges, proceed to implementation,
   then start the code audit loop (Steps 2-5 with `code` mode).

---

## Step 7 — Transition to Code Audit (FULL_CYCLE only)

After implementation is complete:

1. Tell the user: "Plan is approved. Implementation complete. Starting code audit loop..."
2. Run `node scripts/openai-audit.mjs code <plan-file> --json`
3. Follow Steps 2-6 with CODE_AUDIT mode
4. The code audit loop has the same convergence criteria, deliberation, and max iterations

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENAI_API_KEY` | (required) | GPT-5.4 API key |
| `OPENAI_AUDIT_MODEL` | `gpt-5.4` | Model to use for auditing |
| `OPENAI_AUDIT_REASONING` | `high` | Reasoning effort (high/xhigh) |
| `OPENAI_AUDIT_MAX_TOKENS` | `16000` | Max output tokens |
| `OPENAI_AUDIT_TIMEOUT_MS` | `120000` | Timeout in ms |

---

## Key Principles

1. **Peer Relationship**: Claude and GPT-5.4 are equals. Neither blindly defers.
2. **Claude has codebase context**: Claude's deep knowledge of project conventions, patterns,
   and CLAUDE.md gives it legitimate authority to challenge GPT-5.4's findings.
3. **GPT-5.4 has fresh eyes**: GPT-5.4's outsider perspective catches blind spots that Claude
   might miss due to familiarity bias.
4. **Deliberation is final**: Once GPT-5.4 rules on a challenge (sustain/overrule/compromise),
   that ruling is accepted. No infinite debate.
5. **No Quick Fixes**: Every fix must be sustainable. Band-aids are rejected by either model.
6. **Convergence**: The loop has a clear stopping condition and a maximum iteration cap.
7. **Minimal Interruption**: Only ask the user about genuinely ambiguous design decisions.
8. **Transparency**: Every round's audit, rebuttal, and resolution is saved.
9. **Both Phases**: Plan quality AND code quality are audited with the same rigour.

---

## Compatibility

This skill works identically in:
- **Claude Code CLI** (terminal)
- **Claude Code in VS Code** (integrated terminal)
- **Any Claude Code environment** that has access to `node` and `OPENAI_API_KEY`

The `scripts/openai-audit.mjs` script is a standalone Node.js module that uses the same
OpenAI SDK (`openai@6.17.0`) already in the project's dependencies.
