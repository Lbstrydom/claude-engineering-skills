# Plan: Architecture-Intent PR-C — Postgres Adapter

- **Date**: 2026-05-15
- **Status**: Complete (implemented + audited via /cycle; /audit-code 2 GPT + 2 Gemini rounds 2026-05-15, all findings fixed, Gemini coherence "Strong"; see audit summary at docs/plans/arch-intent-pr-c-audit-summary.md)
- **Author**: Claude + Louis
- **Scope**: backend
- **Target domain(s)**: `shared-lib` (the `arch-intent/` module tree), `audit-orchestration` (stack detection)
- **Parent plan**: [architecture-intent-framework.md](architecture-intent-framework.md) — PR-C of the 3-PR series (§10, §11). Follows PR-A (framework + JS/TS) and PR-B (Python + Java, shipped commit `18ecc5e`).

> **Neighbourhood considered** — explored directly. The PR-B adapters
> [adapters/python.mjs](../../scripts/lib/arch-intent/adapters/python.mjs)
> and [adapters/java.mjs](../../scripts/lib/arch-intent/adapters/java.mjs)
> are the **reuse templates** — postgres.mjs mirrors their structure
> (lexical stripper → extractor → index → three-state resolver → contract
> entry). [domain-resolver.mjs](../../scripts/lib/arch-intent/domain-resolver.mjs)
> (`resolveFileToDomain`, `checkDepAllowed`, `VENDOR_DOMAIN`) is reused
> as-is. The adapter contract in
> [adapter-contract.mjs](../../scripts/lib/arch-intent/adapter-contract.mjs)
> is **frozen** — PR-C conforms, does not modify it.

---

## 1. Context Summary

**Detected scope**: backend. **Stack**: js-ts (the tool repo).

**What exists today**:
- The framework spine (`adapter-contract.mjs`): Phase 1 inventory
  (file glob → domain rules → `mapped`/`unmappedFiles`), Phase 2 per-stack
  adapter edge analysis with fault isolation.
- Three concrete adapters: `js-ts.mjs` (PR-A, dependency-cruiser),
  `python.mjs` + `java.mjs` (PR-B, pure-JS source parsers).
- The adapter contract: `default async function analyseImports({mapped,
  domainMap, repoPath})` → `{violations, _meta, analyzerVersion}`, each
  violation `{fromFile, toFile, fromDomain, toDomain, ruleViolated}` with
  `ruleViolated ∈ {not-in-allowedDeps, cycle, unknown}`.
- `stackKinds` schema enum already includes `postgres` (PR-A
  forward-declaration); `repo-stack.mjs` does NOT yet detect it.
- This repo itself has 34 `.sql` files under `supabase/migrations/` —
  usable as a real dogfooding target.

**Patterns reused vs new**:
- *Reused*: the contract, `domain-resolver.mjs`, the PR-B adapter
  structure (stripper → extractor → index → three-state resolver),
  the `_meta` fixed-keys discipline, fault isolation.
- *New*: a pure-JS SQL DDL parser. Unlike imports, the "edges" are
  foreign keys, view dependencies, function calls, trigger bindings,
  and RLS policy references.

### The three design tensions (resolved)

#### Tension 1 — Schema source: `.sql` parsing vs live `pg_catalog`

The parent plan §2 sketch said postgres.mjs "queries pg_catalog".
**Rejected** — same reasoning that rejected `import-linter` for PR-B:
querying `pg_catalog` requires a live database + credentials wherever
`/audit-code` runs (CI, every consumer repo). It cannot run in a CI
job without a provisioned DB.

**Decision**: parse `.sql` migration files directly in JavaScript — no
DB, no credentials, CI-safe. Consistent with how `python.mjs` /
`java.mjs` avoid requiring a target runtime. The DDL subset we need
(`CREATE TABLE/VIEW/FUNCTION/POLICY/TRIGGER`, `ALTER TABLE … FOREIGN
KEY`) is regular enough to extract reliably after lexical stripping.

#### Tension 2 — What a Postgres "domain edge" is

There is no `import`. Coupling between database objects is:

| Edge kind | SQL construct | Direction |
|---|---|---|
| `foreign-key` | `REFERENCES other_table` (inline col constraint OR `ALTER TABLE … ADD … FOREIGN KEY`) | the FK-bearing table → the referenced table |
| `view-select` | `CREATE VIEW v AS SELECT … FROM t` | the view → each base table/view it selects |
| `function-call` | a `CREATE FUNCTION` body that names another defined function | the function → the callee |
| `trigger-binding` | `CREATE TRIGGER … ON t … EXECUTE FUNCTION f` | the trigger's table `t` → the function `f` |
| `policy-reference` | `CREATE POLICY … ON t … USING (… other_table …)` | table `t` → each table named in the policy expression |

Each resolved edge maps a *source object* to a *target object*; the
domains come from the **files** that define those objects (Tension 3).

#### Tension 3 — `mapped` is file→domain, but objects need domains

A `.sql` migration file routinely defines objects belonging to several
domains. The contract input `mapped` is `Map<filePath, domain>` — file
granularity.

**Decision — file-granularity, NO schema extension.** Each database
object inherits the domain of the `.sql` file that *defines* it (via
`mapped` / `domainMap.rules`). An edge object-A→object-B becomes a
domain edge `domainOf(fileDefiningA) → domainOf(fileDefiningB)`,
checked against `allowedDeps`. This is the **identical file=domain
assumption every other adapter makes** (a JS file, a Python module, a
Java class each belong to one domain). It needs zero change to
`DomainMapSchema`, zero change to the contract.

