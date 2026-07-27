/**
 * @fileoverview Conservative auto-fix for CLAUDE.md hygiene findings.
 * Only fixes standalone markdown link nodes (stale/file-ref).
 */
import fs from 'node:fs';
import { atomicWriteFileSync } from '../file-io.mjs';
import { resolveAndClassify } from '../sensitive-paths.mjs';

/**
 * Strict line-number normalization for untrusted `finding.line` input
 * (round-3 code-audit finding 69995e0f — a bare `Number(value)` coercion
 * accepts non-integer inputs that should never resolve to a line: `true` ->
 * 1, a single-element array `[2]` -> 2, and a `Symbol()` throws instead of
 * failing closed, which can abort a run mid-way after earlier canonical
 * groups have already been written). A genuine number must be a positive
 * safe integer; a string is accepted only when it matches a canonical
 * decimal-integer grammar (no sign, no leading zero, digits only) and its
 * parsed value is a positive safe integer. Every other type or shape
 * returns null — callers must never let an un-normalized `finding.line`
 * reach a sort comparator, bounds check, dedup comparison, or index
 * calculation.
 * @param {unknown} value
 * @returns {number|null}
 */
function normalizeLineNumber(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 1 ? value : null;
  }
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/**
 * Apply auto-fixes to findings. Only stale/file-ref with standalone links are fixable.
 *
 * Every finding's `file` is untrusted input: each is resolved and classified
 * via `resolveAndClassify` (against a once-canonicalized `repoRoot`) before
 * any read or write. A finding whose path fails to resolve, escapes
 * `repoRoot`, or lexically/canonically matches a sensitive pattern is
 * refused — reported in `skipped`, never read or written. Accepted findings
 * are grouped by their resolved canonical path, not the raw `file` string,
 * so two aliases of one physical file (an in-repo symlink, or two distinct
 * relative spellings) are deduplicated together rather than independently
 * read-splice-writing the same content.
 * @param {Array} findings - Findings from runRules()
 * @param {string} repoRoot
 * @param {object} [options]
 * @param {boolean} [options.dryRun=true] - If true, report but don't modify
 * @returns {{ applied: Array<{ file: string, line: number, action: string }>, skipped: Array<{ file: string, line: number, reason: string }> }}
 */
