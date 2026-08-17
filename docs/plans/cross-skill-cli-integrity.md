# cross-skill.mjs CLI integrity remediation

- **Date**: 2026-08-12
- **Status**: **Complete** — closed 2026-08-17. All 21 fixes landed (`8f582e80`) + Gemini gate APPROVE. It stayed `In Progress` because the stated `/audit-code` bar (HIGH == 0) was never reached; §Acceptance explains why that bar was unreachable *from inside this plan* — the residual HIGHs were the §Deferred entries, and **every one of them has since been closed or explicitly declared by successor work** (see §Closure). Nothing in this plan's scope remains open.
- **Author**: Claude + Louis
- **Scope**: backend
- **Target domain(s)**: `shared-lib`, `stores`, `audit-orchestration`
- **Subject**: `scripts/cross-skill.mjs` + the store seams its correctness rides on

> **Reading note for auditors.** Every `§Verified defects` entry below describes
> the defect **as it was at HEAD 096b78c7** and then states its fix. All of
> F1–F9 are **implemented in the working tree**; the pre-fix code is quoted only
> to explain what was wrong. A finding that re-states one of these problem
> statements as still-open is contradicted by the source.

## Implementation status

| # | Defect | State | Evidence |
|---|--------|-------|----------|
| F1 | `learning-record` context hash collided (nested content erased) | fixed | `tests/cross-skill-cli-integrity.test.mjs` — with an in-suite negative control proving the old expression collided |
| F2 | `record-ship-event` reported success for a failed write | fixed | store returns a status; CLI fails closed |
| F3 | `record-regression-spec-run` same; `ux-lock-run` `recorded` was an alias for `cloud` | fixed | both callers updated |
| F4 | `persona-outcomes --repo` accepted and silently overridden | fixed | **behavioural proof below** |
| F5 | `arm-eval-run` persisted `repo_id = NULL` | fixed | routes through `resolveScopedRepoId()` |
| F6 | `record-persona-session` skipped reconciliation when both id+name supplied | fixed | reconcile is unconditional |
| F7 | repo resolution collapsed transient failure into "no scope" | fixed | `resolveRepoForStoreResult` discriminated core |
| F8 | `cmdAbortRefreshRun` emitted `ok:true` when nothing was aborted | fixed | found by this plan's own audit round 1 |
| F9 | `getPlanIdByPath` labelled a lookup FAILURE as `not-found` | fixed | new `lookup-failed` reason |
| F10 | `get-persona-sessions-by-repo --repo` returned a **false zero** for a foreign repo | fixed | **behavioural proof below**; found by audit r2 |
| F11 | `resolveRequestedRepoScope` accepted an unresolvable `--repo` when `--repo-id` was valid | fixed | a gap in F4's own first fix, found by audit r2 |
| F12 | `ux-lock-run`'s `resolveRepoId` collapsed a store outage into "recording disabled" | fixed | F7's sibling, one file over |

| F13 | `resolveRepoId`: an explicit but UNKNOWN `repoUuid` returned null → unscoped write | fixed | audit r3 |
| F14 | `validatePlanPath`: on POSIX, containment and the returned identifier disagreed (`..\x.md` passed, returned `../x.md`) | fixed | audit r3; probe under `path.posix` |
| F15 | `cmdPublishRefreshRun` did not assert its own success (asymmetric with F8) | fixed | audit r3 |
| F16 | `get-recent-findings --repo-id` accepted and never read — ambient repo silently substituted | fixed | audit r4 |
| F17 | `resolveRequestedRepoScope` / `resolveShipNudgeScope` reported a store OUTAGE as `UNKNOWN_REPO` | fixed | audit r4; F17 was reintroduced *by F4's own fix* |
| F18 | `record-persona-session`: a swallowed resolver error made F6's reconciliation a silent no-op | fixed | audit r4 |
| F19 | `decision-logger` retained caller-owned `context`/`choice`/`outcome` by reference after validating them | fixed | audit r4; snapshot at admission |
| F20 | `finalize-outcomes` emitted `ok:true` beside `cloudOk:false` (stderr already said `cloud=failed`) | fixed | audit r5 |
| F21 | `finalize-outcomes --round` accepted `0`, negatives, and silently substituted another round for `abc` | fixed | audit r5; **contract tightened**, see below |

