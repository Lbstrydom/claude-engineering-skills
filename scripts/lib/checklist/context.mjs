/**
 * @fileoverview The `/audit-code` side of the checklist: turn the audit's own `--files` / `--diff` inputs into a
 * `<checklist>` block, in-process, with the SAME matcher the CLI runs (`match.mjs`).
 *
 * OBSERVE-ONLY BY DEFAULT (pilot decision 2026-11-22): the audit ALWAYS evaluates the checklist and records the fires
 * (purpose `operational`), but the block enters the prompt only when `AUDIT_CHECKLIST_INJECT=1`, because a prompt change
 * reaches every audit everywhere. Unset: the rubric is BYTE-IDENTICAL whether or not `.audit-loop/checklist.json` exists.
 *
 * Status, carried on the audit context (`ctx.checklist`) and onto the round JSON as `_checklist` when unmeasured:
 *   `absent`     no checklist file: unaffected, nothing evaluated.
 *   `measured`   evaluated and recorded.
 *   `unmeasured` the file is invalid, the diff unreadable/unparseable, or a file could not be read whole: never a silent skip.
 *
 * @module scripts/lib/checklist/context
 */
import { loadChecklist } from './schema.mjs';
import { matchChecklist, renderChecklistBlock } from './match.mjs';

export const INJECT_ENV = 'AUDIT_CHECKLIST_INJECT';

/**
 * @param {object} [args]
 * @param {string[]} [args.targetPaths] - the audit's changed/target files (`--files` / `--changed`)
 * @param {string|null} [args.diffFile] - the audit's `--diff` unified-diff file
 * @param {string} [args.baseDir]
 * @param {string} [args.logPath] - fires log (tests); defaults to `.audit/checklist-fires.jsonl`
 * @returns {{block: string, firedCount: number, evaluated: number, status: 'absent'|'measured'|'unmeasured', absent: boolean, warning: string|null}}
 */
export function getChecklistContext({ targetPaths = [], diffFile = null, baseDir = process.cwd(), logPath } = {}) {
  const none = { block: '', firedCount: 0, evaluated: 0, status: 'measured', absent: false, warning: null };
  const loaded = loadChecklist({ repoRoot: baseDir });
  if (!loaded.ok) return { ...none, status: 'unmeasured', warning: loaded.error };
  if (loaded.absent) return { ...none, status: 'absent', absent: true };
  if (loaded.entries.length === 0) return none;
  const result = matchChecklist({
    entries: loaded.entries, files: targetPaths, diffPath: diffFile || undefined, purpose: 'operational', cwd: baseDir, logPath,
  });
  if (!result.ok) return { ...none, status: 'unmeasured', warning: `${result.code}: ${result.message}` };
  return { block: renderChecklistBlock(result.fired, loaded.entries), firedCount: result.fired.length, evaluated: result.evaluated, status: 'measured', absent: false, warning: null };
}

/**
 * The audit's one call. Evaluates and records always; appends the block to the rubric only under `AUDIT_CHECKLIST_INJECT=1`.
 * Sets `ctx.checklist` to the status. Never throws; an unmeasured evaluation says so on stderr and on the round (`_checklist`).
 *
 * @param {string} rubric - the requirements rubric ('' when none)
 * @param {Parameters<typeof getChecklistContext>[0]} args
 * @param {object} [ctx] - the audit context; receives `checklist`
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function withChecklistBlock(rubric, args, ctx = {}, env = process.env) {
  try {
    const cl = getChecklistContext(args);
    ctx.checklist = cl.status;
    if (cl.status === 'unmeasured') process.stderr.write(`  [checklist] UNMEASURED — the tripwire checklist could not be evaluated for this audit: ${cl.warning}\n`);
    if (cl.status === 'measured') process.stderr.write(`  [checklist] ${cl.firedCount} of ${cl.evaluated} entries fired${env[INJECT_ENV] === '1' ? '' : ` (observe-only: set ${INJECT_ENV}=1 to inject)`}\n`);
    if (!cl.block || env[INJECT_ENV] !== '1') return rubric;
    return [rubric, cl.block].filter(Boolean).join('\n\n');
  } catch (err) {
    ctx.checklist = 'unmeasured';
    process.stderr.write(`  [checklist] UNMEASURED — ${err.message}\n`);
    return rubric;
  }
}
