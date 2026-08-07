---
summary: Verification discipline — pinned citations, figure provenance, two-direction proof, attribution, consumer-side checks.
---

# Verification Discipline

Six rules that outlived the engagement that produced them. Each is led by its
measurement, because the measurement is the argument. Field report:
`wine-cellar-app/docs/upstream-issues/claude-engineering-skills-feedback-2026-08-07.md`; design + audit trail:
[`docs/plans/verification-discipline-cluster.md`](../../plans/verification-discipline-cluster.md).

This is the canonical copy. Consuming skills carry a byte-identical
`references/verification-discipline.md`, synced by
`node scripts/sync-shared-audit-refs.mjs` and drift-checked in `npm run check`.
**Edit this file, never a copy.**

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
  line, so a line citation there begins decaying immediately. Use
  `grep -n '^## 2026-07-04' status.md`.
- **An untracked or off-disk path is not a citable path.** It resolves to
  nothing for every reader but the author. Cite it as `git show <sha>:<path>`.
- **A paste-slot, appendix number or section label is a citation too**, and
  drifts like any other reference.

**Checking a document**: `scripts/check-doc-citations.mjs` re-resolves every
pinned citation in a document at its commit and reports `ok` / `moved` /
`drifted` / `unresolvable`.
Report-only — it is an instrument, not a gate.

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
[`skills/audit-code/examples/contract-test-scaffold.md`](../../../skills/audit-code/examples/contract-test-scaffold.md).

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

## Where these came from

Three of the six describe a capability that was **documented, believed, and never
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
