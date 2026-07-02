# Arm-eval session 63d053a7-cbdd-43d4-8a5d-47e107a9c04d

| Field | Value |
|---|---|
| Experiment | plan-authoring |
| Phase | prospective |
| Task id | `task-9d806e4a` |
| Seed (presentation-order RNG) | 18 |
| Config / rubric version | 1 / 1 |
| Created (UTC) | 2026-07-02T06:19:46.995Z |
| Repo | 8548afbd-8d85-50de-baca-1bb158d696da |
| Archive mode | FULL (attribution + judgments) |

## Task

Add structured logging with correlation IDs across the multi-pass audit pipeline

## Arms + outputs

### Arm GPT

- Models: `{"models":["latest-gpt"],"resolved":"gpt-5.5","backfillNote":"backfilled 2026-07-02: sentinel resolved against live catalog same-day as all runs"}`
- Conformant: true
- Output hash: `637eeb184eac0d88`

## Overview

Add a small, shared structured logging facility and thread a single correlation ID through the multi-pass audit pipeline, including child audit processes. The implementation should preserve existing CLI/stdout contracts by writing logs to `stderr` as newline-delimited JSON, while keeping audit machine-readable outputs on `stdout` unchanged.

The core design is:

- Generate or accept one `correlation_id` at the audit pipeline boundary.
- Propagate that ID explicitly through audit context objects and child process environment/args.
- Emit structured JSON log events at pipeline/pass/tool boundaries.
- Avoid logging prompts, model responses, API keys, file contents, or other sensitive payloads.
- Keep the logger in `shared-lib`; keep audit-specific context helpers in `audit-orchestration`.

## Target Paths

- `scripts/lib/structured-logger.mjs`
- `scripts/lib/audit/logging-context.mjs`
- `scripts/cycle.mjs`
- `scripts/openai-audit.mjs`
- `scripts/gemini-review.mjs`
- `tests/structured-logger.test.mjs`
- `tests/audit-correlation.test.mjs`

## Design Decisions

### 1. Use newline-delimited JSON on `stderr`

**Decision:** Structured logs are emitted as one JSON object per line to `stderr`.

**Rationale:**

- Preserves existing `stdout` contracts for commands that output JSON, markdown, or audit artifacts.
- Easy to parse in CI and shell pipelines.
- Avoids adding a logging dependency.
- Right-sized for CLI scripts and multi-process orchestration.

**Contract example:**

```json
{
  "ts": "2026-07-02T12:34:56.789Z",
  "level": "info",
  "event": "audit.pass.start",
  "component": "cycle",
  "correlation_id": "8a61a2f1-6e4a-4c9a-a2f0-7fb8c0e8f4bd",
  "pass_id": "pass-2",
  "audit_run_id": "20260702-123456",
  "metadata": {
    "auditor": "gemini"
  }
}
```

### 2. Put generic logging in `shared-lib`

**Decision:** Create `scripts/lib/structured-logger.mjs` as a shared utility.

**Rationale:**

- `audit-orchestration` is allowed to depend on `shared-lib`.
- Keeps logger reusable without introducing an audit-domain dependency.
- Avoids duplicating logging logic in OpenAI/Gemini/Cycle scripts.

### 3. Keep audit-specific correlation helpers in `audit-orchestration`

**Decision:** Create `scripts/lib/audit/logging-context.mjs` for audit pipeline concerns such as env propagation and pass-level logger derivation.

**Rationale:**

- Correlation ID parsing/normalization is generic.
- Audit pass naming, child process propagation, and audit run context are audit-specific.
- Maintains domain boundaries from the existing architecture map.

### 4. Prefer explicit context propagation over global state

**Decision:** Pass logger/context objects explicitly where practical, and propagate to child processes via environment variables.

**Rationale:**

- More testable than implicit global state.
- Avoids `AsyncLocalStorage` complexity, which is unnecessary for CLI-oriented scripts.
- Works across process boundaries.

### 5. Support inbound correlation IDs

**Decision:** Accept correlation IDs from, in order:

1. CLI flag `--correlation-id <id>`
2. Environment variable `AUDIT_CORRELATION_ID`
3. Generated UUID via `crypto.randomUUID()`

**Rationale:**

- Enables CI systems to inject their own trace IDs.
- Enables parent processes to correlate child script logs.
- Provides deterministic testing hooks.

### 6. Validate and sanitize correlation IDs

**Decision:** Accept only safe correlation ID strings matching a conservative pattern, for example:

```text
^[A-Za-z0-9._:-]{1,128}$
```

If invalid, generate a new UUID and log a warning with no untrusted raw value included.

