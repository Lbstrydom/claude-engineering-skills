# Plan: Phase G.1 — Storage Interface + Facade + noop + Supabase refactor

- **Date**: 2026-04-05
- **Status**: Draft (follows Phase F)
- **Author**: Claude + Louis
- **Parent**: [skill-bundle-mega-plan.md](./skill-bundle-mega-plan.md) / split from phase-g-storage-adapters
- **Depends on**: Phase F complete (install infrastructure)
- **Scope**: Refactor `learning-store.mjs` into pluggable-adapter architecture. Define interfaces cleanly, ship `noop` adapter + refactored `supabase` adapter, establish data-scoping + fail-fast + schema contracts. NO new adapters, NO GitHub backend, NO SQLite/Postgres — those are G.2/G.3.

---

## 1. Context

Phase G was originally scoped as "5 adapters in one phase". The audit said no (7 HIGHs at R1). Phase G is now split into 3 sub-phases:

- **G.1 (this plan)**: interfaces + facade + noop + Supabase refactor
- **G.2**: SQLite + Postgres (generic SQL backends)
- **G.3**: GitHub adapter (branch + Issues)

**G.1's job**: establish the architecture cleanly. No new storage backends shipped; existing Supabase code becomes one adapter behind a facade. The `noop` adapter is the default when no config is set. Every subsequent adapter (G.2, G.3) slots into the interfaces this phase defines.

**Zero behavioral change for current Supabase users** is the invariant.

### Why split this way

The G.1 audit exposed (as Phase G R1 at H1-H7):
- The interface was a "god interface" mixing concerns — split must happen BEFORE adapters are built against it
- Data-scoping contract was incomplete — must be explicit before multi-backend semantics get defined
- Facade fail-fast vs graceful-degrade policy was contradictory — must be resolved before any adapter init logic
- Debt-ledger ownership split between adapter + `lib/debt-ledger.mjs` + local files was unclear — must pick ONE path

All these are **architectural groundwork**. Doing them cleanly in G.1 means G.2/G.3 build against a stable foundation.

### Key Requirements

1. **Split the interface by concern** — not one god interface, but `DebtStore`, `RunStore`, `LearningStateStore`, `GlobalStateStore` (see §2.2)
2. **Facade dispatches explicitly** — `AUDIT_STORE` env var with backward-compat auto-detect for existing Supabase users
3. **`noop` is default** — zero config works out of the box
4. **Fail-fast on broken explicit config** — `AUDIT_STORE=supabase` + missing keys → exit 1 with clear error (NOT silent noop fallback)
5. **Data-scoping policy enforced at facade level** — every query takes explicit `repoId`, per-entity scope documented + tested
6. **Zero behavioral change for current Supabase users** — existing env vars auto-detect to supabase adapter
7. **Debt-ledger ownership is unambiguous** — debt always flows through the adapter; noop routes debt calls through the adapter (which delegates to `lib/debt-ledger.mjs` for file operations)
8. **Zod schemas at boundaries** — adapter config, capability declarations, cross-adapter DTOs all validated
9. **`@supabase/supabase-js` becomes an optional dep** — `noop` users don't need it

### Non-Goals

- New adapters (SQLite/Postgres in G.2, GitHub in G.3)
- Cross-backend migration tools
- Schema changes (keep current schema; adapters must work with it as-is)
- Adapter-level encryption
- Multi-repo federation strategy (defer)
- Replacing `lib/debt-ledger.mjs` (it stays as the file-based implementation — see §2.6)

---

## 2. Proposed Architecture

### 2.0 Authoritative Capability & Return-Shape Matrix (normative)

**This table is the single source of truth**; other sections refer back to it. When anything else in the plan appears to contradict this table, this table wins.

| Facade method | noop | supabase | Legacy return shape (unchanged) | Envelope access |
|---|---|---|---|---|
| `upsertRepo(profile, name)` | local, fingerprint-as-repoId | cloud, UUID | `Promise<string\|null>` (repoId or null) | `.withEnvelope()` variant |
| `getRepoByFingerprint(fp)` | local synth | cloud lookup | `Promise<{id, fingerprint}\|null>` | `.withEnvelope()` variant |
| `upsertDebtEntries(repoId, e)` | local files | cloud | `Promise<{ok, inserted, updated}>` | `.withEnvelope()` variant |
| `readDebtEntries(repoId)` | local files | cloud | `Promise<object[]>` | `.withEnvelope()` variant |
| `removeDebtEntry(repoId, id)` | local files | cloud | `Promise<{ok, removed}>` | `.withEnvelope()` variant |
| `appendDebtEvents(repoId, ev)` | local files | cloud | `Promise<{inserted}>` | `.withEnvelope()` variant |
| `readDebtEvents(repoId, since?)` | local files | cloud | `Promise<object[]>` | `.withEnvelope()` variant |
| `syncBanditArms(repoId, arms)` | local files | cloud | `Promise<void>` | `.withEnvelope()` variant |
| `loadBanditArms(repoId)` | local files | cloud | `Promise<object\|null>` | `.withEnvelope()` variant |
| `syncFalsePositivePatterns(repoId, p)` | local files | cloud | `Promise<void>` | `.withEnvelope()` variant |
| `loadFalsePositivePatterns(repoId)` | local files | cloud | `Promise<{repoPatterns, globalPatterns}>` | `.withEnvelope()` variant |
| `recordRunStart(repoId, plan, mode)` | **not supported** → returns `null` | cloud, UUID | `Promise<string\|null>` | `.withEnvelope()` variant |
| `recordRunComplete(runId, stats)` | not supported → no-op | cloud | `Promise<void>` | `.withEnvelope()` variant |
| `recordFindings(runId, f, pass, r)` | not supported → no-op | cloud | `Promise<void>` | `.withEnvelope()` variant |
| `recordPassStats(runId, pass, s)` | not supported → no-op | cloud | `Promise<void>` | `.withEnvelope()` variant |
| `recordAdjudicationEvent(...)` | not supported → no-op | cloud | `Promise<void>` | `.withEnvelope()` variant |
| `recordSuppressionEvents(...)` | not supported → no-op | cloud | `Promise<void>` | `.withEnvelope()` variant |
| `syncPromptRevision(pass, id, t)` | not supported → no-op | cloud | `Promise<void>` | `.withEnvelope()` variant |
| `listGlobalPromptVariants()` | not supported → `[]` | cloud | `Promise<object[]>` | `.withEnvelope()` variant |

