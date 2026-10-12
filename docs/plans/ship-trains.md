# Plan: Ship trains — batched, impact-based `/ship --train`
- **Date**: 2026-10-11
- **Status**: Approved
- **Author**: Claude + Louis Strydom
- **Scope**: backend (CLI + skill prose + docs; no UI)
- **Target domain(s)**: `ship`, `fleet`, `shared-lib`, `skills-content`
- ⚠ **Cross-domain work** — touches >1 domain. The crossings are intentional: `ship` gains a caller of `fleet`'s serial landing (one new seam, §2.4), and `shared-lib`'s gate decision gains a second caller. No new edge runs *into* `ship`.
- **Depends on**: none recorded as a plan. Two **path holds**, not plan dependencies (§11): the `/cycle` session on `claude/fleet-unclaimed-work-impl` owns `scripts/lib/fleet/**`, `scripts/fleet.mjs` and `skills/fleet/**` until its four clusters merge, and the keyset PR (`fix/ship-nudge-keyset-paging`) holds `skills/ship/SKILL.md`. Cluster A touches neither.

---

## 1. Context Summary

**Detected**: scope `backend`, stack `js-ts` (`cross-skill detect-stack`).

### 1.1 The problem, measured

`/ship` is `disable-model-invocation: true` (`skills/ship/SKILL.md:14` (5157ff65)), so only the user can run it, in each session separately. With several sessions working concurrently that left two bad options, and on 2026-10-11 we took both:

- **One manual `/ship` per PR per chat.** PRs #202–#206 each waited for a separate human `/ship` in a separate session.
- **Merge without `/ship`.** #200 and #201 were merged with no `/ship` at all. They skipped the status.md entry, the `AI-*` trailers, the AGENTS drift check, Steps 6.5–6.8 and the consumer sync.

The provenance loss is wider than the two unshipped PRs. The **figure** and its **attribution** are measured separately here, because the first draft of this plan attributed the whole figure to the squash. The coordinator's re-check showed that was wrong for the cases it sampled (#193, #195, #198 carry `AI-Gate` on 0 of 7, 0 of 4 and 0 of 6 of their own commits).

**The figure.** *Measured* 2026-10-11 at 5157ff65, with `git log origin/main --since=2026-09-25 --grep='^AI-Gate:' --oneline | wc -l` against the unfiltered count:
- **20 of 76** commits on `main` since the switch to branch + PR + squash-merge carry an `AI-Gate` line.
- **12 of the last 13** carry none.
- The coordinator reproduced the figure independently.

**The attribution.** *Measured* 2026-10-11 over **all 80 PRs merged into `main` since 2026-09-25**. Method:
- for each PR, `gh pr view <n> --json commits` gives its **own** branch commits; a commit "carries" the trailer when its message has an `AI-Gate:` line;
- `git log -1 --format=%B <mergeCommit>` gives the squash commit on `main`, which is then run through `parseMessageTrailers`.

| Class | PRs | What happened |
|---|---|---|
| **A — `/ship` never ran** | **54** | No branch commit carries `AI-Gate`. ship-commit never wrote a trailer, so there was nothing to lose. **The dominant cause.** |
| **B — carried on the branch, lost on the squash** | **9** | **B1 (4):** #162, #163, #164, #165, all merged 2026-10-06. The last branch commit carries the block, but the squash commit's body was replaced with a hand-written summary and has **no** `AI-Gate` at all (e.g. squash `e9307d26` vs its branch commit's `AI-Gate: not-run` / `AI-Run-ID: 94d699be…`). **B2 (5):** #186, #187, #192, #196, #197. GitHub's default squash body (the PR title plus one bullet per commit) keeps the block, but **mid-list**, where git's last-paragraph rule cannot parse it (e.g. squash `5df1ade5`: `AI-Gate: waived` followed by further `*` bullets). |
| C — carried and parseable | 17 | Survived the squash, mostly because the ship commit was the last (or only) commit on the branch. |

So there are **two causes, and this design has to answer both**:
- **A (54/80)** is the pressure to merge without `/ship`. One human `/ship` per PR per session is what produced it. A train removes the pressure: one keystroke covers the batch (§2.7).
- **B (9/80)** is real, cited, and independent of A. Nothing passes `--subject` or `--body` to `gh pr merge`; its callers are `scripts/lib/fleet/train-approve.mjs:213` (prints the command), `scripts/lib/fleet/serial.mjs:245` (runs it) and `scripts/lib/sync-pr.mjs:296` (consumer PRs) (all 5157ff65). So the squash message is whatever GitHub defaults to, or whatever the merger types. The train answers B by writing the message itself (§2.3 `messageFor`), so the block is always the last paragraph.

**The provenance convention is not failing on its own terms. The workflow mostly routes around it (A), and the landing path drops it when it does run (B).**

Consumer sync has the same shape. It fires only from `.githooks/pre-push` §2 (`.githooks/pre-push:281-318` (5157ff65)), and only when a push updates the default branch from a checkout whose HEAD is that tip. A PR merged on GitHub never pushes `main` locally, so it never syncs consumers. Someone has to remember to run it.

### 1.2 What exists today (Code Trace)

**`/fleet land` already builds trains.**

- A train has an immutable manifest under `<git-common-dir>/fleet/trains/<trainId>.json`: `TrainSchema`, `scripts/lib/fleet/registry.mjs:98-126` (5157ff65). Immutability is enforced by `writeTrain`'s `TRAIN_IMMUTABLE` refusal at `registry.mjs:375-396`.
- `buildTrain` (`scripts/lib/fleet/train.mjs:280`) creates a detached integration worktree, squashes each PR in landing order, and records `candidate:{oid,tree}`. `runTiers` (`train.mjs:502`) then runs **one combined test run**.
- `approvable` (`scripts/lib/fleet/overlap.mjs:405`) is the pure eligibility predicate.
- In `pr` mode, `--approve` only *prints* `gh pr merge … --squash --match-head-commit` (`train-approve.mjs:211-213`).
- `--approve --serial` *executes* the merges one PR at a time: update-branch when BEHIND, wait for required checks on that exact head, then merge (`runSerial`, `serial.mjs:143`; the merge call at `:245`).
- Fleet writes **no** trailers and no status.md entry, checks **no** audit provenance, and triggers **no** consumer sync. `grep` over `scripts/lib/fleet` for `status.md|trailer|provenance|sync-to-repos` finds only a CLI-path lookup at `handover.mjs:223`.

**Provenance today** is commit-time only.

- `scripts/ship-commit.mjs` reads the worktree's `.audit/last-audit-run.json` with `resolveEvidence` (`scripts/lib/commit-trailers.mjs:165`).
- It compares the tree being committed with the marker's `auditedTree` in `evaluateGateVerification` (`commit-trailers.mjs:338-411`). Tree equality means `passed`; a differing tree means `converged`. Either value then needs the store verdict from `getAuditRunConvergence`, which reads `round_converged_after`.
- It renders the block with `formatTrailerBlock` and `composeFinalMessage` (`commit-trailers.mjs:472`, `:513`).
- It has **no mode that verifies an existing commit**. The store's `getRunMeta` (`scripts/lib/store/runs-findings.mjs`, 5157ff65) returns `auditedSha`, `auditedTree` and `branch` per run id.

**Consumer reach has an oracle.**

- `getSyncClosure()` (`scripts/lib/sync-inventory.mjs`) returns the files the sync ships. *Measured* at 5157ff65: **921 files**.
- It includes `.claude/skills/**`, `supabase/migrations/**`, `scripts/lib/fleet/serial.mjs`, `scripts/ship-commit.mjs`, `scripts/lib/store/**`, and some `tests/fixtures/**` (the `--adopt` schema contract).
- It excludes `skills/**` (the authoring copy), `docs/reference/**` and `scripts/sync-to-repos.mjs`.

**status.md is written by the model, never by a script.** See `skills/ship/SKILL.md:713-715` (5157ff65): in PR #87 a script write destroyed 19,257 lines. Each `/ship` prepends one entry, so several sessions shipping in parallel all conflict on it.

### 1.3 Neighbourhood considered

`get-neighbourhood` over `scripts/lib/fleet/train.mjs`, `scripts/ship-commit.mjs`, `scripts/lib/commit-trailers.mjs` and `skills/ship/SKILL.md`, intent "verify per-PR audit provenance, classify PR impact, land PRs, one consumer sync":

| Band | Symbol | Decision |
|---|---|---|
| `precedent` (above-floor-standout, 0.756) | `scripts/ship-commit.mjs:121` `main` | **Not extended.** It is a single-commit CLI at 854 lines, bound to the local working tree and marker. A train verifies *other sessions'* PR heads against the store and never commits locally. What both need is the gate **decision**, and that already lives in `commit-trailers.mjs`. So the train **reuses `evaluateGateVerification` and `formatTrailerBlock` unchanged** and adds a sibling CLI (§2.2). |
| `review` (0.57–0.64) | `formatTrailerBlock`, `resolveEvidence`, `isContentVerifiable`, `evaluateGateVerification`, `composeFinalMessage`, `validateTrailerInput` | Reused as-is. The train builds an `evidence` object from a store-bound run rather than a marker file (§2.3). |

**Security incident neighbourhood**: INC-001 (symlink sensitive-path bypass) came back on path proximity only. The train reads no file contents for egress, so it does not apply.

### 1.4 Patterns reused vs new

