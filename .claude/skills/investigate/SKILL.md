---
name: investigate
description: |
  Settle a factual claim about this repo with a measurement, not a
  recollection. Use when a number, a date, or a current state is asserted and
  needs checking: verify a figure in a doc or plan, establish when a change
  actually landed, reproduce a past measurement, or confirm whether something
  is really enabled/disabled/enforced. Forces a cross-check by a second
  INDEPENDENT method and a positive control, because a zero result and a
  broken instrument look identical.
  Pick by INPUT: a CLAIM to test comes here ("the cache cut cost 40%", "that
  landed in July"); a TOPIC to survey goes to /explain --history ("have we
  touched rate limiting?"). "Why is it this way" is /explain.
  Triggers on: "verify that", "is that number right", "is this still true",
  "when did we actually", "did that change land", "reproduce the measurement",
  "check whether X is really", "confirm the claim", "/investigate".
  Full command syntax: see the Usage section in this skill.
---

# Investigate

> **Worktree preflight** — in a linked git worktree the synced tooling tree
> `scripts/.claude-skills/` is absent — it is gitignored, so `git worktree add`
> does not populate it, and every command below that uses it dies on a bare
> `MODULE_NOT_FOUND`. Run `npm run skills:hydrate` first. Detail:
> `docs/runbooks/consumer-adoption.md` §"Linked git worktrees".

## Usage

```
Usage:
  /investigate "<claim or question>"    — verify one claim
  /investigate "<claim>" --brief        — emit a brief for a sub-agent/session
```

For claims with a truth value an instrument can settle. Two investigations on
2026-08-03 returned correct answers *despite* the method prescribed for them
being wrong — the answers were right by luck. This skill exists so the next one
is right on purpose.

**Scope firewall**: include a step only if it changes what you *measure*. "Why
is this code shaped this way" is `/explain` — recorded rationale, not
measurement. "Is the plan implemented" is `/ux-lock verify`. "Is the code
correct" is `/audit-code`.

---

## The failure this skill prevents

Both 2026-08-03 briefs named a specific command. In both cases the named
command fails **silently** on the exact question being asked — it returns a
confident, well-formed, wrong answer rather than an error.

| Prescribed | Why it fails silently |
|---|---|
| `docker image inspect --format '{{.Size}}'` | Under the containerd snapshotter this returns *content* size, not the *disk usage* figure the claim cited. They differ by 3.6x. Following the brief would have produced a rigorously-derived false contradiction. |
| `git log -S 'python3 make g++'` | The commit removed the string from a `RUN` line and re-added it verbatim in a comment. Net occurrence count unchanged, so `-S` reports nothing. A reader reproducing the stated method would conclude the change never happened. |

Both over-specified *how* and under-specified *what quantity is in question*.

> The pickaxe case is **live in this repo**. `scripts/explain-history.mjs` ran
> `git log --all -S <topic>` as its content search. Measured on 2026-08-04:
> `-S 'runJsonLinesAsyncStrict'` → 18 commits; `-G` on the same symbol → 35.
> Seventeen commits that touched lines containing the symbol were invisible to
> the tool this repo ships for answering "have we touched this before?" Pass C
> (`-G`, `source: git-touched`) was added the same day.

---

## Step 1 — State the quantity, before naming a tool

Write down what is actually in question — the measurement, event or object —
and *how you know that is the one the source meant*. Do not assume the obvious
reading. `.Size` and disk usage are both "the image size"; only one is the
claim's figure.

If the brief you were handed names a command, treat that as a hint about intent,
not an instruction. Say which quantity you concluded it meant, and why.

Also settle **which question**: verifying a historical claim and assessing
current state are different. "Does the July figure reproduce at that commit"
and "does the number still hold for what is deployed today" have different
answers. Say which one you are answering, and if you think the other is the one
that matters, say so.

## Step 2 — Choose the instrument, then break it on purpose

State the method you chose and why. Then:

For "when did this change" questions, `/explain --history "<topic>"` is the
repo's cross-source instrument (git subject-grep + `-S` + `-G`, arch-memory,
plans, brainstorm ledger) — use it rather than a hand-rolled `git log`, and
treat its four sources as candidate cross-checks. For "is this stated gate
actually enforced" questions, `npm run gates:check` reads the `gate-contract.json`
binding directly. Neither removes the obligations below.

- **Cross-check with a second, independent method.** Independent means it does
  not share an input with the first. Two readings derived from one capture are
  one observation, not two — that is how a fabricated finding survives four
  review passes (see `docs/runbooks/pre-ship-empirical-verify.md`).
- **Reconcile any disagreement, and report it even if you resolve it.** A
  reconciled disagreement is the most informative thing in the report; deleting
  it because you settled it discards the evidence that the first number was
  ambiguous.
- **Require a positive control.** A wall of zero matches, empty results or
  denials is indistinguishable from a broken harness, a dead endpoint, a
  revoked credential or a typo'd path. State what result would prove the
  instrument was working, run that too, and report it alongside. This is the
  same rule as "can this gate return green without having checked anything?" —
  applied to your own measurement instead of to a code path.