**Dual-API rule (fix H2)**: G.1 preserves **legacy shapes** for every existing facade method to guarantee zero-behavior-change. The discriminated envelope (§2.11) is exposed via a **parallel method namespace** `learningStore.envelope.*`, NOT by mutating legacy return types. Existing callers untouched; new callers that need to distinguish unsupported/transient/empty use the envelope namespace.

**Phase D caller migration (fix H4 contradiction)**: Phase D callers (openai-audit.mjs, debt-resolve, debt-backfill, debt-budget-check) are migrated to call **`learningStore.upsertDebtEntries(...)`** etc. (legacy shape). They do NOT switch to envelope variants. Raw return shapes are identical to what `lib/debt-ledger.mjs` returned, so migration is 1-line-per-site (change import).

### 2.1 Adapter Selection Contract

**Selection logic** (`scripts/lib/stores/index.mjs`):

```javascript
/**
 * Pick adapter from env. Order matters:
 * 1. Explicit AUDIT_STORE wins
 * 2. Backward-compat auto-detect for existing users (one-time notice)
 * 3. Default to noop
 *
 * Missing-required-vars for EXPLICIT AUDIT_STORE = fail-fast, not silent fallback.
 */
export function pickAdapter() {
  if (process.env.AUDIT_STORE) {
    return validateExplicitAdapter(process.env.AUDIT_STORE);  // fail-fast on missing vars
  }
  // Backward-compat auto-detect
  if (process.env.SUPABASE_AUDIT_URL && process.env.SUPABASE_AUDIT_ANON_KEY) {
    logOnce('auto-detect', 'Legacy Supabase env detected; using supabase adapter. Set AUDIT_STORE=supabase to silence this notice.');
    return 'supabase';
  }
  return 'noop';
}
```

**Fail-fast contract** (fix for original Phase G R1-H3):
- `AUDIT_STORE=supabase` + missing `SUPABASE_AUDIT_URL` → exit 1, lists required vars
- `AUDIT_STORE=unknown-adapter` → exit 1, lists valid values
- NEVER silently fall back to noop when an explicit adapter is set

**Transient-failure contract** (fix G1-R1-H3 — no silent data loss):

Adapter init that connects-and-fails (e.g., cloud server down):
- Logs a **loud warning** to stderr: `[learning] adapter=<name> UNREACHABLE — data will buffer to .audit/local/pending-writes/ and retry on next invocation.`
- Facade routes write calls to a **local buffer** at `.audit/local/pending-writes/<adapter>-<timestamp>.jsonl`
- Reads return empty (no data to query while disconnected)
- Next invocation: facade checks for pending-writes file, replays to the now-connected adapter, deletes the buffer file on success
- After 30 days of unflushed buffers → loud warning on every invocation suggesting operator switch to `noop` or fix connection
- Operators can disable buffering with `AUDIT_STORE_NO_BUFFER=1` (then writes fail-fast)

**Outbox journal format (fix G1-R2-M1)**: pending-writes is a durable outbox with the following contract:
- File name: `.audit/local/pending-writes/<adapter>-<schemaVersion>-<iso8601>.jsonl`
- Each line is a JSON record `{ v, op, idempotencyKey, repoId, createdAt, payload }`:
  - `v`: journal schema version (starts at `1`; bump when payload shapes change)
  - `op`: adapter method name (`upsertDebtEntries`, `recordFindings`, etc.)
  - `idempotencyKey`: deterministic hash of `(op, repoId, payload)` → replay is safe if adapter already applied it
  - `createdAt`: ISO timestamp for stale-warning computation
- **Atomic append**: each record written with `fs.appendFileSync` + `fsync` per line (crash-safe)
- **Replay ownership**: process acquires a `.audit/local/pending-writes/.lock` file (exclusive, with PID + start time). Stale locks older than 10 min are stolen with a warning
- **Partial-success handling**: replay walks the file line-by-line; on per-record adapter error, logs + continues (adapter idempotency ensures re-delivery is safe). On systemic error (adapter re-disconnects), aborts and leaves remaining lines for next run
- **Delete-on-fully-drained**: file deleted only after every line replays successfully; otherwise rewritten with unprocessed tail
- **Schema version mismatch**: replay refuses to process records with `v > maxSupported`; warns operator to upgrade
- Replay is best-effort on every `initLearningStore()`; failures don't block the current run

