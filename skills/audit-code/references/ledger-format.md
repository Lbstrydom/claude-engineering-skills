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

Iterate the round's `--out` result findings and write entries from them.

> **Write this to a FILE and run it — never inline as `node -e "…"`.** The
> payload is `rulingRationale`: free-form English, which contains apostrophes
> ("the plan's constraint", "718ca90's fix"). Embedded in a shell string those
> are landmines — the command dies with `unexpected EOF while looking for
> matching '`, and the workaround people reach for is stripping the apostrophes
> out of their own rationale, corrupting the audit record to satisfy a quoting
> rule. Observed live 2026-07-17. A file has no shell in the loop, so prose stays
> prose. (Same reason the adjudication queues are `--worksheet`-first rather than
> raw JSON.) **Import paths in a file resolve against the FILE, not cwd** — hence
> `../../scripts/shared.mjs` below; `node -e` resolved `./scripts/…` and copying
> that verbatim into a file silently breaks every import.
>
> **Pass the result/ledger PATHS as arguments — never rebuild them from a bare
> SID inside the script (2026-07-26 incident).** `` `/tmp/${SID}-r1-result.json` ``
> reconstructed inside the `.mjs` file is resolved by NODE's own path logic,
> which on Windows disagrees with what BASH resolved when `--out /tmp/$SID-r1-
> result.json` was originally passed to the audit CLI (confirmed live: Bash's
> `/tmp` lands in `AppData/Local/Temp`; Node's own resolution of the identical
> string lands in `C:\tmp` — two different, unrelated directories). The script
> then throws on a file that genuinely exists. This exact class — reconstructing
> an ambiguous `/tmp/...` path instead of threading through the one BASH already
> resolved — cost a consumer repo 30 days of silently-lost final-review
> persistence (101 real runs, traced 2026-07-26); fixed there by passing paths
> as `process.argv[N]`, never rebuilding them.

```bash
# 1. Write the triage script. The quoted 'EOF' means the shell expands nothing.
cat > .claude/tmp/ledger-r1.mjs <<'EOF'
import { writeLedgerEntry, generateTopicId, populateFindingMetadata } from '../../scripts/shared.mjs';
import fs from 'node:fs';
const [resultPath, ledgerPath] = process.argv.slice(2);
const r = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
// Your triage decisions, keyed by the round's finding ids. Apostrophes are safe
// here — this is a file, not a shell string.
const triage = {
  H1: { outcome: 'accepted',  state: 'planned', ruling: 'sustain',  why: "valid — the plan's fix is scheduled" },
  M3: { outcome: 'dismissed', state: 'pending', ruling: 'overrule', why: '300-line file, 2 consumers, acceptable' },
};
for (const f of r.findings) {
  const t = triage[f.id]; if (!t) continue;
  // `f._pass || 'plan'` — NOT a bare `f._pass`. A CODE audit's findings carry
  // `_pass` ('Structure', 'Wiring', …); a PLAN audit's findings DO NOT have the
  // field at all (verified against a real plan-audit result JSON). Passing the
  // bare value there produces a topicId that joins to nothing, so the entry is
  // INVISIBLE to suppression and outcome labeling — precisely the failure the
  // warning block above describes. Reproduced: the two forms yield different
  // topicIds for the same finding. This mirrors the auto-writers, which already
  // get it right: openai-audit.mjs:925/943 + plan-audit-cloud.mjs:96 pass the
  // literal 'plan'; legacy-production-audit.mjs:2369 passes `f._pass`.
  populateFindingMetadata(f, f._pass || 'plan');  // idempotent; ensures _hash/_primaryFile
  writeLedgerEntry(ledgerPath, {
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
    pass: f._pass || 'plan',                    // MUST match the populateFindingMetadata arg above
  });
}
console.log('ledger entries written');
EOF

# 2. Run it — paths are ARGUMENTS resolved by THIS shell, never rebuilt inside
# the script from a bare SID (that would let Node re-resolve /tmp/ itself and
# disagree with what this line just resolved — the 2026-07-26 incident above).
node .claude/tmp/ledger-r1.mjs "/tmp/$SID-r1-result.json" "/tmp/$SID-ledger.json"
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
# A file again, and topicIds as ARGUMENTS: an `<angle-bracket>` placeholder
# cannot be pasted into PowerShell, which reserves `<` — this repo's operator-doc
# convention forbids them for that reason.
cat > .claude/tmp/ledger-fixed.mjs <<'EOF'
import { writeLedgerEntry } from '../../scripts/shared.mjs';
const [SID, ...topicIds] = process.argv.slice(2);
for (const topicId of topicIds) {
  writeLedgerEntry(`/tmp/${SID}-ledger.json`, {
    topicId,
    remediationState: 'fixed',
    // other fields unchanged — writeLedgerEntry merges on topicId
  });
}
console.log(`marked ${topicIds.length} entr(ies) fixed`);
EOF

node .claude/tmp/ledger-fixed.mjs "$SID" 42fe8eb796e8 6373587e8fe1
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
