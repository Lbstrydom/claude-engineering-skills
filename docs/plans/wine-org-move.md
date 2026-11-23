# Moving wine-cellar-app into a personal GitHub organisation

- **Status**: Draft

Planning only. Nothing here has been executed: no transfer, no GitHub setting changed, no store row written.
`NEWORG` is a placeholder for the organisation name the owner will choose.

## 1. Why, and the one decision that gates everything

**Motive.** wine-cellar-app ("wine") is the owner's only private personal repo that pays for GitHub-hosted
Actions minutes (about 3,750 hosted minutes in the last 30 days, `expected` from the 2026-11-23 runner
inventory). The cheaper runner providers that inventory looked at, Blacksmith and Depot, only serve
repositories owned by an **organisation** (§6). So the repo has to move from a user account to an org.

**The gate (decide before anything else): a Free org loses wine's merge gate.** Measured 2026-11-23
(`gh api user`, `gh api repos/Lbstrydom/wine-cellar-app/rulesets`):

- the owner's personal account is on **GitHub Pro**, and wine has **3 active rulesets**, no bypass actors:
  `main protection` (no deletion, no force-push, PR required, required checks `Required gate` and
  `AI-Models trailer`), plus two `Protect E5b evidence` rulesets (one branch, one tag) that make a
  frozen experiment's evidence refs undeletable and unrewritable;
- classic branch protection on `main`: none (`404 Branch not protected`). The rulesets are the whole gate.

Rulesets and protected branches on a **private** repo need GitHub Pro (personal) or Team / Enterprise (org);
GitHub Free for organisations has them for **public** repos only (§5.3). GitHub's transfer doc says it
outright: a private repo moved to a Free user or org loses protected branches. Transferred into a Free org,
the three rulesets stop being enforced: nothing would then require `Required gate`, so a red PR could be
merged, and the E5b evidence refs could be deleted. The same move also loses private-repo **environments**
(§5.3), CODEOWNERS, and the wiki.

Three ways through, the owner picks one (`D0` in §8):

