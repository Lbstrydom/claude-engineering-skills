# Plan: Enforce the debt ledger's persisted-record contract (§2 of aged-out-acceptance-remainder.md)

- **Date**: 2026-09-15
- **Status**: Approved — GPT plan audit converged after 3 rounds (9→3→2
  findings, 100% acceptance throughout); Gemini final gate APPROVE after
  3 rounds (round 1: 4 findings incl. a real receipt-contract bug in this
  plan's own text; round 2: 4 findings, mostly §6 table drift from already-
  corrected prose plus a genuine embedding data-flow gap; round 3: 0
  findings). Implementation in progress.
  **Implementation-time correction 1 (found by running the pre-existing
  `tests/debt-ledger.test.mjs` suite, not by review):** §2 Fix A's
  `normalizeClassificationEnvelope` call was specified as living in the
  `persistDebtEntries` facade. `debt-auto-capture.mjs` (the primary capture
  path) calls `writeDebtEntries` **directly**, bypassing that facade —
  normalizing only there would have made the classification-or-reason
  contract silently start rejecting every entry captured through the actual
  production path (9 existing tests failed the moment the schema change
  landed, exposing this before it shipped). `debt-backfill.mjs --promote`
  was NOT affected the same way — it already calls `persistDebtEntries`, not
  `writeDebtEntries`, directly. The call moved to the real write boundaries
  regardless: `writeDebtEntries` (`debt-ledger.mjs`) and `upsertDebtEntries`
  (`store/debt.mjs`) each normalize internally, idempotently, so every
  caller is covered regardless of which facade it goes through — the
  single-oracle shape this repo already prefers elsewhere.

  **Implementation-time correction 2 (round-1 code-audit M12 — the review
  that named the Correction 1 text above as internally inconsistent with the
  diagram in turn surfaced a second, more consequential gap while verifying
  it):** `debt-auto-capture.mjs` calling `writeDebtEntries` +
  a separate `durableWrite` directly wasn't just a normalization gap — it
  meant this file, the PRIMARY real-world capture path (Step 3.6 of every
  audit round), never went through `persistDebtEntries`/
  `enrichDebtEntriesWithAliases` **at all**. Fix C's content-aliasing would
  have been functionally dead on the exact path it exists for, only ever
  firing for `debt-backfill.mjs --promote`'s rare historical imports.
  `debt-auto-capture.mjs`'s `main()` now calls `persistDebtEntries` for both
  the local and cloud write, matching `debt-backfill.mjs`'s existing shape —
  a genuine functional fix, not only a documentation one. §2 and §6 below
  reflect the corrected architecture.

  **Code-audit convergence (12 rounds, SID `audit-code-1789432147`):** GPT
  R1 (24 findings) established the baseline contract; R2–R4 (4, 3, 3
  findings) each fixed a genuine bug introduced by the PRIOR round's own fix
  to `scripts/lib/debt-alias.mjs` (a shared-mutable-state race in the
  per-entry timeout, an asymmetric alias-length guard, a supersession
  exclusion that reached the DB query but not the in-batch match loop); R5–R6
  (2, 2 findings) extended the same pattern — a re-captured topic superseded
  by an earlier write carried no `supersededBy` in its own DTO (R5 H1), then
  R6 found the R5 fix's own preflight query was unbounded and its failure
  path silently degraded to "assume nothing superseded" (fixed by racing the
  query against the batch's budget and failing CLOSED for in-batch matching
  specifically, never the whole batch). R7–R8 converged clean (PASS, 0
  findings, 2 stable rounds) — GPT-side convergence reached at round 8.
  **Gemini final gate ran twice** (mandatory regardless of convergence):
  round 1 found two more genuine HIGH bugs neither GPT nor 11 prior code-audit
  rounds had caught — G1: `pg` has no built-in type parser for pgvector's
  custom `vector` type, so a real Postgres cache hit in
  `populateContentAliases` returned the embedding column as a text literal,
  not a `number[]`, silently breaking `cosineSimilarity` (fixed by promoting
  the pre-existing `parseVectorLiteral` from `store/security.mjs` — where the
  identical class was already root-caused once — into the shared
  `semantic-suppression.mjs`); G2: every round-4/5/6 fix excluded a
  superseded *candidate* from being matched to, but nothing excluded a
  superseded *entry* from being the match source, so a superseded batch-mate
  processed after a live one could still pollute the live topic's own
  `contentAliases` via the reciprocal update (fixed with one guard at the top
  of `processEntry`, which also made the now-redundant candidate-side checks
  provably unreachable — removed). Round 2 confirmed both fixes ("mathematically
  and functionally sound") and found one further MEDIUM (a test's `after()`
  hook skipped `closePool()` on a failed cleanup query — fixed to match the
  try/finally shape already used in `store-debt-cloud-validation.test.mjs`).
  **One Gemini claim was dismissed, not fixed, across all three times it was
  raised** (round-1 human triage, Gemini gate round 1, Gemini gate round 2):
  "the secret-redaction test uses an already-redacted fixture, not a raw
  secret" — verified false each time against the actual file
  (`tests/debt-alias.test.mjs`'s `detailSnapshot` is the raw
  `'AKIAABCDEFGHIJKLMNOP...'` string, never a `[REDACTED:...]` marker); a
  reviewer claim that fails direct verification three times in a row is
  correctly overruled, not chased into a third paid Gemini round for a
  claim already refuted twice. Every fix across all 12 rounds was verified
  with a mocked-pool unit test and, for DB-dependent behaviour, a fresh
  disposable Postgres container (`npm run db:suites:gate` re-run clean after
  rounds 1, 4, 6, and the Gemini-gate fixes).
- **Author**: Claude + Louis
- **Scope**: backend (`stack: js-ts`) — Zod schemas, the local + cloud debt-ledger
  write paths, one Postgres migration, one CLI. No UI.
- **Target domain(s)**: `shared-lib`, `stores`, `supabase`, `tech-debt`
  (`compute-target-domains`, 2026-09-15) — ⚠ cross-domain: the three fixes
  below share one write boundary (`persistDebtEntries`) on purpose (see §Proposed
  Architecture), so the crossing is intentional, not incidental.
