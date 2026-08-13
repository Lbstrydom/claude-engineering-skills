# Plan: Adaptive context "blast radius" + deterministic finding-verification gate

- **Date**: 2026-05-17
- **Status**: Complete
- **Author**: Claude + Louis
- **Scope**: backend

> **Target domain(s)**: `shared-lib`, `audit-orchestration`, `brainstorm`.
> ⚠ **Cross-domain work** — touches the audit pipeline, the brainstorm
> helper, and a new shared-lib module; boundary crossings are intentional
> (one shared context layer consumed by several skills).

---

## 1. Context Summary

**Scope/stack**: backend · `js-ts` (Node ESM).

### The problem

External LLMs in this repo receive context that is **not matched to the
question being asked**. Proven failure: an `/audit-code --scope diff` run
threw **3 of 4 HIGH findings as false positives** — GPT claimed
`schemas.mjs` / `AGENTS.md` / `secret-patterns.mjs` were "missing modules"
purely because those unchanged-but-imported files were absent from its
context window. It conflated *"not in my context"* with *"not in the
repo."* This wastes a rebuttal round on every diff-scope audit.

Two **complementary** fixes (a brainstorm with OpenAI + Gemini converged on
both):

1. **Deterministic finding-verification gate** — eliminates the *provable*
   false-positive class outright, with no LLM. (Highest leverage; ships
   independently.)
2. **Adaptive context "blast radius"** — a context layer whose *slice* and
   *size* are selected by `(intent, scope)`, so each LLM call site gets
   exactly the context its question needs — no more, no less.

"Blast radius" = how far out from the change/question the context net is
cast. A diff audit needs a *small* radius (the touched files + their
immediate import boundary). A whole-repo question needs a *large* one. A
concept question needs *one relevant doc section*. Today every call site
either gets too little (diff audit → "missing module" hallucinations) or a
fixed slice (`/brainstorm --with-arch` always sends `## Architecture`, even
when the question is about the audit subsystem).

### What exists today (Phase 1 exploration — reuse, don't reinvent)

| Piece | File | Role here |
|---|---|---|
| `loadArchSection()` — heading-aware, fence-tracking section parser | `scripts/lib/brainstorm/arch-context.mjs` | **The model for tier T2**; generalize to `loadSection(name)` |
| `readProjectContextForPass()`, `generateRepoProfile()`, AGENTS.md section regex | `scripts/lib/context.mjs` | Existing AGENTS-section extraction + repo profiling |
| `get-neighbourhood` (embedding symbol search) | `scripts/cross-skill.mjs`, `scripts/lib/neighbourhood-query.mjs` | Symbol-existence / duplication check for T3 + the gate |
| `docs/architecture-map.md` (generated symbol index) | — | T3 source |
| `normalizeFindingsForOutput()`, `runMultiPassCodeAudit()` | `scripts/openai-audit.mjs` | Gate hook point — runs after normalize, before verdict |
| Finding schema (`severity`, free-text `category`, `title`, `description`, `is_mechanical`, `_hash`) | `scripts/lib/schemas.mjs` | The gate classifies on `category`/`title`/`description` |
| Tiered-fraction token budgeting | `scripts/lib/brainstorm/provider-limits.mjs`, `resume-context.mjs` | Budget pattern for the context tiers |
| arch-intent file inventory + architecture pass | `scripts/lib/arch-intent/adapter-contract.mjs`, `openai-audit.mjs` `runArchitecturePass` | Possible T0 source; also half of a future `/audit-drift` |

### Neighbourhood considered (Phase 0.5)

`get-neighbourhood` returned 50 candidates, **all `recommendation: review`**
(cosine 0.66–0.69, none ≥ 0.75) — no reuse/extend target; the two new
modules are genuinely greenfield. Closest neighbours are informative, not
duplicative: `inventoryFiles` (`arch-intent/adapter-contract.mjs`) and
`generateRepoProfile` (`context.mjs`) — **T0 should source its file list
from one of these rather than a fresh `git ls-files`**, checked in Phase 2.
`runArchitecturePass` / `runOrphanIntroducedPass` confirm the audit already
has post-pass analysis stages — the gate slots in as a sibling.

---

## 1.5 Execution Model

Three plan phases with a strict dependency chain (resolves audit R2-H1 —
the two shared utilities are **prerequisites of the gate**, so they live in
Phase 1, not Phase 2):

```
Phase 1  shared utils (repo-inventory.mjs, module-graph.mjs)
         + the deterministic gate + the schema change
                                     ── self-contained ──► shippable alone
Phase 2  repo-context.mjs tiers      ── depends on Phase 1's two utils
Phase 3  rewire consumers            ── depends on Phase 2
```

- **Phase 1 is self-contained and shippable alone** — it bundles the two
  shared utilities (`repo-inventory.mjs`, `module-graph.mjs`) it needs,
  plus the gate and the `schemas.mjs` change. It is the highest-leverage
  change — recommend shipping it as its own PR/`/cycle` first.
- **Phase 2 depends on Phase 1's two utilities** (the tiers consume the
  same filtered inventory + AST module-graph the gate does — one source of
  truth, no duplication, no temporary providers).
- **Phase 3 depends on Phase 2** (consumers can't request a tier until the
  tiers exist).
