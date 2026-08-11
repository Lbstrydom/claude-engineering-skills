# Plan: A transactional commit boundary for `ship-commit`

- **Date**: 2026-08-11
- **Status**: Draft
- **Author**: Claude + Louis
- **Scope**: backend (one CLI binary + its consumer-synced copy; no UI)

> **Promoted out of [`worktree-identity-guards.md`](worktree-identity-guards.md),
> not invented here.** That plan ships *detection* of a moved base; this one owns
> *prevention*. It was raised six times across two audit loops and an independent
> gate, and kept as documented debt each time — which is exactly how a known hole
> becomes permanent. It gets its own plan so the decision is revisitable instead
> of buried in a bullet.

---

## 1. The gap, stated precisely

`scripts/ship-commit.mjs` verifies worktree identity (guard B) and then calls
`git commit`. Those are two operations. Between them a concurrent session can
amend, rebase or check out, and the resulting commit is built on a base nobody
checked.

What exists today is a **post-commit verification**: after the commit, the CLI
compares `HEAD^` and the current branch against the identity it verified, exits 1
on mismatch, prints a recovery command, and `/ship` must not push. That is
honest and it was named honestly — it is *not* a compare-and-swap, and the code
and skill prose both say so.

**What it buys**: the field incident escaped because it was **pushed**. A
detected, unpushed, wrong-parent commit is recoverable in seconds; the pushed one
needed a human to notice a 12-line change carrying a −2,324-line diff.

**What it does not buy**: prevention. The commit exists before anyone knows it is
wrong, and a direct caller of the CLI — a versioned surface synced into consumer
repos this repo cannot observe — is not bound by `/ship`'s "do not push" step.

## 2. The fix, and why it is not free

Git *does* offer a real CAS. The sequence:

```
GIT_INDEX_FILE=<private>  git read-tree HEAD
GIT_INDEX_FILE=<private>  git add -- <declared paths>
GIT_INDEX_FILE=<private>  git write-tree            → <tree>
git commit-tree <tree> -p <expected-old> -F <msg>   → <new>
git update-ref refs/heads/<branch> <new> <expected-old>
```

`update-ref` with an expected-old value is atomic and git guarantees it: if the
ref moved, the update fails and no branch is advanced.

**Half of this already exists.** `ship-commit` builds exactly that private-index
tree today to compute `committedTree` for the `AI-Gate: passed` comparison
(worktree-identity-guards, cluster B). So the tree construction is proven; what
is unbuilt is committing *from* it rather than re-running `git commit`.

### The blocking question — settle this first

**`commit-tree` does not run hooks.** `scripts/ship-commit.mjs` explicitly
contemplates a `commit-msg` hook or clean filter rewriting the message after it
writes — it re-parses the persisted message precisely because that can happen.
Switching to `commit-tree` would silently skip such a hook in a **consumer** repo,
and this repo cannot observe consumer hooks.

Measured 2026-08-11: **this repo has no `pre-commit` hook** (`.githooks/` holds
only `post-checkout` and `pre-push`), so the approach is feasible *here*. That is
not evidence about consumers.

Second cost: `--no-tests` works by passing `--no-verify` to `git commit`. Under
`commit-tree` there is no hook to bypass, so the flag becomes meaningless and its
documented escape-hatch rationale would need re-expressing.

**Phase 1 is answering that question, not writing the transaction.** Options to
evaluate, cheapest first:

1. **Invoke the hooks explicitly** around `commit-tree` (`core.hooksPath` is
   discoverable; `commit-msg` and `pre-commit` have defined contracts). Restores
   parity, at the cost of reimplementing a piece of git.
2. **Keep `git commit`, add the CAS afterwards** — commit normally, then
   `update-ref` the branch back if the parent is wrong. Rejected on sight: that
   is a destructive rewrite in a shared worktree, the exact action the parent
   plan forbids.
3. **Transaction only when no hooks are configured**, falling back to today's
   detect-and-report otherwise. Honest, but a guard that silently weakens based
   on repo configuration needs to *announce* which mode it took.

## 3. Trigger to prioritise

Not speculative work. Start it when either fires:

- any consumer report of a wrong-parent commit that the post-commit verification
  caught — that is the detection paying for itself and saying prevention is
  wanted; or
- the first `commit-msg` hook landing in **this** repo, at which point the
  hook-invocation cost must be paid explicitly either way.

## 4. Out of scope

- **Anything about the INDEX.** Guard A already removed the unscoped-commit mode,
  so there is no path where `ship-commit` consumes an index it did not declare.
  This plan is only about the ref.
- **Re-litigating detection.** The post-commit verification stays regardless; a
  transaction makes it redundant for the ref, not for the trailer parse-back.

## 5. Acceptance

The transaction is done when a test **moves the ref between verification and
commit** and asserts that no commit is created and no branch advances — the
prevention claim, not a narrower detection one. The existing barrier-harness in
[`tests/ship-commit-worktree-identity.test.mjs`](../../tests/ship-commit-worktree-identity.test.mjs)
is the place to put it.
