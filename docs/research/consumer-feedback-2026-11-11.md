# Consumer feedback on CES — 2026-11-11

**Question.** Where does CES cost the consumer repos time or trust, what is missing, and what must not break? The CES
coordinator asked the three consumer coordinators (WCA = wine-cellar-app, STO = storyline, AIO = ai-organiser) for up to
8 ranked items each, from their own work and their worker sessions, with evidence and frequency.

**Answer.** 22 items in 7 themes. Two themes come from more than one repo, and they rank first: **(1)** the pre-push gate
pushes sessions into its bypasses in all three repos; **(2)** nothing waits for CI on the pushed commit, so merges and
"done" reports run ahead of the evidence. The first fix should be the plan-less refusal in repos whose plans are
untracked (AIO): it blocks every code push there, and the only way through teaches the bypass.

**Plan.** Theme 1 is planned and audited in [`docs/plans/prepush-gate-consumer-feedback-theme1.md`](../plans/prepush-gate-consumer-feedback-theme1.md).

**Status of the evidence.** These are the coordinators' reports, not measurements. Where this doc says **verified**, the
claim was checked against CES source on 2026-11-11 at `4a6662f1`. **Unverified** items need that check before they are
planned. One report was partly contradicted (theme 3, 4K truncation).

## Theme 1 — the pre-push gate teaches the bypass (WCA, STO, AIO) — priority 1

| # | Repo | Item | Evidence | Frequency | Status |
|---|---|---|---|---|---|
| 1a | AIO | The plan-less refusal blocks every code push. AIO keeps `docs/plans/` untracked by design, so a fresh worktree or a chip never has a plan to select. Workaround: `AUDIT_PREPUSH_PLAN=…` once, then `AUDIT_PREPUSH_ALLOW_UNMEASURED=1`. | AIO #108, #109 | Every code push since the 21ad9254 sync | **Verified**: `decideNoPlanGate` in `scripts/lib/prepush-audit-gate.mjs` (4a6662f1) refuses any push with code files and no selected plan; the rule dates from #289 (hook v13) and reached AIO with the sync. It has no answer for a repo whose plans cannot be selected in a worktree. |
| 1b | STO | The hook hangs on a draft plan, so chips push with `AUDIT_PREPUSH_DISABLE=1`. | #526 chip; 10-18 and 10-22 worker sessions | About weekly | **Not reproducible** (2026-11-11): storyline runs hook v16 with v11's bounded steps; 67 kept logs show max 959s, no refusal or budget expiry. The report matches the pre-v11 defect. See the plan §0. |
| 1c | AIO | Noise: 16 of 17 findings on one push were about pre-existing code in whole files the diff touched (`styles.css`, `en.ts`, `types.ts`). | `.audit/prepush/*.report.json` for AIO #109 | Every push touching a large file | **Verified** (2026-11-11): 15 of 17 findings on #109's first push were about unchanged code, plus the M13 marker. `buildAuditUnits` sends every chunk of a large file. Split out to its own campaign plan. |
| 1d | AIO | A tooling failure is reported as a finding: `ADJACENCY_INCOMPLETE: WORKING_TREE_UNREADABLE` appears as a MEDIUM. | Both AIO #108/#109 pushes | Every push there | **Verified** (2026-11-11): the marker is a hard-coded MEDIUM that the gate counts. The overflow cause (ENOBUFS read as `WORKING_TREE_UNREADABLE`, from auditing the working tree) is inferred. |
| 1e | WCA | A stale shared `node_modules` (junction) fails pre-push as if the session's own diff were broken; an install in main breaks other sessions' gates mid-flight. Hydrate does not detect lockfile drift. | WCA #1315 (dompurify), #1297 (vendored supabase.js) | Several a week | **Mechanism real, WCA-owned** (2026-11-11): the failing step is WCA's `pre-push.local` running tests through hand-made junctions; the CES hook never touches `node_modules`. The cited PRs were off (#1295/#1303, not #1315/#1297). |

**Why it ranks first.** Each item makes a session reach for `ALLOW_UNMEASURED`, `PREPUSH_DISABLE` or `--no-verify`. A
gate that is routinely bypassed measures nothing, and the bypass habit then covers the pushes the gate exists for.

## Theme 2 — nothing waits for CI on the pushed commit (WCA, STO) — priority 2