**Rationale:**

- Prevents log injection and malformed JSON-adjacent metadata.
- Avoids accepting arbitrarily large values from env/CLI.
- Keeps compatibility with UUIDs and common CI trace IDs.

### 7. Add redaction guardrails

**Decision:** Logger should redact obvious secret-bearing keys from metadata before serialization.

Suggested key matching:

- `apiKey`
- `api_key`
- `authorization`
- `token`
- `secret`
- `password`
- `OPENAI_API_KEY`
- `GEMINI_API_KEY`

**Rationale:**

- Logging metadata is useful, but model/API workflows are high risk for accidental credential leakage.
- Redaction should be defensive and recursive for plain objects/arrays.
- Do not log prompt bodies, model responses, diffs, or full file contents.

### 8. Log lifecycle events, not payloads

**Decision:** Add logs for high-value pipeline events:

- Pipeline start/end/failure
- Pass start/end/failure
- Child process spawn/exit/failure
- Model audit start/end/failure
- Retry attempts, if existing retry behavior is present
- Output artifact paths, if already part of existing public behavior and safe

**Rationale:**

- Gives observability across the multi-pass flow without exposing sensitive content.
- Keeps log volume low.
- Avoids changing audit behavior.

## File-Level Plan

### `scripts/lib/structured-logger.mjs` — create

Purpose: Shared structured logging utility.

Plan:

- Export correlation helpers:
  - `createCorrelationId()`
  - `normalizeCorrelationId(value)`
  - `resolveCorrelationId({ argv, env })`
- Export logger factory:
  - `createStructuredLogger({ component, correlationId, stream, level, baseFields })`
- Logger methods:
  - `debug(event, metadata)`
  - `info(event, metadata)`
  - `warn(event, metadata)`
  - `error(event, metadata)`
  - `child(extraBaseFields)`
- Emit newline-delimited JSON to the provided stream, defaulting to `process.stderr`.
- Include standard fields:
  - `ts`
  - `level`
  - `event`
  - `component`
  - `correlation_id`
  - optional `metadata`
- Validate event names as non-empty safe strings.
- Serialize errors safely:
  - `name`
  - `message`
  - `code` if present
  - omit stack by default unless an existing debug mode convention exists.
- Redact secret-like keys recursively.
- Handle serialization failures by emitting a minimal fallback log line rather than throwing.
- Do not write files or persist logs directly.

Failure modes:

- Invalid correlation ID: generate a new one and expose a warning event.
- Invalid metadata/circular object: log fallback metadata indicating serialization failure.
- Broken stream: do not crash the audit pipeline solely because logging failed, unless existing stream behavior already throws.

---

### `scripts/lib/audit/logging-context.mjs` — create

Purpose: Audit-domain helper for consistent context propagation.

Plan:

- Import from `scripts/lib/structured-logger.mjs`.
- Export constants:
  - `AUDIT_CORRELATION_ID_ENV = 'AUDIT_CORRELATION_ID'`
  - optionally `AUDIT_RUN_ID_ENV = 'AUDIT_RUN_ID'`
- Export helpers:
  - `createAuditLoggingContext({ argv, env, component })`
  - `withAuditCorrelationEnv(env, context)`
  - `createPassLogger(context, { passId, auditor })`
  - `appendCorrelationArgs(args, context)` if child scripts need CLI propagation in addition to env.
- Generate an `audit_run_id` if there is no existing run identifier convention.
- Ensure child process env merges preserve existing env values and only adds/overrides audit correlation fields.
- Keep the helper free of provider-specific logic.

Failure modes:

- Missing env object: default to `process.env`.
- Invalid inbound ID: rely on shared logger normalization and include one warning event.
- Child env construction should never drop existing required variables.

---

### `scripts/cycle.mjs` — modify

Purpose: Establish root correlation ID for the multi-pass pipeline and log orchestration lifecycle.

Plan:

- At CLI entry, create audit logging context using `createAuditLoggingContext`.
- Preserve existing argument parsing and behavior.
- Accept optional `--correlation-id`.
- Log:
  - `audit.pipeline.start`
  - `audit.pass.start`
  - `audit.pass.end`
  - `audit.pass.fail`
  - `audit.pipeline.end`
  - `audit.pipeline.fail`
- Include safe metadata only:
  - pass number/id
  - auditor name
  - command/script name
  - exit code
  - duration in milliseconds
  - artifact path if already safe/public
