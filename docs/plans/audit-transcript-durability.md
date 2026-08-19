# Plan: Audit-Transcript Durability Across Worktree Teardown

- **Date**: 2026-08-18
- **Status**: Complete — mirror-at-write + filesystem sweep backstop shipped
  with `tests/audit-transcript-durability.test.mjs` (acceptance test, negative
  control, and the registry-blindness case). Retention is deliberately deferred
  with a named revisit trigger (§6).
- **Scope**: transcripts only. Deliberately NOT a redirect of `.audit/` — see §3.2.
- **Audit trail**: GPT code-audit R1 (H:4 M:11 L:2) → R2 (H:4 M:3) → R3 (H:0 M:3)
  → R4 (H:2, one REOPEN) → R5 (H:1 M:3) → R6 (H:1 M:1), stopped at the 6-round
  cap. 35 findings ruled: 21 accepted, 2 severity-adjusted, 10 dismissed,
  2 deferred. Gemini final gate: **APPROVE**, 0 new findings, 0 wrongly
  dismissed, 0 over-engineering flags. Detector census clean.

  **What the rounds actually bought.** R1 found two real defects in the first
  draft (durability reported as exit 0; a TOCTOU in collision handling). R2 and
  R4 then found defects *introduced by those fixes* — a `platform === 'darwin'`
  case-fold guess, and a class fixed at two of its three sites — which is the
  author-mimicry pattern, and neither was visible from the file I was editing.
  R6's one substantive item was that nothing verified the archived bytes after
  writing, i.e. I had not audited my own success path. From R5 onward the HIGHs
  were the *same* design argument re-raised (remove `--allow-nondurable`) — a
  flag R1's own H4 had recommended verbatim — so the loop was applying rigor
  pressure, not finding bugs, and the cap was the right stop. Rebuttals are on
  the ledger entries rather than summarised away.

## 1. The defect

`.audit/` is gitignored, so **every linked worktree keeps its own copy** and it
is deleted with the worktree. Agent/chip sessions routinely run in throwaway
worktrees under `.claude/worktrees/<name>`, run real audits there, and are then
removed — taking every transcript with them.

### 1.1 Evidence (measured 2026-08-18)

| Observation | Value | How |
|---|---|---|
| Real audit sessions in the store, 4 days to 2026-08-18 | 8 sessions / 60 runs | `audit_runs`, excluding `experiment_tag='final-review-bakeoff'` replays |
| Transcripts on disk dated 2026-08-17 | **0**, anywhere | filesystem scan across main checkout + every registered worktree |
| Sessions the store shows for 2026-08-17 | `auditor-controls-execution-wiring.md`, plan **and** code | store query |
| Surviving transcripts | only main checkout + one still-live worktree | filesystem |
| Transcripts stranded in the live worktree right now | 4 (`audit-plan-1755500000-transcript{,-v2,-v3,-v4}.json`) | `ls .claude/worktrees/beautiful-payne-85c039/.audit/` |

The 2026-08-17 sessions ran in chip worktrees that were later removed.

### 1.2 What is and is not lost — this sets the severity

- **NOT lost**: findings, verdicts, costs, run metadata. Worktree sessions write
  to the shared Postgres store correctly (verified: `audit_runs` rows are
  present for those sessions). **The audit loop's own primary evidence is
  safe.** This is not a data-integrity incident.
- **LOST**: the raw transcript artifacts. These are the INPUT material the
  model-comparison campaigns consume (`bakeoff-collect.mjs --transcript`), and
  the only full record of a deliberation's *shape* — the store keeps the
  findings, not the rounds that produced them.

The consequence is concrete and current: **`final-review-scoped-2026q3` is
stalled at 7/12 snapshots specifically because it is transcript-starved**, while
this repo audits constantly. The transcripts that campaign needs are being
generated and then deleted.

Severity therefore reads **medium, not high** — no evidence is corrupted and no
gate is wrong; a *renewable* input is being destroyed faster than it accrues.
That is why the fix below is scoped to transcripts rather than to `.audit/`.

### 1.3 The related defect: git's registry cannot see every worktree

`.claude/worktrees/` contained **four** directories while `git worktree list`
reported only two of them:

```
on disk                                    registered?
  beautiful-payne-85c039                     yes (live session)
  nifty-khayyam-8c78fa                       yes
  gallant-hopper-82a5e2                      NO — deregistered, still on disk
  github-actions-runners-disabled-7e0546     NO — deregistered, still on disk
```

This is the known "a failed `git worktree remove` still deregisters" failure.
The two orphans happened to be empty 12K shells, so nothing was recoverable —
but a teardown that fails *midway* leaves real artifacts in a directory **no
git-based scan can see**. The first scan run during this investigation iterated
`git worktree list` and was blind to both.

