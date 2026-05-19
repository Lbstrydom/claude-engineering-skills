# Plan: Architecture-Intent Framework + JS Adapter (PR-A of 3)

- **Date**: 2026-05-11
- **Status**: Complete — all 3 PRs shipped (PR-A framework + JS/TS adapter, commit `6c6be92`; PR-B Python + Java adapters, commit `18ecc5e`; PR-C Postgres adapter, commit `5f7c30d`). PR-B and PR-C each ran their own `/plan` + `/audit-plan` + `/audit-code` cycle — see `docs/completed/arch-intent-pr-{b,c}-*.md` and the audit summaries in `docs/completed/`.
- **Author**: Claude + Louis (origin: /brainstorm on 2026-05-11 — both GPT and Gemini converged on C4 + intent-doc + LLM-bouncer)
- **Scope**: backend
- **Target domain(s)**: `audit-orchestration`, `shared-lib`, `install`, `docs`
- ⚠ **Cross-domain work** — touches `audit-orchestration` (new audit pass in openai-audit.mjs), `shared-lib` (new `arch-intent/` module tree), `install` (sync-to-repos.mjs CORE_SCRIPTS extension), and `docs` (new architecture-intent.md template + this repo's first instance). Boundary crossings intentional: framework is shared-lib infra; integration lives in audit-orchestration; templates ship via install.

> **Neighbourhood considered** — all `review`-band candidates (no high-similarity reuse). Most-similar symbols:
>
> | Symbol | File | Recommendation |
> |---|---|---|
> | `runMultiPassCodeAudit` | `scripts/openai-audit.mjs` | review (extension target — add new `architecture` pass) |
> | `getNeighbourhoodForIntent` | `scripts/lib/neighbourhood-query.mjs` | review (similar shape — pluggable analyser, but different domain) |
> | `loadDomainRules` | `scripts/lib/symbol-index/domain-tagger.mjs` | extend (current rule loader needs `allowedDeps` field) |
> | `cruise` (from dependency-cruiser) | already imported in `scripts/symbol-index/extract.mjs:24` | reuse (the JS adapter calls this) |
>
> No high-similarity matches → genuinely new framework. No security incidents.

---

## 0. TL;DR

PR-A of a 3-PR series ships the **framework spine** and the **first concrete adapter (JS/TS)**. Future PRs slot Python + Java (PR-B) and Postgres (PR-C, separately planned) into the same contract.

**What ships in PR-A:**
1. New module tree `scripts/lib/arch-intent/` with the pluggable adapter contract.
2. JS/TS adapter using existing `dependency-cruiser` dep.
3. New `architecture` pass in `runMultiPassCodeAudit` — opt-in (skip when no `architecture-intent.md`).
4. Template `docs/architecture-intent.md` + this repo's first concrete instance (dogfooding).
5. `allowedDeps` extension to `.audit-loop/domain-map.json` schema.
6. Sync entry in `sync-to-repos.mjs` so consumer repos get the framework.

**What's deferred to PR-B / PR-C:**
- Python adapter (PR-B, ~1-2 hr — same contract, swap `dependency-cruiser` for `import-linter`)
- Java/ArchUnit adapter (PR-B, ~1-2 hr — generates ArchUnit test files into consumer Java repos)
- Postgres adapter (PR-C, needs its own /plan — schema/RLS/function boundaries are conceptually different from "imports")

### Canonical sources of truth (R1/H1 fix)

To kill the dual-authority ambiguity:
- **`.audit-loop/domain-map.json` is the SOLE machine-readable SoT** — rules, allowedDeps, descriptions all live here.
- **`docs/architecture-intent.md` is the human narrative** — Mermaid + rationale prose. The Mermaid block IS NOT enforced — it's a render artefact for humans, intentionally allowed to drift from the rules (with a note encouraging operators to keep them aligned manually).
- **No `ALLOWED_DEPS_OVERRIDE` fallback** (R1/H4 fix) — `domain-map.json` is mandatory when the architecture pass runs. Missing it → SKIPPED_MISSING_DOMAIN_MAP, not silent fallback.
- The intent doc is allowed to exist alone (humans get value from the narrative even without domain-map). The reverse is also fine. The pass FIRES only when BOTH are present.

---

## 1. Context Summary

### What exists today (Phase 1 exploration)

- **Domain tagging**: `.audit-loop/domain-map.json` already maps file paths → domain names. The current schema is `{ rules: [{ pattern, domain }, ...] }` — first-match-wins glob rules. Loaded via `loadDomainRules(repoRoot)` in `scripts/lib/symbol-index/domain-tagger.mjs:145`. Used by `arch:refresh` to populate `domainTag` in the Supabase symbol_index.
- **Stack detection**: `node scripts/cross-skill.mjs detect-stack` returns `{ stack: 'js-ts' | 'python' | 'java' | 'mixed' | 'unknown', pythonFramework, detectedFrom }`. Already wired into `/audit-code` for skipping irrelevant passes (e.g., "frontend SKIPPED — repo profile: not relevant").
- **Audit pass pattern**: `runMultiPassCodeAudit` in `scripts/openai-audit.mjs:992` orchestrates `Wave 1 (structure + wiring)`, `Wave 2 (backend + frontend quality)`, `Wave 3 (sustainability)`, `Wave 4 (quickfix)`. Each pass calls `safeCallGPT` with prompt built via `buildCachePrompt` (the cache-stable 3-message structure shipped 2026-05-11).
- **Dependency analysis**: `dependency-cruiser` already a dep, currently invoked in `scripts/symbol-index/extract.mjs:24-246` to extract the file-to-file import graph for symbol-index. We can reuse the same analyzer for the new arch-intent pass.
- **Mermaid Chart MCP**: connector `1d8d02d1-...` available for rendering/validation. We use it for the optional Mermaid validation helper but the framework doesn't depend on it.

### Patterns reused vs new

**Reused**:
- `loadDomainRules()` — extended to also return `allowedDeps` (additive, backward-compat).
- `detectStack()` — gates adapter selection.
- `cruise()` from `dependency-cruiser` — JS adapter reuses the same lib that powers `extract.mjs`.
- `buildCachePrompt` + `safeCallGPT` — the new `architecture` pass uses the existing pattern.
- `sync-to-repos.mjs CORE_SCRIPTS` — new framework files added to the synced set.

**New**:
- `scripts/lib/arch-intent/` module tree (new directory).
- Adapter contract: `async function analyseImports({ repoPath, intent, domainMap, stack }) → { violations, unmappedFiles, deadIntent, analyzerVersion }`.
- JS/TS adapter (first concrete impl).
- New `architecture` pass in `runMultiPassCodeAudit`.
- Extended Zod schema for the new `allowedDeps` field on domain-map.json.
- `docs/architecture-intent.md` (template + this repo's first instance).

### Known issues / lessons

- The recent prompt-cache work taught us that **adapter contracts must be ratified by audit-plan BEFORE coding** — getting the contract right is load-bearing for downstream adapters. PR-A goes through /plan + /audit-plan; PR-B reuses the contract without re-planning.
- Naming inconsistency drift (e.g., `buildPassPrompt` → `buildAuditPassPrompt` in the prefix-cache PR) — be explicit upfront about the canonical name: **`buildArchIntentReport`** for the framework entry point, **adapters** for the stack-specific implementations.

---

## 2. Proposed Architecture

```
                       ┌────────────────────────────────────────────────────────┐
                       │  docs/architecture-intent.md  (HAND-CURATED)           │
                       │  ──────────────────────────────                        │
                       │  - C4 Container-level Mermaid diagram                  │
                       │  - Domain narratives (1-2 sentences each)              │
                       │  - Cross-cutting concerns (auth, logging, etc.)        │
                       │  - "Why this boundary" rationale                       │
                       └────────────────────────────────────────────────────────┘
                                          │ (parallel SoT)
                       ┌────────────────────────────────────────────────────────┐
                       │  .audit-loop/domain-map.json  (HAND-CURATED)           │
                       │  ──────────────────────────────                        │
                       │  - rules[]  (existing: pattern→domain)                 │
                       │  - allowedDeps{ from: [to, ...] }  (NEW)               │
                       │  - description{ domain: "narrative" }  (NEW, optional) │
                       └────────────────────────────────────────────────────────┘
                                          │
                                          ▼
       ┌──────────────────────────────────────────────────────────────────────┐
       │  scripts/lib/arch-intent/  (NEW module tree)                         │
       │  ─────────────────────────                                           │
       │                                                                      │
       │  ┌─ adapter-contract.mjs ─────────────────────────────────────────┐  │
       │  │  • runArchIntentAnalysis({ repoPath, stackKinds, domainMap })  │  │
       │  │    → iterates stackKinds, loads adapter per kind, merges       │  │
       │  │  • isArchIntentReportClean(report) → boolean (R1/H3 helper)    │  │
       │  │  • validateAdapterReturnShape(raw) (Zod-via ArchIntentReport-  │  │
       │  │    Schema; throws config error if adapter misbehaves)          │  │
       │  │  • EMPTY_REPORT = {                                            │  │
       │  │      violations: [],                                            │  │
       │  │      unmappedFiles: [],   // canonical name (R1/M2 fix)         │  │
       │  │      deadIntent: [],                                            │  │
       │  │      analyzerVersion: 'none',                                   │  │
       │  │      perStackResults: [], // R3/H2: typed per-stack envelope    │  │
       │  │      _meta: {},                                                 │  │
       │  │    }                                                            │  │
       │  │  • perStackResults: Array<{                                     │  │
       │  │      stackKind: 'js-ts' | 'python' | 'java' | ...,             │  │
       │  │      status: 'ok' | 'error' | 'unsupported',                   │  │
       │  │      report?: { violations: [], _meta: {} },                    │  │
       │  │      error?: { message, kind: 'config'|'analyzer' }             │  │
       │  │    }>                                                           │  │
       │  │  • Top-level violations/unmappedFiles/deadIntent are the merged │  │
       │  │    aggregate of all `status: 'ok'` per-stack reports plus       │  │
       │  │    inventory phase results.                                     │  │
       │  └────────────────────────────────────────────────────────────────┘  │
       │                                                                      │
       │  ┌─ adapters/ ───────────────────────────────────────────────────┐   │
       │  │  • js-ts.mjs        ← PR-A: invokes dependency-cruiser        │   │
       │  │  • python.mjs       ← PR-B: invokes import-linter             │   │
       │  │  • java.mjs         ← PR-B: generates ArchUnit test files     │   │
       │  │  • postgres.mjs     ← PR-C: queries pg_catalog                │   │
       │  └───────────────────────────────────────────────────────────────┘   │
       │                                                                      │
       │  ┌─ domain-resolver.mjs ─────────────────────────────────────────┐   │
       │  │  • resolveFileToDomain(filePath, rules) → domain | null        │   │
       │  │  • checkDepAllowed(from, to, allowedDeps) → boolean            │   │
       │  │  • Shared by all adapters; no analyser-specific logic           │   │
       │  └───────────────────────────────────────────────────────────────┘   │
       │                                                                      │
       │  ┌─ intent-doc-parser.mjs ───────────────────────────────────────┐   │
       │  │  • parseIntentDoc(docPath) → { mermaid, narratives, version, │   │
       │  │    _warnings: [] }                                            │   │
       │  │  • Extracts the FIRST ```mermaid``` block + section            │   │
       │  │    narratives by header (best-effort — never throws on        │   │
       │  │    malformed input; captures issues in _warnings)             │   │
       │  │  • Intent doc is human narrative ONLY — no machine-readable   │   │
       │  │    fallback for allowedDeps (R1/H1+H4 fix)                    │   │
       │  └───────────────────────────────────────────────────────────────┘   │
       └──────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
       ┌──────────────────────────────────────────────────────────────────────┐
       │  scripts/openai-audit.mjs  (MODIFIED — new pass)                     │
       │  ──────────────────────────                                          │
       │                                                                      │
       │  Wave 1.5: Architecture (NEW — after Structure/Wiring, before     │
       │  Wave 2). State machine per R1/M1+M2+H3 fixes:                       │
       │                                                                      │
       │    let archState = 'SKIPPED_NO_INTENT';                              │
       │    let archResult = EMPTY_PASS_RESULT;                               │
       │    if (shouldRunPass('architecture')) {                              │
       │      const intentExists = fs.existsSync('docs/architecture-intent.md');│
       │      const domainMapExists = fs.existsSync('.audit-loop/domain-map.json');│
       │      if (!intentExists) {                                            │
       │        archState = 'SKIPPED_NO_INTENT';                              │
       │      } else if (!domainMapExists) {                                  │
       │        archState = 'SKIPPED_MISSING_DOMAIN_MAP';                     │
       │      } else {                                                        │
       │        try {                                                         │
       │          const { stack, stackKinds } = await detectStack();          │
       │          const domainMap = loadArchIntentConfig(repoRoot); // R3/M2 │
       │            // throws ArchIntentConfigError on bad config             │
       │          const intent = parseIntentDoc('docs/architecture-intent.md');│
       │          const report = await runArchIntentAnalysis({                │
       │            repoPath, stackKinds, domainMap, intent                   │
       │          });                                                         │
       │          if (report.analyzerVersion === 'none') {                    │
       │            archState = 'SKIPPED_UNSUPPORTED_STACK';                  │
       │          } else if (isArchIntentReportClean(report)) {               │
       │            archState = 'ANALYZED_CLEAN'; // zero LLM call, save tokens│
       │          } else {                                                    │
       │            // R2/H2 fix: mechanical report is first-class.           │
       │            // LLM enriches with severity; fallback if it fails.      │
       │            const llmCall = await safeCallGPT(openai, {              │
       │              ...buildCachePrompt({                                   │
       │                rubric: PASS_ARCH_INTENT_SYSTEM,                      │
       │                focusBlock,                                           │
       │                passName: 'architecture',                             │
       │                planContent,                                          │
       │                ledgerFile, impactSet, isR2Plus, historyBlock,        │
       │                codeHeader: '## Intent + Violations',                 │
       │                // R2/M3 fix: aggregate by (from, to, rule) +         │
       │                // first-3 exemplars when count > 20                  │
       │                code: formatViolationsForPrompt(report, intent),      │
       │              }),                                                     │
       │              schema: ArchIntentPassSchema,                           │
       │              schemaName: 'architecture_pass',                        │
       │              reasoning: 'medium',                                    │
       │              ...archLimits,                                          │
       │              passName: 'architecture'                                │
       │            }, EMPTY_FINDINGS);                                       │
       │            if (llmCall.failed) {                                     │
       │              // LLM call failed; emit findings from mechanical       │
       │              // report using fixed severity rubric (decision 10)     │
       │              archState = 'ANALYZED_FALLBACK_DETERMINISTIC';          │
       │              archResult = {                                          │
       │                ...llmCall,                                           │
       │                result: { findings: deriveFindingsFromReport(report) }│
       │              };                                                      │
       │            } else {                                                  │
       │              archState = 'ANALYZED_WITH_FINDINGS';                   │
       │              archResult = llmCall;                                   │
       │            }                                                         │
       │          }                                                           │
       │        } catch (err) {                                               │
       │          // Only configuration errors reach this catch; per-stack    │
       │          // analyzer failures are handled inside runArchIntent      │
       │          // Analysis via perStackResults envelopes (R3/H2 + R2/H5).  │
       │          archState = 'ERROR_INVALID_CONFIG';                         │
       │          archResult = { findings: [{ severity: 'HIGH', category:    │
       │            '[Architecture] Invalid domain-map.json', detail: err.   │
       │            message }] };                                             │
       │        }                                                             │
       │        // After successful runArchIntentAnalysis, derive state from  │
       │        // perStackResults: ANALYZED_PARTIAL if any stack failed,    │
       │        // ERROR_ALL_STACKS_FAILED if all did, etc. See              │
       │        // deriveArchState(report) helper below.                      │
       │      }                                                               │
       │    } else { archState = 'SKIPPED_PASS_FILTER'; }                     │
       │    process.stderr.write(`  [architecture] ${archState}\n`);          │
       │    archResult._state = archState;  // surfaced in cacheMetrics       │
       └──────────────────────────────────────────────────────────────────────┘
```

### Key design decisions

0. **Two-phase analysis (R2/H1 + R3/H3 + Gemini-R1/H1 fixes)** (#3 Modularity, #5 SSoT). `runArchIntentAnalysis` is split into two phases:
   - **Phase 1 — File inventory** (shared, stack-agnostic):
     1. **Discover ALL candidate source files** first via a broad walk: `git ls-files` if in a git repo, else `**/*` glob, respecting `.gitignore` and a built-in exclude list (`node_modules/`, `dist/`, `build/`, `.git/`, `coverage/`, etc.). Filter to source-file extensions (`.{js,ts,mjs,cjs,jsx,tsx,py,java,sql,...}`).
     2. **Apply `domainMap.rules` to that set** to assign each file to a domain. First-match-wins. Files matched by NO rule are `unmappedFiles`. This is the ONLY way `unmappedFiles` can be non-empty — globbing rules alone is mathematically empty (every file matched a rule by definition).
     3. Result: `{ mapped: Map<filePath, domain>, unmappedFiles: filePath[] }`.
   - **Phase 2 — Edge analysis** (per-stack adapter): for each `stackKind` (from `detectStack().stackKinds`), the adapter receives `mapped` files filtered to that stack's file extensions + `domainMap` and returns `{ violations[], _meta }`. `stackKinds` controls ADAPTER SELECTION only (which language analyzer runs); it never controls file discovery.
   - Both phases run regardless of whether the LLM-bouncer succeeds.
   - **`deadIntent` (R3/M1 + Gemini-R1/M2 fixes)** is computed from `declaredDomains` = (every `rule.domain`) ∪ (every `allowedDeps` key) ∪ (every `description` key) MINUS pseudo-domains (`vendor`) MINUS domains that matched at least one file. Pseudo-domains are EXCLUDED because they describe external dependencies, not local files — they'll never have matching files and would otherwise always be in deadIntent.

1. **Adapter contract returns DATA, not decisions** (#3 Modularity, #11 Testability). Adapters emit `violations[]` with no severity. The LLM-bouncer in `/audit-code` classifies severity. This split makes adapters pure functions of (repo, config) — unit-testable without LLMs.

2. **Stack detection is LAZY with extended return shape for `mixed` (R1/H2 fix)** (#15 Error Handling, #18 Backward Compat). `detectStack()` is extended to return:
   ```js
   { stack: 'js-ts' | 'python' | 'java' | 'mixed' | 'unknown',
     stackKinds: [{ kind: 'js-ts', rootGlobs: ['src/**/*.{js,ts,mjs}', ...], confidence: 1.0 }, ...],
     pythonFramework, detectedFrom }
   ```
   `runArchIntentAnalysis` iterates `stackKinds` (singleton for non-mixed); per-stack file ownership comes from `rootGlobs`; results merge with file-path deduplication (one file → one violation set even if multiple analyzers see it). Missing adapter for a kind → log + skip that kind only.

3. **`allowedDeps` is WHITELIST not blacklist** (#10 No Hardcoding, #5 SSoT). Every edge in the import graph maps to (fromDomain, toDomain). Edge is allowed iff `allowedDeps[fromDomain]` includes `toDomain`. Implicit denial. Same-domain edges always allowed. External deps map to `vendor` pseudo-domain (always-allowed target).

4. **Mermaid in intent.md is NOT enforced** (R1/H1+H4 fix, #5 SSoT). The Mermaid block is a render artefact for humans; the framework doesn't parse or compare it against `allowedDeps`. Operators are encouraged to keep them aligned but the framework treats them as independent. **`domain-map.json` is the single machine-readable SoT.**

5. **Pass-state taxonomy is explicit and frozen (R1/M1 + R2/H3+H5 fixes)** (#15 Error Handling, #19 Observability). The pass emits exactly one of these states:
   - `SKIPPED_PASS_FILTER` — `--passes` argument excludes `architecture`
   - `SKIPPED_NO_INTENT` — `docs/architecture-intent.md` missing → audit proceeds normally
   - `SKIPPED_MISSING_DOMAIN_MAP` — intent.md present but `.audit-loop/domain-map.json` absent or has no rules
   - `SKIPPED_NO_BASELINE` — `domain-map.json.allowedDeps === null` (bootstrap left it unset; operator must run `--baseline-from-graph`)
   - `SKIPPED_UNSUPPORTED_STACK` — no adapter exists for ANY detected stackKind (per-stack mismatches are non-fatal; see decision 13)
   - `ERROR_INVALID_CONFIG` — `domain-map.json` fails `DomainMapSchema` validation OR semantic validation → emits config-level finding (HIGH severity)
   - `ERROR_ALL_STACKS_FAILED` — every detected stack's adapter threw (rare; per-stack isolation per decision 13)
   - `ANALYZED_CLEAN` — all checks pass; no LLM call; zero findings
   - `ANALYZED_WITH_FINDINGS` — violations present; LLM call succeeded; findings have LLM-classified severity
   - `ANALYZED_FALLBACK_DETERMINISTIC` — violations present; LLM call FAILED; findings emitted from mechanical report using fixed rubric (decision 11)
   - `ANALYZED_PARTIAL` — some stacks succeeded, some failed; findings include analyser-failure entries plus successful-stack violations (decision 13)
   
   Each state is documented + tested. Tests assert state transitions.

6. **"Clean" is centrally defined (R1/H3 + Gemini-R2/H1 fixes)** (#5 SSoT). `isArchIntentReportClean(report)` returns true iff ALL of:
   - `violations.length === 0`
   - `unmappedFiles.length === 0`
   - `deadIntent.length === 0`
   - `perStackResults.every(r => r.status === 'ok')` — no stack analyzer errored
   
   The last condition prevents the false-clean trap where a per-stack analyzer crashed (returning zero violations) and the pass mistakes silence for absence. This helper is used by the audit-pass gate, tests, and stderr summary — no path drift.

7. **Validation at the boundary (R1/M4 fix)** (#11 Testability, project rule). `loadDomainRules(repoRoot)` parses raw JSON via `DomainMapSchema.parse()` and returns a TYPED object (`{ rules: [...], allowedDeps: {}, description: {}, _version: number }`). Defaults applied at parse time. Any invalid config → throws `LlmError({ category: 'config' })`; caller in the audit pass maps to `ERROR_INVALID_CONFIG` state.

8. **Same-cycle Wave placement: Wave 1.5** (#19 Observability). Run AFTER Wave 1 (cheap structure/wiring) but BEFORE Wave 2 (expensive backend/frontend). Architecture violations are often root causes; catching them early avoids downstream noise. Wall-clock cost: ~5-15s per audit (adapter call + optionally one short LLM call).

9. **Pass shortcuts the LLM call on clean** (#19 Observability, cost efficiency). When `isArchIntentReportClean(report) === true`, no LLM call. Returns the standard pass envelope with `state: 'ANALYZED_CLEAN'`, zero findings, zero usage. Saves ~$0.01-0.03 per clean audit.

10. **Severity is one fixed rubric — no config (R1/M6 fix)** (#5 SSoT). PR-A ships ONE severity policy:
    - Cross-cutting violations (cycle across critical domains, or violation through a previously-clean boundary) → **HIGH**
    - Boundary erosion (single forbidden edge with no broader pattern) → **MEDIUM**
    - Unmapped source file in `src/` → **LOW** (operator: add a rule)
    - Dead intent (domain declared, no files) → **LOW** (operator: remove from intent OR plan to populate)
    
    No `policy.crossCuttingSeverity` config in `domain-map.json` PR-A.

11. **Mechanical report is first-class — LLM is an enrichment, not a gate (R2/H2 + Gemini-R2/LOW fixes)** (#11 Robustness, #15 Error Handling). The mechanical report has authoritative status. The audit-pass flow:
    - Phase 1+2 run → mechanical report computed
    - If clean → state = `ANALYZED_CLEAN`, zero findings, no LLM call
    - If violations exist → LLM call attempted
      - **LLM success** → state = `ANALYZED_WITH_FINDINGS`; findings use the FULL severity rubric from decision 10 (LLM can detect cross-cutting cycles via graph reasoning)
      - **LLM failure** → state = `ANALYZED_FALLBACK_DETERMINISTIC`; findings use a **SIMPLIFIED deterministic rubric** (cross-cutting detection requires LLM judgement and isn't available in fallback):
        - Every violation → MEDIUM
        - Unmapped source file → LOW
        - Dead intent → LOW
        - Per-stack analyzer failure → MEDIUM (one finding per failed stack)
        - HIGH is NEVER assigned in fallback mode — it requires the LLM's cross-cutting judgement
    - A `failed: true` LLM call never silently swallows mechanical violations. Tests pin this invariant.

12. **Bootstrap creates a SAFE baseline, not an empty whitelist (R2/H3 + R3/H1 fixes)** (#10 No Hardcoding, #18 Backward Compat). The `allowedDeps` field has ONE canonical lifecycle, applied identically in schema, loader, bootstrap, audit pass, and tests:
    | Value in `domain-map.json` | Loader returns | Audit pass interprets |
    |---|---|---|
    | Field absent OR `null` | `allowedDeps: null` | `SKIPPED_NO_BASELINE` — operator must run bootstrap |
    | `{}` (empty object, explicit) | `allowedDeps: {}` | "EVERY cross-domain edge forbidden" — operator's explicit choice (rare but legal) |
    | `{...keys: [...values]}` | parsed as typed map | normal whitelist semantics |
    
    Bootstrap CLI behaviour:
    - If `docs/architecture-intent.md` absent → copy template
    - `--baseline-from-graph` flag set → run the JS adapter, emit a baseline `allowedDeps` reflecting current import graph (freeze reality, narrow over time)
    - Without `--baseline-from-graph` → leave `allowedDeps: null` (the SKIPPED_NO_BASELINE state surfaces a one-line audit log telling operator how to baseline)
    - Reasoning: empty-whitelist = unusable first audit; baseline-from-graph = "freeze current behavior, narrow over time" matching Phase 0 symbol-index pattern.

13. **Per-stack fault isolation (R2/H5 fix)** (#15 Error Handling, #16 Graceful Degradation). When `stackKinds.length > 1` (mixed repo), each kind's adapter runs in its own `try/catch`. Per-stack result envelope:
    ```
    perStackResults: [
      { stackKind: 'js-ts', status: 'ok', report: { violations, _meta } },
      { stackKind: 'python', status: 'error', error: { message, stack } },
      { stackKind: 'java', status: 'unsupported', reason: 'no adapter at adapters/java.mjs' }
    ]
    ```
    Merge: successful reports' violations concatenate. Failures emit ONE finding per failed stack (`category: '[Architecture] Stack analyzer failure (java)'`, severity MEDIUM). Whole pass only fails when ALL stacks errored.

14. **Semantic validation post-Zod (R2/H4 fix)** (#11 Robustness, project rule). `loadDomainRules` performs TWO validation phases:
    - **Shape**: Zod `DomainMapSchema.parse(raw)` — types, formats
    - **Semantic** (after shape passes):
      - Derive `declaredDomains = new Set(rules.map(r => r.domain) ∪ {'vendor'})`
      - Every key in `allowedDeps` MUST be in `declaredDomains` (else throw `ArchIntentConfigError: 'unknown domain in allowedDeps key: X'`)
      - Every value in `allowedDeps[k]` MUST be in `declaredDomains`
      - Every key in `description` MUST be in `declaredDomains`
      - Detect rule shadowing: warn (not throw) if a later rule's pattern is a strict subset of an earlier rule's (the later is unreachable)
    - Both errors map to pass state `ERROR_INVALID_CONFIG` (HIGH finding) in the audit.

15. **Shared-lib errors are domain-typed, not LlmError (R2/M2 fix)** (#3 Modularity, #5 SSoT). New module `scripts/lib/arch-intent/errors.mjs` exports:
    ```js
    export class ArchIntentConfigError extends Error { /* schema / semantic failures */ }
    export class ArchIntentAnalyzerError extends Error { /* adapter runtime failures */ }
    ```
    Shared-lib functions (`loadDomainRules`, `validateAdapterReturnShape`, etc.) throw these directly. Mapping to `LlmError({category:'config'})` happens ONLY in `openai-audit.mjs` when it needs to feed the audit-loop error machinery. Keeps shared lib transport-agnostic.

16. **Prompt budget for large repos (R2/M3 fix)** (#19 Observability, #20 Long-Term Flexibility). When the mechanical report has >20 violations, the LLM prompt aggregates them:
    - Group by `(fromDomain, toDomain, ruleViolated)` triple
    - For each cluster: send `{ fromDomain, toDomain, rule, count, exemplars: [first 3 edges by file path] }`
    - Cap cluster count per LLM call at 30; if more, run multiple LLM calls and merge results
    - Full raw violations preserved in `_meta.fullViolations` for cacheMetrics / debugging
    - Token budget per LLM call capped at ~8K input tokens; adaptive based on `computePassLimits` (existing helper)

---

## 3. Engineering Principles Applied

- **#1 DRY**: `domain-resolver.mjs` shared by all adapters; no per-adapter duplication of glob-matching.
- **#3 Modularity**: adapter contract is the only seam; adapters know nothing about each other or about the audit pipeline.
- **#5 SSoT**: `domain-map.json` is the SOLE machine-readable canonical spec. `architecture-intent.md` is the human narrative (Mermaid block + rationale prose) — not enforced. Two artefacts, ONE machine authority.
- **#10 No Hardcoding**: severity policy IS fixed in PR-A (see decision 10) — no config knob. Deferred to PR-F if real demand emerges.
- **#11 Testability**: adapter contract is pure — fixture-driven unit tests with synthetic repos.
- **#15 Error Handling**: missing intent.md, missing adapter, malformed allowedDeps, parser failures — all skip gracefully with one-line stderr warning.
- **#18 Backward Compat**: existing `domain-map.json` files without `allowedDeps` continue to work — the field is optional. New audit pass is opt-in per repo.
- **#19 Observability**: every architecture pass emits stderr summary line + structured pass record in cacheMetrics-style audit-run aggregate.
- **#20 Long-Term Flexibility**: adding a new language is ONE new adapter file. The contract is the only thing future stacks must conform to.

---

## 4. Execution Model (sequencing)

| Step | Depends on | Why |
|---|---|---|
| 1. Define adapter contract module + Zod schema | nothing | Foundation — must come first |
| 2. Extend domain-map.json schema (add allowedDeps) | (1) | Pure config; backwards-compat |
| 3. Build `domain-resolver.mjs` + `intent-doc-parser.mjs` shared helpers | (1) | Used by all adapters |
| 4. Build JS/TS adapter using existing dependency-cruiser | (1, 3) | First concrete adapter validates contract |
| 5. Author this repo's first `docs/architecture-intent.md` + populate allowedDeps | (2) | Dogfood; serves as template + test data |
| 6. Wire `architecture` pass into `runMultiPassCodeAudit` (Wave 1.5) | (1-5) | Integration; this is where the value lands |
| 7. Unit tests for adapter contract + JS adapter + intent-doc parser | (1, 3, 4) | Pure-function tests; run via `node --test` |
| 8. Integration test: run audit-code against this repo's architecture-intent.md | (1-7) | End-to-end smoke; uses live OpenAI ($0.02-0.05) |
| 9. Add new files to `sync-to-repos.mjs` CORE_SCRIPTS | (1-6) | Propagation to consumer repos |
| 10. Manual: run sync, smoke-test in wine-cellar + ai-organiser | (9) | Verify framework deploys cleanly |

**Partial-failure recovery**: every step is independently revertable. Steps 1-3 (new module tree + helpers) change zero behaviour. Step 4 (JS adapter) is gated by Step 6 (pass integration) — if either misbehaves, revert and the audit pipeline is unaffected. Step 5 (dogfood intent.md) is documentation-only.

---

## 5. Sustainability Notes

### Assumptions that could change

- **`dependency-cruiser` keeps working on Node ESM repos**. If it bit-rots, the JS adapter rewrites; the contract is unaffected.
- **All adapters can be expressed via the file-edge model** (one file imports another file → violation if domain-pair forbidden). Postgres breaks this (PR-C — schemas/functions/RLS need a richer model). The contract MAY need extension in PR-C; design it now with a `_meta` extension slot.
- **Mermaid is the rendering choice**. If the user later wants Structurizr or D2, the intent-doc parser swaps; the rest of the framework is unaffected.

### Future extension points deliberately built in

- `_meta` field on the adapter return shape — opaque to the framework, available for adapter-specific metadata (e.g., Postgres adapter may attach RLS-policy snapshots; JS adapter attaches `unresolvedEdges` + `dynamicEdges`).
- Mermaid validation via Mermaid MCP — stubbed in PR-A, can become a pre-commit hook in a future PR.
- Per-repo severity policy config (deferred from PR-A — see decision 10).

### What if requirements change

- **Operators want diagrams to match deps automatically** (drift between Mermaid + allowedDeps): build a `npm run arch-intent:check-diagram-sync` script that parses Mermaid edges and diffs against allowedDeps. Add as a non-blocking warning in the architecture pass. Deferred from PR-A.
- **Teams want a custom analyzer for a new stack** (e.g., Rust, Go): one new adapter file. The contract is the only thing they must conform to.

---

## 6. Risk & Trade-off Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `allowedDeps` not enumerated for cross-domain edges → false-positive violations | high (on first authoring) | medium | Explicit "first authoring" workflow: PR-A authors this repo's allowedDeps from the current import graph; future authors generate a draft via `npm run arch-intent:bootstrap` (deferred — note in plan for future) |
| Mermaid diagram drifts from `allowedDeps` (one says X, other says Y) | medium | medium | Explicit: documented in §5 as deferred. Framework does NOT validate the two against each other in PR-A. Operators are told to update both. |
| `dependency-cruiser` invocation cost on large repos (cold start ~3-5s) | medium | low | Adapter caches result per audit run; only one invocation per `/audit-code` |
| Stack-detection misfires on mixed repos | medium | medium | When `stack === 'mixed'`, framework runs all detected stacks' adapters and merges results. Documented in adapter-contract.mjs JSDoc |
| Adapter generates many violations on first run (existing tech debt) | very high | medium | PR-A includes a "starter allowedDeps that matches reality, then narrow over time" workflow. Severity floor is configurable — operator can demote noisy violations |
| Integration test costs $$ (live OpenAI call) | low | low | Gated by `RUN_LIVE_TESTS=1`. Skipped in CI by default — like the existing integration-prompt-cache test |

### Trade-offs explicitly accepted

- **No auto-Mermaid generation from allowedDeps**: gives up "always-in-sync" promise for the simplicity of two SoTs the operator controls. Brainstorm consensus: auto-generation pollutes intent.
- **`vendor` pseudo-domain for external deps**: simplifies analyzer logic; trade-off is we can't enforce "do not import from `lodash`" rules. Accepted — that's a different layer of policy.
- **Pass placement: Wave 1.5 (after structure/wiring, before backend/frontend)**: adds ~5-10s wall-clock to R1. Accepted because architecture violations are root causes; surfacing them early prevents 5 downstream findings.

---

## 7. Testing Strategy

### Unit tests (`tests/arch-intent-contract.test.mjs` — NEW)

- `runArchIntentAnalysis({ stack: 'unknown' })` → returns EMPTY_RESULT, logs warning
- `runArchIntentAnalysis({ stack: 'js-ts' })` → loads `adapters/js-ts.mjs` and invokes it
- Missing intent.md → returns EMPTY_RESULT (caller's gate, not framework's)
- Malformed domain-map.json (no `allowedDeps`) → behaves as if `allowedDeps = {}` (everything forbidden — fail loud)
- `_meta` field is opaque (framework doesn't read it)

### Unit tests (`tests/arch-intent-domain-resolver.test.mjs` — NEW)

- File path → domain via glob rules (reuses domain-tagger tests' patterns)
- `checkDepAllowed('audit-orchestration', 'shared-lib', { 'audit-orchestration': ['shared-lib'] })` → true
- Self-domain edge always allowed (`audit-orchestration` → `audit-orchestration`)
- `vendor` always allowed as target
- Missing fromDomain in allowedDeps → forbidden (whitelist semantics)

### Unit tests (`tests/arch-intent-doc-parser.test.mjs` — NEW)

- Parse a sample intent.md → extracts Mermaid block + narrative sections
- Missing Mermaid block → returns `mermaid: null`, no throw
- Malformed Mermaid → captured in `_warnings: [...]`, no throw

### Unit tests (`tests/arch-intent-adapter-js.test.mjs` — NEW)

- Against `tests/fixtures/arch-intent-js/` synthetic repo (committed):
  - 3 domains: `app`, `core`, `vendor`
  - 5 files with intentional import edges (2 valid, 1 forbidden, 1 cross-domain-but-allowed)
  - Run adapter → expect exactly 1 violation reported
- Adapter handles missing `node_modules` gracefully

### Integration test (`tests/integration-arch-intent.test.mjs` — NEW)

- Gated by `RUN_LIVE_TESTS=1`
- Run the architecture pass against this repo's own intent.md
- Assert: violations[] reasonably-sized (not >50 — sanity check) and pass returns a structured result that openai-audit consumes correctly
- Cost: ~$0.02-0.05 per run

### Manual smoke

- After Step 9 (sync), run `node scripts/openai-audit.mjs code <plan> --passes architecture` in wine-cellar-app and ai-organiser. Expect:
  - Both have no intent.md yet → architecture pass skips silently
  - No regressions in other passes

---

## 8. File-Level Plan

### New files

#### `scripts/lib/arch-intent/adapter-contract.mjs` (~120 LOC)
The framework spine. Exports:
- `runArchIntentAnalysis(opts) → { violations, unmappedFiles, deadIntent, analyzerVersion, _meta? }`
- `EMPTY_RESULT` constant
- `validateAdapterReturnShape(raw, adapterPath)` — Zod-validated; throws config-LlmError on bad adapter
Why: SSoT for the contract. Adapters import nothing from each other.

#### `scripts/lib/arch-intent/domain-resolver.mjs` (~80 LOC)
Shared by all adapters. Exports:
- `resolveFileToDomain(filePath, rules) → domain | null` (glob match)
- `checkDepAllowed(from, to, allowedDeps) → boolean`
- `VENDOR_DOMAIN = 'vendor'` constant
Why: deduplication — every adapter needs this; #1 DRY.

#### `scripts/lib/arch-intent/intent-doc-parser.mjs` (~100 LOC)
Reads `docs/architecture-intent.md`. Exports:
- `parseIntentDoc(docPath) → { mermaid, narratives, version, _warnings }`
- Detects + extracts the first ```mermaid``` block; captures section narratives by header.
Why: framework needs this; only-this-place reads the doc.

#### `scripts/lib/arch-intent/adapters/js-ts.mjs` (~200 LOC)
The first concrete adapter. Exports:
- `default async function analyseImports({ mapped, domainMap, repoPath })` — Gemini-R2/H2 fix
- `mapped`: `Map<filePath, domain>` from Phase 1 (the orchestrator pre-computes inventory + domain assignment)
- `domainMap`: typed config from `loadArchIntentConfig` (includes `allowedDeps`)
- `repoPath`: for resolving relative imports
- **The adapter does NOT walk the filesystem** — Phase 1 owns inventory. The adapter only runs the import-graph analysis on the pre-mapped files.
- Uses `dependency-cruiser`'s `cruise()` to build the import graph
- Normalises edges via the **canonical edge-kind taxonomy (R1/M5 fix)**:
  | Edge kind | Source pattern | How treated |
  |---|---|---|
  | `local-file` | resolved relative import (`./foo.mjs`) | mapped to domain via rules; checked against allowedDeps |
  | `vendor-npm` | bare-specifier resolving to `node_modules/` | mapped to `vendor` pseudo-domain (always-allowed target) |
  | `vendor-node-builtin` | `node:fs`, `path`, `crypto`, etc. | mapped to `vendor`; always allowed |
  | `vendor-typescript-alias` | resolves through `tsconfig.json` paths → local file | treated as `local-file` (re-resolve through alias) |
  | `unresolved` | dependency-cruiser couldn't resolve the path | recorded in `_meta.unresolvedEdges`; NOT flagged as violation (operator decides) |
  | `dynamic` | `await import(variable)` | recorded in `_meta.dynamicEdges`; NOT flagged (can't statically check) |
  | `type-only` | TS `import type { X }` | excluded from the import graph (compile-time-only; no runtime coupling) |
- Returns standard adapter-contract shape (`ArchIntentReportSchema`)
Why: validates the contract on the hardest case (this repo). Edge-kind spec lives WITH the adapter, not in the contract — different stacks have different taxonomies.

#### `tests/arch-intent-contract.test.mjs` (~100 LOC)
Per §7. Uses `node --test`.

#### `tests/arch-intent-domain-resolver.test.mjs` (~80 LOC)
Per §7.

#### `tests/arch-intent-doc-parser.test.mjs` (~80 LOC)
Per §7.

#### `tests/arch-intent-adapter-js.test.mjs` (~120 LOC)
Per §7.

#### `tests/fixtures/arch-intent-js/` (~500 LOC across files)
Synthetic 5-file JS repo. Committed; updated via `UPDATE_SNAPSHOTS=1` if intentional.

#### `tests/integration-arch-intent.test.mjs` (~80 LOC)
Per §7. Gated `RUN_LIVE_TESTS=1`.

#### `tests/arch-intent-bootstrap.test.mjs` (~70 LOC) — R1/M3 fix
Tests for the bootstrap CLI:
- No-op when `docs/architecture-intent.md` already exists (idempotent)
- Copies template to live path on first run
- Behaviour per Decision 12: without `--baseline-from-graph`, `allowedDeps` is left omitted/null (NOT `{}`); with the flag, a baseline is generated from the current import graph. Tests assert both branches.
- Exits 0 in both cases; non-zero only on fs errors

#### `docs/architecture-intent.md` (THIS REPO's first instance — ~200 LOC)
Hand-curated. Contains:
- Header + last-updated date
- "Why this matters" intro (1 paragraph)
- C4 Container Mermaid diagram (~15-20 nodes for this repo's domains)
- Per-domain narratives (1-2 sentences each — 10-15 domains based on current domain-map)
- Cross-cutting concerns (auth/secrets, sync to consumer repos, learning-store as shared state)
- "Boundary rationale" — why specific allowedDeps[] entries are restrictive

#### `docs/architecture-intent.template.md` (~150 LOC)
The template consumer repos copy. Includes:
- Placeholders + clear authoring instructions
- Example Mermaid block with comments
- Worked example of allowedDeps section

### Modified files

#### `.audit-loop/domain-map.json` (this repo's instance)
- Add `allowedDeps: { domain: [allowed-target-domains] }` block.
- Initial values derived from CURRENT IMPORT GRAPH (whatever is true today). Operator narrows over time.
- Add `description: { domain: "1-sentence purpose" }` block (optional but recommended).

#### `scripts/lib/symbol-index/domain-tagger.mjs` (NO CHANGE — R3/M2 fix)
`loadDomainRules(repoRoot)` keeps its current shape (returns `[{pattern, domain}, ...]`) for backward-compatibility with `arch:refresh` / symbol-index callers. Adding architecture-intent strictness to this widely-used loader would couple unrelated concerns.

#### `scripts/lib/arch-intent/load-config.mjs` (~80 LOC, NEW) — R3/M2 fix
Architecture-intent-specific config loader:
- `loadArchIntentConfig(repoRoot)` reads `.audit-loop/domain-map.json` and returns the typed `{ rules, allowedDeps, description }` shape after Zod parse + semantic validation.
- Internally calls `loadDomainRules()` for the rules array (DRY), then runs Zod + semantic validation on the rest.
- Throws `ArchIntentConfigError` on validation failures; never affects the existing symbol-index code path.
- Single entry-point for arch-intent config — no other caller in the codebase reads domain-map.json for arch-intent purposes.

#### `scripts/lib/schemas.mjs` (~35 LOC)
- Add `DomainMapSchema` Zod schema (rules + optional allowedDeps + optional description).
- Add `ArchIntentReportSchema` covering the adapter contract return shape (violations, unmappedFiles, deadIntent, analyzerVersion, _meta).
- Add `ArchIntentPassSchema` covering the GPT response shape for the new audit pass.

#### `scripts/lib/arch-intent/errors.mjs` (~30 LOC) — R2/M2 fix
- `ArchIntentConfigError` — schema or semantic validation failure
- `ArchIntentAnalyzerError` — adapter runtime failure
- Mapped to LlmError({category:'config'}) only inside `openai-audit.mjs`; shared lib stays transport-agnostic.

#### `scripts/lib/arch-intent/semantic-validator.mjs` (~80 LOC) — R2/H4 fix
- `validateDomainMapSemantics(parsedMap)` — runs AFTER Zod shape validation:
  - Builds `declaredDomains` set from `rules` + always-allowed `vendor` pseudo-domain
  - Rejects `allowedDeps` keys/values not in declaredDomains
  - Rejects `description` keys not in declaredDomains
  - Warns (doesn't throw) on rule shadowing (later rule with strict-subset pattern)
- Throws `ArchIntentConfigError` on hard violations; returns `{ warnings: [] }` on success

#### `scripts/openai-audit.mjs` (~80 LOC)
- New constant `PASS_ARCH_INTENT_SYSTEM` (the LLM-bouncer rubric — see §9 below).
- New Wave 1.5 block after `Promise.all(wave1Promises)` and before `Wave 2`:
  - Call `runArchIntentAnalysis(...)`
  - If clean: `archResult = { findings: [], summary: 'intent clean', usage: zero }`
  - If violations: `safeCallGPT(...)` with the architecture-pass prompt
- Add `architecture` to the `allResults` array + `passNameOrder` parallel array (for cache telemetry).
- Add `architecture` to `EMPTY_*` set.

#### `scripts/sync-to-repos.mjs` (~30 LOC) — R3/H4 fix
Sync the ENTIRE `scripts/lib/arch-intent/**` subtree, not per-file. Use the existing `SUBTREE_SYNC` mechanism if present, OR add it:
```js
const SUBTREE_SYNC = [
  'scripts/lib/arch-intent',  // sync recursively; new files auto-include
];
```
Plus standalone top-level files:
```
'scripts/arch-intent-bootstrap.mjs',  // bootstrap CLI
```
This prevents the "I added a new module and forgot to update CORE_SCRIPTS" failure mode that bit us with `prompt-builder.mjs` and `decision-logger.mjs` earlier this session.

Add a new TEMPLATE_FILES section (R1/M3 fix — separates distribution from adoption):
```js
// Templates: copied ONLY IF the destination does not exist.
// Never overwritten — operators own the live copy.
const TEMPLATE_FILES = [
  { source: 'docs/architecture-intent.template.md',
    target: 'docs/architecture-intent.template.md' }, // template stays as template
];
```

Sync writes the TEMPLATE files only when missing. Operators run `node scripts/arch-intent-bootstrap.mjs` to copy the template to `docs/architecture-intent.md` (live, gitignored-free) and to seed `.audit-loop/domain-map.json` with `allowedDeps: {}` if absent.

#### `scripts/arch-intent-bootstrap.mjs` (NEW — ~80 LOC)
One-shot CLI to onboard a repo:
1. Reads `docs/architecture-intent.template.md` (synced from this repo).
2. Copies to `docs/architecture-intent.md` if absent; never overwrites.
3. Reads `.audit-loop/domain-map.json`. If `allowedDeps` field is missing:
   - With `--baseline-from-graph`: run the **detected stack's adapter** (via `detectStack()` — JS/TS now; Python/Java/Postgres in future PRs), derive a baseline `allowedDeps` from the current dependency graph, write it. Bootstrap is stack-agnostic (Gemini-R2/MEDIUM fix).
   - Without the flag: leave the field omitted (loader treats as `null` → `SKIPPED_NO_BASELINE` state)
   **Never writes an empty `{}`** — empty means "everything forbidden" which is a deliberate operator choice (decision 12).
4. Prints next-step instructions: either "review the generated baseline" or "run again with --baseline-from-graph to seed".
Exits 0 on no-op, 0 on success; non-zero only on filesystem errors.

### Files NOT modified

- `scripts/symbol-index/extract.mjs` — keeps its own dependency-cruiser usage (different concern: symbol indexing vs intent enforcement). Two independent invocations is acceptable; symbol-index runs on `arch:refresh`, intent-check runs on `/audit-code`.
- `scripts/cycle.mjs` — `/cycle` already runs `/audit-code` which now includes the architecture pass. No cycle-level changes needed.

---

## 9. LLM-Bouncer Prompt (the rubric)

Cited inline because it's design-load-bearing:

```
PASS_ARCH_INTENT_SYSTEM = `You are auditing PR diffs against the repo's
declared architectural intent. The mechanical analyser has already
flagged candidate violations — your job is to classify SEVERITY and
filter false positives.

You receive:
1. The repo's `architecture-intent.md` (the hand-curated C4 + rationale).
2. A list of mechanical violations: { fromFile, toFile, fromDomain,
   toDomain, ruleViolated }.
3. Unmapped files (in repo, not in any domain rule).
4. Dead intent (domains declared but with no files).

Your output: findings list. Use:
- HIGH: cross-cutting violation, breaks a critical invariant
  (e.g., audit-orchestration -> learning-store when not allowed
  creates a circular dep between core subsystems).
- MEDIUM: boundary erosion in a non-critical edge, OR a recurring
  pattern that suggests the boundary is wrong (consider proposing
  an allowedDeps update INSTEAD of a fix).
- LOW: isolated, easily-fixed cases (one file in the wrong domain;
  one stray import).

When recommending a fix, prefer "move the file to the right domain"
or "extract the cross-cutting concern into a shared module" over
"add the dep to allowedDeps". Adding to allowedDeps is admitting the
intent doc was wrong — sometimes that's right, but say so explicitly.

DO NOT raise findings for:
- Same-domain edges (always allowed by definition).
- Edges to `vendor` (external deps — different policy layer).
- Unmapped files in test/ or docs/ (heuristic — only flag src/).

DO raise findings for:
- `deadIntent` (domain declared but no files) — possible stale intent.
- `unmappedFiles` (files in src/ with no domain rule) — gap in domain-map.

Severity floor: any mechanical violation defaults to MEDIUM unless you
can justify HIGH or LOW with concrete reasoning.`
```

---

## 10. Rollout sequence (PR-A → PR-B → PR-C)

| PR | Scope | Why this order |
|---|---|---|
| **A (this plan)** | Framework + JS adapter + dogfooding intent.md | Validates contract on hardest case (this repo); ships first |
| **B** | Python adapter (~1-2hr) + Java/ArchUnit adapter (~1-2hr) | Reuses A's contract; validates portability on two stacks; no new /plan needed |
| **C** | Postgres adapter | Needs its OWN /plan (schemas/RLS/functions ≠ "imports"); conceptually different model |

**Verification gate (mandatory per repo Step 7 rule)**: after PR-A lands, run `/audit-code` against THIS plan with the new architecture pass enabled. Gemini final review must return APPROVE or CONCERNS-with-no-blocker. The audit-summary artefact at `docs/completed/architecture-intent-framework-audit-summary.md` MUST be committed alongside the implementation; /ship is BLOCKED on this artefact existing.

---

## 11. Bundle plan

PR-A is its own /cycle (this plan + audit + implementation + audit-code + ship). It does NOT bundle with PR-B/PR-C. Reason: contract correctness is the load-bearing piece — better to ship + audit + verify before adding three more adapters that inherit the contract.

After PR-A ships:
- PR-B: Python + Java adapters in one bundle (parallel — both validate the contract on new stacks).
- PR-C: Postgres adapter (separate plan, separate /cycle).

---

## Audit Trail

| Phase | H | M | L | Outcome |
|---|---|---|---|---|
| GPT R1 | 4 | 6 | 0 | All 10 valid + in-scope; fixed: SSoT clarified (domain-map.json is sole machine SoT), adapter contract for `mixed` stacks, central `isArchIntentReportClean`, fallback dropped, state taxonomy frozen, schema names consistent (`unmappedFiles`), install/sync split, validation at boundary, edge-kind taxonomy, severity rubric fixed |
| GPT R2 | 5 | 3 | 0 | R1 fixes exposed deeper concerns at the next layer: 2-phase analysis, mechanical-report-first-class, safe bootstrap baseline, semantic validation, per-stack isolation, domain-typed errors, prompt budget aggregation |
| GPT R3 | 4 | 2 | 0 | Internal-consistency drift from R2's partial edits — fixed: `allowedDeps` lifecycle canonicalised, `perStackResults` in schema, file inventory broad-glob-then-rule, sync entire subtree, deadIntent from declaredDomains, `loadDomainRules` kept backward-compat with new `loadArchIntentConfig` |
| Gemini R1 | 1 | 2 | 1 | All 4 addressed in flight: file inventory must broad-glob first, bootstrap never writes `{}`, `vendor` excluded from deadIntent, pseudocode uses `loadArchIntentConfig` |
| Gemini R2 (cap) | 2 | 1 | 1 | All 4 addressed in flight: `isArchIntentReportClean` includes `perStackResults.every(ok)`, JS adapter signature `analyseImports({mapped, domainMap, repoPath})`, bootstrap uses detected-stack adapter, fallback uses simplified deterministic rubric |

Plan converged on substance across 5 review rounds. Remaining concerns at Gemini R2 (the protocol cap) were all in-flight-addressable plan edits — no design pivots. Implementation proceeds with the plan in this state.
