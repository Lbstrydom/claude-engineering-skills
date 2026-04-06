# Plan: Phase G.3 — GitHub Adapter (Branch + Issues)

- **Date**: 2026-04-06
- **Status**: Draft (follows Phase G.2)
- **Author**: Claude + Louis
- **Parent**: [skill-bundle-mega-plan.md](./skill-bundle-mega-plan.md) / split from phase-g-storage-adapters
- **Depends on**: G.1 (interfaces + facade + envelope API) and G.2 (optional — reuses no-SQL primitives; conformance hardening benefits)
- **Scope**: Build a GitHub-native storage adapter using a dedicated branch + GitHub Issues as the durable store. Users with GitHub-only infra (no DB) get persistent debt + audit-run history without operating SQLite/Postgres/Supabase.

---

## 1. Context

Some consumer repos run entirely in GitHub — no cloud DB, no team Supabase, no shared SQLite location. For them, the simplest cross-session storage is GitHub itself: commits to a dedicated branch + Issues for events and debt entries.

G.3 ships `stores/github-store.mjs` that:
- Uses a dedicated `audit-events/main` branch (configurable) as the durable store
- Writes debt entries and learning state as JSON files committed to that branch
- Writes audit-run history and adjudication events as GitHub Issues (with structured body + labels)
- Authenticates via `GITHUB_TOKEN` (GitHub Actions default) or PAT
- Uses octokit (`@octokit/rest`) via `optionalDependencies`

**Target audience**: repos already in GitHub, no external DB allowed (compliance, budget, simplicity), CI-first workflows.

