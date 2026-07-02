# Arm-eval session fe5f9759-6956-4e4f-b6f5-96857bb3aa54

| Field | Value |
|---|---|
| Experiment | plan-authoring |
| Phase | prospective |
| Task id | `task-e73f4e94` |
| Seed (presentation-order RNG) | 17 |
| Config / rubric version | 1 / 1 |
| Created (UTC) | 2026-07-02T06:15:33.518Z |
| Repo | 8548afbd-8d85-50de-baca-1bb158d696da |
| Archive mode | FULL (attribution + judgments) |

## Task

Implement a --since date filter on the adjudication ledger reader

## Arms + outputs

### Arm GPT

- Models: `{"models":["latest-gpt"],"resolved":"gpt-5.5","backfillNote":"backfilled 2026-07-02: sentinel resolved against live catalog same-day as all runs"}`
- Conformant: true
- Output hash: `46a28a61b0531d4e`

## Overview

Implement an inclusive `--since` date filter for the adjudication ledger reader so callers can restrict displayed/read ledger entries to those whose ledger timestamp is on or after the supplied date.

The change should be reader-only: no ledger format migration, no writes, and no change to adjudication persistence semantics. The implementation should reuse the existing argument parsing, ledger entry parsing, and timestamp/date validation conventions already present in the audit/adjudication code.

## Target Paths

- `scripts/lib/audit/adjudication-ledger.mjs`
- `scripts/audit-adjudication-ledger.mjs`
- `tests/adjudication-ledger.test.mjs`

## Design Decisions

### 1. Filter at the ledger reader boundary

Add the `since` filtering capability to the ledger reader function rather than duplicating filtering in each caller.

**Rationale:**

- Keeps the contract centralized.
- Ensures all current and future readers get consistent behavior.
- Avoids CLI-only filtering that could diverge from programmatic usage.
- Keeps persistence safe because the reader remains a pure read/filter operation.

### 2. Use an inclusive comparison

Entries should pass when:

```text
entryTimestamp >= sinceTimestamp
```

**Rationale:**

- `--since` conventionally means “from this point onward.”
- Inclusive behavior avoids accidentally dropping entries exactly at midnight or exactly at a supplied timestamp.
- Easier to test and document.

### 3. Accept ISO-like date inputs, reject invalid dates

Support:

- `YYYY-MM-DD`
- Full ISO timestamps such as `2026-07-01T12:34:56Z`

For a plain `YYYY-MM-DD`, normalize to the start of that date in UTC:

```text
YYYY-MM-DDT00:00:00.000Z
```

Invalid values should fail fast with a clear CLI error.

**Rationale:**

- Avoids local timezone ambiguity.
- Maintains deterministic behavior across developer machines and CI.
- Keeps the interface small and predictable.

### 4. Do not silently include entries with malformed timestamps when `--since` is supplied

When filtering is enabled, entries without a parseable ledger timestamp should be excluded from filtered results, and existing warning/error behavior should be preserved if the reader already reports malformed records.

**Rationale:**

- A malformed timestamp cannot be safely compared.
- Including malformed records would violate the filter contract.
- Excluding them is safer for a reader/reporting command than throwing on historical bad data, unless the existing reader is already strict.

### 5. Preserve existing default behavior

When `--since` is omitted, output and return values must remain unchanged.

**Rationale:**

- Avoids breaking existing scripts, dashboards, or tests.
- Keeps the change narrowly scoped to the new option.

## File-Level Plan

### `scripts/lib/audit/adjudication-ledger.mjs` — modify

Purpose: central ledger reading/parsing logic.

Planned changes:

1. Locate the existing adjudication ledger read function, likely responsible for:
   - locating the ledger file,
   - reading JSONL or structured ledger data,
   - parsing entries,
   - returning/displaying entries.

2. Extend the reader options object with an optional `since` or `sinceDate` field.

   Example contract shape:

   ```js
   readAdjudicationLedger({
     ledgerPath,
     since,
     ...
   })
   ```

3. Add a small internal date normalization helper if no existing shared helper exists.

   Desired behavior:

   - `undefined`, `null`, or empty value means no filter.
   - `YYYY-MM-DD` becomes `Date.parse(`${value}T00:00:00.000Z`)`.
   - Full ISO timestamp values are parsed as-is.
   - Invalid values produce a structured error or throw consistent with existing reader error handling.

4. Identify the canonical timestamp field on adjudication ledger entries.

   Use the existing ledger schema rather than introducing a new field. Likely candidates to confirm in the file/tests:

   - `timestamp`
   - `createdAt`
   - `ts`
   - `adjudicatedAt`

