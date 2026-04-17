/**
 * @fileoverview File I/O utilities extracted from shared.mjs.
 * Handles file reading, writing, path normalization, sensitive file filtering,
 * diff parsing, and context assembly for audit scripts.
 * @module scripts/lib/file-io
 */

import fs from 'fs';
import path from 'path';
import { ALL_EXTENSIONS_PATTERN } from './language-profiles.mjs';

// ── Atomic File Writes ──────────────────────────────────────────────────────
// Write to a temp file in the same directory, then rename for crash-safety.

export function atomicWriteFileSync(filePath, data) {
  const absPath = path.resolve(filePath);
  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmpPath, data, 'utf-8');
    fs.renameSync(tmpPath, absPath);
  } catch (err) {
    // Clean up temp file on failure — log but don't mask the original error
    try { fs.unlinkSync(tmpPath); } catch (cleanupErr) {
      process.stderr.write(`  [atomic-write] Temp file cleanup failed: ${cleanupErr.message}\n`);
    }
    throw err;
  }
}

// ── Path Normalization ──────────────────────────────────────────────────────

/**
 * Canonicalize file paths to cwd-relative, forward-slash, lowercase form.
 * @param {string} p - File path (absolute or relative)
 * @returns {string} Normalized path
 */
export function normalizePath(p) {
  const resolved = path.resolve(p);
  const cwdPrefix = path.resolve('.');
  return resolved.replace(cwdPrefix, '').replace(/\\/g, '/').replace(/^\//, '').toLowerCase();
}

// ── Safe Parsing ────────────────────────────────────────────────────────────

/** Safe parseInt with fallback for NaN. */
export function safeInt(val, fallback) {
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? fallback : n;
}

// ── File Helpers ────────────────────────────────────────────────────────────

export function readFileOrDie(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`Error: File not found: ${resolved}`);
    process.exit(1);
  }
  return fs.readFileSync(resolved, 'utf-8');
}

// ── Sensitive File Filtering ────────────────────────────────────────────────

const SENSITIVE_PATTERNS = [
  /\.env$/i, /\.env\./i, /secret/i, /credential/i, /\.pem$/i, /\.key$/i,
  /password/i, /token/i, /\.pfx$/i, /\.p12$/i, /id_rsa/i, /id_ed25519/i
];

export function isSensitiveFile(relPath) {
  const basename = path.basename(relPath);
  return SENSITIVE_PATTERNS.some(p => p.test(basename));
}

// ── Audit Infrastructure Exclusion ────────────────────────────────────────
// These are the audit-loop's own scripts, synced to consumer repos via
// sync-to-repos.mjs. They must NEVER appear in the audit scope — including
// them causes Gemini/Claude Opus to flag issues in the tool itself rather
// than in the project being audited.

const AUDIT_INFRA_BASENAMES = new Set([
  'openai-audit.mjs', 'gemini-review.mjs', 'bandit.mjs', 'learning-store.mjs',
  'phase7-check.mjs', 'shared.mjs', 'check-sync.mjs', 'check-setup.mjs',
  'refine-prompts.mjs', 'evolve-prompts.mjs', 'meta-assess.mjs',
  'debt-auto-capture.mjs', 'debt-backfill.mjs', 'debt-budget-check.mjs',
  'debt-pr-comment.mjs', 'debt-resolve.mjs', 'debt-review.mjs',
  'write-plan-outcomes.mjs', 'write-ledger-r1.mjs', 'sync-to-repos.mjs',
  'audit-loop.mjs',
  // lib/ modules
  'file-io.mjs', 'schemas.mjs', 'ledger.mjs', 'code-analysis.mjs', 'context.mjs',
  'findings.mjs', 'config.mjs', 'llm-auditor.mjs', 'llm-wrappers.mjs',
  'language-profiles.mjs', 'rng.mjs', 'robustness.mjs', 'sanitizer.mjs',
  'secret-patterns.mjs', 'suppression-policy.mjs', 'backfill-parser.mjs',
  'owner-resolver.mjs', 'rule-metadata.mjs', 'file-store.mjs',
  'prompt-registry.mjs', 'prompt-seeds.mjs', 'linter.mjs',
  'plan-fp-tracker.mjs', 'predictive-strategy.mjs',
  'debt-capture.mjs', 'debt-events.mjs', 'debt-git-history.mjs',
  'debt-ledger.mjs', 'debt-memory.mjs', 'debt-review-helpers.mjs',
]);

