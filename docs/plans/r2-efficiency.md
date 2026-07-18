# Plan: Adaptive Audit Intelligence — Efficiency, Learning, and Continuous Improvement
- **Date**: 2026-03-29
- **Status**: Complete (shipped — R2+ mode is the canonical audit re-run path: `R2_ROUND_MODIFIER` + `buildRulingsBlock` in `scripts/lib/audit/prompt-builder.mjs`; `suppressReRaises` post-output filter in `scripts/lib/debt-ledger.mjs` + `scripts/gemini-review.mjs`; `--round <n> --ledger <path>` CLI surface in `scripts/openai-audit.mjs`. AGENTS.md "R2+ Audit Mode (Phase 1)" documents the three-layer defence. Status line corrected 2026-05-23.)
- **Author**: Claude + Louis

## Phasing Overview

| Phase | Name | Scope | Effort |
|-------|------|-------|--------|
| **1** | R2+ Efficiency | Eliminate finding churn, adjudication ledger, post-output suppression | Short-term (1-2 days) |
| **1.5** | Map-Reduce Audit Architecture | Eliminate truncation — full codebase coverage via chunked parallel audits | Short-term (2-3 days) |
| **2** | Repo-Aware Prompt Tuning | LLM scans repo → adjusts pass focus, skips irrelevant passes | Short-term (1 day) |
| **3** | Cloud Learning Database | Supabase-hosted learning store, cross-repo/cross-IDE access | Medium-term (2-3 days) |
| **4** | Effectiveness Tracking + Online FP Learning | Acceptance rates, false positive EMA tracker, signal-to-noise scoring | Medium-term (1-2 days) |
| **5** | Self-Improving Prompts (TextGrad-lite) | LLM generates prompt diffs from outcome data → human approves → A/B tested | Medium-term (2-3 days) |
| **6** | Adaptive Prompt Selection (Thompson Sampling) | Multi-armed bandit for prompt variants, contextual bandits for repo-aware selection | Medium-term (1-2 days) |
| **7** | Predictive Audit Strategy | Full pipeline optimization — pass selection, reasoning effort, cost prediction | Long-term (after 50+ audit runs) |

### Platform Support

All features work across: Claude Code, VS Code Copilot (Agents.md), Cursor, Windsurf, JetBrains (copilot-instructions.md), and standalone CLI. The instruction file discovery chain (`CLAUDE.md → Agents.md → .github/copilot-instructions.md`) is already implemented in `_getClaudeMd()`. All phases are platform-agnostic by design.

---

## 1. Context Summary

### The Problem

In the context-brief audit, GPT-5.4 re-raised 15+ dismissed findings in Round 2 and 5 more in Round 3 — all paraphrased versions of items already deliberated and overruled. This wasted:
- **~$1.50 in GPT tokens** (re-analyzing known issues)
- **~$0.30 in rebuttal tokens** (Claude re-challenging, GPT re-overruling)
- **~5 minutes of wall time** per round

### Root Cause Analysis

1. **Hash-based history matching fails on paraphrasing**: `semanticId()` hashes `category|section|detail`. GPT rewords findings each round → new hash → bypasses "DO NOT re-raise."
2. **Suppression instruction is in user prompt, not system prompt**: System prompt says "find all issues" (strong). User prompt says "don't re-raise these" (weak). System wins.
3. **No structured adjudication state**: Rulings exist only as markdown text in history. No machine-readable schema linking findings to their resolution status, affected scope, or GPT's own rationale.
4. **No deterministic post-processing**: Even if GPT re-raises, there's no post-output filter to catch paraphrased duplicates.

### What exists today

- `buildHistoryContext()` — formats prior rounds as markdown with hashes/lists
- `--files` flag — scopes quality passes to specific files
- `--passes` flag — skips irrelevant passes
- System prompts — per-pass instructions (same for R1 and R2+)
- Semantic IDs — content hashes (fail on paraphrasing)
- `isSensitiveFile()` — filters secrets from API calls
- `computePassLimits()` — adaptive token/timeout sizing

---

## 2. Proposed Architecture

### Three-Layer Defence Against Finding Churn

```
Layer 1: Adjudication Ledger (structured state)
  └─ Machine-readable JSON artifact tracking every finding's lifecycle
     (raised → deliberated → dismissed/fixed/compromised/reopened)

Layer 2: R2+ Prompt Strategy (behavioral guidance)
  ├─ R2+ system prompts: "verify fixes + find regressions" (not "find all issues")
  ├─ Rulings injection: GPT's own prior rulings in system prompt
  └─ Composable prompts: base + round modifier (DRY)

Layer 3: Post-Output Suppression (deterministic filter)
  └─ Fuzzy-match returned findings against ledger's dismissed items
     If >0.7 Jaccard similarity AND affected files unchanged → auto-suppress
     If affected files DID change → mark as "reopened" (legitimate re-raise)
```

### Core Data Model: Adjudication Ledger

```javascript
// adjudication-ledger.json — written after each round's deliberation
{
  "version": 1,
  "entries": [
    {
      "topicId": "a1b2c3d4e5f6",  // SHA-256 fingerprint: sha256(normFile|normPrinciple|category|pass)
      "semanticHash": "8a142db0",        // Content hash from first occurrence
      "adjudicationOutcome": "dismissed",  // 'dismissed' | 'accepted' | 'severity_adjusted'
      "remediationState": "pending",       // 'pending' | 'planned' | 'fixed' | 'verified' | 'regressed'
      "severity": "MEDIUM",              // Current severity (after ruling)
      "originalSeverity": "MEDIUM",      // As first raised
      "category": "SOLID-SRP Violation",
      "section": "scripts/shared.mjs",
      "detailSnapshot": "shared.mjs mixes unrelated responsibilities...",
      "affectedFiles": ["scripts/shared.mjs"],  // Scope for reopen detection
      "affectedPrinciples": ["SRP", "DRY"],     // For pass-relevant filtering
      "ruling": "overrule",              // GPT's ruling
      "rulingRationale": "300-line file, 2 consumers, acceptable trade-off",
      "resolvedRound": 1,
      "pass": "backend"                  // Which pass raised it
    }
  ]
}
```

**Two-Axis State Model**:

Axis 1 — **Adjudication Outcome** (set once during deliberation, rarely changes):
```
(new finding) ──→ dismissed   (GPT overruled / Claude challenged + GPT agreed)
(new finding) ──→ accepted    (Claude agrees with finding)
(new finding) ──→ severity_adjusted  (GPT compromised on severity)
```

Axis 2 — **Remediation State** (progresses as fixes are applied and verified):
```
pending ──→ planned  (Claude commits to fixing)
planned ──→ fixed    (fix implemented)
fixed   ──→ verified (R2+ confirms fix holds)
fixed   ──→ regressed (R2+ detects fix reverted or broken)
verified ──→ regressed (later round detects regression)
```

The two axes are independent. A finding can be `accepted` + `pending` (agreed but not yet fixed), `severity_adjusted` + `fixed`, or `dismissed` + `pending` (dismissed findings stay in `pending` — they don't progress through remediation).

Transitions are applied by the orchestrator via `applyAdjudicationEvent(ledger, event)`. Entries are upserted by `topicId` (not appended).

**`topicId` generation** — single canonical identity via content-addressed fingerprint:
```javascript
import { createHash } from 'crypto';

/**
 * Generate a deterministic finding fingerprint.
 * Identity = sha256(normalizedPrimaryFile + '|' + normalizedPrinciple + '|' + category + '|' + pass)
 *
 * No sequence disambiguator — if two findings share the same file, principle,
 * category, and pass, they are the SAME topic and should be upserted, not duplicated.
 */
function generateTopicId(finding) {
  // Normalize: strip cwd prefix, use forward slashes, lowercase
  const normFile = path.resolve(finding._primaryFile)
    .replace(path.resolve('.'), '')
    .replace(/\\/g, '/')
    .replace(/^\//, '')
    .toLowerCase();
  const normPrinciple = finding.principle
    .split('/')[0].split('—')[0].trim().toLowerCase().replace(/\s+/g, '-');
  const normCategory = finding.category.trim().toLowerCase().replace(/\s+/g, '-');
  const input = `${normFile}|${normPrinciple}|${normCategory}|${finding._pass}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}
// Example: "a1b2c3d4e5f6" — stable 12-char hex, deterministic from structured fields
```
This is stable across rewordings because it uses the primary file, principle, category, and pass — not the detail text or GPT's free-text `section` field. Including `category` distinguishes same-file same-principle findings that differ by category (e.g., "SOLID-SRP Violation" vs "DRY Violation" on the same file and principle). There is ONE identity strategy: the SHA-256 fingerprint. No sequence disambiguators, no hash suffixes, no manual slugs.

**Key design choices**:
- **`topicId`** is deterministic (generated from structured fields) — not a manual slug
- **`affectedFiles`** enables reopen detection — if a fix touches `shared.mjs`, dismissed findings scoped to that file can be reopened
- **`pass`** enables filtering rulings by pass (backend findings don't clutter frontend prompt)
- **State machine** with explicit transitions prevents illegal states (e.g., can't go from `fixed` to `dismissed`)
- Written by the **orchestrator (Claude/SKILL.md)** after each deliberation, not by the GPT script
- **Validated on read** with a lenient Zod schema — malformed entries logged + skipped, not crashed

### Change 1: Adjudication Ledger Management

**New function: `buildRulingsBlock(ledgerPath, passName)`**

Reads the ledger, filters by pass relevance and affected files, formats as system-prompt exclusions. Capped at ~1000 chars.

**Prioritization** (when entries exceed the cap, include in this order):
1. Same-pass + in-impact-set entries (most relevant to current audit scope)
2. Recent dismissed items (last 2 rounds) — GPT is most likely to re-raise these
3. Stable summary of older entries (e.g., "12 additional items dismissed in R1-R3, see ledger")

This ordering is **deterministic** — same input always produces the same rulings block.

```
## YOUR PRIOR RULINGS (scoped to this pass)

