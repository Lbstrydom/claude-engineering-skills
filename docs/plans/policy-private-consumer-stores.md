# Plan: consumers whose store is private by policy — honest populations, analysis shipped to the data, reports carried by hand
- **Date**: 2026-11-21
- **Status**: Complete
- **Author**: Claude + Louis
- **Scope**: backend (CLI + pure libraries + one sync-closure change; no UI). Stack `js-ts`.
- **Target domain(s)**: `scripts`, `shared-lib`, `stores`, `sync`

Origin: consumer field report 3 (kept outside the repo; it names an organisation). A consumer
organisation's audit store is a private Postgres behind a tunnel, and its policy forbids any
data leaving the organisation — **not even the redacted aggregates** that `telemetry:export`
(#420–#430) was built to carry. Only a person may carry a verdict out, in prose. Louis approved
all three asks plus one addition (a "consumer-reported, unverified" evidence category) on
2026-11-21. This plan is the opposite of the export path: nothing moves, so the tooling has to be
honest about what it did not measure, run where the data is, and help a human carry the result.

## 0. Measurements (before design)

- **The fan-out has exactly two readers.** `discoverStores` (`scripts/lib/upstream/store-discovery.mjs:152` (6680c819))
  is called only by `scripts/upstream-queues.mjs:249` and `scripts/store-drift.mjs:251` (`git grep -n discoverStores`).
  `scripts/lib/dashboard/collect-home-consumers.mjs`, `scripts/lib/fleet/handover.mjs` and `scripts/lib/sync-inventory.mjs`
  import `CONSUMER_REPOS` but open no store (no `AUDIT_DB_URL` / `storeFingerprint` / child spawn in them).
- **An unreachable store is already not rendered empty** (measured 2026-11-20 against a dead loopback DSN; sibling note
  `ces-private-store-field-report-investigation-2026-11-20.md`): both collators route `ok:false` to `unqueried` and a
  0-answered run prints "NOTHING WAS CHECKED". What does not exist is a **declared** state: a consumer that must never be
  queried is today indistinguishable from one whose `.env` is missing (`UNRESOLVED.NO_DSN`) — and, worse, a consumer whose
  DSN *does* resolve on the maintainer's machine (a tunnel is up) would be queried, which the policy forbids.
- **`own-model-coverage.mjs` is not in the sync closure**: absent from `SYNCED_SCRIPT_ENTRIES` in
  `scripts/lib/sync-entry-lists.mjs` (the closure's declaration; `sync-path-map.mjs` only maps paths) and from the
  relocation list in `scripts/lib/sync-isolation-verify.mjs:86`. Its three inputs are resolved from `ROOT = scripts/..`
  (`scripts/own-model-coverage.mjs:23`): `.own-model-coverage.json`, `tests/fixtures/expected-schema.json`,
  `supabase/migrations/`. Relocated to `scripts/.claude-skills/`, `ROOT` would be `<consumer>/scripts`, so every input
  misses. The latter two already ship (`LAYOUT_CONSTANTS.EXPECTED_SCHEMA_DEST`, `MIGRATIONS_DEST_PREFIX`); the config does not.
- **The capture-v1 recipes are documentation, not commands.** `docs/reference/audit-telemetry-queries.md` holds 11 SQL
  blocks; `tests/audit-capture-db.test.mjs` executes them from the markdown. `docs/` is outside the consumer closure, and
  the recipes use `CREATE TEMP VIEW`, which Postgres refuses inside a `READ ONLY` transaction (the exporter's snapshot
  contract, `scripts/lib/telemetry-export/sources.mjs` `SQL.setTx`). So the report cannot run the doc text as written.
- **Verdict writers that read a store** (census by reading each CLI that prints a verdict and imports `lib/store/` or
  `lib/db/`): `scripts/tiered-shadow-report.mjs` (shadow window), `scripts/bakeoff-collect.mjs` (final-review shadow
  bake-off), `scripts/model-eval-adjudicator.mjs` (ground truth from `getAdjudicatorGroundTruth`, model-swap verdict),
  `scripts/own-model-coverage.mjs` (coverage floors). `scripts/model-eval-auditor.mjs` writes eval-run rows but scores a
  committed corpus, not store population — excluded with that reason. Prose verdicts are hand-written under
  `docs/research/*.md` (39 entries today).
- **`upstream reconcile` already exists** (`scripts/lib/cross-skill/commands/quality.mjs:262` — ledger ↔ store). The field
  report's "upstream reconcile" (match a GitHub issue back to a local report) is a different operation and needs another name.
- **`scripts/lib/upstream/commands.mjs` is 1090 lines**, over the 1000-line size ratchet (`.file-size-baseline.json`):
  it may not grow. New `upstream` behaviour goes in a new module.
- **Architectural memory** (`get-neighbourhood`, k=8): population line → all `review` (below noise floor; greenfield);
  export Markdown → `precedent: redactReport` (`commands.mjs`) — reused below as the first redaction stage; telemetry
  report → `precedent: buildSuppressionStats` (unrelated cluster noise; the real precedent is `buildExport`, chosen by the brief).

## 1. The problem, narrowly

Three things are false or impossible today for a policy-private consumer:
1. A verdict computed from N stores reads as a verdict about everyone. Nothing says the policy consumer was not measured,
   or that it never can be.
2. The consumer cannot run upstream's own questions (capture-v1 (a)–(c), coverage floors, shadow status) against its own
   store, so it cannot answer "run X and tell us the verdict".
3. Its upstream reports can only reach CES by hand, and nothing helps the operator make a pasteable, sanitized copy.

**Code Trace** (6680c819):
- Fan-out: `upstream-queues.mjs main()` :249 → `discoverStores()` `lib/upstream/store-discovery.mjs:152` →
  per consumer `readEnvText(repo.path)` :186 → `resolveRepoStore()` :127 → `add()` → `collectQueues()`
  `upstream-queues.mjs:150` → `queryStore()` :118 (child `cross-skill.mjs upstream list`) → `renderQueues()` :190.
  `store-drift.mjs main()` :251 is the same chain into `collectDrift` / `renderDrift`.
- Pointer: `doctor/probes.mjs` → `readStoreSetupPointer()` `lib/doctor/store-reachability.mjs:73` →
  `renderStoreDetail()` :106.
- Export: `telemetry-export.mjs main()` :86 → `buildExport()` `lib/telemetry-export/build.mjs:168` →
  `deps.readRows` = `makeRowReader()` `lib/telemetry-export/sources.mjs:51` (one `withTx`, `SQL.setTx` READ ONLY) →
  `validateExport()` → `assertExportClean()` `lib/telemetry-export/redact.mjs:52` → `--print` writes stdout :184.
- Upstream report: `cross-skill.mjs upstream report` → `upstreamCmd()` `lib/cross-skill/commands/quality.mjs:139` →
  :239 `readStdin()` → `upstreamReport()` `lib/upstream/commands.mjs:440` → `validateReportInput()` :389 →
  `redactReport()` :428 → `computeFingerprint()` → `writeEnvelope()` → `recordFn`.
- Coverage: `own-model-coverage.mjs main()` :78 → `loadConfig()` :26 (`ROOT/.own-model-coverage.json`) →
  `measureLive()` :41 → `buildMeasureSql()` / `evaluateEntry()` `lib/telemetry/coverage.mjs`.

## 2. Design

### 2.1 Declared policy: `"upstreamReachable": false` (Phase 1)

- **Schema.** `.audit-loop/store-setup.json` (#414's doctor pointer) gains an optional boolean `upstreamReachable`.
  `readStoreSetupPointer` (`scripts/lib/doctor/store-reachability.mjs:73`) returns it; a non-boolean value is a
  `problem`, never coerced. A file carrying only `upstreamReachable` is valid (today "neither check nor docs" is a
  problem — that rule moves to "none of the three keys").
- **Fail closed toward privacy.** In discovery a consumer is **not queried** when its pointer says
  `upstreamReachable:false`, **or** the pointer is present but unreadable/malformed. The two get distinct reasons:
  `unreachable-by-policy` (declared) and `policy-undeterminable` (file present, could not be read). Rationale: a typo in a
  privacy declaration must not turn into a query of the store it protects.
- **A store, not only a consumer, can be private.** Discovery dedups by fingerprint, so a private consumer whose DSN
  equals a reachable consumer's (or which falls through to the shared `~/.audit-loop.env` layer that CES itself uses)
  would have its rows read through the other consumer's query. So discovery still **resolves the private consumer's DSN
  locally and fingerprints it** — the same in-process read it does for every consumer; the DSN is never queried, never
  logged, never returned — and any queryable store whose fingerprint collides is **refused** and listed as
  `shared-with-policy-consumer` (in `policyUnreachable`, never in `stores`). A private consumer with no resolvable DSN
  cannot collide with anything and is simply listed. The contradiction is printed so the operator fixes the
  configuration; nothing is queried in the meantime.
- **Shape.** `discoverStores` returns a third list beside `stores` and `unresolved`: `policyUnreachable:
  [{repo, alias, reason}]`. The pointer reader is **injected and required** (`readSetupPointer`), like `fingerprintOf`
  (which throws when absent today), because `store-discovery.mjs` is `shared-lib` and the doctor module is not (the
  layering note at `store-discovery.mjs:52`). A missing reader **throws** — an omitted injection must not silently
  disable the privacy rule. Both production callers pass `readStoreSetupPointer`. A consumer with no pointer, or with
  `upstreamReachable` absent or `true`, behaves exactly as today (field report §4; the brief's constraint).
- **Readers.** `collectQueues` / `collectDrift` carry `policyUnreachable` through; both renderers print it on every
  path, as its own line — `unreachable-by-policy <alias> — declared private; never queried, NOT counted`. It is never
  in `storesQueried`, never in `unqueried` (that list means "we tried"), never counted as empty. `--json` carries the
  list. The "NOTHING WAS CHECKED" branch counts only stores that were *eligible* to be asked.
- **Doctor.** `renderStoreDetail` adds `upstream: unreachable-by-policy (declared in .audit-loop/store-setup.json)` so
  the consumer's own operator sees the declaration took effect.

### 2.2 The population line (Phase 2)

One pure module, `scripts/lib/population.mjs`, the only producer of the line:

```
Population: measured from 2 stores — d5a9d07b (ces, wca), 3f2a91c0 (sto). Not measured: orgx (unreachable-by-policy), aio (store-unreachable). Consumer-reported, unverified (not pooled): orgx — "dispute rate 0.6%" (2026-11-20, by hand).
```

- **The canonical form is a versioned object, the line is its rendering.** `population/v1`:
  `{schema, measured:[{store, scope:'store'|'repo', consumers:[alias]}], notMeasured:[{alias, reason}],
  unknownBeyond: boolean, consumerReported:[{alias, claim, receivedAt, via}]}`. `unknownBeyond:true` says the population
  outside `measured` is not known here (rendered `other consumers: not known here`) — it is not a fake `notMeasured` entry,
  and a measured store with no known aliases renders as `<fp> (consumers not known here)``. `buildPopulation(...)` validates and returns it;
  `renderPopulationLine(pop)` renders it; `parsePopulationLine(text)` reads a line back to the object or `null` (the tests
  and the doc check use it, so the grammar has one definition). JSON envelopes carry the object, never only the line.
- **Bounded, validated fields** (refused, never truncated or escaped into ambiguity): `alias` `[a-z0-9-]{1,32}`;
  `store` `[0-9a-f]{8}`; `reason` from a closed set (`unreachable-by-policy`, `policy-undeterminable`,
  `shared-with-policy-consumer`, `store-unreachable`, `no-store`, `not-in-scope`); `claim` ≤200 chars,
  no control characters, no `;` or `"` (the line's delimiters), and it must pass the leak scan (§2.4); `receivedAt`
  ISO date; `via` from `by-hand` | `telemetry-export`.
- **Labels are registry aliases, never repo names or hostnames.** The line is meant to be pasted into public
  `docs/research/`; a policy consumer's repo name is exactly what its organisation would not want published. The alias is the registry's existing **required** `alias` field
  (`consumer-repos.mjs`, the `--target` key); Phase 2 makes the registry loader also assert it is **unique** and matches
  `[a-z0-9-]{1,32}` (today only presence is checked), so no entry needs migrating and a duplicate fails at load; stores are the 8-hex fingerprint prefix (already printed by
  `describeStore`).
- **Consumer-reported evidence is its own typed entry.** The same alias may appear as measured *and* as
  consumer-reported (two independent pieces of evidence); what is forbidden is **pooling**, and it is forbidden by
  construction: the object has no field that sums across `measured` and `consumerReported`, and the renderer never
  adds a reported claim to a store count. Received `telemetry-export` files (`scanRegistered`) are classified as
  `consumerReported` with `via:'telemetry-export'`: aggregates the consumer chose to send, not measurements CES took.
- **Provenance comes from the query, not from the render.** Each writer passes what it actually read:
  `{fingerprint, scope}`, where `scope` is `store` (the query had no repo predicate — every consumer on that store is
  in the population) or `{repo: alias}` (it filtered to one repo). `resolvePopulation({fingerprint, scope})` then adds
  the not-measured side: in the source repo it runs discovery over `CONSUMER_REPOS` (fingerprints only, no query) and
  lists every consumer outside the read set with its reason; in a consumer, where the registry's private half is
  absent, `notMeasured` is empty and `unknownBeyond` is `true`. A repo-scoped read never claims the other
  consumers that share its store. Never "all".
- **Enforcement — two tests, no new `check` gate** (keeps clear of the concurrent gate edits; see §8):
  - `tests/population-writers.test.mjs` iterates the registry `STORE_VERDICT_WRITERS` (exported by
    `population.mjs`: file + render function + reason) and asserts each writer's rendered verdict, from a fixture
    summary, parses with `parsePopulationLine`. A census assertion reads every `scripts/*.mjs` that imports
    `lib/store/` or `lib/db/` **and** prints `verdict`/`window` text, and fails on one that is neither registered nor
    in the registry's `EXEMPT` list with a reason — the filesystem is the side that sees a writer no list mentions.
  - `tests/research-population-line.test.mjs`: every `docs/research/*.md` either parses a population line, or carries
    `<!-- population: not-store-derived — <reason> -->`, or is in the committed grandfather list
    `tests/fixtures/research-population-grandfathered.json` (today's files, each pinned to the sha256 of its
    EOL-canonical content via `canonicalizeEol`). A grandfathered file whose content changes loses the exemption and
    must carry a line or the marker; a listed file that no longer exists fails (re-baseline). So an old document cannot
    quietly acquire new store-derived claims.
  - **Known limit**: the census sees a writer by its imports and its output vocabulary; a writer printing through a
    helper can evade it. The registry is the contract, the census a backstop — stated, not claimed as proof.
- **Verdict-writer changes**: each registered CLI prints the line on its human path and carries `population` in its
  JSON. `own-model-coverage.mjs check --live` adds `population` to its envelope (exit codes unchanged).

### 2.3 Ship the analysis to the data (Phases 3–4)

**Phase 3 — `own-model-coverage.mjs` joins the sync closure.**
- Declare it in `SYNCED_SCRIPT_ENTRIES` (`scripts/lib/sync-entry-lists.mjs`) and in the relocation list
  (`scripts/lib/sync-isolation-verify.mjs`), and add it to `CLI_SMOKE_SET` (it already implements
  `--selfcheck-relocation`).
- Its config ships: `LAYOUT_CONSTANTS.OWN_MODEL_COVERAGE_SRC = '.own-model-coverage.json'` →
  `OWN_MODEL_COVERAGE_DEST = '.audit-loop/own-model-coverage.json'`, round-tripped by `sourceRelToDestRel` /
  `destRelToSourceRel` exactly like `EXPECTED_SCHEMA_*` (upstream-exclusive: replaced, never merged —
  `isCoOwnedJsonDest` is false by construction because the path is relocated).
- The CLI resolves its three inputs through one **layout-aware** resolver: when it runs from the relocated tooling dir
  (`scripts/.claude-skills/`, root two up) each source path goes through `sourceRelToDestRel`; when it runs from the
  source checkout (`scripts/`, root one up) the source paths are used unchanged. So `--static` and `--live` work in a
  consumer and nothing moves in CES. Both layouts are tested with distinct fixture content. A missing input exits 1 naming the mapped path, never a stack trace.
- **Tier 3 seam — all in the same commit**: (1) `tests/sync-path-map.test.mjs` round-trip for the new constant;
  (2) `tests/own-model-coverage-relocated.test.mjs` runs the **real sync entry** (the same function `sync-to-repos.mjs`
  calls, against a temp git consumer, as the existing sync integration tests do) and asserts the config lands at
  `.audit-loop/own-model-coverage.json`, the CLI at `scripts/.claude-skills/own-model-coverage.mjs`, both are in the
  manifest and owned by the ownership oracle, a second sync with a changed config **replaces** it (upstream-exclusive),
  and the relocated CLI's `check --static` exits 0 from the consumer root; (3) `relocation-guard` / `CLI_SMOKE_SET`
  entry; (4) `npm run bundle:deps` regenerated so the closure carries `lib/telemetry/coverage.mjs` and its imports.

**Phase 4 — `telemetry-export.mjs --report`.** A mode of the existing CLI, not a second pipeline:
- Runs `buildExport` exactly as `--print` does (same reachability probe, drift child, repo-scoped snapshot, strict
  counts, `measured:false` rules, `assertExportClean`). The report groups run **inside that same snapshot**:
  `makeRowReader` gains an optional `extraReads(client)` hook, called inside its `withTx` after the export reads, so
  there is one READ ONLY REPEATABLE READ transaction and one instant. `--print` and delivery never pass the hook, so
  the exported document is byte-identical to today's.
- **Error isolation inside one transaction.** A Postgres error aborts the transaction, so each group runs under its own
  `SAVEPOINT g_<n>` with `SET LOCAL statement_timeout` (caller-side bound); on a group error the reader issues
  `ROLLBACK TO SAVEPOINT g_<n>` and records `{measured:false, reason}` (`reasonForError`: `schema-fault`, `timeout`
  for SQLSTATE `57014`, `read-failed`). A **connection-level** error (the `store-unreachable` codes, or a failed
  `ROLLBACK TO`) ends the remaining groups as `unmeasured (store-unreachable)` without further statements.
- **Side effects, traced.** Report mode performs exactly: (1) the reachability probe — one pool connection to the
  configured store and `SELECT 1` (`doctor/store-reachability.mjs:127`); (2) the drift child — `setup-postgres.mjs
  --check-drift --live --format json`, which reads the store and the local migration files and writes nothing
  (`telemetry-export.mjs:51`); (3) the snapshot transaction. No other child, socket or file write. The CLI test runs
  report mode with `child_process` and `fs` write functions spied: the only spawn is that argv, and there are zero writes.
- **Report groups** (inputs and scope fixed here, not at build time):

  | Group | Scope | Inputs | Denominator / null rule |
  |---|---|---|---|
  | (a) re-raise, reopen, dispute | **store-wide** (every repo in the consumer's own store; repo ids never printed) | `CAPTURE_EPOCHS` (exported by `capture-queries.mjs`, the same constant the capture writer stamps — today `['capture-v1']`) | as in `audit-telemetry-queries.md` §3; denominator 0 → `unmeasured (no-eligible-rows)` |
  | (b) quality per model | store-wide, stratified by pass | same epochs; historical cohort unparameterised | per-model `n`; excluded count printed; cohorts never pooled |
  | (c) agreement, reversal rate | store-wide | same epochs | `presented_resolved` 0 → unmeasured; incomplete reviews counted apart |
  | coverage | store-wide | `.audit-loop/own-model-coverage.json` via Phase 3's resolver; `windowDays` from it | `evaluateEntry`'s statuses unchanged |
  | shadow windows | store-wide | `getTieredShadowObservations` rows + `windowProgress`; final-review shadow only if a store reader exists | `comparedRuns` only (never `totalRuns`); no reader → `unmeasured (no-reader)` |

  The population line for the report is `measured from 1 store — <fp> (consumers not known here); other consumers: not known here` (round-trip tested in the consumer layout).
  - **capture-v1 (a)** re-raise / reopen / dispute rates, each with its denominator, plus the summed `equivalence`
    receipt (they are lower bounds, and the report says so);
  - **(b)** prospective per-`source_model` accepted / dismissed / unresolved with *n*, and the historical one-model
    cohort with its excluded count — never pooled; stratified by pass (repo stratification omitted: it would print repo ids);
  - **(c)** per-run agree / disagree / unknown and the reversal rate with `presented_resolved`, incomplete reviews counted apart;
  - **own-model coverage**: `evaluateEntry` over the synced config (Phase 3) — status per column, fill rate, floor;
  - **shadow windows**: tiered shadow `comparedRuns` against `windowProgress` (store observations), and the
    final-review shadow status where a store reader exists, else `measured:false, reason:'no-reader'`.
- **One SQL oracle.** The recipes move into `scripts/lib/telemetry/capture-queries.mjs` as CTE bodies with `$1` for the
  epoch set (no temp views, so a READ ONLY transaction accepts them). `tests/audit-capture-db.test.mjs` changes to assert
  each doc block equals the module text (`$1` ↔ `:epochs`, `CREATE TEMP VIEW x AS <body>;` ↔ the CTE body) **and** to run
  the module's composed queries on its real Postgres — the doc stays readable, the code is the source, and the two
  cannot drift.
- **Model ids** pass a closed charset (`[a-z0-9][a-z0-9._/-]{0,63}`) and the redaction scan; one that fails maps to
  `other` and increments `redactions` (the builder's `toEnum` rule), never aborts the report and never prints raw.
- **Output** is human-readable text on stdout (counts, rates, verdicts, one population line naming this one store),
  ending `Nothing was written or sent.` It writes no file, opens no network path other than the store, and is
  mutually exclusive with `--print`, `--push`, `--drop-dir` and `--if-older-than`. Exit 0 when built (even with
  unmeasured groups), 1 refused/failed, 2 usage. An unreadable group renders `unmeasured (<reason>)`, never `0`.

### 2.4 `upstream report --export` (Phase 5)

- `cross-skill.mjs upstream report --export --slug <slug> --title … --severity … --affected-path …`, body on **stdin**
  (an argv `--body` is refused with `--export`: a backtick in argv runs as command substitution — AGENTS.md).
- **Two representations, stated.** The report filed into the consumer's own store keeps the operator's original
  (gently redacted) text — it never leaves the organisation. The **export** is a separate rendering with identity
  strings replaced by the slug. The slug is validated first (`[a-z0-9-]{1,32}`, and not itself one of the identity strings).
- **Order, each step idempotent:** (1) validate (`validateReportInput`) and gentle redact (`redactReport`); (2) render
  the export Markdown, substituting the consumer's own identity strings (remote `owner/repo` first, then repo basename and
  `package.json` name) as **literal, regex-escaped, token-bounded** matches — case-insensitive, but never inside a larger
  identifier or path segment (`[A-Za-z0-9_.-]` on neither side); an identity shorter than 4 characters cannot be
  substituted safely, so its presence refuses the export with `identity-too-short` and asks the operator to edit; (3) **fail-closed scan of the final rendered bytes** — a hit refuses with the
  category list and nothing is filed, written or printed; (4) write `.audit/upstream-exports/<fingerprint>-<sha256:16>.md` with
  `atomicWriteFileSync` (gitignored; immutable per content: same bytes on a retry → same file, a changed rendering →
  a new file, never an overwrite); (5) record `{schema, exportedAt, slug, fingerprint, sha256, path, filed:null}` in its **own** file beside the Markdown
  (`<same stem>.json`): no shared map, so two concurrent exports cannot lose each other's record; created exclusively
  (`wx`), and a retry of the same content finds it and updates only its own file;
  (6) file the report the usual way (fingerprint upsert, so a retry is a no-op), then update the entry's `filed` to
  `{cloud, id|null, spooled}`. A failure at step 4–6 is reported with the step that failed and what already exists
  (`exportPath` present, record present, filed or not); re-running the same command completes the remaining steps.
- **Fail-closed scan, and what it is not.** `redact.mjs` exports `scanForLeaks(text, {prose:true})` — the same `SHAPES`
  + `scanForSecrets` + `classifyPath` oracle the exporter uses. `prose` exempts a hostname-shaped token **only** when it
  has path context (it is, or ends, a `/`-separated segment such as `lib/foo.mjs` or `scripts/.claude-skills/x.mjs`)
  **and** its last label is a source extension from `file-taxonomy.mjs`. A bare `foo.mjs` or `build.sh` with no slash
  is refused as ambiguous: the operator rewrites it as a path or removes it. The scan is a **screening aid** for known
  shapes; it cannot prove prose free of confidential meaning, which is why the human reads the file before pasting (the
  warning below) and why nothing is ever sent automatically.
- **The warning** goes to stderr every time, before the path: `CES is a PUBLIC repository: whatever you paste there is
  public. Read the file before you paste it.` The envelope carries `exportPath` and `public: true`.
- New module `scripts/lib/upstream/export.mjs` (render + identity substitution + record); `quality.mjs` gains the branch.

### 2.5 Later phase — planned, not built: `upstream match-issue`

Match a pasted GitHub issue back to the local export record so an upstream fix closes it consumer-side. It needs a
**new network path on the consumer** (reading GitHub), which this plan's constraint forbids adding silently. Named
`match-issue`, not `reconcile` (§0). Recorded as a follow-up; the export record's `fingerprint` + `sha256` are its key.

## 3. Alternatives and right-sizing

- **Band-aid**: a hand-maintained list of "private consumers" in CES. Rejected: it is a second registry that goes stale,
  and the declaration belongs to the consumer that owns the policy.
- **Over-built**: a generic "evidence provenance" schema on every store row, or a second report pipeline with its own
  schema. Rejected: no current requirement reads per-row provenance; the brief requires reusing the exporter.
- **Chosen**: one optional boolean in an existing committed file, one pure population module with a registry + census
  test, one CLI mode, one new upstream module. Each is the smallest thing that is a true function of the problem.
- **A new `npm run` gate** for the population line was considered and deferred to tests: same enforcement at push
  (`npm test` runs in the branch tier) without editing the `check` chain that a concurrent session is changing.

## 7. File-level plan

| File | Change | Why |
|---|---|---|
| `scripts/lib/doctor/store-reachability.mjs` | modify | `upstreamReachable` in the pointer schema; doctor line |
| `scripts/lib/upstream/store-discovery.mjs` | modify | `policyUnreachable`, injected `readSetupPointer`, fail-closed |
| `scripts/upstream-queues.mjs`, `scripts/store-drift.mjs` | modify | carry + render policy line; population line |
| `scripts/lib/population.mjs` | create | the one population producer + writer registry |
| `scripts/tiered-shadow-report.mjs`, `scripts/bakeoff-collect.mjs`, `scripts/model-eval-adjudicator.mjs`, `scripts/own-model-coverage.mjs` | modify | print/carry the population line |
| `scripts/lib/sync-entry-lists.mjs`, `scripts/lib/sync-isolation-verify.mjs`, `scripts/lib/sync-path-map.mjs` | modify | ship `own-model-coverage.mjs` and its config |
| `scripts/lib/telemetry/capture-queries.mjs` | create | capture-v1 SQL as code |
| `scripts/lib/telemetry-export/report.mjs` | create | report groups + renderer over the builder |
| `scripts/telemetry-export.mjs` | modify | `--report` mode |
| `scripts/lib/telemetry-export/redact.mjs` | modify | export `scanForLeaks` with the prose exemption |
| `scripts/lib/upstream/export.mjs` | create | Markdown render, identity substitution, local record |
| `scripts/lib/cross-skill/commands/quality.mjs` | modify | `--export` branch |
| `docs/runbooks/consumer-adoption.md`, `docs/reference/consumer-repo-layout.md`, `docs/reference/audit-telemetry-queries.md` | modify | operator docs; doc pinned to code |

### 7b. Implementation Phases

**Phase 1 — Declared policy-private consumers in the fan-out**: pointer schema, discovery's third list, both readers'
render + JSON, doctor line. Files: `scripts/lib/doctor/store-reachability.mjs` (modify),
`scripts/lib/upstream/store-discovery.mjs` (modify), `scripts/upstream-queues.mjs` (modify), `scripts/store-drift.mjs`
(modify), `tests/upstream-store-discovery.test.mjs` (modify), `tests/store-drift.test.mjs` (modify),
`tests/store-reachability-policy.test.mjs` (create), `docs/runbooks/consumer-adoption.md` (modify).

**Phase 2 — The population line and its enforcement**: the module, the shared leak scanner it validates claims with
(`scanForLeaks`, §2.4 — introduced here so Phase 5 only consumes it; Tier 3 egress tests in the same commit), the four
writers, the two tests, the grandfather list. Files: `scripts/lib/telemetry-export/redact.mjs` (modify),
`tests/telemetry-export-redact-prose.test.mjs` (create), `scripts/lib/consumer-repos.mjs` (modify), `scripts/lib/population.mjs` (create), `scripts/tiered-shadow-report.mjs` (modify), `scripts/bakeoff-collect.mjs`
(modify), `scripts/model-eval-adjudicator.mjs` (modify), `scripts/own-model-coverage.mjs` (modify),
`scripts/upstream-queues.mjs` (modify), `scripts/store-drift.mjs` (modify), `tests/population.test.mjs` (create),
`tests/population-writers.test.mjs` (create), `tests/research-population-line.test.mjs` (create),
`tests/fixtures/research-population-grandfathered.json` (create), `docs/reference/consumer-repo-layout.md` (modify).

**Phase 3 — Sync `own-model-coverage.mjs` and its config**: closure entry, relocation entry, layout constant, path-map
resolution in the CLI, relocation test in the same commit. Files: `scripts/lib/sync-entry-lists.mjs` (modify),
`scripts/lib/sync-isolation-verify.mjs` (modify), `scripts/lib/sync-path-map.mjs` (modify),
`scripts/own-model-coverage.mjs` (modify), `tests/sync-path-map.test.mjs` (modify),
`tests/own-model-coverage-relocated.test.mjs` (create).

**Phase 4 — `telemetry-export.mjs --report`**: capture queries module, report groups, renderer, CLI mode, doc pinned
to code. Files: `scripts/lib/telemetry/capture-queries.mjs` (create), `scripts/lib/telemetry-export/report.mjs`
(create), `scripts/telemetry-export.mjs` (modify), `scripts/lib/telemetry-export/sources.mjs` (modify),
`tests/telemetry-report.test.mjs` (create), `tests/audit-capture-db.test.mjs` (modify),
`docs/reference/audit-telemetry-queries.md` (modify).

**Phase 5 — `upstream report --export`**: export module (consuming Phase 2's scanner), dispatch branch, docs. Tier 3
(sensitive-path egress): the export CLI's refusal tests land in the same commit. Files: `scripts/lib/upstream/export.mjs` (create),
`scripts/lib/cross-skill/commands/quality.mjs` (modify), `tests/upstream-export.test.mjs` (create),
`docs/runbooks/consumer-adoption.md` (modify).

**Close-out (not a phase)**: `npm run skills:regenerate` if any SKILL.md changed (none planned), `npm run bundle:deps`
(new synced module edges), `npm run guards:preflight`, `npm test` (branch tier) before each handover.

## 8. Risks and trade-offs

- **Fail-closed on a malformed declaration** hides a consumer that *meant* to be reachable. Accepted: the reason
  `policy-undeterminable` is printed, so it is visible and fixable; the opposite error leaks.
- **The census test is a heuristic** (imports a store module + prints verdict text). It can miss a writer that prints
  through a helper, and over-match a store CLI that is not a verdict. The `EXEMPT` list with reasons absorbs the second;
  the registry is the contract for the first. Stated, not hidden.
- **Grandfathered research docs** stay without a line. Retro-fitting 39 documents is not this plan's work; new ones cannot skip it.
- **Report query cost** on a large consumer store: the (a) concern view is per-finding with a correlated subquery. One
  statement timeout (`SET LOCAL statement_timeout` at the caller, AGENTS.md "bound an RPC at the CALLER"), and a
  timed-out group is `unmeasured (timeout)`.
- **Concurrent work.** `ces-verification-lessons` is changing gates, audit prompts, the structural card and AGENTS.md.
  This plan edits **none** of those (no `package.json` `check` chain edit, no AGENTS.md edit, no prompt edit). If an
  AGENTS.md tripwire is wanted later it is one line, coordinated through the CES coordinator first.
- **Stacked PRs**: Phase 3–4 (PR 2) builds on PR 1's `population.mjs`; PR 3 also stacks on PR 1 (it consumes `scanForLeaks`).
  Merging PR 1 with `--delete-branch` would close PR 2 — retarget first (memory: stacked-PR rule).
- **Deferred**: `upstream match-issue` (§2.5); a population line on `concern-telemetry-report` / `memory-health`
  (consumer-side, single-store, not cross-store verdicts — they get it when they make cross-store claims).

## 9. Testing strategy and proof plan

| Behaviour | Oracle | Pass condition | Negative control |
|---|---|---|---|
| Declared consumer is never queried | `discoverStores` with an injected pointer `{upstreamReachable:false}` and a resolvable DSN; spy on `readEnvText` | consumer in `policyUnreachable`, absent from `stores`; the query spy is never called for its fingerprint | same fixture without the key → queried as today |
| Malformed declaration fails closed | pointer `{upstreamReachable:"no"}` / unreadable | `policy-undeterminable`, not queried | valid `true` → queried |
| Never counted as empty | `collectQueues` with 0 eligible stores + 1 policy consumer | renders "NOTHING WAS CHECKED" and the policy line; `storesQueried === 0` | 1 answered store → "0 open across 1" + policy line |
| Shared-store consumers unchanged | existing `upstream-store-discovery` / `store-drift` suites | byte-identical output when no pointer is injected | — |
| Population grammar | `renderPopulationLine` ∘ `parsePopulationLine` round-trip | identity on fixtures, including an alias present in both `measured` and `consumerReported` | a reported claim never changes a store count |
| Every writer emits the line | `population-writers.test.mjs` | each registry entry's render parses | remove the line from one writer → test fails (red-then-green recorded in the PR) |
| Research docs carry it | `research-population-line.test.mjs` | all pass | a temp doc without a line or marker → fails |
| Relocated coverage CLI works | spawn the copy under a temp `scripts/.claude-skills/` layout with the mapped config | `check --static` exit 0; config read from `.audit-loop/` | config absent → exit 1 naming the mapped path, not a crash |
| Report never fakes a zero | `buildReport` with a reader throwing `42P01` for one group | that group `unmeasured (schema-fault)`, others measured | all readers ok → numbers |
| Report SQL is the doc SQL | `audit-capture-db.test.mjs` | each doc block equals module text, and module queries run on the real Postgres inside `READ ONLY` | flip one character in the doc → fails |
| Report writes/sends nothing | spy fs writes + child spawns in report mode | only the store read and the drift child | — |
| Export refuses leaks | `scanForLeaks` over bodies with a hostname, DSN, IP, email, `C:\` path, `db.internal.mjs`-style host ending in an extension with no path context | each refused with its category; nothing filed or written | `scripts/.claude-skills/lib/foo.mjs` and plain prose pass |
| Export retries are idempotent | fail the store filing once, re-run | one `.md`, one record entry, `filed` set on the retry | changed body under the same fingerprint → a second file and entry, the first still matches its hash |
| Private store shared with a reachable consumer | discovery fixture: private consumer DSN = wine's DSN | that store refused as `shared-with-policy-consumer`; nothing queried | different DSNs → wine queried |
| Missing pointer reader | `discoverStores` without `readSetupPointer` | throws | — |
| Report group error does not poison the snapshot | real Postgres: drop a view a group reads, run report | that group `unmeasured (schema-fault)`, later groups measured (savepoint) | — |
| Report numbers are right | seeded multi-repo fixture in `audit-capture-db.test.mjs` | each rate equals the hand-computed value | empty cohort → `unmeasured (no-eligible-rows)` |
| Identity substitution is bounded | basename `orgx` inside `orgxtools` and `lib/orgx-helpers.mjs`; a 3-char basename | untouched / untouched / refused `identity-too-short` | standalone `orgx` → slug |
| Concurrent exports | two exports of different reports in parallel | both records present | — |
| Population fields bounded | `buildPopulation` with a 201-char claim, a `;` in a claim, an alias with `_` | each refused | valid input renders and round-trips |
| Grandfathered doc edited | change one grandfathered file's content in a temp copy | test fails until a line or marker is added | unchanged file passes |
| Export substitutes identity | body naming the remote `owner/repo` and basename | replaced by the slug | slug-free body unchanged |
| Body never from argv | `--export --body x` | usage error | stdin body accepted |
| Public warning + local record | run export in a temp repo | stderr carries the PUBLIC line; a `.audit/upstream-exports/*.json` record appears with no content | refused export → no record |

## 11. Execution Clustering

- **Cluster A** — Phases 1–2 — fix-gate: yes
  - Coupling: the population line renders discovery's `policyUnreachable`; both readers change in both phases. Own branch + PR 1.
- **Cluster B** — Phases 3–4 — fix-gate: yes
  - Coupling: the report's coverage group reads the config Phase 3 ships, through the same path-map resolution. Own branch + PR 2, stacked on PR 1.
- **Cluster C** — Phase 5 — fix-gate: final
  - Coupling: consumes Phase 2's `scanForLeaks`; independent of B. Own branch + PR 3, stacked on PR 1.
- **Final gate**: a FULL-coverage final review on each cluster's exact head (each cluster ships as its own PR), re-run per file group if coverage reads PARTIAL.

## Audit trail

- **/audit-plan** (SID `audit-plan-1795278439725-75304`, 2026-11-21): R1 H8 M2 → R2 H3 M1 → R3 H2 M2; acceptance 10/10,
  4/4, 4/4 (one severity-adjusted: the alias field already existed). **Stopped at the 3-round cap while productive**,
  not by convergence: the structural card read 0 structural / 18 polish clusters, so the remaining character is
  implementation-completeness, which the code audit checks against real code.
- **Final gate**: Gemini (`gemini-4-argon`) round 1 — APPROVE, gate `approve`, 0 blocking, 0 debt.
- **Cluster A code audit** (SID `audit-code-1795280359734-63820`): 6 GPT rounds (the cap) — H16→7→5→6→5→4; each
  later round's findings were narrower edge cases of the privacy and leak rules, all fixed or dismissed with reasons in
  the ledger. Final gate: Gemini `--batch`, 5 groups, `approve_with_debt`. G1 (MEDIUM: a refused shared store lost the
  `self` label) fixed with a red-then-green test. **Debt G2 (LOW)**: a repo-scoped read (`{repo:'self'}` /
  `{repos:[...]}`) always renders `unknownBeyond`, even in the source repo where the registry could name the
  store-mates it did not read — honest but less informative; revisit if a repo-scoped verdict needs the not-measured side.
- **Cluster B code audit** (SID in `.audit/policy-b-sid`): R1 H6 M9 L1 → R2 H1 M4 L2 → R3 H1 M2 (two defects, both fixed
  with red-then-green tests). Stopped at R3, the step-back point: nothing structural remained. Decisions recorded:
  `converged` for (c) is `round_converged_after IS NOT NULL` (no per-run H/M column exists); the reopen-rate denominator
  now counts each concern once, at its earliest non-final dismissal (a correction to the committed recipe); model ids
  print only when they are a known public id, else `<family>:other`, because this consumer's Azure deployment names
  can be private.
