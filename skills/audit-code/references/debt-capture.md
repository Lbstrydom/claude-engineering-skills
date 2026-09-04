---
summary: Phase D debt ledger — persist out-of-scope valid findings so they don't re-surface.
---

# Debt Capture (Step 3.6) + Resolution (Step 5.1)

**Purpose**: Persist out-of-scope valid findings to `.audit/tech-debt.json`
so future audits suppress them automatically. Without this step, the same
pre-existing concerns get re-raised every audit, burning tokens and
diluting signal.

**Eligible candidates**: findings from Step 3 triage with `action = defer`
— meaning `validity = valid` AND (`scope = out-of-scope` OR an explicit
deferred reason).

> **Impact-tested, not authorship-tested.** A finding is only `defer`-eligible
> once it passes the Step 3 **load-bearing test**: the change being shipped must
> not depend on the cited code path. A pre-existing finding in a *changed* file
> that the new code rides on is `fix-now`, not debt — see Step 3 "Scope is
> decided by impact, not authorship". The `deferredRationale` for an
> `out-of-scope` entry must state the **independence** (the new code does not
> call/depend on the cited path), not merely that it's pre-existing.

## Required fields per deferredReason

| `deferredReason` | Valid scope | Additional required fields |
|---|---|---|
| `out-of-scope` | out-of-scope | (none beyond rationale) |
| `blocked-by` | any | `blockedBy` (issue/PR/topicId ref) |
| `deferred-followup` | any | `followupPr` (e.g. `owner/repo#123`) |
| `accepted-permanent` | any | `approver` + `approvedAt` |
| `policy-exception` | any | `policyRef` + `approver` |

## Capture flow

One command, run after Step 3.5 (ledger write) and before Step 4 (fix). It
reads the ledger and converts every `ruling: 'defer'` entry into a debt entry,
deriving each one from the ledger's own record:

```bash
node scripts/debt-auto-capture.mjs --ledger .audit/$SID-ledger.json --run $SID
```

`--dry-run` previews without writing. `--reason` overrides the default
`out-of-scope`, paired with its required field — e.g.
`--reason blocked-by --blocked-by "owner/repo#123"`.

**Exit code = did EVERY deferral land.** Exit 0 means a COMPLETE capture
(including the "0 deferred entries found" case). Exit 1 is a missing arg, an
unreadable ledger, a write failure, **or a PARTIAL capture** — one or more
deferred entries failed to build or were rejected by the schema. The entries
that did validate are still written and the command is idempotent (upsert by
`topicId`), so the fix is: read the `Rejected entries:` block, correct the
cause, re-run the same command. Before 2026-09-04 only an ALL-rejected run
exited non-zero, so a run that dropped some deferrals reported success to
`$?` while its own summary card said otherwise.

> **Do not hand-roll this with `node -e` + `buildDebtEntry`/`writeDebtEntries`.**
> An earlier revision of this page documented exactly that loop, importing
> `./scripts/lib/debt-ledger.mjs` — a module specifier the consumer sync's
> command rewriter cannot relocate (it only rewrites `node scripts/<path>`), so
> the documented step could not run at all in a consumer repo, where the bundle
> lives under `scripts/.claude-skills/`. `debt-auto-capture.mjs` had already
> replaced it; the snippet just outlived it. Guarded by
> `tests/skill-command-portability.test.mjs`.

## Automatic protections

- `deferredRationale` must be ≥20 chars — schema-enforced, no rubber-stamp defers.
  The **upper** bound is 4000 chars, sized to this page's own producer: Step 3's
  honest-deferral check requires a defer to name the root cause, the rejected
  minimal in-scope fix, the residual risk and (out-of-scope) the independence
  argument. **Never shorten the rationale to fit a cap** — the cap was raised
  from 400 on 2026-09-04 precisely because it rejected the best-reasoned
  deferrals first (measured over 2,116 ledger rulings: max 1945 chars; 22.5% of
  HIGH defers over 400 against 4.3% of LOW), so debt memory kept the
  least-reasoned ones and the rejected findings were never suppressed in any
  future audit. A rejection at 4000 is a signal to check the text, not to trim it
- **Sensitivity scan** (path + content) runs at capture time; secrets in
  `detail` / `category` / `section` / `rationale` are auto-redacted to
  `[REDACTED:pattern-name]` and entry is marked `sensitive: true`
- **Per-reason required fields** enforced by schema — missing field → rejected
- **Idempotent upserts** — same topicId across runs updates existing entry,
  does not duplicate
