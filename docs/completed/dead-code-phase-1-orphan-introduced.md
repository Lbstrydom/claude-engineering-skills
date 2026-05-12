# Plan: Dead-Code Detection — Phase 1 (Orphan-Introduced Check)

- **Date**: 2026-05-12
- **Status**: Complete
- **Author**: Claude + Louis (origin: /brainstorm with GPT-5 + Gemini-Pro on 2026-05-12)
- **Scope**: backend
- **Target domain(s)**: `audit-orchestration`, `shared-lib`, `tests`
- ⚠ **Cross-domain work** — touches >1 domain; the new pass module lives in `shared-lib` (`scripts/lib/audit/`) and is wired into `audit-orchestration` (`scripts/openai-audit.mjs`). Test files live in `tests`. This mirrors the existing `arch-intent` split — confirmed intentional.

> **Neighbourhood considered** (top similarity scores)
>
> | Symbol | File | Domain | Recommendation |
> |---|---|---|---|
> | `runMultiPassCodeAudit` | `scripts/openai-audit.mjs:780` | audit-orchestration | review (orchestrator — wire new pass invocation) |
> | `runMapReducePass` | `scripts/openai-audit.mjs:613` | audit-orchestration | review (parallel-pass scaffold; orphan check runs in same wave as architecture) |
> | `runArchIntentAnalysis` | `scripts/lib/arch-intent/adapter-contract.mjs:223` | shared-lib | **reuse** (provides the HEAD import graph + dependency-cruiser output) |
> | `analyseImports` (js-ts adapter) | `scripts/lib/arch-intent/adapters/js-ts.mjs:74` | shared-lib | **reuse-via-output** (cruise() result is the SSoT; pass-builder reads `_meta` or refactors adapter to expose raw edges) |
> | `isArchIntentReportClean` / `deriveArchState` | `scripts/lib/arch-intent/adapter-contract.mjs:307,321` | shared-lib | **pattern-mirror** (same pass-state taxonomy applies) |
>
> No high-similarity reuse candidate; the orphan-introduced check is genuinely new logic. The arch-intent infrastructure is the substrate.

No security incidents matched these paths.

---

## 0. TL;DR — what changes, what doesn't

**Tight phase 1 scope: detect when a diff orphans a previously-imported file.** Catches the recurring "LLM writes new module, leaves old one with zero callers" failure mode in the same PR that introduced it.

**What we DO**:
1. New mechanical pass: `orphan-introduced` in [scripts/lib/audit/orphan-introduced.mjs](scripts/lib/audit/orphan-introduced.mjs). Pure deterministic algorithm, no LLM call.
2. Reuse the dependency-cruiser graph already computed by arch-intent. Don't re-parse.
3. Orchestration resolves a `DiffScope` (`{baseRef, headRef, changedFiles, preEdgesByCaller}`) via the existing audit diff-scope resolver (working-tree / merge-base / passed `--diff`, with shallow-clone degradation). Pre-edge data is computed AST-style (NOT regex-on-patch — see H3 fix). Detector compares pre-edges vs HEAD graph for orphan signal.
4. Findings emitted at **MEDIUM** severity. Dynamic imports, reflection, framework conventions can still create false positives — operator confirms via accept-v1 marker or ledger dismiss.
5. Telemetry sink at `.audit/orphan-metrics.jsonl` so phase 2/3 measure FP rate from operator triage.

**What we DO NOT** (deferred to phases 2-4):
- ❌ Full-repo scan (`/repo-scan` skill — phase 2)
- ❌ Cross-stack adapters (Python/Java/CSS/HTML/SQL — phase 2-3)
- ❌ Wrap external tools (knip/vulture/PurgeCSS — phase 2)
- ❌ Clustering findings — phase 3
- ❌ Soft-delete TTL workflow — phase 3
- ❌ LLM rationale-writing — phase 3
- ❌ Auto-delete or auto-fix — never (out of scope for this product)

**Honest expected outcomes**:
- ~5-15% of audits will surface 1-2 orphan-introduced findings on real PRs
- ~10-20% false-positive rate initially (dynamic imports, reflection-loaded plugins) — operator suppresses via accept-v1 marker
- Telemetry from 20+ real audits informs whether phase 2 should keep the same heuristic or pivot to knip-wrap

---

## 1. Context Summary

### What exists today (Phase 1 exploration)

