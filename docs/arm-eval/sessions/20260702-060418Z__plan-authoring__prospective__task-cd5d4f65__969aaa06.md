# Arm-eval session 969aaa06-cea7-4dd9-a5b7-61b19364e462

| Field | Value |
|---|---|
| Experiment | plan-authoring |
| Phase | prospective |
| Task id | `task-cd5d4f65` |
| Seed (presentation-order RNG) | 14 |
| Config / rubric version | 1 / 1 |
| Created (UTC) | 2026-07-02T06:04:18.103Z |
| Repo | 8548afbd-8d85-50de-baca-1bb158d696da |
| Archive mode | FULL (attribution + judgments) |

## Task

Add a CSV export subcommand to cross-skill for the arm-eval leaderboard

## Arms + outputs

### Arm GPT

- Models: `{"models":["latest-gpt"],"resolved":"gpt-5.5","backfillNote":"backfilled 2026-07-02: sentinel resolved against live catalog same-day as all runs"}`
- Conformant: true
- Output hash: `54d135bae5c3f409`

# Implementation Plan: CSV Export Subcommand for `cross-skill` arm-eval Leaderboard

## Overview

Add a CSV export path to the existing `scripts/cross-skill.mjs` CLI for the arm-eval leaderboard. The implementation should reuse the existing arm-eval leaderboard data-loading and ranking logic, adding only a small rendering/output layer for CSV.

The intended CLI shape should be a true subcommand, for example:

```bash
node scripts/cross-skill.mjs arm-eval leaderboard-csv
```

with optional file output:

```bash
node scripts/cross-skill.mjs arm-eval leaderboard-csv --out leaderboard.csv
```

Default behavior should write CSV to stdout, preserving script composability:

```bash
node scripts/cross-skill.mjs arm-eval leaderboard-csv > leaderboard.csv
```

The change should not alter leaderboard computation, persistence formats, or existing arm-eval commands.

## Design Decisions

### 1. Reuse existing leaderboard row computation

**Decision:** Reuse the current arm-eval leaderboard data source and ranking logic already present in `scripts/cross-skill.mjs`.

**Rationale:**
- Prevents CSV export from drifting from the existing leaderboard.
- Keeps the change small and tied to the current contract.
- Avoids introducing a second interpretation of score/rank/order semantics.

If the current leaderboard code mixes computation and rendering, minimally factor it into:
- a pure “build rows” function
- existing human-readable renderer
- new CSV renderer

### 2. Add a subcommand, not only a format flag

**Decision:** Add a dedicated subcommand such as:

```bash
arm-eval leaderboard-csv
```

**Rationale:**
- The task explicitly asks for a CSV export subcommand.
- Avoids changing the behavior of existing leaderboard commands.
- Keeps command discovery simple in help text.

If the existing command grammar already has an export namespace, align with it instead, for example:

```bash
arm-eval export-csv leaderboard
```

but do not introduce a large CLI parser refactor.

### 3. CSV is stdout-first, with optional safe file output

**Decision:** Write to stdout by default. Support `--out <path>` if the existing CLI already has output-file conventions or if this is straightforward to add locally.

**Rationale:**
- Stdout is the smallest useful export mechanism.
- It works naturally with shell redirection and CI artifacts.
- Optional `--out` improves usability without requiring callers to manage redirection.

For `--out`, use persistence-safe behavior:
- write to a temporary file in the target directory
- rename atomically where possible
- avoid partial destination files on failure
- fail clearly if the directory does not exist or is not writable

### 4. CSV escaping must be correct and spreadsheet-safe

**Decision:** Implement or reuse a small CSV cell encoder that:
- quotes fields containing comma, quote, CR, LF, or leading/trailing whitespace
- doubles embedded quotes
- emits a stable header row
- normalizes `null` / `undefined` to empty cells
- preserves numeric cells as plain numbers where safe

Additionally, protect text fields against spreadsheet formula injection by prefixing dangerous text values with `'` when they begin with one of:

```text
= + - @ tab carriage-return
```

**Rationale:**
- Leaderboard data may include skill/model names or identifiers from files or external systems.
- Correct CSV quoting alone does not prevent spreadsheet formula execution.
- The mitigation is small and appropriate for exported CSV.

### 5. Stable column contract

**Decision:** The CSV should expose a stable, documented column order. Prefer the existing leaderboard row shape. If the existing row shape is implicit, define an explicit column list in `scripts/cross-skill.mjs`.

Recommended columns, adjusted to the actual existing row fields:

```text
rank,skill,model,score,wins,losses,ties,total,last_updated
```

If the current arm-eval leaderboard uses different names, map to the existing canonical terms rather than inventing new metrics.

**Rationale:**
- CSV consumers depend on column order and names.
- Explicit columns prevent accidental changes when row objects gain extra properties.
- The export should match the human-readable leaderboard ordering and scoring.

### 6. No new dependency

**Decision:** Do not add a CSV package.

**Rationale:**
- CSV rendering needs are small and deterministic.
- Avoids dependency churn for a script-level feature.
- Easier to audit escaping and formula-safety behavior directly.

### 7. Test at the renderer and CLI behavior level

**Decision:** Add focused tests for:
- CSV escaping
- formula-injection mitigation
- column/header stability
- row ordering matching leaderboard ordering
- stdout/file-output behavior if `--out` is supported

**Rationale:**
- CSV bugs are usually contract bugs, not algorithm bugs.
- Testing the pure renderer makes edge cases easy.
- A CLI-level test verifies the subcommand is wired correctly.

## Target Paths

- `scripts/cross-skill.mjs`
- `tests/cross-skill-arm-eval-csv.test.mjs`

## File-Level Plan

### `scripts/cross-skill.mjs` — modify

Purpose: Add the arm-eval leaderboard CSV subcommand and CSV rendering support.

Planned changes:

1. **Locate existing arm-eval command dispatch**
   - Find the current `arm-eval` command handling in `main`, `parseArgs`, or equivalent dispatch logic.
   - Add recognition for the new subcommand:
     - preferred: `arm-eval leaderboard-csv`
     - or align with existing CLI naming if there is already an export pattern.

2. **Reuse or factor leaderboard row generation**
   - Identify the existing arm-eval leaderboard code path.
   - If the existing renderer directly computes and prints rows, extract the row-building portion into a small pure helper.
   - Existing human-readable leaderboard output should call the same helper after refactoring.
   - CSV output should call the same helper.

3. **Add explicit CSV column definition**
   - Define a local constant for column order, for example:

     ```js
     const ARM_EVAL_LEADERBOARD_CSV_COLUMNS = [...]
     ```

   - Columns should map directly to existing leaderboard row fields.
   - Do not serialize arbitrary object keys.

4. **Add CSV rendering helpers**
   - Add small pure helpers in the same file unless there is already a shared CSV helper:
     - `sanitizeCsvCellForSpreadsheet(value)`
     - `escapeCsvCell(value)`
     - `renderCsv(rows, columns)`
     - optionally `renderArmEvalLeaderboardCsv(rows)`

   - Behavior:
     - `null` / `undefined` become empty string
     - quotes are doubled
     - fields requiring quotes are quoted
     - dangerous spreadsheet-leading characters on text cells are prefixed with `'`
     - output ends with a single trailing newline

5. **Add output handling**
   - Default: print CSV to stdout.
   - If supporting `--out`:
     - parse `--out <path>` using current argument parsing style
     - write atomically to the provided path
     - do not mutate leaderboard source data
     - print either nothing or a concise success message to stderr, depending on existing CLI convention
   - Ensure stdout contains only CSV when no `--out` is used.

6. **Update help/usage text**
   - Include the new subcommand in any existing usage block.
   - Include `--out <path>` only if implemented.

