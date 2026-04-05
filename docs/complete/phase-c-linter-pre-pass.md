# Plan: Phase C — Linter Pre-Pass Integration

- **Date**: 2026-04-04
- **Status**: Audit-complete, ready to implement
- **Audit history**: 2 rounds (R1 H:6 M:5 L:0 → R2 H:4 M:4 L:1)
- **Stopping criteria**: HIGH count decreased meaningfully (6→4, -33%) and MEDIUM held (5→4). Phase C had the clearest convergence signal of the three plans. Remaining HIGH findings concern cross-source dedup (deferred to v2 by design), strict-mode determinism (pinned tooling = out of scope), and project-level diagnostics (scoped out for v1). Trust boundary is explicitly documented in §1.
- **Author**: Claude + Louis
- **Scope**: Run language-appropriate linters/type-checkers before GPT, inject their findings into the canonical pipeline, and free GPT's reasoning budget for architectural issues.
- **Parent plan**: `multi-language-and-linter-integration.md` (Phase C of 3)
- **Depends on**: Phase A (language profiles) + Phase B (ClassificationSchema)
- **Extends Phase B**: Adds `LINTER` and `TYPE_CHECKER` to `ClassificationSchema.sourceKind` enum

---

## 1. Context Summary

### What Exists Today

GPT wastes significant reasoning tokens on mechanical issues that linters detect in milliseconds:

- `no-unused-vars`, `no-console`, unused imports
- Type errors (`any` casting, missing types)
- Bare `except:` in Python, mutable default args
- Formatting/style issues

Meanwhile, GPT's architectural reasoning (SOLID, DRY, sustainability, wiring) is under-budgeted. The current audit takes 150-200s per pass partly because GPT is re-doing what linters already do.

