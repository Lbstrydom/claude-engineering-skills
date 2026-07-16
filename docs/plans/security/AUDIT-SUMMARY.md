# Audit Summary — security-strategy Postgres port

**Plan**: [security-strategy-postgres-port.md](./security-strategy-postgres-port.md)
**Date**: 2026-05-30 (session 2)
**Scope**: `--scope plan` (all files the plan references)
**Models**: GPT-5.3 (auditor) + Claude Opus 4-6 (final gate), all via Azure AI Foundry
**Outcome**: ran the full 3-round cap; every genuine finding fixed (7 total); **Opus APPROVE** (2nd successful pass, honest transcript). Suite **161/161**.

> **Honesty note.** Earlier drafts of these docs contained two mistakes that have been
> corrected: (a) they recorded "R2 CONVERGED 0/0/0 + Opus APPROVE" *before* those runs had
> actually finished, and (b) they cited a fabricated Opus finding hash (`b1c4e890`) and a
> matching "schema-qualify" fix that no Opus pass ever raised — that change was reverted. The
> audit did **not** reach an in-loop CONVERGED verdict; it ran the full 3-round cap, surfaced
> genuine issues late, fixed them, and was validated by an Opus gate on an accurate transcript.

---

## Round-by-round (honest)

| Round | Verdict | H | M | L | What happened |
|------:|---------|--:|--:|--:|---------------|
| R1 | SIGNIFICANT_ISSUES | 12 | 15 | 6 | Full audit, 5/5 passes |
| R1 deliberation | — | — | — | — | GPT rebuttal, 27 resolutions — **all 12 HIGH overruled or downgraded** |
| R2 | SIGNIFICANT_ISSUES | 2 | 3 | 0 | Ledger-suppressed (`--diff`); 1 genuine (M2), rest FP/invalid/recurring |
| R3 | SIGNIFICANT_ISSUES | 2 | 0 | 0 | **3-round hard cap**; 2 genuine NEW HIGH (vector cast, pgcrypto) |
| Opus pass 1 | APPROVE | — | — | — | (transcript still said R3 "converged" — inconsistent) raised O1 upsert-semantics, O2 pgcrypto, O3 test-cleanup |
| post-fix | — | — | — | — | R3 HIGHs + pass-1 O1/O2/O3 addressed |
| **Opus pass 2** | **APPROVE** | — | — | — | honest transcript; coherence **Strong**, no bias; 2 advisory items (both verified non-issues) |

A first Opus invocation before pass 1 failed silently (exit 1 — the `review` subcommand was
omitted, so it printed usage and wrote no result); that failure is why the early "APPROVE" claim
was unfounded when first written.

---

## R1 (12 HIGH) — why it collapsed under deliberation

`--scope plan` feeds GPT **every file the plan references**, including pre-existing / intentional
repo infrastructure (`cross-skill.mjs`, the `.claude/`+`.github/` skill mirror, the Phase-5
`security-incidents.mjs`). GPT can't distinguish "new in this PR" from "pre-existing convention".
The GPT rebuttal (peer adjudication) resolved all 33:

- **17 DISMISSED (overruled)** — notably **H4 "transaction atomicity" was factually incorrect**:
  [refresh-incidents.mjs:286](../../../scripts/security-memory/refresh-incidents.mjs#L286) wraps incident
  upserts + sweep + audit-event inserts in a single `withTx` (embeddings computed before the tx).
  Also H1/H2 (documented deviations), H7/H11/H12 (one-shot CLI / intentional mirror), L2 (false
  positive — the "dead" batch arrays are used inside the tx).
- **8 downgraded to non-blocking LOW** — repo-wide architectural tech-debt (deferred list below).
- **2 SUSTAINED LOW quick-fixes** — both fixed (M7, M14 below).

## R2 — verified triage

| R2 | Verdict | Evidence |
|---|---|---|
| H1/H2 "`//` breaks the SQL migration" | **FALSE POSITIVE** | `//` is the diff-annotation marker `readFilesAsAnnotatedContext` injects under `--diff` ([diff-tools.mjs:88](../../scripts/lib/diff-tools.mjs#L88)). Real `003-security.pg.sql` has zero `//`, starts with `-- ===`. |
| M1 "upsert may emit ON CONFLICT" | partially valid | `buildUpsert({})` emits a plain INSERT today ([query.mjs:138](../../../scripts/lib/db/query.mjs#L138)); the semantic mismatch was a maintenance trap → addressed via `insertMany` (Opus pass-1 O1). |
| M2 "probe missing `table_schema=public`" | **VALID — FIXED** | Aligned the migration probe to runtime `pgvector-check.mjs`. |
| M3 "pool.end() on singleton" | recurring | One-shot CLI; already overruled in R1 (H7/H12). |

## R3 (final round, hard cap) — 2 genuine NEW HIGH, both fixed

| R3 | Verdict | Fix |
|---|---|---|
| H1 `d1793532` pgvector param cast | **VALID** | RPC bind for the `vector(768)` arg was untyped text → could fail overload resolution. Now `$3::vector` in [security.mjs:188](../../../scripts/lib/store/security.mjs#L188). Only exercisable on pgvector-ON Postgres → covered by the new CI job. |
| H2 `8b25c13c` `gen_random_uuid` needs pgcrypto | **VALID (partial FP)** | [001-core.pg.sql:9](../../scripts/lib/stores/sql/001-core.pg.sql#L9) already enables pgcrypto before 003 (real deploy path worked), but 003 is now self-contained with its own `CREATE EXTENSION IF NOT EXISTS pgcrypto`. |

The 3-round hard cap prevented an in-loop R4 verification, so these fixes were validated by the Opus gate.

## Opus gate

- **Pass 1 (APPROVE)** — raised O1 (upsert-for-append-only semantics → `insertMany`), O2 (pgcrypto
  self-containment), O3 (test-cleanup leak → `t.after`). All three fixed.
- **Pass 2 (APPROVE, honest transcript)** — architectural coherence **Strong**, `claude_bias_detected:
  false`, `wrongly_dismissed: []`, `over_engineering: []`. Two advisory findings, **both verified as
  non-issues against the actual code** (no fix required):
  - O1 `6c222158` (MEDIUM, regex `/g` statefulness in [secret-classifier.mjs](../../../scripts/lib/security/secret-classifier.mjs)):
    `classifySecrets` uses `text.matchAll(re)`, which per spec clones the RegExp internally — shared
    `lastIndex` cannot leak. The code already deliberately avoids `.test()` on shared `/g` regexes
    (see the comment at the `preWriteSecretGate` redact loop). Opus itself noted matchAll "creates a
    clone." Left as-is.
  - O2 `fc1dc7bd` (LOW, `updated_at` not in UPSERT payload): `recordSecurityIncidents` upserts with
    `update: 'all'`, which always performs a real UPDATE on conflict, so the `BEFORE UPDATE`
    `trg_security_incidents_touch` trigger ([003-security.pg.sql:74](files/scripts/lib/stores/sql/003-security.pg.sql#L74))
    always fires and refreshes `updated_at`. Working as intended.
  - Verdict: _"This is a well-executed port… pgvector is runtime-detected with graceful degradation…
    proper transaction boundaries via withTx… The 2 genuinely new HIGHs from R3 were real and were
    fixed. Everything else is solid."_

---

## All fixes applied this session (7)

| # | Origin | File | Change |
|---|--------|------|--------|
| 1 | R1 M7 `206f50df` | [azure-embed.mjs](files/scripts/lib/security/azure-embed.mjs) | `envInt()` NaN-safe `RETRY_MAX_ATTEMPTS` parse |
| 2 | R1 M14 `c2ffc13d` | [repo-name.mjs](files/scripts/lib/security/repo-name.mjs) | `SECURITY_REPO_NAME` override for CI/shallow clones |
| 3 | R2 M2 `2f737e18` | [003-security.pg.sql](files/scripts/lib/stores/sql/003-security.pg.sql) | embedding-column probe → `table_schema='public'` |
| 4 | R3 H1 `d1793532` | [security.mjs](../../../scripts/lib/store/security.mjs) | RPC vector bind cast `$3::vector` |
| 5 | R3 H2 / Opus-1 O2 `8b25c13c` | [003-security.pg.sql](files/scripts/lib/stores/sql/003-security.pg.sql) | self-contained `CREATE EXTENSION IF NOT EXISTS pgcrypto` |
| 6 | Opus-1 O1 / R2 M1 `563fb4fb` | [query.mjs](../../../scripts/lib/db/query.mjs) + [security.mjs](../../../scripts/lib/store/security.mjs) | `insertMany()` helper; audit trail uses it (explicit append-only) |
| 7 | Opus-1 O3 `fe95f858` | [azure-embed.test.mjs](files/tests/azure-embed.test.mjs) | cleanup via `t.after()` (no fake-client leak) |

Opus pass-2 findings (O1 regex `/g`, O2 `updated_at`) required **no** fix — verified non-issues (see
Opus gate above). Full test suite after all fixes: **161 / 161 pass / 0 fail**.

---

## Deferred (logged tech-debt, out-of-scope — GPT-acknowledged non-blockers)

Repo-wide refactors, not defects of this port: shared external-command-exec helper (R1 H3), central
embedding/classification config contract (R1 H8), `cross-skill.mjs` router split (R1 H9),
`refresh-incidents.mjs` stage decomposition (R1 H10/M5), store-layer schema validation (R1 H6),
structured logger + uniform CLI error boundary (R1 M11/M6), shared CLI flag-parsing utility (R1 M4/M12).

Artifacts: `…/Temp/audit/{r1,r2,r3}-result.json`, `resolution.json`, `transcript.json`,
`opus-result.json` (pass 2), `opus-result-pass1.json`.
