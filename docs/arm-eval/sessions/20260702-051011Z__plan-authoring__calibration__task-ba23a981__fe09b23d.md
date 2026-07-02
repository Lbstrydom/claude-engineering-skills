# Arm-eval session fe09b23d-42d7-4238-b28e-e6a18e8063fc

| Field | Value |
|---|---|
| Experiment | plan-authoring |
| Phase | calibration |
| Task id | `task-ba23a981` |
| Seed (presentation-order RNG) | 1 |
| Config / rubric version | 1 / 1 |
| Created (UTC) | 2026-07-02T05:10:11.200Z |
| Repo | 8548afbd-8d85-50de-baca-1bb158d696da |
| Archive mode | FULL (attribution + judgments) |

## Task

Add a --max-output-tokens flag to arm-eval-run that caps each arm's generation length and records the cap in the session config

## Arms + outputs

### Arm GPT

- Models: `{"models":["latest-gpt"],"resolved":"latest-gpt"}`
- Conformant: true
- Output hash: `ac53f5984ba8db8f`

# Implementation Plan: `--max-output-tokens` for `arm-eval-run`

## Overview

Add a `--max-output-tokens <n>` CLI flag to `arm-eval-run` so a caller can cap the generation length for every evaluated arm in a run. The cap must be:

1. Parsed and validated as a positive integer.
2. Passed into each arm’s generation call using the repository’s existing provider/options contract.
3. Persisted in the run/session config so the run is reproducible and auditable.
4. Omitted from provider calls and session config when not supplied, preserving current behavior.

The implementation should stay local to the existing `arm-eval-run` command and its tests, reusing the command’s current argument parsing, session creation, persistence, and arm execution flow.

## Target Paths

- `scripts/arm-eval-run.mjs`
- `tests/arm-eval-run.test.mjs`

## Design Decisions

### 1. Add one optional CLI flag, no new config system

**Decision:** Add `--max-output-tokens <positive-integer>` directly to the existing `arm-eval-run` argument parser.

**Rationale:** The task asks for a single command flag. Introducing a broader configuration layer or shared CLI parsing abstraction would be over-engineering unless the file already uses one.

**Behavior:**

- Accepted form: `--max-output-tokens 1024`
- Invalid forms:
  - Missing value
  - Non-numeric value
  - Decimal value
  - Zero or negative value
  - Non-finite value

Recommended validation contract:

```text
maxOutputTokens?: positive integer
```

If invalid, fail before starting a session or invoking any arm.

### 2. Use camelCase internally and in persisted config

**Decision:** Map the CLI flag to an internal/persisted field named `maxOutputTokens`.

**Rationale:** Existing JavaScript code likely uses camelCase for parsed options and config objects. The CLI remains kebab-case, while persisted JSON remains idiomatic and easy to consume.

Persisted session config should include:

```json
{
  "maxOutputTokens": 1024
}
```

Only include the property when the flag is supplied, unless the existing session config convention records optional unset values explicitly. Prefer matching existing persistence style.

### 3. Apply the cap uniformly to every arm generation

**Decision:** Pass the validated cap into the shared generation options for every arm invocation.

**Rationale:** The task says “caps each arm’s generation length,” so the cap must not be applied selectively or only to one provider/model path.

Implementation should identify the single point where each arm’s generation call is made. If arms are executed through a helper like:

```js
runArm(arm, prompt, options)
```

or provider calls are assembled in one object, add the cap there rather than duplicating logic per arm.

Expected shape, adapted to existing naming:

```js
{
  ...existingGenerationOptions,
  maxOutputTokens
}
```

If the provider adapter expects a different key, map only at the provider boundary while keeping `maxOutputTokens` as the command/session contract.

### 4. Preserve current behavior when flag is absent

**Decision:** Do not set a default token cap in this change.

**Rationale:** The requested feature is an optional cap. Adding a default could silently change evaluation behavior and invalidate comparisons with prior runs.

