# Persona/Nav feedback-loop recovery — deterministic correlator, nav-audit v2 persistence, telemetry surfacing, outcome labels

- **Status**: Complete — all 4 workstreams (WS1-WS4) implemented across 4
  `/cycle --autonomous` clusters, each independently code-audited to
  convergence (Clusters 1-3, fix-gate: yes) or one documented round
  (Cluster 4, fix-gate: none per plan). The mandatory consolidated Gemini
  gate over the union diff of all 4 clusters (94 findings, 29 files)
  **APPROVED outright** on round 1 — closing the plan-level round-3
  `CONCERNS`-not-re-verified caveat noted below against the real
  implementation rather than re-litigated plan prose. See Implementation
  Log at the bottom for what shipped, deviations, and real bugs found only
  by empirical DB verification.
Date: 2026-07-13

## 1. Problem — measured, not assumed

An investigation (2026-07-13, live DB queries against the audit-loop Supabase
project) found the UX lenses' feedback side half-built, mirroring the
asymmetry just closed for audit-plan:

| Loop | Designed? | Ever fired? | Evidence |
|---|---|---|---|
| `persona_test_sessions` capture | ✅ rich (verdict, P0-P3, findings jsonb, debrief, click_path, commit_sha) | ✅ 59 rows | latest **2026-05-23** — stale ~7 weeks |
| `persona_audit_correlations` (persona P0/P1 ↔ audit ground truth) | ✅ table + `record-correlation` CLI + skill Phase 6b marked MANDATORY | ❌ **0 rows ever** | `SELECT count(*)` = 0 |
| Bandit user-impact reward (`computeUserImpactReward`) | ✅ | ❌ never fed (reads correlations) | — |
| `audit_effectiveness` view / dashboard tab | ✅ | ❌ measures against an empty ground-truth set | — |
| Persona finding outcomes (was a P0 ever fixed?) | ❌ nothing anywhere | — | ship gate reads only the latest session's raw count |
| nav-audit run persistence | ❌ `record-nav-audit-run` is a documented stub ("deferred to v2, no migration in v1") | ❌ validates input, then no-ops | cross-skill.mjs `cmdRecordNavAuditRun` |
| nav drift aging (>14-day governance smell) | designed cloud-sourced (`firstSeenFromHistory`) | ❌ no run history exists → aging works only off a gitignored local cache that dies with the checkout | collect-nav.mjs comment trail |
| persona→nav seeding (`get-reachability-evidence` → `personaIntents`) | ✅ | ✅ works | read-direction only; only as fresh as the stale sessions |

**Root-cause pattern**: every dead loop above relies on an *agent-discretionary
manual step* (Phase 6b's one-command-per-finding emission; a v2 that never got
scheduled). The audit-code fix for the same class (deterministic outcome
capture — `finalizeRoundOutcomes` runs automatically on the invocation the
agent already makes) is the proven remedy: **make the write deterministic on a
step that already happens.**

## 2. Workstreams

### WS1 — Deterministic persona↔audit correlator (highest leverage)

Replace the per-finding manual `record-correlation` emission with a
**deterministic post-session correlator** that runs automatically inside
persona-test Phase 6 (immediately after `recordPersonaSession` returns the
`sessionId` — the invocation the agent already makes), while keeping the
manual CLI as the override/repair path.

