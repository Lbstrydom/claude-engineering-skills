# Commit Provenance Trailers (`AI-*`)

Commits produced through the skills workflows carry structured git trailers
recording how they were produced — which skill ran, which models
participated, and whether a gate governed the change. Git-native: queryable
with `git log` / `git interpret-trailers`, no database required. The
authoritative writer is [`scripts/ship-commit.mjs`](../../scripts/ship-commit.mjs)
(pure logic in [`scripts/lib/commit-trailers.mjs`](../../scripts/lib/commit-trailers.mjs));
`/ship` Step 6.3 invokes it. Plan + audit trail:
[`docs/plans/provenance-trailers-and-gate-honesty.md`](../completed/provenance-trailers-and-gate-honesty.md).

## Schema (v1)

```text
AI-Skill: ship
AI-Models: claude,gemini,gpt
AI-Gate: passed
AI-Run-ID: ecae388d-c176-4182-9d27-0210b919b844
```

| Key | Value grammar | Semantics |
|---|---|---|
| `AI-Skill` | lowercase kebab-case, must name a `skills/` (or consumer `.claude/skills/`) directory | which skill workflow produced the commit |
| `AI-Models` | comma-separated tokens `^[a-z][a-z0-9.-]*$`, deduplicated, sorted alphabetically | **declared** lineup of models that participated. Grammar-validated but not evidence-bound (same honesty tier as a `Co-authored-by` line) — receipt-derived binding is a v2 item |
| `AI-Gate` | `passed` \| `waived` \| `not-run` | **evidence- and verdict-bound**: `passed`/`waived` require `.audit/last-audit-run.json` fresher than `HEAD` (an audit ran this cycle); `not-run` requires its absence. `passed` additionally requires (a) the **audited-target identity** to match — the marker's `auditedTree` must equal the tree being committed (see below), checked first and locally — and (b) the run's **convergence verdict verified against the cloud store** (`audit_runs` row via `getAuditRunConvergence`) — cloud off, run not found, run not converged, or a tree mismatch all refuse `passed`, fail-closed. Scope of the verified claim: **GPT-loop convergence only** — the Gemini final-review disposition is not yet store-verifiable per run; binding it is part of the V2 ship-evidence receipt. `waived` is the declared, unverified disposition (gate override OR verification unavailable); the accompanying `AI-Run-ID` keeps it forensically resolvable |
| `AI-Run-ID` | `[A-Za-z0-9-]{8,64}`, conditional | injected by the helper from `.audit/last-audit-run.json` when fresh — never typed by an agent. Since E1 this is **more than a correlation hint on a `passed` commit**: `passed` additionally requires the marker's `auditedTree` to equal the tree being committed, so the id names a run whose *subject* was verified. On `waived` it remains a best-effort hint. `--no-run-id` omits it (declares the audit unrelated) and forces `--gate not-run` |

### The audited-target identity (E1)

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

The `AI-*` namespace is **reserved**: a commit-message file containing any
`AI-*` trailer is rejected (`reserved-trailer`) — the helper is the only
writer, so a malformed or hand-typed block can never enter history.

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
