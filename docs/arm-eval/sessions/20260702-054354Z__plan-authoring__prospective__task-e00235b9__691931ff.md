# Arm-eval session 691931ff-da9c-4ead-aee9-52e6e99ab464

| Field | Value |
|---|---|
| Experiment | plan-authoring |
| Phase | prospective |
| Task id | `task-e00235b9` |
| Seed (presentation-order RNG) | 11 |
| Config / rubric version | 1 / 1 |
| Created (UTC) | 2026-07-02T05:43:54.027Z |
| Repo | 8548afbd-8d85-50de-baca-1bb158d696da |
| Archive mode | BLINDED (prospective, human ranking pending — arm identity/models/scores withheld to protect the anchor) |

## Task

Implement a retry-with-backoff wrapper for transient OpenRouter 5xx errors in the OSS model path

## Outputs (blinded — rank via `arm-eval-adjudicate`)

### output-1

# Implementation Plan — Retry with Backoff for Transient OpenRouter 5xx Errors in OSS Model Path

## Overview

Implement a small, provider-scoped retry wrapper around the existing OpenRouter call used by the OSS model audit path. The retry should only apply to transient OpenRouter HTTP `5xx` responses, use bounded exponential backoff with jitter, and preserve existing behavior for non-retryable failures such as `4xx`, malformed responses, missing credentials, and validation errors.

The change should be localized to the OSS/OpenRouter client layer rather than the broader audit orchestration path, so other providers and audit flows are not affected.

## Target Paths

- `scripts/lib/audit/oss-model.mjs`
- `tests/audit/oss-model-openrouter-retry.test.mjs`

## Design Decisions

### 1. Scope retry to the OSS OpenRouter call site only

**Decision:** Add retry logic at the lowest existing function that performs the OpenRouter HTTP request for the OSS model path, expected in `scripts/lib/audit/oss-model.mjs`.

**Rationale:**

- The task is specifically about transient OpenRouter `5xx` errors in the OSS model path.
- Avoids changing behavior for Gemini, OpenAI, Claude, or other audit providers.
- Keeps failure semantics local and testable.
- Prevents accidental retries around non-idempotent higher-level orchestration work.

### 2. Retry only HTTP `5xx` OpenRouter responses

**Decision:** Retry when the OpenRouter HTTP response status is in the inclusive range `500–599`.

Do **not** retry:

- `400–499`, including `401`, `403`, `404`, `408`, `409`, `422`, `429`
- local validation failures
- missing environment variables or API keys
- response JSON/schema parsing failures after a successful HTTP response
- prompt construction failures

**Rationale:**

- The task asks for transient OpenRouter `5xx` errors.
- Retrying auth, quota, prompt, validation, or contract errors wastes time and can hide real defects.
- `429` may require provider-specific `Retry-After` handling, but that is outside this task and should not be bundled into this change.

### 3. Use bounded exponential backoff with small jitter

**Decision:** Use a minimal bounded retry policy:

- Total attempts: `3` maximum, including the first attempt.
- Delays before retries:
  - after attempt 1: approximately `500ms`
  - after attempt 2: approximately `1000ms`
- Add small jitter, for example `0–100ms`, to avoid synchronized retries.
- No delay after the final failed attempt.

**Rationale:**

- Three attempts is enough to smooth short OpenRouter instability without causing long audit hangs.
- Exponential backoff is standard for transient server-side failures.
- Jitter prevents multiple audit workers from retrying in lockstep.
- Avoids over-engineering with a general-purpose retry framework.

### 4. Preserve the final error contract

**Decision:** If all retry attempts fail with OpenRouter `5xx`, throw the same style of error currently thrown by the OSS model path, enriched only with safe retry context such as:

- provider name: `OpenRouter`
- final HTTP status
- number of attempts
- sanitized response body excerpt if existing behavior already includes one

Do **not** include:

- API keys
- Authorization headers
- full prompt contents
- full model response payloads if they can contain sensitive audit input

**Rationale:**

- Downstream callers likely depend on current error type/message shape.
- Retry context improves diagnosability without leaking secrets.
- Security-sensitive request/response content should not be expanded as part of this task.

### 5. Keep retry implementation private unless existing architecture already has a retry helper

**Decision:** Prefer a small private helper in `scripts/lib/audit/oss-model.mjs`, for example conceptually:

- `isRetryableOpenRouterStatus(status)`
- `sleep(ms)`
- `computeBackoffDelayMs(attemptIndex)`
- `callOpenRouterWithRetry(...)`