- Event written to `.audit/local/debt-events.jsonl` (or Supabase when cloud active)

## Status card

```
═══════════════════════════════════════
  DEBT CAPTURE — Round 1
  Deferred: 7 entries (5 out-of-scope, 2 blocked-by)
  Sensitive (redacted): 1
  Total ledger: 23 entries
═══════════════════════════════════════
```

## Debt Resolution (Step 5.1)

After the verification audit runs, if `_debtMemory.debtReopened > 0` AND
those reopened debt topics have NO matching finding in the current round's
output, those entries are candidates for resolution (the underlying issue
appears fixed).

**Resolution requires positive evidence**: the entry's files must be in
`--changed` AND in the audit scope. Absence of a match from an
out-of-scope audit is NOT proof of resolution.

For each candidate, prompt the operator:

```
═══════════════════════════════════════
  DEBT RESOLVED? — abc12345
  Category: [SYSTEMIC] God Module / Excessive File Size
  Files: scripts/openai-audit.mjs
  Reopened this round but no matching finding raised.
  Resolve? [y/N]
═══════════════════════════════════════
```

If confirmed:

```bash
node scripts/debt-resolve.mjs abc12345 \
  --rationale "fixed in commit <hash> — <brief description>" \
  --run-id $SID
```

Exit codes: 0 = resolved, 1 = op error, 2 = entry not found / lock contention.

Removes the entry from `.audit/tech-debt.json` (and cloud mirror when
configured); logs a `resolved` event to the event source. Audit trail
stays in the event log.

## Periodic Debt Health (beyond per-audit capture)

Step 3.6 captures and Step 5.1 resolves debt **within a single audit run**,
scoped to whatever files that run happened to touch. Neither ever looks at
the ledger as a whole — a backlog entry whose file simply never comes back
into an audit's scope sits open forever with no prompt to revisit it. Two
standalone CLIs close that gap; run them periodically, not per-audit:

```bash
node scripts/debt-review.mjs --local-only   # free heuristic clustering — no API key needed
node scripts/debt-review.mjs                # richer LLM clustering (GPT) into ranked refactor candidates
node scripts/debt-review.mjs --write-plan-doc   # also writes docs/plans/refactor-<cluster>.md for the top candidate
node scripts/debt-budget-check.mjs          # opt-in per-path policy gate — reads the ledger's `budgets` field
```

`node scripts/debt-resolve.mjs <topicId> --rationale "..."` closes an entry
once you've independently confirmed it's fixed (not just "no longer
reopened this round" — see the resolution requirement above).

**This now runs automatically, opportunistically.** The `debt-health` local
maintenance check (`scripts/debt-health-check.mjs`, wired into
`scripts/maintenance-checks.mjs`) reports stale (>180d by default),
recurring (>=3 distinct audit runs), and over-budget entries with no LLM
call and no required env — see
[`docs/runbooks/local-maintenance-checks.md`](../../../docs/runbooks/local-maintenance-checks.md).
It's opt-in (`AUDIT_LOOP_WEEKLY_MAINTENANCE=1`) and never blocks a push;
`npm run debt:health` runs it on demand.

## Verifying capture actually happened

The capture command above is a manual step this SKILL.md *instructs* the
operator (you) to run — nothing mechanical enforces that it did. `debt-health`
above can't see the gap either: it only ever reads `.audit/tech-debt.json`
itself, so a `ruling: 'defer'` entry that was never captured leaves that file
looking exactly as healthy as one with nothing to capture. Two backstops:

- **Every `debt-auto-capture.mjs` run self-checks.** After a successful write,
  it re-scans every round ledger in the same `.audit/` directory and prints a
  `WARN:` line (non-fatal — this run already succeeded) naming any deferred
  entry from an *earlier* invocation that still has no matching entry in
  `.audit/tech-debt.json`.
- **`npm run debt:capture-trail`** (`scripts/debt-capture-trail-check.mjs`,
  wired into `maintenance-checks.mjs` as `debt-capture-trail`) is the
  standalone, deterministic version of the same cross-check — cross-checks
  every `ruling: 'defer'` entry across `.audit/*-ledger.json` against
  `.audit/tech-debt.json` by `topicId`, independent of whether debt-auto-
  capture ever ran again to trip the WARN above. Exit 1 (`attention`) when
  anything is uncaptured; **`0 uncaptured` against a non-zero deferred total
  is the pass — `N uncaptured` against a non-zero total is a failure to fix,
  never a pass**, same doctrine as Step 3.5b's `labelled: 0` case.
