# Static gates as a required CI check — on a mirror of this repo, and on its consumers

**What it is**: the steps to make `static-gates` (`npm run check:static:ci` in GitHub Actions) a merge-blocking
check on a repository that is NOT this one: a private mirror of the source repo that another organisation runs, and the
consumer repos that mirror syncs into.

**When you need it**: once the mirror has fast-forwarded past the commit that added
`.github/workflows/static-gates.yml`, or when a consumer decides to gate merges in CI.

**Who runs it**: that organisation's repo coordinator session, with an admin of each repository. Nothing here is done
from the source repo's machine: the mirror's GitHub, runners and audit store are reachable only from that side.

## 0. Grant everything up front

The run is quick but it stalls on any missing permission. Before starting, the human owner gives the coordinator, in
its own chat and for this runbook only:

| Needed | Why | Who can grant it |
|---|---|---|
| Repo **admin** on the mirror (and each consumer that opts in) | editing a ruleset | the repo owner, or the org's GitHub admins |
| GitHub Actions **enabled** for the repo, with a runner it may use (hosted or a self-hosted runner) | the job has to run somewhere | org policy |
| Permission for the coordinator to run `gh api` against `repos/<owner>/<repo>/rulesets` | the read-before and read-back steps | the human, in the coordinator's chat |
| A quiet window (no PRs mid-merge) | adding a required check makes every open PR wait for it | the coordinator picks it |

If org policy forbids any row, stop and tell the human: that is a policy decision, not something to work around.

## 1. The mirror

1. **Confirm the workflow is there.** `.github/workflows/static-gates.yml` exists on the mirror's default branch.
2. **Confirm the job runs green on the default branch.** Find its latest push run:
   ```powershell
   gh run list --workflow static-gates.yml --branch main --limit 1
   ```
   Do not continue on a red or missing run. A required check that has never passed blocks every PR.
3. **Check the local-only set.** `.ci-static-local-only.json` lists the gates CI does not run: today those that read the
   audit store or the store-derived observed graph. On a mirror whose store is a different database they stay
   local-only, run by the pre-push hook against that side's own store. Never point CI at an audit store.
4. **Read the current rules before changing anything.**
   ```powershell
   gh api repos/OWNER/REPO/rulesets
   ```
   If a ruleset already requires `full-suite` (or similar) on the default branch, edit THAT ruleset. Don't add a
   second one; two rulesets on one branch are harder to read back.
5. **Add the check**, in the quiet window. Into the ruleset's `required_status_checks` add
   `{"context": "static-gates", "integration_id": 15368}` (15368 is GitHub Actions). Pinning the integration id stops
   a status from another app satisfying the check. Leave `strict_required_status_checks_policy` as the owner decides
   (§3).
   ```powershell
   gh api -X PUT repos/OWNER/REPO/rulesets/RULESET_ID --input ruleset.json
   ```
6. **Read it back and prove it.** `gh api repos/OWNER/REPO/rulesets/RULESET_ID` shows both contexts. Then open a
   trivial PR (a one-word docs edit) and confirm it lists `static-gates` as required. Close it unmerged.

## 2. Consumer repos

A consumer does **not** get `static-gates.yml`: workflows are the consumer's own, and the sync never writes them. A
consumer that wants CI-gated merges:

1. adds its own job that runs its own checks (its test and lint entry points, not this repo's `check:static`);
2. lets it run green on the default branch;
3. adds that job's name as a required check, as in §1 steps 4–6.

Treat each consumer as a separate decision for whoever owns that repo. A consumer that already gates merges in CI
(phase gates, a lint job) needs nothing new.

## 3. "Require branches to be up to date" (strict mode)

Off by default here. With several agent PRs open at once, strict mode forces every open PR to rebase after each merge.
Each rebase is a new head, so CI reruns in full, and merges queue behind one another. The gap it closes is a PR that
never ran a gate added to the default branch after the PR's last run. The `static-gates` run on every push to the
default branch catches that immediately after the merge, which is usually enough.

If the owner wants strict mode anyway, pair it with batched merges: land the ready PRs together in one quiet window, so
the rebases happen once a day, not once per merge.

## 4. Done means

- `gh api …/rulesets/RULESET_ID` lists `static-gates` with integration 15368.
- A fresh PR shows it as required.
- The local-only gates are still run by the pre-push hook on that side.
- The coordinator reports the ruleset id, the read-back output and the probe PR number to the human.