5. Apply the filter after successful record parsing and before sorting/rendering/returning.

   Required behavior:

   ```text
   if no since filter:
     return existing entries unchanged

   if since filter:
     return only entries whose timestamp is valid and >= normalized since timestamp
   ```

6. Ensure the filter does not mutate parsed ledger entries.

7. If the reader exposes metadata/counts, make sure counts are internally consistent:
   - total entries read remains total if already reported,
   - returned/displayed entries reflect the filtered set,
   - add a filtered count only if the reader already has a reporting pattern for filters.

### `scripts/audit-adjudication-ledger.mjs` — modify

Purpose: CLI entry point for the adjudication ledger reader.

Planned changes:

1. Extend existing CLI argument parsing to recognize:

   ```text
   --since <date>
   ```

2. Add help text for the new option.

   Suggested wording:

   ```text
   --since <date>   Show adjudication ledger entries on or after date. Accepts YYYY-MM-DD or ISO timestamp.
   ```

3. Validate that `--since` has a value.

   Failure modes:

   - `--since` without a following value exits non-zero.
   - invalid date exits non-zero with a clear message.
   - unknown options should continue to behave as they do today.

4. Pass the parsed/validated `since` value into the ledger reader options.

5. Do not perform a second independent filter in the CLI unless the existing architecture already keeps filters in the CLI layer. Prefer central filtering in `scripts/lib/audit/adjudication-ledger.mjs`.

### `tests/adjudication-ledger.test.mjs` — modify

Purpose: test reader and CLI behavior for the new filter.

Planned tests:

1. Reader returns all entries when `since` is omitted.

2. Reader includes entries exactly at the cutoff timestamp.

3. Reader excludes entries before the cutoff timestamp.

4. Reader supports plain date input.

   Example:

   ```text
   --since 2026-07-01
   ```

   should include entries at:

   ```text
   2026-07-01T00:00:00.000Z
   2026-07-01T12:00:00.000Z
   ```

   and exclude:

   ```text
   2026-06-30T23:59:59.999Z
   ```

5. Reader supports full ISO timestamp input.

6. Invalid `since` value is rejected.

7. CLI passes `--since` through to the reader and output excludes older entries.

8. Existing tests for unfiltered ledger reading continue to pass without expectation changes, except where adding explicit assertions improves clarity.

## Implementation Notes

### Date normalization helper

Use a narrowly scoped helper in the ledger module unless there is already a shared date helper in `scripts/lib/**`.

Suggested helper behavior:

```text
normalizeSinceDate(value):
  if value is undefined/null/empty:
    return null

  if value matches /^\d{4}-\d{2}-\d{2}$/:
    parse `${value}T00:00:00.000Z`

  otherwise:
    parse value with Date.parse

  if result is not finite:
    fail with clear invalid-date error

  return epoch milliseconds
```

Avoid accepting fuzzy natural language dates such as `yesterday` because `Date.parse` behavior for non-ISO values can vary by runtime.

If strictness is desired, reject non-ISO strings explicitly instead of relying on broad `Date.parse`.

### Entry timestamp comparison

The implementation should avoid string comparisons unless the ledger guarantees canonical ISO timestamps. Prefer converting both the cutoff and entry timestamp to epoch milliseconds before comparing.

Pseudo-contract:

```text
entryTime = parseEntryTimestamp(entry)
if sinceMs !== null:
  include only if Number.isFinite(entryTime) && entryTime >= sinceMs
```

### Error handling

Match existing CLI conventions. If the repository uses custom helpers for argument errors or process exit codes, reuse them.

Expected user-facing examples:

```text
Invalid --since date: not-a-date
```

or:

```text
--since requires a date value
```

## Risks

1. **Unknown canonical timestamp field**

   The ledger may have more than one timestamp-like field. The implementation must use the field already treated as the ledger entry date by existing reader/output logic.

2. **Timezone ambiguity**

   Plain dates must be normalized to UTC midnight to avoid local timezone differences in CI and developer environments.

3. **Malformed historical entries**

   Some historical ledger entries may lack timestamps. Filtering should not crash unless the existing reader is already strict about malformed records.

4. **Argument parser coupling**

   If `scripts/audit-adjudication-ledger.mjs` uses a shared parser, adding `--since` should follow that parser’s conventions rather than introducing ad-hoc parsing.

5. **Snapshot/output tests**

   Existing tests may assert exact CLI help or output. Update only the necessary expectations and avoid unrelated formatting changes.

## Section 9 — Acceptance Criteria