7. **Failure modes**
   - Unknown subcommand should continue to produce existing invalid-command behavior.
   - Missing `--out` value should fail with a non-zero exit code and clear message.
   - File write failure should fail non-zero without corrupting an existing destination file.
   - Empty leaderboard should still emit only the CSV header row.

---

### `tests/cross-skill-arm-eval-csv.test.mjs` — create

Purpose: Verify the new CSV export contract without depending on external services.

Planned tests:

1. **Header and stable column order**
   - Use a minimal fixture or pure renderer invocation.
   - Assert the first line exactly matches expected CSV headers.

2. **Leaderboard row order**
   - Provide fixture rows or fixture arm-eval data with known scores.
   - Assert exported CSV row order matches the existing leaderboard order/rank order.

3. **CSV escaping**
   - Include values with:
     - comma
     - double quote
     - newline
     - leading/trailing whitespace
   - Assert RFC-style escaping:
     - embedded quotes doubled
     - quoted fields where required

4. **Spreadsheet formula mitigation**
   - Include a skill/model/name value beginning with `=`, `+`, `-`, `@`, or tab.
   - Assert the exported cell is prefixed with `'`.

5. **Empty leaderboard**
   - Assert CSV output contains the header row and a final newline.

6. **CLI wiring**
   - Spawn the script with the new subcommand against a temporary fixture store if existing tests already do this.
   - Assert:
     - exit code is `0`
     - stdout begins with the expected header
     - stderr does not contain an error

7. **Optional `--out` behavior**
   - If `--out` is implemented:
     - run command with a temp output path
     - assert stdout is empty or matches existing convention
     - assert file content equals expected CSV
     - assert missing `--out` value exits non-zero

Prefer using existing test helpers and temporary-directory patterns already present in the repository.

## Risks

1. **Unclear existing arm-eval row contract**
   - Risk: The current leaderboard may not expose a clean row object.
   - Mitigation: Factor only the smallest necessary pure helper from existing code, preserving existing output behavior.

2. **CSV columns may not match stakeholder expectations**
   - Risk: Consumers may expect specific column names for the arm-eval leaderboard.
   - Mitigation: Base columns on the existing leaderboard metrics and keep the order explicit. If project docs mention leaderboard fields, mirror those names.

3. **Formula-safety may surprise consumers**
   - Risk: A model or skill name beginning with `-` may be prefixed with `'` in CSV.
   - Mitigation: This is appropriate for spreadsheet-targeted CSV exports. Apply mitigation only to text cells, not numeric metric cells.

4. **File output could introduce persistence bugs**
   - Risk: Partial files on failed writes.
   - Mitigation: Use stdout by default and atomic temp-file rename for `--out`.

5. **Monolithic script testability**
   - Risk: `scripts/cross-skill.mjs` may not currently export helpers.
   - Mitigation: Prefer CLI-level tests if helper exports are inconsistent with repository style. If helpers are exported, keep them side-effect-free and avoid changing runtime behavior.

## Section 9 — Acceptance Criteria

1. `node scripts/cross-skill.mjs arm-eval leaderboard-csv` exits with code `0` for a valid existing arm-eval leaderboard data set.

2. The CSV export writes valid CSV to stdout by default and writes no non-CSV informational text to stdout.

3. The first CSV row is a stable header row with explicit arm-eval leaderboard columns.

4. CSV data rows use the same ranking/order and metric values as the existing arm-eval leaderboard command.

5. An empty arm-eval leaderboard exports the header row plus a trailing newline, without crashing.

6. CSV fields containing commas, double quotes, CR/LF, or leading/trailing whitespace are correctly quoted, and embedded quotes are doubled.

7. Text CSV fields beginning with spreadsheet-dangerous prefixes `=`, `+`, `-`, `@`, tab, or carriage return are neutralized before export.

8. Existing `cross-skill` commands, including the existing arm-eval leaderboard command, continue to behave as before.

9. If `--out <path>` is implemented, the command writes the CSV to the requested file, avoids partial destination files on write failure, and reports invalid/missing output paths with a non-zero exit code.