If the repository already has a shared retry/sleep utility in `scripts/lib/**`, reuse it instead of duplicating.

**Rationale:**

- The retry policy is provider-specific and currently needed only in one place.
- Avoids adding a new shared abstraction prematurely.
- Reusing an existing utility is acceptable if it avoids duplicate timing primitives without widening behavior.

### 6. Make tests deterministic by injecting timing/randomness where practical

**Decision:** Structure the helper so tests can avoid real-time waits. Preferred approaches:

- accept an internal/private options object with `sleepFn` and `randomFn`, or
- expose a narrowly scoped testable helper if that is consistent with current module style.

Production callers should not need to pass these options.

**Rationale:**

- Tests should not sleep for real backoff durations.
- Deterministic jitter makes assertions stable.
- Keeps production API unchanged.

## File-Level Plan

### Modify: `scripts/lib/audit/oss-model.mjs`

**Purpose:** Add retry-with-backoff behavior to the existing OpenRouter request used by the OSS model path.

Planned changes:

1. Locate the existing function that sends the OpenRouter HTTP request.
   - This is likely the function that uses `fetch` against OpenRouter’s chat/completions endpoint.
   - Keep all existing request construction, headers, model selection, and response parsing intact.

2. Extract or wrap the single HTTP request attempt.
   - Create a private “single attempt” function if the current code combines fetch, status handling, and parsing in one block.
   - The single-attempt function should perform exactly one HTTP request and return/throw as it does today.

3. Add retry classification.
   - Introduce a helper equivalent to:
     - status is numeric
     - status `>= 500`
     - status `<= 599`
   - Do not treat `429` or network exceptions as retryable unless existing code already converts OpenRouter network failures into synthetic `5xx` errors. If so, preserve existing semantics but document the classification in comments.

4. Add bounded retry loop around the OpenRouter request.
   - Attempt up to `3` times total.
   - On retryable `5xx`, consume or safely capture the response body as current code does.
   - Delay only between attempts.
   - On success, return immediately.
   - On non-retryable failure, throw immediately.

5. Add backoff delay computation.
   - Base delay: `500ms`.
   - Attempt delays: `500ms`, then `1000ms`.
   - Add small jitter, e.g. `Math.floor(Math.random() * 100)`.
   - Cap is not strictly necessary for three attempts, but a constant such as `OPENROUTER_RETRY_MAX_DELAY_MS = 1000` is acceptable if it keeps the logic clear.

6. Preserve logging behavior.
   - If the file already logs provider errors, add a safe retry log/warning only if consistent with existing style.
   - Include attempt number, max attempts, and status.
   - Exclude API key, Authorization header, prompt, and raw full response body.

7. Preserve public API.
   - Do not require callers to pass retry configuration.
   - Avoid changing exported function names unless tests already use named exports that make helper testing straightforward.

8. Add deterministic test hooks only if needed.
   - If tests cannot reliably fake timers or intercept sleep, add a private/internal options parameter with defaults:
     - `sleepFn = defaultSleep`
     - `randomFn = Math.random`
   - Keep the parameter internal to the OSS model function path and avoid documenting it as public API unless the repo has an existing convention for test-only injection.

### Create: `tests/audit/oss-model-openrouter-retry.test.mjs`

**Purpose:** Verify retry behavior for OpenRouter `5xx` errors without performing real network calls or real sleeps.

Planned tests:

1. Retries transient `500` then succeeds.
   - Mock/fake `fetch` to return:
     1. HTTP `500`
     2. HTTP `200` with a valid existing OpenRouter-compatible response body
   - Assert:
     - fetch called twice
     - final result matches successful response
     - no real delay occurs

2. Retries up to max attempts for repeated `5xx`.
   - Mock/fake `fetch` to return `502`, `503`, `500`.
   - Assert:
     - fetch called exactly three times
     - thrown error includes final status or preserves existing error semantics
     - no fourth attempt occurs

3. Does not retry `4xx`.
   - Mock/fake `fetch` to return `401` or `400`.
   - Assert:
     - fetch called exactly once
     - error is thrown immediately

4. Does not retry `429`.
   - Mock/fake `fetch` to return `429`.
   - Assert:
     - fetch called exactly once
   - This guards against accidentally widening the policy beyond the task.

5. Uses backoff between retry attempts.
   - Inject fake `sleepFn` if implemented.
   - Inject deterministic `randomFn` if jitter is used.
   - Assert expected sleep calls, for example:
     - first retry delay in range `500–599ms`, or exact deterministic value
     - second retry delay in range `1000–1099ms`, or exact deterministic value