- When spawning or invoking `scripts/openai-audit.mjs`, `scripts/gemini-review.mjs`, or other audit subprocesses:
  - pass `AUDIT_CORRELATION_ID`
  - pass `AUDIT_RUN_ID` if added
  - optionally append `--correlation-id <id>` where existing process conventions make env propagation insufficient.
- Ensure pipeline errors are logged before rethrowing or exiting with the existing code.
- Do not change stdout output.

Failure modes:

- Child process exits non-zero: log structured failure with code/signal, then preserve existing failure behavior.
- Logger initialization fails unexpectedly: fallback to current behavior and emit no logs rather than breaking audits.
- Existing `--correlation-id` flag conflict: if already used for something else, prefer env-only propagation and document in code comments.

---

### `scripts/openai-audit.mjs` — modify

Purpose: Consume propagated correlation ID and log OpenAI audit lifecycle events.

Plan:

- Initialize audit logging context at entry with component `openai-audit`.
- Consume `AUDIT_CORRELATION_ID` or `--correlation-id`.
- Log:
  - `audit.provider.start`
  - `audit.provider.request.start`
  - `audit.provider.request.end`
  - `audit.provider.fail`
  - `audit.provider.end`
- Include safe metadata:
  - provider identifier as `openai`
  - configured model name if already visible in CLI/config output
  - pass id if available
  - retry attempt counts if existing
  - duration
- Do not log:
  - prompts
  - completions/responses
  - API keys
  - authorization headers
  - file contents
  - raw diffs
- Ensure any subprocess/file operations inherit the same correlation env if this script invokes further scripts.
- Preserve existing exit codes and outputs.

Failure modes:

- Missing API key: log provider failure with sanitized error type/message, preserving existing user-facing error.
- API/network error: log sanitized error and preserve existing retry/exit behavior.
- Invalid correlation ID: regenerate/normalize through shared utility.

---

### `scripts/gemini-review.mjs` — modify

Purpose: Consume propagated correlation ID and log Gemini review lifecycle events.

Plan:

- Initialize audit logging context at entry with component `gemini-review`.
- Consume `AUDIT_CORRELATION_ID` or `--correlation-id`.
- Log:
  - `audit.provider.start`
  - `audit.provider.request.start`
  - `audit.provider.request.end`
  - `audit.provider.fail`
  - `audit.provider.end`
- Include safe metadata:
  - provider identifier as `gemini`
  - model name if already visible in CLI/config output
  - pass id if available
  - duration
  - retry count if existing
- Apply the same redaction and payload-avoidance rules as OpenAI.
- Preserve existing behavior, exit codes, and stdout.

Failure modes:

- Missing Gemini credentials: sanitized failure log only.
- Provider response parsing error: sanitized structured error log while preserving existing handling.
- Invalid inherited correlation ID: regenerate/normalize consistently.

---

### `tests/structured-logger.test.mjs` — create

Purpose: Unit coverage for shared structured logger behavior.

Plan test cases:

- Emits valid one-line JSON per log event.
- Includes required fields:
  - `ts`
  - `level`
  - `event`
  - `component`
  - `correlation_id`
- Generates UUID-like correlation ID when none supplied.
- Uses valid supplied correlation ID.
- Rejects/normalizes invalid correlation IDs.
- Redacts secret-like keys recursively.
- Serializes `Error` objects safely.
- Does not include stack traces by default.
- Handles circular metadata without throwing.
- Writes to injected stream for deterministic tests.

---

### `tests/audit-correlation.test.mjs` — create

Purpose: Verify audit-specific propagation and entrypoint behavior without making provider API calls.

Plan test cases:

- `createAuditLoggingContext` reads `AUDIT_CORRELATION_ID`.
- CLI `--correlation-id` takes precedence over environment value.
- `withAuditCorrelationEnv` preserves existing env values and injects audit correlation fields.
- Pass logger includes `pass_id` and `audit_run_id`.
- `scripts/cycle.mjs` child process invocation receives `AUDIT_CORRELATION_ID`.
  - Prefer testing helper-level spawn argument construction if direct CLI integration is too brittle.
- OpenAI/Gemini entrypoint logging initialization can be tested in dry-run/mock mode if such a mode already exists; otherwise keep integration tests at helper level to avoid network calls.

## Security and Safety Considerations

- Logs must not contain provider secrets, tokens, prompts, generated responses, raw diffs, or file contents.
- Correlation IDs from env/CLI must be length-limited and character-limited.
- Logging failures should not corrupt audit artifacts or alter audit decisions.
- Keep logs on `stderr` to avoid breaking consumers that parse `stdout`.
- Avoid persistent log files unless the user/CI redirects output externally.
- Do not introduce new external dependencies for logging.

