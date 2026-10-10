/**
 * @fileoverview PURE decision core of the dashboard Home tab: the measurement
 * factory, the chip grading table (`HEALTH_RULES`), the Needs-you rule table
 * (`NEEDS_RULES`) and ranker, and the bounded-projection helper the renderer uses.
 * No I/O, no clock: everything time-derived (ages, days overdue) arrives already
 * computed inside the measurement.
 *
 * Three different things (plan §2): a MEASUREMENT is one independently-obtainable
 * value and OWNS its status — `{id, label, card, value, status, asOf, source,
 * detail}`; a COLLECTOR returns an array of them; a CARD is only a presentation
 * grouping. A chip derives from ITS measurement, so one unreadable source degrades
 * one chip, not its neighbours.
 *
 * Two honesty rules the tables enforce:
 *   - `ok` is reachable ONLY from a measured value that met a stated rule. A
 *     measured value with no rule to judge it is `neutral`; a measurement whose
 *     status is not `ok` is `unmeasured` regardless of the table, never green.
 *   - "Nothing needs you" is emitted only when no rule fired AND nothing is
 *     unmeasured — absence of evidence is not evidence of absence.
 *
 * Plan: docs/plans/dashboard-home-summary.md §2 (Health strip, Needs you).
 *
 * @module scripts/lib/dashboard/home-model
 */

// ── Bounded projections (plan §2 "Bounded projections") ────────────────────────

/** Display truncation limits, in characters. The full text rides in a capped `title` attribute. */
export const LIMITS = Object.freeze({
  title: 140, path: 120, subject: 140, detail: 200, receiptLabel: 60, titleAttr: 400,
});

/** Collectors store strings clipped to this, so the payload is bounded before it is ever rendered. */
export const STORED_MAX = LIMITS.titleAttr;

/** Collapse control characters (newlines included) to single spaces. */
const flat = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();

