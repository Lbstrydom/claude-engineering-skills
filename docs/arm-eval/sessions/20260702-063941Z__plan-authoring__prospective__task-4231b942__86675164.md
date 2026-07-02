# Arm-eval session 86675164-4de6-4a5f-9946-275a1f8d6bdd

| Field | Value |
|---|---|
| Experiment | plan-authoring |
| Phase | prospective |
| Task id | `task-4231b942` |
| Seed (presentation-order RNG) | 21 |
| Config / rubric version | 1 / 1 |
| Created (UTC) | 2026-07-02T06:39:41.945Z |
| Repo | 8548afbd-8d85-50de-baca-1bb158d696da |
| Archive mode | FULL (attribution + judgments) |

## Task

Implement graceful degradation when GEMINI_API_KEY is absent in the final-review path

## Arms + outputs

### Arm GPT

- Models: `{"models":["latest-gpt"],"resolved":"latest-gpt"}`
- Conformant: true
- Output hash: `c8cd24bbd9073871`

## Overview

Implement graceful degradation for the final-review flow when `GEMINI_API_KEY` is not configured. Instead of throwing, exiting non-zero, or blocking the audit/cycle pipeline, the final-review path should detect the missing key early, emit an explicit “skipped” result, and continue safely.

The smallest correct solution is to add a single capability check at the Gemini final-review boundary, return a structured skip result, and make the orchestrating path treat that skip as non-fatal. Avoid adding a broad provider abstraction or global environment-management layer.

## Target Paths

- `scripts/gemini-review.mjs`
- `scripts/cycle.mjs`
- `tests/gemini-review.test.mjs`

## Design Decisions

### 1. Detect missing `GEMINI_API_KEY` before any Gemini request setup

**Decision:** Add an early guard in `scripts/gemini-review.mjs` before creating a client, building request payloads that assume credentials, or attempting network I/O.

**Rationale:**

- Prevents runtime crashes from SDK/client initialization.
- Avoids accidental unauthenticated network attempts.
- Keeps failure mode deterministic and fast.
- Localizes Gemini-specific behavior to the Gemini review script.

Expected behavior:

- If `process.env.GEMINI_API_KEY` is absent or blank:
  - final review is skipped;
  - a clear warning/status message is emitted;
  - no network call is attempted;
  - the command exits successfully when invoked as part of final-review degradation.

### 2. Represent the degraded state explicitly as “skipped”

**Decision:** Use an explicit skip outcome rather than pretending the review succeeded.

The result contract should distinguish:

- `status: "ok"` — Gemini review ran and produced output.
- `status: "skipped"` — Gemini review did not run because configuration was missing.
- `status: "error"` or existing error path — Gemini was configured but failed unexpectedly.

**Rationale:**

- Preserves correctness: missing review is not the same as passing review.
- Makes downstream behavior testable.
- Prevents silent quality regressions.
- Keeps the pipeline unblocked while retaining visibility.

If the repository already has a status/result shape for audit steps, reuse it instead of introducing a new parallel format.

### 3. Only degrade for missing credentials, not real configured failures

**Decision:** Treat absent/blank `GEMINI_API_KEY` as non-fatal in the final-review path. Continue to treat malformed responses, API errors, timeouts, or request construction bugs as the existing failure mode unless current architecture already classifies them as soft failures.

**Rationale:**

- The task is specifically about missing key graceful degradation.
- Broadly swallowing Gemini failures would mask real regressions.
- Keeps operational semantics predictable.

Failure mode matrix:

| Condition | Behavior |
|---|---|
| `GEMINI_API_KEY` missing | Skip final review, exit non-zero only if existing CLI has an explicit “strict” mode |
| `GEMINI_API_KEY` blank/whitespace | Same as missing |
| API key present but invalid | Existing Gemini failure behavior |
| API timeout/network error | Existing failure behavior |
| Unexpected exception before API call unrelated to key | Existing failure behavior |

### 4. Do not persist secrets or expose environment values

**Decision:** Logs and artifacts must never include the value of `GEMINI_API_KEY`.

**Rationale:**

