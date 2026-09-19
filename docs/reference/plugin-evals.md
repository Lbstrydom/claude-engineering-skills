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

**Scope of the pilot**: expanded 2026-09-19 from 3 cases (one pair) to 12
cases covering every one of this repo's 13 model-invokable skills (the other
3 — `security-strategy`, `ship`, `skills` — carry `disable-model-invocation:
true` and can only be reached by explicit slash command, so there is no
triggering ambiguity to test):

| Case | Asserts |
|------|---------|
| `evals/explain-topic-question/` | a WHY/topic question invokes `explain`, not `investigate` |
| `evals/investigate-claim-question/` | a claim-verification question invokes `investigate`, not `explain` |
| `evals/plan-vs-audit-plan-design-request/` | a greenfield design request invokes `plan`, not `audit-plan` |
| `evals/audit-code-request/` | a "review my code before a PR" request invokes `audit-code`, not `audit-plan` |
| `evals/audit-plan-request/` | a "review this plan doc" request invokes `audit-plan`, not `audit-code` |
| `evals/ux-lock-verify-vs-audit-code/` | "was the plan actually built" (live app) invokes `ux-lock`, not `audit-code` |
| `evals/visual-audit-vs-persona-test/` | a styling/theme-consistency check invokes `visual-audit`, not `persona-test` |
| `evals/click-test-vs-persona-test/` | a structural DOM/accessibility walk invokes `click-test`, not `persona-test` |
| `evals/nav-audit-vs-persona-test/` | a "does the menu offer what's needed" question invokes `nav-audit`, not `persona-test` |
| `evals/brainstorm-vs-plan/` | wanting another LLM's independent take invokes `brainstorm`, not `plan` |
| `evals/cycle-full-flow-request/` | an explicit end-to-end request invokes the `cycle` orchestrator, not a single step directly |
| `evals/ai-context-management-drift-check/` | an AGENTS.md/CLAUDE.md drift question invokes `ai-context-management`, not `explain` |

Each case has one or two `tool_used` graders: one asserting the intended
skill fired (`min: 1`), and — where a sibling call doesn't legitimately
happen as part of correct behavior — one asserting the wrong sibling didn't
(`max: 0`). `cycle-full-flow-request` deliberately has only the positive
grader: `cycle`'s own documented flow calls `/plan` as its real first step,
so asserting "does not invoke plan" would fail on *correct* orchestration —
caught before running it, not after. All graders are `arm: with-only` — the
assertion can only ever be true when the plugin is loaded, so scoring it
against the without-arm baseline is meaningless (see below).

## Running it

