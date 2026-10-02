# Experiment 7 — gpt-6.1-sol vs gpt-6-sol vs gpt-5.6-sol for the GPT auditor

**Date**: 2026-10-01 · **Role**: auditor (the 5-pass GPT generator) · **Question**:
should `gpt-6.1-sol` be the GPT auditor, replacing the operator's local
`OPENAI_AUDIT_MODEL=gpt-5.6-sol` pin (2026-09-30)?

**Verdict: switch to `gpt-6.1-sol` (via `latest-gpt`), on cost grounds. Quality
difference is UNMEASURED by the harness — the instrument scored all three arms
identically at zero — and a 3-case hand spot-check found `gpt-6.1-sol` no worse
(one case better).** Same shape as
[experiment-6](./experiment-6-adjudicator-swap-and-the-unreachable-rule.md): a
cost decision with the quality claim explicitly not established.

---

## 1. What was measured

Revision `2ccc9496` (linked worktree, no commits during the runs). Corpus
`known-defects.json` v3 (18 entries). Store `d5a9d07b91225a93`. All figures
`measured` unless labelled.

### 1.1 Harness screen tier (the runs of record)

```bash
node scripts/model-eval-auditor.mjs --candidate '{"kind":"pinned-model","value":"gpt-6.1-sol"}' --tier screen --repo-roots C:/GIT/claude-engineering-skills,C:/GIT/ai-organiser,C:/GIT/wine-cellar-app
```

(repeated for `gpt-6-sol`, `gpt-5.6-sol`). Seeded KD subset: KD-021, KD-005,
KD-006, KD-024.

| arm | runId | recall | FPR | verdict |
|---|---|---|---|---|
| gpt-6.1-sol | `7e24cec7` | 0 | 1.0 | inconclusive |
| gpt-6-sol | `301c77c9` | 0 | 1.0 | inconclusive |
| gpt-5.6-sol | `a0364be0` | 0 | 1.0 | inconclusive |

### 1.2 Tier C raw-output probe (replaces the promotion tier)

The promotion tier cannot do better here: for GPT-vs-GPT the candidate and
baseline share an independence group, so `resolveEvaluationTier` returns Tier C
unconditionally (`scripts/lib/model-eval/route-catalog.mjs:360`, `2ccc9496`) —
the same `extractStructured` + `scoreDefectLocalization` as the screen tier, and
its baseline would be `latest-gpt` = `gpt-6.1-sol`, i.e. the candidate. Tier C
also **discards the raw per-case outputs**, so the runbook's "read the raw
output before believing low recall" step is impossible from a harness run. A
scratch probe re-ran the identical functions over the union of the screen and
promotion subsets (11 cases: + KD-016, KD-018, KD-013, KD-026, KD-012, KD-020,
KD-019), all three arms, keeping outputs and usage. Default reasoning effort
(no dial), identical input to every arm (166,133 input tokens).

| arm | recall (11) | FPR (11) | cost (11 cases) | output tok | reasoning tok | median latency |
|---|---|---|---|---|---|---|
| **gpt-6.1-sol** | 0 | 1.0 | **$0.357** | 2,491 | 1,213 | 8.4 s |
| gpt-6-sol | 0 | 1.0 | $0.391 | 5,841 | 4,863 | 10.3 s |
| gpt-5.6-sol | 0 | 1.0 | $0.885 | 11,042 | 9,863 | 20.8 s |

Every response was well-formed and named a real file with a concrete,
plausible defect — the zero is the documented oracle ceiling (one location
guess per case, credited only if it is THE curated defect), not an instrument
failure. All three arms chose the same file on 6/11 cases and frequently the
same alternative bug, so the corpus is not discriminating between these models.

### 1.3 Hand spot-check of the alternative findings (at each KD's buggy commit)

| case | gpt-6.1-sol | gpt-6-sol | gpt-5.6-sol |
|---|---|---|---|
| KD-026 (`be9545d6`) — `--dry-run` still runs `ensureLedger` DDL (`setup-postgres.mjs:441`) | real | real | real |
| KD-020 (`1823c7c8`) | **real** — `execFileSync('npm', …)` fails on Windows (`npm.cmd`) | **false** — claims `--dry-run` reaches `npm install`; it `process.exit(0)`s at line 190 first | **false** — same claim |
| KD-018 (`2f577183`) — override looked up by `cand.id` before the frozen-id remap (`ledger.mjs:141`) | plausible | plausible | plausible |

