---
summary: status.md session-log template + update rules + persona / UX status sections.
---

# status.md — Format & Update Rules

`status.md` is the project's append-only session log. Newest entries go
at the top. Every `/ship` run appends a new entry.

**Where a new entry goes depends on ONE tracked marker, `docs/status/entries/README.md`:**

- **Marker present** (this source repo since the per-entry cutover): the entry is a NEW
  FILE `docs/status/entries/<YYYY-MM-DD>-<HHMMSS>-<kebab-slug>.md` (UTC time of the
  ship; the slug names the work). Its first line is the entry's own `## YYYY-MM-DD — summary`
  heading, it holds exactly ONE `## ` heading, and the heading date equals the file
  name's. `status.md` takes no new entry (the integrity gate fails it), and an entry
  file is never edited after it is written. Two ships never touch the same path, which
  is the point: the single log file used to conflict on every concurrent ship.
- **Marker absent** (a consumer, or any repo without the directory): append to
  `status.md` at the repo root, newest first, exactly as below. Nothing here changes for
  those repos.

Everything below describes the entry's CONTENT, which is identical either way. The
drained `### Consumer Verification (previous ship)` subsection goes inside the new entry,
under its heading.

> **Source-repo-only note (does not apply to a consumer repo).** In the
> claude-engineering-skills repo the root log holds the CURRENT MONTH only;
> earlier months are archived under `docs/status/<YYYY-MM>.md`, and a pre-push
> gate proves no entry was lost. Neither the rotation tool nor that gate is
> synced, so a consumer's `status.md` simply keeps growing — which is fine at
> a consumer's scale. The one habit worth borrowing anywhere: **cite a session
> entry by its `## YYYY-MM-DD` header, never by line number**, and search with
> `grep -rn '^## 2026-07-04' status.md docs/status/` so the command keeps
> working after any future rotation.

## Initial creation (first `/ship` on a repo)

When `status.md` doesn't exist, create with a header:

```markdown
# Project Status Log

## <Today's Date> — <Brief Summary of Work>

### Changes
- <Bullet list of what was done, grouped logically>

### Files Affected
- <List of key files created or modified, with one-line purpose>

### Decisions Made
- <Any architectural or design decisions taken during this session>

### Next Steps
- <What remains to be done, if anything>

---
```

## Subsequent entries — append at the TOP (below the header)

So the most recent session is always the first entry a reader sees.

### Rules for the log entry

- **Be specific** — name actual files, functions, and endpoints
- **Be concise** — this is a log, not documentation
- **Include decisions** — these are valuable context for future sessions
- **Include blockers or open questions** if any remain
- **Date format**: `YYYY-MM-DD`

## Optional sections (when data available)

### UX Status (when persona-test P0s exist)

When Step 0.5a finds recent P0s, append:

```markdown
### UX Status
⚠ 2 unresolved P0s from persona test 3 days ago (Pieter, "adding a bottle")
Resolve before next user-facing release.
```

### Persona Test Status (when recent session exists)

```markdown
### Persona Test Status — <date>
- **Last run**: <persona> on <url> (<N> days ago)
- **Verdict**: <verdict>
- **P0s**: <n> | **P1s**: <n>
- **Top finding**: <P0 or P1 description>
- **Debrief**: <first 100 words of debrief_md>...
```

### Regression Lock Status (when `missing_spec_count > 0`)

```markdown
### Regression Lock Status
⚠ <n> recent HIGH-severity fix(es) have no /ux-lock spec:
  • <primary_file>: <one-line detail>
These will silently regress under future refactors.
```

### Plan Verify Status (when a plan was verified)

```markdown
### Plan Verify Status — <plan-name>
- **Last verify**: <date> (commit <sha>)
- **Satisfaction**: <pct>% (<passed>/<total> criteria)
- **Status**: <PLAN_SATISFIED | PLAN_PARTIAL | PLAN_NOT_SHIPPED>
- **Failing P0**: <first failing criterion if any>
```

