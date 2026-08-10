# `.campaigns/` — model-comparison campaign configs

A **campaign** answers one operator question — *"should this model replace the
incumbent for this role?"* — with pre-registered arms, a declared decision rule,
and evidence that cannot be silently relabelled.

These files are **committed and consumer-owned**. They are the reviewable
artefact: a diff here is a change to what will be asked of the models, and that
is the point.

> Plan: [`docs/plans/model-comparison-campaigns.md`](../docs/plans/model-comparison-campaigns.md)
> — §2.5a is the authoritative schema, §2.5b the lock.

## Anatomy

| Field | What it fixes |
|---|---|
| `id` | Campaign identity. Becomes a path component, so `^[a-z0-9][a-z0-9-]{0,63}$` |
| `decision.incumbent` | The model to beat. Must name exactly one non-replicate arm's `model` |
| `arms[]` | The comparison. `mode: primary` at most once; `type: "replicate"` marks a same-model re-run used to measure run-to-run variance, and never gates completeness |
| `controls` | The **declared** effective request spec — the dials that make two arms comparable |
| `adjudicator` | A declared participant, not an ambient default |
| `calibration.sampleRate` | Fraction of agent verdicts sampled for human calibration (`0.1`–`1.0`) |
| `targetN` | Snapshots needed for a verdict. Floor of **12**; below it the verdict engine returns INCONCLUSIVE regardless of what this says |
| `decisionRule` | Pre-registered: how the winner is chosen, decided **before** the data |

## Two rules worth knowing before you edit one

**Validation is strict and closed.** Unknown keys are rejected. A typo'd
`reasoningEfort` fails loudly rather than quietly running at a provider default
— an unpinned dial is how a comparison becomes uninterpretable *after* the spend.

**Not every field costs you your evidence.** Only the collection-relevant subset
— `role`, `decision`, `arms`, `controls` — is hashed into `configDigest` and
from there into the cohort lock. Editing those changes what is asked of the
models, so prior snapshots are orphaned into their own cohort (reported, never
deleted, never relabelled).

`targetN`, `calibration` and the whole `decisionRule` are deliberately **outside**
every digest. They change how already-collected evidence is *read*, never what it
means, so editing a cost ceiling must not throw away a campaign's collection.

That exemption is not a licence to retune the rule until the answer is
agreeable. Every change to an analysis-time field appends a `rule_changed` event
with before/after and the operator, and the standings watermark any verdict
whose decision rule changed after the first arm-run was collected. The evidence
survives; the fact that the goalposts moved is recorded next to the number.

## Adding a campaign

1. Copy an existing file, change `id` (it must be unique — the runner **refuses**
   and lists ids rather than picking one when several exist and no `--campaign`
   is passed).
2. Declare at least **two non-replicate arms**. One arm is not a comparison.
3. Commit it. An absent `.campaigns/` directory is not an error — a repo may
   simply never run campaigns.