export function applyFixes(findings, repoRoot, options = {}) {
  const dryRun = options.dryRun !== false;
  const applied = [];
  const skipped = [];

  // A null/non-object array entry has no `file` to report against by its own
  // shape, but silently dropping it recreates the exact observability gap
  // this plan closes elsewhere (round-2 code-audit finding 5a482bc2) — a
  // regression in a findings producer could silently shrink auto-fix
  // coverage with no visible signal. Reported with its array index as the
  // one stable identifier available for a malformed entry. A well-formed
  // finding that simply isn't fixable (wrong ruleId, fixable:false) is
  // correctly left untouched, same as before — only a genuinely malformed
  // array element gets this treatment.
  const fixable = [];
  findings.forEach((f, idx) => {
    if (!f || typeof f !== 'object') {
      skipped.push({ file: null, line: null, reason: `malformed finding at index ${idx}` });
      return;
    }
    if (f.fixable && f.ruleId === 'stale/file-ref') fixable.push(f);
  });

  // resolveAndClassify realpaths the FILE but never opts.repoRoot itself —
  // canonicalize it here, once, so a repoRoot passed as a symlinked path
  // (e.g. process.cwd() under macOS's /tmp -> /private/tmp) doesn't compare
  // a realpath'd file target against a non-canonical repoRoot and produce a
  // false escapedRepo for every finding. Fail-closed if this itself throws.
  let canonicalRepoRoot;
  try {
    canonicalRepoRoot = fs.realpathSync(repoRoot);
  } catch {
    for (const f of fixable) {
      skipped.push({ file: f.file, line: f.line, reason: 'repoRoot could not be resolved' });
    }
    return { applied, skipped };
  }

  // Per finding (not yet grouped): gate before grouping, so aliased paths
  // resolving to the same physical file land in the SAME canonical group.
  const byCanonical = new Map();
  for (const f of fixable) {
    // `finding.file` is untrusted input (same class defect #2 already treats
    // it as) — a non-string value would make resolveAndClassify throw
    // internally (path.isAbsolute requires a string) before it ever reaches
    // its own fail-closed result. Reported explicitly, never silently
    // dropped and never left to crash the whole run.
    if (typeof f.file !== 'string') {
      skipped.push({ file: f.file, line: f.line, reason: 'invalid file path' });
      continue;
    }
    const gate = resolveAndClassify(f.file, { repoRoot: canonicalRepoRoot });
    if (gate.resolutionFailed || gate.escapedRepo || gate.category === 'sensitive') {
      const reason = gate.resolutionFailed
        ? 'path resolution failed'
        : gate.escapedRepo
          ? 'path escapes repo root'
          : 'path classified sensitive';
      skipped.push({ file: f.file, line: f.line, reason });
      continue;
    }
    if (!byCanonical.has(gate.canonical)) byCanonical.set(gate.canonical, []);
    byCanonical.get(gate.canonical).push(f);
  }

  for (const [canonical, groupFindings] of byCanonical) {
    // Sort by line descending — splice from bottom up to avoid stale indices.
    // Uses normalizeLineNumber (never throws, treats anything invalid as 0)
    // rather than raw finding.line — a Symbol-valued line would otherwise
    // throw INSIDE the comparator (Symbol - 0 is a TypeError), aborting the
    // whole run after earlier canonical groups may have already been written.
    groupFindings.sort((a, b) => (normalizeLineNumber(b.line) ?? 0) - (normalizeLineNumber(a.line) ?? 0));

    let content;
    try {
      content = fs.readFileSync(canonical, 'utf-8');
    } catch (err) {
      for (const f of groupFindings) {
        skipped.push({ file: f.file, line: f.line, reason: `read failed: ${err.code || err.message}` });
      }
      continue;
    }

    const lines = content.split('\n');
    // Captured once, before any splice — a live lines.length shrinks on
    // every real-run splice, which would make the bounds check below
    // dry-run-mode-dependent (a later, valid line number could exceed an
    // already-shrunk length in real-run but not in dry-run).
    const originalLength = lines.length;
    let modified = false;
    let lastProcessedLine = null;

    for (const finding of groupFindings) {
      // Normalize once — finding.line is untrusted input (same class as
      // `file`); a string '2' would sort correctly via the comparator above
      // but fail a strict-equality dedup check against a numeric
      // lastProcessedLine, letting a same-line duplicate slip past the
      // dedup gate and re-splice. Strict (not a bare Number() coercion,
      // which wrongly accepts `true`/single-element arrays as valid lines —
      // see normalizeLineNumber's own docstring). Every subsequent use
      // (bounds check, dedup comparison, index math) reads this one value.
      const lineNum = normalizeLineNumber(finding.line);

      // Bounds check FIRST, against the captured original length — a
      // malformed finding.line must never reach the dedup check below,
      // or a null/undefined line could spuriously equal the dedup
      // sentinel's initial null value.
      if (lineNum === null || lineNum > originalLength) {
        skipped.push({ file: finding.file, line: finding.line, reason: 'invalid line number' });
        continue;
      }

      if (lineNum === lastProcessedLine) {
        skipped.push({ file: finding.file, line: finding.line, reason: 'duplicate finding for already-processed line' });
        continue;
      }
      lastProcessedLine = lineNum;

      const lineIdx = lineNum - 1;
      const line = lines[lineIdx];

      // Only fix standalone markdown links (entire line is a link or list-item link)
      const standaloneLink = /^\s*(?:[-*]\s+)?\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line);
      if (!standaloneLink) {
        skipped.push({ file: finding.file, line: finding.line, reason: 'reference embedded in prose' });
        continue;
      }

      if (dryRun) {
        applied.push({ file: finding.file, line: finding.line, action: `would remove: ${line.trim()}` });
      } else {
        lines.splice(lineIdx, 1);
        modified = true;
        applied.push({ file: finding.file, line: finding.line, action: `removed: ${line.trim()}` });
      }
    }

    if (modified && !dryRun) {
      atomicWriteFileSync(canonical, lines.join('\n'));
    }
  }

  return { applied, skipped };
}
