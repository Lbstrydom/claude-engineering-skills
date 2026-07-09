# Field Records — Two Years of Production Audits, Mined

**Date**: 2026-07-09. **Method**: two parallel reading passes over the
historical audit records — 21 `*-audit-summary.md` files in this repo's
`docs/completed/` (2026-04 → 2026-05) plus the cloud-ledger decomposition, and
~17 records read in full from a private commercial app's `docs/completed/`
(~60 present, 2026-03 → 2026-06). These are records of the GPT-5.5 + Gemini
pipeline reviewing **Claude-authored code in real production use** — the
complement to experiment 1's controlled comparison.

## Headline aggregates

- **Cloud ledger (this repo)**: 13,963 findings raised, **375 accepted (2.7%)**.
  Severity-weighted accepted value 1,614.
- **Round-value split**: round 1 = 48.1% of accepted value; rounds 2+ = 51.9% —
  by acceptance labels, R2+ is NOT dead weight.
- **Gemini as a net-new finder**: 6/142 accepted (**4.2%**) — weak as a finder.
- **Dollar costs are trivial** ($0.18–0.72/audit round; worst 6-round churn
  ≈ $2.40). **The real cost is triage/rebuttal labor** on 30–48-finding
  round-1 batches.
- Commercial-app pattern: of a typical R1 batch, genuine fix-now items ≈
  10–25%; 50–70% is pre-existing/out-of-scope debt surfaced by diff
  over-capture; 10–20% outright false.

## What the pipeline genuinely caught (would-have-shipped bugs)

*GPT rounds*: SQL-injection surface in query-builder identifier handling;
silently-dropped `undefined` WHERE values (an UPDATE mutating wrong rows);
path-traversal/symlink egress gaps; redact-after-truncate secret splitting; a
tautological migration test (`files.sort()` vs `[...files].sort()` — green
while asserting nothing); an advisory-lock race on duplicate-wine creation; an
IPv6 hex-mapped-loopback SSRF bypass (`::ffff:7f00:1`) in fresh security code;
resume-path replay undercounting; cache `PLAN_VERSION` not bumped on shape
change; fail-open on a destructive merge operation.

*Gemini's real catches were mostly GPT-missed HIGHs or bugs in fix rounds*: a
spread-order bug inside Claude's fix for a GPT finding; a screen-reader
announcer silenced by an inert sweep (missed by four GPT rounds); a
never-resolving lazy-materialisation placeholder; one-transaction backfill
requirements; and — its single most valuable class — **reversing a wrong
dismissal**: a real silent-ledger-data-loss bug that GPT had raised, Claude had
wrongly dismissed, and only the independent gate resurrected.

## The false-positive taxonomy (what the 97% actually is)

1. **Phantom missing files** — the #1 recurring class in BOTH repos (6+ audits
   here, 8+ there): the structure pass flags files as "missing" that exist,
   were just created, or were deliberately deleted. Mechanically checkable.
   Cheap per instance; expensive in aggregate (it re-taxed four consecutive
   milestones, and the R2+ suppression subsystem exists largely to manage it).
2. **Pre-existing/out-of-scope scope bleed** — the bulk by volume. Auditors
   can't tell "new" from "pre-existing"; triage by diff-membership/blame is the
   documented fix. Mechanically checkable.
3. **Confident misreads / fabrications (the expensive tail)** — Gemini's
   signature failure mode (8+ documented instances here): claims about code or
   transcripts that don't exist, including one **REJECT verdict built on a
   fabricated quote** that required forensic grep of round-1 stderr to disprove,
   and suggestions that would have *introduced* bugs if obeyed (`|| → ??` on a
   NaN-sensitive path). GPT's signature mode is the phantom-file/scope class.
   Both families repeatedly raised the identical `db.prepare()` idiom FP for
   months despite documentation — **family diversity did not diversify that
   error**.
4. **Rigor pressure in late rounds** — findings decay from design bugs to
   gold-plating; every long record shows it (one 6-round plan audit never
   converged and shipped on operator override).

## Structural findings (what actually earns the money)

- **Round 2's distinct value is catching regressions introduced by round 1's own
  fixes** — recurs across both repos ("the rate of NEW issues is now ≤ the rate
  of my-edits-introducing-bugs"). The loop partly audits itself, and that is
  real value.
- **Gemini's proven role is adjudication oversight, not discovery** — 4.2%
  acceptance as a finder, but repeatedly decisive as a check on dismissals and
  fix-quality. (Operators' emergent behavior already matched this: skipping the
  gate on over-captured rounds, capping it at 2 rounds, overriding FP-only
  REJECTs.)
- **Named Claude-author blind-spot classes** (recurring, caught pre-ship by
  non-Claude reviewers — the concrete case for cross-family review):
  1. cache/version-invalidation omissions (shape changes without version bumps)
  2. transaction/locking gaps (dupe-check races, missing `FOR UPDATE`, non-atomic backfills)
  3. valid-zero `||` drops (`price_eur || null` destroying legitimate 0s)
  4. fail-open defaults on destructive paths
  5. replay/resume accounting errors
  Plus a sixth cross-cutting one: fix-round wiring/ordering slips.
- **The hardest counter-evidence**: the worst shipped bug in either corpus (a
  "102% correctly placed" UI stat with a suppressed CTA) passed BOTH foreign
  model families — every reviewer of the same diff inherits the author's
  framing. Only a live persona test broke the shared assumption. Cross-family
  review diversifies *reasoning style*, not *evidence*. Several HIGH mechanical
  bugs (a TDZ crash in the audit script itself, silent jsonb corruption, a
  gate that exited green having checked nothing) also shipped straight past the
  multi-family apparatus.

## Net assessment

The false-positive burden is mostly cheap-to-dismiss noise with a genuinely
expensive fabrication tail; the multi-round structure earns its keep through
round-2 fix-verification and Gemini-as-adjudicator, NOT through more discovery
rounds or Gemini-as-finder; and the cross-family hypothesis is supported
specifically for **omission-class catches**, while being refuted as a general
independence guarantee (shared framing, shared idiom-FPs). Every one of these
conclusions maps to a specific structural element of the redesign plan:
mechanical Stage-0 triage (classes 1–2 above), Gemini repositioned as
adjudicator with a wrong-dismissal audit, the named blind-spot classes as
positive obligations, and live verification kept as the layer nothing static
replaces.
