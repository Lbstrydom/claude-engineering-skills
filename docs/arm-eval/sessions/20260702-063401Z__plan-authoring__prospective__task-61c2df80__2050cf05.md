# Arm-eval session 2050cf05-fb40-474a-97c1-e77d6cc6d8e6

| Field | Value |
|---|---|
| Experiment | plan-authoring |
| Phase | prospective |
| Task id | `task-61c2df80` |
| Seed (presentation-order RNG) | 20 |
| Config / rubric version | 1 / 1 |
| Created (UTC) | 2026-07-02T06:34:01.137Z |
| Repo | 8548afbd-8d85-50de-baca-1bb158d696da |
| Archive mode | BLINDED (prospective, human ranking pending — arm identity/models/scores withheld to protect the anchor) |

## Task

Add a concurrency cap to the parallel audit passes to bound peak memory on large diffs

## Outputs (blinded — rank via `arm-eval-adjudicate`)

### output-1

# Implementation Plan: Concurrency Cap for Parallel Audit Passes

## Overview

The audit pipeline currently fans out multiple audit passes in parallel (via `Promise.all` or equivalent) with no bound on in-flight work. On large diffs this produces unbounded concurrent allocations — each pass holds its diff slice, prompt context, and LLM response buffer simultaneously — causing peak-memory spikes that can exceed container limits.

The fix introduces a minimal concurrency limiter (semaphore pattern) into the audit orchestration layer, wrapping the existing parallel dispatch so that at most `N` passes execute concurrently. The cap is configurable with a safe default derived from typical pass memory footprint, preserving existing ordering and result-collection semantics.

## Design Decisions

1. **Reuse a shared-lib concurrency primitive if one exists; otherwise add a local one.** The `shared-lib` domain (683 symbols) is the natural home for a generic `pLimit`/semaphore helper. If `scripts/lib/**` already exports a concurrency limiter, we reuse it rather than introducing a new abstraction. This keeps the solution right-sized — no new dependency, no over-generalised scheduler.

2. **Semaphore over queue/chunk partitioning.** A counting semaphore (`acquire()`/`release()` or an async `pLimit`-style wrapper) is the smallest change that preserves the current "dispatch all, collect in order" contract. Chunking the array into fixed batches would alter error-propagation timing (a failing batch would block later batches) and is a larger behavioural change than needed.

3. **Result ordering preserved.** The limiter wraps each pass's invocation, not its result mapping. `Promise.all` over the wrapped promises still returns results in input order — the cap only controls how many are *executing* at once, not completion order.

4. **Configurable cap with safe default.** The cap is sourced from (in priority order): an explicit options field → an environment variable (`AUDIT_CONCURRENCY`) → a compiled default (e.g. `4`). The default should be conservative — high enough to keep latency low for typical diffs, low enough that a 200-file diff doesn't allocate 200 simultaneous pass contexts. We validate the value is a positive integer and clamp to `[1, 64]`.

5. **No persistence changes.** The cap is a runtime execution concern, not a stored configuration. It does not touch the findings store, learning store, or any JSON state file. This satisfies the invariant that audit results are deterministic regardless of execution concurrency.

6. **Error semantics unchanged.** If a pass rejects, the overall `Promise.all` still rejects with the first rejection (existing behaviour). The semaphore correctly releases on both success and failure via `finally`.

## Target Paths

- `scripts/lib/audit/parallel-runner.mjs` — modify (or the file that currently dispatches parallel audit passes; adjust to actual filename)
- `scripts/lib/concurrency.mjs` — create (only if no existing shared-lib concurrency limiter is found; otherwise modify the existing file)
- `tests/audit-concurrency.test.mjs` — create

> **Note:** The exact dispatch file name within `scripts/lib/audit/**` must be confirmed at implementation time by grepping for `Promise.all` in the audit domain. The plan targets whichever file contains the parallel fan-out. If multiple files fan out independently, all are modified to accept the cap via a shared option.