6. Does not leak secrets in retry errors/logs.
   - If the OSS model path exposes error text containing request metadata, assert the thrown message does not include the test API key.
   - If there is no logging/error body expansion in the implementation, this can be covered by asserting the thrown error message only contains status/attempt metadata.

## Failure Modes and Handling

1. **OpenRouter returns `500–599` once, then success**
   - Retry after backoff.
   - Return successful model result.

2. **OpenRouter returns `500–599` for all attempts**
   - Throw final provider error after three total attempts.
   - Include safe context such as final status and attempts.

3. **OpenRouter returns `400–499`**
   - Throw immediately.
   - No retry.

4. **OpenRouter returns invalid JSON with HTTP `200`**
   - Preserve existing parsing failure behavior.
   - No retry, because this is not an HTTP `5xx`.

5. **Missing API key or invalid configuration**
   - Preserve existing validation behavior.
   - No retry.

6. **Network-level exception**
   - Unless existing OSS model code already classifies this as a provider `5xx`, preserve current behavior and do not retry under this task.
   - If current behavior wraps fetch failures into a provider status, only retry when the wrapped status is explicitly `5xx`.

## Testability Notes

- Prefer Node’s built-in test runner style if the repository already uses it.
- Avoid real OpenRouter calls.
- Avoid real sleeps.
- Restore any global `fetch` monkeypatches in `afterEach`/`finally` to prevent cross-test pollution.
- Use valid minimal OpenRouter response fixtures that match the current parser contract.
- Keep tests focused on retry behavior rather than broad audit orchestration.

## Security and Persistence Safety

- No persistence writes are expected for this change.
- Do not store retry state outside the call stack.
- Do not log API keys, Authorization headers, prompts, or full response bodies.
- Ensure response body handling does not accidentally duplicate large/sensitive payloads in thrown errors.
- Retry count must be bounded to avoid runaway provider calls and unexpected cost.

## Risks

1. **Existing function shape may combine request and parsing tightly**
   - Mitigation: refactor only enough to isolate one-attempt behavior. Do not redesign the OSS model client.

2. **Tests may require dependency injection if current code uses global `fetch` and direct timers**
   - Mitigation: add narrow internal defaults for `fetchFn`, `sleepFn`, or `randomFn` only if existing test patterns support it.

3. **Changing error messages may break tests**
   - Mitigation: preserve existing error structure and append retry metadata only where safe and necessary.

4. **Retrying can increase provider cost**
   - Mitigation: retry only OpenRouter `5xx`, cap at three attempts, and do not retry validation or client errors.

5. **Jitter can make tests flaky**
   - Mitigation: inject deterministic randomness or assert delay ranges rather than exact values.

## Section 9 — Acceptance Criteria

1. OpenRouter `500–599` responses in the OSS model path are retried with bounded exponential backoff.
2. The implementation performs no more than three total OpenRouter attempts for a single OSS model request.
3. A request that receives one transient OpenRouter `5xx` followed by a valid success returns the successful result.
4. Repeated OpenRouter `5xx` responses throw after the final allowed attempt and do not perform an extra request.
5. OpenRouter `4xx` responses are not retried.
6. OpenRouter `429` responses are not retried as part of this task.
7. Existing behavior for missing credentials, malformed success responses, and local validation errors is preserved.
8. Retry delays are covered by deterministic tests without real sleeping.
9. Tests verify the number of OpenRouter fetch attempts for success-after-retry, repeated-`5xx`, `4xx`, and `429` cases.
10. Error/log output introduced by this change does not include API keys, Authorization headers, prompts, or other sensitive request content.
11. Public OSS model call signatures remain unchanged unless the repository already supports internal dependency injection patterns.
12. The change is localized to the OSS/OpenRouter model path and does not alter retry behavior for unrelated providers.

### output-2

## Overview

Implement a retry-with-exponential-backoff wrapper for HTTP requests that encounter transient 5xx errors from OpenRouter in the OSS model path. The wrapper will intercept failed requests, apply jittered backoff delays, and retry up to a configurable maximum before surfacing the error. It will be integrated into the existing shared-lib HTTP/OpenRouter call chain without breaking existing contracts.

## Design Decisions

1. **Right-sizing: pure function wrapper, not middleware/plugin.**  
   The smallest unit that solves the problem is a standalone `withRetry` wrapper that takes an async function and returns a decorated version. This avoids coupling to any specific HTTP client, keeps the footprint minimal, and composes cleanly with existing code.