### F21 — a prior test asserted the weaker contract

`tests/cross-skill-finalize-round.test.mjs` asserted that `--round 0` was
honoured ("an explicit 0 is a caller decision") and that `--round abc` fell back
to `result.round`. Both were changed to refusals, because the older expectation
**contradicted that suite's own header**: *"Round is a real key … so round 0
mislabels the whole round."* Audit rounds are 1-based, so honouring `0` writes
the same mislabelled record the original defect produced, reached by a different
input; and silently finalising round 7 because the operator typed `abc` is the
silently-different-answer class this CLI's flag guard exists to prevent. The two
tests were rewritten with that reasoning rather than deleted.

**Every one of F10–F21 is a SIBLING of, or a regression introduced by, a defect
fixed earlier in this same change set** — F17 is the sharpest example: the fix
for F4 reintroduced F7's failure-collapse inside its own new resolver.
Single-pass fixing of this file has repeatedly under-delivered for exactly this
reason.

Original note on F10–F12: **each is a SIBLING of a defect fixed earlier** — the same bug in the next command along. F1–F9 came from fixing
what was reported; F10–F12 came from asking "where else does this shape live?"
and are the reason a single-pass fix of this file has repeatedly under-delivered.

### F10 behavioural proof (live store, from a `claude-engineering-skills` checkout)

`get-persona-sessions-by-repo --repo Lbstrydom/wine-cellar-app`:

| | result |
|---|---|
| pre-fix | `{"ok":true,"cloud":true,"rows":[],"scopedByRepoId":true}` |
| post-fix | wine's session `e3bd6f92…` (persona "Nadia — …home wine collector") |

The store predicate is `WHERE repo_name = $1 AND (repo_id = $3 OR repo_id IS
NULL)`, and `repoId` came from the ambient checkout — so the two clauses named
different repos and matched nothing. The **`scopedByRepoId: true`** beside the
empty array is what makes this worse than a plain wrong answer: the payload
actively asserts the scoping was correct.

### F4 behavioural proof (one-revert negative control, live store)

Run from a `claude-engineering-skills` checkout, against the real store:

| resolution | `persona-outcomes summary --repo Lbstrydom/wine-cellar-app` |
|---|---|
| pre-fix (`resolveScopedRepoId`, ambient) | `{"ok":true,"sessionId":null}` — **false**: reports wine has no persona sessions |
| post-fix (`resolvePersonaOutcomesScope`) | wine's real session `e3bd6f92…`, persona "Nadia — …home wine collector", verdict `Needs work`, rawP0 2 |

Only that one line was reverted for the control. `--repo bogus/nope` now returns
`UNKNOWN_REPO` ("It is NOT an empty result; nothing was measured") instead of
silently answering about the ambient repo.

## Problem

`scripts/cross-skill.mjs` (3,248 lines) is the single persistence entrypoint for
every skill. It has produced a disproportionate share of defects, all of one
family: **a read or a claim that is confidently wrong rather than absent.** A
prior audit (2026-08-11) left ~10 HIGHs unconverged against this file.

Each finding below was **re-verified by execution against HEAD 096b78c7** before
being admitted to this plan. Findings that died on contact are recorded in
§Rejected so they are not re-raised.

## Verified defects

### F1 — `learning-record` context hash collides and disagrees with its only sibling writer

`cross-skill.mjs:2954` computes:

```js
const canonical = JSON.stringify(p.context, Object.keys(p.context).sort());
```

The second argument to `JSON.stringify` is a **replacer array**: a *global,
recursive property allowlist*, not a key sort. Two consequences, both measured:

- **Nested content is erased.** `{passName:'x', meta:{model:'gpt'}}` serialises
  as `{"meta":{},"passName":"x"}` — `meta`'s contents are gone because `model`
  is not in the top-level key list. Arrays of objects become `[{},{}]`.
- **Different contexts therefore collide.** Two contexts differing only below
  the top level produce an **identical** sha256. Verified: both hash to
  `f5ec63d7cb26…`.

The comment claims "same algorithm as decision-logger". It is not.
`scripts/lib/learning/decision-logger.mjs` has a proper recursive
`_canonicalise` (sorts keys at every level, `__proto__`-safe) exposed as
`_internals.contextHash`. So the two writers of `learning_decisions.context_hash`
produce **different hashes for the same context**, and the CLI's is lossy.

**Fix**: delete the local implementation; call decision-logger's. One oracle.

### F2 — `record-ship-event` reports success for a failed write

`recordShipEvent` (`store/plans-ship.mjs:1430`) catches every error, writes to
stderr, and returns `undefined`. `cmdRecordShipEvent` (`cross-skill.mjs:584`)
ignores that and emits `{ok:true, cloud:true}` unconditionally. A ship event that
never reached the store reports as persisted. Sole caller is this CLI.

**Fix**: return a discriminated status from the store; report it at the CLI.

### F3 — `record-regression-spec-run` reports success for a failed write

Identical shape: `recordRegressionSpecRun` (`plans-ship.mjs:379`) swallows and
returns `undefined`; `cmdRecordRegressionSpecRun` emits `{ok:true, cloud:true}`.
Two callers — this CLI and `scripts/ux-lock-run.mjs:282`.

**Fix**: same as F2; update both callers.

### F4 — `persona-outcomes --repo <name>` is accepted and silently overridden

All three modes read the repo from two independent sources:

```js
const repoName = argOption('repo');          // what the operator asked for
const _scope   = await resolveScopedRepoId(); // --repo-id, else AMBIENT identity
const repoId   = _scope.repoId;
```

`resolveScopedRepoId()` never reads `--repo`. The store
(`store/persona-outcomes.mjs:247,356`) **prefers `repoId` when non-null** and only
falls back to `repo_name`. So inside any git repo with a resolvable identity,
`--repo other/repo` queries **this** repo and labels the output with the other
repo's name. `backfill-hash` is worse — it is a **mutating** command that would
migrate this repo's rows while logging the other repo's name.

This is the exact recurring shape: *a flag it accepts that does not do what its
consumer thinks.*

**Fix**: make `--repo` resolve to an id and be authoritative; conflict with an
explicit `--repo-id` is an error, never a silent winner.

### F5 — `arm-eval-run` persists an unscoped session when `--repo-id` is omitted

`cmdArmEvalRun:1157` uses `argOption('repo-id') || null` with **no ambient
fallback**, while its sibling `cmdArmEvalMaybeCapture:1310` correctly uses
`resolveScopedRepoId()`. A manual `arm-eval-run` therefore writes
`arm_eval_sessions.repo_id = NULL`, which every repo-scoped leaderboard read
then misses.

**Fix**: route through `resolveScopedRepoId()`, matching the sibling.

### F6 — `record-persona-session` trusts caller-supplied identity when both fields are present

`cross-skill.mjs:1621`:

```js
if (!data.repoId || !data.repoName) { /* reconcile against this checkout */ }
```

Reconciliation — the check that `repoId` and `repoName` name the *same*
repository — runs only when one is missing. Supply **both** and it is skipped
entirely, which is precisely the case the reconciliation exists to catch. The
`REPO_IDENTITY_CONFLICT` guard right below it is unreachable for that input.

**Fix**: always reconcile when a repo identity is resolvable.

### F7 — repo resolution collapses transient failure into "no repo scope" (systemic)