n=3, one rater. It licenses "not worse", nothing stronger.

## 2. Cost

Rates read 2026-10-01 from developers.openai.com/api/docs/pricing ($/1M, <272K
context): gpt-6.1-sol $2 / cached $0.10 / $10 · gpt-6-sol $2 / $0.20 / $10 ·
gpt-5.6-sol $4 / $0.40 / $20 (promotional "at least through November 21, 2026").
`model-pricing-table.mjs` already carries all three correctly.

On identical input, `gpt-5.6-sol` cost **2.5x** `gpt-6.1-sol` (`measured`, §1.2):
2x from the rate card, the rest from ~4.4x more output tokens (mostly
reasoning). `gpt-6.1-sol` was also 2.5x faster at the median.

Caveat on the reasoning gap: these calls ran at the API default (`medium`).
Production pins effort per pass (`PASS_REASONING`, `high` for backend/frontend),
so the token gap there is unmeasured; the rate-card 2x is the floor.

## 3. Request-shape compatibility

`gpt-6.1-sol` rejects reasoning effort `none`/`minimal` and supports tools only
on the Responses API (OpenAI model page, 2026-10-01). Every GPT call site's
effort comes from a closed set of `low|medium|high` (`VALID_REASONING`,
`PASS_REASONING`, `finalReviewConfig.reasoningEffort`, the per-pass literals in
`legacy-production-audit.mjs`) or `low…max` (`EFFORT_LEVELS`); brainstorm
`DEPTH_REASONING_EFFORT` is `low|null`. No GPT Chat Completions call passes
`tools` (the only Chat Completions tool path is the OpenRouter OSS adapter). No
fix needed.

## 4. Spend

