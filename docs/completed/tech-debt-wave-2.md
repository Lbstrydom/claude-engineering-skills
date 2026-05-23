# Plan: Tech Debt Wave 2 — Responsibility Splits & Safety Fixes
- **Date**: 2026-04-17
- **Status**: Complete (shipped — `scripts/shared.mjs` god-module split into focused `scripts/lib/*.mjs` files: `code-analysis.mjs`, `audit-scope.mjs`, `diff-annotation.mjs`, `plan-paths.mjs`, `ledger.mjs`, `context.mjs`, `findings.mjs` + barrel; canonical paths via `file-io.mjs`. Documented in AGENTS.md "Architecture" section. Status line corrected 2026-05-23.)
- **Author**: Claude + Louis

---

## 1. Context Summary

### What Exists Today

Wave 1 (complete) split the original `shared.mjs` monolith into 35+ focused lib modules.
The barrel re-export (`shared.mjs`) still exists but is only imported by 6 files — most
consumers already import directly from `lib/*.mjs`.

The split followed *extraction lines* (what was in shared.mjs) rather than *responsibility
boundaries* (what changes together). Three modules remain oversized:

| Module | Lines | Responsibilities | Importers |
|--------|-------|-----------------|-----------|
| `file-io.mjs` | 596 | 7 (atomic writes, path utils, sensitive filtering, audit-infra exclusion, diff annotation, plan extraction, file classification) | 19 files |
| `findings.mjs` | 552 | 6 (identity/hashing, formatting, FP tracker, outcomes, effectiveness, tasks) | 14 files |
| `context.mjs` | 608 | 4 (repo profiling, audit brief, CLAUDE.md parsing, session cache) | acceptable — fewer distinct responsibilities |

Additionally, `file-io.mjs` has two security-adjacent issues (boundary enforcement) and
missing error recovery that should be fixed before any structural work.

### Existing Patterns to Reuse

- **Barrel re-export**: `shared.mjs` re-exports 162 symbols from 19 modules. New splits
  must add re-exports to maintain backward compat.
- **`file-store.mjs`**: `MutexFileStore` and `AppendOnlyStore` already provide structured
  persistence — `findings.mjs` already uses these for task storage.
- **`language-profiles.mjs`**: Registry pattern for language-specific behavior. Extension
  maps in `file-io.mjs` should defer to this registry (DRY, Single Source of Truth).
- **`config.mjs`**: Centralized env var reads. No new env vars needed.

---

## 2. Proposed Architecture

### Implementation Phases

Work is organized into 4 phases. Each phase is independently shippable — later phases
do not depend on earlier ones being complete.

```
Phase 1 (Fix Now)     — Safety & reliability fixes in file-io.mjs (no structural changes)
Phase 2 (Split)       — file-io.mjs → 4 focused modules + barrel
Phase 3 (Split)       — findings.mjs → 4 focused modules + barrel
Phase 4 (Annotate)    — Global state annotations + accepted debt documentation
```

### Dependency Graph After Splits

```
                    ┌─────────────────────────────────────┐
                    │           shared.mjs (barrel)        │
                    └─────────┬───────────────────────────┘
                              │ re-exports all symbols
          ┌───────────────────┼───────────────────────────────┐
          ▼                   ▼                               ▼
   ┌──────────────┐   ┌──────────────┐               ┌──────────────┐
   │  file-io.mjs │   │ findings.mjs │               │  ledger.mjs  │
   │  (barrel)    │   │  (barrel)    │               │              │
   └──────┬───────┘   └──────┬───────┘               └──────────────┘
          │                  │
    ┌─────┼──────┐     ┌─────┼──────┐
    ▼     ▼      ▼     ▼     ▼      ▼
  core  diff   plan  ident tracker outcomes
  -io   -annot -paths        format  tasks
        audit-scope          effectiveness
```

---

## 3. Phase 1 — Safety & Reliability Fixes (Fix Now)

