# Jev (TypeSafe "System-One" router) — rejected

- **Date**: 2026-11-02
- **Decision**: Rejected (Louis, 2026-11-02). Not adopted, not trialled.
- **Context**: [`docs/plans/skill-best-practice-alignment.md`](../plans/skill-best-practice-alignment.md)

## What it is

Jev is a hosted "System-One" router pitched alongside Claude Code skill best practice: a
`UserPromptSubmit` hook sends each prompt to a TypeSafe endpoint, which classifies it and
tells the agent which skill or workflow to run, instead of letting the host match the
prompt against each skill's `description`.

## Why it was rejected

1. **No current requirement.** Skill routing is already measured here: `claude plugin
   eval . --tag pilot` asserts which skill fires for 13 ambiguous prompts
   ([`plugin-evals.md`](../reference/plugin-evals.md)); the 2026-11-02 baseline passed
   12/13, and the one miss (`audit-code-request`) is a description problem a router would
   paper over rather than fix. Routing quality is a property of the descriptions, which
   this repo already governs (`skills:check`, 1024-char cap, declared discriminators).
2. **Egress of every task's text.** The hook sends the user's prompt — often containing
   code, paths, customer names and plan text — to `api.typesafe.ai` before any work
   starts. This repo's sensitive-path rules exist precisely to keep that class of data
   from reaching third-party services by default; a per-prompt egress to a new vendor
   would need its own security review and gains nothing (point 1).
3. **Measured unreliability.** In the two-model `/brainstorm` debate round that assessed
   it, the router's classifications were sensitive to wording (paraphrases of the same
   request routed differently) and it reported high confidence on the routes it got
   wrong — the overconfidence shape that turns a miss into a silent miss.
4. **Latency on every prompt.** The hook adds 0.75–1.5 s before the first token on every
   prompt, including the ones that need no skill at all.

## What would reopen it

A routing failure the description layer cannot fix (shown by an eval case that keeps
failing after the descriptions are corrected), plus a self-hosted or no-egress deployment
option. Neither exists today.
