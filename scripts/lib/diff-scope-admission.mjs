/**
 * @fileoverview `--scope diff` admission — decide which changed files are
 * auditable BEFORE they are counted, and before they become the R2+ impact set.
 *
 * ## The defect this closes (field report, 2026-09-26)
 *
 * `openai-audit.mjs` built its diff scope from `git diff --name-only` plus every
 * untracked file, and only the LATER admission step (`mergeScopeFiles`) dropped
 * non-source files. By then the damage was done: a dirty tree holding 26 persona
 * screenshots printed "34 changed files → scoping audit to diff", and all 34 —
 * PNGs included — became `changedFiles`, the set R2+ reopen detection keys on.
 * The count described the working tree, not the audit.
 *
 * ## One allowlist
 *
 * "Auditable" is `resolveReferenceExtension(path) !== null` — the SAME predicate
 * `mergeScopeFiles` admits with (lib/plan-paths.mjs). A second extension list
 * here would drift from that one, and the two halves of one decision would
 * disagree about what a code file is.
 *
 * Pure: no git, no filesystem.
 *
 * @module scripts/lib/diff-scope-admission
 */

import path from 'node:path';
import { resolveReferenceExtension } from './plan-paths.mjs';
import { classifyFileCoverage } from './language-profiles.mjs';
import { extensionLabel } from './file-taxonomy.mjs';

/**
 * Is an untracked file named anywhere in the plan text? Matched on the
 * repo-relative path or its basename — a plan cites files as prose, often by
 * bare name. Deliberately loose: this only decides whether to WARN, so a
 * false "referenced" costs one missing warning, never a scope change.
 */
function planReferences(planText, file) {
  if (!planText) return false;
  const norm = file.replace(/\\/g, '/');
  return planText.includes(norm) || planText.includes(path.posix.basename(norm));
}

/**
 * Partition a diff-scope candidate set.
 *
 * @param {object} input
 * @param {string[]} input.files - the candidate set (diff ∪ untracked, after
 *   infra/exclusion filtering), in order
 * @param {string[]} [input.untracked] - which of those are untracked
 * @param {string|null} [input.planText] - the plan content, for the untracked warning
 * @returns {{auditable: string[], ignored: string[], ignoredByExtension: Record<string, number>,
 *   nonCode: string[], uncovered: string[], uncoveredByExtension: Record<string, number>,
 *   untrackedUnreferenced: string[]}}
 *   `ignored` = `nonCode` + `uncovered`. They are split because they mean different things:
 *   `nonCode` is an EXPECTED exclusion (a PNG, a lockfile); `uncovered` is an UNRECOGNISED
 *   file type that was changed and not audited, which must never read as expected.
 */
export function partitionDiffScope({ files, untracked = [], planText = null }) {
  const auditable = [];
  const ignored = [];
  const nonCode = [];
  const uncovered = [];
  const ignoredByExtension = {};
  const uncoveredByExtension = {};
  for (const f of files || []) {
    if (typeof f !== 'string' || f === '') continue;
    if (resolveReferenceExtension(f) === null) {
      ignored.push(f);
      const label = extensionLabel(f);
      ignoredByExtension[label] = (ignoredByExtension[label] || 0) + 1;
      if (classifyFileCoverage(f).class === 'uncovered') {
        uncovered.push(f);
        uncoveredByExtension[label] = (uncoveredByExtension[label] || 0) + 1;
      } else {
        nonCode.push(f);
      }
      continue;
    }
    auditable.push(f);
  }
  const untrackedSet = new Set(untracked);
  const untrackedUnreferenced = auditable.filter((f) => untrackedSet.has(f) && !planReferences(planText, f));
  return { auditable, ignored, ignoredByExtension, nonCode, uncovered, uncoveredByExtension, untrackedUnreferenced };
}

/**
 * Operator lines for a partition. PURE. Empty when there is nothing to say.
 *
 * @param {ReturnType<typeof partitionDiffScope>} p
 * @returns {string[]}
 */
export function formatDiffScopeNotices(p) {
  const lines = [];
  const group = (byExt) => Object.entries(byExt)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([ext, n]) => `${ext}: ${n}`)
    .join(', ');
  const nonCodeByExt = {};
  for (const f of p.nonCode || []) { const l = extensionLabel(f); nonCodeByExt[l] = (nonCodeByExt[l] || 0) + 1; }
  if ((p.nonCode || []).length > 0) {
    lines.push(`  [scope] ${p.nonCode.length} non-code file(s) ignored (${group(nonCodeByExt)})`);
  }
  if ((p.uncovered || []).length > 0) {
    // NOT "non-code": an unrecognised file type is a coverage GAP, and calling it an
    // expected exclusion is what let a consumer's C# go unaudited without a word.
    lines.push(`  [scope] WARNING: ${p.uncovered.length} changed file(s) of unrecognised type were NOT audited (${group(p.uncoveredByExtension)}) — `
      + 'register the type in scripts/lib/file-taxonomy.mjs (--files does not admit it)');
  }
  if (p.untrackedUnreferenced.length > 0) {
    const shown = p.untrackedUnreferenced.slice(0, 5).join(', ');
    const more = p.untrackedUnreferenced.length > 5 ? ` (+${p.untrackedUnreferenced.length - 5} more)` : '';
    lines.push(`  [scope] WARNING: ${p.untrackedUnreferenced.length} untracked file(s) not referenced by the plan `
      + `entered --scope diff: ${shown}${more} — pass --files to pin scope`);
  }
  return lines;
}