No external tool execution exists beyond `git` at [config.mjs:39](scripts/lib/config.mjs#L39).

### Security: Execution Trust Boundary

**This plan changes the trust boundary** — running repo-configured linters means executing code/config the repo owner controls (ESLint configs can `require()` custom rules, `tsconfig.json` affects compilation). This is equivalent to running `npm test` in the repo, which is already an accepted threat model for audit-loop.

**Threat model**: The audit-loop already reads repo source files and sends them to external LLMs. Running repo's own linters is a strictly smaller trust concern than that data exfiltration path.

**Mitigations already in place**:
- `execFileSync` with argv arrays (no shell expansion, no command injection)
- Fixed 60s timeout per tool
- Captured stderr (no interactive input)
- No elevated privileges

**Mitigations added for Phase C**:
- `--no-tools` CLI flag: disable all tool execution (opt-out for untrusted repos)
- `AUDIT_LOOP_ALLOW_TOOLS=1` env gate: explicit opt-in for CI environments
- Log every tool invocation to stderr (auditability)
- Tool findings clearly attributed in output JSON (not silently mixed into GPT output)

**Out of scope**: sandboxed tool execution (Docker), capability-restricted subprocess APIs — these would be appropriate for executing tools from untrusted repos, but the audit-loop already runs in a trust context where the user controls the repo.

### Why Linter Pre-Pass Works

1. **Speed** — Linters return in seconds, GPT takes minutes
2. **Determinism** — Same code → same findings, no LLM variance
3. **Mechanical fixes** — Auto-applicable via `--fix`
4. **Better GPT prompts** — "Skip these, focus on design" frees tokens for what GPT is uniquely good at

### Key Requirements

1. **Advisory-by-default** — tool findings don't affect verdict math unless `--strict-lint`. Keeps verdict reproducible across machines with different tool availability.
2. **Canonical lifecycle** — tool findings enter the same `FindingSchema` pipeline as GPT findings. No parallel tracking.
   **Known dedup limitation**: Tool and model findings about the same defect have DIFFERENT semantic IDs (file-based vs content-hash). Both appear in output. The lint summary in prompts tells GPT "don't re-raise these" to mitigate noise. Forcing cross-source equivalence is deferred to v2.
3. **Structured execution** — `execFileSync` with argv arrays, no shell strings, no path concat.
4. **Status envelope** — `ToolRunResult` distinguishes `ok` / `no_tool` / `failed` / `timeout`. Callers know what happened.
5. **Post-filtered scope** — project-scoped tools (tsc, eslint) run at repo root, findings filtered to audited file set.
6. **Rule metadata registry** — explicit mapping from tool rule IDs to severity + sonarType.

### Non-Goals

- Per-file cache / persistence — keep in-memory only, recompute per audit run
- Monorepo per-root execution — single `cwd`, post-filter
- Custom tool plugins / config generation — use whatever tool config exists in the repo
- Running tools in Docker / pinned version management — out of scope
- `--fix` auto-application — detect only, don't mutate source

---

## 2. Proposed Architecture

### 2.0 Extend Phase B ClassificationSchema

**Modified file**: `scripts/lib/schemas.mjs`

Phase B declared `sourceKind` as `['MODEL', 'REVIEWER']`. Phase C adds `'LINTER'` and `'TYPE_CHECKER'`:

```javascript
// In ClassificationSchema (Phase B):
sourceKind: z.enum(['MODEL', 'REVIEWER', 'LINTER', 'TYPE_CHECKER']).describe(...)
```

**SQL migration update** (extend the Phase B constraint):

```sql
-- Update chk_source_kind to include tool source kinds (idempotent via DROP + ADD)
ALTER TABLE audit_findings DROP CONSTRAINT IF EXISTS chk_source_kind;
ALTER TABLE audit_findings
  ADD CONSTRAINT chk_source_kind
  CHECK (source_kind IS NULL OR source_kind IN ('MODEL', 'REVIEWER', 'LINTER', 'TYPE_CHECKER'));
```

**Note**: The Phase B migration already includes LINTER/TYPE_CHECKER in its constraint (future-proofing), so Phase C's schema change only touches Zod.

### 2.1 Extend Language Profiles with `tools[]`

**Modified file**: `scripts/lib/language-profiles.mjs` (adds tools config to existing Phase A profiles)

```javascript
// Example (appended to existing js profile):
js: Object.freeze({
  // ... existing Phase A fields (extensions, regex, resolvers) ...

  // Phase C: tool configurations
  tools: Object.freeze([
    Object.freeze({
      id: 'eslint',              // Stable identity for RULE_METADATA lookup + sourceName
      kind: 'linter',            // 'linter' | 'typeChecker'
      command: 'npx',
      args: ['eslint', '--format', 'json', '--no-error-on-unmatched-pattern', '.'],
      scope: 'project',          // 'file' | 'project'
      availabilityProbe: ['npx', ['eslint', '--version']],
      parser: 'parseEslintOutput',
    })
  ])
}),

ts: Object.freeze({
  // ... existing Phase A fields ...
  tools: Object.freeze([
    Object.freeze({
      id: 'eslint',
      kind: 'linter',
      command: 'npx',
      args: ['eslint', '--format', 'json', '.'],
      scope: 'project',
      availabilityProbe: ['npx', ['eslint', '--version']],
      parser: 'parseEslintOutput',
    }),
    Object.freeze({
      id: 'tsc',
      kind: 'typeChecker',
      command: 'npx',
      args: ['tsc', '--noEmit', '--pretty', 'false'],
      scope: 'project',
      availabilityProbe: ['npx', ['tsc', '--version']],
      parser: 'parseTscOutput',
    })
  ])
}),

py: Object.freeze({
  // ... existing Phase A fields ...
  tools: Object.freeze([
    Object.freeze({
      id: 'ruff',
      kind: 'linter',
      command: 'ruff',
      args: ['check', '--output-format', 'json', '.'],
      scope: 'project',
      availabilityProbe: ['ruff', ['--version']],
      parser: 'parseRuffOutput',
      fallback: Object.freeze({
        id: 'flake8',
        kind: 'linter',
        command: 'flake8',
        args: ['--format', 'pylint', '.'],  // pylint format is built-in
        scope: 'project',
        availabilityProbe: ['flake8', ['--version']],
        parser: 'parseFlake8PylintOutput',
      })
    })
  ])
}),
```

### 2.2 Tool Runner (`lib/linter.mjs`)

**New file**: `scripts/lib/linter.mjs`

```javascript
/**
 * @fileoverview Tool pre-pass orchestration — runs linters and type-checkers,
 * normalizes output to canonical FindingSchema format.
 *
 * Design:
 * - Uses execFileSync with argv arrays (no shell, no path concat)
 * - Status envelope distinguishes no_tool / failed / timeout from ok
 * - Post-filters project-scoped tool output to audited file set
 * - Graceful: missing tools never block the audit
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { normalizePath } from './file-io.mjs';
import { getAllProfiles, getProfileForFile } from './language-profiles.mjs';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * ToolRunResult — contract for all tool executions.
 * @typedef {object} ToolRunResult
 * @property {'ok'|'no_tool'|'failed'|'timeout'} status
 * @property {RawLintFinding[]} findings  - Parsed findings (pre-normalization)
 * @property {object} usage - { files: number }
 * @property {number} latencyMs
 * @property {string} stderr
 * @property {string} toolId   - Stable identity: 'ruff' | 'eslint' | 'tsc'
 * @property {string} toolKind - 'linter' | 'typeChecker'
 */

/**
 * RawLintFinding — parser output, before normalization to FindingSchema.
 * @typedef {object} RawLintFinding
 * @property {string} file
 * @property {number} line
 * @property {number} [endLine]
 * @property {number} [column]
 * @property {string} rule     - Rule ID (e.g. 'no-unused-vars', 'F401', 'TS2304')
 * @property {string} message
 * @property {boolean} fixable
 */

const TOOL_TIMEOUT_MS = 60_000;
const TOOL_MAX_BUFFER_BASE = 10 * 1024 * 1024; // 10MB base
const TOOL_MAX_BUFFER_PER_FILE = 100 * 1024;    // +100KB per file (tolerates large finding sets)

/** Size buffer based on audited file count. Prevents overflow on large repos. */
function computeMaxBuffer(fileCount) {
  return Math.max(TOOL_MAX_BUFFER_BASE, TOOL_MAX_BUFFER_BASE + fileCount * TOOL_MAX_BUFFER_PER_FILE);
}

// ── Tool Availability ────────────────────────────────────────────────────────

/**
 * Check if a tool is available. Uses argv array, not shell.
 * @param {[string, string[]]} probe - [command, args]
 * @returns {boolean}
 */
function isToolAvailable([command, args = []]) {
  try {
    execFileSync(command, args, { stdio: 'pipe', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

// ── Tool Execution ───────────────────────────────────────────────────────────

/**
 * Run a single tool. Returns ToolRunResult envelope.
 * @param {object} toolConfig - From profile.tools[]
 * @param {string[]} auditedFiles - Files the audit is analyzing (for post-filtering)
 * @param {string} profileId - e.g. 'js', 'py'
 * @returns {ToolRunResult}
 */
export function runTool(toolConfig, auditedFiles, profileId) {
  const startMs = Date.now();
  const fileSet = new Set(auditedFiles.map(f => normalizePath(f)));
  const toolId = toolConfig.id;
  const toolKind = toolConfig.kind;

  // Availability check
  if (!isToolAvailable(toolConfig.availabilityProbe)) {
    if (toolConfig.fallback) {
      process.stderr.write(`  [tool] ${profileId}/${toolId} not available — trying fallback ${toolConfig.fallback.id}\n`);
      return runTool(toolConfig.fallback, auditedFiles, profileId);
    }
    process.stderr.write(`  [tool] ${profileId}/${toolId} not available — skipping\n`);
    return { status: 'no_tool', findings: [], usage: { files: 0 }, latencyMs: 0, stderr: '', toolId, toolKind };
  }

  // Execute
  try {
    const stdout = execFileSync(toolConfig.command, toolConfig.args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: TOOL_TIMEOUT_MS,
      cwd: process.cwd(),
      maxBuffer: computeMaxBuffer(auditedFiles.length),
    });
    const rawFindings = PARSERS[toolConfig.parser](stdout);
    const filtered = rawFindings.filter(f => fileSet.has(normalizePath(f.file)));
    const filteredOut = rawFindings.length - filtered.length;
    process.stderr.write(`  [tool] ${profileId}/${toolId}: ${filtered.length} findings${filteredOut > 0 ? ` (${filteredOut} out-of-scope filtered)` : ''} in ${((Date.now() - startMs) / 1000).toFixed(1)}s\n`);
    return { status: 'ok', findings: filtered, usage: { files: auditedFiles.length }, latencyMs: Date.now() - startMs, stderr: '', toolId, toolKind };
  } catch (err) {
    // Tools commonly exit non-zero when findings exist — try stdout anyway
    if (err.stdout) {
      try {
        const rawFindings = PARSERS[toolConfig.parser](err.stdout.toString());
        const filtered = rawFindings.filter(f => fileSet.has(normalizePath(f.file)));
        return { status: 'ok', findings: filtered, usage: { files: auditedFiles.length }, latencyMs: Date.now() - startMs, stderr: err.stderr?.toString() || '', toolId, toolKind };
      } catch { /* fall through */ }
    }
    const isTimeout = err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT';
    process.stderr.write(`  [tool] ${profileId}/${toolId}: ${isTimeout ? 'timeout' : 'failed'}: ${err.message?.slice(0, 100)}\n`);
    return { status: isTimeout ? 'timeout' : 'failed', findings: [], usage: { files: 0 }, latencyMs: Date.now() - startMs, stderr: err.message, toolId, toolKind };
  }
}

/**
 * Run all applicable tools for the audited file set.
 * Deduplicates tools by `id` — ESLint is one tool for both JS and TS (runs once),
 * not two separate executions. Tools are grouped by id, then the union of files
 * from all languages that use that tool is passed for post-filtering.
 * @param {string[]} files
 * @returns {ToolRunResult[]}
 */
export function executeTools(files) {
  // Group files by language profile, collecting unique tool configs
  const toolsById = new Map(); // toolId → { config, profileId, files: Set }
  for (const f of files) {
    const profile = getProfileForFile(f);
    if (profile.id === 'unknown' || !profile.tools) continue;
    for (const toolConfig of profile.tools) {
      if (!toolsById.has(toolConfig.id)) {
        toolsById.set(toolConfig.id, { config: toolConfig, profileId: profile.id, files: new Set() });
      }
      toolsById.get(toolConfig.id).files.add(f);
    }
  }

  const results = [];
  for (const { config, profileId, files: toolFiles } of toolsById.values()) {
    results.push(runTool(config, [...toolFiles], profileId));
  }
  return results;
}

// ── Parser Dispatch ──────────────────────────────────────────────────────────

const PARSERS = {
  parseEslintOutput,
  parseTscOutput,
  parseRuffOutput,
  parseFlake8PylintOutput,
};

export function parseEslintOutput(stdout) {
  const data = JSON.parse(stdout);
  const findings = [];
  for (const file of data) {
    for (const msg of (file.messages || [])) {
      findings.push({
        file: file.filePath ? path.relative(process.cwd(), file.filePath).replace(/\\/g, '/') : '',
        line: msg.line || 1,
        endLine: msg.endLine,
        column: msg.column,
        rule: msg.ruleId || 'unknown',
        message: msg.message || '',
        fixable: !!msg.fix,
      });
    }
  }
  return findings;
}

export function parseRuffOutput(stdout) {
  const data = JSON.parse(stdout);
  return data.map(item => ({
    file: item.filename ? path.relative(process.cwd(), item.filename).replace(/\\/g, '/') : '',
    line: item.location?.row || 1,
    endLine: item.end_location?.row,
    column: item.location?.column,
    rule: item.code || 'unknown',
    message: item.message || '',
    fixable: !!item.fix,
  }));
}

export function parseTscOutput(stdout) {
  // tsc --pretty false output: "path/to/file.ts(10,5): error TS2304: Cannot find name 'foo'."
  const findings = [];
  const regex = /^(.+?)\((\d+),(\d+)\):\s+\w+\s+(TS\d+):\s+(.+)$/gm;
  let match;
  while ((match = regex.exec(stdout)) !== null) {
    findings.push({
      file: match[1].replace(/\\/g, '/'),
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
      rule: match[4],
      message: match[5].trim(),
      fixable: false,
    });
  }
  return findings;
}

export function parseFlake8PylintOutput(stdout) {
  // pylint format: "path:line: [code] message"
  const findings = [];
  const regex = /^(.+?):(\d+):\s*\[(\w+)\]\s*(.+)$/gm;
  let match;
  while ((match = regex.exec(stdout)) !== null) {
    findings.push({
      file: match[1].replace(/\\/g, '/'),
      line: parseInt(match[2], 10),
      rule: match[3],
      message: match[4].trim(),
      fixable: false,
    });
  }
  return findings;
}
```

### 2.3 Rule Metadata Registry

**New file**: `scripts/lib/rule-metadata.mjs`

Maps tool rule IDs to canonical severity + sonarType. Starts with top-20 rules per tool, grows from experience.

```javascript
/**
 * @fileoverview Rule metadata registry — maps tool rule IDs to canonical audit taxonomy.
 * One registry per tool. Unknown rules fall back to _default.
 *
 * Contribution path: when a rule feels misclassified in practice, add a specific entry.
 * The registry grows organically from audit outcomes.
 */

export const RULE_METADATA = Object.freeze({
  eslint: Object.freeze({
    // Bugs (runtime-breaking)
    'no-undef': { severity: 'HIGH', sonarType: 'BUG', effort: 'EASY', isQuickFix: false },
    'no-unreachable': { severity: 'HIGH', sonarType: 'BUG', effort: 'EASY', isQuickFix: false },
    'no-dupe-keys': { severity: 'HIGH', sonarType: 'BUG', effort: 'TRIVIAL', isQuickFix: false },
    'no-dupe-args': { severity: 'HIGH', sonarType: 'BUG', effort: 'TRIVIAL', isQuickFix: false },
    'use-before-define': { severity: 'MEDIUM', sonarType: 'BUG', effort: 'EASY', isQuickFix: false },
    // Vulnerabilities
    'no-eval': { severity: 'HIGH', sonarType: 'VULNERABILITY', effort: 'MEDIUM', isQuickFix: false },
    'no-implied-eval': { severity: 'HIGH', sonarType: 'VULNERABILITY', effort: 'MEDIUM', isQuickFix: false },
    // Code smells
    'no-unused-vars': { severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'TRIVIAL', isQuickFix: false },
    'no-console': { severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'TRIVIAL', isQuickFix: false },
    'prefer-const': { severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'TRIVIAL', isQuickFix: false },
    '@typescript-eslint/no-explicit-any': { severity: 'MEDIUM', sonarType: 'CODE_SMELL', effort: 'EASY', isQuickFix: false },
    '@typescript-eslint/no-unused-vars': { severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'TRIVIAL', isQuickFix: false },
    _default: { severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'EASY', isQuickFix: false },
  }),

  ruff: Object.freeze({
    // Security (S-prefix = bandit-integrated rules)
    'S102': { severity: 'HIGH', sonarType: 'VULNERABILITY', effort: 'MEDIUM', isQuickFix: false }, // exec-builtin
    'S301': { severity: 'HIGH', sonarType: 'VULNERABILITY', effort: 'MEDIUM', isQuickFix: false }, // pickle
    'S307': { severity: 'HIGH', sonarType: 'VULNERABILITY', effort: 'MEDIUM', isQuickFix: false }, // eval-used
    'S608': { severity: 'HIGH', sonarType: 'VULNERABILITY', effort: 'MEDIUM', isQuickFix: false }, // sql injection
    'S324': { severity: 'MEDIUM', sonarType: 'VULNERABILITY', effort: 'EASY', isQuickFix: false },  // weak hash
    // Bugs (F-prefix = pyflakes)
    'F401': { severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'TRIVIAL', isQuickFix: false }, // unused import
    'F811': { severity: 'MEDIUM', sonarType: 'BUG', effort: 'EASY', isQuickFix: false },       // redefined
    'F821': { severity: 'HIGH', sonarType: 'BUG', effort: 'EASY', isQuickFix: false },         // undefined name
    'F841': { severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'TRIVIAL', isQuickFix: false }, // unused variable
    // Code smells (E-prefix = pycodestyle, B = bugbear)
    'B006': { severity: 'MEDIUM', sonarType: 'BUG', effort: 'EASY', isQuickFix: false },       // mutable default arg
    'B008': { severity: 'MEDIUM', sonarType: 'BUG', effort: 'EASY', isQuickFix: false },       // function call in default
    'E722': { severity: 'MEDIUM', sonarType: 'CODE_SMELL', effort: 'EASY', isQuickFix: false }, // bare except
    _default: { severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'EASY', isQuickFix: false },
  }),

  tsc: Object.freeze({
    'TS2304': { severity: 'HIGH', sonarType: 'BUG', effort: 'EASY', isQuickFix: false },  // Cannot find name
    'TS2322': { severity: 'HIGH', sonarType: 'BUG', effort: 'EASY', isQuickFix: false },  // Type not assignable
    'TS2339': { severity: 'HIGH', sonarType: 'BUG', effort: 'EASY', isQuickFix: false },  // Property does not exist
    'TS2345': { severity: 'HIGH', sonarType: 'BUG', effort: 'EASY', isQuickFix: false },  // Argument type mismatch
    'TS7006': { severity: 'MEDIUM', sonarType: 'CODE_SMELL', effort: 'EASY', isQuickFix: false },  // Implicit any
    'TS7053': { severity: 'MEDIUM', sonarType: 'CODE_SMELL', effort: 'EASY', isQuickFix: false },  // Index expression
    'TS18048': { severity: 'MEDIUM', sonarType: 'BUG', effort: 'EASY', isQuickFix: false }, // possibly undefined
    _default: { severity: 'MEDIUM', sonarType: 'BUG', effort: 'EASY', isQuickFix: false },
  }),

  flake8: Object.freeze({
    // Flake8 uses same E/F/W codes as ruff for overlapping rules
    'F401': { severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'TRIVIAL', isQuickFix: false },
    'F821': { severity: 'HIGH', sonarType: 'BUG', effort: 'EASY', isQuickFix: false },
    'E722': { severity: 'MEDIUM', sonarType: 'CODE_SMELL', effort: 'EASY', isQuickFix: false },
    _default: { severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'EASY', isQuickFix: false },
  }),

  _default: Object.freeze({
    severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'EASY', isQuickFix: false,
  }),
});

/**
 * Look up metadata for a rule. Falls back to tool's _default, then global _default.
 */
export function getRuleMetadata(toolId, ruleId) {
  const toolRegistry = RULE_METADATA[toolId];
  if (!toolRegistry) return RULE_METADATA._default;
  return toolRegistry[ruleId] || toolRegistry._default || RULE_METADATA._default;
}
```

### 2.4 Normalize Tool Results → Canonical FindingSchema

**Same file**: `scripts/lib/linter.mjs`

```javascript
import { getRuleMetadata } from './rule-metadata.mjs';

/**
 * Normalize a single raw lint finding to FindingSchema (with classification).
 * @param {RawLintFinding} raw
 * @param {ToolRunResult} result - Parent result (provides toolId, toolKind)
 * @param {number} autoIndex - 1-based sequence for ID generation
 * @returns {object} FindingSchema-shaped object
 */
export function normalizeExternalFinding(raw, result, autoIndex) {
  const meta = getRuleMetadata(result.toolId, raw.rule);
  const sourceKind = result.toolKind === 'typeChecker' ? 'TYPE_CHECKER' : 'LINTER';

  return {
    id: `T${autoIndex}`,
    severity: meta.severity,
    category: `[${meta.sonarType}] ${raw.rule}`,
    section: `${raw.file}:${raw.line}`,
    detail: raw.message,
    risk: `Static analysis rule violation: ${raw.rule}`,
    recommendation: `Review and resolve rule: ${raw.rule}. ${raw.fixable ? 'Auto-fix available via tool --fix flag.' : 'Manual fix required.'}`,
    is_quick_fix: meta.isQuickFix,
    is_mechanical: true,
    principle: raw.rule,
    classification: {
      sonarType: meta.sonarType,
      effort: meta.effort,
      sourceKind,
      sourceName: result.toolId,
    },
  };
}

/**
 * Normalize all tool results into canonical findings.
 * @param {ToolRunResult[]} results
 * @returns {object[]} FindingSchema[]
 */
export function normalizeToolResults(results) {
  const findings = [];
  let idx = 0;
  for (const result of results) {
    if (result.status !== 'ok') continue;
    for (const raw of result.findings) {
      findings.push(normalizeExternalFinding(raw, result, ++idx));
    }
  }
  return findings;
}
```

### 2.5 Lint Context Injection (Prompt Budget Safe)

**Same file**: `scripts/lib/linter.mjs`

```javascript
const LINT_CONTEXT_TOKEN_BUDGET = 2000; // ~8K chars max

/**
 * Format tool findings as a SUMMARIZED context block for GPT prompts.
 * Uses global budget; summarizes by rule when raw listing would exceed it.
 * @param {object[]} normalizedFindings - Canonical findings with classification
 * @param {number} [budget=LINT_CONTEXT_TOKEN_BUDGET]
 * @returns {string}
 */
export function formatLintSummary(normalizedFindings, budget = LINT_CONTEXT_TOKEN_BUDGET) {
  if (normalizedFindings.length === 0) return '';

  const header = '## Pre-detected Static Analysis Findings (mechanical — already flagged)\n' +
    'The following have been detected by linters/type-checkers. Do NOT re-raise them.\n' +
    'Focus on architectural, design, and logic issues that static analysis cannot detect.\n\n';

  // Small set: list directly
  if (normalizedFindings.length <= 15) {
    const lines = normalizedFindings.map(f =>
      `- ${f.section}: [${f.principle}] ${f.detail.slice(0, 80)}`
    );
    const block = header + lines.join('\n');
    if (block.length <= budget * 4) return block; // ~4 chars/token
  }

  // Large set: summarize by rule
  const ruleCount = {};
  const sevCount = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of normalizedFindings) {
    ruleCount[f.principle] = (ruleCount[f.principle] || 0) + 1;
    sevCount[f.severity]++;
  }
  const topRules = Object.entries(ruleCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([rule, count]) => `  - ${rule}: ${count}x`)
    .join('\n');
  return header +
    `**Summary**: ${normalizedFindings.length} findings (H:${sevCount.HIGH} M:${sevCount.MEDIUM} L:${sevCount.LOW})\n` +
    `**Top rules**:\n${topRules}\n\n` +
    `Do NOT re-raise these patterns.`;
}
```

### 2.6 Integration in openai-audit.mjs

**Modified file**: `scripts/openai-audit.mjs`

Add Phase 0 pre-pass before GPT passes start:

```javascript
import { executeTools, normalizeToolResults, formatLintSummary } from './lib/linter.mjs';

// Inside runMultiPassCodeAudit(), BEFORE GPT passes:

process.stderr.write('\n── Phase 0: Tool Pre-Pass ──\n');
const toolResults = executeTools([...found]);
const normalizedToolFindings = normalizeToolResults(toolResults);
const toolCapability = {
  toolsAvailable: toolResults.filter(r => r.status === 'ok').map(r => r.toolId),
  toolsFailed: toolResults.filter(r => r.status !== 'ok').map(r => ({ id: r.toolId, status: r.status })),
  strictLint: args.includes('--strict-lint'),
  timestamp: Date.now(),
};

// Lint summary injected into pass prompts to tell GPT what's already covered
const lintContext = formatLintSummary(normalizedToolFindings);

// Pass lintContext into pass prompts (appended to system message)
// ... existing GPT pass logic, with lintContext added to each pass's system prompt ...

// Merge normalized tool findings into allFindings
for (const f of normalizedToolFindings) {
  f._hash = semanticId(f); // Uses file:line:rule identity (see 2.7)
  f._pass = 'tool';
  allFindings.push(f);
}

// Attach capability state to result
mergedResult._toolCapability = toolCapability;
```

### 2.7 Tool Finding Identity (Extend `semanticId`)

**Modified file**: `scripts/lib/findings.mjs` — `semanticId()`

Tool findings use `file:line:rule` as identity inputs (deterministic cross-round). Model findings continue using content hash.

```javascript
export function semanticId(f) {
  const kind = f.classification?.sourceKind;
  if (kind === 'LINTER' || kind === 'TYPE_CHECKER') {
    // Tool finding: identity is file + rule + message (stable across line-number shifts).
    // Line numbers drift when unrelated lines are added/removed above — a `no-unused-vars`
    // at line 42 is the same finding if it moves to line 47. Use message as tiebreaker
    // for multiple instances of the same rule in the same file.
    const [file] = (f.section || '').split(':');
    const rule = f.principle || 'unknown';
    // Use first 60 chars of message (stable, includes variable names)
    const msgSnippet = (f.detail || '').slice(0, 60).toLowerCase().trim();
    return crypto.createHash('sha256')
      .update(`${normalizePath(file)}|${rule}|${msgSnippet}`)
      .digest('hex')
      .slice(0, 8);
  }
  // Model finding: content hash (existing behavior)
  const content = `${f.category}|${f.section}|${f.detail}`.toLowerCase().trim();
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
}
```

### 2.8 Advisory vs Strict Verdict Math

**Modified file**: `scripts/openai-audit.mjs` — verdict computation

Default: tool findings DON'T affect the verdict. Only `--strict-lint` counts them.

```javascript
const strictLint = args.includes('--strict-lint');

// When computing verdict:
const modelFindings = allFindings.filter(f =>
  f.classification?.sourceKind !== 'LINTER' && f.classification?.sourceKind !== 'TYPE_CHECKER'
);
const countFor = strictLint ? allFindings : modelFindings;
const high = countFor.filter(f => f.severity === 'HIGH').length;
const medium = countFor.filter(f => f.severity === 'MEDIUM').length;
// ... verdict math as before
```

Tool findings ARE included in the output JSON regardless — they're just advisory by default for verdict determination.

### 2.9 SKILL.md Documentation

**Modified files**: `.claude/skills/audit-loop/SKILL.md`, `.github/skills/audit-loop/SKILL.md`

Add a section describing tool pre-pass behavior, `--strict-lint` flag, and how to interpret tool capability state.

---

## 3. File Impact Summary

| File | Changes |
|---|---|
| `scripts/lib/language-profiles.mjs` | Add `tools[]` arrays to existing profiles (Phase A) |
| `scripts/lib/linter.mjs` | **New** — `runTool`, `executeTools`, `normalizeExternalFinding`, `normalizeToolResults`, `formatLintSummary`, parsers |
| `scripts/lib/rule-metadata.mjs` | **New** — `RULE_METADATA` registry, `getRuleMetadata()` |
| `scripts/lib/findings.mjs` | Extend `semanticId()` to dispatch on `classification.sourceKind` |
| `scripts/openai-audit.mjs` | Add Phase 0 pre-pass, inject lint context into prompts, advisory verdict math, `--strict-lint` flag |
| `scripts/shared.mjs` | Re-export linter + rule-metadata symbols |
| `.claude/skills/audit-loop/SKILL.md` | Document tool pre-pass, `--strict-lint` |
| `.github/skills/audit-loop/SKILL.md` | Mirror SKILL.md |
| `tests/linter.test.mjs` | **New** — parsers, runTool mocks, normalization, summary formatting |
| `tests/rule-metadata.test.mjs` | **New** — lookup, fallbacks |

---

## 4. Testing Strategy

### Unit Tests — Hermetic (no external tools)

| Test | What it validates |
|---|---|
| `parseEslintOutput()` on captured fixture | Normalizes ESLint JSON to RawLintFinding[] |
| `parseRuffOutput()` on captured fixture | Normalizes ruff JSON |
| `parseTscOutput()` on captured text | Regex-parses tsc output |
| `parseFlake8PylintOutput()` on captured text | Regex-parses flake8 pylint format |
| `getRuleMetadata('eslint', 'no-undef')` | Returns HIGH/BUG |
| `getRuleMetadata('eslint', 'unknown-rule')` | Returns eslint._default |
| `getRuleMetadata('unknown-tool', 'any')` | Returns global _default |
| `normalizeExternalFinding()` populates classification | sourceKind, sourceName, sonarType set |
| `normalizeToolResults()` skips failed results | Only status='ok' results contribute |
| `formatLintSummary([])` | Empty string |
| `formatLintSummary(smallSet)` | Direct listing |
| `formatLintSummary(largeSet)` | Summarized by rule |
| `formatLintSummary()` respects budget | Output ≤ budget * 4 chars |
| `runTool()` with mocked execFileSync — success | Returns status:'ok' with findings |
| `runTool()` with mocked execFileSync — non-zero exit + stdout | Parses stdout anyway (findings present) |
| `runTool()` with mocked execFileSync — timeout | Returns status:'timeout' |
| `runTool()` with mocked availabilityProbe failure | Returns status:'no_tool' |
| `runTool()` fallback triggers on unavailable primary | Recurses to fallback config |
| `runTool()` post-filters to audited file set | Out-of-scope findings excluded |
| `semanticId()` for tool finding | Uses file:line:rule identity |
| `semanticId()` for model finding | Uses content hash (existing behavior) |
| Tool + model finding with same issue | Have DIFFERENT semantic IDs (tracked separately) |

### Integration Tests — Hermetic

| Test | What it validates |
|---|---|
| Full Phase 0 flow with mocked tool outputs | Pre-pass → normalized findings → lint context |
| Verdict math excludes tool findings by default | Tool HIGH doesn't push verdict to SIGNIFICANT_ISSUES |
| Verdict math includes tool findings with `--strict-lint` | Tool HIGH counts |
| Tool findings persist to ledger | `batchWriteLedger()` accepts them (classification validated) |
| `_toolCapability` attached to result | tools_available, tools_failed, strict_lint recorded |

### Smoke Tests — Gated behind `AUDIT_LOOP_SMOKE=1`

| Test | What it validates |
|---|---|
| Real `ruff` on Python fixture | End-to-end |
| Real `eslint` on JS fixture | End-to-end |
| Full audit with Phase 0 | Lint findings in output, GPT prompted with summary |

---

## 5. Rollback Strategy

Phase C changes are additive and gated:

- **`tools[]` on profiles** — empty-by-default if omitted from Phase A profiles; no effect until populated
- **Phase 0 pre-pass** — runs only if `executeTools()` returns non-empty results; graceful skip on missing tools
- **Tool findings are advisory by default** — verdict math unchanged without `--strict-lint`
- **Tool findings in output** — appended to `allFindings` array; existing consumers see more findings but all have valid `FindingSchema` shape
- **`semanticId()` dispatch** — old findings without `classification.sourceKind` fall through to content-hash branch (existing behavior)

Revert path:
1. Remove Phase 0 block from `openai-audit.mjs`
2. Remove `tools[]` from profiles
3. `semanticId()` dispatch becomes dead code (harmless)

---

## 6. Implementation Order

1. **`rule-metadata.mjs`** — registry + `getRuleMetadata()` + tests
2. **Parsers** (`lib/linter.mjs`) — all 4 parsers + fixture-based tests
3. **`runTool()` + `executeTools()`** — execution with mocked spawn tests
4. **Normalization** — `normalizeExternalFinding()`, `normalizeToolResults()` + tests
5. **`formatLintSummary()`** + budget tests
6. **`semanticId()` dispatch** — tool vs model identity + tests
7. **Language profile `tools[]`** — add to js/ts/py profiles
8. **`openai-audit.mjs` Phase 0 integration** — pre-pass block, lint context injection, verdict math
9. **`--strict-lint` CLI flag** + verdict math tests
10. **SKILL.md updates**
11. Run `npm test` — verify no regressions
12. Smoke test with real tools (gated)

---

## 7. Out of Scope (Future)

- **Per-tool caching** — recompute per run is fine at current scale
- **Monorepo per-root execution** — single `cwd` + post-filter is sufficient
- **Auto-fix application** — detection only
- **Custom tool plugins** — use repo's existing tool config
- **Pinned tool versions / Docker** — advisory is sufficient mitigation for version drift
- **Richer finding identity** (cross-source dedup tool↔model) — two-scheme approach is good enough
