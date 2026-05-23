# Plan: Architectural Memory

- **Date**: 2026-05-01 (revised post-R1 + R2 + R3 + Gemini ×2 audit cycle)
- **Status**: Complete (shipped — master plan; 6 tables live (symbol_index/definitions/embeddings/file_imports/layering_violations/refresh_runs), 10 scripts under `scripts/symbol-index/`, RPCs `get-neighbourhood` / `get-incident-neighbourhood` / `list-symbols-for-snapshot` / `get-active-refresh-id` / `compute-target-domains` all in `scripts/cross-skill.mjs`. Status line corrected 2026-05-23.)
- **Author**: Claude + Louis
- **Composed from**:
  - [architectural-memory-backend.md](./architectural-memory-backend.md) — earlier backend draft (file-level detail)
  - [architectural-memory-frontend.md](./architectural-memory-frontend.md) — earlier rendered-surface draft (wireframes, state map, Mermaid conventions)
- **Status of child plans** (responding to R2 ambiguity #1): the child
  plans (`architectural-memory-backend.md`, `architectural-memory-frontend.md`)
  are pre-R1 drafts kept for reference of wireframes and per-file
  enumeration only. **This merged file is the single canonical
  artefact for implementation.** Phase A of rollout (§8) explicitly
  archives the child plans to `docs/plans/archive/architectural-memory-{backend,frontend}.md`
  with a one-line stub left in their original location pointing here.
  Where this file diverges from the children — and it does extensively
  in §1 sensitivity model, §2 (snapshot, identity, refresh modes,
  failure matrix, retention, egress gate), §3 (query path), §5
  (file plan, contracts), §6 (R11–R17), §9 (R2-fix coverage) — this
  file wins. There is no "implementation-time reconciliation" — children
  are frozen.

This merged document is the **audit target** for `/audit-plan`. It contains
the synthesis: executive view, cross-cutting decisions, full file-level
plan, the unified risk register, the unified failure matrix, the data and
presentation contracts, and the combined Section 9 acceptance criteria.

---

## 0. Pre-implementation verifications

Audit findings about specific library behavior are claims, not facts. Each
load-bearing claim from R1+ rounds gets a runnable verification step the
implementer must execute before writing the code that depends on it. The
verification's *output* — not the audit's *assertion* — is what the design
rests on.

| ID | Verifies | Command | Resolution date | Result |
|---|---|---|---|---|
| **S1** | Gemini-R2 G2: `dependency-cruiser` does NOT extract intra-file symbols; need `ts-morph` for that | `node scripts/symbol-index/spike-extract.mjs scripts/openai-audit.mjs` | 2026-05-01 | **VERIFIED**. ts-morph extracted 17 intra-file symbols with line ranges + body text + export flags. dep-cruiser emitted 45 module records with `{source, dependencies, dependents, orphan, valid}` keys only — no symbol-level fields. Plan's split (ts-morph for symbols, dep-cruiser for graph) confirmed. Spike script preserved at `scripts/symbol-index/spike-extract.mjs` for re-run on dep upgrade. |
| **S2** | The `publish_refresh_run` RPC actually runs as one Postgres transaction | (Phase A acceptance test — apply migration, simulate failure inside RPC, verify both updates rolled back together) | TBD (Phase A) | Pending |
| **S3** | `text-embedding-004` (or whatever sentinel resolves to) is reachable + returns 768-dim vectors | `node scripts/symbol-index/spike-embed.mjs` (one-shot — to be written in Phase A) | TBD (Phase A) | Pending |
| **S4** | pgvector extension is enable-able on the target Supabase project | `supabase db reset && supabase migration up` on a dev project | TBD (Phase A) | Pending |

**Pattern**: any future audit finding tagged "library behavior" or "schema
assumption" gets an S-row here with a 5-minute spike. The spike output
goes in the `Result` column, replacing the auditor's claim as the source
of truth. Plan changes that depend on the verification cite the S-id
inline (e.g. "per S1 result").

---

## Executive summary

**Problem** — `claude-audit-loop` audits diffs by default, so cross-file
architectural drift (duplicate functions, layering violations, divergent
naming) is invisible at the moment when it's cheapest to prevent: plan time.

**Solution** — Persist a per-repo **symbol index** in Supabase (with
pgvector embeddings + LLM-derived purpose summaries), consult it inside
`/plan-backend` and `/plan-frontend` before the planner proposes new
code, and run a weekly drift sweep that surfaces clusters and layering
violations as a sticky GH issue. A committed `docs/architecture-map.md`
with Mermaid diagrams gives humans a parallel view of what the AI sees.

**Why now** — The data-loop infrastructure landed in Phase 4 (cross-skill
tables, persona ↔ audit correlations). This is the natural next layer:
codebase-state memory that planning consults and that drives a periodic
"is the architecture decaying?" gate.

**What's reused** — Migration / RPC / sticky-issue patterns from
`memory-health`; CLI facade pattern from `cross-skill.mjs`; sentinel
model resolution from `model-resolver.mjs`; atomic writes from
`file-io.mjs`; Node test runner; existing `audit_repos` row resolution.

**What's new** — `dependency-cruiser` extraction; pgvector storage
(versioned via child table); snapshot-publication refresh model;
`getNeighbourhood` consultation API with explicit query-embedding layer;
rendered `architecture-map.md` artifact; drift-sweep workflow; `/ship`
advisory integration.

**Key R1 audit responses (HIGH/MEDIUM)** — see §10 for the per-finding
mapping. Major shape changes:
- Snapshot publication via `refresh_runs` + `active_refresh_id` (H1)
- Explicit refresh modes with file-level inventory (H2)
- Dedicated query-embedding module `scripts/lib/neighbourhood-query.mjs` (H3)
- `/ship` advisory integration via `skills/ship/SKILL.md` change (H4)
- Service-role writes + threat model documented; per-repo RLS predicates as Phase F (H5)
- `scripts/lib/repo-identity.mjs` resolves stable `repo_id` (H6)
- `signature_hash` composes name + signature + body checksum (M1)
- Per-surface failure matrix in §2 (M2)
- Zod data/presentation contracts in §5 (M3)
- Versioned `symbol_embeddings` child table — no destructive drops (M4)

---

## Path-convention note (responding to /audit-code R2 H2)

Several earlier plan sections refer to modules under `lib/*` (e.g.
`lib/symbol-index-contracts.mjs`). These are implemented under
`scripts/lib/*` in the actual codebase to match the pre-existing
project convention (where every `scripts/lib/*.mjs` lives — see
`scripts/lib/model-resolver.mjs`, `scripts/lib/file-io.mjs`, etc.).
Treat any unqualified `lib/*` reference in this document as
`scripts/lib/*`. The convention is enforced by the existing
`scripts/lib/` directory; new architectural-memory modules follow it.

---

## 1. Context Summary

### What exists today (cross-cutting Phase 1 findings)

- **Cross-skill writer pattern**: `scripts/cross-skill.mjs` already
  hosts `record-*` / `list-*` / `get-*` subcommands. Add three more.
- **Migration style**: idempotent (`CREATE ... IF NOT EXISTS`,
  `ALTER ... IF NOT EXISTS`), RLS enabled with anon-permissive policies.
  pg_trgm already enabled; pgvector is new.
- **Existing repo identity**: `audit_repos` table already keys on `name`
  (used by `cross_skill` queries — see `learning-store.mjs`). We extend
  this with a stable, deterministic `repo_uuid` so refreshes performed
  from forks/clones still resolve to the same logical repo.
- **Weekly trigger pattern**: memory-health workflow + sticky issue +
  auto-close is the proven shape; mirror exactly with new label
  `architectural-drift` and marker `<!-- audit-loop:architectural-drift -->`.
  Mirroring includes: same gh-api search-by-marker, same auto-close
  guard ("only close if last comment was workflow's"), same artefact
  upload, same workflow-dispatch input, same exit-code semantics
  (0=green, 1=triggered, 2=infra-error).
- **Model resolution**: `resolveModel(sentinel)` everywhere; new env
  vars route through `config.mjs`.
- **Skill structure**: `.md` SKILL files with phase-numbered flow + a
  references-table footer. Plan skills already shell out to
  `cross-skill.mjs` (e.g. `detect-stack`).
- **Test runner**: `node --test`, fixtures in `tests/*.test.mjs`.
- **Static analysis**: `lib/code-analysis.mjs` builds dep graphs in-process
  but doesn't persist — we don't replace it; we add a persistence layer.
- **No traditional UI**: human surfaces are committed Markdown +
  Mermaid + GH issue bodies.
- **Existing /ship skill**: lives in `skills/ship/SKILL.md`. Already
  has a "Step 0.5b" pattern for cross-skill checks (unlocked-fixes).
  Adding an advisory `arch:refresh` + `arch:render` step there is the
  natural integration point.

### Patterns we reuse

| Need | Reused from |
|---|---|
| Cross-skill writer | `scripts/cross-skill.mjs` (parsePayload, isCloudEnabled, emit JSON) |
| Migration shape | `20260421163525_memory_health.sql` |
| Weekly trigger | `.github/workflows/memory-health.yml` (full mirror — see §1 above) |
| Model selection | `scripts/lib/model-resolver.mjs` sentinels |
| Atomic writes | `atomicWriteFileSync` in `scripts/lib/file-io.mjs` |
| Skill→CLI | `cross-skill.mjs detect-stack` (existing prior art) |
| Sticky issue UX | memory-health marker + auto-close guard |
| Status-badge report | memory-health markdown structure |
| Per-repo identity | `audit_repos` table (extended with `repo_uuid`) |

### Sensitivity & access model (responding to H5)

`symbol_index` stores file paths, signatures, LLM-generated purpose
summaries, and embeddings of code identity. This is **materially more
sensitive** than memory-health's anonymous metric counts. Threat model:

| Actor | What they can do | What they should not |
|---|---|---|
| Trusted developer (holds anon key) | Read own repo's symbol_index | Read other repos in same Supabase project |
| Trusted developer (holds service-role key) | Refresh own repo's symbol_index | Refresh other repos in same project |
| Anon-key leak | Limited to read-only | Cannot write, cannot poison the index |
| Untrusted reader of public docs | Read `docs/architecture-map.md` (intentionally public) | Read raw embeddings, raw summaries |

**v1 hardening (in scope)**:
1. **Writes require service role — no fallback** (responding to R2 H10).
   New env var `SUPABASE_AUDIT_SERVICE_ROLE_KEY`. `scripts/cross-skill.mjs`
   exposes two distinct client factories — `getReadClient()` (anon) and
   `getWriteClient()` (service-role). `getWriteClient()` hard-fails with
   typed error `SERVICE_ROLE_REQUIRED` if `SUPABASE_AUDIT_SERVICE_ROLE_KEY`
   is absent. **No anon-write fallback exists in any code path.** Local
   developers needing refresh capability set the service-role key in
   their local `.env`; the weekly drift workflow gets it from GH secret.
2. **Anon policy is read-only** for `symbol_index`,
   `symbol_layering_violations`, `symbol_definitions`, `symbol_embeddings`,
   and `refresh_runs` — `FOR SELECT USING (true)`, no `FOR INSERT/UPDATE/DELETE`.
3. **Per-repo predicate RLS deferred to Phase F** — anon users of a
   shared Supabase project can still read sibling repos' indices.
   v1 ships under the assumption that each developer uses their own
   Supabase project (matches the documented `SUPABASE_AUDIT_*` setup
   in `AGENTS.md`); shared-project hardening is captured as Phase F
   below with explicit follow-up acceptance.

### What's new

- `symbol_definitions` table — **stable per-repo logical symbol identity** (R2 H7) keyed on `(repo_id, canonical_path, symbol_name, kind)`. Survives across refreshes; embeddings + cross-snapshot history attach here.
- `symbol_index` table + `symbol_layering_violations` — snapshot-scoped via `refresh_id`. `symbol_index` rows reference `symbol_definitions(id)` via `definition_id` FK.
- `symbol_embeddings` versioned child table keyed on `(definition_id, embedding_model, dimension)` with **paired pointers `(active_embedding_model, active_embedding_dim)` on `audit_repos`** (responding to R3 H7 — both halves of the contract must be persisted together). Embedding survives across refreshes when its definition does.
- `refresh_runs` table + per-repo `active_refresh_id` snapshot pointer (snapshot-isolation for readers).
- **AST-based symbol extraction via `ts-morph`** (`@ts-morph/bootstrap` for the lightweight surface; new npm dep) — extracts intra-file function/class/component/hook symbols with `body_text`, `start_line`, `end_line`. JS/TS only in v1. (Responding to Gemini-R2 G2: `dependency-cruiser` is a module-graph tool and does NOT parse intra-file symbols — that was a fundamental tool mismatch in earlier drafts.)
- **`dependency-cruiser` for module-edge graph + layering rules** — populates `symbol_layering_violations` (file-to-file relationships only). Does NOT do symbol extraction. JS/TS only in v1.
- LLM purpose summarisation (Haiku) + embedding (Gemini text-embedding-004),
  signature-hash cached so steady-state cost is ~zero.
- `getNeighbourhood` Postgres RPC (combines hop-graph + cosine), driven
  through a dedicated `neighbourhood-query.mjs` orchestrator that owns
  description→embedding conversion and the `{result, usage, latencyMs}`
  contract.
- `repo-identity.mjs` — derives + persists a stable `repo_uuid`.
- `scripts/lib/arch-render.mjs` — pure renderers shared by all three
  human surfaces.
- `scripts/lib/symbol-index-contracts.mjs` — Zod schemas for the data
  layer and the presentation layer.
- `docs/architecture-map.md` — committed, regenerated on `/ship`.
- `.github/workflows/architectural-drift.yml` — weekly sweep.
- `skills/ship/SKILL.md` — advisory `arch:refresh` + `arch:render` step.

### Known user-visible issues

`PERSONA_TEST_REPO_NAME` is unset for `claude-audit-loop` itself (this
repo is the tooling, not a consumer app). No persona sessions to
consult. Skipping the persona pre-step.

---

## 2. Phase 1.5 — Execution Model

### Stable symbol identity (responding to R2 H7)

R1 fixed snapshot isolation by scoping `symbol_index` rows under `refresh_id`,
but that left **embeddings and cross-snapshot history with no stable anchor**.
Fix: a `symbol_definitions` table keyed per-repo on the logical identity:

```
symbol_definitions(
  id              UUID PK,
  repo_id         UUID FK → audit_repos(id),
  canonical_path  TEXT,        -- repo-relative, normalised
  symbol_name     TEXT,
  kind            TEXT,
  first_seen_at   TIMESTAMPTZ,
  last_seen_at    TIMESTAMPTZ,
  archived_at     TIMESTAMPTZ NULL,  -- soft-delete when symbol vanishes for ≥1 weekly cycle
  UNIQUE (repo_id, canonical_path, symbol_name, kind)
)
```

**Identity rules**:
- Same `(repo_id, canonical_path, symbol_name, kind)` across refreshes → same `definition_id`.
- File rename via `git mv` → identity preserved if `git diff --name-status` reports `R` and `symbol_name`+`kind` match (the rename is recognised at the refresh's incremental processing step; new `canonical_path` is written, definition_id unchanged).
- Symbol rename within same file (different `symbol_name`) → new `definition_id` (distinct logical symbol).
- File deletion → `last_seen_at` not updated this run; archived after one full refresh confirms absence.

`symbol_index.definition_id FK` connects each snapshot row to its stable
identity. `symbol_embeddings(definition_id, model, dim)` attach to identity,
not snapshot. Copy-forward of untouched files preserves both `definition_id`
and `refresh_id` ↔ `definition_id` mapping unchanged.

### Repository identity (responding to H6)

Every API and table key depends on a stable `repo_id`. Resolution lives
in `scripts/lib/repo-identity.mjs`:

```
resolveRepoIdentity(cwd) →  { repoUuid, name, remoteUrl, source }
```

1. Read `.audit-loop/repo-id` (committed file) → use as `repoUuid` if present.
2. Else compute deterministic UUIDv5 from **canonicalised git `origin` remote URL only** —
   write to `.audit-loop/repo-id`. (Responding to R3 H6: top-level path is excluded
   from the hash because two clones of the same remote MUST resolve to the same
   `repoUuid` per the acceptance criteria. Path is recorded for diagnostics, not identity.)
3. `name` derives from the canonicalised remote (`owner/repo`).
4. The committed `.audit-loop/repo-id` survives renames and clones; consumers
   commit it once on first refresh. Forks (different `origin` URL) get a new id
   (correct, by design — fork should have its own architectural memory).
5. **Bootstrap race**: when neither `.audit-loop/repo-id` nor canonical
   `origin` URL is available (e.g. local-only repo with no remote), fall back
   to UUIDv5 from the absolute repo path AND log a stderr warning that this
   id won't survive moving the repo. Acceptance criteria amended accordingly.

The same module is imported by every script, skill consumer, workflow,
and RPC client — no script computes `repo_id` independently.

`audit_repos` is extended with a `repo_uuid TEXT` column (additive,
nullable for backfill; populated by `resolveRepoIdentity` on next access).
All new tables in this plan (`symbol_index`, `symbol_embeddings`,
`refresh_runs`, `symbol_layering_violations`) use the existing
`audit_repos.id UUID` foreign key, with the bridge from `repo_uuid`
(stable) to `audit_repos.id` (DB-internal) handled in `learning-store.mjs`.

### Snapshot publication model (responding to H1)

Refresh writes are isolated from readers via `refresh_runs` + per-repo
`active_refresh_id`:

```
┌─────────────────────────────────────────────────────────────────┐
│ refresh_runs                                                     │
│   id (UUID PK), repo_id (FK), mode (full|incremental),           │
│   started_at, completed_at, status (running|published|aborted),  │
│   walk_start_commit, walk_end_commit, files_processed (jsonb),   │
│   files_added/modified/deleted/renamed (jsonb), llm_calls (int), │
│   embed_calls (int), error (text)                                │
│                                                                  │
│ audit_repos: ALTER TABLE … ADD COLUMN active_refresh_id UUID      │
│                                                                  │
│ symbol_index.refresh_id (FK → refresh_runs.id)                    │
└─────────────────────────────────────────────────────────────────┘
```

**Write path**:
1. `refresh.mjs` opens a `refresh_runs` row with `status='running'`.
2. All upserts during the run carry `refresh_id = <new id>`.
3. On success: `UPDATE audit_repos SET active_refresh_id = <new id>`
   in a single transaction with `UPDATE refresh_runs SET status='published', completed_at=now()`.
4. Stale-row archival is deferred to publish step (see Refresh modes below).
5. On failure: `UPDATE refresh_runs SET status='aborted', error=…` —
   `active_refresh_id` is unchanged; readers continue seeing the previous snapshot.

**Read path** (all reader RPCs and CLI tools):
1. Query `audit_repos.active_refresh_id` → the published snapshot.
2. `symbol_index` queries always filter `WHERE refresh_id = <active>`.
3. `symbol_neighbourhood` and `drift_score` RPCs accept the resolved
   `active_refresh_id` as a parameter to avoid TOCTOU.

### Snapshot retention (responding to R2 M5)

Published snapshots accumulate. Without retention, storage and
`symbol_embeddings` grow monotonically. v1 ships with explicit policy:

| Snapshot class | Retention |
|---|---|
| Active snapshot (`audit_repos.active_refresh_id`) | Forever (until superseded) |
| Last 4 published snapshots per repo | Always retained (rollback window) |
| Weekly checkpoints | One per ISO week, retained 90 days |
| Other published snapshots | Pruned after 30 days |
| Aborted/failed runs | Pruned after 7 days |
| `symbol_definitions` archived ≥30 days AND no remaining snapshot reference | Pruned with cascading `symbol_embeddings` |

`refresh_runs` gains a `retention_class` column (`active` / `rollback` /
`weekly_checkpoint` / `transient` / `aborted`) populated at publish time
from the policy table above. Pruning queries that column, never the
timestamp directly — keeps policy logic in one place.

**Pruning is scheduled, not manual** (responding to R2 M5). The same
`.github/workflows/architectural-drift.yml` workflow runs prune as a
follow-up step after the drift sweep (single workflow, two jobs sharing
the same secret). Prune is transactional per snapshot: delete
snapshot-scoped `symbol_index` and `symbol_layering_violations` rows
first, then the `refresh_runs` row, in a single transaction.
`symbol_definitions` and their `symbol_embeddings` survive across
snapshot prune cycles.

`npm run arch:prune` is the manual entrypoint (still ships) but is no
longer the only path. Acceptance criteria added in §9.

### Sensitive content egress gate (responding to R2 H11)

**Hard project rule** (per `AGENTS.md` "Do NOT" list): `.env` and
credential files MUST NEVER be sent to external APIs. v1 enforces this
with a centralised gate in `scripts/lib/sensitive-egress-gate.mjs`,
which extends the existing `scripts/lib/secret-patterns.mjs` rather than
duplicating its patterns. The gate runs **twice** in defence-in-depth:

1. In `extract.mjs`, **before any body-text capture** (path filter).
2. In `summarise.mjs` and `embed.mjs`, **before any provider call**
   (content scrub). Even if path filter is misconfigured, content scrub
   is a backstop.

**Path denylist** (always blocked from extraction):
- `.env`, `.env.*` (any extension or suffix variant)
- `**/secrets/**`, `**/credentials*`, `**/private/**`
- `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.crt`, `*.cer`, `*.der`
- `id_rsa*`, `*.gpg`, `*.asc`
- `*.lock`, `*-lock.json`, `*.lockb` (no useful symbols, large noise)
- Anything matched by repo's `.gitignore`

**Allowlist** (only these extensions are summarised + embedded):
`.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.vue`, `.svelte`. Other
extensions can be path-indexed for layering checks but their bodies are
**never** sent to providers — `purpose_summary` stays NULL, embedding skipped.

**Content heuristic** (applied to body text before any LLM call):
- Reuse `scripts/lib/secret-patterns.mjs` patterns (already covers AWS
  keys, Stripe keys, JWT, GitHub tokens, etc.).
- If any pattern matches: symbol is recorded with
  `purpose_summary = '[SECRET_REDACTED]'`, embedding skipped, but the
  symbol still appears in the index for layering/duplication checks
  (path + name + signature). No body content leaves the machine.

**Outbound payload logging**: any debug/trace output of LLM payloads goes
through `redactSecrets(payload)` from the same module. Stderr never
echoes raw body content; only counts + hashes.

**Acceptance gate**: P0 tests in §9 prove blocked paths produce no
provider call and that secret-bearing bodies don't appear in any
outbound payload.

### Refresh modes (responding to H2)

Two modes are explicit, never blended:

| Mode | When | What it scans | Stale handling | Cost |
|---|---|---|---|---|
| **full** (`--full`) | First run, weekly action, after schema change | All files | All symbols not present in this run are archived at publish | Highest (LLM + embed every cache-miss) |
| **incremental** (`--since-commit <sha>` or default with cached `walk_end_commit`) | `/ship` (which runs **before** the commit is created), ad-hoc | Files reported by `git diff --name-status <sha>` (note: NO `..HEAD` — see Gemini G1 fix below) UNION `git ls-files --others --exclude-standard` (untracked); status set is A/M/D/R/U where U = untracked-now-included | Per-file: deleted files → all symbols archived in publish; renamed files → archive at old path, re-extract at new; modified files → re-extract, archive missing symbols within those files only; untracked-now-included → treated as added; untouched files → kept verbatim from prior snapshot | Low (cache hits dominate) |

**Working-tree visibility (responding to Gemini G1)**: `/ship` invokes
`arch:refresh --since-commit <last-shipped>` *before* the commit is
created — so the user's edits live in the working tree + staging area,
not in `HEAD`. Using `git diff --name-status <since>..HEAD` would
produce an empty diff and silently miss every change `/ship` is about
to commit. The plan therefore uses `git diff --name-status <since>`
(diffing the working tree against `<since>`, NOT against HEAD) and
unions in `git ls-files --others --exclude-standard` for untracked
files. Acceptance criterion added in §9.

**Critical**: incremental mode never archives by `last_seen_commit` alone.
Stale detection is scoped to the affected file set. Untouched files are
copied forward into the new `refresh_id` snapshot via a single bulk
`INSERT ... SELECT` so the snapshot is self-contained.

This makes the snapshot publication model O(changed files) for the
common case and O(repo) only for full refresh.

**Graph-derived artifacts always recompute (responding to R2 H8).**
`symbol_layering_violations` and the dependency graph used by
`drift_score` are recomputed from the FULL repo on every refresh,
regardless of mode. Justification: dep-cruiser walks the full graph
naturally (it must, to follow imports), and a touched file can introduce
a violation against an untouched file. Per-edge incrementalism is
out-of-scope for v1 — it's a measurable extra layer of complexity for
marginal gain (graph walk on a 1000-symbol repo takes <2s in
dep-cruiser benchmarks). This means incremental refresh saves on LLM +
embed calls, not on graph traversal. Documented and acceptance-tested.

### Failure matrix (responding to M2)

Every command and surface has a defined failure mode:

| Command/surface | Cloud off (no Supabase env) | RPC error | Embedding provider 5xx/429 | LLM provider 5xx/429 | Validation error | Partial batch failure | Workflow infra error | Service-role missing |
|---|---|---|---|---|---|---|---|---|
| `npm run arch:refresh` | Exit 0 with stderr `architectural-memory: cloud disabled — skipping refresh`; no DB writes | Exit 2; refresh_run marked aborted; active snapshot unchanged | Retry batch up to 3× with backoff; persistent 5xx → batch marked failed in refresh_run; partial publish allowed only for cache-hit symbols (no embedding gap) | Same retry semantics; persistent failure → batch's symbols left with `purpose_summary IS NULL` in next snapshot | Per-symbol skip with stderr warning; refresh proceeds | Batch transaction rolls back; refresh_run logs `files_failed`; next refresh retries those files | Workflow exit 1 (CI marks failure) | **Hard fail with code `SERVICE_ROLE_REQUIRED`**, exit 2; stderr explains how to set `SUPABASE_AUDIT_SERVICE_ROLE_KEY`. No anon-write fallback exists. |
| `npm run arch:render` | Exit 0 with stderr `cloud disabled — leaving docs/architecture-map.md unchanged` | Exit 2; file unchanged | N/A (render doesn't call embeddings) | N/A | Exit 1; file unchanged | N/A (single read query) | N/A | N/A (read-only) |
| `npm run arch:drift` | Exit 0; no report | Exit 2 (matches memory-health) | N/A | N/A | Exit 2 | N/A | Workflow exit 1 | N/A (read-only) |
| `cross-skill.mjs get-neighbourhood` | Emit `{ok:true, cloud:false, records:[], hint:"…"}`, exit 0 | Emit `{ok:false, error:{code:"RPC_ERROR", message:…}}`, exit 2 | Emit `{ok:false, error:{code:"EMBED_FAILED", retryable:true\|false, providerStatus:N, activeModel:"…", activeDim:N}}`, exit 2 | (only used by summarise/embed CLIs) | Emit `{ok:false, error:{code:"BAD_INPUT", issues:[…]}}`, exit 2 | N/A (single read) | N/A | N/A (read-only) |
| `cross-skill.mjs get-neighbourhood` — **embedding-model mismatch** (R2 H9) | (n/a) | (n/a) | Emit `{ok:false, error:{code:"EMBEDDING_MISMATCH", expected:{model,dim}, available:[…]}}`, exit 2 | (n/a) | (n/a) | (n/a) | (n/a) | (n/a) |
| `/plan-backend`, `/plan-frontend` consultation step | **Fail open**: emit cloud-off callout; plan continues with no neighbourhood context | **Fail open**: emit RPC-error callout `_consultation failed: <code>; plan proceeds without architectural context_`; plan continues | **Fail open**: same callout with `code=EMBED_FAILED` (or `EMBEDDING_MISMATCH` per row above) | (n/a — query embedding falls under EMBED_FAILED) | **Fail closed**: surface error to user, abort plan generation | N/A | N/A | N/A (read-only) |
| `/audit-code --scope=full` symbol catalogue | Skip section silently (existing audit behaviour preserved) | Skip section, log warning | Skip section, log warning | (audit prompt embedding is its own concern; not affected here) | Skip section, log warning | N/A | N/A | N/A (read-only) |
| `/ship` advisory step | Skip step silently (existing /ship behaviour preserved) | Print warning, allow ship to continue | Print warning, allow ship to continue | (n/a) | Print warning, allow ship to continue | N/A | N/A | Print warning explaining how to enable refresh; ship continues |
| Drift workflow sticky issue | Workflow's existing secrets-check skips with `::warning::` | Exit 2 → workflow fails | (n/a — drift uses RPC only) | (n/a) | Exit 2 → workflow fails | N/A | Workflow exit 1 |

**Rule**: `/plan-*` and `/audit-code` always **fail open** for the
neighbourhood/catalogue feature — the original tool behaviour must
survive any architectural-memory failure. `/ship` is also fail-open
(advisory). Refresh CLI **fails loud** so refreshes that silently broke
are visible.

### Sequencing rule (LOAD-BEARING, refined)

`refresh.mjs` must:
1. Resolve `repo_id` via `repo-identity.mjs`.
2. Open a `refresh_runs` row (mode, walk_start_commit). Capture `refresh_id`.
3. For incremental: enumerate `git diff --name-status <since>` (NO `..HEAD` — per Gemini G1 fix) UNION `git ls-files --others --exclude-standard` into `files_added/modified/deleted/renamed/untracked`. (Step intentionally aligned with the Refresh-Modes section above — earlier draft inconsistency was Gemini-R2 G5.)
4. Process each file set per the rules in "Refresh modes" above; all
   upserts use the captured `refresh_id`.
5. Bulk-copy untouched-file symbols from the prior snapshot:
   `INSERT ... SELECT FROM symbol_index WHERE refresh_id = <prior>`
   (filter out files in the touched set).
6. On success: atomically promote `audit_repos.active_refresh_id = <new>`
   AND set `refresh_runs.status='published'` in the same transaction.
7. On failure mid-way: leave `active_refresh_id` untouched; mark the
   run aborted; log to stderr.

Readers never see partial state because they always go through
`active_refresh_id`.

### Concurrency model

- Symbol extraction is single-threaded (dep-cruiser is a single process).
- LLM batching: parallel up to `ARCH_INDEX_LLM_CONCURRENCY` (default 4).
- Embedding batching: parallel up to same concurrency.
- Per-skill consultation (`getNeighbourhood`) is a single read query.
- Two refreshes against the same repo: one wins the `refresh_runs`
  insert via a unique `(repo_id, status='running')` partial-unique
  index; the other exits with `REFRESH_IN_FLIGHT` and the operator
  is told to wait or pass `--force`.
- **`--force` and cooperative cancellation** (responding to R3 H10):
  marking `refresh_runs.status='aborted'` is necessary but not sufficient
  — a running worker would otherwise keep writing rows under its now-
  aborted refresh_id. The cancellation contract:
  1. `--force` writes `status='aborted'` on the prior run AND records
     a `lease_owner` change in `refresh_runs.cancellation_token`.
  2. The active refresh worker checks `refresh_runs.status` (and its
     `cancellation_token`) **before each batch** and **immediately
     before publish**. If it observes `status='aborted'`, it exits
     non-zero, leaves rows under the aborted `refresh_id` orphaned
     (cleaned up by next prune), and never promotes `active_refresh_id`.
  3. `--force` then waits up to 30s for the prior worker's process
     to exit (best-effort detection via heartbeat row in `refresh_runs.last_heartbeat_at`,
     updated every batch). If the heartbeat is stale (>60s), the new
     refresh proceeds without waiting. If still active, exit with
     `REFRESH_IN_FLIGHT` and a clear stderr message.
  4. The lease + heartbeat columns are added to `refresh_runs`
     (`cancellation_token UUID`, `last_heartbeat_at TIMESTAMPTZ`).
- Workflow concurrency: `concurrency: { group: architectural-drift, cancel-in-progress: false }`
  identical to memory-health.

---

## 3. Proposed Architecture

### Cross-cutting component diagram

```
┌────────────────────────────────────────────────────────────────────┐
│  Backend pipeline                                                   │
│                                                                     │
│  refresh.mjs ──► open refresh_run (id=R)                            │
│       │                                                             │
│       ├─► repo-identity.mjs    (resolves repo_uuid → audit_repos.id) │
│       ├─► extract → summarise → embed → upsert (all rows: refresh_id=R) │
│       ├─► copy-forward untouched files from prior snapshot           │
│       └─► PROMOTE: active_refresh_id := R   (atomic)                 │
│                                                                     │
│  Supabase: symbol_index, symbol_embeddings (versioned),              │
│            symbol_layering_violations, refresh_runs                  │
│  RPCs:    drift_score(repo_id, refresh_id),                          │
│           symbol_neighbourhood(repo_id, refresh_id, target_paths,    │
│                                intent_embedding, k)                  │
└─────────────┬────────────────────────────────────────┬──────────────┘
              │                                        │
       ┌──────▼──────────┐                  ┌──────────▼──────────┐
       │  Skill consumers │                 │  Human surfaces       │
       │                  │                 │                       │
       │  /plan-backend   │◄── consults via │  docs/architecture-   │
       │  /plan-frontend  │   neighbourhood │  map.md (committed,   │
       │  /audit-code     │   -query.mjs    │  regenerated by /ship)│
       │   (--scope=full) │                 │                       │
       │  /ship           │                 │  Drift sticky GH issue│
       │   (advisory      │                 │  (weekly)             │
       │    refresh+      │                 │                       │
       │    render)       │                 │  /plan-* output       │
       │                  │                 │  "Neighbourhood       │
       │                  │                 │   considered" callout │
       └──────────────────┘                 └───────────────────────┘
```

### Query path for plan-time consultation (responding to H3)

```
/plan-backend or /plan-frontend
   │
   ▼ shells to:
node scripts/cross-skill.mjs get-neighbourhood --json '{
  "targetPaths": [...],
  "intentDescription": "<task summary>",
  "kind": ["function","component"]   // optional filter
}'
   │
   ▼ delegates to:
scripts/lib/neighbourhood-query.mjs → getNeighbourhoodForIntent({...})
   │   1. resolves repo_id via repo-identity.mjs
   │   2. resolves active_refresh_id from audit_repos
   │   3. **loads `active_embedding_model` AND `active_embedding_dim` from
   │       audit_repos** (responding to R2 H9) — NOT from config sentinel.
   │       The stored value is a CONCRETE model id (e.g., `gemini-3-flash-preview`),
   │       NEVER a sentinel string. **Sentinels are resolved at refresh
   │       time and the resolved concrete id is what gets persisted**
   │       (responding to Gemini G2 — storing `latest-flash` would silently
   │       corrupt vector space when Google flips the alias to a new
   │       backing model with a different dim, since stored embeddings
   │       and new query embeddings would live in different spaces).
   │   4. requests intent embedding using that exact (concrete model, dim)
   │       combination, via shared LLM-wrapper pattern (lib/llm-wrappers.mjs
   │       precedent). Returns {result, usage, latencyMs}.
   │   5. if no compatible active model exists OR provider is misconfigured
   │       for that exact model: emits typed error
   │       `EMBEDDING_MISMATCH {expected, available}` and the skill
   │       fail-opens at its boundary.
   │   6. validates inputs/outputs against symbol-index-contracts.mjs
   │   7. caches embedding by `sha256(intentDescription + activeModel + activeDim)`
   │       for 24h on **disk** at `.audit-loop/cache/intent-embeddings.json`
   │       (per Gemini-R2 G3 — `cross-skill.mjs` is an ephemeral CLI process
   │       spawned per /plan-* invocation, so in-memory cache would be a
   │       no-op across calls). Cache key includes model+dim so model swap
   │       invalidates cache automatically. Cache file is `.gitignore`d.
   ▼ calls:
scripts/learning-store.mjs → getNeighbourhood(repoId, refreshId, ...)
   │
   ▼ Postgres RPC:
symbol_neighbourhood(repo_id, refresh_id, target_paths,
                     intent_embedding, k)
   │
   ▼ returns scored ordered records (Zod-validated by data-contract)
   │
   ▼ neighbourhood-query.mjs renders via:
scripts/lib/arch-render.mjs → renderNeighbourhoodCallout({records, …})
   │
   ▼ cross-skill.mjs emits:
{ok:true, cloud:true, records:[…], markdown:"<callout>", refreshId:"<…>"}
   │
   ▼ skill inlines `markdown` field into plan output
```

The dedicated module owns: model resolution, embedding contract,
caching, error normalisation, cost accounting. No skill ever calls
embeddings directly. No two scripts compute query embeddings.

### Key cross-cutting decisions and principles

| # | Decision | Principles |
|---|---|---|
| 1 | Single source of truth: Supabase `symbol_index` filtered by `active_refresh_id`. All surfaces re-derive from it. | Backend #10, Frontend #29 |
| 2 | Sentinels (`latest-haiku`, `latest-flash`) for all model IDs. | Backend #8, #18 |
| 3 | All cross-skill writes through `scripts/cross-skill.mjs` (graceful no-op when Supabase off). | Backend #1, #2, #16 |
| 4 | Signature-hash composes name + normalised signature + body checksum. | Backend #17 + responds to M1 |
| 5 | RPC-side scoring (drift + neighbourhood) — not Node-side O(n²). | Backend #17 |
| 6 | Pure renderers in `lib/arch-render.mjs`; CLI scripts handle I/O. | Frontend #27, #28; Backend #11 |
| 7 | Stable ordering everywhere — drift surfaces as a noisy `architecture-map.md` diff (a feature). | Frontend #10 (Consistency), drift-as-signal |
| 8 | Sticky-issue marker `<!-- audit-loop:architectural-drift -->` + auto-close-on-green guard (full mirror of memory-health behaviour). | Frontend #11; reused from memory-health |
| 9 | Cloud-off path: planning skills emit a one-line hint and continue normally. Provider/RPC errors take the same fail-open path with a different reason code. | Backend #16; Frontend #11; responds to M2 |
| 10 | **Snapshot publication via `refresh_runs` + `active_refresh_id`**. Readers always filter on the active snapshot; writers stage rows under their own `refresh_id`. | Responds to H1 — transactional integrity |
| 11 | **Versioned `symbol_embeddings` child table** keyed on `(definition_id, embedding_model, dimension)` (NOT `symbol_id` — corrected per R3 H8 to align with stable identity per R2 H7) with paired `(active_embedding_model, active_embedding_dim)` pointer on `audit_repos`. **`embedding_model` columns ALWAYS store the resolved concrete provider id, never a sentinel string** (per Gemini G2). `refresh.mjs` resolves the sentinel at refresh-start time and persists the concrete id; reads use the stored concrete id directly. No destructive drops on model swap. | Responds to M4 + Gemini G2 — open/closed, sustainability, semantic-vector-space integrity |
| 12 | **Explicit refresh modes (full / incremental)** with file-level inventory. Stale handling scoped to affected file set, never by `walk_commit` alone. | Responds to H2 — correct lifecycle |
| 13 | **Service-role writes**, anon-read-only, per-repo predicate RLS deferred to Phase F. Threat model documented. | Responds to H5 — least privilege |
| 14 | **Stable repo identity** via `scripts/lib/repo-identity.mjs` and committed `.audit-loop/repo-id`. Single resolver imported by everyone. | Responds to H6 — single source of truth |
| 15 | **Dedicated query-embedding module** (`neighbourhood-query.mjs`) owns description→embedding→RPC orchestration, contract validation, and cost accounting. | Responds to H3 — end-to-end traceability, SRP |
| 16 | **`/ship` advisory step** runs `arch:refresh --since-commit <last>` and `arch:render`; commits the regenerated map if changed. Never blocks ship. | Responds to H4 — automation over manual drift |

---

## 4. Sustainability Notes

### Encoded assumptions

- Supabase is the canonical store; `learning-store.mjs` is the swap point —
  specifically, the methods `recordSymbolIndex`, `recordLayeringViolations`,
  `getNeighbourhood`, `computeDriftScore`, `archiveStaleSymbols`,
  `openRefreshRun`, `publishRefreshRun`, `getActiveRefreshId`. The
  swap target must preserve their input/output Zod contracts and the
  RPC scoring semantics (or implement equivalents). Storage choice
  beneath that line (Postgres / DuckDB / SQLite + a vector add-on) is
  free to vary.
- `dependency-cruiser` covers v1 stack (JS/TS only); Python is future scope.
- Embedding **dimension** is a per-row attribute, not a schema constraint.
  Provider swap is now an additive migration: write new rows under a new
  `embedding_model` + `dimension`, flip `active_embedding_model` when
  backfill completes, leave old rows for rollback. No drop+recreate.
- Repo size budget: ≤10K symbols (above which ivfflat lists tuning matters).

### What breaks if requirements change

| Change | Containment |
|---|---|
| New embedding provider | Insert into `symbol_embeddings` under new `(model, dim)`; backfill in background; flip `active_embedding_model` pointer; old embeddings remain queryable for rollback |
| New language support | Add `extractors/<lang>.mjs`; refresh dispatcher picks by extension |
| Schema needs a new symbol attribute | Additive ALTER on `symbol_index`; old refresh_runs still readable |
| Cross-repo neighbourhood (consumer queries sibling repo's index) | Schema-ready (`repo_id` already a column); RPC takes `repo_ids[]` instead of single |
| Per-repo RLS predicates (Phase F) | Implement `current_setting('request.jwt.claims', true)::jsonb -> 'repo_id'` predicates; existing service-role writes remain untouched |
| New symbol kind | `kind` enum is wide; usually no migration needed |

### Pattern we're establishing

This is the **first persistent per-repo code-state store**. Future
stores (coverage map, perf-budget map, dependency-version map) should
mirror its shape:
- `<thing>_index` table keyed on `(repo_id, refresh_id, identity)`
- `refresh_runs`-style snapshot publication with `active_refresh_id` pointer
- Sibling `<thing>_violations` table for cross-cutting flags
- Versioned attribute child tables for evolving model outputs
- RPC-based scoring with refresh_id parameter
- Weekly sticky-issue gate
- Committed Markdown artifact regenerated by `/ship`
- Stable identity resolved by `scripts/lib/repo-identity.mjs`

### Extension points built in

- `scripts/symbol-index/extractors/` directory ready for per-language extractors.
- `domain_tag` is free-form text — reassignable by future override CLI.
- `kind` enum is wide; new symbol kinds rarely need a migration.
- `archived_at` keeps history for resurrection or "this used to live at..."
  diagnostics.
- Embedding versioning supports A/B comparison: query with two models and compare ranking quality.

---

## 5. File-Level Plan (combined)

### Data and presentation contracts (responding to M3)

`scripts/lib/symbol-index-contracts.mjs` is the single source of truth
for shapes that cross module boundaries. Two Zod schemas:

```js
// ── DATA contract — what flows from learning-store / RPC to consumers ──
export const SymbolRecordSchema = z.object({
  id:              z.string().uuid(),         // snapshot row id
  definitionId:    z.string().uuid(),         // stable per-repo identity (per Gemini G3 — needed by backend consumers / diagnostics / symbol_embeddings joins)
  refreshId:       z.string().uuid(),
  repoId:          z.string().uuid(),
  filePath:        z.string(),
  startLine:       z.number().int().nullable(),
  endLine:         z.number().int().nullable(),
  symbolName:      z.string(),
  kind:            z.enum(['function','class','component','hook','route','method','constant','type','other']),
  signatureHash:   z.string(),
  purposeSummary:  z.string().nullable(),
  domainTag:       z.string().nullable(),
  // embedding NOT included in the wire contract — it's >700 numbers per row
  // and consumers don't need it; only the RPC does
});

export const NeighbourhoodQueryArgsSchema = z.object({
  repoUuid:           z.string().min(1),
  targetPaths:        z.array(z.string()),
  intentDescription:  z.string().min(1),
  k:                  z.number().int().positive().default(50),
  kind:               z.array(z.enum(['function','class','component','hook','route','method','constant','type','other'])).optional(),  // R3 M1: filter pushed into RPC, not post-hoc
});

export const NeighbourhoodResultSchema = z.object({
  cloud:     z.boolean(),
  refreshId: z.string().uuid().nullable(),
  records:   z.array(SymbolRecordSchema.extend({
    score:           z.number().min(0).max(1),
    hopScore:        z.number().min(0).max(1),
    similarityScore: z.number().min(-1).max(1),
    recommendation:  z.enum(['reuse','extend','justify-divergence','review']),
  })),
  totalCandidatesConsidered: z.number().int().nonnegative(),
  truncated:                 z.boolean(),
  hint:                      z.string().nullable(),  // present in cloud-off / error states
});

export const DriftReportSchema = z.object({
  refreshId:           z.string().uuid().nullable(),
  generatedAt:         z.string(),  // ISO8601
  windowDays:          z.number().int().positive(),
  driftScore:          z.number().nonnegative(),
  threshold:           z.number().positive(),
  duplicationPairs:    z.number().int().nonnegative(),
  layeringViolations:  z.number().int().nonnegative(),
  namingDivergences:   z.number().int().nonnegative(),
  status:              z.enum(['GREEN','AMBER','RED','INSUFFICIENT_DATA']),
  clusters:            z.array(/* … cluster shape … */),
});

// ── PRESENTATION contract — what arch-render functions return ──
export const RenderedNeighbourhoodCalloutSchema = z.object({
  markdown:           z.string(),
  appendixMarkdown:   z.string(),  // full neighbourhood, for end-of-plan
  truncatedAt:        z.number().int().nonnegative(),
});

export const RenderedArchitectureMapSchema = z.object({
  markdown:    z.string(),
  bytesWritten: z.number().int().nonnegative(),
});

export const RenderedDriftIssueSchema = z.object({
  markdown:    z.string(),
  topClustersShown: z.number().int().nonnegative(),
  longTailHidden:   z.number().int().nonnegative(),
});
```

Conversion from data → presentation lives in **one** module
(`scripts/lib/arch-render.mjs`); all consumers (skill-side renderer,
drift CLI, render-mermaid CLI) call into it. Truncation logic and
ranking metadata are owned by the presentation layer; the data layer
returns full data + flags.

### New backend files

| File | Purpose | Why |
|---|---|---|
| `supabase/migrations/20260501120000_symbol_index.sql` | Schema for `symbol_index`, `symbol_embeddings` (versioned child), `symbol_layering_violations`, `refresh_runs`; ALTER `audit_repos` to add `active_refresh_id UUID`, `repo_uuid TEXT`, `active_embedding_model TEXT`; `vector` extension; two RPCs (`drift_score(repo_id, refresh_id, …)`, `symbol_neighbourhood(repo_id, refresh_id, target_paths, intent_embedding, k)`); RLS policies (anon read-only, service-role write) | Single source of truth for schema. Idempotent + RLS-tightened (responds to H1, H5, M4) |
| `scripts/lib/symbol-index.mjs` | Pure in-process API: signature normalisation (now includes body checksum per M1), hash, batching, Node-side ranking fallback | #2 SR, #11 Testability |
| `scripts/lib/symbol-index-contracts.mjs` | Zod data + presentation schemas (above) | Responds to M3 |
| `scripts/lib/repo-identity.mjs` | `resolveRepoIdentity(cwd)` → `{repoUuid, name, remoteUrl, source}`; persists `.audit-loop/repo-id` | Responds to H6 |
| `scripts/lib/neighbourhood-query.mjs` | `getNeighbourhoodForIntent({repoUuid, targetPaths, intentDescription, k, kind})` — owns embedding generation, contract validation, cost accounting; returns `{result, usage, latencyMs}` | Responds to H3 |
| `scripts/symbol-index/extract.mjs` | CLI: **uses `ts-morph` (AST parser) for intra-file symbol extraction** including body_text, start_line, end_line, and signature; **uses `dependency-cruiser` separately for the file-to-file import graph**. Emits one JSON line per symbol record (with deps annotation) on stdout. (Responding to Gemini-R2 G2 — these are two distinct tools; treating dep-cruiser as a symbol extractor was incorrect.) | #2 SR (one job: walk the AST, emit records) |
| `scripts/symbol-index/summarise.mjs` | CLI: read records → batched Haiku purpose summaries → enriched stdout | Composable with extract |
| `scripts/symbol-index/embed.mjs` | CLI: read records → batched embeddings (model from `ARCH_INDEX_EMBED_MODEL`) → enriched stdout | Composable with summarise |
| `scripts/symbol-index/refresh.mjs` | Orchestrator: opens `refresh_run`, dispatches mode (full/incremental), runs extract→summarise→embed→upsert under `refresh_id`, copy-forwards untouched-file symbols, atomically promotes `active_refresh_id` on success | Responds to H1, H2 |
| `scripts/symbol-index/drift.mjs` | CLI: calls `drift_score` RPC for `active_refresh_id`, evaluates thresholds, renders Markdown via `arch-render.mjs`. Exit 0/1/2 | #1 DRY (mirrors memory-health) |
| `scripts/symbol-index/prune.mjs` | CLI: GC aborted/old refresh_runs (>7 days, not active) | Operational hygiene; sketch only in v1 |
| `.github/workflows/architectural-drift.yml` | Weekly action (Mondays 09:30 UTC, 30-min stagger from memory-health); same sticky-issue logic as memory-health; label `architectural-drift`; uses `SUPABASE_AUDIT_SERVICE_ROLE_KEY` from secrets for the refresh-then-drift sequence | #1 DRY |
| `tests/symbol-index.test.mjs` | Unit tests for `lib/symbol-index.mjs` + cloud-off graceful no-op + signature_hash determinism + body-checksum invalidation | #11 Testability; responds to M1 |
| `tests/repo-identity.test.mjs` | Unit tests for `repo-identity.mjs`: idempotency across runs, deterministic across clones of the same remote, fork detection | Responds to H6 |
| `tests/neighbourhood-query.test.mjs` | Unit tests for `neighbourhood-query.mjs`: contract validation, embedding cache hit, error normalisation | Responds to H3 |
| `tests/refresh-modes.test.mjs` | Integration tests against a real **Postgres + pgvector** test database (Supabase project or local docker-compose `pgvector/pgvector:pg16`); SQLite is rejected as a substrate because it cannot validate pgvector, RPC, transaction, or RLS. Gated behind `RUN_INTEGRATION=1` so unit `npm test` stays hermetic. Coverage: snapshot isolation under concurrent reads, incremental file-status handling (A/M/D/R), abort semantics, RLS anon-read-vs-service-write enforcement, embedding-model mismatch error path | Responds to H1, H2; clarifies R2 ambiguity #3 |
| `tests/sensitive-egress.test.mjs` | Unit + integration tests for the egress gate: every denylist pattern blocks at extract; allowlist enforced; secret-bearing bodies produce `[SECRET_REDACTED]`; outbound payload logging contains zero raw bytes from blocked files | Responds to R2 H11 |
| `tests/snapshot-retention.test.mjs` | Unit tests for retention classification + prune transactionality | Responds to R2 M5 |
| `tests/symbol-definitions.test.mjs` | Unit tests for stable-identity rules: same `(repo,path,name,kind)` across refreshes → same `definition_id`; `git mv` rename preserves identity; symbol rename creates new identity; archived symbols GC after threshold | Responds to R2 H7 |

### New frontend (rendering) files

| File | Purpose | Why |
|---|---|---|
| `scripts/lib/arch-render.mjs` | Pure renderers: `renderArchitectureMap`, `renderDriftIssue`, `renderNeighbourhoodCallout`, `groupByDomain`, `renderMermaidContainer`, `renderSymbolTable`, `escapeMermaidLabel`, `escapeMarkdown`. All return objects matching the Presentation contract from `symbol-index-contracts.mjs` | #27 SR, #28 Modularity, #29 DRY |
| `scripts/symbol-index/render-mermaid.mjs` | CLI: reads symbol_index for `active_refresh_id` via cross-skill.mjs → calls renderArchitectureMap → atomic write to `docs/architecture-map.md` | #28 Modularity |
| `tests/arch-render.test.mjs` | Golden-file tests for each renderer; deterministic output assertion; M3 contract conformance | #11 Testability |

### Modified files

| File | Change |
|---|---|
| `scripts/cross-skill.mjs` | Add subcommands. **Writes**: `record-symbol-index`, `record-symbol-definitions`, `record-symbol-embeddings`, `record-layering-violations`, `open-refresh-run`, `publish-refresh-run`, `abort-refresh-run`, `set-active-embedding-model`. **Reads** (added per R3 H9 — render and audit-code consumers need them): `get-active-refresh-id`, `list-symbols-for-snapshot` (paginated, supports filters: kind, domain_tag, file_path prefix), `list-layering-violations-for-snapshot`, `get-neighbourhood`. Each follows existing pattern (Zod-validate → cloud-off no-op → learning-store call → emit JSON). Two distinct client factories: `getReadClient()` (anon) and `getWriteClient()` (service-role; hard-fails with `SERVICE_ROLE_REQUIRED` if env unset — **no anon-write fallback exists**, per R2 H10 fix). |
| `scripts/lib/sensitive-egress-gate.mjs` | NEW. Centralised denylist + allowlist + content-heuristic scrub, extending `scripts/lib/secret-patterns.mjs`. Exports `isPathSensitive(path)`, `isExtensionAllowlisted(path)`, `containsSecrets(body)`, `redactSecrets(payload)`. Imported by `extract.mjs`, `summarise.mjs`, `embed.mjs`, and any LLM payload logger. |
| `supabase/migrations/20260501120000_symbol_index.sql` (extended) | Definitive column list (per Gemini-R2 G4): on `audit_repos` — adds `active_refresh_id UUID`, `active_embedding_model TEXT` (concrete model id, never sentinel — per Gemini G2), `active_embedding_dim INT` (per R3 H7), `repo_uuid TEXT` (per R1 H6). On `refresh_runs` — `cancellation_token UUID`, `last_heartbeat_at TIMESTAMPTZ` (per R3 H10), `retention_class TEXT CHECK (...)` (per R2 M5), `mode TEXT`, `walk_start_commit`, `files_added/modified/deleted/renamed JSONB`, partial-unique index `(repo_id) WHERE status='running'`. New tables: `symbol_definitions` (stable identity per R2 H7), `symbol_embeddings` keyed on `definition_id` (per R3 H8). New RPCs (per Gemini-R2 G1): `publish_refresh_run(p_repo_id UUID, p_refresh_id UUID)` — performs `UPDATE audit_repos SET active_refresh_id` AND `UPDATE refresh_runs SET status='published'` in a single Postgres transaction (supabase-js / PostgREST cannot multi-statement transact, so the atomic promote MUST live server-side). Also `drift_score(repo_id, refresh_id, …)` and `symbol_neighbourhood(repo_id, refresh_id, target_paths, intent_embedding, kind_filter, k)`. RLS: anon `FOR SELECT USING (true)` only on all symbol-* tables — no `FOR INSERT/UPDATE/DELETE`, per R2 H10. |
| `scripts/learning-store.mjs` | Add exports: `recordSymbolIndex(repoId, refreshId, symbols)`, `recordSymbolDefinitions(repoId, definitions)` (R3 H8 — definitions are repo-scoped, not snapshot-scoped), `recordSymbolEmbedding(definitionId, model, dim, vector)` (R3 H8 — keyed on definition_id NOT symbol_id), `recordLayeringViolations(repoId, refreshId, violations)`, `getNeighbourhood(repoId, refreshId, targetPaths, intentEmbedding, kindFilter, k)` (R3 M1 — `kindFilter` pushed into signature; corresponding RPC accepts and pushes-down into the SELECT), `computeDriftScore(repoId, refreshId)`, `archiveStaleSymbols(repoId, refreshId, fileSet)`, `openRefreshRun(repoId, mode, walkStartCommit)`, `publishRefreshRun(refreshId)`, `abortRefreshRun(refreshId)`, `getActiveRefreshId(repoId)`, `listSymbolsForSnapshot(refreshId, {kind, domainTag, filePathPrefix, limit, offset})` (R3 H9 — read API for render + audit-code), `listLayeringViolationsForSnapshot(refreshId)` (R3 H9), `copyForwardUntouchedFiles(repoId, fromRefreshId, toRefreshId, touchedFileSet)`, `setActiveEmbeddingModel(repoId, model, dim)` (R3 H7 — accepts BOTH model and dim, persists both atomically), `getActiveEmbeddingModel(repoId)` returning `{model, dim}` for `neighbourhood-query.mjs` to read. |
| `scripts/lib/config.mjs` | Add `symbolIndexConfig` Object.freeze with: `summariseModel`, `embedModel`, `embedDim`, `llmConcurrency`, `batchSize`, `driftThreshold`, `driftSimDup`, `driftSimName`, `driftNameLev`, `auditFullTopN`, `serviceRoleKey` (read from `SUPABASE_AUDIT_SERVICE_ROLE_KEY`), `intentEmbedCacheTtlMs` (default 24h), `refreshIncrementalDefault` (boolean, default true) |
| `skills/plan-backend/SKILL.md` | Phase 1 pre-step: shell out to `cross-skill.mjs get-neighbourhood`; inline returned `markdown` field as callout near top of plan output. Add "Full neighbourhood" appendix at end. Empty-state, cloud-off, and error-state copy per §2 failure matrix. |
| `skills/plan-frontend/SKILL.md` | Same change as plan-backend, with frontend `kind` filter. |
| `skills/audit-code/SKILL.md` | When `--scope=full`, fetch `symbol_index` for repo's `active_refresh_id` and inline a "Symbol catalogue (top N by domain)" section. Cap at `ARCH_AUDIT_FULL_TOPN` (default 200). Ranking: by domain alphabetical, then within domain by similarity to the diff's centroid (computed via the same embedding model), tie-break by alphabetical symbol_name. Truncation noted in the inlined section header. |
| `skills/ship/SKILL.md` | New advisory step "Step 0.5c — Architectural Memory Refresh": run `npm run arch:refresh --since-commit <last-shipped>` and `npm run arch:render`. If `docs/architecture-map.md` changed, stage it. Always advisory — never blocks ship. Cloud-off / error → print warning, skip. (Responds to H4.) |
| `package.json` | New scripts: `arch:refresh`, `arch:refresh:full`, `arch:render`, `arch:drift`, `arch:prune`. New deps: `dependency-cruiser ^17` (file-to-file graph + layering rules), `ts-morph ^25` (AST symbol extraction — per Gemini-R2 G2). |
| `AGENTS.md` | New env-var rows including `SUPABASE_AUDIT_SERVICE_ROLE_KEY`; new "Architectural Memory" subsection under "Cross-Skill Data Loop"; link to `docs/architecture-map.md`; one-paragraph "How to read this"; threat-model summary referencing §1 of this plan. |
| `.env.example` | New env vars: `ARCH_INDEX_SUMMARY_MODEL`, `ARCH_INDEX_EMBED_MODEL`, `ARCH_INDEX_EMBED_DIM`, `ARCH_INDEX_LLM_CONCURRENCY`, `ARCH_INDEX_BATCH_SIZE`, `ARCH_DRIFT_SCORE_THRESHOLD`, `ARCH_DRIFT_SIM_DUP`, `ARCH_DRIFT_SIM_NAME`, `ARCH_DRIFT_NAME_LEVENSHTEIN`, `ARCH_AUDIT_FULL_TOPN`, `SUPABASE_AUDIT_SERVICE_ROLE_KEY`, `ARCH_INTENT_EMBED_CACHE_TTL_MS`, `ARCH_REFRESH_INCREMENTAL_DEFAULT`. Each with one-line comment. |
| `.gitignore` | (no change required — `.audit-loop/repo-id` IS committed by design, per H6 resolution) |

> Earlier per-file detail (function signatures, exports) lives in
> the child plans, but the **shape changes above (snapshot model,
> versioned embeddings, repo identity, query path, /ship integration,
> failure matrix, contracts) supersede the children where they conflict**.

---

## 6. Risk & Trade-off Register (combined)

### Backend risks (R1–R12)

| # | Risk / Trade-off | Mitigation |
|---|---|---|
| R1 | pgvector extension may need Supabase dashboard enable | Migration uses `CREATE EXTENSION IF NOT EXISTS vector` — fails loudly. Documented in `.env.example`. |
| R2 | Embedding model swap | **No drop+recreate** — versioned `symbol_embeddings` child table; backfill new model in background, flip `active_embedding_model` pointer atomically. (Updated per M4.) |
| R3 | dep-cruiser is JS/TS only in v1 | Refresh exits 0 with stderr `architectural-memory: Python extraction not yet supported (stack=python detected)`; emits JSON `{ok:true, skipped:true, reason:"unsupported-stack"}` on stdout. No DB writes. (Clarified per ambiguity #2.) |
| R4 | Body changes that should re-trigger summary | **Resolved per M1**: `signature_hash = sha256(name + normalised_signature + sha256(body_text))`. Pure-comment body changes still produce the same hash if body is normalised. Drift sweep is a backstop, not the primary mechanism. |
| R5 | First-time embed cost | ≤$0.10/1000 symbols; steady-state ~zero. |
| R6 | ivfflat index quality requires ≥1000 rows | Full-table scan acts as fallback for small repos. Documented. |
| R7 | Domain_tag noise from LLM tagging | Accepted v1; `arch:tag-review` CLI in v2. |
| R8 | Concurrent skill consultations | Read-only RPC, no contention expected. Cached embedding for repeat queries within a session. |
| R9 | Cross-repo neighbourhood | Out of scope; schema-ready (`repo_id` already a column). |
| R10 | `audit-code --scope=full` prompt bloat | Capped at 200 (env-tunable). |
| R11 | **Snapshot publication race**: two refreshes started within milliseconds | Partial-unique index `(repo_id) WHERE status='running'` ensures only one wins; the loser exits with `REFRESH_IN_FLIGHT`. `--force` flag aborts the in-flight one first (writes `status='aborted'`). |
| R12 | **Service-role key handling** | Stored as GH repository secret for the workflow; documented in `.env.example` and `AGENTS.md` as developer-local; never committed. Anon key remains read-only for all symbol-* tables. |
| R13 | **Stable symbol identity drift across refactors** (R2 H7) | `symbol_definitions` keyed on `(repo_id, canonical_path, symbol_name, kind)`. `git mv` preserves identity; symbol rename creates new identity. Edge case: large refactor that renames AND moves a symbol simultaneously breaks the identity link (treated as delete + insert). Acceptable for v1 — embedding cost on these is one-shot. |
| R14 | **Sensitive-data egress** (R2 H11) | Two-stage gate: path filter at extract.mjs, content scrub at summarise/embed. Allowlist of summarisable extensions. Reuses existing `scripts/lib/secret-patterns.mjs`. Defence in depth: even if path filter is misconfigured, content scrub catches secrets in body. P0 acceptance criteria. |
| R15 | **Snapshot retention growth** (R2 M5) | `retention_class` column drives policy. Pruning is scheduled (drift workflow). Acceptance test verifies prune transactionality. Cap: active + last 4 + weekly checkpoints (90d) + 30d window for transient. |
| R16 | **Embedding-model mismatch on read** (R2 H9) | `neighbourhood-query.mjs` loads `active_embedding_model` from repo state, NOT from config. Cache key includes `(model, dim)` so model swap invalidates cache. Typed `EMBEDDING_MISMATCH` error path; skill fails open. |
| R17 | **Graph-derived state stale on incremental refresh** (R2 H8) | Layering violations and dep graph always recomputed from full repo; only symbol extraction is incremental. Cost is bounded (dep-cruiser walks full graph in <2s for ~1000 symbols). |

### Frontend risks (F1–F10)

| # | Risk / Trade-off | Mitigation |
|---|---|---|
| F1 | Mermaid cross-surface inconsistency | Stick to `flowchart TB` + `classDef`; verified GitHub/VS Code/Obsidian/terminal. |
| F2 | Noisy diffs on `architecture-map.md` | Stable ordering; diff = drift signal (intentional). |
| F3 | Mis-grouped domains from noisy LLM tagging | Flat table is still correct. |
| F4 | Mermaid >50 nodes unreadable | Fallback: summary diagram + flat table. |
| F5 | Auto-close stomps human takeover | Same protection as memory-health (only auto-close when last comment was workflow's). Specifically: gh-api search by marker; check most recent comment author; only close if author matches the workflow's bot or the body still starts with the marker and no human comment exists since the last workflow update. |
| F6 | Symbol-path links break across branches | Repo-relative paths; GitHub renders branch-aware. |
| F7 | Recommendation tag is opinion not gate | Reviewer always overrides. |
| F8 | Plan output bloated by callout | Top-5 visible; full at end; cap 100. |
| F9 | Reviewers ignore layering violations | Dedicated section in both map and drift issue. |
| F10 | Dark-mode contrast for cluster highlighting | Explicit `color:#000` in classDef. |

### Cross-cutting deliberately deferred

- **Per-repo predicate RLS** (Phase F) — anon users of a shared
  Supabase project can read sibling repos' indices. v1 ships under
  per-developer-Supabase assumption; service-role-only writes already
  block poisoning. Phase F adds JWT claim-based predicates.
- **Cross-repo neighbourhood** (consumer queries sibling repo's index)
  — schema-ready; out of v1.
- **Auto-refresh on every git commit** — too aggressive; weekly +
  /ship covers it.
- **Per-repo dep-cruiser config bundling** — picked up automatically
  if present; not bundled.
- **Hand-curated `domain_tag` registry in AGENTS.md** — rejected.
- **Hosted web view** — out of scope.
- **Interactive PR-time map view** — would need a custom GitHub App.

---

## 7. Testing Strategy (combined)

### Unit tests (Node `--test`)

- `tests/symbol-index.test.mjs` — signature normalisation, hash determinism (including body-checksum sensitivity per M1), batching, ranking, cloud-off graceful no-op, deterministic output across LF/CRLF.
- `tests/repo-identity.test.mjs` — idempotency across runs, deterministic UUIDv5 across clones of the same remote, fork detection (different remote → different uuid), missing `.audit-loop/repo-id` handled gracefully.
- `tests/neighbourhood-query.test.mjs` — contract validation against `SymbolRecordSchema` and `NeighbourhoodResultSchema`, embedding cache TTL, error normalisation paths from §2 failure matrix.
- `tests/arch-render.test.mjs` — golden-file assertions for each renderer; M3 presentation-contract conformance; escape correctness for Mermaid + Markdown special chars; deterministic output.
- `tests/refresh-modes.test.mjs` — runs against real Postgres + pgvector (gated by `RUN_INTEGRATION=1`); covers snapshot isolation under concurrent reader/writer, `git diff --name-status` outputs (A/M/D/R), abort semantics, RLS anon-read-vs-service-write, embedding-model mismatch error path.
- `tests/sensitive-egress.test.mjs` — every denylist pattern blocks; allowlist enforced; outbound payload contains zero raw bytes from blocked files; secret-pattern detection on body content forces `[SECRET_REDACTED]` summary; redactSecrets() helper used in all log paths.
- `tests/snapshot-retention.test.mjs` — retention classification matches policy table; prune transactionality (snapshot-scoped rows + refresh_runs row in single transaction); definitions+embeddings survive across snapshot prune cycles unless their archived_at threshold is met.
- `tests/symbol-definitions.test.mjs` — stable-identity rules per R2 H7.

### Integration / smoke (manual; opt-in)

- Apply migration to a fresh Supabase project; verify `vector` extension + RPCs + RLS policies (anon SELECT works; anon INSERT fails; service-role INSERT works).
- Run `npm run arch:refresh:full` against this repo (claude-audit-loop itself); inspect populated rows + new `refresh_runs` row + promoted `active_refresh_id`.
- Trigger `architectural-drift.yml` via `workflow_dispatch`; verify sticky issue logic on a seeded duplication state.
- Invoke `/plan-backend` with a contrived task; verify the Neighbourhood callout appears with refreshId attribution.
- Invoke `/plan-backend` with `unset SUPABASE_AUDIT_URL`; verify the cloud-off hint appears (per failure matrix).
- Invoke `/plan-backend` with valid Supabase but disabled embedding provider; verify EMBED_FAILED callout (fail-open behaviour).
- Invoke `/ship` on a commit that touched `scripts/openai-audit.mjs`; verify `arch:refresh --since-commit <prior>` runs in incremental mode and `docs/architecture-map.md` is regenerated + staged.

### Cross-surface visual checks

- `docs/architecture-map.md` renders correctly in GitHub (light + dark, mobile + desktop), VS Code Markdown preview, Obsidian, terminal `cat`/`less`, Claude Code.

### Determinism / regression

- Re-running `npm run arch:render` on identical state must produce a byte-identical file. CI assertion: `git diff --exit-code docs/architecture-map.md` after `npm run arch:render`.
- `signature_hash` deterministic across LF/CRLF, across runs, across platforms.

### `npm run check` integration

- New tests automatically picked up by existing `tests/*.test.mjs` glob in `npm test`.
- No new lint rules required.

---

## 8. Rollout

Six sequential phases. Each is an independently mergeable change.

| Phase | Scope | Behavioural change at end |
|---|---|---|
| A — Schema + Library | Migration applied (with `symbol_definitions`, `refresh_runs`, `symbol_embeddings` versioned table, `retention_class` column, all RLS-hardened); `lib/symbol-index.mjs`, `lib/symbol-index-contracts.mjs`, `lib/repo-identity.mjs`, `lib/neighbourhood-query.mjs`, `lib/sensitive-egress-gate.mjs` + `learning-store.mjs` additions + `cross-skill.mjs` subcommands; tests green; **child plans archived to `docs/plans/archive/`** | Infra in place; cloud-off no-op verified; service-role key REQUIRED for writes (no fallback) |
| B — Extract + Refresh | All `scripts/symbol-index/*.mjs` (extract.mjs uses egress gate; summarise/embed double-check); `npm run arch:refresh:full` works against this repo; refresh_run snapshot publication verified; incremental mode verified; secret-bearing test fixtures confirm zero egress | `symbol_index` populated with `active_refresh_id` set; `.audit-loop/repo-id` committed; `symbol_definitions` populated; `symbol_embeddings` keyed on `definition_id` |
| C — Skill integration | SKILL.md changes for plan-backend, plan-frontend, audit-code; `npm run skills:regenerate` | /plan-* output gains "Neighbourhood considered" callout (read-pinned to active embedding model per R2 H9); /audit-code --scope=full inlines symbol catalogue |
| D — Drift sweep + retention | `drift.mjs` + `prune.mjs` + `architectural-drift.yml` (drift + prune as two jobs sharing one workflow); manual workflow_dispatch test | Weekly drift report; sticky issue when threshold crossed; published-snapshot pruning runs weekly |
| E — Frontend artifact | `lib/arch-render.mjs` + `render-mermaid.mjs` + `tests/arch-render.test.mjs`; first `docs/architecture-map.md` generated | `docs/architecture-map.md` becomes a regenerated artifact |
| F — Hardening + /ship integration + per-repo RLS | `skills/ship/SKILL.md` advisory step; per-repo predicate RLS via JWT claims; embedding-model swap procedure documented + smoke-tested with non-destructive backfill flow | /ship regenerates and stages map; multi-developer Supabase projects safe; embedding model swap is a routine, non-destructive operation |

### Backward compatibility

- All migrations idempotent. Existing tables touched only by additive `ALTER TABLE … ADD COLUMN IF NOT EXISTS`.
- All new env vars optional (defaults in `config.mjs`).
- Cloud-off path: skills emit a one-line hint (per failure matrix), planning continues unchanged.
- New scripts have no side effects unless explicitly invoked.
- `audit_repos` rows without `repo_uuid` are backfilled lazily on next `resolveRepoIdentity` call.

### Adoption in consumer repos

After merge, consumers update by:
1. Bumping their pinned version of claude-audit-loop.
2. Running `npm run sync` (existing flow).
3. Running `npm run arch:refresh:full` once to populate their `symbol_index` (writes `.audit-loop/repo-id`; commit it).
4. Optionally enabling the weekly workflow in their repo (synced; can be disabled per-repo).
5. Optionally setting `SUPABASE_AUDIT_SERVICE_ROLE_KEY` for refreshes (anon key alone gives read-only — refresh exits with a clear error if anon-only).

---

## 9. Acceptance Criteria (combined, machine-parseable)

> Format follows the plan-frontend Section 9 spec. Criteria mix backend
> behaviours (verifiable via CLI + DB inspection) and frontend
> behaviours (verifiable via file inspection or Playwright on GitHub's
> rendered HTML). Backend-only criteria use `[other]` category since
> they are not browser-driven.

### Gemini final-review fix coverage (responding to G1, G2, G3)

- [P0] [other] /ship's incremental refresh sees uncommitted changes (G1)
  - Setup: edit a JS file (do NOT commit); invoke `/ship` (which runs `arch:refresh --since-commit <last-shipped>` before creating the commit)
  - Assert: `refresh_runs.files_processed` for that run includes the edited file path; the new active snapshot's `symbol_index` rows reflect the new symbols/changes from the working tree
- [P0] [other] /ship's incremental refresh includes untracked files (G1)
  - Setup: create a new untracked `.mjs` file; invoke `/ship`
  - Assert: untracked file's symbols appear in the new active snapshot
- [P0] [other] `embedding_model` columns store resolved concrete IDs (G2)
  - Setup: set `ARCH_INDEX_EMBED_MODEL=latest-flash` (a sentinel); run `npm run arch:refresh:full`
  - Assert: `audit_repos.active_embedding_model` and every `symbol_embeddings.embedding_model` row contain a CONCRETE id (e.g. `gemini-flash-latest`-style) NOT the literal sentinel string `latest-flash`; stderr logs the resolved id at refresh start
- [P0] [other] Sentinel re-resolution at read time would FAIL the contract (G2)
  - Setup: from a refreshed state, call `getNeighbourhoodForIntent`; verify the embedding generated for the intent uses the same concrete model id stored in `audit_repos.active_embedding_model` — NOT a fresh sentinel resolution
  - Assert: if active model in DB is `model-x` and we then change `ARCH_INDEX_EMBED_MODEL` to a different sentinel resolving to `model-y`, the read still uses `model-x` (the stored concrete id)
- [P1] [other] `SymbolRecordSchema` exposes `definitionId` to consumers (G3)
  - Setup: import `SymbolRecordSchema` from `scripts/lib/symbol-index-contracts.mjs`; parse a sample record from `cross-skill.mjs list-symbols-for-snapshot` output
  - Assert: parse succeeds with non-null `definitionId`; the value matches the underlying `symbol_definitions.id` for that logical symbol

### R2 fix coverage (responding to R2 H7–H11, M5)

- [P0] [other] Sensitive-data egress gate blocks `.env` and credential paths
  - Setup: place an `.env` file with realistic secrets at repo root + a `secrets/api.key` file; run `npm run arch:refresh:full` with HTTP recording enabled (capture all outbound LLM/embedding requests)
  - Assert: zero outbound requests reference content from `.env` or `secrets/api.key`; both files are absent from `symbol_index` rows; stderr explicitly logs `egress-gate: path blocked: .env`
- [P0] [other] Sensitive-data egress gate redacts secrets in body content
  - Setup: create a `.js` source file containing a hardcoded fake AWS access key string (`AKIA…` format from the secret-patterns regex) embedded in a function body; run refresh
  - Assert: the symbol appears in `symbol_index`; its `purpose_summary = '[SECRET_REDACTED]'`; no `symbol_embeddings` row exists for it; outbound LLM payload (captured) contains zero bytes from the secret
- [P0] [other] Stable symbol identity preserved across refresh
  - Setup: full refresh; capture `symbol_definitions.id` for `runMultiPassCodeAudit`; modify the function body (signature unchanged); incremental refresh
  - Assert: same `definition_id`; `symbol_index` row points to it; `symbol_embeddings` row preserved (cache-hit because new content didn't trigger a body-checksum change for this test, or new embedding generated for same `definition_id` if body changed)
- [P0] [other] Stable identity preserved across `git mv`
  - Setup: full refresh; `git mv scripts/openai-audit.mjs scripts/openai-audit-v2.mjs`; commit; incremental refresh
  - Assert: every symbol's `definition_id` unchanged in the new active snapshot; new `canonical_path` written; old path absent from active snapshot; embeddings still attached to same definitions
- [P0] [other] Service-role hard-fail when key absent
  - Setup: `unset SUPABASE_AUDIT_SERVICE_ROLE_KEY`; ensure `SUPABASE_AUDIT_URL` + anon key are set
  - Assert: `npm run arch:refresh` exits 2 with stderr containing `SERVICE_ROLE_REQUIRED`; no DB writes; no anon-write fallback attempted
- [P0] [other] Embedding compatibility — read pinned to active model
  - Setup: refresh with model A active; manually set `active_embedding_model` to a model B with different dim that has zero rows; call `cross-skill.mjs get-neighbourhood`
  - Assert: emits `{ok:false, error:{code:"EMBEDDING_MISMATCH", expected:{model:"B",dim:…}, available:[{model:"A",dim:…}]}}`; exit 2; `/plan-*` would fail-open with the same error code
- [P0] [other] Graph-derived artefacts always recomputed
  - Setup: full refresh; introduce a layering violation (an edge from `scripts/lib/x.mjs` to `scripts/openai-audit.mjs` that violates dep-cruiser rules); modify only `scripts/lib/x.mjs`; incremental refresh
  - Assert: new violation appears in `symbol_layering_violations` for the new active snapshot — proves graph was recomputed (NOT just symbols within touched file)
- [P0] [other] Snapshot retention — prune respects retention class
  - Setup: seed 10 published snapshots with varied `retention_class` values (1 active, 4 rollback, 2 weekly_checkpoint, 3 transient); set transient TTL to 0 days; trigger prune
  - Assert: 7 snapshots remain (active + 4 rollback + 2 checkpoints); transient ones are gone; their snapshot-scoped rows (`symbol_index`, `symbol_layering_violations`) cascade-deleted; `symbol_definitions` survive as long as still referenced
- [P0] [other] Prune is transactional per snapshot
  - Setup: simulate a delete error mid-prune for one snapshot (e.g. force a constraint violation on a foreign-key)
  - Assert: that snapshot's rows + refresh_runs row remain consistent (all-or-nothing); other snapshots prune cleanly
- [P1] [other] Pruning runs as part of weekly drift workflow
  - Setup: trigger `architectural-drift.yml` via `workflow_dispatch`
  - Assert: workflow log contains both `arch:drift` and `arch:prune` step output; counts of pruned snapshots reported
- [P1] [other] Embedding cache key includes model+dim
  - Setup: call `getNeighbourhoodForIntent` twice with identical intent but different `active_embedding_model` between calls
  - Assert: second call generates a fresh embedding (cache key differs); stderr does not show `embedding-cache: hit`

### Schema, identity, and snapshot isolation (responding to H1, H5, H6)

- [P0] [other] Migration `20260501120000_symbol_index.sql` applies cleanly to a fresh Supabase project
  - Setup: `supabase db reset` on a dev project; apply migration
  - Assert: `psql -c "\dt symbol_index symbol_embeddings symbol_layering_violations refresh_runs"` shows all four tables; `\dT vector` shows the extension; both `drift_score` and `symbol_neighbourhood` RPCs callable
- [P0] [other] RLS — anon is read-only on symbol_index
  - Setup: connect with anon key; attempt `INSERT INTO symbol_index VALUES (...)`
  - Assert: insert is rejected with RLS error; `SELECT FROM symbol_index` succeeds
- [P0] [other] RLS — service role can write
  - Setup: connect with service-role key; attempt INSERT under a valid `refresh_id`
  - Assert: insert succeeds
- [P0] [other] Snapshot isolation — readers see only published snapshots
  - Setup: start a long-running `refresh.mjs` (full mode); concurrently call `node scripts/cross-skill.mjs get-neighbourhood` from another shell
  - Assert: get-neighbourhood result's `refreshId` equals the previous active snapshot id (NOT the new in-flight one); after refresh publishes, the next call returns the new id
- [P0] [other] `repo-identity.mjs` is deterministic across clones
  - Setup: clone the same git remote URL into two different directories; run `node -e "console.log(JSON.stringify(await import('./scripts/lib/repo-identity.mjs').then(m => m.resolveRepoIdentity(process.cwd()))))"` in each
  - Assert: `repoUuid` matches between the two clones
- [P0] [other] `repo-identity.mjs` writes `.audit-loop/repo-id` on first call
  - Setup: fresh clone with no `.audit-loop/repo-id`; call `resolveRepoIdentity`
  - Assert: file exists post-call; second call reads existing file (no recompute)

### Refresh modes (responding to H2)

- [P0] [other] Incremental refresh handles file deletions
  - Setup: full refresh; delete a file with N indexed symbols; commit; run `npm run arch:refresh --since-commit <prior>`
  - Assert: deleted file's symbols absent from new active snapshot; symbols from untouched files preserved at prior `purpose_summary` and `embedding`
- [P0] [other] Incremental refresh handles renames
  - Setup: full refresh; `git mv old.mjs new.mjs`; commit; refresh
  - Assert: symbols at `new.mjs` exist in new snapshot; no symbols at `old.mjs`; counts match (no symbol lost)
- [P0] [other] Aborted refresh leaves active snapshot intact
  - Setup: simulate refresh failure mid-batch (`ARCH_INDEX_FORCE_FAIL=batch3`); run refresh; query `active_refresh_id` before and after
  - Assert: `active_refresh_id` unchanged; `refresh_runs.status='aborted'` for the failed run; original snapshot rows still queryable
- [P1] [other] Concurrent refresh attempts are rejected
  - Setup: start refresh A in background; start refresh B in foreground
  - Assert: B exits non-zero with `REFRESH_IN_FLIGHT` code; A continues to completion

### Query embedding path (responding to H3)

- [P0] [other] `get-neighbourhood` validates input + emits errors per failure matrix
  - Setup: `node scripts/cross-skill.mjs get-neighbourhood --json '{}'`
  - Assert: emits `{ok:false, error:{code:"BAD_INPUT", issues:[…]}}`; exit code 2
- [P0] [other] `getNeighbourhoodForIntent` returns `{result, usage, latencyMs}`
  - Setup: import `scripts/lib/neighbourhood-query.mjs`; call with valid args (mocked embedding provider)
  - Assert: return value has all three keys; `usage.totalTokens > 0`; `latencyMs > 0`
- [P0] [other] Repeat queries hit the embedding cache
  - Setup: call `getNeighbourhoodForIntent` twice with identical `intentDescription` within TTL
  - Assert: second call's stderr does not contain `embedding generated`; cost telemetry shows zero embedding tokens for the second call

### /ship integration (responding to H4)

- [P0] [other] /ship runs arch:refresh + arch:render as advisory steps
  - Setup: invoke `/ship` on a commit that modified `scripts/openai-audit.mjs`
  - Assert: stdout contains both `arch:refresh` and `arch:render` step output; if `docs/architecture-map.md` changed, it is staged in the resulting commit; ship outcome is unaffected by arch step success/failure
- [P0] [other] /ship arch step never blocks ship
  - Setup: invoke `/ship` with `unset SUPABASE_AUDIT_URL`
  - Assert: ship completes successfully; arch step printed warning but did not abort

### Cross-cutting backend acceptance

- [P0] [other] `getNeighbourhood` returns empty + `cloud: false` when Supabase env unset
  - Setup: `unset SUPABASE_AUDIT_URL SUPABASE_AUDIT_ANON_KEY`
  - Assert: `node scripts/cross-skill.mjs get-neighbourhood --json '{"targetPaths":["x.mjs"],"intentDescription":"y"}'` exits 0 with JSON `{"ok":true,"cloud":false,"records":[],"hint":"…"}`; the hint string contains `npm run arch:refresh`
- [P0] [other] `npm test` passes including new tests
  - Setup: clean checkout, `npm ci`
  - Assert: `npm test` exit code 0; `tests/symbol-index.test.mjs`, `tests/arch-render.test.mjs`, `tests/repo-identity.test.mjs`, `tests/neighbourhood-query.test.mjs`, `tests/refresh-modes.test.mjs` all report > 0 passing tests
- [P0] [other] `npm run arch:refresh` is idempotent on unchanged repo
  - Setup: run `npm run arch:refresh` twice in a row on the same commit
  - Assert: second run's stderr summary contains `0 LLM calls, 0 embedding calls`; new `refresh_runs` row created but `active_refresh_id` content equivalent
- [P0] [other] Skill consultation step emits a hint when Supabase is off
  - Setup: invoke `/plan-backend` against this repo with Supabase env unset
  - Assert: planning output contains the literal string `npm run arch:refresh`
- [P0] [other] Skill consultation step fails open on RPC error
  - Setup: invoke `/plan-backend` with valid Supabase env but unreachable network
  - Assert: planning output contains a callout starting with `_consultation failed:` and ending with `; plan proceeds without architectural context_`; planning still completes
- [P1] [other] Drift sweep workflow opens a sticky issue when threshold crossed
  - Setup: seed `symbol_index` (under `active_refresh_id`) with 5 known duplication pairs (cosine > 0.85, same kind, different file); set `ARCH_DRIFT_SCORE_THRESHOLD=0`; trigger workflow via `workflow_dispatch`
  - Assert: GitHub API shows one open issue labelled `architectural-drift` whose body's first line is `<!-- audit-loop:architectural-drift -->`
- [P1] [other] Drift sweep workflow auto-closes when score returns to green AND last comment was workflow's
  - Setup: with sticky issue from prior step open and no human comment since; delete the duplication-pair rows; trigger workflow
  - Assert: same issue is now closed; closure comment contains `returned to green`
- [P1] [other] Drift sweep workflow does NOT auto-close if a human commented after the workflow
  - Setup: with open sticky issue, post a human comment; then return metrics to green and trigger workflow
  - Assert: issue remains open; workflow logs `human takeover detected — leaving issue open`
- [P1] [other] Audit-code `--scope=full` includes a symbol catalogue in prompt with deterministic ranking
  - Setup: invoke `npm run audit:code -- --scope=full --plan docs/plans/architectural-memory.md`
  - Assert: audit transcript file contains a `Symbol catalogue` section; entries ordered by `(domain alphabetical, similarity desc, symbol_name alphabetical)`; cap respected; section header contains `truncated at <N>` if truncated
- [P1] [other] Embedding model swap is non-destructive
  - Setup: with one model active, set `ARCH_INDEX_EMBED_MODEL=<other-model-with-different-dim>`; run `npm run arch:refresh --backfill-embedding-only`
  - Assert: rows under both models exist in `symbol_embeddings`; `active_embedding_model` not yet flipped; subsequent `npm run arch:set-active-embedding-model <other>` flips pointer; readers now use new model; old rows still present (rollback ready)
- [P2] [other] Stack-detection short-circuit when not JS/TS
  - Setup: run `npm run arch:refresh` on a Python-only fixture repo
  - Assert: stderr contains exactly `architectural-memory: Python extraction not yet supported (stack=python detected)`; stdout JSON `{"ok":true,"skipped":true,"reason":"unsupported-stack"}`; exit code 0; no DB writes

### Frontend acceptance

- [P0] [visibility] Generated `docs/architecture-map.md` exists and contains the sticky marker
  - Setup: `npm run arch:render`
  - Assert: file `docs/architecture-map.md` exists; first line is exactly `<!-- audit-loop:architectural-map -->`
- [P0] [text] Document header includes generated timestamp + commit SHA + refresh_id
  - Setup: `npm run arch:render`
  - Assert: file content matches regex `Generated: \d{4}-\d{2}-\d{2}T.*commit: [0-9a-f]{7,40}.*refresh_id: [0-9a-f-]{36}`
- [P0] [text] Document includes a drift score line
  - Setup: `npm run arch:render`
  - Assert: file content contains a line matching `Drift score: \d+ / threshold \d+`
- [P0] [navigation] Symbol path links resolve to existing files in the repo
  - Setup: `npm run arch:render`; parse all `[...](path#L\d+)` links from the Symbols tables
  - Assert: every linked path exists relative to the repo root; every line number is within the file's line count
- [P0] [text] Neighbourhood callout in /plan-* output uses callout-blockquote format
  - Setup: invoke `/plan-backend` with a task whose intent matches a seeded near-duplicate
  - Assert: plan output contains a blockquote (`> `) section starting with `**Neighbourhood considered**`
- [P0] [text] Empty-state copy appears when no near-duplicates found
  - Setup: invoke `/plan-backend` with a task whose target paths have no symbols in the index
  - Assert: plan output contains `No near-duplicates found`
- [P0] [text] Drift-sweep issue body uses the sticky marker
  - Setup: trigger `architectural-drift.yml` via `workflow_dispatch` on a state with score > threshold
  - Assert: opened GitHub issue body's first line is `<!-- audit-loop:architectural-drift -->`
- [P1] [a11y] Mermaid `classDef` styles include explicit `color:` for contrast
  - Setup: `npm run arch:render`
  - Assert: every `classDef` directive in the output includes both `fill:` and `color:` properties
- [P1] [text] Duplication clusters are marked in BOTH the table row and the Mermaid label
  - Setup: seed symbol_index with a 3-symbol cluster (cosine > 0.85); `npm run arch:render`
  - Assert: rendered file shows the cluster's symbols with `[DUP]` text in the table AND with the `dup` class applied in the Mermaid block
- [P1] [text] Domains with >50 symbols emit a summary diagram + flat table
  - Setup: seed a domain with 55 symbols; `npm run arch:render`
  - Assert: domain section contains exactly ONE `flowchart` block; that block contains ≤16 nodes; flat table that follows contains all 55 rows
- [P1] [text] Drift-sweep issue body collapses long tail under `<details>`
  - Setup: trigger workflow with state containing >5 duplication clusters
  - Assert: issue body contains `<details>` block with a `<summary>` line referencing "Long tail"
- [P1] [other] Render is deterministic across runs
  - Setup: `npm run arch:render`; commit; `npm run arch:render`
  - Assert: `git diff --exit-code docs/architecture-map.md` exits 0 after the second render
- [P2] [text] Footer includes "How to regenerate" + "How to interpret"
  - Setup: `npm run arch:render`
  - Assert: file contains both `## How to regenerate` and `## How to interpret` headings near EOF
- [P2] [text] Sticky-issue auto-close comment references "returned to green"
  - Setup: open then close drift sweep sticky issue (delete duplication seed; run workflow)
  - Assert: closure comment on the issue contains the literal string `returned to green`

### Coverage check (per plan-frontend §9 guidance)

- ≥1 P0 per primary user flow: Flow A (PR review of `architecture-map.md`),
  Flow B (plan output callout), Flow C (drift-sweep issue) — all covered.
- ≥1 a11y criterion per new surface: `classDef` colour assertion +
  duplication cluster dual-signal (text + colour).
- ≥1 state criterion: empty-state copy + cloud-off hint + RPC-error fail-open.
- ≥1 lifecycle criterion: snapshot isolation + abort-leaves-snapshot-intact.
- ≥1 security criterion: anon RLS read-only + service-role write.
- Responsive: not applicable (no mobile-vs-desktop layouts).

---

## 10. R1 + R2 + R3 + Gemini final audit response mapping

### Gemini final-review findings — Round 2 cap (2H + 2M + 1L)

The audit-plan skill caps Gemini final review at 2 rounds. Gemini round 2
returned CONCERNS with these 5 additional findings; all accepted, surgical
edits applied as v5 of the plan, no further re-review run (cap reached).

| ID | Severity | Resolution |
|---|---|---|
| G1-R2 — Snapshot promote not atomic via supabase-js | HIGH | §5 migration row updated — schema now ships a `publish_refresh_run(p_repo_id, p_refresh_id)` Postgres RPC that performs the `audit_repos` + `refresh_runs` updates in a single server-side transaction. PostgREST cannot multi-statement transact, so client-side multi-update was a real bug. |
| G2-R2 — `dependency-cruiser` is wrong tool for symbol extraction | HIGH | §1 What's new: new dep `ts-morph` for **AST-based intra-file symbol extraction**; `dependency-cruiser` retained for **file-to-file import graph + layering rules only**. §5 extract.mjs row split: ts-morph for symbols, dep-cruiser for graph. §5 package.json adds both deps. (This was a fundamental tool mismatch in earlier drafts that survived 4 rounds.) |
| G3-R2 — In-memory cache no-op in ephemeral CLI | MEDIUM | §3 Query path step 7 — cache moved to disk at `.audit-loop/cache/intent-embeddings.json`; gitignored. CLI processes are spawned per `/plan-*` invocation; in-memory cache lifetime was zero. |
| G4-R2 — Migration column list incomplete in §5 | MEDIUM | §5 migration row now lists every column added across R1+R2+R3: `active_refresh_id`, `active_embedding_model`, `active_embedding_dim`, `repo_uuid`, `cancellation_token`, `last_heartbeat_at`, `retention_class`. Plus the new `publish_refresh_run` RPC and the `kind_filter` parameter on `symbol_neighbourhood`. |
| G5-R2 — Sequencing-rule still said `<since>..HEAD` | LOW | §2 Sequencing rule step 3 aligned with the §2 Refresh-modes definition — uses `git diff --name-status <since>` (no `..HEAD`) UNION `git ls-files --others --exclude-standard`. |

### Gemini final-review findings — Round 1 (2 HIGH + 1 LOW)

| ID | Severity | Resolution |
|---|---|---|
| G1 — /ship's git-diff misses uncommitted changes | HIGH | §2 Refresh modes — incremental command now uses `git diff --name-status <since>` (no `..HEAD`) UNION `git ls-files --others --exclude-standard`. Working-tree visibility paragraph added. |
| G2 — Storing sentinel in embedding columns silently corrupts vector space | HIGH | §3 Query path step 3 — explicit "stored value is concrete model id, NEVER a sentinel". §3 decision #11 — embedding_model columns ALWAYS store resolved concrete provider id. `refresh.mjs` resolves sentinel once at refresh-start and persists concrete id. |
| G3 — `SymbolRecordSchema` missing `definitionId` | LOW | §5 Data and presentation contracts — `definitionId` field added to `SymbolRecordSchema`. |

### R3 findings (5 HIGH + 1 MEDIUM)

Final R3 round identified inconsistencies introduced by R2 fixes
themselves. Fixed via targeted edits (no R4 run, per skill's rigor-pressure
plateau rule — 5→5 HIGH plateaued; remaining work is the Gemini final
gate). Each R3 finding mapped:

| R3 ID | Severity | Resolution |
|---|---|---|
| H6 — Repo identity contradiction | HIGH | §2 Repository identity step 2 — repoUuid now derived from canonicalised origin URL ONLY (top-level path removed). Acceptance criterion "deterministic across clones" now satisfiable. |
| H7 — Incomplete embedding pinning | HIGH | §1 What's new — `audit_repos` gains paired `(active_embedding_model, active_embedding_dim)` pointer. §5 learning-store.mjs `setActiveEmbeddingModel(repoId, model, dim)` accepts both atomically; `getActiveEmbeddingModel` returns `{model, dim}`. |
| H8 — Embedding ownership inconsistency | HIGH | §3 decision #11 — `symbol_embeddings` keyed on `(definition_id, embedding_model, dimension)` (NOT `symbol_id`). §5 learning-store API renamed: `recordSymbolEmbedding(definitionId, model, dim, vector)`. Decision text and APIs now consistent with §2 stable identity. |
| H9 — Missing read interface | HIGH | §5 cross-skill.mjs subcommands now split into Writes + Reads. New read subcommands: `get-active-refresh-id`, `list-symbols-for-snapshot` (with kind/domain/path filters + pagination), `list-layering-violations-for-snapshot`. learning-store.mjs gains corresponding `listSymbolsForSnapshot` + `listLayeringViolationsForSnapshot`. |
| H10 — Unsafe forced cancellation | HIGH | §2 Concurrency model — `--force` semantics extended with cooperative cancellation. New columns on `refresh_runs`: `cancellation_token UUID`, `last_heartbeat_at TIMESTAMPTZ`. Workers check status + token before each batch and before publish; exit if aborted (rows orphaned, cleaned by next prune). `--force` waits up to 30s for prior worker via heartbeat. |
| M1 — Filter not wired E2E | MEDIUM | §5 Data contract — new `NeighbourhoodQueryArgsSchema` includes optional `kind` filter. `learning-store.getNeighbourhood` signature now accepts `kindFilter`. RPC `symbol_neighbourhood` signature updated to push filter into the SELECT (no post-hoc truncation). |

### R2 findings (5 HIGH + 1 MEDIUM)

| R2 ID | Severity | Resolution location |
|---|---|---|
| H7 — Stable symbol identity | HIGH | §2 "Stable symbol identity" subsection (new); §1 "What's new" mentions `symbol_definitions`; §5 schema extension; §6 R13; §9 R2-fix coverage (3 P0 criteria) |
| H8 — Graph lifecycle | HIGH | §2 Refresh modes — "Graph-derived artifacts always recompute" paragraph; §6 R17; §9 R2-fix coverage (1 P0 criterion) |
| H9 — Embedding compatibility | HIGH | §3 Query path — step 3 now loads active model from repo state; §2 failure matrix new `EMBEDDING_MISMATCH` row; §6 R16; §9 R2-fix coverage (2 P0/P1 criteria) |
| H10 — Auth contradiction | HIGH | §1 Sensitivity & access — anon-write fallback removed; §2 failure matrix new "Service-role missing" column; §5 cross-skill.mjs split into `getReadClient`/`getWriteClient`; §9 R2-fix coverage (1 P0 criterion) |
| H11 — Sensitive-data egress | HIGH | §2 "Sensitive content egress gate" subsection (new); §5 new file `scripts/lib/sensitive-egress-gate.mjs`; §6 R14; §9 R2-fix coverage (2 P0 criteria) |
| M5 — Snapshot retention | MEDIUM | §2 "Snapshot retention" subsection (new); §6 R15; §8 Phase D extended; §9 R2-fix coverage (3 P0/P1 criteria) |

R2 ambiguities resolved:
- Child-plan reconciliation — Plan header now states children archived in Phase A; merged plan is the only canonical artefact
- Pruning specificity — §2 "Snapshot retention" now defines retention classes, TTLs, scheduled prune via drift workflow
- Test substrate — §5 file plan + §7 testing strategy now require real Postgres + pgvector for integration tests; SQLite explicitly rejected

### R1 findings (6 HIGH + 4 MEDIUM)

Each R1 finding mapped to where this revision addresses it:

Each R1 finding mapped to where this revision addresses it:

| R1 ID | Severity | Resolution location |
|---|---|---|
| H1 — Snapshot isolation | HIGH | §2 "Snapshot publication model"; §5 schema (`refresh_runs`, `active_refresh_id`); §9 acceptance (3 P0 + 1 P1 criteria) |
| H2 — Refresh lifecycle | HIGH | §2 "Refresh modes" + sequencing rule; §5 schema (file inventory in refresh_runs); §9 acceptance (3 P0 criteria) |
| H3 — Query embedding path | HIGH | §3 "Query path for plan-time consultation"; §5 new file `scripts/lib/neighbourhood-query.mjs`; §9 acceptance (3 P0 criteria) |
| H4 — /ship integration | HIGH | §1 (existing /ship pattern); §5 modified `skills/ship/SKILL.md`; §8 Phase F; §9 acceptance (2 P0 criteria) |
| H5 — RLS | HIGH | §1 "Sensitivity & access model" with threat model; §5 schema (anon-read-only, service-role-write); §6 R12; §9 acceptance (2 P0 criteria); §8 Phase F for per-repo predicates |
| H6 — Stable repo identity | HIGH | §2 "Repository identity"; §5 new file `scripts/lib/repo-identity.mjs`; §9 acceptance (2 P0 criteria) |
| M1 — Cache invalidation | MEDIUM | §3 decision #4 + §6 R4 update (composes body checksum); §9 (test coverage in `tests/symbol-index.test.mjs`) |
| M2 — Failure matrix | MEDIUM | §2 "Failure matrix" table |
| M3 — Data/presentation contracts | MEDIUM | §5 "Data and presentation contracts" with full Zod schemas; §5 new file `scripts/lib/symbol-index-contracts.mjs` |
| M4 — Versioned embeddings | MEDIUM | §3 decision #11; §4 "Encoded assumptions" updated; §5 schema (`symbol_embeddings` child table); §6 R2 update; §9 acceptance (1 P1 criterion) |

R1 ambiguities resolved:
- "mirror exactly" (memory-health) — §1 Patterns table now lists every behaviour copied
- "friendly warning" (R3) — §6 R3 now specifies exact stderr text + JSON shape + exit code
- "top N by domain" (audit-code) — §5 modified-files row now defines ordering rule
- "emit a one-line hint and continue" — §2 failure matrix specifies copy + path per surface
- "learning-store.mjs is the swap point" — §4 lists the exact methods that form the abstraction boundary

---

## Cross-references

- [architectural-memory-backend.md](./architectural-memory-backend.md) — earlier backend draft (per-file detail; pre-R1)
- [architectural-memory-frontend.md](./architectural-memory-frontend.md) — earlier rendered-surface draft (wireframes, state map; pre-R1)
- Predecessor: `scripts/memory-health.mjs` + `.github/workflows/memory-health.yml`
- Cross-skill loop: `supabase/migrations/20260419120000_cross_skill_data_loop.sql`
- Cross-skill writer pattern: `scripts/cross-skill.mjs`
- Model resolution: `scripts/lib/model-resolver.mjs`
- LLM wrapper pattern: `scripts/lib/llm-wrappers.mjs`
- Atomic writes: `scripts/lib/file-io.mjs`
- Existing /ship skill: `skills/ship/SKILL.md`
