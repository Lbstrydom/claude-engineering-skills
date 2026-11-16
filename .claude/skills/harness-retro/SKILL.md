---
name: harness-retro
description: |
  Post-session retro for the AI harness itself: mechanically scan recent Claude
  Code session transcripts for failures that RECUR across sessions (tool errors,
  denials, hook errors and blocks, refusals, retries, user corrections), check
  what the harness already has, then judge each ranked candidate and PROPOSE the
  lowest enforcing layer (hook/gate > script > reference doc > AGENTS.md) with
  the failure it prevents, the exact change and a positive-control test. Never
  applies a change: a human approves, the fix lands as its own PR. Also promotes
  memory tripwires that keep firing into enforcement, and measures recurrence
  before vs after a fix landed. Pick by INPUT: past SESSIONS to mine come here;
  a CODE change to review is /audit-code.
  Triggers on: "harness retro", "retro", "what keeps going wrong",
  "recurring failures", "promote this tripwire", "/harness-retro".
  Full command syntax: see the Usage section in this skill.
---

# /harness-retro — turn recurring failures into checks

## Usage

```
/harness-retro                 — scan this repo's sessions (14 days), judge, propose
/harness-retro --fleet         — report every repo on this account (no persistence)
/harness-retro effect          — did an enforced fix reduce its failure?
```

> **Worktree preflight** — in a linked git worktree the gitignored tooling tree
> `scripts/.claude-skills/` is absent (`git worktree add` does not populate it),
> so every command below that uses it dies on `MODULE_NOT_FOUND`. Run
> `npm run skills:hydrate` first; if no such script exists,
> `references/worktree-preflight.md` holds the entry to add (ask the user first:
> it edits `package.json`). Keys are not copied: put them in
> `~/.audit-loop.env`, which every worktree reads.

**Detect mechanically, judge with the model, enforce in the repo, measure with
the store.** The scanner is deterministic; you are the judgment step, and only
for the ranked candidates it hands you. **Propose, never apply.**

Transcripts are read from the account's config root and **never leave local
disk**. Only derived counts reach the store (`--persist`, cloud on).

## Step 1 — Scan

```bash
node scripts/harness-retro.mjs scan --since 14d
```

Read the report. **`UNMEASURED` is not a clean result** — say what it scanned
and why it could not conclude (no transcripts, read errors, unrecognised
format, no in-scope sessions), then stop. `MEASURED` with zero candidates is a
valid result: report how many sessions were scanned and that nothing recurred.

Add `--persist` at the end of a coordinator session so the effect metric has a
durable denominator. An unmigrated store exits non-zero naming the migration —
relay it; never retry around it.

## Step 2 — Judge each candidate (the only model step)

The latest scan artifact (`.audit/harness-retro/scan-<id>.json`) lists the
ranked `candidates` (each with `coveredBy` hints) and `tripwires` whose status
is `promotion-candidate`. For each, decide one `verdict`:

- `propose` — a recurring, mechanically decidable failure no existing surface
  enforces. Choose the LOWEST layer that can enforce it.
- `already-covered` — a hook, gate, skill or memory already handles it; name
  it in `coveredBy`. A `hook_block` that keeps firing IS enforcement working —
  propose only if its round trip is the cost (e.g. rewrite instead of block).
- `judgment-only` — real, but no check can decide it.
- `not-actionable` — noise, an upstream product behaviour, or a one-time event.

Open the named surface before you claim `already-covered`; `coveredBy` is a
lexical hint, not a verdict. Ladder, the coordinator-chore rule (a recurring
mechanical chore → `layer: script`, `coordinatorChore: true`) and a worked
example: `references/judging-candidates.md`.

## Step 3 — Record

Write the envelope to a file with the Write tool, then pipe it:

```bash
node scripts/harness-retro.mjs record --scan latest < .claude/tmp/retro-proposals.json
```

`record` refuses a proposal missing any of the three things, an `identity`
the scan did not rank, or evidence that does not match the scan's counts. The
shape it validates (keys are exact; `.strict()` refuses extras):

<!-- harness-retro:proposal-example -->
```json
{
  "scanId": "20261116T120000123Z-abcdef",
  "proposals": [
    {
      "identity": "fingerprint:0123456789abcdef",
      "verdict": "propose",
      "failurePrevented": { "summary": "hook commands fail when the session cwd is not the repo root", "sessions": 8, "occurrences": 51 },
      "layer": "gate",
      "change": { "files": [".claude/settings.json"], "description": "prefix every hook command with \"$CLAUDE_PROJECT_DIR\"" },
      "positiveControl": { "test": "tests/<new-check>.test.mjs", "assertion": "a hook command with a relative path fails the test" },
      "coordinatorChore": false
    },
    {
      "identity": "tripwire:feedback_example",
      "verdict": "already-covered",
      "reason": "the grep nudge hook already blocks this before it runs",
      "coveredBy": ".claude/hooks/bash-grep-nudge.mjs"
    }
  ]
}
```
<!-- /harness-retro:proposal-example -->

`layer: "agents-md"` additionally needs `ladderJustification` (why no lower
layer can enforce it). Present the rendered `proposals-<id>.md` to the human.

## Step 4 — After a human approves one

The fix is its **own** PR. In that branch, once its test exists (`TEST` = that test's repo-relative path):

```bash
node scripts/harness-retro.mjs enforce --identity fingerprint:0123456789abcdef --scan latest --test "$TEST" --layer gate --summary "hook commands resolve from the project dir"
```

**`enforce` refuses, writing nothing, an identity the scan did not rank.** It
also refuses a test `npm test` would not run and a summary carrying a path.
Otherwise it appends the decision to `.harness-retro/decisions.json` (committed with the
fix) and, for a `tripwire:` identity, retires the tripwire from `MEMORY.md`
(the file is kept). `reject --identity … --summary …` records a "no". Closure
rules, re-running an interrupted `enforce`, and reading `effect`:
`references/effect-and-closure.md`.

## Step 5 — Was it worth it?

```bash
node scripts/harness-retro.mjs effect
```

Recurrence before vs after each enforcement landed, over equal windows and a
stable population. `pending`, `pending-merge` and `unmeasured` carry reasons —
report them as such, never as "no effect".

`node scripts/harness-retro.mjs status` reports the heartbeat (stale after 8
days), registry problems and half-finished retirements.

## Reference files

| File | Summary | Read when |
|---|---|---|
| `references/judging-candidates.md` | Judging a retro candidate — the enforcement ladder, the three-things contract, coordinator chores, an example. | Step 2 — judging candidates, OR unsure which layer a fix belongs in. |
| `references/effect-and-closure.md` | Closing a decision and reading its effect — enforce/reject, tripwire retirement, activation, the verdicts. | Step 4 or 5 — recording an approved fix, OR an effect verdict needs explaining. |
| `references/worktree-preflight.md` | Worktree preflight remedy — the skills:hydrate npm script to add when a linked worktree lacks the tooling tree. | A command dies with `MODULE_NOT_FOUND` in a linked worktree AND this repo has no `skills:hydrate` script. |

— end of /harness-retro —