- **Neighbourhood considered**: `get-neighbourhood` against
  `buildDebtEntry`/`upsertDebtEntries`/`schemas.mjs` returned 8 candidates, all
  band `review` (below this repo's noise floor) — every one is a function this
  plan *extends in place* (`buildDebtEntry`, `upsertDebtEntries`,
  `PersistedDebtEntrySchema`), so the similarity is expected, not duplication to
  resolve.
- **Supersedes**: closes §2 of `docs/plans/aged-out-acceptance-remainder.md`
  (findings `75981b9b` HIGH, `dd651e36` HIGH, `92fe5776` MEDIUM). §3 and §4 of
  that document are already shipped and out of scope here.

---

## 1. Context Summary

### What exists today (Code Trace, pinned to `704fa057`)

- `PersistedDebtEntrySchema` (`scripts/lib/schemas.mjs:1204`) is the *local*
  write-path contract: `DebtEntryPersistedFields` (`schemas.mjs:1152`) +
  `enforceDeferredReasonRequiredFields` (`schemas.mjs:1181`), a `superRefine`
  requiring per-reason fields (`blockedBy`, `followupPr`, …). `classification`
  (`schemas.mjs:1067`, inherited from `LedgerCoreFields`) is
  `ClassificationSchema.nullable().optional()` — the four sub-fields are
  all-or-nothing *when the object is present*, but nothing requires the object
  to be present at all. `contentAliases` (`schemas.mjs:1176`) is
  `z.array(z.string().max(12)).max(20).default([])` — a real, validated field
  with zero producers.
- `writeDebtEntries` (`scripts/lib/debt-ledger.mjs:272`) is the **only** call
  site that runs an entry through `PersistedDebtEntrySchema.safeParse`
  (line 316) before it reaches `.audit/tech-debt.json`. Non-conforming entries
  land in a structured `rejected[]` array the caller must inspect.
- `upsertDebtEntries` (`scripts/lib/store/debt.mjs:26`) is the **cloud**
  write path (`debt_entries` table). It runs **no Zod validation at all** — it
  maps `e.classification?.sonarType ?? null` etc. straight into a row object
  (lines 40-43) and lets Postgres's per-column `CHECK` constraints
  (`supabase/migrations/20260405092206_add_debt_memory.sql:26-28`) be the only
  gate. Those constraints check each of `sonar_type`/`effort`/`source_kind`
  independently (`IS NULL OR IN (...)`), so they cannot see the envelope
  invariant Zod enforces (all four sub-fields together) — a row with
  `sonar_type` set and `effort` NULL is DB-legal but schema-illegal. They also
  don't enforce `deferredRationale`'s 4000-char cap or `contentAliases`'
  max-20/max-12-char shape at all (the DB column has no such CHECK).
- `buildDebtEntry` (`scripts/lib/debt-capture.mjs:84-158`) is the entry
  constructor used by the audit orchestrator's Step 3.6 (via
  `scripts/debt-auto-capture.mjs:212`). It sets `classification:
  finding.classification || null` (line 131, no fallback) and
  `contentAliases: []` (line 136, hardcoded, no producer ever populates it).
  `scripts/debt-backfill.mjs`'s `--promote` path constructs
  `PersistedDebtEntry`-shaped records directly from
  `scripts/lib/backfill-parser.mjs` (never sets `classification` at all) and
  writes them via the same `writeDebtEntries`/`persistDebtEntries` path — so
  **two different constructors** feed the one write boundary, and neither
  populates the fields §2 is about.
- `persistDebtEntries` (`scripts/lib/debt-memory.mjs:230-275`) is the single
  facade both callers should route through: it writes local first
  (`writeDebtEntries`, line 246) then mirrors to cloud via the durable-write
  seam (`durableWrite('debt.entries', …)`, line 271 → `upsertDebtEntries`,
  registered in `scripts/lib/audit-store-writers.mjs:287-296`). It already
  holds `context.repoId` when cloud is active — the one place both the local
  and cloud writes can be enriched identically before either happens.
- The repo already has a **proven, promoted pattern** for exactly this class
  of problem, one table over: `finding_embeddings`
  (`supabase/migrations/20260721120000_finding_embeddings_prototype.sql`) +
  `partitionRecordTimeReRaises`/`nearestOpenReRaise`
  (`scripts/lib/semantic-suppression.mjs:380`, `:3xx`) — cosine similarity over
  `VECTOR(768)` via `embedText()` (`scripts/lib/embed-text.mjs:168`), fail-open
  on every error, logged, never blocking the write it augments. AGENTS.md's
  "pgvector promoted" section and §2's own text both say to reuse this rather
  than invent a second mechanism.
- `scripts/debt-review.mjs`'s `--ttl-days` / `findStaleEntries`
  (`scripts/lib/debt-review-helpers.mjs`) already flags entries by **age**
  (`deferredAt` vs a global TTL). That is a different signal from what
  `92fe5776` asks for — a **per-entry** revalidation trigger an entry declares
  for itself (e.g. "blocked-by X, revisit in 90 days") — so the fix below is
  additive to `--ttl-days`, not a replacement.

### Known constraint from the parent document (§2, "Not attempted here")

A classification **backfill** across the 181 already-unclassified entries is
explicitly out of scope (a per-entry judgement call, not a migration), and a
full semantic-clustering **redesign** for aliasing is explicitly out of scope
(a bigger design decision than a queue-clearing session). This plan does
**not** attempt either. It closes the *contract* so every entry captured
**from now on** is unambiguous about classification, gets a best-effort alias
lookup, and can carry a revalidation trigger — leaving the 181/222 historical
rows exactly as they are, an accepted and now-explicit backlog.

---

## 2. Proposed Architecture

```mermaid
flowchart TD
    subgraph Capture
        BDE[buildDebtEntry] --> DAC[debt-auto-capture.mjs main]
        BF[debt-backfill.mjs --promote]
    end
    DAC --> PDE
    BF --> PDE[persistDebtEntries]
    subgraph "persistDebtEntries (scripts/lib/debt-memory.mjs) — the ONE shared write facade"
        PDE --> ALIAS["populateContentAliases via\nenrichDebtEntriesWithAliases\n(store/debt.mjs, NEW, fail-open,\ncloud-only, best-effort)"]
        ALIAS --> LOCAL["writeDebtEntries → .audit/tech-debt.json"]
        ALIAS --> CLOUD["durableWrite('debt.entries') → upsertDebtEntries"]
    end
    subgraph "The actual write boundaries — normalization lives HERE, not in persistDebtEntries"
        LOCAL --> NORMLOCAL["normalizeClassificationEnvelope\n+ safeParse (debt-ledger.mjs)"]
        CLOUD --> NORMCLOUD["normalizeClassificationEnvelope\n+ safeParse (store/debt.mjs, NEW —\ncloses the cloud/local validation gap)"]
        NORMCLOUD --> ROWS[debt_entries UPSERT]
        ALIAS -.embedding for THIS entry.-> EMB[(debt_embeddings, NEW table)]
        ALIAS -.cosine query against.-> EMB
    end
    NORMLOCAL --> LEDGER[(.audit/tech-debt.json)]
    ROWS --> DBTBL[(debt_entries)]
```

**Both capture paths now go through `persistDebtEntries`.** An earlier draft
of this diagram (and the implementation, until this plan's own code audit
caught it) had `debt-auto-capture.mjs` — the PRIMARY, real-world capture path,
invoked every audit round — call `writeDebtEntries` and `durableWrite`
separately, bypassing this facade entirely. That would have made Fix C's
content-aliasing functionally dead on the exact path it was built for: only
`debt-backfill.mjs --promote` (a rare, one-off historical import) would ever
have exercised it. `debt-auto-capture.mjs`'s `main()` now calls
`persistDebtEntries` directly, matching `debt-backfill.mjs`'s existing call
shape — see the File-Level Plan and the round-1 code-audit note under Status
above.

Three fixes, one shared write boundary (`persistDebtEntries`), each closing
one finding:

### Fix A — classification is either present or explicitly declared absent (`dd651e36`)

**Right-sizing (band-aid / over-built / chosen):**
- *Band-aid*: make `classification` a required field on `PersistedDebtEntrySchema`.
  Rejected — it would immediately break `debt-backfill.mjs` (never sets
  classification) and silently turn "we don't have this yet" into a write
  failure for every legacy-shaped caller, which is a regression, not a fix.
- *Over-built*: a classifier service that infers `sonarType`/`effort` from
  `category`/`detail` text when the caller omits it. Rejected — that is the
  181-entry judgement call §2 explicitly defers; inferring it mechanically
  would fabricate classifications with no reviewer behind them.
- *Chosen*: require the **disjunction** *classification present* OR
  *classification explicitly declared unavailable* — normalized at the one
  write boundary, so no caller has to opt in.

