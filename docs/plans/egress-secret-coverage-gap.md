# Plan: Egress secret coverage — the two layers are not independent

- **Date**: 2026-07-19
- **Status**: Complete (option B implemented 2026-07-19; §4e records a correction to §1)
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

> **Superseded in part by §4c (2026-07-19).** The "rules out" below assumed an
> unguarded refusal is costly. Auditing all 20 sites showed none of them leaks on
> refusal, and §4b measured zero false positives for keyed matching — so the
> shared floor can be raised without hardening the call sites first. The option
> table stands; its risk weighting does not.

That rules out simply making the shared gate aggressive. Two candidate shapes,
both needing a decision:

| Option | Trade-off |
|---|---|
| **A. Opt-in strictness** — `assertEgressSafe(text, { strict: true })`, adopted first by arch-memory | Contained blast radius; risks a two-tier gate where the strict mode is the one nobody enables |
| **B. Raise the shared floor** — add the four measured shapes to the gate only (not the redactor) | Keeps one gate; still pattern-based, so it does not fix independence — it only refills the subset |

A is the honest fix for the architecture; B is the cheap fix for today's four
rows. They are not exclusive: B is a legitimate stopgap **if** A is actually
scheduled, and dishonest if it is not.

## 4b. Q3 SETTLED (2026-07-19) — and it settles the threshold question with it

Measured against **18 MB of real audit payload** (the last 200 commits' diffs —
the actual shape of what gets sent):

| Shape | Bare-pattern false positives | Keyed-context false positives | Verdict |
|---|---|---|---|
| Generic 40-hex | **227** occurrences, **206 distinct — 205 resolve as real git objects**, the 1 remainder being git's all-zeros null-ref sentinel | **0** | **Bare is unusable. Keyed is free.** |
| AWS secret (40-char base64) | **301** | **0** | **Bare is unusable. Keyed is free.** |
| JWT | **0** | — | Safe to match bare |
| `BEGIN … PRIVATE KEY` | **6** — all six are *prose documenting the pattern*, not keys | — | Near-safe bare; see caveat |

**Answer to Q3: the generic-40-hex row is a FALSE POSITIVE as written.** Not one
of the 227 occurrences was a secret; every resolvable token was a git object.
Flagging bare 40-hex would refuse essentially every diff-bearing payload while
catching nothing — the gate would be turned off within a day.

**But "don't flag 40-hex" is also wrong**, and this is the part the original
question missed: a legacy GitHub personal access token *is* exactly 40 hex
characters. The shape is genuinely ambiguous, so the fix is not to include or
exclude it — it is to stop matching on shape alone.

**The disambiguator, measured**: require a secret-ish key within a short window
(`token|secret|api_key|password|auth|credential`). Across the same 18 MB that
yields **zero** false positives while still flagging
`GITHUB_TOKEN=<40-hex>`, and correctly allowing a bare SHA in a diff, the
`ZERO_SHA="000…"` sentinel, and prose citing a commit.

Two consequences for the design above:

- **Option B becomes viable and cheap.** It was written off as "still
  pattern-based, only refills the subset" — true, but with keyed patterns its
  measured false-positive cost is zero, which is what actually blocked it. B is
  now the sensible first move rather than a stopgap.
- **Q1 is largely answered for these four shapes.** The remaining threshold risk
  is not 40-hex at all; it is the private-key header, whose only false positives
  are *documentation about secrets* — including this repo's own security docs.
  A gate that refuses payloads for discussing PEM blocks is a real irritant, so
  that row needs the keyed treatment too, or an explicit prose carve-out.

Method note: the first run of this measurement was **wrong** — `grep` treated the
concatenated diff as binary and its "Binary file … matches" warning was counted
as a token, yielding "1 distinct token". Re-run with `-a`. Recorded because the
error direction was reassuring (it under-reported), which is exactly the kind
that survives review.

## 4c. Q2 SETTLED (2026-07-19) — no call site leaks on refusal; Q2 does not gate rollout

Audited all **20** call sites by AST (`assertEgressSafe` inside a `try` block,
then whether every caller of the enclosing function is itself wrapped):

| Refusal behaviour | Sites | Paths |
|---|---|---|
| Caught locally, degrades to a non-sending fallback | 5 | `structured-extractor` (returns `egressDecision:'blocked'`, null context) · `cluster-propose` (`dupFallback()` — *"never send"*) · `arm-eval/judge` · `oss-structured-output:268` · `neighbourhood-query` (C10 deterministic path) |
| Unguarded locally, but **every caller catches** → per-item skip | 8 | `extractDiff`, `runGptPass`, `runGeminiReview`, `runGeminiPass`, `runOssPass`, `runGptJudgeBatch`, `loadCorpusCase`, `invokeStructured` |
| **Propagates to the top** — run aborts | ~5 | `runAuditGenerationArm`, `assertJudgePayloadSafe`, `ossStructuredCall` (5 of 6 callers unwrapped), `runStage` (1 of 2), `produceBrainstorm`/`producePlan` (dispatched at `scripts/lib/arm-eval/run.mjs:75-76`, whose only `catch` covers archive export) |

