# Audit summary: Python indexing for architectural memory

- **Plan**: [python-arch-memory-indexing.md](python-arch-memory-indexing.md)
- **Date**: 2026-11-20 (off-peak)
- **Code-audit SID**: `audit-code-1795205037519-87104`

## Plan audit
- 3 GPT rounds. R1 was H7 M2, R2 H3, R3 H3 M1, and every finding was accepted except H7, which GPT deliberation
  compromised to MEDIUM.
- The GPT cap (3) was reached. The structural card showed 0 structural clusters, so the rounds stopped.
- Final gate: **APPROVE** (Gemini, round 1/2).

## Code audit: 6 rounds (cap reached), then the final gate

| Round | H | M | Outcome |
|---|---|---|---|
| R1 (union diff from the plan commit) | 8 | 24 | Fixed: open-then-verify reads, lazy bounded loads, strict id correlation, nested/decorated defs, resolver boundary, banner BOM/cookie, egress pin. H6/H8 went to deliberation, where GPT sustained them, and were fixed. 2 deferred (M5, M18); 4 adjacency coverage notes dismissed |
| R2 | 4 | 5 | Fixed: descriptor-path check, ASCII Python banner, Python-true line slicing, module-scope `__all__`, FIFO-safe open, index excludes refused reads |
| R3 | 1 | 3 | Fixed: conservative `__all__`, for/while/match scopes |
| R4 | 1 | 1 | **Pivot** (`__all__` came back in a 4th round): one generic rule. The literal is trusted only when `__all__` is mentioned exactly once in the whole AST |
| R5 | 1 | 1 | Fixed: a string containing `__all__` counts as a mention |
| R6 (all changed scripts) | 3 | 1 | Fixed H3 (PEP 263 line-1 rule) and M1 (the index holds only loaded requests). **Deferred H1 (residual race) and H2 (owned by the sibling chip)**, see below |

- At the R6 cap, the structural card showed 0 structural, 2 local and 44 polish clusters. **STOP**: going past the
  cap is Louis's call.
- **Final gate** (Gemini, `--batch`, round 1/2): `CONCERNS` → **`approve_with_debt`**, with 0 blocking and 2
  non-blocking findings, both captured as debt:
  - G1: a defensive banner-idempotency edge case for a shebang+cookie file with CRLF endings. The sync always reads
    the banner-free source, so this guard is only defensive.
  - G2: a docstring that mentions `__all__` makes the literal untrusted. This is the intended conservative direction.
- The first gate call, run without `--batch`, read only part of the diff ("1398 changed lines never shown") and
  approved. That call is **not** counted as evidence. The batch run saw everything except 58 lines.

## Census (final round)
- Passes run in R6: `backend`, `sustainability`, `wiring` (completed).
- `structure`/`frontend`: run in R1, not re-run in R2–R6 (`ineligible`; R2+ passes were chosen for the changed
  backend files).
- `duplication`: R1 raised one pre-existing pair, recorded with a `@duplicate-justification` pragma.
- `adjacency`: `uncovered` in R1 (the enumeration bound maxCandidates=25 was reached on a 30-file diff).
- `arch-memory`: `ineligible` (`--scope=diff`).

## Remaining (accepted debt, captured in the ledger)
- **Residual admission race on non-Linux** (R6 H1). Linux binds the fd through `/proc/self/fd`. Windows and macOS
  have no fd-to-path API in Node, so the re-admission is sandwiched between two inode checks against the fd. The
  residual needs repo-write access plus three precisely timed symlink swaps, and the bytes still pass the secret
  scrub before egress. Failing closed would disable Python indexing on Windows and macOS. **Louis's call:** accept
  this, or make Python indexing Linux-only.
- **`arch-render` "not indexed" callout keys on the extension allowlist, not on the snapshot's coverage**
  (R1 M5 / R6 H2). On a machine with no interpreter, a `.py` target no longer gets the "not indexed" disclaimer.
  The coverage verdict in the get-neighbourhood envelope (the `ces-private-store` chip) is where this gets fixed.
- `extract.mjs` is still a large module (R1 M18). It is size-ratcheted, and this change stayed inside the ratchet.
- G1, G2 from the final gate (above).
