# Plan: Consumer pre-push hook: bounded, visible, fail-closed steps (hook v11)
- **Date**: 2026-10-23
- **Status**: Complete — shipped in #284 (status reconciled against merged PRs 2026-10-25)
- **Author**: Claude + Louis
- **Scope**: backend (git hooks, CLI scripts) — stack `js-ts` + POSIX shell

## 1. Context Summary

**Incident (storyline, 2026-10-18, 10-22 on #411, 10-23 on #417 and #418).** The synced consumer pre-push hook hung four
times. Workers killed it and pushed with `AUDIT_PREPUSH_DISABLE=1`, so the gate was effectively off. A gate that hangs gets
bypassed. Fleet proposal `p-20261022124230-a709`, upstream report `07bcc90f`.

**Measured on the fourth hang** (a push of a MERGE commit, main merged into the branch), replayed from the storyline worktree:

1. `base..head` (remote tip .. merge) holds the whole of main's delta, including storyline's `template-led-visual-upgrade` plan (a file of that repo, not this one)
   (149 KB). `check-plan-status.mjs --select` read it as "the plan this push changed" and selected it.
2. The audit ran `openai-audit.mjs code <plan> --scope diff` with no `--base`: the default is `HEAD~1`, and on a merge commit
   `HEAD~1..HEAD` is main's delta again. It audited code the branch never wrote.
3. The audit's output went to `/tmp/prepush-audit-$$.json` with no clock: nothing printed, so a slow audit looked like a hang.

**The "nested machine lease" theory is NOT confirmed.** The hook (v7 installed, v10 on main) contains no fleet or lease call, and the
reporting lane withdrew the guess ("my own unconfirmed guess"). So there is nothing to make reentrant. What is true, and tested:
a held lease — the pushing session's or another's — never makes the hook wait, and a timeout names the holder. If a real nested
acquire surfaces (a `fleet lease run` under the same identity is refused as `held`), that is a separate defect with its own repro.

## 2. Design (the smallest thing that is a true function of the problem)

Band-aid rejected: a single `timeout` around the whole hook (kills the push it protects; names nothing). Over-built rejected:
a hook-wide lease protocol nothing acquires.

1. **`lib/prepush-step.mjs` + `scripts/prepush-step.mjs`** — `run --step --budget-sec -- cmd`: wall-clock budget, heartbeat on stderr,
   the step's process TREE killed on expiry (`runChild`), exit 124 plus a refusal naming step, elapsed, budget and the lease holder
   (`describeLeaseHolder`, read-only; unreadable is "unknown", never "free"). `own-files` prints the branch-own scope line.
2. **`push-range.mjs branchOwnedChangedFiles`** — given the range `resolvePushRange` produced (no base re-inferred), the branch's
   own files are the non-merge commits in the range that the default branch lacks. It only ever narrows when it can prove it; every
   uncertainty returns the whole diff, `scoped:false`. Used by plan selection and the drift gate.
3. **Hook v11** — every node step goes through the runner (plan-status probe/drift/selection, code audit, surfaces check); one
   `▸ step` line each. A merge push audits `--files <own files>`; one that owns nothing skips the audit and says so. A non-merge
   push keeps `--scope diff`. 124 refuses the push whatever `AUDIT_PREPUSH_BLOCK` says; other audit failures stay non-blocking.
   A missing runner refuses. The `fail-closed-on-signal` block is untouched (byte-identical, pinned by its own test).

## 3. Acceptance

- Tests (Tier 3, same commit): `tests/prepush-hook-bounded-steps.test.mjs` — a hanging audit is killed with its child and the push
  refused with step/elapsed/holder; a held lease never delays the hook; merge push audits only branch-own files; pure-merge skips;
  non-merge unchanged; selector on a real merge; every "never narrow when unsure" branch.
- Consumers must re-install after the sync: `npm run hooks:install -- --target <name>`.

## 4. Stated limits

A path changed only by a merge's conflict resolution is not branch-owned here. Own commits that change no file make the scope
undecidable, so the whole diff is kept. The default budget (600 s) is a guess; it is an env var, not a measurement.
