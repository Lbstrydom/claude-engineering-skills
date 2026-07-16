# Plan: Split `/audit-loop` into `/audit-plan` + `/audit-code`
- **Date**: 2026-04-26
- **Status**: **Complete** (all 6 phases shipped 2026-04-27)
- **Author**: Claude + Louis
- **Sibling plan**: [ai-context-sync.md](./ai-context-sync.md) — landed first; this work depends on `SKILL_ENTRY_SCRIPTS` registry and Copilot prompt-file generation from Phase 3 of that plan.
- **Audit trail**: GPT R1 (16 findings; 2 fixed in-scope: deterministic sort, empty references/ pruned; rest auditor misreads or pre-existing). Gemini final review (CONCERNS_REMAINING; F1 fix shipped: explicit `EXPECTED_CONSUMERS` registry alongside auto-discovery; F2/F3 dismissed as auditor file-inventory misreads).

## Implementation Log

### 2026-04-27

- **Phase 1 — Extract shared references**: `docs/audit/shared-references/{ledger-format,gemini-gate}.md` (canonical). `scripts/sync-shared-audit-refs.mjs` with auto-discovery + `EXPECTED_CONSUMERS` registry (added in audit fix). Wired into `npm run skills:regenerate` + `skills:check`. 12 tests.
- **Phase 2 — Build /audit-plan**: `skills/audit-plan/SKILL.md` (247 lines, plan-only flow: max 3 rounds + rigor-pressure stop). 2 synced refs.
- **Phase 3 — Build /audit-code**: `skills/audit-code/SKILL.md` (328 lines, code-only flow: 5-pass parallel + R2+ + debt capture + 6-round 2-stable convergence). 4 refs (2 synced from canonical, 2 code-only).
- **Phase 4 — Slim /audit-loop to orchestrator**: `skills/audit-loop/SKILL.md` slimmed 371 → 84 lines. `scripts/lib/audit-dispatch.mjs` pure-function dispatcher. 15 dispatch tests + structural integrity tests.
- **Phase 5 — Wire SKILL_ENTRY_SCRIPTS**: registry expanded 7 → 9 skills. AGENTS.md skill chain reflects the split. Copilot prompts regenerated.
- **Phase 6 — End-to-end validation**: 9 skills lint clean via `skills:check`. 4 sync pairs in alignment. 1126 tests (1125 pass; 1 pre-existing `vendoring-provenance` SHA pin).

### Token-cost reduction (lines as proxy vs original 371-line audit-loop)

| Direct invocation | Lines | Reduction |
|---|---:|---:|
| `/audit-plan` | 247 | **33%** ✓ (≥30% target met) |
| `/audit-code` | 328 | 12% (most original content was code-audit-flavoured) |
| `/audit-loop` orchestrator | 84 | **77%** ✓ |

Bigger wins: routing clarity (atomic skill descriptions per mode) + drift prevention.

### Backwards compatibility

- `/audit-loop plan <X>` and `/audit-loop code <X>` continue to work via the orchestrator
- Bandit historical data under `skill_name="audit-loop"` preserved; new runs log under `audit-plan` / `audit-code` (cold-start ~5-10 runs to recover)
- Consumer-repo install ships all 3 audit skills; existing hooks referencing `/audit-loop` keep working

---

## 1. Context Summary

### 1.1 The motivation (empirical, from Louis)

On a sibling repo using the same audit-loop skill, splitting `/audit-loop` into `/audit-plan` and `/audit-code` produced measurable improvements:

- **Less token burn at invocation** — plan audits don't load code-audit plumbing (scope/diff/passes), code audits don't load plan-rigor-pressure rules.
- **More precise audits** — atomic skill descriptions reduce routing ambiguity; the model knows exactly which mode is firing.
- **Less drift between modes** — interleaved instructions in one SKILL.md let plan-audit edits leak into code-audit logic and vice versa. Separate files enforce separation by construction.

### 1.2 Current state — measured, not estimated

`.claude/skills/audit-loop/SKILL.md` is **371 lines** and exposes 4 modes via subcommand parsing:

| Mode | Trigger | Today's invocation |
|---|---|---|
| `PLAN_AUDIT` | `/audit-loop plan <plan-file>` | Audit plan iteratively |
| `CODE_AUDIT` | `/audit-loop code <plan-file>` or `/audit-loop <plan-file>` (shorthand) | Audit code against plan |
| `FULL_CYCLE` | `/audit-loop full <task>` | Plan → audit → implement → audit code |
| `PLAN_CYCLE` | `/audit-loop <task-description>` | Plan → audit → fix → repeat |

Steps used in each mode (from inspection of SKILL.md §0–§8):

| Step | PLAN_AUDIT | CODE_AUDIT | FULL_CYCLE | PLAN_CYCLE |
|---|:---:|:---:|:---:|:---:|
| 0. Parse mode | ✓ | ✓ | ✓ | ✓ |
| 1. Plan generation | — | — | ✓ | ✓ |
| 2. GPT audit | ✓ | ✓ | ✓ (twice) | ✓ |
| 2 — `--scope`/`--diff`/`--changed`/`--files`/`--passes` flags | — | ✓ | ✓ (code phase) | — |
| 3. Triage | ✓ | ✓ | ✓ | ✓ |
| 3 — Plan early-stop on rigor pressure (max 3 rounds) | ✓ | — | ✓ (plan phase) | ✓ |
| 3 — Code 6-round convergence | — | ✓ | ✓ (code phase) | — |
| 3.5. Ledger | ✓ | ✓ | ✓ | ✓ |
| 3.6. Debt capture | rare | ✓ | ✓ | rare |
| 4. Fix | ✓ | ✓ | ✓ | ✓ |
| 5. Verify (R2+) | ✓ | ✓ | ✓ | ✓ |
| 6. Convergence report | ✓ | ✓ | ✓ | ✓ |
| 7. Gemini gate | ✓ | ✓ | ✓ | ✓ |
| 8. Code audit transition | — | — | ✓ | — |

Reference files today: `r2-plus-mode.md` (code-only territory), `ledger-format.md` (both), `debt-capture.md` (mostly code), `gemini-gate.md` (both).

### 1.3 What's actually shared vs mode-specific

| Concern | Shared | Plan-only | Code-only |
|---|:---:|:---:|:---:|
| Triage rules (validity × scope × action) | ✓ | | |
| Adjudication ledger format | ✓ | | |
| Step 7 Gemini final gate | ✓ | | |
| Bandit / learning store integration | ✓ | | |
| 3-round rigor-pressure stop rule | | ✓ | |
| `--mode plan` flag (per existing memory: must always pass) | | ✓ | |
| Plan stays at one file → no multi-pass parallelism | | ✓ | |
| `--scope diff` default + `git diff`/`--changed`/`--files`/`--passes` plumbing | | | ✓ |
| 6-round convergence + 2 stable rounds | | | ✓ |
| Multi-pass (structure, wiring, backend, frontend, sustainability) | | | ✓ |
| R2+ ledger-driven suppression | rare in plan | | ✓ |
| Debt capture (out-of-scope pre-existing) | | | ✓ |

**Estimated split**: `/audit-plan` SKILL.md ≈ 180-200 lines; `/audit-code` SKILL.md ≈ 280-300 lines. Both well under the 3K-token / ~250-line house-style target.

### 1.4 Existing infrastructure (do not duplicate)

| What exists | Status |
|---|---|
| `scripts/openai-audit.mjs` — single CLI with `plan` / `code` / `rebuttal` subcommands | Keep — already split per-mode at the CLI layer |
| `scripts/gemini-review.mjs` — final gate, mode-agnostic | Keep |
| `scripts/lib/ledger.mjs` — adjudication ledger | Keep |
| `scripts/bandit.mjs` + learning store | Keep — but historical data is keyed by `audit-loop`; see §3.5 |
| `scripts/cross-skill.mjs` — writes `audit_runs`, `plans`, etc. | Keep — `skill_name` field becomes `audit-plan` or `audit-code` going forward |
| Prompt-file shims (Phase 3 of [ai-context-sync](./ai-context-sync.md)) | Affected — must be regenerated for the new skill names |
| `sync-to-repos.mjs` skill enumeration | Affected — picks up new skills automatically once they exist on disk |

### 1.5 What this plan is NOT

