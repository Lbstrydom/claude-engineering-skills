# Audit summary — anthropic-cli-faithfulness-routing (THROW AND PIN rework)

- **Plan**: [`anthropic-cli-faithfulness-routing.md`](anthropic-cli-faithfulness-routing.md)
- **Date**: 2026-11-15
- **Session**: `audit-code-1794726002780-79060`
- **Scope**: `--scope diff` (R1 over `a4697858`), then R2+ diff-scoped per round.
  **R7 over the WHOLE PR diff** (41 files), because rounds 6's fixes and the four
  addenda had never been read adversarially.
- **Audited head**: `2f148286` (R7). R6's head was `db775bdd`.

## CAPPED at round 7 — still NOT converged

Round 7 is the extra round Louis authorised after reading the round-6 card
(`--past-cap`, soft cap 6, absolute cap 8). It did not converge either, and the
reason is in the numbers rather than in the rigour: widening the scope from the
last commit to the whole PR put 15 files in front of the auditor for the first
time, so the count went UP.

| | |
|---|---|
| Final round | **H:11 M:18 L:2** against a threshold of `H==0 && M<=2` |
| Rounds | 7 of a soft 6 / absolute 8 |
| Findings total | 135 across 7 rounds |
| File coverage | `complete` every round |
| R7 adjudication | 20 accepted · 7 dismissed · 5 deferred · 32/32 ledgered · 5/5 deferrals captured |
| Final gate | **8 disjoint batches over all 41 changed files** — 7 APPROVE, 1 CONCERNS (`approve_with_debt`), **0 blocking**, 0 wrongly dismissed |
| Gate code coverage | **FULL on all 8 batches** — no changed line went unshown |
| Local gate | `guards:preflight` PASS, 36 steps, 2733 tests |

### Why the final review is seven calls, not one

`FULL_CODE_MAX_CHARS` is a hard 100,000-char constant
([code-render.mjs](../../scripts/lib/final-review/code-render.mjs)), and
`windowTargetFor` divides it by the changed-file count. At 41 files that is
~2.4K of window each — which is **why round 6's gate reported PARTIAL, 1917 of
2657 changed lines never shown**. No flag tunes it. One call cannot cover this
diff; several disjoint calls can, and the union of their coverage records is
the answer. The partition asserts DISJOINTNESS and COMPLETENESS in both
directions before any call is made, because the union claim is false otherwise.

### Per-round

| round | verdict | H | M | L | the concern |
|---|---|---|---|---|---|
| R1 | SIGNIFICANT_ISSUES | 19 | 12 | 1 | 4 fail-open holes in the new gate + a dead brief leg + 17 pre-existing solo-control findings |
| R2 | SIGNIFICANT_ISSUES | 4 | 8 | 1 | the fail-closed pass was itself fail-open; 3 of my new tests vacuous |
| R3 | SIGNIFICANT_ISSUES | 4 | 6 | 0 | **pivot threshold** — regex cannot do this job |
| R4 | SIGNIFICANT_ISSUES | 7 | 5 | 1 | AST-level fail-opens, 2 against the module's own docstrings |
| R5 | SIGNIFICANT_ISSUES | 6 | 3 | 0 | control flow, spellings, provenance |
| R6 | SIGNIFICANT_ISSUES | 3 | 5 | 0 | 2 regressions I introduced in R5 + 1 declared limit |
| R7 | SIGNIFICANT_ISSUES | 11 | 18 | 2 | whole-PR scope: 3 more gate fail-opens, the pin's effect on RESUME, and 5 pre-existing solo-control/research findings |

## The honest shape of this audit

**Every round found a real fail-open, and four of the six found one I had
introduced while fixing the previous round.** That is the record, and it is the
reason the cap handed the decision to a human rather than my declaring
convergence.

What changed across the rounds is the argument for stopping:

- **R1–R3** produced shapes with no principled enumeration (shorthand, spreads,
  duplicate keys, nesting depth) — the signature of the wrong tool.
- **R3** hit the pivot rule. The census now parses, via the shared
  `scripts/lib/ast.mjs` that five other gates here already use. My twice-made
  argument that a parser was over-engineering was **false on the facts**, not a
  judgement call that went the other way.
- **R4–R5** produced "this node type also assigns the key" — answerable against
  the grammar.
- **R6** produced two over-broad matches of my own making plus one limit that
  needs dataflow and is now declared rather than patched.

The defect CLASS is converging even though the count is not.

## What the final gate found, and what was done with it