**This is distinct from**:
- **Broken config** (missing required env var) → fail-fast, exit 1 on init
- **Unsupported capability** (calling `run.*` on noop) → structured "not-supported" return (§2.11)

Three clearly-distinguished cases: config-error, transient-unreachable, and
capability-mismatch. None of them silently lose data.

### 2.2 Split Interfaces by Concern (fix original G R1-H1)

Instead of one `LearningStoreInterface` with 20+ methods, split by data concern:

```javascript
// scripts/lib/stores/interfaces.mjs

/**
 * DebtStore — persistent debt ledger + events (Phase D data).
 * Called by lib/debt-ledger.mjs + lib/debt-events.mjs + lib/debt-memory.mjs.
 */
export const DebtStoreInterface = {
  async upsertDebtEntries(repoId, entries) -> {ok, inserted, updated, error?}
  async readDebtEntries(repoId) -> object[]
  async removeDebtEntry(repoId, topicId) -> {ok, removed, error?}
  async appendDebtEvents(repoId, events) -> {inserted, error?}
  async readDebtEvents(repoId, sinceTs?) -> object[]
};

/**
 * RunStore — per-audit-run history (Phase 3/4 learning system).
 */
export const RunStoreInterface = {
  async recordRunStart(repoId, planFile, mode) -> runId|null
  async recordRunComplete(runId, stats) -> void
  async recordFindings(runId, findings, passName, round) -> void
  async recordPassStats(runId, passName, stats) -> void
  async recordAdjudicationEvent(runId, fingerprint, event) -> void
  async recordSuppressionEvents(runId, result) -> void
};

/**
 * LearningStateStore — per-repo + global learning state (Phase 2 bandit/FP).
 * Methods take repoId explicitly. Global data goes to the global-sentinel repoId.
 */
export const LearningStateStoreInterface = {
  async syncBanditArms(repoId, arms) -> void
  async loadBanditArms(repoId) -> object|null
  async syncFalsePositivePatterns(repoId, patterns) -> void
  async loadFalsePositivePatterns(repoId) -> {repoPatterns, globalPatterns}
  async syncExperiments(experiments) -> void              // global
};

/**
 * GlobalStateStore — codebase-agnostic audit-loop state.
 */
export const GlobalStateStoreInterface = {
  async syncPromptRevision(passName, revisionId, text) -> void
  async listGlobalPromptVariants() -> object[]
};

/**
 * RepoStore — fingerprint-based repo registry.
 */
export const RepoStoreInterface = {
  async upsertRepo(profile, repoName) -> string|null   // returns repoId
  async getRepoByFingerprint(fingerprint) -> object|null
};
```

**Adapter implementations**: each adapter exports an object implementing any
subset of these interfaces. The facade checks capability flags on each
method and routes accordingly.

```javascript
// stores/supabase-store.mjs
export const adapter = {
  name: 'supabase',
  capabilities: { debt: true, run: true, learningState: true, globalState: true, repo: true },
  debt: { upsertDebtEntries, readDebtEntries, removeDebtEntry, appendDebtEvents, readDebtEvents },
  run: { recordRunStart, recordRunComplete, recordFindings, /* ... */ },
  learningState: { /* ... */ },
  globalState: { /* ... */ },
  repo: { upsertRepo, getRepoByFingerprint },
};
```

### 2.3 Facade Routing

`scripts/learning-store.mjs` becomes the facade:

```javascript
// Facade delegates to the adapter's sub-interface. Methods missing from
// the adapter (declared via capabilities) return no-op values from facade.

let _adapter = null;

export async function initLearningStore() {
  const name = pickAdapter();
  _adapter = await loadAdapterModule(name);
  const ok = await _adapter.init?.();
  process.stderr.write(`  [learning] Adapter: ${name} ${ok ? '(connected)' : '(UNREACHABLE — writes will buffer to .audit/local/pending-writes/; see §2.1)'}\n`);
  return ok;
}

export async function upsertRepo(profile, name) {
  if (!_adapter?.capabilities.repo) return null;
  return _adapter.repo.upsertRepo(profile, name);
}
// ... one facade wrapper per interface method
```

**Facade guarantees**:
- Methods with no matching capability → return structured `{ supported: false, reason }` envelope (§2.11)
- Facade never throws on missing capability — adapters are free to be partial
- Every method takes `repoId` explicitly where the interface demands it (§2.5)
- Return contract is **unambiguous**: capability-missing, transient-failure, and empty-data are distinguished (§2.11)

### 2.4 Backward-Compat Wrappers for Deprecated Names

Phase D.1 shipped method names like `readDebtEntriesCloud`, `removeDebtEntryCloud`. These become **deprecated wrappers** that log once and forward to the new names:

```javascript
let _deprecationsLogged = new Set();
export async function readDebtEntriesCloud(repoId) {
  if (!_deprecationsLogged.has('readDebtEntriesCloud')) {
    process.stderr.write('  [learning] readDebtEntriesCloud is deprecated; use readDebtEntries (adapter is no longer cloud-specific)\n');
    _deprecationsLogged.add('readDebtEntriesCloud');
  }
  return readDebtEntries(repoId);
}
```

These wrappers stay through G.1/G.2/G.3, get removed in a post-Phase-G cleanup commit.