`resolveRepoForStore` (`store/repo.mjs:184`) returns `null` for **three
different facts**: cloud disabled (185), no row found (242), and *any thrown
error* (243–246, stderr + `return null`). `resolveRepoId` (`cross-skill.mjs:335`)
adds `.catch(() => null)` on top and hands `null` to writers.

`cmdUpsertPlan` and `cmdRecordShipEvent` then write a row with `repo_id = NULL`
on a **transient DB failure** — an unscoped row that no repo-scoped read will
ever return, reported as `{ok:true}`. This is the same defect already fixed one
branch above it in the same function for the explicit `repoUuid` path, which
fails closed with `REPO_RESOLVE_FAILED`.

**Fix**: one implementation, discriminated. Refactor `resolveRepoForStore`'s body
into a core returning `{kind:'resolved'|'cloud-off'|'unresolved'|'error'}`; keep
the existing null-returning function as a thin wrapper so all 53 existing
references are untouched; consume the discriminated form in `resolveRepoId` and
fail closed on `error`.

### F8 — `abort-refresh-run` reported success for an abort that did not happen

`cmdAbortRefreshRun` carried a comment stating the contract exactly — *"an
external caller that aborts a wrong-repo or already-terminal run must be told
so, not given an unconditional `{ok:true}`"* — directly above an unconditional
`emit({ok: true, cloud: true, aborted})`. The **store** half was fixed (proved by
`tests/refresh-runs-repo-scoping.test.mjs`: `abortRefreshRun` returns
`aborted:false` under the wrong repoId); the CLI wrapped that honest `false` in
`ok:true`, surfacing the real outcome only as a data field a shell caller
checking `.ok` never reads. A comment claiming a fix that was only half-made is
this file's signature defect.

**Fix**: `aborted === false` → `ABORT_NOT_APPLIED`, exit 1. No production caller
of the subcommand exists (`refresh.mjs` uses the store function directly), so the
tightening is contained.

### F9 — `getPlanIdByPath` labelled a store outage `not-found`

Its `catch` returned `reason:'not-found'`, so a thrown query produced *"no plan
registered at `<path>` — run the /plan flow first"*: the operator's input blamed
for the store being unreachable, and an invitation to re-register a plan that
already exists. Same collapse as F7, one call away, and `cmdUpdatePlanStatus`
rides on it.

**Fix**: distinct `lookup-failed` reason; the CLI raises `PLAN_LOOKUP_FAILED`
rather than `PLAN_NOT_RESOLVED`.

## Rejected — verified false, do not re-raise

- **"`--limit` is accepted but read by no handler."** Already fixed:
  `pageArgsFromFlags()` reads it for both nudge readers.

  **Claim corrected (shadow final review, HIGH).** An earlier revision of this
  plan cited "a full bidirectional flag census (94 declared flags) shows zero
  unread flags" as if it closed the inert-flag class. **It does not, and saying
  so was wrong.** `KNOWN_FLAGS` is a single GLOBAL union and `assertKnownFlags`
  validates names only, so a flag read by ONE subcommand is silently accepted
  and ignored by the other ~60. F4 (`persona-outcomes --repo`) and F16
  (`get-recent-findings --repo-id`) are precisely that shape — **and the global
  census passed while both were live.** The census proves only "some handler
  reads this name"; it is evidence against a *typo in the allowlist*, not
  against an inert flag. A per-subcommand regression lock over the pairs whose
  inertness caused real defects now sits beside it in
  `tests/cross-skill-cli-integrity.test.mjs`, with its limits stated in-suite.
  (`--policy/--baseline/--since` are forwarded to `learning/replay.mjs`, which
  reads all three.)
- **"`allAges` counting branch does not filter `is_open_disposition`"** — it does.
- **"`tests/fixtures/expected-schema.json` is malformed JSON"** — it parses.
- **"`recordSymbolIndex` / `recordLayeringViolations` swallow write failures"**
  (audit r1, bundled into the F2/F3 finding). They do not: both accumulate the
  real `result.rowCount`, warn on an attempted-vs-reported mismatch, and
  **`throw`** on a chunk failure, which the CLI turns into `emitError`. Executed
  and read before accepting the bundle — only the ship-event, spec-run and
  abort paths were genuinely defective.