These items were deliberated in prior rounds. Do NOT re-raise them unless
the code they affect has materially changed (in which case mark as REOPENED).

### DISMISSED
- [ssmj-breadth] "shared.mjs mixes concerns" — YOU ruled DISMISSED R1.
  Reason: 300-line file, 2 consumers, acceptable. Scope: shared.mjs
- [oamj-size] "openai-audit.mjs oversized" — YOU ruled DISMISSED R1.
  Reason: Pre-existing, out of scope. Scope: openai-audit.mjs

### COMPROMISED (do not re-escalate)
- [sgpt-fail] "safeCallGPT failure states" — YOU ruled MEDIUM (was HIGH) R2.
  Scope: openai-audit.mjs

### FIXED (do not re-raise)
- [wiring-dup] "WiringIssueSchema duplicated" — FIXED R1 in shared.mjs
```

**Key**: Filter by `pass` field — backend pass only sees backend-scoped rulings. This keeps the block small (~500-800 chars per pass instead of growing unbounded).

### Change 2: R2+ System Prompt Composition

Replace full `_R2` prompt constants with composable pieces:

```javascript
// Shared R2+ round modifier — prepended to base pass prompt
const R2_ROUND_MODIFIER = `ROUND 2+ VERIFICATION MODE

This is a follow-up round. Your job has CHANGED from Round 1:

Round 1: Find ALL issues in the codebase.
Round 2+: VERIFY FIXES and CHECK FOR REGRESSIONS.

FOCUS ON:
1. Do the fixes resolve the original findings?
2. Did any fix introduce NEW problems in CHANGED code?
3. Did changes cause KNOCK-ON regressions in code that imports/depends on changed files?
4. Are there genuinely NEW issues not present in Round 1?

DO NOT:
- Re-raise findings from YOUR PRIOR RULINGS section below
- Paraphrase a dismissed finding as "new" — that contradicts your own judgment
- Re-audit unchanged, unaffected code for the same issue classes

If you believe a dismissed finding should be REOPENED because changed code
materially affects its scope, raise it with category prefix [REOPENED].`;

/**
 * Compose an R2+ system prompt from three parts:
 * 1. R2 round modifier (shared objective: verify + regress + no re-raise)
 * 2. Rulings block (filtered by pass)
 * 3. Pass rubric (WHAT to check — stripped of R1 objective language)
 *
 * IMPORTANT: The base prompt is refactored into a "rubric" that defines
 * WHAT to check (SOLID, DRY, async/await...) but NOT HOW THOROUGH to be.
 * The round modifier controls thoroughness (R1 = "find all", R2 = "verify + regress").
 */
function buildR2SystemPrompt(passRubric, rulingsBlock) {
  return `${R2_ROUND_MODIFIER}\n\n${rulingsBlock}\n\n---\n\nPASS RUBRIC (what to check):\n${passRubric}`;
}
```

**Prompt structure** (fixes M1 — no conflicting R1/R2 instructions):

| Part | R1 | R2+ |
|------|-----|------|
| **Objective** | "Find ALL issues" | R2_ROUND_MODIFIER: "Verify fixes + find regressions" |
| **Rubric** | Full base prompt (objective + checklist) | Checklist only (no "be ruthless" / "find all") |
| **Rulings** | N/A | Filtered rulings block |

Each base prompt is split into:
- `PASS_BACKEND_RUBRIC` — the checklist: "Check: SOLID, DRY, async/await..."
- `PASS_BACKEND_OBJECTIVE_R1` — the R1 framing: "Be ruthlessly honest..."

R1 uses `OBJECTIVE_R1 + RUBRIC`. R2+ uses `R2_ROUND_MODIFIER + RULINGS + RUBRIC`.

**Why composable** (Principle #1 DRY): One source of truth for R2+ semantics. Rubric is shared across rounds. No conflicting instructions.

### Change 3: Diff-Aware Code Annotation

**New function: `readFilesAsAnnotatedContext(filePaths, diffMap, opts)`**

```javascript
/**
 * Read files with change annotations for R2+ passes.
 * @param {string[]} filePaths - All files to include (changed + affected dependents)
 * @param {Map<string, {startLines: number[], endLines: number[]}>} diffMap - Changed line ranges per file
 * @param {object} opts - Same as readFilesAsContext
 * @returns {string} Annotated file contents
 */
```

**Diff input contract**: Accept a `--diff <path>` CLI flag pointing to a unified diff file. Parse it once in `main()` into a `DiffMap`:

```javascript
/**
 * Parse a unified diff file into a map of changed line ranges per file.
 * @param {string} diffPath - Path to unified diff output (git diff format)
 * @returns {Map<string, {hunks: Array<{start: number, count: number}>}>}
 */
export function parseDiffFile(diffPath) { ... }
```

**Impact Set — unified scope for R2+** (H3/H4 fix):

The `impactSet` is a single computed set used consistently for:
1. Context inclusion (which files GPT sees)
2. Rulings filtering (which rulings are relevant)
3. Reopen validation (which dismissed items can be reopened)
4. Annotation (which lines are marked as changed)

```javascript
/**
 * Compute the R2+ impact set from changed files + their dependents.
 * @param {string[]} changedFiles - Files modified in the fix round
 * @param {string[]} allFiles - All files referenced in the plan
 * @returns {string[]} Union of changed files + files that import from them
 */
export function computeImpactSet(changedFiles, allFiles) {
  const impactSet = new Set(changedFiles);

  // Simple import-scan: find files that import from any changed file
  // (sufficient for CLI scripts with explicit ESM imports; documented limitation)
  for (const file of allFiles) {
    if (impactSet.has(file)) continue;
    const absPath = path.resolve(file);
    if (!fs.existsSync(absPath)) continue;
    const content = fs.readFileSync(absPath, 'utf-8');
    for (const changed of changedFiles) {
      const basename = path.basename(changed, path.extname(changed));
      if (content.includes(`from './${basename}`) || content.includes(`from './${changed}`)) {
        impactSet.add(file);
        break;
      }
    }
  }

  return [...impactSet];
}
```

**Context assembly for R2+**:
- `changedFiles` get diff annotations (`// ── CHANGED ──` markers)
- `impactSet \ changedFiles` (dependents) are included unannotated but at lower token priority
- Files outside `impactSet` are NOT included (GPT focuses on impact zone)
- Context budgeting via `computePassLimits()`: changed hunks get priority, dependents get remainder

**Error handling** (H6 fix):
- Missing diff file → stderr warning, fall back to unannotated `readFilesAsContext()`
- Malformed diff → stderr warning, skip annotations for that file
- Empty changed set → run in "verification only" mode (check prior fixes still present)
- All paths go through existing `isSensitiveFile()` filtering
- Missing ledger → stderr warning, fall back to R1 behavior (full audit)

### Change 4: Post-Output Fuzzy Suppression

**New function: `suppressReRaises(findings, ledger, changedFiles)`**

After GPT returns findings, deterministically filter re-raises:

```javascript
/**
 * Post-process GPT findings against the adjudication ledger.
 * Three-step matching: (1) narrow by pass+scope, (2) fuzzy score, (3) reopen check.
 * @param {object[]} findings - GPT's raw findings
 * @param {object} ledger - Adjudication ledger
 * @param {string[]} impactSet - Changed files + affected dependents (unified set)
 * @returns {{ kept: object[], suppressed: object[], reopened: object[] }}
 */
export function suppressReRaises(findings, ledger, { changedFiles, impactSet }) {
  // CRITICAL: accepted+pending items must NOT be suppressed — they are open obligations.
  // Only suppress entries that are truly resolved:
  //   - adjudicationOutcome === 'dismissed' (overruled — no action needed)
  //   - remediationState === 'fixed' or 'verified' (work completed)
  // Everything else (accepted+pending, accepted+planned, severity_adjusted+pending, etc.)
  // represents an open obligation that GPT should be allowed to re-raise.
  const resolved = ledger.entries.filter(e =>
    e.adjudicationOutcome === 'dismissed' ||
    e.remediationState === 'fixed' ||
    e.remediationState === 'verified'
  );
  const kept = [], suppressed = [], reopened = [];

  for (const f of findings) {
    // Step 1: Narrow candidates by pass + file scope overlap
    // NOTE: GPT's `section` field is display-only — all file matching uses
    // structured `_primaryFile` and `affectedFiles[]` fields populated by the orchestrator.
    const candidates = resolved.filter(d =>
      d.pass === f._pass &&
      d.affectedFiles.some(af => af === f._primaryFile || f.affectedFiles?.includes(af))
    );
    if (candidates.length === 0) { kept.push(f); continue; }

    // Step 2: Score all candidates, pick highest
    let bestMatch = null, bestScore = 0;
    for (const d of candidates) {
      const score = jaccardSimilarity(
        `${f.category} ${f.section} ${f.detail}`,
        `${d.category} ${d.section} ${d.detailSnapshot}`
      );
      if (score > bestScore) { bestScore = score; bestMatch = d; }
    }

    // Step 3: Minimum threshold + reopen check
    if (bestMatch && bestScore > 0.6) {
      // Reopen only if affected files were DIRECTLY CHANGED (not just dependents)
      // impactSet includes dependents for context, but reopen requires actual changes
      const scopeDirectlyChanged = bestMatch.affectedFiles.some(af => changedFiles.includes(af));
      if (scopeDirectlyChanged) {
        f._reopened = true;  // Metadata flag, not category mutation
        f._matchedTopic = bestMatch.topicId;
        f._matchScore = bestScore;
        reopened.push(f);
      } else {
        suppressed.push({
          finding: f,
          matchedTopic: bestMatch.topicId,
          matchScore: bestScore,
          reason: `Matches ${bestMatch.adjudicationOutcome} entry (${bestMatch.remediationState}), scope unchanged`
        });
      }
    } else {
      kept.push(f); // No strong match — genuinely new finding
    }
  }

  return { kept, suppressed, reopened };
}
```