1. Running the adjudication ledger reader without `--since` produces the same entries as before the change.

2. Running the reader with `--since YYYY-MM-DD` returns/displays only entries with ledger timestamps on or after `YYYY-MM-DDT00:00:00.000Z`.

3. Running the reader with `--since <ISO timestamp>` returns/displays only entries with ledger timestamps greater than or equal to that exact timestamp.

4. An entry whose timestamp exactly equals the `--since` cutoff is included.

5. Entries before the cutoff are excluded.

6. Invalid `--since` values are rejected with a clear error and a non-zero CLI exit.

7. Supplying `--since` without a value is rejected with a clear error and a non-zero CLI exit.

8. The implementation does not modify, rewrite, migrate, or append to the adjudication ledger file.

9. Unit tests cover unfiltered behavior, plain-date filtering, ISO timestamp filtering, inclusive cutoff behavior, and invalid date handling.

10. The new implementation follows the existing audit/adjudication module boundaries and does not introduce new cross-domain dependencies.

### Arm OSS-DS

- Models: `{"models":["deepseek/deepseek-v4-pro"],"resolved":"deepseek/deepseek-v4-pro"}`
- Conformant: true
- Output hash: `22e3fd9aaa54124c`

## Plan — `--since` date filter for the adjudication ledger reader

### Overview

Add a `--since` CLI option to the adjudication ledger reader (`scripts/adjudication-ledger.mjs`) so users can list only those adjudication records whose `adjudicatedAt` timestamp is on or after a given ISO‑8601 date. The change is a straightforward extension of the existing argument‑parsing and record‑filtering pipeline. Existing ledger records are stored as JSONL with an `adjudicatedAt` field (ISO‑8601 string). The filter respects the current `--summary` / `--full` output modes, failures are surfaced via non‑zero exit + stderr, and the default behaviour (no `--since`) remains unchanged.

### Design decisions

1. **Reject a general‑purpose query language** – the ask is a single date filter. A full query DSL or multiple filter flags are out of scope.
2. **Use ISO‑8601 date‑only strings for the CLI flag** – parse with `new Date(…)`. This matches the existing `adjudicatedAt` format in the ledger, requires zero schema changes, and gives clear error messages for bad input.
3. **Inclusive `>=` comparison** – “since” is interprets as “on or after”. This is the common expectation; the acceptance criteria make it unambiguous.
4. **Filter lives in a plain pure function** – a `filterSince(records, sinceDate)` function in the same module. It is trivially unit‑testable and the module already has a similar pipeline for `--summary`.
5. **No changes to the ledger store** – the filter is applied at read time only. No index or database migration is required.
6. **Stderr on bad input, exit code 1** – consistent with the existing argument‑error handling in the script.

### File-level plan

**Create**

- None.

**Modify**

| File | Purpose |
|---|---|
| `scripts/adjudication-ledger.mjs` | Add `--since` argument to the argument parser, define a `filterSince` helper, apply the filter before any output, and add a usage note. |
| `tests/unit/adjudication-ledger.test.mjs` | Add test cases: valid `--since` includes/excludes correctly, invalid date rejects with error, missing `--since` is a no‑op, `--since` works with both `--summary` and `--full`. |

### Risk assessment

- **Date parsing edge cases** – `new Date(sinceArg).getTime()` returns `NaN` for invalid strings. The `isNaN` check covers this.
- **Ledger record timestamp format** – the `adjudicatedAt` field is already an ISO‑8601 string (`2025-05-12T14:30:00.000Z`). Comparing `Date` objects constructed from both strings is safe.
- **Performance** – linear scan of the ledger on every invocation. For the current ledger size (hundreds of entries) this is fine. If the ledger grows into the tens of thousands, an index or binary‑search on a pre‑sorted file could be added later without changing the public API.
- **No architectural drift** – the change stays entirely within the `audit-orchestration` domain and `shared-lib` pattern for argument parsing; no new domain dependencies are introduced.

---

## Target Paths

- `scripts/adjudication-ledger.mjs`
- `tests/unit/adjudication-ledger.test.mjs`

---

## Section 9 — Acceptance Criteria

1. Calling `scripts/adjudication-ledger.mjs --since 2025-06-01` outputs only records with `adjudicatedAt` on or after `2025-06-01T00:00:00.000Z`.
2. Calling the script with `--since` and an invalid date (e.g. `--since not-a-date`) exits with status 1 and an error message on stderr.
3. Calling the script without `--since` outputs all records (unchanged behaviour).
4. The `--since` filter works correctly in combination with both `--summary` and `--full` output modes.
5. Records with `adjudicatedAt` exactly equal to the `--since` value are included in the output.
6. At least one automated unit test covers each of the above behaviours.

