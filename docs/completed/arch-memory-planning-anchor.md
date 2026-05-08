# Plan: Arch-Memory Planning Anchor

- **Date**: 2026-05-03
- **Status**: Draft v6 (post R1+R2+R3 GPT + Gemini ×2 — 9H/14M/2L addressed; 2 Gemini-R1 HIGHs challenged as invalid claims about pre-existing code; all Gemini-R2 MEDIUMs accepted)
- **Author**: Claude + Louis
- **Scope**: backend
- **Stack**: js-ts (Node ESM)

## 1. Context Summary

The architectural-memory pipeline indexes symbols, tags them with
domains, surfaces drift, and renders `docs/architecture-map.md`. As
of v6 of the arch-memory plan everything is live across 3 repos. **But
domain context — which we now reliably compute via path-based tagger
rules — is dropped before reaching the planner.**

Specifically:

- `getNeighbourhood()` returns records with `domainTag: "<domain>"` per
  candidate (verified live).
- `renderNeighbourhoodCallout()` (`scripts/lib/arch-render.mjs:221`)
  builds the `> **Neighbourhood considered**` table the planner sees,
  but **drops the domain field**. So planners never see "the candidate
  you might reuse is in the `wine-shop` domain".
- `/plan` SKILL.md doesn't compute the *target* domain (where the new
  code will land) — just the candidates.
- No cross-domain warning when `targetPaths` span multiple domains.
- `/explain` doesn't surface domain at all.
- The rendered `architecture-map.md` has per-domain Mermaid diagrams +
  flat tables but no human-readable "what is this domain" summary, no
  per-symbol "where used", no link back into the planner.

This is all **fixable with data we already have** — domain-tagger,
dep-cruiser layering graph, Haiku summarisation pattern, and the cross-
skill RPC bridge are all in place. No new pipelines required.

### Neighbourhood considered

