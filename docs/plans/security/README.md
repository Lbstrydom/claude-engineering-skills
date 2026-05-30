# `/security-strategy` — portable security-memory subsystem

A self-contained copy of the **security-strategy Postgres port** so it can be
re-implemented in the upstream personal repo (`claude-engineering-skills`) or any
other audit-loop consumer.

- **[PLAN.md](./PLAN.md)** — the full design + decisions + phase plan (the canonical spec).
- **[AUDIT-SUMMARY.md](./AUDIT-SUMMARY.md)** — the GPT-5.3 + Opus audit history (what was
  flagged, what was fixed, what was a false positive).
- **[files/](./files/)** — every implemented file, path-mirrored to its repo location.

---

## What it does

`/security-strategy` turns a human-maintained markdown file (`docs/security-strategy.md`)
into a queryable Postgres **security-incident index**, so `/plan` can pull "have we been
bitten by this before?" context into new work.

```
docs/security-strategy.md            (markdown source of truth — threat model + incidents)
   │  parse-strategy.mjs             (HTML-comment-bounded → structured incidents)
   ▼
refresh-incidents.mjs  (npm run security:refresh)
   │  • pre-write secret gate (refuse high-confidence keys / redact PII)
   │  • Azure embedding @ dim=768  (ONLY when pgvector is present)
   │  • semgrep status per mitigation_ref
   │  • branch-gated sweep (mark-removed→historical only on main)
   │  • atomic incident + audit-event write (withTx)
   ▼
Postgres: security_incidents  +  security_strategy_events  +  security_incident_neighbourhood() RPC
   ▲
cross-skill.mjs get-incident-neighbourhood   (path-overlap + optional cosine similarity)
   ▲
/plan Phase 0.5c                              (threat-relevant incidents surfaced into planning)
```

**pgvector is optional and runtime-detected.** With it: 768-dim embeddings + HNSW + cosine
similarity. Without it (e.g. local Windows Postgres): the embedding column/RPC are never
created and retrieval falls back to path-overlap ranking. Same code, both modes.

---

## Files in this package (where each goes)

Copy `files/*` over your repo root — the paths already match.

| File | Role |
|------|------|
| `scripts/lib/stores/sql/003-security.pg.sql` | Schema: `security_incidents` + `security_strategy_events` + `security_incident_neighbourhood()` RPC, all pgvector-guarded. Self-contained (`CREATE EXTENSION IF NOT EXISTS pgcrypto`). |
| `scripts/security-memory/parse-strategy.mjs` | Pure markdown parser (incidents + threat model + corporate fields). |
| `scripts/security-memory/incident-status.mjs` | Mitigation classification + semgrep shell-out (cached). |
| `scripts/security-memory/refresh-incidents.mjs` | Orchestrator — `npm run security:refresh`. Embedding, secret gate, branch-gating, atomic write, exit-2-on-embed-failure. |
| `scripts/lib/store/security.mjs` | Storage domain module: upsert/sweep/events/neighbourhood + `getSecurityStats`. |
| `scripts/lib/security/secret-classifier.mjs` | Hybrid refuse(high-confidence)/redact(PII) pre-write gate. |
| `scripts/lib/security/pgvector-check.mjs` | Runtime `vector` extension + `embedding` column probes (cached, `table_schema='public'`). |
| `scripts/lib/security/azure-embed.mjs` | Azure OpenAI `text-embedding-3-small` @ dim=768 wrapper, with dim/empty guards. |
| `scripts/lib/security/repo-name.mjs` | Shared security-domain repo identity (git remote → `SECURITY_REPO_NAME` override → basename). |
| `scripts/security-incidents.mjs` | Phase-5 lightweight heartbeat CLI — `npm run security:log`. |
| `.claude/skills/security-strategy/SKILL.md` | The skill spec (Postgres language, corporate fields, branch-gate). |
| `docs/security-strategy.md` | The markdown template (threat-model + incidents-list comment markers). |
| `tests/{parse-strategy,incident-status,incident-neighbourhood,secret-classifier,pgvector-fallback,azure-embed}.test.mjs` | Coverage incl. the mocked pgvector-ON write contract. |
| `.github/workflows/pgvector-azure-ci.yml` | CI that exercises the pgvector-ON path on a `pgvector/pgvector:pg17` service container. |

---

## Shared-file edits (NOT standalone — apply these by hand)

These live inside larger shared files, so they're given here as patches rather than full-file copies.

### 1. `scripts/lib/db/query.mjs` — add the `insertMany` helper

Append-only multi-row INSERT (no `ON CONFLICT`). Used by the audit trail so the append-only
intent is explicit and independent of how `buildUpsert` treats an absent conflict target.

```js
/**
 * Append-only multi-row INSERT (no ON CONFLICT). Use this — not `upsert(t, rows, {})`
 * — when the intent is a plain append (e.g. audit trails).
 */
export async function insertMany(table, rows, opts = {}) {
  const { sql, params } = buildUpsert(table, rows, { returning: opts.returning });
  const res = await _exec(sql, params);
  if (opts.returning !== undefined) return res.rows;
  return { rowCount: res.rowCount ?? 0 };
}
```