**Capture, don't summarise.** A transcript showing only the successful commands
is a reconstruction. Include failures and retries, in the order issued. Name any
evidence file using the actual capture date, determined at run time — not a date
copied from the brief.

## Step 2.5 — Verify the attribution, not just the figure

Reproducing a number does not test the sentence it sits in. A recorded "22.5%
image-size reduction" **reproduced perfectly** while its stated cause was false:
the parent commit already had the property being credited, and the real mechanism
accounted for **92%** of the delta. A pass that checks figures and not
attributions clears both.

So whenever the claim names a *cause* — "X made it faster / smaller / safer":

- **Ask whether the parent already had the property being credited.** Inspect the
  parent for it directly. This is the whole check, and it is usually one command.
- **Ask the build system where one can answer.** In the source case a resolver
  settled it independently of reading any file: one target resolved at the parent,
  the other did not.
- **Decompose the delta.** 92/8 is a different story from 50/50, and only
  measurement distinguishes them.

**Report two verdicts, never one**: `figure: reproduced | refuted` and
`attribution: confirmed | refuted | untested`. Fusing them is the artefact that
misleads — and `untested` is a legitimate result to report.

The chronological trap is the sibling, in both directions: do not infer causation
from proximity (Step 3), and check the order actually holds — in the same
engagement a campaign credited with enabling a migration began *ninety minutes
after* that migration merged.

→ `references/verification-discipline.md` §4.

## Step 3 — Report without softening

- **Label every figure `measured` / `derived` / `expected`, and carry the fields
  its kind requires** — for `measured`, the exact command, the working context,
  the immutable revision, the observation time; for `derived`, its sources and
  formula; for `expected`, its basis and an explicit note that it is not a
  measurement. A label with no evidence behind it is the same shape as a green
  with no check. A documented test count once sat stale by 2.3x on count and
  6.7x on wall clock, and nothing in the row said when it had last been true.
- **Name the metric.** "Size" and "faster" name nothing: one container image
  reported three sizes varying by **3.6x** depending on tool and storage driver.
- **Pin any `file:line` you cite to the commit you read it at** — `path:120
  (a4ec98da)`. Cite append-newest-first files (`status.md`, changelogs) by
  section header, never by line. A path is durable; a path plus a line is a
  snapshot. Five of nine bad claims in one verified document were correct when
  written and decayed afterwards. → `references/verification-discipline.md` §1-2.
- Where the evidence does not settle a question, say it does not settle it.
  **Absence of a recorded rationale is a finding, not a gap to fill with a
  plausible one.** Confabulating a plausible rationale is the default
  behaviour, and it is indistinguishable from a real one in the output.
- Do not infer causation from chronological proximity. Two commits one day
  apart were driven by unrelated goals in the case that prompted this rule.
- If history was rewritten, squashed, or the record is otherwise unavailable,
  say so explicitly rather than working around it.

## Step 4 — Recommend, open-endedly

Recommend a position and justify it. Any options you list are illustrative, not
exhaustive. If the honest answer is a split — drop one half of the claim, keep
the other — say so. In one of the two source investigations the true answer was
exactly that split, and a closed menu did not contain it.

---

## Two different failure modes — do not merge them

The 2026-08-03 briefs got one half right and one half wrong, and the halves are
independent. Both belong in any brief you write:

**Incentive design — this worked, keep doing it.** Removing the reward for a
pleasing answer, by pre-authorising the unpleasing one and naming the specific
cheat paths:

> A failed reproduction is a legitimate and reportable result.
> I would rather narrow the claim than defend an inflated one.
> Do not adjust the figures to match a fresh build.
> Do not substitute a different commit or patch the old file to make it build.

Generic instructions to "be rigorous" do nothing; naming *this task's* specific
corruption does.

**Method prescription — this failed, and it is the harder one to see.** The
incentive failures are visible: you can read a brief and notice it is leading
the witness. A wrong instrument is invisible from the brief — it looks like
rigour. It only surfaces when someone knows the tool's semantics, and the whole
point of delegating was that they might not.

## Four things not to put in a brief

1. **Do not prescribe the command.** Ask for the quantity plus a justified
   method and a cross-check.
2. **Do not offer a forced-choice menu with a pre-endorsed option.** A closed
   menu plus a stated preference produces a worse answer than an open question.
3. **Do not hardcode unverified values.** An evidence filename was dated a day
   ahead of the actual capture — in a brief about appearance versus reality.
4. **Do not issue unscoped destructive cleanup.** "Prune afterwards" on a host
   with 25 images, 166 volumes and other projects' builds would have destroyed
   unrelated work. Clean up only what this task created, by name or tag.

---

## Reference files

This skill's canonical flow is above. The files below cover specialised
situations — read them only when the trigger applies.

| File | Summary | Read when |
|---|---|---|
| `references/brief-skeleton.md` | Copy-paste brief template for delegating an investigation to a sub-agent or fresh session. | Invoked with `--brief`, OR the user is writing instructions for another agent/session to run the investigation. |
| `references/verification-discipline.md` | Verification discipline — pinned citations, figure provenance, two-direction proof, attribution, consumer-side checks. | Step 2.5 — the claim names a cause and the attribution needs testing, OR Step 3 — writing figures or `file:line` citations into a durable document. |