- Maintains security invariant around credentials.
- Skip output only needs to say the key is absent, not show process environment contents.

Acceptable message example:

```text
Gemini final review skipped: GEMINI_API_KEY is not configured.
```

Unacceptable:

```text
GEMINI_API_KEY=
env: {...}
```

### 5. Keep artifacts stable and explicit

**Decision:** If final-review normally writes an output artifact, write a minimal skip artifact with the same expected location/shape when the key is missing.

**Rationale:**

- Downstream consumers should not crash on missing files.
- The pipeline can continue while preserving observability.
- Avoids “file not found” secondary failures.

The skip artifact should include:

- status/skipped indicator;
- reason code such as `missing_gemini_api_key`;
- human-readable message;
- timestamp only if existing artifacts already include timestamps.

Do not introduce nondeterministic fields into tests unless existing artifact format already requires them.

### 6. Make orchestration treat this skip as non-fatal

**Decision:** In `scripts/cycle.mjs`, where the final-review/Gemini step is invoked or interpreted, handle the skip result as a successful degradation rather than a hard failure.

**Rationale:**

- The user-facing issue is likely in the final-review path as part of the larger audit/cycle flow.
- Even if `scripts/gemini-review.mjs` exits cleanly, the orchestrator may still need to recognize a skip result or avoid invoking the command when the key is absent.
- The orchestration layer should continue the cycle while surfacing that final review was skipped.

Preferred approach:

1. Let `scripts/gemini-review.mjs` own the credential check.
2. Let `scripts/cycle.mjs` tolerate the explicit skip status/output.

Avoid duplicating environment checks in many places unless the current code already centralizes preflight checks in the orchestrator.

## File-Level Plan

### Modify `scripts/gemini-review.mjs`

Purpose: Add the graceful-degradation behavior at the Gemini final-review boundary.

Planned changes:

1. Locate the CLI entrypoint or main review function.
2. Add a small helper or inline check:

   - Treat `undefined`, empty string, and whitespace-only values as missing.
   - Do not log the key.
   - Perform this check before constructing Gemini client/request objects.

3. Return or emit a structured skipped result when missing:

   - `status: "skipped"` or repository-equivalent;
   - `reason: "missing_gemini_api_key"`;
   - message: `Gemini final review skipped: GEMINI_API_KEY is not configured.`;
   - no findings/review comments unless the existing schema requires an empty collection.

4. Preserve existing behavior when the key is present.

5. Ensure CLI exit behavior is graceful:

   - final-review mode exits `0` for the missing-key skip;
   - configured Gemini failures keep existing non-zero behavior.

6. If the script writes final-review output files, write the skip artifact using the same atomic/persistence conventions already used in this script or nearby audit scripts.

Implementation constraint:

- Reuse existing IO helpers, logging helpers, result renderers, and atomic-write utilities if already present.
- Do not add a new dependency.

### Modify `scripts/cycle.mjs`

Purpose: Ensure the larger final-review path does not fail the entire cycle when Gemini review is skipped due to missing credentials.

Planned changes:

1. Locate where `scripts/gemini-review.mjs` is invoked or where final-review result status is interpreted.
2. If the invocation currently assumes any absence of Gemini output is fatal, update it to accept the explicit skip result.
3. Surface the skip in the cycle summary/log output.
4. Preserve strict behavior for all other Gemini errors.

Expected cycle behavior:

- Missing `GEMINI_API_KEY`:
  - cycle completes;
  - summary says Gemini final review skipped;
  - no stack trace;
  - no failed process status solely due to missing key.

- Present `GEMINI_API_KEY`:
  - existing final-review path continues unchanged.

### Create or Modify `tests/gemini-review.test.mjs`

Purpose: Add regression coverage for the missing-key final-review path.

Planned tests:

1. **Missing key skips without failure**

   - Temporarily unset `process.env.GEMINI_API_KEY`.
   - Invoke the Gemini final-review entrypoint or CLI in final-review mode.
   - Assert exit code/result status is success/skipped.
   - Assert output contains the skip message.
   - Assert output does not include any secret value.