The parent plan §5 said the contract "MAY need" a `_meta` extension —
"may", not "must". File-granularity conforms to the *existing* contract
and is the disciplined minimal scope. Its limitation (a single
timestamp-named migration spanning domains is mapped coarsely) is
**explicitly deferred** to a future object-granularity enhancement
(§8) — that would add an optional object-name→domain rule block to
`domain-map.json` and is out of scope for PR-C. Repos that organise
SQL by feature directory (`db/billing/**`, `db/learning/**`) get
correct results today; repos with flat timestamp-only migration dirs
get coarse-but-honest results and can adopt object-granularity later.

#### Tension 4 — violation `fromFile`/`toFile` for object edges

The violation shape requires `fromFile`/`toFile` strings. For an
object-to-object edge, `fromFile` = the `.sql` file that defines the
source object, `toFile` = the `.sql` file that defines the target
object. Both are real repo-relative paths (the files are in `mapped`).
The object identity is preserved in `_meta.edges` for transparency.
No synthetic identifiers needed — every violation cites real files.

---

## 1.5 Mandatory Pre-Implementation Consultation

PR-C introduces a new SQL parser. Per AGENTS.md, run at the start of
/cycle Step 3 (implementation):

1. **Architectural-memory**:
   ```bash
   node scripts/cross-skill.mjs get-neighbourhood --json '{
     "targetPaths": ["scripts/lib/arch-intent/adapters/postgres.mjs"],
     "intentDescription": "pure-JS Postgres DDL parser + object index + dependency-edge resolver for the arch-intent adapter contract",
     "k": 8
   }'
   ```
   Act on the `recommendation` column. `python.mjs`/`java.mjs` are the
   known `extend`-template siblings; reuse `domain-resolver.mjs`.

2. **Security-incident** — PR-C parses untrusted `.sql` files:
   ```bash
   node scripts/cross-skill.mjs get-incident-neighbourhood --json '{
     "targetPaths": ["scripts/lib/arch-intent/adapters/postgres.mjs"],
     "intentDescription": "parsing untrusted SQL migration files",
     "k": 3
   }'
   ```
   All DDL-extraction regexes MUST be bounded (no catastrophic
   backtracking) — they run over attacker-influenceable file content.

Record outcomes in the Implementation Log. Acceptance criterion #7.

---

## 2. Proposed Architecture

```
runArchIntentAnalysis (adapter-contract.mjs)        [unchanged]
  └─ Phase 2: for each stackKind → loadAdapter
       ├─ adapters/js-ts.mjs    [PR-A]
       ├─ adapters/python.mjs   [PR-B]
       ├─ adapters/java.mjs     [PR-B]
       └─ adapters/postgres.mjs [PR-C — NEW]

detectRepoStack (repo-stack.mjs)                    [PR-C — EXTENDED]
  push 'postgres' to stackKinds when .sql files / a migrations dir exist
```

### 2.1 Lexical preprocessing — `stripSqlCommentsAndStrings(source)`

A character-level scanner that is **strictly length-preserving** — every
input character maps to exactly one output character (a blanked char →
a space, newlines kept as newlines). Therefore **any offset into the
stripped source indexes the identical position in the original source**
(H2-enabling invariant — Stage 1 uses this to recover function bodies
from `originalSource` by stripped-source offsets). It blanks:

- **Line comments** — `--` to end-of-line.
- **Block comments** — `/* … */`. Postgres block comments **nest** —
  track depth.
- **String literals** — `'…'`; a doubled `''` inside is an escaped
  quote, not a terminator.
