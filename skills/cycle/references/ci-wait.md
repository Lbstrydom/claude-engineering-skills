---
summary: Step 7 CI wait - every check on the pushed head, into the done report; no merging.
---

# CI on the pushed head — `/cycle` reports it, `/ship` merges it

After an autonomous run pushes a branch and opens its PR, nobody was waiting on CI: red runs went unreported and a chip stopped
with CI still in progress. Run, by path (substitute the PR number and the sha you pushed):

```bash
node scripts/ci-merge.mjs --pr 123 --wait-only --head 0a1b2c3d --timeout-min 30
```

`--head` makes it refuse a PR whose head is a different commit than the one you pushed, so the verdict is never for another commit.

It waits for EVERY check on the exact head sha (not one named check) and prints one envelope; paste its `report` field into the done report.

- Exit 0: all checks passed, or only checks you named with `--allow-fail` failed.
- Exit 1: a check failed — report each failing check by name; do not call the run done.
- Exit 3: timed out — report what is still pending, as pending. Never write "CI green" for a run that did not finish.
- `--wait-only` changes nothing. `--autonomous` does not authorize merging, so `/cycle` never passes `--merge`; the human's `/ship`
  does, once they say to merge. Flags and refusals: the script's own header (`node scripts/ci-merge.mjs` with a bad flag lists them).
