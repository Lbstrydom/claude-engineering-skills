# Audit summary — anthropic-cli-faithfulness-routing (THROW AND PIN rework)

- **Plan**: [`anthropic-cli-faithfulness-routing.md`](anthropic-cli-faithfulness-routing.md)
- **Date**: 2026-11-15
- **Session**: `audit-code-1794726002780-79060`
- **Scope**: `--scope diff` (R1 over `a4697858`), then R2+ diff-scoped per round
- **Audited head**: `db775bdd` (final-review marker: run `9c1a3b3e`, tree `5149eb18`)

## CAPPED at round 6 — NOT converged

| | |
|---|---|
| Final round | **H:3 M:5 L:0** against a threshold of `H==0 && M<=2` |
| Rounds | 6 of 6 (the cap). Continuing is the operator's call |
| Findings total | 103 across 6 rounds |
| File coverage | `complete` every round |
| Final gate | **Gemini `gemini-4-argon`: APPROVE**, `gateDisposition: approve`, 0 blocking, **1 LOW debt finding (fixed)** |
| Gate code coverage | **PARTIAL — 1917 of 2657 changed lines never shown** |
| Local gate | `guards:preflight` PASS, 36 steps, 2723 tests |

### Per-round

| round | verdict | H | M | L | the concern |
|---|---|---|---|---|---|
| R1 | SIGNIFICANT_ISSUES | 19 | 12 | 1 | 4 fail-open holes in the new gate + a dead brief leg + 17 pre-existing solo-control findings |
| R2 | SIGNIFICANT_ISSUES | 4 | 8 | 1 | the fail-closed pass was itself fail-open; 3 of my new tests vacuous |
| R3 | SIGNIFICANT_ISSUES | 4 | 6 | 0 | **pivot threshold** — regex cannot do this job |
| R4 | SIGNIFICANT_ISSUES | 7 | 5 | 1 | AST-level fail-opens, 2 against the module's own docstrings |
| R5 | SIGNIFICANT_ISSUES | 6 | 3 | 0 | control flow, spellings, provenance |
| R6 | SIGNIFICANT_ISSUES | 3 | 5 | 0 | 2 regressions I introduced in R5 + 1 declared limit |

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

## Not verified / stated plainly

- **Round 6 did not converge.** The structural-or-stop card reports **5
  structural clusters of 89**, all the census's control-flow analysis;
  `anthropic-pin-census.mjs` was raised in 6 rounds, `work-unit-labels.mjs` in 4.
- **The round-6 fixes are UNAUDITED** — written after the final round, at the
  cap. Four negative controls fire and the suite is green; no adversarial pass
  has read them.
- **The Gemini gate saw PARTIAL code coverage**: 6/26 changed files rendered
  whole, 1917 of 2657 changed lines never shown. Its APPROVE is therefore an
  approval of what it was shown, not of the whole diff. Said here because a gate
  verdict quoted without its coverage is the exact false-green this repo's own
  discipline warns about.
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