## Persistence and Contract Correctness

- No new persistent state is required.
- Existing audit output files and stdout formats remain unchanged.
- Structured log schema should be additive and stable.
- Any new CLI flag must be optional.
- Existing exit codes are preserved.
- Child env propagation must merge with, not replace, existing environment variables.

## Test Strategy

- Unit-test the logger with injected writable streams.
- Unit-test audit context/env propagation independently of provider calls.
- Add lightweight integration coverage around the cycle orchestration only where existing test seams permit mocking child processes.
- Avoid tests that call OpenAI/Gemini APIs.
- Validate that structured logs are emitted to `stderr`, not `stdout`.

## Risks

1. **Breaking stdout consumers**
   - Mitigation: write logs only to `stderr`; add tests that stdout remains untouched where feasible.

2. **Accidental secret leakage**
   - Mitigation: recursive redaction, conservative metadata selection, no prompt/response logging.

3. **Correlation ID not propagated to all passes**
   - Mitigation: centralize env propagation in `scripts/lib/audit/logging-context.mjs` and update all child process creation in `scripts/cycle.mjs`.

4. **Existing argument parser conflicts**
   - Mitigation: prefer environment propagation; only add `--correlation-id` if no conflict exists.

5. **Provider tests becoming flaky**
   - Mitigation: test provider scripts through dry-run/mock seams only; otherwise limit tests to shared helpers.

6. **Over-logging**
   - Mitigation: lifecycle events only, no payload logging, default level `info`.

7. **Invalid inherited correlation values**
   - Mitigation: validate, sanitize, and regenerate safely with a warning event.

## Section 9 — Acceptance Criteria

1. Running the multi-pass audit pipeline emits newline-delimited JSON log records to `stderr`.

2. Audit command `stdout` remains compatible with existing behavior and does not include structured log lines.

3. A single `correlation_id` is present on pipeline, pass, OpenAI audit, and Gemini review log events within one pipeline run.

4. When `AUDIT_CORRELATION_ID` is set, the emitted logs use that value if it is valid.

5. When `--correlation-id <id>` is supplied, it takes precedence over `AUDIT_CORRELATION_ID` if both are present.

6. Invalid or unsafe correlation IDs are not emitted raw; a safe generated ID is used instead.

7. Child audit processes spawned by `scripts/cycle.mjs` receive the same correlation ID through their environment.

8. Structured logs include stable fields: `ts`, `level`, `event`, `component`, and `correlation_id`.

9. Provider lifecycle failures are logged with sanitized error information while preserving existing exit behavior.

10. Logs do not include API keys, authorization headers, prompt bodies, model responses, raw diffs, or full file contents.

11. Secret-like metadata keys are redacted recursively by the shared logger.

12. Logger serialization failures, including circular metadata, do not crash the audit pipeline.

13. Unit tests cover correlation ID generation, validation, env/CLI precedence, redaction, error serialization, and stream output.

14. Audit correlation tests verify env propagation from orchestration to child audit contexts without requiring external provider API calls.

15. The implementation respects domain boundaries: audit orchestration imports shared logging utilities, while shared logging utilities do not import audit-specific modules.

### Arm OSS-DS

- Models: `{"models":["deepseek/deepseek-v4-pro"],"resolved":"deepseek/deepseek-v4-pro"}`
- Conformant: true
- Output hash: `ef57d0707f4cca74`

## Overview

Add structured JSON logging with a unique correlation ID to the multi‑pass audit pipeline so that every log entry from a single orchestrated run shares the same identifier. The logging utility is minimal, lives inside the `audit-orchestration` domain, and is passed through the pipeline via explicit parameters (no hidden global state). The implementation does not alter existing audit behavior, only adds observability.

**Key outcomes:**
- A new `scripts/lib/audit/structured-logger.mjs` module that creates a logger writing JSON lines to `stdout`.
- The top‑level audit script (likely `scripts/cycle.mjs`) generates a UUID correlation ID, creates a logger, and passes the logger (or the correlation ID) to each downstream pass.
- Each pass logs start, completion, and any error events with the same correlation ID.
- Existing exit codes, file‑side‑effects, and external contracts remain unchanged.
- Downstream tooling (dashboards, grep) can easily filter by `correlationId`.

---

## Design Decisions

### 1. Logger lives inside `audit-orchestration`, not `shared-lib`
**Rationale:**  
The requirement is scoped to the audit pipeline. Placing the module in `scripts/lib/audit/` respects the architectural domain rules (`scripts/lib/audit/**` → `audit-orchestration`) and avoids premature sharing. If another domain later needs structured logging, the utility can be lifted to `shared-lib` at that time.