**Load-bearing consequence**: any harvest design must not rely solely on git's
worktree registry to enumerate worktrees.

## 2. Requirement (the acceptance test)

> A transcript produced by an audit in a throwaway worktree must survive that
> worktree's removal.

Everything below is judged against that one sentence.

## 3. Options weighed

### 3.1 The three candidates

**(a) Harvest on teardown** — a cleanup hook copies `.audit/**` (or just
`*transcript*.json`) out before the worktree is removed.

*Rejected.* It only runs if teardown runs, and §1.3 is a **measured** case where
teardown did not complete: two directories were deregistered from git and left
on disk. A durability mechanism whose trigger is the very operation observed to
fail is not durable. It also cannot help a worktree removed by `rm -rf`, which
is how a stuck Windows `git worktree remove` is usually finished by hand.

**(b) Write through** — audits in a linked worktree write transcripts to the
MAIN checkout's `.audit/`, resolved via `git rev-parse --git-common-dir/..`
(the resolver `discoverLocalEnvPath` has used since `606537ee`).

*Adopted, in the mirror variant — see §3.3.* Durable by construction: nothing
depends on cleanup running.

**(c) Sweep** — a periodic job harvests any `.audit/` found under
`.claude/worktrees/**` by walking the **filesystem**, not the git registry.

*Adopted as a backstop, not as the primary.* A sweep only rescues what has not
already been deleted; between two sweeps the window is wide open, and the chip
worktrees that lost the 2026-08-17 transcripts lived hours, not days. But it is
the only mechanism that can reach (i) worktrees created *before* this change,
(ii) a transcript written by any path that bypasses the shared helper, and
(iii) the deregistered-orphan case of §1.3.

**These are not exclusive, and treating them as exclusive is the trap.** (b)
closes the window for everything written from now on; (c) recovers what (b)
cannot see. Shipping both.

### 3.2 Rejected: redirecting all of `.audit/` to the main checkout

The tempting generalisation — make `.audit` *always* resolve to the main
checkout — is **over-broad and actively unsafe**, for reasons that are properties
of the directory's contents, not of taste:

- **`.audit/last-audit-run.json` is gate evidence.** `ship-commit.mjs:287` reads
  it at `<repoRoot>/.audit/last-audit-run.json` and it is tree-hashed. Sharing
  it means a worktree's audit evidence could satisfy a main-checkout ship, and a
  worktree ship would look for evidence its own audit wrote elsewhere. That
  converts a durability fix into a gate-honesty defect.
- **Per-checkout mutable state**: `tech-debt.json`, `bandit-state.json`,
  `session-ledger.json`, `campaigns/` locks, `write-spill/`, `outcomes.jsonl`.
  Several are explicitly in `audit-clean.mjs`'s `KEEP` set as "load-bearing
  local state". Concurrent sessions already share one working tree here; giving
  them one shared mutable `.audit/` invites interference no current requirement
  asks for.
- **Blast radius**: `.audit` is constructed as a cwd-relative literal at 40+
  call sites across 30 files.

The smallest thing that is a true function of the problem is *transcripts*, and
the problem statement says so: transcripts are what the campaigns consume and
what §1.2 identifies as lost. Redirecting the rest is the over-engineered cliff.

### 3.3 Refinement: mirror at write, don't redirect the write

Within option (b) there are two shapes:

| | (b1) redirect | (b2) mirror |
|---|---|---|
| Where the transcript is written | main `.audit/` only | worktree `.audit/` **and** a durable archive |
| Downstream readers | **all must change** — `gemini-review.mjs review <plan> .audit/$SID-transcript.json` is spelled that way in `audit-code/SKILL.md`, `audit-plan/SKILL.md`, `audit-code/references/gemini-gate.md`, `cycle/SKILL.md` | unchanged |
| Failure if a reader is missed | the MANDATORY final gate dies on `File not found` — the exact 2026-08-08 field-report failure `build-audit-transcript.mjs` exists to fix | none |
| Durability | yes | yes |

**(b2) is chosen.** It buys the identical durability guarantee at zero blast
radius on the prose↔code seam that has already broken once here. The cost is one
duplicated copy per transcript — 84KB on average (measured: 51 transcripts,
4,293,988 bytes total), against a `.audit/` that is already 97MB.

This is not a band-aid. The root cause is *"the only copy lives in volatile
storage"*, and writing a copy into durable storage at write time addresses that
root cause directly and unconditionally. What would be a band-aid is deferring
durability to a cleanup step (option a) or to a scheduled scan (option c alone).

