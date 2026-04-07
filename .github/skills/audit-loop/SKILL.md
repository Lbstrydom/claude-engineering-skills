---
name: audit-loop
description: |
  Self-driving plan-audit-fix loop with adaptive learning.
  Three-model system: Claude (author) + GPT-5.4 (auditor) + Gemini 3.1 Pro (final arbiter).
  Features: R2+ suppression via adjudication ledger, map-reduce for large codebases,
  repo-aware prompt tuning, cloud learning store (Supabase), Thompson Sampling prompt selection.
  Triggers on: "audit loop", "plan and audit", "run the audit loop", "auto-audit",
  "plan-audit-fix loop", "iterate on the plan", "GPT audit".
  Usage: /audit-loop <task-description>           — Full cycle: plan + audit loop
  Usage: /audit-loop plan <plan-file>             — Audit an existing plan iteratively
  Usage: /audit-loop code <plan-file>             — Audit code against plan iteratively
  Usage: /audit-loop full <task-description>      — Plan + implement + audit code
---

# Self-Driving Audit Loop

Orchestrate an automated plan-audit-fix quality loop with adaptive learning.

**Input**: `$ARGUMENTS` — task description or `plan|code|full <path>`.

---

## Step 0 — Parse Mode and Validate

| Input | Mode |
|-------|------|
| `plan docs/plans/X.md` | PLAN_AUDIT — audit plan iteratively |
| `code docs/plans/X.md` | CODE_AUDIT — audit code against plan |
| `full <description>` | FULL_CYCLE — plan → audit → implement → audit code |
| `<description>` | PLAN_CYCLE — plan → audit → fix → repeat |

Validate: plan file exists (if applicable), `OPENAI_API_KEY` is set.
Optional: `GEMINI_API_KEY` for final review (Step 7). `SUPABASE_AUDIT_URL` for cloud learning.

Initialize session ID: `SID=audit-$(date +%s)`

Show kickoff card:
```
═══════════════════════════════════════
  AUDIT LOOP — [MODE] — Starting
  Plan: <path> | Max 6 rounds | SID: $SID
═══════════════════════════════════════
```

---

## Step 1 — Plan Generation (PLAN_CYCLE / FULL_CYCLE only)

Generate plan with `/plan-backend` or `/plan-frontend`, save to `docs/plans/<name>.md`. Skip otherwise.

---

## Step 2 — Run GPT-5.4 Audit

### Audit Scope — Choose Deliberately

**CRITICAL**: Code audits see whatever files you give them. GPT-5.4 doesn't know what's "new" vs pre-existing — it flags everything. To get signal, scope deliberately:

| Scope mode | When to use | Behavior |
|---|---|---|
| `--scope diff` (**DEFAULT**) | "audit my recent work", "/audit-loop my PR", after implementing a phase/feature | Auto-scopes to `git diff HEAD~1..HEAD` + unstaged + untracked files. Findings focus on YOUR changes. |
| `--scope plan` | Plan describes a large refactor touching many files; user wants broad view | All files referenced in the plan (legacy behavior). |
| `--scope full` | "audit the entire codebase", user explicitly asks for a codebase-wide review | Full repo audit — slowest, catches cross-cutting issues. |

**Default is `--scope diff`**. If the user says "audit my work" / "audit this feature" / "audit this phase" → default applies.
Only switch to `--scope plan` or `--scope full` when the user EXPLICITLY asks for broader scope, or when `git diff` is empty (no recent changes).

**Why this matters**: Without scoping, auditing Phase A's ~150-line diff produces 28 findings about files Phase A barely touched. With `--scope diff`, you get findings about the actual changes. This is the #1 source of false-positive noise.

### Excluding Files from Scope

When `--scope diff` picks up vendored, upstream, or irrelevant files, use:

**CLI flag**: `--exclude-paths 'scripts/**,vendor/**,.audit-loop/**'` (comma-separated globs)

