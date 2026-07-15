/**
 * @fileoverview Diff parsing and change-annotation for audit context.
 *
 * Parses unified diffs into per-file hunk maps, then annotates file content
 * with CHANGED/UNCHANGED markers so LLM auditors focus on new code.
 *
 * Split from file-io.mjs (Wave 2, Phase 2) for Single Responsibility.
 * @module scripts/lib/diff-annotation
 */

import fs from 'node:fs';
import path from 'node:path';
import { normalizePath } from './file-io.mjs';
import { safeReadFile } from './audit-scope.mjs';
import { redactSecrets } from './sensitive-egress-gate.mjs';

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
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      currentFile = normalizePath(fileMatch[1]);
      if (!diffMap.has(currentFile)) diffMap.set(currentFile, { hunks: [] });
      continue;
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch && currentFile) {
      diffMap.get(currentFile).hunks.push({
        startLine: Number.parseInt(hunkMatch[1], 10),
        lineCount: Number.parseInt(hunkMatch[2] || '1', 10)
      });
    }
  }

  process.stderr.write(`  [diff] Parsed ${diffMap.size} files, ${[...diffMap.values()].reduce((s, d) => s + d.hunks.length, 0)} hunks\n`);
  return diffMap;
}

// ── Annotation Styles ─────────────────────────────────────────────────────

const CODE_EXTS = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'rb', 'sh', 'css', 'scss', 'c', 'cpp', 'h']);
const HEADER_ONLY_EXTS = new Set(['json', 'yaml', 'yml', 'md', 'markdown', 'html', 'htm', 'xml', 'txt', 'toml', 'ini']);

/**
 * Route a file to its annotation style based on extension.
 * @param {string} relPath
 * @returns {'block' | 'header-only'}
 */
export function getCommentStyle(relPath) {
  const ext = relPath.split('.').pop()?.toLowerCase() ?? '';
  if (CODE_EXTS.has(ext)) return 'block';
  if (HEADER_ONLY_EXTS.has(ext)) return 'header-only';
  return 'block';
}

function _annotateBlockStyle(raw, sortedHunks) {
  const lines = raw.split('\n');
  const annotated = [];
  let cursor = 0;

  for (const hunk of sortedHunks) {
    const hunkStart = Math.max(hunk.startLine - 1, 0);
    const hunkEnd = Math.min(hunkStart + hunk.lineCount, lines.length);

    if (cursor < hunkStart) {
      annotated.push(
        '/* ━━━━ UNCHANGED CONTEXT — DO NOT FLAG ━━━━ */',
        ...lines.slice(cursor, hunkStart),
        '/* ━━━━ END UNCHANGED CONTEXT ━━━━ */'
      );
    }

    annotated.push(
      '// ── CHANGED ──',
      ...lines.slice(hunkStart, hunkEnd),
      '// ── END CHANGED ──'
    );
    cursor = hunkEnd;
  }

  if (cursor < lines.length) {
    annotated.push(
      '/* ━━━━ UNCHANGED CONTEXT — DO NOT FLAG ━━━━ */',
      ...lines.slice(cursor),
      '/* ━━━━ END UNCHANGED CONTEXT ━━━━ */'
    );
  }

  return { content: annotated.join('\n'), headerAnnotation: ' [CHANGED]' };
}

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

// ── Annotated Context Assembly ────────────────────────────────────────────

/**
 * Read files with diff-based CHANGED/UNCHANGED markers.
 * @param {string[]} filePaths
 * @param {Map} diffMap - Output of parseDiffFile()
 * @param {object} opts
 * @param {number} [opts.maxPerFile=10000]
 * @param {number} [opts.maxTotal=120000]
 * @param {boolean} [opts.redact=true] - Redact secret-shaped content before
 *   annotation/truncation. Defaults to `true` (safe by default), mirroring
 *   `audit-scope.mjs::readFilesAsContext` — see
 *   docs/plans/discovery-portfolio-secret-redaction.md for why this is a
 *   separate implementation needing the identical fix, and why redaction
 *   runs BEFORE annotation (not after — annotation's hunk ranges are
 *   computed against the original file's line numbers; redaction is
 *   line-count-preserving, per `secret-patterns.mjs::redactSecrets`'s own
 *   doc comment, so it cannot desync them).
 * @returns {string}
 */
export function readFilesAsAnnotatedContext(filePaths, diffMap, { maxPerFile = 10000, maxTotal = 120000, redact = true } = {}) {
  let total = '';
  let omitted = 0;
  const cwdBoundary = path.resolve('.');

  for (const relPath of filePaths) {
    const block = _buildFileBlock(relPath, diffMap, cwdBoundary, maxPerFile, redact);
    if (block === null) continue;
    if (total.length + block.length > maxTotal) { omitted++; continue; }
    total += block;
  }

  if (omitted > 0) total += `\n... [${omitted} file(s) omitted — context budget reached]\n`;
  return total;
}

function _buildFileBlock(relPath, diffMap, cwdBoundary, maxPerFile, redact = true) {
  const result = safeReadFile(relPath, cwdBoundary);
  if (!result) return null;
  // Redact BEFORE annotating: redactSecrets preserves the original match's
  // newline count (secret-patterns.mjs), so hunk-range annotation below stays
  // correctly aligned to the file's real line numbers either way — but
  // redacting first also means no annotation marker text can ever land
  // between a secret's context and its value (the failure mode when this was
  // tried the other way around during plan review).
  let raw = redact ? redactSecrets(result.content) : result.content;
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