| Option | Cost | Keeps the gate? | Notes |
|---|---|---|---|
| **A. NEWORG on GitHub Team** | one seat, monthly (`expected` about $4; read the price on github.com/pricing before deciding) | yes, rulesets enforced as today | the honest like-for-like |
| B. NEWORG on Free, gate moved into CI | none | **no, advisory only** | `Required gate` keeps running but cannot block a merge; the E5b refs lose their protection |
| C. Stay put, no Blacksmith | none | yes | trim hosted minutes instead (wine's own `ci-hosted-minutes-trim-2026-11` plan) |

**Recommendation: A, or C. Not B.** B removes the one mechanism that stops a red PR merging in a repo where
several agent sessions merge concurrently; an advisory check is the gate the rulesets exist to replace.
**The runbook in §4 is for option A only.** C ends here: no transfer, and wine's own minutes-trim plan is
the path. B is not executable from this plan; choosing it needs its own plan, with acceptance criteria that
state the merge gate is advisory and the E5b refs are unprotected. Whether
A pays for itself is arithmetic the owner can do with the §6 prices: Team's seat price against the hosted
minutes Blacksmith's free allowance absorbs (3,000 minutes there is $12 at its overage rate, `derived`).
Everything below assumes **A** unless it says otherwise.

**A second fact the motive rests on: Blacksmith is not card-free.** Its Terms of Service require a valid
payment method at account setup (§6). The free allowance is real; the "no card" part is not available.

## 2. What keys on the slug `Lbstrydom/wine-cellar-app`

Each row was checked on 2026-11-23 against the repo or store named, not from memory.

### 2.1 The CES audit store (read-only queries, store `d5a9d07b91225a93`)

**Identity survives; the name does not.** The store finds wine by `repo_uuid`, and wine **commits**
`.audit-loop/repo-id`, so the uuid does not depend on the origin URL
([repo-identity.mjs](../../scripts/lib/repo-identity.mjs) `resolveRepoIdentity`, step 1). Exactly one
`audit_repos` row matches it, named `Lbstrydom/wine-cellar-app` (`measured`).

But `name` is **re-derived from the git origin** and written back on the next audit that carries a repo
profile ([store/repo.mjs](../../scripts/lib/store/repo.mjs) `resolveRepoForStoreResult`, the UPDATE
branch). So the row renames itself to `NEWORG/wine-cellar-app` the first time an audit runs in a checkout
whose `origin` points at NEWORG. That is CES's existing rename path, and it is half a path:

| Keyed on the name | Where | Effect after the self-rename | Measured |
|---|---|---|---|
| `persona_test_sessions.repo_name` | base table | 66 rows still say the old slug | 66 rows, all also carry wine's `repo_id` |
| views `audit_effectiveness`, `persona_density_per_repo` | `LEFT JOIN persona_test_sessions s ON s.repo_name = r.name` | **wine's 66 sessions drop out of both views**: precision/recall and persona density read empty, which looks like "no persona testing" | view definitions read with `pg_get_viewdef` |
| `LEARNING_REPO_NAME` in wine's `.env` | env | still the old slug; every name lookup (`getRepoIdByName`, weekly-review, home queues, maintenance checks) misses the renamed row | `.env` value equals the slug (value not printed); `.env.example` carries a placeholder |
| `personas.repo_name`, `fleet_events.repo_name`, `own_model_ledger.repo_name` | base tables | none | 0 rows with the slug |

Rows that hold the slug only as **history** (PR URLs and prose): `audit_run_diffs.diff_text` 12,
`upstream_issues.body` 13, `debt_entries.followup_pr` 6, `learning_decisions.context` 5,
`debt_entries.detail_snapshot` 1, `upstream_issue_events.note` 1. GitHub's redirect resolves those URLs (§5)
and nothing joins on them, so they stay as written. `symbol_index` text columns timed out at 20 s and were
not scanned (`unmeasured`); its `file_path` is repo-relative, so no slug is expected there.

**A flip-flop hazard.** The rename follows whichever checkout audits last. After the transfer, a clone whose
`origin` still says `Lbstrydom/...` works through the redirect, and a profiled audit there renames the row
**back**. So every clone must be repointed in one sitting (§4, step 9), not just the main checkout. Linked
worktrees share their clone's config, so one `set-url` per clone covers them; separate clones (the WSL
runner's work directory is a CI checkout and takes `github.repository`, so it is not one) are listed in step 3.

**The minimal rename path (design).** The name is denormalised, and the views join on the copy. Two
mutually exclusive shapes; the owner picks one as D2 before step 1:

- **D2 = structural (recommended):** a CES migration that re-joins both views by id, keeping the name as a
  fallback only for rows that have no id:
  `ON s.repo_id = r.id OR (s.repo_id IS NULL AND s.repo_name = r.name)`.
  Same projected columns and aggregates; only the join predicate changes, so rows that join today still join.
  Measured in this store: 69 persona sessions, **0** with a null `repo_id`, 0 dangling, 0 whose name
  disagrees with their repo row, so here the change is lossless. Other stores are not measured; the fallback
  arm is what keeps their legacy rows, and the migration PR runs the same four counts on each store before
  `--migrate`. It is its own CES PR with its own `/audit-code`, a DB test with a renamed repo, and
  `--migrate` on **every** store before the CES `main` fast-forward reaches consumer hooks. Once it is in,
  the self-rename is harmless to the views, and later renames need nothing.
- **D2 = operator fallback:** one transaction that sets `audit_repos.name` and
  `persona_test_sessions.repo_name` to the new slug together, run **inside the freeze** after every clone is
  repointed and before any audit runs (§4, step 10F). Smaller, but repeated by hand for any later rename,
  and it is a store write, which needs the owner's go-ahead.

Either way, `LEARNING_REPO_NAME` changes in the same sitting as the origin URLs (§4, step 9): from the first
profiled audit on, the old env value misses the row.

### 2.2 CES's own config and tooling

| Item | File | After the move | Action |
|---|---|---|---|
| consumer registry | [consumer-repos.mjs](../../scripts/lib/consumer-repos.mjs) (`name: 'wine-cellar-app'`, alias `wine`, local path, `merge: 'manual'`) | unchanged: it keys on the basename and the local directory, never the owner | none |
| sync PRs | [sync-pr.mjs](../../scripts/sync-pr.mjs) runs `gh` inside the consumer's checkout | follows the checkout's `origin` | none once wine's origin is updated |
| pilot authorisation | [step-back-pilot-freeze.mjs](../../scripts/lib/audit/step-back-pilot-freeze.mjs) `AUTHORISED_REPOS`, checked against the clone's own origin | wine **fails closed** (refused, not misread) | add the new slug in a CES PR, keep the old one until no frozen dataset names it |
| experiment recipients | `docs/experiments/audit-effectiveness/recipient-policy.json` key `github.com/Lbstrydom/wine-cellar-app`, compared with the remote | same: refused until a new key exists | same PR; frozen corpora keep the old identity as history |
| docs and test fixtures | `consumer-adoption.md` examples, `ensure-branch-protection.mjs` usage comment, `tests/fixtures/fleet/github-ci/*` | fixtures are recorded API responses, history | docs only, optional |

No `.sync-*` file in CES names the target slug: `.sync-receipt.json` and `scripts/.sync-owned.json` live in
the **consumer** and name the **source** (`Lbstrydom/claude-engineering-skills`), which does not move.

### 2.3 Wine's own config (read at wine `origin/main`, 2026-11-23; WCA makes these changes)

| Item | Where | Why it breaks or drifts |
|---|---|---|
| `IMAGE_NAME: ${{ github.repository }}` | `.github/workflows/docker-publish.yml` | the GHCR path becomes `ghcr.io/neworg/wine-cellar-app`. The existing container package does **not** move: it stays on the user account, unlinked, and workflows lose access to it (§5.1), so the first post-move publish creates a fresh package under NEWORG. Railway builds from source, so this is not the deploy path, but the image-size check reads the registry |
| `environment: baseline-refresh` | `.github/workflows/refresh-schema-baseline.yml` | option B only: Free orgs cannot configure environments on private repos (§5.3). Separately, its comment says required reviewers gate a secret, but the environment has **no** protection rules and **0** secrets (`measured`); a pre-existing mismatch for WCA, independent of this move |
| lowercase-repository assertion | `scripts/measure-image-size.mjs` and its test | follows `github.repository`; re-read the measured image after the first publish |
| `image-size-budget.json` note | names the old image path | prose; refresh with the next measurement |
| `DEFAULT_REPO = 'Lbstrydom/wine-cellar-app'` | `scripts/check-required-checks.mjs` | hard-coded slug; works through the redirect for reads, but should take the new slug |
| bridge file | `.audit-loop/repo-identity.json` `name` | read by the persona-consistency scripts; update with the origin |
| `LEARNING_REPO_NAME` | `.env` (local, untracked) | §2.1 |
| `CODEOWNERS` `@Lbstrydom` | `.github/CODEOWNERS` | a user handle, still valid as an org member |
| CES checkouts | `consistency-canary`, `visual-audit`, `workflow-cadence` check out `Lbstrydom/claude-engineering-skills` | CES is public and does not move: none |
| `package.json` | no `repository`/`homepage`/`bugs` field | none |
| Dependabot | `.github/dependabot.yml` names no owner | none; re-enable security updates if the setting does not carry (§5) |
| README badges | none name the slug | none |
| self-hosted jobs | 9 jobs with `runs-on: self-hosted`; `pg-compat-test` picks its runner at run time | the runner is **repo-registered** (§3) |

### 2.4 Deploys, webhooks and integrations (GitHub side, counts only)

- **Railway** auto-deploys from GitHub source through the Railway GitHub App (wine `deployment-ops.md`).
  The app is installed on the owner's account; after the transfer it must also be installed on NEWORG with
  access to wine, then the service's source re-linked if Railway shows it disconnected (Railway documents an
  Add → GitHub Repository → Refresh to clear its repo cache). This is a Railway deploy-environment change, so
  it is the owner's. Railway also writes GitHub deployment environments (`wine-cellar / production`, PR
  previews; 105 environments in total, none with protection rules). The transfer doc does not say whether
  environments move; compare the count after the move (§4). On option B they would be unavailable (§5.3).