**Affected old names**: `readDebtEntriesCloud`, `removeDebtEntryCloud`, `appendDebtEventsCloud`, `readDebtEventsCloud`, `upsertDebtEntries` (was renamed in D.1 — keep current name).

### 2.5 Data-Scoping Policy (fix original G R1-H2, R1-H8)

**Every query method takes `repoId` as the first parameter.** No ambient state, no silent cross-repo reads.

Per-entity scope (matches existing Phase 3 + Phase D schema):

| Entity | Primary scope | Secondary scope |
|---|---|---|
| `debt_entries`, `debt_events` | per-repo | — |
| `audit_runs`, `audit_findings`, `audit_pass_stats` | per-repo | — |
| `suppression_events`, `finding_adjudication_events` | per-repo | — |
| `bandit_arms` | per-repo | `GLOBAL_REPO_ID` fallback priors |
| `false_positive_patterns` | per-repo | `GLOBAL_REPO_ID` cross-repo priors |
| `prompt_variants`, `prompt_revisions`, `prompt_experiments` | global (`GLOBAL_REPO_ID`) | — |

**`GLOBAL_REPO_ID`** is a sentinel UUID (`00000000-0000-0000-0000-000000000000`) already
used by the current Supabase schema (see `.audit-loop/` learning tables).
Global-scope entities always use this repoId. G.1 preserves this convention.

**Method naming convention**: queries that read global-only data are named
explicitly (`listGlobalPromptVariants()`, NOT `listPromptVariants(repoId)`).
Mixed-scope reads (e.g., FP patterns) return `{ repoPatterns, globalPatterns }`
objects so callers weight them independently — matches existing Phase 3 behavior.

**Enforcement**: facade passes `repoId` through to adapter methods unchanged.
Adapters apply the filter at the backend's native query layer (SQL WHERE,
API param, etc.). The facade does NOT enforce scope itself — adapters do.

**`repoId` identity model** (fix G1-R1-H2):

`repoId` is a **stable opaque string** per repo. The adapter owns its own
mapping between the fingerprint (content-addressable from the repo's stack
profile) and the repoId it returns.

- **fingerprint** (universal, portable): `sha256(repoProfile)` — computed once
  from the audit-loop's existing `generateRepoProfile()`. Stable across
  machines/clones because it's derived from repo content.
- **repoId** (adapter-specific, opaque to callers): whatever the adapter
  returns from `upsertRepo(profile, name)`. Callers treat it as opaque.