2. **Blank key is treated as missing**

   - Set `process.env.GEMINI_API_KEY = "   "`.
   - Assert same skipped behavior.

3. **No network/client call when missing key**

   - Use the repository’s existing test seams/mocks if available.
   - If no seam exists, test by invoking the function path before client construction and asserting no call to the Gemini request helper is made.
   - Avoid real external network calls.

4. **Configured key preserves existing behavior**

   - Set a fake non-empty key.
   - Mock the Gemini client/request helper.
   - Assert the script proceeds to the normal review path.

5. **Cycle/final-review integration**

   - If `scripts/cycle.mjs` has testable function exports, add a test asserting missing-key skip does not mark the whole cycle failed.
   - If not, prefer a CLI-level test with temporary output paths and mocked subprocess behavior, keeping it lightweight.

Test hygiene:

- Restore original environment variables after each test.
- Use temp directories for artifacts.
- Do not require a real Gemini API key.
- Do not perform network I/O.

## Persistence and Contract Safety

- If a final-review artifact is expected, the skip path should write it in the same schema family as successful review artifacts.
- Use atomic write helpers if existing final-review code writes artifacts atomically.
- Do not delete or overwrite unrelated audit artifacts.
- Ensure skipped output is parseable by existing downstream consumers.
- If existing consumers expect arrays for findings/comments, provide empty arrays rather than omitting required fields.

## Security Considerations

- Never log the value of `GEMINI_API_KEY`.
- Do not dump full `process.env`.
- Do not persist credential-derived configuration.
- The missing-key message should be explicit enough for operators but not reveal secrets.
- Keep the guard local to Gemini; do not alter unrelated provider credential handling.

## Risks

1. **Unknown existing result schema**

   The repository may already have a specific audit-step result schema. The implementation must reuse it where available to avoid breaking downstream parsers.

2. **Orchestrator may rely on process exit code only**

   If `scripts/cycle.mjs` only shells out and checks exit status, most of the fix may be in `scripts/gemini-review.mjs`. If it parses output, both files need coordinated changes.

3. **Tests may need a seam around Gemini client construction**

   If the current script constructs the Gemini client at module import time, refactor minimally so environment checks and client construction happen inside the runtime function. Avoid broad rewrites.

4. **Silent quality loss**

   Skipping final review can hide the absence of an external reviewer. Mitigate by making the skip visible in logs/artifacts and summaries.

5. **Behavior difference between direct CLI and cycle path**

   Direct invocation of `scripts/gemini-review.mjs` should also degrade gracefully unless there is an existing documented strict mode. Keep behavior consistent to avoid surprise.

## Section 9 — Acceptance Criteria

1. When `GEMINI_API_KEY` is unset, the final-review path completes without throwing an uncaught exception.

2. When `GEMINI_API_KEY` is unset, no Gemini API request/client call is attempted.

3. When `GEMINI_API_KEY` is unset, the final-review result is explicitly marked as skipped with a reason equivalent to `missing_gemini_api_key`.

4. When `GEMINI_API_KEY` is unset, the cycle/final-review orchestration exits successfully unless another unrelated step fails.

5. When `GEMINI_API_KEY` is blank or whitespace-only, behavior is the same as when it is unset.

6. When `GEMINI_API_KEY` is present, the existing Gemini final-review behavior is preserved.

7. Missing-key skip logs/artifacts do not include the API key value or a dump of `process.env`.

8. If the final-review path normally writes an artifact, the missing-key path writes a valid skipped artifact consumable by downstream code.

9. Tests cover unset key, blank key, no-network-on-missing-key, and configured-key normal-path behavior.

10. No new external dependencies are introduced.

### Arm OSS-DS

- Models: `{"models":["deepseek/deepseek-v4-pro"],"resolved":"deepseek/deepseek-v4-pro"}`
- Conformant: true
- Output hash: `df498ee54b1ed159`

## Plan: Graceful degradation when `GEMINI_API_KEY` is absent in the final-review path

