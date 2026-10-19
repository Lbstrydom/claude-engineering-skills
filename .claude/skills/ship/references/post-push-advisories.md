---
summary: Steps 6.5-6.8's post-push advisories and the Step 7 close-out - incident history, kept out of the routine flow.
---

# Post-push advisories — incident history and design rationale

## 6.5 — Security memory refresh

**Call the script by path, never `npm run security:refresh`.** The sync never
merges npm scripts into a consumer's `package.json`, so that alias exists in
the source repo and nowhere else. From 2026-08-14 this step used that alias
with `--if-present` appended, which silenced the `Missing script` error a
consumer reported — and, because that flag exits 0 having run nothing, turned
every consumer refresh into a silent no-op with a success exit code. The
refresher itself **is** synced
(`scripts/.claude-skills/security-memory/refresh-incidents.mjs`), so naming
the path makes the step actually run where it was always meant to. Do not
"fix" a missing alias by writing to a consumer's script table from a SKILL
step.

The commit-subject regex is word-boundary-anchored deliberately: the
unanchored form matched "leak" inside "leaking", "auth" inside
"author/authoring", and "rce" inside "source/force/interface",
false-flagging ~6% of commits in a 200-commit sample (confirmed 2026-07-22).

## 6.6 — Friction closure

**The cadence differs from the hook, and that is worth knowing.** With the
`UserPromptSubmit` hook (Claude Code only), friction is surfaced *as you
work*; without it, only here, once per ship. On a host with no hooks the
session-review call returns whatever the store holds — which, with nothing
injected during the session, is usually empty. That is a correct empty, not
a broken one, and this step must not read an empty list as evidence that no
friction existed. Earlier wording asserted the hook "injects" callouts as
plain fact, which is false outside Claude Code.

## 6.7 — Final-review credit

**Why this step exists.** `final-review-adjudicate` and
`final-review-record-fix` have existed and been tested since the shadow-A/B
experiment closed — and nothing called them, so `user_action` stayed null,
credit landed only in source comments, and the resulting tail read as noise
until a manual sweep recovered it (2026-07-28). This step is the missing
caller.

**Widened to the primary bucket** (docs/plans/skill-efficacy-census.md Phase
1, 2026-08-22): the 2026-07-28 fix only reached the shadow-only bucket — the
READ side (`final-review-pending`) was hard-scoped to `shadowOnlyQueue`, so a
primary GPT/Gemini-round finding was never surfaced here at all, however
long it sat fixed with `user_action` still null (a live-store audit found
1,615 such rows). `final-review-pending` now reads a merged `pendingQueue`
(shadow-only ∪ primary-bucket fixed-but-unlabelled), and the card threads
each item's own `bucket` through to its printed command instead of
hardcoding `shadow-only` — a bug that would have silently mis-scoped every
primary-bucket item even after the read side was widened.

**Pagination — walking the whole queue (since 2026-09-13).** The card shows
one page. The JSON form pages by a keyset cursor, never an offset — the
queue is drained by the very adjudication that walks it, so an offset would
skip one row per adjudication (measured before the change: a 50-row cap with
no way past it left ~2,167 of 2,217 credit rows unreachable through this
CLI).

