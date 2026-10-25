# Backlog triage + arch drift — 2026-10-25

- **Status**: Complete
**Scope:** fleet proposals (54), consumer-filed upstream reports (3), arch drift, 15 local `archive/*` tags.
**Base:** `main` at `6d3b34e1`. Figures are labelled *measured* (with the command), *derived*, or *expected*.

## 1. Arch drift

| Figure | Value | Label / command |
|---|---|---|
| Drift status | RED, score 21 / threshold 20 | measured — `npm run arch:drift` |
| Duplication pairs | 21 | measured — same run |
| Layering violations (dep-cruiser) | 0 | measured — same run |
| Corpus | 5,817 symbols | measured — same run |
| Index freshness | **165 commits behind `origin/main`** (indexed at `a6b035b3`, PR #125) | measured — the report's own freshness line |

**Read the table with the freshness row first.** The run measured an index 165 commits old, so "0 layering violations" is a statement about
`a6b035b3`, not about today's code. A fresh `npm run arch:refresh` is heavy and was NOT run: the machine's heavy slot was held by another repo's gate for the whole session (the
request waited in the lease queue, then was withdrawn). **Open follow-up:** `node scripts/fleet.mjs lease run --kind gate -- npm run arch:refresh`,
then `npm run arch:drift`, when the slot is free; until then treat the layering figure as unmeasured for current code.

Top duplication clusters (all test-helper duplication, none in `scripts/`): `write` ×3 (`tests/claudemd/file-scanner-gitignore`,
`ship-commit-worktree-identity`, `symbol-index-corpus-ownership`), `writeRoundLedger` ×N (`tests/debt-auto-capture-*`), `seedLedger` ×2,
`sha12` ×2, plus seven two-member tails (`withCwd`, `at`, `git`, `stubDeps`, `requiredValue`, `makeDeferEntry`). 26 justified declarations
are excluded; 5 `@duplicate-justification` pragmas are unresolved (`scripts/lib/is-source-repo.mjs:44`, `scripts/lib/sync-inventory.mjs:382`,
`scripts/sync-to-repos.mjs:797`, two in `tests/`).
**Derived:** the RED is a *test-helper* signal — a shared `tests/helpers/` module for `write`/`writeRoundLedger`/`seedLedger` would clear it;
it is not a production-layering problem. Folded into cluster C below as a low-priority tail, not its own chip.

## 2. Triage — counts by class (derived from §4; 54 proposals)

| Class | n | Notes |
|---|---|---|
| ALREADY DONE (closed `--done`) | 6 | f94f #242 · fd60 #250 · 63bd #263 · 5ec9 #248 · 33e5 #287 · b16d (archive tags verified, §3) |
| IMMEDIATE (shipped in PRs below) | 3 | 82e1, f136, ddc3 (ddc3 was half-wrong: Haiku 5.5 was already correct, only the Fable row was missing) |
| DECLINE | 1 | 806f |
| DEFER (with trigger) | 18 | 10 own-model-telemetry + 8 others |
| CLUSTER | 26 | §4, grouped in §5 |

Upstream reports (`npm run upstream:issues`, measured): 3 open, all from wine — two duplicates of the Sonnet/Opus 5.5 cache-read price
(`14a7ef5a`, `fa8cf7ed`; fixed by #279, close with `upstream fix --commit 47321e8f`; the second is wine's own non-synced `lib/model-pricing.mjs`,
so it is a wine-side fix) and `d4dada5d` (Gemini PARTIAL for a changed test file names neither file nor reason — belongs to cluster D).

## 3. Archive tags (15, all local-only)

Method: per-commit added-line hit rate against the same files on `origin/main`, then distinctive-identifier greps; carry candidates were
cherry-pick dry-run with `git merge-tree`. Detail: the sibling note `archive-tags-verdicts.md` in the shared notes folder.