> **Neighbourhood considered** (10 candidates from symbol-index)
>
> | Symbol | Path | Domain | Sim | Recommendation |
> |---|---|---|---|---|
> | `tagDomain` | `scripts/lib/symbol-index/domain-tagger.mjs:88` | `arch-memory` | 0.61 | **reuse** (mandatory per task) |
> | `loadDomainRules` | `scripts/lib/symbol-index/domain-tagger.mjs:115` | `arch-memory` | 0.61 | **reuse** |
> | `getNeighbourhoodForIntent` | `scripts/lib/neighbourhood-query.mjs` | `shared-lib` | 0.65 | **reuse** (planner's existing RPC) |
> | `renderNeighbourhoodCallout` | `scripts/lib/arch-render.mjs:221` | `shared-lib` | 0.63 | **extend** (add Domain column) |
> | `renderArchitectureMap` | `scripts/lib/arch-render.mjs:135` | `shared-lib` | 0.64 | **extend** (per-domain summaries + footer) |
> | `groupByDomain` | `scripts/lib/arch-render.mjs:45` | `shared-lib` | 0.66 | **extend** (return summary metadata too) |
> | `summariseBatch` | `scripts/symbol-index/summarise.mjs` | `arch-memory` | 0.63 | **mirror** (new sister fn for domain summaries) |
> | `copyForwardUntouchedFiles` | `scripts/learning-store.mjs:1905` | `learning-store` | 0.67 | **extend** (carry domain-summary cache forward) |
> | `renderMermaidContainer` | `scripts/lib/arch-render.mjs:69` | `shared-lib` | 0.67 | **extend** (consume domain summary) |
> | `main (render-mermaid)` | `scripts/symbol-index/render-mermaid.mjs` | `arch-memory` | 0.61 | **extend** (fetch summaries + import graph) |

### What exists today

- **`scripts/lib/symbol-index/domain-tagger.mjs`** — `matchGlob`, `tagDomain(filePath, rules)`, `loadDomainRules(repoRoot)`. Path-based, deterministic. Reuse in plan + explain.
- **`scripts/symbol-index/extract.mjs`** — runs dependency-cruiser, captures the import graph as `dependencies` per source file. **Currently only used to compute layering violations** — the raw graph is discarded after that. The "where used" data is sitting on the floor.
- **`scripts/symbol-index/summarise.mjs`** — Haiku-batched per-symbol purpose summaries. Same pattern works for per-domain summaries with a different prompt.
- **`scripts/learning-store.mjs`** — `recordSymbolIndex`, `copyForwardUntouchedFiles`, RPC wrappers. Migration `20260501120000_symbol_index.sql` is the table baseline.
- **`scripts/lib/arch-render.mjs`** — pure renderer. Returns `{markdown, ...}` from each fn.
- **`skills/plan/SKILL.md`** Phase 0.5 already calls `getNeighbourhood`. Adding 2 lines: target-domain computation + cross-domain warning render.
- **`skills/explain/SKILL.md`** — separate flow, needs its own one-line addition.

## 2. Proposed Architecture

### 2.1 Plumbing the existing domainTag through the planner (#3, #10 — Single Source of Truth, Modularity)

**`renderNeighbourhoodCallout()` extension** — add a `Domain` column to
both the top-N callout table and the appendix flat table. No data
fetching changes; `domainTag` is already in `records`. Empty domain
renders as em-dash so column stays aligned.

```diff
- > | Symbol | Path | Sim | Recommendation | Purpose |
- > |---|---|---|---|---|
+ > | Symbol | Path | Domain | Sim | Recommendation | Purpose |
+ > |---|---|---|---|---|---|
```

This change is mechanical and risk-free.

### 2.2 Target-domain computation in /plan (#1, #11 — DRY, Testability)

**New helper function** `computeTargetDomains(targetPaths, rules)` in
`scripts/lib/symbol-index/domain-tagger.mjs`:

```js
export function computeTargetDomains(targetPaths, rules) {
  const tagged = new Set();
  const untagged = [];
  for (const p of targetPaths) {
    const d = tagDomain(p, rules);
    if (d) tagged.add(d);
    else untagged.push(p);
  }
  return {
    domains: Array.from(tagged).sort(),
    untaggedPaths: untagged,        // R2-M4: surface, don't drop
    crossDomain: tagged.size > 1,
  };
}
```

R2-M4: untagged paths (no matching domain rule) are returned alongside
the classified domains, not silently dropped. The cross-domain warning
trigger stays based on `tagged.size > 1` (untagged paths don't count
as "another domain" since we don't know what they are), but a
**separate "untagged paths" callout** appears whenever
`untaggedPaths.length > 0`, surfacing the gap to the user — they may
want to add a rule to `.audit-loop/domain-map.json` before proceeding.

Pure function, fully covered by `tagDomain`'s existing test infrastructure.

**`scripts/cross-skill.mjs`** gets a new `compute-target-domains`
sub-command. **Single interface (R3-M1):** `--json '{"targetPaths":[...]}'`
on argv (consistent with all other cross-skill sub-commands). No `--paths`
csv form, no stdin reading. Emits the helper's full result verbatim:

```json
{
  "ok": true,
  "domains": ["arch-memory", "shared-lib"],
  "untaggedPaths": ["random-utility.js"],
  "crossDomain": true
}
```

The planner shells out exactly once per plan and renders all three
fields (R3-H1: untaggedPaths must be threaded through to plan output,
not just returned by the helper).

**`/plan` SKILL.md Phase 0.5 update**:

```bash
# Existing: get neighbourhood
node scripts/cross-skill.mjs get-neighbourhood ...

# New: compute target domains
node scripts/cross-skill.mjs compute-target-domains --json '{"targetPaths":[...]}'
```

Plan output gains a header block right after the metadata:

```markdown
- **Target domain(s)**: `arch-memory`, `shared-lib`
- ⚠ **Cross-domain work** — touches >1 domain; confirm boundary crossings are intentional.
- ⚠ **Untagged paths**: `random-utility.js`, `another.js` — these don't match any rule in `.audit-loop/domain-map.json`. Consider adding a rule before designing.
```

Header lines are conditional:
- Cross-domain warning renders when `domains.length > 1` (R2-M4: based
  on tagged set only — null-domain paths don't trigger this directly).
- Untagged-paths warning renders when `untaggedPaths.length > 0`
  (R2-M4: surfaces the gap so it can't silently disappear).

### 2.3 Phase 0.6 — Anchor against the rendered map (#19 — Observability)

New SKILL.md phase between 0.5 (neighbourhood query) and 1 (Explore):

> ### Phase 0.6 — Read the rendered architecture map for the target domain(s)
>
> If `docs/architecture-map.md` exists AND target domains are non-empty:
> grep the document for the `## <domain>` section heading(s) and read
> the symbol table beneath each. This is the human-curated view of
> what's already in the domain and complements the embedding-based
> neighbourhood query.

Does NOT shell out to a tool — just instructs the planner to use Read +
Grep on the local file. Zero new infrastructure.

### 2.4 /explain domain surfacing (#10, #19 — Single Source of Truth, Observability)

`/explain` needs concrete data plumbing — not just SKILL.md prose
(R1-H3). Two new cross-skill subcommands carry the data; SKILL.md
calls them deterministically.

**Two new `scripts/cross-skill.mjs` subcommands**:

1. `compute-target-domains` (already specified in §2.2, reused here for
   the single-path case) — returns `{domains: [<file's domain>]}` for
   the file being explained.

2. `get-callers-for-file --json '{"path":"<file>"}'` — queries
   `symbol_file_imports` for the active snapshot, returns:
   ```json
   {
     "ok": true,
     "cloud": true,
     "callers": [
       {"importer_path": "src/foo.js", "domain": "wine-shop"},
       {"importer_path": "src/bar.js", "domain": "pairing-lab"}
     ],
     "callerDomains": ["pairing-lab", "wine-shop"],
     "snapshotProvenance": "import-graph-populated"
   }
   ```
   Joins importers to their domain via the existing
   **`loadDomainRules(cwd)` + `tagDomain(importer_path, rules)`**
   helpers (R2-M3 — reuse the existing abstraction; do not re-read the
   file inline). The cross-skill subcommand calls
   `loadDomainRules(process.cwd())` once, then `tagDomain(p, rules)`
   per importer.

   When `import_graph_populated == false` for the active snapshot,
   `snapshotProvenance: "pre-feature-snapshot"` and `callers: []` —
   /explain skips the cross-domain reach finding to avoid false signal.

**`/explain` SKILL.md update** — its existing file/symbol identification
phase gains two deterministic shellouts:

```bash
# 1. Get the explained file's domain
FILE_DOMAIN=$(node scripts/cross-skill.mjs compute-target-domains \
  --json '{"targetPaths":["<file>"]}' | jq -r '.domains[0] // "unknown"')

# 2. Get callers + their domains
CALLERS=$(node scripts/cross-skill.mjs get-callers-for-file \
  --json '{"path":"<file>"}')
```

Output additions:

```markdown
**Domain**: `<X>`
```

**Cross-domain reach detection — deterministic spec (R3-M2,
Gemini-R2-G3)**:

Given `callerDomains` (the list of distinct domain tags from importers,
sorted alphabetically), let `homeDomain = tagDomain(file)`. The
"cross-domain reach" finding triggers if and only if **all** of:

1. `callerDomains.length > 0` (importers exist)
2. `nonSelfCallerDomains = callerDomains.filter(d => d !== homeDomain)` has length **> 0** (Gemini-R2-G3: ANY external domain caller is the leak; a single cross-domain importer is the most common architectural violation. Previous `> 1` threshold silently ignored direct A→B encapsulation breaks — defeating the feature's primary use case.)
3. `homeDomain` is NOT in the cross-cutting allowlist (constant in
   `/explain` SKILL.md): `["shared-lib", "shared-frontend", "core",
   "utils", "scripts"]`
4. `snapshotProvenance === "import-graph-populated"` (R1-H2 / R2-H1 —
   skip silently if false to avoid false signal)

When triggered, render exactly:

```markdown
**Cross-domain reach detected**: `<homeDomain>` file called from
`<nonSelfCallerDomains[0]>`, `<nonSelfCallerDomains[1]>`<, +N more if any> — explain whether this is intentional shared API vs leaked internal.
```

When NOT triggered, omit the section entirely (don't emit "_no
cross-domain reach_" — keeps /explain output clean).

When `snapshotProvenance == "pre-feature-snapshot"`: skip both the
cross-domain reach AND the importer list with a one-line note
`_caller analysis unavailable — snapshot pre-dates symbol_file_imports table_`.

This gives /explain real plumbing instead of hand-waving at the data.

### 2.5 Per-domain LLM summaries (#1, #20 — DRY, Long-Term Flexibility)

**Schema addition** — new table `domain_summaries`. **Repo-scoped, not
refresh-scoped** — a domain's summary is permanent for the repo until
the cache invariants change (R1-M1: there's no "carry forward" because
there's nothing per-snapshot to carry; the row IS permanent until a
new generation event):

```sql
CREATE TABLE domain_summaries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id         UUID NOT NULL REFERENCES audit_repos(id),
  domain_tag      TEXT NOT NULL,
  summary         TEXT NOT NULL,           -- 1-2 line Haiku output
  composition_hash TEXT NOT NULL,           -- sha256(sorted file_paths in domain)
  symbol_count    INTEGER NOT NULL,
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  generated_model TEXT NOT NULL,
  UNIQUE (repo_id, domain_tag)
);

CREATE INDEX idx_domain_summaries_repo ON domain_summaries(repo_id);
```

**Cache lifecycle (R1-M1 clarification)**:

- The `UNIQUE (repo_id, domain_tag)` row is the canonical summary.
- `summarise-domains.mjs` runs per `arch:render`: for each domain in
  the active snapshot, compute current `compositionHash` + `symbolCount`,
  compare against the stored row's values:
  - Both match → noop (cache hit)
  - Either differs → call Haiku, UPSERT (overwriting the prior summary)
- There is NO copy-forward step in `copyForwardUntouchedFiles` for this
  table — the row persists across refreshes by virtue of being repo-
  scoped, not refresh-scoped. (Removed the misleading "carry forward"
  language from §4 file-level plan.)

Cache invariants (R2-M2 added template + model; **Gemini-R2-G2 hardened
composition_hash to be content-aware, not path-aware**):

- **`composition_hash = sha256(sorted "<definition_id>|<signature_hash>" rows in domain)`** — content-derived, not path-derived. Any internal refactor that changes a symbol's body (and therefore its `signature_hash` per the existing extraction pipeline) invalidates the summary. The previous `sha256(file_paths)` approach missed file-internal refactors that kept the path stable but changed the meaning of the code.
- `symbol_count` differs by >20% from cached value (still useful as a coarse-grained check; covers cases where the bulk of bodies are unchanged but a wave of new symbols appeared)
- **`prompt_template_version`** (integer constant in `summarise-domains.mjs`; bump on any prompt change) differs from cached value
- **`generated_model`** (concrete resolved model ID) differs from cached — protects against `latest-haiku` rolling forward

Any one trigger forces regeneration. All four axes are cheap
(computed from the snapshot's symbol_index rows + a constant + a
resolveModel() call). Schema additions:

```sql
ALTER TABLE domain_summaries
  ADD COLUMN prompt_template_version INTEGER NOT NULL DEFAULT 1;
-- composition_hash and generated_model already in the v1 schema; just
-- enforce we compute composition_hash from definition_id+signature_hash
-- (Gemini-R2-G2) and compare both on cache read.
```

**Library API + thin CLI wrapper (R2-H2)** — `summarise-domains.mjs`
exports a function for in-process use AND has a CLI shim:

```js
// Library API — what render-mermaid.mjs imports
export async function summariseDomains({ repoId, refreshId, supabase, model }) {
  // Returns {summaries: Map<domain, {summary, source: 'cache'|'fresh'}>,
  //          errors: [{domain, code, message}],
  //          stats: {total, cacheHits, fresh, failed}}
}

// CLI: thin wrapper that calls summariseDomains() and emits JSON
// Exit code 0 if any domain succeeded; exit 1 only on argv error or
// "all domains failed" (mirrors brainstorm-round.mjs total-output).
async function main() { /* parseArgs → init store → summariseDomains → emit */ }
```

`render-mermaid.mjs` imports `summariseDomains` directly (no spawn).
The CLI exists for ad-hoc invocation via `npm run arch:summarise-domains`.

**Algorithm**:

1. Fetch grouped symbols for the active snapshot (group by `domain_tag`).
2. For each domain: compute `compositionHash` + `symbolCount`. Look up
   prior cache row in `domain_summaries`.
3. Cache hit (all invariants match — see R2-M2 below) → reuse.
4. Cache miss → call Haiku via `latest-haiku` sentinel.
5. UPSERT into `domain_summaries` (overwrites prior).

**Haiku call contract (R1-M2)**:

The function signature mirrors the rest of the codebase's LLM wrappers:

```js
async function summariseDomain({ domain, symbols, filePaths, model }) {
  // Returns {result, usage, latencyMs}
  // result: { summary: string }                         (Zod-validated)
  // usage:  { inputTokens, outputTokens }
  // latencyMs: number
}
```

Zod schema (in `scripts/lib/symbol-index/schemas.mjs` if it exists,
otherwise inline in summarise-domains.mjs):

```js
export const DomainSummarySchema = z.object({
  summary: z.string().min(20).max(400),  // bounded length forces concision
});
```

Error states + behaviour:
| State | Behaviour |
|---|---|
| HTTP 4xx / 5xx | Skip the domain (don't UPSERT); log to stderr; renderer falls back to "_(summary unavailable — see Haiku log)_" |
| Timeout (60s) | Same as HTTP error |
| Empty response | Same |
| Schema validation failure (summary too short / too long) | Same — don't UPSERT a malformed value |
| Haiku rate limit (429) | Retry once with 2s backoff; on second failure, skip |

Per-domain failures don't block other domains. The summarise-domains
script exits 0 if ≥1 domain succeeded, 1 only if argv error or all
domains failed (mirrors brainstorm-round.mjs total-output contract).

Prompt template (kept simple to keep cost low):

> Write a one-or-two-sentence description of what the `<domain>` domain
> in this repo handles. Be concrete; avoid vacuous phrasing like
> "manages various concerns". Keep under 400 characters.
>
> Domain has <N> symbols across <M> files. Sample symbols:
> - <symbol_name>: <purpose_summary> (<file_path>)
> - …
>
> Description:

Sample N=10 symbols (highest by symbol_count per file, alphabetical
tiebreak) to keep prompt bounded.

**Run timing**: invoked from `arch:render` BEFORE the Mermaid render
pass so the renderer has the cached summaries available. Steady-state
cost: ~$0 (full cache hit). First run per repo: ~$0.005 (16-32 domains
× ~$0.0002 each via Haiku).

**`renderArchitectureMap()` extension** — accepts `domainSummaries: Map<domain, summary>`
arg, renders below each `## <domain>` heading:

```markdown
## arch-memory

> Symbol-index pipeline: extraction (ts-morph), Haiku summaries,
> Gemini embeddings, snapshot publication, and drift detection.
```

### 2.6 "Where used" — leveraging the dep-cruiser graph (#10, #20)

**The data already exists** — `extract.mjs` runs dependency-cruiser
(`cruise()`) which produces `dependencies: [{resolved: "<file>"}]`
per source file. Currently we only use it for layering violations. **We
discard the import graph after that.**

**Persist the inverse graph**:

```sql
CREATE TABLE symbol_file_imports (
  refresh_id      UUID NOT NULL REFERENCES refresh_runs(id) ON DELETE CASCADE,
  importer_path   TEXT NOT NULL,
  imported_path   TEXT NOT NULL,
  UNIQUE (refresh_id, importer_path, imported_path)
);

CREATE INDEX idx_sfi_imported ON symbol_file_imports(refresh_id, imported_path);
CREATE INDEX idx_sfi_importer ON symbol_file_imports(refresh_id, importer_path);
```

Per-snapshot, refresh-scoped. Indexed on **both** ends — `imported_path`
for "who imports this file" lookup, `importer_path` for the
copy-forward key (R1-H1).

**`extract.mjs` extension** — emit `imports: [{importer, imported}]`
alongside `symbols` and `violations`.

**Filter external dependencies (Gemini-R1-G3, Gemini-R2-G1)** —
dependency-cruiser emits edges to `node_modules` and Node builtins.
Persisting those bloats `symbol_file_imports` with millions of useless
rows. **Use the dep-cruiser-emitted metadata, not string matching**
(Gemini-R2-G1: `fs/promises`, `util/types`, `stream/web` are core
Node modules with slashes — string-only filters miss them):

```js
function isInternalEdge(dep) {
  if (!dep || !dep.resolved) return false;
  // dep-cruiser-emitted flags — authoritative
  if (dep.coreModule === true) return false;
  const types = dep.dependencyTypes || [];
  if (types.includes('core')) return false;
  if (types.includes('npm')) return false;
  if (types.includes('npm-dev')) return false;
  if (types.includes('npm-optional')) return false;
  if (types.includes('npm-peer')) return false;
  if (types.includes('npm-bundled')) return false;
  // Belt-and-braces — also exclude anything that resolved into
  // node_modules even if dep-cruiser missed the type tag
  const r = dep.resolved;
  if (r.includes('node_modules/') || r.includes('node_modules\\')) return false;
  if (r.startsWith('node:')) return false;
  return true;
}

const internalImports = depCruiserOutput.modules.flatMap(m =>
  (m.dependencies || [])
    .filter(isInternalEdge)
    .map(d => ({ importer: m.source, imported: d.resolved }))
);
```

The metadata-first check is correct for `fs/promises`, `util/types`,
`stream/web` (all marked `coreModule: true` + `dependencyTypes: ['core']`
by cruiser regardless of whether the path contains a slash). The
string check is defence-in-depth for older cruiser versions or unusual
configurations. Tested in §6.

**`refresh.mjs` extension** — bulk-insert the imports into
`symbol_file_imports`. Fits neatly between symbol upsert and embedding
upsert. Chunked to 500/batch like other inserts.

**`copyForwardUntouchedFiles()` extension — keyed on `importer_path`**
(R1-H1 — edges are owned by the importer side, not the imported side):

- Touched files have their import edges fully re-extracted in this
  refresh.
- For untouched files, copy-forward the rows where
  `importer_path IN (untouched_set)`. This means: if `a.js` (touched)
  drops its import of `b.js` (untouched), the dropped edge is correctly
  absent from the new snapshot — `a.js` only emits its current edges.
- Naive copy-forward keyed on `imported_path` would have kept the stale
  edge alive (b.js would still appear to be imported by a.js). The
  importer-keyed approach is the only correct one.

### 2.6.1 Snapshot provenance — distinguishing "leaf" from "missing data" (R1-H2, R2-H1)

"0 importers" is ambiguous: it could mean (a) genuinely a leaf, (b) the
snapshot pre-dates this feature so the table was never populated for
that refresh, or (c) the refresh ran but the migration wasn't applied
on the consumer DB. These are different states and the renderer must
not collapse them.

**Add `import_graph_populated BOOLEAN` to `refresh_runs`** (default
`false`). The refresh.mjs flow sets it via the **chain-of-trust rule
(R2-H1)** — incremental refreshes only have full coverage if the prior
snapshot ALSO had it:

| Refresh mode | Prior snapshot's flag | This snapshot's flag |
|---|---|---|
| Full refresh | n/a — every file re-extracted | `true` |
| Incremental | `true` — copy-forward + new edges = full coverage | `true` |
| Incremental | `false` — copy-forward of nothing leaves untouched files with no edges | `false` (partial coverage) |
| Incremental | NULL — no prior snapshot | `false` |

So a freshly-deployed feature requires a single `arch:refresh:full` per
repo to flip the chain to `true`. Subsequent incrementals stay `true`
because they correctly inherit + extend.

Renderer reads this flag once per render:

| `import_graph_populated` | Importers count | Render |
|---|---|---|
| `true` | ≥1 | `\`a.js\`, \`b.js\`, \`c.js\` …` |
| `true` | 0 | `_(internal)_` (genuinely a leaf in this snapshot) |
| `false` | n/a | `_(unknown — run \`npm run arch:refresh:full\` to populate)_` |

This removes the false-leaf signal entirely AND tells the user how to
fix the missing-data state.

### 2.6.2 "Top 3 importers" — define "top" (R1-L1)

`top` = alphabetical sort by `importer_path`, take first 3, suffix
`, +N more` if more exist. Stable across renders (no churn) and trivial
to compute. The user can run a future `arch:where-used <file>` for the
full list (out of scope, §8).

**`render-mermaid.mjs` extension** — for each domain group:

1. Read `import_graph_populated` from `refresh_runs` for the active
   snapshot (single boolean lookup).
2. Bulk-fetch importers for all `file_path` values in the domain via:
   ```sql
   SELECT imported_path, importer_path
   FROM symbol_file_imports
   WHERE refresh_id = $1 AND imported_path = ANY($2)
   ```
3. Group by `imported_path`; deduplicate; sort alphabetically; take
   top 3 importer files per imported file (R1-L1).
4. Pass to `renderArchitectureMap` (which then forwards into
   `renderSymbolTable`) as **two new args** (R3-H2 — must be threaded
   end-to-end, not just produced):
   - `importerMap: Map<filePath, string[]>`
   - `importGraphPopulated: boolean`

**`renderArchitectureMap` signature update (R3-H2)**:

```js
renderArchitectureMap({
  /* existing args */,
  importerMap,           // R3-H2: new
  importGraphPopulated,  // R3-H2: new
  domainSummaries,       // §2.5
})
```

Forwards both new args to `renderSymbolTable(symbols, dupSymbolIds, {
importerMap, importGraphPopulated })`. Without this thread-through, the
renderer can't distinguish "0 importers because leaf" from "0 importers
because pre-feature snapshot" — the §2.6.1 design fails silently.

**`renderSymbolTable()` extension** — adds a "File imported by" column
(R2-M1 — explicitly named to signal **file-level granularity**, not
symbol-level). All symbols within the same file therefore show the same
importer list — that's by design, not a bug. The data we have is
file-level (dependency-cruiser graph); symbol-level resolution is a
v2 concern (§8). Documented inline in the rendered map's "How to
interpret" footer:

> The "File imported by" column lists the top files that import the
> file each symbol lives in (alphabetical, top 3, suffix `, +N more`
> if more exist). All symbols in the same file share the same list —
> the data is file-level, not per-symbol.

For each row:
- 1+ importers → `\`path1\`, \`path2\`, \`path3\`` (alphabetical sort,
  R1-L1; suffix `, +N more` if >3 exist)
- 0 importers + `import_graph_populated == true` → `_(internal)_`
- 0 importers + `import_graph_populated == false` → `_(unknown — run \`npm run arch:refresh:full\`)_`

Leaf-only symbols get the explicit `(internal)` marker so the reader
knows it's not a missing-data bug.

### 2.7 Footer link back to /plan (#19 — Observability)

**`renderArchitectureMap()` footer** — append:

```markdown
---

## Plan a change in this area

- Quick: `/plan <task description>` — auto-detects scope + consults this index for near-duplicates
- Atomic: `/plan-backend` / `/plan-frontend` (deprecated aliases)
- Onboarding: `/explain <file:line>` — shows domain + git history + principles
- Drift triage: `npm run arch:duplicates` — top cross-file duplicate clusters
```

Pure markdown; no logic changes.

## 3. Sustainability Notes

- **All deltas are extensions, not rewrites.** Every renderer change is
  additive. Every new column in the rendered table is optional in the
  underlying schema (Map can be empty; column renders em-dash).
- **Domain summary cache invalidates on composition change**, not just
  symbol count. If you rename one file in a domain (composition_hash
  changes) the summary regenerates even though count is unchanged. This
  catches "I split foo.js into foo.js + bar.js" cleanly.
- **`symbol_file_imports` is snapshot-scoped** and copied forward exactly
  like `symbol_index`. Same RLS model, same anon-read / service-write
  contract, same rule about full re-extraction on touched files.
- **No new sentinels or model registry changes.** Domain summary uses
  `latest-haiku` (already in resolveModel). When Haiku is rotated this
  picks up the new ID automatically.
- **The /explain caller-domain analysis depends on `symbol_file_imports`
  being populated.** Graceful degradation: if the table is empty (older
  snapshot or migration not yet run), /explain skips the cross-domain-
  reach finding silently and just emits the file's own domain.
- **Cross-domain warning threshold may want tuning.** Some legitimate
  cross-cutting work (e.g. shared utility extraction) will trigger
  the warning. The plan v1 keeps a hard ">1 distinct domain" trigger;
  v2 could weight by symbol count or path depth. Out of scope.

## 4. File-Level Plan

### A. Domain-tagger extension

| File | Status | Edit |
|---|---|---|
| `scripts/lib/symbol-index/domain-tagger.mjs` | EDIT | Add `computeTargetDomains(targetPaths, rules)` exported function |
| `tests/domain-tagger.test.mjs` | EDIT | Add `computeTargetDomains` tests (single domain, multi-domain, all-null, mixed null+real) |

### B. Cross-skill bridge

| File | Status | Edit |
|---|---|---|
| `scripts/cross-skill.mjs` | EDIT | New sub-command `compute-target-domains` reading `--json '{targetPaths:[...]}'`; emits `{domains, crossDomain}` |
| `scripts/cross-skill.mjs` | EDIT | New sub-command `get-callers-for-file` reading `--json '{path:"<file>"}'`; queries symbol_file_imports for active snapshot; joins importers to `tagDomain()`; emits `{callers, callerDomains, snapshotProvenance}` (R1-H3) |
| `tests/cross-skill-target-domains.test.mjs` | NEW | Sub-command contract tests |

### C. Renderer changes

| File | Status | Edit |
|---|---|---|
| `scripts/lib/arch-render.mjs` | EDIT | (1) `renderNeighbourhoodCallout` adds Domain column; (2) `renderArchitectureMap` accepts `domainSummaries` + `importerMap` + renders summaries below domain headings; (3) appends footer "Plan a change in this area"; (4) `renderSymbolTable` adds "Where used" column |
| `tests/arch-render.test.mjs` | EDIT | New cases for Domain column, summary block, where-used column, footer presence |

### D. Domain summaries (Haiku)

| File | Status | Edit |
|---|---|---|
| `scripts/symbol-index/summarise-domains.mjs` | NEW | CLI: read snapshot, group by domain, hit cache or call Haiku, upsert |
| `scripts/learning-store.mjs` | EDIT | New `getDomainSummaries(repoId)` (repo-scoped, not refresh-scoped — R1-M1), `upsertDomainSummary({repoId, domainTag, summary, compositionHash, symbolCount})`. **No** copy-forward for this table — rows are permanent per-repo. |
| `supabase/migrations/20260503150000_domain_summaries.sql` | NEW | `CREATE TABLE domain_summaries`, indexes, anon-read RLS, GRANTs |

### E. Where-used (dep-cruiser graph persistence)

| File | Status | Edit |
|---|---|---|
| `scripts/symbol-index/extract.mjs` | EDIT | Emit `imports: [{importer, imported}]` from cruiser output |
| `scripts/symbol-index/refresh.mjs` | EDIT | Bulk-upsert `symbol_file_imports` rows after symbol upsert; chunked at 500 |
| `scripts/learning-store.mjs` | EDIT | New `recordSymbolFileImports`, `getImportersForFiles({refreshId, paths})` (returns Map sorted alphabetically — R1-L1); `copyForwardUntouchedFiles` carries imports forward keyed on **importer_path** (R1-H1) for untouched importer files only |
| `scripts/learning-store.mjs` | EDIT | New `markImportGraphPopulated(refreshId)` setter + `getRefreshProvenance(refreshId)` reader (R1-H2) |
| `supabase/migrations/20260503160000_symbol_file_imports.sql` | NEW | `CREATE TABLE symbol_file_imports`, both indexes (importer + imported — R1-H1), anon-read RLS, GRANTs |
| `supabase/migrations/20260503170000_refresh_provenance.sql` | NEW | `ALTER TABLE refresh_runs ADD COLUMN import_graph_populated BOOLEAN DEFAULT false` (R1-H2 — distinguishes leaf from missing-data) |

### F. Render orchestration

| File | Status | Edit |
|---|---|---|
| `scripts/symbol-index/render-mermaid.mjs` | EDIT | Before render: invoke `summarise-domains.mjs` (in-process import + call); fetch domain summaries + importer map; pass to `renderArchitectureMap` |
| `package.json` | EDIT | New script `arch:summarise-domains` for ad-hoc invocation outside the render flow |

### G. Skill SKILL.md updates

| File | Status | Edit |
|---|---|---|
| `skills/plan/SKILL.md` | EDIT | Phase 0.5 adds `compute-target-domains` invocation + Target-domain header + cross-domain warning rendering; new Phase 0.6 "Read architecture-map.md for target domain(s)" |
| `skills/explain/SKILL.md` | EDIT | Output format gains "Domain" line; cross-domain-reach finding when caller domains differ; **fix existing `git log -L <line>,<line>+10:<file>` template (Gemini-G4 — git's `-L` doesn't evaluate `<line>+10` arithmetic) → use git's native offset syntax `git log -L <line>,+10:<file>`** |

### H. Sync + consumer rollout

| File | Status | Edit |
|---|---|---|
| `scripts/sync-to-repos.mjs` | EDIT | Add `summarise-domains.mjs` to `ARCH_MEMORY_SCRIPTS` so consumers receive it |

## 5. Risk & Trade-off Register

| Risk | Mitigation |
|---|---|
| Domain summary cache aggressiveness (R3-M3 — single source of truth is §2.5; this register no longer duplicates the rules) | Cache invariants live in §2.5 only: `composition_hash`, `symbol_count` ±20%, `prompt_template_version`, `generated_model`. Any one mismatch → regenerate. |
| `symbol_file_imports` table grows unbounded | Snapshot-scoped (FK to refresh_runs ON DELETE CASCADE); existing prune.mjs already drops old refresh_runs rows after retention period |
| `getImportersForFiles` slow at 5000-symbol scale (e.g. wine-cellar) | Batch IN clauses + single SQL query per render (one query for all paths in a domain, not per-path); idx_sfi_imported makes it index-served |
| Cross-domain warning is noisy for genuinely cross-cutting work | Document "this is a heads-up, not a block" in plan output; threshold is ">1 distinct domain" — paths matching no rule don't trigger it |
| Haiku domain summaries are bland or wrong | Prompt template includes 5+ example symbols per domain so the model has concrete signal; user can edit `domain_summaries.summary` directly via SQL if needed |
| Two new migrations apply before tests run | Migrations are additive (CREATE TABLE only — no ALTER on existing tables); applying out of order with code changes is safe; rollback = DROP TABLE |
| `/explain` cross-domain-reach finding triggers on shared-utility imports (correct but noisy) | Only emit when caller domain count > 1 AND target file isn't in `shared-*` domain; configurable later |

### Deliberately deferred

| Item | Reason |
|---|---|
| LLM-generated cross-domain reach explanations (vs deterministic detection) | v1 just lists; explanation can come from `/explain` itself |
| Importance-weighted "top-15" symbol selection in Mermaid diagrams | Current "by file order" is good enough; importance ranking needs call-graph weighting we don't have yet |
| Domain-summary refinement based on user feedback | No mechanism for that yet; first pass is the baseline |
| Visualizing the import graph in Mermaid (edges between files within a domain) | Would blow up diagram size at >50 nodes; the flat table's "Where used" column is the v1 surface |

## 6. Testing Strategy

**Unit tests** (`npm test` via Node test runner):

- `tests/domain-tagger.test.mjs` — `computeTargetDomains` cases:
  - Single path, single domain → `["X"]`
  - Multiple paths, all same domain → `["X"]`
  - Multiple paths, multiple domains → sorted `["X", "Y"]`
  - All paths match no rule → `[]`
  - Mix of matched + unmatched → only matched, sorted
- `tests/cross-skill-target-domains.test.mjs` — sub-command contract:
  - Stdin and `--json` argv both accepted
  - Output shape: `{domains: [...], crossDomain: bool}`
  - `crossDomain === domains.length > 1`
  - Empty input → `{domains: [], crossDomain: false}`
- `tests/arch-render.test.mjs` (extends existing):
  - `renderNeighbourhoodCallout` output contains `| Domain |` header
  - `renderNeighbourhoodCallout` renders em-dash for null `domainTag`
  - `renderArchitectureMap` with `domainSummaries: Map([['X', 'summary text']])` emits `> summary text` below `## X`
  - `renderArchitectureMap` with `importerMap: Map([['file.js', ['a.js', 'b.js']]])` emits importers in the symbol table
  - `renderArchitectureMap` with `importerMap` empty for a file emits `_(internal)_`
  - Footer "Plan a change in this area" present in every output
- `tests/domain-summaries.test.mjs` — cache invariants:
  - Composition hash differs → cache miss
  - Symbol count delta >20% → cache miss
  - Both stable → cache hit
  - Mocked Haiku call invoked exactly once per cache miss
  - Schema validation failure → no UPSERT, returned `{state: 'malformed'}`
  - Per-domain failure doesn't block other domains
  - Exit 0 with ≥1 success; exit 1 only when all fail
- `tests/import-edge-filter.test.mjs` — Gemini-G3 isInternal()
  predicate cases:
  - `node_modules/express/index.js` → external (excluded)
  - `node_modules\\express\\index.js` → external on Windows path
  - `path` / `fs` (bare builtins) → external
  - `node:fs` / `node:path` → external (Node builtin scheme)
  - `scripts/lib/findings.mjs` → internal
  - `src/wine-shop/index.js` → internal
  - empty / null → not internal (defensive)
- `tests/symbol-file-imports.test.mjs` — **the import persistence
  pipeline** (R1-M3 — highest-risk path, was missing):
  - **extract.mjs**: given a fixture repo with known imports, emits
    `imports: [{importer, imported}]` matching expected edges
  - **refresh.mjs**: full refresh persists rows with the right
    `refresh_id`; chunked at 500/batch (provoke with 1500 fake edges)
  - **incremental copy-forward (R1-H1)**: two-snapshot scenario where
    a touched file `a.js` drops its import of untouched `b.js`; verify
    the new snapshot does NOT contain the stale (a,b) edge
  - **provenance flag (R1-H2)**: `refresh_runs.import_graph_populated`
    set to `true` only after import insert completes successfully
  - **getImportersForFiles**: mocked store returns expected shape
    `Map<imported_path, importer_path[]>` sorted alphabetically (R1-L1)

**Integration smoke** (manual, requires real Supabase):

1. `npm run arch:refresh` — verify `symbol_file_imports` rows inserted; spot-check via SQL that one indexed file has importers.
2. `npm run arch:render` — verify `docs/architecture-map.md` now shows summaries below domain headings + Where-used column populated.
3. `node scripts/cross-skill.mjs compute-target-domains --json '{"targetPaths":["scripts/lib/findings.mjs"]}'` — returns `{"domains":["findings"],"crossDomain":false}`.
4. `node scripts/cross-skill.mjs compute-target-domains --json '{"targetPaths":["scripts/lib/findings.mjs","skills/plan/SKILL.md"]}'` — returns `{"domains":["findings","skills-content"],"crossDomain":true}`.
5. Open the rendered map in VS Code — verify each `## <domain>` has a 1-2 line summary above the Mermaid block.

## 7. Rollout

Sequential, one repo at a time:

1. **audit-loop** (source of truth):
   - Apply **all three migrations** (R3-H3 — earlier draft listed only two; the feature also needs the provenance migration):
     - `20260503150000_domain_summaries.sql`
     - `20260503160000_symbol_file_imports.sql`
     - `20260503170000_refresh_provenance.sql`
     - `supabase db push --linked` applies any unsent migrations in order
   - Implement code changes (file-level plan §4)
   - `npm test` — all green
   - **First run must be `npm run arch:refresh:full`** — required to flip
     `import_graph_populated` to `true` per the chain-of-trust rule
     (§2.6.1, R2-H1). Without this, the renderer will show all symbols
     as `_(unknown — run arch:refresh:full)_`.
   - `npm run arch:render` — verify summaries + "File imported by"
     column present
   - `npm run sync` so consumers receive `summarise-domains.mjs` + the
     updated extract/refresh/render + domain-tagger.computeTargetDomains
   - Commit + push
2. **wine-cellar**:
   - Pull (gets synced files)
   - `supabase db push --linked` (each consumer's app DB doesn't run
     these — they share the audit-loop DB; this step is a no-op for
     consumers)
   - **`npm run arch:refresh:full`** (one-time per consumer to flip the
     provenance flag)
   - `npm run arch:render`
   - Commit map + push
3. **ai-organiser**: same as wine-cellar.

Total wall time estimate: 30 minutes for code + tests, ~5 min per repo
for refresh + render.

## 8. Out of Scope

- Visual graph rendering of importer edges in Mermaid (deferred — diagram size cap)
- LLM rewrite of stale domain summaries on user feedback (no feedback channel yet)
- Cross-domain warning suppression list for known-OK boundaries (config surface concern, v2)
- Per-symbol "Where used" beyond top-3 importers (use `npm run arch:duplicates` or a future `arch:where-used <symbol>` CLI for full lists)
- Backfill of `symbol_file_imports` for old snapshots (only forward — old snapshots show empty `Where used` columns; that's fine and signals "this was indexed before the feature shipped")
- Symbol-level (not file-level) import graph (dep-cruiser is file-level; symbol-level resolution would need a TS-morph pass we're not adding)