/**
 * Returns true if the path points to an audit-loop infrastructure file.
 * These files are synced to consumer repos but should never be in audit scope.
 * @param {string} relPath - Relative file path
 * @returns {boolean}
 */
export function isAuditInfraFile(relPath) {
  const norm = relPath.replaceAll('\\', '/');
  const basename = path.basename(norm);
  // Must be directly under top-level scripts/ or scripts/lib/ — NOT nested
  // under other directories (e.g. src/scripts/ is a legitimate consumer path).
  if (!norm.startsWith('scripts/')) return false;
  return AUDIT_INFRA_BASENAMES.has(basename);
}

// ── Diff Parsing ────────────────────────────────────────────────────────────

/**
 * Parse unified diff into line ranges per file.
 * @param {string} diffPath - Path to unified diff file
 * @returns {Map<string, {hunks: Array<{startLine: number, lineCount: number}>}>}
 */
export function parseDiffFile(diffPath) {
  const absPath = path.resolve(diffPath);
  if (!fs.existsSync(absPath)) {
    process.stderr.write(`  [diff] File not found: ${absPath}\n`);
    return new Map();
  }

  let content;
  try {
    content = fs.readFileSync(absPath, 'utf-8');
  } catch (err) {
    process.stderr.write(`  [diff] Failed to read: ${err.message}\n`);
    return new Map();
  }

  const diffMap = new Map();
  let currentFile = null;

  for (const line of content.split('\n')) {
    // File header: +++ b/path/to/file.js
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      currentFile = normalizePath(fileMatch[1]);
      if (!diffMap.has(currentFile)) diffMap.set(currentFile, { hunks: [] });
      continue;
    }

    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch && currentFile) {
      diffMap.get(currentFile).hunks.push({
        startLine: parseInt(hunkMatch[1], 10),
        lineCount: parseInt(hunkMatch[2] || '1', 10)
      });
    }
  }

  process.stderr.write(`  [diff] Parsed ${diffMap.size} files, ${[...diffMap.values()].reduce((s, d) => s + d.hunks.length, 0)} hunks\n`);
  return diffMap;
}

// ── File Reading ────────────────────────────────────────────────────────────

/**
 * Read file contents, truncated per file, capped total.
 * @param {string[]} filePaths
 * @param {object} opts
 * @param {number} [opts.maxPerFile=10000]
 * @param {number} [opts.maxTotal=120000]
 * @returns {string}
 */
export function readFilesAsContext(filePaths, { maxPerFile = 10000, maxTotal = 120000 } = {}) {
  let total = '';
  let omitted = 0;
  let sensitive = 0;

  const cwdBoundary = path.resolve('.');

  for (const relPath of filePaths) {
    if (isSensitiveFile(relPath)) { sensitive++; continue; }

    const absPath = path.resolve(relPath);
    if (!absPath.startsWith(cwdBoundary)) { omitted++; continue; }
    if (!fs.existsSync(absPath)) continue;

    const raw = fs.readFileSync(absPath, 'utf-8');
    const ext = relPath.split('.').pop();
    const lang = { sql: 'sql', css: 'css', html: 'html', md: 'markdown', json: 'json', py: 'python', rs: 'rust', go: 'go', java: 'java', rb: 'ruby', sh: 'bash' }[ext] ?? 'js';
    const content = raw.length > maxPerFile
      ? raw.slice(0, maxPerFile) + `\n... [TRUNCATED — ${raw.length} chars total]`
      : raw;
    const block = `### ${relPath}\n\`\`\`${lang}\n${content}\n\`\`\`\n`;

    if (total.length + block.length > maxTotal) { omitted++; continue; }
    total += block;
  }

  if (omitted > 0) total += `\n... [${omitted} file(s) omitted — context budget reached]\n`;
  if (sensitive > 0) total += `\n... [${sensitive} sensitive file(s) excluded (.env, secrets, keys)]\n`;
  return total;
}

