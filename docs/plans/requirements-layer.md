# Plan: Requirements Layer — a materialized view of the codebase's de-facto requirements

- **Date**: 2026-05-17
- **Status**: Complete
- **Author**: Claude + Louis
- **Scope**: backend

> **Target domain(s)**: `shared-lib`, `audit-orchestration`, `scripts`.
> ⚠ **Cross-domain work** — a new `requirements` domain consumed by the
> audit pipeline; boundary crossings are intentional.

---

## 1. Context Summary

**Scope/stack**: backend · `js-ts` (Node ESM).

### The problem & the de-risking

`claude-engineering-skills` audits *code against a plan* and *plans against
principles* — but it has no **requirements** layer: the set of invariants
the system must keep true. Requirements are the one classical-SE artefact
that generated-architecture cannot synthesise (they encode *intent*, which
isn't in the code) — established across two `/brainstorm` rounds.

A **passed extraction spike** de-risked the core premise: `gpt-5.5`
extraction against two invariant-rich files produced **~100% keepable**,
correctly-abstracted, checkable requirement assertions; **~87% run-to-run
stability** (the ~13% delta complementary, zero contradictions); and a
**sabotage acid test** — re-introducing a known bug — was caught precisely
by the relevant requirement, **zero false positives**. The premise holds:
an LLM extracts checkable invariants at the right level, stably.

### What exists today (Phase 1 exploration — reuse, don't reinvent)

| Piece | File | Role here |
|---|---|---|
| `getRepoContext` — tiered context, fallback state machine, token budgeting, commit-SHA stamping | `scripts/lib/repo-context.mjs` | The pattern (and budgeting) for surfacing requirements as context |
| arch-intent — declared-contract-vs-reality **drift engine** | `scripts/lib/arch-intent/*`, `runArchitecturePass` | The drift-check (Phase 2) is arch-intent with a new edge type |
| `arch-intent-bootstrap.mjs` `generateBaseline` | — | Prior art: "generate a baseline contract from the code" — directly analogous to extracting a requirements baseline |
| Zod schema patterns; `FindingSchema`, acceptance-criteria shape | `scripts/lib/schemas.mjs`, `/plan` §10 | The `RequirementSchema` mirrors these (ID'd, kind-tagged, checkable) |
| Structured-output LLM call (`responses.parse` + Zod) | `scripts/openai-audit.mjs`, `scripts/lib/llm-wrappers.mjs` | The extraction + gap-challenge calls reuse this |
| `repo-inventory.mjs` `listRepoFiles`, `module-graph.mjs` | — | File/symbol resolution for provenance + (Phase 2) drift links |
| `atomicWriteFileSync`, `semanticId`, `jaccardSimilarity` | `scripts/lib/file-io.mjs`, `scripts/lib/findings.mjs` | Atomic ledger writes; cheap text-similarity merge |
| audit prompt assembly (`fileListContext` slot) | `openai-audit.mjs`, `scripts/lib/audit/prompt-builder.mjs` | Where the requirements *rubric* is injected |

### Neighbourhood considered (Phase 0.5)

`get-neighbourhood` returned 50 candidates, **all `recommendation: review`**
(cosine 0.66–0.73, none ≥ 0.75) — no reuse/extend target; the new
`requirements/` modules are genuinely greenfield. `initAuditBrief` /
`_llmCondense` (0.67–0.73) and `runArchitecturePass` (0.70) confirm the
LLM-condense + declared-contract patterns to mirror, not duplicate.

---

## 1.5 Execution Model

The pipeline is **sequential stages**, not concurrent operations:

```
extract (run ×2, PARALLEL) → merge → gap-challenge → write candidates
        → human refine (overrides) → reconcile → ledger + index
                                              → getRequirementsContext
                                              → /audit-code rubric
```

- The **two extract runs are independent** → `Promise.all`. Partial failure
  (one run fails) **degrades to a 1-run extraction** with a stderr warning —
  never aborts (graceful degradation, #16). Both fail → the CLI exits
  non-zero; no ledger is written.
- Everything after `merge` is **strictly serial** — each stage consumes the
  prior stage's output.
- The **ledger write is atomic** (`atomicWriteFileSync` — temp+rename) so a
  crash mid-write cannot corrupt `.requirements/ledger.json` (#14).
- `reconcile` is **idempotent**: re-running it over the same
  candidates + overrides yields a byte-identical ledger (#13).
- No rollback semantics — the pipeline is regenerate-from-source; a failed
  run leaves the prior committed ledger untouched.

---

## 2. Proposed Architecture

```
                          scripts/requirements.mjs   (CLI)
                          extract | reconcile | index
                                   │
   ┌───────────────────────────────┼────────────────────────────────┐
   │ scripts/lib/requirements/                                       │
   │  schema.mjs      RequirementSchema, RequirementsLedgerSchema     │
   │  extract.mjs     extractRequirements({files,runs}) → candidates  │
   │                  (structured LLM ×2, merge by assertion sim)     │
   │  gap-challenge.mjs  classifyGaps(candidates) → observed-unintended│
   │                  / intended-unobserved / untested / contradictory│
   │  ledger.mjs      loadLedger / writeLedger (atomic) / reconcile    │
   │                  (candidates + overrides → active ledger+index)  │
   │  context.mjs     getRequirementsContext({targetPaths}) → block    │
   └───────────────────────────────┬────────────────────────────────┘
                                    │
                .requirements/   (committed — the materialized view)
                  candidates.json   generated extraction output
                  gaps.json          generated gap-challenge assessments
                  ledger.json       reconciled active requirements — the
                                     SINGLE persisted artefact read at audit
                                     time; the "index" is derived from it
                                     in-memory (no separate index file —
                                     audit R2-H3)
                  overrides.json     small human-curated accept/reject/edit
                                    │
   openai-audit.mjs  runMultiPassCodeAudit → injects the requirements
   (Plan-Phase B)    rubric (in-scope assertions) into the audit prompt
```

### Plan-Phase A — the data layer (extract → ledger)

**`scripts/lib/requirements/schema.mjs`** — Zod, mirroring `FindingSchema`. Three
distinct contracts (resolves audit H2 — a *candidate* is by definition
observed-in-code, so the gap classes are not all candidate properties):

```
# What extraction emits (observed in code — a hypothesis, not yet a requirement):
RequirementCandidateSchema = {
  id:        content-derived stable key — see "Identity" below
  assertion: string (≤200, one sentence),
  kind:      enum(security|safety|correctness|behavioural|persistence),
  checkable: boolean,
  provenance:  { file, anchor }[]   # WHERE it is declared/evidenced — MULTI-valued
  appliesTo:   string[]             # files/globs the invariant GOVERNS (audit H3)
  evidence:  { code: string[], tests: string[] },
  seenInRuns:  int,   confidence: enum(high|medium|low),
}

# What gap-challenge emits — a separate assessment keyed by candidate id:
GapAssessmentSchema = {
  requirementId: string,
  gap: enum(none|observed-but-unintended|untested|contradictory),  # `none` is valid
  conflictsWith: string[],          # requirement ids (when gap=contradictory)
  rationale: string,
}
# NOTE: `intended-but-unobserved` is NOT a candidate/gap annotation — intent
# absent from code cannot be extracted. It is a refine-step / Phase-2 concern
# (compare human-supplied intent to candidates); explicitly out of v1 extraction.

# The reconciled active requirement (candidate + gap + override applied):
RequirementSchema = RequirementCandidateSchema + {
  status: enum(active|needs-review|superseded|inferred-only),
  # `needs-review` — has an unresolved `contradictory` gap; NOT active until an
  #  override resolves it (audit H4). `inferred-only` — low-confidence/unconfirmed.
  gap:        GapAssessmentSchema | null,
}

RequirementsLedgerSchema = {
  generatedAt, commitSha,           # commit the ledger was reconciled at
  extractionSourceSha,              # commit the code was extracted FROM (audit M3)
  coveredFiles: string[],           # files extraction actually read (M3 freshness)
  requirements: RequirementSchema[],
  identityAliases: { [rewordedCandidateId]: frozenLedgerId }, # reworded
                              # candidate's new content-seeded id → its frozen
                              # ledger id, so reconcile routes it back (audit H1, G3)
}
```

**Identity — content-seeded at birth, then FROZEN (resolves audit H1, R2-M1,
R2-M3)** — a requirement's `id` (`REQ-<kind>-<hash8>`, hash over
`kind + normalized(assertion) + sorted(provenance.file)`, via the repo's
`semanticId()` pattern) is content-*seeded* the first time a requirement is
minted, then **persisted in the ledger and never changes** — not for an
extraction reword, not for an override edit. The ledger IS the identity
registry. `reconcile` matches each incoming candidate to an existing ledger
requirement in this order: (1) **exact id**; (2) **`identityAliases`
lookup** — the reworded candidate's id maps directly to a frozen ledger id;
(3) **exact content fingerprint**; (4) **unambiguous 1:1 alias** — exactly
one vanished id and exactly one new candidate, mutual-best
`jaccardSimilarity` above threshold — reuse the frozen ledger id and record
an `identityAliases` entry `{ rewordedCandidateId → frozenLedgerId }` so the
next reconcile resolves it in step (2) without re-similarity-matching
(audit G3 — the map is keyed by what extraction *produces*, routing to the
frozen id, not the useless reverse). A **split (1→≥2),
merge (≥2→1), or ambiguous match** is NOT auto-carried — it is surfaced as
`status:'needs-review'` for the human (audit R2-M3). Genuinely-new
candidates mint a fresh id. Because the id is frozen, an `overrides.json`
assertion-edit keeps the same id (audit R2-M1) and the override key never
goes stale.

**`extract.mjs`** — `extractRequirements({ files, baseDir, runs=2 })`:
- **Sensitive-egress guard on every input (audit R2-H4)** — `--files` is
  user-supplied, so each resolved path is checked through the repo's
  `sensitive-egress-gate.mjs` (and `isSensitivePath`) **before being read
  or sent to the LLM**. A path matching the denylist is refused with a
  clear error — inventory exclusion alone is not sufficient for
  user-specified inputs. No file content reaches an external model
  unvetted.
- **Chunking (audit G2)** — the target files are token-counted; if the
  combined payload exceeds a safe threshold (~60k tokens) `extract` batches
  the files, runs the extraction passes per batch, and merges across
  batches (the same `mergeRequirements` path). A large `--files` set never
  blows the model context window.
- A structured LLM call per run/batch (reuse the `openai-audit.mjs`
  `responses.parse` + Zod pattern), the **descriptive** extraction prompt
  (de-facto = hypothesis; "what the code enforces", not "what should be").
- `runs` calls fire in `Promise.all`; **merge**: two assertions are "the
  same" when `jaccardSimilarity(a,b) ≥ MERGE_THRESHOLD` AND same `kind`;
  each survivor carries `seenInRuns` (1 or 2). `seenInRuns:1` → `confidence:
  low` — flagged for the human (the spike's ~13%-delta finding, #19).
- Emits `RequirementCandidateSchema[]`. IDs are **content-derived**
  (`REQ-<kind>-<hash8>` over kind + normalized assertion + provenance —
  see "Identity", audit H1), never positional and never LLM-supplied, so
  insert/delete never renumbers and re-runs diff cleanly.

**`gap-challenge.mjs`** — `classifyGaps(candidates, { baseDir })` → a
`GapAssessmentSchema[]` keyed by requirement id. One low-reasoning LLM pass
tags each candidate `none` | `observed-but-unintended` | `untested` |
`contradictory` (with `conflictsWith` ids + rationale). **Not**
`intended-but-unobserved` — intent absent from code is unextractable
(audit H2); that class is a Phase-2 / refine concern. Advisory — never
blocks (#16).

**`ledger.mjs`** — `loadLedger` / `writeLedger` / `reconcile` / `deriveIndex`:
- `reconcile(candidates, gapAssessments, overrides, priorLedger)` → the
  **active ledger** (one file). The SINGLE place candidate + gap + human
  input merge (#5). Idempotent (#13 — re-run → byte-identical).
- **Partial-extraction merge semantics (audit G1 — data-loss guard)** —
  `extract --files` covers only a subset, so `reconcile` is a **scoped
  merge, never a wholesale replace**: (1) the new ledger's `coveredFiles` =
  `union(prior.coveredFiles, newly-extracted)`; (2) a prior requirement
  whose `provenance` files do **not** overlap the new extraction set is
  **retained unchanged** (it was not re-examined — keeping it is correct,
  deleting it would wipe the ledger); (3) only requirements whose
  `provenance` IS within the new extraction set are replaced/updated by the
  new candidates. A `--files a.mjs` run never touches requirements about
  `b.mjs`.
- `deriveIndex(ledger)` → the `{id, assertion, kind, status}` index — a
  pure in-memory projection, **not a persisted file** (audit R2-H3: a
  separate `index.json` could be observed out of sync with `ledger.json`
  between two renames; deriving it from the one ledger file removes the
  consistency problem and the need for reader-side locking entirely).
- `overrides.json` keys by the **frozen id** (see "Identity"); `reconcile`
  resolves `identityAliases`.
- **Status lifecycle (audit R2-M2, G1)** — `reconcile` sets `status` by
  this table: override `accept` → `active`; override `reject` → omitted;
  an unresolved `contradictory` **OR `observed-but-unintended`** gap →
  `needs-review` (audit G1 — `observed-but-unintended` means the code does
  something likely *unintended*, i.e. a candidate bug; if it were `active`
  the rubric would tell the auditor to *defend that bug* and flag its
  fix as a violation — so it stays OUT of the active rubric until a human
  adjudicates: confirm-intended → `active`, or confirm-bug → `reject`);
  `seenInRuns:1` and unconfirmed → `inferred-only`; otherwise → `active`.
  `untested` is a **gap annotation, not a status** — an untested
  requirement can still be `active` (no test ≠ wrong); it shows in the
  rubric/refine view as a coverage flag. `conflictsWith` ids on both sides.
- **`seenInRuns` / `confidence` are high-water marks (audit G2)** —
  `reconcile` merges them against the prior ledger
  (`max(prior.seenInRuns, candidate.seenInRuns)`); a requirement once seen
  in 2 runs stays `seenInRuns:2`. A **degraded 1-run extraction** (one
  extract call failed, AC3) therefore never downgrades a previously
  `active` requirement to `inferred-only` — a transient API failure cannot
  corrupt ledger state.
- **Write (audit M2 + R2-H3)**: `extract`/`reconcile` acquire a repo-scoped
  lock (reuse `scripts/lib/brainstorm/file-lock.mjs` `withFileLock`); each output
  file is `atomicWriteFileSync` (#14). With the index no longer persisted,
  there is exactly one consistency-critical file (`ledger.json`) — an
  unlocked reader always sees a coherent whole.

**`scripts/requirements.mjs`** — CLI:
- `extract` — runs extract → merge → gap-challenge and writes BOTH
  `.requirements/candidates.json` AND `.requirements/gaps.json` (audit
  R2-H1 — the gap assessments are a persisted, named artefact, not an
  in-memory hand-off).
- `reconcile` — reads `candidates.json` + `gaps.json` + `overrides.json` +
  the prior `ledger.json` → writes the reconciled `ledger.json`.
- `index` — prints the derived index (`deriveIndex` — no file written).
`--out`, `--json`, 1-line-summary-to-stdout per the repo CLI convention.

### Plan-Phase B — the consumption layer (surface → audit rubric)

**`scripts/lib/requirements/context.mjs`** — `getRequirementsContext({ targetPaths,
baseDir, maxTokens })` → `{ block, indexCount, inScopeCount, tokensEst,
degraded, stale }`. Mirrors `getRepoContext`'s contract (commit-SHA stamp,
budget, graceful degrade — reuses the budgeting pattern):
- **In-scope computation (audit H3, G3)** — a requirement is in-scope when
  any `targetPaths` entry (1) directly matches its `appliesTo` globs or its
  `provenance.file`, or (2) **forward-transitively** matches — the
  `targetPath` *imports* an `appliesTo`/`provenance` file (cheap:
  `module-graph.mjs` `parseImports` on the targetPath only). Reverse edges
  ("a file imports the targetPath") are NOT computed at audit time — that
  needs a whole-repo reverse dependency graph; precomputing it during
  `extract` is a documented Phase-2 enhancement (audit G3). v1 relies on a
  well-populated `appliesTo` as the primary mechanism + forward transitivity
  as the cheap backstop.
- **Budget degradation policy (audit L1 — defined, not deferred)** — fill
  order under `maxTokens`: (1) all in-scope **full** requirement text; (2)
  the **index** (id + one-liner) for everything else; (3) if even the index
  overflows, collapse out-of-scope index rows into per-`kind` summary lines
  with overflow counts. In-scope full text is never dropped before
  out-of-scope index rows.
- **Freshness (audit M3)** — compares `ledger.extractionSourceSha` +
  `coveredFiles` against current HEAD: if any in-scope file changed since
  extraction, set `stale:true` and prefix the block with a visible
  `⚠ requirements ledger may be stale (run requirements.mjs extract)`.
- **Coverage (audit R2-H2)** — v1 allows extraction on a partial file set,
  so the block distinguishes two cases: a `targetPath` *in* `coveredFiles`
  with no matching requirement → genuine "no requirements here"; a
  `targetPath` *outside* `coveredFiles` → **uncovered**, reported as
  `uncoveredTargets: string[]` + a block line `ℹ N target file(s) not yet
  extracted — rubric coverage is partial`. The audit must not read an empty
  rubric for an uncovered file as "no invariants apply."
- Ledger absent → empty block, `degraded:true`.

**Audit rubric wiring (audit M1 — via the shared prompt layer, not a
provider hard-wire)** — `scripts/lib/audit/prompt-builder.mjs` `buildAuditPassPrompt`
accepts the requirements-rubric block as an input (same channel the Phase-3
`getRepoContext` block already flows through — `fileListContext`/a sibling
slot). `runMultiPassCodeAudit` in `openai-audit.mjs` *assembles* the block
via `getRequirementsContext` and passes it in — it does not compose the
prompt. The block is framed as a rubric ("verify the diff violates none of
these repo invariants"). Code mode; non-blocking try/catch.

### Key design decisions

| Decision | Principles | Rationale |
|---|---|---|
| `.requirements/` is **committed**, not gitignored | #5, #19 | It's the cross-cutting materialized view — must be shared, diffable, and syncable to consumer repos. Unlike gitignored `.audit/` telemetry. |
| Ledger is **generated**; humans edit only `overrides.json` | #5, brainstorm "harvest don't author" | An authored ledger rots. Humans adjudicate deltas; the generator owns the rest. |
| Extract runs **2× and merges** | #19 Observability | The spike proved a single run misses ~1 real invariant; `seenInRuns` surfaces low-confidence ones for refine. |
| Merge by **`jaccardSimilarity`**, not embeddings | #2, #17 | Cheap, deterministic, no embed call/network. Embedding-sim is a Phase-2 upgrade if Jaccard proves too coarse. |
| IDs assigned **deterministically post-merge** | #11, #13 | Re-runs produce diffable ledgers; the LLM never owns IDs. |
| Requirements surfaced via a **dedicated `getRequirementsContext`**, not a new `getRepoContext` tier | #2, #3 | Tiers are blast-radius *sizes*; requirements are an orthogonal *source*. Same budgeting contract, separate function. |
| Primary consumer is **`/audit-code` as a rubric**, not a dashboard | brainstorm + spike | The spike proved an auditor catches a real regression from the ledger + diff. The dashboard is Phase 2 / lower value. |
| `de-facto` assertions are **hypotheses** (`status` / `confidence`) until confirmed | #12 Validation | Extraction from working code encodes current behaviour — including bugs — as "correct"; the schema makes that explicit; `gap-challenge` + refine catch it. |

---

## 6. Sustainability Notes

- **Assumption**: extraction stays stable across model upgrades. If a new
  model shifts abstraction level, `seenInRuns` + the spike's acid-test
  recipe (re-runnable) detect it. The extraction prompt is one constant.
- **Requirements rot worse than code** — intent can't be regenerated. The
  Phase-2 drift-check is the mitigation; v1 ships `status` + provenance so
  the rot is at least *visible* (a requirement citing a vanished file is
  inspectable) even before the automated drift-check exists.
- **Extension seams**: the merge similarity fn is swappable (Jaccard →
  embeddings); `kind` is an enum (add a category = one entry); the
  consumer set grows by calling `getRequirementsContext` (audit-plan,
  /ship next).
- **Token ceiling**: the index is capped; if the repo's requirement count
  outgrows ~1–2k tokens the index must summarise by `kind` — a known future
  fork, noted not solved.

---

## 7. File-Level Plan

### Plan-Phase A
- **NEW `scripts/lib/requirements/schema.mjs`** — `RequirementSchema`,
  `RequirementsLedgerSchema`, `OverridesSchema`. Why: #5 single source of
  truth for the requirement contract.
- **NEW `scripts/lib/requirements/extract.mjs`** — `extractRequirements`,
  `EXTRACTION_PROMPT`, `mergeRequirements`, `assignIds`. Pure except the
  LLM call. Why: #3 SRP — extraction isolated from storage.
- **NEW `scripts/lib/requirements/gap-challenge.mjs`** — `classifyGaps`,
  `GAP_PROMPT`. Why: #3 — gap analysis is a separable advisory pass.
- **NEW `scripts/lib/requirements/ledger.mjs`** — `loadLedger`,
  `writeLedger`, `reconcile`, `deriveIndex` (in-memory projection, no
  persisted index file — audit R2-H3). Why: #3 — storage/reconciliation
  isolated; #14 atomic writes.
- **NEW `scripts/requirements.mjs`** — CLI (`extract`/`reconcile`/`index`).
  Why: the repo's `node scripts/<x>.mjs` invocation convention.
- **NEW `.requirements/README.md`** — explains the artefacts
  (`candidates.json`, `gaps.json`, `ledger.json` — generated and
  intentionally absent from a fresh checkout, appearing on first
  `extract`/`reconcile`; `overrides.json` — hand-curated, created by the
  user on demand, also absent until then). The README is the only
  committed file in `.requirements/` at rest.

### Plan-Phase B
- **NEW `scripts/lib/requirements/context.mjs`** — `getRequirementsContext`.
  Why: #2 — one surfacing function, mirrors `repo-context.mjs`'s contract.
- **MOD `scripts/lib/audit/prompt-builder.mjs`** — `buildAuditPassPrompt`
  accepts the requirements-rubric block as an input slot (provider-agnostic;
  audit M1). Why: #2/#3 — prompt composition stays in the shared layer.
- **MOD `scripts/openai-audit.mjs`** — `runMultiPassCodeAudit` *assembles*
  the rubric via `getRequirementsContext` and passes it to
  `buildAuditPassPrompt` (code mode, non-blocking) — it does not compose
  the prompt itself.
- **MOD `skills/audit-code/SKILL.md`** — document the requirement-aware
  rubric; regenerate `.claude/skills/` copy.
- **MOD `scripts/sync-to-repos.mjs`** — add the new `requirements/` modules
  + `scripts/requirements.mjs` to `CORE_SCRIPTS` (lesson from the
  adaptive-context series — a synced script's deps MUST be in the list).

### Tests
- **NEW** `tests/requirements-schema.test.mjs`, `tests/requirements-extract.test.mjs`
  (merge logic — stub the LLM), `tests/requirements-ledger.test.mjs`
  (reconcile idempotency, atomic write), `tests/requirements-context.test.mjs`.

---

## 8. Risk & Trade-off Register

| Risk / trade-off | Severity | Mitigation |
|---|---|---|
| Extraction encodes a current *bug* as a "requirement" | Med | `status:inferred-only` + `confidence` + `gap-challenge` `observed-but-unintended` flag + the human refine step; schema frames de-facto as hypothesis |
| LLM extraction cost / latency on a large repo | Med | v1 extracts per-explicit-file-set (CLI arg), not whole-repo; 2 runs in parallel; structured-output keeps tokens bounded |
| `jaccardSimilarity` merge too coarse → near-dup requirements | Low | `seenInRuns`/`confidence` surface them; merge threshold is one tunable constant; embedding-sim is the documented upgrade |
| Index outgrows the token ceiling | Low (resolved) | Defined budget-degradation order — in-scope full text, then index, then per-`kind` summaries (audit L1, §2 context.mjs) |
| Ledger churn makes `.requirements/` diffs noisy | Low (resolved) | **Content-derived** ids (not positional — audit H1) + stable sort + idempotent `reconcile` → only real assertion changes move lines |
| Concurrent `extract`/`reconcile` runs interleave `.requirements/` | Low (resolved) | Repo-scoped `withFileLock`; coupled ledger+index written under one lock hold (audit M2) |
| A `contradictory` pair both reach the audit rubric | Low (resolved) | `needs-review` status — contradictory requirements are not `active` until an override resolves them (audit H4) |
| `/audit-code` silently consumes a stale ledger | Low (resolved) | `extractionSourceSha` + `coveredFiles` freshness check; `getRequirementsContext` sets `stale` + a visible warning (audit M3) |
| `.requirements/` committed → git merge conflicts on the ledger | Low | Generated + reconciled; conflicts resolve by re-running `reconcile`; hand-edited `overrides.json` is small |
| **Deferred — Phase 2** (documented, not built): the **drift-check** (requirement↔code/test link validation — arch-intent with a new edge type), the **`/ship` mutation-proposal flow** (AI proposes ledger add/update/deprecate at ship, human Y/N), the **`/audit-plan` consumer**, a **precomputed reverse dependency graph** for reverse-edge in-scope matching (audit G3 — v1 does forward transitivity only), and any **architect query/dashboard** surface. v1 ships `status`/provenance so rot is visible; Phase 2 automates catching it. | — | Split out so v1 stays shippable; Phase 2 is its own `/cycle`. |

---

## 9. Testing Strategy

**Unit**:
- `schema` — a valid `RequirementCandidate` / `GapAssessment` / `Requirement`
  parses; bad `kind`/`gap`/missing field rejected.
- `extract` `mergeRequirements` — two stubbed runs: identical assertions
  merge to one `seenInRuns:2`; a run-1-only assertion survives `seenInRuns:1
  confidence:low`; different `kind` never merges.
- **identity (audit H1)** — ids are content-derived; inserting a new
  requirement leaves others' ids unchanged; a reworded requirement produces
  an `identityAliases` entry and its prior override still resolves.
- `ledger` — `reconcile` idempotent (re-run → byte-identical); `overrides`
  `reject` drops, an edited `assertion` applies, `accept` is recorded;
  **a `contradictory` gap with no override → `status:'needs-review'`, not
  `active`** (audit H4); `writeLedger` atomic; `extract`/`reconcile` under
  `withFileLock` (audit M2).
- `context` — `getRequirementsContext` emits the index always; full text
  for in-scope requirements via **direct AND transitive** module-graph
  match (audit H3); ledger-absent → empty + `degraded`; commit-SHA stamped;
  in-scope file changed since `extractionSourceSha` → `stale:true` + warning
  (audit M3); over budget → the §2 degradation order, in-scope full text
  never dropped first (audit L1).

**Integration**: an `openai-audit` code run with a `.requirements/ledger.json`
present injects the rubric block; ledger absent → audit unaffected.

**Edge cases**: both extract runs fail → CLI exits non-zero, no ledger
written; empty file set; a requirement whose `provenance.file` no longer
exists (v1: surfaced via `status`, not yet auto-flagged).

## 10. Acceptance Criteria

Backend — behavioural pass/fail contracts:

- **AC1** — `requirements.mjs extract --files <a,b>` writes
  `.requirements/candidates.json` of schema-valid `RequirementCandidate`s;
  each has `seenInRuns`, multi-valued `provenance[]`, `appliesTo[]`, and a
  **content-derived** `REQ-<kind>-<hash8>` id.
- **AC2** — extraction runs twice; an assertion in only one run survives
  with `seenInRuns:1`, `confidence:low`.
- **AC3** — one failed extract run → degrades to a 1-run result + stderr
  warning, exit 0; both fail → exit non-zero, no file written.
- **AC4** — `gap-challenge` emits a `GapAssessment` per candidate with
  `gap ∈ {none, observed-but-unintended, untested, contradictory}`;
  `intended-but-unobserved` is never produced (unextractable — audit H2).
- **AC5** — `reconcile` is idempotent (re-run → byte-identical ledger);
  `overrides.json` `reject`/edit/`accept` applied at reconcile only.
- **AC6** — identity is position-independent: inserting/removing a
  requirement does not change another's id; a reworded requirement gets an
  `identityAliases` entry so its prior override still applies (audit H1).
- **AC7** — a `contradictory` gap with no resolving override → the
  requirement is written `status:'needs-review'`, **not `active`**, and
  does NOT appear in the audit rubric (audit H4).
- **AC8** — `writeLedger` is atomic and `extract`/`reconcile` hold a
  repo-scoped lock; `ledger.json` is the single persisted artefact (the
  index is derived in-memory, never a separate file), so any unlocked
  reader always sees a coherent whole (audit M2, R2-H3).
- **AC9** — `getRequirementsContext`: emits the derived index; full text
  for in-scope requirements where in-scope = direct OR **forward-transitive**
  (targetPath imports a `provenance`/`appliesTo` file — audit H3/G3) match;
  under budget
  pressure follows the defined degradation order (audit L1); sets
  `stale:true` + a visible warning when in-scope files changed since
  `extractionSourceSha` (audit M3); reports `uncoveredTargets` for target
  files outside `coveredFiles` (audit R2-H2); ledger-absent → empty +
  `degraded`.
- **AC10** — `/audit-code` injects the requirements rubric (via
  `prompt-builder.mjs`, provider-agnostic — audit M1) when a ledger exists;
  unaffected when it does not.
- **AC11** — the new `requirements/` modules + `scripts/requirements.mjs`
  are in `sync-to-repos.mjs` `CORE_SCRIPTS`.
- **AC12** — `requirements.mjs extract` refuses any `--files` path matching
  the sensitive-egress denylist (no unvetted content to the LLM — audit
  R2-H4) and writes both `candidates.json` and `gaps.json` (audit R2-H1).
- **AC13** — `reconcile` sets `status` per the lifecycle table:
  `accept`→`active`, `reject`→omitted, unresolved `contradictory` **or
  `observed-but-unintended`**→`needs-review` (kept out of the audit rubric —
  audit G1), `seenInRuns:1`/unconfirmed→`inferred-only`.
- **AC14** — `reconcile` merges `seenInRuns`/`confidence` as a high-water
  mark vs the prior ledger; a degraded 1-run extraction never downgrades a
  previously-`active` requirement (audit G2).
- **AC15** — full test suite green; `npm run skills:check` green.

## Verification gate

`npm test` green (incl. new suites) · `npm run skills:check` green ·
AC1–AC10 demonstrable · `--scope diff` self-audit clean · a real
`requirements.mjs extract` run on this repo produces a sane candidates file.
