# Plan: Learning / Persona / Quickfix Reliability Debt (2026-07-26 triage)

- **Date**: 2026-07-26 (re-scoped 2026-08-01)
- **Status**: Draft — **re-scoped to the 7 entries that are still real.**
  14 of the original 21 shipped between 2026-07-26 and 2026-08-01, all under
  *other* plans. See §0.
- **Author**: Claude (tech-debt backlog triage session)
- **Scope**: backend

> Origin: full `.audit/tech-debt.json` backlog triage (384 entries). This
> cluster (21 entries) spans `quickfix-stats.mjs`, `decision-logger.mjs`,
> `persona-consistency-promote.mjs`, `persona-outcomes.mjs`,
> `audit-correlator.mjs`, and `brainstorm/session-store.mjs` — different
> files, but a recurring shared bug shape: **cloud/DB read or write failure
> is indistinguishable from "genuinely empty" or "success."** Verified
> against current source 2026-07-26.

---

## 0. Staleness triage (2026-08-01) — read this before Themes 1–6

Every entry below was re-traced against current source. The theme text that
follows §0 is the **2026-07-26 snapshot** and is deliberately left intact as
the historical record — where §0 and a theme disagree, **§0 is current.**

### Already shipped — 14 of 21, none of them via this plan

| Entries | Theme | Landed in | What's in the code now |
|---|---|---|---|
| `328dbf9d`, `4294a043`, `5c716982`, `6b6263b8`, `97bd6987`, `d3f514c0` | 1 | [`refactor-failure-contract.md`](./refactor-failure-contract.md) (Cluster B) | The `!parsed.ok && !parsed.cloud` guard is gone. Three pure interpreters — `interpretCandidateListResult`, `interpretShipEventResult`, `interpretPromoteRegressionSpecResult` — plus `isWellFormedCliResponse` and a new `EXIT.DEPENDENCY_FAILURE` (3). A failed candidate-list check now exits 3 with *"treating this as unknown, not zero"*, and cloud-off is a separate, typed `{ok:true, cloud:false}`. |
| `3a02107d`, `a502a7e1`, `ac1dd0c3` | 2 | same | `readQuickfixDecisions` returns `{ok:true,decisions}` / `{ok:false,error}`; `rebuildFromCloud` returns early on `!readResult.ok` so `writeAtomic` is unreachable on a read failure and a good cache can no longer be clobbered by a transient error. A bonus guard was added beyond what the entries asked: a non-empty decision set that aggregates to zero patterns is treated as a data-shape regression, not an empty result. |
| `7ec90282`, `8db9393b` | 2 | same (round-1 finding H3) | Both env vars now parse through [`scripts/lib/quickfix-policy.mjs`](../../scripts/lib/quickfix-policy.mjs) — `parseValidatedThreshold` (finite, `[0,1]`) and `parseValidatedMinHits` (finite integer `>= 1`), each emitting one stderr line on rejection. `'0.2junk'` no longer silently reads as `0.2`. Consolidated into one module because the *same* two vars were parsed independently by the hot-path matcher too. |
| `88bc75e1`, `8993b96f` | 4 | commit `a86a5ca7` | `repoId` is the PRIMARY session-selection key in both `getPersonaOutcomesSummary` and `getActionablePersonaOutcomeItems`; `repo_name` survives only as a fallback for when identity resolution genuinely fails. **Verified non-inert**: both production callers (`cross-skill.mjs:1760`, `:1800`) supply `repoId` from `resolveScopedRepoId()`. |
| `c6b3df92` | 5 | [`persona-finding-hash-versioning.md`](./persona-finding-hash-versioning.md) | `PERSONA_FINDING_HASH_VERSION = 2`; the hash payload is now a fixed-order 5-key `{element, code, route, expected, observed}` over a full 64-hex SHA-256, with `route` resolved per-step from the click-path lookup. Two findings on the same element in different journey steps no longer collide. |

`88bc75e1`/`8993b96f` were **stale-open in the ledger** (fix landed
2026-07-27, entries never reconciled) — resolved 2026-08-01 against
`a86a5ca7`. The other nine were already reconciled.

### Still open — 7 entries, this plan's actual remaining scope