### 3.4 What would change the decision

- **If transcripts stopped being a campaign input**, the archive would have no
  consumer and the honest answer would be to delete them, not preserve them.
- **If a second reader of `.audit/$SID-transcript.json` appeared inside library
  code** (rather than in SKILL.md prose), redirect (b1) would become as cheap as
  mirror (b2) and the duplicate copy would no longer be worth paying for.
- **If the archive's growth exceeded the deferral threshold in §6**, retention
  moves from deferred to required.
- **If the harness stopped creating throwaway worktrees**, the whole plan is
  moot — but the sweep would still be wanted for the orphan case of §1.3.

## 4. Design

### 4.1 The archive

```
<main checkout>/.audit/transcripts/<name>.json
```

- **Path identity has ONE oracle**, `canonicalPathKey()` (added in R2). Both
  the volatility test and the sweep's candidate dedup route through it, so the
  two cannot disagree about whether two paths name the same place. It asks
  `fs.realpathSync.native` rather than folding case, because *every* form of
  the platform guess is wrong somewhere: unconditional lowercasing breaks on
  any case-sensitive volume, and `platform === 'darwin'` breaks on
  case-sensitive APFS — where it merged the genuinely distinct `wt-A` and
  `wt-a` and one worktree was never scanned. Canonicalising sidesteps the
  question: the filesystem knows, and this code does not have to.
- **Under the main checkout**, resolved by `resolveMainRoot()` — the existing
  `--git-common-dir/..` derivation in
  [`scripts/lib/pinned-worktree/paths.mjs`](../../scripts/lib/pinned-worktree/paths.mjs).
  Reused rather than re-derived: this repo already carries four spellings of
  "find the main checkout" and a fifth is how they drift. It is a general git
  derivation that happens to live in the pinned-worktree module; moving it is a
  larger refactor with no correctness gain here.
- **Still gitignored, still category A** under the AGENTS.md generated-artifact
  policy — `.audit/` is already ignored wholesale and `transcripts/` inherits
  that. This plan is about not DESTROYING the artifact, never about committing
  it.
- **A subdirectory, not `.audit/` itself**, for three reasons: it does not
  collide with the working copies; `audit-clean.mjs`'s `keepNewest: 25`
  transient rule is directory-scoped and non-recursive, so the archive is not
  swept by a policy written for working copies; and it gives retention (§6) a
  single place to act on.

### 4.2 `archiveTranscript()` — the mirror

New module `scripts/lib/audit/transcript-archive.mjs` (domain
`audit-orchestration`, importing only `shared-lib` — a declared edge).

```
archiveTranscript(absTranscriptPath, { cwd, env })
  -> { archived: boolean, path: string|null, reason: string }
```

Rules:

1. **Never throws.** The function reports a structured outcome rather than
   raising, so no call site needs a try/catch.
1b. **But a failure IS in the exit code — a warning is not a guarantee**
   (added after R1 audit H1/H4/M6). The first draft logged `NOT archived` and
   exited 0, which every caller checking `$?` reads as success — the same
   defect AGENTS.md's `emit({ok:false})` rule exists to prevent, and it would
   have restored the original loss mode through the reporting channel: disk
   full → warning nobody reads → worktree removed → transcript gone. The rule
   is scoped to where it matters, via `outcome.volatile`:
   - **volatile source** (a linked worktree — the local copy dies with it):
     `build-audit-transcript` exits **1**. `--allow-nondurable` is the explicit
     opt-out.
   - **main checkout** (the local copy is already durable): warn, exit **0**.
     Pinned by its own test, because a blanket "always fail" would satisfy the
     first rule while breaking every ordinary audit.
   - **`AUDIT_TRANSCRIPT_ARCHIVE=0`**: exit **0**. A chosen degradation is not
     a failure — `isArchiveFailure()` owns that distinction so no call site
     re-derives it.

   `audit-loop.mjs` deliberately warns and continues instead of exiting: it is
   mid-run with N rounds already paid for, and the transcript it just wrote is
   the input to the final gate two lines later. Aborting there destroys more
   than it protects. The CLI is cheap to re-run; the orchestrator is not.
   `sourceIsVolatile` **fails closed** — an unresolvable worktree root reads as
   volatile, because the expensive mistake is calling a doomed file durable.
2. **Reason strings are distinct per outcome** — `archived`, `already-archived`,
   `disabled`, `not-in-a-repo`, `copy-failed`. "Nothing to do" and "tried and
   could not" must never share a string; that conflation is exactly how the
   `isP0OrP1` drift (AGENTS.md §prose↔code) stayed invisible.
