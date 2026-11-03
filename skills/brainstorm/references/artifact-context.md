---
summary: Why --with-artifact beats more architecture context, what the policy pack attaches, and the context budgets.
---

# Artifact and architecture context — rationale and mechanics

The resident rules live in SKILL.md Step 0: arch context auto-attaches on
architecture-intent topics, and whenever the topic concerns something that
already exists you pass `--with-artifact <path>`. This file holds the
reasoning and the mechanics behind those rules.

## Architecture context (`--with-arch` / `--no-arch`)

By default the
helper **auto-attaches** the repo's `## Architecture` section whenever the
topic shows architecture intent (same keyword trigger as `--depth` deep:
architecture / schema / migration / refactor / design). This fixes the
asymmetry where Claude's take is codebase-grounded but the external models
saw only the topic. `--with-arch` forces it on for any topic; `--no-arch`
forces it off when you want an unanchored outside view. The flags are
mutually exclusive (helper errors if both are passed).

## Why the focal artifact comes first

Architecture
context describes what *exists*; it does not describe the decision under
debate, and attaching more of it does not help. That was measured, not
assumed: a round with 7,664 chars of `## Architecture` attached still
produced generic answers from both models. The thing that was missing was
the **object under discussion** — and in the failure cases it always
existed as a file (a plan, a diff, one module) that the models only ever
received as Claude's *paraphrase*. They were reviewing a description, and
it showed.

## The policy pack

Attaching an artifact also auto-attaches a **policy pack** — the repo's
standing constraints, so a model can't optimise the local object while
breaking a global rule it was never shown. Two sources, both canonical, no
new prose to maintain: `.requirements/ledger.json` filtered to invariants
governing the artifact's path, plus a fixed manifest of `AGENTS.md` H2
sections (`POLICY_SECTIONS` in `lib/brainstorm/policy-context.mjs`). Both
are resolved at call time — editing the rule in AGENTS.md changes what the
next round sends, with no copy to sync.

## Budgets

Budgets are absolute, not fractions of the provider ceiling: 3,000 tokens
for artifacts (split across them), 2,000 for policy. The binding constraint
is signal density, not window space.
