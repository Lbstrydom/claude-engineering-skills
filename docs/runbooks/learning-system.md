# Adaptive Learning System — Operations Runbook

> Operational detail (CLI, classifier gates, quickfix lifecycle, replay, outbox) for
> the adaptive-learning system. **Design** lives in the master plan
> [`docs/plans/adaptive-learning-v1.md`](../completed/adaptive-learning-v1.md) +
> per-phase `adaptive-learning-phase-{1,2,3}-*.md`. Env vars are in AGENTS.md's
> Environment Variables table. Stubbed from AGENTS.md to keep that file lean.

The system collects telemetry across audit decision points (pass selection,
convergence prediction, arch-memory band, auto-deferral) into the `learning_decisions`
table + a per-repo `recurring_finding_clusters` table. Phase 1 is the foundation;
later phases promote individual decision points to live learners.

## Auto-deferral classifier

Scope-gated to `--scope diff` audits only. Two gates BOTH hold for an auto-defer to
fire: (1) finding `category` in the AUTO_DEFERRABLE_CLASSES allowlist (`style`,
`formatting`, `unused-import`, `dead-code-local`, `comment-quality`, `naming-local`,
`magic-number-local`); (2) deterministic SCM evidence (file not in HEAD~1..HEAD diff,
or matched by an explicit plan marker, or recurring across 2+ rounds). Findings failing
either gate route to `audit_findings.user_action='needs_triage'` and surface in the
weekly review's "Awaiting triage" section.

**Plan-marker syntax** (operators inline these in plan markdown to accept known v1
limits):
```
<!-- audit:accept-v1: <file-glob> :: <reason> -->
```

## Weekly review

Mondays 09:00 UTC, per consumer repo. Sticky GitHub issue with label
`learning-weekly-review`. Hard cap of 7 items: 3 awaiting triage + 3 no-brainer
fix-now (recurring 3+ HIGH or 5+ MEDIUM) + 1 stale deferral (>30 days). Run locally
with `npm run learning:weekly-review -- --repo <name>`.

## CLI

- `npm run learning:weekly-review` — generate digest, post sticky issue
- `npm run learning:stats -- --json '{"repoName":"<owner/repo>"}'` — counts of pending
  triage, no-brainer recurring, stale deferrals. Two things the previous wording got
  wrong, both silent: `repoName` is a **payload field, not an argv flag** (`--repoName`
  is not in `KNOWN_FLAGS`), and without the `--` npm swallows it before the script
  sees it — so the documented command returned `{"unknownRepo":true}` rather than
  erroring. The name must be the **fully-qualified** identity from
  `cross-skill.mjs resolve-repo-identity` (e.g. `Lbstrydom/claude-engineering-skills`);
  a bare repo name also resolves to `unknownRepo`.
- `npm run learning:record` — generic decision logger (mostly for tools)
- `npm run learning:quickfix-stats` — Phase 2; print Beta posteriors per pattern
- `npm run learning:quickfix-rebuild` — Phase 2; rebuild stats cache from cloud
- `npm run learning:quickfix-bootstrap` — **RETIRED (2026-08-09).** Refuses with
  `error:'bootstrap-retired'` and exits non-zero; it writes nothing. Use
  `npm run learning:backfill-outcomes -- --rebuild-stats` instead, which owns
  outcome detection and already runs weekly. It was retired because it was a
  *second* implementation of that detector, free to diverge from the real one,
  and because it had no outcome data — it synthesised every hit as `no_action`
  and wrote those inert weights over whatever was in the cache, including a
  good cloud-built one. It exits non-zero rather than returning a quiet
  `ok:false` so an automation consumer that only checks the exit code cannot
  read "did nothing" as "rebuilt".
- `npm run learning:backfill-outcomes` — Phase 2; drain hits JSONL into
  `learning_decisions`, then resolve unresolved outcomes from file state
- `npm run learning:replay -- <decision_type> [--policy <path>] [--since 30d] [--format markdown]`
  — Phase 3; counterfactual evaluation of a candidate policy against historical
  decisions. Built-in reward fns: `pass_selection`, `convergence_predict`,
  `arch_memory_band` (per master plan §5).

## Live quickfix learner (Phase 2)

Per-repo Beta posteriors over each quickfix pattern's accept-vs-suppress outcomes. The
hot path stays synchronous: `matchPatterns()` reads the derived
`.audit/quickfix-pattern-stats.json` cache (`fs.readFileSync`, no network) and skips
patterns whose `acceptanceRate < 0.20 AND totalHits >= 10` per repo. Cache freshness is
enforced by an out-of-band reconciler (`backfill-outcomes.mjs`) which the weekly cron
runs BEFORE the digest assembly.

**Hit lifecycle**:
1. `.claude/hooks/quickfix-scan.mjs` fires on Edit/Write — appends one record per match
   to `.audit/quickfix-hits.jsonl` with a uuid `hit_id`.
2. `learning:backfill-outcomes` drains new JSONL entries into `learning_decisions`
   (decision_type=`quickfix_hit`, outcome=null).
3. After 30 minutes, the same reconciler examines the file state at the cited path: line
   removed/changed → `accept`; line gained `// quickfix-hook:ignore` → `suppress`; line
   still present, no marker → `ignore`; file deleted → `accept`. Rows older than 30min
   that still can't be resolved stay pending until the next cycle.