### Consumer Verification — previous ship(s), when `pending-note read` returns any

Step 6.8 of a PRIOR `/ship` run wrote a note instead of amending an
already-pushed status.md entry (which would force a second commit + push —
see SKILL.md Step 6.8). Step 2 of THIS run drains them, prepends them above this
session's own entry, then deletes exactly the ones it drained.

**There may be more than one, and the subsection holds all of them.** A ship
does not happen after every note: Step 2 only runs inside `/ship`, and not every
status.md commit is a ship, so notes accumulate between drains. One Commit /
Retrieval / Result triple per note, oldest first — the order `pending-note read`
prints them in. Never collapse two ships into one triple, and never drop the
older one: each names a different pushed artifact.

```markdown
### Consumer Verification (previous ship)
- **Commit**: <full sha>
- **Retrieval**: <command actually run, e.g. clone-to-tempdir + `npm run check`>
- **Result**: <verified | failed | unverified — <blocked prerequisite> if unverified>
- **Commit**: <full sha of the next-newer note, if the drain returned more than one>
- **Retrieval**: …
- **Result**: …
```

### Ship train entry — when the entry is the train log (`/ship --train`, step T3)

ONE entry for the whole train, titled by **date + the PR list**, never by a train id (the
id does not exist yet). The gate column says **planned**: it is written before any merge,
and an update-branch can still turn a planned `passed` into `converged`. The ACTUAL gates
arrive in the next entry via the verify note.

```markdown
## <date> — Ship train: #<n>, #<n>, #<n>

### Changes
| PR | Tier | Planned gate | Run | identityProvable | What |
|---|---|---|---|---|---|
| #<n> | urgent / standard / ride-along | passed / converged / waived / not-run | <8-char run id or —> | true / false | <one line> |

Base pinning: <strict | none> (<evidence>). Overrides used: <flags, or none>.
```

`identityProvable` is `false` on an unpinned destination, where a train can land `converged`
but never `passed`. The log PR itself is a ride-along row. Commit it with
`ship-commit.mjs --gate not-run` as usual; the train's squash messages carry the real gates.

## Never commit these into status.md

- Raw tool output (dumps, stack traces, lint output)
- Generated file lists longer than 20 items — summarise
- Secrets, credentials, personal data
- Speculation about "what the user probably meant"

## The `Backlog:` line (Step 2b)

Every entry carries one line summarising the standing queues, produced by
`node scripts/backlog-snapshot.mjs` and pasted in by the agent:

```
Backlog 2026-09-04T09:14Z: Q1 26c/25p (+190 aged) · Q2 80c/88p (50 perm) · Q3 486 · debt 173 cloud/106 local (0 spilled) · upstream 0
```

| Field | Read | Meaning |
|---|---|---|
| `Q1 <c>c/<p>p (+<n> aged)` | `list-unlocked-fixes` | fixes with no regression lock, split code/plan, plus the aged-out population |
| `Q2 <c>c/<p>p (<n> perm)` | `list-unremediated-acceptances` | accepted findings never remediated; `perm` are declined-on-the-merits |
| `Q3 <n>` | `final-review-pending` | shadow-only final-review credit backlog |
| `debt <n> cloud/<n> local (<n> spilled)` | `debt-reconcile --json` | private-store rows vs the machine-local cache, and any undrained spill artifacts |
| `upstream <n>` | `upstream list` | open consumer reports |

**Two rules the line obeys, and why they matter:**

- **A field reads `unmeasured`, never `0`, when its query did not answer.**
  `0` reads as good news; an unasked question is not good news. This is the same
  discipline the debt checks apply to an absent ledger.
- **The counts come from each reader's COUNT field, never `rows.length`.** Every
  one of these readers is capped (20 rows, 10 items) while reporting a true
  total separately. Counting rows once reported "20" against a real 232.

The timestamp is the measurement instant, not the ship time, and one instant
covers every field because a single process performs all the reads.