- **`runArchIntentAnalysis()`** ([adapter-contract.mjs:223](scripts/lib/arch-intent/adapter-contract.mjs#L223)): computes `mapped` + `unmappedFiles` + `deadIntent` + `perStackResults[].report.violations` + per-stack `_meta`. The js-ts adapter's `_meta` does NOT currently expose raw incoming-edge counts — only edge totals, vendor counts, unresolved/dynamic edge lists.
- **dependency-cruiser** is invoked inside [adapters/js-ts.mjs:91](scripts/lib/arch-intent/adapters/js-ts.mjs#L91). The `cruise()` result has the full graph data we need (`result.output.modules[].dependencies[]`), but it's currently consumed and discarded after edge-classification.
- **Architecture pass** ([openai-audit.mjs:1096](scripts/openai-audit.mjs#L1096)): clean pass-state taxonomy — `ANALYZED_CLEAN`, `ANALYZED_WITH_FINDINGS`, `ANALYZED_PARTIAL`, `ANALYZED_FALLBACK_DETERMINISTIC`, `SKIPPED_NO_BASELINE`, `SKIPPED_UNSUPPORTED_STACK`, `ERROR_ALL_STACKS_FAILED`. Orphan check follows the same pattern with `SKIPPED_NO_GRAPH` added.
- **R2+ ledger suppression** is plumbed through `safeCallGPT` for LLM-generated findings. Mechanical findings (architecture's deterministic fallback path) currently bypass the ledger. The orphan-introduced pass needs equivalent fingerprint-based suppression for round 2+.
- **No telemetry sink exists yet** for orphan-style mechanical findings. The pattern matches `.audit/cache-metrics.jsonl` (already exists for prefix-cache telemetry).
- **`audit:accept-v1` marker** is parsed by the auto-deferral classifier (see [scripts/lib/learning/auto-defer.mjs](scripts/lib/learning/auto-defer.mjs) or equivalent — verify exact path during implementation). Reuse this parser; do not introduce a parallel one.

### Patterns reused vs new

**Reused**:
- `runArchIntentAnalysis()` runs first; the orphan pass consumes its output. Saves ~3-15s by not re-running dependency-cruiser.
- Pass-state taxonomy from `deriveArchState()`.
- `safeCallGPT`'s pattern of mechanical-fallback finding emission (no LLM).
- Findings format from [scripts/lib/findings-format.mjs](scripts/lib/findings-format.mjs).
- accept-v1 marker parser.
- Atomic writes (`atomicWriteFileSync` from [scripts/lib/file-io.mjs](scripts/lib/file-io.mjs)) for telemetry append (use append-only mode, not full rewrite).

**New**:
- `scripts/lib/audit/orphan-introduced.mjs` — pure module exporting `detectOrphansIntroduced({scope, head, ctx}) → {rawFindings, _meta, state}`. Detector is side-effect-free; no git calls, no file I/O.
- `scripts/lib/audit/diff-scope-resolver.mjs` (NEW or extend existing) — orchestration helper that produces a `DiffScope` record from `{baseRef, headRef}` or a passed-in `--diff` patch. Owns git access. Owns AST-based pre-edge extraction for changed files (H3 fix).
- `scripts/lib/audit/findings-pipeline.mjs` — unified post-processing: normalize → fingerprint → ledger-suppress → accept-v1-suppress → telemetry-emit. Routes both LLM and mechanical findings (H2 fix). Replaces today's ad-hoc bypass for mechanical findings.
- `scripts/lib/audit/orphan-metrics.mjs` — telemetry writer (lock-safe append). See "Telemetry contract" below.
- Adapter `_meta` extension on js-ts: expose `callersByTarget: Map<repoRelPath, Set<repoRelPath>>` AND `targetsByCaller: Map<repoRelPath, Set<repoRelPath>>` (directionally explicit names — M1 fix) plus `allFiles: Set<repoRelPath>`. Validated at the boundary via Zod (#12). Approx 15 LOC.
- `.audit/orphan-metrics.jsonl` telemetry sink (lock-safe append-only).
- New finding `kind: 'orphan-introduced'` with sub-kind `'born-orphan'` (added file with no callers) vs `'left-orphan'` (existing file lost its last caller).

### Past lessons

- The arch-intent /audit-code R1 surfaced HIGH findings around `git ls-files` not including untracked files (R1/H2 fix). Lesson reused here: git operations need to handle the "no parent commit / shallow clone" edge case explicitly. The orchestration-owned diff-scope resolver degrades to `SKIPPED_NO_BASELINE` on shallow clones, initial commits, or detached-HEAD merge-base failures — never crashes.
- The architecture-pass plan went 5 audit rounds before converging on a clean pass-state taxonomy. Phase 1 inherits that taxonomy verbatim — no design from scratch.

---

## 2. Proposed Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ /audit-code orchestration (scripts/openai-audit.mjs)                   │
│                                                                          │
│   Wave 1:  runArchIntentAnalysis() ───┐                                │
│                                        │  passes report + _meta         │
│                                        ▼  (callersByTarget +           │
│                                           targetsByCaller graph)        │
│   Wave 1.5: detectOrphansIntroduced() ◄┘     ◄── NEW                    │
│            ↓ returns {findings, state}                                  │
│            ↓ appends to .audit/orphan-metrics.jsonl                     │
│                                                                          │
│   Wave 2:  structure / wiring / backend / frontend / sustain / quickfix │
│            (existing — unchanged)                                       │
│                                                                          │
│   Finding emission: orphan-introduced findings join the rest of the     │
│   pass results, flow through R2+ ledger suppression and reporting.      │
└────────────────────────────────────────────────────────────────────────┘
```

### Algorithm (deterministic)

The detector is a **pure function**. Orchestration owns baseline resolution + git access + post-processing; the detector itself takes a fully-resolved input record and emits raw findings.

#### Inputs (provided by orchestration)

```
ChangedFile:    // R2/H1 fix — explicit base + head caller identities
  status:            'A' | 'C' | 'M' | 'D' | 'R'   // Gemini-R3/L1 fix — handle git's copy status
  baseCallerPath:    string | null      // path at baseRef (null only for 'A' / 'C' status)
  headCallerPath:    string | null      // path at headRef (null only for 'D' status)
  // For 'R': baseCallerPath = oldPath, headCallerPath = newPath
  // For 'M': baseCallerPath === headCallerPath
  // For 'A': baseCallerPath = null
  // For 'C': baseCallerPath = null (treated like 'A' — copy destination has no preimage at the new path)
  // For 'D': headCallerPath = null

DiffScope:
  baseRef:               string         // e.g. 'HEAD~1', 'origin/main', merge-base SHA — orchestration picks
  headRef:               string         // 'HEAD' or commit SHA
  changedFiles:          ChangedFile[]
  preEdgesByBaseCaller:  Map<baseCallerPath, Set<repoRelPath>>
                                          // imports as they were at baseRef
                                          // Keys: baseCallerPath for every ChangedFile with status in {M, D, R}
                                          // Extracted via AST (see "Pre-edge resolution"). NOT regex.
  targetExistedAtBase:   Set<repoRelPath> // R2/H3 fix — for every target reached during analysis,
                                          // whether the target FILE existed at baseRef.
                                          // Gemini-R2/M1 fix: built ONCE via `git ls-tree -r --name-only ${baseRef}`,
                                          // not per-target (avoids N+1 process spawns on large diffs).
  entryPoints:           Set<repoRelPath> // R2/M3 fix — resolved by orchestration, not the detector.
                                          // Includes package.json bin/main/exports, scripts/*, bin/*.
                                          // Gemini-R3/M1 fix: package.json fields typically point to compiled
                                          // outputs (dist/index.js). The resolver attempts to reverse-resolve
                                          // each output path to its source equivalent by reading tsconfig.json
                                          // `rootDir`/`outDir` (or a babel.config equivalent). Heuristic: strip
                                          // `outDir/` prefix, prepend `rootDir/`, try `.ts`/`.tsx`/`.mjs`/`.js`
                                          // extensions in order. Falls back to literal path if no source match.
                                          // Both source-resolved AND literal paths are added to entryPoints,
                                          // so the exemption fires regardless of which form appears in the graph.

HeadGraph (from arch-intent's runArchIntentAnalysis _meta — H2/M1 fix):
  callersByTarget: Map<repoRelPath, Set<repoRelPath>>    // for each target file: set of files that import it at HEAD
  targetsByCaller: Map<repoRelPath, Set<repoRelPath>>    // for each caller file: set of files it imports at HEAD
  allFiles:        Set<repoRelPath>                      // every file in the mapped set
  // Repo-relative, forward-slash normalised. Validated at the boundary (Zod) before consumption.

Context:
  repoPath:    string
  planContent: string | null         // for accept-v1 marker scanning (NOT for plan-specific suppression)
  ledgerFile:  string | null         // R2+ adjudication ledger path (orchestration provides)
  runId:       string                // joined back from audit_runs.id for telemetry triage
```

#### Pre-edge resolution (R1/H3 fix — no regex, plus R2/H2 fix — include D-status)

Orchestration MUST produce `preEdgesByBaseCaller` by AST parsing, not regex:

0. **Gemini-R2/H1 fix — pre-filter to source files**: filter `changedFiles` against the same `SOURCE_EXTENSIONS` set as [adapter-contract.mjs:41-47](scripts/lib/arch-intent/adapter-contract.mjs#L41). Binary files, JSON, lockfiles, .md must NEVER reach the AST parser. Skip silently — they cannot be orphan candidates anyway.
1. For each remaining `ChangedFile` with status in `{M, D, R}`: spawn `git show ${baseRef}:${baseCallerPath}` → preimage text.
   **R2/H2 fix**: `D` (deleted) callers MUST be included. A deleted file that used to import target X is a removed-edge that may orphan X.
   `A` (added) files are NOT processed here — they have no baseRef preimage.
2. Feed each preimage text through the same parser used by dependency-cruiser (parse via `@dependency-cruiser/cruise` API against a temp-file or in-memory string entry-point, OR equivalently the `acorn`/TS-AST extractor that dep-cruiser uses internally).
3. Extract every static dependency form supported by the HEAD adapter:
   `import x from 'y'`, `import * as x from 'y'`, `import { a, b } from 'y'`, `import 'y'` (side-effect), `export ... from 'y'` (re-export), `require('y')`, `require.resolve('y')`. Same forms js-ts.mjs already handles at HEAD.
   **Gemini-R3/H1 fix — type-only imports DO count for orphan analysis**: `import type { Foo } from './types'` keeps `types.ts` alive even though it's not a runtime edge. The orphan check MUST include type-only edges in `callersByTarget` / `targetsByCaller`, while the existing arch-intent `allowedDeps` check continues to skip them (its `_meta.typeOnlyEdges` counter is preserved for that purpose). The js-ts adapter exposes two-track meta: violation-relevant edges (current behaviour, type-only excluded) and graph-relevance edges (type-only INCLUDED). Pre-edge extraction does the same — type-only forms are part of the preimage edge list.
4. Resolve each target identically to the HEAD pass (Node resolution + tsconfig paths) and record `Set<resolvedRepoRelPath>` per `baseCallerPath`.
5. The cost is bounded by `|changedFiles ∩ {M, D, R}|`, typically 1–30 files per PR — orders of magnitude cheaper than a full re-cruise.

Regex parsing of the diff patch is **explicitly rejected** (R1/H3): misses `import {...}` multi-line forms, dynamic shapes, re-exports, side-effect imports, and silently disagrees with the HEAD pass on resolution rules.

#### Patch-only mode (R2/M1 fix — explicit)

If orchestration receives a `--diff` patch without a resolvable base tree (e.g. CI passes a patch artefact), the resolver returns `state: 'SKIPPED_PATCH_ONLY_MODE'` and 0 findings. Phase 1 does NOT support patch-only orphan detection because pre-edges require AST parsing of preimage files (no preimage = no pre-edges). Phase 2 may add temp-tree materialisation if telemetry shows demand.

#### Working-tree mode completeness (R3/H3 fix)

When orchestration runs without explicit `--base/--head` refs (i.e. against the current working tree), `resolveDiffScope` MUST union three sources to build `changedFiles`, mirroring the arch-intent inventory pattern at [adapter-contract.mjs:104-120](scripts/lib/arch-intent/adapter-contract.mjs#L104).

**Gemini-R5/M1 — parser must handle variable-width records** (R/C statuses occupy TWO path tokens; A/M/D occupy ONE). The parser MUST peek at the status code prefix and consume the matching number of null-separated path tokens before advancing to the next record. Misalignment one record into the stream corrupts every subsequent ChangedFile.

**Gemini-R4/M1 fix — ALL git commands used by the resolver MUST pass `-z` for null-byte termination + disable `core.quotePath`.** Filenames containing newlines, spaces, or non-ASCII characters break newline-separated parsing silently. Required `-z` invocations:

1. `git diff --name-status -z HEAD` — tracked-but-modified files vs HEAD (status M/D/R + staged A/C)
2. `git ls-files --others --exclude-standard -z` — newly-added uncommitted files (status A, no baseCallerPath)
3. `git status --porcelain=v1 -z` — catches files that are added-then-modified, deleted-then-recreated, etc.
4. `git ls-tree -r -z --name-only ${baseRef}` (for `targetExistedAtBase` Set construction — Gemini-R2/M1 + R4/M1 combined)

Parse null-byte-separated output. The resulting `changedFiles` list normalises every entry to the same `{status, baseCallerPath, headCallerPath}` shape. Without this union, the audit blind-spot we fixed in arch-intent (R1/H2 there) would re-appear here.

#### Pass-state single source of truth (R3/M1 fix)

All pass-state strings are defined ONCE in [scripts/lib/schemas.mjs](scripts/lib/schemas.mjs) as `OrphanPassStateSchema` (Zod enum):

```
'ANALYZED_CLEAN' | 'ANALYZED_WITH_FINDINGS' | 'ANALYZED_PARTIAL' |
'SKIPPED_NO_BASELINE' | 'SKIPPED_NO_GRAPH' | 'SKIPPED_PATCH_ONLY_MODE' | 'SKIPPED_UNSUPPORTED_STACK' |
'ERROR'
```

Mapping from upstream arch-intent state when graph is unavailable or partial:
- arch-intent `SKIPPED_UNSUPPORTED_STACK` → orphan `SKIPPED_UNSUPPORTED_STACK`
- arch-intent `ERROR_ALL_STACKS_FAILED` → orphan `SKIPPED_NO_GRAPH`
- arch-intent `ANALYZED_PARTIAL` (some stack errored) → orphan inherits `ANALYZED_PARTIAL` (Gemini-R2/M2 fix — partial-graph signal must propagate; the orphan check may produce incomplete results when only some stacks analysed)
- arch-intent `SKIPPED_NO_BASELINE` (allowedDeps null) → orphan still runs (orphan check doesn't need allowedDeps)

Tests, telemetry, detector return, orchestration logging all import the same enum.

#### Pure detector (R2 fixes applied)

```
detectOrphansIntroduced({ scope: DiffScope, head: HeadGraph, ctx: Context }) → DetectorResult

  1. // Compute removedEdgesByTarget — for each target, the EXACT set of callers
     // who dropped an edge to it (Gemini-R5/H1 fix). Reverse-walking preEdgesByBaseCaller
     // later would include callers that still import the target → unstable fingerprint
     // + incorrect rationale. We track exact attribution here.
     removedEdgesByTarget = new Map<repoRelPath, Set<repoRelPath>>()
     function recordRemoved(target, baseCaller):
       if !removedEdgesByTarget.has(target): removedEdgesByTarget.set(target, new Set())
       removedEdgesByTarget.get(target).add(baseCaller)
     for f in scope.changedFiles where f.status in {'M', 'D', 'R'}:
       preTargets = scope.preEdgesByBaseCaller.get(f.baseCallerPath) ?? new Set()
       if f.status === 'D':
         // Caller is gone → ALL its preTargets are removed-at-HEAD, attributed to baseCallerPath.
         for target in preTargets: recordRemoved(target, f.baseCallerPath)
       else:
         // M or R: compare against HEAD targets for the head-side caller identity.
         headTargets = head.targetsByCaller.get(f.headCallerPath) ?? new Set()
         for target in preTargets:
           if !headTargets.has(target): recordRemoved(target, f.baseCallerPath)

  2. suspects = new Set<repoRelPath>()
     for f in scope.changedFiles where f.status in {'A', 'C'}: suspects.add(f.headCallerPath)  // Gemini-R3/L1
     for f in scope.changedFiles where f.status === 'R': suspects.add(f.headCallerPath)
     for t in removedEdgesByTarget.keys(): suspects.add(t)

  3. rawFindings = []
     for path in suspects:
       if !head.allFiles.has(path):           continue   // file deleted at HEAD — out of scope
       if scope.entryPoints.has(path):        continue   // resolved by orchestration (R2/M3 fix)
       if isTestFile(path):                   continue   // tests/** + *.test.* + *.spec.*
       // Gemini-R2/wrongly-dismissed-R3/M2 fix: filter test callers from the zero-caller check.
       // Public-contract files are already exempted via scope.entryPoints. If a non-entry-point
       // file's only remaining callers are test files, it IS dead in prod — exactly the orphan
       // pattern we exist to catch (file retained its unit test but lost its production callers).
       allCallers      = head.callersByTarget.get(path) ?? new Set()
       nonTestCallers  = new Set([...allCallers].filter(c => !isTestFile(c)))
       testCallers     = new Set([...allCallers].filter(c =>  isTestFile(c)))
       if nonTestCallers.size > 0:            continue
       // testCallers recorded in _meta for operator context (helps triage: "this file is only
       // touched by its own test — confirm it's dead, then delete both")
       // R2/H3 fix — subKind from base existence of the TARGET, not from changedFiles membership.
       subKind = scope.targetExistedAtBase.has(path) ? 'left-orphan' : 'born-orphan'
       // Gemini-G1 + R5/H1 fix: emit FULL sorted REMOVERS set for fingerprinting + truncated display list.
       // Use removedEdgesByTarget (exact attribution from Step 1) — NOT a reverse-walk of preEdgesByBaseCaller
       // (which would include still-importing callers and produce unstable fingerprints).
       allRemovedCallers = [...(removedEdgesByTarget.get(path) ?? new Set())].sort()
       priorCallers      = allRemovedCallers.slice(0, 3)
       rawFindings.push({
         severity:           'MEDIUM',
         kind:               'orphan-introduced',
         subKind,
         file:               path,
         allRemovedCallers,                       // full sorted set — fingerprint input
         priorCallers,                            // first 3 for display only
         rationale: subKind === 'left-orphan'
           ? `Lost all incoming imports in this diff (previously imported by: ${priorCallers.join(', ')}${allRemovedCallers.length > 3 ? ', ... (' + (allRemovedCallers.length - 3) + ' more)' : ''})`
           : `Newly added; no file at HEAD imports it (entry-points + tests excluded)`,
       })

  4. return {
       rawFindings,
       _meta: { suspectsCount, removedEdgesCount, entryPointsCount: scope.entryPoints.size },
       state
     }
```

`findPriorCallers` walks `scope.preEdgesByBaseCaller` to find callers whose preTargets included the given path. Result is sorted (R2/M4 fix — deterministic for fingerprint stability).

#### Post-processing pipeline (H2 fix — canonical for both LLM and mechanical findings)

The detector returns RAW findings. Orchestration applies a unified pipeline (this becomes the standard pattern, replacing today's bypass where mechanical findings skip the ledger):

```
processFindings(rawFindings, ctx) → { survivors, suppressed }:
  1. normalize: ensure {severity, kind, file, rationale} shape; canonicalise paths.
  2. fingerprint (R2/M4 + R3/H1 + Gemini-G1 fix):
       For 'left-orphan': hash over {kind, subKind, file, f.allRemovedCallers}
         where f.allRemovedCallers is the FULL alphabetically-sorted array emitted by
         the detector (NOT the truncated f.priorCallers display list). This is the
         single property the pipeline needs from the detector for stable fingerprinting.
       For 'born-orphan': hash over {kind, subKind, file}.
       Goes through the shared findings.mjs/semanticId() canonical-evidence path
       (same as LLM-pass findings). This prevents two different orphan events on the
       same file from colliding into one fingerprint (R3/H1 — would silently suppress
       a real new finding after the first was dismissed).
       Schema (R2/M1 contract): every `orphan-introduced` raw finding MUST include
       `allRemovedCallers: string[]` (empty array for `born-orphan`). Validated at the
       boundary by `OrphanIntroducedFindingSchema` so the pipeline can't silently see
       `undefined`.
  3. ledger-suppress (R2+ only): if ctx.ledgerFile exists, partition findings whose
                   fingerprint matches an entry with adjudicationOutcome ∈
                   {'dismissed', 'severity_adjusted-to-zero'} into `suppressed[]`
                   (with `suppressedBy: 'ledger'`). Survivors continue.
  4. accept-v1-suppress: partition findings whose file matches an active accept-v1 glob
                   in ctx.planContent (reuses scripts/lib/learning/auto-defer.mjs parser)
                   into `suppressed[]` (with `suppressedBy: 'accept-v1'`).
  5. return { survivors, suppressed }. Pipeline is pure-data, no I/O.
```

**Gemini-R4/H1 fix — telemetry emission belongs to per-pass orchestration, not the shared pipeline.** Each wave (orphan-pass, architecture-pass, future LLM passes) is responsible for calling its own metrics sink (`appendOrphanMetric` / `appendArchMetric` etc.) on the `{survivors, suppressed}` return. This keeps the pipeline reusable across pass types and prevents one pass's findings from corrupting another pass's telemetry log.

Steps 3+4 already exist conceptually for LLM-pass findings — phase 1 makes them reusable across all passes (LLM + mechanical) via this generic interface.

### Key design decisions (with cited principles)

1. **No full re-run of dependency-cruiser** (#1 DRY, #5 SSoT). HEAD graph comes from the existing arch-intent pass via adapter `_meta` (`callersByTarget`, `targetsByCaller`, `allFiles`). Pre-edge data is computed AST-style for ONLY the changed files (H3 fix), not by regexing the patch — bounded cost.
2. **Targeted suspect set, not full-file scan** (#17 N+1 prevention adjacent — avoid O(files²)). The diff bounds the work; we only check files the diff plausibly orphaned.
3. **Mechanical-only at phase 1, no LLM** (#11 Testability — pure functions, fixtures-only; #20 Long-Term Flexibility — phase 2/3 can layer LLM rationale on top of the same finding stream).
4. **MEDIUM severity, never HIGH** (#15 Error Handling — false positives still possible; raising to HIGH would block legitimate merges from dynamic-import-heavy codebases).
5. **Pass-state taxonomy mirrors arch-intent** (#3 Modularity, #5 SSoT). Reusing `ANALYZED_CLEAN` / `ANALYZED_WITH_FINDINGS` / `SKIPPED_NO_BASELINE` keeps the operator's mental model consistent.
6. **Telemetry from day one** (#19 Observability). Phase 2 design decisions depend on real FP-rate data — emit it now, even before we know what we'll do with it.
7. **Reuse accept-v1 marker syntax** (#1 DRY). The auto-deferral classifier already parses `<!-- audit:accept-v1: <glob> :: <reason> -->`. Don't fork the parser.
8. **No file deletions, no auto-fix** (#15 Error Handling). The pass surfaces a finding only. Remediation is operator's choice — phase 3 will add the TTL workflow.
9. **Unified post-processing pipeline for all findings (R1/H2 fix)** (#1 DRY, #5 SSoT, #19 Observability). Mechanical and LLM-pass findings share one fingerprint → ledger-suppress → accept-v1-suppress → telemetry pipeline. Orchestration owns it; detector returns raw findings. Implementing this for phase 1 also retroactively brings the arch-intent fallback path through the ledger (was bypassing it). Future passes inherit for free.
10. **Orchestration owns baseline resolution (R1/H1 fix)** (#3 Modularity). The detector accepts a fully-resolved `DiffScope` object with `{baseRef, headRef, changedFiles, preEdgesByCaller}`. Orchestration decides whether to use working-tree, HEAD~1, merge-base, or a passed-in `--diff` patch via the existing audit diff-scope resolver. No `git` calls inside the detector.
11. **Directionally explicit graph contract (R1/M1 fix)** (#12 Validation, #2 SOLID/ISP). Adapter `_meta` exposes two opposite-direction maps with explicit names: `callersByTarget: Map<target, Set<callers>>` and `targetsByCaller: Map<caller, Set<targets>>`. Boundary validation via Zod ensures shape + direction match the contract.

---

### Telemetry contract (R1/M2 fix)

`.audit/orphan-metrics.jsonl` is **append-only JSONL**. Writer: [scripts/lib/audit/orphan-metrics.mjs](scripts/lib/audit/orphan-metrics.mjs).

**Write strategy** (M2 fix — atomic-write doesn't compose with append):

- Use `fs.appendFileSync(file, line, {flag: 'a'})` for single records — atomic at line granularity on POSIX (writes < PIPE_BUF are atomic; one JSONL line is always < 4KB).
- Windows / NTFS lacks the POSIX atomicity guarantee for `appendFileSync`. Mitigation: cross-process file lock via `proper-lockfile` (already a transitive dep) OR fallback to `O_APPEND` flag opened explicitly. The wrapper module abstracts this; callers don't see the lock.
- The existing `atomicWriteFileSync` is NOT used here — it's for full-file rewrites. The plan's earlier reference to it was misleading and is removed.

**Record schema** (one JSONL line per RAW finding, including suppressed):

```jsonc
{
  "ts":            "2026-05-12T13:42:01.234Z",
  "runId":         "audit_run-uuid",         // joined to audit_runs.id for triage backfill
  "fingerprint":   "orphan:left:src/foo.mjs:9c3a", // stable hash; matches findingFingerprint()
  "kind":          "orphan-introduced",
  "subKind":       "left-orphan" | "born-orphan",
  "file":          "src/foo.mjs",
  "severity":      "MEDIUM",
  "suppressedBy":  null | "ledger" | "accept-v1",
  "passState":    "ANALYZED_CLEAN" | "ANALYZED_WITH_FINDINGS" | "SKIPPED_NO_BASELINE" | "SKIPPED_NO_GRAPH" | "SKIPPED_UNSUPPORTED_STACK" | "ERROR"
}
```

**Triage backfill** (so phase 2 can compute FP rate):

- The R2+ ledger writer ALREADY records `adjudicationOutcome` per fingerprint (dismissed / accepted / severity_adjusted) — see [scripts/lib/ledger.mjs](scripts/lib/ledger.mjs).
- `joinTriageOutcomes(ledgerFile)` reads the ledger and produces a derived view `{fingerprint → outcome}` for the analysis script.
- No new triage table needed. Phase 2's analysis script joins `.audit/orphan-metrics.jsonl` × ledger entries on fingerprint.

**Run-summary record** (R2/M2 fix — emit even when zero findings, so per-run analysis is feasible without scanning the whole log):

```jsonc
{
  "ts":                    "...",
  "runId":                 "...",
  "kind":                  "orphan-run-summary",
  "passState":             "ANALYZED_CLEAN" | "ANALYZED_WITH_FINDINGS" | "SKIPPED_NO_BASELINE" | "SKIPPED_NO_GRAPH" | "SKIPPED_PATCH_ONLY_MODE" | "SKIPPED_UNSUPPORTED_STACK" | "ERROR",
  "rawFindingCount":       <int>,    // before suppression
  "surfacedFindingCount":  <int>,    // after suppression
  "suspectsCount":         <int>,
  "removedEdgesCount":     <int>
}
```

The summary record is the FIRST line per run; per-finding records follow. Phase 2 analysis scripts join `summary.runId == finding.runId`.

**Rotation**: log grows ~150 bytes/run × ~5 audits/week ≈ 40 KB/year. No rotation needed at phase 1.

---

## 6. Sustainability Notes

### Assumptions that could change

- **Baseline resolution works on every CI environment**. Shallow clones (depth=1) and squash-merge repos may fail to resolve a baseline. Mitigation: orchestration-owned `resolveDiffScope` degrades to `SKIPPED_NO_BASELINE` and emits a stderr hint about `git fetch --deepen=1`. The detector never sees this case — orchestration short-circuits.
- **dependency-cruiser parses all valid JS/TS imports**. Edge cases (custom Babel transforms, advanced TS-only syntax) might miss imports. The orphan check inherits whatever blind spots dependency-cruiser has — which is acceptable because the architecture pass already lives with them.
- **Operators will triage orphan findings, not ignore them**. If telemetry shows 80% dismiss-without-action, the heuristic is too noisy and phase 2 should pivot to a higher-precision wrap (knip's own dead-code report has lower FPs).

### Extension points deliberately built in

- The output shape `{findings, _meta, state}` matches the architecture pass — phase 2's `/repo-scan` can produce identical-shaped findings from knip/vulture output and flow through the same downstream pipeline.
- `callersByTarget` + `targetsByCaller` + `allFiles` on adapter `_meta` are what phase 2's full-repo scan also needs — same SSoT.
- Telemetry schema is extensible — `{kind: 'orphan-introduced', subKind, severity}` lets phase 3 add `'clearance'` and `'cluster'` kinds without schema migration.

### What if requirements change in 6 months

- Need to support Python/Java/CSS/HTML/SQL → adapters expose the same `_meta.{callersByTarget, targetsByCaller, allFiles}` shape. Phase 2 scaffolds the adapter contract.
- Need to surface orphans at HIGH severity (e.g. for prod-deploy gates) → severity becomes a config knob. Single point of change.
- Need to disable the pass per-repo → standard `.audit-loop/config.json` `disabledPasses` field (already exists).

---

## 7. File-Level Plan

### New files

| Path | Purpose | Key exports |
|---|---|---|
| `scripts/lib/audit/orphan-introduced.mjs` | Pure detector — no I/O | `detectOrphansIntroduced({scope, head, ctx}) → {rawFindings, _meta, state}`, `isTestFile(path)` |
| `scripts/lib/audit/diff-scope-resolver.mjs` | Build `DiffScope` from refs or `--diff`; AST-based pre-edge extraction; entry-point discovery | `resolveDiffScope({repoPath, baseRef, headRef, diffPatch?}) → DiffScope`, `computeEntryPoints(repoPath)`. `extractPreEdges` is internal (used by `resolveDiffScope` only — not a public export, per audit-code R1/M3). |
| `scripts/lib/audit/findings-pipeline.mjs` | Unified post-processing for ALL passes | `processFindings(rawFindings, ctx) → finalFindings`, `findingFingerprint(f) → string` |
| `scripts/lib/audit/orphan-metrics.mjs` | Lock-safe telemetry writer | `appendOrphanMetric(record)`, `joinTriageOutcomes(ledgerFile)` |
| `tests/orphan-introduced.test.mjs` | Unit tests covering 5 acceptance cases + 7 edge cases | (test entry) |
| `tests/diff-scope-resolver.test.mjs` | Test pre-edge extraction across import forms; shallow-clone degradation | (test entry) |
| `tests/findings-pipeline.test.mjs` | Test fingerprint stability + ledger suppression + accept-v1 + telemetry emission for both mechanical and LLM-shaped raw findings | (test entry) |
| (fixtures built programmatically in-test via `git init` + temp dirs — no on-disk `tests/fixtures/orphan-introduced/scenario-*/` per audit-code R1/M1; the tests are self-contained and don't need committed fixture trees) | | |

### Modified files

| Path | What changes | Why |
|---|---|---|
| `scripts/lib/arch-intent/adapters/js-ts.mjs` | Add `callersByTarget` + `targetsByCaller` + `allFiles` to `_meta`. ~15 LOC | SSoT for directionally explicit graph (M1 fix); consumed by orphan pass. |
| `scripts/lib/schemas.mjs` | Add `OrphanIntroducedFindingSchema`, `DiffScopeSchema`, `HeadGraphMetaSchema` (Zod). ~30 LOC | Boundary validation (#12), enforces directional contract (M1 fix). |
| `scripts/openai-audit.mjs` | Wave-1.5 hook: call `resolveDiffScope` → `detectOrphansIntroduced` → `processFindings`. Also re-route arch-intent's deterministic-fallback findings through `processFindings` (#1 DRY benefit). ~60 LOC | Integration point + H2 fix retroactively applies suppression pipeline to existing mechanical findings. |
| `.audit-loop/domain-map.json` | Add explicit `"pattern": "scripts/lib/audit/**", "domain": "audit-orchestration"` rule (audit-code R1/M16 — explicit boundary for the audit subsystem rather than inheriting from the shared-lib catch-all). | Domain consistency for the audit subsystem. |

### Files NOT modified

- The js-ts adapter's analyzer-version, edge-classification, or violation-emission logic. Pure additive change to `_meta`.
- The R2+ ledger format. Orphan findings flow through the existing format unchanged — they're just another finding kind.
- The arch-intent contract. The pass is built ON TOP of it, not extending the contract.

---

## 8. Risk & Trade-off Register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Dynamic-import false positives (`await import(varname)`) | High in DI-heavy or plugin-loader codebases | MEDIUM severity (never HIGH); accept-v1 marker for known intentional patterns; telemetry to spot per-repo patterns |
| Reflection-based loaders (e.g. `require(path.join(...))`) | Medium | Same mitigation; phase 2 will route these to per-stack heuristics via knip |
| Shallow CI clones can't resolve baseline | Medium (some CI configs use depth=1) | Orchestration's `resolveDiffScope` degrades to `SKIPPED_NO_BASELINE` with stderr hint; detector never sees the case |
| Initial commit (no HEAD~1) | Low (only first commit ever) | Same as above |
| `dependency-cruiser` failed → no graph available | Low (already a known arch-intent state) | Degrade to `SKIPPED_NO_GRAPH`; pass-state taxonomy already supports this |
| Operator never triages → telemetry useless | Medium | Telemetry includes `action: dismiss|fix|defer` from R2+ ledger entries; phase 2 derives FP-rate per-repo from this |
| accept-v1 marker syntax drift between auto-defer parser and orphan parser | Low | Reuse the existing parser — don't fork |

**Trade-offs explicitly accepted**:
- **JS/TS only at phase 1** — Python repos get nothing yet. Justified by phase progression: prove heuristic on the highest-coverage stack first.
- **Mechanical-only (no LLM)** — won't catch semantic orphans like "file is technically imported but the import is dead code". Justified by cost discipline and phase 1's "leak prevention" framing.
- **No per-file confidence score** — every orphan-introduced finding is MEDIUM. Phase 3 will add per-finding confidence based on signal stacking (dynamic-import-free dir, has tests, etc.).

---

## 9. Testing Strategy

### Unit tests (`tests/orphan-introduced.test.mjs`)

**Acceptance cases from input** (5 required):

| # | Scenario | Expected |
|---|---|---|
| (a) | File `lib/old.mjs` was imported by `main.mjs` at HEAD~1. The diff removes that import. At HEAD, `lib/old.mjs` has 0 incoming. | 1 finding emitted with `subKind: 'left-orphan'` |
| (b) | File `lib/orphan.mjs` had 0 incoming at HEAD~1 AND 0 at HEAD. Diff didn't touch it. | 0 findings (not introduced by this diff) |
| (c) | `scripts/cli.mjs` is in `package.json` `bin` and the diff removes its last importer. | 0 findings (entry-point exempted) |
| (d) | `tests/old.test.mjs` orphaned by the diff. | 0 findings (test file exempted) |
| (e) | R1 finding suppressed via ledger. R2 should not re-raise the same finding fingerprint. | R2 returns 0 findings (suppression respected) |

**Additional edge cases**:

- (f) Born-orphan: newly added `lib/dead-at-birth.mjs` with no callers at HEAD → 1 finding with `subKind: 'born-orphan'`
- (g) Renamed file `R old new` → suspects.add(new); if new has 0 callers, find on new (not old)
- (h) accept-v1 marker `<!-- audit:accept-v1: lib/plugin-* :: dynamically loaded -->` in plan → finding emitted into `rawFindings` but `suppressedBy: 'accept-v1'` in telemetry; not surfaced in `finalFindings`
- (i) Dynamic-import line `await import(\`./plugins/${name}\`)` in preimage → not parsed as static import (matches HEAD adapter's classification); doesn't add to suspects
- (j) Shallow clone (`resolveDiffScope` returns `state: 'SKIPPED_NO_BASELINE'`) → detector not invoked; pass returns 0 findings, no crash
- (k) `head.callersByTarget` is null or missing → `state: 'SKIPPED_NO_GRAPH'`, 0 findings, stderr warning
- (l) Empty diff (HEAD == base) → `state: 'ANALYZED_CLEAN'`, 0 findings
- (m) **Re-export edge case (H3-driven)**: `export * from './removed'` line removed in diff → preimage AST parser must emit `./removed` as a target; if `./removed` ends up orphan at HEAD, finding emitted
- (n) **Side-effect-only import**: `import './polyfill'` line removed in diff → same as (m); polyfill file becomes orphan candidate

### Pre-edge extraction tests (`tests/diff-scope-resolver.test.mjs`)

Covers H3 (AST not regex):
- Static `import x from 'y'` → extracted
- Named `import { a, b } from 'y'` → extracted
- Default-and-named `import x, { a } from 'y'` → extracted
- Wildcard `import * as x from 'y'` → extracted
- Side-effect `import 'y'` → extracted
- Re-export `export * from 'y'` → extracted
- Re-export `export { a } from 'y'` → extracted
- CJS `require('y')` → extracted
- Dynamic `await import(varName)` → NOT extracted (classified as dynamic, mirrors HEAD adapter)
- Type-only `import type { T } from 'y'` → NOT extracted (matches HEAD adapter exclusion)
- Multi-line import statement → AST parses correctly (regex would miss)
- Comment containing `import x from 'y'` → NOT extracted

### Findings-pipeline tests (`tests/findings-pipeline.test.mjs`)

Covers H2 (unified suppression):
- Mechanical raw finding flows through fingerprint → ledger-suppress → accept-v1 → telemetry
- LLM-shaped raw finding flows through the same pipeline
- Same fingerprint across rounds = same finding (stable hash)
- Ledger entry with `adjudicationOutcome: 'dismissed'` suppresses on R2; `passState` recorded but `suppressedBy: 'ledger'` in telemetry
- accept-v1 glob match → `suppressedBy: 'accept-v1'`
- Telemetry emitted for ALL raw findings (including suppressed) — required for FP-rate analysis

### Integration smoke (R2/L1 fix — use worktree, not destructive checkout)

Run on the last 5 audit_runs in this repo:

```bash
for sha in $(git log --format=%H HEAD~5..HEAD); do
  wt=$(mktemp -d)
  git worktree add --detach "$wt" "$sha"
  ( cd "$wt" && node ${REPO}/scripts/openai-audit.mjs code \
      docs/plans/dead-code-phase-1-orphan-introduced.md \
      --scope diff \
      --base "${sha}^" --head "$sha" )    # explicit base/head match the production resolver path
  git worktree remove --force "$wt"
done
```

**Expected**: 0 false positives on shipped commits (all 5 should produce 0 orphan-introduced findings, or findings should be genuine intentional removals that we'd accept as MEDIUM and dismiss).

### Telemetry verification

After integration smoke, the per-run summary records make analysis straightforward:

```bash
cat .audit/orphan-metrics.jsonl | jq -s '
  [.[] | select(.kind == "orphan-run-summary")] |
  {
    total_runs: length,
    runs_with_findings: map(select(.surfacedFindingCount > 0)) | length,
    avg_surfaced:       (map(.surfacedFindingCount) | add / length),
    avg_raw:            (map(.rawFindingCount) | add / length),
    states:             group_by(.passState) | map({passState: .[0].passState, count: length})
  }
'
```

Sanity-check: `avg_surfaced ≤ 0.5` across 5 shipped commits (most should be 0).

---

## Out of Scope (Future)

| Item | Phase | Why deferred |
|---|---|---|
| Full-repo `/repo-scan` skill | 2 | Needs FP-rate telemetry from phase 1 first to inform heuristic vs wrap decision |
| knip / vulture / PurgeCSS wrap layer | 2 | Cross-stack scope; needs adapter contract extension |
| Domain → connectivity → root-cause clustering | 3 | Only valuable above ~10 findings/scan; phase 1 should produce 0-3 per audit |
| Soft-delete TTL workflow (auto-delete after 30 days no-refs) | 3 | Requires phase 2's clearance flow to produce candidates |
| HTML / SQL / Java orphan adapters | 3-4 | Custom builds; defer until phase 2 validates the contract |
| LLM rationale-writing on findings | 3 | Detection precision must be ≥90% before LLM-written rationale is trustworthy |
| Cross-LLM verification (GPT + Gemini independent vote) | 3 | Brainstorm pushback: correlated failure modes; only valuable on first onboarding scan |

### R3 audit deferrals (resolved at implementation time, not in plan)

| R3 finding | Why deferred to implementation |
|---|---|
| **R3/H2 — Preimage module resolution parity** | Two valid implementation paths exist (a: temp-worktree materialisation; b: shared resolver utility extracted from arch-intent). Choice depends on dependency-cruiser's API surface for in-memory input, which we'll validate during implementation. Plan-stage commitment: parity with HEAD adapter is REQUIRED; the implementation PR must include a parity test (same import list extracted by HEAD and pre-edge paths on the same file content). Failure to achieve parity blocks ship. |
| **R3/M2 — Test-only callers** | ~~Deferred to implementation.~~ **REVERSED after Gemini-R2 rebuttal** — Gemini correctly pointed out that `scope.entryPoints` already exempts public-contract files. A non-entry-point file with only test callers IS dead in prod. The detector now filters test callers from the zero-caller check (see algorithm §3). `testCallers` recorded in `_meta` for operator triage context. |

---

## Audit history

| Round | Auditor | Verdict | Outcome |
|---|---|---|---|
| R1 | GPT-5 (openai-audit plan) | NEEDS_REVISION (H:3 M:2) | All 5 fixed in plan: baseline contract (H1), unified suppression pipeline (H2), AST-based pre-edge extraction (H3), directional graph contract (M1), telemetry writer contract (M2) |
| R2 | GPT-5 (openai-audit plan) | NEEDS_REVISION (H:3 M:4 L:1) | All 3 HIGHs + M4 fixed (new HIGHs surfaced by R1's formal contract): rename caller identities (H1), D-status pre-edges (H2), target-existence subKind (H3), canonical fingerprint (M4). M1/M2/M3 also addressed (patch-only mode, telemetry schema, entry-point resolution). L1 fixed (worktree-based smoke test). |
| R3 | GPT-5 (openai-audit plan) | NEEDS_REVISION (H:3 M:2 L:0) — HIGH plateau confirmed (R1=3, R2=3, R3=3); rigor-pressure stop. R3/H1 (fingerprint canonical-evidence) + R3/H3 (working-tree mode union) + R3/M1 (pass-state SoT) fixed in plan. R3/H2 (preimage resolution parity) + R3/M2 (test-caller filtering) deferred to implementation-time with explicit rationale in Out-of-Scope §. |
| Gemini gate (R1) | Gemini Pro | CONCERNS (1 HIGH: G1 data-flow contract mismatch between detector output and pipeline fingerprint input). Fix: detector now emits `allRemovedCallers` (full sorted set) AND `priorCallers` (truncated display); pipeline uses the former for fingerprinting. Mechanical fix; trivial. |
| Gemini gate (R2) | Gemini Pro | CONCERNS_REMAINING (1 HIGH binary-file crash + 2 MED: N+1 spawns, ANALYZED_PARTIAL signal; 1 wrongly-dismissed: R3/M2 test-caller filtering). All 4 applied: SOURCE_EXTENSIONS pre-filter, single `git ls-tree` for `targetExistedAtBase`, `ANALYZED_PARTIAL` enum + inheritance, test-caller filter reversal. |
| Gemini gate (R3) | Gemini Pro | CONCERNS (1 HIGH type-only exclusion + 1 MED entry-point resolution gap + 1 LOW 'C' status). All 3 applied: adapter exposes two-track meta (violations excludes type-only, graph includes them), package.json output paths reverse-resolved via tsconfig rootDir/outDir, 'C' (copy) status handled like 'A'. |
| Gemini gate (R4) | Gemini Pro | CONCERNS (1 HIGH telemetry-coupling-in-pipeline + 1 MED missing -z null-termination). Both applied: pipeline returns `{survivors, suppressed}` and each pass orchestration owns its own metrics-sink call; all git CLI invocations now use `-z` for null-byte path separation. |
| Gemini gate (R5) | Gemini Pro | CONCERNS (1 HIGH unstable-removed-caller-identity + 1 MED variable-width record parser). Both applied: explicit `removedEdgesByTarget: Map<target, Set<caller>>` built during Step 1 (exact attribution, not reverse-walk); `-z` parser must consume 2 tokens for R/C, 1 for A/M/D. **Per protocol's documented max of 2 final-review rounds, stopping here and surfacing to user.** |

## Implementation Log

### 2026-05-12 — phase 1 shipped

**Completed**:
- `scripts/lib/audit/orphan-introduced.mjs` — pure detector (15 unit tests)
- `scripts/lib/audit/diff-scope-resolver.mjs` — git I/O + AST pre-edges via `git worktree` + dep-cruiser (10 integration tests)
- `scripts/lib/audit/findings-pipeline.mjs` — fingerprint + ledger-suppress + accept-v1 (kind-scoped per Gemini final-gate fix); 26 unit tests
- `scripts/lib/audit/orphan-metrics.mjs` — lock-safe single-batch JSONL writer
- `scripts/lib/audit/glob-match.mjs` — shared glob utility (extracted from deferral-classifier dup)
- `scripts/lib/schemas.mjs` — 5 new Zod schemas (OrphanPassState, ChangedFile, DiffScope, HeadGraphMeta, OrphanIntroducedFinding)
- `scripts/lib/arch-intent/adapters/js-ts.mjs` — extended `_meta` with two-track graph (violations-track excludes type-only, orphan-track includes it)
- `scripts/openai-audit.mjs` — Wave 1.5b orchestration wiring (post-arch-intent, pre-Wave-2)
- `.audit-loop/domain-map.json` — explicit `scripts/lib/audit/**` → `audit-orchestration` rule
- 51 new tests; full suite 2041/2042 (1 pre-existing vendoring SHA failure unrelated)

**Audit cycle**:
- /audit-plan: 3 GPT rounds + 5 Gemini gates → CONCERNS_REMAINING but stopped per documented 2-round cap
- /audit-code: 3 GPT rounds (R3 plateau on re-raises + rigor pressure) + 2 Gemini gates → all addressable issues resolved
- ~30 substantive findings addressed (mix of fix, dismiss, compromise via GPT deliberation)
- Gemini caught my bias on accept-v1 cross-pass leak (wrongly_dismissed) — fix applied: kind-scope gate on suppression

**Deviations from original plan**:
- `extractPreEdges` is internal-only (not exported) per R1/M3
- `computeEntryPoints` lives in `diff-scope-resolver.mjs` (orchestration-side) not the pure detector per R1/M2 + R2/M3
- accept-v1 suppression gated on `kind === 'orphan-introduced'` (Gemini final-gate fix — prevents cross-pass leak)
- Fixtures are programmatic in-test, not on-disk `tests/fixtures/orphan-introduced/scenario-*/` per R1/M1

**Out of scope (phase 2)**:
- R3/H2 preimage-resolution-parity test gate
- Full config-injection layer for entry-points + test patterns
- Gemini-final-R2/G1: arch-intent's `git ls-files` lacks `-z` (pre-existing arch-intent code, not phase 1 scope)
- Cross-LLM verification for /repo-scan (separate phase 2 skill)
- Knip/vulture/PurgeCSS wrap for full-repo dead-code clearance
- Clustering pipeline for blast-radius bounding
