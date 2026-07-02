# Arm-eval session 2e6098ec-934c-4491-aaf2-6dd4c8acac8a

| Field | Value |
|---|---|
| Experiment | plan-authoring |
| Phase | prospective |
| Task id | `task-93d6c711` |
| Seed (presentation-order RNG) | 12 |
| Config / rubric version | 1 / 1 |
| Created (UTC) | 2026-07-02T05:45:57.114Z |
| Repo | 8548afbd-8d85-50de-baca-1bb158d696da |
| Archive mode | BLINDED (prospective, human ranking pending — arm identity/models/scores withheld to protect the anchor) |

## Task

Add a per-repo rate limiter to the architectural-memory embedding calls to avoid quota bursts

## Outputs (blinded — rank via `arm-eval-adjudicate`)

### output-1

# Implementation Plan: Per-Repo Rate Limiter for Architectural-Memory Embedding Calls

## Overview

Add a token-bucket rate limiter that wraps architectural-memory embedding API calls, keyed per repository, to prevent quota bursts. The limiter persists its state to disk so that repeated CLI invocations for the same repo share a single bucket. The design is intentionally minimal: one new utility module in shared-lib, one integration point at the embedding call site, and one test file. No external dependencies are introduced.

## Design Decisions

### 1. Token bucket algorithm
**Rationale**: Token bucket allows small bursts (up to capacity) while enforcing a steady average rate. It is simpler than sliding-window or leaky-bucket for this use case, and naturally handles the bursty pattern of batch embedding generation—process many symbols, then idle. The refill rate maps directly to the embedding API's requests-per-minute quota.

### 2. Per-repo keying with separate state files
**Rationale**: Each repository gets its own bucket so that processing repo A does not consume repo B's quota. Using one state file per repo (`<stateDir>/<hash(repoKey)>.json`) avoids cross-repo file contention and keeps individual state files tiny. The repo key is provided by the caller (the embedding module), derived from the target repo path or identifier already available in that module's context.

### 3. File-based state persistence with atomic writes
**Rationale**: The tool runs as short-lived CLI processes. Without persistence, each invocation starts with a full bucket, defeating rate limiting across runs. State is saved on every token consumption using an atomic write (temp file + `fs.rename`) to prevent corruption from partial writes. This satisfies the codebase's persistence invariants (REQ-persistence-6623d196, REQ-persistence-d8f9613d) and follows the same `atomicWrite` pattern already used in `scripts/symbol-index/drift.mjs`.

### 4. In-process serialization via promise chain
**Rationale**: Node.js is single-threaded but async. Multiple concurrent `acquire()` calls could read stale token counts between the read and the write. Serializing via a promise chain ensures each acquire observes the state left by the previous one. This is simpler than a mutex library and sufficient for single-process use.

### 5. Environment-variable configuration with safe defaults
**Rationale**: Rate and burst parameters vary by API tier and deployment. Defaults (50 req/min, burst 5) are conservative enough for typical embedding APIs. Override via `ARCH_MEM_EMBEDDING_RPM` and `ARCH_MEM_EMBEDDING_BURST` env vars. No config file is needed—keeps the footprint minimal and consistent with how other scripts in this repo handle configuration.

### 6. Fail-open on state-file errors, fail-wait on rate exhaustion
**Rationale**: If the state file is corrupt or unwritable, the limiter starts with a full bucket and continues in-memory (fail-open). This avoids blocking the workflow due to I/O issues. When rate is exhausted, the limiter waits (sleeps) until a token refills rather than rejecting the call—embedding calls are not optional, so rejection would halt the pipeline. The wait _is_ the rate-limiting mechanism.

### 7. Injectable clock and sleep for testability
**Rationale**: Time-dependent logic is hard to test with real timers. The factory accepts `now()` and `sleep()` functions, defaulting to `Date.now()` and `timers/promises` `setTimeout`. Tests inject fast-forwarding mocks to verify rate enforcement without real delays.

### 8. No external dependencies
**Rationale**: The rate limiter uses only Node.js built-ins (`fs`, `path`, `crypto`, `timers/promises`). Adding a rate-limiting library (e.g., `bottleneck`, `p-limit`) would be over-engineering for a token bucket that is ~60 lines of logic.