- **Escape-string literals** — `E'…'` / `e'…'` (G1 fix). Postgres
  C-style escape strings use BACKSLASH escapes: `\'` is an escaped
  quote (does NOT terminate), `\\` is a literal backslash pair. The
  scanner detects an `E`/`e` immediately before an opening `'` and, for
  that string, switches to backslash-escape rules (`\<any>` consumes
  both, doesn't terminate) — AND still honours `''` doubling. A plain
  `'…'` with no `E` prefix uses `''`-doubling only (backslash is
  literal). Without this, `E'O\'Reilly'` would terminate at the `\'`
  and desync every subsequent token.
- **Quoted identifiers** — `"…"`; a doubled `""` is an escaped quote.
  (Kept structurally — identifiers are not stripped to nothing, but
  quote-state must be tracked so a `;` or `--` inside `"weird;name"`
  is not misread.)
- **Dollar-quoted strings** — `$$ … $$` and `$tag$ … $tag$` (Postgres
  function bodies). The opening tag (`$` + optional identifier + `$`)
  must be matched by the identical closing tag. This is the critical
  one — function bodies contain SQL that must NOT be parsed as
  top-level DDL.

Pure function, exported, exhaustively unit-tested (§9).

The adapter is an explicit **3-stage pipeline** with typed intermediate
artifacts (H2 fix — the R1 draft's per-file edge extraction needed the
global function set before it existed; staging removes the chicken-and-egg):

```
Stage 1  parseFile(file)        per-file, pure → FileParse
            { objectDefs[], rawRefs[], parseError? }
Stage 2  buildSqlCatalog(parses) all files     → SqlCatalog (ordered)
            { objectToFile, objectKind, drops, redefinitions }
Stage 3  resolveEdges(rawRefs, catalog)        → Edge[] + unresolvedRefs
```

### 2.2 Stage 1 — `parseFile(strippedSql, originalSource)` → FileParse

After stripping (§2.1), split on top-level `;` into **Statement
artifacts** — `{text, startOffset, endOffset, startLine}` (H2 fix). The
stripper is length-preserving (§2.1), so `[startOffset, endOffset)`
indexes BOTH the stripped source (for classification) AND the original
source (for `originalSource.slice(startOffset, endOffset)` — used to
recover a function's dollar-quoted or `AS '…'` body). The `;`-split
guarantees no `;` hides in a string/comment/dollar-quote/quoted-identifier.

Classify each Statement via bounded regexes. **Every ref carries the
file + line of the STATEMENT that introduces it** (the dependency
originates where the statement lives, NOT where the source object was
first created). Emit:

**`objectDefs`** — one per `CREATE`. Each OWNS the refs that originate
from its own statement body (H1 fix — refs are tied to a definition
version, so a later `CREATE OR REPLACE` supersedes the earlier
version's refs):
- `CREATE [OR REPLACE] TABLE [IF NOT EXISTS] <name> ( <cols> )` —
  `kind:'relation'`; owns:
  - `foreign-key` refs from inline column `REFERENCES` + table-level
    `FOREIGN KEY` constraints;
  - `column-type` refs — each column's type token; builtin types
    (`text`, `int[eger]`, `bigint`, `boolean`, `timestamptz`, `jsonb`,
    `uuid`, `numeric`, …) are in `SQL_BUILTIN` → `proven-external`, a
    non-builtin type name resolves against the type catalog (G4).
- `CREATE TABLE <child> PARTITION OF <parent> …` — `kind:'relation'`;
  owns a `partition-of` ref `child → parent` (G1 — a partition has a
  hard structural dependency on its parent table).
- `CREATE [OR REPLACE] [MATERIALIZED] VIEW <name> AS <select>` —
  `kind:'relation'`; owns `view-select` refs. Ref extraction (M2):
  collect the identifier after each `FROM` / `JOIN`, then **exclude**
  (a) names bound as CTEs by a `WITH <cte> AS (…)` clause in the same
  statement, (b) tokens immediately followed by `(` (set-returning
  functions / `FROM jsonb_array_elements(…)`), (c) the per-source
  alias token (the identifier after `AS` or the bare alias). The
  survivors are candidate relation names — Stage 3 resolves them; a
  stray alias/CTE that still slips through resolves to `unresolved`
  (false-negative-safe — never a violation).
- `CREATE [OR REPLACE] FUNCTION <name> ( <args> ) …` — `kind:'function'`,
  arity = top-level arg count; owns `function-call` refs scanned from
  its body. Body recovered from `originalSource` — handles BOTH
  `$tag$…$tag$` dollar-quoted bodies AND the `AS '…'` single-quoted
  form (M3 fix); a bounded scan for `<identifier>(` tokens.
- `CREATE TYPE <name> AS {ENUM (…)|(…)|RANGE (…)}` and
  `CREATE DOMAIN <name> AS <base>` — `kind:'type'` (G4). A third
  catalog object kind alongside relations and functions. Custom types
  are edge TARGETS (referenced by table column types); they own no
  outbound refs themselves (a domain's base type is almost always a
  builtin — not tracked).

**`alterRefs`** — refs added by a statement that modifies an EXISTING
object; each carries its own `definingFile` (H2):
- `ALTER TABLE <t> ADD [CONSTRAINT …] FOREIGN KEY … REFERENCES <other>`
  → `foreign-key` ref, `fromObject = t`, file = the ALTER's file.
- `CREATE [OR REPLACE] [CONSTRAINT] TRIGGER <name> … ON <t> … EXECUTE
  {PROCEDURE|FUNCTION} <f>` → `trigger-binding` ref `t → f`, file = the
  trigger's file. The ref carries the trigger `name` (G2 — for
  `DROP TRIGGER` matching); `OR REPLACE` accepted (G3, PG14 syntax).
- `CREATE POLICY <name> ON <t> … USING(…)/WITH CHECK(…)` → `policy-reference`
  ref for each table named in the expression; the ref carries the
  policy `name` + its `ON` table (G2 — for `DROP POLICY` matching).
  Extraction (M2): collect
  identifiers in the `USING`/`WITH CHECK` expression that appear in a
  relation position — after `FROM`/`JOIN` inside a sub-`SELECT`, or as
  a bare schema-qualified `schema.table` token; exclude function calls
  (`ident(`), column references, and SQL keywords. Survivors are
  candidates — Stage 3 resolves; non-relations slip to `unresolved`.

**`drops`** — `DROP {TABLE|VIEW|MATERIALIZED VIEW|FUNCTION|TYPE|DOMAIN}
[IF EXISTS] <name>[, <name>…] [CASCADE|RESTRICT]` records. Postgres
permits a **comma-separated list** of objects in one `DROP` — emit one
drop record per name in the list, not just the first.
`ALTER TABLE <t> DROP CONSTRAINT [IF EXISTS] <c>` → a constraint-drop
record (see §2.3). `DROP TRIGGER <name> ON <t>` and `DROP POLICY <name>
ON <t>` → trigger-/policy-drop records (G2 — §2.3 uses these to remove
the matching `alterRef`). `ALTER TABLE … RENAME TO …` is recorded but
cross-rename resolution is a documented limitation (§8).

Each `foreign-key` `alterRef` from a `CREATE TABLE` inline/`ALTER TABLE
… ADD CONSTRAINT <c> FOREIGN KEY` carries its **constraint name** `c`
when one is given (for G3 drop-matching).

Each ref: `{kind, fromObjectName, toName, expectedKind, definingFile,
line}` — `expectedKind` (`relation`|`function`) drives kind-aware
resolution in Stage 3 (H3). `parseFile` is pure; a parse failure is
caught by the Stage-0 caller (§2.5), never thrown past the adapter.

### 2.3 Stage 2 — `buildSqlCatalog(parses)` → ordered catalog (H1 + H3 fix)

Migrations EVOLVE the schema — the **current** state is what matters,
not the first definition. Sort `.sql` files deterministically by
repo-relative path using a **natural (numeric-aware) comparison** so
non-zero-padded numbering orders correctly (`2_x.sql` before
`10_x.sql`, which a raw lexical sort gets wrong — M3 fix). This is
correct for the dominant schemes (Supabase `YYYYMMDD…` timestamps,
numbered migrations, nested dirs). Repos whose order genuinely cannot
be derived from path/filename are a documented limitation (§8).

Replay in order, tracking an **epoch counter per object** (H1 fix):

- `CREATE` / `CREATE OR REPLACE <obj>` → increment that object's
  epoch; set its entry to THIS `objectDef` (last wins); its owned refs
  replace the prior version's (superseded definitions' edges do not leak).
- `DROP <obj>` → remove the object AND its owned refs; the next
  `CREATE` of the same name starts a FRESH epoch.
- Each `alterRef` captures its `fromObject`'s epoch **at the time the
  ALTER/TRIGGER/POLICY statement is replayed**. After the full replay,
  an `alterRef` is kept only if its captured epoch === the object's
  FINAL epoch — so a ref onto an object that was later dropped and
  recreated (a new epoch) is correctly discarded, not reattached to
  the unrelated new object (H1: lifecycle boundaries preserved).
- `ALTER TABLE <t> DROP CONSTRAINT <c>` → during replay, remove any
  surviving `foreign-key` `alterRef` on `t` whose constraint name === `c`
  (dropping a constraint does not bump the table's epoch, so without
  this the FK edge would survive forever). **Limitation**: an FK added
  WITHOUT an explicit constraint name (Postgres auto-names it
  `<t>_<col>_fkey`) cannot be matched by a later `DROP CONSTRAINT
  <autoname>` — the adapter does not synthesise auto-names. Documented
  in §8.
- `DROP TRIGGER <name> ON <t>` / `DROP POLICY <name> ON <t>` → remove
  any surviving `trigger-binding` / `policy-reference` `alterRef` whose
  name + `ON` table match (G2 — triggers/policies, like constraints,
  do not bump an epoch; named drop-matching keeps their edges current).
- Re-definition history recorded in `_meta.objectRedefinitions`.

**Kind-separated identity (H3 fix)** — a table, a function, and a type
may share `schema.name`, so ONE map cannot hold them. Three maps:
- `relationToDef: Map<key, objectDef>` — tables, views, materialized views.
- `functionToDef: Map<key, objectDef>` — functions.
- `typeToDef: Map<key, objectDef>` — custom types + domains (G4).

Keys are `schema.name`:
- Unquoted identifiers → lowercased (Postgres case-folds them).
- Quoted identifiers (`"MixedCase"`) → case preserved, quotes stripped.
- Function overloads (same `schema.name`, different arity) → the
  ordered replay keeps the last; all arities recorded in
  `_meta.objectRedefinitions`. Per-overload domain precision is a
  documented limitation (§8).

(The epoch check above subsumes simple existence filtering — a
`fromObject` that no longer exists has no final epoch, so its
`alterRefs` are dropped; one that was dropped-then-recreated has a
bumped epoch, so stale `alterRefs` are dropped too.)

### 2.4 Stage 3 — `resolveEdges(catalog)` — kind-aware three-state

Collect every surviving ref: each surviving `objectDef`'s owned refs +
the kept `alterRefs`. Resolve each ref's `toName` against the map
selected by `expectedKind` (H3 + G4):
- `foreign-key`, `view-select`, `partition-of`, `policy-reference` →
  `relationToDef`;
- `function-call`, `trigger-binding` → `functionToDef`;
- `column-type` → `typeToDef`.

| State | Meaning | Treatment |
|---|---|---|
| `resolved-local` | `toName` is in the kind-appropriate catalog map | domain-checked against `allowedDeps` |
| `proven-external` | `toName` matches the frozen `SQL_BUILTIN` set — `pg_*`, `information_schema.*`, common builtin/extension functions (`gen_random_uuid`, `uuid_generate_v4`, `now`, `coalesce`, `count`, `jsonb_*`, …) | `VENDOR_DOMAIN`; always allowed |
| `unresolved` | neither — referenced but not in the catalog and not a known builtin | recorded in `_meta.unresolvedRefs`; **NOT** a violation, **NOT** vendor |

**Namespace resolution (M2-from-R1 fix)**: an explicitly-qualified
`schema.name` matches that exact key. An unqualified `name` resolves
by: (1) try `public.name`; (2) else, if EXACTLY ONE catalog object of
the expected kind has the bare `name` under any schema, use it
(best-effort — handles `app`/`core`/`auth`-schema repos); (3) if
ambiguous → `unresolved`, candidates recorded. `SET search_path`
mid-migration is NOT modelled (§8 limitation).

**Edge → violation**: `fromFile` = the **ref's `definingFile`** (where
the dependency-introducing statement lives — H2), `toFile` = the file
of the target object's surviving definition. `fromDomain` =
`domainOf(ref.definingFile)`, `toDomain` = `domainOf(target's file)`
(via `mapped`, `resolveFileToDomain` fallback).
`checkDepAllowed(fromDomain, toDomain, allowedDeps)` failure → one
violation `{fromFile, toFile, fromDomain, toDomain,
ruleViolated:'not-in-allowedDeps'}`.

