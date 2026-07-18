# Plan: Port `/security-strategy` skill to audit-loop (Postgres + Azure + corporate-hardened)

- **Date**: 2026-05-29
- **Status**: **Complete** — Phases 1–6 implemented, tested, persona-verified, and formally audited (2026-05-30 session 2: GPT-5.3 audit ran the full 3-round cap; all genuine R1/R2/R3 findings fixed — 7 total; **Opus 4-6 APPROVE** on an honest post-fix transcript (its 2 pass-2 advisories verified as non-issues); 161/161 tests green). Both open QA follow-ups closed: the `/audit-code` gate + the Azure-Postgres pgvector-ON CI job (`.github/workflows/pgvector-azure-ci.yml`). See the 2026-05-30 (session 2) entry in the Implementation Log.
- **Author**: Claude + Louis
- **Scope**: backend (schema + ESM scripts + cross-skill RPC + skill spec) + light frontend (no UI surface)
- **Target domains**: storage, cross-skill, scripts/security-memory, lib/store, lib/db
- **Source repo**: lifted from `github.com/Lbstrydom/claude-engineering-skills`
- **Upstream agent brief**: full inventory captured in this session's transcript (~860 LOC port surface)
- **Local files staged by upstream agent**: `C:\Temp\sec\` — `skill.md`, `parse-strategy.mjs`, `refresh-incidents.mjs`, `incident-status.mjs`, `lib-store-security.mjs`, `migration.sql`, `strategy-doc.md`

---

## 1. Context Summary

**The gap**: `/security-strategy` exists in `.claude/skills/security-strategy/` but is dead code in audit-loop:

| Check | State |
|---|---|
| `docs/security-strategy.md` (source of truth) | Does not exist |
| `npm run security:refresh` | Not in package.json |
| `scripts/security-memory/*` | Does not exist |
| `scripts/lib/store/security.mjs` | Does not exist |
| `cross-skill.mjs::get-incident-neighbourhood` | Does not exist |
| Postgres table `security_incidents` | Does not exist in 001-core.pg.sql |

The skill's SKILL.md still mentions "Supabase index". This audit-loop repo uses Postgres only (per CLAUDE.md / AGENTS.md). All LLM calls go through Azure AI Foundry — direct Gemini / OpenAI / Anthropic API calls are forbidden.

**Why port instead of rewrite**: the upstream is already ~80% pg-native (`lib/store/security.mjs` even has comments documenting its postgres-parity migration). Pure modules (`parse-strategy.mjs`, `incident-status.mjs`) port byte-for-byte. The real work is (a) swapping Gemini → Azure embeddings, (b) wiring the cross-skill RPC into audit-loop's `cross-skill.mjs`, and (c) adding corporate hardening. A rewrite would re-derive battle-tested code with regression tests upstream.

---

## 2. Decisions captured (session 2026-05-29)

| Decision | Choice | Rationale |
|---|---|---|
| **Branch-gating mode** | Feature branches UPSERT incidents (additive — `/plan` sees them during PR review); sweep (mark removed-from-md as `historical`) runs ONLY when current branch is `main` | Matches corporate "PR required" workflow. UPSERT is safe on branches (the markdown is the source of truth; DB is a derived index). Sweep gated to `main` prevents ephemeral branch edits from wiping canonical history. |
| **Secret-detected behaviour at write** | **Hybrid**: refuse on high-confidence patterns (API key shapes, JWT, AWS keys), auto-redact on low-confidence (emails, names) with loud warning | Belt + suspenders. High-confidence patterns are unambiguous and a refusal forces the operator to fix the markdown; low-confidence patterns are noisier and refusal would block legitimate incidents. |
| **Embedding provider** | Azure OpenAI `text-embedding-3-small` with `dimensions: 768` parameter | Honours audit-loop's "all LLM via Azure AI Foundry" rule. Native dim is 1536 but the API supports `dimensions` reduction. Schema stays `VECTOR(768)` matching upstream Gemini-768 layout. |
| **pgvector availability** | **Runtime-detected, optional** | Local dev Postgres 17.9 doesn't have pgvector installed or available. Azure Postgres Flexible Server does. Migration uses `CREATE EXTENSION IF NOT EXISTS vector` guarded by a runtime check; if pgvector is absent, the `embedding` column is omitted (NULL) and cross-skill retrieval falls back to keyword/path overlap ranking. |

---

## 3. pgvector probe finding (2026-05-29)

```sql
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'; -- 0 rows
SELECT name, default_version FROM pg_available_extensions WHERE name = 'vector'; -- 0 rows
SELECT version(); -- PostgreSQL 17.9 on x86_64-windows
```

**Local dev: pgvector neither installed nor available to install.** This is a Windows-native Postgres install missing the pgvector binaries. Azure Postgres Flexible Server tiers we use in prod do ship pgvector — verify in the target env before assuming embeddings are enabled.

**Install steps for local dev (Windows + Postgres 17)** — defer to consumer:

1. Download pgvector binaries: https://github.com/pgvector/pgvector/releases → `pgvector-x.y.z-pg17-windows-x64.zip`
2. Copy `vector.dll` → `<pg-install>/lib/`
3. Copy `vector--*.sql` + `vector.control` → `<pg-install>/share/extension/`
4. `psql -d audit_loop -c 'CREATE EXTENSION vector;'`
5. Verify: `SELECT extversion FROM pg_extension WHERE extname = 'vector';`

---

## 4. Proposed Architecture

### 4.1 Pipeline (end-to-end)

```mermaid
flowchart LR
  SM[docs/security-strategy.md\nmarkdown source of truth]:::doc
  P["parse-strategy.mjs\nHTML-comment-bounded → incidents/threats"]:::pure
  RI[refresh-incidents.mjs\nnpm run security:refresh]:::cli
  IS[incident-status.mjs\nsemgrep per mitigation_ref]:::pure
  AE[Azure OpenAI Embedding\ntext-embedding-3-small @ dim=768]:::svc
  SCH["Schema: security_incidents\n+ security_strategy_events\n+ incident_quarantine when branch≠main"]:::db
  RPC[Postgres function:\nincident_neighbourhood/4]:::db
  XS[cross-skill.mjs\nget-incident-neighbourhood]:::cli
  PLAN[/plan Phase 0.5c\nthreat-relevant incidents]:::skill

  SM --> P
  P --> RI
  IS --> RI
  RI --> AE
  RI --> SCH
  RPC --> XS
  XS --> PLAN
  SCH -.-> RPC

  classDef doc fill:#e8f4ff,stroke:#0066cc
  classDef pure fill:#e8ffe8,stroke:#008800
  classDef cli fill:#fff4e0,stroke:#cc6600
  classDef svc fill:#fff0c0,stroke:#a87000
  classDef db fill:#f0e0ff,stroke:#7000a8
  classDef skill fill:#ffe0d0,stroke:#c44000
```

### 4.2 Schema design — `security_incidents` with corporate hardening

> **Phase relationship**: Phase 5 (already shipped, commit `0164058`) built a
> lightweight `security_incident_log` table in `001-core.pg.sql` to make the
> skill operational immediately. The full `security_incidents` + `security_strategy_events`
> tables below are built in Phase 1 via `002-security.pg.sql` (separate migration file).
> Both tables coexist; `security_incident_log` remains as an append-only heartbeat trail.

```sql
-- 002-security.pg.sql — applied by Phase 1 migration runner
-- Base table: no VECTOR type — embedding column added conditionally below

CREATE TABLE IF NOT EXISTS security_incidents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id             UUID NOT NULL REFERENCES audit_repos(id) ON DELETE CASCADE,
  incident_id         TEXT NOT NULL,                          -- INC-NNN per-repo
  description         TEXT NOT NULL,
  affected_paths      TEXT[] NOT NULL DEFAULT '{}',
  mitigation_ref      TEXT,                                   -- semgrep:rule-id | scripts/path | manual
  mitigation_kind     TEXT NOT NULL DEFAULT 'manual'
                        CHECK (mitigation_kind IN ('semgrep', 'manual', 'file-ref')),
  status              TEXT NOT NULL DEFAULT 'manual-verification-required'
                        CHECK (status IN ('mitigation-passing', 'mitigation-failing',
                                          'manual-verification-required', 'historical')),
  lessons_learned     TEXT,

  -- Audit-loop corporate hardening (new, beyond upstream):
  commit_sha          TEXT NOT NULL,                          -- mandatory git linkage; no orphan incidents
  classification      TEXT NOT NULL DEFAULT 'Internal'
                        CHECK (classification IN ('Public', 'Internal', 'Confidential')),
  compliance_tags     TEXT[] NOT NULL DEFAULT '{}',           -- ['PII', 'payment', 'PHI', 'GDPR', 'PCI']

  -- Embedding columns: only populated when pgvector available (added conditionally below).
  -- embedding        VECTOR(768)  — NOT declared here; added via ALTER TABLE DO block
  embedding_model     TEXT,                                   -- e.g. 'azure-openai/text-embedding-3-small-768'
  embedding_dim       INTEGER,                                -- must equal actual embedding length before insert

  -- Change detection + audit:
  source_fingerprint  TEXT NOT NULL,                          -- sha256 of canonical incident block
  status_check_at     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (repo_id, incident_id)
);

CREATE INDEX IF NOT EXISTS idx_security_incidents_repo ON security_incidents(repo_id);
CREATE INDEX IF NOT EXISTS idx_security_incidents_fingerprint ON security_incidents(source_fingerprint);

-- Conditionally add VECTOR column + index when pgvector is available.
-- FIRST try to install the extension, THEN check if it actually loaded.
-- This handles both "already installed" and "available to install but not yet installed" cases.
-- The DO block is idempotent — re-running the migration is safe.
DO $$
BEGIN
  -- Attempt to load pgvector (no-op if already installed; silently skips if unavailable):
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION WHEN OTHERS THEN
    -- pgvector binaries not present — proceed without embedding column
    RAISE NOTICE 'pgvector extension unavailable (%). Proceeding without embedding column.', SQLERRM;
  END;

  -- Now check if it actually loaded:
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'security_incidents' AND column_name = 'embedding'
    ) THEN
      ALTER TABLE security_incidents ADD COLUMN embedding vector(768);
    END IF;
    -- HNSW index: safe to create on empty or populated table (no min-row requirement).
    -- Default params (m=16, ef_construction=64) are appropriate for v1.
    -- Tune m/ef_construction after initial data load if retrieval latency is observed.
    CREATE INDEX IF NOT EXISTS idx_security_incidents_embedding
      ON security_incidents USING hnsw (embedding vector_cosine_ops);
  END IF;
END $$;

-- Audit-trail table (new, corporate requirement):
CREATE TABLE IF NOT EXISTS security_strategy_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id         UUID NOT NULL REFERENCES audit_repos(id) ON DELETE CASCADE,
  incident_id     TEXT NOT NULL,                              -- INC-NNN (FK soft — incident may be historical)
  event_kind      TEXT NOT NULL
                    CHECK (event_kind IN ('inserted', 'updated', 'embedding_rebuilt',
                                          'marked_historical', 'refused_secret', 'redacted_secret')),
  who             TEXT,                                       -- $USER / git config user.name
  branch          TEXT NOT NULL,                              -- e.g. 'main' or 'feature/foo'
  commit_sha      TEXT,
  detail          JSONB NOT NULL DEFAULT '{}',                -- redacted by redactSecrets() before insert
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_security_strategy_events_repo ON security_strategy_events(repo_id, created_at DESC);

-- Cosine-distance neighbourhood RPC.
-- Created unconditionally — caller passes p_intent_embedding = NULL when pgvector absent.
-- VECTOR type in the parameter list requires pgvector; guard with DO block:
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE $func$
      CREATE OR REPLACE FUNCTION incident_neighbourhood(
        p_repo_id          UUID,
        p_target_paths     TEXT[],
        p_intent_embedding vector(768),
        p_k                INTEGER DEFAULT 8
      ) RETURNS TABLE (
        id              UUID,
        incident_id     TEXT,
        description     TEXT,
        affected_paths  TEXT[],
        status          TEXT,
        classification  TEXT,
        compliance_tags TEXT[],
        similarity      NUMERIC,
        path_overlap    INTEGER
      ) LANGUAGE SQL STABLE AS $fn$
        SELECT
          si.id, si.incident_id, si.description, si.affected_paths,
          si.status, si.classification, si.compliance_tags,
          CASE WHEN p_intent_embedding IS NULL THEN NULL
               ELSE (1 - (si.embedding <=> p_intent_embedding))::NUMERIC
          END AS similarity,
          cardinality(ARRAY(SELECT unnest(si.affected_paths) INTERSECT SELECT unnest(p_target_paths)))::INTEGER
            AS path_overlap
        FROM security_incidents si
        WHERE si.repo_id = p_repo_id
          AND si.status != 'historical'
          AND (p_intent_embedding IS NULL OR si.embedding IS NOT NULL)
        ORDER BY path_overlap DESC, similarity DESC NULLS LAST
        LIMIT p_k
      $fn$
    $func$;
  END IF;
END $$;

-- When pgvector is absent, cross-skill.mjs uses a plain SQL fallback (path-overlap only):
-- SELECT ... FROM security_incidents WHERE repo_id=$1 AND status!='historical'
-- ORDER BY cardinality(...) DESC LIMIT $k

-- schema_version bump: Phase 5 (001-core.pg.sql) inserted v=4.
-- This migration (002-security.pg.sql) inserts v=5.
-- ON CONFLICT DO NOTHING makes it idempotent if re-run.
INSERT INTO schema_version (v) VALUES (5) ON CONFLICT DO NOTHING;
```

**Mandatory `commit_sha`**: every memory item traces to a real fix in git history. The skill's `add-incident` interactive mode prompts for `--commit <sha>` and `add-incident from-commit <sha>` pre-fills it. The migration adds the column with `NOT NULL` so no orphan rows can exist.

**`classification` enum**: an organisation-specific document-classification convention. `Internal` default — safe baseline. `Confidential` for memory tied to customer data, payment, or regulated material. CHECK constraint enforces the closed set.

**`compliance_tags TEXT[]`**: open-vocabulary tags for regulated-data flagging (`PII`, `payment`, `PHI`, `GDPR`, `PCI`). Used by `/plan` Phase 0.5c to elevate matched incidents to higher-priority review.

### 4.3 Branch-gating logic

```javascript
// scripts/security-memory/refresh-incidents.mjs (port)
function currentBranch() {
  try {
    return execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function currentCommitSha() {
  try {
    return execFileSync('git', ['log', '-1', '--format=%H'], { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

const branch = currentBranch();
// commit_sha: prefer --commit <sha> CLI flag; fall back to HEAD sha; fail loudly if git unavailable
const commitSha = flags.commit || currentCommitSha();
if (!commitSha) throw new Error('commit_sha required: run from inside a git repo or pass --commit <sha>');
// NOTE: --commit <sha> is the preferred input when documenting a specific fix commit.
// The HEAD fallback is appropriate for new/ongoing incidents with no specific fix
// commit yet (e.g. theoretical threat model entries at bootstrap time).
const allowSweep = branch === 'main';

// Always UPSERT incidents present in the markdown — feature branches contribute too.
await upsertIncidents(incidents, { branch, commitSha });

// Only sweep (mark removed-from-md as 'historical') when on main.
if (allowSweep && parseWarnings.length === 0) {
  await markHistorical(removedFromMarkdown, { reason: 'absent-from-main-markdown' });
} else if (parseWarnings.length > 0) {
  warn(`Sweep skipped — ${parseWarnings.length} parse warning(s). Resolve before merging.`);
} else {
  info(`Sweep skipped — current branch is "${branch}" (sweep gated to main).`);
}
```

### 4.4 Secret-handling logic (hybrid refuse + redact)

```javascript
// scripts/lib/security/secret-classifier.mjs (new)
const HIGH_CONFIDENCE = [
  /sk-[a-zA-Z0-9]{32,}/g,                         // OpenAI keys
  /AKIA[0-9A-Z]{16}/g,                            // AWS access keys
  /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\./g,     // JWTs
  /xox[bpoa]-[a-zA-Z0-9-]{10,}/g,                 // Slack tokens
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

const LOW_CONFIDENCE = [
  /[\w._-]+@[\w.-]+\.\w{2,}/g,                    // emails
  /\b[A-Z][a-z]+ [A-Z][a-z]+\b/g,                 // proper names (loose)
  /\b\d{3}[-\s]?\d{3}[-\s]?\d{4}\b/g,             // phone numbers
];

export function classifySecrets(text) {
  const hits = { highConfidence: [], lowConfidence: [] };
  for (const re of HIGH_CONFIDENCE) {
    // Use matchAll (global flag) to catch all occurrences, not just the first
    for (const m of text.matchAll(re)) {
      hits.highConfidence.push({ pattern: re.source, sample: m[0].slice(0, 6) + '…' });
    }
  }
  for (const re of LOW_CONFIDENCE) {
    for (const m of text.matchAll(re)) {
      hits.lowConfidence.push({ pattern: re.source, sample: m[0].slice(0, 6) + '…' });
    }
  }
  return hits;
}

export function preWriteSecretGate(content) {
  const c = classifySecrets(content);
  if (c.highConfidence.length > 0) {
    return {
      ok: false,
      kind: 'refused',
      detail: `High-confidence secret pattern(s) detected: ${c.highConfidence.map(h => h.pattern).join(', ')}. Edit the markdown to remove and retry.`,
      events: c.highConfidence.map(h => ({ event_kind: 'refused_secret', detail: { pattern: h.pattern, sample: h.sample } })),
    };
  }
  if (c.lowConfidence.length > 0) {
    const redacted = redactSecrets(content); // existing sanitizer
    return {
      ok: true,
      kind: 'redacted',
      content: redacted,
      warning: `Low-confidence patterns auto-redacted: ${c.lowConfidence.length} hit(s).`,
      events: c.lowConfidence.map(h => ({ event_kind: 'redacted_secret', detail: { pattern: h.pattern, sample: h.sample } })),
    };
  }
  return { ok: true, kind: 'clean', content, events: [] };
}
```

### 4.5 Embedding optionality (runtime pgvector detection)

```javascript
// scripts/lib/security/pgvector-check.mjs (new)
let _cached = null;
export async function pgvectorAvailable(pool) {
  if (_cached !== null) return _cached;
  try {
    const r = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    _cached = r.rowCount > 0;
  } catch { _cached = false; }
  return _cached;
}

// In refresh-incidents.mjs:
const hasVector = await pgvectorAvailable(pool);
if (hasVector) {
  for (const inc of changedIncidents) {
    const vec = await azureEmbed(inc.description); // returns number[], length=768
    if (vec.length !== 768) throw new Error(`Unexpected embedding dim ${vec.length} for ${inc.incident_id}`);
    inc.embedding = vec;
    inc.embedding_dim = vec.length;   // stored alongside; runtime assertion for future reads
    inc.embedding_model = 'azure-openai/text-embedding-3-small-768';
  }
} else {
  warn('pgvector not installed — skipping embeddings. Cross-skill retrieval falls back to keyword/path overlap.');
  for (const inc of changedIncidents) {
    inc.embedding = null;
    inc.embedding_dim = null;
    inc.embedding_model = null;
  }
}
```

### 4.6 Cross-skill RPC entry point

```javascript
// scripts/cross-skill.mjs (new sub-command)
case 'get-incident-neighbourhood': await cmdGetIncidentNeighbourhood(flags, store); break;

async function cmdGetIncidentNeighbourhood(flags, store) {
  const repoName = flags.repo || repoName();
  const targetPaths = (flags.paths || '').split(',').filter(Boolean);
  const intentText = flags['intent-text'] || null;
  const k = Number(flags.k || 8);

  const hasVector = await pgvectorAvailable(getPool());
  let intentEmbedding = null;
  if (hasVector && intentText) intentEmbedding = await azureEmbed(intentText);

  const rows = await store.queryIncidentNeighbourhood({
    repoName,
    targetPaths,
    intentEmbedding,
    k,
  });
  out({ ok: true, cloud: true, mode: hasVector ? 'embedding+path' : 'path-only', rows });
}
```

---

## 5. File-by-file Port Plan

### Lift verbatim from upstream (75% of port)

| Upstream file | Disposition | Notes |
|---|---|---|
| `.claude/skills/security-strategy/SKILL.md` | **Edit** language "Supabase index" → "Postgres index"; ensure write-protocol matches new schema fields | Already partially present in audit-loop |
| `docs/security-strategy.md` (template) | **Lift verbatim** (3.9KB) | New file — doesn't exist in audit-loop |
| `scripts/security-memory/parse-strategy.mjs` (~210 LOC) | **Lift verbatim** | Pure, no DB deps |
| `scripts/security-memory/incident-status.mjs` (~155 LOC) | **Lift verbatim** | Pure + semgrep shellout |
| `tests/incident-neighbourhood.test.mjs` + `tests/incident-status.test.mjs` (~12.8KB) | **Lift verbatim** | No Supabase coupling |

### Adapt (25% of port)

| Upstream file | Adaptation | LOC delta |
|---|---|---|
| `scripts/security-memory/refresh-incidents.mjs` (~310 LOC) | Import path repointing; Gemini → Azure embedding swap; add branch-gating + pre-write secret gate + commit_sha capture; emit audit-trail events | ~60 LOC modified |
| `scripts/lib/store/security.mjs` (~165 LOC) | Already pg-native; just rename imports to audit-loop's `lib/db/query.mjs`; add classification + compliance_tags pass-through; add quarantine no-op fallback | ~20 LOC modified |
| `supabase/migrations/...security_incidents.sql` (~6.3KB) | → `scripts/lib/stores/sql/002-security.pg.sql`: drop Supabase RLS + GRANTs; add corporate-hardening columns; bump schema_version 3 → 4; pgvector EXTENSION + index guarded | ~80 LOC modified |
| `cross-skill.mjs` | Add `get-incident-neighbourhood` sub-command (~50 LOC) + adapter call | +50 LOC new |

### New (audit-loop-specific)

| File | Purpose | LOC |
|---|---|---|
| `scripts/lib/security/secret-classifier.mjs` | Hybrid high/low confidence secret detection + redact-or-refuse gate | ~80 |
| `scripts/lib/security/pgvector-check.mjs` | Runtime pgvector availability cache | ~20 |
| `scripts/lib/security/azure-embed.mjs` | Azure OpenAI text-embedding-3-small @ dim=768 wrapper | ~50 |
| `tests/secret-classifier.test.mjs` | High/low confidence classification + gate behaviour | ~100 |
| `tests/pgvector-fallback.test.mjs` | Refresh with embeddings disabled → store writes succeed with embedding=NULL | ~60 |

### Helper modules — check audit-loop equivalents before lifting

| Upstream module | Audit-loop equivalent? | Action |
|---|---|---|
| `lib/repo-identity.mjs` | ✓ Exists | Use existing |
| `lib/assert-repo-root.mjs` | ✓ Exists | Use existing |
| `lib/cli-io.mjs` | ✓ Exists | Use existing |
| `lib/secret-patterns.mjs` | Likely partial (`sanitizer.mjs` exists) | Reuse `redactSecrets()`; layer the hybrid classifier on top |
| `lib/neighbourhood-query.mjs` (re-ranker) | ✗ Need to lift | Small (~50 LOC); fetch from upstream |

---

## 6. Implementation Phases

Execute in this order — each phase is a separate PR for clean review.

### Phase 0 — pre-flight (no code)

- Confirm pgvector availability in the target Azure Postgres production deployment (probe via psql)
- Document Windows pgvector install steps for local dev (already captured in section 3)
- Tag this plan as `Status: Approved` after `/audit-plan` round

### Phase 1 — schema + helpers (no skill changes yet)

1. Write `scripts/lib/stores/sql/002-security.pg.sql` with corporate hardening + pgvector guard
2. Write `scripts/lib/security/secret-classifier.mjs` + tests
3. Write `scripts/lib/security/pgvector-check.mjs` + tests
4. Write `scripts/lib/security/azure-embed.mjs` (Azure OpenAI client, `text-embedding-3-small`, dim=768)
5. Apply migration via `npm run db:setup-postgres`
6. Smoke test: insert one row directly via psql, confirm CHECK constraints fire correctly

### Phase 2 — parser + status + store

1. Lift `parse-strategy.mjs` verbatim → `scripts/security-memory/parse-strategy.mjs`
2. Lift `incident-status.mjs` verbatim → `scripts/security-memory/incident-status.mjs`
3. Adapt `lib/store/security.mjs` → `scripts/lib/store/security.mjs` (import repointing):
   - All INSERT/UPSERT operations for `security_incidents` MUST check BOTH conditions before
     including `embedding` in the column list:
     1. `pgvectorAvailable()` — the extension is loaded
     2. Column existence check: `SELECT 1 FROM information_schema.columns WHERE table_name='security_incidents' AND column_name='embedding'`
     Both must be true. The extension can be installed after the migration ran, leaving the column absent.
     When either check is false, omit `embedding` from the INSERT statement entirely — do NOT pass it as NULL.
   - `embedding_model` and `embedding_dim` are always-present columns (TEXT/INTEGER, nullable) —
     include them unconditionally; set to NULL when embedding is skipped.
4. Lift `tests/parse-strategy.test.mjs` + `tests/incident-status.test.mjs` (port if upstream tests exist)

### Phase 3 — refresh pipeline

1. Lift `refresh-incidents.mjs` → `scripts/security-memory/refresh-incidents.mjs` with adaptations:
   - Replace Gemini embed call with `azureEmbed()`
   - Add branch-gating before sweep
   - Validate `--classification` and `--compliance-tags` CLI flags against the closed enum BEFORE
     building any SQL: `if (!['Public','Internal','Confidential'].includes(classification)) throw`
   - Add `preWriteSecretGate()` before each upsert; the gate returns an `events` array.
     Insert every event from that array into `security_strategy_events` as part of the
     same transaction as the incident upsert (atomically). If the gate returns `ok: false`
     (refused), insert the `refused_secret` event but do NOT upsert the incident.
   - Add `security_strategy_events` audit trail insert per write
   - Add `commit_sha` capture (`git log -1 --format=%H` if not passed)
   - Add `classification` + `compliance_tags` pass-through
   - Call `pool.end()` in a `finally` block before process exit (prevent dangling connections)
   - Exit code: `process.exit(failedEmbeds.length > 0 ? 2 : 0)` — exit 1 on any Postgres write failure
2. Add `npm run security:refresh` script to `package.json`
3. Smoke test: build fixture `docs/security-strategy.md`, run refresh, verify DB rows + audit events

### Phase 4 — cross-skill RPC

1. Add `get-incident-neighbourhood` command to `scripts/cross-skill.mjs`
2. Lift `lib/neighbourhood-query.mjs` (re-ranker) if needed
3. Validate the `--json` input object against a Zod schema (`z.object({ targetPaths: z.array(z.string()), intentDescription: z.string().optional(), k: z.number().int().optional() })`) before calling the store — reject with exit 1 and a clear error message on schema mismatch
4. Test: query via CLI with fixture data, verify path overlap ranking works without embeddings (pgvector-off case), then with embeddings (pgvector-on case)

### Phase 5 — skill spec + /plan integration

1. Adapt `.claude/skills/security-strategy/SKILL.md`:
   - Replace all "Supabase" language with "Postgres"
   - Document `commit_sha` requirement
   - Document `classification` + `compliance_tags` prompts in `add-incident` flow
   - Document branch-gating behaviour ("sweep only on main")
2. Update `/plan` SKILL.md Phase 0.5b/0.5c (if it exists in audit-loop) to call `get-incident-neighbourhood`
3. Update `/ship` Step 6.5 — keep the existing conditional (still gated on `docs/security-strategy.md` exists), update language Supabase → Postgres
4. Add `docs/security-strategy.md` template via `/security-strategy bootstrap` (first invocation creates it)

### Phase 6 — dashboard

1. Add a `Security` section to the dashboard's telemetry tab — incident counts per classification, last refresh ts, recent audit events
2. Same pattern as the Learning section just landed (commit `fba25eb`): collector → schema → renderer
3. Optional for v1; can defer to follow-up if scope pressure

---

## 7. Acceptance Criteria

Each must be a lockable behaviour testable via existing `node:test` patterns.

1. `parseSecurityStrategy(markdown)` returns the same `{threatModel, incidents[], warnings[]}` shape as upstream — port test fixtures byte-for-byte.
2. `preWriteSecretGate('contains sk-abc123...')` returns `{ok: false, kind: 'refused'}` with the matching pattern named.
3. `preWriteSecretGate('contact john@acme.com about X')` returns `{ok: true, kind: 'redacted'}` with `john@acme.com` replaced.
4. `preWriteSecretGate('all clean text here')` returns `{ok: true, kind: 'clean'}`.
5. `pgvectorAvailable(pool)` returns `true` when extension installed, `false` otherwise. Cached per-process.
6. Migration applies cleanly on a Postgres WITH pgvector → schema_version row v=5 + `vector` extension present + `embedding` column exists on `security_incidents` + HNSW index created.
7. Migration applies cleanly on a Postgres WITHOUT pgvector → schema_version row v=5 + `embedding` column absent from `security_incidents` + no vector index created + `incident_neighbourhood` function not created.
8. `refresh-incidents.mjs` on branch=feature/foo with fixture markdown containing one new incident: UPSERTs the new row, does NOT mark any existing rows historical even if absent from markdown.
9. `refresh-incidents.mjs` on branch=main with same fixture: UPSERTs AND marks the absent rows as `status='historical'`.
10. `refresh-incidents.mjs` exit code is 2 when pgvector IS available and any incident failed to embed (upstream CI gate contract). Failure aggregation: collect all embed errors, continue processing remaining incidents, then check `failedEmbeds.length > 0` before exit — `process.exit(failedEmbeds.length > 0 ? 2 : 0)`. When pgvector is absent, embedding is skipped; exit code is 0.
11. `cross-skill.mjs get-incident-neighbourhood --repo X --paths a,b --k 5`: returns at most 5 rows sorted by path_overlap DESC, similarity DESC NULLS LAST.
12. Every write to `security_incidents` produces a matching row in `security_strategy_events` with the correct `event_kind` and `branch`.
13. Inserting an incident without `commit_sha` fails with the NOT NULL constraint message.
14. `classification` set to a non-enum value (e.g. 'Open') is rejected by the CHECK constraint.

---

## 8. Risk & Trade-off Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| pgvector unavailable in production Azure Postgres tier | Low | High | Verify in pre-flight (Phase 0). If unavailable: skill ships in keyword-only mode permanently (degraded but functional). |
| Azure OpenAI `text-embedding-3-small` dim=768 reduction quality differs from Gemini-768 | Medium | Low | Both providers produce dense 768-dim vectors trained on large multilingual corpora; cosine-distance retrieval quality is comparable at this dimension. Accept the v1 quality risk; add eval fixtures in v2 if retrieval precision is reported as degraded. |
| Embedding rate limits | Low | Medium | Only re-embed on `source_fingerprint` change. Single-call per incident. Add backoff + retry via existing `lib/robustness.mjs::retryWithBackoff`. |
| Secret classifier false negative (high-confidence pattern misses a real key shape) | Medium | High | Layer: (1) high-confidence pattern list, (2) `redactSecrets()` defence in depth, (3) PR review enforces visibility. Expand patterns in follow-ups. |
| Secret classifier false positive (refuses legitimate text) | Low | Low | Operator gets clear error naming the pattern; can edit and retry. Worst case: a doc with legitimate `BEGIN PRIVATE KEY` example text — extraordinarily rare. |
| Branch detection fails (detached HEAD, rebase mid-flight) | Low | Medium | `currentBranch()` returns null → default to "non-main" → no sweep. Conservative. |
| `commit_sha NOT NULL` rejects bootstrap (first incident has no prior commit) | Low | Low | `/security-strategy bootstrap` uses `git log -1` for the initial seed commit OR `git rev-parse HEAD`. Operator with a fresh repo gets a clear error: commit anything first. |
| `security_incidents` schema lives in `public` alongside less-sensitive tables | Medium | Medium | Document the sensitivity. Consider moving to a separate `security` schema in v2 with stricter Postgres role grants. |
| Refresh script needs `gh`/git binary present | Low | Low | Already required by `/ship`. Add docs note. |

---

## Out of Scope (Future)

The following concerns were raised during `/audit-plan` and deferred — not blocking v1:

- **Schema-level `embedding_dim` constraint** (R3 LOW `2c43c74c`): `embedding_dim` is stored as an INTEGER column and validated in application code (`vec.length !== 768`), but not enforced at the Postgres level. A `CHECK (embedding_dim = 768)` constraint would catch embedding provider changes at write time. Deferred: `CHECK` constraints on compute-derived columns have maintenance overhead when the model changes; v1 trusts the application assertion, which is sufficient for a single embedding provider.

- **Consistent error-handling style in `security-incidents.mjs`** (Opus LOW): `cross-skill.mjs` uses a structured `err()` helper and JSON output. `security-incidents.mjs` uses `process.stderr.write` + `console.log`. Unifying these is a code-quality cleanup, not a correctness issue. Deferred to a later polishing pass when more Phase 1–4 scripts exist to establish a pattern.

---

## 9. Long-Term Sustainability

- **Schema columns are open enough** to add `severity` (planned for v2 — not in v1 to keep the surface tight; mitigation_kind + classification cover the headline taxonomy).
- **Embedding model swap**: `embedding_model` column captures the current model; on model change, set `source_fingerprint = NULL` for old rows to trigger re-embed on next refresh.
- **Multi-repo**: `repo_id` FK is the partition. Same schema serves multiple consumer repos without code change.
- **Removal**: if a /security-strategy skill needs to be retired, the table doesn't drop — incidents stay queryable via the cross-skill RPC even after the markdown source is removed.

---

## 10. Open Questions

All resolved 2026-05-29:

1. **`/plan` Phase 0.5c** ✅ Already exists — `.claude/skills/plan/SKILL.md` line 134 calls `get-incident-neighbourhood`. No change needed; Phase 4 RPC must satisfy that contract.
2. **`security_incidents.severity`** ✅ Deferred to v2. `mitigation_kind` + `classification` provide sufficient incident taxonomy for v1. Adding a severity column would require agreeing a closed enum before schema is locked.
3. **Sensitive schema isolation** ✅ Keep in `public` for v1. Moving to a dedicated `security` Postgres role/schema adds operational complexity with no immediate corporate requirement. Document the sensitivity in the migration comments; revisit in v2.
4. **Per-incident `confidentiality_expires_at`** ✅ Deferred to v2. Auto-decay of classification would require a background scheduler and a policy decision about decay windows — overengineering for a v1 port.

---

## 11. Files to be created or modified

```
scripts/security-memory/parse-strategy.mjs        ← NEW (lift verbatim, ~210 LOC)
scripts/security-memory/refresh-incidents.mjs     ← NEW (adapted, ~310 LOC + 60 LOC mods)
scripts/security-memory/incident-status.mjs       ← NEW (lift verbatim, ~155 LOC)
scripts/lib/store/security.mjs                    ← NEW (adapted, ~165 LOC + 20 LOC mods)
scripts/lib/security/secret-classifier.mjs        ← NEW (~80 LOC)
scripts/lib/security/pgvector-check.mjs           ← NEW (~20 LOC)
scripts/lib/security/azure-embed.mjs              ← NEW (~50 LOC)
scripts/lib/neighbourhood-query.mjs               ← NEW (lift verbatim if needed)
scripts/lib/stores/sql/002-security.pg.sql        ← NEW (adapted, ~80 LOC mods from upstream)
scripts/cross-skill.mjs                           ← EDIT (+50 LOC for get-incident-neighbourhood)
.claude/skills/security-strategy/SKILL.md         ← EDIT (Supabase → Postgres + corporate fields)
.github/skills/security-strategy/SKILL.md         ← EDIT (mirror)
docs/security-strategy.md                         ← NEW template (lift verbatim from upstream)
tests/parse-strategy.test.mjs                     ← NEW (lift verbatim)
tests/incident-status.test.mjs                    ← NEW (lift verbatim)
tests/incident-neighbourhood.test.mjs             ← NEW (lift verbatim, adapted)
tests/secret-classifier.test.mjs                  ← NEW (~100 LOC)
tests/pgvector-fallback.test.mjs                  ← NEW (~60 LOC)
package.json                                      ← EDIT (add `security:refresh` script)
.claude/skills/ship/SKILL.md                      ← EDIT (Step 6.5 language Supabase → Postgres)
.github/skills/ship/SKILL.md                      ← EDIT (mirror)
```

**Total**: ~1100 LOC of code (lifted + adapted + new) + ~260 LOC of tests + schema migration + skill text edits.

---

## Auditor / reviewer notes

- Upstream agent staged reference files at `C:\Temp\sec\` during session 2026-05-29; use those for direct comparison rather than re-fetching from GitHub.
- The "lift verbatim" claim assumes upstream upstream code passed audit in the personal repo's own /audit-code; verify by spot-checking the test files exist and pass when ported.
- `commit_sha NOT NULL` is a **forcing function**: it makes orphan incidents schema-impossible. If a future workflow needs orphan entries (e.g. theoretical threat models without a fix yet), revisit — but the default of forcing real-fix traceability is the corporate posture we want.
- Branch-gating + secret-refusal + audit-trail together form defence-in-depth: any one alone could be circumvented; all three together is hard. Don't drop one to simplify v1.

---

## Implementation Log

### 2026-05-29 — Phase 5 (skill spec) + lightweight audit trail

- **Completed**:
  - Rewrote `.claude/skills/security-strategy/SKILL.md` and `.github` mirror — removed all Supabase language, added corporate incident fields (`classification`, `compliance_tags`, `commit_sha`), branch-gate notice, and round-trip verify step (replaces the fictional `parseSecurityStrategy()` call).
  - Created `docs/security-strategy.md` template with `<!-- threat-model:start/end -->` and `<!-- incidents-list:start/end -->` markers.
  - Added `security_incident_log` table to `001-core.pg.sql` (schema v4) — lightweight audit trail recording who logged what and from which branch. Simpler than the full `security_incidents` table designed in §4.2 — sufficient to log the skill's operations without pgvector.
  - Created `scripts/security-incidents.mjs` — CLI for `npm run security:log` that inserts into `security_incident_log`. **Updated post-Opus review**: validates `classification` against `VALID_CLASSIFICATIONS` enum before INSERT; calls `pool.end()` in `finally` block; exits 1 (not 0) when Postgres unavailable — a compliance audit trail must not silently report success when nothing was written.
  - Added `security:log` npm script to `package.json`.
  - Updated `/ship` Step 6.5 in both `.claude` and `.github` copies to remove `npm run security:refresh` / Supabase language; now calls `npm run security:log` as the heartbeat.

- **Deviation from plan**: implemented `security_incident_log` (audit trail) rather than the full `security_incidents` table (§4.2). The full table with pgvector embeddings, neighbourhood RPC, and Azure embed integration is Phases 1–4 — deferred. The audit trail is sufficient to make the skill operational with traceable writes.

- **Two-table coexistence contract**: `security_incident_log` (Phase 5, lightweight) and `security_incidents` (Phase 1, full) serve different roles and coexist permanently:
  - `security_incident_log`: append-only heartbeat; written by `npm run security:log` on every `/ship` run; records who ran the skill, from which branch, and when.
  - `security_incidents`: structured incident index; written by `npm run security:refresh`; queryable by `/plan` Phase 0.5c for neighbourhood retrieval.
  - `/ship` Step 6.5 calls `security:log` (already updated); a future `/refresh` step can call `security:refresh` independently. The two scripts do not share write paths.

- **Remaining (Phases 1–4, 6)**:
  - `scripts/lib/stores/sql/002-security.pg.sql` — full `security_incidents` schema with pgvector guard
  - `scripts/security-memory/` — parse-strategy, refresh-incidents, incident-status
  - `scripts/lib/security/` — secret-classifier, pgvector-check, azure-embed
  - `cross-skill.mjs get-incident-neighbourhood` sub-command
  - Test files (parse-strategy, incident-status, incident-neighbourhood, secret-classifier, pgvector-fallback)
  - Dashboard: Security section in telemetry tab (Phase 6)

### 2026-05-30 — Phases 1–4 (schema + helpers + parser + store + refresh + cross-skill RPC)

- **Completed**:
  - **Phase 1**: `scripts/lib/stores/sql/003-security.pg.sql` (NOT `002` — that name was taken by arch-memory; this migration inserts `schema_version v=5`, satisfying acceptance criteria 6/7). Full `security_incidents` + `security_strategy_events` + `security_incident_neighbourhood()` RPC, all pgvector-guarded. Helpers: `scripts/lib/security/{secret-classifier,pgvector-check,azure-embed}.mjs`. Wired `003` into `setup-postgres.mjs` SQL_FILES.
  - **Phase 2**: `scripts/security-memory/{parse-strategy,incident-status}.mjs` (ported; parser EXTENDED to read the corporate `Classification` / `Compliance tags` / `Commit` fields). `scripts/lib/store/security.mjs` (adapted; conditional embedding column, path-overlap fallback, audit-trail events).
  - **Phase 3**: `scripts/security-memory/refresh-incidents.mjs` — Azure embed (pgvector-gated), per-incident secret gate (refuse high-confidence / redact PII), branch-gated sweep (main-only, clean-parse-only), atomic incident+event write (`withTx`), commit_sha capture, exit 2 on embed failure. Added `security:refresh` npm script.
  - **Phase 4**: `cross-skill.mjs get-incident-neighbourhood` — Zod-validated input (`--json` or flags), pgvector-aware (embedding+path vs path-only), intent text redacted before egress.
  - **Tests**: 5 new test files (parse-strategy, incident-status, secret-classifier, pgvector-fallback, incident-neighbourhood). Full suite green (157 tests, 0 fail; the DB integration test now runs after adding `import 'dotenv/config'`). Migration applied locally (pgvector absent → path-only fallback exercised). **E2E verified live against Postgres**: add (parsed=1/upserted=1/onMain), path-overlap query (INC-001, overlap=1, CONFIDENTIAL), high-confidence-secret refusal (refused=1/upserted=0), main-branch sweep (swept=1), and historical-resurrect (re-added incident returns).

- **Real bugs found + fixed during implementation** (caught by running the code + an early audit pass):
  - **Load-breaking bug**: `lib/store/security.mjs` imported a non-existent `getOrCreateRepoId` from `repo.mjs` → module failed to load. Switched to `getRepoIdByName` + `upsertRepo`, which also attaches security incidents to the existing audit repo row when present (no duplicate row).
  - **Resurrect bug**: a swept-historical incident re-added to the markdown stayed historical (unchanged fingerprint → upsert skipped). Now `priorHistorical` forces a status-only re-upsert that preserves any existing embedding.
  - **`--strategy` path bug**: `path.join(repoRoot, abs)` ignored an absolute flag value → switched to `path.resolve`.
  - Deterministic tie-break (`incident_id ASC`) in both the fallback SQL and the RPC; commit_sha→HEAD fallback logs a provenance warning; intent text redacted before Azure egress; documented atomic-refresh intent, the StorageAdapter-bypass deviation, the parseList comma limitation, and the self-healing null-embedding path.

- **Deviations from plan (documented)**:
  - Migration file `003-security.pg.sql` (not `002`); `classification` uses the UPPERCASE 4-value set `PUBLIC|INTERNAL|CONFIDENTIAL|RESTRICTED` (matches the shipped Phase 5 skill/docs/log) rather than §4.2's `Public/Internal/Confidential`; RPC named `security_incident_neighbourhood` to avoid colliding with the arch-memory `incident_neighbourhood` stub.
  - Parser extended (not byte-for-byte verbatim) to read corporate fields; the secret classifier's proper-name pattern is detect-only (not auto-redacted) to avoid corrupting incident prose.

- **Advisory (Opus LOW, deferred)**: the pgvector-ON path (azureEmbed + HNSW + similarity RPC) is unverified locally (Windows Postgres lacks pgvector) — needs an Azure-Postgres CI job (plan §6 Phase 0 pre-flight + §8 risk register). `schema_version` is non-monotonic (cosmetic; the migration ledger is the source of truth).

### 2026-05-30 — Phase 6 (dashboard Security section) + persona-test + honest final audit

- **Phase 6 completed**:
  - `scripts/lib/store/security.mjs::getSecurityStats(repoId)` — per-classification + per-status counts, embedding coverage, last-refresh timestamp, 10 most recent audit-trail events.
  - `collect-telemetry.mjs::collectSecurity()` (4th telemetry source) + `schema.mjs` security block (optional/defaulted so older payloads stay valid) + `render.mjs::sectionSecurity()` (three tables + summary line) registered in the telemetry tab.

- **persona-test (senior software engineer)** — drove the live dashboard with Playwright; found and **fixed a P2**: the dashboard keyed the security repo by package.json name while the writers key by git-remote name → it read a different, empty `repo_id` (the audit-trail section silently rendered nothing). Fix: extracted `scripts/lib/security/repo-name.mjs::securityRepoName()` as the single shared identity for refresh, cross-skill, and the dashboard collector. Re-verified live: 3 tables + 3 audit-trail rows render. Engineer's feature verdict: classification/status/audit-trail breakdown is useful for governance; deferred nice-to-haves: per-incident drill-down, link to docs/security-strategy.md, separate refused/redacted-secret counter.

- **Final audit-code (2026-05-30, full diff incl. Phase 6) — HONEST RESULT**: a single GPT-5.3 pass returned **SIGNIFICANT_ISSUES (12 HIGH / 15 MEDIUM / 7 LOW)**. The R2/Opus convergence rounds were NOT completed (the orchestration batch was interrupted), so this did **not** reach a formal CONVERGED/APPROVE verdict. Findings were adjudicated rather than auto-accepted:
  - **Fixed (in-scope, real):** shared `repo-name.mjs` helper (collapses the repo-name divergence + the M/L git-name duplication findings); `tests/azure-embed.test.mjs` mocking the OpenAI client to cover the dim-mismatch / empty-vector / empty-input guards (the only coverage of the otherwise-untested pgvector-ON write contract); `security-incidents.mjs` `execSync`→`execFileSync` [8]; `pgvector-check.mjs` probe constrained to `table_schema='public'` [19] and both probes now log the swallowed error cause [16]; corrected the security-strategy SKILL.md (both copies) "soft-fail (exit 0)" wording to match the code's intentional hard-fail (exit 1) so a compliance trail never reports false success [26].
  - **Adjudicated as out-of-scope (repo-wide conventions this code deliberately matches, not regressions this PR introduced):** "use yargs/commander" [5,27] — every CLI in the repo uses the same hand-rolled `parseFlags`; the one external input IS Zod-validated. Pool lifecycle/DI [6,24] — `getPool()`+`closePool()` in a one-shot CLI `finally` is the existing pattern. "God scripts/layering" [20,23], "central config module" [11,21], "structured logger" [18], "async child_process" [32], "shared embed-client factory" [30], "LRU on the per-run semgrep cache" [31] — valid repo-wide refactors logged as future tech-debt, not v1 blockers. "withTx not used" [7] — false: the refresh write block IS wrapped in `withTx`. Plan-path drift [1,2,3] — documented (003 not 002; `neighbourhood-query.mjs` folded into `store/security.mjs`). Frontend/API [4] — N/A (CLI/library, no HTTP surface).

- **Deviations from plan (documented)**: migration `003-security.pg.sql` (not `002`); `classification` UPPERCASE 4-value `PUBLIC|INTERNAL|CONFIDENTIAL|RESTRICTED` (matches shipped Phase 5); RPC named `security_incident_neighbourhood` (avoids the arch-memory `incident_neighbourhood` stub collision); parser extended (not verbatim) for corporate fields; secret classifier proper-name pattern is detect-only.

- **Tests**: full suite **161 tests / 161 pass / 0 fail**. Verified live against Postgres (pgvector absent → path-overlap fallback exercised end to end).

- **Honest status**: Phases 1–6 implemented + tested + persona-verified. The convergence loop was NOT completed to a clean verdict. Open QA follow-ups: (1) re-run `/audit-code` to a formal CONVERGED + Opus APPROVE; (2) Azure-Postgres CI job to exercise the pgvector-ON embedding path (azureEmbed + HNSW + similarity RPC) which is unverified locally (Windows Postgres lacks pgvector).

