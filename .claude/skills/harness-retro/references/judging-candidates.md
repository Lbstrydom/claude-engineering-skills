---
summary: Judging a retro candidate — the enforcement ladder, the three-things contract, coordinator chores, an example.
---

# Judging retro candidates

You see only what the scanner ranked: fingerprints that recurred in two or more
sessions (one-offs are counted, never ranked) and memory tripwires that fired in
two or more. Each carries a normalised, redacted `label` — the first informative
line of the failure — plus `kind`, `tool`, counts and `coveredBy` hints.

## The ladder — choose the LOWEST layer that can enforce it

| Rank | Layer | Use when | Why it ranks here |
|---|---|---|---|
| 1 | `hook` / `gate` | the action passes through a hook or the pre-push `check` | fail-closed, runs without anyone remembering |
| 2 | `script` | a recurring chore a person or agent does by hand | the decision becomes code; the model only judges |
| 3 | `reference-doc` | guidance needed only in one skill's situation | loaded on demand, costs nothing elsewhere |
| 4 | `agents-md` | none of the above can see the mistake | loaded every session and size-capped — the last resort |

**Enforce before you instruct**: a line of prose an agent must remember is the
weakest fix. **Load only when needed**: prefer a skill reference over AGENTS.md.
`agents-md` requires `ladderJustification` naming why ranks 1–3 cannot work.

## The three things every `propose` names

1. **`failurePrevented`** — the failure in one sentence, with the scan's own
   `sessions` and `occurrences` (copied from the scan; `record` refuses others).
2. **`change`** — the exact files and what changes in them.
3. **`positiveControl`** — the test that proves the new enforcement FIRES on the
   failing input (and, implicitly, passes otherwise). The test must name the
   identity in a string literal; the registry check enforces that at commit time.

## Verdicts

- `already-covered` — open the surface first. A `hook_block` recurring is a
  hook doing its job; only propose when the round trip it costs is the problem
  (e.g. a nudge that could rewrite the call instead of refusing it).
- `judgment-only` — a real problem no mechanical check can decide (taste,
  scope, design). Say so; it may belong in a skill reference.
- `not-actionable` — product behaviour outside this repo, environment noise, a
  one-time incident.

## Coordinator chores

If the label is a coordinator doing the same mechanical sequence by hand (merge
on green at the audited head, archive + worktree removal, refusing to
fast-forward `main` while a store is behind), the fix is a **script**:
`layer: "script"`, `coordinatorChore: true`. The retro flags it; building it is
its own approved PR.

## Worked example

Candidate: `hook_error`, tool `UserPromptSubmit`, label `bash: .claude/hooks/arch-memory-check.sh: No such file or directory`,
8 sessions, `coveredBy` empty.

- Recurs: yes. Mechanically decidable: yes — every hook command in
  `.claude/settings.json` either starts with `"$CLAUDE_PROJECT_DIR"` or it does not.
- Layer: `gate` (a test over the settings file fails on a relative hook path).
- `failurePrevented`: hook commands fail whenever the session cwd is not the
  repo root (8 sessions, 51 occurrences — from the scan).
- `change`: `.claude/settings.json` hook commands prefixed with `"$CLAUDE_PROJECT_DIR"`.
- `positiveControl`: `tests/hook-command-paths.test.mjs` — a relative hook
  command fails the test; the current file passes.

## What you must not do

- Edit the harness. Propose; the human approves; the fix is its own PR.
- Inflate evidence or invent an identity — `record` checks both against the scan.
- Read the raw transcripts to "add context" to a proposal and paste their text
  anywhere: the label is the only transcript-derived text that may travel.
