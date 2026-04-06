# Plan: Phase I — CLAUDE.md / AGENTS.md Hygiene + Sprawl Control

- **Date**: 2026-04-06
- **Status**: Draft
- **Author**: Claude + Louis
- **Parent**: [skill-bundle-mega-plan.md](./skill-bundle-mega-plan.md)
- **Depends on**: Phase E (skills consolidated, single source of truth)
- **Scope**: Automated sprawl detection, reference-structure enforcement, and size-budgeting for `CLAUDE.md`, `AGENTS.md`, and skill files. Runs as a post-audit hook and standalone lint. Keeps instruction files small and effective as the project evolves.

---

## 1. Context

### The Problem

`CLAUDE.md` and `AGENTS.md` files are high-leverage: they configure how AI coding assistants behave in a repo. But they sprawl:
- Instructions grow as features ship — nobody prunes obsolete sections
- Copy-paste duplication between `CLAUDE.md` and `AGENTS.md` (they often cover the same ground)
- Architecture documentation migrates INTO instruction files instead of staying in supporting docs
- File paths, function names, and API details get hardcoded — then drift as code evolves
- Skill files (`SKILL.md`) accumulate context that belongs in CLAUDE.md or supporting docs, not inline

**Result**: a 15KB `CLAUDE.md` that an LLM loads into every conversation, most of which is irrelevant to any given task. Context waste = worse suggestions + higher cost.

### What Good Looks Like

A healthy `CLAUDE.md` is:
- **Under 3KB** (~750 tokens) for the file itself
- **Reference-heavy**: points to supporting docs rather than inlining architecture
- **Behavioral, not descriptive**: tells the assistant what to do/avoid, not how the code works
- **Current**: every file path, function name, and env var mentioned actually exists
- **Non-duplicated**: no content repeated between `CLAUDE.md`, `AGENTS.md`, and skill files

### Target Audience

- **Developers maintaining AI-assisted repos** — Phase I ships a linter they can run
- **The audit-loop itself** — Phase I adds a post-audit hygiene check (Step 6.5)
- **Skill authors** — guidelines for what belongs in SKILL.md vs CLAUDE.md

### Non-Goals

- Rewriting CLAUDE.md content (Phase I detects problems; fixing is manual or via skill guidance)
- Enforcing a specific CLAUDE.md template (projects differ)
- Cross-repo CLAUDE.md consistency (each repo is independent)
- AI-powered content suggestions (just linting rules + reference extraction)
- Modifying how Claude Code or Copilot load these files (platform behavior)

---

## 2. Proposed Architecture

### 2.1 Hygiene Linter (`scripts/claudemd-lint.mjs`)

CLI that analyzes instruction files and reports findings:

```bash
node scripts/claudemd-lint.mjs [--fix [--yes]] [--config .claudemd-lint.json] \
  [--format terminal|json|sarif] [--out <file>]
```

**I/O contract (fix I-R2-H1)**:
- `--format terminal` (default): findings to stderr, 1-line summary to stdout
- `--format json`: JSON report to file via `--out <file>` (required with json format), 1-line summary to stdout
- `--format sarif`: SARIF to file via `--out <file>`, 1-line summary to stdout
- `--out` is mandatory for json/sarif formats (fail-fast if missing)
- Follows the project's existing `--out <file>` convention (`openai-audit.mjs`, `gemini-review.mjs`)

**Input**: scans repo for instruction files, with **mandatory exclusions (fix I-R1-H6)**:

Default excluded globs (non-configurable):
- `.git/**`, `node_modules/**`, `dist/**`, `build/**`, `coverage/**`
- `tests/**/fixtures/**` (prevents self-contamination from test fixture repos)
- `vendor/**`, `.next/**`, `__pycache__/**`, `.venv/**`

Scanned file patterns:
- `CLAUDE.md` (root + any nested, excluding above)
- `AGENTS.md`
- `.claude/skills/*/SKILL.md`
- `.github/skills/*/SKILL.md`
- `.github/copilot-instructions.md`

**Rules** (each independently configurable):

| Rule ID | Severity | Description |
|---|---|---|
| `size/claude-md` | WARN | `CLAUDE.md` exceeds `maxBytes` (default 3072) |
| `size/agents-md` | WARN | `AGENTS.md` exceeds `maxBytes` (default 4096) |
| `size/skill-md` | WARN | Any `SKILL.md` exceeds `maxBytes` (default 30720) |
| `stale/file-ref` | ERROR | Referenced file path does not exist |
| `stale/function-ref` | WARN | Referenced function/class not found via grep |
| `stale/env-var` | WARN | Referenced env var not in `.env.example` or code |
| `dup/cross-file` | WARN | Paragraph-level similarity >80% between instruction files |
| `ref/deep-code-detail` | WARN | File contains >N fenced code blocks (default N=5) — deterministic count |
| `sync/claude-agents` | WARN | Same heading exists in both CLAUDE.md + AGENTS.md with different content — deterministic heading-match |