| Tag | Verdict | Evidence |
|---|---|---|
| `archive/claude/elegant-volhard-cf100d` | DROP | superseded by the full plan, #199/#216 |
| `archive/claude/fleet-chip-intake-policy` | DROP | same title shipped as #237 |
| `archive/claude/ship-trains-plan` | DROP | plan on main; trains shipped #211/#219/#224 |
| `archive/debt-ledger-per-entry-2026-10-13` | DROP | #247, 95–100% line hits |
| `archive/fleet/prune-apply-handoff` | DROP | `applyPrune`/`--apply` on main (#216/#220) |
| `archive/prune-apply-handoff` | DROP | same tip (726b3960) as the row above |
| `archive/keep-203-rebased-2026-10-12` | DROP | #203 merged it |
| `archive/worktree-agent-a17ae37087cdde225` | DROP | #202 |
| `archive/worktree-agent-a3431c2e33d303e8a` | DROP | all 14 commits present by content (atomic `--out`, carried edges, `softFail`, replay false zero all found) |
| `archive/worktree-agent-a68f29248c8b90190` | DROP | #125 |
| `archive/worktree-agent-a7729e417bceceb2b` | DROP | #205, pin superseded by #148/#159 |
| `archive/worktree-agent-a8895e6b04909c52f` | DROP | #203 |
| `archive/worktree-agent-aa03e61f5a6524a00` | DROP | #218, #215 and the rest by content |
| `archive/worktree-agent-ad8559f27235c40c9` | DROP | #204 |
| `archive/worktree-agent-ad59c28b45a55cd82` | **CARRY INTO CLUSTER D** | 3 final-review fixes absent from main (below) |

Carry items on `ad59c28b`: `94b59fe2` (a `finish_reason:length`/`MAX_TOKENS` truncation reads as "reviewer found little"; one test conflict),
`b3849183` (`runShadow` drops `requestIdentity`, so `sr.requestIdentity` is always null; clean cherry-pick), `dd0f2ed7` (campaign-scope refusal
before the primary is billed, run-id recovery bound to the transcript, `ProviderNotReadyError` instead of `process.exit(1)`; conflicts in
`gemini-review.mjs` and `.file-size-baseline.json`). `d9eda256` is an optional refactor that only makes sense with `dd0f2ed7`.
**Recommendation for Louis:** delete 14 tags, keep `archive/worktree-agent-ad59c28b45a55cd82` until cluster D lands; push none to origin.
Nothing was deleted by this chip.

## 4. Proposal-by-proposal (ids abbreviated to the last 4 hex)

- **DONE:** f94f→#242, fd60→#250, 63bd→#263 (`gemini-review.mjs` calls `recordFinalReviewMarker`), 5ec9→#248 (branch tier + CI verdict
  replaced the interim rule), 33e5→#287 (`lease run` records not-granted as `refused`, wrapped exit as `childExit`), b16d (§3).