**`.auditignore` file** (in repo root): one glob pattern per line, `#` comments.
```
# Vendored audit-loop scripts — not our code
scripts/openai-audit.mjs
scripts/gemini-review.mjs
scripts/lib/**

# Build artifacts
dist/**
```

Both mechanisms stack. `.auditignore` is read automatically; `--exclude-paths` is additive.

### Single Entry Point (Full Loop)

For end-to-end orchestration without AI skill orchestrators:
```bash
node scripts/audit-loop.mjs code <plan-file>                     # Full loop: audit → report
node scripts/audit-loop.mjs code <plan-file> --max-rounds 3      # Limit rounds
node scripts/audit-loop.mjs code <plan-file> --exclude-paths 'scripts/**'
node scripts/audit-loop.mjs code <plan-file> --skip-gemini       # Skip Step 7
```
Artifacts land in `.audit/` (persistent across sessions).

### Round 1 — Audit (scope-aware)

```bash
# Default: audit only recent changes (preferred)
node scripts/openai-audit.mjs code <plan-file> \
  --out .audit/$SID-r1-result.json \
  2>.audit/$SID-r1-stderr.log

# Broader scope examples (only when user asks):
# --scope plan    → all plan-referenced files
# --scope full    → entire repo
# --base main     → diff against main instead of HEAD~1
# --exclude-paths 'scripts/**'  → exclude vendored files from scope
```

### Phase 0 — Tool Pre-Pass (Phase C)

Before GPT runs, the script executes language-appropriate static analysis tools
(ESLint for JS/TS, `tsc --noEmit` for TS, `ruff` for Python, falling back to
`flake8`). Tool findings carry a `classification` envelope with
`sourceKind: 'LINTER' | 'TYPE_CHECKER'` and are appended to `findings[]` with
`T`-prefixed IDs (`T1`, `T2`, ...).

| Flag | Default | Effect |
|------|---------|--------|
| `--no-tools` | off | Skip Phase 0 entirely. Use for untrusted repos — ESLint configs can `require()` arbitrary code. |
| `--strict-lint` | off (advisory) | Count tool findings in verdict math. Without this flag, tool findings are surfaced but don't affect PASS/NEEDS_FIXES/SIGNIFICANT_ISSUES. |

**Trust boundary**: running repo-configured linters executes code the repo
owner controls, equivalent to running `npm test`. Every invocation is logged
to stderr. See [scripts/lib/linter.mjs](scripts/lib/linter.mjs) for full
security notes.

**Advisory-by-default rationale**: tool availability varies across machines
(no `npx eslint` on a Python-only box). Counting tool findings in the verdict
would make it non-reproducible. Opt in with `--strict-lint` when your CI
environment has all the tools.

The result JSON includes `_toolCapability: { toolsAvailable, toolsFailed, strictLint, disabled }`
so orchestrators can see which tools ran.

### Round 2+ — R2+ mode with ledger, diff, and changed files

```bash
# Generate diff from fixes
git diff HEAD~1 -- . > /tmp/$SID-diff.patch

# Build changed + files lists from Step 4 fix list
CHANGED="scripts/shared.mjs,scripts/openai-audit.mjs"
FILES="$CHANGED,scripts/gemini-review.mjs"  # changed + dependents

# Determine passes
PASSES="sustainability"  # always include
# Add backend if any backend file changed, frontend if frontend changed, etc.

node scripts/openai-audit.mjs code <plan-file> \
  --round 2 \
  --ledger /tmp/$SID-ledger.json \
  --diff /tmp/$SID-diff.patch \
  --changed $CHANGED \
  --files $FILES \
  --passes $PASSES \
  --out /tmp/$SID-r2-result.json \
  2>/tmp/$SID-r2-stderr.log
```

### CLI Flag Contract

