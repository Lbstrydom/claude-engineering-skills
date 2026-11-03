---
summary: Step 3C detail — cluster-state schema, author-tier hint, scope-flag incident, 4a measurement, round-2 rationale.
---

# Clustered execution — detail behind Step 3C

`SKILL.md` keeps the loop, the commands, the classification table and every
decision. This file holds the state-record schema and the measurements and
rationale behind the rules, moved verbatim.

## Cluster execution state — schema

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

## Optional author-tier observation

- **Optional author-tier observation**: if the cluster carries an advisory `author-tier:` hint (§11 grammar), you MAY export `AUDIT_AUTHOR_TIER_HINT=<concrete model id or logical tier>` before invoking `/audit-code` so the audit's observation-only recorder captures actual-vs-suggested tier. This **does NOT change which model runs** — it is pure telemetry (`docs/plans/model-tier-observation.md`). Prefer a concrete model id (e.g. `claude-sonnet-5-5`) so the ladder partition key populates.

## Why `--files`, and only `--files`, scopes the audit

> Passing the derived scope as `--changed` and
> expecting it to scope is the defect this recipe was rewritten to fix —
> measured 2026-08-13, a per-cluster audit declaring 11 files audited **52**,
> because `--scope=diff` recomputed from a working tree shared with another
> session, and 26 of 31 findings were about code the cluster never touched.
> Do NOT hand-compute the change set or hand-apply the admission rules here:
> `cycle-cluster-scope.mjs` does that in code, because parsing NUL-delimited
> git output and applying `isAuditInfraFile` are not things to do in prose.

## Two sets, two purposes

**Two sets, two purposes** — conflating them is unsatisfiable. The
*reconciliation set* includes deletes and both rename operands (that is how an
edit leaving the cluster is detected); the *allowlist* is that set filtered to
paths on disk (the audit's admission policy rejects off-disk paths, so
including them guarantees a shortfall). The script returns both and never
mixes them.

## 3a — why `clusterStartRef` is validated on use

A concurrent session can amend, rebase or check out between
capture and audit — HEAD moved six times in one session here — and a base
that has left this history yields a silently WRONG envelope rather than an
error.
This is the first of two layers: `/audit-code`'s own resolver refuses the
same base (`not-an-ancestor`, hard fail), which is where the exit code is.

## 4a — the measurement behind in-cluster scoring

`/audit-code` grades the cluster's *diff* against the *whole plan*, so a later cluster's not-yet-written file comes back as `[Structure] Missing planned file` — **HIGH**. Measured 2026-08-08 (`gate-honesty-adjudicated-defects.md` §11.1): a cluster's total HIGH went 6 → 5 → 3 while its in-cluster HIGH went 2 → 2 → **0**; at that point its own work was clean and the gate would have refused *forever*, on two files belonging to clusters correctly not yet implemented. A gate that cannot be satisfied by doing the work correctly is the cried-wolf shape that earns `--no-verify`.

## Why the broadest test suite

Unit isolation structurally *cannot* catch the failure modes a delete/refactor cluster introduces: a stale `vi.mock`/`jest.mock` of a now-deleted module path only errors when something actually resolves it (i.e. in integration), and cross-module integration breaks are invisible to per-module unit suites.

## 4.5 — what `finalize-outcomes` captures

This deterministically captures `adjudication_outcome` + `audit_runs.labeled` + the `needs_triage` reconciliation for any finding the ledger omitted — replacing the model-remembered `/audit-code` Step 3.5b for the autonomous path. The `run-id` is the audit's `_cloudRunId` (written on the `--out` JSON; stable across rounds because `audit-loop.mjs`/the audit threads one unified id).

## 3C.2 — why round 2 needs the rebuilt transcript

Skipping this
rebuild is what makes round 2 blind to round 1's deliberation: a `--out
…-v2.json` built from only the (unchanged) per-cluster round results, with no
`--summary`, gives Gemini nothing that distinguishes "never addressed" from
"addressed with cited evidence you already saw," and it re-raises the
identical finding round 2. `--summary` is the existing mechanism Step 7.1
already uses for this — carry it forward here rather than inventing a second
one.

## 3C.2 — why one `--ledger` per cluster

Clustered execution produces
one ledger PER CLUSTER (each cluster's own `/audit-code` invocation writes its
own `.audit/$CLUSTER_SID-ledger.json`); passing only one silently drops every
other cluster's resolutions from the `claude_resolutions` trail the reviewer
sees.