- Within Phase 2, the four tiers are mutually independent (parallel work).
- No atomicity/rollback semantics — every operation is a pure read/compute.
  Partial failure of any tier degrades to a smaller tier or an empty block;
  it never aborts the audit/brainstorm (graceful degradation, #16).

---

## 2. Proposed Architecture

```
                    ┌─────────────────────────────────────┐
   (intent, scope,  │  scripts/lib/repo-context.mjs        │
    targetPaths) ──►│  getRepoContext() → { block,         │
                    │    tier, tokensEst, commitSha }      │
                    │  ┌─ T0 Inventory  flat file list     │
                    │  ├─ T1 Adjacency  T0 + import exports │
                    │  ├─ T2 Section    named AGENTS.md §   │
                    │  └─ T3 Map        full symbol catalog │
                    └─────────────────────────────────────┘
                       ▲          ▲          ▲          ▲
        /audit-code ───┘  /audit-plan │  gemini-review │  /brainstorm
        diff→T1 full→T3    T1 + nbr   │   T0/T1        │   T2 (intent)
                                      │
                    ┌─────────────────────────────────────┐
   audit findings ─►│ scripts/lib/audit/                   │
   (post-normalize) │   finding-verification.mjs           │
                    │ verifyExistenceFindings():           │
                    │  classify "missing X" → resolve vs   │
                    │  filesystem + symbol index →         │
                    │  refuted | confirmed |               │
                    │  requires_verification               │
                    └─────────────────────────────────────┘
                       │ runs in runMultiPassCodeAudit,
                       │ after normalizeFindingsForOutput,
                       ▼ before verdict computation
```

### Phase 1 — Deterministic finding-verification gate (resolves brainstorm finding b)

**New module `scripts/lib/audit/finding-verification.mjs`.**

**Scope — code-audit only** (resolves audit H3). The deterministic
existence gate runs **only in `code` mode**, never `plan` mode: a
plan-audit finding "module X does not exist" is routinely *correct*
because the plan proposes creating X. Verifying plan findings against the
live filesystem would wrongly refute valid ones. For plan-audit the
relevant check is *duplication* — "the plan proposes something that
already exists" — which is a **similarity** question handled by
`get-neighbourhood` (Phase 3 `/audit-plan` wiring), a separate,
explicitly non-deterministic mechanism. Phase 1 does not touch plan mode.

`verifyExistenceFindings(findings, ctx)` → returns findings annotated with
verification metadata (it does **not** mutate them — see "Finding contract"
below). For each finding:

1. **Classify** (pure): does the finding assert a file/module/import/symbol
   is *missing*? Match `category` + `title` + `description` against the
   `EXISTENCE_CLAIM_SIGNAL` keyword/regex set (`missing module`, `does not
   exist`, `not found`, `no such file`, `unresolved import`, `undefined
   export`, …). Non-matching findings pass through untouched. (#5 — the
   signal set is one exported constant.)
2. **Extract the cited entity** → the full `citedEntity` shape
   `{ kind:'file'|'symbol', name, fromFile, exportName }` from
   `location`/`file`/`description` (`fromFile` = the importing/citing file,
   needed to resolve relative specifiers; `exportName` for export-missing
   claims — see the `schemas.mjs` entry, audit R2-H2).
3. **Sandbox + resolve** (resolves audit H5 — entity names come from
   untrusted LLM text):
   - **Repo-root sandbox first**: canonicalise the extracted path; if it is
     absolute, contains `..` segments, or resolves outside `baseDir`,
     **do not touch the filesystem** — return `requires_verification` with
     reason code `outside_repo_scope`.
   - **Sensitive-path check next** (resolves audit Gemini-R2-G1): test the
     canonicalised path against `SENSITIVE_PATH_DENYLIST` *before any `fs`
     probe*. A finding citing `secrets/prod.key` etc. → return
     `requires_verification` reason `sensitive_path_excluded`; never probe
     it and never write the path into `verificationReason` or a log. The
     gate must not become a side channel that confirms a sensitive file's
     existence.
   - *File/module*: resolve against the **filtered repo inventory** (the
     Phase 2 T0 list, already sensitive-path-filtered — H4) using the
     shared AST-backed module resolver (see Phase 2 `module-graph.mjs`),
     not ad-hoc extension probing.
   - *Symbol/export*: look up in the **exact symbol inventory** produced by
     `scripts/symbol-index/extract.mjs` (AST-derived — deterministic). This
     resolves audit H2: `get-neighbourhood` is embedding *similarity*, not
     an exact index, and `grep` is heuristic — **neither is used for the
     deterministic existence verdict**. If the exact symbol inventory is
     unavailable, the finding is `requires_verification`, never refuted.
4. **Adjudicate** — produce verification metadata only; the original
   finding is **immutable** (audit M2). The gate proves *presence*
   reliably; it can prove *absence* **only for files** (`fs` is
   authoritative and complete), **never for symbols** — the AST index
   (`symbol-index/extract.mjs`) omits interfaces, type aliases, enums and
   non-function consts, so "not in the index" ≠ "does not exist" (audit G1):
   - **Entity provably exists** — file on disk, or symbol *found* in the
     AST index → `verification:'refuted'`, `verificationReason` set,
     `countsTowardVerdict:false`, `verdictSeverity:'LOW'`. The **only**
     outcome that downgrades.
   - **File provably missing** — `fs.existsSync` false (authoritative) →
     `verification:'confirmed'`.
   - **Symbol not found in the AST index** →
     `verification:'requires_verification'` — *never* `confirmed`;
     absence is unprovable from an incomplete index (audit G1).
   - **Unresolvable** — dynamic import, alias, out-of-scope path, or no
     index available → `verification:'requires_verification'`.
   - For **both** `confirmed` and `requires_verification`:
     `countsTowardVerdict:true` and `verdictSeverity` = the **original
     `severity`, unchanged** (audit G2 — capping an unverifiable finding
     would let the gate silently bury a genuine HIGH the model got right;
     **only deterministic proof of falsity — `refuted` — may downgrade**).

**Finding contract (resolves audit H1 + M2)** — see the `schemas.mjs`
file-level entry: the model's original finding (`severity`, `title`, …)
stays **immutable**; the gate adds a sibling object
`{ verification, verificationReason, citedEntity, verdictSeverity,
countsTowardVerdict }`. Verdict + display logic read `verdictSeverity` /
`countsTowardVerdict`; `severity` is preserved as the audit trail of what
the model actually claimed.

**Hook point**: `runMultiPassCodeAudit` in `openai-audit.mjs`, immediately
after `normalizeFindingsForOutput()` and **before** the
`HIGH==0 && MEDIUM<=2` verdict is computed (the verdict consumes
`verdictSeverity`/`countsTowardVerdict`) — so a refuted finding cannot
produce a `SIGNIFICANT_ISSUES` verdict. **Code mode only.**

Why deterministic, not "more context": exact existence (`fs` + the
AST symbol index) is free and never goes stale. Context injection
(Phase 2) *reduces* the hallucination rate; this gate *eliminates* the
provable class. Belt (Phase 2) and suspenders (Phase 1).

### Phase 2 — `scripts/lib/repo-context.mjs` — the blast-radius tiers

`getRepoContext({ tier, scope, targetPaths = [], intent = null, baseDir = process.cwd() })`
→ `{ block, requestedTier, resolvedTier, fallbackReason, commitSha, gitAvailable, tokensEst, degraded }`
(see the fallback state machine below).

| Tier | Content | Token cost | Generation |
|---|---|---|---|
| **T0 Inventory** | Flat repo file-path list, **sensitive-path-filtered** | ~nil | `repo-inventory.mjs` `listRepoFiles()` — the single pinned, filtered source (git work-tree → `git ls-files`; else `.gitignore`-aware fs walk) |
| **T1 Adjacency** | T0 + public exports/signatures of modules the `targetPaths` **import but did not change** | low | The shared **`module-graph.mjs`** AST resolver (below) — never regex |
| **T2 Section** | One named AGENTS.md section, selected by `intent` | mid | `loadSection(name)` — `arch-context.mjs` `loadArchSection` generalized to any heading |
| **T3 Map** | Full symbol catalogue, **sensitive-path-filtered** | high | The exact AST symbol inventory from `symbol-index/extract.mjs` / `architecture-map.md`, filtered |

**Two shared utilities** — built in **Phase 1** (the gate needs them), and
consumed by both the gate **and** the Phase 2 tiers (one source of truth —
#1, #5; resolves audit R2-H1):

- **`scripts/lib/repo-inventory.mjs`** — `listRepoFiles({ baseDir })` →
  the canonical, **sensitive-path-filtered** file list (resolves audit
  H4). It applies the project's existing sensitive-path denylist (`.env`,
  `secrets/`, `.aws/`, `.ssh/`, `*.pem`, `*.key`, … — the same set
  `quickfix-scan` and the audit sensitive-file filter use; extract that
  denylist into a shared constant if it is not already one). **Every**
  context block (T0/T1/T3), the symbol-map generation, and the Phase 1
  gate's file lookups consume this — sensitive paths never appear in a
  block, a log, or a verdict.
- **`scripts/lib/module-graph.mjs`** — an **AST-based**, ESM-only module
  resolver (resolves audit M1): parses `import` / `export … from`
  statements (multiline, barrels, default + named, re-exports) via the
  same parser the symbol-index uses; resolves specifiers by the repo's
  real ESM rules. `require()` is **not** supported (repo is ESM-only — a
  Do-NOT). Patterns it cannot statically resolve (dynamic `import()`,
  computed specifiers) are reported as **non-verifiable**, never guessed.
  Used by T1 adjacency and by the Phase 1 gate's file/module resolution.

Cross-cutting rules:
- **Commit-SHA stamped** — every block carries `generated at <sha>` so a
  consumer (and the reader LLM) knows its freshness; mitigates stale-map
  anchoring.
- **Terse + factual** — inventory and signatures only; no interpretive
  prose. Limits anchoring (the brainstorm's explicit warning).
- **Budgeted** — each tier has a token ceiling via the
  `provider-limits.mjs` fraction pattern; T1/T3 truncate (lowest-priority
  entries first) rather than overflow.

**Fallback state machine (resolves audit M3)** — `getRepoContext` returns
`{ block, requestedTier, resolvedTier, fallbackReason, commitSha,
gitAvailable, degraded }`. The complete matrix:

| Requested | Failure | Resolved | `fallbackReason` |
|---|---|---|---|
| T3 | symbol-map generation fails | T1 | `t3_symbol_map_unavailable` |
| T2 | AGENTS.md missing / section absent | T0 | `t2_section_unavailable` |
| T1 | `module-graph` cannot resolve any import / empty diff | T0 | `t1_no_resolvable_adjacency` |
| T0 | repo inventory empty/unreadable | empty block | `t0_inventory_unavailable` |
| any | `git` unavailable | resolved tier still returned | `commitSha:null`, `gitAvailable:false`. Note: this affects **only** the SHA stamp — inventory generation is git-independent (`listRepoFiles` falls back to a `.gitignore`-aware fs walk, audit R2-M1), so T0/T1/T3 still produce content in non-git/shallow/tarball environments. |

Degradation never throws; consumers branch on `resolvedTier`. The
mixed-consumer case (`/audit-plan` = T1 **+** neighbourhood) is two
independent calls — the T1 call follows this matrix; the neighbourhood
call has its own existing failure handling (Phase 3).

### Phase 3 — Rewire the consumers to declare (intent, scope)

| Consumer | Tier | Wiring |
|---|---|---|
| `/audit-code --scope diff` | **T1** | `openai-audit.mjs` builds `targetPaths` from changed files; injects the T1 block via `lib/audit/prompt-builder.mjs` |
| `/audit-code --scope full` | **T3** | reuse/replace the existing symbol-catalogue inline path |
| `/audit-plan` | **T1 + neighbourhood** | inject T1; **also** detect duplication via `get-neighbourhood`. Do **not** embed the whole plan document — that overflows / dilutes the embedding vector (audit G4). Instead a cheap LLM pre-pass extracts the plan's *proposed* symbols/modules into a short list, then the neighbourhood query runs on that list. **Pre-pass constraints (audit Gemini-R2-G3)**: strict Zod-4 structured output (`z.object({ proposedSymbols: z.array(z.string()) })`); lightweight model (`latest-gpt-mini` sentinel); wrapped in `try/catch` — on any failure, **skip duplication detection and proceed** (it is advisory, never blocks the audit); embeddings issued in **one batch**, not serial per item, to avoid rate limits. This lets GPT tell "plan references nonexistent module" from "plan duplicates existing code" — the same `get-neighbourhood` `/plan` Phase 0.5 uses, but `/audit-plan` currently does not. |
| `gemini-review.mjs` | **T0/T1** | add the inventory block to the review payload so the final reviewer can *falsify* factual repo claims, not just judge deliberation |
| `/brainstorm` | **T2** | replace the bespoke `--with-arch` arch loader with `getRepoContext({tier:'T2', intent})`; the intent→section map drives which section |

**Intent→section map** (the T2 selector — single source of truth, data-driven):
a small exported table, e.g. `architecture → "## Architecture"`,
`audit-subsystem → "## R2+ Audit Mode"`, `learning → "## Learning System"`,
`memory → "## Architectural Memory …"`. `/brainstorm`'s existing
`ARCH_INTENT_RE` keyword auto-detect extends to pick the *intent*, hence the
section. `--with-arch` stays as an alias for `intent=architecture`;
`--no-arch` unchanged; a new `--with-section <name>` exposes explicit
selection (the extension seam already noted in the brainstorm-arch-context
plan).

### Key design decisions

| Decision | Principles | Rationale |
|---|---|---|
| Two separate modules (`finding-verification.mjs`, `repo-context.mjs`) | #2 Modularity, #3 SRP | Verification (post-output adjudication) and provisioning (pre-call context) are different concerns with different consumers and lifecycles. |
| Gate is deterministic, runs post-normalize pre-verdict | #11 Testability, #15 Error handling | A filesystem question must not be decided by an LLM; placing it before verdict means a refuted finding can't gate the build. |
| Tiers are an enum, not a boolean | #20 Long-term flexibility, #4 No hardcoding | Adding a tier or an intent is one table entry — data-driven, not a new code path. |
| Reuse `loadArchSection` (generalized) for T2; the **exact AST symbol inventory** (`symbol-index/extract.mjs`) for T3 + the gate | #1 DRY, #11 Testability | The section parser and the AST symbol index already exist and are tested. `get-neighbourhood` (embedding similarity) is used **only** for `/audit-plan` *duplication* detection — never for the deterministic existence verdict (audit H2). |
| Every tier degrades, never throws | #16 Graceful degradation | Audit/brainstorm must survive a context-generation failure. |
| `verification` field + logged downgrade reasons | #19 Observability | Operators can see *why* a finding was refuted; future telemetry can measure the FP rate. |

---

## 6. Sustainability Notes

- **Assumption**: AGENTS.md keeps `## ` H2 sections with stable-ish names.
  If a section is renamed, the intent→section map entry goes stale →
  `loadSection` returns empty → T2 degrades to T0. Not fatal; the map is
  one obvious place to update.
- **Stale-map risk** (T3): mitigated by call-time generation + commit-SHA
  stamp; never trust a checked-in `architecture-map.md` blindly.
- **Anchoring risk**: mitigated by terse factual blocks **and** the Phase 1
  gate as the deterministic backstop — even if the LLM over-trusts a stale
  T-block, the gate re-checks reality.
- **Extension seam**: the tier enum and the intent→section map are the two
  data-driven knobs. A future T4 (e.g. git-blame/ownership context) or a
  new intent is an additive entry.
- **`/assess` depends on this**: the standalone codebase-assessment skill
  (see §8) is a natural T3 + arch-intent consumer once this layer exists.

---

## 7. File-Level Plan

### NEW — `scripts/lib/audit/finding-verification.mjs`
- `EXISTENCE_CLAIM_SIGNAL` — exported keyword/regex set.
- `classifyFinding(finding)` → `boolean` (asserts a missing entity?). Pure.
- `extractCitedEntity(finding)` → `{ kind: 'file'|'symbol', name }|null`.
- `verifyExistenceFindings(findings, ctx)` → findings with `verification`
  + capped severity. Pure except the fs/symbol lookups passed in `ctx`.
- **Why**: #3 SRP — isolates deterministic adjudication from the LLM audit.

### MOD — `scripts/lib/schemas.mjs` (resolves audit H1 + M2)
- Add a `FindingVerificationSchema` — `{ verification: enum('refuted',
  'confirmed','requires_verification'), verificationReason: string,
  citedEntity: { kind: enum('file','symbol'), name: string,
  fromFile: string | null, exportName: string | null } | null,
  verdictSeverity: enum('HIGH','MEDIUM','LOW'), countsTowardVerdict:
  boolean }`. `citedEntity.fromFile` carries the *importing/citing* file
  so relative specifiers (`./schemas.mjs`) resolve against the right base,
  and `exportName` carries the specific symbol for export-missing claims
  (resolves audit R2-H2 — `{kind,name}` alone cannot resolve relative
  imports or ambiguous basenames).
- Attach it to the finding output schema as an **optional sibling** object
  (`verification?`), not by mutating `severity`. The model's original
  `severity`/`title`/`category`/`description` stay immutable; verdict +
  display logic read `verdict.verdictSeverity` / `countsTowardVerdict`.
- **Presence rule (resolves audit R2-H4)**: a finding the gate did **not
  classify as an existence-claim** carries **no** `verification` object at
  all — it passes through untouched and counts toward the verdict
  normally. `verification` is attached **only** to findings that *are*
  existence-claims; among those, `requires_verification` is the value for
  ones the gate could not resolve. The field is never attached to
  unrelated findings.
- **Why**: #5 single source of truth for the finding contract; the gate
  cannot otherwise emit a field the schema rejects at the boundary.

### NEW — `scripts/lib/repo-inventory.mjs` (resolves audit H4 + R2-M1)
- `listRepoFiles({ baseDir })` → canonical sensitive-path-filtered file
  list. **One pinned source** (resolves audit R2-M1): inside a git
  work-tree, the **union** of `git ls-files` **and** `git ls-files
  --others --exclude-standard` — tracked *plus* untracked-but-unignored
  files. Plain `git ls-files` omits newly-created files, which is exactly
  the case the motivating false-positive bug hit (a brand-new
  `arch-context.mjs`) — audit G3; `arch-intent/adapter-contract.mjs`
  already does this correctly and is the reference. Outside a git
  work-tree, a `.gitignore`-respecting recursive filesystem walk (covers
  non-git checkouts, shallow clones, tarball installs). The chosen path is
  reported as `inventorySource: 'git'|'fs-walk'` so consumers and tests
  can assert it.
- **Exclude uncommitted deletions** (resolves audit Gemini-R2-G2):
  `git ls-files` lists index entries even when deleted from the working
  tree, which would advertise ghost files to the LLM (and make the gate
  wrongly `refute` a *correct* "missing file" finding). Subtract
  `git ls-files --deleted`, or `fs.existsSync`-filter the union, so the
  inventory only contains files that physically exist.
- `SENSITIVE_PATH_DENYLIST` — shared constant (extract from
  `quickfix-patterns`/audit sensitive-file filter if not already shared),
  applied by **both** source paths.
- **Why**: #5 — one inventory source for T0/T1/T3 + the gate; the security
  boundary (no sensitive path ever reaches an external LLM) lives in one
  place, not duplicated per consumer.

### NEW — `scripts/lib/module-graph.mjs` (resolves audit M1)
- AST-based ESM-only import/export resolver: `resolveImports(file)`,
  `publicExports(file)`. Reuses the symbol-index parser. `require()`
  unsupported; unresolvable dynamic patterns reported non-verifiable.
- **Why**: #1 DRY — T1 adjacency and the Phase 1 gate share one correct
  resolver instead of two divergent regex heuristics.

### NEW — `scripts/lib/repo-context.mjs`
- `getRepoContext({ tier, scope, targetPaths, intent, baseDir })` → bundle.
- `INTENT_SECTION_MAP` — exported intent→AGENTS-section table.
- Tier builders `buildInventory` / `buildAdjacency` / `buildSection` /
  `buildMap`; `buildAdjacency` parses imports + extracts exports.
- **Why**: #2 Modularity — one provisioning surface for all call sites.

### MOD — `scripts/lib/brainstorm/arch-context.mjs`
- Generalize `loadArchSection()` → `loadSection(headingName)`;
  `loadArchSection` becomes a thin `loadSection('## Architecture')` wrapper
  (back-compat). `repo-context.mjs` T2 calls `loadSection`.

### MOD — `scripts/openai-audit.mjs`
- `runMultiPassCodeAudit` (**`code` mode only** — resolves audit R2-H3;
  the gate must never run in `plan` mode, §2 Phase 1): call
  `verifyExistenceFindings` after `normalizeFindingsForOutput`, before the
  verdict (which now reads `verdictSeverity`/`countsTowardVerdict`).
- Inject the `getRepoContext` block — T1 for `--scope diff`, T3 for
  `--scope full` — into the pass prompts (via `prompt-builder.mjs`).
- `plan` mode gets **no** existence gate; the `/audit-plan` duplication
  check is wired separately in Phase 3 via `get-neighbourhood`.

### MOD — `scripts/lib/audit/prompt-builder.mjs`
- `buildAuditPassPrompt` accepts an optional `repoContextBlock` and places
  it in the cache-friendly prefix region.

### MOD — `scripts/gemini-review.mjs`
- Add the T0/T1 block to the review payload.

### MOD — `scripts/brainstorm-round.mjs`
- Replace the bespoke arch load with `getRepoContext({tier:'T2', intent})`;
  add `--with-section <name>`; `--with-arch` → `intent=architecture` alias.

### MOD — SKILL.md files
- `skills/audit-code/SKILL.md`, `skills/audit-plan/SKILL.md`,
  `skills/brainstorm/SKILL.md` — document the context tiers + the
  verification gate; regenerate `.claude/skills/` copies.

### NEW — tests
- `tests/finding-verification.test.mjs`, `tests/repo-context.test.mjs`.

---

## 8. Risk & Trade-off Register

| Risk / trade-off | Severity | Mitigation |
|---|---|---|
| Gate over-suppresses a *real* missing-entity finding | Med | Only `refuted` when the entity **provably exists** (fs + exact AST symbol index); a genuine miss stays `confirmed`. Anything unresolvable → `requires_verification` (verdictSeverity capped MEDIUM, never dropped, original `severity` preserved). |
| Gate wrongly refutes a valid plan-audit finding about a future artifact | Med→resolved | Gate is **code-mode only** (audit H3); plan mode uses `get-neighbourhood` duplication detection instead. |
| Import resolution edge cases (barrels, re-exports, dynamic `import()`) | Med→resolved | One shared AST resolver `module-graph.mjs` (audit M1); unresolvable patterns → non-verifiable, never guessed. |
| **Security — sensitive paths leaking to external LLMs** | Med→resolved | `repo-inventory.mjs` applies the shared sensitive-path denylist to every T0/T1/T3 block + the gate (audit H4). LLM-authored paths are repo-root-sandboxed + canonicalised before any `fs` probe; traversal/absolute → `outside_repo_scope` (audit H5). |
| T1/T3 token cost | Low | Per-tier budget via the `provider-limits.mjs` fraction pattern; truncate lowest-priority entries first. |
| Stale T3 map anchors the LLM | Low | Call-time generation + commit-SHA stamp; gate is the backstop. |
| T2 intent mis-classification sends the wrong section | Low | Brainstorm-only (low stakes); defaults to `architecture`; `--with-section` overrides. |
| `loadArchSection` rename breaks an importer | Low | Keep `loadArchSection` as a back-compat wrapper. |
| **Deferred — out of scope**: standalone `/assess` codebase health skill | — | Brainstorm concluded it is worth building **anchored to the repo's own declared standards** (AGENTS.md, arch-intent's declared dependency graph, the Accepted-Technical-Debt register — *not* general principles, which regress to noise) as a thin aggregator of deterministic evidence (memory-health, dead-export graph, dependency staleness) + LLM synthesis. It **depends on the Phase 2 context layer**. Recommended as the immediate follow-up plan once this lands. |

---

## 9. Testing Strategy

**Unit — `finding-verification.test.mjs`**:
- `classifyFinding`: a "missing module" finding matches; a normal DRY
  finding does not.
- `verifyExistenceFindings`: cited file **exists** → `refuted`, severity
  capped; cited file **missing** → `confirmed`, severity unchanged;
  unresolvable import → `requires_verification`, severity ≤ MEDIUM.
- **Regression for H1/H2/M2**: a synthetic HIGH "missing `schemas.mjs`"
  finding, with `schemas.mjs` present on disk → must come out `refuted`
  and non-HIGH. This is the exact bug that motivated the plan.

**Unit — `repo-context.test.mjs`**:
- T0 returns a file list; T1 adds exports of an imported-unchanged module
  and omits changed files' own exports; T2 returns the requested section
  (and a different `intent` returns a different section); T3 returns the
  catalogue.
- Degradation matrix: each row of the §2 fallback table — forced T3/T2/T1/T0
  failure → correct `resolvedTier` + `fallbackReason`; `git` unavailable →
  `commitSha:null`, `gitAvailable:false`, block still returned.

**Unit — `repo-inventory.test.mjs` + `module-graph.test.mjs`** (security +
correctness):
- `listRepoFiles` **never** emits a denylisted path (`.env`, `*.pem`,
  `secrets/`, …) — assert against a fixture tree seeded with such files
  (audit H4).
- `module-graph` resolves multiline imports, `export … from` barrels,
  default + named; reports dynamic `import()` as non-verifiable; ignores
  `require()`.
- Gate sandbox (audit H5): a finding citing `../../etc/passwd` or an
  absolute path → `requires_verification` reason `outside_repo_scope`, and
  **no `fs` probe is made** outside `baseDir`.

**Integration**:
- `openai-audit` plan/code run with the gate wired — verdict computed on
  post-gate findings.
- `getRepoContext` invoked from a subdirectory resolves repo-root correctly.

**Edge cases**: empty diff (T1 → just T0); no AGENTS.md (T2 → empty,
degrades); dynamic `import()` in a changed file (adjacency → skipped, not
crashed); a finding citing a path outside the repo.

## 10. Acceptance Criteria

Backend scope — behavioural pass/fail contracts:

- **AC1** — A HIGH audit finding asserting a file/module/symbol is
  "missing", where that entity exists on disk, is emitted with
  `verification:'refuted'` and severity ≤ LOW; it cannot produce a
  `SIGNIFICANT_ISSUES` verdict.
- **AC2** — A finding asserting a genuinely-absent **file** keeps
  `verification:'confirmed'`, `countsTowardVerdict:true`, and its original
  severity unchanged.
- **AC3** — An unresolvable existence claim, **and any "missing symbol"
  claim** (absence is unprovable from the incomplete AST index), is
  `verification:'requires_verification'` with `countsTowardVerdict:true`
  and **original severity preserved** — the gate never downgrades a finding
  it could not deterministically prove false (audit G1, G2).
- **AC4** — `getRepoContext` returns the correct tier for each
  `(intent, scope)`; T0 ⊂ T1; every block is commit-SHA stamped.
- **AC5** — Any tier-generation failure degrades to a smaller tier (records
  `degradedFrom`) and never throws into the audit/brainstorm.
- **AC6** — `/audit-code --scope diff` prompt includes the T1 adjacency
  block (exports of imported-unchanged modules).
- **AC7** — `/brainstorm` selects the AGENTS.md section by intent; an
  audit-subsystem topic gets the audit section, not `## Architecture`.
- **AC8** — `loadArchSection()` still works (back-compat wrapper).
- **AC9** — no denylisted sensitive path (`.env`, `*.pem`, `secrets/`, …)
  appears in any T0/T1/T3 block, log line, or the gate's lookups.
- **AC10** — the gate runs in `code` mode only; a `plan`-mode audit of a
  plan that proposes a not-yet-existing module does **not** refute that
  finding.
- **AC11** — a finding citing a path outside `baseDir` (absolute or `..`)
  yields `requires_verification` / `outside_repo_scope` with no
  out-of-repo filesystem access.
- **AC12** — full test suite green; `npm run skills:check` green.

## Verification gate

`npm test` green (incl. new suites + the H1/H2/M2 regression) ·
`npm run skills:check` green · all AC1–AC9 demonstrable ·
`--scope diff` self-audit clean.

---

## Implementation Log

### 2026-05-17 — Phase 1 complete

- **Shipped**: `scripts/lib/repo-inventory.mjs`, `scripts/lib/module-graph.mjs`,
  `scripts/lib/audit/finding-verification.mjs` (new); `schemas.mjs`
  (`FindingVerificationSchema` + optional `verification` sibling);
  `openai-audit.mjs` (gate wired into `runMultiPassCodeAudit`, code mode
  only, post-normalize / pre-verdict). 29 new tests; full suite green
  (2270, 0 fail).
- **Audit**: Phase 1 R1 code-audit surfaced 20 findings — ~11 genuine
  gate-correctness bugs all fixed (anchored claim-phrase extraction vs
  first-quoted-token; ESM-exact resolution with no extensionless probing;
  removed the `fs.existsSync` fallback so the inventory is the sole truth;
  scoped-package → external; sensitive-path filtering moved into the
  fs-walk traversal; leading-slash → unresolvable). The remaining 9 were
  diff-scope artefacts (Phase 2 modules legitimately not built yet) or
  plan-prose `lib/` vs `scripts/lib/` path shorthand — no code change.
- **Deviation**: `module-graph.mjs` ships `resolveSpecifier` only;
  `publicExports` (T1's AST export extraction) is deferred to Phase 2
  alongside its sole consumer rather than built speculatively now.
- **Remaining**: Phase 2 (`repo-context.mjs` tiers) and Phase 3 (consumer
  rewiring) — separate cycles per the plan's dependency chain.

### 2026-05-17 — Phase 2 complete

- **Shipped**: `scripts/lib/repo-context.mjs` (new — `getRepoContext` with
  the four blast-radius tiers, fallback state machine, `INTENT_SECTION_MAP`);
  `module-graph.mjs` gains `parseImports`/`publicExports`;
  `arch-context.mjs` generalised `loadArchSection` → `loadSection({heading})`
  + back-compat wrapper. 26 new/extended tests; full suite green (2284).
- **Audit**: Phase 2 R1 code-audit surfaced 21 findings — ~11 genuine
  fixes applied (repo-root resolution; symbol claims never refuted;
  `targetPaths` inventory-validated; `execSync` maxBuffer; fs-walk dot-dir
  inclusion; `complete` flag; line-boundary truncation; honest T3 label;
  unknown-intent surfaced; static gate imports). M15 (move `loadSection`
  to a neutral module — benign coupling, `arch-context.mjs` is
  dependency-light) and M11 (have the audit producer emit a structured
  `citedEntity` so the gate consumes a contract instead of parsing prose —
  a larger producer-schema change) deferred with rationale. Plan-prose
  path nits, the prior-adjudicated `@import` non-resolution, and
  context-provider≠audit-run dismissed.
- **Deviation**: `publicExports`/`parseImports` are comment-stripped ESM
  regex (not a full AST parser) — a deliberate best-effort choice for the
  *advisory* T1 block; the deterministic gate's resolution is pure path
  math, where M1's AST concern actually applied.
- **Remaining**: Phase 3 — rewire the consumers onto `getRepoContext`.

### 2026-05-17 — Phase 3 complete (series complete)

- **Shipped**: `/audit-code` injects `getRepoContext` T1 (diff) / T3 (full)
  into the cacheable prompt prefix; `/audit-plan` injects T0; `gemini-review`
  gains a T0/T1 block so the final reviewer can falsify factual repo
  claims. `scripts/lib/doc-sections.mjs` (new) — section extraction moved
  out of the `brainstorm/` namespace into shared `lib/`. The gate now
  degrades `confirmed`→`requires_verification` on an incomplete inventory.
  13 new tests; suite green (bar one pre-existing flaky timing test in
  `hook-arch-memory-check`, unrelated — touches no hooks).
- **Audit**: Phase 3 R1 surfaced 7 findings — M2 (incomplete-inventory
  soundness) and M4 (cross-domain coupling — flagged in P2 and P3, fixed
  by the `doc-sections.mjs` move) fixed; M1 (regex prose-parsing — same as
  the deferred P2-M11 structured-citation-contract idea) and M3 (advisory
  T1 read-swallow — benign, advisory context) deferred with rationale;
  plan-prose path nits + the `quickfix-patterns.mjs` location LOW dismissed.
- **Deferred from Phase 3** (out of scope — documented follow-ups, not
  regressions): (1) the `/brainstorm` → `getRepoContext` T2 rewiring — the
  shipped `--with-arch` feature already supplies equivalent context, so
  this is cosmetic consolidation with regression risk; (2) the
  `/audit-plan` neighbourhood-duplication LLM pre-pass — a distinct
  sub-feature; the T0 inventory injection already addresses the core "does
  this plan reference / duplicate existing code" gap.
- **Series complete**: Phases 1–3 shipped (`b14a3e6`, `52b21b9`, this).
  The deterministic gate + the four-tier blast-radius context layer are
  live across `/audit-code`, `/audit-plan`, and `gemini-review`.

### 2026-08-13 — post-ship fix: a list claim ran past its own sentence

- **Defect**: `extractCitedEntityList` sliced from the list intro to the END
  of `detail`, so every quoted path in every LATER sentence was absorbed as a
  list member. The sentence after a "these are missing:" list is routinely
  where the model names what DOES exist, so the gate answered *"N of M cited
  path(s) DO exist — the claim is at least partly false"* about **true** HIGH
  findings, citing as evidence a path the model had reported as present one
  sentence earlier. A gate that manufactures doubt about correct findings is
  this module's own purpose pointed backwards.
- **Measured** (`wine-cellar-app/.audit`, 29 artifacts → 26 unique, 385
  findings, 25 absence claims → 22 unique after removing 3 byte-identical
  `consolidated-*` copies; each claim resolved against the wine tree **at its
  own run's commit**, since these audits drove the creation of the files they
  named): 3 of 22 hit the defect. Base rate of the absence claims themselves:
  16 true / 5 false / 1 ambiguous.
- **Fix**: members are the path-shaped tokens in the SAME sentence as the
  intro. `SENTENCE_GAP` matches only the gap BETWEEN cited tokens, which is
  what makes it safe against paths — `a.js` has a dot, but a dot inside a
  quoted token is never in a gap. `LIST_INTRO` became global so a detail
  carrying two list claims still yields both.
- **Effect on the corpus**: three true HIGH findings moved
  `requires_verification` → `confirmed` (`cluster1-r2` H3, `cluster1-r3` H3,
  `cluster2-r2` H1 — every cited path verified as landing *after* its run
  date), and one count corrected (12 → 11 cited paths, dropping a `/dist/`
  build output named in a consequence sentence). **Nothing moved toward
  `refuted`**; the 3 correct refutations and the 1 correct confirmation are
  byte-unchanged. 8 new tests, 4 of them red before the fix.
- **Not changed, deliberately**: the intro vocabulary stays as-is ("are also
  absent" still does not match). The one field case affected reaches the same
  verdict either way, so widening it has no measured need — and a second list
  silently dropped is the conservative direction (`requires_verification`).

### 2026-08-13 — the one absence class the gate cannot reach, closed at the prompt

This plan's §1 problem statement is *"GPT claimed X was a missing module purely
because it was absent from its context window"*, and fix #1 — the deterministic
gate — resolves it wherever the subject is a **repo file**. One sub-class is
structurally out of the gate's reach, and it is closed here instead.

- **The residual**: a **dependency-manifest** claim. `finding-verification.mjs`
  cannot adjudicate one even in principle — `tokenKind` classifies a bare
  specifier as `external`, and a repo FILE inventory has nothing to say about an
  npm manifest. Verified on all three field cases against current `main`: two
  land `requires_verification`, and the third is **not classified as an existence
  claim at all**, so the gate never looks at it.
- **Measured** (same 22-claim corpus as the entry above): 3 HIGH findings, in 3
  DIFFERENT passes, asserted a package was undeclared when it was declared all
  along — `openai ^6.17.0` twice (be-services, sustainability) and `zod ^4.3.6`
  alongside it once (structure). Ground truth read from `package.json` at each
  run's own commit. All three wrote *"the **supplied** package.json"*: the model
  knew its view was partial and asserted absence anyway.
- **Fix**: `NO_MANIFEST_ABSENCE_VERDICTS`, a sibling of the existing
  `NO_DECLARED_ARCH_VERDICTS`, on the same 5 generator passes. Same shape — *a
  pass must not return a verdict about a document it was not given.*
- **A SCOPE restriction, not a "prove absence" obligation** — this is the whole
  design decision. The base rate of these passes' file-absence claims is **16
  true / 5 false**, so a general reticence nudge would risk 16 true findings to
  recover 3. A scope rule cannot suppress the file-existence findings at all.
- **`EVIDENCE_CONTRACT_BLOCK` was considered and REJECTED for the legacy passes.**
  It is schema-blocked, not merely expensive: the emitted JSON Schema for
  `ProducerFindingSchema` carries `additionalProperties: false` and has no
  `causalChain` property, so the model cannot emit the field the block demands.
  Routing the chain into `detail` instead is also constrained — `maxLength` 600,
  with p90 already at 550 and 10.4% of findings at ≥550.
- **Cost, measured not guessed**: +141 tok/pass × 5 = 705/run. Across the 17 runs
  with cache telemetry that is ~11,985 tokens ≈ **$0.03 against $16.56 of actual
  spend (0.18%)**, plus a one-time invalidation under $0.02. The structure pass's
  measured cache hit rate is **6.34%** (21,262 / 335,199 input tokens), so there
  was far less prefix caching to disturb than the cache-stability contract
  implies — R1 runs mostly hit 0%, and only repeat rounds (60%, 44%) benefit.
- **Vehicle: seed edit, not a minted revision.** `bootstrapFromConstants`
  re-promotes a changed seed whenever the active revision's `source` is
  `bootstrap` (verified: active `rev-112f336b2d6e` is bootstrap-sourced; the new
  seed is `rev-9d3cc793fb81`), so it reaches every consumer on their next run
  with no promotion step. A manually promoted revision would have been left
  alone — which is what makes the registry the right vehicle for an *experiment*
  and the seed the right one for a settled rule.
- **Shadow: unaffected.** `SHADOW_PASSES` derives from `Object.keys(PASS_PROMPTS)`,
  so a content edit enrols no new arm (verified: 8 keys, 5 shadow passes, both
  unchanged). AGENTS.md's warning is scoped to the add-a-key case and does not
  apply.
- 3 new tests in `prompt-seeds-rules.test.mjs`, pinning the rule's REASON and its
  import-still-in-scope carve-out (without which it degrades to "never mention
  dependencies" and starts suppressing real import defects), plus a scope
  assertion that it is not sprayed onto the mechanical waves. Negative control:
  deleting the rule fails 2 of the 3.