### 9. Domain placement: shared-lib
**Rationale**: The rate limiter is a general utility, not specific to arch-memory. Placing it in `scripts/lib/rate-limiter.mjs` (shared-lib domain) allows any domain to use it—shared-lib is a permitted dependency for arch-memory, stores, and most other domains per the `allowedDeps` map. No layering violation is introduced.

### 10. Module-level singleton cache
**Rationale**: If the embedding module is called from multiple code paths in the same process, they should share the same bucket per repo. A `Map`-based cache keyed by `repoKey:stateDir` ensures a single limiter instance per repo per process. This avoids accidental parallel buckets for the same repo.

## File-Level Plan

### 1. `scripts/lib/rate-limiter.mjs` — CREATE
**Domain**: shared-lib (path rule: `scripts/lib/**`)

**Purpose**: Token bucket rate limiter with per-repo keying, file persistence, and injectable time functions.

**Exports**:
- `createRateLimiter(options)` → `{ acquire, getState }`
  - `options.repoKey` (string, required): repository identifier
  - `options.stateDir` (string, required): directory for state files
  - `options.rate` (number, optional): tokens per second; default from `ARCH_MEM_EMBEDDING_RPM` env or `50/60`
  - `options.burst` (number, optional): max tokens; default from `ARCH_MEM_EMBEDDING_BURST` env or `5`
  - `options.now` (function, optional): returns current time in ms; default `Date.now`
  - `options.sleep` (function, optional): `(ms) => Promise<void>`; default from `timers/promises`
- `getRateLimiter(options)` → same return, cached by `repoKey:stateDir` (singleton factory)

**Internal logic**:
- State file path: `path.join(stateDir, crypto.createHash('sha1').update(repoKey).digest('hex').slice(0, 16) + '.json')`
- `_loadState()`: read file; on missing/corrupt, return `{ tokens: burst, lastRefill: now() }` + warn
- `_saveState(state)`: write JSON to temp file in same dir, then `fs.rename` (atomic on same filesystem)
- `_refill(state)`: `state.tokens = min(burst, state.tokens + (now() - state.lastRefill) / 1000 * rate); state.lastRefill = now()`
- `acquire()`: chained promise → refill → if `tokens >= 1` consume + persist + return → else `await sleep((1 - tokens) / rate * 1000)` → retry

**Error handling**:
- Corrupt state file: `console.warn`, start full bucket
- State dir missing: attempt `fs.mkdir(stateDir, { recursive: true })`; if that fails, continue in-memory + warn
- Write failure: warn, continue in-memory
- Invalid rate/burst (≤ 0, NaN): clamp to minimums (`rate ≥ 0.01`, `burst ≥ 1`)

### 2. `scripts/lib/store/embeddings.mjs` — MODIFY (assumed path; see Risk 5)
**Domain**: stores (path rule: `scripts/lib/store/**`)

**Purpose**: Integration point—wrap each embedding API call with `await limiter.acquire()`.

**Changes**:
- Import `getRateLimiter` from `../rate-limiter.mjs`
- Before the existing embedding API call (the `fetch`/SDK invocation), add:
  ```js
  const limiter = getRateLimiter({ repoKey, stateDir });
  await limiter.acquire();
  ```
- `repoKey`: derived from the repo path or identifier already available in the module's context (the module already knows which repo it's processing)
- `stateDir`: use the existing state directory pattern used by other store modules (e.g., alongside other `.json` state files). If no canonical state dir exists, default to `path.join(repoRoot, '.arch-state', 'rate-limits')`
- No changes to the embedding API call itself, its error handling, or its return value—the limiter is a pre-call gate only

**Note**: If the actual embedding call site is in a different file (e.g., `scripts/lib/symbol-index/embeddings.mjs` in the arch-memory domain, or a shared client in `scripts/lib/`), the same 3-line integration pattern applies. The rate-limiter module is domain-agnostic.

### 3. `tests/rate-limiter.test.mjs` — CREATE
**Domain**: tests (path rule: `tests/**`)

**Purpose**: Unit tests covering token bucket logic, persistence, per-repo isolation, concurrency, and failure modes.

