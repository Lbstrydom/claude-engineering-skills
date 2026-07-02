# Arm-eval session 07af0f8b-4c1b-409c-b8c3-42d3ee7063a1

| Field | Value |
|---|---|
| Experiment | plan-authoring |
| Phase | calibration |
| Task id | `task-3ba84e08` |
| Seed (presentation-order RNG) | 2 |
| Config / rubric version | 1 / 1 |
| Created (UTC) | 2026-07-02T05:25:43.147Z |
| Repo | 8548afbd-8d85-50de-baca-1bb158d696da |
| Archive mode | FULL (attribution + judgments) |

## Task

Add pagination to the audit findings list endpoint with a stable cursor and a max page size

## Arms + outputs

### Arm GPT

- Models: `{"models":["latest-gpt"],"resolved":"latest-gpt"}`
- Conformant: true
- Output hash: `686a586041a3a24b`

# Implementation Plan — Paginated Audit Findings List Endpoint

## Overview

Add cursor-based pagination to the audit findings list endpoint, enforcing a maximum page size and returning a stable `nextCursor` for subsequent pages. The implementation should avoid offset pagination, preserve deterministic ordering, validate all pagination inputs, and keep pagination logic close to the findings/listing layer so the endpoint remains thin.

The endpoint will support:

```http
GET /.../audit/findings?limit=50&cursor=<opaque-cursor>
```

Response shape should extend the existing response contract with pagination metadata, preferably without renaming the existing findings collection field:

```json
{
  "findings": [],
  "pageInfo": {
    "limit": 50,
    "hasMore": true,
    "nextCursor": "..."
  }
}
```

If the current endpoint uses a different collection key, keep that key and add `pageInfo`.

## Target Paths

- `scripts/lib/findings.mjs`
- `scripts/lib/findings-pagination.mjs`
- `scripts/lib/dashboard/api.mjs`
- `tests/findings-pagination.test.mjs`
- `tests/dashboard-audit-findings-api.test.mjs`

## Design Decisions

### 1. Use keyset/cursor pagination, not offset pagination

**Decision:** Use a stable cursor derived from the final item in the current page.

**Rationale:**

- Offset pagination becomes unstable when new findings are inserted or existing findings are removed between requests.
- Keyset pagination avoids page drift and scales better for persistent stores.
- The cursor can remain stateless and does not require server-side session storage.

### 2. Define one canonical deterministic sort order

**Decision:** The list endpoint should sort findings by:

1. primary immutable timestamp descending, e.g. `createdAt`, `created_at`, or the existing persisted audit finding timestamp;
2. stable unique identifier descending, e.g. `id`, `findingId`, or the existing canonical finding hash.

Conceptually:

```sql
ORDER BY created_at DESC, id DESC
```

For the next page:

```sql
WHERE created_at < :cursorCreatedAt
   OR (created_at = :cursorCreatedAt AND id < :cursorId)
```

**Rationale:**

- Timestamp alone is not stable because multiple findings may share the same timestamp.
- ID alone may not reflect existing list semantics.
- The timestamp + ID tuple guarantees deterministic pagination without duplicates or skipped records.

If the current list endpoint already has an established documented sort order, preserve it and add the unique ID as the final tie-breaker.

### 3. Enforce a maximum page size at the API boundary

**Decision:** Introduce explicit constants:

```js
DEFAULT_FINDINGS_PAGE_SIZE = 50
MAX_FINDINGS_PAGE_SIZE = 100
```

Validation rules:

- missing `limit` → default to `50`;
- `limit` must be an integer;
- `limit < 1` → `400`;
- `limit > MAX_FINDINGS_PAGE_SIZE` → `400`;
- successful responses must never return more than `MAX_FINDINGS_PAGE_SIZE`.

**Rationale:**

- Rejecting over-limit requests gives clients a clear contract.
- A hard cap protects memory, response size, and backing-store query cost.
- Keeping the default smaller than the max gives room for explicit larger page requests.

### 4. Cursor format should be opaque, versioned, and validated

**Decision:** Encode the cursor as base64url JSON:

```json
{
  "v": 1,
  "sort": "created_at_desc_id_desc",
  "createdAt": "2026-07-02T10:30:00.000Z",
  "id": "finding_123",
  "filtersHash": "..."
}
```

The public cursor value is base64url-encoded. The endpoint treats it as opaque.

