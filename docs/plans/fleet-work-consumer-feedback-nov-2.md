# Plan: fleet — the rest of a work consumer's November run report
- **Date**: 2026-11-16
- **Status**: In progress — implemented on branch `claude/fleet-feedback-batch2`, PR pending
- **Author**: Claude + Louis
- **Scope**: backend (fleet CLI + skill prose; no UI) · stack `js-ts`
- **Target domain(s)**: `fleet`

A work consumer on the Azure profile (G&D Deal Room, seven concurrent sessions, 2026-11-15) sent a run report. Its urgent
half merged as CES #368 (`b0f87161`: lease heartbeat, red-train exit 4, per-verb help, merged claims, dubious ownership;
plan `fleet-work-consumer-feedback-nov.md`). This plan is the other six items, in the consumer's suggested order.

**Reproduced against current main, not the consumer's bundle** (about `0cd064d1`, 2026-11-11). Every new test below was run
against `origin/main` at `85cfbccd` first, in a separate worktree: 23 of the 25 new tests fail there, and the 2 that pass
are the stacked-base control and an argv refusal that main also gives. **Nothing here was already fixed.** One item had a
foundation: #375 (`85cfbccd`) shipped `fleet decision` with the scopes `record-catchup` and `note`, so item 4 adds two scopes
and the `next` view to it instead of a second channel.

**Do not regress** (what the consumer said worked): sessions refusing relayed approvals and `--override`; `fleet propose`
keeping other sessions' findings out of branches; `land --dry-run`'s landing order (plain `--dry-run` still only plans);
the train's separate candidate commit keeping main untouched while red.

**Mixed-bundle compatibility.** The registry is shared by every worktree, and a worktree may run an older synced bundle.
Nothing here adds a field an older reader would have to understand: a stacked base goes in the existing `source.baseRef`;
a probe is kept under its own root, `fleet/probes/`; a stale ready mark is derived, never written; and the new decision
field `to` appears only on the two new scopes, which an older reader already lists as unsupported. One known cost: a bundle
from #375 that reads a `test-plan`/`answer` record treats the registry as unusable (fail-closed, by #375's design), so its
`record-catchup` decisions read INDETERMINATE until it is re-synced. #375 merged on 2026-11-16, so no consumer is known to
run that bundle.

## 1. `fullSuite: "train"`

**Fix**: a `.fleet.json` key, `fullSuite: "session"` (default) or `"train"`. With `"train"`:
- `fleet next` prints `TESTS: this repo defers the full suite to the train …`: run the targeted and affected-file tests plus
  the required gates, then `fleet ready`, never the heavy slot for a full suite, and the exact test-log words
  `full suite deferred to the train (fullSuite: train)` (one spelling, `FULL_SUITE_LOG_LINE`, so a log is greppable).
- `fleet ready` says the same and returns `fullSuite: "deferred-to-train"`.
- `fleet land` (a real train, not a probe) says it is the one full-suite run for the sessions in it.
- Participant rule 4a, the chip preamble's TURN block and `/cycle`'s clustered-execution reference carry the conditional.

