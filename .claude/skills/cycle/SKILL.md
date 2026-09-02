---
name: cycle
description: |
  End-to-end feature cycle orchestrator. Runs the full skill chain in
  sequence: /plan → /audit-plan → (wait for human implementation) →
  /audit-code → /persona-test (if frontend/full-stack) → /ux-lock (if
  fixes shipped) → /ship. Use when starting a new feature or non-trivial
  fix and you want the whole workflow on autopilot. Supports resuming from
  an existing plan or straight to code-audit, per-step skips, max-round
  pass-through, and an opt-in autonomous mode that implements + audits each
  plan cluster (the default still pauses for the human).
  Triggers on: "run the full cycle", "do the whole flow", "plan + audit
  + ship", "feature cycle", "/cycle".
  Full command syntax: see the Usage section in this skill.
---

> **Worktree preflight** — in a linked git worktree the synced tooling tree
> `scripts/.claude-skills/` is absent — it is gitignored, so `git worktree add`
> does not populate it, and every command below that uses it dies on a bare
> `MODULE_NOT_FOUND`. Run `npm run skills:hydrate` first.
>
> If this repo defines no such script, it has not adopted the remedy yet. Add
> this entry to its `package.json` `scripts` and run it — it copies the tooling
> tree in from the main checkout, and leans on nothing but node and git:
>
> "skills:hydrate": "node -e \"const{execFileSync}=require('node:child_process'),p=require('node:path'),f=require('node:fs');const main=p.dirname(execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim());const dir='scripts/.claude-skills';const src=p.join(main,dir);if(p.resolve(dir)===p.resolve(src)){console.log('[hydrate] main checkout - nothing to do');process.exit(0)}if(!f.existsSync(src)){console.error('[hydrate] no tooling at '+src+' - re-sync the main checkout first');process.exit(1)}f.cpSync(src,dir,{recursive:true});console.log('[hydrate] copied '+src)\""
>
> Rationale (source repo only — `docs/runbooks/` is not synced to consumers):
> `docs/runbooks/consumer-adoption.md` §"Linked git worktrees".

## Usage

```
Usage: /cycle <task-description>          — Full chain from scratch
Usage: /cycle plan <plan-file>            — Skip planning; use existing plan
Usage: /cycle code <plan-file>            — Skip to code-audit-then-ship
Usage: /cycle <plan-file> --no-persona    — Skip persona-test step
Usage: /cycle <plan-file> --persona-url <url> — Explicit persona-test target (local dev server, no PERSONA_TEST_APP_URL needed)
Usage: /cycle <plan-file> --no-uxlock     — Skip ux-lock step (no UI changes)
Usage: /cycle <plan-file> --no-ship       — Stop after audit; don't commit or push
Usage: /cycle <plan-file> --max-rounds N  — Pass through to /audit-plan and /audit-code
Usage: /cycle --autonomous <plan-file>    — Opt-in: autonomously implement + audit each §11 cluster (default still pauses for the human)
Usage: /cycle code <plan-file> --cluster <ID> [--baseline-ref <sha>]  — Resume one declared cluster (human clustered path)
Usage: /cycle --autonomous <plan-file> --authorize-stale-reaudit      — Resume a halted autonomous run; re-process stale clusters
```

# Feature Cycle Orchestrator

Chains the existing atomic skills into one workflow so you don't have to
remember which to invoke when. Each step is a delegation to the
underlying skill — this orchestrator just sequences + waits.

**This skill does NOT duplicate logic from the atomic skills**. If you
want fine control over a single step, invoke that step's skill directly
(`/audit-code`, `/audit-plan`, etc.). Use `/cycle` when you want the
golden-path workflow without thinking about it.

<!-- host-contract: no-dispatch; preserves=step-order,step3-pause,skip-flags,blocked-propagation -->