**Rationale:**

- Versioning allows future cursor migration.
- Including the sort name prevents accidentally reusing an old cursor after sort behavior changes.
- Including a filter hash prevents using a cursor from one filtered result set against another.
- No server-side persistence is required.

Do not treat the cursor as authorization. Always re-apply authorization, tenant scope, repository scope, and filters independently on each request.

### 5. Fetch `limit + 1` records to determine `hasMore`

**Decision:** Query or collect one additional item beyond the requested limit.

- If `rows.length > limit`, set `hasMore: true`.
- Return only the first `limit` rows.
- Generate `nextCursor` from the final returned row.
- If there are no additional rows, return `hasMore: false` and `nextCursor: null`.

**Rationale:**

- Avoids a separate count query.
- Works for database-backed and file-backed implementations.
- Keeps response time predictable.

### 6. Keep endpoint changes thin

**Decision:** Put pagination parsing, cursor encode/decode, comparator logic, and result slicing into `scripts/lib/findings-pagination.mjs`.

The route handler should only:

1. parse query params through the helper;
2. pass the pagination object to the existing findings listing function;
3. serialize the existing findings payload plus `pageInfo`.

**Rationale:**

- Keeps route logic testable.
- Avoids duplicating pagination semantics in multiple endpoints.
- Keeps the change within existing findings/dashboard boundaries.

### 7. Preserve existing filters and scopes

**Decision:** Existing query filters, authorization filters, repository filters, severity filters, status filters, etc. must remain part of the query before pagination is applied.

Pagination order of operations:

1. authenticate/authorize;
2. parse and validate filters;
3. parse and validate pagination;
4. apply scope + filters;
5. apply canonical sort;
6. apply cursor boundary;
7. fetch `limit + 1`;
8. return page and metadata.

**Rationale:**

- Prevents cursor misuse across scopes.
- Maintains data correctness.
- Avoids leaking whether findings exist outside the caller’s scope.

## File-Level Plan

### `scripts/lib/findings-pagination.mjs` — create

Purpose: Centralize reusable pagination behavior for audit findings.

Add exports for:

- `DEFAULT_FINDINGS_PAGE_SIZE`
- `MAX_FINDINGS_PAGE_SIZE`
- `FINDINGS_CURSOR_VERSION`
- `FINDINGS_CURSOR_SORT`
- `parseFindingsPaginationParams(query)`
- `encodeFindingsCursor({ createdAt, id, filtersHash })`
- `decodeFindingsCursor(cursor)`
- `buildFindingsFiltersHash(filters)`
- `compareFindingForCursor(finding, cursor)` or equivalent keyset predicate helper
- `paginateSortedFindings(findings, pagination)` if the current backing store is in-memory/file-backed

Validation behavior:

- invalid base64 → typed `400`-style error;
- invalid JSON → typed `400`-style error;
- unsupported cursor version → typed `400`-style error;
- cursor missing required fields → typed `400`-style error;
- cursor sort mismatch → typed `400`-style error;
- cursor filter hash mismatch → typed `400`-style error.

Implementation notes:

- Use `Buffer.from(value, 'base64url')` if the project’s supported Node version allows it; otherwise use the repository’s existing base64url helper if present.
- Do not use `eval`, dynamic imports, or unsafe parsing.
- Normalize timestamps to ISO-8601 strings before encoding.
- Treat IDs as strings.

### `scripts/lib/findings.mjs` — modify

Purpose: Extend the existing findings list/read function to support keyset pagination.

Expected changes:

- Locate the existing function used by the audit findings list endpoint.
- Add an optional pagination parameter, for example:

```js
listAuditFindings({ filters, pagination })
```

or preserve the existing signature and add an options object only if compatible.

- Ensure findings are sorted by the canonical order before applying the cursor.
- Apply the cursor boundary using timestamp + ID.
- Fetch or compute `limit + 1`.
- Return both records and page metadata, for example:

```js
{
  findings,
  pageInfo: {
    limit,
    hasMore,
    nextCursor
  }
}
```

For database-backed storage:

- implement tuple/keyset filtering at query level;
- use parameterized query values only;
- request `limit + 1`.

For file-backed/in-memory storage:

- load the existing scoped findings;
- sort deterministically;
- apply cursor comparison;
- slice to `limit + 1`.

