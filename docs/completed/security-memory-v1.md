# Plan: Proactive Security Memory v1

- **Date**: 2026-05-04
- **Status**: Draft v6 (post R1+R2+R3 GPT + Gemini ×2 — 14H/18M/2L addressed; 1 medium deferred to v1.1 with rationale)
- **Author**: Claude + Louis
- **Scope**: backend
- **Stack**: js-ts (Node ESM)
- **Origin**: 2-round multi-LLM brainstorm (OpenAI gpt-5.5 + Gemini 3.1 Pro) refined down from 5-table proposal to single-table incident-log MVP

## 1. Context Summary

We have proactive **architectural** memory (per-repo Supabase symbol-index
consulted by `/plan` to prevent duplicate-function drift). We do not yet
have proactive **security** memory — i.e. durable per-repo security
context (past incidents, mitigation pointers) that the planner consults
at design time before proposing new code. Today every plan re-derives
"is this area sensitive?" from scratch and forgets between sessions.

### Brainstorm-extracted constraints

Both LLMs independently flipped from "DB-first is over-engineered" to
"v1 is right" once they understood we're piggybacking on an existing
embedding pipeline. The settled v1 design has 8 load-bearing decisions:

| Decision | Source |
|---|---|
| Markdown source-of-truth (`docs/security-strategy.md`); Supabase = embedding index | both LLMs r1 |
| Single new table (`security_incidents`); no threat-model / trust-boundaries / invariants tables in v1 | both LLMs r1 |
| Path-overlap-first retrieval; cosine-second; top-3 callouts max | OpenAI r2 |
| Intent-rephrasing fallback via Haiku ONLY when path-overlap empty (cost-bounded) | Gemini r2 (G2 — bridges intent-vs-incident embedding gap) |
| No `active` status — `mitigation-passing` only when Semgrep rule passes; everything else `manual-verification-required` | both r2 (false-comfort trap) |
| Capture path = post-PR `/ship` hook on security-relevant commits, NOT upfront bootstrap | OpenAI r2 |
| Repo-scoped only in v1 (no `Scope: repo \| org` flag yet) | both r2 |
| `/plan` integration via Phase 0.5b extension (alongside arch-memory neighbourhood callout, not new Phase 0.7) | this plan |

### Neighbourhood considered (consulted 2026-05-04)

8 candidates returned (sim 0.62-0.68, all `review` band). All are
existing `scripts/cross-skill.mjs` subcommand handlers — they're
**patterns to mirror**, not reuse:

| Candidate | Sim | Decision |
|---|---|---|
| `cmdGetNeighbourhood` (cross-skill.mjs) | 0.64 | **Mirror exactly** — template for new `cmdGetIncidentNeighbourhood`. Same input shape (targetPaths + intentDescription + k), same emit/emitError pattern, same store-disabled-graceful-degradation. |
| `cmdRecordSymbolEmbedding` | 0.68 | **Mirror** — embedding upsert pattern (resolve model via sentinel, store dim alongside vector). |
| `cmdRecordSymbolIndex`, `cmdRecordShipEvent`, `cmdUpsertPlan`, `cmdRecordCorrelation` | 0.62-0.64 | Bridge-write pattern (parse payload, validate, call learning-store helper, emit). |
| `getNeighbourhoodForIntent` (scripts/lib/neighbourhood-query.mjs) — not in neighbourhood top-8 but well-known | n/a | **Mirror** — composite-score RPC wrapper with embedding done client-side. New `getIncidentNeighbourhoodForIntent` follows same shape. |

**Mandatory reuse** (project conventions, not similarity-driven):
- `redactSecrets()` (scripts/lib/secret-patterns.mjs) — applied to any text egressed to LLM (intent-rephrasing prompt + embedding input)
- `chunk()` + `getWriteClient()` + `withRetry()` (learning-store.mjs) — bulk inserts of incidents, retry on transient errors
- `resolveModel()` (scripts/lib/model-resolver.mjs) — `latest-haiku` for rephrasing, `latest-flash`/`gemini-embedding-001` for embedding
- ivfflat index pattern from migration 20260501120000 — exact copy with `WHERE embedding IS NOT NULL` partial-index trick
- Migration RLS pattern: `ENABLE ROW LEVEL SECURITY` + `anon_read_*` SELECT policy + service-role-only writes (no anon-write policy)

### What exists today
- Supabase project `uahjjdelnnpfmaqjrwoz` with active `symbol_index`, `symbol_embeddings`, `symbol_file_imports`, `domain_summaries`, `refresh_runs`, `audit_repos` tables.
- `scripts/lib/neighbourhood-query.mjs` exposes `getNeighbourhoodForIntent({adapters, args, repoRoot})` — generic enough we can pass a different RPC name (`incident_neighbourhood`) and reuse the embedding + caching shell.
- `scripts/symbol-index/embed.mjs` Gemini embedding pattern (concrete model resolved at call time, cached on disk for repeats).
- `/plan` SKILL.md Phases 0.5 (arch-memory) + 0.5b (target domains) — natural insertion point for incident neighbourhood.
- `/ship` SKILL.md has post-push hooks (the existing arch:refresh trigger). New security capture prompt fits same pattern.

## 2. Proposed Architecture

### Data model — one table only

