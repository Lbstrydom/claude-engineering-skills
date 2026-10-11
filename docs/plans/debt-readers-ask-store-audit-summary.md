# Audit convergence summary — debt readers ask the store

**Plan**: [`docs/plans/debt-readers-ask-store.md`](debt-readers-ask-store.md)
**SID**: `audit-code-1791714713` · **Base**: `56eb0459` · **Audited head**: `bbdaaa49`
**Auditor**: `latest-gpt` (balanced tier) · **Final gate**: `latest-pro` (Gemini)

## Rounds

| Round | Scope | Result | Coverage |
|---|---|---|---|
| 1 | diff vs 56eb0459, default passes | H:3 M:5 — 7 accepted + fixed, 1 dismissed (M1: two-list DB enrolment is the repo's documented rule, gated by `db:enrolment:gate`) | **3 changed files excluded by policy** (audit-infra: `debt-memory.mjs`, `debt-ledger.mjs`, `debt-review.mjs`) |
| 2 | R2+ on the fixes | H:1 — accepted + fixed (partial read reported `ok:true`) | partial: 2 infra files `none` |
| 3 | R2+ | PASS — **not counted**: the two infra files were still never read | partial |
| 4 | full change, `--allow-infra-scope` | H:1 M:1 — both rebutted, GPT overruled its own findings (exit-code contract; fail-loud corrupt cache) | complete, 0 changed lines unread |
| 5 | same as 4 | **PASS H:0 M:0 L:0**, `_convergence: converged` | complete, 0 changed lines unread |

## Final gate

Gemini round 1: **APPROVE**, `gateDisposition: approve` (blocking 0, debt 0,
wrongly dismissed 0). **Coverage caveat**: the envelope was PARTIAL — the
same three audit-infra files were dropped unconditionally
(`scripts/gemini-review.mjs:304 (56eb0459)` filters `isAuditInfraFile` with
no opt-in), so the APPROVE covers 8 of 11 changed files. Every changed line
of the other three was read by GPT rounds 4–5.

## Census (round 5)

| Pass / wave | State |
|---|---|
| structure, wiring, backend, sustainability | completed |
| frontend | ineligible (backend-only diff) |
| quickfix / duplication / adjacency (waves) | not run in R2+ (`--passes` selection) — ran in round 1 |
| arch-memory | ineligible (`--scope diff`) |
| file coverage | completed (round 5); rounds 1–3 uncovered for the 3 infra files |

## Two-direction proof

- `tests/debt-authoritative-read-db.test.mjs`: 0/5 on `56eb0459`, green on the
  fix; the events-failure case goes red (`an unread events table is not "no
  recurrence"`) with `readDebtEventsCloudResult` reverted to the swallowing
  reader, green restored.
- `tests/debt-read-context.test.mjs`: 7/7, pure.