**Trade-off**: GitHub API rate limits + eventual consistency (branch pushes aren't instant). G.3 designs around these explicitly — it's NOT a low-latency adapter.

### Non-Goals

- GitLab / Bitbucket equivalents (separate future adapters)
- Cross-fork/cross-org federation
- Encrypting the storage branch (GitHub repo-level permissions are the only access control)
- Real-time or sub-second consistency
- Writing back to the primary branch (stays on `audit-events/main`)
- Replacing any G.1/G.2 adapter — GitHub is an additional option

---

## 2. Proposed Architecture

### 2.1 Storage Model

Two storage surfaces inside one repo:

**A. `audit-events/main` branch** (dedicated, orphan branch):
**Identifier model (fix G3-R1-H5)**:
- `storageRepoSlug`: the `AUDIT_GITHUB_OWNER/AUDIT_GITHUB_REPO` pair — identifies the GitHub repo hosting the storage branch. Config-only, never appears in file paths.
- `scopeId`: the audited-repo's fingerprint (from G.1 §2.5). ALL persisted paths are namespaced by this. Passed through as `repoId` from the facade.

File layout (all paths namespaced by `scopeId`):
- `debt/<scopeId>/entries.json` — debt entries map (atomic-replace)
- `events/<scopeId>/<idempotencyKey>.json` — per-event files (immutable, append-only)
- `learning/<scopeId>/bandit-deltas/<isoTs>-<idempKey>.json` — append-only delta (§2.4)
- `learning/<scopeId>/fp-deltas/<isoTs>-<idempKey>.json` — append-only delta
- `runs/<scopeId>/<runId>.json` — per-run summary (immutable once written)
- `findings/<scopeId>/<runId>/<passName>.json` — findings batches (immutable)
- `global/prompt-variants.json` — global state (atomic-replace, NOT scopeId-namespaced)
- `schema_version.json` — `{v: 1}` version marker

**B. GitHub Issues** (projection layer — NOT the authoritative store):
- Labels: `audit-loop:event`, `audit-loop:adjudication`, `audit-loop:suppression`
- Title: `[audit-loop] run=<runId> scope=<scopeId> topic=<topicId> kind=<kind>`
- Body: structured JSON block between `<!-- AL_EVENT -->` markers + operator-facing summary
- Closed immediately on creation (archival, not actionable)

**CRITICAL (fix G3-R1-H2)**: Issues are a **projection**, not the source of truth. The authoritative store for ALL data — including adjudication + suppression events — is the branch. Events live at `events/<scopeId>/<eventId>.json` (immutable, append-only). Issues are created as a **read-only view** for operator UX. If an issue is deleted/edited, no data is lost; the adapter only reads from the branch.

**Why split surfaces**: branch commits are the authoritative durable store; Issues provide filter/search UX that operators use to browse events. Issues are optional — if creation fails (rate limit, permission), the event is still recorded on the branch.

### 2.2 Read / Write Model

**Writes go through the GitHub REST API** via `@octokit/rest`:

**Atomic multi-file commits via Git Data API (fix G3-R1-H6)**:

Every logical write unit goes through a **single commit** containing all related file mutations:
1. Fetch current branch HEAD ref → `parentSha`
2. Fetch base tree → `baseTreeSha`
3. Build new tree with all files changed in this operation: `POST /repos/:o/:r/git/trees` with `base_tree=<baseTreeSha>` + array of `{path, mode, type, content}` entries
4. Create commit: `POST /repos/:o/:r/git/commits` with `tree=<newTreeSha>`, `parents=[parentSha]`, `message='[audit-loop] <operation summary>'`
5. Update branch ref: `PATCH /repos/:o/:r/git/refs/heads/audit-events/main` with `sha=<newCommitSha>`, `force=false` → CAS against current HEAD

If step 5 returns 422 (ref not at expected sha), adapter re-reads HEAD and retries the merge (§2.4). This gives us atomicity across multiple files within a single commit — no partial writes.

- **Issues**: `POST /repos/:o/:r/issues` + immediate `PATCH` to close. Issue creation is a **best-effort projection** — fails silently (logged to stderr), does not affect the authoritative branch state.

**Reads**:
- `GET /repos/:o/:r/contents/:path?ref=audit-events/main` for JSON files (authoritative for ALL data)
- Issues are NOT read by the adapter — they are read-only projections for human operators

**Local cache (fix G3-R1-M1 — coherency)**:
- Cache is **request-scoped**, not process-scoped: keyed by `(path, ref_sha)`, where `ref_sha` is revalidated before **every read operation** via a lightweight `GET /repos/:o/:r/git/ref/heads/audit-events/main` call (~50ms)
- If remote `ref_sha` matches cache → serve from cache (cache hit). If different → invalidate, re-fetch files
- After every successful local write → cache updated with new `ref_sha` from the commit response
- Cache is **process-scoped** (lives for process lifetime) but **revalidated on every read** via ref-check (fix G3-R2-M4 — "request-scoped" was a misnomer; the correct description is "process-scoped with per-read revalidation")
- Multi-writer scenario: each process revalidates on every read, so remote writes are visible within one API round-trip
- ETag optimization: `If-None-Match` on contents API calls to avoid downloading unchanged blobs

### 2.3 Branch Bootstrap

**First-run flow**: if `audit-events/main` branch doesn't exist, adapter **fails fast** with a canonical misconfiguration error pointing at the setup CLI:

```
Error: audit-events/main branch missing.
Run: node scripts/setup-github-store.mjs --owner <o> --repo <r>
This creates an orphan branch with initial schema_version.json.
```

Setup CLI (`scripts/setup-github-store.mjs`) creates the orphan branch via:
1. Generate empty tree: `POST /repos/:o/:r/git/trees` with `[{path:'schema_version.json', mode:'100644', type:'blob', content: '{"v":1}'}]`
2. Commit with no parent: `POST /repos/:o/:r/git/commits` with `tree=<treeSha>`, `parents=[]`
3. Create branch ref: `POST /repos/:o/:r/git/refs` with `ref=refs/heads/audit-events/main`, `sha=<commitSha>`

This parallels the G.2 setup-CLI / runtime-adapter split: **setup CLIs own DDL-equivalents, runtime only verifies**.

### 2.4 Concurrency + Conflict Resolution

GitHub atomic-writes via `sha` parameter give us optimistic concurrency control:
- Writer reads current file + its `sha`
- Writer sends updated file with that `sha` as the expected-current
- If another writer committed in between, GitHub returns 409 → adapter catches → re-reads → retries the application-level merge

**Retry policy**:
- Max 3 retries with exponential backoff (200ms, 800ms, 2s)
- After 3 conflicts → surfaces as `{ reason: 'transient', retryable: true, bufferToOutbox: true }` envelope
- Outbox replay (G.1 §2.1) handles it on next run

**Application-level merge (fix G3-R1-H4)** — delta-event model for hot mutable entities:

Bandit arms and FP patterns are stored as **append-only delta logs** (not full-state snapshots) to avoid the "sum-from-same-baseline" double-counting problem:
- `learning/<scopeId>/bandit-deltas/<isoTs>-<idempKey>.json` = `{arm_key, alpha_delta: +1, beta_delta: 0}`
- `learning/<scopeId>/fp-deltas/<isoTs>-<idempKey>.json` = `{pattern_hash, dismissals_delta: +1}`

On **read**, adapter materializes current state by scanning all deltas and summing. Materialized view is cached in-memory per `initLearningStore()`.

On **conflict** (409 during commit), adapter re-reads HEAD, confirms its new delta files don't conflict with any existing delta files (they won't — each is uniquely named by idempotency key), retries the tree+commit. No merge logic needed for append-only files.

