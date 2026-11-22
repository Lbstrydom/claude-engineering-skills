/**
 * @fileoverview The `/audit-code` side of the checklist: turn the audit's own `--files` / `--diff` inputs into a
 * `<checklist>` block, in-process, with the SAME matcher the CLI runs (`match.mjs`), so the audit and an agent's
 * `node scripts/checklist.mjs --diff` can never disagree about what fired.
 *
 * Mirrors `requirements/context.mjs`: an ABSENT `.audit-loop/checklist.json` means the audit is unaffected and the prompt
 * byte-identical (empty block, nothing evaluated, nothing recorded). A present-but-invalid file or an unreadable diff
 * degrades loudly to an empty block plus a `warning`, never throws into the audit.
 *
 * @module scripts/lib/checklist/context
 */
import { loadChecklist } from './schema.mjs';
import { matchChecklist, renderChecklistBlock } from './match.mjs';

/**
 * @param {object} [args]
 * @param {string[]} [args.targetPaths] - the audit's changed/target files (`--files` / `--changed`)
 * @param {string|null} [args.diffFile] - the audit's `--diff` unified-diff file
 * @param {string} [args.baseDir]
 * @param {string} [args.logPath] - fires log (tests); defaults to `.audit/checklist-fires.jsonl`
 * @returns {{block: string, firedCount: number, evaluated: number, absent: boolean, warning: string|null}}
 */
export function getChecklistContext({ targetPaths = [], diffFile = null, baseDir = process.cwd(), logPath } = {}) {
  const none = { block: '', firedCount: 0, evaluated: 0, absent: false, warning: null };
  const loaded = loadChecklist({ repoRoot: baseDir });
  if (!loaded.ok) return { ...none, warning: loaded.error };
  if (loaded.absent || loaded.entries.length === 0) return { ...none, absent: loaded.absent };
  const result = matchChecklist({
    entries: loaded.entries, files: targetPaths, diffPath: diffFile || undefined, purpose: 'operational', cwd: baseDir, logPath,
  });
  if (!result.ok) return { ...none, warning: `${result.code}: ${result.message}` };
  return { block: renderChecklistBlock(result.fired, loaded.entries), firedCount: result.fired.length, evaluated: result.evaluated, absent: false, warning: null };
}

/**
 * The audit's one call: append the `<checklist>` block to the rubric string, logging to stderr. Never throws.
 * Absent checklist, nothing fired, invalid file: the rubric comes back BYTE-IDENTICAL (invalid also warns).
 *
 * @param {string} rubric - the requirements rubric ('' when none)
 * @param {Parameters<typeof getChecklistContext>[0]} args
 * @returns {string}
 */
export function withChecklistBlock(rubric, args) {
  try {
    const cl = getChecklistContext(args);
    if (cl.warning) process.stderr.write(`  [checklist] skipped (non-blocking) — ${cl.warning}\n`);
    if (!cl.block) return rubric;
    process.stderr.write(`  [checklist] ${cl.firedCount} of ${cl.evaluated} entries fired\n`);
    return [rubric, cl.block].filter(Boolean).join('\n\n');
  } catch (err) {
    process.stderr.write(`  [checklist] skipped (non-blocking) — ${err.message}\n`);
    return rubric;
  }
}