/** Cut to `max` UTF-16 units without splitting a surrogate pair. */
function cut(s, max) {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/** Clip a string for STORAGE in a measurement (single line, ≤ 400). */
export function clip(value, max = STORED_MAX) {
  return cut(flat(value), max);
}

/**
 * Truncate for DISPLAY. A truncated value gets an ellipsis and keeps its full text
 * (itself capped at {@link LIMITS.titleAttr}) for a `title` attribute; an intact one
 * has `title: null`. Escaping is the renderer's job and happens after this.
 *
 * @param {unknown} value
 * @param {number} limit - one of {@link LIMITS}
 * @returns {{text: string, title: string|null}}
 */
export function bound(value, limit) {
  const s = flat(value);
  if (s.length <= limit) return { text: s, title: null };
  return { text: `${cut(s, limit - 1)}…`, title: cut(s, LIMITS.titleAttr) };
}

// ── Measurement ────────────────────────────────────────────────────────────────

/** Valid source statuses (schema.mjs `SourceStatusSchema`). */
const STATUSES = new Set(['ok', 'missing-optional', 'invalid', 'unexpected-error']);

/**
 * Build one measurement. `status` is mandatory and validated: a typo must not
 * silently become "not ok" nor, worse, "ok".
 *
 * @param {object} m
 * @returns {{id: string, label: string, card: string, value: any, status: string, asOf: string|null, source: string, detail: string}}
 */
export function makeMeasurement({ id, label, card, value = null, status, asOf = null, source, detail = '', ...extra }) {
  if (!STATUSES.has(status)) throw new Error(`measurement ${id}: invalid status ${JSON.stringify(status)}`);
  return { id, label, card, value, status, asOf, source: clip(source, LIMITS.detail), detail: clip(detail), ...extra };
}

export const CARD_LABELS = Object.freeze({
  queues: 'Queues', vitals: 'Vitals', consumers: 'Consumers', shipped: 'Recently shipped', inflight: 'In flight',
});

// ── Commands: literals, with at most one validated interpolation ───────────────

const CONSUMER_NAME = /^[A-Za-z0-9._-]+$/;
const DOTS_ONLY = /^\.+$/;

/** A consumer name safe to interpolate into a command: the plan's pattern, and never `.`/`..`. */
export const isConsumerName = (v) => typeof v === 'string' && CONSUMER_NAME.test(v) && !DOTS_ONLY.test(v);
/** An `owner/repo` slug safe to interpolate into a command: the plan's pattern, and no `.`/`..` segment. */
export const isRepoSlug = (v) => typeof v === 'string' && REPO_SLUG.test(v) && !v.split('/').some((x) => DOTS_ONLY.test(x));
const REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Literal commands. Every npm invocation that takes a flag uses the `--` form. */
const CMD = Object.freeze({
  whoami: 'node scripts/cross-skill.mjs whoami',
  unlockedFixes: 'node scripts/cross-skill.mjs list-unlocked-fixes',
  syncStatus: 'node scripts/sync-status.mjs',
  maintenanceStatus: 'node scripts/maintenance-checks.mjs --status',
  contextCheck: 'npm run context:check',
  skillsCheck: 'npm run skills:check',
  buildStderr: 'node scripts/build-dashboard.mjs reference',
  upstreamQueues: 'npm run upstream:queues',
  unremediated: 'node scripts/cross-skill.mjs list-unremediated-acceptances',
  lockWithTest: 'node scripts/cross-skill.mjs lock-with-test --worksheet',
  maintenanceRun: 'node scripts/maintenance-checks.mjs',
  debtReview: 'npm run debt:review',
});

/** N01: one command per measurement id (queues share one; consumer rows share the consumers one). */
function unmeasuredCommand(id) {
  if (id.startsWith('queue-')) return CMD.whoami;
  if (id === 'consumers' || id.startsWith('consumer:')) return CMD.syncStatus;
  if (id === 'maintenance') return CMD.maintenanceStatus;
  if (id === 'agents-size') return CMD.contextCheck;
  if (id === 'skills') return CMD.skillsCheck;
  if (id === 'plans') return null; // a link to the Plans tab, not a command
  return CMD.buildStderr; // status log, merge log, in-flight: the build's own stderr
}

const pctOf = (chars, cap) => Math.floor((chars * 100) / cap);

/** An In Progress plan older than this many days is stale. The ONE place the policy lives. */
export const STALE_PLAN_DAYS = 14;
const DAY_MS = 86_400_000;

/**
 * The In Progress plans older than {@link STALE_PLAN_DAYS} at the measurement's `asOf`, oldest first.
 * The collector passes raw dates; undated plans cannot be called stale (a malformed header is
 * flagged elsewhere).
 * @param {{value: {plans: Array<{slug: string, path: string, date: string|null}>}, asOf: string|null}} m
 * @returns {Array<{slug: string, path: string, date: string, days: number}>}
 */
export function staleInProgress(m) {
  const at = Date.parse(m.asOf ?? '');
  if (Number.isNaN(at)) return [];
  return (m.value?.plans ?? [])
    .map((p) => ({ ...p, t: Date.parse(p.date ?? '') }))
    .filter((p) => !Number.isNaN(p.t))
    .filter((p) => at - p.t > STALE_PLAN_DAYS * DAY_MS) // strictly older than the policy, to the millisecond
    .map((p) => ({ slug: p.slug, path: p.path, date: p.date, days: Math.floor((at - p.t) / DAY_MS) }))
    .sort((a, b) => b.days - a.days);
}

// ── HEALTH_RULES ───────────────────────────────────────────────────────────────

const fmtCodePlan = (v) => `${v.code}c/${v.plan}p`;
const FMT = {
  'queue-q1': fmtCodePlan,
  'queue-q2': fmtCodePlan,
  'queue-q3': (v) => String(v.total),
  'queue-debt': (v) => `${v.cloud} cloud/${v.local} local`,
  'queue-upstream': (v) => `${v.total}${v.partial ? '+' : ''}`,
};

/** Queue chip: ok = measured and <= previous; warn = grew; no previous line = neutral. */
function gradeQueue(m) {
  const value = FMT[m.id](m.value);
  const prev = m.previous;
  if (!prev || !Number.isFinite(prev.total)) {
    return { state: 'neutral', value, detail: 'no previous Backlog line in status.md to compare with' };
  }
  // A paginated count is a LOWER BOUND: neither "not above" nor "grew" can be claimed against one.
  if (m.value.partial || prev.partial) {
    return { state: 'neutral', value, detail: 'a paginated count is a lower bound, so it is not comparable with the previous line' };
  }
  return m.value.total <= prev.total
    ? { state: 'ok', value, detail: `not above the previous line (${prev.total})` }
    : { state: 'warn', value, detail: `grew from ${prev.total} on the previous line` };
}

function gradeAgents(m) {
  const { chars, cap } = m.value;
  const value = `${pctOf(chars, cap)}% of ${cap}`;
  if (chars * 100 < cap * 95) return { state: 'ok', value, detail: `${chars} characters, below 95% of the cap` };
  if (chars <= cap) return { state: 'warn', value, detail: `${chars} characters, at or above 95% of the cap` };
  return { state: 'bad', value, detail: `${chars} characters, over the ${cap}-character cap` };
}

function gradePlans(m) {
  // staleInProgress() returns [] for an unusable observation time; that must read as "could not be
  // evaluated", never as "no stale plans" (an unasked question is not good news).
  if (Number.isNaN(Date.parse(m.asOf ?? ''))) {
    return { state: 'neutral', value: `${m.value.inProgress} in progress`, detail: 'staleness could not be evaluated (no usable observation time)' };
  }
  const old = staleInProgress(m);
  return old.length === 0
    ? { state: 'ok', value: `${m.value.inProgress} in progress`, detail: `no plan In Progress for more than ${STALE_PLAN_DAYS} days` }
    : { state: 'warn', value: `${old.length} stale`, detail: `${old.length} plan(s) In Progress for more than ${STALE_PLAN_DAYS} days` };
}

function gradeConsumers(m) {
  const v = m.value;
  if (v.mode === 'consumer') {
    return { state: 'neutral', value: `last synced ${v.syncedAt ?? 'at an unknown time'} from ${v.sha7 ?? 'an unknown commit'}`, detail: 'a fact, not a judgement: upstream HEAD is not knowable offline' };
  }
  const value = `${v.current}/${v.total} current${v.omitted > 0 ? ` (+${v.omitted} not inspected)` : ''}`;
  const allCurrent = v.total > 0 && v.omitted === 0 && v.inspected === v.total && v.current === v.inspected;
  // `omitted > 0` can never be ok: an uninspected consumer is an unanswered question.
  if (allCurrent) return { state: 'ok', value, detail: 'every registered consumer is at this HEAD' };
  const counts = `${v.behind} behind, ${v.notComparable} not comparable, ${v.unreadable} unreadable, ${v.omitted} not inspected`;
  // warn is for what a human can act on: behind, unreadable, or not inspected. A receipt commit that is not on this
  // history is typical after a squash-merge and receipts carry no bundle hash, so currency cannot be judged: neutral,
  // never a permanent warn (measured 2026-10-06: all three real receipts record a pre-squash branch commit).
  const actionable = v.behind > 0 || v.unreadable > 0 || v.omitted > 0 || v.total === 0;
  return actionable
    ? { state: 'warn', value, detail: counts }
    : { state: 'neutral', value, detail: `${counts}: receipt commit is not on this history — typical after a squash-merge; receipts carry no bundle hash, so currency cannot be judged by content` };
}

function gradeMaintenance(m) {
  const v = m.value;
  return v.overdueDays === 0
    ? { state: 'ok', value: 'on schedule', detail: `last run ${v.lastRunAt}, within its ${v.windowDays}-day window` }
    : { state: 'warn', value: `overdue ${v.overdueDays}d`, detail: `last run ${v.lastRunAt}, window ${v.windowDays} days` };
}

function gradeSkills(m) {
  const { count, roster } = m.value;
  // The table says "equal (neutral chip showing the count)": equal is not a threshold met, it is a consistency fact.
  return count === roster
    ? { state: 'neutral', value: String(count), detail: 'skills on disk match the census roster' }
    : { state: 'bad', value: `${count} vs ${roster}`, detail: `${count} skills on disk, census roster lists ${roster}` };
}

/**
 * The one committed grading table. `rule` states, in words, what earns each state;
 * a chip never has a state its row does not name. Add a chip = add a row + a test row.
 */
export const HEALTH_RULES = Object.freeze([
  // The queue's OWN listing, like Q2 — `whoami` is the remedy for an UNMEASURED queue (unmeasuredCommand),
  // and on a measured card it named nothing about the fixes counted (persona-test 2026-10-10, P2).
  { id: 'queue-q1', label: 'Q1 code fixes', from: 'queue-q1', tab: null, command: CMD.unlockedFixes,
    rule: 'ok: measured and not above the previous Backlog line; warn: grew; neutral: no previous line', grade: gradeQueue },
  { id: 'queue-q2', label: 'Q2 acceptances', from: 'queue-q2', tab: null, command: CMD.unremediated,
    rule: 'ok: measured and not above the previous line; warn: grew; neutral: no previous line', grade: gradeQueue },
  { id: 'queue-q3', label: 'Q3 final review', from: 'queue-q3', tab: null, command: null,
    rule: 'ok: measured and not above the previous line; warn: grew; neutral: no previous line', grade: gradeQueue },
  { id: 'queue-debt', label: 'Debt', from: 'queue-debt', tab: null, command: CMD.debtReview,
    rule: 'ok: measured and not above the previous line; warn: grew; neutral: no previous line', grade: gradeQueue },
  { id: 'queue-upstream', label: 'Upstream', from: 'queue-upstream', tab: null, command: CMD.upstreamQueues,
    rule: 'ok: measured and not above the previous line; warn: grew; neutral: no previous line', grade: gradeQueue },
  { id: 'agents-size', label: 'AGENTS.md size', from: 'agents-size', tab: null, command: CMD.contextCheck,
    rule: 'ok: < 95% of the cap (characters); warn: 95-100%; bad: > 100%', grade: gradeAgents },
  { id: 'plans', label: 'Plans', from: 'plans', tab: 'plans', command: null,
    rule: 'ok: none In Progress older than 14 days; warn: at least one', grade: gradePlans },
  { id: 'consumers', label: 'Consumers', from: 'consumers', tab: null, command: CMD.syncStatus,
    rule: 'ok: all inspected AND every one current; warn: any behind, not inspected or unreadable; neutral: only not-comparable (receipt commit off this history) and in a consumer repo', grade: gradeConsumers },
  { id: 'maintenance', label: 'Maintenance', from: 'maintenance', tab: null, command: CMD.maintenanceStatus,
    rule: 'ok: within its 7-day window; warn: overdue', grade: gradeMaintenance },
  { id: 'skills', label: 'Skills', from: 'skills', tab: null, command: CMD.skillsCheck,
    rule: 'neutral: equal to the census roster (shows the count); bad: unequal', grade: gradeSkills },
]);

/**
 * Grade every chip. A measurement whose status is not `ok` (or that is absent)
 * yields `unmeasured` with its reason, whatever the table row says.
 *
 * @param {Array<object>} measurements - flat list from every collector
 * @returns {Array<{id: string, label: string, value: string, state: 'ok'|'warn'|'bad'|'neutral'|'unmeasured', measured: boolean, source: string, asOf: string|null, detail: string, tab: string|null, command: string|null}>}
 */
export function gradeHealth(measurements) {
  const byId = new Map(measurements.map((m) => [m.id, m]));
  return HEALTH_RULES.map((r) => {
    const m = byId.get(r.from);
    const base = { id: r.id, label: r.label, tab: r.tab, command: r.command };
    if (!m || m.status !== 'ok' || m.value == null) {
      return { ...base, value: '—', state: 'unmeasured', measured: false, source: m?.source ?? 'not collected', asOf: m?.asOf ?? null, detail: m ? (m.detail || `source status ${m.status}`) : 'this measurement was not collected' };
    }
    const g = r.grade(m);
    return { ...base, ...g, measured: true, source: m.source, asOf: m.asOf, detail: clip(g.detail) };
  });
}

// ── NEEDS_RULES ────────────────────────────────────────────────────────────────

export const MAX_NEEDS_ROWS = 8;
export const NOTHING_NEEDS_YOU = 'Nothing needs you';

function index(model) {
  const measurements = Array.isArray(model) ? model : (model?.measurements ?? []);
  const byId = new Map(measurements.map((m) => [m.id, m]));
  return { measurements, byId, unmeasured: measurements.filter((m) => m.status !== 'ok') };
}

/** `true | false | 'unmeasured'`: the rule's input is missing or its measurement is not ok. */
function need(idx, id, test) {
  const m = idx.byId.get(id);
  if (!m || m.status !== 'ok' || m.value == null) return 'unmeasured';
  return test(m);
}

/** Age anchor of a queue rule: the previous line's instant, only when the value did not fall since. */
const trendAnchor = (m, current, previous) => (m.previous && Number.isFinite(previous) && current >= previous ? (m.previousAt ?? null) : null);
const notBelowPrevious = (current, previous) => !Number.isFinite(previous) || current >= previous;
const plural = (n) => n;

/**
 * The complete rule table (plan §2, ids stable). Severity 3 is highest; ties break
 * by age anchor (older first, none last), then rule id, then text — deterministic.
 * `when` answers true | false | 'unmeasured'; `rows` is called only for `true`.
 */
export const NEEDS_RULES = Object.freeze([
  {
    id: 'N01', severity: 3,
    when: (idx) => idx.unmeasured.length > 0,
    rows: (idx) => {
      // Measurements that share (card, detail, command, tab) are ONE cause with ONE remedy: one row, not N copies of
      // the same sentence. Differing causes keep their own rows. `unmeasured` still counts measurements.
      const groups = new Map();
      for (const m of idx.unmeasured) {
        const detail = m.detail || `source status ${m.status}`;
        const command = unmeasuredCommand(m.id);
        const tab = m.id === 'plans' ? 'plans' : null;
        const key = JSON.stringify([m.card, detail, command, tab]);
        if (!groups.has(key)) groups.set(key, { detail, command, tab, card: m.card, members: [] });
        groups.get(key).members.push(m);
      }
      return [...groups.values()].map((g) => {
        const first = g.members[0];
        const n = g.members.length;
        const text = n === 1
          ? `${first.label} unmeasured — ${g.detail}`
          : `${(CARD_LABELS[g.card] ?? g.card).toUpperCase()}: ${n} readings unmeasured — ${g.detail}`;
        return { text, command: g.command, tab: g.tab, anchor: null, card: g.card, measurementId: first.id, measurementIds: g.members.map((m) => m.id) };
      });
    },
  },
  {
    id: 'N02', severity: 3,
    when: (idx) => need(idx, 'skills', (m) => m.value.count !== m.value.roster),
    rows: (idx) => {
      const v = idx.byId.get('skills').value;
      return [{ text: `Census roster is stale (${v.count} skills vs ${v.roster})`, command: CMD.skillsCheck, anchor: null }];
    },
  },
  {
    id: 'N03', severity: 3,
    when: (idx) => need(idx, 'queue-upstream', (m) => m.value.total > 0),
    rows: (idx) => {
      const m = idx.byId.get('queue-upstream');
      return [{ text: `${m.value.total}${m.value.partial ? '+' : ''} upstream report(s) open`, command: CMD.upstreamQueues, anchor: m.value.oldestAt ?? null }];
    },
  },
  {
    id: 'N04', severity: 2,
    when: (idx) => need(idx, 'queue-q2', (m) => m.value.total > 0 && notBelowPrevious(m.value.total, m.previous?.total)),
    rows: (idx) => {
      const m = idx.byId.get('queue-q2');
      return [{ text: `${m.value.total} accepted finding(s) never remediated`, command: CMD.unremediated, anchor: trendAnchor(m, m.value.total, m.previous?.total) }];
    },
  },
  {
    id: 'N05', severity: 2,
    when: (idx) => need(idx, 'queue-q1', (m) => m.value.code > 0 && notBelowPrevious(m.value.code, m.previous?.code)),
    rows: (idx) => {
      const m = idx.byId.get('queue-q1');
      return [{ text: `${m.value.code} code fix(es) have no regression lock`, command: CMD.lockWithTest, anchor: trendAnchor(m, m.value.code, m.previous?.code) }];
    },
  },
  {
    id: 'N06', severity: 2,
    when: (idx) => need(idx, 'plans', (m) => staleInProgress(m).length > 0),
    rows: (idx) => staleInProgress(idx.byId.get('plans')).map((p) => ({
      text: `Plan ${p.slug} In Progress for ${plural(p.days)} days`, command: null, tab: 'plans', anchor: p.date ?? null,
    })),
  },
  {
    id: 'N07', severity: 2,
    when: (idx) => need(idx, 'consumers', (m) => m.value.mode === 'source' && m.value.rows.some((r) => r.state === 'behind')),
    rows: (idx) => idx.byId.get('consumers').value.rows.filter((r) => r.state === 'behind').map((r) => {
      const ok = isConsumerName(r.name);
      return {
        text: `${ok ? r.name : 'A consumer'} is ${r.behind} commit(s) behind`,
        // Interpolated ONLY when the name matches its pattern; otherwise the row says so, never an unvalidated string.
        command: ok ? `npm run sync -- --target ${r.name}` : null,
        commandNote: ok ? null : 'command unavailable',
        anchor: r.syncedAt ?? null,
      };
    }),
  },
  {
    id: 'N08', severity: 2,
    when: (idx) => need(idx, 'maintenance', (m) => m.value.overdueDays > 0),
    rows: (idx) => {
      const v = idx.byId.get('maintenance').value;
      return [{ text: `Weekly maintenance overdue by ${v.overdueDays} day(s)`, command: CMD.maintenanceRun, anchor: v.lastRunAt ?? null }];
    },
  },
  {
    id: 'N09', severity: 2,
    when: (idx) => need(idx, 'agents-size', (m) => m.value.chars * 100 >= m.value.cap * 95),
    rows: (idx) => {
      const v = idx.byId.get('agents-size').value;
      return [{ text: `AGENTS.md at ${pctOf(v.chars, v.cap)} % of its cap`, command: CMD.contextCheck, anchor: null }];
    },
  },
  {
    id: 'N10', severity: 1,
    when: (idx) => need(idx, 'queue-q3', (m) => m.value.total > 0),
    rows: (idx) => {
      const m = idx.byId.get('queue-q3');
      const slug = m.repo;
      const ok = isRepoSlug(slug);
      return [{
        text: `${m.value.total} final-review finding(s) await a ruling`,
        command: ok ? `node scripts/cross-skill.mjs final-review-pending --repo ${slug}` : null,
        commandNote: ok ? null : 'command unavailable',
        anchor: trendAnchor(m, m.value.total, m.previous?.total),
      }];
    },
  },
  {
    id: 'N11', severity: 1,
    when: (idx) => need(idx, 'queue-debt', (m) => m.value.total > 0 && notBelowPrevious(m.value.total, m.previous?.total)),
    rows: (idx) => {
      const m = idx.byId.get('queue-debt');
      return [{ text: `${m.value.total} deferred-debt item(s) open`, command: CMD.debtReview, anchor: trendAnchor(m, m.value.total, m.previous?.total) }];
    },
  },
]);

const anchorMs = (a) => { const t = Date.parse(a ?? ''); return Number.isNaN(t) ? Infinity : t; };

/**
 * Evaluate every rule and rank the rows: severity desc, then age anchor (older
 * first, no anchor last), then rule id, then text. Top {@link MAX_NEEDS_ROWS}
 * are returned; the true overflow is `more`, never dropped silently.
 *
 * `headline` is {@link NOTHING_NEEDS_YOU} only when no rule fired AND no measurement
 * is unmeasured; otherwise null.
 *
 * @param {Array<object>|{measurements: Array<object>}} model
 * @returns {{rows: Array<object>, total: number, more: number, unmeasured: number, headline: string|null}}
 */
export function rankNeedsYou(model) {
  const idx = index(model);
  const all = [];
  for (const rule of NEEDS_RULES) {
    if (rule.when(idx) !== true) continue;
    for (const row of rule.rows(idx)) {
      all.push({ ruleId: rule.id, severity: rule.severity, command: null, tab: null, commandNote: null, ...row, text: clip(row.text, LIMITS.detail) });
    }
  }
  all.sort((a, b) => (b.severity - a.severity)
    || (anchorMs(a.anchor) - anchorMs(b.anchor) === 0 ? 0 : (anchorMs(a.anchor) < anchorMs(b.anchor) ? -1 : 1))
    || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0)
    || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  const rows = all.slice(0, MAX_NEEDS_ROWS);
  return {
    rows, total: all.length, more: all.length - rows.length, unmeasured: idx.unmeasured.length,
    headline: all.length === 0 && idx.unmeasured.length === 0 ? NOTHING_NEEDS_YOU : null,
  };
}

// ── Composition ────────────────────────────────────────────────────────────────

const SEVERITY = { 'unexpected-error': 3, invalid: 2, 'missing-optional': 1, ok: 0 };

/** The worst status among measurements (`ok` for an empty list is NOT assumed: callers handle it). */
export function worstStatus(measurements) {
  return measurements.reduce((w, m) => (SEVERITY[m.status] > SEVERITY[w] ? m.status : w), 'ok');
}

/**
 * Compose the Home model from collector outputs.
 *
 * @param {Record<string, {measurements: object[]}>} cards - keyed by card id
 * @param {{now?: Date}} [opts]
 * @returns {{builtAt: string, cards: Record<string, {id: string, label: string, measurements: object[], status: string, warning: null|{status: string, detail: string}}>, health: object[], needs: object}}
 */
export function buildHomeModel(cards, { now = new Date() } = {}) {
  const out = {};
  const flat_ = [];
  for (const [id, card] of Object.entries(cards)) {
    const ms = card.measurements ?? [];
    flat_.push(...ms);
    // A card shows its own warning only when EVERY measurement in it is non-ok.
    const allBad = ms.length > 0 && ms.every((m) => m.status !== 'ok');
    out[id] = {
      id, label: CARD_LABELS[id] ?? id, measurements: ms, status: ms.length ? worstStatus(ms) : 'unexpected-error',
      warning: allBad ? { status: worstStatus(ms), detail: clip(ms.map((m) => m.detail).filter(Boolean)[0] ?? 'no detail', LIMITS.detail) } : null,
    };
  }
  return { builtAt: now.toISOString(), cards: out, health: gradeHealth(flat_), needs: rankNeedsYou(flat_) };
}
