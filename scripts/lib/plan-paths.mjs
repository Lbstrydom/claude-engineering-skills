/**
 * @fileoverview Plan path extraction — regex + fuzzy keyword discovery of
 * source file paths referenced in plan documents.
 *
 * Split from file-io.mjs (Wave 2, Phase 2) for Single Responsibility.
 * @module scripts/lib/plan-paths
 */

import fs from 'node:fs';
import path from 'node:path';
import { ALL_EXTENSIONS_PATTERN } from './language-profiles.mjs';
import { normalizePath } from './file-io.mjs';
import { isSensitiveFile, isAuditInfraFile } from './audit-scope.mjs';

// ── Plan Path Extraction ──────────────────────────────────────────────────

/**
 * Extract source file paths from a plan. Purely regex-driven.
 *
 * @param {string} planContent
 * @param {object} [opts]
 * @param {boolean} [opts.allowInfraFiles=false] - Skip the `isAuditInfraFile`
 *   exclusion. That exclusion exists to stop the audit tool from treating its
 *   OWN control-plane files (schemas.mjs, ledger.mjs, openai-audit.mjs, …) as
 *   a feature's subject files during a NORMAL (consumer-code) audit — correct
 *   for that case. A META-plan whose deliverable genuinely IS a change to the
 *   audit tool's own infrastructure needs the opposite: those files must be
 *   readable as the subject. Opt in explicitly (CLI: `--allow-infra-scope`);
 *   default stays false so ordinary audits are unaffected.
 * @returns {{found: string[], missing: string[], allPaths: Set<string>}}
 */
export function extractPlanPaths(planContent, { allowInfraFiles = false } = {}) {
  const paths = new Set();
  let match;
  const infraExcluded = (p) => !allowInfraFiles && isAuditInfraFile(p);

  const EXT = 'js|mjs|ts|tsx|jsx|sql|css|html|json|md|py|rs|go|java|rb|sh';

  // Phase 1: Exact path regex extraction (backtick paths, inline paths, heading filenames)
  const genericPathRegex = new RegExp(`(?:^|\\s|\\\`|\\()((?:\\.?[\\w.-]+\\/)+[\\w.-]+\\.(?:${EXT}))`, 'gm');
  while ((match = genericPathRegex.exec(planContent)) !== null) {
    const p = match[1].replace(/^\.\//, '');
    if (!p.startsWith('http') && !p.startsWith('node_modules') && !infraExcluded(p)) paths.add(p);
  }

  const btRegex = new RegExp(`\\\`((?:\\.?[\\w.-]+\\/)+[\\w.-]+\\.(?:${EXT}))\\\``, 'gm');
  while ((match = btRegex.exec(planContent)) !== null) {
    const p = match[1].replace(/^\.\//, '');
    if (!p.startsWith('http') && !p.startsWith('node_modules') && !infraExcluded(p)) paths.add(p);
  }

  const fnRegex = new RegExp(`####\\s+\`([\\w./-]+\\.(?:${ALL_EXTENSIONS_PATTERN}))\``, 'gm');
  while ((match = fnRegex.exec(planContent)) !== null) {
    const captured = match[1];
    if (captured.includes('/')) {
      const normalized = captured.replace(/^\.\//, '');
      if (!normalized.startsWith('http') && !normalized.startsWith('node_modules') && !infraExcluded(normalized)) paths.add(normalized);
      continue;
    }
    const filename = captured;
    if ([...paths].some(p => p.endsWith('/' + filename) || p === filename)) continue;
    const searchDirs = [
      'src/config', 'src/routes', 'src/services', 'src/schemas',
      'scripts', 'lib', 'utils', '.claude/skills', '.github/skills'
    ];
    for (const dir of searchDirs) {
      const candidate = `${dir}/${filename}`;
      if (fs.existsSync(path.resolve(candidate)) && !infraExcluded(candidate)) { paths.add(candidate); break; }
    }
  }

  // Phase 2: Fuzzy keyword discovery — only when Phase 1 found very few files.
  const regexFoundCount = [...paths].filter(p => fs.existsSync(path.resolve(p))).length;
  if (regexFoundCount < 5) {
    const keywords = _extractPlanKeywords(planContent);
    if (keywords.length > 0) {
      const repoFiles = _scanRepoFiles({ allowInfraFiles });
      const beforeCount = paths.size;
      for (const file of repoFiles) {
        const basename = path.basename(file).toLowerCase().replace(/\.[^.]+$/, '').replaceAll(/[._-]/g, '');
        if (basename.length < 3) continue;
        for (const kw of keywords) {
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

// ── Internal Helpers ──────────────────────────────────────────────────────

function _extractPlanKeywords(planContent) {
  const keywords = new Set();

  const pascalRegex = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;
  let m;
  while ((m = pascalRegex.exec(planContent)) !== null) {
    keywords.add(m[1].toLowerCase());
    const parts = m[1].replaceAll(/([A-Z])/g, ' $1').trim().split(/\s+/);
    for (const part of parts) {
      if (part.length >= 4) keywords.add(part.toLowerCase());
    }
  }

  const btIdentRegex = /`([A-Za-z][\w]+)`/g;
  while ((m = btIdentRegex.exec(planContent)) !== null) {
    const ident = m[1];
    if (ident.includes('/') || /\.\w{1,4}$/.test(ident)) continue;
    if (ident.length >= 4) keywords.add(ident.toLowerCase());
  }

  const headingRegex = /^#{2,4}\s+(.+)$/gm;
  while ((m = headingRegex.exec(planContent)) !== null) {
    const words = m[1].replaceAll(/[^a-zA-Z\s]/g, '').split(/\s+/);
    for (const w of words) {
      if (w.length >= 4) keywords.add(w.toLowerCase());
    }
  }

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

function _scanRepoFiles({ allowInfraFiles = false } = {}) {
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
          const rel = path.relative(process.cwd(), full).replaceAll(/\\/g, '/');
          if (allowInfraFiles || !isAuditInfraFile(rel)) results.push(rel);
        }
      }
    }
  }

  walk(process.cwd(), 0);
  return results;
}
