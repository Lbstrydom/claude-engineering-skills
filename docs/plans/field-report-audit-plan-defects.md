# Plan: Field-Reported /plan → /audit-plan Defects

- **Date**: 2026-08-08
- **Status**: Complete — shipped in `cd862249`, `3a9dde1d`, `49bef636`; this
  document is the retrospective spec the code audit grades those commits
  against. It was written AFTER the fixes (a field report, not a planned
  feature), so treat it as the intent record, not a forward design.
- **Scope**: backend / tooling. No UI surface.

## 1. Context

A real `/plan` → `/audit-plan` session in a consumer repo reported five defects,
all reproduced directly. Two blocked documented flows. Fixing them surfaced two
more of the same family, and a class census found three further instances of
one. Running the newly-fixed self-check against a consumer plan then exposed a
defect in the extractor itself.

Code Trace (at `49bef636`):

- `skills/audit-plan/SKILL.md` Step 6 and `skills/audit-code/SKILL.md` Step 7
  both invoked `scripts/gemini-review.mjs review <plan> .audit/$SID-transcript.json`
  with no step producing that file. `scripts/audit-loop.mjs:452` (pre-change)
  built one inline; nothing else did.
- `scripts/lib/sync-rewriter.mjs:35` `COMMAND_REGEX = /\bnode\s+scripts\/…/g`
  is the only relocation surface, so a module specifier inside `import()` or a
  heredoc ships unrewritten to `scripts/.claude-skills/` consumers.
- `scripts/lib/ledger.mjs:104` replaces (not merges) an entry at a topicId and
  validates the whole `LedgerEntrySchema`, so a partial write is rejected.
- `scripts/lib/outcome-sync.mjs:92` `enrichFindings` joins on
  `entry.topicId === generateTopicId(finding)` or `entry.latestFindingId`.
- `scripts/lib/plan-paths.mjs` hand-maintained its own extension alternation in
  insertion order, while `scripts/lib/language-profiles.mjs` sorted its own
  longest-first for exactly this reason.

## 2. Requirements

| # | Requirement |
|---|---|
| R1 | The final-review transcript has a producer both MANDATORY gates can run, and one assembler shared with the orchestrator. |
| R2 | A plan-mode transcript carries no code files — the reviewer's plan/code discriminator is their absence. |
| R3 | `/audit-plan`'s Gemini invocation passes `--mode plan`. |
| R4 | Every runnable command in a skill survives relocation to a consumer, and names a file the bundle ships. |
| R5 | Ledger entries derive identity from the round's own findings; a partial `mark-fixed` write cannot silently no-op. |
| R6 | `write-code-outcomes` cannot report `0/N labelled` as success without naming a cause. |
| R7 | Plan-audit convergence keys on acceptance rate, with finding count as a secondary backstop. |
| R8 | Skill session artifacts live in `.audit/`, not `/tmp/`. |
| R9 | Path extraction resolves every extension it claims to support, including `.json`/`.tsx`. |

## 3. Files

- `scripts/build-audit-transcript.mjs` (create) — R1/R2 CLI.
- `scripts/lib/audit/transcript.mjs` (create) — R1/R2 shared builder.
- `scripts/write-ledger-entries.mjs` (create) — R5.
- `scripts/audit-loop.mjs` (modify) — R1, use the shared builder.
- `scripts/lib/plan-paths.mjs` (modify) — R4 CLI + R9 ordering + `regexFoundCount`.
- `scripts/lib/language-profiles.mjs` (modify) — R9 `toExtensionAlternation`.
- `scripts/lib/audit/detector.mjs` (modify) — R4 CLI.
- `scripts/lib/plan-criteria-parser.mjs` (modify) — R4 CLI.
- `scripts/lib/schemas.mjs` (modify) — R5 persist `latestFindingId`.
- `scripts/write-code-outcomes.mjs` (modify) — R6 diagnosis.
- `scripts/sync-to-repos.mjs`, `scripts/lib/sync-inventory.mjs` (modify) — R4 ship the new entry points.
- `skills/{audit-plan,audit-code,plan,ux-lock}/**`, `docs/audit/shared-references/**` (modify) — R3, R7, R8.
- `tests/{audit-transcript-build,write-ledger-entries,skill-command-portability,language-profiles,audit-detector}.test.mjs` — guards.