### Arm OSS-GLM

- Models: `{"models":["z-ai/glm-5.2"],"resolved":"z-ai/glm-5.2"}`
- Conformant: true
- Output hash: `a0d5d5b0707aadb6`

# Implementation Plan: `--since` Date Filter on Adjudication Ledger Reader

## Overview

Add a `--since <date>` CLI flag to the adjudication ledger reader so users can restrict outputto ledger entries on or after a given date. The change touches three layers: CLI argument parsing, the ledger reader's query/filter logic, and tests. The design reuses existing arg-parsing and ledger-reading symbols, adds a single pure-function filter, and wires the flag through without introducing new abstractions.

---

## Design Decisions

### 1. Filter at the reader layer, not the CLI layer
The `--since` flag is parsed in the CLI entry point but the actual filtering happens inside the ledger reader function. This keeps the CLI thin (consistent with the thin-delegate invariant) and makes the filter unit-testable without spawning a process.

### 2. Inclusive semantics (`>=`)
`--since 2025-01-15` includes entries timestamped on 2025-01-15 itself. This is the least-surprising behavior for "show me everything since this date" and matches common CLI tool conventions (`git log --since`, `journalctl --since`).

### 3. Date-only granularity for the flag, timestamp-aware comparison internally
The `--since` flag accepts `YYYY-MM-DD` (and optionally `YYYY-MM-DDTHH:mm:ssZ` for power users). Internally, we normalize to a UTC millisecond epoch and compare against the entry's timestamp field. A date-only input is normalized to `00:00:00.000Z` of that day, which naturally produces inclusive `>=` semantics.

### 4. Reject invalid dates with a clear non-zero exit
Invalid `--since` values (unparseable, future dates beyond a reasonable guard, wrong format) cause the CLI to print a diagnostic to stderr and exit with code 2 (distinguishing from code 1 for runtime errors and code 0 for success). This follows the existing error-exit convention seen in other `scripts/*.mjs` entry points.

### 5. No persistence or schema changes
The ledger format is read-only for this feature. We do not add indexes, modify the JSONL schema, or write anything. The filter is a pure read-time predicate. This is the smallest solution that is a true function of the problem.

### 6. Reuse existing date utilities
If a date-parsing helper already exists in `shared-lib` (e.g., a `parseDate` or similar), reuse it. If not, use a minimal inline parse via `Date` constructor + format validation regex rather than adding a dependency or a new shared utility for a single call-site.

---

## File-Level Plan

### `scripts/lib/findings-ledger.mjs` — Modify
**Purpose:** Contains `readLedger` (or equivalent) that returns adjudication entries. Add an optional `since` parameter to the reader function. When provided, entries whose timestamp field falls before the `since` epoch are excluded from the returned array. The filter is applied after entries are loaded and parsed, before return. Add a small internal helper `parseSinceDate(raw)` that validates the input and returns an epoch-ms number or throws a typed error. Export this helper so tests can exercise it directly.

### `scripts/audit-findings.mjs` (or the actual adjudication-ledger CLI entry point) — Modify
**Purpose:** The CLI entry point that calls the ledger reader. Extend `parseArgs` to recognize `--since <value>`. Pass the parsed value (or `null`) into the reader call. On parse failure from `parseSinceDate`, print a usage error to stderr and `process.exit(2)`. Update `--help` text to document the new flag.

### `tests/test-findings-ledger-since.mjs` — Create
**Purpose:** Unit tests for the `since` filter. Cases: (a) no `since` returns all entries (backward compatibility), (b) `since` excludes earlier entries, (c) `since` includes entries exactly on the boundary date (inclusive), (d) `since` accepts both `YYYY-MM-DD` and ISO datetime, (e) invalid date string throws with a clear error, (f) empty ledger with `since` returns empty array without error. Uses a small in-memory fixture array rather than file I/O.

### `tests/test-audit-findings-cli-since.mjs` — Create
**Purpose:** Integration test that spawns the CLI with `--since` and asserts the filtered output. Covers: valid date produces filtered output and exit 0; invalid date produces stderr message and exit 2; absent flag produces unfiltered output (backward compatibility).

---

## Target Paths

- `scripts/lib/findings-ledger.mjs`
- `scripts/audit-findings.mjs`
- `tests/test-findings-ledger-since.mjs`
- `tests/test-audit-findings-cli-since.mjs`

---

## Risks