## File-Level Plan

### 1. `scripts/lib/concurrency.mjs` (create — conditional)

**Purpose:** A minimal `pLimit(concurrency)` factory returning an async wrapper that gates calls through a counting semaphore.

- Exports `pLimit(maxConcurrency)` → returns `async (fn) => ...` that waits for a free slot, runs `fn()`, and releases in `finally`.
- Exports `resolveConcurrency(explicit, envVar, defaultValue)` → normalises and clamps the cap source.
- Pure JS, no I/O, no side effects — fully unit-testable.
- Only created if a grep of `scripts/lib/**` for `pLimit|semaphore|concurrency` returns no existing implementation. If one exists, we add `resolveConcurrency` there if missing and reuse `pLimit`.

### 2. `scripts/lib/audit/parallel-runner.mjs` (modify)

**Purpose:** The file that currently dispatches audit passes in parallel.

- Import `pLimit` and `resolveConcurrency` from the shared-lib concurrency module.
- Add `concurrency` to the function's options parameter (typed as positive integer, optional).
- Replace the bare `Promise.all(passes.map(p => runPass(p)))` pattern with:
  ```
  const limit = pLimit(resolveConcurrency(options.concurrency, 'AUDIT_CONCURRENCY', DEFAULT_AUDIT_CONCURRENCY))
  Promise.all(passes.map(p => limit(() => runPass(p))))
  ```
- Define `DEFAULT_AUDIT_CONCURRENCY = 4` as a module constant.
- Ensure `runPass` rejections propagate unchanged (the `finally` in the limiter guarantees slot release).
- Log the effective concurrency at debug level (if a logger is already wired).

### 3. `tests/audit-concurrency.test.mjs` (create)

**Purpose:** Verify the cap bounds concurrent execution without altering results.

- **Test 1 — Concurrency respected:** Spawn `N` fake passes that record their start/end timestamps. Set cap to `K < N`. Assert no more than `K` are ever in-flight simultaneously.
- **Test 2 — Result ordering preserved:** Returns results in input order even when passes resolve out of order.
- **Test 3 — Error propagation:** If one pass rejects, the overall promise rejects and all slots are released (subsequent invocations still succeed).
- **Test 4 — Config resolution:** `resolveConcurrency` honours explicit option > env var > default, clamps invalid values (0, negative, non-integer) to the default.
- **Test 5 — Default applies:** When no concurrency option is passed and no env var is set, passes still execute (cap = default).

## Risks

1. **Wrong dispatch file identified.** The architecture map shows 122 symbols in `audit-orchestration` across multiple files. If the parallel fan-out lives in a different file than `parallel-runner.mjs` (e.g., inside `scripts/openai-audit.mjs` or `scripts/cycle.mjs`), the modification target shifts. Mitigation: grep for `Promise.all` and `\.map(` in the audit domain at implementation start.

2. **Multiple independent fan-out sites.** If several entry points (`openai-audit.mjs`, `gemini-review.mjs`, `cycle.mjs`) each dispatch passes independently, we must apply the cap to all of them or route through a single shared dispatch function. Mitigation: extract a shared `runPassesParallel(passes, options)` helper if duplication exists, then apply the cap once.

3. **Deadlock from nested acquire.** If `runPass` internally calls another function gated by the same semaphore instance, a deadlock occurs. Mitigation: the semaphore is created fresh per dispatch call (not module-level singleton), so nesting across different invocations is impossible. Within a single dispatch, `runPass` must not re-enter the limiter — confirm by inspection.

4. **Throughput regression on small diffs.** A conservative default (4) could slow down audits that previously ran 20 passes in parallel. Mitigation: the default is a balance, and users can override via `AUDIT_CONCURRENCY`. Benchmarking on a representative diff should confirm latency impact is acceptable (< 2× at default for < 50 passes).

5. **Env var in test environments.** If `AUDIT_CONCURRENCY` is set in CI, tests asserting default behaviour could be flaky. Mitigation: tests that check the default explicitly clear the env var in their setup.