Do not change finding persistence format unless absolutely required. If some existing findings lack a stable timestamp or ID, derive the missing tie-breaker using the repository’s existing canonical finding hash, not array index.

### `scripts/lib/dashboard/api.mjs` — modify

Purpose: Wire the endpoint query params to the findings listing layer and serialize pagination metadata.

Expected changes:

- Locate the current audit findings list route handler.
- Read `limit` and `cursor` from query parameters.
- Pass all existing filters plus pagination to the findings listing function.
- Preserve the existing response collection key.
- Add `pageInfo`.
- Map pagination validation errors to `400 Bad Request`.
- Preserve existing behavior for non-pagination failures.

Example response metadata:

```json
{
  "pageInfo": {
    "limit": 50,
    "hasMore": true,
    "nextCursor": "eyJ2Ijox..."
  }
}
```

Error response should match the project’s existing API error shape. If there is no standardized shape, use a minimal stable response:

```json
{
  "error": "invalid_cursor",
  "message": "Cursor is malformed or incompatible with this request."
}
```

### `tests/findings-pagination.test.mjs` — create

Purpose: Unit coverage for cursor and pagination helper behavior.

Test cases:

- default page size is applied when `limit` is omitted;
- `limit=1` is accepted;
- `limit=MAX_FINDINGS_PAGE_SIZE` is accepted;
- `limit=0` is rejected;
- negative limit is rejected;
- non-integer limit is rejected;
- over-max limit is rejected;
- cursor round-trips through encode/decode;
- malformed base64 cursor is rejected;
- malformed JSON cursor is rejected;
- unsupported cursor version is rejected;
- sort mismatch is rejected;
- filter hash mismatch is rejected;
- duplicate timestamps are paginated without duplication because ID is used as tie-breaker;
- `nextCursor` is generated from the last returned item only when `hasMore` is true.

### `tests/dashboard-audit-findings-api.test.mjs` — create or modify

Purpose: Integration/API-level coverage for the audit findings list endpoint.

Test cases:

- endpoint returns no more than default page size when no `limit` is provided;
- endpoint returns requested number of findings for valid `limit`;
- endpoint returns `400` for `limit > MAX_FINDINGS_PAGE_SIZE`;
- first page response includes `pageInfo.limit`, `pageInfo.hasMore`, and `pageInfo.nextCursor`;
- second page using `nextCursor` returns the next records with no overlap;
- all records across sequential pages match the canonical sorted full result;
- invalid cursor returns `400`;
- cursor generated for one filter set is rejected when used with a different filter set;
- inserting a newer finding between page 1 and page 2 does not duplicate or skip records from the original traversal.

## Data and Contract Correctness

- The cursor must represent the last visible record in the previous page, not an array offset.
- The endpoint must re-apply all existing filters before applying the cursor.
- The cursor must be bound to the active filter set using a deterministic filter hash.
- Sorting must be deterministic across process restarts.
- If the endpoint currently allows arbitrary client-controlled sorting, either:
  - include the sort in the cursor and validate it; or
  - restrict pagination initially to the default canonical sort and reject cursor usage with unsupported sort values.
- The response must never include more findings than the requested validated `limit`.
- The response must never include more findings than `MAX_FINDINGS_PAGE_SIZE`.

## Failure Modes

Explicitly handle these cases:

| Failure | Expected behavior |
|---|---|
| `limit` missing | Use default page size |
| `limit` is not an integer | `400 Bad Request` |
| `limit < 1` | `400 Bad Request` |
| `limit > MAX_FINDINGS_PAGE_SIZE` | `400 Bad Request` |
| `cursor` is malformed | `400 Bad Request` |
| `cursor` has unsupported version | `400 Bad Request` |
| `cursor` sort does not match current endpoint sort | `400 Bad Request` |
| `cursor` filter hash does not match current filters | `400 Bad Request` |
| Cursor points to deleted/nonexistent finding | Return the next records after the cursor key if possible; do not require the exact row to exist |
| No records after cursor | Return empty findings array, `hasMore: false`, `nextCursor: null` |

## Security and Persistence Safety

- Do not trust cursor contents for authorization.
- Do not place secrets in the cursor.
- Do not include internal filesystem paths or sensitive audit metadata in the cursor.
- Use parameterized queries if persistence is database-backed.
- Avoid offset-based queries for large datasets.
- Avoid full collection scans if an indexed persistent store is already used.
- Do not introduce server-side cursor persistence.
- Do not mutate findings while paginating.
- Do not log full cursor payloads at info level; log only error class or truncated cursor if needed.

