# Plan: fleet train id collision within one second (CI flake, run 44940239208)
- **Date**: 2026-11-21
- **Status**: In progress — implemented on branch claude/fleet-trainid-collision-9f2c, awaiting audit
- **Author**: Claude + Louis
- **Scope**: backend (Node CLI, `scripts/lib/fleet/**`). Stack `js-ts`.
- **Target domain(s)**: `fleet`

## 1. Context Summary

`tests/fleet-rollup.test.mjs` "an unreadable or malformed answer AFTER the close…"
failed on CI (blocking an unrelated PR) with `refusing to overwrite populated manifest
field "createdAt" on t-20261121192943-1901; build a new train`. `superseded()` builds two
rollups back to back.

**Root cause (measured, not inferred).** `newTrainId` (`registry.mjs`) is
`t-<UTC second>-<crypto.randomBytes(2) hex>`: the suffix is 16 RANDOM bits, not
clock-derived. Two builds in the same second draw the same id with probability 1/65536;
`train.mjs` then called `writeTrain` with an id that already held a manifest, and
`writeTrain` correctly refused to overwrite — an error that looks like a bad train when
nothing is wrong with it. This is a production hazard, not a fixture artefact: any two
`fleet land` builds inside one second can hit it.

## 2. Design

`mintTrainId(dir, now, {attempts=16})` draws via `newTrainId`, checks
`trainPath(dir, id)` and redraws on an existing manifest; after the bound it throws
`TRAIN_ID_EXHAUSTED` rather than overwrite. `train.mjs` mints through it. Callers already
hold `trains/.lock`, so check-then-write cannot race.

*Band-aid considered:* fix only the fixture (sleep/inject a clock). Rejected: the same
collision exists in production. *Over-built considered:* a monotonic counter or a longer
suffix. Rejected: a longer suffix only lowers the odds, and a counter needs shared state;
the registry itself is the oracle for "taken".

## 3. Acceptance criteria

- A1. With the train-id draw forced to collide inside one second, the second build gets
  a fresh id (red before the fix with the exact CI error, green after).
- A2. `mintTrainId` skips a taken id, uses a free first draw unchanged, and throws
  `TRAIN_ID_EXHAUSTED` instead of overwriting when no id is free.
- A3. `fleet-registry` and `fleet-rollup` suites stay green (70/70).