### Overview
The final review step in the audit pipeline relies on the Google Gemini API. Currently, when the `GEMINI_API_KEY` environment variable is missing the process fails with an unhandled error, breaking the entire pipeline. This plan adds a pre‑flight check at the entry point of the Gemini review so the system degrades gracefully: the review is skipped, a clear warning is emitted, and the overall orchestration continues without failure.

### Design Decisions

1. **Check location** – At the very beginning of the `main` function (or the exported function that drives the review) in `scripts/gemini-review.mjs`. This catches the missing key before any API client is instantiated, avoids code duplication, and protects all callers transparently.
   - **Rationale**: The script is the single documented entry point for Gemini‑based review; placing the guard here gives the largest blast radius with the smallest change.

2. **Degradation behaviour** – When the key is absent, the function prints a warning to stderr and either exits with code 0 (if it is a CLI script) or returns a `{ skipped: true, reason: 'missing-api-key' }` object (if it is used as a library).
   - **Rationale**: Skipping is the correct, minimal behaviour – the final review is an enhancement, not a hard dependency. Exiting with code 0 prevents CI/CD failures; returning a sentinel allows programmatic callers to react.

3. **No fallback provider** – We intentionally do **not** wire up a local model or an alternative API. That would increase maintenance surface and is out of scope.
   - **Rationale**: Right‑sizing: the only true function of the problem is “don’t crash”. Anything beyond a skip is over‑engineering.

4. **Logging** – Use `console.warn` (or the project’s shared logger if already imported) so the message is visible on stderr.
   - **Rationale**: Reuses existing patterns; no new dependency.

5. **Error resilience** – If the key exists but is invalid, the original error path (thrown by the Gemini client) remains untouched. We only guard against the *absent* key.
   - **Rationale**: Keep the change minimal and orthogonal.

6. **Testability** – A new unit test will simulate the missing‑key and present‑key (mocked) scenarios, verifying both the warning message and the exit/return contract.

### File‑Level Plan

#### 1. **Modify** `scripts/gemini-review.mjs`
- **Purpose**: Core script that performs the Gemini‑based final review.
- **Current state**: Likely instantiates a Gemini client at module load or at the start of `main` and assumes `process.env.GEMINI_API_KEY` is set.
- **Change**:
  - Open the file and locate the `main` function (or the function that is exported and called externally, e.g. `runGeminiReview`).
  - At the very top, insert:
    ```js
    if (!process.env.GEMINI_API_KEY) {
      console.warn(‘GEMINI_API_KEY not set. Skipping Gemini final review.’);
      if (/* this is a CLI entry-point */) {
        proess.exitCode = 0;
        return;
      }
      return { skipped: true, reason: ‘missing-api-key’ };
    }
    ```
  - If a global Gemini client is instantiated at module load, move that code inside a lazy initializer so it never runs when the key is missing.
  - Adjust any existing callers (if the function is imported elsewhere) to handle the new skip result.

#### 2. **Modify** `scripts/cycle.mjs` (if it orchestrates the final review)
- **Purpose**: Audit cycle orchestrator that may invoke the Gemini review step as part of a larger pipeline.
- **Current state**: May `import { runGeminiReview }` from `gemini-review.mjs` or spawn the script as a child process.
- **Change**:
  - Inspect how the review is invoked.
  - If it is a direct function call, add a check on the returned object: `if (result.skipped) { console.log(‘Final review skipped (missing GEMINI_API_KEY).’); }` and continue.
  - If it is a child process, no change is needed—exit code 0 already signals success.
  - This ensures the cycle completes normally even when the key is absent.

#### 3. **Create** `tests/gemini-review-graceful.test.mjs` (new)
- **Purpose**: Validate the new degradation behaviour in isolation.
- **Change**:
  - Write two test cases:
    1. `GEMINI_API_KEY` not set → call the function; assert that a warning is written to stderr and the function returns a skip object (or the process exits with 0).
    2. `GEMINI_API_KEY` set (with a mock client) → assert the function proceeds normally and the warning is **not** printed.
  - Use the project’s existing test runner (e.g., `node:test` or `vitest`), following patterns seen in `tests/` directory.
  - If a previous test file for `gemini-review.mjs` exists, update it to supply a fake key so it doesn’t break.