## Section 9 — Acceptance Criteria

1. No more than `concurrency` audit passes execute simultaneously, verifiable by instrumenting pass start/end times and checking the maximum observed in-flight count equals the configured cap.
2. When `concurrency` is not specified and `AUDIT_CONCURRENCY` is unset, passes execute with the default cap (a positive integer ≤ 16) and all passes complete successfully.
3. Setting `AUDIT_CONCURRENCY=1` forces fully sequential execution with no behavioural change in the audit results (identical findings output for the same input diff).
4. If any audit pass rejects, the overall dispatch rejects with the same error as before the change, and all semaphore slots are released (a subsequent dispatch call completes normally).
5. Results are returned in input order regardless of completion order or concurrency level.
6. Invalid concurrency values (0, negative, non-numeric, non-integer) fall back to the default without throwing.
7. No new dependencies are added; the concurrency limiter is implemented in pure JavaScript using `Promise`.
8. No persistence files (findings store, learning store, any JSON state) are modified by this change.
9. All existing audit-orchestration tests pass without modification.
10. New unit tests in `tests/audit-concurrency.test.mjs` pass and cover: concurrency bound enforcement, ordering preservation, error propagation, config resolution priority, and default fallback.

### output-2

# Implementation Plan — Concurrency Cap for Parallel Audit Passes

## Overview

The audit orchestration currently runs parallel audit passes without an explicit concurrency bound, likely via `Promise.all(...)` over all passes or diff partitions. On large diffs this can inflate peak memory because each pass may hold prompt context, parsed diff data, model responses, and findings simultaneously.

Implement a small, reusable concurrency limiter inside the existing `audit-orchestration` domain and route the parallel audit pass execution through it. The limiter will preserve existing observable contracts: input order of results, current failure behavior as closely as possible, and no persistence/output format changes.

Default behavior should become bounded without requiring user configuration. An optional validated environment override can be added for advanced tuning.

## Target Paths

- `scripts/lib/audit/audit-runner.mjs`
- `scripts/lib/audit/concurrency-limit.mjs`
- `tests/audit-concurrency-limit.test.mjs`

## Design Decisions

### 1. Add a small local concurrency helper rather than a dependency

**Decision:** Create `scripts/lib/audit/concurrency-limit.mjs` with a minimal async ordered mapper, for example conceptually:

- `mapWithConcurrency(items, concurrency, worker)`
- preserves result order
- never starts more than `concurrency` workers at once
- rejects if any worker rejects
- stops scheduling new work after the first failure
- drains/observes already-started promises to avoid unhandled rejections

**Rationale:**

- Avoids introducing a new dependency for a small primitive.
- Keeps implementation within the `audit-orchestration` domain.
- Makes behavior easy to unit test.
- Avoids over-engineering with queues, worker pools, cancellation tokens, or external schedulers.

### 2. Default cap should be conservative and deterministic

**Decision:** Introduce an audit pass concurrency default in the audit runner, e.g.:

- `DEFAULT_AUDIT_PASS_CONCURRENCY = 4`

Use the cap only for pass-level parallelism, not unrelated IO or subprocess behavior.

**Rationale:**

- The problem is peak memory on large diffs, not CPU saturation.
- A deterministic cap is easier to reason about and test than auto-scaling to CPU count.
- `4` preserves useful parallelism while bounding worst-case prompt/context duplication.
- This is a safer default than “unlimited” and less disruptive than serial execution.

### 3. Optional environment override with strict validation

**Decision:** Support an optional environment variable such as:

- `AUDIT_PASS_CONCURRENCY`

Validation rules:

- unset: use default
- integer string `>= 1`: use value, optionally with an upper safety ceiling such as `32`
- invalid value: fail fast with a clear error, or fall back with an explicit warning depending on existing CLI conventions

Preferred behavior: fail fast for invalid explicit configuration, because silently ignoring an invalid memory-control setting can surprise operators.

