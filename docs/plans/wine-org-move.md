# Moving wine-cellar-app into a personal GitHub organisation

- **Status**: Draft

Planning only. Nothing here has been executed by this plan: no transfer, no repo setting changed, no store
row written. The target is the owner's organisation **`Creathyst`**, created 2026-11-23 on GitHub **Team**,
so D0 is decided as option A (§1).

**Org settings the owner reports applied (2026-11-23):** two-factor authentication required; base
repository permission *none*; private-repo creation limited to owners; approval required for workflows on
pull requests from forks. A read-back that afternoon (`gh api orgs/Creathyst`, a member token without
`admin:org`) showed `plan: team` and 2FA required, while base permission still read `read` and member repo
creation still read `true`, so those two were mid-change or not yet saved. Step 5 re-reads all four with an
owner token before anything moves.

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
(§5.3), CODEOWNERS, and the wiki. GitHub's pricing page states the same in its plan table: "Repository
rules" and "Code owners" are *Public repositories* only on Free, and *Included* on Team.

**Plainly: yes, moving wine to a Free org drops its merge protection.** Keeping it costs one Team seat,
$4 a month. A protection that is about to exist makes this sharper: wine is setting up a protected
`release` branch that Railway will deploy production from, protected by a ruleset (wine #1421, in flight
2026-11-23). On a Free org that ruleset could not be enforced either, so production's deploy source would
be unprotected too.

Three ways through, the owner picks one (`D0` in §8):