≈ **$2.20** (`derived`: probe $1.63 measured from usage; the three screen runs
report `cost: null`, estimated $0.57 from the same cases' per-call cost).

## 5. What would change this verdict

- A Tier A/B GPT-vs-GPT comparison — impossible in this harness by construction
  (same independence group); would need the production 5-pass run on both arms
  and a cross-family blind judge.
- A corpus whose cases have one *unambiguous* defect, so that single-guess
  recall can move off zero.
- gpt-5.6-sol's promotional price ending (21 Nov 2026) only widens the gap.

## 6. Rollback trigger

This is a cost-only decision. Experiment 7 supports **no** claim that
`gpt-6.1-sol` audits as well as or better than the alternatives, beyond the
three hand-checked cases in §1.3. Revert to an explicit `OPENAI_AUDIT_MODEL`
pin if either of these happens:

- a discriminating evaluation (see §5) ranks `gpt-6.1-sol` below a comparator;
- production audits regress observably, e.g. the Gemini final gate's
  `wrongly_dismissed` or release-blocking count rises across consecutive runs,
  or a shipped defect is traced to a missed GPT finding.

## Appendix — per-case outputs (Tier C probe, default effort)

Each arm's single defect-location guess, truncated to 90 characters. Full
outputs and usage were kept for the same-sitting adjudication but are not
committed (Category A run bundle). The store keeps the three screen runs only
as metrics.

| case | expected file | gpt-6.1-sol | gpt-6-sol | gpt-5.6-sol |
|---|---|---|---|---|
| KD-021 | `scripts/symbol-index/refresh.mjs` | `scripts/lib/subprocess.mjs` — child.stdin has no 'error' listener. If a child exits or closes stdin before consuming opt… | `tests/subprocess.test.mjs` — Both signal-kill tests launch children that run forever but never kill or await them. Thei… | `tests/subprocess.test.mjs` — The two signal-related tests start subprocesses that run forever (`setInterval`) but never… |
| KD-005 | `scripts/lib/arm-eval/judge.mjs` | `scripts/lib/arm-eval/decision.mjs` — The human-anchor gate counts sessions (`anchorTasks = humanRankings.length`), not distinct… | `scripts/lib/arm-eval/decision.mjs` — Human rankings are persisted as opaque output labels, but evaluateArmEval compares them di… | `scripts/lib/arm-eval/decision.mjs` — The human-anchor threshold counts ranking sessions, not distinct tasks: `anchorTasks = hum… |
| KD-006 | `scripts/lib/store/debt.mjs`, `scripts/lib/store/persona.mjs`, `scripts/lib/store/plans-ship.mjs` | `scripts/lib/store/arch-memory.mjs` — recordSymbolEmbedding passes the JavaScript vector array directly as `embedding`. node-pos… | `scripts/lib/store/plans-ship.mjs` — recordRegressionSpec uses ON CONFLICT (repo_id, candidate_fingerprint) for candidate rows,… | `scripts/lib/store/persona.mjs` — `recordPersonaSession()` always returns `existed: false`, even when `ON CONFLICT session_i… |
| KD-024 | `scripts/lib/file-io.mjs` | `scripts/lib/file-io.mjs` — Fuzzy matching strips underscores, dots, and hyphens from file basenames but does not appl… | `scripts/lib/file-io.mjs` — Fuzzy discovery treats generic heading words and PascalCase components as file matches. Fo… | `scripts/lib/file-io.mjs` — Fuzzy discovery treats generic PascalCase components such as `service` as independent keyw… |
| KD-016 | `scripts/openai-audit.mjs` | `skills/cycle/SKILL.md` — The new Step 3 decision table incorrectly includes SKIP_PLAN in every implementation-gate … | `skills/cycle/SKILL.md` — The new Step 3 decision table sends `SKIP_PLAN` runs to the pause or autonomous-implementa… | `scripts/openai-audit.mjs` — The A1 guard counts all effective backend and frontend files without considering `--passes… |
| KD-018 | `scripts/lib/requirements/gap-challenge.mjs` | `scripts/lib/requirements/ledger.mjs` — In reconcile(), overrides are looked up using overrides[cand.id] before resolving the cand… | `scripts/lib/requirements/ledger.mjs` — After a reworded candidate is matched to a prior requirement, `reconcile` looks up its ove… | `scripts/lib/requirements/ledger.mjs` — Overrides are looked up using `overrides[cand.id]` before the candidate is mapped to its f… |
| KD-013 | `src/services/chat/conversationPersistenceService.ts` | `src/ui/modals/ChatResumePickerModal.ts` — After the first inline rename is saved or cancelled, subsequent renames on that row stop w… | `src/ui/modals/UnifiedChatModal.ts` — When a conversation with a custom title is resumed, `this.titleEl.setText(state.customTitl… | `src/ui/modals/UnifiedChatModal.ts` — When restoring a conversation with a custom title, `this.titleEl.setText(state.customTitle… |
| KD-026 | `scripts/setup-postgres.mjs` | `scripts/setup-postgres.mjs` — --dry-run still modifies the database. runMigrate() unconditionally calls ensureLedger(), … | `scripts/setup-postgres.mjs` — `--dry-run` can modify the database. `runMigrate()` always calls `ensureLedger()`, which c… | `scripts/setup-postgres.mjs` — `--dry-run` violates its documented “touch nothing” behavior. `runMigrate()` unconditional… |
| KD-012 | `src/services/vector/embeddingQueue.ts` | `src/services/vector/vectorStoreService.ts` — The queue-backed indexNoteInternal() returns true after awaiting completion even when embe… | `src/services/vector/vectorStoreService.ts` — In the queued path, indexNoteInternal returns true after awaiting completion even when the… | `src/services/vector/vectorStoreService.ts` — The queued indexing path always returns `true`, even when embedding fails or `onBatchSucce… |
| KD-020 | `scripts/install-skills.mjs` | `scripts/install-skills.mjs` — Both dependency-install calls use execFileSync('npm', ...), which fails on standard Window… | `scripts/install-skills.mjs` — The new dependency-install block ignores `args.dryRun`. When the target has a package.json… | `scripts/install-skills.mjs` — The new dependency-installation block does not honor `args.dryRun`. Running the documented… |
| KD-019 | `scripts/check-skill-updates.mjs` | `scripts/lib/install/conflict-detector.mjs` — detectConflicts hashes the entire copilot-instructions.md file, but the installer records … | `scripts/install-skills.mjs` — The receipt records only the managed block’s SHA for `.github/copilot-instructions.md`, bu… | `scripts/lib/bootstrap-template.mjs` — The bootstrap downloads only the selected entry script into a flattened cache filename, bu… |