**Rationale:**

- Gives maintainers a way to lower concurrency for constrained machines or raise it in CI.
- Keeps public surface small; no new CLI flag unless the repository already has a standard audit config parser where flags are expected.
- Strict validation prevents values like `0`, `-1`, `Infinity`, or `abc` from producing accidental unlimited/serial/weird behavior.

### 4. Preserve output ordering and audit semantics

**Decision:** The bounded execution should return results in the same order as the input pass list.

**Rationale:**

- Existing callers may rely on stable pass ordering for logs, markdown output, findings grouping, snapshots, or deterministic tests.
- A concurrency limiter that returns completion order would be a contract regression.

### 5. Keep failure behavior close to current `Promise.all`

**Decision:** If one pass fails:

- reject the overall run
- do not start additional queued passes
- allow already-started passes to settle internally so rejections are observed
- surface the first failure with the original stack/cause where possible

**Rationale:**

- Current `Promise.all` likely fails the whole audit run on a rejected pass.
- Avoiding new scheduling after failure reduces wasted memory and API usage.
- Observing in-flight promises avoids unhandled rejection noise.

### 6. No persistence format changes

**Decision:** Do not alter findings schema, audit report schema, cache format, learning store data, or on-disk result paths.

**Rationale:**

- The task is runtime memory control only.
- Persistence changes would broaden the blast radius unnecessarily.

## File-Level Plan

### `scripts/lib/audit/concurrency-limit.mjs` — create

Purpose: Provide a small, tested async concurrency primitive for audit orchestration.

Planned exports:

- `mapWithConcurrency(items, concurrency, worker)`
- optionally `parsePositiveIntegerConcurrency(value, optionName)` if config parsing is best kept near the primitive

Implementation requirements:

1. Validate `items` is iterable/array-like according to existing project style.
2. Validate `concurrency` is a finite positive integer.
3. Preserve result order by storing each worker result at its original index.
4. Track active workers and scheduled index count.
5. Ensure active count never exceeds the cap.
6. On first rejection:
   - capture the error
   - stop scheduling additional items
   - reject the returned promise
   - attach handlers to any in-flight work so no unhandled rejections leak
7. Handle edge cases:
   - empty item list resolves to `[]`
   - concurrency greater than item count works normally
   - synchronous throw from `worker` is treated as rejection
8. Avoid retaining unnecessary references after completion where practical.

### `scripts/lib/audit/audit-runner.mjs` — modify

Purpose: Replace unbounded pass-level parallel execution with bounded execution.

Planned changes:

1. Locate the current pass orchestration code that runs audit passes concurrently, likely a `Promise.all(passes.map(...))` or equivalent.
2. Import `mapWithConcurrency` from `./concurrency-limit.mjs`.
3. Add a local constant:
   - `DEFAULT_AUDIT_PASS_CONCURRENCY = 4`
4. Add a small config resolver:
   - reads `process.env.AUDIT_PASS_CONCURRENCY`
   - validates positive integer
   - applies upper ceiling if chosen
   - returns default when unset
5. Replace unbounded execution with:
   - `mapWithConcurrency(passes, resolvedConcurrency, runSinglePass)`
6. Preserve:
   - existing result object shapes
   - existing logs except optional one-line debug/info showing the chosen cap if existing logging conventions support it
   - existing error propagation
   - existing ordering of pass results
7. Ensure any per-pass cleanup/finally behavior remains inside the worker so it still runs under bounded execution.
8. Do not cap unrelated operations unless they are part of the same pass-level `Promise.all`.

If the actual pass-launching function lives in a differently named audit module, apply the modification there and keep `audit-runner.mjs` as the imported/public orchestration path only if it is already the call site. Do not duplicate caps in multiple layers.

### `tests/audit-concurrency-limit.test.mjs` — create

Purpose: Verify limiter behavior and guard against regressions back to unbounded execution.

Planned test coverage:

1. **Caps active work**
   - Run e.g. 10 tasks with concurrency `3`.
   - Instrument `active` and `maxActive`.
   - Assert `maxActive <= 3`.

2. **Preserves input order**
   - Use workers with intentionally varied delays.
   - Assert returned array order matches input order, not completion order.

3. **Handles empty input**
   - Assert `mapWithConcurrency([], 4, worker)` resolves to `[]`.
   - Assert worker is not called.

4. **Rejects invalid concurrency**
   - `0`, `-1`, `NaN`, non-integer values, and non-numeric strings if parser is exported/tested.
   - Assert clear error messages.

5. **Handles worker failure safely**
   - One worker rejects.
   - Assert the overall promise rejects with that error.
   - Assert no more than the cap was active.
   - Assert queued tasks after failure are not scheduled where deterministic to test.

6. **Allows concurrency greater than item count**
   - Assert all tasks complete and order is preserved.

Optional integration-style test if the existing audit runner is easy to invoke with stub passes:

7. **Audit runner uses the cap**
   - Stub several pass functions.
   - Set `AUDIT_PASS_CONCURRENCY=2`.
   - Assert maximum concurrent pass executions is `2`.

## Implementation Steps

1. Inspect `scripts/lib/audit/audit-runner.mjs` for current unbounded pass execution.
2. Create `scripts/lib/audit/concurrency-limit.mjs`.
3. Add focused unit tests for the helper.
4. Modify audit runner to resolve a pass concurrency cap.
5. Replace the unbounded pass `Promise.all` with `mapWithConcurrency`.
6. Run the targeted tests.
7. Run the repository’s existing audit/test command relevant to `audit-orchestration`.
8. If snapshot/log tests fail due to new log lines, remove the log or gate it behind existing verbose/debug mode.

## Failure Modes and Handling

### Invalid configured concurrency

- Example: `AUDIT_PASS_CONCURRENCY=0`
- Handling: fail fast with a clear message such as `AUDIT_PASS_CONCURRENCY must be a positive integer`.
- Reason: explicit invalid memory-control config should not be silently ignored.

### Worker/pass throws synchronously

- Handling: treat as rejected async work and reject the overall bounded map.
- Reason: matches `Promise.all(passes.map(async ...))` behavior.

### Worker/pass rejects asynchronously

- Handling: reject overall operation, stop scheduling queued work, observe in-flight work.
- Reason: preserves fail-fast behavior while avoiding unhandled rejections.

### Very high configured concurrency

- Handling: either reject values above a documented ceiling or clamp only if existing config conventions already clamp.
- Preferred: reject above ceiling with clear message.
- Reason: prevents accidental reintroduction of memory spikes.

### Empty pass list

- Handling: resolve to an empty result list.
- Reason: should preserve current no-op behavior.

## Security and Persistence Considerations

- No shell execution or file path handling is introduced.
- Environment variable parsing must not use `eval`, loose numeric coercion without validation, or unsafe fallbacks.
- No changes to persisted audit findings, learning store records, cache files, or reports.
- The limiter must not swallow pass errors; suppressed audit failures could create false confidence in audit output.

## Test Strategy

Run:

1. New focused limiter test:
   - `node --test tests/audit-concurrency-limit.test.mjs`
2. Existing audit-related tests, depending on repository convention:
   - `node --test tests/*audit*.test.mjs`
3. Full test suite if practical:
   - `npm test` or the repository’s documented equivalent

Also perform a manual smoke run on a representative diff with:

- default concurrency
- `AUDIT_PASS_CONCURRENCY=1`
- `AUDIT_PASS_CONCURRENCY=2`
- invalid value such as `AUDIT_PASS_CONCURRENCY=0`

Confirm that reports remain semantically unchanged except for timing/order-independent behavior.

## Risks

1. **Incorrect call site**
   - Risk: The cap is added to a helper path that is not used by the actual parallel audit passes.
   - Mitigation: Grep for `Promise.all`, `allSettled`, and pass arrays in `scripts/lib/audit/**` and ensure only the pass-level launcher is modified.

