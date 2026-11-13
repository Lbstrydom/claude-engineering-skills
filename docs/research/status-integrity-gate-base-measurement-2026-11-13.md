# `status:integrity:gate` — the `base == HEAD` refusal, measured

**Date**: 2026-11-13 · **Verdict**: **FIXED.** The refusal was keyed to a
proxy (`base == HEAD`) instead of to the real condition (the two states are
identical). Fail-closed is unchanged. **Frequency: every CES `/ship`, by
construction** (§3d-bis) — the gate contributed nothing to `guards:preflight`
on any ship, and an explicit `--base` did not help.

All `file:line` citations are pinned to **`36dc4ca6`**, the commit read.
Every figure below is labelled `measured` / `derived` and carries its command.

> **On the pins**: `npm run docs:citations -- <this file>` reports `MOVED` and
> `DRIFTED` lines against this PR's own tip. That is correct, not rot: §6 edits
> several of the cited regions, so a citation pinned to the commit *read*
> necessarily no longer matches the commit *shipped*. The pin is what makes
> that legible — re-pin only if you re-read the code at a later commit.

> **Scope note.** This began as a measurement-only investigation ("recommend,
> and be willing to recommend nothing"). Louis then asked for the bug fixed.
> The measurement is kept in full below because it is what selects the fix —
> and it rules out the fix the original framing implied. §6 says which, and why.

---

## 0. The question

Raised by Louis, 2026-11-13: *"`status:integrity:gate`'s default base is
`@{upstream}`, which equals HEAD on any fully-pushed branch, so a manual
`check:static` can never run to the end there. The gate is right to fail
closed… I'd want a measurement of how often it bites before changing a gate
that's correctly refusing to compare nothing."*

Two things were explicitly **not** asked for: a change that makes the gate
pass, and an argument from how annoying it is.

---

## 1. What it does today, precisely

**Confirmed — with one correction to the mechanism.** The description of the
*outcome* is exactly right. The *trigger* is broader than `@{upstream}`.

### The chain

| Step | Location (`36dc4ca6`) |
|---|---|
| gate script | [`scripts/check-status-log-integrity.mjs`](../../scripts/check-status-log-integrity.mjs) |
| default base comes from the resolver | `scripts/check-status-log-integrity.mjs:164-168 (36dc4ca6)` |
| inferred base validated like an explicit one | `scripts/check-status-log-integrity.mjs:172-176 (36dc4ca6)` |
| the `base == HEAD` refusal | `scripts/check-status-log-integrity.mjs:144-149 (36dc4ca6)` |
| `@{upstream}` default | `scripts/lib/push-range.mjs:131-132 (36dc4ca6)` |
| fork-point default | `scripts/lib/push-range.mjs:136-137 (36dc4ca6)` |

With no `--base`, `resolveBase` calls `resolvePushRange`, takes its `base`,
and passes it through `validateExplicitBase`, which **throws when the base
resolves to HEAD**. `main()` catches that and exits **2** with
`verdict: "bad-base"`.

### Measured, live in this worktree

```bash
node scripts/check-status-log-integrity.mjs --json; echo "exit=$?"
```

```
{"ok":false,"verdict":"bad-base","error":"--base \"36dc4ca6…\" resolves to HEAD (36dc4ca6). The previous and current states would be identical, so conservation would hold having compared nothing."}
exit=2
```

So: **it fails (exit 2). It does not skip, and it does not report anything
that reads like a pass.** Fail-closed, as documented at
`scripts/check-status-log-integrity.mjs:11-16 (36dc4ca6)`.

### The correction: there are TWO triggers, not one

`@{upstream}` is only the first precedence rung. Measured in a disposable
repo (`/c/tmp/prm2`, bare remote + work clone), probing
`resolvePushRange({})` and resolving its base at each state:

| State | `source` | base == HEAD? |
|---|---|---|
| A — `main`, fully pushed, clean | `upstream` | **REFUSE** |
| B — `main`, 1 commit ahead of upstream | `upstream` | ok |
| C — new branch off an *un*pushed main tip, no own commits | `fork-point` | ok |
| D — new branch, no upstream, 1 own commit | `fork-point` | ok |
| E — `feat`, fully pushed | `upstream` | **REFUSE** |
| F — detached at a pushed sha | `fork-point` | ok |
| G — back on `main`, upstream behind | `upstream` | ok |
| H — fresh branch off a **fully-pushed** main, zero own commits, no upstream | `fork-point` | **REFUSE** |

Case **H** is the one the framing misses, and it is the case this very
worktree was in: a Claude Code worktree branch created at `origin/main`'s tip
has no upstream, so the resolver falls to `merge-base origin/main HEAD` —
which **is** HEAD. The refusal therefore also fires on a branch that has
never been pushed at all.

**The unifying predicate is not "fully pushed".** It is:

> **HEAD contains no commit that its base source lacks** — i.e. *this
> branch/push carries no commits*.

That covers both the post-push state and the fresh-worktree state.

---

## 2. The `push-range.mjs` invariant — verdict: **NOT VIOLATED**

AGENTS.md: *"One range, one resolver — `push-range.mjs`. Gates must not
re-infer a base from working-tree state (`@{u}`, dirty→`HEAD~1`)."*

The gate **already routes through the one resolver**
(`scripts/check-status-log-integrity.mjs:164 (36dc4ca6)`), and it is not exempted —
it is one of the rule's model citizens. Its own file header says so
(`scripts/check-status-log-integrity.mjs:18-23 (36dc4ca6)`):

> "`scripts/lib/push-range.mjs` is this repo's single range resolver, and
> AGENTS.md's rule is explicit: gates must not re-infer a base from
> working-tree state."

So **the fix proposed by the lead — "route it through the one resolver" — is
already done, and routing it through the resolver is what produces the
behaviour.** `@{upstream}` is the *resolver's* documented rung 2
(`scripts/lib/push-range.mjs:68-73 (36dc4ca6)`), labelled `trusted: false`, and the
resolver's own header names the exact failure modes it was built to end
(`scripts/lib/push-range.mjs:4-21 (36dc4ca6)`). The gate is downstream of a deliberate
design choice, not in breach of it.

One asymmetry worth naming: the resolver reports `source` and `trusted`, and
`describePushRange` exists so *"a gate that narrowed its scope because it had
to guess must be able to SAY so"* (`scripts/lib/push-range.mjs:22-26 (36dc4ca6)`). This
gate reads only `base` (`scripts/check-status-log-integrity.mjs:168 (36dc4ca6)`) and
discards both. That is why its refusal could name the resolved sha but not the
rung that produced it — so an operator in the fresh-worktree case (**H**) saw
a bare sha with no way to tell the fork-point path had been taken. §6 threads
`describePushRange` into the message; threading the whole range object through
`resolveBase` would be the structural version (§7).

---

## 3. Frequency — **the bite rate cannot be measured; exposure can**

### 3a. What is NOT measurable, and why

The honest denominator for "how often does it bite" is **invocations of
`npm run check:static` / `npm run check` outside the pre-push hook**. Nothing
records them.

| Instrument | Result | Command |
|---|---|---|
| Audit store — any table recording gate or `check` runs | **none exists** (74 tables enumerated; closest are `friction_log`, `memory_friction`) | `git ls-files 'supabase/migrations/*.sql' \| xargs grep -hoiE "create table (if not exists )?[a-z0-9_.]+"` |
| `friction_log` | **0 rows, ever** | `select count(*) from friction_log` |
| `memory_friction` | **0 rows, ever** | `select count(*) from memory_friction` |
| `.claude/tmp/push-gate.log` (untracked, machine-local, 90,757 lines) | **0** mentions of `status-log-integrity`; 2 of `knip:gate` across the whole file — an ad-hoc stdout redirect, not telemetry | `grep -c status-log-integrity .claude/tmp/push-gate.log` |

**Positive control** (same connection, same session — so the two zeros above
are real emptiness, not a broken instrument): `audit_runs` **7100**,
`fleet_events` **8990**, `ship_events` **434**, `debt_entries` **1426**.
Store `d5a9d07b91225a93` (NAS, `db=audit_loop`).

Measured on one store only. Per AGENTS.md consumers are not all on one store,
but §4 establishes this gate reaches no consumer, so no other store can hold
a run of it.

**Conclusion: the bite rate is unmeasurable with the instruments that exist.**
To measure it you would need the one thing absent: a record of each gate
invocation carrying its resolved base `source` and verdict. That is a new
telemetry surface, and this finding does not recommend building one for a
single gate.

### 3b. What IS measurable: exposure

A one-point census of every live worktree of this repo, 2026-11-13, applying
the predicate from §1:

```bash
git worktree list --porcelain | awk '/^worktree /{print $2}' | while read -r wt; do
  h=$(git -C "$wt" rev-parse HEAD); up=$(git -C "$wt" rev-parse --verify --quiet '@{upstream}')
  if [ -n "$up" ]; then b="$up"; else b=$(git -C "$wt" merge-base origin/main HEAD); fi
  [ "$b" = "$h" ] && echo "REFUSE $wt"
done
```

**Measured: 6 of 17 live worktrees (35%) would refuse right now** — 3 by
`@{upstream}`, 3 by fork-point. Labelled `derived` as a rate: it is one
census point, not a time average, and worktree population turns over daily.

### 3c. Was the refusal correct in those cases?

Of those 6 refusing worktrees, how many had **any** delta for the gate to
compare? (Read the bound this puts on things in §3e — a one-instant census is
near the wrong instrument for a transient state.)

```bash
git -C "$wt" status --porcelain -- status.md docs/status | wc -l
git -C "$wt" status --porcelain | wc -l
```

**Measured: 0 of 6 had any dirty file at all** — subject-dirty 0, tree-dirty 0,
in all six. **In every observed instance the refusal is correct and the
comparison it declines is genuinely vacuous.**

### 3d. Does the documented workflow even ask for the manual run?

```bash
git grep -nE '(Run|run|re-run|Re-run) `npm run check(:static)?`' -- '*.md' | wc -l
git grep -nE '(Run|run|re-run|Re-run) `npm run check(:static)?`' -- 'skills/**/*.md'
```

**Measured: 1 committed doc** instructs it imperatively, and it is a plan
(`docs/plans/skill-efficacy-census.md`). **No SKILL.md and no runbook does.**
The 392 raw `npm run check` matches across `*.md` are dominated by
`sync-shared-audit-refs` banner boilerplate ("`npm run check` verifies it"),
which is a statement *about* the hook, not an instruction to run it by hand.

So the habit Louis describes is a habit, not a documented step. The designed
path is the pre-push hook, which supplies an explicit base
(`.githooks/pre-push:402`, `scripts/prepush-check.mjs:590-594 (36dc4ca6)`) — making the
base `source: 'explicit'`, `trusted: true`, never HEAD. **The pre-push path is
unaffected, confirmed — before and after the §6 fix.**

### 3d-bis. The live frequency answer — reported by a concurrent session, reproduced here

A concurrent CES session hit all three states in sequence on one branch while
shipping a docs-only commit, and its report reframes §3a. Reproduced in a
disposable repo (`/c/tmp/prm5`, per-entry layout, real gate):

| Step | State | Result |
|---|---|---|
| 1 | fresh branch, no upstream, nothing on disk | **exit 2** |
| 2 | same, with an **explicit** `--base origin/main` | **exit 2** — `origin/main` **is** HEAD at that moment |
| 3 | after the commit landed | `conserved against <sha>` — measured |

Two things follow, and the second is the frequency answer.

**An explicit base does not help.** The gate is asked *before HEAD has moved
past the branch point*, so there is no ref that spans anything. This kills the
"just pass `--base`" workaround as a general remedy.

**A gate exiting 2 is counted as UNMEASURED, not failed.** `EXIT_CANNOT_RUN = 2`
(`scripts/lib/guards-preflight.mjs:181`), so `guards:preflight` reports
`INCOMPLETE: not measured: status:integrity:gate`. The honesty surface works —
it is not a false green — but the gate contributes nothing.

**And that state is not rare: it is every CES `/ship`.** The documented flow
cuts a branch at the default-branch tip, writes the new status entry to disk,
and runs `guards:preflight` **before** committing. So:

> **The honest frequency is not a rate over a habit — it is "every ship, by
> construction".** §3a's unmeasurable "how often does someone re-run after
> pushing" was the wrong denominator. The right one is structural, needs no
> telemetry, and is 100%.

This is also what makes the §5 blind spot matter rather than being theoretical:
at that exact moment the uncommitted status entry is on disk, which is the
delta the old proxy refused to look at. §6's fix turns step 1 into a real,
firing check — and three negative controls (§6.1) prove it is not vacuous.

### 3e. What the frequency does and does not establish

Being precise about this, because it is easy to over-claim in both directions.

**What it rules out.** Making the clean-tree case pass. The refusal is correct
in 6 of 6 observed instances (§3c), the bite rate is unmeasurable (§3a), and
the documented workflow never asks for the manual run (§3d). Had the bug been
"the refusal is annoying", there would be no evidence for touching it — and
AGENTS.md forbids the change anyway (§6).

**What the census does NOT establish.** The frequency of the state the §6 fix
addresses. `base == HEAD` **with a status-log delta on disk** was observed
**0 of 6** — and that turned out to be a **sampling artefact, now superseded by
§3d-bis**: a census taken at one instant across 17 worktrees catches them
mostly **at rest**, while a tree carries an uncommitted status entry only
during the minutes of a ship. Reading 0/6 as "this does not happen" would have
been reading the wrong instrument. §3d-bis measures the same state
structurally instead of by sampling, and it is **every ship**.

**Correction to this document's own earlier verdict.** An earlier revision used
the 0/6 figure to argue for recording the gap rather than fixing it. That was
wrong: **a point-in-time census over long-lived containers cannot measure a
transient state**, and the right move was to ask what the state *is
structurally tied to* (here: the ship flow) rather than how often a snapshot
catches it. This is `verification-discipline` §4a's test — *does the reader's
result depend on `now()`?* — which was already in this branch's base when the
census was run; §3f works through why it was not reached for. The two numbers
divide cleanly:

- **6 of 6 clean (§3c)** — argues for keeping the refusal where the states
  really are identical. Still correct, still honoured by §6.
- **Every ship (§3d-bis)** — argues for correcting the proxy. This is the
  figure that justifies the fix.

Neither alone would have selected it; the fix's primary justification remains
correctness (§5), with §3d-bis establishing that it is not theoretical.

### 3f. This is not a new rule — it is §4a's test, failed on a single read

The first draft of this section proposed a new rule. That was wrong, and
checking it against the existing reference is what showed why.

**[`verification-discipline.md`](../audit/shared-references/verification-discipline.md)
§4a already owns this**, landed hours earlier by #351 (`bd2b3c06`) and present
in this branch's own base (`20e4e026`) when the census was run. Its mechanical
test is:

> *does the reader's result depend on `now()`?*

Applied to §3c: the dirtiness of a worktree is **entirely** a function of when
you look, so the answer is plainly yes — and §4a's test would have caught the
error. **I had the rule and did not reach for it.** That is the honest finding,
and it is more useful than a new rule would have been.

**What §4a covers, and what this case adds.** §4a's worked case is *two* reads
over a rotating population, and its remedies are shaped for a delta: name a
cohort both reads share, or compare a quantity aging cannot reduce. Here there
was only **one** read, used as a prevalence claim ("0 of 6, so this does not
happen"). The test transfers exactly; the remedies do not. So the additive part
is narrow:

- **A single read needs the test too.** §4a's tell is *"a delta nobody worked
  for"*, which a one-shot census does not present — there is no delta to be
  suspicious of. The question has to be asked of a bare count as well.
- **Property or episode?** The useful form of §4a's test when there is no
  clock in a query to grep: *is the thing I am counting a **property** of the
  container, or an **episode** inside it?* A property (a worktree's branch, its
  upstream, its config) is safe to sample. An episode (mid-edit, mid-ship,
  mid-request, holding a lock) is not — it is `now()`-dependent without any SQL
  saying so. Then ask what the episode is **structurally tied to** and count
  that instead: the flow that always produces it. A structural answer needs no
  sampling and no telemetry, and it does not decay. §3d-bis is one.
- **The honest wording for a bare count.** "Observed 0 of N" is evidence of
  rarity only once you have stated the observation window and shown the state
  would have been visible inside it. Without that, 0 of N and "I measured the
  wrong thing" are indistinguishable — as a broken instrument and a true zero
  are (§3 of the same reference).

Both halves of this investigation failed a form of the test: §3a's bite rate
was the wrong *denominator* (a habit nothing records), and §3c's 0 of 6 was the
wrong *instrument* for a real state.

**Disposition — NOT promoted, and the §7.5 trigger is NOT met.** A concurrent
session proposed #348's standing-queue finding as the second, unrelated case.
It is not: **#348 is the incident that produced §4a**, so counting it would be
double-counting one incident under two rules. Nothing here earns an edit to a
file synced into **ten** skills' `references/` and out to consumers.

The remaining candidate change is much smaller than a new rule and is recorded
as §7.5: **one clause in §4a** noting that its test applies to a single read
used as a prevalence claim, not only to a delta between two reads. That is for
Louis to take as its own change, not something to widen this PR with.

---

## 4. Consumer blast radius — **zero**

| Question | Answer | Evidence |
|---|---|---|
| Is the gate synced to consumers? | **No** | `scripts/.claude-skills/check-status-log-integrity.mjs` absent in both live consumers (wine-cellar-app: 78 synced `.mjs`; ai-organiser: 79) |
| Does any consumer `package.json` define `status:integrity:gate`? | **No** | `grep status:integrity` in both — no match |
| Is `status.md` itself synced? | **No** | corroborates `docs/plans/backlog-and-drift-reduction.md:575 (36dc4ca6)`, which already recorded this |
| Is `push-range.mjs` synced? | **Yes** | `scripts/.claude-skills/lib/push-range.mjs` present |
| Do synced callers fail closed on `base == HEAD`? | **No** | the two consumer callers (`check-plan-status.mjs:62`, `lib/upstream/reconcile-gate.mjs:66`) degrade gracefully on an empty range; neither has the HEAD-equality refusal |

**The fail-closed-on-`base == HEAD` behaviour is unique to this gate, and this
gate reaches no consumer.** A consumer cannot hit this.

### The 2026-10-02 hook note

The note at `.githooks/pre-push:244-255` landed in `b9198f76`
*"fix(pre-push): skip the check for a delete-only push (#158)"*, 2026-10-02.
It does not describe an open carry. It is the **post-mortem of a different,
already-fixed instance of the same root cause**: in a worktree detached at
`origin/main`, a `git push origin --delete <branch>` ran the full check with
an empty range and `status:integrity:gate` blocked the deletion after ~10
minutes. The fix was to skip when `PUBLISHED_REFS == 0 && DELETED_REFS > 0`.

That matters for precedent: **the repo has already decided once that "this
push publishes no commits ⇒ there is nothing to verify ⇒ skip" is correct** —
but it made that decision in the *hook*, where "no refs published" is a fact
git states, and not in the gate. It never reaches consumers either: the hook
is installed per-repo by `scripts/install-prepush-hook.mjs`, and the consumer
copy carries the same skip.

---

## 5. The bug — the refusal was keyed to a proxy

The gate refused on **`base == HEAD`**. That is a proxy for "there is nothing
to compare", and it is **false whenever the working tree is dirty**, because
**`curr` is read from disk, not from HEAD**
(`scripts/check-status-log-integrity.mjs:252-259 (36dc4ca6)`).

Proved on a disposable copy (`/c/tmp/prm3`, real gate, real git):

1. **`curr` is the working tree.** `--base HEAD~1`, clean → `ok:true`. Same
   base, `status.md` truncated **on disk only, nothing committed** →
   `ok:false`, 2 × `entry-vanished`, exit 1. `git checkout -- status.md` →
   `ok:true` again.
2. **`base == HEAD` + dirty tree is a substantive comparison.** With the
   refusal patched out of the *copy*, `base == HEAD` + a truncated `status.md`
   → `ok:false`, **3 × `entry-vanished`**, exit 1. With a clean tree it →
   `ok:true`, 0 violations — a genuinely vacuous pass.

So the gate was **blind to an uncommitted history truncation** on any
fully-pushed branch or fresh worktree — **6 of 17 live worktrees** (§3b). And
that is not a marginal blind spot: **PR #87's own defect class is a
working-tree event** — a partial Read then a whole-file Write — so the gate
was declining to look exactly where its founding incident happens, at the
moment it happens.

The existing test already knew the premise was conditional:
`tests/check-status-log-integrity.test.mjs:228 (36dc4ca6)` scoped its comment
to *"on a clean tree the two states are the same object"*.

---

## 6. The fix

**One change: ask the question where the answer is known.**

`validateExplicitBase` no longer throws on `base == HEAD`. It returns
`{ oid, emptyRange: true }`, and `main()` reads both states as usual, then
calls **`refuseIfNothingToCompare(base, prev, curr)`**, which refuses **iff
the range is empty AND the two states are byte-identical**. That is the real
condition, and it can only be evaluated after both sides have been read.

```
before:  base == HEAD                      -> exit 2   (proxy)
after:   base == HEAD && prev == curr      -> exit 2   (real condition)
         base == HEAD && prev != curr      -> run the laws
         base != HEAD                      -> unchanged
```

### Why each newly-passing case now has a real range

The constraint on this fix was: *if your change makes any currently-failing
case pass, say exactly why that case now has a real range.* There is exactly
one such case.

| Case | Before | After | Why it is a real comparison |
|---|---|---|---|
| empty range, **clean** tree | exit 2 | **exit 2, unchanged** | Nothing differs. Still fails closed — and this is the case §3c measured at 6 of 6, so the common case is untouched. |
| empty range, **status-log delta on disk** | exit 2 | **exit 0 or 1, on the laws** | `prev` is HEAD's committed state, `curr` is the working tree. They differ **by the uncommitted edit**, which is a real, non-empty delta over the gate's own subject. The laws are applied to that delta, not to an empty one. Measured: a truncation → exit 1 with `entry-vanished`; a legal append → exit 0. |
| non-empty range | unchanged | unchanged | Not touched. |

**No case passes without something to compare.** The refusal was not relaxed;
it was moved from a proxy that over-fires to the condition it was always
meant to express.

### Honesty: a working-tree-only run says so

A run whose range was empty compared the working tree against one commit, not
a span of commits. Reporting that as plain `conserved against <sha>` would
let a green be read as covering commits it never saw. So:

- the summary reads `conserved against the working tree vs <sha> (empty commit range)`
- `--json` carries `emptyRange` and `comparedWorkingTreeOnly`

### The one-resolver invariant (§2) is satisfied, not bent

**No base resolution changed.** The base still comes from `push-range.mjs`,
unchanged, and no new inference was added — which is why this is the right
shape of fix. What changed is *when the gate decides the range is useless*.

`canonicalState` sorts keys before comparing, because `prev` is enumerated by
`git ls-tree` / `git show` and `curr` by `readdirSync` / `readFileSync`: the
same content arrives through two different enumerations, so comparing raw
`JSON.stringify` output would compare orderings and claim a delta where there
is none — which on this gate means running the laws on a vacuous pair.

### What this does NOT fix, and why that is correct

**A manual `check:static` on a fully-pushed branch with a clean tree still
exits 2.** That is the case Louis's original framing described, and it must
stay failing:

- Nothing differs, so a pass would be a green having compared nothing —
  forbidden by AGENTS.md's sandbox-honesty rule: *"Ask whether it can go green
  in a clean checkout having checked nothing — if so it needs a strictness
  flag, not a tolerated skip."*
- The pre-push sandbox runs against a deliberately clean checkout, so a
  clean-tree skip would silently disable the gate exactly where merges land.

In practice this removes most of the friction anyway: you run `check:static`
*while you have uncommitted work*, and that is precisely the case that now
runs to the end. With a genuinely clean tree there was never anything for this
gate to do.

### Rejected alternatives, and what each would have broken

| Option | Rejected because |
|---|---|
| **Widen the default base to the fork point** when it collapses (so a fully-pushed *feature* branch gets a non-empty range) | It is a real range, but **redundant coverage**: each push checks `remote-tip..new-tip`, and the union over a branch's pushes is already `fork-point..HEAD`. It would re-audit commits that were checked when they were pushed, to make a clean-tree run produce output. That is making the gate pass rather than making it correct. (It would help only after a history-rewriting force-push — noted, not acted on.) |
| **Change the default base** to `HEAD~1` or a hardcoded `origin/main` | `HEAD~1` is the exact under-scoping `push-range.mjs` was built to end (`scripts/lib/push-range.mjs:4-16 (36dc4ca6)`) — a multi-commit push could hide a deletion in a non-tip commit. A hardcoded `origin/main` is a second resolver, in breach of the one-resolver rule. |
| **Exit 0 on an empty range** | A green having checked nothing. See above. |
| **Skip when the tree is clean** | Same class, and it would disable the gate in the pre-push sandbox. |
| **Refuse on `prev == curr` generally**, not only in the empty range | Would block almost every push: outside the empty range, `prev == curr` is the ordinary and legal "this range did not touch the log". Pinned by a test (§6.1). |

### 6.1 Tests — all three directions, each proven by reverting

The failure mode guarded against is a gate loosened until it stops
complaining, so the must-not-fire directions carry as many tests as the fix.

| Revert applied | Tests that go red |
|---|---|
| **the fix** — restore the `base == HEAD` throw | 2 — `THE FIX — … TRUNCATION on disk is caught`, `THE FIX, other way — … legal APPEND … PASSES` |
| **loosen** — never refuse | 3 — `--base HEAD on a CLEAN tree is REFUSED`, `… keeps its VERDICT`, `MUST NOT FIRE — empty range, CLEAN tree still FAILS CLOSED` |
| **broaden** — refuse on any identical pair | 3 — `MUST NOT FIRE — a NON-empty range that leaves the log alone still passes`, `a real range reports that it did NOT compare only the working tree`, `a real ancestor exits 0 on a conserved log` |

Restored each time: **41/41 pass** (was 28). Reverting the fix reds **6** once
the live-shape tests below are included.

**The live `/ship` shape** (§3d-bis) is tested end to end in the per-entry
layout this repo actually uses: a fresh branch with no upstream, the new status
entry on disk, nothing committed. One test asserts the gate now **measures**
(exit 0, `comparedWorkingTreeOnly: true`); a CONTROL asserts that
`--base origin/main` is still refused there on a clean tree, so a later reader
cannot "fix" this by passing a base; and **three negative controls** — an
existing entry record deleted, `status.md` truncated, the marker deleted — each
**fail with exit 1**, which is what proves the newly-unlocked measurement is
not vacuous.

Two further properties of the new suite:

- **A CONTROL test asserts the fixture is actually in the collapsing state**
  (`HEAD == @{upstream}`). Without it, all four behavioural tests could pass
  for the wrong reason — a fixture with a non-empty range never exercises the
  fix at all.
- **An unresolvable base still fails closed** in the fixture as well as in the
  repo, so the pre-existing fail-closed contract is asserted on both paths.

The suite runs against a **disposable** repo: the fix's subject is a dirty
working tree, and this checkout is shared with other sessions, so dirtying
`status.md` here would race them. The fixture copies the gate's own
**transitive import closure, computed from the source** (static `from` and
dynamic `import()`), so adding an import cannot silently leave it broken.

---

## 7. Follow-ups (not actioned here)

1. **`repoRoot` is passed and ignored.** `scripts/check-status-log-integrity.mjs:167 (36dc4ca6)`
   calls `resolver({ repoRoot: REPO })`, but `resolvePushRange` destructures
   only `env`, `run`, `defaultBranch` (`scripts/lib/push-range.mjs:88-92 (36dc4ca6)`),
   and `defaultRun` runs `git` with no `cwd` (`scripts/lib/push-range.mjs:52-55 (36dc4ca6)`).
   Benign today — the gate is invoked via `npm` from the repo root — but the
   call site states an intent the callee does not honour. **Not the cause of
   anything reported here.**
2. **Force-push coverage.** The union-over-pushes argument in §6 assumes
   append-only branch history. A history-rewriting force-push leaves a hole no
   per-push check covers. Measuring whether that has ever happened on a branch
   carrying status-log changes is the prerequisite for acting.
3. **`check-plan-status.mjs:62`** uses the resolved range without checking
   `range.trusted`, where the sibling path at line 81-82 does. On an empty
   range it would select zero changed plans — the same proxy-vs-real-condition
   shape as this fix, one hop over. Flagged as an **unverified observation**:
   not measured, and in a synced file, so it belongs in an upstream-shaped
   review of its own.
4. **No gate records its own invocations** (§3a). If the empty-range state is
   ever suspected again, the missing instrument is a per-invocation record of
   the resolved base `source` and the verdict. Not worth building for one gate.
5. **One clause in `verification-discipline.md` §4a** — that its `now()` test
   applies to a **single read used as a prevalence claim**, not only to a delta
   between two reads (§3f). This is the whole remaining candidate; the new rule
   the first draft proposed is withdrawn. Deliberately not done here: that file
   syncs into **ten** skills' `references/` and reaches consumers, so it is a
   distribution decision, and §3f is one case of an existing rule rather than a
   new one. **Retirement predicate**: if no second case of the *single-read*
   form appears, §3f stays a research note and this item is dropped — not
   carried indefinitely.

   **Near-miss analysis, so the comparison need not be rediscovered.** #348's
   standing-queue finding (`e94d2deb`) was proposed as the second case and
   **rejected** — it is the incident that produced §4a, so it cannot also be
   the second case for a rule derived from §4a. On the substance the two are
   one rule with two faces, and the distinction is worth keeping: in #348 the
   instrument reads a **true number about a population that rotated underneath
   it** (two reads, disjoint cohorts); here the instrument **cannot see the
   state at all** at the moment it samples (one read, a false zero). Both are
   answered by *"what is your count structurally tied to?"*, which is why one
   clause is the right size of change and a parallel rule is not.

### Considered and NOT opened as findings

- **The ordering of `guards:preflight` vs the ship's own commit.** Raised as a
  possibility while reproducing §3d-bis ("the problem is as much *when* the
  gate runs as *what base* it defaults to"), and checked: it is not an
  independent defect. The uncommitted entry is the right subject for a
  pre-commit check, and the gate measures correctly both before the commit
  (against the working tree) and after it (against the range). Both orderings
  now yield a real answer, so there is nothing a reordering would fix. Recorded
  here so it is visibly closed rather than silently dropped.
