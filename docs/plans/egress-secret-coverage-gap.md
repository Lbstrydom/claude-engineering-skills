# Plan: Egress secret coverage — the two layers are not independent

- **Date**: 2026-07-19
- **Status**: Draft
- **Author**: Claude + Louis
- **Scope**: backend
- **Severity**: HIGH — four secret shapes currently reach an external LLM provider
- **Origin**: found while reviewing the Tier-3 egress tests added alongside the
  arch-memory intent normalizer. The tests pass; the seam leaks anyway.

---

## 1. The measured defect

The egress path is documented as two layers — `redactSecrets` rewrites, then
`assertEgressSafe` refuses what redaction missed. Measured 2026-07-19, **the
second layer catches nothing the first does not**:

| Shape | `redactSecrets` | `assertEgressSafe` (on RAW text) | Reaches provider |
|---|---|---|---|
| DSN password | redacts | refuses | no |
| GitHub PAT | redacts | refuses | no |
| OpenAI key | redacts | — | no |
| Slack token | redacts | — | no |
| AWS access key **id** | redacts | — | no |
| **AWS secret access key** | **misses** | **misses** | **YES** |
| **JWT** | **misses** | **misses** | **YES** |
| **`-----BEGIN RSA PRIVATE KEY-----`** | **misses** | **misses** | **YES** |
| **Generic 40-char hex** | **misses** | **misses** | **YES** |

The gate's pattern set is a **strict subset** of the redactor's. So the layers do
not fail differently — they fail identically, and "defence in depth" here is one
layer applied twice. Every shape redaction misses passes the gate by construction.

Proven end-to-end through the real composition
(`neighbourhood-query.mjs:210 → 222 → 224`): an intent carrying an AWS secret
access key is redacted (the *id* is caught, the *secret* is not), passes the
gate, and arrives in the provider payload verbatim.

## 2. Why the obvious fix is not the fix

**Rejected: "add an AWS secret pattern."** It closes one of four rows and leaves
the architecture untouched — the next unlisted shape leaks identically. The
defect is not a missing pattern; it is that **the refusing layer inherits the
rewriting layer's blind spots**. A pattern-list gate behind a pattern-list
redactor can only ever be redundant.

Note also what this means for the tests already written: they cannot catch this
class. A test that redacts and then asserts "no secret in payload" passes exactly
when the redactor happens to know the shape, and says nothing about the shapes it
does not.

## 3. The asymmetry that makes a fix possible

`redactSecrets` and `assertEgressSafe` have **different failure costs**, and the
current design ignores that:

- A **false positive in the redactor** silently corrupts text — this is precisely
  why AGENTS.md pins the "gentle" `lib/secret-patterns.mjs` rather than
  `sanitizer.mjs`, which blanket-redacts any 20+ char token and "would corrupt
  incident prose". That constraint is correct and stays.
- A **false positive in the gate** merely refuses. On the arch-memory path the
  caller already degrades to `deterministicNormalize` (C10) — an embeddable
  fallback, no exception, no send. **Refusal is cheap there.**

So the gate can afford to be aggressive where the redactor cannot. Making it
entropy- or shape-based rather than pattern-based would give the two layers
genuinely independent failure modes, which is the property currently missing.

## 4. Blast radius — measured, and it constrains the design

`assertEgressSafe` has **20 call sites** across arm-eval, model-eval,
audit-shadow, solo-control, oss-structured-output, and arch-memory. Only the
arch-memory caller is known to degrade gracefully on refusal; the others were not
audited for this and mostly guard **diffs and prompts**, where a false positive
could abort a paid audit run rather than silently degrade.

That rules out simply making the shared gate aggressive. Two candidate shapes,
both needing a decision:

| Option | Trade-off |
|---|---|
| **A. Opt-in strictness** — `assertEgressSafe(text, { strict: true })`, adopted first by arch-memory | Contained blast radius; risks a two-tier gate where the strict mode is the one nobody enables |
| **B. Raise the shared floor** — add the four measured shapes to the gate only (not the redactor) | Keeps one gate; still pattern-based, so it does not fix independence — it only refills the subset |

A is the honest fix for the architecture; B is the cheap fix for today's four
rows. They are not exclusive: B is a legitimate stopgap **if** A is actually
scheduled, and dishonest if it is not.

## 5. Open questions to settle before implementation

1. **How aggressive can a strict gate be before it fires on real diffs?**
   Measure against the known-defect corpus and a sample of real audit payloads —
   a gate that refuses 5% of genuine audits is worse than the leak it prevents.
   This is a measurement, not a judgement call; do it before choosing a threshold.
2. **What do the other 19 call sites do on refusal?** Unaudited. If any of them
   turns a refusal into a crash mid-run, that is a separate defect and it gates
   option A's rollout.
3. **Is the generic-40-hex row a true positive?** A 40-char hex string is also a
   git SHA, which appears legitimately in nearly every diff. This row may be
   *correctly* not-refused, and treating it as a leak would make the gate unusable.
   Decide explicitly; it materially changes the threshold.
4. **Does the redactor need any of this?** Current answer: no — its gentleness is
   a deliberate, documented constraint and this plan does not touch it.

## 6. Acceptance

- The four measured shapes no longer reach a provider payload on the arch-memory
  path — demonstrated by driving the **real** composition, not the primitives.
- A test asserts the layers are **independent**: for at least one shape, the gate
  refuses something the redactor does not rewrite. Today no such case exists,
  which is the whole finding.
- False-positive rate of any new strictness is **measured against real payloads**
  and recorded here, before it gates anything.
- The wiring pin (`tests/arch-memory-egress-wiring.test.mjs`) stays green — this
  plan changes the layers, not the order.

## 7. Explicitly out of scope

Hardening the redactor. Its gentleness is load-bearing for incident prose and is
documented as such; widening it is a different plan with a different risk profile.
