/**
 * @fileoverview The no-measurement marker: how a scheduled job says "I ran, I did
 * not fail, and I did not measure anything real this time".
 *
 * # Why a green run needs a way to say it was empty
 *
 * `workflow-cadence-doctor.mjs` reads a workflow's run-level conclusion, and a
 * conclusion has two values that matter: `success` and not. A job that hit a
 * fail-open branch -- no credential, no snapshot, no input -- and exited 0
 * reports `success`, and from the doctor's vantage point that is byte-identical
 * to a job that did its work. Measured 2026-09-13 in the source repo itself:
 * five of the six watched crons had been green-and-skipping (`AUDIT_DB_URL not
 * set -- skipping ...`) since the store moved off Supabase, `memory-health.yml`
 * for every scheduled run since at least 2026-06-22, and the doctor read `ok` on
 * all six. A consumer found the same shape the hard way (wine-cellar-app #507:
 * a wrapper returning 0 on `no active snapshot` kept a dead credential green for
 * ~26 days).
 *
 * The run conclusion cannot carry a third value -- GitHub retired `neutral` for
 * workflow jobs -- and failing the run is wrong for the honest "nothing to do"
 * case (cried-wolf red is how a gate earns `--no-verify`). So the convention is
 * a CHECK-RUN ANNOTATION with a fixed title, which the emitting step writes as a
 * workflow command and the doctor reads back through the annotations API.
 *
 * # The contract
 *
 *   ::notice title=audit-loop-no-measurement::<reason>
 *
 * The TITLE is the key; the level (`notice` / `warning`) is the emitter's
 * choice and the reader ignores it. Emit it from whichever step DECIDED not to
 * measure -- a shell `if [ -z "$AUDIT_DB_URL" ]` branch in the workflow YAML,
 * or a Node script via `emitNoMeasurement`. A run carrying this annotation is
 * reported by the doctor as `unmeasured`, never `ok`, on any watch entry that
 * sets `requireMeasurement: true`.
 *
 * # Why annotations and not the job log
 *
 * The log was the obvious instrument and it is a trap: Actions prints the full
 * `run:` script body BEFORE executing it, so a grep for the marker matches the
 * echoed source of the branch that did NOT fire. The annotations API reflects
 * only commands that actually executed. It costs one extra permission
 * (`checks: read`), which the doctor names when it is missing.
 *
 * @module scripts/lib/measurement-marker
 */

/** The annotation title the doctor keys on. Reader and every writer share it. */
export const NO_MEASUREMENT_TITLE = 'audit-loop-no-measurement';

/** Escape a workflow-command DATA segment (GitHub's own rules). */
function escapeData(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/**
 * The exact line a step prints to declare no-measurement.
 *
 * @param {string} reason  Why nothing was measured. Keep it one line.
 * @param {{level?: 'notice'|'warning'}} [opts]
 * @returns {string} e.g. `::notice title=audit-loop-no-measurement::AUDIT_DB_URL not set`
 */
export function formatNoMeasurementCommand(reason, { level = 'notice' } = {}) {
  if (level !== 'notice' && level !== 'warning') {
    throw new TypeError(`no-measurement level must be "notice" or "warning", got ${JSON.stringify(level)}`);
  }
  const text = String(reason ?? '').trim();
  if (text === '') throw new TypeError('a no-measurement marker needs a reason');
  return `::${level} title=${NO_MEASUREMENT_TITLE}::${escapeData(text)}`;
}

/**
 * Declare that this run measured nothing.
 *
 * Under `GITHUB_ACTIONS` the workflow command goes to STDOUT -- that is the only
 * stream the runner parses for commands. Anywhere else it is a plain, prefixed
 * line on stderr, so a CLI keeping stdout clean for JSON still says so.
 *
 * @param {string} reason
 * @param {{env?: NodeJS.ProcessEnv, out?: NodeJS.WritableStream,
 *          err?: NodeJS.WritableStream, level?: 'notice'|'warning'}} [opts]
 * @returns {string} the line written
 */
export function emitNoMeasurement(reason, {
  env = process.env, out = process.stdout, err = process.stderr, level = 'notice',
} = {}) {
  const line = env.GITHUB_ACTIONS
    ? formatNoMeasurementCommand(reason, { level })
    : `[no-measurement] ${String(reason ?? '').trim()}`;
  (env.GITHUB_ACTIONS ? out : err).write(`${line}\n`);
  return line;
}

/**
 * Is this GitHub check-run annotation the marker?
 *
 * Level-agnostic and title-exact: a warning with a different title is somebody
 * else's warning, and an untitled `::warning::AUDIT_DB_URL not set -- skipping`
 * -- the shape every one of this repo's crons emitted before 2026-09-13 -- is
 * NOT a match. Absence of the marker means "measured, as far as the run said",
 * which is exactly what it meant before this convention existed.
 *
 * @param {{title?: string}|null|undefined} annotation
 */
export function isNoMeasurementAnnotation(annotation) {
  return Boolean(annotation) && typeof annotation === 'object'
    && annotation.title === NO_MEASUREMENT_TITLE;
}