## 4. Testing Strategy

- Tier 1 (test-first, deterministic): transcript shape, ledger identity derivation, extension alternation.
- Tier 3 (ships with its test): the consumer sync/relocation contract — `skill-command-portability` asserts against the sync inventory, not local existence.
- Negative controls: the plan-mode `code_files` invariant and the alternation ordering were each reverted and observed red before being restored.

## 4b. Audit trail (2026-08-08)

6 GPT rounds + 2 Gemini gate rounds. 42 findings raised, 20 ruled: **10 accepted
and fixed, 7 dismissed with evidence, 3 deferred** (the rest were suppressed
re-raises and adjacency control markers).

| Round | Findings | What it caught |
|---|---|---|
| R1 | H3 M19 | `--round nope` → NaN → schema rejection → `1/1 ruled, acceptance 100%`, exit 0, **no ledger on disk**. Reproduced live. |
| R2 | M6 | `readRoundResult` computed the round then spread the payload over it. |
| R3 | M3 | Batch writes were validated per entry; now whole-batch-before-disk. |
| R4 | H1 M5 | Escalated the non-atomic batch I had patched around twice — now one `atomicWriteFileSync`. Plus a docblock advertising a flow the new guard refuses. |
| R5 | H1 M2 | Atomic rename ≠ atomic transaction: no lock across read-merge-write. |
| R6 | H1 M1 | A parseable-but-not-a-ledger file was silently replaced (the sibling writer backs it up). |
| Gemini 1 | 1 new | A malformed criterion's `Setup:`/`Assert:` attached to the **previous valid** criterion. |
| Gemini 2 | 1 new HIGH | `--mark-fixed` read the ledger *outside* the lock added in R5 — a stale snapshot overwrote a concurrent ruling. |

Three findings dismissed repeatedly (6 raises) claimed the sync inventory
duplication has "no programmatic enforcement of equality";
`tests/sync-inventory-parity.test.mjs` deep-equals both lists and its header
records the drift incident that created it. Gemini's `wrongly_dismissed` on that
item arrived with an empty rationale and was challenged with the test.

**Deferred with a TODO at the line**: `runDetector`'s ripgrep `path:line:text`
parse is ambiguous for a filename containing `:<digits>:`. Independent of this
change set (the CLI added here parses nothing); a colon is illegal in a Windows
filename and no shipped glob reaches one; the real fix is `--json` framing.

**R7 — the post-gate verification pass (2026-08-08).** The three fixes made
AFTER the last audited round (R6's corrupt-ledger backup, and both Gemini
findings: the malformed-criterion `current` clear and the `--mark-fixed`
read-outside-the-lock) shipped in `bc6f578f` as `AI-Gate: waived`, because
`passed` binds to WHAT was audited and those fixes were not. Re-audited over
`49bef636..HEAD` scoped to the two files that carried them: **PASS, H:0 M:0
L:0**.

That is what makes `passed` reachable, and only in a specific order: the
evidence records `gitIndexTree` at audit START, and `ship-commit` compares it to
`git write-tree` at commit time, so the tree must be staged BEFORE the
converging round and untouched afterwards. A partial `--path` commit of an
audited worktree is refused for the same reason — a whole-tree audit does not
cover a subset.

**Two guards were deleted rather than kept**: a two-process race test for
`--mark-fixed` passed against both implementations (the processes serialize on
the lock), and a mutation probe for batch atomicity could not be driven red. A
probe that cannot fail proves nothing, so both were replaced by structural
assertions that DO go red — one atomic write call and zero per-entry writes; no
ledger read outside the lock.

## 5. Out of Scope (Future)

- Widening `PLAN_REFERENCE_EXTENSIONS` to `cjs/mts/cts/pyi` — changes extraction scope; no current requirement.
- A ledger-fixture oracle for the detector gate (would let `detector-blocks-convergence` bind executably instead of document-only).