- **Webhooks**: one, to a third-party code-scanning service. Webhooks "remain associated" (§5.1); verify it fires.
- **Deploy keys**: 0. **Actions variables**: 0. **Dependabot secrets**: 0. **Actions secrets**: 17 (names not
  listed here). **Pages**: off. **Autolinks**: 0. **Open PRs**: 8.
- **Actions settings**: all actions allowed, default token read-only, Actions may approve PRs. These are
  repo-level; the **org** policy can override them (§5), so set NEWORG's defaults before the transfer.

### 2.5 Claude and coordinator files

- 37 auto-memory files (wine and CES projects) mention the slug, almost all as PR links: history, left alone.
  Two carry operative commands: the runner health check (`gh api repos/Lbstrydom/wine-cellar-app/actions/runners`)
  and the merge-queue note, whose conclusion **still holds** after the move (merge queue on a private
  org-owned repo needs Enterprise Cloud).
- The `gh` CLI's active account is often a work account with no access to wine. Every `gh` step below starts
  with `gh auth switch --user Lbstrydom` and `gh api user -q .login`.
- `~/.claude/CLAUDE.md`, rules and skills: no slug.
- The shared host lock (sibling-session notes, 2026-11-23) records `repo = $GITHUB_REPOSITORY` in its record
  and is not live for wine yet. When wine joins, its records carry the new slug; nothing compares the old one.