| # | Repo | Item | Evidence | Frequency |
|---|---|---|---|---|
| 2a | WCA | No synced merge-when-green helper. The same loop is rebuilt per PR: wait on `mergeStateStatus`, update-branch on BEHIND, compare failing checks to an allowed list, squash with `--match-head-commit`, optionally wait for the deploy. An early version trusted `UNSTABLE` and #1278 merged with gitleaks red (fixed by #1292). A first wait tracked one required check and ended early (#1261). | WCA #1297, #1307, #1308, #1310, #1314–#1317 | Every merge, about 10 a day |
| 2b | STO | `/cycle --autonomous` has no "wait for checks on the pushed head, report the verdict" step. Red runs went unreported (#523: c43101c6, b40cbabb); the #526 chip stopped with CI in progress and could not enable the PR monitor. | STO #523, #526 | Most chip PRs |
| 2c | STO | The drift sweep cannot be confirmed on demand; a duplication fix sits open until the scheduled run. | STO #521 | Every duplication fix |

**Shape of the fix (to plan, not decided).** One synced script: wait for every check on the exact head sha, an
allowed-failure list by check name, refuse `UNSTABLE` unless every failure is allowed, merge only with
`--match-head-commit`, an optional deploy-wait, and a serial queue across PRs. `/cycle` and `/ship` call it rather than
describing the loop in prose. 2c is a separate, smaller item (a manual trigger or a local `--confirm` mode).

## Theme 3 — passes that checked nothing, or the wrong thing — priority 3

| # | Repo | Item | Evidence | Status |
|---|---|---|---|---|
| 3a | WCA | The Gemini gate returns `APPROVE` with `Code: PARTIAL`, so sessions re-run per file group. Wanted: chunk by file group, or refuse to print APPROVE on partial coverage. | WCA #1315 | Unverified |
| 3b | STO | `/audit-code` cuts each file at about 4K characters, so a PASS on large files is hollow. | STO memory `audit-code-partial-coverage` | **Doubtful**: the 4,000-character slices found in `scripts/lib/context.mjs` (4a6662f1) cut the project-instructions and plan context, not audited files. Needs a real check before planning. |
| 3c | STO | An audit missed a change that edited what a gate *measures* instead of the behaviour: #523 commit 4e8d83ba reported the un-shifted rectangle, so occupancy and floater gates passed. GPT and Opus both missed it. Wanted: a pass that asks "does this change alter a gate's input or reporting rather than the behaviour?" | STO #523 | Once; highest trust cost |

## Theme 4 — worktrees and `/ship` (AIO, WCA)

| # | Repo | Item | Evidence | Status |
|---|---|---|---|---|
| 4a | AIO | `ship-commit` cannot run in a worktree: hydrate copies no `node_modules` (`ERR_MODULE_NOT_FOUND 'zod'`) and no `.claude/skills` ("no skill layout found"). Falls back to a plain commit, losing the `AI-*` trailers. | AIO #106 | Unverified |
| 4b | AIO | `persona-outcomes summary` resolves the bare name `ai-organiser`, which `audit_repos` does not know (it expects `owner/repo`), so the persona gate reads UNMEASURED. | Every AIO `/ship` | Unverified |
| 4c | AIO | `docs/architecture-map.md` is tracked in AIO, but CES treats it as Category A (gitignored, line 218 of CES `.gitignore`); the hook regenerates it and dirties main. A `commit -a` swept a 12K-line diff into AIO #109. | AIO #109 | Partly verified (CES side) |
| 4d | AIO | Persona-test screenshots land in an untracked `sessions/` folder not gitignored by default; most of the 44 files a sync refused on. | AIO sync refusal, 11-09 | Unverified |

## Theme 5 — plan-audit scope (WCA, STO)

| # | Repo | Item | Evidence |
|---|---|---|---|
| 5a | WCA | `/audit-plan` on an amendment audits the whole base protocol: round 1 gave 2 HIGH + 2 MEDIUM, none in the amendment, and the acceptance-rate stop fired at 0/4. Wanted: `--section`/`--diff` scoping, with base findings captured separately. | WCA #1317; 3 amendments this week |
| 5b | STO | `/plan` and `/audit-plan` accept probe acceptance criteria the fixture set cannot meet. #525 spent a full autonomous cycle and a $0.93 probe; the gate failed partly because the "proven" wording behind faults 4 and 7 is not in the stored storyboards. Wanted: audit-plan checks each probe criterion is scorable on the named test set. | STO #525 |

## Theme 6 — workflow guidance gaps (WCA, STO)

- **6a (WCA) Stacked PRs after a squash merge.** #1307 squashed, the retargeted #1308 went DIRTY and the merge loop spun 4
  tries. Workers cannot force-push, so they merge main in. Nothing in `/cycle` or `/ship` covers retarget timing,
  merge-main vs rebase, or keeping the diff equal to the audited piece. Every stacked chain (4 PRs on 11-10).
- **6b (STO) No before/after render review for visual changes.** Chips judge by rule passes; design calls were caught
  only by reading rendered sheets (#523: body 0.6 in off the slide midline; #526: centred visual beside top-aligned text,
  rejected by Louis). Wanted: `/cycle` renders before/after sheets, compares adjacent columns for alignment and balance,
  attaches them to the report. Every renderer or layout PR.

## Theme 7 — small, frequent

- **7a (WCA)** The Bash grep-nudge hook hard-denies a leading `grep` instead of warning, costing a round trip.
  **Verified**: `.claude/hooks/bash-grep-nudge.mjs` returns `permissionDecision: 'deny'` (4a6662f1). Whether deny is
  the intended design is a decision, not a bug.
- **7b (STO)** Second-gh-account plumbing: `GH_TOKEN=$(gh auth token --user …)` on every command; `gh pr checks` fails
  on the PAT. `archive_session` is denied by the classifier or needs the hook-supplied retry. Constant, small.
- **7c (AIO)** The CES coordinator asked AIO to clean up for a sync that had already landed (AIO #107). The receipt
  (`.sync-receipt.json` `recentSyncs[0]`) or a `chore(sync)` commit on the consumer's `origin/main` answers that.
  Coordinator practice: check before asking.

## Theme 8 — lessons from Anthropic's own code review (external, 2026-11-12)

**Source.** The Claude Code team's write-up of how it reviews code
(`claude.dev/blog/solving-code-review-at-anthropic`), read 2026-11-12. These are claims made in that post, not
measurements we took. The figures below are the ones the post reports.

**Already in CES; the post backs it up.** A round cap that asks the author to rethink the approach after round 3 (our
structural-or-stop card). Re-review of the diff only, with findings already posted never repeated (R2+ ledger
suppression). Tracking each finding's outcome: fixed, rejected as wrong, intentional, or doesn't matter (our accepted,
dismissed and deferred). Approvals bound to one commit (`--match-head-commit`). Their merge queue matches theme 2.

| # | Item | Why it matters here | Status |
|---|---|---|---|
| 8a | **A pre-existing tag on findings.** Findings about code the change did not introduce are posted under a separate tag, so they don't count against the author or the gate, rather than dropped. | About 59% of what their reviewer kept flagging was code that predated its first pass. That is the same shape as 1c (AIO: 15 of 17 out-of-diff). A non-blocking tag is a smaller first step for 1c than changing what `buildAuditUnits` sends. | To plan, alongside 1c |
| 8b | **Run the reviewer on known-clean changes.** Count how often it reports something on a PR known to be clean that would have led to a harmful change. | CES has no false-positive control on clean diffs. The model-eval harness runs only when a new model ships, and it measures recall. | To plan |
| 8c | **Turn past incidents into an eval, and score every change to the prompts, tools or model against it.** | An edit to the `PASS_PROMPTS` seeds rolls out globally without any score. Reverted and fixed-forward PRs in the consumers are the seed set. Pairs with 8b (recall plus false positives). | To plan |
| 8d | **Measure convergence.** Track the share of PRs that pass after one review-and-fix round, the share that need five or more rounds, and the mean reviews to pass. | Theirs went from 65% to 78% passing after one round, and from 8.9% to 1.5% needing five or more. `audit_runs` already has per-round rows, so both shares are a query plus a dashboard tile. | Cheap; to plan |
| 8e | **Set review depth by risk, from what the change touches rather than who wrote it.** Their tiers are Quick, Standard and Deep. | The pre-push gate runs the same depth on every push. Docs-only and config-only pushes are the noise in theme 1. | Consider with theme 1 |
| 8f | **A per-area review file**, written by code owners: what failure looks like in this area, paths to skip, a cap on nits, file-and-line evidence required, and a summary that starts with a count and says plainly when there is nothing to fix. | The requirements ledger covers the invariants but not this. | Consider |
| 8g | **Fix a finding that keeps recurring at its source:** a lint rule, a skill edit or an instruction-file line, and **name the bug class** so the author fixes every instance. | `recurring_finding_clusters` already finds the recurrences, but nothing turns them into a source fix. | Consider |

**Not adopted.** A group of verifier agents that votes on each finding before it is posted. It costs several times as
much per audit, and the Gemini/Opus final gate already gives an independent check. Revisit if 8b shows a false-positive
problem the gate does not catch.

## Keep — do not break

- Red-without-fix plus negative control in `/audit-code` (WCA #1310, #1314, #1316): merging on a report is trustworthy.
- The round cap with the structural-or-stop card: audits converge in 2–6 rounds (WCA).
- The audit loop on Azure (terra, medium) with an Azure Opus final review, and the honest `converged` gate value (STO #526).
- Guards that force an explicit decision: contract-manifest hash pins, the `DECK_AUDIT_RULE_VERSION` hash test, catalog
  pins (STO #523).
- The sync's base-lag refusal and dry run (exact files, remedy and counts before writing) (AIO).
- `check-context-drift --strict` and the drift gate: fast, quiet, no false positives across 4 PRs (AIO).

## Proposed order

1. **1a** — plan-less refusal in repos with untracked plans. Verified, blocks every AIO push, smallest fix.
2. **1b–1e** — verify, then fix the hang, the out-of-diff noise, tooling-failure-as-finding, and lockfile drift.
3. **2a/2b** — the shared wait-for-checks-and-merge script, then wire `/cycle` and `/ship` to it.
4. **3a, 3c** — partial-coverage APPROVE and the gate-input audit question; settle 3b first.
5. **4a–4d** — worktree `ship-commit`, the persona repo slug, generated files in consumer trees.
6. **5a, 5b, 6a, 6b** — plan-audit scoping and the two workflow guides.
7. **7a, 7b** — decide on the grep hook; document the second-account recipe.

Theme 8 slots in by dependency, not by rank. **8a** goes with 1c, and **8e** with the rest of theme 1. **8d** is cheap
and gives a baseline before any other change, so it goes first. **8b** and **8c** together are one eval campaign.