- **Not** a rewrite of `openai-audit.mjs`. The CLI already supports per-mode subcommands.
- **Not** a change to the audit protocol itself (triage rules, convergence thresholds, Gemini gate). Those carry forward unchanged.
- **Not** a breaking change for consumer repos by default. Phase 5 ships a thin `/audit-loop` alias-skill so existing muscle memory and hooks keep working.

---

## 2. Proposed Architecture

### 2.1 Three-skill end state

```
.claude/skills/
├── audit-plan/                            ← NEW. Plan-audit only.
│   ├── SKILL.md                            ~180 lines: Step 0, 2 (plan flags),
│   │                                       3 (rigor-stop), 3.5, 4, 5 (single-pass),
│   │                                       6, 7. No --scope/--diff/--passes plumbing.
│   └── references/
│       ├── ledger-format.md               (copy — kept in sync via Phase 4 check)
│       └── gemini-gate.md                 (copy — kept in sync via Phase 4 check)
│
├── audit-code/                            ← NEW. Code-audit only.
│   ├── SKILL.md                            ~280 lines: Step 0, 2 (--scope/--diff/
│   │                                       --changed/--files/--passes), 3 (6-round
│   │                                       convergence), 3.5, 3.6 (debt), 4, 5
│   │                                       (R2+ mode), 6, 7.
│   └── references/
│       ├── r2-plus-mode.md                (canonical home — code-only)
│       ├── ledger-format.md               (copy — kept in sync via Phase 4 check)
│       ├── debt-capture.md                (canonical home — code-only)
│       └── gemini-gate.md                 (copy — kept in sync via Phase 4 check)
│
└── audit-loop/                            ← KEPT, but slimmed to ~60-line
    └── SKILL.md                            orchestrator that dispatches:
                                            - /audit-loop plan <X>     → /audit-plan
                                            - /audit-loop code <X>     → /audit-code
                                            - /audit-loop <X> shorthand → /audit-code
                                            - /audit-loop full <task>  → /audit-plan
                                              then /audit-code
                                            - /audit-loop <task>       → /audit-plan
                                              (PLAN_CYCLE)
```

### 2.2 Why keep `/audit-loop` as an orchestrator (Option B)

Considered alternatives:
- **A. Drop `/audit-loop` entirely.** Cleanest but breaks consumer-repo hooks, scripts, GH Actions, and muscle memory. Rejected.
- **B. Keep as thin orchestrator** (chosen). Preserves `/audit-loop` muscle memory; orchestrator file is ~60 lines (just mode parsing + dispatch); no breakage.
- **C. Add `/audit-full` as a third skill for FULL_CYCLE.** Adds discoverability cost. Rejected — FULL_CYCLE is rare; `/audit-loop full` works fine via the orchestrator.

The orchestrator skill knows nothing about audit details. It only routes:

```markdown
## Step 0 — Parse and dispatch

| Input | Dispatch to |
|---|---|
| `plan <plan-file>` | invoke `/audit-plan <plan-file>` |
| `code <plan-file>` | invoke `/audit-code <plan-file>` |
| `<plan-file>` (shorthand) | invoke `/audit-code <plan-file>` |
| `full <task>` | invoke `/audit-plan <task>`, on success invoke `/audit-code <plan>` |
| `<task>` (no path) | invoke `/audit-plan <task>` (PLAN_CYCLE) |
```

### 2.3 Shared-content drift strategy

Two reference files (`ledger-format.md`, `gemini-gate.md`) are copies in both `audit-plan/references/` and `audit-code/references/`. Drift risk is real: an edit to one file might miss the other.

**Solution**: maintain a single canonical source under `docs/audit/shared-references/`. Add a check to `npm run skills:check` (which already exists per CLAUDE.md Phase B) that hashes each shared reference and asserts byte-equality across both skill copies plus the canonical. CI fails on drift. Generation script: `npm run audit:sync-shared-refs` copies canonical → both skill copies.

Layout:
```
docs/audit/shared-references/
├── ledger-format.md                       ← canonical
└── gemini-gate.md                         ← canonical

scripts/sync-shared-audit-refs.mjs        ← copy canonical → both skill copies
                                             + assert frontmatter summaries match
                                             SKILL.md reference-index rows
```