> **On a host with no skill-to-skill dispatch, delegate INLINE.** Claude Code
> can invoke `/audit-code` as a command; VS Code Copilot reads the same
> `.claude/skills/` tree but has no documented mechanism for one skill to
> invoke another. Where a step below says "invoke `/x`", such a host instead
> **opens `skills/x/SKILL.md` and follows it in place**, then returns here and
> continues with the next step.
>
> **Pass the delegated skill its arguments explicitly** — the plan path, the
> sub-command, the flags. `/cycle` already holds those values, so this is
> orchestrator-supplied input (rule 0 of `references/input-acquisition.md`),
> not inference. Without it an inlined `/audit-code` has no user message naming
> a plan, and its own contract would correctly make it ask-and-stop — which
> would deadlock every inline cycle.
>
> **Four invariants survive the fallback, and a run that breaks one is not a
> `/cycle` run:**
>
> 1. **Step order** — the sequence below is unchanged; inlining is a change of
>    mechanism, never of order.
> 2. **The Step 3 pause** — a default (non-`--autonomous`) cycle still stops at
>    the implementation gate. Inlining must not silently turn a paused cycle
>    into an autonomous one.
> 3. **Skip flags** — `--no-persona`, `--no-uxlock`, `--no-ship` are honoured
>    identically.
> 4. **Blocked propagation** — a `[BLOCKED]`, `AUDIT_NOT_RUN` or non-converged
>    result from an inlined skill reaches the Step 8 summary. It must not be
>    swallowed by the skill that ran inline.
>
> **What inlining is NOT**: it is not a subagent and gets no fresh context, so
> a long inlined skill consumes the parent conversation's budget. Say which
> steps ran inline in the Step 8 summary, so a reader can tell a dispatched run
> from an inlined one rather than assuming.

---

## Step 0 — Parse Input

> **A prerequisite that does not resolve is a stop, not a mid-flow death.**
> /cycle spends real money on /plan before it ever reaches an audit step, so
> resolve the audit prerequisites HERE — the helper scripts, and a GPT route
> (`OPENAI_API_KEY` **or** an active Azure profile). If one is absent, the
> ladder in /audit-code's `references/prerequisite-ladder.md` decides what
> happens: hydrate and retry, run the labelled adversarial-agent substitute, or
> report `AUDIT_NOT_RUN` and stop. Whichever rung applies, say so before
> generating the plan rather than after paying for it, and carry the same
> `AUDIT_DEGRADED` / `AUDIT_NOT_RUN` label into Step 6's handoff to /ship so a
> degraded run cannot reach a commit looking clean.

| Input shape | Mode |
|---|---|
| `/cycle <task description>` (no file path) | **FULL** — generate plan, audit it, wait for impl, audit code, ship |
| `/cycle plan <plan-file>` | **SKIP_PLAN** — plan exists; audit it, wait for impl, audit code, ship |
| `/cycle code <plan-file>` | **SKIP_TO_CODE** — plan + impl exist; audit code, validate UX, ship |
| `/cycle <plan-file>` (no `plan`/`code` keyword) | **AUTO** — detect by checking if any new code exists since plan was written |

Optional flags:
- `--no-persona` — skip /persona-test (use when no live URL or backend-only)
- `--persona-url <url>` — explicit persona-test target. Use this for a repo that
  only sets `PERSONA_TEST_APP_URL` for CI/PR-preview but runs a normal local dev
  server otherwise (Step 5 would silently skip without it — see Step 5).
- `--no-uxlock` — skip /ux-lock (use when no UI changes shipped)
- `--no-ship` — stop after audit; don't commit or push
- `--max-rounds N` — pass through to /audit-plan and /audit-code
- `--autonomous` (alias `--implement`) — **opt-in**: autonomously implement + audit each §11 cluster (see "Clustered execution"). On a plan with **no §11 block** it runs the **degenerate single-cluster** path (the whole plan as one unit — Step 3) rather than silently pausing. Without the flag, `/cycle` pauses for the human at Step 3 exactly as today — the autonomous behaviour is never silent either way.
- `--cluster <ID>` — implement/audit a single declared cluster (human resume path).
- `--baseline-ref <sha>` — audit baseline for a resume where no `clusterStartRef` was captured (work already committed).
- `--authorize-stale-reaudit` — resume a halted autonomous run by re-processing exactly the `stale` clusters.
- `--no-cluster` — ignore any §11 block; fall back to the single-audit path.

**§11 detection**: parse the target plan for an `## 11. Execution Clustering`
block. If present (and not `--no-cluster`), set `hasClustering` and parse
the clusters + each cluster's derived file scope. This activates the
clustered-execution path (Step 0.7 preflight + Step 3 branch). Absent → the
classic linear flow below, unchanged.

Show kickoff card:

```
═══════════════════════════════════════
  /cycle — [MODE]
  Steps: plan → audit-plan → audit-code → persona-test → ux-lock → ship
  Skipped: --no-persona, --no-uxlock
═══════════════════════════════════════
```

---

## Step 0.7 — Clustering preflight (when `hasClustering`; fail-closed)

Validate the §11 block **before any execution** — `/cycle code <plan>`
reaches here without having passed `/audit-plan`, so this is the
execution-time safety net (the second of two validation layers). Check:

- **partition** — every §7b implementation phase in exactly one cluster; none omitted/duplicated; close-out outside the phase set;
- **contiguous** ascending cluster ranges (grammar rule 1);
- every `fix-gate` value in `{yes, final, none}`; `Coupling:` present on each cluster;
- trailing `Final gate` line present;
- **derived scope** (member `Files:` + tagged `Additional files:`) is non-empty and fully intent-tagged, validated **per cluster against that cluster's `gateStatus`** in the state record, NOT the global `/cycle` mode: a `pending`/absent cluster uses pre-implementation expectations (`(modify)`/`(delete)` resolve on disk; `(create)` has a resolvable parent dir, no collision, no sensitive-path); an `audited`/`gate-clear`/`stale` cluster uses post-implementation expectations (`(create)`/`(delete)` already done — no false collision on resume).

**On any failure**: stop, present the defect, offer (1) correct the plan or
(2) `--no-cluster` fallback to the single-audit path. Never silently
proceed with a malformed block.

---

## Step 1 — Plan (FULL mode only)

Invoke `/plan <task description>`. The unified `/plan` skill auto-detects
scope (backend / frontend / full-stack) and produces one consolidated
plan document at `docs/plans/<descriptive-name>.md`.

**On failure**: surface the error and abort. Don't proceed to audit.

---

## Step 2 — Audit Plan

Invoke `/audit-plan <plan-file>`. Iteratively refines the plan with
GPT + Gemini final gate. Max 3 rounds; rigor-pressure stop.

**On verdict**:
- `APPROVE` (Gemini) → proceed to Step 3
- `CONCERNS` after Gemini round 2 (cap) → present to user, ask: "Plan has remaining concerns from final review. Proceed to implementation anyway, fix the plan first, or stop?"
- `REJECT` → present to user, recommend stopping the cycle to revise

---

## Step 3 — Implementation gate (branches on mode)

**Decision table (one source of truth — the bullets below elaborate).** The gate is a
pure function of three inputs: the parsed mode, whether the plan carries a §11 block
(`hasClustering`), and the `--autonomous` flag. `SKIP_PLAN` / `SKIP_TO_CODE` mean the
human already implemented, so the gate is bypassed entirely (go straight to Step 4 audit).

| Mode | `hasClustering` | `--autonomous` | Action |
|---|---|---|---|
| FULL / SKIP_PLAN (plan generated/audited, not yet implemented) | no | no | **Pause** for the human (card below) |
| FULL / SKIP_PLAN | no | **yes** | **Degenerate single-cluster autonomous** (whole plan as one unit) |
| FULL / SKIP_PLAN | yes | no | **Pause** + print cluster guidance; resume `--cluster <ID>` |
| FULL / SKIP_PLAN | yes | **yes** | **Step 3C** clustered autonomous loop |
| SKIP_TO_CODE (already implemented) | any | any | **Empty-diff guard first** (below); then **no gate** — go to Step 4 audit (per-cluster if `--cluster`, else union diff) |

- **No §11 block + default (no `--autonomous`)** → **today's behaviour, unchanged**:
  `/cycle` **pauses here** for the human to implement (or resume later via
  `/cycle code <plan>`). Output the "paused at implementation gate" card
  below. Skipped automatically in SKIP_PLAN / SKIP_TO_CODE modes (the human
  already implemented).
- **No §11 block + `--autonomous`** → **degenerate single-cluster autonomous path**
  (do NOT silently fall back to the pause — that contradicts the explicit
  `--autonomous`). A plan below the §7b Gate-1 / §11 threshold is small + cohesive by
  construction, so treat its **entire** implementation as ONE implicit cluster and run
  the Step 3C loop over it: implement → `/audit-code` over the **union diff** →
  fix-gate to convergence → the **mandatory** consolidated Gemini gate (Step 3C.2) →
  close-out → ship. Print one line up front so it's never silent:
  `plan below the §11 threshold — implementing inline as a single unit (no clustering).`
  The same within-cluster auto-fix authorization applies; a fix needing files outside
  the plan's declared `§7`/`§7b` scope still **stops** for confirmation.
- **§11 block + default (no `--autonomous`)** → still pauses, but prints the
  cluster plan as implementation guidance and instructs the operator to
  **implement only the next cluster**, then resume with `/cycle code <plan>
  --cluster <ID>` (the `--cluster` arg is **required** on every human resume
  — `/cycle` does not auto-divine the next cluster). On resume, Step 4 runs
  the **per-cluster** audit (see Step 3C). If the operator implemented
  several clusters at once (per-cluster isolation impossible), `/cycle` says
  so and falls back to a single union-diff audit.
