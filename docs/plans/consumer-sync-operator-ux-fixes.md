# Plan: Four consumer-sync operator-UX fixes (wine coordinator report, 2026-11-15)

- **Date**: 2026-11-15
- **Status**: Complete — audit-code: 6 GPT rounds (cap reached, structural card 0 structural / 30 polish), Gemini final gate APPROVE round 1
- **Author**: Claude + Louis
- **Scope**: backend (sync/setup CLIs + their libs; no UI)
- **Target domain(s)**: `sync`, `shared-lib`, `tests`

## Context

After the 2026-11-15 wine sync and its `cli` → `sdk` backend switch, the wine (WCA) coordinator reported four
defects. Each was checked against the source before being fixed. Every fix is in the consumer sync contract
(AGENTS.md Testing doctrine, Tier 3), so each lands with a test that fails on the pre-fix source.

## 1. Merge policy lives in the consumer registry

**Defect.** `sync:pr` armed squash auto-merge unless the operator passed `--no-merge`. wine's rule is that its
coordinator merges sync PRs, and wine#1380 auto-merged when the flag was forgotten. The PR body also always
claimed "Squash auto-merge is armed".

**Fix.**
- `scripts/lib/consumer-repos.mjs`: an optional `merge: 'auto' | 'manual'` field on a registry entry (absent =
  `auto`). wine is `manual`. Local-registry entries are validated, not defaulted, so a typo fails closed. A local
  entry that repoints a base entry keeps the base entry's policy unless it declares its own. `mergePolicyOf(entry)`
  is the one reader.
- `scripts/sync-pr.mjs`: `--merge` / `--no-merge` are explicit overrides; passing both is refused. With neither,
  the registry entry decides (`resolveMergeDecision`). Each consumer prints
  `merge: … (decided by <source>)`, and the final note names the source.
- `scripts/lib/sync-pr.mjs`: `buildPrText` takes `autoMerge`, so a manual consumer's PR body does not claim
  auto-merge.

**Tests.** `tests/sync-pr.test.mjs` covers the decision table and wine's registry entry.
`tests/sync-pr-git.test.mjs` runs the real CLI against git: a manual entry makes no `gh pr merge` call and its body
claims no auto-merge; an entry with no policy still arms auto-merge (the negative control); `--merge` overrides.

## 2. The Claude backend in effect, and the layer that set it

**Defect.** Learning that `CLAUDE_BACKEND=cli` was in effect meant tracing the launch env, the repo `.env` and
`~/.audit-loop.env` by hand.

**Fix.**
- `scripts/lib/claude-backend-name.mjs` (new, dependency-free): `VALID_BACKENDS` and `parseBackendName`, the one
  reading of a raw value. `anthropic-client.mjs`'s `resolveBackend` reads through it.
- `scripts/lib/env-provenance.mjs`: `claudeBackendProvenance(layers)` resolves `CLAUDE_BACKEND` with the existing
  `resolveVariable` precedence and returns one line: the backend name plus `launch environment` / `.env` /
  `~/.audit-loop.env` / `default`, and any lower layer it overrides, by backend name. An unrecognised value is
  withheld and WARNs. `reportEnvProvenance` (check-setup's "Environment provenance" section) prints it.
- No other value from those files is printed.

**Tests.** `tests/env-provenance.test.mjs`: each layer and the default are named, an override is reported by
backend name, a secret-shaped value in another key or an invalid backend value is never echoed.

## 3. Whether a stale dry-run state is safe to apply

**Defect.** `sync-to-repos --dry-run` ended `UNMEASURED … (would-fast-forward)` and said its counts were read
against a base it could not establish. That is true of the COUNTS, but it said nothing on whether a real run would
apply. The real run then fast-forwarded and applied cleanly.

**Fix.** `scripts/lib/sync-base-lag.mjs`: `realRunVerdictOf(plan)` maps the same `planBaseLag` result the real
run's executor switches on (`proceed` / `fast-forward` → yes, `refuse` → NO plus its remedy,
`unchecked` / `proceed-stale` → UNKNOWN / only on purpose). It adds no second classifier. `enforceBaseLag` returns it
as `applyVerdict`. `describeUnmeasuredTargets` prints it under each unmeasured target in a dry run.

**Tests.** `tests/sync-base-lag.test.mjs`: for clean-stale, dirty-stale and current states on real git, the dry
run's `safe` equals the real run's `ok` on the same state. An unreachable origin is UNKNOWN. The CLI summary
carries the line for both would-fast-forward and refused states.

## 4. The sync's own run artifacts are not "no longer synced"

**Defect.** The dry run advised `scripts/.sync-owned.json` and `.sync-receipt.json` as "no longer synced … likely
renamed upstream" and counted their citations. The same session's `sync:pr` then committed both as sync-owned.
The GC signal was the wrong one. `patchManifestWithExtraHashes` records both in the consumer manifest after the
payload, so the next run's prior manifest holds them while its payload destinations do not, and
`planGarbageCollection` read the difference as orphans.

**Fix.** `scripts/lib/sync-gc.mjs`: `SYNC_RUN_ARTIFACTS` is the one list of files every sync writes after its
payload. `planGarbageCollection` skips them, and `sync-to-repos.mjs` builds the manifest patch from the same list.

**Tests.** `tests/sync-run-artifacts-not-orphans-e2e.test.mjs` has a planner unit test with a negative control (a
genuinely retired tracked file is still advised), and two real syncs into a fixture consumer. The second sync, both
dry and real, advises neither artifact.

## Out of scope

- No real sync is run against any consumer. The PR is opened, not merged.
- `scripts/lib/fleet/consumer-bundle.mjs` still prints `--no-merge` in its handover commands. It is an explicit
  override and remains correct.