**Declined**: enforcing it in `lease acquire`/`lease run` (refusing a session's `--kind test`). A pre-push hook that runs the
full gate is still heavy work under `lease run -- git push`, so a refusal there would break the push path; coordination is
cooperative by design. **Not edited**: `skills/cycle/SKILL.md` (already over its size baseline on main, and the ratchet is
drift-only); its "broadest suite" rule points at `references/clustered-execution.md`, which now states the exception.

**Acceptance**: `next`/`ready` under `"train"` name the deferral and the log words; the default prints none of it.
`tests/fleet-suite-decision-cpu.test.mjs`.

## 2. Fast-tier probe train

**Fix**: `land --dry-run --tier <name>` builds the combined candidate from every ready branch and runs ONLY that pre-land
tier. It is kept under `fleet/probes/` (same layout and lock, its own root), where no approve, confirm or resume reader
looks, so no bundle can approve it; it removes its worktree, ends `abandoned`, and exits 0 green, 4 red, 3 on a conflict.
`--tier` without `--dry-run` is an argv error. `fleet status` prints `hint: N ready branches never tested together — …`
while two or more ready heads have not all been in one train or probe that reached a verdict (a tier result or a
conflict); once one has, it prints that train's verdict. A moved head changes its oid, so the hint returns
(`tested-together.mjs`, pure). `land` takes no heavy slot itself, so the probe needs none.

**Declined**: running the probe automatically when a second branch becomes ready. That needs a watcher process fleet does
not have; the status hint asks the coordinator to run it, which is the same trigger.

**Acceptance**: two ready branches that both edit one file give `CONFLICT at feat-b` from the probe, and the full tier
never runs. `tests/fleet-probe-and-stale-ready.test.mjs`.

## 3. Stacked-base overlap

**Fix**: `claim --base <branch>` records the session's real fork point in `source.baseRef` (`--base <the base>` un-stacks).
`gatherFacts` adds `ownChanged[branch]` = `stackBase...tip` for each stacked session; overlap (in `status` and in
`claim`'s `othersFor`) uses it. What the session inherited (from-base files minus its own) shows once, collapsed:
`inherited (N files) from stack base X — shared ancestor commits, not counted as overlaps`. A stack base that cannot be
measured falls back to the from-base diff with a note, never to "no files". `changed` itself is unchanged, so check hooks
and `land` see what they saw before. A declared-path conflict (not known) is now the first line under its branch.

**Acceptance**: six sessions on one unlanded base report zero overlaps from it and one inherited line each; without
`--base` (the control) they overlap on the base's files; a new claim on the base's files is not blocked by them; a
declared-path conflict is the first line. `tests/fleet-stacked-base.test.mjs`.

## 4. User-decision records for a session

**Fix**: two decision scopes, `test-plan` and `answer`, addressed with `--to <session|all>` (default `all`). They keep
#375's properties: the user's exact words on stdin, the recording session and time, immutable, revocable by a new record,
fail-closed on an unusable registry. `fleet next` quotes an active one addressed to the session as
`USER DECISION <id> (<scope>) — the user's own words, recorded by <session> at <time>; not a peer's claim:`, apart from
directives and never as a DO line, with the note that it grants nothing else.

**Never grants merge, push, `--override` or deletion** — tested two ways: no such scope exists or is accepted, and none of
the modules that merge, push, override a claim or delete work (`train-approve`, `serial`, `train`, `land`, `archive`,
`prune`, `prune-orphans`, `commands`, `lifecycle`, `restack`, `lease`, `lease-cmd`, `directives`) imports
`decisions.mjs`.

**Acceptance**: `tests/fleet-suite-decision-cpu.test.mjs` (`user decisions`).

## 5. Stale ready marks

**Fix**: a ready mark on a branch ahead 0 of the base reads `ready (stale — ahead 0 of base)`, derived on every read. It
leaves `landingOrder`; `land` names it (`left out: N stale ready mark(s) … --include-stale brings them back`), and
`--include-stale` appends it. A `--select` that names one says how to bring it back.

**Acceptance**: `tests/fleet-probe-and-stale-ready.test.mjs` (`ahead 0`).

## 6. Unleased test load

**Fix (the minimum asked)**: `lease status` prints `machine CPU: N% busy across M cores` (whole-machine counters from
`os.cpus()`, sampled over 1 s; `FLEET_CPU_SAMPLE_MS=0` skips it, `FLEET_CPU_BUSY_PCT` pins it for tests) and, at 85% or
more, a WARNING that names load which took no lease. `lease run` samples after its grant and before its job starts, and
warns the same way. An unmeasured sample is a line saying so, never "idle". It names; it never says what to stop.

**Declined**: a light `test` lease kind with limited concurrency. The warning shows the case the consumer hit (test runs
that took no lease saturating the CPU while the slot read free); a second slot type would change admission for every repo
on the machine, and nothing in the report needs concurrent leased test runs. Revisit if a consumer reports that the
warning fires but they cannot serialise the runs it names.

**Acceptance**: `tests/fleet-suite-decision-cpu.test.mjs` (`machine CPU saturation`).

## Verification

- Each item's test failed on `origin/main` (`85cfbccd`) and passes here (counts above).
- The fleet suite (all `tests/fleet-*` plus the lease, CLI-entry and relocation guards) — see the PR body for the run.