```bash
# Cheap smoke check — one run, no baseline arm
claude plugin eval . --tag pilot --runs 1 --ablation none

# Full pilot pass — 3 runs, cost-capped. Always pass --ablation none for
# this pilot: every grader here is with-only (see above), so the default
# ablation's without-arm score is a structural constant, not a
# measurement -- see "The ablation Δ is confirmed meaningless" below.
claude plugin eval . --tag pilot --max-cost-usd 5 --ablation none

# A single case
claude plugin eval . --case explain-topic-question --ablation none
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

**Correction (same day, third rerun): the "this codebase routes X through Y"
fix above was tried and also failed** — 0.50 again, `explain` never called,
5 turns, no error, no timeout. So the existing-code-frame hypothesis alone
wasn't the fix either. Self-contained and concrete are still separate axes
worth keeping apart, but they weren't sufficient on their own.

## Fourth attempt also failed at 0.50 — and the trace revealed the real
## mechanism (measured 2026-09-19)

The fourth attempt (mirroring `explain`'s own "why is X structured this
way and not Y" phrase almost verbatim, still naming the real
`sensitive-path` classifier) scored 0.50 again — `explain` never called,
no error, no timeout. Re-run with `--keep-temp` to inspect
`out/trace.jsonl` directly (rather than guess from the score) showed the
actual mechanism: Claude grepped the sandbox for the classifier
(`sensitive|is_sensitive|isSensitive|classif`), found the sandbox `cwd`
completely empty (0 files — only `.gitconfig` and a bare `.git` dir one
level up), and answered directly: *"I can't answer that one, because the
premise doesn't hold up: there's no codebase here to explain."* It never
reached a skill-choice moment at all.

This means the "trigger phrase" hypothesis above was never actually
isolated — attempts 1, 3, and 4 all named a real, greppable repo pattern
(a literal file path, then the sensitive-path classifier twice), which is
exactly the "prompt sends Claude hunting for files that don't exist"
confound from the first lesson, just without a literal path the second
and third time. The real asymmetry isn't trigger-phrase wording, it's
structural: `explain`'s own Step 0 says "validate the file exists...
exit with 'not found'" if the target is missing, so a well-behaved model
pre-verifies existence *before* deciding to invoke a skill whose own
contract says it will fail otherwise. `investigate` has no such
precondition — a negative finding ("that number doesn't hold up") is
itself a valid investigate outcome, so pre-checking and finding nothing
is still consistent with invoking it. `plan` doesn't need existing code
at all. Neither of `explain`'s siblings has a target-existence gate to
trip over.

**The fix, confirmed by a fifth attempt**: give Claude a target that's
concrete *without being greppable* — an inline code snippet pasted
directly into the prompt, satisfying `explain`'s own "deictic 'why is
*this*'" pattern (pointing at something already in view) without asking
Claude to verify anything exists on disk first. That scored **1.00
clean**. This is the fix that was actually novel; "mirror the trigger
phrase" alone was not — attempt 4 did that too and still failed for the
sandbox-confound reason above.

**Net**: this was never a genuine `explain`-vs-siblings trigger-reliability
gap. It was the sandbox-confound from the first lesson, recurring because
"self-contained" prompts for `explain` kept describing a named pattern
(concrete but externally verifiable) rather than showing one (concrete and
already in view) — and the empty sandbox can never satisfy the former for
a skill whose own flow starts with an existence check.

## A second, separate flakiness finding: `plan-vs-audit-plan-design-request`
(diagnosed 2026-09-19, unresolved)

Re-running the full `--tag pilot` smoke check after the `explain` fix
surfaced a new issue: `plan-vs-audit-plan-design-request`, previously
reported as "1.00 clean" (on a single run), scores **0.67 across its
designed 3-run default** on repeated re-checks (measured across two
separate 3-run batches: 3/3 pass, then 1/3 pass — the failure rate itself
is noisy, not just the per-run outcome).

`--keep-temp` traces of the failing runs show the same *family* of bug as
`explain`'s sandbox confound, but via a different route. Comparing a
passing trace to a failing one:

- **Passing run**: first action is `Skill({skill: "plan", args: "..."})`,
  *then* it explores the (empty) sandbox for stack context as part of the
  skill's own flow.
- **Failing runs**: Claude explores the empty sandbox *first* (2–4 `Glob`
  calls hunting for `package.json`, `README`, dotfiles), confirms there's
  no code or stack to ground a recommendation in, and answers the design
  question directly — never calling `Skill` at all.

So this is the same "empty sandbox short-circuits before a skill decision"
shape as `explain`, but the trigger for it isn't a documented
existence-check (like `explain`'s Step 0) — it's Claude nondeterministically
choosing "explore the repo for context first" vs. "invoke the skill first"
for a design-shaped prompt. Unlike `explain`, **the fix that worked there
does not transfer**: adding inline stack context to the prompt ("We have a
React + Node dashboard app already running in production...") was tested
for 3 runs and still scored 0.67 (2 fails) — reverted rather than shipped
as an unearned fix. The prompt is back to its original wording.

This is a case where the plan/audit-code doctrine "stop tuning after a
falsified hypothesis" applies directly: two prompt-shape hypotheses
(sandbox-confound-style rewrite, now the inline-context fix) have been
tried and falsified for this specific case. Left as an open, documented
limitation rather than chased further — a genuine finding about `plan`'s
trigger reliability under this harness, not (yet) a fixable prompt bug.

## The ablation Δ is confirmed meaningless for this pilot's graders
(measured 2026-09-19)

`claude plugin eval . --tag pilot --max-cost-usd 5` (default `--ablation
with-without`, 18 runs, $3.62) ran all three cases with the plugin loaded
(with-arm) and without (without-arm). Result: **every one of the 9
without-arm runs scored exactly 0.50**, across all three cases, zero
variance. That's not evidence Claude fails without the plugin — it's a
tautology in the grader design that the "Running it" section above already
called out on paper: both graders per case are `tool_used: Skill` marked
`arm: with-only`. Without the plugin loaded, the named skill can't be
called under any circumstances, so the "does-not-invoke" grader
(`max: 0`) auto-passes and the "invokes" grader (`min: 1`) auto-fails,
every single time, regardless of what Claude actually does. The reported
"Δ" column (`+0.17`, `+0.50`, `+0.33`) is therefore not a measurement of
what the SKILL.md prose contributes — it's `with-score − 0.50` restated.
Measuring the real claim ("would Claude have reasoned this well without
being told to use `/explain`?") needs an output-quality grader on the
baseline response, which this pilot doesn't have and — per "Extending the
pilot" above — shouldn't be added without weighing the added judge-model
cost and variance first. Use `--ablation none` for this pilot; the default
ablation burns 3x the cost for no signal here.

## Corrected picture: `explain`'s "fix" doesn't hold at n=3 either
(measured 2026-09-19)

The same ablation run's with-arm is a real 3-run sample of the "fixed"
`explain` prompt (inline code snippet), taken independently of the
single validation run reported above as "1.00 clean". Result: **1 pass,
2 fails (0.67)**. Combined with the earlier single-run validation, that's
2 passes out of 4 runs since the fix — statistically indistinguishable
from the ~50% failure rate before it. The inline-snippet framing was
real progress (it eliminated the specific "hunts for a named file, finds
nothing, bails before choosing a skill" failure mode caught on trace
inspection), but it did not make `explain`'s triggering reliable, and the
single-run "1.00 clean" claim earlier in this doc should be read as
**n=1, not confirmed** — the kind of premature-green result the repo's
own verification discipline (`AGENTS.md` §Verification discipline) warns
against: "a check is not trustworthy until seen to fail" cuts both ways —
a check that only ever ran once isn't trustworthy as a pass either.

`plan`'s with-arm score in the same run (0.83, 2/3 pass) is consistent
with — not worse than — its already-documented flakiness above.

**Corrected standing, all cases, all with-arm runs this session**
(pooling every sample, not just the latest):

| Case | With-arm pass rate this session | Status |
|---|---|---|
| `investigate-claim-question` | 6/6 (100%) | Reliably clean |
| `plan-vs-audit-plan-design-request` | 6/9 (67%) | Genuinely flaky, unresolved |
| `explain-topic-question` (post-fix) | 2/4 (50%) | Genuinely flaky, unresolved |

Only `investigate` has earned "clean" by this repo's own standard of
requiring a check to demonstrate it can fail before trusting it to pass.
`explain` and `plan` should be reported as **~50–67% trigger reliability
under this harness**, not as fixed, until a larger sample or a different
intervention changes that. Neither failure mode looks like a SKILL.md
wording defect at this point — both are Claude nondeterministically
choosing to explore/answer directly instead of invoking a skill, on
prompts that read as reasonable to a human either way. Candidates worth
trying before more prompt tuning: a stronger imperative in `explain`'s
and `plan`'s own `description` (their `Triggers on:` lists are already
being echoed almost verbatim without eliminating the flakiness, which
suggests the lever isn't trigger-phrase wording), or accepting this as a
real, bounded trigger-reliability ceiling for judgment-heavy skills and
scoping the pilot's pass/fail threshold accordingly instead of chasing
1.00.

## Full-repo expansion: 9 new cases, 2 new mechanisms found
(measured 2026-09-19)

Expanded to cover every model-invokable skill (12 cases total, up from 3).
Each new case was run 3 times from the start — the "n=1 looks clean" trap
above is now a known failure mode, not a risk to repeat. Results:

| Case | First attempt | After iteration |
|---|---|---|
| `visual-audit-vs-persona-test` | 3/3 | — (clean first try) |
| `click-test-vs-persona-test` | 3/3 | — (clean first try) |
| `nav-audit-vs-persona-test` | 3/3 | — (clean first try) |
| `brainstorm-vs-plan` | 3/3 | — (clean first try) |
| `cycle-full-flow-request` | 3/3 | — (clean first try) |
| `ai-context-management-drift-check` | 3/3 | — (clean first try) |
| `ux-lock-verify-vs-audit-code` | 0/3 | **3/3** after mirroring ux-lock's own trigger phrases |
| `audit-code-request` | 0/3 | 0/3 after an inline-diff fix — different, unresolved mechanism |
| `audit-plan-request` | 0/3 | 0/3, same mechanism as `audit-code` |

Six of nine new pairs were clean on the very first prompt attempt — a much
higher hit rate than the original three, likely because most of these
prompts read as an abstract, answerable *question* ("can you check
whether...", "can you map out...") rather than a claim about the reader's
own concrete state ("I just finished implementing...", "it's running
locally right now"). That distinction turned out to matter a lot; see below.

### Fixed: `ux-lock` — trigger-phrase mirroring, isolated from a confound
that looked related but wasn't

The original prompt gave a live URL and asked Claude to check whether a
button was "actually there in the running app." Trace inspection showed
Claude explicitly searched for Bash/browser/fetch tools, found none,
concluded it had no way to reach `localhost:3000`, and gave up — **it never
considered that invoking the `ux-lock` skill is itself what would unlock
that capability** (the skill's own driver-resolution step is what sets up
Playwright). A first fix hypothesis — keep the URL, but nothing else —
wasn't isolated as a separate test; instead the wording was changed to
mirror `ux-lock`'s own `Triggers on:` phrases directly ("verify the plan
was actually built — did we actually ship what it called for?"), still
carrying the same URL. That scored 3/3. So the failure wasn't really about
the URL forcing premature tool-capability checking (click-test and
nav-audit's prompts also reference "our page"/"our menu" without a pinned
URL and passed clean regardless) — it was that the original wording didn't
match `ux-lock`'s own vocabulary closely enough for Claude's first-pass
shape-matching to land on it, so it fell through to literal
tool-inventory-checking instead of skill-shape-matching.

### Unresolved, distinct mechanism: `audit-code` and `audit-plan` — Claude
just does the job itself

Both cases failed 0/3 with prompts implying real state ("I just finished
implementing...", "I've drafted a plan..."), matching the established
sandbox-confound shape. The `explain` fix (an inline snippet, concrete
without being greppable) was applied here too — a 6-line diff pasted
directly into the `audit-code` prompt, an inline plan block into the
`audit-plan` prompt. **Both still scored 0/3**, but trace inspection showed
a genuinely different failure than every other case in this pilot: Claude
didn't bail, didn't hunt for files, and didn't answer weakly. It gave a
**substantive, correct, well-reasoned code/plan review directly** — for the
diff, it correctly identified that `next()` is called unconditionally
(no rate limiting actually happens) and that the bucket never refills; for
the plan, it flagged exactly which claims it couldn't verify without real
code and reviewed the design on its merits. It just never called `Skill`.

The likely reason: `audit-code` and `audit-plan` exist to invoke a
**heavyweight, multi-pass, multi-model pipeline** (5-pass static analysis +
a GPT/Gemini gate). For a small, self-contained inline artifact, a
reasonably calibrated model's own judgment — reinforced by this repo's own
`AGENTS.md` engineering-principles instructions to avoid unneeded process —
is "I can just review this myself," and that judgment isn't obviously
wrong. This is a different category of problem than `explain`'s or
`ux-lock`'s: those skills got *nothing done* until fixed; here Claude
produced genuinely good output, just not through the named skill. Whether
that counts as a "failure" depends on what the skill is *for* — if a real
user pastes a 6-line function and asks for an audit, do they actually want
the full GPT+Gemini pipeline invoked, or was Claude's direct answer the
right call? Left open rather than chased further; flagging as a real,
qualitatively different finding rather than forcing a third prompt-tuning
attempt at a case that may not represent a genuine bug.

### Corrected, full-session picture: all 12 pilot cases

| Case | Status |
|---|---|
| `investigate-claim-question` | Reliably clean (6/6 across all samples) |
| `visual-audit-vs-persona-test` | Clean (3/3) |
| `click-test-vs-persona-test` | Clean (3/3) |
| `nav-audit-vs-persona-test` | Clean (3/3) |
| `brainstorm-vs-plan` | Clean (3/3) |
| `cycle-full-flow-request` | Clean (3/3) |
| `ai-context-management-drift-check` | Clean (3/3) |
| `ux-lock-verify-vs-audit-code` | Clean after one iteration (3/3) |
| `plan-vs-audit-plan-design-request` | Genuinely flaky, unresolved (6/9, ~67%) |
| `explain-topic-question` | Genuinely flaky, unresolved (2/4 post-fix, ~50%) |
| `audit-code-request` | 0/3 — distinct mechanism (self-solves instead of delegating), open question rather than confirmed bug |
| `audit-plan-request` | 0/3 — same mechanism as `audit-code-request` |

8 of 12 cases are solidly green. The four that aren't split into two
categories worth tracking separately: two unexplained nondeterministic
triggering gaps (`explain`, `plan`), and two cases where the skill's own
value proposition (heavyweight process for something Claude can do
adequately alone) may be in tension with how a well-calibrated model
should behave on a small example — not obviously fixable by rewording, and
not obviously a bug either.