**Path normalization**: All file paths are canonicalized to cwd-relative forward-slash form before comparison — in `affectedFiles`, `changedFiles`, `impactSet`, and ledger entries. A shared `normalizePath(p)` function ensures consistency. GPT's `section` field is **display-only** — all file matching uses the structured `_primaryFile` and `affectedFiles[]` fields populated by the orchestrator when enriching GPT's raw output.

**PREREQUISITE: Finding Metadata Contract**: The orchestrator MUST populate `_primaryFile`, `affectedFiles[]`, `_pass`, and `principle` on every finding before passing to the suppression layer. These fields are derived from GPT's `section` field (parsed) and the pass name. A `populateFindingMetadata(finding, passName)` helper normalizes GPT's free-text section into structured fields.

**Matching improvements over v1**:
- **Narrowed candidates**: Filter by pass + file scope before scoring (prevents cross-pass false matches)
- **Best match**: Score ALL candidates, pick highest (not first-over-threshold)
- **Resolved entries only**: Only `dismissed` outcomes and `fixed`/`verified` remediation states are suppressible. Accepted+pending items remain open obligations that GPT can re-raise.
- **Impact set**: Uses unified `impactSet` (changed files + dependents) for reopen validation — not just `changedFiles`
- **Audit trail**: `matchedTopic`, `matchScore`, and `reason` on suppressed items for transparency

**Jaccard similarity** — reuse the existing `tokenize()` and `wordOverlap()` from `openai-audit.mjs` (already used for cross-pass dedup). Move to `shared.mjs`. Threshold configurable via `SUPPRESS_SIMILARITY_THRESHOLD` env var (default: 0.6).

---

## 3. Sustainability Notes

### Assumptions
- GPT respects system-prompt rulings better than user-prompt history (validated by rebuttal behavior pattern)
- Jaccard similarity >0.6 catches paraphrased re-raises without false-suppressing genuinely new findings (calibrated from observed audit data: same issue reworded typically scores 0.7-0.9)
- Simple import-scan finds affected dependents (sufficient for CLI scripts with explicit imports)

### What could change
- If ledger grows very large (50+ entries across many rounds), need pagination/summarization → filter by recency + pass relevance (already designed)
- If Jaccard threshold is too aggressive/conservative → configurable via `SUPPRESS_SIMILARITY_THRESHOLD` env var
- If git diff format changes → parser is isolated in `parseDiffFile()`

### Extension points
- Ledger schema is versioned (`version: 1`) — can evolve without breaking existing data
- Suppress function returns `{ kept, suppressed, reopened }` — orchestrator can log/override
- `R2_ROUND_MODIFIER` is a single string — easy to tune or A/B test

### What we defer
- **Automatic dependency graph** — simple import-regex scan is sufficient for now
- **Gemini intermittent checks** — the three-layer defence makes these unnecessary
- **Semantic topicId grouping** — current fingerprint is deterministic from file+principle+pass; semantic clustering deferred

---

## 4. File-Level Plan

### 4.1 `scripts/shared.mjs` (MODIFY)

**New functions**:
- `buildRulingsBlock(ledgerPath, passName)` — formats ledger entries as system-prompt exclusions, filtered by pass
- `parseDiffFile(diffPath)` — parses unified diff into `DiffMap`
- `readFilesAsAnnotatedContext(filePaths, diffMap, opts)` — wraps `readFilesAsContext()` with change annotations
- `suppressReRaises(findings, ledger, impactSet)` — post-output fuzzy suppression with pass-scoped matching
- `jaccardSimilarity(a, b)` — extracted from `openai-audit.mjs`'s `wordOverlap()` (move to shared, DRY)
- `computeImpactSet(changedFiles, allFiles)` — changed files + 1-hop import dependents
- `writeLedgerEntry(ledgerPath, entry)` — helper for orchestrator to write structured ledger entries (upsert by topicId)
- `LedgerEntrySchema` — Zod 4 validation schema for ledger entries (validated on read, lenient: skip invalid entries)
- `normalizePath(p)` — canonicalize file paths to cwd-relative forward-slash form

**Pre-requisite fix**: Upgrade `verifySchemaSync()` to also compare enum values (not just type='string'). Currently a Zod enum of `['A','B']` and JSON Schema enum of `['C']` both pass as 'string' type. Add `_def.entries` comparison for enum fields.

**Why shared.mjs**: All functions are consumed by the audit runner and potentially by the Gemini reviewer. Same module, same responsibility boundary.

**Planned module decomposition** (Split planned for Phase 1.5 — after implementation validates API shapes):

| Module | Responsibility | Functions |
|--------|---------------|-----------|
| `ledger.mjs` | Adjudication ledger CRUD | writeLedgerEntry, buildRulingsBlock, LedgerEntrySchema |
| `similarity.mjs` | Finding matching | jaccardSimilarity, suppressReRaises |
| `diff-context.mjs` | Diff parsing + annotation | parseDiffFile, readFilesAsAnnotatedContext |
| `repo-profile.mjs` | Repo analysis | generateRepoProfile, computeImpactSet |
| `shared.mjs` | Retained: file I/O, context, formatting | readFilesAsContext, readProjectContextForPass, formatFindings, semanticId |

### 4.2 `scripts/openai-audit.mjs` (MODIFY)

**Changes**:
- New CLI flags: `--round <n>`, `--diff <path>`, `--ledger <path>`, `--changed <list>` (files modified this round — distinct from `--files` which scopes audit visibility)
- `runMultiPassCodeAudit()`: when `round >= 2`, use composed R2+ prompts + rulings + annotated context
- Post-output: run `suppressReRaises()` before merging pass results
- Move `tokenize()` and `wordOverlap()` to shared.mjs (already used there for dedup)
- New constant: `R2_ROUND_MODIFIER` (shared round-mode text)

### 4.3 `scripts/gemini-review.mjs` (NO CODE CHANGES)

Gemini receives suppression data via the **transcript** (built by the orchestrator), not via code changes. The orchestrator should include in the transcript:
- `suppression_summary`: `{ kept: N, suppressed: N, reopened: N }` per round
- `suppressed_topics`: list of topicIds that were auto-suppressed (so Gemini can validate the suppression was correct)
- `reopened_topics`: list of topicIds that were reopened (so Gemini can evaluate if the reopen was justified)

**Suppression data contract** (for transcript):
```json
{
  "suppression": {
    "kept": [{ "id": "M1", "severity": "MEDIUM", "detail": "..." }],
    "suppressed": [{ "topicId": "a1b2c3d4e5f6", "matchScore": 0.82, "reason": "Matches dismissed entry, scope unchanged" }],
    "reopened": [{ "id": "M3", "severity": "MEDIUM", "_matchedTopic": "backend:openai-audit.mjs:dry", "_reopened": true }]
  }
}
```

This gives Gemini full visibility into what was suppressed and why — not just counts. Gemini can validate that suppressions were correct and that reopens were justified.

**`changedFiles` derivation** (M3 fix): The authoritative source is the `--changed` CLI flag passed by the orchestrator. The orchestrator derives this from the files it modified during Step 4 (fix round). `--changed` is the SOLE authoritative source for determining what was modified this round. `--files` is a separate concern: it defines the audit scope (which may include unchanged dependents for context). `--diff` provides the unified diff for line-level annotations within `--changed` files. Do NOT use `git diff --name-only` or `--files` as alternatives for determining what changed.

### 4.5 `.claude/skills/audit-loop/SKILL.md` + `.github/skills/audit-loop/SKILL.md` (MODIFY)

**Step 2 — R2+ command changes**:

Replace the current R2+ command:
```bash
# OLD (legacy --history only)
node scripts/openai-audit.mjs code <plan-file> --out /tmp/audit-$$-result.json \
  --history /tmp/audit-$$-history.json \
  --passes backend,sustainability \
  --files src/changed-file.js

# NEW (R2+ with ledger, diff, changed files, round number)
git diff HEAD~1 -- . > /tmp/audit-$$-diff.patch
node scripts/openai-audit.mjs code <plan-file> --out /tmp/audit-$$-result.json \
  --round 2 \
  --ledger /tmp/audit-$$-ledger.json \
  --diff /tmp/audit-$$-diff.patch \
  --changed scripts/shared.mjs,scripts/openai-audit.mjs \
  --files scripts/shared.mjs,scripts/openai-audit.mjs,scripts/gemini-review.mjs \
  --passes backend,sustainability \
  2>/tmp/audit-$$-stderr.log
```

