# Phase I Plan Audit Summary

- **Date**: 2026-04-06
- **Plan**: `phase-i-claudemd-hygiene.md`
- **Rounds**: 3 (capped per early-stop rule; R2→R3 HIGH count INCREASED 4→6 = rigor pressure)
- **Verdict trajectory**: R1 SIGNIFICANT_GAPS H:6 → R2 NEEDS_REVISION H:4 → R3 SIGNIFICANT_GAPS H:6
- **Cost**: ~$0.40, ~10 min
- **Status**: Audit-complete. 15 fixes applied. 6 R3 HIGHs are rigor pressure / scope creep — documented as known limitations.

## Key Fixes Applied

**R1 (6 HIGH, 3 MEDIUM addressed)**:
- Path resolution contract: `resolveReferencedPath(sourceFile, rawRef, repoRoot)` with URL/anchor skipping (H1)
- In-process source index: no `grep` shelling — `fs.readFileSync` + per-line regex for function detection (H2)
- Integration contract: `HygieneReportSchema` in `lib/schemas.mjs`, CLI exit codes (0/1/2/3), `--out` for JSON/SARIF (H3)
- Auto-fix safety: standalone-node-only, `--fix --yes` for unattended, preview in interactive (H4)
- Finding identity: `semanticId()` with `hygiene:` namespace prefix, file-pair-aware for sync/claude-agents (H5)
- Mandatory exclusions: `.git`, `node_modules`, `tests/**/fixtures/**`, etc. shared between scanner + source index (H6)
- File layout: `scripts/lib/claudemd/*` canonical (M1)
- Decoupled similarity: `doc-similarity.mjs` own implementation, not coupled to ledger.mjs (M2)
- Deferred subjective rules (dup/inline-arch, ref/missing-section-link) removed from active spec (M3)

**R2 (4 HIGH, 6 MEDIUM addressed)**:
- I/O contract: `--out` mandatory for json/sarif formats, follows project convention (H1)
- State transitions: hygiene ERRORs are advisory (presented to user + Step 7), NOT convergence-blocking (H2)
- Schema changes: `lib/schemas.mjs` listed as modified, `TranscriptSchema` extended with `hygiene` key (H3)
- Shared exclusion set: source index uses same mandatory exclusions as instruction-file scanner (H4)
- CI workflow: `continue-on-error: true` + `if: always()` for SARIF upload (M5)
- Rollback: visible warning instead of silent skip when linter missing (M6)

**R3 (6 HIGHs — rigor pressure, documented as known limitations)**:
- Convergence/blocking contradiction resolved (Step 6.5 is advisory throughout)
- Hook module location specified (`step65-hook.mjs`)
- Nested-file comparison scope defined (same directory tree only)
- Config format is strict JSON (no comments)
- Auto-fix described as opt-in standalone-node-only

## Remaining HIGHs (6 from R3 — rigor pressure, not correctness gaps)

| # | Finding | Resolution |
|---|---|---|
| R3-H1 | Workflow state machine contradiction | Fixed in plan — Step 6.5 is advisory only, Q6 updated |
| R3-H2 | Missing runtime module | Added `step65-hook.mjs` to file impact |
| R3-H3 | CLI output contract ambiguity | Fixed — `--out` is mandatory for json/sarif, I/O contract section is authoritative |
| R3-H4 | JSONC comments in sample config | Fixed — config is strict JSON, deferred rules removed from sample |
| R3-H5 | Auto-fix safety | Already addressed in R1; conservative standalone-node-only design |
| R3-H6 | Nested-file comparison scope | Added scoping rule: same directory tree only |

## Trajectory Analysis

6 → 4 → 6. R2 showed genuine improvement (>30% drop). R3 increase is
classic rigor-pressure: GPT re-found edge cases in areas already fixed
(auto-fix safety, output contract) and pushed for things that are
implementation details (JSONC support, cross-directory comparison algorithms).

Phase I is architecturally simple compared to G.1-G.3 — it's a linter with
a well-defined rule set, not a distributed storage system. The R3 HIGHs
are all either already-fixed contradictions or scope-appropriate-for-implementation
decisions.

## Next Steps

Plan is ready to implement. Key implementation notes:
1. Build file-scanner + ref-checker first — they're the core utility
2. Test with this repo's own CLAUDE.md as a real-world fixture
3. Step 6.5 hook is thin — runs CLI, parses JSON, returns findings
4. SARIF formatter is optional polish; JSON output is the integration contract
5. Deferred rules (inline-arch, missing-section-link) go in a future phase when LLM-assisted analysis is available