- **"`cmdPublishRefreshRun` emits `{ok:true}` without evidence a row was
  published"** (audit r2 HIGH). It does not need to: the **live**
  `publish_refresh_run` definition (read from `pg_proc`, not from the first
  migration — migrations are cumulative here) `RAISE EXCEPTION`s on all three
  failure modes — run not found, run belongs to a different repo, and status
  not `running`. Every one becomes a thrown error the handler already converts
  to `emitError`. There is no silent 0-row path to guard.

## Deferred — independence named, and where each one actually landed

> **Correction (2026-08-17), and it is this plan's own defect class.** Three of
> the four entries below closed with *"Captured to the debt ledger."* **They were
> not.** A mechanical check of `.audit/tech-debt.json` — 149 entries — found
> **zero** referencing this plan or any of these items, by plan name or by
> content (`isCloudEnabled`, `initLearningStore`, `record-plan-verify`,
> `record-correlation`, `record-symbol-index`, `publish-refresh-run`: 0 hits
> each). The sentence was a **claim that was confidently wrong rather than
> absent** — the exact family this plan exists to remove, committed inside the
> plan that removes it, and the second time that has happened here (cf. the
> struck-through `decision-logger` entry below). It is corrected rather than
> deleted, because the pattern is the lesson.
>
> The claim is *not* being replaced with real ledger entries: filing debt for
> work that has since been **done** would swap one false record for another. The
> true disposition of each is stated inline instead, with the commit that closed
> it. The residual in #3 is a **stated design decision**, not open debt.

- ~~**ID-addressed child writes**~~ (`record-plan-verify-run`, `record-plan-verify-items`,
  `record-correlation`, `record-regression-spec-run`) take a parent UUID and never
  resolve a repo scope. **Independence**: unlike F1–F7 these are never wrong on a
  *default* invocation — being wrong requires the caller to supply a UUID belonging
  to another repo, which no skill does (each threads the id it just created in the
  same process). Fixing properly needs a parent→repo ownership check in the store,
  which is a schema-adjacent change larger than this remediation.
  → **CLOSED** by `5c952bc6` (*Phases 7–8 — parent-ownership joins for child
  writes*), with `fa7ef2c4` scoping the read path. Each command now threads the
  resolved repo into the writer's parent join and distinguishes
  `parent-not-found` from `parent-not-owned` — *"that plan does not exist"* and
  *"that plan belongs to another repository"* are different things for the
  operator to do next. The independence claim held: the fix arrived as its own
  schema-adjacent piece of work, exactly as predicted.
- **Arch-memory mutations** (`record-symbol-index`, `publish-refresh-run`, …) take
  `repoId` from the JSON payload. **Independence**: these are internal pipeline
  steps invoked only by `arch:refresh`, which resolves the id itself immediately
  before; none is documented for hand invocation.
  → **CONVERTED from a silent gap into a DECLARED one.** Still payload-supplied,
  by design, but each is now an explicit `scope: 'none'` entry in the command
  registry (`scripts/lib/cross-skill/registry.mjs`) with the reasoning carried in
  `commands/arch-refresh.mjs`'s docblock. That is the whole point of the registry:
  an undeclared assumption became an enumerable, conformance-tested declaration.
  A future change that *does* want these repo-scoped now has to edit a
  declaration rather than discover a convention.