**A ruling on EITHER axis is a label** (since 2026-09-14,
docs/plans/final-review-credit-projection.md). A finding's adjudication
lives on two columns: `adjudication_outcome` (the triage ruling, written
automatically by the audit loop's own deliberation) and `user_action` (the
ship-time disposition this step's `final-review-adjudicate` writes). Until
this date the card read only `user_action`, so a primary-bucket finding the
loop had already ruled `accepted` weeks earlier — 1,649 of 2,280 rows in one
live measurement — still printed as "fixed-but-unlabelled" and this step
asked you to re-adjudicate it. `user_action` is a durable override: once set
to anything but `needs_triage` it wins outright.

**Re-running the final reviewer no longer erases prior rulings.** Before
2026-09-14, `recordFinalReviewFindings` replaced a run's findings by
DELETE-then-INSERT, so a second Gemini pass over the same `--run-id` (a
re-run round, or a consolidated union-diff gate) silently wiped every
`user_action` / `adjudication_outcome` a human or agent had already written
on that run's rows. It now upserts the new snapshot and prunes only the rows
the snapshot dropped that carry no ruling and no recorded remediation on
either axis.

## 6.8 — Consumer-side verification

**One note per ship, and none of them overwrite each other** (2026-09-07,
upstream b02d80b3). This step used to write ONE fixed filename
unconditionally, and the gap between a write and the next read is
unbounded — Step 2 only runs inside `/ship`, and not every status.md commit
is a ship. A second ship inside that gap destroyed an unread note by
following this step as written, silently in both directions. Hit live
2026-09-06: a verified note was still unread ~10 hours later when the next
Step 6.8 ran. The filename now carries the sha and a timestamp, so a
collision is not expressible rather than merely unlikely.

**The MAIN checkout, not the worktree you are standing in** (2026-08-14). A
ship run from a linked worktree that is then deleted — the normal end of a
Claude Code session — destroys this note before any later `/ship` can read
it, so the handoff silently never happens and the only symptom is a note
that never appears. `.claude/tmp/` resolves per-tree, so a hand-written path
means a different directory depending on where you are standing. Both the
reader and writer resolve the durable location themselves, via the same
`--git-common-dir` trick `skills:hydrate` uses: in a linked worktree the
common dir's parent IS the main checkout, and the main checkout is the one
tree guaranteed to outlive the session.

**Why not re-open the pushed status.md entry.** status.md is append-only, and
this step runs AFTER that entry's commit already landed: writing into it now
means a second commit and a second push, which re-triggers the same
pre-push readiness suite Step 6.8 exists to verify — doubling the
workflow's cost for one status line. A consumer hit exactly this 2026-08-14
and reported it as friction.

## Close-out — where the shipped work is, and what else is dirty

A clean ship from a linked worktree can leave the user's EDITOR on another checkout (often the main one, on an older branch) with
hundreds of changes. The Changes badge then reads as "the shipment is unfinished" (reported by a Windows/VS Code consumer
2026-10-19: 232 changes, 176 of them test artefacts, in a checkout the ship rightly never touched). Step 7 ends with one
READ-ONLY block that says which tree was shipped and what the others look like. It never changes another checkout.

1. **Shipped**: the worktree path, its branch, the pushed sha, and whether `origin/main` contains it. Make a claim about remote
   main only after `git fetch origin main` succeeded. Then `git merge-base --is-ancestor SHA origin/main`: exit 0 = contained;
   exit 1 = not on main yet (say why: PR open, unmerged); any other exit = the probe failed (bad ref, missing object, repository
   error): report "unknown" with the diagnostic and do not claim either result.
2. **Other checkouts**: for each other entry of `git worktree list --porcelain` (the main checkout first), run
   `git -C PATH status --porcelain=v1 --untracked-files=normal`. Report tracked edits and deletions, untracked files, and untracked
   DIRECTORIES separately; a directory holding its own `.git` is an embedded repository and is named as one. Say when a count
   could not be measured; never print 0 for a probe that failed.
3. **Next action**: how to open the shipped tree (`code PATH`), and, if another checkout is dirty, one sentence: that checkout is
   what the editor is showing, the ship did not touch it, and cleaning it is a separate task the user starts.

Never run `git reset`, `git clean`, `git checkout -- .`, `git stash`, or delete ignored files in another checkout from this step.

**Cleanup, only after the user asks for it and approves the plan** (preservation first):

- Probe twice, and compare content as well as status: the same ` M path` lines prove nothing if a file changed underneath. Take a
  snapshot of everything the cleanup would move, twice: `git -C PATH diff HEAD | git hash-object --stdin` (staged and unstaged
  tracked changes) plus `git -C PATH ls-files --others --exclude-standard -z | xargs -0 git -C PATH hash-object` (every untracked file
  by content; an embedded repository is hashed from its own `git rev-parse HEAD` and `git status --porcelain`). Any difference means stop: something is writing there.
  Even identical probes are only evidence, not proof of idleness: ask the user to confirm that no editor, agent or test run is
  using that checkout before anything moves.
- Copy the whole tree, embedded repositories included, to a dated folder OUTSIDE the repository, byte for byte, and verify it with a
  hash manifest compared in both directions. A plain `git stash -u` is not a backup: it does not carry embedded repositories.
- Tracked edits go into a NAMED stash (`git stash push -m "cleanup-DATE"`); note its sha from `git stash list --format=%H%x20%gs`
  and restore with `apply`, never `pop`. Untracked folders are moved (not stashed) into the verified backup.
- Real source edits are never hidden: list them for the user before anything moves.