For **debt entries** and **prompt variants** (low-contention, infrequently-updated):
- Stored as single atomic-replace files
- On 409 conflict: re-read, **3-way merge** (base + ours + theirs):
  - Debt entries (fix G3-R2-H5): merge by `topic_id`, **field-level merge within each entry** — numeric fields (occurrences, severity_weight) take max, timestamp fields take latest, payload_json takes the version with the later `updatedAt`. If `updatedAt` ties, last-writer-wins (acceptable: both writers computed the same delta). This prevents silent data loss of concurrent updates to the same topic
  - Prompt variants: merge by `variant_id`, last-writer-wins per variant (independent, low-contention)
- 3-way merge uses the committed base tree (fetched at step 1) as the common ancestor; if base is unavailable (branch was force-pushed), falls back to last-writer-wins with a loud warning

### 2.5 Rate Limiting

GitHub REST API: 5000 req/hr per authenticated user, 1000 req/hr for `GITHUB_TOKEN` in Actions.

**Adapter budget per audit run**:
- ~5 reads at init (branch HEAD, schema-version, debt entries, bandit, FP)
- ~8 writes per round (debt + learning updates + 2-4 new events + run summary)
- ~10 total per round

**Updated budget with issue projections (fix G3-R2-H3)**:
- Branch writes: ~2 commits per round (1 debt/learning + 1 events/run), each = 3 API calls (tree + commit + ref-update) = ~6 per round
- Branch reads: ~5 per round (ref revalidation + file reads)
- Issue projections: ~N events per round × 2 calls (create + close). For a typical round with 10 findings → 20 issue calls
- Total per round: ~31 calls. For 5 rounds: ~155 calls

**Issue projection budget cap**: if >50% of the per-run rate budget is consumed, adapter pauses issue projection for the rest of the run (events are already on branch). Logs: `[github] issue projection paused — rate-limit budget low; events are on branch`. This prevents issue projections from starving authoritative writes.

**Rate-limit handling (fix G3-R1-M2)** — explicit plugin chain:
- `@octokit/plugin-throttling` + `@octokit/plugin-retry` configured at Octokit init:
  - Throttling: respect `x-ratelimit-remaining`, `x-ratelimit-reset`, `retry-after`; queue when approaching limit
  - Retry: automatic exponential backoff on 500/502/504 + secondary rate-limit (403 with `retry-after`); max 3 retries
- On rate-limit hit: returns `{ok: false, reason: 'transient', retryable: true, bufferToOutbox: true, operatorHint: 'GitHub rate limit hit; retry after <seconds>s'}`
- Outbox replay handles retry

### 2.6 Issues API for Events

Adjudication + suppression events have these properties:
- High volume (one per finding per round)
- Operators actually browse them
- Immutable once written

Issues API is well-suited:
- Labels filter/search
- Title searchable
- GitHub UI shows them grouped

