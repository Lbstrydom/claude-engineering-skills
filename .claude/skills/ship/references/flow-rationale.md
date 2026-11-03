---
summary: Why /ship's own flow is shaped as it is — the explicit-invocation bar, numbering, and Steps 0.5b-6.8 rationale.
---

# /ship flow rationale — moved out of SKILL.md

`SKILL.md` keeps each rule in one line at the step that applies it. This file
carries the reasoning and history those lines were cut from, verbatim. Read a
section when its step's one-liner points here.

## Explicit invocation

> **Explicit invocation only — this is a host-neutral requirement, not just a
> frontmatter flag.** `disable-model-invocation: true` above enforces it in
> Claude Code, and **also in VS Code Copilot**, which reads `.claude/skills/`
> and honours that exact key (it is a documented Copilot frontmatter field, not
> a Claude-only one — verified against VS Code's Agent Skills docs 2026-09-02).
> Hosts outside those two are not guaranteed to, and a frontmatter key cannot
> explain *why* anyway, so the rule is stated here too, where every host reads
> it:
>
> Why the bar is here and not on the individual steps: every step below skips
> confirmation deliberately, and the thing that makes that safe is the user
> having chosen to run this. Self-invoke and the approval those steps rely on
> was never given — the skill would be citing its own execution as consent.
> A push to a shared branch is also the least reversible action in this
> bundle, and in this repo the working tree is shared with concurrent
> sessions.

## 0.5b — the /ux-lock card's React caveat

The card's UI/DOM line originally read:

```
  UI/DOM-facing fix → /ux-lock. Note it has a documented bad record on React
  surfaces (wine-cellar-app 2026-07: generated specs proved brittle, several
  reverted, root cause undiagnosed) — prefer a unit test there too unless the
  contract genuinely needs a live DOM.
```

## 0.5e — paging and closing rows

To read past the default 20-row page, pass the payload's `nextCursor` back as `--after` — a
keyset cursor, so closing rows between reads neither repeats nor skips one
(`--offset` counts positions in a set your closes just shrank, so it skips one
unread row per row closed). `nextCursor: null` is the end.

`final-review-record-fix` only resolves final-review-pass rows and so
answers `no-match` for an ordinary audit finding (all 142 rows of one queue,
2026-10-02).

## 0.5f — numbering note

> **Numbering note**: this sub-step is `0.5f`, not `0.5d`, because two H2
> sections below already claim `Step 0.5c` and `Step 0.5d` (a pre-existing
> collision referenced from ~20 other files, so renumbering them is out of
> scope here). The H3 sub-step order is `0.5a → 0.5b → 0.5e → 0.5g → 0.5h → 0.5i → 0.5f`.

## Step 2 — where the pending notes live

The command resolves the MAIN checkout itself — `.claude/tmp/` is per-worktree
and Step 6.8 deliberately writes to the durable one (a worktree is routinely
deleted at session end, taking the note with it). The notes are gitignored
scratch state (same directory the commit-message file uses), so they survive a
session boundary but never ship as-is.

## Step 2b — why the backlog line is pasted, not written

Never let a script write `status.md`: PR #87
destroyed 19,257 lines of it that way.

A queue it could not read renders **`unmeasured`**, never `0`. That distinction
is the point — `0` reads as good news, and an unasked question is not good news.

## Step 4 — history

(This step used to say "mirror exactly"; that was a landmine — removed.)

## Step 5.5 — plans no longer move on completion

**There is no archive step.** Plans live in `docs/plans/` for their whole
lifecycle; a completed plan simply carries `Status: Complete`. The
`docs/plans/` → `docs/completed/` archiver was deleted by
`docs/plans/reference-integrity-gate.md` Cluster C — moving a completed plan
silently broke every reference to it (the failure that plan exists to kill).
Status is metadata, never a path; the dashboard rebuild at Step 0.5d is
sufficient (no post-archive rebuild is needed because nothing moves).

*(The dashboard's Plans tab historically bucketed by directory; bucketing by
`Status:` instead is a small follow-up, tracked separately — out of this
plan's scope.)*

## Step 5.8 — why the staleness check exists

A long `/cycle --autonomous` run — many audit rounds, multiple clusters — can
take long enough for a **different** PR to merge to the default branch first,
touching files this run also touched. What that produces downstream is
confusing rather than obvious: `gh pr create` reports `mergeable:
CONFLICTING`, and GitHub can additionally skip dispatching a `pull_request`
CI run for it entirely — reading exactly like a CI-infrastructure flake (a
self-hosted runner not picking up the job) and costing real diagnostic time
before anyone checks mergeability and finds a plain merge conflict
underneath. Catch it here instead.

If a rebase or merge resolves real overlap, re-run the full test suite
before continuing to Step 6 — a clean 3-way merge with zero conflict markers
is not proof of correctness. git's own auto-merge can fold two independent
additions of the same import line and the same component mount into one
file with no conflict markers at all, producing a real duplicate-render bug
that only a type-check or test failure catches. This applies to any merge
touching files a `/cycle` run modified, not only the ones flagged with
visible conflicts.

## Step 6.0 — the source repo's sync manifest

The source repo's `scripts/.sync-manifest.json` is **gitignored** (it's
regenerated on every `npm run sync` — which the pre-push hook runs only when
the push updates the default branch — and carries
volatile provenance — a timestamp + HEAD sha — so committing it is pure churn;
Category A per the generated-artifact policy). **Do not `git add` it.** The
pre-push sync regenerates it on disk for readers; it is never committed here.

Consumers are unaffected: they track their **own** manifest (synced + eol-pinned
via `.gitattributes`; the isolation verifier needs it). The source `.gitignore`
entry is source-only and does not propagate to the consumer managed block.

## Step 6.8 — why the synced bundle is verified only in the MAIN checkout

A linked worktree cannot answer this, and since 2026-09-07 it SAYS so: `runGates` refuses a proven linked worktree at `preflight` with exit 2. The manifest records what the last sync wrote to the MAIN checkout's disk, and `skills:hydrate` populates a worktree by copying those same files — so a run there would re-read bytes hydrate just copied and report agreement it manufactured. Hydrate now carries the manifest as well as the tooling tree (upstream 5bc7ff30), so that refusal is explicit rather than the accident of a missing file.