#### 4. **Modify** (if it exists) `scripts/lib/audit/gemini-client.mjs`
- **Purpose**: Shared Gemini client used by multiple audit steps.
- **Change**: If this module eagerly initialses a client, wrap the construction in a function that checks `process.env.GEMINI_API_KEY` and throws a descriptive `MissingAPIKey` error (or returns a disabled client stub). This is a secondary, defensive guard; the primary guard in the entry‑point script remains sufficient. Only touch this file if a grep confirms its existence and it is in the same call path.

### Risks
- **Silent skip in CI** – If the warning isn’t captured in CI logs, teams may not realise the review is missing. *Mitigation*: use `console.warn` and a prominent `⚠️` prefix; document the behaviour in the project README or runbook.
- **Downstream consumers** – If a later pipeline step expects a review artifact, the skip could cause a secondary failure. *Mitigation*: ensure `cycle.mjs` (and any other orchestrator) explicitly handles the skip status; we’ll test the full cycle with the key missing.
- **Existing test breakage** – Tests that mock the Gemini client may not supply a key and now fail on the new guard. *Mitigation*: Update those tests to set `process.env.GEMINI_API_KEY` to a dummy value or mock the check.
- **Over‑modification** – Adding a fallback would increase complexity and maintenance. *Mitigation*: the design explicitly rejects fallbacks; we will stay disciplined during implementation.

## Target Paths
- `scripts/gemini-review.mjs`
- `scripts/cycle.mjs`
- `tests/gemini-review-graceful.test.mjs` (new)
- `scripts/lib/audit/gemini-client.mjs` (only if present and in the call chain)

## Section 9 — Acceptance Criteria
1. When the `GEMINI_API_KEY` environment variable is **not set**, the `main` (or equivalent) function of `scripts/gemini-review.mjs` emits a warning to stderr that contains the string `"GEMINI_API_KEY not set"` and either exits with code 0 or returns an object with `skipped: true`.
2. When the key is absent, the audit cycle (run via `scripts/cycle.mjs` or its equivalent) completes without error; the final review step is skipped and a log message appears.
3. When the key is **set** (and a valid client is available, mocked in tests), the review function proceeds normally and produces its expected output.
4. A dedicated unit test exists that exercises both the missing-key and present-key scenarios and can be executed independently.
5. All existing tests that previously assumed a present key continue to pass after being updated with a mock key or an overridden check.
6. The change introduces no new dependencies, does not alter the allowed dependency graph, and respects the existing layering (audit-orchestration → shared-lib, etc.).
7. No other Gemini‑calling code path is left unprotected; a grep for `GEMINI_API_KEY` across the codebase confirms all references are covered by the same guard pattern.

### Arm OSS-GLM

- Models: `{"models":["z-ai/glm-5.2"],"resolved":"z-ai/glm-5.2"}`
- Conformant: true
- Output hash: `6ff9ed54b30c77c4`

# Implementation Plan — Graceful Degradation for Missing `GEMINI_API_KEY` in Final-Review Path

## Overview

The final-review path (`scripts/gemini-review.mjs`, domain `audit-orchestration`) currently fails hard when `GEMINI_API_KEY` is absent from the environment. This plan introduces a bounded graceful-degradation mode: when the key is missing, the review path emits a structured "skipped" finding set with a clear degradration marker, rather than crashing or silently producing empty output. The degradation is explicit, observable, and testable — downstream consumers (findings store, dashboard, cycle orchestration) already tolerate finding records with a `status` field, so no downstream contract changes are required.

The scope is deliberately narrow: we do **not** add a fallback LLM provider, retry logic, or partial-review synthesis. The smallest true function of the problem is: detect absence → produce a well-formed skipped result → log a warning → exit zero with degraded output.

## Design Decisions

1. **Detect at the entry boundary, not deep in the call stack.**
   - Rationale: Failing fast at the top of `gemini-review.mjs` (or its shared config loader) prevents partial state — half-written findings, open network sockets, or misleading error messages from the SDK. The check belongs before any Gemini client construction.