First pass, 7 batches: 5 new findings, 0 blocking. One batch (the census pair)
came back PARTIAL at 926 unshown lines — the same budget arithmetic one level
down — so it was split and re-run. Second pass of the four affected batches:
**FULL coverage everywhere, 0 blocking.**

**Fixed** — four, of which one was a genuine silent failure:

| | |
|---|---|
| `verdict.unparsed` never printed | `auditPinCensus` sets `ok: false` on it, so the gate exited 1 with **nothing on stderr explaining itself**, on exactly the file most likely to be mid-edit. Now reported, and asserted MECHANICALLY from the verdict's own keys — a hand-written list would be maintained by whoever forgot the loop |
| Rule A's empty `params` | fires on a spread or computed key, and the message interpolated the empty list: ``passes ``,``, naming nothing, for the case a reader most needs told apart |
| `summarise.mjs` exits after stdout | `process.exit(1)` after `emit()` discards unflushed bytes on a piped stdout. `stdout:flush:gate` reported "at baseline" over a corpus that walks `scripts/*.mjs` and **never descends into `scripts/symbol-index/`** |
| stale round-6 claims | the plan and this summary still said the audit stopped at R6 and the post-R6 fixes were unaudited — true when written, false after R7 |

**Dismissed — and the dismissals are PROBES, not prose.** A dismissal written as
an argument is a claim about code that nothing re-checks, and this module has
already had four rounds of "the analysis looks right". Each is now a test
([anthropic-pin-census.test.mjs](../../tests/anthropic-pin-census.test.mjs)), so
if one ever becomes true the suite says so:

- a factory returning `backend: 'cli'` is not a pin (`pinned: false`)
- an explicit cli construction beside the factory breaks the claim (`used: false`)
- a `backend` key BEFORE the spread disqualifies it exactly as after — there is
  no ordering hole, because any occurrence disqualifies
- the corpus pre-filter cannot hide a namespace import: every binding form the
  census recognises derives from the literal `createAnthropicClient` appearing
  in the file (raised twice, dismissed twice, now asserted over all four shapes)

**Deferred, LOW**: `normaliseArgText` tracks quote state with one variable, so a
nested template literal (`` `${`x`}` ``) closes the outer quote early and inverts
the state for the rest of the span. Real, and its only effect is a digest
collision — a MISSED drift, never a false alarm — in an options object where
nested templates do not occur. Proper handling needs the parser's token stream,
which is the same answer as the regex-literal limit recorded in §7.13.

## Round 8 — the delta between the audited head and the PR head (2026-11-15)

A merge needs the PR head to EQUAL the audited sha, and it did not: the final
gate in round 7 ran at `0f14b999`, while the PR head had moved to `d9b936a5`.
Two commits sat in between, both written in response to CI rather than to an
audit, and a green `full-suite` is not an audit:

| commit | what |
|---|---|
| `913b2590` | the Azure suite was not hermetic — it inherited `OPENAI_AUDIT_MODEL` from this machine's `.env`, so it passed here and failed on a clean runner |
| `d9b936a5` | `anthropic:pin:gate` carried no poison pill, so nothing had ever asked whether the gate can fail |

**Round 8, scoped to those 5 files (112 lines), 4 passes: `PASS` — H:0 M:0 L:0.**
Final review over the same delta: **APPROVE, 0 blocking, 0 debt, code coverage
FULL.** Round 8 is the ABSOLUTE cap; there is no round 9.

**Audited sha: `d9b936a5`, which is the PR head.**

One honest note on coverage rather than a clean number: 4 of the 5 files were
audited and the fifth, `tests/fixtures/poison/anthropic-unpinned-system-call.mjs.txt`,
was `not-admitted` as non-code — a `.txt` is not source. It is not unexamined,
though, and the distinction matters: that fixture is the poison pill's payload,
and `gates:poison` EXECUTES it, reporting the pill as `verified` only when the
gate actually fails against the poisoned tree. Machine-checked by execution is
stronger evidence than a reviewer reading it, which is why this is recorded as a
classification rather than a gap.

The structural card at this cap reports **9 structural clusters of 115**, with
`anthropic-pin-census.mjs` raised in 7 of the 8 rounds, `work-unit-labels.mjs`
in 5 and `check-anthropic-pins.mjs` in 3. That is the same cluster every round
named, and it is the standing argument that the census's control-flow analysis
is what a future change should restructure rather than keep patching.

## Not verified / stated plainly