When the flag is absent:

- Existing generation calls should be unchanged.
- Existing session config should not gain a misleading default unless the current config format explicitly records undefined/default fields.

### 5. Fail early and safely

**Decision:** Validate immediately after parsing CLI args and before creating/writing session state.

**Rationale:** Prevents partially-created sessions for invalid CLI input and keeps persistence clean.

Failure mode should be a clear CLI error, consistent with the script’s existing style, for example:

```text
--max-output-tokens must be a positive integer
```

### 6. Test via command internals or subprocess according to existing patterns

**Decision:** Extend the existing test style for `arm-eval-run`.

**Rationale:** If the command is currently tested through exported parser/helpers, unit-test those. If it is tested as a CLI subprocess, add subprocess coverage. Avoid introducing a new test harness.

Tests should verify both:

- Data contract correctness: parsing/validation/persistence.
- Behavioral propagation: generation options for each arm include the cap.

## File-Level Plan

### `scripts/arm-eval-run.mjs` — Modify

Purpose: Add parsing, validation, propagation, and session config persistence for `--max-output-tokens`.

Planned changes:

1. Locate existing argument parsing.
2. Add support for:
   - `--max-output-tokens <n>`
3. Add/extend validation:
   - Value must exist.
   - Value must be base-10 integer text.
   - Parsed number must be a safe positive integer.
4. Store parsed value internally as `maxOutputTokens`.
5. Add `maxOutputTokens` to the session config object written for the run when supplied.
6. Pass `maxOutputTokens` into the options used for each arm generation.
7. Ensure undefined cap is not forwarded if the flag is absent, unless the existing provider contract already tolerates undefined options.
8. Ensure invalid values exit using the existing CLI error path and do not create/write a session.

Implementation notes:

- Prefer a small local helper only if parsing is currently inline and repeated validation would be messy, for example:
  - `parsePositiveIntegerFlag(value, flagName)`
- If the script already has a generic numeric parser, reuse it instead of adding another helper.
- Avoid changing unrelated arm selection, scoring, output, or persistence behavior.

### `tests/arm-eval-run.test.mjs` — Modify

Purpose: Add regression coverage for the new CLI flag.

Planned tests:

1. **Parses and persists the cap**
   - Run or invoke `arm-eval-run` with `--max-output-tokens 123`.
   - Assert the created session config contains `maxOutputTokens: 123`.

2. **Passes cap to every arm**
   - Use the existing mocked/stubbed generation path.
   - Configure at least two arms.
   - Assert each generation call receives the cap in its options.

3. **Preserves old behavior when omitted**
   - Run without the flag.
   - Assert generation options do not include a cap, or match the previous expected options.
   - Assert persisted session config does not include `maxOutputTokens`, unless existing config style records absent optional fields.

4. **Rejects invalid values**
   - Cover representative invalid values:
     - `0`
     - `-1`
     - `1.5`
     - `abc`
     - missing value
   - Assert command fails before generation starts.
   - Assert no session config is written, if the existing test harness can observe filesystem effects.

If the current repository has a differently named test file for this command, update that file instead, but keep the target path above as the expected concrete location for this change.

## Data and Contract Correctness

### CLI contract

```text
arm-eval-run ... --max-output-tokens <positive integer>
```

### Internal option contract

```js
{
  maxOutputTokens?: number
}
```

Constraints:

- Integer
- Positive
- Safe JavaScript integer
- No implicit default introduced by this change

### Session config contract

When supplied:

```json
{
  "maxOutputTokens": 123
}
```

When omitted:

```json
{}
```

or unchanged relative to the current session config format.

### Provider/generation contract

Every arm generation should receive the same cap. If the lower-level provider expects provider-specific naming, the mapping should happen at the existing provider boundary, not in multiple arm branches.

## Failure Modes

1. **Missing flag value**
   - Input: `--max-output-tokens`
   - Expected: CLI error, non-zero exit, no generation.