2. **Reuse the existing findings contract, not a new "skipped" type.**
   - Rationale: The `findings` domain already has a structured record shape. A degradation result is represented as a single finding record with `status: "skipped"` and `reason: "GEMINI_API_KEY absent"`. This avoids contract drift and keeps the dashboard/cycle consumers unchanged.

3. **Warn via `console.warn` (or the shared logging helper), not `console.error`.**
   - Rationale: Exit code is 0 (degraded-but-successful), so the diagnostic goes to stderr-warning channel to avoid being interpreted as a hard failure by CI grep patterns. This matches the existing convention in `audit-orchestration` for non-fatal warnings.

4. **Introduce a single helper: `resolveGeminiConfig()` in shared-lib.**
   - Rationale: Both `gemini-review.mjs` and any future test need to assert "key present / absent" logic. Centralizing the env-read + validation in one pure function (no I/O) makes it trivially testable and avoids scattering `process.env.GEMINI_API_KEY` checks across files. The function returns `{ available: boolean, key: string | null, reason: string | null }`.

5. **No new dependencies, no new env-var overrides.**
   - Rationale: Adding a `GEMINI_ALLOW_SKIP` flag would be over-engineering — the absence of the key *is* the signal. We do not add a force-mode; if the key is absent, degradation is unconditional.

6. **Exit code 0 with degraded output, not exit code 2.**
   - Rationale: The cycle orchestration (`scripts/cycle.mjs`) treats non-zero exits as hard failures that halt the loop. Degradation is a successful-but-incomplete state; halting the cycle on a missing key would be worse than proceeding with a skipped review.

7. **Emit a machine-readable marker in the findings JSON.**
   - Rationale: Downstream tools (dashboard, learning-store) that aggregate review results need to distinguish "0 findings because clean" from "0 findings because skipped." A top-level `degraded: true` flag in the output envelope (alongside the findings array) makes this unambiguous without changing per-finding schema.

## File-Level Plan

| File | Action | Purpose |
|---|---|---|
| `scripts/lib/gemini-config.mjs` | **Create** | New shared-lib module exporting `resolveGeminiConfig()` — a pure function reading `process.env.GEMINI_API_KEY`, returning `{ available, key, reason }`. Also exports `DEGRADATION_REASON` constant. |
| `scripts/gemini-review.mjs` | **Modify** | Import `resolveGeminiConfig`. At entry, after arg parsing but before client construction, call the resolver. If `available === false`, emit degraded output envelope `{ findings: [{ status: "skipped", reason, ... }], degraded: true, reviewer: "gemini", timestamp }`, warn to stderr, and `process.exit(0)`. |
| `tests/gemini-review-degradation.test.mjs` | **Create** | Unit + integration test: (a) `resolveGeminiConfig` returns `available: false` when env unset; (b) `gemini-review.mjs` run with no key produces exit 0, degraded envelope, skipped finding; (c) run with key present still proceeds normally (mocked). |
| `tests/gemini-config.test.mjs` | **Create** | Focused unit tests for `resolveGeminiConfig`: empty string key treated as absent, whitespace-only key treated as absent, valid key returns `available: true`. |

## Target Paths

- `scripts/lib/gemini-config.mjs`
- `scripts/gemini-review.mjs`
- `tests/gemini-review-degradation.test.mjs`
- `tests/gemini-config.test.mjs`

## Risks

1. **Existing callers may assert on finding count > 0.** If any downstream consumer in `audit-orchestration` or `dashboard` treats zero substantive findings as an error, the skipped finding (with `status: "skipped"`) should satisfy that check — but this needs verification against `scripts/cycle.mjs` and dashboard collectors. Mitigation: the skipped finding *is* a finding record, so counts remain ≥1.

2. **Whitespace-only or placeholder keys.** A key set to `"placeholder"` or `" "` would pass a simple truthiness check but fail at the API. `resolveGeminiConfig` must validate non-empty after trim, not just truthiness. Placeholder detection (e.g., `"your-key-here"`) is intentionally out of scope — that's a configuration-quality problem, not a degradation-path problem.