// ── Diff Annotation Helpers ─────────────────────────────────────────────────

/**
 * File extensions that support inline block-comment markers (/* ... * /).
 * JS/TS/CSS/Python/Go/Rust/Java/Ruby/Shell/C-family files get inline UNCHANGED markers.
 */
const CODE_EXTS = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'rb', 'sh', 'css', 'scss', 'c', 'cpp', 'h']);

/**
 * File extensions that cannot embed comment syntax — use header-only annotation.
 * Line numbers are injected into the left margin instead.
 */
const HEADER_ONLY_EXTS = new Set(['json', 'yaml', 'yml', 'md', 'markdown', 'html', 'htm', 'xml', 'txt', 'toml', 'ini']);

/**
 * Route a file to its annotation style based on extension.
 * @param {string} relPath
 * @returns {'block' | 'header-only'}
 */
function getCommentStyle(relPath) {
  const ext = relPath.split('.').pop()?.toLowerCase() ?? '';
  if (CODE_EXTS.has(ext)) return 'block';
  if (HEADER_ONLY_EXTS.has(ext)) return 'header-only';
  return 'block'; // default to block for unknown extensions
}

/**
 * Annotate a code file (JS/TS/Python/etc.) with inline block-comment markers.
 * Unchanged regions get UNCHANGED CONTEXT markers; changed hunks get CHANGED markers.
 * @param {string} raw - Raw file content
 * @param {Array<{startLine: number, lineCount: number}>} sortedHunks - Hunks sorted ascending
 * @returns {{ content: string, headerAnnotation: string }}
 */
function _annotateBlockStyle(raw, sortedHunks) {
  const lines = raw.split('\n');
  const annotated = [];
  let cursor = 0; // 0-indexed line position

  for (const hunk of sortedHunks) {
    const hunkStart = Math.max(hunk.startLine - 1, 0); // convert to 0-indexed
    const hunkEnd = Math.min(hunkStart + hunk.lineCount, lines.length);

    // Unchanged region before this hunk
    if (cursor < hunkStart) {
      annotated.push(
        '/* ━━━━ UNCHANGED CONTEXT — DO NOT FLAG ━━━━ */',
        ...lines.slice(cursor, hunkStart),
        '/* ━━━━ END UNCHANGED CONTEXT ━━━━ */'
      );
    }

    // Changed region
    annotated.push(
      '// ── CHANGED ──',
      ...lines.slice(hunkStart, hunkEnd),
      '// ── END CHANGED ──'
    );
    cursor = hunkEnd;
  }

  // Trailing unchanged region after last hunk
  if (cursor < lines.length) {
    annotated.push(
      '/* ━━━━ UNCHANGED CONTEXT — DO NOT FLAG ━━━━ */',
      ...lines.slice(cursor),
      '/* ━━━━ END UNCHANGED CONTEXT ━━━━ */'
    );
  }

  return { content: annotated.join('\n'), headerAnnotation: ' [CHANGED]' };
}

/**
 * Annotate a non-code file (JSON/YAML/Markdown/HTML) with line-number margins
 * and a header annotation listing the changed line ranges.
 * @param {string} raw - Raw file content
 * @param {Array<{startLine: number, lineCount: number}>} sortedHunks - Hunks sorted ascending
 * @returns {{ content: string, headerAnnotation: string }}
 */
function _annotateHeaderOnlyStyle(raw, sortedHunks) {
  const numberedLines = raw.split('\n').map((line, i) => `${String(i + 1).padStart(4, ' ')} | ${line}`);
  const totalLines = numberedLines.length;
  const changedRanges = sortedHunks
    .map(h => `${h.startLine}-${Math.min(h.startLine + h.lineCount - 1, totalLines)}`)
    .join(', ');
  return {
    content: numberedLines.join('\n'),
    headerAnnotation: ` [CHANGED — LINES ${changedRanges} — REVIEW ONLY THESE LINES]`,
  };
}