Issue body format:
```
<!-- AL_EVENT v=1 -->
{"runId":"...","topicId":"...","kind":"adjudication","ruling":"overrule","rationale":"..."}
<!-- /AL_EVENT -->

**Summary**: GPT overruled `file.mjs` SRP violation — 300-line file acceptable.
**Ruling**: overrule
**Round**: 2
```

**Adapter reads events from the BRANCH**, not Issues. Issues are a human-readable projection.

**Idempotency (fix G3-R1-H3)**: idempotency is enforced at the **branch level**, not Issues. Each event is stored as `events/<scopeId>/<idempotencyKey>.json` — if the file already exists, the write is a no-op (CAS on branch). Issues are projected afterward; if an issue already exists for a given key (checked via lightweight title-match, NOT search API), projection skips. Issue projection failure is non-fatal.

### 2.7 Authentication

Config:
- `AUDIT_STORE=github` to select
- `AUDIT_GITHUB_TOKEN=<token>` (required — PAT or `GITHUB_TOKEN` from Actions env)
- `AUDIT_GITHUB_OWNER=<owner>` (required)
- `AUDIT_GITHUB_REPO=<repo>` (required)
- `AUDIT_GITHUB_BRANCH=audit-events/main` (default)
- `AUDIT_GITHUB_API_URL=https://api.github.com` (override for GHE)

**Token permissions required**:
- Fine-grained PAT: `contents:write`, `issues:write`, `metadata:read`
- Classic PAT: `repo` scope
- `GITHUB_TOKEN` in Actions: requires `permissions: { contents: write, issues: write }` in workflow YAML

**Token validation at init (fix G3-R2-M3)**: adapter calls `GET /repos/:o/:r` (the storage repo) — this works for ALL token types (PAT classic, PAT fine-grained, `GITHUB_TOKEN`). On 401 → "token invalid". On 404 → "repo not found or token lacks access". On success, adapter verifies `permissions.contents` + `permissions.issues` from the response (GitHub returns this for fine-grained PATs). For classic PATs that don't return granular permissions, adapter defers permission validation to the first actual write (fail-fast on 403).

### 2.8 Capability Matrix

| Interface | github adapter | Storage backing |
|---|---|---|
| debt.* | supported | branch: `debt/<repoId>/` |
| run.* | supported | branch: `runs/` + `findings/`; events: Issues |
| learningState.* | supported | branch: `learning/<repoId>/` |
| globalState.* | supported | branch: `global/` |
| repo.* | supported | synth: repoId = `owner/repo` slug (fixed-per-install) |

**`scopeIsolation: true`** — GitHub adapter path-scopes by `repoId` in file paths, conformance isolation test passes.

**Special repoId note**: for a github adapter, `repoId` (i.e. `scopeId`) is the audited-repo's fingerprint (sha256 hex, 64 chars). Multiple audited repos writing to the same storage repo each get their own `scopeId`-namespaced directory. The "storage repo" slug is separate config (`AUDIT_GITHUB_OWNER`/`AUDIT_GITHUB_REPO`).

**Path encoding (fix G3-R2-M2)**: all dynamic path segments are validated + encoded:
- `scopeId`: sha256 hex (64 chars, `[a-f0-9]`-only) — safe by construction
- `runId`: UUIDv4 (36 chars, `[a-f0-9-]`-only) — safe by construction
- `passName`: validated against `^[a-zA-Z0-9_-]{1,64}$` at facade boundary
- `idempotencyKey`: sha256 hex — safe by construction
- `isoTs`: validated ISO-8601 format, colons replaced with dashes for path safety
- Path length: GitHub enforces 256-char max per path component; total max path ~400 chars for deepest nesting. Validated at adapter boundary.
- Any value failing validation → reject with `{reason: 'validation'}` envelope

### 2.9 Compaction + Read Scalability (fix G3-R2-H4)

Over time, append-only delta files and events accumulate unboundedly. Without compaction, reads degrade linearly.

