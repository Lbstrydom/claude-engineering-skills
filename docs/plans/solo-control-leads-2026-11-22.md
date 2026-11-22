# Solo-control / model-eval leads — triage and fixes (2026-11-22)

- **Date**: 2026-11-22
- **Status**: In Progress — fixes implemented; audit and merge pending
- **Scope**: backend (`scripts/solo-control-audit.mjs`, `scripts/lib/solo-control/**`, `scripts/lib/audit/diff-scope-resolver.mjs`, `scripts/debt-auto-capture.mjs`)

> **Target domain(s)**: `audit-orchestration`, `shared-lib`, `tech-debt`, `tests`

**Source:** the verification-lessons Cluster C audit, round 1
(`audit-code-vlC-…-r1-result.json`, findings H4–H9, H11, H12, H19–H22, M1, M4, M5, M8, M10). One
**unadjudicated** GPT round about code Cluster C does not change (#421/#429 hardening), so each lead was
reproduced against `origin/main` @ `9865dc65` before anything was fixed. Verdicts: **REAL** (fixed here),
**FALSE** (evidence), **BY DESIGN** (not a defect, evidence), **DEFERRED** (real, schema-bound, debt).

## Verdicts

| Lead | Verdict | Evidence (at `9865dc65`) | Fix / disposition |
|---|---|---|---|
| **H4** forced rerun reuses a callId; readers dedupe separately-billed calls | **REAL** | `ledger.mjs:26` callId = hash(commit,purpose,pass,chunk,repeat,model); `hardening-guards.mjs` `budgetVerdict` keyed `byCallId` — and its own docstring recorded the gap ("Deferred: call identity"). A `--force` rerun that re-pays a cell is one row, so the cap undercounts. | Every paid call now carries a **`spendId`** (callId + fresh nonce, `recordCall`); the budget (`budgetVerdict`, `aggregateBudgetSpent`) counts by `spendId ?? callId`. callId keeps its identity meaning (resume, shared-pass credit); a shared credit copies the payer's spendId so a shared call is still ONE spend. Legacy rows (no spendId) dedupe as before — stated limit. Tests: `solo-control-leads.test.mjs` (mutation-checked red). |
| **H22** resumed partial commit reruns successful cells under the same ids | **REAL** (same root as H4) | Same callId derivation; resume re-pays cells with identical ids. | Fixed by the same `spendId`. Note the consequence: a billed-but-unpriced first attempt now stays **unmeasured** after a priced rerun (never read as zero). |
| **H5** nonconforming reply triggers a second paid call that is *not recorded* | **FALSE** (recording) / **REAL** (budget → M8) | `runPass`/`runDeepseekPass` accumulate `usage` over BOTH attempts (`sumUsage`) and `recordCall` writes one row with the summed usage; a test now pins `{20,10}` tokens after two attempts. | Recording claim is false. The un-rechecked budget is M8. |
| **M8** budget checked only before a cell that may make two calls | **REAL** | `cmdRun` called `budgetBreached` before each cell; `runPass` retried (a second paid call) with no further check. | `beforeRetry` gate (`retryBudgetVerdict`): ledger **plus the first attempt's in-flight cost** (not yet in the ledger) is checked before the retry; breach or unpriced-usage → the cell is `budgetStop`/`providerError` (unmeasured, never a conformance miss), the commit is `budget-exceeded`, the run stops (exit 3). Budget check never weakened. |
| **H6** ledger query filters by commit sha, not repository | **DEFERRED** (real, schema-bound) | `model_ab_finding_scores` has no repo column (`20260701140000_model_ab_v2.sql:198-227`); filtering needs a view migration + per-unit repo identity. Collision needs the same sha in two registered repos (forks/mirrors); the experiment's commits resolve through `locateCommit` roots. | Debt entry (this PR's `--add`). Not deferred for size: it needs a store migration, which is not this change. |
| **H8 / H21** findings, ledger calls and resume cleanup keyed by commit sha while discovery uses (auditedSha, auditedTree) | **REAL (guard), re-key DEFERRED** | `cmdRun`: `commit: sha` only; several dirty-tree audit rounds share one HEAD but have distinct trees. | Each persisted finding now carries `unitKey` (the discovery identity), so the conflation is detectable downstream. Full re-keying of merge/score/ledger by unit is the deferred half (debt entry): it changes the join key against `model_ab_finding_scores`, which has no tree column (same migration as H6). |
| **H9** `DISTINCT ON` has no tie-break ORDER BY | **REAL** | `ORDER BY v.commit_sha, v.arm, v.canonical_id` = the DISTINCT ON keys only. | `ar.created_at DESC, v.run_id DESC, v.finding_fingerprint` appended (`store-queries.mjs`). **Verified by SQL-text test only — not run against a real Postgres here (no Docker, per the load rules).** `audit_runs.created_at` is used elsewhere in the repo (`concern-telemetry-report.mjs`). |
| **H12** discovery SQL drops rows where both sha and tree are null | **REAL** | `AND (ar.audited_sha IS NOT NULL OR ar.audited_tree IS NOT NULL)`; both-null rows were neither run nor counted, and the log said "only one of …". | Predicate removed; `partitionDiscoveredRows` counts every incomplete row (log reworded "sha and/or tree"). The count now includes legacy pre-migration rows — that is the true figure of what is excluded. |
| **H11 / H19** schema-invalid reply → empty findings counted as a completed cell | **BY DESIGN** | `coldPassOutcome`: a REPLY that did not conform is *the model's measured outcome* (`conformanceMiss`, counted in `conformanceByPass`, skew warning > 15%), NO reply is `providerError` (unmeasured, re-run on resume). That split is the deliberate #421 hardening, with tests (`solo-control-run-guards`). Not an "empty result for a fault": the fault class (transport) is the other branch. | No change. Residual noted: a *truncated* reply (max_tokens) is also a conformance miss; visible in `conformanceByPass`, not hidden. |
| **M1** DeepSeek reply with no `system_fingerprint` bypasses the pin | **REAL** | `if (recipient === 'deepseek' && r.systemFingerprint)` — no fingerprint skipped the check and the cell was accepted as measured beside a pin. | `fingerprintVerdict`: missing is refused exactly as drift is (cell `provider-error`, commit `provider-error`, re-run on resume). Strict by design: a provider that never returns a fingerprint yields an unmeasured arm, not an unverified one. Anthropic is never checked. |
| **H7** stage-capture filename sanitisation collides (`run/1` vs `run_1`) | **FALSE** | `stage-recall.mjs:96-99` `artifactFileName` = sha256 of `JSON.stringify([runId, entryId, stage])`; no sanitisation exists anywhere in the file. | Pinned by a test (distinct hashes; deterministic). |
| **M4** medium clusters sampled before adjudicators can split/merge them | **FALSE** | `cmdScore` builds `sampleRows` **per sheet row** with the row's own `inclusionProb` (`solo-control-audit.mjs` score loop) and `scoreMediumSampleWeighted` is a row-level Horvitz–Thompson estimate; a human regrouping the `cluster` column does not change any row's inclusion probability. | No change. |
| **M5** decision computed over unlabeled/invalid/unproven rows | **REAL (small)** | `decision` was built regardless; `decisionStatus: 'directional-only'` sat beside it in the report. A consumer reading `decision` alone saw a verdict. | `blockVerdictUnlessFinal` folds a non-`final` status into `decision.verdictBlocked`, keeping an existing block. |
| **M10** retro reads "Sonnet produced findings" as "review completed" | **REAL** | `sonnetFindings.length === 0` was the only baseline check; a run that billed 3 of 5 passes then failed holds findings and a `provider-error` state. | `baselineReviewCompleted` (latest `perCommit` state must be `ran`); otherwise the commit is recorded `sonnet-baseline-incomplete` before any policy check or Gemini call. With completion now known, the old `findings.length === 0` skip (its proxy) is removed: a completed zero-finding baseline is a real one (R1 H7). The hardening test fixture lacked `perCommit` (unfaithful to real artifacts) and was corrected. |
| **H20** orphan resolver returns `headRef: null` on a dirty tree even with an older base | **REAL**, in `resolveDiffScope` | Working-tree mode ran `git diff --name-status HEAD` (ignoring `baseRef`) while preimages and the base manifest are taken at `baseRef`, so every commit between an older `--base` and HEAD was dropped from the orphan wave. (`resolveOrphanScopeRefs`'s policy is right and is kept; the bug is one hop down.) | Diff against `resolvedBase`; base == HEAD is the same command as before. `diff-scope-working-tree-base.test.mjs` (red without the fix, with a base==HEAD control). Docstring in `orphan-pass.mjs` corrected. |

Tally: **REAL fixed 9** (H4, H22, M8, M1, H9, H12, M5, M10, H20; plus the H8/H21 guard) · **FALSE 3** (H5-recording, H7, M4) ·
**BY DESIGN 2** (H11, H19) · **DEFERRED 2** (H6, H8/H21 re-key).

## Also added — `debt-auto-capture.mjs --add`

One hand-authored entry (`--severity --category --file --detail --rationale [--line --principle]`), projected by
`lib/debt-manual-entry.mjs` onto the round-ledger entry shape and run through the **same** `buildDebtEntry`
(redaction, sensitivity), `PersistedDebtEntrySchema`, `persistDebtEntries` (local write + cloud durable-write)
and per-reason field checks. Nothing is defaulted or padded (a 20-char rationale is required, unlike the
auto path's dot-padding). Topic id is `m`+8 hex of the content hash, deterministic, so a re-add updates in
place. Tests: `tests/debt-auto-capture-add.test.mjs`.

## Size ratchet

`scripts/solo-control-audit.mjs` **shrank 2272 → 2218** (SQL + partition moved to
`lib/solo-control/store-queries.mjs`; guards to `cell-guards.mjs`); baseline lowered, never raised.

## Audit R1 (spend $0.79) — triage

21 findings. **Fixed:** case-preserving manual topic id (H5/M6), completed zero-finding baseline no longer skipped (H7/M5), a reply with no usage makes the retry unmeasured not free (H8/H9), `--line` positive integer (L1), stale docstring (L2). **Dismissed false:** M7/M8 (the test uses a raw credential, no placeholder regex). **Deferred, filed as debt (11):** H1, H2, H10 (the schema-bound re-key above), H3, H4/M4 (judge-gpt resume), H6/M1 (pre-gate artifact), M2 (retro model stamping), M3 (usage rollup on budget stop; the budget reads the ledger, not `out.usage`), M9 (toggle-gate message) — all in code this diff does not touch.

## Audit trail (/audit-code, base 9865dc65, SID audit-code-1795305783557-49708)

R1–R6, measured GPT spend ≈ $2.2 (0.79 + 0.30 + 0.30 + 0.27 + 0.28 + 0.28). Fixed from the rounds: case-preserving and delimiter-unambiguous manual topic id, completed zero-finding baseline, a usage-less or partial-usage reply is unmeasured (retry gate and ledger row), `--line` positive integer, stdout drain on both `--add` exits. Dismissed with evidence: the redaction-test claims (no such regex in the file), raw-array bind on a read predicate (read-side contract), provider-error rows without usage being free (documented policy), incomplete-usage cells (counted unmeasured, now pinned). Deferred as debt (15+ entries, cloud-synced): repo identity / unit re-key (schema-bound), pre-gate artifact provenance, per-canonical dedupe semantics, rename-to-sensitive egress listing, judge-gpt resume, retro model stamping.

R6 was not clean (the remaining findings are repeats of the deferred concerns plus dismissed claims; coverage `partial`: the 153 KB `solo-control-audit.mjs` is windowed for GPT). Structural-or-stop card read: **STOP** — accept the rest as debt, and rely on the Gemini final gate with FULL coverage on the exact head; no post-R6 code fix is outstanding.

## Not verified

* H9's SQL against a real Postgres (text + stub-query tests only; CI's DB suites do not enrol this query).
* No paid solo-control or model-eval run was made; the retry gate and fingerprint pin are exercised through stub clients.
