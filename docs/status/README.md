# Session log archive

`status.md` at the repo root holds the **current month**. Earlier months live
here, one file per month, newest entries first within each file — the same
order the root log uses.

## Why the split

The log reached **1.57 MB across 408 entries and six months**, at the repo root,
and was the single most-churned path in the repository: 401 of one 90-day
window's commits touched it. It was also at ~75% of the 2 MiB document ceiling
`scripts/lib/doc-citations.mjs` applies. Rotating whole months keeps the file
people actually append to small, without discarding anything.

## Nothing was lost, and that is checked

Rotation is not a rewrite. `scripts/rotate-status-log.mjs` refuses to write
unless the pieces reassemble into the original **byte for byte**, and it records
every archived entry's full-span SHA-256 in `rotation-manifest.json`.

`npm run status:integrity:gate` re-verifies on every push, against the whole
push range:

- an entry present at the base must still exist, in the root or in a vouched archive;
- a retained root entry may be **appended to**, never rewritten or truncated;
- an archived entry is frozen, and must match its manifest digest **in order**;
- the **manifest itself may only grow** — deleting an archive together with its
  own record is the bypass that passes every other rule;
- and if the base cannot be resolved (a shallow CI clone), the gate **fails
  closed** rather than reporting conservation it did not check.

This exists because PR #87 replaced `status.md` with a single entry, destroying
19,257 lines, and reached `main` through a full check run — nothing measured the
file. Restored by PR #88 (`3a17bbce`, 19,257 insertions, 0 deletions).

## Finding an entry

Entries keep their `## YYYY-MM-DD — summary` headings, so cite them by header
rather than by line number (`docs/audit/shared-references/verification-discipline.md`
§1). To search every month at once:

```bash
grep -rn '^## 2026-07-04' status.md docs/status/
```

## Adding an entry

Never here. `/ship` appends to `status.md` at the root; a month moves into this
directory only via `npm run status:rotate`, which writes the manifest that makes
the move provable.
