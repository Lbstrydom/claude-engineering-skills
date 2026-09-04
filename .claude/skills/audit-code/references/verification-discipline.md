---
summary: Verification discipline — pinned citations, figure provenance, two-direction proof, attribution, consumer-side checks.
---

# Verification Discipline

Seven rules, each led by its measurement, because the measurement is the
argument. Six outlived the engagement that produced them; §7 was added later,
from the lens-coverage-honesty work. Field report:
`wine-cellar-app/docs/upstream-issues/claude-engineering-skills-feedback-2026-08-07.md`; design + audit trail:
[`docs/plans/verification-discipline-cluster.md`](https://github.com/Lbstrydom/claude-engineering-skills/blob/main/docs/plans/verification-discipline-cluster.md).

> **GENERATED COPY — do not edit.** The canonical is
> [`docs/audit/shared-references/verification-discipline.md`](https://github.com/Lbstrydom/claude-engineering-skills/blob/main/docs/audit/shared-references/verification-discipline.md).
> Regenerate with `node scripts/sync-shared-audit-refs.mjs`; `npm run check`
> fails on drift. Links above were re-spelled for this location — a target
> outside `skills/` becomes an absolute upstream URL, because this copy is
> copied again into `.claude/skills/` and then into consumer repos, where no
> relative path reaches it. So this file is NOT byte-identical to the
> canonical by design.

---

## 1. Cite a line number only with the commit you read it at

> **Measured**: of nine bad claims in one verified document, **five were correct
> when written and decayed afterwards**. None was fabricated.

A path alone is durable. **A path plus a line number is a snapshot, and must be
labelled as one.** The dangerous shape is not a dead link — it is a line number
that still resolves, to different content, so the reader stops checking. One
measured citation moved from a coupling-ranked table to an unrelated section
while continuing to resolve, and the row it pointed at now reads a *different
number for the same claim*.

**Rules:**

- **Pinned form** — the commit id in parentheses, immediately after the line
  (ranges use `:120-140`):

  ```
  path/to/file.ext:120 (a4ec98da)
  ```
- **Append-newest-first files are cited by section header, never by line.**
  `status.md`, changelogs, session logs: every new entry shifts every earlier
  line, so a line citation there begins decaying immediately. Search the current
  month and the archives together, because such a log is eventually rotated and
  a header survives the move while a line number does not:
  `grep -rn '^## 2026-07-04' status.md docs/status/`.
- **An untracked or off-disk path is not a citable path.** It resolves to
  nothing for every reader but the author. Cite it as `git show <sha>:<path>`.
- **A paste-slot, appendix number or section label is a citation too**, and
  drifts like any other reference.

**Checking a document** re-resolves every pinned citation at the commit it was
read at and reports `ok` / `moved` / `drifted` / `unresolvable`. Report-only:
an instrument, not a gate, and it writes nothing.

- source repo: `npm run docs:citations -- <doc>`
- consumer repo: `node scripts/.claude-skills/check-doc-citations.mjs <doc>`

It reads the repo it is run in, so a consumer checks its own citations. Add
`--require-citations` when the run is meant to prove adoption: a clean report
over **zero** parsed citations is not a pass, and that flag turns it into a
non-zero exit.

### The citation contract (what the checker actually does)

**Extraction is two-stage, because one-stage extraction fails open.**

1. **Recognise candidates** — any `<path-like>:<digits>` prefix, **bare filenames
   included** (a root-level `AGENTS.md` line reference is a real citation), plus any
   parenthesised revision-like suffix. No path rule is applied here: a candidate
   is a *shape*, not a validity claim.
2. **Classify** — every candidate lands in exactly one bucket:
   - **pinned** (valid 7-40 lowercase-hex sha) → resolve it;
   - **unpinned** (no parenthesised suffix) → counted, no verdict. The `/`
     requirement applies *here and only here*: without a sha there is nothing to
     separate `foo.md:12` from prose;
   - **malformed** (suffix present, not a valid sha) → `unresolvable` with a
     reason code. **Never silence** — silently dropping a malformed pinned
     citation is the fail-open case this instrument exists to close.

Citations inside fenced code blocks are not extracted.

**Comparison**: the cited line's normalized text at `<sha>` (read via git) against
the **working-tree file** (read from disk), falling back to `HEAD` only when the
path is absent from the tree. Git reads exactly one thing — the historical pinned
state. Comparing against `HEAD` would mean an author cannot verify a citation fix
without committing first, and the reader who follows a citation opens the current
file, not `HEAD`. Normalization is narrow on purpose: **CRLF→LF and
trailing-whitespace strip, nothing else.** Anything looser starts approximating
*"is this citation apt"*, a judgement with no oracle.

| Verdict | Condition | Remedy |
|---|---|---|
| `ok` | identical at the cited location | none |
| `moved` | differs there, pinned excerpt occurs **exactly once** elsewhere | mechanical re-pin; the report names the new line |
| `drifted` | differs, excerpt absent or non-unique | re-read the claim |
| `unresolvable` | any read / revision / grammar / boundary / limit failure | fix the citation (**fail-closed** — never `ok`) |

**An insertion above a citation is decay, not a false positive.** The citation
makes a location claim as well as a content claim; a reader following it lands on
the wrong text. `moved` exists so that case reads as a cheap re-pin rather than an
alarm.

### 1b. A claim sourced from mutable state must carry the query that produced it

> **Measured**: a module docstring asserted a payload shape *"verified against
> live session data, 2026-07-13"*. The store was wiped **2026-07-14**. The claim
> was also wrong, and every later reader trusted it — including the one that
> wrote an entire correlator against the wrong field name, which then produced
> zero rows for a month.

A commit id makes a file claim re-checkable: the bytes still exist. **A live
store offers no such anchor.** When the source is a database, a dashboard, an
API, or anything else that can be mutated, dropped or restored, a claim recorded
without its query is not merely at risk of going *stale* — it becomes
**unfalsifiable**, because there is no longer any way to ask the question again.
And unfalsifiable prose reads exactly as authoritative as verified prose.

- **Writing one**: paste the query, RPC, or command beside the claim, and pin
  the date. `-- SELECT count(*) FROM x WHERE …  → 7 (2026-08-11)` costs one line
  and converts an assertion into an instrument someone else can re-run.
- **Reading one**: re-run the query before building on it. If the claim predates
  a known wipe, restore, migration or provider switch, treat it as
  **unverified** — not as weak evidence, as *no* evidence. It cannot be checked,
  so it cannot be relied on.
- **The tell**: a claim about live data that is *also* about a shape, count or
  schema — the things a migration silently changes. Those are the claims worth
  re-running first.

This is §1's rule with the anchor removed. Where a line citation decays into
pointing at the wrong text, a store-sourced claim decays into pointing at
nothing at all.

---

## 2. A figure without provenance misdirects debugging

> **Measured**: a documented test count was stale by **2.3x on count and 6.7x on
> wall clock** — `~5250 tests (~12s)` against a real 12,216 in 80s.

A stale figure is worse than a missing one, because it is exactly the number
someone reaches for when a run *looks wrong*. A suite reporting 12,216 against a
documented 5,250 invites the conclusion that something double-registered — and
sends the debugging session after the loader while the doc is the broken thing.

**Label every figure you write into a durable document**, and carry the fields
its kind requires:

| Kind | Required |
|---|---|
| **all** | metric name + unit; value; population / scope (what was counted, over what) |
| `measured` | the **exact command**, the working context, the **immutable revision** of code and data, the observation time |
| `derived` | the cited source measurements (each a record itself) **and** the formula |
| `expected` | its basis, and an explicit statement that it is **not** a measurement |

**Re-measure, never extrapolate** — and only when you have just run the thing.

**Name the metric.** "Size" and "faster" name nothing: one container image
reported three different sizes varying by **3.6x** depending on tool and storage
driver. A figure whose metric is ambiguous is not checkable, and the ambiguity is
usually in the tool rather than the doc.

**A figure stated loosely in one report is quoted back as a hard requirement in
the next.** Precision is acquired by re-reading, not by being earned.

---

## 3. A check is not trustworthy until it has been seen to fail

> **Measured**: a container health check had **never passed on any image**, then
> sat **three weeks** with nothing able to detect its reversion. Separately, **six
> verification-script failures in one session were all instrument defects.**

**Two-direction proof — the standard step, not a nicety:**

1. Write the check.
2. **Break the subject → confirm RED.** Where the fix closes independent failure
   modes, break them **one at a time**: two defects on one line can mask each
   other, and a half-fix is then indistinguishable from no fix.
3. Restore → **confirm GREEN**.
4. Record that you did it, and what the red output said.

**A before/after observation is not a negative control.** Watching a
*pre-existing* defect go from red to green tells you nothing about whether the
*repaired* check would go red again. In the measured case the repaired probe had
only ever been observed passing — and an always-passes probe is
indistinguishable from a correct one.

**When a check fails, suspect the instrument before the subject.** Six for six in
one session: directory entries counted as files, XML entities breaking string
matches, `grep` consuming leading-dash content as flags. The cheapest
discriminator is a positive control — feed the instrument something it *must*
find.

**The asymmetry is the whole point.** A check that wrongly fails is annoying and
visible. **A check that wrongly passes is invisible, and it spends the trust
budget a real check would need.** Ask of any green-emitting branch: *can this
return green without having checked anything?*

### 3a. When the negative control cannot be built, DECOMPOSE — do not shrug

> **Measured 2026-08-09**: a lock-durability property resisted direct testing.
> With the lock removed the race stayed invisible at 2×12 concurrent writes
> (under the cap, so the trim never fired and there was nothing to race) and
> again at 2×80 (at the cap, lost updates leave the file *at* the cap, so a
> count cannot tell them apart). Two honest attempts, both non-discriminating.

"I could not make it fail" is a finding about the *instrument*, not a licence to
ship the test as if it proved something. The move is to split the property into
claims that are each provable:

> *"acknowledged appends are never lost"* = **(1)** the lock provides mutual
> exclusion **AND** **(2)** all mutation happens inside it.

(1) is behavioural and testable with real OS processes. (2) is **structural** —
an AST check on lexical containment, which cannot be flaky and cannot be raced.
Their conjunction is the property; neither half alone is. And (2) is the half a
refactor silently breaks, so that is where the regression lock belongs.

**Prefer a structural assertion wherever behaviour is unobservable.**
Concurrency, ordering and "nothing else may do X" invariants are usually
lexical. Resolve the *binding*, not the spelling — a local shadow named like the
real thing must not satisfy the guard.

**Build the negative control INTO the guard.** A checker that has never
demonstrated it can say NO is indistinguishable from one that always says YES.
Run it against a deliberately-broken copy of the real subject, in the same test
file, and assert it reports the violation.

### 3b. Mechanise it — mutation testing is this rule at scale

Red-then-green is per-check and manual, so it verifies the checks you thought to
doubt. Mutation testing does it exhaustively: mutate the source, re-run the
tests, and any mutant that survives is a place the suite would not have noticed
a real regression.

> **Measured on first run**: a pure string module written *deliberately*, with
> tests written in the same sitting to close a security finding, scored
> **77.78% with 6 survivors**. Two genuine gaps — a null-coercion path with no
> test at all, and a `[\r\n\t]+` quantifier no input exercised twice. Review had
> missed both. A wider census then measured the Tier-3 egress seam at **67.5%
> (120 survivors)** and a lock module at **31.7% (270)**.

Three things make it sustainable rather than shelfware:

- **A registry, not "mutate everything."** Pair one module with the one test
  file covering it, so a run is seconds. Whole-tree mutation on a large suite
  takes days, and a gate nobody runs reads as coverage while providing none.
- **A ratchet, not a cliff.** Set the floor to the score measured *today* and
  fail only on a DROP; record the goal separately. A floor set to the number you
  wish for is red on day one and gets ignored — the cried-wolf shape. The floor
  may only ever be raised.
- **Absence is a statement.** A module missing from the registry has not had its
  tests proven to detect defects, only to pass. Say so where the registry lives.

Not a push gate: it is slow and drifts with unrelated refactors. On-demand, or
nightly CI.

### 3c. Code that only runs after a failure needs a manufactured failure

> **Measured 2026-08-29**: adding `/L*v` verbose logging and a failure tail to a
> single `msiexec` drill introduced **three defects into that one diagnostic
> path**, and the drill ran green end-to-end between the second and the third.
> A `/\r?\n/` split mangled into a literal newline; a UTF-16LE log read as UTF-8,
> printing null-separated mojibake into the CI error message; and a last-60-lines
> tail that missed the real cause — `Error 1335 … cabinet file 'cab2.cab' … is
> corrupt` at **line 1480 of 2131**, the tail holding only rollback bookkeeping.
> The opacity it was fixing had already cost days: the same bare exit code 1603
> was written off twice, in two sessions, as self-clearing runner residue.

Logging, error formatting, failure classification and retry decisions sit outside
§3's framing because of one shared property: **the happy path never executes
them.** §3 asks you to prove a check *can* fail. Here the reporter **is** the
subject, and the failure is an **input you must manufacture before the code under
test runs at all**. So a fully passing suite is not weak evidence that a reporter
works — it is **zero** evidence, and it reads as reassurance. That is the trap.

**Manufacture a real failure of the real tool, in the same pass that adds the
diagnostic:**

1. **Drive the actual tool to an actual error** — not a stub, not a hand-written
   fixture. `msiexec /i C:\nonexistent\nope.msi /quiet /norestart /L*v <path>`
   → exit 1619, in about ten seconds.
2. **Read what the handler printed**, not what it was meant to print. Encoding,
   line splitting and truncation are invisible to review and observable only
   here — the UTF-16LE defect had already survived two green drills.
3. **Check the diagnostic names the cause.** A verbose log does not end at the
   failure, so a fixed tail of N lines is an assumption about where the cause
   sits. That one was wrong by 650 lines, and CI named nothing.

Ten seconds against a defect that had already survived a full drill. "We'll find
out next time it breaks" is not the cheaper trade — next time is a CI failure
diagnosable only if the full log happens to still be on the runner's disk.

### 3d. Intermittent means race — "the environment" is a claim, not an explanation

> **Measured 2026-08**: three failures in one repo, each attributed to a
> shared/contended CI machine before anyone read the code, two of them
> independently by more than one session. All three were the **same shape** — a
> guard that exists and is applied at one call site and missed at another: a
> confirm-dialog handler registered by one app launcher but not a second; an
> export wait using a local 30s timeout at one call site while a shared helper
> used the command's real 120s contract at two others; a process-tree wait
> applied before uninstall but not before upgrade.

Sibling of *suspect the instrument before the subject*: **a failure that comes
and goes is evidence of a race**, and "the machine was busy" is a hypothesis that
has to be tested — re-run on an idle machine, check for overlapping jobs — not
the default explanation. Untested, it is a claim about mutable state with no
query behind it (§1b), and it costs nothing to assert, which is why it keeps
winning.

The cheap discriminator is a **census, not a repro**: take the guard the passing
path relies on and enumerate every call site that needs it. The failing site is
usually the one nobody added it to.

---

## 4. Reproducing a figure is not verifying its attribution

> **Measured**: a 22.5% image-size reduction **reproduced perfectly** — and its
> stated cause was false. The credited property already existed in the parent
> commit; the real mechanism accounted for **92%** of the delta.

Any claim of the form *"this change made X faster / smaller / safer"* can fail
this way: **the improvement is real, and the credited property already existed.**
A verification pass that checks figures and not attributions passes both cleanly.

**The attribution step**, after the figure reproduces:

1. **Did the parent already have the property being credited?** Inspect the
   parent for it directly.
2. **Ask the build system**, where one can answer. In the measured case the
   resolver settled it independently of any file reading: one target resolved at
   the parent, the other did not.
3. **Decompose the delta.** 92/8 is a different story from 50/50, and only
   measurement tells you which you have.

**Report two verdicts, never one**: `figure: reproduced | refuted` and
`attribution: confirmed | refuted | untested`. A summary that fuses them is the
artefact that misleads.

**Chronological proximity is not causation** — and the reverse trap is just as
live: in the same engagement a campaign credited with enabling a migration began
**ninety minutes after** the migration merged.

---

## 5. Promote a one-off check that mattered into a contract test

> **Measured**: a repaired health check was **unguarded for three weeks** —
> reverting it passed every gate in the repository.

Every engagement produces throwaway verification, and a fraction of it guards
something that will regress. That promotion is craft; the scaffold makes it
mechanical. Template + worked example:
[`skills/audit-code/examples/contract-test-scaffold.md`](../examples/contract-test-scaffold.md).

Three parts, and **the first alone is the fail-open trap of §3**:

1. **Subject probe** — the assertion.
2. **Negative control** — proof it goes red when the guarded thing breaks,
   one defect at a time.
3. **Vacuous-pass guard** — proof the probe can observe anything at all.
   **Mandatory whenever the real assertion is "expect empty"**: a silently
   broken search returns nothing, which is what passing looks like.

Plus lifecycle, because a scaffolded check otherwise becomes an undocumented
permanent guard: a **disposition** (`temporary-guard` | `promoted-durable-contract`
| `retired`), the **successor contract** when promoted or replaced, and — for a
`temporary-guard` — a **named enforcing test and its machine-evaluable retirement
predicate**, so removal is forced rather than remembered. Link the originating
audit finding; do not open a second promotion record beside the ledger.

---

## 6. Verify what the consumer receives, not what the producer sent

> **Measured**: two independent cases where the producer-side check passed and
> the consumer-side artifact was defective.

`git push` exiting 0 proves the transfer completed. It proves nothing about the
receiver's view. A generated artifact can pass every check against its **source**
while the built output carries real defects.

| Artifact | Consumer-side retrieval | Subject check |
|---|---|---|
| a pushed commit | clone/fetch into a temp dir at the pushed sha | the repo's battery runs green **in the clone** — catches tracked-vs-ignored and case-only path faults invisible locally |
| the synced consumer bundle | **authoritative**: the synced `sync-isolation-verify` run *in the consumer*. `npm run sync:dry` from the source is the pre-check, not the verdict | zero unexpected diffs; no orphans |
| the skill manifest | re-derive from the pushed sha, not the working tree | regenerated bytes identical |
| a published package | `npm pack`, install the tarball, import it | the public entry points resolve |
| a pushed image | pull the digest and run **that** | it boots and answers |

**Required evidence** — all of it, or the state is `unverified`: immutable locator
(digest / full sha / bundle version), the retrieval command actually run, the
isolated environment, the expected subject behaviour, the observed result.

**Three terminal states, and only three**: `verified`, `failed`, `unverified`.
**`unverified` must name a concrete blocked prerequisite** — "no network in this
environment", "no consumer checkout on this machine" — never a bare "not
applicable". A missing prerequisite is a fact; an undefined *impossible* is an
excuse. **Never inherit the producer-side green.**

---

## 7. A report states its coverage, not only its verdict

> **Measured**: of nine lenses in this bundle that emit a findings verdict, two
> (click-test, visual-audit) arrived independently at the discipline below;
> three (ux-lock, persona-test, audit-code) did not, and each was able to emit
> a clean verdict over an itinerary the report never stated.

§6's rule is scoped to one artifact class — what a consumer receives after a
push. The asymmetry behind it is not: **a check that wrongly fails is annoying
and visible; a check that wrongly passes is invisible, and it spends the
trust budget a real check would need.** That applies to every surface a lens
declines to check, not only to a post-push retrieval.

**Three obligations.**

1. **The subject line — what was checked, with what instrument.** A verdict
   without an itinerary is unfalsifiable: the reader cannot tell a thorough
   pass from a vacuous one, because the two look identical in the transcript.

2. **The non-coverage line — what had no applicable check, and why, by a
   named kind.** For a lens that enumerates a bounded surface set (a route
   list, a pass/wave set), every surface **never attempted** carries a reason
   of one of four kinds:

   - `blocked` — a concrete missing prerequisite (an auth wall with no
     bootstrap, no network, an absent credential *or unset config for an
     optional capability* — the latter is still a nameable, concrete thing:
     "AUDIT_DB_URL unset", not a vaguer "disabled"). §6's rule verbatim.
   - `out-of-scope` — another lens owns it; **name that lens**.
   - `not-reached` — the run's own budget ran out (step cap, route list,
     device matrix, node budget) before the surface was attempted.
   - `not-applicable` — the check does not apply here at all: a detector
     ineligible for the resolved repo/language/scope, or a surface no lens in
     the bundle owns (an honest `not-applicable, unowned` is itself useful
     information — a gap in the *bundle*, not a defect in the *run*).

   **A surface that WAS attempted but did not complete is a different thing
   from a surface that was never attempted.** Call the attempted-but-failed
   outcome `errored`. It is **not** one of the four kinds above and must not
   be folded into one — doing so hides whether the check ran at all, the
   exact ambiguity this section exists to prevent. Both `errored` and the
   four never-attempted kinds count as "not covered" for the verdict-coupling
   rule below, but each is reported under its own distinct label.

   A bare "not applicable" with no kind and no name is not a reason.

3. **The verdict coupling — the clean label is reserved for a run that was
   also complete.** Zero findings plus a non-empty non-coverage line (of
   either shape) gets a *distinct* label from zero findings with nothing
   uncovered. And: **issues are never masked by coverage gaps** — a run with
   findings *and* gaps surfaces both, never collapses to the gap label.

**Three shapes, not one artefact.** A coverage block is itself a claim, and
the obligation above is shape-neutral — it does not prescribe one report
format:

- **Enumeration** — the lens discovers or defines a bounded surface set (a
  route crawl, a pass/wave set), so it owes a per-surface state using the
  vocabulary above.
- **Degradation** — a single verdict downgrades (to `unverified`, or an
  equivalent) when capture is incomplete, carrying the same vocabulary
  applied to the capture as a whole, not per-surface.
- **Boundary disclosure** — for a lens whose exploration is *adaptive*
  (plan-as-you-go rather than crawl-a-known-set), there is no surface set to
  enumerate honestly. The report states what was **actually reached** plus
  the **boundaries that bounded the run** (a step budget, a declared focus, a
  safety-policy restriction, an auth state), from a record the run itself
  populated as it went — never composed at report time — and says explicitly
  that this is not an inventory scan. The four-kind taxonomy does not apply
  here: there is no enumerated set for a kind to describe an entry of.

A fourth case is worth naming so it is not silently absorbed into one of the
three: a lens whose report is **rendered by a script**, not composed by the
agent from these instructions, cannot be brought to conformance by editing
this reference alone — that would need a code change, a different kind of
work with a different owner. Such a lens should be documented honestly:
which existing mechanisms already serve one of the three obligations, and
which remain deferred, by name, rather than silently claimed.

**The reciprocal warning.** A coverage block is exactly as unfalsifiable as
the verdict it decorates if it is composed at report time rather than
**derived from the run's own record** — and it is *more* dangerous, because
it stops the reader checking. Where nothing was recorded, the honest block
says that; it does not reconstruct.

---

## Where these came from

Three of the original six describe a capability that was **documented, believed, and never
exercised**. That is the family resemblance, and it is why the rules are phrased
as steps rather than principles — the same ask, filed as a principle three weeks
earlier, produced two further instances of its own failure class.

This repository has form here in both directions, which is the useful part.
`scripts/lib/skill-refs-parser.mjs:207 (37796cff)` raises `Orphan file: … is not
listed in the reference table` — a real guard, doing real work, which is why the
file you are reading must appear in its skill's reference table.
`scripts/check-docs-refs.mjs:22 (37796cff)` states its own doctrine plainly —
*"it checks whether a cited path RESOLVES, not whether the citation is apt"* — and
that honest scope limit is exactly why §1 needed a separate instrument rather than
a wider net cast over an existing one.
