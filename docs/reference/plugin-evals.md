# Plugin evals (pilot)

**What it is**: `.claude-plugin/plugin.json` at repo root plus `evals/` wrap
the existing `skills/` directory so the Claude Code CLI's `claude plugin eval`
can run realistic prompts against this repo's skills and assert, mechanically,
which skill fires. It runs each case with the plugin loaded (with-arm) and
without (without-arm) and reports the delta, isolating what the skill's
SKILL.md prose actually contributes rather than what Claude would have done
anyway.

**Why it exists**: `npm test` (14,000+ tests) exercises `scripts/lib/**` —
the code the skills call into — but nothing in this repo tests the prose
layer: whether a SKILL.md's `description`/`Triggers on:` frontmatter actually
steers Claude to the right skill for an ambiguous prompt. That's the same
"prose↔code seam" class of bug documented in AGENTS.md (a reader silently
matching 0/7 sessions on a field-name mismatch) — plugin evals give that seam
a mechanical check for the first time.

**Scope of the pilot**: three cases targeting the two pairs of skills whose
own descriptions call out an explicit discriminator (so a regression here is
a real trigger-boundary break, not noise):

| Case | Asserts |
|------|---------|
| `evals/explain-topic-question/` | a WHY/topic question invokes `explain`, not `investigate` |
| `evals/investigate-claim-question/` | a claim-verification question invokes `investigate`, not `explain` |
| `evals/plan-vs-audit-plan-design-request/` | a greenfield design request invokes `plan`, not `audit-plan` |

Each case has two `tool_used` graders: one asserting the intended skill fired
(`min: 1`), one asserting the wrong sibling didn't (`max: 0`). Both are
`arm: with-only` — the assertion can only ever be true when the plugin is
loaded, so scoring it against the without-arm baseline is meaningless.

## Running it

```bash
# Cheap smoke check — one run, no baseline arm
claude plugin eval . --tag pilot --runs 1 --ablation none

# Full pilot pass — 3 runs each way, cost-capped
claude plugin eval . --tag pilot --max-cost-usd 5

# A single case
claude plugin eval . --case explain-topic-question
```

Every run is a real, billed API call (the with-arm, the without-arm, and any
`llm`-type grader's judge model). Always pass `--max-cost-usd` outside of a
one-off smoke check.

## Why this doesn't touch the Copilot-native surface

`.claude/skills/**` (generated from `skills/**` by `npm run skills:regenerate`)
is the surface GitHub Copilot, Cursor, and Windsurf actually read — see
[skill-surface-ownership.md](skill-surface-ownership.md). `claude plugin eval`
is orthogonal to it:

- The eval sandbox loads skills **only** from the plugin under test
  (`skills/` at repo root, referenced by `.claude-plugin/plugin.json`'s
  default skill location). It never reads `.claude/skills/`.
- Running an eval is local and ephemeral — it doesn't install, register, or
  publish the plugin anywhere, so no new discovery root is created on disk.
- `.claude-plugin/plugin.json` is inert to every other tool unless something
  explicitly loads it as a plugin (`--plugin-dir`, `claude plugin eval`, or a
  marketplace entry) — it has no documented effect on VS Code, Copilot, or
  the `npm run sync` distribution path.

In short: this is a **Claude Code CLI-only test harness** sitting alongside
the skills, not a second distribution surface. Copilot users are unaffected
whether or not this pilot exists or expands.

## Extending the pilot

Adding a case: create `evals/<case-name>/prompt.md` (frontmatter + prompt
body) and `evals/<case-name>/graders/<name>.md` (one grader per assertion).
Prefer deterministic graders (`tool_used`, `regex`, `file_exists`) over
`llm`-judged rubrics where a mechanical check suffices — they're free and
don't add judge-model variance. Tag every new case so it can be filtered
independently of the full suite.

This pilot is deliberately narrow (three cases, two skill pairs). Before
widening it to more skills or to output-quality grading (not just
triggering), revisit whether the cost is earning its keep — the same
right-sizing question AGENTS.md asks of any new mechanical check.

## Two lessons from the first real run (measured 2026-09-19)

`claude plugin eval . --tag pilot --runs 1 --ablation none` (Claude Code
v2.1.278, single run each, `--ablation none`): $0.64 total, 0/3 cases scored
above threshold on the first attempt. Both failures were the eval's, not the
skills':

- **`min` defaults to 1 even when only `max` is set.** A `tool_used` grader
  meant to assert "this skill must NOT fire" needs `min: 0` set explicitly —
  omitting it leaves the impossible band `min:1, max:0`, which fails
  regardless of what Claude does. The report showed this literally:
  `expected 1..0`. `investigate-claim-question` had actually behaved
  correctly (called `investigate` once, `explain` zero times) but scored 50%
  because of this. Fixed by adding `min: 0` to every "does-not-invoke-*"
  grader.
- **The eval sandbox does not mount the repo, only the plugin's declared
  skill surface.** Prompts that named real internals (`sensitive-paths.mjs`,
  "the R2+ audit mode's post-output suppression layer") sent Claude looking
  for files that don't exist in the ephemeral workspace, burning through
  `max_turns` before it ever reached a skill decision, or arguably ever
  contributing that finding at all. Fixed by rewriting prompts to be
  self-contained: they keep the *shape* that should trigger the right skill
  (a WHY question, a claim to verify, a greenfield design ask) without
  naming anything that only exists in this repo. `max_turns` was also raised
  from 5 to 8 to give a genuine trigger decision room to happen before a
  timeout, independent of the file-access issue.

Net: a case scoring 0% on a `tool_used` grader is not evidence a skill
failed to trigger until you've ruled out an impossible grader range and a
prompt that sent the model chasing nonexistent files — check the report's
per-run turn count and error field before reading the score at face value.

## A third lesson: self-contained isn't the same as abstract (measured 2026-09-19)

Second run, prompts rewritten per the lesson above: `investigate` and `plan`
both went to 1.00 clean (confirming their earlier 0% *was* the sandbox
confound, not a real trigger gap). `explain` stayed at 0.50.

The difference: the working `plan` prompt kept a concrete action framing
("I want to **add** a feature... how should I **structure** this") that
echoes the skill's own trigger language. The `explain` rewrite over-corrected
into a fully abstract, hypothetical design question with no reference to
*existing* code at all ("why would a shared library expose one canonical
validation function..."). `/explain`'s whole premise is explaining why code
that already exists is the way it is; a pure hypothetical with nothing
concrete to point at gives Claude no reason to reach for a skill built
around git history and architectural memory; it just answers the design
question directly.

The fix is neither the original (a literal file path that doesn't exist in
the sandbox) nor the first rewrite (no existing-code referent at all): keep
an "existing code" frame — `"this codebase routes X through Y"` — without
naming a real file. Self-contained and concrete are separate axes; a prompt
needs to clear the sandbox-access bar *and* still look like the shape of
question the target skill actually answers.