## Testing Strategy

Run the existing relevant test suite plus the new pagination tests.

Recommended commands should follow the repository’s existing test runner. If tests are Node-based, likely candidates are:

```bash
npm test
```

or targeted test execution for the new files if supported.

Also manually verify the endpoint with:

```bash
curl ".../audit/findings?limit=2"
curl ".../audit/findings?limit=2&cursor=<nextCursor>"
curl ".../audit/findings?limit=101"
curl ".../audit/findings?cursor=not-a-valid-cursor"
```

## Risks

1. **Unknown existing response shape**  
   If the endpoint currently returns a bare array, adding `pageInfo` requires a response shape change. Prefer preserving the existing collection key if one already exists. If it is a bare array, document the breaking change or introduce the object response under the versioning convention already used by the API.

2. **Missing stable timestamp or ID**  
   Some legacy findings may lack a timestamp or unique ID. Use existing canonical finding identifiers/hashes as the tie-breaker. Avoid array index because it is not stable.

3. **Filter hashing mismatch**  
   Filters must be normalized before hashing. For example, unordered query params should hash consistently.

4. **Sort order drift**  
   If future code changes the endpoint sort without updating `FINDINGS_CURSOR_SORT`, existing cursors may behave incorrectly. The explicit sort marker should be updated whenever sort semantics change.

5. **Large file-backed datasets**  
   If findings are currently loaded from files, keyset pagination may still require sorting in memory. That is acceptable for this task if current storage is file-backed and dataset size is bounded, but the helper should be structured so database-backed keyset filtering can replace it later.

6. **Domain boundary drift**  
   Keep reusable pagination logic in the findings layer and avoid introducing dashboard-to-unrelated-domain imports. Reuse existing symbols and error helpers where available.

## Section 9 — Acceptance Criteria

1. The audit findings list endpoint accepts an optional `limit` query parameter.

2. When `limit` is omitted, the endpoint returns no more than `DEFAULT_FINDINGS_PAGE_SIZE` findings.

3. The endpoint rejects `limit` values that are non-integer, less than `1`, or greater than `MAX_FINDINGS_PAGE_SIZE` with `400 Bad Request`.

4. The endpoint never returns more than `MAX_FINDINGS_PAGE_SIZE` findings in a single response.

5. The endpoint response includes pagination metadata containing `limit`, `hasMore`, and `nextCursor`.

6. When additional records exist after the returned page, `hasMore` is `true` and `nextCursor` is a non-empty opaque string.

7. When no additional records exist after the returned page, `hasMore` is `false` and `nextCursor` is `null`.

8. Supplying a valid `nextCursor` from page 1 returns the next page without duplicating findings from page 1.

9. Pagination order is deterministic and uses a unique tie-breaker so findings with identical timestamps are not skipped or duplicated.

10. Malformed cursors are rejected with `400 Bad Request`.

11. Cursors with unsupported versions or incompatible sort metadata are rejected with `400 Bad Request`.

12. A cursor generated for one filter set is rejected when used with a different filter set.

13. Existing authorization, repository scope, and filter behavior remain unchanged.

14. New unit tests cover cursor encoding/decoding, limit validation, cursor validation, and duplicate-timestamp pagination.

15. New endpoint-level tests verify first-page and second-page behavior, max page size enforcement, invalid cursor handling, and no overlap between pages.

### Arm OSS-DS

- Models: `{"models":["deepseek/deepseek-v4-pro"],"resolved":"deepseek/deepseek-v4-pro"}`
- Conformant: true
- Output hash: `8c3a852e3923325a`

## Overview

Add stable cursor‑based pagination with a configurable maximum page size to the existing audit‑findings list endpoint. The endpoint will return a limited page of findings together with an opaque `nextCursor` that clients can send back to retrieve the next page. The pagination logic is implemented in the findings domain library and consumed by the Supabase Edge Function endpoint. The change is minimal, re‑uses existing symbols, and respects the architecture’s dependency rules.

## Design Decisions

