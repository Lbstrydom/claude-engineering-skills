# Gitignore policy — what is ignored, and why

> **The question this file answers**: *this repo is public; some of what it
> produces must never be. How do we keep that private without losing it?*
>
> Ignoring a path is easy. The failure is what happens next: a path is ignored
> because it is private, everyone assumes it lives somewhere durable, and nobody
> ever checks. Measured on 2026-09-04, that assumption cost **37 tech-debt
> entries existing on exactly one laptop and nowhere else** — HIGH and MEDIUM
> findings, some five months old, one command away from being lost with the
> disk. The module that owned them *documented* the local file as "the durable,
> human-approved state" while `.gitignore` had ignored it all along.
>
> So: an ignored path must declare **which kind of thing it is**, and a private
> one must name **where it durably lives instead**.

## The three categories

AGENTS.md's generated-artifact policy already names two. Both are about
*generated* files, and neither can describe a file that is neither generated nor
publishable — which is exactly the class that went missing.

| | **A — derived / volatile** | **B — committed + verified** | **P — private + load-bearing** |
|---|---|---|---|
| What it is | a function of external or mutable state, or carrying volatile provenance (timestamps, HEAD shas) | a pure, deterministic function of committed source | genuine, non-regenerable state that must never be public |
| Tracked? | no | **yes** | no |
| If it is lost | regenerate it; costs a command | cannot be lost; it is committed | **the information is gone** |
| Obligation | none | a freshness check in `npm run check` | **must declare a durable home** |
| Example | `.audit-loop/domain-deps-observed.json` | `.claude/skills/**` | `.audit/tech-debt.json` |

**P is the category this document exists to add.** A and B both have an escape
hatch — regenerate, or read the committed copy. P has neither, so it carries an
obligation instead: *say where the durable copy lives.* A `P` rule that cannot
answer that is not private-and-safe, it is one disk failure from being gone.

## The declaration, in `.gitignore` itself

Categories are declared in the comment block above each rule, not in a sidecar.
A sidecar would be a second source of truth that drifts from the rules it
describes, which is the failure `docs/plans/standing-queue-burndown.md` §0
rejects for the same reason. The file already used this convention informally —
12 rules said "Category A" in prose before any of this was enforced.

### Grammar

- A **comment block** is a run of consecutive `#` lines. It binds **downward**
  to the **rule group** beneath it: the contiguous run of non-blank,
  non-comment lines ending at the next blank line or comment block.
- A **negation** (`!pattern`) is an ordinary member of its rule group. A
  negation appearing first in a group is an error — it narrows nothing.
- The block must contain `Category: A`, `Category: B`, or `Category: P`.
- A `P` block must additionally contain:
  - `Durable home:` — where the recoverable content actually lives.
  - `Recoverable:` — what can be reconstructed from that home. **Must be
    non-empty.**
  - `Disposable:` — what is knowingly *not* recoverable. May be `none`, but must
    be stated rather than left implicit.

`npm run gitignore:policy:gate` enforces this, drift-only against a committed
baseline so the existing rules do not fail the first push.

### Why `P` must state a disposable half

Honesty about scope is the whole point. `.audit/` is one broad rule over a
directory holding many different things, and claiming all of it is recoverable
would be exactly the over-claim this policy exists to prevent. The truthful
statement is narrower:

- **Recoverable** — debt entries and events (`debt_entries` / `debt_events`),
  findings and runs (`audit_findings` / `audit_runs`), all in the private store.
- **Disposable** — per-run transcripts, `*-stderr.log`, `*-diff.patch`, round
  result JSONs, the session cache. Losing these costs a re-run, not a fact.
- **`.audit/write-spill/` is disposable, and it is the sharpest case.** A spill
  artifact exists *precisely because* the remote write did not land, so until
  the drain succeeds it is a **sole local copy with nothing to restore it
  from**. Certifying it as recoverable would be false in the one state it exists
  to represent. It is instead an accepted, bounded loss window — the price of
  not blocking work on a store outage — and `npm run debt:reconcile` reports the
  count of undrained artifacts so the window is visible rather than assumed
  empty.

## The `P` rules in this repo

| Rule | Durable home | If the home is unreachable |
|---|---|---|
| `.audit/` | private Postgres (`debt_entries`, `debt_events`, `audit_findings`, `audit_runs`); reconcile with `npm run debt:reconcile` | new entries spill to `.audit/write-spill/` and are replayed by the drain |
| `scripts/lib/consumer-repos.local.json` | the operator's own machine; `consumer-repos.local.example.json` documents the shape | re-enter by hand — it names a private repo and must never be public |
| `scripts/lib/runner-hosts.local.json` | same | same |
| `docs/upstream-issues/` | the private store's upstream queue (`npm run upstream:issues`) | the report was filed via `cross-skill.mjs upstream report`; the markdown is a convenience copy |
| `docs/personal/` | the author's own records | not recoverable from this repo, deliberately |
| `.audit-loop/solo-control/` | the private store's arm-eval tables | the unblind map is deliberately local-only |

## Reading this before adding an ignore rule

Ask, in order:

1. **Can I regenerate it from committed source?** → **A**. Ignore it, done.
2. **Is it a pure function of committed source that others should read?** →
   **B**. Commit it and add a freshness check.
3. **Neither?** → **P**, and you owe the three tokens. If you cannot name a
   durable home, you have found a real problem: the thing you are about to
   ignore has nowhere to live. Fix that first.

The third branch is the one that matters. It is not paperwork — it is the
question nobody asked about `.audit/tech-debt.json` for five months.
