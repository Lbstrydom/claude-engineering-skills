# Audit Summary — Architecture-Intent PR-C (Postgres Adapter)

- **Date**: 2026-05-15
- **Plan**: [docs/plans/arch-intent-pr-c-postgres-adapter.md](arch-intent-pr-c-postgres-adapter.md)
- **Cycle**: `/cycle` FULL mode — plan → audit-plan → implement → audit-code → ship
- **Final**: Gemini CONCERNS at the round-2 cap; the single residual finding was concrete and fixed. Coherence "Strong" every round; 0 wrongly-dismissed every round.

## /audit-plan — 3 GPT rounds + 2 Gemini rounds

| Phase | H | M | L | Outcome |
|---|---|---|---|---|
| GPT R1 | 2 | 3 | 1 | first-wins ignores migration evolution; multi-pass chicken-and-egg; fault isolation; namespace; object identity; over-broad detection — all fixed |
| GPT R2 | 3 | 3 | 1 | refs leak from superseded defs; wrong fromFile attribution; table-vs-function key collision; prisma-dir false signal; quoted-ident contract; `AS '…'` bodies — all fixed |
| GPT R3 | 3 | 3 | 1 | drop-then-recreate alterRef reattach; statement span model; non-distinctive markers; stage-contract drift; CTE exclusion; lexical sort — all fixed; 1 dismissed (recordDecision misapplication) |
| Gemini R1 | — | — | — | CONCERNS — E-strings, multi-drops, DROP CONSTRAINT — all fixed |
| Gemini R2 | — | — | — | CONCERNS at cap — PARTITION OF, DROP TRIGGER/POLICY, OR REPLACE TRIGGER, CREATE TYPE/DOMAIN — all 4 folded in per user direction |

## /audit-code — 2 GPT rounds + 2 Gemini rounds

| Phase | Genuine in-scope findings | Outcome |
|---|---|---|
| GPT R1 | 4 | quote-aware statement split; widened detection sample; non-distinctive markers dropped; `SQL_MAX_FILE_BYTES` env-overridable |
| GPT R2 | 4 | qualified quoted-name regex + quote-aware `normName`; fd-leak `finally`; `SQL_MAX_FILE_BYTES` validation; `SQL_BUILTIN` JSDoc honesty |
| Gemini R1 | CONCERNS | G1 `normName` dot-join collision (`SEG_DOT` escaping + `displayName`); G2 non-standalone `E` escape-string misfire — both fixed |
| Gemini R2 | CONCERNS (cap) | one MEDIUM — `$$` not Postgres-distinctive (`DELIMITER $$` in MySQL) — fixed by dropping it |

**Recurring false positives** (dismissed, confirmed 3×): GPT's structure
pass flagged PR-A/PR-B's already-shipped files (`adapter-contract.mjs`,
`domain-resolver.mjs`, `adapters/{js-ts,python,java}.mjs`) as "missing" —
an artifact of the `--files` audit scope + the plan's `../../` relative
paths. Verified present; the 171-test arch-intent suite imports them all.
`cross-skill.mjs`-style out-of-scope findings and the dynamically-loaded
"orphan" false positive were also dismissed with rationale.

## Gemini final reasoning

> "The codebase provides a remarkably robust and elegant pure-JavaScript
> lexical analyzer and catalog replayer for PostgreSQL migrations. It
> handles deep Postgres-specific quirks (nested block comments,
> exact-tag dollar-quotes, epoch-based redefinitions) without requiring
> a live database, perfectly bridging standard static file analysis with
> SQL's declarative nature."

## Final state

- Full test suite: **2065 pass / 0 fail / 20 pre-existing skips**.
- New: `adapters/postgres.mjs` (~430 LOC) + `tests/arch-intent-adapter-postgres.test.mjs` (44 tests).
- Modified: `repo-stack.mjs` (Postgres detection), `sync-to-repos.mjs` (CORE_SCRIPTS).
- Adapter contract (`adapter-contract.mjs`) unchanged — PR-C conforms via the existing `_meta`-extensible shape; no `DomainMapSchema` change.
- The 3-PR architecture-intent series is complete: JS/TS (PR-A), Python + Java (PR-B), Postgres (PR-C).
