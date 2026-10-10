# Plan: /fleet — status truth, a coordination channel, and real landing (wine + storyline feedback)
- **Date**: 2026-10-09
- **Status**: Approved
- **Author**: Claude + Louis
- **Scope**: backend (CLI + skill content; no UI) · stack `js-ts`
- **Target domain(s)**: `fleet`, `skills-content`
- ⚠ **Cross-domain work** — touches >1 domain; the `skills-content` half is the SKILL.md / reference prose that teaches the new verbs (intentional).
- **Depends on**: docs/plans/fleet-storyline-feedback.md (Complete)

## 1. Context Summary

Two consumers ran `/fleet` hard on 2026-10-09: wine-cellar-app across seven
concurrent sessions, storyline for two days. Their reports were re-verified
against this repo at `9ed60afc` before planning. Already shipped and therefore
NOT in this plan: the fresher-of-local/upstream measurement base (wine 4,
overlaps half), `hotFiles` (wine 5), idle/merged hiding (wine 6). Everything
below is still true at `9ed60afc`.

The failures sort into three groups, which are this plan's three clusters:

1. **Status lies in ways that caused wrong actions** — squash-merged work reads
   as unlanded and stays in the proposed landing order; a PR merged 3 s after
   `ready` on draft-time SKIPPED checks, because a skipped check counts as
   passing; a finished claim can only lapse; uncommitted edits are invisible to
   overlap detection; archiving a worktree destroyed gitignored deliverables.
2. **Coordination runs through host messaging, which fails twice** — messages
   are held when permission modes differ (host behaviour fleet cannot change),
   and a delivered peer message is (correctly) treated by the receiving model as
   untrusted data, so sessions second-guess the coordinator. The fix is to move
   coordination OFF messages into the shared registry and to move AUTHORITY into
   the user's own launch prompt, scoped to a closed set of safe directive kinds.
3. **Landing does not match how repos with strict "up to date" rules land** — a
   combined train cannot satisfy GitHub's per-PR fresh run; restacking after a
   squash merge is manual; append-only docs conflict every time; a `.fleet.json`
   guard added by one branch is never applied to another before CI.

**Code Trace (9ed60afc).**
- PR facts: `gatherFacts` `scripts/lib/fleet/facts.mjs:107` → `listPullRequests`
  `scripts/lib/fleet/gh-facts.mjs:254` → `runGh` `gh-facts.mjs:240` hard-codes
  `--state open`; merged PRs are never observed. Checks: `attachChecks`
  `gh-facts.mjs:224` → `summariseChecks` `gh-facts.mjs:91`, whose `good` list is
  `['SUCCESS','NEUTRAL','SKIPPED']` (`gh-facts.mjs:95`) — a skipped check is a
  pass, and nothing anywhere reads which checks are REQUIRED.
- Completion: `buildStatus` `scripts/lib/fleet/overlap.mjs:~525` calls
  `deriveDone` `overlap.mjs:~436`, which recognises ONLY `phase:'landed'`
  trains. A PR merged by hand never makes its session `done`; `landingOrder`
  (`overlap.mjs:~689`) then keeps proposing it. Untracked items hide as
  `merged` only on `ahead === 0` (`hideReason` `overlap.mjs:~730`) — a squash
  merge never makes a branch's tip an ancestor of base.
- Evidence: per-branch `changedFiles` `scripts/lib/fleet/git-facts.mjs`
  (`git diff --name-only base...branch`) — committed only. The ONLY porcelain read
  is `probeWorktreeCleanliness` `facts.mjs:~260`, which keeps a boolean and
  discards the paths.
- Verbs: `VERBS` `scripts/lib/fleet/argv.mjs:16` — no `release`, `next`,
  `directive`, `archive-check`, `restack`. Hold: `cmdHold`
  `scripts/lib/fleet/commands.mjs:337` writes `hold.json`; `cmdClaim` /
  `cmdReady` / `cmdTouch` (`commands.mjs:141`, `:280`, `:321`) never read it.
- Landing: `approveTrain` `scripts/lib/fleet/train-approve.mjs:~205`, pr mode →
  `verifyPrsForPlan` requires every PR's `baseRefOid` to equal the ONE recorded
  base, then `planFor` prints `gh pr merge … --match-head-commit` commands and
  stops `awaiting-merge`. After the first merge the base moves, so on a strict
  repo every later PR needs update-branch + a fresh CI run that fleet neither
  performs nor waits for. Land-phase hooks: `finishTrain`
  `scripts/lib/fleet/train.mjs:378` runs `runChecks({cwd, …})` with the CALLER's
  checkout, before dependency provisioning, so a guard committed on one train
  branch never runs. Conflicts: `applySources` `train.mjs:~357` stops at the
  first conflict.
- Registry: `SessionSchema`, `HoldSchema`, `TrainSchema` are all
  `z.strictObject` (`scripts/lib/fleet/registry.mjs:60`, `:96`, `:103`);
  `listTrains` treats any unexpected file in `trains/` as invalid
  (`registry.mjs:~402`).

**Neighbourhood considered.** `get-neighbourhood` over gh-facts / commands /
train-approve returned only `review`-band matches (nothing above this repo's
noise floor): `scripts/ensure-branch-protection.mjs` reads rulesets through
`gh api`, but for an admin write path; required-checks here reads per-PR state
via `gh pr checks --required`, which needs no admin scope. No reuse.

**A compatibility fact that shapes the design.** Each linked worktree runs the
tooling copy it was hydrated with, so two bundle versions routinely read one
registry. Every registry schema is strict, so a NEW optional field on an existing
record makes an older worktree read that record as invalid → `registry
incomplete` → every claim refused fleet-wide. Rule for this plan: **existing
record schemas do not change**; new data goes in NEW directories, which old
readers never open (`readSessions` reads only `sessions/`; `listTrains` only
`trains/`).

## 2. Proposed Architecture

```mermaid
graph LR
  CLI["scripts/fleet.mjs"] --> CMD["commands.mjs (existing verbs)"]
  CLI --> LIFE["lifecycle.mjs: release / archive-check"]
  CLI --> COORD["coordination.mjs: next / directive"]
  CLI --> LAND["land.mjs"]
  CLI --> RS["restack.mjs"]
  LAND --> SER["serial.mjs"]
  FACTS["facts.mjs gatherFacts"] --> MERGED["merged-facts.mjs"]
  FACTS --> WTS["worktree-status.mjs"]
  FACTS --> DIR["directives.mjs"]
  MERGED --> GH["gh-facts.mjs"]
  SER --> REQ["required-checks.mjs"]
  APPROVE["train-approve.mjs"] --> REQ
  COORD --> OBL["obligations.mjs"]
  OBL --> FACTS
  TRAIN["train.mjs"] --> UNION["union-merge.mjs"]
  RS --> UNION
  RS --> MERGED
```

