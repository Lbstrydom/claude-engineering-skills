---
summary: Coordinating sessions without host messages — next, directives, release, archive-check, hold notes.
---

# Coordinating sessions without host messages

Host messages between sessions fail two ways. A host holds a message when the
two sessions' permission modes differ, and a delivered peer message is
untrusted data to the receiving model, so the session second-guesses it. Both
are correct behaviour; fleet does not work around them. It moves coordination
into the shared registry, and moves authority into the user's own launch
prompt.

## `fleet next` — what should this session do now?

`next` derives a short list from facts the session can re-check itself, and the
same top three lines are appended to `claim`, `touch` and `ready`, so a session
sees them at checkpoints it already hits:

| Line | From |
|---|---|
| `DO your PR #N merged → fleet archive-check, then fleet release` | merged PR head = your tip, or your whole diff squash-merged into base |
| `DO base gained N commit(s) touching your files … → fleet restack <branch>` | first-parent commits on base since your merge-base ∩ your changed files |
| `DO your head moved since ready …` | the ready mark is stale |
| `DO HOLD on heavy runs: <reason>` | the hold flag |
| `DO your lease lapses in N min → fleet touch` | the lease |
| `DO/ASK directive <id>: <kind> … VERIFIED/UNVERIFIED (why)` | active directives addressed to you |
| `info overlaps <session> …` | the overlap join, uncommitted edits included |

## Directives — attention, never authority

```
fleet directive --to <id|all> --kind <pause|resume|rebase|release|rerun-ready> \
  --reason <pr-merged|hold|train|note> [--ref <ref>] [--note "…"] [--expires-hours 24]
fleet directive --list [--all]
fleet directive --ack <directive-id> --outcome done|declined [--note "…"]
```

- The kinds are closed: there is no merge, push, override or delete directive.
- A directive is **VERIFIED for a recipient only when fleet derives the same
  action for that recipient from current facts**: a `release` citing a PR that
  is not the recipient's own is UNVERIFIED; a `rebase` needs a base change that
  touches the recipient's files; `pause`/`resume` must cite the CURRENT hold
  event (`--reason hold` with no `--ref` cites it for you). A `note` is never
  verified. Current facts outrank directives, so a `resume` while the hold is
  still on reads `superseded`.
- Ack with `done` after acting, `declined` after the user said no. Expired and
  answered directives move to `directives/archive/<yyyy-mm>/`; nothing is deleted.
- A directive this fleet version does not understand (a newer kind or schema) is
  listed as unsupported and never acted on.

`fleet hold off --note "rebase onto main and continue"` posts a `resume`
directive to everyone that cites that exact hold event. `fleet hold on --notify`
posts the matching `pause`.

## Addressing a session

`fleet claim --host-session <id>` records the host's own id for the session (for
the desktop app, the `local_…` id, not the display name). `status` prints it as
`host: <id>`, so a coordinator who does send a host message addresses one that
is delivered.

## Ending a session

- `fleet release [--abandoned]` retires the claim now: the session stops blocking
  claims and leaves the landing order. It never refuses; it prints the
  archive verdict as advice.
- `fleet archive-check [<id|branch|path>]` is read-only. It exits 0 only when
  every probe ran and nothing would be lost. Exit 3 means `AT RISK` (staged or
  unstaged changes, untracked files, gitignored files outside `archiveIgnore`,
  commits no remote holds, including on a detached HEAD) or `UNVERIFIED` (a probe
  failed, or skip-worktree/assume-unchanged files hide edits from git). Run it
  before archiving a worktree: archiving can empty gitignored folders such as
  `.claude/tmp`.

## Permission prompts

Add a project allow rule for fleet's own CLI so sessions do not stall on it:
`Bash(node scripts/.claude-skills/fleet.mjs:*)` (a consumer path; in the source
repo, `scripts/fleet.mjs`). It names no personal folder, so it is safe to commit.
Message delivery across differing permission modes stays host behaviour.