**Implementation:**
- `schemas.mjs`: add `classificationUnavailableReason: z.string().trim().min(1).max(200).optional()`
  to `DebtEntryPersistedFields` — `min(1)` **after** `trim()` so an empty or
  whitespace-only string cannot satisfy the disjunction below (round-1 GPT
  audit M3: a bare `max(200)` let a blank string count as an explicit
  explanation). Extend the existing `superRefine` (or add a sibling composed
  the same way `enforceDeferredReasonRequiredFields` is) to raise an issue on
  `path: ['classification']` when **both** `classification` and
  `classificationUnavailableReason` are absent.
- `schemas.mjs`: export a new pure helper `normalizeClassificationEnvelope(entry)`
  — returns `entry` unchanged if `classification` is present OR
  `classificationUnavailableReason` is a non-blank string
  (`.trim().length > 0`), else returns `{ ...entry, classificationUnavailableReason:
  'not-provided-by-capture-source' }`. The blank check is the normalizer's own
  half of M3 — the schema rejects a blank value that reaches validation, the
  normalizer must not itself treat a blank value as "already set" and skip
  injecting the real default. Pure, no I/O, colocated with the schema it
  defends (mirrors `enforceDeferredReasonRequiredFields` being in the same
  file as what it guards).
- **Normalization lives at the actual write boundaries, not a facade
  (implementation-time correction — found by running the pre-existing
  `tests/debt-ledger.test.mjs` suite):** the first draft called
  `normalizeClassificationEnvelope` inside `debt-memory.mjs`'s
  `persistDebtEntries` only. But `debt-auto-capture.mjs` (the primary capture
  path) and `debt-backfill.mjs --promote` both call `writeDebtEntries`
  **directly**, bypassing that facade — normalizing only there would make the
  classification-or-reason contract silently reject every entry captured
  through actual production use (9 existing tests failed the moment the
  schema change landed alone, exposing this immediately). Instead:
  `writeDebtEntries` (`debt-ledger.mjs`) and `upsertDebtEntries`
  (`store/debt.mjs`) each call `normalizeClassificationEnvelope` internally,
  idempotently, right before `safeParse` — the single-oracle shape this repo
  already prefers (every caller covered regardless of which facade it
  reaches the write through), rather than trusting each caller to route
  through one blessed entry point.
- **Cloud round-trip (round-1 GPT audit H1 — HIGH):** the migration and
  `upsertDebtEntries`/`readDebtEntriesCloud` mappings must cover
  `classificationUnavailableReason`, not just `reviewDeadline`/`supersededBy`.
  Without a `classification_unavailable_reason` column, an entry that
  satisfies the local disjunction (schema-valid, either field present) loses
  the field entirely on the cloud round trip — a cloud read then reconstructs
  an entry with **neither** field set, silently breaking the very contract
  Fix A exists to guarantee. Added to the Fix C migration (§File-Level Plan)
  and to both mapping directions in `store/debt.mjs`.

This makes the *existing* envelope invariant in `ClassificationSchema` (all
four sub-fields required together) actually mean something at the persisted-entry
level: from this change forward, every entry either carries a complete
classification or an explicit, greppable reason it doesn't. The 181 historical
rows are untouched — `readDebtLedger` never re-validates on read (confirmed:
it hydrates raw JSON without calling `.parse`/`.safeParse`), so this is
forward-only by construction, not a retroactive break.

### Fix B — the cloud write path enforces the same contract as the local one (`75981b9b`, part 1)

