---
summary: Why the synthesis keeps a one-voice-only row (dated A/B), and how the automatic arm-eval capture behaves.
---

# Synthesis template evidence and arm-eval capture

## Why the one-voice-only row

The *one voice only* row is there because a lone view is what a synthesis
drops first: in a 2026-09-28 A/B, the template without it silently lost 3 of
Gemini's 5 unique points in one round.

## Step 4.5 — Arm-eval capture (AUTOMATIC — no action)

Capture is now fired by the round helper itself: after `brainstorm-round.mjs`
appends the round-1 session it dispatches a detached, toggle-gated arm-eval
capture (`scripts/lib/arm-eval/capture-trigger.mjs`). You do NOT run any
`arm-eval-maybe-capture` command — doing so would double-capture. When the
per-repo `arm-eval-toggle` is off it is a byte-identical no-op; when on, one
blinded D/E/F session records for the same topic in the background, unaffecting
YOUR brainstorm flow. If the helper printed `arm-eval capture dispatched`, you
may mention it in one line; otherwise say nothing.