### 2.5 Fault isolation + `_meta` shape (M1 fix)

**Per-file fault isolation** — Stage 0, before Stage 1: each `.sql`
file is read inside its own try/catch. A read failure (missing,
permission, non-UTF8) or a parse exception does NOT abort the adapter
— the file is skipped, recorded, and the remaining files proceed.
Files above a size guard (`SQL_MAX_FILE_BYTES`, default 4 MiB — a
migration file that large is almost certainly generated data, not
schema) are skipped and recorded too. The adapter only throws past its
boundary on a genuine programming error, never on bad input.

**`_meta` shape** (fixed keys, always present — PR-B discipline):
`{statementCount, tableCount, viewCount, functionCount, typeCount,
edgeCount, fkEdges, viewEdges, functionCallEdges, triggerEdges,
policyEdges, partitionEdges, columnTypeEdges, vendorRefs,
unresolvedRefs:[], objectRedefinitions:[], unreadableFiles:[],
parseErrors:[], skippedLargeFiles:[], edges:[], allFiles:[]}`. `edges`
carries `{fromObject, toObject, kind}`; `parseErrors` carries
`{file, message}`. `analyzerVersion`: `'postgres-1.0.0'`.

### 2.6 Stack detection — `repo-stack.mjs` extension (L1 fix)