- **Stable cursor** – A Base64‑encoded JSON object containing the `id` and `created_at` of the last finding in the page. Using the composite key `(created_at DESC, id DESC)` ensures deterministic ordering and cursor stability even when new findings are inserted.
- **Keyset pagination** – The underlying Supabase query uses the `ordered` fields and a `WHERE` clause that compares the composite key to the cursor’s values (`lt`). This avoids offset‑based pagination pitfalls and performs well on indexed columns.
- **Max page size** – Enforced server‑side: default 50, maximum 100. Clients can request a smaller limit; values above 100 are clamped to 100.
- **Endpoint validation** – The query parameters `cursor` (optional) and `limit` (optional) are parsed and validated. Invalid cursors (malformed JSON, missing fields, wrong types) return a `400 Bad Request`.
- **Re‑use existing symbols** – The existing `listFindings` function (exported from `scripts/lib/findings.mjs`) is extended with pagination parameters. The endpoint handler is updated to pass those parameters. No new abstractions are introduced.
- **Safety and persistence** – All database queries remain parameterised (Supabase client’s builder methods). The cursor is never interpreted as SQL; it is decoded and used only for constructing `.lt()` / `.or()` filters.
- **Testability** – Unit tests cover the pagination logic in isolation; integration tests verify the full HTTP contract.

## File‑level Plan

### 1. `scripts/lib/findings.mjs` (modify)

**Purpose** – Core findings library; provides the `listFindings` function used by the endpoint.

**Changes**

- Add an optional `options` parameter: `{ cursor?: string, limit?: number }`.
- Default `limit` to 50, clamp to 100.
- Decode cursor if present:
  - Base64 decode → JSON parse.
  - Validate that it contains `id` (string) and `created_at` (string).
  - On failure, throw a controlled error (e.g. `InvalidCursorError` to be caught by the endpoint).
- Build the Supabase query:
  - Always order by `created_at` descending, then `id` descending.
  - If cursor is valid, add a filter: `created_at < cursor.created_at` **OR** (`created_at = cursor.created_at` AND `id < cursor.id`). Use Supabase’s `.or()` with the appropriate condition string.
- Request `limit + 1` rows to detect whether there is a next page.
- After fetching, compute `nextCursor`:
  - If fetched rows > limit, slice to `limit` and encode the `id` and `created_at` of the last row in the slice as the next cursor.
  - If fetched rows ≤ limit, `nextCursor` is `null`.
- Return `{ findings, nextCursor }`.

### 2. `supabase/functions/audit-findings/index.ts` (modify)

**Purpose** – HTTP endpoint (`GET /audit-findings`) that returns findings.

**Changes**

- Parse query parameters `cursor` and `limit` from the URL.
- Validate `limit`:
  - Convert to integer, default to 50 if missing.
  - Clamp to the range [1, 100].
- Call `listFindings(supabase, { cursor, limit })`.
- Catch the `InvalidCursorError` (or more generic validation error) and respond with `400 Bad Request` and a descriptive message.
- On success, respond with `200 OK` and JSON body `{ findings, nextCursor }`.
- On unexpected errors, respond with `500 Internal Server Error`.

### 3. `tests/unit/findings.test.js` (modify)

**Purpose** – Unit tests for the findings library.

**Changes**

- Add test cases for `listFindings`:
  - Default behaviour (no cursor, no limit) returns first page with default limit.
  - Cursor decoding and encoding work correctly.
  - Next page detection works (nextCursor is present when more items exist, absent when at end).
  - Empty result set returns `{ findings: [], nextCursor: null }`.
  - Invalid cursor throws an error.
  - Limit clamping (0 → 1, 101 → 100, negative → 1).

### 4. `tests/integration/supabase/findings-endpoint.test.ts` (create or modify)

**Purpose** – Integration tests for the HTTP endpoint.

**Changes**

- Create or extend an existing test file to exercise the full endpoint:
  - Seed a known set of findings.
  - Request without cursor → verify first page, correct `nextCursor`.
  - Use the returned `nextCursor` to fetch the next page → verify correct items.
  - Verify cursor stability: multiple calls with the same cursor return the same next page.
  - Verify that the last page returns `nextCursor: null`.
  - Test invalid cursor → 400.
  - Test limit > 100 → 200 with clamped limit.
  - Test limit = 0 → 400 or 200 with clamped limit (decide contract).

## Risks