10. Automated tests cover CSV header order, escaping, formula mitigation, empty leaderboard behavior, and CLI dispatch for the new subcommand.

### Arm OSS-DS

- Models: `{"models":["deepseek/deepseek-v4-pro"],"resolved":"deepseek/deepseek-v4-pro"}`
- Conformant: true
- Output hash: `f4c4b67abee64b60`

## Plan — Add CSV Export Subcommand to `cross-skill` for Arm‑Eval Leaderboard

### Overview
Add a `csv` subcommand to `scripts/cross-skill.mjs` that exports the arm‑eval leaderboard as a CSV file.  
The export re‑uses the existing leaderboard data retrieval already available to the cross‑skill bridge (e.g., from the learning‑store domain), formats rows with proper escaping, and writes the file using the atomic‑write utility from shared‑lib to meet persistence safety requirements.  
No new production files are created; the change is localised to `scripts/cross-skill.mjs`.

### Design Decisions (with rationale)

1. **Subcommand, not standalone script**  
   Logically belongs to the cross‑skill evaluation tool; avoids fragmentation and follows the existing CLI pattern where subcommands like `eval`, `compare`, etc. are already dispatched inside `cross-skill.mjs`.

2. **CSV format chosen over JSON/TSV**  
   CSV is the most universally consumable format for external analysis (spreadsheets, BI tools). The leaderboard is tabular, so CSV fits naturally.

3. **No external CSV library**  
   The repository avoids heavy dependencies for simple output tasks. A small helper that escapes commas, quotes, and line breaks is sufficient and keeps the dependency footprint zero.

4. **Output file via `--output` flag; safe default**  
   The user may specify `--output path/to/out.csv`. If omitted, a timestamped file (e.g. `arm-eval-leaderboard-20260701T120000.csv`) is written to the current working directory.  
   This respects user intent while preventing accidental overwrite (unless `--force` is given) and avoids writing to arbitrary system paths through path‑traversal checks.

5. **Atomic write**  
   Uses `atomicWrite` from shared‑lib (already available per the symbol index) to write the file fully or not at all, satisfying `REQ-persistence-6623d196`.

6. **Data source**  
   Assumes the leaderboard is obtainable from the learning‑store domain through a function like `getArmEvalLeaderboard()` already in use by other cross‑skill subcommands. If such a function does not yet exist, a thin adapter that reads the raw eval records and ranks them will be created **inside** `cross-skill.mjs` (not in shared‑lib) to keep the export logic self‑contained. The plan does **not** add new database queries or change the storage schema.

7. **Single leaderboard, single file**  
   Only the arm‑eval leaderboard is exported. Multi‑leaderboard support is left for a future enhancement. This keeps the scope right‑sized: the smallest solution that truly solves the problem.

### File‑level Plan

**Modify** `scripts/cross-skill.mjs`  
- Add a new function `csvExport(args)` that:
  1. Parses `--output` and `--force` from `args`.
  2. Validates the output path (resolved absolute path must stay inside the working directory or a safe user‑specified location; reject paths containing `..` sequences that escape the expected root).
  3. Fetches the leaderboard data (via the existing `getArmEvalLeaderboard()` or similar).
  4. Builds a CSV string: first row header (columns: rank, model, version, score, … – derived from the actual leaderboard schema), then one row per entry with proper CSV escaping (commas, double‑quotes, newlines).
  5. Writes the string to the target path using `atomicWrite` (imported from `scripts/lib/shared-lib/fs-utils.mjs` or equivalent).
  6. Prints success message to stderr with the file path.
- Register the subcommand in the already‑existing dispatch table (e.g., `subcommands.csv = csvExport`).
- Export `csvExport` for testability (the file already exports several functions).

No new files are created – the entire feature lives in a single, testable function within the existing domain boundary.