- **New module** `scripts/lib/persona/audit-correlator.mjs` (pure matching +
  a thin orchestration wrapper). **Versioned, executable matcher contract**
  (`MATCHER_VERSION = 1`, persisted as a real `matcher_version int` column
  added to `persona_audit_correlations` by this WS's migration — a queryable
  identity, not a rationale-string prefix; NULL on pre-existing/manual rows
  is the honest "unversioned" value). Hash-function changes bump
  `MATCHER_VERSION`; old outcome labels stay joined to old hashes (a bump
  orphans them from NEW sessions only — accepted single-operator debt,
  revisit trigger: the first actual version bump):
  - Inputs: the session's P0/P1 findings (already structured in the session
    payload), the session's `commit_sha`, `repoId`.
  - **Canonical finding-identity contract** (`persona_finding_hash` — the
    join key for BOTH correlation idempotency here and WS4's outcome
    labels, so it is defined ONCE): `semanticId()` (the existing single
    source, `lib/findings.mjs`) over the canonicalized persona-finding
    mapping `{ section: finding.element, category: finding.code, detail:
    finding.observed }` — **corrected at implementation time**: the real
    persona-finding shape (`{fix, code, step, element, expected, observed,
    confidence}`, already documented in `references/audit-correlation.md`
    and produced by every persona-test session) has no separate `category`
    field — `code` IS the severity ("P0".."P3"). An earlier draft of this
    section assumed `finding.severity + finding.category`; that shape was
    never real (ground-truth-verified against the actual finding payload
    before writing the correlator, per this repo's own "docs/plans
    statuses are systematically stale" standing caution). The mapping is
    exported as `personaFindingHash(finding)` from the correlator module
    so WS4's label validation and the worksheet use the identical
    function, never a re-derivation. Hash-function changes are a
    `MATCHER_VERSION` bump.
  - **Candidate selection is timestamp-ordered AND temporally bounded**
    (a git SHA has no order relation to an audit-run row, so ordering is
    by `created_at`; but recency-ordering alone still permits an ancient
    fallback — Gemini gate round-3 finding: a repo unaudited for 6 months
    would let a 6-month-stale run stand in as the comparison candidate for
    today's persona session, penalizing that old audit for missing a bug
    that didn't exist when it ran): the last N `audit_runs` rows for
    `repoId` **within the last 14 days** (`WHERE created_at >= now() -
    interval '14 days'`), ordered by `created_at DESC` (N=5 default,
    `PERSONA_CORRELATE_RUN_WINDOW` env-tunable), plus — regardless of
    age — the exact run whose `commit_sha` matches the session's
    `commit_sha` (an exact-commit match is always relevant no matter how
    old). A repo with no runs inside the 14-day window and no exact
    commit match has zero candidates → the already-defined
    no-candidate-runs path (emits nothing), not a stale fallback. All
    candidate `audit_findings` fetched via ONE store read
    (`WHERE run_id = ANY($1)`, no N+1).
  - **Matching, in strict precedence order** (first hit wins per persona
    finding; comparisons are conjunctive within a tier). **Both sides'
    canonical inputs are defined** — persona side per the identity
    contract above; audit side uses the finding row's NATIVE fields
    (`section`, `category`, `detail`, `affectedFiles` — the shapes
    `audit_findings` already stores):
    1. Exact tier: `semanticId()` byte-equality between the persona
       canonicalization and the audit finding's stored `_hash`
       (opportunistic fast path — expected to fire rarely, since the two
       vocabularies differ; the fuzzy tier is the working matcher and
       that expectation is documented, not hidden) → `match_score = 1.0`.
    2. Fuzzy tier — **Overlap Coefficient, not Jaccard** (Gemini gate
       round-2 finding: Jaccard is mathematically wrong for this
       comparison — a UI-vocabulary token set like `[checkout]` compared
       against a code-path token set like `[src, pages, checkout, tsx]`
       via Jaccard scores only 0.25 because the LARGER set's extra tokens
       inflate the union denominator; the two vocabularies are
       structurally disjoint in SIZE by design (a short UI label vs a
       full path), not in relevance. Overlap Coefficient
       `|A ∩ B| / min(|A|, |B|)` measures whether the SMALLER vocabulary
       is contained within the larger one, which is the actual question
       — "does the UI element appear in the code path" — and isn't
       penalized by the larger side's verbosity. `[checkout]` fully
       contained in `[src, pages, checkout, tsx]` scores 1.0, correctly).
       Token normalization = lowercase → split on non-alphanumeric →
       drop tokens with length < 3. File-path tokens: persona side =
       tokens of `finding.element` + the sanitized step URL path; audit
       side = tokens of `affectedFiles` entries. Keyword tokens: persona
       `observed` text vs audit `detail + section`. Score = `0.5 ×
       Overlap(file-path tokens)` + `0.5 × Overlap(keyword tokens)`;
       accept iff score >= 0.6 **AND both component scores are > 0**
       (**strengthened at code-audit time, two rounds**: round 1 added the
       dual-signal floor — a pure single-signal match, e.g. perfect
       file-path containment with zero keyword overlap, cleared the
       original 0.5 combined threshold on its own, a real false-ground-
       truth risk since a short UI-element token can trivially appear in
       an unrelated file's path. Round 2 raised the combined threshold
       0.5 → 0.6 on the COMBINED weighted score (not an independent
       per-axis minimum — a 100%-file/20%-keyword split and a
       50%/50%-needing-70%-elsewhere split both clear 0.6 the same way).
       Round 3 added `MIN_INFORMATIVE_TOKENS = 2`: a single-token smaller
       set (e.g. both sides mentioning only "Save") is treated as
       non-evidence on that axis regardless of containment — the
       combined-score threshold alone can't catch this, since a lone
       shared generic token still scores a degenerate 1.0 on Overlap
       Coefficient. All three changes cost only recall — a rejected
       match still falls through to `audit_missed`, never silently
       dropped). A P0/P1 finding missing `element` or `observed`
       is quarantined BEFORE hashing (never matched, never emitted) —
       the `?? ''` degradation in `personaFindingHash` otherwise gives
       every malformed finding sharing those missing fields the SAME
       synthetic identity, a correlation/outcome-label collision across
       unrelated observations (code-audit H4 fix). Ties broken by newest
       audit run, then highest audit severity (deterministic).
  - Emission per P0/P1 finding, idempotent per constraint design below:
    - match → `confirmed_hit` (or `severity_understated` when the audit
      severity was LOW/MEDIUM and persona severity is P0 — the rule the
      skill prose already specifies).
    - no match → `audit_missed` with `audit_finding_id NULL` and
      `audit_run_id` = most recent candidate run.
  - **Idempotency for NULL matches (real Postgres gotcha)**: the existing
    `UNIQUE (persona_session_id, persona_finding_hash, audit_finding_id)`
    does NOT deduplicate rows where `audit_finding_id IS NULL` (NULLs are
    distinct in Postgres uniqueness). New additive migration adds a
    **partial unique index**:
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_correlations_missed ON
    persona_audit_correlations (persona_session_id, persona_finding_hash)
    WHERE audit_finding_id IS NULL;` — a re-run of the same session then
    conflicts on BOTH shapes (matched via the existing constraint, missed
    via the partial index) and uses `ON CONFLICT DO NOTHING`.
  - **"First hit wins" is enforced at the correlator, not by constraint**
    (deliberate): the AUTO-correlator emits **at most one row per
    (session, finding-hash)** — before emitting, it checks for ANY
    existing correlation row for that pair (one batched existence read for
    the whole session, not per-finding) and skips already-correlated
    findings (`correlationSummary.skippedExisting: n`). The DB
    deliberately still PERMITS multiple rows per pair with different
    `audit_finding_id`s because the MANUAL path legitimately produces
    them (e.g. a human recording that one persona symptom confirms two
    distinct audit findings) — constraining the table to one-row-per-pair
    would break the schema's existing manual contract. Auto = exactly one
    (or zero if any exists); manual = unconstrained; both idempotent.
  - **Empty candidate set emits NOTHING (ground-truth integrity)**: a
    session with ZERO eligible `audit_runs` is **not evidence the audit
    missed anything** — there was no audit to compare against, and an
    `audit_missed` row here would pollute the effectiveness/reward loop
    with false negatives (penalizing the auditor for runs that never
    happened). The correlator emits zero rows and reports
    `correlationSummary: { attempted: true, candidates: 0,
    reason: 'no-candidate-runs' }` — visible, honest, and excluded from
    ground truth. `audit_missed` requires at least one candidate run
    (`audit_run_id` NOT NULL on the auto path — the manual CLI keeps its
    existing freedom).
  - `audit_false_positive` / `severity_overstated` are NOT auto-emitted
    (they require human judgment that a flagged issue could not be
    reproduced) — they remain manual-CLI-only. Documented in the module
    header so the asymmetry is a stated contract, not an omission.
  - **Manual repair MUST retire the auto-emitted NULL row (Gemini gate
    round-2 finding — stale ground truth)**: without this, an operator
    using the manual CLI to correct an auto-emitted `audit_missed` into a
    real `confirmed_hit` would leave BOTH rows in place — the ground
    truth would then simultaneously say "audit missed this" (the stale
    NULL row) and "audit caught this" (the new manual row) for the same
    finding, double-counting in `audit_effectiveness` and the bandit
    reward. `recordPersonaAuditCorrelation` (the manual-CLI store
    function) wraps its insert in one transaction: `DELETE FROM
    persona_audit_correlations WHERE persona_session_id = $1 AND
    persona_finding_hash = $2 AND audit_finding_id IS NULL` immediately
    before inserting the real match — a repair actually repairs the
    record, never appends a second, contradictory truth.
- **Wiring + observable degradation**: `cross-skill.mjs
  record-persona-session` gains `autoCorrelate: true` (default ON). The
  response ALWAYS carries a structured `correlationSummary`:
  `{ attempted: bool, reason?: 'disabled-by-flag'|'cloud-off'|
  'no-repo-identity'|'no-p0p1-findings'|'no-candidate-runs'|
  'candidate-read-failed'|'existence-check-failed', candidates: n,
  exact: n, fuzzy: n, missed: n, skippedExisting: n, writeFailed: n,
  matcherVersion: 1 }` — the reason union covers READ-side failures
  (candidate query, existence lookup) as first-class states, not just
  policy/availability; every failure state also logs loudly to stderr.
  Disabled-by-policy, unavailable, read-failure, and write-failure are
  all externally distinguishable, never conflated into silence. persona-test SKILL.md
  Phase 6b becomes "verify `correlationSummary` in the response (echo it
  into the session report); run the manual CLI only for repair /
  false-positive labeling." A `writeFailed > 0` or unexpected `reason`
  logs loudly to stderr at emit time.
- **Best-effort invariant** (graceful degradation #16): correlator failure
  never fails the committed session write — but is always visible via
  `correlationSummary` + stderr, never a silent no-op.
- **Tests** (Tier 1 — deterministic seam): pure matcher unit tests (exact
  semanticId hit; fuzzy-threshold hit incl. tie-break order; sub-threshold
  → audit_missed shape; severity_understated rule; token-normalization
  cases); hermetic cloud-off → `correlationSummary.reason='cloud-off'`;
  idempotency (re-run same session → 0 new rows for BOTH matched and
  missed shapes, exercising the partial unique index via the store seam's
  conflict target).

### WS2 — nav-audit v2 run persistence (the deferred migration)

- **New migration** `nav_audit_runs`:
  `id uuid PK DEFAULT gen_random_uuid(), repo_id uuid NOT NULL,
  head_sha text NOT NULL, scope text NOT NULL DEFAULT 'full',
  drift_keys jsonb NOT NULL DEFAULT '[]', finding_counts jsonb,
  verify_summary jsonb, tool_version text,
  created_at timestamptz NOT NULL DEFAULT now()`.
  Index `(repo_id, created_at DESC)`. Bare repo_id (single-tenant, mirrors
  `tiered_shadow_observations`). RLS enabled deny-all (owner-bypass), same
  posture as siblings. **Idempotency with no NULL hole**: `scope` is
  `NOT NULL`, with the writer normalizing an ABSENT scope to `'full'`
  (an unknown, non-empty scope is explicitly REJECTED, not normalized —
  see the closed-enum validation rule below, which this sentence must
  not contradict) (a nullable scope would make `UNIQUE (repo_id, head_sha,
  scope)` a non-constraint for NULL rows — same Postgres NULLs-are-distinct gotcha
  as WS1). Constraint: `UNIQUE (repo_id, head_sha, scope)`.
- **Conflict semantics preserve firstSeen**: writes use
  `ON CONFLICT (repo_id, head_sha, scope) DO NOTHING` — a re-record of the
  same (repo, sha, scope) never updates `created_at` (which IS the
  first-seen timestamp drift aging depends on) and never replaces
  `drift_keys` (extraction is deterministic for a given sha+scope, so the
  first row's keys are the same keys — documented in the store header).
- **Store module** `scripts/lib/store/nav-audit.mjs` — **observable
  best-effort, not silent** (the silent-DB-write-swallow class is a
  standing HIGH in this repo's own audit checklist):
  `recordNavAuditRun` never throws but returns a discriminated result
  `{ status: 'recorded'|'deduplicated'|'unavailable'|'failed',
  error?: <sanitized message> }` — `recorded` requires a verified
  `rowCount === 1`, `deduplicated` is the DO-NOTHING conflict path
  (`rowCount === 0`), `failed` logs loudly to stderr at the store seam.
  `cmdRecordNavAuditRun` emits the status in its JSON response.
  Plus `getNavFirstSeen({repoId, driftKeys})` → key→first `created_at`
  map via ONE query with **per-key semantics** (NOT array containment —
  `drift_keys @> $all` would only match runs containing EVERY requested
  key). The defined query unnests and groups:
  `SELECT key, min(created_at) AS first_seen FROM nav_audit_runs,
  jsonb_array_elements_text(drift_keys) AS key
  WHERE repo_id = $1 AND created_at >= now() - ($3 || ' days')::interval
  AND key = ANY($2) GROUP BY key` —
  one round trip, per-key minimum, bounded by the caller's key list AND a
  `sinceDays` window (default 180, capped 365 — same bounded-read posture
  as `getTieredShadowObservations`) so the unnest scans a time-bounded
  slice the `(repo_id, created_at DESC)` index can serve, never the
  entire history. Semantics documented: "first seen within the retention
  window" — a divergence older than the window ages from the window
  edge, which only UNDERSTATES age (safe direction: anything past the
  window is already maximally old for the >14-day governance smell).
  Explicit repoId — never ambient.
- **Cloud persistence only for clean-tree runs (Gemini gate finding)**:
  `head_sha` alone cannot distinguish between different UNCOMMITTED
  working-tree states on the same commit — a dirty local experiment's
  drift keys would otherwise lock into the shared cloud ledger via the
  first `ON CONFLICT DO NOTHING` write, permanently misrepresenting
  abandoned local state as "first seen" for that sha, and blocking any
  later clean run on the same sha from ever correcting the record. Fix:
  the producer (`scripts/nav-audit.mjs`) checks `git status --porcelain`
  before calling `record-nav-audit-run` — **dirty tree → skip the cloud
  write entirely** (the local observed-envelope/verify-result files are
  still written exactly as today; only the CLOUD aging record is
  skipped). A clean tree is the only state a shared ledger should ever
  represent — "dropping dirty runs is cleaner for a shared ledger" than
  tracking working-tree content hashes as a second uniqueness dimension.
- **Producer wiring is non-discretionary** (the WS1 lesson applied to
  WS2 — a record command nobody calls is the same dead loop):
  `scripts/nav-audit.mjs`'s own completion path (immediately after the
  observed-envelope/verify-result write in `main()`, the step every run
  already executes) invokes `record-nav-audit-run` via the same
  cross-skill subprocess boundary it already uses for
  `get-reachability-evidence` — best-effort (a failure logs the
  discriminated status and never fails the audit), never left to skill
  prose for an agent to remember. `scripts/nav-audit.mjs` is in the Files
  table for exactly this edit.
- **Command input schema + envelope→row mapping (defined, not implied)**:
  `record-nav-audit-run` payload =
  `{ headSha: envelope.provenance.headSha (the sha the extractor already
  stamps), scope: 'full' | 'diff' | 'verify' (see validation below),
  driftKeys: the advisory divergence keys from partitionFindings(
  runTaxonomy(...)) — the SAME divergenceKey() values the local drift
  ledger caches today (one key function, no parallel derivation),
  findingCounts: { byClass: {...}, bySeverity: {...} } from the taxonomy
  result, verifySummary: the persisted verify-result's summary block or
  null when no --verify ran, toolVersion: NAV_TOOL_VERSION }`. The exact
  envelope field names are resolved against `lib/nav/envelope.mjs` /
  `drift.mjs` at implementation time — but the SOURCE of each column is
  pinned here so the implementation maps, never invents.
- **Scope validation, not conflation**: `scope` accepts the closed enum
  (`full`/`diff`/`verify`); ABSENT → `'full'` (the default mode);
  UNKNOWN → `BAD_INPUT` error (an unknown scope is invalid input or a
  future mode — silently folding it into the `full` uniqueness row would
  deduplicate unrelated results; fail loud instead).
- **Drift aging goes cloud-first**: `collect-nav.mjs` (and the CI drift
  gate's aging path) source `firstSeenLookup` from `getNavFirstSeen`,
  falling back to the local ledger cache when cloud is off — local cache
  becomes the fallback it was always documented as, instead of the only
  source.
- **Tests**: store cloud-off degradation (hermetic AUDIT_DB_URL='' dynamic
  import, the established convention); discriminated-result shape per
  status; aging-source precedence (cloud rows beat local cache; absent
  both → age 0).
- **Consumer sync + relocation — traced, not assumed**:
  - Migration deployment: `scripts/sync-to-repos.mjs` already maps
    `supabase/migrations/*.sql` → consumer `.audit-loop/migrations/*.sql`
    (the AGENTS.md "What sync writes" table row; the mapper is
    `scripts/lib/sync-path-map.mjs` — the single source of truth for the
    layout, so NO new mapping entry is needed for a new file matching the
    existing migrations glob). The shared single-tenant DB gets the table
    ONCE via `node scripts/setup-postgres.mjs --migrate` from this repo;
    consumer copies exist for the isolation verifier, not re-application.
  - Store module reachability: `scripts/lib/store/nav-audit.mjs` is
    imported by `cross-skill.mjs` (a `CORE_ENTRY`), so the sync walker's
    transitive import closure picks it up automatically (the established
    contract — per the repo memory, only computed-import targets or
    fs-read assets need manual declaration; this is a static import).
  - Relocation: the new module uses no `import.meta.dirname` parent
    resolution (plain sibling imports only) — nothing for
    `tests/relocation-guard.test.mjs` to flag; the collect-nav change is
    dashboard-side (source-repo only surface, synced like its siblings).

### WS3 — Persona telemetry dashboard section

- New telemetry tab "Persona Tests" (group: *Delivery & governance*):
  latest-session card per persona (verdict, P0/P1 counts, age), a session
  trend table (exactly the last **15** sessions, ordered `created_at DESC`
  — fixed limit + order, not "~15"), and a correlation-loop health line
  (total correlations, by type — turns WS1's output into a visible
  surface).
- **Typed availability states, not one empty state** (the established
  `sources.<name>.status` pattern this dashboard already uses):
  - `ok` + rows → normal render;
  - `ok` + zero sessions → "no persona sessions recorded yet" note;
  - `ok` + sessions but zero correlations → an explicit "correlation loop
    has not fired yet" callout (distinct from the sessions-empty state —
    this is the exact signal that was invisible for months);
  - `missing-optional` (cloud off / no repo identity) → the standard
    empty-panel with the cause;
  - `unexpected-error` (query failure) → the standard warning panel with
    the sanitized error. A collector failure must never render as a clean
    zero (the repo's green≠checked doctrine).
- Collector reads via existing `getPersonaSessionsByRepo` + one new small
  store read for correlation counts (extends `store/persona.mjs`). Wiring
  is the established four-touch pattern (traced, same as the Tiered Shadow
  tab shipped today): `collect-telemetry.mjs` collector + `sources` entry,
  optional `personaTests` block on `TelemetryDataSchema`, REGISTRY entry +
  SLICER in `render.mjs`, new `sections/persona-tests.mjs`. Plain-English
  `desc` per the new dashboard convention.
- **Staleness surfaced honestly**: the panel shows "latest session: N days
  ago" prominently — the 7-week gap is a finding this tab would have caught.

### WS4 — Persona finding outcome labels (fixed/dismissed)

- **Schema is REPO-scoped, not session-scoped (Gemini gate finding — fixes
  session amnesia)**: labels must survive across sessions, or `dismissed`/
  `wont_fix` are useless for a persistent false-positive that a new
  persona-test run trips over again every time — the exact "don't ask the
  user the same thing twice" failure the workstream exists to prevent.
  `persona_finding_outcomes` (
  `id uuid PK DEFAULT gen_random_uuid(), repo_id uuid NOT NULL
  REFERENCES audit_repos(id) ON DELETE CASCADE, persona_finding_hash text
  NOT NULL, outcome text NOT NULL CHECK (outcome IN
  ('fixed','dismissed','wont_fix','stale')),
  last_seen_session_id uuid REFERENCES persona_test_sessions(id)
  ON DELETE SET NULL — informational audit trail ("most recently labeled
  from this session"), NOT part of the identity key,
  labeled_by text NOT NULL, rationale text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()`,
  `UNIQUE (repo_id, persona_finding_hash)` — one durable adjudication per
  finding per repo, independent of which session first or most recently
  saw it.
  - **Correction semantics**: labels are correctable — the `label` command
    upserts `ON CONFLICT (repo_id, persona_finding_hash) DO UPDATE SET
    outcome/rationale/labeled_by/last_seen_session_id/updated_at`; the
    original `created_at` is preserved, `updated_at` marks the correction.
    Last-write-wins with visible `updated_at ≠ created_at` is the
    deliberate single-operator design — an append-only revision ledger is
    the over-engineered version rejected here (revisit trigger: a second
    concurrent labeler exists).
  - **Regression handling** (a finding relabeled `fixed` that reappears is
    a real regression, not a resolved item — must NOT be silently treated
    as closed): the ship-gate summary query joins the CURRENT session's
    raw P0/P1 finding hashes against the repo-level ledger's LATEST
    outcome per hash. If the ledger says `dismissed`/`wont_fix` → closed
    (counts against neither `openP0` nor `openP1`). If the ledger says
    `fixed` or `stale`, OR no ledger row exists → **open** (a finding
    labeled `fixed` that the current session still observes is exactly a
    regression, and the gate correctly re-flags it — `fixed` is not a
    standing suppression, only `dismissed`/`wont_fix` are).
  - **Rationale is REQUIRED for dismissive outcomes**
    (`dismissed`/`wont_fix`) — enforced at BOTH layers: the CLI validates
    first (friendly message), and the table carries the invariant so no
    future store consumer or direct write can bypass it:
    `CHECK (outcome NOT IN ('dismissed','wont_fix') OR
    (rationale IS NOT NULL AND length(btrim(rationale)) > 0))`.
    Optional for `fixed`/`stale`.
  - **Dismissal cascades to retire false ground truth (Gemini gate round-3
    finding — cross-workstream integration gap)**: WS1's correlator runs
    automatically BEFORE any human labeling, so an LLM hallucination or a
    genuinely non-reproducible persona finding gets auto-emitted as
    `audit_missed` (correctly penalizing nothing at that point — it looked
    like a real miss). When a human later labels that SAME
    `persona_finding_hash` `dismissed`/`wont_fix` via WS4, the `label`
    command additionally deletes any `audit_missed` correlation rows
    (`audit_finding_id IS NULL`) for that hash across ALL sessions — the
    same cleanup pattern WS1's manual-repair path already uses (round-2
    G2), applied here to the dismissal path: a human rejecting a finding
    retires its false ground truth exactly the same way a human confirming
    it retires the stale miss. `confirmed_hit`/`severity_understated`
    correlation rows are untouched by a `fixed`/`stale` label (those
    outcomes don't contest the correlation's truth, only the finding's
    current status).
- **Worksheet-first labeling** (per the standing PowerShell-safe operator-doc
  rule — never raw-JSON queues): `cross-skill.mjs persona-outcomes
  --worksheet` renders **ACTIONABLE** P0/P1s, not merely "unlabeled" (Gemini
  gate round-3 finding — "unlabeled" is a dead end for regressions: a
  finding relabeled `fixed` but reappearing in a newer session already HAS
  a ledger row, so a naive unlabeled-only filter would hide it from the
  exact surface meant to re-adjudicate it, leaving the ship gate blocked
  with an empty worksheet). Actionable = NO ledger row exists for the hash
  OR the ledger's latest outcome is `fixed`/`stale` **and** the finding was
  observed in the CURRENT (latest) session — i.e. the same set the
  ship-gate summary's `openP0`/`openP1` counts, so the worksheet and the
  gate can never disagree about what's still open. **Bounded + ordered**:
  the last **10** sessions by `created_at DESC`, max **50** worksheet rows,
  newest first; when clipped, the header states "N older unlabeled
  findings not shown — re-run after labeling" (never silent truncation).
  `persona-outcomes label --session <id> --hash <h> --outcome fixed
  [--rationale "..."]` upserts one row. Reuses
  [`scripts/lib/adjudication-worksheet.mjs`](../scripts/lib/adjudication-worksheet.mjs)
  (the shared renderer built for exactly this shape).
- **End-to-end ship-gate read path (machine-readable, via the store — never
  raw SQL in a SKILL.md)**: new `cross-skill.mjs persona-outcomes summary
  [--repo <name>]` returns
  `{ ok, cloud, sessionId, sessionCreatedAt, persona, verdict, rawP0: n,
  rawP1: n, labeled: { closed: n, open_relabeled_fixed: n,
  open_relabeled_stale: n, unlabeled: n }, openP0: n, openP1: n }`
  (`persona`/`verdict` added at code-audit time — the plan text's original
  shape omitted them despite `/ship`'s own UX-GATE warning template
  needing both, a real spec/consumer mismatch caught by the code audit,
  not by any unit test) for the repo's LATEST session's
  raw P0/P1 findings joined against the REPO-level outcome ledger's latest
  row per hash (per the regression-handling rule above — `dismissed`/
  `wont_fix` close a finding durably across sessions; `fixed`/`stale`/no
  row leave it open, so a real regression is never silently suppressed).
  Hash validation on `label`: the store verifies the supplied hash exists
  in the target session's findings (via the shared `personaFindingHash`
  from WS1) — an unknown hash is a friendly CLI error, never a silent
  orphan row.
  - **Closed failure semantics for `/ship` (fail-open to today's behavior,
    NEVER a new blocker — the gate is non-blocking by contract)**:
    `cloud: false` → `/ship` proceeds without the UX gate exactly as its
    existing cloud-off path does today; **no session found** →
    `{ ok: true, sessionId: null }`, gate silent (same as today's
    no-recent-session path); **store/query failure** →
    `{ ok: false, error }`, `/ship` logs one warning line and falls back
    to the existing `get-persona-sessions-by-repo` raw `p0_count` read
    (today's exact source), so a summary-command regression can never
    make the ship gate stricter OR blind — it degrades to the current
    behavior. `/ship` Step 0.5a calls THIS command first (replacing the
    raw read as the primary); zero outcome rows → `openP0 === rawP0`,
    byte-identical gate behavior to today.
  - **The worksheet is surfaced where the gate already fires** (dead-loop
    prevention, made concrete): when `openP0 > 0`, `/ship` Step 0.5a's
    existing UX-GATE warning block appends one passive line —
    `Label fixed/dismissed P0s: node scripts/cross-skill.mjs
    persona-outcomes --worksheet` — same passive-log convention as the
    Step 6.5 security hint (`/ship` is `disable-model-invocation: true`;
    a printed command, never a prompt). The labeling surface therefore
    rides a step that already fires whenever there is anything to label.
- Deliberately NOT auto-labeled: outcome requires human/agent verification
  that the fix landed (the re-verify-on-live-env memory) — the worksheet is
  the surface for that judgment.

## 3. Sequencing + right-sizing

Order: WS1 → WS2 → WS3 → WS4 (leverage order; WS3 becomes more valuable
after WS1 emits rows). Each WS is independently shippable + auditable
(`/audit-code --scope diff` per WS, Gemini gate each).

- **Band-aid rejected**: re-instructing the skill to "really do Phase 6b
  this time" — the mechanism already says MANDATORY and produced 0 rows in
  ~5 weeks of overlap; agent-discretionary emission IS the root cause.
- **Over-engineering rejected**: an LLM-based semantic correlator
  (embedding similarity between persona findings and audit findings) — the
  schema's own `match_score` supports fuzzy, but the canonical `semanticId`
  contract + file/keyword overlap covers the realistic match space at zero
  API cost; embeddings can be a v2 if measured match-rate is poor
  (revisit trigger: >50% of confirmed-by-eye pairs missed by the
  deterministic matcher across 10 sessions).
- **Not in scope**: fixing the 7-week session staleness itself (that's
  usage, not tooling — surfaced by WS3's staleness banner); visual-audit /
  click-test persistence (no equivalent designed-but-dead loop found —
  assess separately after these land).

## 4. Files

| File | Action | WS |
|---|---|---|
| `scripts/lib/persona/audit-correlator.mjs` | new | 1 |
| `scripts/lib/store/persona.mjs` | extend (candidate-set read + correlation-count read) | 1,3 |
| `scripts/cross-skill.mjs` | extend `record-persona-session` (autoCorrelate), wire `record-nav-audit-run`, add `persona-outcomes` | 1,2,4 |
| `skills/persona-test/SKILL.md` + references | Phase 6b rewrite (verify-not-emit) | 1 |
| `supabase/migrations/<ts>_correlations_missed_unique.sql` (partial unique index for NULL-match idempotency + `matcher_version int` column) | new | 1 |
| `supabase/migrations/<ts>_nav_audit_runs.sql` | new | 2 |
| `supabase/migrations/<ts>_persona_finding_outcomes.sql` | new | 4 |
| `scripts/lib/store/nav-audit.mjs` | new | 2 |
| `scripts/nav-audit.mjs` | extend (non-discretionary record-nav-audit-run call on completion) | 2 |
| `scripts/lib/dashboard/collect-nav.mjs` | aging source → cloud-first | 2 |
| `scripts/lib/dashboard/{collect-telemetry,schema,render}.mjs` + `sections/persona-tests.mjs` | new tab | 3 |
| `skills/ship/SKILL.md` (Step 0.5a) | open-P0 subtraction | 4 |
| `tests/persona-audit-correlator.test.mjs`, `tests/store-nav-audit.test.mjs`, `tests/persona-outcomes.test.mjs`, dashboard test extensions | new | 1,2,3,4 |

## 5. Risks

| Risk | Mitigation |
|---|---|
| Auto-correlator emits garbage matches → poisons bandit reward | Conservative: exact semanticId primary; fuzzy floor 0.5 with score+rationale recorded (auditable); `audit_missed` requires zero matches; kill switch honors existing `LEARNING_DISABLE=1` |
| Correlator slows the session write | Runs after the session row commits; best-effort; single batched candidate read |
| nav_audit_runs grows unbounded | Same posture as tiered_shadow_observations — bounded by real run frequency; sinceDays window on reads; revisit trigger documented in store header |
| Outcome labels never get used (dead loop #2) | Worksheet surfaced by `/ship`'s existing UX-gate output when open P0s exist — the label surface rides a step that already fires |

## 6. Audit Trail

`/audit-plan` — `--mode plan`, run-unified via `--run-id` (dogfooding the
plan-audit cloud parity feature shipped earlier the same session).

**GPT loop — 3 rounds (max cap reached, HIGH count plateaued, not
increased — a legitimate stop, not rigor pressure):**

| Round | Verdict | H | M | L | Outcome |
|---|---|---|---|---|---|
| 1 | NEEDS_REVISION | 6 | 3 | 0 | all 9 accepted + fixed in plan |
| 2 | SIGNIFICANT_GAPS | 5 | 2 | 0 | all 7 accepted + fixed in plan (0 re-raises) |
| 3 | SIGNIFICANT_GAPS | 5 | 3 | 1 | all 9 accepted + fixed in plan |

25/25 GPT findings across 3 rounds accepted and folded into the plan text
— zero dismissals, zero deferrals (every finding was a genuine
specification gap in a plan whose entire purpose is closing
underspecified dead loops, so "argue it away" would have defeated the
plan's own thesis). Notable catches: Postgres NULLs-are-distinct breaking
the `audit_missed` idempotency design (R1); my own R2 fix for that
introducing a WORSE bug — emitting `audit_missed` with no candidate audit
run at all, which would have poisoned ground truth (R3 caught it,
self-correcting the loop's own prior round); the canonical
`persona_finding_hash` definition being needed exactly once and shared by
both WS1 and WS4 rather than re-derived (R3).

**Gemini gate — 3 rounds (2 normal + 1 genuine-bug exception; hard cap
reached, loop closed with `CONCERNS` outstanding):**

| Round | Verdict | New findings | Outcome |
|---|---|---|---|
| 1 | `CONCERNS_REMAINING` | G1 (nav dirty-tree cloud pollution, MEDIUM), G2 (persona outcome "session amnesia", HIGH) | both fixed |
| 2 (exception — G1/G2 were concrete design defects, not rigor pressure) | `CONCERNS` | G1 (Jaccard math wrong for disjoint-size vocabularies → near-100% false-negative correlator, HIGH), G2 (manual repair leaves stale contradictory ground truth, HIGH), G3 (scope-normalization self-contradiction, LOW) | all 3 fixed |
| 3 (hard cap — no round 4 regardless of finding character) | `CONCERNS` | G1 (worksheet filters out regressions — dead end, HIGH), G2 (dismissal doesn't retire a false `audit_missed`, MEDIUM), G3 (no temporal bound on candidate audit runs — stale-audit penalty, MEDIUM) | all 3 fixed in text, **not re-verified** |

8/8 Gemini findings across 3 rounds accepted and fixed. Every Gemini round
independently found real defects specifically in the ground-truth
integrity of WS1's correlator and its interaction with WS4's labeling —
the single highest-stakes new mechanism in this plan, and exactly where
adversarial review earned its cost. The round-3 findings were fixed in
plan text (all cheap, mechanical, clearly correct) but **not re-verified
by a 4th Gemini round**, per the skill's hard cap (2 normal + at most one
genuine-bug exception — never open-ended, even when every new round keeps
finding real issues on an artifact with intrinsically infinite refinement
surface). Residual risk is judged acceptable: these three (worksheet
actionable-set definition, dismissal cascade, temporal candidate bound)
are all plan-TEXT edits with no remaining design ambiguity, and
`/audit-code` will verify the actual implementation against real code —
the correct backstop for anything a further plan-level round might still
surface.

**Convergence assessment**: HIGH count 6→5→5 (GPT) did not meaningfully
drop round-over-round, which by the plan-audit skill's own convergence
table would normally argue for stopping GPT rigor-pressure escalation —
but each round's findings were verifiably NEW (0 re-raises across all 3
rounds per `_suppression.suppressed: 0` every round) and concretely
different defects, not restatements — so continuing to the max-3 cap was
warranted rather than rigor pressure. The same held for Gemini: three
rounds, zero repeated findings, every finding a distinct concrete defect.

33 total findings (25 GPT + 8 Gemini) recorded to the cloud learning
store via the unified `run-id`; outcomes captured automatically each
round (dogfooding the plan-audit cloud parity feature) plus one manual
capture for the final GPT round (no round 4 to carry it automatically).

## 11. Execution Clustering

Added post-approval (mechanical/structural only — no design content
changed; the file scope below is copied verbatim from §4) so
`/cycle --autonomous` can execute this plan cluster-by-cluster with real
scope enforcement and fix-gates, per the dependency graph established
during plan review: WS1 and WS2 are mutually independent; WS4 has a hard
dependency on WS1 (`personaFindingHash()` + `persona_audit_correlations`
schema); WS3 has a soft ordering preference for WS1 (richer data) but no
hard block.

### Cluster 1 — WS1: Deterministic persona↔audit correlator

- Coupling: none (foundational — no upstream dependency)
- Files: `scripts/lib/persona/audit-correlator.mjs` (create),
  `scripts/lib/store/plans-ship.mjs` (modify — candidate-set read,
  existence-check read, and the manual-repair/dismissal-cascade delete
  logic; **reconciled at implementation time**: the declared target was
  `scripts/lib/store/persona.mjs`, but `persona_audit_correlations` CRUD
  already lived in `plans-ship.mjs` — co-locating there matches the
  codebase's existing domain-module convention rather than splitting one
  table's logic across two files), `scripts/cross-skill.mjs` (modify —
  `record-persona-session` autoCorrelate wiring + `record-correlation`
  discriminated-result propagation only, NOT the WS2/WS4 additions),
  `skills/persona-test/SKILL.md` + `references/audit-correlation.md`
  (modify — Phase 6b rewrite + hash-formula correction), `supabase/migrations/<ts>_correlations_missed_unique.sql`
  (create), `tests/persona-audit-correlator.test.mjs` (create),
  `tests/learning-store-exports.test.mjs` (modify — pinned public-surface
  contract update for the 3 new plans-ship.mjs exports; mechanically
  coupled to the plans-ship.mjs change, not a separate concern)
- fix-gate: yes

### Cluster 2 — WS2: nav-audit v2 run persistence

- Coupling: independent of Cluster 1 (no shared state or output
  dependency; ordered second per explicit operator sequencing, not
  technical necessity)
- Files: `supabase/migrations/<ts>_nav_audit_runs.sql` (create),
  `scripts/lib/store/nav-audit.mjs` (create), `scripts/nav-audit.mjs`
  (modify — non-discretionary producer call, static path only; the
  `--verify` live path produces a structurally different finding shape —
  no `drift_keys` — and is out of scope here), `scripts/cross-skill.mjs`
  (modify — wire `record-nav-audit-run` + `get-nav-first-seen`, additive
  to Cluster 1's edit), `scripts/lib/dashboard/collect-nav.mjs` (modify —
  cloud-first aging source, now sourced via `listNavAuditRunHistory` +
  the pre-existing `firstSeenFromHistory` reducer in `lib/nav/drift.mjs`
  rather than a new server-side aggregation — reuses already-tested code
  the gap table itself named as "designed cloud-sourced but never wired"),
  **additional files reconciled at implementation time** (mechanically
  required by `collectNav` becoming `async`, not a separate concern):
  `scripts/lib/dashboard/collect-reference.mjs` (modify — `await
  collectNav(...)`, `collectReference` becomes `async`),
  `scripts/build-dashboard.mjs` (modify — `await collectReference(...)`),
  `tests/nav-dashboard.test.mjs` + `tests/nav-verify-store.test.mjs`
  (modify — existing `collectNav` call sites updated to `await`),
  `tests/store-nav-audit.test.mjs` (create),
  `supabase/migrations/<ts>_nav_audit_runs_content_hash.sql` (create —
  **added at code-audit time**, rounds 2-3, H2/H6/M3: the original
  `(repo_id, head_sha, scope)` identity doesn't represent what a
  `scope: 'diff'` run actually audited — the uncommitted working tree,
  which `head_sha` alone can't capture. Adds a `content_hash` column
  (a stable hash of the sorted `drift_keys`) to the conflict target so
  two diff-scope runs at the same commit with genuinely different
  audited content persist as distinct rows instead of the second
  silently colliding with `DO NOTHING`. This also SURFACED a real
  pre-existing bug: `recordNavAuditRun` used `insertReturning` —
  `db/query.mjs`'s plain-`INSERT` helper, which silently ignores
  `onConflict`/`update` entirely — instead of `upsert()`, the
  conflict-aware helper; an empirical DB smoke test (not any unit test)
  caught it, fixed by switching to `upsert()`)
- fix-gate: yes

### Cluster 3 — WS4: Persona finding outcome labels

- Coupling: depends on Cluster 1's `personaFindingHash()` export (shared
  identity function) and `persona_audit_correlations` schema (the
  dismissal-cascade cleanup deletes rows from it) — must run after
  Cluster 1
- Files: `supabase/migrations/<ts>_persona_finding_outcomes.sql`
  (create), `scripts/cross-skill.mjs` (modify — add `persona-outcomes`,
  additive to Clusters 1+2's edits), `skills/ship/SKILL.md` (modify —
  Step 0.5a open-P0 subtraction), `tests/persona-outcomes.test.mjs`
  (create), **additional files reconciled at implementation time**:
  `scripts/lib/store/persona-outcomes.mjs` (create — the declared list
  didn't name a dedicated store module; co-locating ~150 lines of new SQL
  directly in `cross-skill.mjs` would compound the "God CLI" debt already
  flagged and dismissed as pre-existing across Clusters 1-2's audits — a
  new file matches the established per-domain-module convention),
  `supabase/migrations/<ts>_persona_finding_outcomes_touch_trigger.sql`
  (create — an empirical DB smoke test caught real clock skew between
  this machine and the remote Supabase instance: `updated_at`, set from
  the client's JS clock, read EARLIER than `created_at`, set from the
  DB server's clock, after a genuine insert-then-update round trip.
  Fixed with the established `touch_*_updated_at` BEFORE UPDATE trigger
  pattern already used by `security_incidents`/`memory_friction` — same
  server clock for both columns), `scripts/lib/store/plans-ship.mjs`
  (modify — code-audit H5 fix: Cluster 1's `retireMissedCorrelationsForHash`
  had NO repo scope despite its own docstring's claim, so two different
  repos coincidentally sharing a `persona_finding_hash` could
  cross-contaminate each other's ground truth; the function signature
  gained a required `repoId` parameter and its DELETE now joins through
  `persona_test_sessions.repo_id` — a real latent bug in Cluster 1's code,
  surfaced only because WS4 became its second, first-ever caller)
- fix-gate: yes

### Cluster 4 — WS3: Persona telemetry dashboard section

- Coupling: soft — renders correctly with zero data regardless, but is
  materially more useful once Cluster 1 (and ideally Cluster 3) have real
  rows; ordered last, no hard block
- Files: `scripts/lib/store/plans-ship.mjs` (modify — correlation-count
  read, additive to Cluster 1's edit; corrected from `persona.mjs` per
  Cluster 1's reconciliation note above), `scripts/lib/dashboard/{collect-telemetry,schema,render}.mjs`
  (modify), `scripts/lib/dashboard/sections/persona-tests.mjs` (create),
  dashboard test extensions (modify/create)
- fix-gate: none

Final gate: mandatory consolidated Gemini review over the union diff of
all four clusters, run once ALL FOUR clusters have converged (per
`/cycle` Step 3C.2) — separate from, and in addition to, the plan-level
Gemini gate already recorded in §6 Audit Trail above (that gate reviewed
the PLAN; this one reviews the IMPLEMENTATION). A partial run (e.g. only
Clusters 1–2 this session) defers this gate until Clusters 3–4 also land.

## Implementation Log

### 2026-07-13 (two `/cycle --autonomous` sessions: Clusters 1-2, then Clusters 3-4)

- **Completed**: all 4 workstreams. WS1 (`scripts/lib/persona/audit-correlator.mjs`,
  auto-wired into `record-persona-session`), WS2 (`scripts/lib/store/nav-audit.mjs`,
  wired into `nav-audit.mjs` + dashboard drift aging), WS4 (`scripts/lib/store/persona-outcomes.mjs`,
  `persona-outcomes summary|label|--worksheet` CLI, wired into `/ship`'s UX gate),
  WS3 (`scripts/lib/dashboard/sections/persona-tests.mjs`, new "Persona Tests"
  telemetry tab). Every cluster ran its own GPT multi-round `/audit-code` to
  convergence (or one documented round for Cluster 4, fix-gate: none). The
  mandatory consolidated Gemini gate over the union diff of all 4 clusters
  APPROVED on round 1 with zero new findings.
- **Remaining**: nothing — all four workstreams shipped in this plan's scope.
  The plan's own "Out of Scope (Future)" items (an LLM-based semantic
  correlator, the 7-week session-staleness usage gap itself, visual-audit/
  click-test persistence) remain genuinely deferred, not partial work.
- **Deviations from the plan text** (each reconciled in its cluster's §11
  declaration above at implementation time, not silently):
  - Cluster 1's declared store target `scripts/lib/store/persona.mjs`
    corrected to `plans-ship.mjs` (where `persona_audit_correlations` CRUD
    already lived).
  - Cluster 1's canonical hash-identity formula corrected from the plan's
    `{severity, category, element, observed}` to the REAL, already-documented
    persona-finding shape `{code, element, observed}` (`code` IS severity;
    no separate `category` field exists) — verified against live session
    data before writing the correlator, not assumed from plan text.
  - The fuzzy-matcher threshold was strengthened TWICE beyond the plan's
    original 0.5 (a dual-signal floor, then 0.5→0.6, then a
    `MIN_INFORMATIVE_TOKENS` floor) in response to genuine code-audit
    findings about false-ground-truth risk from generic vocabulary overlap.
  - Cluster 2's `nav_audit_runs` uniqueness gained a `content_hash` column
    (not in the original plan) after code-audit found a real diff-scope
    data-loss collision the plan's `(repo_id, head_sha, scope)` identity
    didn't account for.
  - Cluster 3's `retireMissedCorrelationsForHash` (a Cluster-1 function)
    gained a required `repoId` parameter — a real latent cross-repo
    contamination bug in Cluster 1's code, invisible until WS4 became its
    first real caller.
  - Two genuine bugs were caught ONLY by empirical DB smoke tests, never by
    a unit test: `insertReturning`-vs-`upsert` (dedup completely
    non-functional in WS2) and client/server clock skew in WS4's
    `updated_at` column (fixed with a DB-side touch trigger, matching the
    established `security_incidents`/`memory_friction` pattern).
  - Cluster 3/4's declared `Files:` lists didn't name dedicated store
    modules; `scripts/lib/store/persona-outcomes.mjs` was added to match
    the established per-domain-module convention rather than growing
    `cross-skill.mjs` further (the recurring, dismissed-as-pre-existing
    "God CLI" finding across every cluster's audit).