- **Data consistency** – Findings inserted between page requests may cause items to shift. This is inherent to keyset pagination; the cursor is stable *for the result set at the time the cursor was generated*, but the next page may include new items that appear before the cursor’s cutoff. Document this behaviour.
- **Missing database indexes** – The query relies on `ORDER BY created_at DESC, id DESC` and a `WHERE` predicate on the same columns. Ensure a composite index `(created_at, id)` exists; otherwise, performance may degrade.
- **Cursor forward‑compatibility** – If the findings schema changes (e.g., `created_at` renamed), the cursor encoding must be updated. The decoding logic should be resilient to unknown fields, but a version prefix could be added later if needed (not in this plan).
- **Error handling** – The endpoint must never leak internal errors (stack traces) to the client. The unit tests and integration tests must verify error responses.

## Target Paths

- `scripts/lib/findings.mjs`
- `supabase/functions/audit-findings/index.ts`
- `tests/unit/findings.test.js`
- `tests/integration/supabase/findings-endpoint.test.ts`

## Section 9 — Acceptance Criteria

1. `GET /audit-findings` without parameters returns a page of findings with a default limit of 50 and a `nextCursor` field.
2. The `nextCursor` is a non‑empty string when there are more findings; it is `null` when the last page is reached.
3. Using the returned `nextCursor` as the `cursor` query parameter fetches the next page of findings correctly, with no overlaps or gaps.
4. The cursor is stable: repeated calls with the same cursor return the same result set (assuming no concurrent modifications).
5. The `limit` query parameter is honoured; values above 100 are silently clamped to 100, values below 1 are clamped to 1.
6. An invalid cursor (malformed JSON, missing `id` or `created_at`, wrong types) results in a `400 Bad Request` with a clear error message.
7. When there are zero findings, the endpoint returns `200 OK` with `{ findings: [], nextCursor: null }`.
8. The endpoint returns `500 Internal Server Error` for unexpected backend failures, without exposing internal details.
9. Unit tests cover all branches of the pagination logic (default, cursor, limit clamping, empty results, invalid cursor).
10. Integration tests verify the end‑to‑end contract, including seed data, pagination, and error cases.

### Arm OSS-GLM

- Models: `{"models":["z-ai/glm-5.2"],"resolved":"z-ai/glm-5.2"}`
- Conformant: true
- Output hash: `485d759236d02c47`

# Implementation Plan — Cursor Pagination for Audit Findings List

## Overview

The audit findings list currently returns the full result set in a single call. This plan adds stable cursor-based pagination with an enforced maximum page size. The cursor must be stable across inserts/deletes that occur outside the current page boundary, so we use a composite key cursor (`created_at`, `id`) encoded opaquely. The max page size is a hard ceiling applied after parsing the user-requested size, with a sensible default when no size is requested.

The change is confined to the `findings` domain (query/cursor logic) and the `audit-orchestration` domain (the endpoint that calls the list). No new domains are introduced; existing storage and shared-lib utilities are reused.

## Design Decisions

1. **Cursor strategy: composite `(created_at, id)` key, opaque base64url encoding.**
   - Rationale: Findings are append-mostly with a `created_at` timestamp. A simple offset cursor is unstable when new findings are inserted between page fetches (skips or duplicates). A composite key on `(created_at, id)` provides a total order that is immune to inserts before the cursor position. `id` is the tiebreaker for same-timestamp entries, guaranteeing a stable, deterministic ordering even under clock collisions.
   - The cursor is an opaque token — callers never parse it. This decouples the internal ordering from the wire contract, allowing future migration to a different sort key without breaking clients.

2. **Max page size: hard ceiling (100), default page size (25), minimum (1).**
   - Rationale: A hard ceiling prevents unbounded queries from degrading persistence-layer performance. The default of 25 balances usability against payload size. Sizes above the ceiling are clamped, not rejected — rejecting creates a poor caller experience for a non-security-critical parameter. Sizes below 1 are clamped to 1.

3. **Cursor validation is explicit, not silent.**
   - A malformed or undecodable cursor returns a typed error (`INVALID_CURSOR`) rather than silently resetting to page 1. This prevents silent data omission when a client passes a stale/corrupt token. An empty/absent cursor is the legitimate "first page" signal and is not an error.

4. **Response contract: `{ items, nextCursor, hasMore }`.**
   - `nextCursor` is `null` when the last page has been reached. `hasMore` is a convenience boolean derived from whether the query returned `pageSize + 1` rows (fetch-one-extra pattern). This avoids a second count query.
   - The extra row is stripped from `items` before serialization; it exists only to determine `nextCursor`.