3. **Idempotent.** Re-archiving the same bytes is a no-op, so the sweep can run
   as often as it likes.
4. **Collision-safe, with no check-then-write window.** Session ids are usually
   `audit-code-<epoch>` and unique, but hand-named ones are demonstrably not:
   the live worktree holds `audit-plan-1755500000-transcript.json`, a made-up
   id another session could mint verbatim. So: same basename + identical
   content → no-op; same basename + **different** content →
   `<base>-<sha256:8>.json`; both names taken by different content → refuse.
   The disambiguator is content-derived, so it is stable across repeated
   harvests.

   The first draft chose the target with `readOrNull` + compare and then wrote
   — a TOCTOU the R1 audit caught (H2/H3): two concurrent worktrees both read
   "absent" and the second write clobbered the first, silently losing the
   artifact this module protects. Publication now goes through
   `atomicWriteFileSync({exclusive:true})`, whose `link()` fails `EEXIST`
   **in the filesystem**, and the EEXIST branch re-reads to decide already-
   archived vs disambiguate. Concurrency here is not hypothetical: this repo
   routinely runs several agent sessions at once.
5. **Kill switch** `AUDIT_TRANSCRIPT_ARCHIVE=0`. This is not decoration — it is
   what lets the negative control in §5 execute the *pre-change* behaviour
   inside the standing suite.

Call sites (both existing transcript writers):

- [`scripts/build-audit-transcript.mjs`](../../scripts/build-audit-transcript.mjs)
  — after `atomicWriteFileSync`.
- [`scripts/audit-loop.mjs`](../../scripts/audit-loop.mjs) — after the inline
  transcript `writeFileSync`.

Both print one line naming the archive path, so a run that did not archive says
so rather than looking clean.

### 4.3 `harvest-audit-transcripts.mjs` — the sweep

New CLI, `npm run audit:transcripts:harvest`.

**Candidate worktrees are the UNION of two enumerations**, because each is blind
where the other sees:

| Source | Sees | Blind to |
|---|---|---|
| filesystem: entries of `<main>/.claude/worktrees/` | deregistered orphans (§1.3) | worktrees outside that directory (`C:/GIT/ces-bakeoff`, pinned fixtures) |
| `git worktree list --porcelain` | registered worktrees anywhere | anything git has forgotten |

Neither alone is sufficient, and the union is what the §1.3 finding demands.
A git enumeration **failure** is reported as `gitEnumerationFailed`, never
folded into "no worktrees" — collapsing the two would let half the union die
while the sweep still printed a clean summary (R1 audit M4).

Every `<candidate>/.audit/*transcript*.json` is passed to `archiveTranscript`.
**Copy only — the sweep never deletes.** Symlinked candidates are skipped,
matching `audit-clean.mjs`'s boundary. Path dedup is case-folded **only on
Windows/macOS**: on a case-sensitive filesystem `wt-A` and `wt-a` are two
worktrees, and folding them would drop one from the sweep (M7).

**The main checkout is a candidate too** (changed after R1 audit M8; §8
originally scoped it out). It is durable against worktree teardown but *not*
against `audit-clean.mjs`'s `keepNewest: 25` cap, so a transcript that only
ever lived there is still on a clock — and the archive exists precisely so
campaigns have a deeper history than that cap allows. Excluding it made the
archive silently incomplete, which is a subtler version of the bug being fixed.

**Exit codes** (tightened in R2): `0` only when every transcript found is now
in the archive — finding nothing is a legitimate `0`, since nothing was at
risk. `1` when the repository could not be resolved, or when **any** discovered
transcript could not be archived. A command whose job is repairing durability
must not report success on a partial repair: those sources are then one
`git worktree remove` from loss while the operator believes the sweep made them
safe.

**Where it runs**: `.githooks/pre-push`, in the real-checkout section,
**non-blocking** — so the exit code above informs without ever blocking a push.

Deliberately **NOT** in `npm run check`. `check` runs in a throwaway sandbox
worktree (`prepush-check.mjs`) where `.claude/worktrees/` is gitignored and
therefore absent — the sweep would find nothing and report green having examined
nothing. That is precisely the sandbox-honesty failure AGENTS.md gates against,
and a harvest is a side-effecting maintenance action, not a gate.

## 5. Tests — `tests/audit-transcript-durability.test.mjs`

Against a **real** temp git repo with a **real** linked worktree, because the
whole defect is a property of git worktree layout.

