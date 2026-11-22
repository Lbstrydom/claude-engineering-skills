# Plan: fleet feedback cluster 4 — a ready mark on a test subset, then a red train (#5)
- **Date**: 2026-11-22
- **Status**: In progress — plan audited (2 GPT rounds + Gemini), implemented on claude/fleet-cluster4-shared-surface
- **Author**: Claude + Louis
- **Scope**: backend (Node CLI, `scripts/lib/fleet/**`, `.fleet.json`). Stack `js-ts`.
- **Target domain(s)**: `fleet`

## 1. Context Summary

Work-consumer feedback #5: sessions mark `ready` after running a SUBSET of tests, then the train goes red, because the files
they changed (a shared fixture, a test helper, a contract) are loaded by suites the subset never ran. `fleet next` and `ready` should
require or recommend the fast tier when shared contracts or fixtures are touched.

Code trace (read at `aaddcc5c`): `cmdReady` (`commands.mjs`) records `ready: {oid, at}` only; the `readyChecks` hook (`facts.mjs`) can
refuse a ready but only for a consumer-written check, and nothing records whether any test ran. `deriveObligations`
(`obligations.mjs`) already receives `myFiles` for `next`. `.fleet.json` is parsed by a strict zod schema (`config.mjs`) and
`resolveConfig` re-maps each key by hand.

Constraints from the coordinator: do not edit `test-tier.mjs`, `ci-verdict.mjs`, `ci-flake-rerun.mjs` or the coordinator playbook; `ready`
carries no verification evidence; the two helpers `tests/helpers/fleet-serial-fx.mjs` and `tests/helpers/git-fixture-env.mjs` are in the shared set.

## 2. Design

**Recommend, never require.** `ready` records an oid, not a test run, so there is no evidence a gate could check: requiring would block
every ready or none. The honest mechanism is a loud recommendation at the two checkpoints a session reads (`ready`'s output and
`next`), naming the files and the command, and saying plainly that fleet cannot tell whether it was run. The train's own tiers stay
the authority (they are what the red train was).

- `.fleet.json` `sharedSurfaces: {globs?, run?}`, each field resolved independently: `globs` are claim-grammar patterns (validated like
  `hotFiles`; omitted → the defaults `tests/helpers/**`, `tests/fixtures/**`; `[]` turns the advice off); `run` is an argv array (never a
  shell string; omitted → no command is named and the message says the repo defines its own). CES sets `globs` to the two defaults plus
  `scripts/gate-contracts/**`, `.test-tiers.json`, `scripts/lib/fleet/contracts.mjs` (the two helpers the coordinator named sit under
  `tests/helpers/**`), and `run: ["npm", "run", "guards:preflight"]`.
- **What `guards:preflight` does and does not cover (audit H4).** It runs the static gates plus the 31 guard test files; it does NOT run
  the fleet suites that load `fleet-serial-fx.mjs`/`git-fixture-env.mjs`, which is exactly the red-train case. So the command is a floor,
  and the recommendation leads with the part that closes the gap: **the test files that actually load the changed shared files**
  (`testsLoading`: a reverse walk of the static import graph over EVERY tracked script — tests, helpers and production modules, so a shared
  contract under `scripts/` reaches the tests that import it through other modules — plus literal dynamic imports, and any script that names a
  changed path as a string, which is itself a seed (a helper naming a fixture reaches the tests that import the helper)), printed as one
  runnable `node --test <files>` for the first 10 with the exact count; **the complete set is always in the JSON** (`sharedSurface.tests`) and
  the text says so when it is capped; then the configured `run`. It is
  best-effort and says so: a computed `import()` or a path built at run time is not followed, an unreadable test file is counted
  (`unread`), and a reach that could not be computed is stated, never dropped.
- **One changed-path contract (audit H2).** `ready` and `next` both read `changedFiles(base, tip)` (`git diff --name-only -z --no-renames
  base...tip`: from the merge-base, so a base that advanced is not counted; a rename lists both endpoints and a deletion is listed). `ready`
  asks it of the exact oid it records; `next` uses `myFiles`, which is that same list for the branch tip plus uncommitted files.
- **Unavailable is a result, not an empty list (audit H3).** If the base is unmeasured or the diff could not be read, `ready` prints `note:
  shared test files were not checked (<why>)` and carries `sharedSurface.checked:false`; `next` carries `shared-surface-unmeasured` (info) when
  `filesUnknown` is non-empty. Both stay non-blocking. `globs: []` (off) suppresses the notes too.
- `shared-surface.mjs` (pure): `sharedSurfaceTouched(files, cfg)` and `sharedSurfaceLine(touched, cfg, cmd)`; names capped at 6 with an exact
  count, control characters rendered visibly (`printable`), the command rendered through `renderCommand`.
- `ready`: the branch changed files (see the contract above) are matched; the line is printed and the JSON carries
  `sharedSurface: {checked, touched, run, tests}`. Never blocks.
- `next`: `deriveObligations` raises `shared-surface` as **info** (a DO nobody can clear would nag forever), not for a retired session.
  An old caller passing no config gets the defaults.
- `resolveConfig` carries the key through (it re-maps by hand; the first test run showed a silently dropped key falls back to defaults).
*Band-aid considered:* a hard `ready` refusal keyed on touched files. Rejected: no evidence exists to clear it, so it would only teach
sessions to ignore it. *Over-built considered:* recording a test-run attestation in the registry. Rejected here: a new evidence schema
and a trust problem (a session attests its own run) for a recommendation the train already backstops.

## 3. Acceptance criteria

- A1. A branch changing a file under a shared glob gets the recommendation from `ready` (text and JSON) and from `next` (info), and is
  still marked ready; a branch changing only ordinary source gets none.
- A2. The two named helpers match under the defaults and under the CES `.fleet.json`; `globs: []` disables; an unknown inner key, a bad
  glob or a shell-string `run` is a config error.
- A3. The line names files and the command safely (cap, control characters, quoting) and says fleet cannot verify the run.
- A4. `resolveConfig` carries `sharedSurfaces` through; callers that pass no config keep the defaults.

## 4. Files

`scripts/lib/fleet/shared-surface.mjs` (new), `tests/fleet-cluster4-reach.test.mjs`, `scripts/lib/fleet/config.mjs`, `scripts/lib/fleet/commands.mjs` (`ready`),
`scripts/lib/fleet/obligations.mjs`, `scripts/lib/fleet/coordination.mjs` (`next`), `.fleet.json`, `tests/fleet-cluster4.test.mjs`.