4. On the next weekly cron, `learning:quickfix-rebuild` aggregates the resolved outcomes
   into the cache file; the hot path picks them up.

**Skip-rule env tuning**:
- `LEARNING_QUICKFIX_SKIP_THRESHOLD` (default `0.20`) — minimum acceptance rate below
  which a pattern is skipped. Lower = more aggressive skip.
- `LEARNING_QUICKFIX_MIN_HITS` (default `10`) — minimum hit count before the skip rule
  applies. Single-digit hits never trigger.

## Replay framework + remaining telemetry (Phase 3)

Phase 3 ships the **graduation infrastructure** that lets future v2 candidates promote
from telemetry-only to live without a 3-month wait:

**Telemetry hooks**:
- **`convergence_predict`** — `recordDecision` per round in `openai-audit.mjs` capturing
  `{round, highCount, mediumCount, dismissed, totalFindings}`. Outcome resolved
  out-of-band by reading `audit_runs.round_converged_after` + `rigor_pressure_round`
  once the run finishes (this round vs convergence point → `converged-here` /
  `continued` / `wasted`).
- **`arch_memory_band`** — `recordDecision` per neighbourhood-query record in
  `scripts/lib/neighbourhood-query.mjs`. Off-audit; `decision_key` format is
  `arch_memory_band:<symbol_index_id>`. Outcome resolved by scanning git history within
  30 min of the decision: `reuse-correct` (no edits in dir), `wrong-fork` (edits despite
  reuse recommendation), `extend-correct` (edits consistent with extend recommendation),
  or `uncertain`.

**Replay engine** (`scripts/lib/learning/replay.mjs`): pure counterfactual evaluator.
Reads historical `learning_decisions`, runs both a baseline policy + a candidate policy
on each row's recorded context, computes reward distributions + delta summary. Built-in
reward functions encode the master plan §5 promotion gates for all three decision types.

**Replay CLI** (`scripts/learning/replay.mjs`):
```
npm run learning:replay <decision_type> \
  [--policy <module-path>] \
  [--baseline <module-path>] \
  [--since 30d] \
  [--repo-id <uuid>] \
  [--format json|markdown]
```
Custom policy modules export either `default` or `policy` as a function mapping
`(context) → choice`. Stdout is JSON by default; markdown switch produces a comparison
table.

**Promotion recipe** (per master plan §5): collect ≥30 days of telemetry, write a
candidate policy fn, run replay, validate metrics (e.g. `pass_selection` ≤5% recall
loss; `convergence_predict` ≤2% false-stop rate; `arch_memory_band` ≥10% precision lift
on reuse band), then flip a live env flag.

## Environment-aware outbox

On flush failure, decisions spill to `.audit/learning-outbox/` (one JSON file per failed
write, atomic via temp+rename) for replay on next audit start. In CI runtimes
(`process.env.CI` or `GITHUB_ACTIONS` truthy), the disk outbox is disabled in favour of
synchronous retry with exponential backoff (3 attempts: 200ms/600ms/1.8s); failures are
counted as `lostInCI` and logged but never crash the run.

### The outbox is also the EVICTION path (2026-08-09)

`flush()` is no longer the only producer. When a per-type queue is at
`LEARNING_QUEUE_CAP_PER_TYPE`, `recordDecision` spills the **oldest** entry to the same
outbox *before* removing it from memory, and the removal is conditional on that spill
succeeding:

| Condition | Queue action | `recordDecision` returns | Counter |
|---|---|---|---|
| Under cap | enqueue new | `decisionKey` | — |
| At cap, spill **succeeds** | shift oldest, enqueue new | `decisionKey` | `evictedOutboxed++` |
| At cap, spill **fails** | **retain oldest, do not enqueue** | **`null`** | `backpressureRejected++` |

Two operational consequences:

- **`recordDecision` can return `null` for a second reason.** Previously only
  `LEARNING_DISABLE=1`; now also back-pressure. A returned key is a *receipt*, and one is
  never issued for a decision that was not admitted. Callers already tolerate `null`.
- **This is environment-independent.** There is no CI carve-out, deliberately: `flush()`
  may lose an *already-admitted* entry in CI because a receipt was issued and only later
  could the write not be made, whereas eviction happens at *admission*, where refusing
  costs the caller nothing. Dropping post-receipt is a lie; refusing pre-receipt is not.

`reconcileOutbox` needs no change — it already replays the whole directory, so an evicted
decision is recovered on the next audit start.

**Reading the flush summary**: `dropped` now counts only entries that were admitted and
then *permanently* lost (today: the CI-loss path). `evictedOutboxed` entries are
recoverable from disk, and `backpressureRejected` decisions were never admitted — neither
is a loss, and neither contributes to `dropped`.

## Opt-outs

- `LEARNING_DISABLE=1` — global kill switch; disables all live learning + telemetry
  recording in one env var.
- `LEARNING_QUEUE_CAP_PER_TYPE=64` — bounded sub-queue cap per `decision_type`. Defaults
  to 64; high-frequency event types cannot evict low-frequency ones.
