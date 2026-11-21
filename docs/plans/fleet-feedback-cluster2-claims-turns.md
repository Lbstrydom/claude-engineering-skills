# Plan: fleet feedback cluster 2 — a turn outlives its work, broad claims, stale ready marks
- **Date**: 2026-11-21
- **Status**: In progress — plan audited (3 GPT rounds, Gemini APPROVE), implementing on branch claude/fleet-cluster2-claims-turns
- **Author**: Claude + Louis
- **Scope**: backend (Node CLI, `scripts/lib/fleet/**`, `skills/fleet/**`). Stack `js-ts`.
- **Target domain(s)**: `fleet`

## 1. Context Summary

Work-consumer fleet feedback of 2026-11-21, items #1, #2, #9. Code trace (all read at `47148350`):

- **#1.** The lease turn is per repo (`lease-turns.mjs`). It ends on expiry, or after `batchGapMs` (10 min) idle, and
  while ANY window of that repo is running the repo counts as busy (`busyOf`, `lease-turns.mjs:26`). `release
  --end-turn` yields it, but only when the caller passes the flag (`lease.mjs` `decideRelease`). The incident: the
  slot was released at 16:17 with the PR merged and the session archived, yet the turn lasted to 16:37 — the repo's
  own CI window (`decideReleaseToCiWindow`, kind `ci`) kept it busy for a PR that no longer needed CI. Nothing ties a
  window or a turn to the work it served; `fleet release` (`lifecycle.mjs` `cmdRelease`) never touches the lease.
- **#2.** `claim --paths tests/**` registers a pattern that `patternsIntersect` (`overlap.mjs`) matches against every
  sibling's tests, so it blocks them (the `abstractOnly` softening needs BOTH sides wildcard and no tracked file in
  common). `claim` says nothing about breadth. Directives (`directives.mjs`) have a closed five-kind vocabulary
  and `verifyDirective` (`obligations.mjs`) marks one VERIFIED only when fleet derives the same obligation from
  facts itself; no kind can ask a session to narrow its claim. `claim --paths` REPLACES the recorded paths
  (`commands.mjs` `claimPaths = hasPaths || mode === 'new' ? paths : cur.paths`).
- **#9.** A session stays `ready` (non-terminal) until it runs `fleet release`. `landingOrder` already excludes a stale
  mark (`overlap.mjs` `landingOrder`: `state === 'ready' && !readyStale`), but the record still shows as `ready (stale —
  head moved)` in `status`/`next` and a merged one still looks live. `fleet release --id <x>` retires one by hand.

## 2. Design

### D0 — one release transition, used by every retiring path (audit H6)
`retireSession(t, cur, target, ctx)` (in `lifecycle.mjs`, runs inside the registry transaction) is the ONE place a
session becomes `done`/`abandoned`; it replaces the inline write in `cmdRelease` and is what the bulk path calls.
`afterRetire(ctx, {merged})` is the one follow-on step (D1), run inside the same registry lock. Per-item results carry TWO separate
fields: `retirement` = `retired | skipped(reason) | failed(reason)` and `lease` = `n/a | ended | cleared+ended |
skipped(reason) | failed(reason)`; JSON includes `repair` (the exact `fleet release --id <x>` command) whenever
`lease` is `failed`. Partial progress stands (each item commits on its own). Exit: a retirement `failed` is a refusal
(non-zero, as today); `retired` with `lease: failed` is `ok:true` with a `warning:` line and the repair command —
the release the caller asked for happened and its follow-on is bounded and repairable; skipped items alone are ok.