### 2.1 Merged-work detection (Cluster 1, wine 1)

New `scripts/lib/fleet/merged-facts.mjs`, two INDEPENDENT signals, each with its
own provenance — never one inferred from the other's silence:

- **`listMergedPullRequests(cwd, {base, limit:100, env})`** — one
  `gh pr list --state merged --base <base> --limit 100 --json
  number,headRefName,headRefOid,mergedAt,mergeCommit,url` call →
  `{queried, complete, prs:[{number, headRef, headOid, mergedAt, mergeOid}]}`
  (`complete:false` at the limit). Fields recorded in the gh field fixture.
- **`squashMatches(cwd, {baseRev, patchIds, depth:200})`** — git-only, works with
  `gh` absent: `git log --first-parent -p -n 200 <base>` piped to
  `git patch-id --stable` gives `{commit → patchId}`; a branch whose existing
  whole-diff `patchId` (already computed by `gatherFacts`) equals one of them was
  squash-merged as that commit. Exactly the canonicalisation `patchId` already
  pins (`-c diff.noprefix=false …`) is reused so the two sides are comparable.

`mergedEvidenceFor(item)` (pure, in merged-facts) answers per branch:
`{merged:true, via:'pr'|'squash', pr?, commit, extraCommits}` when **(pr)** a
merged PR's `headRefOid` equals the branch tip, or the tip is an ancestor of
that `headRefOid`; or **(squash)** the patch-id matched. A branch with commits
AFTER the merged head is `{merged:'partially', extraCommits:n}` — work remains,
so it is never hidden and gets a `restack` obligation (2.5).

