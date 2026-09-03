# R2+ audit mode — the three-layer churn defence, in detail

Moved out of `AGENTS.md` (2026-09-03) under its progressive-disclosure rule.
AGENTS.md keeps what R2+ *is*, the three layers in one line each, the two
invariants that constrain anyone changing them, and the CLI flags. Everything
below is the elaboration.

## Layer 3 is called unconditionally, and exempts `reopened`

`suppressReRaises()` fuzzy-matches findings against the ledger; then, when the
cloud store is on, `runCloudFpPass()` applies the cloud FP-pattern policy
([`cloud-fp-suppression-read-loop.md`](../plans/cloud-fp-suppression-read-loop.md)).

Two properties are load-bearing:

- **It runs outside the ledger branch.** A no-ledger run is exactly the case a
  pattern learned on another machine serves, so gating it on a local ledger
  would disable it where it helps most.
- **It exempts `reopened`**, so category statistics can never mask a regression.

Layer 1 stays local-ledger-only, deliberately: a pre-generation "do NOT raise X"
hint can stop a required reopen from ever reaching the classifier, so the cloud
policy does **not** feed the prompt.

## A rulings group's header may claim only what its ruling ESTABLISHED (2026-08-14)

`buildRulingsBlock` renders four groups, and their instructions differ in
strength on purpose:

| Group | What the ruling established | Instruction strength |
|---|---|---|
| DISMISSED | a disproof — "you ruled this false" | strongest |
| FIXED | it was repaired | keeps the reopen-on-material-change clause |
| ADJUSTED | the severity was wrong, not the finding | bars re-escalation only |
| DEFERRED | the SCOPE was wrong; the defect is real and still present | bars re-arguing scope, and **explicitly licenses a different defect in the same code** |

The DEFERRED group exists because `ruling` is a **separate axis** from
`adjudicationOutcome` (`LedgerEntrySchema`), so the sanctioned deferral shape
(`accepted` + `pending`) matched no group at all and was invisible to the next
round. The auditor therefore re-litigated the same scope decision, with the same
reasoning, every round.

**Adding a group?** State what its ruling *proved*, and give it the weakest
instruction that is true. An overstated header suppresses true positives — which
is the failure mode that costs most, because it is silent.

## The existence gate runs on BOTH reviewer paths (2026-08-14)

`verifyExistenceFindings`
([finding-verification.mjs](../../scripts/lib/audit/finding-verification.mjs))
mechanically refutes "file/module X does not exist" against the repo inventory.

It ran only in the GPT path for its whole life — `gemini-review.mjs` never called
it — so a false absence claim from the *final* reviewer could only be answered by
argument. It is now wired via `applyExistenceGate` at both post-parse filter
chains.

Two traps, both of which made the gate look alive while classifying nothing:

1. **`wrongly_dismissed` shares no field name with `FindingBase`.** Without a
   projection the gate runs and classifies zero — a green that means "nothing was
   examined", not "nothing was wrong".
2. **The noun→claim bridge must not treat a filename's dot as a sentence
   boundary.** Use `CLAIM_GAP`, not `[^.]`. That hole made the two most natural
   absence phrasings unclassifiable while extension-free prose still matched, so
   the gate's own output looked healthy.

Widening classification is the safe direction here: an unadjudicable claim
becomes `requires_verification` with its severity preserved, and only `refuted`
downgrades anything.
