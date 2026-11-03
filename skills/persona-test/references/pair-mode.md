---
summary: Pair mode detail — why opposed personas, the Step P5 PAIR DIFF fence, overlap interpretation, Step P7 responses.
---

# Pair mode (`--pair`) — detail

The resident Phase 7 steps (parse, run A then B with a fresh cache-bust each,
the overlap rule, the worse-of OVERALL, the `link-persona-pair` command) are
in SKILL.md. This file holds the report fence and the background.

## Why pair mode exists

**Why pair mode exists**: two personas of opposed expertise surface disjoint
findings — in the wine-cellar-app session that motivated this feature,
Elena (sommelier) and Martha (newer drinker) overlapped on exactly 1 of
~12 findings. Solo runs miss half the issues an opposed-expertise pair
catches. Pair mode formalises that.

## Step P5 — the pair report fence

After both solo reports (printed in full so the reader sees per-persona
context), append:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  PAIR DIFF — <persona_a> ∥ <persona_b>
  URL: <url>
  Focus: <focus or "exploratory">
  A device: <preset_a> <WxH>   B device: <preset_b> <WxH>
  A verdict: <verdict_a>   B verdict: <verdict_b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CONSENSUS (<n>) — both personas saw these
────────────────────────────────────────────────────
  [P<n>] <title>
     A's framing: <observed_a — first 80 chars>
     B's framing: <observed_b — first 80 chars>
     Fix: <merged fix or A's if identical>

A-ONLY (<n>) — caught by <persona_a>'s expertise
────────────────────────────────────────────────────
  [P<n>] <title> — <observed_a — first 100 chars>
  ...

B-ONLY (<n>) — caught by <persona_b>'s expertise
────────────────────────────────────────────────────
  [P<n>] <title> — <observed_b — first 100 chars>
  ...

COVERAGE METRIC
────────────────────────────────────────────────────
  Overlap rate: <consensus / (consensus + a_only + b_only)>
  Interpretation:
    < 0.20  — Strong disjoint coverage. Both personas were the right call.
    0.20–0.50 — Healthy mix of consensus + coverage.
    > 0.50 — High overlap. Consider picking more dissimilar personas next time.

OVERALL: <Ready for users | Needs work | Blocked>
  Reason: <one sentence — the WORSE of verdict_a and verdict_b>
```

## Step P6 — why no pair debrief

Each solo run already produced a Phase 5b debrief. Don't generate a third
"pair debrief" — the two debriefs side-by-side are the artefact. Pair mode
is about finding-level diff, not narrative synthesis.

## Step P7 — responses and refusals

`overlapRate` is optional — the CLI derives it from the three counts and
REFUSES a supplied value that disagrees with them, so send the counts you
printed in Step P5. Response `{"ok": true, "cloud": true, "pairId": "<uuid>",
"overlapRate": <n>}`. A refusal exits 1 with a code naming it:
`PARENT_NOT_FOUND` (a session id matches no row) or `PARENT_NOT_OWNED` (the
sessions belong to different repos, or not to this one). With the cloud store
off it returns `{"ok": true, "cloud": false, "pairId": null}` — say in the
report that the pairing was not persisted rather than implying it was.