| Option | Cost | Keeps the gate? | Notes |
|---|---|---|---|
| **A. Creathyst on GitHub Team** | **$4 per user per month**, one seat = $48 a year ([pricing](https://github.com/pricing), read 2026-11-23) | yes, rulesets enforced as today | the honest like-for-like; Team also includes 3,000 Actions minutes a month against the Free org's 2,000 (same page) |
| B. Creathyst on Free, gate moved into CI | none | **no, advisory only** | `Required gate` keeps running but cannot block a merge; the E5b refs lose their protection |
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
branch). So the row renames itself to `Creathyst/wine-cellar-app` the first time an audit runs in a checkout
whose `origin` points at Creathyst. That is CES's existing rename path, and it is half a path:

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
  Same projected columns and aggregates. Rows join exactly as today **only where id and name agree**: a row
  whose non-null `repo_id` names a different repo than its `repo_name` would move to the id's repo. Measured
  in this store: 69 persona sessions, **0** with a null `repo_id`, 0 dangling, 0 whose name disagrees with
  their repo row, so here the change is lossless. Other stores are not measured, so the migration PR carries
  a **per-store preflight** with stop conditions, run before `--migrate` on each store:

  | Count | Stop if |
  |---|---|
  | sessions whose `repo_id` matches no `audit_repos` row (dangling) | > 0 |
  | sessions whose association **changes**: the repo they join today (`s.repo_name = r.name`, exact) differs from the repo they would join under the new predicate (none counts as a repo) | > 0 |
  | sessions with a null `repo_id` whose `repo_name` matches no repo, or more than one | > 0 |
  | `audit_repos` names held by more than one row | > 0 |

  The second row compares the **exact** join that exists today, not basenames, so a session named
  `other-owner/wine-cellar-app` whose id points at wine's row is a stop, not a pass.

  **Backfill before the view change, in the same migration:** every null-`repo_id` session whose
  `repo_name` matches exactly one `audit_repos` row gets that row's id. Without it, a legacy row would join
  by name until its repo is renamed and then vanish, which is the failure this migration exists to stop.
  After the backfill the name arm of the join should match nothing; it stays only as a guard. Rows the
  backfill cannot resolve (0 or more than 1 match) are the third stop condition.

  A stop means that store is not migrated until each listed row is resolved by hand and recorded; nothing
  is coerced. The PR is its own CES change with its own `/audit-code`. Its DB test covers a renamed repo
  (a null-id legacy session must stay with its repo **across** the rename), a same-basename different-owner
  session, and each stop condition, and is **enrolled** in `db-test-container.mjs`'s
  `*_SUITE_FILES` and `postgres-parity.yml` (a DB suite no runner names has never run; a skip is not a
  pass). `--migrate` runs on **every** store before the CES `main` fast-forward reaches consumer hooks. Once
  it is in, the self-rename is harmless to the views, and later renames need nothing.
- **D2 = operator fallback:** one transaction per store, run **inside the freeze** after every clone is
  repointed and before any audit runs (§4, step 10F); a store write, so it needs the owner's go-ahead:
  1. preflight: the four counts above, scoped to wine, must be 0, and no row is already named
     `Creathyst/wine-cellar-app`;
  2. `SELECT … FOR UPDATE` the wine row by uuid;
  3. `UPDATE audit_repos SET name = new WHERE id = <wine row id>` must affect exactly 1 row;
  4. `UPDATE persona_test_sessions SET repo_name = new WHERE repo_id = <wine row id> OR (repo_id IS NULL AND
     repo_name = old)` must affect exactly the step 3 session count;
  5. re-read both views for wine; they must equal the step 3 baseline; otherwise `ROLLBACK`.

  The reverse transaction for rollback is the same with old and new swapped. Smaller than the migration, but
  repeated by hand for any later rename.

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
| `IMAGE_NAME: ${{ github.repository }}` | `.github/workflows/docker-publish.yml` | the GHCR path becomes `ghcr.io/creathyst/wine-cellar-app`. The existing container package does **not** move: it stays on the user account, unlinked, and workflows lose access to it (§5.1), so the first post-move publish creates a fresh package under Creathyst. Railway builds from source, so this is not the deploy path, but the image-size check reads the registry |
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
| runner-status token | a personal access token scoped to wine, used by the runner-health tooling (wine `ci-self-hosted-runner.md`) | a fine-grained token is bound to one resource owner, so a token issued for the user account cannot reach a Creathyst repo: re-issue it with Creathyst as owner (the org may have to approve fine-grained tokens) and re-set the secret. Verify its scope after the move |
| runbooks | `required-checks-gate.md` names a ruleset **id**; `ci-self-hosted-runner.md` and `deployment-ops.md` name `repos/Lbstrydom/wine-cellar-app` | the id changes if a ruleset is re-created at step 8; text edits in the step 14 canary PR |
| `release` branch ruleset | being created with wine #1421 | must exist and be in the step 3 baseline before the transfer; it is the production deploy source |
| CODEOWNERS (12 paths, `@Lbstrydom`) | `.github/CODEOWNERS` | enforced on Team; confirm the user resolves and keeps write access as an org member |

### 2.4 Deploys, webhooks and integrations (GitHub side, counts only)

- **Railway** auto-deploys from GitHub source through the Railway GitHub App (wine `deployment-ops.md`).
  The app is installed on the owner's account; after the transfer it must also be installed on Creathyst with
  access to wine, then the service's source re-linked if Railway shows it disconnected (Railway documents an
  Add → GitHub Repository → Refresh to clear its repo cache). This is a Railway deploy-environment change, so
  it is the owner's. Railway also writes GitHub deployment environments (`wine-cellar / production`, PR
  previews; 105 environments in total, none with protection rules). The transfer doc does not say whether
  environments move; compare the count after the move (§4). On option B they would be unavailable (§5.3).
- **Webhooks**: one, to a third-party code-scanning service. Webhooks "remain associated" (§5.1); verify it fires.
- **Deploy keys**: 0. **Actions variables**: 0. **Dependabot secrets**: 0. **Actions secrets**: 17 (names not
  listed here). **Pages**: off. **Autolinks**: 0. **Open PRs**: 8.