2. **Configurable via defaults + overrides.**  
   Default values (max retries=3, base delay=1s, max delay=30s, jitter factor=0.3) are hardcoded as constants. Callers can pass an options object to override any subset. This avoids a config file dependency while still allowing flexibility.

3. **Only retry on OpenRouter 5xx responses.**  
   The wrapper inspects either a standard `Response` object (status 500–599) or an error with a `status` property. Non-5xx errors (4xx, network failures without status, timeouts) bubble up immediately without retry. This prevents masking real client errors.

4. **Jittered exponential backoff.**  
   Delay = min(cap, base × 2^attempt) × (1 + random(-jitter, +jitter)). This prevents thundering herd on OpenRouter. Jitter is multiplicative, not additive, to keep the spread proportional.

5. **Integration point: wrap the existing `openRouterFetch` or equivalent function.**  
   The wrapper is applied at the call site where OpenRouter requests are made. If there is a central `callOpenRouter` helper in shared-lib, that is the ideal place to apply it. If not, a new thin helper is created in shared-lib that composes `withRetry` with the underlying fetch.

6. **No persistence or state.**  
   Retry state is ephemeral per-call. No logs are written to disk (existing logging can capture failures if needed).

## File-level Plan

### 1. Create: `scripts/lib/retry.mjs`
- **Purpose:** Exports the `withRetry` wrapper and internal helpers for delay calculation and error classification.
- **Symbols:**
  - `withRetry(fn, options?)` — main export; returns an async function with identical signature that retries on 5xx.
  - `isTransient5xx(error)` — returns true if the error represents an OpenRouter 5xx response.
  - `calculateDelay(attempt, options)` — computes jittered backoff delay.
- **Domain:** shared-lib (matches `scripts/lib/**` rule).

### 2. Create: `scripts/lib/openrouter-retry.mjs`
- **Purpose:** Applies `withRetry` to the specific OpenRouter HTTP call path used in the OSS model.
- **Symbols:**
  - `createRetryableOpenRouterFetch(baseFetch)` — composes the base fetch function with `withRetry`, exports the decorated version.
  - Exports a pre-configured `retryableFetch` using the default fetch binding.
- **Domain:** shared-lib.

### 3. Modify: `scripts/lib/openrouter-oss.mjs` (or equivalent existing entry point)
- **Purpose:** Import and use the retryable fetch instead of raw fetch for OSS model calls.
- **Change:** Replace `fetch(...)` call with `retryableFetch(...)` from `openrouter-retry.mjs`.
- **Note:** If no such centralized file exists, identify the specific file(s) that make OpenRouter calls for OSS models and apply the change there. The plan names this as the canonical integration point.

### 4. Create: `tests/unit/retry.test.mjs`
- **Purpose:** Unit tests for `withRetry` and `calculateDelay`.
- **Coverage:**
  - Success on first attempt passes through unchanged.
  - Retries on 5xx, returns success if subsequent attempt succeeds.
  - Stops after max retries and throws the last 5xx error.
  - Does not retry on 4xx or network errors without status.
  - Delay calculation follows exponential curve with jitter bounds.
  - Custom options override defaults correctly.

### 5. (Optional) Create: `tests/unit/openrouter-retry.test.mjs`
- **Purpose:** Integration test verifying the composed fetch wrapper correctly intercepts 5xx in a simulated environment.

## Risks

- **Unknown integration point:** The exact file that calls OpenRouter for OSS models is not specified in the architecture map. If no central helper exists, multiple call sites may need updating, increasing scope. Mitigation: during implementation, locate all OpenRouter OSS model call sites and apply consistently.
- **Error shape mismatch:** The wrapper relies on `error.status` being present for 5xx classification. If the existing code throws errors with a different shape (e.g., `error.response.status`), the check will fail and retries won't trigger. Mitigation: inspect actual error objects at the call site and adjust `isTransient5xx` accordingly.
- **Test interference:** Unit tests for `calculateDelay` that assert delay ranges with random jitter can be flaky. Mitigation: mock `Math.random` to deterministic values in tests, or use a seedable PRNG injection point.

## Target Paths
- `scripts/lib/retry.mjs`
- `scripts/lib/openrouter-retry.mjs`
- `scripts/lib/openrouter-oss.mjs` (modify; actual filename may differ)
- `tests/unit/retry.test.mjs`
- `tests/unit/openrouter-retry.test.mjs` (optional)

