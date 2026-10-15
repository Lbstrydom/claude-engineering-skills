# Session log entries

**This file is the cutover marker.** While it exists, the session log is one file per
entry: a new `/ship` entry is a NEW FILE in this directory, and `status.md` at the repo
root takes no new entry. Deleting this file would switch the rules below off, so the
integrity gate (`npm run status:integrity:gate`) fails if it disappears.

## Why

Every ship used to insert its entry at the top of one file, so two PRs shipping at the same
time always conflicted in `status.md`, however different their entries. A new path never
conflicts, and nothing is rendered or generated: entries are source records, like
`docs/plans/*.md`.

## The contract

- **Name**: `<YYYY-MM-DD>-<HHMMSS>-<kebab-slug>.md` — the UTC time of the ship, a lowercase
  slug naming the work. Newest sorts last by name; readers list them newest first.
- **Content**: the first line is the entry's own `## YYYY-MM-DD — summary` heading, in the
  grammar `status.md` already uses; the date equals the file name's. Exactly one `## `
  heading per file; sub-sections (`###`), including the drained
  `### Consumer Verification (previous ship)` note, live inside it.
- **Immutable**: an entry file is never edited or deleted once it is on the base branch.
  A correction is a new entry.
- **`status.md` is frozen history**: it may still be appended to under an EXISTING heading,
  but it gains no new `## ` heading.

## If the gate says `root-entry-added`

Your branch predates the cutover and added an entry to `status.md`. Move ONLY the `## `
block(s) you added into new files here, and delete exactly those spans from `status.md`
(keep any legitimate amendment to an older entry). Re-run `npm run status:integrity:gate`
and read the diff.

## Search

```bash
grep -rn '^## 2026-10-15' status.md docs/status/
```

Plan: `docs/plans/fleet-chips-and-merge-friction.md` §12.