- **Round 7 did not converge either** (H:11 M:18 vs `H==0 && M<=2`), and the
  count rose because the scope widened from the last commit to all 41 changed
  files. The round-6 card's 5 structural clusters of 89 were all the census's
  control-flow analysis, and round 7 found three more fail-opens in exactly
  that analysis — the cluster is real, and it is the reason the extra round was
  worth running.
- **The ROUND-7 fixes are now the unaudited ones.** That is the standing
  property of a last round, not a defect of this one: whatever is fixed after
  the final pass has not been read adversarially. They carry red-first controls
  (3 of 134 fail against the pre-fix module; 2 of 136 for the reporting fixes)
  and `guards:preflight` is green.
- **Round 6's gate saw PARTIAL code coverage** — 1917 of 2657 changed lines
  never shown — so its APPROVE was an approval of what it was shown. Round 7's
  gate is seven disjoint batches covering all 41 files: **FULL on 6 of 7**.
  Recorded because a gate verdict quoted without its coverage is the exact
  false-green this repo's discipline warns about.
- The **full** test suite ran only in `guards:preflight`; the whole suite runs
  in the GitHub `full-suite` check on the PR.
- The **consumer-synced bundle is unverified** — nothing is merged, and both
  `anthropic-cli-faithfulness.mjs` and `anthropic-pin-census.mjs` are new lib
  modules in the sync closure.
- No `docs/status/` entry: that is `/ship` time, with the PR number.

## Negative controls — 27 run across six rounds, every one seen to fail

| round | controls (failures / suite) |
|---|---|
| seam | oracle neutered 11/27 · seam swallows the verdict 7/27 · planted unpinned+`system` file turns the gate RED (exit 1), removing it restores green |
| R1 | eager labeller 2/24 · no shorthand 2/40 · no spread guard 1/40 · trusted indirect pin 2/40 · no count check 3/40 |
| R2 | first-match-wins 1/52 · trusted `used` 1/52 · no digest check 2/52 · eager provider 4/27 |
| R3 | flattened nesting 1/74 · shorthand ignored 1/74 · literal whitespace stripped 4/74 · unparsed-reads-clean 1/74 · swallowed provider error 1/28 |
| R4 | skip computed keys 2/96 · pin anywhere in the factory 4/96 · no aliases 2/96 · no dynamic-key fail-closed 1/96 · no computed params 3/96 · comma folded in literals 1/96 · truthiness-keyed error 2/32 |
| R5 | bare return 1/110 · implicit fallthrough 1/110 · no bracketed spelling 1/110 · no provenance 2/110 · no spread rule 1/110 · unguarded `String(err)` 1/32 |
| R6 | last-statement-only 4/128 · any-`create` 2/128 · no namespace 1/128 · no receiver provenance 2/128 |