### 2. Correlation ID generated at the top‑level orchestrator
**Rationale:**  
A UUID v4 is created once per run in the main entry point (e.g., `scripts/cycle.mjs` main function). This guarantees uniqueness across runs and simplicity. No central registry or `AsyncLocalStorage` is needed.

### 3. Correlation ID propagated explicitly through function arguments
**Rationale:**  
Explicit threading (passing `correlationId` or a logger instance) is the smallest, most testable approach. All audit passes are called from the orchestrator; adding a string parameter to existing functions keeps contracts clear and avoids global state or complex context propagation.

### 4. Logger writes to `stdout` as newline‑delimited JSON
**Rationale:**  
The pipeline already runs as a CLI tool. Writing to `stdout` is the simplest transport; log lines can be redirected to files or consumed by other processes without additional configuration. Each log entry contains `timestamp`, `level`, `message`, `correlationId`, and optional `meta`.

### 5. Logger interface is minimal
**Rationale:**  
`createLogger(correlationId)` returns an object with `info`, `warn`, `error` methods (each accepting a message string and an optional metadata object). This avoids over‑engineering (no log levels, no transports) while still providing structured data.

### 6. No dependency on external logging libraries
**Rationale:**  
The codebase avoids unnecessary dependencies; a 30‑line utility is self‑contained and easy to audit.

---

## File‑Level Plan

### Create
- **`scripts/lib/audit/structured-logger.mjs`**  
  *Purpose:* Exports `createLogger(correlationId, opts?)` that returns a logger instance with `info`, `warn`, `error` methods. Each call formats `{ timestamp, level, correlationId, message, ...meta }` as JSON and writes it to `stdout` (or `opts.stream`).

### Modify
- **`scripts/cycle.mjs`**  
  *Purpose:* At the start of the main pipeline function, generate a correlation ID (`crypto.randomUUID()`), create a logger, and pass it (or the ID) to the first audit pass. Log `audit_start` and `audit_end` (with success/failure). Ensure the correlation ID is forwarded to every subsequent pass invocation.

- **`scripts/openai-audit.mjs`**  
  *Purpose:* Accept a `correlationId` (or a logger instance) as a new parameter. Use the module to obtain a logger and log `openai_audit_start`, `openai_audit_end`, and any caught errors.

- **`scripts/gemini-review.mjs`**  
  *Purpose:* Same pattern as `openai-audit.mjs` – accept correlation ID, log start/end/error.

- **Other `scripts/audit-*.mjs` files** (if invoked by the orchestrator)  
  *Purpose:* Apply the same pattern wherever these files participate in the multi‑pass pipeline. Each file will import the logger and add a logging call for its own stage.

> **Note:** The exact set of files to modify depends on the call graph of the orchestrator. The plan above includes the most prominent passes. The implementation will start by tracing `scripts/cycle.mjs` to identify all entry points.

---

## Risks

1. **Logger changes stdout contract** – Some tools may already expect `stdout` to contain only audit results. Adding JSON logs could break parsers. Mitigation: check existing `stdout` consumers; if necessary, log to `stderr` or a configurable stream. (We default to `stdout` but can expose a `stream` option.)
2. **Threading correlation ID through deeply nested helpers** – Some helper functions may not be called directly by the orchestrator. Mitigation: only add logging at the entry points of each pass; do not force every internal function to log unless it already reports errors. The plan is scoped to the pass boundaries.
3. **crypto.randomUUID() availability** – Node ≥15.6 required. The project likely uses modern Node. If not, fallback to a simple UUID generator.
4. **Performance** – JSON serialisation and `console.log` overhead is negligible for an audit pipeline that already runs LLM calls. No risk.

---

## Target Paths

- `scripts/lib/audit/structured-logger.mjs`
- `scripts/cycle.mjs`
- `scripts/openai-audit.mjs`
- `scripts/gemini-review.mjs`

---

## Section 9 — Acceptance Criteria

1. Running the full audit pipeline (e.g., `node scripts/cycle.mjs`) produces newline‑delimited JSON log lines on `stdout`.
2. Every log line contains the keys `timestamp` (ISO‑8601), `level` (one of `info`, `warn`, `error`), `message`, and `correlationId`.
3. All log lines from a single pipeline invocation share the same `correlationId` value.
4. Two consecutive pipeline invocations produce different `correlationId` values.
5. Each audit pass logs at least two events: a start event (e.g., `"openai_audit_start"`) and an end event (e.g., `"openai_audit_end"`), with the same correlation ID.
6. If a pass encounters an error, an `error`‑level log entry is emitted before the process exits, still carrying the correlation ID.
7. Existing pipeline behaviour (exit codes, file outputs, API calls, findings processing) is unchanged.
8. The new `structured-logger.mjs` module can be unit‑tested by providing a stream and asserting the JSON output.