### Risks
- **Missing leaderboard function** – if a dedicated aggregation function does not exist, the implementation will compute the leaderboard on‑the‑fly. This may require an extra data load but is deterministic and testable.
- **Large leaderboard** – arm‑eval likely contains a moderate number of entries; CSV generation is O(n) and well within Node’s capabilities. If the leaderboard grows very large, streaming could be introduced later.
- **CSV injection** – if any field originates from user‑supplied data, the escaping rules (RFC 4180) prevent formula injection in spreadsheet applications. The plan includes prefixing fields that start with `=`, `+`, `-`, `@` with a tab character (or single quote) as an extra safeguard.
- **File permission errors** – handled gracefully by printing a clear error message and returning a non‑zero exit code.
- **Path traversal** – rejected by the path validation step, preventing writes outside the intended directory.

## Target Paths
- `scripts/cross-skill.mjs` — modify to add `csvExport` function, register subcommand, and export the function.

## Section 9 — Acceptance Criteria
1. Running `node scripts/cross-skill.mjs csv` without `--output` creates a CSV file named `arm-eval-leaderboard-<timestamp>.csv` in the current working directory.
2. The generated CSV contains a header row and one row per leaderboard entry, with columns matching the arm‑eval leaderboard schema (exact columns to be confirmed during implementation, but at minimum: rank, model name, primary metric).
3. Fields containing commas, double‑quotes, or newline characters are correctly escaped according to RFC 4180.
4. Running with `--output path/to/file.csv` writes the CSV to the specified path; the path is validated to prevent directory traversal (e.g., `../outside.csv` is rejected with an error message and non‑zero exit code).
5. If the output file already exists, the command fails with a distinct error message unless `--force` is supplied.
6. The write operation is atomic: no partial or truncated CSV files are left on disk if the process crashes mid‑write.
7. When the leaderboard data is unavailable (e.g., empty or broken store), the command exits with an appropriate error message and non‑zero status – it never outputs a file with only a header.
8. The subcommand can be tested in isolation: the exported `csvExport` function accepts a mock `args` object and returns a promise that resolves when the file is written (or rejects on error), allowing unit tests without touching the real filesystem.
9. Existing subcommands (`eval`, `compare`, …) continue to work without any change in behaviour (regression test via existing integration tests).

### Arm OSS-GLM

- Models: `{"models":["z-ai/glm-5.2"],"resolved":"z-ai/glm-5.2"}`
- Conformant: true
- Output hash: `ee1681faebe7e09d`

# Plan: CSV Export Subcommand for arm-eval Leaderboard

## Overview

Add a `export-csv` subcommand to `scripts/cross-skill.mjs` that reads the arm-eval leaderboard data (JSON) and emits a well-formed CSV to stdout or an output file. The feature reuses existing leaderboard-collection logic and shared-lib persistence utilities (atomic writes) rather than introducing new infrastructure. CSV generation follows RFC 4180 quoting rules. The implementation is scoped to a single new helper module plus a thin subcommand registration in the existing CLI dispatcher, keeping the change surface small.

## Design Decisions

