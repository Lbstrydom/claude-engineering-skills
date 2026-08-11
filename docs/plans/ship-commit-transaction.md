# Plan: A transactional commit boundary for `ship-commit`

- **Date**: 2026-08-11 (updated 2026-08-11 after `worktree-identity-guards` shipped;
  §2 Phase 1 answered same day — see §2.1)
- **Status**: Draft — not started; trigger-gated; Phase 1 answered in §2.1 and the cost widened
- **Author**: Claude + Louis
- **Scope**: backend (one CLI binary + its consumer-synced copy; no UI)

> **Promoted out of [`worktree-identity-guards.md`](worktree-identity-guards.md),
> not invented here.** That plan shipped *detection* of a moved base; this one
> owns *prevention*. It was raised six times across two audit loops and an
> independent gate, and kept as documented debt each time — which is exactly how
> a known hole becomes permanent. It has its own plan so the decision is
> revisitable instead of buried in a bullet.
>
> **Parent is now Complete** (all three clusters shipped 2026-08-11, consolidated
> gate APPROVE). Everything below is written against the code as it actually
> landed, with `file:line` pinned to `f6caab93`.

---

## 1. The gap, stated precisely

`scripts/ship-commit.mjs` verifies worktree identity (guard B) and then calls
`git commit`. Those are two operations. Between them a concurrent session can
amend, rebase or check out, and the resulting commit is built on a base nobody
checked.

What exists today is **post-commit verification**
([`scripts/ship-commit.mjs:698`](../../scripts/ship-commit.mjs), `f6caab93`):
after the commit it compares `HEAD^` and the current branch against the verified
identity, exits 1 on `post-commit-drift`, prints a recovery command, and `/ship`
must not push. That is honest and it is named honestly — the code and the skill
prose both say it DETECTS rather than prevents.

**What it buys.** The field incident escaped because it was **pushed**. A
detected, unpushed, wrong-parent commit is recoverable in seconds; the pushed one
needed a human to notice a 12-line change carrying a −2,324-line diff.

**What it does not buy.** Prevention. The commit exists before anyone knows it is
wrong, and a direct caller of the CLI — a versioned surface synced into consumer
repos this repo cannot observe — is not bound by `/ship`'s "do not push" step.

**What is already closed, and stays out of scope.** Guard A removed the
unscoped-commit mode entirely, so there is no path where `ship-commit` consumes
an index it did not declare. This plan is only about the **ref**.

## 2. The fix, and why it is not free

Git offers a real CAS:

```
GIT_INDEX_FILE=<private>  git read-tree HEAD
GIT_INDEX_FILE=<private>  git add -- <declared paths>
GIT_INDEX_FILE=<private>  git write-tree            → <tree>
git commit-tree <tree> -p <expected-old> -F <msg>   → <new>
git update-ref refs/heads/<branch> <new> <expected-old>
```

`update-ref` with an expected-old value is atomic and git guarantees it: if the
ref moved, the update fails and no branch advances.

### Half of this is already built and in production

[`scripts/ship-commit.mjs:434-447`](../../scripts/ship-commit.mjs) (`f6caab93`)
already constructs exactly that private-index tree — `read-tree HEAD` → `add --
<paths>` → `write-tree`, with `GIT_INDEX_FILE` pointed at a temp file under
`.git/` and cleaned up in a `finally`. It was added for a different reason (to
compute `committedTree` for the `AI-Gate: passed` comparison once guard A made
`--path` mandatory), but it is the same object construction this plan needs, and
it has been exercised on every commit since.

**So the unbuilt part is narrower than it looks**: commit *from* that tree with
`commit-tree` + `update-ref`, instead of re-running `git commit`.

### The blocking question — Phase 1 answers this, and only this

**`commit-tree` does not run hooks.** `ship-commit.mjs` explicitly contemplates a
`commit-msg` hook or clean filter rewriting the message after it writes — it
re-parses the persisted message precisely because that can happen. Switching to
`commit-tree` would silently skip such a hook in a **consumer** repo, and this
repo cannot observe consumer hooks.