```sql
CREATE TYPE security_mitigation_kind_t AS ENUM ('semgrep', 'manual', 'file-ref');
CREATE TYPE security_status_t AS ENUM (
  'mitigation-passing',           -- semgrep rule exists AND last run passed
  'mitigation-failing',           -- semgrep rule exists AND last run failed (or rule missing)
  'manual-verification-required', -- non-semgrep mitigation_ref; pipeline can't auto-verify
  'historical'                    -- explicitly retired by maintainer
);

CREATE TABLE security_incidents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id             UUID NOT NULL REFERENCES audit_repos(id) ON DELETE CASCADE,
  incident_id         TEXT NOT NULL,                    -- "INC-NNN" from markdown
  description         TEXT NOT NULL,
  affected_paths      TEXT[] NOT NULL DEFAULT '{}',
  mitigation_ref      TEXT,                              -- "semgrep:rule-id" | "scripts/lib/secret-patterns.mjs" | "manual"
  mitigation_kind     security_mitigation_kind_t NOT NULL,
  status              security_status_t NOT NULL DEFAULT 'manual-verification-required',
  lessons_learned     TEXT,
  embedding           VECTOR(768),                        -- Gemini embedding of (description + " " + lessons_learned). Dim is hardcoded at 768 to match arch-memory's active model; widening to a different dim requires a future ALTER (R1-M1 trade-off).
  embedding_model     TEXT,                               -- concrete model id at embed time (e.g. 'gemini-embedding-001')
  embedding_dim       INTEGER,                            -- (R1-M1) stored alongside model; refresh re-embeds when stored dim/model differs from active sentinel resolution
  source_fingerprint  TEXT NOT NULL,                      -- sha256(description + lessons_learned + affected_paths.join + mitigation_ref) — drives cache hit
  status_check_at     TIMESTAMPTZ,                        -- last time status was auto-resolved
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),  -- bumped on every UPDATE via trigger below (R2-H2 + R3-H2)
  UNIQUE (repo_id, incident_id)
);

-- R3-H2: DEFAULT now() only fires on INSERT. The freshness check
-- (max(updated_at) for repo) needs updated_at to bump on UPDATE too,
-- otherwise UPSERTs that change content would leave stale timestamps.
-- Single trigger keeps callers from having to remember to set the col.
CREATE OR REPLACE FUNCTION touch_security_incidents_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_security_incidents_touch
  BEFORE UPDATE ON security_incidents
  FOR EACH ROW
  EXECUTE FUNCTION touch_security_incidents_updated_at();

CREATE INDEX idx_security_incidents_repo ON security_incidents(repo_id);
CREATE INDEX idx_security_incidents_vector
  ON security_incidents USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50)
  WHERE embedding IS NOT NULL;

-- (R1-H1) Authorization model: security incidents are MORE SENSITIVE than
-- the rest of audit-loop's tables (they describe past breaches + their
-- mitigations). Unlike symbol_index etc. which use anon-read, this table
-- has NO anon-read policy — reads require the service-role key. The
-- cross-skill bridge (`scripts/cross-skill.mjs::cmdGetIncidentNeighbourhood`)
-- uses service-role context for these queries.
--
-- The `incident_neighbourhood` RPC stays SECURITY DEFINER but its callers
-- must hold a service-role JWT — the SUPABASE_AUDIT_SERVICE_ROLE_KEY env
-- var that the bridge already requires for writes is the same key.

ALTER TABLE security_incidents ENABLE ROW LEVEL SECURITY;
-- NO anon SELECT policy — explicit absence is the safety boundary.
-- Service role bypasses RLS automatically per Supabase contract.
```

Migration ordering note (R2-H1): the `GRANT EXECUTE` and `REVOKE` for the
RPC must come AFTER the `CREATE FUNCTION incident_neighbourhood(...)`
statement (shown later in this section). The migration file orders:
1. `CREATE TYPE` (enums)
2. `CREATE TABLE security_incidents` + indexes
3. `ALTER TABLE … ENABLE ROW LEVEL SECURITY` (no policy created)
4. `CREATE OR REPLACE FUNCTION incident_neighbourhood(…)`
5. `GRANT EXECUTE … TO service_role`
6. `REVOKE EXECUTE … FROM anon, authenticated, public`

`UNIQUE(repo_id, incident_id)` is the cache key — re-parsing the same
markdown produces the same `incident_id`, and the
`source_fingerprint` field tells us whether the row needs re-embedding
(content changed) or just re-status-checking (same content, possibly
different mitigation status).

**No `active` status value.** Per brainstorm round 2, file-existence
proves nothing — only Semgrep-rule-runs-and-passes is auto-verifiable.
This is the load-bearing decision against false-comfort failure mode.

### Markdown source-of-truth format (`docs/security-strategy.md`)

> **Note for code auditors**: the markdown block below is an
> **illustrative example** of the parser-recognised incident format,
> NOT a list of files this plan creates. `src/billing/**` and
> `src/checkout/stripe.js` are fictitious paths used only to demonstrate
> the `affected_paths` field. The actual files this plan creates are
> listed in the "File-Level Plan" section further down.