**Compaction strategy**: the setup CLI (`setup-github-store.mjs --compact`) runs a **snapshot + prune** cycle:
1. Materializes current bandit/FP state from all deltas into `learning/<scopeId>/bandit-snapshot-<isoTs>.json` + `fp-snapshot-<isoTs>.json`
2. Adds a `compaction-marker-<isoTs>.json` = `{cutoffTs: <isoTs>}` alongside the snapshot
3. Deletes all delta files with timestamps < `cutoffTs` (in a single atomic commit)
4. Future reads: if snapshot file exists, load it; then scan ONLY deltas after `cutoffTs`

**Events compaction**: events older than 90 days are bundled into `events/<scopeId>/archive-<year>-<quarter>.json` (one file per quarter per repo). Individual event files are deleted.

**Directory-listing strategy**: adapter uses `GET /repos/:o/:r/git/trees/<sha>?recursive=1` to list all files on the branch in a SINGLE API call (returns up to 100K entries). This avoids per-directory listing pagination. File paths are parsed client-side to filter by prefix (`debt/<scopeId>/`, `events/<scopeId>/`, etc.).

**Read bound**: materialized reads (bandit, FP, debt) are always bounded to 1 snapshot + 1 tree-listing + scan recent deltas. Events read is bounded by `sinceTs` + archive files.

**When to compact**: documented operator responsibility. Setup CLI `--compact` is idempotent; recommended after every 100 audit runs or monthly, whichever comes first.

### 2.10 Error Normalization

Extends G.2's `normalizeError()` with GitHub-specific codes:

| Native | reason | retryable | bufferToOutbox | hint |
|---|---|---|---|---|
| 401 Unauthorized | misconfiguration | no | no | "GitHub token invalid; check AUDIT_GITHUB_TOKEN" |
| 403 Forbidden (scope) | misconfiguration | no | no | "token lacks required scopes (contents:write, issues:write)" |
| 403 Rate-limited | transient | yes | yes | "GitHub rate limit hit; retry after <X>s" |
| 404 branch missing | misconfiguration | no | no | "run setup-github-store.mjs" |
| 404 file missing (read) | not-an-error | — | — | returns null/empty as empty-data |
| 409/422 stale-ref (write) | transient | yes (3x) | yes (after retries) | "concurrent write conflict; retrying via merge" |
| 422 validation | validation | no | no | "GitHub rejected payload; see error body" |
| 500-502, 504 | transient | yes | yes | "GitHub upstream error; retry" |
| network error | transient | yes | yes | "network error contacting GitHub; retry" |

### 2.11 Schema Version

`schema_version.json` on the branch contains `{v: 1}`. Setup CLI writes it; adapter init reads it + fails fast on mismatch with canonical misconfiguration error pointing at setup CLI `--migrate` flag.

Future schema bumps ship as a new setup-CLI migration that rewrites file layouts in a single atomic commit (new tree + new branch HEAD). Downgrades refused.

---

## 3. File Impact Summary

**New files**:

| File | Purpose |
|---|---|
| `scripts/lib/stores/github-store.mjs` | GitHub adapter factory |
| `scripts/lib/stores/github/git-data-api.mjs` | Wraps octokit Git Data API (trees/commits/refs) for atomic multi-file commits |
| `scripts/lib/stores/github/contents-read-api.mjs` | Wraps octokit Contents API for reads only |
| `scripts/lib/stores/github/issues-projection.mjs` | Best-effort issue creation for operator UX (non-authoritative) |
| `scripts/lib/stores/github/merge-ops.mjs` | Application-level merge for conflict resolution |
| `scripts/lib/stores/github/github-errors.mjs` | `normalizeError` extension for GitHub codes |
| `scripts/setup-github-store.mjs` | Operator CLI: orphan-branch creation + migrations |
| `tests/stores/github-store.test.mjs` | Mock octokit tests + conformance |
| `tests/stores/github/content-api.test.mjs` | Content API wrapper tests |
| `tests/stores/github/issues-api.test.mjs` | Issues API wrapper tests |
| `tests/stores/github/merge-ops.test.mjs` | Merge semantics tests |

**Modified files**:

| File | Change |
|---|---|
| `scripts/lib/stores/index.mjs` | Add `github` to `VALID_ADAPTERS`, lazy-load via `await import('./github-store.mjs')` in the `github` branch only (fix G3-R1-H1) |
| `scripts/lib/stores/conformance.mjs` | No changes — github has `scopeIsolation: true` |
| `scripts/lib/stores/normalize-errors.mjs` | Extract shared error types from `sql/sql-errors.mjs` + add GitHub mappings |
| `package.json` | Add `@octokit/rest` + `@octokit/plugin-throttling` + `@octokit/plugin-retry` to `optionalDependencies` |
| `.env.example` | Document `AUDIT_GITHUB_*` vars |

**NOT touched**:
- G.1 facade, interfaces
- G.2 SQL adapters, sql/ modules
- Phase D callers

---

## 4. Testing Strategy

### Unit tests

- **git-data-api.mjs**: mock octokit, verify tree-build + commit + ref-update sequence, 422-retry on stale ref
- **contents-read-api.mjs**: mock octokit, verify read paths with ETag caching, 404-as-empty-data
- **issues-projection.mjs**: verify issue creation/close as best-effort, no read-back
- **merge-ops.mjs**: bandit (max), FP (sum), debt (union with topicId), prompt-variants (last-write-wins)
- **github-errors.mjs**: each native code maps to canonical envelope

### Conformance suite (github-store.test.mjs)

Runs G.1/G.2 conformance against a **mock-octokit adapter** (in-memory branch + issues state):
- Roundtrip, scope isolation, envelope contract, idempotency, ordering, tx atomicity (via 409-retry)
- Extra test: rate-limit simulation → transient-failure envelope + outbox buffering
- Extra test: 409-conflict simulation → retry → merge → success

### Integration tests (opt-in)

Gated on `GITHUB_STORE_TEST_REPO` + `GITHUB_STORE_TEST_TOKEN` env vars:
- Point at a throwaway test repo
- Run full audit round end-to-end
- Verify branch + issues created correctly
- Clean up (delete branch + close all test issues)
- Skipped in OSS CI by default; Louis runs locally before merge

---

## 5. Rollback Strategy

- **Revert G.3**: git revert adapter files + `stores/index.mjs` additions. `AUDIT_STORE=github` fail-fast-errors per G.1 §2.1. User data on `audit-events/main` branch persists — safe to re-enable later.
- **Per-user rollback**: set `AUDIT_STORE=noop` (or another adapter). Branch data remains on disk. Operators can manually delete the branch if desired.
- **Branch data recovery**: if the adapter is reverted, data is still readable via GitHub UI or `git fetch origin audit-events/main && git checkout audit-events/main`.

---

## 6. Implementation Order

1. **`github/github-errors.mjs`** + tests — canonical envelope mapping (422 for stale-ref, not 409).
2. **`github/git-data-api.mjs`** + mock-octokit tests — tree/commit/ref-update sequence, 422-retry.
3. **`github/contents-read-api.mjs`** + tests — read-only contents, ETag caching.
4. **`github/issues-projection.mjs`** + tests — best-effort create/close, no read.
5. **`github/merge-ops.mjs`** + tests — delta-event append (bandit/FP), 3-way (debt/prompt).
6. **`github-store.mjs`** — factory composing the APIs, implements G.1 interfaces.
6. **Conformance**: `github-store.test.mjs` runs full conformance against mock octokit.
7. **`setup-github-store.mjs`** — orphan-branch creation + migration scaffold.
8. **`stores/index.mjs` + `.env.example` + `package.json`** — wiring.
9. **Integration test gated on env vars** — real GitHub test repo.
10. **Commit + push G.3.**

---

## 7. Known Limitations (accepted for G.3)

