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
export function hasCounts(m) {
  return m && Number.isFinite(m.code) && Number.isFinite(m.plan);
}

/**
 * Is this envelope a COMPLETE answer for `reader` — i.e. one the matching formatter would render
 * as a number rather than `unmeasured`? The same predicates the `fmt*` functions below apply, in
 * one place, so a classifier cannot accept an envelope (e.g. `{}`) the formatter would refuse.
 *
 * @param {'q1'|'q2'|'q3'|'upstream'|'debt'} reader
 * @param {object|null|undefined} env
 * @returns {boolean}
 */
export function isCompleteAnswer(reader, env) {
  if (!env || typeof env !== 'object') return false;
  if (reader === 'q1' || reader === 'q2') return isMeasured(env) && Boolean(hasCounts(env.byMode));
  if (reader === 'q3') return env.state === 'ready' && Boolean(env.counts) && Number.isFinite(env.counts.totalActionable);
  if (reader === 'debt') return env.verdict === 'measured' && Number.isFinite(env.cloudTotal) && Number.isFinite(env.localTotal);
  return env.ok === true && env.cloud !== false && (Number.isFinite(env.total) || Array.isArray(env.rows));
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

const LINE_HEAD = /^Backlog (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z): (.+)$/;
const Q3_LINE = /^Q3 (?:unmeasured|(\d+))$/;
const DEBT_LINE = /^debt (?:unmeasured|(\d+) cloud\/(\d+) local \((\d+|\?) spilled\))$/;
const UPSTREAM_LINE = /^upstream (?:unmeasured|(\d+)(\+)?)$/;
const CODE_PLAN = { Q1: /^Q1 (?:unmeasured|(\d+)c\/(\d+)p(?: \(\+?(\d+) aged\))?)$/, Q2: /^Q2 (?:unmeasured|(\d+)c\/(\d+)p(?: \(\+?(\d+) perm\))?)$/ };

/** `<n>c/<m>p` plus an optional ` (<n> <word>)`; each label's regex names its legal word. */
function parseCodePlan(seg, label) {
  const m = CODE_PLAN[label].exec(seg);
  if (!m) return undefined;
  if (m[1] === undefined) return null;
  return { code: Number(m[1]), plan: Number(m[2]), extra: m[3] === undefined ? null : Number(m[3]) };
}

/**
 * Parse one line written by {@link renderBacklogSnapshot} — the READER that matches
 * that writer. `/ship` pastes the line into `status.md`, so the producer is a
 * formatter and the consumer is code with no compiler between them; a round-trip
 * test pins the two, and a REAL line from `status.md` is a fixture.
 *
 * Returns per-queue numbers, with `null` for a queue that rendered `unmeasured`
 * (an unasked question stays distinct from a zero). Returns `null` for the WHOLE
 * line when it is not a backlog line or any segment does not match the grammar —
 * a half-parsed line must not look like a measurement.
 *
 * @param {string} line
 * @returns {null | {at: string, q1: null|{code: number, plan: number, aged: number|null},
 *   q2: null|{code: number, plan: number, perm: number|null}, q3: number|null,
 *   debt: null|{cloud: number, local: number, spilled: number|null},
 *   upstream: null|{total: number, partial: boolean}}}
 */
export function parseBacklogLine(line) {
  if (typeof line !== 'string') return null;
  const head = LINE_HEAD.exec(line.trim());
  if (!head) return null;
  const segs = head[2].split(' · ');
  if (segs.length !== 5) return null;
  const q1 = parseCodePlan(segs[0], 'Q1');
  const q2 = parseCodePlan(segs[1], 'Q2');
  if (q1 === undefined || q2 === undefined) return null;
  const q3m = Q3_LINE.exec(segs[2]);
  const dm = DEBT_LINE.exec(segs[3]);
  const um = UPSTREAM_LINE.exec(segs[4]);
  if (!q3m || !dm || !um) return null;
  return {
    at: head[1],
    q1: q1 && { code: q1.code, plan: q1.plan, aged: q1.extra },
    q2: q2 && { code: q2.code, plan: q2.plan, perm: q2.extra },
    q3: q3m[1] === undefined ? null : Number(q3m[1]),
    debt: dm[1] === undefined ? null
      : { cloud: Number(dm[1]), local: Number(dm[2]), spilled: dm[3] === '?' ? null : Number(dm[3]) },
    upstream: um[1] === undefined ? null : { total: Number(um[1]), partial: um[2] === '+' },
  };
}