**Test cases** (using Node's built-in `node:test` + `node:assert/strict`, consistent with the repo's test conventions):
1. **Token consumption**: create limiter with `burst: 3`; call `acquire()` once; `getState().tokens` equals 2
2. **Burst exhaustion + refill**: with fake clock, acquire `burst` tokens instantly; next `acquire()` triggers sleep; advance fake clock past refill window; acquire succeeds
3. **Rate enforcement timing**: with `rate: 1` (1/sec) and `burst: 1`, two rapid acquires require ≥ 1000 ms between them (verified via fake sleep capture)
4. **Per-repo isolation**: two limiters, different `repoKey`, same `stateDir`; consuming all tokens in one does not affect the other
5. **Cross-instance persistence**: limiter A acquires 2 of 5 tokens; create limiter B with same `repoKey` + `stateDir`; `getState().tokens` equals 3
6. **Corrupt state recovery**: write invalid JSON to state file path; create limiter; `getState().tokens` equals `burst`; a warning is emitted
7. **Missing state file**: no file exists; limiter starts with full bucket; no error thrown
8. **Unwritable state dir**: `stateDir` set to a read-only path (or mock `fs.rename` to throw); `acquire()` still returns; warning emitted; in-memory state is used
9. **Concurrent acquire serialization**: fire 5 concurrent `acquire()` calls with `burst: 3`; first 3 resolve immediately, remaining 2 wait for refill (verified via fake sleep)
10. **Env var override**: set `ARCH_MEM_EMBEDDING_RPM=120` and `ARCH_MEM_EMBEDDING_BURST=10`; create limiter without explicit options; `getState().tokens` equals 10; rate equals 2/sec
11. **Singleton cache**: `getRateLimiter` called twice with same `repoKey` + `stateDir` returns the same instance (reference equality)

## Risks

### 1. Cross-process race condition on state file
**Risk**: Two processes processing the same repo simultaneously could read the same token count, both consume, and last-write-wins loses one consumption—allowing a small burst past the limit.
**Mitigation**: In practice, this tool processes one repo per invocation. If parallel processing is added later, file locking (`fs.open` with `O_EXCL` lock file or `proper-lockfile`) can be layered in. The current design documents this limitation in a code comment. The impact is bounded: at most one extra call per concurrent process, which is within typical API quota headroom.

### 2. Incorrect rate configuration
**Risk**: Setting the rate too high defeats the limiter; too low stalls the pipeline.
**Mitigation**: Conservative defaults (50/min, burst 5). Document that the rate should be set to ~80% of the API's actual per-minute quota to leave headroom for other callers. The env var override is intentionally explicit so misconfiguration is visible.

### 3. State file accumulation
**Risk**: State files accumulate for repos no longer being processed.
**Mitigation**: State files are ~80 bytes each. A cleanup step (remove files whose `lastRefill` is older than `burst / rate` seconds, meaning the bucket is already full) can be added as a follow-up. Out of scope for this change—flagged in a `TODO` comment.

### 4. Clock skew
**Risk**: System clock changes (NTP sync, manual adjustment) could cause incorrect refill calculations.
**Mitigation**: `Date.now()` is used for v1 simplicity. A backward clock jump would at most allow `burst` extra calls (the bucket is capped at `burst`). This is an edge case, not a common failure mode. If it becomes an issue, switch to `process.hrtime.bigint()` for monotonic timing.