- **IMMEDIATE (this triage's PRs):** 82e1 (refusal metric counts only `ready`/`land`), f136 (NUL stripped at the db write seam, column named),
  ddc3 (Fable 5.1/5 price rows; Haiku 5.5 verified already right).
- **DECLINE:** 806f — measured 0 collisions in wine and storyline; the three `scripts/*.mjs` in ai-organiser are its own pre-isolation leftovers,
  an AIO-side cleanup, not a predicate change.
- **DEFER:** own-model-telemetry ×10 (8d3d 4af2 03db df18 b6ee ed8b 34c0 56a4 cd0e bc17) — until Louis decides the own-model roadmap ·
  e5a8 — until the eval-credibility audit (140c) reports · 896b — until the first real release run (workflow has never run) ·
  5bf9 — until trains are in routine use (≥3 train runs to measure) · 4da4 — first containerised fleet host · 0d7c — next time ≥3 archived
  branches are unproven after the subject-match check · 0c85 — next ride-along misclassified as config · 4732 — until storyline's CI-hold
  guesswork costs a measured wasted slot · 2c93 — next `BRANCH_EXISTS` dead-end on a sync PR.
- **CLUSTER A (prepush convergence):** 484f, df45, 70b5, 5c16.
- **CLUSTER B (sync contract):** d93e, 2221, da9a, a5ce, 689c, 5bc2.
- **CLUSTER C (hook fidelity):** 4146, ecff, 619c, fac2, 981b, a2b8 (+ the test-helper duplication tail from §1).
- **CLUSTER D (final-review reliability):** 0ace + the archive carries (§3) + upstream `d4dada5d`.
- **CLUSTER E (small, parallel-safe):** 1c46 (Azure Haiku brief 401).
- **LATER CLUSTERS:** adoption-fit (81f8, e216), fleet-perf (358e), fleet-handover (47db — not reproduced from a worktree; reproduce from the
  main checkout right after a sync), store-honesty (6f2e), gate-honesty (2581), ux-lens-safety (0faf), eval-credibility audit (140c).

## 5. Cluster briefs (ranked by consumer pain × gate cost × cost-of-delay)

Ranking evidence: A is the only item where a consumer's push *cannot* succeed however clean it is (AIO: H:28→11→22 on one push) or forces
`ALLOW_UNMEASURED` (storyline #442); B is seen on every sync (derived: `d93e` reproduced in wine and ai-organiser each sync) and is the
feed for every consumer; C contains the one real correctness gap (4146 could false-pass) but shares a file with A; D is dormant-safe
(fails closed) so cost-of-delay is lowest.

### A. Pre-push convergence and scope honesty — **first**
- **Scope:** (484f) concern-identity for re-reports across pushes and a base for merge pushes so the audit reads the 29 changed files not 94;
  prune/reuse the orphaned `.audit/prepush/.tmp-ledger.*`. (df45) when adjacency stops at `maxContainers`, list the skipped files or scale the
  bound with the diff. (70b5) a diff with no implementation files is `NO_CODE_IN_SCOPE`, a distinct measured outcome — never PASS, never UNMEASURED.
  (5c16) `/investigate` first: is an empty change set complete for plan/full scope? then make the ledger say *not measured*.
- **Files:** `scripts/lib/audit-scope.mjs` (~454 `auditSubjectFileGuard`), `scripts/lib/audit-shadow.mjs` (`ADJACENCY_*`),
  `scripts/lib/audit/file-coverage.mjs`, `scripts/lib/audit/convergence.mjs`, `scripts/lib/coverage-format.mjs`,
  `scripts/install-prepush-hook.mjs` (outcome mapping + version bump), `.githooks/pre-push`.
- **Why / risk:** highest consumer pain and gate cost. Risk **high** — audit core and the hook that gates every consumer push; a wrong
  `NO_CODE_IN_SCOPE` is a green-without-measuring (AGENTS.md: audit success paths). Needs a plan (3 rounds, cap 5) before code.
- **Syncs / migrations:** consumer sync + `hooks:install` rollout (hook version bump), all three consumers; **no migrations**.

### B. Sync contract batch — **parallel with A**
- **Scope:** (d93e) print the exact install command per missing bundle package for the consumer's package manager; `doctor`/`check-setup` FAIL
  not warn. (2221) divergence guard distinguishes "disk equals a previous upstream version" from real edits. (da9a) `sync:pr` must not say
  "skip clean" for a stale bundle — run the sync first or compare the bundle stamp. (a5ce) `sync:pr` surface must include the managed
  `.gitignore` block it rewrites. (689c) derive `sync-inventory.mjs` `DEBT_ENTRY`/`CORE_ENTRY` from the one list in `sync-to-repos.mjs`.
  (5bc2) `upstream fix --commit` resolvable from a consumer.
- **Files:** `scripts/sync-to-repos.mjs`, `scripts/sync-pr.mjs`, `scripts/lib/sync-inventory.mjs`, `scripts/lib/sync-gitignore*.mjs`,
  `scripts/check-setup.mjs`/doctor, `scripts/lib/upstream/commands.mjs`. **Disjoint from A.**
- **Why / risk:** every sync today shows the warnings; a Copilot consumer had to hand-install picomatch. Risk **medium** — sync is Tier-3
  (change lands with its test, same commit; consumers are unobservable).
- **Syncs / migrations:** consumer sync after merge; no migrations. Keep to `sync-path-map.mjs` as the layout oracle.

### D. Final-review reliability — **parallel with A and B**
- **Scope:** rebase the three carry commits from `archive/worktree-agent-ad59c28b45a55cd82` (§3) onto main; then 0ace (register a
  pending-attempt invalidation at review start so a lock-contention loser still supersedes the first APPROVE); upstream `d4dada5d`
  (PARTIAL names the file and reason).
- **Files:** `scripts/gemini-review.mjs`, `scripts/lib/final-review/{transport,shadow,providers}.mjs`, `scripts/lib/final-review-marker.mjs`,
  `.file-size-baseline.json` (oversized-files ratchet: a shrink must be re-baselined).
- **Why / risk:** a truncated response currently reads as "reviewer found little" — an approve-by-silence. Risk **medium**; `dd0f2ed7` is the
  conflict-heavy one. No consumer-contract change except the final-review report text.
- **Syncs / migrations:** consumer sync; no migrations.

### C. Hook fidelity — **after A merges** (shares `install-prepush-hook.mjs`)
- **Scope:** 4146 plan-status gate reads `git show <pushed-sha>:<path>`, not the working tree (could false-pass); ecff dash-safe trap probe
  (`trap '' SIG` not `kill -l NAME`); 619c `/audit-plan` from a linked worktree in a consumer; fac2 triage `sameConcernAs` resolves debt ids and
  one bad link does not fail the batch; 981b/a2b8 participant-rules bootstrap order (hydrate before lease CLI exists in a consumer).
- **Risk:** medium-high (hook). **Syncs:** hook rollout again. **Migrations:** none.

### E. Azure Haiku brief 401 — small, **parallel with anything**
- **Scope:** reproduce from the ai-organiser env first; likely the credential/endpoint pair resolved apart (AGENTS.md: one unit).
  **Files:** `scripts/lib/anthropic-client.mjs`, `azureConfig.claudeRoute`. **Risk:** low-medium; an assertion on the *emitted request*, not config.

### Order and parallelism
1. **A, B, D, E start together** — pairwise disjoint files (A: audit/hook; B: sync/upstream; D: final-review; E: anthropic-client).
2. **C starts when A merges** (same hook file).
3. Later: adoption-fit (81f8 unblocked by #248), fleet-perf (358e), store-honesty (6f2e), gate-honesty (2581), ux-lens-safety (0faf, a
   wine data-safety item — rank above polish), then the eval-credibility audit (140c) which unblocks e5a8 and informs the own-model decision.
4. One heavy CES job at a time (fleet rule 14): chips queue on the lease; the *plans* parallelise, the full-suite runs do not.