1. **Subcommand shape: `cross-skill export-csv [--output <path>] [--limit <n>]`**
   - Rationale: `cross-skill.mjs` already dispatches subcommands (it's the cross-skill-bridge entrypoint). Adding a new verb is the idiomatic extension point. `--output` defaults to stdout, avoiding a new persistent artifact unless the user opts in. `--limit` reuses any existing top-N leaderboard concept without changing storage.

2. **Extract CSV logic into a dedicated helper: `scripts/lib/cross-skill/export-csv.mjs`**
   - Rationale: `scripts/lib/cross-skill/**` falls under the `cross-skill-bridge` domain (via the `scripts/lib/**` → shared-lib fallback rule, but the cross-skill entrypoint already pulls from its own lib subtree). Keeping the serializer pure and separable makes it unit-testable without spawning a process. This is the smallest decomposition that is a true function of the problem — one pure serializer + one CLI wiring point.

3. **RFC 4180 CSV quoting**
   - Fields containing comma, double-quote, CR, or LF are wrapped in double-quotes; embedded double-quotes are doubled. This is the minimum correct behavior — no partial escaping, no custom delimiter.
   - Rationale: Rejecting both a naive `join(',')` (band-aid, corrupts on any field with a comma) and a full CSV library dependency (over-engineered for a fixed-schema export).

4. **Reuse existing leaderboard data source**
   - The serializer accepts a plain array of leaderboard row objects (already produced by existing collection logic in cross-skill or learning-store). No new store schema, no new query path. The CLI layer calls the existing reader and passes rows to the serializer.
   - Rationale: Right-sizing — the problem is "emit existing data as CSV," not "redesign the leaderboard."

5. **Output safety: atomic write + path validation**
   - When `--output` is specified, use the shared-lib atomic-write utility (already used by drift.mjs and others) to prevent partial files on crash. Validate the output path does not resolve outside the repo root if a repo-root guard exists in shared-lib; otherwise, reject paths containing `..` segments.
   - Rationale: Honors REQ-persistence-6623d196 / REQ-persistence-d8f9613d (atomic writes) and REQ-security-b0b533cc (path safety).

6. **Schema is fixed and explicit**
   - The CSV columns are determined by the leaderboard row contract (skill name, score, rank, eval date, etc.). The serializer takes an explicit `columns` array so the contract is visible in code, not inferred by reflection.
   - Rationale: Prevents silent schema drift if the JSON store adds fields; the export is a stable contract for downstream consumers.

7. **Error handling: explicit failure modes**
   - No leaderboard data found → exit code 1, stderr message "No leaderboard data available."
   - Store file unreadable/corrupt JSON → exit code 2, stderr message with the parse error.
   - Output path invalid/unsafe → exit code 3, stderr message.
   - Empty result set (valid but zero rows) → exit code 0, CSV header only on stdout. This is a correct empty export, not an error.

## File-Level Plan

| File | Action | Purpose |
|---|---|---|
| `scripts/lib/cross-skill/export-csv.mjs` | **Create** | Pure serializer: `rowsToCsv(rows, columns)` → string. RFC 4180 quoting. `escapeField(value)` helper. No I/O — fully unit-testable. |
| `scripts/cross-skill.mjs` | **Modify** | Register `export-csv` subcommand in the existing dispatcher. Parse `--output`, `--limit` flags. Call existing leaderboard reader (reuse current symbol). Pipe rows through `rowsToCsv`. Write to stdout or atomic-write to file. Handle all explicit exit codes. |
| `tests/unit/cross-skill/export-csv.test.mjs` | **Create** | Unit tests for `rowsToCsv`: basic fields, embedded commas/quotes/newlines, empty rows (header only), null/undefined values, numeric formatting, column ordering. |
| `tests/integration/cross-skill-export-csv.test.mjs` | **Create** | Integration test: invoke `cross-skill export-csv` via child process against a fixture leaderboard store. Assert exit code 0, parseable CSV output, correct row count. Test `--output` writes a file atomically. Test missing-data exit code 1. |

## Target Paths

- `scripts/lib/cross-skill/export-csv.mjs`
- `scripts/cross-skill.mjs`
- `tests/unit/cross-skill/export-csv.test.mjs`
- `tests/integration/cross-skill-export-csv.test.mjs`

## Risks

- **Leaderboard data shape unknown from map alone**: The exact field names and nesting of the arm-eval leaderboard JSON are not fully visible in the architecture map. The plan mitigates by making `columns` an explicit parameter, so the CLI wiring (which has access to the real reader) defines the schema. If the reader returns a different shape than expected, only the CLI layer needs adjustment, not the serializer.
- **Domain boundary ambiguity for `scripts/lib/cross-skill/`**: The domain rules map `scripts/lib/**` to `shared-lib` by default, but the cross-skill-bridge domain is anchored on `scripts/cross-skill.mjs`. Placing the helper under `scripts/lib/cross-skill/` may be tagged as `shared-lib` by the domain-tagger. If the team considers this a violation, the helper can move to `scripts/lib/cross-skill-bridge/` or be inlined. This should be confirmed before implementation; it does not change the design, only the path.
- **Atomic-write dependency**: The plan assumes a shared-lib atomic-write utility exists (drift.mjs uses one). If that utility is private to arch-memory and not exported from shared-lib, a thin local atomic-write helper must be added — a minor scope increase but still right-sized.
- **Large leaderboard sets**: If the leaderboard can have thousands of rows, streaming would matter. Given this is an eval leaderboard (likely tens to low hundreds of rows), a single in-memory string is the correct right-sized choice. If scale grows, the serializer's design (array in → string out) can be refactored to a generator without changing the CLI contract.

## Section 9 — Acceptance Criteria

1. Running `node scripts/cross-skill.mjs export-csv` with valid leaderboard data prints RFC 4180-compliant CSV to stdout with exit code 0.
2. Running `node scripts/cross-skill.mjs export-csv --output results.csv` writes the CSV to the specified file atomically (no partial file on simulated crash) and exits 0.
3. Fields containing commas, double-quotes, or newlines are correctly quoted and escaped per RFC 4180 (verified by parsing the output with a standard CSV parser in tests).
4. When no leaderboard data exists, the command exits with code 1 and writes a clear error message to stderr.
5. When the leaderboard store file contains corrupt JSON, the command exits with code 2 and reports the parse error on stderr.
6. When `--output` points to a path with `..` traversal or resolves outside the repo, the command exits with code 3 and refuses to write.
7. An empty but valid leaderboard (zero rows) produces a CSV with only the header line and exits 0.
8. `--limit N` truncates output to the top N rows (respecting existing sort order) and is validated as a non-negative integer.
9. `rowsToCsv` is a pure function with no I/O side effects, covered by unit tests including edge cases (null values, Unicode, empty strings).
10. No new third-party dependencies are introduced; all CSV logic is implemented in-repo.

## Judge scores (blinded at judge time; unblinded here post-ranking)

| Pass | Label | Arm | Scores |
|---|---|---|---|
| 1 | output-1 | OSS-DS | `{"reuse":3,"clarity":4,"correctness":3,"completeness":3,"right_sizing":4,"risk_handling":3,"implementability":3,"repo_intent_fidelity":3,"architectural_coherence":3,"acceptance_criteria_quality":3}` |
| 1 | output-2 | GPT | `{"reuse":4,"clarity":4,"correctness":4,"completeness":4,"right_sizing":4,"risk_handling":4,"implementability":4,"repo_intent_fidelity":4,"architectural_coherence":4,"acceptance_criteria_quality":4}` |
| 1 | output-3 | OSS-GLM | `{"reuse":4,"clarity":5,"correctness":4,"completeness":5,"right_sizing":5,"risk_handling":4,"implementability":4,"repo_intent_fidelity":5,"architectural_coherence":4,"acceptance_criteria_quality":5}` |
| 2 | output-1 | OSS-DS | `{"reuse":3,"clarity":4,"correctness":3,"completeness":3,"right_sizing":4,"risk_handling":3,"implementability":3,"repo_intent_fidelity":3,"architectural_coherence":3,"acceptance_criteria_quality":4}` |
| 2 | output-2 | GPT | `{"reuse":4,"clarity":4,"correctness":4,"completeness":4,"right_sizing":4,"risk_handling":4,"implementability":4,"repo_intent_fidelity":4,"architectural_coherence":4,"acceptance_criteria_quality":4}` |
| 2 | output-3 | OSS-GLM | `{"reuse":4,"clarity":5,"correctness":4,"completeness":5,"right_sizing":4,"risk_handling":4,"implementability":4,"repo_intent_fidelity":4,"architectural_coherence":4,"acceptance_criteria_quality":5}` |

## Human ranking (best → worst)

- output-3 > output-2 > output-1 — review-mode (2026-07-02T08:04:53.440Z)