### D1 — a turn ends when the work it served is gone
`endTurnWorkGone(lease, repoKey, now, {clearCi}, by)` (pure, `lease-turns.mjs`). It does nothing when `repoKey` holds the
slot or has a waiter (its job or a sibling job exists). Otherwise two INDEPENDENT effects: if the turn is `repoKey`'s it
ends it (`turn-ended`, reason `work-gone`); and, only when `clearCi` is set, it clears `repoKey`'s own running
`kind:'ci'` windows (`window-cleared`, `ownRepo:true`, `reason:'work-gone'` — existing journal kinds) whether or not
the turn still exists (a turn that already expired must not strand the window). Neither effect applies to another
repo's turn or windows. Nothing to do returns the SAME object, and the result says which effects applied.
- **When it runs (audit H1).** The registry `transact` is a file lock, not a database transaction: `writeSession` is an
  immediate atomic write with no rollback, so the retirement is DURABLE the moment `retireSession` writes it, before
  the lease is touched; a throw afterwards cannot un-retire it. The lease step then runs while the registry lock is
  still held: if the retired session was the repo's last non-terminal one, `transactLease(machineDir,
  …, {maxWaitMs: 2000})` applies it. Lock order is registry → lease; no path takes them the other way (the lease
  verbs never read the registry), so it cannot deadlock, and a `claim` that would register new work needs the
  registry lock, so no session can appear between the count and the lease write. A lease lock timeout is a bounded
  2 s wait, never a hang.
- **Windows (audit H3).** CI windows carry no work identity and adding one would change `lease run`/`sync-pr` callers,
  so the policy is conservative and explicit: windows are cleared ONLY when the released session's branch has merged
  evidence (`status` item `merged.merged === true`: its CI is moot) AND it was the repo's last live session. An
  `abandoned` release, a release with no merged evidence, or unreadable evidence ends the TURN only; the window
  then expires on its own (it can still hold other repos off the slot until it does, as today). Test: two windows,
  merged vs abandoned vs unknown, another repo's window untouched.
- **Recovery (audit H2).** A lease failure, or a crash after the registry commit, is bounded (the turn still expires
  at its own `endsAt`) and repaired by re-running the same `fleet release --id <x>`: on the `already` path
  `cmdRelease` re-attempts the lease step, which is idempotent (`endTurnWorkGone` is a no-op once the turn is gone).
  The failure line prints that exact command. No persisted intent record: a second store for one bit of derived
  state is the over-built version, and the lease already self-expires.
*Band-aid considered:* shorten `batchGapMs` or ignore the repo's own windows in `busyOf`. Rejected — the 2026-10-14
batching policy and "own CI counts as its time" are deliberate; the defect is only that the work is GONE.
*Over-built considered:* make the lease read the session registry from `settleQueue` (couples a machine-wide store to
per-repo ones), or a persisted work-gone intent (above).

### D2 — broad claims are named, and a verified directive can ask to narrow one
`broadClaimPatterns(paths)` (pure, `overlap.mjs`, over the existing validated claim grammar — patterns are already
repo-relative with `/` separators, `validateClaimPattern` rejects anything else): the LITERAL prefix is the leading
segments containing no `*`/`?`; a pattern is BROAD when its LAST segment is exactly `*` or `**` and its literal prefix
has at most two segments (`tests/**`, `app/views/**`, `**`, `src/*`, `src/*/lib/**`). A last segment like `*.test.mjs`
is not whole-segment and stays narrow. `claim` WARNS (never refuses: a docs-only session legitimately claims
`docs/plans/**`) — one `warning:` line naming the patterns, and `broadPatterns` in the JSON.
New directive kind `narrow`. Inventory of what changes: `DIRECTIVE_KINDS`/`DirectiveSchema` (`directives.mjs`),
`KIND_ACTION` + `verifyDirective` + a new `broad-claim` obligation in `deriveObligations` (`obligations.mjs`),
`cmdDirective`'s kind error text, the `render-train.mjs` participant text and `skills/fleet/references/{coordination,
participant-rules}.md` (the five-kind lists). Mixed versions: an older bundle reads the new kind through
`classifyDirective`'s existing rule (unsupported: listed, never acted on, never makes the registry incomplete) —
asserted by a test over the OLD kind list. `deriveObligations` raises `broad-claim` for a session whose recorded claim
holds a broad pattern AND that has a live non-known overlap; `verifyDirective` marks `narrow` VERIFIED only when
that obligation exists (the reason kind is not consulted — the fact is the verification), else `unverified`. The
action text quotes the session's ACTUAL broad patterns and the replacement command (`fleet claim --paths <the
files you actually edit>`, which replaces the recorded paths).

### D3 — stale ready marks: invalidate the mark, retire only proven-landed work (audit H4, H5)
`staleReadyMarks(items, {now, days})` (pure, `overlap.mjs`; `days` must be a whole number 1..3650, else an ArgvError;
the age is `now - Date.parse(ready.at)` and a mark is aged when that is `>= days * 86400000`; a missing or
unparseable `ready.at` is skipped with its reason, never aged) returns two classes from status items in state `ready`:
- `landed` — `merged.merged === true`, which `facts.mjs` sets only when merged evidence (a merged PR head or a squash
  patch-id) covers the branch's EXACT current tip; a branch that gained commits after the merge reads `'partially'`
  (as `deriveObligations` already distinguishes) and is NOT landed → retire `done`. A `'partially'` merged state falls
  through to the aged test on its own merits; UNREADABLE merged evidence (`gh` down, PR list incomplete) does not:
  nothing is listed for that session at all (neither class), because an aged mark may be a merged one we cannot see.
  Unreadable HEAD evidence (git cannot name the tip) likewise lists nothing. Evidence needed to LIST and to APPLY
  is the same, per class: landed = merged evidence readable and `true`; aged = merged evidence readable and not
  `true`, head readable and moved, `ready.at` valid and old.
- `aged` — the mark is older than `days` (default 14) AND `readyStale` (head moved): not proof of abandonment, so the
  session is NOT retired; only its mark is invalidated (`state: working`, `ready: null`, rev+1), which is exactly
  what a moved head already means. The session and its claim live on.
`fleet release --stale-ready [--days N] [--apply]` (mutually exclusive with `--id`/`--abandoned`): lists both classes;
dry run by default. `--apply` re-gathers fresh facts, recomputes, and acts only on an item whose refreshed entry has the SAME identity AND
the SAME class as listed (id, `gen`, `rev`, `ready.oid`, class) — an item that turned `aged`→`landed` or
`landed`→`aged` between preview and apply is skipped with `class-changed` and needs a new preview; each item then commits in its own registry transaction through `retireSession` (landed) or a mark
invalidation, re-checking `gen`/`rev`/`state`/`ready.oid` AND re-reading the branch tip with local git inside the
transaction (the same "tip must still be the judged tip" rule `prune --apply` uses). Unreadable merged or head
evidence skips the item with its reason — never guesses. Remote evidence changing in the instant between that
re-read and the write is inherent to any check-then-act over a remote and is bounded by reversibility: a `done`
session re-claims (`claimMode`: terminal → new) and an invalidated mark is re-made by `fleet ready`.

## 3. Acceptance criteria

- A1. `endTurnWorkGone` ends the repo's turn; clears its own running CI windows only with `clearCi`; returns the same
  object when the slot is held by the repo or a same-repo waiter exists, and when the turn is another repo's AND no
  eligible own CI window needs clearing; with another repo's turn and an eligible own window only the window
  changes (the other repo's turn is untouched); never touches another repo's windows.
- A2. `fleet release` of the repo's last live session ends its turn (red-first: the 16:17/16:37 scenario). With merged
  evidence it also clears the CI window, even when the turn already expired or is another repo's; abandoned or unknown evidence leaves the window. A sibling live session
  keeps the turn. A lease lock timeout leaves the release committed and prints the repair command; re-running it
  completes the lease step.
- A3. Interleaving: a `claim` cannot register between the last-session count and the lease write (both under the
  registry lock) — asserted by running the release's lease step with a claim queued on the registry lock.
- A4. `broadClaimPatterns` classifies `tests/**`, `**`, `app/views/**`, `src/*`, `src/*/lib/**` broad and
  `tests/foo.test.mjs`, `src/lib/fleet/**`, `tests/*.test.mjs` not; `claim` warns and carries `broadPatterns`,
  never blocks.
- A5. A `narrow` directive is VERIFIED only for a session with a broad claim and a live overlap; UNVERIFIED otherwise;
  a reader holding the old kind list lists it as unsupported.
- A6. `release --stale-ready` lists landed and aged classes; `--apply` retires landed, invalidates aged (never retires
  them), skips an item whose `rev`, `ready.oid` or branch tip moved, and rejects `--id`/`--abandoned`. An active
  session with an old mark keeps its claim.
- A7. Bulk retirement of a repo's last live session ends the turn exactly as a single release does (one transition).
- A8. `skills:check`, `cli:catalog`, the fleet skill references agree; AGENTS.md untouched.

## 4. Files

- `scripts/lib/fleet/lease-turns.mjs`, `scripts/lib/fleet/lease-workgone.mjs` — D1 (the pure decision, the bounded lease step)
- `scripts/lib/fleet/lifecycle.mjs` — D0/D1/D3 (`retireSession`, `afterRetire`, evidence binding, `release --stale-ready`)
- `scripts/lib/fleet/overlap.mjs` — D2/D3 (`broadClaimPatterns`, `staleReadyMarks`, overlap `ownPatterns`)
- `scripts/lib/fleet/obligations.mjs`, `scripts/lib/fleet/directives.mjs` — D2 (the `narrow` kind, the `broad-claim` obligation)
- `scripts/lib/fleet/commands.mjs`, `scripts/lib/fleet/argv.mjs`, `scripts/fleet.mjs`, `scripts/lib/fleet/render-train.mjs` — claim warning, flags, usage text
- `skills/fleet/references/coordination.md`, `skills/fleet/references/participant-rules.md`, `skills/fleet/references/ending-a-session.md` — the documented vocabulary and verbs
- `tests/fleet-cluster2.test.mjs` — A1-A7