### 5. Integration point uncertainty
**Risk**: The exact embedding call site (`scripts/lib/store/embeddings.mjs`) is inferred from the domain map, not confirmed against the full symbol table (which was truncated).
**Mitigation**: The rate limiter module is designed to be integration-agnostic—a 3-line change at any call site. If the actual call site is elsewhere (e.g., in arch-memory's `scripts/lib/symbol-index/` or a shared API client in `scripts/lib/`), the same pattern applies. The implementer should grep for `fetch`/`openai`/`embed` in `scripts/lib/store/` and `scripts/lib/symbol-index/` to confirm the exact file before modifying.

### 6. State file path collision
**Risk**: SHA-1 hash truncation (16 hex chars) could theoretically collide for different repo keys.
**Mitigation**: 16 hex chars = 64 bits of entropy. Birthday collision probability reaches 50% only at ~2^32 repos. Not a realistic concern for this tool's scale.

## Target Paths
- `scripts/lib/rate-limiter.mjs` (create)
- `scripts/lib/store/embeddings.mjs` (modify)
- `tests/rate-limiter.test.mjs` (create)

## Section 9 — Acceptance Criteria
1. `createRateLimiter({ repoKey, stateDir, burst: 3 })` returns an object with `acquire` (async function) and `getState` (sync function) properties
2. After calling `acquire()` once on a fresh limiter with `burst: 3`, `getState().tokens` returns a value equal to or less than 2 (allowing for elapsed-time refill)
3. With a fake clock that does not advance, calling `acquire()` `burst` times resolves immediately, and the next `acquire()` call invokes the injected `sleep` function with a positive ms argument
4. Two limiter instances created with different `repoKey` values but the same `stateDir` maintain independent token counts—consuming all tokens in one does not reduce the other's `getState().tokens`
5. A new limiter instance created with the same `repoKey` and `stateDir` as a prior instance (in the same process or a new one) sees the persisted token count (within 1 token, allowing for refill elapsed time)
6. Writing invalid JSON to the state file path before creating a limiter causes the limiter to initialize with a full bucket (`getState().tokens === burst`) and emit a warning, without throwing
7. When the state directory is unwritable (mock `fs.rename` to throw), `acquire()` still resolves successfully and a warning is emitted; subsequent `getState()` reflects in-memory token consumption
8. Five concurrent `acquire()` calls on a limiter with `burst: 3` result in exactly 3 immediate resolutions and 2 delayed resolutions that wait for the injected `sleep`—total tokens consumed never exceeds `burst + floor(elapsed_seconds * rate)`
9. Setting `ARCH_MEM_EMBEDDING_RPM=120` and `ARCH_MEM_EMBEDDING_BURST=10` before creating a limiter (without explicit rate/burst options) results in `getState().tokens === 10` and a refill rate of 2 tokens/second
10. `getRateLimiter` called twice with identical `repoKey` and `stateDir` returns the same object reference (singleton cache works)
11. The embedding call module invokes `await limiter.acquire()` before each embedding API request (verifiable by code

### output-2

## Overview
Embedding API calls for architectural memory (e.g., in `scripts/openai-audit.mjs`) can trigger quota bursts when multiple repositories compete for a shared API key. We introduce a lightweight, per-repo rate limiter that shapes traffic on a per-instance basis. The limiter is a promise‑based sliding‑window throttler that ensures no more than `maxCallsPerMinute` calls proceed per repo. It is placed around the single embedding call site and reused via a factory keyed by repo slug. No persistence is needed; state lives only for the script’s lifetime.

## Design Decisions

1. **Limiter algorithm** – Sliding window (record timestamps, `wait` promise resolved after `maxCallsPerMinute` / 60 average interval).  
   *Rationale*: simple, no burst edge cases; avoids a full token-bucket implementation while still preventing short‑burst spikes.

2. **Per‑repo keying** – The limiter factory accepts a `repoSlug` (derived from the repository root or configured identifier). Each repo gets its own instance.  
   *Rationale*: isolates rate tracking so one repo’s burst doesn’t starve another.

3. **Promise‑based integration** – `await rateLimiter.wait()` inserted before the API call.  
   *Rationale*: works naturally with the current async/await calling code; does not change control flow or error handling.

4. **Configuration** – Limits are loaded from environment variables (`ARCH_EMBED_MAX_PER_MIN`, default 50) with an optional override per repo via a small config object.  
   *Rationale*: avoids hard‑coding yet remains trivially configurable without a persistent store.

5. **Location in shared‑lib** – File `scripts/lib/rate-limiter.mjs` + unit test `tests/rate-limiter.test.mjs`. Allowed dependency: shared‑lib → shared‑lib ok.  
   *Rationale*: the limiter is a general utility; placing it in shared‑lib keeps it available for any future embedding call without layering violations.

## File‑Level Plan

### Create

| File | Purpose |
|---|---|
| `scripts/lib/rate-limiter.mjs` | Exports `createRateLimiter(repoSlug, opts?)` returning an object with `wait(): Promise<void>`. Keeps in‑memory call timestamps. Provides optional `getStats()` for observability. |
| `tests/rate-limiter.test.mjs` | Vitest unit tests: verifies correct delay of sequential calls, respects concurrency limit, resets state per repo slug, works under burst scenarios. |

### Modify

| File | Change |
|---|---|
| `scripts/openai-audit.mjs` (or whichever file currently makes the embedding API call) | Import `createRateLimiter`, extract a `repoSlug` from the execution context (e.g., derived from the repository path), call `const embedLimiter = createRateLimiter(repoSlug)` once at the top level, and insert `await embedLimiter.wait()` immediately before the embedding HTTP request. |

*Note*: The exact embedding call site will be confirmed in the target source; the plan assumes `scripts/openai-audit.mjs` as the most likely candidate. If the call lives elsewhere, the change follows the same pattern.

## Risks

- **Global API limit still trackable by the provider** – The per‑repo limiter only prevents bursts at the repo level. If many repos run concurrently, the sum of per‑repo limits may still exceed the global API plan quota. Mitigation: expose `maxPerMinGlobal` as an environment variable and coordinate externally (or later add a global token bucket).  
- **In‑memory state lost on crash** – A crash when a promise is waiting leaves the limiter empty; restart picks up fresh, no data loss.  
- **Configuration drift** – If environment variables are forgotten, the default (50/min) may be too high or too low. Mitigation: document the env vars in `scripts/lib/rate-limiter.mjs` comments and in the main README.  
- **Test framework dependency** – Adding a test file assumes Vitest is the project’s test runner; if a different framework is used, the test file must be adapted (minor risk).

## Target Paths
- `scripts/lib/rate-limiter.mjs`
- `scripts/openai-audit.mjs`
- `tests/rate-limiter.test.mjs`

## Section 9 — Acceptance Criteria
1. A new module `scripts/lib/rate-limiter.mjs` exists and exports `createRateLimiter`.
2. Calling `createRateLimiter('repo-a')` returns an object with a `wait` method.
3. When `wait()` is called more than `maxPerMin` times within one minute for the same repo, later calls are delayed such that the effective rate stays ≤ `maxPerMin` per minute.
4. Two different repo slugs receive independent rate limits.
5. The embedding API call in the architectural‑memory pipeline (identified file) is preceded by `await rateLimiter.wait()`.
6. The embedding call still works as before when rate is unconstrained (no artificial failures introduced).
7. The limiter implements a configurable default (`50` per minute) that can be overridden via environment variable `ARCH_EMBED_MAX_PER_MIN`.
8. A unit test file `tests/rate-limiter.test.mjs` verifies the throttling behaviour and independence of repos.
9. No layering violations: `scripts/lib/rate-limiter.mjs` is in the `shared‑lib` domain and may only depend on other `shared‑lib` utilities.

### output-3

## Overview

Add a small, testable, per-repository async rate limiter around architectural-memory embedding provider calls. The limiter will live inside the `arch-memory` domain (`scripts/lib/symbol-index/**`) and will be applied at the architectural-memory embedding boundary so all embedding requests for the same repository are serialized/throttled before reaching the external embedding API.

The implementation should avoid changing embedding payload semantics, persistence formats, vector-store contracts, or retry behavior. It should only control when embedding calls start.

## Design Decisions

### 1. Put the limiter in `scripts/lib/symbol-index/**`

**Decision:** Create a dedicated limiter module under `scripts/lib/symbol-index/`.

**Rationale:**
- The feature is specific to architectural-memory embedding calls.
- This path is already mapped to the `arch-memory` domain.
- Avoids adding a broader shared abstraction before there is evidence other domains need it.

---

### 2. In-process per-repo limiter, not persisted cross-process locking

**Decision:** Implement an in-memory per-repo limiter keyed by canonical repo identity/path.

**Rationale:**
- The immediate quota-burst failure mode is concurrent embedding calls within the same architectural-memory process/run.
- Adding lock files or persisted token buckets would increase persistence and stale-lock failure modes.
- No new persistent state means no new corruption or cleanup surface.
- If later evidence shows bursts across multiple independent processes, a file-backed or shared-store limiter can be added behind the same limiter interface.

**Explicit limitation:** This will not coordinate separate Node.js processes running simultaneously in the same repo.

---

### 3. Apply the limiter only at the external embedding-call boundary

**Decision:** Wrap the provider call, not every higher-level caller.

**Rationale:**
- Guarantees coverage for all architectural-memory embedding use cases that share the embedding wrapper.
- Avoids duplicating throttling logic across index/search/update flows.
- Keeps tests focused on “does every embedding provider call pass through the limiter?”

---

### 4. Preserve existing error behavior

**Decision:** The limiter delays and schedules calls but does not retry, translate, or suppress provider errors.

**Rationale:**
- The task is rate limiting, not retry/backoff policy.
- Existing callers’ handling of quota, auth, network, and malformed-response errors should remain unchanged.
- This avoids masking provider failures or making tests flaky.

---

### 5. Conservative configurable defaults

**Decision:** Use a default minimum interval between same-repo embedding calls, configurable by environment variable.

Recommended contract:

- `ARCH_MEMORY_EMBEDDING_MIN_INTERVAL_MS`
  - default: `500`
  - `0` disables waiting
  - invalid/negative values fall back to default
  - clamp to a safe maximum, e.g. `60000`

**Rationale:**
- A 500ms default avoids request bursts without making normal batched indexing prohibitively slow.
- Environment override allows operators to tune for provider quota tiers.
- Configuring interval is simpler and safer than exposing a full token-bucket policy prematurely.

---

### 6. Deterministic testability

**Decision:** Export a pure limiter factory that accepts injected `now()` and `sleep(ms)` functions.

**Rationale:**
- Tests can verify ordering and spacing without real-time sleeps.
- Production uses `Date.now()` and `setTimeout`.
- Makes failure-mode tests deterministic.

---

## Target Paths

- `scripts/lib/symbol-index/embedding-rate-limiter.mjs`
- `scripts/lib/symbol-index/embeddings.mjs`
- `tests/symbol-index/embedding-rate-limiter.test.mjs`
- `tests/symbol-index/embeddings-rate-limit.test.mjs`

## File-level Plan

### `scripts/lib/symbol-index/embedding-rate-limiter.mjs` — create

Purpose: Provide the per-repo async rate limiter used by architectural-memory embedding calls.

Plan:
- Export a factory such as `createEmbeddingRateLimiter(options = {})`.
- Export a singleton such as `embeddingRateLimiter` for production use.
- Keep the public surface minimal:
  - `schedule(repoKey, operation)`
  - optional helper `normalizeEmbeddingRateLimitConfig(env = process.env)`
- Internals:
  - Maintain a `Map<repoKey, queueState>`.
  - For each repo key, enqueue operations so same-repo embedding calls do not start in a burst.
  - Track the last start time per repo.
  - Before starting the next operation, wait until `lastStart + minIntervalMs`.
  - Use `finally` so failures do not permanently block the queue.
  - Clean up idle repo entries after the last queued operation settles.
- Contract:
  - `operation` is called exactly once.
  - Return value/rejection from `operation` is passed through unchanged.
  - Same repo calls are throttled.
  - Different repo calls are independent.
- Defensive behavior:
  - If `repoKey` is missing/blank, use a stable fallback such as `'__unknown_repo__'` rather than throwing inside the limiter.
  - Invalid interval config falls back to default.
  - Do not log request bodies, embedding text, API keys, or provider responses.

---

### `scripts/lib/symbol-index/embeddings.mjs` — modify

Purpose: Ensure all architectural-memory embedding API calls go through the per-repo limiter.

Plan:
- Locate the existing external embedding provider call(s), e.g. OpenAI embedding creation or equivalent.
- Import the limiter from `./embedding-rate-limiter.mjs`.
- Determine the repo key from existing embedding context:
  - Prefer an existing repo root/repo path argument if present.
  - Otherwise use the existing project/root discovery mechanism already used by architectural-memory.
  - Fallback to `process.cwd()` only if no explicit repo context exists.
- Wrap provider calls:

  Conceptually:

  ```js
  return embeddingRateLimiter.schedule(repoKey, () => provider.embeddings.create(payload));
  ```

- Preserve the existing payload exactly:
  - model
  - input text/batches
  - dimensions
  - metadata
  - timeout/signal options
- Preserve existing errors:
  - Do not catch unless existing code already does.
  - If existing code maps errors, keep that mapping outside/around the scheduled provider call.
- Avoid wrapping non-provider preprocessing/postprocessing.
  - Tokenization, cache checks, vector normalization, and response validation should remain outside unless they currently happen as part of the provider call.
- If there are multiple direct embedding call sites in this file, route all through one private helper to prevent future bypasses.

---

### `tests/symbol-index/embedding-rate-limiter.test.mjs` — create

Purpose: Unit-test limiter behavior without real provider calls.

Test cases:
1. Same-repo operations are not started closer together than the configured interval.
2. Same-repo operations preserve FIFO ordering.
3. Different repo keys do not block each other.
4. Rejected operations propagate the original error and do not break later queued calls.
5. `minIntervalMs: 0` allows immediate execution while still preserving queue correctness if same-repo serialization is part of the implementation.
6. Invalid environment/config values fall back to defaults.
7. Idle repo queue state is cleaned up after operations settle, if the implementation exposes this indirectly or via a test-only observable.

Use injected fake `now()` and `sleep(ms)` to avoid wall-clock delays.

---

### `tests/symbol-index/embeddings-rate-limit.test.mjs` — create

Purpose: Verify the architectural-memory embedding boundary uses the limiter.

Plan:
- Mock or inject the embedding provider used by `scripts/lib/symbol-index/embeddings.mjs`.
- Mock or inject the limiter, or configure the real limiter with fake time.
- Assert that:
  - Provider calls are made through the scheduled path.
  - The repo key passed to the limiter is the expected canonical repo identity/path.
  - Provider payload is unchanged.
  - Provider errors still propagate unchanged.
- Avoid real network/API calls.
- Avoid dependence on actual API keys.

---

## Failure Modes and Handling

### Provider returns `429` or quota error

- The limiter does not retry or transform the error.
- Existing caller behavior remains intact.
- Future retry/backoff can be added separately if needed.

### Operation throws synchronously

- `schedule()` should treat synchronous throws the same as rejected promises.
- Queue state must still advance/clean up.

### Long-running or hanging provider call

- The limiter should not add new timeout behavior unless the embedding module already supports timeout/signal handling.
- Existing timeout/abort behavior should remain responsible for hanging calls.

### Invalid repo key

- Normalize blank/missing repo keys to a fallback key.
- This prevents accidental unbounded map growth from `undefined`, `null`, or empty strings.

### High cardinality repo keys

- Cleanup idle entries after queues drain.
- Avoid memory leaks in long-running processes that touch many repos.

### Test flakiness from timers

- Use injected fake `sleep`/`now` in unit tests.
- Do not rely on real `setTimeout` delays in tests.

## Security and Persistence Safety

- No API keys or embedding text should be logged by the limiter.
- No embedding payload contents should be stored by the limiter.
- No new persistent files are introduced.
- Repo key should be a normalized identifier/path string only; it should not be used for filesystem writes by the limiter.
- The limiter must not mutate provider payloads or embedding responses.

## Risks

1. **Multiple process burst risk remains.**  
   The proposed limiter coordinates calls within one process only. If quota bursts come from multiple simultaneous CLI processes in the same repo, this will reduce but not eliminate bursts. A later enhancement could add a lockfile/shared-state implementation behind the same interface.

2. **Incorrect call-site coverage.**  
   If architectural-memory has multiple direct embedding provider calls and only one is wrapped, bursts may continue. Implementation should first search for all embedding provider invocations under `scripts/lib/symbol-index/**` and route them through the same helper.

3. **Throughput reduction.**  
   Conservative throttling may slow large indexing runs. The environment-configurable interval provides an operational escape hatch.

4. **Repo-key mismatch.**  
   If different callers pass different representations of the same repo path, they may get separate queues. Normalize to an absolute/canonical repo root where existing architecture already provides one.

5. **Hidden dependency on embedding call concurrency.**  
   If existing code assumes concurrent embedding calls for performance, serialization may affect runtime. This is acceptable for quota safety but should be noted in release notes or script output if indexing becomes noticeably slower.

## Section 9 — Acceptance Criteria

1. All architectural-memory external embedding API calls under `scripts/lib/symbol-index/**` are routed through the new per-repo limiter.
2. Same-repo embedding calls are delayed so their start times respect `ARCH_MEMORY_EMBEDDING_MIN_INTERVAL_MS` or the default interval.
3. Embedding calls for different repo keys can proceed independently and do not wait on each other’s queues.
4. Provider request payloads and response handling remain unchanged except for scheduling delay.
5. Provider errors, including quota/auth/network errors, propagate to existing callers without being swallowed or remapped by the limiter.
6. Limiter queue state is released after both successful and failed operations, allowing later same-repo calls to proceed.
7. Invalid or negative interval configuration falls back to the documented default; `0` is accepted as an explicit no-wait setting.
8. Tests do not perform real embedding API/network calls and do not require real API keys.
9. Unit tests cover same-repo throttling, different-repo independence, FIFO behavior, failure propagation, and config parsing.
10. The implementation introduces no new persistent files and logs no embedding input text, provider responses, or secrets.