2. **Non-integer value**
   - Input: `--max-output-tokens 10.5`
   - Expected: CLI error, non-zero exit, no generation.

3. **Non-numeric value**
   - Input: `--max-output-tokens abc`
   - Expected: CLI error, non-zero exit, no generation.

4. **Zero or negative value**
   - Input: `--max-output-tokens 0`
   - Expected: CLI error, non-zero exit, no generation.

5. **Value too large for safe integer handling**
   - Input: greater than `Number.MAX_SAFE_INTEGER`
   - Expected: CLI error, non-zero exit, no generation.

6. **Provider rejects cap**
   - If a downstream provider has a lower max than requested, keep existing provider error handling.
   - Do not silently rewrite the user’s requested cap unless existing provider code already normalizes generation limits.

## Security and Persistence Safety

- Treat the flag as numeric data only; never interpolate it into shell commands.
- Validate before persistence to avoid recording malformed session configs.
- Preserve existing atomic write/session write behavior.
- Do not mutate shared/global generation config in a way that could leak the cap across later runs.
- Ensure test temp directories are isolated if session files are created during tests.

## Testability Notes

The preferred seam is the existing command execution/generation abstraction. If the script currently does not export parser helpers, avoid a broad refactor. Instead, test through the same CLI or module entrypoint currently used by existing tests.

Use mocks/fakes for generation calls to avoid real model/API calls. The test should inspect the options passed to the fake generation function for each arm.

## Risks

1. **Provider option naming mismatch**
   - Risk: Existing provider code may expect `maxTokens`, `max_output_tokens`, or another field.
   - Mitigation: Follow the current generation options contract in `arm-eval-run`; keep `maxOutputTokens` as the CLI/session field and map only where necessary.

2. **Session config shape uncertainty**
   - Risk: The session config may be nested or normalized before writing.
   - Mitigation: Add the cap at the same point other run-level CLI settings are recorded, not by post-processing the written file.

3. **Accidental behavior change**
   - Risk: Adding a default cap or forwarding `undefined` may change generation behavior.
   - Mitigation: Only include the option when supplied and add a regression test for omitted flag behavior.

4. **Partial session creation on invalid input**
   - Risk: Validation after session initialization could leave junk session files.
   - Mitigation: Validate immediately after arg parsing and before filesystem writes.

5. **Multi-arm execution path duplication**
   - Risk: Some arms may use a separate execution branch and miss the cap.
   - Mitigation: Identify all generation call sites in `arm-eval-run` and cover at least two-arm execution in tests.

## Section 9 — Acceptance Criteria

1. `arm-eval-run` accepts `--max-output-tokens <n>` where `<n>` is a positive safe integer.
2. When `--max-output-tokens 123` is supplied, each arm generation call receives a generation length cap of `123` using the existing provider/options contract.
3. When `--max-output-tokens 123` is supplied, the persisted session config records `"maxOutputTokens": 123`.
4. When `--max-output-tokens` is omitted, existing generation behavior is unchanged and no default cap is introduced.
5. Invalid values such as `0`, `-1`, `1.5`, `abc`, and a missing value cause a clear CLI failure before any arm generation begins.
6. Invalid `--max-output-tokens` input does not create or persist a session config.
7. Tests cover parsing/persistence, propagation to multiple arms, omitted-flag behavior, and invalid values.
8. The implementation does not introduce new external dependencies.
9. The change is limited to the `arm-eval-run` command and its tests, with no unrelated changes to scoring, arm selection, or session storage semantics.

### Arm OSS-DS

- Models: `{"models":["deepseek/deepseek-v4-pro"],"resolved":"deepseek/deepseek-v4-pro"}`
- Conformant: true
- Output hash: `bd057a9941059f46`

## Overview

Add an optional `--max-output-tokens <n>` flag to `arm-eval-run`.  
When supplied, the flag sets a per‑arm output token cap that is passed to the generation API call.  
The cap is also recorded in the persistent session configuration so that every run is self‑documenting and reproducible.