- **§11 block + `--autonomous`** → enter **Step 3C** (the implement-and-audit
  cluster loop). This is the explicit authorization that relaxes the
  "never auto-fix" hard rule, scoped to within-cluster fixes.
- **SKIP_TO_CODE empty-implementation guard (do this BEFORE auditing).**
  `code` assumes the human already implemented — but an *approved-but-unimplemented*
  plan (e.g. resumed straight after `/audit-plan`, zero commits since) yields an
  **empty implementation diff**, and auditing nothing returns a misleading green.
  So before Step 4, compute the diff base (the plan's commit, or `--baseline-ref`,
  else the dirty-aware base `/audit-code` uses) and check it's non-empty:
  ```bash
  BASE=$([ -n "$(git status --porcelain)" ] && echo HEAD || echo HEAD~1)   # or the plan commit / --baseline-ref
  [ -z "$(git diff "$BASE" --name-only)$(git ls-files --others --exclude-standard)" ] && echo EMPTY
  ```
  If empty → **do NOT audit a no-op.** Tell the operator the plan looks
  unimplemented and offer the fork, naming the EXACT command for each side —
  `--autonomous` alone does nothing here, since `SKIP_TO_CODE` routes straight
  past the implementation gate regardless of the flag (Step 3's decision
  table), so "just add `--autonomous`" is not a fix while the `code` keyword
  stays: (1) drop the `code` keyword and re-run as `/cycle plan <plan-file>
  --autonomous` (let `/cycle` implement it — `plan` mode is the one whose
  gate actually reads `--autonomous`), or (2) implement manually then re-run
  `/cycle code <plan-file>` unchanged. This mirrors the Step 3C rule "never
  default `--diff` to HEAD — empty diff = silent skip" (line ~191), extended
  to the human `code` path. (The AUTO-mode "any new code since the plan
  commit" detection gates this too.)

```
═══════════════════════════════════════
  /cycle paused at implementation gate
  Plan: docs/plans/<name>.md
  Resume with: /cycle code docs/plans/<name>.md
═══════════════════════════════════════
```

---

## Step 3C — Clustered execution (when `hasClustering`)

### Cluster execution state — `.audit/cycle-cluster-state.json`

Durable, gitignored, lock-guarded (`withFileLock` for read-modify-write,
atomic temp+rename; lock-acquire failure → stop, no racy overwrite).
Schema: `{ schemaVersion:1, repoId, entries: { <canonicalPlanPath>: {
clusters: { <clusterId>: <record> } } } }` — the path maps to a
**collection** of cluster records (not the §11 content hash, so amending
the plan never orphans cleared clusters). Per-cluster record: `{ clusterId,
gateStatus: pending|audited|gate-clear|stale, scopeHash (this cluster's §11
declaration + derivedScope), auditedBaselineRef, derivedScope:[…tagged
paths…], auditedFileHashes:{path:sha256 over all derivedScope paths},
lastAuditRound, lastUpdated }`. A `gate-clear` cluster flips to **`stale`**
if any `derivedScope` hash changes OR its `scopeHash` changes; amending one
cluster updates/invalidates only that cluster's record.

### Loop (autonomous)

State-driven + resumable: read state first, **skip `gate-clear` clusters**.
For each remaining cluster in declared order:

1. **Implement** the cluster's member-file phases.
2. **Budget**: no runtime splitting in v1 — invoke `/audit-code` on the cluster's derived scope and let its internal map-reduce handle large diffs. `/cycle` only enforces **never merge** across a declared boundary.
   - **Optional author-tier observation**: if the cluster carries an advisory `author-tier:` hint (§11 grammar), you MAY export `AUDIT_AUTHOR_TIER_HINT=<concrete model id or logical tier>` before invoking `/audit-code` so the audit's observation-only recorder captures actual-vs-suggested tier. This **does NOT change which model runs** — it is pure telemetry (`docs/plans/model-tier-observation.md`). Prefer a concrete model id (e.g. `claude-sonnet-4-6`) so the ladder partition key populates.
3. **Audit envelope**: capture `clusterStartRef` (`vcs.gitCommitSha`) when implementation begins, write the cluster's derived scope one-path-per-line to a scope file, then run the two commands below. On a resume with no recorded `clusterStartRef`, require `--baseline-ref <sha>` or fall back to union-diff — **never** default the base to HEAD (empty diff = silent skip). Round policy is `/audit-code`'s own cap — no new policy here.

   > **`--files` is the ONLY flag that scopes the audit.** `--changed` is the R2+
   > impact set for reopen detection and `--diff` is annotation context; neither
   > bounds what the model reads. Passing the derived scope as `--changed` and
   > expecting it to scope is the defect this recipe was rewritten to fix —
   > measured 2026-08-13, a per-cluster audit declaring 11 files audited **52**,
   > because `--scope=diff` recomputed from a working tree shared with another
   > session, and 26 of 31 findings were about code the cluster never touched.
   > Do NOT hand-compute the change set or hand-apply the admission rules here:
   > `cycle-cluster-scope.mjs` does that in code, because parsing NUL-delimited
   > git output and applying `isAuditInfraFile` are not things to do in prose.

<!-- cycle:cluster-audit-command -->
```bash
# 1. Deterministic half, in code. Resolves the base to an immutable OID, builds
#    the reconciliation set (status-aware: deletes and BOTH rename operands),
#    filters to on-disk paths for the allowlist, runs the admission pre-flight,
#    writes the patch. EXITS NON-ZERO on an out-of-scope edit, an unadmittable
#    path, or a comma-unsafe path — when it does, STOP and show its stderr.
node scripts/cycle-cluster-scope.mjs --base "$CLUSTER_START" \
  --scope-file "$SCOPE_FILE" --out-dir .audit --cluster "$ID" --json > "$SCOPE_JSON"

# 2. Audit using ONLY values that call produced. Read them with node, not jq —
#    node is guaranteed here; jq is not, and is absent from check-deps.mjs.
FILES=$(node -p "require('./$SCOPE_JSON').filesCsv")
PATCH=$(node -p "require('./$SCOPE_JSON').diffPath")
INFRA=$(node -p "require('./$SCOPE_JSON').allowInfraScopeRequired ? '--allow-infra-scope' : ''")

node scripts/openai-audit.mjs code "$PLAN" --scope diff \
  --files "$FILES" --changed "$FILES" --diff "$PATCH" $INFRA
#   --files   : THE scoping flag — an allowlist; makes --scope a no-op
#   --changed : R2+ reopen/impact detection only — does NOT scope
#   --diff    : annotation context only — does NOT scope; must be a real file
```
<!-- /cycle:cluster-audit-command -->

   **Two sets, two purposes** — conflating them is unsatisfiable. The
   *reconciliation set* includes deletes and both rename operands (that is how an
   edit leaving the cluster is detected); the *allowlist* is that set filtered to
   paths on disk (the audit's admission policy rejects off-disk paths, so
   including them guarantees a shortfall). The script returns both and never
   mixes them.

   **A deletion-only cluster has an empty allowlist** and reports
   `emptyAllowlist: true`. That is correct — there is no code to read. Route it
   to the consolidated Gemini gate over the union diff, where the deletion IS
   visible; do not record a vacuous per-cluster pass.
4. **Fix-gate**: `fix-gate: yes` → reach `/audit-code` convergence (`HIGH==0 && MEDIUM<=2 && quickFix==0`) **over this cluster's IN-CLUSTER findings** (see 4a) before the next cluster; `none` skips; `final` defers to the consolidated gate. Within-cluster fixing is authorized; a fix needing files **outside** the cluster's scope → **stop** for confirmation (mark any touched `gate-clear` cluster `stale`). Persistent non-convergence → hand back with a summary.
   - **3a. `clusterStartRef` is validated ON USE, not just captured.** Run
     `git merge-base --is-ancestor <clusterStartRef> HEAD` before it becomes a
     diff base. A concurrent session can amend, rebase or check out between
     capture and audit — HEAD moved six times in one session here — and a base
     that has left this history yields a silently WRONG envelope rather than an
     error. On a non-ancestor, halt and report rather than demoting to the
     dirty-aware default, which would quietly widen the range you asked for.
     This is the first of two layers: `/audit-code`'s own resolver refuses the
     same base (`not-an-ancestor`, hard fail), which is where the exit code is.
   - **4a. The gate scores IN-CLUSTER findings only — otherwise no cluster but the last can ever pass.** `/audit-code` grades the cluster's *diff* against the *whole plan*, so a later cluster's not-yet-written file comes back as `[Structure] Missing planned file` — **HIGH**. Measured 2026-08-08 (`gate-honesty-adjudicated-defects.md` §11.1): a cluster's total HIGH went 6 → 5 → 3 while its in-cluster HIGH went 2 → 2 → **0**; at that point its own work was clean and the gate would have refused *forever*, on two files belonging to clusters correctly not yet implemented. A gate that cannot be satisfied by doing the work correctly is the cried-wolf shape that earns `--no-verify`. Classify every finding by the cluster owning its cited file — the derived scopes are already computed, so this is mechanical, not a judgement call:

     | Cited file is in… | Class | Effect on THIS gate |
     |---|---|---|
     | this cluster's derived scope | `in-cluster` | **gates** — fix it, pre-existing or not |
     | a **later** cluster's derived scope | `deferred-declared` | does not gate; **must be zero at the final gate** |
     | an **earlier** cluster's derived scope | `regression` | **gates** — that cluster is now `stale`; go to step 5 |
     | **no** cluster's derived scope | `out-of-scope` | unchanged: fail closed per step 3 |

     Three properties stop this becoming an escape hatch, and all three are load-bearing: **(1)** deferral is *bounded* — `deferred-declared` means "owned by a LATER cluster", and the final cluster has none, so the bucket is empty there by construction and every deferred completeness finding must be satisfied before Step 3C.2; **(2)** *"pre-existing" is still not a defer reason* — these buckets are about plan SCHEDULE, never authorship, so AGENTS.md's impact test applies unchanged to anything in-cluster; **(3)** the classification is *derived*, never argued — a finding cannot be talked into a friendlier bucket. **Every `deferred-declared` finding is listed in the cluster's hand-back summary with the cluster that owns it** — a deferral nobody can see is indistinguishable from a dismissal.
   - **Convergence test scope — run the BROADEST suite, not unit-only (load-bearing for destructive clusters).** When "iterate to green" runs the project's tests at the cluster boundary, use the widest command the repo defines (`test:all` / `test:integration` / `test:e2e` — fall back to plain `test` / the full `node --test`), **never `test:unit` alone**. Unit isolation structurally *cannot* catch the failure modes a delete/refactor cluster introduces: a stale `vi.mock`/`jest.mock` of a now-deleted module path only errors when something actually resolves it (i.e. in integration), and cross-module integration breaks are invisible to per-module unit suites. A cluster is "green" only when the integration tier passes; a `test:unit`-only green on a destructive cluster is a false-green and does **not** clear the fix-gate.
4.5. **Finalize outcomes (deterministic capture — WS1)**: once the cluster's audit has converged AND its findings are triaged (the adjudication ledger carries terminal `accepted`/`dismissed`/`severity_adjusted` outcomes), call **once** per converged audit:
   ```bash
   node scripts/cross-skill.mjs finalize-outcomes \
     --run-id <result._cloudRunId> --ledger <final-ledger.json> --result <final-round-result.json>
   ```
   This deterministically captures `adjudication_outcome` + `audit_runs.labeled` + the `needs_triage` reconciliation for any finding the ledger omitted — replacing the model-remembered `/audit-code` Step 3.5b for the autonomous path. The `run-id` is the audit's `_cloudRunId` (written on the `--out` JSON; stable across rounds because `audit-loop.mjs`/the audit threads one unified id). Cloud-off → it no-ops with a hint; an unknown run-id is a hard error. Skip only when the audit produced no cloud run (cloud off).
5. **After the loop**: if any `gate-clear` cluster went `stale`, **halt + summarize**; resume only with `--authorize-stale-reaudit`, which re-processes exactly the stale clusters (their out-of-scope reconciliation ignores files owned by *other* clusters, since later clusters legitimately committed since the old baseline). No autonomous loop-back.

### Step 3C.1 — Close-out execution (autonomous)

The loop only iterates §7b phases, so the plan's unclustered close-out
(e.g. `npm run skills:regenerate` + `npm run skills:check`, build/codegen)
would never run. After the last cluster clears and **before** the
consolidated gate, parse and execute the plan's close-out step(s),
surfacing failures. (Human path leaves close-out to the operator.)

### Step 3C.2 — Consolidated Gemini gate (closed loop, mandatory)

**First, the deferrals come due.** Step 4a lets a cluster defer a finding that
belongs to a *later* cluster; this is where that debt is settled, because there
is no later cluster left. Before invoking the reviewer, re-check every
`deferred-declared` finding accumulated across the run: each must now be
satisfied (the file exists, the migration ran, the phase landed). **Any that
remain are the plan's own §7b work, unimplemented** — halt and summarize rather
than asking Gemini to bless an incomplete change set. This check is what makes
4a a deferral instead of a dismissal, so it is not optional and not
Gemini's job.

After all clusters (+ close-out), run **one** Gemini review over the
**union diff** — mandatory regardless of per-cluster GPT convergence, and a
**closed loop**: `APPROVE` → done; `CONCERNS`/`REJECT` → deliberate, apply
fixes scoped to the union diff (the per-cluster out-of-scope stop does NOT
apply here — no active cluster; touched `gate-clear` clusters are flagged
`stale` for the next run), **re-run Gemini**. **Max 2 consolidated rounds**
(symmetric with `/audit-plan`'s Gemini cap): after round 2 with `CONCERNS`,
triage by finding character — a concrete **design/correctness** defect earns one
more round (rare); **implementation-completeness** nits ("specify the store
step", parameter placement) or **rising praise + ~1 nit/round** → **STOP**, the
classic `/audit-code` path (Step 4) already verified the code against the real
implementation, so record + close rather than re-running the union gate. Exit on
`APPROVE`, the capped stop, or explicit handback. Never replaced by GPT
rebuttal. Invocation: build the
transcript the way `/audit-code` does (`changed_files`=union file set,
accumulated per-cluster findings as the `rounds[]` trail), then
`node scripts/gemini-review.mjs review <target> <transcript.json> --out …` —
reuse `/audit-code`'s transcript path, no new gate machinery. **Concrete transcript
shape + the no-`GEMINI_API_KEY` degradation ladder (Opus fallback → independent
adversarial agent over the union diff → only-then skip) are in
`audit-code/references/gemini-gate.md`** — when no provider key is present, run the
independent-agent substitute rather than skipping the mandatory gate. Generated
`.claude/skills/**` copies are byte-verified by `skills:check`, not
re-reviewed. Then continue to Step 5.

---

## Step 4 — Audit Code (classic path — no §11 block)

Invoke `/audit-code <plan-file>` (default `--scope=diff`). Multi-pass
parallel GPT audit with R2+ ledger suppression and Gemini final
review. Max 6 rounds; quality threshold `HIGH==0 && MEDIUM<=2 && quickFix==0`.

**On verdict**:
- `CONVERGED` → proceed to Step 5
- `INCOMPLETE` (passes timed out) → present to user, offer: continue with partial / re-run with higher timeout / stop
- Persistent HIGH findings after R6 → present to user with finding list, recommend fix-then-retry rather than ship

> **Solo author-model control** fires automatically inside `/audit-code`
> (its Step 6.5b — backgrounded, toggle-gated) when the `arm-eval` shadow is on.
> `/cycle` delegates to `/audit-code`, so no separate action is needed here; if
> you run the autonomous per-cluster path (Step 3C) that invokes `/audit-code`,
> it inherits the same trigger.

---

## Step 5 — Persona Test (if scope ⊇ frontend, AND not --no-persona)

Detect whether persona-test is applicable:
- Skip if plan scope is `backend` only
- Skip if `--no-persona` flag passed
- Resolve the target URL in the same order `/persona-test` itself uses
  (Phase 0b): `--persona-url` flag → `PERSONA_TEST_APP_URL` env → (in
  `--autonomous` mode, where there's no human to ask) a running local dev
  server if one is detectable, else skip. **`PERSONA_TEST_APP_URL` unset is
  not the same fact as "no deployed instance"** — a repo that only sets the
  env var for CI/PR-preview but runs a normal local dev server otherwise has
  a perfectly runnable target that this env-only check would miss. If no
  target resolves by any of these, **do not skip silently** — print
  `Step 5 skipped — persona-test has no target (PERSONA_TEST_APP_URL unset;
  pass --persona-url <url> to run it)` in the Step 8 summary so the gap is
  visible rather than assumed-away.

### Step 5.0 — Deploy-topology gate (GREEN ≠ REALIZED #7)

Before driving the browser, resolve whether persona-test can actually GATE here —
**call the seam, don't re-decide in prose** (the decision is a tested function):

```bash
node scripts/cross-skill.mjs preview-gate --format human
```

Act on the directive:
- **`[HALT]`** (`previewGateMode: pre_merge_required`) — a preview env exists and MUST gate.
  Run persona-test against the **preview `--url`** and **halt before merge/ship** until it passes;
  do not let Step 7 ship on a failed/again-skipped persona run.
- **`[WARN]`** (`post_merge_warning` — deploy-from-main / no preview) — surface the warning
  prominently: persona-test here is **POST-HOC and cannot prevent prod exposure**; its P0/P1
  findings are fast-follow, NOT a gate. Proceed, but say so in the Step 8 summary.
- **`[OK]`** (`not_applicable`, default) — silent; proceed normally.

Invoke `/persona-test <persona> <url>` — drives a browser as a registered
persona, collects P0–P3 findings.

**On verdict**:
- 0 P0 findings AND OVERALL is `Ready for users` → proceed to Step 6
- 0 P0 findings AND OVERALL is `Needs work` because of `authWallUntested`
  (persona-test hit a login wall with no auth bootstrap configured — see
  `/persona-test`'s `references/auth-bootstrap.md`) → this is **not** a
  clean pass; it means the run never reached the app's primary
  authenticated surfaces. Surface this explicitly in the Step 8 summary
  (don't silently read "0 P0" as "proceed") and proceed only as a WARN,
  same posture as the `[WARN]` deploy-topology case above.
- ≥1 P0 finding → present to user, recommend fix before ship; offer to feed findings back into a new `/audit-code` round (under `[HALT]`, a P0 **blocks** ship until fixed)

---

## Step 6 — UX Lock (if any new fixes shipped, AND not --no-uxlock)

For each HIGH finding fixed in Step 4, AND each P0/P1 fixed in Step 5,
invoke `/ux-lock` to generate a Playwright spec that locks the fix.

Skip if no fixes were applied OR `--no-uxlock` flag passed OR backend-only
scope.

---

## Step 7 — Ship (unless --no-ship)

Invoke `/ship`. Runs the existing /ship checklist (status update, AGENTS
sync, plan update, stage + commit + push, ship_event log).

**Step 0.5c of /ship** automatically refreshes the architectural-memory
index (incremental refresh, regenerates `docs/architecture-map.md` if
changed). No additional action needed here.

---

## Step 8 — Cycle Summary

```
═══════════════════════════════════════
  /cycle complete — <PLAN-NAME>
  Plan:        docs/plans/<name>.md
  Audit-plan:  3 rounds, APPROVE
  Clusters:    A in-cluster H:0 (2 deferred→C); B in-cluster H:0 (autonomous)  ← only if hasClustering
  Audit-code:  4 rounds, CONVERGED, H:0 M:1 L:2                 ← classic path (no §11)
  Final gate:  Gemini APPROVE over union diff                  ← only if hasClustering
  Persona:    0 P0, 1 P1 (deferred)
  UX-lock:    2 specs generated
  Ship:       commit abc1234 pushed to main
  Total time: 18m
  Total cost: ~$1.40
═══════════════════════════════════════
```

If any step was skipped, note why. If any step exited non-success,
surface as a warning at the top. For clustered runs, show the per-cluster
gate result and the preflight outcome.

---

## Hard rules

- **Never auto-fix** between steps without user confirmation — **except** in
  `--autonomous` mode, where the opt-in flag authorizes within-cluster fixes
  scoped to the active cluster's derived file set (summaries still surfaced;
  cross-cluster fixes and persistent non-convergence still hand back).
- **Never skip `/audit-plan`** unless explicitly in SKIP_PLAN or SKIP_TO_CODE mode.
- **Never skip `/audit-code`** unless explicitly in SKIP_TO_SHIP mode (not currently exposed; reserved).
- **Default is human-orchestrated** — `/cycle` pauses at the implementation gate (Step 3); only the **opt-in `--autonomous`** flag implements code, and it never activates silently.
- **`/cycle` reads the §11 block; it never authors or merges clusters** — it may split-equivalent (defer oversized diffs to `/audit-code`'s map-reduce) but never merges across a declared boundary. Clustering is the plan's job.
- **The consolidated Gemini gate is mandatory** after clustered execution, regardless of per-cluster convergence — and Step 3C.2's deferral re-check runs *before* it, so no `deferred-declared` finding survives the run.
- **A per-cluster fix-gate scores IN-CLUSTER findings only** (Step 4a). Scoring the whole plan against one cluster's diff makes every gate but the last unpassable; deferral is bounded to *later*-cluster scopes and settled at 3C.2. Never widen it to "pre-existing" — that is authorship, not schedule.
- **Cost cap awareness**: estimate total cost upfront from input size and surface it in the kickoff card. A typical full cycle costs $1–3; autonomous clustered runs cost more (one audit per cluster + the final gate).

---

## Reference files

This skill is a thin orchestrator — there are no references. All the
heavy logic lives in the underlying atomic skills (`/plan`,
`/audit-plan`, `/audit-code`, `/persona-test`, `/ux-lock`, `/ship`).
This skill's only job is sequencing.