5. **Sort direction is fixed to ascending `(created_at, id)`.**
   - Rationale: Introducing a `sort` parameter expands the surface area and the cursor must encode direction. The task asks for a stable cursor, not a configurable sort. Fixing ascending keeps the contract minimal. Descending can be added later as a separate, opt-in parameter without breaking the default path.

6. **No schema migration required.**
   - The cursor depends only on `created_at` and `id`, both of which are existing columns in the findings store (per the persistence invariants). No new index is strictly required for correctness, though a composite index on `(created_at, id)` is recommended for performance at scale (noted as a risk, not a blocker).

7. **Pagination logic lives in the findings domain, not in audit-orchestration.**
   - The findings domain owns the data model and query semantics. The endpoint in audit-orchestration is a thin caller that forwards parameters and serializes the response. This respects the existing `allowedDeps` (audit-orchestration → findings) and keeps the cursor encoding/decoding co-located with the data it references.

## Failure Modes

| Mode | Handling |
|---|---|
| Cursor is malformed (not valid base64url, truncated JSON, missing fields) | Return `INVALID_CURSOR` error; do not fall back to page 1 |
| Cursor references a `created_at`/`id` pair that no longer exists | Not an error — the `WHERE (created_at, id) > (cursor_created_at, cursor_id)` clause still positions correctly; the row is simply gone |
| Requested `pageSize` is not a number, negative, or > max | Clamp to `[1, MAX_PAGE_SIZE]`; if non-numeric, use default |
| Persistence layer returns zero rows | Return `{ items: [], nextCursor: null, hasMore: false }` — legitimate empty page, not an error |
| Persistence layer throws | Propagate as internal error; no partial results |

## File-Level Plan

### Findings domain

- **`scripts/lib/findings-store.mjs`** (modify) — Add a `paginateFindings({ cursor, pageSize })` function that implements the fetch-one-extra pattern: decodes the cursor, clamps the page size, issues a query ordered by `(created_at ASC, id ASC)` with a `WHERE` clause derived from the cursor, slices the extra row, and returns `{ items, nextCursor, hasMore }`. This is the single source of truth for pagination semantics.

- **`scripts/lib/findings-cursor.mjs`** (create) — Pure functions `encodeCursor({ createdAt, id })` and `decodeCursor(token)` plus `MAX_PAGE_SIZE`, `DEFAULT_PAGE_SIZE` constants and a `clampPageSize(input)` helper. Base64url encoding of a compact JSON payload. No I/O, no side effects — fully unit-testable in isolation. Placing cursor logic in its own module keeps `findings-store.mjs` focused on persistence and makes the cursor contract independently testable.

### Audit-orchestration domain

- **`scripts/lib/audit/list-findings.mjs`** (modify) — The existing list endpoint handler. Update it to accept `cursor` and `pageSize` from the request, delegate to `paginateFindings`, and serialize the response. Error mapping: `INVALID_CURSOR` → 400 response; all other errors → 500. No business logic here — it is a transport adapter.

### Tests

- **`tests/findings-cursor.test.mjs`** (create) — Unit tests for the cursor module: round-trip encode/decode, malformed-token rejection, boundary values, `clampPageSize` clamping at 0, negative, above max, non-numeric, and default.

- **`tests/findings-pagination.test.mjs`** (create) — Integration tests against the findings store: first-page fetch (no cursor), forward traversal across multiple pages, `hasMore` correctness at the boundary, empty result set, stability under concurrent insert (insert a row with an earlier `created_at` between page fetches and assert no duplicate/skip), max-page-size enforcement, and `INVALID_CURSOR` error propagation through the endpoint.

## Risks

1. **Performance without a composite index.** If the findings table grows large and lacks an index on `(created_at, id)`, the cursor `WHERE` clause degrades to a scan. This is a performance risk, not a correctness risk. Mitigation: document the recommended index; add it if a migration path exists. Not a blocker for the feature.

2. **Clock skew on `created_at`.** If `created_at` is set by distributed writers with unsynchronized clocks, the ascending order may not match real-world insertion order. The `id` tiebreaker still guarantees determinism. This is an inherent property of the existing schema, not introduced by pagination.