- **Actions settings**: all actions allowed, default token read-only, Actions may approve PRs. These are
  repo-level; the **org** policy can override them (§5), so set Creathyst's defaults before the transfer.

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
  Its planned run-status staleness check needs a cross-repo read token (the owner's decision): if wine is in
  Creathyst and the other two repos are not, that token must span two owners, which a single fine-grained token
  cannot. Take that into the token decision.
- Wine's workflows and its sync hook read the public CES repo with no token. CES does not move, so nothing
  changes; if CES ever moved, those reads would ride the redirect.

## 3. The self-hosted runner

The WSL runner (labels `self-hosted, Linux, X64, wsl2, docker, playwright`) is registered **on the
repository**. GitHub's documentation does not say whether a repo-level runner survives a transfer (§5.4),
so plan for re-registration and treat a surviving one as a bonus. Re-register it **on Creathyst** (org level),
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
3. **Remove** the repo registration (step 8R): `config.sh remove` with a removal token from
   `POST repos/Creathyst/wine-cellar-app/actions/runners/remove-token` (short-lived, fetched at that moment).
   If the registration did not survive the transfer, there is nothing to remove on GitHub; clear the local
   registration as the runner docs describe.
4. **Create** the runner group on Creathyst with repository access "Selected repositories → wine-cellar-app".
5. **Register** with a registration token from `POST orgs/Creathyst/actions/runners/registration-token`:
   `config.sh --url https://github.com/Creathyst --token … --name <same> --labels wsl2,docker,playwright
   --runnergroup <group>` (`self-hosted, Linux, X64` are added by the runner itself).
6. **Start**: `sudo ./svc.sh install && sudo ./svc.sh start` for an `svc.sh` service, or
   `sudo systemctl start <unit>` for the hand-written one (its unit file did not change).
7. **Verify**: the org runner list shows it `online` with all six labels and in the group; one labelled job
   (a `runs-on: self-hosted` job that uses docker) runs on it and passes.

**Rollback** depends on where the forward procedure stopped, so first read the state: the local `.runner`
file (present or not, and which URL it names), the service (installed, running), and the org and repo
runner lists.

| State found | Remove with | Then |
|---|---|---|
| registered at org level (forward finished) | stop the service; `config.sh remove` with an **org** removal token (`POST orgs/Creathyst/actions/runners/remove-token`) | register at the repo |
| local config present, no GitHub registration (interrupted, or deleted by hand) | clear the local registration as the runner docs describe | register at the repo |
| still registered at the repo (forward never reached item 3) | nothing | restart the service, done |

"Register at the repo" is items 5–7 with `--url https://github.com/Lbstrydom/wine-cellar-app`, a **repo**
registration token, no `--runnergroup`, then the service started the way item 1 recorded.

## 4. Runbook (option A)

Each step names who acts. **Owner** = a click or a setting only the owner makes. **WCA** = the wine
coordinator or a wine PR. **CES** = a CES PR. Nothing in this plan is done by the session that wrote it.
**D2** (§2.1) decides between steps 2S and 10F; exactly one of them runs.

### Before the day

1. Owner: decide D2 and D5. (Done: D0 = A, and Creathyst exists on Team.)
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
   - Actions permissions and default workflow permissions;
   - code-security settings, each read from its own endpoint (the repo's `security_and_analysis` object
     comes back empty, so it cannot be the record). Measured 2026-11-23, all **off**: secret scanning
     (and so push protection) disabled; Dependabot alerts disabled (`vulnerability-alerts` 404); Dependabot
     security updates disabled (`automated-security-fixes` `enabled: false`); code scanning not enabled; no
     code-security configuration attached. Step 3 re-reads them on the day;
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
     For **each** store: the `audit_repos` row by uuid, wine's rows in `audit_effectiveness` and
     `persona_density_per_repo` (every projected column), and the persona session count (66 on the measured
     store; each store's own numbers are its own baseline);
   - every clone of wine on every machine the owner uses (`git remote -v` per clone);
   - which branch Railway deploys production from (`main` today; `release` once wine #1421 is live);
   - the runner-status token's resource owner, repository list and permissions (not its value);
   - the workflow matrix (Verification): one row per workflow that uses a secret, a token write, the
     registry or an integration, with its trigger and a safe way to run it (WCA fills this).
4. Owner: settle the rollback question (§5.2): ask GitHub Support whether a repo can be transferred back
   into its retired `OWNER/NAME`. Record the answer as D5.
5. Owner: on Creathyst, set Actions policy to the step 3 values, and confirm rulesets are available on the plan.
   Re-read the four org settings above with an owner token and record them as done only when they read back.
5W. **Workflow token permissions.** The org's default workflow permission caps every repo in it, so if it is
   read-only, a workflow that writes with the default `GITHUB_TOKEN` and declares no `permissions:` fails
   after the move. Inventory at wine `origin/main`, 2026-11-23 (`permissions:` blocks and every write: `git
   push`, `gh` write commands, `github-script`, build-push, `*: write` scopes):

   | Workflow | Declares `permissions:` | Writes with the token |
   |---|---|---|
   | `benchmark.yml` | **no** | **yes**: job `fixture-staleness` creates an issue with `actions/github-script` |
   | `arch-drift-scoped.yml`, `rating-smoke.yml` | no | no |
   | `pg-compat-test.yml` | on 3 of 7 jobs | the undeclared jobs only read |
   | the other 16 | yes (top level or per job) | where they write, the scope is declared (`issues`, `packages`, `contents`/`pull-requests`) |

   So **one** job must declare `permissions: { issues: write }` before the transfer (a WCA edit). It is
   already broken today, independent of the move: wine's repo default is already `read` (measured), and its
   `if: failure()` follows a `continue-on-error` step, so it never runs anyway. WCA fixes both or deletes
   the step. Step 3 re-runs this inventory on the day, since workflows change.
   Then set Creathyst's default workflow permission to **read**, matching wine's.

### The day: freeze, transfer, restore protection first

6. **Freeze** (WCA, then owner). WCA tells every wine worker session to hold (no push, no merge, no tag
   writes); the owner pauses the CES and WCA coordinators' merge authority for the window. Disable the
   scheduled workflows that step 3 marked as writing and enabled, record which ones were disabled, and wait
   until `gh run list --status in_progress` and `--status queued` are both empty (cancel any that are not).
   Auto-merge is on for the repo (`allow_auto_merge: true`, `measured`): turn it off for the window, so that
   a queued auto-merge cannot land while the gate is being restored. The freeze holds until step 16.
7. Owner: Settings → Danger Zone → Transfer → Creathyst. Takes effect at once.
8. Owner: **rulesets first** (a static check, no runner needed). Compare all rulesets against the step 3
   JSON (three today, four once wine #1421's `release` ruleset exists); re-create any that is missing or
   differs. The merge gate is now configured, but not yet proven.
8R. Owner: **the runner**, still frozen (§3, items 1–7). It comes before the negative control because the
   jobs behind `Required gate` may be placed on the self-hosted runner at run time (`pg-compat-test`'s
   `scope` job picks the runner), and a check that stays queued proves nothing.
8N. Owner: **negative control.** A scratch PR to `main` that makes one job behind `Required gate` fail on
   purpose (a one-line failing assertion in a unit test). Pass condition: within 45 minutes the
   `Required gate` check **completes as failed** and the merge button is blocked. A check still queued at
   45 minutes is a failure of this step, not a pass. Then close the PR and delete the branch.

### Then, in order

9. Owner: every clone from step 3: `git remote set-url origin https://github.com/Creathyst/wine-cellar-app.git`;
   in the same sitting, update `LEARNING_REPO_NAME` in wine's `.env` and the bridge file. No profiled audit
   runs anywhere until this is done.
10. **Store cut-over, immediately after step 9**, so the window in which the new `LEARNING_REPO_NAME` and
    the old row name disagree is minutes, not days, and inside the freeze:
    - D2 = structural: WCA runs one `/audit-plan` round on any wine plan, in a repointed checkout, once per
      store from step 3 (a profiled audit writes only to the store its checkout is configured for). That
      audit is what renames the row on that store.
    - D2 = fallback (10F): the owner runs the fallback transaction (§2.1) on each store instead.

    Then run the store checks from the verification list on each store, against that store's own baseline.
11. Owner: **runner-status token.** Issue a fine-grained token with **Creathyst** as resource owner, wine as
    its only repository and the same permissions as the old one (step 3 records them; approve it in the org
    if the org requires approval), replace the secret's value, and run the runner-health check once against
    `repos/Creathyst/wine-cellar-app`. A secret-name comparison cannot catch an old token in a new name.
12. Owner: install the Railway GitHub App on Creathyst with access to wine; refresh or re-link the service
    source. Install any other app from step 3 that lost access.

    12S. **Code-security configuration, explicitly.** Re-read wine's security settings (step 3 list). If
    anything attached a configuration on transfer, or a setting differs, attach one that matches the step 3
    record. Wine has every feature off today, so the risk is the other way round from usual: a configuration
    would **enable** features, not disable them. Enabling is a separate owner decision, not part of the
    move: Dependabot alerts and security updates are free; secret scanning and push protection on a private
    repo are paid GitHub Secret Protection, and code scanning is paid Code Security
    ([pricing](https://github.com/pricing) add-ons; `expected`, confirm the cost before enabling). Until
    then, keep the org's default configuration for new repos unset, as the owner already is.
13. Compare the live state against the **expected** state, item by item (names, not only counts). Re-enter
    any missing secret or variable from its recovery source. Any difference not fixed now is a rollback
    trigger. The expected state is the step 3 baseline except where the plan changes it on purpose:

    | Baseline item | Expected now |
    |---|---|
    | rulesets, secrets, variables, environments, webhooks, deploy keys, autolinks, Actions settings | equal to baseline |
    | runner-status token | new value, Creathyst-owned, health check passed (step 11) |
    | GitHub Apps | equal, but installed on Creathyst (Railway and any other app re-granted at step 12) |
    | code-security settings | equal to baseline (all off), unless the owner chose otherwise at 12S |
    | default workflow permission | `read`, now set at org level (step 5W) |
    | clone origins, `LEARNING_REPO_NAME`, bridge file | the Creathyst slug (step 9) |
    | store rows | same uuid and row id; name `Creathyst/wine-cellar-app`; each store's view rows and session counts equal its own baseline (step 10) |
    | runner | org-level, in the group, same name and six labels (step 8R) |
    | scheduled workflows, auto-merge | disabled / off as recorded at step 6, until step 16 |

14. **Canary, still inside the freeze.** The owner's go for this one change is the exception to the freeze,
    given at step 6. Its route depends on where Railway deploys production from, which step 3 records:
    - **Railway deploys `main`** (wine #1421 not yet live): WCA opens one PR to `main` with the §2.3 edits;
      its merge sha is the one to see deployed.
    - **Railway deploys `release`** (wine #1421 live): the same PR merges to `main`, then WCA's normal,
      protected promotion fast-forwards `release` to that `main` sha after its checks pass. The `release`
      sha is the one to see deployed, and the promotion is the second freeze exception.
    Then run the workflow matrix below.
15. If any verification item fails: fix it under the freeze, or roll back.
16. Unfreeze: re-enable exactly the workflows step 6 recorded as disabled, turn auto-merge back on, restore
    the coordinators' merge authority, tell WCA to resume.

### Verification (each a measurement, not a glance)

- **CI**: the step 14 PR runs green, including a self-hosted job on the re-registered runner, and its merge
  waited for `Required gate` (step 8N proved the negative case).
- **Workflow matrix.** A PR and a merge do not trigger every workflow, so WCA fills this table at step 3 for
  every workflow that uses a secret, a token write, the registry or an integration, and each row is run
  once after step 14:

  | Workflow | Trigger it needs | Safe way to run it in the window | Expected |
  |---|---|---|---|
  | `docker-publish` | push to `main` touching image paths | `workflow_dispatch` (it has one) | publishes `ghcr.io/creathyst/wine-cellar-app`; the image-size step reads the new package |
  | `consistency-canary`, `visual-audit`, `sql-schema-compat` | deploy-related | `workflow_dispatch` where present, else the canary merge | green against the deployed sha |
  | `monitor-alert`, `workflow-cadence` (issue writers) | schedule | `workflow_dispatch` where present, with an input or condition that **reaches** the issue write | the issue (or its close) appears; the test issue is then closed and labelled as a test |
  | `benchmark` `fixture-staleness` | schedule, on stale fixtures | after WCA's 5W fix, a dispatch that forces the stale path | the issue appears and is closed; if WCA deletes the step instead, this row is removed and the deletion recorded |
  | runner-health tooling | manual | step 11 | passes |
  | any other row WCA adds | | | |

  A workflow with neither a dispatch trigger nor a safe event is listed as **unverified**, with the date of
  its next scheduled run, and checked then.
- **Deploy**: the sha named at step 14 is deployed on Railway; `wait-for-deploy.mjs --expect-sha <that sha>`
  sees it.
- **Webhook**: the third-party service shows a delivery for the canary push.
- **Store** (after step 10), on each store wine writes to, against **that store's** step 3 baseline: the row
  found by uuid is still the only row and is named `Creathyst/wine-cellar-app`; the `audit_effectiveness`
  and `persona_density_per_repo` rows for wine equal their baseline values (on the measured store that
  includes 66 sessions; any drop to 0 is the failure this guards); a name lookup with the new
  `LEARNING_REPO_NAME` resolves the row.
- **Sync**: from CES, `npm run sync:dry -- --target wine` shows no unexpected change, and `sync-pr` resolves
  the repo.
- **Blacksmith** is not part of this verification. It starts only after everything above passes (§6).

### Rollback

Triggers: step 8 or 8N cannot restore enforcement, or a step 13 or verification item fails and cannot be
fixed within the freeze. Who: the owner, with WCA reverting wine-side config. Its own order and expected
state, not the forward ones:

1. Re-freeze (step 6), if the freeze was lifted.
2. **D5 = transfer back allowed**:
   1. Creathyst → Settings → Transfer → `Lbstrydom`.
   2. Rulesets: compare with the step 3 JSON; re-create what differs.
   3. Runner: the §3 rollback items, back to repo level. If re-registration fails part-way, the runner is
      offline, not misregistered: required checks queue rather than pass, so the freeze holds until it is
      fixed; nothing merges in that state.
   4. Negative control as at step 8N, at the old location.
   5. Every clone's origin, `LEARNING_REPO_NAME` and bridge file back to the old slug.
   6. Store, per store: D2 = structural, WCA runs one profiled audit in a reverted checkout, which renames
      the row back; D2 = fallback, the reverse transaction. Then check each store against its step 3
      baseline, including a name lookup with the old slug.
   7. Runner-status token: re-issue for the old owner, replace the secret, run the health check.
   8. Railway re-linked to the personal installation.
   9. If the canary PR merged, WCA reverts it (and, if it was promoted, re-promotes `release`).
   10. **Expected state = the step 3 baseline**, item by item, including the runner at repo level and the
       old slug everywhere. Then the deploy, webhook and CI checks from the verification list, with the old
       URLs. Only then unfreeze per step 16.
3. **D5 = transfer back not allowed**: there is no clean rollback, only forward recovery: fix the failing
   item in place, under the freeze. The owner accepts that before step 7, or does not transfer.

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
after (verification), and treat GitHub App installations as needing a fresh install on Creathyst (Railway's
included). Org-level Actions policy can be stricter than a repo's, so Creathyst's is set first (step 5).

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
| Included Actions compute | $18/month (about 3,000 Linux minutes, `derived`) | $12/month (about 2,000) | 3,000 minutes/month ([pricing](https://github.com/pricing)) | [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) |

With no payment method, GitHub-hosted usage is **blocked** when the included quota runs out (same billing
page). The owner's Pro allowance stays with the personal account and keeps covering the other personal repos.

### 5.4 Runners

- Whether a repo-level self-hosted runner survives a transfer: not documented. A runner that has not
  connected for 14 days is removed automatically.
- Runner groups: [Managing access](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/manage-access)
  says Team **or Free** orgs can create extra groups with "Selected repositories" access;
  [Runner groups](https://docs.github.com/en/actions/concepts/runners/runner-groups) says Team. They
  conflict; read Creathyst's settings page once the org exists.

### 5.5 Who can transfer

Admin on the repo plus permission to create repos in Creathyst; Settings → Danger Zone → Transfer [T]. Creathyst
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
- **Install** the Blacksmith GitHub App on Creathyst with **Only select repositories → wine-cellar-app**.
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

- **D0**: decided, option A (Creathyst on Team, 2026-11-23).
- **D1**: decided, `Creathyst`.
- **D2**: structural view migration (step 2S, recommended) or the operator rename inside the freeze (step
  10F). Exactly one.
- **D4**: Blacksmith with a card on file (it requires one), the $25 alert, eu-west by support request (§6).
- **D5**: GitHub Support's answer on transferring back into a retired name (step 4); if "no", accept forward
  recovery only, or do not transfer.
- **Freeze window**: a date and length agreed with WCA (step 6). WCA's calendar (2026-11-23): an alpha
  release candidate is cut around 24 Nov (the `release` branch, its ruleset and Railway's source switch), live
  participant testing starts 1 Dec, alpha invites go out 8 Dec. A transfer touches exactly those three
  things, so WCA advises **no transfer before 8 Dec, preferably after the participant-testing window**. In
  flight at the time: three Dependabot PRs and one owner-held promotion PR, all to merge or park before the
  freeze.

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
- Post-gate additions (2026-11-23, at the CES coordinator's request and with WCA's inputs): Team price and
  the Free-vs-Team repository-rules line verified on the pricing page; the plain answer in §1; the `release`
  ruleset (wine #1421); runner-status token, runbook ids, CODEOWNERS and host-lock token rows; WCA's freeze
  calendar. Re-gated as Gemini round 2.
- Org decided (2026-11-23): placeholder replaced by `Creathyst` (Team); owner-reported org settings recorded
  with their read-back; step 5W (workflow token permissions, one undeclared writer found) and step 12S
  (code-security configuration; wine has every feature off) added. Audited as a fresh short pass (below).
- Short pass R1 (GPT): 5 HIGH, 3 MEDIUM, all accepted. Canary route depends on Railway's deploy branch
  (`main` or `release`); runner restored (8R) before the negative control (8N), which needs a completed
  failing check within 45 min; rollback given its own order and expected state, including the reverse store
  rename; per-store preflight stop conditions and the fallback transaction's predicates and row-count
  assertions; runner-status token rotation as step 11; a workflow verification matrix; per-store baselines
  instead of 66 everywhere; DB-test enrolment for the migration.
- Short pass R2 (GPT): 2 HIGH, 2 MEDIUM, all accepted. Migration backfills null `repo_id` before the view
  change; preflight compares the exact existing join, not basenames; state-aware runner rollback with an
  org removal token; conditional workflow writes must actually be reached in verification.
- Short pass final gate (Gemini, round 1 of 2): APPROVE, 0 blocking, 0 debt.