## Design decisions (with rationale)

1. **Argument parsing reuse** – Use the existing shared argument‑parsing utility (`parseArgs` from `scripts/lib/args.mjs`).  
   Reason: consistent CLI behaviour, no new dependency, validates numeric range automatically.

2. **No default cap** – If `--max-output-tokens` is omitted the API call behaves as before (no `max_tokens` parameter).  
   Reason: preserves backward compatibility; the user explicitly opts in.

3. **Pass as top‑level option** – The parsed integer is threaded through the arm‑execution pipeline.  
   Reason: each arm’s generation call needs the same limit; centralising avoids per‑arm duplication.

4. **Store in session config** – The cap is added as an optional field (`maxOutputTokens`) in the session configuration object that is serialised at the start of the run.  
   Reason: enables post‑run audits; the config file is the single source of truth for the run’s parameters.

5. **API contract alignment** – The generation function conditionally adds `max_tokens` to the request body only when the flag is set.  
   Reason: respects the underlying API (Claude / OpenAI‑compatible) which typically uses `max_tokens` for output length.

## File‑level plan

| File | Create / Modify | Purpose |
|------|-----------------|---------|
| `scripts/arm-eval-run.mjs` | Modify | Add `--max-output-tokens` option definition, parse it, inject into session config, and pass to the arm‑running routine. |
| `scripts/lib/arm-eval/run-arms.mjs` | Modify | Accept the cap as an argument and forward it to the generation call for each arm. |
| `scripts/lib/session/config.mjs` | Modify | Optional: if a schema or builder exists for session configuration, allow the new `maxOutputTokens` field. Otherwise the dynamic object already accepts it. |

### Detailed responsibilities

#### `scripts/arm-eval-run.mjs`
- Import `parseArgs` (and any validation helpers) from `scripts/lib/args.mjs`.
- Extend the options definition to include `--max-output-tokens` with type `'int'`, positive‑number constraint, and description.
- In the `main()` function, after parsing, extract `maxOutputTokens` (default `null`).
- Build or extend the session configuration object (e.g. `sessionConfig`) with `maxOutputTokens: opts.maxOutputTokens`.
- Call the arm‑execution function (likely `runArms()`) with the parsed cap.

#### `scripts/lib/arm-eval/run-arms.mjs`
- The function signature gains a `maxOutputTokens` parameter (default `null`).
- Inside the loop for each arm, when constructing the generation API request:
  - If `maxOutputTokens !== null`, add `max_tokens: maxOutputTokens` to the request body.
  - Otherwise omit the field entirely.

#### `scripts/lib/session/config.mjs` (if present)
- If a dedicated config builder or validator exists, add `maxOutputTokens` as an optional integer field (no required changes if config is built ad‑hoc in the runner).
- No persistence format changes needed; JSON serialisation of `null` vs omitted field is acceptable.

## Risks

- **API field name mismatch** – Some providers use `max_tokens` while others use `max_output_tokens`.  
  Mitigation: cross‑reference the existing API client code (likely in `scripts/lib/arm-eval/`) to use the exact field already employed for other generation parameters.
- **Session config schema rigidity** – If the config is validated against a fixed schema, a new field may break downstream consumers.  
  Mitigation: make the field optional; verify by inspecting any schema definition.
- **Negative or zero input** – A malformed flag could cause an API error.  
  Mitigation: argument parsing enforces positive‑integer via the existing validation framework; invalid values exit early with a clear message.
- **State threading** – If the arm‑execution path is deeply nested, forgetting to pass the cap could silently ignore it.  
  Mitigation: add a simple test (see acceptance criteria) that verifies the cap appears in the request body mock.

## Target Paths

- `scripts/arm-eval-run.mjs`
- `scripts/lib/arm-eval/run-arms.mjs`
- `scripts/lib/session/config.mjs` (only if a formal config builder exists; otherwise no modification needed)