**Deferred rules (v2, fix I-R1-M3)** — too subjective for deterministic implementation:
- `dup/inline-arch`: requires classifying prose as "architecture vs behavioral" — needs ML/LLM
- `ref/missing-section-link`: requires understanding what "could be extracted" — judgment call

**Output formats**:
- Terminal (default): colored, grouped by file, severity-sorted → stderr
- JSON: `--format json` → stdout, validated against `HygieneReportSchema` (Zod 4, defined in `lib/schemas.mjs`)
- SARIF: `--format sarif` → stdout, for GitHub Code Scanning upload

**CLI exit codes (fix I-R1-H3)**:
- `0`: all rules pass (or only INFO findings)
- `1`: at least one ERROR finding
- `2`: at least one WARN finding (no ERRORs)
- `3`: linter itself failed (bad config, scan error)

**Report schema** (`HygieneReportSchema` in `lib/schemas.mjs`):
```javascript
{
  version: '1',
  timestamp: ISO-8601,
  files_scanned: string[],
  findings: [{
    ruleId: string,           // e.g. 'stale/file-ref'
    severity: 'error' | 'warn' | 'info',
    file: string,             // source file (repo-relative)
    line: number | null,
    message: string,
    semanticId: string,       // stable hash for cross-round dedup (fix I-R1-H5)
    fixable: boolean,
  }],
  summary: { error: number, warn: number, info: number },
}
```

**Orchestrator integration (Step 6.5, fix I-R2-H2)**:
1. Run `node scripts/claudemd-lint.mjs --format json --out /tmp/$SID-hygiene.json`
2. Parse report via `HygieneReportSchema`, check exit code
3. **State transitions**:
   - Exit 0 (clean or INFO only): proceed to Step 7 normally
   - Exit 2 (WARN only): include in convergence card as advisory, proceed to Step 7
   - Exit 1 (ERROR findings): **do NOT block convergence or rerun audit passes**. Instead:
     - Include ERROR findings in the convergence card with `HYGIENE_ERRORS` flag
     - Include in Step 7 transcript so Gemini/Opus can see them
     - Orchestrator presents them to the user as "hygiene issues found, fix before shipping"
     - Does NOT convert hygiene errors into audit-loop findings or reopen audit rounds
   - Exit 3 (linter crash): log warning to stderr, proceed to Step 7 (linter failure is non-blocking)
4. Hygiene report is included in transcript under `hygiene` key (validated by `TranscriptSchema`)

### 2.2 Reference Structure

Phase I encourages (does not enforce) a **tiered reference structure**:

```
CLAUDE.md           ← behavioral rules only, <3KB, references supporting docs
├── docs/arch/      ← architecture docs (diagrams, ADRs, data models)
├── docs/guides/    ← how-to guides for common tasks
└── AGENTS.md       ← agent-specific overrides only, references CLAUDE.md
```

The linter detects when content belongs in a supporting doc (`dup/inline-arch`, `ref/deep-code-detail`) and suggests extraction.

### 2.3 Post-Audit Hygiene Hook (Step 6.5)

After every audit-loop convergence (Step 6) and before the final review (Step 7), the orchestrator runs the hygiene linter:

```bash
node scripts/claudemd-lint.mjs --format json --out /tmp/$SID-hygiene.json
```

Results are:
1. Included in the audit transcript sent to Step 7 (Gemini/Claude Opus)
2. Summarized in the convergence report
3. Findings with severity ERROR block convergence (same as HIGH audit findings)

**Integration point**: the SKILL.md orchestrator adds a `hygiene` section to the Step 6 convergence card:

```
═══════════════════════════════════════
  CONVERGED — Round 4
  Final: H:0 M:2 L:1
  Hygiene: 1 ERROR (stale file ref), 2 WARN
═══════════════════════════════════════
```

### 2.4 Auto-Fix Mode (`--fix`)

For mechanical fixes only:

**Auto-fix is strictly structural (fix I-R1-H4)** — only operates on isolated nodes:

| Rule | Auto-fix | Safety constraint |
|---|---|---|
| `stale/file-ref` | Only fixes **standalone markdown link nodes** (entire `[text](path)` is the full line content or list-item content). If the reference is embedded within a sentence, auto-fix is skipped and a manual-fix hint is emitted | Never modifies surrounding text |
| `stale/function-ref` | No auto-fix | Functions may be renamed, not deleted |
| `dup/cross-file` | No auto-fix | Requires judgment |
| `size/*` | No auto-fix | Requires judgment |
| `stale/env-var` | No auto-fix | May be in a dependency |
| `ref/deep-code-detail` | **Suggestion only**: print the section + proposed `docs/` path to stderr. No file modification | Advisory |

Auto-fix writes are atomic (`atomicWriteFileSync`). `--fix` always runs `--dry-run` first (showing what would change), then applies only after confirmation (or `--fix --yes` for CI).

### 2.5 Configuration (`.claudemd-lint.json`)

```json
{
  "rules": {
    "size/claude-md": { "severity": "warn", "maxBytes": 3072 },
    "size/agents-md": { "severity": "warn", "maxBytes": 4096 },
    "size/skill-md": { "severity": "warn", "maxBytes": 30720 },
    "stale/file-ref": { "severity": "error" },
    "stale/function-ref": { "severity": "warn", "ignore": ["legacyHelper"] },
    "stale/env-var": { "severity": "warn" },
    "dup/cross-file": { "severity": "warn", "similarityThreshold": 0.8 },
    "dup/inline-arch": { "severity": "info" },
    "ref/missing-section-link": { "severity": "info" },
    "ref/deep-code-detail": { "severity": "warn", "maxCodeBlocks": 5 },
    "sync/claude-agents": { "severity": "warn" }
    // NOTE: dup/inline-arch + ref/missing-section-link are deferred (v2) and NOT in default config
  },
  "ignore": [
    "docs/plans/**"
  ]
}
```

Default config is sensible for most repos. Projects override per-rule severity + thresholds.

### 2.6 Stale-Reference Detection

**Path resolution contract (fix I-R1-H1)**:

Every extracted reference is resolved via `resolveReferencedPath(sourceFile, rawRef, repoRoot)`:
1. Skip external URLs (http/https/mailto), anchor-only links (`#section`)
2. Strip trailing anchors (`file.md#heading` → `file.md`) and query fragments
3. Resolve relative to the source file's directory (`path.resolve(path.dirname(sourceFile), rawRef)`)
4. Normalize to repo-relative path, check `fs.existsSync()` against repo root
5. Skip matches in code blocks (fenced ``` regions) — those are illustrative, not actual references

**File references**: regex matches for markdown links `[...](path)` and backtick paths matching common extensions (`*.{mjs,js,ts,py,json,yml,yaml,md,sql}`).

**Function references (fix I-R1-H2)**: in-process index, NOT shell-out-per-name:
1. At scan start, build a `Set<string>` of all exported identifiers by walking source files once:
   - `export function <name>`, `export class <name>`, `export const <name>`, `def <name>(` (Python)
   - Uses `fs.readFileSync` + per-line regex — NOT `grep` subprocesses
   - Source files discovered via `glob('**/*.{mjs,js,ts,py}')` with the **same mandatory exclusion set** as the instruction-file scanner (fix I-R2-H4): `.git`, `node_modules`, `dist`, `build`, `coverage`, `tests/**/fixtures/**`, `vendor`, `.next`, `__pycache__`, `.venv`
2. References in instruction files are matched against this set
3. Common false-positive names excluded: configurable `ignore` list in rule config (default: `init`, `run`, `main`, `test`, `setup`)

**Env-var references**: regex matches for `ALL_CAPS_WITH_UNDERSCORES` patterns (≥2 chars, ≥1 underscore). Checked against:
1. `.env.example` entries
2. `process.env.<VAR>` occurrences in source files (from the in-process index)
3. Known platform vars excluded: `NODE_ENV`, `PATH`, `HOME`, `CI`, `GITHUB_TOKEN`, `SHELL`, `USER`, `TERM` (configurable skip list)

### 2.7 Finding Identity (fix I-R1-H5)

Hygiene findings use the project's existing `semanticId()` function with a `hygiene:` namespace prefix:

```javascript
semanticId = sha256(`hygiene:${ruleId}:${repoRelativePath}:${normalizedContent}`).slice(0,16)
```

Where `normalizedContent` is:
- For `stale/file-ref`: the referenced path (normalized)
- For `stale/function-ref`: the function name
- For `stale/env-var`: the env var name
- For `dup/cross-file`: concatenation of the two file paths + paragraph index
- For `size/*`: the file path (one finding per file)
- For `sync/claude-agents`: both file paths + heading text (prevents collision for common headings like "Setup")

These IDs are stable across runs (same stale ref → same ID) and compatible with the audit loop's existing suppression/dedup infrastructure. Step 7 transcript includes hygiene findings under a `hygiene` key with these IDs.

### 2.9 Similarity Detection

Paragraph-level Jaccard similarity on normalized token sets (lowercased, stopwords removed):
- Compare every paragraph in `CLAUDE.md` against every paragraph in `AGENTS.md` + skill files
- Paragraphs >50 tokens with Jaccard >0.8 → `dup/cross-file` finding
- **Own implementation** in `lib/claudemd/doc-similarity.mjs` (fix I-R1-M2 — decoupled from `lib/ledger.mjs`). Same algorithm (Jaccard on token sets) but own module with document-specific normalization (markdown-aware: strips formatting, links, code blocks before tokenizing)

### 2.8 CI Integration

Optional GitHub Action workflow:

```yaml
# .github/workflows/claudemd-lint.yml
name: CLAUDE.md Hygiene
on: [pull_request]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: node scripts/claudemd-lint.mjs --format sarif --out results.sarif
        continue-on-error: true    # fix I-R2-M5: non-zero exit codes are informational, not step failures
      - uses: github/codeql-action/upload-sarif@v3
        if: always()               # upload SARIF even if linter found issues
        with:
          sarif_file: results.sarif
```

SARIF upload enables findings to appear as inline PR annotations.

---

## 3. File Impact Summary

**New files**:

| File | Purpose |
|---|---|
| `scripts/claudemd-lint.mjs` | Thin CLI entry point (fix I-R1-M1 — canonical: CLI in scripts/, domain in scripts/lib/) |
| `scripts/lib/claudemd/rules.mjs` | Rule definitions + check logic (9 deterministic rules, no deferred v2 rules) |
| `scripts/lib/claudemd/file-scanner.mjs` | Discover instruction files in repo (with mandatory exclusions) |
| `scripts/lib/claudemd/ref-checker.mjs` | Stale-reference detection (files, functions, env vars) |
| `scripts/lib/claudemd/doc-similarity.mjs` | Document-level Jaccard similarity (own implementation, NOT ledger.mjs) |
| `scripts/lib/claudemd/sarif-formatter.mjs` | SARIF output formatting |
| `scripts/lib/claudemd/autofix.mjs` | Structural auto-fix operations |
| `scripts/lib/claudemd/step65-hook.mjs` | Orchestrator Step 6.5 integration (runs CLI, parses report) |
| `tests/claudemd/rules.test.mjs` | Rule logic tests |
| `tests/claudemd/ref-checker.test.mjs` | Reference detection tests |
| `tests/claudemd/doc-similarity.test.mjs` | Similarity scoring tests |
| `tests/claudemd/integration.test.mjs` | End-to-end lint tests with fixture repos |
| `.claudemd-lint.json` | Default config for this repo |

**Modified files**:

| File | Change |
|---|---|
| `.claude/skills/audit-loop/SKILL.md` | Add Step 6.5 hygiene hook description |
| `.github/skills/audit-loop/SKILL.md` | Same |
| `scripts/lib/schemas.mjs` | Add `HygieneReportSchema`, `HygieneFindingSchema`, `HygieneConfigSchema`; extend `TranscriptSchema` with optional `hygiene` key (fix I-R2-H3) |
| `package.json` | No new dependencies |

---

## 4. Testing Strategy

### Unit tests

- **rules.mjs**: each rule tested with fixture files that trigger/pass the rule
- **ref-checker.mjs**: test stale file detection, function detection, env-var detection with fixture repos
- **similarity.mjs**: test known-similar paragraphs at various Jaccard thresholds

### Integration tests

- **Fixture repos** in `tests/claudemd/fixtures/`:
  - `clean/` — passes all rules
  - `sprawl/` — 15KB CLAUDE.md, triggers `size/claude-md`
  - `stale/` — file refs to deleted files, triggers `stale/file-ref`
  - `dup/` — duplicated paragraphs between CLAUDE.md + AGENTS.md
  - `deep-code/` — CLAUDE.md with inline SQL schemas + function signatures

### Auto-fix tests

- Run `--fix` on fixture repos, verify output matches expected fixed files
- Verify atomic-write safety (no partial fix on crash simulation)

---

## 5. Rollback Strategy

- **Revert Phase I**: remove `scripts/claudemd-lint.mjs` + `lib/claudemd/`. Step 6.5 in SKILL.md logs a **visible warning** to stderr (`[hygiene] linter not found, skipping Step 6.5`) rather than silently succeeding (fix I-R2-M6). No data dependencies.
- **Disable per-repo**: set all rules to `"off"` in `.claudemd-lint.json`

---

## 6. Implementation Order

1. **`lib/claudemd/file-scanner.mjs`** — discover instruction files
2. **`lib/claudemd/ref-checker.mjs`** + tests — stale-reference detection
3. **`lib/claudemd/similarity.mjs`** + tests — reuse Jaccard from ledger.mjs
4. **`lib/claudemd/rules.mjs`** + tests — all 11 rules
5. **`scripts/claudemd-lint.mjs`** — CLI with terminal + JSON output
6. **`lib/claudemd/sarif-formatter.mjs`** — SARIF output
7. **`lib/claudemd/autofix.mjs`** + tests — mechanical fixes
8. **Integration tests** with fixture repos
9. **Step 6.5 hook** in SKILL.md
10. **`.claudemd-lint.json`** for this repo
11. **CI workflow example** in docs

---

## 7. Known Limitations (accepted for Phase I)

1. **No content suggestions** — the linter detects problems but doesn't suggest what to write. Fixing sprawl requires human judgment about what's important.
2. **Function-ref detection is heuristic** — regex-based, not AST-parsed. May produce false positives for common names like `init`, `run`, `main`.
3. **Similarity is paragraph-level** — won't catch sentence-level duplication or semantic similarity (same idea, different words).
4. **No cross-repo analysis** — each repo is linted independently. Can't detect duplication between repos sharing the same skills.
5. **Auto-fix is conservative** — only removes clearly stale references. Size/dup/arch issues require manual intervention.
6. **SKILL.md size budget (30KB)** — generous because skills carry operational instructions. May need per-skill tuning.
7. **Step 6.5 is advisory** — hygiene findings (including ERRORs) are reported but do NOT block convergence or reopen audit rounds. They are presented to the user and included in the Step 7 transcript for visibility.
8. **Nested CLAUDE.md comparison scope (I-R3-H6)**: `dup/cross-file` and `sync/claude-agents` compare files **within the same directory tree only** (a nested `CLAUDE.md` in `packages/api/` is compared against `packages/api/AGENTS.md`, NOT against root `CLAUDE.md`). Root-level files are compared against each other. This keeps the comparison set bounded and meaningful.
9. **Config format is strict JSON (I-R3-H4)**: `.claudemd-lint.json` is JSON, not JSONC. No comments. Deferred v2 rules are NOT listed in the config — the schema validates only known rule IDs.
10. **Auto-fix for stale file-refs is opt-in and conservative (I-R3-H5)**: only applies to **standalone markdown link nodes** where the entire line is a link. If the reference is embedded in prose, auto-fix skips it. `--fix --yes` is required for unattended mode; interactive mode shows a preview first.
11. **Orchestrator integration module (I-R3-H2)**: Step 6.5 logic lives in `scripts/lib/claudemd/step65-hook.mjs` — thin module that runs the CLI, parses the report, and returns structured findings for the convergence card. SKILL.md describes the hook; the module implements it.

---

## 8. Resolved Design Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| Q1 | Lint-only or lint+rewrite? | **Lint-only** (with conservative auto-fix) | Rewriting instruction files requires judgment |
| Q2 | Default CLAUDE.md size budget? | **3KB (~750 tokens)** | Enough for behavioral rules + references; forces extraction |
| Q3 | Where to hook into audit loop? | **Step 6.5** (after convergence, before final review) | Catches drift without blocking the audit |
| Q4 | Similarity algorithm? | **Jaccard on normalized token sets** | Already implemented in ledger.mjs suppression |
| Q5 | New dependency for SARIF? | **No — hand-build SARIF JSON** | SARIF schema is simple; avoids dep |
| Q6 | Block convergence on hygiene ERRORs? | **No** — advisory only, presented to user + Step 7 | Hygiene is a different concern from code correctness; blocking convergence would mix audit and lint semantics |
| Q7 | Detect CLAUDE.md/AGENTS.md conflicts? | **Yes — `sync/claude-agents` rule** | Common source of confusion when both exist |
| Q8 | Support nested CLAUDE.md? | **Yes — scan all** | Claude Code supports them at any directory level |
| Q9 | Enforce reference structure? | **No — suggest via INFO findings** | Different projects have different doc structures |
| Q10 | CI integration method? | **SARIF upload to GitHub Code Scanning** | Inline PR annotations, no custom UI |
