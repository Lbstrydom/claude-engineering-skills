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

Write them with the bundled CLI — it derives every identity field from the
round's own findings, so you supply only the judgement:

```bash
node scripts/write-ledger-entries.mjs \
  --result .audit/$SID-r1-result.json \
  --ledger .audit/$SID-ledger.json \
  --triage .claude/tmp/triage-r1.json
```

`--triage` is a JSON file keyed by the round's finding ids. **Write it with an
editor (the `Write` tool), never as a shell string.** The payload is
`rulingRationale`: free-form English containing apostrophes ("the plan's
constraint", "718ca90's fix"), which are landmines inside a shell string — the
command dies with `unexpected EOF while looking for matching '`, and the
workaround people reach for is stripping apostrophes out of their own rationale,
corrupting the audit record to satisfy a quoting rule (observed live
2026-07-17). A file has no shell in the loop, so prose stays prose. Same reason
the adjudication queues are `--worksheet`-first rather than raw JSON.

```json
{
  "H1": { "outcome": "accepted",  "state": "planned", "ruling": "sustain",
          "why": "valid — the plan's fix is scheduled" },
  "M3": { "outcome": "dismissed", "state": "pending", "ruling": "overrule",
          "why": "300-line file, 2 consumers, acceptable" }
}
```

`outcome` ∈ `accepted|dismissed|severity_adjusted`, `state` ∈
`pending|planned|fixed|verified|regressed`, `ruling` ∈
`sustain|overrule|compromise|defer`; all four fields are required and an
unknown finding id is refused (a typo'd id would otherwise leave a finding
silently un-adjudicated). Findings you don't rule on stay `pending` and are
reported on stderr — that is the silent half of a `0/N labelled` outcome
report.

Add `--pass <name>` only for a CODE audit whose findings somehow lack `_pass`;
the default is `plan`, and a real finding's own `_pass` always wins.

> **Why a CLI and not a hand-written script.** The previous recipe wrote a
> `.mjs` file importing `../../scripts/shared.mjs`. That import is invisible to
> the consumer sync's command rewriter — which only relocates `node
> scripts/<path>` — so in a consumer repo, where the bundle lives under
> `scripts/.claude-skills/`, the snippet could not run at all. Same class a
> consumer reported 2026-08-08 for /plan's Gate-1 self-check. The CLI form is
> rewritten correctly for both layouts.

> **Session artifacts live in `.audit/`, never `/tmp/` (2026-07-26 incident).**
> A `` `/tmp/${SID}-r1-result.json` `` reconstructed inside a script is resolved
> by NODE's own path logic, which on Windows disagrees with what BASH resolved
> when the same literal was passed to the audit CLI (confirmed live: Bash's
> `/tmp` lands in `AppData/Local/Temp`; Node's resolution of the identical
> string lands in `C:\tmp` — two different, unrelated directories). The script
> then throws on a file that genuinely exists. That cost a consumer repo 30 days
> of silently-lost final-review persistence (101 real runs, traced 2026-07-26).
> A repo-relative `.audit/…` path has no such split: every reader resolves it
> against the same cwd, and it is gitignored + swept by `npm run audit:clean` in
> this repo and in every consumer.

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
node scripts/write-ledger-entries.mjs \
  --ledger .audit/$SID-ledger.json \
  --mark-fixed 42fe8eb796e8 6373587e8fe1
```

topicIds are ARGUMENTS, and there is no `<angle-bracket>` placeholder anywhere:
PowerShell reserves `<`, so a bracketed command cannot be pasted — this repo's
operator-doc convention forbids them for that reason. A topicId not present in
the ledger is refused, not quietly skipped.

> **This replaced a recipe that silently did nothing (found 2026-08-08).** The
> old snippet wrote a bare `{topicId, remediationState: 'fixed'}` entry, but
> `writeLedgerEntry` REPLACES the entry at a topicId — it does not merge — and
> validates the whole `LedgerEntrySchema`, so a partial entry failed validation
> and returned without writing. Exit 0, one stderr line, no `fixed` state
> anywhere: reopen detection and remediation labelling both ran on a ledger
> where nothing had ever been marked. The CLI does the read-modify-write.

## What the ledger enables

1. **Rulings injection** — R2+ prompts include the prior dismissals as
   "do not raise these again" instructions.
2. **Post-output suppression** — fuzzy match new findings against ledger
   topics; suppress re-raises of dismissed items.
3. **Reopen detection** — when fixed code regresses, R2+ detects it via
   the `remediationState: 'fixed'` entries that match new raises.
4. **Debt capture** — out-of-scope deferrals in Step 3.6 reference ledger
   entries for cross-linkage.
