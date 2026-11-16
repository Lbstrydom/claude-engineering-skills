---
summary: Closing a decision and reading its effect — enforce/reject, tripwire retirement, activation, the verdicts.
---

# Closing a decision, and reading its effect

## `enforce` — in the fix PR, after the human said yes

```bash
node scripts/harness-retro.mjs enforce --identity <fingerprint:fp|tripwire:name> --scan latest --test tests/<x>.test.mjs --layer <hook|gate|script|reference-doc|agents-md> --summary "<public one-liner>"
```

Order, every step idempotent (re-running finishes an interrupted run):

1. **Preflight** — writes nothing unless every input is valid: the identity is a
   candidate of the scan, the test is a `tests/*.test.mjs` file `npm test`
   collects, declares an `it()`/`test()` case and names the identity in a string
   literal, and the summary carries no path, email or secret (the registry is
   PUBLIC).
2. **Registry** — appended to `.harness-retro/decisions.json` under its own lock,
   with every evidence fingerprint. No commit sha: a commit cannot name itself.
3. **Tripwire retirement** (`tripwire:` identities) — the memory file gets
   `metadata.enforced_by`; its `MEMORY.md` line moves to `index-enforced.md`
   when it is the line's only link. A line shared with other tripwires is never
   rewritten: `status` reports `needs-manual-reflow` for you to reflow by hand.
4. **Friction mirror** — a `type: friction` memory is also closed through
   `frictionLink`, so `memory_friction.resolved` flips.

`status` reports any half-done retirement in both directions.

`reject --identity … --scan latest --summary "…"` records a "no": the identity
is then shown as `previouslyRejected` and never re-ranked.

## Activation — when did the enforcement go live?

Derived, never typed: the first-parent commit on `origin/main` that introduced
the identity into the registry. Accepted only from a landing-time source — a
commit GitHub itself created (squash/merge, `noreply@github.com`) or the PR's
`merged_at` via `gh`. A locally created commit's date is when it was written,
not when it landed, so without one of those sources the result is
`activation-unknown`.

## `effect` verdicts

| Verdict | Meaning |
|---|---|
| `reduced` | ≥3 sessions hit before, and the after-rate is ≤ half the before-rate |
| `unchanged` | neither reduced nor regressed |
| `regressed` | the after-rate is higher, with ≥3 hits after |
| `pending` | the after-window (default 14 days) has not elapsed |
| `pending-merge` | the registry entry is not on `origin/main` yet |
| `unmeasured` | activation unknown, no account with completed scans covering both windows, a window under 10 sessions, or a fingerprint-version change — the reason says which |

Windows are equal length and the population is restricted to accounts whose
completed scans cover both, so the figure cannot drift with `now()`. Cloud off,
the same function runs over the local scan artifacts (`source: local-scan`) —
limited to transcripts that were still on disk when scanned.

`unmeasured` is not "no effect". Run `scan --persist` regularly so the windows
are covered.
