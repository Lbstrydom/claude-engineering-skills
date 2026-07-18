# Phase F Plan Audit Summary

- **Date**: 2026-04-05
- **Plan**: `phase-f-install-update-infra.md`
- **Rounds**: 3 (capped per early-stop rule)
- **Verdict trajectory**: R1 SIGNIFICANT_GAPS H:6 → R2 SIGNIFICANT_GAPS H:6 → R3 NEEDS_REVISION H:5
- **Cost**: ~$0.45, ~12 min
- **Status**: Audit-complete. 14 fixes applied. 5 remaining HIGHs documented as known limitations.

## Key Fixes Applied

**R1 (6 HIGH, 6 MEDIUM addressed)**:
- Versioning: removed date component, now pure 16-char content hash covering ALL managed artifacts (H1, H6)
- Ownership: clarified receipt is authoritative source, not SKILL.md markers; repo-scoped receipt committed, machine-scoped local (H2)
- Staleness check: added local drift detection via receipt-SHA comparison (H3)
- Pinned reproducibility: bundle-history.json maps bundleVersion → git SHA; tooling fetched from same ref as content (H4)
- Transaction boundary: receipt-first commit ordering, rollback from snapshots (H5)
- God-script risk: decomposed installer into 10 focused lib modules (M2)
- Manifest sync: CI guard + pre-commit hook (M3)
- Partial install: receipt tracks subset, check computes partial bundle version (M4)
- Schema validation: Zod at all JSON boundaries (M5)
- Self-update: deferred-swap pattern, Windows-safe (M6)

**R2 (4 MEDIUM addressed, 4 new HIGH surfaced)**:
- Scope contradiction: authoritative surface table, explicit `~/.claude/skills/` global (H1)
- Cache keys: include git ref, pinned installs never see wrong-ref content (H2)
- Repo-root discovery: walk-up to `.git` file/dir OR package.json, outermost wins (H3)
- Transaction journal: separated from authoritative receipt (H4)
- bundle-history self-reference: documented follow-up commit pattern (H5)
- Migration path for existing manual installs: `--adopt` flag (H6)

## Remaining HIGHs (documented as known limitations)

5 HIGHs remain at R3 stop — all accepted with mitigations documented in §7:

| # | Finding | Mitigation |
|---|---|---|
| R3-H1 | Outermost-`.git` heuristic incorrect for worktrees/submodules | `--repo-root <path>` CLI flag |
| R3-H2 | In-memory rollback snapshots lost on crash | Fast installer (<10s); narrow crash window |
| R3-H3 | First-install curl-pipe always fetches from `main` | Workaround URL form with SHA for pin-first-install |
| R3-H4 | bundleVersion excludes installer tooling itself | Phase H signed-checksum manifest covers tooling separately |
| R3-H5 | Committed receipt mixes immutable facts + mutable metadata | Split into `.audit-loop-install-receipt.json` (committed) + `.audit-loop/local-state.json` (gitignored) — Phase F follow-up |

## Trajectory Analysis

HIGH count flat at 6 for 2 rounds, then dropped to 5 at R3. Less convergent
than Phase D or Phase E audits — this plan has genuine architectural depth
(versioning, transactions, ownership, migration, rollback) where each fix
exposes adjacent concerns. The 5 remaining HIGHs are all real; they're
accepted because addressing them well requires implementation work that's
appropriate for the fix phase, not the plan phase.

## Next Steps

Plan is ready to implement. Known limitations will inform implementation
priorities: R3-H5 (receipt split) should happen early; R3-H3 (first-install
pin) can be documented in README + URL form; R3-H1/H2/H4 are "fix if it hurts
in practice" items.