1. **Wrong file identified:** The architecture map is truncated and the exact path of the "adjudication ledger reader" is inferred. If the reader lives under `scripts/lib/audit/` instead of `scripts/lib/findings-ledger.mjs`, the plan's file targets need adjustment. Mitigation: a grep for "adjudication" or "ledger" across `scripts/` confirms the exact module before implementation.

2. **Timestamp field name assumption:** The plan assumes entries have a `timestamp` (or `date`/`createdAt`) field. If the field is named differently, the filter predicate must be adjusted. Mitigation: inspect one sample ledger entry before writing the filter.

3. **Timezone ambiguity:** A date-only `--since 2025-01-15` normalized to UTC midnight may surprise users in other zones whose entries are stamped in local time. Mitigation: document that comparison is UTC-based in `--help`; accept full ISO timestamps for users who need zone control.

4. **Large ledger performance:** Filtering is O(n) over all entries on every invocation. For current ledger sizes this is fine. If the ledger grows to hundreds of thousands of entries, a sorted-index or binary-search optimization may be warranted later — but that is out of scope for this change (premature optimization).

5. **Backward compatibility:** Adding an optional parameter to the reader function must not break existing callers that omit it. The parameter defaults to `null`/`undefined` and the filter is skipped when absent.

---

## Section 9 — Acceptance Criteria

1. Running the adjudication ledger reader CLI with `--since 2025-01-15` outputs only entries whose timestamp is on or after 2025-01-15T00:00:00.000Z.
2. Running the CLI without `--since` produces identical output to the pre-change behavior (no regression).
3. The `--since` flag accepts both `YYYY-MM-DD` and full ISO 8601 datetime strings; both produce correct filtered results.
4. Passing an unparseable or malformed `--since` value causes the CLI to print a human-readable error to stderr and exit with code 2.
5. The boundary date is inclusive: an entry timestamped exactly at `2025-01-15T00:00:00.000Z` is included when `--since 2025-01-15` is used.
6. The ledger reader function, when called programmatically with `since = null` or `undefined`, returns all entries without filtering.
7. Unit tests cover: no-filter backward compatibility, exclusion of earlier entries, inclusive boundary, both date formats, invalid input rejection, and empty-ledger-with-since.
8. Integration tests cover: CLI valid `--since` (exit 0, filtered output), CLI invalid `--since` (exit 2, stderr message), and CLI without `--since` (exit 0, unfiltered output).
9. No changes are made to the ledger file format, schema, or any persisted data.
10. The `--help` output of the CLI documents the `--since` flag, its accepted formats, and its inclusive semantics.

## Judge scores (blinded at judge time; unblinded here post-ranking)

| Pass | Label | Arm | Scores |
|---|---|---|---|
| 1 | output-1 | OSS-GLM | `{"reuse":4,"clarity":5,"correctness":4,"completeness":5,"right_sizing":4,"risk_handling":5,"implementability":4,"repo_intent_fidelity":4,"architectural_coherence":4,"acceptance_criteria_quality":5}` |
| 1 | output-2 | GPT | `{"reuse":4,"clarity":4,"correctness":4,"completeness":5,"right_sizing":3,"risk_handling":5,"implementability":4,"repo_intent_fidelity":4,"architectural_coherence":4,"acceptance_criteria_quality":5}` |
| 1 | output-3 | OSS-DS | `{"reuse":3,"clarity":4,"correctness":3,"completeness":3,"right_sizing":4,"risk_handling":3,"implementability":3,"repo_intent_fidelity":3,"architectural_coherence":3,"acceptance_criteria_quality":3}` |
| 2 | output-1 | OSS-GLM | `{"reuse":4,"clarity":5,"correctness":4,"completeness":4,"right_sizing":4,"risk_handling":5,"implementability":4,"repo_intent_fidelity":4,"architectural_coherence":4,"acceptance_criteria_quality":5}` |
| 2 | output-2 | GPT | `{"reuse":4,"clarity":4,"correctness":4,"completeness":5,"right_sizing":4,"risk_handling":4,"implementability":4,"repo_intent_fidelity":4,"architectural_coherence":4,"acceptance_criteria_quality":5}` |
| 2 | output-3 | OSS-DS | `{"reuse":3,"clarity":4,"correctness":3,"completeness":3,"right_sizing":4,"risk_handling":3,"implementability":3,"repo_intent_fidelity":3,"architectural_coherence":3,"acceptance_criteria_quality":3}` |

## Human ranking (best → worst)

- output-1 > output-2 > output-3 — review-mode (2026-07-02T08:04:54.864Z)