**Implementation:**
- `store/debt.mjs`'s `upsertDebtEntries`: run
  `PersistedDebtEntrySchema.safeParse(entry)` per entry (after normalization)
  before building the row for `upsert('debt_entries', …)`. On failure, exclude
  that entry from the batch and return a structured
  `{ ok: true, rejected: [{topicId, reason}], appliedCount, … }` (mirrors
  `writeDebtEntries`'s `rejected[]` shape) rather than letting Postgres's
  `CHECK` constraints be the only backstop — those constraints stay as-is
  (defense in depth), but the message quality and the envelope-invariant
  coverage now match the local path exactly.
- **Partial-failure contract (round-1 GPT audit H3 — HIGH):** a schema
  rejection is a **permanent** defect (the entry is malformed, not
  temporarily unreachable) and must be classified distinctly from a
  transient/connection failure, because `durableWrite`'s spill queue retries
  the latter but retrying a schema-invalid row forever accomplishes nothing.
  Concretely: `upsertDebtEntries` returns `ok: true` (the CALL succeeded)
  with `rejected: [...]` and `appliedCount` populated whenever *any* row
  failed `safeParse` — never `ok: false` for a schema rejection, which is
  reserved for the upsert itself throwing (a real DB/connection error).
  **`applied` and `declined` are mutually exclusive on the writer's receipt
  (Gemini gate round 1 G1 — HIGH, corrects the draft above):** the original
  wording here proposed `{ applied: true, declined: true, … }`, but
  `durableWrite` (`durable-write.mjs`) checks `res.applied === true` **before**
  `res.declined` in every branch — a receipt asserting both would report
  `outcome: 'written'`, silently discarding the rejection signal it was meant
  to carry (verified by reading `durable-write.mjs`'s branch order directly;
  the specific mechanism Gemini cited — the shared `receipt()`/
  `DECLINED_REASONS` helper — does NOT apply here, since this writer's
  `replay` already bypasses `receipt()` and hand-constructs its own result,
  per the writer's own pre-existing comment). The corrected contract: an
  **all-rejected** batch (`appliedCount === 0`) returns `{ applied: false,
  declined: true, reason: 'schema-rejected' }` — `declined`, not `lost`,
  because `durableWrite` must **not** spill these for retry (a schema-invalid
  row does not become valid on a later attempt) — and `durableWrite` reports
  `outcome: 'skipped'`. A **partial** batch (`appliedCount > 0`) returns
  `{ applied: true }` only — real progress happened, so `durableWrite`
  correctly reports `outcome: 'written'`; `rejectedTopics` detail for a
  partial batch is **not** threaded through `durableWrite`'s outcome (that
  contract has no field for it and is not being widened for one caller) but
  is written directly to stderr by `upsertDebtEntries` itself the moment it
  detects rejections, the same way this module already logs other errors —
  visible in the CLI's own output regardless of the coarse outcome.
  `debt-auto-capture.mjs`'s summary card (which already renders a `Rejected:
  N` line for the *local* write) is unchanged by this fix; the cloud-side
  rejection detail reaches the operator via the stderr line, not a new card
  field.

### Fix C — `contentAliases` gets a real, bounded producer (`75981b9b`, part 2)

**Right-sizing:**
- *Band-aid*: leave `contentAliases` permanently `[]` and only ship Fix A/B.
  Rejected — the finding is specifically that the field "exists but is not
  applied consistently"; shipping the contract fix alone would leave the field
  dead, which the parent document already measured (0 of 222) and flagged as
  the wrong outcome for a HIGH finding.
- *Over-built*: a background reclustering job, an admin UI for merge/alias
  decisions, or a retroactive backfill across all 222 rows. Rejected — exactly
  what §2 marks "Not attempted here" (a semantic-clustering design decision
  larger than one session) and what AGENTS.md's pgvector section warns against
  duplicating.
- *Chosen*: a **forward-only, best-effort, fail-open** populator that reuses
  the existing embedding machinery verbatim — one new table shaped exactly
  like `finding_embeddings`, one new query shaped exactly like
  `nearestOpenReRaise`, wired into the one write boundary. No new dependency,
  no new similarity algorithm, no backfill.

**Implementation:**
- New migration `supabase/migrations/<ts>_debt_embeddings.sql`:
  ```sql
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE TABLE IF NOT EXISTS debt_embeddings (
    repo_id         UUID NOT NULL REFERENCES audit_repos(id) ON DELETE CASCADE,
    topic_id        TEXT NOT NULL,
    embedding       VECTOR(768),
    embedding_model TEXT NOT NULL,
    dimension       INT NOT NULL,
    snapshot_hash   TEXT NOT NULL,  -- sha256 of the text embedded — re-embed only on change
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (repo_id, topic_id)
  );
  -- Loose coupling to debt_entries(repo_id, topic_id) by natural key, not an
  -- FK to its surrogate id: the alias lookup runs BEFORE the entry's upsert
  -- (it needs to see OTHER existing entries first), so ordering an FK against
  -- a row that may not exist yet would force a two-phase write. debt_entries
  -- already treats (repo_id, topic_id) as its real identity (UNIQUE constraint).
  CREATE INDEX IF NOT EXISTS idx_debt_embeddings_model ON debt_embeddings (embedding_model, dimension);
  CREATE INDEX IF NOT EXISTS idx_debt_embeddings_vector
    ON debt_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 20)
    WHERE embedding IS NOT NULL;

  -- RLS (round-1 GPT audit M5 — MEDIUM: the migration named no access policy
  -- at all). Same single-tenant "Allow all for anon" shape already applied to
  -- debt_entries/debt_events (20260405092206) and finding_embeddings' implicit
  -- equivalent — this is a personal/single-user CLI tool, not a multi-tenant
  -- service; there is no narrower role to scope to.
  ALTER TABLE debt_embeddings ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS "Allow all for anon" ON debt_embeddings;
  CREATE POLICY "Allow all for anon" ON debt_embeddings FOR ALL USING (true) WITH CHECK (true);

  -- Same migration carries Fix A's cloud column (round-1 GPT audit H1) and
  -- Fix D's two fields (round-1 GPT audit M4 adds the producer, not the column):
  ALTER TABLE debt_entries ADD COLUMN IF NOT EXISTS classification_unavailable_reason TEXT;
  ALTER TABLE debt_entries ADD COLUMN IF NOT EXISTS review_deadline TIMESTAMPTZ;
  ALTER TABLE debt_entries ADD COLUMN IF NOT EXISTS superseded_by TEXT;
  ```
- New `scripts/lib/debt-alias.mjs`:
  - `findNearDuplicateDebtTopic(pool, { repoId, embedding, embeddingSpace, threshold, excludeTopicId })`
    — mirrors `nearestOpenReRaise`'s query shape (`embedding <=> $1::vector`,
    scoped by `embedding_model`/`dimension`), scoped to the same `repo_id`,
    excluding the entry's own `topicId`. Returns the best match above
    `threshold` or `null`.
  - `populateContentAliases(entries, { repoId, pool, embed, embeddingSpace, threshold, maxEntries = 25, deadlineMs = 5000 })`
    — for each entry, up to `maxEntries` and a shared `deadlineMs` wall-clock
    budget for the **whole batch** (round-1 GPT audit M2 — MEDIUM: nothing
    bounded this before; a large adjudication round deferring dozens of
    findings at once must not make `debt-auto-capture.mjs` hang):
    1. Build embed text from `category + ' ' + section + ' ' + detailSnapshot`,
       then run it through **this module's own** `redactSecrets` call
       (round-1 GPT audit H2 — HIGH: the original draft relied on
       `buildDebtEntry` having already redacted, but
       `debt-backfill.mjs --promote` builds `PersistedDebtEntry`-shaped
       records directly via `backfill-parser.mjs`, which never redacts —
       both constructors feed `persistDebtEntries`, so the redaction must
       live at the shared boundary, not be assumed of every producer).
    2. Skip if `< 30` chars after redaction (mirrors
       `partitionRecordTimeReRaises`'s floor).
    3. `snapshot_hash = sha256(text)`; if `debt_embeddings` already has a row
       for `(repoId, topicId)` with a matching `snapshot_hash` **AND matching
       `embedding_model`/`dimension` against the CURRENT `embeddingSpace`**,
       **reuse its stored embedding** instead of re-embedding (round-1 GPT
       audit M2 — the field existed but nothing ever checked it). The
       model/dimension check is not optional (round-2 GPT audit H4 — HIGH):
       matching on `snapshot_hash` alone would reuse a vector from a
       *retired* space after a provider/model switch or an Azure
       endpoint/deployment change, while the nearest-neighbour query is
       scoped to the *current* `embeddingSpace` — the two vectors are not
       comparable even though the text is byte-identical (this is the exact
       hazard AGENTS.md's Azure section names: "a deployment or resource
       switch is a DIFFERENT vector space… two spaces can't mix"). A
       `snapshot_hash` match against a stale space is treated as a miss —
       re-embed.
    4. Otherwise embed it, and check for a match in **two** places, not one
       (Gemini gate round 1 G4 — MEDIUM: the DB alone is blind to this same
       batch's own entries, since their embeddings aren't written to
       `debt_embeddings` until step 6 below — a multi-pass audit round
       deferring several re-worded duplicates of the same finding in one
       capture would otherwise never link them to each other): first, cosine
       against every **already-processed entry earlier in this same batch**
       (via `embeddingsByTopicId`, in memory, no query); then, if no match,
       `findNearDuplicateDebtTopic` against **other, previously-committed**
       entries in the DB (`excludeTopicId` = this entry's own topicId — an
       entry is never its own alias, in either check).
    5. If a match is found (from either check), append its `topicId` to
       `entry.contentAliases` (deduped, respecting the existing `max(20)`
       cap) — an intra-batch match makes BOTH entries alias each other
       (append each one's topicId to the other's `contentAliases`), since
       neither is more "canonical" than the other at this point.
    Every step wrapped in try/catch and racing the shared deadline — **any
    failure or timeout (no pool, no embedding provider, a query error, budget
    exhausted) leaves the remaining entries in the batch completely
    unchanged**, exactly the `[]` status quo, never blocks the persist it
    augments; a timeout is logged distinctly from a hard failure so an
    operator can tell "too slow" from "broken". Returns
    `{ entries, embeddingsByTopicId }` — the second so the caller can persist
    each new entry's own embedding as a future match target.
  - Threshold default: reuse `semanticSuppressConfig`'s conservative 0.92 — an
    alias claims "same debt topic", which is a stronger claim than "possible
    re-raise", so it should not be laxer than that bar.
- `debt-memory.mjs`'s `persistDebtEntries`: after `normalizeClassificationEnvelope`,
  when `context.source === EventSource.CLOUD`, call `populateContentAliases`
  (via `getPool()`, `embedText()`, `findingEmbeddingSpace()` — all already
  imported elsewhere in this module's neighbours) on the batch **before**
  calling `writeDebtEntries`, so the local ledger and the cloud mirror agree.
  When `context.source === EventSource.LOCAL` (no cloud), skip entirely —
  `contentAliases` stays `[]`, which is honest (no embedding infra reachable),
  not a regression from today.
- **Write ordering (round-1 GPT audit M1 — MEDIUM, clarified):** the alias
  *lookup* (querying OTHER entries' existing embeddings) happens first, against
  rows already committed from a prior capture. The entry being captured now is
  upserted into `debt_entries` next (Fix B). Only **after** that upsert
  succeeds does `store/debt.mjs` persist *this* entry's own embedding into
  `debt_embeddings` (`ON CONFLICT (repo_id, topic_id) DO UPDATE`) — fail-open,
  logged, never re-throws (mirrors `persistKeptEmbeddings`'s "a missing
  embedding only weakens future dedup, never breaks the write" framing
  verbatim). So a `debt_embeddings` row for a topic that failed to upsert (Fix
  B rejection) is never written; the only orphan risk is the reverse — an
  entry that upserts fine but whose embedding write then fails or whose
  *later* deletion leaves a stale vector.
- **Data-flow contract, caller to `store/debt.mjs` (Gemini gate round 2 G2 —
  HIGH):** the paragraph above says *where* the embedding write happens but
  the original draft never specified how `populateContentAliases`'s
  `embeddingsByTopicId` (computed in `debt-alias.mjs`, called from
  `debt-memory.mjs`) actually reaches `store/debt.mjs`, whose cloud write
  goes through `durableWrite('debt.entries', {repoId, entries})` — a
  payload `durableWrite` serializes to JSON when it spills, and a JS `Map`
  serializes to `{}` under `JSON.stringify`, silently losing every vector on
  the first spill. Closed by: (1) `populateContentAliases` returns
  `embeddingsByTopicId` as a **plain `{topicId: number[]}` object**, never a
  `Map`; (2) `debt-memory.mjs` passes it through unchanged as a third field
  on the `durableWrite` payload — `{repoId, entries, embeddingsByTopicId}`;
  (3) `upsertDebtEntries`'s signature widens to
  `upsertDebtEntries(repoId, entries, embeddingsByTopicId)`, and the
  `debt.entries` writer's `replay` passes `payload.embeddingsByTopicId`
  through. This keeps embedding persistence inside the SAME durable-write
  registration `debt_entries` already has — no second `registerWriter` call,
  since embeddings are explicitly not part of that write's durability
  contract (a lost or delayed embedding degrades future aliasing, never the
  entry itself).
- **Orphan cleanup, cloud-only (round-1 GPT audit M1, corrected by Gemini gate
  round 1 G2 — MEDIUM):** the draft above wrongly assigned this cleanup to
  `removeDebtEntry` in `debt-ledger.mjs` too. `debt-ledger.mjs` is a **local
  filesystem JSON manager only** — no DB pool, no `repoId` — per its own
  module docstring (already read in this session: "Mutations go through a
  single-writer lock… atomic temp-file + rename"), and local-only mode never
  populates `debt_embeddings` in the first place (Fix C skips aliasing
  entirely when `context.source === EventSource.LOCAL`), so there is no local
  embedding cache for it to clean up. The cleanup belongs **only** to
  `removeDebtEntryCloud` (`store/debt.mjs`), which also deletes the
  corresponding `debt_embeddings` row (`DELETE ... WHERE repo_id = $1 AND
  topic_id = $2`, fail-open — a failed cleanup delete never blocks or reverts
  the entry removal it accompanies) — and to `removeDebt`, the
  `debt-memory.mjs` facade that already calls both the local and cloud
  removers, whose existing `{removedLocal, removedCloud}` result is
  unaffected by this correction. `debt_embeddings` is intentionally **not**
  FK'd to `debt_entries` (the alias lookup must run before this entry's own
  row necessarily exists), so this explicit, hand-maintained delete is the
  cascade a foreign key would otherwise provide. A vector can still outlive
  its entry for the fail-open window between a successful cloud removal and
  this cleanup call, or if the cleanup call itself fails — an accepted
  residual gap (documented rather than pretended closed) since the mechanism
  is best-effort by design throughout.

### Fix D — a per-entry revalidation trigger (`92fe5776`)

**Right-sizing:**
- *Band-aid*: nothing — leave revalidation entirely to the existing global
  `--ttl-days` age heuristic. Rejected — `92fe5776` is specifically that no
  entry can declare its OWN review point (a `blocked-by` waiting on an issue
  due in 30 days is not the same urgency as an `accepted-permanent` with no
  expectation of revisit), and no successor-link exists at all.
- *Over-built*: a full workflow engine for debt lifecycle transitions
  (states, approvals, notifications). Rejected — no current requirement needs
  it; `debt-review.mjs` already renders a markdown report a human reads.
- *Chosen*: two new optional persisted fields + one new query surfaced in the
  existing report, no new subsystem.

**Implementation:**
- `schemas.mjs`'s `DebtEntryPersistedFields`: add
  `reviewDeadline: z.string().datetime().optional()` and
  `supersededBy: z.string().max(120).optional()`. Add to the `superRefine`:
  `supersededBy` must not equal the entry's own `topicId` (self-reference
  guard — the one thing Postgres's per-column CHECK also cannot express,
  since it needs two columns of the same row).
- `store/debt.mjs`: add `review_deadline TIMESTAMPTZ` and `superseded_by TEXT`
  columns via the same migration as Fix C (additive, `ALTER TABLE ... ADD
  COLUMN IF NOT EXISTS`), map them in `upsertDebtEntries` and
  `readDebtEntriesCloud`.
- `debt-capture.mjs`'s `buildDebtEntry`: when `deferredReason` is
  `'blocked-by'` or `'deferred-followup'` (the two reasons that imply "revisit
  this"), auto-compute `reviewDeadline` as `deferredAt + 90 days` **unless**
  the caller already passed one via `captureArgs.reviewDeadline` (new optional
  arg, passed through like `blockedBy`/`followupPr` already are). The other
  three reasons (`out-of-scope`, `accepted-permanent`, `policy-exception`)
  get no automatic deadline — they are not expected to be revisited by
  design — but the CLI flag still lets a human set one explicitly on any
  entry.
- `debt-auto-capture.mjs`: add `--review-deadline <iso>` passthrough (mirrors
  the existing `--blocked-by`/`--followup-pr` flags exactly).
- **`supersededBy` producer (round-1 GPT audit M4 — MEDIUM):** the schema and
  storage for `supersededBy` are useless without a way to actually set it —
  add flags to `debt-auto-capture.mjs`.
  **Both endpoints are explicit, never inferred (round-3 GPT audit H6 —
  HIGH, superseding the round-2 fix below):** a single scalar
  `--supersedes <old-topic-id>` is ambiguous the moment a batch captures more
  than one topic, and round-2's fix ("proceed only when exactly one entry in
  the batch was actually persisted") turned out to be a *different* bug:
  counting survivors selects whichever entry happened to persist, which is
  the WRONG entry whenever the operator's intended replacement is itself the
  one that got rejected (batch has intended-successor A and unrelated B; A
  is rejected, B persists; the old fix links the old entry to B, not A).
  Validation outcomes must never decide *identity*. The fix is to stop
  inferring the successor from batch composition at all:
  `--supersedes <old-topic-id> --supersedes-with <new-topic-id>` — the
  operator, who authored the adjudication ledger and therefore already knows
  every new topicId before capture runs, names **both** endpoints explicitly.
  `debt-auto-capture.mjs` refuses (non-fatal to the capture that already
  ran) if only one of the pair is given.
- **Existence is VERIFIED, not inferred from write outcomes (round-3 GPT
  audit H7 — HIGH):** absence from `rejected[]` proves the new entry was
  *schema-valid*, not that it durably exists yet — Fix B's cloud upsert can
  still fail on a connection error (no schema rejection recorded) or spill
  for later replay, in which case the topic isn't queryable in
  `debt_entries` yet even though nothing named it "rejected". So neither
  `markSuperseded` nor `markSupersededCloud` trusts an earlier write
  receipt: each independently re-reads its OWN store for
  `newTopicId` (and `oldTopicId`) immediately before writing the link, and
  refuses (structured, non-fatal) if either lookup comes back empty — this
  is a strictly stronger version of the "old topicId must exist" check
  already planned for the self-reference guard, now applied to the new
  topicId too and done by reading current state rather than trusting a
  write-time bookkeeping field.
  `markSuperseded(oldTopicId, newTopicId, {ledgerPath})`
  (`debt-ledger.mjs`, mirroring `removeDebtEntry`'s lock-and-rewrite shape,
  re-reading the ledger under lock to confirm both topics are present) sets
  the OLD entry's `supersededBy` field; `markSupersededCloud(repoId,
  oldTopicId, newTopicId)` in `store/debt.mjs` does the cloud equivalent
  (`SELECT 1 FROM debt_entries WHERE repo_id=$1 AND topic_id=$2` for each
  endpoint, then `UPDATE ... SET superseded_by = $1 WHERE repo_id = $2 AND
  topic_id = $3`). Both also refuse when `oldTopicId === newTopicId` (the
  same self-reference guard Fix D's schema-level check already applies).
  **Historical-entry compatibility (Gemini gate round 2 G4 — MEDIUM):**
  before writing the old entry back, `markSuperseded` runs it through
  `normalizeClassificationEnvelope` (Fix A) — 181 of 222 measured entries
  have neither `classification` nor `classificationUnavailableReason`, and a
  targeted rewrite that re-validates the full entry against
  `PersistedDebtEntrySchema` (defense-in-depth, matching `writeDebtEntries`'s
  own practice) would otherwise either persist a schema-violating row
  unchecked, or refuse to ever supersede a historical entry for a reason
  entirely unrelated to `supersededBy`. Normalizing first backfills an
  honest `classificationUnavailableReason` on that one write, the same
  forward-only contract Fix A already establishes for every other write
  path — not a backfill campaign, just this module's one remaining
  read-modify-write learning the same rule the others already follow.
  **Local/cloud coordination (round-2 GPT audit M7 — MEDIUM, still applies):**
  these are two independent mutations with no transaction spanning them, and
  this plan does **not** invent new coordination for that — it reuses the
  pattern this same module already has for exactly this shape, `removeDebt`'s
  `{removedLocal, removedCloud}` result. `markSuperseded`'s caller runs local
  first (authoritative, per the module's own established precedence — see
  `debt-ledger.mjs`'s module docstring), then attempts `markSupersededCloud`
  and reports `{local: {applied}, cloud: {applied, error}}` without rolling
  back the local change on a cloud failure — and because each side now
  verifies existence independently against its OWN store (the H7 fix above),
  a "local yes, cloud not-yet-visible" outcome is reported accurately rather
  than either side guessing from the other's write receipt. A disagreement
  between the two is the same class of local/cloud drift this system already
  tolerates and surfaces elsewhere (e.g. the measured 37/222 local-only
  entries that motivated this whole document) — not a new invariant this plan
  needs to close. This gives `supersededBy` one real, executable workflow: an
  operator who deliberately replaces a debt entry with a better-scoped one
  can now say so, closing the exact gap `92fe5776` described ("no
  canonical/superseded link").
- `debt-review-helpers.mjs`: add `findOverdueForReview(entries, now)` —
  entries whose `reviewDeadline` has passed, distinct from `findStaleEntries`'s
  age-based signal (different question: "did you say you'd look at this by
  X" vs "is this just old"). **Excludes superseded entries (Gemini gate
  round 1 G3 — MEDIUM):** an entry with `supersededBy` set has already been
  retired by its replacement, so its own `reviewDeadline` is moot — without
  this exclusion, a superseded entry whose deadline has passed would nag
  forever in every future report even though the operator already acted on
  it (`!entry.supersededBy` in the filter). `debt-review.mjs`'s
  `renderMarkdown`: add an "## Overdue for Review" section beside the
  existing "Stale Entries" one, populated only when non-empty (matches the
  existing pattern for `Budget Violations`/`Stale Entries`).

---

## 3. Engineering Principles

- **#5 Single Source of Truth** — `normalizeClassificationEnvelope` and the
  cloud-side `PersistedDebtEntrySchema.safeParse` make the Zod schema the one
  place the persisted-entry contract is defined; the Postgres `CHECK`
  constraints remain a second, coarser backstop (defense in depth) but are no
  longer the *only* enforcement on the cloud path.
- **#11 Testability** — every new function (`normalizeClassificationEnvelope`,
  `findNearDuplicateDebtTopic`, `populateContentAliases`,
  `findOverdueForReview`) is pure or takes injectable I/O (`pool`, `embed`),
  matching this file's own established test-injection pattern
  (`nearestOpenReRaise(pool, …)`, `partitionRecordTimeReRaises({pool, embed, …})`).
- **#13 Idempotency** — `debt_embeddings` upserts `ON CONFLICT (repo_id,
  topic_id) DO UPDATE`; re-running capture for the same topic re-embeds rather
  than duplicating, matching `finding_embeddings`'s own `ON CONFLICT` shape.
- **#15 Graceful Degradation** — Fix C is fail-open at three layers (no pool,
  no embedding provider, a query error) and Fix A/B never regress an existing
  entry (forward-only, read path unchanged).
- **#16 Backward Compatibility** — no existing field is renamed, tightened, or
  removed; every new field is optional; historical entries never get
  re-validated on read.

---

## 4. Security Considerations

`populateContentAliases` sends `category + section + detailSnapshot` text to
the embedding provider (Gemini or Azure, via `embedText`) — the **same** text
`partitionRecordTimeReRaises` already sends today for `audit_findings`, and it
runs strictly after `buildDebtEntry`'s existing secret-redaction pass
(`redactFields`/`redactSecrets`, `debt-capture.mjs:107-114`) has already run
on `category`/`section`/`detailSnapshot`. No new egress surface, no new
sensitive-path exposure — this is the existing sensitive-path/egress
consultation's precedent (`get-incident-neighbourhood` was consulted at
Phase 0.5c during the earlier §3/§4 work in this same document's lineage; the
data class here — redacted debt-entry text — is unchanged from what already
flows to the same provider).

---

## 5. Testing Plan

> **Verified against a real disposable Postgres, not just written and
> skipped:** `node scripts/db-test-container.mjs --keep` (pgvector image,
> migrated fresh from this plan's own migration) surfaced two real bugs the
> mocked-pool unit tests could not — a missing `source: 'debt'` field in a
> test fixture, and every seeded/query vector needing the column's actual
> fixed `VECTOR(768)` dimension rather than the toy 3-dim vectors the unit
> tests use (pgvector rejects a dimension mismatch server-side, not
> silently). Both fixed; all 17 tests across
> `tests/store-debt-cloud-validation.test.mjs` +
> `tests/debt-alias-integration.test.mjs` pass against the live container,
> including the real `ivfflat` cosine ranking, cross-repo scoping, the
> schema-validation write path, embedding persistence, and orphan cleanup.
> Container torn down after (`npm run db:local -- down`).
>
> **A full `npm test` run (15,956 tests) surfaced four more real gaps, all
> mechanical, all fixed:** (1) `debt-memory.mjs` (tech-debt domain) importing
> `db/client.mjs` directly (stores domain) was an undeclared layering edge —
> fixed by **retagging** `debt-alias.mjs` from `tech-debt` to `shared-lib`
> (it's a DB-query/embedding helper, the same category as
> `semantic-suppression.mjs`/`embed-text.mjs`, not tech-debt logic — the
> generic `scripts/lib/debt-*.mjs` glob had misclassified it) and adding a
> new `enrichDebtEntriesWithAliases` export to `store/debt.mjs` that owns
> pool lifecycle privately rather than exposing a raw `getPool` accessor
> (which would have reopened the `getReadClient`/`getWriteClient`
> abstraction breach R3/M2 deliberately removed). (2) `markSupersededCloud`
> is a new write-shaped `store/**` export needing registration or exemption
> — exempted in `tests/audit-store-durability-call-site.test.mjs`'s
> `NOT_A_DURABLE_WRITE` (it's an explicit, operator-invoked, already-
> representable-on-failure link, not part of the orchestrator's automatic
> cloud-write block). (3) `debt-memory.mjs`'s new `embedText()` call needed
> a census entry in `tests/embed-provenance.test.mjs` — exempted as
> query-side (it resolves `embeddingSpace` via the same shared
> `findingEmbeddingSpace()` this census protects and hands off to
> `store/debt.mjs` for the actual persistence). (4) `learning-store.mjs`'s
> pinned public-export-count tests needed `markSupersededCloud` +
> `enrichDebtEntriesWithAliases` added (206 → 208).
>
> **The full pre-push gate chain (`npm run check`'s components, minus
> `npm test` which is reported separately above) passes clean**, after three
> more mechanical follow-ups the changes above required: `npm run
> plans:index` (new plan file), `node scripts/check-stdout-flush.mjs
> --update` (the new `--supersedes` summary's stdout write, now routed
> through `finishAndExit`, shrank the tracked-site count by one), `node
> scripts/file-size-ratchet.mjs --update-baseline` (schemas.mjs's justified
> +48 lines), and `npm run db:local:regen` (the new migration's real schema
> changes — `debt_embeddings` + 3 `debt_entries` columns — regenerated
> `tests/fixtures/expected-schema.json` from a fresh replay). `db:suites:gate`
> then passed end-to-end against a fresh container, exercising the two new
> DB-gated debt suites as part of the same run.

- **`tests/debt-schemas.test.mjs`** (extend — this file already covers
  `PersistedDebtEntrySchema`/`HydratedDebtEntrySchema`, so Fix A's tests join
  it rather than a parallel file): `normalizeClassificationEnvelope` — no-op
  when classification present, no-op when `classificationUnavailableReason`
  already present, injects the default reason when both absent, and a
  blank/whitespace-only reason is NOT treated as already-set;
  `PersistedDebtEntrySchema` rejects an entry with neither field and accepts
  one with either; `supersededBy` self-reference rejected, a different
  topicId accepted.
- **`tests/debt-ledger.test.mjs`** (extend): a `writeDebtEntries` call with no
  classification and no explicit reason is now accepted (normalization
  happens upstream in `persistDebtEntries`, not inside `writeDebtEntries`
  itself — assert `writeDebtEntries` alone still REJECTS the bare case,
  proving the schema-level guard is real and not just cosmetic).
- **`tests/store-debt-cloud-validation.test.mjs`** (new, DB-gated per the
  existing `db-test-container.mjs` enrolment contract — AGENTS.md "A DB suite
  no runner names has never run"): `upsertDebtEntries` rejects a
  schema-invalid entry (e.g. `deferredRationale` > 4000 chars, which the
  Postgres CHECK does not catch) and reports it in `rejected[]` rather than
  either silently truncating or throwing an unhandled DB error; an
  **all-rejected** batch returns `{applied: false, declined: true, reason:
  'schema-rejected'}` (round-1 GPT audit H3, corrected by Gemini gate round 1
  G1 — `applied`/`declined` are never both `true`) and `durableWrite` reports
  `outcome: 'skipped'`, never `lost`/spilled-for-retry; a **partial** batch
  returns `{applied: true}` and logs the rejected topicIds to stderr; and —
  moved here from `tests/debt-ledger.test.mjs` per Gemini gate round 1 G2 —
  `removeDebtEntryCloud` also deletes the matching `debt_embeddings` row.
- **`tests/debt-alias.test.mjs`** (new): `findNearDuplicateDebtTopic` pure
  query shape test (mocked pool, mirrors `nearestOpenReRaise`'s own test
  style) + `populateContentAliases`'s fail-open paths — no pool, embed()
  throws, query throws, below-threshold match, above-threshold match,
  self-exclusion (never aliases a topic to itself), the `<30`-char floor, the
  `maxEntries`/`deadlineMs` bound actually stopping mid-batch (round-1 GPT
  audit M2), the `snapshot_hash` match skipping a re-embed when
  `embedding_model`/`dimension` also match, and a `snapshot_hash` match
  **against a different `embedding_model`/`dimension`** correctly treated as
  a miss and re-embedding (round-2 GPT audit H4 — a text-identical row from a
  retired vector space must never be reused); an **intra-batch** near-duplicate
  (two entries in the same call whose text is near-identical) aliases to each
  other via `embeddingsByTopicId` even though neither is in `debt_embeddings`
  yet (Gemini gate round 1 G4); and — **round-1 GPT audit H2** — a raw
  secret-shaped string in `detailSnapshot` never reaching the mocked
  `embed()` call, proving the module's own redaction fires regardless of
  whether the caller already redacted.
- **`tests/debt-auto-capture-supersedes.test.mjs`** (new): `--supersedes`
  requires `--supersedes-with` (refuses non-fatally if only one is given —
  round-3 GPT audit H6); succeeds when both named topicIds are independently
  verified to exist; the round-2 counting bug's exact repro — a batch with an
  intended successor that gets rejected alongside an unrelated entry that
  persists — must NOT link to the unrelated survivor (round-3 GPT audit H6
  regression test); `markSuperseded`/`markSupersededCloud` refuse when the
  new topicId is schema-valid but not yet queryable in the store being
  checked (e.g. a cloud spill not yet drained) rather than inferring
  existence from the write receipt (round-3 GPT audit H7); the local/cloud
  partial-failure shape (`markSuperseded` returns `{local:{applied:true},
  cloud:{applied:false, error}}` without reverting the local write, each side
  verified independently) (round-2 GPT audit M7).
  **Negative control required** (AGENTS.md verification-discipline #3): a test
  asserting `populateContentAliases` does NOT alias two entries whose text is
  genuinely dissimilar, so a mocked `embed()` that always "matches" cannot
  pass this suite.
- **`tests/debt-alias-integration.test.mjs`** (new, DB-gated — round-1 GPT
  audit M6): runs the real `ivfflat` cosine query from
  `findNearDuplicateDebtTopic` against a live Postgres fixture (two seeded
  `debt_embeddings` rows, one within threshold, one outside, one in a
  *different* `repo_id` to prove the scoping predicate), and one full
  `persistDebtEntries` round trip (local ledger write + cloud upsert +
  embedding persistence) asserting the local and cloud copies of
  `contentAliases`/`classificationUnavailableReason` agree afterward — the
  thing the mocked-pool unit tests above cannot show.
- **`tests/debt-capture.test.mjs`** (extend): `buildDebtEntry` sets
  `reviewDeadline` for `blocked-by`/`deferred-followup`, leaves it unset for
  the other three reasons, and honors an explicit `captureArgs.reviewDeadline`
  override.
- **`tests/debt-review-helpers.test.mjs`** (extend): `findOverdueForReview`
  — entries with a past deadline, a future deadline, and no deadline at all
  (must not be flagged) are each classified correctly; distinct from
  `findStaleEntries` (a test proving an entry can be flagged by one and not
  the other, confirming they are not aliases of the same predicate).
- **Poison-pill gate contract** (per AGENTS.md's gate-honesty system, since
  this plan's Fix A/B is a genuine `check-chain`-relevant contract): if a new
  `npm run` gate is warranted for "every debt-entry write validates against
  `PersistedDebtEntrySchema`", add a `scripts/gate-contracts/*.json` entry with
  a deliberately-broken fixture + control run, per the existing
  `visual-contract-doc-gate.json` precedent from §4 of the parent document —
  decide during implementation whether this rises to gate-contract weight or
  stays test-only (a schema-validation unit test may be sufficient; a
  dedicated CLI gate is not obviously warranted here since there's no
  prose↔code seam to defend, unlike §4's doc-drift case).

---

## 6. File-Level Plan

| File | Change |
|---|---|
| `scripts/lib/schemas.mjs` | Add `classificationUnavailableReason` (trimmed, `min(1)`), `reviewDeadline`, `supersededBy` to `DebtEntryPersistedFields`; extend the debt superRefine (classification-or-reason disjunction + `supersededBy` self-reference guard); add `normalizeClassificationEnvelope` (blank-aware) |
| `scripts/lib/debt-memory.mjs` | `persistDebtEntries`: call `populateContentAliases` when cloud-active, before `writeDebtEntries`, converting its returned `embeddingsByTopicId` **Map to a plain `{topicId: number[]}` object** before it enters `durableWrite`'s payload (Gemini gate round 2 G2 — a `Map` does not survive `durableWrite`'s JSON spill serialization); pass that object through to `durableWrite('debt.entries', {repoId, entries, embeddingsByTopicId, embeddingSpace})`. Classification normalization is NOT done here — see the implementation-time correction in the Status line above: it lives in `writeDebtEntries`/`upsertDebtEntries` themselves, since both are also called directly by `debt-auto-capture.mjs`/`debt-backfill.mjs`, bypassing this facade |
| `scripts/lib/debt-ledger.mjs` (additional) | `writeDebtEntries` calls `normalizeClassificationEnvelope` on each entry before `safeParse`, at the actual local write boundary (corrected location — see Status line) |
| `scripts/lib/store/debt.mjs` | `upsertDebtEntries(repoId, entries, {embeddingsByTopicId, embeddingSpace})` — **signature widened** (Gemini gate round 2 G2) to accept the plain-object embedding map + its space metadata alongside entries: normalizes (corrected location — see Status line) + `safeParse` before upsert, returns `{rejected[], appliedCount}` (all-rejected → `{applied:false, declined:true}`; partial → `{applied:true}` + stderr log of rejected topics — never both `applied`/`declined` true); maps `classification_unavailable_reason`/`review_deadline`/`superseded_by` both directions in `upsertDebtEntries`/`readDebtEntriesCloud`; after the entries upsert succeeds, loops `embeddingsByTopicId` and upserts each into `debt_embeddings` as a fail-open side effect of this SAME call (never a separate durable-write registration — a missing embedding only weakens future dedup, per the existing `finding_embeddings` precedent); `removeDebtEntryCloud` also deletes the matching `debt_embeddings` row; new `markSupersededCloud(repoId, oldTopicId, newTopicId)` verifying both topicIds exist via a real read before writing the link |
| `scripts/lib/debt-alias.mjs` (new) | `findNearDuplicateDebtTopic`, `populateContentAliases` (redacts internally, bounded by `maxEntries`/`deadlineMs`, checks in-batch `embeddingsByTopicId` before the DB, reuses an embedding on a matching `snapshot_hash` + `embedding_model`/`dimension`; returns `embeddingsByTopicId` as a plain object, not a `Map` — Gemini gate round 2 G2) |
| `scripts/lib/debt-ledger.mjs` | New `markSuperseded(oldTopicId, newTopicId, opts)` (locked read-modify-write, mirrors `removeDebtEntry`, verifies both topicIds exist in the local ledger before writing the link; runs the target entry through `normalizeClassificationEnvelope` before re-validating and writing it back — Gemini gate round 2 G4, so a historical entry with neither `classification` nor `classificationUnavailableReason` is honestly backfilled rather than either silently persisting a schema-violating row or refusing supersession for a reason unrelated to what's actually changing) — local JSON only, no embedding-cache involvement (that lives exclusively in `store/debt.mjs`, see Gemini gate round 1 G2) |
| `scripts/lib/debt-capture.mjs` | `buildDebtEntry`: auto-compute `reviewDeadline` for `blocked-by`/`deferred-followup`; accept `captureArgs.reviewDeadline` override |
| `scripts/debt-auto-capture.mjs` | **`main()`'s write path replaced**: `writeDebtEntries(entries)` + a standalone `syncToCloud`/`durableWrite` call → one `persistDebtEntries(debtContext, entries)` call (implementation-time correction 2 — closes the "Fix C never actually runs on the primary capture path" gap, round-1 code audit M12); add `--review-deadline <iso>` and the paired `--supersedes <old-topic-id>` / `--supersedes-with <new-topic-id>` flags (both-or-neither — round 3 GPT audit H6; a lone `--supersedes` was round 2's now-abandoned design, corrected in §6 per Gemini gate round 2 G3); summary card surfaces cloud-side `rejected[]` and the cloud error message |
| `scripts/lib/debt-review-helpers.mjs` | Add `findOverdueForReview` (excludes entries with `supersededBy` set — Gemini gate round 1 G3) |
| `scripts/debt-review.mjs` | `renderMarkdown`: add "Overdue for Review" section |
| `scripts/lib/audit-store-writers.mjs` | `debt.entries` writer: pass `payload.embeddingsByTopicId` through to `upsertDebtEntries` (Gemini gate round 2 G2); map an all-rejected batch to `{applied:false, declined:true, reason:'schema-rejected'}` and a partial batch to `{applied:true}` — **never both `applied`/`declined` true** (corrects the self-contradictory shape this row previously named; the fix is stated in §2 Fix B, Gemini gate round 1 G1, and this row now matches it — Gemini gate round 2 G1 caught the two having drifted) |
| `supabase/migrations/<ts>_debt_embeddings.sql` (new) | `debt_embeddings` table + indexes + RLS policy; `ALTER TABLE debt_entries ADD COLUMN IF NOT EXISTS classification_unavailable_reason`, `review_deadline`, `superseded_by` |
| `tests/debt-schemas.test.mjs` | extend, Fix A incl. blank-reason rejection (M3) and `supersededBy` self-reference (Fix D) |
| `tests/debt-ledger.test.mjs` | extend, Fix A + local-only `markSuperseded` (M4, H6, H7) — no embedding-cache assertions here (Gemini gate round 1 G2) |
| `tests/store-debt-cloud-validation.test.mjs` (new, DB-gated) | Fix B, incl. all-rejected vs partial-batch receipt shape (H3, corrected by G1) and the new column round trip (H1); cloud `removeDebtEntryCloud` embedding-cache cleanup (M1, relocated here per G2) |
| `tests/debt-alias.test.mjs` (new) | Fix C: fail-open paths, self-redaction (H2), batch bound (M2), hash-reuse (M2) |
| `tests/debt-alias-integration.test.mjs` (new, DB-gated) | Fix C real-Postgres cosine query + full round trip (M6) |
| `tests/debt-auto-capture-supersedes.test.mjs` (new) | Fix D `--supersedes <old>`/`--supersedes-with <new>` pairing (H5, H6) + existence verification (H7) + local/cloud partial-failure shape (M7) + `markSuperseded` normalizing a classification-less historical entry (G4) |
| `tests/debt-capture.test.mjs` | extend, Fix D |
| `tests/debt-review-helpers.test.mjs` | extend, Fix D |
| `docs/plans/aged-out-acceptance-remainder.md` | §2 status → shipped, cite this plan + commit shas |

No `## 11. Execution Clustering` block — the four fixes share one write
boundary and one schema file closely enough that splitting them into
independently-auditable clusters would fragment review of a single coherent
contract change. `/cycle --autonomous` runs this as the degenerate
single-cluster path.
