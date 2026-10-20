# Commit Provenance Trailers (`AI-*`)

Commits produced through the skills workflows carry structured git trailers
recording how they were produced — which skill ran, which models
participated, and whether a gate governed the change. Git-native: queryable
with `git log` / `git interpret-trailers`, no database required. The
authoritative writer is [`scripts/ship-commit.mjs`](../../scripts/ship-commit.mjs)
(pure logic in [`scripts/lib/commit-trailers.mjs`](../../scripts/lib/commit-trailers.mjs));
`/ship` Step 6.3 invokes it. Plan + audit trail:
[`docs/plans/provenance-trailers-and-gate-honesty.md`](../plans/provenance-trailers-and-gate-honesty.md).

> **Two arguments became REQUIRED in 2026-08 and the writer refuses without
> them** ([`worktree-identity-guards.md`](../plans/worktree-identity-guards.md)):
> a complete identity bundle (`--expect-head <sha>` plus `--expect-branch <name>`
> or `--expect-detached`) and an explicit `--path` scope per file. Both are
> fail-closed on purpose — a shared working tree means the commit you get is not
> necessarily the commit you checked. The identity bundle may be omitted only
> when a fresh audit supplied it via `.audit/last-audit-run.json`
> (`auditedSha` + `auditedBranch`); a marker predating that field reports
> `pre-bundle-evidence` and refuses rather than half-matching.

## Schema (v1)

```text
AI-Skill: ship
AI-Models: claude,gemini,gpt
AI-Gate: passed
AI-Run-ID: ecae388d-c176-4182-9d27-0210b919b844
AI-Audited-Tree: 64e894a145de26eed3c3e006c434a345015257bf
AI-Final-Review: approve
```

| Key | Value grammar | Semantics |
|---|---|---|
| `AI-Skill` | lowercase kebab-case, must name a `skills/` (or consumer `.claude/skills/`) directory | which skill workflow produced the commit |
| `AI-Models` | comma-separated tokens `^[a-z][a-z0-9.-]*$`, deduplicated, sorted alphabetically | **declared** lineup of models that participated. Grammar-validated but not evidence-bound (same honesty tier as a `Co-authored-by` line) — receipt-derived binding is a v2 item |
| `AI-Gate` | `passed` \| `converged` \| `waived` \| `not-run` | **evidence- and verdict-bound**: `passed`/`waived` require `.audit/last-audit-run.json` fresher than `HEAD` (an audit ran this cycle); `not-run` requires its absence. `passed` additionally requires (a) the **audited-target identity** to match — the marker's `auditedTree` must equal the tree being committed (see below), checked first and locally — and (b) the run's **convergence verdict verified against the cloud store** (`audit_runs` row via `getAuditRunConvergence`) — cloud off, run not found, run not converged, or a tree mismatch all refuse `passed`, fail-closed. Scope of the verified claim: **GPT-loop convergence only**. The final review's result is a separate fact in `AI-Final-Review` (bound to the run's local evidence, not store-verified; the durable store binding is part of the V2 ship-evidence receipt), and it never changes this value. `waived` is the declared, unverified disposition (gate override OR verification unavailable); the accompanying `AI-Run-ID` keeps it forensically resolvable |
| `AI-Audited-Tree` | 40-hex git oid, conditional — **`passed` only** | the tree object `ship-commit` actually compared when granting `passed`, i.e. the index tree at ship time, which at that moment equals the marker's `auditedTree`. Written only on the accept branch of `evaluateGateVerification`, and the renderer independently refuses to emit it on any other gate or for a malformed oid. **Added 2026-08-04 to make `passed` re-checkable from the commit alone** — see "Verifying a historical `passed`" below |
| `AI-Run-ID` | `[A-Za-z0-9-]{8,64}`, conditional | injected by the helper from `.audit/last-audit-run.json` when fresh — never typed by an agent. Since E1 this is **more than a correlation hint on a `passed` commit**: `passed` additionally requires the marker's `auditedTree` to equal the tree being committed, so the id names a run whose *subject* was verified. On `waived` it remains a best-effort hint. `--no-run-id` omits it (declares the audit unrelated) and forces `--gate not-run` |
| `AI-Final-Review` | `approve` \| `approve-with-debt` \| `blocked`, conditional | the **result** of the final review of the run `AI-Run-ID` names (the round gate's disposition, not the reviewer's verdict word: an `APPROVE` can be `blocked`). **Derived, never an input**: read from `.audit/last-final-review.json` and emitted only when that marker is bound to the same gate evidence `AI-Run-ID` comes from (run, audited tree and round all equal) and records a disposition. There is no flag, and a hand-typed one is refused as a reserved trailer. Absent ⇒ *no final-review record was bound to this run's evidence*, never "approved". Written by `ship-commit.mjs` only; a train squash never carries it. Since 2026-10-20; see "The final-review result" below |
| `AI-Ship-Authority` | the single literal `launch-prompt`, conditional | the ship was **pre-authorised by the user's launch prompt** rather than typed as `/ship`. Written only by `ship-commit.mjs --preauthorised`, after every condition in `scripts/lib/ship-preauth.mjs` held (effective gate `passed`/`converged`, the store's audit converged for this branch, the final review APPROVED this audited tree and round with result `approve`, and no sensitive path, migration or repository-policy file in the branch). A user-typed `/ship` writes none. Since 2026-10-15; see "Pre-authorised ships" below |

