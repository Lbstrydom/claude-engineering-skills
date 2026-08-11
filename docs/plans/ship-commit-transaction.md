# Plan: A transactional commit boundary for `ship-commit`

- **Date**: 2026-08-11 (updated 2026-08-11 after `worktree-identity-guards` shipped)
- **Status**: Draft — not started; trigger-gated (see §3)
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
the approach is feasible *here*. That is not evidence about consumers, and the
two known consumers are exactly the repos whose hooks nobody here can enumerate.

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
3. **Ask the consumers.** Two repos, one question: do you have `pre-commit` or
   `commit-msg` hooks? If both say no, option 1's cost may simply not be owed
   yet, and option 2 becomes a two-line guard rather than a design.

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

Until then the honest posture is: the window is narrowed to a process-spawn, the
failure is detected and loudly reported, and the push is blocked.

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