## Section 9 — Acceptance Criteria

1. Running `node scripts/arm-eval-run.mjs --max-output-tokens 512` passes `max_tokens: 512` to each arm’s generation API call.  
2. Omitting the flag does **not** include `max_tokens` in the API request; the previous behaviour is unchanged.  
3. The session configuration file (e.g. `session-<id>.json`) contains the key `maxOutputTokens` with the value supplied on the CLI.  
4. Providing a non‑positive integer (e.g. `--max-output-tokens 0`) results in a clear error message and non‑zero exit code before any API call.  
5. The flag appears in the built‑in help output (`--help`).

### Arm OSS-GLM

- Models: `{"models":["z-ai/glm-5.2"],"resolved":"z-ai/glm-5.2"}`
- Conformant: true
- Output hash: `a0eabd44442fd373`

## Overview

Add a `--max-output-tokens` CLI flag to the `arm-eval-run` command that caps each arm's generation length at the provider-call boundary and persists the chosen cap into the session config record so downstream consumers (dashboard, replay, analysis) can see what limit was in effect.

The change is a vertical slice: argument parsing → session-config schema → provider call wiring → persistence → tests. No new domains or abstractions are introduced; existing arg-parsing and session-config helpers are reused.

---

## Design Decisions (with rationale)

1. **Flag type: positive integer, optional, default `null` (no cap).**
   Rationale: The absence of a cap must be distinguishable from `0`. Using `null` as the sentinel avoids ambiguity and aligns with JSON-serializable config records. A value of `0` or negative is rejected at parse time with an explicit error message.

2. **Cap enforced at the provider-call boundary, not post-hoc.**
   Rationale: Truncating after generation wastes tokens and produces incomplete outputs that skew eval metrics. The cap is passed as the `max_output_tokens` parameter (or equivalent) into the existing provider-call abstraction, so the model itself stops generating.

3. **Session config field: `maxOutputTokens` (camelCase, nullable).**
   Rationale: Matches the existing JSON naming convention in session config. Nullable so the field is always present in new sessions (schema-stable) but semantically "unset" when no flag was passed.

4. **Record the *effective* cap, not the raw CLI string.**
   Rationale: If a future layer (e.g., provider-specific max) clamps the user-requested value, the session config should reflect what was actually applied. For this iteration, effective == requested (no clamping logic), but the field name and comment leave room.

5. **No changes to existing flag behavior or output format.**
   Rationale: Right-sizing — the flag is additive. Existing invocations without `--max-output-tokens` produce identical behavior. Backward compatibility is preserved by defaulting to `null`.

6. **Validation co-located with arg parsing.**
   Rationale: Fail fast at the CLI boundary with a clear message rather than deep in a provider call. The parse function returns a typed error that the caller already knows how to surface.

---

## File-Level Plan

### `scripts/arm-eval-run.mjs` — MODIFY
- Add `--max-output-tokens` to the argument parser (the existing `parseArgs` or equivalent CLI definition in this file).
- Validate: must be a positive integer if provided; reject `0`, negatives, and non-numeric strings with an explicit error.
- Pass the resolved value (integer or `null`) into the session-config builder and into the arm-generation call site.

### `scripts/lib/arm-eval/session-config.mjs` (or the existing session-config module for arm-eval) — MODIFY
- Add `maxOutputTokens` to the session config object schema/default.
- Accept the value from the caller (the run orchestrator) and write it into the persisted config record.
- Ensure the field is always present in the output JSON (default `null`), so downstream readers get a stable schema.

### `scripts/lib/arm-eval/run-arm.mjs` (or the existing per-arm execution module) — MODIFY
- Accept `maxOutputTokens` in its options/input.
- When non-null, pass it as the `max_output_tokens` parameter to the provider-call abstraction used for generation.
- When `null`, omit the parameter (preserving current behavior).