Two controls had to be **re-run** after they were found not to have mutated the
file at all, and one (R4's throw-vs-absence) **would not go red** — which
exposed two mechanisms covering one question. That one is written up as plan
§7.8a: *if a negative control will not fire, look for the second mechanism
rather than weakening the control.*

## Adjudicated against the auditor

| concern | ruling | outcome |
|---|---|---|
| refuse `max_tokens` at the seam (3 raises) | **compromise** | Class accepted, recommendation rejected: refusing on a param every caller sets is arithmetically "cli is never usable". Closed where it was MEASURED instead — the audit's own `[brief]` step, dead on both transports since before this change |
| use a JS parser (5 raises over 3 rounds) | **conceded at R3** | I was wrong twice. The repo already parses in five gates |
| `--selfcheck-relocation` ordering (2 raises) | **dismissed, false positive** | Verified in the enforcing code: all 26 CLIs do this and AGENTS.md specifies it. A repo-wide contract change, recorded as plan §8.4 |
| 17 solo-control-audit findings | **deferred, independence stated** | 27 lines touched in a 2,480-line file; none of the cited code reads the transport selection or shares a column, constraint or transaction with it |

---

# Audit summary — the ALLOWLIST flip (addendum 4, PR #361)

- **Plan**: [`anthropic-cli-faithfulness-routing.md`](anthropic-cli-faithfulness-routing.md) §9
- **Date**: 2026-11-15
- **Session**: `audit-code-1794749279189-66388`
- **Scope**: R1 `--scope diff --base origin/main` (the whole change, because
  **none of it had been audited** — the branch was pushed and the PR opened
  before any round ran). R2–R6 diff-scoped per round against the working tree.
- **Audited head**: `f6d9ca55dac1cb14cee5f4a19fab1a9c329c397a` plus the uncommitted fixes of rounds
  1–6, committed as the next commit on this branch. Final-review tree hash
  `3ec85cb52bae`; git diff base `3dabb3f3b1ab` (main at #360's squash merge).

## Six rounds, and each one found a real defect in the previous one's fix

| round | verdict | H | M | L | what it found |
|---|---|---|---|---|---|
| 1 | SIGNIFICANT_ISSUES | 6 | 3 | 2 | inherited-property divergence; the staged request escaping the gate |
| 2 | SIGNIFICANT_ISSUES | 3 | 2 | 0 | NON-ENUMERABLE inherited keys; a request assembled by member assignment |
| 3 | SIGNIFICANT_ISSUES | 3 | 5 | 0 | a Proxy prototype cycle (infinite loop); `Object.prototype` pollution whitelisted; inherited ALLOWLISTED params |
| 4 | SIGNIFICANT_ISSUES | 2 | 0 | 0 | the divergence check had become too BROAD — keys neither backend reads |
| 5 | SIGNIFICANT_ISSUES | 2 | 2 | 0 | value read before membership (a getter could throw/side-effect); `toJSON` makes the sdk body undecidable |
| 6 | SIGNIFICANT_ISSUES | 2 | 3 | 0 | a TOCTOU between the oracle's read and the adapter's; `toJSON` callability; `CLI_READ_PARAMS` duplicated unchecked |

Every round's findings were fixed; **nothing was deferred and no debt was
captured.** 35 findings, 35 ruled: 31 accepted, 3 severity-adjusted, 1
dismissed. Acceptance 100% / 100% / 100% / 100% / 75% / 100%.

## The one pivot that mattered

Rounds 1–3 each patched the key ENUMERATION and round 3 found the next layer
anyway. The fix was to stop patching and ask the invariant instead: **what sdk
will SEND (own enumerable) versus what cli can READ (the destructure, which
walks the prototype chain and ignores enumerability)** — any key in the
difference is a divergence, whatever its name. Round 4 then corrected the
direction, scoping divergence to the params the adapter actually destructures,
because an inherited key it never names is read by neither backend.

## Final gate — APPROVE, over PARTIAL code coverage

`FINAL_REVIEW_MODEL` (Gemini Pro), round 1 then round 2 (the hard cap):

- **Round 1**: `APPROVE`, gate `approve`, 0 blocking, 0 debt, 0 wrongly
  dismissed. Coverage **PARTIAL** — 4/11 changed files whole, 437 of 1627
  changed lines never shown.
- **Round 2** (transcript narrowed to the six code files, so the verdict covers
  the code rather than the prose): `APPROVE`, gate `approve`, 0 blocking, 0
  debt, 0 wrongly dismissed. Coverage **PARTIAL** — 2/6 whole, 4 windowed, 0
  absent, 197 of 1556 changed lines never shown, diff hunks post-image verified.

**Stated plainly: this is an APPROVE of the examined files, not of every line.**
A coverage gap is not release-blocking, and it is not a clean full-coverage
approve either.

## Round-6 structural card — the human call, and why it was STOP

The card classified 4 clusters structural and 25 polish, with
`anthropic-cli-faithfulness.mjs` raised in 6 rounds. Its one genuinely
structural item was the TOCTOU, and it was **fixed rather than deferred**: the
wider fix (hand the adapter a validated snapshot — a change to its signature)
was rejected as too large for an audit round, and the minimal one closes the
window completely by never reading an accessor. Size is not scope, so a defer
there would have been dishonest.

The one concern raised in four rounds and **not** fixed is the census's
shape-versus-dataflow trade-off: neither the request-shape rule nor the
member-assignment rule ties its subject to a particular `.create` call. That is
the dataflow this gate declares out of scope, it is now a stated LIMIT in the
module docstring with the three bounds that make it acceptable, and measured it
flags 0 additional files in this repo. Its failure direction is a demand for a
pin or a declaration, never a silent pass.

## Pass census (round 6)

| identifier | state | reason |
|---|---|---|
| `structure` | completed | — |
| `backend` | completed | — |
| `sustainability` | completed | — |
| `frontend` | ineligible | no frontend files in the diff |
| `wiring` | ineligible | not selected for the R2+ pass set |
| `quickfix` | completed | 0 findings |
| `duplication` | completed | js/ts only; all changed files are `.mjs` |
| `adjacency` | completed | — |
| `arch-memory` | ineligible | `--scope diff` |
| `file coverage` | completed | `_coverage.status: complete`, gate pass |
| detector census | completed | 0 detectors recorded; `blocked: false` |