This sidesteps the symlink problem (Windows-hostile) and matches the existing "authoritative source + generated copies" pattern from Phase B/E of `skill-progressive-disclosure-refactor.md`.

### 2.4 Frontmatter `description:` for routing

Today the audit-loop description must list 4 modes — making it a long, awkward dispatch document. After the split:

`audit-plan/SKILL.md` frontmatter:
```yaml
description: Iteratively audit a plan file with GPT-5.4 + Gemini final gate.
  Multi-round refinement with rigor-pressure early stop.
  Triggers on: "audit the plan", "iterate on the plan", "audit docs/plans/",
  "verify the plan", "review the plan", "is this plan good".
  Usage: /audit-plan <plan-file>             — Audit existing plan
  Usage: /audit-plan <task-description>      — Generate, then audit (PLAN_CYCLE)
```

`audit-code/SKILL.md` frontmatter:
```yaml
description: Iteratively audit code against a plan with GPT-5.4 + Gemini final gate.
  Multi-pass static + dynamic analysis, R2+ ledger suppression, debt capture.
  Triggers on: "audit the code", "audit my changes", "audit my PR",
  "check the implementation", "verify the implementation", "review my code",
  "audit this", "audit my code".
  Usage: /audit-code <plan-file>             — Audit code against plan
  Usage: /audit-code <plan-file> --round 2   — R2+ verification round
```

`audit-loop/SKILL.md` frontmatter (slimmed):
```yaml
description: Orchestrator for /audit-plan + /audit-code. Use directly if you want
  the full cycle or aren't sure which audit mode applies. Otherwise prefer the
  specific skills for clearer routing and lower token cost.
  Usage: /audit-loop plan <X>      — Delegate to /audit-plan
  Usage: /audit-loop code <X>      — Delegate to /audit-code
  Usage: /audit-loop full <task>   — Plan-audit then code-audit
```

Each description has single-purpose triggers, so Claude's routing decision is unambiguous.

### 2.5 Data loop continuity

The cross-skill learning store (`audit_runs` table) keys runs by `skill_name`. Two options:

**Option A** (chosen — backward compatible): going forward, `audit_runs.skill_name` is `audit-plan` or `audit-code`. Historical rows under `audit-loop` are preserved untouched. Bandit arm keys are recomputed on first run after split (cold-start for ~5-10 runs is acceptable; bandit recovers fast).

**Option B**: migrate historical rows by inferring mode from `mode` column (already exists per `openai-audit.mjs` schema). Adds migration complexity; not worth it given Option A's fast recovery.

`scripts/bandit.mjs` requires no code changes — it already keys by `skill_name`. Consumer repos that have run `audit-loop` historically will have a brief cold-start period; document in CHANGELOG.

---

## 3. Phase 1 — Extract Shared References

**Goal**: establish the canonical home for shared reference content before any SKILL.md changes. ~1 hour.

### 3.1 Create canonical sources

```bash
mkdir -p docs/audit/shared-references
```

Move (with `git mv` to preserve history):
- `.claude/skills/audit-loop/references/ledger-format.md` → `docs/audit/shared-references/ledger-format.md`
- `.claude/skills/audit-loop/references/gemini-gate.md` → `docs/audit/shared-references/gemini-gate.md`

Verify content unchanged: `git diff HEAD~1 docs/audit/shared-references/`.

### 3.2 Sync script: `scripts/sync-shared-audit-refs.mjs`

Default mode: copy canonical → all skill copies. `--check` mode: hash-compare and exit non-zero on drift.

```javascript
const TARGETS = {
  'docs/audit/shared-references/ledger-format.md': [
    '.claude/skills/audit-plan/references/ledger-format.md',
    '.claude/skills/audit-code/references/ledger-format.md',
  ],
  'docs/audit/shared-references/gemini-gate.md': [
    '.claude/skills/audit-plan/references/gemini-gate.md',
    '.claude/skills/audit-code/references/gemini-gate.md',
  ],
};
```

Behaviour:
- Default: copy canonical → each target. Idempotent (no-op if byte-equal).
- `--check`: SHA-256 each target, fail if any diverge from canonical.
- Frontmatter `summary:` in target files must byte-match the SKILL.md reference-index row of the owning skill (per `docs/reference/skill-reference-format.md`).