## Section 9 — Acceptance Criteria

1. When an OpenRouter HTTP call returns a 5xx status, the wrapper retries the request with an exponentially increasing delay.
2. The delay between retries includes randomized jitter to prevent thundering herd, bounded by a configurable maximum.
3. The wrapper stops retrying after a configurable maximum number of attempts (default 3) and throws the last received error.
4. Non-5xx responses (4xx codes, network failures without a status code, timeouts) are not retried and bubble up immediately.
5. A successful response on any attempt (including after retries) is returned to the caller unchanged.
6. The wrapper exposes a configurable options object (maxRetries, baseDelayMs, maxDelayMs, jitterFactor) with reasonable defaults.
7. Existing OpenRouter OSS model call sites use the retry-enabled wrapper without changing their call signatures.
8. Unit tests exist for the retry logic covering: success path, 5xx retry and eventual success, 5xx exhaustion, non-5xx no-retry, and delay calculation bounds.

### output-3

# Implementation Plan — Retry-with-Backoff Wrapper for OpenRouter 5xx Transient Errors

## Overview

Introduce a focused, dependency-light retry wrapper that wraps OpenRouter HTTP calls in the OSS model path and transparently retries transient `5xx` responses using exponential backoff with jitter. The wrapper will live in the `shared-lib` domain so that `audit-orchestration`, `scripts`, and other permitted dependents can import it without layering violations. It will expose a single `withOpenRouterRetry(fn, options)` higher-order function and a small classification helper (`isTransientOpenRouterError`). Non-retryable errors (4xx, network errors with `ECONNRESET`-style semantics that should propagate, etc.) will short-circuit immediately. The wrapper is designed for testability via injectable sleep and clock functions, avoiding real timers in unit tests.

## Design Decisions

1. **Placement in `shared-lib`** (`scripts/lib/openrouter-retry.mjs`): The domain map permits `audit-orchestration`, `scripts`, `stores`, `tech-debt`, and others to depend on `shared-lib`. Placing the wrapper here maximizes reuse without introducing a new domain or cross-domain violation.

2. **Higher-order function, not a fetch subclass**: `withOpenRouterRetry(fn, opts)` wraps any async callable returning `{ status, data }` or throwing a network error. This avoids coupling to a specific HTTP client and is a true function of the problem (retry logic is orthogonal to transport).