**Reused:**
- fleet's train: manifest, integration worktree, one combined test run, `approvable`, serial landing with required checks.
- `commit-trailers.mjs`: the gate decision and the rendering.
- `getSyncClosure()`: what reaches consumers.
- `file-taxonomy.mjs` `matchFileKind`: what counts as code.
- `cli-io.mjs`: `emit`, `assertKnownFlags`, `finishAndExit`.
- `/ship`'s own steps, run once per train instead of once per PR.
- The `pending-note` mechanism (Step 6.8), which carries a deviation into the next status entry.

**New:**
- One pure impact classifier.
- One pure provenance binder.
- One read-only store query.
- One CLI, `scripts/ship-train.mjs`.
- One optional callback seam in `serial.mjs`.
- One `/ship` flag, `--train`, with its reference doc.

---

## 2. Proposed Architecture

```mermaid
sequenceDiagram
  participant U as User (types /ship --train)
  participant C as Coordinator session
  participant ST as scripts/ship-train.mjs
  participant FL as fleet land (train.mjs / serial.mjs)
  participant DB as audit store (audit_runs)
  participant GH as GitHub
  participant CS as consumers (sync + sync:pr)
  U->>C: /ship --train
  C->>ST: plan (read-only)
  ST->>DB: runs whose audited_tree = a PR commit tree, or audited_sha = a PR commit
  ST-->>C: per-PR tier, binding, planned gate, refusals, due?
  C->>C: write ONE status.md entry on the log branch, open log PR, fleet ready
  C->>FL: land --select sources+log  (one combined test run; manifest pins the heads)
  C->>ST: land --train trainId [overrides]  (serial landing over the manifest)
  ST->>FL: runSerial(..., messageFor)
  FL->>ST: messageFor(pr, headOid, baseOid)
  ST-->>FL: subject + body + AI-* block, decided fresh on this head
  FL->>GH: gh pr merge --squash --match-head-commit --subject --body-file
  C->>ST: verify --train trainId (is every landed claim TRUE?)
  C->>ST: sync --train trainId (re-verifies, then publishes the final merge OID)
  ST->>CS: sync-to-repos then sync-pr
```

### 2.1 The flow (what `/ship --train` does)

Sessions stop at **ship-ready**: audited, PR open, `fleet ready`. They do **not** run `/ship` and do **not** write status.md. When a train is due, the user types `/ship --train` once, in the coordinator session. Under the skill, the coordinator then runs these steps (T0–T9). **ship-train persists no state of its own** (§2.8): every verb is a pure function of fleet's train manifest, git, GitHub and the audit store, recomputed on each call.

| Step | Action | Mechanism |
|---|---|---|
| T0 | Pre-ship nudges, once per train | `/ship` Step 0.5 queries, unchanged. Not per PR: the store questions are repo-wide. |
| T1 | **Plan** | `node scripts/ship-train.mjs plan --composer <line> [--pr …] [overrides] --json` (read-only). For each ready session with an open PR it reports: the tier (§2.5), the provenance binding (§2.3), the **planned gate**, any refusal, and whether a train is **due** (§2.6). Not due → stop, naming the missing trigger. |
| T2 | Refusals | A PR with a refusal (no bound converged run on a non-ride-along, an unverifiable store, a ride-along-only set) stops the train. The only overrides are invocation flags: `--waive <n,…>`, `--allow-unaudited <n,…>` and `--end-of-day`. They are read **only** from the `/ship --train` invocation, the same rule `/ship` applies to its existing override flags (`skills/ship/SKILL.md:536-543` (5157ff65)). The coordinator passes the SAME flags to `land` (T5); nothing carries them between steps except that invocation. |
| T3 | **Train log** | On a branch `ship/train-<YYYYMMDD>-<lowest PR>` in the coordinator's worktree, the model writes **one** status.md entry by hand, using the train template (§7, Phase 7). The entry is titled with the date and the PR list, and its gate column says **planned** (T1's output). It runs the AGENTS drift check (`/ship` Step 4) and commits through `ship-commit.mjs --gate not-run`. It pushes, opens a PR, and runs `fleet claim` + `fleet ready` on that branch. The log is an ordinary ride-along source; fleet decides its landing position. |
| T4 | **Build** | `node scripts/fleet.mjs land --select <sources…,log>`: the existing train build with one combined test run. Fleet writes its immutable manifest, which pins every source's PR number and head oid, the base and the destination. Not `approvable` → stop. |
| T5 | **Land** | `node scripts/ship-train.mjs land --train <trainId> --composer <line> [overrides]` reads the fleet manifest (§2.8), refuses unless it is fleet-approvable, and drives fleet's **serial** landing. Fleet calls `messageFor` per PR **at merge time**, after any update-branch. `messageFor` decides the gate **fresh** on that exact head (§2.3), so there is no persisted message to keep consistent. A source whose fresh decision is a refusal is **not merged**; serial stops there and the output names it. |
| T6 | **Verify** | `node scripts/ship-train.mjs verify --train <trainId>` checks that every landed claim is **true** (§2.8): each merge commit's trailers parse, and each claim is supported by git and the store. It also derives the final merge OID and any interleaved foreign commits. It writes a pending-note with the **actual** gates and any deviation, so the next status entry carries them. It is read-only apart from that note, and re-runnable. |
| T7 | Post-land advisories, once per train | `/ship` Steps 6.5–6.7, unchanged. |
| T8 | **Consumer sync** | `node scripts/ship-train.mjs sync --train <trainId> [--accept-interleaved] [--accept-provenance-mismatch]` **re-runs T6's verification in the same invocation** and refuses unless it is clean, or unless every remaining block is acknowledged by a flag given on this invocation (§2.8). It then creates a clean detached worktree at the derived **final merge OID** (never a re-read branch tip), checks its tree, and runs `sync-to-repos` there, then `sync-pr`. Newer commits on `main` are reported as **not** part of this publication. It records the Step 6.8 consumer-verification note, naming any acknowledged oids. |
| T9 | Ship event | One `record-ship-event` per **`/ship --train` invocation**, because the event's unit is a human ship action, not a train (plan R4 M1). A train finished across two invocations (stop, then `land --resume` under a second `/ship --train`) therefore records two events, each true of its own invocation, and no idempotency key is needed. The outcome reflects the worst per-PR result of that invocation; one that stopped partway reports `warned` with the PR it stopped at. |

**Why the log rides inside the train, not after it.** A follow-up log PR would need its own required-checks wait: a second CI run and a second landing, exactly the per-change overhead trains exist to remove. Riding inside the train means one combined test run covers it.

The cost is that the entry is written before the merge shas exist, and before T5 knows whether an update-branch has turned a planned `passed` into `converged`. So the entry records **planned** gates, and T6's pending-note records the **actual** ones. That is the same channel Step 6.8 already uses for "verify after the fact" facts, and it needs no stored diff between the two.

### 2.2 Components (#5 Modularity, #1 DRY)

| Unit | Kind | Responsibility |
|---|---|---|
| `scripts/lib/ship-train/impact.mjs` | pure | `classifyPrImpact({changes, closure, isCode})` returns `{tier, reasons[]}`, where `changes` is a list of `{status, path, oldPath?}` (§2.5). `isTrainDue({prs, endOfDay})` returns `{due, triggers[], missing[]}`. |
| `scripts/lib/ship-train/provenance.mjs` | pure | `bindAuditRun({commits, candidates})` returns a `tree` binding, an `ancestry` candidate, or an unbound reason. `decideTrainGate({binding, headTree, basePinning, tier, waived, allowUnaudited})` returns `{gate, runId, auditedTree, models, identityProvable, refusal}`. It **calls `evaluateGateVerification`**; it does not reimplement it. `composeSquashMessage({pr, commits, decision})` calls `composeFinalMessage`. `modelsFromRun(row, composerFamily)` returns only substantiated families. |
| `scripts/lib/ship-train/verify.mjs` | pure | `verifyTrain` (claim truth per landed source, final merge OID, interleaving) and `publicationClearance` (§2.8). |
| `scripts/lib/commit-trailers.mjs` | shared-lib (+~10 lines) | `evaluateGateVerification` gains `identityProvable = true` (§2.3). The default keeps every existing caller byte-identical. |
| `scripts/lib/store/train-provenance.mjs` | store read | `findCodeRunCandidates({trees, oids})`: one parameterised `SELECT` over `audit_runs`, scoped to the current repo and to code-mode runs, returning each row's match kind. Read-only, so it is not a durable-write registration. |
| `scripts/ship-train.mjs` | CLI | `plan` (read-only), `land [--resume]`, `verify`, `sync`, plus a read-only `message --pr <n>` for inspection. It persists no state of its own (§2.8). It follows the `--selfcheck-relocation` contract, uses `assertKnownFlags`, and exits through `emit` / `finishAndExit`. |
| `scripts/lib/fleet/serial.mjs` | seam (+~20 lines) | An optional `messageFor({source, headOid, baseOid}) → {subject, body} \| {stop: reason} \| null` on the serial run options. A message adds `--subject` and `--body-file` to the merge call; `{stop}` ends the run before that merge. When it is absent, behaviour is byte-identical to today. |
| `skills/ship/references/train-mode.md` | prose | The T0–T9 runbook, its refusals and override flags, and the laundering rationale (§2.7). |
| `skills/ship/SKILL.md` | prose (+~12 lines) | A `--train` usage row and a pointer section to the reference above. |