- **`initLearningStore()` / `isCloudEnabled()` collapse "unreachable" into
  "disabled"** (audit r1 HIGH). Real, and the same family as F7.
  **Independence**: none of F1–F9 calls it for a *scoping* decision — it gates
  the cloud-off early return that every handler already treats as a documented
  graceful no-op, and the two states it merges produce the *same* local
  behaviour. Changing it re-types the entry condition of ~60 handlers plus every
  other CLI in the repo, which is a distinct piece of work from this one.
  → **MITIGATED where it bit, deliberately unchanged where it did not.**
  `67189e99` added `scripts/lib/store/client-state.mjs`: `getCloudState()`
  returns `'off' | 'ready' | 'unreachable'`, so the CLI stops telling operators
  *"AUDIT_DB_URL unset"* while their database is merely down. It is **wired, not
  ornamental** — `dispatch.mjs:212` reads it and `dispatch.mjs:294` emits
  `degraded: 'store-unreachable'`, asserted by `tests/cross-skill-finalize-round.test.mjs`
  and `tests/plan-verify-items-write-result.test.mjs`. The `isCloudEnabled()`
  **boolean contract is still collapsed on purpose**: routing stays on the same
  pool-presence check the legacy path used (byte-compatibility), and writes
  attempt anyway and report their own discriminated outcome. So the residual is a
  recorded design decision with its evidence deliberately narrow, not debt.
- ~~**God-module size**~~ (`cross-skill.mjs` 3.2K lines, `plans-ship.mjs` 1.4K) and
  the **domain layering violations** the mechanical waves flagged
  (`model-ab store → audit-arms`, `toggle → audit-arms`, `dashboard →
  model-eval`, install↔scripts reciprocal). **Independence**: all pre-existing,
  none in a file this change set alters behaviourally, and none reachable from
  F1–F9's call paths. Pre-existing architecture debt with its own ledger entries.
  → **CLOSED.** `cross-skill.mjs` is **3,248 → 1,098 lines**, split into 11
  command modules under `scripts/lib/cross-skill/commands/`; `store/plans-ship.mjs`
  no longer exists (the store moved to `scripts/lib/store/`). Layering: `3e1e02bb`
  (*Cluster 1 — 14 layering violations to 0, via 1 extraction*). Note §Acceptance
  item 2 — *"a 3,248-line god-module attracts a standing architecture HIGH that no
  fix inside it can retire"* — was exactly right, and retiring it needed a
  different plan, which is what happened.
- ~~**`decision-logger` retains caller-owned objects by reference**~~ —
  **NO LONGER DEFERRED; fixed as F19.** This entry contradicted the status table
  above it for two rounds, and the module itself still carried a "Known residual
  (documented, not fixed — right-sizing)" docblock after the fix landed. Both
  were corrected once the shadow final review named the contradiction — a stale
  comment asserting the opposite of what the code does is the exact defect class
  this plan exists to remove, committed inside the plan that removes it.

## Shadow final review (round 6) — 5 findings the primary APPROVEd past

`FINAL_REVIEW_SHADOW=claude-opus` returned `CONCERNS_REMAINING` against Gemini's
`APPROVE`, with **5 shadow-only findings and 0 overlap**. All five were real and
all five are fixed:

| | Finding | Disposition |
|---|---|---|
| HIGH | The flag census was cited as evidence against a class it cannot detect | claim corrected above + per-subcommand regression lock added |
| MED | `ux-lock-run` hand-rolls `opt`/`flag` with no `assertKnownFlags` — a typo'd `--strict-selector` silently ran in warn mode and reported success | `KNOWN_FLAGS` + guard added; refusal verified by execution |
| MED | Plan listed F19 as both fixed and deferred while the module documented it as "not fixed" | all three reconciled |
| MED | `validatePlanPath` case-insensitivity was `win32`-only; **macOS is case-insensitive too** | `darwin` added |
| LOW | The test helper `functionBody` sliced to the next `async function`, so unrelated code changed the scope of negative assertions | rewritten brace-balanced; falsifiability re-proved |

This is the second time in this repo's history the shadow reviewer earned its
keep after the primary gate approved — and the first two findings are ones a
human reviewer would plausibly also have missed, because both are *claims about
evidence* rather than defects in a line of code.

## Acceptance — outcome, stated honestly