3. **Retry only on 5xx and selected network errors**: OpenRouter 5xx (500, 502, 503, 504) are transient. 429 is explicitly excluded (handled by rate-limit logic elsewhere — out of scope). Network errors matching `ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `EAI_AGAIN` are retried since they are transient. All other errors propagate immediately.

4. **Exponential backoff with full jitter**: `delay = random(0, base * 2^attempt)`. Full jitter avoids thundering-herd when multiple workers retry simultaneously. Defaults: `maxAttempts = 4`, `baseDelayMs = 1000`, `maxDelayMs = 30000`. These are the smallest defaults that meaningfully cover typical OpenRouter recovery windows (usually <30s) without excessive user-visible latency.

5. **Injectable `sleep` and `now` for testability**: The wrapper accepts optional `{ sleep, now }` in its options. Production callers pass nothing (defaults to `setTimeout` and `Date.now`); tests inject deterministic stubs. This is the minimal seam needed — no mock framework or time-freezing library required.

6. **Logging via existing shared-lib logger pattern**: If the repo has a standard logger/warn utility in `shared-lib`, reuse it. Otherwise, emit to `console.warn` with a structured prefix `[openrouter-retry]`. This keeps the module zero-dependency.

7. **No persistence, no secrets**: The wrapper touches no stores, no secrets, no filesystem. It is a pure runtime utility. This satisfies the security invariants by construction.

8. **AbortSignal passthrough**: The wrapper forwards an optional `AbortSignal` from options to the sleep call, so a caller aborting mid-backoff won't wait for the full delay. The underlying `fn` is responsible for honoring the signal on its own.

9. **Error preservation**: On final attempt failure, the original error/response is re-thrown or returned unmodified — no wrapping in a new error type — so upstream callers' existing error handling remains unchanged.

## File-Level Plan

- **`scripts/lib/openrouter-retry.mjs`** — CREATE
  - Exports `withOpenRouterRetry(fn, options)` and `isTransientOpenRouterError(errorOrResponse)`.
  - `isTransientOpenRouterError`: classifies an error or response object as retryable. Checks status codes 500/502/503/504, and network error codes (`ECONNRESET`, `ETIMEDOWN`, `ECONNREFUSED`, `EAI_AGAIN`).
  - `withOpenRouterRetry`: loops up to `maxAttempts`, calls `fn`, classifies result, sleeps with jittered backoff between attempts, logs each retry, and returns/throws the final result.
  - Internal helper `computeBackoffDelay(attempt, baseDelayMs, maxDelayMs, jitterFn)`.

- **`tests/openrouter-retry.test.mjs`** — CREATE
  - Unit tests with injected `sleep` (records delays) and `now`.
  - Tests: (a) succeeds on first attempt — no sleep called; (b) retries on 503 then succeeds on attempt 2; (c) exhausts attempts on persistent 502 — original error preserved; (d) 400 error is not retried; (e) 429 is not retried; (f) `ECONNRESET` is retried; (g) backoff delays increase and respect `maxDelayMs` cap; (h) jitter produces values within `[0, cap]`; (i) `AbortSignal` abort interrupts sleep.

- **`scripts/lib/openrouter-retry.constants.mjs`** — CREATE (optional, only if constants are referenced by multiple consumers)
  - Exports `DEFAULT_RETRY_OPTIONS` (`maxAttempts: 4`, `baseDelayMs: 1000`, `maxDelayMs: 30000`), `TRANSIENT_STATUS_CODES` (`Set`), `TRANSIENT_NETWORK_ERRORS` (`Set`).
  - Rationale: keeps the main module lean and makes the classification sets importable by tests without coupling to internal logic.

## Risks

1. **Misclassification of 5xx variants**: Some 500s from OpenRouter may represent non-transient upstream failures (e.g., model permanently unavailable). Mitigation: The `maxAttempts` cap bounds wasted retries to ~7s of backoff; callers can override options for stricter behavior.

2. **Backoff latency perceived as hang**: A worst-case 4-attempt retry with jitter could add ~15-30s before failure. Mitigation: Each retry is logged with attempt number and delay, giving observability. Callers can set `maxAttempts: 1` to effectively disable.

3. **Double-retry if upstream already retries**: If an existing HTTP client in the repo already has retry logic, this wrapper could compound retries. Mitigation: Before wiring into callers, audit existing fetch wrappers in `shared-lib`; disable or reduce their retry if overlapping. (This plan creates the wrapper only; caller wiring is a separate, reviewable step.)

4. **AbortSignal edge cases**: If `AbortSignal` aborts during `fn` execution (not during sleep), the wrapper must propagate the `AbortError` immediately without retry. The implementation must check `signal.aborted` before each attempt, not just before sleep.

## Target Paths

- `scripts/lib/openrouter-retry.mjs`
- `scripts/lib/openrouter-retry.constants.mjs`
- `tests/openrouter-retry.test.mjs`

## Section 9 — Acceptance Criteria

1. `scripts/lib/openrouter-retry.mjs` exports `withOpenRouterRetry` and `isTransientOpenRouterError` as named exports.
2. `isTransientOpenRouterError` returns `true` for HTTP status codes 500, 502, 503, 504 and for network errors with codes `ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `EAI_AGAIN`.
3. `isTransientOpenRouterError` returns `false` for HTTP 4xx (including 429) and for non-transient error codes.
4. `withOpenRouterRetry` does not call `sleep` when the first attempt succeeds.
5. `withOpenRouterRetry` retries up to `maxAttempts` times when the response is transient, then returns the successful result if a subsequent attempt succeeds.
6. `withOpenRouterRetry` re-throws the original error (unmodified) when all attempts are exhausted on a transient failure.
7. `withOpenRouterRetry` does not retry on non-transient errors (4xx); the error/response propagates after the first attempt.
8. Backoff delays are computed as `random(0, min(maxDelayMs, baseDelayMs * 2^attempt))` and never exceed `maxDelayMs`.
9. `withOpenRouterRetry` accepts optional `{ sleep, now }` overrides; when provided, no real `setTimeout` or `Date.now` is called (verifiable in tests).
10. When an `AbortSignal` is provided and aborts, the wrapper stops retrying and propagates the abort reason without additional sleep.
11. Each retry attempt emits a log line containing attempt number and computed delay (verifiable via captured console output in tests).
12. All unit tests in `tests/openrouter-retry.test.mjs` pass with `node --test`.
13. No new layering violations are introduced: `scripts/lib/openrouter-retry.mjs` is tagged `shared-lib` and imports only from within `shared-lib` or Node built-ins.