### Arm OSS-GLM

- Models: `{"models":["z-ai/glm-5.2"],"resolved":"z-ai/glm-5.2"}`
- Conformant: true
- Output hash: `7ac5fe61d23640b3`

# Implementation Plan — Structured Logging with Correlation IDs for the Audit Pipeline

## Overview

The multi-pass audit pipeline (`scripts/cycle.mjs`, `scripts/openai-audit.mjs`, `scripts/gemini-review.mjs`, `scripts/audit-*.mjs`, and `scripts/lib/audit/**`) currently uses ad-hoc `console.log`/`console.error` calls with no way to correlate log lines across passes or sub-audits. This plan introduces a minimal structured logger backed by `AsyncLocalStorage` for correlation-ID propagation, living in the `shared-lib` domain (which `audit-orchestration` already depends on), and wires it into the audit entry points and library functions.

The solution is deliberately scoped: one new logging module, one new correlation module, and surgical edits to audit files to replace raw console calls and establish the correlation context at the pipeline entry point. No external dependencies; no new persistence; no changes to non-audit domains.

---

## Design Decisions

### 1. AsyncLocalStorage for correlation propagation (not argument threading)
**Rationale:** Threading a `correlationId` parameter through every function in the audit pipeline would require modifying dozens of internal signatures for no behavioural gain. `AsyncLocalStorage` (Node built-in, zero deps) lets any function deep in the call stack read the active correlation ID without signature changes. This is the standard Node.js pattern for request-scoped context.

**Failure mode:** If code escapes the async context (e.g., `setTimeout` without `await`, detached callbacks), `getCorrelationId()` returns `undefined`. The logger handles this gracefully by emitting `"correlation_id": "unknown"` rather than throwing.

### 2. JSON Lines to stderr (not stdout, not files)
**Rationale:** Several audit scripts write machine-readable results to stdout (JSON findings, markdown). Logging to stderr keeps that contract intact. JSON Lines (`{"ts":"...","level":"info","correlation_id":"...","pass":"openai","msg":"...",...}`) is greppable, pipeable to `jq`, and requires no log-shipping infrastructure. No file-based persistence is added — this respects `[REQ-persistence-6623d196]` / `[REQ-persistence-d8f9613d]` by not introducing new durable state.

### 3. Cross-process propagation via `AUDIT_CORRELATION_ID` env var
**Rationale:** `cycle.mjs` may spawn child scripts (`openai-audit.mjs`, `gemini-review.mjs`) as subprocesses. The orchestrator sets `AUDIT_CORRELATION_ID` in the child environment; the child's logger reads it on startup. This is simpler and more robust than parsing CLI flags in every script. If the env var is absent, a new ID is generated — so standalone execution still works.

### 4. Logger lives in `shared-lib`, not `audit-orchestration`
**Rationale:** The domain map permits `audit-orchestration → shared-lib`. Placing the logger in `scripts/lib/log/` (which matches the `scripts/lib/**` → `shared-lib` rule) keeps it reusable by other domains without violating layering. The audit-specific wiring stays in `audit-orchestration` files.

### 5. Pass name as an explicit structured field
**Rationale:** Correlation ID groups the whole run; `pass` field (e.g., `"openai"`, `"gemini"`, `"nav"`, `"visual"`) identifies which sub-audit produced the line. This is the minimum vocabulary needed to reconstruct multi-pass timelines without over-engineering a full tracing/span system.

### 6. No log-level configuration file or external config
**Rationale:** Level is controlled by `AUDIT_LOG_LEVEL` env var (default `info`). Adding a config file would be over-engineering for a CLI pipeline. The env var is read once at module load.

---

## File-Level Plan

### New files

