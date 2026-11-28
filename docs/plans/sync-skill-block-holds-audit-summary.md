# Audit summary: Block holds (docs/plans/sync-skill-block-holds.md)

- **Date**: 2026-11-28
- **Status**: Complete
- **Mode**: `/cycle --autonomous --ship`, single unit (the plan has no §11 clustering).

## /audit-plan — SID `audit-plan-1795849705622-63128`

| Round | H | M | L | Acceptance | Notes |
|---|---|---|---|---|---|
| R1 | 5 | 2 | 0 | 100% | migration consent, declaration reconciliation, historical render, bundle closure, `from` aliasing |
| R2 | 2 | 0 | 0 | 100% | durable adoption state; fail-closed before the untracked overwrite |
| R3 | 1 | 2 | 0 | 100% | pending needs a current declaration; consent bound to the held bytes; lint fails closed |

Final gate: Gemini, `CONCERNS` → **`approve_with_debt`** (0 blocking, 2 debt). Both debt items were fixed in the plan: a duplicated-text paste error, and the token's byte representation.

## /audit-code — SID `audit-code-1795852347790-74952`, base `bfd7186c`

| Round | Verdict | H | M | L | Accepted / compromise / dismissed | Theme |
|---|---|---|---|---|---|---|
| R1 | SIGNIFICANT_ISSUES | 6 | 12 | 0 | 14 / 3 / 1 | line-bounded fragment check, `blocks: null`, supersede on write, lint fail-closed, deployed verifier, isolated-source lifecycle e2e |
| R2 | SIGNIFICANT_ISSUES | 2 | 3 | 0 | 5 / 0 / 0 | ordered HTML scan, symlink policy, working-tree overlay |
| R3 | SIGNIFICANT_ISSUES | 3 | 5 | 0 | 2 / 5 / 1 | **pivot**: same concern (HTML) for 3 rounds; replaced ad-hoc parsing with a conservative documented subset |
| R4 | SIGNIFICANT_ISSUES | 1 | 5 | 0 | 6 / 0 / 0 | POSIX link removal, rename-safe overlay, JSON `ok` envelope, slot-missing precedence |
| R5 | PASS | 0 | 1 | 0 | 1 / 0 / 0 | flags validated before `--help` |
| R6 | (after deliberation) | 0 | 0 | 0 | 0 / 0 / 2 | the `--selfcheck-relocation` early return is the repo's CLI smoke contract |

**CONVERGED (uncovered: 3 non-code files, see census) — Round 6 | Final: H:0 M:0 L:0**

Final gate: Gemini (`gemini-4-argon`), round 1, **APPROVE**, disposition `approve` (0 blocking, 0 debt).

### Census

- passes `backend`, `sustainability`, `wiring`, `structure`, `frontend`: completed. R2+ ran a subset per round, by file type.
- `file coverage` (final gate): uncovered. `.audit-loop/checklist.json`, `.gate-files.json` and the plan were not selected for the review envelope. The first two are a generated artifact (`checklist:gen:check`) and a registry checked by `tests/gate-provenance-registry.test.mjs`.
- `arch-memory`: ineligible (`--scope diff`).
- detector census: completed (0 detectors recorded, `blocked: false`).

### Decisions worth knowing

1. **Raw historical blobs still count as prior-upstream for a block-declared path** (code R1 H6, compromise). A raw upstream blob carries no consumer block, so it is a stale snapshot. A pending hold → block adoption pre-empts the rule.
2. **Supported-markup subset** (code R3, compromise after the pivot). A fragment, and any upstream file that carries a slot, may contain no block-level raw HTML except a comment closed on its own line. All four real consumer adapter blocks pass it.
3. **`--selfcheck-relocation` stays first in `main()`** (code R6, overruled). This is the documented CLI smoke contract.