3. **Silent degradation masking persistent misconfiguration.** If the key is accidentally removed from CI, every review silently skips with no actionable signal. Mitigation: the `console.warn` message is explicit and the `degraded: true` flag is visible in the output JSON. Additionally, the test suite asserts the warning is emitted, so CI logs will show it.

4. **Domain boundary: `scripts/lib/gemini-config.mjs` falls under `shared-lib`** (per the `scripts/lib/**` rule), while `gemini-review.mjs` is `audit-orchestration`. The allowed-deps map permits `audit-orchestration → shared-lib`, so this import is layering-safe. No violation introduced.

5. **Test environment isolation.** Tests that manipulate `process.env.GEMINI_API_KEY` must save/restore the original value to avoid cross-test contamination. Use `beforeEach`/`afterEach` env snapshots.

## Section 9 — Acceptance Criteria

1. When `GEMINI_API_KEY` is unset, empty, or whitespace-only, `resolveGeminiConfig()` returns `{ available: false, key: null, reason: "GEMINI_API_KEY absent" }`.
2. When `GEMINI_API_KEY` is set to a non-empty, non-whitespace value, `resolveGeminiConfig()` returns `{ available: true, key: <string>, reason: null }`.
3. Running `node scripts/gemini-review.mjs` with no `GEMINI_API_KEY` in the environment exits with code 0.
4. The stdout JSON output of a degraded run contains `"degraded": true` at the top level.
5. The degraded output contains at least one finding record with `"status": "skipped"` and a `reason` field referencing the absent key.
6. A warning message is written to stderr during a degraded run.
7. No network call or Gemini SDK client construction occurs during a degraded run (verifiable by mocking/asserting no SDK import side-effects).
8. Running `node scripts/gemini-review.mjs` with a valid `GEMINI_API_KEY` (mocked SDK) proceeds to the normal review path and produces output with `"degraded"` absent or `false`.
9. `resolveGeminiConfig` is a pure function with no I/O side effects (does not read files, does not mutate `process.env`).
10. All new and modified files pass the existing lint and domain-classification checks without introducing layering violations.

## Judge scores (blinded at judge time; unblinded here post-ranking)

| Pass | Label | Arm | Scores |
|---|---|---|---|
| 1 | output-1 | OSS-DS | `{"reuse":2,"clarity":3,"correctness":3,"completeness":3,"right_sizing":4,"risk_handling":3,"implementability":2,"repo_intent_fidelity":2,"architectural_coherence":3,"acceptance_criteria_quality":3}` |
| 1 | output-2 | GPT | `{"reuse":4,"clarity":4,"correctness":4,"completeness":4,"right_sizing":4,"risk_handling":4,"implementability":4,"repo_intent_fidelity":3,"architectural_coherence":3,"acceptance_criteria_quality":4}` |
| 1 | output-3 | OSS-GLM | `{"reuse":4,"clarity":5,"correctness":4,"completeness":4,"right_sizing":4,"risk_handling":4,"implementability":4,"repo_intent_fidelity":4,"architectural_coherence":5,"acceptance_criteria_quality":5}` |
| 2 | output-1 | OSS-DS | `{"reuse":2,"clarity":3,"correctness":3,"completeness":3,"right_sizing":3,"risk_handling":3,"implementability":2,"repo_intent_fidelity":2,"architectural_coherence":3,"acceptance_criteria_quality":3}` |
| 2 | output-2 | GPT | `{"reuse":4,"clarity":4,"correctness":4,"completeness":4,"right_sizing":4,"risk_handling":4,"implementability":4,"repo_intent_fidelity":3,"architectural_coherence":3,"acceptance_criteria_quality":4}` |
| 2 | output-3 | OSS-GLM | `{"reuse":4,"clarity":5,"correctness":4,"completeness":4,"right_sizing":4,"risk_handling":4,"implementability":4,"repo_intent_fidelity":4,"architectural_coherence":5,"acceptance_criteria_quality":5}` |

## Human ranking (best → worst)

- output-3 > output-2 > output-1 — review-mode (2026-07-02T08:04:56.775Z)