**Principles**: Defensive Validation (#12), Graceful Degradation (#16), Consistent Error Handling (#15)

No structural changes — all fixes are within `file-io.mjs`. Quick wins.

### 1A. `isSensitiveFile()` — Check Full Path, Not Just Basename

**Problem**: `isSensitiveFile('config/credentials/prod.json')` returns `false` because
`path.basename()` is `prod.json` which matches no pattern. The `/credential/i` pattern
would catch `credentials.json` but not files *under* a `credentials/` directory.

**Fix**: Test against the full relative path AND the basename. The existing patterns
already use case-insensitive regex, so testing the full path catches directory names too.

```javascript
// BEFORE
export function isSensitiveFile(relPath) {
  const basename = path.basename(relPath);
  return SENSITIVE_PATTERNS.some(p => p.test(basename));
}

// AFTER
export function isSensitiveFile(relPath) {
  const norm = relPath.replaceAll('\\', '/');
  return SENSITIVE_PATTERNS.some(p => p.test(norm));
}
```

**Why full path works**: `/credential/i` matches `config/credentials/prod.json` because
the path string contains "credential". Same for `/secret/i` matching `secrets/db.json`.
The `.env` patterns use anchors (`/\.env$/i`) so they won't false-positive on paths
like `src/environment/config.js`.

**Risk**: The `/token/i` and `/password/i` patterns could false-positive on paths
like `src/tokenizer/utils.js` or `src/password-strength/validator.js`. Mitigate by
tightening these two patterns to require word boundaries or directory separators:

```javascript
const SENSITIVE_PATTERNS = [
  /\.env$/i, /\.env\./i, /secret/i, /credential/i, /\.pem$/i, /\.key$/i,
  /(?:^|[/\\])password(?:[/\\.]|$)/i,   // directory or file named "password"
  /(?:^|[/\\])tokens?(?:[/\\.]|$)/i,    // directory or file named "token(s)"
  /\.pfx$/i, /\.p12$/i, /id_rsa/i, /id_ed25519/i
];
```

**Tests to add**:
- `config/credentials/prod.json` → sensitive (directory match)
- `secrets/db-config.json` → sensitive
- `.env.production` → sensitive (existing, verify still works)
- `src/tokenizer/utils.js` → NOT sensitive (false positive guarded)
- `src/password-strength/check.mjs` → NOT sensitive

### 1B. `readFilesAsContext()` — Path Containment Fix

**Problem**: `absPath.startsWith(cwdBoundary)` is not a safe containment check.
`/home/user/project-other/file.js` starts with `/home/user/project` if the CWD
is `/home/user/project`.

**Fix**: Use `path.relative()` and reject paths that escape with `..`:

```javascript
// BEFORE
const cwdBoundary = path.resolve('.');
// ...
if (!absPath.startsWith(cwdBoundary)) { omitted++; continue; }

// AFTER
const cwdBoundary = path.resolve('.');
// ...
const rel = path.relative(cwdBoundary, absPath);
if (rel.startsWith('..') || path.isAbsolute(rel)) { omitted++; continue; }
```

Apply the same fix in `_buildFileBlock()` (line 344) which has the same pattern.

**Tests to add**:
- `../sibling-repo/file.js` → omitted
- `scripts/lib/config.mjs` → included (within repo)
- Absolute path outside CWD → omitted

### 1C. `readFilesAsContext()` — Per-File Error Recovery

**Problem**: No try/catch around `fs.readFileSync()`. A race condition (file deleted
between existence check and read), permission error, or binary file causes the entire
context assembly to abort.

**Fix**: Wrap per-file read in try/catch:

```javascript
for (const relPath of filePaths) {
  if (isSensitiveFile(relPath)) { sensitive++; continue; }

  const absPath = path.resolve(relPath);
  const rel = path.relative(cwdBoundary, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { omitted++; continue; }

  let raw;
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) { // 2MB guard
      omitted++;
      continue;
    }
    raw = fs.readFileSync(absPath, 'utf-8');
  } catch {
    omitted++; // file missing, permissions, or race condition
    continue;
  }
  // ... rest of processing
}
```

Apply the same pattern to `_buildFileBlock()` which has the same unguarded read.

**Tests to add**:
- Non-existent file in list → skipped, others still processed
- Directory path in list → skipped
- Very large file (>2MB simulated via stat) → skipped

### 1D. Extension Map — Deduplicate with language-profiles.mjs

**Problem**: `readFilesAsContext()` hardcodes `{ sql: 'sql', css: 'css', ... }` for
language detection. `_buildFileBlock()` and `getCommentStyle()` have separate extension
sets (`CODE_EXTS`, `HEADER_ONLY_EXTS`). `language-profiles.mjs` is the single source
of truth for language extensions.

**Fix**: Import from `language-profiles.mjs` instead of hardcoding. Add a
`getLanguageName(ext)` helper to the profiles registry.

**Principle**: Single Source of Truth (#10), DRY (#1)

---

## 4. Phase 2 — file-io.mjs Responsibility Split

**Principles**: SRP (#2), Modularity (#7), Interface Segregation (#5)

### New Module Layout

| New module | Responsibility | Exports | Lines (est.) |
|-----------|---------------|---------|-------------|
| `scripts/lib/file-io.mjs` | Core I/O + path utils + barrel re-exports | `atomicWriteFileSync`, `readFileOrDie`, `normalizePath`, `safeInt`, `writeOutput` + re-exports from children | ~80 + re-exports |
| `scripts/lib/diff-annotation.mjs` | Diff parsing + CHANGED/UNCHANGED markers | `parseDiffFile`, `readFilesAsAnnotatedContext`, `getCommentStyle` | ~210 |
| `scripts/lib/plan-paths.mjs` | Plan path extraction + repo scanning | `extractPlanPaths`, `classifyFiles` | ~200 |
| `scripts/lib/audit-scope.mjs` | File filtering + scope decisions | `isSensitiveFile`, `isAuditInfraFile`, `readFilesAsContext`, `AUDIT_INFRA_BASENAMES` | ~120 |

### Migration Strategy — Zero Breakage

1. Create new modules, move functions (cut-paste, not rewrite)
2. Update internal `import` statements within the new modules
3. **`file-io.mjs` becomes a barrel** — re-exports everything from the 3 children:
   ```javascript
   // file-io.mjs — barrel re-export (backward compat)
   export { atomicWriteFileSync, readFileOrDie, normalizePath, safeInt, writeOutput } from './file-io-core.mjs';
   export { parseDiffFile, readFilesAsAnnotatedContext, getCommentStyle } from './diff-annotation.mjs';
   export { extractPlanPaths, classifyFiles } from './plan-paths.mjs';
   export { isSensitiveFile, isAuditInfraFile, readFilesAsContext } from './audit-scope.mjs';
   ```
4. All 19 importers of `file-io.mjs` continue working unchanged
5. Over time, direct importers can switch to the specific child module for
   tighter dependencies (optional, not required)

**Key detail**: The core I/O functions must live in a new file (`file-io-core.mjs`)
rather than staying in `file-io.mjs`, because `file-io.mjs` becomes the barrel.
Alternatively, rename the barrel to `file-io.mjs` and keep core functions in place
alongside re-exports — simpler, fewer renames.

**Chosen approach**: Keep core functions in `file-io.mjs` alongside re-exports.
The other 3 modules import from `file-io.mjs` for shared utils (`normalizePath`,
`isSensitiveFile`). This avoids circular deps because the flow is:
```
file-io.mjs (core + barrel)
  ← audit-scope.mjs (imports normalizePath)
  ← diff-annotation.mjs (imports normalizePath, isSensitiveFile from audit-scope)
  ← plan-paths.mjs (imports isAuditInfraFile from audit-scope, normalizePath)
```

Wait — `diff-annotation.mjs` needs `isSensitiveFile` which moves to `audit-scope.mjs`.
And `audit-scope.mjs` needs `normalizePath` from `file-io.mjs`. This creates:
```
file-io.mjs → exports normalizePath (stays here)
audit-scope.mjs → imports normalizePath from file-io.mjs, exports isSensitiveFile
diff-annotation.mjs → imports from audit-scope.mjs + file-io.mjs
plan-paths.mjs → imports from audit-scope.mjs + file-io.mjs
file-io.mjs → re-exports from audit-scope, diff-annotation, plan-paths
```

No circular deps. file-io.mjs has core + re-exports. Child modules import core
utils from file-io.mjs but do NOT import from each other's re-exports.

### Dependency Rules

- `audit-scope.mjs` imports: `file-io.mjs` (normalizePath), `language-profiles.mjs`
- `diff-annotation.mjs` imports: `file-io.mjs` (normalizePath), `audit-scope.mjs` (isSensitiveFile)
- `plan-paths.mjs` imports: `file-io.mjs` (normalizePath), `audit-scope.mjs` (isAuditInfraFile, isSensitiveFile), `language-profiles.mjs`
- `file-io.mjs` imports: `language-profiles.mjs` (existing), re-exports from children

### `shared.mjs` Updates

Add re-exports for any new module names if consumers switch to direct imports.
The existing re-exports from `file-io.mjs` continue working — no changes needed
until consumers opt in to direct imports.

---

## 5. Phase 3 — findings.mjs Responsibility Split

**Principles**: SRP (#2), Modularity (#7), Testability (#11)

### New Module Layout

| New module | Responsibility | Exports | Lines (est.) |
|-----------|---------------|---------|-------------|
| `scripts/lib/findings.mjs` | Barrel + identity/hashing | `semanticId` + re-exports from children | ~70 + re-exports |
| `scripts/lib/findings-format.mjs` | Finding display | `formatFindings` | ~40 |
| `scripts/lib/findings-tracker.mjs` | FP tracker class + decay math | `FalsePositiveTracker`, `extractDimensions`, `buildPatternKey`, `applyLazyDecay`, `effectiveSampleSize`, `recordWithDecay` | ~130 |
| `scripts/lib/findings-outcomes.mjs` | Outcome logging + effectiveness | `appendOutcome`, `loadOutcomes`, `compactOutcomes`, `computePassEffectiveness`, `computePassEWR`, `setRepoProfileCache` | ~170 |
| `scripts/lib/findings-tasks.mjs` | Remediation task CRUD | `createRemediationTask`, `trackEdit`, `verifyTask`, `persistTask`, `loadTasks`, `updateTask` | ~80 |

### Migration Strategy

Same barrel pattern as Phase 2:
```javascript
// findings.mjs — barrel re-export (backward compat)
export { semanticId } from './findings.mjs';  // stays in this file
export { formatFindings } from './findings-format.mjs';
export { FalsePositiveTracker, extractDimensions, ... } from './findings-tracker.mjs';
export { appendOutcome, setRepoProfileCache, ... } from './findings-outcomes.mjs';
export { createRemediationTask, trackEdit, ... } from './findings-tasks.mjs';
```

### Module-Global State Migration

- `_repoProfileCache` moves to `findings-outcomes.mjs` (the only consumer)
- `_taskStore` moves to `findings-tasks.mjs` (the only consumer)
- Cross-module injection (`setRepoProfileCache`) stays exported from `findings-outcomes.mjs`,
  re-exported via `findings.mjs` barrel

### Dependency Rules

- `findings-format.mjs` imports: nothing from siblings (pure formatter)
- `findings-tracker.mjs` imports: `config.mjs` (learningConfig)
- `findings-outcomes.mjs` imports: `file-io.mjs` (atomicWriteFileSync), `file-store.mjs`, `config.mjs`
- `findings-tasks.mjs` imports: `file-store.mjs`, `config.mjs`
- `findings.mjs` (barrel): `crypto`, re-exports from children

No circular deps — children never import from `findings.mjs`.

---

## 6. Phase 4 — Global State & Accepted Debt

### 4A. FILE_REGEX — Create Per-Call Instead of Module-Global

**File**: `scripts/lib/ledger.mjs` (line 21)

**Problem**: `FILE_REGEX` is a global regex with `.lastIndex` state. Callers must
reset `.lastIndex = 0` before each use (line 220). Missing this reset is a latent bug.

**Fix**: Replace the module-global with a factory function:

```javascript
// BEFORE
const FILE_REGEX = buildFileReferenceRegex();
// ... in populateFindingMetadata():
FILE_REGEX.lastIndex = 0;
while ((match = FILE_REGEX.exec(section)) !== null) { ... }

// AFTER
function getFileRegex() { return buildFileReferenceRegex(); }
// ... in populateFindingMetadata():
const fileRegex = getFileRegex();
while ((match = fileRegex.exec(section)) !== null) { ... }
```

**Cost**: Marginal — `buildFileReferenceRegex()` constructs a regex from a static
extension list. Creating it per-call adds ~0.01ms. The function is called once
per finding (not in a hot loop).

### 4B. Cross-Module Cache Coupling — Annotate, Don't Refactor

**Pattern**: `context.mjs` → `setRepoProfileCache()` → `findings.mjs`

**Assessment**: This is a one-way injection to avoid circular imports. It works
correctly in the CLI-per-invocation model. Refactoring to dependency injection
would add complexity for no practical benefit.

**Action**: Add a JSDoc annotation explaining the coupling:

```javascript
/**
 * @WARNING Module-global state — safe in CLI-per-invocation model.
 * If this module is ever used as a library, this cache must be replaced
 * with dependency injection (pass repoProfile as a function parameter).
 * See: context.mjs → setRepoProfileCache() → this module
 */
let _repoProfileCache = null;
```

### 4C. Accepted Permanent Debt — Document Rationale

Add a `## Accepted Technical Debt` section to CLAUDE.md:

```markdown
## Accepted Technical Debt

These items were evaluated and deliberately accepted:

| Item | Rationale | Revisit trigger |
|------|-----------|-----------------|
| `atomicWriteFileSync` no fsync | CLI tool, not a database. Rename atomicity protects against process crash (the real failure mode). | Never — unless used in a daemon/server context |
| `atomicWriteFileSync` temp naming (PID+timestamp) | Collision requires same PID + same millisecond + same directory. Probability < 1 in 10^9. | Never |
| `readFileOrDie` process.exit(1) | Name is self-documenting. Only called from CLI entry points. | If the function is ever called from a library context |
| `normalizePath()` lowercasing | Correct for Windows (case-insensitive FS). Project runs on Windows. On case-sensitive Linux, distinct files could collide — acceptable since audit-loop audits local repos, not cross-platform file servers. | If audit-loop is deployed as a CI service on Linux |
```

---

## 7. File-Level Plan

### Phase 1 Files (Safety Fixes)

#### `scripts/lib/file-io.mjs` (modify)
- **Changes**: Fix `isSensitiveFile()` to check full path; fix path containment in
  `readFilesAsContext()` and `_buildFileBlock()` to use `path.relative()`; add per-file
  try/catch + stat size guard; tighten `/token/i` and `/password/i` patterns
- **Dependencies**: None new
- **Why**: Defensive Validation (#12), Graceful Degradation (#16)

#### `tests/file-io.test.mjs` (modify)
- **Changes**: Add test cases for sensitive directory detection, path traversal rejection,
  per-file error recovery, large file skip
- **Why**: Testability (#11)

### Phase 2 Files (file-io.mjs Split)

#### `scripts/lib/audit-scope.mjs` (new)
- **Exports**: `isSensitiveFile`, `isAuditInfraFile`, `readFilesAsContext`, `AUDIT_INFRA_BASENAMES`
- **Imports**: `normalizePath` from `file-io.mjs`, `ALL_EXTENSIONS_PATTERN` from `language-profiles.mjs`
- **Why**: SRP (#2) — scope/filtering is a distinct responsibility from I/O

#### `scripts/lib/diff-annotation.mjs` (new)
- **Exports**: `parseDiffFile`, `readFilesAsAnnotatedContext`, `getCommentStyle`
- **Imports**: `normalizePath` from `file-io.mjs`, `isSensitiveFile` from `audit-scope.mjs`
- **Why**: SRP (#2) — diff annotation is a distinct responsibility from plan extraction

#### `scripts/lib/plan-paths.mjs` (new)
- **Exports**: `extractPlanPaths`, `classifyFiles`
- **Imports**: `normalizePath` from `file-io.mjs`, `isAuditInfraFile`, `isSensitiveFile` from `audit-scope.mjs`, `ALL_EXTENSIONS_PATTERN` from `language-profiles.mjs`
- **Why**: SRP (#2) — plan path extraction has different change reasons than I/O

#### `scripts/lib/file-io.mjs` (modify → barrel + core)
- **Keeps**: `atomicWriteFileSync`, `readFileOrDie`, `normalizePath`, `safeInt`, `writeOutput`
- **Adds**: Re-exports from `audit-scope.mjs`, `diff-annotation.mjs`, `plan-paths.mjs`
- **Why**: Backward Compatibility (#18) — all 19 importers continue working

#### `scripts/shared.mjs` (modify)
- **Changes**: No changes needed (re-exports from `file-io.mjs` which is now a barrel)

#### `scripts/sync-to-repos.mjs` (modify)
- **Changes**: Add `audit-scope.mjs`, `diff-annotation.mjs`, `plan-paths.mjs` to `CORE_SCRIPTS`

#### `tests/audit-scope.test.mjs` (new)
- **Tests**: `isSensitiveFile` full-path matching, `isAuditInfraFile` edge cases, `readFilesAsContext` containment
- **Why**: Split tests follow split modules

#### `tests/diff-annotation.test.mjs` (new)
- **Tests**: `parseDiffFile` hunk extraction, `readFilesAsAnnotatedContext` marker placement
- **Why**: The existing file-io.test.mjs tests move here

### Phase 3 Files (findings.mjs Split)

#### `scripts/lib/findings-format.mjs` (new)
- **Exports**: `formatFindings`
- **Imports**: none from siblings
- **Why**: Pure formatter — no state, no I/O

#### `scripts/lib/findings-tracker.mjs` (new)
- **Exports**: `FalsePositiveTracker`, `extractDimensions`, `buildPatternKey`, `applyLazyDecay`, `effectiveSampleSize`, `recordWithDecay`
- **Imports**: `config.mjs`
- **Why**: FP tracking is a self-contained subsystem

#### `scripts/lib/findings-outcomes.mjs` (new)
- **Exports**: `setRepoProfileCache`, `appendOutcome`, `loadOutcomes`, `compactOutcomes`, `computePassEffectiveness`, `computePassEWR`
- **Imports**: `file-io.mjs` (atomicWriteFileSync), `file-store.mjs`, `config.mjs`
- **Owns**: `_repoProfileCache` module-global (with annotation)
- **Why**: Outcome logging and metrics are a distinct responsibility

#### `scripts/lib/findings-tasks.mjs` (new)
- **Exports**: `createRemediationTask`, `trackEdit`, `verifyTask`, `persistTask`, `loadTasks`, `updateTask`
- **Imports**: `file-store.mjs`, `config.mjs`
- **Owns**: `_taskStore` module-global
- **Why**: Task CRUD is self-contained

#### `scripts/lib/findings.mjs` (modify → barrel + identity)
- **Keeps**: `semanticId` (identity/hashing — core responsibility)
- **Adds**: Re-exports from 4 child modules
- **Why**: Backward Compatibility (#18) — all 14 importers continue working

#### `scripts/sync-to-repos.mjs` (modify)
- **Changes**: Add findings-format, findings-tracker, findings-outcomes, findings-tasks to `CORE_SCRIPTS`

### Phase 4 Files (Annotations)

#### `scripts/lib/ledger.mjs` (modify)
- **Changes**: Replace `FILE_REGEX` module-global with per-call `getFileRegex()` factory
- **Why**: Eliminate `.lastIndex` state bug risk

#### `scripts/lib/findings-outcomes.mjs` (modify)
- **Changes**: Add `@WARNING` JSDoc annotation on `_repoProfileCache`

#### `CLAUDE.md` (modify)
- **Changes**: Add `## Accepted Technical Debt` section

---

## 8. Risk & Trade-off Register

| Risk | Mitigation | Severity |
|------|-----------|----------|
| Barrel re-exports add import indirection | Minimal perf impact — Node.js caches modules. Consumers can opt into direct imports over time. | LOW |
| `isSensitiveFile` full-path check could false-positive | Tightened `/token/i` and `/password/i` with word boundaries. Other patterns are specific enough. | LOW |
| Phase 2/3 splits produce many small files | Each file has a clear responsibility and is testable in isolation. 80-210 lines each is the sweet spot. | LOW |
| `shared.mjs` barrel grows | Already 162 symbols. New modules add re-exports to `file-io.mjs` and `findings.mjs`, not `shared.mjs`. No growth. | NONE |
| Sync-to-repos.mjs must include new files | Added to CORE_SCRIPTS array. Setup check validates file presence. | LOW |

### Deliberately Deferred

| Item | Reason |
|------|--------|
| `openai-audit.mjs` split (2119 lines) | Genuine orchestrator — complexity is inherent, not accidental. Extract only when adding new orchestration modes. |
| `context.mjs` split (608 lines) | 4 responsibilities but tightly coupled (profiling feeds brief which feeds context). Split would create artificial seams. |
| Module-global caches → DI | CLI-per-invocation makes globals safe. Refactor only if extracting as a library. |

---

## 9. Testing Strategy

### Phase 1 Tests (file-io.test.mjs additions)

```
isSensitiveFile — full path matching
  ✓ catches files under sensitive directories (credentials/, secrets/)
  ✓ still catches basename matches (.env, .pem, id_rsa)
  ✓ does NOT false-positive on tokenizer/, password-strength/

readFilesAsContext — path containment
  ✓ rejects ../sibling-repo/file.js
  ✓ rejects absolute paths outside CWD
  ✓ accepts normal repo-relative paths

readFilesAsContext — error recovery
  ✓ skips deleted files, processes remaining
  ✓ skips directories in file list
  ✓ skips files > 2MB size guard
  ✓ returns partial context when some files fail
```

### Phase 2 Tests (new test files)

```
tests/audit-scope.test.mjs
  ✓ isSensitiveFile edge cases (moved from file-io.test.mjs)
  ✓ isAuditInfraFile edge cases (moved from file-io.test.mjs)
  ✓ readFilesAsContext integration

tests/diff-annotation.test.mjs
  ✓ parseDiffFile hunk parsing
  ✓ readFilesAsAnnotatedContext CHANGED/UNCHANGED markers (moved from file-io.test.mjs)
  ✓ getCommentStyle extension routing
```

### Phase 3 Tests (new test files)

```
tests/findings-tracker.test.mjs
  ✓ FalsePositiveTracker (moved from shared.test.mjs)
  ✓ applyLazyDecay, effectiveSampleSize (moved from shared.test.mjs)

tests/findings-outcomes.test.mjs
  ✓ appendOutcome, loadOutcomes, compactOutcomes
  ✓ computePassEffectiveness, computePassEWR (moved from shared.test.mjs)
```

### Continuous Validation

After each phase: `npm test` must show 825+ tests passing. The barrel re-exports
ensure no import breakage. New tests increase coverage, never decrease it.

---

## 10. Sustainability Notes

### Assumptions That Could Change

1. **CLI-only model** → If audit-loop becomes a library or daemon, module-global
   state needs DI refactoring. Phase 4 annotations mark exactly where.
2. **Windows-primary** → If deployed as Linux CI service, `normalizePath()` lowercasing
   needs revisiting. Documented in accepted debt.
3. **Single-repo auditing** → If auditing multiple repos in parallel (CI matrix),
   the module-global caches would share state across runs. The CLI-per-process model
   prevents this today.

### Extension Points

- **New file filter**: Add to `audit-scope.mjs` without touching I/O or diff code
- **New annotation style**: Add to `diff-annotation.mjs` without touching plan extraction
- **New finding identity scheme**: Modify `semanticId` in `findings.mjs` without touching tracker or outcomes
- **New outcome store**: Modify `findings-outcomes.mjs` without touching formatting or tracking
