/**
 * @fileoverview Home collector: the five standing queues, one MEASUREMENT each.
 *
 * Reads go through `gatherBacklogEnvelopes` (the same definition the
 * `backlog-snapshot` CLI uses), so Home cannot grow a second copy of "what is a
 * queue". The failure KIND is kept (`KIND_TO_STATUS`): an unreachable store is an
 * expected absence (`missing-optional`), a broken reader is a defect
 * (`unexpected-error`). A queue is only ever a number when its envelope carried the
 * count fields — never `rows.length`, never `0` for an unasked question.
 *
 * Trend: the previous value comes from the newest `Backlog …` line in `status.md`
 * (`/ship` pastes it), parsed by `parseBacklogLine`.
 *
 * Plan: docs/plans/dashboard-home-summary.md §2 (Card contract, Health strip).
 *
 * @module scripts/lib/dashboard/collect-home-queues
 */
import { gatherBacklogEnvelopes, KIND_TO_STATUS } from '../store/backlog-gather.mjs';
import { parseBacklogLine } from '../store/backlog-snapshot.mjs';
import { latestBacklogLine } from './status-entries.mjs';
import { makeMeasurement, isRepoSlug } from './home-model.mjs';

const num = Number.isFinite;

const META = {
  q1: { id: 'queue-q1', label: 'Q1 code fixes', source: 'cross-skill.mjs list-unlocked-fixes' },
  q2: { id: 'queue-q2', label: 'Q2 acceptances', source: 'cross-skill.mjs list-unremediated-acceptances' },
  q3: { id: 'queue-q3', label: 'Q3 final review', source: 'cross-skill.mjs final-review-pending' },
  debt: { id: 'queue-debt', label: 'Debt', source: 'debt-reconcile.mjs --json' },
  upstream: { id: 'queue-upstream', label: 'Upstream', source: 'cross-skill.mjs upstream list' },
};

/** The five queue measurements (id + label + source), for a placeholder when the whole unit fails. */
export const QUEUE_MEASUREMENTS = Object.freeze(Object.values(META).map((m) => Object.freeze({ ...m, card: 'queues' })));

/** Oldest instant a row carries, if the envelope has any (N03's age anchor). */
function oldestAt(rows) {
  const times = (Array.isArray(rows) ? rows : [])
    .map((r) => Date.parse(r?.createdAt ?? r?.created_at ?? r?.reportedAt ?? ''))
    .filter(num);
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

/**
 * The COUNT fields of an envelope, or null when it did not carry them. Mirrors the
 * formatter's own `hasCounts` rule (backlog-snapshot.mjs): an absent field is not a zero.
 */
function extractValue(key, env) {
  if (key === 'q1' || key === 'q2') {
    const m = env?.byMode;
    if (!m || !num(m.code) || !num(m.plan)) return null;
    const extra = key === 'q1'
      ? { aged: num(env.agedOut) ? env.agedOut : null }
      : { perm: num(env.byDisposition?.acceptedPermanent) ? env.byDisposition.acceptedPermanent : null };
    return { total: m.code + m.plan, code: m.code, plan: m.plan, ...extra };
  }
  if (key === 'q3') {
    return num(env?.counts?.totalActionable) ? { total: env.counts.totalActionable } : null;
  }
  if (key === 'debt') {
    if (!num(env?.cloudTotal) || !num(env?.localTotal)) return null;
    return { total: env.cloudTotal, cloud: env.cloudTotal, local: env.localTotal, spilled: num(env.undrainedSpills) ? env.undrainedSpills : null };
  }
  if (num(env?.total)) return { total: env.total, partial: false, oldestAt: oldestAt(env.rows) };
  if (Array.isArray(env?.rows)) return { total: env.rows.length, partial: Boolean(env.nextCursor), oldestAt: oldestAt(env.rows) };
  return null;
}

/** The previous per-queue value from a parsed Backlog line, in each measurement's own shape. */
function previousOf(key, p) {
  if (!p) return null;
  if (key === 'q1' || key === 'q2') { const q = p[key]; return q ? { total: q.code + q.plan, code: q.code, partial: false } : null; }
  if (key === 'q3') return p.q3 === null ? null : { total: p.q3 };
  if (key === 'debt') return p.debt ? { total: p.debt.cloud } : null;
  return p.upstream ? { total: p.upstream.total, partial: p.upstream.partial } : null; // a paginated count is a lower bound: keep the qualifier
}

/**
 * @param {string} root - repo root (the readers' cwd)
 * @param {object} [opts]
 * @param {boolean} [opts.statusCapped] - `statusText` is a prefix of a larger file
 * @param {string|null} [opts.statusText] - head of status.md (for the trend); null/absent ⇒ no baseline
 * @param {string} [opts.repo] - `owner/repo` slug for Q3; defaults to `LEARNING_REPO_NAME`
 * @param {Function} [opts.run] - reader runner (injectable)
 * @param {number} [opts.timeoutMs=20000] - per-read cap
 * @param {AbortSignal} [opts.signal]
 * @param {Date} [opts.now]
 * @returns {Promise<{card: 'queues', measurements: object[]}>}
 */
export async function collectQueues(root, { statusText = null, statusCapped, repo, run, timeoutMs = 20_000, signal, now = new Date() } = {}) {
  const candidate = repo ?? process.env.LEARNING_REPO_NAME ?? '';
  const slug = isRepoSlug(candidate) ? candidate : '';
  const { envelopes, outcomes } = await gatherBacklogEnvelopes({ repo: slug, cwd: root, run, timeoutMs, signal });
  const line = statusText ? latestBacklogLine(statusText, { capped: statusCapped }) : null;
  const prev = line ? parseBacklogLine(line) : null;
  const asOf = now.toISOString();

  const measurements = Object.keys(META).map((key) => {
    const { id, label, source } = META[key];
    const outcome = outcomes[key];
    let status = KIND_TO_STATUS[outcome.kind];
    let detail = outcome.detail;
    let value = null;
    if (status === 'ok') {
      value = extractValue(key, envelopes[key]);
      if (!value) { status = 'unexpected-error'; detail = 'answer lacks the count fields (malformed envelope)'; }
    }
    return makeMeasurement({
      id, label, card: 'queues', value, status, asOf, source, detail: status === 'ok' ? '' : detail,
      kind: outcome.kind,
      previous: status === 'ok' ? previousOf(key, prev) : null,
      previousAt: status === 'ok' && prev ? `${prev.at.slice(0, -1)}:00Z` : null,
      ...(key === 'q3' ? { repo: slug || null } : {}),
    });
  });
  return { card: 'queues', measurements };
}