Key difference: `--changed` = files modified this round (for reopen detection). `--files` = all files to include in context (changed + dependents).

```
CANONICAL CONTRACT:
- --changed <list>: SOLE AUTHORITATIVE SOURCE for files modified in the CURRENT fix round.
  Source: orchestrator's fix list. Used for: reopen validation (did dismissed scope change?),
  diff annotations, determining what actually changed.
- --files <list>: Audit scope — all files to include in audit context (may include unchanged
  dependents for context). Source: --changed + computed impact set.
  Used for: context assembly, pass scoping. NOT a source for what changed.
- --diff <path>: Unified diff file. Source: git diff output by orchestrator.
  Used for: line-level annotations within --changed files only.
```

**New Step 3.5 — Write Adjudication Ledger** (after deliberation, before fixes):

```markdown
## Step 3.5 — Update Adjudication Ledger

After each deliberation round, update `/tmp/audit-$$-ledger.json` with structured entries.

For each finding:
1. Generate `topicId` via `generateTopicId(finding)` — SHA-256 fingerprint of `normalizedFile|normalizedPrinciple|category|pass`
2. Set `adjudicationOutcome`: `dismissed` (overruled), `accepted` (agreed), `severity_adjusted` (compromise)
   Set `remediationState`: `pending` (default), `planned` (will fix), `fixed` (implemented)
3. Record `affectedFiles`, `ruling`, `rulingRationale`
4. Upsert by `topicId` (update existing entry if re-encountered)

Use the `writeLedgerEntry()` helper from shared.mjs:
```bash
node -e "
import { writeLedgerEntry } from './scripts/shared.mjs';
writeLedgerEntry('/tmp/audit-$$-ledger.json', {
  topicId: 'a1b2c3d4e5f6',  // SHA-256 fingerprint
  adjudicationOutcome: 'dismissed',
  remediationState: 'pending',
  severity: 'MEDIUM',
  category: 'SOLID-SRP Violation',
  section: 'scripts/shared.mjs',
  detailSnapshot: 'shared.mjs mixes unrelated responsibilities',
  affectedFiles: ['scripts/shared.mjs'],
  ruling: 'overrule',
  rulingRationale: '300-line file, 2 consumers, acceptable',
  resolvedRound: 1,
  pass: 'backend'
});
" --input-type=module
```

The ledger is the source of truth for R2+ rulings injection and post-output suppression.
```

**Step 5 — R2+ suppression logging**:

After R2+ audit returns, log suppression results before deliberation:
```
═══════════════════════════════════════
  R2 POST-PROCESSING
  Kept: 2 | Suppressed: 11 | Reopened: 1
  Suppressed: [ssmj-breadth] score=0.82, [oamj-size] score=0.78...
═══════════════════════════════════════
```

### 4.6 `CLAUDE.md` (MODIFY)

Document `--round`, `--diff`, `--ledger` flags and the adjudication ledger schema.

---

## 5. Risk & Trade-off Register

| Risk | Mitigation |
|------|------------|
| Jaccard false-suppresses a genuinely new finding | Threshold 0.6 is conservative (paraphrases score 0.7-0.9). Suppressed findings logged to stderr. Configurable via env var. |
| Rulings block grows too large for system prompt | Filter by pass + cap at ~1000 chars. Older entries summarized. |
| Diff parsing fails on unusual git output | Graceful fallback to unannotated context + stderr warning |
| Ledger file missing on R2+ | Graceful fallback to R1 behavior (full audit, no suppression) |
| `[REOPENED]` false positive — GPT marks everything as reopened | Post-processing validates: only findings with `match.affectedFiles` overlap are allowed to reopen |
| Import-scan misses indirect dependencies | Gemini final review catches holistic regressions. Import-scan is good enough for direct imports. |

### Trade-offs

1. **Three layers vs prompt-only**: More complex but deterministic. Prompt guidance is probabilistic; the suppression filter catches what prompts miss.
2. **Orchestrator writes ledger vs script writes ledger**: Orchestrator (Claude) has the deliberation context (which findings were accepted/challenged). Script only sees GPT's output. Orchestrator is the right place.
3. **Simple import-scan vs full dependency graph**: Import-scan covers 95% of cases for a 3-file project. Full graph is overkill.

### Deliberately deferred

- **LLM-assisted topicId refinement** — current SHA-256 fingerprint is fully deterministic; LLM could suggest semantic grouping later
- **Ledger compaction** — remove entries older than N rounds; not needed until 10+ round audits
- **Cross-audit ledger persistence** — ledger is per-audit-run; sharing across audit runs is a separate feature

---

## 6. Testing Strategy

### Automated fixture tests

1. **Ledger parsing**: Load fixture ledger JSON, verify `buildRulingsBlock()` output filtered by pass
2. **Diff parsing**: Load fixture unified diff, verify `parseDiffFile()` returns correct `DiffMap`
3. **Annotation rendering**: Given files + diffMap, verify `// ── CHANGED ──` markers at correct lines
4. **Fuzzy suppression**: Given fixture findings + ledger, verify:
   - Paraphrased re-raise of dismissed item → suppressed
   - Same issue but affected file changed → reopened
   - Genuinely new finding → kept
   - Exact hash match → suppressed
5. **Prompt composition**: Verify `buildR2SystemPrompt()` includes round modifier + rulings + base prompt
6. **Sensitive file filtering**: Verify `.env` in diff doesn't leak into annotations

### Manual validation

Run the context-brief audit again with the new R2+ mode:
- R1: full audit → expect ~19 findings
- R2: with ledger + rulings → expect 0-3 genuinely new findings (not 15+ re-raises)
- Verify dismissed items are NOT in R2 output
- Verify knock-on regression detection by introducing a deliberate bug

### Expected improvement

| Metric | Before | After | Saving |
|--------|--------|-------|--------|
| R2 findings (GPT output) | 16 | 2-3 | ~80% |
| R2 rebuttal needed | Yes (11 re-raises) | Rarely (0-1) | ~90% |
| R2 wall time | ~280s | ~80s | 70% |
| R2 cost | ~$0.55 | ~$0.12 | 78% |
| False suppressions | N/A | ~0 (0.6 threshold) | — |
| Missed regressions | N/A | ~0 (full code + annotations) | — |

---
---

# Phase 1.5: Map-Reduce Audit Architecture — Eliminate Truncation (Short-Term)

## Problem: Half-Audits

The current audit pipeline silently truncates code:

| Limit | Current Value | Impact |
|-------|--------------|--------|
| Per file | 2K-10K chars | Large files (>500 lines) get cut mid-function |
| Per pass total | 20K-120K chars | Files omitted entirely when budget exhausted |
| Plan sections for passes | 3K-4K chars | Plan detail lost |

For wine-cellar-app (200+ files), a backend pass with `maxTotal: 80000` chars (~20K tokens) can include maybe 10-15 full files out of 50+ backend files. The remaining 35+ files are **never audited**. That's a 30% audit, not a 100% audit.

## Solution: Map-Reduce with Semantic Chunking (Regex-Based)

Inspired by how CodeRabbit, Cursor, and Windsurf handle large codebases. Three phases:

### Phase 1: PRE-PROCESS (no LLM, ~0ms)

```javascript
/**
 * Build audit units from plan files using dependency graph clustering.
 * Each unit fits within a single GPT pass context window (~30K tokens).
 */
function buildAuditUnits(planFiles, maxTokensPerUnit = 30000) {
  // 1. Build dependency graph from ESM imports
  const graph = buildDependencyGraph(planFiles);

  // 2. Cluster into strongly connected components
  const clusters = tarjanSCC(graph);

  // 3. Size each cluster; split oversized ones
  const units = [];
  for (const cluster of clusters) {
    const totalTokens = cluster.reduce((sum, f) => sum + estimateTokens(f), 0);
    if (totalTokens <= maxTokensPerUnit) {
      units.push({ files: cluster, strategy: 'full' });
    } else {
      // Large cluster: core files get full source, peripheral get exports-only
      const core = rankByFanIn(cluster, graph).slice(0, 5);
      const peripheral = cluster.filter(f => !core.includes(f));
      units.push({
        coreFiles: core,
        signatureFiles: peripheral.map(f => extractExportsOnly(f)),
        strategy: 'core+signatures'
      });
    }
  }
  return units;
}
```

**File scoring for priority** (determines who gets full source vs signature-only):

| Factor | Score | Rationale |
|--------|-------|-----------|
| Changed in this round | +100 | Primary audit target |
| Imported by changed file | +50 | Knock-on regression risk |
| High fan-in (many dependents) | +5 per dep (max 30) | Architectural risk node |
| Has DB queries | +20 | Data integrity risk |
| Has auth logic | +25 | Security risk |
| Recent bug density (git blame) | +10 per recent bug | History of issues |
| File size > 8K tokens | -10 | Too large for full inclusion — use AST chunks |

### Phase 2: MAP (parallel LLM calls)

Each audit unit is sent to GPT independently, in parallel:

```javascript
const CONCURRENCY_LIMIT = 5;

async function mapPhase(units, systemPrompt, projectBrief) {
  // Semaphore-based concurrency pool — at most CONCURRENCY_LIMIT parallel GPT calls
  let active = 0;
  const queue = [];
  function acquireSlot() {
    if (active < CONCURRENCY_LIMIT) { active++; return Promise.resolve(); }
    return new Promise(resolve => queue.push(resolve));
  }
  function releaseSlot() {
    if (queue.length > 0) queue.shift()();
    else active--;
  }

  const results = await Promise.allSettled(
    units.map(async (unit, i) => {
      await acquireSlot();
      try {
        const context = unit.strategy === 'full'
          ? readFilesAsContext(unit.files, { maxPerFile: 10000, maxTotal: 80000 })
          : readCoreAndSignatures(unit.coreFiles, unit.signatureFiles);

        return callGPT(openai, {
          systemPrompt,
          userPrompt: [
            `## Project Brief\n${projectBrief}`,
            `## Audit Unit ${i + 1}/${units.length}`,
            `## Code\n${context}`,
            `\nFlag any cross-file issues with cross_file_flag: true.`
          ].join('\n\n'),
          schema: PassFindingsSchema,
          schemaName: `unit_${i}_findings`,
          passName: `map-${i}`
        });
      } finally {
        releaseSlot();
      }
    })
  );

  // Collect findings, marking failed units instead of silently dropping them
  const findings = [];
  let failedUnitCount = 0;
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      findings.push(...results[i].value.result.findings);
    } else {
      failedUnitCount++;
      console.error(`[map] Unit ${i} failed: ${results[i].reason?.message || results[i].reason}`);
      findings.push({
        id: `MAP-FAIL-${i}`,
        severity: 'HIGH',
        category: 'Audit Infrastructure',
        section: `map-unit-${i}`,
        detail: `Map unit ${i} failed: ${results[i].reason?.message || 'unknown error'}. Files in this unit were NOT audited.`,
        _failed_unit: true,
        _unit_index: i,
        _unit_files: units[i].files || units[i].coreFiles || []
      });
    }
  }

  // Attach failure metadata so reduce phase knows about gaps
  findings._failedUnitCount = failedUnitCount;
  findings._totalUnits = units.length;
  return findings;
}
```

**Concurrency**: 3-5 parallel calls (GPT-5.4 handles this well). Each call is ~30K tokens input, ~3K output. Total map phase: ~30-60s wall time regardless of codebase size.

### Phase 3: REDUCE (single LLM synthesis call)

After map phase, one synthesis call deduplicates and detects cross-cutting patterns:

```javascript
async function reducePhase(allFindings, projectBrief, planContent) {
  return callGPT(openai, {
    systemPrompt: REDUCE_SYSTEM_PROMPT,
    userPrompt: [
      `## Project Brief\n${projectBrief}`,
      `## Plan\n${planContent.slice(0, 8000)}`,
      `## Findings from ${allFindings.length} audit units:`,
      JSON.stringify(allFindings.map(f => ({
        id: f.id, severity: f.severity, category: f.category,
        section: f.section, detail: f.detail, cross_file_flag: f.cross_file_flag
      })), null, 2),
      `\nTasks:`,
      `1. Remove duplicates and near-duplicates`,
      `2. Identify SYSTEMIC patterns (same issue in 3+ files → elevate severity)`,
      `3. Flag cross-file issues that individual units couldn't see`,
      `4. Return ranked, deduplicated findings`
    ].join('\n\n'),
    schema: PassFindingsSchema,
    schemaName: 'reduce_findings',
    passName: 'reduce'
  });
}
```

**TOKEN BUDGET**: The reduce phase input (all map findings) is capped at 30K tokens. If map produces more findings than fit, prioritize HIGH > MEDIUM > LOW, and truncate detail fields to 200 chars. The reduce prompt includes the finding count so it knows if it's working with truncated input. The reduce phase also receives the failure count from the map phase (via `findings._failedUnitCount`) and must note it in its output findings so the user knows which units were not audited.

### Semantic Chunking (Regex-Based) for Large Single Files

Uses regex-based function boundary detection (not a full AST parser) to avoid adding a parser dependency. Handles ES6+ patterns: `export function`, `export async function`, `export class`, `export const = () =>`. For files with non-standard structures, falls back to line-count chunking.

For files >500 lines, split at function/class boundaries (not line count):

```javascript
/**
 * Split a large file into semantic chunks at function/class boundaries.
 * Each chunk includes the file's import block for context.
 * Uses regex-based detection (no AST parser dependency needed for JS/TS).
 * Falls back to line-count chunking when regex detection finds no boundaries.
 */
function chunkLargeFile(source, filePath, maxChunkTokens = 6000) {
  const imports = extractImportBlock(source); // Everything before first function/class
  const functions = splitAtFunctionBoundaries(source); // Regex: export (async )? function|class|const.*=>

  const chunks = [];
  let current = { imports, items: [], tokens: estimateTokens(imports) };

  for (const fn of functions) {
    const fnTokens = estimateTokens(fn.source);
    if (current.tokens + fnTokens > maxChunkTokens && current.items.length > 0) {
      chunks.push(current);
      current = { imports, items: [], tokens: estimateTokens(imports) };
    }
    current.items.push(fn);
    current.tokens += fnTokens;
  }
  if (current.items.length) chunks.push(current);
  return chunks;
}
```

**Critical**: Always prepend the import block to every chunk. Without type/import context, GPT can't reason about dependencies.

### Integration with Existing Multi-Pass Architecture

The map-reduce layer sits BELOW the existing pass system:

```
SKILL.md orchestrator
    │
    ▼
openai-audit.mjs — pass orchestrator (existing)
    │
    ├── structure pass → single call (small context)
    ├── wiring pass → single call (API files only)
    ├── backend pass → MAP-REDUCE (large file set)
    │   ├── Pre-process: build audit units
    │   ├── Map: parallel GPT calls per unit
    │   └── Reduce: synthesize + dedup
    ├── frontend pass → MAP-REDUCE (large file set)
    └── sustainability pass → MAP-REDUCE (all files)
```

**Threshold**: If a pass has ≤15 files that fit in `maxTotal`, use the existing single-call path. If >15 files or `maxTotal` exceeded, auto-switch to map-reduce. No CLI changes needed — the split is internal.

### File Changes

- `scripts/shared.mjs`: New `buildAuditUnits()`, `chunkLargeFile()`, `extractExportsOnly()`
- `scripts/openai-audit.mjs`: `runMultiPassCodeAudit()` detects oversized passes → delegates to map-reduce
- New: `REDUCE_SYSTEM_PROMPT` constant for the synthesis pass

### Expected Impact

| Metric | Current (truncated) | With Map-Reduce |
|--------|-------------------|-----------------|
| Files audited | ~30% (budget cut) | 100% (chunked) |
| Cross-file issues found | Low (files omitted) | High (reduce phase) |
| Backend pass time | ~150s (1 call) | ~60s (5 parallel + 1 reduce) |
| Token cost per pass | ~$0.15 | ~$0.25 (more calls, but parallelized) |
| Audit confidence | Partial | Full coverage |

---
---

# Phase 2: Repo-Aware Prompt Tuning (Short-Term)

## Problem

The audit prompts are generic — the same backend pass checks "SOLID, DRY, async/await, cellar_id scoping" whether the repo is a CLI tool with 3 files or a multi-tenant Express app with 200+ files. The audit brief (from context-brief feature) helps by injecting repo-specific constraints, but the **pass selection and focus areas** are still hardcoded.

## Solution: Pre-Audit Repo Analysis

At audit start (after `initAuditBrief()`), run a lightweight LLM analysis of the repo that produces a **repo profile**:

```javascript
// Generated once at audit start, cached for the session
{
  "repoFingerprint": "sha256-of-package.json+CLAUDE.md+sorted-code-file-inventory",
  "stack": {
    "backend": { "framework": "express", "db": "postgresql", "auth": "supabase-jwt" },
    "frontend": { "framework": "vanilla-js", "bundler": null },
    "testing": { "framework": "vitest", "isolation": "per-file" }
  },
  "fileBreakdown": {
    "backend": 45,      // route + service + db files
    "frontend": 32,     // public/js files
    "config": 8,
    "test": 120,
    "total": 205
  },
  "passRelevance": {
    "structure": true,
    "wiring": true,      // has both frontend + backend
    "backend": true,
    "frontend": true,
    "sustainability": true
  },
  "focusAreas": [
    "cellar_id scoping on ALL queries (multi-tenant critical)",
    "async/await on all db.prepare() calls (PostgreSQL returns Promises)",
    "CSP compliance — no inline event handlers",
    "apiFetch() not raw fetch() for API calls"
  ],
  "skipPatterns": [
    "MCP server configuration — not auditable",
    "Deployment instructions — out of scope",
    "Search pipeline benchmarks — test-only"
  ]
}
```

### How It's Generated

1. **File count** — `glob` counts by directory pattern (instant, no LLM)
2. **Stack detection** — regex on `package.json` dependencies (instant)
3. **Focus areas** — extracted from the audit brief (already LLM-generated)
4. **Pass relevance** — if `fileBreakdown.frontend === 0`, skip frontend pass entirely
5. **Repo fingerprint** — SHA-256 of `package.json` + `CLAUDE.md` + sorted file inventory (`ls -R` filtered to code files: `*.js`, `*.ts`, `*.mjs`, `*.cjs`, `*.jsx`, `*.tsx`, `*.py`, `*.go`, `*.rs`). **Invalidation rule**: re-generate the full repo profile when the fingerprint changes (file added/removed/renamed, dependencies changed, or CLAUDE.md updated).

### How It's Used

- **Pass selection**: Skip passes where `passRelevance[pass] === false`
- **System prompt injection**: `focusAreas` are prepended to each pass's rubric as "PRIORITY CHECKS for this codebase"
- **Context budgeting**: Larger `fileBreakdown` → higher token limits per pass
- **R2+ prompt tuning**: Focus areas inform which dismissed findings are most important to keep in the rulings block

### File Changes

- `scripts/shared.mjs`: New `generateRepoProfile()` function (regex + brief-derived)
- `scripts/openai-audit.mjs`: Consume repo profile for pass selection + prompt injection
- No new dependencies — uses existing `initAuditBrief()` output + file system scanning

---
---

# Phase 3: Cloud Learning Database (Medium-Term)

## Problem

The adjudication ledger (Phase 1) is per-audit-run in `/tmp/`. The repo profile (Phase 2) is per-session. Nothing persists across audit runs, repos, or IDEs. When the same developer audits wine-cellar-app from VS Code on Monday and from Claude Code on Wednesday, the system starts from zero both times.

## Solution: Supabase Learning Store

A cloud-hosted PostgreSQL database (Supabase — already in the project stack) that stores:

1. **Audit outcomes** — what was found, accepted, dismissed, fixed per repo
2. **Repo profiles** — cached stack/focus data per repo fingerprint
3. **Prompt effectiveness** — acceptance rates per pass per repo
4. **False positive patterns** — recurring dismissals that should become suppressions

### Why Supabase

| Option | Pros | Cons |
|--------|------|------|
| SQLite local | Zero setup, fast | Per-machine only, no cross-IDE |
| Supabase PostgreSQL | Cloud, cross-IDE, already in stack, free tier | Needs API key, network dependency |
| Firebase/Planetscale | Cloud, free tier | New dependency, unfamiliar stack |

**Decision**: Supabase. The wine-cellar-app already uses it. We have the SDK expertise. The free tier handles this volume easily (hundreds of rows, not millions). Graceful fallback: if `SUPABASE_AUDIT_URL` is not set, skip cloud learning entirely — pure local mode.

### Database Schema

```sql
-- Repos we've audited
-- RLS: WHERE user_id = auth.uid()
CREATE TABLE audit_repos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  fingerprint TEXT UNIQUE NOT NULL,       -- SHA-256 of package.json + CLAUDE.md + sorted code file inventory
  name TEXT NOT NULL,                     -- Human-readable repo name
  stack JSONB NOT NULL,                   -- { backend, frontend, testing }
  file_breakdown JSONB NOT NULL,          -- { backend: 45, frontend: 32, ... }
  focus_areas TEXT[] NOT NULL,            -- Repo-specific audit priorities
  last_audited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Individual audit runs
