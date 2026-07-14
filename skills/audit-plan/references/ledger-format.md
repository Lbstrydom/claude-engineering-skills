---
summary: Adjudication ledger schema + writer invocation example for each finding outcome.
---

# Adjudication Ledger — Writing Entries

After each deliberation round, write ledger entries for every finding
before proceeding to Step 4 (Fix). The ledger is the source of truth for
R2+ rulings injection and post-output suppression.

## Status fields

Two orthogonal axes track a finding's lifecycle:

| Axis | Values | Meaning |
|---|---|---|
| **adjudicationOutcome** | `dismissed` / `accepted` / `severity_adjusted` | How was the finding judged during deliberation |
| **remediationState** | `pending` / `planned` / `fixed` / `verified` / `regressed` | What's the implementation status |

Typical flows:
- Dismissed finding: `dismissed` + `pending` (never progresses)
- Fixed HIGH finding: `accepted` + `fixed` → `verified` after R2+ confirms
- Severity-adjusted: `severity_adjusted` + flows same as accepted at new severity

## Writer invocation

> **Load-bearing identity invariant (2026-07-14 incident — do NOT hand-construct
> finding stand-ins).** Every downstream matcher keys on the finding's OWN
> identity fields: R2+ suppression narrows candidates by `entry.pass ===
> finding._pass` (the AUDIT PASS name, e.g. `Structure`/`Wiring` — never
> `'code'`/`'plan'`) plus `affectedFiles` overlap, then Jaccard-scores
> `category + section + detail`; `finalize-outcomes`/`write-code-outcomes`
> join by `entry.topicId === generateTopicId(finding)` (which folds in
> `_hash`) **or** `entry.latestFindingId === finding.id`. An entry written
> with curated/invented values for any of these fields is INVISIBLE to all
> of them — suppression silently never engages and outcome labeling reports
> `0/N labelled · needs_triage`. Derive every entry FROM the result JSON's
> actual finding object.

Iterate the round's `--out` result findings and write entries from them:

```bash
node --input-type=module -e "
import { writeLedgerEntry, generateTopicId, populateFindingMetadata } from './scripts/shared.mjs';
import fs from 'node:fs';
const r = JSON.parse(fs.readFileSync('/tmp/\$SID-r1-result.json','utf8'));
// Your triage decisions, keyed by the round's finding ids:
const triage = {
  H1: { outcome: 'accepted',  state: 'planned', ruling: 'sustain',  why: 'valid — fix scheduled' },
  M3: { outcome: 'dismissed', state: 'pending', ruling: 'overrule', why: '300-line file, 2 consumers, acceptable' },
};
for (const f of r.findings) {
  const t = triage[f.id]; if (!t) continue;
  populateFindingMetadata(f, f._pass);          // idempotent; ensures _hash/_primaryFile
  writeLedgerEntry('/tmp/\$SID-ledger.json', {
    topicId: generateTopicId(f),                // from the REAL finding — never a stand-in
    latestFindingId: f.id,                      // second join key for outcome labeling
    semanticHash: f._hash,
    adjudicationOutcome: t.outcome,
    remediationState: t.state,
    severity: f.severity, originalSeverity: f.severity,
    category: f.category,                       // verbatim from the finding
    section: f.section,                         // verbatim
    detailSnapshot: (f.detail || '').slice(0, 400),  // the finding's text, not your summary
    affectedFiles: f.affectedFiles,             // verbatim — drives suppression file-scope
    affectedPrinciples: f.principle ? [f.principle] : [],
    ruling: t.ruling,
    rulingRationale: t.why,                     // rationale is YOURS; identity is the finding's
    resolvedRound: r.round || 1,
    pass: f._pass,                              // the audit pass name, verbatim
  });
}
" 
```

The split to remember: **identity fields come from the finding verbatim;
only `adjudicationOutcome`/`remediationState`/`ruling`/`rulingRationale`
are yours.**

## Ledger ordering rule

**Write the ledger BEFORE proceeding to Step 4.** If Step 4's fixes
happen first, the ledger captures pre-fix state and R2+ rulings injection
uses stale data. The ledger is the R2+ contract — treat it as the source
of truth.

After Step 4 completes, update ledger entries for the fixed items:

```bash
node -e "
import { writeLedgerEntry } from './scripts/shared.mjs';
writeLedgerEntry('/tmp/\$SID-ledger.json', {
  topicId: '<existing topicId>',
  remediationState: 'fixed',
  // other fields unchanged — writeLedgerEntry merges on topicId
});
" --input-type=module
```

## What the ledger enables

1. **Rulings injection** — R2+ prompts include the prior dismissals as
   "do not raise these again" instructions.
2. **Post-output suppression** — fuzzy match new findings against ledger
   topics; suppress re-raises of dismissed items.
3. **Reopen detection** — when fixed code regresses, R2+ detects it via
   the `remediationState: 'fixed'` entries that match new raises.
4. **Debt capture** — out-of-scope deferrals in Step 3.6 reference ledger
   entries for cross-linkage.