Why a sibling CLI and not a `ship-commit --train` mode: covered in §1.3. In short, `ship-commit` is bound to *this* worktree and marker and always commits. The train never commits locally and verifies *other* commits against the store. Folding those together would add a second evidence source to a file whose whole design is one evidence source.

### 2.3 Per-PR provenance: binding, gate and recording (the central decision)

The pre-authorisation for this work says sessions make **plain commits with no `AI-*` trailers**: the user's `/ship` writes provenance. So the train has to establish *which audit run covered which PR* without any declaration from the session.

**Binding by content, not by declaration (#13, #4).** For a PR with merge-base `B` and commits `C1..Cn`, read every commit oid and tree `T(Ci)`. Then run **one** repo-scoped, code-mode query, `findCodeRunCandidates({trees, oids})`, which returns rows where `audited_tree = ANY(trees) OR audited_sha = ANY(oids)`. Each row is tagged with its **match kind**, `tree` or `sha-only`, and the rows are ordered deterministically: bound commit position, then `created_at`, then `id`. The two kinds are kept apart from the moment they are read. A `tree` match can bind; a `sha-only` match is an **ancestry candidate** and can only ever back an explicitly authorised waiver, never `passed` or `converged`. The oid list is `C1..Cn` and **excludes `B`**: the merge-base is shared with every other branch off `main`, so a run on `B` says nothing about this PR.

`audited_tree` is the audited **worktree** content: `read-tree HEAD` + `add -A`. When a session commits exactly what was audited, that tree *is* a commit tree in the PR. This is E1's content identity, the strongest binding the store can give. It needs no run id from the session, so it cannot be forged by an agent writing a PR body. The best a forger could do is a store row with that exact tree, which is the same bar `passed` has today.

Choose the binding as follows:
- Prefer the newest bound commit `Ck`, and among its runs the newest converged one.
- Commits `Ck+1..Cn` are the **post-audit delta**. Record them by count and file list.
- If no tree matches, the PR is **unbound**. Typical causes: a stray untracked file was in the audited worktree, or the audit ran after a commit that was later amended.

**Ancestry is deliberately not a fallback for `passed`/`converged`.** An `audited_sha` inside `(B, H]` shows that an audit happened on this branch. It does not show what that audit read: the tree it read included uncommitted content that may never have been committed. So an ancestry-only match can support at most `waived` with that run id, and only under `--waive <n>`.

**The gate for the squash commit `S` on `main`.** `S` does not exist when its message is written. Its tree is only **provable** in advance when the server pins the base: a PR that is up to date with `main` squashes to exactly `T(H)`, but `--match-head-commit` protects the head, not the target. If anything else reaches `main` between the message and the merge, GitHub squashes onto the newer base and `T(S) ≠ T(H)`. Detecting that afterwards cannot repair a published `passed` (round-1 finding H1, accepted). So the train claims tree identity **only when it is server-enforced**:

- **Base pinned** (`basePinning: 'strict'`): the destination's ruleset or classic protection requires branches to be up to date before merging (`strict_required_status_checks_policy` / `required_status_checks.strict`). In that case GitHub itself refuses a merge whose head does not contain the current base. With `messageFor` running **after** serial's update-branch on the exact head being merged (`serial.mjs:143-245` (5157ff65)), `T(S) = T(H)` is guaranteed by the server, not predicted. `committedTree = T(H)`.
- **Base not pinned** (`basePinning: 'none'`, or the protection read failed, which is fail-closed): tree identity is **not provable at commit time**. `committedTree` is still `T(H)`, but the evaluator is told `identityProvable: false` (below).

*Measured* 2026-10-11 for **this** repo: `gh api repos/Lbstrydom/claude-engineering-skills/rulesets` → `[]` and `…/branches/main/protection` → 404. `main` is unpinned, so trains here land audited PRs as `converged`, never `passed`. That is the honest result, and it is the reason `plan` reports the pinning verdict up front.

**One additive input to the shared evaluator.** `evaluateGateVerification` (`scripts/lib/commit-trailers.mjs:338` (5157ff65)) gains an optional `identityProvable` (default `true`, so every existing caller is byte-identical). When it is `false`:
- `passed` is **refused**, with an AGENT FIX naming the missing server pin and pointing at `converged`.
- The under-claim refusal for `converged` ("trees match, use `passed`") is **suspended**, because `passed` is not available to under-claim against.

It can never grant `passed`, and it changes nothing else in the function. This is the one semantic widening the train makes. `converged` now reads "a store-verified converged run, and the committed tree is **not asserted** equal to the audited tree: either it differs, or equality could not be proven at commit time". That still carries no `AI-Audited-Tree`, exactly as today. Phase 7 states the widening in `commit-provenance.md` and in AGENTS.md's four-value paragraph.

With `evidence = {state:'fresh', runId, auditedTree: T(Ck)}` the train calls `evaluateGateVerification`, trying `passed` then `converged`, and takes the first accepted:

| Situation | Gate on `S` | Extra trailers |
|---|---|---|
| Tree-bound converged run, `T(Ck) == T(H)`, base **pinned** | `passed` | `AI-Run-ID`, `AI-Audited-Tree: T(Ck)`. Self-verifying with `%T` on `S`, **reachable from `main` forever** |
| Tree-bound converged run, `T(Ck) == T(H)`, base **not pinned** | `converged` (`identityProvable:false`) | `AI-Run-ID` |
| Tree-bound converged run, `T(Ck) ≠ T(H)` (post-audit commits, or base merged in by update-branch) | `converged` | `AI-Run-ID` |
| Tree-bound run, not converged | refuse. Under `--waive <n>`: `waived` | `AI-Run-ID` |
| Ancestry candidate only (`sha-only`) | refuse. Under `--waive <n>`: `waived` | `AI-Run-ID` of the newest candidate |
| No run, ride-along tier | `not-run` (the normal case for docs/tests/config) | none |
| No run, `standard`/`urgent` tier | refuse. Under `--allow-unaudited <n>`: `not-run` | none |
| Store unreachable / cloud off | `standard`/`urgent` refuse (cannot verify, so cannot claim; same fail-closed bar as `ship-commit`). Ride-alongs: `not-run` | none |

**Post-merge mismatch blocks publication (defence in depth).** On a base-pinned destination T6 should never find `AI-Audited-Tree ≠ %T`. If it does, the server pin was not what the merge-time read saw, and the `passed` claim is **false** under §2.8's truth check. `verify` reports it in its pending-note, and `sync` refuses until the operator re-runs it with `--accept-provenance-mismatch`, an invocation-only flag whose acknowledgement is written into the Step 6.8 note.

`AI-Skill: ship`.

`AI-Models` lists **only substantiated participants** (round-1 M1, accepted). It is assembled from what the run row actually records:
- `author_model` (arm-eval column, `supabase/migrations/20260701160000_arm_eval.sql:98` (5157ff65));
- `final_review_model` (`20260610120000_final_review_shadow.sql:16`);
- the auditor model, if the row records one.

Each is mapped through `modelFamily` (`scripts/lib/model-resolver.mjs:383` (5157ff65)), the one family function AGENTS.md mandates, and then through `canonicaliseModels`. Which column holds the **auditor** model is a build-time census, Phase 2's first step. An unrecorded stage is **omitted**, never assumed, and `plan`/`land` report `attributionMissing: [stage…]`.

The model that composes the squash message is always a substantiated participant: it is the coordinator's own family. If nothing else is recorded, `AI-Models` is that family alone, and the train entry says "audit-stage attribution unrecorded". That keeps `AI-Models` non-empty (its grammar requires it) without inventing anyone.

**Recording: per-PR trailers + the status.md entry. No new manifest file, no new trailer key.**

- **Per-PR trailers at squash-merge** are authoritative. They are git-native, they answer the existing query cookbook unchanged, and `passed` stays self-verifying from git alone.
- **The status.md train entry** is the human-readable cross-PR record. It names every PR (including ride-alongs), its tier, and its planned gate and run id. T6's pending-note adds the actual gates to the next entry.
- **fleet's existing local manifest** (`trains/<id>.json`, already immutable) holds the machine record of what was tested and landed. `ship-train` adds nothing to its schema **and keeps no state beside it** (§2.8).

**Right-sizing for this choice.**
- *Band-aid*: loop `/ship` per PR. It changes nothing structurally and leaves the squash-body loss in place.
- *Over-engineered*: a committed `trains/<id>.json` manifest, plus a new `AI-Train:` trailer key, plus the V2 ship-evidence receipt.
- *Chosen*: the trailers that already exist, rendered by the function that already renders them, delivered through the place they are lost when /ship does run (the squash body). The **current requirements** it serves are the 9 measured class-B losses (§1.1) and, through the single keystroke per train, the 54 class-A bypasses.

An `AI-Train` key would answer "which commits shipped together". The status.md entry answers that already, and a new reserved key would be a schema change across every consumer for a query nobody has asked.

**Who writes `AI-*`.** The reserved-namespace invariant is "only the helper renders the block, so a hand-typed block never enters history" (`commit-provenance.md:145-147`). After this change there are **two emission points**, `ship-commit.mjs` (direct commits) and `ship-train.mjs` (squash messages). Both render through the **same** `formatTrailerBlock` / `composeFinalMessage` and the same `evaluateGateVerification`, so there is still one renderer and one gate decision. AGENTS.md and `commit-provenance.md` are updated to say so (Phase 7). A `messageFor` body is never typed by an agent: it is computed inside `ship-train.mjs` from the store and git.

### 2.4 The one fleet seam

`runSerial` gains an optional `messageFor` callback. `ship-train land` calls fleet's serial landing **as a library** with that callback. It does not shell out to `fleet land --approve --serial`: a CLI flag would have to carry a command template, and that is a new injection surface.

Nothing else in fleet changes:
- no schema change;
- no change to `approvable`;
- no change to `--approve` without `--serial`.

The PR-mode non-serial path (print-only) stays as it is. The train always lands serially, because only serial mode knows the head at the moment of merge.

Domain edges: `ship` → `fleet` (new: only the CLI, `scripts/ship-train.mjs`, imports `serial.mjs` and `registry.mjs`; the verbs in `scripts/lib/ship-train/` receive the manifest and the serial runner through their injected context, so the library adds no edge into `fleet`) and `ship` → `shared-lib` (exists). `fleet` imports nothing from `ship`. Per AGENTS.md, a new edge means re-checking `tests/arm-vocabulary-layering.test.mjs` and the `allowedDeps` in `.audit-loop/domain-map.json`. If `ship → fleet` is not already allowed, Phase 5 adds it to `allowedDeps` with a reason.

### 2.5 Impact tiers (`classifyPrImpact`)

The PR's change list comes from `git diff --name-status -z -M B...H` on the fetched PR ref, never `gh pr view --json files`, which pages at 100. The output is NUL-delimited, so it is safe for paths containing whitespace or newlines, and it is parsed into `{status, path, oldPath?}`. A rename or copy keeps **both endpoints**, so a file renamed *out of* the closure is evaluated at its old path, which is in the closure. A delete is evaluated at the deleted path (round-1 M2, accepted). "Changed path" below means the union of every `path` and every `oldPath`.

1. **`urgent`**: any changed path is in `getSyncClosure()`. Reason `reaches-consumers:<n> files`. The closure contains synced `scripts/lib/store/**`, `scripts/lib/db/**`, migrations and security libs, so "changes behaviour, security or the store **for consumers**" is covered by the same single oracle. No second hand-kept list.
2. **`standard`**: otherwise, any changed file is source code per `file-taxonomy.mjs` `matchFileKind` and is not under `tests/`. This is repo-internal behaviour, e.g. `scripts/sync-to-repos.mjs`, which the closure does not include.
3. **`ride-along`**: otherwise. Only tests, docs or config.

The closure is computed on the **base** (`main`) checkout. A PR that *adds* a brand-new synced file without touching any existing synced file would read as `standard`. The failure direction is benign: the PR waits for the ≥3 or end-of-day trigger instead of shipping now, and is never shipped *less* carefully. The T6 log re-classifies against `getSyncClosure()` run in the train's integration worktree, so the record is exact. Measured and accepted as R4.

### 2.6 When a train is due (`isTrainDue`)

`due` ⇔ the set has **at least one non-ride-along PR** and one of:
- any `urgent` PR;
- **≥ 3** ship-ready PRs in total;
- `--end-of-day`.

A ride-along-only set is **never** due, not even at end of day. Ride-alongs wait for the next real train and are named in its entry (the user's rule).

This reconciles the four triggers the brief lists. Read literally, "≥3 ship-ready PRs" would let three docs PRs form a train of their own, which contradicts "never a train of their own"; the non-ride-along precondition removes that contradiction.

When the user types `/ship --train` and the set is not due, `plan` refuses with the missing trigger and the exact re-invocation (`/ship --train --end-of-day`). It is a nudge with a human override, never a silent no-op.

### 2.7 Why the human gate stays: one `/ship --train`, not a relaxed `disable-model-invocation`

The alternative is to drop `disable-model-invocation` so that a coordinator agent can run `/ship` on a schedule. That turns a **standing, agent-held authority** into the thing that publishes to `main` and to every consumer. Today the only path from "an agent decided" to "consumers received it" passes through a human keystroke. With the gate relaxed, an agent could reach the push through any chain of agent-authored inputs — another session's message, a file, a PR body, a directive. That is the laundering path AGENTS.md and fleet's participant rules already refuse (`skills/fleet/SKILL.md:92-95`). A train keeps the keystroke and spends it better: the per-PR human cost goes from N keystrokes to 1, and the human still sees what is being shipped (the T1 table) at the moment they authorise it.

The remaining limit is cooperative, stated plainly. `ship-train.mjs land` is an ordinary CLI, and an agent with a shell could run it. So could `gh pr merge`, or `fleet land --approve --serial`. The skill gate is a policy layer, as it is for `/fleet`, and an agent cannot enforce a gate against its own shell. The train changes neither the reachability nor the policy. It removes the *pressure* to bypass `/ship`, which is what actually produced #200/#201.

### 2.8 Stateless by design: what the old receipt bought, and what owns it now

**Amended 2026-10-12 after Cluster A's audit.** The first version of this plan put a persisted operation receipt between planning and publication: `<git-common-dir>/fleet/ship-trains/<opId>.json`, holding the planning snapshot, per-PR "actual" decisions, merges, verify results, publication checkpoints and phases.

Cluster A built it, and `/audit-code` then raised fresh HIGHs in **five consecutive rounds** (R2–R6). Every one was in the same place: a verify record that a **later invocation** (`sync`) consumes. Once that state exists, its whole lifecycle has to be owned:
- a re-verify can go stale;
- a refusal must persist;
- concurrent writers need compare-and-swap;
- an old record needs a basis hash to detect obsolescence;
- phase invariants make some writes illegal.

Each fix created the next finding. That is the AGENTS.md over-engineering signal: the structure, not the code, was generating the defects.

**The forcing question** — *what is the smallest structure that is a true function of the problem?* — has a smaller answer. The problem needs a pinned set of PRs to land, a claim per merge that is true at merge time, and a publication gated on those claims being true. All of that is already recorded by systems that own their own state. ship-train therefore persists **nothing**, and every verb recomputes from owned state.

**What the receipt bought, item by item, and what covers it now** (the substitution the audit should check, not just the deletion):

| The receipt provided | Why it was there | Covered now by | Why that is sufficient |
|---|---|---|---|
| Handoff from plan to land (selected PRs, exact heads) — plan R1 H2 | land must merge exactly what was planned and tested | **fleet's train manifest** (`trains/<trainId>.json`, `TrainSchema`, `scripts/lib/fleet/registry.mjs:98-126` (5157ff65)): `sources[].prNumber`, `sources[].oid`, `baseOid`, `destination` | It is immutable once written (`TRAIN_IMMUTABLE`, `registry.mjs:375-396`), fleet's approve re-verifies every recorded fact before landing (`verifyFacts`, `train-approve.mjs:90`), and serial merges with `--match-head-commit`. A second copy of the same pins added only a consistency obligation. |
| Overrides (`--waive`, `--allow-unaudited`, `--end-of-day`) | the decision depends on them | **The `land` invocation's own flags**, exactly as `/ship`'s override flags are invocation-only today | The human types them on the one `/ship --train`; the skill passes them to `plan` and `land` unchanged. A stored copy would be a second source of truth. |
| Planned decisions, then `actual[pr]` persisted before each merge — plan R1 H5, R2 H2 | reproducible messages on retry; a reference to verify against | **Fresh computation at merge time** (`messageFor` decides on the exact head being merged) plus **claim-truth verification** (below) | A retry recomputes the decision for the current head and current facts, strictly safer than the plan-R3-H1 "revalidate, then replay" rule it replaces, because nothing stale can be replayed. Verify no longer needs a stored decision to compare against, because it checks whether each claim is **true**, not whether it equals what was decided. |
| Merge checkpoints (`merges[pr]`) and landing recovery — plan R1 H5 | resume after a crash without double-merging | **fleet's serial progress record** (`fleet/serial/<trainId>.json`, `scripts/lib/fleet/serial.mjs:70-90`) and its resume (`resumeSerial`), plus **GitHub** (`gh pr view --json state,headRefOid,mergeCommit`) | Serial already resumes per PR and never resubmits a PR GitHub reports MERGED. A ship-train copy would have been a second checkpoint to reconcile. |
| Landing order — plan R2 M1 | find the final merge; detect reordering | the manifest's `sources` order (fleet's `landingOrder`) and `main`'s first-parent chain | Both are read fresh in the same invocation that uses them. |
| `verify` record, `verified`/`verified-interleaved` phases, `publicationAmendment`, revocation, basis hash, compare-and-swap — code R2–R6 | `sync` (a later invocation) consumed verify's result | **`sync` re-runs verification itself, in the same invocation**, and gates on that fresh result plus flags given on that invocation | With no stored verify result there is nothing to go stale, be revoked, race, or drift from its basis. The class of finding R2–R6 produced becomes unrepresentable rather than handled. |
| Publication checkpoints per consumer | resume a partly-failed sync | **sync-to-repos' in-progress journal, written in each CONSUMER checkout** (`path.join(repo.path, LAYOUT_CONSTANTS.IN_PROGRESS_JOURNAL)`, `scripts/sync-to-repos.mjs:1701` (5157ff65)), the consumer-side rollback receipts, and **sync-pr**'s per-consumer skip of a consumer with nothing to do | The recovery state lives in the consumer, so removing the source-side publication worktree cannot touch it. A retry re-creates the source worktree at the same final merge OID, and the tools reopen their own journals. (Plan R4 H2 was dismissed on exactly this evidence.) |
| `opId` key for the status.md entry | the fleet train id does not exist when the entry is written | the entry's **date + PR list** | The entry never needed a machine key; the train id appears in T6's pending-note. |

**Source identity first** (plan R4 H1). Before any trailer is read, `verify` proves that each merged PR **is the source the train tested**. A PR can change after the manifest pinned it, gain a valid audit, and be merged by someone else. Its trailers could then pass every truth check while carrying content the combined run never saw.

So, for each manifest source, GitHub's merged `headRefOid` must be one of:
- the manifest's pinned `sources[].oid`; or
- a chain of fleet serial's **own** base-only updates leading back to it, each link proven by fleet's existing oracle `classifyUpdatedHead` (`scripts/lib/fleet/serial.mjs:109` (5157ff65)). That oracle requires two parents, the first being the prior head, the second on the base, and a tree equal to a clean re-merge. The chain is bounded at a small number of links.

Anything else (a foreign head, an unverifiable link) **blocks publication with no override flag**. Identity is not acknowledgeable, because it is the train's definition. A PR that merged at a foreign head is reported as a foreign commit, not a train source.

**Claim truth, the key move.** For each source that passed the identity check and that GitHub reports MERGED, `verify` reads the squash commit's trailers and checks what each one **asserts**:
- The block **parses** as a last-paragraph trailer block, with no duplicated `AI-*` key. Classes B1/B2 (§1.1) fail here.
- **Every run reference is resolved one way** (plan R5 H1). `AI-Run-ID` is looked up by `findCodeRunForRepo({repoRowId, runId})` in `scripts/lib/store/train-provenance.mjs`. That is one parameterised read, scoped to the current canonical repository (`resolveRepoRowIdForRead`, the same resolution `plan` uses) **and** to `mode = 'code'`, so the scope is not left to each claim rule. A run from another repo, a plan-mode run, or no row at all makes every audit-backed claim **false**. A schema fault is fatal, as in `plan`. This matters because §2.8 also judges PRs whose trailers ship-train did not write.
- **`passed`** asserts tree identity plus a verified verdict. It is true iff:
  - `AI-Audited-Tree` equals the commit's own `%T`;
  - the run resolves (above) and is converged;
  - its `audited_tree` equals `AI-Audited-Tree`;
  - that tree is the tree of a commit in the PR (merge-base..merged head).
- **`converged`** asserts the same binding and verdict without tree identity. It is true iff the run resolves (above), is converged, and its `audited_tree` is the tree of a PR commit.
- **`waived`** asserts only that a related run exists. It is true iff the run resolves (above) and its `audited_tree` or `audited_sha` belongs to the PR.
- **`not-run`** asserts nothing. It is true iff there is no `AI-Run-ID` and no `AI-Audited-Tree`.
- An **under-claim** (`converged` where `passed` was provable, `not-run` on an audited PR) is **true** and not a failure. Verify notes it.

Truth needs no record of what was decided; it needs only git, GitHub and the store, all re-read each time.

**What verify cannot judge, and says so.** Whether a `not-run` on a non-ride-along PR was *authorized* is a policy question; the authorization (`--allow-unaudited`) was an invocation flag that left no trace. Verify reports such PRs as `not-run on a <tier> PR` in the pending-note rather than failing them. The status.md entry, written before landing, already named every override the human typed.

**Publication gate** (`publicationClearance`, pure). `sync` calls it on the verification it just computed:
- any claim that is not true, or a train source that did not merge → blocked; `--accept-provenance-mismatch` acknowledges the claim failures, and nothing acknowledges an unmerged source;
- interleaved foreign commits on `main` between the base and the final merge → blocked; `--accept-interleaved` acknowledges them;
- acknowledged oids are written into the Step 6.8 pending-note, so the record of what was published beyond the train lives with the publication.

Commits after the final merge are never published by this train.

**Final merge OID.** The merge commit of the last train source in `main`'s first-parent order, from `expectedOid`/`baseOid`, with every source's merge commit required to be on that chain. A train source not on it blocks publication.

**Right-sizing, restated for this choice.**
- *Band-aid:* keep the receipt and fix R6's two findings. Each round showed the next finding sits one step further along the same lifecycle.
- *Over-built:* the receipt as it stood, a second, partial copy of fleet's state with its own consistency machinery.
- *Chosen:* no new persistent state. Its **current requirement** is exactly the three facts above: pinned heads, true claims, gated publication. Each is already owned elsewhere.

### 2.9 Partial failure and recovery (over owned state)

| Interrupted during | State that survives | How to continue |
|---|---|---|
| T3 log PR | the log branch and PR | `fleet ready` it; it is an ordinary source |
| T4 build | fleet manifest + phase | fleet's own `--abandon` / rebuild |
| T5 landing | fleet serial record + GitHub | `ship-train land --train <id> --resume [same overrides]`. Serial resumes; a source GitHub reports MERGED is recorded, never resubmitted. `messageFor` recomputes the decision on the current head, so a stale decision is never replayed. A source whose fresh decision is now a refusal stops the run, and the output names it. |
| T6 verify | nothing (read-only apart from its note) | re-run |
| T8 sync | sync-to-repos' journal and rollback receipts, **in each consumer checkout** | re-run `sync --train <id>`. It re-creates the source worktree at the same final merge OID; already-synced consumers are no-ops; rollbacks are refused by the consumer receipt |

There is no ship-train lock, because ship-train writes nothing that two processes could race on. Concurrent landing of the same train is excluded by fleet's own train lock (`withTrainLock`, `scripts/lib/fleet/train.mjs:156` (5157ff65)).

**Retryable vs terminal.**
- **Retryable**: gh 5xx, network errors.
- **Terminal**: a head that moved off the manifest, a store schema fault (fatal, loud), a refusal on a fresh decision.

A terminal stop never auto-retries.

---

### 2.10 Test cost across a train — PROPOSED, not yet audited (2026-10-12)

*Raised by the coordinator from a measurement by session local_b7b4b056.* `.fleet.json` sets no `testCommand`, so `fleet land` runs `package.json`'s `npm test` (the full suite) once per train. That is on top of every PR's own pre-push gate, which already ran the full `check` in a clean sandbox at that PR's commit. A train therefore pays the full suite **N + 1** times. In practice it pays more, because a branch is pushed several times while it is iterated on.

*Measured* 2026-10-12, from this cluster's own pre-push logs (`# duration_ms` in `$TEMP/push-plan2.log`): **1,713 s ≈ 28.6 min** for 18,618–18,797 tests on this machine, per run.

**What each run actually proves.**
- **The train's combined run** is the only one that tests **the bytes that land**: base + every source, squashed in landing order, under fleet's candidate-integrity checks (clean tree and unchanged `HEAD` tree before and after the run; `train.mjs:502`). It catches what no per-PR run can:
  - two PRs that are each green but break together;
  - a PR that is green against the base it was tested on but red against today's.
- **A PR's pre-push full run** proves that PR, alone, against an older base. It is useful *early* feedback, but redundant as a *landing* gate once the train's run exists.

**Option (b), rejected: trust each PR's recorded gate and run only what the combination can break.** Three problems:
1. **No recorded gate exists.** `scripts/prepush-check.mjs` keeps no durable pass record; it writes only a failure's output. Trusting a gate needs a new persisted record of "tree T passed the full suite". §2.8 just removed a persisted record for generating exactly this class of defect.
2. **It would almost never fire.** Every train carries the status.md log PR (T3), so the candidate tree never equals any tree a PR already tested. The saving needs "run only what the delta can break", which is affected-test selection over the combination. That is the hard version of the problem, not the easy one.
3. "What the combination can break" is not the per-PR delta. Interactions are exactly what the combined run exists for.

**Option (a), recommended, and split by owner (coordinator ruling, 2026-10-12).** The train's combined run is the authoritative full suite, and branch pushes may get a cheaper tier. The two halves have different owners:

- **Train side — owned HERE.**
  - `fleet land` keeps `npm test` as the train's combined run. It is the **one authoritative full suite on the bytes that land**; `.fleet.json` is not edited, and the train docs say so.
  - **The thinness metric**: `ship-train verify` reports whether the train's combined run failed on a test that the branch tier did **not** select. It is the measurement that says whether a cheaper branch tier is too thin, so its fix is to widen the tier, never to drop the train's run.
  - It reads fleet's own run record (`tierResults`/log) and the branch tier's selection for the PR's head. It is built once the gate-cost plan publishes how that selection can be asked for; until then it reports `unmeasured` (no branch tier to compare against), never a clean zero.
- **Branch side — owned by the gate-cost plan** (`docs/plans/gate-cost-slice-1.md`, chip `fleet/make-the-pre-push-gate-s-per-f-2dab`). Everything below is that plan's to design, measure and decide, and is NOT built here:
  - a cheaper branch-push tier (e.g. static gates plus direct-impact tests);
  - its vacuous-pass guard;
  - a full-suite escape hatch;
  - the `scripts/prepush-check.mjs` / `scripts/run-tests.mjs` changes.

  The analysis above is handed to it as input. Weakening the branch gate is a policy decision for the user, made with that plan's numbers.

**Cost:** unchanged on the train side (one full run per train). The branch-side saving is the gate-cost plan's to measure. The expected figure is a branch push dropping from the measured ~28.6 min.

**Right-sizing (train side).**
- *Band-aid*: drop the train's run because PRs already passed. That removes the only test of the landing bytes.
- *Over-built*: (b)'s recorded-gate store.
- *Chosen*: keep the one combined run, and add one read-only metric that keeps any future branch tier honest.

**Not yet audited.** This section was added after the plan's GPT cap (5 rounds) and Gemini cap (2 rounds) were used. Its train-side half (Phase 8) gets a focused `/audit-plan` when it is scheduled. No audit now (coordinator ruling): Cluster A ships first.

---

## 6. Sustainability Notes

- **Assumptions that could change.** `passed` on a squash commit rests on two things holding together: the server refusing a merge whose head is not up to date, and GitHub squashing an up-to-date head to exactly that head's tree.
  - The first is **read** from the destination's protection at `plan` time and again at every merge, never assumed. Without it, `passed` is simply not offered (§2.3).
  - The second is **checked** on every train by T6. A violation blocks publication rather than being merely reported.
  - Turning on strict up-to-date protection is a repo setting. It is the user's decision and **not** made by this plan. It is the switch that makes `passed` reachable here.
- **Direct-squash repos.** For a consumer whose `mergeMethod` is `direct-squash`, `messageFor` needs a sibling hook where `applySources` commits (`scripts/lib/fleet/train.mjs:364` (5157ff65)). That is deliberately not built (§8, D2). There, the push lease against `expectedOid` *is* a server-enforced base pin, so it is the cleaner route to `passed` if a consumer ever needs it.
- **Extension point.** `messageFor` is the single seam a future evidence receipt (V2) would attach to.

## 7. File-Level Plan

### 7b. Implementation Phases

- **Phase 1 — Impact classifier**: `classifyPrImpact` + `isTrainDue`, pure, test-first. Files: `scripts/lib/ship-train/impact.mjs` (create), `tests/ship-train-impact.test.mjs` (create).
- **Phase 2 — Provenance binder, evaluator input, store read**. Steps:
  - **First step is a census**: which `audit_runs` column, if any, records the auditor model. Run the query, record its result in the Implementation Log, then write `modelsFromRun` against it.
  - Write `bindAuditRun` (tree binding vs ancestry candidate kept apart), `decideTrainGate` (via `evaluateGateVerification`), `composeSquashMessage` (via `composeFinalMessage`) and `modelsFromRun`.
  - Add `evaluateGateVerification`'s `identityProvable` input, default `true`.
  - Write `findCodeRunCandidates({trees, oids})`. The read degrades loudly on a schema fault (`describeSchemaFault`) and never returns an empty list on a broken query.
  - Enrol the new DB suite in `scripts/db-test-container.mjs`'s `*_SUITE_FILES` **and** in `.github/workflows/postgres-parity.yml`: two edits, because the binding query must be asserted once on real Postgres.

  - *Sequencing (coordinator, 2026-10-11):* `scripts/db-test-container.mjs` and `.github/workflows/postgres-parity.yml` are held by the keyset PR (`fix/ship-nudge-keyset-paging`). The real-Postgres suite and its two-list enrolment therefore land **last**, after that PR merges and Cluster A rebases. Until then the store read's failure branches are covered purely in `tests/ship-train-provenance.test.mjs`. The DB suite already ran green (12/12) against a local disposable container, and that run caught two real SQL defects (a locale-dependent `ORDER BY`, and `COLLATE` on a `DISTINCT` `ORDER BY`).

  Files: `scripts/lib/ship-train/provenance.mjs` (create), `scripts/lib/store/train-provenance.mjs` (create), `scripts/lib/commit-trailers.mjs` (modify), `tests/commit-trailers.test.mjs` (modify), `tests/ship-train-provenance.test.mjs` (create), `tests/ship-train-provenance.db.test.mjs` (create), `scripts/db-test-container.mjs` (modify), `.github/workflows/postgres-parity.yml` (modify).
- **Phase 3 — `ship-train.mjs` read-side verbs, stateless**:
  - `plan` (read-only; base pinning read via `gh api` rulesets + classic protection, failing closed to `none`).
  - `message` (read-only).
  - `verify --train` (claim truth over the fleet manifest, git, GitHub and the store; read-only apart from its pending-note).
  - `publicationClearance` (pure).
  - `plan` reads `node scripts/fleet.mjs status --json` (the CLI, so no fleet edit) plus git. `verify` reads the fleet manifest through fleet's own `readTrain` (an import, not an edit).

  Files: `scripts/lib/store/train-provenance.mjs` (modify — add `findCodeRunForRepo`), `scripts/lib/ship-train/verify.mjs` (create — claim truth + clearance, pure over gathered facts), `tests/ship-train-verify.test.mjs` (create), `scripts/lib/ship-train/commands.mjs` (create — the verbs over an injected context; under lib/ so tests import them without a `tests → ship` edge, which the layering test forbids), `scripts/ship-train.mjs` (create — thin CLI: argv, real context, rendering), `tests/ship-train-cli.test.mjs` (create).
  - *Amended during implementation:* no `npm run` alias. A synced SKILL.md must name tooling by path (AGENTS.md shape #5), so an alias would serve nobody. `CLI_SMOKE_SET` membership moved to Phase 6, because membership asserts consumer **presence** and so needs the `sync-to-repos.mjs` declaration in the same edit.
  - *Amended 2026-10-12 (pre-push):* `.audit-loop/domain-map.json` (modify) moves here from Phase 5. `tests/domain-map-subsystem-coverage.test.mjs` requires `scripts/lib/ship-train/**` to be claimed explicitly (tagged `ship`), and the edges this cluster already has are declared with reasons: `tests → ship` (the precedent is `tests → fleet`) and `ship → fleet` (the CLI reads fleet's manifest and calls `classifyUpdatedHead`; §2.4).
  - *Amended 2026-10-12 (§2.8):* the receipt module and its tests (`scripts/lib/ship-train/receipt.mjs`, `tests/ship-train-receipt.test.mjs`), and the `prepare`/`abandon` verbs, are removed. ship-train persists no state.
- **Phase 4 — Serial `messageFor` seam**:
  - An optional callback `messageFor({source, headOid, baseOid}) → {subject, body} | {stop: reason} | null`. When it is absent, or returns `null`, behaviour is byte-identical to today.
  - `{stop}` ends the serial run **before** that PR's merge, with the reason recorded in fleet's serial record. This is how a fresh decision that became a refusal is honoured.
  - The message goes to a temp `--body-file` under the train's log dir and is removed after the merge.
  - On resume, the callback simply runs again on the current head. Nothing is replayed.

  Files: `scripts/lib/fleet/serial.mjs` (modify), `tests/fleet-serial.test.mjs` (modify).
  - *Amended during implementation (Cluster B):*
    - `baseOid` is the destination's tip read **at that moment** (`git ls-remote`), or `null` when it cannot be read. It is only read when a `messageFor` is present, so the absent path makes no extra git call.
    - A callback that **throws**, returns an empty or multi-line subject, a NUL, or any shape other than `{subject, body}` / `{stop}` / `null` is treated as `{stop}`. A caller that asked for a message must never get an unmessaged merge by accident.
    - The body file is `serial/<trainId>.pr-<n>.msg`. It is removed in a `finally` immediately after the `gh pr merge` call, because `gh` reads it during that call.
    - The test fixtures (`trainFx`, `updatedHead`, `scriptedGh`) moved to `tests/helpers/fleet-serial-fx.mjs`, shared with `tests/ship-train-recovery.test.mjs`.
    - **Audit R1 M4 (GPT sustained after a rebuttal): the requirement is durable.** An approval that supplies a `messageFor` records one immutable `messageRequired: true` in fleet's own serial record (absent everywhere else, so ordinary runs and pre-existing records behave as before). A resume without a provider, or a provider that answers `null`, stops before any merge. This is not a ship-train receipt: no message body, decision or verification result is stored, only a fixed constraint of the run, owned by the runner that enforces it. The cost is an additive field in a strict v1 schema, so a fleet older than this change refuses to read such a record.
    - **Audit R1 H1/M3/M5/M6/M8:** a message file left by a process that died is swept when the next run starts (under the run lease); both child processes have deadlines (message 5 min, publication 30 min); `sync` runs under a per-train exclusive lease so a second concurrent sync is refused before it can touch the first's worktree.
- **Phase 5 — `land` and `sync` verbs**:
  - `land --train <id> [--resume] --composer <line> [overrides]` reads the fleet manifest, refuses unless fleet calls it approvable, and calls `approveSerial` (or `resumeSerial`) with a `messageFor` that decides fresh per head.
  - `sync --train <id> [--accept-interleaved] [--accept-provenance-mismatch]` re-runs verification in the same invocation and gates on `publicationClearance`. It then does a detached `git worktree add` at the final merge OID and checks that commit's tree. It provisions dependencies with `provisionNodeModules` (`scripts/lib/pinned-worktree/manage.mjs`, the pinned-revision precedent), runs `sync-to-repos.mjs` then `sync-pr.mjs`, writes the Step 6.8 note, and removes the worktree.
  - Fault-injection tests interrupt before and after each merge and each consumer sync, and assert recovery from owned state only.
  - Domain-map `allowedDeps` for `ship → fleet`, if the layering test requires it.
  - *Amended during implementation (Cluster B):*
    - **`messageFor` is synchronous, so `land` decides it in a child process.** Fleet's serial loop holds a file lease and sleeps with `Atomics.wait`; the store query is async. The callback therefore runs `ship-train message --pr <n> --json` as a child (argv array, no shell) and reads its JSON. That is the same verb a human previews with, so what is previewed is what lands. The callback refuses a message whose `headOid` is not the head serial is merging.
    - `land` takes `--resume` and `--accept-rerun` (fleet's own flag for a green-after-rerun train). Every override is still read only from the invocation. `requiredChecks` and `serialTimeoutMs` come from `.fleet.json` exactly as `fleet land` reads them.
    - **`sync`'s rollback protection is `sync-to-repos`'s own** (`--allow-rollback` is never passed). `sync` publishes the final merge OID, reports how many newer commits are on the destination, and runs `sync-to-repos --no-prompt` then `sync-pr` with default targets. A leftover publication worktree from an interrupted run is cleared before a new one is created. The worktree is removed on every outcome, a removal failure is reported and never masks the original failure, and no Step 6.8 note is written for a publication that did not complete.
    - The Step 6.8 note records the consumer-side result as `unverified (blocked: sync-isolation-verify not run in each consumer's MAIN checkout)`, because `sync` does not run it.
    - Fault injection (`tests/ship-train-recovery.test.mjs`) runs against REAL fleet serial landing with a scripted `gh`. The decision under test is the real `decideTrainGate` + `composeSquashMessage` over a canned binding; only the store read is canned. Negative controls: a cross-attempt message cache fails 3 of the 5 tests, and dropping the head comparison fails 2.

  Files: `scripts/ship-train.mjs` (modify), `scripts/lib/ship-train/commands.mjs` (modify), `tests/ship-train-cli.test.mjs` (modify), `tests/ship-train-recovery.test.mjs` (create), `.audit-loop/domain-map.json` (modify).
- **Phase 6 — `/ship --train` skill surface**: a usage row, a pointer section and the reference doc, plus a one-line cross-reference from fleet's landing doc. Files: `skills/ship/SKILL.md` (modify), `skills/ship/references/train-mode.md` (create), `skills/fleet/references/landing.md` (modify).
- **Phase 7 — Records and invariants docs**: the status.md train-entry template (titled by date + PR list, with a planned-gate and `identityProvable` column); in the provenance reference, the second emission point, the content-binding rule, the server-pin precondition for `passed` on squash, and `converged`'s widened reading; AGENTS.md's provenance paragraph ("written only by" → two emission points, one renderer, one evaluator; `converged` = "not asserted equal"). Files: `skills/ship/references/status-md-format.md` (modify), `docs/reference/commit-provenance.md` (modify), `AGENTS.md` (modify).

- **Phase 8 — Train-run thinness metric** (§2.10 train side; PROPOSED):
  - `ship-train verify` reports whether the train's combined run failed on a test the branch tier did not select, reading fleet's run record and the gate-cost plan's selection for each PR head.
  - Until that selection exists, the field reads `unmeasured`, never zero.
  - The branch tier itself is the gate-cost plan's, not built here.

  Files: `scripts/lib/ship-train/verify.mjs` (modify), `scripts/lib/ship-train/commands.mjs` (modify), `tests/ship-train-verify.test.mjs` (modify).

**Close-out (not a phase)**: `npm run skills:regenerate`, `npm run skills:check`, `npm run bundle:deps`, `npm run plans:index`, then `npm test`. The shared generated files in `.fleet.json` `hotFiles` are regenerated at rebase, never claimed.

### Key exports and dependencies

| File | Exports | Imports | Imported by |
|---|---|---|---|
| `scripts/lib/ship-train/impact.mjs` | `classifyPrImpact`, `isTrainDue`, `TIERS` | `file-taxonomy.mjs` | `ship-train.mjs` |
| `scripts/lib/ship-train/provenance.mjs` | `bindAuditRun`, `decideTrainGate`, `composeSquashMessage`, `modelsFromRun` | `commit-trailers.mjs`, `model-resolver.mjs` (`modelFamily`) | `ship-train.mjs` |
| `scripts/lib/ship-train/verify.mjs` | `verifyTrain`, `checkClaimTruth`, `readAiTrailers`, `publicationClearance` | `commit-trailers.mjs` | `commands.mjs` |
| `scripts/lib/store/train-provenance.mjs` | `findCodeRunCandidates` | `db/client.mjs`, `db/errors.mjs`, `store/repo.mjs` | `ship-train.mjs` |
| `scripts/ship-train.mjs` | CLI only | the modules above, `sync-inventory.mjs`, `fleet/serial.mjs`, `fleet/registry.mjs`, `pinned-worktree/manage.mjs` (`provisionNodeModules`), `cli-io.mjs` | `skills/ship/references/train-mode.md` (prose) |

## 8. Risk & Trade-off Register

- **R1 — Base moves between update-branch and merge.** `--match-head-commit` protects the head, not the target. *Resolved by construction* (round-1 H1): `passed` is offered only where the server refuses a non-up-to-date merge (§2.3). On an unpinned destination, which is this repo as measured, audited PRs land as `converged` with `identityProvable:false`. Residual: the protection read could be wrong or change mid-train. T6's `%T` check catches that and **blocks publication** until a human has read it.
- **R2 — Planned gates in the log can differ from actual.** Covered in §2.1. The entry labels its column "planned", and T6's pending-note records the actual gates. No stored diff is kept.
- **R8 — No single ship-train file shows a train's progress.** *Accepted* (§2.8): the record is fleet's manifest + serial record + GitHub + the sync tools' journals, each owned by its writer. A train-progress view, if ever wanted, is a **read** over those, never a new store.
- **R9 — Authorization of a `not-run` on a non-ride-along leaves no machine trace.** `--allow-unaudited` is an invocation flag. *Accepted*: verify reports such PRs, and the status.md entry, written by the model under the human's `/ship --train`, names every override typed.
- **R3 — Unbound PRs because of a stray untracked file in the audited worktree.** The binder refuses, and the honest repairs are `--waive` or a re-audit. *Accepted*: refusing beats inferring. `plan` names the newest `sha-only` ancestry candidate, returned by the same query (§2.3), so the operator can see the cause.
- **R7 — `converged`'s meaning widens.** It now also covers "equality not provable at commit time". The widening only *removes* an implied claim ("the tree differs"). It never adds one, and it carries no new trailer. A reader who needs the distinction has `AI-Audited-Tree`'s presence (on `passed`) and the train entry's `identityProvable` column. *Accepted*, documented in Phase 7.
- **R4 — Closure on the base under-classifies a PR that only *adds* synced files.** Benign direction, as §2.5 explains.
- **R5 — The coordinator's log branch must itself be a fleet session.** It claims only `status.md`. Parallel `/ship` runs no longer touch status.md, which **removes** today's main status.md conflict source.
- **R6 — Sessions that still run single `/ship`.** Single `/ship` stays valid for coordinator-less work. It is unchanged, and its squash-body loss is the same defect. *Deferred (D1)*: `/ship`'s own branch path could pass the body at merge time too, but `/ship` does not merge (it pushes a branch). That needs its own design and is out of scope here.
- **D2 — Deferred**: a `messageFor` for `direct-squash`/`direct-merge` modes (`applySources`). No current consumer of this feature uses them. This repo is `pr` mode (the fleet default) and, measured 2026-10-11, has no ruleset or branch protection on `main`.
- **D3 — Deferred**: backfilling provenance for the 56 already-merged commits. Not possible honestly: the squash trees exist, but claims made after the fact would not be produced at ship time.

## 9. Testing Strategy

**Tier 1, test-first (pure):**
- **`classifyPrImpact`**:
  - a closure hit beats everything (including a `tests/fixtures/**` file that is in the closure);
  - code outside the closure → `standard`;
  - only `docs/**`, `*.md` or `tests/**` → `ride-along`;
  - an empty file list → `ride-along`, flagged with reason `no-files`;
  - a rename **out of** the closure → `urgent` (old endpoint);
  - a rename **into** the closure → `urgent`;
  - a delete of a closure file → `urgent`;
  - a rename from `tests/` into `scripts/` → not `ride-along`;
  - a path containing a space and one containing a newline both parse correctly from `-z` output.
- **`isTrainDue`**:
  - all four triggers fire;
  - three ride-alongs → **not** due (the contradiction case);
  - `--end-of-day` with only ride-alongs → not due.
- **`bindAuditRun`**:
  - a tree match on the head;
  - a tree match on an earlier commit (delta recorded);
  - the newest converged run wins;
  - **a `sha-only` candidate never binds** for `passed`/`converged` (the must-not-fire direction);
  - a run on the merge-base `B` is never a candidate.
- **`decideTrainGate`**:
  - every row of the §2.3 table;
  - **`passed` is refused whenever `basePinning !== 'strict'`, even with equal trees** (the must-not-fire direction for H1);
  - `AI-Audited-Tree` is present only on `passed` (assert its **absence** on `converged`);
  - refusals name the override flag.
- **`evaluateGateVerification` with `identityProvable`**:
  - the default `true` leaves all existing `tests/commit-trailers.test.mjs` cases unchanged;
  - `false` refuses `passed`;
  - `false` permits `converged` on equal trees;
  - `false` never turns a non-converged or absent store row into an accept.
- **`modelsFromRun`**:
  - a row with only `final_review_model` yields that family plus the composer, nothing else;
  - no hard-coded `gpt`/`gemini` without a recording column.
- **`composeSquashMessage`**: the output round-trips through `parseMessageTrailers` as a **parseable trailer block**. This is the regression test for class B (§1.1): B1 (body replaced) and B2 (block buried mid-list) both fail this round-trip.

**DB-gated (enrolled twice):** `findCodeRunCandidates` against real Postgres:
- matches by tree (kind `tree`);
- matches by sha (kind `sha-only`);
- a row matching both is reported once, as `tree`;
- deterministic ordering;
- excludes plan-mode runs and other repos;
- a missing column reads as a loud schema fault, not `[]`.

**CLI:**
- `--selfcheck-relocation`;
- unknown flags exit 2;
- `plan --json` against a fixture registry with git repos;
- `verify` against a bare-origin fixture with squash commits carrying and lacking trailers.

**`serial.mjs`:**
- with `messageFor` absent, the recorded `gh` argv is byte-identical to the current tests;
- when present, `--subject`/`--body-file` are added and the body file holds the message;
- `messageFor` is called with the **post-update** head (fake gh that reports BEHIND, then an updated oid).

**Recovery (fault injection, `tests/ship-train-recovery.test.mjs`):** interrupt immediately before and immediately after each merge submission and each consumer sync. In every case, recovery reads **only owned state** (fleet manifest, fleet serial record, GitHub, sync journals), and must:
- **never resubmit a merge GitHub already performed**;
- decide the message for a still-open PR **fresh** on its current head. Case: strict protection removed between attempts → the retry claims `converged`, not the `passed` the first attempt would have claimed;
- stop **before merging** when the fresh decision is a refusal;
- re-run only the consumers that are not already synced (the sync tools' own no-op contract).

**Source identity (`verify`):**
- a merged head equal to the pinned oid passes;
- a head that is one or two serial base-only updates of it passes, via `classifyUpdatedHead`;
- a head the PR gained after pinning (truthful trailers, valid audit) **blocks with no override flag**;
- an unverifiable link (fetch failure) blocks as unverifiable.

**Claim truth (`verify`):**
- every row of the §2.8 truth list, true and false;
- a body that parses but names a run unrelated to the PR is false;
- `passed` with `AI-Audited-Tree ≠ %T` is false;
- `passed` naming a run whose `audited_tree` is not that trailer is false;
- duplicated keys are false;
- an `AI-Run-ID` from another repository, or naming a plan-mode run, makes `passed`/`converged`/`waived` false;
- an under-claim is true and noted;
- `not-run` on a non-ride-along PR is reported, not failed.

**Publication gate:**
- `sync` re-verifies in the same invocation and refuses on any false claim or unmerged source;
- interleaved foreign commits need `--accept-interleaved`;
- false claims need `--accept-provenance-mismatch`;
- an unmerged source has no override;
- `sync` checks out the final merge OID even when the remote tip has moved past it, and says so;
- acknowledged oids appear in the Step 6.8 note.

**Landing order:** a manifest whose log PR lands first. The final merge OID is the last train merge in first-parent order, not the log's.

**Empirical (pre-ship, verification-discipline):** run `plan` against today's real open PRs (#202–#206) **read-only** and check each binding by hand against the store. A check is not trusted until it has been seen to fail, so the negative control is a PR whose head was amended after its audit.

## 11. Execution Clustering

- **Cluster A** — Phases 1–3 — fix-gate: yes
  - Coupling: the decision core and its read side. The classifier, binder, evaluator input and claim-truth verifier are only meaningful together inside `plan`/`message`/`verify`, and the wiring pass needs to see `decideTrainGate` → `evaluateGateVerification(identityProvable)` and verify's truth check over the same store row in one diff. It touches **no** held path (`scripts/lib/commit-trailers.mjs` is shared-lib, unclaimed), so it can start now.
  - author-tier: standard
- **Cluster B** — Phases 4–5 — fix-gate: yes
  - Coupling: the seam and its only caller. `messageFor` (fleet) and `ship-train land` (ship) must be audited across the boundary, since the post-update-head timing is the correctness claim. **Unblocked 2026-10-12**: the fleet A-D PR (#216) merged and released the claim on `scripts/lib/fleet/**`. Claimed as `claude/ship-trains-b`. If a claim ever reports BLOCKED, stop and report; never `--override`.
- **Cluster C** — Phases 6–7 — fix-gate: final
  - Coupling: the human-facing surface and the invariant docs. They describe A+B and must agree with the CLI as built. **Blocked** on the keyset PR's hold on `skills/ship/SKILL.md` and on the fleet claim for `skills/fleet/**`.
- **Cluster D** — Phase 8 — fix-gate: yes
  - Coupling: the metric reads fleet's combined-run record (needs Cluster B) and the branch tier's selection (needs the gate-cost plan), so it lands after both. **Proposed**: built only after a focused `/audit-plan` of §2.10's train side.
- **Final gate**: the mandatory consolidated Gemini review over the union diff of A+B+C (+D when built).

## Audit Trail

- **/audit-plan** (SID `audit-plan-1791751223`, run `bd49abc4-243e-42cc-85ec-e5d14328841d`), 3 GPT rounds, stopped at the default cap:
  - R1 H5 M2, 7/7 accepted;
  - R2 H2 M1, 3/3 accepted (propagation debt from R1's fixes: interleaving, planned vs actual, landing order);
  - R3 H1, 1/1 accepted (replay permission on resume).
  - Acceptance was 100% in every round. Every finding was a concrete design defect, with no rigor pressure. The cap was reached with the count falling (7 → 3 → 1).
- **Final gate** (Gemini `latest-pro`, `--mode plan`): **APPROVE** on round 1. Disposition `approve`, 0 blocking, 0 debt, 0 new findings, 0 wrongly dismissed.
- **Cluster A `/audit-code`** (SID `audit-code-1791755121`, base `9d6bd80c`, 14 files via `scripts/cycle-cluster-scope.mjs`). Six GPT rounds, the hard cap:
  - R1 H3 M12, 14/15 accepted (1 adjacency control marker dismissed).
  - R2 H1, R3 H3, R4 H2, R5 H3, R6 H2: all accepted and fixed.
  - R2–R6 were each propagation from the previous round's fix in the verify/publication path: interleaving enforcement → re-verify freshness → refusal persistence → revocation record + compare-and-swap → verification bound to the receipt state it judged.
  - Every fix landed with a test that was reverted to confirm it fails, then restored (`scripts/lib/ship-train/**`, 127 tests in the five ship-train suites).
  - Deferred-declared, not gating Cluster A: `skills/ship/references/train-mode.md` (Cluster C); `tests/ship-train-recovery.test.mjs` (Cluster B); `tests/ship-train-provenance.db.test.mjs` plus its two enrolment lists (held for the keyset PR; already 12/12 on a disposable Postgres).
  - Coverage: R1 PARTIAL (7 of 14 files head-cut by the pass budget); R2–R6 COMPLETE on the 8 source files (windowed reads).
  - Census: structure, wiring, be-services and sustainability `completed`; frontend `ineligible` (backend-only diff); quickfix `completed`; adjacency **incomplete** (`ADJACENCY_INCOMPLETE`, maxContainers=20); arch-memory `ineligible` (`--scope diff`).
  - Not converged by the 2-stable-rounds rule: R6 raised 2 HIGH, fixed after it, and there is no R7.
- **Cluster A final gate** (Gemini `latest-pro`): **APPROVE**, round 1. Disposition `approve`, 0 blocking, 0 debt, 0 new, 0 wrongly dismissed. Its envelope reported `Code: PARTIAL, changed lines unmeasured for 7 file(s)`, so the APPROVE covers the examined files only.
- **Stateless amendment (2026-10-12)** — §2.1, §2.2, §2.8, §2.9, §7b, §8, §9 and §11 rewritten to remove the ship-train receipt. §2.8 maps every item the receipt provided to the owned state that covers it.
  - `/audit-plan` R4 (H2 M1): H1, source identity before claim truth, fixed. H2 was rebutted with `scripts/sync-to-repos.mjs:1701` (the sync journal lives in each consumer checkout) and GPT overruled itself, so it is dismissed. M1, the ship-event unit, fixed.
  - R5 (H1): one repo-scoped, code-mode run lookup for every claim; fixed.
  - Gemini plan gate round 2 (`--prior` round 1): **APPROVE**. Disposition `approve`, 0 blocking, 0 debt, 0 new, 0 wrongly dismissed. The Gemini cap of 2 rounds is now used.
- **Cluster A, stateless re-implementation** (`/audit-code` SID `audit-code-1791760063`, base `9d6bd80c`; this replaces the receipt-shaped implementation the R1–R6 session above audited). Net −537 lines.
  - R1 (7 source files): H4 M6 L1, 9 accepted (82%). M1 dismissed as stale (receipt.mjs is removed by the amendment); M6 dismissed as a control marker. Fixes: one repo identity from `origin`; canonical trailer keys; terminator-aware boolean flags; a framed `-z` parse; an `unbindable` input category.
  - R2 (verify + commands): H1 accepted. A PR's commits are now measured from the squash's first parent, so an update-branch can't lend one PR another's run.
  - R3 (5 files), R4 (2 files), R5 (all 7): **PASS, H:0 M:0 L:0**, coverage COMPLETE every round. Converged.
  - Every fix was proven red, then green. That includes the held real-Postgres suite (6/6), where removing the repo-scope clause turns its new `findCodeRunForRepo` test red.
  - Deferred-declared (not gating A): `tests/ship-train-recovery.test.mjs` (Cluster B), `skills/ship/references/train-mode.md` (Cluster C), and the DB suite's two-list enrolment (held for the keyset PR).
- **Cluster A final gate** (Gemini `latest-pro`, stateless code): **APPROVE**, round 1. Disposition `approve`, 0 blocking, 0 debt, 0 new, 0 wrongly dismissed. Its envelope reported `Code: PARTIAL, changed lines unmeasured for 6 file(s)`, so the APPROVE covers what it examined.