-- RLS: WHERE user_id = auth.uid()
CREATE TABLE audit_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  repo_id UUID REFERENCES audit_repos(id),
  plan_file TEXT NOT NULL,                -- Path to plan being audited
  mode TEXT NOT NULL,                     -- 'plan' | 'code'
  rounds INTEGER NOT NULL,               -- How many GPT rounds before convergence
  total_findings INTEGER NOT NULL,
  accepted_count INTEGER NOT NULL,
  dismissed_count INTEGER NOT NULL,
  fixed_count INTEGER NOT NULL,
  gemini_verdict TEXT,                    -- 'APPROVE' | 'CONCERNS' | 'REJECT'
  total_cost_estimate NUMERIC(6,3),       -- Estimated $ cost
  total_duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-pass effectiveness tracking
-- RLS: WHERE user_id = auth.uid()
CREATE TABLE audit_pass_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  run_id UUID REFERENCES audit_runs(id),
  pass_name TEXT NOT NULL,                -- 'structure' | 'wiring' | 'backend' | 'frontend' | 'sustainability'
  findings_raised INTEGER NOT NULL,
  findings_accepted INTEGER NOT NULL,
  findings_dismissed INTEGER NOT NULL,
  findings_compromised INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,
  reasoning_effort TEXT,                  -- 'low' | 'medium' | 'high'
  acceptance_rate NUMERIC(4,3) GENERATED ALWAYS AS (
    CASE WHEN findings_raised > 0 THEN findings_accepted::NUMERIC / findings_raised ELSE 0 END
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Recurring false positive patterns (learned over time)
-- RLS: WHERE user_id = auth.uid()
CREATE TABLE false_positive_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  repo_id UUID REFERENCES audit_repos(id),
  pattern_type TEXT NOT NULL,             -- 'category' | 'section' | 'principle' | 'detail_fragment'
  pattern_value TEXT NOT NULL,            -- e.g., "shared.mjs mixes concerns"
  dismissal_count INTEGER NOT NULL DEFAULT 1,
  last_dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  auto_suppress BOOLEAN NOT NULL DEFAULT FALSE,  -- TRUE after N dismissals (threshold configurable)
  suppress_threshold INTEGER NOT NULL DEFAULT 3,  -- Auto-suppress after this many dismissals
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(repo_id, pattern_type, pattern_value)
);