| File | Create | Purpose |
|---|---|---|
| `scripts/lib/log/correlation.mjs` | Create | AsyncLocalStorage-based correlation context. Exports: `withCorrelation(id, fn)` — runs `fn` inside a context with the given ID; `getCorrelationId()` — returns active ID or reads `AUDIT_CORRELATION_ID` env var as fallback; `ensureCorrelationId()` — returns active ID, or generates one and wraps current execution if none exists (used by entry points). ID format: `audit_<base36-timestamp>_<random-4-chars>` for human-greppability without a UUID dependency. |
| `scripts/lib/log/structured-logger.mjs` | Create | Factory `createLogger({ pass, level })` returns an object with `debug/info/warn/error` methods. Each method serialises a JSON line to `stderr` with fields: `ts` (ISO 8601), `level`, `correlation_id` (from `getCorrelationId()`), `pass`, `msg`, and any extra key-values passed as a final object argument. Respects `AUDIT_LOG_LEVEL` env var. Re-uses nothing from existing code — deliberately standalone to avoid coupling. |
| `tests/log/correlation.test.mjs` | Create | Tests: `withCorrelation` sets/restores context; `getCorrelationId` returns `undefined` outside context; nested `withCorrelation` preserves outer ID; env-var fallback works when `AUDIT_CORRELATION_ID` is set and no context is active. |
| `tests/log/structured-logger.test.mjs` | Create | Tests: logger emits valid JSON to stderr; includes `correlation_id` from active context; respects level filtering; extra fields merge correctly; `pass` field is included; `correlation_id` is `"unknown"` when no context. Uses stderr capture via temporary `process.stderr.write` interception. |

### Modified files

| File | Modify | Purpose |
|---|---|---|
| `scripts/cycle.mjs` | Modify | At the top of `main()`: call `ensureCorrelationId()` to establish the run-scoped ID. When spawning child audit scripts, set `AUDIT_CORRELATION_ID` in `child_process` env. Replace existing `console.log`/`console.error` audit-progress calls with `logger.info(...)` / `logger.error(...)`. Create the logger via `createLogger({ pass: 'cycle' })`. |
| `scripts/openai-audit.mjs` | Modify | At entry: `ensureCorrelationId()` (reads env var if spawned by `cycle.mjs`, generates if standalone). Create `createLogger({ pass: 'openai' })`. Replace console calls with structured logger calls. |
| `scripts/gemini-review.mjs` | Modify | Same pattern as `openai-audit.mjs` with `pass: 'gemini'`. |
| `scripts/lib/audit/orchestrator.mjs` (or equivalent audit library file) | Modify | If the audit library has a central orchestration function, wrap each pass invocation in `withCorrelation(existingId, () => runPass(...))` so the ID propagates even if the pass uses detached async. Replace console calls with logger calls. *(If no single orchestrator file exists, this applies to whichever `scripts/lib/audit/**` file coordinates passes — the implementer should grep for `console.log` in that directory.)* |
| `scripts/audit-*.mjs` (each audit entry script) | Modify | Each gets `ensureCorrelationId()` at entry and a `createLogger({ pass: '<name>' })`. Replace console calls. The pass name is derived from the script basename (e.g., `audit-nav.mjs` → `pass: 'nav'`). |

### Files explicitly NOT modified
- `scripts/lib/findings*.mjs` — findings domain; logging here would couple findings to a new dependency. Findings return data; the caller logs.
- `scripts/lib/store/**`, `scripts/lib/debt-*.mjs`, `scripts/lib/plan-*.mjs` — out of scope; not part of the audit pipeline's multi-pass flow.
- Any persistence/store code — no new durable state is introduced.

---

## Risks

1. **AsyncLocalStorage context loss in detached callbacks.** If any audit code uses raw `setTimeout`/`setInterval` callbacks that aren't `await`ed, the correlation ID will be `undefined` in those callbacks. **Mitigation:** The logger emits `"unknown"` rather than throwing, so this degrades gracefully. The implementer should grep for un-awaited timers in `scripts/lib/audit/**` and wrap them in `withCorrelation` if found.

2. **Existing log output consumed by downstream tools.** If any existing script or CI pipeline parses the human-readable `console.log` output of audit scripts, switching to JSON Lines on stderr will break that parsing. **Mitigation:** All structured logs go to stderr; stdout output (findings JSON, markdown) is unchanged. A grep for `console.log` in audit scripts should confirm which output goes to stdout vs stderr today.

3. **`scripts/lib/audit/**` file inventory uncertainty.** The architecture map truncates the full symbol listing. The implementer must enumerate `scripts/lib/audit/` to find all files with `console.log` calls. **Mitigation:** `grep -rn 'console\.\(log\|error\|warn\)' scripts/lib/audit/ scripts/audit-*.mjs scripts/cycle.mjs scripts/openai-audit.mjs scripts/gemini-review.mjs` before starting edits.

4. **Child-process env propagation on Windows.** Setting env vars for `child_process.spawn` is cross-platform, but if any audit script is invoked via `exec` with shell interpolation, the env var may not propagate. **Mitigation:** Use `child_process.spawn`/`fork` with `env: { ...process.env, AUDIT_CORRELATION_ID }` rather than shell strings.

