/**
 * @fileoverview Pure formatter for the per-ship backlog snapshot line.
 *
 * **Why a line per ship.** Three standing queues have been surfaced by `/ship`
 * as prose on every push for months, acknowledged, and never worked
 * (`docs/plans/standing-queue-burndown.md`). Prose that scrolls past is not a
 * measurement anyone can trend. One line in the status entry makes the drift
 * visible in the log, on the ship that caused it, rather than being
 * rediscovered every few weeks by someone re-running five commands.
 *
 * **The two rules this file exists to enforce**, both learned from real wrong
 * numbers in this repo:
 *
 *   1. **Never read `rows.length`.** Every one of these readers is CAPPED —
 *      `list-unlocked-fixes` caps `rows` at 20 while reporting the true total
 *      in `byMode`; `final-review-pending` caps `items` at 10 and reports
 *      `counts.totalActionable`. Counting rows once reported "20" against a
 *      real 232.
 *   2. **An unasked question never renders as `0`.** A reader that returned
 *      `measured:false`, `cloud:false`, or a non-repo scope answered nothing,
 *      and `0` would read as good news. Those render `unmeasured`.
 *
 * No I/O: the CLI performs the reads, this turns them into a string.
 *
 * Plan: docs/plans/backlog-and-drift-reduction.md §2 (snapshot grammar), Phase 10.
 *
 * @module scripts/lib/store/backlog-snapshot
 */

export const UNMEASURED = 'unmeasured';

/**
 * True when an envelope represents an answered question.
 *
 * Deliberately conservative: anything that is not positively a repo-scoped,
 * measured, cloud-backed answer is treated as unmeasured.
 *
 * @param {object|null|undefined} env
 * @returns {boolean}
 */
export function isMeasured(env) {
  if (!env || typeof env !== 'object') return false;
  if (env.ok === false) return false;
  if (env.cloud === false) return false;
  if (env.measured === false) return false;
  if (env.scope && env.scope.mode && env.scope.mode !== 'repo') return false;
  return true;
}

/**
 * A count is only a count when the envelope actually carried it.
 *
 * `m.code ?? 0` substituted 0 for an ABSENT field, so a transport-looking but
 * structurally incomplete envelope rendered as a real zero — the same
 * "unasked question reads as good news" defect the `unmeasured` rule exists to
 * prevent, one level down.
 */
function hasCounts(m) {
  return m && Number.isFinite(m.code) && Number.isFinite(m.plan);
}

function fmtQ1(env) {
  if (!isMeasured(env) || !hasCounts(env.byMode)) return `Q1 ${UNMEASURED}`;
  const m = env.byMode;
  const aged = Number.isFinite(env.agedOut) ? ` (+${env.agedOut} aged)` : '';
  return `Q1 ${m.code}c/${m.plan}p${aged}`;
}

function fmtQ2(env) {
  if (!isMeasured(env) || !hasCounts(env.byMode)) return `Q2 ${UNMEASURED}`;
  const m = env.byMode;
  const perm = env.byDisposition?.acceptedPermanent;
  const permStr = Number.isFinite(perm) ? ` (${perm} perm)` : '';
  return `Q2 ${m.code}c/${m.plan}p${permStr}`;
}

function fmtQ3(env) {
  // `final-review-pending` uses `state`, not `measured`/`cloud`.
  if (!env || typeof env !== 'object' || env.state !== 'ready' || !env.counts
      || !Number.isFinite(env.counts.totalActionable)) {
    return `Q3 ${UNMEASURED}`;
  }
  return `Q3 ${env.counts.totalActionable}`;
}

function fmtDebt(env) {
  if (!env || typeof env !== 'object' || env.verdict !== 'measured'
      || !Number.isFinite(env.cloudTotal) || !Number.isFinite(env.localTotal)) {
    return `debt ${UNMEASURED}`;
  }
  // `null` means the spill directory could not be read — say so rather than
  // printing 0, which would claim an empty loss window we did not observe.
  const spilled = Number.isFinite(env.undrainedSpills) ? env.undrainedSpills : '?';
  // The spill count is carried even at zero: an undrained spill is a real,
  // bounded loss window (the artifact exists because the write did NOT land),
  // and a window nobody prints is a window nobody closes.
  return `debt ${env.cloudTotal} cloud/${env.localTotal} local (${spilled} spilled)`;
}

function fmtUpstream(env) {
  if (!env || typeof env !== 'object' || env.ok !== true || env.cloud === false) {
    return `upstream ${UNMEASURED}`;
  }
  // COUNT field first, `rows.length` only as a last resort — this function
  // had it backwards, preferring `rows.length` and so defeating rule 1 of this
  // very module on the one reader that paginates. `nextCursor` proves the list
  // is partial, so a length read there is a floor, not a total.
  if (Number.isFinite(env.total)) return `upstream ${env.total}`;
  if (Array.isArray(env.rows)) {
    return env.nextCursor ? `upstream ${env.rows.length}+` : `upstream ${env.rows.length}`;
  }
  return `upstream ${UNMEASURED}`;
}

/**
 * Render the single status-entry line.
 *
 * @param {object} input
 * @param {object} [input.q1] - `list-unlocked-fixes` envelope
 * @param {object} [input.q2] - `list-unremediated-acceptances` envelope
 * @param {object} [input.q3] - `final-review-pending` envelope
 * @param {object} [input.debt] - `debt-reconcile --json` envelope
 * @param {object} [input.upstream] - `upstream list` envelope
 * @param {Date|string} [input.at] - measurement instant
 * @returns {string}
 */
export function renderBacklogSnapshot({ q1, q2, q3, debt, upstream, at = new Date() } = {}) {
  const ts = (at instanceof Date ? at : new Date(at)).toISOString().replace(/:\d{2}\.\d{3}Z$/, 'Z');
  const parts = [fmtQ1(q1), fmtQ2(q2), fmtQ3(q3), fmtDebt(debt), fmtUpstream(upstream)];
  return `Backlog ${ts}: ${parts.join(' · ')}`;
}