`.sql` files are NOT all Postgres schema sources — seed scripts, test
fixtures, vendored SQL, and other dialects (MySQL/SQLite) all use the
`.sql` extension. Detection is therefore signal-tiered:

1. **`supabase/migrations/`** (the ONLY content-check-free strong
   signal) — Supabase is Postgres-exclusive, so this directory is an
   unambiguous Postgres indicator. → `postgres`.
   (M1 fix: generic `migrations/`, `db/migrations/`, `db/migrate/`,
   and `prisma/migrations/` are NOT treated as strong signals — those
   layouts are used by MySQL and SQLite too. They fall through to the
   content check below.)
2. **Content-confirmed `.sql`** — otherwise, `git ls-files -- "*.sql"`
   (monorepo-safe: `--cached --others --exclude-standard`, 64 MiB
   `maxBuffer`, try/catch fallback — the PR-B `hasJavaSources` pattern);
   then read a BOUNDED sample (first ≤5 files, first 4 KiB each) and
   require a **Postgres-DISTINCTIVE** marker. Generic `create table`/
   `create function` are excluded (would misclassify MySQL/SQLite); so
   are `returning`/`on conflict` (SQLite/MariaDB have them) and `$$`
   (MySQL/MariaDB dumps use `DELIMITER $$`). The retained markers are
   genuinely Postgres-only: `create policy` (row-level security),
   `language plpgsql` (PL/pgSQL), and the `jsonb` type. A repo whose
   `.sql` is generic ANSI DDL with none of these is NOT classified
   `postgres` (false-negative-safe — the architecture pass skips it).

The top-level `stack` field is NOT extended (no `/plan` Postgres
profile) — `stackKinds`-only, the deliberate split documented in
`detectRepoStack`'s JSDoc.

### Key design decisions