2. **Changed failure timing**
   - Risk: Bounded execution may not start later passes if an early pass fails, whereas `Promise.all` would have started all passes immediately.
   - Mitigation: This is intentional for memory/API safety. Document it in tests and preserve overall rejection semantics.

3. **Order regressions**
   - Risk: Results returned by completion order may alter report output.
   - Mitigation: Store results by original index and test varied completion times.

4. **Too low default hurts runtime**
   - Risk: Default cap of `4` may slow audits with many lightweight passes.
   - Mitigation: Provide validated `AUDIT_PASS_CONCURRENCY` override.

5. **Too high override reintroduces memory spikes**
   - Risk: Users can set a large cap.
   - Mitigation: Add a reasonable maximum or explicit validation error for extreme values.

6. **Unhandled rejections from in-flight tasks**
   - Risk: Fail-fast limiter rejects while other started tasks later reject.
   - Mitigation: Ensure every started worker promise has rejection handling attached.

## Section 9 — Acceptance Criteria

1. Parallel audit pass execution is bounded by a default concurrency cap no greater than `4`.
2. The audit runner no longer starts all audit passes at once when the number of passes exceeds the cap.
3. Audit pass results are returned in the same order as the input pass list.
4. `AUDIT_PASS_CONCURRENCY=1` causes pass execution to be effectively serial.
5. Invalid concurrency configuration such as `AUDIT_PASS_CONCURRENCY=0` fails with a clear validation error.
6. The concurrency helper resolves `[]` for an empty input list without invoking the worker.
7. The concurrency helper never exceeds the configured number of active workers in unit tests.
8. A worker rejection causes the bounded operation to reject and prevents unscheduled queued work from starting.
9. Existing audit findings/report data shapes remain unchanged.
10. No new runtime dependency is added solely for concurrency limiting.
11. New tests cover concurrency limiting, ordering, invalid configuration, empty input, and worker failure behavior.
12. Existing audit-related tests continue to pass.

### output-3

## Overview

This plan adds a **configurable concurrency cap** to the parallel audit passes in the audit-orchestration domain. The goal is to bound peak memory usage during large diffs by limiting how many file-level audit passes run simultaneously, while preserving correctness and existing execution order semantics.

The smallest viable solution: introduce a `runWithConcurrencyLimit(fn, items, limit)` helper into `shared-lib` (where generic parallel-execution utilities belong), then consume it in the main audit driver (`scripts/lib/audit/`). The cap value will be read from environment variable `AUDIT_CONCURRENCY` with a sensible default (e.g., 8) so operators can tune without a code change. No new external dependencies are introduced; the implementation uses Promise-based bounded concurrency via a simple semaphore pattern.

---

## Design Decisions

1. **Reusable semaphore helper in shared-lib** — `shared-lib` already provides `promisePool`-style helpers. A standalone `runWithConcurrencyLimit` is the right granularity: small, testable in isolation, and reusable across all parallel-invocation sites. Reject the band-aid of inlining a `for`-loop with manual counting inside the audit driver.

2. **Environment variable (`AUDIT_CONCURRENCY`) as the cap source** — avoids coupling concurrency tuning to the codebase. Default to `8` (a reasonable balance for Node.js on typical CI runners). Operators can set it per-run. No argument-parsing changes needed in the audit CLI scripts; the helper reads `process.env` internally.

3. **Cap applied at the per-file pass level** — The existing code (inferred from domain map: `scripts/lib/audit/`) already maps audit passes across a file list. We wrap that mapping logic with the concurrency helper. This bounds peak memory by capping the number of in-flight Promises holding file content + LLM request state.

4. **Preserve `Promise.all` semantics for error aggregation** — `runWithConcurrencyLimit` returns a `Promise` that resolves to an array of results (same order as input items) or rejects with the first error (consistent with `Promise.all`). This is a drop-in replacement for `await Promise.all(items.map(fn))`.