| Flag | Source | Purpose |
|------|--------|---------|
| `--round <n>` | Orchestrator | Triggers R2+ mode (rulings, suppression, annotations) |
| `--ledger <path>` | Step 3.5 output | Adjudication ledger for rulings injection + suppression |
| `--diff <path>` | `git diff` output | Line-level change annotations in code context |
| `--changed <list>` | Step 4 fix list | **Authoritative** source for what was modified (reopen detection) |
| `--files <list>` | changed + dependents | Audit scope — what GPT sees in context |
| `--passes <list>` | Smart selection | Which passes to run |

### Smart Pass Selection (Round 2+)

| Pass | When to skip on R2+ |
|------|-------------------|
| `structure` | Skip ONLY if zero file additions/deletions/renames in the diff. Re-run if fixes created or deleted files. |
| `wiring` | Skip unless a route or API file was changed |
| `backend` | Run if any backend file changed |
| `frontend` | Run if any frontend file changed |
| `sustainability` | Always run (cross-cutting) |

### R2+ Automatic Behavior

When `--round >= 2`, the script automatically:
1. **Loads ledger** → injects GPT's own prior rulings into system prompts
2. **Parses diff** → annotates changed lines with `// ── CHANGED ──` markers
3. **Computes impact set** → changed files + files that import from them
4. **Uses R2+ prompts** → "verify fixes + check regressions" instead of "find all issues"
5. **Post-output suppression** → fuzzy-matches findings against ledger, suppresses re-raises of dismissed items
6. **FP tracker** → auto-suppresses finding patterns with historically high dismiss rates

### Handle Results

Read stderr for pass timings and suppression stats:
```bash
cat /tmp/$SID-r1-stderr.log
```

Read result JSON:
```bash
cat /tmp/$SID-r1-result.json
```

If `verdict` is `INCOMPLETE` (passes timed out), offer: re-run with higher timeout, or continue with partial results.

### Show Results

```
═══════════════════════════════════════
  ROUND 1 AUDIT — SIGNIFICANT_ISSUES
  H:6 M:10 L:5 | Deduped: 3 | Cost: ~$0.45
  Top: [H1] Missing auth on /api/...
═══════════════════════════════════════
```

---

## Step 3 — Triage (validity × scope × action)

**You are a peer, not a subordinate.** For each finding, record three orthogonal judgments:

| Dimension | Values | Meaning |
|---|---|---|
| **validity** | `valid` \| `invalid` \| `uncertain` | Is the concern real? |
| **scope** | `in-scope` \| `out-of-scope` | Does it cite code this audit targeted? |
| **action** | `fix-now` \| `defer` \| `dismiss` \| `rebut` | What happens next? |

### Triage Rules

