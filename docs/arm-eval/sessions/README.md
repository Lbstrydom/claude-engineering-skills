# Arm-eval session archive

One markdown file per arm-eval session — the committed, third-party-auditable
record of the experiment ("can an OSS combination beat the proprietary
baseline?"). Design + method: [`docs/arm-eval.md`](../../arm-eval.md);
framework plan: [`docs/completed/arm-eval-framework.md`](../../completed/arm-eval-framework.md).

**The database remains canonical** (sessions / runs / outputs / judgments /
human rankings, in the shared audit store). These files are an append-style
export for readers WITHOUT database access — written once when a session runs
(auto-capture on the `arm-eval-run` / `arm-eval-maybe-capture` path) and
upgraded exactly once more when the blinded human ranking lands. They are not
regenerable build artifacts; treat them like experiment lab notes.
Regenerate/backfill: `node scripts/cross-skill.mjs arm-eval-export --all`.

## Filename

`<UTC yyyymmdd-hhmmssZ>__<experiment>__<phase>__<task-id>__<session-id-8>.md`

Sorts chronologically; the task-id is the normalized content hash of the
prompt (the diversity unit); the full prompt is inside the file.

## Blinding rule (why some files hide the arm identity)

The human spot-check is the experiment's ground-truth anchor, so a
**prospective session that has not been human-ranked yet exports BLINDED**:
outputs appear only under their opaque `output-N` presentation labels — arm
identity, per-arm models, and judge scores are withheld (any of them would let
the ranker infer attribution). After
`arm-eval-adjudicate --session-id <id> --ranked …` records the ranking, the
file is rewritten with full attribution, judge scores, and the ranking.
Calibration-phase sessions are never part of the anchor pool and export full
immediately.

## Reading a full file

- **Arms + outputs** — each arm's verbatim output (shape-redacted), the
  concrete models resolved at run time, and the output hash.
- **Judge scores** — Claude-as-judge rubric scores (1–5 per dimension), two
  independent passes (self-consistency), presentation label ↔ arm mapping.
  The judge saw only the blinded labels at judge time.
- **Human ranking** — the blinded best→worst ranking (by label), reviewer,
  timestamp. Kendall τ between this and the judge ranking is the anchor
  statistic (`arm-eval-decision`).