**Measured 2026-08-11 (`f6caab93`): this repo has no `pre-commit` and no
`commit-msg` hook** — `.githooks/` holds only `post-checkout` and `pre-push`. So
the approach is feasible *here*. That is not evidence about consumers — and the
consumers have now been measured (§2.1), which is where the cost actually lives.

Second cost: `--no-tests` works by passing `--no-verify` to `git commit`. Under
`commit-tree` there is no hook to bypass, so the flag becomes meaningless and its
documented escape-hatch rationale needs re-expressing rather than deleting — a
gate with no sanctioned override manufactures gate-tampering, which is why that
flag exists at all.

**Options to evaluate, cheapest first:**

1. **Invoke the hooks explicitly** around `commit-tree`. `core.hooksPath` is
   discoverable and `pre-commit`/`commit-msg` have defined contracts. Restores
   parity, at the cost of reimplementing a piece of git — and of owning its edge
   cases (hook exit codes, message rewriting, `--no-verify` semantics) forever.
2. **Detect hooks and branch**: transaction when none are configured, today's
   detect-and-report when they are. Honest, but a guard that silently weakens
   based on repo configuration **must announce which mode it took** — an
   unannounced downgrade is the fake-check shape this repo already polices.
3. **Ask the consumers.** ~~Two repos, one question: do you have `pre-commit` or
   `commit-msg` hooks?~~ **DONE 2026-08-11 — and not by asking: both checkouts
   were read directly off this machine, which is stronger than a recollection and
   weaker than a durable fact (§2.1). One of the two has a live `pre-commit`.**
   The hypothesis attached to this option ("if both say no, option 1's cost may
   simply not be owed yet, and option 2 becomes a two-line guard") is
   **falsified**.

### 2.1 Phase 1 answer — the consumer hook census (measured 2026-08-11)

Read directly off the two consumer checkouts on this machine at this repo's
`d57fe3c8`. **This is untracked machine state, not a committed fact**:
`.git/hooks/` is never tracked, so a re-read on another machine — or here next
month — can differ. Carry the command, not the conclusion:

```bash
for r in C:/GIT/wine-cellar-app C:/GIT/ai-organiser; do git -C "$r" config --get core.hooksPath; ls -1 "$(git -C "$r" rev-parse --git-path hooks)"; done
```

| Repo | `core.hooksPath` | active `pre-commit` | active `commit-msg` |
|---|---|---|---|
| `wine-cellar-app` | `.git/hooks` | **YES** | no |
| `ai-organiser` | `.git/hooks` (unset) | no | no |
| this repo | `.githooks` | no | no |

`wine-cellar-app`'s `.git/hooks/pre-commit` (682 bytes, mtime 2026-07-19) runs
`npx eslint` over the staged `src/*.js` + `public/js/*.js` and **exits 1 on lint
failure**. A real gate, not a no-op. `ai-organiser` carries a `.githooks/post-commit`
that is inert (its `core.hooksPath` is unset, so `.git/hooks/` wins) and would be
irrelevant here regardless — `post-commit` is best-effort and `commit-tree` skips
it either way.

**And that hook demonstrably fires under the exact call `ship-commit` makes.**
Not inferred — replicated. scripts/ship-commit.mjs:685-688 (d57fe3c8) issues
`git commit -F <msg> --cleanup=whitespace -- <paths>`; the same shape against a
throwaway fixture repo with instrumented hooks emits:

```
HOOK-RAN pre-commit
HOOK-SEES-STAGED: a.txt          # exactly the declared --path set, nothing else
HOOK-GIT_INDEX_FILE=…/.git/next-index-98244.lock
HOOK-RAN commit-msg on .git/COMMIT_EDITMSG
```

So under `--only`, git hands `pre-commit` a temp index containing precisely the
paths being committed, and `commit-msg` runs too. **Every `ship-commit` run in
`wine-cellar-app` is today lint-gated on exactly the files it commits, and
`commit-tree` would silently delete that gate** — in the one consumer whose hooks
had never been checked.

**What this does to the fork.** Option 1's cost is owed in full and permanently,
for a trigger that has not fired. Option 2 survives but is **not** the two-line
guard it was hoped to be: `wine-cellar-app` would take the *weakened* branch on
every commit, so the announced-downgrade requirement becomes load-bearing rather
than decorative — and the consumer carrying the drift risk is the one that would
not get the transaction. The measurement makes this work **more** expensive than
§2 assumed, which is why the posture in §3 stands unchanged.

**Rejected on sight:** commit normally, then `update-ref` the branch back on a
wrong parent. That is a destructive rewrite in a shared worktree — the exact
action the parent plan forbids and the reason its post-commit path deliberately
does not auto-reset.

## 3. Trigger to prioritise

Not speculative work. Start when either fires:

- **any consumer report of a `post-commit-drift`** that the current verification
  caught — that is detection paying for itself and saying prevention is wanted; or
- **the first `commit-msg` or `pre-commit` hook landing in this repo**, at which
  point option 1's cost must be paid explicitly either way.

**Neither has fired, checked 2026-08-11 at `d57fe3c8`:**

- `npm run upstream:issues` → `No open upstream issues.` No consumer has reported
  a `post-commit-drift`.
- This repo's `core.hooksPath` is `.githooks`, which holds only `post-checkout`
  and `pre-push` — no commit-time hook. (`.git/hooks/` carries stale
  `post-checkout`/`post-merge`/`pre-push` copies; `core.hooksPath` makes them
  inert, and none are commit-time in any case.)

Note the second arm is about **this** repo by design. The §2.1 census found a
`pre-commit` hook in a *consumer*, which is not a trigger — it is the opposite:
evidence that the fix costs more, not that it is now due.

Until one fires the honest posture is: the window is narrowed to a process-spawn,
the failure is detected and loudly reported, and the push is blocked.

## 4. Out of scope

- **Anything about the INDEX.** Guard A closed it (§1).
- **Re-litigating detection.** Post-commit verification stays regardless; a
  transaction makes it redundant for the *ref*, not for the trailer parse-back,
  which guards against a hook rewriting the message.
- **The `--path` / identity-bundle contract.** Settled and shipped; this plan
  changes how a commit is *created*, not what it is *allowed* to contain.

## 5. Acceptance

The transaction is done when a test **moves the ref between verification and
commit** and asserts that **no commit object is referenced and no branch
advances** — the prevention claim, not a narrower detection one. Detection is
already asserted; re-asserting it would be a vacuous pass.

The harness exists: [`tests/ship-commit-worktree-identity.test.mjs`](../../tests/ship-commit-worktree-identity.test.mjs)
(`f6caab93`, 11 tests) already drives the real CLI against real repos and pins
guard A and guard B refusals by exit code. The new case belongs there.

**Two properties the acceptance test must have**, both learned the hard way while
shipping the parent:

- **Assert the outcome, not a log line.** An earlier draft of guard B emitted a
  diagnostic and continued, which reads as protection while providing none.
- **Isolate the gate under test.** Guard B runs before guard A, so a fixture with
  a real HEAD refuses on `no-expectation` and a recipe can go green having proven
  the *wrong* gate fires. The guard-A `cli-exit` recipe needed an unborn HEAD for
  exactly this reason — see the note in
  [`scripts/lib/gate-honesty/oracles.mjs`](../../scripts/lib/gate-honesty/oracles.mjs).

## 6. What the parent plan's run suggests about scope

Two data points worth carrying in, both from the `worktree-identity-guards`
execution rather than from theory:

- **The migrated legacy suites caught a regression the new tests could not.**
  Guard A made `--path` mandatory, which made `AI-Gate: passed` structurally
  unreachable — invisible to the new tests, obvious to the old ones. Whatever
  this plan changes about commit creation, the three `ship-commit-*` suites are
  the detector, not an afterthought.
- **A stricter pure boundary can add a crash path to a best-effort caller.**
  Making `buildGateEvidence` throw on a malformed branch quietly gave
  `writeGateEvidence` — telemetry that must never fail an audit — a way to die.
  `commit-tree` replaces a call that currently fails softly in several places;
  check each caller's failure contract rather than assuming the exit code is the
  whole interface.