| topicId | Sev | File | One-line statement |
|---|---|---|---|
| `222b036e` | HIGH | `learning/decision-logger.mjs` | Cap-breach eviction drops a decision with only a counter bump — never spilled to the outbox. |
| `191fca35` / `f1a716cf` | MED ×2 | `learning/quickfix-stats.mjs` | `rebuildFromBootstrap` is a stub that labels every hit `no_action`, yet returns `{ok:true}`. |
| `e0623c0a` | MED | `brainstorm/session-store.mjs` | A non-numeric `schemaVersion` silently downcasts a future record to V1. **Reproduced** — see below. |
| `e51bacd2` / `fa86b341` | MED ×2 | `brainstorm/session-store.mjs` | `appendQuarantine`'s read→combine→trim is unlocked; `loadSession` takes no lock at all. |
| `bbd58a09` | MED | `persona-consistency-promote.mjs` | `limit: 100` with no pagination loop — candidate 101+ is never promoted, silently. |

**`e0623c0a` is not a hypothesis — it was executed.** A real, schema-valid
session record from `.brainstorm/sessions/` was replayed through
`loadSession` with only `schemaVersion` varied:

```
schemaVersion="3"    -> rounds=1 synth=1 invalid=0 storedVersion=2   silently downcast
schemaVersion=null   -> rounds=1 synth=1 invalid=0 storedVersion=2   silently downcast
schemaVersion=false  -> rounds=1 synth=1 invalid=0 storedVersion=2   silently downcast
schemaVersion=3      -> rounds=0 invalid=1  reason=unsupported-future-schema-version-3
```

One detail the original triage did not catch, and which makes this worse
than "falls through to legacy V1 synthesis": the downcast record is also
stamped `_synthesised: {fields: [...'schemaVersion'...]}` — so a *future*
record is affirmatively mislabelled as a *legacy* one. The guard at
`session-store.mjs:188` is `typeof parsed.schemaVersion === 'number' &&
parsed.schemaVersion > 2`; the numeric branch is correct, everything
non-numeric routes to the V1 promotion path where `schemaVersion: 2` is
overwritten onto the record before validation, so the schema can never
object.

---

## Theme 1 — `persona-consistency-promote.mjs` (7 entries, 6 HIGH)

Every one of these is the same guard, `if (!parsed.ok && !parsed.cloud)
return { ok: true };` (line 119) or its sibling
`listConsistencyCandidatesViaCli` returning `[]` on failure (lines 102-105)
— both conflate "cloud is deliberately off" with "the call actually failed."
Downstream, `promoteCandidates` (line ~227) can't tell "no pending
candidates" from "we couldn't check." `bbd58a09` is a related but distinct
issue: `limit: 100` is hardcoded with no pagination loop, so candidates
beyond the first 100 are silently never promoted. **Fix**: change the CLI
bridge's return contract so cloud-off and failure are distinguishable
(`{ok:true, cloud:false}` vs `{ok:false, error}`), and add pagination to
`listConsistencyCandidatesViaCli`.

## Theme 2 — `quickfix-stats.mjs` (7 entries)

Same false-success shape: `readQuickfixDecisions` catches and returns `[]`
(`3a02107d`/`a502a7e1`/`ac1dd0c3`, one bug, 3 topicIds), then
`rebuildFromCloud` writes that empty result to cache and reports
`{ok:true}` anyway. Separately, `rebuildFromBootstrap` (`191fca35`/
`f1a716cf`) never actually calls git or evaluates file changes — it
unconditionally classifies every hit as `outcome: 'no_action'`, i.e. the
bootstrap heuristic is a stub, not an implementation. And
`7ec90282`/`8db9393b` — the two env-var thresholds
(`LEARNING_QUICKFIX_SKIP_THRESHOLD`, `...MIN_HITS`) are parsed with bare
`parseFloat`/`parseInt`, no finiteness/range validation, so `'0.2junk'` or a
negative value silently passes through. **Fix**: same failure-vs-empty
distinction as Theme 1; implement or explicitly stub-and-log the bootstrap
heuristic; validate the two env vars the same way `memory-health.mjs`'s
`numEnv()` does elsewhere (once that gets its own missing bound fixed, see
the arch-memory plan).

## Theme 3 — `decision-logger.mjs`

`222b036e` — `recordDecision()` does `queue.shift()` on cap breach, only
incrementing a `_droppedCounts` counter; the evicted decision is never
written to the outbox/durable store, so it's gone. **Fix**: either raise
the cap, spill to the outbox on eviction (matching the pattern
`docs/runbooks/learning-system.md` documents for the *other* outbox path),
or make the drop an explicit, alertable event rather than a silent counter.

## Theme 4 — `persona-outcomes.mjs` session lookup