## 3. The self-hosted runner

The WSL runner (labels `self-hosted, Linux, X64, wsl2, docker, playwright`) is registered **on the
repository**. GitHub's documentation does not say whether a repo-level runner survives a transfer (§5.4),
so plan for re-registration and treat a surviving one as a bonus. Re-register it **on NEWORG** (org level),
in a runner group whose repository access is limited to wine. That is the shape that later lets a second repo
share it (§7). GitHub's own pages disagree on whether a Free org gets extra runner groups (§5.4); option A is
Team, where they are documented.

Org-level registration is the plan's choice, not an open decision: it is what §7 needs, and the rollback
path below covers going back to repo level.

The procedure, using GitHub's own runner scripts. The Windows-side keepalive is untouched; the runner's
Linux service is stopped and restarted around the re-registration:

1. **Capture** (step 3): runner name, its labels (all six, since the nine jobs select on them), the runner
   version, the service unit name and file, and whether the unit was installed by the runner's own
   `svc.sh` or written by hand (wine's notes name a custom unit; WCA confirms which).
2. **Stop** the service (`sudo systemctl stop <unit>`, or `sudo ./svc.sh stop`). If it was installed by
   `svc.sh`, also `sudo ./svc.sh uninstall`, since that service is bound to the old registration.
3. **Remove** the repo registration (step 11): `config.sh remove` with a removal token from
   `POST repos/NEWORG/wine-cellar-app/actions/runners/remove-token` (short-lived, fetched at that moment).
   If the registration did not survive the transfer, there is nothing to remove on GitHub; clear the local
   registration as the runner docs describe.
4. **Create** the runner group on NEWORG with repository access "Selected repositories → wine-cellar-app".
5. **Register** with a registration token from `POST orgs/NEWORG/actions/runners/registration-token`:
   `config.sh --url https://github.com/NEWORG --token … --name <same> --labels wsl2,docker,playwright
   --runnergroup <group>` (`self-hosted, Linux, X64` are added by the runner itself).
6. **Start**: `sudo ./svc.sh install && sudo ./svc.sh start` for an `svc.sh` service, or
   `sudo systemctl start <unit>` for the hand-written one (its unit file did not change).
7. **Verify**: the org runner list shows it `online` with all six labels and in the group; one labelled job
   (a `runs-on: self-hosted` job that uses docker) runs on it and passes.

**Rollback** is the same seven items with the repo URL
(`--url https://github.com/Lbstrydom/wine-cellar-app`, a repo registration token) and no group.

## 4. Runbook (option A)

Each step names who acts. **Owner** = a click or a setting only the owner makes. **WCA** = the wine
coordinator or a wine PR. **CES** = a CES PR. Nothing in this plan is done by the session that wrote it.
**D2** (§2.1) decides between steps 2S and 10F; exactly one of them runs.

### Before the day

1. Owner: decide D0 = A, the org name, D2 and D5. Create NEWORG and buy one Team seat.
2. CES: land the `AUTHORISED_REPOS` and recipient-policy additions (§2.2) carrying **both** slugs.

   2S. CES (D2 = structural only): land the view migration (§2.1) and run `--migrate` on every store;
   verify on each that `audit_effectiveness` and `persona_density_per_repo` return the same rows as before.
3. **Baseline**, written to a file kept outside the repo (non-secret metadata only, never values):
   - rulesets: full JSON of all three (targets, conditions, rules, enforcement, bypass actors, required checks);
   - Actions secrets and environment secrets: **names** and `updated_at`; Actions variables (0); Dependabot
     secrets (0);
   - environments: names, protection rules, deployment-branch policy, and each environment's **variables**
     (names, plus a recovery source for any value that is not trivially re-derivable), or "none";
   - webhooks: URL host, events, content type, active flag; deploy keys (0); autolinks (0);
   - Actions permissions and default workflow permissions; security-and-analysis settings;
   - GitHub Apps that can see wine (from the owner's installations list), with each app's repository grant;
   - for each secret, its **recovery source** (where the owner can get the value again, such as a provider
     dashboard or a password manager) and who re-enters it. Values are never written down here. GitHub cannot
     reveal a stored secret, so a secret with no recovery source **blocks the transfer** until one exists;
   - scheduled workflows: name, whether each writes to the repo (push, tag, PR, release), and whether it is
     enabled now (WCA fills this);
   - runner capture (§3, item 1);
   - stores: **which** stores wine writes to. WCA runs, in a wine checkout, the store seam's own descriptor
     (`activeStoreDescriptor()` from the synced `db/client.mjs`: a fingerprint, never a host), and lists
     any other DSN wine's tooling is configured with. This plan measured one store, `d5a9d07b91225a93`,
     where wine's row was last audited on 2026-11-23; whether it is the only one is for WCA to confirm.
     For **each** store: the `audit_repos` row by uuid, the `audit_effectiveness` row for wine, and the
     persona session count (66 on the measured store; each store's own number is its own baseline);
   - every clone of wine on every machine the owner uses (`git remote -v` per clone).
4. Owner: settle the rollback question (§5.2): ask GitHub Support whether a repo can be transferred back
   into its retired `OWNER/NAME`. Record the answer as D5.
5. Owner: on NEWORG, set Actions policy to the step 3 values, and confirm rulesets are available on the plan.

### The day: freeze, transfer, restore protection first

6. **Freeze** (WCA, then owner). WCA tells every wine worker session to hold (no push, no merge, no tag
   writes); the owner pauses the CES and WCA coordinators' merge authority for the window. Disable the
   scheduled workflows that step 3 marked as writing and enabled, record which ones were disabled, and wait
   until `gh run list --status in_progress` and `--status queued` are both empty (cancel any that are not).
   Auto-merge is on for the repo (`allow_auto_merge: true`, `measured`): turn it off for the window, so that
   a queued auto-merge cannot land while the gate is being restored. The freeze holds until step 16.
7. Owner: Settings → Danger Zone → Transfer → NEWORG. Takes effect at once.
8. Owner: **rulesets first.** Compare all three against the step 3 JSON; re-create any that is missing or
   differs. Then a negative control: a scratch PR with a deliberately failing required check must show the
   merge blocked; then delete the scratch PR and branch.

### Then, in order

9. Owner: every clone from step 3: `git remote set-url origin https://github.com/NEWORG/wine-cellar-app.git`;
   in the same sitting, update `LEARNING_REPO_NAME` in wine's `.env` and the bridge file. No profiled audit
   runs anywhere until this is done.
10. **Store cut-over, immediately after step 9**, so the window in which the new `LEARNING_REPO_NAME` and
    the old row name disagree is minutes, not days, and inside the freeze:
    - D2 = structural: WCA runs one `/audit-plan` round on any wine plan, in a repointed checkout, once per
      store from step 3 (a profiled audit writes only to the store its checkout is configured for). That
      audit is what renames the row on that store.
    - D2 = fallback (10F): the owner runs the one-transaction rename (§2.1) on each store instead.

    Then run the store checks from the verification list on each store, against that store's own baseline.
11. Owner: the runner (§3, items 1–7).
12. Owner: install the Railway GitHub App on NEWORG with access to wine; refresh or re-link the service
    source. Install any other app from step 3 that lost access.
13. Compare the live state against the **expected** state, item by item (names, not only counts). Re-enter
    any missing secret or variable from its recovery source. Any difference not fixed now is a rollback
    trigger. The expected state is the step 3 baseline except where the plan changes it on purpose:

    | Baseline item | Expected now |
    |---|---|
    | rulesets, secrets, variables, environments, webhooks, deploy keys, autolinks, Actions and security settings | equal to baseline |
    | GitHub Apps | equal, but installed on NEWORG (Railway and any other app re-granted at step 12) |
    | clone origins, `LEARNING_REPO_NAME`, bridge file | the NEWORG slug (step 9) |
    | store rows | same uuid and row id; name `NEWORG/wine-cellar-app`; session counts equal (step 10) |
    | runner | org-level, in the group, same name and six labels (step 11) |
    | scheduled workflows, auto-merge | disabled / off as recorded at step 6, until step 16 |

    For a rollback the expected state is the step 3 baseline itself, with the runner back at repo level.
14. **Canary, still inside the freeze**: WCA opens one PR with the §2.3 edits; the owner's go for this one
    PR is the exception to the freeze, given at step 6. It must pass the whole verification list below,
    including a deploy, before anything else merges.
15. If any verification item fails: fix it under the freeze, or roll back.
16. Unfreeze: re-enable exactly the workflows step 6 recorded as disabled, turn auto-merge back on, restore
    the coordinators' merge authority, tell WCA to resume.

### Verification (each a measurement, not a glance)

- **CI**: the step 14 canary runs green, including a self-hosted job on the re-registered runner, and its
  merge waited for `Required gate` (step 8 proved the negative case).
- **Secrets in use**: the canary's workflows that consume secrets (deploy wait, canaries, image publish)
  ran without an auth or missing-secret error.
- **Deploy**: its merge deploys on Railway; `wait-for-deploy.mjs --expect-sha` sees the new sha.
- **Webhook**: the third-party service shows a delivery for the canary push.
- **Store** (after step 10), on each store wine writes to: the row found by uuid is still the only row and
  is named `NEWORG/wine-cellar-app`; `audit_effectiveness` still counts wine's 66 sessions (it must not drop
  to 0); a name lookup with the new `LEARNING_REPO_NAME` resolves the row.
- **Sync**: from CES, `npm run sync:dry -- --target wine` shows no unexpected change, and `sync-pr` resolves
  the repo.
- **Blacksmith** is not part of this verification. It starts only after everything above passes (§6).

### Rollback

Triggers: step 8 cannot restore enforcement, or a step 13 or verification item fails and cannot be fixed
within the freeze. Who: the owner, with WCA reverting wine-side config.

1. Re-freeze (step 6).
2. **D5 = transfer back allowed**: NEWORG → Settings → Transfer → `Lbstrydom`. Then repeat steps 8–13
   against the step 3 baseline at the old location: rulesets; every clone's origin, `LEARNING_REPO_NAME` and
   bridge file back; the runner re-registered on the repo (§3, rollback); Railway re-linked to the
   personal installation. If the canary PR merged, WCA reverts it. Unfreeze per step 16. Store: with D2 = structural, nothing
   (the next profiled audit renames the row back); with D2 = fallback, reverse the transaction.
3. **D5 = transfer back not allowed**: there is no clean rollback, only forward recovery: fix the failing
   item in place, under the freeze. The owner accepts that before step 7, or does not transfer.
4. Verify with the same list as above.

The old URL's redirect also dies if anything named `wine-cellar-app` is created under `Lbstrydom` (§5.2).

## 5. What GitHub carries over on transfer

Read 2026-11-23. No page showed a "last updated" date, so re-read them on the day.
[T] = [Transferring a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository).

### 5.1 Carried, not carried, not documented

| Item | Outcome | Source |
|---|---|---|
| Issues, PRs (the 8 open ones included), wiki, stars, watchers, history | move with the repo | [T] |
| Webhooks, secrets, deploy keys | "remain associated" | [T] |
| Git LFS objects | move, in the background | [T] |
| Collaborators | kept; the old owner becomes a collaborator; assignees who are not org members are cleared | [T] |
| GHCR container package | **stays on the old account, unlinked; workflows lose access** | [Packages permissions](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages) |
| GitHub Pages | not redirected (wine has Pages off) | [T] |
| Actions variables, environments, rulesets, Actions settings, Dependabot secrets, code-security settings, autolinks, GitHub App installations | **not documented** either way | [T] is silent |

For the "not documented" row the runbook takes the conservative path: record each before (step 3), compare
after (verification), and treat GitHub App installations as needing a fresh install on NEWORG (Railway's
included). Org-level Actions policy can be stricter than a repo's, so NEWORG's is set first (step 5).

### 5.2 Redirects and their limits

- Web URLs and `git clone`/`fetch`/`push` redirect to the new location; GitHub still recommends
  `git remote set-url` [T].
- The redirect is **deleted for good** if a repo or fork is later created at the old location [T].
- **Retired names.** A repo with more than 100 clones or more than 100 Actions uses in the week before the
  transfer has its old `OWNER/NAME` permanently retired at the old owner [T]. Wine's CI volume almost
  certainly passes that bar, so the name `Lbstrydom/wine-cellar-app` is expected to retire. Whether a
  **transfer back** into a retired namespace is allowed is not documented: that is the one open risk in the
  rollback (§4), and it is checked before step 6, not after.
- API redirects and `uses:` references to actions inside the repo: not documented. Wine references no action
  inside itself, so only API callers matter, and the §2.3 edits remove the hard-coded slug.

### 5.3 What a Free organisation can do with a private repo

From each page's "Who can use this feature?" line:

| Feature | Pro (today) | Free org | Team org | Source |
|---|---|---|---|---|
| Rulesets | yes | **no** (public only) | yes | [About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets) |
| Protected branches | yes | **no** | yes | [About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) |
| CODEOWNERS | yes | **no** | yes | [About code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners) |
| Environments, environment variables, deployment branches | yes | **no** | yes | [Managing environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments), [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) |
| Required reviewers / wait timers on environments | **no** (public only) | no | no | same |
| Included Actions compute | $18/month (about 3,000 Linux minutes, `derived`) | $12/month (about 2,000) | see pricing page | [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) |

With no payment method, GitHub-hosted usage is **blocked** when the included quota runs out (same billing
page). The owner's Pro allowance stays with the personal account and keeps covering the other personal repos.

### 5.4 Runners

- Whether a repo-level self-hosted runner survives a transfer: not documented. A runner that has not
  connected for 14 days is removed automatically.
- Runner groups: [Managing access](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/manage-access)
  says Team **or Free** orgs can create extra groups with "Selected repositories" access;
  [Runner groups](https://docs.github.com/en/actions/concepts/runners/runner-groups) says Team. They
  conflict; read NEWORG's settings page once the org exists.

### 5.5 Who can transfer

Admin on the repo plus permission to create repos in NEWORG; Settings → Danger Zone → Transfer [T]. NEWORG
must not already hold a repo of that name or a fork in its network.

## 6. Blacksmith afterwards

Sources: [quickstart](https://docs.blacksmith.sh/introduction/quickstart),
[GitHub app](https://docs.blacksmith.sh/blacksmith-administration/github-app),
[runners overview](https://docs.blacksmith.sh/blacksmith-runners/overview),
[settings](https://docs.blacksmith.sh/introduction/settings),
[terms](https://docs.blacksmith.sh/about/terms-of-service),
[caching](https://docs.blacksmith.sh/blacksmith-caching/dependencies-actions),
[pricing](https://www.blacksmith.sh/pricing). Read 2026-11-23.

- **Orgs only.** "Blacksmith is limited to GitHub organizations" (quickstart). Depot's runners have the same
  limit ([Depot docs](https://depot.dev/docs/github-actions/overview)).
- **Install** the Blacksmith GitHub App on NEWORG with **Only select repositories → wine-cellar-app**.
- **Free tier**: 3,000 x64 2 vCPU minutes per org per month; larger runners use them faster, in proportion to
  vCPUs. After that, Ubuntu x64 2 vCPU is $0.004/min (`expected`, pricing page). **A payment method is
  required at sign-up** (terms, effective 2026-07-20). The task brief assumed no card; that is not available.
- **Spending alert**: set the monthly threshold to **$25** under Settings → Spending Alerts. It emails; it
  is not a hard cap, and the docs show no hard cap for runners. The cap that does exist is the owner's own
  card limit.
- **Region**: us-east, us-west, eu-west (Amsterdam), eu-central (Frankfurt). Changing region is a support
  request, not a setting. Ask for **eu-west** before the pilot, so the pilot measures the region that will
  be used.
- **Pilot one heavy job first.** Pick one GitHub-hosted job that dominates wine's hosted minutes (WCA chooses,
  from its billing measurement: per-job timestamps, not the `/timing` API, which returns 0 for wine). Change
  only its `runs-on:` to `blacksmith-2vcpu-ubuntu-2604` (the label the docs now map `ubuntu-latest` to; not
  2404). Before the switch, WCA records for that job: its current runner image, the last 10 runs' billed
  minutes, durations and pass rate. Note that `ubuntu-latest` on GitHub and Blacksmith's 26.04 image may
  differ, so a failure in the pilot is first checked against the image, not the provider.
  **Accept** if, over the next 10 runs on comparable PRs, the pass rate is no lower, median duration is no
  worse than +20%, and Blacksmith's dashboard shows the minutes landing in the free allowance. **Reject**
  otherwise, by reverting the one `runs-on:` line. WCA reports the numbers; the owner decides. A spend alert
  firing during the pilot stops it (revert the line) until the owner looks. Then migrate the rest in one WCA
  PR; the Migration Wizard opens PRs, so use it only for that bulk step.
- **Caching**: `actions/cache@v5` uses Blacksmith's cache with no change (25 GB per repo per week). The
  `useblacksmith/cache` and `useblacksmith/setup-*` actions are **archived**; do not adopt them. Docker layer
  cache is `useblacksmith/setup-docker-builder@v1` plus `useblacksmith/build-push-action@v2`, for
  `docker-publish` after the pilot.
- The self-hosted jobs stay on the WSL runner. Blacksmith replaces GitHub-hosted minutes only.

## 7. Shared runner (noted, not designed)

An org-level self-hosted runner in a runner group, limited by repository, is the shape that could later
serve wine and ai-organiser from one registration. That repo is not part of this move; it would need its own
transfer decision and its own look at the host-lock work in the sibling notes. Not designed here.

## 8. Decisions for the owner

- **D0**: option A or C (§1). B needs its own plan.
- **D1**: the org name.
- **D2**: structural view migration (step 2S, recommended) or the operator rename inside the freeze (step
  10F). Exactly one.
- **D4**: Blacksmith with a card on file (it requires one), the $25 alert, eu-west by support request (§6).
- **D5**: GitHub Support's answer on transferring back into a retired name (step 4); if "no", accept forward
  recovery only, or do not transfer.
- **Freeze window**: a date and length agreed with WCA (step 6).

## Audit trail

- R1 (GPT, 2026-11-23): 7 HIGH, 2 MEDIUM, all accepted. Changes: runbook scoped to option A only; D2 paths
  made mutually exclusive; flip-flop hazard and every-clone repointing; structural migration keeps a name
  fallback for id-less rows (measured 0 such rows in this store); freeze made a control (auto-merge off,
  schedules paused, coordinators paused) with rulesets restored first and a negative control; runner
  procedure with labels, tokens and group; metadata baseline compared by name; rollback decision tree;
  deliberate store-rename trigger; Blacksmith pilot thresholds.
- R2 (GPT): 2 HIGH, 3 MEDIUM, all accepted. Freeze now holds through the store cut-over and a canary PR with
  deploy; runner service lifecycle (stop, uninstall, re-register, start) for both unit kinds; org-level
  registration fixed (D3 removed); secret recovery sources required before transfer; scheduled-workflow
  inventory with restore-exactly-what-was-disabled.
- R3 (GPT): 2 HIGH, 1 MEDIUM, all accepted. Step 13 compares against an explicit expected-state table, not
  the raw baseline; store cut-over is per store, with WCA confirming which stores wine writes to (only
  `d5a9d07b91225a93` was measured); environment variables inventoried. GPT cap (3) reached; acceptance
  stayed 100% every round, so the stop is the cap, not rigor pressure.
- Final gate (Gemini, round 1 of 2): APPROVE, 0 blocking, 0 debt. Status stays Draft until the owner takes
  D0, D2 and D5.
