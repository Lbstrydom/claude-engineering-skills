# Audit summary — fleet-work-consumer-feedback-nov-2

- **Plan**: `docs/plans/fleet-work-consumer-feedback-nov-2.md`
- **SID**: `audit-code-1794857852493-76148` · scope `diff` against `origin/main`
- **Rounds**: 6 GPT rounds (the code cap) + final review rounds 1 and 2

## Rounds

| Round | Verdict | H / M / L | What it found |
|---|---|---|---|
| R1 | SIGNIFICANT_ISSUES | 9 / 12 / 2 | onGranted outside the lease lifecycle; tested-together coverage (conflict reach, base identity); display-string stale flag; `fullSuiteOf` swallowing config errors; suite note on refusals; decision provenance wording; stack-base ancestry |
| R2 | SIGNIFICANT_ISSUES | 1 / 3 / 0 | equal-tip stack base; per-source deferral provenance; superset manifests |
| R3 | SIGNIFICANT_ISSUES | 1 / 1 / 0 | pre-claim commits absorbed by the base → fork point recorded at claim |
| R4 | SIGNIFICANT_ISSUES | 4 / 1 / 0 | fork point overwritten on re-claim; write order |
| R5 | SIGNIFICANT_ISSUES | 4 / 0 / 0 | mutable record lifecycle → **pivot**: immutable create-only records per (session, gen, base) |
| R6 | SIGNIFICANT_ISSUES | 1 / 1 / 0 | deliberated to MEDIUM: a rewritten base; fixed with an ancestry check at read time |

Every finding was adjudicated; none is deferred as debt. Dismissed with evidence: R1 M3 (the schema already rejects a
standalone CR), R4 H2 (the diff is three-dot). Overruled in deliberation: R1 M4 (mixed-bundle cost, documented).

**Not converged by the two-stable-rounds rule — the cap stopped it.** `audit-structural-card.mjs`: capped while productive
(round-6 acceptance 100%, HIGH 9→1→1→4→4→1); 1 structural cluster (transaction safety in `commands.mjs` /
`stack-bases.mjs`, rounds 4–6), 36 polish. The human call (STOP / STRUCTURAL / CONTINUE) is the user's.

## Final gate

Round 1 APPROVE, `gateDisposition: approve` (blocking 0, debt 0). Origin/main then moved (#377), so the branch merged it
and the gate was re-run (round 2, `--prior`): **APPROVE, `gateDisposition: approve`**, final gate gemini-4-argon.
Coverage of the final reviewer: PARTIAL — 3/29 changed files whole, 26 windowed, 372 of 1146 changed lines not shown
(envelope budget). The GPT rounds read every changed file (`_coverage: complete` in R1).

## Census (R6)

| Identifier | State |
|---|---|
| backend | completed |
| sustainability | completed |
| structure, wiring, frontend | ineligible (R2+ passes chosen per file type; R1 ran all five) |
| arch-memory | ineligible (`--scope diff`) |
| file coverage | completed (R1 complete; R2+ scoped to the changed files) |