- **Pure-JS, no database** (#20 flexibility, #16 graceful degradation):
  the audit tool runs anywhere Node runs; requiring a live Postgres to
  audit a repo would make the pass fragile and usually `SKIPPED`.
- **Nested block comments + dollar-quote tags** (#12 validation): the
  two Postgres-specific lexical hazards. Both are explicitly handled —
  the #1 false-positive risk is a `;`/`REFERENCES` inside a function
  body or comment being parsed as top-level DDL.
- **File-granularity domains** (#2 SoT, #20): conforms to the existing
  contract + `DomainMapSchema` with zero change; consistent with every
  other adapter. Object-granularity deferred (§8).
- **Conservative on unresolved** (#15): an unknown referenced object is
  `unresolved` (visible in `_meta`), never a violation — a false
  positive erodes trust; a missed edge is recoverable.
- **Self-contained** (#2 modularity): imports only `domain-resolver.mjs`
  + `node:` builtins, like every sibling adapter — fault isolation.

---

## 6. Sustainability Notes

- **Assumption**: the DDL subset is statically extractable from `.sql`
  files. True for migration files (declarative DDL). Dynamically
  generated SQL (an ORM building schema at runtime, `EXECUTE format(…)`
  in a function) is invisible — accepted, documented, same class as
  the dynamic-import limitation PR-B accepted.
- **Object-granularity is the designed extension seam**: if operators
  need per-object domains, add an optional `objectRules` block to
  `DomainMapSchema` (object-name globs → domain) and a resolver branch
  — the adapter's edge model already works on objects; only the
  object→domain lookup changes. No contract change. Documented in §8.
- **New SQL constructs**: a new edge kind = one new extractor function
  + one `_meta` counter. The stripper and index are unaffected.
- **`SQL_BUILTIN` set drift**: like PR-B's stdlib/vendor sets — a
  frozen constant, a miss → `unresolved` (visible), never a false
  violation. Easy to extend.

---

## 7. File-Level Plan

### New files

#### `scripts/lib/arch-intent/adapters/postgres.mjs` (~380 LOC)
- `default async function analyseImports({mapped, domainMap, repoPath})` —
  contract entry. Stage 0: per-file read + try/catch fault isolation
  (M1) + `SQL_MAX_FILE_BYTES` size guard; then drives the 3-stage pipeline.
- `stripSqlCommentsAndStrings(source)` — pure; blanks line comments,
  NESTED block comments, `'…'` strings (`''` escape), and
  `$tag$…$tag$` dollar-quotes (exact-tag match). Quoted identifiers
  (`"…"`, `""` escape) are NOT blanked — their text is preserved so
  the extractor can read names like `"MixedCase"`; the scanner only
  tracks quote-state across them so a `;`/`--` inside `"weird;name"`
  is not misread as a statement split or comment (M2 — consistent with
  §2.1). Exported for tests.
- `parseFile(strippedSql, originalSource)` — Stage 1, pure; →
  `{objectDefs, alterRefs, drops, parseError?}` (§2.2). Splits into
  Statement artifacts with offsets; `originalSource` recovers
  dollar-quoted / `AS '…'` function bodies for call scanning. Exported.
- `buildSqlCatalog(parses)` — Stage 2, pure; natural-sorted
  epoch-tracked ordered replay (CREATE/REPLACE last-wins, DROP removes,
  epoch-filtered `alterRefs`, named trigger/policy/constraint
  drop-matching) → `{relationToDef, functionToDef, typeToDef,
  survivingRefs, objectRedefinitions}` (§2.3). Exported for tests.
- `resolveEdges(catalog)` — Stage 3, pure; kind-aware three-state
  resolution of `survivingRefs` → `{edges, unresolvedRefs}` (§2.4).
  Exported for tests.
- `resolveSqlRef(name, expectedKind, catalog)` — single-name,
  kind-aware → `{state, targetFile?}`. Exported for tests.
- `SQL_BUILTIN` — frozen Set of `pg_*` / `information_schema` prefixes,
  common builtin/extension function names, AND builtin column-type
  names (`text`, `int`/`integer`, `bigint`, `boolean`, `timestamptz`,
  `timestamp`, `date`, `jsonb`, `json`, `uuid`, `numeric`, `serial`,
  `bigserial`, `bytea`, `inet`, …) so builtin column types resolve to
  `proven-external`, not `unresolved` noise.
- `SQL_MAX_FILE_BYTES` — size guard constant (default 4 MiB).
- Imports: `node:path`, `node:fs`, `domain-resolver.mjs`. Nothing else.

#### `tests/arch-intent-adapter-postgres.test.mjs` (~200 LOC)
- Unit: `stripSqlCommentsAndStrings` (line/nested-block comments,
  `''`-escaped strings, dollar-quotes incl. tagged `$fn$`, a `;`/`--`
  hidden inside each), `extractStatements`, `extractObjectsAndEdges`
  (FK inline + `ALTER TABLE`, view `FROM`, function call, trigger,
  policy), `buildSqlObjectIndex` (redefinition collision), `resolveSqlRef`
  (all three states).
- Integration: `analyseImports` against a synthetic multi-file `.sql`
  fixture repo — one deliberate cross-domain FK violation, one allowed
  same-domain edge, one `pg_catalog` reference (vendor), one undefined
  reference (`unresolvedRefs`).

#### `tests/fixtures/` — generated programmatically in tmpdirs by the test
(matching the PR-B test pattern — no committed fixture files).

### Modified files

#### `scripts/lib/repo-stack.mjs` (~26 LOC)
Add `hasPostgresSources()` — tiered detection per §2.6: migration-dir
markers (strong signal) OR `git ls-files -- "*.sql"` + a bounded
content sample requiring a Postgres DDL marker. Push `'postgres'` to
`stackKinds`. No change to the top-level `stack` field.

#### `tests/repo-stack.test.mjs` (~24 LOC)
Cases: `postgres` in `stackKinds` for (a) a `supabase/migrations/` dir,
(b) `.sql` files in a git repo with no migrations dir, (c) excluded for
a pure-JS repo.

#### `scripts/sync-to-repos.mjs` (~1 LOC)
Add `scripts/lib/arch-intent/adapters/postgres.mjs` to `CORE_SCRIPTS`
(the arch-intent files are enumerated individually — verified during
PR-B; NOT subtree-synced).

### Files NOT modified

- `adapter-contract.mjs` — frozen; `loadAdapter` discovers
  `postgres.mjs` by filename. PR-C conforms to the contract.
- `schemas.mjs` — `stackKinds` enum already has `postgres`; the
  violation/report schemas are stack-agnostic. No change.

---

## 8. Risk & Trade-off Register

| Risk / Trade-off | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Dollar-quote tag mis-match → function body parsed as DDL | medium | medium (false positive) | `stripSqlCommentsAndStrings` matches the exact opening `$tag$` to its identical closing tag; exhaustively unit-tested incl. tagged + nested-looking bodies. |
| Nested block comments mis-counted | low | low | Depth-tracked in the stripper; unit-tested. |
| File-granularity too coarse for flat timestamp-only migration dirs | certain (for such repos) | medium | **Documented limitation, not a defect** — identical file=domain assumption every adapter makes. Object-granularity is the designed extension seam (§6); deferred to a future PR with an optional `objectRules` domain-map block. Repos organising SQL by feature dir get correct results now. |
| Dynamically generated SQL (`EXECUTE format(…)`, ORM runtime DDL) invisible | certain | low | Documented; same accepted class as PR-B's dynamic-import limitation. False-negative only. |
| `ALTER TABLE … RENAME` mid-migration not tracked across the catalog | low | low | Documented limitation — the ordered catalog (§2.3) replays CREATE/REPLACE/DROP but not RENAME chains. Rare in well-managed migrations; a renamed object resolves as `unresolved` (visible in `_meta`), never a false violation. |
| Function overload precision (same name, different arity) | low | low | Catalog keys functions by `schema.name`; genuine overloads recorded in `_meta.objectRedefinitions` with arities. Calls resolve to the name → domain-coarse but honest. Per-overload domain precision deferred. |
| `SET search_path` mid-migration changes unqualified resolution | low | low | Not modelled. Unqualified names use `public` then a best-effort unique-bare-name match (§2.4). Documented; ambiguous bare names → `unresolved`, never a false violation. |
| FK added without an explicit constraint name, then dropped by its Postgres auto-name (`<t>_<col>_fkey`) | low | low | The adapter does not synthesise constraint auto-names, so a later `DROP CONSTRAINT <autoname>` is not matched → a stale FK edge survives (§2.3 G3 limitation). Rare (add-then-drop FK within migration history); the stale edge is visible in `_meta.edges`. Explicitly-named constraints (the common case) ARE drop-matched. |
| Function-call extraction over-matches (any `ident(` token) | medium | low | Calls are only recorded when the identifier matches a **defined** function in the index; unknown `ident(` tokens (built-ins, keywords like `count(`) are ignored or land in `unresolvedRefs`, never a violation. |
| `SQL_BUILTIN` set drift | low | low | Frozen constant; a miss → `unresolved` (visible), never a false violation. Easy to extend. |
| ReDoS via malicious `.sql` content | low | medium | All DDL regexes bounded/linear — negated classes, no nested quantifiers. §1.5 security consultation + acceptance #7. |
| **Deferred**: live `pg_catalog` introspection mode | n/a | n/a | Explicitly rejected (§1 Tension 1) — needs a DB + credentials, not CI-safe. Could be an opt-in future mode; out of scope for PR-C. |
| **Deferred**: object-granularity domain mapping | n/a | n/a | §6 extension seam; needs a `DomainMapSchema` addition — separate future PR. |

---

## 9. Testing Strategy

**Unit tested** (`node --test`) — each pure helper in isolation:
- `stripSqlCommentsAndStrings` — `--` line comments, `/* */` nested
  block comments, `'…'` strings with `''` escapes, `"…"` quoted
  identifiers, `$$…$$` and `$tag$…$tag$` dollar-quotes; the adversarial
  cases: a `;` inside a string, a `--` inside a dollar-quoted body, a
  `REFERENCES` / `CREATE TABLE` inside a function body and inside a
  comment → must produce zero spurious objects/edges. Line count
  preserved.
- `extractStatements` / `extractObjectsAndEdges` — every edge kind in
  the §2.2 table: inline-column `REFERENCES`, `ALTER TABLE … FOREIGN
  KEY`, `CREATE VIEW … SELECT FROM`, `CREATE MATERIALIZED VIEW`,
  function-call in a body, `CREATE TRIGGER … EXECUTE FUNCTION`,
  `CREATE POLICY … USING`.
- `buildSqlObjectIndex` — schema-qualified vs unqualified (`public`)
  names; `CREATE OR REPLACE` redefinition → `objectRedefinitions`.
- `resolveSqlRef` — `resolved-local`, `proven-external` (`pg_catalog`,
  `information_schema`, a builtin function), `unresolved`.

**Integration tested**:
- `analyseImports` end-to-end against a synthetic multi-file `.sql`
  fixture — assert the deliberate cross-domain FK violation is caught,
  the same-domain edge is NOT flagged, a `pg_catalog` reference is NOT
  flagged, an undefined reference lands in `_meta.unresolvedRefs` (not
  `violations`), and `_meta` has all fixed keys.
- Run through `runArchIntentAnalysis` with stubbed `stackKinds:['postgres']`
  to confirm contract integration (`status:'ok'`, `validateAdapterReport`
  passes).

**Key edge cases**:
- A `;` inside a `$$ … $$` function body → does not split a statement.
- `REFERENCES` / `CREATE TABLE` text inside a comment or a string → zero objects.
- A tagged dollar-quote `$func$ … $func$` whose body contains the
  literal text `$$` → not mis-terminated.
- Schema-qualified (`app.users`) vs unqualified (`users`) FK target
  resolving to the same object.
- A function `CREATE OR REPLACE`d in a later migration → the LATEST
  definition's file + body wins (ordered catalog, §2.3); the
  superseded version's call-edges do NOT leak; redefinition recorded
  in `_meta.objectRedefinitions`.
- A table `DROP`ped in a later migration → it and all edges into/out
  of it are absent from the final catalog.
- An `ALTER TABLE … ADD FOREIGN KEY` in a different file from the
  table's `CREATE` → the violation's `fromFile` is the ALTER's file.
- A table and a function sharing `schema.name` → kept distinct by the
  kind-separated catalog maps.
- A `.sql` file with only comments → zero objects, zero edges.
- An `E'O\'Reilly'` escape-string with a backslash-escaped quote → does
  not desync the scanner; a following statement is parsed normally.
- `DROP TABLE t1, t2, t3 CASCADE;` → all three objects removed from
  the catalog (multi-object drop list).
- `ALTER TABLE t ADD CONSTRAINT fk_x FOREIGN KEY … REFERENCES u;`
  followed later by `ALTER TABLE t DROP CONSTRAINT fk_x;` → the FK
  edge is absent from the final catalog (named-constraint drop).
- `CREATE TABLE child PARTITION OF parent …` → a `partition-of` edge
  `child → parent`; cross-domain partition → violation.
- A table column typed with a custom `CREATE TYPE` enum/composite in
  another domain → a `column-type` edge; a builtin column type
  (`text`, `jsonb`, …) → `proven-external`, no edge.
- `CREATE TRIGGER` / `CREATE POLICY` followed by `DROP TRIGGER … ON t`
  / `DROP POLICY … ON t` → the trigger/policy edge is gone.
- `CREATE OR REPLACE TRIGGER` (PG14) → parsed like `CREATE TRIGGER`.

**Verification (a step in implementation, not code)**:
- After implementing, run `node scripts/sync-to-repos.mjs --dry-run` and
  confirm `postgres.mjs` appears in the planned sync set.
- Dogfood: run the adapter against this repo's own
  `supabase/migrations/**` and eyeball `_meta` for sanity.

**Acceptance criteria** (backend — not Playwright):
1. `analyseImports` in `postgres.mjs` conforms to the contract: returns
   `{violations, _meta, analyzerVersion}`, validated by
   `validateAdapterReport` inside `runArchIntentAnalysis` with no schema error.
2. The fixture integration test catches exactly the deliberate FK
   violation — no false positives on same-domain, `pg_catalog`, or
   builtin edges.
3. `detectRepoStack()` returns `stackKinds` containing `'postgres'` for
   a repo with a migrations dir or `.sql` files, and not otherwise.
4. A `;`, `CREATE TABLE`, or `REFERENCES` inside a comment, string, or
   dollar-quoted function body produces zero spurious objects/edges.
5. Every violation cites real `.sql` files in `fromFile`/`toFile`;
   object identities are preserved in `_meta.edges`.
6. All new tests pass under `npm test`; no regression in existing
   `arch-intent-*` tests. `sync-to-repos.mjs --dry-run` lists `postgres.mjs`.
7. The §1.5 mandatory consultations were run and recorded in the
   Implementation Log; all DDL-extraction regexes are bounded (no
   catastrophic backtracking) since they parse untrusted file content.

---

## Implementation Log

### 2026-05-15 — PR-C implemented (/cycle Step 3)

**Mandatory consultations (§1.5)**:
- *Architectural-memory* (`get-neighbourhood`): 6 candidates, all `review`
  band (highest 0.667 — no SQL DDL parser among them; `postgres-store.mjs`
  is a runtime DB-connection adapter, different concern). Greenfield; the
  PR-B `python.mjs`/`java.mjs` adapters are the structural template.
- *Security-incident* (`get-incident-neighbourhood`): 0 incidents. All
  DDL-extraction regexes bounded/linear (negated classes, no nested
  quantifiers) — acceptance #7.

**Built**:
- `scripts/lib/arch-intent/adapters/postgres.mjs` — pure-JS Postgres
  DDL adapter (3-stage pipeline; length-preserving stripper with nested
  block comments + `E'…'` escape-strings + `$tag$` dollar-quotes;
  epoch-tracked ordered catalog; kind-separated relation/function/type
  maps; 7 edge kinds).
- `scripts/lib/repo-stack.mjs` — `hasPostgresSources()` (tiered
  detection) + `postgres` in `stackKinds`.
- `scripts/sync-to-repos.mjs` — `postgres.mjs` added to `CORE_SCRIPTS`.
- `tests/arch-intent-adapter-postgres.test.mjs` (35 tests),
  `tests/repo-stack.test.mjs` (+4 Postgres cases).

**Status**: full suite 2062 pass / 0 fail / 20 pre-existing skips.

### 2026-05-15 — PR-C audited (/cycle Step 4)

`/audit-code` — 2 GPT rounds + 2 Gemini rounds. Gemini coherence rated
"Strong" every round; 0 wrongly-dismissed every round.

- **GPT R1–R2**: genuine in-scope findings 4 → 4, all fixed +
  regression-tested (quote-aware statement split; widened detection
  sample; qualified quoted-name regex + quote-aware `normName`; fd-leak
  finally; `SQL_MAX_FILE_BYTES` env validation; non-distinctive markers
  dropped). Recurring HIGH H1/H2 ("missing PR-A/B files") confirmed-false
  3×.
- **Gemini R1 → CONCERNS**: G1 `normName` dot-join collision
  (`"my.table"` vs `my.table`) — fixed with `SEG_DOT` intra-segment
  escaping + `displayName`; G2 non-standalone `E` escape-string misfire
  — fixed with a standalone-`E` guard.
- **Gemini R2 → CONCERNS** (cap): one residual MEDIUM — `$$` is not
  Postgres-distinctive (`DELIMITER $$` in MySQL dumps) — fixed by
  dropping it; the 3 retained markers (`create policy`,
  `language plpgsql`, `jsonb`) are genuinely Postgres-only.

Gemini cap (2 rounds) reached; the single residual finding was concrete
and fixed. Final: full suite 2065 pass / 0 fail / 20 pre-existing skips.
