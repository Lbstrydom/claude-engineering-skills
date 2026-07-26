# Plan: Audit-Pipeline Reliability Debt (2026-07-26 triage)

- **Date**: 2026-07-26
- **Status**: Draft
- **Author**: Claude (tech-debt backlog triage session)
- **Scope**: backend

> Origin: full `.audit/tech-debt.json` backlog triage (384 entries). This is
> the largest single cluster of genuinely-still-valid debt found (45
> entries) — it's the audit pipeline's own robustness gaps: silent
> error-swallowing around cloud/learning writes, two god-modules
> (`legacy-production-audit.mjs` ~2280 lines, `openai-audit.mjs`), duplicated
> schema/prompt systems, and a `findings.mjs`/`ledger.mjs` topic-identity
> scheme that still hashes prose content despite its own docs claiming
> otherwise. Every row below was independently re-verified against current
> source on 2026-07-26 (not just re-read from the original finding).

---

## Theme 1 — Silent-swallow around cloud/learning writes

`062e1be1`, `4235a115`, `656f6586`, `9d9d478a` — `finalizePriorRoundOutcomes`,
`backfillLearningOutcome`, `recordDiffComplexity`, and the debt-memory/ledger
writes all either run unconditionally (no `noCloudRecording` gate) or
`.catch(() => {})` real failures. **Fix**: route all of these through one
shared "best-effort cloud write" helper that (a) checks the shadow/no-cloud
flag once, (b) logs (not swallows) real failures, matching the pattern
`fsyncFile`/`atomicWriteFileSync` already use elsewhere in this repo.

## Theme 2 — Two god-modules

`883ce465`/`e1c28c86` (`legacy-production-audit.mjs`, `runLegacyProductionAudit`
~2280 lines) and `1444bd3bcd09`/`4583a315f94f`/`a3eea13798de`
(`openai-audit.mjs` — hand-wired per-pass code blocks, local schema
duplicates of `schemas.mjs`, hardcoded prompts duplicating
`prompt-registry.mjs`). **Fix**: this is a real, large decomposition —
scope it as its own follow-up plan rather than folding into this one; the
previous Phase-11 extraction (moving `runMultiPassCodeAudit` out) is the
precedent to repeat for the remaining orchestration.

## Theme 3 — Correctness bugs (not just size/duplication)

- `39a73f09` — 2 literal NUL bytes in `legacy-production-audit.mjs:1083`
  (confirmed via raw bytes, not an escape sequence). **Fix**: replace with a
  textual sentinel; trivial, do this one first.
- `bf45c2f7` — verdict computation (line 2946) and the commit-provenance
  convergence check (line 3319) recompute severity counts independently and
  can disagree. **Fix**: have the provenance gate call the same
  `effSeverity`/`countFor` helper verdict computation already uses.
- `cd77d84e`/`d96b1e86` — MAP-phase `cached_tokens` never accumulated into
  `mapUsage`; only REDUCE's figure is reported. **Fix**: sum in the MAP
  aggregation loop (line 532-535) same as other token fields.
- `6ae952bf` — `passRegistry` and `recordPassStats` maintain two independent
  sources of truth for reasoning-level. **Fix**: derive `recordPassStats`'s
  lookup from `passRegistry` directly.
- `9e965821` — cache dir `mkdirSync` has no explicit mode (e.g. `0o700`).
  Trivial one-line fix.
- `7d5479de` — `_cacheDir`/`_runSeedUsed` module-level mutable globals; only
  a real problem if this ever runs concurrently in one process (currently
  CLI-per-invocation, so low urgency — see AGENTS.md's accepted-debt table
  for the same pattern elsewhere).

## Theme 4 — `evidence-triage.mjs` anchor resolution

`19b2d764`, `866769e6` — quote/anchor matching never checks the anchor's own
`startLine`/`endLine`, so a duplicated quote elsewhere in the same hunk can
misattribute location. `78e4d7aa`, `9cac9947`, `b587ef32` — the diff-header
regex still doesn't handle git's C-style path escaping (accepted debt per
the file's own comment, just not yet fixed). **Fix**: same shape as the
`findAllLineRangesInContent`/`resolveAnchorLocation` "ambiguous → unsupported
verdict" fix that already landed for the sibling defect (`dfde9106`,
resolved this session) — extend that pattern to check `startLine`/`endLine`
too.

## Theme 5 — `discovery-portfolio.mjs` fail-open outcome tracking

