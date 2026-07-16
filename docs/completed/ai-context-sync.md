# Plan: AI Context Sync — Reconcile Drift, Detect Drift, Copilot Slash-Command Parity
- **Date**: 2026-04-26
- **Status**: **Complete** (all 6 phases shipped 2026-04-26 / 2026-04-27)
- **Author**: Claude + Louis
- **Audit trail**: 5× GPT-5.4 R1 audits at phase boundaries (15 in-scope fixes applied; rest deferred / out-of-scope / dismissed). Initial gap: Gemini final review skipped at all 5 audit points — closed retroactively via `npm run audit:full` wrapper + memory entry; structural fix prevents recurrence.

## Implementation Log

### 2026-04-26 — Phases 1, 2, 6, 4, 3 (PR-sequence order)

- **Phase 1 — Reconcile + Slim**: Flipped canonical CLAUDE.md → AGENTS.md. AGENTS.md 360 lines (canonical), CLAUDE.md 41 lines (`@./AGENTS.md` import + Claude-only addenda). `scripts/lib/context.mjs` `INSTRUCTION_FILE_CANDIDATES` reads AGENTS.md first.
- **Phase 2 — Drift Detector**: `scripts/check-context-drift.mjs` with 4 ctx/* rules + Zod config + CommonMark fence-length parser + SARIF output. 35 tests. `.github/workflows/context-drift.yml` PR + weekly.
- **Phase 6 — Model Pool Freshness Gate**: `scripts/check-model-freshness.mjs` reuses existing `refreshModelCatalog()`. New `getLiveCatalog` export. Wired default-on into 3 entry-points with `MODEL_CATALOG_REFRESH=skip` opt-out. 23 tests. `.github/workflows/model-freshness.yml` weekly.
- **Phase 4 — Decommission `.github/skills/`**: `--keep-github-skills` rollback flag on both `regenerate-skill-copies.mjs` and `sync-to-repos.mjs`. Deprecation warnings.
- **Phase 3 — Copilot Prompt Shims**: `scripts/lib/install/copilot-prompts.mjs` with `SKILL_ENTRY_SCRIPTS` registry generates `.github/prompts/<name>.prompt.md`. 20 tests. YAML-safe description quoting.

### 2026-04-26 — Phase 5: ai-context-management skill

- `skills/ai-context-management/SKILL.md` orchestrates 5 modes (audit, reconcile, generate-prompts, revise, migrate)
- 4 references + 3 examples with byte-matched `summary:` frontmatter
- 30 skill-structure tests; integration coverage via underlying CLI tests (78 total across drift, freshness, copilot-prompts)

### 2026-04-27 — Audit-process retrospective fix + audit-loop split

- All 5 phase audits ran GPT only (Gemini skipped — same systemic bug). Closed gap retroactively with `npm run audit:full` (fused GPT+Gemini wrapper). Memory entry `feedback_gemini_review_skipped.md` records the failure mode.
- Audit-loop skill split shipped as a separate plan ([audit-loop-skill-split.md](./audit-loop-skill-split.md)) — adds `/audit-plan` and `/audit-code` as separate skills with `/audit-loop` as a thin orchestrator. New entries added to SKILL_ENTRY_SCRIPTS. Total: 9 skills.

### Acceptance criteria — all 12 met (live-verified)

| § | Criterion | Result |
|---|---|---|
| 1 | AGENTS.md / CLAUDE.md no drift | 360 / 41 lines, `context:check` OK |
| 2-3 | PR-time + weekly drift gating | both triggers in workflow |
| 4 | Copilot prompt shims | 9 prompt files |
| 5-6 | `.github/skills/` deprecation + rollback | flag + warnings present |
| 7 | ≥29 skill tests | 30 tests |
| 8 | skills:check green | 9/9 skills lint clean |
| 9-10 | Model freshness | script + workflow + wired entry-points |
| 11 | All tests pass | 1125/1126 (1 pre-existing) |
| 12 | Consumer-repo install end-to-end | sync dry-run ships all files |

---

## 1. Context Summary

### 1.1 The trigger

A pre-implementation check found that `AGENTS.md` (269 lines) and `CLAUDE.md` (353 lines) in this repo share the same first heading (`# CLAUDE.md - Claude Engineering Skills`) — meaning AGENTS.md was once a copy of CLAUDE.md — but have drifted by 84 lines over the last 4 days:

| What | Status in CLAUDE.md (Apr 23) | Status in AGENTS.md (Apr 19) |
|---|---|---|
| Model Resolution section (~60 lines) | Present | **Missing** |
| Memory-Health Gate section (~25 lines) | Present | **Missing** |
| Env-var defaults | `latest-gpt`, `latest-pro` sentinels | Stale: `gpt-5.4`, `gemini-3.1-pro-preview`, `claude-opus-4-1` |

`git log --oneline -10 -- AGENTS.md CLAUDE.md` returns 10 CLAUDE.md commits and 0 AGENTS.md commits. No automation in the repo aligns them.

**Impact today**: teammates on GitHub Copilot in VS Code (Copilot reads `AGENTS.md` natively at workspace root) are operating against 4-day-stale, partially incorrect instructions whenever they work in this repo or any consumer repo whose AGENTS.md was sourced from here.

### 1.2 The user goal

Louis is on Claude Code + Claude in VS Code. Teammates are on GitHub Copilot in VS Code. They consume the skills bundle in downstream repos (via `bootstrap.mjs`). Goal: shared project context that doesn't drift between Claude and Copilot views, plus a way for Copilot teammates to invoke the skills (the skills today are Claude-only slash commands).

### 1.3 Existing infrastructure (do not duplicate)

| File / module | What it does | Reusable for this plan? |
|---|---|---|
| `scripts/lib/install/merge.mjs` | Block-marker merge for consumer-repo `.github/copilot-instructions.md` (start/end markers around managed block) | Yes — Phase 3 reuses the merge primitive |
| `scripts/lib/claudemd/file-scanner.mjs` | Recursively scans for `**/CLAUDE.md`, `**/AGENTS.md`, `.github/copilot-instructions.md`, `.claude/skills/*/SKILL.md`, `.github/skills/*/SKILL.md`. Excludes `node_modules`, `.git`, fixtures, etc. | Yes — Phase 2 drift detector uses this directly |
| `scripts/lib/claudemd/sarif-formatter.mjs` | SARIF output for findings | Yes — Phase 2 emits SARIF for CI annotations |
| `scripts/install-skills.mjs` | Consumer-repo install: writes `.audit-loop/` CLI + merges copilot-instructions block | Phase 3 extends to also write `.github/prompts/*.prompt.md` |
| `scripts/sync-to-repos.mjs` | Mirrors `.claude/skills/<name>/` AND `.github/skills/<name>/` to consumer repos | Phase 4 audits whether the `.github/skills/` half is dead weight |
| `claude-md-improver` skill (user plugins) | Audits CLAUDE.md quality with 6-criterion rubric | Phase 5 (optional) extends the rubric for AGENTS.md + drift |

### 1.4 What is genuinely missing

1. No alignment automation between `AGENTS.md` and `CLAUDE.md` within a single repo.
2. No drift detector in CI.
3. No way for Copilot teammates to invoke the skills as slash commands (`/audit-loop` etc.) — only Claude users get that surface today.
4. Unclear whether `.github/skills/<name>/SKILL.md` (currently shipped to consumers by `sync-to-repos.mjs`) is read by any tool. VS Code Copilot does not read it per its public docs (`.github/instructions/`, `.github/prompts/`, `.github/copilot-instructions.md`, `AGENTS.md` only).

### 1.5 What this plan is NOT

- **Not** a content rewrite of CLAUDE.md or AGENTS.md beyond reconciling drift.
- **Not** a Copilot-native rewrite of skill orchestration. Copilot teammates run the same CLI underneath; they don't get Claude's progressive-disclosure UX.
- **Not** new audit logic — `claude-md-improver` already covers quality scoring.

---

## 2. Proposed Architecture

### 2.1 Canonical relationship (this repo and any repo using the skills)

```
<repo>/
├── AGENTS.md                              ← canonical project context (shared)
│                                            Read natively by: Copilot, Cursor,
│                                            Windsurf, Codex CLI, Gemini CLI,
│                                            VS Code chat. Read by Claude
│                                            via @import in CLAUDE.md.
│
├── CLAUDE.md                              ← thin: Claude-only addendum
│                                            (~30 lines). First non-frontmatter
│                                            line: `@./AGENTS.md`
│                                            Body: slash-command notes, hooks,
│                                            #-key learnings, anything that
│                                            won't help Copilot.
│
├── .github/
│   ├── copilot-instructions.md            ← OPTIONAL in this repo (Copilot
│   │                                        already reads AGENTS.md). In
│   │                                        consumer repos: managed by
│   │                                        existing merge.mjs block.
│   │
│   └── prompts/                           ← NEW. Copilot slash-command shims.
│       ├── audit-loop.prompt.md            Each ~15-30 lines. Wraps the
│       ├── plan-backend.prompt.md          underlying CLI: `node .audit-loop/
│       ├── plan-frontend.prompt.md         scripts/<x>.mjs ...`. Copilot
│       ├── persona-test.prompt.md          shows them as /<name> in chat.
│       ├── ux-lock.prompt.md
│       └── ship.prompt.md
│
└── .claude/
    └── skills/<name>/                     ← unchanged — authoritative SKILL.md
                                             + references/ + examples/ as
                                             established in Phase B/C of
                                             skill-progressive-disclosure-refactor
```

### 2.2 Why AGENTS.md becomes canonical (not CLAUDE.md)

The current state has CLAUDE.md as canonical and AGENTS.md as a stale copy. Reverse it because:

- The shared file is what the wider ecosystem agreed on as `AGENTS.md` (Linux Foundation / Agentic AI Foundation standard, read natively by every major coding agent).
- Calling the canonical file `CLAUDE.md` produces drift via the action of editing — the natural file to edit when adding shared content like "Model Resolution" is the one that says it's for Claude. Reversing that puts the natural editing target on the canonical file.
- Claude reads AGENTS.md transitively via `@./AGENTS.md` import (Claude convention supports this), so no Claude functionality is lost.

### 2.3 Drift detection strategy

Two-pronged: **structural** (cheap, deterministic) and **semantic** (optional, only if structural is insufficient).

**Structural rule**: CLAUDE.md must contain only an `@./AGENTS.md` import + a small allowlist of Claude-only section headings (`## Slash Commands`, `## Hooks`, `## Local Overrides`, `## Memory & #-key`, etc.). Any other top-level heading in CLAUDE.md is a drift violation. Any content present in CLAUDE.md but not AGENTS.md outside the allowlist is a drift violation.

This makes drift impossible-to-introduce-accidentally rather than detectable-after-the-fact.

**Semantic check (optional, Phase 2.5)**: when consumer repos can't be made to follow the structural rule (e.g. legacy CLAUDE.md), normalize headings + diff body content. Flag headings that exist in both files with different content.

**Subdirectory rules (decision recorded 2026-04-26)**: only the **root-level** `AGENTS.md` requires a slim sibling `CLAUDE.md` with `@./AGENTS.md` import. Subdirectory `AGENTS.md` files (e.g. `packages/foo/AGENTS.md`) are auto-discovered by both Copilot and Claude as scoped guidance — no sibling `CLAUDE.md` needed. Drift detector responsibilities for subdirectories: enforce size (≤150 lines per Augment Code's empirical sweet spot), enforce reasoned-rules (every rule has a `Reason:` line), check size cap. If a subdirectory *does* have both `AGENTS.md` and `CLAUDE.md`, apply the same alignment + import + allowlist rules as root.

Rationale: forcing per-subdirectory CLAUDE.md doubles file count in monorepos with no functional benefit — Claude already cascades CLAUDE.md from root + auto-discovers nested CLAUDE.md if present. The shared content layer (AGENTS.md) is what matters for Copilot teammates; having a single root `CLAUDE.md` with `@./AGENTS.md` plus root + per-package `AGENTS.md` files gives both tools complete coverage.

### 2.4 Copilot prompt-file shims (the actual user value)

Each skill gets a generated `.github/prompts/<name>.prompt.md` of the form:

```markdown
---
description: <copy from skill SKILL.md frontmatter description>
mode: agent
---
# /<skill-name>

<short purpose, 2-3 lines from SKILL.md>

## Run

Invoke the underlying engineering skills CLI:

\`\`\`bash
node .audit-loop/scripts/<entry-script>.mjs ${input:args}
\`\`\`

For full skill flow (progressive disclosure, multi-pass orchestration), use Claude Code with `/<skill-name>`. This prompt provides CLI parity for VS Code Copilot users.
```

Generation source: introspect each `skills/<name>/SKILL.md` frontmatter. Entry-script mapping is a small registry in the generator (skill name → script name) — only ~6 entries.

Limitation acknowledged: prompt files don't have progressive-disclosure (`references/` loaded on demand). Copilot users get the CLI output and the skill's headline doc. For complex multi-turn flows like `audit-loop`'s 5-pass deliberation, they get structured CLI output — not the conversational fix-iterate loop. This is acceptable because the audit-loop CLI already produces structured JSON + ledger + Supabase writes; the conversational layer in Claude is on top.

### 2.5 Decommission decision (Phase 4)

If verification confirms `.github/skills/<name>/SKILL.md` is read by no tool (Copilot doesn't list it; Claude in VS Code reads `.claude/skills/`), drop it from `sync-to-repos.mjs`. Reduces consumer-repo file count by 50% for the skills surface.

---

## 3. Phase 1 — Reconcile + Slim (this-repo housekeeping)

**Goal**: stop the bleed today. ~30 minutes.

**Principle**: Do No Harm to existing references. Both files are checked into git and referenced by audit-loop's brief generator.

### 3.1 Reconcile: bring AGENTS.md current

1. Diff CLAUDE.md → AGENTS.md (already done in 1.1). Identify additions:
   - `## Model Resolution` section (commit `900f58e`) — copy verbatim.
   - `## Memory-Health Gate` section (commit `eeceb87`) — copy verbatim.
   - Env-var table updates (sentinels, `META_ASSESS_MODEL`, `META_ASSESS_GPT_FALLBACK` rows, `MEMORY_HEALTH_*` rows) — replace stale rows in AGENTS.md.
2. Apply via `Edit` tool against AGENTS.md only. Do not touch CLAUDE.md yet (Step 3.2 will).
3. Verify: `diff AGENTS.md CLAUDE.md` should now show only the heading-1 line and any Claude-only addenda yet to move.

### 3.2 Slim CLAUDE.md to Claude-only addendum

After 3.1, CLAUDE.md and AGENTS.md are content-identical. Now extract Claude-only material from AGENTS.md back to CLAUDE.md and replace the body of CLAUDE.md with a thin pointer:

```markdown
# CLAUDE.md — Claude-Specific Addendum

@./AGENTS.md

## Claude-only Notes

[anything truly Claude-specific: skill discovery hints,
 #-key auto-incorporation reminders, hooks, slash commands.
 Most of CLAUDE.md as it stands today is shared content
 and belongs in AGENTS.md, not here. Target: ≤30 lines.]
```

Audit existing CLAUDE.md for truly Claude-only content. Candidates by inspection:
- The `# auto memory` section (system-prompt injected — but that's harness-level, not a CLAUDE.md concern). Confirm whether to move.
- `## Code Style` rule "Use Edit tool for X" (Claude-specific tool advice — keep).
- `## Do NOT` list (mostly Zod 4 conventions — actually shared, move to AGENTS.md).
- The model-resolution warnings (shared, move to AGENTS.md).

Final CLAUDE.md target: 25-40 lines. Verify by counting after slim.

### 3.3 Update brief generator and any other readers

`scripts/lib/context.mjs` reads CLAUDE.md to generate audit briefs (per `grep` results in 1.3). Verify the brief generator follows the `@./AGENTS.md` import OR is updated to read AGENTS.md directly. If neither, the brief loses 84 lines of shared context.

**Action**: read `scripts/lib/context.mjs` for the CLAUDE.md parser. If it doesn't follow imports, switch the read path to `AGENTS.md` (which now holds shared content) and treat CLAUDE.md as supplementary.

### 3.4 Acceptance — Phase 1

- [ ] `wc -l AGENTS.md CLAUDE.md` shows AGENTS.md ≥ 350 lines, CLAUDE.md ≤ 40 lines.
- [ ] `diff AGENTS.md CLAUDE.md` shows only frontmatter/heading differences (no content drift).
- [ ] `npm run audit:brief` (or whatever brief CLI exists) produces a brief that includes both Model Resolution and Memory-Health content.
- [ ] All existing tests pass (`npm test`).

---

## 4. Phase 2 — Drift Detector + CI Wire-Up

**Goal**: prevent re-occurrence. ~2 hours including tests.

### 4.1 New script: `scripts/check-context-drift.mjs`

CLI:
```bash
node scripts/check-context-drift.mjs [--repo <path>] [--format text|json|sarif] [--strict]
```

Algorithm:

1. Resolve repo root (default cwd or `--repo`).
2. Use `scanInstructionFiles()` from `lib/claudemd/file-scanner.mjs` to find `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md` (per repo, plus subdirectory `AGENTS.md`/`CLAUDE.md` files in monorepos).
3. For each `(AGENTS.md, CLAUDE.md)` pair sharing a directory:
   - **Check 1: import** — CLAUDE.md must contain `@./AGENTS.md` (or equivalent `@AGENTS.md`) on a non-comment line within the first 10 lines. **Severity: HIGH.**
   - **Check 2: allowlist** — every `##` heading in CLAUDE.md must match the Claude-only allowlist (`Slash Commands`, `Hooks`, `Local Overrides`, `Memory`, `Claude-only Notes`, configurable via `.claude-context-allowlist.json`). **Severity: HIGH.**
   - **Check 3: size** — CLAUDE.md ≤ 80 lines (config: `maxClaudeMdLines`). **Severity: MEDIUM.**
   - **Check 4: drift** — for any `##` heading appearing in both AGENTS.md and CLAUDE.md, content must match within whitespace tolerance. **Severity: HIGH.**
4. For `.github/copilot-instructions.md` (if present and not just a managed block):
   - **Check 5: managed-block intact** — extract via `mergeBlock.extractBlock()`; if user content drifted from AGENTS.md by more than the managed block, **WARN.**
5. Output:
   - **text** (default): human-readable report, exit code 0 if green, 1 if any HIGH, 2 if MEDIUM only.
   - **json**: structured findings array.
   - **sarif**: via `lib/claudemd/sarif-formatter.mjs` for GitHub Code Scanning annotations.

### 4.2 Tests (`tests/check-context-drift.test.mjs`)

Use `tests/claudemd/fixtures/` (already exists per glob in 1.3 — `tests/claudemd/fixtures/dup/AGENTS.md`). Add fixtures:
- `aligned/` — proper AGENTS.md + slim CLAUDE.md → 0 findings
- `drift-missing-import/` → CLAUDE.md without `@./AGENTS.md` → HIGH
- `drift-shared-section/` → both files contain `## Model Resolution` with different bodies → HIGH
- `drift-bloated-claude/` → CLAUDE.md > 80 lines with shared sections → HIGH + MEDIUM
- `monorepo/` → root AGENTS.md + packages/foo/AGENTS.md (subdirectory) → both checked independently

Target: 8-10 tests in node:test format, following the existing pattern in `tests/shared.test.mjs`.

### 4.3 npm wire-up (`package.json`)

Add scripts:
```json
"context:check": "node scripts/check-context-drift.mjs --strict",
"context:check:json": "node scripts/check-context-drift.mjs --format json",
"context:check:sarif": "node scripts/check-context-drift.mjs --format sarif"
```

Wire `context:check` into the existing `test` or `pretest` chain. Recommendation: keep tests fast — add to a new `npm run check` umbrella that includes `context:check` + `skills:check` (existing) + `test`.

### 4.4 GH Action (`.github/workflows/context-drift.yml`)

**Decision recorded 2026-04-26**: PR-gated, not weekly-only. Drift gets large fast (84 lines in 4 days) — weekly cron alone would let multiple drift events stack between checks. Hybrid approach:

- **PR check** (primary, fast-fail): runs on every PR via the existing CI workflow. Exits non-zero on any HIGH finding. SARIF output uploaded via `@github/codeql-action/upload-sarif` so findings appear inline as PR review comments. Median runtime target: <5 sec (pure-static comparison, no network calls).
- **Weekly Monday 09:00 UTC cron** (safety net): catches main-branch commits that bypassed PR (direct pushes), and surfaces drift in repos without active PR activity. Posts a sticky issue with label `context-drift` when any HIGH fires; auto-closes when green. Mirrors `memory-health.yml` pattern.

PR check is required (blocking); weekly cron is informational only (issue post, no force-fail). This keeps the developer feedback loop tight without making the weekly cron a noisy interruption.

### 4.5 Acceptance — Phase 2

- [ ] `node scripts/check-context-drift.mjs` exits 0 on this repo after Phase 1.
- [ ] All 8-10 fixture tests pass.
- [ ] `context:check:sarif` produces valid SARIF parseable by `@github/codeql-action/upload-sarif`.
- [ ] GH Action runs on the next Monday cron and either silences or opens an issue.

---

## 5. Phase 3 — Copilot Prompt-File Shims

**Goal**: give Copilot-in-VS-Code teammates `/audit-loop`, `/plan-backend`, etc. as slash commands. ~3 hours.

### 5.1 New module: `scripts/lib/install/copilot-prompts.mjs`

Exports:
```javascript
export function generatePromptFile(skillName, skillFrontmatter, scriptEntry) { ... }
export function generateAllPromptFiles(skillsDir, opts) { ... }
```

Skill → entry-script registry (the only hand-maintained piece):
```javascript
const SKILL_ENTRY_SCRIPTS = {
  'audit-loop': { script: 'openai-audit.mjs', argsHint: '--code <file> [--round N]' },
  'plan-backend': { script: 'plan-backend.mjs', argsHint: '<task description>' },
  // ... 6 entries total
};
```

Each generated `.github/prompts/<name>.prompt.md` is ~20 lines, emits a managed-block header (`<!-- audit-loop-bundle:start -->...<!-- end -->`) so re-installs replace it idempotently.

### 5.2 Hook into `scripts/install-skills.mjs`

Today the consumer-repo install:
1. Writes `.audit-loop/` CLI tree.
2. Merges block into `.github/copilot-instructions.md`.

Add step 3: write/refresh `.github/prompts/<skill>.prompt.md` for each registered skill. Files are plain shims — no merge needed if they're entirely managed (overwrite policy: managed-block wraps the whole file content, just like copilot-instructions does).

### 5.3 Tests (`tests/copilot-prompts.test.mjs`)

- Generate prompt for each skill from a fixture SKILL.md.
- Output is valid `.prompt.md` (frontmatter parseable, has a fenced bash block).
- Re-running generation with no SKILL.md changes is idempotent (byte-equal output).
- Re-running after SKILL.md frontmatter change updates the prompt.

### 5.4 Manual validation

In a consumer repo:
1. Run `node .audit-loop/bootstrap.mjs install --surface both`.
2. Open the repo in VS Code with GitHub Copilot.
3. In Copilot chat, type `/` — verify `/audit-loop`, `/plan-backend`, etc. appear.
4. Run `/audit-loop` with a simple input — verify it shells out to `node .audit-loop/scripts/openai-audit.mjs ...` and returns output.

### 5.5 Acceptance — Phase 3

- [ ] All 6 skills generate valid prompt files.
- [ ] Consumer-repo install ships them at `.github/prompts/`.
- [ ] Manual validation in a Copilot-enabled VS Code workspace shows them as slash commands.
- [ ] Re-install is idempotent (no spurious diffs).

---

## 6. Phase 4 — Verify and Decommission `.github/skills/<name>/`

**Goal**: ~1 hour. Cheap, reduces consumer-repo file count by ~50% on the skills surface.

### 6.1 Verification

1. Read VS Code Copilot docs and GitHub Docs for any reference to `.github/skills/`. Current docs do not mention it (`.github/instructions/`, `.github/prompts/`, `.github/copilot-instructions.md`, `AGENTS.md` are the documented locations).
2. Test in a clean VS Code workspace with only `.github/skills/<name>/SKILL.md` present (no other Copilot config). Try `/<name>` in Copilot chat. Expectation: not recognized.
3. Cross-check with the `claude-md-management` plugin — if its scanner finds `.github/skills/`, that's a Claude-side convention, not Copilot. Confirm by reading its code.

### 6.2 Decommission with rollback safety (decision recorded 2026-04-26)

**Failure mode requirements** (Louis Q4):
- Must not fail silently — if a teammate relies on `.github/skills/` (e.g. some IDE we don't know about reads it), they get a visible signal, not a mystery breakage.
- Must be reversible per-install — a flag preserves old behavior for one release.

Steps:

1. **Add deprecation warning to `install-skills.mjs`**: when consumer repo has existing `.github/skills/<name>/` files but install is about to skip writing them, log to stderr:
   ```
   [install] DEPRECATION: .github/skills/ is no longer maintained (no documented
             tool reads it). To preserve existing files for one more release, run:
               node .audit-loop/bootstrap.mjs install --keep-github-skills
             Existing files will not be deleted by this install.
   ```
   The warning fires whether or not `--keep-github-skills` is passed — operators see it on every install until they remove the directory or opt-in to keeping it.

2. **Add `--keep-github-skills` flag** (one-release escape hatch). Install flow when flag is set: write to BOTH `.claude/skills/` AND `.github/skills/` (current behavior). Flag removed in next minor release.

3. **Edit `scripts/sync-to-repos.mjs`** (default path):
   ```javascript
   // Before
   out.push(`.claude/skills/${name}/${rel}`, `.github/skills/${name}/${rel}`);
   // After
   out.push(`.claude/skills/${name}/${rel}`);
   if (opts.keepGithubSkills) out.push(`.github/skills/${name}/${rel}`);
   ```

4. **Update `scripts/build-manifest.mjs`** if it emits both surfaces.

5. **Update CLAUDE.md/AGENTS.md** to remove the `.github/skills/<name>/` reference from the "Skill file structure" section, document the deprecation in `CHANGELOG.md`.

6. **Don't delete existing `.github/skills/` directories in consumer repos** — orphan but harmless. Document in CHANGELOG that operators can `rm -rf .github/skills/` once they confirm nothing reads it.

7. **Rollback recovery**: if a downstream user reports breakage, the immediate fix is `--keep-github-skills` flag on next install (their files come back). The change is fully reversible by reverting one PR.

### 6.3 Acceptance — Phase 4

- [ ] Verification documented in plan with finding (vestigial or not).
- [ ] If vestigial: sync-to-repos updated, manifest updated, CLAUDE.md/AGENTS.md notes removed.
- [ ] `--keep-github-skills` flag works end-to-end (install with flag still writes both surfaces).
- [ ] Deprecation warning logged at install time when stale `.github/skills/` files detected.
- [ ] CHANGELOG entry explains deprecation, escape hatch, and rollback path.
- [ ] Existing consumer repos: `.github/skills/` directories not deleted by this change.

---

## 7. Phase 5 — `ai-context-management` Skill

**Goal**: package the drift detection + reconcile + prompt-generation as a callable skill so any repo can run it. ~6 hours including tests.

**Decision recorded 2026-04-26**: build it, but with strong test discipline (Louis Q3). The skill is the user-visible UX over Phase 2 + Phase 3 + Phase 5's own modes — it must be reliable. Proceeds in parallel with Phase 4 once Phases 1-3 are green.

### 7.1 Structure (matches Phase B/C house style — see `docs/reference/skill-reference-format.md`)

```
skills/ai-context-management/
├── SKILL.md                              ← canonical flow, ≤3K tokens
├── references/
│   ├── drift-rules.md                    ← allowlist, severity matrix, examples,
│   │                                       subdirectory rules from §2.3
│   ├── reconcile-playbook.md             ← step-by-step: "drifted → green",
│   │                                       includes the Phase 1 reconcile
│   │                                       sequence as canonical doc
│   ├── prompt-file-format.md             ← Copilot .prompt.md spec + frontmatter
│   │                                       reference, per-skill entry-script map
│   └── canonical-flip.md                 ← migration guide: CLAUDE.md → AGENTS.md
│                                           canonical, why and how
└── examples/
    ├── slim-claude-md.md                 ← canonical 30-line CLAUDE.md template
    ├── well-formed-agents-md.md          ← exemplar AGENTS.md showing reasoned
    │                                       rules, ≤150 lines, sections
    └── monorepo-layout.md                ← root + packages/foo/AGENTS.md example
```

Each reference file has `summary:` YAML frontmatter byte-matching the parent SKILL.md's reference-index row. Enforced by `npm run skills:check`.

### 7.2 Modes

| Mode | Maps to | Purpose |
|---|---|---|
| `audit` | `scripts/check-context-drift.mjs` + `claude-md-improver` rubric | Score AGENTS.md, flag drift, report subdirectory file health |
| `reconcile` | new orchestration over Phase 1 work | Interactive: detect drift → propose patch → apply |
| `generate-prompts` | `scripts/lib/install/copilot-prompts.mjs` | Refresh `.github/prompts/` |
| `revise` | extends `revise-claude-md` | Apply session learnings → AGENTS.md by default, CLAUDE.md only for Claude-only material |
| `migrate` | one-shot: legacy CLAUDE.md → AGENTS.md canonical | For repos onboarding to the new structure |

### 7.3 Test discipline (Louis Q3 requirement)

Tests are the gate, not an afterthought. Targets:

**Unit-level tests** (`tests/ai-context-management/skill-modes.test.mjs`):
- `audit` mode: 6 fixture cases (aligned, drift-missing-import, drift-shared-section, drift-bloated-claude, monorepo, legacy-no-agents-md). Each asserts findings count, severity distribution, and exit code.
- `reconcile` mode: 4 cases (auto-mergeable drift, conflict-needs-human, missing-import-add, slim-claude-md-from-bloated). Each asserts the proposed patch matches a golden file.
- `generate-prompts` mode: 6 cases (one per skill — happy path), 3 edge cases (missing entry-script in registry, malformed SKILL.md frontmatter, idempotent re-run).
- `revise` mode: 3 cases (shared learning → AGENTS.md, Claude-only learning → CLAUDE.md, mixed learning → user prompt).
- `migrate` mode: 4 cases (monolithic CLAUDE.md → split, repo with both files in drift → reconcile + slim, repo without AGENTS.md → create from CLAUDE.md, no-op when already canonical).

**Total: ≥23 tests** (vs typical Phase B/C coverage of ~9-15 for similar surface area). Justification: the skill writes to user files; bugs are user-visible.

**Integration tests** (`tests/ai-context-management/integration.test.mjs`):
- Run audit → reconcile → audit again → assert all findings cleared.
- Run audit → generate-prompts → verify prompt files match SKILL.md frontmatter.
- Run revise with mocked LLM (Anthropic API mocked via fixture responses) → verify the routing decision (shared vs Claude-only).
- Cross-skill: invoke from inside a fixture monorepo, verify subdirectory AGENTS.md files are scanned correctly.

**Total: ≥6 integration tests.**

**Acceptance gate**: skill cannot ship until all 29+ tests pass AND `npm run skills:check` passes (reference frontmatter byte-matches SKILL.md).

### 7.4 Acceptance — Phase 5

- [ ] Skill file ≤ 3K tokens (per house style).
- [ ] 4 references files, each with `summary:` frontmatter byte-matching SKILL.md.
- [ ] 2-3 examples files.
- [ ] ≥23 unit tests + ≥6 integration tests, all passing.
- [ ] `npm run skills:check` green.
- [ ] Generated copy in `.claude/skills/` (and `.github/skills/` only if Phase 4 hasn't decommissioned it).
- [ ] `sync-to-repos` installs the skill in consumer repos.
- [ ] Manual end-to-end: invoke `/ai-context-management audit` in a test consumer repo; verify it produces a useful report.
- [ ] Manual end-to-end: invoke `/ai-context-management reconcile` after introducing drift; verify it patches correctly.

---

## 8. Phase 6 — Model Pool Freshness Gate

**Goal**: detect when `STATIC_POOL` in `scripts/lib/model-resolver.mjs` has fallen behind providers' live catalogs. Eliminates the "quarterly manual chore" CLAUDE.md describes today. ~3 hours including tests.

**Trigger** (Louis ad-hoc): the audit-loop already has `refreshModelCatalog()` for live OpenAI/Anthropic/Google catalog fetch (parallel to `c:\git\ai-organiser\src\services\adapters\dynamicModelService.ts` which has the same approach + Groq/DeepSeek/OpenRouter). What's missing is the automation layer: nothing tells operators when the static pool is drifting from the live catalog, and nothing wires the live refresh into entry points by default.

### 8.1 Existing infrastructure (reuse, do not rebuild)

| What exists | Location | Status |
|---|---|---|
| Live catalog fetch (3 providers) | `scripts/lib/model-resolver.mjs` `refreshModelCatalog()` | Production-quality; per-provider timeout, silent fallback, session cache |
| Sentinel resolution | `scripts/lib/model-resolver.mjs` `resolveModel()` | Done |
| Deprecated remap with one-time warning | `scripts/lib/model-resolver.mjs` `deprecatedRemap()` | Done |
| CLI self-check | `node scripts/lib/model-resolver.mjs catalog` | Manual one-shot |
| Static fallback pool | `STATIC_POOL` constant | Hand-maintained quarterly |

**What ai-organiser has that we don't**: stale-while-revalidate caching (background refresh on stale read). Not relevant here — CLI tools are short-lived processes; cache TTL doesn't help.

**What ai-organiser has that we might want**: extra OpenAI-compat providers (Groq, DeepSeek, OpenRouter). Not in scope for this phase — the audit-loop only uses OpenAI/Anthropic/Google. Adding them later is a 1-line registration.

### 8.2 New script: `scripts/check-model-freshness.mjs`

CLI:
```bash
node scripts/check-model-freshness.mjs [--format text|json|sarif] [--strict]
```

Algorithm:

1. Call `refreshModelCatalog()` to populate live cache (uses env keys; silent fallback if missing).
2. For each `(provider, sentinel)` pair in `SENTINEL_TO_TIER`:
   - `staticPick = resolveModel(sentinel)` with live cache empty (force static).
   - `livePick = resolveModel(sentinel)` with live cache populated.
   - If `staticPick !== livePick` → **HIGH** finding: "static pool missing newer `<livePick>` for `<sentinel>`; resolves to stale `<staticPick>`".
3. For each provider: `liveOnly = liveIds - staticPoolIds` filtered for relevant tiers (e.g. `gpt-N+`, `claude-{opus,sonnet,haiku}-N+`, `gemini-N-{pro,flash}`). Report as **MEDIUM**: "live catalog has these IDs not in static pool (consider adding for offline resolution)".
4. For each `DEPRECATED_REMAP` entry: if the deprecated ID appears in any provider's live catalog, **LOW**: "remap entry `<id>` may be premature — provider still serves this model".
5. If a provider's API key is missing → skip provider, log `INSUFFICIENT_DATA` (mirrors memory-health pattern).
6. Output formats: text (human), json, sarif (CI annotations via existing formatter).

### 8.3 Wire `refreshModelCatalog()` into entry points

Today operators must call `refreshModelCatalog()` explicitly. Make it default-on for the audit pipeline so the live pool informs every run:

- `scripts/openai-audit.mjs` `main()` — add `await refreshModelCatalog()` as first awaited call (silent failure).
- `scripts/gemini-review.mjs` `main()` — same.
- `scripts/refine-prompts.mjs` `main()` — same.

Keep the call optional via env var `MODEL_CATALOG_REFRESH=skip` for environments without API quota or air-gapped CI.

### 8.4 Tests (`tests/check-model-freshness.test.mjs`)

Use `nock` or simpler — global `fetch` stub via `globalThis.fetch = mockFetch` for the test process.

- Static pool has all live models → 0 HIGH findings.
- Static pool missing newer Opus (live returns `claude-opus-5-0` which isn't in STATIC_POOL) → flag `latest-opus` drift, **HIGH**.
- Live API returns deprecated ID we already remap → no false positive on remap (only LOW).
- Live API returns ID we remap as deprecated but provider still lists it → flag remap entry as premature, **LOW**.
- Provider API down (mock 503) → INSUFFICIENT_DATA, no false positive.
- API key missing → skip provider gracefully.
- Sentinel resolves identically with both pools → 0 findings.
- Test all 8 sentinels in `SENTINEL_TO_TIER`.

**Total: ≥10 tests.**

### 8.5 npm wire-up + GH Action

Add scripts:
```json
"models:freshness": "node scripts/check-model-freshness.mjs",
"models:freshness:json": "node scripts/check-model-freshness.mjs --format json",
"models:check": "node scripts/check-model-freshness.mjs --strict"
```

Wire `models:check` into `npm run check` umbrella (with `context:check` and `skills:check`).

GH Action `.github/workflows/model-freshness.yml`: weekly Monday 09:00 UTC (mirrors `memory-health.yml`). Uses repo secrets for API keys. Posts sticky issue with label `model-freshness` when HIGH fires; auto-closes when green. **Not** PR-gated (model freshness can lag a few days without harm; PR check would burn API quota on every push).

### 8.6 Acceptance — Phase 6

- [ ] `node scripts/check-model-freshness.mjs` runs against live APIs and produces a report.
- [ ] All ≥10 fixture tests pass with mocked fetch.
- [ ] `refreshModelCatalog()` wired into the 3 entry-point scripts; opt-out via `MODEL_CATALOG_REFRESH=skip`.
- [ ] GH Action runs weekly, opens/closes issue based on findings.
- [ ] CLAUDE.md/AGENTS.md "Refreshing the static pool (quarterly)" note updated to point at the automated check.

---

## 9. Acceptance Criteria — Whole Plan

| Criterion | Phase | How verified |
|---|---|---|
| AGENTS.md and CLAUDE.md no longer drift | 1 | `wc -l` + `diff` post-Phase-1 |
| Drift cannot recur silently | 2 | `npm run context:check` in CI on every PR |
| Drift gating runs both PR-time and weekly | 2 | Both workflows present in `.github/workflows/` and pass dry-run |
| Copilot teammates can invoke skills as slash commands | 3 | Manual test in VS Code workspace |
| `.github/skills/` decision recorded (kept or dropped) | 4 | Plan's Phase 4 section filled in with finding |
| `.github/skills/` deprecation provides rollback flag | 4 | `--keep-github-skills` flag works end-to-end |
| `ai-context-management` skill ships with ≥29 tests | 5 | `npm test` count |
| Skill has `references/` + `examples/` per house style | 5 | `npm run skills:check` green |
| Static model pool stays current | 6 | Weekly `model-freshness.yml` opens issue when stale |
| `refreshModelCatalog()` is default-on for audit pipeline | 6 | `node scripts/openai-audit.mjs` shows live-fetch line in stderr |
| All existing tests still pass | All | `npm test` post each phase |
| Consumer-repo install still works end-to-end | 3 | `bootstrap.mjs install --surface both` in test repo |

---

## 10. Out of Scope

| Item | Why excluded |
|---|---|
| Rewriting AGENTS.md/CLAUDE.md content | Phase 1 reconciles drift; content quality is a separate `claude-md-improver` concern |
| Cursor / Windsurf-specific files | Not in user's stack today (Claude + Copilot only) |
| GEMINI.md support | Same as above |
| Migrating consumer repos retroactively | Consumer repos absorb new structure on next `bootstrap.mjs install` — no force-push |
| AI-generated commit messages for reconciliation | Reconciliation is one-shot, manual review preferred |
| Prompt-file progressive disclosure | Copilot prompt files don't support `references/` loading; CLI parity is the realistic ceiling |

---

## 11. Decisions Recorded — 2026-04-26

All five open questions answered by Louis at planning review:

| # | Question | Decision | Affects |
|---|---|---|---|
| 1 | Flip canonical to AGENTS.md? | **Yes**. AGENTS.md becomes source of truth; CLAUDE.md slims to `@./AGENTS.md` import + Claude-only addenda. | §2.1, §3 |
| 2 | Subdirectory rules? | **Best long-term**: only root requires the AGENTS.md+slim-CLAUDE.md pair. Subdirectory `AGENTS.md` files (monorepo packages) auto-discovered by both Copilot and Claude — no sibling CLAUDE.md required. Drift detector still enforces size/reasoned-rules on subdirectory files. | §2.3 |
| 3 | Phase 5 skill build now or defer? | **Build now**, but with strong test discipline: ≥23 unit tests + ≥6 integration tests. The skill writes to user files, so reliability is non-negotiable. | §7 |
| 4 | Phase 4 decommission `.github/skills/`? | **Yes**, with rollback safety: `--keep-github-skills` escape-hatch flag for one release, deprecation warning at install time, no silent-skip of files. | §6 |
| 5 | GH Action scope — weekly only or PR + weekly? | **PR + weekly**. PR check is fast-fail blocking; weekly cron is informational. Drift accumulates fast (84 lines in 4 days); weekly alone leaves a gap. | §4.4 |

### Additional decision recorded 2026-04-26

| # | Topic | Decision | Affects |
|---|---|---|---|
| 6 | Add ai-organiser-style live model checking? | **Yes, as Phase 6**. Audit-loop already has `refreshModelCatalog()` (parallel to ai-organiser's `dynamicModelService.ts`). Missing: automation layer (default-on wiring + drift gate against `STATIC_POOL`). New `scripts/check-model-freshness.mjs` + weekly GH Action. | §8 |

---

## 12. Estimated Effort

| Phase | Effort | Risk |
|---|---|---|
| 1 — Reconcile + Slim | 30 min | Low (manual edits, easy to revert) |
| 2 — Drift Detector + PR/weekly CI | 2.5 hr | Low (pure script + tests + 2 workflow files) |
| 3 — Copilot Prompt Shims | 3 hr | Medium (touches install flow; needs consumer-repo manual test) |
| 4 — Verify + Decommission with rollback | 1.5 hr | Low (verification + flag plumbing) |
| 5 — `ai-context-management` skill (≥29 tests) | 6 hr | Medium (test surface area is large; mock LLM correctness matters) |
| 6 — Model Pool Freshness Gate | 3 hr | Low (reuses existing `refreshModelCatalog()`; mocked-fetch tests) |
| **Total** | **~16.5 hr** | — |

### Suggested PR sequence

1. **PR 1** (Phases 1 + 2): reconcile + drift detector + PR/weekly CI. Self-contained, no install-flow changes. ~3 hr.
2. **PR 2** (Phase 6): model freshness gate. Independent of context-drift work. Can ship before or after PR 1. ~3 hr.
3. **PR 3** (Phase 4): decommission `.github/skills/` with `--keep-github-skills` rollback flag. Touches install flow. Should land before Phase 3 to reduce churn in Phase 3's install changes. ~1.5 hr.
4. **PR 4** (Phase 3): Copilot prompt shims + install-flow integration. Builds on PR 3's cleaner install flow. ~3 hr.
5. **PR 5** (Phase 5): `ai-context-management` skill. Wraps Phases 2-4 outputs in a callable skill. Largest PR; lands last. ~6 hr.

Total wall-clock: 5 PRs over ~2 days of focused work, or ~1 week with normal review cadence.