/**
 * Wraps readFilesAsContext with diff-based change markers.
 *
 * For code files (JS/TS/Python/etc.): wraps unchanged regions with
 *   /* ━━━━ UNCHANGED CONTEXT — DO NOT FLAG ━━━━ * / markers, and changed
 *   hunks with // ── CHANGED ── / // ── END CHANGED ── markers.
 *
 * For non-code files (JSON/YAML/Markdown/HTML): injects 4-char line numbers
 *   into the left margin and annotates the block header with changed line ranges.
 *
 * Files without diff entries are passed through unchanged.
 *
 * @param {string[]} filePaths - Files to read
 * @param {Map} diffMap - Output of parseDiffFile()
 * @param {object} opts
 * @param {number} [opts.maxPerFile=10000]
 * @param {number} [opts.maxTotal=120000]
 * @returns {string} Annotated file context
 */
export function readFilesAsAnnotatedContext(filePaths, diffMap, { maxPerFile = 10000, maxTotal = 120000 } = {}) {
  let total = '';
  let omitted = 0;
  const cwdBoundary = path.resolve('.');

  for (const relPath of filePaths) {
    const block = _buildFileBlock(relPath, diffMap, cwdBoundary, maxPerFile);
    if (block === null) continue; // sensitive or out-of-bounds
    if (total.length + block.length > maxTotal) { omitted++; continue; }
    total += block;
  }

  if (omitted > 0) total += `\n... [${omitted} file(s) omitted — context budget reached]\n`;
  return total;
}

/**
 * Build the fenced code block string for a single file, applying diff annotations.
 * Returns null when the file should be skipped (sensitive, out-of-bounds, missing).
 * @param {string} relPath
 * @param {Map|undefined} diffMap
 * @param {string} cwdBoundary
 * @param {number} maxPerFile
 * @returns {string|null}
 */
function _buildFileBlock(relPath, diffMap, cwdBoundary, maxPerFile) {
  if (isSensitiveFile(relPath)) return null;
  const absPath = path.resolve(relPath);
  if (!absPath.startsWith(cwdBoundary) || !fs.existsSync(absPath)) return null;

  let raw = fs.readFileSync(absPath, 'utf-8');
  const ext = relPath.split('.').pop();
  const lang = { sql: 'sql', css: 'css', html: 'html', md: 'markdown', json: 'json', py: 'python', rs: 'rust', go: 'go', java: 'java', rb: 'ruby', sh: 'bash' }[ext] ?? 'js';

  const diffInfo = diffMap?.get(normalizePath(relPath));
  let headerAnnotation = '';

  if (diffInfo && diffInfo.hunks.length > 0) {
    const sortedHunks = [...diffInfo.hunks].sort((a, b) => a.startLine - b.startLine);
    const { content, headerAnnotation: ha } = getCommentStyle(relPath) === 'block'
      ? _annotateBlockStyle(raw, sortedHunks)
      : _annotateHeaderOnlyStyle(raw, sortedHunks);
    raw = content;
    headerAnnotation = ha;
  }

  const content = raw.length > maxPerFile
    ? raw.slice(0, maxPerFile) + `\n... [TRUNCATED — ${raw.length} chars total]`
    : raw;

  return `### ${relPath}${headerAnnotation}\n\`\`\`${lang}\n${content}\n\`\`\`\n`;
}

// ── File Path Extraction ────────────────────────────────────────────────────

/**
 * Extract source file paths from a plan. Purely regex-driven.
 * @param {string} planContent
 * @returns {{found: string[], missing: string[], allPaths: Set<string>}}
 */