**Committed work merged ≠ session finished (audit H3).** Merged evidence speaks
only about COMMITTED history. A session is derived `done` only when BOTH hold:
`committedWorkMerged` (above) AND `workRemaining === false`, where
`workRemaining` comes from the worktree probe of 2.3 (clean, or no worktree at
all). A dirty worktree ⇒ state stays non-terminal, display `merged — worktree
has uncommitted changes`; an unprobed one (budget spent, probe failed) ⇒
`merged — worktree not inspected`, also non-terminal. Merged sessions are
therefore ALWAYS probe candidates (the probe set is "non-terminal OR
merged-evidence"), so a session cannot slip to terminal before its worktree is
read. An explicit `fleet release` stays a separate, human/session-initiated
transition that needs no such evidence.

Consumers (#5 single source of truth — one predicate, three readers):
- `deriveDone` gains `merged` + `workRemaining` inputs → `{done:true,
  note:'derived done (PR #N merged)'}` only under the rule above. Terminal ⇒
  excluded from overlaps and `landingOrder` by the existing `isTerminalState`
  filters, no new branch.
- `hideReason` gains `'landed'` for untracked branches (same evidence, and the
  existing clean-worktree precondition), counted as `N landed (squash)`.
- The derived state is derived on READ everywhere (status, claim, land); it is
  persisted when the session runs `fleet release`, which `next` tells it to
  do. (The plan first said mutating verbs would cache it; that would make
  `touch` silently end a session — dropped in implementation.) `status` stays
  write-free.

**Fact-acquisition profiles (audit H9).** Which facts a verb gathers is named,
not implied by `untracked:false`:

| Profile | Used by | Merged facts | Worktree probe | Base-advance facts |
|---|---|---|---|---|
| `status` | `status`, `land` | gh merged list + squash match for every analysed branch | every candidate (bounded) | — |
| `claim` | `claim`, `start` | gh merged list (one call) + squash match for the caller's branch | the caller's worktree AND every other live registered session's worktree (bounded by `CLEAN_PROBE`; over budget ⇒ that session's uncommitted evidence is `{queried:false}`, disclosed in the verdict as "uncommitted work not inspected for X") | the caller's branch only |
| `checkpoint` | `touch`, `ready`, `next`, `release` | gh merged list (one call) + squash match for the CALLER's branch only | the caller's worktree only | the caller's branch only |
| `minimal` | `hold`, `repair`, `directive` | not gathered (`{queried:false, reason:'not requested'}`) | — | — |

Base-advance facts (for the rebase obligation, 2.4) are git-only and need no
changed paths from `gh`: `git log --first-parent --name-only -z
--format=%x00%H%x00%s <mergeBase>..<base>` bounded to 500 commits → the
first-parent commits since my merge-base, each with its files and subject (the
`(#N)` suffix names the PR when present). Intersected with my changed files.
Over the bound ⇒ `{complete:false}` and the obligation reads "base advanced by
>500 commits; overlap not measured".

Bounded cost: `status` adds +1 `gh` call and +1 `git log -p | patch-id`;
`checkpoint` adds +1 `gh` call, one patch-id compare and one bounded `git log`.

### 2.2 Required checks must have RUN (Cluster 1, wine 7)

New `scripts/lib/fleet/required-checks.mjs`:

A head-bound contract (audit H5) — the verdict always names the head it is about
and the inventory it was checked against:

```
RequiredChecksResult = {
  headOid,                       // the PR head the observation is bound to
  inventory: { source: 'rules-api' | 'config' | 'unknown', names: string[] },
  observed: [{ name, bucket, completedAt }],
  complete: boolean, verdict, reason?
}
```

- **Inventory** (which checks are required) — asked, never inferred from what
  happened to run: `gh api repos/<o>/<r>/rules/branches/<base>` (rulesets apply
  to read-only tokens) → every `required_status_checks` rule's contexts; a
  `.fleet.json` `requiredChecks: [...]` list is unioned in (classic branch
  protection is not readable without admin, so a repo using it declares its
  checks there). Neither available ⇒ `inventory.source:'unknown'`. An EXPLICIT
  `requiredChecks: []` is the only way to assert "this repo requires none".
- **Observation** — `gh pr checks <n> -R <repo> --json
  name,state,bucket,completedAt` (all checks, not `--required`, so a required
  check that never appeared is detectable as MISSING rather than as absence).
  `gh` exits 1 (failure) or 8 (pending) WITH valid JSON on stdout, so stdout is
  parsed regardless of exit status. **Head binding**: `gh pr view --json
  headRefOid` immediately before AND after the checks call; unequal ⇒ `complete:
  false, verdict:'unknown', reason:'head moved during observation'`.
- **`requiredChecksVerdict(result)`** — the ONE predicate, over inventory ×
  observed: `pass` only if every inventory name is observed with
  `bucket === 'pass'`. A name observed as `skipping` → `not-run` (names it); a
  name never observed → `missing`; `pending` → `pending`; `fail`/`cancel` →
  `failed`; inventory `[]` from an explicit config → `none-required`; inventory
  `unknown` → `unknown`. **`SKIPPED` never satisfies a required check** — the
  #802 defect — and absence is never read as `none-required`.
- `summariseChecks` keeps its rollup semantics for display, but reports
  `skipped` as its own count (`checks:success (2 skipped)`) instead of folding it
  into success silently.
- pr-mode `approveTrain` (`verifyPrsForPlan`) adds per PR: `isDraft` → refuse
  ("mark ready, let CI run on the ready head, then approve");
  `requiredChecksVerdict` of `failed`/`not-run` → refuse naming the checks;
  `missing`/`pending`/`unknown` → the plan is emitted but each merge line carries
  `WAIT: required checks <verdict> (<names>) — do not merge until they pass`
  (the merge commands are printed for a human, and a just-pushed head registers
  its checks asynchronously, so absence at approval time is a precondition, not
  a refusal — the same reading serial uses).
- `status` warns on a PR that is a draft with `autoMergeRequest` set ("ready +
  auto-merge on a draft merges on draft-time results") and on one that is green,
  `mergeStateStatus: CLEAN`, auto-merge armed and unmerged for > 15 minutes
  ("auto-merge may be hung; re-arm: `gh pr merge <n> --auto`" — storyline 8).
  `autoMergeRequest` and `mergeStateStatus` join `PR_LIST_FIELDS` (both real list
  fields, already in the recorded fixture).

### 2.3 `release`, uncommitted evidence, `archive-check`, `--fetch` (Cluster 1)

- **`fleet release [--id] [--abandoned] [--note "…"]`** — under `fleet/.lock`
  writes the session `state:'done'` (or `'abandoned'`); both are EXISTING states,
  so no schema change. Prints the `archive-check` summary for the session's
  worktree as advisory (never refuses: releasing a claim loses nothing).
- **Uncommitted evidence (wine 3)** — new `scripts/lib/fleet/worktree-status.mjs`
  `porcelainPaths(path)` (`git status --porcelain=v1 -z --untracked-files=all`),
  bounded by the existing `CLEAN_PROBE` budget (per-call timeout, candidate cap,
  aggregate deadline; over budget ⇒ `{queried:false}`, never `[]`).
  `probeWorktreeCleanliness` is re-expressed on top of it (one probe, two
  readers). `gatherFacts` records `uncommitted[branch]` for every worktree-backed
  non-terminal item. The overlap join unions committed ∪ uncommitted files and
  tags an overlap `via:['uncommitted']` when the shared file is uncommitted on
  either side; rendered `overlaps X (uncommitted) on a.mjs`. In `decideClaim` an
  uncommitted-only overlap is **advisory** (`warn`), never `blocked`: uncommitted
  state is volatile and may be discarded — blocking on it would cry wolf.
- **`fleet archive-check <id|branch|path> [--min-kb 256]`** (storyline 2) —
  read-only. ONE verdict over every way removing the worktree loses work (audit
  H2):

  | Loss class | Probe |
  |---|---|
  | staged changes (incl. staged deletions) | porcelain `X` column ≠ ` ` |
  | unstaged tracked changes (incl. deletions) | porcelain `Y` column ≠ ` ` |
  | untracked files | `??` entries |
  | gitignored files not matching `archiveIgnore` | `!!` entries (`--ignored=matching`) |
  | unpushed commits | `git rev-list <branch> --not --remotes` |
  | stash entries made in this worktree | not detectable per worktree — always listed as a reminder line, never part of the verdict |

  `archiveIgnore` (`.fleet.json`, default `["node_modules/**",
  "scripts/.claude-skills/**"]` — regenerable trees) removes ignored entries
  only, never tracked or untracked-unignored ones. **`--min-kb` is display-only**:
  every at-risk path counts toward the verdict; entries under the threshold are
  summarised (`+N smaller files`). Exit **0** only when every probe ran and found
  nothing; **3** when something would be lost (`AT RISK`); **3** with verdict
  `UNVERIFIED` when any probe failed or its budget ran out (the size walk, the
  porcelain call, rev-list) — an incomplete inspection is never "clean". Also
  prints the open PR, the session's `waitingOn`, and a fixed **"what do you still
  owe?"** checklist (participant rule 7's report fields).
- **`status --fetch`** (wine 4 remainder) — `git fetch --no-tags <remote>
  <base>` before gathering; a failed fetch is a printed warning and the run
  continues on the last fetch (never fatal, never silent).

### 2.4 A coordination channel that needs no host messaging (Cluster 2)

**Directives** — new record kind under `fleet/directives/` (old readers never
open it), `scripts/lib/fleet/directives.mjs`:

```
DirectiveSchema (v1) = strict {
  schemaVersion: 1, id: "d-<14 digits>-<4 hex>", to: <session id> | "all",
  kind: "pause" | "resume" | "rebase" | "release" | "rerun-ready",
  reason: { kind: "pr-merged" | "hold" | "train" | "note", ref?: string, note?: string },  // ref required except for kind "note"
  by: string, createdAt: iso, expiresAt: iso,
  acks: [{ session: id, at: iso, outcome: "done" | "declined", note?: string }]
}
```

- **Closed vocabulary** (#13): there is no `merge`, `push`, `override`, `delete`
  kind, so a directive can never carry the actions only the user may authorise.
  The schema is the boundary, not prose. `by` is attribution, never
  authentication.
- **Verified = corroborated, never "the cited record exists" (audit H4).** A
  directive is `VERIFIED` for a recipient only when fleet INDEPENDENTLY derives
  the same action for THAT recipient from current facts (the obligations of
  2.4 below). A directive therefore adds attention, never authority. Per kind:

  | Kind | VERIFIED for recipient R only when |
  |---|---|
  | `release` | R's own `committedWorkMerged` holds (the cited PR's head is R's branch tip or an ancestor of it) — a release citing an unrelated PR is UNVERIFIED |
  | `rebase` | R's branch is behind the base AND the base-advance facts show first-parent commits since R's merge-base touching R's files (the cited PR, when given, must be among them) |
  | `pause` | `reason` is `hold:<at>` and the CURRENT hold is ON with exactly that `at` (bound to one hold event; a later hold transition supersedes it) |
  | `resume` | `reason` is `hold:<at>` and the CURRENT hold is OFF with exactly that `at` |
  | `rerun-ready` | R is `ready (stale — head moved)` |

  Everything else — `note:` reasons, a `to:'all'` directive whose condition holds
  for some recipients but not R — renders `UNVERIFIED for R — ask the user`.
  **Facts outrank directives**: a `resume` while the hold is still on, or a
  `pause` after the hold was released, is shown as `superseded by current
  state`, never actionable.
- **Command grammar (audit M1)** — all under `fleet directive`, `assertKnownFlags`
  per mode, exactly one mode per call:
  - `directive --to <id|all> --kind <kind> --reason <pr-merged|hold|train|note>
    [--ref <ref>] [--note "…"] [--expires-hours 24]` → creates; prints the id
    and, per current recipient, whether it is verified now. Kind, reference and
    note are SEPARATE flags (audit R3-M1) — a hold reference is an ISO timestamp
    and a note may contain colons, so no single colon-joined string can carry
    them. `--reason hold` without `--ref` resolves to the current hold's `at`
    inside the transaction. Exit 0; 2 on a bad kind/reason/ref (e.g. a `hold`
    ref that is not an ISO time, a `pr-merged` ref that is not `#<n>`); 3 when
    `--to` names no live session.
  - `directive --list [--all]` → active directives (`--all` adds archived);
    `--json` shape `{active:[…], unsupported:[…], complete}`.
  - `directive --ack <id> --outcome done|declined [--note "…"]` → appends the
    caller's ack. A session acks `done` AFTER it has performed the action, and
    `declined` (with a note) when it asked the user and was told no. An ack is
    per recipient; acking twice is a no-op, not an error.
  - Kind → the command a session runs: `pause`→ stop heavy runs/pushes until the
    hold clears; `resume`→ continue; `rebase`→ `fleet restack <branch>`;
    `release`→ `fleet archive-check` then `fleet release`; `rerun-ready`→ re-test
    then `fleet ready`. The kind never names anything beyond its row.
- **Storage and bounded reads (audit M2)**: `fleet/directives/active/` holds
  unexpired directives with outstanding acks; any mutating directive call (and
  `release`) moves expired or fully-acked records to
  `fleet/directives/archive/<yyyy-mm>/` under `fleet/.lock` — moved, never
  deleted. Checkpoint reads list only `active/`, capped at 200 records; over the
  cap ⇒ `directives: {complete:false}` and `next` says "directives not fully
  read", never "no directives". History is `directive --list --all`.
- **Record evolution (audit M3)**: every new record family (`directives`,
  `hosts`, `serial`) dispatches on `schemaVersion` — a version this reader does
  not know, or a v1 directive whose `kind` it does not know, is collected as
  `unsupported` (listed by `directive --list`, counted in status, NEVER
  actionable, NEVER verified) and **never makes the session registry
  incomplete**. A mutating verb never rewrites an unsupported record. So the
  next release can add a kind without breaking this one, and a mixed-version
  fleet degrades to "visible, not actionable".
- Writes go through `transact` (same `fleet/.lock`).
- **Hold events are identified by `at`** (audit R2-M1). Today `hold off` writes
  `at: null`; it will write the off time (`at` is already `nullable(Iso)` in the
  strict `HoldSchema`, so old readers accept it). `hold on|off` and its
  directive share ONE transaction and ONE timestamp: `hold on` with `--notify`
  posts `pause` with `reason: hold:<at>`; `hold off --note "…"` posts `resume`
  with `reason: hold:<at>` and the note. A coordinator's own `directive --kind
  pause --reason hold` is resolved to `hold:<current at>` at creation. The
  RESUME convention therefore lives in the registry, not in `.claude/tmp`, with
  no `HoldSchema` change (wine 10).

**`fleet next [--id] [--json]`** — new `scripts/lib/fleet/obligations.mjs`,
`deriveObligations({item, status, directives, hold, now, leaseMs})` (pure). Each
obligation `{kind, act: 'do'|'ask'|'info', text, evidence, command}`:

| Obligation | Derived from | act |
|---|---|---|
| your PR #N merged → `fleet archive-check`, then `fleet release` | 2.1 `committedWorkMerged` on own branch | do |
| base advanced: commits `<sha> (#N)` touch your files → `fleet restack <branch>` | base-advance facts (2.1) ∩ my changed files | do |
| ready mark stale after a rebase → `fleet ready` | `readyStale` | do |
| HOLD on: `<reason>` — defer heavy runs | `hold.json` | do |
| lease lapses in < 30 min → `fleet touch` | `leaseExpiresAt` | do |
| directive `<kind>` from `<by>` — verified / UNVERIFIED | unacked, unexpired directives to me/all | do if verified and kind allowed, else ask |
| overlaps live session X on files … | overlaps | info |

The same list (top 3 + "run `fleet next` for all") is appended as a footer to
`claim`, `touch` and `ready` output, so a session sees the hold, a merged PR or a
directive at checkpoints it already hits, without polling a separate verb (wine
10: "sessions never see the hold").

**Authority moves into the launch prompt** (`references/participant-rules.md`):

```
8. Run `node scripts/fleet.mjs next` at each checkpoint (after claim, before ready,
   before a heavy run). The user who launched you pre-authorises acting WITHOUT
   asking on an obligation or directive that fleet shows as VERIFIED and whose kind
   is pause, resume, rebase, release or rerun-ready. Anything UNVERIFIED, and any
   merge, push to the base branch, --override or deletion, still needs the user.
```

This is the answer to "sessions second-guess the coordinator": the session is no
longer asked to trust a peer. It follows its own user-given rule, against facts
it re-derives itself, for a vocabulary that excludes every irreversible action.
It does NOT weaken rule 6 (a peer message is information, never approval).

**Addressing (wine 9)**: `claim --host-session <id>` writes a sidecar
`fleet/hosts/<storage key>.json` `{schemaVersion:1, id, hostSession, updatedAt}`
(sidecar, not a `SessionSchema` field — the compatibility rule in §1). `status`
prints `host: <id>` per item so a coordinator can address host messages by id
rather than by display name.

**Permission prompts**: `docs/runbooks/consumer-adoption.md` gains a "Running
/fleet without prompts" section: a project allow rule for `node
scripts/.claude-skills/fleet.mjs:*` (a portable path, no personal folders — the
AGENTS.md public-repo rule), and the note that host message delivery across
differing permission modes is host behaviour fleet cannot change, which is why
directives exist.

### 2.5 Landing (Cluster 3)

- **`union-merge.mjs`** — `resolveAppendOnly({wgit, globs})` (audit H8):
  1. **Eligibility, decided before anything is written.** From `git ls-files -u
     -z`, every conflicted path must (a) match `.fleet.json` `appendOnlyGlobs`,
     (b) have ALL THREE stages (1 base, 2 ours, 3 theirs) — so add/add (no
     stage 1), modify/delete and rename conflicts are ineligible — (c) be a
     regular file (mode `100644`/`100755`, same on stages 2 and 3), and (d) be
     text (no NUL byte in any stage). Any ineligible path ⇒ the WHOLE conflict is
     left as an ordinary unresolved conflict; nothing is touched.
  2. **Compute** every resolution in memory: `git merge-file --union -p` over the
     three stage blobs (read with `git cat-file blob :N:path`), no write yet.
  3. **Write + stage** all results (`git add`). This happens ONLY inside a
     throwaway worktree (train or restack); if any write or `git add` fails, the
     caller abandons that worktree (the train records `conflict`; restack aborts
     and removes it), so there is no partially resolved state anywhere a user
     can see.
  Used by **direct-mode trains**
  (fleet pushes the candidate, so the union result is what lands) and by
  **restack**. In **pr mode** a train does NOT auto-resolve: GitHub would still
  report the conflict, so the train stops `conflict` with
  `append-only conflict — restack <id> after <prev> lands` (honest, not hidden).
  Every resolution is disclosed in the train's existing `notes` array (no
  `TrainSchema` change).
- **Land-phase checks run in the candidate** (storyline 5): `finishTrain`
  provisions dependencies first, then runs `.fleet.json` checks with `cwd =
  t.worktree`, so a guard committed by branch A runs against branch B's change in
  the combined tree. `checkScriptHash` already resolves the script inside its
  `cwd`, so a script that exists only on one branch is found in the combined tree
  and nowhere else.
- **`fleet restack <branch> [--onto <ref>] [--from <oid>] [--replace]`**
  (`scripts/lib/fleet/restack.mjs`, storyline 3):
  Three separated stages — construct, validate, publish (audit H7):
  1. **Inputs.** `onto` defaults to the measured base (`resolveMeasurementBase`);
     `from` defaults to the newest merged-PR head (2.1) that is an ancestor of
     the branch — the parent a stacked branch was built on — else
     `merge-base(onto, branch)`. The branch tip is read once here as `oldTip`.
  2. **Construct** in a throwaway worktree at `onto` (same pattern and cleanup as
     the train worktree), with the train's empty `core.hooksPath` so no
     consumer hook runs — cherry-pick has no `--no-verify` (audit H1):
     `git -c core.hooksPath=<empty> cherry-pick <from>..<oldTip>`. Merge commits
     in the range ⇒ refuse before starting, naming them. A conflict whose files
     are all eligible for union resolution (below) is resolved and the pick
     continued (`cherry-pick --continue`, `GIT_EDITOR=true`); any other conflict
     ⇒ `cherry-pick --abort`, the worktree is removed, exit 3 naming the commit
     and files — never a half state.
  3. **Validate**: patch-id of `from..oldTip` vs `onto..candidate`, both with
     `:(exclude)` pathspecs for `.fleet.json` `restackIgnore` (default `[]`;
     storyline sets `docs/**`).
  4. **Publish**, by outcome:
     - patch EQUAL, no `--replace` → create `<branch>-restack` at the candidate
       (`git update-ref refs/heads/<branch>-restack <candidate> ""` — the empty
       old value refuses if it already exists).
     - patch DIFFERS → ONLY the diagnostic branch `<branch>-restack-mismatch` is
       created, with the differing files listed; exit 3. **`--replace` is
       ignored on a mismatch** — the source branch is never replaced by an
       unvalidated candidate.
     - patch EQUAL + `--replace`, branch NOT checked out in any worktree →
       ONE operation: `git update-ref refs/heads/<branch> <candidate> <oldTip>`
       (compare-and-swap; a moved tip refuses).
     - patch EQUAL + `--replace`, branch CHECKED OUT in some worktree → fleet does
       NOT move it (audit R2-H3: `git reset` takes no expected-old value, so a
       check-then-reset is not atomic). It publishes `<branch>-restack` as in the
       first case and prints the one command the owning session runs in its own
       worktree when it chooses to adopt it (`git reset --keep
       <branch>-restack`), plus the push command. fleet moves a ref only through
       `update-ref` with an expected old value.
     Recovery: every path publishes with a single compare-and-swap ref command,
     so there is no partial publication to roll back; on any failure the result
     prints the candidate oid and `oldTip`. Never force-pushes.
- **`land --approve <trainId> --serial`** (`scripts/lib/fleet/serial.mjs`, wine 8
  + storyline 8) — pr mode only; the human approval is the same `--approve` and
  covers the whole sequence. Progress lives in a NEW file
  `fleet/serial/<trainId>.json` (strict `SerialRunSchema`: per source
  `{id, prNumber, testedOid, step, updatedOid, checks, mergedOid, at}`), so
  `TrainSchema` and old readers are untouched.

  **Exclusion (audit H6).** The run holds a per-train lease file
  `fleet/serial/<trainId>.lock` (pid + host + start, the same lock primitive as
  `trains/.lock`) for its whole duration; a second `--approve`/`--resume` of the
  same train is refused while the holder is alive. Each manifest transition is a
  short `withTrainLock` critical section, so the long waits never hold the
  fleet-wide `trains/.lock` and other trains stay landable.

  **Preflight**: every PR's `requiredChecksVerdict` inventory must be known
  (`rules-api` or `config`); `unknown` ⇒ refuse before merging anything, naming
  the `.fleet.json` `requiredChecks` remedy. A verified `none-required` is
  allowed (the wait step then passes immediately).

  Per PR, in landing order, each step persisted as an INTENT before the remote
  call and as a RESULT after it:
  1. **verify**: open, not draft, base ref = destination, and the head is one of
     the heads this run can account for (below). Anything else ⇒ stop: someone
     pushed. `mergeStateStatus: DIRTY` (the base now conflicts) ⇒ stop at once
     with `fleet restack <branch>` as the remedy (Gemini G2) — never proceed to a
     merge that cannot succeed.
  2. **update** (only when `mergeStateStatus` is `BEHIND`): persist
     `{step:'update', priorHead, baseOid}`; then call
     `gh api -X PUT repos/<o>/<r>/pulls/<n>/update-branch -f
     expected_head_sha=<priorHead>` (GitHub refuses if the head moved — the
     expected-head guard `gh pr update-branch` lacks). A 422 (merge conflict)
     ⇒ stop with the restack remedy. The endpoint answers `202 Accepted` and
     builds the merge commit in the background (Gemini G1), so fleet then POLLS
     `gh pr view` every 2 s for up to 60 s until the head differs from
     `priorHead`; still unchanged ⇒ stop resumable as `update not yet visible`.
     Persist `updatedOid`.
     **Objects first (audit R3-H1).** GitHub creates the updated head remotely,
     so before any recovery check: read the PR head H via `gh pr view`; `git
     fetch --no-tags <destination remote> +refs/pull/<n>/head:refs/fleet/pr/<n>
     +refs/heads/<base>:refs/fleet/serial/base`; require `refs/fleet/pr/<n>` ==
     H (else re-read — the same bounded 60 s poll — then stop resumable); require H, both its
     parents and the base tip to resolve locally. A shallow clone
     (`rev-parse --is-shallow-repository`) is refused at serial PREFLIGHT, so
     missing ancestry never masquerades as foreign content. A fetch or
     resolution failure stops the run as `could not verify (acquisition)` —
     resumable, never UNACCOUNTED.
     **Resume recognises its own update** by ancestry AND content (audit R2-H4):
     a current head H is accepted as this run's update iff (a) H has exactly two
     parents, (b) the first is the persisted `priorHead`, (c) the second is an
     ancestor of the current base, and (d) H's tree equals the tree of a clean,
     reproducible merge of those two parents (`git merge-tree --write-tree
     <priorHead> <parent2>`, git ≥ 2.38). A tree mismatch (foreign content in the
     merge itself), a merge-tree conflict, or a git too old for `merge-tree
     --write-tree` ⇒ the head is UNACCOUNTED: stop and require a fresh
     `--approve`. A conflicting update ⇒ stop with `fleet restack <branch>` as the
     remedy.
  3. **wait**: poll `requiredChecksVerdict` on the persisted current head every
     30 s; the result is accepted only when its `headOid` equals that head (head
     binding, 2.2). `pass`/`none-required` → proceed; `failed`/`not-run` (a
     conclusive skip) → stop at once; `missing` and `pending` → KEEP POLLING —
     GitHub registers a new head's workflows asynchronously, so a just-updated
     head legitimately shows its required checks as missing at first (audit
     R2-H2). `serialTimeoutMs` (default 60 min, `.fleet.json`) ⇒ stop, resumable,
     naming every required check still missing or pending; a check that never
     registered is reported as `never registered on <head>`, and missing checks
     never permit a merge.
  4. **merge**: re-verify the head once more, persist `{step:'merge', head}`,
     then `gh pr merge <n> --squash --match-head-commit <head>` (GitHub refuses a
     moved head).
  5. **observe**: `gh pr view` until `MERGED` (≤ 2 min) and record `mergedOid`;
     green + `CLEAN` + unmerged after that ⇒ stop as "merge did not take — check
     branch rules".
  `land --resume <trainId>` re-enters at the persisted step: a `merge` intent
  whose PR is already `MERGED` is observed, never re-merged. The train reaches
  `landed` only when every PR is observed merged; the result states plainly that
  serial lands each PR at a head CI tested on GitHub, which may differ from the
  locally tested train candidate.

### 2.6 Principles that drove the decisions

- **#5 Single source of truth**: one merged predicate (`mergedEvidenceFor`), one
  required-checks predicate (`requiredChecksVerdict`), one porcelain probe — each
  read by status, claim, next, restack and serial rather than re-derived.
- **#13 Validation / #15 Error handling**: closed directive vocabulary in the
  schema; every unqueried source stays `{queried:false, reason}`; `skipping` is
  never success.
- **#14 Idempotency / transaction safety**: serial writes each step before acting
  and resumes from it; restack is all-or-nothing in a throwaway worktree and
  moves a ref only by compare-and-swap.
- **#18 Backward compatibility**: no existing record schema changes; new data in
  new directories, so a mixed-version fleet keeps working.
- **#16 Graceful degradation**: `gh` absent ⇒ squash detection still works by
  patch-id; required checks render `unknown`, never pass.

## 6. Sustainability Notes

- **Assumption: GitHub.** Merged-PR, required-check and serial landing are `gh`
  facts; a non-GitHub remote degrades to `not queried` everywhere, and squash
  detection keeps working offline.
- **Assumption: squash-merge.** Patch-id matching detects squash merges; true
  merge commits are already caught by ancestry (`ahead 0`). Rebase-merges
  produce per-commit patch-ids — covered by `git cherry` semantics only partly;
  stated as a limit in the reference doc.
- **Extension points**: a new directive kind is one enum value + one row in the
  obligations table + one participant-rule word; a new obligation is one pure
  rule in `obligations.mjs`.

## 7. File-Level Plan

All modules are ESM under `scripts/lib/fleet/`, return plain data, never throw
across the CLI boundary, and keep stdout clean (`process.stderr.write` for
progress). `overlap.mjs` (773 lines) stays well under the size-ratchet threshold;
new logic goes in new modules, not into it.

| File | Intent | Purpose |
|---|---|---|
| `scripts/lib/fleet/merged-facts.mjs` | create | merged-PR listing, squash patch-id matching, `mergedEvidenceFor` |
| `scripts/lib/fleet/required-checks.mjs` | create | `gh pr checks --required` + `requiredChecksVerdict` |
| `scripts/lib/fleet/worktree-status.mjs` | create | bounded porcelain probe (paths, ignored, sizes) |
| `scripts/lib/fleet/lifecycle.mjs` | create | `release`, `archive-check` verbs |
| `scripts/lib/fleet/directives.mjs` | create | directive schema, read/write/ack, reason verification |
| `scripts/lib/fleet/obligations.mjs` | create | `deriveObligations` (pure) |
| `scripts/lib/fleet/coordination.mjs` | create | `next`, `directive` verbs, checkpoint footer |
| `scripts/lib/fleet/union-merge.mjs` | create | all-or-nothing append-only conflict resolution |
| `scripts/lib/fleet/restack.mjs` | create | `restack` verb |
| `scripts/lib/fleet/serial.mjs` | create | serial pr landing, schema, resume |
| `scripts/lib/fleet/gh-facts.mjs` | modify | fields, skipped count, hang/draft warnings data |
| `scripts/lib/fleet/facts.mjs` | modify | gather merged / uncommitted / directives / hosts |
| `scripts/lib/fleet/overlap.mjs` | modify | `deriveDone` merged input, `hideReason` landed, uncommitted overlaps, advisory claim |
| `scripts/lib/fleet/render.mjs` | modify | landed/uncommitted/host/directive/warning lines |
| `scripts/lib/fleet/render-train.mjs` | modify | required-check lines in pr plan, serial results |
| `scripts/lib/fleet/commands.mjs` | modify | footer on claim/touch/ready, `--host-session`, `hold off --note`, `status --fetch` |
| `scripts/lib/fleet/config.mjs` | modify | `appendOnlyGlobs`, `restackIgnore`, `archiveIgnore`, `serialTimeoutMs`, `requiredChecks` |
| `scripts/lib/fleet/train.mjs` | modify | union resolution in direct modes, checks after provisioning in the candidate |
| `scripts/lib/fleet/train-approve.mjs` | modify | draft + required-checks gate in pr plan; `--serial` dispatch |
| `scripts/lib/fleet/land.mjs` | modify | `--serial` flag routing |
| `scripts/lib/fleet/argv.mjs` | modify | new verbs and flags |
| `scripts/fleet.mjs` | modify | dispatch new verbs |
| `tests/fixtures/fleet/gh-pr-view-fields.json` | modify | record `gh pr checks --json` fields |
| `tests/helpers/fleet-repo.mjs` | modify | fake `gh`: `pr list --state merged`, `pr checks` (exit 1/8 with JSON), `api` rules + update-branch, `pr merge` |

### 7b. Implementation Phases

**Phase 1 — Merged-work detection**: merged-PR listing + squash patch-id matching, `deriveDone`/`hideReason`/landing order consume it, persisted by mutating verbs. Files: scripts/lib/fleet/merged-facts.mjs (create), scripts/lib/fleet/gh-facts.mjs (modify), scripts/lib/fleet/facts.mjs (modify), scripts/lib/fleet/overlap.mjs (modify), scripts/lib/fleet/train-approve.mjs (modify), scripts/lib/fleet/render.mjs (modify), tests/fleet-merged-facts.test.mjs (create), tests/fixtures/fleet/gh-pr-view-fields.json (modify), tests/helpers/fleet-repo.mjs (modify)

**Phase 2 — Required checks actually ran**: `requiredChecksVerdict`, skipped count, draft/auto-merge/hang warnings, pr-plan gate. Files: scripts/lib/fleet/required-checks.mjs (create), scripts/lib/fleet/render-train.mjs (modify), tests/fleet-required-checks.test.mjs (create), scripts/lib/fleet/config.mjs (modify)

**Phase 3 — Session lifecycle + uncommitted evidence**: `release`, `archive-check`, porcelain paths in overlaps, `status --fetch`. Files: scripts/lib/fleet/worktree-status.mjs (create), scripts/lib/fleet/lifecycle.mjs (create), scripts/lib/fleet/commands.mjs (modify), scripts/lib/fleet/config.mjs (modify), scripts/lib/fleet/argv.mjs (modify), scripts/fleet.mjs (modify), tests/fleet-lifecycle.test.mjs (create)

**Phase 4 — Directive records + host sidecar**: schema, read/write/ack under the registry lock, `hosts/` sidecar. Files: scripts/lib/fleet/directives.mjs (create), tests/fleet-directives.test.mjs (create) (registry.mjs already exports `assertManaged`/`storageKey`/`TRAIN_ID_RE`, so it needs no change)

**Phase 5 — `next` + checkpoint footer**: `deriveObligations`, `next`/`directive` verbs, footer on claim/touch/ready, `hold off --note`, `claim --host-session`, status lines. Files: scripts/lib/fleet/obligations.mjs (create), scripts/lib/fleet/coordination.mjs (create), tests/fleet-coordination.test.mjs (create)

**Phase 6 — Coordination docs**: participant authority clause, SKILL.md usage, coordination reference, adoption permission note. Files: skills/fleet/references/participant-rules.md (modify), skills/fleet/references/coordination.md (create), skills/fleet/SKILL.md (modify), docs/runbooks/consumer-adoption.md (modify)

**Phase 7 — Union merge + checks in the candidate**: append-only resolution in direct-mode trains, pr-mode honest stop, checks after provisioning with cwd = candidate. Files: scripts/lib/fleet/union-merge.mjs (create), scripts/lib/fleet/train.mjs (modify), tests/fleet-union-merge.test.mjs (create)

**Phase 8 — Restack**: `restack` verb. Files: scripts/lib/fleet/restack.mjs (create), tests/fleet-restack.test.mjs (create)

**Phase 9 — Serial landing**: `land --approve --serial`, serial manifest, resume, hang detection. Files: scripts/lib/fleet/serial.mjs (create), scripts/lib/fleet/land.mjs (modify), tests/fleet-serial.test.mjs (create)

**Phase 10 — Landing docs**: Files: skills/fleet/references/landing.md (create)

**Close-out (not a phase)**: `npm run skills:regenerate` · `npm run skills:check` · `npm run plans:index` · `npm run size:ratchet:gate` · full `npm test`.

## 8. Risk & Trade-off Register

- **Serial mode lands heads that differ from the tested train candidate.** That
  is inherent to strict "up to date" rules (GitHub merges the updated head) and
  is stated in the result; the safeguard is that each updated head must pass its
  REQUIRED checks on GitHub before fleet merges it.
- **A blocking CLI for up to `serialTimeoutMs` per PR.** Mitigated by writing
  each step first and `--resume`; an interrupted run loses nothing.
- **Patch-id squash detection misses a squash whose conflict resolution changed
  the diff.** Then the gh signal (head oid) still matches; with `gh` absent the
  branch stays visible — the safe direction.
- **Uncommitted overlaps are volatile.** Advisory only, never blocking.
- **Directive authority could be abused by a hostile peer.** The vocabulary
  cannot express merge/push/delete; unverifiable reasons always route to the
  user; acting on a verified `rebase` produces a new local branch, nothing more.
- **Deferred (true scope boundaries, not difficulty):** host load / CI-idle /
  `run-when-idle` / slots / RAM / Windows Update (storyline 1, 7 — machine-
  and runner-specific; a later plan can add a slot primitive on top of
  directives); reservations (storyline 6 — a new record kind of its own);
  permission modes, duplicate peer titles and message delivery (host app, not
  reachable from a CLI); an audit-coverage gate (belongs to `/audit-code`);
  worktree compliance (wine 11 — a consumer `.fleet.json` check, which the
  checks-in-candidate change now makes more useful).

## 9. Testing Strategy

Tier 1 (deterministic, test-first where pure): every new predicate is pure and
unit-tested — `mergedEvidenceFor`, `requiredChecksVerdict`, `deriveObligations`,
directive schema + reason verification, union-merge all-or-nothing, serial step
machine (with injected `gh`/`git` deps, as `train-approve` tests already do).

Integration on real temp repos (the existing fleet test pattern, fake `gh` via
`ghBin`/`deps.gh`):
- a branch squash-merged into base → hidden as `landed`; a registered session →
  `done` with the PR note; neither in `landingOrder`; a branch with extra commits
  after the merge stays visible with a restack obligation.
- `gh pr checks` fixture with `bucket:'skipping'` on a required check → pr plan
  refuses naming it; `pending` → WAIT line; exit 1/8 with JSON parsed.
- uncommitted edit in worktree A to a file branch B committed → overlap tagged
  `uncommitted`; a claim over it → `warn`, not `blocked`.
- `archive-check` on a worktree with an ignored 1 MB file and an unpushed
  commit → exit 3 listing both; `node_modules` ignored; clean → exit 0.
- directive to `all` with `pr-merged:#N` → `verified:true` when the merged fixture
  has #N, `false` otherwise; `note:` always UNVERIFIED; ack is append-only.
- an OLD-schema reader (current `readSessions`/`listTrains`) over a registry
  containing `directives/`, `hosts/`, `serial/` → still `complete:true` (the
  compatibility rule, asserted, not assumed).
- restack: stacked branch after parent squash → new branch, patch-id equal; a
  real conflict → aborted, worktree gone, exit 3; append-only conflict →
  resolved with both sides present.
- serial: three PRs, the second BEHIND → update-branch called, waits on pending
  then pass, merges with `--match-head-commit <updated>`; interrupted after
  PR 1 → `--resume` does not re-merge PR 1.
- land-phase check that exists only on train branch A blocks branch B's change.

Added by the round-1 plan audit:
- merged PR + DIRTY worktree → not done (`merged — worktree has uncommitted
  changes`); unprobed → not done; clean → done (H3).
- checkpoint profile: `touch` with no prior `status` surfaces "your PR merged"
  and a base-advance rebase obligation from git facts alone (H9).
- directive `release` to R citing a merged PR that is NOT R's → UNVERIFIED;
  `resume` while hold on → superseded; `to:'all'` verified for one recipient,
  unverified for another (H4); unknown kind / schemaVersion 2 record → listed
  unsupported, registry still complete, never actionable (M3); 201 active records
  → `complete:false` (M2).
- required checks: inventory from a rules-API fixture; a required check never
  observed → `missing`; head moved between the two `pr view` reads →
  `unknown`; config `requiredChecks: []` → `none-required`; no inventory →
  serial preflight refuses (H5).
- serial: crash after update-branch but before `updatedOid` persisted → resume
  accepts the merge-of-base head by parentage and rejects a head with a foreign
  commit; a second concurrent `--resume` refused by the per-train lease (H6).
- restack: mismatch + `--replace` → only `-restack-mismatch` written, source
  untouched; checked-out replace with a moved tip refuses; hooks never run (H1,
  H7).
- union merge: add/add, modify/delete, binary, mode-mismatch → left as ordinary
  conflict with zero files changed (H8).
- archive-check: staged deletion only → AT RISK; porcelain failure → UNVERIFIED
  exit 3; a 10-byte untracked file still counts (H2).

Added by the round-2 plan audit:
- a clean caller claims `x` while live session A has `x` modified but
  uncommitted → `warn` naming A (claim profile probes A); A's probe over budget
  → the verdict says "uncommitted work not inspected for A" (R2-H1).
- serial: new head → `missing` → `pending` → `pass` merges; a check that never
  registers stops at the deadline as `never registered` (R2-H2).
- restack `--replace` on a checked-out branch → only `<branch>-restack` written,
  source ref unchanged (R2-H3).
- serial recovery: a two-parent head with the right parents but an extra file in
  its tree → UNACCOUNTED, stop (R2-H4).
- `hold off --note` → `resume` directive verified; a later `hold on` makes it
  superseded (R2-M1).

Negative controls: each new gate gets one test proving it does NOT fire on the
healthy case (a passing required check, a clean worktree, a non-overlapping
merged PR).

## 10. Plan audit trail

- GPT plan audit, 3 rounds (cap): R1 H:9 M:3 → R2 H:4 M:1 → R3 H:1 M:1; every
  finding accepted and folded in (acceptance 100% each round — productive, not
  rigor pressure). Stopped at the 3-round default cap; R3's two findings were
  implementation-level (object acquisition before recovery; flag encoding).
- Gemini final gate, round 1: `approve_with_debt` (blocking 0, debt 3). All
  three folded into the plan instead of carried as debt: G1 update-branch is
  asynchronous (bounded poll), G2 `DIRTY` stops serial with the restack remedy,
  G3 `reason.ref` optional for `note`.

## 11. Execution Clustering

- **Cluster 1** — Phases 1-3 — fix-gate: yes
  - Coupling: all three change what `gatherFacts`/`buildStatus` report about a single session (merged, checks, uncommitted, released); the wiring pass must see the status join with all new evidence at once.
  - Additional files: scripts/lib/fleet/git-facts.mjs (modify — shared canonical-diff constants for both patch-id producers), scripts/lib/fleet/land.mjs (modify — passes `requiredChecks` to approval), tests/fleet-cli.test.mjs (modify — field-contract test knows `pr checks` fields), tests/fleet-capstone-feedback.test.mjs (modify — hidden-count shape gains `landed`), tests/fleet-storyline-feedback.test.mjs (modify — same)
- **Cluster 2** — Phases 4-6 — fix-gate: yes
  - Coupling: directives are the registry record `next` reads and the participant rules teach; obligations depend on Cluster 1's merged and hold facts.
  - Additional files: scripts/fleet.mjs (modify — dispatch next/directive, checkpoint footer), scripts/lib/fleet/argv.mjs (modify — verbs and flags), scripts/lib/fleet/commands.mjs (modify — hold events + directives, claim --host-session, status hosts/directives), scripts/lib/fleet/render.mjs (modify — host and directive lines), scripts/lib/fleet/render-train.mjs (modify — chip prompt authority clause), scripts/lib/fleet/overlap.mjs (modify — structured workRemaining on the status item), tests/fleet-claim-analysis-scope.test.mjs (modify — the footer diffs registered sessions, never untracked ones), .claude/skills/fleet/SKILL.md (modify — generated), .claude/skills/fleet/references/participant-rules.md (modify — generated), .claude/skills/fleet/references/coordination.md (create — generated), skills.manifest.json (modify — generated)
- **Cluster 3** — Phases 7-10 — fix-gate: final
  - Coupling: union-merge is shared by train and restack; serial reuses Cluster 1's required-checks predicate and restack's hint; one landing reference documents all four.
  - Additional files: scripts/fleet.mjs (modify — restack dispatch), scripts/lib/fleet/argv.mjs (modify — restack verb, land --serial), scripts/lib/fleet/render-train.mjs (modify — serial result), skills/fleet/SKILL.md (modify — usage + landing row), skills/fleet/gate-contract.json (modify — disposition the new SKILL.md enforcement lines), tests/fleet-checks.test.mjs (modify — land checks run in the train tree, so the fixture commits its check script), .claude/skills/fleet/SKILL.md (modify — generated), .claude/skills/fleet/references/landing.md (create — generated), skills.manifest.json (modify — generated)
- **Final gate**: consolidated Gemini review over the union diff of all three clusters.