5. **Test fragility from stderr interception.** Capturing stderr in tests requires monkey-patching `process.stderr.write`. **Mitigation:** Tests use a contained before/after hook to save and restore the original `write`. Alternatively, the logger factory can accept a `sink` option (defaults to `process.stderr`) for test injection — this adds one parameter but dramatically improves testability and is worth the cost.

---

## Target Paths

- `scripts/lib/log/correlation.mjs` — create
- `scripts/lib/log/structured-logger.mjs` — create
- `tests/log/correlation.test.mjs` — create
- `tests/log/structured-logger.test.mjs` — create
- `scripts/cycle.mjs` — modify
- `scripts/openai-audit.mjs` — modify
- `scripts/gemini-review.mjs` — modify
- `scripts/lib/audit/orchestrator.mjs` — modify (or equivalent central audit-lib file as identified by grep)
- `scripts/audit-*.mjs` — modify (each audit entry script)

---

## Section 9 — Acceptance Criteria

1. Running `node scripts/cycle.mjs` produces JSON Lines on stderr where every line contains a `"correlation_id"` field with the same value across all passes in that single invocation.
2. Running any audit script standalone (e.g., `node scripts/openai-audit.mjs`) produces JSON Lines on stderr with a `"correlation_id"` field populated (not `"unknown"`).
3. When `cycle.mjs` spawns child audit scripts, the child's stderr log lines contain the same `"correlation_id"` as the parent's log lines.
4. Every JSON Line on stderr from audit scripts is valid JSON parseable by `JSON.parse` (verifiable by piping stderr through `jq .`).
5. The `"pass"` field is present on every log line and matches the script that emitted it (e.g., lines from `openai-audit.mjs` have `"pass":"openai"`).
6. Setting `AUDIT_LOG_LEVEL=debug` causes debug-level lines to appear on stderr; the default (`info`) suppresses them.
7. `stdout` output of audit scripts is byte-for-byte unchanged compared to before this change (findings JSON, markdown, etc.).
8. `node --test tests/log/correlation.test.mjs` and `node --test tests/log/structured-logger.test.mjs` pass with zero failures.
9. No new runtime dependencies are added to `package.json` (only Node.js built-ins: `async_hooks`, `crypto` for random ID generation).
10. A grep for `console.log` and `console.error` in `scripts/lib/audit/**`, `scripts/audit-*.mjs`, `scripts/cycle.mjs`, `scripts/openai-audit.mjs`, and `scripts/gemini-review.mjs` returns zero results (all replaced by structured logger calls).

## Judge scores (blinded at judge time; unblinded here post-ranking)

| Pass | Label | Arm | Scores |
|---|---|---|---|
| 1 | output-1 | GPT | `{"reuse":4,"clarity":4,"correctness":5,"completeness":5,"right_sizing":3,"risk_handling":5,"implementability":4,"repo_intent_fidelity":5,"architectural_coherence":5,"acceptance_criteria_quality":5}` |
| 1 | output-2 | OSS-DS | `{"reuse":2,"clarity":4,"correctness":3,"completeness":2,"right_sizing":4,"risk_handling":2,"implementability":3,"repo_intent_fidelity":2,"architectural_coherence":3,"acceptance_criteria_quality":3}` |
| 1 | output-3 | OSS-GLM | `{"reuse":3,"clarity":5,"correctness":4,"completeness":4,"right_sizing":4,"risk_handling":4,"implementability":4,"repo_intent_fidelity":5,"architectural_coherence":5,"acceptance_criteria_quality":5}` |
| 2 | output-1 | GPT | `{"reuse":4,"clarity":4,"correctness":5,"completeness":5,"right_sizing":3,"risk_handling":5,"implementability":4,"repo_intent_fidelity":5,"architectural_coherence":5,"acceptance_criteria_quality":5}` |
| 2 | output-2 | OSS-DS | `{"reuse":2,"clarity":4,"correctness":3,"completeness":2,"right_sizing":4,"risk_handling":2,"implementability":3,"repo_intent_fidelity":2,"architectural_coherence":3,"acceptance_criteria_quality":3}` |
| 2 | output-3 | OSS-GLM | `{"reuse":3,"clarity":5,"correctness":4,"completeness":4,"right_sizing":4,"risk_handling":4,"implementability":4,"repo_intent_fidelity":4,"architectural_coherence":4,"acceptance_criteria_quality":5}` |

## Human ranking (best → worst)

- output-1 > output-3 > output-2 — review-mode (2026-07-02T08:04:55.343Z)

