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

For each deferral candidate, write one entry:

```bash
node -e "
import { writeDebtEntries } from './scripts/lib/debt-ledger.mjs';
import { buildDebtEntry } from './scripts/lib/debt-capture.mjs';

const finding = { /* enriched finding with _hash, _primaryFile, _pass, affectedFiles, classification */ };
const { entry, sensitivity, redactions } = buildDebtEntry(finding, {
  deferredReason: 'out-of-scope',
  deferredRationale: 'pre-existing god-module concern, not in this phase scope — tracked for refactor pass',
  deferredRun: '\$SID',
});

const result = await writeDebtEntries([entry]);
console.log(JSON.stringify({
  inserted: result.inserted,
  updated: result.updated,
  rejected: result.rejected.length,
  sensitive: sensitivity.sensitive,
  redactions: redactions.length,
}));
" --input-type=module
```

## Automatic protections

- `deferredRationale` must be ≥20 chars — schema-enforced, no rubber-stamp defers
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