### 3.3 Wire into existing checks

- `npm run skills:check` (existing) — add `&& node scripts/sync-shared-audit-refs.mjs --check`.
- `npm run skills:regenerate` (existing) — add `&& node scripts/sync-shared-audit-refs.mjs` (default mode).

### 3.4 Tests (`tests/sync-shared-audit-refs.test.mjs`)

- Canonical exists, targets don't → default mode creates them.
- All targets byte-equal canonical → `--check` exits 0.
- One target has drifted → `--check` exits non-zero with file path in stderr.
- Frontmatter `summary:` mismatch between target and parent SKILL.md reference-index row → `--check` flags it (reuses existing `skill-refs-parser` from Phase E).

≥6 tests.

### 3.5 Acceptance — Phase 1

- [ ] Two canonical files at `docs/audit/shared-references/`.
- [ ] Sync script + tests pass.
- [ ] Existing `audit-loop` references continue to work (canonical → existing copy via sync script).

---

## 4. Phase 2 — Build `/audit-plan`

**Goal**: extract plan-mode content from `audit-loop/SKILL.md` into a focused `audit-plan/SKILL.md`. ~2 hours.

### 4.1 Author `audit-plan/SKILL.md`

Content from `audit-loop/SKILL.md`:
- Step 0 — slimmed: only `PLAN_AUDIT` and `PLAN_CYCLE` modes.
- Step 1 — kept (PLAN_CYCLE only).
- Step 2 — slimmed: drop `--scope`/`--diff`/`--changed`/`--files`/`--passes` flags. Plan audit invocation:
  ```bash
  node scripts/openai-audit.mjs plan <plan-file> --mode plan \
    --out /tmp/$SID-r1-result.json
  ```
- Step 3 — slimmed: drop multi-pass language; keep triage rules + 3-round rigor-pressure stop rule.
- Step 3.5 — kept (links to `references/ledger-format.md`).
- Step 3.6 — drop (debt capture is code-only).
- Step 4 — kept, simplified (plans are one file, not many).
- Step 5 — kept, simplified (R2+ for plans is just the round number; no `--passes` selection).
- Step 6 — kept.
- Step 7 — kept (links to `references/gemini-gate.md`).
- Step 8 — drop (FULL_CYCLE only; orchestrator handles it).

Target: 180-200 lines. Verify: `wc -l .claude/skills/audit-plan/SKILL.md`.

### 4.2 Reference-index in SKILL.md

Two references: `ledger-format.md`, `gemini-gate.md`. Reference-index rows match the `summary:` frontmatter in each (enforced by `skills:check`).

### 4.3 Run `npm run skills:check`

Must pass. Includes Phase E's `skill-refs-parser` checks.

### 4.4 Smoke test

In a test consumer repo: invoke `/audit-plan docs/plans/some-test-plan.md`. Verify:
- GPT call fires with `plan` subcommand, not `code`.
- No `--scope`/`--diff` flags in invocation.
- Triage rules apply correctly.
- Step 7 Gemini gate fires.
- Convergence respects 3-round rigor-pressure cap.

### 4.5 Acceptance — Phase 4 (Phase 2 of plan)

- [ ] `audit-plan/SKILL.md` exists, ≤200 lines, ≤3K tokens.
- [ ] `references/` contains 2 files synced from canonical.
- [ ] `skills:check` green.
- [ ] Smoke test passes in a test repo.

---

## 5. Phase 3 — Build `/audit-code`

**Goal**: extract code-mode content from `audit-loop/SKILL.md` into a focused `audit-code/SKILL.md`. ~2.5 hours.

### 5.1 Author `audit-code/SKILL.md`

Content from `audit-loop/SKILL.md`:
- Step 0 — slimmed: only `CODE_AUDIT` mode.
- Step 1 — drop (no plan generation in code-only flow).
- Step 2 — kept in full: `--scope diff` default, `--diff`, `--changed`, `--files`, `--passes`, R1/R2+ invocations. Detailed scope decision table.
- Step 3 — slimmed: drop the plan-rigor-pressure subsection; keep 6-round convergence + 2-stable-rounds rule.
- Step 3.5 — kept.
- Step 3.6 — kept (debt capture canonical home).
- Step 4 — kept in full.
- Step 5 — kept in full (R2+ mode with full reference).
- Step 6 — kept.
- Step 7 — kept.
- Step 8 — drop (orchestrator handles FULL_CYCLE).