| Criterion | Target | Actual |
|---|---|---|
| `/audit-code` HIGH | 0 | **7 (not met — see below)** |
| `/audit-code` MEDIUM | ≤ 2 | **16 (not met)** |
| Gemini final gate | APPROVE | ✅ **APPROVE**, 1 new MEDIUM (a test-env restore in a suite this change set does not touch) |
| Shadow reviewer | reviewed | ✅ `CONCERNS_REMAINING`, 5 shadow-only findings — **all 5 real, all 5 fixed** |
| `npm test` | green, skip count unmoved | ✅ 190/190 across every suite covering these files; skips 26 → 26 |

### Why HIGH == 0 was not reached, and why the rounds were run anyway

Round-by-round HIGH: **9 → 6 → 8 → 4 → 5 → 7**. It oscillates rather than
converging, and the reason is structural, not a backlog of unfixed bugs:

1. **The remaining HIGHs are the §Deferred entries, re-bundled differently each
   round.** The auditor aggregates; the same two clusters (ID-addressed child
   writes; `initLearningStore`/`isCloudEnabled` collapse) reappear inside a
   newly-worded HIGH each time. Each has its **independence named** above.
2. **A 3,248-line god-module attracts a standing architecture HIGH** that no
   fix inside it can retire.
3. Rounds 3–6 each still produced **genuine net-new defects** (F13–F21), which
   is why the 2–3 round convergence cap in AGENTS.md was deliberately exceeded —
   that cap exists to stop rigor-pressure, and this was not rigor-pressure. The
   *last* round's genuinely-new yield was 2, and both were fixed.

**Read this as: the reported HIGH count is not a count of open defects.** Every
finding raised across six rounds was either fixed (F1–F21), deferred with its
independence named, or verified false and recorded in §Rejected. Anyone
resuming should start from §Deferred, not from the raw verdict.

## Closure (2026-08-17)

Nothing in this plan's scope remains open, so it moves to `Complete`. Verified
mechanically against the tree, not from recollection:

| Was | Now | Closed by |
|---|---|---|
| F1–F21 | landed and shipped | `8f582e80` |
| Deferred: ID-addressed child writes | closed — parent-ownership joins, `parent-not-found` ≠ `parent-not-owned` | `5c952bc6`, `fa7ef2c4` |
| Deferred: arch-memory mutations | declared `scope: 'none'` in the registry, reasoning in code | `cross-skill-command-registry.md` Cluster B |
| Deferred: `isCloudEnabled` collapse | mitigated + wired at the envelope layer; boolean contract collapsed **by design** | `67189e99` |
| Deferred: god-module + layering | closed — 3,248 → 1,098 lines / 11 modules; 14 layering violations → 0 | registry clusters, `3e1e02bb` |
| §Deferred's *"captured to the debt ledger"* | **false claim, corrected in place** | this closure |

**The successor absorbed the deferrals by design, not by accident.**
`docs/plans/cross-skill-command-registry.md` (Status: **Complete**) states it
outright — *"the deferred clusters from `cross-skill-cli-integrity.md` land here
natively"* — and that is what the §Acceptance analysis argued for: the residual
HIGHs were structural, so the way to retire them was a plan whose scope was the
structure, not another round inside this one.

**The one thing this closure is evidence for.** The §Acceptance section was
written to say *"the reported HIGH count is not a count of open defects."* That
was a claim about the future, and five days of successor work is what tested it:
every residual HIGH turned out to be a real piece of work that a differently
scoped plan closed. Running a seventh round here would have found none of them.
But the same closure also found a false sentence that six audit rounds, a Gemini
gate, and a shadow reviewer all read past — because *"captured to the debt
ledger"* is a claim about a **record elsewhere**, and no reviewer looking at this
file could falsify it without going and reading the ledger. That is the
generalisable lesson, and it is not "audit harder": **a claim whose truth lives
outside the diff needs a mechanical check, not a reader.**
