# Plan: VS Code GitHub Copilot compatibility audit + fixes

**Status**: Complete — audited + fixed 2026-07-21 (one Gemini-caught regression resolved; pre-existing sync debt deferred).
**Scope**: frontend/tooling — no runtime/DB changes.

## Problem

Audit the repo for seamless operation under GitHub Copilot Agent Skills in VS
Code (GA + default-on since VS Code 1.109, Jan 2026), and fix anything missing
or wrong. Research (official VS Code / GitHub docs, July 2026) established the
current contract; this plan captures the fixes applied.

## Findings & fixes

### 1. Skill `description` exceeded Copilot's hard 1,024-char cap (6 skills)
Copilot Agent Skills enforce **`description` ≤ 1024 chars** and **`name` ≤ 64,
`^[a-z0-9-]{1,64}$`, equal to dir name** (violation = silent skip). Six skill
descriptions were 1,377–2,255 chars (persona-test, click-test, nav-audit, plan,
cycle, brainstorm).

**Fix**: relocate the always-loaded Usage/Examples command syntax from the
level-1 `description` frontmatter into a level-2 `## Usage` section in the SKILL
body (loaded only on invocation). Trigger phrases stay in the description
(they drive selection). Verified: every command-syntax line preserved verbatim
in the body; two genuinely-condensed clauses (persona-test BrightData "external/
anti-bot" note, plan's example arg) restored. All 15 descriptions now ≤1024.
Net always-loaded description weight 15,586 → 11,415 chars.

### 2. `.vscode/mcp.json` missing the mermaid MCP server
VS Code reads `.vscode/mcp.json`, NOT Claude's `.mcp.json`. The mermaid server
was only in `.mcp.json`, so Copilot users lacked mermaid validation.
**Fix**: add the `mermaid` stdio server to `.vscode/mcp.json` (mirrors `.mcp.json`).

### 3. Stale `.github/skills/` mirror shadowing skills (ai-organiser)
Copilot discovers `.github/skills`, `.claude/skills`, `.agents/skills` as peers;
collision precedence across roots is undefined. ai-organiser carried a 2025-era
`.github/skills/` mirror shadowing 3 fresh `.claude/skills` skills.
**Fix**: removed it (gitignored generated content). Root cause documented: the
sync never deletes it in consumers — check both `.github/skills` and
`.agents/skills` on odd consumer Copilot behaviour.

### 4. `.github/prompts/*.prompt.md` shim surface RETIRED
Since VS Code 1.109, skills surface as `/name` slash commands in the SAME
namespace as prompt files — so all 15 same-basename shims collided with their
own skills (undefined winner). Additionally 7 of 15 pointed at non-existent CLIs
(`node scripts/plan.mjs` etc.). Skills are the GA, default-on, cross-harness
surface (VS Code, Copilot CLI, cloud agent, JetBrains).

**Fix**: retire the whole surface.
- Delete generator `scripts/lib/install/copilot-prompts.mjs`, its test
  `tests/copilot-prompts.test.mjs`, reference `skills/ai-context-management/
  references/prompt-file-format.md` (+ its index row), and the 15
  `.github/prompts/*.prompt.md` files.
- Strip prompt generation/prune from `scripts/regenerate-skill-copies.mjs`.
- Strip prompt wiring from sync: `scripts/sync-to-repos.mjs` (COPILOT_PROMPT_FILES
  + NON_CODE_FILES spread + `.github/prompts/** text eol=lf` consumer gitattributes
  pin), `scripts/lib/sync-inventory.mjs` (buildCopilotPromptFiles + `_internals`).
- Retire GENERATE_PROMPTS mode from the ai-context-management skill (frontmatter,
  Step 0 mode table, Step 3 section, renumber steps).
- Update tests (ai-context-management, sync-banner, sync-gitattributes), the
  arch-memory held-out fixture (drop the `parseSkillFrontmatter` probe), the
  check-stale-skill-surface fix message, `.gitattributes` comment.
- Update live docs: README (3 surface tables), AGENTS.md (reframe collision as
  retirement rationale), consumer-adoption runbook (3 refs), click-test skill
  deployment notes.

### Consumer cleanup (separate, no automatic mechanism)
The sync only ADVISES on orphaned tracked consumer files — it never deletes
them. So `.github/prompts/*.prompt.md` (15 tracked files in each of wine-cellar-app
and ai-organiser) must be `git rm`'d in each consumer repo directly.

## Non-goals / accepted scope boundaries
- Do NOT push level-2 SKILL bodies into level-3 references (usage is needed on
  ~every invocation; level 2 is its correct home).
- Historical `docs/plans/*.md`, `status.md`, and eval `known-defects*.json`
  references to the retired surface are left as-is (history records).
- `.github/prompts` prefix in `sync-path-map.mjs` STAYS_AT_CANONICAL_PATH_PREFIXES
  left in place (inert passthrough for a now-absent path; removing it would
  churn sync-path-map tests for zero behavioural gain).

## Audit outcome (2026-07-21)

`/audit-code --scope diff` round 1 → 8 findings, ALL pre-existing debt in the
two sync files the diff touched (sync-to-repos ↔ sync-inventory duplication;
`syncMigrations()` bare-catch; `.github/skills` advisory removal). Impact-tested
as independent/out-of-scope → deferred. The Gemini final gate **endorsed** those
defers (`wrongly_dismissed: []`, no over-engineering flags) but caught one
genuine in-scope HIGH that GPT missed:

- **RESOLVED — `skills-help.mjs::parseSkill` broke on the Usage relocation.**
  It scraped `usage`/`triggers` only from the frontmatter `description`; moving
  Usage into the `## Usage` body emptied it (feeds `docs/SKILLS-INDEX.md`).
  Fix: `parseSkill` now falls back to the body `## Usage` fenced block when the
  description has none. Covered by a regression test in `tests/skills-help.test.mjs`;
  `SKILLS-INDEX.md` regenerates byte-identical (usage fully restored).

Deferred pre-existing debt (independent of this change; tracked, not fixed here):
sync-to-repos/sync-inventory config duplication; `syncMigrations()` swallowing
non-ENOENT errors; automating deprecated-root removal (the advise-then-manual
convention predates this change — see `.github/skills` deprecation).

## Acceptance criteria
- `npm run skills:check` and `regenerate-skill-copies --check` exit 0.
- No code/test reference to `copilot-prompts`, `generateAllPromptFiles`,
  `SKILL_ENTRY_SCRIPTS`, `generatePromptFile`, `buildCopilotPromptFiles`.
- All 15 skill descriptions ≤ 1024 chars; `name` == dir name; LF; no BOM.
- Sync dry-run resolves with no errors and ships zero `.github/prompts` files.
- `.vscode/mcp.json` contains both playwright and mermaid servers.