Target: 280-300 lines. Verify: `wc -l .claude/skills/audit-code/SKILL.md`.

### 5.2 Reference files in `audit-code/references/`

- `r2-plus-mode.md` (canonical home — moved here, not duplicated).
- `debt-capture.md` (canonical home — moved here, not duplicated).
- `ledger-format.md` (synced copy).
- `gemini-gate.md` (synced copy).

### 5.3 Reference-index in SKILL.md

Four references. Each reference-index row matches the `summary:` frontmatter.

### 5.4 Smoke test

In a test consumer repo with a recent diff: invoke `/audit-code docs/plans/some-test-plan.md`. Verify:
- GPT call fires with `code` subcommand.
- `--scope diff` defaults; `git diff` plumbing works.
- Multi-pass parallelism (5 passes) executes.
- R2+ mode in Round 2 invocation.
- Debt capture eligibility check fires for out-of-scope findings.
- Step 7 Gemini gate fires.

### 5.5 Acceptance — Phase 3

- [ ] `audit-code/SKILL.md` exists, ≤300 lines, ≤3K tokens.
- [ ] `references/` contains 4 files (2 canonical here, 2 synced).
- [ ] `skills:check` green.
- [ ] Smoke test passes including R2+ verification round.

---

## 6. Phase 4 — Slim `/audit-loop` to Orchestrator

**Goal**: replace existing 371-line `audit-loop/SKILL.md` with a ~60-line orchestrator that dispatches to the new skills. ~1.5 hours.

### 6.1 Author orchestrator SKILL.md

```markdown
---
name: audit-loop
description: Orchestrator for /audit-plan + /audit-code. ...
---

# Audit Loop Orchestrator

Dispatches to /audit-plan, /audit-code, or chains both for FULL_CYCLE.

## Step 0 — Parse mode and dispatch

[the dispatch table from §2.2]

## FULL_CYCLE flow

1. Invoke /audit-plan <task> — generate plan, audit iteratively, converge.
2. On success, prompt user to implement (or auto-implement if Phase X
   ships an implementer skill).
3. Once code is in place, invoke /audit-code <plan-file>.

If /audit-plan does not converge within max-3 rounds, halt and present
findings — user decides whether to proceed.

## See also

- /audit-plan for plan-only audits
- /audit-code for code-only audits
```

Target: ≤60 lines. No reference files (orchestrator is too thin to need them).

### 6.2 Migration note in CHANGELOG

```markdown
## [unreleased]

### Changed
- /audit-loop split into /audit-plan and /audit-code for atomic skill descriptions
  and lower token cost. /audit-loop is now a thin orchestrator that delegates;
  existing /audit-loop invocations continue to work.

### Migration
- No action required for existing users — /audit-loop dispatches to the new skills.
- Recommended: prefer /audit-plan or /audit-code directly for clearer routing
  and lower token cost.
- Bandit historical data under skill_name="audit-loop" is preserved; new runs
  log under "audit-plan" or "audit-code". Brief cold-start period for the
  new arms is expected and recovers within ~5-10 runs.
```

### 6.3 Test: orchestrator dispatch

`tests/audit-loop-orchestrator.test.mjs`:
- Parse `plan <X>` → dispatch table returns `/audit-plan <X>`.
- Parse `code <X>` → `/audit-code <X>`.
- Parse `<plan-file>` (shorthand path detection) → `/audit-code <plan-file>`.
- Parse `full <task>` → returns plan-then-code chain.
- Parse `<task>` (no path) → `/audit-plan <task>`.
- Empty input → error message.

≥6 tests, pure-string parsing (no LLM calls).

### 6.4 Acceptance — Phase 4

- [ ] `audit-loop/SKILL.md` slimmed to ≤60 lines.
- [ ] Dispatch table covers all 4 historical modes.
- [ ] Orchestrator tests pass.
- [ ] CHANGELOG entry added.

---

## 7. Phase 5 — Update Cross-Skill Wiring

**Goal**: regenerate prompt-file shims, update consumer-repo install, update docs. ~2 hours.