**The security answer is clean: not one site sends after a refusal.** Every path
either aborts before the wire call or returns a fallback that does not send. The
assert is consistently placed immediately before the provider call, so a throw
cannot be stepped over. There is no "catch and continue anyway" anywhere.

**So Q2's premise was wrong, and this is the useful part.** §4 assumed unguarded
propagation was the blocker — "a false positive could abort a paid audit run
rather than silently degrade". Two corrections:

1. The variance between the three rows above is **operational, not
   security-relevant**: lose-the-run versus lose-one-item. Both are fail-closed.
2. Aborting on a *true* positive is arguably the **correct** behaviour for a
   security gate, not a defect. The abort is only a cost when the refusal is a
   false positive — and §4b measured the keyed form at **zero** false positives
   across 18 MB of real payload.

Combined, that removes Q2 as a rollout gate: **option B (keyed patterns on the
gate) can ship without first hardening 15 call sites**, because the failure it
would newly trigger is one that (a) never fires on measured-real payloads and
(b) fails safe in every path when it does.

What remains genuinely worth doing, at much lower priority: the ~5 propagating
paths would produce a stack trace rather than a diagnosable message, which is a
poor operator experience for a security refusal. That is an ergonomics item, not
a correctness one, and should not block the fix.

**Limits of this analysis, stated so it is not over-trusted**: it is static and
two levels deep. Dependency-injected dispatch (`d.producePlan`) was followed by
name, but a caller reached through a differently-named indirection could be
missed. It also assumes an outer `catch` handles rather than rethrows — verified
for the five local catches above, not exhaustively for every ancestor.

## 4d. Q1 SETTLED (2026-07-19) — the final detector set, all measured at zero FP

The PEM row is the one §4b left open. Keying it (as for 40-hex and AWS) would be
**wrong**: a leaked private key appears as a header followed by base64, with no
`secret=`/`token=` beside it, so a keyed matcher would miss the very thing it is
for. The distinguishing feature is not context but **structure** — real keys have
a body; prose about keys does not.

| Shape | Detector | FPs / 18 MB | Catches the real thing |
|---|---|---|---|
| Generic 40-hex | keyed context | **0** (vs 227 bare) | `GITHUB_TOKEN=<40-hex>` ✓ |
| AWS secret (40-char b64) | keyed context | **0** (vs 301 bare) | ✓ |
| JWT | bare structural | **0** | ✓ |
| PEM private key | header **+ base64 body** | **0** (vs 6 bare) | ✓ real key flagged, prose allowed |

Verified both directions on the PEM row: a real `-----BEGIN RSA PRIVATE KEY-----`
plus body is flagged; the documentation string that produced all six bare-header
false positives (`"…(e.g. \`-----BEGIN RSA PRIVATE KEY-----\n<20 lines of
base64>\`)"`) is allowed.

With Q1, Q2 and Q3 all settled empirically, **option B is implementable now** and
its measured cost is zero false positives on real traffic.

## 4e. IMPLEMENTED (2026-07-19) — option B, and a correction to §1

Gate-only patterns added to `scripts/lib/sensitive-egress-gate.mjs`, **not** to the redactor:
`gate:keyed-b64-40`, `gate:jwt`, `gate:pem-truncated`. The
`gate:` prefix is load-bearing — `scripts/lib/secret-patterns.mjs` already exports a
`pem-private-key`, and an unprefixed duplicate made a shared-scanner hit read as
a gate-only hit, costing real time during this change.

**Correction to §1: the "PEM private key reaches the provider" row was WRONG.**
The probe used a bare `-----BEGIN RSA PRIVATE KEY-----` header with no key
material — that is prose, not a secret, and both layers correctly ignore it. The
redactor *does* catch a complete `BEGIN…END` key (`scripts/lib/secret-patterns.mjs:46`).

The real gap is narrower and was found only by re-testing with proper fixtures:
the redactor's pattern **requires the `-----END …-----` terminator**, so a
**truncated** PEM block — clipped by a diff hunk, or split across a payload
boundary — passes through with its body intact. That is what `gate:pem-truncated`
catches, and it is a better finding than the one it replaces: it is a shape the
redactor structurally cannot see, which is precisely the independence this plan
is about.

A second fixture error is recorded for the same reason: the original AWS probe
used a 39-character token (the canonical example mistyped, `/` → `0`), so it was
not a valid AWS secret-key shape at all. Both errors were self-inflicted and both
were caught by re-measuring rather than by review.

**Verification**
- The four shapes are refused post-redaction through the real composition, each
  attributed to its own `gate:` pattern.
- **Zero refusals across 18 MB of real audit payload** (91 chunks, post-redaction
  — the order production uses).
- Legitimate shapes still pass: bare git SHAs, the null-ref sentinel, prose citing
  a commit, PEM headers in documentation, bare 40-char base64.
