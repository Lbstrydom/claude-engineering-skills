# Audit Summary — Pre-push hook fails closed when killed

- **Date**: 2026-10-12
- **Plan**: [docs/plans/prepush-hook-fail-closed-when-killed.md](prepush-hook-fail-closed-when-killed.md)
- **Cycle**: `/cycle --autonomous` — plan → audit-plan → implement (single unit, no §11) → audit-code → stop at the `/ship` handoff
- **Final**: CONVERGED (rounds 4 and 5 clean, 2/2 stable); Gemini **APPROVE** (blocking 0, 1 non-blocking LOW captured as debt)

## /audit-plan — 3 GPT rounds + 1 Gemini round (SID `audit-plan-1791818126813-60892`)

| Phase | H | M | L | Outcome |
|---|---|---|---|---|
| GPT R1 | 2 | 2 | 0 | 4/4 accepted: USR1/USR2 in the trap set; L3 moved from the runner's sandbox to a hook-owned record; runtime characterisation instead of a permanent fail-open contract; bounded test lifecycle |
| GPT R2 | 1 | 2 | 0 | 3/3 accepted: null-status probe bug; validated common-dir resolution; record published before substantive work |
| GPT R3 | 0 | 1 | 1 | 2/2 accepted: no `--contains` advice for an unknown sha; §7 placement contradiction |
| Gemini R1 | 0 | 0 | 1 | APPROVE; the LOW (redirection order) was folded straight into the plan |

## /audit-code — 5 GPT rounds + 1 Gemini round (SID `audit-code-1791820187753-43984`)

| Round | H | M | L | Outcome |
|---|---|---|---|---|
| R1 | 0 | 6 | 0 | 6/6 accepted, all test hygiene: deadline-vs-signal oracle, tri-state ref check, push lifecycle ownership, hermetic git config, one bash-resolution strategy, exact probe assertions |
| R2 | 1 | 2 | 1 | H1 accepted: a stale record whose pid was reused by THIS hook read as alive and got overwritten (fixed; mutation-proven). M1/L1 accepted. M2 dismissed: the adjacency wave hit its own enumeration bound on `scripts/lib/fleet/prune.mjs`, a file this change doesn't touch |
| R3 | 1 | 1 | 0 | H1 accepted: XSI terminators (SIGTRAP, …) are now trapped behind a `kill -l` capability probe; mutation-proven. M1 dismissed: the temporary audit copy of the hook (below) |
| R4 | 0 | 0 | 0 | PASS — coverage complete |
| R5 | 0 | 0 | 0 | PASS — coverage complete; 2/2 stable |
| Gemini R1 | 0 | 0 | 1 | APPROVE. The LOW (pre-existing `process.exit` after a stdout write in `install-prepush-hook.mjs`'s CLI, which this change doesn't touch) was captured as debt |

## Census (final round)

```
structure / wiring / backend / sustainability   completed
frontend                                         ineligible  (no frontend files)
quickfix / duplication / adjacency (waves)       completed   (R2 adjacency: enumeration bound reached on an untouched file)
arch-memory                                      ineligible  (--scope diff)
detectors                                        completed   (0 registered — no cross-cutting finding carried one)
file coverage                                    completed   (R2–R5; see the note below for R1)
```

**Coverage note — the hook is extensionless.** `scripts/lib/file-taxonomy.mjs` admits no
extensionless file, so R1 reported `PARTIAL — .githooks/pre-push not audited`. For R2–R5 a
byte copy (`.githooks/pre-push.audit-copy.sh`) was passed with `--files` so the auditor read
the hook. The copy was deleted after each run and is never committed; R2's H1 and R3's H1 were
both found in it. Gemini's own envelope was PARTIAL (617 of 1,215 changed lines not shown,
mostly the runbook, the plan and the long test file), so its APPROVE covers what it examined.

## Verification

- `tests/prepush-hook-fail-closed-on-signal.test.mjs` — 21/21. Real `git push` runs against
  throwaway bare remotes; the unprotected hook killed by SIGHUP reads `fail-open` on Git
  2.56.0.windows.2, and every protected case reads `blocked`.
- `tests/cli-io-shell-exit-code.test.mjs` — 21/21. Raw 256 reads `$?=0` under Git's bash; the
  normalised value reads exactly 1.
- 13 existing hook test files (167 tests) and the 17 files touching the runner/cli-io
  (402 tests) — all pass.
- Mutation-proven guards: trap `exit 256` → 4 red; raw forwarding → 8 red; `$$` guard reverted
  → 1 red; XSI probe disabled → SIGTRAP red.
- **Real-hook red/green** (Git 2.56.0.windows.2, HEAD 8d862042): the pre-fix hook killed by
  SIGHUP let the push through (`git push` exit 0, remote received the ref, neither verdict
  line printed — the incident's signature); the fixed hook blocked it; the child-only kill
  blocked with both. Table: the plan's Implementation Log.
- **Full `npm test`** (2026-10-12, measured with `npm test`, 28m34s under shared-machine
  load): 19,589 tests, 19,541 pass, **2 fail**, 46 skipped. Both failures were
  `tests/rmsync-retry-guard.test.mjs` flagging this change's own new `fs.rmSync` calls (in
  the new test and the new helper) for not using the repo's retry-hardened options. Fixed;
  the guard re-run passes 1902/1902 and the integration file 21/21. The full suite was not
  re-run after that fix (coordinator: one heavy job at a time); the pre-push gate re-runs it.
