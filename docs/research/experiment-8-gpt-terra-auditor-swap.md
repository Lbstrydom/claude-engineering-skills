# Experiment 8 — gpt-6.1-terra vs gpt-6.1-sol for the GPT auditor

**Date**: 2026-10-28 · **Role**: auditor (the 5-pass GPT generator) · **Question**:
should `gpt-6.1-terra`, released at half `gpt-6.1-sol`'s list price, replace the
`OPENAI_AUDIT_MODEL=gpt-6.1-sol` pin set by
[experiment 7](./experiment-7-gpt-sol-auditor-swap.md)?

**Verdict: switch to `gpt-6.1-terra`, on cost grounds, with quality matched on
the cases examined.** On the 11 cases from experiment 7 it cost 42% to 47% less
(`derived`) than `gpt-6.1-sol` on identical input. Its findings named the same
file as `gpt-6.1-sol` in 9 of 11 cases at default effort, and the one differing
claim checked by hand was a real defect. The operator approved the switch on
2026-10-28: the operator's local `.env` now pins `OPENAI_AUDIT_MODEL=gpt-6.1-terra`.
Same shape as experiment 7: the harness cannot rank two GPT models, so this is
a cost decision with "not worse on 11 cases" as its quality evidence.

---

## 1. What was measured

Revision `6f6970c0` (pinned fixture `terra-eval-2026-10-28`, removed after the
run). Corpus `known-defects.json`. Store `d5a9d07b91225a93`. All figures
`measured` unless labelled.

### 1.1 Access

A one-call probe through `createOpenAIClient({purpose:'gpt'})` returned for both
`gpt-6.1-terra` and `gpt-6.1-sol` with the operator's key.

### 1.2 Harness screen tier (run of record)

```bash
node scripts/model-eval-auditor.mjs --candidate '{"kind":"pinned-model","value":"gpt-6.1-terra"}' --tier screen --repo-roots C:/GIT/claude-engineering-skills,C:/GIT/ai-organiser,C:/GIT/wine-cellar-app
```

runId `3f3ca25e`, verdict `inconclusive`. This is the expected outcome, not a
finding. Experiment 7 §1.2 records why: the screen tier credits one guess per
case and only the curated defect, and GPT-vs-GPT shares an independence group,
so the promotion tier falls back to the same Tier C scorer.

### 1.3 Tier C raw-output probe (both arms, two effort levels)

A scratch probe ran the harness's own `loadCorpusCase` + `extractStructured`
over experiment 7's 11 cases (KD-021, KD-005, KD-006, KD-024, KD-016, KD-018,
KD-013, KD-026, KD-012, KD-020, KD-019), keeping every output and its usage.
Identical input to every arm: 166,133 tokens.

| arm | cases | file in expected set | output tok | reasoning tok | cost (11) | median latency |
|---|---|---|---|---|---|---|
| **gpt-6.1-terra**, default effort | 11 | 3 | 4,889 | 3,949 | **$0.191** | 6.6 s |
| gpt-6.1-sol, default effort | 11 | 3 | 2,777 | 1,495 | $0.360 | 7.6 s |
| **gpt-6.1-terra**, `high` | 11 | 4 | 17,299 | 16,383 | **$0.253** | 19.8 s |
| gpt-6.1-sol, `high` | 11 | 4 | 10,068 | 8,806 | $0.433 | 24.7 s |

Terra's cost is `derived` from tokens at the list rates below, because the
pricing table had no Terra row when the probe ran (the probe reported its cost
as null, not zero). Sol's cost is the measured figure, and it matches the same
derivation.

Terra spends about 1.7x to 2.6x Sol's output tokens, mostly on reasoning. At
half the rate it is still the cheaper arm at both effort levels. Production pins
`high` for the backend and frontend passes, so the `high` rows are the closer
estimate: **-42%**.

### 1.4 Hand comparison of the findings

At default effort the two arms named the same file in 9 of 11 cases. Their
descriptions were the same defect in 6 of those 9 (KD-021, KD-006, KD-016,
KD-018, KD-026, KD-012). Where they differed:

| case | gpt-6.1-terra | gpt-6.1-sol | check |
|---|---|---|---|
| KD-020 (`1823c7c8`) | `--save-dev` install of deps missing from `node_modules` moves existing prod deps (e.g. `openai`) into devDependencies on a fresh checkout | (high) `execFileSync('npm')` fails on Windows | **both real**: `install-skills.mjs:225` decides "missing" from `node_modules` alone, and `:233` runs `npm install --save-dev` on that list |
| KD-005 | a self-consistency breach excludes one arm, then still allows a credible verdict | the human-anchor gate counts sessions, not tasks | not checked; both plausible |
| KD-024 | PascalCase components become independent keywords | dot/underscore normalisation mismatch | not checked; both plausible |
| KD-013 | `titleEl.setText` removes the rename button | detached `titleSpan` after the first rename | not checked; `gpt-6-sol` raised Terra's claim in experiment 7 |

Terra at `high` was the only arm to find KD-016's curated defect file
(`scripts/openai-audit.mjs`). Sol at `high` was the only arm to find KD-012's
(`embeddingQueue.ts`).

n=11, one rater, one hand check. This supports "not worse", nothing stronger.

## 2. Cost

Rates read 2026-10-28 from developers.openai.com/api/docs/pricing ($/1M,
<272K context / long context):

- `gpt-6.1-terra`: $1 / cached $0.05 / $5, and $2 / $0.10 / $7.50.
- `gpt-6.1-sol`: $2 / $0.10 / $10, and $4 / $0.20 / $15.

This PR adds the Terra row to `model-pricing-table.mjs`.

## 3. Resolver change bundled with the switch

The live catalog already resolved `latest-gpt` to `gpt-6.1-terra`, while the
offline `STATIC_POOL` resolved it to `gpt-6.1-sol`. Both ids parsed as plain
SKUs at 6.1, so list order decided the tie. `parseOpenAIModel` now marks `sol`
premium at 6.1, the same way OpenAI prices it (2x terra). `latest-gpt` therefore
resolves to Terra deterministically, online and offline.

This has one consequence for the Azure work profile:
`azure:doctor --target gpt` no longer guesses a `gpt-6.1-sol` deployment, so a
tenant that serves only that SKU names it with `--candidate`. That follows the
existing rule that a premium SKU is never guessed.

## 4. Spend

About **$1.30** (`derived`: probe $1.24 from usage at list rates, plus the
screen run's 4 cases at about $0.07).

## 5. Rollback trigger

Revert `OPENAI_AUDIT_MODEL` to `gpt-6.1-sol` if any of these happens:

- the Gemini final gate's `wrongly_dismissed` or release-blocking count rises
  across consecutive runs after 2026-10-28;
- a shipped defect is traced to a GPT finding that was missed;
- a discriminating evaluation (experiment 7 §5) ranks Terra below Sol.
