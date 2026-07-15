# Plan: Architectural-Drift Duplication Cleanup — Consolidate Real Dupes + Exclusion Mechanism

- **Date**: 2026-07-15
- **Status**: Complete — implemented (Cluster A: 8 planned + 2 mid-audit-discovered duplicate consolidations + 4 pragmas; Cluster B: the new pragma-persistence mechanism), GPT code-audit ran the full 6-round cap across both clusters (8 real bugs found+fixed, rest recurring/pre-existing/noise, every dismissal verified via git diff or a live DB/refresh run), consolidated Gemini final gate over the union diff APPROVE (0 new findings, 0 wrongly-dismissed). Live end-to-end verification against this repo's own data: duplication_excluded_count:4 (exactly matching the 4 real pragmas), drift score 29→24. Full suite: 5458 tests, 5437 pass, 0 fail, 21 skipped.
- **Author**: Claude + Louis
- **Scope**: backend

- **Target domain(s)**: `arch-memory`, `audit-orchestration`, `shared-lib`
- ⚠ **Cross-domain work** — touches the symbol-extraction pipeline (arch-memory), the existing `@duplicate-justification` pragma convention (audit-orchestration), and the drift RPCs (shared-lib). The boundary is intentional: this plan extends an existing audit-orchestration convention into arch-memory's full-repo scan, it does not blur ownership.

## Context Summary

`npm run arch:drift` (`scripts/symbol-index/drift.mjs`) computes a repo-wide
architectural-drift score from two axes — duplication pairs and layering
violations — via Postgres RPCs (`drift_score`, `top_duplicate_clusters`) over
the `symbol_index`/`symbol_definitions` tables. `wine-cellar-app` is currently
`RED` at 92/20, driven almost entirely by 86 duplicate clusters.

This session investigated that report directly (not assumed) and found the
86 clusters split cleanly into three buckets, verified by a script cross-
referencing each cluster's member `filePaths` against `scripts/.claude-skills/`
(the isolated-sync destination) — see the investigation output captured in
this plan's Audit Trail section once auditing begins:

- **12 "upstream-only" clusters** (every member under `scripts/.claude-skills/`,
  i.e. real duplication inside THIS repo's own tooling, just observed via a
  consumer's synced copy): `mulberry32` (3x), `nowIso` (3x), `isP0OrP1`,
  `hashText`, `sha256`, `estimateTokens`, `hashFile`, `chunk`, `round4`,
  `contractExists`, `isValidCount`, `firstSeenFromHistory` (2x each).
- **54 of the "mixed" clusters** (one upstream + one local member) are a
  single root cause: stale, untracked, unreferenced pre-isolation-migration
  leftover copies of synced CLI scripts sitting in wine-cellar-app's `scripts/`
  root (byte-identical to their `scripts/.claude-skills/` counterpart, minus
  the sync banner — confirmed via `diff`). This is a wine-cellar-app-local
  `git rm`, **out of scope for this plan** (different repo) — noted here only
  so the design doesn't misread it as "local code forking a whole synced
  script," which it isn't.
- **2 residual "mixed" clusters** (`round1`, `escapeRegex`) are genuine
  coincidental small-helper collisions between an upstream file and
  wine-cellar-app's own unrelated business logic — nothing upstream-side to
  consolidate into.

**Code Trace** (Phase 1, this session):
- `scripts/symbol-index/drift.mjs:76-147` (`main`) → `computeDriftScore`/
  `getTopDuplicateClusters` (`scripts/lib/store/arch/neighbourhood.mjs:37-65`)
  → `driftScore`/`topDuplicateClusters` (`scripts/lib/db/rpc.mjs`) → the SQL
  functions in `supabase/migrations/20260503130000_drift_score_signature.sql`
  and `20260503140000_top_duplicate_clusters.sql`.
- `top_duplicate_clusters` SQL (read in full): groups `symbol_index` rows by
  `(signature_hash, kind)` joined to `symbol_definitions`, `HAVING
  COUNT(DISTINCT file_path) > 1` — no exclusion mechanism exists anywhere in
  this path today.
- `scripts/lib/audit/duplication-detector.mjs:60-66` (`PRAGMA_RE`) and
  `:143-151` (`findPragmaAbove`) — the authoritative, language-agnostic
  `@duplicate-justification: target=<file>:<symbol> reason=<...>` pragma
  parser, used **only** by `/audit-code`'s diff-scoped Wave 5 duplication
  pass. Confirmed via grep that `drift.mjs` and its RPC chain never reference
  this pragma.
- `scripts/lib/symbol-index/stale-pragma-sweep.mjs:49-91` (`findStalePragmas`)
  — an EXISTING full-repo `git grep -F @duplicate-justification:` sweep
  (excludes `*.md`, `tests/*`), today used only to flag pragmas whose target
  file no longer exists. This is the direct precedent/reusable building block
  for full-repo (not diff-scoped) pragma discovery — extend it, do not
  reinvent a second scanner.
- `supabase/migrations/20260501120000_symbol_index.sql:139-156` +
  `:328,366` — `symbol_layering_violations` is the existing precedent for a
  **snapshot-scoped, always-fully-recomputed** exclusion-adjacent table.
  `scripts/lib/store/arch/symbols.mjs:123-143` (`recordLayeringViolations`)
  + `scripts/symbol-index/refresh.mjs:355-356` ("12. Upsert layering
  violations (always full repo per R2 H8)") is the exact write-path shape to
  mirror for the new duplicate-justification persistence.
- `scripts/lib/nav/*.mjs` / `scripts/lib/visual/*.mjs` — grepped for
  cross-imports between the two directories: **zero** exist today. This
  matters: `sha256`, `contractExists`, and `firstSeenFromHistory` are
  duplicated between `nav/` and `visual/`, but AGENTS.md documents these two
  skills as a deliberately independent "sister lens" pair (mirrors the
  `round4` `arm-eval`/`model-ab-decision` case, which AGENTS.md explicitly
  calls out as "don't conflate"). Forcing a new nav↔visual import to
  deduplicate these three would be the FIRST such coupling — a bigger
  decision than a plain dedup. Treat as candidates for the exclusion
  pragma, not forced consolidation, unless implementation finds a neutral
  third home that doesn't create nav↔visual coupling.
- `scripts/lib/audit/llm-helpers.mjs` exists as a general helper module in
  the `audit` domain — a plausible home for `nowIso` if no better fit exists;
  confirmed no `lib/nav/utils.mjs`-style shared file exists for the nav/visual
  case, consistent with the zero-coupling finding above.

**Neighbourhood considered** (Phase 0.5, `get-neighbourhood` on the touched
files): returned `findPragmaAbove`/`PRAGMA_RE` (duplication-detector.mjs),
`findStalePragmas`/`renderStalePragmaSection` (stale-pragma-sweep.mjs),
`computeDriftScore`/`getTopDuplicateClusters`/`callNeighbourhoodRpc`
(store/arch/neighbourhood.mjs) — all `recommendation: review` (0.7-0.82
similarity), i.e. close enough to consult, not close enough to reuse as-is.
Confirms the design below **extends** these three modules rather than adding
parallel new ones.

Patterns reused: the pragma convention itself (unchanged syntax/regex), the
full-repo-git-grep-sweep pattern (`findStalePragmas`), the
"snapshot-scoped, always-recomputed" persistence pattern
(`symbol_layering_violations`). New: a `symbol_index.duplicate_justified`
column + a small extraction-time write step.

## Proposed Architecture

```mermaid
sequenceDiagram
    participant Refresh as arch:refresh (refresh.mjs)
    participant Pragma as duplicate-justification-pragma.mjs (shared-lib)
    participant DB as symbol_index (new columns)
    participant RPC as top_duplicate_clusters / drift_score (SQL, JSONB)
    participant Drift as arch:drift (drift.mjs)

    Refresh->>Refresh: upsert symbol_definitions + symbol_index (existing extraction step - definition_id + start_line exist on symbol_index for THIS refresh)
    Refresh->>Pragma: findRepoPragmas() - full-repo git grep @duplicate-justification (captures pragma's OWN line number too)
    Pragma-->>Refresh: [{pragmaFile, pragmaLine, targetFile, targetSymbol, reason}, ...]
    Refresh->>DB: ONE batched query - symbol_index JOIN symbol_definitions WHERE refresh_id = $refreshId AND file_path = ANY(pragma files) (Gemini G1 fix - start_line lives on symbol_index, not symbol_definitions)
    DB-->>Refresh: {definition_id, file_path, symbol_name, kind, start_line}[]
    Refresh->>Refresh: resolve each pragma -> nearest start_line strictly AFTER pragmaLine, same file, <=5 lines (concrete algorithm, round-2 H2 fix) - the PRAGMA-BEARING declaration's own definition_id, not the named target
    Refresh->>DB: withTx: (1) reset ALL refresh_id rows to false/NULL, (2) UPDATE...FROM(VALUES...) sets each justified row's own reason/target/source (round-3 H2 fix - two statements, one transaction, not a single scalar CASE WHEN)
    Note over Refresh,DB: mirrors symbol_layering_violations' full-recompute-per-refresh pattern - a removed pragma correctly un-flags its row on the very next refresh
    Drift->>RPC: top_duplicate_clusters(repo_id, refresh_id)
    RPC->>DB: SELECT ... WHERE duplicate_justified = false GROUP BY signature_hash, kind HAVING count(distinct file_path) > 1
    RPC-->>Drift: clusters (justified rows excluded); drift_score's JSONB payload also carries duplication_excluded_count (row-level, a distinct quantity from the cluster count itself - round-3 M2 fix)
```

Note (Gemini G2 fix): `duplication-detector.mjs` (`audit-orchestration`) also imports
`PRAGMA_RE` from `duplicate-justification-pragma.mjs` — both consumers depend on the
same `shared-lib`-domain module; neither domain imports from the other.

Key design decisions:
- **Reuse the existing pragma, don't invent a second config surface** (#1
  DRY, #5 Single Source of Truth). A developer already knows
  `@duplicate-justification` from `/audit-code`'s Wave 5 — the same comment
  now also suppresses the whole-repo drift score, one mental model.
- **Persist on `symbol_index`, fully recomputed every refresh** (#5, #9). Round-1
  H1 finding: the original design's "copy-forward-then-UPDATE handles
  incremental refreshes for free" claim was FALSE — an UPDATE that only sets
  `true` for currently-resolved pragmas never resets a row whose pragma was
  removed, renamed, or whose target changed, so a stale suppression could
  persist forever. Fixed: mirror `symbol_layering_violations` exactly — it
  is fully recomputed (not incrementally patched) every refresh, incremental
  or full. The write is a single `UPDATE ... WHERE refresh_id = $refreshId`
  that sets `duplicate_justified` from the COMPLETE current resolved set
  (true for members, false for everyone else), never a partial patch.
- **Exclude the pragma-BEARING declaration, not the named "target"** (round-1
  H2 fix). The original design read `target=<file>:<symbol>` as identifying
  WHICH row to exclude — but a `symbol_index` row belongs to exactly one
  cluster by construction (clusters are grouped by exact `signature_hash`
  equality), so "exclude the target" and "exclude whoever the pragma sits
  above" are NOT equivalent when a target participates in more than one
  near-identical grouping, and it made the reason field editable by ANY
  annotator pointing at the same target (last-write-wins). The corrected
  semantics: the pragma marks the declaration IT SITS ABOVE as an
  acknowledged duplicate — `target=`/`reason=` remain in the row purely as
  the audit-trail explanation (matches how a human reads the comment: "this
  declaration duplicates that one, and here's why that's fine"), not as a
  machine-verified pairwise link. This is unambiguous per-row and requires
  no cross-target verification. v1 is scoped and tested against 2-member
  clusters (this plan's 4 real cases); a 3+-member cluster with one member
  justified correctly still flags the remaining ≥2 unjustified members — not
  a gap, the intended behavior (only ONE occurrence was ever vouched for).
- **Exclusion happens in SQL, not client-side** (#11 Validation happens at
  the boundary that matters) — `drift_score` is a numeric, threshold-gated
  value; filtering the rendered markdown client-side would fix the *report*
  but leave the *score* (and hence the RED/AMBER/GREEN CI-gate status) wrong.
  Verified `drift_score` `RETURNS JSONB` (not a fixed composite type), so
  adding a `duplication_excluded_count` key via `CREATE OR REPLACE FUNCTION`
  needs no drop/recreate (round-1 H4 fix — the original plan hand-waved this
  as "an additional scalar, or a second RPC call" without checking Postgres's
  actual constraint on changing a function's return shape).

## Sustainability Notes

**Right-sizing** (new structure: 4 new `symbol_index` columns — round-1
`duplicate_justified`/`duplicate_justification_reason`, plus `target`/
`source` added by round-2's M2 fix so the row-level audit trail actually
matches what this section already claimed — + one new extraction step):
- **Band-aid extreme**: hardcode a hand-maintained ignore-list of
  `(file, symbol)` pairs in a JSON file, read only by `drift.mjs` to filter
  the *rendered markdown* client-side. Fast to ship, but leaves the numeric
  score wrong (the CI-gate status is the thing that actually matters) and
  invents a second "this duplicate is fine" convention alongside the
  existing pragma.
- **Over-engineered extreme**: a general-purpose "suppression rules engine"
  supporting glob patterns, expiry dates, approval workflows, and a REST API
  for managing exclusions across all drift axes (duplication AND future
  layering-exception types) with its own admin UI.
- **Chosen**: reuse the one pragma that already exists, persist it as four
  plain columns (boolean + 3 text audit-trail fields) on the table that's
  already snapshot-scoped for exactly this purpose, exclude in the two
  existing SQL functions. No current requirement needs cross-axis
  generality (layering violations already have their own exclusion path via
  `domain-map.json`'s `allowedDeps`, which is the RIGHT mechanism for that
  axis — not this one) or an approval workflow (a code review on the PR
  adding the pragma IS the approval).

**Assumptions that could change**: if a future drift axis needs its own
exclusion (unlikely given layering already has `allowedDeps`), it gets its
own column/mechanism rather than retrofitting this one — these four
`boolean`/`text` columns are deliberately narrow to `duplicate_justified`
semantics,
not a generic "excluded" flag.

## File-Level Plan

1. **`scripts/lib/duplicate-justification-pragma.mjs`** (create — round-1 M1's
   fix was itself wrong, corrected here per Gemini plan-gate G2: the round-1
   fix flipped `PRAGMA_RE` to live in `stale-pragma-sweep.mjs`, arch-memory,
   with `duplication-detector.mjs`, audit-orchestration, importing FROM it —
   but that relied on `stale-pragma-sweep.mjs`'s own docblock claim that
   "audit-orchestration -> arch-memory is an approved edge," which is FALSE
   per direct verification against `.audit-loop/domain-map.json`: neither
   `allowedDeps['audit-orchestration']` (`["findings","learning-store",
   "plan","shared-lib","tech-debt"]`) nor `allowedDeps['arch-memory']`
   (`["learning-store","shared-lib"]`) lists the other domain — the docblock
   was unverified/stale, and round-1's "fix" just moved the undeclared edge
   to the opposite direction rather than removing it. The actually-correct
   fix: relocate `PRAGMA_RE` to a new, genuinely domain-neutral `shared-lib`
   module — BOTH `arch-memory` and `audit-orchestration` explicitly list
   `shared-lib` in their `allowedDeps`, so this is the only placement that
   creates zero undeclared edges. Top-level `scripts/lib/*.mjs` (matching
   the placement of `rng.mjs`, `sensitive-paths.mjs`, `vcs.mjs`) is
   `shared-lib` domain.
   - Add `findRepoPragmas(repoRoot)` here too (not in
     `stale-pragma-sweep.mjs`) — same `git grep -F
     @duplicate-justification:` full-repo sweep (excluding `*.md`,
     `tests/*`), using `PRAGMA_RE` to capture target file, target symbol,
     AND reason (not just the target file `findStalePragmas` extracts
     today), plus the pragma's own line number (already available from the
     `git grep -n` output `findStalePragmas` already parses) — round-1 H3
     fix: resolution needs to find the declaration the pragma sits ABOVE,
     not blindly match `(file, symbolName)` string equality against the
     target, which cannot disambiguate two same-named declarations in one
     file.

2. **`scripts/lib/symbol-index/stale-pragma-sweep.mjs`** (modify)
   - Import `PRAGMA_RE` (for `findStalePragmas`'s own target-file regex,
     which can now reuse the shared one) and `findRepoPragmas` FROM the new
     `scripts/lib/duplicate-justification-pragma.mjs` — both this file
     (arch-memory) and `duplication-detector.mjs` (audit-orchestration)
     import from the neutral shared-lib module, neither imports from the
     other.

3. **`scripts/lib/audit/duplication-detector.mjs`** (modify)
   - Import `PRAGMA_RE` FROM `scripts/lib/duplicate-justification-pragma.mjs`
     instead of defining it locally. `findPragmaAbove`'s behavior is
     unchanged (still audit-orchestration's own diff-scoped anchoring
     logic); only the regex's home moves.

4. **`supabase/migrations/<timestamp>_symbol_duplicate_justification.sql`** (create)
   - `ALTER TABLE symbol_index ADD COLUMN IF NOT EXISTS duplicate_justified BOOLEAN NOT NULL DEFAULT false;`
   - `ALTER TABLE symbol_index ADD COLUMN IF NOT EXISTS duplicate_justification_reason TEXT;`
   - `ALTER TABLE symbol_index ADD COLUMN IF NOT EXISTS duplicate_justification_target TEXT;` (the
     raw `target=<file>:<symbol>` string from the pragma) and
     `ALTER TABLE symbol_index ADD COLUMN IF NOT EXISTS duplicate_justification_source TEXT;`
     (`<pragmaFile>:<pragmaLine>`, where the pragma comment itself lives) —
     round-2 M2 fix: the plan's own Proposed Architecture section claims
     `target=`/`reason=` "remain in the row purely as the audit-trail
     explanation," but the original schema only persisted `reason`; without
     `target`/`source`, a reviewer inspecting a justified row independently
     (or after the source file moves) has no way to see what it was
     asserted to duplicate or which pragma authorized it.
   - `CREATE OR REPLACE FUNCTION top_duplicate_clusters(...)` — **re-declared
     in this NEW migration file** (never edit
     `20260503140000_top_duplicate_clusters.sql` itself — that file already
     ran on every deployed database; a migration filename applies once, so
     editing an already-applied file is a no-op there and only affects a
     fresh `--migrate` run, producing a split deployment). Copy the existing
     function body as the baseline (same `RETURNS TABLE` signature,
     unchanged — no drop/recreate needed since the column list doesn't
     change) and add `AND si.duplicate_justified = false` to the `bucket`
     CTE's `WHERE` clause.
   - `CREATE OR REPLACE FUNCTION drift_score(...)` — **same rule** (round-2
     H1 fix, round-3 H1 confirms it as the fix, not a suggestion): re-declare
     in THIS new migration, never edit
     `20260503130000_drift_score_signature.sql`. Copy that function's full
     current body as the baseline (confirmed `RETURNS JSONB`, so this
     re-declaration is a same-signature `CREATE OR REPLACE`, no drop/grant
     dance needed), add the same `duplicate_justified = false` predicate to
     its duplication-counting subquery, and add a `'duplication_excluded_count',
     v_excluded_count` key to its `jsonb_build_object(...)` payload — `v_excluded_count`
     is a **row-level count of excluded declarations** (`COUNT(*) FROM
     symbol_index si JOIN symbol_definitions sd ON sd.id = si.definition_id
     WHERE si.refresh_id = p_refresh_id AND si.duplicate_justified = true AND
     EXISTS (SELECT 1 FROM symbol_index si2 JOIN symbol_definitions sd2 ON
     sd2.id = si2.definition_id WHERE si2.refresh_id = si.refresh_id AND
     si2.signature_hash = si.signature_hash AND sd2.kind = sd.kind AND
     si2.file_path <> si.file_path)` — round-4 M2 fix: the `EXISTS` clause
     now matches `(signature_hash, kind)` together, not `signature_hash`
     alone — `top_duplicate_clusters`' own cluster identity is
     `(signature_hash, kind)` (its `GROUP BY` clause), and the earlier
     draft's `signature_hash`-only predicate could over-count a justified
     row as "excluded" merely because a DIFFERENT-kind declaration
     elsewhere happened to share its hash, even though the drift RPC would
     never have grouped them into the same cluster. i.e. only counts a
     justified row if it would otherwise have shared its `(signature_hash,
     kind)` cluster identity with at least one OTHER file, matching round-3
     M2's fix: this is a distinct quantity from the cluster-count the score
     itself tracks (see Testing Strategy).
   - Read both full existing migrations before authoring the new one's
     `CREATE OR REPLACE` bodies — do not guess their exact query shape.
   - Idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`),
     applied via `node scripts/setup-postgres.mjs --migrate` per this repo's
     migration doctrine — never hand-applied via the dashboard.

5. **`scripts/lib/store/arch/symbols.mjs`** (modify)
   - Add `recordDuplicateJustifications(refreshId, repoId, justifications)`
     where `justifications` is `[{definitionId, target, source, reason}, ...]`
     (round-2 M2 fix — carries the full audit-trail, not just a reason
     string; see item 4's schema). **Two statements, one transaction**
     (round-3 H2 fix — round-2's single boolean-only `UPDATE ... SET
     duplicate_justified = (definition_id = ANY($ids))` genuinely cannot
     also carry a DIFFERENT `reason`/`target`/`source` per row; a scalar
     `CASE WHEN` has no way to pick "this row's own value" out of a list).
     Wrapped in this repo's existing `withTx` helper
     (`scripts/lib/db/query.mjs:566`) so the two statements commit or roll
     back together — preserving round-2 H1's atomicity requirement without
     the row-count-driven chunking that caused round-2's original
     contradiction:
     1. **Reset**: `UPDATE symbol_index SET duplicate_justified = false,
        duplicate_justification_reason = NULL, duplicate_justification_target
        = NULL, duplicate_justification_source = NULL WHERE refresh_id =
        $refreshId` — unconditional, covers every row this refresh.
     2. **Apply**: `UPDATE symbol_index AS si SET duplicate_justified = true,
        duplicate_justification_reason = v.reason,
        duplicate_justification_target = v.target,
        duplicate_justification_source = v.source FROM (VALUES ($1::uuid,
        $2::text, $3::text, $4::text), ...) AS v(definition_id, reason,
        target, source) WHERE si.definition_id = v.definition_id AND
        si.refresh_id = $refreshId` — one `VALUES` row per justified
        definition, each carrying its own reason/target/source; skipped
        entirely (steps straight to step 1's all-false state) when
        `justifications` is empty.

6. **`scripts/symbol-index/refresh.mjs`** (modify)
   - **Sequencing + data source** (round-3 M1 fix, corrected again per
     Gemini plan-gate G1: round-3's fix queried `symbol_definitions` for
     `start_line` — that column does NOT exist there, it's `symbol_index`-
     only per the schema (`symbol_definitions` is the stable cross-refresh
     identity table with no positional columns; `start_line`/`end_line` are
     snapshot-scoped on `symbol_index`). The batched query as previously
     specified would fail with a Postgres `column does not exist` error):
     run pragma resolution **after** the symbol-extraction upsert step has
     completed (so `symbol_index` rows for this `refreshId` exist to query).
     Call `findRepoPragmas(repoRoot)` first (cheap, pure `git grep`, no DB
     dependency), collect the DISTINCT set of files it references, then run
     **one batched query against `symbol_index`, scoped to this refresh** —
     `SELECT si.definition_id, si.file_path, sd.symbol_name, sd.kind,
     si.start_line FROM symbol_index si JOIN symbol_definitions sd ON sd.id
     = si.definition_id WHERE si.refresh_id = $refreshId AND si.file_path =
     ANY($pragmaFiles)` — scoped to just those files, not one query per
     pragma (avoids the N+1 the original wording permitted), and correctly
     sourced from the table that actually carries `start_line`. Normalize
     `git grep`'s repo-relative paths using the SAME canonical-path helper
     this same refresh already uses when writing `symbol_index` rows — do
     not write a second normalizer.
   - **Resolution algorithm** (round-2 H2 fix, concrete): for each pragma,
     among the batched-query results for `pragmaFile`, pick the row with the
     SMALLEST `start_line` strictly greater than `pragmaLine` (the very next
     declaration — no scanning range, just "the next one"), rejecting the
     match as unresolvable if the gap exceeds **5 lines** (matches
     `findPragmaAbove`'s own documented "up to 3 lines above" convention,
     plus slack for a multi-line JSDoc block). (Gemini G1's secondary point —
     that `symbol_definitions`' `UNIQUE (repo_id, canonical_path,
     symbol_name, kind)` constraint already prevents two SAME-name-AND-kind
     declarations in one file — is correct but doesn't eliminate the need
     for this algorithm: two DIFFERENT-kind declarations can still share a
     name in one file, e.g. a function and a method both named `parse`, and
     line-proximity is still what correctly attaches the pragma to the one
     it actually sits above.)
   - **Ambiguity guard** (round-2 M1 fix): at most one pragma per
     declaration is the documented convention; if more than one distinct
     pragma line resolves to the SAME `definition_id`, that's a detected,
     reported condition (a new LOW-severity subsection alongside the
     existing stale-pragma report, not silently last-write-wins) —
     deterministically use the LAST one by source line order if a single
     value must be picked.
   - **Unresolved pragmas are also reported**, not silently dropped: extend
     the stale-pragma report's markdown (or add a sibling subsection using
     the same "LOW — dead documentation, not a safety gap" framing) to list
     any pragma that failed to resolve to a declaration at all, so an author
     who wrote one gets feedback instead of silent non-suppression.
   - Call `recordDuplicateJustifications(refreshId, repoId, resolved)` —
     this call must run even when zero pragmas resolve, so the reset
     semantics (item 5, step 1) correctly clear any previously-justified
     rows.
   - **Why this file**: the orchestrator already runs the layering-violation
     write at the equivalent point in the same pipeline; adding a sibling
     step is consistent, not a new orchestration pattern.

7. **`scripts/symbol-index/drift.mjs`** (modify)
   - No `top_duplicate_clusters` return-shape change needed. Read
     `duplication_excluded_count` off the `drift_score` JSONB result
     (already fetched by `main()`) and, when non-zero, append "excludes N
     `@duplicate-justification`-marked declarations this refresh" to the
     `## Top duplication clusters` section (round-3 M2 fix — "declarations,"
     not "pairs": the count is row-level, a distinct quantity from the
     cluster-level count the score itself tracks — see item 4's definition
     of `v_excluded_count` and the Testing Strategy) so a reader isn't
     confused why a previously-seen cluster disappeared.

8. **Consolidate the 8 genuine upstream duplicate clusters** (modify;
   concrete targets verified this session via export-status + `allowedDeps`
   checks, not guessed):
   - `mulberry32`: migrate to **`scripts/lib/rng.mjs`** (NOT
     `lib/audit/seeded-random.mjs` — round-1 M2 fix. Verified
     `.audit-loop/domain-map.json` has NO `allowedDeps` entry for `arm-eval`
     at all, so `lib/arm-eval/judge.mjs` importing from an audit-domain
     module would be an undeclared cross-domain edge; `lib/rng.mjs` is
     already imported by 4 unrelated modules — `bandit.mjs`,
     `evolve-prompts.mjs`, `refine-prompts.mjs`, `shared.mjs` — confirming
     it's already the domain-neutral RNG home). Move `mulberry32`,
     `seededShuffleCopy`, `seededDraw` from `seeded-random.mjs` into
     `rng.mjs`; update ALL current importers (`lib/arm-eval/judge.mjs`,
     `lib/audit-shadow.mjs`, AND `seeded-random.mjs`'s own existing callers
     per its docblock — `final-adjudication.mjs`, `gpt-sentinel-trigger.mjs`
     — grep for the full current importer list before deleting the file,
     don't rely on this plan's list being exhaustive); retire
     `seeded-random.mjs`.
   - `nowIso`: new **`scripts/lib/audit/time-utils.mjs`** (NOT
     `llm-helpers.mjs` — round-1 M2 fix; verified `llm-helpers.mjs`'s actual
     exports are all LLM-call-shaping — `callGPT`, `MODEL`,
     `getPassPrompt` — dumping a generic timestamp helper there would make
     non-LLM audit code depend on an LLM-prompt module for no reason).
     Update `lib/audit/evidence-triage.mjs`, `lib/audit/
     final-adjudication.mjs`, `lib/audit/stage1-triage.mjs`.
   - `isP0OrP1`: canonical **`scripts/lib/persona/audit-correlator.mjs`**
     (export it — round-2-of-Gemini G1 fix, direction REVERSED from the
     original round-1 draft, which wrongly assumed
     `scripts/lib/persona/audit-correlator.mjs` sits in a `persona-test`
     domain that has "no declared restriction." Direct verification of
     `.audit-loop/domain-map.json`'s `rules` array shows `persona-test`'s
     glob is `scripts/lib/persona-test/**` specifically — `.../lib/persona/`
     (no `-test` suffix) does NOT match it and falls through to the
     catch-all `scripts/lib/**` rule, i.e. `shared-lib` domain instead.
     `shared-lib`'s own `allowedDeps` (`["findings","plan"]`) does NOT
     include `stores`, so the round-1 direction (shared-lib importing FROM
     stores) was itself an undeclared edge. The corrected direction:
     `scripts/lib/store/persona-outcomes.mjs` (confirmed `stores` domain via
     its own specific `scripts/lib/store/**` glob) imports FROM
     `audit-correlator.mjs` instead — `stores`' `allowedDeps` explicitly
     includes `shared-lib`, so `stores -> shared-lib` is already an approved
     edge, no exception needed.
   - `hashText`: same-directory pair
     (`lib/arm-eval/producers/{brainstorm,plan}.mjs`) — extract to new
     sibling `lib/arm-eval/producers/_shared.mjs`.
   - `estimateTokens`: same-directory pair
     (`lib/requirements/{context,extract}.mjs`) — extract to new sibling
     `lib/requirements/_shared.mjs`.
   - `hashFile`: canonical **`scripts/lib/sync-manifest.mjs`** — it ALREADY
     exports `hashFile` (verified; `sync-isolation-verify.mjs`'s copy is
     module-private). Zero new file needed — just delete the private copy
     and import.
   - `chunk`: `lib/store/arch/_shared.mjs` is already named as the shared
     home — `lib/store/security.mjs` imports from there. No new file.
   - `isValidCount`: canonical **`scripts/lib/model-pricing.mjs`** (export
     it — currently module-private in both files) — `oss-structured-
     output.mjs` imports from there.
   - **Why**: real, fixable duplication inside this repo's own tooling —
     consolidating here benefits every consumer permanently on their next
     sync, which is strictly better than adding exclusion config anywhere.

9. **`round4`, `sha256`, `contractExists`, `firstSeenFromHistory`** (modify,
   4 files get a pragma, not a merge — round-4 M3 fix: the original draft
   left this as an unresolvable template, `target=<the OTHER file>:<symbol>
   reason=... see [pointer]>`, which item 1's own `[<>${}]` placeholder
   guard would have SKIPPED entirely if authored literally — every pragma
   below is now the real, final comment text, one side annotated per the
   existing convention, `findPragmaAbove`/`PRAGMA_RE` has no "both sides"
   concept, it only ever matches the comment immediately above ONE
   declaration):
   - `scripts/lib/model-ab-decision.mjs`, immediately above `round4`:
     `// @duplicate-justification: target=scripts/lib/arm-eval/decision.mjs:round4 reason=arm-eval-stats and model-ab-decision are deliberately independent shadow-evaluation systems (AGENTS.md "Model-A/B/C shadow CONCLUDED" and "Arm-eval framework" sections) -- not accidental duplication, do not merge`
   - `scripts/lib/visual/schema.mjs`, immediately above `sha256`:
     `// @duplicate-justification: target=scripts/lib/nav/schema.mjs:sha256 reason=nav-audit and visual-audit are a deliberately independent "sister lens" pair (AGENTS.md skill-naming-convention note) -- zero existing nav<->visual imports today, not accidental duplication`
   - `scripts/lib/visual/contract.mjs`, immediately above `contractExists`:
     `// @duplicate-justification: target=scripts/lib/nav/contract.mjs:contractExists reason=nav-audit and visual-audit are a deliberately independent "sister lens" pair (AGENTS.md skill-naming-convention note) -- zero existing nav<->visual imports today, not accidental duplication`
   - `scripts/lib/visual/drift.mjs`, immediately above `firstSeenFromHistory`:
     `// @duplicate-justification: target=scripts/lib/nav/drift.mjs:firstSeenFromHistory reason=nav-audit and visual-audit are a deliberately independent "sister lens" pair (AGENTS.md skill-naming-convention note) -- zero existing nav<->visual imports today, not accidental duplication`
   - **Why these get a pragma instead of a merge**: zero existing
     nav↔visual or arm-eval↔model-ab imports today (confirmed via grep) —
     these are documented-independent systems, not accidental duplication.
     This is also the live end-to-end test case for item 7's mechanism.

10. **`tests/stale-pragma-sweep.test.mjs`** (modify — file exists per the
   neighbourhood consultation's `drift-stale-pragma.test.mjs` reference;
   confirm exact filename during implementation) — add coverage for
   `findRepoPragmas`: extracts target file/symbol/reason correctly, skips
   the same `*.md`/`tests/*` paths `findStalePragmas` already skips, skips
   placeholder/template text (the `[<>${}]` guard) matching the existing
   test's fixtures.

11. **`tests/symbol-index-drift-justification.test.mjs`** (create) —
    integration-style test (Tier 2, invariant-based per this repo's testing
    doctrine): given a fixture repo with a pragma-annotated duplicate pair
    and an un-annotated duplicate pair, after the refresh pipeline's
    justification-write step runs, `top_duplicate_clusters` excludes the
    annotated pair's member from its `file_paths`/`file_count` and
    `drift_score`'s duplication count drops by exactly 1 — but the
    un-annotated pair is unaffected. Requires a disposable test DB per this
    repo's Tier-3 disposable-DB doctrine (`AUDIT_DB_TEST_URL`,
    `assertDisposableDbUrl`) — reuse the existing harness pattern from
    `tests/db-setup.test.mjs`/`tests/db-withtx.test.mjs`, do not hand-roll a
    new one.

12. **`tests/symbols-store.test.mjs`** (modify — confirm exact filename;
    the module already has coverage per its docblock listing
    `recordLayeringViolations`) — add `recordDuplicateJustifications` unit
    coverage: the two-statement (reset, then `VALUES`-driven apply), one-
    transaction behaviour (round-3 H2 design; round-4 M1 fix — corrects this
    item's own stale "single statement"/"assert one `UPDATE` call" wording,
    which contradicted the actual design one section over) — NOT row-count
    chunking, that was round-1's original draft error; the two-statement
    shape is fixed regardless of how many rows are justified. Error
    propagation matches `recordLayeringViolations`'s convention.

**Close-out (not a phase)**: `node scripts/requirements.mjs extract --files
<the touched files from items 1-11>` + `node scripts/requirements.mjs
reconcile` (round-2 M3 fix — the requirements rubric injected into this
plan's own audit flagged the ledger as stale/uncovered for these paths, and
this plan touches persistence/migration/refresh/shared-store code the
requirements layer is meant to govern), `npm run context:check` (AGENTS.md
is already at the 1200-line cap per this session's earlier finding — this
plan's AGENTS.md footprint, if any, must be a net-zero or condensed
addition, same constraint hit and resolved during the prior `/cycle` this
session), `npm test`.

## Risk & Trade-off Register

- **Trade-off**: persisting justification as columns on `symbol_index`
  (snapshot-scoped) means a pragma only takes effect from the NEXT
  `arch:refresh` onward, not retroactively on already-published snapshots.
  Matches how layering violations already behave (also recomputed fresh per
  refresh) — not a new limitation this plan introduces.
- **What could go wrong**: item 6's next-declaration resolution (bounded by
  a 5-line sanity gap) could still mis-anchor on unusual formatting (e.g. a
  pragma immediately followed by an unrelated single-line comment, then a
  multi-line JSDoc block, pushing the real declaration's `start_line` past
  the 5-line bound) — the fix-side mitigation is unchanged: exceeding the
  bound makes the pragma unresolvable rather than mis-attached, and it's
  now surfaced in the report (item 6's ambiguity-guard extension) rather
  than silently dropped, so an author gets feedback and can adjust
  placement. Validate the 5-line bound against the 4 real annotated files
  this plan itself creates (item 9), not synthetic fixtures alone.
- **Deliberately deferred**: the wine-cellar-app-local legacy-file cleanup
  (54 clusters) — different repo, zero-code, zero-risk `git rm`, not this
  plan's concern. A general cross-axis suppression-rules engine (see
  right-sizing above) — no current requirement.

## Testing Strategy

- **Unit** (Tier 1, `stale-pragma-sweep`/`duplication-detector` exports):
  `findRepoPragmas` extraction correctness, `PRAGMA_RE` export shape
  unchanged (no behavior drift in the existing diff-scoped pass).
- **Unit** (Tier 1, `symbols.mjs`): `recordDuplicateJustifications` is
  **two** `UPDATE` statements in **one transaction** (round-4 M1 fix —
  corrects a stale reference left over from round-2's design, which this
  section still described before round-3 H2 replaced it with the
  reset-then-`VALUES`-apply pair; explicitly NOT chunked, unlike
  `recordLayeringViolations`'s bulk-insert path — no row-count-driven
  batching, just the two fixed statements): assert both statements run
  inside `withTx`, and that a failure in the second (apply) statement rolls
  back the first (reset) — not "one `UPDATE` invocation," which the actual
  per-row-values design can no longer satisfy. Error propagation.
- **Integration** (Tier 2/3 hybrid, disposable DB): the end-to-end
  pragma-to-excluded-drift-score path (item 11) — this is the one seam where
  a silent miscount (excluding too much, or too little) would be a real
  regression, so it gets a real DB, not a mock. Round-1 M3 expansion — the
  matrix must cover, not just the single annotated-pair happy path:
  (a) **copy-forward reset**: a pragma present in refresh N, then REMOVED
  before refresh N+1 (incremental) — the row must un-flag on N+1, not stay
  stuck `true` (the exact bug H1 found); (b) **target/reason changed**
  between refreshes — the new reason persists, the old one doesn't linger;
  (c) **ambiguous same-name declarations** in one file — the resolver picks
  the correct one via next-declaration proximity (item 6's algorithm), not
  the first/wrong match; (d) **3+-member cluster, one member justified** —
  the cluster still reports with the remaining ≥2 unjustified members,
  `file_count` drops by exactly 1, it does NOT disappear entirely — this is
  a CLUSTER-level effect (round-3 M2 terminology fix: distinct from (e));
  (e) **excluded-count (row-level) accuracy** — `drift_score`'s
  `duplication_excluded_count` (a count of individual DECLARATIONS excluded,
  not clusters or pairs) matches the number of justified rows that would
  otherwise have shared a `signature_hash` with ≥1 other file (not the raw
  pragma count, which could include pragmas targeting a symbol with no
  duplicate at all — those must NOT increment the count); for this plan's
  own 4 real 2-member cases specifically: the CLUSTER disappears from
  `top_duplicate_clusters` entirely (a cluster-level effect, `file_count`
  1→below the `>1` threshold) while `duplication_excluded_count`
  (row-level) increases by exactly 1 — two different, correctly-distinct
  metrics, not the same number;
  (f) **multiple pragmas resolving to one definition_id** (round-2 M1) — the
  ambiguity guard reports it rather than silently picking a reason by
  enumeration order; (g) **a pragma that resolves to no declaration at all**
  (beyond the 5-line bound, or genuinely orphaned) — reported, not silently
  dropped.
- **Key edge cases**: a pragma targeting a symbol that doesn't exist in this
  refresh (already covered by the existing stale-pragma report, don't
  duplicate); a pragma added mid-refresh-cycle only taking effect on the
  NEXT refresh (documented behavior, not a bug); the `round4`/nav-visual
  pragmas specifically drop those exact clusters from `wine-cellar-app`'s
  next `arch:refresh` + `arch:drift` run (manual live-verification against
  that repo once the migration is applied there, mirroring this session's
  `oss-call-policy.mjs` sync-then-verify pattern).
- **Full suite**: `npm test` — zero new failures.

## 11. Execution Clustering

- **Cluster A** — Phases 8-9 — fix-gate: yes
  - **Coupling**: both are pure consolidation/pragma-authoring against
    EXISTING code, touching zero shared files with Cluster B's new
    persistence machinery. Grouped together (not split further) because
    deciding "merge vs. pragma" for the borderline cases (round4,
    nav/visual) is easier done in one pass with full context on which
    symbols were ALREADY merged in phase 8.
  - Files: the ~15 files listed in phase 8 (modify) + the 4 files in phase 9
    (modify).
- **Cluster B** — Phases 1-7, 10-12 — fix-gate: final
  - **Coupling**: the actual new feature — the new shared-lib pragma module,
    schema migration, write-path, RPC changes, and their tests form one seam
    (a migration with no write-path is dead; a write-path with no RPC
    exclusion doesn't suppress anything; tests validate the whole chain).
  - Files: phases 1-7 (create/modify) + phases 10-12 (create/modify).
- **Final gate**: mandatory consolidated Gemini review over the union diff
  of Cluster A + Cluster B, per this repo's standard `/cycle` closed-loop
  final-gate protocol.

## Audit Trail

- **Investigation** (before this plan was written): a categorization script
  cross-referenced `wine-cellar-app`'s 86-cluster `arch:drift` report against
  `scripts/.claude-skills/` path prefixes, confirming the exact 12/56/18
  split (12 upstream-only, 56 mixed, 18 local-only) matched independently by
  the user. `diff` against one representative "mixed" pair confirmed the
  54-of-56 legacy-file-copy hypothesis (byte-identical minus the sync
  banner, untracked, unreferenced). Grep confirmed zero existing nav↔visual
  and arm-eval↔model-ab-decision imports, supporting the "sister lens /
  deliberately independent" reading for 4 of the 12 upstream-only clusters.
- **GPT plan-audit, round 1**: H1 (copy-forward-then-UPDATE claim was false
  for the pragma-removed case) + H2 (target-exclusion semantics ambiguous
  for 3+-member clusters, reason field order-dependent) + H3 (resolution
  keyed on `(file, symbolName)` string equality, no anchoring, silently
  drops ambiguous cases) + H4 (report/count mechanism hand-waved, Postgres
  return-type-change constraint not addressed) + M1 (new cross-domain
  import, arch-memory depending on audit-orchestration) + M2 (5 of 8
  consolidation targets hand-waved as "pick the natural owner," including
  the highest-risk `mulberry32`/`isP0OrP1` cases) + M3 (integration test
  matrix covered only the single happy-path pair) → all 7 accepted and
  fixed directly (no dismissals): full reset+reapply write semantics
  (mirroring `symbol_layering_violations` exactly); exclusion re-scoped to
  the pragma-bearing declaration, not the named target; resolution redesigned
  to use the pragma's own line number + a forward-scanning proximity window
  (mirroring `findPragmaAbove`, inverted); `drift_score`'s confirmed `JSONB`
  return type used for the excluded-count without a schema-breaking
  drop/recreate; `PRAGMA_RE`'s ownership flipped to `stale-pragma-sweep.mjs`
  (arch-memory) per the file's own documented approved-edge-direction
  precedent; all 8 consolidation targets given concrete, evidence-backed
  homes (export status + `.audit-loop/domain-map.json` `allowedDeps` checked
  directly, not guessed) — `mulberry32` moved from the originally-proposed
  audit-domain `seeded-random.mjs` to the domain-neutral `lib/rng.mjs` after
  confirming `arm-eval` has no `allowedDeps` entry at all; test matrix
  expanded to 5 explicit scenarios beyond the single happy path.
- **GPT plan-audit, round 2** (H dropped 4→2, >30%, continued per the
  convergence rule): H1 (self-contradiction — "single statement" full-reset
  vs. "mirror chunking convention," which cannot both hold) + H2 (the
  "small window" resolution algorithm was still deferred to implementation
  rather than concretely specified) + M1 (multiple pragmas resolving to one
  `definition_id` — order-dependent reason overwrite, undetected; unresolved
  pragmas dropped with zero feedback) + M2 (the plan claimed `target=`/
  `reason=` persist as audit-trail but the schema only had a `reason`
  column) + M3 (this plan touches the requirements-governed persistence/
  migration/refresh paths but close-out never refreshed the — flagged
  stale — requirements ledger) → all 5 accepted and fixed: clarified
  `recordLayeringViolations` chunks because it bulk-INSERTS many rows
  (parameter-list-size driven), while this function is a single `UPDATE`
  over existing rows — no chunking applies, removed the contradictory
  framing entirely; replaced "small window" with a concrete algorithm
  (smallest `start_line` strictly after the pragma line, bounded by a cited
  5-line sanity gap); added an ambiguity guard (multiple pragmas → one
  declaration is now detected and reported, not silently overwritten) and
  an unresolved-pragma report (extends the existing stale-pragma markdown
  section, same LOW-severity framing); added the missing
  `duplicate_justification_target`/`_source` columns; added a
  `requirements.mjs extract` + `reconcile` close-out step.
- **GPT plan-audit, round 3** (H plateaued 2→2 — the nominal stop signal —
  but all 4 findings were concrete, code-traced bugs, not restated rigor
  pressure, so continued per the genuine-bug exception; this is the
  deliberate stopping point regardless of round 4's outcome): H1 (told
  implementation to edit an ALREADY-APPLIED historical migration file — a
  real deployment-breaking bug: migration filenames apply once, so editing
  one after the fact is a no-op on any deployed database, producing a split
  deployment where the schema exists but the old `drift_score`/
  `top_duplicate_clusters` bodies keep running) + H2 (the single
  boolean-only `UPDATE ... = ANY($ids)` genuinely cannot carry a different
  `reason`/`target`/`source` per row — the plan's own `CASE WHEN ... END`
  was left as a literal ellipsis) + M1 (pragma-resolution data source,
  timing, and query cost left unspecified — permitted an N+1 lookup) + M2
  (the "excluded" count's unit was undefined — declaration vs. cluster vs.
  file vs. score-delta are different quantities, and the plan's own test
  claim "drops by exactly 1" didn't specify which) → all 4 accepted and
  fixed: the `drift_score`/`top_duplicate_clusters` changes now live
  ENTIRELY as fresh `CREATE OR REPLACE FUNCTION` bodies inside the NEW
  migration file, the two historical migrations are never touched; the
  write path is now two statements (unconditional reset, then a
  `VALUES`-list-driven `UPDATE ... FROM` carrying each row's own
  reason/target/source) wrapped in this repo's existing `withTx` helper —
  one transaction, not chunked, resolving round-2 H1's contradiction for
  real; pragma resolution now runs after the `symbol_definitions` upsert via
  one batched query scoped to just the pragma-referencing files, reusing
  the same canonical-path normalizer this refresh already uses; the
  excluded-count is now explicitly defined as a row-level "excluded
  declarations" quantity, separately named and tested from the
  cluster-level `file_count`/`HAVING count > 1` effect.
- **GPT plan-audit, round 4** (H:0 — the genuine-bug-exception round
  completed, per round 3's own pre-committed stopping point): M1 (item 12 +
  Testing Strategy still described round-2's superseded single-`UPDATE`
  design after round-3 H2 replaced it — a stale cross-reference) + M2 (the
  `v_excluded_count` predicate matched `signature_hash` alone, not
  `(signature_hash, kind)` — `top_duplicate_clusters`' own cluster
  identity — risking an over-count) + M3 (the 4 required pragmas were left
  as an unresolvable template that item 1's own placeholder guard would
  skip if authored literally) → all 3 accepted and fixed: item 12/Testing
  Strategy corrected to match the actual two-statement design; the
  excluded-count predicate now joins `symbol_definitions` and matches
  `kind` on both sides; all 4 pragmas now have real, final, concrete text
  (target file:symbol, one side stated explicitly, a concrete AGENTS.md
  section cited in the reason). **Stopping here** — H:0, all MEDIUM
  findings across 4 rounds were concrete and fixed, not restated rigor
  pressure; this is the plan's converged state.
- **Gemini final review, round 1**: CONCERNS, `architectural_coherence:
  Strong`. G1 (HIGH): the batched resolution query in item 6 targeted
  `symbol_definitions` for `start_line` — that column doesn't exist there
  (`symbol_definitions` is the stable, positional-data-free identity table;
  `start_line`/`end_line` are `symbol_index`-only, snapshot-scoped). The
  query as written would fail with a Postgres `column does not exist`
  error. G2 (HIGH): round-1's own M1 fix (flip `PRAGMA_RE` to live in
  `stale-pragma-sweep.mjs`, arch-memory, with `duplication-detector.mjs`
  importing from it) relied on that file's own docblock claim of an
  "approved edge" that turned out to be unverified — direct inspection of
  `.audit-loop/domain-map.json` showed NEITHER direction is actually
  declared in `allowedDeps`, so round-1's fix just relocated the undeclared
  edge rather than removing it. Both fixed: item 6's query now joins
  `symbol_index` (scoped to `refresh_id`) to `symbol_definitions`, sourcing
  `start_line` from the table that actually has it; `PRAGMA_RE` and
  `findRepoPragmas` relocated a second time to a genuinely domain-neutral
  new `scripts/lib/duplicate-justification-pragma.mjs` (`shared-lib`
  domain, verified BOTH `arch-memory` and `audit-orchestration` list
  `shared-lib` in their own `allowedDeps`) — both consumers now import from
  a common neutral module, neither imports from the other. File-Level Plan
  renumbered (12 items) to accommodate the new file.
- **Gemini final review, round 2** (concrete design/correctness defect —
  genuine-bug exception, one more round beyond the nominal 2-round cap):
  G1 (HIGH): round-1's `isP0OrP1` direction (`persona/audit-correlator.mjs`
  imports FROM `store/persona-outcomes.mjs`) was justified by claiming
  `audit-correlator.mjs` sits in an unrestricted `persona-test` domain —
  false per direct verification of `domain-map.json`'s actual glob rules
  (`persona-test` only matches `scripts/lib/persona-test/**`; `.../persona/`
  falls to the `shared-lib` catch-all, whose `allowedDeps` doesn't include
  `stores`). Fixed: direction reversed — canonical is now
  `audit-correlator.mjs` (`shared-lib`), `store/persona-outcomes.mjs`
  (confirmed `stores` domain) imports FROM it, since `stores`'
  `allowedDeps` explicitly includes `shared-lib`, an already-approved edge.
- **Gemini final review, round 3** (genuine-bug exception, second extra
  round — both round-1 and round-2 found concrete, data-verified defects,
  not implementation-completeness nits): **APPROVE**, 0 new findings, 0
  wrongly-dismissed. Plan converged.

### Code Audit (post-implementation, 6 rounds — hard cap reached)

- **Cluster A, round 1** (H:12, M:18, L:3 — mostly Structure-pass artifacts
  from Cluster B's not-yet-built files, plus pre-existing code in files
  touched with only a 1-line export/import/pragma change): 2 genuine NEW
  duplicates the original plan missed — `mulberry32` in
  `scripts/model-eval-auditor.mjs` and `estimateTokens` in
  `scripts/lib/repo-context.mjs` — found and fixed (deduplicated, not
  pragma'd, after verifying the "dependency-free CLI" rationale for one was
  factually wrong). All other findings deferred as Cluster-B-not-built-yet
  (expected, by design) or pre-existing/unrelated (verified via `git diff`).
- **Cluster A, round 2** (H:4, M:8, L:1): 1 stale-index Duplication-pass
  false-positive on the already-fixed `mulberry32` (GPT overruled itself
  after direct code verification); rest deferred as Cluster-B-not-built-yet
  or pre-existing. Cluster A's own code: H:0 unresolved.
- **Union round 1** (H:8, M:9, L:2, Cluster A+B combined): H1
  (`recordDuplicateJustifications` reported the requested count, not the
  actual `UPDATE` rowCount) and M1 (`drift.mjs` read snake_case fields from
  a function that returns camelCase, silently making the whole report-time
  reconciliation a no-op) → both real, both fixed. H7 (plan's own
  Sustainability Notes still said "2 columns" after round-2 of the plan
  audit added target/source) → plan doc corrected. Rest deferred as the
  recurring migration-tool-artifact, pre-existing/unrelated, or
  practically-impossible-scale (65,535-parameter limit at 16,384+
  justifications).
- **Union round 2** (H:8, M:14, L:2): H3 (`recordDuplicateJustifications`
  accepted `repoId` but never used it) → defense-in-depth scoping added.
  M7 (`git grep` without `--untracked` misses pragmas in brand-new files
  the extraction pipeline DOES index) → empirically verified real, fixed.
  H8 (a transient `git` failure would silently WIPE every existing
  justification via the always-full-reset write design) → serious,
  fixed with a `strict` mode that throws instead of degrading, letting
  `refresh.mjs` skip the write step entirely rather than risk data loss.
  Added the missing "target/reason changed" test scenario (M9) and fixed
  per-`DELETE` test-teardown robustness (L2). Rest deferred as
  pre-existing/unrelated or an accepted architectural design tradeoff
  (two different pragma-scanning algorithms for two genuinely different
  scopes — diff-scoped vs. full-repo).
- **Union round 3** (H:12, M:13, L:6): M5 (an ambiguous declaration —
  multiple pragmas resolving to one target — silently excluded via a
  "last one wins" compromise) → redesigned so a genuinely ambiguous
  declaration trusts NEITHER pragma, matching the plan's own "fail toward
  more findings, never fewer, on ambiguity" principle. L2 (stale JSDoc
  after the round-2 `repoId` fix) → corrected. Rest deferred as
  pre-existing/unrelated, matching an established codebase convention (the
  cloud-off return-value ambiguity matches every other `record*` function
  in the same file), or recurring.
- **Union round 4 / hard cap** (H:7, M:14, L:2): every finding was either
  the recurring migration-tool-artifact (5th occurrence — verified false
  via a live `arch:refresh` + `arch:drift` run showing the mechanism
  working end-to-end: `duplication_excluded_count:4` exactly matching the 4
  real pragmas, score dropping 29→24), a recurring pre-existing finding
  already dismissed with documented rationale, pre-existing code this
  change never touches (verified via `git diff HEAD` each time), an
  inherited (not introduced) `PRAGMA_RE` characteristic byte-identical to
  the regex it was relocated from, or repo-wide Architecture-pass
  domain-map noise. Genuine convergence, not rigor pressure — no fixes
  needed this round.
- **Consolidated Gemini gate** (mandatory, over the full 6-round union
  diff, `--mode code`): **APPROVE** on round 1 — 0 new findings, 0
  wrongly-dismissed.
- **Net**: 8 genuine bugs found and fixed across the new pragma-persistence
  mechanism (UPDATE-success-reporting, snake_case/camelCase mismatch,
  missing repo_id scope, missed `--untracked` flag, a serious
  full-reset-vs-transient-failure data-wipe risk, an ambiguous-pragma
  design gap) plus 2 additional real duplicate-symbol copies the original
  plan missed — found via the Duplication pass itself, a nice
  self-referential validation that the feature being built also caught
  real bugs during its own construction. Every dismissal was verified via
  `git diff HEAD`, a live DB query, or a real `arch:refresh`/`arch:drift`
  run — never assumed either way.