### 7.1 Regenerate Copilot prompt-file shims

Depends on Phase 3 of [ai-context-sync](./ai-context-sync.md). Once that ships:

- `audit-plan` and `audit-code` each get a `.github/prompts/<name>.prompt.md` shim.
- `audit-loop` shim updated to reflect orchestrator role (or removed in favor of pointing users to the specific skills).

Update the entry-script registry in `scripts/lib/install/copilot-prompts.mjs`:
```javascript
const SKILL_ENTRY_SCRIPTS = {
  'audit-plan': { script: 'openai-audit.mjs', argsHint: 'plan <plan-file>' },
  'audit-code': { script: 'openai-audit.mjs', argsHint: 'code <plan-file>' },
  'audit-loop': { script: 'openai-audit.mjs', argsHint: '<plan-or-task>' }, // keep
  // ... other skills
};
```

### 7.2 Update consumer-repo install (`scripts/install-skills.mjs`)

Existing install ships all skill files via `sync-to-repos.mjs` enumeration — picks up the new skills automatically. Verify no hardcoded skill list anywhere; if there is, add the two new skills.

### 7.3 Update docs

- `CLAUDE.md` (after Phase 1 of [ai-context-sync](./ai-context-sync.md) slims it, this lives in `AGENTS.md`): update Skill Chain section to reflect 3 audit skills (plan, code, orchestrator).
- `README.md`: update skill list.
- `docs/reference/skill-reference-format.md`: update example to reference the new skill names where applicable.

### 7.4 Update GH Action references

Search for any GH Action that calls `audit-loop` directly. Update to call the specific sub-skill or keep using `audit-loop` (orchestrator) — depends on what the workflow is auditing.

### 7.5 Acceptance — Phase 5

- [ ] Prompt-file shims regenerated for new skills.
- [ ] Consumer-repo install ships all 3 audit skills (plan, code, orchestrator).
- [ ] Docs updated.
- [ ] GH Actions still work (orchestrator path) or updated to use sub-skill.

---

## 8. Phase 6 — End-to-End Validation

**Goal**: prove all 4 historical entry points still work, plus the new direct invocations. ~1 hour.

### 8.1 Test matrix

| Invocation | Expected behavior | Verify |
|---|---|---|
| `/audit-plan docs/plans/X.md` | Direct plan audit | New skill fires, plan-only flow |
| `/audit-code docs/plans/X.md` | Direct code audit | New skill fires, code-only flow |
| `/audit-loop plan docs/plans/X.md` | Orchestrator → /audit-plan | Same as direct, via dispatch |
| `/audit-loop code docs/plans/X.md` | Orchestrator → /audit-code | Same as direct, via dispatch |
| `/audit-loop docs/plans/X.md` (shorthand) | Orchestrator → /audit-code | Defaults to code via shorthand path detection |
| `/audit-loop full <task>` | Plan then code | Both phases run, plan converges before code starts |
| `/audit-loop <task>` (no path) | PLAN_CYCLE → /audit-plan | Plan-cycle behavior unchanged |
| Consumer-repo install fresh | All 3 skills present | `bootstrap.mjs install` ships them |

Run all 8 invocations against a test plan + test code change. Capture stderr to verify dispatch.

### 8.2 Token-cost measurement

Compare SKILL.md load tokens before/after split:

| Before | After |
|---|---|
| `/audit-loop` invocation: ~7-9K tokens | `/audit-plan` invocation: ~4-5K tokens |
| | `/audit-code` invocation: ~6-7K tokens |
| | `/audit-loop` orchestrator invocation: ~1-1.5K tokens (then dispatches; sub-skill loads on dispatch) |

Target: at least 30% token reduction on direct sub-skill invocations vs current `/audit-loop`. Measure with `tiktoken` or a SKILL.md-only token counter (no need for full LLM call).

### 8.3 Acceptance — Phase 6

- [ ] All 8 test-matrix invocations succeed.
- [ ] Token-cost measurement shows ≥30% reduction for direct sub-skill invocations.
- [ ] No regressions in existing skill tests (audit-loop test suite, if any).
- [ ] `npm test` passes.

---

## 9. Acceptance Criteria — Whole Plan