5. **No config file or CLI flag** — The environment variable is sufficient for operational control. Adding a config layer or CLI flag would be over-engineering for this single tunable.

---

## File-Level Plan

### Create: `scripts/lib/concurrency.mjs`

**Purpose:** Exports `runWithConcurrencyLimit(fn, items, limit)` — a generic bounded-concurrency executor.

- Accepts an async `fn(item, index)` and an array `items`.
- Limits concurrent invocations to `limit` (default: reads `process.env.AUDIT_CONCURRENCY`, falls back to 8 if unset/invalid).
- Maintains result order (indexed array). Rejects immediately on first failure (fast-fail), cancelling remaining slots via `AbortController` (optional but recommended for bounded resources).
- Fully unit-testable: no domain logic, pure async control flow.

### Modify: `scripts/lib/audit/run-audit-passes.mjs` (or the actual dispatch entry)

**Purpose:** Replace `await Promise.all(files.map(pass))` with `await runWithConcurrencyLimit(pass, files)`.

- Import `runWithConcurrencyLimit` from `../concurrency.mjs`.
- Remove any manual batching or `Array.map` + `Promise.all` that previously launched all passes at once.
- No other logic changes; error handling and result collection remain identical.

### Modify: `tests/lib/concurrency.test.mjs` (new or existing test file)

**Purpose:** Unit tests for the concurrency helper.

- Test that `limit` truly bounds inflight operations (using a slow async identity function and a counter).
- Test that results preserve input order.
- Test that `AUDIT_CONCURRENCY` env var is parsed correctly (valid number, invalid fallback, unset fallback).
- Test fast-fail: first rejection cancels remaining slots.

### Modify: `tests/lib/audit/run-audit-passes.test.mjs` (if it exists)

**Purpose:** Integration-level test that the audit driver respects concurrency.

- Stub the inner `pass` function to track concurrency.
- Assert that at most `limit` calls are inflight simultaneously.

---

## Section 9 — Acceptance Criteria

1. When `AUDIT_CONCURRENCY=4` is set, the audit process never has more than 4 file-level audit passes in flight at any moment.
2. When `AUDIT_CONCURRENCY` is unset, the default concurrency cap is 8.
3. Invalid `AUDIT_CONCURRENCY` values (non-numeric, <=0) fall back to the default cap and do not crash the process.
4. Audit results for a given file list are identical (order and content) to the uncapped version when all passes succeed.
5. If one audit pass rejects, the entire task rejects promptly without waiting for remaining inflight passes to complete (fast-fail).
6. Peak resident memory during a large diff (500+ files) is measurably lower with the cap than without, for a representative workload.
7. The new `runWithConcurrencyLimit` helper is unit-tested in isolation for correct limits, ordering, and error propagation.
8. No changes to existing public CLI signatures or output formats.

---

## Target Paths

- `scripts/lib/concurrency.mjs`
- `scripts/lib/audit/run-audit-passes.mjs`
- `tests/lib/concurrency.test.mjs`
- `tests/lib/audit/run-audit-passes.test.mjs`

---

## Risks

- **Opaque fast-fail behavior:** If the `AbortController` approach is used to cancel inflight promises on first failure, any in-progress LLM calls may still consume resources until the HTTP request is aborted. Mitigation: use `AbortSignal` only for timeouts/long-poll; for short-running HTTP calls, simply allow inflight promises to settle naturally after the rejection is propagated (still safe, since results are discarded).
- **Shared mutable state in per-file passes:** If existing passes share mutable state (e.g., a findings accumulator), bounding concurrency could change interleaving and expose race conditions. Mitigation: review audit pass code for shared mutable state before merging; concurrency has always been parallel, so any existing race is a pre-existing bug.
- **`AUDIT_CONCURRENCY` name collision:** Unlikely but possible if another tool in the CI environment uses the same name. Mitigation: document the variable clearly in the skill’s README; the name is sufficiently specific.