Adapters guarantee:
- `upsertRepo(profile, name)` is idempotent: same fingerprint → same repoId
- `getRepoByFingerprint(fingerprint)` returns the existing repoId or null
- repoId is stable within an adapter (doesn't change across sessions)

**Client-generated IDs (fix G1-R2-H1)**: all identifiers that flow through
facade calls are **generated client-side** before any adapter round-trip:
- `repoId` for new repos: the facade computes `sha256(profile)` → hex prefix,
  synchronously, before calling `upsertRepo`. Adapter accepts this as the row
  PK (supabase: maps it into the UUID column by reformatting; sqlite/postgres:
  stores as text PK). Legacy Supabase rows that already exist keep their
  UUIDs; facade's `upsertRepo` calls `getRepoByFingerprint` first, reuses the
  existing row's id if found.
- `runId`: client-generated UUIDv4 at `recordRunStart`, returned immediately
  even if adapter call is pending/buffered. Subsequent `recordFindings(runId,...)`
  calls work whether the adapter round-tripped or not.
- **Consequence**: identities never block on adapter round-trips; the same run
  produces consistent IDs whether the backend is reachable or not.

Adapter-specific mappings (documented):
- **noop**: repoId = fingerprint (1-to-1)
- **supabase**: repoId = client-generated (derived from fingerprint, formatted
  as UUID). On insert, the client ID is written as the PK. Existing rows pre-G.1
  keep their server-generated UUIDs; facade resolves via `getRepoByFingerprint`
  before insert.
- **sqlite (G.2)**: same as supabase, random UUID per row
- **postgres (G.2)**: same
- **github (G.3)**: repoId = the GitHub `owner/repo` slug (persistent)

**Callers NEVER cross adapter boundaries with a repoId** — the facade routes
every call through a single adapter, and that adapter's repoId is used
only within that adapter's storage. If an operator switches `AUDIT_STORE`,
they get a fresh repo registry (and existing debt file at
`.audit/tech-debt.json` stays intact, local-files is its own per-repo scope).

**Global scope sentinel**: `GLOBAL_REPO_ID = '00000000-0000-0000-0000-000000000000'`
is only meaningful within adapters that persist global-scoped entities
(supabase, postgres, sqlite). noop doesn't persist global state, so the
sentinel is unused there.

### 2.6 Debt-Ledger Ownership (fix original G R1-H4)

**Unambiguous rule**: the adapter's `DebtStore` methods ARE the entry point
for all debt operations. The facade routes ALL debt-ledger calls through
`_adapter.debt.*`.

**`lib/debt-ledger.mjs` becomes the file-based implementation** used by the
`noop` adapter's `DebtStore`:

```javascript
// stores/noop-store.mjs
import * as fileDebtLedger from '../../lib/debt-ledger.mjs';

export const adapter = {
  name: 'noop',
  capabilities: { debt: true, run: false, learningState: true, globalState: false, repo: true },
  debt: {
    async upsertDebtEntries(repoId, entries) {
      // noop uses local files; repoId is informational only (local ledger is per-repo-working-dir anyway)
      return fileDebtLedger.batchWriteLedger('.audit/tech-debt.json', entries);
    },
    async readDebtEntries(repoId) {
      const ledger = fileDebtLedger.readLedger('.audit/tech-debt.json');
      return ledger.entries;
    },
    // ... etc.
  },
  repo: {
    async upsertRepo(profile) {
      // Synthesize repoId deterministically from fingerprint (no cloud call)
      return profile.repoFingerprint;
    },
    async getRepoByFingerprint(fingerprint) {
      return { id: fingerprint, fingerprint };
    },
  },
};
```

**Result**: consumers ALWAYS call through the facade. The facade ALWAYS
goes through the adapter. Adapters use whichever storage fits (files for
noop, Supabase for supabase, etc.). No split ownership.

**Existing callers** (fix G1-R1-H4 — single write path, no split ownership):

Phase D code in `scripts/openai-audit.mjs` + Phase D scripts currently call
`lib/debt-ledger.mjs` directly (`batchWriteLedger`, `readLedger`, etc.).
G.1 **migrates these callers to the facade** as part of the G.1 refactor:

| Old call | New call (via facade) |
|---|---|
| `batchWriteLedger('.audit/tech-debt.json', entries)` | `upsertDebtEntries(repoId, entries)` |
| `readLedger('.audit/tech-debt.json')` | `readDebtEntries(repoId)` |
| `removeEntry(path, topicId)` | `removeDebtEntry(repoId, topicId)` |

`lib/debt-ledger.mjs` becomes a **private-by-convention** module consumed
ONLY by `stores/noop-store.mjs`:
- JSDoc marks each public function as `@internal`
- README note: "Don't call `lib/debt-ledger.mjs` directly — call the facade"
- No breaking change for external consumers (we have none yet)

**Single write path after G.1**:
```
Phase D scripts → learning-store.mjs (facade) → adapter.debt.* → storage
                                              ↑
                                              noop adapter → lib/debt-ledger.mjs → local files
                                              supabase adapter → @supabase/supabase-js → cloud
```

Callers never see `lib/debt-ledger.mjs`. Only `stores/noop-store.mjs` does.
Clean ownership. G.1 **commits the migration of Phase D callers** as a
mandatory step — not deferred.

**Migration scope**: ~5 call sites in openai-audit.mjs + debt-resolve.mjs +
debt-backfill.mjs + debt-budget-check.mjs. Each is a 1-line change (import
facade instead of lib module). Tests must pass unchanged.

### 2.7 `noop` Adapter Implementation

Silent no-op for methods it doesn't support. File-based for methods it does.

| Capability | noop behavior |
|---|---|
| `debt.*` | delegates to `lib/debt-ledger.mjs` (local files, Phase D) |
| `repo.*` | synthetic repoId from fingerprint, no persistence |
| `learningState.*` | delegates to `.audit/bandit-state.json` + `.audit/fp-tracker.json` (local files, existing behavior) |
| `run.*` | not supported (local run history not previously persisted) |
| `globalState.*` | not supported |

**noop is working-directory-scoped by design (fix G1-R2-H3)**: noop's
"scope" is the single repo whose working-directory hosts `.audit/`. The
`repoId` passed to noop methods is informational only — noop reads/writes
`.audit/tech-debt.json`, `.audit/bandit-state.json`, `.audit/fp-tracker.json`
in the current working directory, period. This matches pre-G.1 Phase D
behavior exactly (debt and learning state were already single-repo-per-checkout).

**Conformance suite opt-out for noop**: the cross-repo isolation test ("query
with repoId=A doesn't return rows from repoId=B") **does not apply** to noop.
noop's contract is: "storage is scoped to the working directory; repoId is
accepted-but-ignored". This is documented in the conformance suite as a
capability flag `scopeIsolation: false` on the noop adapter; the isolation
test skips adapters with that flag. Adapters that DO have multi-repo storage
(supabase, sqlite, postgres, github) MUST have `scopeIsolation: true` and MUST
pass the isolation test.

**Why `noop` supports debt + learningState** (fix G1-R1-H1): these concerns
already have local-file implementations shipped before G.1:
- Phase D.1 shipped `.audit/tech-debt.json` + `.audit/local/debt-events.jsonl`
- Existing code (pre-G.1) persists `bandit-state.json` + `fp-tracker.json`
  locally via `atomicWriteFileSync`

Removing these would regress existing behavior. `noop` wraps the file
layer for both concerns so current users who run without cloud retain
their bandit arms + FP patterns across sessions.

**`run.*` + `globalState.*` remain unsupported** — no prior local
implementation to wrap. These require actual storage (SQLite adds them
in G.2). Calling facade methods for these on noop returns structured
"not-supported" signals (§2.11).

### 2.8 Refactor `scripts/learning-store.mjs` → `stores/supabase-store.mjs`

**Extraction**:
1. Move all Supabase-specific code from `scripts/learning-store.mjs` to `scripts/lib/stores/supabase-store.mjs`
2. Rename methods to match new interfaces (drop `Cloud` suffixes)
3. Group methods under capability sub-objects (`debt`, `run`, `learningState`, etc.)
4. Move `_supabase` client init to `supabaseAdapter.init()`
5. `scripts/learning-store.mjs` becomes the facade — ~150 LoC of dispatch code

**Zero-behavior-change test**: all existing tests must pass with `AUDIT_STORE=supabase` set. Run full suite (604+ tests) before AND after the refactor.

### 2.9 Optional-Dep Loading

`package.json` moves `@supabase/supabase-js` from `dependencies` to `optionalDependencies`:

```json
{
  "optionalDependencies": {
    "@supabase/supabase-js": "^2.x"
  }
}
```

**Facade check**: `loadAdapterModule('supabase')` dynamically imports, catches missing-dep error, exits with clear message:

```
Error: AUDIT_STORE=supabase requires @supabase/supabase-js but it is not installed.
Run: npm install @supabase/supabase-js
(Or set AUDIT_STORE=noop to run without cloud persistence.)
```

**Lazy-loading isolation boundary (fix G1-R2-M2)**:
- `scripts/learning-store.mjs` facade imports ONLY `stores/index.mjs` at top level; adapter modules are loaded via `await import(...)` inside `loadAdapterModule()` after selection
- `shared.mjs` barrel MUST NOT re-export adapter implementations (only interfaces + schemas)
- No source file may top-level-import `stores/supabase-store.mjs` directly
- CI adds a test: installs with `--omit=optional`, runs `AUDIT_STORE=noop npm test`, verifies zero `@supabase/supabase-js` resolution attempts (via `require.resolve` probe that should throw)
- ESLint rule `no-restricted-imports` blocks direct imports of `supabase-store.mjs` outside `stores/index.mjs` and its own tests

### 2.10 Schema Validation at Boundaries

`scripts/lib/schemas-store.mjs` defines Zod schemas for:

- `AdapterConfigSchema` — env-var shapes per adapter
- `AdapterCapabilitiesSchema` — `{ debt, run, learningState, globalState, repo }` booleans
- `DebtEntryDTO` — what the debt interface exchanges (maps to Phase D's PersistedDebtEntrySchema)
- `DebtEventDTO` — event envelope
- `RepoDTO` — repo row shape
- `RunDTO`, `FindingDTO`, etc. for run-related methods

Validation runs:
- On every adapter method's return value (boundary)
- On config read at adapter init

Invalid data → clear error surfaced at the boundary, no silent propagation.

### 2.11 Return Contract — Distinguishing Unsupported / Transient / Empty (fix G1-R1-H5)

**Problem**: "return null/[]/{ok:true}" for unsupported capabilities conflates
three very different states:
- **Capability missing**: adapter doesn't implement this concern (noop + run.*)
- **Transient failure**: adapter unreachable, data buffered (§2.1)
- **Legitimately empty**: query ran, no matching rows

Callers need to tell these apart. A bandit-load that returns `null` could mean
"adapter doesn't do learningState" (use defaults forever) OR "no arms yet"
(use defaults then persist) OR "Supabase is down" (retry later). Each deserves
a different caller response.

**Solution (dual-API, preserves zero-behavior-change)**: the facade exposes both legacy shapes (§2.0 column 4) AND a parallel envelope namespace. Legacy methods return raw values exactly as before G.1 — existing callers/tests are not touched. New callers that need to distinguish states call `learningStore.envelope.<method>(...)`:

```javascript
// Write methods
{ ok: true,  supported: true,  written: <n>, ... }           // success
{ ok: false, supported: true,  reason: 'transient', buffered: true }  // buffered, retry next run
{ ok: false, supported: true,  reason: 'validation', errors: [...] }  // schema failed
{ ok: true,  supported: false, reason: 'capability' }        // no-op, adapter doesn't support

// Read methods
{ ok: true,  supported: true,  data: [...] }                 // success (possibly empty list)
{ ok: false, supported: true,  reason: 'transient', data: [] }  // adapter down, no data
{ ok: true,  supported: false, reason: 'capability', data: null } // no-op, adapter doesn't support
```

**Caller contract** (opt-in via envelope namespace):

```javascript
const res = await learningStore.envelope.loadBanditArms(repoId);
if (!res.supported) {
  // Adapter doesn't persist learning state — use in-memory defaults, don't try to save
}
else if (!res.ok && res.reason === 'transient') {
  // Cloud down this run — use in-memory defaults, don't overwrite on save
}
else if (res.data === null) {
  // No prior arms — first run, start fresh
}
else {
  // Use res.data
}
```

**Facade-level convenience**: the legacy top-level methods (`learningStore.loadBanditArms(repoId)`) internally call the envelope method, unwrap to the pre-G.1 shape, and return. Callers get identical behavior to pre-G.1 without having to learn the envelope API.

**Schema**: `StoreResponseSchema` in `schemas-store.mjs` validates every
envelope at the facade boundary.

**Adapter contract**: adapters return raw values (`null`, `[]`, `{inserted: 3}`,
etc.) from their sub-interface methods; the **facade** wraps them into
envelopes based on adapter capabilities + call outcome. Adapters never
construct envelopes themselves — keeps adapter code simple.

---

## 3. File Impact Summary

**New files**:

| File | Purpose |
|---|---|
| `scripts/lib/stores/interfaces.mjs` | Documented JSDoc interfaces (DebtStore, RunStore, etc.) |
| `scripts/lib/stores/index.mjs` | `pickAdapter()`, `loadAdapterModule()`, `validateExplicitAdapter()` |
| `scripts/lib/stores/noop-store.mjs` | noop adapter (default) |
| `scripts/lib/stores/supabase-store.mjs` | Refactored from `learning-store.mjs` |
| `scripts/lib/schemas-store.mjs` | Zod schemas for adapter boundaries |
| `tests/stores/conformance.mjs` | Shared conformance suite for all adapters |
| `tests/stores/noop-store.test.mjs` | noop-specific tests + conformance |
| `tests/stores/supabase-store.test.mjs` | supabase-specific tests + conformance |
| `tests/stores/index.test.mjs` | adapter-selection tests, fail-fast + auto-detect |
| `tests/stores/schemas-store.test.mjs` | schema validation tests |

**Modified files**:

| File | Change |
|---|---|
| `scripts/learning-store.mjs` | Becomes thin facade (~150 LoC) |
| `package.json` | `@supabase/supabase-js` → `optionalDependencies` |
| `.env.example` | Document `AUDIT_STORE=noop\|supabase` + per-adapter env vars |

**Internals preserved (module structure unchanged)**:
- `scripts/lib/debt-ledger.mjs` — still the file-based implementation; `stores/noop-store.mjs` delegates to it (§2.6)

**Modified callers (migration required per §2.6)** — 1-line-per-site import swap:
- `scripts/openai-audit.mjs` — debt-ledger calls become facade calls
- `scripts/debt-resolve.mjs`, `scripts/debt-backfill.mjs`, `scripts/debt-budget-check.mjs` — same
- These scripts continue to use legacy return shapes (§2.0) so behavior is bit-for-bit identical.

---

## 4. Testing Strategy

### Shared Conformance Suite (`tests/stores/conformance.mjs`)

One suite, run against every adapter:

| Test | What it validates |
|---|---|
| `init()` returns boolean | Lifecycle contract |
| `upsertRepo()` returns a string id or null | Repo contract |
| `getRepoByFingerprint()` round-trips an upserted repo | Roundtrip |
| `upsertDebtEntries()` + `readDebtEntries()` roundtrip | Debt CRUD |
| Query with `repoId=A` doesn't return rows from repoId=B | Scoping |
| Methods not in capabilities return `{supported: false}` envelope | Capability contract |
| Transient-failure returns `{ok: false, reason: 'transient'}` (tested via mocked unreachable) | Failure-mode contract |
| `unwrapOrDefault()` returns default on !ok and !supported | Helper contract |
| Invalid `repoId` (non-string, empty) rejected via shared schema (non-empty opaque string; UUID/slug-specific validation lives in adapter-specific tests per §2.5) | Boundary validation |
| Duplicate `upsertDebtEntries()` idempotent | Idempotency |

### Adapter-Specific Tests

**noop**:
- Routes debt calls to `lib/debt-ledger.mjs` correctly
- Synthetic repoId is deterministic from fingerprint
- Non-capability methods return null/empty without error

**supabase**:
- All existing learning-store.mjs tests pass under the adapter
- Cloud disabled → degrades gracefully (existing behavior)
- `@supabase/supabase-js` missing → clear install-me error

### Adapter-Selection Tests (`tests/stores/index.test.mjs`)

- `AUDIT_STORE` unset → `noop`
- `AUDIT_STORE=supabase` + all Supabase vars → `supabase`
- `AUDIT_STORE` unset + Supabase vars set → `supabase` + deprecation notice logged once
- `AUDIT_STORE=supabase` + missing `SUPABASE_AUDIT_ANON_KEY` → exit 1 with clear error
- `AUDIT_STORE=garbage` → exit 1 with list of valid values
- `AUDIT_STORE=noop` → noop adapter, ignores Supabase vars

### Zero-Behavior-Change Integration Test

**Critical gate for G.1 shipping**: run the complete pre-G.1 test suite with `AUDIT_STORE=supabase` explicitly set. Every pre-G.1 test must pass without modifications. Captures regression from the refactor.

---

## 5. Rollback Strategy

- **Revert G.1**: git revert the facade commit + adapter extractions. `scripts/learning-store.mjs` restored, no adapter concept. Existing Supabase users unaffected.
- **Per-caller rollback**: any caller that broke due to deprecated-method renames can call the deprecation-wrapper names. They still work.
- **Data rollback**: no schema changes, no data migrated. Safe.

---

## 6. Implementation Order

1. **`stores/interfaces.mjs`** — document the 5 interfaces with JSDoc. No runtime code.
2. **`stores/schemas-store.mjs`** — Zod schemas for boundary validation. Tests.
3. **`tests/stores/conformance.mjs`** — shared conformance suite, parametrized on adapter. Failing tests initially (no adapters yet).
4. **`stores/noop-store.mjs`** — implement, delegating debt to `lib/debt-ledger.mjs`. Conformance tests pass.
5. **`stores/supabase-store.mjs`** — extracted byte-faithful from `learning-store.mjs`, methods grouped under capability sub-objects. Existing tests pass.
6. **`stores/index.mjs`** — `pickAdapter()` with fail-fast + auto-detect. Tests.
7. **`scripts/learning-store.mjs` refactor** — thin facade. Backward-compat wrappers for deprecated names.
8. **`package.json`** — `@supabase/supabase-js` → `optionalDependencies`.
9. **`.env.example`** — document `AUDIT_STORE` + adapter env vars.
10. **Zero-behavior-change integration test** — run full suite with `AUDIT_STORE=supabase`, verify all pre-G.1 tests pass.
11. **Conformance suite** — runs both noop + supabase, all tests pass.
12. **Commit + push G.1.**

---

## 7. Known Limitations (accepted for G.1)

1. **noop adapter doesn't support run/globalState** — learningState IS supported (§2.7 wraps existing local files). Run history + global prompt state have no prior local implementation, deferred to sqlite (G.2). noop users lose cross-session audit-run history. Acceptable: they can opt into sqlite/supabase when those ship.
2. **Interface splits are capability-flag-based** — allows adapters to be partial without stronger typing. TypeScript would enforce this better, but the project is JS.
3. **Data-scoping enforcement is per-adapter** — facade passes repoId, adapter MUST apply the filter. If an adapter bug causes cross-repo leak, it's caught by conformance tests but not at the facade level.
4. **`lib/debt-ledger.mjs` stays callable directly** — avoids a big API migration for Phase D callers. Consolidation is future work.
5. **Deprecation wrappers live through G.1/G.2/G.3** — cleanup happens post-G.3.
6. **Schema evolution** — G.1 preserves the current Supabase schema. No new columns, no renames. Future phases will address schema versioning across adapters.
7. **Legacy-API transient-failure ambiguity (G1-R3-H1)**: callers using legacy return shapes (§2.0) cannot distinguish "cloud down, data buffered" from "legitimately empty". Envelope API is opt-in. For G.1, we accept this because the alternative — forcing migration of all Phase D callers to envelopes — is disproportionate to the risk. **Mitigation**: loud stderr warning on init-unreachable; buffered-outbox log on every write during disconnection. Callers that need precise failure signals can opt into `learningStore.envelope.*`. Future phase may migrate Phase D callers en masse.
8. **Profile-fingerprint drift as repo identity (G1-R3-H2)**: `repoId` is derived from `sha256(repoProfile)`, which depends on the stack profile output. If the profile detector evolves (e.g., new frameworks detected), the fingerprint for an existing repo could shift and produce a new `repoId`, orphaning prior data. **Mitigation**: G.1 adds `.audit/repo-identity.json` (committed, gitignored-safe) holding the first computed `repoId` — subsequent runs read from this file and skip profile-based derivation. Deleting the file triggers re-derivation (documented recovery path). Adapter `getRepoByFingerprint` also accepts historical fingerprints via an optional `aliases` column (supabase schema add), populated lazily when drift is detected. Full resolution (deterministic content-addressable key that never drifts) deferred to G.2 when SQL backends stabilize the schema.
9. **Outbox replay causality (G1-R3-H4)**: the outbox replays operations independently per-record; causally-linked operations (`upsertRepo` → `recordRunStart` → `recordFindings`) may partially-succeed during replay. **Mitigation**: all IDs are client-generated (§2.5), so parent rows can be re-created idempotently from the journal even if they were never round-tripped the first time. Dependent-order replay (parent rows first) is out of scope for G.1's best-effort outbox; strict causal ordering with retry classification is a future follow-up when multi-writer scenarios appear.
10. **Module-global `_adapter` singleton (G1-R3-M2)**: facade holds a single adapter instance per process. Testability suffers for parallel cross-adapter tests. **Mitigation**: conformance suite creates fresh adapter instances directly (bypassing facade singleton); facade-level tests reset via an explicit `__resetForTest()` export. Full dependency-injection refactor (`createLearningStore({env, cwd, ...})`) deferred — the CLI entry-points are single-adapter-per-run in practice.

---

## 8. Resolved Design Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| Q1 | One interface or split by concern? | **5 split interfaces** (DebtStore, RunStore, etc.) | Adapters can be partial; interface segregation principle |
| Q2 | Silent noop fallback on broken config? | **Fail-fast** on explicit `AUDIT_STORE` with missing vars | Silent degradation loses data without telling operator |
| Q3 | Where does debt data flow? | **Through adapter's DebtStore interface** exclusively | Single ownership path, no split brain |
| Q4 | Does noop support debt? | **Yes** — wraps `lib/debt-ledger.mjs` | Phase D already file-based, don't regress it |
| Q5 | Are adapter methods optional? | **Yes, declared via capabilities flags** | Not every adapter supports every concern |
| Q6 | How is data scoped? | **Facade passes explicit `repoId`**, adapter filters at backend | Single enforcement point, per-entity policy |
| Q7 | Backward compat for existing Supabase users? | **Auto-detect legacy env vars** + one-time deprecation notice | Zero friction for current users |
| Q8 | `@supabase/supabase-js` required for noop users? | **No** — moved to `optionalDependencies` | Keep install lightweight for the common case |
| Q9 | Does `lib/debt-ledger.mjs` get replaced? | **No** — stays as the file-based implementation | Avoids API migration; consolidation is future |
| Q10 | Zero-behavior-change gate? | **Full pre-G.1 test suite passes with `AUDIT_STORE=supabase`** | Safest refactor validation |
| Q11 | How do callers tell unsupported-capability from transient-failure from empty-data? | **Discriminated envelope** `{ok, supported, reason?, data?}` + `unwrap*()` helpers | Avoid silent misinterpretation of noop returns |