`88bc75e1`/`8993b96f` — `getPersonaOutcomesSummary` and
`getActionablePersonaOutcomeItems` both key the initial session lookup on
`repo_name` (`ORDER BY created_at DESC LIMIT 1`), and
`repo_name` has **no unique constraint** — the migration that added
`repo_id` (`20260615120000_persona_session_repo_id.sql`) explicitly notes
name-collisions are possible. A renamed/duplicated repo name can silently
select the wrong repo's session. **Fix**: key the lookup on `repo_id`
(already present per that migration) instead of `repo_name`.

## Theme 5 — `audit-correlator.mjs` hash identity

`c6b3df92` — `personaFindingHash` hashes only `element`/`code`/`observed`,
omitting `finding.step` and the click-path URL — two persona findings on
the same element in *different steps of the journey* collapse to the same
dedup identity. **Fix**: fold `step`/URL into the hash.

## Theme 6 — `brainstorm/session-store.mjs`

`e0623c0a` — the `schemaVersion > 2` check only branches on
`typeof === 'number'`, so `"3"` (string), `null`, `false` all fall through
to legacy V1 synthesis instead of an explicit unsupported-version error.
`e51bacd2`/`fa86b341` — the final write got made atomic
(`atomicWriteFileSync`, commit ea2035c) but the read-existing→combine→trim
sequence before it is still unlocked, and `loadSession` doesn't take the
session lock at all (unlike `appendSession`) — so concurrent writers can
still lose updates via a lost-update race, just no longer via a torn write.

---

## Full entry table


**`scripts/lib/learning/quickfix-stats.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `191fca35` | MEDIUM | quickfix-stats.mjs:139-183 rebuildFromBootstrap unconditional no_action |
| `3a02107d` | HIGH | quickfix-stats.mjs:106,254-256,97-122 error swallow ok:true |
| `7ec90282` | MEDIUM | quickfix-stats.mjs:36-37 unguarded parseFloat/parseInt |
| `8db9393b` | MEDIUM | quickfix-stats.mjs:36-37 duplicate of 7ec90282 |
| `a502a7e1` | HIGH | quickfix-stats.mjs:97-122,254-256 duplicate of 3a02107d |
| `ac1dd0c3` | MEDIUM | quickfix-stats.mjs:106-121,254-256 duplicate |
| `f1a716cf` | MEDIUM | quickfix-stats.mjs:139-183 duplicate of 191fca35 |

**`scripts/lib/learning/decision-logger.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `222b036e` | HIGH | decision-logger.mjs:241-249 recordDecision queue.shift on cap breach, evicted entry never written to outbox |

**`scripts/persona-consistency-promote.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `328dbf9d` | HIGH | persona-consistency-promote.mjs:119-121 cloud-off swallow |
| `4294a043` | HIGH | persona-consistency-promote.mjs:102-105 candidate-list failure returns [] |
| `5c716982` | HIGH | persona-consistency-promote.mjs:117-124 recordShipEventViaCli returns ok:true on cloud-off failure |
| `6b6263b8` | HIGH | persona-consistency-promote.mjs:104,227-230 empty on failure indistinguishable |
| `97bd6987` | HIGH | persona-consistency-promote.mjs:119 guard unchanged |
| `bbd58a09` | MEDIUM | persona-consistency-promote.mjs:100 hardcoded limit:100 no pagination |
| `d3f514c0` | HIGH | persona-consistency-promote.mjs:119 same guard swallows failures |

**`scripts/lib/store/persona-outcomes.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `88bc75e1` | HIGH | persona-outcomes.mjs:167-174 session lookup keyed on non-unique repo_name, collision risk documented in migration |
| `8993b96f` | HIGH | persona-outcomes.mjs:167-174,252-259 same non-unique repo_name lookup duplicate |

**`scripts/lib/persona/audit-correlator.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `c6b3df92` | HIGH | persona/audit-correlator.mjs:62-67 hash omits step/click-path/expected behavior |

**`scripts/lib/brainstorm/session-store.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `e0623c0a` | MEDIUM | session-store.mjs:188 schemaVersion check lets non-numbers fall through to V1 |
| `e51bacd2` | MEDIUM | session-store.mjs:229-263 read-combine-trim sequence still unlocked despite atomic final write |
| `fa86b341` | MEDIUM | session-store.mjs:223 loadSession no session lock unlike appendSession |

## Rollback

All additive/defensive; the `repo_id`-based session lookup fix should be
tested against a repo with a known name-collision in the persona sessions
table before shipping (or a synthetic one in a disposable test DB per
`assertDisposableDbUrl`).