1. **Latency ceiling** — every write is a REST API round-trip (~200-500ms from most locations). A 5-round audit adds ~15-25s of GitHub latency. **Mitigation**: in-memory cache reduces duplicate reads; writes batched where possible.
2. **Rate limits are hard ceilings** — Actions `GITHUB_TOKEN` is 1000 req/hr. Repos with many parallel audit workflows can exhaust this. **Mitigation**: outbox buffering + operator hint to use PAT (5000/hr) for high-volume workflows.
3. **409-conflict retry limit (3)** — heavy concurrent writes surface as transient failures. **Mitigation**: outbox replay; concurrent-writers documented as "low volume" use case.
4. **Issues API pagination** — reading all events for a repo requires N paginated requests. **Mitigation**: `sinceTs` filter on facade uses GitHub's `since` param; typical reads scan recent events only.
5. **GitHub Issues UX clutter** — audit-loop events create many closed issues. **Mitigation**: all events use dedicated labels; repo maintainers can filter them out of default issue views via saved queries.
6. **No encryption** — data stored as plaintext JSON on a branch. Repo-level GitHub permissions are the only access control. **Mitigation**: documented; operators needing encryption should use postgres/sqlite with disk encryption.
7. **No multi-storage-repo support in one adapter instance** — adapter is scoped to one `owner/repo` storage. Running audit-loop across N repos writing to M different storage repos requires switching `AUDIT_GITHUB_REPO`. **Mitigation**: documented use case is "audited repo == storage repo" (most common).
8. **Field-level debt merge is best-effort** — concurrent edits to the same topic use field-level max/latest merge, but edge cases (identical updatedAt, both writers changing payload_json differently) fall back to last-writer-wins. **Mitigation**: debt entries change rarely after initial creation; concurrent edits to the same field are exceptional.
9. **Setup-CLI dependency at runtime** — conformance test harness invokes `setup-github-store.mjs` (via helper) to create an initial branch in the mock. **Mitigation**: same pattern as G.2 `createMigratedDb(dialect)` — programmatic entry point.
10. **Compaction is operator-initiated** — no automatic compaction; unbounded delta growth if operator never runs `setup-github-store.mjs --compact`. **Mitigation**: init logs stale-delta count if >100 deltas; compaction documented in README. Future: auto-compact on `initLearningStore()` if delta count exceeds threshold.
11. **Issue projection budget cap may suppress operator UX** — under heavy audit load, issue projections pause to preserve rate budget for authoritative writes. **Mitigation**: events are always on branch; operators can browse via `git checkout audit-events/main` or GitHub file browser.

---

## 8. Resolved Design Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| Q1 | Branch only or mix with Issues? | **Both — branch for state, Issues for events** | Branch is cheap for blobs, Issues has filter/search UX |
| Q2 | Auto-create branch at runtime? | **No — setup CLI owns it** | Matches G.2 ownership pattern, avoids runtime race |
| Q3 | Conflict resolution strategy? | **Optimistic CAS + 3x retry + app-level merge** | Simple, bounded, degrades to outbox |
| Q4 | Merge semantics per entity? | **Monotonic for counters, last-write-wins for state** | Minimizes data loss without 3-way merge complexity |
| Q5 | Issue-per-event or batched? | **Issue-per-event** (closed immediately) | Operator UX + pagination simplicity |
| Q6 | octokit dependency — required or optional? | **`optionalDependencies` + explicit fail-fast (fix G3-R2-L1)**: when `AUDIT_STORE=github` and `await import('@octokit/rest')` throws `ERR_MODULE_NOT_FOUND`, adapter exits with `Error: AUDIT_STORE=github requires @octokit/rest. Run: npm install @octokit/rest @octokit/plugin-throttling @octokit/plugin-retry` | Most users don't need github adapter |
| Q7 | Rate-limit strategy? | **Outbox buffering via canonical transient envelope** | Reuses G.1 §2.1 machinery |
| Q8 | Self-host (GHE) support? | **Yes — via `AUDIT_GITHUB_API_URL` override** | Standard octokit config |
| Q9 | Scope isolation flag? | **`true`** | Files path-scoped by repoId fingerprint |
| Q10 | Authentication model? | **Single token (PAT or GITHUB_TOKEN)** | Matches GitHub's standard auth model |
| Q11 | Schema versioning? | **`schema_version.json` on branch, setup-CLI manages** | Same ownership pattern as G.2 |
| Q12 | Errors extension layer? | **Rename `sql-errors.mjs` → `normalize-errors.mjs`, share** | Don't recreate normalization; github extends it |