### The audited-target identity (E1)

### `converged` — the audited-then-remediated ship (added 2026-09-04)

`converged` is `passed`'s sibling over the **same** evidence and the **same**
store lookup; the two are the equal/differing halves of one tree comparison, so
each refusal names the other and neither is obtainable more cheaply. It exists
because the `!==` half was previously unlabelled: an audit that ran, converged,
and had its findings **fixed** moves the tree by construction, which made
`passed` unreachable while fresh evidence made `not-run` illegal — leaving only
`waived`, i.e. *"shipped past a gate"*, for the workflow's best outcome. A
`/cycle --autonomous` ship was consequently indistinguishable in git history
from `/ship --no-tests`.

**Why `passed` is rare, and why that is not a defect.** `/ship`'s own mandatory
Steps 2–5 write `status.md`, sometimes CLAUDE.md, and the plan's Implementation
Log *after* the audit and *before* Step 6.3's commit. So even a zero-finding,
converged, otherwise-untouched audit moves the tree and lands on `converged`.
Measured over this repo's whole history the day `converged` was added:
**647 `not-run`, 86 `waived`, 2 `passed`**. Read a low `passed` count as the
designed consequence of an audit-then-document workflow, not as breakage — and
never reorder a ship to chase it.

**What `converged` deliberately does NOT claim**, in its own words rather than a
reader's inference: that the tree delta is findings-derived (nothing checks
that — which is exactly why it is not called `remediated`); that the audit ran
in the same operator session (freshness is only `evidence > HEAD`); and that no
foreign commit intervened (committer timestamps are user-controlled and
non-monotonic).

**`AI-Audited-Tree` is deliberately NOT emitted on `converged`.** On `passed`
the audited tree *is* the commit's tree, so it is reachable from a ref and the
trailer is self-verifying with pure git, forever. On `converged` it is a
synthetic tree from `gitWorktreeTree`'s throwaway index that equals nothing any
ref points at — measured: reachable from **0 refs**, listed by
`git fsck --unreachable`, **destroyed by `git gc --prune=now`**, and **absent
from a fresh clone**. Emitting it would publish a provenance line that resolves
for its author until the next gc and for nobody else ever, which is worse than
omitting it. (Second, independent reason: that identity covers all non-ignored
worktree content including unrelated untracked files — an audit *subject*, not a
publishable scope.) The consequence is honest and worth stating: a `converged`
commit carries **no in-git record of what moved after the audit**; recovery runs
through `AI-Run-ID` and the store. Making that durable is the deferred V2
ship-evidence receipt.
Plan: [`gate-taxonomy-remediated-ships.md`](../plans/gate-taxonomy-remediated-ships.md).

