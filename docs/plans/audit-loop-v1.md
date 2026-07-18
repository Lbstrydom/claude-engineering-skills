# Plan: Claude Audit Loop v1.0
- **Date**: 2026-03-25
- **Status**: Complete
- **Author**: Claude + Louis
- **Scope**: Multi-model plan/code audit tool with peer deliberation

---

## 1. Context Summary

### Purpose
A portable, self-driving quality loop where one AI assistant (Claude/Copilot) plans and fixes,
while GPT-5.4 independently audits. The two models operate as peers with structured deliberation.

### Key Requirements
1. Plan auditing — check plan quality before implementation (SOLID, DRY, Gestalt, sustainability)
2. Code auditing — verify implementation matches plan (multi-pass parallel for speed)
3. Peer deliberation — assistant can accept/challenge/compromise on findings
4. Rebuttal resolution — GPT can sustain/overrule/compromise
5. Adaptive sizing — token limits and timeouts scale to codebase size
6. Graceful degradation — failed passes don't crash the audit
7. Quick-fix detection — band-aids flagged and rejected by both models
8. Portable — works with Claude Code, VS Code Copilot, or raw terminal

---

## 2. Proposed Architecture

### 2.1 Core Script: `scripts/openai-audit.mjs`

Three modes:
- `plan` — Single GPT call to audit plan quality (structured output via Zod)
- `code` — Multi-pass parallel audit (5 passes in 3 waves)
- `rebuttal` — Send assistant's challenges to GPT for resolution

### 2.2 Multi-Pass Code Audit Architecture

```
Wave 1 (parallel, reasoning: low):
  ├── structure: files exist, exports match plan
  └── wiring: frontend API calls ↔ backend routes

Wave 2 (parallel, reasoning: high):
  ├── backend: SOLID, DRY, security, async, DB queries
  └── frontend: Gestalt, CSP, accessibility, state coverage

Wave 3 (sequential, reasoning: medium):
  └── sustainability: quick fixes, dead code, coupling
```

Large backends (>12 files) auto-split into routes + services sub-passes.

### 2.3 Adaptive Sizing

`computePassLimits(contextChars, reasoning)` calculates per-pass:
- `maxTokens` = base 4000 + (inputTokens × reasoningMultiplier), capped at 32K
- `timeoutMs` = (maxTokens / tokensPerSec + 30s buffer), capped at 300s

Reasoning multipliers: high=0.4, medium=0.25, low=0.1
Generation speed: high=150 tok/s, medium=200 tok/s, low=250 tok/s

### 2.4 Graceful Degradation

`safeCallGPT()` wraps every pass call — catches timeout/parse/API errors and returns
empty findings instead of crashing. Failed passes reported in `_failed_passes` output.

### 2.5 Skills (Two Formats)

| Location | Format | Consumer |
|----------|--------|----------|
| `.claude/skills/audit-loop/SKILL.md` | Claude Code YAML frontmatter | Claude Code CLI + VS Code extension |
| `.github/skills/audit-loop/SKILL.md` | VS Code Copilot YAML frontmatter | VS Code Copilot Chat |

Both skills contain identical orchestration logic — only frontmatter differs.

### 2.6 Setup Script: `setup.mjs`

Interactive installer that:
1. Checks prerequisites (Node 18+, npm)
2. Detects target project directory
3. Installs npm dependencies (openai, zod, dotenv)
4. Copies script + both skill formats
5. Sets up .env with API key prompt
6. Adds .env to .gitignore

---

## 3. File-Level Plan

### `scripts/openai-audit.mjs`
- **Purpose**: GPT-5.4 audit caller with multi-pass parallel architecture
- **Key exports**: None (CLI script)
- **Key functions**:
  - `computePassLimits(contextChars, reasoning)` — adaptive token/timeout sizing
  - `measureContextChars(filePaths, maxPerFile)` — measure file sizes for sizing
  - `extractPlanPaths(planContent)` — regex-driven file path extraction from any plan
  - `readFilesAsContext(filePaths, opts)` — read files with truncation and total cap
  - `classifyFiles(filePaths)` — split into backend/frontend/shared
  - `callGPT(openai, opts)` — single structured GPT call with timeout
  - `safeCallGPT(openai, opts, emptyResult)` — graceful degradation wrapper
  - `runMultiPassCodeAudit(openai, planContent, projectContext, jsonMode)` — orchestrator
  - `main()` — CLI entry point, mode routing
- **Schemas**: FindingSchema, PlanAuditResultSchema, PassFindingsSchema, StructurePassSchema, WiringPassSchema, SustainabilityPassSchema, CodeAuditResultSchema, RebuttalResolutionSchema
- **Dependencies**: openai, zod (zodTextFormat), dotenv/config, fs, path

### `.claude/skills/audit-loop/SKILL.md`
- **Purpose**: Claude Code orchestration skill
- **Key sections**: Mode parsing, GPT audit invocation, Claude deliberation (accept/partial/challenge), rebuttal flow, fix classification, convergence loop, failed pass recovery
- **Dependencies**: scripts/openai-audit.mjs

### `.github/skills/audit-loop/SKILL.md`
- **Purpose**: VS Code Copilot orchestration skill (same logic, different frontmatter)
- **Key sections**: Same as Claude Code skill
- **Dependencies**: scripts/openai-audit.mjs

### `setup.mjs`
- **Purpose**: Interactive project installer
- **Key functions**:
  - `checkNode()`, `checkNpm()`, `checkGit()` — prerequisite checks
  - `checkDependencies(targetDir)` — scan package.json for missing deps
  - `installSkills(targetDir, sourceDir)` — copy both skill formats
  - `installScript(targetDir, sourceDir)` — copy audit script
  - `setupEnv(targetDir)` — create/update .env with API key
- **Dependencies**: fs, path, child_process, readline

### `package.json`
- **Purpose**: Dependency manifest for standalone use
- **Type**: module (ESM)
- **Dependencies**: openai ^6.17.0, zod ^4.0.0, dotenv ^17.0.0

### `.env.example`
- **Purpose**: Template showing all configurable environment variables
- **Content**: OPENAI_API_KEY + all optional overrides with defaults

---

## 4. Sustainability Notes

### Assumptions
- GPT-5.4 remains available on OpenAI Responses API
- Zod structured output continues to work with `zodTextFormat()`
- VS Code Copilot skills format (`.github/skills/`) is stable

### Extension Points
- `OPENAI_AUDIT_MODEL` env var allows swapping to future models without code change
- Pass system prompts are separate constants — easy to customize per-project
- Schema definitions are modular — add new pass types by adding schema + prompt + wave entry
- `computePassLimits` heuristics can be tuned via env vars without touching code

---

## 5. Testing Strategy

### Manual Verification
- Plan audit: Run against a real plan file, verify findings are actionable
- Code audit: Run against implemented plan, verify files are found and analyzed
- Rebuttal: Create mock rebuttal, verify GPT resolution is structured
- Adaptive sizing: Test with projects of different sizes (3 files vs 25+)
- Graceful degradation: Verify failed passes produce empty findings, not crashes
- Setup script: Run against clean project, verify all files installed correctly

### Key Edge Cases
- Plan with no file paths (regex finds nothing)
- Missing OPENAI_API_KEY (clear error message)
- All passes fail (still produces valid JSON output with 0 findings)
- Huge files (truncation works correctly)
- Backend with exactly 12 files (split threshold boundary)
- Project without package.json (setup creates one)