- `validity=invalid` → action MUST be `dismiss` or `rebut` (can't defer a wrong finding)
- `validity=uncertain` → action MUST be `rebut` (send to GPT deliberation)
- `validity=valid` + `scope=in-scope` + HIGH/MEDIUM → action MUST be `fix-now` (unless `accepted-permanent` debt with approver)
- `validity=valid` + `scope=out-of-scope` → action = `defer` is eligible (pre-existing debt)
- `validity=valid` + `scope=in-scope` + LOW → operator choice
- Only `validity=valid` findings can be deferred to the debt ledger

Scope hint: look at the finding's cited files vs `--changed`/`--scope diff`. A
finding that points at code your PR didn't touch is `out-of-scope` by definition.

### Finding Classification (existing)

Each finding has `is_mechanical: true/false` set by GPT:
- **Mechanical** (`is_mechanical: true`): deterministic fix. Fix immediately, no deliberation needed.
- **Architectural** (`is_mechanical: false`): judgment call. Needs deliberation, resets stability if new.

### Tiered Rebuttal (when action=rebut)

| Finding Severity | Deliberation |
|-----------------|-------------|
| **HIGH** rebut | ALWAYS send to GPT deliberation |
| **MEDIUM** rebut | ALWAYS send to GPT deliberation |
| **LOW** rebut | Claude decides locally |

Only send rebuttal if there are rebut HIGH or MEDIUM findings:
```bash
node scripts/openai-audit.mjs rebuttal <plan-file> <rebuttal-file> \
  --out /tmp/$SID-resolution.json 2>/tmp/$SID-rebuttal-stderr.log
```

### Convergence

Quality threshold: `HIGH == 0 && MEDIUM <= 2 && quickFix == 0`

Stability uses `_hash` for exact cross-round matching:
- New hash not in prior set = genuinely new → resets stability
- Mechanical-only findings do NOT require stability rounds

| Condition | Action |
|-----------|--------|
| Threshold NOT met | Fix → re-audit |
| Threshold met, new architectural | Fix → re-audit (stability resets) |
| Threshold met, mechanical only | Fix → re-audit (stability NOT reset) |
| Threshold met, 0 new, 2/2 stable | **CONVERGED** → Step 6, then REQUIRED Step 7 |
| Round 6, not stable | Present to user, then REQUIRED Step 7 |

Max 6 rounds for CODE audits.

### PLAN audits: Early-Stop on Rigor Pressure

**Plan audits have infinite refinement surface.** Unlike code (which has objective correctness), a plan can always be made "more rigorous". GPT-5.4 is trained to keep finding issues — after round 2-3, findings shift from "real design bugs" to "push for more rigor" (parser-based analysis instead of regex, full v2 features now, cross-source dedup, etc.).

**Max 3 rounds for plan audits** unless HIGH count is ACTIVELY DECREASING:

| Condition | Action |
|---|---|
| R1 → R2 HIGH count drops significantly (>30%) | Continue to R3 |
| R2 → R3 HIGH count drops significantly | Continue to R4 (rare) |
| HIGH count plateaus or INCREASES across rounds | **STOP** — remaining findings are scope pressure, not correctness gaps |
| R2+ findings push for v2 features, parser dependencies, framework expansion | **STOP** — challenge as out-of-scope, document as "known limitations" in plan |

**When to stop, record remaining concerns as**:
- `## N. Out of Scope (Future)` section in the plan
- Explicit "known limitations" note
- Then proceed to Step 7 final gate — acknowledge in transcript that deferrals are intentional

**Why this matters**: Each audit round costs ~$0.15 and ~3 minutes. A 4-round plan audit that doesn't decrease HIGH count is $0.30 and 6 minutes wasted, plus it pressures Claude to accept scope creep during deliberation. Stop earlier, ship earlier, iterate in code.

**Exception**: If you're genuinely uncertain whether a finding is a bug or scope creep, one more round is worth the cost. Use judgment.

**CRITICAL**: Step 7 (Gemini/Claude Opus final review) is MANDATORY after the last audit round, regardless of convergence. Gemini provides an independent perspective that GPT-5.4 cannot. The only exception is when neither `GEMINI_API_KEY` nor `ANTHROPIC_API_KEY` is available.

---

## Step 3.5 — Update Adjudication Ledger

**After each deliberation round**, write the ledger for R2+ suppression.

For EACH finding, record its adjudication outcome:

```bash
node -e "
import { writeLedgerEntry, generateTopicId, populateFindingMetadata } from './scripts/shared.mjs';

// Example: dismissed finding
const finding = { section: 'scripts/shared.mjs', category: 'SOLID-SRP Violation', principle: 'SRP', _pass: 'backend' };
populateFindingMetadata(finding, 'backend');

writeLedgerEntry('/tmp/$SID-ledger.json', {
  topicId: generateTopicId(finding),
  semanticHash: 'abcd1234',
  adjudicationOutcome: 'dismissed',   // 'dismissed' | 'accepted' | 'severity_adjusted'
  remediationState: 'pending',        // 'pending' | 'planned' | 'fixed' | 'verified'
  severity: 'MEDIUM',
  originalSeverity: 'MEDIUM',
  category: finding.category,
  section: finding.section,
  detailSnapshot: 'shared.mjs mixes concerns...',
  affectedFiles: ['scripts/shared.mjs'],
  affectedPrinciples: ['SRP'],
  ruling: 'overrule',
  rulingRationale: '300-line file, 2 consumers, acceptable',
  resolvedRound: 1,
  pass: 'backend'
});
" --input-type=module
```

**Status values**:
- `adjudicationOutcome`: `dismissed` (GPT overruled), `accepted` (will fix), `severity_adjusted` (compromise)
- `remediationState`: `pending` → `planned` → `fixed` → `verified` (or `regressed`)

**CRITICAL**: Write the ledger BEFORE proceeding to Step 4. The ledger is the source of truth for R2+.

---

## Step 3.6 — Debt Capture (Phase D)

**Purpose**: Persist out-of-scope valid findings to `.audit/tech-debt.json` so
future audits suppress them automatically. Without this step, the same
pre-existing concerns get re-raised every audit, burning tokens and diluting
signal.

**Eligible candidates** (from Step 3 triage): findings with `action = defer`.
That means `validity = valid` AND either `scope = out-of-scope` OR
`validity = valid, scope = in-scope` with a non-`out-of-scope` reason.

### Required fields per deferredReason

| `deferredReason` | Valid scope | Additional required fields |
|---|---|---|
| `out-of-scope` | out-of-scope | (none beyond rationale) |
| `blocked-by` | any | `blockedBy` (issue/PR/topicId ref) |
| `deferred-followup` | any | `followupPr` (e.g. `owner/repo#123`) |
| `accepted-permanent` | any | `approver` + `approvedAt` |
| `policy-exception` | any | `policyRef` + `approver` |

### Capture flow

For each deferral candidate, write one entry to the debt ledger:

```bash
node -e "
import { writeDebtEntries } from './scripts/lib/debt-ledger.mjs';
import { buildDebtEntry } from './scripts/lib/debt-capture.mjs';

const finding = { /* enriched finding with _hash, _primaryFile, _pass, affectedFiles, classification */ };
const { entry, sensitivity, redactions } = buildDebtEntry(finding, {
  deferredReason: 'out-of-scope',
  deferredRationale: 'pre-existing god-module concern, not in this phase scope — tracked for refactor pass',
  deferredRun: '$SID',
});

const result = await writeDebtEntries([entry]);
console.log(JSON.stringify({ inserted: result.inserted, updated: result.updated, rejected: result.rejected.length, sensitive: sensitivity.sensitive, redactions: redactions.length }));
" --input-type=module
```

**Automatic protections**:
- `deferredRationale` must be >= 20 chars (schema-enforced — no rubber-stamp defers)
- Sensitivity scan (path + content) runs at capture time — secrets in
  `detail`/`category`/`section`/`rationale` are auto-redacted to
  `[REDACTED:pattern-name]` and entry is marked `sensitive: true`
- Per-reason required fields enforced by schema — missing field → rejected
- Same topicId across runs → updates existing entry, NOT duplicate
- Event written to `.audit/local/debt-events.jsonl` (or Supabase if cloud active)

### Status card

```
═══════════════════════════════════════
  DEBT CAPTURE — Round 1
  Deferred: 7 entries (5 out-of-scope, 2 blocked-by)
  Sensitive (redacted): 1
  Total ledger: 23 entries
═══════════════════════════════════════
```

---

## Execution Order

**CRITICAL: Wait for rebuttal BEFORE fixing.**

1. Send rebuttal (if rebut HIGH/MEDIUM findings from triage)
2. Wait for rebuttal response
3. **Write adjudication ledger** (Step 3.5)
4. **Capture deferrable debt** (Step 3.6) — persist out-of-scope debt
5. Fix ALL findings together (Step 4)
6. Run tests
7. Verification audit (Step 5) — debt suppression runs automatically

---

## Step 4 — Fix Findings

ALL HIGH must be fixed. MEDIUM until ≤2 remain. LOW if mechanical.

**Track which files you modify** — you'll need this for `--changed` in Step 5.

Show what changed:
```
═══════════════════════════════════════
  FIXING — 17 findings
  Auto-fixed: 3 (mechanical)
  Fixed per recommendation: 8
  Compromises: 2
  Skipped (LOW): 4
  Files modified: shared.mjs, openai-audit.mjs
═══════════════════════════════════════
```

List each fix: `[ID] description → file:lines`

After fixing, update ledger entries to `remediationState: 'fixed'` for fixed items.

---

## Step 5 — Verify and Loop (R2+ Mode)

After fixes, re-audit using **R2+ mode** (back to Step 2).

1. Collect files modified during Step 4 → `--changed`
2. Compute scope: changed + their importers → `--files`
3. Generate diff: `git diff HEAD~1 -- . > /tmp/$SID-diff.patch`
4. Build `--passes` from file types (see Smart Pass Selection)
5. Run R2+ audit with `--round <N> --ledger --diff --changed --files`

Track finding churn using `_hash` fields:
- Resolved: hash in prior round but not current
- Recurring: hash in both rounds
- New: hash in current but not prior

### R2+ Post-Processing Report

The script automatically logs suppression stats to stderr:
```
═══════════════════════════════════════
  R2 POST-PROCESSING
  Kept: 2 | Suppressed: 11 | Reopened: 1
  Suppressed: a1b2c3 (0.82), 9f4d1e (0.78)...
═══════════════════════════════════════
```

Review suppressed topics to validate no legitimate findings were over-suppressed.

```
═══════════════════════════════════════
  ROUND 2 → ROUND 3 (R2+ mode)
  H:0 M:2 L:1 | New: 0 | Suppressed: 11
  Stable: 1/2
═══════════════════════════════════════
```

### Step 5.1 — Debt Resolution Prompt (Phase D)

After the verification audit runs, if the result's `_debtMemory.debtReopened > 0`
AND those reopened debt topics have NO matching finding in the current round's
output, those entries are candidates for resolution (the underlying issue
appears fixed).

**Resolution requires positive evidence** (fix R2-M3): the entry's files must
be in `--changed` AND in the audit scope. Absence of a match from an
out-of-scope audit is NOT proof of resolution.

For each candidate, prompt the operator:

```
═══════════════════════════════════════
  DEBT RESOLVED? — abc12345
  Category: [SYSTEMIC] God Module / Excessive File Size
  Files: scripts/openai-audit.mjs
  Reopened this round but no matching finding raised.
  Resolve? [y/N]
═══════════════════════════════════════
```

If confirmed, run:

```bash
node scripts/debt-resolve.mjs abc12345 \
  --rationale "fixed in commit <hash> — <brief description>" \
  --run-id $SID
```

This removes the entry from `.audit/tech-debt.json` (and from cloud mirror when
configured), and logs a `resolved` event to the event source. The audit trail
stays in the event log.

Exit codes: 0 = resolved, 1 = op error, 2 = entry not found / lock contention.

---

## Step 6 — Convergence Report (Pre-Final)

```
═══════════════════════════════════════
  CONVERGED — Round 4
  Final: H:0 M:2 L:1
  Rounds: 4 | Time: 14m | Cost: ~$1.20
  Files changed: 6
  Remaining (accepted): [M3], [M7]
═══════════════════════════════════════
```

Save convergence snapshot to `docs/plans/<name>-audit-summary.md`.

Do not close the loop in Step 6. Completion requires Step 7 final review (or explicit "final gate unavailable" note when both provider keys are absent).

---

## Step 7 — Gemini Independent Review (Final Gate)

After the final GPT-5.4 audit round (whether converged or not), run Gemini 3.1 Pro as an independent third reviewer. This step is MANDATORY — Gemini provides cross-model perspective that catches blind spots in Claude-GPT deliberation.

**If `GEMINI_API_KEY` is not set**, run Claude Opus fallback (`ANTHROPIC_API_KEY`).

**Only skip Step 7** if neither key is available.

When Step 7 is skipped, output `FINAL_GATE_SKIPPED` and do not claim full final-gate validation.

### Build Transcript

Assemble `/tmp/$SID-transcript.json` with the full audit trail:
- Plan content, code files list
- All rounds: GPT findings, Claude positions, GPT rulings, fixes applied
- Final state: remaining findings, dismissed findings
- Suppression data: kept/suppressed/reopened counts per round

### Run Review

```bash
node scripts/gemini-review.mjs review <plan-file> /tmp/$SID-transcript.json \
  --out /tmp/$SID-gemini-result.json 2>/tmp/$SID-gemini-stderr.log
```

The script auto-selects provider in this order:
1. Gemini (when `GEMINI_API_KEY` is set)
2. Claude Opus fallback (when `ANTHROPIC_API_KEY` is set)

### Process Verdict

| Verdict | Action |
|---------|--------|
| `APPROVE` | Done → final report |
| `CONCERNS` | Step 7.1: Deliberate → Fix → Gemini re-verify |
| `REJECT` | Present to user — needs human judgment |

Max 2 final-review rounds.

### Step 7.1 — Deliberate on Gemini Findings (CONCERNS only)

When Gemini returns `CONCERNS`, Claude deliberates on each `new_findings` and `wrongly_dismissed` item — same peer relationship as GPT deliberation:

1. **For each Gemini finding**, decide: ACCEPT, PARTIAL, or CHALLENGE
   - CHALLENGE must cite evidence (file paths, code, conventions)
   - Gemini catches things GPT missed — give extra weight to Gemini findings
2. **Fix accepted findings** — track which files changed
3. **Update transcript** with Gemini findings, Claude positions, and fixes applied
4. **Re-run Gemini review** with updated transcript:

```bash
node scripts/gemini-review.mjs review <plan-file> /tmp/$SID-transcript-v2.json \
  --out /tmp/$SID-gemini-result-v2.json 2>/tmp/$SID-gemini-stderr-v2.log
```

**CRITICAL**: Do NOT use GPT to verify Gemini's findings — GPT already missed them. Gemini must verify its own concerns were addressed. This closes the loop properly.

If Gemini returns `APPROVE` on re-review → done. If `CONCERNS` again after 2 rounds → present to user.

---

## Step 8 — Code Audit Transition (FULL_CYCLE only)

After plan converges: implement, then run Steps 2-6 with CODE_AUDIT mode.

---

## UX Rules

1. Status card after every phase (compact format above)
2. Never dump raw JSON — parse and summarize
3. Show every fix with file + line reference
4. Cost tracking: `cost ≈ (input × 2.5 + output × 10) / 1M`
5. Batch all user decisions into one prompt
6. Progress: show pass timings from stderr

## Key Principles

1. **Peer relationship** — neither model blindly defers
2. **Three-model system** — Claude (author) + GPT-5.4 (auditor) + Gemini 3.1 Pro (final arbiter)
3. **Fix all HIGH**, MEDIUM until ≤2, LOW optional
4. **Stability over speed** — 2 clean rounds required
5. **No quick fixes** — band-aids rejected by all models
6. **Deliberation is final** — no infinite debate
7. **Graceful degradation** — failed passes, missing keys, missing ledger all skip cleanly
8. **No self-review** — Step 7 final gate reviews Claude-GPT transcript. GPT verifies after Step 7 fixes.
9. **Adaptive learning** — outcomes logged, FP patterns tracked, prompts improve over time

---

## Compatibility

| Environment | Skill Location | Notes |
|-------------|---------------|-------|
| Claude Code | `.claude/skills/audit-loop/` | Native bash |
| VS Code Copilot | `.github/skills/audit-loop/` | Terminal tool |
| Cursor / Windsurf | `.github/skills/audit-loop/` | Terminal tool |
| Any AI + terminal | Direct script | `node scripts/openai-audit.mjs` |

The script auto-detects project context from `CLAUDE.md`, `Agents.md`, or `.github/copilot-instructions.md`.