3. **Cursor replay.** A client could replay an old cursor. This is safe by design — the cursor positions in a total order, and replaying it simply re-fetches from that point. No special handling needed.

4. **Existing callers of the un-paginated list.** Any caller that currently expects a flat array will break. Mitigation: audit all call sites of the list function before merging; either update them to consume the new `{ items, nextCursor, hasMore }` shape or provide a compatibility wrapper (`findAllFindings()`) that iterates pages internally for callers that genuinely need the full set. The wrapper should be used sparingly and logged, to discourage unbounded fetches.

## Target Paths

- `scripts/lib/findings-store.mjs` (modify)
- `scripts/lib/findings-cursor.mjs` (create)
- `scripts/lib/audit/list-findings.mjs` (modify)
- `tests/findings-cursor.test.mjs` (create)
- `tests/findings-pagination.test.mjs` (create)

## Section 9 — Acceptance Criteria

1. Calling the list endpoint with no `cursor` parameter returns the first page of findings ordered by `(created_at ASC, id ASC)`, with `nextCursor` set to a non-null opaque string and `hasMore: true` when more rows exist.

2. Calling the list endpoint with a `cursor` obtained from a previous response returns the next contiguous page — no row from the previous page appears, and no row is skipped relative to the total ordering.

3. When the last page is reached, `nextCursor` is `null` and `hasMore` is `false`.

4. When the underlying store contains zero findings, the response is `{ items: [], nextCursor: null, hasMore: false }` with no error.

5. Requesting a `pageSize` greater than `MAX_PAGE_SIZE` (100) returns at most 100 items; the requested size is clamped, not rejected.

6. Requesting a `pageSize` of 0, a negative number, or a non-numeric value returns the default page size (25) worth of items without error.

7. Passing a malformed cursor (corrupt base64url, truncated JSON, or missing required fields) returns an `INVALID_CURSOR` error with an HTTP-equivalent 400 status; it does not silently reset to page 1.

8. Inserting a new finding with a `created_at` earlier than the last item on the current page, then fetching the next page, does not produce a duplicate of any already-seen row and does not skip any row that sorts after the cursor.

9. The `encodeCursor` and `decodeCursor` functions are pure (no I/O, no side effects) and round-trip correctly for all valid inputs including timestamp collisions where two findings share the same `created_at` (disambiguated by `id`).

10. All existing call sites of the previously un-paginated list function either consume the new paginated contract or use an explicit compatibility wrapper; no call site silently breaks.

## Judge scores (blinded at judge time; unblinded here post-ranking)

| Pass | Label | Arm | Scores |
|---|---|---|---|
| 1 | output-1 | OSS-GLM | `{"reuse":4,"clarity":5,"correctness":5,"completeness":4,"right_sizing":5,"risk_handling":4,"implementability":5,"repo_intent_fidelity":5,"architectural_coherence":5,"acceptance_criteria_quality":5}` |
| 1 | output-2 | GPT | `{"reuse":4,"clarity":4,"correctness":5,"completeness":5,"right_sizing":3,"risk_handling":5,"implementability":4,"repo_intent_fidelity":4,"architectural_coherence":4,"acceptance_criteria_quality":5}` |
| 1 | output-3 | OSS-DS | `{"reuse":3,"clarity":4,"correctness":4,"completeness":3,"right_sizing":4,"risk_handling":3,"implementability":3,"repo_intent_fidelity":2,"architectural_coherence":2,"acceptance_criteria_quality":4}` |
| 2 | output-1 | OSS-GLM | `{"reuse":4,"clarity":5,"correctness":4,"completeness":4,"right_sizing":5,"risk_handling":4,"implementability":4,"repo_intent_fidelity":4,"architectural_coherence":5,"acceptance_criteria_quality":5}` |
| 2 | output-2 | GPT | `{"reuse":3,"clarity":4,"correctness":5,"completeness":5,"right_sizing":3,"risk_handling":5,"implementability":4,"repo_intent_fidelity":3,"architectural_coherence":3,"acceptance_criteria_quality":5}` |
| 2 | output-3 | OSS-DS | `{"reuse":3,"clarity":4,"correctness":4,"completeness":3,"right_sizing":4,"risk_handling":3,"implementability":3,"repo_intent_fidelity":2,"architectural_coherence":2,"acceptance_criteria_quality":4}` |