### `scripts/lib/arm-eval/provider-call.mjs` (or the existing provider abstraction) — MODIFY (if needed)
- If the provider-call interface does not already accept a `max_output_tokens` / `maxOutputTokens` option, add it as an optional field in the call-options object and forward it to the underlying API request payload.
- If it already accepts such a parameter (check first — many provider SDKs do), this file may require no changes; the wiring happens in `run-arm.mjs`.

### `tests/arm-eval/max-output-tokens.test.mjs` — CREATE
- Test: flag omitted → session config has `maxOutputTokens: null`, generation call receives no cap.
- Test: flag provided with valid positive integer → session config has `maxOutputTokens: <value>`, generation call receives the cap.
- Test: flag provided with `0` → parse error, non-zero exit, clear message.
- Test: flag provided with negative or non-numeric → parse error.
- Test: flag provided with value exceeding provider max (if applicable) → effective value still recorded as requested (this iteration; clamping is a future concern, documented in code comment).

### `tests/arm-eval/session-config.test.mjs` — MODIFY (if it exists)
- Add assertion that `maxOutputTokens` is always present in the serialized session config, defaulting to `null`.

---

## Risks

1. **Provider doesn't support `max_output_tokens`.** Some provider endpoints may not accept this parameter or may name it differently. Mitigation: check the existing provider-call abstraction's option surface first; if it already has a token-limit parameter, reuse it. If not, add the field but guard the provider payload construction with a conditional so unsupported providers ignore it gracefully.

2. **Session config schema drift.** Adding a new field could break downstream consumers that validate against a strict schema. Mitigation: field is nullable and additive; verify no strict-schema validator rejects unknown keys. If a schema file exists (e.g., a JSON schema or Zod definition), update it in the same change.

3. **Test isolation.** The arm-eval run may require network calls or mock providers. Mitigation: tests should use the existing mock/stub infrastructure for provider calls; assert on the call-options object, not on real generation output.

4. **Existing arg parser limitations.** If the current parser is a hand-rolled switch/case rather than a structured parser, adding a new integer-typed optional flag requires careful handling. Mitigation: follow the exact pattern used by the most recently added integer flag in the same file.

---

## Target Paths

- `scripts/arm-eval-run.mjs` — modify
- `scripts/lib/arm-eval/session-config.mjs` — modify
- `scripts/lib/arm-eval/run-arm.mjs` — modify
- `scripts/lib/arm-eval/provider-call.mjs` — modify (conditional — only if no existing token-limit option)
- `tests/arm-eval/max-output-tokens.test.mjs` — create
- `tests/arm-eval/session-config.test.mjs` — modify (if it exists)

---

## Section 9 — Acceptance Criteria

1. Running `arm-eval-run` without `--max-output-tokens` produces identical behavior to the current version (no regression), and the persisted session config contains `"maxOutputTokens": null`.
2. Running `arm-eval-run --max-output-tokens 4096` causes each arm's generation call to receive a maximum output token limit of 4096.
3. The persisted session config for a run with `--max-output-tokens 4096` contains `"maxOutputTokens": 4096`.
4. Running `arm-eval-run --max-output-tokens 0` exits with a non-zero status and prints an error message indicating the value must be a positive integer.
5. Running `arm-eval-run --max-output-tokens -100` exits with a non-zero status and prints an error message indicating the value must be a positive integer.
6. Running `arm-eval-run --max-output-tokens abc` exits with a non-zero status and prints an error message indicating the value must be a positive integer.
7. The `maxOutputTokens` field is present in every newly created session config record regardless of whether the flag was passed.
8. All existing arm-eval tests pass without modification.
9. New tests in `tests/arm-eval/max-output-tokens.test.mjs` verify the cap is forwarded to the provider-call options object (via mock/stub) and the session config reflects the passed value.
10. No new cross-domain dependency violations are introduced (the change stays within the `scripts` / `shared-lib` domain boundary and does not import from disallowed domains).