`122899a5`, `33593f74`/`7ceef72a` — malformed findings pass through
(`Array.isArray` only), and a null `gptCall` adapter silently drops the
outcome entirely instead of recording a skip. **Fix**: validate each
finding shape, and push an explicit `{status:'skipped', reason:'no-adapter'}`
outcome instead of nothing.

## Theme 6 — `diff-scope-resolver.mjs` orphan-preimage cleanup

`ce44f372`, `e5f71156` — stale-worktree sweep is keyed purely on
basename-prefix + mtime age, with an unconditional `fs.rmSync` fallback and
no ownership verification. `82e60a82` — `readdirSync` failures are logged
but never surfaced in the returned scope state. **Fix**: this is a
deletion-safety gap (matching the `audit-clean.mjs` symlink-escape class
already fixed this session) — add the same ownership/ancestry check before
any `rmSync` fallback.

## Theme 7 — Topic-identity / findings-identity honesty gap

`30ca14747055`/`3ce44825046d` (`findings.mjs` `semanticId` still a raw
content hash of prose for model findings — documented as "deferred to v2"),
`6c518b81fda5` (`_repoProfileCache` module-global survived the god-module
split into siblings), `d486a8691080` (`ledger.mjs generateTopicId`'s own
JSDoc claims "no content hash," but line 50 folds one in anyway — a
documentation/code mismatch, fix the docstring or the code, pick one).

## Theme 8 — Ledger governance

`744ebe8db568` — corruption recovery is fail-open (warns + backs up +
continues with a fresh empty ledger) despite a comment claiming
"fail loudly." `9ed20331d025` — three independent read-modify-write ledger
implementations diverge in corruption handling. `ae4d3a65ad4a` — file paths
still extracted from free-text `section` via regex instead of a structured
field. `75981b9b`/`92fe5776`/`dd651e36` — the ledger schema itself has no
`contentAliases` cross-linking (0/211 populated), no lifecycle fields
(`supersededBy`/`expiry`/etc.), and 31/211 entries have `classification:
null`. **Fix**: these four are the actual root cause of *why* this backlog
had so many near-duplicate entries in the first place — worth prioritizing
if another triage pass like this one is expected to recur.

---

## Full entry table


**`scripts/lib/audit/legacy-production-audit.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `062e1be1` | HIGH | legacy-production-audit.mjs:1305 finalizePriorRoundOutcomes unconditional, no noCloudRecording check internally |
| `4235a115` | HIGH | legacy-production-audit.mjs:3387-3396 backfillLearningOutcome catch swallow, docblock admits deferred gap |
| `656f6586` | HIGH | legacy-production-audit.mjs:1405 recordDiffComplexity catch swallow, same acknowledged gap |
| `6ae952bf` | MEDIUM | legacy-production-audit.mjs:2446-2475,3116-3119 passRegistry vs recordPassStats two sources of truth |
| `7d5479de` | MEDIUM | legacy-production-audit.mjs:247,388 _cacheDir/_runSeedUsed mutable module globals |
| `883ce465` | HIGH | legacy-production-audit.mjs:1268-3545 ~2280-line function still orchestrates everything |
| `9d9d478a` | HIGH | legacy-production-audit.mjs:1488,1523,2876 debt-memory/ledger writes have no noCloudRecording/learningWritesAllowed check |
| `9e965821` | MEDIUM | legacy-production-audit.mjs:255 mkdirSync no explicit mode set |
| `bf45c2f7` | HIGH | legacy-production-audit.mjs:2946-2958,3319-3323 verdict vs commit-provenance gate recompute diverge |
| `cd77d84e` | MEDIUM | legacy-production-audit.mjs:526,532-535,663 mapUsage never accumulates cached_tokens from MAP results |
| `d96b1e86` | MEDIUM | legacy-production-audit.mjs same cached_tokens gap duplicate of cd77d84e |
| `e1c28c86` | MEDIUM | legacy-production-audit.mjs:1268-3545 same ~2280-line function duplicate of 883ce465 |
| `39a73f09` | HIGH | legacy-production-audit.mjs:1083 2 literal NUL bytes in string literals confirmed via raw bytes |

**`scripts/lib/audit/tiered-pipeline.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `14e2f6c9` | MEDIUM | tiered-provider-calls.mjs:36-51,65-92 duplicated Stage-1 prompt/schema across transports post-extraction |
| `864d73db` | MEDIUM | tiered-pipeline.mjs 607 lines still over 500-line threshold, still orchestrates everything |
| `9d28fa46` | MEDIUM | tiered-provider-calls.mjs same duplication duplicate of 14e2f6c9 |
| `ef5cb0ac` | MEDIUM | tiered-provider-calls.mjs same duplication duplicate of 14e2f6c9 |