| Criterion | Phase | How verified |
|---|---|---|
| `/audit-plan` exists, ≤200 lines | 2 | `wc -l` |
| `/audit-code` exists, ≤300 lines | 3 | `wc -l` |
| `/audit-loop` slimmed to ≤60 lines | 4 | `wc -l` |
| Shared references in canonical home | 1 | `ls docs/audit/shared-references/` |
| Shared-ref drift detected by CI | 1 | `npm run skills:check` includes drift check |
| All 4 historical entry points work | 6 | Test matrix in §8.1 |
| Token cost reduction ≥30% on direct invocations | 6 | Measurement in §8.2 |
| Bandit recovers from cold-start within 10 runs | 6 | Empirical (post-merge tracking) |
| Consumer-repo install ships all 3 skills | 5 | `bootstrap.mjs install` in test repo |
| `skills:check` green throughout | All | CI runs |
| All existing tests pass | All | `npm test` post each phase |

---

## 10. Out of Scope

| Item | Why excluded |
|---|---|
| Rewriting audit content (triage rules, convergence) | Pure refactor, no behavior change |
| Migrating historical bandit data | Cold-start is fast; complexity not worth it |
| Removing `/audit-loop` entirely | Preserves muscle memory + consumer hooks |
| Adding `/audit-full` as a separate skill | Orchestrator handles FULL_CYCLE; extra skill increases discovery cost |
| Splitting `openai-audit.mjs` into separate scripts | CLI subcommands already split per-mode; no benefit from also splitting the file |
| Sharing references via symlinks | Windows-hostile; sync script with drift check is simpler |
| Live token-cost measurement instrumentation | One-shot measurement in §8.2 is enough; no need for ongoing telemetry |

---

## 11. Decisions Recorded — 2026-04-26

| # | Question | Decision | Rationale |
|---|---|---|---|
| 1 | Drop `/audit-loop` or keep? | **Keep as orchestrator** | Preserves muscle memory + consumer hooks; orchestrator is ~60 lines |
| 2 | Add `/audit-full`? | **No** | Orchestrator handles FULL_CYCLE; extra skill = extra discovery cost |
| 3 | Shared refs: symlink, duplicate, or canonical-source? | **Canonical source + sync script + drift check** | Matches existing Phase B/E pattern; Windows-safe; cheap drift detection |
| 4 | Migrate bandit historical data? | **No, fast cold-start instead** | ~5-10 runs to recover; migration complexity not justified |
| 5 | Sequence relative to ai-context-sync plan? | **Land after ai-context-sync Phases 1-2** | Phase 5 of this plan touches prompt-file shims which depend on Phase 3 of that plan; Phase 1 (drift detector) helps catch shared-ref drift |

---

## 12. Estimated Effort

| Phase | Effort | Risk |
|---|---|---|
| 1 — Extract shared references | 1 hr | Low (file moves + sync script + tests) |
| 2 — Build `/audit-plan` | 2 hr | Medium (content extraction; risk of behavioral drift if missed) |
| 3 — Build `/audit-code` | 2.5 hr | Medium (more content; R2+ + debt capture detail) |
| 4 — Slim `/audit-loop` to orchestrator | 1.5 hr | Low (small file + dispatch tests) |
| 5 — Update cross-skill wiring | 2 hr | Low (regeneration) |
| 6 — End-to-end validation | 1 hr | Low (test matrix execution) |
| **Total** | **~10 hr** | — |

### Suggested PR sequence

1. **PR 1** (Phase 1): extract shared references + sync script + drift check. Independent of skill changes; can land first. ~1 hr.
2. **PR 2** (Phases 2 + 3): build `/audit-plan` + `/audit-code` in parallel. They don't depend on each other. ~4.5 hr.
3. **PR 3** (Phases 4 + 5 + 6): slim `/audit-loop` to orchestrator, update wiring, run validation. ~4.5 hr.

Sequencing rule: **do not land PR 3 until ai-context-sync Phases 1-2 are merged**, so the drift detector exists and the canonical AGENTS.md / CLAUDE.md split is in place when the wiring updates touch docs.

Total wall-clock: 3 PRs over ~1.5 days of focused work, or ~3-5 days with normal review cadence. Sits cleanly after ai-context-sync's PR sequence.