1. **Acceptance (the load-bearing one)** — round results written in a linked
   worktree at `<main>/.claude/worktrees/wt`; `build-audit-transcript.mjs` run
   with cwd inside it; the worktree then destroyed with `fs.rmSync` (the real
   failure mode — a hand-finished teardown, not a clean `git worktree remove`).
   Asserts the archived copy survives in `<main>/.audit/transcripts/` **and
   parses to the same transcript**.
2. **Negative control (red-then-green)** — the identical flow with
   `AUDIT_TRANSCRIPT_ARCHIVE=0`, which executes the pre-change behaviour.
   Asserts that after teardown **no copy exists anywhere**. This is what makes
   test 1 load-bearing rather than vacuous; it was also run against the
   unmodified script before implementing, and failed there as required.
3. **Registry blindness** — a plain directory under `.claude/worktrees/` that is
   NOT a git worktree. The test first asserts `git worktree list --porcelain`
   does not mention it (so the premise is proven, not assumed), then asserts the
   sweep harvests its transcript anyway.
4. **The union's other half** — a *registered* worktree outside
   `.claude/worktrees/` is harvested too, so a future "simplification" to a
   single enumeration fails a test.
5. **Collision** — identical content under one basename collapses to one file;
   differing content under one basename preserves both.
6. **The exit contract, in all four directions** (added with the R1 fixes) —
   non-zero for a volatile source whose mirror failed; **zero** for the same
   failure in the main checkout; zero under `--allow-nondurable`; zero when the
   kill switch is set. Test 2 of that group is the direction the gate must NOT
   fire in, which is the half a one-directional suite would miss.
7. **No-clobber** — an existing byte-different transcript at the preferred
   archive name is never modified.
8. **Main-checkout harvest** and **git-enumeration failure reported distinctly**
   (with a positive control proving the success path still enumerates).

9. **Path identity** — `canonicalPathKey` preserves the filesystem's own
   spelling, plus an end-to-end check that the sweep visits exactly as many
   directories as the filesystem actually created.

Every fix added in response to the audit was proven **red-then-green
individually**: each was reverted on its own, the corresponding test observed
failing with a message naming the real defect, then restored.

**One of those reverts exposed a vacuous test, which is the reason the rule
exists.** The first case-sensitivity test created `wt-A` and `wt-a` and required
the sweep to visit as many directories as the filesystem made. On Windows both
spellings are one directory, so it passed *with the case-folding bug restored* —
green, and proving nothing on the machine it runs on. It is kept as the
end-to-end companion (it does discriminate on a case-sensitive volume) and
paired with a unit test asserting `canonicalPathKey` preserves on-disk casing,
which fails under case-folding on **every** platform. A guard that has only ever
been observed passing is indistinguishable from one that cannot fail.

## 6. Retention — deferred, explicitly

**Measured**: 51 transcripts, 4,293,988 bytes total (~84KB mean); `.audit/` as a
whole is 97MB. Observed audit rate ≈ 2 sessions/day ⇒ **~170KB/day, ~62MB/year**
of archive growth.

**Decision: no pruning now**, and this is a deliberate deferral rather than an
oversight. Reasons: (i) the archive exists *because* the working copies are
already capped at 25 and campaigns need a deeper history than that cap allows —
a second cap would reintroduce the problem one layer up; (ii) 62MB/year in a
gitignored directory next to a 97MB sibling is not a cost worth managing yet;
(iii) `audit-clean.mjs`'s directory-scoped rules do not reach the subdirectory,
so nothing prunes it by accident.

**Revisit trigger** (named now so the deferral is falsifiable): the archive
exceeding **500MB or 2,000 files**, or a campaign needing a defined retention
window. At that point the right shape is an age+campaign-aware rule in
`audit-clean.mjs`, not a blind `keepNewest`.

## 7. Doc updates

- [`docs/runbooks/model-campaigns.md`](../runbooks/model-campaigns.md) — the
  archive is the durable place to look for a transcript; `--transcript` still
  takes any absolute path (the consumption contract is unchanged).
- [`docs/runbooks/pinned-revision-fixture.md`](../runbooks/pinned-revision-fixture.md)
  — same note, since a fixture has no transcripts of its own and must be handed
  absolute paths.

## 8. Out of scope

- Redirecting the rest of `.audit/` (§3.2).
- ~~Back-filling the main checkout's own transcripts~~ — **brought IN scope**
  by R1 audit M8; the sweep now includes the main checkout (§4.3).
- Deleting the two orphaned worktree directories of §1.3. They are empty and
  removing them recovers nothing; the sweep is designed to see them, which is
  the durable answer. Cleaning up orphan directories is repo hygiene — a
  separate, explicitly-requested task.
- Any change to how transcripts are *consumed*. `bakeoff-collect.mjs
  --transcript <path>` is untouched.