**`scripts/lib/audit/evidence-triage.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `19b2d764` | HIGH | evidence-triage.mjs:188-211,252-273 no anchor startLine/endLine check, first-match bug admitted |
| `78e4d7aa` | MEDIUM | evidence-triage.mjs:113-128 header regex no C-style unescape, accepted debt comment |
| `866769e6` | HIGH | evidence-triage.mjs:416-476,188-211 zero anchor.startLine/endLine refs, dup quote misattribution |
| `9cac9947` | MEDIUM | evidence-triage.mjs:117 header regex only unquoted/space-quoted |
| `b587ef32` | MEDIUM | evidence-triage.mjs:101-107 same gap, own doc admits only spaces covered |

**`scripts/lib/audit/discovery-portfolio.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `122899a5` | MEDIUM | discovery-portfolio.mjs:79-81 only Array.isArray checked, malformed entries pass |
| `33593f74` | MEDIUM | discovery-portfolio.mjs:147-154 gptCall null skips outcome push, reachable in prod |
| `7ceef72a` | MEDIUM | discovery-portfolio.mjs:147-154 duplicate of 33593f74 |

**`scripts/lib/audit/diff-scope-resolver.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `82e60a82` | MEDIUM | diff-scope-resolver.mjs:49-63 readdirSync failures logged not surfaced |
| `ce44f372` | HIGH | diff-scope-resolver.mjs:272-291 basename+mtime heuristic ownership |
| `e5f71156` | HIGH | diff-scope-resolver.mjs:285-289 fallback rmSync no ownership check |

**`scripts/lib/findings.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `30ca14747055` | HIGH | findings.mjs:38-39 semanticId still raw content hash of prose for non-tool findings |
| `3ce44825046d` | HIGH | findings.mjs:27-40 dispatch confirmed, plan doc explicitly still documents deferred to v2 |
| `6c518b81fda5` | HIGH | findings-outcomes.mjs:20,28,45,68 _repoProfileCache module-global mutable state persists post-split |
| `d486a8691080` | HIGH | ledger.mjs:43-53 generateTopicId JSDoc claims no content hash but line 50 folds contentHash into hashed content |

**`scripts/openai-audit.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `1444bd3bcd09` | HIGH | config.mjs:265 PASS_NAMES flat array, legacy-production-audit.mjs:1717-1774 hand-wired per pass |
| `4583a315f94f` | HIGH | openai-audit.mjs:197,221,235 local schemas vs schemas.mjs owning ~30 others |
| `a3eea13798de` | HIGH | openai-audit.mjs:251,283 hardcoded prompts vs prompt-registry.mjs separate system |

**`scripts/lib/ledger.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `744ebe8db568` | HIGH | ledger.mjs:78-95 corruption only warns+backs up+continues fresh empty ledger, fail-open despite fail-loud comment |
| `9ed20331d025` | MEDIUM | ledger.mjs multiple independent RMW implementations diverge in corruption handling |
| `ae4d3a65ad4a` | HIGH | ledger.mjs:260-278 populateFindingMetadata extracts paths via regex on free-text section field |

**`scripts/lib/audit/final-adjudication.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `ab71f952` | MEDIUM | final-adjudication.mjs:154-159 Number.isFinite accepts negative maxMechanicalTailItems |

**`scripts/lib/audit/stage0-relevance-context.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `5308a5d6` | MEDIUM | stage0-relevance-context.mjs:84-96 sequential await loop no Promise.all/batching |

**`scripts/lib/audit/discovery-diff-scope.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `6cfb5541` | HIGH | discovery-diff-scope.mjs:27-44,57 lexical-only shouldSkipForIndexing, symlink-aware check not implementable over diff per own comment |

**`scripts/lib/audit/stage1-triage.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `71a8f46a` | LOW | stage1-triage.mjs:7-15 stale header re: wiring, contradicted by openai-audit.mjs/tiered-pipeline.mjs/cheap-triager-validate.mjs |

**`.audit/tech-debt.json`**

| topicId | severity | evidence |
|---|---|---|
| `75981b9b` | HIGH | tech-debt.json 0/211 entries have contentAliases, duplicate defects uncorrelated |
| `92fe5776` | MEDIUM | tech-debt.json no supersededBy/reviewDeadline/expiry/etc fields exist |
| `dd651e36` | HIGH | tech-debt.json 31/211 entries classification:null |

## Rollback

All fixes are additive/refactor-only within the audit tooling itself; no
schema/data migrations. Revert per-commit if a regression surfaces in
`npm test`.
