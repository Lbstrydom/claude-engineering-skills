# Plan: Final-review reliability (backlog-triage cluster D)
- **Date**: 2026-10-25
- **Status**: Complete
- **Author**: Claude + Louis
- **Scope**: backend — stack `js-ts`
- **Target domain(s)**: `audit-orchestration`, `shared-lib`
- **Source**: `docs/plans/backlog-triage-2026-10-25.md` section 5 (cluster D); fleet proposal `p-20261015193106-0ace`; upstream `d4dada5d`.

## 1. Problem
A final review whose response was truncated, or that never got to record its verdict, must not read as a clean review
(an approve-by-silence). Three independent gaps remain on main:

1. A truncated or structurally invalid response reads as "reviewer found little" (`finish_reason: length` / `MAX_TOKENS`).
2. Campaign-scope refusal fires after the primary reviewer is billed; run-id recovery is not bound to the transcript;
   provider readiness exits the process instead of throwing.
3. Two concurrent reviews in one worktree: the one that loses the marker lock records nothing, so the first review's
   APPROVE keeps standing (0ace).
4. `Code: PARTIAL, changed lines unmeasured for N file(s)` names neither the file nor the reason (d4dada5d).

## 2. Design
- **Carries (rebased, already designed and audited in the archive tag `ad59c28`)**: `94b59fe2` (truncation fails the
  review; one conflict, resolved to main's behavioural test), `b3849183` (`requestIdentity` in the shadow ran-block),
  `dd0f2ed7` (preflight refusal, bound run-id recovery, readiness throws). `d9eda256` is an optional refactor with four
  conflicts and is NOT carried: it adds no behaviour a requirement needs.
- **0ace**: a review registers a uniquely named file under `.audit/last-final-review.pending/` when it starts; the marker
  reader refuses (`reason: 'pending'`) while any entry exists. A recording review removes its own entry and every entry
  that started before it. An entry from a review that started LATER stays (that review governs). Creating a new file
  needs no lock and no read-modify-write, so registration cannot lose the race a late revocation can. Fail closed: a
  crashed review leaves the ship refusing until a review records again; a registration failure makes the lifecycle fatal.
  Alternative rejected: revoking under the lock at start — the earlier review can still finish after it and re-write.
- **d4dada5d**: `formatCodeCoverageSegment` appends `; UNMEASURED: <file> (<reason>)` from `changedUnmeasured`, which
  already carries path and reason. Capped at 5 (+N more), control characters flattened, sensitive paths never named,
  non-code assets omitted as in the NONE list.

## 3. Must NOT fire (negative controls)
- A clean coverage record emits no `UNMEASURED` segment; a sensitive path is `[sensitive path]`, never its name.
- An earlier review finishing does not clear a later review's pending entry; no pending entries leaves the reader's
  behaviour unchanged (`absent` stays `absent`).

## 4. Acceptance criteria
- `tests/final-review-pending-attempt.test.mjs`, `tests/final-review-code-coverage.test.mjs`,
  `tests/final-review-hunk-windows.test.mjs`, `tests/gemini-review-*.test.mjs` pass.
- No migration; consumer-visible change is the final-review report line and the new `pending` refusal reason.

## 5. Outcome (2026-10-25)
- Carried `94b59fe2`, `b3849183`, `dd0f2ed7` from the archive tag; `d9eda256` (optional refactor, four conflicts) not carried.
- /audit-code: 4 rounds (R3, R4 PASS), Gemini APPROVE (0 blocking, 0 debt). Round 1 found 8 HIGH, of which the pending
  registry needed a persisted total order (wx-created stamp), a supersession check (a review whose entry a later
  recorder cleared writes nothing) and a per-attempt nonce for ownership; ENOTDIR now refuses; recovery of an oversize
  array is restricted to arrays. Dismissed: run-id fallback to an earlier round (deliberate, tested, bound by marker-run equality).
- Audit plan step skipped: the design is the approved triage brief; the audit exercised it.