-- Per-finding per-pass: individual findings with full context
CREATE TABLE audit_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  run_id UUID REFERENCES audit_runs(id),
  finding_fingerprint TEXT NOT NULL,       -- SHA-256 topicId from generateTopicId()
  pass_name TEXT NOT NULL,
  severity TEXT NOT NULL,                  -- 'HIGH' | 'MEDIUM' | 'LOW'
  category TEXT NOT NULL,
  primary_file TEXT NOT NULL,              -- Structured file path (not GPT's display section)
  detail_snapshot TEXT NOT NULL,           -- Finding text at time of raise
  prompt_variant_id UUID REFERENCES prompt_variants(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-finding adjudication decision (one row per deliberation event)
CREATE TABLE finding_adjudication_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  finding_id UUID REFERENCES audit_findings(id),
  outcome TEXT NOT NULL,                   -- 'dismissed' | 'accepted' | 'severity_adjusted'
  rationale TEXT NOT NULL,                 -- Why this decision was made
  round INTEGER NOT NULL,                  -- Which round this decision occurred in
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-finding suppression event (one row per suppression/reopen action)
CREATE TABLE suppression_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  finding_id UUID REFERENCES audit_findings(id),
  matched_fingerprint TEXT NOT NULL,       -- topicId of the ledger entry that matched
  match_score NUMERIC(4,3) NOT NULL,       -- Jaccard similarity score
  action TEXT NOT NULL,                    -- 'suppressed' | 'reopened'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- NOTE: audit_pass_stats should be a derived VIEW, not a separately maintained table.
-- The table definition below is kept for backward compatibility but should be
-- replaced with: CREATE VIEW audit_pass_stats_v AS SELECT ... FROM audit_findings
-- JOIN finding_adjudication_events ... GROUP BY pass_name, run_id;

-- Prompt variants and their effectiveness
-- RLS: WHERE user_id = auth.uid()
CREATE TABLE prompt_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  pass_name TEXT NOT NULL,
  variant_name TEXT NOT NULL,             -- e.g., 'v1-base', 'v2-focused', 'v2-with-repo-context'
  prompt_hash TEXT NOT NULL,              -- SHA-256 of prompt text (detect changes)
  total_uses INTEGER NOT NULL DEFAULT 0,
  avg_acceptance_rate NUMERIC(4,3),
  avg_findings_per_use NUMERIC(5,1),
  avg_false_positive_rate NUMERIC(4,3),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(pass_name, variant_name)
);
```

### Access Pattern

```
Audit Start
    │
    ├─ Load repo profile from cloud (by fingerprint)
    │   └─ Cache hit? Use cached focus_areas + pass_relevance
    │   └─ Cache miss? Generate locally, save to cloud
    │
    ├─ Load false positive patterns for this repo
    │   └─ Auto-suppress patterns with dismissal_count >= threshold
    │
    └─ Load prompt variants → select best-performing per pass
    │
    ▼
During Audit (each pass)
    │
    └─ Track: findings_raised, tokens, latency
    │
    ▼
After Deliberation
    │
    ├─ Update pass stats (accepted/dismissed/compromised counts)
    ├─ Update false positive patterns (increment dismissal_count)
    └─ Update prompt variant effectiveness
    │
    ▼
After Convergence
    │
    └─ Write audit_run summary → cloud
```

### Authentication

Use Supabase Auth with JWT. CLI authenticates via `supabase login` or stored refresh token in `~/.claude-audit/config.json`. RLS policies use `auth.uid()`. Each table has `user_id UUID REFERENCES auth.users(id) NOT NULL`.

Use a dedicated Supabase project for the audit learning store (separate from any app being audited). The audit-loop repo stores:
- `SUPABASE_AUDIT_URL` — Supabase project URL
- `SUPABASE_AUDIT_ANON_KEY` — public anon key (RLS policies restrict access)

```json
// ~/.claude-audit/config.json
{
  "supabaseRefreshToken": "eyJ..."
}
```

The CLI uses the refresh token to obtain a short-lived JWT on each invocation. RLS policy on all tables:

```sql
CREATE POLICY "user_isolation" ON audit_repos
  FOR ALL USING (user_id = auth.uid());
-- Same policy on audit_runs, audit_pass_stats, false_positive_patterns, prompt_variants
```

This leverages Supabase's built-in auth infrastructure with proper JWT validation, avoiding custom API key management. The refresh token flow works well for CLI tools — no browser OAuth redirect needed after initial `supabase login`.

### Cross-IDE Access

```
VS Code (Claude Code ext)  ──→ Supabase ←── Terminal (CLI)
Cursor / Windsurf          ──→ Supabase ←── CI/CD pipeline
JetBrains (Copilot)        ──→ Supabase ←── Web dashboard (future)
```

All environments use the same `openai-audit.mjs` / `gemini-review.mjs` scripts. The Supabase client is initialized from env vars — same pattern as the wine-cellar-app.

### File Changes

- `scripts/shared.mjs`: New `initLearningStore()`, `loadRepoProfile()`, `recordAuditRun()`, `loadFalsePositivePatterns()`
- `scripts/openai-audit.mjs`: Call learning store at start/end of audit
- `package.json`: Add `@supabase/supabase-js` dependency
- `.env.example`: Add `SUPABASE_AUDIT_URL`, `SUPABASE_AUDIT_ANON_KEY`
- New: `migrations/001_learning_store.sql` — schema DDL

### Graceful Degradation

If `SUPABASE_AUDIT_URL` is not set or Supabase is unreachable:
- All cloud features disabled silently
- Local-only mode (adjudication ledger in `/tmp/`, no cross-run learning)
- Stderr: `[learning] Cloud store not configured — using local mode`

---
---

# Phase 4: Effectiveness Tracking (Medium-Term)

## Problem

We have no visibility into which passes produce valuable findings and which mostly produce noise. The sustainability pass in the context-brief audit generated 15+ re-raises across 3 rounds — all dismissed. That's ~$1.00 wasted with zero useful output.

## Solution: Signal-to-Noise Scoring

After each audit run, compute effectiveness metrics per pass:

```javascript
{
  "passEffectiveness": {
    "structure": {
      "acceptance_rate": 0.85,      // 85% of findings were accepted
      "signal_score": 0.92,         // High — mostly useful findings
      "cost_per_accepted": 0.02,    // $0.02 per useful finding
      "recommendation": "keep"
    },
    "sustainability": {
      "acceptance_rate": 0.15,      // 15% accepted — mostly noise
      "signal_score": 0.22,         // Low — GPT re-raises dismissed items
      "cost_per_accepted": 0.45,    // $0.45 per useful finding (expensive!)
      "recommendation": "reduce_reasoning"  // or "skip_on_r2+"
    }
  }
}
```

### Metrics

| Metric | Formula | Purpose |
|--------|---------|---------|
| **Acceptance rate** | `accepted / raised` | How often GPT's findings are useful |
| **Signal score** | `(accepted + compromised) / (raised - suppressed)` | Quality after filtering |
| **Cost per accepted** | `pass_cost / accepted` | Efficiency — how much we pay per useful finding |
| **Churn rate** | `re_raises / raised` | How often GPT repeats dismissed items (R2+) |
| **Regression catch rate** | `reopened / total_changed_scope` | How well R2+ catches regressions |

### Adaptive Behavior (driven by metrics)

| Condition | Action |
|-----------|--------|
| `acceptance_rate < 0.20` for 3+ runs | Reduce reasoning effort (`high` → `medium`) |
| `acceptance_rate < 0.10` for 5+ runs | Skip pass on R2+ (keep on R1) |
| `churn_rate > 0.60` for 2+ runs | Flag for human review of suppression calibration. Do NOT auto-tune thresholds. |
| `cost_per_accepted > $0.50` | Flag for prompt review (Phase 5) |
| `regression_catch_rate > 0.30` | Pass is catching real issues — keep full effort |

### Storage

Metrics are computed in the script and stored in `audit_pass_stats` (Phase 3 schema). Aggregate queries produce the recommendations:

```sql
-- Which passes are wasting money?
SELECT pass_name,
       AVG(acceptance_rate) as avg_acceptance,
       SUM(input_tokens + output_tokens) as total_tokens,
       COUNT(*) as uses
FROM audit_pass_stats
WHERE run_id IN (SELECT id FROM audit_runs WHERE repo_id = $1)
GROUP BY pass_name
ORDER BY avg_acceptance ASC;
```

### File Changes

- `scripts/shared.mjs`: New `computePassEffectiveness()`, `getAdaptivePassConfig()`
- `scripts/openai-audit.mjs`: Before each pass, check adaptive config (skip/reduce if warranted)
- Cloud store queries in `initLearningStore()` load phase

---
---

# Phase 5: Self-Improving Prompts (Long-Term)

## Problem

Even with repo-aware tuning and effectiveness tracking, prompt quality is static — a human writes the prompt once, and it stays that way until manually updated. The system knows which passes have low acceptance rates but can't automatically fix the prompts that cause it.

## Solution: LLM-Assisted Prompt Refinement Loop

After each audit run, an LLM (Haiku or Flash — cheap and fast) reviews the audit outcomes and suggests prompt refinements:

### The Refinement Cycle

```
After Audit Convergence
    │
    ▼
Refinement LLM receives:
  - Current pass prompt text
  - Last 5 audit runs' outcomes for this pass + repo
  - Accepted findings (what GPT got right)
  - Dismissed findings (what GPT got wrong — false positives)
  - Suppressed findings (what the system caught as re-raises)
  - Acceptance rate trend (improving? declining?)
    │
    ▼
LLM produces:
  - Suggested prompt diff (additions, removals, rewording)
  - Rationale for each change
  - Expected impact (e.g., "should reduce false positives by ~30%")
  - Confidence level (high/medium/low)
    │
    ▼
Human Review:
  - Show diff + rationale in terminal
  - User approves (✓), rejects (✗), or edits
  - Approved changes saved as new prompt variant
    │
    ▼
A/B Testing:
  - New variant used for next audit
  - Effectiveness compared against previous variant
  - If worse, auto-revert after 3 runs
```

### Prompt Refinement Schema

```javascript
{
  "refinementId": "uuid",
  "passName": "sustainability",
  "repoId": "uuid",
  "currentPromptHash": "abc123",
  "suggestedChanges": [
    {
      "type": "add",           // add | remove | reword
      "location": "after line 3",
      "text": "Do NOT flag file size concerns for files under 500 lines — this repo's convention is acceptable.",
      "rationale": "shared.mjs size was dismissed 6 times across 3 audits. This is a known acceptable trade-off.",
      "confidence": "high"
    },
    {
      "type": "remove",
      "location": "line 7",
      "text": "file/function size (>500 lines / >50 lines)",
      "rationale": "Size-based findings have 8% acceptance rate in this repo. The codebase deliberately uses larger orchestration files.",
      "confidence": "medium"
    }
  ],
  "expectedImpact": "Reduce sustainability pass false positives by ~40% based on historical dismissal patterns",
  "status": "pending",        // pending | approved | rejected | reverted
  "approvedBy": null,
  "approvedAt": null
}
```

### Safety Rails

1. **Human approval required** — no automatic prompt changes. The LLM suggests, the human decides.
2. **A/B testing** — new variant runs alongside old variant's baseline metrics. Auto-revert if acceptance rate drops.
3. **Prompt versioning** — every variant is stored with hash, creation date, and effectiveness metrics. Full history preserved.
4. **Repo-scoped** — refinements are per-repo. A refinement for wine-cellar-app doesn't affect other repos.
5. **Revert capability** — any variant can be reverted to the previous version with one command.

### Storage

- `prompt_variants` table (Phase 3 schema) stores all variants
- `prompt_refinements` table (new) stores suggested changes + approval status
- Cloud dashboard (Phase 6) shows refinement history and A/B comparison

### File Changes

- New: `scripts/refine-prompts.mjs` — standalone refinement script
- `scripts/shared.mjs`: `loadActivePromptVariant(passName, repoId)`, `recordPromptRefinement()`
- `scripts/openai-audit.mjs`: Load active prompt variant instead of hardcoded constant
- SKILL.md: New `/audit-refine` command to trigger manual refinement review

### CLI Interface

```bash
# Review and approve pending refinements
node scripts/refine-prompts.mjs review

# Show prompt effectiveness history
node scripts/refine-prompts.mjs stats --repo wine-cellar-app

# Revert a prompt variant
node scripts/refine-prompts.mjs revert --pass sustainability --to v2

# Force refinement analysis (normally auto-triggered after audit)
node scripts/refine-prompts.mjs analyze --repo wine-cellar-app --pass sustainability
```

---
---

# Phase 6: Adaptive Prompt Selection — Thompson Sampling Bandits (Medium-Term)

## Problem

Static prompt selection wastes tokens. The same "check SOLID, DRY, async/await" prompt runs regardless of whether a repo's sustainability findings have a 15% acceptance rate (noise) or 85% (signal). Phase 5 lets humans approve prompt changes — but selection between approved variants is still manual.

## Solution: Multi-Armed Bandit for Prompt Variant Selection

Based on research into TensorZero's bandit gateway and NeurIPS 2024 work on best-arm identification for prompt learning. The core algorithm is **Thompson Sampling with Beta-Bernoulli model** — 50 lines of pure JS, no external dependencies.

### How It Works

Each prompt variant for each pass is an "arm." Pulling an arm = using that prompt for an audit. Reward = acceptance rate of findings produced by that prompt. Over time, the bandit converges on the best variant.

```javascript
// bandit.mjs — Thompson Sampling prompt selector (no dependencies)

/**
 * Select the best prompt variant for a pass using Thompson Sampling.
 * Each arm tracks: alpha (successes) + beta (failures) as Beta distribution params.
 * Selection: sample from each arm's Beta posterior, pick highest sample.
 */
class PromptBandit {
  constructor(statePath) {
    this.arms = loadJSON(statePath) ?? {};
  }

  addArm(passName, variantId) {
    const key = `${passName}:${variantId}`;
    if (!this.arms[key]) this.arms[key] = { alpha: 1, beta: 1, pulls: 0 };
  }

  select(passName) {
    const candidates = Object.entries(this.arms)
      .filter(([k]) => k.startsWith(`${passName}:`));
    if (candidates.length === 0) return null;

    let best = null, bestSample = -1;
    for (const [key, arm] of candidates) {
      const sample = randomBeta(arm.alpha, arm.beta);
      if (sample > bestSample) { bestSample = sample; best = { key, ...arm }; }
    }
    return best;
  }

  update(passName, variantId, accepted) {
    const key = `${passName}:${variantId}`;
    if (!this.arms[key]) return;
    if (accepted) this.arms[key].alpha++;
    else this.arms[key].beta++;
    this.arms[key].pulls++;
  }

  // Convergence: arm's 95% CI fully above all others → lock in
  hasConverged(passName) {
    const candidates = Object.entries(this.arms)
      .filter(([k]) => k.startsWith(`${passName}:`));
    if (candidates.length < 2) return true;
    const sorted = candidates.sort((a, b) =>
      (b[1].alpha / (b[1].alpha + b[1].beta)) - (a[1].alpha / (a[1].alpha + a[1].beta))
    );
    const best = sorted[0][1];
    const bestLower = betaQuantile(best.alpha, best.beta, 0.025);
    return sorted.slice(1).every(([, arm]) =>
      bestLower > betaQuantile(arm.alpha, arm.beta, 0.975)
    );
  }
}

// Pure JS Beta random variate (Marsaglia-Tsang gamma method)
function randomBeta(a, b) {
  const g1 = randomGamma(a), g2 = randomGamma(b);
  return g1 / (g1 + g2);
}
```

### Contextual Bandits — Repo-Aware Selection

For repos with different characteristics, run separate bandits per context bucket:

```javascript
function contextBucket(repoProfile) {
  const stack = repoProfile.hasTypeScript ? 'ts' : 'js';
  const size = repoProfile.fileCount < 20 ? 'S' : repoProfile.fileCount < 100 ? 'M' : 'L';
  const tested = repoProfile.hasTests ? 'T' : 'U';
  return `${stack}:${size}:${tested}`;
}
// Example: "js:M:T" = medium JS repo with tests
// Falls back to global bandit if bucket has < 10 observations
```

### Integration with Audit Pipeline

```javascript
// In openai-audit.mjs, before each pass:
const bandit = new PromptBandit('.audit/bandit-state.json');
const selected = bandit.select(passName);
const systemPrompt = selected?.promptText ?? DEFAULT_PROMPTS[passName];

// After deliberation:
for (const finding of findings) {
  bandit.update(passName, selected.variantId, finding._accepted);
}
```

### RLHF-Lite: Weighted Reward Signal

The deliberation loop already produces rich feedback. Use weighted scoring instead of binary accept/dismiss:

```javascript
function computeReward(resolution) {
  const positionWeights = { accept: 1.0, partial_accept: 0.6, challenge: 0.0 };
  const rulingWeights = { sustain: 1.0, compromise: 0.5, overrule: 0.0 };
  const severityMult = { HIGH: 1.0, MEDIUM: 0.7, LOW: 0.4 };

  const claudeSignal = positionWeights[resolution.claude_position] ?? 0;
  const gptSignal = rulingWeights[resolution.gpt_ruling] ?? 0;
  const sevMult = severityMult[resolution.final_severity] ?? 0;

  return (claudeSignal * 0.4 + gptSignal * 0.6) * sevMult;
}
```

### File Changes

- New: `scripts/bandit.mjs` — Thompson Sampling implementation (~100 lines, no deps)
- `scripts/openai-audit.mjs`: Select prompt variant via bandit before each pass
- `scripts/shared.mjs`: `computeReward()` function for weighted outcomes
- Bandit state stored in cloud DB (Phase 3) or local `.audit/bandit-state.json`

### References

- [TensorZero: Bandits in LLM Gateways](https://www.tensorzero.com/blog/bandits-in-your-llm-gateway/) — production bandit implementation
- [NeurIPS 2024: Best Arm Identification for Prompt Learning](https://proceedings.neurips.cc/paper_files/paper/2024/file/b46bc1449205888e1883f692aff1a252-Paper-Conference.pdf)
- [MASPOB: Bandit-Based Prompt Optimization](https://arxiv.org/html/2603.02630v1)

---
---

# Phase 7: Predictive Audit Strategy (Long-Term — after 50+ audit runs)

## Vision

With enough historical data, the system predicts optimal audit strategy before running:

```
Before Audit:
  "Predicted: 3 passes relevant (skip structure, frontend)
   Reasoning: high for backend (security changes), low for sustainability
   Expected: 4-6 findings, ~$0.35 total
   Gemini: skip (99% APPROVE rate for this repo)"
```

### Predictive Models (trained on Phase 3-6 data)

| Prediction | Input Features | Model |
|------------|----------------|-------|
| Pass relevance | Changed files, file types, change size, repo stack | Logistic regression |
| Reasoning effort | Pass history, acceptance rate, repo complexity | Contextual bandit (Phase 6) |
| Expected findings | Repo fingerprint, change scope, historical density | Linear regression |
| Gemini necessity | Claude-GPT convergence history, bias detection rate | Decision tree |

### Data Requirements

- 10 audit runs per repo for per-repo predictions
- 50 audit runs total for cross-repo patterns
- Phase 3-6 generate the training data as a side effect of normal operation

---
---

# Cross-Phase Architecture

## How the Phases Build on Each Other

```
Phase 1: R2+ Efficiency
  └─ Adjudication ledger (per-run, /tmp/)
  └─ Post-output suppression (Jaccard matching)
  └─ Composable R2+ prompts
      │
Phase 1.5: Map-Reduce Architecture
  └─ Full codebase coverage (no truncation)
  └─ AST-aware chunking for large files
  └─ Parallel map + synthesis reduce
      │
Phase 2: Repo-Aware Tuning
  └─ Repo profile (per-session, cached)
  └─ Pass selection based on repo shape
  └─ Focus areas injected into prompts
      │
Phase 3: Cloud Learning Database
  └─ Supabase stores: repos, runs, pass stats, patterns
  └─ Cross-IDE, cross-run persistence
  └─ False positive pattern accumulation
      │
Phase 4: Effectiveness Tracking + Online FP Learning
  └─ Signal-to-noise scoring per pass
  └─ EMA-based false positive tracker (auto-suppress after 5+ dismissals)
  └─ Outcome logging (JSONL) — foundation for all learning
  └─ Adaptive pass config (skip/reduce low-signal passes)
  └─ Cost-per-accepted-finding metric
      │
Phase 5: Self-Improving Prompts (TextGrad-lite)
  └─ LLM generates prompt diffs from outcome data
  └─ Human-approved A/B testing
  └─ Prompt versioning + auto-revert
      │
Phase 6: Thompson Sampling Bandits
  └─ Multi-armed bandit selects best prompt variant per pass
  └─ Contextual bandits for repo-aware selection
  └─ RLHF-lite weighted reward from deliberation outcomes
  └─ Convergence detection (lock winning variant)
      │
Phase 7: Predictive Strategy
  └─ ML predictions from accumulated data (Phases 3-6)
  └─ Cost optimization before audit starts
  └─ Automated pass/effort/reasoning selection
```

## Dependency Chain

- Phase 1 is standalone (can ship independently)
- Phase 1.5 is standalone (enhances Phase 1 but works without it)
- Phase 2 builds on Phase 1 (uses repo profile for R2+ tuning)
- Phase 3 requires Phase 1-2 (stores their outputs)
- Phase 4 requires Phase 3 (queries stored outcomes) + starts outcome logging immediately (local JSONL)
- Phase 5 requires Phase 4 (uses effectiveness data for refinement)
- Phase 6 requires Phase 4-5 (needs prompt variants to select between + outcome data for rewards)
- Phase 7 requires Phase 3-6 (trains on accumulated data — minimum 50 audit runs)

**Early data collection**: Phase 4's outcome logging (JSONL) should start in Phase 1 — even before cloud DB. Every deliberation result gets appended to `.audit/outcomes.jsonl`. This means Phases 5-6 have training data from day one.

## Cloud Store: Single Source of Truth

After Phase 3, all learning data flows through Supabase:

```
VS Code (Copilot)  ──→                      ←── Terminal (CLI)
Claude Code        ──→   Supabase Cloud     ←── CI/CD pipeline
Cursor / Windsurf  ──→                      ←── Web dashboard (future)
JetBrains          ──→                      ←──

Writes: run results, pass stats, false positives, bandit state, prompt variants
Reads: repo profiles, effectiveness trends, prompt A/B comparisons, bandit selections
```

All IDEs and environments use the same scripts and the same cloud store. Platform-specific instruction files (CLAUDE.md, Agents.md, .github/copilot-instructions.md) are detected automatically via the existing fallback chain.