`passed` binds to **what was audited**, not merely to when. The marker carries
`auditedTree` — the git tree object id of the worktree the audit read — and
`ship-commit` refuses `passed` unless the tree being committed equals it.

Why a timestamp alone was not enough: a run started against commit **A** can
terminate *after* commit **B**'s timestamp, so freshness reads true and `passed`
attaches to **B — a commit that was never audited**. And why a commit sha alone
was not enough either: trailer validation runs *before* the new commit exists,
so `HEAD` is still the parent, and `auditedSha === HEAD` compares `A === A` and
succeeds by construction while the claim it encodes is false. Content identity
is the only one of the three checks a post-audit edit cannot satisfy.

Consequences worth knowing before they surprise you:

- **A partial commit of an audited worktree refuses `passed`.** Staging a subset
  produces a different tree. This is correct — a whole-worktree audit does not
  cover a subset — but it means "audit everything, then commit some of it" needs
  `waived`, not `passed`.
- **Unstaged edits count.** The captured identity hashes files on disk, not the
  index, because that is what the audit read.
- **Pre-E1 markers and rows never verify.** `auditedTree` is nullable and is
  never backfilled; a run without one is *unverifiable → `not-run`*, never a
  pass. Backfilling a guessed value would retroactively legitimise exactly the
  unbound evidence the field exists to reject.
- **A failed VCS capture makes the run evidence-less** — no marker is written at
  all, rather than one that cannot support its own claim.

### Verifying a historical `passed` (from 2026-08-04)

For any commit carrying `AI-Audited-Tree`, the identity claim is checkable with
git alone — no cloud, no local marker:

```bash
git log -1 --format='%(trailers:key=AI-Audited-Tree,valueonly)%n%T' <sha>
```

The two lines must be identical. They are the tree the gate compared and the
tree the commit carries.

**Why this trailer exists — a gap, not a hole.** The *mechanism* is well pinned
(29 tests across `tests/gate-evidence.test.mjs` and
`tests/gate-evidence-tree-identity.test.mjs`, including the false-pass attack
and controls in both directions). What was missing was the *record*. The gate
compares the **index** tree at ship time; `audit_runs.audited_tree` stores the
**worktree** tree from audit time. Those are different quantities — pinned by
`"an unstaged edit changes the worktree tree but NOT the index tree"` — so the
store can never be used to re-check a historical `passed`, and the artifact the
gate does read (`.audit/last-audit-run.json`) is transient and overwritten.

This was found by auditing the only two `passed` commits in the repo's history
(`2825bf12`, `183810de`, both 2026-07-21). Both resolve to real converged runs.
For `2825bf12` the stored tree also happens to equal the committed tree; for
`183810de` it does not, and **the record cannot settle whether that is benign** —
the marker it would need is long gone. That is the whole argument for persisting
the compared value: not that the gate was wrong, but that nobody could tell.
Commits before this date remain unverifiable in this respect, and no backfill is
possible or attempted — guessing the value would recreate the unbound evidence
the field exists to reject.

The `AI-*` namespace is **reserved**: a commit-message file containing any
`AI-*` trailer is rejected (`reserved-trailer`) — the helpers are the only
writers, so a malformed or hand-typed block can never enter history.

### Two emission points, one renderer, one evaluator (ship trains)