> If your repo doesn't have an `upsert`/`buildUpsert` query layer, just emit a plain
> parameterised `INSERT INTO <t> (...) VALUES (...), (...)` — the point is **no `ON CONFLICT`**
> on the append-only `security_strategy_events` table.

### 2. `scripts/cross-skill.mjs` — register the `get-incident-neighbourhood` sub-command

Add to the command switch: `case 'get-incident-neighbourhood': await cmdGetIncidentNeighbourhood(flags); break;`
and the handler:

```js
async function cmdGetIncidentNeighbourhood(flags) {
  const repoRoot = assertRepoRoot();
  const intentText = flags['intent-text'] || flags.intent || null;
  const paths = parseList(flags.paths);
  const k = Number(flags.k ?? 8);

  // Zod-validate the structured input before any DB work.
  const parsed = NeighbourhoodInputSchema.safeParse({
    targetPaths: paths,
    intentDescription: intentText ?? undefined,
    k,
  });
  if (!parsed.success) {
    err(`invalid input: ${parsed.error.issues.map(i => i.message).join('; ')}`);
    process.exit(1);
  }

  const hasVector = await pgvectorAvailable(getPool());
  let intentEmbedding = null;
  if (hasVector && intentText) {
    intentEmbedding = await azureEmbed(redactSecrets(intentText)); // redact before egress
  }

  const repoId = await resolveSecurityRepoId(securityRepoName(repoRoot));
  const rows = await store.queryIncidentNeighbourhood({
    repoId, targetPaths: paths, intentEmbedding, k: parsed.data.k, hasVector,
  });
  out({ ok: true, cloud: true, mode: hasVector ? 'embedding+path' : 'path-only', rows });
}
```

Plus a Zod schema near the top:
```js
const NeighbourhoodInputSchema = z.object({
  targetPaths: z.array(z.string()),
  intentDescription: z.string().optional(),
  k: z.number().int().min(1).max(50).optional().default(8),
});
```

### 3. `package.json` — add the npm scripts

```json
"security:refresh": "node scripts/security-memory/refresh-incidents.mjs",
"security:log": "node scripts/security-incidents.mjs log"
```

### 4. `scripts/setup-postgres.mjs` (or your migration runner) — register the migration

```js
const SQL_FILES = [
  // ...existing 001/002...
  { name: '003-security.pg.sql', path: path.join(__dirname, 'lib', 'stores', 'sql', '003-security.pg.sql') },
];
```

### 5. Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_ENDPOINT` | for embeddings | — | Azure embedding calls (skip → path-only mode) |
| `AZURE_OPENAI_EMBED_DEPLOYMENT` | No | `text-embedding-3-small` | Embedding deployment (dim=768) |
| `AUDIT_DB_URL` (or `AUDIT_POSTGRES_URL`) | Yes | — | Postgres connection string |
| `SECURITY_REPO_NAME` | No | git-remote name | Pins `repo_id` when git origin is absent (CI / shallow clones) |

---

## Porting steps

1. Copy `files/*` over your repo root.
2. Apply the 5 shared-file edits above.
3. `npm run db:setup-postgres` (or your migration runner) → applies `003-security.pg.sql`.
4. `npm test` → the 6 security test files should pass (they mock Azure, so no creds needed).
5. `/security-strategy bootstrap` (or hand-create `docs/security-strategy.md` from the template) →
   then `npm run security:refresh`.
6. (Optional) wire the CI workflow + add `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_ENDPOINT` repo
   secrets to exercise the live pgvector-ON path.

---

## Key design decisions (full rationale in [PLAN.md](./PLAN.md) §2)

- **Branch-gating**: feature branches UPSERT incidents (additive); the sweep that marks
  removed-from-markdown incidents `historical` runs **only on `main`** — ephemeral branch edits
  can't wipe canonical history.
- **Secret handling**: hybrid — **refuse** on high-confidence shapes (API keys, JWTs, AWS keys),
  **auto-redact** low-confidence PII (emails, phones) with a loud warning.
- **Embeddings**: Azure `text-embedding-3-small` with `dimensions: 768` (honours "all LLM via
  Azure AI Foundry"); schema stays `VECTOR(768)`.
- **pgvector optional**: `CREATE EXTENSION IF NOT EXISTS vector` guarded; absent → embedding
  column/RPC omitted, keyword/path-overlap fallback.
- **Mandatory `commit_sha`** (NOT NULL): every incident traces to a real fix in git history.
- **`classification`** (UPPERCASE 4-value `PUBLIC|INTERNAL|CONFIDENTIAL|RESTRICTED`) +
  **`compliance_tags TEXT[]`** for regulated-data flagging.

> **Note on naming deviations** (carried for compatibility, see PLAN §"Deviations"): the migration
> is `003-security.pg.sql` (not `002` — taken by arch-memory) and inserts `schema_version v=5`; the
> RPC is `security_incident_neighbourhood` (avoids an arch-memory `incident_neighbourhood` stub
> collision). Rename freely in a fresh repo that doesn't have those collisions.
