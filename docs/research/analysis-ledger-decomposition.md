# Phase 1 — Ledger decomposition (where does accepted value come from?)

> **Point-in-time SNAPSHOT** — generated from the live ledger by `npm run audit-exp:ledger`.
> It is a dated decision-trail artifact (like the arm-eval session archives), NOT an
> auto-maintained living file; counts drift as audits accumulate. Regenerate to refresh.

> **Survivorship caveat (load-bearing).** These labels only exist for findings the
> apparatus SURFACED. This is a *kill-criterion / ablation* diagnostic, **not** the
> causal answer to "could a solo model do as well" — that is Phase 3. Read it to
> decide which apparatus components look dead and to shrink the paid phases.

- stage_type: `audit-code` · findings: **13963** · accepted: **375** · accepted-value: **1614** (weights {"LOW":1,"MEDIUM":3,"HIGH":8,"CRITICAL":15})

## Accepted value by round (the P1 → P3 gate lever)

| round | accepted count | accepted value | accepted HIGH+ |
|---|---|---|---|
| 1 | 162 | 777 | 65 |
| 2+ | 213 | 837 | 48 |

- **acceptedValueRound1Share = 48.1%** — P1 gate: **≥ 80%** ⇒ round 2-3 look ablatable → compare the *lean* apparatus in Phase 3.

## Accepted by stage (raising stage)

| stage | accepted count | accepted value |
|---|---|---|
| `baseline(gpt-gen/gemini-untagged)` | 342 | 1392 |
| `oss-gen` | 16 | 113 |
| `gpt-round` | 11 | 78 |
| `gemini` | 6 | 31 |

## Gate marginal value

The Gemini gate's OWN net-new findings (`stage='gemini'`): **6/142** accepted (**4.2%**).
P1 gate: acceptance **< 15%** ⇒ the gate's marginal contribution looks low → candidate to drop from the lean apparatus.
*Blind spot*: this does NOT measure findings the gate SUPPRESSED — suppressions aren't recorded as rows.