- `tests/egress-gate-only-patterns.test.mjs` asserts **independence** (redactor
  leaves it AND gate refuses it), not merely coverage — so moving a pattern into
  the shared scanner, which would silently re-collapse the layers, fails the test.
- Mutation-tested: disabling the gate-only set fails 5 of 12.
- `npm run check`: 7846 pass, 0 fail.

**Not done, and deliberately**: option A (entropy/shape-based strictness). B was
measured at zero false-positive cost, which is what made it the right first move;
A remains the answer if a future shape has no usable key context. The layers are
now genuinely independent for four shapes, not all shapes.


### 4e.1 A side-effect worth its own note: the audit pipeline mangled its own input

Auditing this change produced three HIGH-confidence findings that the new test
file was **syntactically broken** — a single-quoted string crossing newlines, a
dangling template terminator, a fixture holding `[REDACTED:pem-private-key]`
instead of a key. The file was fine; it passed 12/12 and `npm run check` was green.

The auditor was right about what it received. `readFilesAsContext` redacts file
bodies before they reach the provider, and the redactor's `pem-private-key`
pattern spans `BEGIN … END`. The fixture's `BEGIN` and a *different* test's
`END` sat ~80 lines apart, so the whole span — including all the code between
them — collapsed into one placeholder. Three reviewers then reasoned, correctly,
about mangled source.

Two things follow:

1. **Fixed locally**: the fixture is now assembled from parts, so no literal
   `BEGIN … END` span exists in the file. Verified: 117 source lines → 117
   redacted lines, no placeholder.
2. **Generalises beyond this file** (not fixed here — needs its own plan): *any*
   file containing two PEM markers becomes unauditable this way, and the failure
   is silent. The audit context is quietly shortened, and nothing tells the
   reviewer that what they are reading is not what is on disk. A redaction that
   deletes surrounding code is a context-integrity problem, not just a noise
   problem — it is the same "green over content that was never really examined"
   class this repo already tracks elsewhere.

### 4e.2 What the Gemini gate caught — two real evasions and a redundant rule

The consolidated gate returned **CONCERNS with 2 new findings**, both genuine,
and both invisible to a suite that was 12/12 green:

1. **HIGH — the gap matcher forbade letters.** The first revision spelled the gap
   as a negated class (`[^A-Za-z0-9/+=]{0,12}`). Under `/i` that excludes every
   letter, so it could not cross an ordinary variable-name suffix. Measured after
   the report: **4 of 5 realistic spellings leaked** — `AWS_SECRET_KEY=`,
   `api_key_id=`, `GITHUB_TOKEN_VALUE=` and a padded base64 value. The fixtures
   had used `secret <space> <token>`, the one spelling that happened to work.
2. **MEDIUM — `` cannot terminate a base64 token.** A token ending in padding
   (`=`) followed by a delimiter is a non-word/non-word transition, so the
   boundary never fires. Terminators are now negative lookaheads.

Both fixed; the seven realistic spellings are now fixtures, so a future fixture
set cannot be that unrepresentative again.

**A third finding came from mutation-testing the fix**: `gate:keyed-hex-40` was
**redundant** and has been removed. Hex is a subset of the base64 alphabet and
both rules used the same gap, so `keyed-b64-40` already matched every keyed
40-hex token. Its only unique coverage was a 41-character run
(`secret=<40hex>g`) — not a 40-hex secret, so a false positive rather than
coverage. It also made the b64 rule **impossible to mutation-test**: reverting
the hex rule left the suite green because b64 silently covered the same inputs.
With it gone the mutation isolates cleanly (7 of 20 fail).

The lesson worth keeping: green tests over unrepresentative fixtures are exactly
what an independent reviewer is for. The suite passed at every point during this
change while the pattern missed the three most common real-world spellings.

## 5. Open questions to settle before implementation

1. ~~**How aggressive can a strict gate be before it fires on real diffs?**~~
   **SETTLED 2026-07-19 — see §4d.** All four shapes have a detector measured at
   **zero** false positives across 18 MB of real payload. The PEM row is resolved
   by requiring a base64 **body**, not by keying — keying would have missed real
   keys, which have no `secret=` beside them.
2. ~~**What do the other 19 call sites do on refusal?**~~ **SETTLED 2026-07-19 —
   see §4c.** All 20 audited: none sends after a refusal. 5 degrade locally, 8
   are skipped per-item by a catching caller, ~5 abort the run. The variance is
   operational, not security-relevant, and aborting on a true positive is correct
   behaviour — so this does **not** gate rollout, contrary to the assumption
   here. Residual (low priority): the ~5 propagating paths emit a stack trace
   rather than a diagnosable refusal message.
3. ~~**Is the generic-40-hex row a true positive?**~~ **SETTLED 2026-07-19 — see
   §4b.** No: 227 occurrences across 18 MB of real payload, all git SHAs, zero
   secrets. But the shape is genuinely ambiguous (a legacy GitHub PAT is also
   40 hex), so the resolution is keyed-context matching rather than
   include-or-exclude. Measured false-positive cost of the keyed form: **zero**.
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