export function extractPlanPaths(planContent) {
  const paths = new Set();
  let match;

  const EXT = 'js|mjs|ts|tsx|jsx|sql|css|html|json|md|py|rs|go|java|rb|sh';

  // Phase 1: Exact path regex extraction (backtick paths, inline paths, heading filenames)
  const genericPathRegex = new RegExp(`(?:^|\\s|\\\`|\\()((?:\\.?[\\w.-]+\\/)+[\\w.-]+\\.(?:${EXT}))`, 'gm');
  while ((match = genericPathRegex.exec(planContent)) !== null) {
    const p = match[1].replace(/^\.\//, '');
    if (!p.startsWith('http') && !p.startsWith('node_modules') && !isAuditInfraFile(p)) paths.add(p);
  }

  const btRegex = new RegExp(`\\\`((?:\\.?[\\w.-]+\\/)+[\\w.-]+\\.(?:${EXT}))\\\``, 'gm');
  while ((match = btRegex.exec(planContent)) !== null) {
    const p = match[1].replace(/^\.\//, '');
    if (!p.startsWith('http') && !p.startsWith('node_modules') && !isAuditInfraFile(p)) paths.add(p);
  }

  // Allow slash-containing paths AND bare filenames: #### `src/app/main.py` or #### `file.py`
  // Extension list comes from the language-profiles registry (single source of truth).
  const fnRegex = new RegExp(`####\\s+\`([\\w./-]+\\.(?:${ALL_EXTENSIONS_PATTERN}))\``, 'gm');
  while ((match = fnRegex.exec(planContent)) !== null) {
    const captured = match[1];
    // If captured path contains a slash, treat it as repo-relative and add directly
    if (captured.includes('/')) {
      const normalized = captured.replace(/^\.\//, '');
      if (!normalized.startsWith('http') && !normalized.startsWith('node_modules') && !isAuditInfraFile(normalized)) paths.add(normalized);
      continue;
    }
    // Bare filename — use search-dir fuzzy discovery (existing behavior)
    const filename = captured;
    if ([...paths].some(p => p.endsWith('/' + filename) || p === filename)) continue;
    const searchDirs = [
      'src/config', 'src/routes', 'src/services', 'src/schemas',
      'scripts', 'lib', 'utils', '.claude/skills', '.github/skills'
    ];
    for (const dir of searchDirs) {
      const candidate = `${dir}/${filename}`;
      if (fs.existsSync(path.resolve(candidate)) && !isAuditInfraFile(candidate)) { paths.add(candidate); break; }
    }
  }

  // Phase 2: Fuzzy keyword discovery — only when Phase 1 found very few files.
  // Catches cases where plan says "UserService" but file is "user-service.ts".
  const regexFoundCount = [...paths].filter(p => fs.existsSync(path.resolve(p))).length;
  if (regexFoundCount < 5) {
    const keywords = _extractPlanKeywords(planContent);
    if (keywords.length > 0) {
      const repoFiles = _scanRepoFiles();
      const beforeCount = paths.size;
      for (const file of repoFiles) {
        const basename = path.basename(file).toLowerCase().replace(/\.[^.]+$/, '').replaceAll(/[._-]/g, '');
        if (basename.length < 3) continue;
        for (const kw of keywords) {
          // Require strong match: keyword ≥6 chars and covers ≥50% of the basename
          if (kw.length >= 6 && basename.includes(kw) && kw.length >= basename.length * 0.5) {
            paths.add(file);
            break;
          }
        }
      }
      const added = paths.size - beforeCount;
      if (added > 0) {
        process.stderr.write(`  [plan-paths] Fuzzy discovery: +${added} files from ${keywords.length} plan keywords\n`);
      }
    }
  }

  const resolved = new Map();
  for (const p of paths) {
    const abs = path.resolve(p);
    if (!resolved.has(abs)) resolved.set(abs, p);
  }

  const found = [];
  const missing = [];
  for (const p of [...resolved.values()].sort((a, b) => a.localeCompare(b))) {
    (fs.existsSync(path.resolve(p)) ? found : missing).push(p);
  }
  return { found, missing, allPaths: new Set(resolved.values()) };
}

/**
 * Extract keywords from plan text that likely refer to implementation files.
 * Catches: PascalCase names (UserService), backtick identifiers, heading references.
 * @param {string} planContent
 * @returns {string[]} Lowercase keywords
 */
function _extractPlanKeywords(planContent) {
  const keywords = new Set();

  // PascalCase identifiers (e.g. UserService, AuthMiddleware, WineCellar)
  const pascalRegex = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;
  let m;
  while ((m = pascalRegex.exec(planContent)) !== null) {
    // Split PascalCase into parts: "UserService" → "userservice"
    keywords.add(m[1].toLowerCase());
    // Also add individual parts: "user", "service"
    const parts = m[1].replace(/([A-Z])/g, ' $1').trim().split(/\s+/);
    for (const part of parts) {
      if (part.length >= 4) keywords.add(part.toLowerCase());
    }
  }

  // Backtick identifiers that look like module/class names (not paths — those are caught in Phase 1)
  const btIdentRegex = /`([A-Za-z][\w]+)`/g;
  while ((m = btIdentRegex.exec(planContent)) !== null) {
    const ident = m[1];
    // Skip if it looks like a path (has slashes or dots before extension)
    if (ident.includes('/') || /\.\w{1,4}$/.test(ident)) continue;
    if (ident.length >= 4) keywords.add(ident.toLowerCase());
  }

  // Heading references: "### Authentication Service" → "authentication", "service"
  const headingRegex = /^#{2,4}\s+(.+)$/gm;
  while ((m = headingRegex.exec(planContent)) !== null) {
    const words = m[1].replace(/[^a-zA-Z\s]/g, '').split(/\s+/);
    for (const w of words) {
      if (w.length >= 4) keywords.add(w.toLowerCase());
    }
  }

  // Remove common noise words
  const noise = new Set([
    'this', 'that', 'with', 'from', 'will', 'should', 'must', 'have', 'been',
    'when', 'where', 'what', 'which', 'each', 'every', 'some', 'many', 'more',
    'than', 'then', 'into', 'also', 'only', 'over', 'such', 'both', 'after',
    'before', 'other', 'about', 'between', 'through', 'during', 'without',
    'within', 'along', 'following', 'across', 'behind', 'beyond', 'plus',
    'implementation', 'overview', 'summary', 'approach', 'architecture',
    'design', 'pattern', 'context', 'example', 'notes', 'details',
    'step', 'phase', 'plan', 'task', 'issue', 'error', 'status',
    'true', 'false', 'null', 'undefined', 'string', 'number', 'boolean',
    'function', 'class', 'const', 'export', 'import', 'async', 'await',
    'return', 'default', 'interface', 'type'
  ]);
  return [...keywords].filter(kw => !noise.has(kw) && kw.length >= 3);
}

/**
 * Scan the working directory for source files, respecting common ignore patterns.
 * Returns relative paths. Limits depth to 5 levels and skips node_modules, .git, dist, build.
 * @returns {string[]} Relative file paths
 */
function _scanRepoFiles() {
  const EXT_SET = new Set(['.js', '.mjs', '.ts', '.tsx', '.jsx', '.sql', '.css', '.html', '.json', '.py', '.rs', '.go', '.java', '.rb', '.sh', '.vue', '.svelte']);
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.tox', 'coverage', '.nyc_output', 'vendor', '.venv', 'venv', '.claude', '.github', 'docs']);
  const results = [];

  function walk(dir, depth) {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (EXT_SET.has(ext) && !isSensitiveFile(entry.name)) {
          const rel = path.relative(process.cwd(), full).replace(/\\/g, '/');
          if (!isAuditInfraFile(rel)) results.push(rel);
        }
      }
    }
  }

  walk(process.cwd(), 0);
  return results;
}

// ── File Classification ─────────────────────────────────────────────────────

/**
 * Classify files as backend, frontend, or shared.
 * @param {string[]} filePaths
 * @returns {{backend: string[], frontend: string[], shared: string[]}}
 */
export function classifyFiles(filePaths) {
  const backend = [];
  const frontend = [];
  const shared = [];

  const fePatterns = [/^public\//, /\/css\//, /\/html\//, /\.css$/, /\.html$/, /\/components\//];
  const sharedPatterns = [/\/config\//, /\/schemas\//, /\/types\//, /\/shared\//, /\.json$/];

  for (const p of filePaths) {
    if (fePatterns.some(rx => rx.test(p))) {
      frontend.push(p);
    } else if (sharedPatterns.some(rx => rx.test(p))) {
      shared.push(p);
    } else {
      backend.push(p);
    }
  }

  return { backend, frontend, shared };
}

// ── Output Helpers ──────────────────────────────────────────────────────────

/**
 * Write output to file or stdout.
 * @param {object} data
 * @param {string} outPath
 * @param {string} summaryLine
 */
export function writeOutput(data, outPath, summaryLine) {
  const json = JSON.stringify(data, null, 2);
  if (outPath) {
    const abs = path.resolve(outPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, json, 'utf-8');
    process.stderr.write(`  [out] Results written to ${abs}\n`);
    console.log(summaryLine);
  } else {
    console.log(json);
  }
}
