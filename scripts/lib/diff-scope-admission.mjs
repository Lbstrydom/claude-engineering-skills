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

function extensionLabel(file) {
  const ext = path.extname(file).replace(/^\./, '').toLowerCase();
  return ext || '(no extension)';
}

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
 *   untrackedUnreferenced: string[]}}
 */
export function partitionDiffScope({ files, untracked = [], planText = null }) {
  const auditable = [];
  const ignored = [];
  const ignoredByExtension = {};
  for (const f of files || []) {
    if (typeof f !== 'string' || f === '') continue;
    if (resolveReferenceExtension(f) === null) {
      ignored.push(f);
      const label = extensionLabel(f);
      ignoredByExtension[label] = (ignoredByExtension[label] || 0) + 1;
      continue;
    }
    auditable.push(f);
  }
  const untrackedSet = new Set(untracked);
  const untrackedUnreferenced = auditable.filter((f) => untrackedSet.has(f) && !planReferences(planText, f));
  return { auditable, ignored, ignoredByExtension, untrackedUnreferenced };
}

/**
 * Operator lines for a partition. PURE. Empty when there is nothing to say.
 *
 * @param {ReturnType<typeof partitionDiffScope>} p
 * @returns {string[]}
 */
export function formatDiffScopeNotices(p) {
  const lines = [];
  if (p.ignored.length > 0) {
    const groups = Object.entries(p.ignoredByExtension)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([ext, n]) => `${ext}: ${n}`)
      .join(', ');
    lines.push(`  [scope] ${p.ignored.length} non-code file(s) ignored (${groups})`);
  }
  if (p.untrackedUnreferenced.length > 0) {
    const shown = p.untrackedUnreferenced.slice(0, 5).join(', ');
    const more = p.untrackedUnreferenced.length > 5 ? ` (+${p.untrackedUnreferenced.length - 5} more)` : '';
    lines.push(`  [scope] WARNING: ${p.untrackedUnreferenced.length} untracked file(s) not referenced by the plan `
      + `entered --scope diff: ${shown}${more} — pass --files to pin scope`);
  }
  return lines;
}