```markdown
# Security strategy — <repo-name>

## Threat model
…short prose, not parsed by pipeline (planners read it directly via Read tool)…

## Incidents

<!-- incident:start id="INC-001" -->
**Description**: Debug log leaked credit-card numbers via
console.log(payment) in the Stripe callback handler.

**Affected paths**: `src/billing/**`, `src/checkout/stripe.js`

**Mitigation**: `semgrep:no-payment-logs`

**Lessons learned**: Any payment-handling code path must route logs
through `scripts/lib/secret-patterns.mjs` (`redactSecrets()`) which strips
card-shaped substrings. Never log raw payment payloads even at DEBUG level.
<!-- incident:end -->

<!-- incident:start id="INC-002" -->
…another incident…
<!-- incident:end -->
```

The marker pair (`<!-- incident:start id="…" -->` / `<!-- incident:end -->`)
is the parse boundary. Field labels (`**Description**:` etc.) are
case-insensitive and order-independent.

**Required vs optional field rules** (R1-H4 — schema NOT NULL columns
need explicit handling for partial entries):

| Field | Required | Behaviour if missing |
|---|---|---|
| `id` (in marker tag) | YES | Entry SKIPPED with stderr warning; not persisted. |
| `**Description**` | YES (DB `NOT NULL`) | Entry SKIPPED with stderr warning; not persisted. |
| `**Affected paths**` | optional | Defaults to `[]` array (still persists). |
| `**Mitigation**` | optional | If absent → `mitigation_kind='manual'`, `mitigation_ref=null`. |
| `**Lessons learned**` | optional | NULL in DB; entry persists. |

**`mitigation_kind` derivation rule** (parser-side, not user-supplied):
- `mitigation_ref` matches `/^semgrep:[A-Za-z0-9._\-/]+$/` → `semgrep` (R2-M2: real semgrep specs include slashes, dots, namespaces — e.g. `semgrep:python.lang.security.audit.dangerous-system-call` or `semgrep:p/owasp-top-ten` for registry rulesets)
- `mitigation_ref` matches a path-shaped string (contains `/` and ends in known extension) → `file-ref`
- `mitigation_ref` is empty/null OR equals literal "manual" → `manual`

So a half-written entry without `description` is parser-skipped (one
stderr warning, pipeline continues). Entries with description but
nothing else persist with sensible defaults. The DB schema's NOT NULL
constraints can never reject a parsed entry because the parser pre-filters.

### Pipeline (3 components)

```
docs/security-strategy.md
        │
        ▼
parse-strategy.mjs   ── pure, testable, no I/O beyond fs.readFile ──► Array<IncidentRecord>
                                                                            │
        ┌───────────────────────────────────────────────────────────────────┘
        ▼
refresh-incidents.mjs  ── for each new/changed (by source_fingerprint):
                              1. Gemini-embed (description + lessons_learned)
                              2. UPSERT row
                              3. status auto-resolve (semgrep run? file exists? → status enum)
                              4. update status_check_at
        │
        ▼
   security_incidents table
        │
        ▼
incident_neighbourhood RPC   ── path-overlap-first, weighted cosine score, top-K
        │
        ▼
get-incident-neighbourhood (cross-skill.mjs)   ── embeds intent client-side, calls RPC
        │
        ▼
   /plan Phase 0.5b consultation   ──► "Past incidents to verify against" callout
   /security-strategy add-incident ──► appends to markdown, then refresh
   /ship hook (security commit)    ──► offers to invoke add-incident
```

### Composite scoring — split: RPC returns raw signals, client weights (R1-M3)

R1-M3 surfaced a real conflict: the plan claimed env-tunable weights
(`SEC_SCORE_W_*`) but baked them into a Postgres function. Resolution:
the **RPC returns the four raw signals + ranks by them only as a stable
ordering for the LIMIT clause**. The CLIENT (`neighbourhood-query.mjs`)
applies the weighted sum from env vars and re-sorts. This makes the
weights actually tunable without a migration.

RPC contract:

```sql
CREATE OR REPLACE FUNCTION incident_neighbourhood(
  p_repo_id          UUID,
  p_target_paths     TEXT[],
  p_intent_embedding VECTOR(768),
  p_k                INT DEFAULT 3
) RETURNS TABLE (
  incident_id      TEXT,
  description      TEXT,
  affected_paths   TEXT[],
  mitigation_ref   TEXT,
  status           security_status_t,
  lessons_learned  TEXT,
  cosine_score      NUMERIC,
  path_overlap      BOOLEAN,
  mitigation_bonus  NUMERIC,
  recency_decay     NUMERIC
  -- NB: composite_score deliberately NOT returned by RPC (R1-M3).
  -- Client computes weighted sum from env-tunable weights and re-sorts.
)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
BEGIN
  RETURN QUERY
  WITH scored AS (
    SELECT
      si.incident_id,
      si.description,
      si.affected_paths,
      si.mitigation_ref,
      si.status,
      si.lessons_learned,
      -- cosine similarity (1 - distance)
      (1 - (si.embedding <=> p_intent_embedding))::NUMERIC AS cosine_score,
      -- path overlap: any target path glob-matches any affected path glob
      EXISTS (
        SELECT 1
          FROM unnest(p_target_paths) AS tp,
               unnest(si.affected_paths) AS ap
         -- R2-M4: escape literal SQL wildcards (% and _) BEFORE the
         -- glob-to-LIKE translation. Underscores are common in JS/TS
         -- filenames (`my_helper.js`) and would otherwise match any
         -- single char, producing false-positive path overlaps.
         WHERE tp LIKE replace(replace(replace(replace(ap, '\', '\\'), '%', '\%'), '_', '\_'), '*', '%') ESCAPE '\'
            OR ap LIKE replace(replace(replace(replace(tp, '\', '\\'), '%', '\%'), '_', '\_'), '*', '%') ESCAPE '\'
      ) AS path_overlap,
      -- mitigation_resolves bonus
      CASE si.status
        WHEN 'mitigation-passing'           THEN 1.0
        WHEN 'manual-verification-required' THEN 0.5
        WHEN 'mitigation-failing'           THEN 0.0
        WHEN 'historical'                   THEN 0.3
      END AS mitigation_bonus,
      -- recency decay: 1 / (1 + age_days/180)
      (1.0 / (1.0 + EXTRACT(epoch FROM (v_now - si.created_at)) / 86400.0 / 180.0))::NUMERIC AS recency_decay
    FROM security_incidents si
    WHERE si.repo_id = p_repo_id
      AND si.embedding IS NOT NULL
      AND si.status <> 'historical'
  )
  -- Path-overlap force-include FIRST. Server-side fallback ordering
  -- uses cosine + mitigation_bonus only (deterministic, no env config
  -- inside DB). Client re-sorts by env-weighted composite per R1-M3.
  -- LIMIT applied here is a coarse pre-filter (3*p_k) so the client has
  -- enough candidates to re-rank meaningfully. Total returned ≤ 3*p_k.
  SELECT
    s.incident_id, s.description, s.affected_paths,
    s.mitigation_ref, s.status, s.lessons_learned,
    s.cosine_score, s.path_overlap,
    s.mitigation_bonus, s.recency_decay
  FROM scored s
  ORDER BY
    s.path_overlap DESC,
    (s.cosine_score + 0.1 * s.mitigation_bonus) DESC,
    s.incident_id ASC
  LIMIT (3 * p_k);
END;
$$;
```

The `LIKE` glob translation handles `**` → `%` and `*` → `%`. This is
intentionally simple — sufficient for our path-globs and keeps the SQL
readable (R1-M4 — accepted limitation; complex globs like `{a,b}.js`
fall through and rely on cosine ranking instead).

### Client-side re-ranking (R1-M3)

In `scripts/lib/neighbourhood-query.mjs::getIncidentNeighbourhoodForIntent`,
after RPC returns up to `3*k` candidates:

```js
const W = {
  cosine:    Number(process.env.SEC_SCORE_W_COSINE     ?? 0.65),
  pathBonus: Number(process.env.SEC_SCORE_W_PATH       ?? 0.20),
  mitigation:Number(process.env.SEC_SCORE_W_MITIGATION ?? 0.10),
  recency:   Number(process.env.SEC_SCORE_W_RECENCY    ?? 0.05),
};
const ranked = candidates
  .map(r => ({
    ...r,
    composite_score:
        W.cosine    * r.cosine_score
      + W.pathBonus * (r.path_overlap ? 1 : 0)
      + W.mitigation * r.mitigation_bonus
      + W.recency   * r.recency_decay,
  }))
  .sort((a, b) =>
    // Path-overlap still wins ties (force-include semantics)
    (b.path_overlap === a.path_overlap)
      ? b.composite_score - a.composite_score
      : (b.path_overlap ? 1 : -1)
  )
  .slice(0, k);

return { records: ranked, totalCandidatesConsidered: candidates.length };
```

Total candidate count IS surfaced (`totalCandidatesConsidered`) so
the `/plan` callout's "(N shown of M total)" line is accurate (R1-L1).

### ivfflat index — present but unused at v1 scale (R3-M1, accepted limitation)

The `idx_security_incidents_vector` ivfflat index is created in the
migration but the v1 RPC does NOT use it (the CTE computes cosine on
the full filtered set, then sorts). At v1 scale (<50 incidents/repo
expected; <200 across all repos) this is faster than ivfflat probe
overhead. The index is created so it's available when we cross the
threshold. **Documented threshold: when any single repo has >200
incidents, restructure the RPC to use `ORDER BY embedding <=> $query
LIMIT 50` form so ivfflat is index-served.** That refactor is
v2-shaped, not v1.

### Markdown freshness check on read (R2-H2)

Markdown is canonical but the planner reads from the DB index. If the
user edits `docs/security-strategy.md` without running
`npm run security:refresh`, the planner consults stale data. Add a
cheap freshness check inside `getIncidentNeighbourhoodForIntent`:

```js
import { statSync } from 'node:fs';

// R-Gemini-r2-G1: statSync THROWS on ENOENT — must wrap explicitly.
// Default mdMtime to 0 when the file doesn't exist (no md → no
// freshness signal possible → no warning). Same outcome as "soft fail"
// I claimed in v3, this just actually implements it.
let mdMtime = 0;
try {
  mdMtime = statSync('docs/security-strategy.md').mtimeMs;
} catch (err) {
  if (err.code !== 'ENOENT') throw err;  // surface unexpected errors
}
const lastRefresh = await store.getMaxIncidentRefreshAt(repoId);  // SELECT max(updated_at)
const stale = mdMtime > 0 && lastRefresh != null
  && (mdMtime > new Date(lastRefresh).getTime() + 5_000);
//                                                └─ 5s slack tolerates clock skew
```

When `stale === true`, `getIncidentNeighbourhoodForIntent` adds a
`freshnessWarning` field to the result. `/plan` Phase 0.5b renders it
as an extra line in the callout:

```markdown
> ⚠ `docs/security-strategy.md` edited since last refresh — run
> `npm run security:refresh` to bring the security index current.
```

The check is one fs.stat + one tiny SQL query. Always runs (cheap).
Soft signal — never blocks.

### Intent-rephrasing fallback (Gemini-r2-G2)

```js
// In scripts/lib/neighbourhood-query.mjs sister fn getIncidentNeighbourhoodForIntent
//
// 1. Embed intentDescription, call RPC. If any path-overlap hits → return.
// 2. If candidates.length > 0 AND no path-overlap AND every candidate
//    cosine_score < 0.5:                                       ← R2-M3
//    a. Call Haiku ONCE with structured-output schema (R3-M3 — Zod
//       enforces shape, not free-text):
//
//       const FailureModesSchema = z.object({
//         failureModes: z.array(z.string().min(20).max(200)).min(1).max(3),
//       });
//
//       Prompt: "Given intent: <X>, list 1-3 hypothetical security
//       failure modes that might apply. Each: one sentence, concrete
//       (mention attack vector + asset). Return JSON {failureModes: [...]}"
//    b. Embed (intent + " " + failureModes.join(' ')), retry RPC.
//    c. Return whatever it surfaces (or empty). NO further rephrasing.
// 3. Cap: 1 rephrase per query. No recursion.
//
// R2-M3: the candidates.length > 0 guard is load-bearing. Without it,
// an empty candidate array (repo with zero incidents OR cold cache)
// satisfies `every(c => c.cosine < 0.5)` vacuously, triggering Haiku
// rephrasing on EVERY plan that touches a non-incident-tagged area —
// exactly the unbounded-cost path we need to prevent. Empty array →
// short-circuit return immediately, no Haiku.
```

This bridges the intent-vs-incident embedding gap without unbounded
LLM cost. Only fires on the empty-overlap-and-low-cosine path.

### `/plan` integration (Phase 0.5b extension, not new Phase 0.7)

After the existing `compute-target-domains` call in Phase 0.5b, also
call:

```bash
node scripts/cross-skill.mjs get-incident-neighbourhood --json '{
  "targetPaths": [...],
  "intentDescription": "<one-line>",
  "k": 3
}'
```

Render result inline as `> **Past incidents to verify against** (N
shown of M total)` callout block:

```markdown
> **Past incidents to verify against** (2 shown of 5 total)
>
> | Incident | Affected paths | Status | Lessons learned |
> |---|---|---|---|
> | **INC-001** — Debug log leaked credit-card numbers via console.log(payment)… | `src/billing/**` | `manual-verification-required` | Route payment logs through redact.mjs; never log raw payloads. |
> | **INC-007** — Stripe webhook accepted unverified payloads | `src/checkout/stripe.js` | `mitigation-passing` (semgrep:require-stripe-sig) | …always check the signature header before parsing body. |
```

If `docs/security-strategy.md` doesn't exist:

```markdown
> _No security strategy document found. Run `/security-strategy bootstrap` to seed one._
```

Soft warning only — never blocks plan generation.

## 3. Sustainability Notes (#20)

- **Single table now; can fan out later.** If we add a threat-model
  table, an invariants table, or a security_decisions table in v2,
  they're additive — no schema rewrite to `security_incidents` needed.
- **Markdown is canonical** so the system survives Supabase being
  unavailable. `/plan` falls back to "no incidents available" gracefully;
  the human-readable history still lives in git.
- **Status semantics are deliberately conservative.** Adding new
  auto-verifiable mitigation kinds (e.g. `unit-test-passes`) is a
  per-kind enum extension + status-resolver branch, not a redesign.
- **Score weights are env-tunable** (`SEC_SCORE_W_COSINE`, etc.) for
  future calibration without code changes (#8 No Hardcoding).
- **Path-glob matching uses `LIKE` translation.** If we outgrow this
  (e.g. need true glob semantics for `{a,b}.js`), swap the EXISTS
  subquery for a function call — RPC signature unchanged.
- **The `Scope: repo | org` flag** is intentionally absent in v1 but
  the `repo_id` FK + UNIQUE makes promotion mechanically straightforward
  (add a `scope` column with default `'repo'`; org-scoped reads UNION
  across repos in the same org).

## 4. File-Level Plan

### A. Schema

| File | Status | Purpose |
|---|---|---|
| `supabase/migrations/20260504120000_security_incidents.sql` | NEW | Table + 2 enums + 2 indexes + RLS + RPC |

### B. Pure parser + status resolver

| File | Status | Purpose |
|---|---|---|
| `scripts/security-memory/parse-strategy.mjs` | NEW | Pure function `parseSecurityStrategy(markdownText)` → `{incidents: [...], threatModel: string \| null, warnings: [{kind:'missing-id'\|'missing-description'\|'duplicate-id'\|'unparseable-block', line, snippet}]}`. **Pure: no I/O at all** (R2-M1). **(R-Gemini-G2)** Tracks seen `incident_id` set during parse — duplicate IDs (e.g. user copy-pasted a block and forgot to change the id) keep the FIRST occurrence and emit a `duplicate-id` warning for each repeat. This prevents the downstream Postgres `ON CONFLICT DO UPDATE … row affected twice` crash that would otherwise kill the entire refresh on one typo. Caller (`refresh-incidents.mjs`) iterates `warnings` and emits to stderr. (#11 Testability, #12 Defensive Validation) |
| `scripts/security-memory/incident-status.mjs` | NEW | TWO functions: (1) **pure** `classifyMitigation({mitigation_kind, semgrepRunResult, ruleFileExists})` → `{status, status_evidence}` — given evidence, picks the enum value (testable in isolation). (2) **impure** `runSemgrepIfNeeded({repoRoot, mitigationRef, mitigationKind, fingerprintCache})` — when `mitigation_kind === 'semgrep'`, resolves rule source: a literal `semgrep:p/<ruleset-name>` or `semgrep:r/<id>` is a **registry rule** (no local file); anything else is a **local rule** (`semgrep:my-rule-id` → `semgrep/my-rule-id.yml` in repo). Shells out via `execFileSync('semgrep', ['--config', <rule>, '--json', repoRoot])`, parses exit code (0 = no findings → passing; 1 = findings → failing; other = "tool error" → degrade to manual). **(R-Gemini-G3 + R-Gemini-r2-G3)** Cache key differentiates source: `localRule → sha256(rule_file_content + repo_HEAD_sha)`; `registryRule → sha256(mitigationRef + repo_HEAD_sha)`. **For local rules, check `fs.existsSync(rulePath)` BEFORE attempting `readFileSync` for the cache key** — if the file is missing (typo in mitigation_ref pointing at non-existent local rule), short-circuit immediately with `{status: 'mitigation-failing', status_evidence: 'rule file not found: <path>'}`. Never attempt to read a non-existent file; that would throw ENOENT and crash the whole refresh. **Falls back to `manual-verification-required` if semgrep binary not on PATH** (R1-H2). |

### C. Refresh orchestrator

| File | Status | Purpose |
|---|---|---|
| `scripts/security-memory/refresh-incidents.mjs` | NEW | Reads `docs/security-strategy.md`, parses, diffs against existing rows by `source_fingerprint`, embeds new/changed via Gemini, UPSERTs, runs status resolver, writes `status_check_at`. Mirrors `scripts/symbol-index/refresh.mjs` pattern at smaller scope. **Behaviour matrix** (R1-H3, R1-H5): (a) `docs/security-strategy.md` does not exist → log "no security strategy file" to stderr, exit 0, no DB writes; (b) cloud disabled (no Supabase URL) → log "cloud disabled — skipping" to stderr, exit 0; (c) parsed file has 0 incidents → run the sweep step (mark ALL existing DB rows as `historical` per markdown-is-canonical), then exit 0. Do NOT run status checks on incidents that no longer exist in the markdown — they're being retired this refresh (R-Gemini-G5: previous wording was contradictory). **Sweep step** (R1-H3, R-Gemini-r2-G2): after upserting parsed incidents, IF the current branch is the repo's default branch (`git rev-parse --abbrev-ref HEAD` matches `git symbolic-ref --short refs/remotes/origin/HEAD` after stripping the `origin/` prefix; falls back to `main` then `master` if symbolic-ref isn't set), THEN fetch all DB rows for this repo whose `incident_id` is NOT in the parsed set; mark each as `status='historical'` with stderr line `removed-from-markdown: <id>`. We DO NOT delete — preserves audit trail. Re-adding the same `incident_id` later restores it from `historical`. **On a feature branch, sweep is SKIPPED** — only UPSERTs happen — to prevent thrashing of incidents that exist on other parallel branches but aren't yet in this branch's markdown. The Supabase index converges to the canonical state when default-branch refreshes run. |

### D. Learning-store helpers + RPC wrapper

| File | Status | Edit |
|---|---|---|
| `scripts/learning-store.mjs` | EDIT | Add `recordSecurityIncidents(repoId, incidents)` (chunked UPSERT), `getSecurityIncidentsByFingerprint(repoId, fingerprints)` (cache lookup), `callIncidentNeighbourhoodRpc({repoId, targetPaths, intentEmbedding, k})` (RPC wrapper). |
| `scripts/lib/neighbourhood-query.mjs` | EDIT | Add `getIncidentNeighbourhoodForIntent({adapters, args, repoRoot})`. **(R1-M2)** This sister fn IS the reuse mechanism — it shares the same embedding shell, intent-cache, and adapter-injection pattern as `getNeighbourhoodForIntent`, just calls a different RPC name and returns a different record shape. Where they share logic (embed → cache → invoke RPC → map records), code is **lifted into a private `_neighbourhoodCore({rpcName, recordMapper, adapters, args})` helper** in the same file so neither sister fn copies the shell. The two public fns are thin wrappers over that core. **(R3-M2 + R-Gemini-G4)** The library functions return `{result, usage, latencyMs}` per the project's internal LLM-call contract — but the cross-skill bridge (`cmdGetNeighbourhood` and new `cmdGetIncidentNeighbourhood`) **unwraps `.result` before `emit()`** so the JSON shape on stdout stays flat (records/totalCandidatesConsidered/freshnessWarning at the root). This preserves backwards-compat with the existing `/plan` Phase 0.5 caller which reads root fields. The contract split is intentional: the LIBRARY contract is `{result, usage, latencyMs}` (for in-process callers + telemetry); the CLI contract is the flat result (for shell consumers + the planner reading via grep/jq). |

### E. Cross-skill bridge

| File | Status | Edit |
|---|---|---|
| `scripts/cross-skill.mjs` | EDIT | Add `cmdGetIncidentNeighbourhood` mirroring `cmdGetNeighbourhood` exactly. Register as `'get-incident-neighbourhood'`. |

### F. /plan integration

| File | Status | Edit |
|---|---|---|
| `skills/plan/SKILL.md` | EDIT | Phase 0.5b: add second cross-skill call alongside `compute-target-domains`. Add render rules for the "Past incidents to verify against" callout (top-3, table format, with status label). Soft-warn if markdown missing. |

### G. /security-strategy skill

| File | Status | Purpose |
|---|---|---|
| `skills/security-strategy/SKILL.md` | NEW | On-demand only. Two modes: `/security-strategy bootstrap` (interview → seed markdown) and `/security-strategy add-incident` (prompt for fields → append entry → trigger refresh). **(R3-M4)** Write protocol: (1) Read current markdown; (2) construct new full content with new entry inserted; (3) **round-trip parse** the new content through `parseSecurityStrategy()` and assert the new entry appears in `incidents[]` with non-null `description`; (4) only on round-trip success, call `atomicWriteFileSync()` (scripts/lib/file-io.mjs) — temp-file + rename. Round-trip catches malformed entries before they ship; atomic write prevents partial-file corruption on crash. |
| `.claude/skills/security-strategy/SKILL.md` | NEW (generated) | Mirror via `npm run skills:regenerate`. |

### H. /ship hook

| File | Status | Edit |
|---|---|---|
| `skills/ship/SKILL.md` | EDIT | (R-Gemini-G1 — corrected: `/ship` is `disable-model-invocation: true` and explicitly forbids confirmation prompts; an interactive prompt would break the autonomous fire-and-forget contract.) Replace interactive prompt with **passive log message after successful push**. After git push succeeds, regex-match HEAD commit subject against `/fix.*security\|cve\|vuln\|leak\|injection\|auth\|xss\|csrf\|rce/i`. If matched, emit (to stdout, not interactive prompt): `⚠ Security-relevant commit detected: "<subject>". Run \`/security-strategy add-incident\` to draft an incident entry from this fix.` No blocking, no input — user reads the message and decides whether to invoke separately. Single line, easy to grep, easy to ignore if not needed. |

### I. CLI + sync

| File | Status | Edit |
|---|---|---|
| `package.json` | EDIT | Add `"security:refresh": "node scripts/security-memory/refresh-incidents.mjs"`. (R3-H3 — corrected from R2-M5: refresh moves POST-push, not pre-push, to avoid publishing local markdown edits to shared Supabase before the push has actually shipped). Two `/ship` integration points, both POST-push: (1) `npm run security:refresh` runs after `git push` succeeds so the Supabase index only ever reflects state that's been published to git. (2) The security-commit-detect prompt in §4H runs in the same post-push phase. If push fails, neither runs — Supabase index stays consistent with origin/main. The sweep step (mark removed-from-markdown rows as `historical`) is therefore safe because it only runs against pushed state. |
| `scripts/sync-to-repos.mjs` | EDIT | Add new files to `ARCH_MEMORY_SCRIPTS` (or new `SECURITY_MEMORY_SCRIPTS` constant for clarity): `scripts/security-memory/parse-strategy.mjs`, `scripts/security-memory/refresh-incidents.mjs`, `scripts/security-memory/incident-status.mjs`. |

### J. Documentation

| File | Status | Edit |
|---|---|---|
| `README.md` | EDIT | Quick Reference table: add `/security-strategy <bootstrap\|add-incident>` row + `npm run security:refresh` row. |
| `AGENTS.md` | EDIT | New "Security incident memory — Mandatory consultation" section mirroring "Architectural Memory — Pre-fix Consultation" structure. Rule: when planning security-relevant work, the `/plan` Phase 0.5b auto-fires — for ad-hoc fixes outside `/plan`, manually call `node scripts/cross-skill.mjs get-incident-neighbourhood …`. |
| `docs/security-strategy.md` | NEW (audit-loop only; consumers create their own via /security-strategy bootstrap) | Initial threat model + zero or one seed incident as living example. |

### K. Tests

| File | Status | Coverage |
|---|---|---|
| `tests/parse-strategy.test.mjs` | NEW | (a) empty markdown → `{incidents:[], threatModel:null}`; (b) one well-formed entry → expected fields; (c) marker pair without ID → skipped not crashed (and warning emitted); (d) missing optional fields → null in those positions, entry still returned; (e) two entries with same content → identical `source_fingerprint`; (f) edit one field → different fingerprint; (g) nested marker (mid-content) → outer wins, inner ignored; (h) Windows line endings normalised. |
| `tests/incident-status.test.mjs` | NEW | (a) `mitigation_kind='semgrep'` + rule file exists + last run passed → `mitigation-passing`; (b) `mitigation_kind='semgrep'` + rule missing → `mitigation-failing`; (c) `mitigation_kind='semgrep'` + last run failed → `mitigation-failing`; (d) `mitigation_kind='file-ref'` + file exists → STILL `manual-verification-required` (the false-comfort guard); (e) `mitigation_kind='manual'` → always `manual-verification-required`; (f) status_check_at timestamp populated; (g) `historical` status passes through unchanged regardless of mitigation_ref. |
| `tests/incident-neighbourhood.test.mjs` | NEW | (a) Mocked RPC: path-overlap row force-included even with low cosine; (b) cosine-only fallback when no path-overlap; (c) intent-rephrasing fallback fires only when no path-overlap AND all cosine < 0.5; (d) rephrasing capped at 1 attempt per query; (e) deterministic composite score for fixed embeddings + paths; (f) k=0 → empty result; (g) `historical`-status incidents excluded from RPC results. |

## 5. Risk & Trade-off Register

| Risk | Mitigation |
|---|---|
| LLM becomes paranoid/bureaucratic from constant security context (Gemini r1 second-order effect) | Hard top-3 cap; status labels make epistemic level visible; only show callout when results exist (no "no incidents — proceed" noise on every plan) |
| `mitigation-passing` overstates protection (false-comfort trap, both LLMs r2) | Only `semgrep:` mitigations earn this status; everything else stays `manual-verification-required` regardless of file existence. The `mitigation_kind` enum is the load-bearing constraint. |
| Embedding drift across model upgrades | `embedding_model` column stored; refresh re-embeds when model differs (same pattern as symbol_embeddings). |
| Path-glob `LIKE` translation imprecise for `{a,b}.js` style globs | Documented limitation; v1 uses `*` and `**` only; complex globs route to `manual-verification-required` via path_overlap=false. |
| Intent-rephrasing fallback adds LLM cost on every plan | Gated: only fires when path-overlap returns 0 AND all cosine < 0.5. Cap 1 attempt. Typical plan with arch-memory targets domains we have rules for, so fallback rarely fires. |
| Markdown parser crashes on user typos / malformed entries | Per-entry try/catch in parser; missing fields → null + emit stderr warning, never throw; skip-not-crash. Test (c) covers. |
| /ship hook prompt becomes annoying; users dismiss it always | Pattern is conservative (matches `fix.*security\|cve\|vuln\|leak\|injection\|auth\|xss\|csrf\|rce`); fires rarely. Non-blocking. Telemetry could later track decline rate. |
| Cross-repo Scope:repo\|org temptation creeps in early | Explicitly deferred. The `repo_id` UNIQUE constraint keeps it strictly per-repo. v2 adds `scope` column without breaking v1 reads. |
| RPC `EXISTS … unnest … LIKE` is O(N×M) per row | N (target paths) and M (affected paths per incident) are both small (<20 typical); incident count per repo is small (<50 expected); inner loop cost negligible vs vector index. |
| Semgrep not installed → all semgrep statuses degrade to `mitigation-failing` (false negatives) | `incident-status.mjs` distinguishes "rule missing" from "semgrep not installed" via separate detection step; "semgrep not installed" → fall back to `manual-verification-required` and emit warning. |
| `docs/security-strategy.md` accidentally committed with real secrets | Existing `redactSecrets()` runs on all text egressed to LLM; markdown itself goes to PR review where humans catch this; no secrets-in-incidents pattern is healthy practice. Documented in /security-strategy bootstrap interview. |

### Deliberately deferred

| Item | Reason |
|---|---|
| 5-table schema (threat-model, trust-boundaries, invariants, decisions tables) | Brainstorm consensus: prove the loop with incidents only first |
| `Scope: repo \| org` cross-repo retrieval | Need ≥5 incidents/repo before we know what's actually shareable |
| Trust-boundary auto-tagging from AST | Alert-fatigue trap (both LLMs); revisit if incident retrieval proves valuable |
| Threat-model in DB | Markdown sufficient; planner reads directly via Read tool |
| Upfront `/security-strategy bootstrap` as gate | Generates generic boilerplate; post-PR capture generates dense entries |
| Org-level Scope flag + promotion mechanism | Deferred until 5+ incidents/repo accumulate |
| Semgrep ruleset bootstrap helper | Out of scope for this plan; ships with the separately-planned defensive layer |
| Ad-hoc `/security-audit <plan-or-scope>` LLM-driven semantic review skill | Reactive layer; separately planned. Memory layer (this plan) feeds it via `incident_neighbourhood` for relevant historical context. |

## 6. Testing Strategy

### Unit tests (Node `node:test`, `npm test`)

- **`tests/parse-strategy.test.mjs`** — 8 cases above. Pure function, no fixtures beyond inline markdown strings.
- **`tests/incident-status.test.mjs`** — 7 cases. Mocks: `fs.existsSync` for file checks; pretend-semgrep result object for rule-pass/fail.
- **`tests/incident-neighbourhood.test.mjs`** — 7 cases. Mocks: stub `callIncidentNeighbourhoodRpc` returning fixture rows; stub `embedIntent`; stub Haiku rephrasing call.

### Integration smoke (manual, requires Supabase)

1. Apply migration 20260504120000_security_incidents to live DB.
2. Create `docs/security-strategy.md` with one seed incident (`INC-001` debug-log-payment example).
3. `npm run security:refresh` → verify single row inserted, embedding non-null, status auto-resolved to `manual-verification-required` (no semgrep rule yet).
4. `node scripts/cross-skill.mjs get-incident-neighbourhood --json '{"targetPaths":["src/billing/foo.js"],"intentDescription":"add Stripe webhook handler","k":3}'` → verify incident returned with `path_overlap: true`.
5. `node scripts/cross-skill.mjs get-incident-neighbourhood --json '{"targetPaths":["scripts/lib/findings.mjs"],"intentDescription":"refactor finding deduplication","k":3}'` → verify zero results AND no rephrasing fallback fires (cosine ranking already runs; only fires if all <0.5).
6. Edit lessons_learned in markdown; re-run refresh → verify `source_fingerprint` differs and embedding re-generated (one Gemini call), other untouched incidents skipped (cache hit).

### Per-plan cost target

- Per-plan overhead (steady state): 1× Gemini embed (~$0.0003) + 1× Postgres RPC (~50ms). Well under $0.001.
- Refresh overhead (only when markdown changes): 1× Gemini embed per new/changed incident.
- Intent-rephrasing fallback: 1× Haiku call (~$0.0005) + 1× embed; fires rarely.

## Deferred to v1.1 (Gemini-r2-G4)

**Batched Semgrep execution** — v1 runs `semgrep --config <rule> --json
<repo>` sequentially per incident on each refresh. Gemini correctly
flagged this as a UX-degrading concern at scale. Trade-off accepted for
v1 because:

1. Per-incident semgrep result is **cached by `sha256(rule + repo_HEAD)`**
   — the second refresh against the same HEAD reads cache, not semgrep.
   So perf cost is ONLY paid when HEAD changes AND a rule changes — uncommon.
2. v1 scale is small: 3 repos × <10 incidents each currently. Sequential
   semgrep at this scale is seconds, not minutes.
3. Batching requires parsing semgrep's multi-rule JSON output and
   mapping findings back to rules — non-trivial and the wrong shape to
   add now if we don't yet need it.

**v1.1 trigger**: when any single repo accumulates >20 incidents AND the
post-push refresh consistently exceeds 30s, refactor `runSemgrepIfNeeded`
to batch all uncached local-rule references into a single
`semgrep --config rule1.yml --config rule2.yml … --json <repo>` call,
and demultiplex the resulting `results[].check_id` field per rule.

## 7. Out of Scope (links to brainstorm rationale)

- Trust-boundary auto-tagging from AST (alert fatigue — both LLMs r1)
- 5-table schema for threat model / invariants / decisions / boundaries (over-engineering — both r1)
- Cross-repo retrieval (sparse data, premature normalisation — both r2)
- Upfront `/security-strategy bootstrap` as `/cycle` gate (cargo-cult risk — OpenAI r2)
- File-existence as `mitigation-passing` evidence (false-comfort trap — both r2)
- Embedding-only retrieval without path-overlap weight (intent-vs-incident embedding gap — Gemini r2)

## 8. Acceptance Criteria

Machine-checkable post-implementation:

| ID | Check | How |
|---|---|---|
| AC1 | Migration applies cleanly to live Supabase | `supabase db push --linked` exits 0 |
| AC2 | Single new table created with correct schema | `supabase db query --linked "SELECT column_name FROM information_schema.columns WHERE table_name = 'security_incidents';"` returns 16 columns (id, repo_id, incident_id, description, affected_paths, mitigation_ref, mitigation_kind, status, lessons_learned, embedding, embedding_model, embedding_dim, source_fingerprint, status_check_at, created_at, updated_at) — R1-L1 corrected from 14 |
| AC3 | `parse-strategy.mjs` is pure (no fs writes, no network) | Test grep: no `writeFile\|fetch\|exec` in the file body |
| AC4 | All 22 unit tests pass | `node --test tests/parse-strategy.test.mjs tests/incident-status.test.mjs tests/incident-neighbourhood.test.mjs` exits 0 |
| AC5 | `/plan` Phase 0.5b emits "Past incidents to verify against" callout when results exist | grep `Past incidents to verify against` skills/plan/SKILL.md returns hit |
| AC6 | `/plan` Phase 0.5b emits soft-warning when `docs/security-strategy.md` missing | grep `No security strategy document found` skills/plan/SKILL.md returns hit |
| AC7 | No `active` enum value anywhere in migration or status resolver | `! grep -E "'active'" supabase/migrations/20260504120000_security_incidents.sql scripts/security-memory/incident-status.mjs` |
| AC8 | (R2-H3 — corrected after R1-M3 design change) Composite score weights live CLIENT-SIDE, env-tunable; RPC returns raw signals only | `! grep -q "composite_score" supabase/migrations/20260504120000_security_incidents.sql` AND `grep -q "SEC_SCORE_W_COSINE" scripts/lib/neighbourhood-query.mjs`. Subsumes AC21 — single check. |
| AC9 | Path-overlap force-include verified live | smoke step 4 (above) returns row with `path_overlap: true` ranked first |
| AC10 | `/ship` hook prompt only fires on security-pattern commits | grep `fix.*security\|cve\|vuln\|leak\|injection\|auth\|xss\|csrf\|rce` skills/ship/SKILL.md |
| AC11 | `npm run security:refresh` defined + works | `npm run security:refresh -- --help` (or trial run) exits 0 |
| AC12 | (R3-H1 — strengthened from "OR" to "AND") `redactSecrets()` applied at EVERY text-egress site | All sites must grep clean: (1) `grep -q redactSecrets scripts/security-memory/refresh-incidents.mjs` (description+lessons before Gemini embed), (2) `grep -q redactSecrets scripts/lib/neighbourhood-query.mjs` (intent before Gemini embed AND before Haiku rephrase). Test asserts: input containing `sk-…` shaped secret yields `redactionCount > 0` and the secret string never reaches the SDK call. |
| AC13 | Sync includes new files | grep `security-memory` scripts/sync-to-repos.mjs returns 3 files |
| AC14 | README + AGENTS updated | grep `/security-strategy` README.md AGENTS.md returns hits in both |
| AC15 | (R1-H1) `security_incidents` has NO anon SELECT policy | `supabase db query --linked "SELECT count(*) FROM pg_policies WHERE tablename='security_incidents' AND roles @> ARRAY['anon']::name[];"` returns 0 |
| AC16 | (R1-H1) `incident_neighbourhood` RPC granted to service_role only | `supabase db query --linked "SELECT routine_name, grantee FROM information_schema.routine_privileges WHERE routine_name='incident_neighbourhood';"` returns only service_role |
| AC17 | (R1-H2) Semgrep runner shells out + handles missing binary | grep `execFileSync.*semgrep` scripts/security-memory/incident-status.mjs returns hit; missing-binary degrades to manual-verification-required (test case) |
| AC18 | (R1-H3) Sweep marks DB-only incidents as `historical` | test: insert 2 incidents in markdown, refresh, remove 1 from markdown, refresh again → DB row for removed incident has `status='historical'`, NOT deleted |
| AC19 | (R1-H4) Parser skips entries without `description` instead of crashing | test: malformed entry without description → 0 rows persisted, stderr line emitted, well-formed siblings persist |
| AC20 | (R1-H5) `security:refresh` exits 0 cleanly when markdown missing | `rm docs/security-strategy.md && npm run security:refresh; echo $?` → 0 |
| AC21 | (R1-M3) Composite scoring is client-side; weights env-tunable | grep `SEC_SCORE_W_COSINE` scripts/lib/neighbourhood-query.mjs returns hit; RPC SQL does NOT contain composite_score |

## 9. Engineering Principles Cited

- **#1 DRY** — reuses existing embedding pipeline, chunk/getWriteClient/withRetry helpers, ivfflat index pattern, RLS pattern, `redactSecrets`, `resolveModel` sentinels
- **#2 SRP** — parse-strategy.mjs (pure parsing), incident-status.mjs (pure status resolution), refresh-incidents.mjs (orchestration), neighbourhood-query.mjs sister fn (retrieval) — four single-responsibility units
- **#7 Modularity** — markdown SoT + DB index + RPC + cross-skill bridge + skill is a swappable stack; replace any layer without breaking others
- **#8 No Hardcoding** — score weights env-tunable (`SEC_SCORE_W_*`), model via `latest-haiku`/`gemini-embedding-001` sentinels
- **#10 Single Source of Truth** — markdown is canonical; DB rows are derived index; mitigation_ref is the single string that drives status
- **#11 Testability** — three pure functions with no I/O; mockable RPC + embedding boundaries
- **#12 Defensive Validation** — Zod schemas at RPC + cross-skill subcommand boundary
- **#13 Idempotency** — `source_fingerprint` makes refresh safely re-runnable; UPSERT on `(repo_id, incident_id)` UNIQUE
- **#15 Consistent Error Handling** — emit/emitError pattern matches existing cross-skill subcommands
- **#16 Graceful Degradation** — markdown missing → soft warning; cloud disabled → empty incidents; semgrep not installed → `manual-verification-required`; `/plan` always proceeds
- **#19 Observability** — refresh logs counts; status labels surface epistemic state honestly; status_check_at timestamp visible to humans
- **#20 Long-Term Flexibility** — single table now; Scope flag + threat-model table + invariants table all additive; ivfflat handles 50→500 incidents without re-tuning