A `/ship --train` lands several audited PRs in one human action, and GitHub's
squash writes the commit message, so the block would otherwise be lost (measured
2026-10-11: of 80 merged PRs, 54 never ran `/ship` and 9 lost the trailer on the
squash). `scripts/ship-train.mjs` therefore writes each squash commit's message,
and there are now **two** emission points: `ship-commit.mjs` (direct commits)
and `ship-train.mjs` (squash messages). Both render through the same
`formatTrailerBlock` and decide the gate through the same
`evaluateGateVerification`, so there is still one renderer and one gate
decision. A squash body is never typed by an agent: it is computed from the
store and git, on the exact head being merged, and `ship-train verify` later
checks that every claim on the landed commit is TRUE.

Three rules are specific to a train. Plan:
[`ship-trains.md`](../plans/ship-trains.md).

- **A run is bound by CONTENT, never by branch or time.** The run's
  `audited_tree` must equal the tree of one of the PR's own commits. A match on
  `audited_sha` alone (`ancestry`) can back only a declared `--waive`, and the
  merge-base is excluded.
- **`passed` on a squash needs a server pin.** It is granted only when the
  destination requires branches to be up to date (a ruleset or classic
  protection with strict status checks and no bypass), because only then does
  GitHub itself guarantee that the squash tree equals the audited tree. On an
  unpinned destination (this repository's `main`, measured 2026-10-11) a train
  lands audited PRs as `converged`, never `passed`.
- **`converged` widens by one reading.** It now also covers "equality could not
  be proven at commit time", not only "the tree differs". The widening only
  removes an implied claim; it never adds one, and it still carries no
  `AI-Audited-Tree`. Implemented as an optional `identityProvable` input to
  `evaluateGateVerification` (default `true`, so every existing caller is
  byte-identical).

### Who writes the evidence (and why `passed` was unreachable until 2026-07-18)

The gate reads **two** pieces of evidence, written by **two** producers — both
inside the audit pipeline, never by the shipper:

| Evidence | Written by | Proves |
|---|---|---|
| `.audit/last-audit-run.json` (gitignored) | `writeGateEvidence` ([`scripts/lib/audit/gate-evidence.mjs`](../../scripts/lib/audit/gate-evidence.mjs)), called at run-finalisation in `legacy-production-audit.mjs` | an audit **ran** after HEAD |
| `audit_runs.round_converged_after` | `recordConvergenceState` ([`store/learning-decisions.mjs`](../../scripts/lib/store/learning-decisions.mjs)), called from the same seam when the round meets the canonical threshold | the audit **passed** |

**Both were missing until 2026-07-18**, which made `passed` structurally
unreachable: the marker had four readers and zero writers (the on-disk file was
six weeks stale), and `recordConvergenceState` had zero callers, leaving
`round_converged_after` NULL on all 39 live rows. Every commit therefore shipped
`not-run`, including commits behind a converged multi-round GPT audit plus a
consolidated Gemini APPROVE — the trailer understating the rigor it exists to
record.

The split is deliberate, not incidental: the marker is a local file, so it can
only ever be **necessary** evidence. Sufficiency requires the store's verdict
for that same `runId`, which the shipper cannot author. Consequently the writer
emits a marker for every completed cloud-backed **code** audit — converged or
not — because "an audit ran and did not converge" is honest evidence that
correctly yields `waived`-or-fix rather than `passed`. Plan audits are excluded
(the gate asserts the shipped *code* was audited), and a run with no cloud id
writes nothing (an unresolvable `runId` would read `fresh` while `passed` was
refused — a confusing half-state).

**Never hand-write the marker.** It is not a switch for turning `passed` on; it
is a receipt the pipeline emits. Regression pins: [`tests/gate-evidence.test.mjs`](../../tests/gate-evidence.test.mjs)
(which validates the writer's output through the *real* validator, never a
restated copy of its schema).

### A schema-behind store used to forge a `not-run` (fixed 2026-09-05)

`not-run` is documented above as *absence of mechanical production*. Until
2026-09-05 it was also what a **fully converged, multi-round audit** produced
whenever the store was one migration behind the working tree — and the two were
indistinguishable in the trailer, which is the one question it exists to answer.

The chain: a behind store rejects the `audit_runs` INSERT (`assertSchemaRealized`
throws `ERR_SCHEMA_BEHIND` on the write path) → `recordRunStart` returns null →
`cloudRunId` is null → the whole gate-evidence block was skipped by its own
`if (cloudRunId && …)` guard → no marker, no convergence verdict → `ship-commit`
correctly refuses `converged` *and* `waived`, because it cannot see evidence it
was never handed. **Every step after the first was behaving as designed.** The
defect was that the one condition costing a clean audit its provenance was the
one condition that reported nothing: the run printed `Verdict: PASS`, exited 0,
and said only `[durable-write] … 2 lost` on the way past.

This is not a rare state. **A store is behind by construction immediately after
pulling a bundle that ships a migration** — the normal condition of every
consumer between `sync` and their next `setup-postgres.mjs --migrate`. The
ordering made it near-unavoidable: `ship-commit` blocks until the migration is
applied, but by then the audit has already run against the un-migrated store and
burned its evidence, so the natural sequence (audit → ship → "oh, migrate" →
ship) *guaranteed* the downgrade.

Three fixes, in the order they now fire:

1. **The audit refuses before spending.** `openai-audit.mjs` asks
   `checkMigrationRealization` ([`scripts/lib/db/schema-realization.mjs`](../../scripts/lib/db/schema-realization.mjs))
   — the same oracle `ship-commit --check-migrations` uses, extracted from it so
   ship time and audit time cannot disagree — and exits before the first LLM
   call, naming the missing migrations and the remedy. `AUDIT_ALLOW_SCHEMA_BEHIND=1`
   proceeds anyway. Fail-OPEN on every uncertainty: only a definite set difference
   blocks.
2. **A run that could not register says so, at the end.** `classifyGateEvidenceGap`
   ([`gate-evidence.mjs`](../../scripts/lib/audit/gate-evidence.mjs)) now runs
   *outside* the `cloudRunId` guard, so cloud-on-but-unregistered prints the
   consequence and the remedy while the operator can still act. Cloud **off**
   stays silent — local-only is a supported mode and `not-run` is correct for it;
   a warning that fires on every offline audit is one nobody reads.
3. **It is queryable, not just logged.** The same reason lands in the result JSON
   as `_gateEvidenceUnwritten` (`no-cloud-run-id`), beside the writer's own
   refusal reasons, rather than living only in scrolled-past stderr.

The evidence still cannot be reconstructed after the fact — a marker cannot be
back-dated, and hand-writing it is forgery the store cross-check exists to catch.
**Re-running the audit after `--migrate` is the only repair.**

### Pre-authorised ships (`AI-Ship-Authority`, from 2026-10-15)

A chip's launch prompt may pre-authorise its own ship (`skills/fleet/references/chip-preamble.md`). It is then not a typed `/ship`, and
the commit says so. The decision is code (`evaluatePreauthorisedShip`), so a chip cannot talk itself past the list; the commit path
refuses (exit 2, each refused condition named) otherwise, and `--check-preauthorised` prints the same verdict early without committing.
The final-review condition reads `.audit/last-final-review.json` (written by `gemini-review.mjs` after each code-mode review, from the gate-evidence marker it ran
against; the previous marker is revoked first, so a failed replacement never leaves an old approval readable): `audit_runs.gemini_verdict` is one column per run with no target identity, so on its own it cannot tell an approval of tree A
from one of tree B. Query: `git log --oneline --grep='^AI-Ship-Authority: launch-prompt'`.

Since 2026-10-20 that condition requires the review's **result** (`disposition`) to be `approve`, not only the verdict word to be
`APPROVE`: an APPROVE whose result is `blocked` (a release-blocking finding, a coverage downgrade, a required subject not received in
full) is refused, naming the result; `approve_with_debt` is refused too; a marker written before dispositions were recorded is
refused with its own reason, `predates dispositions: re-run the final review`, distinct from `malformed`.

### The final-review result (`AI-Final-Review`, from 2026-10-20)

A reviewed decision to ship with debt and a gate bypass used to look identical in git: both read `AI-Gate: waived`. The final
review's result is now its own trailer, so a consumer's

```text
AI-Gate: waived
AI-Run-ID: ecae388d-c176-4182-9d27-0210b919b844
AI-Final-Review: approve-with-debt
```

reads as what it was: the GPT loop did not converge (honest `waived`), the store row for the run says how many rounds it took, and
the final review of that same run, tree and round accepted the remaining findings as debt. Plan:
[`copilot-feedback-item4.md`](../plans/copilot-feedback-item4.md) §2.2.

- **Derived from a record that already existed.** `gemini-review.mjs` writes `.audit/last-final-review.json` after each code-mode
  review; it now records the round gate's `disposition` beside the `verdict`. Only legal pairs are written or read: `approve` needs
  `APPROVE`, `approve_with_debt` needs `CONCERNS`/`CONCERNS_REMAINING`, `blocked` follows any verdict. A contradictory pair is
  `malformed`. A review with no disposition writes no marker (after revoking the old one, as before).
- **One binding predicate.** `matchFinalReviewMarker` (`scripts/lib/final-review-marker.mjs`) answers "is this review about this
  audit evidence?" for both callers, the trailer and the pre-authorised check. What a bound review must *say* stays each caller's
  policy: the trailer reports any of the three; the pre-authorised check requires `approve`.
- **Independent of `AI-Gate`.** `evaluateGateVerification` never reads the final-review marker, and a test pins that its refusal is
  byte-identical with and without an approving marker present. `waived` beside `approve-with-debt` is two facts about one run from
  two records; neither qualifies the other, so there is no illegal pair to police.
- **Absence.** After this date a commit with `AI-Run-ID` and no `AI-Final-Review` means only that no final-review marker was bound
  to that run's evidence at commit time (none ran, it reviewed another round or tree, it was revoked, or it predates dispositions).
  It never means approved. No `AI-Run-ID` ⇒ never an `AI-Final-Review`: a result needs a run to be a result of.
- **Limit: a local fact.** The marker is a gitignored file in the worktree that ran the review, so the trailer is only as durable
  as the commit that carries it, and the store has no per-run, target-bound copy of the result (`audit_runs.gemini_verdict` is the
  verdict word, one per run, no target). A marker lost before the commit means no trailer, never a false one. A durable record is
  the V2 receipt's job.
- **Train squashes never carry it.** A train lands other sessions' PRs from the coordinator's checkout, where no marker is bound
  to a PR's run, so `composeSquashMessage` never writes the key and `ship-train verify` reports one on a squash as a false claim.
  On a squash-merged repository the trailer therefore lives on the PR's own commits, not on the commit that lands on the default
  branch.

**What is reachable from a commit, and what is not** (the other facts the consumer asked for, decided in the plan, not built):

| Fact | How to reach it from the trailers |
|---|---|
| Formal CODE result and budget | `AI-Run-ID` is the `audit_runs.id`: `rounds`, `round_converged_after` (null = did not converge), `rigor_pressure_round`, `total_cost_estimate`, `gemini_verdict` — `SELECT rounds, round_converged_after, rigor_pressure_round, total_cost_estimate, gemini_verdict FROM audit_runs WHERE id = 'ecae388d-c176-4182-9d27-0210b919b844';` |
| Final-review result | `AI-Final-Review` itself |
| Accepted debt | **Not joinable from `AI-Run-ID` today.** Debt entries are stamped `deferred_run` = the audit's **session id** (the `--run` value of `debt-auto-capture.mjs`, compacted past 40 chars by `scripts/lib/run-key.mjs`), not the `audit_runs.id`, and `audit_runs` stores no session id. The SID is in the transient gate-evidence marker (`sid`) and in the audit's own output; from a commit alone the debt is found by plan and time (`audit_runs.plan_file`, `created_at`), not by key. Measured 2026-10-20 against the migrations and `scripts/lib/store/runs-findings.mjs`. |
| Result digest, human ship authority | Dropped: a digest of a gitignored, overwritten file verifies nothing later, and an agent-written "the user approved" is a declaration. The commit author and the PR merge are the authority record. |

## Adoption boundary

The convention applies **from the annotated tag `provenance-v1` forward**
(no history rewrite). Semantics of absence:

- Commits before `provenance-v1` — pre-convention; absence means nothing.
- Commits after `provenance-v1` with no `AI-*` trailers — **not mechanically
  produced** (manual commit, other tooling). Deliberately not distinguishable
  further: absence encodes exactly "no helper ran", nothing more.

## Query cookbook

```bash
# Everything shipped through the skills workflow since adoption (vs manual)
git log --oneline provenance-v1.. --grep='^AI-Skill: '

# All commits where a second model audited (GPT present in the lineup)
git log --oneline --grep='^AI-Models: .*gpt'

# Gate verdict per commit, table form (empty = pre-convention or manual)
git log --format='%h %(trailers:key=AI-Gate,valueonly,separator=%x2C) %s' -20

# "Which review gated this line?" — blame the line, then read its provenance
git blame -L 42,42 scripts/openai-audit.mjs --porcelain | head -1   # → <sha>
git show -s --format='%(trailers)' <sha>

# Commits shipped on a waiver (gates overridden)
git log --oneline --grep='^AI-Gate: waived'

# Audited-then-remediated ships (the gate ran, converged, and its findings were
# applied — the tree moved BECAUSE of the gate, not around it)
git log --oneline --grep='^AI-Gate: converged'

# Both verified gates together (everything behind a store-verified verdict)
git log --oneline --grep='^AI-Gate: \(passed\|converged\)'

# A reviewed ship-with-debt, told apart from a plain bypass (both are AI-Gate: waived)
git log --oneline --grep='^AI-Gate: waived' --grep='^AI-Final-Review: approve-with-debt' --all-match

# Final-review result per commit (empty = no review bound to the run, or pre-2026-10-20)
git log --format='%h %(trailers:key=AI-Gate,valueonly,separator=%x2C) %(trailers:key=AI-Final-Review,valueonly,separator=%x2C) %s' -20
```

## Failure contract (what agents see)

Exit `2` = agent-correctable input; every violation is reported at once as a
pinned-format stderr line:

```text
AGENT FIX: <field>: expected <grammar>; got "<value>". Example: <valid-example>
```

Exit `1` = operational (nothing staged, hook rejection, unparseable audit
evidence, git failure) — report, don't retry blindly. Exit `0` = committed.
The full 15-row failure taxonomy lives in the plan (§F1.4) and is asserted
row-by-row by [`tests/ship-commit-cli.test.mjs`](../../tests/ship-commit-cli.test.mjs).

## Degradation

- **Manual commits** need nothing: commit as usual, carry no trailers.
- **Consumer repos with a stale sync** (helper not hydrated): `/ship` falls
  back to a plain commit and prints `provenance trailers skipped (helper
  unavailable — re-run npm run sync)`.
- The helper never invents values: no fresh audit evidence → `AI-Run-ID`
  is omitted and only `not-run` is legal, rather than fabricating provenance.
- **Cloud off / store unreachable**: `passed` is unavailable (can't verify →
  don't claim); `waived` + `AI-Run-ID` remain, so the claim history stays
  honest and later forensics can upgrade the reading via the run id.

## v1 scope

`/ship` is the only emission point; `/cycle`'s autonomous path is the
explicit v2 target (its unattended retry loop should not gate on an unproven
exit-2 contract). Other v2 items (receipt-derived `AI-Models`, verdict-bound
ship-evidence record, `--gate-reason`) are listed in the plan's §V2 with
their promotion triggers.
